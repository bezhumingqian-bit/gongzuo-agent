const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { WorkBuddyOAuth, localClientCredentials, SCOPES, REDIRECT_URI } = require('../electron/workbuddy-oauth.cjs');
const { SettingsService } = require('../electron/settings-service.cjs');
const { cloudSessionFor } = require('../electron/agent-service.cjs');

const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const b64url = buffer => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function memorySettings(client = { clientId: 'cb_test', clientSecret: 'sec_test' }) {
  let record = null;
  return {
    get record() { return record; },
    readWorkbuddyOAuth: async () => record && { ...record },
    writeWorkbuddyOAuth: async value => { record = value && { ...value }; },
    getWorkbuddyClient: async () => client
  };
}

function platform() {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    if (target.pathname.endsWith('/token')) {
      const form = Object.fromEntries(new URLSearchParams(options.body));
      calls.push({ path: 'token', form });
      if (form.client_secret !== 'sec_test') return json(401, { error: 'invalid_client' });
      if (form.grant_type === 'authorization_code') return json(200, { access_token: 'at_1', token_type: 'Bearer', expires_in: 86400, refresh_token: 'rt_1', scope: SCOPES.join(' '), open_id: 'op_me' });
      if (form.grant_type === 'refresh_token' && form.refresh_token === 'rt_1') return json(200, { access_token: 'at_2', expires_in: 86400, refresh_token: 'rt_2', open_id: 'op_me' });
      return json(400, { error: 'invalid_grant' });
    }
    if (target.pathname.endsWith('/user/profile')) { calls.push({ path: 'profile', auth: options.headers.authorization }); return json(200, { nickname: '张三', avatar: 'https://x/a.png' }); }
    return json(404, {});
  };
  return { calls, fetchImpl };
}

test('授权：打开授权页带 state 与 PKCE，回调伪造被忽略，正确回调换取令牌并读取昵称', async () => {
  const port = await freePort();
  const settings = memorySettings();
  const { calls, fetchImpl } = platform();
  let authorizeUrl;
  const opened = new Promise(resolve => { authorizeUrl = resolve; });
  const auth = new WorkBuddyOAuth({ settingsService: settings, clientSource: localClientCredentials({ settingsService: settings, keychain: async () => null }), openExternal: url => authorizeUrl(url), fetchImpl, port });
  const running = auth.authorize();
  const url = new URL(await opened);
  assert.equal(url.origin + url.pathname, 'https://www.workbuddy.cn/openapi/v2/authorize');
  const q = Object.fromEntries(url.searchParams);
  assert.equal(q.response_type, 'code');
  assert.equal(q.client_id, 'cb_test');
  assert.equal(q.redirect_uri, `http://127.0.0.1:${port}/oauth/callback`);
  assert.deepEqual(q.scope.split(' '), SCOPES);
  assert.equal(q.code_challenge_method, 'S256');
  assert.ok(q.state.length >= 20);
  assert.equal((await auth.status()).authorizing, true);

  const forged = await fetch(`${q.redirect_uri}?code=evil&state=wrong`);
  assert.equal(forged.status, 400);
  assert.equal(calls.length, 0, '伪造回调不换令牌');

  const ok = await fetch(`${q.redirect_uri}?code=c_1&state=${encodeURIComponent(q.state)}`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /授权完成/);
  const record = await running;
  assert.equal(record.nickname, '张三');
  const exchange = calls.find(call => call.path === 'token').form;
  assert.equal(exchange.grant_type, 'authorization_code');
  assert.equal(exchange.redirect_uri, q.redirect_uri, 'redirect_uri 与授权时逐字一致');
  assert.equal(b64url(crypto.createHash('sha256').update(exchange.code_verifier).digest()), q.code_challenge);
  assert.equal(calls.find(call => call.path === 'profile').auth, 'Bearer at_1');
  const status = await auth.status();
  assert.equal(status.authorized, true);
  assert.equal(status.openId, 'op_me');
  assert.equal(status.nickname, '张三');
  assert.equal(status.authorizing, false);
  assert.equal(settings.record.refreshToken, 'rt_1');
});

