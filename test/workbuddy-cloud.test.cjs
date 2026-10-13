const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const { callWorkBuddyCloud, updateText, buildCloudPrompt } = require('../electron/workbuddy-cloud.cjs');
const { workbuddyTransport } = require('../electron/workbuddy-transport.cjs');
const { AgentService } = require('../electron/agent-service.cjs');

// Fake WorkBuddy Open API + ACP gateway (SSE receive channel + POST JSON-RPC).
async function fakeWorkBuddy({ permission = false, artifact = false, expireFirstSse = false } = {}) {
  const log = { creates: [], gets: 0, prompts: [], posts: [], permissionAnswer: null };
  let sse = null;
  let base;
  let sseCalls = 0;
  const push = message => sse?.write(`data: ${JSON.stringify(message)}\n\n`);
  const server = http.createServer(async (req, res) => {
    const body = await new Promise(resolve => { let raw = ''; req.on('data', c => raw += c).on('end', () => resolve(raw)); });
    const authed = req.headers.authorization;
    if (req.url === '/openapi/v2/tasks' && req.method === 'POST') {
      assert.equal(authed, 'Bearer oauth-token');
      log.creates.push(JSON.parse(body));
      res.end(JSON.stringify({ task_id: 'task-1', status: 'working', name: 'x', link: `${base}/acp`, token: 'ticket-1', expire_at: 0 }));
      return;
    }
    if (req.url === '/openapi/v2/tasks/task-1' && req.method === 'GET') {
      log.gets += 1;
      res.end(JSON.stringify({ code: 0, msg: 'success', data: { task_id: 'task-1', status: 'idle', link: `${base}/acp`, token: 'ticket-2' } }));
      return;
    }
    if (req.url === '/acp' && req.method === 'GET') {
      sseCalls += 1;
      if (expireFirstSse && sseCalls === 1) { res.statusCode = 401; res.end('{}'); return; }
      assert.match(authed, /^Bearer ticket-/);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'acp-connection-id': 'conn-1' });
      res.flushHeaders();
      sse = res;
      return;
    }
    if (req.url === '/acp' && req.method === 'POST') {
      assert.equal(req.headers['acp-connection-id'], 'conn-1');
      const message = JSON.parse(body);
      log.posts.push(message.method || 'response');
      res.statusCode = 202; res.end();
      if (!message.method) { log.permissionAnswer = message.result; return; }
      if (message.method === 'session/prompt') {
        log.prompts.push(message.params.prompt[0].text);
        setTimeout(() => {
          push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'task-1', update: { sessionUpdate: 'tool_call', title: '检索资料' } } });
          push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'task-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '本周完成' } } } });
          push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'task-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' 3 项。' } } } });
          if (permission) push({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: { requestId: 'r-1', type: 'tool_permission', toolCall: { title: '发送邮件' } } });
          if (artifact) push({ jsonrpc: '2.0', method: '_codebuddy.ai/artifact', params: { sessionId: 'task-1', event: 'created', artifact: { type: 'media', uri: 'agent:///artifacts/周报.md', name: '周报.md', mimeType: 'text/markdown' } } });
          setTimeout(() => push({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } }), 30);
        }, 10);
        return;
      }
      setTimeout(() => push({ jsonrpc: '2.0', id: message.id, result: {} }), 5);
      return;
    }
    if (req.url === '/artifacts/%E5%91%A8%E6%8A%A5.md' && req.method === 'GET') {
      assert.match(authed, /^Bearer ticket-/);
      res.end('# 周报\n完成 3 项');
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise(resolve => { sse?.end(); server.closeAllConnections?.(); server.close(resolve); });
  return { base, log, close, config: { workbuddyAccessToken: 'oauth-token', workbuddyApiBase: `${base}/openapi/v2`, agent: { mode: 'workbuddy', workbuddyTransport: 'cloud' } } };
}

