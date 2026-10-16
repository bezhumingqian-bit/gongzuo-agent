const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRelay } = require('../server/workbuddy-relay.cjs');
const { WorkBuddyRelayAuth, relayOrigin } = require('../electron/workbuddy-relay-client.cjs');
const { SettingsService, defaultSettings, normalizeSettings } = require('../electron/settings-service.cjs');
const { checkWorkBuddy, callWorkBuddy, readWorkBuddyReply, releaseWorkBuddyMessage, localAssistantContent, withLocalAssistantConfiguration, hasLocalAssistantOperations } = require('../electron/workbuddy-service.cjs');
const { AgentService } = require('../electron/agent-service.cjs');

const publicUrl = 'https://relay.example.com';
const scope = 'user.profile.readable user.localassistant.readable user.localassistant.invokable';
const wrapped = data => new Response(JSON.stringify({ code: 0, data }), { status: 200 });
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from('encrypted:' + Buffer.from(text).toString('base64')),
  decryptString: value => Buffer.from(value.toString().slice(10), 'base64').toString()
};
async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-relay-client-'));
  let clock = Date.now(), sends = 0, messages = [], exchange = [];
  const encryptionKey = crypto.randomBytes(32), secret = 'TEST_SERVER_CLIENT_SECRET_NOT_CLIENT';
  const server = createRelay({ publicUrl, clientId: 'test-app', clientSecret: secret, storagePath: path.join(directory, 'relay.enc'), encryptionKey,
    now: () => clock, fetchImpl: async (target, opts) => {
      const u = new URL(target);
      assert.equal(u.origin, 'https://www.workbuddy.cn');
      if (u.pathname.endsWith('/token')) {
        exchange.push(new URLSearchParams(opts.body));
        return new Response(JSON.stringify({ access_token: 'PROVIDER_ACCESS_SECRET', refresh_token: 'PROVIDER_REFRESH_SECRET', expires_in: 3600, scope, open_id: 'account_one' }));
      }
      assert.equal(opts.headers.authorization, 'Bearer PROVIDER_ACCESS_SECRET');
      if (u.pathname.endsWith('/user/profile')) return wrapped({ nickname: '测试用户', open_id: 'account_one' });
      if (u.pathname.endsWith('/localassistant')) return wrapped({ online: true });
      if (opts.method === 'POST') {
        sends++;
        const content = JSON.parse(opts.body).content;
        messages = [{ role: 'assistant', message_id: 'response_1', msg_type: 'text', content: ['正在处理'] }, { role: 'assistant', message_id: 'response_2', msg_type: 'text', content: ['方案已经整理。'] }];
        assert.match(content, /已确认的工作记忆|只用于发送测试/);
        return wrapped({ message_id: 'message_' + sends });
      }
      return wrapped({ messages });
    } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const calls = [];
  const clientFetch = async (url, opts) => {
    calls.push({ url, opts });
    const target = new URL(url); assert.equal(target.origin, publicUrl);
    return fetch(base + target.pathname + target.search, opts);
  };
  const settings = new SettingsService(path.join(directory, 'settings.json'), path.join(directory, 'credentials.json'), safeStorage);
  await settings.initialize();
  await settings.save({ ...defaultSettings(), agent: { mode: 'workbuddy', workbuddyTransport: 'localassistant', workbuddyRelayUrl: publicUrl } });
  let opened;
  const auth = new WorkBuddyRelayAuth({ settingsService: settings, fetchImpl: clientFetch, now: () => clock, wait: async ms => { clock += ms; },
    openExternal: async url => {
      opened = new URL(url);
      await fetch(base + '/oauth/callback?code=test_auth_code&state=' + encodeURIComponent(opened.searchParams.get('state')));
    } });
  settings.workbuddyTokenProvider = () => auth.getAccessToken();
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); await fs.rm(directory, { recursive: true, force: true }); });
  return { settings, auth, calls, exchange, clientFetch, directory, secret, get opened() { return opened; }, get sends() { return sends; }, set messages(value) { messages = value; }, advance(ms) { clock += ms; } };
}

