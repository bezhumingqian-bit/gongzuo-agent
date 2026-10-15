const { WSClient, generateReqId } = require('@wecom/aibot-node-sdk');
const { taskLink } = require('./runtime-channel.cjs');
const { matchWorkflow, workflowGoal } = require('./workflow-service.cjs');
const { WecomSendError, recipientUserId } = require('./wecom-service.cjs');
const { wecomBotEvent, recordWecomEvent } = require('./contracts/source-event.cjs');
const { actors, workspaceRole } = require('./contracts/policy.cjs');
const { WorkOperations, WorkError, findTask } = require('./contracts/work-operations.cjs');
const { requestToJoin } = require('./workspace-service.cjs');

function parseCommand(text) {
  const input = String(text || '').replace(/^@[^\s]+\s*/u, '').trim();
  const create = input.match(/^(?:新建|创建工作)\s+([^:：\n]{2,80})\s*[:：]\s*([\s\S]{2,2000})$/u);
  if (create) return { type: 'create', workspace: create[1].trim(), content: create[2].trim() };
  const update = input.match(/^更新\s+([A-Za-z0-9-]{4,100})\s*[:：]\s*([\s\S]{1,2000})$/u);
  if (update) return { type: 'update', taskId: update[1], content: update[2].trim() };
  const view = input.match(/^查看\s+([A-Za-z0-9-]{4,100})$/u);
  if (view) return { type: 'view', taskId: view[1] };
  const join = input.match(/^加入\s+(\S{1,80}?)(?:\s+(?:我是\s*)?([^\s]{1,20}))?$/u);
  if (join) return { type: 'join', workspace: join[1].trim(), name: (join[2] || '').trim() };
  return { type: 'help' };
}

// Kept for callers/tests; the decision itself lives in contracts/policy.cjs.
const memberAccess = (space, userId) => workspaceRole(space, actors.wecom(userId));

// WeCom wording for policy denials. Same text as before the contract refactor.
function denialText(error, commandType) {
  if (error.code === 'workspace-not-found') return '工作空间不存在，请使用共作中的准确空间名称。';
  if (error.code === 'task-not-found') return '找不到唯一的工作 ID，请使用完整 ID。';
  if (error.code === 'no-work') return error.message;
  if (commandType === 'create') return '你尚未获得这个空间的企微协作权限。';
  if (error.code === 'read-only') return '你在这个项目只有只读权限。';
  return '你尚未获得这个空间的企微参与权限。';
}

class WecomBotBridge {
  constructor({ store, settingsService, taskRunner, ops, clientFactory = options => new WSClient(options), publish = () => {}, logFile = null }) {
    Object.assign(this, { store, settingsService, taskRunner, clientFactory, publish, logFile });
    this.log = [];
    this.ops = ops || new WorkOperations({ store, taskRunner });
    this.client = null;
    this.status = '未配置';
    this.lastTextFrameAt = null;
    this.lastTextFrameStatus = '尚未收到';
  }

  // Keeps the last connection events (no message content, no secrets) for diagnosis.
  note(line) {
    const entry = `${new Date().toISOString()} ${String(line).slice(0, 200)}`;
    this.log.push(entry);
    if (this.log.length > 60) this.log.splice(0, this.log.length - 60);
    if (this.logFile) require('node:fs').promises.writeFile(this.logFile, `${this.log.join('\n')}\n`, { mode: 0o600 }).catch(() => {});
  }

