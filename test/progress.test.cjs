const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { extractProgress, fallbackProgress, PROGRESS_INSTRUCTION } = require('../electron/progress-service.cjs');
const { conversationInput } = require('../electron/connection-service.cjs');
const { JsonStore } = require('../electron/store.cjs');
const { TaskRunner } = require('../electron/task-runner.cjs');

test('提炼：从回复中取出进展块并剥离；支持中英文字段、去重、限量、截断', () => {
  const reply = '已核对三个可用区的库存。\n\n**结论**：南昌库存充足。\n\n<进展>\n[{"类型":"结论","内容":"南昌三区库存充足，可承接迁移"},{"类型":"卡点","内容":"沙特报价未回"},{"type":"todo","text":"周四前确认迁移批次"},{"类型":"结论","内容":"南昌三区库存充足，可承接迁移"},{"类型":"闲聊","内容":"你好"}]\n</进展>';
  const { text, items, found } = extractProgress(reply);
  assert.equal(found, true);
  assert.ok(!text.includes('<进展>') && text.startsWith('已核对'));
  assert.deepEqual(items.map(item => item.kind), ['conclusion', 'blocker', 'todo']);
  const long = extractProgress(`ok<progress>[{"类型":"决定","内容":"${'长'.repeat(300)}"}]</progress>`);
  assert.equal(long.items[0].text.length, 120);
  assert.deepEqual(extractProgress('普通回复<进展>[]</进展>').items, []);
  assert.equal(extractProgress('普通回复<进展>[]</进展>').text, '普通回复');
});

test('提炼：模型没按 JSON 写时容忍「类型：内容」行；没有进展块时只取明确标注的行和生成文件', () => {
  assert.deepEqual(extractProgress('x<进展>\n- 决定：越南优先\n- 待办：周五前给报价\n</进展>').items.map(i => [i.kind, i.text]), [['decision', '越南优先'], ['todo', '周五前给报价']]);
  const items = fallbackProgress('先分析一下。\n**结论**：福州下线可在本周完成\n- 下一步：导出 vstation 清单\n普通的一句话不算', [{ name: '迁移清单.xlsx' }]);
  assert.deepEqual(items.map(i => [i.kind, i.text]), [['conclusion', '福州下线可在本周完成'], ['todo', '导出 vstation 清单'], ['output', '生成文件：迁移清单.xlsx']]);
  assert.deepEqual(fallbackProgress('只是普通的一段说明，没有任何标注。'), []);
});

test('提示词要求 Agent 附进展块', () => {
  assert.ok(conversationInput([{ role: 'user', text: 'hi' }], {}).instructions.includes(PROGRESS_INSTRUCTION));
});

