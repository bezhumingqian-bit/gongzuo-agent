// Execution adapters: one entry per Agent mode, all behind the same contract
// (docs/MODULAR_PLATFORM.md「Agent 与工具」, docs/HARNESS.md).
//
//   { id, capabilities, isConfigured(config), run(ctx) → string | { text, ... }, source(result, config) }
//
// ctx = { service, task, config, memory, hooks }. The outer harness (context,
// sessions, timeline, approvals, progress) stays in TaskRunner; adapters only
// talk to their engine.
const path = require('node:path');
const { callExternalAgent } = require('../connection-service.cjs');
const { callWorkBuddy } = require('../workbuddy-service.cjs');
const { callWorkBuddyCloud } = require('../workbuddy-cloud.cjs');
const { callCloudAgent } = require('../cloudagent.cjs');
const { transportOf } = require('../workbuddy-transport.cjs');
const { callLocalAgent, callLocalAgentSession } = require('../local-agent-service.cjs');
const { callKernel } = require('./kernel-adapter.cjs');

const modelKeyReady = config => Boolean(config?.model?.modelId && (!['openai', 'kimi', 'deepseek'].includes(config.model.provider) || config.modelKey || (config.model.provider === 'openai' && process.env.OPENAI_API_KEY)));

function localAgent(kind) {
  return {
    id: kind,
    capabilities: ['text', 'resume'],
    isConfigured: () => true,
    run: ({ service, task, config, memory }) => (service.sessionsRoot && /^[a-zA-Z0-9-]{1,100}$/.test(task.id)
      ? callLocalAgentSession(kind, task.messages, task.workspace, memory, { sessionDir: path.join(service.sessionsRoot, task.id, kind), sessionId: task.agentSessionId })
      : callLocalAgent(kind, task.messages, task.workspace, memory)),
    source: () => kind
  };
}

const ADAPTERS = {
  // 共作内核（线 B）：自有模型 API + 共作工具（K0）。
  'built-in': {
    id: 'built-in',
    capabilities: ['text', 'tools'],
    isConfigured: modelKeyReady,
    run: ({ service, task, config, memory, hooks }) => (service.kernelImpl || callKernel)(config, task, memory, hooks, { fetchImpl: service.fetchImpl }),
    source: result => (result?.kernel && !result.kernel.fallback ? 'kernel' : 'model')
  },
  external: {
    id: 'external',
    capabilities: ['text'],
    isConfigured: config => Boolean(config.agent.endpoint),
    run: ({ service, task, config, memory }) => callExternalAgent(config, task.messages, task.workspace, memory, service.fetchImpl),
    source: () => 'external-agent'
  },
  codebuddy: {
    id: 'codebuddy',
    capabilities: ['text'],
    isConfigured: () => true,
    run: ({ service, task, memory }) => service.codeBuddyImpl(task.messages, task.workspace, memory),
    source: () => 'codebuddy'
  },
  // 线 A：CodeBuddy CloudAgent 托管内核。
  cloudagent: {
    id: 'cloudagent',
    capabilities: ['text', 'tools', 'files', 'resume', 'cloud'],
    isConfigured: config => Boolean(config.cloudagentApiKey),
    run: ({ service, task, config, memory, hooks, cloudSession }) => (service.cloudAgentImpl || callCloudAgent)(config, task.messages, task.workspace, memory, { sessionId: cloudSession, workId: task.id, title: task.title, turnStartedAt: task.agentRun?.startedAt, onProgress: hooks.onProgress, onPermission: hooks.onPermission, fetchImpl: service.fetchImpl }),
    source: () => 'cloudagent'
  },
  workbuddy: {
    id: 'workbuddy',
    capabilities: ['text', 'tools', 'files'],
    // The local MCP hand-off needs no credentials; Open API transports need a token.
    isConfigured: config => transportOf(config) === 'handoff' || Boolean(config.workbuddyAccessToken),
    run: ({ service, task, config, memory, hooks, cloudSession }) => (transportOf(config) === 'cloud'
      ? (service.cloudImpl || callWorkBuddyCloud)(config, task.messages, task.workspace, memory, { sessionId: cloudSession, title: task.title, onProgress: hooks.onProgress, fetchImpl: service.fetchImpl })
      : callWorkBuddy(config, task.messages, service.fetchImpl, undefined, memory)),
    source: result => (result?.pending ? 'workbuddy-pending' : 'workbuddy')
  },
  codex: localAgent('codex'),
  kimi: localAgent('kimi')
};

const adapterFor = config => ADAPTERS[config?.agent?.mode] || ADAPTERS['built-in'];

module.exports = { ADAPTERS, adapterFor, modelKeyReady };
