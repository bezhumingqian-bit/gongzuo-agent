const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemory, extractCandidate, getApplicableMemories } = require('../electron/memory-service.cjs');

test('个人记忆和团队记忆只进入各自的上下文', () => {
  const myPreference = createMemory({ title: '简短回复', content: '我的回复尽量简短', category: '偏好' }, { scope: 'personal' });
  const productRule = createMemory({ title: '发布评审', content: '产品团队发布前需评审', category: '流程' }, { scope: 'team', workspaceId: 'product' });
  const opsRule = createMemory({ title: '预算审批', content: '运营预算要审批', category: '流程' }, { scope: 'team', workspaceId: 'operations' });
  const product = getApplicableMemories([myPreference], [productRule, opsRule], 'product');
  assert.deepEqual(product.personal.map(item => item.id), [myPreference.id]);
  assert.deepEqual(product.team.map(item => item.id), [productRule.id]);
  assert.equal(myPreference.workspaceId, null);
  assert.equal(productRule.ownerId, null);
  assert.deepEqual(getApplicableMemories([myPreference], [productRule, opsRule], 'operations', 'another-user').personal, []);
});

test('归档的记忆不再进入新工作上下文', () => {
  const memory = createMemory({ title: '旧约定', content: '不再适用的流程' }, { scope: 'team', workspaceId: 'product' });
  memory.status = 'archived';
  assert.deepEqual(getApplicableMemories([], [memory], 'product').team, []);
});

test('从明确的任务消息提取待确认草稿并保留来源', () => {
  const candidate = extractCandidate({
    id: 'task-1',
    title: '客户反馈',
    goal: '整理客户反馈',
    workspace: '产品团队',
    messages: [{ role: 'user', text: '记住：每周五给客户反馈做一次摘要' }]
  });
  assert.equal(candidate.content, '记住：每周五给客户反馈做一次摘要');
  assert.equal(candidate.sourceTaskId, 'task-1');
  assert.equal(candidate.workspace, '产品团队');
});