test('授权：授权页拒绝、应用凭据错误时给出错误码与排查方向，回调页转义平台文本', async () => {
  const cases = [
    ['sec_test', 'error=access_denied', /access_denied.*取消.*尚未启用/, /授权被拒绝/],
    ['sec_test', 'error=invalid_scope&error_description=scope%20not%20bound', /invalid_scope：scope not bound.*授权列表/, /invalid_scope/],
    ['sec_test', 'error=server_error&error_description=%3Cscript%3Ex%3C%2Fscript%3E', /server_error/, /&lt;script&gt;/],
    ['wrong', 'code=c_1', /不认可这个应用/, /授权失败/]
  ];
  for (const [secret, query, pattern, pagePattern] of cases) {
    const port = await freePort();
    const settings = memorySettings({ clientId: 'cb_test', clientSecret: secret });
    let open; const opened = new Promise(resolve => { open = resolve; });
    const auth = new WorkBuddyOAuth({ settingsService: settings, openExternal: url => open(url), fetchImpl: platform().fetchImpl, port });
    const outcome = auth.authorize().then(() => null, error => error);
    const url = new URL(await opened);
    const page = await (await fetch(`${url.searchParams.get('redirect_uri')}?${query}&state=${encodeURIComponent(url.searchParams.get('state'))}`)).text();
    assert.match((await outcome)?.message || '', pattern);
    assert.match(page, pagePattern);
    assert.doesNotMatch(page, /<script>/);
    assert.equal(settings.record, null);
  }
});

test('授权：没有应用凭据时不打开浏览器', async () => {
  let opened = false;
  const auth = new WorkBuddyOAuth({ settingsService: memorySettings({}), clientSource: { get: async () => ({ clientId: null, clientSecret: null }) }, openExternal: () => { opened = true; } });
  await assert.rejects(auth.authorize(), /Client ID 和 Client Secret/);
  assert.equal(opened, false);
});

test('令牌：到期前 10 分钟自动续期，并发只续一次；续期被拒且已过期则清除', async () => {
  let now = 1_000_000;
  const settings = memorySettings();
  const { calls, fetchImpl } = platform();
  const auth = new WorkBuddyOAuth({ settingsService: settings, openExternal: () => {}, fetchImpl, now: () => now });
  await settings.writeWorkbuddyOAuth({ accessToken: 'at_1', refreshToken: 'rt_1', expiresAt: now + 3600_000, openId: 'op_me', nickname: '张三' });
  assert.equal(await auth.getAccessToken(), 'at_1', '离到期还早，不续期');
  now += 3600_000 - 5 * 60_000;
  const [a, b] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()]);
  assert.equal(a, 'at_2'); assert.equal(b, 'at_2');
  assert.equal(calls.filter(call => call.form?.grant_type === 'refresh_token').length, 1);
  assert.equal(settings.record.refreshToken, 'rt_2');
  assert.equal(settings.record.nickname, '张三', '续期保留授权人');

  now = settings.record.expiresAt + 1;
  assert.equal(await auth.getAccessToken(), null, 'rt_2 被拒（invalid_grant）且已过期');
  assert.equal(settings.record, null);
  assert.equal((await auth.status()).authorized, false);
});

test('令牌：续期时网络失败，未过期的令牌继续可用', async () => {
  let now = 0;
  const settings = memorySettings();
  const auth = new WorkBuddyOAuth({ settingsService: settings, openExternal: () => {}, fetchImpl: async () => { throw new Error('offline'); }, now: () => now });
  await settings.writeWorkbuddyOAuth({ accessToken: 'at_1', refreshToken: 'rt_1', expiresAt: 5 * 60_000 });
  assert.equal(await auth.getAccessToken(), 'at_1');
  assert.ok(settings.record, '网络失败不清除授权');
});

