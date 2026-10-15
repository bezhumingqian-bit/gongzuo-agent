const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../electron/store.cjs');
const { TaskRunner } = require('../electron/task-runner.cjs');
const { AgentService } = require('../electron/agent-service.cjs');
const { WorkBuddyBridge, tokensMatch, socketPathFor } = require('../electron/workbuddy-bridge.cjs');
const { executeTool, callBridge, loadBridge } = require('../integrations/workbuddy/gongzuo-mcp.cjs');

async function setup({ runtime = { agent: { mode: 'workbuddy' } }, documents = [] } = {}) {
  // Short tmp path keeps the Unix socket under the macOS 104-byte limit.
  const directory = await fs.mkdtemp(path.join('/tmp', 'gz-br-'));
  const store = new JsonStore(path.join(directory, 'workspace.json'), () => ({
    activeWorkspace: '产品团队', workspaces: [{ id: 'product', name: '产品团队' }, { id: 'ops', name: '运营团队' }], tasks: []
  }));
  const personalMemoryStore = new JsonStore(path.join(directory, 'personal.json'), () => ({ items: [] }));
  const teamMemoryStore = new JsonStore(path.join(directory, 'team.json'), () => ({ items: [] }));
  await Promise.all([store.initialize(), personalMemoryStore.initialize(), teamMemoryStore.initialize()]);
  const documentService = {
    list: async () => documents,
    readForAgent: async id => ({ name: documents.find(item => item.id === id).name, text: '资料正文：季度目标 120 万', truncated: false })
  };
  const settingsService = { getRuntimeConfig: async () => runtime };
  const runner = new TaskRunner({ store, settingsService, personalMemoryStore, teamMemoryStore, documentService, agent: new AgentService(), publish: () => {} });
  const bridge = new WorkBuddyBridge({ userDataDir: directory, store, taskRunner: runner, version: '0.1.0-test' });
  await bridge.start();
  const info = loadBridge({ GONGZUO_BRIDGE_FILE: bridge.infoPath });
  const call = (method, route, body) => callBridge(method, route, body, info);
  const tool = (name, args) => executeTool(name, args, call);
  const cleanup = async () => { await bridge.stop(); await fs.rm(directory, { recursive: true, force: true }); };
  return { directory, store, runner, bridge, info, call, tool, cleanup };
}

test('没有 OAuth 令牌时，WorkBuddy 工作进入交接队列，经 MCP 领取并回填', async () => {
  const ctx = await setup({ documents: [{ id: 'doc-1', name: '目标.md', workspaceId: 'product', status: 'active' }] });
  try {
    const created = await ctx.runner.create('整理本周进展', '产品团队', ['doc-1']);
    await ctx.runner.queues.get(created.id);
    let task = (await ctx.store.read()).tasks[0];
    assert.equal(task.agentRun.status, 'awaiting-workbuddy');
    assert.equal(task.messages.length, 1, '交接时不会在进程内生成回复');

    assert.match(await ctx.tool('gongzuo_connection_test', {}), /连接成功.*等待 WorkBuddy 处理的工作：1 项/s);
    assert.match(await ctx.tool('gongzuo_list_pending_work', {}), new RegExp(created.id));

    const claimed = await ctx.tool('gongzuo_claim_work', { taskId: created.id });
    assert.match(claimed, /整理本周进展/);
    assert.match(claimed, /资料正文：季度目标 120 万/, '引用资料正文随交接提供');
    assert.match(claimed, new RegExp(`triggerId: ${task.agentRun.triggerId}`));
    assert.ok((await ctx.store.read()).tasks[0].agentRun.claimedAt);

    await assert.rejects(ctx.tool('gongzuo_submit_reply', { taskId: created.id, triggerId: 'wrong-trigger', text: '答复' }), /不是最新的待处理消息/);
    assert.match(await ctx.tool('gongzuo_submit_reply', { taskId: created.id, triggerId: task.agentRun.triggerId, text: '本周完成 3 项。' }), /已写回共作/);
    task = (await ctx.store.read()).tasks[0];
    assert.equal(task.agentRun.status, 'done');
    assert.deepEqual(task.messages.at(-1).text, '本周完成 3 项。');
    assert.equal(task.messages.at(-1).source, 'workbuddy');
    assert.equal(task.messages.at(-1).replyToId, task.agentRun.triggerId);
    await assert.rejects(ctx.tool('gongzuo_submit_reply', { taskId: created.id, triggerId: task.agentRun.triggerId, text: '重复' }), /没有等待 WorkBuddy 回复/);
    assert.match(await ctx.tool('gongzuo_list_pending_work', {}), /没有等待/);
  } finally { await ctx.cleanup(); }
});

