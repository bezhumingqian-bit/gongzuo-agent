const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const { configureRuntimeChannel, linkScheme } = require('./runtime-channel.cjs');
// Set paths before the single-instance lock is acquired. Packaged previews
// share the existing development data, not the old production app's data.
const runtimeChannel = configureRuntimeChannel(app, require('../package.json'));
const { JsonStore } = require('./store.cjs');
const { createSeed } = require('./seed.cjs');
const { AgentService } = require('./agent-service.cjs');
const { actors, classifyChannelEvent } = require('./contracts/policy.cjs');
const { channelIngestEvent, hasChannelEvent, recordChannelEvent } = require('./contracts/source-event.cjs');
const { WorkOperations } = require('./contracts/work-operations.cjs');
const { memorySeed, createMemory, extractCandidate } = require('./memory-service.cjs');
const { SettingsService } = require('./settings-service.cjs');
const { testConnection } = require('./connection-service.cjs');
const { ConnectionStatusService } = require('./connection-status.cjs');
const connectionStatusService = new ConnectionStatusService();
const { readWorkBuddyReply, releaseWorkBuddyMessage, hasLocalAssistantOperations, withLocalAssistantConfiguration } = require('./workbuddy-service.cjs');
const { modelPortalUrl, WORKBUDDY_PORTAL } = require('./provider-links.cjs');
const { DocumentService } = require('./document-service.cjs');
const { createProjectWorkspace, addProjectMember, linkWecomProjectMember, linkFeishuProjectMember, decideJoinRequest, removePendingProjectMember, updatePendingProjectMemberRole, migrateLegacyWorkspaceMembers, ensurePersonalWorkspace, personalWorkspace } = require('./workspace-service.cjs');
const { TaskRunner } = require('./task-runner.cjs');
const { WecomDelivery, recipientUserId, fetchVisibleMembers, sendViaWecom } = require('./wecom-service.cjs');
const { WecomBotBridge } = require('./wecom-bot-service.cjs');
const { WorkBuddyBridge } = require('./workbuddy-bridge.cjs');
const { WorkBuddyRelayAuth } = require('./workbuddy-relay-client.cjs');
const { notifyMember, reachability, botContacts } = require('./channel-router.cjs');

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
let workbuddyAuth;
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
  return Boolean(mainWindow && event.sender === mainWindow.webContents && event.senderFrame && event.senderFrame === mainWindow.webContents.mainFrame && event.senderFrame.url === pathToFileURL(path.join(__dirname, '..', 'demo', 'index.html')).href);
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
      filters: [{ name: '文档', extensions: ['pdf', 'docx', 'doc', 'txt', 'md', 'csv', 'xlsx', 'xls', 'pptx', 'ppt', 'html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'webp'] }]
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

  ipcMain.handle('documents:preview', async (event, input = {}) => {
    const trustedUrl = pathToFileURL(path.join(__dirname, '..', 'demo', 'index.html')).href;
    if (!isTrustedSender(event) || !event.senderFrame || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== trustedUrl) throw new Error('不受信任的请求');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('预览请求无效');
    const taskId = assertString(input.taskId, '工作 ID', 100);
    const id = assertString(input.id, '资料 ID', 100);
    const data = await store.read();
    const task = data.tasks.find(item => item.id === taskId);
    if (!task) throw new Error('工作不存在');
    await workOps.view(actors.local(), task.id);
    if (!task.messages?.some(message => Array.isArray(message.artifacts) && message.artifacts.some(artifact => artifact?.id === id))) throw new Error('资料不属于这项工作的成果');
    const names = new Set([task.workspace, ...(Array.isArray(task.relatedWorkspaces) ? task.relatedWorkspaces : [])]);
    const allowedWorkspaceIds = data.workspaces.filter(space => names.has(space.name) || ['personal', 'public'].includes(space.type)).map(space => space.id);
    return documentService.preview(id, allowedWorkspaceIds);
  });

  ipcMain.handle('documents:open', async (event, id) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const filePath = await documentService.getFilePath(assertString(id, '资料 ID', 100));
    if (/\.html?$/i.test(filePath)) {
      const confirmation = await dialog.showMessageBox(mainWindow, { type: 'warning', title: '在本机浏览器打开生成的页面？', message: '本机浏览器不使用共作的隔离预览', detail: '页面脚本可能联网或跳转。只打开你信任的成果；如只需查看，请留在右侧预览。', buttons: ['取消', '信任并打开'], defaultId: 0, cancelId: 0 });
      if (confirmation.response !== 1) return false;
    }
    const error = await shell.openPath(filePath);
    if (error) throw new Error(`无法打开资料：${error}`);
    return true;
  });

  ipcMain.handle('settings:get', async event => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const data = await store.read();
    const runtime = await settingsService.getRuntimeConfig();
    const memberReach = {};
    const contacts = botContacts(data);
    for (const space of data.workspaces || []) for (const member of space.members || []) memberReach[member.id] = reachability(member, runtime, wecomBot, contacts);
    return { ...await settingsService.getPublic(), memberReach, workbuddyAuth: await workbuddyAuth.status(), workbuddyBridge: workbuddyBridge?.status || { listening: false, lastClientAt: null }, wecomBotStatus: wecomBot?.status || '未配置', wecomBotLastTextFrameAt: wecomBot?.lastTextFrameAt || null, wecomBotLastTextFrameStatus: wecomBot?.lastTextFrameStatus || '尚未收到', wecomRecentInbound: (data.wecomEvents || []).slice(-5).reverse().map(({ userId, chatType, at }) => ({ userId, chatType, at })) };
  });

  ipcMain.handle('settings:save', async (event, input) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    return withLocalAssistantConfiguration(async () => {
    const pendingRelay = hasLocalAssistantOperations() || (await store.read()).tasks.some(task => (task.agentMode === 'workbuddy' && ['queued','running'].includes(task.agentRun?.status)) || task.messages?.some(m => m.source === 'workbuddy-pending' && m.via === 'localassistant-relay'));
    if (hasLocalAssistantOperations() && input?.agent?.workbuddyTransport && input.agent.workbuddyTransport !== 'localassistant') throw new Error('本地助理仍在发送或读取，请稍后再切换连接方式');
    if (pendingRelay && input?.agent?.workbuddyRelayUrl != null && input.agent.workbuddyRelayUrl.replace(/\/$/, '') !== await settingsService.getWorkbuddyRelayUrl()) throw new Error('还有本地助理任务在监听，请先核对并结束监听，再改授权服务地址');
    const result = await settingsService.save(input);
    await wecomBot.restart('settings-save');
    return { ...result, wecomBotStatus: wecomBot.status };
    });
  });

  ipcMain.handle('integrations:status', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const allowed = ['model','agent','wecom','feishu','wecom-bot'];
    if (!Array.isArray(input.kinds) || input.kinds.length > allowed.length || input.kinds.some(kind => !allowed.includes(kind))) throw new Error('连接类型无效');
    const config = await settingsService.getRuntimeConfig();
    const values = await Promise.all([...new Set(input.kinds)].map(async kind => [kind, await connectionStatusService.get(kind, config, { bridge: workbuddyBridge, bot: wecomBot, force: input.force === true })]));
    return { statuses: Object.fromEntries(values), configurationRevision: config.configurationRevision };
  });

  ipcMain.handle('integrations:reconnect', async (event, kind) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    if (!['model','agent','wecom','feishu','wecom-bot'].includes(kind)) throw new Error('连接类型无效');
    // Explicit recovery only. Never resend a task, create a sandbox, invoke a
    // model, alter a credential, or open OAuth during an automatic status check.
    if (kind === 'wecom-bot' && !['已连接','连接中','重连中'].includes(wecomBot.status)) await wecomBot.restart('user-reconnect');
    if (kind === 'agent') {
      const config = await settingsService.getRuntimeConfig();
      if (config.agent?.mode === 'workbuddy' && require('./workbuddy-transport.cjs').transportOf(config) === 'handoff' && !workbuddyBridge?.status.listening) await workbuddyBridge.start();
    }
    const config = await settingsService.getRuntimeConfig();
    return { status: await connectionStatusService.get(kind, config, { bridge: workbuddyBridge, bot: wecomBot, force: true }), configurationRevision: config.configurationRevision };
  });

  ipcMain.handle('integrations:test', async (event, kind) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    if (!['model', 'agent', 'wecom', 'feishu'].includes(kind)) throw new Error('连接类型无效');
    const config = await settingsService.getRuntimeConfig();
    let result;
    if (kind === 'agent' && config.agent?.mode === 'workbuddy' && require('./workbuddy-transport.cjs').transportOf(config) === 'handoff') {
      const bridge = workbuddyBridge?.status;
      result = !bridge?.listening
        ? { ok: false, message: '共作本机连接未启动，请重启共作' }
        : bridge.lastClientAt
          ? { ok: true, message: `WorkBuddy 已通过本机连接器访问共作（最近一次 ${bridge.lastClientAt.slice(0, 19).replace('T', ' ')} UTC）` }
          : { ok: false, message: '本机连接已就绪，但 WorkBuddy 尚未调用；请在 WorkBuddy 中信任「gongzuo」连接器后让它查看共作待处理工作' };
      await settingsService.recordCheck(kind, result);
      return result;
    }
    if (kind === 'feishu') {
      try { result = await require('./feishu-service.cjs').checkFeishu(config); }
      catch (error) { result = { ok: false, message: error.message }; }
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

  ipcMain.handle('workbuddy:authorize', async event => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const authorizationGeneration = workbuddyAuth.abortGeneration;
    return withLocalAssistantConfiguration(async () => {
    if ((await store.read()).tasks.some(task => (task.agentMode === 'workbuddy' && ['queued','running'].includes(task.agentRun?.status)) || task.messages?.some(m => m.source === 'workbuddy-pending' && m.via === 'localassistant-relay'))) throw new Error('还有 WorkBuddy 任务在监听；核对并结束监听后再重新授权，避免原授权无法释放任务');
    const record = await workbuddyAuth.authorize({ generation: authorizationGeneration });
    await settingsService.recordCheck('agent', { ok: false, message: `已授权 WorkBuddy${record.nickname ? `：${record.nickname}` : ''}；请测试本地助理在线状态` });
    return workbuddyAuth.status();
    });
  });

  ipcMain.handle('workbuddy:cancel-authorization', async event => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    await workbuddyAuth.cancel();
    return workbuddyAuth.status();
  });

  ipcMain.handle('workbuddy:sign-out', async event => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    return withLocalAssistantConfiguration(async () => {
    if ((await store.read()).tasks.some(task => (task.agentMode === 'workbuddy' && ['queued','running'].includes(task.agentRun?.status)) || task.messages?.some(m => m.source === 'workbuddy-pending' && m.via === 'localassistant-relay'))) throw new Error('还有 WorkBuddy 任务在监听；请先核对并结束监听，再退出授权');
    await workbuddyAuth.signOut();
    return workbuddyAuth.status();
    });
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
    // New work starts in the personal space unless a space was chosen.
    const workspace = current.workspaces.some(item => item.name === input.workspace) ? input.workspace : personalWorkspace(current)?.name || current.activeWorkspace;
    const mentions = Array.isArray(input.mentions) ? input.mentions.slice(0, 10) : [];
    if (input.agentMode != null && !['built-in', 'external', 'codebuddy', 'workbuddy', 'cloudagent', 'codex', 'kimi'].includes(input.agentMode)) throw new Error('Agent 类型无效');
    const task = await workOps.create(actors.local(), { workspace, goal, documentIds: input.documentIds || [], relatedWorkspaces: Array.isArray(input.relatedWorkspaces) ? input.relatedWorkspaces.slice(0, 10) : null, options: { ...(mentions.length ? { mentions } : {}), ...(input.agentMode ? { agentMode: input.agentMode } : {}) } });
    if (task.messages?.[0]?.mentions?.length) await wecomDelivery.sendMentions(task.id, task.messages[0].id);
    return (await store.read()).tasks.find(item => item.id === task.id) || task;
  });

  ipcMain.handle('tasks:handover', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const taskId = assertString(input.taskId, '任务 ID', 100);
    const workspace = assertString(input.workspace, '工作空间', 80);
    const messageIds = Array.isArray(input.messageIds) ? input.messageIds.slice(0, 30).map(id => assertString(id, '消息 ID', 100)) : [];
    return workOps.handover(actors.local(), taskId, { workspace, messageIds });
  });

  ipcMain.handle('tasks:retrieve-cloud-files', async (event, taskId, messageId = null) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const { task } = await workOps.resolve(actors.local(), assertString(taskId, '任务 ID', 100), 'work.append');
    return taskRunner.retrieveCloudFiles(task.id, messageId == null ? null : assertString(messageId, '消息 ID', 100));
  });

  ipcMain.handle('tasks:set-conversation-shared', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    return workOps.setConversationShared(actors.local(), assertString(input.taskId, '任务 ID', 100), input.shared === true);
  });

  ipcMain.handle('settings:set-privacy', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    return settingsService.setPrivacy({ personalLocalOnly: input.personalLocalOnly === true });
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

  // 允许 / 拒绝 an action the executing Agent is waiting on (approval broker).
  ipcMain.handle('tasks:resolve-approval', async (event, taskId, approvalId, outcome) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const { task } = await workOps.resolve(actors.local(), assertString(taskId, '任务 ID', 100), 'work.append');
    if (!['allow', 'reject'].includes(outcome)) throw new Error('确认结果无效');
    return taskRunner.resolveApproval(task.id, assertString(approvalId, '确认 ID', 100), outcome);
  });

  ipcMain.handle('wecom:forward-to-members', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const taskId = assertString(input.taskId, '任务 ID', 100);
    await workOps.view(actors.local(), taskId);
    return wecomDelivery.forwardToMembers(taskId, assertString(input.messageId, '消息 ID', 100), Array.isArray(input.memberIds) ? input.memberIds.map(id => assertString(id, '成员', 100)) : []);
  });

  ipcMain.handle('progress:update', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const taskId = assertString(input.taskId, '任务 ID', 100);
    await workOps.resolve(actors.local(), taskId, 'work.append');
    return taskRunner.updateProgress(taskId, assertString(input.itemId, '进展', 100), { action: input.action, text: input.text, kind: input.kind });
  });

  ipcMain.handle('progress:publish-all', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const taskId = assertString(input.taskId, '任务 ID', 100);
    await workOps.resolve(actors.local(), taskId, 'work.append');
    return taskRunner.publishAllProgress(taskId);
  });

  ipcMain.handle('progress:add', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const taskId = assertString(input.taskId, '任务 ID', 100);
    await workOps.resolve(actors.local(), taskId, 'work.append');
    return taskRunner.addProgress(taskId, { kind: input.kind, text: input.text });
  });

  ipcMain.handle('tasks:set-related-spaces', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    if (!Array.isArray(input.workspaces) || input.workspaces.length > 10) throw new Error('关联空间格式无效');
    return workOps.setRelated(actors.local(), assertString(input.taskId, '任务 ID', 100), input.workspaces.map(name => assertString(name, '工作空间', 80)));
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
    await workOps.view(actors.local(), id);
    const config = await settingsService.getRuntimeConfig();
    if (pending.via === 'localassistant-relay' && !config.workbuddyViaRelay) throw new Error('当前不是原来的 HTTPS 本地助理连接，请恢复该连接与授权后取回');
    const reply = await readWorkBuddyReply(config, pending.externalMessageId);
    if (!reply) return { ready: false };
    const data = await store.update(draft => {
      const item = draft.tasks.find(task => task.id === id)?.messages.find(message => message.id === pending.id);
      if (item && item.source === 'workbuddy-pending') {
        item.text = reply.slice(0, 50000);
        // A local-assistant text reply is not an authoritative completion event.
        // Keep the relay lease until the user explicitly verifies the PC task.
        item.source = pending.via === 'localassistant-relay' ? 'workbuddy-pending' : 'workbuddy';
        const task = draft.tasks.find(task => task.id === id);
        if (task?.workflow) { task.status = 'review'; task.needsMe = true; }
      }
      return draft;
    });
    publishData(data);
    return { ready: true, observing: pending.via === 'localassistant-relay' };
  });

  ipcMain.handle('tasks:release-workbuddy', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    if (input.confirmed !== true) throw new Error('请先确认已在 WorkBuddy 核对执行结果');
    const id = assertString(input.taskId, '工作 ID', 100);
    const messageId = assertString(input.messageId, '消息 ID', 100);
    await workOps.view(actors.local(), id);
    const task = (await store.read()).tasks.find(item => item.id === id);
    const pending = task?.messages?.find(item => item.id === messageId && item.source === 'workbuddy-pending' && item.via === 'localassistant-relay' && item.externalMessageId);
    if (!pending) throw new Error('此工作没有 HTTPS 本地助理监听');
    const selection = await dialog.showMessageBox(mainWindow, { type: 'question', title: '结束本次监听', message: '你已经在 WorkBuddy 核对这次任务结束了吗？', detail: '只释放共作对消息流的占用，不会停止 WorkBuddy 的任务；未结束时释放可能影响后续回复匹配。', buttons: ['继续监听', '已核对，结束监听'], defaultId: 0, cancelId: 0 });
    if (selection.response !== 1) return { released: false };
    await releaseWorkBuddyMessage(await settingsService.getRuntimeConfig(), pending.externalMessageId);
    const data = await store.update(draft => {
      const m = draft.tasks.find(item => item.id === id)?.messages.find(item => item.id === messageId);
      if (m) { m.source = 'workbuddy'; m.observationEndedAt = new Date().toISOString(); }
      return draft;
    });
    publishData(data);
    return { released: true };
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

  ipcMain.handle('workspace:decide-join', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    let outcome;
    const data = await store.update(draft => {
      outcome = decideJoinRequest(draft, { requestId: assertString(input.requestId, '申请', 100), approve: input.approve === true, name: input.name, role: input.role || 'editor' });
      return draft;
    });
    publishData(data);
    // They messaged the bot to apply, so the bot may answer them now.
    const text = outcome.approved
      ? `你已加入共作「${outcome.space.name}」。之后有人在共作 @ 你、把工作指派给你，我会在这里通知你。\n也可以直接发：新建 ${outcome.space.name}：工作目标`
      : `你加入「${outcome.space.name}」的申请没有通过；如有疑问请联系空间负责人。`;
    wecomBot?.sendText(outcome.request.userId, text).catch(() => {});
    return data;
  });

  ipcMain.handle('workspace:link-feishu-member', async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error('不受信任的请求');
    const data = await store.update(draft => { linkFeishuProjectMember(draft, input); return draft; });
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
        ...(scope === 'personal' ? { portable: next.portable } : {}),
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
  // Generated HTML can run isolated inline scripts, but cannot navigate a frame
  // to HTTP/local files, open windows, access Node or the preload IPC.
  // Scripts are off by default; trusted interactive mode is not full network isolation.
  mainWindow.webContents.on('will-frame-navigate', (event, url) => {
    const target = event.url || url || '';
    if (!['about:blank', 'about:srcdoc'].includes(target) && !target.startsWith('data:application/pdf;base64,')) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, '..', 'demo', 'index.html'));
}

