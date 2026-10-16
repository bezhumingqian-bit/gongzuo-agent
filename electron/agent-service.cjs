const crypto = require('node:crypto');
const { callCodeBuddy } = require('./codebuddy-service.cjs');
const { retrieveCloudArtifacts } = require('./cloudagent.cjs');
const { workbuddyTransport, transportOf } = require('./workbuddy-transport.cjs');
const { adapterFor } = require('./harness/adapters.cjs');

// Who a cloud session belongs to: the WorkBuddy open_id, or the CodeBuddy API
// key id (the part before the dot; never the secret).
function sessionOwner(config) {
  if (config?.agent?.mode === 'cloudagent') {
    const key = String(config.cloudagentApiKey || '');
    if (!key) return null;
    return key.startsWith('ck_') && key.includes('.') ? key.split('.')[0] : `key:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
  }
  return config?.workbuddyOpenId || null;
}

// A cloud task / sandbox belongs to the account that created it. When someone
// else continues a shared work, start their own (the full conversation is sent
// again) instead of loading one their credentials cannot open.
function cloudSessionFor(task, config) {
  if (!task.agentSessionId) return undefined;
  const owner = task.agentSessionOwner || null;
  const current = sessionOwner(config);
  return owner && current && owner !== current ? undefined : task.agentSessionId;
}
const path = require('node:path');
const { callLocalAgent, callLocalAgentSession } = require('./local-agent-service.cjs');

const { classifyChannelEvent } = require('./contracts/policy.cjs');
const { isCasualPrompt } = require('../demo/work-index.js');

function createLocalTask({ goal, workspace, hasContext = false }) {
  const now = new Date().toISOString();
  const kind = !hasContext && isCasualPrompt(goal) ? 'conversation' : 'work';
  return {
    id: crypto.randomUUID(),
    title: goal.length > 28 ? `${goal.slice(0, 28)}…` : goal,
    titleSource: 'auto',
    kind,
    goal,
    workspace,
    status: 'running',
    needsMe: false,
    createdAt: now,
    updatedAt: now,
    messages: [{ id: crypto.randomUUID(), role: 'user', text: goal, createdAt: now }],
    steps: kind === 'conversation' ? [] : [
      { id: crypto.randomUUID(), title: '确认目标与可用资料', status: 'pending' },
      { id: crypto.randomUUID(), title: '形成执行计划', status: 'pending' },
      { id: crypto.randomUUID(), title: '交付可检查的成果', status: 'pending' }
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
      label: checked?.ok ? '连接测试通过' : settings?.agent?.mode === 'cloudagent' ? (configured ? '共作 Agent · 云端执行' : '共作 Agent · 缺少 CodeBuddy API Key') : handoff ? 'WorkBuddy 本机连接' : transport === 'cloud' ? 'WorkBuddy 云端任务' : configured ? '已配置 · 待验证' : '本地演示模式',
      modelConnected: Boolean(checked?.ok),
      detail: handoff
        ? '工作会排队等待 WorkBuddy 通过本机连接器领取，处理结果回到同一项工作。'
        : checked?.ok ? '当前配置已通过连接测试；发起工作时会调用该服务。' : configured ? '发起工作时会尝试调用已配置的服务；可在设置中先测试连接。' : '任务会保存并使用本地规则演示。'
    };
  }

  isConfigured(config) {
    return Boolean(config && adapterFor(config).isConfigured(config));
  }

  async answer(task, config, memoryContext = {}, hooks = {}) {
    if (!this.isConfigured(config)) return null;
    const transport = config.agent.mode === 'workbuddy' ? transportOf(config) : null;
    // The local hand-off is pulled by WorkBuddy; TaskRunner never calls answer() for it.
    if (transport === 'handoff') return null;
    const adapter = adapterFor(config);
    try {
      const result = await adapter.run({ service: this, task, config, memory: memoryContext, hooks, cloudSession: cloudSessionFor(task, config) });
      const text = typeof result === 'string' ? result : result.text;
      return { id: crypto.randomUUID(), role: 'assistant', text, createdAt: new Date().toISOString(), source: adapter.source(result, config), ...(result.messageId ? { externalMessageId: result.messageId } : {}), ...(result.viaRelay ? { via: 'localassistant-relay' } : {}), ...(result.sessionId ? { agentSessionId: result.sessionId } : {}), ...(result.stopReason ? { stopReason: result.stopReason } : {}), ...(transport === 'cloud' ? { via: 'cloud-task', agentSessionOwner: sessionOwner(config) } : {}), ...(config.agent.mode === 'cloudagent' ? { agentSessionOwner: sessionOwner(config) } : {}), ...(result.files?.length ? { pendingFiles: result.files, pendingFilesDirectory: result.filesDirectory } : {}), ...(result.kernel ? { kernel: result.kernel } : {}), ...(result.proposals?.length ? { proposals: result.proposals } : {}), ...(result.approvals?.length ? { approvals: result.approvals } : {}) };
    } catch (error) {
      return { id: crypto.randomUUID(), role: 'assistant', text: `连接失败：${error.message}`, createdAt: new Date().toISOString(), source: 'connection-error' };
    }
  }

  // Files a CloudAgent work left in its sandbox (/workspace/artifacts).
  retrieveCloudFiles(config, sessionId, options = {}) {
    return (this.retrieveCloudImpl || retrieveCloudArtifacts)(config, sessionId, { fetchImpl: this.fetchImpl, ...options });
  }

  async createTask(input, config) {
    const task = createLocalTask(input);
    const answer = await this.answer(task, config, input.memoryContext);
    if (answer) task.messages.push(answer);
    return task;
  }
}

module.exports = { AgentService, classifyChannelEvent, createLocalTask, cloudSessionFor, sessionOwner };
