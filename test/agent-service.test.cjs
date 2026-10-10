const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentService, classifyChannelEvent, createLocalTask } = require('../electron/agent-service.cjs');

test('明确完成语句可以形成可撤销的低风险自动更新', () => {
  const result = classifyChannelEvent({ text: '统计口径已确认，移动端问题也处理完了。' });
  assert.equal(result.action, 'auto-update');
  assert.equal(result.patch.progressConfirmed, true);
});

test('负责人和截止时间变化必须请求确认', () => {
  const result = classifyChannelEvent({ text: '把负责人改成王宁，截止时间延后到周五。' });
  assert.equal(result.action, 'suggest');
});

test('普通讨论只作为任务依据归档', () => {
  const result = classifyChannelEvent({ text: '我倾向于沿用上个季度的统计口径。' });
  assert.equal(result.action, 'archive');
});

test('本地 Agent 创建结构完整的任务', () => {
  const task = createLocalTask({ goal: '做一个客户反馈管理小应用', workspace: '产品团队' });
  assert.equal(task.workspace, '产品团队');
  assert.equal(task.status, 'running');
  assert.equal(task.messages[0].role, 'user');
  assert.equal(task.steps.length, 3);
});

test('WorkBuddy 没有访问令牌时走本机交接，不在进程内调用', async () => {
  const agent = new AgentService();
  assert.equal(agent.isConfigured({ agent: { mode: 'workbuddy' }, workbuddyAccessToken: null }), true);
  assert.equal(agent.isConfigured({ agent: { mode: 'workbuddy' }, workbuddyAccessToken: 'token' }), true);
  assert.equal(await agent.answer({ messages: [{ role: 'user', text: '测试' }] }, { agent: { mode: 'workbuddy' } }), null);
  const status = agent.getStatus({ agent: { mode: 'workbuddy' }, hasWorkbuddyAccessToken: false });
  assert.equal(status.label, 'WorkBuddy 本机连接');
  assert.match(status.detail, /本机连接器领取/);
});

test('官方模型未配置密钥时不会被标为可执行', () => {
  const agent = new AgentService();
  for (const provider of ['kimi', 'deepseek']) {
    const config = { agent: { mode: 'built-in' }, model: { provider, modelId: 'example' } };
    assert.equal(agent.isConfigured(config), false);
    assert.equal(agent.isConfigured({ ...config, modelKey: 'test-key' }), true);
  }
});
