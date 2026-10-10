const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DocumentService } = require('../electron/document-service.cjs');

test('documents stay in their workspace and can be categorized, archived and restored', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-documents-'));
  try {
    const source = path.join(directory, '入职说明.txt');
    await fs.writeFile(source, '示例内容');
    const service = new DocumentService(path.join(directory, 'index.json'), path.join(directory, 'files'));
    await service.initialize();
    const [uploaded] = await service.upload('public', [source]);
    assert.equal(uploaded.workspaceId, 'public');
    assert.equal(uploaded.storedName, undefined);
    assert.equal(await fs.readFile(await service.getFilePath(uploaded.id), 'utf8'), '示例内容');
    assert.deepEqual(await service.readForAgent(uploaded.id, 'public'), { id: uploaded.id, name: '入职说明.txt', text: '示例内容', truncated: false });
    await assert.rejects(service.readForAgent(uploaded.id, 'product'), /不属于当前空间/);
    assert.equal((await fs.stat(await service.getFilePath(uploaded.id))).mode & 0o777, 0o600);
    const updated = await service.update(uploaded.id, { category: '规范', tags: ['入职', '流程'] });
    assert.deepEqual(updated.tags, ['入职', '流程']);
    await service.setArchived(uploaded.id, true);
    await assert.rejects(service.readForAgent(uploaded.id, 'public'), /不属于当前空间/);
    await assert.rejects(service.getFilePath(uploaded.id), /资料不存在/);
    await service.setArchived(uploaded.id, false);
    assert.equal((await service.list())[0].category, '规范');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('unsupported files do not leave partial uploads', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-documents-'));
  try {
    const valid = path.join(directory, '说明.md');
    const invalid = path.join(directory, 'script.sh');
    await Promise.all([fs.writeFile(valid, '说明'), fs.writeFile(invalid, 'echo hello')]);
    const service = new DocumentService(path.join(directory, 'index.json'), path.join(directory, 'files'));
    await service.initialize();
    await assert.rejects(service.upload('public', [valid, invalid]), /不支持的文件格式/);
    assert.deepEqual(await service.list(), []);
    assert.deepEqual(await fs.readdir(path.join(directory, 'files')), []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