test('HTTPS授权→一次性绑定→PC本地助理在线→发送工作→获取后续文本→显式结束→撤销，客户端不拿平台密钥', async t => {
  const c = await setup(t);
  const result = await c.auth.authorize();
  assert.deepEqual(result, { nickname: '测试用户', openId: 'account_one' });
  const r = await c.settings.readWorkbuddyOAuth();
  assert.equal(r.kind, 'relay');
  assert.ok(r.sessionToken);
  assert.equal(r.accessToken, undefined);
  assert.equal(r.refreshToken, undefined);
  assert.equal(c.opened.searchParams.get('redirect_uri'), publicUrl + '/oauth/callback');
  assert.equal(c.exchange[0].get('redirect_uri'), c.opened.searchParams.get('redirect_uri'));
  assert.equal(c.exchange[0].get('client_secret'), c.secret);
  assert.equal((await c.auth.status()).authorized, true);
  assert.ok(!JSON.stringify(await c.auth.status()).includes(r.sessionToken));
  const config = await c.settings.getRuntimeConfig();
  assert.equal(config.workbuddyViaRelay, true);
  assert.equal(config.workbuddyAccessToken, r.sessionToken);
  assert.equal((await checkWorkBuddy(config, c.clientFetch)).ok, true);
  const m = { team: [{ title: '团队口径', content: '只算可售池' }], personal: [] };
  const out = await callWorkBuddy(config, [{ role: 'user', text: '整理方案' }], c.clientFetch, async () => {}, m);
  assert.equal(out.text, '方案已经整理。');
  assert.equal(out.pending, true, '文本回复不等于任务完成，必须核对后释放');
  assert.equal(out.viaRelay, true);
  assert.equal(c.sends, 1);
  await assert.rejects(callWorkBuddy(config, [{ role: 'user', text: '第二项任务' }], c.clientFetch, async () => {}, m), e => e.code === 'account_busy');
  assert.equal(c.sends, 1, '账号被占用时不能再发任务');
  await releaseWorkBuddyMessage(config, out.messageId, c.clientFetch);
  await c.auth.signOut();
  assert.equal(await c.settings.readWorkbuddyOAuth(), null);
  assert.equal((await c.auth.status()).authorized, false);
  assert.ok(!JSON.stringify(c.calls).includes(c.secret));
  assert.ok(!JSON.stringify(c.calls).includes('PROVIDER_ACCESS_SECRET'));
  assert.ok(!(await fs.readFile(path.join(c.directory, 'relay.enc'), 'utf8')).includes('PROVIDER_ACCESS_SECRET'));
  assert.ok(!(await fs.readFile(path.join(c.directory, 'credentials.json'), 'utf8')).includes(r.sessionToken));
});

test('PC回复与其它用户消息冲突时拒绝接收，不把其它工作串进来', async t => {
  const c = await setup(t); await c.auth.authorize();
  const config = await c.settings.getRuntimeConfig();
  const out = await callWorkBuddy(config, [{ role: 'user', text: '只用于发送测试' }], c.clientFetch, async () => {}, {});
  c.messages = [{ message_id: 'OTHER', role: 'user', msg_type: 'text', content: ['不属于当前工作的个人资料'] }];
  await assert.rejects(readWorkBuddyReply(config, out.messageId, c.clientFetch), e => e.code === 'message_stream_conflict');
  await releaseWorkBuddyMessage(config, out.messageId, c.clientFetch);
});

