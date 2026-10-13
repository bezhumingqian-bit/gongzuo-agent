const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { JsonStore } = require('../electron/store.cjs');
const { fetchVisibleMembers, sendViaWecom, WecomDelivery } = require('../electron/wecom-service.cjs');
const { linkWecomProjectMember } = require('../electron/workspace-service.cjs');
const { WecomBotBridge, parseCommand } = require('../electron/wecom-bot-service.cjs');
const { recordInboundMessage } = require('../electron/channel-inbox.cjs');

test('统一消息收件按渠道与事件去重', () => {
  const data = {};
  const base = { eventId: 'same-id', senderId: 'person', conversationId: 'chat', text: '你好', receivedAt: '2026-09-29T02:00:00Z' };
  recordInboundMessage(data, { ...base, channel: 'wecom' });
  recordInboundMessage(data, { ...base, channel: 'wecom' });
  recordInboundMessage(data, { ...base, channel: 'feishu' });
  assert.deepEqual(data.inboundMessages.map(item => item.id), ['wecom:same-id', 'feishu:same-id']);
  assert.equal(data.inboundMessages[1].taskId, null);
});

test('企微目录只同步可见成员标识，项目创建者可绑定并撤销机器人参与', async () => {
  const config = { wecom: { organizationId: 'corp', applicationId: '10001' }, wecomSecret: 'secret' };
  const members = await fetchVisibleMembers(config, async url => ({ ok: true, text: async () => JSON.stringify(url.includes('gettoken') ?
    { errcode: 0, access_token: 'private-token' } : { errcode: 0, userlist: [{ userid: 'zhang_1', name: '张宁', mobile: 'secret-phone' }, { userid: '@all', name: '所有人' }] }) }));
  assert.deepEqual(members, [{ userId: 'zhang_1', name: '张宁' }]);
  const data = { workspaces: [{ id: 'project-1', type: 'project', name: '项目甲', createdBy: 'local-user', members: [] }], wecomDirectory: { members } };
  assert.throws(() => linkWecomProjectMember(data, { workspaceId: 'project-1', userId: 'zhang_1' }, 'other'), /只有空间创建者/);
  const member = linkWecomProjectMember(data, { workspaceId: 'project-1', userId: 'zhang_1', role: 'editor' });
  assert.equal(member.wecomUserId, 'zhang_1');
  assert.equal(member.status, 'wecom');
  assert.equal(member.mobile, undefined);
});

