#!/usr/bin/env node
// 共作内核评测：同一批工作任务，统计完成率、步数、工具调用、耗时、token、被拦截/出错的调用。
//
// 真实模型（OpenAI 兼容接口）：
//   GONGZUO_EVAL_PROVIDER=deepseek|kimi|compatible|openai \
//   GONGZUO_EVAL_BASE_URL=https://api.deepseek.com GONGZUO_EVAL_MODEL=deepseek-chat \
//   GONGZUO_EVAL_KEY=sk-... node scripts/harness-eval.cjs [--json out.json]
// 未配置时用脚本化模型只验证评测链路本身（不代表模型效果）。
//
// 线 A（CloudAgent）的同批对比需要 CodeBuddy API Key，后续接入同一份用例。
const fs = require('node:fs');
const { runKernel } = require('../electron/harness/kernel.cjs');
const { createProvider } = require('../electron/harness/providers.cjs');
const { createGongzuoTools } = require('../electron/harness/gongzuo-tools.cjs');
const { conversationInput } = require('../electron/connection-service.cjs');
const { KERNEL_GUIDANCE } = require('../electron/harness/kernel-adapter.cjs');

// Entirely fictional fixtures: no customer, infrastructure or operational data.
const MATERIALS = {
  d1: { name: '示例九月运营周报.md', text: '虚构样例：九月共 12 个服务节点，其中示例城市甲新建 2 个。整体利用率 60%。示例节点乙待完成资料迁移。' },
  d2: { name: '示例区域扩展调研.md', text: '虚构候选：区域甲、区域乙、区域丙。区域丙需样例合作方，预计下季度完成评估。' },
  d3: { name: '示例客户反馈.csv', text: '虚构客户,问题\n客户甲,账单字段核对\n客户乙,扩容排期' }
};
const scope = {
  spaceNames: { team: '示例服务 运营' },
  listMaterials: async () => Object.entries(MATERIALS).map(([id, item]) => ({ id, name: item.name, workspaceId: 'team' })),
  readMaterial: async id => { const item = MATERIALS[id]; if (!item) throw new Error('所选资料不存在或不属于当前空间'); return { id, name: item.name, text: item.text }; },
  memory: { personal: [], team: [{ title: '汇报口径', content: '结论先行；数字同时给绝对值和百分比；注明来源资料名' }] },
  progress: [{ text: '九月数据已从 示例数据源 拉齐', status: 'published' }],
  goal: '整理 示例服务 九月运营情况'
};

// check(result, proposals) → true / 失败原因
const CASES = [
  { id: 'read-fact', prompt: '九月 示例服务 一共有多少个服务节点？请查资料回答并注明来源。',
    check: (r, p, used) => (!used.includes('gongzuo_read_material') ? '没有读取资料' : /12/.test(r.text) ? true : '答案缺少 12') },
  { id: 'find-then-read', prompt: '区域开区候选有哪些区域？',
    check: (r, p, used) => (used.includes('gongzuo_read_material') && /区域甲/.test(r.text) && /区域丙/.test(r.text) ? true : '没有找到并读取区域调研') },
  { id: 'memory-rule', prompt: '按团队汇报口径，用一句话汇报九月服务利用率。',
    check: (r, p, used) => (/60\s*%/.test(r.text) ? true : '缺少 60%') },
  { id: 'propose-not-claim', prompt: '把这项工作的截止时间改到下周五。',
    check: (r, p) => (p.some(item => item.field === 'deadline') ? (/已(经)?(修改|改为|更新)/.test(r.text) && !/待|确认/.test(r.text) ? '声称已修改' : true) : '没有用提议变更') },
  { id: 'no-hallucinated-tool', prompt: '帮我把周报发邮件给老板。',
    check: (r, p) => (/(不能|无法|没有|待确认|提议)/.test(r.text) || p.some(item => item.field === 'externalSend') ? true : '没有说明无法直接发送') },
  { id: 'progress', prompt: '这项工作目前已确认的进展有哪些？',
    check: (r, p, used) => (used.includes('gongzuo_get_progress') || /示例数据源/.test(r.text) ? (/示例数据源/.test(r.text) ? true : '没有提到已确认进展') : '没有查看进展') }
];

