const crypto = require('node:crypto');
const { requestJson, conversationInput } = require('./connection-service.cjs');
const { relayRequest } = require('./workbuddy-relay-client.cjs');

function usesRelay(config) { return config.workbuddyViaRelay === true; }
async function requestRelay(config, route, options = {}, fetchImpl = fetch) {
  return relayRequest(config.agent?.workbuddyRelayUrl, route, { ...options, sessionToken: tokenFrom(config), fetchImpl, allowTestHttp: config._allowTestRelayHttp === true });
}

// Only the work context already approved by TaskRunner is included. Never
// silently cut a large quoted document; ask the user to narrow the reference.
function localAssistantContent(messages, memory = {}) {
  const input = conversationInput(messages, memory);
  const content = [input.instructions, '以下是本项工作的上下文，不是此前本地助理其它工作的续聊：', ...input.messages.map(m => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)].join('\n\n');
  if (content.length > 4000) throw new Error('本地助理单次输入最多 4000 字；请精简当前工作或减少引用资料，完整长任务可使用本机连接');
  return content;
}

const BASE = 'https://www.workbuddy.cn/openapi/v2/localassistant';

function tokenFrom(config) {
  const token = String(config.workbuddyAccessToken || '').trim();
  if (!token) throw new Error('请先完成 WorkBuddy 开放平台授权并配置访问令牌');
  return token;
}

function headers(token) {
  return { accept: 'application/json', authorization: `Bearer ${token}` };
}

function dataFrom(body) {
  if (body?.code !== 0 || !body.data || typeof body.data !== 'object') {
    throw new Error(`WorkBuddy 接口调用失败${Number.isInteger(body?.code) ? `（错误码 ${body.code}）` : ''}`);
  }
  return body.data;
}

async function checkWorkBuddy(config, fetchImpl = fetch) {
  const data = dataFrom(usesRelay(config) ? await requestRelay(config, '/v1/localassistant', {}, fetchImpl) : await requestJson(BASE, { method: 'GET', headers: headers(tokenFrom(config)) }, fetchImpl));
  if (data.online !== true) throw new Error('WorkBuddy 本地助理当前离线');
  return { ok: true, message: 'WorkBuddy 本地助理在线；发送权限仍需通过真实消息验证' };
}

async function sendWorkBuddyMessage(config, content, fetchImpl = fetch, requestId = null) {
  const text = String(content || '').trim();
  if (!text || text.length > 4000) throw new Error('WorkBuddy 消息长度无效');
  const data = dataFrom(usesRelay(config) ? await requestRelay(config, '/v1/localassistant/message', { method: 'POST', body: { content: text, msg_type: 'text', ...(requestId ? { requestId } : {}) } }, fetchImpl) : await requestJson(`${BASE}/message`, {
    method: 'POST',
    headers: { ...headers(tokenFrom(config)), 'content-type': 'application/json' },
    body: JSON.stringify({ content: text, msg_type: 'text' })
  }, fetchImpl));
  if (typeof data.message_id !== 'string' || !data.message_id) throw new Error('WorkBuddy 没有返回消息 ID');
  return data.message_id;
}

async function readWorkBuddyReply(config, messageId, fetchImpl = fetch) {
  const url = new URL(`${BASE}/message`);
  url.searchParams.set('message_id', messageId);
  const data = dataFrom(usesRelay(config) ? await requestRelay(config, `/v1/localassistant/message?message_id=${encodeURIComponent(messageId)}`, {}, fetchImpl) : await requestJson(url.toString(), { method: 'GET', headers: headers(tokenFrom(config)) }, fetchImpl));
  if (!Array.isArray(data.messages)) throw new Error('WorkBuddy 消息格式无效');
  let reply;
  for (const item of data.messages) {
    // The relay verifies the provider message stream against its mapped
    // provider ID. The desktop uses a stable request ID, not that provider ID.
    if (!usesRelay(config) && item.role === 'user' && item.message_id !== messageId) throw new Error('WorkBuddy 出现其他用户消息，无法确定回复属于当前工作');
    if (item.role === 'assistant' && item.msg_type === 'text') { reply = item; if (!usesRelay(config)) break; }
  }
  if (!reply) return null;
  const text = Array.isArray(reply.content) ? reply.content.filter(part => typeof part === 'string').join('\n').trim() : '';
  return text || null;
}

