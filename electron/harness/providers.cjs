// Model seam for the 共作 kernel: one `complete()` per step, normalised to
// { text, toolCalls: [{ id, name, arguments }], stopReason, usage, raw }.
//
// - OpenAI official → Responses API (function_call items).
// - Everything else (DeepSeek, Kimi, compatible gateways, local servers) →
//   Chat Completions with `tools`.
// Non-streaming on purpose: progress is reported per step, and a step's tool
// calls are only executed once the whole message (and its stop reason) is in.

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const STEP_TIMEOUT_MS = 120000;

class ProviderError extends Error {
  constructor(message, { status, toolsUnsupported = false } = {}) {
    super(message);
    this.status = status;
    this.toolsUnsupported = toolsUnsupported;
  }
}

// A gateway that does not support function calling usually says so in a 400/422.
const TOOLS_UNSUPPORTED = /(tool|function)[^.]{0,60}(not support|unsupported|not allowed|invalid|unknown|unrecognized)|(not support|unsupported|unknown|unrecognized)[^.]{0,60}(tool|function)/i;

async function postJson(url, body, { key, fetchImpl = fetch, signal, timeoutMs = STEP_TIMEOUT_MS }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body)
    });
  } catch (error) {
    if (signal?.aborted) throw new ProviderError('已取消');
    if (timeout.aborted) throw new ProviderError('模型响应超时');
    throw new ProviderError('连接失败，请检查地址、网络和服务状态');
  }
  const raw = await response.text().catch(() => '');
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) throw new ProviderError('服务响应过大');
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new ProviderError('身份验证失败，请检查密钥或服务权限', { status: response.status });
    if (response.status === 429) throw new ProviderError('服务请求过于频繁或额度不足', { status: response.status });
    const detail = raw.replace(/\s+/g, ' ').slice(0, 300);
    throw new ProviderError(`服务返回 HTTP ${response.status}`, { status: response.status, toolsUnsupported: [400, 404, 422].includes(response.status) && TOOLS_UNSUPPORTED.test(detail) });
  }
  try { return JSON.parse(raw); } catch { throw new ProviderError('服务没有返回有效的 JSON'); }
}

const declare = tools => tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));

// ---- Chat Completions ----

function chatMessages(system, history) {
  const out = [{ role: 'system', content: system }];
  for (const item of history) {
    if (item.role === 'user') out.push({ role: 'user', content: item.content });
    else if (item.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: item.content || (item.toolCalls?.length ? null : ''),
        ...(item.reasoning ? { reasoning_content: item.reasoning } : {}),
        ...(item.toolCalls?.length ? { tool_calls: item.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {})
      });
    } else if (item.role === 'tool') out.push({ role: 'tool', tool_call_id: item.toolCallId, content: item.content });
  }
  return out;
}

function parseChat(body) {
  const choice = body?.choices?.[0];
  const message = choice?.message;
  if (!message) throw new ProviderError('模型没有返回结果');
  const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
    .filter(call => call?.function?.name)
    .map((call, index) => ({ id: String(call.id || `call_${index}`), name: String(call.function.name), arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}) }));
  const finish = choice.finish_reason;
  return {
    text: typeof message.content === 'string' ? message.content : '',
    ...(typeof message.reasoning_content === 'string' && message.reasoning_content ? { reasoning: message.reasoning_content } : {}),
    toolCalls,
    stopReason: finish === 'length' ? 'length' : toolCalls.length ? 'tool_use' : 'stop',
    usage: body.usage ? { input: body.usage.prompt_tokens || 0, output: body.usage.completion_tokens || 0 } : null
  };
}

// ---- Responses API ----

function responsesInput(history) {
  const out = [];
  for (const item of history) {
    if (item.role === 'user') out.push({ role: 'user', content: item.content });
    else if (item.role === 'assistant') {
      if (item.content) out.push({ role: 'assistant', content: item.content });
      for (const call of item.toolCalls || []) out.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
    } else if (item.role === 'tool') out.push({ type: 'function_call_output', call_id: item.toolCallId, output: item.content });
  }
  return out;
}

function parseResponses(body) {
  const output = Array.isArray(body?.output) ? body.output : [];
  const text = output.filter(item => item.type !== 'function_call' && Array.isArray(item.content)).flatMap(item => item.content)
    .filter(part => part.type === 'output_text' && typeof part.text === 'string').map(part => part.text).join('\n')
    || (typeof body?.output_text === 'string' ? body.output_text : '');
  const toolCalls = output.filter(item => item.type === 'function_call' && item.name)
    .map((item, index) => ({ id: String(item.call_id || item.id || `call_${index}`), name: String(item.name), arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) }));
  const truncated = body?.status === 'incomplete' && /max_output_tokens/.test(String(body?.incomplete_details?.reason || ''));
  return {
    text,
    toolCalls,
    stopReason: truncated ? 'length' : toolCalls.length ? 'tool_use' : 'stop',
    usage: body?.usage ? { input: body.usage.input_tokens || 0, output: body.usage.output_tokens || 0 } : null
  };
}

function createProvider(config, fetchImpl = fetch) {
  const model = config?.model || {};
  const modelId = String(model.modelId || '').trim();
  const baseUrl = String(model.baseUrl || '').trim().replace(/\/$/, '');
  if (!modelId) throw new ProviderError('请先配置模型 ID');
  if (!baseUrl) throw new ProviderError('请先配置模型地址');
  const key = config.modelKey || (model.provider === 'openai' ? process.env.OPENAI_API_KEY : null);
  if (['openai', 'kimi', 'deepseek'].includes(model.provider) && !key) throw new ProviderError('请先配置模型 API Key');
  const responses = model.provider === 'openai';
  return {
    id: responses ? 'openai-responses' : 'openai-chat',
    model: modelId,
    async complete({ system, history, tools = [], signal }) {
      if (responses) {
        const body = await postJson(`${baseUrl}/responses`, {
          model: modelId, instructions: system, input: responsesInput(history), store: false,
          ...(tools.length ? { tools: declare(tools).map(tool => ({ type: 'function', ...tool })) } : {})
        }, { key, fetchImpl, signal });
        return parseResponses(body);
      }
      const body = await postJson(`${baseUrl}/chat/completions`, {
        model: modelId, messages: chatMessages(system, history),
        ...(tools.length ? { tools: declare(tools).map(tool => ({ type: 'function', function: tool })), tool_choice: 'auto' } : {})
      }, { key, fetchImpl, signal });
      return parseChat(body);
    }
  };
}

module.exports = { createProvider, ProviderError, chatMessages, parseChat, responsesInput, parseResponses };
