// Local bridge that lets the WorkBuddy MCP connector (a separate stdio process)
// read and answer 共作 work. It listens on a Unix socket inside userData and
// requires a random bearer token written next to it with 0600 permissions, so
// only processes running as this macOS user can reach it. No TCP port is opened.
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { actors } = require('./contracts/policy.cjs');
const { WorkOperations, WorkError } = require('./contracts/work-operations.cjs');

const MAX_BODY_BYTES = 256 * 1024;
const MAX_WAIT_MS = 280 * 1000;
const FILE_EXTENSIONS = /\.(pdf|docx|doc|txt|md|csv|xlsx|xls|pptx|ppt)$/i;
const MAX_SOCKET_PATH = 100; // macOS sun_path limit is 104 bytes.
const ID_PATTERN = /^[A-Za-z0-9-]{4,100}$/;

class BridgeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function socketPathFor(userDataDir) {
  const preferred = path.join(userDataDir, 'workbuddy-bridge.sock');
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH) return preferred;
  const hash = crypto.createHash('sha256').update(userDataDir).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `gongzuo-${hash}.sock`);
}

function tokensMatch(expected, header) {
  const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(String(header || ''));
  if (!match) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(match[1]);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new BridgeError(413, '请求内容过大')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new BridgeError(400, '请求不是有效的 JSON')); }
    });
    request.on('error', reject);
  });
}

function requireId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new BridgeError(400, `${label}无效`);
  return value;
}

// Files a local WorkBuddy produced and wants to return with its reply.
async function validateReplyFiles(files) {
  if (files == null) return [];
  if (!Array.isArray(files) || files.length > 10) throw new BridgeError(400, '一次最多附带 10 个文件');
  const checked = [];
  for (const file of files) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.length > 1000) throw new BridgeError(400, '文件路径必须是绝对路径');
    if (!FILE_EXTENSIONS.test(file)) throw new BridgeError(400, `不支持的文件格式：${path.basename(file)}`);
    let stat;
    try { stat = await fs.stat(file); } catch { throw new BridgeError(400, `文件不存在：${path.basename(file)}`); }
    if (!stat.isFile()) throw new BridgeError(400, `不是普通文件：${path.basename(file)}`);
    checked.push(file);
  }
  return checked;
}

function summarizeTask(task) {
  return {
    taskId: task.id,
    title: task.title,
    workspace: task.workspace,
    relatedWorkspaces: task.relatedWorkspaces || [],
    status: task.status,
    agentMode: task.agentMode || null,
    agentRun: task.agentRun?.status || null,
    needsMe: Boolean(task.needsMe),
    updatedAt: task.updatedAt,
    messageCount: (task.messages || []).length
  };
}

class WorkBuddyBridge {
  constructor({ userDataDir, store, taskRunner, ops, version, publish = () => {} }) {
    this.socketPath = socketPathFor(userDataDir);
    this.infoPath = path.join(userDataDir, 'workbuddy-bridge.json');
    Object.assign(this, { store, taskRunner, version, publish });
    this.ops = ops || new WorkOperations({ store, taskRunner });
    this.actor = actors.workbuddy();
    this.server = null;
    this.token = null;
    this.lastClientAt = null;
  }

  get status() {
    return { listening: Boolean(this.server?.listening), lastClientAt: this.lastClientAt };
  }

