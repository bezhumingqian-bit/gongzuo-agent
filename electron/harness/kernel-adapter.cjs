// Adapter between 共作's work model and the kernel: builds the prompt and the
// scoped 共作 tools, reports tool steps as run progress, and falls back to a
// plain model call when the endpoint does not support function calling.
const { conversationInput, callModel } = require('../connection-service.cjs');
const { mergeStep } = require('../execution-log.cjs');
const { runKernel } = require('./kernel.cjs');
const { createProvider } = require('./providers.cjs');
const { createGongzuoTools } = require('./gongzuo-tools.cjs');

const KERNEL_GUIDANCE = [
  '【共作内核】你可以调用共作工具：按需查找和读取这项工作可引用的资料、查找适用记忆、查看已确认进展。',
  '先判断是否需要查资料；需要时先列出再读取，不要猜资料内容。修改负责人、截止时间、完成状态或对外发送等，只能用 gongzuo_propose_change 提议，不能声称已经修改。',
  '你没有文件、命令或网络工具；做不到的事直接说明。'
].join('\n');

const STOP_NOTES = {
  max_steps: '（已达到本轮工具调用上限；以上结论基于已获取的信息。）',
  timeout: '（本轮超过时间上限，已停止；以上是已产出的部分，不代表完成。）',
  cancelled: '（本轮已取消；以上是已产出的部分。）',
  max_tokens: '（模型输出达到长度上限，内容可能不完整。）'
};

const emptyScope = (task, memoryContext) => ({
  listMaterials: async () => [],
  readMaterial: async () => { throw new Error('这项工作没有可读取的资料'); },
  spaceNames: {},
  memory: memoryContext,
  progress: task.progress || [],
  goal: task.goal
});

async function callKernel(config, task, memoryContext = {}, hooks = {}, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const input = conversationInput(task.messages || [], memoryContext);
  const scope = { ...emptyScope(task, memoryContext), ...(hooks.toolScope || {}) };
  const level = options.level || 'K0';
  const { tools, guard, proposals } = createGongzuoTools(scope, { level });
  const provider = (options.providerFactory || createProvider)(config, fetchImpl);
  const onProgress = hooks.onProgress || (() => {});
  let execution = [];
  let steps = 0;
  let text = '';
  const report = extra => {
    try { Promise.resolve(onProgress({ text, steps, execution: execution.map(item => ({ ...item })), lastActivityAt: Date.now(), ...extra })).catch(() => {}); } catch { /* progress is best effort */ }
  };
  let result;
  try {
    result = await runKernel({
      provider,
      system: `${input.instructions}\n\n${KERNEL_GUIDANCE}`,
      history: input.messages,
      tools,
      limits: options.limits,
      signal: options.signal,
      hooks: {
        beforeToolCall: guard,
        onEvent: event => {
          if (event.type === 'text') { text = event.text; report(); return; }
          if (event.type !== 'tool') return;
          if (event.status === 'in_progress') steps += 1;
          execution = mergeStep(execution, { id: event.id, title: event.title, kind: event.kind, status: event.status, startedAt: event.startedAt, endedAt: event.endedAt });
          report(event.status === 'in_progress' ? { step: event.title } : {});
        }
      }
    });
  } catch (error) {
    if (!error.toolsUnsupported) throw error;
    // The endpoint rejected `tools`: answer as a plain conversation, and say so.
    const plain = await callModel(config, task.messages || [], memoryContext, fetchImpl);
    return { text: `${plain}\n\n（当前模型接口不支持工具调用，本轮按纯对话回答，未查阅空间资料。）`, kernel: { level, fallback: 'no-tools' } };
  }
  const note = STOP_NOTES[result.stopReason];
  const body = result.text || (result.stopReason === 'end_turn' ? '模型没有返回文字结果。' : '');
  // The note belongs to the reply, before a trailing <进展> block (TaskRunner extracts that block).
  const block = body.search(/<(进展|progress)>/u);
  const reply = !note ? body : block >= 0 ? `${body.slice(0, block).trimEnd()}\n\n${note}\n\n${body.slice(block)}` : `${body}\n\n${note}`;
  return {
    text: reply.trim().slice(0, 50000),
    kernel: { level, steps: result.steps, toolCalls: result.toolCalls, stopReason: result.stopReason, usage: result.usage },
    ...(proposals.length ? { proposals } : {})
  };
}

module.exports = { callKernel, KERNEL_GUIDANCE };
