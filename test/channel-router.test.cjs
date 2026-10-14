const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { channelsFor, reachability, notifyMember } = require('../electron/channel-router.cjs');
const { sendFeishuText, feishuReceiver, tokenCache } = require('../electron/feishu-service.cjs');
const { WecomDelivery } = require('../electron/wecom-service.cjs');
const { JsonStore } = require('../electron/store.cjs');
const { linkFeishuProjectMember } = require('../electron/workspace-service.cjs');

const app = { wecom: { organizationId: 'corp', applicationId: '1000002' }, wecomSecret: 's' };
const bot = { wecom: { botId: 'b' }, wecomBotSecret: 'x' };
const feishu = { feishu: { appId: 'cli_abcdefgh12' }, feishuAppSecret: 'fs' };

test('企微是主通道：自建应用优先，飞书其次，机器人兜底；没绑定或没配置给出明确原因', () => {
  const both = { wecomUserId: 'zhang', feishuId: 'zhang@corp.com' };
  assert.deepEqual(channelsFor(both, { ...app, ...feishu, ...bot, wecom: { ...app.wecom, ...bot.wecom } }, { status: '已连接' }).map(c => c.channel), ['wecom-app', 'feishu', 'wecom-bot']);
  assert.equal(reachability(both, { ...feishu }, null).channel, 'feishu', '企微应用没配置时走飞书');
  assert.equal(reachability({ wecomUserId: 'zhang' }, { ...bot }, { status: '已连接' }).channel, 'wecom-bot');
  assert.deepEqual(reachability({ wecomUserId: 'zhang' }, { ...bot }, { status: '未连接' }), { reachable: false, reason: 'channel-not-configured' });
  assert.deepEqual(reachability({ name: '无账号' }, { ...app }, null), { reachable: false, reason: 'unbound' });
});

test('notifyMember 按路由发送，并标注实际通道', async () => {
  const calls = [];
  const sendWecomApp = async (config, to, text) => { calls.push(['app', to, text]); return { externalMessageId: 'w1' }; };
  const sendFeishu = async (config, to, text) => { calls.push(['feishu', to, text]); return { externalMessageId: 'f1' }; };
  assert.equal((await notifyMember({ ...app, ...feishu }, { wecomUserId: 'z', feishuId: 'z@x.com' }, 'hi', { sendWecomApp, sendFeishu })).channel, 'wecom-app');
  assert.equal((await notifyMember({ ...feishu }, { wecomUserId: 'z', feishuId: 'z@x.com' }, 'hi', { sendWecomApp, sendFeishu })).channel, 'feishu');
  assert.deepEqual(calls.map(c => c[0]), ['app', 'feishu']);
  await assert.rejects(notifyMember({ ...app }, { name: 'x' }, 'hi', { sendWecomApp }), error => error.code === 'unbound');
});

test('飞书：识别账号类型，用 tenant token 发文本，常见错误给出可操作提示', async () => {
  assert.deepEqual(feishuReceiver('a@b.com'), { type: 'email', id: 'a@b.com' });
  assert.equal(feishuReceiver('ou_abc123').type, 'open_id');
  assert.equal(feishuReceiver('zhangsan').type, 'user_id');
  tokenCache.clear();
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body), auth: options.headers.authorization });
    if (url.includes('tenant_access_token')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-1', expire: 7200 }));
    const body = JSON.parse(options.body);
    if (body.receive_id === 'out@corp.com') return new Response(JSON.stringify({ code: 230013, msg: 'no availability' }));
    return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_1' } }));
  };
  const sent = await sendFeishuText(feishu, 'zhang@corp.com', '你好', fetchImpl);
  assert.equal(sent.externalMessageId, 'om_1');
  const message = requests.find(r => r.url.includes('/im/v1/messages'));
  assert.match(message.url, /receive_id_type=email/);
  assert.equal(message.auth, 'Bearer t-1');
  assert.deepEqual(JSON.parse(message.body.content), { text: '你好' });
  await assert.rejects(sendFeishuText(feishu, 'out@corp.com', 'x', fetchImpl), /可用范围/);
  assert.equal(requests.filter(r => r.url.includes('tenant_access_token')).length, 1, 'token 复用');
});

