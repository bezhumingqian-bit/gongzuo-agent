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
// No fixed turn length: a turn stops only after IDLE_LIMIT_MS without any
// update from the cloud, or after the MAX_TURN_MS safety ceiling.
const IDLE_LIMIT_MS = 10 * 60 * 1000;
const MAX_TURN_MS = 2 * 60 * 60 * 1000;
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
//
// Error kinds callers can tell apart: `rpc` (the agent answered with a
// JSON-RPC error), `busy` (HTTP 409, the session is still running an earlier
// prompt), `expired` (HTTP 401) and `dropped` (the channel itself broke).
// `onDrop` fires once when the receive stream breaks without close().
// `strictStreams`: a streamed POST reply that ends without the response for
// its request counts as a dropped channel instead of waiting forever.
const dropped = message => Object.assign(new Error(message), { dropped: true });

class AcpConnection {
  constructor({ link, ticket, fetchImpl = fetch, onNotification = () => {}, onRequest = async () => ({}), onDrop = () => {}, strictStreams = false }) {
    Object.assign(this, { link, ticket, fetchImpl, onNotification, onRequest, onDrop, strictStreams });
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
    } catch { throw dropped('无法连接云端任务通道'); }
    if (response.status === 401) throw Object.assign(new Error('云端任务凭据已过期'), { expired: true });
    if (!response.ok || !response.body) throw dropped(`云端任务通道返回 HTTP ${response.status}`);
    this.connectionId = response.headers.get('acp-connection-id');
    this.reading = this.read(response.body).catch(() => this.drop(dropped('云端任务通道已断开')));
  }

  drop(error) {
    if (this.closed || this.droppedOnce) return;
    this.droppedOnce = true;
    this.fail(error);
    this.onDrop(error);
  }

  // Parses an SSE body and dispatches each JSON-RPC message. Used for the GET
  // notification stream and for POST responses streamed as SSE (AgentOS returns
  // session/prompt results that way).
  async read(body, { primary = true } = {}) {
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
    const rest = buffer.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (rest) this.dispatch(rest);
    if (primary && !this.closed) this.drop(dropped('云端任务通道已断开'));
  }

  dispatch(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.id !== undefined && message.method === undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(Object.assign(new Error(`云端任务出错：${String(message.error.message || message.error.code || '').slice(0, 160)}`), { rpc: true, code: message.error.code }));
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
    let response;
    try {
      response = await this.fetchImpl(this.link, {
        method: 'POST', redirect: 'error',
        headers: { ...auth(this.ticket), 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.connectionId ? { 'acp-connection-id': this.connectionId } : {}) },
        body: JSON.stringify(payload),
        signal: this.controller.signal
      });
    } catch { throw dropped('云端任务通道请求失败'); }
    if (response.status === 401) throw Object.assign(new Error('云端任务凭据已过期'), { expired: true });
    if (response.status === 409) throw Object.assign(new Error('云端会话正在执行上一条请求，请稍后再试'), { busy: true });
    if (!response.ok) throw Object.assign(new Error(`云端任务返回 HTTP ${response.status}`), { dropped: response.status >= 500 });
    if (/text\/event-stream/i.test(response.headers.get('content-type') || '') && response.body) {
      // Streamed reply (e.g. session/prompt): dispatch as it arrives; do not block the caller.
      const id = payload.id;
      this.read(response.body, { primary: false })
        .catch(() => {})
        .then(() => {
          if (!this.strictStreams || this.closed || id === undefined || !this.pending.has(id)) return;
          const waiter = this.pending.get(id);
          this.pending.delete(id);
          clearTimeout(waiter.timer);
          waiter.reject(dropped('云端回复流中断'));
        });
      return;
    }
    const text = await response.text().catch(() => '');
    if (text.trim()) { try { const body = JSON.parse(text); if (body?.jsonrpc) this.dispatch(text); } catch { /* async result arrives on SSE */ } }
  }

  notify(method, params) {
    return this.post({ jsonrpc: '2.0', method, params }).catch(() => {});
  }

  call(method, params, timeout = RPC_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(dropped(`云端任务响应超时（${method}）`)); }, timeout);
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
    // Release the server-side connection; best effort.
    if (this.connectionId) this.fetchImpl(this.link, { method: 'DELETE', headers: { ...auth(this.ticket), 'acp-connection-id': this.connectionId }, redirect: 'error' }).catch(() => {});
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
  let prompting = false;
  const declined = [];
  const artifacts = new Map();
  const steps = [];
  const startedAt = Date.now();
  let lastActivity = startedAt;
  let stopped = null;
  const connection = new AcpConnection({
    link: info.link, ticket: info.ticket, fetchImpl,
    onNotification: message => {
      lastActivity = Date.now();
      if (message.method === '_codebuddy.ai/artifact' && message.params?.artifact?.uri) {
        const { event, artifact, url } = message.params;
        if (event === 'deleted') artifacts.delete(artifact.uri);
        else artifacts.set(artifact.uri, { artifact, url: message.params.url || url });
        return;
      }
      // session/load replays earlier updates first; only collect this turn's output.
      if (message.method !== 'session/update' || !prompting) return;
      const piece = updateText(message.params);
      if (piece.kind === 'agent_message_chunk' && piece.text) {
        text = (text + piece.text).slice(0, MAX_TEXT);
        onProgress({ text, steps: steps.length, lastActivityAt: lastActivity, startedAt });
      } else if (piece.kind === 'tool_call' && piece.update?.title) {
        steps.push(String(piece.update.title).slice(0, 80));
        onProgress({ step: steps.at(-1), text, steps: steps.length, lastActivityAt: lastActivity, startedAt });
      } else onProgress({ activity: true, steps: steps.length, lastActivityAt: lastActivity, startedAt });
    },
    onRequest: async request => {
      if (request.method === 'session/request_permission') {
        declined.push(String(request.params?.toolCall?.title || request.params?.type || '需授权的操作').slice(0, 80));
        return { outcome: { outcome: 'cancelled' } };
      }
      return {};
    }
  });
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - lastActivity > IDLE_LIMIT_MS) stopped = 'idle';
    else if (now - startedAt > MAX_TURN_MS) stopped = 'max';
    if (stopped) connection.close();
  }, 15000);
  const deadline = watchdog;
  try {
    await connection.open();
    await connection.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
    await connection.call('session/load', { sessionId: info.taskId, cwd: '/workspace', mcpServers: [] });
    prompting = true;
    const result = await connection.call('session/prompt', {
      sessionId: info.taskId,
      prompt: [{ type: 'text', text: buildCloudPrompt(messages, workspace, memoryContext, resume) }]
    }, MAX_TURN_MS);
    const stopReason = result?.stopReason || 'end_turn';
    const downloaded = artifacts.size ? await downloadArtifacts([...artifacts.values()], { link: info.link, ticket: info.ticket, fetchImpl }) : { saved: [], skipped: [] };
    const notes = [];
    if (stopReason !== 'end_turn') notes.push(`（WorkBuddy 本轮结束原因：${({ max_tokens: '达到输出上限', max_turn_requests: '达到轮次上限', refusal: '模型拒绝', cancelled: '已取消' })[stopReason] || stopReason}）`);
    if (declined.length) notes.push(`（WorkBuddy 请求执行需授权的操作，共作尚不支持在此确认，已拒绝：${declined.join('、')}）`);
    if (downloaded.skipped.length) notes.push(`（另有 ${downloaded.skipped.length} 个产物未存入资料：${downloaded.skipped.slice(0, 5).join('、')}）`);
    const body = text.trim() || (downloaded.saved.length ? '已生成文件，见下方成果。' : 'WorkBuddy 没有返回文字结果。');
    return { text: [body, ...notes].join('\n\n').slice(0, MAX_TEXT), sessionId: info.taskId, files: downloaded.saved, filesDirectory: downloaded.directory, stopReason };
  } catch (error) {
    if (stopped === 'idle') throw new Error('WorkBuddy 云端 10 分钟没有任何动静，已停止等待；可以稍后重试');
    if (stopped === 'max') throw new Error('WorkBuddy 云端这一轮已运行 2 小时仍未结束，已停止等待');
    if (error.expired && !options.retried) {
      clearInterval(deadline); connection.close();
      return callWorkBuddyCloud(config, messages, workspace, memoryContext, { ...options, sessionId: info.taskId, retried: true });
    }
    throw error;
  } finally {
    clearInterval(deadline);
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
