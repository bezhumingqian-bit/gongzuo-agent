const { WSClient, generateReqId } = require('@wecom/aibot-node-sdk');
const { matchWorkflow, workflowGoal } = require('./workflow-service.cjs');
const { WecomSendError, recipientUserId } = require('./wecom-service.cjs');
const { recordInboundMessage } = require('./channel-inbox.cjs');

function parseCommand(text) {
  const input = String(text || '').replace(/^@[^\s]+\s*/u, '').trim();
  const create = input.match(/^(?:新建|创建工作)\s+([^:：\n]{2,80})\s*[:：]\s*([\s\S]{2,2000})$/u);
  if (create) return { type: 'create', workspace: create[1].trim(), content: create[2].trim() };
  const update = input.match(/^更新\s+([A-Za-z0-9-]{4,100})\s*[:：]\s*([\s\S]{1,2000})$/u);
  if (update) return { type: 'update', taskId: update[1], content: update[2].trim() };
  const view = input.match(/^查看\s+([A-Za-z0-9-]{4,100})$/u);
  if (view) return { type: 'view', taskId: view[1] };
  return { type: 'help' };
}

function memberAccess(space, userId) {
  const member = space?.members?.find(item => item.wecomUserId === userId && ['wecom', 'active'].includes(item.status));
  return member?.role || null;
}

function findTask(data, id) {
  const matches = data.tasks.filter(task => task.id === id || task.id.startsWith(id));
  return matches.length === 1 ? matches[0] : null;
}

class WecomBotBridge {
  constructor({ store, settingsService, taskRunner, clientFactory = options => new WSClient(options), publish = () => {} }) {
    Object.assign(this, { store, settingsService, taskRunner, clientFactory, publish });
    this.client = null;
    this.status = '未配置';
    this.lastTextFrameAt = null;
    this.lastTextFrameStatus = '尚未收到';
  }

