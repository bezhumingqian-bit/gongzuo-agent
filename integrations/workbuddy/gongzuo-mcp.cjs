#!/usr/bin/env node
// Minimal, read-only MCP endpoint for checking WorkBuddy -> 共作 connectivity.
// Keep stdout reserved for newline-delimited JSON-RPC messages.
const { version } = require('../../package.json');

const TOOL = {
  name: 'gongzuo_connection_test',
  description: '检查 WorkBuddy 是否能够调用共作本机连接器。仅返回固定连接状态，不读取共作的工作、资料、记忆或凭据。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }
};
const MAX_LINE_BYTES = 1024 * 1024;
const SUPPORTED_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

function response(request) {
  const id = request?.id;
  if (request?.jsonrpc !== '2.0' || !request.method) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (id === undefined) return null; // Notifications do not receive responses.
  let result;
  if (request.method === 'initialize') {
    const requested = request.params?.protocolVersion;
    result = {
      protocolVersion: SUPPORTED_VERSIONS.has(requested) ? requested : '2025-11-25',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'gongzuo-workbuddy-connector', version }
    };
  } else if (request.method === 'ping') {
    result = {};
  } else if (request.method === 'tools/list') {
    result = { tools: [TOOL] };
  } else if (request.method === 'tools/call') {
    if (request.params?.name !== TOOL.name) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool' } };
    }
    result = {
      content: [{ type: 'text', text: `共作本机连接成功（版本 ${version}）。当前连接器只提供连接测试。` }],
      isError: false
    };
  } else {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  }
  return { jsonrpc: '2.0', id, result };
}

function run(input = process.stdin, output = process.stdout) {
  input.setEncoding('utf8');
  let pending = '';
  input.on('data', chunk => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        process.stderr.write('MCP message too large\n');
        process.exitCode = 1;
        input.destroy();
        return;
      }
      let reply;
      try { reply = response(JSON.parse(line)); }
      catch { reply = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
      if (reply) output.write(`${JSON.stringify(reply)}\n`);
    }
    if (Buffer.byteLength(pending, 'utf8') > MAX_LINE_BYTES) {
      process.stderr.write('MCP message too large\n');
      process.exitCode = 1;
      input.destroy();
    }
  });
}

if (require.main === module) run();
module.exports = { TOOL, response, run };
