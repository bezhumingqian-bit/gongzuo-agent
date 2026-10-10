function createSeed() {
  return {
    schemaVersion: 1,
    activeWorkspace: '产品团队',
    workspaces: [
      { id: 'product', name: '产品团队', type: 'team' },
      { id: 'operations', name: '运营团队', type: 'team' },
      { id: 'public', name: '公共空间', type: 'public' }
    ],
    tasks: [
      {
        id: 'feedback',
        title: '给客户反馈应用增加统计页',
        goal: '给客户反馈管理应用增加统计页，按来源和状态展示本周趋势。',
        workspace: '产品团队',
        status: 'review',
        needsMe: true,
        dot: 'amber',
        meta: '待你确认 · 产品团队 · 10 分钟前',
        createdAt: '2026-09-23T01:00:00.000Z',
        updatedAt: '2026-09-23T01:10:00.000Z',
        messages: []
      },
      {
        id: 'insight',
        title: '整理本季度客户洞察',
        goal: '整理本季度客户洞察，重点说明用户反馈发生了什么变化。',
        workspace: '产品团队',
        status: 'running',
        needsMe: false,
        dot: 'green',
        meta: 'AI 正在替你处理 · 产品团队',
        createdAt: '2026-09-23T00:20:00.000Z',
        updatedAt: '2026-09-23T00:28:00.000Z',
        messages: []
      },
      {
        id: 'onboarding',
        title: '完善新同事入职清单',
        goal: '完善新同事入职清单，让接手人一眼看出当前进度。',
        workspace: '运营团队',
        status: 'todo',
        needsMe: true,
        dot: 'violet',
        meta: '等待你补充 · 运营团队 · 昨天',
        createdAt: '2026-09-22T04:00:00.000Z',
        updatedAt: '2026-09-22T04:00:00.000Z',
        messages: []
      }
    ],
    apps: [
      { id: 'feedback', name: '客户反馈管理', workspace: '产品团队', version: 1, description: '反馈录入与跟进', status: 'published' },
      { id: 'budget', name: '预算申请台', workspace: '运营团队', version: 1, description: '申请与审批', status: 'published' }
    ],
    channelEvents: []
  };
}

module.exports = { createSeed };
