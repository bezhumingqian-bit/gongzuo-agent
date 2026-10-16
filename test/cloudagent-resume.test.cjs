// CloudAgent turns without a fixed length: reconnect after a drop or a long
// silence, recognise the own turn in the session/load replay, wait for an
// earlier turn that is still running, and stop only at the safety ceiling.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { callCloudAgent, humanStep, workKey, CloudAgentClient } = require('../electron/cloudagent.cjs');
const tag = id => `【共作消息 ${crypto.createHash('sha256').update(id).digest('hex').slice(0, 10)}】`;

const RID = '2110293515846402048';
const timing = { idleMs: 400, checkMs: 40, reconnectDelays: [10, 10, 10], maxTurnMs: 5000, loadMs: 1000 };

// Scriptable AgentOS: the control plane returns one running runtime; the ACP
// side hands load/prompt to the test's callbacks.
function scripted({ onLoad = () => {}, onPrompt = () => {}, getStatus = () => 200, onFetch = () => undefined } = {}) {
  const st = { gets: 0, loads: 0, news: 0, prompts: [], cancels: [], sse: null };
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
    const overridden = onFetch(target, options, h);
    if (overridden !== undefined) return overridden;
    if (target.host === 'www.codebuddy.cn') {
      const runtime = { id: RID, status: 'RUNNING', metadata: { gongzuo_work: workKey('w-resume') }, links: { acpLink: { url: 'https://sandbox.test/acp', token: `tok${st.gets}` } } };
      return json(200, { code: 0, data: target.pathname.endsWith('/runtimes') ? { items: [runtime] } : runtime });
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
      if (message.method === 'session/new') { st.news += 1; reply(message.id, { sessionId: 'S' }); }
      if (message.method === 'session/set_mode') reply(message.id, {});
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
  assert.ok(progress.some(p => p.step === '运行沙箱命令'));
});

