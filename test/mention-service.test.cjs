const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveMentions } = require('../electron/mention-service.cjs');

test('mentions only resolve active colleagues from the task workspace', () => {
  const data = { workspaces: [
    { name: '项目 A', members: [
      { id: 'local-user', name: '我', status: 'active' },
      { id: 'colleague', name: '张宁', status: 'active' },
      { id: 'pending', name: '李然', status: 'pending' }
    ] },
    { name: '项目 B', members: [{ id: 'outsider', name: '王敏', status: 'active' }] }
  ] };
  const task = { workspace: '项目 A' };
  assert.deepEqual(resolveMentions(data, task, ['colleague', 'colleague']), [{ memberId: 'colleague', name: '张宁' }]);
  for (const id of ['local-user', 'pending', 'outsider', 'missing']) {
    assert.throws(() => resolveMentions(data, task, [id]), /只能提及/);
  }
});
