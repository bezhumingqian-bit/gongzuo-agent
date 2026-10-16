const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { retrieveCloudArtifacts } = require('../electron/cloudagent.cjs');

const MB = 1024 * 1024;
const entry = (name, extra = {}) => ({ type: 'FILE_TYPE_FILE', path: `/workspace/artifacts/${name}`, size: '1', modifiedTime: '2026-10-15T08:00:00Z', ...extra });
const runtime = { id: 'R', status: 'RUNNING', links: { acpLink: { token: 'tok' }, sandboxLink: { dataPlaneEndpoint: 'https://files.test' } } };
const client = { getRuntime: async () => runtime, waitReady: async value => value };

function fixture(entries, { download = () => new Response('x'), list = null } = {}) {
  const state = { downloads: [], signals: [] };
  const fetchImpl = (url, init) => {
    const target = new URL(url);
    assert.equal(init.headers['x-access-token'], 'tok');
    assert.equal(init.redirect, 'error');
    state.signals.push(init.signal);
    if (target.pathname === '/filesystem.Filesystem/ListDir') {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['connect-protocol-version'], '1');
      assert.deepEqual(JSON.parse(init.body), { path: '/workspace/artifacts', depth: 1 });
      return list ? list(init) : new Response(JSON.stringify({ entries }));
    }
    assert.equal(target.pathname, '/files', '保持现有 dataPlane 接口契约');
    assert.equal(target.searchParams.get('username'), 'user');
    const remote = target.searchParams.get('path');
    state.downloads.push(remote);
    return download(remote, init, state.downloads.length);
  };
  return { state, run: extra => retrieveCloudArtifacts({}, 'R:S', { client, fetchImpl, timing: { fileMs: 1000 }, ...extra }) };
}

async function clean(result) {
  if (result.directory) await fs.rm(result.directory, { recursive: true, force: true });
}

test('仅允许 artifacts 直属普通文件，拒绝穿越、非规范路径及非法大小', async () => {
  const invalidPaths = [
    '/workspace/artifacts/../../secret.md', '/workspace/artifacts/../secret.md',
    '/workspace/artifacts/sub/../secret.md', '/workspace/artifacts/sub/file.md',
    '/workspace/artifacts//double.md', '//workspace/artifacts/a.md',
    '/workspace/artifacts/./dot.md', '/workspace/artifacts/a.md/',
    '/workspace/artifactsX/a.md', '/workspace/artifacts/a\\b.md',
    '/workspace/artifacts/a\0b.md', 'workspace/artifacts/a.md'
  ];
  const invalidSizes = [-1, '-1', undefined, null, '', ' ', 'no', 0.5, '0.5', Infinity, '9007199254740992'];
  const fake = fixture([
    ...invalidPaths.map(raw => entry('bad.md', { path: raw })),
    ...invalidSizes.map((size, i) => entry(`bad-size-${i}.md`, { size })),
    entry('link.md', { type: 'FILE_TYPE_SYMLINK' }),
    entry('directory.md', { type: 'FILE_TYPE_DIRECTORY' }),
    entry('valid.md'), entry('zero.txt', { size: 0 })
  ]);
  const result = await fake.run();
  try {
    assert.deepEqual(fake.state.downloads, ['/workspace/artifacts/valid.md', '/workspace/artifacts/zero.txt']);
    assert.deepEqual(result.saved.map(file => file.name), ['valid.md', 'zero.txt']);
  } finally { await clean(result); }
});

test('列表 fetch 和列表响应体都不能无限等待', async () => {
  for (const bodyHangs of [false, true]) {
    let signal;
    const fake = fixture([], { list: init => {
      signal = init.signal;
      return bodyHangs ? { ok: true, json: () => new Promise(() => {}) } : new Promise(() => {});
    } });
    await assert.rejects(fake.run({ timing: { fileMs: 20 } }), error => error.timeout && /文件列表超时/.test(error.message));
    assert.equal(signal.aborted, true);
  }
});

test('某文件网络失败或下载 fetch 超时不丢已下载文件，并继续后面的文件', async () => {
  const fake = fixture(['a.md', 'failed.md', 'hang.md', 'b.md'].map(name => entry(name)), {
    download: remote => {
      if (remote.endsWith('/failed.md')) throw new Error('网络中断');
      if (remote.endsWith('/hang.md')) return new Promise(() => {});
      return new Response(remote.endsWith('/a.md') ? 'AAA' : 'BBB');
    }
  });
  const result = await fake.run({ timing: { fileMs: 25 } });
  try {
    assert.deepEqual(result.saved.map(file => file.name), ['a.md', 'b.md']);
    assert.equal(await fs.readFile(result.saved[0].path, 'utf8'), 'AAA');
    assert.equal(await fs.readFile(result.saved[1].path, 'utf8'), 'BBB');
    assert.match(result.skipped.join('、'), /网络中断[\s\S]*下载云端文件超时/);
    assert.equal(fake.state.signals[3].aborted, true);
  } finally { await clean(result); }
});

