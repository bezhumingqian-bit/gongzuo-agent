function resolveMentions(data, task, memberIds) {
  if (!Array.isArray(memberIds) || memberIds.length > 10 || memberIds.some(id => typeof id !== 'string')) {
    throw new Error('提及的成员无效');
  }
  const ids = [...new Set(memberIds)];
  const spaces = taskMemberSpaces(data, task);
  if (!spaces.length && ids.length) throw new Error('工作空间不存在');
  return ids.map(id => {
    const member = findMember(spaces, id);
    if (!member) throw new Error('只能提及这项工作所在空间（含关联空间）中已加入的同事');
    return { memberId: member.id, name: member.name || member.email || '同事' };
  });
}

// Members of a work come from its primary space and its related spaces.
function taskMemberSpaces(data, task) {
  return [task.workspace, ...(task.relatedWorkspaces || [])]
    .map(name => (data.workspaces || []).find(item => item.name === name))
    .filter(Boolean);
}

function findMember(spaces, id) {
  for (const space of spaces) {
    const member = (space.members || []).find(item => item.id === id && ['active', 'wecom', 'feishu'].includes(item.status) && item.id !== 'local-user');
    if (member) return member;
  }
  return null;
}

module.exports = { resolveMentions, taskMemberSpaces, findMember };
