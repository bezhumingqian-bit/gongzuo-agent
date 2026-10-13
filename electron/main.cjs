const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, shell } = require('electron');
const path = require('node:path');
const crypto = require('node:crypto');
const { JsonStore } = require('./store.cjs');
const { createSeed } = require('./seed.cjs');
const { AgentService } = require('./agent-service.cjs');
const { actors, classifyChannelEvent } = require('./contracts/policy.cjs');
const { channelIngestEvent, hasChannelEvent, recordChannelEvent } = require('./contracts/source-event.cjs');
const { WorkOperations } = require('./contracts/work-operations.cjs');
const { memorySeed, createMemory, extractCandidate } = require('./memory-service.cjs');
const { SettingsService } = require('./settings-service.cjs');
const { testConnection } = require('./connection-service.cjs');
const { readWorkBuddyReply } = require('./workbuddy-service.cjs');
const { modelPortalUrl, WORKBUDDY_PORTAL } = require('./provider-links.cjs');
const { DocumentService } = require('./document-service.cjs');
const { createProjectWorkspace, addProjectMember, linkWecomProjectMember, removePendingProjectMember, updatePendingProjectMemberRole, migrateLegacyWorkspaceMembers } = require('./workspace-service.cjs');
const { TaskRunner } = require('./task-runner.cjs');
const { WecomDelivery, recipientUserId, fetchVisibleMembers, sendViaWecom } = require('./wecom-service.cjs');
const { WecomBotBridge } = require('./wecom-bot-service.cjs');
const { WorkBuddyBridge } = require('./workbuddy-bridge.cjs');

let mainWindow;
let store;
let personalMemoryStore;
let teamMemoryStore;
let settingsService;
let documentService;
let taskRunner;
let wecomDelivery;
let wecomBot;
let workbuddyBridge;
let workOps;
let pendingTaskLink = null;
const agent = new AgentService();

function assertString(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new Error(`${name} 无效`);
  }
  return value.trim();
}

function isTrustedSender(event) {
  return Boolean(mainWindow && event.sender === mainWindow.webContents && !event.senderFrame?.url.startsWith('http'));
}

function publishData(data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('data:changed', data);
}

