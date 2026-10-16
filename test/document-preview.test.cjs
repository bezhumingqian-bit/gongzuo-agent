const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { DocumentService, allowedExtensions } = require('../electron/document-service.cjs');
const { WorkOperations } = require('../electron/contracts/work-operations.cjs');
const { actors } = require('../electron/contracts/policy.cjs');

const KB = 1024;
const MB = 1024 * KB;
const electronDirectory = path.join(__dirname, '..', 'electron');
const binaryFormats = [
  ['png', 'image/png', Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex')],
  ['jpg', 'image/jpeg', Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')],
  ['jpeg', 'image/jpeg', Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')],
  ['gif', 'image/gif', Buffer.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b', 'hex')],
  ['webp', 'image/webp', Buffer.from('5249464616000000574542505650384c090000002f00000000078888fe0700', 'hex')],
  ['pdf', 'application/pdf', Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')]
];

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-preview-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sources = path.join(directory, 'sources');
  const files = path.join(directory, 'files');
  await Promise.all([fs.mkdir(sources), fs.mkdir(files)]);
  const service = new DocumentService(path.join(directory, 'index.json'), files);
  await service.initialize();
  const add = async (name, content, workspaceId = 'primary') => {
    const source = path.join(sources, name);
    await fs.writeFile(source, content);
    return (await service.upload(workspaceId, [source]))[0];
  };
  const patch = (id, input) => service.index.update(data => {
    Object.assign(data.items.find(item => item.id === id), input);
    return data;
  });
  return { directory, files, service, add, patch };
}

function assertSafeResult(result, directory) {
  const fields = new Set(['id', 'name', 'kind', 'text', 'dataUrl', 'mime', 'truncated', 'reason']);
  assert.ok(Object.keys(result).every(key => fields.has(key)));
  assert.equal(typeof result.id, 'string');
  assert.equal(typeof result.name, 'string');
  assert.equal(typeof result.mime, 'string');
  assert.equal(typeof result.truncated, 'boolean');
  assert.equal(JSON.stringify(result).includes(directory), false);
}

function assertUnsupported(result, directory, reason) {
  assertSafeResult(result, directory);
  assert.equal(result.kind, 'unsupported');
  assert.equal(result.truncated, false);
  assert.equal(result.text, undefined);
  assert.equal(result.dataUrl, undefined);
  assert.match(result.reason, reason);
}

async function assertSafeRejection(promise, directory, pattern) {
  await assert.rejects(promise, error => {
    assert.match(error.message, pattern);
    assert.equal(error.message.includes(directory), false);
    return true;
  });
}

test('云端临时文件带序号，展示名保留 Agent 原文件名，且不能更换格式', async t => {
  const ctx = await fixture(t);
  const source = path.join(ctx.directory, 'report-1.md');
  await fs.writeFile(source, '正文');
  const file = (await ctx.service.upload('primary', [source], { names: ['项目交接.md'] }))[0];
  assert.equal(file.name, '项目交接.md');
  assert.equal((await ctx.service.preview(file.id, ['primary'])).text, '正文');
  await assert.rejects(ctx.service.upload('primary', [source], { names: ['伪装.html'] }), /格式不一致/);
});

test('文本预览保留 UTF-8 内容，仅返回公开预览字段', async t => {
  const ctx = await fixture(t);
  for (const [extension, mime] of [['txt', 'text/plain'], ['md', 'text/markdown'], ['csv', 'text/csv']]) {
    await t.test(extension, async () => {
      const text = ' 中文资料\n第二行,数据\n';
      const document = await ctx.add(`资料.${extension}`, text);
      const result = await ctx.service.preview(document.id, ['primary']);
      assert.deepEqual(result, { id: document.id, name: document.name, kind: 'text', mime, truncated: false, reason: null, text });
      assertSafeResult(result, ctx.directory);
    });
  }
  const empty = await ctx.add('空文件.txt', '');
  assert.equal((await ctx.service.preview(empty.id, ['primary'])).text, '');
});

test('txt/md/csv 的 400 KB 边界与超限截断不读取边界外字节', async t => {
  const ctx = await fixture(t);
  const open = fs.open;
  let highestReadEnd = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    handle.read = (buffer, offset, length, position) => {
      highestReadEnd = Math.max(highestReadEnd, position + length);
      return read(buffer, offset, length, position);
    };
    return handle;
  });
  for (const extension of ['txt', 'md', 'csv']) {
    for (const size of [400 * KB, 400 * KB + 1]) {
      await t.test(`${extension} ${size} 字节`, async () => {
        const document = await ctx.add(`边界.${extension}`, Buffer.alloc(size, 0x61));
        highestReadEnd = 0;
        const result = await ctx.service.preview(document.id, ['primary']);
        assert.equal(result.text, 'a'.repeat(400 * KB));
        assert.equal(result.truncated, size > 400 * KB);
        assert.equal(result.reason, size > 400 * KB ? '仅预览前 400 KB 文本' : null);
        assert.ok(highestReadEnd <= 400 * KB);
        assertSafeResult(result, ctx.directory);
      });
    }
  }
  const split = await ctx.add('字符边界.txt', Buffer.concat([Buffer.alloc(400 * KB - 1, 0x61), Buffer.from('中尾') ]));
  const result = await ctx.service.preview(split.id, ['primary']);
  assert.equal(result.text, 'a'.repeat(400 * KB - 1));
  assert.equal(result.truncated, true);
  assert.equal(result.text.includes('\ufffd'), false);
});

test('HTML/HTM 返回源码文本，2 MB 可预览，超限不返回内容', async t => {
  const ctx = await fixture(t);
  for (const extension of ['html', 'htm']) {
    await t.test(extension, async () => {
      const text = '<!doctype html><script>globalThis.executed = true</script><h1>源码</h1>';
      const document = await ctx.add(`页面.${extension}`, text);
      const result = await ctx.service.preview(document.id, ['primary']);
      assert.equal(result.kind, 'html');
      assert.equal(result.mime, 'text/html');
      assert.equal(result.text, text);
      assert.equal(result.dataUrl, undefined);
      assert.equal(result.truncated, false);
      assert.equal(result.reason, null);
      assertSafeResult(result, ctx.directory);
      const file = await ctx.service.getFilePath(document.id);
      await fs.truncate(file, 2 * MB);
      assert.equal(Buffer.byteLength((await ctx.service.preview(document.id, ['primary'])).text), 2 * MB);
      await fs.truncate(file, 2 * MB + 1);
      assertUnsupported(await ctx.service.preview(document.id, ['primary']), ctx.directory, /2 MB/);
    });
  }
});

test('图片与 PDF 验证 magic 后返回可逆的 base64 data URL', async t => {
  const ctx = await fixture(t);
  for (const [extension, mime, content] of binaryFormats) {
    await t.test(extension, async () => {
      const document = await ctx.add(`成果.${extension.toUpperCase()}`, content);
      const result = await ctx.service.preview(document.id, ['primary']);
      assert.equal(result.kind, extension === 'pdf' ? 'pdf' : 'image');
      assert.equal(result.mime, mime);
      assert.equal(result.dataUrl, `data:${mime};base64,${content.toString('base64')}`);
      assert.deepEqual(Buffer.from(result.dataUrl.split(',')[1], 'base64'), content);
      assert.equal(result.text, undefined);
      assert.equal(result.truncated, false);
      assert.equal(result.reason, null);
      assertSafeResult(result, ctx.directory);
    });
  }
  const oldGif = await ctx.add('旧版.gif', Buffer.from('GIF87a\x01\x00\x01\x00'));
  assert.equal((await ctx.service.preview(oldGif.id, ['primary'])).kind, 'image');
});

test('图片 10 MB 与 PDF 25 MB 允许等于上限，实际文件超限返回 unsupported', async t => {
  const ctx = await fixture(t);
  for (const [extension, , content] of binaryFormats) {
    await t.test(extension, async () => {
      const document = await ctx.add(`大文件.${extension}`, content);
      const limit = (extension === 'pdf' ? 25 : 10) * MB;
      const file = await ctx.service.getFilePath(document.id);
      await fs.truncate(file, limit);
      const result = await ctx.service.preview(document.id, ['primary']);
      assert.equal(result.kind, extension === 'pdf' ? 'pdf' : 'image');
      assert.equal(Buffer.from(result.dataUrl.split(',')[1], 'base64').length, limit);
      await fs.truncate(file, limit + 1);
      assertUnsupported(await ctx.service.preview(document.id, ['primary']), ctx.directory, /预览上限/);
      assert.equal((await ctx.service.list()).find(item => item.id === document.id).size, content.length);
    });
  }
});

test('拒绝空内容、伪造或不完整 magic，Office 与未知格式返回 unsupported', async t => {
  const ctx = await fixture(t);
  for (const [extension, , signature] of binaryFormats) {
    for (const [label, content] of [['空文件', Buffer.alloc(0)], ['伪造', Buffer.from('<html>不是所声明的文件</html>')], ['短头', signature.subarray(0, 2)]]) {
      await t.test(`${extension} ${label}`, async () => {
        const document = await ctx.add(`${label}.${extension}`, content);
        assertUnsupported(await ctx.service.preview(document.id, ['primary']), ctx.directory, /内容与声明格式不符/);
      });
    }
  }
  const highBitGif = await ctx.add('错误字节.gif', Buffer.from([0x47, 0xc9, 0x46, 0x38, 0x39, 0x61]));
  assertUnsupported(await ctx.service.preview(highBitGif.id, ['primary']), ctx.directory, /内容与声明格式不符/);
  const wrongWebp = await ctx.add('错误容器.webp', Buffer.from('RIFF\x00\x00\x00\x00WAVE'));
  assertUnsupported(await ctx.service.preview(wrongWebp.id, ['primary']), ctx.directory, /内容与声明格式不符/);
  for (const extension of ['doc', 'docx', 'xls', 'xlsx', 'ppt']) {
    const document = await ctx.add(`Office.${extension}`, '不应调用外部转换器');
    assertUnsupported(await ctx.service.preview(document.id, ['primary']), ctx.directory, /暂不支持/);
  }
  const unknown = await ctx.add('未知.txt', '内容');
  await ctx.patch(unknown.id, { name: '未知.xyz' });
  assertUnsupported(await ctx.service.preview(unknown.id, ['primary']), ctx.directory, /暂不支持/);
});

test('按 active、精确 ID 与允许空间检查，归档和未知资料不可预览', async t => {
  const ctx = await fixture(t);
  const document = await ctx.add('空间.txt', '内容', 'related');
  await assertSafeRejection(ctx.service.preview(document.id, ['primary']), ctx.directory, /不存在或不属于/);
  await assertSafeRejection(ctx.service.preview(document.id), ctx.directory, /不存在或不属于/);
  await assertSafeRejection(ctx.service.preview(document.id.slice(0, 8), ['related']), ctx.directory, /不存在或不属于/);
  await assertSafeRejection(ctx.service.preview('不存在', ['related']), ctx.directory, /不存在或不属于/);
  assert.equal((await ctx.service.preview(document.id, ['primary', 'related'])).text, '内容');
  await ctx.service.setArchived(document.id, true);
  await assertSafeRejection(ctx.service.preview(document.id, ['related']), ctx.directory, /不存在或不属于/);
  await ctx.service.setArchived(document.id, false);
  assert.equal((await ctx.service.preview(document.id, ['related'])).text, '内容');
});

test('storedName 拒绝路径逃逸、绝对路径、分隔符、空值和 NUL', async t => {
  const ctx = await fixture(t);
  const document = await ctx.add('安全.txt', '内容');
  const outside = path.join(ctx.directory, 'outside.txt');
  await fs.writeFile(outside, '临时边界外测试内容');
  for (const storedName of ['../outside.txt', 'sub/../../outside.txt', '..\\outside.txt', 'sub\\file.txt', outside, 'C:\\outside.txt', '.', '..', '', null, 123, 'file\0.txt']) {
    await ctx.patch(document.id, { storedName });
    await assertSafeRejection(ctx.service.preview(document.id, ['primary']), ctx.directory, /文件路径无效/);
  }
});

test('真实路径不得逃出 filesDirectory，错误与文件名称不泄露本地路径', async t => {
  const ctx = await fixture(t);
  const document = await ctx.add('安全.txt', '内容');
  const file = await ctx.service.getFilePath(document.id);
  await ctx.patch(document.id, { name: path.join(ctx.directory, '安全.txt') });
  assert.equal((await ctx.service.preview(document.id, ['primary'])).name, '安全.txt');
  const realpath = fs.realpath;
  const canonicalFile = await realpath(file);
  t.mock.method(fs, 'realpath', target => path.resolve(target) === canonicalFile
    ? Promise.resolve(path.join(ctx.directory, 'files-escape', 'outside.txt')) : realpath(target));
  await assertSafeRejection(ctx.service.preview(document.id, ['primary']), ctx.directory, /不可安全读取/);
});

test('禁止 filesDirectory、文件自身及读取竞争中的 symlink', async t => {
  for (const mode of ['外部目标', '内部目标', '断链', '资料目录', '读取竞争']) {
    await t.test(mode, async sub => {
      const ctx = await fixture(sub);
      const document = await ctx.add('链接.txt', '原内容');
      const file = await ctx.service.getFilePath(document.id);
      const outside = path.join(ctx.directory, 'outside.txt');
      await fs.writeFile(outside, '临时边界外测试内容');
      if (mode === '资料目录') {
        const alias = path.join(ctx.directory, 'alias');
        await fs.symlink(ctx.files, alias, 'dir');
        ctx.service.filesDirectory = alias;
      } else if (mode === '读取竞争') {
        const open = fs.open;
        sub.mock.method(fs, 'open', async (target, flags) => {
          assert.ok(flags & fs.constants.O_NOFOLLOW);
          await fs.unlink(file);
          await fs.symlink(outside, file);
          return open(target, flags);
        });
      } else {
        const target = mode === '内部目标' ? path.join(ctx.files, '内部.txt') : mode === '断链' ? path.join(ctx.directory, '不存在.txt') : outside;
        if (mode === '内部目标') await fs.writeFile(target, '内部内容');
        await fs.unlink(file);
        await fs.symlink(target, file);
      }
      await assertSafeRejection(ctx.service.preview(document.id, ['primary']), ctx.directory, /不可安全读取/);
    });
  }
});

test('缺失文件、非普通文件与索引读取错误均不暴露文件系统路径', async t => {
  const ctx = await fixture(t);
  const document = await ctx.add('缺失.txt', '内容');
  const file = await ctx.service.getFilePath(document.id);
  await fs.unlink(file);
  await assertSafeRejection(ctx.service.preview(document.id, ['primary']), ctx.directory, /不可安全读取/);
  await fs.mkdir(file);
  await assertSafeRejection(ctx.service.preview(document.id, ['primary']), ctx.directory, /不可安全读取/);
  t.mock.method(ctx.service.index, 'read', async () => { throw new Error(`ENOENT: ${ctx.directory}/index.json`); });
  await assertSafeRejection(ctx.service.preview(document.id, ['primary']), ctx.directory, /索引读取失败/);
});

async function ipcHarness(ctx, data) {
  const handlers = new Map();
  const mainFrame = { url: pathToFileURL(path.join(electronDirectory, '..', 'demo', 'index.html')).href };
  const webContents = { mainFrame };
  const workspaceStore = { read: async () => data };
  let dialogOptions;
  const electron = {
    app: { on() {}, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: async (_window, options) => { dialogOptions = options; return { canceled: true, filePaths: [] }; } }
  };
  // 禁用 Electron 启动，其他业务服务使用空桩；不读取真实 userData、凭据或密钥。
  const context = vm.createContext({
    __dirname: electronDirectory,
    process: { platform: process.platform },
    windowFixture: { webContents },
    storeFixture: workspaceStore,
    documentFixture: ctx.service,
    opsFixture: new WorkOperations({ store: workspaceStore }),
    require: id => {
      if (id === 'electron') return electron;
      if (id.startsWith('node:')) return require(id);
      if (id === './runtime-channel.cjs') return { configureRuntimeChannel: () => ({}), linkScheme: () => 'gongzuo-test' };
      if (id === './agent-service.cjs') return { AgentService: class {} };
      if (id === './connection-status.cjs') return { ConnectionStatusService: class {} };
      if (id === './contracts/policy.cjs') return { actors };
      return {};
    }
  });
  vm.runInContext(await fs.readFile(path.join(electronDirectory, 'main.cjs'), 'utf8'), context);
  vm.runInContext('mainWindow = windowFixture; store = storeFixture; documentService = documentFixture; workOps = opsFixture; registerIpc();', context);
  return { preview: handlers.get('documents:preview'), upload: handlers.get('documents:upload'), event: { sender: webContents, senderFrame: mainFrame }, getDialogOptions: () => dialogOptions };
}

function workspaceData(artifacts = []) {
  return {
    workspaces: [
      { id: 'primary', name: '主空间', type: 'team' },
      { id: 'related', name: '关联空间', type: 'project' },
      { id: 'private', name: '个人空间', type: 'personal' },
      { id: 'public', name: '公共空间', type: 'public' },
      { id: 'unrelated', name: '其他团队', type: 'team' }
    ],
    tasks: [{ id: 'task-main', workspace: '主空间', relatedWorkspaces: ['关联空间'], messages: [{ artifacts }] }]
  };
}

test('IPC 只允许可信主 frame、有效输入和精确存在的工作 ID', async t => {
  const ctx = await fixture(t);
  const document = await ctx.add('成果.txt', '内容');
  const harness = await ipcHarness(ctx, workspaceData([{ id: document.id }]));
  const input = { taskId: 'task-main', id: document.id };
  assert.equal((await harness.preview(harness.event, input)).text, '内容');
  for (const event of [
    { sender: {}, senderFrame: harness.event.senderFrame },
    { sender: harness.event.sender },
    { sender: harness.event.sender, senderFrame: { url: harness.event.senderFrame.url } },
    { sender: harness.event.sender, senderFrame: { url: 'https://untrusted.invalid/' } }
  ]) await assert.rejects(harness.preview(event, input), /不受信任/);
  const trustedUrl = harness.event.senderFrame.url;
  for (const url of ['about:blank', pathToFileURL(path.join(ctx.directory, 'other.html')).href, 'https://untrusted.invalid/']) {
    harness.event.senderFrame.url = url;
    await assert.rejects(harness.preview(harness.event, input), /不受信任/);
  }
  harness.event.senderFrame.url = trustedUrl;
  for (const invalid of [null, [], 'bad', {}, { taskId: '', id: document.id }, { taskId: 'task-main', id: 1 }, { taskId: 'x'.repeat(101), id: document.id }, { taskId: 'task-main', id: 'x'.repeat(101) }]) {
    await assert.rejects(harness.preview(harness.event, invalid), /无效/);
  }
  for (const taskId of ['task-', '不存在']) await assert.rejects(harness.preview(harness.event, { ...input, taskId }), /工作不存在/);
});

test('IPC 同时要求本工作 messages.artifacts 关联与主/关联/个人/public 空间归属', async t => {
  const ctx = await fixture(t);
  const data = workspaceData();
  const harness = await ipcHarness(ctx, data);
  for (const workspaceId of ['primary', 'related', 'private', 'public', 'unrelated']) {
    const document = await ctx.add(`${workspaceId}.txt`, workspaceId, workspaceId);
    data.tasks[0].messages[0].artifacts.push({ id: document.id });
    const request = harness.preview(harness.event, { taskId: 'task-main', id: document.id, allowedWorkspaceIds: ['unrelated'] });
    if (workspaceId === 'unrelated') await assert.rejects(request, /不存在或不属于/);
    else assert.equal((await request).text, workspaceId);
  }
  const unlinked = await ctx.add('未关联.txt', '内容');
  data.tasks[0].messages[0].documentRefs = [{ id: unlinked.id }];
  data.tasks.push({ id: 'task-other', workspace: '主空间', messages: [{ artifacts: [{ id: unlinked.id }] }] });
  await assert.rejects(harness.preview(harness.event, { taskId: 'task-main', id: unlinked.id }), /不属于这项工作的成果/);
  const archived = await ctx.add('归档.txt', '内容');
  data.tasks[0].messages[0].artifacts.push({ id: archived.id }, { id: '未知资料' });
  await ctx.service.setArchived(archived.id, true);
  for (const id of [archived.id, '未知资料']) await assert.rejects(harness.preview(harness.event, { taskId: 'task-main', id }), /不存在或不属于/);
  const document = (await ctx.service.list()).find(item => item.workspaceId === 'related');
  data.tasks[0].relatedWorkspaces = [];
  await assert.rejects(harness.preview(harness.event, { taskId: 'task-main', id: document.id }), /不存在或不属于/);
});

test('旧 public 工作存 personal 的成果允许预览，无所属空间的工作仍拒绝', async t => {
  const ctx = await fixture(t);
  const document = await ctx.add('旧成果.txt', '旧内容', 'private');
  const data = workspaceData([{ id: document.id }]);
  data.tasks[0].workspace = '公共空间';
  data.tasks[0].relatedWorkspaces = [];
  const harness = await ipcHarness(ctx, data);
  assert.equal((await harness.preview(harness.event, { taskId: 'task-main', id: document.id })).text, '旧内容');
  data.tasks[0].workspace = '已删除空间';
  await assert.rejects(harness.preview(harness.event, { taskId: 'task-main', id: document.id }), /访问权限/);
});

test('上传白名单和 main dialog 均包含新增格式，preload 转发 previewDocument 对象', async t => {
  const ctx = await fixture(t);
  const harness = await ipcHarness(ctx, workspaceData());
  await harness.upload(harness.event, 'primary');
  for (const extension of ['html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'webp']) {
    assert.equal(allowedExtensions.has(`.${extension}`), true);
    assert.ok(harness.getDialogOptions().filters[0].extensions.includes(extension));
  }
  let api;
  const calls = [];
  const context = vm.createContext({ require: id => {
    assert.equal(id, 'electron');
    return {
      contextBridge: { exposeInMainWorld: (name, exposed) => { assert.equal(name, 'gongzuo'); api = exposed; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve('测试返回'); } }
    };
  } });
  vm.runInContext(await fs.readFile(path.join(electronDirectory, 'preload.cjs'), 'utf8'), context);
  const input = { taskId: 'task-main', id: 'document-id' };
  assert.equal(await api.previewDocument(input), '测试返回');
  assert.deepEqual(calls, [['documents:preview', input]]);
  assert.equal(Object.isFrozen(api), true);
});
