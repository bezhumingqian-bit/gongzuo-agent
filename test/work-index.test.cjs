const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { classifyTask, displayTask, isCasualPrompt, objectiveFrom, isTestPrompt, isRequest } = require('../demo/work-index.js');
const { createSeed, createDemoSeed } = require('../electron/seed.cjs');
const { createLocalTask } = require('../electron/agent-service.cjs');
const { TaskRunner } = require('../electron/task-runner.cjs');

const user = (text, createdAt = '2026-10-16T09:00:00.000Z', extra = {}) => ({ id: `user-${createdAt}-${text}`, role: 'user', text, createdAt, ...extra });
const greeting = () => ({ id: 'greeting', title: '在吗', goal: '在吗', workspace: '个人空间', messages: [user('在吗')], updatedAt: '2026-10-16T09:00:00.000Z' });
const onboarding = () => createDemoSeed().tasks.find(item => item.id === 'onboarding');

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function setup({ configured = true, handoff = false, answerText = '在的。', documents = [] } = {}) {
  let data = createSeed();
  const store = {
    read: async () => structuredClone(data),
    update: async update => { data = structuredClone(update(structuredClone(data))); return structuredClone(data); }
  };
  const observed = [];
  const agent = {
    isConfigured: () => configured,
    answer: async task => {
      observed.push(task);
      return { id: `answer-${observed.length}`, role: 'assistant', text: answerText, source: 'codex', createdAt: '2026-10-16T10:00:00.000Z' };
    }
  };
  const runner = new TaskRunner({
    store,
    settingsService: { getRuntimeConfig: async () => ({ agent: { mode: handoff ? 'workbuddy' : 'codex' } }) },
    personalMemoryStore: { read: async () => ({ items: [] }) },
    teamMemoryStore: { read: async () => ({ items: [] }) },
    documentService: { list: async () => documents, readForAgent: async id => ({ id, name: '材料.md', text: '用户明确引用的材料' }) },
    agent, publish: () => {}
  });
  const settle = async id => { while (runner.queues.has(id)) await runner.queues.get(id); };
  return { store, runner, observed, settle };
}

test('UMD 浏览器全局与 Node 导出一致，无浏览器依赖', () => {
  const source = fs.readFileSync(path.join(__dirname, '../demo/work-index.js'), 'utf8');
  const browser = {};
  vm.runInNewContext(source, browser);
  assert.deepEqual(Object.keys(browser.GongzuoWorkIndex).sort(), ['classifyTask', 'displayTask', 'isCasualPrompt', 'isRequest', 'isTestPrompt', 'objectiveFrom'].sort());
  assert.equal(browser.GongzuoWorkIndex.displayTask(greeting()).title, '简短问候');
  assert.equal(browser.GongzuoWorkIndex.classifyTask({ goal: '查库存' }), 'work');
});

test('只精确匹配纯问候、应答和能力元信息', () => {
  for (const text of ['在吗', '在吗？', '你好！', ' OK ', '谢谢', '收到', '你用什么模型', '你用的什么模型？', '你使用的是什么模型', '你是什么模型', '你可以做ppt?', '你能不能做PPT吗', '能做PPT吗', '你能做什么']) {
    assert.equal(isCasualPrompt(text), true, text);
    assert.equal(classifyTask({ goal: text, messages: [user(text)] }), 'conversation', text);
  }
  for (const text of ['查库存', '写周报', '做PPT', '帮我做PPT', '帮我开发一个CDC的介绍PPT', '你可以做CDC的介绍PPT吗', '在吗，请查库存', '谢谢，请写周报', '你好页面需要修复', '测试接口', '好的库存表怎么生成']) {
    assert.equal(isCasualPrompt(text), false, text);
    assert.equal(classifyTask({ goal: text, messages: [user(text)] }), 'work', text);
  }
});

test('对话显示有意义标题和最近日期，不重复在吗或助手回复', () => {
  const task = greeting();
  task.messages.push({ role: 'assistant', text: 'Agent 已回复', createdAt: '2026-10-16T10:10:00.000Z' });
  const view = displayTask(task);
  assert.equal(view.kind, 'conversation');
  assert.equal(view.title, '简短问候');
  assert.equal(view.preview, '2026-10-16 · 简短问候');
  assert.equal(view.updatedAt, '2026-10-16T10:10:00.000Z');
  assert.doesNotMatch(view.preview, /在吗|Agent/);
  assert.equal(displayTask({ goal: '你可以做ppt?', messages: [user('你可以做ppt?')] }).title, '模型与能力咨询');
  assert.equal(Array.from({ length: 6 }, greeting).every(task => classifyTask(task) === 'conversation'), true);
});

