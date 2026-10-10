const crypto = require('node:crypto');
const { callModel, callExternalAgent } = require('./connection-service.cjs');
const { callCodeBuddy } = require('./codebuddy-service.cjs');
const { callWorkBuddy } = require('./workbuddy-service.cjs');
const path = require('node:path');
const { callLocalAgent, callLocalAgentSession } = require('./local-agent-service.cjs');

const COMPLETION_WORDS = /(已完成|做完了|处理完了|已经解决|可以发布|验收通过)/;
const HIGH_IMPACT_WORDS = /(负责人|截止时间|延期|预算|发布到外部|删除|权限)/;

function createLocalTask({ goal, workspace }) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: goal.length > 28 ? `${goal.slice(0, 28)}…` : goal,
    goal,
    workspace,
    status: 'running',
    needsMe: false,
    createdAt: now,
    updatedAt: now,
    messages: [{ id: crypto.randomUUID(), role: 'user', text: goal, createdAt: now }],
    steps: [
      { id: crypto.randomUUID(), title: '确认目标与可用资料', status: 'done' },
      { id: crypto.randomUUID(), title: '形成执行计划', status: 'running' },
      { id: crypto.randomUUID(), title: '交付可检查的成果', status: 'todo' }
    ]
  };
}

function classifyChannelEvent(event) {
  const text = String(event.text || '').trim();
  if (!text) return { action: 'archive', reason: 'empty' };
  if (HIGH_IMPACT_WORDS.test(text)) {
    return { action: 'suggest', reason: 'high-impact-field', suggestion: '请负责人确认后更新任务' };
  }
  if (COMPLETION_WORDS.test(text)) {
    return { action: 'auto-update', reason: 'explicit-completion', patch: { progressConfirmed: true } };
  }
  return { action: 'archive', reason: 'context-only' };
}

class AgentService {
  constructor(fetchImpl = fetch, codeBuddyImpl = callCodeBuddy) {
    this.mode = 'local';
    this.fetchImpl = fetchImpl;
    this.codeBuddyImpl = codeBuddyImpl;
    this.sessionsRoot = null;
  }

  getStatus(settings) {
    const configured = settings?.agent?.mode === 'external'
      ? Boolean(settings.agent.endpoint)
      : ['codebuddy', 'codex', 'kimi'].includes(settings?.agent?.mode)
        ? true
        : settings?.agent?.mode === 'workbuddy'
          ? Boolean(settings.hasWorkbuddyAccessToken)
        : Boolean(settings?.model?.modelId && (settings.model.provider === 'local' || settings.hasModelKey));
    const kind = ['external', 'codebuddy', 'workbuddy', 'codex', 'kimi'].includes(settings?.agent?.mode) ? 'agent' : 'model';
    const checked = settings?.checks?.[kind];
    return {
      mode: configured || settings?.agent?.mode === 'workbuddy' ? kind : this.mode,
      label: checked?.ok ? '连接测试通过' : configured ? '已配置 · 待验证' : settings?.agent?.mode === 'workbuddy' ? 'WorkBuddy 待授权' : '本地演示模式',
      modelConnected: Boolean(checked?.ok),
      detail: checked?.ok ? '当前配置已通过连接测试；发起工作时会调用该服务。' : configured ? '发起工作时会尝试调用已配置的服务；可在设置中先测试连接。' : settings?.agent?.mode === 'workbuddy' ? '需要先完成 WorkBuddy 开放平台授权。' : '任务会保存并使用本地规则演示。'
    };
  }

  isConfigured(config) {
    if (config?.agent?.mode === 'external') return Boolean(config.agent.endpoint);
    if (config?.agent?.mode === 'codebuddy') return true;
    if (['codex', 'kimi'].includes(config?.agent?.mode)) return true;
    if (config?.agent?.mode === 'workbuddy') return Boolean(config.workbuddyAccessToken);
    return Boolean(config?.model?.modelId && (!['openai', 'kimi', 'deepseek'].includes(config.model.provider) || config.modelKey || (config.model.provider === 'openai' && process.env.OPENAI_API_KEY)));
  }

  async answer(task, config, memoryContext = {}) {
    if (!this.isConfigured(config)) return null;
    try {
      const result = config.agent.mode === 'external'
        ? await callExternalAgent(config, task.messages, task.workspace, memoryContext, this.fetchImpl)
        : config.agent.mode === 'codebuddy'
          ? await this.codeBuddyImpl(task.messages, task.workspace, memoryContext)
          : config.agent.mode === 'workbuddy'
            ? await callWorkBuddy(config, task.messages, this.fetchImpl)
          : ['codex', 'kimi'].includes(config.agent.mode)
            ? this.sessionsRoot && /^[a-zA-Z0-9-]{1,100}$/.test(task.id)
              ? await callLocalAgentSession(config.agent.mode, task.messages, task.workspace, memoryContext, {
                sessionDir: path.join(this.sessionsRoot, task.id, config.agent.mode), sessionId: task.agentSessionId
              })
              : await callLocalAgent(config.agent.mode, task.messages, task.workspace, memoryContext)
          : await callModel(config, task.messages, memoryContext, this.fetchImpl);
      const text = typeof result === 'string' ? result : result.text;
      return { id: crypto.randomUUID(), role: 'assistant', text, createdAt: new Date().toISOString(), source: ['codebuddy', 'codex', 'kimi'].includes(config.agent.mode) ? config.agent.mode : config.agent.mode === 'workbuddy' ? (result.pending ? 'workbuddy-pending' : 'workbuddy') : config.agent.mode === 'external' ? 'external-agent' : 'model', ...(result.messageId ? { externalMessageId: result.messageId } : {}), ...(result.sessionId ? { agentSessionId: result.sessionId } : {}) };
    } catch (error) {
      return { id: crypto.randomUUID(), role: 'assistant', text: `连接失败：${error.message}`, createdAt: new Date().toISOString(), source: 'connection-error' };
    }
  }

  async createTask(input, config) {
    const task = createLocalTask(input);
    const answer = await this.answer(task, config, input.memoryContext);
    if (answer) task.messages.push(answer);
    return task;
  }
}

module.exports = { AgentService, classifyChannelEvent, createLocalTask };