  async restart(reason = 'restart') {
    this.note(`restart (${reason})`);
    this.stop();
    this.lastTextFrameAt = null;
    this.lastTextFrameStatus = '尚未收到';
    const config = await this.settingsService.getRuntimeConfig();
    if (!config.wecom?.botId || !config.wecomBotSecret) { this.note(`skip: botId=${Boolean(config.wecom?.botId)} secret=${Boolean(config.wecomBotSecret)}`); return this.status; }
    // GONGZUO_DEBUG_WECOM=1 prints the SDK's connection log (diagnostics only).
    const quietLogger = { debug() {}, info: (...a) => this.note(`info ${a.join(' ')}`), warn: (...a) => this.note(`warn ${a.join(' ')}`), error: (...a) => this.note(`error ${a.join(' ')}`) };
    this.lastError = null;
    const client = this.clientFactory({ botId: config.wecom.botId, secret: config.wecomBotSecret, logger: quietLogger });
    this.client = client;
    this.status = '连接中';
    client.on('authenticated', () => { this.status = '已连接'; this.note('status 已连接'); });
    client.on('disconnected', reason => { this.status = '已断开，等待重连'; this.note(`status 已断开 ${String(reason || '').slice(0, 80)}`); });
    client.on('reconnecting', () => { this.status = '重连中'; this.note('status 重连中'); });
    client.on('error', error => { this.status = '连接异常'; this.lastError = String(error?.message || error || '').slice(0, 200); this.note(`status 连接异常 ${this.lastError}`); });
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
    if (this.client) { this.note('stop'); try { this.client.disconnect(); } catch {} }
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
    const event = wecomBotEvent(frame);
    if (!event) return false;
    const body = frame.body;
    const userId = event.actorId;
    const msgId = event.sourceId;
    const commandText = event.text.replace(/^@[^\s]+\s*/u, '').trim();
    const command = parseCommand(event.text);
    const config = await this.settingsService.getRuntimeConfig();
    const summary = command.type === 'help' ? matchWorkflow(config.workflow, userId, commandText) : null;
    const reply = async content => {
      if (this.client) await this.client.replyStream(frame, generateReqId('stream'), String(content).slice(0, 3500), true);
      return content;
    };
    let duplicate = false;
    const updatedData = await this.store.update(data => {
      duplicate = recordWecomEvent(data, event).duplicate;
      return data;
    });
    if (duplicate) return reply('这条消息已处理。');
    this.publish(updatedData);
    if (command.type === 'join') {
      if (body.chattype === 'group') return reply('请单聊我发送「加入 空间名称 你的名字」，这样我之后才能把工作通知发给你。');
      let outcome;
      const joined = await this.store.update(data => { outcome = requestToJoin(data, { userId, workspace: command.workspace, name: command.name }); return data; });
      this.publish(joined);
      if (outcome.status === 'workspace-not-found') return reply(`找不到空间「${command.workspace}」，请向同事确认共作里的准确空间名称。`);
      if (outcome.status === 'already-member') return reply(`你已经在「${outcome.space.name}」里了。有人在共作 @ 你时，我会在这里通知你。`);
      return reply(`${outcome.status === 'already-requested' ? '已更新' : '已提交'}加入「${outcome.space.name}」的申请，等空间负责人在共作里确认。\n从现在起，有人在共作 @ 你时我可以在这里通知你。`);
    }
    if (command.type === 'help' && !summary) return reply('共作支持：\n加入 空间名称 你的名字（第一次使用先发这句）\n新建 空间名称：工作目标\n更新 工作ID：进展内容\n查看 工作ID\n只有已加入空间的企微成员可以操作该空间。');
    const origin = { chatId: body.chattype === 'group' ? body.chatid : userId, userId, msgId, chatType: body.chattype };
    const actor = actors.wecom(userId);
    try {
      if (summary) {
        const space = (await this.store.read()).workspaces.find(item => item.id === config.workflow.workspaceId);
        if (!space) return reply('规则目标空间不存在，请在共作设置中重新选择。');
        if (config.workflow.agentMode === 'built-in' && !config.model?.modelId) return reply('内置模型尚未配置；摘要未转交。');
        const task = await this.ops.create(actors.rule('wecom-summary', space.id, userId), {
          workspaceId: space.id, goal: workflowGoal(config.workflow, summary), origin,
          options: { agentMode: config.workflow.agentMode, workflow: { type: 'wecom-summary', sourceUserId: userId, sourceMsgId: msgId }, title: `审核企微摘要 · ${space.name}` }
        });
        const transport = require('./workbuddy-transport.cjs').transportOf(config);
        const handler = config.workflow.agentMode !== 'workbuddy' ? '内置 Agent' : transport === 'handoff' ? ' WorkBuddy（本机连接，等待领取）' : transport === 'cloud' ? ' WorkBuddy 云端任务' : ' WorkBuddy';
        return reply(`摘要已交给${handler} 分析，结果将作为待确认工作保存。\n工作 ID：${task.id}`);
      }
      if (command.type === 'create') {
        const task = await this.ops.create(actor, { workspace: command.workspace, goal: command.content, origin });
        return reply(`已创建工作。\n工作 ID：${task.id}\n${task.agentRun?.status === 'not-configured' ? 'Agent 尚未配置，请在共作中设置。' : 'Agent 结果会私聊发给你。'}`);
      }
      if (command.type === 'view') {
        const { task } = await this.ops.view(actor, command.taskId);
        const detail = `「${task.title}」\n空间：${task.workspace}${task.relatedWorkspaces?.length ? `（关联：${task.relatedWorkspaces.join('、')}）` : ''}\n状态：${task.agentRun?.status || task.status || '进行中'}\n打开：${taskLink(task.id)}`;
        if (body.chattype === 'group') {
          await this.client.sendMessage(userId, { msgtype: 'markdown', markdown: { content: detail } });
          return reply('工作状态已发到你的企微私聊。');
        }
        return reply(detail);
      }
      const { task } = await this.ops.append(actor, command.taskId, command.content, { origin });
      const updated = (await this.store.read()).tasks.find(item => item.id === task.id);
      return reply(`已记录到工作 ${task.id.slice(0, 8)}；${updated?.agentRun?.status === 'not-configured' ? 'Agent 尚未配置，请在共作中设置。' : 'Agent 结果会私聊发给你。'}`);
    } catch (error) {
      if (error instanceof WorkError) return reply(denialText(error, command.type));
      return reply(`处理失败：${String(error.message || '未知错误').slice(0, 160)}`);
    }
  }

  async sendAgentAnswer({ taskId, answer, origin }) {
    if (!this.client || !origin?.userId || !answer?.text) return;
    const content = `共作工作 ${taskId.slice(0, 8)} 的 Agent ${answer.source === 'connection-error' ? '调用失败' : '回复'}：\n${String(answer.text).slice(0, 2400)}\n\n打开：${taskLink(taskId)}`;
    await this.client.sendMessage(origin.userId, { msgtype: 'markdown', markdown: { content } });
  }
}

module.exports = { WecomBotBridge, parseCommand, memberAccess, findTask };
