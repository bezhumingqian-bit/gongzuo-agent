function resolveMentions(data, task, memberIds) {
  if (!Array.isArray(memberIds) || memberIds.length > 10 || memberIds.some(id => typeof id !== 'string')) {
    throw new Error('提及的成员无效');
  }
  const ids = [...new Set(memberIds)];
  const workspace = data.workspaces.find(item => item.name === task.workspace);
  if (!workspace && ids.length) throw new Error('工作空间不存在');
  return ids.map(id => {
    const member = (workspace.members || []).find(item => item.id === id && ['active', 'wecom'].includes(item.status) && item.id !== 'local-user');
    if (!member) throw new Error('只能提及当前空间中已关联的同事');
    return { memberId: member.id, name: member.name || member.email || '同事' };
  });
}

module.exports = { resolveMentions };