function registerIpc() {
  ipcMain.handle('documents:list', async event => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    return documentService.list();
  });

  ipcMain.handle('documents:upload', async (event, workspaceId) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const id = assertString(workspaceId, '工作空间 ID', 80);
    const data = await store.read();
    if (!data.workspaces.some(item => item.id === id)) throw new Error('工作空间不存在');
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: `上传到${data.workspaces.find(item => item.id === id).name}`,
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '文档', extensions: ['pdf', 'docx', 'doc', 'txt', 'md', 'csv', 'xlsx', 'xls', 'pptx', 'ppt'] }]
    });
    if (selection.canceled || !selection.filePaths.length) return [];
    return documentService.upload(id, selection.filePaths);
  });

  ipcMain.handle('documents:update', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    return documentService.update(assertString(input.id, '资料 ID', 100), input);
  });

  ipcMain.handle('documents:archive', async (event, id) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    return documentService.setArchived(assertString(id, '资料 ID', 100), true);
  });

  ipcMain.handle('documents:restore', async (event, id) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    return documentService.setArchived(assertString(id, '资料 ID', 100), false);
  });

  ipcMain.handle('documents:open', async (event, id) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const filePath = await documentService.getFilePath(assertString(id, '资料 ID', 100));
    const error = await shell.openPath(filePath);
    if (error) throw new Error(`无法打开资料：${error}`);
    return true;
  });

  ipcMain.handle('settings:get', async event => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const data = await store.read();
    return { ...await settingsService.getPublic(), workbuddyBridge: workbuddyBridge?.status || { listening: false, lastClientAt: null }, wecomBotStatus: wecomBot?.status || '未配置', wecomBotLastTextFrameAt: wecomBot?.lastTextFrameAt || null, wecomBotLastTextFrameStatus: wecomBot?.lastTextFrameStatus || '尚未收到', wecomRecentInbound: (data.wecomEvents || []).slice(-5).reverse().map(({ userId, chatType, at }) => ({ userId, chatType, at })) };
  });

  ipcMain.handle('settings:save', async (event, input) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const result = await settingsService.save(input);
    await wecomBot.restart();
    return { ...result, wecomBotStatus: wecomBot.status };
  });

  ipcMain.handle('integrations:test', async (event, kind) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    if (!['model', 'agent', 'wecom'].includes(kind)) throw new Error('连接类型无效');
    const config = await settingsService.getRuntimeConfig();
    let result;
    if (kind === 'agent' && config.agent?.mode === 'workbuddy' && !config.workbuddyAccessToken) {
      const bridge = workbuddyBridge?.status;
      result = !bridge?.listening
        ? { ok: false, message: '共作本机连接未启动，请重启共作' }
        : bridge.lastClientAt
          ? { ok: true, message: `WorkBuddy 已通过本机连接器访问共作（最近一次 ${bridge.lastClientAt.slice(0, 19).replace('T', ' ')} UTC）` }
          : { ok: false, message: '本机连接已就绪，但 WorkBuddy 尚未调用；请在 WorkBuddy 中信任「gongzuo」连接器后让它查看共作待处理工作' };
      await settingsService.recordCheck(kind, result);
      return result;
    }
    try { result = await testConnection(kind, config); }
    catch (error) { result = { ok: false, message: error.message }; }
    await settingsService.recordCheck(kind, result);
    return result;
  });

  ipcMain.handle('integrations:open-model-portal', async (event, provider) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    await shell.openExternal(modelPortalUrl(provider));
    return true;
  });

  ipcMain.handle('integrations:open-workbuddy-portal', async event => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    await shell.openExternal(WORKBUDDY_PORTAL);
    return true;
  });

  ipcMain.handle('wecom:send-task-message', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    return wecomDelivery.sendTaskMessage(
      assertString(input.taskId, '任务 ID', 100),
      assertString(input.messageId, '消息 ID', 100),
      assertString(input.recipientUserId, '企业微信成员 UserID', 64)
    );
  });

  ipcMain.handle('wecom:send-draft', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const text = assertString(input.text, '企微消息');
    if (Buffer.byteLength(text, 'utf8') > 2048) throw new Error('企微消息不能超过 2048 字节');
    const recipient = recipientUserId(input.recipientUserId);
    const current = await store.read();
    const taskId = input.taskId == null ? null : assertString(input.taskId, '任务 ID', 100);
    const workspace = current.workspaces.some(item => item.name === input.workspace) ? input.workspace : current.activeWorkspace;
    const message = await taskRunner.recordOutbound(text, workspace, taskId);
    const actualTaskId = message.taskId;
    const delivery = await wecomDelivery.sendTaskMessage(actualTaskId, message.id, recipient);
    const task = (await store.read()).tasks.find(item => item.id === actualTaskId);
    return { taskId: actualTaskId, messageId: message.id, delivery, task };
  });

  ipcMain.handle('wecom:sync-members', async event => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const members = await fetchVisibleMembers(await settingsService.getRuntimeConfig());
    const data = await store.update(draft => { draft.wecomDirectory = { members, syncedAt: new Date().toISOString() }; return draft; });
    publishData(data);
    return { members, syncedAt: data.wecomDirectory.syncedAt };
  });

  ipcMain.handle('wecom:bot-status', async event => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const data = await store.read();
    return { status: wecomBot.status, lastTextFrameAt: wecomBot.lastTextFrameAt, lastTextFrameStatus: wecomBot.lastTextFrameStatus, recentInbound: (data.wecomEvents || []).slice(-5).reverse().map(({ userId, chatType, at }) => ({ userId, chatType, at })) };
  });

  ipcMain.handle('app:bootstrap', async event => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const [data, settings] = await Promise.all([store.read(), settingsService.getPublic()]);
    const taskLink = pendingTaskLink;
    pendingTaskLink = null;
    return { data, agent: agent.getStatus(settings), platform: process.platform, version: app.getVersion(), taskLink };
  });

  ipcMain.handle('agent:status', async event => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    return agent.getStatus(await settingsService.getPublic());
  });

  ipcMain.handle('tasks:create', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const goal = assertString(input.goal, '工作目标');
    const current = await store.read();
    const workspace = current.workspaces.some(item => item.name === input.workspace) ? input.workspace : current.activeWorkspace;
    return workOps.create(actors.local(), { workspace, goal, documentIds: input.documentIds || [] });
  });

  ipcMain.handle('tasks:append-message', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const taskId = assertString(input.taskId, '任务 ID', 100);
    const text = assertString(input.text, '消息');
    const { message } = await workOps.append(actors.local(), taskId, text, { mentions: input.mentions || [], documentIds: input.documentIds || [] });
    if (message.mentions?.length) await wecomDelivery.sendMentions(taskId, message.id);
    return (await store.read()).tasks.find(item => item.id === taskId)?.messages.find(item => item.id === message.id) || message;
  });

  ipcMain.handle('tasks:assign', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    return wecomDelivery.assignTask(assertString(input.taskId, '工作 ID', 100), assertString(input.memberId, '成员 ID', 100));
  });

  ipcMain.handle('tasks:retry-agent', async (event, taskId) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    return taskRunner.retry(assertString(taskId, '任务 ID', 100));
  });

  ipcMain.handle('tasks:set-agent', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    return taskRunner.setAgent(assertString(input.taskId, '任务 ID', 100), assertString(input.mode, 'Agent 类型', 40));
  });

  ipcMain.handle('tasks:sync-workbuddy-reply', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const id = assertString(input.taskId, '任务 ID', 100);
    const messageId = assertString(input.messageId, '消息 ID', 100);
    const existing = (await store.read()).tasks.find(item => item.id === id);
    const pending = existing?.messages?.find(item => item.id === messageId && item.source === 'workbuddy-pending' && item.externalMessageId);
    if (!pending) throw new Error('此工作没有待取回的 WorkBuddy 回复');
    const reply = await readWorkBuddyReply(await settingsService.getRuntimeConfig(), pending.externalMessageId);
    if (!reply) return { ready: false };
    const data = await store.update(draft => {
      const item = draft.tasks.find(task => task.id === id)?.messages.find(message => message.id === pending.id);
      if (item && item.source === 'workbuddy-pending') {
        item.text = reply.slice(0, 50000);
        item.source = 'workbuddy';
        const task = draft.tasks.find(task => task.id === id);
        if (task?.workflow) { task.status = 'review'; task.needsMe = true; }
      }
      return draft;
    });
    publishData(data);
    return { ready: true };
  });

  ipcMain.handle('workspace:set-active', async (event, name) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const workspaceName = assertString(name, '工作空间', 80);
    const data = await store.update(draft => {
      if (!draft.workspaces.some(item => item.name === workspaceName)) throw new Error('工作空间不存在');
      draft.activeWorkspace = workspaceName;
      return draft;
    });
    publishData(data);
    return data.activeWorkspace;
  });

  ipcMain.handle('workspace:create-project', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const data = await store.update(draft => {
      createProjectWorkspace(draft, input);
      return draft;
    });
    publishData(data);
    return data;
  });

  ipcMain.handle('workspace:add-member', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const data = await store.update(draft => {
      addProjectMember(draft, input);
      return draft;
    });
    publishData(data);
    return data;
  });

  ipcMain.handle('workspace:link-wecom-member', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const data = await store.update(draft => { linkWecomProjectMember(draft, input); return draft; });
    publishData(data);
    return data;
  });

  ipcMain.handle('workspace:remove-pending-member', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const data = await store.update(draft => {
      removePendingProjectMember(draft, input);
      return draft;
    });
    publishData(data);
    return data;
  });

  ipcMain.handle('workspace:update-pending-role', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const data = await store.update(draft => {
      updatePendingProjectMemberRole(draft, input);
      return draft;
    });
    publishData(data);
    return data;
  });

  ipcMain.handle('memory:list', async event => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const [personal, team] = await Promise.all([personalMemoryStore.read(), teamMemoryStore.read()]);
    return { personal: personal.items.filter(item => item.status === 'active'), team: team.items.filter(item => item.status === 'active') };
  });

  ipcMain.handle('memory:extract', async (event, taskId) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const id = assertString(taskId, '任务 ID', 100);
    const data = await store.read();
    const task = data.tasks.find(item => item.id === id);
    if (!task) throw new Error('任务不存在');
    return extractCandidate(task);
  });

  ipcMain.handle('memory:save', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const data = await store.read();
    const scope = input.scope === 'team' ? 'team' : input.scope === 'personal' ? 'personal' : null;
    if (!scope) throw new Error('记忆范围无效');
    const sourceTaskId = input.sourceTaskId ? assertString(input.sourceTaskId, '任务 ID', 100) : null;
    const task = sourceTaskId ? data.tasks.find(item => item.id === sourceTaskId) : null;
    if (sourceTaskId && !task) throw new Error('来源任务不存在');
    const workspace = task?.workspace || assertString(input.workspace || data.activeWorkspace, '工作空间', 80);
    const workspaceEntry = data.workspaces.find(item => item.name === workspace);
    if (scope === 'team' && !workspaceEntry) throw new Error('工作空间不存在');
    const memory = createMemory(input, {
      scope,
      workspaceId: scope === 'team' ? workspaceEntry.id : null,
      sourceTaskId,
      sourceExcerpt: task ? extractCandidate(task).sourceExcerpt : null
    });
    const target = scope === 'personal' ? personalMemoryStore : teamMemoryStore;
    await target.update(draft => {
      draft.items.unshift(memory);
      return draft;
    });
    return memory;
  });

  ipcMain.handle('memory:archive', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const id = assertString(input.id, '记忆 ID', 100);
    const scope = input.scope === 'team' ? 'team' : input.scope === 'personal' ? 'personal' : null;
    if (!scope) throw new Error('记忆范围无效');
    const target = scope === 'personal' ? personalMemoryStore : teamMemoryStore;
    let archived = false;
    await target.update(draft => {
      const item = draft.items.find(entry => entry.id === id && entry.scope === scope);
      if (!item) throw new Error('记忆不存在');
      item.status = 'archived';
      item.updatedAt = new Date().toISOString();
      archived = true;
      return draft;
    });
    return archived;
  });

  ipcMain.handle('memory:update', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const id = assertString(input.id, '记忆 ID', 100);
    const scope = input.scope === 'team' ? 'team' : input.scope === 'personal' ? 'personal' : null;
    if (!scope) throw new Error('记忆范围无效');
    const target = scope === 'personal' ? personalMemoryStore : teamMemoryStore;
    let updated;
    await target.update(draft => {
      const item = draft.items.find(entry => entry.id === id && entry.scope === scope && entry.status === 'active');
      if (!item) throw new Error('记忆不存在');
      const next = createMemory(input, { scope, workspaceId: item.workspaceId });
      item.revisions ||= [];
      item.revisions.push({
        title: item.title,
        content: item.content,
        category: item.category,
        tags: item.tags,
        updatedAt: item.updatedAt
      });
      Object.assign(item, {
        title: next.title,
        content: next.content,
        category: next.category,
        tags: next.tags,
        updatedAt: new Date().toISOString()
      });
      updated = item;
      return draft;
    });
    return updated;
  });

  ipcMain.handle('channel:ingest', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const { event: sourceEvent, taskId } = channelIngestEvent(input, () => crypto.randomUUID());
    const decision = classifyChannelEvent(sourceEvent);
    const data = await store.update(draft => {
      // Order kept from before: a replayed event is a no-op even if its task is gone.
      if (hasChannelEvent(draft, sourceEvent)) return draft;
      const task = draft.tasks.find(item => item.id === taskId);
      if (!task) throw new Error('任务不存在');
      recordChannelEvent(draft, sourceEvent, taskId, decision, crypto.randomUUID());
      task.updatedAt = new Date().toISOString();
      if (decision.action === 'auto-update') task.progressConfirmed = true;
      if (decision.action === 'suggest') task.needsMe = true;
      return draft;
    });
    publishData(data);
    return decision;
  });
}

