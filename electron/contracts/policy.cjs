// Policy: who may do what on which workspace, and which changes need a human.
// Every entry point (local UI, WeCom bot, WorkBuddy bridge, automation rules)
// names an actor and asks here; no adapter decides permissions on its own.
//
// Single-machine MVP semantics are preserved exactly:
// - the local Mac user owns all local data;
// - a WeCom member reaches only spaces they were explicitly linked to;
// - WorkBuddy acts as a delegate of the local user;
// - a WeCom summary rule may create work only in its configured space.

const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
const ACTION_MIN_ROLE = {
  'work.view': 'viewer',
  'work.create': 'editor',
  'work.append': 'editor'
};

const actors = {
  local: () => ({ type: 'local', id: 'local-user' }),
  wecom: userId => ({ type: 'wecom', id: String(userId) }),
  workbuddy: () => ({ type: 'workbuddy', id: 'workbuddy-local' }),
  rule: (ruleId, workspaceId, sourceUserId) => ({ type: 'rule', id: String(ruleId), workspaceId, sourceUserId })
};

function workspaceRole(space, actor) {
  if (!space || !actor) return null;
  if (actor.type === 'local') return 'owner';
  if (actor.type === 'workbuddy') return 'editor';
  if (actor.type === 'rule') return space.id === actor.workspaceId ? 'editor' : null;
  if (actor.type === 'wecom') {
    const member = (space.members || []).find(item => item.wecomUserId === actor.id && ['wecom', 'active'].includes(item.status));
    return member ? member.role || null : null;
  }
  return null;
}

// Returns { allowed, role, reason } where reason is 'no-access' (not a member)
// or 'read-only' (member, but role too low). Adapters map reasons to wording.
function authorize(actor, action, space) {
  const needed = ACTION_MIN_ROLE[action];
  if (!needed) throw new Error(`未知操作：${action}`);
  const role = workspaceRole(space, actor);
  if (!role) return { allowed: false, role: null, reason: 'no-access' };
  if ((ROLE_RANK[role] || 0) < ROLE_RANK[needed]) return { allowed: false, role, reason: 'read-only' };
  return { allowed: true, role, reason: null };
}

// A work belongs to one primary space and may be related to others. Access is
// granted by the best role across all of them: relating a work to a space is an
// explicit decision to make it visible and usable there.
function authorizeAny(actor, action, spaces) {
  let fallback = { allowed: false, role: null, reason: 'no-access' };
  for (const space of spaces.filter(Boolean)) {
    const result = authorize(actor, action, space);
    if (result.allowed) return result;
    if (result.reason === 'read-only') fallback = result;
  }
  return fallback;
}

// Context boundary for executing Agents: personal memory belongs to the local
// user and never follows work that a colleague started from a channel.
const mayUsePersonalMemory = origin => !origin;

// ---- approval boundary for changes proposed from channels / Agents ----

const APPROVAL_FIELDS = new Set(['owner', 'deadline', 'permissions', 'budget', 'externalSend', 'publish', 'delete', 'taskDone']);
const REVERSIBLE_FIELDS = new Set(['progress', 'note', 'evidence']);

function changeRisk(field) {
  if (APPROVAL_FIELDS.has(field)) return 'approval';
  if (REVERSIBLE_FIELDS.has(field)) return 'reversible';
  return 'approval'; // Unknown fields default to the safe side.
}

const COMPLETION_WORDS = /(已完成|做完了|处理完了|已经解决|可以发布|验收通过)/;
const HIGH_IMPACT_WORDS = /(负责人|截止时间|延期|预算|发布到外部|删除|权限)/;

// Decide archive / reversible auto-update / suggest-for-approval for a channel
// message already bound to a task (docs/CHANNEL_INTEGRATIONS.md).
function classifyChannelEvent(event) {
  const content = String(event.text || '').trim();
  if (!content) return { action: 'archive', reason: 'empty' };
  if (HIGH_IMPACT_WORDS.test(content)) {
    return { action: 'suggest', reason: 'high-impact-field', suggestion: '请负责人确认后更新任务' };
  }
  if (COMPLETION_WORDS.test(content) && changeRisk('progress') === 'reversible') {
    return { action: 'auto-update', reason: 'explicit-completion', patch: { progressConfirmed: true } };
  }
  return { action: 'archive', reason: 'context-only' };
}

module.exports = { ROLE_RANK, ACTION_MIN_ROLE, actors, workspaceRole, authorize, authorizeAny, mayUsePersonalMemory, changeRisk, classifyChannelEvent };
