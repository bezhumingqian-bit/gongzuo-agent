const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../electron/store.cjs');
const { TaskRunner } = require('../electron/task-runner.cjs');
const { WecomDelivery } = require('../electron/wecom-service.cjs');
const { normalizeSettings } = require('../electron/settings-service.cjs');

async function setup({ wecom = {}, fail = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-sync-'));
  const store = new JsonStore(path.join(directory, 'w.json'), () => ({ workspaces: [{ id: 'p', name: '产品团队' }], tasks: [] }));
  const mem = new JsonStore(path.join(directory, 'm.json'), () => ({ items: [] }));
  await Promise.all([store.initialize(), mem.initialize()]);
  const sent = [];
  const settingsService = { getRuntimeConfig: async () => ({ agent: { mode: 'built-in' }, model: { modelId: 'm', provider: 'local' }, wecom }) };
  const delivery = new WecomDelivery({ store, settingsService, publish: () => {}, send: async (config, userId, text) => {
    await new Promise(resolve => setTimeout(resolve, 5));
    if (fail) throw new Error('企微拒绝发送');
    sent.push({ userId, text }); return { externalMessageId: `x${sent.length}` };
  } });
  const agent = { isConfigured: () => true, answer: async task => ({ id: `a-${task.messages.length}`, role: 'assistant', text: `回复：${task.messages.at(-1).text}`, createdAt: new Date().toISOString(), source: 'model' }) };
  const runner = new TaskRunner({ store, settingsService, personalMemoryStore: mem, teamMemoryStore: mem, documentService: { list: async () => [], readForAgent: async () => ({}) }, agent, publish: () => {} });
  const synced = [];
  runner.onMessageAdded = ({ taskId, messageId }) => { const p = delivery.syncMessage(taskId, messageId); synced.push(p); return p; };
  const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise(resolve => setTimeout(resolve, 30)); await Promise.allSettled(synced); } };
  return { directory, store, runner, delivery, sent, settle };
}

test('开启同步后：我的消息和 Agent 回复按顺序发到企微，带工作标题和链接；开启前的消息不补发', async () => {
  const ctx = await setup();
  try {
    const task = await ctx.runner.create('写周报', '产品团队');
    await ctx.runner.queues.get(task.id);
    await ctx.settle();
    assert.equal(ctx.sent.length, 0, '未开启时不发');
    await ctx.runner.setWecomSync(task.id, { enabled: true, recipientUserId: 'ming' });
    await ctx.runner.append(task.id, '补充本周数据');
    await ctx.runner.queues.get(task.id);
    await ctx.settle();
    assert.equal(ctx.sent.length, 2);
    assert.match(ctx.sent[0].text, /^【共作｜写周报】我：\n补充本周数据/);
    assert.match(ctx.sent[1].text, /^【共作｜写周报】Agent：\n回复：补充本周数据/);
    assert.ok(ctx.sent.every(item => item.userId === 'ming' && /打开工作：/.test(item.text)));
    const saved = (await ctx.store.read()).tasks[0].messages;
    assert.deepEqual(saved.filter(m => m.wecomDelivery).map(m => [m.role, m.wecomDelivery.status, m.wecomDelivery.via]), [['user', 'sent', 'sync'], ['assistant', 'sent', 'sync']]);
    assert.equal(saved[0].wecomDelivery, undefined, '开启前的消息不补发');
    await ctx.runner.setWecomSync(task.id, { enabled: false });
    await ctx.runner.append(task.id, '关掉之后');
    await ctx.runner.queues.get(task.id);
    await ctx.settle();
    assert.equal(ctx.sent.length, 2, '关闭后不再发');
  } finally { await fs.rm(ctx.directory, { recursive: true, force: true }); }
});

test('设置默认开启：新工作自动同步；企微发起的消息不回发；失败记为可重试', async () => {
  const ctx = await setup({ wecom: { syncNewWorks: true, recipientUserId: 'ming' }, fail: true });
  try {
    const task = await ctx.runner.create('默认同步的工作', '产品团队');
    assert.deepEqual([task.wecomSync.enabled, task.wecomSync.recipientUserId], [true, 'ming']);
    await ctx.runner.queues.get(task.id);
    await ctx.settle();
    const messages = (await ctx.store.read()).tasks[0].messages;
    assert.equal(messages[0].wecomDelivery.status, 'failed');
    assert.equal(messages[0].wecomDelivery.via, 'sync');
    const fromWecom = await ctx.runner.create('企微发来的', '产品团队', [], { chatId: 'c', userId: 'bob', msgId: 'm1', chatType: 'single' });
    assert.equal(fromWecom.wecomSync, undefined, '企微发起的工作不默认同步');
  } finally { await fs.rm(ctx.directory, { recursive: true, force: true }); }
});

test('长消息截断到企微上限内并提示；设置要求有默认收件人', () => {
  const body = WecomDelivery.syncBody({ id: 't', title: '长' }, { role: 'assistant', text: '字'.repeat(3000) });
  assert.ok(Buffer.byteLength(body, 'utf8') <= 2048);
  assert.match(body, /完整内容见共作/);
  const base = { model: { provider: 'local', modelId: 'm', baseUrl: 'http://127.0.0.1:1/v1' }, agent: { mode: 'built-in' }, workflow: {} };
  assert.throws(() => normalizeSettings({ ...base, wecom: { syncNewWorks: true } }), /默认收件成员/);
  assert.equal(normalizeSettings({ ...base, wecom: { syncNewWorks: true, recipientUserId: 'ming' } }).wecom.syncNewWorks, true);
});
