const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../electron/store.cjs');
const { sendWecomText, WecomDelivery } = require('../electron/wecom-service.cjs');

const config = { wecom: { organizationId: 'corp-test', applicationId: '100001' }, wecomSecret: 'private-secret' };
const json = body => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });

test('企业微信只向一个指定成员发送当前文字，不返回 Secret 或 token', async () => {
  const calls = [];
  const result = await sendWecomText(config, 'user_1', '请看这条工作消息', async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1
      ? json({ errcode: 0, access_token: 'private-access-token', expires_in: 7200 })
      : json({ errcode: 0, errmsg: 'ok', msgid: 'message-1', invaliduser: '' });
  });
  assert.equal(result.externalMessageId, 'message-1');
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).pathname, '/cgi-bin/gettoken');
  assert.equal(new URL(calls[1].url).pathname, '/cgi-bin/message/send');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    touser: 'user_1', msgtype: 'text', agentid: 100001,
    text: { content: '请看这条工作消息' }, safe: 0
  });
  assert.equal(JSON.stringify(result).includes('private-'), false);
  await assert.rejects(() => sendWecomText(config, '@all', '通知所有人'), /不支持群发/);
  await assert.rejects(() => sendWecomText(config, 'user_1|user_2', '通知'), /不支持群发/);
  await assert.rejects(() => sendWecomText(config, 'user_1', '中'.repeat(700)), /2048 字节/);
});

test('企业微信拒绝无效成员时不把接口成功误标为送达', async () => {
  let count = 0;
  await assert.rejects(() => sendWecomText(config, 'missing-user', '测试', async () => {
    count++;
    return count === 1 ? json({ errcode: 0, access_token: 'token' }) : json({ errcode: 0, invaliduser: 'missing-user' });
  }), /没有接受该收件成员/);
});

async function deliverySetup(send) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-wecom-test-'));
  const store = new JsonStore(path.join(directory, 'workspace.json'), () => ({ tasks: [{ id: 'task-1', messages: [{ id: 'message-1', role: 'user', text: '只发这一条' }] }] }));
  await store.initialize();
  const delivery = new WecomDelivery({ store, settingsService: { getRuntimeConfig: async () => config }, publish: () => {}, send });
  return { directory, store, delivery };
}

test('从已保存工作消息发送，记录接口接受并防止重复发送', async () => {
  let sentText;
  const { directory, store, delivery } = await deliverySetup(async (_config, recipient, text) => {
    sentText = text;
    assert.equal(recipient, 'user_1');
    return { externalMessageId: 'wecom-id' };
  });
  try {
    const result = await delivery.sendTaskMessage('task-1', 'message-1', 'user_1');
    assert.equal(sentText, '只发这一条');
    assert.equal(result.status, 'sent');
    assert.equal((await store.read()).tasks[0].messages[0].wecomDelivery.externalMessageId, 'wecom-id');
    await assert.rejects(() => delivery.sendTaskMessage('task-1', 'message-1', 'user_1'), /勿重复发送/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('请求可能已到企微时保留结果未知状态，应用重启也不自动重发', async () => {
  const { directory, store, delivery } = await deliverySetup(async () => {
    const error = new Error('发送结果未知；请先在企业微信核对');
    error.deliveryUnknown = true;
    throw error;
  });
  try {
    const result = await delivery.sendTaskMessage('task-1', 'message-1', 'user_1');
    assert.equal(result.status, 'unknown');
    await assert.rejects(() => delivery.sendTaskMessage('task-1', 'message-1', 'user_1'), /勿重复发送/);
    await store.update(data => { data.tasks[0].messages[0].wecomDelivery.status = 'sending'; return data; });
    await delivery.markInterrupted();
    assert.equal((await store.read()).tasks[0].messages[0].wecomDelivery.status, 'unknown');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
