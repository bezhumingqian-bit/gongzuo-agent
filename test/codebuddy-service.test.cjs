const test = require('node:test');
const assert = require('node:assert/strict');
const { callCodeBuddy, readCodeBuddyResult, readCodeBuddyText, testCodeBuddy } = require('../electron/codebuddy-service.cjs');
const { AgentService } = require('../electron/agent-service.cjs');

test('CodeBuddy JSON 只提取最终回答，不返回完整事件或本地信息', () => {
  const output = JSON.stringify([
    { type: 'message', role: 'user', content: [{ text: 'private context' }] },
    { type: 'result', subtype: 'success', is_error: false, result: '连接成功。' }
  ]);
  assert.equal(readCodeBuddyResult(output), '连接成功。');
  assert.throws(() => readCodeBuddyResult('{bad'), /可解析/);
  assert.throws(() => readCodeBuddyResult(JSON.stringify([{ type: 'result', subtype: 'error', is_error: true }])), /未返回文本/);
});

test('CodeBuddy 纯文本输出只返回回答并拒绝空结果', () => {
  assert.equal(readCodeBuddyText('  连接成功。\n'), '连接成功。');
  assert.throws(() => readCodeBuddyText(' \n '), /未返回文本/);
});

test('CodeBuddy 调用使用独立目录并禁用工具、MCP 和会话持久化', async () => {
  let call;
  const response = await callCodeBuddy([{ role: 'user', text: '整理进展' }], '产品团队', {}, {
    executable: '/test/codebuddy',
    execFile: async (file, args, options) => {
      call = { file, args, options };
      return { stdout: '下一步确认范围\n' };
    }
  });
  assert.equal(response, '下一步确认范围');
  assert.equal(call.file, '/test/codebuddy');
  assert.equal(call.args[call.args.indexOf('--output-format') + 1], 'text');
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  assert.equal(call.args[call.args.indexOf('--setting-sources') + 1], 'project');
  assert.ok(call.args.includes('--strict-mcp-config'));
  assert.ok(call.args.includes('--no-session-persistence'));
  assert.match(call.args[1], /整理进展/);
  assert.notEqual(call.options.cwd, process.cwd());
});

test('CodeBuddy 测试只发固定短句；Agent 能接收其结果', async () => {
  let sent;
  const checked = await testCodeBuddy({
    executable: '/test/codebuddy',
    execFile: async (_file, args) => {
      sent = args[1];
      return { stdout: '连接成功。\n' };
    }
  });
  assert.equal(checked.ok, true);
  assert.equal(sent, '请只回复：连接成功。不要调用工具。');
  const agent = new AgentService(undefined, async () => 'CodeBuddy 回答');
  const task = await agent.createTask({ goal: '整理进展', workspace: '产品团队' }, { agent: { mode: 'codebuddy' } });
  assert.equal(task.messages.at(-1).text, 'CodeBuddy 回答');
});