let localOperations = 0;
let configurationChanging = false;
let configurationEpoch = 0;
const localAssistantEpoch = () => configurationEpoch;
const advanceLocalAssistantEpoch = () => { configurationEpoch++; };
const hasLocalAssistantOperations = () => localOperations > 0;
async function withLocalAssistantConfiguration(operation) {
  if (localOperations || configurationChanging) throw new Error('本地助理正在执行或调整授权，请稍后再操作');
  configurationChanging = true;
  try { return await operation(); } finally { configurationChanging = false; }
}
async function callWorkBuddy(config, messages, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), memory = {}) {
  if (usesRelay(config) && configurationChanging) throw new Error('正在调整 WorkBuddy 授权，请完成授权后再发送工作');
  if (usesRelay(config) && config._workbuddyConfigurationEpoch != null && config._workbuddyConfigurationEpoch !== configurationEpoch) throw new Error('WorkBuddy 授权或配置在准备资料期间已变化，本次没有发送；请核对后重试工作');
  if (usesRelay(config)) localOperations++;
  try { return await runWorkBuddy(config, messages, fetchImpl, sleep, memory); }
  finally { if (usesRelay(config)) localOperations--; }
}
async function runWorkBuddy(config, messages, fetchImpl, sleep, memory) {
  const latest = [...messages].reverse().find(item => item.role === 'user');
  if (!latest) throw new Error('没有可发送给 WorkBuddy 的消息');
  const content = usesRelay(config) ? localAssistantContent(messages, memory) : latest.text;
  let messageId;
  const requestId = usesRelay(config) ? crypto.randomBytes(32).toString('base64url') : null;
  try {
    const providerMessage = await sendWorkBuddyMessage(config, content, fetchImpl, requestId);
    messageId = requestId || providerMessage;
  }
  catch (error) {
    if (!usesRelay(config)) throw error;
    // If the server accepted the POST but the desktop lost its response, ask
    // for THIS relay session's owned lease; never resend or adopt another
    // session's task. account_busy is a different job and must not be adopted.
    if (['network', 'response'].includes(error.code)) {
      // Persist OUR stable request marker even if the recovery read also fails.
      // It cannot match an earlier/other device request, or morph when the
      // server later receives the provider's message ID.
      error.uncertainMessageId = requestId;
    }
    if (!error.uncertainMessageId) throw error;
    return { text: `${error.message}。核对后可点击“我已核对，结束监听”；此按钮不会停止 WorkBuddy 正在执行的任务。`, messageId: requestId || error.uncertainMessageId, pending: true, viaRelay: true };
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(2000);
    let reply;
    try { reply = await readWorkBuddyReply(config, messageId, fetchImpl); }
    catch (error) {
      const reason = usesRelay(config) ? error.message : error.message.includes('其他用户消息') ? '期间出现其他消息，无法安全匹配回复。请到 WorkBuddy 核对结果。' : '暂时无法读取回复。请检查读取权限后点击“获取最新回复”。';
      return { text: `已发送给 WorkBuddy（消息 ID：${messageId}），${reason}`, messageId, pending: true, ...(usesRelay(config) ? { viaRelay: true } : {}) };
    }
    if (reply) return { text: reply.slice(0, 50000), messageId, pending: usesRelay(config), ...(usesRelay(config) ? { viaRelay: true } : {}) };
  }
  return { text: `已发送给 WorkBuddy（消息 ID：${messageId}），仍在等待回复。可稍后点击“获取最新回复”。`, messageId, pending: true, ...(usesRelay(config) ? { viaRelay: true } : {}) };
}

async function releaseWorkBuddyMessage(config, messageId, fetchImpl = fetch) {
  if (!usesRelay(config)) throw new Error('只有 HTTPS 本地助理连接支持结束监听');
  if (typeof messageId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(messageId)) throw new Error('监听标识无效');
  return requestRelay(config, '/v1/localassistant/release', { method: 'POST', body: { messageId } }, fetchImpl);
}

module.exports = { checkWorkBuddy, sendWorkBuddyMessage, readWorkBuddyReply, callWorkBuddy, releaseWorkBuddyMessage, localAssistantContent, usesRelay, hasLocalAssistantOperations, withLocalAssistantConfiguration, localAssistantEpoch, advanceLocalAssistantEpoch };