test('@ 与转发：跨归属和关联空间找成员，消息带发送者名字与工作链接，记录每人的通道和结果', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-router-'));
  try {
    const store = new JsonStore(path.join(dir, 'w.json'), () => ({
      workspaces: [
        { id: 't', name: '产品团队', members: [{ id: 'm1', name: '张祥春', wecomUserId: 'zxc', status: 'wecom' }] },
        { id: 'p', name: 'TEZ 项目', members: [{ id: 'm2', name: '王宁', feishuId: 'wn@corp.com', status: 'feishu' }, { id: 'm3', name: '李然', status: 'wecom' }] }
      ],
      tasks: [{ id: 'w1', title: '方案评审', workspace: '产品团队', relatedWorkspaces: ['TEZ 项目'], messages: [
        { id: 'u1', role: 'user', text: '@张祥春 @王宁 看下方案', mentions: [{ memberId: 'm1', name: '张祥春' }, { memberId: 'm2', name: '王宁' }] },
        { id: 'a1', role: 'assistant', text: '成本口径已核对' }
      ] }]
    }));
    await store.initialize();
    const sent = [];
    const notify = async (config, member, text) => {
      if (!member.wecomUserId && !member.feishuId) throw Object.assign(new Error('还没有绑定企微或飞书'), { code: 'unbound' });
      sent.push({ to: member.name, text }); return { channel: member.wecomUserId ? 'wecom-app' : 'feishu', externalMessageId: 'x' };
    };
    const delivery = new WecomDelivery({ store, settingsService: { getRuntimeConfig: async () => ({ profile: { name: '朱明谦' } }) }, publish: () => {}, notify });
    const results = await delivery.sendMentions('w1', 'u1');
    assert.deepEqual(results.map(r => [r.name, r.status, r.channel]), [['张祥春', 'sent', 'wecom-app'], ['王宁', 'sent', 'feishu']]);
    assert.match(sent[0].text, /^朱明谦 在共作「方案评审」中 @ 了你：\n@张祥春 @王宁 看下方案\n\n打开工作：/);
    const forwarded = await delivery.forwardToMembers('w1', 'a1', ['m2', 'm3']);
    assert.deepEqual(forwarded.map(r => [r.name, r.status]), [['王宁', 'sent'], ['李然', 'unmapped']]);
    assert.match(sent.at(-1).text, /^朱明谦 从共作「方案评审」转发给你 Agent 的回复：\n成本口径已核对/);
    const saved = (await store.read()).tasks[0].messages;
    assert.equal(saved[1].forwards.length, 2);
    assert.equal(saved[0].mentionDeliveries.length, 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('成员绑定飞书：可绑给已有成员或新增飞书成员，校验格式与重复', () => {
  const data = { workspaces: [{ id: 't', name: '产品团队', type: 'team', members: [{ id: 'm1', name: '张祥春', wecomUserId: 'zxc', status: 'wecom' }] }] };
  linkFeishuProjectMember(data, { workspaceId: 't', memberId: 'm1', feishuId: 'zxc@corp.com' });
  assert.equal(data.workspaces[0].members[0].feishuId, 'zxc@corp.com');
  const added = linkFeishuProjectMember(data, { workspaceId: 't', name: '王宁', feishuId: 'ou_abc', role: 'viewer' });
  assert.equal(added.status, 'feishu');
  assert.throws(() => linkFeishuProjectMember(data, { workspaceId: 't', name: '重复', feishuId: 'ou_abc' }), /已在空间中/);
  assert.throws(() => linkFeishuProjectMember(data, { workspaceId: 't', name: 'x', feishuId: 'bad id!' }), /飞书邮箱/);
});
