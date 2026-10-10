const { JsonStore } = require('./store.cjs');
const { defaultWorkflow, normalizeWorkflow } = require('./workflow-service.cjs');

const defaultSettings = () => ({
  model: { provider: 'openai', modelId: '', baseUrl: 'https://api.openai.com/v1' },
  modelProfiles: {},
  agent: { mode: 'built-in', endpoint: '' },
  wecom: { organizationId: '', applicationId: '', recipientUserId: '', botId: '', messageScope: 'mentions' },
  workflow: defaultWorkflow(),
  checks: {}
});
const defaultCredentials = () => ({ modelKey: null, modelKeys: {}, agentToken: null, wecomSecret: null, wecomBotSecret: null, workbuddyAccessToken: null });

const MODEL_ENDPOINTS = Object.freeze({
  openai: ['https://api.openai.com/v1'],
  kimi: ['https://api.moonshot.cn/v1', 'https://api.moonshot.ai/v1'],
  deepseek: ['https://api.deepseek.com']
});

function savedModelKey(credentials, settings, provider = settings.model.provider) {
  return credentials.modelKeys?.[provider] || (provider === settings.model.provider ? credentials.modelKey : null);
}

function endpoint(value, field, optional = false) {
  const raw = String(value ?? '').trim();
  if (optional && !raw) return '';
  if (!raw || raw.length > 500) throw new Error(`${field}无效`);
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${field}必须是有效地址`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    throw new Error(`${field}必须使用 HTTPS，本机地址可使用 HTTP`);
  }
  if (url.search || url.hash) throw new Error(`${field}不能包含查询参数或片段`);
  return url.toString().replace(/\/$/, '');
}

function normalizeSettings(input = {}) {
  const provider = input.model?.provider;
  if (!['openai', 'kimi', 'deepseek', 'compatible', 'local'].includes(provider)) throw new Error('模型提供方无效');
  const modelId = String(input.model?.modelId ?? '').trim();
  if (modelId.length > 120 || /[\r\n]/.test(modelId)) throw new Error('模型 ID 无效');
  const mode = input.agent?.mode;
  if (!['built-in', 'external', 'codebuddy', 'workbuddy', 'codex', 'kimi'].includes(mode)) throw new Error('Agent 类型无效');
  const baseUrl = endpoint(input.model?.baseUrl, '模型接口地址');
  if (MODEL_ENDPOINTS[provider] && !MODEL_ENDPOINTS[provider].includes(baseUrl)) {
    throw new Error('官方模型提供方只能使用对应的官方接口地址；其他服务请选择兼容模式');
  }
  const agentEndpoint = endpoint(input.agent?.endpoint, 'Agent 地址', true);
  if (mode === 'external' && !agentEndpoint) throw new Error('请填写外部 Agent 地址');
  const organizationId = String(input.wecom?.organizationId ?? '').trim();
  const applicationId = String(input.wecom?.applicationId ?? '').trim();
  const recipientUserId = String(input.wecom?.recipientUserId ?? '').trim();
  const botId = String(input.wecom?.botId ?? '').trim();
  const messageScope = input.wecom?.messageScope || 'mentions';
  if (organizationId.length > 120 || applicationId.length > 120 || /[\r\n]/.test(organizationId + applicationId)) throw new Error('企业微信标识无效');
  if (applicationId && !/^[1-9]\d{0,14}$/.test(applicationId)) throw new Error('企业微信 AgentID 应为数字');
  if (recipientUserId && (!/^[A-Za-z0-9._@-]{1,64}$/.test(recipientUserId) || recipientUserId.toLowerCase() === '@all')) throw new Error('企业微信收件成员 UserID 无效');
  if (botId.length > 120 || /[\r\n]/.test(botId)) throw new Error('企业微信机器人 ID 无效');
  if (!['mentions','authorized'].includes(messageScope)) throw new Error('企业微信消息范围无效');
  return {
    model: { provider, modelId, baseUrl },
    agent: { mode, endpoint: agentEndpoint },
    wecom: { organizationId, applicationId, recipientUserId, botId, messageScope },
    workflow: normalizeWorkflow(input.workflow)
  };
}

function readSecretInput(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 8192 || !value.trim()) throw new Error(`${name}无效`);
  return value.trim();
}

class SettingsService {
  constructor(settingsPath, credentialsPath, safeStorage) {
    this.settings = new JsonStore(settingsPath, defaultSettings);
    this.credentials = new JsonStore(credentialsPath, defaultCredentials);
    this.safeStorage = safeStorage;
  }

  async initialize() {
    await Promise.all([this.settings.initialize(), this.credentials.initialize()]);
  }

  async getPublic() {
    const [settings, credentials] = await Promise.all([this.settings.read(), this.credentials.read()]);
    const modelProviders = ['openai', 'kimi', 'deepseek', 'compatible', 'local'];
    return {
      ...settings,
      checks: settings.checks || {},
      hasModelKey: Boolean(savedModelKey(credentials, settings)),
      hasModelKeys: Object.fromEntries(modelProviders.map(provider => [provider, Boolean(savedModelKey(credentials, settings, provider))])),
      hasAgentToken: Boolean(credentials.agentToken),
      hasWecomSecret: Boolean(credentials.wecomSecret),
      hasWecomBotSecret: Boolean(credentials.wecomBotSecret),
      hasWorkbuddyAccessToken: Boolean(credentials.workbuddyAccessToken),
      secretStorageAvailable: Boolean(this.safeStorage.isEncryptionAvailable()),
      connectionState: 'not-tested'
    };
  }

  async getRuntimeConfig() {
    const [settings, credentials] = await Promise.all([this.settings.read(), this.credentials.read()]);
    const decrypt = value => value ? this.safeStorage.decryptString(Buffer.from(value, 'base64')) : null;
    return { ...settings, modelKey: decrypt(savedModelKey(credentials, settings)), agentToken: decrypt(credentials.agentToken), wecomSecret: decrypt(credentials.wecomSecret), wecomBotSecret: decrypt(credentials.wecomBotSecret), workbuddyAccessToken: decrypt(credentials.workbuddyAccessToken) };
  }

  async save(input = {}) {
    const settings = normalizeSettings(input);
    const previousSettings = await this.settings.read();
    settings.modelProfiles = {
      ...(previousSettings.modelProfiles || {}),
      [previousSettings.model.provider]: previousSettings.model,
      [settings.model.provider]: settings.model
    };
    const modelKey = readSecretInput(input.modelKey, '模型密钥');
    const agentToken = readSecretInput(input.agentToken, 'Agent 令牌');
    const wecomSecret = readSecretInput(input.wecomSecret, '企业微信应用密钥');
    const wecomBotSecret = readSecretInput(input.wecomBotSecret, '企业微信机器人密钥');
    const workbuddyAccessToken = readSecretInput(input.workbuddyAccessToken, 'WorkBuddy 访问令牌');
    const clearModelKey = input.clearModelKey === true;
    const clearAgentToken = input.clearAgentToken === true;
    const clearWecomSecret = input.clearWecomSecret === true;
    const clearWecomBotSecret = input.clearWecomBotSecret === true;
    const clearWorkbuddyAccessToken = input.clearWorkbuddyAccessToken === true;
    if ((modelKey || agentToken || wecomSecret || wecomBotSecret || workbuddyAccessToken) && !this.safeStorage.isEncryptionAvailable()) {
      throw new Error('macOS 安全存储当前不可用，无法保存密钥');
    }
    const encrypted = {};
    if (modelKey) encrypted.modelKey = this.safeStorage.encryptString(modelKey).toString('base64');
    if (agentToken) encrypted.agentToken = this.safeStorage.encryptString(agentToken).toString('base64');
    if (wecomSecret) encrypted.wecomSecret = this.safeStorage.encryptString(wecomSecret).toString('base64');
    if (wecomBotSecret) encrypted.wecomBotSecret = this.safeStorage.encryptString(wecomBotSecret).toString('base64');
    if (workbuddyAccessToken) encrypted.workbuddyAccessToken = this.safeStorage.encryptString(workbuddyAccessToken).toString('base64');
    if (modelKey || agentToken || wecomSecret || wecomBotSecret || workbuddyAccessToken || clearModelKey || clearAgentToken || clearWecomSecret || clearWecomBotSecret || clearWorkbuddyAccessToken || previousSettings.model.provider !== settings.model.provider) {
      await this.credentials.update(current => ({
        ...current,
        modelKey: null,
        modelKeys: {
          ...(current.modelKeys || {}),
          ...(current.modelKey ? { [previousSettings.model.provider]: current.modelKey } : {}),
          [settings.model.provider]: clearModelKey ? null : encrypted.modelKey || current.modelKeys?.[settings.model.provider] || (settings.model.provider === previousSettings.model.provider ? current.modelKey : null)
        },
        agentToken: clearAgentToken ? null : encrypted.agentToken || current.agentToken,
        wecomSecret: clearWecomSecret ? null : encrypted.wecomSecret || current.wecomSecret,
        wecomBotSecret: clearWecomBotSecret ? null : encrypted.wecomBotSecret || current.wecomBotSecret,
        workbuddyAccessToken: clearWorkbuddyAccessToken ? null : encrypted.workbuddyAccessToken || current.workbuddyAccessToken
      }));
    }
    await this.settings.write(settings);
    return this.getPublic();
  }

  async recordCheck(kind, result) {
    if (!['model', 'agent', 'wecom'].includes(kind)) throw new Error('连接类型无效');
    await this.settings.update(current => ({
      ...current,
      checks: {
        ...(current.checks || {}),
        [kind]: { ok: result.ok === true, message: String(result.message || '').slice(0, 200), checkedAt: new Date().toISOString() }
      }
    }));
    return this.getPublic();
  }
}

module.exports = { SettingsService, defaultSettings, normalizeSettings };
