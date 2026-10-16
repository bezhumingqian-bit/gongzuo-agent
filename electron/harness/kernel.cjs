// 共作内核：一个最小的 agent loop（模型 ↔ 工具），供自有模型 API 使用。
//
// 设计参考两个 MIT 开源 harness 的公开思路（未拷贝代码）：
// - pi-agent-core：工具调用前后钩子（beforeToolCall 可拦截，拦截结果以错误回给模型）；
//   输出被截断（length）时整批工具调用都不执行，避免执行残缺参数。
// - DeepSeek Harness：turn / step 两级生命周期；追加式轨迹；超出预算或取消时，
//   未分发的调用补一条合成结果，模型不会面对“消失的调用”。
//
// 能力分级由传入的工具决定（K0 只有共作工具）；内核本身不认识任何具体工具。
// 共作原则：轨迹只记动作名、状态和耗时，不记录参数、工具输出或思考正文。

const LIMITS = Object.freeze({
  maxSteps: 12,            // 模型调用次数上限（含最后的收尾调用）
  maxMs: 5 * 60 * 1000,    // 一轮总时长
  maxCallsPerStep: 8,      // 单步最多执行的工具调用
  maxResultChars: 12000    // 单个工具结果回给模型的上限
});

const SKIPPED = '未执行：本步工具调用超出上限或已取消。';
const TRUNCATED = '未执行：模型输出被截断，工具参数可能不完整。请缩短参数后重试。';
const WRAP_UP = '已达到本轮工具调用上限。请不要再调用工具，直接根据已获得的信息给出结论；信息不足的部分写明待核实。';

const clip = (value, length) => (value.length > length ? `${value.slice(0, length)}\n…（已截断，共 ${value.length} 字）` : value);

// Minimal JSON-schema check: required keys and primitive types of declared properties.
function validateArgs(tool, raw) {
  let args;
  try { args = raw ? JSON.parse(raw) : {}; } catch { return { error: '参数不是有效的 JSON' }; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: '参数必须是对象' };
  const schema = tool.parameters || {};
  for (const key of schema.required || []) if (args[key] == null || args[key] === '') return { error: `缺少参数 ${key}` };
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    if (args[key] == null) continue;
    const type = Array.isArray(args[key]) ? 'array' : typeof args[key];
    const expected = spec.type === 'integer' ? 'number' : spec.type;
    if (expected && type !== expected) return { error: `参数 ${key} 应为 ${spec.type}` };
    if (spec.enum && !spec.enum.includes(args[key])) return { error: `参数 ${key} 只能是 ${spec.enum.join(' / ')}` };
  }
  return { args };
}

