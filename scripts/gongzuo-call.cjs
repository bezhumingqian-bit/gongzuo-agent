#!/usr/bin/env node
// Call one tool of the 共作 WorkBuddy connector from a shell, e.g. for automation
// or debugging without the WorkBuddy connector UI:
//   node scripts/gongzuo-call.cjs gongzuo_list_pending_work
//   node scripts/gongzuo-call.cjs gongzuo_claim_work '{"taskId":"..."}'
//   node scripts/gongzuo-call.cjs gongzuo_submit_reply --file args.json
// Exit code: 0 success, 1 tool error, 2 usage error.
const fs = require('node:fs');
const { TOOLS, response } = require('../integrations/workbuddy/gongzuo-mcp.cjs');

async function main(argv) {
  const [name, ...rest] = argv;
  if (!name || name === '--help' || name === '-h') {
    process.stdout.write(`用法：gongzuo-call.cjs <工具名> [JSON 参数 | --file 参数文件]\n可用工具：\n${TOOLS.map(tool => `  ${tool.name}  ${tool.description.split('。')[0]}`).join('\n')}\n`);
    return name ? 0 : 2;
  }
  let args = {};
  try {
    if (rest[0] === '--file') args = JSON.parse(fs.readFileSync(rest[1], 'utf8'));
    else if (rest[0]) args = JSON.parse(rest[0]);
  } catch (error) {
    process.stderr.write(`参数不是有效的 JSON：${error.message}\n`);
    return 2;
  }
  const reply = await response({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (reply.error) { process.stderr.write(`${reply.error.message}\n`); return 2; }
  const text = reply.result.content.map(part => part.text).join('\n');
  (reply.result.isError ? process.stderr : process.stdout).write(`${text}\n`);
  return reply.result.isError ? 1 : 0;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; });
