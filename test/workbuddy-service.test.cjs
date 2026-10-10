const test = require('node:test');
const assert = require('node:assert/strict');
const { checkWorkBuddy, sendWorkBuddyMessage, readWorkBuddyReply, callWorkBuddy } = require('../electron/workbuddy-service.cjs');

const json = body => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });

test('WorkBuddy 官方本地助理接口：在线、发送、按消息 ID 查询回复', async () => {
  const calls = [];
  const config = { workbuddyAccessToken: 'private-test-token' };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') return json({ code: 0, data: { message_id: 'msg-001' } });
    if (url.includes('message_id=')) return json({ code: 0, data: { messages: [{ message_id: 'msg-001', role: 'user', msg_type: 'text', content: ['测试'] }, { message_id: 'msg-002', role: 'assistant', msg_type: 'text', content: ['收到测试消息'] }] } });
    return json({ code: 0, data: { online: true } });
  };
  assert.equal((await checkWorkBuddy(config, fetchImpl)).ok, true);
  assert.equal(await sendWorkBuddyMessage(config, '只回复测试成功', fetchImpl), 'msg-001');
  assert.equal(await readWorkBuddyReply(config, 'msg-001', fetchImpl), '收到测试消息');
  assert.equal(calls[1].url, 'https://www.workbuddy.cn/openapi/v2/localassistant/message');
  assert.deepEqual(JSON.parse(calls[1].options.body), { content: '只回复测试成功', msg_type: 'text' });
  assert.equal(calls[2].url, 'https://www.workbuddy.cn/openapi/v2/localassistant/message?message_id=msg-001');
  assert.ok(calls.every(call => call.options.headers.authorization === 'Bearer private-test-token' && call.options.redirect === 'error'));
});

test('WorkBuddy 只转发当前用户输入；等待回复不泄露令牌', async () => {
  const calls = [];
  const config = { workbuddyAccessToken: 'private-test-token' };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return json(options.method === 'POST' ? { code: 0, data: { message_id: 'msg-002' } } : { code: 0, data: { messages: [] } });
  };
  const output = await callWorkBuddy(config, [{ role: 'user', text: '旧消息' }, { role: 'assistant', text: '旧回复' }, { role: 'user', text: '新消息' }], fetchImpl, async () => {});
  assert.equal(JSON.parse(calls[0].options.body).content, '新消息');
  assert.equal(calls.length, 7);
  assert.equal(output.pending, true);
  assert.equal(JSON.stringify(output).includes('private-test-token'), false);
});

test('WorkBuddy 授权缺失和接口错误均明确失败', async () => {
  await assert.rejects(sendWorkBuddyMessage({}, '测试'), /开放平台授权/);
  await assert.rejects(checkWorkBuddy({ workbuddyAccessToken: 'x' }, async () => json({ code: 1101, msg: 'token private detail' })), /错误码 1101/);
  await assert.rejects(readWorkBuddyReply({ workbuddyAccessToken: 'x' }, 'msg-1', async () => json({ code: 0, data: { messages: [
    { message_id: 'msg-2', role: 'user', content: ['另一条消息'] },
    { message_id: 'msg-3', role: 'assistant', msg_type: 'text', content: ['另一条回复'] }
  ] } })), /无法确定回复属于当前工作/);
});
