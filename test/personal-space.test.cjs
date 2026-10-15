const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../electron/store.cjs');
const { TaskRunner } = require('../electron/task-runner.cjs');
const { DocumentService } = require('../electron/document-service.cjs');
const { WorkOperations } = require('../electron/contracts/work-operations.cjs');
const { actors, authorize } = require('../electron/contracts/policy.cjs');
const { conversationInput } = require('../electron/connection-service.cjs');
const { ensurePersonalWorkspace, personalWorkspace, linkWecomProjectMember, requestToJoin } = require('../electron/workspace-service.cjs');
const { createSeed } = require('../electron/seed.cjs');

const PROGRESS = '\n<进展>\n[{"类型":"结论","内容":"42/60 台已核对"}]\n</进展>';

async function setup({ privacy, mode = 'codex' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-personal-'));
  const store = new JsonStore(path.join(directory, 'w.json'), () => ({
    workspaces: [
      { id: 'team', name: '产品团队', type: 'team', members: [{ id: 'm-alice', wecomUserId: 'alice', role: 'editor', status: 'wecom' }] },
      { id: 'proj', name: '福州下线', type: 'project', parentWorkspaceId: 'team', createdBy: 'local-user', members: [{ id: 'local-user', role: 'owner', status: 'active' }, { id: 'm-bob', wecomUserId: 'bob', role: 'editor', status: 'wecom' }] },
      { id: 'public', name: '公共空间', type: 'public', members: [] }
    ],
    tasks: []
  }));
  const personalMemoryStore = new JsonStore(path.join(directory, 'p.json'), () => ({ items: [
    { id: 'pm-private', scope: 'personal', ownerId: 'local-user', status: 'active', title: '客户私下说', content: '客户A预算可能砍半' },
    { id: 'pm-portable', scope: 'personal', ownerId: 'local-user', status: 'active', portable: true, title: '写作偏好', content: '结论先行' }
  ] }));
  const teamMemoryStore = new JsonStore(path.join(directory, 't.json'), () => ({ items: [
    { id: 'tm-team', scope: 'team', workspaceId: 'team', status: 'active', title: '团队口径', content: '对外只说已上线区域' },
    { id: 'tm-proj', scope: 'team', workspaceId: 'proj', status: 'active', title: '项目背景', content: '福州一区已裁撤' },
    ...Array.from({ length: 5 }, (_, index) => ({ id: `tm-pub-${index}`, scope: 'team', workspaceId: 'public', status: 'active', title: `规范${index}`, content: '公共规范' }))
  ] }));
  await Promise.all([store.initialize(), personalMemoryStore.initialize(), teamMemoryStore.initialize()]);
  await store.update(data => { ensurePersonalWorkspace(data); return data; });
  const documentService = new DocumentService(path.join(directory, 'documents.json'), path.join(directory, 'documents'));
  await documentService.initialize();
  const seen = [];
  let reply = '好的';
  const agent = {
    isConfigured: () => true,
    answer: async (snapshot, config, memory) => {
      seen.push({ snapshot, memory, input: conversationInput(snapshot.messages, memory) });
      return { id: `a-${seen.length}`, role: 'assistant', text: reply, source: 'codex', createdAt: new Date().toISOString(), agentSessionId: `session-${seen.length}` };
    }
  };
  const settingsService = { getRuntimeConfig: async () => ({ agent: { mode }, model: {}, ...(privacy ? { privacy } : {}) }) };
  const runner = new TaskRunner({ store, settingsService, personalMemoryStore, teamMemoryStore, documentService, agent, publish: () => {} });
  const ops = new WorkOperations({ store, taskRunner: runner });
  const produce = async name => { const file = path.join(directory, name); await fs.writeFile(file, `# ${name}`); return file; };
  const settle = async id => { while (runner.queues.has(id)) await runner.queues.get(id); };
  const task = async id => (await store.read()).tasks.find(item => item.id === id);
  return { directory, store, runner, ops, documentService, produce, seen, settle, task, setReply: text => { reply = text; } };
}

const cleanup = ctx => fs.rm(ctx.directory, { recursive: true, force: true });

test('个人空间：首次启动与老数据都有且只有一个，排在最前；同名时改名不覆盖', () => {
  const seed = createSeed();
  assert.equal(seed.workspaces[0].type, 'personal');
  assert.equal(ensurePersonalWorkspace(seed), false);
  const legacy = { workspaces: [{ id: 'product', name: '产品团队', type: 'team', members: [] }, { id: 'x', name: '个人空间', type: 'project', members: [] }] };
  assert.equal(ensurePersonalWorkspace(legacy), true);
  assert.equal(ensurePersonalWorkspace(legacy), false);
  assert.equal(legacy.workspaces[0], personalWorkspace(legacy));
  assert.equal(personalWorkspace(legacy).name, '我的个人空间');
});

test('个人空间：只有本人和代表本人的 WorkBuddy 能访问，同事无法加入或被关联', () => {
  const data = { workspaces: [], joinRequests: [] };
  ensurePersonalWorkspace(data);
  const space = personalWorkspace(data);
  space.members.push({ id: 'x', wecomUserId: 'alice', role: 'editor', status: 'wecom' });
  assert.equal(authorize(actors.wecom('alice'), 'work.view', space).allowed, false);
  assert.equal(authorize(actors.rule('r1', space.id), 'work.create', space).allowed, false);
  assert.equal(authorize(actors.local(), 'work.create', space).allowed, true);
  assert.equal(authorize(actors.workbuddy(), 'work.append', space).allowed, true);
  assert.throws(() => linkWecomProjectMember(data, { workspaceId: space.id, userId: 'bob', name: '鲍勃' }), /不存在/);
  assert.equal(requestToJoin(data, { userId: 'bob', workspace: space.name }).status, 'workspace-not-found');
});

test('成果不再复制：团队工作的文件只存团队资料（带来源），个人工作只存个人空间', async () => {
  const ctx = await setup();
  try {
    const personal = personalWorkspace(await ctx.store.read());
    const teamTask = await ctx.ops.create(actors.local(), { workspace: '产品团队', goal: '写周报' });
    const answer = { id: 'a1', role: 'assistant', text: '写好了', source: 'workbuddy', pendingFiles: [{ path: await ctx.produce('周报.md') }] };
    await ctx.runner.attachAnswerFiles(teamTask, answer);
    let documents = await ctx.documentService.list();
    assert.deepEqual(documents.map(item => item.workspaceId), ['team'], '个人空间没有副本');
    assert.equal(documents[0].origin.taskId, teamTask.id);
    assert.equal(answer.personalArtifacts, undefined);

    const own = await ctx.ops.create(actors.local(), { workspace: personal.name, goal: '理思路' });
    await ctx.runner.attachAnswerFiles(own, { id: 'a2', role: 'assistant', text: '好', source: 'codex', pendingFiles: [{ path: await ctx.produce('思路.md') }] });
    documents = await ctx.documentService.list();
    assert.equal(documents.find(item => item.name === '思路.md').workspaceId, personal.id);
  } finally { await cleanup(ctx); }
});

test('个人记忆分级：个人工作用全部；团队工作只用标为「可随我带入团队」的；同事触发一条都不用', async () => {
  const ctx = await setup();
  try {
    const personal = personalWorkspace(await ctx.store.read());
    const mine = await ctx.ops.create(actors.local(), { workspace: personal.name, goal: '自己想想' });
    await ctx.settle(mine.id);
    assert.deepEqual(ctx.seen.at(-1).memory.personal.map(item => item.id).sort(), ['pm-portable', 'pm-private']);
    const team = await ctx.ops.create(actors.local(), { workspace: '产品团队', goal: '团队周报' });
    await ctx.settle(team.id);
    assert.deepEqual(ctx.seen.at(-1).memory.personal.map(item => item.id), ['pm-portable']);
    assert.doesNotMatch(ctx.seen.at(-1).input.instructions, /预算可能砍半/);
    await ctx.ops.append(actors.wecom('alice'), team.id, '我补充一句', { origin: { userId: 'alice' } });
    await ctx.settle(team.id);
    assert.deepEqual(ctx.seen.at(-1).memory.personal, []);
  } finally { await cleanup(ctx); }
});

test('上层规则往下传：项目带上主团队与公共空间的记忆（只读标注、按层限量），资料不继承', async () => {
  const ctx = await setup();
  try {
    const work = await ctx.ops.create(actors.local(), { workspace: '福州下线', goal: '迁移清单' });
    await ctx.settle(work.id);
    const { memory, input } = ctx.seen.at(-1);
    const team = memory.team.map(item => item.id);
    assert.equal(team[0], 'tm-proj', '本项目记忆在前');
    assert.ok(team.includes('tm-team'));
    assert.equal(team.filter(id => id.startsWith('tm-pub')).length, 3, '公共记忆最多 3 条');
    assert.match(input.instructions, /团队口径（来自产品团队，上层规则，只读）/);
    const [teamDoc] = await ctx.documentService.upload('team', [await ctx.produce('团队内部.md')]);
    await assert.rejects(ctx.ops.append(actors.local(), work.id, '看团队资料', { documentIds: [teamDoc.id] }), /有效资料/);
  } finally { await cleanup(ctx); }
});

test('公共空间：不能发起工作、不能被关联；资料在任何工作中都能引用', async () => {
  const ctx = await setup();
  try {
    await assert.rejects(ctx.ops.create(actors.local(), { workspace: '公共空间', goal: 'x' }), /不能发起工作/);
    await assert.rejects(ctx.ops.create(actors.local(), { workspace: '产品团队', goal: 'x', relatedWorkspaces: ['公共空间'] }), /不需要关联/);
    const [rule] = await ctx.documentService.upload('public', [await ctx.produce('对外口径.md')]);
    const work = await ctx.ops.create(actors.local(), { workspace: '福州下线', goal: '按口径写', documentIds: [rule.id] });
    await ctx.settle(work.id);
    assert.match(ctx.seen.at(-1).snapshot.messages.at(-1).text, /# 对外口径\.md/);
  } finally { await cleanup(ctx); }
});

test('同事追问只看到目标、已确认进展和他自己的消息；不续接、不覆盖负责人的会话；负责人可选择共享', async () => {
  const ctx = await setup();
  try {
    const work = await ctx.ops.create(actors.local(), { workspace: '福州下线', goal: '迁移清单' });
    await ctx.settle(work.id);
    await ctx.ops.append(actors.local(), work.id, '我私下判断张三那 3 台有问题');
    await ctx.settle(work.id);
    await ctx.store.update(draft => { draft.tasks.find(item => item.id === work.id).progress = [{ id: 'p1', kind: 'conclusion', text: '42/60 台已核对', status: 'published' }, { id: 'p2', kind: 'conclusion', text: '草稿不该出现', status: 'draft' }]; return draft; });
    const ownerSession = (await ctx.task(work.id)).agentSessionId;
    await ctx.ops.append(actors.wecom('bob'), work.id, '现在进度怎么样', { origin: { userId: 'bob' } });
    await ctx.settle(work.id);
    const colleague = ctx.seen.at(-1);
    const texts = colleague.snapshot.messages.map(item => item.text).join('\n');
    assert.doesNotMatch(texts, /私下判断|草稿不该出现/);
    assert.match(texts, /目标：迁移清单/);
    assert.match(texts, /42\/60 台已核对/);
    assert.match(texts, /现在进度怎么样/);
    assert.equal(colleague.snapshot.agentSessionId, null, '不续接负责人的会话');
    const after = await ctx.task(work.id);
    assert.equal(after.agentSessionId, ownerSession, '负责人的会话不被同事这次覆盖');
    assert.equal(after.messages.at(-1).agentSessionId, undefined);

    await ctx.ops.setConversationShared(actors.local(), work.id, true);
    await ctx.ops.append(actors.wecom('bob'), work.id, '再看看', { origin: { userId: 'bob' } });
    await ctx.settle(work.id);
    assert.match(ctx.seen.at(-1).snapshot.messages.map(item => item.text).join('\n'), /私下判断/);
    await assert.rejects(ctx.ops.setConversationShared(actors.wecom('bob'), work.id, false), /只有本人/);
  } finally { await cleanup(ctx); }
});

test('个人资料进团队工作：引用标为个人，同事不能引用，进展草稿标出「参考了个人记忆/资料」', async () => {
  const ctx = await setup();
  try {
    const personal = personalWorkspace(await ctx.store.read());
    const [note] = await ctx.documentService.upload(personal.id, [await ctx.produce('我的笔记.md')]);
    ctx.setReply(`结论如下${PROGRESS}`);
    const work = await ctx.ops.create(actors.local(), { workspace: '产品团队', goal: '参考笔记', documentIds: [note.id] });
    assert.deepEqual(work.messages[0].documentRefs, [{ id: note.id, name: '我的笔记.md', personal: true }]);
    await ctx.settle(work.id);
    const drafts = (await ctx.task(work.id)).progress.filter(item => item.status === 'draft');
    assert.ok(drafts.length && drafts.every(item => item.personal === 'memory-and-document'));
    await assert.rejects(ctx.ops.create(actors.wecom('alice'), { workspace: '产品团队', goal: '看他的笔记', documentIds: [note.id], origin: { userId: 'alice' } }), /有效资料/);
    await assert.rejects(ctx.ops.create(actors.local(), { workspace: '产品团队', goal: 'x', relatedWorkspaces: [personal.name] }), /个人空间不能作为关联空间/);
  } finally { await cleanup(ctx); }
});

test('移交：只把挑选的消息和其中的文件交给项目；个人工作保留全部记录与会话，只能移交一次', async () => {
  const ctx = await setup();
  try {
    const personal = personalWorkspace(await ctx.store.read());
    const work = await ctx.ops.create(actors.local(), { workspace: personal.name, goal: '福州清单初稿' });
    await ctx.settle(work.id);
    await ctx.ops.append(actors.local(), work.id, '这里有我的私人猜测');
    await ctx.settle(work.id);
    let current = await ctx.task(work.id);
    const finalReply = current.messages.filter(item => item.role === 'assistant').at(-1);
    const [file] = await ctx.documentService.upload(personal.id, [await ctx.produce('清单.md')]);
    await ctx.store.update(draft => { draft.tasks.find(item => item.id === work.id).messages.find(item => item.id === finalReply.id).artifacts = [{ id: file.id, name: '清单.md' }]; return draft; });

    await assert.rejects(ctx.ops.handover(actors.wecom('bob'), work.id, { workspace: '福州下线', messageIds: [finalReply.id] }), /只有本人/);
    await assert.rejects(ctx.ops.handover(actors.local(), work.id, { workspace: '公共空间', messageIds: [finalReply.id] }), /团队或项目/);
    const moved = await ctx.ops.handover(actors.local(), work.id, { workspace: '福州下线', messageIds: [finalReply.id] });
    assert.equal(moved.workspace, '福州下线');
    assert.doesNotMatch(moved.messages.map(item => item.text).join('\n'), /私人猜测/);
    assert.equal(moved.agentSessionId, undefined, '不带走个人会话');
    const copied = moved.messages.find(item => item.handedOverFrom === finalReply.id);
    assert.equal(copied.artifacts.length, 1);
    const documents = await ctx.documentService.list();
    assert.equal(documents.find(item => item.id === copied.artifacts[0].id).workspaceId, 'proj');
    current = await ctx.task(work.id);
    assert.equal(current.handedOver.taskId, moved.id);
    assert.ok(current.agentSessionId, '个人工作保留会话');
    await assert.rejects(ctx.ops.handover(actors.local(), work.id, { workspace: '产品团队', messageIds: [finalReply.id] }), /已移交/);
    await assert.rejects(ctx.ops.handover(actors.local(), moved.id, { workspace: '产品团队', messageIds: [copied.id] }), /只有个人空间/);
  } finally { await cleanup(ctx); }
});

test('只用本机执行：个人空间的工作不交给云端沙箱 Agent，团队工作不受影响', async () => {
  const ctx = await setup({ privacy: { personalLocalOnly: true }, mode: 'cloudagent' });
  try {
    const personal = personalWorkspace(await ctx.store.read());
    const mine = await ctx.ops.create(actors.local(), { workspace: personal.name, goal: '私人整理' });
    await ctx.settle(mine.id);
    const blocked = await ctx.task(mine.id);
    assert.equal(blocked.agentRun.status, 'failed');
    assert.match(blocked.agentRun.message, /只用本机执行/);
    assert.equal(ctx.seen.length, 0);
    const team = await ctx.ops.create(actors.local(), { workspace: '产品团队', goal: '团队整理' });
    await ctx.settle(team.id);
    assert.equal(ctx.seen.length, 1);
  } finally { await cleanup(ctx); }
});