test('实际CDC明确请求不会被后续通用PPT能力问句或怎么说覆盖',()=>{
  const task={...onboarding(),messages:[user('帮我开发一个CDC的介绍PPT'),user('你能做一个ppt给我吗'),user('怎么卡住了'),user('怎么说')]};
  assert.equal(displayTask(task).title,'开发一个CDC的介绍PPT');
  assert.equal(isCasualPrompt('你现在是用的什么模型'),true);
  assert.equal(isCasualPrompt('那你现在是什么模型？'),true);
  assert.equal(isCasualPrompt('你 · 刚刚那你现在是什么模型？'),true);
});

test('应用现状讨论与随便PPT请求缩成准确主题，不改原句且manual不覆',()=>{
  const app={title:'在吗',goal:'在吗',messages:[user('我们目前是否可用了，你觉得我们这个应用是否需要更新什么内容吗')]};
  assert.equal(displayTask(app).title,'应用可用性与更新建议');
  const ppt={title:'在吗',goal:'在吗',messages:[user('你先帮我随便做一个ppt')]};assert.equal(displayTask(ppt).title,'制作示例 PPT');assert.equal(ppt.title,'在吗');
});

test('正式初始化保留四个空间、active 和成员，任务应用为空；演示数据另存工厂', () => {
  const seed = createSeed();
  const demo = createDemoSeed();
  assert.equal(seed.workspaces.length, 4);
  assert.equal(seed.activeWorkspace, '产品团队');
  assert.deepEqual(seed.workspaces, demo.workspaces);
  assert.deepEqual(seed.workspaces[0].members, [{ id: 'local-user', name: '我', role: 'owner', status: 'active' }]);
  assert.deepEqual(seed.tasks, []);
  assert.deepEqual(seed.apps, []);
  assert.equal(demo.tasks.length, 3);
  assert.equal(demo.apps.length, 2);
  seed.workspaces[0].members[0].name = '新名称';
  assert.equal(createDemoSeed().workspaces[0].members[0].name, '我');
});

test('sample 只认固定 id 加精确旧标题和目标，不能按 id 删除或泛化匹配', () => {
  for (const task of createDemoSeed().tasks) assert.equal(classifyTask(task), 'sample');
  const task = onboarding();
  assert.equal(classifyTask({ ...task, id: 'customer-onboarding' }), 'work');
  assert.equal(classifyTask({ ...task, title: task.title + ' ' }), 'work');
  assert.equal(classifyTask({ ...task, goal: '开发CDC介绍PPT' }), 'work');
  assert.equal(classifyTask({ ...task, title: '客户的真实入职需求' }), 'work');
  assert.equal(classifyTask({ ...task, titleSource: 'manual' }), 'work');
  assert.equal(classifyTask({ ...task, messages: [user('你好')] }), 'work');
  assert.equal(classifyTask({ ...task, messages: [{ role: 'assistant', text: '已做完CDC.pptx' }] }), 'sample');
  assert.equal(classifyTask({ ...task, artifacts: [{ name: '结果.pptx', id: 'saved' }] }), 'work');
  assert.equal(displayTask({ ...task, artifacts: [{ name: '结果.pptx', id: 'saved' }] }).title, '结果.pptx');
  assert.equal(displayTask({ ...task, progress: [{ text: '实际交付已确认', status: 'published' }] }).title, '工作进展');
  assert.equal(classifyTask({ ...task, progress: [{ text: '已核对入职资料', status: 'published' }] }), 'work');
  assert.equal(classifyTask({ ...task, progress: [{ text: '建议核对资料', status: 'draft' }] }), 'sample');
});

