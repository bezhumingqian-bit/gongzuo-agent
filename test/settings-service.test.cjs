const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SettingsService, normalizeSettings } = require('../electron/settings-service.cjs');

const storage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`encrypted:${value}`),
  decryptString: value => value.toString().replace(/^encrypted:/, '')
};

test('settings persist without returning plaintext credentials to the renderer', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-settings-'));
  try {
    const settingsPath = path.join(directory, 'settings.json');
    const credentialsPath = path.join(directory, 'credentials.json');
    const service = new SettingsService(settingsPath, credentialsPath, storage);
    await service.initialize();
    const publicSettings = await service.save({
      model: { provider: 'openai', modelId: 'example-model', baseUrl: 'https://api.openai.com/v1' },
      agent: { mode: 'external', endpoint: 'https://agent.example.com' },
      wecom: { organizationId: 'example-org', applicationId: '100001', recipientUserId: 'user_1', botId: 'bot_1', messageScope: 'mentions' },
      modelKey: 'test-model-secret',
      agentToken: 'test-agent-secret',
      wecomSecret: 'test-wecom-secret',
      wecomBotSecret: 'test-bot-secret',
      workbuddyAccessToken: 'test-workbuddy-token'
    });
    assert.equal(publicSettings.hasModelKey, true);
    assert.equal(publicSettings.hasAgentToken, true);
    assert.equal(publicSettings.hasWecomSecret, true);
    assert.equal(publicSettings.hasWecomBotSecret, true);
    assert.equal(publicSettings.hasWorkbuddyAccessToken, true);
    assert.equal(JSON.stringify(publicSettings).includes('test-model-secret'), false);
    assert.equal((await fs.readFile(credentialsPath, 'utf8')).includes('test-model-secret'), false);
    assert.equal((await fs.readFile(credentialsPath, 'utf8')).includes('test-wecom-secret'), false);
    assert.equal((await fs.readFile(credentialsPath, 'utf8')).includes('test-bot-secret'), false);
    assert.equal((await fs.readFile(credentialsPath, 'utf8')).includes('test-workbuddy-token'), false);
    assert.equal((await fs.readFile(settingsPath, 'utf8')).includes('test-agent-secret'), false);
    assert.equal((await service.getRuntimeConfig()).modelKey, 'test-model-secret');
    assert.equal((await service.getRuntimeConfig()).wecomSecret, 'test-wecom-secret');
    assert.equal((await service.getRuntimeConfig()).wecomBotSecret, 'test-bot-secret');
    assert.equal((await service.getRuntimeConfig()).workbuddyAccessToken, 'test-workbuddy-token');
    assert.equal(publicSettings.wecom.recipientUserId, 'user_1');
    await service.recordCheck('wecom', { ok: true, message: '凭据有效' });
    assert.equal((await service.getPublic()).checks.wecom.ok, true);
    await service.save({ ...publicSettings, clearModelKey: true });
    assert.equal((await service.getPublic()).hasModelKey, false);
    assert.deepEqual((await service.getPublic()).checks, {});
    assert.equal((await service.getRuntimeConfig()).agentToken, 'test-agent-secret');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('model and agent endpoints reject remote HTTP and embedded credentials', () => {
  const base = { model: { provider: 'compatible', modelId: 'test', baseUrl: 'https://example.com/v1' }, agent: { mode: 'built-in', endpoint: '' } };
  assert.throws(() => normalizeSettings({ ...base, model: { ...base.model, baseUrl: 'http://example.com/v1' } }), /HTTPS/);
  assert.throws(() => normalizeSettings({ ...base, agent: { mode: 'external', endpoint: 'https://user:pass@example.com' } }), /HTTPS/);
  assert.throws(() => normalizeSettings({ ...base, model: { provider: 'openai', modelId: 'test', baseUrl: 'https://example.com/v1' } }), /官方接口地址/);
  assert.equal(normalizeSettings({ ...base, model: { ...base.model, baseUrl: 'http://localhost:11434/v1' } }).model.baseUrl, 'http://localhost:11434/v1');
  assert.equal(normalizeSettings({ ...base, agent: { mode: 'codebuddy', endpoint: '' } }).agent.mode, 'codebuddy');
  assert.throws(() => normalizeSettings({ ...base, model: { provider: 'deepseek', modelId: 'deepseek-flash', baseUrl: 'https://attacker.example' } }), /官方接口地址/);
  assert.throws(() => normalizeSettings({ ...base, model: { provider: 'kimi', modelId: 'kimi-k3', baseUrl: 'https://attacker.example' } }), /官方接口地址/);
  assert.equal(normalizeSettings({ ...base, model: { provider: 'kimi', modelId: 'kimi-k3', baseUrl: 'https://api.moonshot.ai/v1' } }).model.provider, 'kimi');
});

test('模型配置和密钥按提供方隔离，旧版密钥保留给原提供方', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-models-'));
  try {
    const service = new SettingsService(path.join(directory, 'settings.json'), path.join(directory, 'credentials.json'), storage);
    await service.initialize();
    const form = (provider, modelId, baseUrl) => ({ model: { provider, modelId, baseUrl }, agent: { mode: 'built-in', endpoint: '' } });
    await service.save({ ...form('openai', 'example-openai', 'https://api.openai.com/v1'), modelKey: 'openai-secret' });
    await service.save(form('kimi', 'kimi-k3', 'https://api.moonshot.cn/v1'));
    assert.equal((await service.getPublic()).hasModelKey, false);
    assert.equal((await service.getRuntimeConfig()).modelKey, null);
    await service.save({ ...form('kimi', 'kimi-k3', 'https://api.moonshot.cn/v1'), modelKey: 'kimi-secret' });
    await service.save({ ...form('deepseek', 'deepseek-flash', 'https://api.deepseek.com'), modelKey: 'deepseek-secret' });
    assert.equal((await service.getRuntimeConfig()).modelKey, 'deepseek-secret');
    assert.equal((await service.getPublic()).modelProfiles.kimi.modelId, 'kimi-k3');
    await service.save(form('openai', 'example-openai', 'https://api.openai.com/v1'));
    assert.equal((await service.getRuntimeConfig()).modelKey, 'openai-secret');
    await service.save({ ...form('kimi', 'kimi-k3', 'https://api.moonshot.cn/v1'), clearModelKey: true });
    assert.equal((await service.getRuntimeConfig()).modelKey, null);
    const publicSettings = await service.getPublic();
    assert.equal(publicSettings.hasModelKeys.openai, true);
    assert.equal(publicSettings.hasModelKeys.kimi, false);
    assert.equal(publicSettings.hasModelKeys.deepseek, true);
    assert.equal(JSON.stringify(publicSettings).includes('openai-secret'), false);
    assert.equal(JSON.stringify(publicSettings).includes('deepseek-secret'), false);
    assert.equal((await fs.readFile(path.join(directory, 'credentials.json'), 'utf8')).includes('deepseek-secret'), false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('旧版单个模型密钥在切换提供方时迁移到原提供方', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-legacy-model-'));
  try {
    const service = new SettingsService(path.join(directory, 'settings.json'), path.join(directory, 'credentials.json'), storage);
    await service.initialize();
    await fs.writeFile(path.join(directory, 'credentials.json'), JSON.stringify({ modelKey: storage.encryptString('legacy-openai-key').toString('base64') }));
    await service.save({ model: { provider: 'deepseek', modelId: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' }, agent: { mode: 'built-in', endpoint: '' } });
    assert.equal((await service.getRuntimeConfig()).modelKey, null);
    await service.save({ model: { provider: 'openai', modelId: 'example', baseUrl: 'https://api.openai.com/v1' }, agent: { mode: 'built-in', endpoint: '' } });
    assert.equal((await service.getRuntimeConfig()).modelKey, 'legacy-openai-key');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
