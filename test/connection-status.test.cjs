const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { ConnectionStatusService } = require('../electron/connection-status.cjs');

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => null }, text: async () => JSON.stringify(body)
});
const modelConfig = (extra = {}) => ({
  model: { provider: 'compatible', modelId: 'test-model', baseUrl: 'https://model.example/v1' },
  modelKey: 'private-model-key', agent: { mode: 'built-in' }, ...extra
});
const workbuddyConfig = (transport, extra = {}) => ({
  agent: { mode: 'workbuddy', workbuddyTransport: transport, workbuddyRelayUrl: 'https://relay.example' },
  workbuddyAccessToken: 'private-relay-token', workbuddyViaRelay: transport === 'localassistant', ...extra
});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function contract(result, target) {
  assert.deepEqual(Object.keys(result).sort(), ['state', 'label', 'message', 'checkedAt', 'source', 'action', 'target'].sort());
  assert.ok(['connected', 'ready', 'unconfigured', 'unauthorized', 'offline', 'unsupported', 'error'].includes(result.state));
  assert.ok([null, 'configure', 'authorize', 'reconnect'].includes(result.action));
  assert.equal(result.source, 'readonly');
  assert.equal(result.target, target);
  assert.equal(new Date(result.checkedAt).toISOString(), result.checkedAt);
  assert.equal(typeof result.label, 'string');
  assert.equal(typeof result.message, 'string');
  assert.ok(Object.isFrozen(result));
}
function readonly(url, options) {
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.equal(options.body, undefined);
  assert.ok(options.signal instanceof AbortSignal);
  assert.doesNotMatch(new URL(url).pathname, /responses|completions|generate|messages|\/message(?:\/|$)/);
}

test('所有现有模型提供方只请求一次模型列表，不执行生成', async () => {
  for (const provider of ['openai', 'kimi', 'deepseek', 'compatible', 'local']) {
    const calls = [];
    const config = modelConfig({ model: { provider, modelId: 'test-model', baseUrl: 'https://model.example/v1/' } });
    const service = new ConnectionStatusService({ now: () => 1700000000000, fetchImpl: async (url, options) => {
      readonly(url, options);
      calls.push(url);
      assert.equal(options.headers.authorization, 'Bearer private-model-key');
      return json({ data: [{ id: 'test-model' }] });
    } });
    const result = await service.get('model', config);
    contract(result, 'model');
    assert.equal(result.state, 'connected');
    assert.match(result.message, /不保证生成成功/);
    assert.deepEqual(calls, ['https://model.example/v1/models']);
  }
});