test('精确旧 onboarding seed 续写 CDC 时采用最后明确请求，完全不改旧 goal、firstmessage 或空间', () => {
  const task = onboarding();
  task.messages = [user('在吗'), user('帮我开发一个CDC的介绍PPT', '2026-10-16T10:00:00.000Z'),
    { role: 'assistant', text: '我将制作另一份市场分析PPT并已经完成', createdAt: '2026-10-16T10:05:00.000Z' }, user('谢谢', '2026-10-16T10:10:00.000Z')];
  task.access = { owner: 'local-user', shared: false };
  const original = structuredClone(task);
  freeze(task);
  const view = displayTask(task);
  assert.equal(view.kind, 'work');
  assert.equal(view.title, '开发一个CDC的介绍PPT');
  assert.equal(view.originalTitle, '完善新同事入职清单');
  assert.equal(view.derived, true);
  assert.equal(objectiveFrom(task), '开发一个CDC的介绍PPT');
  assert.match(view.preview, /CDC/);
  assert.doesNotMatch(view.preview, /市场分析|已经完成|入职/);
  assert.deepEqual(task, original);
});

test('最后明确请求优先于普通应答，按日期取新请求且派生标题含省略号不超过36字符', () => {
  const task = greeting();
  task.messages = [user('去帮我写CDC介绍', '2026-10-16T10:00:00.000Z'), user('请帮我开发CDC介绍PPT', '2026-10-16T11:00:00.000Z'),
    user('先收到材料', '2026-10-16T11:10:00.000Z'), user('谢谢', '2026-10-16T11:20:00.000Z'), user('帮我查库存', '2026-10-16T09:00:00.000Z')];
  assert.equal(objectiveFrom(task), '开发CDC介绍PPT');
  assert.equal(displayTask(task).title, '开发CDC介绍PPT');
  task.messages.push(user('麻烦你去帮我开发' + 'CDC😀介绍'.repeat(12), '2026-10-16T12:00:00.000Z'));
  assert.equal(Array.from(displayTask(task).title).length, 36);
  assert.equal(displayTask(task).title.endsWith('…'), true);
});

test('manual 标题包括私密 seed 标题不覆盖；其他旧有效目标不同主题也保留', () => {
  const task = { ...onboarding(), titleSource: 'manual', conversationShared: false, messages: [user('帮我开发一个CDC的介绍PPT')] };
  assert.equal(displayTask(task).title, task.title);
  assert.equal(displayTask(task).derived, false);
  const longTitle = '私人手工标题'.repeat(10);
  assert.equal(displayTask({ ...task, title: longTitle }).title, longTitle);
  const existing = { id: 'customer-work', title: '完善新同事入职清单', goal: '完善新同事入职清单', titleSource: 'auto', messages: [user('帮我开发CDC介绍PPT')] };
  assert.equal(displayTask(existing).title, existing.title);
  assert.equal(displayTask({ ...existing, messages: [user('开发CDC功能清单')] }).title, existing.title);
  assert.equal(displayTask({ ...existing, title: 'CDC介绍PPT', goal: 'CDC介绍PPT' }).title, '开发CDC介绍PPT');
});

test('test 只接受明确开头，续写真实非测试请求恢复 work', () => {
  for (const text of ['【联调】检查桥接', '【自动领取联调】在吗', '【预览版验收】连接检查', '【测试】你好', '自动领取联调：检查桥接', '测试：回复收到']) {
    assert.equal(isTestPrompt(text), true, text);
    const task = { title: text, goal: text, messages: [user(text), user('ok')] };
    assert.equal(classifyTask(task), 'test', text);
    task.messages.push(user('请帮我开发一个CDC的介绍PPT', '2026-10-16T11:00:00.000Z'));
    assert.equal(classifyTask(task), 'work', text);
    assert.equal(displayTask(task).title, '开发一个CDC的介绍PPT');
  }
  for (const text of ['写测试报告', '设计测试系统', '客户测试反馈汇总', '测试接口', '整理预览版验收意见']) assert.equal(classifyTask({ goal: text }), 'work', text);
  assert.equal(classifyTask({ title: '【测试】旧项', goal: '帮我开发CDC介绍PPT' }), 'work');
  assert.equal(classifyTask({ title: '【测试】旧项', goal: '【测试】旧项', messages: [user('把库存查一下')] }), 'work');
  assert.equal(displayTask({ ...greeting(), title: '未命名工作', messages: [user('帮我写CDC周报')] }).title, '写CDC周报');
});

