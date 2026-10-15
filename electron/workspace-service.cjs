const crypto = require('node:crypto');
const { recipientUserId } = require('./wecom-service.cjs');

const LOCAL_USER_ID = 'local-user';
const PERSONAL_WORKSPACE_ID = 'personal';
const PERSONAL_WORKSPACE_NAME = '个人空间';

// Every user has exactly one private space. Materials produced while working
// with Agents (generated files, conversations) are kept here across spaces.
// It has no members besides the owner and cannot be shared.
function personalWorkspace(data) {
  return (data.workspaces || []).find(space => space.type === 'personal') || null;
}

function ensurePersonalWorkspace(data) {
  data.workspaces ||= [];
  if (personalWorkspace(data)) return false;
  const taken = new Set(data.workspaces.map(space => space.name));
  const name = taken.has(PERSONAL_WORKSPACE_NAME) ? '我的个人空间' : PERSONAL_WORKSPACE_NAME;
  const id = data.workspaces.some(space => space.id === PERSONAL_WORKSPACE_ID) ? `personal-${crypto.randomUUID()}` : PERSONAL_WORKSPACE_ID;
  const now = new Date().toISOString();
  data.workspaces.unshift({ id, type: 'personal', name, description: '只有你能看到。和 Agent 一起工作产生的材料都留在这里。', createdBy: LOCAL_USER_ID, createdAt: now, members: [{ id: LOCAL_USER_ID, name: '我', role: 'owner', status: 'active', addedAt: now }] });
  return true;
}

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
  // Without a synced directory (no self-built app), the owner types the name.
  const directoryMember = (data.wecomDirectory?.members || []).find(item => item.userId === userId)
    || (String(input.name || '').trim() ? { name: String(input.name).trim().slice(0, 40) } : null);
  if (!directoryMember) throw new Error('请填写同事姓名和企微 UserID');
  if ((workspace.members || []).some(item => item.wecomUserId === userId)) throw new Error('该企微成员已在项目中');
  const role = input.role || 'editor';
  if (!['viewer', 'editor'].includes(role)) throw new Error('项目权限无效');
  const member = { id: crypto.randomUUID(), name: directoryMember.name, wecomUserId: userId, role, status: 'wecom', addedAt: new Date().toISOString() };
  workspace.members ||= [];
  workspace.members.push(member);
  return member;
}

// Bind a colleague's Feishu account: to an existing member (memberId) or as a
// new Feishu-only member. Feishu is a secondary channel next to WeCom.
function linkFeishuProjectMember(data, input, actorId = LOCAL_USER_ID) {
  const workspace = data.workspaces.find(space => space.id === input.workspaceId && ['project', 'team'].includes(workspaceType(space)));
  if (!workspace) throw new Error('团队或项目空间不存在');
  if (workspaceType(workspace) === 'project' && workspace.createdBy !== actorId) throw new Error('只有空间创建者可以关联成员');
  const feishuId = String(input.feishuId || '').trim();
  if (!feishuId || feishuId.length > 120 || !(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(feishuId) || /^[A-Za-z0-9_-]{1,80}$/.test(feishuId))) throw new Error('请填写同事的飞书邮箱、user_id 或 open_id');
  workspace.members ||= [];
  if (workspace.members.some(item => item.feishuId === feishuId && item.id !== input.memberId)) throw new Error('该飞书账号已在空间中');
  if (input.memberId) {
    const member = workspace.members.find(item => item.id === input.memberId && item.id !== LOCAL_USER_ID);
    if (!member) throw new Error('成员不存在');
    member.feishuId = feishuId;
    return member;
  }
  const name = String(input.name || '').trim().slice(0, 40);
  if (!name) throw new Error('请填写同事姓名');
  const role = input.role || 'editor';
  if (!['viewer', 'editor'].includes(role)) throw new Error('项目权限无效');
  const member = { id: crypto.randomUUID(), name, feishuId, role, status: 'feishu', addedAt: new Date().toISOString() };
  workspace.members.push(member);
  return member;
}

// ---- 加入申请：colleague sends the bot "加入 空间名", owner confirms here ----

