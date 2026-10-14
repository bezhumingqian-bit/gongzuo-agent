const { requestJson } = require('./connection-service.cjs');
const { taskLink } = require('./runtime-channel.cjs');
const { taskMemberSpaces, findMember } = require('./mention-service.cjs');

const MAX_BYTES = 2048;

// Fit a message into WeCom's limit, keeping the header and the work link.
function fitWecom(head, text, tail) {
  const full = `${head}${text}${tail}`;
  if (Buffer.byteLength(full, 'utf8') <= MAX_BYTES) return full;
  const note = '…（内容较长，完整内容见共作）';
  const budget = MAX_BYTES - Buffer.byteLength(`${head}${note}${tail}`, 'utf8');
  let body = String(text);
  while (body && Buffer.byteLength(body, 'utf8') > budget) body = body.slice(0, Math.floor(body.length * 0.9));
  return `${head}${body}${note}${tail}`;
}

const senderName = config => String(config?.profile?.name || '').trim() || '同事';

class WecomSendError extends Error {
  constructor(message, deliveryUnknown = false) {
    super(message);
    this.deliveryUnknown = deliveryUnknown;
  }
}

function recipientUserId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(id) || id.toLowerCase() === '@all') {
    throw new WecomSendError('请填写单个企业微信成员 UserID；不支持群发');
  }
  return id;
}

function requireWecomConfig(config) {
  const corpid = String(config.wecom?.organizationId || '').trim();
  const agentid = String(config.wecom?.applicationId || '').trim();
  const secret = String(config.wecomSecret || '').trim();
  if (!corpid || !/^[1-9]\d{0,14}$/.test(agentid) || !secret) {
    throw new WecomSendError('请先在设置中填写企业 ID、数字 AgentID 和应用 Secret');
  }
  return { corpid, agentid: Number(agentid), secret };
}

async function getAccessToken(config, fetchImpl = fetch) {
  const { corpid, secret } = requireWecomConfig(config);
  const tokenUrl = new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken');
  tokenUrl.searchParams.set('corpid', corpid);
  tokenUrl.searchParams.set('corpsecret', secret);
  const result = await requestJson(tokenUrl.toString(), { method: 'GET' }, fetchImpl);
  if (result.errcode !== 0 || !result.access_token) throw new WecomSendError(`企业微信凭据验证失败（错误码 ${result.errcode ?? '未知'}）`);
  return result.access_token;
}

async function fetchVisibleMembers(config, fetchImpl = fetch) {
  const accessToken = await getAccessToken(config, fetchImpl);
  const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/user/simplelist');
  url.searchParams.set('access_token', accessToken);
  url.searchParams.set('department_id', '1');
  url.searchParams.set('fetch_child', '1');
  const result = await requestJson(url.toString(), { method: 'GET' }, fetchImpl);
  if (result.errcode !== 0 || !Array.isArray(result.userlist)) throw new WecomSendError(`读取可见成员失败（错误码 ${result.errcode ?? '未知'}）；请检查通讯录授权范围`);
  return result.userlist.filter(item => /^[A-Za-z0-9._@-]{1,64}$/.test(item.userid || '') && item.userid.toLowerCase() !== '@all').map(item => ({ userId: item.userid, name: String(item.name || item.userid).slice(0, 80) }));
}

async function sendWecomText(config, userId, content, fetchImpl = fetch) {
  const recipient = recipientUserId(userId);
  const text = String(content ?? '');
  if (!text.trim() || Buffer.byteLength(text, 'utf8') > 2048) {
    throw new WecomSendError('企业微信文本消息不能为空或超过 2048 字节');
  }
  const { agentid } = requireWecomConfig(config);
  const accessToken = await getAccessToken(config, fetchImpl);
  const sendUrl = new URL('https://qyapi.weixin.qq.com/cgi-bin/message/send');
  sendUrl.searchParams.set('access_token', accessToken);
  let result;
  try {
    result = await requestJson(sendUrl.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ touser: recipient, msgtype: 'text', agentid, text: { content: text }, safe: 0 })
    }, fetchImpl);
  } catch (error) {
    throw new WecomSendError(`发送结果未知：${error.message}；请先在企业微信核对`, true);
  }
  if (result.errcode !== 0) {
    throw new WecomSendError(`企业微信拒绝发送${Number.isInteger(result.errcode) ? `（错误码 ${result.errcode}）` : ''}`);
  }
  if (result.invaliduser || result.invalidparty || result.invalidtag) {
    throw new WecomSendError('企业微信没有接受该收件成员；请核对 UserID 和应用可见范围');
  }
  return { recipientUserId: recipient, externalMessageId: typeof result.msgid === 'string' ? result.msgid : null, channel: 'application' };
}

