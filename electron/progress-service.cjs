// 进展：what the team sees instead of the full back-and-forth with an Agent.
//
// Progress is written only when a stage of the work is finished (a conclusion
// reached, a decision made, a deliverable produced, a blocker that needs
// someone else). Analysis, clarifying questions and intermediate rounds
// produce nothing. The Agent decides and summarises the whole stage, not just
// its last reply. 共作 strips the block from the reply, keeps the items as
// drafts, and the person confirms them under that reply.
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
  '【团队进展】只有当这项工作的一个阶段完成时，才在回复末尾附上进展块，例如：得出了明确结论、做出了决定、交付了文件或成果、遇到需要别人处理的卡点、明确了谁在什么时候做什么。',
  '分析中、追问或澄清需求、给出待确认的方案、闲聊、和之前重复的内容，都不算阶段完成，此时不要附进展块。',
  '附进展块时，总结的是从上一次进展以来这一整段工作的结果（不是只总结这一句回复），1 到 3 条，只写结果、不写过程：',
  '写事情本身的结果——数字、决定、谁负责什么、什么时候——让没看对话的同事一眼看懂；不要写“已完成回复”“已交付文档”“已整理好”这类描述本次对话的话。',
  '<进展>',
  '[{"类型":"结论|决定|产出|卡点|待办","内容":"一句话，40 字以内"}]',
  '</进展>',
  '这个块会被共作取走，作为团队可见的进展，不会展示在对话里。'
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

// When an Agent did not declare progress, the only stage completion 共作 can
// see for itself is a delivered file. Ordinary replies produce nothing.
function fallbackProgress(reply, artifacts = []) {
  return artifacts.length ? [{ kind: 'output', text: clean(`生成文件：${artifacts.map(item => item.name).join('、')}`) }] : [];
}

// Drop items the work already has — pending, published (incl. its text before
// the person edited it) or dismissed (they chose not to share it).
function dedupe(items, existing = []) {
  const seen = new Set(existing.flatMap(item => [item.text, item.originalText]).filter(Boolean));
  return items.filter(item => !seen.has(item.text));
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

module.exports = { KINDS, PROGRESS_INSTRUCTION, extractProgress, fallbackProgress, dedupe, draft, validKind, validText, MAX_TEXT };
