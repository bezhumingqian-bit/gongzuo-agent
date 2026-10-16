'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { isIP } = require('node:net');

const API_BASE = 'https://www.workbuddy.cn/openapi/v2';
const SCOPES = Object.freeze([
  'user.profile.readable',
  'user.localassistant.readable',
  'user.localassistant.invokable'
]);
const ATTEMPT_TTL = 5 * 60_000;
const SESSION_TTL = 30 * 24 * 60 * 60_000;
const BODY_LIMIT = 16 * 1024;
const ID = /^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,199}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9_-]{43,128}$/;
const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const hash = value => crypto.createHash('sha256').update(value).digest('base64url');

class RelayError extends Error {
  constructor(status, code, message, messageId) {
    super(message);
    Object.assign(this, { status, code, messageId });
  }
}
const fail = (status, code, message, messageId) => {
  throw new RelayError(status, code, message, messageId);
};

function loopback(host) {
  const value = host.replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || (isIP(value) === 4 && value.startsWith('127.'));
}

function validatePublicUrl(value, allowTestHttp) {
  if (typeof value !== 'string' || !/^https?:\/\/[^/?#]+$/.test(value)) {
    throw new Error('publicUrl 必须是无路径、查询或片段的 HTTPS 域名 origin');
  }
  const url = new URL(value);
  if (url.username || url.password || value.includes('@') || /[\s\\%]/.test(value)) throw new Error('publicUrl 格式无效');
  if (allowTestHttp === true && url.protocol === 'http:' && loopback(url.hostname)) return;
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || isIP(host.replace(/^\[|\]$/g, '')) || loopback(host) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
      /\.(?:localhost|local|internal|invalid|test|example)$/.test(host)) {
    throw new Error('生产 publicUrl 必须使用 HTTPS 真实域名，测试 HTTP 仅允许显式 loopback');
  }
}

function encryptionKeyFrom(value) {
  if (Buffer.isBuffer(value) && value.length === 32) return Buffer.from(value);
  if (typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value)) {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 32 && decoded.toString('base64') === value) return decoded;
  }
  throw new Error('encryptionKey 必须是 32 字节密钥或其规范 base64');
}

function jsonBody(req) {
  const type = req.headers['content-type'];
  if (typeof type !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) {
    fail(415, 'json_required', '仅接受 application/json');
  }
  if (Number(req.headers['content-length']) > BODY_LIMIT) fail(413, 'body_too_large', '请求体超过 16KB');
  return new Promise((resolve, reject) => {
    let size = 0;
    let finished = false;
    const chunks = [];
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('aborted', onAborted);
      if (error) { req.resume(); reject(error); } else resolve(result);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) finish(new RelayError(413, 'body_too_large', '请求体超过 16KB'));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const body = JSON.parse(text);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        finish(null, body);
      } catch { finish(new RelayError(400, 'invalid_json', 'JSON 请求体无效')); }
    };
    const onAborted = () => finish(new RelayError(400, 'invalid_json', '请求体未完整接收'));
    const onError = () => finish(new RelayError(400, 'invalid_json', '请求体未完整接收'));
    req.on('data', onData).once('end', onEnd).once('aborted', onAborted).once('error', onError);
  });
}

function exactFields(body, fields) {
  if (Object.keys(body).some(key => !fields.includes(key))) fail(400, 'invalid_parameters', '含有不支持的参数');
}

