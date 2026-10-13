// WorkOperations: the one place that creates, extends and reads work on behalf
// of an actor. It resolves the workspace, asks policy, then delegates execution
// to TaskRunner. Entry points translate WorkError codes into their own wording.
const { authorize } = require('./policy.cjs');

class WorkError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code; // workspace-not-found | task-not-found | no-access | read-only
    Object.assign(this, detail);
  }
}

// Accept a full ID or an unambiguous prefix (WeCom users type short IDs).
function findTask(data, id) {
  const matches = (data.tasks || []).filter(task => task.id === id || task.id.startsWith(id));
  return matches.length === 1 ? matches[0] : null;
}

class WorkOperations {
  constructor({ store, taskRunner }) {
    Object.assign(this, { store, taskRunner });
  }

  check(actor, action, space) {
    const result = authorize(actor, action, space);
    if (!result.allowed) throw new WorkError(result.reason, result.reason === 'read-only' ? '只读权限不能执行此操作' : '没有该空间的访问权限', { role: result.role, workspace: space?.name });
    return result.role;
  }

  async spaceBy(predicate, label) {
    const data = await this.store.read();
    const space = data.workspaces.find(predicate);
    if (!space) throw new WorkError('workspace-not-found', `工作空间不存在：${label}`);
    return { data, space };
  }

  async create(actor, { workspace, workspaceId, goal, documentIds = [], origin = null, options = {} }) {
    const { space } = workspaceId
      ? await this.spaceBy(item => item.id === workspaceId, workspaceId)
      : await this.spaceBy(item => item.name === workspace, workspace);
    this.check(actor, 'work.create', space);
    return this.taskRunner.create(goal, space.name, documentIds, origin, options);
  }

  async resolve(actor, taskId, action) {
    const data = await this.store.read();
    const task = findTask(data, taskId);
    if (!task) throw new WorkError('task-not-found', '工作不存在');
    const space = data.workspaces.find(item => item.name === task.workspace);
    const role = this.check(actor, action, space);
    return { task, space, role };
  }

  view(actor, taskId) {
    return this.resolve(actor, taskId, 'work.view');
  }

  async append(actor, taskId, text, { mentions = [], documentIds = [], origin = null } = {}) {
    const { task } = await this.resolve(actor, taskId, 'work.append');
    const message = await this.taskRunner.append(task.id, text, mentions, documentIds, origin);
    return { task, message };
  }
}

module.exports = { WorkOperations, WorkError, findTask };
