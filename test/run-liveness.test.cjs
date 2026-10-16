// The work page knows a running Agent is alive: start time, last sign of
// life, steps and reconnect phase are kept on agentRun; late progress never
// overwrites a finished run; CloudAgent work is picked up after a restart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../electron/store.cjs');
const { TaskRunner } = require('../electron/task-runner.cjs');

async function setup(agent, mode = 'codex') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-live-test-'));
  const store = new JsonStore(path.join(directory, 'workspace.json'), () => ({ workspaces: [{ id: 'product', name: '产品团队' }], tasks: [] }));
  const personalMemoryStore = new JsonStore(path.join(directory, 'personal.json'), () => ({ items: [] }));
  const teamMemoryStore = new JsonStore(path.join(directory, 'team.json'), () => ({ items: [] }));
  await Promise.all([store.initialize(), personalMemoryStore.initialize(), teamMemoryStore.initialize()]);
  const settingsService = { getRuntimeConfig: async () => ({ agent: { mode } }) };
  const documentService = { list: async () => [], readForAgent: async () => { throw new Error('unexpected'); } };
  const runner = new TaskRunner({ store, settingsService, personalMemoryStore, teamMemoryStore, documentService, agent, publish: () => {} });
  return { directory, store, runner };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, ok, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (ok(value) || Date.now() > end) return value; await wait(50); }
}

test('运行中记录开始时间、最近动作、步数与重连阶段；回复后进度不会把状态改回运行中', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const agent = {
    isConfigured: () => true,
    answer: async (task, config, memory, { onProgress }) => {
      onProgress({ step: '运行命令 python3 build.py', steps: 3, lastActivityAt: Date.now() - 5000 });
      await wait(1700);
      onProgress({ text: '写到第 6 页', steps: 4, phase: 'reconnecting', attempt: 2 });
      await gate;
      onProgress({ text: '最后一句', steps: 9 });
      return { role: 'assistant', text: '完成', source: 'codex', createdAt: new Date().toISOString() };
    }
  };
  const { directory, store, runner } = await setup(agent);
  try {
    const created = await runner.create('做 PPT', '产品团队');
    const runOf = async () => (await store.read()).tasks[0].agentRun;
    let run = await until(runOf, item => item.steps === 3);
    assert.equal(run.status, 'running');
    assert.ok(Date.parse(run.startedAt) > 0, '有开始时间');
    assert.equal(run.progress, '正在运行命令 python3 build.py');
    assert.equal(run.steps, 3);
    assert.ok(Date.now() - Date.parse(run.lastActivityAt) >= 5000, '最近动作时间来自 Agent');
    run = await until(runOf, item => item.phase === 'reconnecting');
    assert.equal(run.phase, 'reconnecting');
    assert.ok(Date.now() - Date.parse(run.lastActivityAt) >= 5000, '重连不伪造新动作');
    assert.equal(run.attempt, 2);
    assert.equal(run.progress, '写到第 6 页');
    release();
    await runner.queues.get(created.id);
    await wait(1700);
    run = (await store.read()).tasks[0].agentRun;
    assert.equal(run.status, 'done', '回复后的迟到进度不覆盖完成状态');
  } finally { release(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('首轮发送前持久化云端 session，连接报告不伪造动作；上限超时标失败而不是完成', async () => {
  let storeRef;
  const agent = {
    isConfigured: () => true,
    answer: async (task, config, memory, { onProgress }) => {
      await onProgress({ sessionId: 'runtime:session', phase: 'working' });
      const saved = (await storeRef.read()).tasks.find(item => item.id === task.id);
      assert.equal(saved.agentSessionId, 'runtime:session');
      assert.equal(saved.agentRun.lastActivityAt, undefined);
      assert.ok(Date.parse(saved.agentRun.startedAt));
      return { id: 'timeout-result', role: 'assistant', text: '部分成果<进展>[{"kind":"output","text":"不应发布"}]</进展>', source: 'cloudagent', stopReason: 'timeout', createdAt: new Date().toISOString() };
    }
  };
  const { directory, store, runner } = await setup(agent, 'cloudagent'); storeRef = store;
  try {
    const task = await runner.create('长任务', '产品团队');
    await runner.queues.get(task.id);
    const saved = (await store.read()).tasks[0];
    assert.equal(saved.agentRun.status, 'failed');
    assert.equal(saved.messages.at(-1).stopReason, 'timeout');
    assert.equal(saved.progress?.length || 0, 0);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('执行步骤最后一次立即落盘并绑定到本轮回复，下一轮不覆盖历史', async () => {
  let serial = 0;
  const agent = { isConfigured: () => true, answer: async (task, config, memory, { onProgress }) => {
    serial++;
    onProgress({ execution: [{ id: `tool-${serial}`, title: '运行沙箱命令', kind: 'execute', status: 'completed', startedAt: Date.now() - 100, endedAt: Date.now() }], steps: 1 });
    return { id: `answer-${serial}`, role: 'assistant', text: '已完成', source: 'cloudagent', createdAt: new Date().toISOString() };
  } };
  const { directory, store, runner } = await setup(agent, 'cloudagent');
  try {
    const task = await runner.create('测试两轮', '产品团队');
    await runner.queues.get(task.id);
    await runner.append(task.id, '第二轮');
    await runner.queues.get(task.id);
    const saved = (await store.read()).tasks[0];
    const replies = saved.messages.filter(item => item.role === 'assistant');
    assert.equal(replies[0].execution.entries[0].id, 'tool-1');
    assert.equal(replies[1].execution.entries[0].id, 'tool-2');
    assert.equal(saved.agentRun.execution[0].id, 'tool-2');
    assert.ok(Date.parse(replies[1].execution.endedAt) >= Date.parse(replies[1].execution.startedAt));
    assert.equal(saved.progress?.length || 0, 0, '工具步骤不是团队进展');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('应用重启：运行中的 CloudAgent 工作自动续接，其他 Agent 只标记中断', async () => {
  const seen = [];
  const agent = { isConfigured: () => true, answer: async task => { seen.push(task.id); return { role: 'assistant', text: '取回了', source: 'cloudagent', createdAt: new Date().toISOString() }; } };
  const { directory, store, runner } = await setup(agent, 'cloudagent');
  try {
    const cloud = await runner.create('云端做 PPT', '产品团队');
    const local = await runner.create('本机整理', '产品团队');
    await runner.queues.get(cloud.id); await runner.queues.get(local.id);
    seen.length = 0;
    await store.update(data => {
      for (const task of data.tasks) task.agentRun = { status: 'running', triggerId: task.messages[0].id };
      data.tasks.find(task => task.id === local.id).agentMode = 'codex';
      return data;
    });
    await runner.markInterrupted();
    assert.ok((await store.read()).tasks.every(task => task.agentRun.status === 'interrupted'));
    const resumed = await runner.resumeCloudRuns();
    assert.deepEqual(resumed, [cloud.id]);
    await runner.queues.get(cloud.id);
    const tasks = (await store.read()).tasks;
    assert.equal(tasks.find(task => task.id === cloud.id).agentRun.status, 'done');
    assert.equal(tasks.find(task => task.id === local.id).agentRun.status, 'interrupted');
    assert.deepEqual(seen, [cloud.id]);
    assert.deepEqual(await runner.resumeCloudRuns(), [], '只续接一次');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
