const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function ui(){
 let html='';const handlers={};const root={set innerHTML(v){html=v},querySelector:()=>null,querySelectorAll:()=>[],addEventListener:(type,fn)=>handlers[type]=fn};
 const context=vm.createContext({document:{getElementById:()=>root,title:'',body:{classList:{add(){}}}},window:{gongzuo:{bootstrap:()=>new Promise(()=>{})}},localStorage:{getItem:()=>null,setItem(){}},setTimeout:()=>0});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../demo/work-index.js'),'utf8'),context);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../demo/app.js'),'utf8'),context);
 return {run:s=>vm.runInContext(s,context),html:()=>html};
}
const request=(id,title,text,date='2026-10-16T04:00:00Z')=>({id,title,goal:title,workspace:'项目A',messages:[{id:'u',role:'user',text,createdAt:date}],createdAt:date,updatedAt:date});
test('桌面启动不会短暂展示三项演示工作',()=>{
 const u=ui();assert.equal(u.run('tasks.length'),0);assert.doesNotMatch(u.html(),/完善新同事入职清单|给客户反馈应用增加统计页/);
});
test('实际PPT需求代替在吗/入职seed标题，简短问候与联调/未使用示例只在次级',()=>{
 const u=ui();const tasks=[request('ppt','在吗','你先帮我随便做一个ppt'),{...request('onboarding','完善新同事入职清单','帮我开发一个CDC的介绍PPT'),goal:'完善新同事入职清单，让接手人一眼看出当前进度。'},request('hello','在吗','在吗'),request('meta','在吗','那你现在是什么模型？'),request('test','【联调】查接口','【联调】查接口'),{id:'insight',title:'整理本季度客户洞察',goal:'整理本季度客户洞察，重点说明用户反馈发生了什么变化。',messages:[]}];
 u.run(`tasks=${JSON.stringify(tasks)};state.drawerOpen=true;state.drawer='history';state.historyView='project';render()`);
 const html=u.html();const primary=html.split('<details class="history-secondary">')[0];
 assert.match(primary,/CDC的介绍PPT/);assert.match(primary,/制作示例 PPT/);assert.doesNotMatch(primary,/完善新同事入职清单|<strong>在吗<\/strong>|联调.*查接口|整理本季度客户洞察/);
 assert.match(html,/其他对话与记录/);assert.match(html,/模型与能力咨询|简短问候/);assert.match(html,/旧版示例/);
 assert.equal(u.run('tasks.length'),6);assert.equal(u.run('tasks.find(t=>t.id===\'onboarding\').title'),'完善新同事入职清单');
});
test('时间与项目两种视角打开同一任务，不复制数据，时间按本地日界限',()=>{
 const u=ui();u.run(`tasks=${JSON.stringify([request('a','查库存','查库存')])};state.historyView='time';state.drawerOpen=true;render()`);
 assert.match(u.html(),/按时间/);assert.match(u.html(),/按项目/);
 const today=u.run(`workTimeGroup({updatedAt:new Date(2026,9,16,0,1).toISOString()},new Date(2026,9,16,14))`);assert.equal(today.name,'今天');
 const yesterday=u.run(`workTimeGroup({updatedAt:new Date(2026,9,15,23,59).toISOString()},new Date(2026,9,16,14))`);assert.equal(yesterday.name,'昨天');
 const missing=u.run(`workTimeGroup({},new Date(2026,9,16,14))`);assert.equal(missing.name,'时间未记录');
 const ids=u.run('JSON.stringify(tasks.map(t=>t.id))');u.run(`state.historyView='project';state.historyOpenGroups=null;render()`);assert.match(u.html(),/项目A/);assert.equal(u.run('JSON.stringify(tasks.map(t=>t.id))'),ids);
});
test('列表优先已确认进展与真实文件，不以Agent已回复冒充成果',()=>{
 const u=ui();const task={...request('a','做PPT','做PPT'),agentRun:{status:'done'},progress:[{status:'published',text:'范围已核对'}],messages:[{role:'user',text:'做PPT'},{role:'assistant',text:'完成了全部操作',artifacts:[{id:'f',name:'方案.pptx'}]}]};
 u.run(`tasks=${JSON.stringify([task])}`);assert.match(u.run('workListDetail(tasks[0])'),/已确认：范围已核对/);
 u.run('tasks[0].progress=[]');assert.match(u.run('workListDetail(tasks[0])'),/文件：方案.pptx/);
 u.run('tasks[0].messages[1].artifacts=[]');assert.doesNotMatch(u.run('workListDetail(tasks[0])'),/完成了全部操作|Agent 已回复/);
});
test('旧seed续写的真实对话不再展示模拟回复，原首条用户正文不被旧goal覆盖',()=>{
 const u=ui();const task={...request('onboarding','完善新同事入职清单','帮我开发一个CDC的介绍PPT'),goal:'完善新同事入职清单，让接手人一眼看出当前进度。'};
 u.run(`tasks=${JSON.stringify([task])};state.view='task';state.task='onboarding';render()`);
 assert.match(u.html(),/按你实际交代的目标显示标题/);assert.match(u.html(),/帮我开发一个CDC的介绍PPT/);assert.doesNotMatch(u.html(),/这份清单主要给新同事本人使用/);
});
test('桌面小应用入口不把固定演示应用冒充已发布',()=>{
 const u=ui();assert.doesNotMatch(u.run('appsDrawer()'),/客户反馈管理|预算申请台/);assert.match(u.run('appsStage()'),/不会将示例界面/);
});

test('标题、摘要与原始名称均转义，个人对话不进入项目正式工作数',()=>{
 const u=ui();const malicious=request('x','在吗','生成<img src=x onerror=alert(1)>报告');u.run(`tasks=${JSON.stringify([malicious,request('g','在吗','在吗')])};state.historyView='project';state.drawerOpen=true;render()`);
 assert.doesNotMatch(u.html(),/<img src=x/);assert.match(u.html(),/&lt;img src=x/);assert.equal(u.run('substantiveWorks().length'),1);
});
