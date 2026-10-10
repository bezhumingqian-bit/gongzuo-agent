const { requestJson } = require('./connection-service.cjs');

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
  const data = dataFrom(await requestJson(BASE, { method: 'GET', headers: headers(tokenFrom(config)) }, fetchImpl));
  if (data.online !== true) throw new Error('WorkBuddy 本地助理当前离线');
  return { ok: true, message: 'WorkBuddy 本地助理在线；发送权限仍需通过真实消息验证' };
}

async function sendWorkBuddyMessage(config, content, fetchImpl = fetch) {
  const text = String(content || '').trim();
  if (!text || text.length > 4000) throw new Error('WorkBuddy 消息长度无效');
  const data = dataFrom(await requestJson(`${BASE}/message`, {
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
  const data = dataFrom(await requestJson(url.toString(), { method: 'GET', headers: headers(tokenFrom(config)) }, fetchImpl));
  if (!Array.isArray(data.messages)) throw new Error('WorkBuddy 消息格式无效');
  let reply;
  for (const item of data.messages) {
    if (item.role === 'user' && item.message_id !== messageId) throw new Error('WorkBuddy 出现其他用户消息，无法确定回复属于当前工作');
    if (item.role === 'assistant' && item.msg_type === 'text') { reply = item; break; }
  }
  if (!reply) return null;
  const text = Array.isArray(reply.content) ? reply.content.filter(part => typeof part === 'string').join('\n').trim() : '';
  return text || null;
}

async function callWorkBuddy(config, messages, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const latest = [...messages].reverse().find(item => item.role === 'user');
  if (!latest) throw new Error('没有可发送给 WorkBuddy 的消息');
  const messageId = await sendWorkBuddyMessage(config, latest.text, fetchImpl);
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(2000);
    let reply;
    try { reply = await readWorkBuddyReply(config, messageId, fetchImpl); }
    catch (error) {
      const reason = error.message.includes('其他用户消息') ? '期间出现其他消息，无法安全匹配回复。请到 WorkBuddy 核对结果。' : '暂时无法读取回复。请检查读取权限后点击“获取最新回复”。';
      return { text: `已发送给 WorkBuddy（消息 ID：${messageId}），${reason}`, messageId, pending: true };
    }
    if (reply) return { text: reply.slice(0, 50000), messageId, pending: false };
  }
  return { text: `已发送给 WorkBuddy（消息 ID：${messageId}），仍在等待回复。可稍后点击“获取最新回复”。`, messageId, pending: true };
}

module.exports = { checkWorkBuddy, sendWorkBuddyMessage, readWorkBuddyReply, callWorkBuddy };