test('云端任务：首轮新建任务并经 ACP 流式拿到回复与进度；续接时复用任务并刷新凭据', async () => {
  const fake = await fakeWorkBuddy();
  try {
    const progress = [];
    const messages = [{ role: 'user', text: '整理本周进展' }];
    const first = await callWorkBuddyCloud(fake.config, messages, '产品团队', {}, { title: '本周进展', onProgress: item => progress.push(item) });
    assert.equal(first.text, '本周完成 3 项。');
    assert.equal(first.sessionId, 'task-1');
    assert.equal(fake.log.creates[0].prompt, '整理本周进展');
    assert.deepEqual(fake.log.posts, ['initialize', 'session/load', 'session/prompt']);
    assert.match(fake.log.prompts[0], /企业团队的工作 Agent[\s\S]*当前工作空间：产品团队[\s\S]*用户：整理本周进展/);
    assert.ok(progress.some(item => item.step === '检索资料'));

    const second = await callWorkBuddyCloud(fake.config, [...messages, { role: 'assistant', text: first.text }, { role: 'user', text: '再列风险' }], '产品团队', {}, { sessionId: 'task-1' });
    assert.equal(second.sessionId, 'task-1');
    assert.equal(fake.log.creates.length, 1, '续接不新建任务');
    assert.equal(fake.log.gets, 1);
    assert.equal(fake.log.prompts[1], '用户：再列风险', '续接只发最新一条');
  } finally { await fake.close(); }
});

test('云端任务：需授权的工具调用被拒绝并在回复中说明；媒体产物下载为文件', async () => {
  const fake = await fakeWorkBuddy({ permission: true, artifact: true });
  try {
    const result = await callWorkBuddyCloud(fake.config, [{ role: 'user', text: '写周报并发邮件' }], '产品团队', {}, {});
    assert.deepEqual(fake.log.permissionAnswer, { outcome: { outcome: 'cancelled' } });
    assert.match(result.text, /已拒绝：发送邮件/);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].name, '周报.md');
    assert.equal(await fs.readFile(result.files[0].path, 'utf8'), '# 周报\n完成 3 项');
    await fs.rm(result.filesDirectory, { recursive: true, force: true });
  } finally { await fake.close(); }
});

test('云端任务：ACP 凭据过期时重新获取一次', async () => {
  const fake = await fakeWorkBuddy({ expireFirstSse: true });
  try {
    const result = await callWorkBuddyCloud(fake.config, [{ role: 'user', text: '测试' }], '产品团队', {}, {});
    assert.equal(result.text, '本周完成 3 项。');
    assert.equal(fake.log.gets, 1);
  } finally { await fake.close(); }
});

test('连接方式：显式选择优先；旧设置有令牌视为本地助理；云端缺令牌不可执行', () => {
  assert.equal(workbuddyTransport({}, false), 'handoff');
  assert.equal(workbuddyTransport({}, true), 'localassistant');
  assert.equal(workbuddyTransport({ workbuddyTransport: 'cloud' }, true), 'cloud');
  assert.equal(workbuddyTransport({ workbuddyTransport: 'handoff' }, true), 'handoff');
  const agent = new AgentService();
  assert.equal(agent.isConfigured({ agent: { mode: 'workbuddy', workbuddyTransport: 'cloud' } }), false);
  assert.equal(agent.isConfigured({ agent: { mode: 'workbuddy', workbuddyTransport: 'cloud' }, workbuddyAccessToken: 't' }), true);
  assert.equal(agent.getStatus({ agent: { mode: 'workbuddy', workbuddyTransport: 'cloud' }, hasWorkbuddyAccessToken: false }).label, 'WorkBuddy 待授权');
  assert.equal(updateText({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } } }).text, 'a');
  assert.equal(updateText({ delta: { text: 'b' } }).text, 'b');
  assert.equal(buildCloudPrompt([{ role: 'user', text: 'x' }, { role: 'user', text: 'y' }], 'S', {}, true), '用户：y');
});
