const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { callLocalAgent, callLocalAgentSession, executableCandidates, findExecutable, parseAgentOutput, testLocalAgent, TEST_PROMPT } = require('../electron/local-agent-service.cjs');

test('Mac 应用启动环境能找到 ChatGPT 内置 Codex CLI', async () => {
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  assert.ok(executableCandidates('codex', '/unused', '/usr/bin:/bin').includes(bundled));
  if (process.platform === 'darwin' && await fs.access(bundled).then(() => true, () => false)) {
    assert.equal(await findExecutable('codex', '/unused', '/usr/bin:/bin'), bundled);
  }
});

test('Codex 和 Kimi 事件只提取最终助手文本', () => {
  assert.equal(parseAgentOutput('codex', [
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', output: 'private' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '完成了。' } })
  ].join('\n')), '完成了。');
  assert.equal(parseAgentOutput('kimi', [
    JSON.stringify({ role: 'user', content: 'private' }),
    JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: '下一步。' }] })
  ].join('\n')), '下一步。');
  assert.throws(() => parseAgentOutput('kimi', '{bad'), /未返回可解析/);
});

test('Codex 在独立目录中以只读沙盒接收标准输入', async () => {
  let call;
  const result = await callLocalAgent('codex', [{ role: 'user', text: '整理进展' }], '产品团队', {}, {
    executable: '/test/codex',
    run: async (file, args, options) => {
      call = { file, args, options };
      return { stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '请确认范围' } }) };
    }
  });
  assert.equal(result, '请确认范围');
  assert.equal(call.file, '/test/codex');
  assert.ok(call.args.includes('--ephemeral'));
  assert.ok(call.args.includes('--ignore-user-config'));
  assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
  assert.match(call.options.input, /整理进展/);
  assert.notEqual(call.options.cwd, process.cwd());
});

test('Kimi 在独立目录中使用无工具 Agent', async () => {
  let call;
  let agentFile;
  const result = await callLocalAgent('kimi', [{ role: 'user', text: '整理进展' }], '产品团队', {}, {
    executable: '/test/kimi',
    run: async (file, args, options) => {
      call = { file, args, options };
      agentFile = await fs.readFile(args[args.indexOf('--agent-file') + 1], 'utf8');
      return { stdout: JSON.stringify({ role: 'assistant', content: '请确认范围' }) };
    }
  });
  assert.equal(result, '请确认范围');
  assert.equal(call.file, '/test/kimi');
  assert.equal(call.args[call.args.indexOf('--output-format') + 1], 'stream-json');
  assert.match(agentFile, /tools: \[\]/);
  assert.match(agentFile, /subagents: \[\]/);
  assert.notEqual(call.options.cwd, process.cwd());
});

test('连接测试只发送固定短句', async () => {
  let prompt;
  const result = await testLocalAgent('codex', {
    executable: '/test/codex',
    run: async (_file, _args, options) => {
      prompt = options.input;
      return { stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '连接成功。' } }) };
    }
  });
  assert.equal(prompt, TEST_PROMPT);
  assert.equal(result.ok, true);
});

test('Codex 续接使用原会话 ID，只发送本轮消息', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-session-test-'));
  const sessionId = '12345678-1234-1234-1234-123456789abc';
  const calls = [];
  try {
    const run = async (_file, args, options) => {
      calls.push({ args, options });
      return { stdout: [JSON.stringify({ type: 'thread.started', thread_id: sessionId }), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '收到' } })].join('\n') };
    };
    const first = await callLocalAgentSession('codex', [{ role: 'user', text: '第一轮' }], '产品团队', {}, { executable: '/test/codex', sessionDir: directory, run });
    assert.equal(first.sessionId, sessionId);
    const second = await callLocalAgentSession('codex', [{ role: 'user', text: '第一轮' }, { role: 'assistant', text: '收到' }, { role: 'user', text: '第二轮' }], '产品团队', {}, { executable: '/test/codex', sessionDir: directory, sessionId, run });
    assert.equal(second.text, '收到');
    assert.deepEqual(calls[1].args.slice(0, 2), ['exec', 'resume']);
    assert.ok(calls[1].args.includes(sessionId));
    assert.match(calls[1].options.input, /第二轮/);
    assert.doesNotMatch(calls[1].options.input, /第一轮/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Kimi 续接同一目录并保留无工具 Agent 的初始绑定', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-kimi-session-test-'));
  const calls = [];
  try {
    const run = async (_file, args, options) => {
      calls.push({ args, options });
      return { stdout: JSON.stringify({ role: 'assistant', content: '收到' }) };
    };
    const first = await callLocalAgentSession('kimi', [{ role: 'user', text: '第一轮' }], '产品团队', {}, { executable: '/test/kimi', sessionDir: directory, run });
    assert.equal(first.sessionId, 'local');
    await callLocalAgentSession('kimi', [{ role: 'user', text: '第一轮' }, { role: 'user', text: '第二轮' }], '产品团队', {}, { executable: '/test/kimi', sessionDir: directory, sessionId: first.sessionId, run });
    assert.ok(calls[0].args.includes('--agent-file'));
    assert.ok(calls[1].args.includes('--continue'));
    assert.ok(!calls[1].args.includes('--agent-file'));
    assert.equal(calls[0].options.cwd, calls[1].options.cwd);
    assert.doesNotMatch(calls[1].args[1], /第一轮/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
