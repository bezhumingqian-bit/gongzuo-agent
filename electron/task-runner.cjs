const crypto = require('node:crypto');
const { createLocalTask } = require('./agent-service.cjs');
const { getApplicableMemories } = require('./memory-service.cjs');
const { resolveMentions } = require('./mention-service.cjs');
const { asksToReadWecomInbox, wecomInboxForAgent } = require('./channel-inbox.cjs');
const { conversationInput } = require('./connection-service.cjs');
const { mayUsePersonalMemory } = require('./contracts/policy.cjs');

// WorkBuddy has two transports: the official Open API (needs an OAuth token) and
// the local MCP hand-off, where WorkBuddy pulls queued work from this app.
const { transportOf } = require('./workbuddy-transport.cjs');
const usesWorkBuddyOpenApi = config => config?.agent?.mode === 'workbuddy' && transportOf(config) === 'localassistant';
const usesWorkBuddyHandoff = config => config?.agent?.mode === 'workbuddy' && transportOf(config) === 'handoff';

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
    if (!['built-in', 'external', 'codebuddy', 'workbuddy', 'cloudagent', 'codex', 'kimi'].includes(mode)) throw new Error('Agent 类型无效');
    if (this.queues.has(taskId)) throw new Error('Agent 正在处理此工作，请稍后切换');
    const data = await this.store.update(draft => {
      const task = draft.tasks.find(item => item.id === taskId);
      if (!task) throw new Error('任务不存在');
      if (['queued', 'running'].includes(task.agentRun?.status)) throw new Error('Agent 正在处理此工作，请稍后切换');
      if (task.agentMode !== mode) {
        task.agentMode = mode;
        task.agentSessionId = null;
        task.agentSessionOwner = null;
        if (task.agentRun?.status === 'awaiting-workbuddy') {
          // The pending hand-off is withdrawn; keep it retryable with the new Agent.
          task.agentRun = { status: 'interrupted', triggerId: task.agentRun.triggerId, updatedAt: new Date().toISOString() };
        } else if (!['failed', 'interrupted', 'not-configured'].includes(task.agentRun?.status)) {
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

  // Builds exactly what an executing Agent may see for one trigger: the ordered
  // conversation, applicable memory and the referenced document text. Shared by
  // in-process Agents and the WorkBuddy hand-off so both get the same boundary.
  async prepare(taskId, triggerId) {
    const runtime = await this.settingsService.getRuntimeConfig();
    const data = await this.store.read();
    const task = data.tasks.find(item => item.id === taskId);
    if (!task) return null;
    const messages = messagesThroughTrigger(task.messages, triggerId);
    if (!messages) return null;
    const config = { ...runtime, agent: { ...runtime.agent, mode: task.agentMode || runtime.agent.mode } };
    const workspaceId = data.workspaces.find(item => item.name === task.workspace)?.id;
    const [personal, team] = await Promise.all([this.personalMemoryStore.read(), this.teamMemoryStore.read()]);
    const triggerMessage = task.messages.find(item => item.id === triggerId);
    const personalAllowed = mayUsePersonalMemory(triggerMessage?.wecomOrigin);
    // The local inbox is the local user's; colleagues writing in via WeCom cannot read it.
    const readWecomInbox = personalAllowed && asksToReadWecomInbox(triggerMessage?.text, messages.slice(0, -1), task.title);
    const memory = getApplicableMemories(personalAllowed ? personal.items : [], team.items, workspaceId);
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
    const refs = triggerMessage?.documentRefs || [];
    let attached;
    try { attached = await Promise.all(refs.map(ref => this.documentService.readForAgent(ref.id, workspaceId))); }
    catch (error) {
      const failure = new Error(String(error?.message || '资料读取失败，请检查资料后重试').slice(0, 180));
      failure.documentFailure = true;
      throw failure;
    }
    const snapshot = { ...task, messages: messages.map(item => {
      if (item.id !== triggerId) return item;
      const parts = [item.text, ...attached.map(document => `【引用资料：${document.name}${document.truncated ? '，仅前 12000 字' : ''}】\n${document.text}`)];
      if (readWecomInbox) {
        const limit = usesWorkBuddyOpenApi(config) ? Math.max(0, 3850 - parts.join('\n\n').length) : 12000;
        if (limit < 200) {
          memory.channelStatus.inboxSharedForThisRequest = false;
          parts.push('【企微收件原文因本次输入过长未附上；请先缩短当前消息或移除资料引用。】');
        } else parts.push(wecomInboxForAgent(data, limit));
      }
      return { ...item, text: parts.join('\n\n') };
    }) };
    return { task, snapshot, memory, config };
  }

  async run(taskId, triggerId) {
    try {
      const runtime = await this.settingsService.getRuntimeConfig();
      const before = (await this.store.read()).tasks.find(item => item.id === taskId);
      if (!before || !messagesThroughTrigger(before.messages, triggerId)) return;
      const selected = { ...runtime, agent: { ...runtime.agent, mode: before.agentMode || runtime.agent.mode } };
      if (!this.agent.isConfigured(selected)) { await this.setRunStatus(taskId, { status: 'not-configured', triggerId }); return; }
      if (usesWorkBuddyHandoff(selected)) {
        // WorkBuddy pulls this work through the local MCP bridge; nothing runs in-process.
        await this.setRunStatus(taskId, { status: 'awaiting-workbuddy', triggerId });
        return;
      }
      await this.setRunStatus(taskId, { status: 'running', triggerId });
      let prepared;
      try { prepared = await this.prepare(taskId, triggerId); }
      catch (error) {
        if (!error.documentFailure) throw error;
        await this.setRunStatus(taskId, { status: 'failed', triggerId, message: error.message });
        return;
      }
      if (!prepared) return;
      let lastProgressAt = 0;
      const onProgress = ({ text, step } = {}) => {
        const now = Date.now();
        if (now - lastProgressAt < 1500) return;
        lastProgressAt = now;
        this.setRunStatus(taskId, { status: 'running', triggerId, progress: String(step ? `正在：${step}` : (text || '').slice(-200)).slice(0, 240) }).catch(() => {});
      };
      const answer = await this.agent.answer(prepared.snapshot, prepared.config, prepared.memory, { onProgress });
      if (answer?.pendingFiles) await this.attachAnswerFiles(prepared.task.workspace, answer);
      await this.recordAnswer(taskId, triggerId, answer);
    } catch (error) {
      await this.setRunStatus(taskId, { status: 'failed', triggerId, message: 'Agent 执行中断，请重试' });
    }
  }

  // Files produced by an Agent become space documents so the team keeps them.
  async attachAnswerFiles(workspace, answer) {
    const files = answer.pendingFiles || [];
    const directory = answer.pendingFilesDirectory;
    delete answer.pendingFiles;
    delete answer.pendingFilesDirectory;
    try {
      const data = await this.store.read();
      const workspaceId = data.workspaces.find(item => item.name === workspace)?.id;
      if (!workspaceId || !files.length || typeof this.documentService?.upload !== 'function') return;
      const saved = await this.documentService.upload(workspaceId, files.slice(0, 10).map(file => file.path));
      answer.artifacts = saved.map(item => ({ id: item.id, name: item.name }));
    } catch (error) {
      answer.text = `${answer.text}\n\n（生成的文件未能存入空间资料：${String(error?.message || '未知错误').slice(0, 120)}）`;
    } finally {
      if (directory) await require('node:fs/promises').rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  async recordAnswer(taskId, triggerId, answer) {
    const failed = answer?.source === 'connection-error';
    const finished = await this.store.update(draft => {
      const current = draft.tasks.find(item => item.id === taskId);
      if (!current) return draft;
      if (answer) current.messages.push({ ...answer, replyToId: triggerId });
      if (answer?.agentSessionId) {
        current.agentSessionId = answer.agentSessionId;
        if ('agentSessionOwner' in answer) current.agentSessionOwner = answer.agentSessionOwner;
      }
      current.agentRun = { status: failed ? 'failed' : 'done', triggerId, updatedAt: new Date().toISOString() };
      current.updatedAt = current.agentRun.updatedAt;
      if (failed || (current.workflow && answer?.source !== 'workbuddy-pending')) current.needsMe = true;
      if (current.workflow && !failed && answer?.source !== 'workbuddy-pending') current.status = 'review';
      return draft;
    });
    this.publish(finished);
    const task = finished.tasks.find(item => item.id === taskId);
    if (answer && task && typeof this.onAgentAnswer === 'function') {
      const trigger = task.messages.find(item => item.id === triggerId);
      if (trigger?.wecomOrigin && !task.workflow) this.onAgentAnswer({ taskId, answer, origin: trigger.wecomOrigin }).catch(() => {});
    }
    return task;
  }

  // ---- WorkBuddy hand-off (pulled through the local MCP bridge) ----

  async listHandoffs() {
    const data = await this.store.read();
    return data.tasks.filter(task => task.agentRun?.status === 'awaiting-workbuddy').map(task => ({
      taskId: task.id,
      triggerId: task.agentRun.triggerId,
      title: task.title,
      workspace: task.workspace,
      waitingSince: task.agentRun.updatedAt || task.updatedAt,
      claimedAt: task.agentRun.claimedAt || null,
      fromWecom: Boolean(task.messages.find(item => item.id === task.agentRun.triggerId)?.wecomOrigin),
      workflow: task.workflow?.type || null
    }));
  }

  async claimHandoff(taskId) {
    const task = (await this.store.read()).tasks.find(item => item.id === taskId);
    if (!task) throw new Error('工作不存在');
    if (task.agentRun?.status !== 'awaiting-workbuddy') throw new Error('这项工作当前没有等待 WorkBuddy 处理的消息');
    const triggerId = task.agentRun.triggerId;
    let prepared;
    try { prepared = await this.prepare(taskId, triggerId); }
    catch (error) {
      if (error.documentFailure) await this.setRunStatus(taskId, { status: 'failed', triggerId, message: error.message });
      throw error;
    }
    if (!prepared) throw new Error('这项工作的待处理消息已不存在');
    const input = conversationInput(prepared.snapshot.messages, prepared.memory);
    const claimedAt = new Date().toISOString();
    const data = await this.store.update(draft => {
      const current = draft.tasks.find(item => item.id === taskId);
      if (current?.agentRun?.status === 'awaiting-workbuddy' && current.agentRun.triggerId === triggerId) current.agentRun.claimedAt = claimedAt;
      return draft;
    });
    this.publish(data);
    return {
      taskId, triggerId, title: task.title, workspace: task.workspace, claimedAt,
      instructions: input.instructions,
      messages: input.messages
    };
  }

  async submitHandoffReply(taskId, triggerId, text, files = []) {
    const reply = String(text || '').trim();
    if (!reply) throw new Error('回复内容不能为空');
    if (reply.length > 50000) throw new Error('回复不能超过 50000 字');
    const task = (await this.store.read()).tasks.find(item => item.id === taskId);
    if (!task) throw new Error('工作不存在');
    if (task.agentRun?.status !== 'awaiting-workbuddy') throw new Error('这项工作当前没有等待 WorkBuddy 回复的消息');
    if (task.agentRun.triggerId !== triggerId) throw new Error('这条消息已不是最新的待处理消息；请重新读取工作后再回复');
    const answer = { id: crypto.randomUUID(), role: 'assistant', text: reply, createdAt: new Date().toISOString(), source: 'workbuddy', via: 'local-mcp' };
    if (files.length) {
      answer.pendingFiles = files.map(file => ({ path: file }));
      await this.attachAnswerFiles(task.workspace, answer);
    }
    await this.recordAnswer(taskId, triggerId, answer);
    return { taskId, messageId: answer.id, files: answer.artifacts || [] };
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

module.exports = { TaskRunner, messagesThroughTrigger, usesWorkBuddyHandoff, usesWorkBuddyOpenApi };
