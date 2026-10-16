const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { renderPptx, renderPptxAsync } = require('../electron/pptx-preview.cjs');
const { DocumentService } = require('../electron/document-service.cjs');

function crc(b) { let c = 0xffffffff; for (const byte of b) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function archive(files) {
  const locals = [], central = []; let offset = 0;
  for (const [name, xml] of Object.entries(files)) {
    const n = Buffer.from(name), b = Buffer.from(xml), h = Buffer.alloc(30), ch = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc(b), 14); h.writeUInt32LE(b.length, 18); h.writeUInt32LE(b.length, 22); h.writeUInt16LE(n.length, 26);
    ch.writeUInt32LE(0x02014b50); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc(b), 16); ch.writeUInt32LE(b.length, 20); ch.writeUInt32LE(b.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(h, n, b); central.push(ch, n); offset += h.length + n.length + b.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const slide = (title, extra = '') => `<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="95250" y="190500"/><a:ext cx="9144000" cy="914400"/></a:xfrm><a:prstGeom prst="rect"/><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="2400"/><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>${extra}</p:spTree></p:cSld></p:sld>`;
function fixture(overrides = {}) { return archive({
  'ppt/presentation.xml': '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="s2"/><p:sldId r:id="s1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>',
  'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="s1" Type="http://r/slide" Target="slides/slide1.xml"/><Relationship Id="s2" Type="http://r/slide" Target="/ppt/slides/slide2.xml"/></Relationships>',
  'ppt/slides/slide1.xml': slide('第一页'), 'ppt/slides/slide2.xml': slide('第二页'), ...overrides
}); }

test('页面顺序来自 presentation 关系，内容直接渲染，不用本机Office应用', () => {
  const value = renderPptx(fixture());
  assert.equal(value.kind, 'slides'); assert.equal(value.pages.length, 2);
  assert.equal(value.width, 1280); assert.equal(value.height, 720);
  assert.deepEqual(value.pages.map(p => p.title), ['第二页', '第一页']);
  assert.match(value.pages[0].svg, /第二页/); assert.match(value.pages[0].svg, /foreignObject/);
});
test('Worker异步预览与同步结果一致', async () => { assert.deepEqual(await renderPptxAsync(fixture()), renderPptx(fixture())); });
test('文字与CSS属性不能注入脚本，不跟随外部图片关系', () => {
  const image = '<p:pic><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm></p:spPr><p:blipFill><a:blip r:embed="image"/></p:blipFill></p:pic>';
  const value = renderPptx(fixture({ 'ppt/slides/slide2.xml': slide('&lt;script&gt;alert(1)&lt;/script&gt;', image), 'ppt/slides/_rels/slide2.xml.rels': '<Relationships><Relationship Id="image" TargetMode="External" Target="https://evil.test/image.png" Type="http://r/image"/></Relationships>' }));
  assert.ok(!value.pages[0].svg.includes('<script>')); assert.ok(!value.pages[0].svg.includes('evil.test'));
  assert.match(value.pages[0].svg, /&lt;script&gt;/); assert.ok(value.warnings.length);
});
test('拒绝DTD/外部实体/未闭合XML/空PPT/路径穿越', () => {
  assert.throws(() => renderPptx(fixture({ 'ppt/slides/slide1.xml': '<!DOCTYPE p [<!ENTITY x SYSTEM "file:///secret">]>' + slide('&x;') })), /外部声明/);
  assert.throws(() => renderPptx(fixture({ 'ppt/slides/slide1.xml': '<p:sld>' })), /未闭合/);
  assert.throws(() => renderPptx(Buffer.alloc(0)), /无效/);
  assert.throws(() => renderPptx(fixture({ '../secret': 'x' })), /路径/);
});
test('拒绝过多页面、压缩炸弹声明、加密ZIP', () => {
  const presentation = '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>' + '<p:sldId r:id="s1"/>'.repeat(81) + '</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>';
  assert.throws(() => renderPptx(fixture({ 'ppt/presentation.xml': presentation })), /80 页/);
  const b = fixture(), offset = b.readUInt32LE(b.length - 6); b.writeUInt32LE(90 * 1024 * 1024, offset + 24); assert.throws(() => renderPptx(b), /超限/);
  const e = fixture(), eo = e.readUInt32LE(e.length - 6); e.writeUInt16LE(1, eo + 8); assert.throws(() => renderPptx(e), /加密/);
});
test('表格正文被渲染，动画明确标为静态', () => {
  const table = '<p:graphicFrame><p:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tblGrid><a:gridCol w="914400"/></a:tblGrid><a:tr h="914400"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>表格单元格</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
  const value = renderPptx(fixture({ 'ppt/slides/slide2.xml': slide('表格', table).replace('</p:sld>', '<p:timing/></p:sld>') }));
  assert.match(value.pages[0].svg, /表格单元格/); assert.ok(value.warnings.some(w => w.includes('静态')));
});
test('DocumentService保持权限、安全读取和源文件不变，PPT缓存复用', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gongzuo-ppt-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, '样例.pptx'), bytes = fixture(); await fs.writeFile(input, bytes);
  const service = new DocumentService(path.join(dir, 'index.json'), path.join(dir, 'files')); await service.initialize();
  const [doc] = await service.upload('personal', [input]);
  await assert.rejects(service.preview(doc.id, ['team']), /不属于/);
  const p = await service.preview(doc.id, ['personal']); assert.equal(p.kind, 'slides'); assert.equal(p.pages.length, 2);
  assert.match(p.pages[0].dataUrl, /^data:image\/svg\+xml;base64,/);
  assert.equal(service.slidePreviewCache.size, 1);
  assert.deepEqual(await service.preview(doc.id, ['personal']), p);
  assert.deepEqual(await fs.readFile(input), bytes);
  const invalid = path.join(dir, 'invalid.pptx'); await fs.writeFile(invalid, 'invalid'); const [bad] = await service.upload('personal', [invalid]);
  assert.equal((await service.preview(bad.id, ['personal'])).kind, 'unsupported');
});
test('页面UI有直接预览、翻页和缩放，失败或加载时不要求先打开外部应用', async () => {
  const source = await fs.readFile(path.join(__dirname, '../demo/app.js'), 'utf8');
  const start = source.indexOf('function previewContent('), end = source.indexOf('function executionContent(', start);
  const context = vm.createContext({ state: { task: 't', pptPreviewPage: 0, pptPreviewZoom: 1 }, safe: s => String(s).replace(/[&<>"']/g, v => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[v]) });
  vm.runInContext(source.slice(start, end), context);
  const p = renderPptx(fixture()), pages = p.pages.map(p => ({ title: p.title, dataUrl: 'data:image/svg+xml;base64,' + Buffer.from(p.svg).toString('base64') })); context.file = { id: 'd', name: '样例.pptx' }; context.preview = { key: 't:d', data: { ...p, pages } };
  const html = vm.runInContext('previewContent(file,preview)', context); assert.match(html, /第 1 \/ 2 页/); assert.match(html, /data-action="ppt-page"/); assert.match(html, /data-action="ppt-zoom"/); assert.match(html, /<img src="data:image\/svg/); assert.ok(!html.includes('用本机应用'));
  context.state.pptPreviewPage = 1; context.state.pptPreviewZoom = 1.5;
  assert.match(vm.runInContext('previewContent(file,preview)', context), /第 2 \/ 2 页/); assert.match(vm.runInContext('previewContent(file,preview)', context), /width:150%/);
  context.preview.loading = true; assert.match(vm.runInContext('previewContent(file,preview)', context), /正在生成 PPT 预览/);
});