async function sendViaWecom(config, userId, content, botBridge, sendApp = sendWecomText) {
  const botConfigured = Boolean(config.wecom?.botId && config.wecomBotSecret);
  const appConfigured = Boolean(config.wecom?.organizationId && config.wecom?.applicationId && config.wecomSecret);
  if (botConfigured && botBridge?.status === '已连接') return botBridge.sendText(userId, content);
  if (botConfigured && !appConfigured) throw new WecomSendError('企微机器人尚未连接；请在设置中检查长连接状态');
  return sendApp(config, userId, content);
}

class WecomDelivery {
  // notify(config, member, text): reaches one colleague through the channel
  // their account is bound to (see channel-router.cjs). Defaults to WeCom.
  constructor({ store, settingsService, publish, send = sendWecomText, notify = null }) {
    Object.assign(this, { store, settingsService, publish, send });
    this.notify = notify || ((config, member, text) => {
      if (!member?.wecomUserId) return Promise.reject(Object.assign(new Error('还没有绑定企微或飞书'), { code: 'unbound' }));
      return this.send(config, member.wecomUserId, text);
    });
  }

  async markInterrupted() {
    const data = await this.store.update(draft => {
      for (const task of draft.tasks) {
        for (const message of task.messages || []) {
          if (message.wecomDelivery?.status === 'sending') {
            message.wecomDelivery = { ...message.wecomDelivery, status: 'unknown', detail: '应用中断，发送结果未知；请先在企业微信核对' };
          }
        }
        if (task.assignmentDelivery?.status === 'sending') task.assignmentDelivery = { ...task.assignmentDelivery, status: 'unknown', detail: '应用中断，发送结果未知；请先在企业微信核对' };
      }
      return draft;
    });
    this.publish(data);
  }

  async sendTaskMessage(taskId, messageId, userId) {
    const recipient = recipientUserId(userId);
    let text;
    const sending = await this.store.update(draft => {
      const task = draft.tasks.find(item => item.id === taskId);
      const message = task?.messages?.find(item => item.id === messageId && item.role === 'user');
      if (!message) throw new Error('工作消息不存在');
      if (['sending', 'sent', 'unknown'].includes(message.wecomDelivery?.status)) {
        throw new Error('这条消息已发送或发送结果未知，请勿重复发送');
      }
      text = message.text;
      message.wecomDelivery = { status: 'sending', recipientUserId: recipient, updatedAt: new Date().toISOString() };
      return draft;
    });
    this.publish(sending);
    let delivery;
    try {
      const config = await this.settingsService.getRuntimeConfig();
      const sent = await this.send(config, recipient, text);
      delivery = { status: 'sent', recipientUserId: recipient, externalMessageId: sent.externalMessageId, channel: sent.channel || 'application', updatedAt: new Date().toISOString() };
    } catch (error) {
      delivery = {
        status: error.deliveryUnknown ? 'unknown' : 'failed',
        recipientUserId: recipient,
        detail: String(error.message || '企业微信发送失败').slice(0, 180),
        updatedAt: new Date().toISOString()
      };
    }
    const finished = await this.store.update(draft => {
      const message = draft.tasks.find(item => item.id === taskId)?.messages.find(item => item.id === messageId);
      if (message?.wecomDelivery?.status === 'sending') message.wecomDelivery = delivery;
      return draft;
    });
    this.publish(finished);
    return delivery;
  }

  async sendMentions(taskId, messageId) {
    const data = await this.store.read();
    const task = data.tasks.find(item => item.id === taskId);
    const message = task?.messages?.find(item => item.id === messageId);
    if (!task || !message) throw new Error('工作消息不存在');
    const spaces = taskMemberSpaces(data, task);
    const recipients = (message.mentions || []).map(mention => ({ memberId: mention.memberId, member: findMember(spaces, mention.memberId), name: mention.name }));
    if (!recipients.length) return [];
    const config = await this.settingsService.getRuntimeConfig();
    const sender = senderName(config);
    const title = task.channelOnly ? '' : `「${task.title || task.goal || '工作'}」`;
    const results = [];
    for (const { member, ...recipient } of recipients) {
      const head = message.wecomOutbound ? `${sender} 通过共作发给你${title ? `（${title}）` : ''}：\n` : `${sender} 在共作${title}中 @ 了你：\n`;
      const body = fitWecom(head, message.text, task.channelOnly ? '' : `\n\n打开工作：${taskLink(taskId)}`);
      results.push(await this.deliverTo(config, member, recipient, body));
    }
    const finished = await this.store.update(draft => {
      const current = draft.tasks.find(item => item.id === taskId)?.messages?.find(item => item.id === messageId);
      if (current) { current.mentionDeliveries = results; current.mentionDelivery = results.every(item => item.status === 'sent') ? 'sent' : 'partial'; }
      return draft;
    });
    this.publish(finished);
    return results;
  }

