const { createHash } = require('node:crypto');

const KINDS = new Set(['model', 'agent', 'wecom', 'feishu', 'wecom-bot']);
const LABELS = Object.freeze({ connected: '已连接', ready: '已就绪', unconfigured: '未配置', unauthorized: '需授权', offline: '已断开', unsupported: '暂不支持', error: '检测异常' });
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CACHE = 32;
const text = value => typeof value === 'string' ? value.trim() : '';
const failure = state => Object.assign(new Error('只读状态检查未完成'), { state });

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

function safeUrl(raw, { localHttp = false, base = false } = {}) {
  if (!text(raw) || /[\\\s]/.test(raw)) throw failure('error');
  let url;
  try { url = new URL(raw); } catch { throw failure('error'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || (base && url.search)
      || (url.protocol !== 'https:' && !(localHttp && local && url.protocol === 'http:'))) throw failure('error');
  return url;
}

async function defaultCheckLocal(mode) {
  // 只查找现有可执行文件，不启动 CLI，也不读取登录凭据。
  try {
    if (mode === 'codebuddy') await require('./codebuddy-service.cjs').findCodeBuddy();
    else await require('./local-agent-service.cjs').findExecutable(mode);
    return true;
  } catch { return false; }
}

class ConnectionStatusService {
  #cache = new Map();
  #inflight = new Map();

  constructor({ fetchImpl = fetch, now = Date.now, ttlMs = 30000, timeoutMs = 8000, checkLocal = defaultCheckLocal } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.checkLocal = checkLocal;
  }

  #result(target, state, message, action = null) {
    return Object.freeze({ state, label: LABELS[state], message, checkedAt: new Date(this.now()).toISOString(), source: 'readonly', action, target });
  }

  #error(target, error) {
    // 仅接受内部状态枚举，不透传 URL、配置、响应体、CLI 输出或异常文字。
    const state = ['unauthorized', 'offline', 'error'].includes(error?.state) ? error.state : 'error';
    if (state === 'unauthorized') return this.#result(target, state, '凭据无效、已过期或权限不足，请重新授权。', 'authorize');
    if (state === 'offline') return this.#result(target, state, '暂时无法连接服务，请检查网络或客户端后重连。', 'reconnect');
    return this.#result(target, state, '只读状态检查未完成，请核对配置；未发送生成请求或消息。', 'configure');
  }

  async #deadline(operation, ms = this.timeoutMs) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        new Promise((_, reject) => {
          timer = setTimeout(() => { reject(failure('offline')); controller.abort(); }, ms);
        })
      ]);
    } finally { clearTimeout(timer); }
  }

  async #abortable(operation, signal) {
    if (signal.aborted) throw failure('offline');
    let onAbort;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          onAbort = () => reject(failure('offline'));
          signal.addEventListener('abort', onAbort, { once: true });
        })
      ]);
    } finally { signal.removeEventListener('abort', onAbort); }
  }

  #body(response, signal) {
    return this.#abortable(() => this.#readBody(response, signal), signal);
  }

  async #readBody(response, signal) {
    const tooLarge = Number(response.headers?.get?.('content-length') || 0) > MAX_BODY_BYTES;
    if (tooLarge || signal.aborted) {
      Promise.resolve(response.body?.cancel?.()).catch(() => {});
      throw failure(tooLarge ? 'error' : 'offline');
    }
    let raw;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const cancel = () => { Promise.resolve(reader.cancel()).catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (signal.aborted) throw failure('offline');
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY_BYTES) throw failure('error');
          chunks.push(Buffer.from(value));
        }
        raw = Buffer.concat(chunks, size).toString('utf8');
      } catch (error) { cancel(); throw error; }
      finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
    } else if (typeof response.text === 'function') raw = await response.text();
    else if (typeof response.json === 'function') raw = JSON.stringify(await response.json());
    else throw failure('error');
    if (signal.aborted) throw failure('offline');
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BODY_BYTES) throw failure('error');
    return raw;
  }

  async #fetch(url, options, signal, localHttp = false) {
    const target = safeUrl(String(url), { localHttp });
    if ((options.method || 'GET') !== 'GET' || options.body != null || signal.aborted) throw failure('error');
    let response;
    try {
      response = await this.#abortable(() => this.fetchImpl(target.toString(), {
        ...options, method: 'GET', redirect: 'error',
        signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal
      }), signal);
    } catch { throw failure('offline'); }
    if (signal.aborted) {
      Promise.resolve(response.body?.cancel?.()).catch(() => {});
      throw failure('offline');
    }
    const redirected = response.redirected || (response.url && response.url !== target.toString()) || (response.status >= 300 && response.status < 400);
    if (redirected || !response.ok) {
      // 错误与无需读取的响应不留后台响应体，避免长连接耗尽资源。
      Promise.resolve(response.body?.cancel?.()).catch(() => {});
      if (redirected) throw failure('error');
      if (response.status === 401 || response.status === 403) throw failure('unauthorized');
      if (response.status >= 500 && response.status !== 501) throw failure('offline');
    }
    return {
      ok: response.ok, status: response.status, headers: response.headers,
      text: () => this.#body(response, signal),
      json: async () => JSON.parse(await this.#body(response, signal))
    };
  }

  async #knownCheck(config, check, expectedUrl) {
    const expected = safeUrl(expectedUrl).toString();
    return this.#deadline(async signal => {
      let fault;
      let requests = 0;
      const readonlyFetch = async (url, options = {}) => {
        try {
          // 固定既有只读列表端点；上游实现日后增加写操作也不会被执行。
          if (String(url) !== expected || requests++ !== 0) throw failure('error');
          return await this.#fetch(url, options, signal);
        } catch (error) { fault = error; throw error; }
      };
      try {
        const result = await check(config, readonlyFetch);
        if (fault) throw fault;
        if (result?.ok !== true || requests !== 1) throw failure('error');
      } catch { throw fault || failure('error'); }
    });
  }

  async get(kind, config = {}, { bridge, bot, force = false } = {}) {
    const target = KINDS.has(kind) ? kind : 'connection';
    if (!KINDS.has(kind)) return this.#result(target, 'unsupported', '不支持此连接类型，未自动调用外部接口。');
    let snapshot;
    let key;
    try {
      snapshot = structuredClone(config || {});
      key = createHash('sha256').update(JSON.stringify(stable({ kind, config: snapshot }))).digest('hex');
    } catch { return this.#error(target, failure('error')); }

    if (kind === 'agent' && snapshot.agent?.mode === 'built-in') {
      const result = await this.get('model', snapshot, { force });
      return Object.freeze({ ...result, target: 'agent' });
    }
    const handoff = kind === 'agent' && snapshot.agent?.mode === 'workbuddy'
      && require('./workbuddy-transport.cjs').transportOf(snapshot) === 'handoff';
    // 内存桥接和 WebSocket 状态无需网络，每次读取，避免旧缓存掩盖断开。
    if (handoff || kind === 'wecom-bot') {
      try { return await this.#deadline(() => this.#live(kind, snapshot, { bridge, bot })); }
      catch (error) { return this.#error(target, error); }
    }
    if (this.#inflight.has(key)) return this.#inflight.get(key);
    const cached = this.#cache.get(key);
    const elapsed = cached ? this.now() - cached.at : Infinity;
    if (!force && elapsed >= 0 && elapsed < this.ttlMs) {
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached.result;
    }
    if (this.#inflight.size >= MAX_CACHE) return this.#result(target, 'error', '只读状态检查正在进行，请稍后自动刷新。');
    const pending = Promise.resolve().then(() => this.#probe(kind, snapshot)).catch(error => this.#error(target, error));
    this.#inflight.set(key, pending);
    try {
      const result = await pending;
      this.#cache.delete(key);
      this.#cache.set(key, { at: this.now(), result });
      while (this.#cache.size > MAX_CACHE) this.#cache.delete(this.#cache.keys().next().value);
      return result;
    } finally { this.#inflight.delete(key); }
  }

  async #live(kind, config, { bridge, bot }) {
    if (kind === 'wecom-bot') {
      if (!text(config.wecom?.botId) || !text(config.wecomBotSecret)) return this.#result(kind, 'unconfigured', '请配置企业微信机器人 ID 与密钥。', 'configure');
      const current = bot?.status;
      const status = typeof current === 'function' ? await current.call(bot) : current;
      if (status === '已连接' || status === 'connected' || status === 'authenticated') return this.#result(kind, 'connected', '企业微信机器人 WebSocket 已认证连接；不代表消息已送达。');
      if (status === 'unauthorized' || status === '需授权') return this.#result(kind, 'unauthorized', '机器人认证未通过，请重新授权。', 'authorize');
      if (status === '连接中' || status === '重连中' || status === 'connecting' || status === 'reconnecting') return this.#result(kind, 'offline', '机器人正在连接或自动重连，尚未确认 WebSocket 已连接。', 'reconnect');
      return this.#result(kind, 'offline', '机器人 WebSocket 未连接，请重连；未发送测试消息。', 'reconnect');
    }
    const current = bridge?.status;
    const status = typeof current === 'function' ? await current.call(bridge) : current;
    if (status?.listening === true) return this.#result(kind, 'ready', '本机连接就绪；近期访问不证明 WorkBuddy PC 持续在线。');
    return this.#result(kind, 'offline', '本机桥接未监听，请恢复本机连接。', 'reconnect');
  }

  async #probe(kind, config) {
    if (kind === 'model') return this.#model(config);
    if (kind === 'wecom') {
      const configured = text(config.wecom?.organizationId) && text(config.wecom?.applicationId) && text(config.wecomSecret);
      return this.#result(kind, configured ? 'ready' : 'unconfigured', configured
        ? '企业微信凭据已配置，需要验证；未自动获取令牌或发送消息。'
        : '请配置企业 ID、应用 AgentID 与应用密钥。', configured ? null : 'configure');
    }
    if (kind === 'feishu') {
      const configured = text(config.feishu?.appId) && text(config.feishuAppSecret);
      return this.#result(kind, configured ? 'ready' : 'unconfigured', configured
        ? '飞书凭据已配置，需要验证；未自动获取令牌或发送消息。'
        : '请配置飞书 App ID 与 App Secret。', configured ? null : 'configure');
    }
    const mode = config.agent?.mode;
    if (mode === 'workbuddy') return this.#workbuddy(config);
    if (mode === 'cloudagent') {
      if (!text(config.cloudagentApiKey)) return this.#result(kind, 'unconfigured', '请配置 CodeBuddy CloudAgent API Key。', 'configure');
      const { checkCloudAgent, API_BASE } = require('./cloudagent.cjs');
      const base = text(config.cloudagentApiBase) || API_BASE;
      safeUrl(base, { base: true });
      const normalized = base.replace(/\/+$/, '');
      await this.#knownCheck({ ...config, cloudagentApiBase: normalized }, checkCloudAgent, `${normalized}/runtimes?page=1&pageSize=1`);
      return this.#result(kind, 'connected', 'CloudAgent 只读沙箱列表 API 可达；未创建沙箱或验证任务执行。');
    }
    if (['codebuddy', 'codex', 'kimi'].includes(mode)) {
      const available = await this.#deadline(signal => this.checkLocal(mode, { signal, timeoutMs: Math.min(3000, this.timeoutMs) }), Math.min(3000, this.timeoutMs));
      const found = available === true || Boolean(text(available)) || available?.available === true || available?.exists === true || available?.ok === true;
      return this.#result(kind, found ? 'ready' : 'unconfigured', found
        ? '本机 CLI 可用；未运行提示词，未验证登录或在线状态。'
        : '未找到本机 CLI，请先安装并配置。', found ? null : 'configure');
    }
    if (mode === 'external') {
      if (!text(config.agent?.endpoint)) return this.#result(kind, 'unconfigured', '请配置外部 Agent 地址。', 'configure');
      safeUrl(config.agent.endpoint, { base: true });
      return this.#result(kind, 'ready', '外部 Agent 已配置；无已知只读健康端点，未自动调用。');
    }
    return this.#result(kind, mode ? 'unsupported' : 'unconfigured', mode ? '此 Agent 暂无安全只读检查，未自动调用。' : '请先配置 Agent。', mode ? null : 'configure');
  }

  async #model(config) {
    const model = config.model || {};
    if (!text(model.modelId) || !text(model.baseUrl) || (model.provider !== 'local' && !text(config.modelKey))) return this.#result('model', 'unconfigured', '请配置模型 ID、接口地址及所需 API Key。', 'configure');
    if (!['openai', 'kimi', 'deepseek', 'compatible', 'local'].includes(model.provider)) return this.#result('model', 'unsupported', '此提供方暂无已知安全的模型列表端点，未自动调用生成。');
    const base = safeUrl(model.baseUrl, { localHttp: true, base: true });
    let route;
    try { route = decodeURIComponent(base.pathname).toLowerCase(); } catch { throw failure('error'); }
    if (route.split('/').some(part => ['responses', 'chat', 'completions', 'messages', 'generate', 'tasks'].includes(part))) throw failure('error');
    const url = `${base.toString().replace(/\/+$/, '')}/models`;
    return this.#deadline(async signal => {
      const response = await this.#fetch(url, { headers: { accept: 'application/json', ...(text(config.modelKey) ? { authorization: `Bearer ${config.modelKey}` } : {}) } }, signal, true);
      if ([404, 405, 501].includes(response.status)) return this.#result('model', 'ready', '凭据已配置，服务不提供模型列表；未自动检测生成，避免计费。');
      if (!response.ok) throw failure('error');
      let body;
      try { body = await response.json(); } catch { throw failure(signal.aborted ? 'offline' : 'error'); }
      const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : null;
      if (!list) throw failure('error');
      if (!list.some(item => (typeof item === 'string' ? item : item?.id || item?.name) === text(model.modelId))) return this.#result('model', 'ready', '模型列表 API 可达，但未确认配置的模型；未自动检测生成。');
      return this.#result('model', 'connected', '模型列表 API 可达且包含配置的模型；不保证生成成功，未调用 LLM。');
    });
  }

  async #workbuddy(config) {
    const transport = require('./workbuddy-transport.cjs').transportOf(config);
    if (transport === 'cloud') {
      if (!text(config.workbuddyAccessToken)) return this.#result('agent', 'unauthorized', '请完成 WorkBuddy 云端授权。', 'authorize');
      const base = text(config.workbuddyApiBase) || 'https://www.workbuddy.cn/openapi/v2';
      safeUrl(base, { base: true });
      const normalized = base.replace(/\/+$/, '');
      await this.#knownCheck({ ...config, workbuddyApiBase: normalized }, require('./workbuddy-cloud.cjs').checkWorkBuddyCloud, `${normalized}/tasks?page=1&size=1`);
      return this.#result('agent', 'connected', 'WorkBuddy 云端只读任务列表 API 可达；未创建或执行任务。');
    }
    const relay = text(config.agent?.workbuddyRelayUrl);
    if (!relay) return this.#result('agent', 'unconfigured', '请配置 HTTPS 授权中转地址；不会直连开放平台本地助理。', 'configure');
    const { relayOrigin } = require('./workbuddy-relay-client.cjs');
    let origin;
    try { origin = relayOrigin(relay); } catch { throw failure('error'); }
    if (!text(config.workbuddyAccessToken) || config.workbuddyViaRelay !== true) return this.#result('agent', 'unauthorized', '请完成 WorkBuddy 本地助理授权。', 'authorize');
    return this.#deadline(async signal => {
      const response = await this.#fetch(`${origin}/v1/localassistant`, { headers: { accept: 'application/json', authorization: `Bearer ${config.workbuddyAccessToken}` } }, signal);
      if (!response.ok) throw failure('error');
      let body;
      try { body = await response.json(); } catch { throw failure(signal.aborted ? 'offline' : 'error'); }
      if (body?.code !== 0 || !body.data || typeof body.data !== 'object') throw failure('error');
      if (body.data.online === true) return this.#result('agent', 'connected', '平台确认 WorkBuddy PC 本地助理在线；未发送测试消息。');
      if (body.data.online === false) return this.#result('agent', 'offline', '平台确认 WorkBuddy PC 本地助理离线，请重连客户端。', 'reconnect');
      throw failure('error');
    });
  }
}

module.exports = { ConnectionStatusService };