test('共作 @ 成员按 UserID 定向推送并记录每人的结果', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-wecom-mention-'));
  try {
    const store = new JsonStore(path.join(dir, 'data.json'), () => ({
      workspaces: [{ name: '项目甲', members: [{ id: 'm1', name: '张宁', wecomUserId: 'zhang_1', status: 'wecom' }] }],
      tasks: [{ id: 'task-1', title: '完成报告', workspace: '项目甲', messages: [{ id: 'message-1', role: 'user', text: '@张宁 请确认', mentions: [{ memberId: 'm1', name: '张宁' }] }] }]
    }));
    await store.initialize();
    const sends = [];
    const delivery = new WecomDelivery({ store, settingsService: { getRuntimeConfig: async () => ({}) }, publish: () => {}, send: async (_config, userId, content) => { sends.push({ userId, content }); return { externalMessageId: 'sent-1' }; } });
    const result = await delivery.sendMentions('task-1', 'message-1');
    assert.equal(result[0].status, 'sent');
    assert.equal(sends[0].userId, 'zhang_1');
    assert.match(sends[0].content, /gongzuo:\/\/task\/task-1/);
    assert.equal((await store.read()).tasks[0].messages[0].mentionDelivery, 'sent');
    const assignment = await delivery.assignTask('task-1', 'm1');
    assert.equal(assignment.status, 'sent');
    assert.equal((await store.read()).tasks[0].assignee.wecomUserId, 'zhang_1');
    await assert.rejects(() => delivery.assignTask('task-1', 'm1'), /重复发送/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('企微机器人只按明确指令操作授权空间，重复消息不重复创建', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-wecom-bot-'));
  try {
    const store = new JsonStore(path.join(dir, 'data.json'), () => ({
      workspaces: [{ id: 'project-1', name: '项目甲', type: 'project', members: [{ id: 'm1', name: '张宁', wecomUserId: 'zhang_1', role: 'editor', status: 'wecom' }] }], tasks: []
    }));
    await store.initialize();
    const calls = [];
    const taskRunner = { create: async (content, workspace, docs, origin) => { calls.push({ content, workspace, origin }); return { id: 'task-1234', title: content }; }, append: async (...args) => { calls.push(args); } };
    const published = [];
    const bridge = new WecomBotBridge({ store, settingsService: { getRuntimeConfig: async () => ({ wecom: {} }) }, taskRunner, publish: data => published.push(data.wecomEvents.at(-1)) });
    const replies = [];
    bridge.client = { replyStream: async (_frame, _id, content) => { replies.push(content); } };
    const frame = (msgid, userid, content) => ({ body: { msgid, from: { userid }, chattype: 'single', text: { content } } });
    await bridge.handleFrame(frame('msg-1', 'stranger', '新建 项目甲：生成报告'));
    assert.equal(calls.length, 0);
    await bridge.handleFrame(frame('msg-2', 'zhang_1', '新建 项目甲：生成报告'));
    await bridge.handleFrame(frame('msg-2', 'zhang_1', '新建 项目甲：生成报告'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].origin.userId, 'zhang_1');
    assert.equal((await store.read()).wecomEvents.length, 2);
    assert.equal((await store.read()).inboundMessages[1].text, '新建 项目甲：生成报告');
    assert.equal(published.length, 2);
    assert.match(replies.at(-1), /已处理/);
    assert.equal(parseCommand('今天的闲聊').type, 'help');
    const pushed = [];
    bridge.client.sendMessage = async (target, body) => { pushed.push({ target, body }); };
    await bridge.sendAgentAnswer({ taskId: 'task-1234', answer: { text: '团队内部结论' }, origin: { chatType: 'group', chatId: 'group-1', userId: 'zhang_1' } });
    assert.equal(pushed[0].target, 'zhang_1');
    assert.notEqual(pushed[0].target, 'group-1');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('企微机器人把最近单聊正文写入统一收件，群聊正文不入库', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-wecom-inbox-'));
  try {
    const store = new JsonStore(path.join(dir, 'data.json'), () => ({ workspaces: [], tasks: [] }));
    await store.initialize();
    const bridge = new WecomBotBridge({ store, settingsService: { getRuntimeConfig: async () => ({ wecom: {} }) }, taskRunner: {} });
    bridge.client = { replyStream: async () => {} };
    for (let i = 0; i < 51; i++) {
      await bridge.handleFrame({ body: { msgid: `inbox-${i}`, from: { userid: 'test_user' }, chattype: 'single', text: { content: `来信 ${i}` } } });
    }
    await bridge.handleFrame({ body: { msgid: 'group-1', from: { userid: 'test_user' }, chattype: 'group', text: { content: '群内消息' } } });
    const data = await store.read();
    assert.equal(data.wecomEvents.length, 52);
    assert.equal(data.wecomEvents[0].text, undefined);
    assert.equal(data.inboundMessages.length, 50);
    assert.equal(data.inboundMessages[0].text, '来信 1');
    assert.equal(data.inboundMessages.at(-1).text, '来信 50');
    assert.equal(data.inboundMessages[0].channel, 'wecom');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('机器人长连接可单独收发工作消息，自建应用仅作备用', async () => {
  const bridge = new WecomBotBridge({ store: {}, settingsService: {}, taskRunner: {} });
  const sent = [];
  bridge.status = '已连接';
  bridge.client = { sendMessage: async (userId, body) => { sent.push({ userId, body }); return { errcode: 0, body: { msgid: 'bot-1' } }; } };
  const config = { wecom: { botId: 'bot-1' }, wecomBotSecret: 'private-bot-secret' };
  const botResult = await sendViaWecom(config, 'zhang_1', '测试工作消息', bridge, () => { throw new Error('不应调用应用接口'); });
  assert.equal(botResult.channel, 'bot');
  assert.equal(botResult.externalMessageId, 'bot-1');
  assert.deepEqual(sent[0], { userId: 'zhang_1', body: { msgtype: 'markdown', markdown: { content: '测试工作消息' } } });
  await assert.rejects(() => bridge.sendText('@all', '测试'), /不支持群发/);
  bridge.client.sendMessage = async () => { throw { errcode: 44012, errmsg: '不要显示的服务端细节' }; };
  await assert.rejects(() => bridge.sendText('zhang_1', '测试'), error => error.deliveryUnknown === false && /44012/.test(error.message) && !error.message.includes('服务端细节'));
  bridge.client.sendMessage = async () => { throw new Error('WebSocket not connected, unable to send data'); };
  await assert.rejects(() => bridge.sendText('zhang_1', '测试'), error => error.deliveryUnknown === false && /长连接已断开/.test(error.message));
  bridge.client.sendMessage = async () => { throw new Error('SDK 内部信息'); };
  await assert.rejects(() => bridge.sendText('zhang_1', '测试'), error => error.deliveryUnknown === true && !error.message.includes('SDK 内部信息'));
  bridge.status = '已断开，等待重连';
  await assert.rejects(() => sendViaWecom(config, 'zhang_1', '测试', bridge), /尚未连接/);
  const appResult = await sendViaWecom({ ...config, wecom: { ...config.wecom, organizationId: 'corp', applicationId: '1001' }, wecomSecret: 'app-secret' }, 'zhang_1', '测试', bridge, async () => ({ channel: 'application' }));
  assert.equal(appResult.channel, 'application');
});

test('企微接收诊断区分已认证与实际收到消息', async () => {
  const client = new EventEmitter();
  client.connect = async () => { client.emit('authenticated'); };
  client.disconnect = () => {};
  const bridge = new WecomBotBridge({
    store: {},
    settingsService: { getRuntimeConfig: async () => ({ wecom: { botId: 'test-bot' }, wecomBotSecret: 'test-secret' }) },
    taskRunner: {},
    clientFactory: () => client
  });
  await bridge.restart();
  assert.equal(bridge.status, '已连接');
  assert.equal(bridge.lastTextFrameAt, null);
  client.emit('message.text', { body: {} });
  await Promise.resolve();
  assert.ok(bridge.lastTextFrameAt);
  assert.equal(bridge.lastTextFrameStatus, '消息格式不匹配');
});

test('契约重构后企微拒绝文案不变：无权、只读、找不到工作、空间不存在', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-wecom-deny-'));
  try {
    const store = new JsonStore(path.join(dir, 'data.json'), () => ({
      workspaces: [{ id: 'p1', name: '项目甲', type: 'project', members: [{ id: 'm1', wecomUserId: 'viewer_1', role: 'viewer', status: 'wecom' }] }],
      tasks: [{ id: 'task-abcd', title: '报告', workspace: '项目甲', messages: [] }]
    }));
    await store.initialize();
    const taskRunner = { create: async () => { throw new Error('不应创建'); }, append: async () => { throw new Error('不应追加'); } };
    const bridge = new WecomBotBridge({ store, settingsService: { getRuntimeConfig: async () => ({ wecom: {} }) }, taskRunner });
    const replies = [];
    bridge.client = { replyStream: async (_f, _id, content) => { replies.push(content); } };
    let n = 0;
    const say = (userid, content) => bridge.handleFrame({ body: { msgid: `d-${n++}`, from: { userid }, chattype: 'single', text: { content } } });
    await say('viewer_1', '新建 项目甲：写报告');
    await say('viewer_1', '新建 不存在：写报告');
    await say('viewer_1', '更新 task-abcd：已完成');
    await say('stranger', '查看 task-abcd');
    await say('viewer_1', '查看 zzzz');
    await say('viewer_1', '查看 task');
    assert.deepEqual(replies.slice(0, 5), [
      '你尚未获得这个空间的企微协作权限。',
      '工作空间不存在，请使用共作中的准确空间名称。',
      '你在这个项目只有只读权限。',
      '你尚未获得这个空间的企微参与权限。',
      '找不到唯一的工作 ID，请使用完整 ID。'
    ]);
    assert.match(replies[5], /「报告」[\s\S]*gongzuo:\/\/task\/task-abcd/, '只读成员可以用短 ID 查看');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
