// Approval broker: an Agent engine asks to run an action that needs a human
// (a sandbox command, a deletion…); the work page shows it and the local user
// allows or declines. No answer within the time limit means decline.
//
// Pending approvals live in memory: they belong to a live engine connection.
// After an app restart the engine re-asks or the turn is retried.
const crypto = require('node:crypto');

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

class ApprovalBroker {
  constructor({ timeoutMs = APPROVAL_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now() } = {}) {
    Object.assign(this, { timeoutMs, setTimer, clearTimer, now });
    this.pending = new Map();
  }

  // Returns { approval, decision } where decision resolves to
  // { outcome: 'allow' | 'reject', reason: 'user' | 'timeout' | 'cancelled' }.
  open({ taskId, triggerId, title, kind }) {
    const id = crypto.randomUUID();
    const requestedAt = this.now();
    const approval = { id, taskId, triggerId, title: String(title || '需确认的操作').slice(0, 120), kind: String(kind || 'other').slice(0, 20), requestedAt, expiresAt: requestedAt + this.timeoutMs };
    const decision = new Promise(resolve => {
      const timer = this.setTimer(() => this.settle(id, { outcome: 'reject', reason: 'timeout' }), this.timeoutMs);
      this.pending.set(id, { approval, resolve, timer });
    });
    return { approval, decision };
  }

  settle(id, result) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    this.clearTimer(entry.timer);
    entry.resolve(result);
    return true;
  }

  // From the work page. Only the task the approval belongs to can answer it.
  resolve(taskId, id, outcome) {
    const entry = this.pending.get(id);
    if (!entry || entry.approval.taskId !== taskId) return false;
    if (!['allow', 'reject'].includes(outcome)) throw new Error('确认结果无效');
    return this.settle(id, { outcome, reason: 'user' });
  }

  cancelTask(taskId) {
    for (const [id, entry] of [...this.pending]) if (entry.approval.taskId === taskId) this.settle(id, { outcome: 'reject', reason: 'cancelled' });
  }

  list(taskId) {
    return [...this.pending.values()].map(entry => entry.approval).filter(item => !taskId || item.taskId === taskId);
  }
}

module.exports = { ApprovalBroker, APPROVAL_TIMEOUT_MS };
