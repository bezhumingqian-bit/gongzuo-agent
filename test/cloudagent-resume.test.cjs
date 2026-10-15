// CloudAgent turns without a fixed length: reconnect after a drop or a long
// silence, recognise the own turn in the session/load replay, wait for an
// earlier turn that is still running, and stop only at the safety ceiling.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { callCloudAgent, humanStep } = require('../electron/cloudagent.cjs');
const tag = id => `【共作消息 ${crypto.createHash('sha256').update(id).digest('hex').slice(0, 10)}】`;

const RID = '2110293515846402048';
const timing = { idleMs: 400, checkMs: 40, reconnectDelays: [10, 10, 10], maxTurnMs: 5000, loadMs: 1000 };

// Scriptable AgentOS: the control plane returns one running runtime; the ACP
// side hands load/prompt to the test's callbacks.
function scripted({ onLoad = () => {}, onPrompt = () => {}, getStatus = () => 200 } = {}) {
  const st = { gets: 0, loads: 0, prompts: [], cancels: [], sse: null };
  const encoder = new TextEncoder();
  const push = message => { try { st.sse?.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`)); } catch { /* closed */ } };
  const update = (sessionUpdate, extra = {}) => push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S', update: { sessionUpdate, ...extra } } });
  const say = text => update('agent_message_chunk', { content: { type: 'text', text } });
  const user = text => update('user_message_chunk', { content: { type: 'text', text } });
  const snapshot = status => update('session_info_update', { _meta: { 'codebuddy.ai': { isSnapshot: true, status } } });
  const end = (stopReason = 'end_turn') => push({ jsonrpc: '2.0', method: 'session/endTurn', params: { sessionId: 'S', stopReason } });
  const reply = (id, result) => push({ jsonrpc: '2.0', id, result });
  const dropStream = () => { try { st.sse?.close(); } catch { /* already closed */ } st.sse = null; };
  const h = { st, push, update, say, user, snapshot, end, reply, dropStream };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    if (target.host === 'www.codebuddy.cn') {
      return json(200, { code: 0, data: { id: RID, status: 'RUNNING', metadata: {}, links: { acpLink: { url: 'https://sandbox.test/acp', token: `tok${st.gets}` } } } });
    }
    if (options.method === 'GET') {
      st.gets += 1;
      const status = getStatus(st.gets);
      if (status !== 200) return new Response('', { status });
      const body = new ReadableStream({ start(controller) { st.sse = controller; controller.enqueue(encoder.encode(': ok\n\n')); } });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'acp-connection-id': `c${st.gets}` } });
    }
    if (options.method === 'DELETE') return new Response('', { status: 200 });
    const message = JSON.parse(options.body);
    if (message.method === 'session/cancel') st.cancels.push(message.params);
    setTimeout(() => {
      if (message.method === 'initialize') reply(message.id, { protocolVersion: 1 });
      if (message.method === 'session/load') { st.loads += 1; onLoad(h, message, st.loads); }
      if (message.method === 'session/prompt') { st.prompts.push(message.params.prompt[0].text); onPrompt(h, message, st.prompts.length); }
    }, 2);
    return new Response('', { status: 202 });
  };
  return { st, fetchImpl };
}

const config = { cloudagentApiKey: 'ck_test' };
const run = (fake, extra = {}) => {
  const progress = [];
  const messages = extra.messages || [{ id: 'aaaa1111-msg', role: 'user', text: '做一份 PPT' }];
  return callCloudAgent(config, messages, '产品团队', {}, { fetchImpl: fake.fetchImpl, sessionId: `${RID}:S`, timing, onProgress: p => progress.push(p), ...extra })
    .then(result => ({ result, progress }));
};
const later = (ms, fn) => setTimeout(fn, ms);

test('步骤显示为人话', () => {
  assert.equal(humanStep({ kind: 'execute', title: '`cd /workspace/artifacts/x && python3 build.py`' }), '运行命令 python3 build.py');
  assert.equal(humanStep({ kind: 'read', title: 'Read /tmp/s2num.png' }), '读取 s2num.png');
  assert.equal(humanStep({ kind: 'edit', title: 'Write /workspace/artifacts/CDC介绍.pptx' }), '编辑 CDC介绍.pptx');
  assert.equal(humanStep({ kind: 'think', title: '' }), '思考');
});

test('提示带消息编号；连接中途断开：重连后从回放里认出本轮并拿到完整回复，不重发', async () => {
  const fake = scripted({
    onLoad: (h, message, n) => {
      if (n === 2) { h.user(h.st.prompts[0]); h.say('前半段'); h.say('后半段'); h.end(); h.snapshot('idle'); }
      h.reply(message.id, {});
    },
    onPrompt: h => { h.update('tool_call', { kind: 'execute', title: 'python3 build.py' }); h.say('前半段'); later(20, h.dropStream); }
  });
  const { result, progress } = await run(fake);
  assert.ok(fake.st.prompts[0].endsWith(tag('aaaa1111-msg')));
  assert.equal(fake.st.prompts.length, 1, '重连不重发');
  assert.equal(result.text, '前半段后半段');
  assert.equal(result.sessionId, `${RID}:S`);
  assert.ok(progress.some(p => p.phase === 'reconnecting' && p.attempt === 1), '界面能看到正在重连');
  assert.ok(progress.some(p => p.step === '运行命令 python3 build.py'));
});

test('重连时本轮还在跑：接上实时输出直到结束', async () => {
  const fake = scripted({
    onLoad: (h, message, n) => {
      if (n === 2) { h.user(h.st.prompts[0]); h.say('第一页'); h.snapshot('working'); }
      h.reply(message.id, {});
      if (n === 2) later(20, () => { h.say('，第二页'); h.end(); });
    },
    onPrompt: h => { h.say('第一页'); later(20, h.dropStream); }
  });
  const { result } = await run(fake);
  assert.equal(result.text, '第一页，第二页');
  assert.equal(fake.st.gets, 2);
});

test('长时间没有任何动静：自动重连确认，而不是按固定时长报失败', async () => {
  const fake = scripted({
    onLoad: (h, message, n) => {
      if (n === 2) { h.user(h.st.prompts[0]); h.say('跑完了'); h.end(); h.snapshot('idle'); }
      h.reply(message.id, {});
    },
    onPrompt: () => { /* the stream stays open but silent */ }
  });
  const { result } = await run(fake);
  assert.equal(result.text, '跑完了');
  assert.equal(fake.st.loads, 2);
});

test('上一条请求还在云端执行：先等它完成再发本条，回复里带上上一条的结果', async () => {
  const fake = scripted({
    onLoad: (h, message, n) => {
      if (n === 1) { h.user('用户：做 PPT'); h.say('PPT 做到第 9 页'); h.snapshot('working'); }
      h.reply(message.id, {});
      if (n === 1) later(30, () => { h.say('，已导出 CDC介绍.pptx'); h.end(); });
    },
    onPrompt: (h, message) => { h.say('刚才卡住是因为在逐页自检。'); h.reply(message.id, { stopReason: 'end_turn' }); }
  });
  const { result, progress } = await run(fake);
  assert.equal(fake.st.prompts.length, 1);
  assert.ok(progress.some(p => p.phase === 'waiting-previous'));
  assert.match(result.text, /^【上一条请求在云端已完成】\nPPT 做到第 9 页，已导出 CDC介绍\.pptx/);
  assert.match(result.text, /刚才卡住是因为在逐页自检。$/);
});

test('应用重启后重试：本条早已在云端做完，直接取回，不再发送', async () => {
  const fake = scripted({
    onLoad: (h, message) => { h.user(`用户：做 PPT\n\n${tag('aaaa1111-msg')}`); h.say('早就做完了'); h.end(); h.snapshot('idle'); h.reply(message.id, {}); }
  });
  const { result } = await run(fake);
  assert.equal(fake.st.prompts.length, 0);
  assert.equal(result.text, '早就做完了');
});

test('同样的话再说一遍（不同消息）：不会误认上一轮的回复', async () => {
  const fake = scripted({
    onLoad: (h, message) => { h.user(`用户：继续\n\n${tag('bbbb2222-x')}`); h.say('旧回复'); h.end(); h.snapshot('idle'); h.reply(message.id, {}); },
    onPrompt: (h, message) => { h.say('新回复'); h.reply(message.id, { stopReason: 'end_turn' }); }
  });
  const { result } = await run(fake, { messages: [{ id: 'cccc3333-x', role: 'user', text: '继续' }] });
  assert.equal(fake.st.prompts.length, 1);
  assert.equal(result.text, '新回复');
});

test('超过安全上限：请云端停止，保留已产出的部分并说明', async () => {
  const fake = scripted({
    onLoad: (h, message) => h.reply(message.id, {}),
    onPrompt: h => { h.say('已完成 6 页'); const beat = setInterval(() => h.update('tool_call_update', { status: 'in_progress' }), 30); later(900, () => clearInterval(beat)); }
  });
  const { result } = await run(fake, { timing: { ...timing, maxTurnMs: 300 } });
  assert.equal(result.stopReason, 'timeout');
  assert.match(result.text, /^已完成 6 页/);
  assert.match(result.text, /仍未结束，共作已请云端停止/);
  assert.equal(fake.st.cancels.length, 1);
});

test('一直连不上：有限次重连后报错，并提示稍后重试可取回', async () => {
  const fake = scripted({
    getStatus: n => (n === 1 ? 200 : 503),
    onLoad: (h, message) => h.reply(message.id, {}),
    onPrompt: h => later(10, h.dropStream)
  });
  await assert.rejects(run(fake), /多次重连未成功[\s\S]*重试/);
  assert.equal(fake.st.gets, 1 + timing.reconnectDelays.length);
});
