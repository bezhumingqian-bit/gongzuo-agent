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
const { ensurePersonalWorkspace, personalWorkspace, linkWecomProjectMember, requestToJoin } = require('../electron/workspace-service.cjs');
const { createSeed } = require('../electron/seed.cjs');

async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-personal-'));
  const store = new JsonStore(path.join(directory, 'w.json'), () => ({
    workspaces: [{ id: 'team', name: '产品团队', type: 'team', members: [{ id: 'm-alice', wecomUserId: 'alice', role: 'editor', status: 'wecom' }] }],
    tasks: []
  }));
  const memory = new JsonStore(path.join(directory, 'm.json'), () => ({ items: [] }));
  await Promise.all([store.initialize(), memory.initialize()]);
  await store.update(data => { ensurePersonalWorkspace(data); return data; });
  const documentService = new DocumentService(path.join(directory, 'documents.json'), path.join(directory, 'documents'));
  await documentService.initialize();
  const runner = new TaskRunner({ store, settingsService: { getRuntimeConfig: async () => ({ agent: { mode: 'built-in' }, model: {} }) }, personalMemoryStore: memory, teamMemoryStore: memory, documentService, agent: { isConfigured: () => false }, publish: () => {} });
  const ops = new WorkOperations({ store, taskRunner: runner });
  const produce = async name => { const file = path.join(directory, name); await fs.writeFile(file, `# ${name}`); return file; };
  return { directory, store, runner, ops, documentService, produce };
}

test('个人空间：首次启动与老数据都有且只有一个，排在最前；同名时改名不覆盖', () => {
  const seed = createSeed();
  assert.equal(seed.workspaces[0].type, 'personal');
  assert.equal(ensurePersonalWorkspace(seed), false, '种子已带个人空间，不重复创建');

  const legacy = { workspaces: [{ id: 'product', name: '产品团队', type: 'team', members: [] }, { id: 'x', name: '个人空间', type: 'project', members: [] }] };
  assert.equal(ensurePersonalWorkspace(legacy), true);
  assert.equal(ensurePersonalWorkspace(legacy), false);
  assert.equal(legacy.workspaces.filter(space => space.type === 'personal').length, 1);
  assert.equal(legacy.workspaces[0], personalWorkspace(legacy));
  assert.equal(personalWorkspace(legacy).name, '我的个人空间');
  assert.deepEqual(personalWorkspace(legacy).members.map(member => member.id), ['local-user']);
});

test('个人空间：只有本人和代表本人的 WorkBuddy 能访问，同事无法加入或被关联', () => {
  const data = { workspaces: [], joinRequests: [] };
  ensurePersonalWorkspace(data);
  const space = personalWorkspace(data);
  // Even a hand-edited member entry must not open it to a colleague.
  space.members.push({ id: 'x', wecomUserId: 'alice', role: 'editor', status: 'wecom' });
  assert.equal(authorize(actors.wecom('alice'), 'work.view', space).allowed, false);
  assert.equal(authorize(actors.rule('r1', space.id), 'work.create', space).allowed, false);
  assert.equal(authorize(actors.local(), 'work.create', space).allowed, true);
  assert.equal(authorize(actors.workbuddy(), 'work.append', space).allowed, true);
  assert.throws(() => linkWecomProjectMember(data, { workspaceId: space.id, userId: 'bob', name: '鲍勃' }), /不存在/);
  assert.equal(requestToJoin(data, { userId: 'bob', workspace: space.name }).status, 'workspace-not-found');
});

test('Agent 生成的文件：团队工作存入团队资料并在个人空间留一份（带来源）；个人工作只存个人空间', async () => {
  const ctx = await setup();
  try {
    const personal = personalWorkspace(await ctx.store.read());
    const teamTask = await ctx.ops.create(actors.local(), { workspace: '产品团队', goal: '写 TEZ 周报' });
    const answer = { id: 'a1', role: 'assistant', text: '周报写好了', source: 'workbuddy', pendingFiles: [{ path: await ctx.produce('周报.md') }] };
    await ctx.runner.attachAnswerFiles(teamTask, answer);
    const documents = await ctx.documentService.list();
    const teamCopy = documents.find(item => item.workspaceId === 'team');
    const personalCopy = documents.find(item => item.workspaceId === personal.id);
    assert.ok(teamCopy && personalCopy, '两边各一份');
    assert.equal(teamCopy.origin, undefined, '团队资料不带个人来源信息');
    assert.deepEqual(personalCopy.origin, { kind: 'agent', taskId: teamTask.id, taskTitle: teamTask.title, workspace: '产品团队', agent: 'workbuddy', messageId: 'a1' });
    assert.deepEqual(answer.artifacts, [{ id: teamCopy.id, name: '周报.md' }]);
    assert.deepEqual(answer.personalArtifacts, [{ id: personalCopy.id, name: '周报.md' }]);
    assert.equal(answer.text, '周报写好了');

    // Removing the personal copy does not touch the team's copy.
    await ctx.documentService.setArchived(personalCopy.id, true);
    assert.equal((await ctx.documentService.list()).find(item => item.id === teamCopy.id).status, 'active');

    const own = await ctx.ops.create(actors.local(), { workspace: personal.name, goal: '自己整理思路' });
    const mine = { id: 'a2', role: 'assistant', text: '整理好了', source: 'codex', pendingFiles: [{ path: await ctx.produce('思路.md') }] };
    await ctx.runner.attachAnswerFiles(own, mine);
    const after = (await ctx.documentService.list()).filter(item => item.name === '思路.md');
    assert.equal(after.length, 1, '个人工作不重复存');
    assert.equal(after[0].workspaceId, personal.id);
    assert.deepEqual(mine.artifacts, mine.personalArtifacts);
  } finally { await fs.rm(ctx.directory, { recursive: true, force: true }); }
});

test('个人资料：本人在任何空间的工作都能引用；同事从企微发起的工作不能引用，个人空间也不能被关联', async () => {
  const ctx = await setup();
  try {
    const personal = personalWorkspace(await ctx.store.read());
    const [doc] = await ctx.documentService.upload(personal.id, [await ctx.produce('我的笔记.md')]);
    const task = await ctx.ops.create(actors.local(), { workspace: '产品团队', goal: '参考我的笔记', documentIds: [doc.id] });
    assert.deepEqual(task.messages[0].documentRefs, [{ id: doc.id, name: '我的笔记.md' }]);
    const prepared = await ctx.runner.prepare(task.id, task.messages[0].id);
    assert.match(prepared.snapshot.messages.at(-1).text, /# 我的笔记\.md/);

    await assert.rejects(ctx.ops.create(actors.wecom('alice'), { workspace: '产品团队', goal: '看看他的笔记', documentIds: [doc.id], origin: { userId: 'alice' } }), /个人空间内的有效资料/);
    await assert.rejects(ctx.ops.create(actors.local(), { workspace: '产品团队', goal: 'x', relatedWorkspaces: [personal.name] }), /个人空间不能作为关联空间/);
    await assert.rejects(ctx.ops.create(actors.wecom('alice'), { workspace: personal.name, goal: '进他的个人空间' }), /没有该空间的访问权限/);
  } finally { await fs.rm(ctx.directory, { recursive: true, force: true }); }
});
