const test = require('node:test');
const assert = require('node:assert/strict');
const { callCloudAgent, checkCloudAgent, parseLossless, permissionReply, spaceKey, workKey, spaceManifest } = require('../electron/cloudagent.cjs');
const { AgentService, cloudSessionFor, sessionOwner } = require('../electron/agent-service.cjs');

const BIG = '2110293515846402048';

// In-memory AgentOS: control plane + ACP (GET SSE, POST 202 / SSE for prompt).
function fakeAgentOS({ history = [] } = {}) {
  const state = { runtimes: [], created: [], prompts: [], loads: [], news: [], permissionAnswers: [], headers: [] };
  let sse = null;
  const encoder = new TextEncoder();
  const push = message => sse?.enqueue(encoder.encode(`id: 1\nevent: message\ndata: ${JSON.stringify(message)}\n\n`));
  const json = (status, text) => new Response(text, { status, headers: { 'content-type': 'application/json' } });
  const runtimeJson = runtime => `{"id":${runtime.id},"runtimeName":"${runtime.name}","status":"${runtime.status}","metadata":${JSON.stringify(runtime.metadata)},"links":{"acpLink":{"url":"https://sandbox.test/acp","token":"tok","tokenExpiresAt":1}}}`;
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    if (target.host === 'www.codebuddy.cn') {
      state.headers.push(options.headers);
      if (options.headers['x-api-key'] !== 'ck_test') return json(401, '{"code":401}');
      const route = target.pathname.replace('/v2/agentos', '');
      if (route === '/runtimes' && options.method === 'GET') {
        const key = target.searchParams.get('metadata.gongzuo_work');
        const items = state.runtimes.filter(item => !key || item.metadata.gongzuo_work === key);
        return json(200, `{"code":0,"data":{"items":[${items.map(runtimeJson).join(',')}],"pagination":{"total":${items.length}}}}`);
      }
      if (route === '/runtimes' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        state.created.push(body);
        const runtime = { id: String(BigInt(BIG) + BigInt(state.runtimes.length)), name: body.runtimeName, status: 'CREATING', metadata: body.metadata, polls: 0 };
        state.runtimes.push(runtime);
        return json(201, `{"code":0,"data":${runtimeJson(runtime)}}`);
      }
      const match = /^\/runtimes\/(\d+)$/.exec(route);
      if (match) {
        const runtime = state.runtimes.find(item => item.id === match[1]);
        if (!runtime) return json(404, '{"code":404,"msg":"not found"}');
        if (runtime.status === 'CREATING' && ++runtime.polls >= 2) runtime.status = 'RUNNING';
        return json(200, `{"code":0,"data":${runtimeJson(runtime)}}`);
      }
      return json(404, '{}');
    }
    if (target.host === 'sandbox.test') {
      if (options.method === 'GET') {
        const body = new ReadableStream({ start(controller) { sse = controller; controller.enqueue(encoder.encode(': padding\n\n')); } });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'acp-connection-id': 'conn-1' } });
      }
      if (options.method === 'DELETE') return new Response('', { status: 200 });
      const message = JSON.parse(options.body);
      if (message.method === undefined) { state.permissionAnswers.push(message); return new Response('', { status: 202 }); }
      if (message.method === 'session/prompt') {
        state.prompts.push(message.params);
        const stream = new ReadableStream({
          start(controller) {
            push({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', title: 'ls /workspace', kind: 'execute' } } });
            push({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: { toolCall: { kind: 'execute', title: 'rm -rf build' }, options: [{ optionId: 'a', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }] } });
            push({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已完成：' } } } });
            push({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '沙箱为空。' } } } });
            setTimeout(() => { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })}\n\n`)); controller.close(); }, 20);
          }
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      setTimeout(() => {
        if (message.method === 'initialize') push({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
        if (message.method === 'session/new') { state.news.push(message.params); push({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'sess-1' } }); }
        if (message.method === 'session/set_mode') push({ jsonrpc: '2.0', id: message.id, result: {} });
        if (message.method === 'session/load') {
          state.loads.push(message.params);
          for (const text of history) push({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
          push(message.params.sessionId === 'sess-1' ? { jsonrpc: '2.0', id: message.id, result: {} } : { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'no session' } });
        }
      }, 5);
      return new Response('', { status: 202 });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { state, fetchImpl };
}

const config = { cloudagentApiKey: 'ck_test' };

test('雪花 ID 不丢精度', () => {
  assert.equal(parseLossless(`{"id":${BIG},"n":12,"a":[${BIG}]}`).id, BIG);
  assert.deepEqual(parseLossless(`{"a":[${BIG}],"n":12}`), { a: [BIG], n: 12 });
});

test('首次执行：为这项工作建沙箱并等就绪，新建会话，流式进度，拒绝执行命令并说明', async () => {
  const { state, fetchImpl } = fakeAgentOS();
  const progress = [];
  const result = await callCloudAgent(config, [{ role: 'user', text: '看看沙箱里有什么' }], '产品团队', {}, { fetchImpl, workId: 'w1', title: '看沙箱', onProgress: p => progress.push(p) });
  assert.equal(state.created.length, 1);
  const manifest = state.created[0].agentManifest;
  assert.equal(manifest.manifestVersion, '1.0');
  assert.deepEqual(manifest.secrets, [{ key: 'CODEBUDDY_API_KEY', value: 'ck_test' }], 'AgentOS 要求带 CODEBUDDY_API_KEY');
  assert.equal(state.created[0].metadata.gongzuo_space, spaceKey('产品团队'));
  assert.equal(state.created[0].metadata.gongzuo_work, workKey('w1'));
  assert.equal(state.created[0].runtimeName, '共作·看沙箱');
  assert.ok(state.headers.every(h => h['X-Source-App'] === 'gongzuo'));
  assert.equal(state.news.length, 1);
  assert.equal(result.sessionId, `${BIG}:sess-1`);
  assert.match(result.text, /^已完成：沙箱为空。/);
  assert.match(result.text, /已拒绝：rm -rf build/);
  assert.deepEqual(state.permissionAnswers[0].result, { outcome: { outcome: 'selected', optionId: 'r' } });
  assert.ok(progress.some(p => p.step === '运行命令 ls /workspace'), '步骤用人话显示');
  assert.ok(progress.every(p => p.startedAt > 0), '进度带开始时间');
  assert.ok(progress.some(p => p.lastActivityAt > 0), '进度带最近动作时间');
  assert.ok(!state.prompts[0].prompt[0].text.includes('【共作消息'), '没有消息 id 时不加编号');
  assert.match(state.prompts[0].prompt[0].text, /看看沙箱里有什么/);
});

test('追问：复用这项工作的沙箱与会话，只发最后一条；加载时回放的历史不混入本轮回复', async () => {
  const { state, fetchImpl } = fakeAgentOS({ history: ['上一轮的旧回复'] });
  const first = await callCloudAgent(config, [{ role: 'user', text: '第一问' }], '产品团队', {}, { fetchImpl, workId: 'w1' });
  const second = await callCloudAgent(config, [{ role: 'user', text: '第一问' }, { role: 'assistant', text: first.text }, { role: 'user', text: '第二问' }], '产品团队', {}, { fetchImpl, workId: 'w1', sessionId: first.sessionId });
  assert.equal(state.created.length, 1, '同一工作不重复建沙箱');
  assert.deepEqual(state.loads.map(item => item.sessionId), ['sess-1']);
  assert.equal(second.sessionId, first.sessionId);
  assert.ok(!second.text.includes('上一轮的旧回复'));
  assert.ok(!state.prompts[1].prompt[0].text.includes('第一问'), '续接只发新消息');
});

test('不同工作各自建沙箱、对话不串；丢了会话 ID 能按工作找回沙箱；会话失效时新开并发送完整对话', async () => {
  const { state, fetchImpl } = fakeAgentOS();
  const a = await callCloudAgent(config, [{ role: 'user', text: 'x' }], '产品团队', {}, { fetchImpl, workId: 'w1' });
  const b = await callCloudAgent(config, [{ role: 'user', text: 'y' }], '产品团队', {}, { fetchImpl, workId: 'w2' });
  assert.equal(state.created.length, 2);
  assert.notEqual(a.sessionId.split(':')[0], b.sessionId.split(':')[0]);
  await callCloudAgent(config, [{ role: 'user', text: 'x2' }], '产品团队', {}, { fetchImpl, workId: 'w1' });
  assert.equal(state.created.length, 2, '按工作标签找回已有沙箱');
  const result = await callCloudAgent(config, [{ role: 'user', text: '旧问题' }, { role: 'assistant', text: '旧答' }, { role: 'user', text: '新问题' }], '产品团队', {}, { fetchImpl, workId: 'w1', sessionId: `${BIG}:gone` });
  assert.equal(state.news.length, 4);
  assert.match(state.prompts.at(-1).prompt[0].text, /旧问题[\s\S]*新问题/);
  assert.equal(result.sessionId, `${BIG}:sess-1`);
  assert.notEqual(spaceKey('产品团队'), spaceKey('运营团队'));
  assert.equal(spaceManifest('运营团队', 'k').id, `gongzuo-${spaceKey('运营团队')}`);
});

test('权限策略：读写类允许，其余拒绝', () => {
  const declined = [];
  const options = [{ optionId: 'ok', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }];
  assert.deepEqual(permissionReply({ params: { toolCall: { kind: 'edit', title: '改 README' }, options } }, declined), { outcome: { outcome: 'selected', optionId: 'ok' } });
  assert.deepEqual(permissionReply({ params: { toolCall: { kind: 'delete', title: '删除' }, options } }, declined), { outcome: { outcome: 'selected', optionId: 'no' } });
  assert.deepEqual(permissionReply({ params: { toolCall: { kind: 'execute' } } }, declined), { outcome: { outcome: 'cancelled' } });
  assert.deepEqual(declined, ['删除', 'execute']);
});

test('连接测试与错误 Key', async () => {
  const { fetchImpl } = fakeAgentOS();
  assert.match((await checkCloudAgent(config, fetchImpl)).message, /可访问/);
  await assert.rejects(checkCloudAgent({ cloudagentApiKey: 'bad' }, fetchImpl), /API Key 无效/);
  await assert.rejects(checkCloudAgent({}, fetchImpl), /还没有配置 CodeBuddy API Key/);
});

test('Agent 服务：CloudAgent 需要 Key，回复标记来源并续接会话', async () => {
  const agent = new AgentService();
  assert.equal(agent.isConfigured({ agent: { mode: 'cloudagent' } }), false);
  assert.equal(agent.isConfigured({ agent: { mode: 'cloudagent' }, cloudagentApiKey: 'ck' }), true);
  let seen;
  agent.cloudAgentImpl = async (cfg, messages, workspace, memory, options) => { seen = options; return { text: '好', sessionId: 'r:s' }; };
  const answer = await agent.answer({ messages: [{ role: 'user', text: 'hi' }], workspace: '产品团队', agentSessionId: 'r:old' }, { agent: { mode: 'cloudagent' }, cloudagentApiKey: 'ck' });
  assert.equal(seen.sessionId, 'r:old');
  assert.equal(seen.workId, undefined, '测试任务没有 id');
  assert.equal(answer.source, 'cloudagent');
  assert.equal(answer.agentSessionId, 'r:s');
  assert.equal(agent.getStatus({ agent: { mode: 'cloudagent' }, cloudagentKeychain: true }).label, 'CodeBuddy 云端');
});

test('多人：沙箱归属按 Key ID 记录（不含密钥）；同事追问别人的工作时新建自己的沙箱', async () => {
  const mine = { agent: { mode: 'cloudagent' }, cloudagentApiKey: 'ck_me123.SECRET' };
  const theirs = { agent: { mode: 'cloudagent' }, cloudagentApiKey: 'ck_you456.OTHER' };
  assert.equal(sessionOwner(mine), 'ck_me123');
  assert.ok(!sessionOwner(mine).includes('SECRET'));
  const task = { agentSessionId: 'r1:s1', agentSessionOwner: 'ck_me123' };
  assert.equal(cloudSessionFor(task, mine), 'r1:s1');
  assert.equal(cloudSessionFor(task, theirs), undefined);
  const agent = new AgentService();
  agent.cloudAgentImpl = async () => ({ text: 'ok', sessionId: 'r2:s2' });
  const answer = await agent.answer({ id: 'w', messages: [{ role: 'user', text: 'hi' }], workspace: '产品团队', ...task }, theirs);
  assert.equal(answer.agentSessionOwner, 'ck_you456');
});