test('追加消息会把交接更新为最新一条；企微来源的回复转回企微', async () => {
  const ctx = await setup();
  try {
    const pushed = [];
    ctx.runner.onAgentAnswer = async event => { pushed.push(event); };
    const origin = { userId: 'zhangsan', chatId: 'zhangsan', msgId: 'm-1', chatType: 'single' };
    const created = await ctx.runner.create('核对库存', '产品团队', [], origin);
    await ctx.runner.queues.get(created.id);
    const first = (await ctx.store.read()).tasks[0].agentRun.triggerId;
    const next = await ctx.runner.append(created.id, '再补充风险', [], [], origin);
    await ctx.runner.queues.get(created.id);
    const run = (await ctx.store.read()).tasks[0].agentRun;
    assert.equal(run.triggerId, next.id);
    const claimed = await ctx.tool('gongzuo_claim_work', { taskId: created.id });
    assert.match(claimed, /核对库存[\s\S]*再补充风险/, '未回复的前序消息一并交给 WorkBuddy');
    await assert.rejects(ctx.tool('gongzuo_submit_reply', { taskId: created.id, triggerId: first, text: '旧' }), /不是最新/);
    await ctx.tool('gongzuo_submit_reply', { taskId: created.id, triggerId: next.id, text: '库存正常' });
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].origin.userId, 'zhangsan');
  } finally { await ctx.cleanup(); }
});

test('列表、详情与新建工作；切换 Agent 会撤回交接并可重试', async () => {
  const ctx = await setup();
  try {
    const created = await ctx.tool('gongzuo_create_work', { goal: '准备周会材料', workspace: '运营团队' });
    const taskId = /taskId: (\S+)/.exec(created)[1];
    await ctx.runner.queues.get(taskId);
    assert.match(await ctx.tool('gongzuo_list_works', { workspace: '运营团队' }), /准备周会材料.*等待 WorkBuddy/);
    assert.match(await ctx.tool('gongzuo_get_work', { taskId }), /目标：准备周会材料/);
    await assert.rejects(ctx.tool('gongzuo_create_work', { goal: 'x', workspace: '不存在' }), /工作空间不存在/);
    await ctx.runner.setAgent(taskId, 'codex');
    const task = (await ctx.store.read()).tasks.find(item => item.id === taskId);
    assert.equal(task.agentRun.status, 'interrupted');
    assert.match(await ctx.tool('gongzuo_list_pending_work', {}), /没有等待/);
  } finally { await ctx.cleanup(); }
});

test('有 OAuth 令牌时仍走开放平台，不进入交接队列', async () => {
  const ctx = await setup({ runtime: { agent: { mode: 'workbuddy' }, workbuddyAccessToken: 'token' } });
  try {
    ctx.runner.agent = { isConfigured: () => true, answer: async () => ({ role: 'assistant', text: '开放平台回复', source: 'workbuddy', createdAt: new Date().toISOString() }) };
    const created = await ctx.runner.create('测试', '产品团队');
    await ctx.runner.queues.get(created.id);
    const task = (await ctx.store.read()).tasks[0];
    assert.equal(task.agentRun.status, 'done');
    assert.equal(task.messages.at(-1).text, '开放平台回复');
  } finally { await ctx.cleanup(); }
});

