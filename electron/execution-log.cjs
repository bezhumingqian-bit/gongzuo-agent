// A bounded, public tool timeline — never persist arguments, output or thoughts.
const LIMIT = 120;
const STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed', 'unknown']);
const KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'think', 'other']);
const clean = (value, length) => String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, length);
function mergeStep(items = [], input = {}, now = Date.now()) {
  if (!input || typeof input !== 'object' || !input.id) return items.slice(-LIMIT);
  const id = clean(input.id, 160);
  const prior = items.find(item => item.id === id);
  const title = input.title ? clean(input.title, 100) : prior?.title || '执行一步';
  const status = STATUSES.has(input.status) ? input.status : prior?.status || 'pending';
  // Replay may re-announce a pending call after its terminal status was received.
  const terminal = prior && ['completed', 'failed'].includes(prior.status);
  const nextStatus = terminal && ['pending', 'in_progress'].includes(status) ? prior.status : status;
  const time = Number.isFinite(now) ? now : Date.now();
  const entry = {
    id, title, kind: KINDS.has(input.kind) ? input.kind : prior?.kind || 'other', status: nextStatus,
    startedAt: prior?.startedAt ?? (Number.isFinite(input.startedAt) && input.startedAt > 0 && input.startedAt <= time ? input.startedAt : input.replayed ? null : time),
    endedAt: prior?.endedAt ?? (['completed', 'failed'].includes(nextStatus) ? (Number.isFinite(input.endedAt) && input.endedAt > 0 && input.endedAt <= time ? input.endedAt : input.replayed ? null : time) : null)
  };
  return [...items.filter(item => item.id !== id), entry].sort((a, b) => {
    const ai = items.findIndex(item => item.id === a.id), bi = items.findIndex(item => item.id === b.id);
    return (ai < 0 ? items.length : ai) - (bi < 0 ? items.length : bi);
  }).slice(-LIMIT);
}
module.exports = { mergeStep, LIMIT };
