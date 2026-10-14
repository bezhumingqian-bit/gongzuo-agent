// WorkOperations: the one place that creates, extends and reads work on behalf
// of an actor. It resolves the workspace, asks policy, then delegates execution
// to TaskRunner. Entry points translate WorkError codes into their own wording.
const { authorize, authorizeAny } = require('./policy.cjs');

const MAX_RELATED = 5;

class WorkError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code; // workspace-not-found | task-not-found | no-access | read-only | invalid-related
    Object.assign(this, detail);
  }
}

// Spaces a work belongs to: its primary space first, then related spaces.
function taskSpaces(data, task) {
  const names = [task.workspace, ...(task.relatedWorkspaces || [])];
  return names.map(name => (data.workspaces || []).find(space => space.name === name)).filter(Boolean);
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

  // Related spaces must exist, differ from the primary space, and the actor
  // must be able to create work in each of them.
  relatedSpaces(actor, data, primaryName, names) {
    if (names == null) return [];
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) throw new WorkError('invalid-related', '关联空间格式无效');
    const unique = [...new Set(names.map(name => name.trim()).filter(Boolean))].filter(name => name !== primaryName);
    if (unique.length > MAX_RELATED) throw new WorkError('invalid-related', `一项工作最多关联 ${MAX_RELATED} 个空间`);
    return unique.map(name => {
      const space = data.workspaces.find(item => item.name === name);
      if (!space) throw new WorkError('workspace-not-found', `工作空间不存在：${name}`);
      this.check(actor, 'work.create', space);
      return space.name;
    });
  }

  async create(actor, { workspace, workspaceId, goal, documentIds = [], origin = null, options = {}, relatedWorkspaces = null }) {
    const { data, space } = workspaceId
      ? await this.spaceBy(item => item.id === workspaceId, workspaceId)
      : await this.spaceBy(item => item.name === workspace, workspace);
    this.check(actor, 'work.create', space);
    const related = this.relatedSpaces(actor, data, space.name, relatedWorkspaces);
    return this.taskRunner.create(goal, space.name, documentIds, origin, related.length ? { ...options, relatedWorkspaces: related } : options);
  }

  async resolve(actor, taskId, action) {
    const data = await this.store.read();
    const task = findTask(data, taskId);
    if (!task) throw new WorkError('task-not-found', '工作不存在');
    const space = data.workspaces.find(item => item.name === task.workspace);
    const result = authorizeAny(actor, action, taskSpaces(data, task));
    if (!result.allowed) throw new WorkError(result.reason, result.reason === 'read-only' ? '只读权限不能执行此操作' : '没有该空间的访问权限', { role: result.role, workspace: space?.name });
    return { task, space, role: result.role };
  }

  // Changing which spaces a work is related to is decided in its primary space;
  // adding a space also needs the right to create work there.
  async setRelated(actor, taskId, names) {
    const data = await this.store.read();
    const task = findTask(data, taskId);
    if (!task) throw new WorkError('task-not-found', '工作不存在');
    const primary = data.workspaces.find(item => item.name === task.workspace);
    this.check(actor, 'work.append', primary);
    const current = new Set(task.relatedWorkspaces || []);
    const added = (Array.isArray(names) ? names : []).filter(name => !current.has(name));
    this.relatedSpaces(actor, data, task.workspace, added);
    const next = this.relatedSpaces({ type: 'local', id: 'policy-check' }, data, task.workspace, names);
    return this.taskRunner.setRelatedWorkspaces(task.id, next);
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

module.exports = { WorkOperations, WorkError, findTask, taskSpaces, MAX_RELATED };