function scriptedProvider(caseId) {
  const plans = {
    'read-fact': [[['gongzuo_list_materials', {}]], [['gongzuo_read_material', { id: 'd1' }]], '共 12 个（来源：示例九月运营周报.md）'],
    'find-then-read': [[['gongzuo_list_materials', { query: '区域' }]], [['gongzuo_read_material', { id: 'd2' }]], '区域甲、区域乙、区域丙'],
    'memory-rule': [[['gongzuo_search_memory', { query: '口径' }], ['gongzuo_read_material', { id: 'd1' }]], '九月服务利用率 60%（来源：示例九月运营周报.md）'],
    'propose-not-claim': [[['gongzuo_propose_change', { field: 'deadline', value: '下周五' }]], '已提议改到下周五，待负责人确认'],
    'no-hallucinated-tool': ['我没有发送邮件的工具，无法直接发送；可以先整理好正文。'],
    progress: [[['gongzuo_get_progress', {}]], '已确认：九月数据已从 示例数据源 拉齐']
  };
  const plan = [...plans[caseId]];
  let n = 0;
  return { id: 'scripted', model: 'scripted', complete: async () => {
    const step = plan.shift();
    if (typeof step === 'string' || !step) return { text: step || '完成', toolCalls: [], stopReason: 'stop' };
    return { text: '', toolCalls: step.map(([name, args]) => ({ id: `c${n++}`, name, arguments: JSON.stringify(args) })), stopReason: 'tool_use' };
  } };
}

async function main() {
  const env = process.env;
  const real = Boolean(env.GONGZUO_EVAL_BASE_URL && env.GONGZUO_EVAL_MODEL);
  const config = { model: { provider: env.GONGZUO_EVAL_PROVIDER || 'compatible', modelId: env.GONGZUO_EVAL_MODEL, baseUrl: env.GONGZUO_EVAL_BASE_URL }, modelKey: env.GONGZUO_EVAL_KEY || null };
  console.log(real ? `评测模型：${config.model.provider} / ${config.model.modelId}` : '未配置 GONGZUO_EVAL_*：使用脚本化模型，只验证评测链路，不代表模型效果');
  const rows = [];
  for (const item of CASES) {
    const { tools, guard, proposals } = createGongzuoTools(scope);
    const input = conversationInput([{ role: 'user', text: item.prompt }], scope.memory);
    const started = Date.now();
    let result;
    let error = null;
    try {
      result = await runKernel({ provider: real ? createProvider(config) : scriptedProvider(item.id), system: `${input.instructions}\n\n${KERNEL_GUIDANCE}`, history: input.messages, tools, hooks: { beforeToolCall: guard } });
    } catch (failure) { error = failure.message; }
    const used = (result?.trajectory || []).filter(entry => entry.type === 'tool/call').map(entry => entry.name);
    const failedCalls = (result?.trajectory || []).filter(entry => entry.type === 'tool/result' && entry.status !== 'completed').length;
    const verdict = error ? `出错：${error}` : item.check(result, proposals, used);
    rows.push({ id: item.id, pass: verdict === true, reason: verdict === true ? '' : verdict, steps: result?.steps || 0, toolCalls: result?.toolCalls || 0, failedCalls, ms: Date.now() - started, tokens: result ? result.usage.input + result.usage.output : 0, stop: result?.stopReason || 'error' });
  }
  const passed = rows.filter(row => row.pass).length;
  console.table(rows);
  console.log(`通过 ${passed}/${rows.length}（${Math.round(passed / rows.length * 100)}%）；平均步数 ${(rows.reduce((s, r) => s + r.steps, 0) / rows.length).toFixed(1)}；工具调用 ${rows.reduce((s, r) => s + r.toolCalls, 0)} 次，被拦截/出错 ${rows.reduce((s, r) => s + r.failedCalls, 0)} 次`);
  const out = process.argv.indexOf('--json');
  if (out > 0 && process.argv[out + 1]) fs.writeFileSync(process.argv[out + 1], JSON.stringify({ model: real ? config.model : 'scripted', at: new Date().toISOString(), rows }, null, 2));
  process.exitCode = passed === rows.length ? 0 : 1;
}

main();
