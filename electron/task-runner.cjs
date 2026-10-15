const crypto = require('node:crypto');
const { createLocalTask } = require('./agent-service.cjs');
const { getApplicableMemories } = require('./memory-service.cjs');
const { resolveMentions } = require('./mention-service.cjs');
const { asksToReadWecomInbox, wecomInboxForAgent } = require('./channel-inbox.cjs');
const { conversationInput } = require('./connection-service.cjs');
const { mayUsePersonalMemory } = require('./contracts/policy.cjs');
const progress = require('./progress-service.cjs');

// WorkBuddy has two transports: the official Open API (needs an OAuth token) and
// the local MCP hand-off, where WorkBuddy pulls queued work from this app.
const { transportOf } = require('./workbuddy-transport.cjs');
const usesWorkBuddyOpenApi = config => config?.agent?.mode === 'workbuddy' && transportOf(config) === 'localassistant';
const usesWorkBuddyHandoff = config => config?.agent?.mode === 'workbuddy' && transportOf(config) === 'handoff';

// ---- privacy boundaries (see docs/ARCHITECTURE.md「空间与隐私」) ----
const INHERITED_LIMITS = { team: 4, public: 3 };
const spaceNamed = (data, name) => (data.workspaces || []).find(item => item.name === name) || null;
const spacesOfType = (data, type) => (data.workspaces || []).filter(item => item.type === type);
// Agents whose execution and files live in a cloud sandbox, not on this Mac.
const runsInCloud = config => config?.agent?.mode === 'cloudagent' || (config?.agent?.mode === 'workbuddy' && transportOf(config) === 'cloud');

