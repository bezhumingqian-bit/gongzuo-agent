const root = document.getElementById('app');
const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const safe = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const modelProviderDefaults={openai:{modelId:'',baseUrl:'https://api.openai.com/v1'},kimi:{modelId:'kimi-k2.6',baseUrl:'https://api.moonshot.cn/v1'},deepseek:{modelId:'deepseek-flash',baseUrl:'https://api.deepseek.com'},compatible:{modelId:'',baseUrl:''},local:{modelId:'',baseUrl:'http://localhost:11434/v1'}};
const modelProviderNames={openai:'OpenAI',kimi:'Kimi',deepseek:'DeepSeek'};
const modelProviderPortals={openai:'https://platform.openai.com/api-keys',kimi:'https://platform.kimi.com/',deepseek:'https://platform.deepseek.com/'};

let tasks = [
  {id:'feedback', title:'给客户反馈应用增加统计页', workspace:'产品团队', meta:'待你确认 · 产品团队 · 10 分钟前', status:'review', dot:'amber', needsMe:true},
  {id:'insight', title:'整理本季度客户洞察', workspace:'产品团队', meta:'AI 正在替你处理 · 产品团队', status:'running', dot:'green', needsMe:false},
  {id:'onboarding', title:'完善新同事入职清单', workspace:'运营团队', meta:'等待你补充 · 运营团队 · 昨天', status:'todo', dot:'violet', needsMe:true}
];

const practices = [
  {id:'build', title:'搭建内部小应用', desc:'从描述需求到可使用的应用', prompt:'做一个客户反馈管理应用，让团队可以录入、筛选和跟进反馈。'},
  {id:'analysis', title:'分析团队数据', desc:'形成结论、图表和可追溯依据', prompt:'分析这份团队数据，找出主要变化并生成可分享的结论。'},
  {id:'handoff', title:'整理项目交接', desc:'把背景、决定和待办交给同事', prompt:'整理这个项目的背景、关键决定和下一步待办，方便新成员接手。'}
];

const homeModuleCatalog = {
  needs:{title:'待我处理',icon:'tasks',description:'需要你确认或补充的工作'},
  space:{title:'当前空间工作',icon:'users',description:'这台设备上可见的空间工作'},
  external:{title:'外部接入',icon:'plug',description:'已连接的 Agent 与企业系统'},
  documents:{title:'空间资料',icon:'folder',description:'当前空间可用的资料'},
  recent:{title:'最近工作',icon:'history',description:'继续你参与的工作'},
  starters:{title:'从这里开始',icon:'spark',description:'常用的 Agent 工作方式'}
};
const defaultHomeModules=Object.keys(homeModuleCatalog);
function readHomePreferences(){
  const fallback={mode:'overview',modules:[...defaultHomeModules],hidden:[]};
  try{
    const saved=JSON.parse(localStorage.getItem('gongzuo.home.v1')||'null');
    if(!saved||typeof saved!=='object')return fallback;
    const modules=Array.isArray(saved.modules)?saved.modules.filter(id=>defaultHomeModules.includes(id)):[];
    return {
      mode:['overview','compact','agent'].includes(saved.mode)?saved.mode:fallback.mode,
      modules:[...new Set([...modules,...defaultHomeModules])],
      hidden:Array.isArray(saved.hidden)?saved.hidden.filter(id=>defaultHomeModules.includes(id)):[]
    };
  }catch{return fallback}
}
const initialHomePreferences=readHomePreferences();

const state = {
  task:null,
  view:'home',
  homeMode:initialHomePreferences.mode,
  homeDefaultMode:initialHomePreferences.mode,
  homeModules:initialHomePreferences.modules,
  homeHidden:initialHomePreferences.hidden,
  homeCustomize:false,
  drawer:'history',
  drawerOpen:false,
  workFilter:'recent',
  historyOpenGroups:null,
  artifactOpen:false,
  artifactTab:'preview',
  published:false,
  feedbackStatus:'处理中',
  channelUpdateApplied:true,
  workspace:'产品团队',
  messages:[],
  agentStatus:null,
  workspaces:[{id:'product',name:'产品团队',type:'team'},{id:'operations',name:'运营团队',type:'team'},{id:'public',name:'公共空间',type:'public'}],
  projectDialog:false,
  memberPanel:false,
  memories:{personal:[],team:[]},
  memoryPanel:false,
  memoryScope:'personal',
  memoryDraft:null,
  settingsPanel:false,
  settingsSection:'model',
  settingsBeforeCapability:null,
  modelDraftProfiles:null,
  settings:{model:{provider:'openai',modelId:'',baseUrl:'https://api.openai.com/v1'},agent:{mode:'built-in',endpoint:''},hasModelKey:false,hasAgentToken:false,secretStorageAvailable:false},
  documents:[],
  wecomDirectory:{members:[],syncedAt:null},
  inboundMessages:[],
  docCategory:'全部',
  docSearch:'',
  docShowArchived:false,
  docEditing:null,
  docDraft:null,
  composerSpaceMenu:false,
  mentionMenu:false,
  mentionQuery:'',
  mentionCursor:0,
  composerMentions:[],
  capabilityPanel:false,
  capabilitySection:'agent',
  capabilityTab:'skill',
  capabilityDetail:null,
  composerDrafts:{'home-input':'','thread-input':''},
  composerDocuments:{'home-input':[],'thread-input':[]},
  documentPicker:null,
  wecomSendTarget:null,
  wecomRecipientDraft:'',
  wecomSendError:'',
  wecomSubmitting:false,
  recentAttachment:null,
  quickPanel:null,
  searchQuery:'',
  sourceExpanded:false,
  miniTab:'feedback',
  miniFormOpen:false,
  demoFeedback:[]
};

const desktopApi = window.gongzuo || null;

function normalizeDesktopTask(task){
  const statusMeta={review:'待你确认',running:'AI 正在处理',todo:'等待你补充',done:'已完成'};
  const runMeta={'awaiting-workbuddy':'等待 WorkBuddy 领取',queued:'Agent 等待执行',running:'Agent 正在处理',done:'Agent 已回复',failed:'Agent 调用失败',interrupted:'Agent 执行中断','not-configured':'待配置 Agent'};
  return {
    ...task,
    title:task.title||task.goal||'未命名工作',
    meta:task.meta||`${task.channelOnly?'企微消息':runMeta[task.agentRun?.status]||statusMeta[task.status]||'进行中'} · ${task.workspace||state.workspace}`,
    dot:task.dot||(task.channelOnly?'green':task.needsMe?'amber':task.status==='running'?'green':'violet')
  };
}

function applyDesktopData(data){
  if(!data) return;
  if(Array.isArray(data.tasks)) tasks=data.tasks.map(normalizeDesktopTask);
  if(Array.isArray(data.workspaces)) state.workspaces=data.workspaces.map(space=>({...space,members:Array.isArray(space.members)?space.members:[]}));
  if(data.activeWorkspace) state.workspace=data.activeWorkspace;
  if(data.wecomDirectory) state.wecomDirectory=data.wecomDirectory;
  if(Array.isArray(data.inboundMessages)||Array.isArray(data.wecomEvents)){
    const inbox=Array.isArray(data.inboundMessages)?data.inboundMessages:[];
    const known=new Set(inbox.map(item=>item.id));
    const legacy=(data.wecomEvents||[]).filter(item=>item.chatType==='single'&&!known.has(`wecom:${item.msgId}`)).map(item=>({id:`wecom:${item.msgId}`,channel:'wecom',senderId:item.userId,receivedAt:item.at,text:''}));
    state.inboundMessages=[...inbox,...legacy].sort((a,b)=>Date.parse(b.receivedAt||'')-Date.parse(a.receivedAt||'')).slice(0,20);
  }
}

function trafficLights(){return `<div class="traffic"><i></i><i></i><i></i></div>`}
function workspaceInitial(name){return ({产品团队:'产',运营团队:'运',公共空间:'公'})[name]||String(name||'空').slice(0,1)}
function workspaceType(space){return space.type||(space.id==='public'?'public':'team')}
function currentWorkspace(){return state.workspaces.find(space=>space.name===state.workspace)}
function mentionMembers(workspaceName){
  const workspace=state.workspaces.find(space=>space.name===workspaceName);
  if(!desktopApi&&workspace?.type!=='project'){
    const demoMembers=workspaceName==='产品团队'?[{id:'demo-zhang',name:'张宁'},{id:'demo-li',name:'李然'}]:workspaceName==='运营团队'?[{id:'demo-wang',name:'王敏'}]:[];
    return demoMembers.map(member=>({...member,status:'demo'}));
  }
  return (workspace?.members||[]).filter(member=>member.id!=='local-user');
}
function mentionPicker(workspaceName){
  const query=state.mentionQuery.trim().toLowerCase();
  const members=mentionMembers(workspaceName).filter(member=>!query||`${member.name||''} ${member.email||''}`.toLowerCase().includes(query));
  return `<div class="mention-picker" role="listbox" aria-label="选择要提醒的同事"><div class="mention-picker-head"><strong>@ 同事</strong><span>${desktopApi?'已关联企微的成员会收到通知':'演示选择，不会真实送达'}</span></div>${members.length?members.map(member=>`<button type="button" role="option" data-action="select-mention" data-id="${safe(member.id)}" ${member.status==='pending'?'disabled':''}><span class="mention-avatar">${safe((member.name||member.email||'同').slice(0,1))}</span><span><strong>${safe(member.name||member.email)}</strong><small>${member.status==='pending'?'待加入，暂不能提醒':member.status==='demo'?'演示同事':member.wecomUserId?'企微 '+member.wecomUserId:member.email||'当前空间成员'}</small></span></button>`).join(''):'<p>当前空间没有可选择的同事。接入企业通讯录后即可按空间权限选择成员。</p>'}</div>`;
}
function workspaceDocuments(name){const id=activeWorkspaceId(name);return state.documents.filter(document=>document.workspaceId===id)}
function documentCount(name){return workspaceDocuments(name).filter(document=>document.status==='active').length}
function formatSize(size){return size<1024?`${size} B`:size<1024*1024?`${(size/1024).toFixed(1)} KB`:`${(size/1024/1024).toFixed(1)} MB`}
function saveHomePreferences(){
  try{localStorage.setItem('gongzuo.home.v1',JSON.stringify({mode:state.homeDefaultMode,modules:state.homeModules,hidden:state.homeHidden}))}catch{}
}

function titlebar(){
  return `<header class="titlebar">
    <div class="title-left">${trafficLights()}<button class="chrome-button" data-action="toggle-drawer" aria-label="切换会话栏">${icon('panel')}</button></div>
    <div class="title-actions"><button class="chrome-button" data-action="toggle-channel-inbox" aria-label="消息收件" title="查看已连接渠道的来信">${icon('comment')}</button><button class="chrome-button" data-action="toggle-notifications" aria-label="通知" title="通知">${icon('bell')}${tasks.some(task=>task.needsMe)?'<i class="bell-indicator"></i>':''}</button><button class="title-profile" data-action="toggle-people" aria-label="查看当前成员" title="当前成员"><span>明</span><i></i></button></div>
  </header>`;
}

function rail(){return `<nav class="rail" aria-label="主要功能">
  <button class="brand-glyph ${state.view==='home'?'active':''}" data-action="new" aria-label="打开主页" data-tooltip="主页">${icon('spark')}</button>
  <button class="rail-button ${state.drawerOpen&&state.drawer==='history'?'active':''}" data-action="drawer" data-id="history" aria-label="我的工作" data-tooltip="我的工作">${icon('tasks')}<span>工作</span></button>
  <button class="rail-button ${state.drawerOpen&&state.drawer==='team'?'active':''}" data-action="drawer" data-id="team" aria-label="工作空间" data-tooltip="工作空间">${icon('users')}<span>空间</span></button>
  <button class="rail-button ${state.drawerOpen&&state.drawer==='apps'?'active':''}" data-action="drawer" data-id="apps" aria-label="团队小应用" data-tooltip="团队小应用">${icon('app')}<span>小应用</span></button>
  <div class="rail-spacer"></div>
  <button class="rail-button settings-rail" data-action="open-settings" aria-label="连接与模型设置" data-tooltip="设置">${icon('settings')}<span>设置</span></button>
  <button class="rail-avatar" data-action="open-memory" data-id="personal" aria-label="个人记忆" title="个人记忆">明</button>
</nav>`}

function historyDrawer(){
  const recentTasks=tasks.map((task,index)=>({task,index,time:Date.parse(task.updatedAt||task.createdAt||'')||0})).sort((a,b)=>b.time-a.time||a.index-b.index).map(item=>item.task);
  const groups=[];
  for(const task of recentTasks){
    const name=task.workspace||'未归类';
    let group=groups.find(item=>item.name===name);
    if(!group){group={name,items:[]};groups.push(group)}
    group.items.push(task);
  }
  const row=task=>`<button class="task-item ${state.task===task.id?'active':''}" data-action="open-task" data-id="${safe(task.id)}"><span class="status-dot ${safe(task.dot)}"></span><span><strong>${safe(task.title)}</strong><small>${safe(task.meta)}</small></span></button>`;
  const openGroups=state.historyOpenGroups===null?groups.slice(0,1).map(group=>group.name):state.historyOpenGroups;
  const recentContent=groups.map(group=>{const open=openGroups.includes(group.name);const space=state.workspaces.find(item=>item.name===group.name);return `<div class="history-group"><button class="history-group-head ${open?'open':''}" data-action="toggle-history-group" data-id="${safe(group.name)}" aria-expanded="${open?'true':'false'}"><span class="history-group-avatar ${space&&workspaceType(space)==='project'?'project':''}">${safe(workspaceInitial(group.name))}</span><span class="history-group-copy"><strong>${safe(group.name)}</strong><small>${group.items.length} 项工作 · 最近：${safe(group.items[0].title)}</small></span>${icon('chevron')}</button>${open?`<div class="history-group-items">${group.items.slice(0,4).map(row).join('')}${group.items.length>4?`<button class="history-group-more" data-action="search-history-space" data-id="${safe(group.name)}">搜索更多 ${group.items.length-4} 项${icon('arrow')}</button>`:''}</div>`:''}</div>`}).join('');
  return `<aside class="drawer">
  <div class="drawer-head"><strong>我的工作</strong><button class="icon-button" data-action="search" aria-label="搜索">${icon('search')}</button></div>
  <p class="drawer-scope">${state.workFilter==='recent'?'按项目或团队收拢我参与的工作；后续对话留在工作内。':'需要你确认或补充的工作'}</p>
  <div class="drawer-filter"><button class="${state.workFilter==='recent'?'active':''}" data-action="work-filter" data-id="recent">最近参与</button><button class="${state.workFilter==='needs'?'active':''}" data-action="work-filter" data-id="needs">需要我</button></div>
  <div class="task-list">${state.workFilter==='needs'?(recentTasks.filter(task=>task.needsMe).map(row).join('')||'<p class="history-empty">目前没有待你处理的工作</p>'):(recentContent||'<p class="history-empty">还没有参与的工作</p>')}</div>
  <div class="drawer-bottom"><span>${icon('shield')} 工作与资料按空间归档</span></div>
</aside>`}

function teamDrawer(){
  const spaces=state.workspaces;
  const groups={team:spaces.filter(space=>workspaceType(space)==='team'),project:spaces.filter(space=>workspaceType(space)==='project'),public:spaces.filter(space=>workspaceType(space)==='public')};
  const count=documentCount(state.workspace);
  const row=(space,index)=>`<button class="space-row ${state.workspace===space.name?'active':''}" data-action="switch-workspace" data-id="${safe(space.name)}"><span class="space-avatar ${workspaceType(space)==='project'?'project-avatar':`s${index}`}">${safe(workspaceInitial(space.name))}</span><span><strong>${safe(space.name)}</strong><small>${workspaceType(space)==='project'?`${(space.members||[]).filter(member=>['active','wecom'].includes(member.status)).length} 位成员 · `:''}${documentCount(space.name)} 份资料${workspaceType(space)==='public'?' · 本机公共范围':''}</small></span>${state.workspace===space.name?icon('check'):''}</button>`;
  return `<aside class="drawer">
    <div class="drawer-head"><strong>工作空间</strong><div class="drawer-head-actions"><button class="drawer-create-project" data-action="open-project-dialog">${icon('plus')}新建项目</button><button class="icon-button" data-action="search" aria-label="搜索">${icon('search')}</button></div></div>
    <p class="drawer-copy">按团队或项目组织工作与资料，空间成员单独管理。</p>
    <div class="drawer-label">团队空间</div>
    ${groups.team.map(row).join('')}
    <div class="drawer-label">项目空间</div>
    ${groups.project.length?groups.project.map(row).join(''):'<p class="project-empty-note">还没有项目空间</p>'}
    <div class="drawer-label">公共空间</div>
    ${groups.public.map(row).join('')}
    <div class="drawer-label">当前空间内容</div>
    <div class="context-summary"><div>${icon('book')}<span><strong>${count} 份空间资料</strong><small>可在右侧上传、分类和管理</small></span></div><div>${icon('comment')}<span><strong>消息来源尚未接入</strong><small>飞书、企业微信和邮件留待后续配置</small></span></div></div>
    <div class="drawer-label">长期记忆</div>
    <button class="memory-entry" data-action="open-memory" data-id="personal">${icon('user')}<span><strong>个人记忆</strong><small>只供你使用，跨工作空间保留</small></span>${icon('chevron')}</button>
    <button class="memory-entry" data-action="open-memory" data-id="team">${icon('users')}<span><strong>团队记忆</strong><small>${safe(state.workspace)}的约定、流程和项目背景</small></span>${icon('chevron')}</button>
    <p class="context-note">切换空间会改变新工作的资料范围，不会移动已有工作。当前空间资料只保存在这台 Mac 上。</p>
  </aside>`;
}

function appsDrawer(){return `<aside class="drawer">
  <div class="drawer-head"><strong>团队小应用</strong><button class="icon-button" data-action="search" aria-label="搜索">${icon('search')}</button></div>
  <p class="drawer-copy">团队成员让 Agent 做出来并发布的工作工具。用于录入、查询、审批和统计，同事可以直接使用。</p>
  <button class="app-row ${state.view==='apps'?'active':''}" data-action="open-app" aria-current="${state.view==='apps'?'page':'false'}"><span class="app-icon purple">${icon('app')}</span><span><strong>客户反馈管理</strong><small>产品团队 · ${state.published?'v2':'v1'} · 反馈录入与跟进</small></span>${icon('chevron')}</button>
  <div class="drawer-label">最近更新</div>
  <p class="drawer-event"><b>客户反馈管理</b>${state.published?'已发布 v2。':'的 v2 正在等待确认。'}</p>
</aside>`}

function drawer(){
  if(!state.drawerOpen) return '';
  if(state.drawer==='team') return teamDrawer();
  if(state.drawer==='apps') return appsDrawer();
  return historyDrawer();
}

