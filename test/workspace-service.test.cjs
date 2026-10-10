const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createProjectWorkspace, addProjectMember, removePendingProjectMember, updatePendingProjectMemberRole, migrateLegacyWorkspaceMembers } = require('../electron/workspace-service.cjs');

function data() {
  return { activeWorkspace: '产品团队', workspaces: [{ id: 'product', name: '产品团队' }, { id: 'public', name: '公共空间' }] };
}

test('项目空间独立创建，并将创建者设为负责人', () => {
  const state = data();
  const project = createProjectWorkspace(state, { name: '客户反馈升级', parentWorkspaceId: 'product', description: '汇集反馈工作' });
  assert.equal(project.type, 'project');
  assert.equal(project.parentWorkspaceId, 'product');
  assert.deepEqual(project.members.map(member => [member.id, member.role, member.status]), [['local-user', 'owner', 'active']]);
  assert.equal(state.activeWorkspace, project.name);
  assert.throws(() => createProjectWorkspace(state, { name: '客户反馈升级' }), /同名/);
  assert.throws(() => createProjectWorkspace(state, { name: '另一个项目', parentWorkspaceId: 'public' }), /关联团队/);
});

test('只有创建者能管理待邀请成员，名单不会被标为已加入', () => {
  const state = data();
  const project = createProjectWorkspace(state, { name: '客户反馈升级' });
  assert.throws(() => addProjectMember(state, { workspaceId: project.id, email: 'a@example.com' }, 'other-user'), /创建者/);
  const member = addProjectMember(state, { workspaceId: project.id, email: 'A@example.com', name: '小王', role: 'viewer' });
  assert.equal(member.email, 'a@example.com');
  assert.equal(member.status, 'pending');
  assert.equal(member.role, 'viewer');
  assert.throws(() => updatePendingProjectMemberRole(state, { workspaceId: project.id, memberId: member.id, role: 'editor' }, 'other-user'), /创建者/);
  updatePendingProjectMemberRole(state, { workspaceId: project.id, memberId: member.id, role: 'editor' });
  assert.equal(member.role, 'editor');
  assert.throws(() => addProjectMember(state, { workspaceId: project.id, email: 'a@example.com' }), /待邀请/);
  assert.throws(() => removePendingProjectMember(state, { workspaceId: project.id, memberId: member.id }, 'other-user'), /创建者/);
  removePendingProjectMember(state, { workspaceId: project.id, memberId: member.id });
  assert.equal(project.members.length, 1);
  assert.throws(() => removePendingProjectMember(state, { workspaceId: project.id, memberId: 'local-user' }), /待邀请/);
});

test('旧版成员数字迁移为空成员列表，空间页面仍可打开', () => {
  const oldData = { workspaces: [
    { id: 'product', name: '产品团队', members: 8 },
    { id: 'operations', name: '运营团队', members: 12 },
    { id: 'public', name: '公共空间' }
  ] };
  assert.equal(migrateLegacyWorkspaceMembers(oldData), true);
  assert.deepEqual(oldData.workspaces.map(space => space.members), [[], [], []]);
  assert.equal(oldData.workspaces[0].legacyMemberCount, 8);
  assert.equal(migrateLegacyWorkspaceMembers(oldData), false);

  let html = '';
  const root = { set innerHTML(value) { html = value; }, addEventListener() {} };
  const context = {
    document: { getElementById: () => root, title: '' },
    window: {},
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout,
    incoming: { workspaces: [{ id: 'product', name: '产品团队', members: 8 }] }
  };
  vm.createContext(context);
  const script = fs.readFileSync(path.join(__dirname, '../demo/app.js'), 'utf8');
  vm.runInContext(`${script}\napplyDesktopData(incoming); state.drawer = 'team'; state.drawerOpen = true; state.view = 'workspace'; render();`, context);
  assert.match(html, /工作空间 \/ 资料/);
  assert.match(html, /空间资料/);
});