test('Relay会话不能发给另一服务、官方云端或被手动平台令牌覆盖', async t => {
  const c = await setup(t); await c.auth.authorize();
  await c.settings.save({ ...defaultSettings(), agent: { mode: 'workbuddy', workbuddyTransport: 'localassistant', workbuddyRelayUrl: publicUrl }, workbuddyAccessToken: 'MANUAL_PROVIDER_TOKEN' });
  const before = await c.settings.getRuntimeConfig();
  assert.notEqual(before.workbuddyAccessToken, 'MANUAL_PROVIDER_TOKEN');
  await c.settings.save({ ...defaultSettings(), agent: { mode: 'workbuddy', workbuddyTransport: 'cloud', workbuddyRelayUrl: publicUrl }, clearWorkbuddyAccessToken: true });
  const cloud = await c.settings.getRuntimeConfig();
  assert.equal(cloud.workbuddyAccessToken, null);
  assert.equal(cloud.workbuddyViaRelay, undefined);
  await c.settings.save({ ...defaultSettings(), agent: { mode: 'workbuddy', workbuddyTransport: 'localassistant', workbuddyRelayUrl: 'https://other.example.com' } });
  assert.equal((await c.settings.getRuntimeConfig()).workbuddyAccessToken, null);
  assert.equal((await c.auth.status()).authorized, false);
});

test('未部署与恶意地址拒绝、授权超时取消、历史私密应用凭据不用于正式桌面授权', async t => {
  const settings = { getWorkbuddyRelayUrl: async () => '', readWorkbuddyOAuth: async () => ({ accessToken: 'LEGACY' }) };
  let opened = false;
  const a = new WorkBuddyRelayAuth({ settingsService: settings, openExternal: () => { opened = true; } });
  await assert.rejects(a.authorize(), /请先部署/);
  assert.equal(opened, false);
  assert.equal(await a.getAccessToken(), null);
  assert.equal((await a.status()).legacyDetected, true);
  for (const url of ['http://127.0.0.1:3000', 'https://evil.example.com/oauth', 'https://user:secret@example.com', 'https://example.com/?token=secret']) assert.throws(() => relayOrigin(url));
  assert.throws(() => normalizeSettings({ ...defaultSettings(), agent: { mode: 'workbuddy', workbuddyRelayUrl: 'http://localhost:3000' } }));
  assert.equal(relayOrigin('https://relay.example.com/'), publicUrl);
  assert.throws(() => localAssistantContent([{ role: 'user', text: '太长'.repeat(3000) }], {}), /4000/);
  const c = await setup(t);
  c.auth.timeoutMs = 10; c.auth.pollMs = 12; c.auth.openExternal = async () => {};
  await assert.rejects(c.auth.authorize(), e => e.code === 'timeout');
  assert.ok(c.calls.some(x => x.url.endsWith('/v1/auth/cancel')));
  assert.equal(await c.settings.readWorkbuddyOAuth(), null);
});

test('取消授权后不保留授权数据；服务返回非官方地址被阻止打开', async t => {
  const c = await setup(t);
  c.auth.openExternal = async () => { await c.auth.cancel(); };
  await assert.rejects(c.auth.authorize(), e => e.code === 'cancelled');
  assert.equal(await c.settings.readWorkbuddyOAuth(), null);
  let opened = false;
  const a = new WorkBuddyRelayAuth({ settingsService: c.settings, openExternal: () => { opened = true; }, fetchImpl: async url => new Response(JSON.stringify(url.endsWith('/healthz') ? { ok: true, redirectUri: publicUrl+'/oauth/callback' } : url.endsWith('/v1/auth/start') ? { id: 'fake_attempt_id_12345', expiresAt: Date.now()+100000, authorizeUrl: 'https://evil.example.com/?client_secret=bad' } : { ok: true })) });
  await assert.rejects(a.authorize(), e => e.code === 'authorize-url');
  assert.equal(opened, false);
});