async function runKernel({ provider, system, history: input, tools = [], limits = {}, hooks = {}, signal, now = Date.now }) {
  const limit = { ...LIMITS, ...limits };
  const history = input.map(item => ({ ...item }));
  const trajectory = [];
  const record = (type, data = {}) => { trajectory.push({ type, at: now(), ...data }); };
  const emit = event => { try { hooks.onEvent?.(event); } catch { /* observers never break the loop */ } };
  const startedAt = now();
  const usage = { input: 0, output: 0 };
  let text = '';
  let stopReason = null;
  let steps = 0;
  let toolCalls = 0;
  record('turn/start', { provider: provider.id, model: provider.model, tools: tools.map(tool => tool.name) });

  const addResult = (call, content, isError) => {
    history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: isError ? `【错误】${content}` : content });
  };

  for (;;) {
    if (signal?.aborted) { stopReason = 'cancelled'; break; }
    if (now() - startedAt > limit.maxMs) { stopReason = 'timeout'; break; }
    const wrapUp = steps >= limit.maxSteps - 1;
    steps += 1;
    record('step/start', { step: steps, wrapUp });
    if (wrapUp) history.push({ role: 'user', content: WRAP_UP });
    let reply;
    try {
      reply = await provider.complete({ system, history, tools: wrapUp ? [] : tools, signal });
    } catch (error) {
      record('assistant/attempt', { step: steps, error: String(error.message || error).slice(0, 160) });
      record('turn/end', { stopReason: 'error' });
      error.trajectory = trajectory;
      throw error;
    }
    if (reply.usage) { usage.input += reply.usage.input; usage.output += reply.usage.output; }
    const calls = wrapUp ? [] : reply.toolCalls || [];
    record('assistant/message', { step: steps, stopReason: reply.stopReason, toolCalls: calls.map(call => call.name), chars: (reply.text || '').length });
    history.push({ role: 'assistant', content: reply.text || '', ...(reply.reasoning ? { reasoning: reply.reasoning } : {}), toolCalls: calls });
    if (reply.text?.trim()) {
      text = reply.text.trim();
      emit({ type: 'text', text });
    }
    if (!calls.length) { stopReason = reply.stopReason === 'length' ? 'max_tokens' : wrapUp ? 'max_steps' : 'end_turn'; break; }

    if (reply.stopReason === 'length') {
      for (const call of calls) { addResult(call, TRUNCATED, true); record('tool/result', { step: steps, id: call.id, name: call.name, status: 'skipped' }); }
      continue;
    }

    for (const [index, call] of calls.entries()) {
      if (signal?.aborted || index >= limit.maxCallsPerStep) {
        addResult(call, SKIPPED, true);
        record('tool/result', { step: steps, id: call.id, name: call.name, status: 'skipped' });
        continue;
      }
      const tool = tools.find(item => item.name === call.name);
      const started = now();
      const event = { id: call.id, kind: tool?.kind || 'other', title: tool ? (tool.title?.() || tool.name) : call.name };
      if (!tool) {
        addResult(call, `没有名为 ${call.name} 的工具`, true);
        record('tool/result', { step: steps, id: call.id, name: call.name, status: 'failed', reason: 'unknown-tool' });
        continue;
      }
      const checked = validateArgs(tool, call.arguments);
      if (checked.error) {
        addResult(call, checked.error, true);
        record('tool/result', { step: steps, id: call.id, name: call.name, status: 'failed', reason: 'invalid-args' });
        continue;
      }
      event.title = tool.title?.(checked.args) || tool.name;
      const before = await hooks.beforeToolCall?.({ tool, call, args: checked.args });
      if (before?.block) {
        addResult(call, before.reason || '该操作不被允许', true);
        record('tool/result', { step: steps, id: call.id, name: call.name, status: 'blocked' });
        emit({ type: 'tool', ...event, status: 'failed', startedAt: started, endedAt: now() });
        continue;
      }
      toolCalls += 1;
      record('tool/call', { step: steps, id: call.id, name: call.name });
      emit({ type: 'tool', ...event, status: 'in_progress', startedAt: started });
      let content;
      let isError = false;
      try {
        const result = await tool.execute(checked.args, { signal });
        content = typeof result === 'string' ? result : JSON.stringify(result);
      } catch (error) {
        content = String(error?.message || error || '工具执行失败').slice(0, 300);
        isError = true;
      }
      const after = await hooks.afterToolCall?.({ tool, call, args: checked.args, content, isError });
      if (after?.content != null) content = String(after.content);
      if (after?.isError != null) isError = Boolean(after.isError);
      addResult(call, clip(content, limit.maxResultChars), isError);
      const ended = now();
      record('tool/result', { step: steps, id: call.id, name: call.name, status: isError ? 'failed' : 'completed', ms: ended - started });
      emit({ type: 'tool', ...event, status: isError ? 'failed' : 'completed', startedAt: started, endedAt: ended });
    }
  }
  record('turn/end', { stopReason, steps, toolCalls });
  return { text, stopReason, steps, toolCalls, usage, trajectory, history };
}

module.exports = { runKernel, validateArgs, LIMITS };