test('真实 fetch 连接本机 mock，models GET 可达，模型缓存复用于内置 Agent', async t => {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ method: request.method, url: request.url });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = modelConfig({ model: { provider: 'local', modelId: 'test-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, modelKey: null });
  const service = new ConnectionStatusService();
  assert.equal((await service.get('model', config)).state, 'connected');
  const agent = await service.get('agent', config);
  contract(agent, 'agent');
  assert.equal(agent.state, 'connected');
  assert.deepEqual(calls, [{ method: 'GET', url: '/v1/models' }]);
});

test('TTL 缓存、force 刷新及并发单飞每轮只有一个 GET', async () => {
  let time = 1700000000000;
  let calls = 0;
  let gate = deferred();
  const service = new ConnectionStatusService({ now: () => time, ttlMs: 30, fetchImpl: async () => { calls++; await gate.promise; return json({ data: [{ id: 'test-model' }] }); } });
  const config = modelConfig();
  const first = service.get('model', config);
  const joined = service.get('model', config, { force: true });
  await Promise.resolve();
  gate.resolve();
  const [a, b] = await Promise.all([first, joined]);
  assert.strictEqual(a, b);
  assert.equal(calls, 1);
  time += 29;
  assert.strictEqual(await service.get('model', config), a);
  assert.equal(calls, 1);
  time++;
  gate = deferred();
  const refresh = Promise.all(Array.from({ length: 12 }, () => service.get('model', config)));
  gate.resolve();
  assert.ok((await refresh).every(item => item.checkedAt !== a.checkedAt));
  assert.equal(calls, 2);
  gate = deferred();
  const forced = service.get('model', config, { force: true });
  gate.resolve();
  await forced;
  assert.equal(calls, 3);
});

test('内置 Agent 与模型并发复用 singleflight，但 target 独立', async () => {
  const gate = deferred();
  let calls = 0;
  const service = new ConnectionStatusService({ fetchImpl: async () => { calls++; await gate.promise; return json({ data: [{ id: 'test-model' }] }); } });
  const pending = Promise.all([service.get('model', modelConfig()), service.get('agent', modelConfig())]);
  gate.resolve();
  const [model, agent] = await pending;
  assert.equal(calls, 1);
  assert.equal(model.target, 'model');
  assert.equal(agent.target, 'agent');
  assert.equal(model.checkedAt, agent.checkedAt);
});

test('配置和同长度 secret 指纹变化不会被旧请求污染，原配置不留引用', async () => {
  const old = deferred();
  const config = modelConfig({ modelKey: 'secret-old' });
  const calls = [];
  const service = new ConnectionStatusService({ fetchImpl: async (url, options) => {
    calls.push(options.headers.authorization);
    if (options.headers.authorization === 'Bearer secret-old') { await old.promise; return json({}, 401); }
    return json({ data: [{ id: 'changed-model' }] });
  } });
  const pending = service.get('model', config);
  config.modelKey = 'secret-new';
  config.model.modelId = 'changed-model';
  const fresh = await service.get('model', config);
  old.resolve();
  assert.equal((await pending).state, 'unauthorized');
  assert.equal(fresh.state, 'connected');
  assert.strictEqual(await service.get('model', config), fresh);
  assert.deepEqual(calls, ['Bearer secret-old', 'Bearer secret-new']);
  assert.equal(JSON.stringify(service).includes('secret-'), false);
});

test('secret 独立变化强制新检查，属性排序不改变配置指纹', async () => {
  let calls = 0;
  const service = new ConnectionStatusService({ fetchImpl: async () => { calls++; return json({ data: [{ id: 'test-model' }] }); } });
  const config = modelConfig();
  await service.get('model', config);
  await service.get('model', { agent: config.agent, modelKey: config.modelKey, model: { baseUrl: config.model.baseUrl, modelId: config.model.modelId, provider: config.model.provider } });
  assert.equal(calls, 1);
  await service.get('model', { ...config, modelKey: 'different-secret' });
  assert.equal(calls, 2);
});

test('缓存最多 32 条，淘汰最旧项，结果不可被调用者污染', async () => {
  let calls = 0;
  const service = new ConnectionStatusService({ fetchImpl: async () => { calls++; return json({ data: [{ id: 'test-model' }] }); } });
  const first = modelConfig();
  const result = await service.get('model', first);
  assert.throws(() => { 'use strict'; result.message = '污染缓存'; }, TypeError);
  for (let i = 0; i < 32; i++) await service.get('model', modelConfig({ modelKey: `cache-key-${i}` }));
  assert.equal(calls, 33);
  await service.get('model', first);
  assert.equal(calls, 34);
});

test('并发最多 32 个配置，超出不产生网络请求', async () => {
  const gate = deferred();
  let calls = 0;
  const service = new ConnectionStatusService({ fetchImpl: async () => { calls++; await gate.promise; return json({ data: [{ id: 'test-model' }] }); } });
  const pending = Array.from({ length: 32 }, (_, i) => service.get('model', modelConfig({ modelKey: `pending-${i}` })));
  const overflow = await service.get('model', modelConfig({ modelKey: 'overflow' }));
  assert.equal(overflow.state, 'error');
  gate.resolve();
  await Promise.all(pending);
  assert.equal(calls, 32);
});

test('断开后 TTL 自动再探测恢复连接，不重复发送任务', async () => {
  let time = 1700000000000;
  let online = false;
  let calls = 0;
  const service = new ConnectionStatusService({ now: () => time, ttlMs: 30, fetchImpl: async (url, options) => {
    readonly(url, options);
    calls++;
    if (!online) throw new Error('模拟断开');
    return json({ data: [{ id: 'test-model' }] });
  } });
  const config = modelConfig();
  assert.equal((await service.get('model', config)).state, 'offline');
  online = true;
  assert.equal((await service.get('model', config)).state, 'offline');
  time += 30;
  assert.equal((await service.get('model', config)).state, 'connected');
  assert.equal(calls, 2);
});

test('缺模型 ID 或所需密钥未配置，本地无密钥可用，不读环境密钥', async () => {
  let calls = 0;
  const service = new ConnectionStatusService({ fetchImpl: async () => { calls++; return json({ data: [{ id: 'test-model' }] }); } });
  for (const config of [{}, modelConfig({ modelKey: '' }), modelConfig({ model: { provider: 'openai', baseUrl: 'https://model.example/v1', modelId: '' } })]) {
    const result = await service.get('model', config);
    assert.equal(result.state, 'unconfigured');
    assert.equal(result.action, 'configure');
  }
  assert.equal(calls, 0);
  assert.equal((await service.get('model', modelConfig({ model: { provider: 'local', baseUrl: 'https://model.example/v1', modelId: 'test-model' }, modelKey: null }))).state, 'connected');
});

test('401/403 需授权，网络失败/503 离线且仅输出安全错误', async () => {
  for (const status of [401, 403, 503, 429]) {
    const service = new ConnectionStatusService({ fetchImpl: async () => json({ message: 'private-model-key 原始错误' }, status) });
    const result = await service.get('model', modelConfig());
    assert.equal(result.state, status === 503 ? 'offline' : status === 429 ? 'error' : 'unauthorized');
    assert.equal(result.action, status === 503 ? 'reconnect' : status === 429 ? 'configure' : 'authorize');
    assert.doesNotMatch(JSON.stringify(result), /private-model-key|原始错误/);
  }
  const service = new ConnectionStatusService({ fetchImpl: async () => { throw new Error('private-model-key 敏感网络错误'); } });
  const result = await service.get('model', modelConfig());
  assert.equal(result.state, 'offline');
  assert.equal(result.action, 'reconnect');
  assert.doesNotMatch(JSON.stringify(result), /private-model-key|敏感网络错误/);
});

test('无列表端点 404/405/501 只标 ready，无模型或坏 JSON 不声称生成可用', async () => {
  for (const status of [404, 405, 501]) {
    const service = new ConnectionStatusService({ fetchImpl: async () => json({}, status) });
    const result = await service.get('model', modelConfig());
    assert.equal(result.state, 'ready');
    assert.match(result.message, /未自动检测生成/);
  }
  const missing = new ConnectionStatusService({ fetchImpl: async () => json({ data: [{ id: 'other' }] }) });
  assert.equal((await missing.get('model', modelConfig())).state, 'ready');
  for (const body of [{ output: '不能算模型列表' }, null]) {
    const service = new ConnectionStatusService({ fetchImpl: async () => json(body) });
    assert.equal((await service.get('model', modelConfig())).state, 'error');
  }
  const malformed = new ConnectionStatusService({ fetchImpl: async () => ({ ...json({}), text: async () => '<html>private-model-key</html>' }) });
  assert.equal((await malformed.get('model', modelConfig())).state, 'error');
});

test('AbortSignal 和 race 同时限制 fetch 与响应体，忽略 abort 的桩也能结束', async () => {
  for (const bodyHangs of [false, true]) {
    let signal;
    const service = new ConnectionStatusService({ timeoutMs: 15, fetchImpl: async (url, options) => {
      signal = options.signal;
      if (!bodyHangs) return new Promise(() => {});
      return { ...json({}), text: () => new Promise(() => {}) };
    } });
    const started = Date.now();
    const result = await service.get('model', modelConfig());
    assert.equal(result.state, 'offline');
    assert.equal(result.action, 'reconnect');
    assert.ok(signal.aborted);
    assert.ok(Date.now() - started < 1000);
  }
});

test('真实响应体超时被取消，过大响应安全拒绝', async () => {
  let canceled = false;
  let signal;
  const service = new ConnectionStatusService({ timeoutMs: 15, fetchImpl: async (url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { canceled = true; } }));
  } });
  assert.equal((await service.get('model', modelConfig())).state, 'offline');
  assert.ok(signal.aborted);
  assert.ok(canceled);
  const large = new ConnectionStatusService({ fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)) });
  assert.equal((await large.get('model', modelConfig())).state, 'error');
});

