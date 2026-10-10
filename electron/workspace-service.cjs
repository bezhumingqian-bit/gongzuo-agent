const crypto = require('node:crypto');
const { recipientUserId } = require('./wecom-service.cjs');

const LOCAL_USER_ID = 'local-user';

function migrateLegacyWorkspaceMembers(data) {
  let changed = false;
  for (const workspace of data.workspaces || []) {
    if (Array.isArray(workspace.members)) continue;
    if (Number.isInteger(workspace.members) && workspace.members > 0) workspace.legacyMemberCount = workspace.members;
    workspace.members = [];
    changed = true;
  }
  return changed;
}

function workspaceType(workspace) {
  return workspace.type || (workspace.id === 'public' ? 'public' : 'team');
}

function createProjectWorkspace(data, input, actorId = LOCAL_USER_ID) {
  const name = String(input.name || '').trim();
  const description = String(input.description || '').trim();
  if (name.length < 2 || name.length > 80) throw new Error('项目空间名称需为 2–80 个字');
  if (description.length > 300) throw new Error('项目说明不能超过 300 个字');
  if (data.workspaces.some(space => space.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('已有同名工作空间');
  const parentWorkspaceId = input.parentWorkspaceId || null;
  if (parentWorkspaceId && !data.workspaces.some(space => space.id === parentWorkspaceId && workspaceType(space) === 'team')) {
    throw new Error('关联团队不存在');
  }
  const now = new Date().toISOString();
  const workspace = {
    id: crypto.randomUUID(),
    type: 'project',
    name,
    description,
    parentWorkspaceId,
    createdBy: actorId,
    createdAt: now,
    members: [{ id: actorId, name: '我', role: 'owner', status: 'active', addedAt: now }]
  };
  data.workspaces.push(workspace);
  data.activeWorkspace = name;
  return workspace;
}

function addProjectMember(data, input, actorId = LOCAL_USER_ID) {
  const workspace = data.workspaces.find(space => space.id === input.workspaceId && workspaceType(space) === 'project');
  if (!workspace) throw new Error('项目空间不存在');
  if (workspace.createdBy !== actorId) throw new Error('只有空间创建者可以添加成员');
  const email = String(input.email || '').trim().toLowerCase();
  const role = input.role || 'editor';
  if (!['viewer','editor'].includes(role)) throw new Error('项目权限无效');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('请输入有效的同事邮箱');
  if ((workspace.members || []).some(member => member.email?.toLowerCase() === email)) throw new Error('该同事已在待邀请列表中');
  const member = { id: crypto.randomUUID(), email, name: String(input.name || '').trim().slice(0, 80) || email.split('@')[0], role, status: 'pending', addedAt: new Date().toISOString() };
  workspace.members ||= [];
  workspace.members.push(member);
  return member;
}

function linkWecomProjectMember(data, input, actorId = LOCAL_USER_ID) {
  const workspace = data.workspaces.find(space => space.id === input.workspaceId && ['project', 'team'].includes(workspaceType(space)));
  if (!workspace) throw new Error('团队或项目空间不存在');
  if (workspaceType(workspace) === 'project' && workspace.createdBy !== actorId) throw new Error('只有空间创建者可以关联企微成员');
  const userId = recipientUserId(input.userId);
  const directoryMember = (data.wecomDirectory?.members || []).find(item => item.userId === userId);
  if (!directoryMember) throw new Error('请先同步企微可见成员，再从目录中选择同事');
  if ((workspace.members || []).some(item => item.wecomUserId === userId)) throw new Error('该企微成员已在项目中');
  const role = input.role || 'editor';
  if (!['viewer', 'editor'].includes(role)) throw new Error('项目权限无效');
  const member = { id: crypto.randomUUID(), name: directoryMember.name, wecomUserId: userId, role, status: 'wecom', addedAt: new Date().toISOString() };
  workspace.members ||= [];
  workspace.members.push(member);
  return member;
}

function removePendingProjectMember(data, input, actorId = LOCAL_USER_ID) {
  const workspace = data.workspaces.find(space => space.id === input.workspaceId && ['project', 'team'].includes(workspaceType(space)));
  if (!workspace) throw new Error('团队或项目空间不存在');
  if (workspaceType(workspace) === 'project' && workspace.createdBy !== actorId) throw new Error('只有空间创建者可以管理成员');
  const index = (workspace.members || []).findIndex(member => member.id === input.memberId && ['pending', 'wecom'].includes(member.status));
  if (index < 0) throw new Error('待邀请或企微成员不存在');
  workspace.members.splice(index, 1);
  return true;
}

function updatePendingProjectMemberRole(data, input, actorId = LOCAL_USER_ID) {
  const workspace = data.workspaces.find(space => space.id === input.workspaceId && ['project', 'team'].includes(workspaceType(space)));
  if (!workspace) throw new Error('团队或项目空间不存在');
  if (workspaceType(workspace) === 'project' && workspace.createdBy !== actorId) throw new Error('只有空间创建者可以管理成员');
  if (!['viewer','editor'].includes(input.role)) throw new Error('项目权限无效');
  const member = (workspace.members || []).find(item => item.id === input.memberId && ['pending', 'wecom'].includes(item.status));
  if (!member) throw new Error('待邀请或企微成员不存在');
  member.role = input.role;
  return member;
}

module.exports = { LOCAL_USER_ID, workspaceType, migrateLegacyWorkspaceMembers, createProjectWorkspace, addProjectMember, linkWecomProjectMember, removePendingProjectMember, updatePendingProjectMemberRole };
