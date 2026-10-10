const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../electron/store.cjs');
const { normalizeSettings, defaultSettings } = require('../electron/settings-service.cjs');
const { matchWorkflow, workflowGoal } = require('../electron/workflow-service.cjs');
const { WecomBotBridge } = require('../electron/wecom-bot-service.cjs');

test('摘要规则默认关闭，启用时必须限定来源与空间', () => {
  const defaults = defaultSettings();
  assert.equal(defaults.workflow.enabled, false);
  assert.throws(() => normalizeSettings({ ...defaults, workflow: { ...defaults.workflow, enabled: true } }), /来源 UserID 和目标空间/);
  const rule = { ...defaults.workflow, enabled: true, senderUserId: 'dayuan_1', workspaceId: 'product' };
  assert.equal(matchWorkflow(rule, 'someone_else', '日报：已完成验收'), null);
  assert.equal(matchWorkflow(rule, 'dayuan_1', '普通聊天'), null);
  assert.equal(matchWorkflow(rule, 'dayuan_1', '日报：已完成验收'), '已完成验收');
  assert.match(workflowGoal(rule, '已完成验收'), /只提出更新建议/);
});

test('企微摘要只由匹配的来源生成待确认工作，重复消息不重复派发', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-workflow-'));
  try {
    const store = new JsonStore(path.join(dir, 'data.json'), () => ({
      workspaces: [{ id: 'product', name: '产品团队' }], tasks: []
    }));
    await store.initialize();
    const calls = [];
    const workflow = { ...defaultSettings().workflow, enabled: true, senderUserId: 'dayuan_1', workspaceId: 'product' };
    const bridge = new WecomBotBridge({
      store,
      settingsService: { getRuntimeConfig: async () => ({ workflow, workbuddyAccessToken: 'test-token' }) },
      taskRunner: { create: async (...args) => { calls.push(args); return { id: 'task-1' }; } }
    });
    const replies = [];
    bridge.client = { replyStream: async (_frame, _id, content) => { replies.push(content); } };
    const frame = (msgid, userid, content) => ({ body: { msgid, from: { userid }, chattype: 'group', chatid: 'group-1', text: { content } } });
    await bridge.handleFrame(frame('msg-1', 'other', '@共作 日报：已完成验收'));
    assert.equal(calls.length, 0);
    await bridge.handleFrame(frame('msg-2', 'dayuan_1', '@共作 日报：已完成验收'));
    await bridge.handleFrame(frame('msg-2', 'dayuan_1', '@共作 日报：已完成验收'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], '产品团队');
    assert.equal(calls[0][4].agentMode, 'workbuddy');
    assert.equal(calls[0][4].workflow.sourceMsgId, 'msg-2');
    assert.match(replies.at(-1), /已处理/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