test('有真实文件或已确认进展即 work，摘要优先已确认进展和文件，不删历史', () => {
  const task = greeting();
  task.progress = [{ id: 'old', text: '旧结论保留', status: 'published', publishedAt: '2026-10-15T10:00:00.000Z' },
    { id: 'confirmed', text: 'CDC内容已经确认，等待排版', status: 'published', publishedAt: '2026-10-16T11:00:00.000Z' },
    { id: 'draft', text: '未经确认的推测', status: 'draft' }];
  task.messages.push({ role: 'assistant', text: 'Agent 已回复', artifacts: [{ id: 'file-real', name: 'CDC介绍.pptx' }] });
  const original = structuredClone(task);
  freeze(task);
  const view = displayTask(task);
  assert.equal(view.kind, 'work');
  assert.equal(view.title, 'CDC介绍.pptx');
  assert.match(view.preview, /^CDC内容已经确认，等待排版 · 文件：CDC介绍.pptx/);
  assert.doesNotMatch(view.preview, /未经确认|Agent|在吗/);
  assert.equal(view.updatedAt, '2026-10-16T11:00:00.000Z');
  assert.deepEqual(task, original);
  assert.equal(displayTask({ ...greeting(), progress: [{ text: '42/60项已核对', status: 'confirmed' }] }).title, '工作进展');
  assert.equal(displayTask({ ...greeting(), messages: [user('CDC交付材料'), { role: 'assistant', artifacts: [{ name: '材料.pdf' }] }] }).title, 'CDC交付材料');
});

test('助手文字、引用资料、预置步骤和未确认建议不会伪造工作成果', () => {
  const task = greeting();
  task.steps = [{ title: '计划', status: 'done' }];
  task.progress = [{ text: 'Agent 已回复', status: 'published' }, { text: '已生成幻灯片', status: 'draft' }];
  task.messages.push({ role: 'assistant', text: 'CDC.pptx 已完成，已交付', pendingFiles: [{ path: '/tmp/CDC.pptx' }] });
  task.artifacts = [{ name: '样例.pptx', source: 'sample' }, { name: '未生成.pptx', status: 'pending' }];
  assert.equal(classifyTask(task), 'conversation');
  assert.equal(objectiveFrom(task), '');
  assert.doesNotMatch(displayTask(task).preview, /CDC|交付|生成|Agent/);
  assert.equal(classifyTask({ ...task, messages: [user('在吗', undefined, { documentRefs: [{ id: 'ref', name: '资料.md' }] })] }), 'work');
  assert.doesNotMatch(displayTask({ title: 'Agent 已回复', goal: 'Agent 已回复' }).preview, /Agent/);
});

test('无正文及非字符串字段安全处理，HTML 保留原字符串交给主界面转义', () => {
  for (const input of [null, undefined, 1, '', {}, { title: {}, goal: [], messages: 'not-array', artifacts: 42, progress: null }]) {
    assert.equal(typeof displayTask(input).title, 'string');
    assert.equal(typeof displayTask(input).preview, 'string');
  }
  const text = '帮我开发<script>alert(1)</script>介绍页';
  const task = { ...greeting(), messages: [user(text)] };
  assert.equal(displayTask(task).title.includes('<script>'), true);
  assert.equal(displayTask(task).originalTitle, '在吗');
  assert.equal(objectiveFrom(task), text.replace('帮我', ''));
  assert.equal(classifyTask({ channelOnly: true, goal: '通知', messages: [user('通知', undefined, { wecomOutbound: true })] }), 'channel');
});

test('本地任务问候无虚构计划，真实短任务三个步骤均 pending', () => {
  for (const goal of ['在吗', '你好', '你用什么模型', '你可以做ppt?']) {
    const task = createLocalTask({ goal, workspace: '个人空间' });
    assert.equal(task.kind, 'conversation');
    assert.equal(task.titleSource, 'auto');
    assert.deepEqual(task.steps, []);
    assert.equal(task.messages[0].text, goal);
  }
  for (const goal of ['查库存', '写周报', '帮我开发一个CDC的介绍PPT']) {
    const task = createLocalTask({ goal, workspace: '产品团队' });
    assert.equal(task.kind, 'work');
    assert.equal(task.steps.length, 3);
    assert.equal(task.steps.every(step => step.status === 'pending'), true);
  }
  assert.equal(createLocalTask({ goal: '在吗', workspace: '个人空间', hasContext: true }).kind, 'work');
});

