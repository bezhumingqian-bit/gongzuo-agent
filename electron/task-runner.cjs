const crypto = require('node:crypto');
const { createLocalTask } = require('./agent-service.cjs');
const { getApplicableMemories } = require('./memory-service.cjs');
const { resolveMentions } = require('./mention-service.cjs');
const { asksToReadWecomInbox, wecomInboxForAgent } = require('./channel-inbox.cjs');

function messagesThroughTrigger(messages, triggerId) {
  const triggerIndex = messages.findIndex(item => item.id === triggerId && item.role === 'user');
  if (triggerIndex < 0) return null;
  const replies = new Map();
  for (const item of messages) {
    if (item.role !== 'assistant' || !item.replyToId || item.source === 'connection-error') continue;
    if (!replies.has(item.replyToId)) replies.set(item.replyToId, []);
    replies.get(item.replyToId).push(item);
  }
  const ordered = [];
  for (const item of messages.slice(0, triggerIndex + 1)) {
    if (item.role === 'user') {
      if (item.wecomOutbound) continue;
      ordered.push(item, ...(replies.get(item.id) || []));
    } else if (!item.replyToId) ordered.push(item);
  }
  return ordered;
}

class TaskRunner {
  constructor({ store, settingsService, personalMemoryStore, teamMemoryStore, documentService, agent, publish }) {
    Object.assign(this, { store, settingsService, personalMemoryStore, teamMemoryStore, documentService, agent, publish });
    this.queues = new Map();
  }

  async documentRefs(workspace, ids = []) {
    if (!Array.isArray(ids) || ids.length > 3 || ids.some(id => typeof id !== 'string' || id.length > 100)) throw new Error('一次最多引用 3 份空间资料');
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const data = await this.store.read();
    const workspaceId = data.workspaces.find(item => item.name === workspace)?.id;
    const documents = await this.documentService.list();
    return unique.map(id => {
      const item = documents.find(document => document.id === id && document.workspaceId === workspaceId && document.status === 'active');
      if (!item) throw new Error('只能引用当前空间内的有效资料');
      if (!/\.(txt|md|csv|pdf|docx|doc)$/i.test(item.name)) throw new Error(`暂不能读取 ${item.name} 的正文`);
      return { id: item.id, name: item.name };
    });
  }

  async create(goal, workspace, documentIds = [], origin = null, options = {}) {
    const refs = await this.documentRefs(workspace, documentIds);
    const config = await this.settingsService.getRuntimeConfig();
    const task = createLocalTask({ goal, workspace });
    task.messages[0].documentRefs = refs;
    if (origin) task.messages[0].wecomOrigin = origin;
    task.agentMode = options.agentMode || config.agent.mode;
    if (options.workflow) {
      task.workflow = options.workflow;
      task.title = options.title || task.title;
    }
    const selectedConfig = { ...config, agent: { ...config.agent, mode: task.agentMode } };
    task.agentRun = { status: this.agent.isConfigured(selectedConfig) ? 'queued' : 'not-configured', triggerId: task.messages[0].id };
    const data = await this.store.update(draft => { draft.tasks.unshift(task); return draft; });
    this.publish(data);
    if (task.agentRun.status === 'queued') this.schedule(task.id, task.messages[0].id);
    return task;
  }

  async append(taskId, text, mentionIds = [], documentIds = [], origin = null) {
    const taskBefore = (await this.store.read()).tasks.find(item => item.id === taskId);
    if (!taskBefore) throw new Error('任务不存在');
    const refs = await this.documentRefs(taskBefore.workspace, documentIds);
    let message;
    const data = await this.store.update(draft => {
      const task = draft.tasks.find(item => item.id === taskId);
      if (!task) throw new Error('任务不存在');
      const mentions = resolveMentions(draft, task, mentionIds);
      if (mentions.some(mention => !text.includes(`@${mention.name}`))) throw new Error('消息中缺少已选择的 @ 同事');
      message = { id: crypto.randomUUID(), role: 'user', text, createdAt: new Date().toISOString(), mentions, mentionDelivery: mentions.length ? 'not_sent' : null, documentRefs: refs };
      if (origin) message.wecomOrigin = origin;
      task.messages.push(message);
      if (task.channelOnly) { task.channelOnly = false; task.status = 'running'; }
      task.updatedAt = message.createdAt;
      return draft;
    });
    this.publish(data);
    const task = data.tasks.find(item => item.id === taskId);
    const runtime = await this.settingsService.getRuntimeConfig();
    const config = { ...runtime, agent: { ...runtime.agent, mode: task.agentMode || runtime.agent.mode } };
    if (this.agent.isConfigured(config)) this.schedule(taskId, message.id);
    else await this.setRunStatus(taskId, { status: 'not-configured', triggerId: message.id });
    return message;
  }

