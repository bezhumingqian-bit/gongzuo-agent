const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../electron/store.cjs');
const { actors, workspaceRole, authorize, mayUsePersonalMemory, changeRisk, classifyChannelEvent } = require('../electron/contracts/policy.cjs');
const { createSourceEvent, sourceKey, wecomBotEvent, recordWecomEvent, channelIngestEvent, recordChannelEvent, hasChannelEvent } = require('../electron/contracts/source-event.cjs');
const { WorkOperations, WorkError, findTask } = require('../electron/contracts/work-operations.cjs');

const project = { id: 'p1', name: '项目甲', type: 'project', members: [
  { id: 'm1', wecomUserId: 'editor_1', role: 'editor', status: 'wecom' },
  { id: 'm2', wecomUserId: 'viewer_1', role: 'viewer', status: 'wecom' },
  { id: 'm3', email: 'x@corp.com', role: 'editor', status: 'pending' }
] };

test('策略：本机用户拥有全部空间；企微成员只按显式关联的角色；待邀请成员无权限', () => {
  assert.equal(workspaceRole(project, actors.local()), 'owner');
  assert.equal(workspaceRole(project, actors.wecom('editor_1')), 'editor');
  assert.equal(workspaceRole(project, actors.wecom('viewer_1')), 'viewer');
  assert.equal(workspaceRole(project, actors.wecom('stranger')), null);
  assert.equal(workspaceRole(project, actors.wecom('x@corp.com')), null);
  assert.deepEqual(authorize(actors.wecom('viewer_1'), 'work.view', project), { allowed: true, role: 'viewer', reason: null });
  assert.equal(authorize(actors.wecom('viewer_1'), 'work.append', project).reason, 'read-only');
  assert.equal(authorize(actors.wecom('stranger'), 'work.view', project).reason, 'no-access');
  assert.equal(authorize(actors.workbuddy(), 'work.create', project).allowed, true);
  assert.equal(authorize(actors.local(), 'work.create', undefined).reason, 'no-access', '空间不存在时拒绝');
  assert.throws(() => authorize(actors.local(), 'work.delete', project), /未知操作/);
});

test('策略：摘要规则只能在配置的空间建工作；企微发起的工作不带个人记忆', () => {
  const rule = actors.rule('wecom-summary', 'p1', 'dayuan_1');
  assert.equal(authorize(rule, 'work.create', project).allowed, true);
  assert.equal(authorize(rule, 'work.create', { id: 'other', members: [] }).reason, 'no-access');
  assert.equal(mayUsePersonalMemory(null), true);
  assert.equal(mayUsePersonalMemory({ userId: 'editor_1' }), false);
});

test('审批边界：高影响字段和未知字段需确认，进度类可撤销自动更新', () => {
  for (const field of ['owner', 'deadline', 'permissions', 'budget', 'externalSend', 'publish', 'delete', 'taskDone']) assert.equal(changeRisk(field), 'approval');
  for (const field of ['progress', 'note', 'evidence']) assert.equal(changeRisk(field), 'reversible');
  assert.equal(changeRisk('somethingNew'), 'approval');
  assert.equal(classifyChannelEvent({ text: '接口已经联调，验收通过' }).action, 'auto-update');
  assert.equal(classifyChannelEvent({ text: '验收通过，但负责人改成王宁' }).action, 'suggest', '高影响优先于完成语句');
  assert.equal(classifyChannelEvent({ text: '' }).reason, 'empty');
});

test('来源事件：企微帧映射为标准字段，非法帧忽略，按来源+连接+消息 ID 去重', () => {
  const single = wecomBotEvent({ body: { msgid: 'm-1', from: { userid: 'zhang_1' }, chattype: 'single', text: { content: '查看 abcd' } } }, { receivedAt: '2026-10-13T00:00:00.000Z' });
  assert.equal(single.source, 'wecom');
  assert.equal(single.actorId, 'zhang_1');
  assert.equal(single.conversationId, 'zhang_1');
  assert.equal(single.conversationType, 'single');
  assert.deepEqual(single.permissionScope, { kind: 'wecom-member', userId: 'zhang_1' });
  assert.equal(sourceKey(single), 'wecom:bot:m-1');
  assert.ok(Object.isFrozen(single));
  const group = wecomBotEvent({ body: { msgid: 'm-2', from: { userid: 'zhang_1' }, chattype: 'group', chatid: 'g-1', text: { content: 'x' } } });
  assert.equal(group.conversationId, 'g-1');
  assert.equal(wecomBotEvent({ body: { msgid: 'm-3', from: { userid: 'bad user!' } } }), null);
  assert.equal(wecomBotEvent({ body: { from: { userid: 'zhang_1' } } }), null);
  assert.throws(() => createSourceEvent({ source: 'feishu', sourceId: '', actorId: 'a' }), /外部消息 ID/);
});