test('问候依旧排队执行和保存回复，但不从助手声明提炼虚假成果', async () => {
  const ctx = setup({ answerText: '在的。\n<进展>\n[{"类型":"结论","内容":"Agent 已回复"}]\n</进展>' });
  const task = await ctx.runner.create('在吗', '个人空间');
  await ctx.settle(task.id);
  const saved = (await ctx.store.read()).tasks[0];
  assert.equal(ctx.observed.length, 1);
  assert.equal(saved.agentRun.status, 'done');
  assert.equal(saved.messages[1].replyToId, saved.messages[0].id);
  assert.equal(saved.messages[1].text, '在的。');
  assert.equal(saved.kind, 'conversation');
  assert.deepEqual(saved.steps, []);
  assert.equal((saved.progress || []).length, 0);
  assert.equal(classifyTask(saved), 'conversation');
});

test('只在个人空间本人真实续写时提升持久 kind，不改 goal/title 或公共团队权限', async () => {
  const ctx = setup({ configured: false });
  for (const [workspace, origin, expected] of [['个人空间', null, 'work'], ['产品团队', null, 'conversation'], ['公共空间', null, 'conversation'], ['个人空间', { userId: 'colleague' }, 'conversation']]) {
    const task = await ctx.runner.create('在吗', workspace);
    const spaces = (await ctx.store.read()).workspaces;
    await ctx.runner.append(task.id, '帮我开发一个CDC的介绍PPT', [], [], origin);
    const saved = (await ctx.store.read()).tasks.find(item => item.id === task.id);
    assert.equal(saved.kind, expected);
    assert.equal(saved.goal, '在吗');
    assert.equal(saved.title, '在吗');
    assert.equal(saved.workspace, workspace);
    assert.equal(saved.handedOver, undefined);
    assert.deepEqual((await ctx.store.read()).workspaces, spaces);
    assert.equal(displayTask(saved).title, '开发一个CDC的介绍PPT');
  }
  const task = await ctx.runner.create('在吗', '个人空间');
  await ctx.runner.append(task.id, '谢谢');
  assert.equal((await ctx.store.read()).tasks.find(item => item.id === task.id).kind, 'conversation');
});

test('有引用或协作上下文时不标普通问候；workflow 标题保护仍然生效', async () => {
  const ctx = setup({ configured: false, documents: [{ id: 'ref', name: '材料.md', workspaceId: 'personal', status: 'active' }] });
  const task = await ctx.runner.create('在吗', '个人空间', ['ref']);
  assert.equal(task.kind, 'work');
  assert.equal(task.steps.every(step => step.status === 'pending'), true);
  const workflow = await ctx.runner.create('写周报', '产品团队', [], null, { title: '人工指定汇报标题', workflow: { type: 'summary' } });
  assert.equal(workflow.titleSource, 'manual');
  assert.equal(displayTask(workflow).title, '人工指定汇报标题');
});

test('问候保持 WorkBuddy MCP handoff 队列，不阻断原 Agent 体系', async () => {
  const ctx = setup({ handoff: true });
  const task = await ctx.runner.create('在吗', '个人空间');
  await ctx.settle(task.id);
  const handoffs = await ctx.runner.listHandoffs();
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].taskId, task.id);
  const claimed = await ctx.runner.claimHandoff(task.id);
  assert.equal(claimed.triggerId, task.messages[0].id);
  await ctx.runner.submitHandoffReply(task.id, claimed.triggerId, '在的，请说。');
  const saved = (await ctx.store.read()).tasks[0];
  assert.equal(saved.kind, 'conversation');
  assert.equal(saved.agentRun.status, 'done');
  assert.deepEqual(saved.steps, []);
  assert.equal(saved.messages.at(-1).text, '在的，请说。');
  assert.equal(ctx.observed.length, 0);
});

test('请求辅助导出对短真实任务有效，对纯咨询和显式 test 无效', () => {
  assert.equal(isRequest('查库存'), true);
  assert.equal(isRequest('写周报'), true);
  assert.equal(isRequest('去帮我开发CDC介绍PPT'), true);
  assert.equal(isRequest('你可以做ppt?'), false);
  assert.equal(isRequest('【测试】在吗'), false);
});
