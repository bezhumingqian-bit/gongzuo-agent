const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../electron/store.cjs');
const { TaskRunner } = require('../electron/task-runner.cjs');
const { WecomDelivery } = require('../electron/wecom-service.cjs');

async function setup(agent, documentService = { list: async () => [], readForAgent: async () => { throw new Error('unexpected'); } }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-runner-test-'));
  const store = new JsonStore(path.join(directory, 'workspace.json'), () => ({ workspaces: [{ id: 'product', name: '产品团队' }], tasks: [] }));
  const personalMemoryStore = new JsonStore(path.join(directory, 'personal.json'), () => ({ items: [] }));
  const teamMemoryStore = new JsonStore(path.join(directory, 'team.json'), () => ({ items: [] }));
  await Promise.all([store.initialize(), personalMemoryStore.initialize(), teamMemoryStore.initialize()]);
  const settingsService = { getRuntimeConfig: async () => ({ agent: { mode: 'codex' } }) };
  const runner = new TaskRunner({ store, settingsService, personalMemoryStore, teamMemoryStore, documentService, agent, publish: () => {} });
  return { directory, store, runner };
}

test('任务先持久化，再异步等待 Agent；同一工作的消息按顺序委派', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const observed = [];
  const agent = {
    isConfigured: () => true,
    answer: async (task, config) => {
      observed.push({ messages: task.messages.map(item => item.text), mode: config.agent.mode, session: task.agentSessionId });
      if (observed.length === 1) await gate;
      return { role: 'assistant', text: `回复 ${observed.length}`, source: 'codex', agentSessionId: 'session-1', createdAt: new Date().toISOString() };
    }
  };
  const { directory, store, runner } = await setup(agent);
  try {
    const created = await runner.create('整理进展', '产品团队');
    assert.equal((await store.read()).tasks[0].messages.length, 1);
    const next = await runner.append(created.id, '补充风险');
    assert.equal(next.text, '补充风险');
    release();
    await runner.queues.get(created.id);
    const final = (await store.read()).tasks[0];
    assert.deepEqual(observed[0].messages, ['整理进展']);
    assert.deepEqual(observed[1].messages, ['整理进展', '回复 1', '补充风险']);
    assert.equal(observed[1].session, 'session-1');
    assert.equal(final.agentRun.status, 'done');
    assert.equal(final.agentSessionId, 'session-1');
    assert.equal(final.messages.filter(item => item.role === 'assistant').length, 2);
  } finally { release(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('中断的工作会标记可重试，并在重试时保留原 Agent 类型', async () => {
  const agent = {
    isConfigured: () => true,
    answer: async () => ({ role: 'assistant', text: '已恢复', source: 'codex', createdAt: new Date().toISOString() })
  };
  const { directory, store, runner } = await setup(agent);
  try {
    const created = await runner.create('检查项目', '产品团队');
    await runner.queues.get(created.id);
    await store.update(data => { data.tasks[0].agentRun.status = 'running'; return data; });
    await runner.markInterrupted();
    assert.equal((await store.read()).tasks[0].agentRun.status, 'interrupted');
    await runner.retry(created.id);
    await runner.queues.get(created.id);
    assert.equal((await store.read()).tasks[0].agentRun.status, 'done');
    assert.equal((await store.read()).tasks[0].agentMode, 'codex');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('单项工作切换 Agent 时清除旧会话，不改变其他工作', async () => {
  const agent = { isConfigured: () => false, answer: async () => null };
  const { directory, store, runner } = await setup(agent);
  try {
    const first = await runner.create('工作一', '产品团队');
    const second = await runner.create('工作二', '产品团队');
    await store.update(data => { data.tasks.find(item => item.id === first.id).agentSessionId = 'old-session'; return data; });
    await runner.setAgent(first.id, 'kimi');
    const data = await store.read();
    assert.equal(data.tasks.find(item => item.id === first.id).agentMode, 'kimi');
    assert.equal(data.tasks.find(item => item.id === first.id).agentSessionId, null);
    assert.equal(data.tasks.find(item => item.id === second.id).agentMode, 'codex');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('切换到可用 Agent 后可重试最近一条未回复消息', async () => {
  const received = [];
  const agent = {
    isConfigured: config => config.agent.mode === 'kimi',
    answer: async task => {
      received.push(task.messages.at(-1).text);
      return { role: 'assistant', text: '已收到', source: 'kimi', createdAt: new Date().toISOString() };
    }
  };
  const { directory, store, runner } = await setup(agent);
  try {
    const task = await runner.create('原问题', '产品团队');
    await runner.append(task.id, 'hello');
    await assert.rejects(() => runner.retry(task.id), /尚未配置/);
    await runner.setAgent(task.id, 'kimi');
    assert.equal((await store.read()).tasks[0].agentRun.status, 'not-configured');
    await runner.retry(task.id);
    await runner.queues.get(task.id);
    const current = (await store.read()).tasks[0];
    assert.deepEqual(received, ['hello']);
    assert.equal(current.agentRun.status, 'done');
    assert.equal(current.messages.at(-1).text, '已收到');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('只有企微相关工作会把收发状态摘要交给 Agent', async () => {
  const contexts = [];
  const agent = {
    isConfigured: () => true,
    answer: async (_task, _config, memory) => {
      contexts.push(memory.channelStatus);
      return { role: 'assistant', text: '已检查', source: 'codex', createdAt: new Date().toISOString() };
    }
  };
  const { directory, store, runner } = await setup(agent);
  try {
    await store.update(data => { data.wecomEvents = [{ at: '2026-09-28T10:05:02.231Z', chatType: 'single', userId: 'private-user', msgId: 'private-message' }]; data.inboundMessages = [{ channel: 'wecom', senderId: 'private-user', text: 'private-body', receivedAt: '2026-09-28T10:05:02.231Z' }]; return data; });
    const wecomTask = await runner.create('企微消息到了吗', '产品团队');
    await runner.queues.get(wecomTask.id);
    const normalTask = await runner.create('整理项目计划', '产品团队');
    await runner.queues.get(normalTask.id);
    assert.deepEqual(contexts[0]?.recentRobotCallback, { at: '2026-09-28T10:05:02.231Z', chatType: 'single' });
    assert.deepEqual(contexts[0]?.inbox, { savedCount: 1, latestAt: '2026-09-28T10:05:02.231Z' });
    assert.equal(JSON.stringify(contexts[0]).includes('private-user'), false);
    assert.equal(JSON.stringify(contexts[0]).includes('private-body'), false);
    assert.equal(contexts[1], undefined);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('用户明确询问企微来信时临时交给 Agent，工作正文不保存收件副本', async () => {
  const snapshots = [];
  const agent = { isConfigured: () => true, answer: async (task, _config, memory) => {
    snapshots.push({ text: task.messages.at(-1).text, shared: memory.channelStatus?.inboxSharedForThisRequest });
    return { role: 'assistant', text: '已汇总', source: 'codex', createdAt: new Date().toISOString() };
  } };
  const { directory, store, runner } = await setup(agent);
  try {
    await store.update(data => { data.inboundMessages = [
      { channel: 'wecom', id: 'wecom:one', text: '第一条具体消息', senderId: 'colleague', receivedAt: '2026-10-09T01:00:00Z' }
    ]; return data; });
    const task = await runner.create('整理项目', '产品团队');
    await runner.queues.get(task.id);
    await runner.append(task.id, '把企微收到的消息内容列出来');
    await runner.queues.get(task.id);
    assert.equal(snapshots[0].shared, undefined);
    assert.doesNotMatch(snapshots[0].text, /第一条具体消息/);
    assert.equal(snapshots[1].shared, true);
    assert.match(snapshots[1].text, /第一条具体消息/);
    const saved = (await store.read()).tasks[0];
    assert.equal(saved.messages.at(-2).text, '把企微收到的消息内容列出来');
    assert.equal(saved.messages.some(message => message.role === 'user' && message.text.includes('第一条具体消息')), false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('直接发企微只记录与投递消息，不触发 Agent；后续工作提问不把通知当指令', async () => {
  const prompts = [];
  const sent = [];
  const agent = { isConfigured: () => true, answer: async task => {
    prompts.push(task.messages.map(item => item.text));
    return { role: 'assistant', text: 'Agent 已回复', source: 'codex', createdAt: new Date().toISOString() };
  } };
  const { directory, store, runner } = await setup(agent);
  const delivery = new WecomDelivery({ store, settingsService: runner.settingsService, publish: () => {}, send: async (_config, userId, text) => {
    sent.push({ userId, text });
    return { externalMessageId: 'wecom-test-1', channel: 'bot' };
  } });
  try {
    const initial = await runner.recordOutbound('手动阀塑料袋', '产品团队');
    const initialDelivery = await delivery.sendTaskMessage(initial.taskId, initial.id, 'colleague');
    assert.equal(initialDelivery.status, 'sent');
    assert.deepEqual(sent, [{ userId: 'colleague', text: '手动阀塑料袋' }]);
    assert.deepEqual(prompts, []);
    const task = (await store.read()).tasks[0];
    assert.equal(task.agentRun.status, 'skipped');
    assert.equal(task.messages[0].wecomOutbound, true);
    const second = await runner.recordOutbound('再发一条通知', '产品团队');
    assert.equal(second.taskId, task.id);
    assert.equal((await store.read()).tasks.length, 1);
    await delivery.sendTaskMessage(task.id, second.id, 'colleague');
    assert.deepEqual(prompts, []);
    await runner.append(task.id, '请帮我整理下一步');
    await runner.queues.get(task.id);
    assert.deepEqual(prompts, [['请帮我整理下一步']]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('企微同事无法通过机器人询问读取本机的收件箱', async () => {
  let observed;
  const agent = { isConfigured: () => true, answer: async task => {
    observed = task.messages.at(-1).text;
    return { role: 'assistant', text: '无权读取', source: 'codex', createdAt: new Date().toISOString() };
  } };
  const { directory, store, runner } = await setup(agent);
  try {
    await store.update(data => { data.inboundMessages = [{ channel: 'wecom', id: 'wecom:private', text: '别人的来信', senderId: 'private' }]; return data; });
    const task = await runner.create('列出企微消息原文', '产品团队', [], { userId: 'colleague', chatId: 'colleague', msgId: 'msg-2' });
    await runner.queues.get(task.id);
    assert.doesNotMatch(observed, /别人的来信/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('只把当前空间主动选择的资料正文交给 Agent', async () => {
  let sent;
  const agent = { isConfigured: () => true, answer: async task => {
    sent = task.messages[0].text;
    return { role: 'assistant', text: '已参考资料', source: 'codex', createdAt: new Date().toISOString() };
  } };
  const documents = {
    list: async () => [
      { id: 'doc-product', workspaceId: 'product', name: '流程.md', status: 'active' },
      { id: 'doc-other', workspaceId: 'other', name: '秘密.md', status: 'active' }
    ],
    readForAgent: async id => ({ id, name: '流程.md', text: '确认负责人后发布', truncated: false })
  };
  const { directory, store, runner } = await setup(agent, documents);
  try {
    await assert.rejects(() => runner.create('整理流程', '产品团队', ['doc-other']), /当前空间/);
    const created = await runner.create('整理流程', '产品团队', ['doc-product']);
    await runner.queues.get(created.id);
    assert.match(sent, /确认负责人后发布/);
    assert.equal((await store.read()).tasks[0].messages[0].text, '整理流程');
    assert.deepEqual((await store.read()).tasks[0].messages[0].documentRefs, [{ id: 'doc-product', name: '流程.md' }]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('资料提取失败会保留工作并给出可重试的原因', async () => {
  let called = false;
  const agent = { isConfigured: () => true, answer: async () => { called = true; return null; } };
  const documents = {
    list: async () => [{ id: 'scan', workspaceId: 'product', name: '扫描件.pdf', status: 'active' }],
    readForAgent: async () => { throw new Error('扫描件.pdf 没有可读取的文字；扫描件需要先做 OCR'); }
  };
  const { directory, store, runner } = await setup(agent, documents);
  try {
    const created = await runner.create('整理扫描件', '产品团队', ['scan']);
    await runner.queues.get(created.id);
    const task = (await store.read()).tasks[0];
    assert.equal(task.agentRun.status, 'failed');
    assert.match(task.agentRun.message, /OCR/);
    assert.equal(called, false);
    assert.equal(task.messages[0].text, '整理扫描件');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('企微同事发起的工作不会带入本机用户的个人记忆', async () => {
  let observed;
  const agent = { isConfigured: () => true, answer: async (_task, _config, memory) => {
    observed = memory;
    return { role: 'assistant', text: '已处理', source: 'codex', createdAt: new Date().toISOString() };
  } };
  const { directory, runner } = await setup(agent);
  try {
    await runner.personalMemoryStore.update(data => { data.items = [{ id: 'personal-1', scope: 'personal', ownerId: 'local-user', status: 'active', content: '仅个人可见' }]; return data; });
    await runner.teamMemoryStore.update(data => { data.items = [{ id: 'team-1', scope: 'team', workspaceId: 'product', status: 'active', content: '团队约定' }]; return data; });
    const task = await runner.create('整理团队进展', '产品团队', [], { userId: 'colleague_1', chatId: 'colleague_1', msgId: 'msg-1' });
    await runner.queues.get(task.id);
    assert.deepEqual(observed.personal, []);
    assert.equal(observed.team.length, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('摘要规则按指定 Agent 执行，保留来源并等待人工确认', async () => {
  let mode;
  const agent = {
    isConfigured: () => true,
    answer: async (_task, config) => {
      mode = config.agent.mode;
      return { role: 'assistant', text: '建议确认项目进展', source: 'workbuddy', createdAt: new Date().toISOString() };
    }
  };
  const { directory, store, runner } = await setup(agent);
  try {
    let pushedToWecom = false;
    runner.onAgentAnswer = async () => { pushedToWecom = true; };
    const origin = { userId: 'dayuan_1', chatId: 'group-1', msgId: 'msg-1' };
    const created = await runner.create('分析企微日报', '产品团队', [], origin, {
      agentMode: 'workbuddy',
      title: '审核企微摘要 · 产品团队',
      workflow: { type: 'wecom-summary', sourceMsgId: 'msg-1' }
    });
    await runner.queues.get(created.id);
    const task = (await store.read()).tasks[0];
    assert.equal(mode, 'workbuddy');
    assert.equal(task.agentMode, 'workbuddy');
    assert.equal(task.status, 'review');
    assert.equal(task.needsMe, true);
    assert.deepEqual(task.messages[0].wecomOrigin, origin);
    assert.equal(task.workflow.sourceMsgId, 'msg-1');
    assert.equal(pushedToWecom, false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