test('桥接拒绝错误令牌，文件与套接字仅当前用户可读写，停止后清理', async () => {
  const ctx = await setup();
  try {
    await assert.rejects(callBridge('GET', '/v1/status', undefined, { ...ctx.info, token: 'x'.repeat(43) }), /令牌无效/);
    assert.equal((await fs.stat(ctx.bridge.infoPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(ctx.bridge.socketPath)).mode & 0o777, 0o600);
    assert.equal(tokensMatch('abc'.repeat(10), `Bearer ${'abc'.repeat(10)}`), true);
    assert.equal(tokensMatch('abc'.repeat(10), 'Bearer short'), false);
    assert.ok(socketPathFor('/x'.repeat(80)).startsWith(os.tmpdir()), '过长路径回退到临时目录');
    await ctx.bridge.stop();
    await assert.rejects(fs.access(ctx.bridge.infoPath));
    await assert.rejects(ctx.tool('gongzuo_connection_test', {}), /没有在运行/);
  } finally { await ctx.cleanup(); }
});

test('值守：等待接口在新工作出现时立即返回，超时返回暂无；已领取的不再返回', async () => {
  const ctx = await setup();
  try {
    assert.match(await ctx.tool('gongzuo_wait_for_work', { timeoutSeconds: 1 }), /暂无新工作/);
    const started = Date.now();
    const waiting = ctx.tool('gongzuo_wait_for_work', { timeoutSeconds: 10 });
    setTimeout(() => { ctx.runner.create('值守测试', '产品团队'); }, 300);
    const result = await waiting;
    assert.match(result, /值守测试/);
    assert.ok(Date.now() - started < 5000, '新工作出现后应尽快返回');
    const taskId = /taskId: (\S+)/.exec(result)[1];
    await ctx.tool('gongzuo_claim_work', { taskId });
    assert.match(await ctx.tool('gongzuo_wait_for_work', { timeoutSeconds: 1 }), /暂无新工作/, '已领取的工作不重复派发');
  } finally { await ctx.cleanup(); }
});

test('回复可附带本机文件：校验格式与存在性，存入该工作所属空间资料', async () => {
  const uploads = [];
  const ctx = await setup();
  ctx.runner.documentService.upload = async (workspaceId, paths) => { uploads.push({ workspaceId, paths }); return paths.map((file, index) => ({ id: `doc-${index}`, name: path.basename(file) })); };
  try {
    const file = path.join(ctx.directory, '周报.md');
    await fs.writeFile(file, '# 周报');
    const created = await ctx.runner.create('写周报', '产品团队');
    await ctx.runner.queues.get(created.id);
    const triggerId = (await ctx.store.read()).tasks[0].agentRun.triggerId;
    await assert.rejects(ctx.tool('gongzuo_submit_reply', { taskId: created.id, triggerId, text: '见附件', files: ['relative.md'] }), /绝对路径/);
    await assert.rejects(ctx.tool('gongzuo_submit_reply', { taskId: created.id, triggerId, text: '见附件', files: [path.join(ctx.directory, 'x.exe')] }), /不支持的文件格式/);
    await assert.rejects(ctx.tool('gongzuo_submit_reply', { taskId: created.id, triggerId, text: '见附件', files: [path.join(ctx.directory, '没有.md')] }), /文件不存在/);
    assert.match(await ctx.tool('gongzuo_submit_reply', { taskId: created.id, triggerId, text: '见附件', files: [file] }), /1 个文件已存入空间资料：周报\.md/);
    assert.deepEqual(uploads, [{ workspaceId: 'product', paths: [file] }]);
    const reply = (await ctx.store.read()).tasks[0].messages.at(-1);
    assert.deepEqual(reply.artifacts, [{ id: 'doc-0', name: '周报.md' }]);
    assert.equal(reply.pendingFiles, undefined);
    await fs.access(file);
  } finally { await ctx.cleanup(); }
});

test('查看工作：待处理消息来自同事时只返回同事自己的消息和已确认进展；负责人共享后返回完整对话', async () => {
  const ctx = await setup();
  try {
    const created = await ctx.runner.create('福州迁移清单', '产品团队');
    await ctx.runner.queues.get(created.id);
    const first = (await ctx.store.read()).tasks[0];
    await ctx.runner.submitHandoffReply(created.id, first.agentRun.triggerId, '负责人私下：3 台可能有问题');
    await ctx.store.update(draft => { draft.tasks[0].progress = [{ id: 'p', text: '42/60 台已核对', status: 'published' }, { id: 'd', text: '草稿', status: 'draft' }]; return draft; });
    await ctx.runner.append(created.id, '进度怎么样', [], [], { userId: 'bob' });
    await ctx.runner.queues.get(created.id);
    let view = await ctx.call('GET', `/v1/works/${created.id}`);
    assert.equal(view.conversationScope, 'colleague');
    assert.deepEqual(view.confirmedProgress, ['42/60 台已核对']);
    assert.deepEqual(view.messages.map(item => item.text), ['进度怎么样']);
    assert.doesNotMatch(JSON.stringify(view), /私下|草稿/);
    const shown = await ctx.tool('gongzuo_get_work', { taskId: created.id });
    assert.match(shown, /负责人的过程对话未共享[\s\S]*42\/60 台已核对[\s\S]*同事本人的消息/);
    assert.doesNotMatch(shown, /私下/);
    await ctx.store.update(draft => { draft.tasks[0].conversationShared = true; return draft; });
    view = await ctx.call('GET', `/v1/works/${created.id}`);
    assert.equal(view.conversationScope, undefined);
    assert.match(JSON.stringify(view.messages), /私下/);
  } finally { await ctx.cleanup(); }
});
