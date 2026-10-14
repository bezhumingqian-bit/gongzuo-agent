const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../electron/store.cjs');
const { TaskRunner } = require('../electron/task-runner.cjs');
const { WorkOperations, taskSpaces } = require('../electron/contracts/work-operations.cjs');
const { actors } = require('../electron/contracts/policy.cjs');
const { getApplicableMemories } = require('../electron/memory-service.cjs');
const { conversationInput } = require('../electron/connection-service.cjs');

async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-related-'));
  const store = new JsonStore(path.join(directory, 'w.json'), () => ({
    workspaces: [
      { id: 'team', name: '产品团队', type: 'team', members: [{ wecomUserId: 'alice', role: 'editor', status: 'wecom' }] },
      { id: 'proj', name: 'TEZ 项目', type: 'project', members: [{ wecomUserId: 'bob', role: 'editor', status: 'wecom' }, { wecomUserId: 'alice', role: 'viewer', status: 'wecom' }] },
      { id: 'ops', name: '运营团队', type: 'team', members: [] }
    ],
    tasks: []
  }));
  const personal = new JsonStore(path.join(directory, 'p.json'), () => ({ items: [] }));
  const team = new JsonStore(path.join(directory, 't.json'), () => ({ items: [
    { id: 'm1', title: '团队约定', content: '结论先行', scope: 'team', workspaceId: 'team', status: 'active' },
    { id: 'm2', title: '项目背景', content: 'TEZ 58 个可用区', scope: 'team', workspaceId: 'proj', status: 'active' },
    { id: 'm3', title: '运营口径', content: '不应出现', scope: 'team', workspaceId: 'ops', status: 'active' }
  ] }));
  await Promise.all([store.initialize(), personal.initialize(), team.initialize()]);
  const documents = [
    { id: 'd-team', name: '团队周报.md', workspaceId: 'team', status: 'active' },
    { id: 'd-proj', name: '项目方案.md', workspaceId: 'proj', status: 'active' },
    { id: 'd-ops', name: '运营.md', workspaceId: 'ops', status: 'active' }
  ];
  const documentService = { list: async () => documents, readForAgent: async (id, spaceIds) => {
    const item = documents.find(document => document.id === id && [].concat(spaceIds).includes(document.workspaceId));
    if (!item) throw new Error('所选资料不存在或不属于当前空间');
    return { name: item.name, text: `正文:${item.name}` };
  } };
  const agent = { isConfigured: () => false };
  const runner = new TaskRunner({ store, settingsService: { getRuntimeConfig: async () => ({ agent: { mode: 'built-in' }, model: {} }) }, personalMemoryStore: personal, teamMemoryStore: team, documentService, agent, publish: () => {} });
  const ops = new WorkOperations({ store, taskRunner: runner });
  return { directory, store, runner, ops };
}

test('新建时多选：归属团队空间并关联项目空间；Agent 拿到两个空间的团队记忆和资料，不含无关空间', async () => {
  const ctx = await setup();
  try {
    const task = await ctx.ops.create(actors.local(), { workspace: '产品团队', goal: '整理 TEZ 周报', relatedWorkspaces: ['TEZ 项目', '产品团队', 'TEZ 项目'], documentIds: ['d-proj'] });
    assert.equal(task.workspace, '产品团队');
    assert.deepEqual(task.relatedWorkspaces, ['TEZ 项目'], '去重且不含归属空间');
    const prepared = await ctx.runner.prepare(task.id, task.messages[0].id);
    assert.deepEqual(prepared.memory.team.map(item => item.id).sort(), ['m1', 'm2']);
    assert.match(prepared.snapshot.messages.at(-1).text, /正文:项目方案\.md/);
    assert.match(conversationInput(prepared.snapshot.messages, prepared.memory).instructions, /同时关联到：TEZ 项目/);
    await assert.rejects(ctx.runner.append(task.id, '再看运营', [], ['d-ops']), /含关联空间/);
    const data = await ctx.store.read();
    assert.deepEqual(taskSpaces(data, data.tasks[0]).map(space => space.id), ['team', 'proj']);
  } finally { await fs.rm(ctx.directory, { recursive: true, force: true }); }
});

test('权限：关联空间的成员可查看与追加；只读成员不能追加；关联需要目标空间的创建权限', async () => {
  const ctx = await setup();
  try {
    const task = await ctx.ops.create(actors.local(), { workspace: '产品团队', goal: '方案评审', relatedWorkspaces: ['TEZ 项目'] });
    assert.equal((await ctx.ops.view(actors.wecom('bob'), task.id)).task.id, task.id, '项目成员通过关联看到');
    await ctx.ops.append(actors.wecom('bob'), task.id, '补充项目进展');
    await assert.rejects(ctx.ops.view(actors.wecom('stranger'), task.id), error => error.code === 'no-access');
    await assert.rejects(ctx.ops.create(actors.wecom('alice'), { workspace: '产品团队', goal: 'x', relatedWorkspaces: ['TEZ 项目'] }), error => error.code === 'read-only', 'alice 在项目里只读，不能把工作关联过去');
    await assert.rejects(ctx.ops.create(actors.local(), { workspace: '产品团队', goal: 'x', relatedWorkspaces: ['不存在'] }), error => error.code === 'workspace-not-found');
    await assert.rejects(ctx.ops.create(actors.local(), { workspace: '产品团队', goal: 'x', relatedWorkspaces: ['a', 'b', 'c', 'd', 'e', 'f'] }), /最多关联 5 个/);
  } finally { await fs.rm(ctx.directory, { recursive: true, force: true }); }
});

test('已有工作调整关联：需归属空间的编辑权限；可增删；清空后恢复单空间', async () => {
  const ctx = await setup();
  try {
    const task = await ctx.ops.create(actors.local(), { workspace: '产品团队', goal: '跟进' });
    assert.equal(task.relatedWorkspaces, undefined, '默认单空间，数据结构不变');
    await assert.rejects(ctx.ops.setRelated(actors.wecom('bob'), task.id, ['TEZ 项目']), error => error.code === 'no-access', 'bob 不在归属空间，不能改关联');
    let updated = await ctx.ops.setRelated(actors.local(), task.id, ['TEZ 项目', '运营团队']);
    assert.deepEqual(updated.relatedWorkspaces, ['TEZ 项目', '运营团队']);
    updated = await ctx.ops.setRelated(actors.wecom('alice'), task.id, ['运营团队']);
    assert.deepEqual(updated.relatedWorkspaces, ['运营团队'], '移除不需要目标空间权限');
    updated = await ctx.ops.setRelated(actors.local(), task.id, []);
    assert.equal(updated.relatedWorkspaces, undefined);
  } finally { await fs.rm(ctx.directory, { recursive: true, force: true }); }
});

test('记忆筛选兼容单个与多个空间 ID', () => {
  const items = [{ id: 'a', scope: 'team', status: 'active', workspaceId: 'x' }, { id: 'b', scope: 'team', status: 'active', workspaceId: 'y' }];
  assert.deepEqual(getApplicableMemories([], items, 'x').team.map(item => item.id), ['a']);
  assert.deepEqual(getApplicableMemories([], items, ['x', 'y']).team.map(item => item.id), ['a', 'b']);
});