function requestToJoin(data, { userId, workspace, name }) {
  const space = data.workspaces.find(item => item.name === workspace && ['project', 'team'].includes(workspaceType(item)));
  if (!space) return { status: 'workspace-not-found' };
  if ((space.members || []).some(member => member.wecomUserId === userId && member.status !== 'pending')) return { status: 'already-member', space };
  data.joinRequests ||= [];
  const existing = data.joinRequests.find(item => item.userId === userId && item.workspaceId === space.id);
  if (existing) { if (name) existing.name = name; return { status: 'already-requested', space }; }
  data.joinRequests.push({ id: crypto.randomUUID(), userId, workspaceId: space.id, name: name || '', at: new Date().toISOString() });
  if (data.joinRequests.length > 200) data.joinRequests.splice(0, data.joinRequests.length - 200);
  return { status: 'requested', space };
}

function decideJoinRequest(data, { requestId, approve, name, role = 'editor' }, actorId = LOCAL_USER_ID) {
  const index = (data.joinRequests || []).findIndex(item => item.id === requestId);
  if (index < 0) throw new Error('加入申请不存在或已处理');
  const request = data.joinRequests[index];
  const space = data.workspaces.find(item => item.id === request.workspaceId);
  if (!space) { data.joinRequests.splice(index, 1); throw new Error('空间已不存在'); }
  if (workspaceType(space) === 'project' && space.createdBy !== actorId) throw new Error('只有空间创建者可以处理加入申请');
  data.joinRequests.splice(index, 1);
  if (!approve) return { approved: false, request, space };
  if (!['viewer', 'editor'].includes(role)) throw new Error('项目权限无效');
  const displayName = String(name || request.name || '').trim().slice(0, 40) || request.userId;
  space.members ||= [];
  let member = space.members.find(item => item.wecomUserId === request.userId);
  if (member) Object.assign(member, { name: displayName, role, status: 'wecom' });
  else { member = { id: crypto.randomUUID(), name: displayName, wecomUserId: request.userId, role, status: 'wecom', addedAt: new Date().toISOString() }; space.members.push(member); }
  return { approved: true, request, space, member };
}

function removePendingProjectMember(data, input, actorId = LOCAL_USER_ID) {
  const workspace = data.workspaces.find(space => space.id === input.workspaceId && ['project', 'team'].includes(workspaceType(space)));
  if (!workspace) throw new Error('团队或项目空间不存在');
  if (workspaceType(workspace) === 'project' && workspace.createdBy !== actorId) throw new Error('只有空间创建者可以管理成员');
  const index = (workspace.members || []).findIndex(member => member.id === input.memberId && ['pending', 'wecom', 'feishu'].includes(member.status));
  if (index < 0) throw new Error('待邀请或企微成员不存在');
  workspace.members.splice(index, 1);
  return true;
}

function updatePendingProjectMemberRole(data, input, actorId = LOCAL_USER_ID) {
  const workspace = data.workspaces.find(space => space.id === input.workspaceId && ['project', 'team'].includes(workspaceType(space)));
  if (!workspace) throw new Error('团队或项目空间不存在');
  if (workspaceType(workspace) === 'project' && workspace.createdBy !== actorId) throw new Error('只有空间创建者可以管理成员');
  if (!['viewer','editor'].includes(input.role)) throw new Error('项目权限无效');
  const member = (workspace.members || []).find(item => item.id === input.memberId && ['pending', 'wecom', 'feishu'].includes(item.status));
  if (!member) throw new Error('待邀请或企微成员不存在');
  member.role = input.role;
  return member;
}

module.exports = { PERSONAL_WORKSPACE_ID, PERSONAL_WORKSPACE_NAME, personalWorkspace, ensurePersonalWorkspace, requestToJoin, decideJoinRequest, LOCAL_USER_ID, workspaceType, migrateLegacyWorkspaceMembers, createProjectWorkspace, addProjectMember, linkWecomProjectMember, linkFeishuProjectMember, removePendingProjectMember, updatePendingProjectMemberRole };