test('URL 凭据/query/hash、非本机 HTTP、生成路径均拒绝且不发请求', async () => {
  let calls = 0;
  const service = new ConnectionStatusService({ fetchImpl: async () => { calls++; return json({}); } });
  for (const baseUrl of ['http://model.example/v1', 'https://u:private-model-key@model.example/v1', 'https://model.example/v1?api_key=secret', 'https://model.example/v1#secret', 'file:///tmp/models', 'https://model.example/v1/chat/completions', 'https://model.example/v1/%67enerate', 'http://localhost.example/v1']) {
    const result = await service.get('model', modelConfig({ model: { provider: 'compatible', modelId: 'test-model', baseUrl } }));
    assert.equal(result.state, 'error');
    assert.doesNotMatch(JSON.stringify(result), /private-model-key|api_key|model\.example/);
  }
  assert.equal(calls, 0);
});

test('重定向无跟随，无论 HTTP 302 或 redirected mock 都不泄密', async () => {
  for (const response of [json({}, 302), { ...json({ data: [{ id: 'test-model' }] }), redirected: true, url: 'https://evil.example' }]) {
    let calls = 0;
    const service = new ConnectionStatusService({ fetchImpl: async (url, options) => { readonly(url, options); calls++; return response; } });
    assert.equal((await service.get('model', modelConfig())).state, 'error');
    assert.equal(calls, 1);
  }
});