test('设置：授权令牌加密保存；手动令牌优先；更换 Client ID 会清除旧授权', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-oauth-settings-'));
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`enc:${value}`), decryptString: buffer => String(buffer).replace(/^enc:/, '') };
  try {
    const service = new SettingsService(path.join(directory, 'settings.json'), path.join(directory, 'credentials.json'), safeStorage);
    await service.initialize();
    const base = { model: { provider: 'local', modelId: 'm', baseUrl: 'http://127.0.0.1:11434/v1' }, agent: { mode: 'workbuddy', workbuddyTransport: 'cloud' }, wecom: {}, workflow: {} };
    await service.save({ ...base, workbuddyClientId: 'cb_one', workbuddyClientSecret: 'sec_one' });
    assert.deepEqual(await service.getWorkbuddyClient(), { clientId: 'cb_one', clientSecret: 'sec_one' });
    await service.writeWorkbuddyOAuth({ accessToken: 'at_oauth', openId: 'op_me', expiresAt: Date.now() + 3600_000 });
    const raw = await fs.readFile(path.join(directory, 'credentials.json'), 'utf8');
    assert.ok(!raw.includes('at_oauth') && !raw.includes('sec_one'), '令牌与 secret 不以明文落盘');
    service.workbuddyTokenProvider = async () => 'at_oauth';
    let runtime = await service.getRuntimeConfig();
    assert.equal(runtime.workbuddyAccessToken, 'at_oauth');
    assert.equal(runtime.workbuddyOpenId, 'op_me');
    assert.equal((await service.getPublic()).hasWorkbuddyAccessToken, true);

    await service.save({ ...base, workbuddyAccessToken: 'at_manual' });
    runtime = await service.getRuntimeConfig();
    assert.equal(runtime.workbuddyAccessToken, 'at_manual', '调试用手动令牌优先');

    await service.save({ ...base, workbuddyClientId: 'cb_two' });
    assert.equal(await service.readWorkbuddyOAuth(), null, '换应用后旧授权作废');
    await service.save({ ...base, clearWorkbuddyClient: true });
    assert.deepEqual(await service.getWorkbuddyClient(), { clientId: null, clientSecret: null });
    await assert.rejects(service.save({ ...base, workbuddyClientId: 'bad id!' }), /Client ID 格式无效/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('应用凭据：共作设置优先，其次读取本机钥匙串', async () => {
  const keychain = async service => ({ 'cn.gongzuo.workbuddy.client-id': 'cb_kc', 'cn.gongzuo.workbuddy.client-secret': 'sec_kc' })[service] || null;
  assert.deepEqual(await localClientCredentials({ settingsService: { getWorkbuddyClient: async () => ({}) }, keychain }).get(), { clientId: 'cb_kc', clientSecret: 'sec_kc', source: 'keychain' });
  assert.deepEqual(await localClientCredentials({ settingsService: { getWorkbuddyClient: async () => ({ clientId: 'cb_set', clientSecret: 'sec_set' }) }, keychain }).get(), { clientId: 'cb_set', clientSecret: 'sec_set', source: 'settings' });
  assert.equal(REDIRECT_URI, 'http://127.0.0.1:47321/oauth/callback', '与开放平台登记的回调地址一致');
});

test('云端任务按授权人续接：换人追问时新开任务，本人或旧数据继续原任务', () => {
  const task = { agentSessionId: 'ct_1', agentSessionOwner: 'op_me' };
  assert.equal(cloudSessionFor(task, { workbuddyOpenId: 'op_me' }), 'ct_1');
  assert.equal(cloudSessionFor(task, { workbuddyOpenId: 'op_other' }), undefined);
  assert.equal(cloudSessionFor({ agentSessionId: 'ct_old' }, { workbuddyOpenId: 'op_other' }), 'ct_old', '未记录归属的旧任务保持原行为');
  assert.equal(cloudSessionFor({}, { workbuddyOpenId: 'op_me' }), undefined);
});