function handleTaskLink(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== `${linkScheme()}:` || url.hostname !== 'task') return;
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
app.on('second-instance', (_event, argv) => { const link = argv.find(arg => arg.startsWith(`${linkScheme()}://`)); if (link) handleTaskLink(link); });
if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(async () => {
  if (app.isPackaged && runtimeChannel.registerProtocol) app.setAsDefaultProtocolClient(runtimeChannel.scheme);
  nativeTheme.themeSource = 'light';
  store = new JsonStore(path.join(app.getPath('userData'), 'workspace.json'), createSeed);
  personalMemoryStore = new JsonStore(path.join(app.getPath('userData'), 'personal-memory.json'), memorySeed);
  teamMemoryStore = new JsonStore(path.join(app.getPath('userData'), 'team-memory.json'), memorySeed);
  settingsService = new SettingsService(
    path.join(app.getPath('userData'), 'settings.json'),
    path.join(app.getPath('userData'), 'credentials.json'),
    safeStorage
  );
  workbuddyAuth = new WorkBuddyRelayAuth({ settingsService, openExternal: url => shell.openExternal(url) });
  settingsService.workbuddyTokenProvider = () => workbuddyAuth.getAccessToken();
  settingsService.cloudagentKeyFallback = require('./cloudagent.cjs').readKeychainKey;
  settingsService.wecomBotSecretFallback = () => require('./workbuddy-oauth.cjs').readKeychain('cn.gongzuo.wecom.bot-secret');
  documentService = new DocumentService(
    path.join(app.getPath('userData'), 'documents.json'),
    path.join(app.getPath('userData'), 'documents')
  );
  await Promise.all([store.initialize(), personalMemoryStore.initialize(), teamMemoryStore.initialize(), settingsService.initialize(), documentService.initialize()]);
  { const current = await store.read();
    if (current.workspaces?.some(space => !Array.isArray(space.members)) || !personalWorkspace(current)) {
      await store.update(data => { migrateLegacyWorkspaceMembers(data); ensurePersonalWorkspace(data); return data; });
    } }
  agent.sessionsRoot = path.join(app.getPath('userData'), 'agent-sessions');
  taskRunner = new TaskRunner({ store, settingsService, personalMemoryStore, teamMemoryStore, documentService, agent, publish: publishData });
  workOps = new WorkOperations({ store, taskRunner });
  wecomBot = new WecomBotBridge({ store, settingsService, taskRunner, ops: workOps, publish: publishData, logFile: path.join(app.getPath('userData'), 'wecom-bot.log') });
  wecomDelivery = new WecomDelivery({ store, settingsService, publish: publishData, send: (config, userId, text) => sendViaWecom(config, userId, text, wecomBot), notify: async (config, member, text) => notifyMember(config, member, text, { bot: wecomBot, contacts: botContacts(await store.read()) }) });
  taskRunner.onAgentAnswer = event => wecomBot.sendAgentAnswer(event);
  workbuddyBridge = new WorkBuddyBridge({ userDataDir: app.getPath('userData'), store, taskRunner, ops: workOps, version: app.getVersion() });
  await taskRunner.markInterrupted();
  await wecomDelivery.markInterrupted();
  registerIpc();
  try { await workbuddyBridge.start(); }
  catch (error) { console.error('WorkBuddy 本机连接启动失败：', error.message); }
  await wecomBot.restart('startup');
  createMenu();
  createWindow();
  taskRunner.resumeCloudRuns().catch(error => console.error('续接云端执行失败：', error.message));
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => { wecomBot?.stop(); workbuddyBridge?.stop().catch(() => {}); });
