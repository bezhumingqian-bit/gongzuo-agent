const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { channelOptions, configureRuntimeChannel, taskLink } = require('../electron/runtime-channel.cjs');
const previewBuild = require('../build/preview.cjs');

test('预览安装包有独立名称与应用 ID，不注册旧版协议，不包含源码配置与凭据', () => {
  assert.equal(previewBuild.productName, '共作预览版');
  assert.equal(previewBuild.appId, 'cn.gongzuo.agent.preview');
  assert.deepEqual(previewBuild.protocols.flatMap(item => item.schemes), ['gongzuo-preview']);
  assert.equal(previewBuild.extraMetadata.gongzuoChannel, 'preview');
  assert.deepEqual(previewBuild.files, ['electron/**/*', 'demo/**/*', 'package.json']);
});

test('预览版沿用开发数据，正式版不改变路径；测试可覆盖数据目录', () => {
  const base = '/Users/example/Library/Application Support';
  const preview = channelOptions({ gongzuoChannel: 'preview' }, base);
  assert.equal(preview.userData, path.join(base, 'gongzuo-agent-dev'));
  assert.equal(preview.displayName, '共作预览版');
  assert.equal(preview.scheme, 'gongzuo-preview');
  assert.equal(channelOptions({}, base).userData, null);
  assert.equal(channelOptions({}, base).scheme, 'gongzuo');
  assert.equal(channelOptions({ gongzuoChannel: 'preview' }, base, '/tmp/test-preview').userData, '/tmp/test-preview');
});

test('运行时在加锁前配置名称、业务目录与浏览器缓存目录', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gongzuo-channel-test-'));
  const calls = [];
  const app = {
    getPath: () => directory,
    commandLine: { getSwitchValue: () => '' },
    setName: value => calls.push(['name', value]),
    setPath: (key, value) => calls.push([key, value])
  };
  try {
    configureRuntimeChannel(app, { gongzuoChannel: 'preview' });
    assert.deepEqual(calls, [
      ['name', '共作预览版'],
      ['userData', path.join(directory, 'gongzuo-agent-dev')],
      ['sessionData', path.join(directory, 'gongzuo-agent-dev')]
    ]);
    assert.ok(fs.statSync(path.join(directory, 'gongzuo-agent-dev')).isDirectory());
    assert.equal(taskLink('abc-1'), 'gongzuo-preview://task/abc-1', '预览版发出的链接只打开预览版');
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test('换了应用后无法解密的旧密钥视为未配置，不阻断启动', async () => {
  const { SettingsService } = require('../electron/settings-service.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gongzuo-cred-test-'));
  try {
    fs.writeFileSync(path.join(directory, 'credentials.json'), JSON.stringify({ modelKey: null, modelKeys: {}, agentToken: Buffer.from('x').toString('base64'), wecomSecret: null, wecomBotSecret: null, workbuddyAccessToken: null }));
    const service = new SettingsService(path.join(directory, 'settings.json'), path.join(directory, 'credentials.json'), { isEncryptionAvailable: () => true, decryptString: () => { throw new Error('Error while decrypting'); } });
    await service.initialize();
    assert.equal((await service.getRuntimeConfig()).agentToken, null);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