// What a colleague's follow-up (from WeCom) may let the Agent see: the work's
// goal, confirmed progress, and that colleague's own messages with the replies
// to them — never the owner's process conversation, unless the owner shared it.
function colleagueView(task, ordered, origin) {
  const own = new Set(ordered.filter(item => item.role === 'user' && item.wecomOrigin?.userId === origin.userId).map(item => item.id));
  const kept = ordered.filter(item => (item.role === 'user' && own.has(item.id)) || (item.role === 'assistant' && own.has(item.replyToId)));
  const confirmed = (task.progress || []).filter(item => item.status === 'published').slice(-12).map(item => `- ${String(item.text || '').slice(0, 200)}`);
  const background = { id: 'colleague-context', role: 'user', text: `【工作背景，由共作提供】目标：${String(task.goal || task.title || '').slice(0, 500)}${confirmed.length ? `\n已确认进展：\n${confirmed.join('\n')}` : '\n暂无已确认进展。'}\n以下是同事本人在这项工作里的消息；负责人的过程对话未共享。`, createdAt: task.createdAt };
  return [background, ...kept];
}

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

  // Documents may come from the work's primary space or any related space.
  async documentRefs(workspace, ids = [], related = [], options = {}) {
    if (!Array.isArray(ids) || ids.length > 3 || ids.some(id => typeof id !== 'string' || id.length > 100)) throw new Error('一次最多引用 3 份空间资料');
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const data = await this.store.read();
    const spaceIds = new Set([workspace, ...related].map(name => data.workspaces.find(item => item.name === name)?.id).filter(Boolean));
    // Public materials can be referenced from any work; my own materials only in work I write here.
    for (const space of spacesOfType(data, 'public')) spaceIds.add(space.id);
    const personalIds = new Set(spacesOfType(data, 'personal').map(space => space.id));
    if (!options.fromChannel) for (const id of personalIds) spaceIds.add(id);
    const documents = await this.documentService.list();
    return unique.map(id => {
      const item = documents.find(document => document.id === id && spaceIds.has(document.workspaceId) && document.status === 'active');
      if (!item) throw new Error(related.length ? '只能引用这项工作所在空间（含关联空间）或个人空间内的有效资料' : '只能引用当前空间或个人空间内的有效资料');
      if (!/\.(txt|md|csv|pdf|docx|doc)$/i.test(item.name)) throw new Error(`暂不能读取 ${item.name} 的正文`);
      return { id: item.id, name: item.name, ...(personalIds.has(item.workspaceId) ? { personal: true } : {}) };
    });
  }

  async create(goal, workspace, documentIds = [], origin = null, options = {}) {
    const related = Array.isArray(options.relatedWorkspaces) ? options.relatedWorkspaces : [];
    const refs = await this.documentRefs(workspace, documentIds, related, { fromChannel: Boolean(origin) });
    const config = await this.settingsService.getRuntimeConfig();
    const task = createLocalTask({ goal, workspace });
    if (related.length) task.relatedWorkspaces = related;
    if (Array.isArray(options.mentions) && options.mentions.length) {
      const mentions = resolveMentions(await this.store.read(), task, options.mentions);
      task.messages[0].mentions = mentions;
      task.messages[0].mentionDelivery = 'not_sent';
    }
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
    const refs = await this.documentRefs(taskBefore.workspace, documentIds, taskBefore.relatedWorkspaces || [], { fromChannel: Boolean(origin) });
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

  async createOutbound(text, workspace, mentionIds = []) {
    const task = createLocalTask({ goal: text, workspace });
    if (mentionIds.length) { task.messages[0].mentions = resolveMentions(await this.store.read(), task, mentionIds); task.messages[0].mentionDelivery = 'not_sent'; }
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

  async appendOutbound(taskId, text, mentionIds = []) {
    let message;
    const data = await this.store.update(draft => {
      const task = draft.tasks.find(item => item.id === taskId);
      if (!task) throw new Error('任务不存在');
      const mentions = mentionIds.length ? resolveMentions(draft, task, mentionIds) : [];
      message = { id: crypto.randomUUID(), role: 'user', text, createdAt: new Date().toISOString(), wecomOutbound: true, ...(mentions.length ? { mentions, mentionDelivery: 'not_sent' } : {}) };
      task.messages.push(message);
      task.updatedAt = message.createdAt;
      return draft;
    });
    this.publish(data);
    return { ...message, taskId };
  }

  async recordOutbound(text, workspace, taskId = null, mentionIds = []) {
    if (taskId) return this.appendOutbound(taskId, text, mentionIds);
    const existing = (await this.store.read()).tasks.find(task => task.channelOnly && task.workspace === workspace);
    return existing ? this.appendOutbound(existing.id, text, mentionIds) : this.createOutbound(text, workspace, mentionIds);
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
    const ordered = messagesThroughTrigger(task.messages, triggerId);
    if (!ordered) return null;
    const config = { ...runtime, agent: { ...runtime.agent, mode: task.agentMode || runtime.agent.mode } };
    const workspaceId = data.workspaces.find(item => item.name === task.workspace)?.id;
    const related = (task.relatedWorkspaces || []).map(name => data.workspaces.find(item => item.name === name)).filter(Boolean);
    const spaceIds = [workspaceId, ...related.map(space => space.id)].filter(Boolean);
    const [personal, team] = await Promise.all([this.personalMemoryStore.read(), this.teamMemoryStore.read()]);
    const triggerMessage = task.messages.find(item => item.id === triggerId);
    const personalAllowed = mayUsePersonalMemory(triggerMessage?.wecomOrigin);
    const primary = spaceNamed(data, task.workspace);
    const inPersonal = primary?.type === 'personal';
    // A colleague's follow-up sees only what the team may see.
    const isolated = Boolean(triggerMessage?.wecomOrigin) && !task.conversationShared;
    const messages = isolated ? colleagueView(task, ordered, triggerMessage.wecomOrigin) : ordered;
    // The local inbox is the local user's; colleagues writing in via WeCom cannot read it.
    const readWecomInbox = personalAllowed && asksToReadWecomInbox(triggerMessage?.text, messages.slice(0, -1), task.title);
    // Personal memory: all of it in personal work; in team/project work only the
    // items the owner marked as portable (「可随我带入团队」).
    const personalItems = personalAllowed ? personal.items.filter(item => inPersonal || item.portable === true) : [];
    const memory = getApplicableMemories(personalItems, team.items, spaceIds);
    // Rules flow down, read-only: a project gets its main team's memory, and every
    // work gets the public space's. Capped per layer to keep the context small.
    const inherited = [];
    const parent = primary?.type === 'project' && primary.parentWorkspaceId ? data.workspaces.find(item => item.id === primary.parentWorkspaceId && item.type === 'team') : null;
    if (parent && !spaceIds.includes(parent.id)) inherited.push([parent, INHERITED_LIMITS.team]);
    for (const space of spacesOfType(data, 'public')) if (!spaceIds.includes(space.id)) inherited.push([space, INHERITED_LIMITS.public]);
    for (const [space, limit] of inherited) {
      const items = getApplicableMemories([], team.items, [space.id]).team.slice(0, limit).map(item => ({ ...item, inheritedFrom: space.name }));
      memory.team.push(...items);
    }
    if (related.length) memory.relatedWorkspaces = related.map(space => space.name);
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
    // Personal-space materials follow only messages written by the local user.
    const publicIds = spacesOfType(data, 'public').map(space => space.id);
    const docSpaceIds = [...spaceIds, ...publicIds, ...(personalAllowed ? spacesOfType(data, 'personal').map(space => space.id) : [])];
    try { attached = await Promise.all(refs.map(ref => this.documentService.readForAgent(ref.id, docSpaceIds))); }
    catch (error) {
      const failure = new Error(String(error?.message || '资料读取失败，请检查资料后重试').slice(0, 180));
      failure.documentFailure = true;
      throw failure;
    }
    const snapshot = { ...task, ...(isolated ? { agentSessionId: null, agentSessionOwner: null, progress: [] } : {}), messages: messages.map(item => {
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
    return { task, snapshot, memory, config, isolated };
  }

  async run(taskId, triggerId) {
    try {
      const runtime = await this.settingsService.getRuntimeConfig();
      const before = (await this.store.read()).tasks.find(item => item.id === taskId);
      if (!before || !messagesThroughTrigger(before.messages, triggerId)) return;
      const selected = { ...runtime, agent: { ...runtime.agent, mode: before.agentMode || runtime.agent.mode } };
      if (!this.agent.isConfigured(selected)) { await this.setRunStatus(taskId, { status: 'not-configured', triggerId }); return; }
      const space = spaceNamed(await this.store.read(), before.workspace);
      if (space?.type === 'personal' && runtime.privacy?.personalLocalOnly && runsInCloud(selected)) {
        await this.setRunStatus(taskId, { status: 'failed', triggerId, message: '个人空间已设为「只用本机执行」，当前 Agent 会在云端沙箱执行。请换用本机 Agent，或在个人空间关闭这项设置。' });
        return;
      }
      if (usesWorkBuddyHandoff(selected)) {
        // WorkBuddy pulls this work through the local MCP bridge; nothing runs in-process.
        await this.setRunStatus(taskId, { status: 'awaiting-workbuddy', triggerId });
        return;
      }
      // What the work page shows while the Agent runs: since when, the last
      // sign of life from the Agent, how many steps, and whether 共作 is
      // reconnecting or waiting for an earlier request to finish.
      const live = { status: 'running', triggerId, startedAt: new Date().toISOString(), steps: 0, phase: 'working' };
      await this.setRunStatus(taskId, live);
      let prepared;
      try { prepared = await this.prepare(taskId, triggerId); }
      catch (error) {
        if (!error.documentFailure) throw error;
        await this.setRunStatus(taskId, { status: 'failed', triggerId, message: error.message });
        return;
      }
      if (!prepared) return;
      let flushTimer = null;
      let lastFlush = 0;
      let finished = false;
      const flush = () => {
        flushTimer = null;
        if (finished) return;
        lastFlush = Date.now();
        this.updateLiveRun(taskId, triggerId, { ...live }).catch(() => {});
      };
      const onProgress = ({ text, step, steps, lastActivityAt, phase, attempt } = {}) => {
        const visible = String(text || '').replace(/<(进展|progress)>[\s\S]*$/u, '').trim();
        const said = step ? `正在${step}` : visible ? visible.slice(-200) : '';
        if (said) live.progress = said.slice(0, 240);
        live.lastActivityAt = new Date(lastActivityAt || Date.now()).toISOString();
        if (Number.isFinite(steps)) live.steps = steps;
        live.phase = phase || 'working';
        if (attempt) live.attempt = attempt; else delete live.attempt;
        if (!flushTimer) flushTimer = setTimeout(flush, Math.max(0, 1500 - (Date.now() - lastFlush)));
      };
      let answer;
      try { answer = await this.agent.answer(prepared.snapshot, prepared.config, prepared.memory, { onProgress }); }
      finally { finished = true; clearTimeout(flushTimer); }
      if (answer && prepared.isolated) answer.isolatedSession = true;
      if (answer?.pendingFiles) await this.attachAnswerFiles(prepared.task, answer);
      await this.recordAnswer(taskId, triggerId, answer);
    } catch (error) {
      await this.setRunStatus(taskId, { status: 'failed', triggerId, message: 'Agent 执行中断，请重试' });
    }
  }

  // Progress writes never overwrite a run that has already ended or moved on.
  async updateLiveRun(taskId, triggerId, run) {
    const data = await this.store.update(draft => {
      const task = draft.tasks.find(item => item.id === taskId);
      if (task?.agentRun?.status === 'running' && task.agentRun.triggerId === triggerId) {
        task.agentRun = { ...run, updatedAt: new Date().toISOString() };
        task.updatedAt = task.agentRun.updatedAt;
      }
      return draft;
    });
    this.publish(data);
  }

  // Files produced by an Agent are stored once, in the space the work lives in
  // (the result belongs there). The personal space links to them instead of
  // keeping copies, so team permissions keep applying.
  async attachAnswerFiles(task, answer) {
    const files = answer.pendingFiles || [];
    const directory = answer.pendingFilesDirectory;
    delete answer.pendingFiles;
    delete answer.pendingFilesDirectory;
    try {
      const data = await this.store.read();
      const space = spaceNamed(data, task.workspace);
      if (!space || !files.length || typeof this.documentService?.upload !== 'function') return;
      const origin = { taskId: task.id, taskTitle: task.title || task.goal, workspace: task.workspace, agent: answer.source, messageId: answer.id };
      const saved = await this.documentService.upload(space.id, files.slice(0, 10).map(file => file.path), { origin });
      answer.artifacts = saved.map(item => ({ id: item.id, name: item.name }));
    } catch (error) {
      answer.text = `${answer.text}\n\n（生成的文件未能存入${task.workspace}资料：${String(error?.message || '未知错误').slice(0, 120)}）`;
    } finally {
      if (directory) await require('node:fs/promises').rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  // 「取回云端文件」: bring back deliverables a CloudAgent work left in its
  // sandbox that 共作 does not have yet; they join the latest cloud reply.
  async retrieveCloudFiles(taskId) {
    const data = await this.store.read();
    const task = data.tasks.find(item => item.id === taskId);
    if (!task) throw new Error('工作不存在');
    const reply = [...task.messages].reverse().find(item => item.role === 'assistant' && item.source === 'cloudagent');
    if (!task.agentSessionId || !reply) throw new Error('这项工作没有 CodeBuddy 云端沙箱');
    if (typeof this.agent.retrieveCloudFiles !== 'function') throw new Error('当前版本不支持取回云端文件');
    const runtime = await this.settingsService.getRuntimeConfig();
    const known = (await this.documentService.list()).filter(item => item.origin?.taskId === task.id && item.status === 'active');
    const fetched = await this.agent.retrieveCloudFiles(runtime, task.agentSessionId, { exclude: new Set(known.map(item => `${item.name}:${item.size}`)) });
    if (!fetched.saved.length) {
      if (fetched.directory) await require('node:fs/promises').rm(fetched.directory, { recursive: true, force: true }).catch(() => {});
      return { files: [], skipped: fetched.skipped };
    }
    const carrier = { id: reply.id, source: 'cloudagent', text: '', pendingFiles: fetched.saved, pendingFilesDirectory: fetched.directory };
    await this.attachAnswerFiles(task, carrier);
    if (!carrier.artifacts?.length) throw new Error(carrier.text.trim().replace(/^（|）$/g, '') || '文件未能存入资料');
    const saved = await this.store.update(draft => {
      const message = draft.tasks.find(item => item.id === taskId)?.messages.find(item => item.id === reply.id);
      if (message) message.artifacts = [...(message.artifacts || []), ...carrier.artifacts];
      return draft;
    });
    this.publish(saved);
    return { files: carrier.artifacts, skipped: fetched.skipped };
  }

  // Whether an answer in a team/project work drew on the owner's personal
  // memory or materials; its progress drafts are then flagged for review.
  async personalContextOf(taskId, triggerId) {
    const data = await this.store.read();
    const task = data.tasks.find(item => item.id === taskId);
    if (!task || spaceNamed(data, task.workspace)?.type === 'personal') return null;
    const trigger = task.messages.find(item => item.id === triggerId);
    if (trigger?.wecomOrigin) return null;
    const documents = (trigger?.documentRefs || []).some(ref => ref.personal);
    const memories = (await this.personalMemoryStore.read()).items.some(item => item.status === 'active' && item.scope === 'personal' && item.portable === true);
    return documents && memories ? 'memory-and-document' : documents ? 'document' : memories ? 'memory' : null;
  }

  // ---- 移交：a personal work hands its result to a team or project ----
  // Only the messages the owner picked move; the personal work keeps the full
  // record and its Agent session. Files in picked replies are stored in the target.
  async handover(taskId, targetName, messageIds) {
    if (!Array.isArray(messageIds) || !messageIds.length || messageIds.length > 30 || messageIds.some(id => typeof id !== 'string')) throw new Error('请选择 1–30 条要移交的消息');
    const data = await this.store.read();
    const source = data.tasks.find(item => item.id === taskId);
    if (!source) throw new Error('工作不存在');
    if (spaceNamed(data, source.workspace)?.type !== 'personal') throw new Error('只有个人空间的工作可以移交');
    if (source.handedOver) throw new Error(`这项工作已移交到「${source.handedOver.workspace}」`);
    if (['queued', 'running', 'awaiting-workbuddy'].includes(source.agentRun?.status) || this.queues.has(taskId)) throw new Error('Agent 还在处理这项工作，请完成后再移交');
    const target = spaceNamed(data, targetName);
    if (!target || !['team', 'project'].includes(target.type)) throw new Error('只能移交到团队或项目空间');
    const picked = new Set(messageIds);
    const chosen = source.messages.filter(item => picked.has(item.id) && ['user', 'assistant'].includes(item.role) && item.source !== 'connection-error' && !item.wecomOutbound && item.source !== 'workbuddy-pending');
    if (chosen.length !== picked.size) throw new Error('所选消息不存在或不能移交');
    const now = new Date().toISOString();
    const task = createLocalTask({ goal: source.goal || source.title, workspace: target.name });
    task.title = source.title;
    task.status = 'running';
    task.steps = [];
    task.agentMode = source.agentMode;
    task.handedOverFrom = { taskId: source.id, at: now };
    task.messages[0].text = source.goal || source.title;
    task.messages[0].handover = true;
    const copies = [];
    for (const item of chosen) {
      const copy = { id: crypto.randomUUID(), role: item.role, text: item.text, createdAt: item.createdAt, handedOverFrom: item.id, ...(item.source ? { source: item.source } : {}) };
      if (item.role === 'assistant') copy.replyToId = task.messages[0].id;
      if (item.artifacts?.length && typeof this.documentService?.getFilePath === 'function') {
        const paths = [];
        for (const artifact of item.artifacts.slice(0, 10)) {
          try { paths.push(await this.documentService.getFilePath(artifact.id)); } catch { /* removed meanwhile */ }
        }
        if (paths.length) {
          const saved = await this.documentService.upload(target.id, paths, { origin: { taskId: task.id, taskTitle: task.title, workspace: target.name, agent: item.source, messageId: copy.id } });
          copy.artifacts = saved.map(document => ({ id: document.id, name: document.name }));
        }
      }
      copies.push(copy);
    }
    task.messages.push(...copies);
    task.agentRun = { status: 'done', updatedAt: now };
    task.createdAt = now;
    task.updatedAt = now;
    const saved = await this.store.update(draft => {
      const current = draft.tasks.find(item => item.id === taskId);
      if (!current) throw new Error('工作不存在');
      if (current.handedOver) throw new Error(`这项工作已移交到「${current.handedOver.workspace}」`);
      current.handedOver = { taskId: task.id, workspace: target.name, at: now, messageCount: copies.length };
      current.updatedAt = now;
      draft.tasks.unshift(task);
      return draft;
    });
    this.publish(saved);
    return task;
  }

  // The owner may let colleagues' follow-ups use the full conversation.
  async setConversationShared(taskId, shared) {
    let result;
    const data = await this.store.update(draft => {
      const task = draft.tasks.find(item => item.id === taskId);
      if (!task) throw new Error('工作不存在');
      if (spaceNamed(draft, task.workspace)?.type === 'personal') throw new Error('个人空间的工作不能共享给同事');
      task.conversationShared = Boolean(shared);
      result = task;
      return draft;
    });
    this.publish(data);
    return result;
  }

  // ---- 进展：confirm, edit, dismiss, or add by hand ----

  async updateProgress(taskId, itemId, { action, text, kind } = {}) {
    if (!['publish', 'dismiss', 'edit', 'unpublish'].includes(action)) throw new Error('进展操作无效');
    let updated;
    const data = await this.store.update(draft => {
      const task = draft.tasks.find(item => item.id === taskId);
      const entry = task?.progress?.find(item => item.id === itemId);
      if (!entry) throw new Error('进展不存在');
      const at = new Date().toISOString();
      if (text != null) {
        const next = progress.validText(text);
        if (next !== entry.text) entry.originalText ||= entry.text;
        entry.text = next;
      }
      if (kind != null) entry.kind = progress.validKind(kind);
      if (action === 'publish') Object.assign(entry, { status: 'published', publishedAt: at });
      if (action === 'dismiss') Object.assign(entry, { status: 'dismissed', dismissedAt: at });
      if (action === 'unpublish') Object.assign(entry, { status: 'draft', publishedAt: null });
      task.updatedAt = at;
      updated = entry;
      return draft;
    });
    this.publish(data);
    return updated;
  }

  async publishAllProgress(taskId) {
    let count = 0;
    const data = await this.store.update(draft => {
      const task = draft.tasks.find(item => item.id === taskId);
      if (!task) throw new Error('任务不存在');
      const at = new Date().toISOString();
      for (const entry of task.progress || []) if (entry.status === 'draft') { Object.assign(entry, { status: 'published', publishedAt: at }); count++; }
      if (count) task.updatedAt = at;
      return draft;
    });
    this.publish(data);
    return { published: count };
  }

  async addProgress(taskId, { kind, text, author = 'local-user' }) {
    const entry = { id: crypto.randomUUID(), kind: progress.validKind(kind), text: progress.validText(text), status: 'published', author, sourceMessageId: null, createdAt: new Date().toISOString() };
    entry.publishedAt = entry.createdAt;
    const data = await this.store.update(draft => {
      const task = draft.tasks.find(item => item.id === taskId);
      if (!task) throw new Error('任务不存在');
      task.progress = [...(task.progress || []), entry].slice(-200);
      task.updatedAt = entry.createdAt;
      return draft;
    });
    this.publish(data);
    return entry;
  }

  async setRelatedWorkspaces(taskId, names) {
    let updated;
    const data = await this.store.update(draft => {
      const task = draft.tasks.find(item => item.id === taskId);
      if (!task) throw new Error('任务不存在');
      if (names.length) task.relatedWorkspaces = names; else delete task.relatedWorkspaces;
      task.updatedAt = new Date().toISOString();
      updated = task;
      return draft;
    });
    this.publish(data);
    return updated;
  }

  async recordAnswer(taskId, triggerId, answer) {
    const failed = answer?.source === 'connection-error';
    // Take the declared key progress out of the reply; keep it as drafts.
    let drafts = [];
    if (answer?.role === 'assistant' && !failed && answer.source !== 'workbuddy-pending' && typeof answer.text === 'string') {
      const extracted = progress.extractProgress(answer.text);
      answer.text = extracted.text;
      const items = extracted.found ? extracted.items : progress.fallbackProgress(extracted.text, answer.artifacts || []);
      const existing = (await this.store.read()).tasks.find(item => item.id === taskId)?.progress || [];
      drafts = progress.draft(progress.dedupe(items, existing), { sourceMessageId: answer.id, author: 'agent' });
      const personalUse = drafts.length ? await this.personalContextOf(taskId, triggerId) : null;
      if (personalUse) for (const item of drafts) item.personal = personalUse;
    }
    const isolatedSession = Boolean(answer?.isolatedSession);
    if (answer) delete answer.isolatedSession;
    const finished = await this.store.update(draft => {
      const current = draft.tasks.find(item => item.id === taskId);
      if (!current) return draft;
      if (answer) { const { agentSessionId, agentSessionOwner, ...visible } = answer; current.messages.push({ ...(isolatedSession ? visible : answer), replyToId: triggerId }); }
      if (drafts.length) current.progress = [...(current.progress || []), ...drafts].slice(-200);
      // A colleague's isolated run must not replace (or reveal) the owner's Agent session.
      if (answer?.agentSessionId && !isolatedSession) {
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
      await this.attachAnswerFiles(task, answer);
    }
    await this.recordAnswer(taskId, triggerId, answer);
    return { taskId, messageId: answer.id, files: answer.artifacts || [] };
  }

  async markInterrupted() {
    const interrupted = [];
    const data = await this.store.update(draft => {
      for (const task of draft.tasks) {
        if (['queued', 'running'].includes(task.agentRun?.status)) {
          interrupted.push({ taskId: task.id, triggerId: task.agentRun.triggerId });
          task.agentRun = { ...task.agentRun, status: 'interrupted', updatedAt: new Date().toISOString() };
        }
      }
      return draft;
    });
    this.interruptedAtStart = interrupted;
    this.publish(data);
  }

  // After the app restarts, CloudAgent work that was running is picked up
  // again: the sandbox kept working, and the run finds its own turn in the
  // session replay (or waits for it to finish) instead of sending it twice.
  async resumeCloudRuns() {
    const pending = this.interruptedAtStart || [];
    this.interruptedAtStart = [];
    if (!pending.length) return [];
    const runtime = await this.settingsService.getRuntimeConfig();
    const data = await this.store.read();
    const resumed = [];
    for (const { taskId, triggerId } of pending) {
      const task = data.tasks.find(item => item.id === taskId);
      if (!task || task.agentRun?.status !== 'interrupted' || task.agentRun.triggerId !== triggerId) continue;
      if ((task.agentMode || runtime.agent?.mode) !== 'cloudagent' || this.queues.has(taskId)) continue;
      this.schedule(taskId, triggerId);
      resumed.push(taskId);
    }
    return resumed;
  }
}

module.exports = { TaskRunner, messagesThroughTrigger, usesWorkBuddyHandoff, usesWorkBuddyOpenApi };
