const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { response, TOOLS, bridgeCandidates } = require('../integrations/workbuddy/gongzuo-mcp.cjs');

const TOOL_NAMES = ['gongzuo_connection_test', 'gongzuo_list_pending_work', 'gongzuo_claim_work', 'gongzuo_submit_reply', 'gongzuo_list_works', 'gongzuo_get_work', 'gongzuo_create_work'];

test('WorkBuddy MCP 暴露共作工作工具；只读工具带只读标注', async () => {
  const list = await response({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map(tool => tool.name), TOOL_NAMES);
  const readOnly = TOOLS.filter(tool => tool.annotations?.readOnlyHint).map(tool => tool.name);
  assert.deepEqual(readOnly, ['gongzuo_connection_test', 'gongzuo_list_pending_work', 'gongzuo_list_works', 'gongzuo_get_work']);
  for (const tool of TOOLS) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(await response({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const unknown = await response({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rm_rf', arguments: {} } });
  assert.equal(unknown.error.code, -32602);
});

test('共作未运行时工具返回明确错误而不是崩溃', async () => {
  const fake = async () => { throw new Error('共作没有在运行'); };
  const called = await response({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gongzuo_connection_test', arguments: {} } }, fake);
  assert.equal(called.result.isError, true);
  assert.match(called.result.content[0].text, /没有在运行/);
});

test('桥接文件可由环境变量指定，默认同时查找正式版与开发版数据目录', () => {
  assert.deepEqual(bridgeCandidates({ GONGZUO_BRIDGE_FILE: '/tmp/x.json' }), ['/tmp/x.json']);
  const defaults = bridgeCandidates({}, '/Users/test');
  assert.ok(defaults.some(item => item.includes('gongzuo-agent/workbuddy-bridge.json')));
  assert.ok(defaults.some(item => item.includes('gongzuo-agent-dev/workbuddy-bridge.json')));
});

test('本机 stdio 子进程完成 MCP 握手、工具发现，并按到达顺序回复', async () => {
  const script = path.join(__dirname, '../integrations/workbuddy/gongzuo-mcp.cjs');
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GONGZUO_BRIDGE_FILE: '/nonexistent/bridge.json' } });
  const frames = [];
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });
  for (const message of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gongzuo_connection_test', arguments: {} } }
  ]) child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.end();
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`MCP exited ${code}`)));
  });
  assert.equal(frames.length, 3);
  assert.equal(buffered, '');
  assert.deepEqual(frames.map(frame => frame.id), [1, 2, 3]);
  assert.equal(frames[0].result.protocolVersion, '2025-11-25');
  assert.deepEqual(frames[1].result.tools.map(tool => tool.name), TOOL_NAMES);
  assert.equal(frames[2].result.isError, true);
  assert.match(frames[2].result.content[0].text, /没有在运行/);
});