test('响应丢失只恢复自己本次请求的监听，不重发、不认领旧工作', async t => {
  const c = await setup(t); await c.auth.authorize();
  const config = await c.settings.getRuntimeConfig();
  let dropped = false;
  const dropAfterSend = async (url, opts) => {
    const response = await c.clientFetch(url, opts);
    if (!dropped && opts.method === 'POST' && url.endsWith('/v1/localassistant/message')) { dropped = true; throw new Error('response lost'); }
    return response;
  };
  const out = await callWorkBuddy(config, [{ role: 'user', text: '只用于发送测试' }], dropAfterSend, async () => {});
  assert.equal(out.pending, true);
  assert.match(out.messageId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await readWorkBuddyReply(config, out.messageId, c.clientFetch), '方案已经整理。');
  assert.equal(c.sends, 1);
  await releaseWorkBuddyMessage(config, out.messageId, c.clientFetch);
  const unrelated = async (url, opts) => {
    if (url.endsWith('/v1/localassistant/message') && opts.method === 'POST') throw new Error('network');
    if (url.endsWith('/v1/auth/status')) return new Response(JSON.stringify({ observation: { owned: true, messageId: 'other', requestId: 'OLD_REQUEST' } }));
    return c.clientFetch(url, opts);
  };
  const uncertain = await callWorkBuddy(config, [{ role: 'user', text: '只用于发送测试' }], unrelated, async () => {});
  assert.equal(uncertain.pending, true);
  assert.match(uncertain.messageId, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(uncertain.messageId, 'other');
  assert.notEqual(uncertain.messageId, out.messageId);
});

test('多个并发授权只能创建一个短期会话', async t => {
  const c = await setup(t);
  c.auth.openExternal = async () => { await c.auth.cancel(); };
  const results = await Promise.allSettled([c.auth.authorize(), c.auth.authorize()]);
  assert.ok(results.some(x => x.status === 'rejected' && x.reason.code === 'busy'));
  assert.equal(c.calls.filter(x => x.url.endsWith('/v1/auth/start')).length, 1);
});

test('响应体中途断流不重发，结束监听回包丢失可以安全重试', async t => {
  const c = await setup(t); await c.auth.authorize();
  const config = await c.settings.getRuntimeConfig();
  const truncated = async (url, opts) => {
    const response = await c.clientFetch(url, opts);
    if (url.endsWith('/v1/localassistant/message') && opts.method === 'POST') return { ok: true, status: 200, json: async () => { throw new Error('body closed'); } };
    return response;
  };
  const out = await callWorkBuddy(config, [{ role:'user',text:'只用于发送测试' }],truncated,async()=>{});
  assert.equal(out.pending,true); assert.equal(c.sends,1);
  assert.equal(await readWorkBuddyReply(config,out.messageId,c.clientFetch),'方案已经整理。');
  const droppedRelease = async(url,opts) => { const response=await c.clientFetch(url,opts); if(url.endsWith('/release'))throw new Error('lost'); return response; };
  await assert.rejects(releaseWorkBuddyMessage(config,out.messageId,droppedRelease),e=>e.code==='network');
  assert.equal((await releaseWorkBuddyMessage(config,out.messageId,c.clientFetch)).ok,true);
  const second = await callWorkBuddy(config,[{role:'user',text:'只用于发送测试'}],c.clientFetch,async()=>{});
  await assert.rejects(releaseWorkBuddyMessage(config,out.messageId,c.clientFetch),e=>e.code==='message_not_owned');
  assert.equal(c.sends,2);
  await releaseWorkBuddyMessage(config,second.messageId,c.clientFetch);
});

test('取消在本地凭据提交期间到达，最终撤销服务端会话且清除本次记录', async t => {
  const c=await setup(t);
  const original=c.settings.writeWorkbuddyOAuth.bind(c.settings);
  let cancelled=false;
  c.settings.writeWorkbuddyOAuth=async record => {
    await original(record);
    if(record?.kind==='relay'&&!cancelled){cancelled=true;await c.auth.cancel().catch(()=>{});}
  };
  await assert.rejects(c.auth.authorize(),e=>e.code==='cancelled');
  assert.equal(await c.settings.readWorkbuddyOAuth(),null);
  assert.ok(c.calls.some(x=>x.url.endsWith('/v1/auth/session')&&x.opts.method==='DELETE'));
});

test('发送和调整授权不能相互穿透；配置期间不派发新任务', async t => {
  const c=await setup(t);await c.auth.authorize();
  const config=await c.settings.getRuntimeConfig();
  let resume;
  const gate=new Promise(r=>{resume=r});
  const pending=withLocalAssistantConfiguration(async()=>{await gate});
  await assert.rejects(callWorkBuddy(config,[{role:'user',text:'只用于发送测试'}],c.clientFetch,async()=>{}),/正在调整/);
  resume();await pending;
  let unblock;
  const wait=new Promise(r=>{unblock=r});
  const blocking=async(url,opts)=>{if(url.endsWith('/message')&&opts.method==='POST')await wait;return c.clientFetch(url,opts)};
  const work=callWorkBuddy(config,[{role:'user',text:'只用于发送测试'}],blocking,async()=>{});
  assert.equal(hasLocalAssistantOperations(),true);
  await assert.rejects(withLocalAssistantConfiguration(async()=>{}),/正在执行/);
  await assert.rejects(c.auth.signOut(),e=>e.code==='executing');
  await assert.rejects(c.auth.authorize(),e=>e.code==='executing');
  unblock();const out=await work;await releaseWorkBuddyMessage(config,out.messageId,c.clientFetch);
  assert.equal(hasLocalAssistantOperations(),false);
});

test('旧平台凭据读取时切换为relay授权，cloud不收到新relay会话',async t=>{
  const c=await setup(t);
  await c.settings.writeWorkbuddyOAuth({accessToken:'OLD_PLATFORM_TOKEN',authorizedAt:'old'});
  await c.settings.save({...defaultSettings(),agent:{mode:'workbuddy',workbuddyTransport:'cloud'}});
  c.settings.workbuddyTokenProvider=async()=>{
    await c.settings.writeWorkbuddyOAuth({kind:'relay',relayUrl:publicUrl,sessionToken:'NEW_RELAY_SECRET',expiresAt:Date.now()+60000,authorizedAt:'new'});
    return 'NEW_RELAY_SECRET';
  };
  const config=await c.settings.getRuntimeConfig();
  assert.equal(config.workbuddyAccessToken,null);
});

test('初始读取服务地址期间取消授权，不会发起或保存新授权',async t=>{
  const c=await setup(t);
  const get=c.settings.getWorkbuddyRelayUrl.bind(c.settings);
  let resume,entered;
  const gate=new Promise(r=>{resume=r});
  const ready=new Promise(r=>{entered=r});
  c.settings.getWorkbuddyRelayUrl=async()=>{entered();await gate;return get();};
  const pending=c.auth.authorize();await ready;await c.auth.cancel();resume();
  await assert.rejects(pending,e=>e.code==='cancelled');
  assert.equal(c.calls.length,0);
  assert.equal(await c.settings.readWorkbuddyOAuth(),null);
});

test('任务准备资料跨过重新授权或保存设置后，不得用旧配置发送',async t=>{
  const c=await setup(t);await c.auth.authorize();
  const old=await c.settings.getRuntimeConfig();
  await c.auth.authorize();
  await assert.rejects(callWorkBuddy(old,[{role:'user',text:'只用于发送测试'}],c.clientFetch,async()=>{}),/准备资料期间已变化/);
  assert.equal(c.sends,0);
  const fresh=await c.settings.getRuntimeConfig();
  const out=await callWorkBuddy(fresh,[{role:'user',text:'只用于发送测试'}],c.clientFetch,async()=>{});
  await releaseWorkBuddyMessage(fresh,out.messageId,c.clientFetch);
});

test('AgentService使用共作准备的任务和记忆，HTTPS通道返回持续监听标识', async t => {
  const c = await setup(t);await c.auth.authorize();
  const config = await c.settings.getRuntimeConfig();
  const agent = new AgentService(c.clientFetch);
  const output = await agent.answer({ id: 'work_1', workspace: '产品团队', messages: [{ role: 'user', text: '生成方案大纲' }] }, config, { team: [{ title: '团队口径', content: '结论先行' }] });
  assert.equal(output.source, 'workbuddy-pending');
  assert.equal(output.via, 'localassistant-relay');
  assert.ok(output.externalMessageId);
  await releaseWorkBuddyMessage(config, output.externalMessageId, c.clientFetch);
});
