const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function ui(api={}){
  let html='';const handlers={};
  const root={set innerHTML(v){html=v},querySelector:()=>null,querySelectorAll:()=>[],addEventListener:(type,fn)=>{handlers[type]=fn},contains:()=>true};
  const context=vm.createContext({document:{getElementById:()=>root,title:'',body:{classList:{add(){}}},visibilityState:'visible'},window:{gongzuo:{bootstrap:()=>new Promise(()=>{}),...api}},localStorage:{getItem:()=>null,setItem(){}},setTimeout:()=>0});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../demo/app.js'),'utf8'),context);
  const run=s=>vm.runInContext(s,context);
  function click(action,id,region='outside'){
    const el=action?{dataset:{action,id},disabled:false}:null;
    const target={closest(selector){if(selector==='[data-action]')return el;if(region==='capability'&&selector.includes('.capability-popover'))return {};if(region==='space'&&selector.includes('.composer-space-anchor'))return {};return null}};
    return handlers.click({target});
  }
  return {run,click,html:()=>html,context,root};
}
test('空白处自动关闭Agent/工具/空间/资料/@/快捷菜单，不关闭配置和审批对话',async()=>{
  const u=ui();u.run(`state.capabilityPanel=true;state.capabilityDetail='codex';state.composerSpaceMenu=true;state.documentPicker='home-input';state.mentionMenu=true;state.homeCustomize=true;state.quickPanel='people';state.settingsPanel=true`);
  await u.click();
  const result=u.run(`({agent:state.capabilityPanel,detail:state.capabilityDetail,space:state.composerSpaceMenu,docs:state.documentPicker,mentions:state.mentionMenu,home:state.homeCustomize,quick:state.quickPanel,settings:state.settingsPanel})`);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{agent:false,detail:null,space:false,docs:null,mentions:false,home:false,quick:null,settings:true});
});
test('打开其他菜单会关闭原Agent菜单；点击当前触发器也能关闭',async()=>{
  const u=ui();u.run(`state.capabilityPanel=true;state.capabilitySection='agent'`);
  await u.click('toggle-composer-space');
  assert.equal(u.run('state.capabilityPanel'),false);assert.equal(u.run('state.composerSpaceMenu'),true);
  await u.click('toggle-capabilities','tools','capability');
  assert.equal(u.run('state.composerSpaceMenu'),false);assert.equal(u.run('state.capabilityPanel'),true);assert.equal(u.run('state.capabilitySection'),'tools');
  await u.click('toggle-capabilities','tools','capability');assert.equal(u.run('state.capabilityPanel'),false);
});
test('直接选择Agent后菜单立即收起，不再要求进入详情二次点击',async()=>{
  const u=ui();u.run(`state.capabilityPanel=true;state.capabilitySection='agent';state.view='home'`);
  const markup=u.run('capabilityPicker()');
  assert.match(markup,/data-action="select-new-agent" data-id="codex"/);
  assert.match(markup,/aria-label="配置当前 Agent"/);
  assert.equal((markup.match(/data-action="capability-configure"/g)||[]).length,1);
  assert.doesNotMatch(markup,/data-action="capability-detail" data-id="codex"/);
  await u.click('select-new-agent','codex','capability');
  assert.equal(u.run('state.composerAgentMode'),'codex');assert.equal(u.run('state.capabilityPanel'),false);
});
test('当前工作切换Agent IPC未返回前就关闭，失败不伪造执行者',async()=>{
  let reject;const pending=new Promise((_,r)=>{reject=r});
  const u=ui({setTaskAgent:()=>pending});u.run(`tasks=[{id:'w',title:'测试',workspace:'产品团队',agentMode:'workbuddy',messages:[]}];state.task='w';state.view='task';state.capabilityPanel=true`);
  const operation=u.click('select-task-agent','codex','capability');
  assert.equal(u.run('state.capabilityPanel'),false);
  reject(new Error('切换失败'));await operation;
  assert.equal(u.run('tasks[0].agentMode'),'workbuddy');assert.match(u.run('state.toast'),/切换失败/);
});
test('设置一级无检查按钮，只读连接状态与二级配置保留',()=>{
  const u=ui();const html=u.run(`state.settingsPanel=true;state.settingsSection='agent';state.settings.agent={mode:'workbuddy',workbuddyTransport:'localassistant'};settingsOverlay()`);
  assert.doesNotMatch(html,/data-action="test-connection"|检查助理在线|data-action="check-wecom-bot"|data-action="save-wecom-bot"/);
  assert.match(html,/data-connection-kind="agent"/);
  assert.match(html,/data-connection-config><summary>连接配置/);
  assert.match(html,/<select name="workbuddyTransport">/);
});
test('已连接没有重连按钮，仅断开显示重连，未授权引导配置而非后台登录',()=>{
  const u=ui();u.run(`state.connectionStatusContexts.agent=connectionContext('agent');state.connectionStatuses.agent={state:'connected',label:'已连接',message:'助理在线'}`);
  assert.doesNotMatch(u.run(`connectionStatusContent('agent')`),/reconnect-connection|configure-connection/);
  u.run(`state.connectionStatuses.agent={state:'offline',label:'已断开',message:'请确认客户端运行后重连'}`);
  assert.match(u.run(`connectionStatusContent('agent')`),/data-action="reconnect-connection"/);
  u.run(`state.connectionStatuses.agent={state:'unauthorized',label:'需授权',message:'授权失效'}`);
  assert.match(u.run(`connectionStatusContent('agent')`),/configure-connection[^>]*>重新授权/);
  assert.doesNotMatch(u.run(`connectionStatusContent('agent',{draft:true})`),/reconnect-connection|configure-connection/);
});
test('自动刷新只调用只读状态IPC，单飞，变化配置不沿用旧结果',async()=>{
  let done,calls=0;const deferred=new Promise(r=>{done=r});
  const u=ui({getConnectionStatuses:async()=>{calls++;return deferred},testConnection:()=>{throw new Error('must not invoke model or task')},authorizeWorkBuddy:()=>{throw new Error('must not authorize automatically')}});
  u.run(`state.settingsPanel=true;state.settingsSection='agent'`);
  const first=u.run('refreshConnectionStatuses()');const second=u.run('refreshConnectionStatuses()');assert.equal(calls,1);
  u.run(`state.settings={...state.settings,agent:{mode:'codex'}}`);done({agent:{state:'connected',label:'旧配置连接'}});await Promise.all([first,second]);
  assert.equal(u.run('state.connectionStatuses.agent'),undefined);
});
test('未保存Agent配置以真正保存的配置为基准，不认领旧Agent状态',()=>{
  const u=ui();u.run(`state.settings={agent:{mode:'workbuddy',workbuddyTransport:'handoff'},configurationRevision:2};state.settingsBeforeCapability=state.settings;state.settings={...state.settings,agent:{mode:'codex'}}`);
  const fields={agentMode:{value:'codex'}};
  const form={querySelector:s=>fields[s.match(/name="([^"]+)"/)?.[1]]||null,querySelectorAll:()=>[]};u.root.querySelector=s=>s==='#settings-form'?form:null;
  assert.equal(u.run(`connectionDraftChanged('agent')`),true);
  assert.equal(u.run(`connectionSavedSettings().agent.mode`),'workbuddy');
  assert.match(u.run(`connectionStatusContent('agent',{draft:connectionDraftChanged('agent')})`),/待保存/);
});

test('凭据保存后的revision变化与强制刷新不会被旧请求吞掉',async()=>{
  let done,calls=0;const old=new Promise(r=>{done=r});
  const u=ui({getConnectionStatuses:async()=>{calls++;return calls===1?old:{statuses:{agent:{state:'ready',label:'新配置'}},configurationRevision:2}}});
  u.run(`state.settings.configurationRevision=1;state.settingsPanel=true;state.settingsSection='agent'`);
  const first=u.run('refreshConnectionStatuses()');
  u.run(`state.settings={...state.settings,configurationRevision:2};refreshConnectionStatuses({force:true})`);
  done({statuses:{agent:{state:'connected',label:'旧密钥'}},configurationRevision:1});await first;
  const queued=u.run('connectionRefreshPending');if(queued)await queued;
  assert.equal(calls,2);assert.equal(u.run('state.connectionStatuses.agent.label'),'新配置');
});

test('相同配置的force请求也会排队执行，不直接复用原检测结果',async()=>{
  let done,calls=0;const old=new Promise(r=>{done=r});
  const u=ui({getConnectionStatuses:async()=>{calls++;return calls===1?old:{agent:{state:'ready',label:'强刷结果'}}}});
  const first=u.run('refreshConnectionStatuses()');u.run('refreshConnectionStatuses({force:true})');done({agent:{state:'offline',label:'旧结果'}});await first;
  const queued=u.run('connectionRefreshPending');if(queued)await queued;
  assert.equal(calls,2);assert.equal(u.run('state.connectionStatuses.agent.label'),'强刷结果');
});

test('清除凭据勾选和内置Agent依赖的模型草稿都必须显示待保存',()=>{
  const u=ui();const fields={agentMode:{value:'built-in'},provider:{value:'openai'},modelId:{value:'m'},baseUrl:{value:'https://api.example.com/v1'},modelKey:{value:''},clearModelKey:{checked:true}};
  const form={querySelector:s=>fields[s.match(/name="([^"]+)"/)?.[1]]||null,querySelectorAll:()=>[]};u.root.querySelector=s=>s==='#settings-form'?form:null;
  u.run(`state.settings={agent:{mode:'built-in'},model:{provider:'openai',modelId:'m',baseUrl:'https://api.example.com/v1'}}`);
  assert.equal(u.run(`connectionDraftChanged('model')`),true);assert.equal(u.run(`connectionDraftChanged('agent')`),true);
  fields.agentMode.value='cloudagent';fields.clearCloudagentApiKey={checked:true};u.run(`state.settings.agent.mode='cloudagent'`);assert.equal(u.run(`connectionDraftChanged('agent')`),true);
});

test('旧重连的失败不能覆盖新配置状态',async()=>{
  let reject;const pending=new Promise((_,r)=>{reject=r});const u=ui({reconnectConnection:()=>pending});
  u.run(`state.settings={agent:{mode:'codex'},configurationRevision:1}`);
  const operation=u.click('reconnect-connection','agent');
  u.run(`state.settings={agent:{mode:'kimi'},configurationRevision:2};state.connectionStatusContexts.agent=connectionContext('agent');state.connectionStatuses.agent={state:'ready',label:'Kimi已就绪'}`);
  reject(new Error('old failure'));await operation;
  assert.equal(u.run('state.connectionStatuses.agent.label'),'Kimi已就绪');
});

test('配置检测异常引导修改配置，不把error一律变成重连；可见轮询强刷避免缓存叠加',()=>{
  const u=ui();u.run(`state.connectionStatusContexts.agent=connectionContext('agent');state.connectionStatuses.agent={state:'error',label:'检测异常',message:'地址无效',action:'configure'}`);
  const markup=u.run(`connectionStatusContent('agent')`);assert.match(markup,/修改配置/);assert.doesNotMatch(markup,/reconnect-connection/);
  const source=fs.readFileSync(path.join(__dirname,'../demo/app.js'),'utf8');assert.match(source,/setInterval\([\s\S]*refreshConnectionStatuses\(\{force:true\}\)\},30000\)/);
});

test('主页不再把历史连接测试当作当前在线状态',()=>{
  const u=ui();u.run(`state.settings.checks={agent:{ok:true},model:{ok:true}}`);assert.equal(u.run('confirmedConnections().length'),0);
  u.run(`state.connectionStatusContexts.agent=connectionContext('agent');state.connectionStatuses.agent={state:'connected',label:'已连接'}`);assert.equal(u.run('confirmedConnections().length'),1);
  u.run(`state.connectionStatuses.agent={state:'offline',label:'已断开'}`);assert.equal(u.run('confirmedConnections().length'),0);
  assert.doesNotMatch(u.run(`homeWidget('external')`),/连接测试通过/);
});

test('桌面自动状态与重连IPC严格区分，自动路径不使用有副作用的连接测试',()=>{
  const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
  const block=main.slice(main.indexOf("ipcMain.handle('integrations:status'"),main.indexOf("ipcMain.handle('integrations:test'"));
  assert.match(block,/connectionStatusService\.get/);assert.doesNotMatch(block,/testConnection\(|callModel\(|sendWorkBuddy/);
  assert.match(block,/user-reconnect/);assert.match(block,/isTrustedSender/);
});