test('响应体停滞会取消 reader，即使 cancel 本身挂起也有界返回并保留其余文件', async () => {
  let cancelled = 0;
  const fake = fixture(['a.md', 'hang.md', 'b.md'].map(name => entry(name)), {
    download: remote => remote.endsWith('/hang.md') ? new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled += 1; return new Promise(() => {}); }
    })) : new Response('ok')
  });
  const result = await fake.run({ timing: { fileMs: 25 } });
  try {
    assert.equal(cancelled, 1);
    assert.deepEqual(result.saved.map(file => file.name), ['a.md', 'b.md']);
    assert.match(result.skipped[0], /超时/);
  } finally { await clean(result); }
});

test('不信任列表大小：流计数超过 25 MB 立即 cancel，不读取余下流', async () => {
  let pulls = 0;
  let cancelled = 0;
  const chunk = new Uint8Array(MB);
  const fake = fixture([entry('oversize.md'), entry('ok.md')], {
    download: remote => remote.endsWith('/oversize.md') ? new Response(new ReadableStream({
      pull(controller) { pulls += 1; controller.enqueue(chunk); },
      cancel() { cancelled += 1; }
    }, { highWaterMark: 0 })) : new Response('ok')
  });
  const result = await fake.run();
  try {
    assert.equal(pulls, 26);
    assert.equal(cancelled, 1);
    assert.deepEqual(result.saved.map(file => file.name), ['ok.md']);
    assert.match(result.skipped[0], /超过 25 MB/);
  } finally { await clean(result); }
});

test('一次最多尝试 10 文件：失败也计数，不能靠一直失败无限下载', async () => {
  const fake = fixture(Array.from({ length: 12 }, (_, i) => entry(`f${i}.md`)), {
    download: () => new Response('', { status: 500 })
  });
  const result = await fake.run();
  assert.equal(fake.state.downloads.length, 10);
  assert.equal(result.directory, null);
  assert.equal(result.saved.length, 0);
  assert.match(result.skipped.at(-1), /最多尝试取回 10 个/);
});

test('总流量 250 MB 上限包含失败文件已读字节，超限取消且不再 fetch', async () => {
  const cancelled = [];
  const chunk = new Uint8Array(MB);
  const fake = fixture(Array.from({ length: 11 }, (_, i) => entry(`f${i}.md`)), {
    download: (_remote, _init, n) => {
      let count = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (count++ < (n === 1 ? 26 : 25)) controller.enqueue(chunk);
          else controller.close();
        },
        cancel() { cancelled.push(n); }
      }, { highWaterMark: 0 }));
    }
  });
  const result = await fake.run({ timing: { fileMs: 5000 } });
  try {
    assert.equal(fake.state.downloads.length, 10);
    assert.deepEqual(cancelled, [1, 10]);
    assert.equal(result.saved.length, 8);
    assert.ok(result.saved.every(file => file.size === 25 * MB));
    assert.ok(result.saved.reduce((sum, file) => sum + file.size, 0) <= 250 * MB);
    assert.match(result.skipped.join('、'), /250 MB/);
  } finally { await clean(result); }
});

test('私有目录和文件权限、长文件名保留扩展，截断及字符替换后不会碰撞', async () => {
  const long = '超长文件名'.repeat(40);
  const names = [`${long}甲.PPTX`, `${long}乙.PPTX`, 'a:b.md', 'a_b.md'];
  const fake = fixture(names.map(name => entry(name)), { download: remote => new Response(remote) });
  const result = await fake.run();
  try {
    assert.equal((await fs.stat(result.directory)).mode & 0o777, 0o700);
    assert.equal(new Set(result.saved.map(file => file.path)).size, names.length);
    for (const file of result.saved) {
      const name = path.basename(file.path);
      assert.ok(Buffer.byteLength(name) <= 120);
      assert.equal(path.extname(name), path.extname(file.name).toLowerCase());
      assert.equal((await fs.stat(file.path)).mode & 0o777, 0o600);
      assert.equal(await fs.readFile(file.path, 'utf8'), `/workspace/artifacts/${file.name}`);
    }
  } finally { await clean(result); }
});

test('磁盘写入中途失败清理残片，不丢之前文件并继续；全部失败清理私有目录', async () => {
  const writeFile = fs.writeFile;
  const mkdtemp = fs.mkdtemp;
  const directories = [];
  let failAll = false;
  fs.mkdtemp = async (...args) => { const directory = await mkdtemp(...args); directories.push(directory); return directory; };
  fs.writeFile = async (target, bytes, options) => {
    if (failAll || path.basename(target).startsWith('bad-')) {
      await writeFile(target, bytes.subarray(0, 1), options);
      throw new Error('磁盘写入失败');
    }
    return writeFile(target, bytes, options);
  };
  let first;
  try {
    first = await fixture(['a.md', 'bad.md', 'b.md'].map(name => entry(name))).run();
    assert.deepEqual(first.saved.map(file => file.name), ['a.md', 'b.md']);
    assert.equal((await fs.readdir(first.directory)).length, 2);
    assert.match(first.skipped[0], /磁盘写入失败/);
    failAll = true;
    const second = await fixture([entry('bad.md')]).run();
    assert.equal(second.directory, null);
    assert.equal(second.saved.length, 0);
    await assert.rejects(fs.stat(directories.at(-1)), { code: 'ENOENT' });
  } finally {
    fs.writeFile = writeFile;
    fs.mkdtemp = mkdtemp;
    if (first) await clean(first);
    for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
  }
});