function workspaceStage(){
  const name=state.workspace;
  const space=currentWorkspace();
  const isProject=space&&workspaceType(space)==='project';
  const parent=space?.parentWorkspaceId?state.workspaces.find(item=>item.id===space.parentWorkspaceId):null;
  const projectTasks=isProject?tasks.filter(task=>task.workspace===name):[];
  const all=workspaceDocuments(name);
  const active=all.filter(document=>document.status==='active');
  const shown=all.filter(document=>(state.docShowArchived?document.status==='archived':document.status==='active')&&(state.docCategory==='全部'||document.category===state.docCategory)&&(!state.docSearch||`${document.name} ${document.tags.join(' ')}`.toLowerCase().includes(state.docSearch.toLowerCase())));
  return `<main class="stage workspace-stage">
    <header class="space-stage-head"><div><span class="space-stage-mark">${safe(workspaceInitial(name))}</span><div><small>${isProject?'项目空间 / 总览':'工作空间 / 资料'}</small><h1>${safe(name)}</h1><p>${isProject?`独立的项目资料与成员${parent?` · 关联${safe(parent.name)}`:''}`:name==='公共空间'?'供公共空间中的工作使用的资料':'归属于这个团队空间的资料'}</p></div></div><div class="space-head-actions">${(isProject||space&&workspaceType(space)==='team')?`<button class="space-member-button" data-action="open-project-members">${icon('users')}成员 ${(space.members||[]).filter(member=>['active','wecom'].includes(member.status)).length}</button>`:''}<button class="dark-button" data-action="upload-documents">${icon('plus')}上传资料</button></div></header>
    <div class="space-stage-body">${isProject?`<div class="project-context"><div><span>${icon('folder')}项目空间</span><p>${safe(space.description||'在这里集中项目任务、资料和长期记忆。')}</p><small>项目资料不自动继承关联团队的访问权限。</small></div><button class="project-start-button" data-action="start-project-work">${icon('spark')}发起项目工作</button></div>`:''}<div class="space-summary"><div><span>当前资料</span><strong>${active.length}</strong><small>按空间归档</small></div><div><span>${isProject?'项目工作':'规范与模板'}</span><strong>${isProject?projectTasks.length:active.filter(document=>['规范','模板'].includes(document.category)).length}</strong><small>${isProject?'当前设备可见':'可分类和打标签'}</small></div><div><span>${isProject?'项目成员':'资料范围'}</span><strong>${isProject?(space.members||[]).filter(member=>['active','wecom'].includes(member.status)).length:name==='公共空间'?'公共':'团队'}</strong><small>${isProject?`${(space.members||[]).filter(member=>member.status==='pending').length} 位待邀请`:'当前为本机演示'}</small></div></div>
    ${isProject?`<div class="space-section-head"><div><h2>项目工作</h2><p>在这个空间发起和追踪的工作</p></div></div><div class="project-task-list">${projectTasks.length?projectTasks.map(task=>`<button class="home-task-row" data-action="open-task" data-id="${safe(task.id)}"><i class="status-dot ${safe(task.dot)}"></i><span><strong>${safe(task.title)}</strong><small>${safe(task.meta)}</small></span>${icon('chevron')}</button>`).join(''):'<p>还没有项目工作，点击“发起项目工作”开始。</p>'}</div>`:''}
    <div class="space-section-head"><div><h2>空间资料</h2><p>上传后保存在这台 Mac；发起工作时可明确引用支持的资料正文。</p></div></div>
    <div class="doc-toolbar"><label class="doc-search">${icon('search')}<input id="doc-search" type="search" value="${safe(state.docSearch)}" placeholder="搜索文件名或标签" aria-label="搜索空间资料"></label><div class="doc-filters">${['全部','规范','模板','项目资料','其他'].map(category=>`<button class="${state.docCategory===category?'active':''}" data-action="doc-category" data-id="${category}">${category}</button>`).join('')}</div><button class="doc-archive-toggle ${state.docShowArchived?'active':''}" data-action="doc-archived">${state.docShowArchived?'返回当前资料':'查看已移出'}</button></div>
    <div class="doc-list">${shown.length?shown.map(document=>`<article class="doc-row"><span class="doc-file-icon">${icon('file')}</span><div class="doc-info"><strong>${safe(document.name)}</strong><small>${safe(document.category)} · ${formatSize(document.size)} · ${new Date(document.createdAt).toLocaleDateString('zh-CN')}${document.status==='archived'?' · 已移出':''}</small>${document.tags?.length?`<div class="doc-tags">${document.tags.map(tag=>`<span>#${safe(tag)}</span>`).join('')}</div>`:''}</div><div class="doc-actions">${document.status==='active'?`<button data-action="open-document" data-id="${safe(document.id)}">打开</button><button data-action="edit-document" data-id="${safe(document.id)}">分类与标签</button><button data-action="archive-document" data-id="${safe(document.id)}">移出</button>`:`<button data-action="restore-document" data-id="${safe(document.id)}">恢复</button>`}</div></article>`).join(''):`<div class="doc-empty">${icon('folder')}<strong>${state.docShowArchived?'没有已移出的资料':state.docSearch||state.docCategory!=='全部'?'没有符合条件的资料':`${safe(name)}还没有资料`}</strong><span>${state.docShowArchived?'移出的资料会保留在本机，方便恢复。':'上传文档后，可以按分类和标签找到它。'}</span>${!state.docShowArchived&&!state.docSearch&&state.docCategory==='全部'?'<button class="soft-button" data-action="upload-documents">上传第一份资料</button>':''}</div>`}</div>
    <p class="space-local-note">${desktopApi?'当前未接入企业账号，空间资料只保存在这台 Mac，尚未同步给其他成员。':'浏览器演示上传的资料仅保留在当前页面，刷新后会消失。'}</p></div>
  </main>`;
}

function projectDialog(){
  const teams=state.workspaces.filter(space=>workspaceType(space)==='team');
  return `<div class="workspace-dialog-overlay" role="dialog" aria-modal="true" aria-label="新建项目空间"><form class="workspace-dialog" id="project-space-form"><div class="workspace-dialog-head"><div><small>第 1 步 / 共 2 步 · 创建项目</small><h2>新建项目空间</h2><p>把同一项目的工作、资料和参与者放在一个独立空间。</p></div><button type="button" class="icon-button" data-action="close-project-dialog" aria-label="关闭">${icon('close')}</button></div><div class="workspace-dialog-body"><label>项目名称<input name="name" maxlength="80" placeholder="例如：客户反馈升级" required></label><label>关联团队 <span>用于归类，不自动共享团队资料</span><select name="parentWorkspaceId"><option value="">不关联团队</option>${teams.map(team=>`<option value="${safe(team.id)}">${safe(team.name)}</option>`).join('')}</select></label><label>项目说明 <span>可选</span><textarea name="description" maxlength="300" rows="3" placeholder="这个项目要完成什么？"></textarea></label><div class="project-create-preview"><span>${icon('shield')}创建后你是项目负责人</span><span>${icon('users')}下一步添加同事并选择权限</span></div><p class="workspace-dialog-note">项目资料不会自动开放给关联团队。当前未接入企业账号，邀请将先作为待办保存在本机。</p></div><div class="workspace-dialog-actions"><button type="button" data-action="close-project-dialog">取消</button><button type="submit" class="dark-button">创建并添加成员</button></div></form></div>`;
}

function projectMembersDialog(){
  const space=currentWorkspace();
  if(!space||!['project','team'].includes(workspaceType(space)))return '';
  const owner=workspaceType(space)==='team'||space.createdBy==='local-user';
  const members=space.members||[];
  return `<div class="workspace-dialog-overlay" role="dialog" aria-modal="true" aria-label="${safe(space.name)}的成员"><section class="workspace-dialog"><div class="workspace-dialog-head"><div><small>${safe(space.name)} · 第 2 步 / 共 2 步</small><h2>关联同事参与工作</h2><p>已同步的企微成员可参与当前空间的机器人工作和 @ 提醒。</p></div><button class="icon-button" data-action="close-project-members" aria-label="关闭">${icon('close')}</button></div><div class="workspace-dialog-body"><div class="project-member-list">${members.map(member=>`<div class="project-member-row"><span class="project-member-avatar">${safe((member.name||member.email||'成').slice(0,1))}</span><span><strong>${safe(member.name||member.email||'成员')}</strong><small>${safe(member.wecomUserId?'企微 '+member.wecomUserId:member.email||'当前设备的创建者')}</small></span><em class="${member.status==='pending'?'pending':''}">${member.status==='pending'?'待邀请 · 未授权':member.status==='wecom'?'企微参与':member.role==='owner'?'创建者':'已加入'}</em>${owner&&['pending','wecom'].includes(member.status)?`<select class="project-role-select" data-member-role="${safe(member.id)}" aria-label="${safe(member.name||member.email)}的项目权限"><option value="viewer" ${member.role==='viewer'?'selected':''}>只读</option><option value="editor" ${member.role!=='viewer'?'selected':''}>协作</option></select><button data-action="remove-project-member" data-id="${safe(member.id)}" aria-label="移除${safe(member.name||member.email)}">移除</button>`:member.role==='owner'?'':'<small class="project-role-text">'+(member.role==='viewer'?'只读':'协作')+'</small>'}</div>`).join('')}</div>${owner&&desktopApi?`<form id="project-wecom-member-form" class="project-member-form"><h3>关联企微同事</h3><label>企微成员<select name="userId" required><option value="">请选择已同步成员</option>${state.wecomDirectory.members.filter(item=>!members.some(member=>member.wecomUserId===item.userId)).map(item=>`<option value="${safe(item.userId)}">${safe(item.name)} · ${safe(item.userId)}</option>`).join('')}</select></label><label>企微操作权限<select name="role"><option value="editor">协作 · 可通过机器人新建和更新</option><option value="viewer">只读 · 仅可查看</option></select></label><button class="dark-button" type="submit">关联企微成员</button></form>`:''}${owner&&workspaceType(space)==='project'?`<form id="project-member-form" class="project-member-form"><h3>添加待邀请同事</h3><label>同事邮箱<input name="email" type="email" maxlength="254" placeholder="name@company.com" required></label><label>显示名称 <span>可选</span><input name="name" maxlength="80" placeholder="同事姓名"></label><label>项目权限<select name="role"><option value="editor">协作 · 可参与工作与资料</option><option value="viewer">只读 · 可查看项目内容</option></select></label><button class="dark-button" type="submit">保存待邀请成员</button></form>`:''}<p class="workspace-dialog-note">${desktopApi?'企微成员可通过机器人参与当前空间并接收 @ 提醒；网页或其他设备访问仍未开通。邮箱待邀请名单仅保存在本机。':'浏览器演示名单只保留在当前页面，刷新后会消失；不会发送邀请。'}</p><button class="project-members-done" data-action="close-project-members">完成，查看项目</button></div></section></div>`;
}

function documentEditor(){
  const draft=state.docDraft;
  if(!draft) return '';
  return `<div class="doc-editor-overlay" role="dialog" aria-modal="true" aria-label="编辑资料分类与标签"><form class="doc-editor" id="document-form"><div class="doc-editor-head"><div><small>资料管理</small><h2>分类与标签</h2><p>${safe(draft.name)}</p></div><button type="button" class="icon-button" data-action="close-document-editor" aria-label="关闭">${icon('close')}</button></div><label>分类<select name="category">${['规范','模板','项目资料','其他'].map(category=>`<option ${draft.category===category?'selected':''}>${category}</option>`).join('')}</select></label><label>标签<input name="tags" value="${safe((draft.tags||[]).join(', '))}" placeholder="用逗号分隔，例如：入职、流程"></label><p>标签用于人工整理与查找资料，不会自动训练模型。</p><div class="doc-editor-actions"><button type="button" class="soft-button" data-action="close-document-editor">取消</button><button type="submit" class="dark-button">保存</button></div></form></div>`;
}

function selectedAgentMode(){return state.view==='task'&&state.task?tasks.find(task=>task.id===state.task)?.agentMode||state.settings?.agent?.mode:state.settings?.agent?.mode}
function agentLabel(mode){return ({codex:'Codex',kimi:'Kimi Code',codebuddy:'CodeBuddy',workbuddy:'WorkBuddy',external:'自定义 Agent'})[mode]||'团队 Agent'}
function agentReady(mode){
  const config=state.settings||{};
  if(['codex','kimi','codebuddy'].includes(mode))return true;
  if(mode==='workbuddy')return true;
  if(mode==='external')return Boolean(config.agent?.endpoint);
  return Boolean(config.model?.modelId);
}

function composer(id='home-input', compact=false){
  const taskWorkspace=state.view==='task'&&state.task?tasks.find(task=>task.id===state.task)?.workspace:null;
  const shownWorkspace=taskWorkspace||state.workspace;
  const selected=state.composerDocuments[id]||[];
  const available=state.documents.filter(document=>document.workspaceId===activeWorkspaceId(shownWorkspace)&&document.status==='active'&&/\.(txt|md|csv|pdf|docx|doc)$/i.test(document.name));
  return `<div class="composer ${compact?'compact':''}">
  <textarea id="${id}" aria-label="${compact?'工作或企微消息':'新工作或企微消息'}" placeholder="${compact?'输入工作指令或企微消息；可输入 @ 提及同事…':'告诉 Agent 你的目标，或输入要发给企微的消息…'}">${safe(state.composerDrafts[id]||'')}</textarea>
  ${compact&&state.mentionMenu?mentionPicker(shownWorkspace):''}
  ${selected.length?`<div class="composer-document-refs">${selected.map(docId=>{const doc=state.documents.find(item=>item.id===docId);return doc?`<button data-action="select-document" data-id="${safe(docId)}" data-input="${id}" title="移除引用">${icon('file')}${safe(doc.name)} ×</button>`:''}).join('')}</div>`:''}
  ${state.documentPicker===id?`<div class="composer-document-picker"><strong>引用${safe(shownWorkspace)}的资料</strong><small>只把你选中的正文发送给当前 Agent；最多 3 份，每份取前 12000 字。</small>${available.length?available.map(doc=>`<button data-action="select-document" data-id="${safe(doc.id)}" data-input="${id}">${icon('file')}<span>${safe(doc.name)}</span>${selected.includes(doc.id)?icon('check'):''}</button>`).join(''):'<p>当前空间没有可引用的 PDF、Word 或文本资料。</p>'}</div>`:''}
  ${state.recentAttachment?.workspace===shownWorkspace?`<div class="composer-attachment">${icon('file')}<span>${safe(state.recentAttachment.name)} 已加入${safe(shownWorkspace)}资料</span><button data-action="view-attached-document">查看</button></div>`:''}
  <div class="composer-bar"><div><button class="composer-tool" data-action="upload-from-composer" aria-label="上传文件到当前空间资料" title="上传到当前空间资料">${icon('paperclip')}</button><button class="composer-doc-button" data-action="toggle-document-picker" data-id="${id}" aria-label="引用空间资料" aria-expanded="${state.documentPicker===id?'true':'false'}">${icon('file')}引用资料</button>${compact?`<button class="mention-trigger" data-action="toggle-mentions" aria-label="@ 同事" aria-expanded="${state.mentionMenu?'true':'false'}">@ 同事</button>`:''}<div class="composer-space-anchor"><button class="context-pill" data-action="toggle-composer-space" aria-label="选择工作空间，当前为${safe(shownWorkspace)}"><span class="workspace-mark tiny">${safe(workspaceInitial(shownWorkspace))}</span>${safe(shownWorkspace)}${icon('down')}</button>${state.composerSpaceMenu?`<div class="composer-space-menu"><strong>${taskWorkspace?'此任务的空间不能更改；选择后会开始新工作':'新工作使用哪个空间？'}</strong>${(state.workspaces.length?state.workspaces:[{name:'产品团队'},{name:'运营团队'},{name:'公共空间'}]).map(space=>`<button data-action="select-composer-space" data-id="${safe(space.name)}"><span class="workspace-mark tiny">${safe(workspaceInitial(space.name))}</span><span>${safe(space.name)}</span>${shownWorkspace===space.name?icon('check'):''}</button>`).join('')}</div>`:''}</div><div class="capability-anchor"><button class="capability-trigger agent-trigger ${state.capabilityPanel&&state.capabilitySection==='agent'?'active':''}" data-action="toggle-capabilities" data-id="agent" aria-label="选择执行 Agent" aria-expanded="${state.capabilityPanel&&state.capabilitySection==='agent'?'true':'false'}">${icon('spark')}<span>${agentLabel(selectedAgentMode())}</span>${icon('down')}</button>${state.capabilityPanel&&state.capabilitySection==='agent'?capabilityPicker():''}</div><div class="capability-anchor"><button class="capability-trigger tools-trigger ${state.capabilityPanel&&state.capabilitySection==='tools'?'active':''}" data-action="toggle-capabilities" data-id="tools" aria-label="查看工具与技能" aria-expanded="${state.capabilityPanel&&state.capabilitySection==='tools'?'true':'false'}">${icon('grid')}<span>工具与技能</span>${icon('down')}</button>${state.capabilityPanel&&state.capabilitySection==='tools'?capabilityPicker():''}</div></div><div>${desktopApi?`<button class="composer-wecom-send" data-action="open-wecom-composer" data-input="${id}" aria-label="直接发送到企微，不调用 Agent" title="直接发送到企微，不调用 Agent">${icon('comment')}发企微</button>`:''}<button class="send-button" data-action="submit" data-input="${id}" aria-label="交给 Agent" title="交给 Agent">${icon('arrow')}</button></div></div>
</div>`}

const capabilityItems={
  'built-in':{name:'团队 Agent',kind:'Agent',icon:'spark',description:'使用共作设置的模型处理当前工作。',needs:'先在设置中配置模型并测试连接。',result:'文本结果留在当前工作。'},
  codex:{name:'Codex',kind:'Agent',icon:'code',description:'通过本机 Codex CLI 处理当前工作，并把文本结果带回对话。',needs:'安装并登录 Codex CLI；在设置中选择后测试连接。',result:'当前只回传文本；代码仓库委派和变更审阅尚未开放。'},
  kimi:{name:'Kimi Code',kind:'Agent',icon:'code',description:'通过本机 Kimi Code CLI 处理当前工作，并把文本结果带回对话。',needs:'安装并登录 Kimi Code CLI；在设置中选择后测试连接。',result:'当前只回传文本；代码仓库委派和变更审阅尚未开放。'},
  codebuddy:{name:'CodeBuddy',kind:'Agent',icon:'code',description:'通过本机已登录的 CLI 接收当前工作的文本结果。',needs:'安装并登录 CodeBuddy Code CLI；在设置中选为执行 Agent 后测试连接。',result:'把文本回答留在当前工作；文件与工具执行尚未开放。'},
  workbuddy:{name:'WorkBuddy',kind:'Agent',icon:'spark',description:'工作排队后由 WorkBuddy 通过本机连接器领取处理，结果回到同一项工作；配置开放平台令牌后改为主动发送。',needs:'在 WorkBuddy 中信任「gongzuo」本机连接器；共作需保持运行。',result:'WorkBuddy 读取共作准备好的对话、记忆与引用资料，回复写回当前工作。'},
  external:{name:'自定义 Agent',kind:'Agent',icon:'grid',description:'接入企业已有的 Agent 服务，按任务委派工作。',needs:'需要服务地址、访问凭据与任务级授权范围。',result:'回传执行状态、成果及可追溯的调用记录。'},
  feishu:{name:'飞书',kind:'MCP 工具',icon:'comment',description:'读取获授权的群消息和文档，必要时更新协作信息。',needs:'需要企业管理员授权、成员身份映射和具体工具权限。',result:'把引用的原消息与更新动作附在当前工作里。'},
  mail:{name:'邮件',kind:'MCP 工具',icon:'send',description:'读取授权邮箱的相关邮件，整理待办或草拟回复。',needs:'需要邮箱授权，并限定账号、文件夹与操作范围。',result:'保留邮件来源；对外发送前由人确认。'},
  mcp:{name:'其他 MCP 服务',kind:'MCP 工具',icon:'plug',description:'接入企业现有系统提供的工具。',needs:'需要服务地址、身份鉴权、工具清单和空间级权限。',result:'按工具调用保留输入范围、结果及审批记录。'},
  summarySkill:{name:'资料整理',kind:'Skill 示例',icon:'file',description:'按团队约定整理资料，提取结论与待办。',needs:'需要团队确认可复用的指令、输出格式和适用范围。',result:'在当前工作中产出可检查的整理结果。'},
  appSkill:{name:'小应用构建',kind:'Skill 示例',icon:'app',description:'按团队开发规范生成和修改内部小应用。',needs:'需要团队定义技术约束、检查项和交付格式。',result:'把应用变更与检查结果留在当前工作。'}
};

function capabilityPicker(){
  const detail=capabilityItems[state.capabilityDetail];
  const section=state.capabilitySection;
  const status=id=>['built-in','codebuddy','workbuddy','codex','kimi'].includes(id)?'可配置':capabilityItems[id]?.kind==='Skill 示例'?'示例':'未接入';
  if(detail) return `<div class="capability-popover" role="dialog" aria-label="${safe(detail.name)}接入说明"><div class="capability-head"><button data-action="capability-back" aria-label="返回${section==='agent'?'Agent':'工具与技能'}列表">${icon('chevron')}</button><strong>${safe(detail.name)}</strong><span>${status(state.capabilityDetail)}</span></div><div class="capability-detail"><div class="capability-symbol">${icon(detail.icon)}</div><small>${safe(detail.kind)} · ${['codebuddy','codex','kimi'].includes(state.capabilityDetail)?'本机 CLI':state.capabilityDetail==='workbuddy'?'官方 Open API':state.capabilityDetail==='built-in'?'共作模型':'计划接入'}</small><p>${safe(detail.description)}</p><div><strong>${detail.kind==='Skill 示例'?'创建前需要':'接入前需要'}</strong><span>${safe(detail.needs)}</span></div><div><strong>接入后能做什么</strong><span>${safe(detail.result)}</span></div><p class="capability-boundary">只传当前任务授权的内容；读取与写入分别授权，跨系统写入和对外发送需要确认。</p></div><div class="capability-footer"><button data-action="capability-back">返回列表</button>${state.view==='task'&&desktopApi&&detail.kind==='Agent'?`<button class="primary" data-action="select-task-agent" data-id="${safe(state.capabilityDetail)}">用于当前工作</button>`:''}${['built-in','external','codebuddy','workbuddy','codex','kimi'].includes(state.capabilityDetail)?`<button data-action="capability-settings">设置默认</button>`:''}</div></div>`;
  const row=(id)=>{const item=capabilityItems[id];return `<button class="capability-row" data-action="capability-detail" data-id="${id}"><span class="capability-symbol">${icon(item.icon)}</span><span><strong>${safe(item.name)}</strong><small>${safe(item.description)}</small></span><em>${status(id)}</em>${icon('chevron')}</button>`};
  if(section==='agent') return `<div class="capability-popover" role="dialog" aria-label="选择执行 Agent"><div class="capability-head"><strong>执行 Agent</strong><button data-action="toggle-capabilities" data-id="agent" aria-label="关闭 Agent 列表">${icon('close')}</button></div><div class="capability-scroll"><div class="capability-current">${icon('spark')}<span><strong>${agentLabel(selectedAgentMode())}</strong><small>${state.view==='task'?'当前工作的执行者':'新工作的默认执行者'}</small></span><b>当前</b></div><h3>其他 Agent</h3>${['built-in','codebuddy','codex','kimi','workbuddy','external'].filter(id=>id!==selectedAgentMode()).map(row).join('')}</div><div class="capability-footer-note">当前工作可单独切换执行者；新工作使用设置中的默认执行者。</div></div>`;
  return `<div class="capability-popover" role="dialog" aria-label="工具与技能"><div class="capability-head"><strong>工具与技能</strong><button data-action="toggle-capabilities" data-id="tools" aria-label="关闭工具与技能">${icon('close')}</button></div><div class="capability-tabs" role="tablist" aria-label="能力类型"><button role="tab" aria-selected="${state.capabilityTab==='skill'}" class="${state.capabilityTab==='skill'?'active':''}" data-action="capability-tab" data-id="skill">技能</button><button role="tab" aria-selected="${state.capabilityTab==='mcp'}" class="${state.capabilityTab==='mcp'?'active':''}" data-action="capability-tab" data-id="mcp">MCP 工具</button></div><div class="capability-scroll"><p class="capability-intro">${state.capabilityTab==='skill'?'技能是团队沉淀的做事方法，可在工作中复用。':'这里显示 Agent 在当前工作可调用的 MCP 工具。'}</p>${state.capabilityTab==='skill'?`<div class="capability-empty"><strong>还没有团队技能</strong><span>以下是将来可以创建的示例</span></div>${['summarySkill','appSkill'].map(row).join('')}`:'<div class="capability-empty"><strong>尚未添加 MCP 工具</strong><span>企业微信消息在左下角“设置 → 企微接入”配置；工作消息可在对话中发送到企微。</span></div>'}</div><div class="capability-footer-note">${state.capabilityTab==='skill'?'示例尚不能执行，后续会支持团队创建和审核。':'这里只放 Agent 可调用的工具。'}</div></div>`;
}

function homeLayoutControls(){
  const modes=[['overview','工作台'],['compact','简洁'],['agent','Agent']];
  return `<div class="home-layout-top"><span>主页</span><div class="home-layout-actions"><div class="home-mode-switch" role="group" aria-label="主页模式">${modes.map(([id,label])=>`<button class="${state.homeMode===id?'active':''}" data-action="home-mode" data-id="${id}" aria-pressed="${state.homeMode===id?'true':'false'}">${label}</button>`).join('')}</div><div class="home-customize-anchor"><button class="home-customize-button ${state.homeCustomize?'active':''}" data-action="home-customize" aria-expanded="${state.homeCustomize?'true':'false'}">${icon('grid')}自定义模块</button>${state.homeCustomize?homeCustomizePanel():''}</div></div></div>`;
}

function homeCustomizePanel(){
  return `<div class="home-customize-panel" role="dialog" aria-label="自定义工作台模块"><div class="home-customize-head"><strong>自定义工作台</strong><button data-action="home-customize" aria-label="关闭自定义模块">${icon('close')}</button></div><p>选择要显示的模块并调整顺序。设置保存在这台设备上，切回工作台模式即可查看。</p><div class="home-module-list">${state.homeModules.map((id,index)=>{const module=homeModuleCatalog[id];const shown=!state.homeHidden.includes(id);return `<div class="home-module-row"><button class="home-module-visibility ${shown?'on':''}" data-action="home-module-toggle" data-id="${id}" aria-pressed="${shown?'true':'false'}" aria-label="${shown?'隐藏':'显示'}${safe(module.title)}">${icon(shown?'check':'plus')}</button><span><strong>${safe(module.title)}</strong><small>${safe(module.description)}</small></span><button data-action="home-module-move" data-id="${id}" data-direction="-1" aria-label="上移${safe(module.title)}" ${index===0?'disabled':''}>↑</button><button data-action="home-module-move" data-id="${id}" data-direction="1" aria-label="下移${safe(module.title)}" ${index===state.homeModules.length-1?'disabled':''}>↓</button></div>`}).join('')}</div><div class="home-customize-foot"><button data-action="home-module-reset">恢复默认</button><button data-action="home-customize">完成</button></div></div>`;
}

function homeTaskRows(items,limit=3){
  return items.length?items.slice(0,limit).map(task=>`<button class="home-task-row" data-action="open-task" data-id="${safe(task.id)}"><i class="status-dot ${safe(task.dot)}"></i><span><strong>${safe(task.title)}</strong><small>${safe(task.meta)}</small></span>${icon('chevron')}</button>`).join(''):'<p class="home-widget-empty">暂时没有相关工作</p>';
}

function homeWidget(id){
  const module=homeModuleCatalog[id];
  const pending=tasks.filter(task=>task.needsMe);
  const spaceTasks=tasks.filter(task=>task.workspace===state.workspace);
  const head=`<div class="home-widget-head"><span class="home-widget-icon">${icon(module.icon)}</span><strong>${safe(module.title)}</strong></div>`;
  if(id==='needs')return `<section class="home-widget">${head}<div class="home-widget-number">${pending.length}<small>项需要你处理</small></div>${homeTaskRows(pending,2)}</section>`;
  if(id==='space')return `<section class="home-widget">${head}<div class="home-widget-number">${spaceTasks.length}<small>${safe(state.workspace)} · 本机可见</small></div>${homeTaskRows(spaceTasks,2)}<p class="home-widget-note">尚未接入组织任务同步</p></section>`;
  if(id==='external'){
    const checks=state.settings.checks||{};
    const connected=[['model','模型'],['agent','外部 Agent']].filter(([kind])=>checks[kind]?.ok).map(([,label])=>label);
    if(state.settings.wecomBotStatus==='已连接')connected.push('企业微信机器人');
    else if(checks.wecom?.ok)connected.push('企业微信应用凭据');
    return `<section class="home-widget">${head}<div class="home-widget-number">${connected.length}<small>项连接测试通过</small></div><div class="home-external-tags">${(connected.length?connected:['模型','Agent','企业微信']).map(label=>`<span>${safe(label)}</span>`).join('')}</div><button class="home-widget-link" data-action="open-settings">管理连接 ${icon('arrow')}</button></section>`;
  }
  if(id==='documents')return `<section class="home-widget">${head}<div class="home-widget-number">${documentCount(state.workspace)}<small>份${safe(state.workspace)}资料</small></div><p class="home-widget-note">按分类和标签整理，供当前空间使用。</p><button class="home-widget-link" data-action="home-documents">管理空间资料 ${icon('arrow')}</button></section>`;
  if(id==='recent')return `<section class="home-widget home-widget-wide">${head}<div class="home-widget-list">${homeTaskRows(tasks,4)}</div></section>`;
  return `<section class="home-widget home-widget-wide">${head}<div class="home-starter-grid">${practices.map(practice=>`<button data-action="practice" data-id="${practice.id}"><strong>${safe(practice.title)}</strong><small>${safe(practice.desc)}</small>${icon('arrow')}</button>`).join('')}</div></section>`;
}

function overviewHome(){
  return `<div class="home-overview"><div class="home-overview-hero"><div><small>${safe(state.workspace)} · 我的工作台</small><h1>今天的工作，从这里开始</h1><p>汇集你参与的工作与当前空间资料；外部系统接入后也会显示在这里。</p></div><button data-action="start-agent">${icon('spark')}发起新工作</button></div><div class="home-overview-grid">${state.homeModules.filter(id=>!state.homeHidden.includes(id)).map(homeWidget).join('')||'<div class="home-overview-empty">当前没有显示的模块。点击“自定义模块”重新添加。</div>'}</div></div>`;
}

function compactHome(){
  const pending=tasks.filter(task=>task.needsMe);
  const spaceTasks=tasks.filter(task=>task.workspace===state.workspace);
  return `<div class="home-compact-wrap"><div class="home-compact-head"><small>${safe(state.workspace)} · 简洁模式</small><h1>工作一览</h1><p>只显示你需要处理的事和当前空间中本机可见的工作。</p></div><div class="home-compact-numbers"><div><strong>${pending.length}</strong><span>待我处理</span></div><div><strong>${spaceTasks.length}</strong><span>当前空间工作</span></div></div><div class="home-compact-list"><div><strong>待我处理</strong><span>点击继续工作</span></div>${homeTaskRows(pending,4)}</div><button class="home-compact-start" data-action="start-agent">${icon('spark')}发起新工作 ${icon('arrow')}</button><p class="home-compact-note">以上仅统计本机可见工作；团队全量任务需要组织接入。</p></div>`;
}

function agentHome(){
  const pending=tasks.filter(task=>task.needsMe);
  return `<div class="home-center"><div class="agent-orb">${icon('spark')}</div><h1>和团队 Agent 一起完成工作</h1><p>说出目标。它会使用当前工作空间允许的资料来执行，并把成果留给团队。</p>${state.agentStatus?`<div class="runtime-status ${state.agentStatus.modelConnected?'connected':'local'}"><i></i><span>${safe(state.agentStatus.label)}</span><small>${safe(state.agentStatus.modelConnected?'模型已连接':'任务会保存在这台 Mac 上')}</small></div>`:''}${composer()}<div class="practice-head"><span>从最佳实践开始</span><span>点开即可修改</span></div><div class="practice-grid">${practices.map((p,i)=>`<button class="practice" data-action="practice" data-id="${p.id}"><span class="practice-icon p${i}">${icon(i===0?'app':i===1?'grid':'users')}</span><span><strong>${safe(p.title)}</strong><small>${safe(p.desc)}</small></span>${icon('arrow')}</button>`).join('')}</div></div>${pending.length?`<div class="home-status"><span><i class="status-dot amber"></i>${pending.length} 项工作需要你处理</span><button data-action="open-task" data-id="${safe(pending[0].id)}">查看</button></div>`:''}`;
}

function home(){return `<main class="stage home-stage home-mode-${state.homeMode}">${homeLayoutControls()}${state.homeMode==='overview'?overviewHome():state.homeMode==='compact'?compactHome():agentHome()}</main>`}

function progressCard(taskId){
  if(taskId==='feedback') return `<div class="agent-progress"><div class="progress-title">${icon('check')} 已完成修改</div><ol><li class="done">读取现有应用和数据结构</li><li class="done">增加统计页与筛选逻辑</li><li class="done">运行基础检查</li></ol></div>`;
  if(taskId==='insight') return `<div class="agent-progress"><div class="progress-title running">${icon('spark')} 正在分析 24 份资料</div><ol><li class="done">整理访谈与反馈</li><li class="current">归纳主要变化</li><li>生成可分享的结论</li></ol></div>`;
  if(taskId==='onboarding') return `<div class="agent-progress"><div class="progress-title waiting">${icon('clock')} 需要补充信息</div><p>这份清单主要给新同事本人使用，还是同时给直属负责人使用？</p></div>`;
  return `<div class="agent-progress"><div class="progress-title running">${icon('spark')} 已记录目标</div><ol><li class="done">确认目标与当前工作空间</li><li class="current">整理可用资料与执行计划</li><li>交付可检查的成果</li></ol></div>`;
}

function channelUpdate(){
  return `<div class="channel-update ${state.channelUpdateApplied?'applied':'reverted'}">
    <div class="channel-source"><span class="channel-logo feishu">飞</span><span><strong>客户反馈项目群</strong><small>王宁 · 8 分钟前</small></span><button data-action="toggle-source-message">${state.sourceExpanded?'收起来源':'查看原消息'} ${icon('external')}</button></div>
    ${state.sourceExpanded?'<div class="channel-source-detail">演示消息 · 来源：客户反馈项目群 · 发送者：王宁。当前尚未接入飞书，无法跳转到真实消息。</div>':''}
    <blockquote>统计口径没有问题，可以发布。移动端支付的问题今天也处理完了。</blockquote>
    <div class="channel-result"><span>${icon(state.channelUpdateApplied?'check':'history')}<b>${state.channelUpdateApplied?'Agent 已自动更新进展':'这次自动更新已撤销'}</b><small>${state.channelUpdateApplied?'“确认统计口径”已完成 · 原文已作为依据':'任务恢复到更新前状态，消息原文仍保留'}</small></span><button data-action="toggle-channel-update">${state.channelUpdateApplied?'撤销':'重新应用'}</button></div>
  </div>`;
}

function wecomMessageAction(message,taskId){
  if(!desktopApi||!message?.id||message.role!=='user'||message.wecomOrigin)return '';
  const delivery=message.wecomDelivery;
  if(delivery?.status==='sent')return `<div class="wecom-delivery sent">${icon('check')}企业微信接口已接受 · ${safe(delivery.recipientUserId)}；请在企微确认收到</div>`;
  if(delivery?.status==='sending')return `<div class="wecom-delivery">${icon('history')}正在发送到企业微信 · ${safe(delivery.recipientUserId)}</div>`;
  if(delivery?.status==='unknown')return `<div class="wecom-delivery unknown">${icon('history')}发送结果未知 · ${safe(delivery.recipientUserId)}；请先在企微核对</div>`;
  return `<div class="wecom-delivery">${delivery?.status==='failed'?`<span class="wecom-error">${safe(delivery.detail||'发送失败')}</span>`:''}<button data-action="open-wecom-send" data-id="${safe(message.id)}" data-task="${safe(taskId)}">${icon('comment')}${delivery?.status==='failed'?'重试发送到企微':message.wecomOutbound?'发送到企微':'转发到企微'}</button></div>`;
}

function messageAuthor(message){
  if(message?.wecomOutbound)return '你 · 企微消息';
  if(!message?.wecomOrigin)return '你';
  const id=message.wecomOrigin.userId;
  return `企微 · ${state.wecomDirectory.members.find(item=>item.userId===id)?.name||id}`;
}

function conversation(){
  const t=tasks.find(x=>x.id===state.task);
  const userText = t.goal||(t.id==='feedback'?'给客户反馈管理应用增加统计页，按来源和状态展示本周趋势。':t.id==='insight'?'整理本季度客户洞察，重点说明用户反馈发生了什么变化。':t.id==='custom'?t.title:'完善新同事入职清单，让接手人一眼看出当前进度。');
  const agentText = t.id==='feedback'?(state.published?'新版本已经发布。团队成员继续使用原来的入口，数据保持不变。':'我已经完成修改。右侧可以直接操作新版本；代码、数据结构和权限变化也可以分别查看。'):t.id==='insight'?'我正在把访谈和反馈合并分析。你可以离开这里，完成后会通知你。':t.id==='onboarding'?'我先确认使用对象，再继续补全清单。':'目标已经记录。本地模式会保存任务；连接模型后才会实际分析和执行。';
  const liveMessages=desktopApi?(t.messages||[]).filter((m,index)=>m.role==='assistant'||m.role==='user'&&index!==0):state.messages.map(m=>({...m,role:'user'}));
  const showPlaceholder=['feedback','insight','onboarding'].includes(t.id)||!desktopApi&&!liveMessages.some(m=>m.role==='assistant');
  const run=t.agentRun?.status;
  const mode=t.agentMode||state.settings?.agent?.mode||'built-in';
  const ready=agentReady(mode);
  const setupMessage=ready?'刚才的消息已保存，但还没有交给当前 Agent。点击“回复上一条”即可继续。':mode==='built-in'?'当前工作使用内置 Agent，但模型尚未配置。消息只会保存，不会自动得到 AI 回复。':`${agentLabel(mode)} 尚未完成连接配置。消息只会保存，不会自动得到 AI 回复。`;
  const runMessage={'awaiting-workbuddy':t.agentRun?.claimedAt?'WorkBuddy 已领取，正在处理；完成后回复会出现在这里。':'已交给 WorkBuddy，等待它通过本机连接器领取。可以在 WorkBuddy 里说「处理共作待办」。',queued:'已保存工作，等待 Agent 执行。',running:t.agentRun?.progress?`Agent 正在处理：${t.agentRun.progress}`:'Agent 正在处理，你可以先查看其他工作。',failed:t.agentRun?.message||'本次调用失败，可以重试。',interrupted:'上次执行被中断，可以重试。','not-configured':setupMessage}[run];
  return `<section class="conversation-pane">
    <div class="conversation-top"><div><strong>${safe(t.title)}</strong><span>${safe(t.workspace||state.workspace)} · 工作对话</span></div><div class="conversation-actions-top"><button class="memory-task-button" data-action="extract-memory">${icon('book')}提炼记忆</button><button class="icon-button" data-action="toggle-people" aria-label="参与者" title="查看参与者">${icon('users')}</button>${t.id==='feedback'?`<button class="artifact-toggle ${state.artifactOpen?'active':''}" data-action="toggle-artifact">${icon('panel')}成果</button>`:''}<div class="task-menu-anchor"><button class="icon-button" data-action="toggle-task-menu" aria-label="更多任务操作" title="更多任务操作">${icon('dots')}</button>${state.quickPanel==='task-menu'?`<div class="task-menu-popover"><button data-action="extract-memory">${icon('book')}提炼记忆</button><button data-action="go-task-workspace">${icon('folder')}查看${safe(t.workspace||state.workspace)}资料</button><button data-action="show-task-info">${icon('file')}任务信息</button></div>`:''}</div></div></div>
    <div class="thread"><div class="message user"><span class="message-avatar">明</span><div><small>${safe(messageAuthor(t.messages?.[0]))} · 10 分钟前</small><p>${safe(userText)}</p>${t.messages?.[0]?.documentRefs?.length?`<div class="message-documents">引用资料：${safe(t.messages[0].documentRefs.map(ref=>ref.name).join("、"))}</div>`:''}${wecomMessageAction(t.messages?.[0],t.id)}</div></div>
      ${t.id==='feedback'?channelUpdate():''}
      ${showPlaceholder?`<div class="message agent"><span class="agent-avatar">${icon('spark')}</span><div><small>团队 Agent</small><p>${safe(agentText)}</p>${progressCard(t.id)}
      ${t.id==='feedback'?`<button class="result-card" data-action="toggle-artifact"><span class="result-thumb">${icon('app')}</span><span><strong>客户反馈管理 · v2</strong><small>${state.published?'已发布给产品团队':'已准备好，等待你的确认'}</small></span>${icon('chevron')}</button>${state.published?`<button class="open-live" data-action="open-app">打开应用 ${icon('external')}</button>`:`<div class="approval-row"><button class="soft-button" data-action="revise">继续修改</button><button class="dark-button" data-action="publish">${icon('check')}确认发布</button></div>`}`:''}
      </div></div>`:''}${liveMessages.map(m=>m.role==='assistant'?`<div class="message agent"><span class="agent-avatar">${icon('spark')}</span><div><small>${m.source==='codebuddy'?'CodeBuddy':m.source==='codex'?'Codex':m.source==='kimi'?'Kimi Code':['workbuddy','workbuddy-pending'].includes(m.source)?(m.via==='cloud-task'?'WorkBuddy 云端':'WorkBuddy'):m.source==='external-agent'?'外部 Agent':'团队 Agent'} · ${m.source==='connection-error'?'调用失败':m.source==='workbuddy-pending'?'已发送，等待回复':'实际响应'}</small><p>${safe(m.text)}</p>${m.artifacts?.length?`<div class="message-documents">成果已存入空间资料：${safe(m.artifacts.map(item=>item.name).join('、'))}</div>`:''}${m.source==='workbuddy-pending'?`<button class="soft-button" data-action="sync-workbuddy" data-id="${safe(m.id)}">获取最新回复</button>`:''}</div></div>`:`<div class="message user"><span class="message-avatar">明</span><div><small>${safe(messageAuthor(m))} · 刚刚</small><p>${safe(m.text)}</p>${m.documentRefs?.length?`<div class="message-documents">引用资料：${safe(m.documentRefs.map(ref=>ref.name).join("、"))}</div>`:''}${m.mentions?.length?`<div class="mention-delivery">${icon('bell')} @${safe(m.mentions.map(item=>item.name).join('、'))} · ${m.mentionDelivery==='demo'?'演示提醒，未真实送达':m.mentionDelivery==='sent'?'企微接口已接受，请在企微确认':m.mentionDeliveries?.length?m.mentionDeliveries.map(item=>item.status==='sent'?item.name+' 已发送':item.name+' '+(item.detail||'未送达')).join('；'):'等待发送'}</div>`:''}${wecomMessageAction(m,t.id)}</div></div>`).join('')}${desktopApi&&runMessage&&run!=='not-configured'?`<div class="agent-run-status"><span>${icon(['running','queued','awaiting-workbuddy'].includes(run)?'spark':'history')}${safe(runMessage)}</span>${['failed','interrupted'].includes(run)?`<button data-action="retry-agent">重试</button>`:''}</div>`:''}</div>
    <div class="thread-composer">${desktopApi&&run==='not-configured'?`<div class="agent-setup-banner"><span>${icon('spark')}${safe(setupMessage)}</span><div>${ready?`<button data-action="retry-agent">回复上一条</button>`:mode==='built-in'?`<button data-action="open-model-settings">配置模型</button>`:''}<button data-action="toggle-capabilities" data-id="agent">选择 Agent</button></div></div>`:''}${composer('thread-input',true)}<span class="composer-note">Enter 交给 Agent · 发企微请点右侧“发企微”</span></div>
  </section>`;
}

function mockApplication(standalone=false){
  const tab=standalone&&!state.published&&state.miniTab==='stats'?'feedback':state.miniTab;
  return `<div class="mini-browser ${standalone?'standalone':''}">${standalone?'':`<div class="mini-browser-bar"><div><i></i><i></i><i></i></div><span>客户反馈管理 · 演示</span><button data-action="open-app" aria-label="在团队小应用中打开">${icon('external')}</button></div>`}<div class="mini-app-shell"><nav><strong>反馈管理</strong><button class="${tab==='feedback'?'active':''}" data-action="mini-tab" data-id="feedback">${icon('file')}全部反馈</button>${!standalone||state.published?`<button class="${tab==='stats'?'active':''}" data-action="mini-tab" data-id="stats">${icon('grid')}统计分析</button>`:''}<button class="${tab==='team'?'active':''}" data-action="mini-tab" data-id="team">${icon('users')}团队设置</button></nav><section>
    ${tab==='feedback'?`<div class="mini-app-head"><div><h3>客户反馈</h3><p>跟进重要问题，让每条反馈都有下文</p></div><button data-action="mini-add">＋ 录入反馈</button></div>${state.miniFormOpen?`<form class="mini-feedback-form" id="mini-feedback-form"><input name="content" maxlength="120" placeholder="反馈内容" required><select name="source"><option>客服反馈</option><option>用户访谈</option><option>其他</option></select><button type="submit">添加</button><button type="button" data-action="mini-add">取消</button></form>`:''}<div class="stats"><article><span>反馈总数</span><b>${128+state.demoFeedback.length}</b><em>演示数据</em></article><article><span>处理中</span><b>23</b><em>5 项超 3 天</em></article><article><span>本周已解决</span><b>16</b><em>↑ 4</em></article></div><div class="feedback-table"><div class="feedback-row head"><span>反馈内容</span><span>来源</span><span>状态</span></div>${state.demoFeedback.map(item=>`<div class="feedback-row"><span>${safe(item.content)}</span><span>${safe(item.source)}</span><span>待处理</span></div>`).join('')}<div class="feedback-row"><span>移动端支付失败</span><span>客服反馈</span><button data-action="cycle-status">${state.feedbackStatus}</button></div><div class="feedback-row"><span>筛选条件无法保存</span><span>用户访谈</span><span>待处理</span></div><div class="feedback-row"><span>希望支持批量导出</span><span>客服反馈</span><span>已解决</span></div></div>`:tab==='stats'?`<div class="mini-app-head"><div><h3>统计分析</h3><p>按来源与状态查看反馈</p></div></div><div class="stats"><article><span>反馈总数</span><b>${128+state.demoFeedback.length}</b><em>演示数据</em></article><article><span>客服反馈</span><b>78</b><em>61%</em></article><article><span>用户访谈</span><b>50</b><em>39%</em></article></div><div class="mini-bars"><span>处理中<i style="width:42%"></i>23</span><span>已解决<i style="width:72%"></i>81</span><span>待处理<i style="width:30%"></i>24</span></div>`:`<div class="mini-app-head"><div><h3>团队设置</h3><p>这个预览尚未接入组织账号</p></div></div><div class="mini-team-note">正式应用将在这里显示成员和权限。当前仅展示界面演示，不能修改团队访问范围。</div>`}
  </section></div></div>`;
}

function artifact(){
  if(!state.artifactOpen) return '';
  let body='';
  if(state.artifactTab==='preview') body=mockApplication();
  if(state.artifactTab==='changes') body=`<div class="artifact-info"><h3>本次改动</h3><div><span>新增页面</span><b>统计分析</b></div><div><span>修改</span><b>反馈列表筛选</b></div><div><span>数据结构</span><b>没有变化</b></div><div><span>使用权限</span><b>沿用产品团队</b></div><p>生成的源码可以导出，所有改动与当前任务关联。</p></div>`;
  if(state.artifactTab==='checks') body=`<div class="artifact-info checks"><h3>发布前检查</h3><div><span>${icon('check')}应用构建</span><b>通过</b></div><div><span>${icon('check')}基础交互</span><b>通过</b></div><div><span>${icon('check')}数据迁移</span><b>不需要</b></div><div><span>${icon('shield')}外部工具</span><b>未使用</b></div></div>`;
  return `<aside class="artifact-panel"><div class="artifact-title"><div><strong>${state.published?'已发布的应用':'正在制作的应用'}</strong><span>客户反馈管理 · v2</span></div><button class="icon-button" data-action="toggle-artifact" aria-label="关闭成果">${icon('close')}</button></div><div class="artifact-tabs"><button class="${state.artifactTab==='preview'?'active':''}" data-action="artifact-tab" data-id="preview">预览</button><button class="${state.artifactTab==='changes'?'active':''}" data-action="artifact-tab" data-id="changes">改动</button><button class="${state.artifactTab==='checks'?'active':''}" data-action="artifact-tab" data-id="checks">检查</button></div><div class="artifact-body">${body}</div><div class="artifact-footer">${icon('shield')} ${state.published?'当前版本已发布，业务数据保持不变':'发布前由人确认数据与权限变化'}</div></aside>`;
}

function taskStage(){return `<main class="stage task-stage">${conversation()}${artifact()}</main>`}

function appsStage(){return `<main class="stage apps-stage"><header class="apps-stage-head"><div><span class="app-icon purple">${icon('app')}</span><span><strong>客户反馈管理</strong><small>产品团队 · ${state.published?'v2':'v1'} · 演示应用</small></span></div><button class="soft-button" data-action="revise">${icon('spark')}让 Agent 改进</button></header>${mockApplication(true)}</main>`}

function activeWorkspaceId(name){
  return state.workspaces.find(space=>space.name===name)?.id||({产品团队:'product',运营团队:'operations',公共空间:'public'}[name]);
}

function memoryOverlay(){
  const scope=state.memoryScope;
  const workspace=state.memoryWorkspace||state.workspace;
  const items=(state.memories[scope]||[]).filter(item=>item.status==='active'&&(scope==='personal'||item.workspaceId===activeWorkspaceId(workspace)));
  const draft=state.memoryDraft;
  return `<div class="memory-overlay" role="dialog" aria-modal="true" aria-label="长期记忆">
    <section class="memory-panel">
      <header class="memory-head"><div><small>可管理的长期上下文</small><h2>长期记忆</h2></div><button class="icon-button" data-action="close-memory" aria-label="关闭记忆">${icon('close')}</button></header>
      <div class="memory-tabs"><button class="${scope==='personal'?'active':''}" data-action="memory-scope" data-id="personal">个人记忆</button><button class="${scope==='team'?'active':''}" data-action="memory-scope" data-id="team">团队记忆</button></div>
      <p class="memory-description">${scope==='personal'?'只供你自己的 Agent 工作使用，不会随团队任务共享。':`归属${safe(workspace)}。确认后可用于这个空间中的新工作。`}</p>
      ${desktopApi?'<p class="memory-local-note">当前是本机演示，团队记忆尚未同步给其他成员。</p>':''}
      ${draft?`<form class="memory-form" id="memory-form">
        <div class="memory-form-title"><strong>${draft.id?'编辑记忆':draft.sourceTaskId?'从任务提炼':'新建记忆'}</strong><button type="button" data-action="cancel-memory-draft">取消</button></div>
        <label>标题<input name="title" data-memory-field="title" maxlength="120" value="${safe(draft.title||'')}" placeholder="一句话概括" required></label>
        <label>内容<textarea name="content" data-memory-field="content" maxlength="2000" rows="5" placeholder="这条信息以后什么时候有用？" required>${safe(draft.content||'')}</textarea></label>
        <div class="memory-form-grid"><label>分类<select name="category" data-memory-field="category">${['偏好','约定','流程','项目背景','其他'].map(category=>`<option ${draft.category===category?'selected':''}>${category}</option>`).join('')}</select></label><label>标签<input name="tags" data-memory-field="tags" value="${safe(draft.tags||'')}" placeholder="用逗号分隔"></label></div>
        ${draft.sourceTaskId?`<p class="memory-source">来源：${safe(tasks.find(task=>task.id===draft.sourceTaskId)?.title||'当前任务')} · 原文保留在任务中</p>`:''}
        <div class="memory-form-actions"><span>${draft.id?'修改会保留上一版内容':'保存后才会成为 Agent 可用的长期记忆'}</span><button class="dark-button" type="submit">${draft.id?'保存修改':`确认保存到${scope==='personal'?'个人':'团队'}记忆`}</button></div>
      </form>`:''}
      <div class="memory-list-head"><strong>${scope==='personal'?'我的记忆':safe(workspace)+'的记忆'} <span>${items.length}</span></strong><button data-action="new-memory">${icon('plus')}新建</button></div>
      <div class="memory-list">${items.length?items.map(item=>`<article class="memory-card"><div><span class="memory-category">${safe(item.category)}</span><strong>${safe(item.title)}</strong><button data-action="edit-memory" data-id="${safe(item.id)}" data-scope="${scope}" aria-label="编辑记忆：${safe(item.title)}">编辑</button><button data-action="archive-memory" data-id="${safe(item.id)}" data-scope="${scope}" aria-label="移出记忆：${safe(item.title)}">移出</button></div><p>${safe(item.content)}</p>${item.tags?.length?`<div class="memory-tags">${item.tags.map(tag=>`<span>#${safe(tag)}</span>`).join('')}</div>`:''}<small>${item.source?.type==='task'?'来自任务 · 已由你确认':'手动添加 · 已由你确认'}${item.revisions?.length?` · 已修订 ${item.revisions.length} 次`:''}</small></article>`).join(''):`<div class="memory-empty">${icon('book')}<strong>还没有${scope==='personal'?'个人':'团队'}记忆</strong><span>在任务里点“提炼记忆”，或手动添加一条。</span></div>`}</div>
    </section>
  </div>`;
}

function settingsOverlay(){
  const config=state.settings;
  const model=config.model||{};
  const officialModelProvider=modelProviderNames[model.provider];
  const agent=config.agent||{};
  const wecom=config.wecom||{};
  const workflow=config.workflow||{enabled:false,senderUserId:'',workspaceId:'',prefix:'日报：',agentMode:'workbuddy',instruction:'从这份摘要中提取已确认的进展、待办和风险。逐条标明依据；不确定的内容写为待核实。只提出更新建议，不修改现有工作。'};
  const checks=config.checks||{};
  const checkRow=(kind,label='测试连接')=>`<div class="settings-test-row"><button type="button" data-action="test-connection" data-id="${kind}" ${desktopApi?'':'disabled'}>${label}</button><span>${safe(checks[kind]?.message||'保存配置后可在 Mac 版测试')}</span></div>`;
  const section=['model','agent','connectors'].includes(state.settingsSection)?state.settingsSection:'model';
  return `<div class="settings-overlay" role="dialog" aria-modal="true" aria-label="设置">
    <section class="settings-panel">
      <header class="settings-head"><div><small>个人工作台设置</small><h2>设置</h2><p>分别管理模型、执行 Agent 和企业连接器。</p></div><button class="icon-button" data-action="close-settings" aria-label="关闭设置">${icon('close')}</button></header>
      <nav class="settings-jump" aria-label="设置类别"><button data-action="settings-section" data-id="model" ${section==='model'?'aria-current="page"':''}>模型</button><button data-action="settings-section" data-id="agent" ${section==='agent'?'aria-current="page"':''}>Agent</button><button data-action="settings-section" data-id="connectors" ${section==='connectors'?'aria-current="page"':''}>连接器</button></nav>
      <form id="settings-form" class="settings-form" autocomplete="off">
        <div class="settings-card" id="settings-model" data-settings-section="model" ${section==='model'?'':'hidden'}><div class="settings-card-title"><span class="settings-card-icon">${icon('spark')}</span><div><h3>API 模型服务</h3><p>供内置 Agent 使用。需要提供方的模型 ID 和 API Key；密钥只在这台 Mac 上安全保存。</p></div><span class="settings-status">${checks.model?.ok?'测试通过':model.modelId?'待测试':'待配置'}</span></div>
          <div class="model-agent-shortcut"><div><strong>已经登录 Codex？</strong><span>可用本机 Codex CLI 处理工作。在 Agent 页选择 Codex 并保存，无需在此配置 OpenAI API Key。</span></div><button type="button" data-action="settings-section" data-id="agent">查看 Codex 接入 ${icon('chevron')}</button></div>
          <div class="settings-grid"><label>提供方<select name="provider" data-current-provider="${safe(model.provider)}"><option value="openai" ${model.provider==='openai'?'selected':''}>OpenAI API</option><option value="kimi" ${model.provider==='kimi'?'selected':''}>Kimi API</option><option value="deepseek" ${model.provider==='deepseek'?'selected':''}>DeepSeek API</option><option value="compatible" ${model.provider==='compatible'?'selected':''}>兼容 OpenAI API 的服务</option><option value="local" ${model.provider==='local'?'selected':''}>本机模型服务</option></select></label><label>模型 ID<input name="modelId" maxlength="120" value="${safe(model.modelId||'')}" placeholder="填写提供方给出的模型 ID"></label></div>
          <label>接口地址<input name="baseUrl" type="url" maxlength="500" required value="${safe(model.baseUrl||'')}" placeholder="https://api.openai.com/v1"><small>远程地址使用 HTTPS；本机服务可使用 localhost 的 HTTP。</small></label>
          <label>API Key<input name="modelKey" type="password" maxlength="8192" ${desktopApi?'':'disabled'} placeholder="${config.hasModelKey?'已安全保存；留空则保持原值':desktopApi?'仅在这台 Mac 上保存':'请在 macOS 应用中配置'}"><small data-model-key-status>${config.hasModelKey?'当前提供方的密钥已保存，界面不会显示原文。':'当前提供方尚未配置密钥。'}${desktopApi&&config.secretStorageAvailable?' 保存时由 macOS 安全存储加密。':''}</small></label>
          <label class="settings-check" data-clear-model-key ${config.hasModelKey?'':'hidden'}><input type="checkbox" name="clearModelKey">移除当前提供方已保存的模型密钥</label>
          <div class="provider-login" ${officialModelProvider?'':'hidden'}><button type="button" data-action="open-model-portal">${icon('external')}管理 ${safe(officialModelProvider||'')} API Key</button><span data-provider-portal-hint>登录 ${safe(officialModelProvider||'')} 开放平台后取得 API Key，保存并测试连接。网页或客户端登录不会自动授权共作调用 API。</span></div>
          ${checkRow('model')}
        </div>
        <div class="settings-card" id="settings-agent" data-settings-section="agent" ${section==='agent'?'':'hidden'}><div class="settings-card-title"><span class="settings-card-icon muted">${icon('settings')}</span><div><h3>执行 Agent</h3><p>选择当前工作默认使用的 Agent。</p></div><span class="settings-status">${checks.agent?.ok?'测试通过':agent.mode==='codebuddy'?'CodeBuddy 待测试':agent.mode==='codex'?'Codex 待测试':agent.mode==='kimi'?'Kimi Code 待测试':agent.mode==='workbuddy'?(config.hasWorkbuddyAccessToken?'WorkBuddy 开放平台':'WorkBuddy 本机连接'):agent.mode==='external'&&agent.endpoint?'待测试':'内置模式'}</span></div>
          <div class="settings-choice"><label><input type="radio" name="agentMode" value="built-in" ${agent.mode==='built-in'?'checked':''}><span><strong>内置 Agent</strong><small>使用“模型”页配置的服务。</small></span></label><label><input type="radio" name="agentMode" value="codex" ${agent.mode==='codex'?'checked':''}><span><strong>Codex</strong><small>调用本机已登录的 CLI，当前只委派文本。</small></span></label><label><input type="radio" name="agentMode" value="kimi" ${agent.mode==='kimi'?'checked':''}><span><strong>Kimi Code</strong><small>调用本机已登录的 CLI，当前只委派文本。</small></span></label><label><input type="radio" name="agentMode" value="codebuddy" ${agent.mode==='codebuddy'?'checked':''}><span><strong>CodeBuddy</strong><small>调用本机已登录的 CLI，当前只委派文本。</small></span></label><label><input type="radio" name="agentMode" value="workbuddy" ${agent.mode==='workbuddy'?'checked':''}><span><strong>WorkBuddy</strong><small>由 WorkBuddy 通过本机连接器领取并回复。</small></span></label><label><input type="radio" name="agentMode" value="external" ${agent.mode==='external'?'checked':''}><span><strong>自定义 Agent</strong><small>使用符合共作桥接协议的 HTTP 服务。</small></span></label></div>
          <div class="settings-local-agent" ${['codex','kimi'].includes(agent.mode)?'':'hidden'}><p>每项工作在独立目录续接文本会话，使用本机已登录账号。项目路径不会传入；只有你明确引用的空间资料正文会随消息发送。</p>${checkRow('agent')}</div>
          <div class="settings-codebuddy" ${agent.mode==='codebuddy'?'':'hidden'}><p>发起工作时会把当前对话和适用记忆发送给 CodeBuddy；禁用工具与 MCP，不允许修改文件。需要先安装并登录 CodeBuddy Code CLI。</p>${checkRow('agent')}</div>
          <div class="settings-workbuddy" ${agent.mode==='workbuddy'?'':'hidden'}>${(()=>{const t=agent.workbuddyTransport||(config.hasWorkbuddyAccessToken?'localassistant':'handoff');const opt=(v,title,desc)=>`<label><input type="radio" name="workbuddyTransport" value="${v}" ${t===v?'checked':''}><span><strong>${title}</strong><small>${desc}</small></span></label>`;return `<div class="settings-choice">${opt('cloud','云端任务（实时）','在 WorkBuddy 云端执行，过程实时显示，生成的文件存入空间资料；需要开放平台令牌。')}${opt('handoff','本机连接','由本机 WorkBuddy 领取处理，可用本机连接器；不需要令牌，但不实时。')}${opt('localassistant','本地助理接口','向本机 WorkBuddy 发送消息并查询回复；需要开放平台令牌。')}</div>`})()}<p><strong>本机连接（默认）</strong>：工作会排队，WorkBuddy 通过「gongzuo」连接器领取，看到的是共作为这项工作准备的对话、适用记忆和你引用的资料；回复写回同一项工作。共作需保持运行；在 WorkBuddy 里说「处理共作待办」即可触发。${state.settings?.workbuddyBridge?.lastClientAt?`WorkBuddy 最近一次访问：${safe(String(state.settings.workbuddyBridge.lastClientAt).slice(0,19).replace('T',' '))} UTC。`:state.settings?.workbuddyBridge?.listening?'本机连接已就绪，WorkBuddy 尚未访问。':''}</p><p><strong>云端任务 / 本地助理</strong>：填入开放平台 OAuth access_token（有效期 24 小时）。云端任务在 WorkBuddy 云端沙箱执行，看不到这台 Mac 的文件；需授权的工具调用会被共作拒绝并在回复中说明。正式版应由受控服务端完成授权与刷新，不要在这里填写 client_secret。</p><div class="provider-login"><button type="button" data-action="open-workbuddy-portal">${icon('external')}打开 WorkBuddy 开放平台</button><span>在官网完成所需审核与授权；网页登录不会自动连接共作。</span></div><label>OAuth 访问令牌<input name="workbuddyAccessToken" type="password" maxlength="8192" ${desktopApi?'':'disabled'} placeholder="${config.hasWorkbuddyAccessToken?'已安全保存；留空则保持原值':desktopApi?'粘贴经授权取得的短期令牌':'请在 macOS 应用中配置'}"><small>只发送当前消息；如果主动引用了空间资料，其正文会随当前消息发送。不自动附带记忆。</small></label>${config.hasWorkbuddyAccessToken?'<label class="settings-check"><input type="checkbox" name="clearWorkbuddyAccessToken">移除 WorkBuddy 访问令牌</label>':''}${checkRow('agent')}<p class="settings-connection-note">连接测试只检查本地助理是否在线，不会发送消息；发送权限在首次实际派发时验证。令牌过期需重新授权。</p></div>
          <div class="settings-external" ${agent.mode==='external'?'':'hidden'}><label>Agent 服务地址<input name="agentEndpoint" type="url" maxlength="500" value="${safe(agent.endpoint||'')}" placeholder="https://agent.example.com"></label><label>访问令牌<input name="agentToken" type="password" maxlength="8192" ${desktopApi?'':'disabled'} placeholder="${config.hasAgentToken?'已安全保存；留空则保持原值':desktopApi?'可选':'请在 macOS 应用中配置'}"><small>${config.hasAgentToken?'已保存，界面不会显示原文。':'如服务需要鉴权，可在此配置。'}</small></label>${config.hasAgentToken?'<label class="settings-check"><input type="checkbox" name="clearAgentToken">移除已保存的 Agent 令牌</label>':''}${checkRow('agent')}</div>
        </div>
        <div class="settings-card" id="settings-wecom" data-settings-section="connectors" ${section==='connectors'?'':'hidden'}><div class="settings-card-title"><span class="settings-card-icon wecom">${icon('comment')}</span><div><h3>企业微信智能机器人</h3><p>推荐的首版接入：用 WebSocket 长连接收消息，也可向指定会话发送工作消息。</p></div><span class="settings-status">${safe(config.wecomBotStatus||'未配置')}</span></div>
          <div class="settings-steps"><span><b>1</b>企微创建 API 模式机器人</span><span><b>2</b>填 BotID、Secret 并保存</span><span><b>3</b>检查连接与收发</span></div>
          <p class="settings-connection-note">在企微“工作台 → 智能机器人 → 创建 → API 模式”选择“使用长连接”，设置可见成员，复制 BotID 和 Secret。共作需保持运行才能接收消息；不需要公网回调地址。</p>
          <div class="settings-grid"><label>机器人 BotID<input name="wecomBotId" maxlength="120" value="${safe(wecom.botId||'')}" placeholder="企业微信智能机器人后台获取"></label><label>机器人 Secret<input name="wecomBotSecret" type="password" maxlength="8192" ${desktopApi?'':'disabled'} placeholder="${config.hasWecomBotSecret?'已安全保存；留空保留':'仅在 Mac 版中保存'}"></label></div>
          <div class="settings-bot-actions"><button type="button" class="dark-button" data-action="save-wecom-bot" ${desktopApi?'':'disabled'}>保存并连接机器人</button><span>保存后会启动长连接，状态显示在下方。</span></div>
          ${config.hasWecomBotSecret?'<label class="settings-check"><input type="checkbox" name="clearWecomBotSecret">移除机器人密钥</label>':''}
          <div class="settings-test-row"><button type="button" data-action="check-wecom-bot" ${desktopApi?'':'disabled'}>检查长连接</button><span>当前状态：${safe(config.wecomBotStatus||'未配置')}</span></div>
          <div class="settings-inbound"><strong>接收诊断</strong><span>本次连接收到文本回调：${config.wecomBotLastTextFrameAt?`${safe(new Date(config.wecomBotLastTextFrameAt).toLocaleString('zh-CN'))} · ${safe(config.wecomBotLastTextFrameStatus||'已收到')}`:'尚未收到'}</span><strong>最近收到的发送者</strong><span>${(config.wecomRecentInbound||[]).length?(config.wecomRecentInbound||[]).map(item=>`${safe(item.userId)} · ${safe(item.chatType==='group'?'群聊':'私聊')} · ${safe(item.at||'')}`).join('<br>'):'尚无接收记录。'}</span><span>单聊机器人收到的消息正文可在窗口右上角“消息收件”查看；旧版已接收的消息无法补回正文。</span></div>
          <p class="settings-connection-note">首次推送前，让收件人在企微单聊这个机器人，发一条消息建立会话；“已连接”只表示长连接已建立。可发送“新建 产品团队：测试连接”验证接收，再从共作发送工作消息。主动推送仍受企微会话、可见范围和频率限制，以实际回执为准。机器人无法读取个人全部聊天记录。</p>
        </div>
        <details class="settings-card settings-advanced" data-settings-section="connectors" ${section==='connectors'?'':'hidden'} ${wecom.organizationId||wecom.applicationId||config.hasWecomSecret?'open':''}><summary>高级接入：自建应用与成员目录 <span>${checks.wecom?.ok?'应用凭据已验证':wecom.organizationId&&wecom.applicationId?'待测试':'可选'}</span></summary><div class="settings-advanced-body"><p>只有需要同步企业成员目录，或需要用自建应用发送通知时再配置。机器人收发消息无需填写下面的企业 ID、AgentID 和应用 Secret。</p>
          <div class="settings-card-title"><span class="settings-card-icon wecom">${icon('comment')}</span><div><h3>企业微信自建应用</h3><p>按应用可见范围发送通知、同步成员目录。</p></div></div>
          <div class="settings-steps"><span><b>1</b>管理员创建自建应用</span><span><b>2</b>填 ID 与 Secret 并保存</span><span><b>3</b>测试凭据，再验证送达</span></div>
          <p class="settings-connection-note">在企业微信管理后台创建自建应用，设置可见成员，取得 CorpID、AgentID 和应用 Secret。保存后先点下方“测试应用凭据”，再向自己的企微 UserID 发送一条测试工作消息确认收到。此连接不能读取聊天记录。</p>
          <div class="settings-grid"><label>企业 ID（CorpID）<input name="wecomOrganizationId" maxlength="120" value="${safe(wecom.organizationId||'')}" placeholder="由企业管理员提供"></label><label>自建应用 AgentID<input name="wecomApplicationId" maxlength="120" value="${safe(wecom.applicationId||'')}" placeholder="由企业管理员提供的数字 ID"></label></div>
          <label>自建应用 Secret<input name="wecomSecret" type="password" maxlength="8192" ${desktopApi?'':'disabled'} placeholder="${config.hasWecomSecret?'已安全保存；留空则保持原值':desktopApi?'仅在这台 Mac 上保存':'请在 macOS 应用中配置'}"><small>在企业微信管理后台的自建应用详情中获取；密钥由 macOS 安全存储加密，界面不会显示原文。</small></label>
          <label>默认收件成员 UserID<input name="wecomRecipientUserId" maxlength="64" value="${safe(wecom.recipientUserId||'')}" placeholder="企微通讯录中的成员 UserID"><small>仅用作发送窗口的默认值；每次发送前仍可修改。不支持 @all 群发。</small></label>
          ${config.hasWecomSecret?'<label class="settings-check"><input type="checkbox" name="clearWecomSecret">移除已保存的企业微信密钥</label>':''}
          <label>计划使用范围<select name="wecomMessageScope"><option value="mentions" ${wecom.messageScope!=='authorized'?'selected':''}>仅提醒与项目成员目录</option><option value="authorized" ${wecom.messageScope==='authorized'?'selected':''}>获授权的消息与项目进展</option></select><small>该选择是后续接入意向；当前只在你明确操作时发送单条工作文字。</small></label>
          ${checkRow('wecom','测试应用凭据')}
          <div class="settings-test-row"><button type="button" data-action="sync-wecom-members" ${desktopApi?'':'disabled'}>同步可见成员</button><span>已同步 ${state.wecomDirectory.members.length} 位 · ${safe(state.wecomDirectory.syncedAt||'尚未同步')}</span></div>
          <p class="settings-connection-note">测试应用凭据不会发送消息。要验证送达，请在工作对话里选一条你发出的消息，点击“发送到企微”；应用需对收件成员可见。目录同步只读取已获授权的可见成员。</p>
        </div></details>
        <div class="settings-card" id="settings-workflow" data-settings-section="connectors" ${section==='connectors'?'':'hidden'}><div class="settings-card-title"><span class="settings-card-icon muted">${icon('spark')}</span><div><h3>企微摘要处理规则</h3><p>指定来源与空间，收到匹配消息后交给 Agent，生成待确认的工作。</p></div><span class="settings-status">${workflow.enabled?'已启用':'已关闭'}</span></div>
          <label class="settings-check"><input type="checkbox" name="workflowEnabled" ${workflow.enabled?'checked':''}>启用这条规则</label>
          <div class="settings-grid"><label>来源成员 UserID<input name="workflowSenderUserId" maxlength="64" value="${safe(workflow.senderUserId)}" placeholder="企微实际回调中的 UserID"><small>只接受这个发送者；大圆是否能向机器人发消息仍需真实验证。</small></label><label>保存到空间<select name="workflowWorkspaceId"><option value="">选择空间</option>${state.workspaces.map(space=>`<option value="${safe(space.id)}" ${workflow.workspaceId===space.id?'selected':''}>${safe(space.name)}</option>`).join('')}</select><small>生成一项待确认工作，不直接更改已有任务。</small></label></div>
          <div class="settings-grid"><label>触发前缀<input name="workflowPrefix" maxlength="30" value="${safe(workflow.prefix)}" placeholder="日报："><small>仅处理以该文字开头的消息，例如“日报：今天完成了…”</small></label><label>处理 Agent<select name="workflowAgentMode"><option value="workbuddy" ${workflow.agentMode==='workbuddy'?'selected':''}>WorkBuddy</option><option value="built-in" ${workflow.agentMode==='built-in'?'selected':''}>内置 Agent</option></select><small>先在“Agent”页完成所选 Agent 的连接配置。</small></label></div>
          <label>处理要求<textarea name="workflowInstruction" maxlength="500" rows="3">${safe(workflow.instruction)}</textarea><small>Agent 只能生成分析与更新建议；需要人在共作中确认。</small></label>
          <p class="settings-connection-note">开启后，匹配的企微消息会发送给所选 Agent。先用无敏感测试句验证大圆到机器人的投递；原始聊天不会因此自动开放给共作。</p>
        </div>
        <p class="settings-state">${desktopApi?'保存后再检查连接状态；真实收发仍需在对应服务中验证。':'浏览器演示可预览配置流程；真实连接仅在 Mac 版中执行。'}</p>
        <div class="settings-actions"><button type="button" class="soft-button" data-action="close-settings">取消</button><button class="dark-button" type="submit">保存设置</button></div>
      </form>
    </section>
  </div>`;
}

function wecomSendOverlay(){
  const target=state.wecomSendTarget;
  if(!target)return '';
  const task=tasks.find(item=>item.id===target.taskId);
  const message=target.draftText?{text:target.draftText}:task?.messages?.find(item=>item.id===target.messageId);
  if(!message)return '';
  const botReady=Boolean(state.settings?.wecom?.botId&&state.settings?.hasWecomBotSecret&&state.settings?.wecomBotStatus==='已连接');
  const appReady=Boolean(state.settings?.wecom?.organizationId&&state.settings?.wecom?.applicationId&&state.settings?.hasWecomSecret);
  const configured=botReady||appReady;
  const method=botReady?'智能机器人长连接':'自建应用';
  const notice=state.settings?.wecom?.botId&&state.settings?.hasWecomBotSecret?'机器人尚未连接。请在设置中检查长连接状态；也可配置自建应用作为备用发送方式。':'尚未接入企微。推荐在“设置 → 连接器”填写机器人 BotID 和 Secret。';
  const recentSingles=[...new Set((state.settings?.wecomRecentInbound||[]).filter(item=>item.chatType==='single').map(item=>item.userId).filter(Boolean))];
  return `<div class="wecom-send-overlay" role="dialog" aria-modal="true" aria-label="发送到企业微信"><section class="wecom-send-panel"><header><div><small>${safe(configured?method:'企业微信')}</small><h2>${target.draftText?'直接发送到企微':'转发已有工作消息'}</h2></div><button class="icon-button" data-action="close-wecom-send" aria-label="关闭发送窗口">${icon('close')}</button></header><p>${target.draftText?'这条文字只发给指定的企微成员，并在共作留下发送记录；不会调用 Agent。':'这条工作消息此前已交给 Agent。现在仅转发文字，不会再次调用 Agent。'}空间资料、记忆和其他对话不会随消息发送。</p><blockquote>${safe(message.text)}</blockquote><form id="wecom-send-form">${botReady?'<div class="wecom-send-notice">首次发送前，请收件人在企业微信里单聊这个机器人，发一条消息建立会话。机器人显示“已连接”只表示长连接已建立。</div>':''}<label>收件成员 UserID<input name="recipientUserId" maxlength="64" required value="${safe(state.wecomRecipientDraft)}" placeholder="企微成员 UserID" autocomplete="off"></label>${botReady&&recentSingles.length?`<div class="wecom-recent-recipients"><small>最近与机器人单聊的账号（点击填入）</small><div>${recentSingles.map(userId=>`<button type="button" data-action="select-wecom-recipient" data-id="${safe(userId)}">${safe(userId)}</button>`).join('')}</div></div>`:''}<small>仅支持单个成员，不能填写显示名或 @all。${botReady?'机器人需对该成员可见，并允许向该会话主动发送。':'自建应用需对该成员可见。'}</small>${!configured?`<div class="wecom-send-notice">${safe(notice)}</div>`:''}${botReady&&!recentSingles.length&&!state.wecomSendError?'<div class="wecom-send-notice">共作尚未收到机器人单聊消息。请先在企微向这个机器人发消息，再回到这里发送。</div>':''}${state.wecomSendError?`<div class="wecom-send-error">${safe(state.wecomSendError)}</div>`:''}<div class="wecom-send-actions"><button type="button" class="soft-button" data-action="open-wecom-settings-from-send">${configured?'管理企微接入':'去配置企微'}</button><button type="button" class="soft-button" data-action="close-wecom-send">取消</button><button class="dark-button" type="submit" ${!configured||state.wecomSubmitting?'disabled':''}>${state.wecomSubmitting?'正在发送…':'确认发送到企微'}</button></div></form></section></div>`;
}

function quickPanel(){
  if(state.quickPanel==='channel-inbox'){
    const inbound=state.inboundMessages;
    const sourceName=channel=>({wecom:'企业微信',feishu:'飞书',telegram:'Telegram',instagram:'Instagram'})[channel]||channel||'外部消息';
    return `<div class="quick-panel top-quick-panel channel-inbox" role="dialog" aria-label="消息收件"><div class="quick-panel-head"><strong>消息收件</strong><button class="icon-button" data-action="close-quick-panel" aria-label="关闭消息收件">${icon('close')}</button></div><div class="channel-inbox-list">${inbound.length?inbound.map(item=>`<article class="channel-inbox-item"><div><strong>${safe(sourceName(item.channel))} · ${safe(item.channel==='wecom'?state.wecomDirectory.members.find(member=>member.userId===item.senderId)?.name||item.senderId:item.senderId)}</strong><small>${safe(item.receivedAt?new Date(item.receivedAt).toLocaleString('zh-CN'):'')}</small></div><p>${item.text?safe(item.text):'<em>已收到；当时未保存正文，无法补回。</em>'}</p>${item.text&&state.view==='task'&&state.task?`<button class="inbox-quote-button" data-action="quote-inbound" data-id="${safe(item.id)}">作为工作材料引用</button>`:''}</article>`).join(''):'<p class="quick-empty">尚未收到已连接渠道的消息。当前可向企业微信机器人单聊发送文字。</p>'}</div><div class="quick-panel-foot">来信原文可直接在这里阅读。${desktopApi?'在工作对话中询问企微来信，也可让 Agent 查看或总结；引用只用于将指定消息作为工作材料。':'浏览器演示不连接 Agent。'}其他渠道尚未接入。</div></div>`;
  }
  if(state.quickPanel==='notifications'){
    const pending=tasks.filter(task=>task.needsMe);
    return `<div class="quick-panel top-quick-panel" role="dialog" aria-label="通知"><div class="quick-panel-head"><strong>需要你处理</strong><button class="icon-button" data-action="close-quick-panel" aria-label="关闭通知">${icon('close')}</button></div>${pending.length?pending.map(task=>`<button class="quick-row" data-action="open-task" data-id="${safe(task.id)}"><span class="status-dot amber"></span><span><strong>${safe(task.title)}</strong><small>${safe(task.workspace||state.workspace)} · ${safe(task.status==='review'?'待你确认':'等待你补充')}</small></span>${icon('chevron')}</button>`).join(''):'<p class="quick-empty">目前没有需要你处理的工作。</p>'}<div class="quick-panel-foot">通知来自本机任务；外部消息尚未接入。</div></div>`;
  }
  if(state.quickPanel==='people'){
    const current=state.view==='task'&&state.task?tasks.find(task=>task.id===state.task):null;
    return `<div class="quick-panel top-quick-panel" role="dialog" aria-label="当前成员"><div class="quick-panel-head"><strong>${current?'任务参与者':'当前成员'}</strong><button class="icon-button" data-action="close-quick-panel" aria-label="关闭成员">${icon('close')}</button></div><div class="member-line"><span class="member-avatar">明</span><span><strong>你</strong><small>本机使用者</small></span></div>${current?'<div class="member-line"><span class="member-avatar agent-member">✦</span><span><strong>团队 Agent</strong><small>当前为本地演示模式</small></span></div>':''}<div class="quick-panel-foot">企微目录和机器人参与按空间配置；跨设备共作账号仍未接入。</div></div>`;
  }
  if(state.quickPanel==='task-info'){
    const task=tasks.find(item=>item.id===state.task);
    const members=mentionMembers(task?.workspace||state.workspace).filter(item=>['active','wecom'].includes(item.status)&&item.wecomUserId);
    return `<div class="quick-panel top-quick-panel" role="dialog" aria-label="任务信息"><div class="quick-panel-head"><strong>任务信息</strong><button class="icon-button" data-action="close-quick-panel" aria-label="关闭任务信息">${icon('close')}</button></div><div class="quick-info"><span>标题</span><strong>${safe(task?.title||'')}</strong><span>工作空间</span><strong>${safe(task?.workspace||state.workspace)}</strong><span>当前状态</span><strong>${safe(task?.status==='review'?'待确认':task?.status==='todo'?'待补充':'进行中')}</strong><span>负责人</span><strong>${safe(task?.assignee?.name||'未指派')}</strong></div>${desktopApi?`<form id="assign-task-form" class="quick-assign-form"><label>指派给当前空间的企微同事<select name="memberId" required><option value="">选择成员</option>${members.map(member=>`<option value="${safe(member.id)}">${safe(member.name)} · ${safe(member.wecomUserId)}</option>`).join('')}</select></label><button class="dark-button" type="submit" ${members.length?'':'disabled'}>指派并通知企微</button><small>${task?.assignmentDelivery?.status==='sent'?'企微接口已接受，请确认实际送达':task?.assignmentDelivery?.status==='unknown'?'结果未知，请先在企微核对':task?.assignmentDelivery?.detail?safe(task.assignmentDelivery.detail):members.length?'会向所选成员发送工作标题和打开链接':'先在空间成员中关联企微同事'}</small></form>`:''}</div>`;
  }
  if(state.quickPanel==='search'){
    const query=state.searchQuery.trim().toLowerCase();
    const matchedTasks=tasks.filter(task=>!query||`${task.title} ${task.workspace||''}`.toLowerCase().includes(query)).slice(0,50);
    const matchedDocs=state.documents.filter(item=>item.status==='active'&&(!query||`${item.name} ${item.tags.join(' ')}`.toLowerCase().includes(query))).slice(0,6);
    return `<div class="search-overlay" role="dialog" aria-modal="true" aria-label="搜索工作和资料"><section class="search-panel"><div class="search-panel-head">${icon('search')}<input id="global-search-input" value="${safe(state.searchQuery)}" placeholder="搜索工作、空间资料和应用" aria-label="搜索"><button class="icon-button" data-action="close-quick-panel" aria-label="关闭搜索">${icon('close')}</button></div><div class="search-results"><small>工作</small>${matchedTasks.length?matchedTasks.map(task=>`<button data-action="open-task" data-id="${safe(task.id)}">${icon('tasks')}<span>${safe(task.title)}<small>${safe(task.workspace||state.workspace)}</small></span></button>`).join(''):'<p>没有匹配的工作</p>'}<small>空间资料</small>${matchedDocs.length?matchedDocs.map(item=>`<button data-action="search-open-document" data-id="${safe(item.id)}">${icon('file')}<span>${safe(item.name)}<small>${safe(state.workspaces.find(space=>space.id===item.workspaceId)?.name||item.workspaceId)}</small></span></button>`).join(''):'<p>没有匹配的资料</p>'}<small>团队小应用</small>${!query||'客户反馈管理'.includes(query)?`<button data-action="open-app">${icon('app')}<span>客户反馈管理<small>演示应用</small></span></button>`:'<p>没有匹配的小应用</p>'}</div></section></div>`;
  }
  return '';
}

let renderedView=null,renderedTask=null,renderedDrawer=null;
function render({followThread=false}={}){
  const previousThread=root.querySelector?.('.thread');
  const previousThreadTop=previousThread?.scrollTop||0;
  const threadWasNearBottom=previousThread?previousThread.scrollHeight-previousThread.clientHeight-previousThreadTop<=80:false;
  const sameThread=renderedView==='task'&&state.view==='task'&&renderedTask===state.task&&Boolean(previousThread);
  const previousDrawerTop=root.querySelector?.('.drawer')?.scrollTop||0;
  const sameDrawer=renderedDrawer===state.drawer&&state.drawerOpen;
  root.innerHTML=`<div class="desktop"><div class="app-window">${titlebar()}<div class="workarea">${rail()}${drawer()}${state.view==='workspace'?workspaceStage():state.view==='task'&&state.task?taskStage():state.view==='apps'?appsStage():home()}</div>${state.memoryPanel?memoryOverlay():''}${state.settingsPanel?settingsOverlay():''}${state.wecomSendTarget?wecomSendOverlay():''}${state.docEditing?documentEditor():''}${state.projectDialog?projectDialog():''}${state.memberPanel?projectMembersDialog():''}${quickPanel()}</div></div><input id="browser-doc-upload" type="file" accept=".pdf,.docx,.doc,.txt,.md,.csv,.xlsx,.xls,.pptx,.ppt" multiple hidden>${state.toast?`<div class="toast">${safe(state.toast)}</div>`:''}`;
  const thread=root.querySelector?.('.thread');
  if(thread)thread.scrollTop=followThread||!sameThread||threadWasNearBottom?thread.scrollHeight:previousThreadTop;
  const drawerPane=root.querySelector?.('.drawer');
  if(drawerPane&&sameDrawer)drawerPane.scrollTop=previousDrawerTop;
  renderedView=state.view;renderedTask=state.task;renderedDrawer=state.drawerOpen?state.drawer:null;
  document.title=`${state.view==='workspace'?state.workspace:state.view==='task'&&state.task?(tasks.find(t=>t.id===state.task)?.title||'新工作'):state.view==='apps'?'客户反馈管理':'团队 Agent'} · ${desktopApi?'共作':'共作 Demo'}`;
}

function toast(text){state.toast=text;render();setTimeout(()=>{state.toast='';render()},2600)}
function openTask(id){const task=tasks.find(item=>item.id===id);if(!task)return;state.task=id;state.view='task';state.drawer='history';if(Array.isArray(state.historyOpenGroups)&&!state.historyOpenGroups.includes(task.workspace||'未归类'))state.historyOpenGroups.push(task.workspace||'未归类');state.quickPanel=null;state.composerSpaceMenu=false;state.composerDocuments['thread-input']=[];state.documentPicker=null;state.mentionMenu=false;state.composerMentions=[];state.capabilityPanel=false;state.capabilityDetail=null;state.homeCustomize=false;state.artifactOpen=id==='feedback';state.artifactTab='preview';state.messages=(task?.messages||[]).filter(message=>message.role==='user'&&message.text!==task.goal).map(message=>({text:message.text,mentions:message.mentions||[],mentionDelivery:message.mentionDelivery||null,documentRefs:message.documentRefs||[]}));render()}
function quoteInboundToCurrentTask(id){
  const item=state.inboundMessages.find(message=>message.id===id&&message.text);
  if(!item||state.view!=='task'||!state.task)return false;
  const sender=item.channel==='wecom'?state.wecomDirectory.members.find(member=>member.userId===item.senderId)?.name||item.senderId:item.senderId;
  const source=({wecom:'企业微信',feishu:'飞书',telegram:'Telegram',instagram:'Instagram'})[item.channel]||item.channel;
  const time=item.receivedAt?new Date(item.receivedAt).toLocaleString('zh-CN'):'';
  const quoted=`引用${source}来信（${sender} · ${time}）：\n${item.text}`;
  state.composerDrafts['thread-input']=[state.composerDrafts['thread-input'],quoted].filter(Boolean).join('\n\n');
  state.quickPanel=null;render();document.getElementById('thread-input')?.focus();
  return true;
}
async function refreshMemories(){
  if(desktopApi) state.memories=await desktopApi.listMemories();
}

async function refreshDocuments(){if(desktopApi)state.documents=await desktopApi.listDocuments()}

function showWorkspaceFormError(form,error){
  let message=form.querySelector('.workspace-form-error');
  if(!message){message=document.createElement('p');message.className='workspace-form-error';const actions=form.querySelector('.workspace-dialog-actions');if(actions)actions.before(message);else form.append(message)}
  message.textContent=error?.message||'保存失败';
}

async function saveProjectWorkspace(form){
  const values=new FormData(form);
  const input={name:String(values.get('name')||'').trim(),parentWorkspaceId:String(values.get('parentWorkspaceId')||'')||null,description:String(values.get('description')||'').trim()};
  try{
    if(desktopApi)applyDesktopData(await desktopApi.createProjectWorkspace(input));
    else{
      if(input.name.length<2||input.name.length>80)throw new Error('项目空间名称需为 2–80 个字');
      if(state.workspaces.some(space=>space.name.toLocaleLowerCase()===input.name.toLocaleLowerCase()))throw new Error('已有同名工作空间');
      if(input.parentWorkspaceId&&!state.workspaces.some(space=>space.id===input.parentWorkspaceId&&workspaceType(space)==='team'))throw new Error('关联团队不存在');
      state.workspaces.push({id:`project-${Date.now()}`,type:'project',...input,createdBy:'local-user',createdAt:new Date().toISOString(),members:[{id:'local-user',name:'我',role:'owner',status:'active'}]});
      state.workspace=input.name;
    }
    state.projectDialog=false;state.memberPanel=true;state.view='workspace';state.drawer='team';state.drawerOpen=true;state.docCategory='全部';state.docSearch='';state.docShowArchived=false;render();
  }catch(error){showWorkspaceFormError(form,error)}
}

async function saveProjectMember(form){
  const values=new FormData(form);
  const input={workspaceId:currentWorkspace()?.id,email:String(values.get('email')||'').trim().toLowerCase(),name:String(values.get('name')||'').trim(),role:String(values.get('role')||'editor')};
  try{
    if(desktopApi)applyDesktopData(await desktopApi.addProjectMember(input));
    else{
      const space=currentWorkspace();
      if(space?.createdBy!=='local-user')throw new Error('只有空间创建者可以添加成员');
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))throw new Error('请输入有效的同事邮箱');
      if(!['viewer','editor'].includes(input.role))throw new Error('项目权限无效');
      if(space.members.some(member=>member.email?.toLowerCase()===input.email))throw new Error('该同事已在待邀请列表中');
      space.members.push({id:`member-${Date.now()}`,email:input.email,name:input.name||input.email.split('@')[0],role:input.role,status:'pending',addedAt:new Date().toISOString()});
    }
    render();
  }catch(error){showWorkspaceFormError(form,error)}
}

async function linkWecomMember(form){
  const values=new FormData(form);
  try{applyDesktopData(await desktopApi.linkWecomProjectMember({workspaceId:currentWorkspace()?.id,userId:values.get('userId'),role:values.get('role')}));render();toast('已关联企微成员，可通过机器人参与当前空间')}catch(error){showWorkspaceFormError(form,error)}
}

async function updateProjectMemberRole(memberId,role){
  const space=currentWorkspace();
  try{
    if(desktopApi)applyDesktopData(await desktopApi.updatePendingProjectMemberRole({workspaceId:space?.id,memberId,role}));
    else{
      if(space?.createdBy!=='local-user')throw new Error('只有空间创建者可以管理成员');
      const member=space.members.find(item=>item.id===memberId&&['pending','wecom'].includes(item.status));
      if(!member)throw new Error('待邀请成员不存在');
      if(!['viewer','editor'].includes(role))throw new Error('项目权限无效');
      member.role=role;
    }
    render();toast('待邀请权限已更新，尚未开通访问');
  }catch(error){toast(error?.message||'权限更新失败')}
}

async function removeProjectMember(memberId){
  const space=currentWorkspace();
  try{
    if(desktopApi)applyDesktopData(await desktopApi.removePendingProjectMember({workspaceId:space?.id,memberId}));
    else{
      if(space?.createdBy!=='local-user')throw new Error('只有空间创建者可以管理成员');
      const member=space.members.find(item=>item.id===memberId&&['pending','wecom'].includes(item.status));
      if(!member)throw new Error('待邀请成员不存在');
      space.members=space.members.filter(item=>item.id!==memberId);
    }
    render();
  }catch(error){toast(error?.message||'移除成员失败')}
}

async function uploadDocuments(workspaceName=state.workspace){
  state.uploadTargetWorkspace=workspaceName;
  if(!desktopApi){document.getElementById('browser-doc-upload')?.click();return}
  try{
    const uploaded=await desktopApi.uploadDocuments(activeWorkspaceId(workspaceName));
    if(!uploaded.length)return;
    state.recentAttachment={name:uploaded.length===1?uploaded[0].name:`${uploaded.length} 份文件`,workspace:workspaceName};
    await refreshDocuments();render();toast(`已上传到${workspaceName}资料`);
  }catch(error){toast(error?.message||'上传资料失败')}
}

async function saveDocumentDraft(form){
  const values=new FormData(form);
  const input={id:state.docEditing,category:values.get('category'),tags:String(values.get('tags')||'').split(/[,，]/).map(tag=>tag.trim()).filter(Boolean)};
  try{
    if(desktopApi){await desktopApi.updateDocument(input);await refreshDocuments()}
    else Object.assign(state.documents.find(document=>document.id===input.id),input);
    state.docEditing=null;state.docDraft=null;render();toast('资料分类与标签已保存');
  }catch(error){const errorEl=form.querySelector('.settings-error')||document.createElement('p');errorEl.className='settings-error';errorEl.textContent=error?.message||'保存失败';if(!errorEl.parentNode)form.querySelector('.doc-editor-actions')?.before(errorEl)}
}

async function saveSettingsForm(form, keepOpen=false){
  const values=new FormData(form);
  const input={
    model:{provider:values.get('provider'),modelId:values.get('modelId'),baseUrl:values.get('baseUrl')},
    agent:{mode:values.get('agentMode'),endpoint:values.get('agentEndpoint'),workbuddyTransport:values.get('workbuddyTransport')||undefined},
    wecom:{organizationId:values.get('wecomOrganizationId'),applicationId:values.get('wecomApplicationId'),recipientUserId:values.get('wecomRecipientUserId'),botId:values.get('wecomBotId'),messageScope:values.get('wecomMessageScope')},
    workflow:{enabled:values.has('workflowEnabled'),senderUserId:values.get('workflowSenderUserId'),workspaceId:values.get('workflowWorkspaceId'),prefix:values.get('workflowPrefix'),agentMode:values.get('workflowAgentMode'),instruction:values.get('workflowInstruction')},
    modelKey:values.get('modelKey')||undefined,
    agentToken:values.get('agentToken')||undefined,
    workbuddyAccessToken:values.get('workbuddyAccessToken')||undefined,
    wecomSecret:values.get('wecomSecret')||undefined,
    wecomBotSecret:values.get('wecomBotSecret')||undefined,
    clearModelKey:values.has('clearModelKey'),
    clearAgentToken:values.has('clearAgentToken'),
    clearWorkbuddyAccessToken:values.has('clearWorkbuddyAccessToken'),
    clearWecomSecret:values.has('clearWecomSecret'),
    clearWecomBotSecret:values.has('clearWecomBotSecret')
  };
  try{
    if(desktopApi){state.settings=await desktopApi.saveSettings(input);state.agentStatus=await desktopApi.getAgentStatus()}
    else state.settings={...state.settings,model:input.model,agent:input.agent,wecom:input.wecom,workflow:input.workflow};
    state.settingsBeforeCapability=null;
    state.modelDraftProfiles=null;
    state.settingsPanel=keepOpen;
    if(keepOpen)state.settingsSection='connectors';
    render();
    if(keepOpen) document.getElementById('settings-wecom')?.scrollIntoView({block:'start'});
    toast(keepOpen?`机器人配置已保存；当前状态：${state.settings.wecomBotStatus||'连接中'}`:'设置已保存；请检查企微机器人长连接');
  }catch(error){
    const status=form.querySelector('.settings-error')||document.createElement('p');
    status.className='settings-error';
    status.textContent=error?.message||'保存设置失败';
    if(!status.parentNode) form.querySelector('.settings-actions')?.before(status);
  }
}

async function submitWecomForm(form){
  const target=state.wecomSendTarget;
  if(!target||!desktopApi||state.wecomSubmitting)return;
  state.wecomRecipientDraft=String(new FormData(form).get('recipientUserId')||'').trim();
  state.wecomSendError='';state.wecomSubmitting=true;render();
  try{
    const outbound=Boolean(target.draftText);
    const response=outbound
      ? await desktopApi.sendWecomDraft({taskId:target.taskId||null,workspace:target.workspace,text:target.draftText,recipientUserId:state.wecomRecipientDraft})
      : await desktopApi.sendWecomMessage({...target,recipientUserId:state.wecomRecipientDraft});
    const result=outbound?response.delivery:response;
    state.wecomSubmitting=false;
    if(outbound&&response.task){
      const latest=normalizeDesktopTask(response.task);
      tasks=tasks.filter(item=>item.id!==latest.id);
      tasks.unshift(latest);
      state.task=latest.id;state.view='task';
      state.composerDrafts[target.inputId]='';
      state.wecomSendTarget={taskId:response.taskId,messageId:response.messageId};
    }
    if(result.status==='sent'){
      state.wecomSendTarget=null;render();toast('企微接口已接受消息，请在企业微信确认收到');
    }else{state.wecomSendError=result.detail||'发送失败，请检查配置和收件成员';render()}
  }catch(error){state.wecomSubmitting=false;state.wecomSendError=error?.message||'无法发送到企业微信';render()}
}

async function extractTaskMemory(){
  const task=tasks.find(item=>item.id===state.task);
  if(!task) return;
  try{
    const candidate=desktopApi?await desktopApi.extractMemory(task.id):{
      title:task.title,content:task.goal||task.title,category:'其他',tags:[],sourceTaskId:task.id,sourceExcerpt:task.goal||task.title,workspace:task.workspace||state.workspace
    };
    state.memoryWorkspace=candidate.workspace||task.workspace||state.workspace;
    state.memoryDraft={...candidate,tags:(candidate.tags||[]).join(', ')};
    state.memoryScope='personal';
    state.memoryPanel=true;
    render();
  }catch(error){toast(error?.message||'无法提炼记忆')}
}

async function saveMemoryDraft(){
  const draft=state.memoryDraft;
  if(!draft) return;
  const input={...draft,scope:state.memoryScope,workspace:state.memoryWorkspace||state.workspace,tags:String(draft.tags||'').split(/[,，]/).map(tag=>tag.trim()).filter(Boolean)};
  try{
    if(desktopApi){if(draft.id) await desktopApi.updateMemory(input);else await desktopApi.saveMemory(input);await refreshMemories()}
    else{
      if(draft.id) Object.assign(state.memories[input.scope].find(item=>item.id===draft.id),input);
      else{
        const item={...input,id:'demo-'+Date.now(),workspaceId:activeWorkspaceId(input.workspace),status:'active',source:input.sourceTaskId?{type:'task',taskId:input.sourceTaskId}:{type:'manual'}};
        state.memories[input.scope].unshift(item);
      }
    }
    state.memoryDraft=null;
    render();
    toast(draft.id?'记忆已更新':`已保存到${input.scope==='personal'?'个人':'团队'}记忆`);
  }catch(error){toast(error?.message||'保存记忆失败')}
}
async function startFrom(text){
  if(desktopApi){
    try{
      const created=normalizeDesktopTask(await desktopApi.createTask({goal:text,workspace:state.workspace,documentIds:state.composerDocuments['home-input']||[]}));
      const latest=tasks.find(task=>task.id===created.id)||created;
      tasks=tasks.filter(task=>task.id!==created.id);
      tasks.unshift(latest);
      state.task=created.id;
      state.view='task';
      state.composerDrafts['home-input']='';
      state.composerDocuments['home-input']=[];state.documentPicker=null;
      state.messages=[];
      state.artifactOpen=false;
      render();
      toast('工作已创建并保存在这台 Mac 上');
      return;
    }catch(error){toast(error?.message||'创建工作失败');return}
  }
  state.task='custom';
  state.view='task';
  state.composerDrafts['home-input']='';
  const customTask={id:'custom',title:text.length>22?text.slice(0,22)+'…':text,goal:text,workspace:state.workspace,meta:'你刚刚发起 · '+state.workspace,status:'demo',dot:'violet',needsMe:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  const oldIndex=tasks.findIndex(task=>task.id==='custom');
  if(oldIndex>=0)tasks.splice(oldIndex,1);
  tasks.unshift(customTask);
  state.messages=[];
  state.artifactOpen=false;
  render();
  toast('已创建浏览器演示任务');
}

root.addEventListener('click',async(event)=>{
  const el=event.target.closest('[data-action]'); if(!el) return;
  const action=el.dataset.action, id=el.dataset.id;
  if(action==='retry-agent'){
    if(!desktopApi){toast('请在 Mac 版重试');return}
    el.disabled=true;
    try{await desktopApi.retryAgent(state.task);toast('已重新交给 Agent 处理')}
    catch(error){el.disabled=false;toast(error?.message||'重试失败')}
    return;
  }
  if(action==='select-task-agent'){
    if(!desktopApi||!state.task){toast('请先打开一项 Mac 版工作');return}
    try{await desktopApi.setTaskAgent({taskId:state.task,mode:id});state.capabilityPanel=false;state.capabilityDetail=null;render();toast(`当前工作已切换到${agentLabel(id)}；此前未回复的消息可点“回复上一条”`)}
    catch(error){toast(error?.message||'切换 Agent 失败')}
    return;
  }
  if(action==='sync-workbuddy'){
    if(!desktopApi){toast('请在 Mac 版取回 WorkBuddy 回复');return}
    el.disabled=true;
    try{const result=await desktopApi.syncWorkBuddyReply({taskId:state.task,messageId:id});toast(result.ready?'已取回 WorkBuddy 回复':'WorkBuddy 还没有返回文本回复')}
    catch(error){toast(error?.message||'取回回复失败')}
    finally{el.disabled=false}
  }
  if(action==='home-mode'&&['overview','compact','agent'].includes(id)){
    state.homeMode=id;state.homeDefaultMode=id;state.homeCustomize=false;state.capabilityPanel=false;saveHomePreferences();render();
  }
  if(action==='start-agent'||action==='home-external'){
    state.homeMode='agent';state.homeCustomize=false;state.capabilityPanel=action==='home-external';state.capabilitySection='tools';state.capabilityTab='mcp';state.capabilityDetail=null;render();
    if(action==='start-agent')document.getElementById('home-input')?.focus();
  }
  if(action==='home-customize'){state.homeCustomize=!state.homeCustomize;render()}
  if(action==='home-module-toggle'&&homeModuleCatalog[id]){
    state.homeHidden=state.homeHidden.includes(id)?state.homeHidden.filter(item=>item!==id):[...state.homeHidden,id];
    saveHomePreferences();render();
  }
  if(action==='home-module-move'&&homeModuleCatalog[id]){
    const from=state.homeModules.indexOf(id),to=from+Number(el.dataset.direction);
    if(from>=0&&to>=0&&to<state.homeModules.length){const modules=[...state.homeModules];[modules[from],modules[to]]=[modules[to],modules[from]];state.homeModules=modules;saveHomePreferences();render()}
  }
  if(action==='home-module-reset'){state.homeModules=[...defaultHomeModules];state.homeHidden=[];saveHomePreferences();render()}
  if(action==='home-documents'){state.view='workspace';state.drawer='team';state.drawerOpen=true;state.homeCustomize=false;render()}
  if(action==='toggle-notifications'){state.quickPanel=state.quickPanel==='notifications'?null:'notifications';state.composerSpaceMenu=false;render()}
  if(action==='toggle-channel-inbox'){state.quickPanel=state.quickPanel==='channel-inbox'?null:'channel-inbox';state.composerSpaceMenu=false;render()}
  if(action==='quote-inbound'){if(!quoteInboundToCurrentTask(id))toast('请先打开一项工作，再引用收到的消息')}
  if(action==='toggle-people'){state.quickPanel=state.quickPanel==='people'?null:'people';state.composerSpaceMenu=false;render()}
  if(action==='toggle-mentions'){
    const input=document.getElementById('thread-input');
    state.mentionCursor=input?.selectionStart??state.composerDrafts['thread-input'].length;
    state.mentionMenu=!state.mentionMenu;
    state.mentionQuery='';render();
    const next=document.getElementById('thread-input');next?.focus();next?.setSelectionRange(state.mentionCursor,state.mentionCursor);
  }
  if(action==='select-mention'){
    const task=tasks.find(item=>item.id===state.task);
    const member=mentionMembers(task?.workspace||state.workspace).find(item=>item.id===id&&item.status!=='pending');
    if(!member)return;
    const draft=state.composerDrafts['thread-input']||'';
    const cursor=Math.min(state.mentionCursor,draft.length);
    const prefix=draft.slice(0,cursor);
    const match=prefix.match(/(?:^|\s)@[^\s@]*$/u);
    const start=match?cursor-match[0].length+match[0].lastIndexOf('@'):cursor;
    const inserted=`@${member.name} `;
    state.composerDrafts['thread-input']=draft.slice(0,start)+inserted+draft.slice(cursor);
    state.composerMentions=[...state.composerMentions.filter(item=>item.id!==member.id),{id:member.id,name:member.name}];
    state.mentionMenu=false;state.mentionQuery='';render();
    const next=document.getElementById('thread-input');const nextCursor=start+inserted.length;next?.focus();next?.setSelectionRange(nextCursor,nextCursor);
  }
  if(action==='toggle-task-menu'){state.quickPanel=state.quickPanel==='task-menu'?null:'task-menu';render()}
  if(action==='show-task-info'){state.quickPanel='task-info';render()}
  if(action==='close-quick-panel'){state.quickPanel=null;render()}
  if(action==='toggle-composer-space'){state.composerSpaceMenu=!state.composerSpaceMenu;state.quickPanel=null;render()}
  if(action==='toggle-capabilities'){const section=id||'agent';state.capabilityPanel=!(state.capabilityPanel&&state.capabilitySection===section);state.capabilitySection=section;state.capabilityDetail=null;state.composerSpaceMenu=false;state.quickPanel=null;render()}
  if(action==='capability-tab'){state.capabilityTab=id;state.capabilityDetail=null;render()}
  if(action==='capability-detail'){state.capabilityDetail=id;render()}
  if(action==='capability-back'){state.capabilityDetail=null;render()}
  if(action==='capability-settings'){
    const mode=['built-in','codebuddy','workbuddy','codex','kimi'].includes(state.capabilityDetail)?state.capabilityDetail:'external';
    state.capabilityPanel=false;state.capabilityDetail=null;
    try{
      if(desktopApi)state.settings=await desktopApi.getSettings();
      state.settingsBeforeCapability=state.settings;
      state.settings={...state.settings,agent:{...state.settings.agent,mode}};
      state.settingsSection='agent';
      state.settingsPanel=true;render();
    }catch(error){toast(error?.message||'无法打开设置')}
  }
  if(action==='select-composer-space'){
    if(state.view==='task'&&state.task){state.composerDrafts['home-input']=state.composerDrafts['thread-input'];state.composerDrafts['thread-input']='';state.task=null;state.view='home';state.homeMode='agent';state.drawerOpen=false}
    state.workspace=id;state.composerDocuments['home-input']=[];state.composerDocuments['thread-input']=[];state.documentPicker=null;state.composerSpaceMenu=false;render();
    if(desktopApi){try{await desktopApi.setActiveWorkspace(id)}catch(error){toast(error?.message||'工作空间切换失败')}}
  }
  if(action==='upload-from-composer')await uploadDocuments(state.view==='task'&&state.task?tasks.find(task=>task.id===state.task)?.workspace||state.workspace:state.workspace);
  if(action==='toggle-document-picker'){state.documentPicker=state.documentPicker===id?null:id;state.capabilityPanel=false;render()}
  if(action==='select-document'){
    const inputId=el.dataset.input;
    const selected=state.composerDocuments[inputId]||[];
    if(selected.includes(id))state.composerDocuments[inputId]=selected.filter(docId=>docId!==id);
    else if(selected.length<3)state.composerDocuments[inputId]=[...selected,id];
    else{toast('一次最多引用 3 份资料');return}
    render();
  }
  if(action==='view-attached-document'){state.workspace=state.recentAttachment.workspace;state.view='workspace';state.drawer='team';state.drawerOpen=true;render()}
  if(action==='go-task-workspace'){state.workspace=tasks.find(task=>task.id===state.task)?.workspace||state.workspace;state.view='workspace';state.drawer='team';state.drawerOpen=true;state.quickPanel=null;render()}
  if(action==='search-open-document'){
    const item=state.documents.find(document=>document.id===id);
    if(item){state.workspace=state.workspaces.find(space=>space.id===item.workspaceId)?.name||state.workspace;state.view='workspace';state.drawer='team';state.drawerOpen=true;state.docCategory='全部';state.docShowArchived=false;state.docSearch=item.name;state.quickPanel=null;render()}
  }
  if(action==='new'){state.task=null;state.view='home';state.homeMode=state.homeDefaultMode;state.drawerOpen=false;state.capabilityPanel=false;state.capabilityDetail=null;state.homeCustomize=false;render();if(state.homeMode==='agent')setTimeout(()=>document.getElementById('home-input')?.focus(),0)}
  if(action==='toggle-drawer'){state.drawerOpen=!state.drawerOpen;render()}
  if(action==='drawer'){state.drawer=id;state.drawerOpen=true;state.view=id==='team'?'workspace':id==='apps'?'apps':state.task&&id==='history'?'task':'home';render()}
  if(action==='work-filter'){state.workFilter=id;render()}
  if(action==='toggle-history-group'){
    const groups=state.historyOpenGroups===null?[...root.querySelectorAll('.history-group-head[aria-expanded="true"]')].map(button=>button.dataset.id):state.historyOpenGroups;
    state.historyOpenGroups=groups.includes(id)?groups.filter(name=>name!==id):[...groups,id];render();
  }
  if(action==='search-history-space'){state.quickPanel='search';state.searchQuery=id;render();document.getElementById('global-search-input')?.focus()}
  if(action==='open-task') openTask(id);
  if(action==='practice'){const p=practices.find(x=>x.id===id);if(p){state.homeMode='agent';state.homeCustomize=false;state.composerDrafts['home-input']=p.prompt;render();document.getElementById('home-input')?.focus()}}
  if(action==='submit'){const input=document.getElementById(el.dataset.input);const value=input?.value.trim();if(!value){input?.focus();return}if(state.view==='task'&&state.task){
    const selected=state.composerMentions.filter(member=>value.includes(`@${member.name}`));
    const typedMentions=[...value.matchAll(/(?:^|\s)@([^\s@]+)/gu)].map(match=>match[1]);
    if(typedMentions.some(name=>!selected.some(member=>member.name===name))){toast('请从 @ 同事列表选择成员后再发送');input?.focus();return}
    let message;
    if(desktopApi){try{message=await desktopApi.appendMessage({taskId:state.task,text:value,mentions:selected.map(member=>member.id),documentIds:state.composerDocuments['thread-input']||[]})}catch(error){toast(error?.message||'消息保存失败');return}}
    else{message={id:`demo-message-${Date.now()}`,role:'user',text:value,mentions:selected.map(member=>({memberId:member.id,name:member.name})),mentionDelivery:selected.length?'demo':null,documentRefs:(state.composerDocuments['thread-input']||[]).map(docId=>state.documents.find(item=>item.id===docId)).filter(Boolean).map(item=>({id:item.id,name:item.name})),createdAt:new Date().toISOString()};const current=tasks.find(task=>task.id===state.task);if(current){current.messages||=[];current.messages.push(message);current.updatedAt=message.createdAt}}
    state.messages.push({text:message.text,mentions:message.mentions||[],mentionDelivery:message.mentionDelivery,documentRefs:message.documentRefs||[]});
    state.composerDrafts['thread-input']='';state.composerDocuments['thread-input']=[];state.documentPicker=null;state.composerMentions=[];state.mentionMenu=false;render({followThread:true});toast(selected.length?(message.mentionDelivery==='sent'?'消息已记录；企微接口已接受提醒':message.mentionDelivery==='demo'?'演示提醒，未实际送达':'消息已记录；请查看企微发送结果'):'已追加到当前工作');
  }else await startFrom(value)}
  if(action==='toggle-artifact'){state.artifactOpen=!state.artifactOpen;render()}
  if(action==='artifact-tab'){state.artifactTab=id;render()}
  if(action==='publish'){state.published=true;state.artifactOpen=true;render();toast('演示版本已发布给产品团队')}
  if(action==='revise'){openTask('feedback');state.artifactOpen=true;state.artifactTab='preview';render();setTimeout(()=>document.getElementById('thread-input')?.focus(),0)}
  if(action==='switch-workspace'){state.workspace=id;state.view='workspace';state.drawer='team';state.drawerOpen=true;state.docCategory='全部';state.docSearch='';state.docShowArchived=false;render();if(desktopApi){try{await desktopApi.setActiveWorkspace(id)}catch(error){toast(error?.message||'工作空间保存失败')}}}
  if(action==='open-project-dialog'){state.projectDialog=true;render();document.querySelector('#project-space-form [name="name"]')?.focus()}
  if(action==='close-project-dialog'){state.projectDialog=false;render()}
  if(action==='open-project-members'){state.memberPanel=true;render()}
  if(action==='close-project-members'){state.memberPanel=false;render()}
  if(action==='remove-project-member')await removeProjectMember(id);
  if(action==='start-project-work'){state.task=null;state.view='home';state.homeMode='agent';state.drawerOpen=false;render();document.getElementById('home-input')?.focus()}
  if(action==='toggle-source-message'){state.sourceExpanded=!state.sourceExpanded;render()}
  if(action==='upload-documents')await uploadDocuments();
  if(action==='doc-category'){state.docCategory=id;render()}
  if(action==='doc-archived'){state.docShowArchived=!state.docShowArchived;render()}
  if(action==='open-document'){
    try{if(desktopApi)await desktopApi.openDocument(id);else{const item=state.documents.find(document=>document.id===id);if(item?.blobUrl)window.open(item.blobUrl,'_blank','noopener,noreferrer')}}
    catch(error){toast(error?.message||'无法打开资料')}
  }
  if(action==='edit-document'){const item=state.documents.find(document=>document.id===id);if(item){state.docEditing=id;state.docDraft={...item};render()}}
  if(action==='close-document-editor'){state.docEditing=null;state.docDraft=null;render()}
  if(action==='archive-document'||action==='restore-document'){
    try{
      if(desktopApi){if(action==='archive-document')await desktopApi.archiveDocument(id);else await desktopApi.restoreDocument(id);await refreshDocuments()}
      else{const item=state.documents.find(document=>document.id===id);if(item)item.status=action==='archive-document'?'archived':'active'}
      render();toast(action==='archive-document'?'资料已移出，可在“查看已移出”中恢复':'资料已恢复');
    }catch(error){toast(error?.message||'更新资料失败')}
  }
  if(action==='open-app'){state.view='apps';state.drawer='apps';state.drawerOpen=true;state.quickPanel=null;render()}
  if(action==='mini-tab'){state.miniTab=id;state.miniFormOpen=false;render()}
  if(action==='mini-add'){state.miniTab='feedback';state.miniFormOpen=!state.miniFormOpen;render();if(state.miniFormOpen)document.querySelector('#mini-feedback-form [name="content"]')?.focus()}
  if(action==='open-memory'){state.memoryPanel=true;state.memoryScope=id==='team'?'team':'personal';state.memoryWorkspace=state.workspace;state.memoryDraft=null;try{await refreshMemories()}catch(error){toast(error?.message||'记忆读取失败')}render()}
  if(action==='open-settings'){
    try{if(desktopApi) state.settings=await desktopApi.getSettings();state.modelDraftProfiles=null;state.settingsPanel=true;render()}
    catch(error){toast(error?.message||'无法打开设置')}
  }
  if(action==='open-model-settings'){
    try{if(desktopApi)state.settings=await desktopApi.getSettings();state.modelDraftProfiles=null;state.settingsSection='model';state.settingsPanel=true;render()}
    catch(error){toast(error?.message||'无法打开模型设置')}
  }
  if(action==='open-wecom-send'){
    try{if(desktopApi)state.settings=await desktopApi.getSettings();state.wecomSendTarget={taskId:el.dataset.task,messageId:id};state.wecomRecipientDraft=state.settings?.wecom?.recipientUserId||'';state.wecomSendError='';render();root.querySelector('#wecom-send-form [name="recipientUserId"]')?.focus()}
    catch(error){toast(error?.message||'无法打开企业微信发送窗口')}
  }
  if(action==='open-wecom-composer'){
    const inputId=el.dataset.input;
    const input=document.getElementById(inputId);
    const draft=input?.value.trim();
    if(!draft){input?.focus();toast('请先输入要发送到企微的文字');return}
    if(new TextEncoder().encode(draft).length>2048){toast('企微消息不能超过 2048 字节');return}
    try{
      state.settings=await desktopApi.getSettings();
      state.wecomSendTarget={taskId:state.view==='task'?state.task:null,workspace:state.workspace,draftText:draft,inputId};
      state.wecomRecipientDraft=state.settings?.wecom?.recipientUserId||'';
      state.wecomSendError='';render();root.querySelector('#wecom-send-form [name="recipientUserId"]')?.focus();
    }catch(error){toast(error?.message||'无法打开企微发送窗口')}
  }
  if(action==='select-wecom-recipient'){
    state.wecomRecipientDraft=id;
    const input=root.querySelector('#wecom-send-form [name="recipientUserId"]');
    if(input){input.value=id;input.focus()}
  }
  if(action==='open-wecom-settings-from-send'){
    try{
      if(desktopApi)state.settings=await desktopApi.getSettings();
      state.wecomSendTarget=null;state.wecomSendError='';state.settingsSection='connectors';state.settingsPanel=true;render();
    }catch(error){toast(error?.message||'无法打开企业微信设置')}
  }
  if(action==='close-wecom-send'){state.wecomSendTarget=null;state.wecomSendError='';render()}
  if(action==='save-wecom-bot'&&desktopApi){
    const form=document.getElementById('settings-form');
    const botId=form?.querySelector('[name="wecomBotId"]')?.value.trim();
    const secret=form?.querySelector('[name="wecomBotSecret"]')?.value.trim();
    if(!botId||(!secret&&!state.settings?.hasWecomBotSecret)){toast('请先填写机器人 BotID 和 Secret');return}
    await saveSettingsForm(form,true);
  }
  if(action==='sync-wecom-members'&&desktopApi){try{state.wecomDirectory=await desktopApi.syncWecomMembers();render();toast(`已同步 ${state.wecomDirectory.members.length} 位企微成员`)}catch(error){toast(error?.message||'企微成员同步失败')}}
  if(action==='check-wecom-bot'&&desktopApi){try{const result=await desktopApi.getWecomBotStatus();state.settings.wecomBotStatus=result.status;state.settings.wecomBotLastTextFrameAt=result.lastTextFrameAt;state.settings.wecomBotLastTextFrameStatus=result.lastTextFrameStatus;state.settings.wecomRecentInbound=result.recentInbound||[];render();toast(`企微机器人：${result.status}`)}catch(error){toast(error?.message||'无法检查机器人状态')}}
  if(action==='settings-section'&&['model','agent','connectors'].includes(id)){
    state.settingsSection=id;
    root.querySelectorAll('[data-settings-section]').forEach(section=>{section.hidden=section.dataset.settingsSection!==id});
    root.querySelectorAll('.settings-jump button').forEach(button=>{if(button.dataset.id===id)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current')});
    const form=document.getElementById('settings-form');if(form)form.scrollTop=0;
  }
  if(action==='open-model-portal'){
    const provider=root.querySelector('#settings-form [name="provider"]')?.value;
    if(!modelProviderPortals[provider]){toast('当前提供方没有统一的开放平台入口');return}
    try{
      if(desktopApi)await desktopApi.openModelPortal(provider);
      else window.open(modelProviderPortals[provider],'_blank','noopener,noreferrer');
    }catch(error){toast(error?.message||'无法打开官网')}
  }
  if(action==='open-workbuddy-portal'){
    try{
      if(desktopApi)await desktopApi.openWorkBuddyPortal();
      else window.open('https://open.workbuddy.cn/settings/developer','_blank','noopener,noreferrer');
    }catch(error){toast(error?.message||'无法打开 WorkBuddy 开放平台')}
  }
  if(action==='test-connection'&&desktopApi){
    el.disabled=true;el.textContent='测试中…';
    try{
      const result=await desktopApi.testConnection(id);
      state.settings=await desktopApi.getSettings();
      state.agentStatus=await desktopApi.getAgentStatus();
      render();toast(result.message);
    }catch(error){render();toast(error?.message||'测试连接失败')}
  }
  if(action==='close-settings'){if(state.settingsBeforeCapability)state.settings=state.settingsBeforeCapability;state.settingsBeforeCapability=null;state.settingsPanel=false;render()}
  if(action==='close-memory'){state.memoryPanel=false;state.memoryDraft=null;render()}
  if(action==='memory-scope'){if(state.memoryDraft?.id&&id!==state.memoryScope){toast('编辑时不能更改记忆范围');return}state.memoryScope=id==='team'?'team':'personal';render()}
  if(action==='new-memory'){state.memoryDraft={title:'',content:'',category:'其他',tags:'',workspace:state.memoryWorkspace||state.workspace};render();document.querySelector('[data-memory-field="title"]')?.focus()}
  if(action==='edit-memory'){
    const item=state.memories[el.dataset.scope]?.find(entry=>entry.id===id);
    if(item){state.memoryScope=el.dataset.scope;state.memoryDraft={...item,tags:(item.tags||[]).join(', '),workspace:state.memoryWorkspace||state.workspace};render();document.querySelector('[data-memory-field="title"]')?.focus()}
  }
  if(action==='cancel-memory-draft'){state.memoryDraft=null;render()}
  if(action==='extract-memory') await extractTaskMemory();
  if(action==='archive-memory'){
    try{
      if(desktopApi){await desktopApi.archiveMemory({id,scope:el.dataset.scope});await refreshMemories()}
      else state.memories[el.dataset.scope]=state.memories[el.dataset.scope].filter(item=>item.id!==id);
      render();toast('已移出长期记忆');
    }catch(error){toast(error?.message||'移出记忆失败')}
  }
  if(action==='cycle-status'){state.feedbackStatus=state.feedbackStatus==='处理中'?'已解决':'处理中';toast('反馈状态已更新')}
  if(action==='toggle-channel-update'){state.channelUpdateApplied=!state.channelUpdateApplied;render();toast(state.channelUpdateApplied?'已重新应用来自飞书的进展':'已撤销自动更新，原消息仍保留')}
  if(action==='search'){state.quickPanel='search';state.searchQuery='';render();document.getElementById('global-search-input')?.focus()}
});

root.addEventListener('input',event=>{
  if(event.target.name==='recipientUserId'&&state.wecomSendTarget)state.wecomRecipientDraft=event.target.value;
  const field=event.target.dataset.memoryField;
  if(field&&state.memoryDraft) state.memoryDraft[field]=event.target.value;
  if(event.target.matches('.composer textarea')){
    state.composerDrafts[event.target.id]=event.target.value;
    if(event.target.id==='thread-input'){
      const cursor=event.target.selectionStart;
      const match=event.target.value.slice(0,cursor).match(/(?:^|\s)@([^\s@]*)$/u);
      const nextOpen=Boolean(match);
      const query=match?.[1]||'';
      state.mentionCursor=cursor;
      if(nextOpen!==state.mentionMenu||nextOpen&&query!==state.mentionQuery){
        state.mentionMenu=nextOpen;state.mentionQuery=query;render();
        const next=document.getElementById('thread-input');next?.focus();next?.setSelectionRange(cursor,cursor);
      }
    }
  }
  if(event.target.id==='global-search-input'){
    const position=event.target.selectionStart;
    state.searchQuery=event.target.value;render();
    const search=document.getElementById('global-search-input');search?.focus();try{search?.setSelectionRange(position,position)}catch{}
  }
  if(event.target.id==='doc-search'){
    const position=event.target.selectionStart;
    state.docSearch=event.target.value;
    render();
    const search=document.getElementById('doc-search');
    search?.focus();
    try{search?.setSelectionRange(position,position)}catch{}
  }
});

root.addEventListener('change',async event=>{
  if(event.target.dataset.memberRole){await updateProjectMemberRole(event.target.dataset.memberRole,event.target.value);return}
  if(event.target.id==='browser-doc-upload'){
    const files=[...event.target.files];
    const allowed=/\.(pdf|docx?|txt|md|csv|xlsx?|pptx?)$/i;
    if(files.some(file=>!allowed.test(file.name)||file.size>25*1024*1024)||files.length>10){toast('一次最多上传 10 份文档，每份不超过 25 MB');return}
    const targetWorkspace=state.uploadTargetWorkspace||state.workspace;
    for(const file of files){state.documents.unshift({id:`demo-${Date.now()}-${Math.random()}`,workspaceId:activeWorkspaceId(targetWorkspace),name:file.name,size:file.size,category:'其他',tags:[],status:'active',createdAt:new Date().toISOString(),blobUrl:URL.createObjectURL(file)})}
    if(files.length)state.recentAttachment={name:files.length===1?files[0].name:`${files.length} 份文件`,workspace:targetWorkspace};
    render();if(files.length)toast(`已添加到${targetWorkspace}演示资料`);
    return;
  }
  const field=event.target.dataset.memoryField;
  if(field&&state.memoryDraft) state.memoryDraft[field]=event.target.value;
  if(event.target.name==='agentMode'){
    const external=root.querySelector('.settings-external');
    if(external) external.hidden=event.target.value!=='external';
    const codebuddy=root.querySelector('.settings-codebuddy');
    if(codebuddy) codebuddy.hidden=event.target.value!=='codebuddy';
    const localAgent=root.querySelector('.settings-local-agent');
    if(localAgent) localAgent.hidden=!['codex','kimi'].includes(event.target.value);
    const workbuddy=root.querySelector('.settings-workbuddy');
    if(workbuddy) workbuddy.hidden=event.target.value!=='workbuddy';
  }
  if(event.target.name==='provider'){
    const provider=event.target.value;
    const previous=event.target.dataset.currentProvider;
    const base=root.querySelector('[name="baseUrl"]');
    const modelId=root.querySelector('[name="modelId"]');
    state.modelDraftProfiles ||= {...(state.settings.modelProfiles||{}),[state.settings.model.provider]:state.settings.model};
    if(previous && base && modelId)state.modelDraftProfiles[previous]={provider:previous,modelId:modelId.value,baseUrl:base.value};
    const next=state.modelDraftProfiles[provider]||modelProviderDefaults[provider];
    if(base)base.value=next.baseUrl;
    if(modelId)modelId.value=next.modelId;
    event.target.dataset.currentProvider=provider;
    const key=root.querySelector('[name="modelKey"]');
    const hasKey=Boolean(state.settings.hasModelKeys?.[provider]);
    if(key){key.value='';key.placeholder=hasKey?'已安全保存；留空则保持原值':desktopApi?'仅在这台 Mac 上保存':'请在 macOS 应用中配置'}
    const keyStatus=root.querySelector('[data-model-key-status]');
    if(keyStatus)keyStatus.textContent=`当前提供方${hasKey?'的密钥已保存，界面不会显示原文。':'尚未配置密钥。'}${desktopApi&&state.settings.secretStorageAvailable?' 保存时由 macOS 安全存储加密。':''}`;
    const clearKey=root.querySelector('[data-clear-model-key]');
    if(clearKey){clearKey.hidden=!hasKey;clearKey.querySelector('input').checked=false}
    const login=root.querySelector('#settings-model .provider-login');
    if(login){login.hidden=!modelProviderNames[provider];login.querySelector('button').innerHTML=`${icon('external')}管理 ${safe(modelProviderNames[provider]||'')} API Key`;login.querySelector('[data-provider-portal-hint]').textContent=`登录 ${modelProviderNames[provider]||''} 开放平台后取得 API Key，保存并测试连接。网页或客户端登录不会自动授权共作调用 API。`}
  }
});

root.addEventListener('submit',event=>{
  if(event.target.id==='project-space-form'){event.preventDefault();saveProjectWorkspace(event.target)}
  if(event.target.id==='project-member-form'){event.preventDefault();saveProjectMember(event.target)}
  if(event.target.id==='project-wecom-member-form'){event.preventDefault();linkWecomMember(event.target)}
  if(event.target.id==='assign-task-form'){event.preventDefault();const memberId=new FormData(event.target).get('memberId');desktopApi.assignTask({taskId:state.task,memberId}).then(result=>{render();toast(result.status==='sent'?'企微接口已接受指派通知，请确认送达':result.detail||'发送结果未知')}).catch(error=>toast(error?.message||'指派失败'))}
  if(event.target.id==='memory-form'){event.preventDefault();saveMemoryDraft()}
  if(event.target.id==='settings-form'){event.preventDefault();saveSettingsForm(event.target)}
  if(event.target.id==='wecom-send-form'){event.preventDefault();submitWecomForm(event.target)}
  if(event.target.id==='document-form'){event.preventDefault();saveDocumentDraft(event.target)}
  if(event.target.id==='mini-feedback-form'){
    event.preventDefault();const values=new FormData(event.target);
    state.demoFeedback.unshift({content:String(values.get('content')||'').trim(),source:String(values.get('source')||'其他')});
    state.miniFormOpen=false;render();toast('已添加到当前演示，刷新后不会保留');
  }
});

root.addEventListener('keydown',(event)=>{
  if(event.key==='Enter'&&!event.shiftKey&&event.target.id==='thread-input'&&state.mentionMenu){event.preventDefault();const first=root.querySelector('.mention-picker>button:not(:disabled)');if(first)first.click();else{state.mentionMenu=false;render()}return}
  if(event.key==='Enter'&&!event.shiftKey&&event.target.matches('.composer textarea')){event.preventDefault();const input=event.target;const button=input.closest('.composer')?.querySelector('[data-action="submit"]');button?.click()}
  if(event.key==='Escape'&&state.wecomSendTarget){state.wecomSendTarget=null;state.wecomSendError='';render()}
  else if(event.key==='Escape'&&state.memoryPanel){state.memoryPanel=false;state.memoryDraft=null;render()}
  else if(event.key==='Escape'&&state.settingsPanel){if(state.settingsBeforeCapability)state.settings=state.settingsBeforeCapability;state.settingsBeforeCapability=null;state.settingsPanel=false;render()}
  else if(event.key==='Escape'&&state.docEditing){state.docEditing=null;state.docDraft=null;render()}
  else if(event.key==='Escape'&&state.memberPanel){state.memberPanel=false;render()}
  else if(event.key==='Escape'&&state.projectDialog){state.projectDialog=false;render()}
  else if(event.key==='Escape'&&state.quickPanel){state.quickPanel=null;render()}
  else if(event.key==='Escape'&&state.capabilityPanel){state.capabilityPanel=false;state.capabilityDetail=null;render()}
  else if(event.key==='Escape'&&state.mentionMenu){state.mentionMenu=false;render();document.getElementById('thread-input')?.focus()}
  else if(event.key==='Escape'&&state.composerSpaceMenu){state.composerSpaceMenu=false;render()}
  else if(event.key==='Escape'&&state.homeCustomize){state.homeCustomize=false;render()}
});

async function bootstrapDesktop(){
  if(!desktopApi) return;
  document.body.classList.add('desktop-runtime');
  try{
    const payload=await desktopApi.bootstrap();
    applyDesktopData(payload.data);
    state.agentStatus=payload.agent;
    state.settings=await desktopApi.getSettings();
    await refreshMemories();
    await refreshDocuments();
    desktopApi.onDataChanged(data=>{applyDesktopData(data);render()});
    desktopApi.onOpenTask(id=>openTask(id));
    render();
    if(payload.taskLink)openTask(payload.taskLink);
  }catch(error){
    state.agentStatus={label:'本地数据不可用',modelConnected:false};
    toast(error?.message||'桌面数据初始化失败');
  }
}

render();
bootstrapDesktop();
