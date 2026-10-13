const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.join(__dirname, '../scripts/gongzuo-call.cjs');
const run = (...args) => spawnSync(process.execPath, [script, ...args], {
  encoding: 'utf8', env: { ...process.env, GONGZUO_BRIDGE_FILE: '/nonexistent/bridge.json' }
});

test('命令行调用：无参数显示用法，未知工具与坏参数返回 2', () => {
  const usage = run();
  assert.equal(usage.status, 2);
  assert.match(usage.stdout, /gongzuo_claim_work/);
  assert.equal(run('--help').status, 0);
  assert.equal(run('rm_rf').status, 2);
  assert.equal(run('gongzuo_get_work', '{bad').status, 2);
});

test('命令行调用：共作未运行时返回 1 并输出原因；支持 --file 参数', () => {
  const offline = run('gongzuo_connection_test');
  assert.equal(offline.status, 1);
  assert.match(offline.stderr, /没有在运行/);
  const file = path.join(os.tmpdir(), `gz-args-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ taskId: 'abcd-1234' }));
  try {
    const fromFile = run('gongzuo_get_work', '--file', file);
    assert.equal(fromFile.status, 1);
    assert.match(fromFile.stderr, /没有在运行/);
  } finally { fs.rmSync(file, { force: true }); }
});
