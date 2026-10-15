const crypto = require('node:crypto');

const CATEGORIES = new Set(['偏好', '约定', '流程', '项目背景', '其他']);
const OWNER_ID = 'local-user';

function memorySeed() {
  return { schemaVersion: 1, items: [] };
}

function compactText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new Error(`${label}无效`);
  }
  return value.trim();
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map(tag => String(tag).trim()).filter(Boolean))].slice(0, 8).map(tag => tag.slice(0, 24));
}

function createMemory(input, { scope, workspaceId = null, sourceTaskId = null, sourceExcerpt = null } = {}) {
  if (!['personal', 'team'].includes(scope)) throw new Error('记忆范围无效');
  if (scope === 'team' && !workspaceId) throw new Error('团队记忆必须指定工作空间');
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    scope,
    ownerId: scope === 'personal' ? OWNER_ID : null,
    workspaceId: scope === 'team' ? workspaceId : null,
    title: compactText(input.title, '标题', 120),
    content: compactText(input.content, '内容', 2000),
    category: CATEGORIES.has(input.category) ? input.category : '其他',
    tags: normalizeTags(input.tags),
    // Personal memory stays in personal work unless marked portable (「可随我带入团队」).
    ...(scope === 'personal' ? { portable: input.portable === true } : {}),
    source: sourceTaskId ? { type: 'task', taskId: sourceTaskId, excerpt: String(sourceExcerpt || '').slice(0, 500) } : { type: 'manual' },
    status: 'active',
    confirmedBy: OWNER_ID,
    createdAt: now,
    updatedAt: now
  };
}

function extractCandidate(task) {
  const messages = Array.isArray(task.messages) ? task.messages : [];
  const explicit = [...messages].reverse().find(message =>
    message.role === 'user' && /(?:记住|以后|约定|原则|偏好)[：:，,\s]/.test(message.text || '')
  );
  const excerpt = explicit?.text || task.goal || task.title || '';
  return {
    title: String(excerpt).replace(/^(?:请)?(?:记住|以后|约定|原则|偏好)[：:，,\s]*/, '').slice(0, 44),
    content: String(excerpt).slice(0, 2000),
    category: explicit ? '约定' : '其他',
    tags: [],
    sourceTaskId: task.id,
    sourceExcerpt: String(excerpt).slice(0, 500),
    workspace: task.workspace
  };
}

function getApplicableMemories(personalItems, teamItems, workspaceId, ownerId = OWNER_ID) {
  const personal = personalItems.filter(item => item.status === 'active' && item.scope === 'personal' && item.ownerId === ownerId);
  const spaces = new Set([].concat(workspaceId).filter(Boolean));
  const team = teamItems.filter(item => item.status === 'active' && item.scope === 'team' && spaces.has(item.workspaceId));
  return { personal, team };
}

module.exports = { OWNER_ID, memorySeed, createMemory, extractCandidate, getApplicableMemories };