test('错误响应立即取消未读响应体，避免后台连接泄漏', async () => {
  for (const status of [401, 404, 503]) {
    let canceled = false;
    const service = new ConnectionStatusService({ fetchImpl: async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), { status }) });
    await service.get('model', modelConfig());
    assert.ok(canceled);
  }
});

test('handoff 每次读取 bridge.status，近期访问不等同 PC 在线，未监听可重连', async () => {
  let reads = 0;
  let listening = true;
  const bridge = { get status() { reads++; return { listening, lastClientAt: new Date().toISOString(), secret: 'private-bridge' }; } };
  const service = new ConnectionStatusService({ fetchImpl: () => { throw new Error('不得请求网络'); } });
  const config = workbuddyConfig('handoff');
  const ready = await service.get('agent', config, { bridge });
  assert.equal(ready.state, 'ready');
  assert.match(ready.message, /不证明.*持续在线/);
  assert.doesNotMatch(JSON.stringify(ready), /private-bridge|lastClientAt/);
  listening = false;
  const offline = await service.get('agent', config, { bridge });
  assert.equal(offline.state, 'offline');
  assert.equal(offline.action, 'reconnect');
  assert.equal(reads, 2);
  assert.equal((await service.get('agent', config)).state, 'offline');
});

test('localassistant 仅 GET 固定 relay 端点，平台 PC 在线/离线/401 映射准确', async () => {
  for (const [online, status, state, action] of [[true, 200, 'connected', null], [false, 200, 'offline', 'reconnect'], [true, 401, 'unauthorized', 'authorize']]) {
    const calls = [];
    const service = new ConnectionStatusService({ fetchImpl: async (url, options) => {
      readonly(url, options);
      calls.push(url);
      assert.equal(options.headers.authorization, 'Bearer private-relay-token');
      return json({ code: 0, data: { online, access_token: 'private-upstream-token' }, errmsg: '原始 errmsg' }, status);
    } });
    const result = await service.get('agent', workbuddyConfig('localassistant'));
    contract(result, 'agent');
    assert.equal(result.state, state);
    assert.equal(result.action, action);
    assert.deepEqual(calls, ['https://relay.example/v1/localassistant']);
    assert.doesNotMatch(JSON.stringify(result), /private-relay-token|private-upstream-token|errmsg/);
  }
});

test('localassistant 无 relay 未配置，不直连；无 token 需授权，超时离线', async () => {
  let calls = 0;
  const service = new ConnectionStatusService({ fetchImpl: async () => { calls++; return json({}); } });
  const legacy = { agent: { mode: 'workbuddy', workbuddyTransport: 'localassistant' }, workbuddyAccessToken: 'legacy-token' };
  assert.equal((await service.get('agent', legacy)).state, 'unconfigured');
  assert.equal((await service.get('agent', workbuddyConfig('localassistant', { workbuddyAccessToken: null }))).state, 'unauthorized');
  assert.equal(calls, 0);
  const hanging = new ConnectionStatusService({ timeoutMs: 15, fetchImpl: async () => new Promise(() => {}) });
  assert.equal((await hanging.get('agent', workbuddyConfig('localassistant'))).state, 'offline');
});

