const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { conversationInput } = require('./connection-service.cjs');

const TEST_PROMPT = '请只回复：连接成功。不要调用工具。';
const MAX_OUTPUT = 2 * 1024 * 1024;

function executableCandidates(kind, home = os.homedir(), searchPath = process.env.PATH || '') {
  const name = kind === 'codex' ? 'codex' : kind === 'kimi' ? 'kimi' : null;
  if (!name) throw new Error('未知的本机 Agent');
  const candidates = searchPath.split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name));
  if (kind === 'codex') candidates.push(
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex'
  );
  else candidates.push(path.join(home, '.kimi-code/bin/kimi'));
  candidates.push(`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`);
  return [...new Set(candidates)];
}

async function findExecutable(kind, home = os.homedir(), searchPath = process.env.PATH || '') {
  const candidates = executableCandidates(kind, home, searchPath);
  for (const candidate of candidates) {
    try { await fs.access(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
  }
  throw new Error(`未找到 ${kind === 'codex' ? 'Codex' : 'Kimi Code'} CLI；请先安装并登录`);
}

function collectText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('\n');
  return typeof content?.text === 'string' ? content.text : '';
}

function parseAgentOutput(kind, stdout) {
  const events = String(stdout).split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  if (kind === 'codex') {
    const completed = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message');
    const answer = completed.map(event => collectText(event.item.text || event.item.content)).filter(Boolean).at(-1);
    if (answer) return answer.trim().slice(0, 50000);
  } else if (kind === 'kimi') {
    const assistant = events.filter(event => event.role === 'assistant' || event.message?.role === 'assistant' || event.type === 'assistant');
    const answer = assistant.map(event => collectText(event.message?.content ?? event.content ?? event.text)).filter(Boolean).at(-1);
    if (answer) return answer.trim().slice(0, 50000);
  }
  throw new Error(`${kind === 'codex' ? 'Codex' : 'Kimi Code'} 未返回可解析的文本结果`);
}

function readCodexSessionId(stdout) {
  for (const line of String(stdout).split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'thread.started' && typeof event.thread_id === 'string' && /^[0-9a-f-]{36}$/i.test(event.thread_id)) return event.thread_id;
    } catch { /* ignore non-JSON diagnostics */ }
  }
  return null;
}

function runProcess(executable, args, { cwd, input, timeout = 120000, env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(new Error('响应超时')); }, timeout);
    child.on('error', done);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT) { child.kill('SIGKILL'); done(new Error('输出超过限制')); }
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('close', code => code === 0 ? done(null, { stdout }) : done(new Error(`进程退出（${code}）`)));
    child.stdin.end(input || '');
  });
}

function buildPrompt(messages, workspace, memoryContext, resume = false) {
  const input = conversationInput(messages, memoryContext);
  return [input.instructions, `当前工作空间：${String(workspace || '').slice(0, 120)}`,
    ...(resume ? input.messages.slice(-1) : input.messages).map(item => `${item.role === 'assistant' ? '助手' : '用户'}：${item.content}`),
    '只根据上面的对话回答；不要读取本机文件、调用工具或修改内容。'].join('\n\n');
}

async function runLocalAgent(kind, messages, workspace, memoryContext = {}, options = {}) {
  if (!['codex', 'kimi'].includes(kind)) throw new Error('未知的本机 Agent');
  const executable = options.executable || await findExecutable(kind);
  const persistent = Boolean(options.sessionDir);
  const directory = persistent ? options.sessionDir : await fs.mkdtemp(path.join(os.tmpdir(), `gongzuo-${kind}-`));
  const resume = persistent && Boolean(options.sessionId);
  const prompt = options.testPrompt || buildPrompt(messages, workspace, memoryContext, resume);
  try {
    if (persistent) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let args;
    let input = '';
    if (kind === 'codex') {
      if (resume) {
        if (!/^[0-9a-f-]{36}$/i.test(options.sessionId)) throw new Error('Codex 会话 ID 无效');
        args = ['exec', 'resume', '--json', '--ignore-user-config', '--skip-git-repo-check',
          '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', options.sessionId, '-'];
      } else {
        args = ['exec', '--json', '--ignore-user-config', '--sandbox', 'read-only',
          '--skip-git-repo-check', '-c', 'approval_policy="never"', '-C', directory, '-'];
        if (!persistent) args.splice(2, 0, '--ephemeral');
      }
      input = prompt;
    } else {
      const agentFile = path.join(directory, 'gongzuo-agent.md');
      const skillsDir = path.join(directory, 'skills');
      await fs.mkdir(skillsDir, { recursive: true });
      if (!resume) await fs.writeFile(agentFile, '---\nname: gongzuo-text\ndescription: Answer the supplied work request as text\ntools: []\nsubagents: []\n---\nAnswer only the supplied text. Do not read files, use tools, or delegate.\n', { mode: 0o600 });
      args = ['-p', prompt, '--output-format', 'stream-json', '--skills-dir', skillsDir];
      if (resume) args.push('--continue');
      else args.push('--agent-file', agentFile);
    }
    const { stdout } = await (options.run || runProcess)(executable, args, { cwd: directory, input, timeout: 120000, env: process.env });
    const text = parseAgentOutput(kind, stdout);
    const sessionId = persistent ? kind === 'codex' ? (readCodexSessionId(stdout) || options.sessionId) : 'local' : null;
    if (persistent && !sessionId) throw new Error('Codex 没有返回可续接的会话 ID');
    return { text, sessionId };
  } catch (error) {
    if (error.message?.includes('未返回可解析')) throw error;
    throw new Error(`${kind === 'codex' ? 'Codex' : 'Kimi Code'} 调用失败：${error.message?.slice(0, 150) || '未知错误'}；请检查登录状态`);
  } finally {
    if (!persistent) await fs.rm(directory, { recursive: true, force: true });
  }
}

async function callLocalAgent(kind, messages, workspace, memoryContext = {}, options = {}) {
  return (await runLocalAgent(kind, messages, workspace, memoryContext, options)).text;
}

async function callLocalAgentSession(kind, messages, workspace, memoryContext = {}, options = {}) {
  if (!options.sessionDir) throw new Error('缺少 Agent 会话目录');
  return runLocalAgent(kind, messages, workspace, memoryContext, options);
}

async function testLocalAgent(kind, options = {}) {
  await callLocalAgent(kind, [{ role: 'user', text: TEST_PROMPT }], '连接测试', {}, { ...options, testPrompt: TEST_PROMPT });
  return { ok: true, message: `${kind === 'codex' ? 'Codex' : 'Kimi Code'} 已返回文本；当前只支持文本委派` };
}

module.exports = { executableCandidates, findExecutable, parseAgentOutput, readCodexSessionId, callLocalAgent, callLocalAgentSession, testLocalAgent, TEST_PROMPT };
