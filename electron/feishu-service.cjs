// Feishu / Lark self-built app: send a text message to one person.
// https://open.feishu.cn/document/server-docs/im-v1/message/create
//
// Credentials: App ID (settings) + App Secret (encrypted credentials). The app
// needs the bot capability, the im:message:send_as_bot scope, and the
// recipient inside the app's availability range. No prior chat is required.
const FEISHU_BASE = 'https://open.feishu.cn';
const LARK_BASE = 'https://open.larksuite.com';

class FeishuSendError extends Error {
  constructor(message, deliveryUnknown = false) { super(message); this.deliveryUnknown = deliveryUnknown; }
}

const baseOf = config => (config.feishu?.domain === 'lark' ? LARK_BASE : FEISHU_BASE);

// A member's Feishu id may be an email, an open_id (ou_), a union_id (on_) or
// the tenant user_id shown in the admin console.
function feishuReceiver(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 120) throw new FeishuSendError('请填写同事的飞书邮箱、user_id 或 open_id');
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) return { type: 'email', id };
  if (/^ou_[A-Za-z0-9]+$/.test(id)) return { type: 'open_id', id };
  if (/^on_[A-Za-z0-9]+$/.test(id)) return { type: 'union_id', id };
  if (/^[A-Za-z0-9_-]{1,80}$/.test(id)) return { type: 'user_id', id };
  throw new FeishuSendError('飞书 ID 格式无效：请填写邮箱、user_id 或 open_id');
}

function requireFeishuConfig(config) {
  const appId = String(config.feishu?.appId || '').trim();
  const appSecret = String(config.feishuAppSecret || '').trim();
  if (!appId || !appSecret) throw new FeishuSendError('请先在设置中填写飞书自建应用的 App ID 和 App Secret');
  return { appId, appSecret };
}

const feishuConfigured = config => Boolean(config?.feishu?.appId && config?.feishuAppSecret);

async function postJson(fetchImpl, url, body, token) {
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json; charset=utf-8', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  } catch { throw new FeishuSendError('无法连接飞书开放平台，请检查网络', true); }
  let data = null;
  try { data = await response.json(); } catch { /* non-JSON */ }
  return { status: response.status, data };
}

const tokenCache = new Map();

async function tenantToken(config, fetchImpl = fetch, now = Date.now) {
  const { appId, appSecret } = requireFeishuConfig(config);
  const key = `${baseOf(config)}|${appId}|${appSecret.length}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - now() > 5 * 60 * 1000) return cached.token;
  const { status, data } = await postJson(fetchImpl, `${baseOf(config)}/open-apis/auth/v3/tenant_access_token/internal`, { app_id: appId, app_secret: appSecret });
  if (data?.code !== 0 || !data?.tenant_access_token) {
    throw new FeishuSendError(`飞书应用凭据无效（${data?.code ?? `HTTP ${status}`}${data?.msg ? `：${String(data.msg).slice(0, 80)}` : ''}）；请核对 App ID 和 App Secret`);
  }
  tokenCache.set(key, { token: data.tenant_access_token, expiresAt: now() + Math.max(60, Number(data.expire) || 7200) * 1000 });
  return data.tenant_access_token;
}

const FEISHU_ERRORS = {
  230013: '这位同事不在飞书应用的可用范围内；请管理员在飞书后台把他加入应用可用范围',
  230006: '飞书应用还没有开启机器人能力；请在飞书开发者后台开启「机器人」',
  99991672: '飞书应用缺少发消息权限；请申请 im:message:send_as_bot 并发布版本',
  230001: '飞书 ID 无效，找不到这位同事',
  99992364: '飞书 user_id 无效，找不到这位同事'
};

async function sendFeishuText(config, receiverId, text, fetchImpl = fetch) {
  const receiver = feishuReceiver(receiverId);
  const token = await tenantToken(config, fetchImpl);
  const { status, data } = await postJson(fetchImpl, `${baseOf(config)}/open-apis/im/v1/messages?receive_id_type=${receiver.type}`, {
    receive_id: receiver.id, msg_type: 'text', content: JSON.stringify({ text: String(text) })
  }, token);
  if (data?.code === 0) return { externalMessageId: data.data?.message_id || null, channel: 'feishu' };
  if (data?.code === 99991663 || data?.code === 99991661) tokenCache.clear();
  if (status >= 500 && data?.code == null) throw new FeishuSendError('飞书暂时不可用，发送结果未知；请稍后在飞书核对', true);
  throw new FeishuSendError(FEISHU_ERRORS[data?.code] || `飞书拒绝发送（${data?.code ?? `HTTP ${status}`}${data?.msg ? `：${String(data.msg).slice(0, 80)}` : ''}）`);
}

async function checkFeishu(config, fetchImpl = fetch) {
  await tenantToken(config, fetchImpl);
  return { ok: true, message: '飞书应用凭据有效；发送权限与可用范围在第一次 @ 同事时验证' };
}

module.exports = { sendFeishuText, checkFeishu, feishuReceiver, feishuConfigured, FeishuSendError, tokenCache, FEISHU_BASE, LARK_BASE };
