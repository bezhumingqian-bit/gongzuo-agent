// Work page: an action the Agent waits on shows 允许一次 / 拒绝; replies from the
// 共作 kernel are labelled and show proposed changes and this turn's decisions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function ui() {
  let html = '';
  const root = { set innerHTML(value) { html = value; }, querySelector() { return null; }, addEventListener() {} };
  const context = vm.createContext({ document: { getElementById: () => root, title: '', body: { classList: { add() {} } }, querySelectorAll: () => [] }, window: { gongzuo: { bootstrap: () => new Promise(() => {}) } }, localStorage: { getItem: () => null, setItem() {} }, setTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../demo/app.js'), 'utf8'), context);
  return { run: script => vm.runInContext(script, context), html: () => html };
}

test('等待确认：显示请求内容（已转义）、允许一次/拒绝、剩余时间，状态写“等你确认后继续”', () => {
  const { run, html } = ui();
  run(`tasks=[{id:'w',title:'跑测试',goal:'跑测试',workspace:'产品团队',agentMode:'cloudagent',messages:[{id:'u',role:'user',text:'跑测试'}],agentRun:{status:'running',triggerId:'u',startedAt:new Date().toISOString(),phase:'awaiting-approval',steps:2,pendingApproval:{id:'ap-1',title:'运行沙箱命令：<img src=x onerror=alert(1)>',kind:'execute',requestedAt:Date.now(),expiresAt:Date.now()+9*60000}}}];state.task='w';state.view='task';render()`);
  assert.match(html(), /Agent 请求执行/);
  assert.match(html(), /&lt;img src=x/);
  assert.doesNotMatch(html(), /<img src=x/);
  assert.match(html(), /data-action="approval-allow" data-id="ap-1"/);
  assert.match(html(), /data-action="approval-reject" data-id="ap-1"/);
  assert.match(html(), /9 分钟内未确认将自动拒绝/);
  assert.match(html(), /等你确认后继续/);
});

test('共作内核回复：标注来源，列出提议的修改（不自动生效）与本轮确认结果', () => {
  const { run, html } = ui();
  run(`tasks=[{id:'k',title:'周报',goal:'周报',workspace:'产品团队',agentMode:'built-in',messages:[{id:'u',role:'user',text:'改截止时间'},{id:'a',role:'assistant',text:'已提议',source:'kernel',proposals:[{field:'deadline',label:'截止时间',value:'周五',reason:'等数据',risk:'approval',status:'pending'}],approvals:[{title:'npm test',outcome:'reject',reason:'timeout'}]}]}];state.task='k';state.view='task';render()`);
  assert.match(html(), /共作内核 · 实际响应/);
  assert.match(html(), /截止时间 → 周五（等数据）/);
  assert.match(html(), /共作不会自动修改/);
  assert.match(html(), /npm test：超时未确认，已拒绝/);
});
