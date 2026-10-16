(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GongzuoWorkIndex = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SEEDS = Object.freeze({
    feedback: { title: '给客户反馈应用增加统计页', goal: '给客户反馈管理应用增加统计页，按来源和状态展示本周趋势。' },
    insight: { title: '整理本季度客户洞察', goal: '整理本季度客户洞察，重点说明用户反馈发生了什么变化。' },
    onboarding: { title: '完善新同事入职清单', goal: '完善新同事入职清单，让接手人一眼看出当前进度。' }
  });
  const string = value => typeof value === 'string' ? value : '';
  const list = value => Array.isArray(value) ? value : [];
  const object = value => value && typeof value === 'object' ? value : {};
  const clean = value => string(value).trim();
  const limit = (value, length) => {
    const chars = Array.from(string(value));
    return chars.length > length ? chars.slice(0, length - 1).join('') + '…' : string(value);
  };
  const comparable = text => clean(text).replace(/^[\s，,。.!！?？、;；:：]+|[\s，,。.!！?？、;；:：]+$/gu, '').toLowerCase();

  function casualKind(text) {
    const value = comparable(text).replace(/^你\s*[·•]\s*刚刚\s*/u, '').replace(/^(?:那|所以)[，,\s]*/u, '');
    if (/^(?:在吗|在不在|你好|您好|嗨|哈喽|hello|hi|hey|早上好|下午好|晚上好|早安|晚安|早|在|好的|好|好呀|好啊|可以|行|嗯|嗯嗯|哦|哦哦|ok|okay|收到|明白|知道了|谢谢|谢谢你|谢谢您|多谢|感谢|不客气|再见)$/u.test(value)) return 'greeting';
    if (/^(?:(?:你|您)(?:现在|目前)?(?:是?(?:用|使用)(?:的)?(?:是)?|是)|你是)(?:什么|哪个|哪种|哪一个)(?:ai)?(?:模型|大模型)(?:呀|啊|吗|呢)?$/u.test(value)
      || /^(?:你|您)(?:是(?:什么|哪个)(?:模型|ai)|是谁|叫什么|有什么能力|有哪些能力|能做什么|可以做什么|会做什么)(?:吗|呢)?$/u.test(value)
      || /^(?:(?:你|您)(?:可以|能|会|能不能|可不可以|会不会)|(?:可以|能|会|能不能|可不可以))(?:帮我)?(?:做|制作|生成|写|开发)(?:一个|一份)?(?:ppt|pptx|演示文稿|幻灯片|文档|word|表格|excel|代码|网站|小程序)(?:给我|给我们)?(?:吗|么|嘛|呢)?$/u.test(value)) return 'capability';
    return '';
  }

  function isCasualPrompt(text) { return Boolean(casualKind(text)); }

  function stripPoliteness(text) {
    return clean(text).replace(/^(?:你先|你(?:能|可以)(?:先)?)[，,\s]*/u, '').replace(/^(?:(?:请(?:你|您)?|麻烦(?:你|您)?|劳烦(?:你|您)?|能否|能不能|可不可以|可以(?:帮我)?|能(?:帮我)?|帮我|替我|给我|去)[\s，,]*)+/u, '').trim();
  }

  function isTestPrompt(text) {
    return /^(?:【(?:联调|自动领取联调|预览版验收|测试)】|(?:自动领取联调|预览版验收|联调|测试)(?=$|[\s：:，,·\-]))/u.test(clean(text));
  }

  function isRequest(text) {
    if (!clean(text) || isCasualPrompt(text) || isTestPrompt(text)) return false;
    const value = stripPoliteness(text);
    return /^(?:开发|制作|生成|创建|新建|做|写|查|查询|查看|检查|核对|整理|汇总|总结|分析|介绍|解释|修改|更改|更新|增加|新增|添加|删除|移除|修复|优化|设计|实现|构建|导出|导入|转换|翻译|比较|对比|计算|统计|搜索|检索|读取|列出|提取|完成|继续|补充|准备|安排|发送|搭建|测试|验证|请问|告诉我|我要|我需要|我想(?:要)?)/u.test(value)
      || /^(?:你|您)(?:可以|能|能不能|可不可以)(?:帮我)?(?:开发|制作|生成|做|写|查|整理|介绍|修改)/u.test(value)
      || /^(?:把|将|给|为|替).+(?:开发|制作|生成|做|写|查|整理|介绍|修改|改成|改为|加上|列出|导出|翻译|更新)/u.test(value);
  }

  function usersOf(task) {
    return list(task.messages).filter(item => item && item.role === 'user' && !item.wecomOutbound && item.id !== 'colleague-context' && clean(item.text));
  }

  function latest(items, textOf) {
    return items.reduce((best, item) => {
      const text = clean(textOf(item));
      if (!text) return best;
      const at = Date.parse(string(item.publishedAt || item.updatedAt || item.createdAt));
      if (!best || !Number.isFinite(at) || !Number.isFinite(best.at) || at >= best.at) return { text, at };
      return best;
    }, null)?.text || '';
  }

  function objectiveFrom(input) {
    const task = object(input);
    const users = usersOf(task);
    const request = latest(users.filter(item => isRequest(item.text)), item => item.text);
    if (request) return stripPoliteness(request);
    const meaningful = text => clean(text) && !isCasualPrompt(text) && !isTestPrompt(text) && !isPlaceholder(text);
    const userText = latest(users.filter(item => meaningful(item.text)), item => item.text);
    if (userText) return stripPoliteness(userText);
    const seededGoal = hasSeedTitle(task) && string(task.goal) === seedOf(task)?.goal;
    return meaningful(task.goal) && !seededGoal ? stripPoliteness(task.goal) : '';
  }

  function isPlaceholder(text) {
    return /^(?:agent\s*已回复|ai\s*已回复|agent\s*正在处理|ai\s*正在替你处理|等待\s*agent\s*回复|未命名(?:工作|任务)|新(?:工作|任务))[。.!！]?$/iu.test(clean(text));
  }

  function confirmedProgress(task) {
    return list(task.progress).filter(item => item && (item.status === 'published' || item.status === 'confirmed' || item.confirmed === true)
      && clean(item.text) && !isPlaceholder(item.text));
  }

  function artifactName(item) {
    if (typeof item === 'string') return /\.[a-z0-9]{1,10}$/iu.test(item) ? item.split(/[\\/]/u).at(-1) : '';
    if (!item || item.sample === true || item.demo === true || ['sample', 'demo'].includes(item.source)
      || ['pending', 'draft', 'failed', 'deleted', 'removed'].includes(item.status)) return '';
    return clean(item.name || item.fileName) || clean(item.path).split(/[\\/]/u).at(-1) || '';
  }

  function artifactsOf(task) {
    return [...list(task.artifacts), ...list(task.files), ...list(task.messages).flatMap(item => list(item?.artifacts))]
      .map(artifactName).filter(Boolean);
  }

  function hasContext(task) {
    return list(task.documentRefs).length > 0 || list(task.mentions).length > 0
      || usersOf(task).some(item => list(item.documentRefs).length || list(item.mentions).length);
  }

  function seedOf(task) {
    return typeof task.id === 'string' && Object.prototype.hasOwnProperty.call(SEEDS, task.id) ? SEEDS[task.id] : null;
  }

  function hasSeedTitle(task) {
    const seed = seedOf(task);
    return Boolean(seed && (string(task.title) === seed.title || (!clean(task.title) && string(task.goal) === seed.goal)));
  }

  function isUntouchedSample(task) {
    const seed = seedOf(task);
    return Boolean(seed && hasSeedTitle(task) && (!clean(task.goal) || string(task.goal) === seed.goal)
      && task.titleSource !== 'manual' && !usersOf(task).length && !artifactsOf(task).length && !confirmedProgress(task).length);
  }

  function classifyTask(input) {
    const task = object(input);
    const users = usersOf(task);
    if (task.channelOnly === true || (task.kind === 'channel' && !users.length)) return 'channel';
    if (isUntouchedSample(task)) return 'sample';
    const initialTest = isTestPrompt(task.goal) || isTestPrompt(task.title) || isTestPrompt(users[0]?.text);
    if (initialTest && !users.some(item => isRequest(item.text)) && !isRequest(task.goal)) return 'test';
    if (artifactsOf(task).length || confirmedProgress(task).length || hasContext(task)) return 'work';
    if (users.some(item => !isCasualPrompt(item.text)) || (clean(task.goal) && !isCasualPrompt(task.goal) && !isTestPrompt(task.goal))) return 'work';
    if (users.length || isCasualPrompt(task.goal) || isCasualPrompt(task.title) || task.kind === 'conversation') return 'conversation';
    return 'work';
  }

  function sameTopic(title, objective) {
    const content = value => stripPoliteness(value).toLowerCase()
      .replace(/开发|制作|生成|创建|新建|整理|介绍|查询|任务|工作|一个|一份|帮我|请|修改|增加|继续|补充|测试|pptx?|演示文稿|文档|文件|清单|报告|页面|应用|内容|材料|资料/gu, ' ');
    const left = content(title);
    const right = content(objective);
    const words = left.match(/[a-z0-9]{2,}|[\p{Script=Han}]{2,}/gu) || [];
    return words.some(word => /^[a-z0-9]+$/u.test(word) ? (right.match(/[a-z0-9]{2,}/gu) || []).includes(word)
      : right.includes(word));
  }

  function updatedAtOf(task) {
    const dates = [task.updatedAt, task.createdAt, ...list(task.messages).map(item => item?.createdAt),
      ...confirmedProgress(task).flatMap(item => [item.publishedAt, item.updatedAt, item.createdAt])].filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value)));
    return dates.reduce((best, date) => !best || Date.parse(date) > Date.parse(best) ? date : best, '');
  }

  function displayTask(input) {
    const task = object(input);
    const kind = classifyTask(task);
    const originalTitle = string(task.title) || string(task.goal);
    const objective = objectiveFrom(task);
    const artifacts = artifactsOf(task);
    const confirmed = confirmedProgress(task);
    const updatedAt = updatedAtOf(task);
    let title = clean(originalTitle);
    if (task.titleSource !== 'manual') {
      if (kind === 'conversation') {
        title = [task.goal, task.title, ...usersOf(task).map(item => item.text)].some(text => casualKind(text) === 'capability') ? '模型与能力咨询' : '简短问候';
      } else if (kind === 'work') {
        const useful = title && !isCasualPrompt(title) && !isTestPrompt(title) && !isPlaceholder(title);
        if (!useful || hasSeedTitle(task) || (objective && sameTopic(title, objective))) title = objective || artifacts.at(-1) || (confirmed.length ? '工作进展' : useful ? title : '未命名工作');
      }
    }
    if (task.titleSource !== 'manual' && title !== originalTitle && kind === 'work') {
      if (/是否可用/u.test(title) && /应用/u.test(title) && /更新/u.test(title)) title = '应用可用性与更新建议';
      else if (/随便做(?:一个|一份)?ppt/iu.test(title)) title = '制作示例 PPT';
    }
    title = title || (kind === 'channel' ? '渠道消息' : '未命名工作');
    if (task.titleSource === 'manual' && originalTitle) title = originalTitle;
    else if (title !== originalTitle) title = limit(title, 36);
    let preview;
    if (kind === 'conversation') preview = [updatedAt.slice(0, 10), title].filter(Boolean).join(' · ');
    else {
      const parts = [latest(confirmed, item => item.text), artifacts.length ? `文件：${[...new Set(artifacts)].slice(-3).join('、')}` : '', objective];
      preview = limit(parts.filter(Boolean).join(' · ') || (kind === 'sample' ? '演示样例，尚无真实进展' : kind === 'channel' ? '渠道消息记录' : kind === 'test' ? '联调与验收记录' : '尚无已确认进展'), 240);
    }
    return { kind, title, preview, originalTitle, derived: title !== originalTitle, updatedAt };
  }

  return { classifyTask, displayTask, isCasualPrompt, objectiveFrom, isTestPrompt, isRequest };
});