  async restart() {
    this.stop();
    this.lastTextFrameAt = null;
    this.lastTextFrameStatus = '尚未收到';
    const config = await this.settingsService.getRuntimeConfig();
    if (!config.wecom?.botId || !config.wecomBotSecret) return this.status;
    const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };
    const client = this.clientFactory({ botId: config.wecom.botId, secret: config.wecomBotSecret, logger: quietLogger });
    this.client = client;
    this.status = '连接中';
    client.on('authenticated', () => { this.status = '已连接'; });
    client.on('disconnected', () => { this.status = '已断开，等待重连'; });
    client.on('reconnecting', () => { this.status = '重连中'; });
    client.on('error', () => { this.status = '连接异常'; });
    client.on('message.text', frame => {
      this.lastTextFrameAt = new Date().toISOString();
      this.lastTextFrameStatus = '处理中';
      this.handleFrame(frame).then(result => {
        this.lastTextFrameStatus = result === false ? '消息格式不匹配' : '已处理';
      }).catch(() => { this.lastTextFrameStatus = '处理失败'; });
    });
    try { await client.connect(); } catch { this.status = '连接异常'; }
    return this.status;
  }

  stop() {
    if (this.client) { try { this.client.disconnect(); } catch {} }
    this.client = null;
    this.status = '未配置';
  }

  async sendText(userId, content) {
    const recipient = recipientUserId(userId);
    const text = String(content ?? '');
    if (!text.trim() || Buffer.byteLength(text, 'utf8') > 2048) {
      throw new WecomSendError('企业微信消息不能为空或超过 2048 字节');
    }
    if (!this.client || this.status !== '已连接') {
      throw new WecomSendError('企微机器人未连接；请在设置中检查 BotID、Secret 和长连接状态');
    }
    let frame;
    try {
      frame = await this.client.sendMessage(recipient, { msgtype: 'markdown', markdown: { content: text } });
    } catch (error) {
      if (Number.isInteger(error?.errcode) && error.errcode !== 0) {
        throw new WecomSendError(`企微拒绝机器人发送（错误码 ${error.errcode}）。请确认收件人已与机器人单聊，并核对可见范围和发送频率`);
      }
      if (error?.message === 'WebSocket not connected, unable to send data') {
        throw new WecomSendError('企微长连接已断开；请检查机器人连接状态后重试');
      }
      throw new WecomSendError('企微未返回可确认的发送回执，送达情况未知；请先在企业微信核对', true);
    }
    if (frame?.errcode !== undefined && frame.errcode !== 0) {
      throw new WecomSendError(`企微机器人拒绝发送（错误码 ${frame.errcode}）`);
    }
    return { recipientUserId: recipient, externalMessageId: typeof frame?.body?.msgid === 'string' ? frame.body.msgid : null, channel: 'bot' };
  }

  async handleFrame(frame) {
    const body = frame?.body || {};
    const userId = String(body.from?.userid || '');
    const msgId = String(body.msgid || '');
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(userId) || !msgId || msgId.length > 200) return false;
    const text = String(body.text?.content || '');
    const commandText = text.replace(/^@[^\s]+\s*/u, '').trim();
    const command = parseCommand(text);
    const config = await this.settingsService.getRuntimeConfig();
    const summary = command.type === 'help' ? matchWorkflow(config.workflow, userId, commandText) : null;
    const reply = async content => {
      if (this.client) await this.client.replyStream(frame, generateReqId('stream'), String(content).slice(0, 3500), true);
      return content;
    };
    let duplicate = false;
    const updatedData = await this.store.update(data => {
      data.wecomEvents ||= [];
      if (data.wecomEvents.some(item => item.msgId === msgId)) duplicate = true;
      else {
        const event = { msgId, userId, chatType: body.chattype === 'group' ? 'group' : 'single', at: new Date().toISOString() };
        data.wecomEvents.push(event);
        if (data.wecomEvents.length > 1000) data.wecomEvents.splice(0, data.wecomEvents.length - 1000);
        if (event.chatType === 'single' && text.trim()) recordInboundMessage(data, {
          channel: 'wecom', eventId: msgId, senderId: userId, conversationId: userId,
          text, receivedAt: event.at
        });
      }
      return data;
    });
    if (duplicate) return reply('这条消息已处理。');
    this.publish(updatedData);
    if (command.type === 'help' && !summary) return reply('共作支持：\n新建 空间名称：工作目标\n更新 工作ID：进展内容\n查看 工作ID\n只有已关联到空间的企微成员可以操作该空间。');
    const data = await this.store.read();
    const origin = { chatId: body.chattype === 'group' ? body.chatid : userId, userId, msgId, chatType: body.chattype };
    try {
      if (summary) {
        const space = data.workspaces.find(item => item.id === config.workflow.workspaceId);
        if (!space) return reply('规则目标空间不存在，请在共作设置中重新选择。');
        if (config.workflow.agentMode === 'built-in' && !config.model?.modelId) return reply('内置模型尚未配置；摘要未转交。');
        const task = await this.taskRunner.create(workflowGoal(config.workflow, summary), space.name, [], origin, {
          agentMode: config.workflow.agentMode,
          workflow: { type: 'wecom-summary', sourceUserId: userId, sourceMsgId: msgId },
          title: `审核企微摘要 · ${space.name}`
        });
        const handler = config.workflow.agentMode !== 'workbuddy' ? '内置 Agent' : config.workbuddyAccessToken ? ' WorkBuddy' : ' WorkBuddy（本机连接，等待领取）';
        return reply(`摘要已交给${handler} 分析，结果将作为待确认工作保存。\n工作 ID：${task.id}`);
      }
      if (command.type === 'create') {
        const space = data.workspaces.find(item => item.name === command.workspace);
        if (!space) return reply('工作空间不存在，请使用共作中的准确空间名称。');
        const access = memberAccess(space, userId);
        if (!['owner', 'editor'].includes(access)) return reply('你尚未获得这个空间的企微协作权限。');
        const task = await this.taskRunner.create(command.content, space.name, [], origin);
        return reply(`已创建工作。\n工作 ID：${task.id}\n${task.agentRun?.status === 'not-configured' ? 'Agent 尚未配置，请在共作中设置。' : 'Agent 结果会私聊发给你。'}`);
      }
      const task = findTask(data, command.taskId);
      if (!task) return reply('找不到唯一的工作 ID，请使用完整 ID。');
      const space = data.workspaces.find(item => item.name === task.workspace);
      const access = memberAccess(space, userId);
      if (!access) return reply('你尚未获得这个空间的企微参与权限。');
      if (command.type === 'view') {
        const detail = `「${task.title}」\n空间：${task.workspace}\n状态：${task.agentRun?.status || task.status || '进行中'}\n打开：gongzuo://task/${encodeURIComponent(task.id)}`;
        if (body.chattype === 'group') {
          await this.client.sendMessage(userId, { msgtype: 'markdown', markdown: { content: detail } });
          return reply('工作状态已发到你的企微私聊。');
        }
        return reply(detail);
      }
      if (!['owner', 'editor'].includes(access)) return reply('你在这个项目只有只读权限。');
      await this.taskRunner.append(task.id, command.content, [], [], origin);
      const updated = (await this.store.read()).tasks.find(item => item.id === task.id);
      return reply(`已记录到工作 ${task.id.slice(0, 8)}；${updated?.agentRun?.status === 'not-configured' ? 'Agent 尚未配置，请在共作中设置。' : 'Agent 结果会私聊发给你。'}`);
    } catch (error) {
      return reply(`处理失败：${String(error.message || '未知错误').slice(0, 160)}`);
    }
  }

  async sendAgentAnswer({ taskId, answer, origin }) {
    if (!this.client || !origin?.userId || !answer?.text) return;
    const content = `共作工作 ${taskId.slice(0, 8)} 的 Agent ${answer.source === 'connection-error' ? '调用失败' : '回复'}：\n${String(answer.text).slice(0, 2400)}\n\n打开：gongzuo://task/${encodeURIComponent(taskId)}`;
    await this.client.sendMessage(origin.userId, { msgtype: 'markdown', markdown: { content } });
  }
}

module.exports = { WecomBotBridge, parseCommand, memberAccess, findTask };
