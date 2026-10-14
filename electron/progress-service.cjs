// 进展：what the team sees instead of the full back-and-forth with an Agent.
//
// Each Agent reply ends with a small structured block of key progress. 共作
// strips it from the reply, keeps the items as drafts on the work, and the
// person who owns the conversation confirms (or edits / dismisses) them with
// one click. Published items show on the work and in the space feed.
const crypto = require('node:crypto');

const KINDS = Object.freeze({ conclusion: '结论', decision: '决定', output: '产出', blocker: '卡点', todo: '待办' });
const LABELS = {
  结论: 'conclusion', 结果: 'conclusion', 发现: 'conclusion',
  决定: 'decision', 决策: 'decision',
  产出: 'output', 交付: 'output', 文件: 'output', 成果: 'output',
  卡点: 'blocker', 阻塞: 'blocker', 风险: 'blocker', 问题: 'blocker',
  待办: 'todo', 下一步: 'todo', 行动: 'todo', todo: 'todo',
  conclusion: 'conclusion', decision: 'decision', output: 'output', blocker: 'blocker'
};
const MAX_ITEMS = 5;
const MAX_TEXT = 120;

const PROGRESS_INSTRUCTION = [
  '回复正文写完后，另起一行附上本轮值得同步给团队的关键进展（只写结果，不写过程、寒暄和重复内容）：',
  '<进展>',
  '[{"类型":"结论|决定|产出|卡点|待办","内容":"一句话，40 字以内"}]',
  '</进展>',
  '没有值得同步的进展就写 <进展>[]</进展>。这个块会被共作取走，不会展示给提问的人。'
].join('\n');

const BLOCK = /<(进展|progress)>\s*([\s\S]*?)\s*<\/\1>/giu;

function kindOf(label) {
  const key = String(label || '').trim().replace(/[：:]/g, '');
  return LABELS[key] || LABELS[key.toLowerCase()] || null;
}

function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function parseItems(raw) {
  let list;
  try { list = JSON.parse(raw); } catch {
    // Tolerate "- 结论：xxx" lines when the model ignored the JSON format.
    list = String(raw).split(/\n+/).map(line => line.replace(/^[-*•\d.\s]+/, '')).map(line => {
      const match = line.match(/^([^：:]{1,6})[：:]\s*(.+)$/u);
      return match ? { 类型: match[1], 内容: match[2] } : null;
    }).filter(Boolean);
  }
  if (!Array.isArray(list)) return [];
  const items = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const kind = kindOf(entry.类型 ?? entry.type ?? entry.kind);
    const text = clean(entry.内容 ?? entry.text ?? entry.content);
    if (kind && text && !items.some(item => item.text === text)) items.push({ kind, text });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

// Returns the reply without progress blocks, and the items they declared.
function extractProgress(reply) {
  const source = String(reply || '');
  let found = false;
  let items = [];
  const text = source.replace(BLOCK, (_, _tag, inner) => {
    found = true;
    items = items.concat(parseItems(inner));
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { text: text || source.trim(), items: items.slice(0, MAX_ITEMS), found };
}

// When an Agent did not declare progress, pick out only what is clearly
// marked; never turn ordinary prose into team updates.
function fallbackProgress(reply, artifacts = []) {
  const items = [];
  const lines = String(reply || '').split('\n').map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.replace(/^[-*>\s]+/, '').match(/^\**\s*(结论|决定|卡点|风险|阻塞|下一步|待办)\s*\**\s*[：:]\s*\**\s*(.+)$/u);
    if (match) {
      const text = clean(match[2].replace(/\*+/g, ''));
      const kind = kindOf(match[1]);
      if (text && kind && !items.some(item => item.text === text)) items.push({ kind, text });
    }
    if (items.length >= 3) break;
  }
  if (artifacts.length) items.push({ kind: 'output', text: clean(`生成文件：${artifacts.map(item => item.name).join('、')}`) });
  return items.slice(0, MAX_ITEMS);
}

function draft(items, { sourceMessageId, author = 'agent', at = new Date().toISOString() } = {}) {
  return items.map(item => ({ id: crypto.randomUUID(), kind: item.kind, text: item.text, status: 'draft', author, sourceMessageId: sourceMessageId || null, createdAt: at }));
}

function validKind(kind) {
  if (!Object.hasOwn(KINDS, kind)) throw new Error('进展类型无效');
  return kind;
}

function validText(text) {
  const value = clean(text);
  if (!value) throw new Error('进展内容不能为空');
  return value;
}

module.exports = { KINDS, PROGRESS_INSTRUCTION, extractProgress, fallbackProgress, draft, validKind, validText, MAX_TEXT };