test('来源事件：按旧语义落库——元数据全记、单聊正文进收件、群聊正文不存、重复不再写', () => {
  const data = {};
  const single = wecomBotEvent({ body: { msgid: 'm-1', from: { userid: 'zhang_1' }, chattype: 'single', text: { content: '你好' } } });
  const group = wecomBotEvent({ body: { msgid: 'm-2', from: { userid: 'zhang_1' }, chattype: 'group', chatid: 'g', text: { content: '群里' } } });
  assert.equal(recordWecomEvent(data, single).duplicate, false);
  assert.equal(recordWecomEvent(data, single).duplicate, true);
  recordWecomEvent(data, group);
  assert.deepEqual(data.wecomEvents.map(item => Object.keys(item).sort()), [['at', 'chatType', 'msgId', 'userId'], ['at', 'chatType', 'msgId', 'userId']]);
  assert.deepEqual(data.inboundMessages.map(item => item.text), ['你好']);

  const { event, taskId } = channelIngestEvent({ source: 'feishu', externalId: 'f-1', sender: '王宁', text: '已完成', taskId: 't-1' }, () => 'gen');
  assert.equal(taskId, 't-1');
  assert.equal(recordChannelEvent(data, event, taskId, { action: 'archive' }, 'id-1').duplicate, false);
  assert.equal(hasChannelEvent(data, event), true);
  assert.deepEqual(Object.keys(data.channelEvents[0]).sort(), ['decision', 'externalId', 'id', 'occurredAt', 'sender', 'source', 'taskId', 'text']);
  assert.throws(() => channelIngestEvent({ source: 'feishu', sender: 'a', text: 'x' }, () => 'gen'), /任务 ID/);
});

test('工作操作：统一校验空间与角色，返回可映射的错误码；短 ID 需唯一', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gz-ops-'));
  try {
    const store = new JsonStore(path.join(dir, 'data.json'), () => ({ workspaces: [project], tasks: [
      { id: 'abcd-1111', workspace: '项目甲', messages: [] }, { id: 'abcd-2222', workspace: '项目甲', messages: [] }, { id: 'ffff-0000', workspace: '项目甲', messages: [] }
    ] }));
    await store.initialize();
    const calls = [];
    const taskRunner = {
      create: async (...args) => { calls.push(['create', ...args]); return { id: 'new-1' }; },
      append: async (...args) => { calls.push(['append', ...args]); return { id: 'msg-1' }; }
    };
    const ops = new WorkOperations({ store, taskRunner });
    const code = promise => promise.then(() => null, error => { assert.ok(error instanceof WorkError); return error.code; });

    assert.equal(await code(ops.create(actors.wecom('stranger'), { workspace: '项目甲', goal: 'x' })), 'no-access');
    assert.equal(await code(ops.create(actors.wecom('viewer_1'), { workspace: '项目甲', goal: 'x' })), 'read-only');
    assert.equal(await code(ops.create(actors.local(), { workspace: '不存在', goal: 'x' })), 'workspace-not-found');
    await ops.create(actors.wecom('editor_1'), { workspace: '项目甲', goal: '写报告', origin: { userId: 'editor_1' }, options: { agentMode: 'codex' } });
    assert.deepEqual(calls[0], ['create', '写报告', '项目甲', [], { userId: 'editor_1' }, { agentMode: 'codex' }]);
    await ops.create(actors.local(), { workspaceId: 'p1', goal: '按 ID' });
    assert.equal(calls[1][2], '项目甲');

    assert.equal(await code(ops.view(actors.local(), 'abcd')), 'task-not-found', '前缀不唯一');
    assert.equal((await ops.view(actors.wecom('viewer_1'), 'ffff')).task.id, 'ffff-0000');
    assert.equal(await code(ops.append(actors.wecom('viewer_1'), 'ffff', '进展')), 'read-only');
    const { message } = await ops.append(actors.wecom('editor_1'), 'ffff', '进展', { origin: { userId: 'editor_1' } });
    assert.equal(message.id, 'msg-1');
    assert.deepEqual(calls.at(-1), ['append', 'ffff-0000', '进展', [], [], { userId: 'editor_1' }]);
    assert.equal(findTask({ tasks: [{ id: 'abc-1' }] }, 'abc-1').id, 'abc-1');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
