// Which channel reaches a colleague. People notifications go through
// self-built apps first because they can message anyone in the app's range
// without a prior chat; the WeCom smart bot only reaches people who have
// messaged it before, so it is a last resort.
const { sendWecomText } = require('./wecom-service.cjs');
const { sendFeishuText, feishuConfigured } = require('./feishu-service.cjs');

const wecomAppConfigured = config => Boolean(config?.wecom?.organizationId && config?.wecom?.applicationId && config?.wecomSecret);
const wecomBotReady = (config, bot) => Boolean(config?.wecom?.botId && config?.wecomBotSecret && bot?.status === '已连接');

// People who have messaged the bot in a single chat (the bot may push to them).
function botContacts(data) {
  const set = new Set(Object.keys(data?.wecomBotContacts || {}));
  for (const event of data?.wecomEvents || []) if (event.chatType !== 'group' && event.userId) set.add(event.userId);
  return set;
}

const hasContact = (contacts, userId) => Boolean(userId) && (contacts instanceof Set ? contacts.has(userId) : Boolean(contacts?.[userId]));

// Ordered candidates for one member, without sending anything. Without a
// contacts list the bot is assumed to reach anyone (legacy callers).
function channelsFor(member, config, bot, contacts = null) {
  const list = [];
  if (member?.wecomUserId && wecomAppConfigured(config)) list.push({ channel: 'wecom-app', to: member.wecomUserId });
  if (member?.feishuId && feishuConfigured(config)) list.push({ channel: 'feishu', to: member.feishuId });
  if (member?.wecomUserId && wecomBotReady(config, bot) && (!contacts || hasContact(contacts, member.wecomUserId))) list.push({ channel: 'wecom-bot', to: member.wecomUserId });
  return list;
}

// Reachability shown next to a member before sending.
function reachability(member, config, bot, contacts = null) {
  const first = channelsFor(member, config, bot, contacts)[0];
  if (first) return { reachable: true, channel: first.channel };
  if (!member?.wecomUserId && !member?.feishuId) return { reachable: false, reason: 'unbound' };
  if (member.wecomUserId && wecomBotReady(config, bot) && contacts && !hasContact(contacts, member.wecomUserId)) return { reachable: false, reason: 'needs-hello' };
  if (member.wecomUserId && config?.wecom?.botId && config?.wecomBotSecret && !wecomBotReady(config, bot)) return { reachable: false, reason: 'bot-offline' };
  return { reachable: false, reason: 'channel-not-configured' };
}

class NotReachableError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const REASON_TEXT = {
  unbound: '还没有绑定企微或飞书',
  'needs-hello': '还没在企微给机器人发过消息，机器人不能主动找他',
  'bot-offline': '企微机器人未连接',
  'channel-not-configured': '企微机器人或飞书应用尚未配置'
};

async function notifyMember(config, member, text, { bot, contacts = null, sendWecomApp = sendWecomText, sendFeishu = sendFeishuText } = {}) {
  const candidates = channelsFor(member, config, bot, contacts);
  if (!candidates.length) {
    const { reason } = reachability(member, config, bot, contacts);
    throw new NotReachableError(REASON_TEXT[reason] || REASON_TEXT['channel-not-configured'], reason);
  }
  const { channel, to } = candidates[0];
  if (channel === 'wecom-app') return { ...(await sendWecomApp(config, to, text)), channel };
  if (channel === 'feishu') return { ...(await sendFeishu(config, to, text)), channel };
  return { ...(await bot.sendText(to, text)), channel };
}

const CHANNEL_LABEL = { 'wecom-app': '企微', 'wecom-bot': '企微机器人', feishu: '飞书' };

module.exports = { channelsFor, reachability, notifyMember, NotReachableError, wecomAppConfigured, wecomBotReady, botContacts, CHANNEL_LABEL, REASON_TEXT };
