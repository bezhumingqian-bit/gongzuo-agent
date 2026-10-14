const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gongzuo', Object.freeze({
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  createTask: input => ipcRenderer.invoke('tasks:create', input),
  appendMessage: input => ipcRenderer.invoke('tasks:append-message', input),
  assignTask: input => ipcRenderer.invoke('tasks:assign', input),
  retryAgent: taskId => ipcRenderer.invoke('tasks:retry-agent', taskId),
  setTaskAgent: input => ipcRenderer.invoke('tasks:set-agent', input),
  setRelatedSpaces: input => ipcRenderer.invoke('tasks:set-related-spaces', input),
  syncWorkBuddyReply: input => ipcRenderer.invoke('tasks:sync-workbuddy-reply', input),
  setActiveWorkspace: name => ipcRenderer.invoke('workspace:set-active', name),
  createProjectWorkspace: input => ipcRenderer.invoke('workspace:create-project', input),
  addProjectMember: input => ipcRenderer.invoke('workspace:add-member', input),
  linkWecomProjectMember: input => ipcRenderer.invoke('workspace:link-wecom-member', input),
  linkFeishuProjectMember: input => ipcRenderer.invoke('workspace:link-feishu-member', input),
  removePendingProjectMember: input => ipcRenderer.invoke('workspace:remove-pending-member', input),
  updatePendingProjectMemberRole: input => ipcRenderer.invoke('workspace:update-pending-role', input),
  ingestChannelEvent: event => ipcRenderer.invoke('channel:ingest', event),
  getAgentStatus: () => ipcRenderer.invoke('agent:status'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: input => ipcRenderer.invoke('settings:save', input),
  testConnection: kind => ipcRenderer.invoke('integrations:test', kind),
  openModelPortal: provider => ipcRenderer.invoke('integrations:open-model-portal', provider),
  openWorkBuddyPortal: () => ipcRenderer.invoke('integrations:open-workbuddy-portal'),
  authorizeWorkBuddy: () => ipcRenderer.invoke('workbuddy:authorize'),
  signOutWorkBuddy: () => ipcRenderer.invoke('workbuddy:sign-out'),
  sendWecomMessage: input => ipcRenderer.invoke('wecom:send-task-message', input),
  sendWecomDraft: input => ipcRenderer.invoke('wecom:send-draft', input),
  forwardWecomToMembers: input => ipcRenderer.invoke('wecom:forward-to-members', input),
  syncWecomMembers: () => ipcRenderer.invoke('wecom:sync-members'),
  getWecomBotStatus: () => ipcRenderer.invoke('wecom:bot-status'),
  listDocuments: () => ipcRenderer.invoke('documents:list'),
  uploadDocuments: workspaceId => ipcRenderer.invoke('documents:upload', workspaceId),
  updateDocument: input => ipcRenderer.invoke('documents:update', input),
  archiveDocument: id => ipcRenderer.invoke('documents:archive', id),
  restoreDocument: id => ipcRenderer.invoke('documents:restore', id),
  openDocument: id => ipcRenderer.invoke('documents:open', id),
  listMemories: () => ipcRenderer.invoke('memory:list'),
  extractMemory: taskId => ipcRenderer.invoke('memory:extract', taskId),
  saveMemory: input => ipcRenderer.invoke('memory:save', input),
  updateMemory: input => ipcRenderer.invoke('memory:update', input),
  archiveMemory: input => ipcRenderer.invoke('memory:archive', input),
  onDataChanged: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('data:changed', listener);
    return () => ipcRenderer.removeListener('data:changed', listener);
  },
  onOpenTask: callback => {
    const listener = (_event, taskId) => callback(taskId);
    ipcRenderer.on('app:open-task', listener);
    return () => ipcRenderer.removeListener('app:open-task', listener);
  }
}));