test('Agent 回复：正文不含进展块，进展存为草稿；确认、修改、忽略、全部发布、手动记录', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-progress-'));
  try {
    const store = new JsonStore(path.join(dir, 'w.json'), () => ({ workspaces: [{ id: 'p', name: '产品团队' }], tasks: [] }));
    const mem = new JsonStore(path.join(dir, 'm.json'), () => ({ items: [] }));
    await Promise.all([store.initialize(), mem.initialize()]);
    const agent = { isConfigured: () => true, answer: async () => ({ id: 'a1', role: 'assistant', text: '处理完了。\n<进展>[{"类型":"产出","内容":"第 2 批迁移清单 18 台"},{"类型":"卡点","内容":"缺 3 台的机位信息"}]</进展>', createdAt: new Date().toISOString(), source: 'model' }) };
    const runner = new TaskRunner({ store, settingsService: { getRuntimeConfig: async () => ({ agent: { mode: 'built-in' }, model: {} }) }, personalMemoryStore: mem, teamMemoryStore: mem, documentService: { list: async () => [] }, agent, publish: () => {} });
    const task = await runner.create('整理第 2 批迁移清单', '产品团队');
    await runner.queues.get(task.id);
    let saved = (await store.read()).tasks[0];
    assert.equal(saved.messages.at(-1).text, '处理完了。');
    assert.deepEqual(saved.progress.map(p => [p.kind, p.status, p.sourceMessageId]), [['output', 'draft', 'a1'], ['blocker', 'draft', 'a1']]);
    const [first, second] = saved.progress;
    await runner.updateProgress(task.id, first.id, { action: 'publish', text: '第 2 批迁移清单已生成（18 台）' });
    await runner.updateProgress(task.id, second.id, { action: 'dismiss' });
    await runner.addProgress(task.id, { kind: 'decision', text: '先迁移福州 A 区' });
    saved = (await store.read()).tasks[0];
    assert.deepEqual(saved.progress.map(p => [p.kind, p.status]), [['output', 'published'], ['blocker', 'dismissed'], ['decision', 'published']]);
    assert.equal(saved.progress[0].text, '第 2 批迁移清单已生成（18 台）');
    await assert.rejects(runner.addProgress(task.id, { kind: 'chat', text: 'x' }), /类型无效/);
    await assert.rejects(runner.updateProgress(task.id, 'nope', { action: 'publish' }), /不存在/);
    await runner.append(task.id, '再来一轮');
    await runner.queues.get(task.id);
    assert.equal((await runner.publishAllProgress(task.id)).published, 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('界面：工作页显示进展面板（草稿待确认 / 已发布）；空间页显示概况、工作卡片墙和只含已确认进展的动态', () => {
  const vm = require('node:vm');
  let html = '';
  const root = { set innerHTML(value) { html = value; }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  const context = { document: { getElementById: () => root, body: { classList: { add() {} } }, title: '' }, window: { gongzuo: { bootstrap: () => new Promise(() => {}) } }, localStorage: { getItem: () => null, setItem() {} }, setTimeout };
  vm.createContext(context);
  vm.runInContext(require('node:fs').readFileSync(path.join(__dirname, '../demo/app.js'), 'utf8'), context);
  const now = new Date().toISOString();
  vm.runInContext(`state.workspaces=[{id:'t',name:'产品团队',type:'team',members:[]},{id:'p',name:'TEZ 项目',type:'project',createdBy:'local-user',members:[]}];
tasks=[{id:'w1',title:'福州边缘一区下线',goal:'下线福州一区',workspace:'产品团队',status:'running',updatedAt:'${now}',messages:[{id:'u1',role:'user',text:'下线福州一区'},{id:'a1',role:'assistant',text:'已整理',source:'model'},{id:'a2',role:'assistant',text:'第二轮',source:'model'}],progress:[{id:'p1',kind:'output',text:'第 2 批迁移清单 18 台',status:'published',author:'agent',sourceMessageId:'a1',publishedAt:'${now}'},{id:'p2',kind:'blocker',text:'缺 3 台机位信息',status:'draft',author:'agent',sourceMessageId:'a2',createdAt:'${now}'},{id:'p3',kind:'todo',text:'被忽略的不显示',status:'dismissed'}]},
{id:'w2',title:'沙特机房选址',goal:'选址',workspace:'TEZ 项目',relatedWorkspaces:['产品团队'],status:'running',updatedAt:'${now}',messages:[],progress:[{id:'q1',kind:'blocker',text:'报价未回',status:'published',author:'local-user',publishedAt:'${now}'}]}];
state.view='task';state.task='w1';render()`, context);
  assert.doesNotMatch(html, /class="progress-panel/, '顶部不再有进展面板');
  assert.match(html, /已同步 1 条进展到空间[\s\S]*第 2 批迁移清单 18 台/, '已确认的那轮收起为一行');
  assert.match(html, /本轮进展[\s\S]*缺 3 台机位信息[\s\S]*确认同步 1 条[\s\S]*这轮不同步/, '进展附在产生它的回复下面');
  assert.doesNotMatch(html, /被忽略的不显示/);
  vm.runInContext("state.view='workspace';state.workspace='产品团队';state.task=null;render()", context);
  assert.match(html, /空间概况[\s\S]*2 项工作/);
  assert.match(html, /最新卡点：「沙特机房选址」报价未回/);
  assert.match(html, /war-card[\s\S]*福州边缘一区下线[\s\S]*待确认/);
  assert.match(html, /沙特机房选址[\s\S]*卡住[\s\S]*来自 TEZ 项目/);
  assert.match(html, /进展动态[\s\S]*第 2 批迁移清单 18 台/);
  assert.doesNotMatch(html.slice(html.indexOf('进展动态')), /缺 3 台机位信息/, '草稿不进入空间动态');
});
