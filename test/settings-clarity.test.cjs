const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function ui(){
  let html='';
  const root={set innerHTML(value){html=value},querySelector(){return null},addEventListener(){}};
  const context=vm.createContext({document:{getElementById:()=>root,title:'',body:{classList:{add(){}}}},window:{gongzuo:{bootstrap:()=>new Promise(()=>{})}},localStorage:{getItem:()=>null,setItem(){}},setTimeout});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../demo/app.js'),'utf8'),context);
  return {run:s=>vm.runInContext(s,context),html:()=>html,root,context};
}
test('WorkBuddy三种连接只默认显示所选操作区，字段保留且不重复旧大段说明',()=>{
  const {run}=ui();
  for(const method of ['handoff','localassistant','cloud']){
    const html=run(`workbuddySettings({agent:{workbuddyTransport:'${method}'},workbuddyAuth:{}},()=>'<div>检查</div>')`);
    const panels=[...html.matchAll(/data-workbuddy-method="([^"]+)"\s*([^>]*)>/g)];
    assert.deepEqual(panels.filter(m=>!m[2].includes('hidden')).map(m=>m[1]),[method]);
    assert.match(html,/name="workbuddyRelayUrl"/);
    assert.match(html,/name="workbuddyAccessToken"/);
    assert.doesNotMatch(html,/本机连接（默认）|云端任务 \/ 本地助理/);
    assert.match(html,/收到文本不等于任务完成/);
    assert.match(html,/工具审批请在 WorkBuddy 内确认/);
    assert.match(html,/<select name="workbuddyTransport">/);
    assert.match(html,/<details class="settings-config" data-connection-config>/);
    assert.doesNotMatch(html,/data-action="test-connection"|检查助理在线/);
  }
});
test('7种默认Agent用一个选择框，可选接入/诊断/关闭规则默认折叠',()=>{
  const {run}=ui();
  const html=run(`state.settingsPanel=true;state.settingsSection='connectors';settingsOverlay()`);
  assert.match(html,/<select name="agentMode">/);
  assert.doesNotMatch(html,/type="radio" name="agentMode"/);
  for(const id of ['settings-wecom-app','settings-feishu','settings-workflow']){
    const opening=html.match(new RegExp('<details[^>]*id="'+id+'"[^>]*>'))?.[0];
    assert.ok(opening,id+' should be collapsible');
    assert.doesNotMatch(opening,/\sopen(?:\s|>)/);
  }
  assert.match(html,/<summary>接收诊断<\/summary>/);
  assert.match(html,/机器人不能读取个人聊天记录/);
  assert.match(html,/name="wecomSecret"/);
  assert.match(html,/name="workflowInstruction"/);
});
test('已发布进展和历史审批折叠，待确认进展与修改建议仍显式可操作',()=>{
  const {run}=ui();
  const published=run(`replyProgress({progress:[{sourceMessageId:'a',status:'published',kind:'output',text:'已生成方案'}]},{id:'a'})`);
  assert.match(published,/<details><summary>已同步 1 条进展/);
  assert.match(published,/data-action="progress-reopen"/);
  const draft=run(`replyProgress({progress:[{id:'p',sourceMessageId:'a',status:'draft',kind:'output',text:'个人资料',personal:'document'}]},{id:'a'})`);
  assert.match(draft,/待确认进展/);
  assert.match(draft,/请确认可公开/);
  assert.match(draft,/data-action="progress-confirm"[^>]*disabled/);
  const audit=run(`replyGovernance({approvals:[{title:'改文件',outcome:'allow'}],proposals:[{label:'截止时间',value:'周五'}]})`);
  assert.match(audit,/<details class="reply-governance"><summary>本轮确认/);
  assert.match(audit,/需负责人确认后手动处理/);
});
test('成员和空间重复工作列表按需展开，不隐藏成员权限和本机存储范围',()=>{
  const {run}=ui();
  const member=run(`state.workspace='审查项目';state.workspaces=[{id:'x',name:'审查项目',type:'project',createdBy:'local-user',members:[]}];projectMembersDialog()`);
  assert.match(member,/<h2>空间成员<\/h2>/);
  assert.match(member,/<details class="member-add-method"><summary>从企业微信通讯录添加/);
  assert.match(member,/邮箱待邀请 · 仅记录名单/);
  assert.match(member,/name="role"/);
  const page=run('workspaceStage()');
  assert.match(page,/<details class="space-work-index"><summary>全部项目工作/);
  assert.match(page,/项目资料不自动继承关联团队/);
});
test('保存成功后不再恢复已提交的密钥和删除勾选，避免后续保存再次删除',()=>{
  const u=ui();
  let fields=[{name:'modelKey',type:'password',value:'SUBMITTED_KEY',dataset:{}},{name:'clearModelKey',type:'checkbox',value:'on',checked:true,dataset:{}}];
  const form={scrollTop:0,contains:()=>false,querySelectorAll:selector=>selector==='details'?[]:fields,querySelector:()=>null};
  u.root.querySelector=selector=>selector==='#settings-form'?form:null;
  u.run('state.settingsPanel=true;renderedSettingsConfig=state.settings;state.settings={...state.settings,hasModelKey:false}');
  const snapshot=u.run('settingsFormSnapshot()');
  fields=fields.map(f=>({...f,value:'',checked:false}));
  u.context.snapshot=snapshot;u.run('restoreSettingsForm(snapshot)');
  assert.equal(fields[0].value,'');
  assert.equal(fields[1].checked,false);
});

test('有成果iframe时增量渲染也同步表单的dirty value/checked属性',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../demo/app.js'),'utf8');
  const patch=source.slice(source.indexOf('function renderRoot(html)'),source.indexOf('let renderedSettingsConfig'));
  assert.match(patch,/current\.nodeName==='INPUT'/);
  assert.match(patch,/current\.value=next\.value/);
  assert.match(patch,/current\.checked=next\.checked/);
  assert.match(patch,/current\.type!=='file'/);
  assert.match(patch,/current\.nodeName==='SELECT'/);
});

test('未保存设置快照保留隐藏字段和密钥，仅本次渲染使用，不写state或localStorage',()=>{
  const u=ui();
  const fields=[{name:'workbuddyRelayUrl',type:'url',value:'https://draft.example.com',dataset:{}},{name:'modelKey',type:'password',value:'TEMP_SECRET_ONLY',dataset:{}},{name:'agentMode',type:'select-one',value:'workbuddy',dataset:{}},{name:'workflowEnabled',type:'checkbox',value:'on',checked:false,dataset:{}}];
  let current=fields;
  const form={scrollTop:18,contains:()=>false,querySelectorAll:selector=>selector==='details'?[]:current,querySelector:selector=>selector==='[name="agentMode"]'?current.find(e=>e.name==='agentMode'):null};
  u.root.querySelector=selector=>selector==='#settings-form'?form:null;
  u.run('state.settingsPanel=true');
  const snapshot=u.run('settingsFormSnapshot()');
  current=fields.map(f=>({...f,value:'',checked:true}));
  u.context.snapshot=snapshot;u.run('restoreSettingsForm(snapshot)');
  assert.equal(current.find(e=>e.name==='workbuddyRelayUrl').value,'https://draft.example.com');
  assert.equal(current.find(e=>e.name==='modelKey').value,'TEMP_SECRET_ONLY');
  assert.equal(current.find(e=>e.name==='workflowEnabled').checked,false);
  assert.equal(u.run('JSON.stringify(state).includes("TEMP_SECRET_ONLY")'),false);
});
