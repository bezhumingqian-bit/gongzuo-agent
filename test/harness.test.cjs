const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runKernel } = require('../electron/harness/kernel.cjs');
const { createProvider, chatMessages, parseChat, parseResponses, responsesInput } = require('../electron/harness/providers.cjs');
const { createGongzuoTools } = require('../electron/harness/gongzuo-tools.cjs');
const { ApprovalBroker } = require('../electron/harness/approvals.cjs');
const { ADAPTERS, adapterFor } = require('../electron/harness/adapters.cjs');
const { AgentService } = require('../electron/agent-service.cjs');
const { JsonStore } = require('../electron/store.cjs');
const { TaskRunner } = require('../electron/task-runner.cjs');
const { WorkOperations } = require('../electron/contracts/work-operations.cjs');
const { actors } = require('../electron/contracts/policy.cjs');

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const scripted = replies => {
  const seen = [];
  return { seen, provider: { id: 'stub', model: 'stub', complete: async request => { seen.push({ tools: request.tools.map(tool => tool.name), history: request.history.map(item => ({ ...item })) }); return replies.shift() || { text: '完成', toolCalls: [], stopReason: 'stop' }; } } };
};
const call = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });
const echoTool = (name, extra = {}) => ({ name, kind: 'read', description: name, parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, execute: async ({ q }) => `结果:${q}`, ...extra });

// ---- kernel ----

test('内核：模型 → 工具 → 模型，结果按顺序回给模型；轨迹不含参数和输出', async () => {
  const { provider, seen } = scripted([
    { text: '先查一下', toolCalls: [call('c1', 'lookup', { q: '机密参数' })], stopReason: 'tool_use' },
    { text: '结论：查到了', toolCalls: [], stopReason: 'stop' }
  ]);
  const events = [];
  const result = await runKernel({ provider, system: 'sys', history: [{ role: 'user', content: '问' }], tools: [echoTool('lookup')], hooks: { onEvent: event => events.push(event) } });
  assert.equal(result.text, '结论：查到了');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.steps, 2);
  assert.equal(result.toolCalls, 1);
  assert.deepEqual(seen[1].history.at(-1), { role: 'tool', toolCallId: 'c1', name: 'lookup', content: '结果:机密参数' });
  assert.deepEqual(events.filter(event => event.type === 'tool').map(event => event.status), ['in_progress', 'completed']);
  const log = JSON.stringify(result.trajectory);
  assert.equal(log.includes('机密参数'), false, '轨迹只记动作名与状态');
  assert.deepEqual(result.trajectory.map(item => item.type), ['turn/start', 'step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/start', 'assistant/message', 'turn/end']);
});

test('内核：未知工具、参数错误、守卫拦截都以错误结果回给模型，不执行', async () => {
  let executed = 0;
  const { provider, seen } = scripted([
    { text: '', toolCalls: [call('a', 'nope', {}), { id: 'b', name: 'lookup', arguments: '{坏' }, call('c', 'lookup', {}), call('d', 'lookup', { q: 'x' })], stopReason: 'tool_use' },
    { text: '好的', toolCalls: [], stopReason: 'stop' }
  ]);
  const result = await runKernel({ provider, system: 's', history: [{ role: 'user', content: 'u' }], tools: [echoTool('lookup', { execute: async () => { executed += 1; return 'ok'; } })], hooks: { beforeToolCall: () => ({ block: true, reason: '不允许' }) } });
  const results = seen[1].history.filter(item => item.role === 'tool').map(item => item.content);
  assert.match(results[0], /没有名为 nope/);
  assert.match(results[1], /不是有效的 JSON/);
  assert.match(results[2], /缺少参数 q/);
  assert.match(results[3], /【错误】不允许/);
  assert.equal(executed, 0);
  assert.equal(result.toolCalls, 0);
});

test('内核：输出被截断时整批工具调用都不执行', async () => {
  let executed = 0;
  const { provider, seen } = scripted([
    { text: '', toolCalls: [call('a', 'lookup', { q: '1' }), call('b', 'lookup', { q: '2' })], stopReason: 'length' },
    { text: '重来', toolCalls: [], stopReason: 'stop' }
  ]);
  await runKernel({ provider, system: 's', history: [{ role: 'user', content: 'u' }], tools: [echoTool('lookup', { execute: async () => { executed += 1; return 'ok'; } })] });
  assert.equal(executed, 0);
  assert.equal(seen[1].history.filter(item => item.role === 'tool' && /被截断/.test(item.content)).length, 2);
});

