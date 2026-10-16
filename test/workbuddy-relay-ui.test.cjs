const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function ui() {
  let html = '';
  const root = { set innerHTML(value) { html = value; }, querySelector() { return null; }, addEventListener() {} };
  const context = vm.createContext({ document: { getElementById: () => root, title: '', body: { classList: { add() {} } } }, window: { gongzuo: { bootstrap: () => new Promise(() => {}) } }, localStorage: { getItem: () => null, setItem() {} }, setTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../demo/app.js'),'utf8'),context);
  return { run: script => vm.runInContext(script,context), html: () => html };
}
test('正式授权设置不展示 Client Secret，服务地址转义，取消入口真实可见', () => {
  const { run } = ui();
  const html = run(`workbuddyRelayCard({agent:{workbuddyRelayUrl:'https://relay.example.com'},workbuddyAuth:{clientConfigured:true,authorizing:true,redirectUri:'https://relay.example.com/oauth/callback',nickname:'<script>bad</script>',authorized:true}})`);
  assert.match(html,/name="workbuddyRelayUrl"/);
  assert.match(html,/data-action="workbuddy-cancel-auth"/);
  assert.match(html,/&lt;script&gt;bad/);
  assert.doesNotMatch(html,/name="workbuddyClientSecret"|name="workbuddyClientId"/);
  assert.match(html,/不需要粘贴应用密钥/);
  assert.match(html,/工具审批请在 WorkBuddy 内确认/);
});
test('持续监听的回复有取回/核对结束两按钮，旧通道不多出释放动作', () => {
  const { run, html } = ui();
  run(`tasks=[{id:'t1',title:'测试',goal:'生成方案',workspace:'产品团队',messages:[{id:'u1',role:'user',text:'生成方案'},{id:'a1',role:'assistant',text:'处理中',source:'workbuddy-pending',externalMessageId:'m1',via:'localassistant-relay'}]}];state.task='t1';state.view='task';render()`);
  assert.match(html(),/data-action="release-workbuddy"/);
  assert.match(html(),/我已核对，结束监听/);
  assert.match(html(),/data-action="sync-workbuddy"/);
  run(`delete tasks[0].messages[1].via;render()`);
  assert.doesNotMatch(html(),/data-action="release-workbuddy"/);
});
test('桌面默认RelayAuth且任务释放有原生确认、未监听结束不可重新授权或换服务', () => {
  const source=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
  assert.match(source,/new WorkBuddyRelayAuth\(/);
  assert.doesNotMatch(source,/new WorkBuddyOAuth\(/);
  assert.match(source,/核对并结束监听后再重新授权/);
  assert.match(source,/再改授权服务地址/);
  assert.match(source,/buttons: \['继续监听', '已核对，结束监听'\]/);
  assert.match(source,/不会停止 WorkBuddy 的任务/);
  const preload=fs.readFileSync(path.join(__dirname,'../electron/preload.cjs'),'utf8');
  assert.match(preload,/releaseWorkBuddy: input => ipcRenderer.invoke\('tasks:release-workbuddy'/);
  assert.match(preload,/cancelWorkBuddyAuthorization:/);
});
