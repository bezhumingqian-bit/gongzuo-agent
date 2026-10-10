const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function scrollPane(height, viewport) {
  let top = 0;
  return {
    scrollHeight: height,
    clientHeight: viewport,
    get scrollTop() { return top; },
    set scrollTop(value) { top = Math.max(0, Math.min(value, height - viewport)); }
  };
}

test('工作对话刷新时保留历史位置，发送消息后跟随最新内容', () => {
  let thread = null;
  let drawer = null;
  let nextThreadHeight = 1000;
  const root = {
    set innerHTML(html) {
      thread = html.includes('class="thread"') ? scrollPane(nextThreadHeight, 500) : null;
      drawer = html.includes('class="drawer"') ? scrollPane(900, 500) : null;
    },
    querySelector(selector) { return selector === '.thread' ? thread : selector === '.drawer' ? drawer : null; },
    addEventListener() {}
  };
  const context = {
    document: { getElementById: () => root, title: '' },
    window: {},
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../demo/app.js'), 'utf8'), context);
  vm.runInContext("state.view='task';state.task='feedback';state.drawerOpen=true;render()", context);
  assert.equal(thread.scrollTop, 500);
  thread.scrollTop = 170;
  drawer.scrollTop = 120;
  nextThreadHeight = 1200;
  vm.runInContext('render()', context);
  assert.equal(thread.scrollTop, 170);
  assert.equal(drawer.scrollTop, 120);
  thread.scrollTop = 700;
  nextThreadHeight = 1600;
  vm.runInContext('render()', context);
  assert.equal(thread.scrollTop, 1100);
  thread.scrollTop = 100;
  nextThreadHeight = 1800;
  vm.runInContext('render({followThread:true})', context);
  assert.equal(thread.scrollTop, 1300);
});

test('消息收件区分企微新旧记录并转义外部正文', () => {
  let html = '';
  const root = { set innerHTML(value) { html = value; }, querySelector: () => null, addEventListener() {}, focus() {} };
  const context = {
    document: { getElementById: () => root, title: '' }, window: {},
    localStorage: { getItem: () => null, setItem() {} }, setTimeout
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../demo/app.js'), 'utf8'), context);
  vm.runInContext(`applyDesktopData({wecomEvents:[
    {msgId:'old',chatType:'single',userId:'tester',at:'2026-09-29T02:00:00Z'}
  ],inboundMessages:[
    {id:'wecom:new',channel:'wecom',senderId:'tester',receivedAt:'2026-09-29T02:01:00Z',text:'<script>alert(1)</script>'}
  ]});state.quickPanel='channel-inbox';render()`, context);
  assert.match(html, /消息收件/);
  assert.match(html, /当时未保存正文/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  vm.runInContext("state.view='task';state.task='feedback';state.quickPanel='channel-inbox';render()", context);
  assert.match(html, /作为工作材料引用/);
  const quoted = vm.runInContext("quoteInboundToCurrentTask('wecom:new') && state.composerDrafts['thread-input']", context);
  assert.match(quoted, /企业微信来信/);
  assert.match(quoted, /<script>alert\(1\)<\/script>/);
  assert.equal(vm.runInContext("state.quickPanel", context), null);
});

test('Mac 输入框明确区分交给 Agent 与直接发企微', () => {
  let html = '';
  const root = { set innerHTML(value) { html = value; }, querySelector: () => null, addEventListener() {} };
  const context = {
    document: { getElementById: () => root, body: { classList: { add() {} } }, title: '' }, window: { gongzuo: { bootstrap: () => new Promise(() => {}) } },
    localStorage: { getItem: () => null, setItem() {} }, setTimeout
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../demo/app.js'), 'utf8'), context);
  vm.runInContext("state.homeMode='agent';render()", context);
  assert.match(html, /data-action="open-wecom-composer"[^>]*直接发送到企微，不调用 Agent/);
  assert.match(html, /data-action="submit"[^>]*aria-label="交给 Agent"/);
  vm.runInContext("state.view='task';state.task='feedback';render()", context);
  assert.match(html, /data-action="open-wecom-composer"[^>]*data-input="thread-input"/);
  vm.runInContext("tasks=[{id:'channel',title:'企微消息',goal:'同一条通知',workspace:'产品团队',messages:[{id:'one',role:'user',text:'同一条通知',wecomOutbound:true},{id:'two',role:'user',text:'同一条通知',wecomOutbound:true}]}];state.task='channel';render()", context);
  assert.equal((html.match(/<p>同一条通知<\/p>/g) || []).length, 2);
});
