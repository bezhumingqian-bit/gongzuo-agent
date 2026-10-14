const crypto = require('node:crypto');
const { callModel, callExternalAgent } = require('./connection-service.cjs');
const { callCodeBuddy } = require('./codebuddy-service.cjs');
const { callWorkBuddy } = require('./workbuddy-service.cjs');
const { callWorkBuddyCloud } = require('./workbuddy-cloud.cjs');
const { callCloudAgent } = require('./cloudagent.cjs');
const { workbuddyTransport, transportOf } = require('./workbuddy-transport.cjs');

// A cloud task belongs to the WorkBuddy account that created it. When someone
// else continues a shared work, start their own cloud task (the full
// conversation is sent again) instead of loading one their token cannot open.
function cloudSessionFor(task, config) {
  if (!task.agentSessionId) return undefined;
  const owner = task.agentSessionOwner || null;
  const current = config.workbuddyOpenId || null;
  return owner && current && owner !== current ? undefined : task.agentSessionId;
}
const path = require('node:path');
const { callLocalAgent, callLocalAgentSession } = require('./local-agent-service.cjs');

const { classifyChannelEvent } = require('./contracts/policy.cjs');

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
      : ['codebuddy', 'codex', 'kimi', 'workbuddy'].includes(settings?.agent?.mode)
        ? true
        : settings?.agent?.mode === 'cloudagent'
          ? Boolean(settings.hasCloudagentApiKey || settings.cloudagentKeychain)
        : Boolean(settings?.model?.modelId && (settings.model.provider === 'local' || settings.hasModelKey));
    const kind = ['external', 'codebuddy', 'workbuddy', 'cloudagent', 'codex', 'kimi'].includes(settings?.agent?.mode) ? 'agent' : 'model';
    const checked = settings?.checks?.[kind];
    const transport = settings?.agent?.mode === 'workbuddy' ? workbuddyTransport(settings.agent, settings.hasWorkbuddyAccessToken) : null;
    const handoff = transport === 'handoff';
    const missingToken = transport && transport !== 'handoff' && !settings.hasWorkbuddyAccessToken;
    if (missingToken) return { mode: this.mode, label: 'WorkBuddy 待授权', modelConnected: false, detail: `WorkBuddy ${transport === 'cloud' ? '云端任务' : '本地助理'}需要开放平台访问令牌。` };
    return {
      mode: configured ? kind : this.mode,
      label: checked?.ok ? '连接测试通过' : settings?.agent?.mode === 'cloudagent' ? (configured ? 'CodeBuddy 云端' : 'CodeBuddy 云端 · 缺少 API Key') : handoff ? 'WorkBuddy 本机连接' : transport === 'cloud' ? 'WorkBuddy 云端任务' : configured ? '已配置 · 待验证' : '本地演示模式',
      modelConnected: Boolean(checked?.ok),
      detail: handoff
        ? '工作会排队等待 WorkBuddy 通过本机连接器领取，处理结果回到同一项工作。'
        : checked?.ok ? '当前配置已通过连接测试；发起工作时会调用该服务。' : configured ? '发起工作时会尝试调用已配置的服务；可在设置中先测试连接。' : '任务会保存并使用本地规则演示。'
    };
  }

  isConfigured(config) {
    if (config?.agent?.mode === 'external') return Boolean(config.agent.endpoint);
    if (config?.agent?.mode === 'codebuddy') return true;
    if (config?.agent?.mode === 'cloudagent') return Boolean(config.cloudagentApiKey);
    if (['codex', 'kimi'].includes(config?.agent?.mode)) return true;
    // The local MCP hand-off needs no credentials; Open API transports need a token.
    if (config?.agent?.mode === 'workbuddy') return transportOf(config) === 'handoff' || Boolean(config.workbuddyAccessToken);
    return Boolean(config?.model?.modelId && (!['openai', 'kimi', 'deepseek'].includes(config.model.provider) || config.modelKey || (config.model.provider === 'openai' && process.env.OPENAI_API_KEY)));
  }

  async answer(task, config, memoryContext = {}, hooks = {}) {
    if (!this.isConfigured(config)) return null;
    const transport = config.agent.mode === 'workbuddy' ? transportOf(config) : null;
    // The local hand-off is pulled by WorkBuddy; TaskRunner never calls answer() for it.
    if (transport === 'handoff') return null;
    try {
      const result = config.agent.mode === 'external'
        ? await callExternalAgent(config, task.messages, task.workspace, memoryContext, this.fetchImpl)
        : config.agent.mode === 'codebuddy'
          ? await this.codeBuddyImpl(task.messages, task.workspace, memoryContext)
          : config.agent.mode === 'cloudagent'
            ? await (this.cloudAgentImpl || callCloudAgent)(config, task.messages, task.workspace, memoryContext, { sessionId: task.agentSessionId, workId: task.id, title: task.title, onProgress: hooks.onProgress, fetchImpl: this.fetchImpl })
          : transport === 'cloud'
            ? await (this.cloudImpl || callWorkBuddyCloud)(config, task.messages, task.workspace, memoryContext, { sessionId: cloudSessionFor(task, config), title: task.title, onProgress: hooks.onProgress, fetchImpl: this.fetchImpl })
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
      return { id: crypto.randomUUID(), role: 'assistant', text, createdAt: new Date().toISOString(), source: ['codebuddy', 'codex', 'kimi', 'cloudagent'].includes(config.agent.mode) ? config.agent.mode : config.agent.mode === 'workbuddy' ? (result.pending ? 'workbuddy-pending' : 'workbuddy') : config.agent.mode === 'external' ? 'external-agent' : 'model', ...(result.messageId ? { externalMessageId: result.messageId } : {}), ...(result.sessionId ? { agentSessionId: result.sessionId } : {}), ...(transport === 'cloud' ? { via: 'cloud-task', agentSessionOwner: config.workbuddyOpenId || null } : {}), ...(result.files?.length ? { pendingFiles: result.files, pendingFilesDirectory: result.filesDirectory } : {}) };
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

module.exports = { AgentService, classifyChannelEvent, createLocalTask, cloudSessionFor };
