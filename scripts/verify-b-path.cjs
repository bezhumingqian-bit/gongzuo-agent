// Browser regression with fresh fixture files only; no credentials or userData.
// NODE_PATH=<managed workspace>/node_modules node scripts/verify-b-path.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const puppeteer = require('puppeteer');
const { DocumentService } = require('../electron/document-service.cjs');
(async () => {
  const root = path.resolve(__dirname, '..');
  const output = path.resolve(root, '../outputs/共作-B路径预览-20261015');
  await fs.mkdir(output, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-b-qa-'));
  const service = new DocumentService(path.join(temporary, 'documents.json'), path.join(temporary, 'files'));
  await service.initialize();
  let browser;
  const checks = [];
  try {
    browser = process.env.GONGZUO_QA_CDP ? await puppeteer.connect({ browserWSEndpoint: process.env.GONGZUO_QA_CDP }) : await puppeteer.launch({ headless: true, args: ['--allow-file-access-from-files'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    const errors = [], network = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    const content = `<!doctype html><html><head><style>body{background:#faf9f6;color:#384352;font:14px system-ui;margin:0;padding:32px}small{color:#929aa4}h1{font-size:24px;margin:20px 0 12px}p{line-height:1.8;color:#788393}.card{border:1px solid #e1e5ea;background:white;border-radius:10px;padding:22px;margin:20px 0}button{border:1px solid #d3dbe5;background:#f0f4f9;color:#4d617d;border-radius:6px;padding:8px 14px}input{border:1px solid #dbe1e8;padding:9px;border-radius:6px;display:block;width:90%;margin:14px 0}</style></head><body><small>浏览器验收样例 · 非云端业务数据</small><h1>项目交接工作台</h1><p>成果已经回到当前工作。可以在右侧查看页面，继续交代 Agent 改进。</p><div class="card"><strong>交接摘要</strong><p>目标、关键决定、下一步集中在一处。</p><input id="draft" placeholder="填写临时备注"><button id="count" onclick="this.textContent=String(++window.count)">确认收到</button></div><small>交互只在隔离预览内，不写入空间资料。</small><script>window.count=0;window.ready=true;window.networkBlocked=false;fetch('https://preview-qa.invalid/not-allowed').then(()=>{},()=>window.networkBlocked=true);try{window.parent.gongzuo;window.parentReadable=true}catch{window.parentReadable=false}try{localStorage.setItem('escape','x');window.storageReadable=true}catch{window.storageReadable=false}</script></body></html>`;
    const source = path.join(temporary, '交接工作台.html');
    await fs.writeFile(source, content);
    const document = (await service.upload('product', [source], { origin: { taskId: 'qa-work', messageId: 'qa-answer' } }))[0];
    const preview = await service.preview(document.id, ['product']);
    const now = Date.now();
    const data = {
      activeWorkspace: '产品团队',
      workspaces: [{ id: 'personal', name: '个人空间', type: 'personal' }, { id: 'product', name: '产品团队', type: 'team' }, { id: 'public', name: '公共空间', type: 'public' }],
      tasks: [{ id: 'qa-work', title: '项目交接工作台 · 验收样例', goal: '把项目背景、关键决定和下一步整理成可查看的工作台。', workspace: '产品团队', agentMode: 'cloudagent', status: 'running', messages: [{ id: 'qa-user', role: 'user', text: '把项目背景、关键决定和下一步整理成可查看的工作台。' }, { id: 'qa-answer', role: 'assistant', text: '已生成《交接工作台.html》。可以直接在右侧查看页面，文件保存在产品团队资料中。\n这是浏览器验收样例，不代表真实云端工作已执行。', source: 'cloudagent', artifacts: [{ id: document.id, name: document.name }], execution: { startedAt: new Date(now - 27000).toISOString(), endedAt: new Date(now).toISOString(), entries: [{ id: 'read', title: '读取项目背景.md', kind: 'read', status: 'completed', startedAt: now - 25000, endedAt: now - 20000 }, { id: 'write', title: '编辑交接工作台.html', kind: 'edit', status: 'completed', startedAt: now - 20000, endedAt: now - 10000 }, { id: 'verify', title: '运行沙箱命令', kind: 'execute', status: 'completed', startedAt: now - 10000, endedAt: now }] } }], agentRun: { status: 'done', steps: 3, startedAt: new Date(now - 27000).toISOString(), endedAt: new Date(now).toISOString() } }]
    };
    await page.evaluateOnNewDocument((data, document, preview) => {
      window.qaData = data; window.qaReply = preview; window.qaPreviewCalls = 0;
      window.gongzuo = { bootstrap: async () => ({ data, settings: { agent: { mode: 'cloudagent' }, hasCloudagentApiKey: true }, agentStatus: { label: '共作 Agent · 验收样例', modelConnected: true } }), listDocuments: async () => [document], listMemories: async () => ({ personal: [], team: [] }), getSettings: async () => ({ agent: { mode: 'cloudagent' }, hasCloudagentApiKey: true }), onDataChanged: cb => { window.qaChanged = cb; }, onOpenTask: () => {}, previewDocument: async () => { window.qaPreviewCalls++; return window.qaReply; }, openDocument: async () => true };
    }, data, document, preview);
    console.log('QA: opening fixture page');
    await page.goto(pathToFileURL(path.join(root, 'demo/index.html')).href);
    console.log('QA: bootstrap', await page.evaluate(() => ({ connected: Boolean(window.qaChanged), title: document.title, preview: Boolean(window.gongzuo) })), errors);
    await page.waitForFunction(() => Boolean(window.qaChanged), { timeout: 5000 });
    await page.evaluate(() => openTask('qa-work'));
    console.log('QA: work opened', await page.evaluate(() => ({ task: state.task, files: state.documents.length, result: state.artifactPreview, body: document.querySelector('.artifact-body')?.innerText })), errors);
    await page.waitForSelector('.artifact-html-frame', { timeout: 5000 });
    assert.match(await page.$eval('.artifact-script-notice', el => el.textContent), /脚本未执行/);
    await page.click('[data-action="toggle-artifact-interactive"]');
    await page.click('[data-action="confirm-artifact-interactive"]');
    const frame = page.frames().find(item => item.parentFrame());
    try { await frame.waitForFunction(() => window.ready && window.networkBlocked, { timeout: 5000 }); await frame.evaluate(() => { window.clicked=false; document.getElementById('count').addEventListener('click',()=>window.clicked=true); }); }
    catch(error) { console.log('HTML frame diagnostics', await frame.evaluate(() => ({ ready: window.ready, networkBlocked: window.networkBlocked, text: document.body?.innerText, meta: document.querySelector('meta[http-equiv]')?.content })), errors); throw error; }
    assert.deepEqual(await frame.evaluate(() => ({ parent: window.parentReadable, storage: window.storageReadable })), { parent: false, storage: false });
    assert.equal(network.length, 0); checks.push('HTML 内联脚本可运行，父页面/IPC与存储不可访问，fetch被CSP阻止');
    // CDP's coordinate click is unreliable across an opaque-origin OOPIF in
    // this driver/browser combination; activate the element in its own frame.
    await frame.$eval('#count',el=>el.click());
    assert.equal(await frame.$eval('#count',el=>el.textContent),'1','隔离页按钮事件实际执行');
    await frame.type('#draft', '预览内的临时备注');
    await page.evaluate(() => { window.savedFrame = document.querySelector('.artifact-html-frame'); window.savedPreview = document.querySelector('.artifact-preview-content'); window.previewOldVersion=window.savedPreview.dataset.previewVersion; });
    await page.click('#thread-input'); await page.type('#thread-input', '请继续优化排版，保留当前内容');
    await page.evaluate(() => { window.qaData.tasks[0].updatedAt = new Date().toISOString(); window.qaChanged(window.qaData); });
    console.log('QA: after refresh', await page.evaluate(() => ({ sameFrame:window.savedFrame===document.querySelector('.artifact-html-frame'),samePreview:window.savedPreview===document.querySelector('.artifact-preview-content'),oldVersion:window.previewOldVersion,newVersion:document.querySelector('.artifact-preview-content').dataset.previewVersion,key:state.artifactInteractiveKey })), await frame.evaluate(() => ({ count:window.count,ready:window.ready })));
    assert.equal(await frame.$eval('#count', el => el.textContent), '1');
    assert.equal(await frame.$eval('#draft', el => el.value), '预览内的临时备注');
    assert.equal(await page.$eval('#thread-input', el => el.value), '请继续优化排版，保留当前内容');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'thread-input');
    assert.equal(await page.evaluate(() => window.qaPreviewCalls), 1); checks.push('后台刷新保留iframe交互、输入焦点/文字，不重复读取文件');
    // Validate the public preview's visual layout, not the generic browser Demo.
    await page.screenshot({ path: path.join(output, '共作-B路径-成果预览.png') });
    await page.click('[data-action="artifact-tab"][data-id="execution"]');
    await page.waitForSelector('.execution-list');
    assert.equal(await page.$$eval('.execution-list li', els => els.length), 3);
    assert.match(await page.$eval('.execution-summary', el => el.textContent), /0:27/);
    await page.screenshot({ path: path.join(output, '共作-B路径-执行过程.png') }); checks.push('执行过程显示3个真实格式步骤和本轮27秒耗时');
    await page.click('[data-action="artifact-tab"][data-id="preview"]');
    await page.evaluate(() => { state.artifactPreview = { key: 'qa-work:' + state.documents[0].id, data: { kind: 'text', text: '<script>window.bad=true</script>\n安全文字' } }; render(); });
    assert.equal(await page.$eval('.artifact-text-wrap pre', el => el.textContent), '<script>window.bad=true</script>\n安全文字');
    assert.equal(await page.evaluate(() => window.bad), undefined); checks.push('文本预览仅显示转义内容，无法执行脚本');
    await page.evaluate(() => { state.artifactPreview = { key: 'qa-work:' + state.documents[0].id, data: { kind: 'unsupported', reason: '暂不支持 Office 内嵌预览' } }; render(); });
    assert.match(await page.$eval('.artifact-empty', el => el.textContent), /用本机应用查看完整成果/); checks.push('Office诚实降级为本机打开');
    await page.evaluate(() => { state.artifactPreview = { key: 'qa-work:' + state.documents[0].id, error: '验收用文件读取失败' }; render(); });
    assert.match(await page.$eval('.artifact-empty', el => el.textContent), /重试预览/); checks.push('读取失败可重试');
    await page.evaluate(() => { state.composerDrafts['thread-input']=''; render(); });
    assert.equal(await page.$eval('#thread-input',el=>el.value),'');checks.push('程序清空草稿同步到已编辑textarea，不残留重复发送文本');
    await page.evaluate(() => { state.documents[0].status = 'archived'; render(); });
    assert.equal(await page.$('.artifact-html-frame'), null); checks.push('归档立即移除旧预览和成果入口');
    await page.setViewport({ width: 980, height: 820 });
    await page.evaluate(() => { state.documents[0].status = 'active'; state.artifactPreview = { key: 'qa-work:' + state.documents[0].id, data: window.qaReply }; render(); });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)); checks.push('980px窗口无横向溢出');
    assert.deepEqual(errors, []); checks.push('全流程无前端异常');
    console.log(JSON.stringify({ passed: true, checks, artifacts: ['共作-B路径-成果预览.png', '共作-B路径-执行过程.png'], note: '真实浏览器 + 隔离测试文件 + 模拟引擎回复；本轮未新建计费沙箱或使用用户凭据' }, null, 2));
  } finally { if (browser) await browser.close(); await fs.rm(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