test('内核：单步超出上限的调用补合成结果；到达步数上限时收尾调用不带工具', async () => {
  const many = Array.from({ length: 3 }, (_, i) => call(`c${i}`, 'lookup', { q: String(i) }));
  const { provider, seen } = scripted([
    { text: '', toolCalls: many, stopReason: 'tool_use' },
    { text: '', toolCalls: [call('x', 'lookup', { q: 'x' })], stopReason: 'tool_use' },
    { text: '基于已有信息的结论', toolCalls: [], stopReason: 'stop' }
  ]);
  const result = await runKernel({ provider, system: 's', history: [{ role: 'user', content: 'u' }], tools: [echoTool('lookup')], limits: { maxSteps: 3, maxCallsPerStep: 2 } });
  const firstResults = seen[1].history.filter(item => item.role === 'tool');
  assert.equal(firstResults.length, 3, '每个调用都有结果');
  assert.match(firstResults[2].content, /超出上限/);
  assert.deepEqual(seen[2].tools, [], '收尾调用不再提供工具');
  assert.match(seen[2].history.at(-1).content, /不要再调用工具/);
  assert.equal(result.stopReason, 'max_steps');
  assert.equal(result.text, '基于已有信息的结论');
});

test('内核：取消后停止，模型异常带着轨迹抛出', async () => {
  const controller = new AbortController();
  controller.abort();
  const { provider } = scripted([]);
  assert.equal((await runKernel({ provider, system: 's', history: [], signal: controller.signal })).stopReason, 'cancelled');
  const failing = { id: 'x', model: 'x', complete: async () => { throw new Error('服务返回 HTTP 500'); } };
  await assert.rejects(runKernel({ provider: failing, system: 's', history: [] }), error => error.trajectory.at(-1).stopReason === 'error');
});

// ---- providers ----

