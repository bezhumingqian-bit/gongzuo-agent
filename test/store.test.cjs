const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../electron/store.cjs');

test('JSON store 初始化并持久化事务结果', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'data.json'), () => ({ count: 0, tasks: [] }));
  await store.initialize();
  await store.update(draft => {
    draft.count += 1;
    draft.tasks.push({ id: 'task-1' });
    return draft;
  });
  const restored = await store.read();
  assert.deepEqual(restored, { count: 1, tasks: [{ id: 'task-1' }] });
});

test('JSON store 串行处理并发更新', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'data.json'), () => ({ count: 0 }));
  await store.initialize();
  await Promise.all(Array.from({ length: 8 }, () => store.update(draft => {
    draft.count += 1;
    return draft;
  })));
  assert.equal((await store.read()).count, 8);
});
