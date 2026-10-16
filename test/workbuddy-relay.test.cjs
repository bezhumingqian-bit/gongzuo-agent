'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createRelay } = require('../server/workbuddy-relay.cjs');

const API = 'https://www.workbuddy.cn/openapi/v2';
const SCOPES = ['user.profile.readable', 'user.localassistant.readable', 'user.localassistant.invokable'];
const PUBLIC = 'https://relay.example.com';
const CLIENT_SECRET = 'CLIENT_SECRET_NEVER_PUBLIC_0123456789';
const digest = value => crypto.createHash('sha256').update(value).digest('base64url');
const verifier = () => crypto.randomBytes(32).toString('base64url');
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const wrapped = data => response({ code: 0, msg: 'ok', data });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function close(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}

async function rawRequest(base, route, { method = 'GET', headers = {}, body, chunks } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(route, base), { method, headers, agent: false }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(text); } catch { data = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    req.on('error', reject);
    if (chunks) for (const chunk of chunks) req.write(chunk);
    req.end(body);
  });
}

async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-relay-test-'));
  const key = crypto.randomBytes(32);
  let clock = Date.UTC(2026, 9, 15);
  let serial = 0;
  const issued = new Map();
  const codes = new Map();
  const mock = {
    calls: [], refreshes: [], tokenForms: [], sends: [], sendAttempts: 0,
    tokenHook: null, profileHook: null, onlineHook: null, sendHook: null, messagesHook: null,
    expiry: 3600, online: true
  };
  function mint(openId, previousRefresh) {
    const n = ++serial;
    const data = { access_token: 'WB_ACCESS_SECRET_' + n + '_LONG', refresh_token: 'WB_REFRESH_SECRET_' + n + '_LONG',
      expires_in: mock.expiry, scope: SCOPES.join(' '), open_id: openId };
    issued.set(data.access_token, { openId, refresh: data.refresh_token });
    if (previousRefresh) assert.match(previousRefresh, /^WB_REFRESH_SECRET_/);
    return data;
  }
  const fetchImpl = async (value, options) => {
    const url = new URL(value);
    assert.equal(url.origin, 'https://www.workbuddy.cn');
    assert.ok(url.pathname.startsWith('/openapi/v2/'));
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const endpoint = url.pathname.slice('/openapi/v2/'.length);
    const method = options.method || 'GET';
    const call = { endpoint, method, options, url };
    mock.calls.push(call);
    if (endpoint === 'token') {
      const form = new URLSearchParams(options.body);
      mock.tokenForms.push(form);
      assert.equal(form.get('client_id'), 'relay-client');
      assert.equal(form.get('client_secret'), CLIENT_SECRET);
      assert.equal(options.headers['content-type'], 'application/x-www-form-urlencoded');
      if (form.get('grant_type') === 'refresh_token') mock.refreshes.push(form);
      if (mock.tokenHook) {
        const result = await mock.tokenHook(form, call);
        if (result) return result;
      }
      const refreshValue = form.get('refresh_token');
      const identity = form.get('grant_type') === 'authorization_code' ? codes.get(form.get('code')) || 'account-one' :
        [...issued.values()].find(item => item.refresh === refreshValue)?.openId;
      if (!identity) return response({ error: 'invalid_grant', error_description: CLIENT_SECRET }, 400);
      return response(mint(identity, refreshValue));
    }
    const token = options.headers?.authorization?.slice(7);
    const identity = issued.get(token);
    assert.ok(identity, '上游必须使用仅由服务端保管的 WorkBuddy token');
    if (endpoint === 'user/profile') {
      if (mock.profileHook) return mock.profileHook(call, identity);
      return wrapped({ open_id: identity.openId, nickname: '测试用户', access_token: token });
    }
    if (endpoint === 'localassistant' && method === 'GET') {
      if (mock.onlineHook) return mock.onlineHook(call, identity);
      return response({ code: 0, msg: CLIENT_SECRET, data: { online: mock.online, access_token: token, endpoint: 'private' } });
    }
    if (endpoint === 'localassistant/message' && method === 'POST') {
      mock.sendAttempts++;
      if (mock.sendHook) {
        const result = await mock.sendHook(call, identity);
        if (result) return result;
      }
      const body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body).sort(), ['content', 'msg_type']);
      assert.equal(body.msg_type, 'text');
      const messageId = 'message-' + (mock.sends.length + 1);
      mock.sends.push({ identity: identity.openId, body, messageId });
      return wrapped({ message_id: messageId, access_token: token });
    }
    if (endpoint === 'localassistant/message' && method === 'GET') {
      if (mock.messagesHook) return mock.messagesHook(call, identity);
      return response({ code: 0, msg: CLIENT_SECRET, data: {
        messages: [
          { role: 'user', message_id: url.searchParams.get('message_id'), msg_type: 'text', content: ['工作'] },
          { role: 'assistant', message_id: 'assistant-1', msg_type: 'text', content: ['回复'],
            metadata: { useful: true, access_token: token, nested: { client_secret: CLIENT_SECRET, text: token } },
            attachments: [{ name: '附件', token, url: 'https://example.com/file' }], forbidden: 'not public', refresh_token: identity.refresh }
        ], access_token: token, total: 99, done: true
      } });
    }
    assert.fail('不应请求其他上游端点：' + endpoint);
  };
  const config = { publicUrl: PUBLIC, clientId: 'relay-client', clientSecret: CLIENT_SECRET,
    storagePath: path.join(directory, 'credentials.enc'), encryptionKey: key, fetchImpl, now: () => clock, ...overrides };
  let server;
  let base;
  async function listen() {
    server = createRelay(config);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
  }
  await listen();
  t.after(async () => {
    await close(server);
    // 只清理由本测试创建的临时目录，绝不触碰用户项目目录。
    await fs.rm(directory, { recursive: true, force: true });
  });
  const f = {
    mock, config, directory, key,
    get server() { return server; },
    get base() { return base; },
    get time() { return clock; },
    advance(ms) { clock += ms; },
    async restart() { await close(server); await listen(); },
    async request(route, { method = 'GET', token, body, headers = {}, rawBody, chunks } = {}) {
      const allHeaders = { ...headers };
      if (token) allHeaders.authorization = 'Bearer ' + token;
      let payload = rawBody;
      if (body !== undefined) {
        allHeaders['content-type'] ||= 'application/json';
        payload = JSON.stringify(body);
      }
      return rawRequest(base, route, { method, headers: allHeaders, body: payload, chunks });
    },
    async start() {
      const claimVerifier = verifier();
      const result = await f.request('/v1/auth/start', { method: 'POST', body: { claimChallenge: digest(claimVerifier) } });
      assert.equal(result.status, 200, result.text);
      return { ...result.data, claimVerifier, state: new URL(result.data.authorizeUrl).searchParams.get('state') };
    },
    callback(attempt, code = 'test-code') {
      return f.request('/oauth/callback?' + new URLSearchParams({ state: attempt.state, code }));
    },
    claim(attempt, claimVerifier = attempt.claimVerifier) {
      return f.request('/v1/auth/claim', { method: 'POST', body: { id: attempt.id, claimVerifier } });
    },
    cancel(attempt, claimVerifier = attempt.claimVerifier) {
      return f.request('/v1/auth/cancel', { method: 'POST', body: { id: attempt.id, claimVerifier } });
    },
    async login(openId = 'account-one') {
      const attempt = await f.start();
      const code = 'code-' + verifier();
      codes.set(code, openId);
      const callback = await f.callback(attempt, code);
      assert.equal(callback.status, 200, callback.text);
      const claimed = await f.claim(attempt);
      assert.equal(claimed.status, 200, claimed.text);
      assert.equal(claimed.data.status, 'ready');
      return claimed.data;
    },
    send(token, content = '执行工作') {
      return f.request('/v1/localassistant/message', { method: 'POST', token, body: { content, msg_type: 'text' } });
    },
    release(token, messageId) {
      return f.request('/v1/localassistant/release', { method: 'POST', token, body: { messageId } });
    },
    async disk() {
      const envelope = JSON.parse(await fs.readFile(config.storagePath, 'utf8'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from(JSON.stringify(['gongzuo-workbuddy-relay-v1', config.publicUrl, config.clientId])));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    }
  };
  return f;
}

