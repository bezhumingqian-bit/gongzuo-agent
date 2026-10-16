const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { mergeStep, LIMIT } = require('../electron/execution-log.cjs');
function ui() {
  let html = '';
  const root = { set innerHTML(value) { html = value; }, querySelector() { return null; }, addEventListener() {} };
  const context = vm.createContext({ document: { getElementById: () => root, title: '', body: { classList: { add() {} } } }, window: { gongzuo: { bootstrap: () => new Promise(() => {}) } }, localStorage: { getItem: () => null, setItem() {} }, setTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../demo/app.js'), 'utf8'), context);
  const run = script => vm.runInContext(script, context);
  run(`tasks=[{id:'real',title:'真实工作',goal:'测试',workspace:'产品团队',agentMode:'cloudagent',messages:[{id:'u',role:'user',text:'测试'},{id:'a',role:'assistant',text:'成果完成',source:'cloudagent',artifacts:[{id:'doc',name:'成果.html'}],execution:{startedAt:'2026-10-15T01:00:00Z',endedAt:'2026-10-15T01:00:05Z',entries:[{id:'call',title:'编辑成果.html',status:'completed',startedAt:1000,endedAt:2000}]}}]}];state.documents=[{id:'doc',name:'成果.html',size:200,status:'active',workspaceId:'product'}];state.task='real';state.view='task';state.artifactOpen=true;state.artifactPreview={key:'real:doc',data:{kind:'html',text:'<h1>真实文件</h1><script>window.attempt=true</script>'}};render()`);
  return { run, html: () => html };
}
test('工具日志按 ID 更新并保持顺序，重放不倒退，参数和思考不落盘，最大120步', () => {
  let list = mergeStep([], { id: '1', title: '读资料', kind: 'read', status: 'in_progress', rawInput: 'SECRET', content: 'THOUGHT' }, 1000);
  list = mergeStep(list, { id: '2', title: '写成果', kind: 'edit', status: 'pending' }, 1100);
  list = mergeStep(list, { id: '1', status: 'completed' }, 1500);
  list = mergeStep(list, { id: '1', status: 'pending', replayed: true }, 1600);
  assert.deepEqual(list.map(item => item.id), ['1', '2']);
  assert.equal(list[0].status, 'completed');
  assert.equal(list[0].endedAt - list[0].startedAt, 500);
  assert.doesNotMatch(JSON.stringify(list), /SECRET|THOUGHT|rawInput/);
  for (let i = 0; i < 150; i++) list = mergeStep(list, { id: `call-${i}` }, 2000 + i);
  assert.equal(list.length, LIMIT);
  const replay = mergeStep([], { id: 'old', status: 'completed', replayed: true }, 9999)[0];
  assert.equal(replay.startedAt, null); assert.equal(replay.endedAt, null);
});
test('真实工作可打开成果面板，HTML仅沙箱srcdoc、不允许同源或窗口，禁止网络与表单', () => {
  const { html } = ui();
  assert.match(html(), /工作成果/); assert.match(html(), /成果.html/);
  assert.match(html(), /sandbox=""/);
  assert.doesNotMatch(html(), /allow-same-origin|allow-popups|allow-forms|应用构建<\/span><b>通过/);
  assert.match(html(), /connect-src &amp;#39;none&amp;#39;/);
  assert.match(html(), /frame-src &amp;#39;none&amp;#39;/);
  assert.match(html(), /&lt;h1&gt;真实文件/);
  assert.doesNotMatch(html(), /<script>window.attempt/);
});
test('归档文件移出成果列表；文字转义、Office诚实降级、旧工作无伪造步骤', () => {
  const { run, html } = ui();
  run(`state.artifactPreview.data={kind:'text',text:'<img src=x onerror=alert(1)>'};render()`);
  assert.match(html(), /&lt;img src=x/);
  run(`state.artifactPreview.data={kind:'unsupported',reason:'暂不支持 Office'};render()`);
  assert.match(html(), /用本机应用查看完整成果/);
  run(`state.documents[0].status='archived';render()`);
  assert.match(html(), /还没有成果文件/);
  run(`state.artifactTab='execution';render()`);
  assert.match(html(), /编辑成果.html/); assert.match(html(), /0:05/);
  run(`tasks[0].messages[1].execution=null;render()`);
  assert.match(html(), /暂无执行步骤/); assert.doesNotMatch(html(), /编辑成果.html/);
});
test('共作Agent入口透明注明CloudAgent，不覆盖已选的默认Agent', () => {
  const { run } = ui();
  assert.equal(run(`agentLabel('cloudagent')`), '共作 Agent');
  assert.match(run(`capabilityItems.cloudagent.description`), /CodeBuddy CloudAgent/);
  run(`state.view='home';state.settings.agent.mode='codex';state.composerAgentMode='cloudagent'`);
  assert.equal(run('selectedAgentMode()'), 'cloudagent');
  assert.equal(run('state.settings.agent.mode'), 'codex');
});