test('模型适配：Chat Completions 携带工具并解析 tool_calls；工具结果按协议回传', async () => {
  let body;
  const provider = createProvider({ model: { provider: 'deepseek', modelId: 'deepseek-v4', baseUrl: 'https://api.deepseek.com' }, modelKey: 'k' }, async (url, options) => {
    body = JSON.parse(options.body);
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    return json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, reasoning_content: '想', tool_calls: [{ id: 't1', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  });
  const reply = await provider.complete({ system: 'sys', history: [{ role: 'user', content: 'u' }], tools: [echoTool('lookup')] });
  assert.equal(body.tools[0].function.name, 'lookup');
  assert.equal(body.tool_choice, 'auto');
  assert.deepEqual(reply.toolCalls, [{ id: 't1', name: 'lookup', arguments: '{"q":"a"}' }]);
  assert.equal(reply.stopReason, 'tool_use');
  assert.equal(reply.reasoning, '想');
  const messages = chatMessages('sys', [{ role: 'assistant', content: '', reasoning: '想', toolCalls: reply.toolCalls }, { role: 'tool', toolCallId: 't1', content: 'r' }]);
  assert.deepEqual(messages[1], { role: 'assistant', content: null, reasoning_content: '想', tool_calls: [{ id: 't1', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } }] });
  assert.deepEqual(messages[2], { role: 'tool', tool_call_id: 't1', content: 'r' });
  assert.equal(parseChat({ choices: [{ finish_reason: 'length', message: { content: '半' } }] }).stopReason, 'length');
});

test('模型适配：OpenAI Responses 解析 function_call 并回传 function_call_output', () => {
  const reply = parseResponses({ output: [{ type: 'function_call', call_id: 'f1', name: 'lookup', arguments: '{}' }, { type: 'message', content: [{ type: 'output_text', text: '查' }] }] });
  assert.deepEqual(reply.toolCalls, [{ id: 'f1', name: 'lookup', arguments: '{}' }]);
  assert.equal(reply.text, '查');
  assert.deepEqual(responsesInput([{ role: 'assistant', content: '', toolCalls: reply.toolCalls }, { role: 'tool', toolCallId: 'f1', content: 'r' }]), [{ type: 'function_call', call_id: 'f1', name: 'lookup', arguments: '{}' }, { type: 'function_call_output', call_id: 'f1', output: 'r' }]);
  assert.equal(parseResponses({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }).stopReason, 'length');
});

test('模型适配：接口不支持工具时标记 toolsUnsupported；不泄露密钥', async () => {
  const provider = createProvider({ model: { provider: 'compatible', modelId: 'm', baseUrl: 'https://m.example/v1' }, modelKey: 'secret-key' }, async () => json({ error: { message: 'tools is not supported for this model' } }, 400));
  await assert.rejects(provider.complete({ system: 's', history: [], tools: [echoTool('lookup')] }), error => error.toolsUnsupported === true && !error.message.includes('secret-key'));
  assert.throws(() => createProvider({ model: { provider: 'kimi', modelId: 'k', baseUrl: 'https://api.moonshot.cn/v1' } }), /API Key/);
});

// ---- 共作 tools ----

const scope = {
  spaceNames: { team: '产品团队' },
  listMaterials: async () => [{ id: 'd1', name: '示例周报.md', workspaceId: 'team' }, { id: 'd2', name: '客户名单.csv', workspaceId: 'team' }],
  readMaterial: async id => { if (id !== 'd1') throw new Error('所选资料不存在或不属于当前空间'); return { name: '示例周报.md', text: '12 个示例节点' }; },
  memory: { personal: [{ title: '偏好', content: '结论先行' }], team: [{ title: '口径', content: '库存按可售池', inheritedFrom: '公共空间' }] },
  progress: [{ text: '已确认 12 个示例节点', status: 'published' }, { text: '草稿', status: 'draft' }],
  goal: '整理周报'
};

test('共作工具 K0：查资料/读资料/查记忆/查进展只在给定范围内；提议变更只生成待确认项', async () => {
  const { tools, proposals } = createGongzuoTools(scope);
  const byName = name => tools.find(tool => tool.name === name);
  assert.deepEqual(tools.map(tool => tool.name), ['gongzuo_list_materials', 'gongzuo_read_material', 'gongzuo_search_memory', 'gongzuo_get_progress', 'gongzuo_propose_change']);
  assert.match(await byName('gongzuo_list_materials').execute({ query: '周报' }), /d1 · 示例周报\.md · 产品团队/);
  assert.doesNotMatch(await byName('gongzuo_list_materials').execute({ query: '周报' }), /客户名单/);
  assert.match(await byName('gongzuo_read_material').execute({ id: 'd1' }), /12 个示例节点/);
  await assert.rejects(byName('gongzuo_read_material').execute({ id: 'other' }), /不属于当前空间/);
  assert.match(await byName('gongzuo_search_memory').execute({ query: '口径' }), /来自公共空间，只读/);
  const progressText = await byName('gongzuo_get_progress').execute({});
  assert.match(progressText, /已确认 12 个示例节点/);
  assert.doesNotMatch(progressText, /草稿/, '只给已确认进展');
  assert.match(await byName('gongzuo_propose_change').execute({ field: 'owner', value: '王宁', reason: '他负责' }), /不会自动修改/);
  assert.deepEqual(proposals, [{ field: 'owner', label: '负责人', value: '王宁', reason: '他负责', risk: 'approval', status: 'pending' }]);
});

test('共作工具守卫：按次数预算拦截', () => {
  const { tools, guard } = createGongzuoTools(scope);
  const read = tools.find(tool => tool.name === 'gongzuo_read_material');
  for (let i = 0; i < 6; i += 1) assert.equal(guard({ tool: read }), null);
  assert.match(guard({ tool: read }).reason, /次数已达上限/);
  assert.match(guard({ tool: { name: 'shell' } }).reason, /不开放/);
});

// ---- adapters ----

test('适配器注册表：每种模式声明能力；未知模式回到共作内核', () => {
  for (const mode of ['built-in', 'external', 'codebuddy', 'cloudagent', 'workbuddy', 'codex', 'kimi']) assert.ok(ADAPTERS[mode].capabilities.includes('text'), mode);
  assert.ok(ADAPTERS['built-in'].capabilities.includes('tools'));
  assert.ok(ADAPTERS.cloudagent.capabilities.includes('cloud'));
  assert.equal(adapterFor({ agent: { mode: 'unknown' } }).id, 'built-in');
});

test('共作内核经 AgentService：调用共作工具、记录提议、上报步骤，来源标记为共作内核', async () => {
  const replies = [
    { choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id: 'a', function: { name: 'gongzuo_list_materials', arguments: '{}' } }, { id: 'b', function: { name: 'gongzuo_propose_change', arguments: '{"field":"deadline","value":"周五"}' } }] } }] },
    { choices: [{ finish_reason: 'stop', message: { content: '资料里有 示例周报；建议截止时间改到周五，待你确认。' } }] }
  ];
  const requests = [];
  const agent = new AgentService(async (url, options) => { requests.push(JSON.parse(options.body)); return json(replies.shift()); });
  const progress = [];
  const config = { agent: { mode: 'built-in' }, model: { provider: 'compatible', modelId: 'm', baseUrl: 'https://m.example/v1' } };
  const answer = await agent.answer({ id: 'w1', goal: '周报', messages: [{ role: 'user', text: '看看有什么资料' }] }, config, {}, { toolScope: scope, onProgress: update => progress.push(update) });
  assert.equal(answer.source, 'kernel');
  assert.match(answer.text, /周五/);
  assert.equal(answer.proposals[0].label, '截止时间');
  assert.equal(answer.kernel.toolCalls, 2);
  assert.match(requests[0].messages[0].content, /共作内核/);
  assert.equal(requests[1].messages.filter(item => item.role === 'tool').length, 2);
  const last = progress.filter(item => item.execution?.length).at(-1);
  assert.deepEqual(last.execution.map(item => item.status), ['completed', 'completed']);
});

