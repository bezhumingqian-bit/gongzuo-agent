// SourceEvent: the single shape every channel adapter produces before anything
// touches work, memory or the inbox (docs/MODULAR_PLATFORM.md「数据来源适配器」).
// Adapters own authentication and field mapping; they never decide task updates.
//
// Storage note: events are still persisted in the legacy collections
// (wecomEvents / inboundMessages / channelEvents) with their original meaning,
// so existing data and UI keep working. Only the in-memory contract is new.
const { recordInboundMessage } = require('../channel-inbox.cjs');

const USER_ID = /^[A-Za-z0-9._@-]{1,64}$/;
const WECOM_EVENT_LIMIT = 1000;

function text(value, max) {
  return String(value ?? '').slice(0, max);
}

function createSourceEvent(input) {
  const event = {
    source: text(input.source, 40).trim(),
    connectionId: text(input.connectionId || 'default', 80),
    tenantId: text(input.tenantId || 'local', 80),
    sourceId: text(input.sourceId, 200).trim(),
    conversationId: input.conversationId == null ? null : text(input.conversationId, 200),
    conversationType: input.conversationType === 'group' ? 'group' : 'single',
    actorId: text(input.actorId, 120).trim(),
    occurredAt: input.occurredAt || input.receivedAt || new Date().toISOString(),
    receivedAt: input.receivedAt || new Date().toISOString(),
    contentType: input.contentType || 'text',
    text: text(input.text, 20000),
    // What the sender is allowed to reach. Adapters fill it; policy enforces it.
    permissionScope: input.permissionScope || null,
    rawRef: input.rawRef || null
  };
  if (!event.source) throw new Error('消息来源无效');
  if (!event.sourceId) throw new Error('外部消息 ID 无效');
  if (!event.actorId) throw new Error('发送者无效');
  return Object.freeze(event);
}

const sourceKey = event => `${event.source}:${event.connectionId}:${event.sourceId}`;

// WeCom intelligent-bot text frame -> SourceEvent. Returns null for frames the
// bot must ignore (missing/invalid sender or message ID), matching prior checks.
function wecomBotEvent(frame, { connectionId = 'bot', receivedAt } = {}) {
  const body = frame?.body || {};
  const userId = String(body.from?.userid || '');
  const msgId = String(body.msgid || '');
  if (!USER_ID.test(userId) || !msgId || msgId.length > 200) return null;
  const group = body.chattype === 'group';
  return createSourceEvent({
    source: 'wecom', connectionId, sourceId: msgId, actorId: userId,
    conversationId: group ? String(body.chatid || '') || null : userId,
    conversationType: group ? 'group' : 'single',
    receivedAt, text: String(body.text?.content || ''),
    permissionScope: { kind: 'wecom-member', userId },
    rawRef: { msgid: msgId }
  });
}

// Persist a WeCom bot event with the exact legacy semantics: dedupe by msgid,
// keep metadata for every message (max 1000), keep single-chat text in the
// shared inbox (max 50). Group text is never stored.
function recordWecomEvent(data, event) {
  data.wecomEvents ||= [];
  if (data.wecomEvents.some(item => item.msgId === event.sourceId)) return { duplicate: true };
  const at = event.receivedAt;
  data.wecomEvents.push({ msgId: event.sourceId, userId: event.actorId, chatType: event.conversationType, at });
  if (data.wecomEvents.length > WECOM_EVENT_LIMIT) data.wecomEvents.splice(0, data.wecomEvents.length - WECOM_EVENT_LIMIT);
  // WeCom lets the bot push only to people who messaged it first; remember them.
  if (event.conversationType === 'single' && event.actorId) {
    data.wecomBotContacts ||= {};
    const known = data.wecomBotContacts[event.actorId];
    data.wecomBotContacts[event.actorId] = { firstAt: known?.firstAt || at, lastAt: at };
  }
  if (event.conversationType === 'single' && event.text.trim()) {
    recordInboundMessage(data, { channel: 'wecom', eventId: event.sourceId, senderId: event.actorId, conversationId: event.conversationId, text: event.text, receivedAt: at });
  }
  return { duplicate: false };
}

// Generic channel event bound to a known task (IPC channel:ingest). Legacy
// record shape { id, externalId, source, sender, text, taskId, occurredAt, decision }.
function channelIngestEvent(input, makeId) {
  const required = (value, label, max) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${label} 无效`);
    return value.trim();
  };
  const externalId = required(input.externalId || makeId(), '外部消息 ID', 160);
  const taskId = required(input.taskId, '任务 ID', 100);
  const event = createSourceEvent({
    source: required(input.source, '消息来源', 40), sourceId: externalId,
    actorId: required(input.sender, '发送者', 120), text: required(input.text, '消息', 2000),
    occurredAt: input.occurredAt || new Date().toISOString(),
    permissionScope: { kind: 'task', taskId }
  });
  return { event, taskId };
}

const hasChannelEvent = (data, event) => (data.channelEvents || []).some(item => item.externalId === event.sourceId && item.source === event.source);

function recordChannelEvent(data, event, taskId, decision, id) {
  data.channelEvents ||= [];
  if (hasChannelEvent(data, event)) return { duplicate: true };
  data.channelEvents.push({ id, externalId: event.sourceId, source: event.source, sender: event.actorId, text: event.text, taskId, occurredAt: event.occurredAt, decision });
  return { duplicate: false };
}

module.exports = { createSourceEvent, sourceKey, wecomBotEvent, recordWecomEvent, channelIngestEvent, hasChannelEvent, recordChannelEvent };
