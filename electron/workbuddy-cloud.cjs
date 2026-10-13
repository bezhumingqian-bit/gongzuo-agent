// WorkBuddy cloud task over the official Open API + ACP channel
// (https://open.workbuddy.cn/docs/openapi「云端任务 API」「ACP 通道」「会话产物」).
//
// One 共作 work item maps to one cloud task (task_id is kept as the work's
// agentSessionId). Each turn: get a fresh ACP link/token for the task, open the
// SSE receive channel, then initialize → session/load → session/prompt over
// POST. Text chunks, tool steps and artifacts stream back on SSE; the
// session/prompt response with stopReason ends the turn.
//
// Tool permission requests from the cloud Agent are declined: 共作 has no
// in-app approval UI for cloud tools yet, and policy says unknown actions need a
// human. The decline is reported in the reply so the employee knows.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { requestJson, conversationInput } = require('./connection-service.cjs');

const API_BASE = 'https://www.workbuddy.cn/openapi/v2';
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const RPC_TIMEOUT_MS = 60 * 1000;
const MAX_TEXT = 50000;
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const SAVABLE = /\.(pdf|docx|doc|txt|md|csv|xlsx|xls|pptx|ppt)$/i;

function safeUrl(raw, label) {
  let url;
  try { url = new URL(String(raw || '')); } catch { throw new Error(`WorkBuddy 返回的${label}无效`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error(`WorkBuddy 返回的${label}不是 HTTPS`);
  if (url.username || url.password) throw new Error(`WorkBuddy 返回的${label}无效`);
  return url;
}

const auth = token => ({ authorization: `Bearer ${token}` });
const unwrap = body => (body && typeof body === 'object' && body.data && typeof body.data === 'object' && 'code' in body) ? body.data : body;

function taskInfo(body) {
  const data = unwrap(body);
  if (!data || typeof data.task_id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(data.task_id)) throw new Error('WorkBuddy 没有返回有效的云端任务 ID');
  if (typeof data.link !== 'string' || typeof data.token !== 'string' || !data.token) throw new Error('WorkBuddy 没有返回 ACP 连接信息');
  return { taskId: data.task_id, status: data.status, name: data.name, link: safeUrl(data.link, 'ACP 地址').toString(), ticket: data.token };
}

async function createCloudTask(config, { prompt, name }, fetchImpl = fetch) {
  const base = config.workbuddyApiBase || API_BASE;
  return taskInfo(await requestJson(`${base}/tasks`, {
    method: 'POST', headers: { ...auth(config.workbuddyAccessToken), 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ prompt: String(prompt).slice(0, 2000), ...(name ? { name: String(name).slice(0, 60) } : {}) })
  }, fetchImpl));
}

async function getCloudTask(config, taskId, fetchImpl = fetch) {
  const base = config.workbuddyApiBase || API_BASE;
  return taskInfo(await requestJson(`${base}/tasks/${encodeURIComponent(taskId)}`, {
    method: 'GET', headers: { ...auth(config.workbuddyAccessToken), accept: 'application/json' }
  }, fetchImpl));
}

// Minimal SSE + POST JSON-RPC client for one ACP connection.
class AcpConnection {
  constructor({ link, ticket, fetchImpl = fetch, onNotification = () => {}, onRequest = async () => ({}) }) {
    Object.assign(this, { link, ticket, fetchImpl, onNotification, onRequest });
    this.pending = new Map();
    this.nextId = 1;
    this.controller = new AbortController();
    this.connectionId = null;
    this.closed = false;
  }

  async open() {
    let response;
    try {
      response = await this.fetchImpl(this.link, { method: 'GET', headers: { ...auth(this.ticket), accept: 'text/event-stream' }, signal: this.controller.signal, redirect: 'error' });
    } catch { throw new Error('无法连接 WorkBuddy 云端任务通道'); }
    if (response.status === 401) throw Object.assign(new Error('WorkBuddy 云端任务凭据已过期'), { expired: true });
    if (!response.ok || !response.body) throw new Error(`WorkBuddy 云端任务通道返回 HTTP ${response.status}`);
    this.connectionId = response.headers.get('acp-connection-id');
    this.reading = this.read(response.body).catch(error => this.fail(error));
  }

  async read(body) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, '');
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (data) this.dispatch(data);
      }
    }
    if (!this.closed) this.fail(new Error('WorkBuddy 云端任务通道已断开'));
  }

  dispatch(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.id !== undefined && message.method === undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`WorkBuddy 云端任务出错：${String(message.error.message || message.error.code || '').slice(0, 160)}`));
      else waiter.resolve(message.result ?? {});
      return;
    }
    if (message.method && message.id !== undefined) {
      Promise.resolve(this.onRequest(message)).then(result => this.post({ jsonrpc: '2.0', id: message.id, result }))
        .catch(() => this.post({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'client error' } }).catch(() => {}));
      return;
    }
    if (message.method) this.onNotification(message);
  }

  async post(payload) {
    const response = await this.fetchImpl(this.link, {
      method: 'POST', redirect: 'error',
      headers: { ...auth(this.ticket), 'content-type': 'application/json', accept: 'application/json', ...(this.connectionId ? { 'acp-connection-id': this.connectionId } : {}) },
      body: JSON.stringify(payload)
    });
    if (response.status === 401) throw Object.assign(new Error('WorkBuddy 云端任务凭据已过期'), { expired: true });
    if (!response.ok) throw new Error(`WorkBuddy 云端任务返回 HTTP ${response.status}`);
    const text = await response.text().catch(() => '');
    if (text.trim()) { try { const body = JSON.parse(text); if (body?.jsonrpc) this.dispatch(text); } catch { /* async result arrives on SSE */ } }
  }

  call(method, params, timeout = RPC_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`WorkBuddy 云端任务响应超时（${method}）`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.post({ jsonrpc: '2.0', id, method, params }).catch(error => {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }

  fail(error) {
    for (const [id, waiter] of this.pending) { clearTimeout(waiter.timer); waiter.reject(error); this.pending.delete(id); }
  }

  close() {
    this.closed = true;
    this.controller.abort();
    this.fail(new Error('连接已关闭'));
  }
}

function updateText(params) {
  const update = params?.update || params?.delta || params || {};
  const kind = update.sessionUpdate;
  if (kind && kind !== 'agent_message_chunk') return { kind, update };
  const content = update.content;
  const text = typeof content === 'string' ? content : typeof content?.text === 'string' ? content.text : typeof update.text === 'string' ? update.text : '';
  return { kind: 'agent_message_chunk', text };
}

function buildCloudPrompt(messages, workspace, memoryContext, resume) {
  const input = conversationInput(messages, memoryContext);
  const turns = resume ? input.messages.slice(-1) : input.messages;
  return [
    ...(resume ? [] : [input.instructions, `当前工作空间：${String(workspace || '').slice(0, 120)}`]),
    ...turns.map(item => `${item.role === 'assistant' ? '助手' : '用户'}：${item.content}`)
  ].join('\n\n');
}

async function downloadArtifacts(artifacts, { link, ticket, fetchImpl }) {
  const sandbox = link.replace(/\/acp\/?$/, '').replace(/\/sessions\/[^/]+\/?$/, '');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-wb-artifacts-'));
  const saved = [];
  const skipped = [];
  for (const { artifact, url } of artifacts) {
    const name = path.basename(String(artifact.name || artifact.uri || '').split('?')[0]).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120);
    if (artifact.type !== 'media' || !name || !SAVABLE.test(name)) { skipped.push(artifact.title || name || artifact.uri); continue; }
    try {
      const target = safeUrl(url || String(artifact.uri).replace(/^agent:\/\/\//, `${sandbox}/`), '产物地址');
      const response = await fetchImpl(target.toString(), { headers: auth(ticket), redirect: 'error' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error('文件过大');
      const file = path.join(directory, name);
      await fs.writeFile(file, bytes, { mode: 0o600 });
      saved.push({ name, path: file });
    } catch { skipped.push(name); }
  }
  return { directory, saved, skipped };
}

async function callWorkBuddyCloud(config, messages, workspace, memoryContext = {}, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const onProgress = options.onProgress || (() => {});
  const goal = [...messages].find(item => item.role === 'user')?.text || '共作工作';
  let info = options.sessionId
    ? await getCloudTask(config, options.sessionId, fetchImpl)
    : await createCloudTask(config, { prompt: goal, name: options.title }, fetchImpl);
  const resume = Boolean(options.sessionId);
  let text = '';
  const declined = [];
  const artifacts = new Map();
  const steps = [];
  const connection = new AcpConnection({
    link: info.link, ticket: info.ticket, fetchImpl,
    onNotification: message => {
      if (message.method === '_codebuddy.ai/artifact' && message.params?.artifact?.uri) {
        const { event, artifact, url } = message.params;
        if (event === 'deleted') artifacts.delete(artifact.uri);
        else artifacts.set(artifact.uri, { artifact, url: message.params.url || url });
        return;
      }
      if (message.method !== 'session/update') return;
      const piece = updateText(message.params);
      if (piece.kind === 'agent_message_chunk' && piece.text) {
        text = (text + piece.text).slice(0, MAX_TEXT);
        onProgress({ text });
      } else if (piece.kind === 'tool_call' && piece.update?.title) {
        steps.push(String(piece.update.title).slice(0, 80));
        onProgress({ step: steps.at(-1), text });
      }
    },
    onRequest: async request => {
      if (request.method === 'session/request_permission') {
        declined.push(String(request.params?.toolCall?.title || request.params?.type || '需授权的操作').slice(0, 80));
        return { outcome: { outcome: 'cancelled' } };
      }
      return {};
    }
  });
  const deadline = setTimeout(() => connection.close(), TURN_TIMEOUT_MS);
  try {
    await connection.open();
    await connection.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
    await connection.call('session/load', { sessionId: info.taskId, cwd: '/workspace', mcpServers: [] });
    const result = await connection.call('session/prompt', {
      sessionId: info.taskId,
      prompt: [{ type: 'text', text: buildCloudPrompt(messages, workspace, memoryContext, resume) }]
    }, TURN_TIMEOUT_MS);
    const stopReason = result?.stopReason || 'end_turn';
    const downloaded = artifacts.size ? await downloadArtifacts([...artifacts.values()], { link: info.link, ticket: info.ticket, fetchImpl }) : { saved: [], skipped: [] };
    const notes = [];
    if (stopReason !== 'end_turn') notes.push(`（WorkBuddy 本轮结束原因：${({ max_tokens: '达到输出上限', max_turn_requests: '达到轮次上限', refusal: '模型拒绝', cancelled: '已取消' })[stopReason] || stopReason}）`);
    if (declined.length) notes.push(`（WorkBuddy 请求执行需授权的操作，共作尚不支持在此确认，已拒绝：${declined.join('、')}）`);
    if (downloaded.skipped.length) notes.push(`（另有 ${downloaded.skipped.length} 个产物未存入资料：${downloaded.skipped.slice(0, 5).join('、')}）`);
    const body = text.trim() || (downloaded.saved.length ? '已生成文件，见下方成果。' : 'WorkBuddy 没有返回文字结果。');
    return { text: [body, ...notes].join('\n\n').slice(0, MAX_TEXT), sessionId: info.taskId, files: downloaded.saved, filesDirectory: downloaded.directory, stopReason };
  } catch (error) {
    if (error.expired && !options.retried) {
      clearTimeout(deadline); connection.close();
      return callWorkBuddyCloud(config, messages, workspace, memoryContext, { ...options, sessionId: info.taskId, retried: true });
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    connection.close();
  }
}

async function checkWorkBuddyCloud(config, fetchImpl = fetch) {
  const base = config.workbuddyApiBase || API_BASE;
  const body = await requestJson(`${base}/tasks?page=1&size=1`, { method: 'GET', headers: { ...auth(config.workbuddyAccessToken), accept: 'application/json' } }, fetchImpl);
  if (body && typeof body === 'object' && 'code' in body && body.code !== 0) throw new Error(`WorkBuddy 接口调用失败（错误码 ${body.code}）`);
  return { ok: true, message: 'WorkBuddy 云端任务接口可访问；创建与执行权限在首次实际派发时验证' };
}

module.exports = { callWorkBuddyCloud, checkWorkBuddyCloud, createCloudTask, getCloudTask, AcpConnection, buildCloudPrompt, updateText };