function createRelay({ publicUrl, clientId, clientSecret, storagePath, encryptionKey,
  fetchImpl = fetch, apiBase = API_BASE, now = Date.now, allowTestHttp = false } = {}) {
  validatePublicUrl(publicUrl, allowTestHttp);
  if (typeof clientId !== 'string' || !clientId || typeof clientSecret !== 'string' || !clientSecret ||
      typeof storagePath !== 'string' || !path.isAbsolute(storagePath) || typeof fetchImpl !== 'function' || typeof now !== 'function') {
    throw new Error('缺少有效的服务端配置，storagePath 必须为绝对路径');
  }
  const key = encryptionKeyFrom(encryptionKey);
  if (apiBase !== API_BASE) {
    const override = new URL(apiBase);
    if (allowTestHttp !== true || override.protocol !== 'http:' || !loopback(override.hostname) ||
        override.username || override.password || apiBase.includes('@') || override.search || override.hash || apiBase.endsWith('/')) {
      throw new Error('apiBase 固定为官方 API；仅显式测试允许 loopback HTTP mock');
    }
  }
  const redirectUri = publicUrl + '/oauth/callback';
  const aad = Buffer.from(JSON.stringify(['gongzuo-workbuddy-relay-v1', publicUrl, clientId]));
  const sessions = new Map();
  const accounts = new Map();
  const inflight = new Map();
  const attempts = new Map();
  const states = new Map();
  const rates = new Map();
  const refreshing = new Map();
  const knownSecrets = new Set([clientSecret]);
  let storageFailed = false;
  let writeQueue = Promise.resolve();

  try {
    const stat = fs.lstatSync(storagePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    const envelope = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    if (envelope.version !== 1) throw new Error();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
    const saved = JSON.parse(plain.toString('utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.sessions) || !Array.isArray(saved.accounts) || !Array.isArray(saved.inflight)) throw new Error();
    for (const [id, record] of saved.accounts) {
      if (typeof id !== 'string' || !record || typeof record !== 'object' || record.openId !== id) throw new Error();
      accounts.set(id, record);
      if (typeof record.tokens?.accessToken === 'string') knownSecrets.add(record.tokens.accessToken);
      if (typeof record.tokens?.refreshToken === 'string') knownSecrets.add(record.tokens.refreshToken);
    }
    for (const [id, record] of saved.sessions) {
      if (!CHALLENGE.test(id) || !record || !Number.isFinite(record.expiresAt) || !accounts.has(record.accountId)) throw new Error();
      if (record.expiresAt > now()) sessions.set(id, record);
    }
    for (const [id, record] of saved.inflight) {
      if (!accounts.has(id) || !record || !CHALLENGE.test(record.sessionHash) || !ID.test(record.messageId) ||
          !['reserved', 'sending', 'uncertain', 'active'].includes(record.phase)) throw new Error();
      if (record.phase !== 'active') record.phase = 'uncertain';
      inflight.set(id, record);
    }
    fs.chmodSync(storagePath, 0o600);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('无法解密或校验中继存储；拒绝启动，不能回退到空状态');
  }

  function persist() {
    const snapshot = JSON.stringify({ version: 1, sessions: [...sessions], accounts: [...accounts], inflight: [...inflight] });
    const operation = writeQueue.then(async () => {
      if (storageFailed) fail(503, 'storage_unavailable', '中继存储不可用，请联系服务维护人员');
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(snapshot, 'utf8'), cipher.final()]);
      const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
      const temporary = storagePath + '.' + random(12) + '.tmp';
      let handle;
      try {
        handle = await fsp.open(temporary, 'wx', 0o600);
        await handle.chmod(0o600);
        await handle.writeFile(envelope, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await fsp.rename(temporary, storagePath);
        // 同步目录项，使发送前的所有权预留在突然重启后仍然生效。
        const directory = await fsp.open(path.dirname(storagePath), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } catch {
        storageFailed = true;
        if (handle) await handle.close().catch(() => {});
        await fsp.unlink(temporary).catch(() => {});
        fail(503, 'storage_unavailable', '中继存储不可用，请联系服务维护人员');
      }
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  function discardAttempt(attempt) {
    attempt.cancelled = true;
    attempt.tokenRecord = null;
    attempt.verifier = null;
    states.delete(attempt.state);
    attempts.delete(attempt.id);
  }
  function live(attempt) {
    return !attempt.cancelled && attempts.get(attempt.id) === attempt && attempt.expiresAt > now();
  }
  function clean() {
    for (const attempt of attempts.values()) if (attempt.expiresAt <= now()) discardAttempt(attempt);
    for (const [ip, rate] of rates) if (rate.until <= now()) rates.delete(ip);
    let changed = false;
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now()) { sessions.delete(id); changed = true; }
    }
    if (changed && !storageFailed) {
      pruneAccounts();
      void persist().catch(() => {});
    }
  }
  function pruneAccounts() {
    const referenced = new Set([...sessions.values()].map(session => session.accountId));
    for (const [id, account] of accounts) {
      if (!referenced.has(id)) {
        if (inflight.has(id)) account.tokens = null;
        else accounts.delete(id);
      }
    }
  }
  function rateLimit(req, start, provenAttemptId = null) {
    // TLS reverse proxy clients share a loopback socket. A proved claim is
    // budgeted per attempt, never by a spoofable X-Forwarded-For header.
    const ip = provenAttemptId ? `attempt:${provenAttemptId}` : req.socket.remoteAddress || 'unknown';
    let rate = rates.get(ip);
    if (!rate || rate.until <= now()) {
      if (rates.size >= 10_000) fail(429, 'rate_limited', '请求过于频繁，请稍后重试');
      rate = { until: now() + 60_000, count: 0, starts: 0 };
      rates.set(ip, rate);
    }
    rate.count++;
    if (start) rate.starts++;
    if (rate.count > 60 || rate.starts > 10) fail(429, 'rate_limited', '请求过于频繁，请稍后重试');
  }

  function secretValues() {
    const values = [...knownSecrets];
    for (const account of accounts.values()) values.push(account.tokens?.accessToken, account.tokens?.refreshToken);
    for (const attempt of attempts.values()) values.push(attempt.tokenRecord?.tokens?.accessToken, attempt.tokenRecord?.tokens?.refreshToken);
    return values.filter(value => typeof value === 'string' && value.length);
  }
  function safe(value, depth = 0, secrets = secretValues()) {
    if (depth > 8) return null;
    if (typeof value === 'string') {
      let text = value.slice(0, 50_000);
      for (const secret of secrets) text = text.split(secret).join('[已隐藏]');
      return text;
    }
    if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || value === null) return value;
    if (Array.isArray(value)) return value.slice(0, 100).map(item => safe(item, depth + 1, secrets));
    if (value && typeof value === 'object') {
      const result = Object.create(null);
      for (const [name, item] of Object.entries(value).slice(0, 100)) {
        if (/token|secret|authorization|cookie|password|credential|code_verifier|__proto__|constructor|prototype/i.test(name)) continue;
        result[safe(name, depth + 1, secrets)] = safe(item, depth + 1, secrets);
      }
      return result;
    }
    return null;
  }
  function sendJson(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
    res.end(value === undefined ? undefined : JSON.stringify(value));
  }
  function callbackPage(res, status, success) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>共作授权</title><body><h1>${success ? '授权完成' : '授权未完成'}</h1><p>${success ? '请关闭此页，回到共作继续。' : '请回到共作重新发起授权。'}</p></body></html>`);
  }

  async function upstream(endpoint, options = {}) {
    const url = apiBase + '/' + endpoint;
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
          if (response.redirected || response.status >= 300 && response.status < 400 ||
              response.url && new URL(response.url).origin !== new URL(url).origin) {
            fail(502, 'upstream_unavailable', 'WorkBuddy 返回了不允许的重定向');
          }
          const text = await response.text();
          if (Buffer.byteLength(text) > 2 * 1024 * 1024) fail(502, 'upstream_unavailable', 'WorkBuddy 响应不可用');
          if (!response.ok) return { status: response.status, ok: false, body: null };
          let body;
          try { body = JSON.parse(text); } catch { fail(502, 'upstream_unavailable', 'WorkBuddy 响应不可用'); }
          return { status: response.status, ok: response.ok, body };
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new RelayError(504, 'upstream_timeout', 'WorkBuddy 连接超时，请稍后核对结果'));
          }, 15_000);
          timer.unref();
        })
      ]);
    } catch (error) {
      if (error instanceof RelayError) throw error;
      fail(502, 'upstream_unavailable', '无法连接 WorkBuddy，请稍后重试');
    } finally { clearTimeout(timer); }
  }
  function dataFrom(result) {
    if (!result.ok || result.body?.code !== 0 || !result.body.data || typeof result.body.data !== 'object' || Array.isArray(result.body.data)) {
      fail(502, 'upstream_rejected', 'WorkBuddy 未接受请求，请核对授权与本地助理状态');
    }
    return result.body.data;
  }
  async function postToken(params) {
    const result = await upstream('token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret }).toString()
    });
    if (!result.ok || result.body?.code === 401) fail(401, 'authorization_expired', 'WorkBuddy 授权不可用，请重新授权');
    const data = result.body && Object.hasOwn(result.body, 'code') ? dataFrom(result) : result.body;
    if (!data || typeof data.access_token !== 'string' || !data.access_token) {
      fail(401, 'authorization_expired', 'WorkBuddy 授权不可用，请重新授权');
    }
    knownSecrets.add(data.access_token);
    if (typeof data.refresh_token === 'string') knownSecrets.add(data.refresh_token);
    return data;
  }
  function tokenRecord(data, previous) {
    const scope = typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : (previous?.scope?.split(' ') || [...SCOPES]);
    if (scope.length !== SCOPES.length || !SCOPES.every(item => scope.includes(item))) {
      fail(401, 'invalid_scope', '授权权限与本地助理限定权限不符，请重新授权');
    }
    const seconds = data.expires_in === undefined ? 3600 : Number(data.expires_in);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 31 * 24 * 3600 ||
        data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || !data.refresh_token)) {
      fail(502, 'invalid_token_response', 'WorkBuddy 授权响应不可用');
    }
    if (previous?.openId && data.open_id && data.open_id !== previous.openId) {
      fail(401, 'identity_changed', '授权身份发生变化，请重新授权');
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || previous?.tokens?.refreshToken || null,
      accessExpiresAt: now() + seconds * 1000,
      scope: SCOPES.join(' ')
    };
  }
  async function refresh(accountId, rejectedToken) {
    const account = accounts.get(accountId);
    if (!account?.tokens) fail(401, 'authorization_expired', '请重新授权 WorkBuddy');
    if (rejectedToken && account.tokens.accessToken !== rejectedToken) return account.tokens.accessToken;
    if (!refreshing.has(accountId)) {
      const previous = account.tokens;
      const work = (async () => {
        if (!previous.refreshToken) fail(401, 'authorization_expired', '请重新授权 WorkBuddy');
        let data;
        try { data = await postToken({ grant_type: 'refresh_token', refresh_token: previous.refreshToken }); }
        catch (error) {
          if (error.status === 401 && accounts.get(accountId) === account && account.tokens === previous) {
            account.tokens = null;
            await persist();
          }
          throw error;
        }
        if (accounts.get(accountId) !== account || account.tokens !== previous) {
          if (accounts.get(accountId)?.tokens) return accounts.get(accountId).tokens.accessToken;
          fail(401, 'authorization_expired', '请重新授权 WorkBuddy');
        }
        account.tokens = tokenRecord(data, account);
        await persist();
        return account.tokens.accessToken;
      })();
      refreshing.set(accountId, work);
      void work.finally(() => { if (refreshing.get(accountId) === work) refreshing.delete(accountId); }).catch(() => {});
    }
    return refreshing.get(accountId);
  }
  async function getAccessToken(accountId) {
    const account = accounts.get(accountId);
    if (!account?.tokens) fail(401, 'authorization_expired', '请重新授权 WorkBuddy');
    if (account.tokens.accessExpiresAt - now() > 60_000) return account.tokens.accessToken;
    return refresh(accountId);
  }
  function authenticate(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) {
      fail(401, 'unauthorized', '需要有效的中继 Bearer 凭据');
    }
    const sessionHash = hash(header.slice(7));
    const session = sessions.get(sessionHash);
    if (!session || session.expiresAt <= now()) fail(401, 'unauthorized', '中继凭据无效或已过期，请重新授权');
    return { sessionHash, session, account: accounts.get(session.accountId) };
  }
  function stillAuthorized(auth) {
    if (storageFailed) fail(503, 'storage_unavailable', '中继存储不可用，请联系服务维护人员');
    if (sessions.get(auth.sessionHash) !== auth.session || auth.session.expiresAt <= now()) {
      fail(401, 'unauthorized', '中继凭据无效或已过期，请重新授权');
    }
  }
  async function readProvider(auth, endpoint) {
    const token = await getAccessToken(auth.session.accountId);
    stillAuthorized(auth);
    let result = await upstream(endpoint, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    if (result.status === 401 || result.body?.code === 401) {
      const fresh = await refresh(auth.session.accountId, token);
      stillAuthorized(auth);
      result = await upstream(endpoint, { headers: { authorization: `Bearer ${fresh}`, accept: 'application/json' } });
    }
    stillAuthorized(auth);
    return dataFrom(result);
  }
  function ownership(auth, messageId) {
    const record = inflight.get(auth.session.accountId);
    if (!record || record.sessionHash !== auth.sessionHash || (record.messageId !== messageId && record.requestId !== messageId)) {
      fail(409, 'message_not_owned', '该消息不属于当前中继会话；请回到原设备核对或明确释放');
    }
    return record;
  }
  function verifiedAttempt(body) {
    exactFields(body, ['id', 'claimVerifier']);
    if (typeof body.id !== 'string' || !CHALLENGE.test(body.id) || typeof body.claimVerifier !== 'string' ||
        !VERIFIER.test(body.claimVerifier) || Buffer.from(body.claimVerifier, 'base64url').length < 32 ||
        Buffer.from(body.claimVerifier, 'base64url').toString('base64url') !== body.claimVerifier) {
      fail(400, 'invalid_attempt', '授权领取凭据无效，请重新发起授权');
    }
    const attempt = attempts.get(body.id);
    const actual = Buffer.from(hash(body.claimVerifier));
    const expected = Buffer.from(attempt?.challenge || hash(random()));
    if (!crypto.timingSafeEqual(actual, expected) || !attempt || !live(attempt)) {
      fail(400, 'invalid_attempt', '授权领取凭据无效，请重新发起授权');
    }
    return attempt;
  }

  async function handleCallback(url, res) {
    const values = url.searchParams;
    if (values.getAll('state').length !== 1 || values.getAll('code').length > 1 ||
        values.getAll('error').length > 1 || values.has('error') && values.has('code')) {
      callbackPage(res, 400, false); return;
    }
    const state = values.get('state');
    const code = values.get('code');
    if (!state || !CHALLENGE.test(state) || (!values.has('error') && (typeof code !== 'string' || !code || code.length > 2048))) {
      callbackPage(res, 400, false); return;
    }
    const attempt = attempts.get(states.get(state));
    if (!attempt || !live(attempt) || attempt.phase !== 'pending') { callbackPage(res, 400, false); return; }
    // 在第一个 await 前消耗 state，重复回调包括 exchange 中的回调都不能再次兑换。
    states.delete(state);
    attempt.phase = 'exchanging';
    if (values.has('error')) {
      attempt.phase = 'failed';
      attempt.failure = { code: 'authorization_denied', message: '授权未完成，请重新发起授权' };
      callbackPage(res, 400, false); return;
    }
    try {
      const data = await postToken({ grant_type: 'authorization_code', code, code_verifier: attempt.verifier, redirect_uri: redirectUri });
      if (!live(attempt)) { callbackPage(res, 400, false); return; }
      const tokens = tokenRecord(data);
      const profile = dataFrom(await upstream('user/profile', { headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' } }));
      if (!live(attempt)) { callbackPage(res, 400, false); return; }
      const openId = profile.open_id || data.open_id;
      if (typeof openId !== 'string' || !openId || openId.length > 200 || data.open_id && profile.open_id && data.open_id !== profile.open_id) {
        fail(502, 'identity_unavailable', '无法确认 WorkBuddy 授权身份');
      }
      attempt.tokenRecord = { openId, nickname: typeof profile.nickname === 'string' ? profile.nickname.slice(0, 200) : '',
        scope: tokens.scope, tokens };
      attempt.phase = 'ready';
      attempt.verifier = null;
      callbackPage(res, 200, true);
    } catch {
      if (live(attempt)) {
        attempt.phase = 'failed';
        attempt.tokenRecord = null;
        attempt.verifier = null;
        attempt.failure = { code: 'authorization_failed', message: 'WorkBuddy 授权未完成，请重新发起授权' };
      }
      callbackPage(res, 400, false);
    }
  }

  async function handle(req, res) {
    clean();
    const url = new URL(req.url, 'http://relay.invalid');
    if (req.url.startsWith('//') || !req.url.startsWith('/')) fail(400, 'invalid_request', '请求路径无效');
    const route = req.method + ' ' + url.pathname;
    if (route === 'GET /healthz') {
      sendJson(res, 200, { ok: !storageFailed, service: 'gongzuo-workbuddy-relay', redirectUri, scopes: [...SCOPES] }); return;
    }
    if (route === 'GET /oauth/callback') { await handleCallback(url, res); return; }
    if (Object.hasOwn(req.headers, 'origin')) fail(403, 'origin_forbidden', '仅允许无 Origin 的桌面服务端调用');
    if (storageFailed) fail(503, 'storage_unavailable', '中继存储不可用，请联系服务维护人员');
    if (!['GET /v1/localassistant/message'].includes(route) && url.search) fail(400, 'invalid_parameters', '不接受查询参数');

    if (route === 'POST /v1/auth/start') {
      rateLimit(req, true);
      const body = await jsonBody(req);
      exactFields(body, ['claimChallenge']);
      if (typeof body.claimChallenge !== 'string' || !CHALLENGE.test(body.claimChallenge) ||
          Buffer.from(body.claimChallenge, 'base64url').toString('base64url') !== body.claimChallenge) {
        fail(400, 'invalid_challenge', '需要 base64url SHA256 领取校验值');
      }
      if (attempts.size >= 500) fail(429, 'attempt_limit', '授权请求过多，请稍后重试');
      const attempt = { id: random(), state: random(), verifier: random(48), challenge: body.claimChallenge,
        expiresAt: now() + ATTEMPT_TTL, phase: 'pending', cancelled: false };
      attempts.set(attempt.id, attempt);
      states.set(attempt.state, attempt.id);
      // 即使使用本地 mock，授权页面也始终指向官方地址。
      const authorize = new URL(API_BASE + '/authorize');
      authorize.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
        scope: SCOPES.join(' '), state: attempt.state, code_challenge: hash(attempt.verifier), code_challenge_method: 'S256' }).toString();
      sendJson(res, 200, { id: attempt.id, authorizeUrl: authorize.toString(), expiresAt: attempt.expiresAt }); return;
    }
    if (route === 'POST /v1/auth/claim' || route === 'POST /v1/auth/cancel') {
      let attempt;
      try { attempt = verifiedAttempt(await jsonBody(req)); }
      catch (error) { rateLimit(req, false); throw error; }
      rateLimit(req, false, attempt.id);
      if (route.endsWith('/cancel')) {
        discardAttempt(attempt);
        sendJson(res, 200, { ok: true }); return;
      }
      if (attempt.phase === 'pending' || attempt.phase === 'exchanging') { sendJson(res, 200, { status: 'pending' }); return; }
      if (attempt.phase === 'failed') { sendJson(res, 200, { status: 'failed', ...attempt.failure }); return; }
      if (attempt.phase !== 'ready') fail(409, 'claim_consumed', '授权结果正在领取或已经领取，请勿重复领取');
      attempt.phase = 'claiming';
      const record = attempt.tokenRecord;
      const sessionToken = random();
      const sessionHash = hash(sessionToken);
      const session = { accountId: record.openId, expiresAt: now() + SESSION_TTL };
      const previousAccount = accounts.get(record.openId);
      accounts.set(record.openId, record);
      sessions.set(sessionHash, session);
      await persist();
      if (!live(attempt)) {
        sessions.delete(sessionHash);
        if (previousAccount && accounts.get(record.openId) === record) accounts.set(record.openId, previousAccount);
        pruneAccounts();
        await persist();
        fail(400, 'invalid_attempt', '授权领取已取消或过期，请重新发起授权');
      }
      discardAttempt(attempt);
      sendJson(res, 200, { status: 'ready', sessionToken, expiresAt: session.expiresAt,
        nickname: safe(record.nickname), openId: safe(record.openId), scope: record.scope }); return;
    }
    const supported = ['GET /v1/auth/status', 'DELETE /v1/auth/session', 'GET /v1/localassistant',
      'POST /v1/localassistant/message', 'GET /v1/localassistant/message', 'POST /v1/localassistant/release'];
    if (!supported.includes(route)) fail(404, 'not_found', '接口不存在');
    const auth = authenticate(req);
    if (route === 'GET /v1/auth/status') {
      if (!auth.account?.tokens) fail(401, 'authorization_expired', '请重新授权 WorkBuddy');
      const observing = inflight.get(auth.session.accountId);
      sendJson(res, 200, { authorized: true, nickname: safe(auth.account.nickname), openId: safe(auth.account.openId),
        scope: auth.account.scope, expiresAt: auth.session.expiresAt,
        ...(observing ? { observation: observing.sessionHash === auth.sessionHash ? { owned: true, messageId: observing.messageId, phase: observing.phase, ...(observing.requestId ? { requestId: observing.requestId } : {}) } : { owned: false } } : {}) }); return;
    }
    if (route === 'DELETE /v1/auth/session') {
      sessions.delete(auth.sessionHash);
      // 不自动释放在途任务；撤销凭据不是平台任务的完成确认。
      pruneAccounts();
      await persist();
      sendJson(res, 204); return;
    }
    if (route === 'GET /v1/localassistant') {
      const data = await readProvider(auth, 'localassistant');
      if (typeof data.online !== 'boolean') fail(502, 'upstream_unavailable', 'WorkBuddy 在线状态不可用');
      sendJson(res, 200, { code: 0, msg: 'ok', data: { online: data.online } }); return;
    }
    if (route === 'POST /v1/localassistant/release') {
      const body = await jsonBody(req);
      exactFields(body, ['messageId']);
      if (typeof body.messageId !== 'string' || !ID.test(body.messageId)) fail(400, 'invalid_parameters', '消息 ID 无效');
      stillAuthorized(auth);
      const active = inflight.get(auth.session.accountId);
      if (!active) {
        // No current lease can be released; retrying after a lost release
        // response is harmless. Never clear another device's active lease.
        sendJson(res, 200, { ok: true }); return;
      }
      const record = ownership(auth, body.messageId);
      if (record.phase === 'reserved' || record.phase === 'sending') {
        fail(409, 'send_in_progress', '发送仍在进行，不能提前释放；请等待发送结果后核对');
      }
      inflight.delete(auth.session.accountId);
      await persist();
      sendJson(res, 200, { ok: true }); return;
    }
    if (route === 'POST /v1/localassistant/message') {
      const body = await jsonBody(req);
      exactFields(body, ['content', 'msg_type', 'requestId']);
      if (body.requestId != null && (typeof body.requestId !== 'string' || !CHALLENGE.test(body.requestId))) fail(400, 'invalid_message', '任务关联标识无效');
      if (body.msg_type !== 'text' || typeof body.content !== 'string' || !body.content.trim() || body.content.length > 4000) {
        fail(400, 'invalid_message', '仅接受不超过 4000 字的非空 text 消息');
      }
      stillAuthorized(auth);
      if (inflight.has(auth.session.accountId)) fail(409, 'account_busy', '本地助理存在未释放任务；请在原设备核对结果后明确释放');
      const record = { sessionHash: auth.sessionHash, messageId: 'uncertain_' + random(), phase: 'reserved', ...(body.requestId ? { requestId: body.requestId } : {}) };
      inflight.set(auth.session.accountId, record);
      await persist();
      let attemptedWrite = false;
      try {
        const token = await getAccessToken(auth.session.accountId);
        stillAuthorized(auth);
        record.phase = 'sending';
        await persist();
        stillAuthorized(auth);
        attemptedWrite = true;
        const result = await upstream('localassistant/message', { method: 'POST',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ content: body.content, msg_type: 'text' }) });
        if (result.status === 401 || result.body?.code === 401) {
          await refresh(auth.session.accountId, token).catch(() => {});
          fail(409, 'write_recheck_required', '发送授权失效，未自动重放；请到 WorkBuddy 核对是否已发送，再明确释放', record.messageId);
        }
        const data = dataFrom(result);
        if (typeof data.message_id !== 'string' || !ID.test(data.message_id)) fail(502, 'upstream_unavailable', 'WorkBuddy 消息 ID 不可用');
        record.messageId = data.message_id;
        record.phase = 'active';
        await persist();
        stillAuthorized(auth);
        sendJson(res, 200, { code: 0, msg: 'ok', data: { message_id: safe(data.message_id) } }); return;
      } catch (error) {
        if (!attemptedWrite) {
          if (inflight.get(auth.session.accountId) === record) inflight.delete(auth.session.accountId);
          if (!storageFailed) await persist();
          throw error;
        }
        record.phase = 'uncertain';
        if (!storageFailed) await persist();
        if (error.code === 'write_recheck_required') throw error;
        fail(storageFailed ? 503 : 502, 'write_uncertain', '发送结果不能确认，未自动重放；请到 WorkBuddy 核对后明确释放', record.messageId);
      }
    }
    if (route === 'GET /v1/localassistant/message') {
      const params = url.searchParams;
      const allowed = ['message_id', 'limit', 'offset'];
      for (const name of params.keys()) {
        if (!allowed.includes(name) || params.getAll(name).length !== 1) fail(400, 'invalid_parameters', '含有不支持或重复的查询参数');
      }
      const messageId = params.get('message_id');
      if (!messageId || !ID.test(messageId) || params.has('limit') && (!/^[1-9]\d{0,2}$/.test(params.get('limit')) || Number(params.get('limit')) > 100) ||
          params.has('offset') && (!/^(?:0|[1-9]\d{0,9})$/.test(params.get('offset')) || !Number.isSafeInteger(Number(params.get('offset'))))) {
        fail(400, 'invalid_parameters', '消息 ID 或分页参数无效');
      }
      const record = ownership(auth, messageId);
      if (record.phase !== 'active') fail(409, 'write_recheck_required', '发送结果不明确，请到 WorkBuddy 核对后明确释放', record.messageId);
      const query = new URLSearchParams();
      for (const name of allowed) if (params.has(name)) query.set(name, name === 'message_id' ? record.messageId : params.get(name));
      const data = await readProvider(auth, 'localassistant/message?' + query.toString());
      if (inflight.get(auth.session.accountId) !== record) fail(409, 'message_not_owned', '任务已释放，不能继续读取旧消息流');
      if (!Array.isArray(data.messages) || data.messages.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
        fail(502, 'upstream_unavailable', 'WorkBuddy 消息响应不可用');
      }
      if (data.messages.some(item => item.role === 'user' && item.message_id !== record.messageId)) {
        fail(409, 'message_stream_conflict', '检测到其他用户消息；停止匹配回复，请到 WorkBuddy 核对后明确释放');
      }
      const fields = ['role', 'content', 'msg_type', 'message_id', 'metadata', 'attachments'];
      const messages = data.messages.slice(0, 100).map(item => {
        const result = Object.create(null);
        for (const name of fields) if (Object.hasOwn(item, name)) result[name] = safe(item[name]);
        return result;
      });
      // assistant 消息并不证明任务完成，所有权只由显式 release 解除。
      sendJson(res, 200, { code: 0, msg: 'ok', data: { messages } });
    }
  }

  const server = http.createServer((req, res) => {
    // 断连可能在 aborted 后继续触发 error，不允许异常客户端终止整个服务。
    req.on('error', () => {});
    void handle(req, res).catch(error => {
      if (res.headersSent) { res.end(); return; }
      const known = error instanceof RelayError;
      sendJson(res, known ? error.status : 500, { error: { code: known ? error.code : 'internal_error',
        message: known ? error.message : '中继请求失败，请稍后重试' }, ...(known && error.messageId ? { messageId: error.messageId } : {}) });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  const cleanup = setInterval(clean, 30_000);
  cleanup.unref();
  server.once('close', () => { clearInterval(cleanup); for (const attempt of attempts.values()) discardAttempt(attempt); });
  const httpClose = server.close;
  server.close = function close(callback) {
    return httpClose.call(this, error => {
      // 定时清理的落盘也必须先排空，close 回调后才能安全重启或清理测试存储。
      void writeQueue.then(() => { if (callback) callback(error); });
    });
  };
  return server;
}

module.exports = { createRelay };

if (require.main === module) {
  try {
    const server = createRelay({
      publicUrl: process.env.GONGZUO_RELAY_PUBLIC_URL,
      clientId: process.env.WORKBUDDY_CLIENT_ID,
      clientSecret: process.env.WORKBUDDY_CLIENT_SECRET,
      encryptionKey: process.env.GONGZUO_RELAY_ENCRYPTION_KEY,
      storagePath: process.env.GONGZUO_RELAY_DATA_FILE || path.join(__dirname, 'workbuddy-relay-data.json')
    });
    const rawPort = process.env.PORT || '8787';
    if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error('PORT 无效');
    server.once('error', () => { console.error('中继监听失败，请检查绑定配置'); process.exitCode = 1; });
    server.listen(Number(rawPort), process.env.BIND_HOST || '127.0.0.1');
  } catch {
    console.error('中继启动失败，请检查 HTTPS 域名、服务端凭据和加密存储配置');
    process.exitCode = 1;
  }
}
