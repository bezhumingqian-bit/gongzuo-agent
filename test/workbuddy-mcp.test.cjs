const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { response } = require('../integrations/workbuddy/gongzuo-mcp.cjs');

test('WorkBuddy MCP 只暴露无数据连接测试工具', () => {
  const list = response({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map(tool => tool.name), ['gongzuo_connection_test']);
  const called = response({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gongzuo_connection_test', arguments: {} } });
  assert.match(called.result.content[0].text, /连接成功/);
  assert.equal(response({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('本机 stdio 子进程完成 MCP 握手、工具发现和调用', async () => {
  const script = path.join(__dirname, '../integrations/workbuddy/gongzuo-mcp.cjs');
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  assert.equal(frames[0].result.protocolVersion, '2025-11-25');
  assert.deepEqual(frames[1].result.tools.map(tool => tool.name), ['gongzuo_connection_test']);
  assert.match(frames[2].result.content[0].text, /连接成功/);
});