  async createOutbound(text, workspace) {
    const task = createLocalTask({ goal: text, workspace });
    task.title = `企微消息 · ${workspace}`;
    task.status = 'done';
    task.steps = [];
    task.channelOnly = true;
    task.messages[0].wecomOutbound = true;
    task.agentRun = { status: 'skipped', triggerId: null };
    const data = await this.store.update(draft => { draft.tasks.unshift(task); return draft; });
    this.publish(data);
    return { ...task.messages[0], taskId: task.id };
  }

  async appendOutbound(taskId, text) {
    let message;
    const data = await this.store.update(draft => {
      const task = draft.tasks.find(item => item.id === taskId);
      if (!task) throw new Error('任务不存在');
      message = { id: crypto.randomUUID(), role: 'user', text, createdAt: new Date().toISOString(), wecomOutbound: true };
      task.messages.push(message);
      task.updatedAt = message.createdAt;
      return draft;
    });
    this.publish(data);
    return { ...message, taskId };
  }

  async recordOutbound(text, workspace, taskId = null) {
    if (taskId) return this.appendOutbound(taskId, text);
    const existing = (await this.store.read()).tasks.find(task => task.channelOnly && task.workspace === workspace);
    return existing ? this.appendOutbound(existing.id, text) : this.createOutbound(text, workspace);
  }

  schedule(taskId, triggerId) {
    const previous = this.queues.get(taskId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.run(taskId, triggerId));
    this.queues.set(taskId, next);
    next.catch(() => {}).finally(() => { if (this.queues.get(taskId) === next) this.queues.delete(taskId); });
  }

  async retry(taskId) {
    const task = (await this.store.read()).tasks.find(item => item.id === taskId);
    if (!task) throw new Error('任务不存在');
    if (!['failed', 'interrupted', 'not-configured'].includes(task.agentRun?.status)) throw new Error('此工作目前不需要重试');
    if (['queued', 'running'].includes(task.agentRun?.status) || this.queues.has(taskId)) throw new Error('Agent 正在处理此工作');
    const runtime = await this.settingsService.getRuntimeConfig();
    const config = { ...runtime, agent: { ...runtime.agent, mode: task.agentMode || runtime.agent.mode } };
    if (!this.agent.isConfigured(config)) throw new Error('当前工作的 Agent 尚未配置；请先设置模型或切换执行 Agent');
    const trigger = [...task.messages].reverse().find(item => item.role === 'user' && !item.wecomOutbound);
    if (!trigger) throw new Error('工作没有可重试的消息');
    this.schedule(taskId, trigger.id);
    return { queued: true };
  }

  async setAgent(taskId, mode) {
    if (!['built-in', 'external', 'codebuddy', 'workbuddy', 'codex', 'kimi'].includes(mode)) throw new Error('Agent 类型无效');
    if (this.queues.has(taskId)) throw new Error('Agent 正在处理此工作，请稍后切换');
    const data = await this.store.update(draft => {
      const task = draft.tasks.find(item => item.id === taskId);
      if (!task) throw new Error('任务不存在');
      if (['queued', 'running'].includes(task.agentRun?.status)) throw new Error('Agent 正在处理此工作，请稍后切换');
      if (task.agentMode !== mode) {
        task.agentMode = mode;
        task.agentSessionId = null;
        if (!['failed', 'interrupted', 'not-configured'].includes(task.agentRun?.status)) {
          task.agentRun = { status: 'done', updatedAt: new Date().toISOString() };
        }
        task.updatedAt = task.agentRun.updatedAt;
      }
      return draft;
    });
    this.publish(data);
    return data.tasks.find(item => item.id === taskId);
  }

  async setRunStatus(taskId, run) {
    const data = await this.store.update(draft => {
      const task = draft.tasks.find(item => item.id === taskId);
      if (task) { task.agentRun = { ...run, updatedAt: new Date().toISOString() }; task.updatedAt = task.agentRun.updatedAt; }
      return draft;
    });
    this.publish(data);
  }