test('共作内核：接口不支持工具时退回纯对话并如实说明', async () => {
  const calls = [];
  const agent = new AgentService(async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return body.tools ? json({ error: { message: 'function calling is not supported' } }, 400) : json({ choices: [{ message: { content: '纯对话回答' } }] });
  });
  const answer = await agent.answer({ id: 'w', messages: [{ role: 'user', text: '你好' }] }, { agent: { mode: 'built-in' }, model: { provider: 'compatible', modelId: 'm', baseUrl: 'https://m.example/v1' } });
  assert.equal(answer.source, 'model');
  assert.match(answer.text, /纯对话回答/);
  assert.match(answer.text, /不支持工具调用/);
  assert.equal(calls.length, 2);
});

// ---- approvals ----

test('审批代理：允许、拒绝、超时、跨工作无效、本轮结束自动拒绝', async () => {
  const timers = [];
  const broker = new ApprovalBroker({ setTimer: (fn, ms) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  const a = broker.open({ taskId: 't1', title: 'npm test' });
  assert.equal(broker.resolve('t2', a.approval.id, 'allow'), false, '其他工作不能替它确认');
  assert.equal(broker.resolve('t1', a.approval.id, 'allow'), true);
  assert.deepEqual(await a.decision, { outcome: 'allow', reason: 'user' });
  const b = broker.open({ taskId: 't1', title: 'rm' });
  timers.at(-1)();
  assert.deepEqual(await b.decision, { outcome: 'reject', reason: 'timeout' });
  assert.equal(broker.resolve('t1', b.approval.id, 'allow'), false, '超时后不能再允许');
  const c = broker.open({ taskId: 't1', title: 'x' });
  assert.equal(broker.list('t1').length, 1);
  broker.cancelTask('t1');
  assert.deepEqual(await c.decision, { outcome: 'reject', reason: 'cancelled' });
  assert.throws(() => broker.resolve('t1', broker.open({ taskId: 't1' }).approval.id, 'maybe'), /无效/);
});

async function runnerSetup(agent) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-harness-'));
  const store = new JsonStore(path.join(directory, 'w.json'), () => ({
    workspaces: [{ id: 'personal', name: '个人空间', type: 'personal' }, { id: 'team', name: '产品团队', type: 'team', members: [] }],
    tasks: []
  }));
  const personal = new JsonStore(path.join(directory, 'p.json'), () => ({ items: [] }));
  const team = new JsonStore(path.join(directory, 't.json'), () => ({ items: [] }));
  await Promise.all([store.initialize(), personal.initialize(), team.initialize()]);
  const documents = [
    { id: 'd-team', name: '团队周报.md', workspaceId: 'team', status: 'active' },
    { id: 'd-personal', name: '我的草稿.md', workspaceId: 'personal', status: 'active' },
    { id: 'd-old', name: '归档.md', workspaceId: 'team', status: 'archived' }
  ];
  const documentService = { list: async () => documents, readForAgent: async (id, spaceIds) => {
    const item = documents.find(document => document.id === id && [].concat(spaceIds).includes(document.workspaceId));
    if (!item) throw new Error('所选资料不存在或不属于当前空间');
    return { id, name: item.name, text: `正文:${item.name}` };
  } };
  const runner = new TaskRunner({ store, settingsService: { getRuntimeConfig: async () => ({ agent: { mode: 'built-in' }, model: { provider: 'compatible', modelId: 'm' } }) }, personalMemoryStore: personal, teamMemoryStore: team, documentService, agent, publish: () => {} });
  const ops = new WorkOperations({ store, taskRunner: runner });
  return { directory, store, runner, ops };
}

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error('等待超时'); await new Promise(resolve => setTimeout(resolve, 10)); }
};