test('纯工具回放也形成轮次边界，只保存本轮步骤，重放状态不倒退', async () => {
  const fake = scripted({ onLoad: (h, message) => {
    h.user('上一条请求');
    h.update('tool_call', { toolCallId: 'old', kind: 'read', title: 'Read old.txt', status: 'completed' });
    h.user(tag('aaaa1111-msg'));
    h.update('tool_call', { toolCallId: 'new', kind: 'edit', title: 'Write new.html', status: 'pending' });
    h.update('tool_call_update', { toolCallId: 'new', status: 'completed' });
    h.say('这一轮已完成新文件'); h.end(); h.snapshot('idle'); h.reply(message.id, {});
  } });
  const { progress } = await run(fake);
  const log = progress.at(-1).execution;
  assert.deepEqual(log.map(item => item.id), ['new']);
  assert.equal(log[0].status, 'completed');
  assert.equal(log[0].startedAt, null, '回放不编造耗时');
  assert.equal(fake.st.prompts.length, 0);
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
  assert.match(result.text, /仍未结束，共作已停止等待[\s\S]*不代表完成/);
  assert.equal(result.timedOut, true);
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

test('每次 load 成功后又断线也受总重连次数限制', async () => {
  const fake = scripted({
    onLoad: (h, message, n) => {
      if (n > 1) { h.user(h.st.prompts[0]); h.snapshot('working'); }
      h.reply(message.id, {});
      if (n > 1) later(10, h.dropStream);
    },
    onPrompt: h => { h.say('部分结果'); later(10, h.dropStream); }
  });
  const progress = [];
  await assert.rejects(run(fake, { onProgress: p => progress.push(p) }), /多次重连未成功/);
  assert.equal(fake.st.gets, 1 + timing.reconnectDelays.length);
  assert.equal(fake.st.loads, fake.st.gets);
  assert.equal(fake.st.prompts.length, 1);
  assert.deepEqual(progress.filter(p => p.phase === 'reconnecting').map(p => p.attempt), [1, 2, 3]);
  const lastAction = progress.find(p => p.text === '部分结果').lastActivityAt;
  assert.ok(progress.filter(p => p.phase === 'reconnecting').every(p => p.lastActivityAt === lastAction));
});

test('状态、用户、空动作及其他 session 的通知均不伪造活性，仍会空闲重连', async () => {
  let beat;
  const fake = scripted({
    onLoad: (h, message, n) => {
      if (n === 2) { h.user(h.st.prompts[0]); h.say('回放结果'); h.end(); h.snapshot('idle'); }
      h.reply(message.id, {});
    },
    onPrompt: h => {
      beat = setInterval(() => {
        h.snapshot('working'); h.user('用户噪声');
        h.update('agent_message_chunk', { content: { text: '' } });
        h.update('tool_call'); h.update('tool_call_update', { title: '', status: null, content: [] });
        h.update('tool_call_update', { heartbeat: true });
        h.update('agent_thought_chunk', { content: { text: '  ' } });
        h.update('plan', { entries: [] }); h.update('plan', { entries: [{}] });
        h.push({ method: 'heartbeat', params: { sessionId: 'S' } });
        h.push({ method: 'session/update', params: { sessionId: 'OTHER', update: { sessionUpdate: 'agent_message_chunk', content: { text: '污染' } } } });
        h.push({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call', title: '没有会话号' } } });
        h.push({ method: 'session/endTurn', params: { sessionId: 'OTHER' } });
      }, 10);
    }
  });
  try {
    const { result, progress } = await run(fake, { timing: { ...timing, idleMs: 70, checkMs: 10 } });
    assert.equal(fake.st.loads, 2);
    assert.equal(result.text, '回放结果');
    assert.ok(progress.every(p => !('lastActivityAt' in p)), '历史和连接状态都不产生最近动作时间');
  } finally { clearInterval(beat); }
});

test('本 session 的文字、思考、工具、工具更新、计划真实动作才更新活性', async () => {
  const kinds = [
    ['agent_message_chunk', { content: { text: '正文' } }],
    ['agent_thought_chunk', { content: { text: '分析中' } }],
    ['tool_call', { title: '读取文件', kind: 'read' }],
    ['tool_call_update', { status: 'in_progress' }],
    ['plan', { entries: [{ content: '检查成果', status: 'in_progress', priority: 'high' }] }]
  ];
  const fake = scripted({
    onLoad: (h, message) => h.reply(message.id, {}),
    onPrompt: (h, message) => {
      kinds.forEach(([kind, data], i) => later(10 + 15 * i, () => h.update(kind, data)));
      later(100, () => h.reply(message.id, { stopReason: 'end_turn' }));
    }
  });
  const { progress } = await run(fake);
  const activity = progress.filter(p => p.lastActivityAt);
  assert.equal(activity.length, kinds.length);
  assert.ok(activity.every((p, i) => i === 0 || p.lastActivityAt > activity[i - 1].lastActivityAt));
});

test('未保存 sessionId：按工作找回 runtime，new 后 load 认出本轮，不重发 prompt', async () => {
  const fake = scripted({
    onLoad: (h, message) => {
      h.user(`用户：做 PPT\n\n${tag('aaaa1111-msg')}`);
      h.say('已取回既有会话结果'); h.end(); h.snapshot('idle'); h.reply(message.id, {});
    }
  });
  const { result, progress } = await run(fake, { sessionId: undefined, workId: 'w-resume' });
  assert.equal(fake.st.news, 1);
  assert.equal(fake.st.loads, 1);
  assert.equal(fake.st.prompts.length, 0);
  assert.equal(result.text, '已取回既有会话结果');
  assert.ok(progress.some(p => p.sessionId === `${RID}:S` && p.phase === 'working'));
});

test('首次 new 后 load 返回 no session 可兼容回退，完整 prompt 只发一次', async () => {
  const fake = scripted({
    onLoad: (h, message) => h.push({ id: message.id, error: { code: -32000, message: 'no session' } }),
    onPrompt: (h, message) => { h.say('首次完成'); h.reply(message.id, { stopReason: 'end_turn' }); }
  });
  const { result } = await run(fake, { sessionId: undefined, workId: 'w-resume' });
  assert.equal(fake.st.news, 1);
  assert.equal(fake.st.loads, 1);
  assert.equal(fake.st.prompts.length, 1);
  assert.match(fake.st.prompts[0], /当前工作空间/);
  assert.ok(fake.st.prompts[0].endsWith(tag('aaaa1111-msg')));
  assert.equal(result.text, '首次完成');
});

test('new 后 load 的其他 RPC 错误不得当作无历史而发送 prompt', async () => {
  const fake = scripted({ onLoad: (h, message) => h.push({ id: message.id, error: { code: -32000, message: 'permission denied' } }) });
  await assert.rejects(run(fake, { sessionId: undefined, workId: 'w-resume' }), /permission denied/);
  assert.equal(fake.st.prompts.length, 0);
});

test('会话进度持久化完成后才允许发送 prompt，连接报告没有虚构动作时间', async () => {
  let persisted = false;
  const progress = [];
  const fake = scripted({
    onLoad: (h, message) => h.reply(message.id, {}),
    onPrompt: (h, message) => {
      assert.equal(persisted, true);
      h.say('正常完成'); h.reply(message.id, { stopReason: 'end_turn' });
    }
  });
  await run(fake, {
    onProgress: async p => {
      progress.push(p);
      if (!persisted) {
        assert.equal(p.sessionId, `${RID}:S`);
        assert.equal(p.phase, 'working');
        assert.ok(!p.lastActivityAt);
        assert.equal(fake.st.prompts.length, 0);
        await new Promise(resolve => later(20, resolve));
        persisted = true;
      }
    }
  });
  assert.equal(fake.st.prompts.length, 1);
  assert.ok(progress.some(p => p.lastActivityAt));
});

test('控制面 fetch 和响应体均有超时，忽略 abort 的桩也不会挂起', async () => {
  for (const bodyHangs of [false, true]) {
    let signal;
    const client = new CloudAgentClient({
      apiKey: 'ck_test', requestMs: 20,
      fetchImpl: (_url, init) => {
        signal = init.signal;
        return bodyHangs ? { ok: true, text: () => new Promise(() => {}) } : new Promise(() => {});
      }
    });
    await assert.rejects(client.getRuntime(RID), error => error.timeout && /控制面请求超时/.test(error.message));
    assert.equal(signal.aborted, true);
  }
});

test('安全上限的取消 fetch 或响应体挂起时有界返回 timeout，不能报告完成', async () => {
  for (const bodyHangs of [false, true]) {
    let cancelSignal;
    const progress = [];
    const fake = scripted({
      onLoad: (h, message) => h.reply(message.id, {}),
      onPrompt: h => h.say('部分输出'),
      onFetch: (url, init, h) => {
        if (url.host === 'sandbox.test' && init.method === 'POST' && JSON.parse(init.body).method === 'session/cancel') {
          h.st.cancels.push(JSON.parse(init.body).params); cancelSignal = init.signal;
          return bodyHangs ? { ok: true, headers: new Headers(), text: () => new Promise(() => {}) } : new Promise(() => {});
        }
      }
    });
    const { result } = await run(fake, { timing: { ...timing, maxTurnMs: 120, checkMs: 10, cancelMs: 20, requestMs: 30 }, onProgress: p => progress.push(p) });
    assert.equal(fake.st.cancels.length, 1);
    assert.equal(cancelSignal.aborted, true);
    assert.equal(result.stopReason, 'timeout');
    assert.equal(result.timedOut, true);
    assert.match(result.text, /部分输出[\s\S]*不能确认成功[\s\S]*不代表完成/);
    assert.equal(progress.at(-1).phase, 'timeout');
  }
});

function recoveredFiles(entries, reply) {
  const downloads = [];
  const runtime = { id: RID, status: 'RUNNING', metadata: { gongzuo_work: workKey('w-resume') }, links: {
    acpLink: { url: 'https://sandbox.test/acp', token: 'tok' },
    sandboxLink: { dataPlaneEndpoint: 'https://files.test' }
  } };
  const fake = scripted({
    onLoad: (h, message) => {
      h.user(`用户：做文件\n\n${tag('aaaa1111-msg')}`);
      h.say(reply); h.end(); h.snapshot('idle'); h.reply(message.id, {});
    },
    onFetch: (url, init) => {
      if (url.host === 'www.codebuddy.cn') return new Response(JSON.stringify({ code: 0, data: url.pathname.endsWith('/runtimes') ? { items: [runtime] } : runtime }));
      if (url.host !== 'files.test') return;
      assert.equal(init.headers['x-access-token'], 'tok');
      if (url.pathname === '/filesystem.Filesystem/ListDir') return new Response(JSON.stringify({ entries }));
      assert.equal(url.pathname, '/files');
      const remote = url.searchParams.get('path');
      downloads.push(remote);
      return new Response(`内容：${remote}`);
    }
  });
  return { fake, downloads };
}
const fileEntry = (name, extra = {}) => ({ type: 'FILE_TYPE_FILE', path: `/workspace/artifacts/${name}`, size: '1', modifiedTime: '2026-10-14T08:00:00Z', ...extra });

test('重启时基线已有本轮文件：从本轮最终回复明确文件名额外取回，不拉历史及子串同名文件', async () => {
  const { fake, downloads } = recoveredFiles([
    fileEntry('本轮.pptx'), fileEntry('轮.pptx'), fileEntry('旧历史.md'), fileEntry('其他本轮.md')
  ], '已完成文件《本轮.pptx》，请查看成果。');
  const { result } = await run(fake, { sessionId: undefined, workId: 'w-resume' });
  try {
    assert.equal(fake.st.prompts.length, 0);
    assert.deepEqual(downloads, ['/workspace/artifacts/本轮.pptx']);
    assert.deepEqual(result.files.map(file => file.name), ['本轮.pptx']);
  } finally { if (result.filesDirectory) await require('node:fs/promises').rm(result.filesDirectory, { recursive: true, force: true }); }
});

test('可靠本轮开始时间与 createdTime 可取回重启前文件；仅 modifiedTime、未来或旧创建时间不能认领', async () => {
  const turnStartedAt = Date.now() - 120000;
  const { fake, downloads } = recoveredFiles([
    fileEntry('本轮.md', { createdTime: new Date(turnStartedAt + 1000).toISOString() }),
    fileEntry('历史刚修改.md', { createdTime: new Date(turnStartedAt - 1000).toISOString(), modifiedTime: new Date().toISOString() }),
    fileEntry('只有修改时间.md', { modifiedTime: new Date().toISOString() }),
    fileEntry('未来.md', { createdTime: new Date(Date.now() + 600000).toISOString() })
  ], '任务已完成，以下是本轮内容摘要。');
  const { result } = await run(fake, { turnStartedAt });
  try {
    assert.deepEqual(downloads, ['/workspace/artifacts/本轮.md']);
    assert.deepEqual(result.files.map(file => file.name), ['本轮.md']);
  } finally { if (result.filesDirectory) await require('node:fs/promises').rm(result.filesDirectory, { recursive: true, force: true }); }
});

test('重启恢复没有可靠本轮时间和明确文件名时宁缺勿滥，不用启动时间或 modifiedTime 猜历史', async () => {
  const { fake, downloads } = recoveredFiles([
    fileEntry('历史.md', { modifiedTime: new Date().toISOString(), createdTime: new Date(Date.now() - 1000).toISOString() })
  ], '本轮内容已完成，但未提供文件名。');
  const { result } = await run(fake);
  assert.equal(result.files, undefined);
  assert.deepEqual(downloads, []);
});

test('本轮文件列表基线读取失败后，不凭历史文件近期 modifiedTime 拉回无关文件', async () => {
  let lists = 0;
  let createdTime;
  const downloads = [];
  const runtime = { id: RID, status: 'RUNNING', links: {
    acpLink: { url: 'https://sandbox.test/acp', token: 'tok' }, sandboxLink: { dataPlaneEndpoint: 'https://files.test' }
  } };
  const fake = scripted({
    onLoad: (h, message) => h.reply(message.id, {}),
    onPrompt: (h, message) => { createdTime = new Date().toISOString(); h.say('已完成'); h.reply(message.id, { stopReason: 'end_turn' }); },
    onFetch: (url, init) => {
      if (url.host === 'www.codebuddy.cn') return new Response(JSON.stringify({ code: 0, data: runtime }));
      if (url.host !== 'files.test') return;
      if (url.pathname === '/filesystem.Filesystem/ListDir') {
        if (++lists <= 2) return new Response('', { status: 500 });
        return new Response(JSON.stringify({ entries: [fileEntry('本轮.md', { createdTime }), fileEntry('历史.md', { modifiedTime: new Date().toISOString() })] }));
      }
      downloads.push(url.searchParams.get('path'));
      return new Response('文件');
    }
  });
  const { result } = await run(fake);
  try { assert.deepEqual(downloads, ['/workspace/artifacts/本轮.md']); }
  finally { if (result.filesDirectory) await require('node:fs/promises').rm(result.filesDirectory, { recursive: true, force: true }); }
});

test('ACP open 和初始化 fetch 挂起均有超时与总重试上限，不会发送 prompt', async () => {
  for (const hangsOnOpen of [true, false]) {
    let requests = 0;
    const signals = [];
    const fake = scripted({
      onFetch: (url, init) => {
        if (url.host !== 'sandbox.test') return;
        const shouldHang = hangsOnOpen ? init.method === 'GET'
          : init.method === 'POST' && JSON.parse(init.body).method === 'initialize';
        if (shouldHang) { requests += 1; signals.push(init.signal); return new Promise(() => {}); }
      }
    });
    await assert.rejects(run(fake, { timing: { ...timing, requestMs: 20 } }), /多次重连未成功/);
    assert.equal(requests, 1 + timing.reconnectDelays.length);
    assert.ok(signals.every(signal => signal.aborted));
    assert.equal(fake.st.prompts.length, 0);
  }
});

test('消息创建时间不是可靠的云端本轮开始时间，不能据此额外下载历史文件', async () => {
  const { fake, downloads } = recoveredFiles([
    fileEntry('旧文件.md', { createdTime: new Date(Date.now() - 60000).toISOString() })
  ], '已完成，本轮未提供明确文件名。');
  const { result } = await run(fake, { messages: [
    { role: 'user', text: '旧问题', createdAt: new Date(Date.now() - 300000).toISOString() },
    { id: 'aaaa1111-msg', role: 'user', text: '新问题', createdAt: new Date(Date.now() - 120000).toISOString() }
  ] });
  assert.equal(result.files, undefined);
  assert.deepEqual(downloads, []);
});

test('等待上一轮完成后才拍本轮发送基线，不取回上一轮刚生成的文件', async () => {
  const entries = [fileEntry('历史.md', { createdTime: new Date().toISOString() })];
  const downloads = [];
  const runtime = { id: RID, status: 'RUNNING', links: {
    acpLink: { url: 'https://sandbox.test/acp', token: 'tok' }, sandboxLink: { dataPlaneEndpoint: 'https://files.test' }
  } };
  const fake = scripted({
    onLoad: (h, message) => {
      h.user('上一条请求'); h.snapshot('working'); h.reply(message.id, {});
      later(20, () => { entries.push(fileEntry('上一轮.md', { createdTime: new Date().toISOString() })); h.say('上一轮结束'); h.end(); });
    },
    onPrompt: (h, message) => {
      entries.push(fileEntry('本轮.md', { createdTime: new Date().toISOString() }));
      h.say('本轮完成'); h.reply(message.id, { stopReason: 'end_turn' });
    },
    onFetch: (url, init) => {
      if (url.host === 'www.codebuddy.cn') return new Response(JSON.stringify({ code: 0, data: runtime }));
      if (url.host !== 'files.test') return;
      if (url.pathname === '/filesystem.Filesystem/ListDir') return new Response(JSON.stringify({ entries }));
      downloads.push(url.searchParams.get('path'));
      return new Response('文件内容');
    }
  });
  const { result } = await run(fake, { turnStartedAt: Date.now() - 120000 });
  try {
    assert.equal(fake.st.prompts.length, 1);
    assert.deepEqual(downloads, ['/workspace/artifacts/本轮.md']);
  } finally { if (result.filesDirectory) await require('node:fs/promises').rm(result.filesDirectory, { recursive: true, force: true }); }
});