  async run(taskId, triggerId) {
    try {
      const runtime = await this.settingsService.getRuntimeConfig();
      const data = await this.store.read();
      const task = data.tasks.find(item => item.id === taskId);
      if (!task) return;
      const messages = messagesThroughTrigger(task.messages, triggerId);
      if (!messages) return;
      const config = { ...runtime, agent: { ...runtime.agent, mode: task.agentMode || runtime.agent.mode } };
      if (!this.agent.isConfigured(config)) { await this.setRunStatus(taskId, { status: 'not-configured', triggerId }); return; }
      await this.setRunStatus(taskId, { status: 'running', triggerId });
      const workspaceId = data.workspaces.find(item => item.name === task.workspace)?.id;
      const [personal, team] = await Promise.all([this.personalMemoryStore.read(), this.teamMemoryStore.read()]);
      const triggerMessage = task.messages.find(item => item.id === triggerId);
      const fromWecom = Boolean(triggerMessage?.wecomOrigin);
      const readWecomInbox = !fromWecom && asksToReadWecomInbox(triggerMessage?.text, messages.slice(0, -1), task.title);
      const memory = getApplicableMemories(fromWecom ? [] : personal.items, team.items, workspaceId);
      if (/企微|企业微信|机器人|长连接/u.test(`${task.title} ${triggerMessage?.text || ''}`) || readWecomInbox) {
        const recentWecomEvent = (data.wecomEvents || []).at(-1);
        const inbox = (data.inboundMessages || []).filter(item => item.channel === 'wecom' && item.text);
        memory.channelStatus = {
          recentRobotCallback: recentWecomEvent ? { at: recentWecomEvent.at, chatType: recentWecomEvent.chatType } : null,
          inbox: { savedCount: inbox.length, latestAt: inbox.at(-1)?.receivedAt || null },
          inboxSharedForThisRequest: readWecomInbox,
          taskDeliveries: task.messages.filter(item => item.role === 'user' && item.wecomDelivery).slice(-5).map(item => ({
            text: String(item.text || '').slice(0, 80),
            status: item.wecomDelivery.status
          }))
        };
      }
      const refs = task.messages.find(item => item.id === triggerId)?.documentRefs || [];
      let attached;
      try { attached = await Promise.all(refs.map(ref => this.documentService.readForAgent(ref.id, workspaceId))); }
      catch (error) {
        await this.setRunStatus(taskId, { status: 'failed', triggerId, message: String(error?.message || '资料读取失败，请检查资料后重试').slice(0, 180) });
        return;
      }
      const snapshot = { ...task, messages: messages.map(item => {
        if (item.id !== triggerId) return item;
        const parts = [item.text, ...attached.map(document => `【引用资料：${document.name}${document.truncated ? '，仅前 12000 字' : ''}】\n${document.text}`)];
        if (readWecomInbox) {
          const limit = config.agent.mode === 'workbuddy' ? Math.max(0, 3850 - parts.join('\n\n').length) : 12000;
          if (limit < 200) {
            memory.channelStatus.inboxSharedForThisRequest = false;
            parts.push('【企微收件原文因本次输入过长未附上；请先缩短当前消息或移除资料引用。】');
          } else parts.push(wecomInboxForAgent(data, limit));
        }
        return { ...item, text: parts.join('\n\n') };
      }) };
      const answer = await this.agent.answer(snapshot, config, memory);
      const failed = answer?.source === 'connection-error';
      const finished = await this.store.update(draft => {
        const current = draft.tasks.find(item => item.id === taskId);
        if (!current) return draft;
        if (answer) current.messages.push({ ...answer, replyToId: triggerId });
        if (answer?.agentSessionId) current.agentSessionId = answer.agentSessionId;
        current.agentRun = { status: failed ? 'failed' : 'done', triggerId, updatedAt: new Date().toISOString() };
        current.updatedAt = current.agentRun.updatedAt;
        if (failed || (current.workflow && answer?.source !== 'workbuddy-pending')) current.needsMe = true;
        if (current.workflow && !failed && answer?.source !== 'workbuddy-pending') current.status = 'review';
        return draft;
      });
      this.publish(finished);
      if (answer && typeof this.onAgentAnswer === 'function') {
        const trigger = finished.tasks.find(item => item.id === taskId)?.messages.find(item => item.id === triggerId);
        if (trigger?.wecomOrigin && !task.workflow) this.onAgentAnswer({ taskId, answer, origin: trigger.wecomOrigin }).catch(() => {});
      }
    } catch (error) {
      await this.setRunStatus(taskId, { status: 'failed', triggerId, message: 'Agent 执行中断，请重试' });
    }
  }

  async markInterrupted() {
    const data = await this.store.update(draft => {
      for (const task of draft.tasks) {
        if (['queued', 'running'].includes(task.agentRun?.status)) task.agentRun = { ...task.agentRun, status: 'interrupted', updatedAt: new Date().toISOString() };
      }
      return draft;
    });
    this.publish(data);
  }
}

module.exports = { TaskRunner, messagesThroughTrigger };