  // One person, one message: result entry recorded on the message.
  async deliverTo(config, member, entry, body) {
    try {
      const sent = await this.notify(config, member, body);
      return { ...entry, status: 'sent', channel: sent.channel || 'wecom-app', externalMessageId: sent.externalMessageId || null };
    } catch (error) {
      if (['unbound', 'channel-not-configured'].includes(error.code)) return { ...entry, status: 'unmapped', detail: String(error.message).slice(0, 120) };
      return { ...entry, status: error.deliveryUnknown ? 'unknown' : 'failed', detail: String(error.message || '发送失败').slice(0, 180) };
    }
  }

  // Forward an existing message of a work (yours or an Agent reply) to members
  // of the work's spaces. Results are recorded on the message.
  async forwardToMembers(taskId, messageId, memberIds) {
    if (!Array.isArray(memberIds) || !memberIds.length || memberIds.length > 10) throw new Error('请选择 1 到 10 位成员');
    const data = await this.store.read();
    const task = data.tasks.find(item => item.id === taskId);
    const message = task?.messages?.find(item => item.id === messageId && ['user', 'assistant'].includes(item.role));
    if (!task || !message) throw new Error('工作消息不存在');
    const spaces = taskMemberSpaces(data, task);
    const config = await this.settingsService.getRuntimeConfig();
    const sender = senderName(config);
    const what = message.role === 'assistant' ? ' Agent 的回复' : '一条消息';
    const body = fitWecom(`${sender} 从共作「${task.title || task.goal || '工作'}」转发给你${what}：\n`, message.text, `\n\n打开工作：${taskLink(taskId)}`);
    const results = [];
    for (const id of [...new Set(memberIds)]) {
      const member = findMember(spaces, id);
      if (!member) { results.push({ memberId: id, name: '未知成员', status: 'failed', detail: '不是这项工作所在空间的成员' }); continue; }
      results.push(await this.deliverTo(config, member, { memberId: member.id, name: member.name || '同事' }, body));
    }
    const at = new Date().toISOString();
    const finished = await this.store.update(draft => {
      const current = draft.tasks.find(item => item.id === taskId)?.messages?.find(item => item.id === messageId);
      if (current) current.forwards = [...(current.forwards || []), ...results.map(item => ({ ...item, at }))].slice(-30);
      return draft;
    });
    this.publish(finished);
    return results;
  }

  async assignTask(taskId, memberId) {
    let recipient;
    let taskTitle;
    const sending = await this.store.update(draft => {
      const task = draft.tasks.find(item => item.id === taskId);
      if (!task) throw new Error('工作不存在');
      const member = findMember(taskMemberSpaces(draft, task), memberId);
      if (!member || (!member.wecomUserId && !member.feishuId)) throw new Error('请选择已绑定企微或飞书的成员');
      if (task.assignee?.memberId === memberId && ['sending', 'sent', 'unknown'].includes(task.assignmentDelivery?.status)) throw new Error('这项工作已经指派给该成员，请勿重复发送');
      recipient = member;
      taskTitle = task.title || task.goal || '工作';
      task.assignee = { memberId, name: member.name, ...(member.wecomUserId ? { wecomUserId: member.wecomUserId } : {}), ...(member.feishuId ? { feishuId: member.feishuId } : {}) };
      task.assignmentDelivery = { status: 'sending', recipientUserId: member.wecomUserId || member.feishuId, updatedAt: new Date().toISOString() };
      task.updatedAt = new Date().toISOString();
      return draft;
    });
    this.publish(sending);
    let delivery;
    try {
      const config = await this.settingsService.getRuntimeConfig();
      const sent = await this.notify(config, recipient, `${senderName(config)} 在共作把「${taskTitle}」指派给你。\n打开工作：${taskLink(taskId)}`);
      delivery = { status: 'sent', recipientUserId: recipient.wecomUserId || recipient.feishuId, externalMessageId: sent.externalMessageId, channel: sent.channel || 'wecom-app', updatedAt: new Date().toISOString() };
    } catch (error) {
      delivery = { status: error.deliveryUnknown ? 'unknown' : 'failed', recipientUserId: recipient.wecomUserId || recipient.feishuId, detail: String(error.message || '发送失败').slice(0, 180), updatedAt: new Date().toISOString() };
    }
    const finished = await this.store.update(draft => {
      const task = draft.tasks.find(item => item.id === taskId);
      if (task?.assignmentDelivery?.status === 'sending' && task.assignee?.memberId === memberId) task.assignmentDelivery = delivery;
      return draft;
    });
    this.publish(finished);
    return delivery;
  }
}

module.exports = { WecomSendError, recipientUserId, sendWecomText, sendViaWecom, fetchVisibleMembers, WecomDelivery };
