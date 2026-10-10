const test = require('node:test');
const assert = require('node:assert/strict');
const { callModel, callExternalAgent, testConnection, conversationInput } = require('../electron/connection-service.cjs');
const { AgentService } = require('../electron/agent-service.cjs');

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify(body)
});

test('OpenAI Responses 请求携带密钥但只返回生成文本', async () => {
  let request;
  const config = {
    model: { provider: 'openai', modelId: 'test-model', baseUrl: 'https://api.openai.com/v1' },
    modelKey: 'test-secret', agent: { mode: 'built-in' }
  };
  const output = await callModel(config, [{ role: 'user', text: '整理项目进展' }], {}, async (url, options) => {
    request = { url, options };
    return json({ output: [{ content: [{ type: 'output_text', text: '项目进展已整理' }] }] });
  });
  assert.equal(output, '项目进展已整理');
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.options.headers.authorization, 'Bearer test-secret');
  assert.equal(request.options.redirect, 'error');
  assert.equal(JSON.parse(request.options.body).store, false);
});

test('兼容模型和外部 Agent 各自使用明确协议', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return json(url.endsWith('/chat/completions')
      ? { choices: [{ message: { content: '兼容模型回答' } }] }
      : { output: '外部 Agent 回答' });
  };
  const model = await callModel({ model: { provider: 'compatible', modelId: 'my-model', baseUrl: 'https://model.example/v1' } }, [{ role: 'user', text: '你好' }], {}, fetchImpl);
  const agent = await callExternalAgent({ agent: { endpoint: 'https://agent.example/run' }, agentToken: 'test-token' }, [{ role: 'user', text: '处理任务' }], '项目 A', {}, fetchImpl);
  assert.equal(model, '兼容模型回答');
  assert.equal(agent, '外部 Agent 回答');
  assert.equal(calls[0].url, 'https://model.example/v1/chat/completions');
  assert.equal(calls[1].body.context.workspace, '项目 A');
  assert.equal(calls[1].body.input, '处理任务');
});

test('Kimi 和 DeepSeek 使用各自的官方接口及已保存密钥', async () => {
  for (const [provider, modelId, baseUrl] of [
    ['kimi', 'kimi-k3', 'https://api.moonshot.cn/v1'],
    ['deepseek', 'deepseek-flash', 'https://api.deepseek.com']
  ]) {
    let request;
    const answer = await callModel({ model: { provider, modelId, baseUrl }, modelKey: `${provider}-secret` }, [{ role: 'user', text: '你好' }], {}, async (url, options) => {
      request = { url, options };
      return json({ choices: [{ message: { content: '连接成功' } }] });
    });
    assert.equal(answer, '连接成功');
    assert.equal(request.url, `${baseUrl}/chat/completions`);
    assert.equal(request.options.headers.authorization, `Bearer ${provider}-secret`);
    assert.equal(JSON.parse(request.options.body).model, modelId);
    await assert.rejects(callModel({ model: { provider, modelId, baseUrl } }, [{ role: 'user', text: '你好' }], {}, () => { throw new Error('不应请求网络'); }), /API Key/);
  }
});

test('Agent 可核对企微收发状态，普通询问不会收到机器人聊天正文', () => {
  const input = conversationInput([{ role: 'user', text: '企微收到吗？' }], {
    channelStatus: {
      recentRobotCallback: { at: '2026-09-28T10:05:02.231Z', chatType: 'single' },
      taskDeliveries: [{ text: '测试消息', status: 'sent' }]
    }
  });
  assert.match(input.instructions, /最近收到文本回调/);
  assert.match(input.instructions, /接口已接受，未确认实际送达/);
  assert.match(input.instructions, /不能证明某位成员的某条消息已进入当前工作/);
  assert.match(input.instructions, /不要声称必须引用才能看到原文/);
  assert.deepEqual(input.messages, [{ role: 'user', content: '企微收到吗？' }]);
});

test('明确询问收件正文时不会将末条消息截成 4000 字', () => {
  const original = '测试正文'.repeat(1200);
  const input = conversationInput([{ role: 'user', text: original }], { channelStatus: { inboxSharedForThisRequest: true } });
  assert.equal(input.messages[0].content, original);
  assert.match(input.instructions, /最近的单聊正文已附在本次输入中/);
});

test('企微测试只验证凭据并不返回 access_token', async () => {
  let request;
  const config = { wecom: { organizationId: 'corp-test', applicationId: '100001' }, wecomSecret: 'test-secret' };
  const result = await testConnection('wecom', config, async (url, options) => {
    request = { url, options };
    return json({ errcode: 0, access_token: 'secret-access-token', expires_in: 7200 });
  });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes('secret-access-token'), false);
  assert.equal(new URL(request.url).hostname, 'qyapi.weixin.qq.com');
  assert.equal(request.options.redirect, 'error');
});

test('Agent 创建任务时写入真实响应；认证失败只给出安全错误', async () => {
  const config = { model: { provider: 'openai', modelId: 'test', baseUrl: 'https://api.openai.com/v1' }, modelKey: 'private-key', agent: { mode: 'built-in' } };
  const good = new AgentService(async () => json({ output: [{ content: [{ type: 'output_text', text: '下一步是确认需求' }] }] }));
  const task = await good.createTask({ goal: '制定计划', workspace: '产品团队' }, config);
  assert.equal(task.messages.at(-1).text, '下一步是确认需求');
  const bad = new AgentService(async () => json({}, 401));
  const failed = await bad.createTask({ goal: '制定计划', workspace: '产品团队' }, config);
  assert.match(failed.messages.at(-1).text, /身份验证失败/);
  assert.equal(JSON.stringify(failed).includes('private-key'), false);
});

test('网络错误不会把令牌或服务原始错误返回给界面', async () => {
  const config = { agent: { endpoint: 'https://agent.example/run' }, agentToken: 'private-token' };
  await assert.rejects(
    callExternalAgent(config, [{ role: 'user', text: '测试' }], '产品团队', {}, async () => { throw new Error('private-token leaked in fetch error'); }),
    error => error.message === '连接失败，请检查地址、网络和服务状态'
  );
});
