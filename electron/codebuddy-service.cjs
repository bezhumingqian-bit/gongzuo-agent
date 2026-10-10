const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { conversationInput } = require('./connection-service.cjs');

const execFileAsync = promisify(execFile);
const TEST_PROMPT = '请只回复：连接成功。不要调用工具。';

async function findCodeBuddy(home = os.homedir(), searchPath = process.env.PATH || '') {
  const candidates = searchPath.split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'codebuddy'));
  candidates.push('/opt/homebrew/bin/codebuddy', '/usr/local/bin/codebuddy');
  try {
    const versions = await fs.readdir(path.join(home, '.nvm/versions/node'));
    for (const version of versions.reverse()) candidates.push(path.join(home, '.nvm/versions/node', version, 'bin/codebuddy'));
  } catch { /* nvm is optional */ }
  for (const candidate of candidates) {
    try { await fs.access(candidate, fs.constants.X_OK); return candidate; } catch { /* try next location */ }
  }
  throw new Error('未找到 CodeBuddy CLI；请先安装 CodeBuddy Code 并在终端完成登录');
}

function readCodeBuddyResult(stdout) {
  let events;
  try { events = JSON.parse(stdout); } catch { throw new Error('CodeBuddy 没有返回可解析的结果'); }
  const result = (Array.isArray(events) ? events : [events]).findLast(item => item?.type === 'result');
  if (!result || result.is_error || result.subtype !== 'success' || typeof result.result !== 'string' || !result.result.trim()) {
    throw new Error('CodeBuddy 未返回文本结果；请检查登录状态或额度');
  }
  return result.result.trim().slice(0, 50000);
}

function readCodeBuddyText(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('CodeBuddy 未返回文本结果；请检查登录状态或额度');
  return text.slice(0, 50000);
}

async function callCodeBuddy(messages, workspace, memoryContext = {}, options = {}) {
  const executable = options.executable || await findCodeBuddy();
  const input = conversationInput(messages, memoryContext);
  const prompt = options.testPrompt || [
    input.instructions,
    `当前工作空间：${String(workspace || '').slice(0, 120)}`,
    ...input.messages.map(item => `${item.role === 'assistant' ? '助手' : '用户'}：${item.content}`)
  ].join('\n\n');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-codebuddy-'));
  try {
    const args = [
      '-p', prompt, '--output-format', 'text', '--tools', '',
      '--permission-mode', 'dontAsk', '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'project',
      '--no-session-persistence', '--max-turns', '1'
    ];
    const { stdout } = await (options.execFile || execFileAsync)(executable, args, {
      cwd: directory,
      timeout: 90000,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env
    });
    return readCodeBuddyText(stdout);
  } catch (error) {
    if (error.message?.startsWith('CodeBuddy ')) throw error;
    if (error.killed || error.code === 'ETIMEDOUT') throw new Error('CodeBuddy 响应超时');
    throw new Error('CodeBuddy 调用失败；请确认 CLI 已登录并可在终端使用');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function testCodeBuddy(options = {}) {
  await callCodeBuddy([{ role: 'user', text: TEST_PROMPT }], '连接测试', {}, { ...options, testPrompt: TEST_PROMPT });
  return { ok: true, message: 'CodeBuddy 已返回内容；当前只支持文本委派，工具执行仍未开放' };
}

module.exports = { findCodeBuddy, readCodeBuddyResult, readCodeBuddyText, callCodeBuddy, testCodeBuddy };
