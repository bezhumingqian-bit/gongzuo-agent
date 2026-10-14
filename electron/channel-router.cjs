// Which channel reaches a colleague. People notifications go through
// self-built apps first because they can message anyone in the app's range
// without a prior chat; the WeCom smart bot only reaches people who have
// messaged it before, so it is a last resort.
const { sendWecomText } = require('./wecom-service.cjs');
const { sendFeishuText, feishuConfigured } = require('./feishu-service.cjs');

const wecomAppConfigured = config => Boolean(config?.wecom?.organizationId && config?.wecom?.applicationId && config?.wecomSecret);
const wecomBotReady = (config, bot) => Boolean(config?.wecom?.botId && config?.wecomBotSecret && bot?.status === '已连接');

// Ordered candidates for one member, without sending anything.
function channelsFor(member, config, bot) {
  const list = [];
  if (member?.wecomUserId && wecomAppConfigured(config)) list.push({ channel: 'wecom-app', to: member.wecomUserId });
  if (member?.feishuId && feishuConfigured(config)) list.push({ channel: 'feishu', to: member.feishuId });
  if (member?.wecomUserId && wecomBotReady(config, bot)) list.push({ channel: 'wecom-bot', to: member.wecomUserId });
  return list;
}

// Reachability shown next to a member before sending.
function reachability(member, config, bot) {
  const first = channelsFor(member, config, bot)[0];
  if (first) return { reachable: true, channel: first.channel };
  if (!member?.wecomUserId && !member?.feishuId) return { reachable: false, reason: 'unbound' };
  return { reachable: false, reason: 'channel-not-configured' };
}

class NotReachableError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

async function notifyMember(config, member, text, { bot, sendWecomApp = sendWecomText, sendFeishu = sendFeishuText } = {}) {
  const candidates = channelsFor(member, config, bot);
  if (!candidates.length) {
    if (!member?.wecomUserId && !member?.feishuId) throw new NotReachableError('还没有绑定企微或飞书', 'unbound');
    throw new NotReachableError(member.feishuId && !member.wecomUserId ? '飞书应用尚未配置' : '企微自建应用尚未配置', 'channel-not-configured');
  }
  const { channel, to } = candidates[0];
  if (channel === 'wecom-app') return { ...(await sendWecomApp(config, to, text)), channel };
  if (channel === 'feishu') return { ...(await sendFeishu(config, to, text)), channel };
  return { ...(await bot.sendText(to, text)), channel };
}

const CHANNEL_LABEL = { 'wecom-app': '企微', 'wecom-bot': '企微机器人', feishu: '飞书' };

module.exports = { channelsFor, reachability, notifyMember, NotReachableError, wecomAppConfigured, wecomBotReady, CHANNEL_LABEL };