test('WorkBuddy Cloud 与 CloudAgent 只读既有列表，不创建任务或沙箱', async () => {
  const calls = [];
  const service = new ConnectionStatusService({ fetchImpl: async (url, options) => {
    readonly(url, options);
    calls.push(url);
    return json({ code: 0, data: { items: [], pagination: { total: 0 } } });
  } });
  assert.equal((await service.get('agent', workbuddyConfig('cloud'))).state, 'connected');
  assert.equal((await service.get('agent', { agent: { mode: 'cloudagent' }, cloudagentApiKey: 'private-cloud-key' })).state, 'connected');
  assert.deepEqual(calls, ['https://www.workbuddy.cn/openapi/v2/tasks?page=1&size=1', 'https://www.codebuddy.cn/v2/agentos/runtimes?page=1&pageSize=1']);
});

test('云端只读 helper 的 401 不被原异常吞掉，超时覆盖响应体', async () => {
  for (const config of [workbuddyConfig('cloud'), { agent: { mode: 'cloudagent' }, cloudagentApiKey: 'private-cloud-key' }]) {
    const service = new ConnectionStatusService({ fetchImpl: async () => json({ msg: 'private-cloud-key 原始异常' }, 401) });
    const result = await service.get('agent', config);
    assert.equal(result.state, 'unauthorized');
    assert.equal(result.action, 'authorize');
    assert.doesNotMatch(JSON.stringify(result), /private-cloud-key|原始异常/);
    const hanging = new ConnectionStatusService({ timeoutMs: 15, fetchImpl: async () => ({ ...json({}), text: () => new Promise(() => {}) }) });
    assert.equal((await hanging.get('agent', config)).state, 'offline');
  }
});

test('known helper 将来改变端点或尝试 POST 也不会执行', async t => {
  const cloud = require('../electron/workbuddy-cloud.cjs');
  const original = cloud.checkWorkBuddyCloud;
  t.after(() => { cloud.checkWorkBuddyCloud = original; });
  let calls = 0;
  const service = new ConnectionStatusService({ fetchImpl: async () => { calls++; return json({}); } });
  for (const [url, method] of [['https://www.workbuddy.cn/openapi/v2/tasks?page=1&size=1', 'POST'], ['https://www.workbuddy.cn/openapi/v2/tasks', 'GET']]) {
    cloud.checkWorkBuddyCloud = async (config, fetchImpl) => { await fetchImpl(url, { method }); return { ok: true }; };
    assert.equal((await service.get('agent', workbuddyConfig('cloud'), { force: true })).state, 'error');
  }
  assert.equal(calls, 0);
  cloud.checkWorkBuddyCloud = async (config, fetchImpl) => {
    const url = 'https://www.workbuddy.cn/openapi/v2/tasks?page=1&size=1';
    await fetchImpl(url, { method: 'GET' });
    await fetchImpl(url, { method: 'GET' }).catch(() => {});
    return { ok: true };
  };
  assert.equal((await service.get('agent', workbuddyConfig('cloud'), { force: true })).state, 'error');
  assert.equal(calls, 1);
});