function noSecrets(text, values = []) {
  for (const secret of [CLIENT_SECRET, 'WB_ACCESS_SECRET_', 'WB_REFRESH_SECRET_', ...values]) assert.ok(!text.includes(secret), '输出中不能出现秘密：' + secret.slice(0, 8));
}

function callbackHeaders(result) {
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert.match(result.headers['content-security-policy'], /default-src 'none'/);
  assert.match(result.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.ok(!/https?:\/\//.test(result.text));
}

test('生产配置拒绝 loopback、路径、userinfo、伪域名；HTTP 只能显式用于 loopback 测试', () => {
  const config = { publicUrl: PUBLIC, clientId: 'id', clientSecret: 'secret', storagePath: '/tmp/relay-never-created.enc', encryptionKey: crypto.randomBytes(32) };
  for (const publicUrl of ['http://relay.example.com', 'http://127.0.0.1:8787', 'https://localhost', 'https://127.0.0.1',
    'https://[::1]', 'https://relay', 'https://relay.local', 'https://relay.internal', 'https://relay.test',
    'https://relay.example.com/', 'https://relay.example.com/path', 'https://relay.example.com?x=1',
    'https://relay.example.com#x', 'https://user:password@relay.example.com', 'https://@relay.example.com', 'https://relay.example.com\\evil',
    'https://relay%2eexample.com', ' https://relay.example.com']) {
    assert.throws(() => createRelay({ ...config, publicUrl }), undefined, publicUrl);
  }
  assert.throws(() => createRelay({ ...config, allowTestHttp: true, publicUrl: 'http://external.example.com' }));
  assert.throws(() => createRelay({ ...config, allowTestHttp: true, publicUrl: 'https://127.0.0.1' }));
  assert.throws(() => createRelay({ ...config, apiBase: 'https://attacker.example.com' }));
  assert.throws(() => createRelay({ ...config, apiBase: 'http://127.0.0.1:1234' }));
  assert.throws(() => createRelay({ ...config, encryptionKey: 'weak' }));
  assert.throws(() => createRelay({ ...config, storagePath: 'relative.enc' }));
  const server = createRelay({ ...config, publicUrl: 'http://127.0.0.1:8787', allowTestHttp: true });
  server.emit('close');
});

test('healthz 与完整 OAuth/PKCE 契约：官方 authorize、精确 redirect_uri、一次性 claim', async t => {
  const f = await fixture(t);
  const health = await f.request('/healthz');
  assert.deepEqual(health.data, { ok: true, service: 'gongzuo-workbuddy-relay', redirectUri: PUBLIC + '/oauth/callback', scopes: SCOPES });
  noSecrets(health.text);
  const attempt = await f.start();
  const url = new URL(attempt.authorizeUrl);
  assert.equal(url.origin + url.pathname, API + '/authorize');
  assert.equal(url.searchParams.get('scope'), SCOPES.join(' '));
  assert.equal(url.searchParams.get('redirect_uri'), PUBLIC + '/oauth/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(attempt.expiresAt, f.time + 300_000);
  noSecrets(attempt.authorizeUrl, [attempt.claimVerifier]);
  assert.deepEqual((await f.claim(attempt)).data, { status: 'pending' });
  const code = 'secret-authorization-code';
  const callback = await f.callback(attempt, code);
  assert.equal(callback.status, 200);
  callbackHeaders(callback);
  noSecrets(callback.text, [code]);
  const form = f.mock.tokenForms[0];
  assert.equal(form.get('redirect_uri'), url.searchParams.get('redirect_uri'));
  assert.equal(form.get('code'), code);
  assert.equal(digest(form.get('code_verifier')), url.searchParams.get('code_challenge'));
  assert.notEqual(form.get('code_verifier'), attempt.claimVerifier);
  await assert.rejects(fs.access(f.config.storagePath));
  const ready = await f.claim(attempt);
  assert.equal(ready.data.status, 'ready');
  assert.match(ready.data.sessionToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(ready.data.expiresAt, f.time + 30 * 86400_000);
  assert.equal(ready.data.scope, SCOPES.join(' '));
  noSecrets(ready.text);
  assert.equal((await f.claim(attempt)).status, 400);
  assert.equal((await f.callback(attempt, code)).status, 400);
  assert.equal(f.mock.tokenForms.length, 1);
  const status = await f.request('/v1/auth/status', { token: ready.data.sessionToken });
  assert.deepEqual(status.data, { authorized: true, nickname: '测试用户', openId: 'account-one', scope: SCOPES.join(' '), expiresAt: ready.data.expiresAt });
  assert.ok(!status.text.includes(ready.data.sessionToken));
});

test('伪造 state、重复 state/code、缺失 code 均不兑换且不损坏合法授权', async t => {
  const f = await fixture(t);
  const a = await f.start();
  const invalid = [
    'state=' + verifier() + '&code=evil',
    'state=' + a.state + '&state=' + a.state + '&code=c',
    'state=' + a.state + '&code=a&code=b',
    'state=' + a.state,
    'state=' + a.state + '&code=',
    'state=' + a.state + '&code=a&error=access_denied'
  ];
  for (const query of invalid) {
    const result = await f.request('/oauth/callback?' + query);
    assert.equal(result.status, 400);
    callbackHeaders(result);
  }
  assert.equal(f.mock.tokenForms.length, 0);
  assert.deepEqual((await f.claim(a)).data, { status: 'pending' });
  assert.equal((await f.callback(a)).status, 200);
});

test('exchange 正在进行也消耗 state，多个并发 claim 只有一份 ready', async t => {
  const f = await fixture(t);
  const entered = deferred();
  const gate = deferred();
  f.mock.tokenHook = async () => { entered.resolve(); await gate.promise; };
  const a = await f.start();
  const callback = f.callback(a);
  await entered.promise;
  assert.equal((await f.callback(a)).status, 400);
  assert.deepEqual((await f.claim(a)).data, { status: 'pending' });
  gate.resolve();
  assert.equal((await callback).status, 200);
  const claims = await Promise.all([f.claim(a), f.claim(a), f.claim(a)]);
  assert.equal(claims.filter(item => item.data?.status === 'ready').length, 1);
  assert.ok(claims.filter(item => item.data?.status !== 'ready').every(item => [400, 409].includes(item.status)));
  assert.equal(f.mock.tokenForms.length, 1);
  assert.equal((await f.disk()).sessions.length, 1);
});

test('盗领/盗取消不能泄露 pending、ready 或 failed 状态，verifier 至少 32 字节', async t => {
  const f = await fixture(t);
  const a = await f.start();
  const stolen = verifier();
  const pending = await f.claim(a, stolen);
  assert.equal(pending.status, 400);
  assert.equal((await f.cancel(a, stolen)).status, 400);
  for (const bad of ['short', 'A'.repeat(42), '!'.repeat(43), verifier() + '=']) assert.equal((await f.claim(a, bad)).status, 400);
  await f.callback(a);
  const ready = await f.claim(a, stolen);
  assert.deepEqual(ready.data, pending.data);
  const unknown = await f.claim({ id: verifier(), claimVerifier: stolen });
  assert.deepEqual(unknown.data, pending.data);
  assert.equal((await f.claim(a)).data.status, 'ready');
  const b = await f.start();
  await f.request('/oauth/callback?' + new URLSearchParams({ state: b.state, error: 'access_denied' }));
  assert.deepEqual((await f.claim(b, stolen)).data, pending.data);
  assert.equal((await f.claim(b)).data.status, 'failed');
});

test('取消 pending 和 exchange 中的授权：后续回调不会产生 session 或保存 token', async t => {
  const f = await fixture(t);
  const a = await f.start();
  assert.deepEqual((await f.cancel(a)).data, { ok: true });
  assert.equal((await f.callback(a)).status, 400);
  assert.equal((await f.claim(a)).status, 400);
  assert.equal(f.mock.tokenForms.length, 0);
  const b = await f.start();
  const entered = deferred();
  const gate = deferred();
  f.mock.tokenHook = async () => { entered.resolve(); await gate.promise; };
  const callback = f.callback(b);
  await entered.promise;
  assert.equal((await f.cancel(b)).status, 200);
  gate.resolve();
  assert.equal((await callback).status, 400);
  assert.equal((await f.claim(b)).status, 400);
  assert.equal(f.mock.calls.filter(item => item.endpoint === 'user/profile').length, 0);
  await assert.rejects(fs.access(f.config.storagePath));
});

test('5 分钟 TTL：超时前后及兑换中超时均不能领取', async t => {
  const f = await fixture(t);
  const a = await f.start();
  f.advance(300_000);
  assert.equal((await f.claim(a)).status, 400);
  assert.equal((await f.callback(a)).status, 400);
  const b = await f.start();
  const entered = deferred();
  const gate = deferred();
  f.mock.tokenHook = async () => { entered.resolve(); await gate.promise; };
  const callback = f.callback(b);
  await entered.promise;
  f.advance(300_000);
  gate.resolve();
  assert.equal((await callback).status, 400);
  assert.equal((await f.claim(b)).status, 400);
  await assert.rejects(fs.access(f.config.storagePath));
  f.mock.tokenHook = null;
  const c = await f.start();
  await f.callback(c);
  f.advance(300_000);
  assert.equal((await f.claim(c)).status, 400);
});

test('OAuth 原始错误、HTML 和错误描述永不输出，失败 poll 使用固定 code/message', async t => {
  const f = await fixture(t);
  const a = await f.start();
  const evil = '<script>' + CLIENT_SECRET + '</script>';
  const callback = await f.request('/oauth/callback?' + new URLSearchParams({ state: a.state, error: evil, error_description: 'raw-error-detail' }));
  assert.equal(callback.status, 400);
  callbackHeaders(callback);
  noSecrets(callback.text, [evil, 'raw-error-detail']);
  assert.deepEqual((await f.claim(a)).data, { status: 'failed', code: 'authorization_denied', message: '授权未完成，请重新发起授权' });
  const b = await f.start();
  f.mock.tokenHook = () => response({ error: CLIENT_SECRET, error_description: evil }, 400);
  const failed = await f.callback(b, 'code-never-shown');
  noSecrets(failed.text, ['code-never-shown', evil]);
  const poll = await f.claim(b);
  assert.equal(poll.data.code, 'authorization_failed');
  noSecrets(poll.text, [evil]);
});

test('只接收 JSON 对象和限定字段，16KB Content-Length 与 chunked 限制有效', async t => {
  const f = await fixture(t);
  for (const route of ['/v1/auth/start', '/v1/auth/claim', '/v1/auth/cancel']) {
    assert.equal((await f.request(route, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, rawBody: 'id=a' })).status, 415);
  }
  assert.equal((await f.request('/v1/auth/start', { method: 'POST', rawBody: '[]', headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await f.request('/v1/auth/start', { method: 'POST', rawBody: '{', headers: { 'content-type': 'application/json' } })).status, 400);
  const a = await f.start();
  assert.equal((await f.request('/v1/auth/claim', { method: 'POST', body: { id: a.id, claimVerifier: a.claimVerifier, client_secret: 'not allowed' } })).status, 400);
  const large = JSON.stringify({ id: a.id, claimVerifier: 'A'.repeat(17000) });
  assert.equal((await f.request('/v1/auth/claim', { method: 'POST', rawBody: large, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(large) } })).status, 413);
  assert.equal((await f.request('/v1/auth/claim', { method: 'POST', chunks: [large.slice(0, 8000), large.slice(8000)], headers: { 'content-type': 'application/json' } })).status, 413);
  assert.equal((await f.claim(a)).data.status, 'pending');
});

test('不完整 JSON 请求主动断连不会产生未处理 error 或终止服务', async t => {
  const f = await fixture(t);
  const received = deferred();
  const aborted = deferred();
  f.server.once('request', req => {
    req.once('aborted', () => aborted.resolve());
    received.resolve();
  });
  const request = http.request(new URL('/v1/auth/start', f.base), { method: 'POST', agent: false,
    headers: { 'content-type': 'application/json', 'content-length': 1024 } });
  request.on('error', () => {});
  request.write('{"claim');
  await received.promise;
  request.destroy();
  await aborted.promise;
  assert.equal((await f.request('/healthz')).status, 200);
  assert.equal(f.mock.calls.length, 0);
});

test('Origin 全面拒绝；Cookie、query sessionToken 和错误 Bearer 均不能认证', async t => {
  const f = await fixture(t);
  const user = await f.login();
  const a = await f.start();
  for (const [route, method, body] of [
    ['/v1/auth/start', 'POST', { claimChallenge: digest(verifier()) }],
    ['/v1/auth/claim', 'POST', { id: a.id, claimVerifier: a.claimVerifier }],
    ['/v1/auth/cancel', 'POST', { id: a.id, claimVerifier: a.claimVerifier }],
    ['/v1/auth/status', 'GET'], ['/v1/auth/session', 'DELETE'], ['/v1/localassistant', 'GET'],
    ['/v1/localassistant/message', 'POST', { msg_type: 'text', content: '工作' }],
    ['/v1/localassistant/release', 'POST', { messageId: 'x' }]
  ]) {
    for (const origin of ['https://relay.example.com', 'null', '']) {
      const result = await f.request(route, { method, body, token: user.sessionToken, headers: { origin } });
      assert.equal(result.status, 403, route);
      noSecrets(result.text);
    }
  }
  assert.equal((await f.request('/v1/auth/status', { headers: { cookie: 'sessionToken=' + user.sessionToken } })).status, 401);
  assert.equal((await f.request('/v1/auth/status?sessionToken=' + user.sessionToken)).status, 400);
  for (const header of ['Bearer short', 'Basic ' + user.sessionToken, user.sessionToken, 'Bearer ' + user.sessionToken + ' extra']) {
    assert.equal((await f.request('/v1/auth/status', { headers: { authorization: header } })).status, 401);
  }
  assert.equal((await f.request('/v1/auth/status', { token: user.sessionToken })).status, 200);
  assert.equal(f.mock.sendAttempts, 0);
});

test('auth 已验证claim按attempt 60次/分钟、start按socket 10次/分钟，代理头不能绕过', async t => {
  const f = await fixture(t);
  const a = await f.start();
  for (let i = 0; i < 60; i++) assert.equal((await f.claim(a)).status, 200);
  const blocked = await f.request('/v1/auth/claim', { method: 'POST', body: { id: a.id, claimVerifier: a.claimVerifier }, headers: { 'x-forwarded-for': 'new-ip' } });
  assert.equal(blocked.status, 429);
  f.advance(60_001);
  assert.equal((await f.claim(a)).status, 200);
  for (let i = 0; i < 10; i++) await f.start();
  assert.equal((await f.request('/v1/auth/start', { method: 'POST', body: { claimChallenge: digest(verifier()) } })).status, 429);
});

test('attempt 上限 500，TTL 清理后释放容量；按 socket 地址而非客户端头限频', async t => {
  const f = await fixture(t);
  let serial = 0;
  // 注入不同的真实连接身份，只替换测试 server socket，不在生产信任代理头。
  f.server.on('connection', socket => Object.defineProperty(socket, 'remoteAddress', { value: 'test-remote-' + (++serial) }));
  for (let i = 0; i < 500; i++) await f.start();
  assert.equal((await f.request('/v1/auth/start', { method: 'POST', body: { claimChallenge: digest(verifier()) } })).data.error.code, 'attempt_limit');
  f.advance(300_000);
  assert.ok((await f.start()).id);
});

test('AES256GCM 加密、SHA256 session 索引、0600 原子存储与重启恢复', async t => {
  const f = await fixture(t);
  const user = await f.login();
  const raw = await fs.readFile(f.config.storagePath, 'utf8');
  noSecrets(raw, [user.sessionToken, user.openId, user.nickname, digest(user.sessionToken)]);
  assert.equal((await fs.stat(f.config.storagePath)).mode & 0o777, 0o600);
  assert.equal((await fs.readdir(f.directory)).filter(name => name.endsWith('.tmp')).length, 0);
  const saved = await f.disk();
  assert.equal(saved.sessions[0][0], digest(user.sessionToken));
  assert.equal(saved.sessions[0][1].expiresAt, user.expiresAt);
  assert.ok(saved.accounts[0][1].tokens.accessExpiresAt < user.expiresAt);
  assert.throws(() => createRelay({ ...f.config, encryptionKey: crypto.randomBytes(32) }), /拒绝启动/);
  assert.throws(() => createRelay({ ...f.config, publicUrl: 'https://another.example.com' }), /拒绝启动/);
  await f.restart();
  assert.equal((await f.request('/v1/auth/status', { token: user.sessionToken })).status, 200);
  assert.equal((await f.request('/v1/localassistant', { token: user.sessionToken })).data.data.online, true);
  const envelope = JSON.parse(raw);
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  ciphertext[0] ^= 1;
  envelope.ciphertext = ciphertext.toString('base64');
  await fs.writeFile(f.config.storagePath, JSON.stringify(envelope));
  assert.throws(() => createRelay(f.config), /拒绝启动/);
});

test('relay credential 30 天过期，与 WorkBuddy access_token 过期独立', async t => {
  const f = await fixture(t);
  const user = await f.login();
  f.advance(3600_000);
  assert.equal((await f.request('/v1/auth/status', { token: user.sessionToken })).status, 200);
  assert.equal((await f.request('/v1/localassistant', { token: user.sessionToken })).status, 200);
  assert.equal(f.mock.refreshes.length, 1);
  f.advance(30 * 86400_000 - 3600_000);
  assert.equal((await f.request('/v1/auth/status', { token: user.sessionToken })).status, 401);
  await f.restart();
  assert.equal((await f.request('/v1/auth/status', { token: user.sessionToken })).status, 401);
});

test('跨两个设备的预过期刷新 single-flight，并持久化 refresh token rotation', async t => {
  const f = await fixture(t);
  const one = await f.login();
  const two = await f.login();
  f.advance(3550_000);
  const entered = deferred();
  const gate = deferred();
  f.mock.tokenHook = async form => {
    if (form.get('grant_type') === 'refresh_token') { entered.resolve(); await gate.promise; }
  };
  const reads = [f.request('/v1/localassistant', { token: one.sessionToken }), f.request('/v1/localassistant', { token: two.sessionToken })];
  await entered.promise;
  gate.resolve();
  assert.ok((await Promise.all(reads)).every(item => item.status === 200));
  assert.equal(f.mock.refreshes.length, 1);
  const saved = await f.disk();
  const rotated = saved.accounts[0][1].tokens.refreshToken;
  assert.notEqual(rotated, f.mock.refreshes[0].get('refresh_token'));
  await f.restart();
  f.advance(3550_000);
  assert.equal((await f.request('/v1/localassistant', { token: one.sessionToken })).status, 200);
  assert.equal(f.mock.refreshes.length, 2);
  assert.equal(f.mock.refreshes[1].get('refresh_token'), rotated);
});

test('GET 上游 401 只刷新一次并重试一次；持久失败不暴露上游错误', async t => {
  const f = await fixture(t);
  const user = await f.login();
  let count = 0;
  f.mock.onlineHook = () => ++count === 1 ? response({ error: CLIENT_SECRET }, 401) : wrapped({ online: true });
  assert.equal((await f.request('/v1/localassistant', { token: user.sessionToken })).status, 200);
  assert.equal(count, 2);
  assert.equal(f.mock.refreshes.length, 1);
  f.mock.onlineHook = () => { count++; return response({ error: CLIENT_SECRET, access_token: 'WB_ACCESS_SECRET_FORGED' }, 401); };
  const result = await f.request('/v1/localassistant', { token: user.sessionToken });
  assert.equal(result.status, 502);
  assert.equal(count, 4);
  assert.equal(f.mock.refreshes.length, 2);
  noSecrets(result.text);
});

test('POST 401 刷新但绝不重放；未确认发送保持互斥并提供可显式释放的 marker', async t => {
  const f = await fixture(t);
  const user = await f.login();
  f.mock.sendHook = () => response({ error: CLIENT_SECRET }, 401);
  const result = await f.send(user.sessionToken);
  assert.equal(result.status, 409);
  assert.equal(result.data.error.code, 'write_recheck_required');
  assert.match(result.data.messageId, /^uncertain_/);
  noSecrets(result.text);
  assert.equal(f.mock.sendAttempts, 1);
  assert.equal(f.mock.refreshes.length, 1);
  assert.equal((await f.send(user.sessionToken)).status, 409);
  assert.equal((await f.request('/v1/localassistant/message?message_id=' + result.data.messageId, { token: user.sessionToken })).status, 409);
  await f.restart();
  assert.equal((await f.send(user.sessionToken)).status, 409);
  assert.equal((await f.release(user.sessionToken, result.data.messageId)).status, 200);
  f.mock.sendHook = null;
  assert.equal((await f.send(user.sessionToken)).status, 200);
  assert.equal(f.mock.sendAttempts, 2);
});

test('刷新 invalid_grant 删除 provider 凭据，刷新网络失败不会发送且可安全重试', async t => {
  const f = await fixture(t);
  const user = await f.login();
  f.advance(3550_000);
  f.mock.tokenHook = () => { throw new Error(CLIENT_SECRET); };
  const network = await f.send(user.sessionToken);
  assert.equal(network.status, 502);
  noSecrets(network.text);
  assert.equal(f.mock.sendAttempts, 0);
  assert.equal((await f.disk()).inflight.length, 0);
  f.mock.tokenHook = () => response({ error: 'invalid_grant', error_description: CLIENT_SECRET }, 400);
  assert.equal((await f.request('/v1/localassistant', { token: user.sessionToken })).status, 401);
  assert.equal((await f.request('/v1/auth/status', { token: user.sessionToken })).status, 401);
  await f.restart();
  assert.equal((await f.request('/v1/auth/status', { token: user.sessionToken })).status, 401);
});

test('跨设备并发发送全局互斥，读与 release 必须属于 inflight session，不将首 assistant 当完成', async t => {
  const f = await fixture(t);
  const one = await f.login();
  const two = await f.login();
  const results = await Promise.all([f.send(one.sessionToken, '设备一'), f.send(two.sessionToken, '设备二')]);
  assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
  assert.equal(f.mock.sendAttempts, 1);
  const owner = results[0].status === 200 ? one : two;
  const other = owner === one ? two : one;
  const messageId = results.find(item => item.status === 200).data.data.message_id;
  const route = '/v1/localassistant/message?message_id=' + messageId + '&limit=100&offset=0';
  assert.equal((await f.request(route, { token: other.sessionToken })).status, 409);
  assert.equal((await f.release(other.sessionToken, messageId)).status, 409);
  const read = await f.request(route, { token: owner.sessionToken });
  assert.equal(read.status, 200);
  assert.equal(read.data.data.messages[1].role, 'assistant');
  assert.equal((await f.send(owner.sessionToken)).status, 409);
  assert.equal((await f.send(other.sessionToken)).status, 409);
  assert.equal((await f.release(owner.sessionToken, messageId)).status, 200);
  assert.equal((await f.send(other.sessionToken)).status, 200);
});

test('独立 openId 可并发发送，多个设备 token 的所有权仍按 provider 账号隔离', async t => {
  const f = await fixture(t);
  const one = await f.login('account-a');
  const two = await f.login('account-b');
  const result = await Promise.all([f.send(one.sessionToken), f.send(two.sessionToken)]);
  assert.ok(result.every(item => item.status === 200));
  assert.deepEqual(new Set(f.mock.sends.map(item => item.identity)), new Set(['account-a', 'account-b']));
  assert.equal((await f.release(two.sessionToken, result[0].data.data.message_id)).status, 409);
});

test('检测其他 user 消息返回可操作 409，既不输出其他消息也不自动清理锁', async t => {
  const f = await fixture(t);
  const user = await f.login();
  const sent = await f.send(user.sessionToken);
  const id = sent.data.data.message_id;
  f.mock.messagesHook = () => wrapped({ messages: [{ role: 'user', message_id: 'foreign-id', content: ['foreign-private-content'] }] });
  const conflict = await f.request('/v1/localassistant/message?message_id=' + id, { token: user.sessionToken });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, 'message_stream_conflict');
  assert.ok(!conflict.text.includes('foreign-private-content'));
  assert.equal((await f.send(user.sessionToken)).status, 409);
  assert.equal((await f.release(user.sessionToken, id)).status, 200);
});

test('固定 localassistant 端点、消息字段与分页白名单，permission_response 和任意代理被拒绝', async t => {
  const f = await fixture(t);
  const user = await f.login();
  for (const body of [
    { content: '工作', msg_type: 'permission_response' }, { content: '工作', msg_type: 'image' },
    { content: '工作' }, { content: '', msg_type: 'text' }, { content: ' '.repeat(5), msg_type: 'text' },
    { content: 'x'.repeat(4001), msg_type: 'text' }, { content: '工作', msg_type: 'text', url: 'https://evil.example.com' },
    { content: '工作', msg_type: 'text', task_id: 'cloud-task' }
  ]) assert.equal((await f.request('/v1/localassistant/message', { method: 'POST', token: user.sessionToken, body })).status, 400);
  for (const route of ['/v1/proxy', '/v1/tasks', '/openapi/v2/tasks', '/v1/user/profile', '/v1/localassistant/anything']) {
    assert.equal((await f.request(route, { token: user.sessionToken })).status, 404);
  }
  assert.equal(f.mock.sendAttempts, 0);
  const online = await f.request('/v1/localassistant', { token: user.sessionToken });
  assert.deepEqual(online.data, { code: 0, msg: 'ok', data: { online: true } });
  noSecrets(online.text);
  f.mock.online = false;
  assert.deepEqual((await f.request('/v1/localassistant', { token: user.sessionToken })).data.data, { online: false });
  const sent = await f.send(user.sessionToken, 'x'.repeat(4000));
  assert.equal(sent.status, 200);
  const id = sent.data.data.message_id;
  const valid = await f.request('/v1/localassistant/message?message_id=' + id + '&limit=1&offset=42', { token: user.sessionToken });
  assert.equal(valid.status, 200);
  assert.deepEqual(Object.keys(valid.data.data), ['messages']);
  assert.deepEqual(Object.keys(valid.data.data.messages[1]).sort(), ['attachments', 'content', 'message_id', 'metadata', 'msg_type', 'role']);
  assert.equal(valid.data.data.messages[1].metadata.nested.text, '[已隐藏]');
  assert.ok(!Object.hasOwn(valid.data.data.messages[1].attachments[0], 'token'));
  noSecrets(valid.text);
  for (const query of ['limit=0', 'limit=101', 'limit=01', 'limit=-1', 'offset=-1', 'offset=1.5', 'offset=999999999999999999999',
    'limit=1&limit=2', 'message_id=' + id, 'url=https://evil.example.com', 'access_token=x', 'cursor=x', 'task_id=x']) {
    assert.equal((await f.request('/v1/localassistant/message?message_id=' + id + '&' + query, { token: user.sessionToken })).status, 400, query);
  }
  assert.equal((await f.request('/v1/localassistant/message?message_id=%2Fetc%2Fpasswd', { token: user.sessionToken })).status, 400);
  assert.equal((await f.request('/v1/localassistant/message', { token: user.sessionToken })).status, 400);
  assert.ok(f.mock.calls.every(item => ['token', 'user/profile', 'localassistant', 'localassistant/message'].includes(item.endpoint)));
});

test('inflight 加密持久化：正常重启后仍阻止第二任务，只允许原 session 显式释放', async t => {
  const f = await fixture(t);
  const one = await f.login();
  const two = await f.login();
  const id = (await f.send(one.sessionToken)).data.data.message_id;
  assert.equal((await f.disk()).inflight[0][1].messageId, id);
  noSecrets(await fs.readFile(f.config.storagePath, 'utf8'), [one.sessionToken, two.sessionToken, id]);
  await f.restart();
  assert.equal((await f.send(two.sessionToken)).status, 409);
  assert.equal((await f.request('/v1/localassistant/message?message_id=' + id, { token: one.sessionToken })).status, 200);
  assert.equal((await f.release(two.sessionToken, id)).status, 409);
  assert.equal((await f.release(one.sessionToken, id)).status, 200);
  await f.restart();
  assert.equal((await f.send(two.sessionToken)).status, 200);
});

test('网络发送失败不自动重试，uncertain 锁与释放 marker 跨重启恢复', async t => {
  const f = await fixture(t);
  const user = await f.login();
  f.mock.sendHook = () => { throw new Error('network raw ' + CLIENT_SECRET); };
  const result = await f.send(user.sessionToken);
  assert.equal(result.status, 502);
  assert.equal(result.data.error.code, 'write_uncertain');
  noSecrets(result.text);
  assert.equal(f.mock.sendAttempts, 1);
  await f.restart();
  assert.equal((await f.send(user.sessionToken)).status, 409);
  assert.equal((await f.release(user.sessionToken, result.data.messageId)).status, 200);
});

test('发送前持久化所有权，发送进行中禁止提前 release 避免并发穿透', async t => {
  const f = await fixture(t);
  const user = await f.login();
  const entered = deferred();
  const gate = deferred();
  f.mock.sendHook = async () => { entered.resolve(); await gate.promise; };
  const sending = f.send(user.sessionToken);
  await entered.promise;
  const saved = await f.disk();
  const record = saved.inflight[0][1];
  assert.equal(record.phase, 'sending');
  assert.equal((await f.release(user.sessionToken, record.messageId)).data.error.code, 'send_in_progress');
  assert.equal((await f.send(user.sessionToken)).status, 409);
  gate.resolve();
  const result = await sending;
  assert.equal(result.status, 200);
  assert.equal((await f.release(user.sessionToken, result.data.data.message_id)).status, 200);
});

test('重启遇到 sending/reserved 会 fail closed 转为 uncertain，而不是丢弃锁', async t => {
  const f = await fixture(t);
  const user = await f.login();
  const id = (await f.send(user.sessionToken)).data.data.message_id;
  const saved = await f.disk();
  saved.inflight[0][1].phase = 'sending';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', f.key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(['gongzuo-workbuddy-relay-v1', PUBLIC, 'relay-client'])));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(saved), 'utf8'), cipher.final()]);
  await fs.writeFile(f.config.storagePath, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') }));
  await f.restart();
  assert.equal((await f.send(user.sessionToken)).status, 409);
  assert.equal((await f.request('/v1/localassistant/message?message_id=' + id, { token: user.sessionToken })).status, 409);
  assert.equal((await f.release(user.sessionToken, id)).status, 200);
});

test('revoke 服务端删除并持久化，不调用未文档化的 WorkBuddy revoke', async t => {
  const f = await fixture(t);
  const one = await f.login();
  const two = await f.login();
  assert.equal((await f.request('/v1/auth/session', { method: 'DELETE', token: one.sessionToken })).status, 204);
  assert.equal((await f.request('/v1/auth/status', { token: one.sessionToken })).status, 401);
  assert.equal((await f.request('/v1/auth/status', { token: two.sessionToken })).status, 200);
  await f.restart();
  assert.equal((await f.request('/v1/auth/status', { token: one.sessionToken })).status, 401);
  assert.equal((await f.disk()).sessions.length, 1);
  assert.equal((await f.request('/v1/auth/session', { method: 'DELETE', token: two.sessionToken })).status, 204);
  assert.deepEqual((await f.disk()).accounts, []);
  assert.ok(!f.mock.calls.some(item => item.endpoint.includes('revoke')));
});

test('revoke 不等同任务完成：所有者被撤销后仍 fail closed 阻止其他设备混串', async t => {
  const f = await fixture(t);
  const one = await f.login();
  const two = await f.login();
  const id = (await f.send(one.sessionToken)).data.data.message_id;
  await f.request('/v1/auth/session', { method: 'DELETE', token: one.sessionToken });
  assert.equal((await f.release(one.sessionToken, id)).status, 401);
  assert.equal((await f.release(two.sessionToken, id)).status, 409);
  await f.restart();
  assert.equal((await f.send(two.sessionToken)).status, 409);
});

test('revoke 与刷新竞争时不能复活 session 或 provider 凭据', async t => {
  const f = await fixture(t);
  const user = await f.login();
  f.advance(3550_000);
  const entered = deferred();
  const gate = deferred();
  f.mock.tokenHook = async () => { entered.resolve(); await gate.promise; };
  const reading = f.request('/v1/localassistant', { token: user.sessionToken });
  await entered.promise;
  assert.equal((await f.request('/v1/auth/session', { method: 'DELETE', token: user.sessionToken })).status, 204);
  gate.resolve();
  assert.equal((await reading).status, 401);
  assert.equal((await f.disk()).accounts.length, 0);
  await f.restart();
  assert.equal((await f.request('/v1/auth/status', { token: user.sessionToken })).status, 401);
});

test('并发 claim/revoke 的单进程写队列不会覆盖其他会话，重启得到最终状态', async t => {
  const f = await fixture(t);
  const attempts = await Promise.all([f.start(), f.start(), f.start(), f.start()]);
  await Promise.all(attempts.map((a, i) => f.callback(a, 'concurrent-' + i)));
  const users = await Promise.all(attempts.map(a => f.claim(a)));
  assert.ok(users.every(item => item.data?.status === 'ready'));
  assert.equal((await f.disk()).sessions.length, 4);
  await Promise.all(users.slice(0, 2).map(item => f.request('/v1/auth/session', { method: 'DELETE', token: item.data.sessionToken })));
  await f.restart();
  assert.equal((await f.disk()).sessions.length, 2);
  for (let i = 0; i < 4; i++) assert.equal((await f.request('/v1/auth/status', { token: users[i].data.sessionToken })).status, i < 2 ? 401 : 200);
});

test('存储失败必须 fail closed，不向客户端发 session，也不能继续调用本地助理', async t => {
  const f = await fixture(t);
  f.config.storagePath = path.join(f.directory, 'missing-parent', 'credentials.enc');
  await f.restart();
  const a = await f.start();
  assert.equal((await f.callback(a)).status, 200);
  const result = await f.claim(a);
  assert.equal(result.status, 503);
  assert.ok(!result.text.includes('sessionToken'));
  noSecrets(result.text);
  assert.equal((await f.request('/healthz')).data.ok, false);
  assert.equal((await f.request('/v1/localassistant', { token: verifier() })).status, 503);
  assert.equal(f.mock.sendAttempts, 0);
});

test('上游超 scope 和身份不一致不会发 session，原始响应绝不泄露', async t => {
  const f = await fixture(t);
  f.mock.tokenHook = () => response({ access_token: 'WB_ACCESS_SECRET_EXTRA', refresh_token: 'WB_REFRESH_SECRET_EXTRA',
    expires_in: 3600, scope: SCOPES.join(' ') + ' user.task.invokable', open_id: 'account-one' });
  const a = await f.start();
  const callback = await f.callback(a);
  assert.equal(callback.status, 400);
  noSecrets(callback.text);
  assert.equal((await f.claim(a)).data.status, 'failed');
  f.mock.tokenHook = null;
  f.mock.profileHook = () => wrapped({ open_id: 'different-identity', nickname: CLIENT_SECRET });
  const b = await f.start();
  assert.equal((await f.callback(b)).status, 400);
  assert.equal((await f.claim(b)).data.status, 'failed');
  await assert.rejects(fs.access(f.config.storagePath));
});

test('上游异常和跨主机重定向被拒绝，错误响应不含 token/secret/raw message', async t => {
  const f = await fixture(t);
  const user = await f.login();
  f.mock.onlineHook = () => new Response(JSON.stringify({ secret: CLIENT_SECRET }), { status: 302, headers: { location: 'https://evil.example.com' } });
  const redirected = await f.request('/v1/localassistant', { token: user.sessionToken });
  assert.equal(redirected.status, 502);
  noSecrets(redirected.text);
  f.mock.onlineHook = () => { throw new Error('RAW_ERROR_' + CLIENT_SECRET); };
  const network = await f.request('/v1/localassistant', { token: user.sessionToken });
  assert.equal(network.status, 502);
  noSecrets(network.text, ['RAW_ERROR_']);
  f.mock.onlineHook = () => response({ code: 12, msg: CLIENT_SECRET, data: { access_token: 'WB_ACCESS_SECRET_ERROR' } });
  const bad = await f.request('/v1/localassistant', { token: user.sessionToken });
  assert.equal(bad.status, 502);
  noSecrets(bad.text);
});

test('ready 取消和 claim 落盘期间取消不会留下可领取 session 或替换原账号 token', async t => {
  const f = await fixture(t);
  const user = await f.login();
  const previous = (await f.disk()).accounts[0][1].tokens.accessToken;
  const ready = await f.start();
  await f.callback(ready);
  assert.equal((await f.cancel(ready)).status, 200);
  assert.equal((await f.claim(ready)).status, 400);
  const a = await f.start();
  await f.callback(a);
  const entered = deferred();
  const gate = deferred();
  const rename = fs.rename;
  let held = false;
  fs.rename = async (...args) => {
    if (args[1] === f.config.storagePath && !held) {
      held = true;
      entered.resolve();
      await gate.promise;
    }
    return rename(...args);
  };
  try {
    const claim = f.claim(a);
    await entered.promise;
    assert.equal((await f.cancel(a)).status, 200);
    gate.resolve();
    const result = await claim;
    assert.equal(result.status, 400);
    assert.ok(!result.text.includes('sessionToken'));
    const saved = await f.disk();
    assert.equal(saved.sessions.length, 1);
    assert.equal(saved.accounts[0][1].tokens.accessToken, previous);
    assert.equal((await f.request('/v1/auth/status', { token: user.sessionToken })).status, 200);
  } finally {
    gate.resolve();
    fs.rename = rename;
  }
});

test('HTTP 401 非 JSON 与 code:401 wrapper 都刷新一次；POST wrapper401 不自动重放', async t => {
  const f = await fixture(t);
  const user = await f.login();
  let calls = 0;
  f.mock.onlineHook = () => ++calls === 1 ? new Response('<html>' + CLIENT_SECRET + '</html>', { status: 401 }) : wrapped({ online: true });
  assert.equal((await f.request('/v1/localassistant', { token: user.sessionToken })).status, 200);
  assert.equal(f.mock.refreshes.length, 1);
  calls = 0;
  f.mock.onlineHook = () => ++calls === 1 ? response({ code: 401, msg: CLIENT_SECRET }) : wrapped({ online: true });
  assert.equal((await f.request('/v1/localassistant', { token: user.sessionToken })).status, 200);
  assert.equal(f.mock.refreshes.length, 2);
  f.mock.sendHook = () => response({ code: 401, msg: CLIENT_SECRET });
  assert.equal((await f.send(user.sessionToken)).data.error.code, 'write_recheck_required');
  assert.equal(f.mock.sendAttempts, 1);
  assert.equal(f.mock.refreshes.length, 3);
});

test('并发读取中 token rotation 后，旧 token 文本也不会从白名单消息内容泄露', async t => {
  const f = await fixture(t);
  const user = await f.login();
  const id = (await f.send(user.sessionToken)).data.data.message_id;
  await f.restart();
  const entered = deferred();
  const gate = deferred();
  f.mock.messagesHook = async call => {
    entered.resolve();
    await gate.promise;
    return wrapped({ messages: [{ role: 'assistant', message_id: 'reply', msg_type: 'text', content: [call.options.headers.authorization.slice(7)] }] });
  };
  const reading = f.request('/v1/localassistant/message?message_id=' + id, { token: user.sessionToken });
  await entered.promise;
  let calls = 0;
  f.mock.onlineHook = () => ++calls === 1 ? response({}, 401) : wrapped({ online: true });
  assert.equal((await f.request('/v1/localassistant', { token: user.sessionToken })).status, 200);
  gate.resolve();
  const result = await reading;
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.data.messages[0].content, ['[已隐藏]']);
  noSecrets(result.text);
});

test('15 秒上游 deadline 覆盖不响应的 injected fetch，并触发 AbortSignal', { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const user = await f.login();
  let signal;
  f.mock.onlineHook = call => { signal = call.options.signal; return new Promise(() => {}); };
  const result = await f.request('/v1/localassistant', { token: user.sessionToken });
  assert.equal(result.status, 504);
  assert.equal(result.data.error.code, 'upstream_timeout');
  assert.equal(signal.aborted, true);
  noSecrets(result.text);
});

test('显式 loopback HTTP mock 使用默认 Node fetch，但 authorize 仍固定官方', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-relay-http-test-'));
  const calls = [];
  const provider = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    calls.push({ url: req.url, method: req.method, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/openapi/v2/token') {
      res.end(JSON.stringify({ access_token: 'real_mock_access_secret', refresh_token: 'real_mock_refresh_secret', expires_in: 3600, open_id: 'real-mock', scope: SCOPES.join(' ') }));
    } else if (req.url === '/openapi/v2/user/profile') {
      assert.equal(req.headers.authorization, 'Bearer real_mock_access_secret');
      res.end(JSON.stringify({ code: 0, msg: 'ok', data: { open_id: 'real-mock', nickname: 'HTTP mock' } }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const publicUrl = 'http://127.0.0.1:8787';
  const relay = createRelay({ publicUrl, clientId: 'id', clientSecret: CLIENT_SECRET, encryptionKey: crypto.randomBytes(32),
    storagePath: path.join(directory, 'secret.enc'), allowTestHttp: true,
    apiBase: 'http://127.0.0.1:' + provider.address().port + '/openapi/v2' });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await close(relay); await close(provider); await fs.rm(directory, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + relay.address().port;
  const claimVerifier = verifier();
  const start = await rawRequest(base, '/v1/auth/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claimChallenge: digest(claimVerifier) }) });
  const authorize = new URL(start.data.authorizeUrl);
  assert.equal(authorize.origin + authorize.pathname, API + '/authorize');
  const callback = await rawRequest(base, '/oauth/callback?code=real-code&state=' + authorize.searchParams.get('state'));
  assert.equal(callback.status, 200);
  assert.equal(new URLSearchParams(calls[0].body).get('redirect_uri'), publicUrl + '/oauth/callback');
  const claim = await rawRequest(base, '/v1/auth/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: start.data.id, claimVerifier }) });
  assert.equal(claim.data.status, 'ready');
  noSecrets(claim.text, ['real_mock_access_secret', 'real_mock_refresh_secret']);
});

test('require.main 从环境读取配置，生产 HTTP 被拒绝，stderr 不打印配置秘密', () => {
  const entry = path.join(__dirname, '../server/workbuddy-relay.cjs');
  const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', env: {
    ...process.env, GONGZUO_RELAY_PUBLIC_URL: 'http://127.0.0.1:8787', WORKBUDDY_CLIENT_ID: 'id',
    WORKBUDDY_CLIENT_SECRET: CLIENT_SECRET, GONGZUO_RELAY_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    GONGZUO_RELAY_DATA_FILE: '/tmp/gongzuo-no-file-created.enc', PORT: '8787'
  } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /中继启动失败/);
  noSecrets(result.stderr + result.stdout);
});
