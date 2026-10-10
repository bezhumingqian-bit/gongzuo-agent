const OFFICIAL_MODEL_PORTALS = Object.freeze({
  openai: 'https://platform.openai.com/api-keys',
  kimi: 'https://platform.kimi.com/',
  deepseek: 'https://platform.deepseek.com/'
});
const WORKBUDDY_PORTAL = 'https://open.workbuddy.cn/settings/developer';

function modelPortalUrl(provider) {
  const url = OFFICIAL_MODEL_PORTALS[provider];
  if (!url) throw new Error('当前模型提供方没有统一的官网登录入口');
  return url;
}

module.exports = { modelPortalUrl, WORKBUDDY_PORTAL };
