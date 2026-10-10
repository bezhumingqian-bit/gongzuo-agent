const test = require('node:test');
const assert = require('node:assert/strict');
const { modelPortalUrl, WORKBUDDY_PORTAL } = require('../electron/provider-links.cjs');

test('模型提供方入口只打开固定的官方网站', () => {
  assert.equal(modelPortalUrl('openai'), 'https://platform.openai.com/api-keys');
  assert.equal(modelPortalUrl('kimi'), 'https://platform.kimi.com/');
  assert.equal(modelPortalUrl('deepseek'), 'https://platform.deepseek.com/');
  assert.throws(() => modelPortalUrl('https://attacker.example'), /没有统一/);
  assert.throws(() => modelPortalUrl('compatible'), /没有统一/);
});

test('WorkBuddy 入口固定为开放平台开发者资料页', () => {
  assert.equal(WORKBUDDY_PORTAL, 'https://open.workbuddy.cn/settings/developer');
});