function createMenu() {
  const template = [
    {
      label: '共作',
      submenu: [
        { role: 'about', label: '关于共作' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏共作' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出共作' }
      ]
    },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#e8ebef',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 19 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, '..', 'demo', 'index.html'));
}

function handleTaskLink(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'gongzuo:' || url.hostname !== 'task') return;
    const id = decodeURIComponent(url.pathname.slice(1));
    if (!/^[A-Za-z0-9-]{4,100}$/.test(id)) return;
    pendingTaskLink = id;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.webContents.isLoading()) return;
      mainWindow.show(); mainWindow.focus();
      mainWindow.webContents.send('app:open-task', id);
      pendingTaskLink = null;
    }
  } catch {}
}

app.on('open-url', (event, url) => { event.preventDefault(); handleTaskLink(url); });
app.on('second-instance', (_event, argv) => { const link = argv.find(arg => arg.startsWith('gongzuo://')); if (link) handleTaskLink(link); });
if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(async () => {
  if (app.isPackaged) app.setAsDefaultProtocolClient('gongzuo');
  nativeTheme.themeSource = 'light';
  store = new JsonStore(path.join(app.getPath('userData'), 'workspace.json'), createSeed);
  personalMemoryStore = new JsonStore(path.join(app.getPath('userData'), 'personal-memory.json'), memorySeed);
  teamMemoryStore = new JsonStore(path.join(app.getPath('userData'), 'team-memory.json'), memorySeed);
  settingsService = new SettingsService(
    path.join(app.getPath('userData'), 'settings.json'),
    path.join(app.getPath('userData'), 'credentials.json'),
    safeStorage
  );
  documentService = new DocumentService(
    path.join(app.getPath('userData'), 'documents.json'),
    path.join(app.getPath('userData'), 'documents')
  );
  await Promise.all([store.initialize(), personalMemoryStore.initialize(), teamMemoryStore.initialize(), settingsService.initialize(), documentService.initialize()]);
  if ((await store.read()).workspaces?.some(space => !Array.isArray(space.members))) {
    await store.update(data => { migrateLegacyWorkspaceMembers(data); return data; });
  }
  agent.sessionsRoot = path.join(app.getPath('userData'), 'agent-sessions');
  taskRunner = new TaskRunner({ store, settingsService, personalMemoryStore, teamMemoryStore, documentService, agent, publish: publishData });
  workOps = new WorkOperations({ store, taskRunner });
  wecomBot = new WecomBotBridge({ store, settingsService, taskRunner, ops: workOps, publish: publishData });
  wecomDelivery = new WecomDelivery({ store, settingsService, publish: publishData, send: (config, userId, text) => sendViaWecom(config, userId, text, wecomBot) });
  taskRunner.onAgentAnswer = event => wecomBot.sendAgentAnswer(event);
  workbuddyBridge = new WorkBuddyBridge({ userDataDir: app.getPath('userData'), store, taskRunner, ops: workOps, version: app.getVersion() });
  await taskRunner.markInterrupted();
  await wecomDelivery.markInterrupted();
  registerIpc();
  try { await workbuddyBridge.start(); }
  catch (error) { console.error('WorkBuddy 本机连接启动失败：', error.message); }
  await wecomBot.restart();
  createMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => { wecomBot?.stop(); workbuddyBridge?.stop().catch(() => {}); });