  async start() {
    if (this.server) return;
    this.token = crypto.randomBytes(32).toString('base64url');
    await fs.rm(this.socketPath, { force: true });
    const server = http.createServer((request, response) => this.handle(request, response));
    server.requestTimeout = MAX_WAIT_MS + 30000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => { server.off('error', reject); resolve(); });
    });
    this.server = server;
    await fs.chmod(this.socketPath, 0o600);
    const info = { socketPath: this.socketPath, token: this.token, pid: process.pid, version: this.version, startedAt: new Date().toISOString() };
    const temp = `${this.infoPath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, this.infoPath);
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (server) await new Promise(resolve => server.close(() => resolve()));
    try {
      const info = JSON.parse(await fs.readFile(this.infoPath, 'utf8'));
      if (info.pid === process.pid) await fs.rm(this.infoPath, { force: true });
    } catch { /* already gone */ }
    await fs.rm(this.socketPath, { force: true });
  }

  async handle(request, response) {
    const send = (status, body) => {
      const payload = JSON.stringify(body);
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
      response.end(payload);
    };
    try {
      if (!tokensMatch(this.token, request.headers.authorization)) throw new BridgeError(401, '共作本机连接令牌无效');
      this.lastClientAt = new Date().toISOString();
      const url = new URL(request.url, 'http://gongzuo.local');
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'v1') throw new BridgeError(404, '接口不存在');
      const body = request.method === 'POST' ? await readBody(request) : {};
      send(200, await this.route(request.method, parts.slice(1), url.searchParams, body));
    } catch (error) {
      const status = error instanceof BridgeError ? error.status
        : error instanceof WorkError ? ({ 'workspace-not-found': 400, 'task-not-found': 404 })[error.code] || 403
          : 409;
      send(status, { error: String(error?.message || '共作处理失败').slice(0, 300) });
    }
  }

  async route(method, parts, query, body) {
    const [resource, id, action] = parts;
    if (method === 'GET' && resource === 'status' && !id) {
      const data = await this.store.read();
      return { ok: true, app: '共作', version: this.version, activeWorkspace: data.activeWorkspace, pendingHandoffs: (await this.taskRunner.listHandoffs()).length };
    }
    if (resource === 'handoffs') {
      if (method === 'GET' && !id) return { items: await this.taskRunner.listHandoffs() };
      if (method === 'GET' && id === 'wait') {
        // Long poll: return as soon as unclaimed work exists, or after the timeout.
        const timeout = Math.min(Math.max(Number(query.get('timeoutMs')) || 100000, 1000), MAX_WAIT_MS);
        const until = Date.now() + timeout;
        for (;;) {
          const items = (await this.taskRunner.listHandoffs()).filter(item => !item.claimedAt);
          if (items.length || Date.now() >= until || !this.server) return { items, timedOut: !items.length };
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      const taskId = requireId(id, '工作 ID');
      if (method === 'POST' && action === 'claim') return this.taskRunner.claimHandoff(taskId);
      if (method === 'POST' && action === 'reply') {
        const triggerId = requireId(body.triggerId, '待处理消息 ID');
        if (typeof body.text !== 'string') throw new BridgeError(400, '回复内容无效');
        return this.taskRunner.submitHandoffReply(taskId, triggerId, body.text, await validateReplyFiles(body.files));
      }
    }
    if (resource === 'works') {
      const data = await this.store.read();
      if (method === 'GET' && !id) {
        const workspace = query.get('workspace');
        const limit = Math.min(Math.max(Number(query.get('limit')) || 20, 1), 50);
        const items = data.tasks.filter(task => !task.channelOnly && (!workspace || task.workspace === workspace || (task.relatedWorkspaces || []).includes(workspace))).slice(0, limit).map(summarizeTask);
        return { items, workspaces: data.workspaces.map(space => space.name) };
      }
      if (method === 'GET' && id && !action) {
        const task = data.tasks.find(item => item.id === requireId(id, '工作 ID'));
        if (!task) throw new BridgeError(404, '工作不存在');
        this.ops.check(this.actor, 'work.view', data.workspaces.find(space => space.name === task.workspace));
        return {
          ...summarizeTask(task),
          goal: task.goal,
          steps: (task.steps || []).map(step => ({ title: step.title, status: step.status })),
          messages: (task.messages || []).filter(item => ['user', 'assistant'].includes(item.role)).slice(-30).map(item => ({
            id: item.id, role: item.role, source: item.source || null, createdAt: item.createdAt, text: String(item.text || '').slice(0, 4000)
          }))
        };
      }
      if (method === 'POST' && !id) {
        const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
        if (!goal || goal.length > 2000) throw new BridgeError(400, '工作目标无效（1–2000 字）');
        const workspace = body.workspace == null ? data.activeWorkspace : String(body.workspace);
        const task = await this.ops.create(this.actor, { workspace, goal, options: { agentMode: 'workbuddy' } });
        return { ...summarizeTask(task), triggerId: task.agentRun?.triggerId || null };
      }
    }
    throw new BridgeError(404, '接口不存在');
  }
}

module.exports = { WorkBuddyBridge, socketPathFor, tokensMatch };