test('工具范围：团队工作不主动列出个人资料，引用过的个人资料仍可读；个人工作可列出', async () => {
  const ctx = await runnerSetup({ isConfigured: () => false });
  try {
    const teamWork = await ctx.ops.create(actors.local(), { workspace: '产品团队', goal: '整理周报', documentIds: ['d-personal'] });
    const prepared = await ctx.runner.prepare(teamWork.id, teamWork.messages[0].id);
    assert.deepEqual((await prepared.toolScope.listMaterials()).map(item => item.id), ['d-team'], '不含个人资料和已归档资料');
    assert.match((await prepared.toolScope.readMaterial('d-personal')).text, /我的草稿/, '本条消息明确引用的个人资料可读');
    const other = await ctx.ops.create(actors.local(), { workspace: '产品团队', goal: '另一项' });
    const plain = await ctx.runner.prepare(other.id, other.messages[0].id);
    await assert.rejects(plain.toolScope.readMaterial('d-personal'), /不属于当前空间/);
    const personalWork = await ctx.ops.create(actors.local(), { workspace: '个人空间', goal: '个人整理' });
    const own = await ctx.runner.prepare(personalWork.id, personalWork.messages[0].id);
    assert.deepEqual((await own.toolScope.listMaterials()).map(item => item.id).sort(), ['d-personal']);
  } finally { await fs.rm(ctx.directory, { recursive: true, force: true }); }
});

test('审批闭环：引擎请求确认 → 工作页显示待确认 → 允许后继续，回复记录本轮确认', async () => {
  const agent = {
    isConfigured: () => true,
    answer: async (task, config, memory, hooks) => {
      const result = await hooks.onPermission({ title: '运行沙箱命令：npm test', kind: 'execute' });
      return { id: 'reply-1', role: 'assistant', text: `命令${result.outcome === 'allow' ? '已执行' : '未执行'}`, createdAt: new Date().toISOString(), source: 'cloudagent' };
    }
  };
  const ctx = await runnerSetup(agent);
  try {
    const work = await ctx.ops.create(actors.local(), { workspace: '产品团队', goal: '跑测试' });
    const pending = await until(async () => (await ctx.store.read()).tasks.find(item => item.id === work.id)?.agentRun?.pendingApproval);
    assert.equal(pending.title, '运行沙箱命令：npm test');
    assert.equal((await ctx.store.read()).tasks[0].agentRun.phase, 'awaiting-approval');
    assert.throws(() => ctx.runner.resolveApproval('other-task', pending.id, 'allow'), /已经结束或不存在/);
    ctx.runner.resolveApproval(work.id, pending.id, 'allow');
    const reply = await until(async () => (await ctx.store.read()).tasks[0].messages.find(item => item.id === 'reply-1'));
    assert.equal(reply.text, '命令已执行');
    assert.deepEqual(reply.approvals.map(item => [item.title, item.outcome]), [['运行沙箱命令：npm test', 'allow']]);
    const run = (await ctx.store.read()).tasks[0].agentRun;
    assert.equal(run.pendingApproval, undefined);
  } finally { await fs.rm(ctx.directory, { recursive: true, force: true }); }
});

test('共作内核：达到上限的说明放在进展块之前，进展块仍可被抽取', async () => {
  const { callKernel } = require('../electron/harness/kernel-adapter.cjs');
  const { extractProgress } = require('../electron/progress-service.cjs');
  const provider = { id: 's', model: 's', complete: async ({ tools }) => (tools.length
    ? { text: '', toolCalls: [{ id: 'x', name: 'gongzuo_get_progress', arguments: '{}' }], stopReason: 'tool_use' }
    : { text: '结论在此\n<进展>[{"类型":"结论","内容":"58 区已确认"}]</进展>', toolCalls: [], stopReason: 'stop' }) };
  const result = await callKernel({}, { messages: [{ role: 'user', text: '问' }], progress: [] }, {}, {}, { providerFactory: () => provider, limits: { maxSteps: 2 } });
  assert.match(result.text, /结论在此\n\n（已达到本轮工具调用上限/);
  const extracted = extractProgress(result.text);
  assert.equal(extracted.found, true);
  assert.match(extracted.text, /已达到本轮工具调用上限/);
  assert.equal(result.kernel.stopReason, 'max_steps');
});