test('external 无文档 health 仅 ready，CLI 不运行 prompt，不调用 testConnection/testLocalAgent', async t => {
  const modules = [require('../electron/connection-service.cjs'), require('../electron/local-agent-service.cjs'), require('../electron/codebuddy-service.cjs')];
  const names = ['testConnection', 'testLocalAgent', 'testCodeBuddy'];
  const originals = modules.map((module, i) => module[names[i]]);
  modules.forEach((module, i) => { module[names[i]] = () => { assert.fail('不能执行测试提示词'); }; });
  t.after(() => modules.forEach((module, i) => { module[names[i]] = originals[i]; }));
  let requests = 0;
  const modes = [];
  const service = new ConnectionStatusService({ fetchImpl: async () => { requests++; assert.fail('不得请求网络'); }, checkLocal: async (mode, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.timeoutMs, 3000);
    assert.equal(options.prompt, undefined);
    modes.push(mode);
    return { available: true, stdout: 'private-cli-output', token: 'private-cli-token' };
  } });
  const external = await service.get('agent', { agent: { mode: 'external', endpoint: 'https://agent.example/run' }, agentToken: 'private-agent-token' });
  assert.equal(external.state, 'ready');
  assert.match(external.message, /未自动调用/);
  for (const mode of ['codex', 'kimi', 'codebuddy']) {
    const result = await service.get('agent', { agent: { mode } });
    assert.equal(result.state, 'ready');
    assert.match(result.message, /未验证登录或在线/);
    assert.doesNotMatch(JSON.stringify(result), /private-cli-/);
  }
  assert.deepEqual(modes, ['codex', 'kimi', 'codebuddy']);
  assert.equal(requests, 0);
});

test('CLI 未安装为 unconfigured，挂起的只读本地检查有限超时', async () => {
  const missing = new ConnectionStatusService({ checkLocal: async () => false });
  assert.equal((await missing.get('agent', { agent: { mode: 'codex' } })).state, 'unconfigured');
  let signal;
  const service = new ConnectionStatusService({ timeoutMs: 15, checkLocal: async (mode, options) => { signal = options.signal; return new Promise(() => {}); } });
  assert.equal((await service.get('agent', { agent: { mode: 'kimi' } })).state, 'offline');
  assert.ok(signal.aborted);
});

test('wecom-bot 返回实时 WebSocket 状态，断开不被缓存掩盖，也不主动 start/send', async () => {
  const config = { wecom: { botId: 'bot-id' }, wecomBotSecret: 'private-bot-secret' };
  const bot = { status: '已连接', start() { assert.fail('不得启动机器人'); }, sendText() { assert.fail('不得发送消息'); }, lastError: 'private-bot-secret 原始错误' };
  const service = new ConnectionStatusService();
  assert.equal((await service.get('wecom-bot', config, { bot })).state, 'connected');
  for (const status of ['已断开，等待重连', '重连中', '连接中', '连接异常', '未配置']) {
    bot.status = status;
    const result = await service.get('wecom-bot', config, { bot });
    assert.equal(result.state, 'offline');
    assert.equal(result.action, 'reconnect');
    assert.doesNotMatch(JSON.stringify(result), /private-bot-secret|原始错误/);
  }
  assert.equal((await service.get('wecom-bot', {})).state, 'unconfigured');
  assert.equal((await service.get('wecom-bot', config)).state, 'offline');
});

test('企微和飞书只评估凭据完整度，不获取 access token 或 POST 消息', async () => {
  const service = new ConnectionStatusService({ fetchImpl: async () => { assert.fail('不允许直连集成平台'); } });
  for (const [kind, config] of [
    ['wecom', { wecom: { organizationId: 'corp', applicationId: '100001' }, wecomSecret: 'private-wecom-secret' }],
    ['feishu', { feishu: { appId: 'cli_app12345678' }, feishuAppSecret: 'private-feishu-secret' }]
  ]) {
    assert.equal((await service.get(kind, {})).state, 'unconfigured');
    const result = await service.get(kind, config);
    contract(result, kind);
    assert.equal(result.state, 'ready');
    assert.match(result.message, /需要验证/);
    assert.doesNotMatch(JSON.stringify(result), /private-wecom-secret|private-feishu-secret|cli_app12345678/);
  }
});

test('未知类型和模式安全返回，不透传原 kind/config 或异常', async () => {
  const service = new ConnectionStatusService();
  const unknown = await service.get('private-secret-kind', { token: 'private-config' });
  contract(unknown, 'connection');
  assert.equal(unknown.state, 'unsupported');
  assert.doesNotMatch(JSON.stringify(unknown), /private-/);
  assert.equal((await service.get('agent', { agent: { mode: 'unknown' } })).state, 'unsupported');
  const bad = await service.get('model', { secret: 'private-config', callback: () => {} });
  assert.equal(bad.state, 'error');
  assert.doesNotMatch(JSON.stringify(bad), /private-config/);
});
