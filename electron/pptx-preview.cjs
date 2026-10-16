// Local, read-only PPTX content preview. No Office process, network, macros,
// external relationships or embedded programs are executed. This is a static
// DrawingML preview, not an Office editing/rendering engine.
const zlib = require('node:zlib');
const path = require('node:path').posix;
const MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const LIMIT = 40 * 1024 * 1024;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (v, fallback = 0) => Number.isFinite(Number(v)) ? Math.max(-100000000, Math.min(100000000, Number(v))) : fallback;
const px = v => num(v) / 9525;
const attr = (n, key, fallback = '') => n?.a?.[key] ?? fallback;
const child = (n, name) => n?.c?.find(c => c.n === name) || null;
const children = (n, name) => (n?.c || []).filter(c => c.n === name);
function all(n, name) { const found = []; const visit = node => { if (node.n === name) found.push(node); for (const c of node.c || []) visit(c); }; if (n) visit(n); return found; }
function text(n) { return n ? n.t + n.c.map(text).join('') : ''; }
function entity(s) {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(s)) throw new Error('PPTX XML 包含无效实体');
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_, e) => {
    if (e[0] !== '#') return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e];
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error('PPTX XML 包含无效字符');
    return String.fromCodePoint(code);
  });
}
function xml(source) {
  if (source.length > 8 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('PPTX XML 超限或包含外部声明');
  const root = { n: '$', a: {}, c: [], t: '' }, stack = [root];
  const tokens = source.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g) || [];
  if (tokens.join('') !== source) throw new Error('PPTX XML 不完整');
  let count = 0;
  for (const token of tokens) {
    const top = stack.at(-1);
    if (token.startsWith('<?') || token.startsWith('<!--')) continue;
    if (token.startsWith('<![CDATA[')) { top.t += token.slice(9, -3); continue; }
    if (token.startsWith('</')) {
      if (stack.length < 2 || token.slice(2, -1).trim() !== top.tag) throw new Error('PPTX XML 结构无效');
      stack.pop(); continue;
    }
    if (token.startsWith('<')) {
      const m = /^<([A-Za-z_][\w.:-]*)([\s\S]*?)\/?\s*>$/.exec(token);
      if (!m || ++count > 100000 || stack.length > 64) throw new Error('PPTX XML 结构超限');
      const a = {}, attrs = m[2].replace(/\/$/, '');
      const rest = attrs.replace(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_, k, v, v2) => { a[k] = entity(v ?? v2); return ''; });
      if (rest.trim()) throw new Error('PPTX XML 属性无效');
      const node = { n: m[1].split(':').pop(), tag: m[1], a, c: [], t: '' }; top.c.push(node);
      if (!/\/\s*>$/.test(token)) stack.push(node);
    } else top.t += entity(token);
  }
  if (stack.length !== 1 || root.c.length !== 1) throw new Error('PPTX XML 未闭合');
  return root.c[0];
}
function zip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 25 * 1024 * 1024 || buffer.length < 22) throw new Error('PPTX 文件无效或超过 25 MB');
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { eocd = i; break; }
  }
  if (eocd < 0 || buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6)) throw new Error('不支持此 PPTX 压缩格式');
  const count = buffer.readUInt16LE(eocd + 10), start = buffer.readUInt32LE(eocd + 16), size = buffer.readUInt32LE(eocd + 12);
  if (count > 2000 || count === 65535 || start + size > eocd || buffer.readUInt16LE(eocd + 8) !== count) throw new Error('PPTX 压缩包超限');
  const entries = new Map(); let offset = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > start + size || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('PPTX 压缩目录无效');
    const flags = buffer.readUInt16LE(offset + 8), method = buffer.readUInt16LE(offset + 10), packed = buffer.readUInt32LE(offset + 20), bytes = buffer.readUInt32LE(offset + 24);
    const nl = buffer.readUInt16LE(offset + 28), ex = buffer.readUInt16LE(offset + 30), comment = buffer.readUInt16LE(offset + 32), local = buffer.readUInt32LE(offset + 42);
    if (offset + 46 + nl + ex + comment > start + size) throw new Error('PPTX 压缩目录越界');
    const name = buffer.subarray(offset + 46, offset + 46 + nl).toString('utf8');
    if (flags & 1 || ![0, 8].includes(method) || bytes > 25 * 1024 * 1024 || packed === 0xffffffff || local === 0xffffffff || (total += bytes) > 80 * 1024 * 1024) throw new Error('PPTX 解压超限或已加密');
    if (name.includes('\\') || name.includes('\0') || name.startsWith('/') || path.normalize(name).replace(/\/$/, '') !== name.replace(/\/$/, '') || name.startsWith('../') || entries.has(name)) throw new Error('PPTX 包内路径无效');
    if (local + 30 > start || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('PPTX 条目无效');
    const ln = buffer.readUInt16LE(local + 26), le = buffer.readUInt16LE(local + 28), data = local + 30 + ln + le;
    if (data + packed > start || buffer.subarray(local + 30, local + 30 + ln).toString('utf8') !== name || buffer.readUInt16LE(local + 8) !== method) throw new Error('PPTX 条目越界');
    entries.set(name, { method, packed, bytes, data }); offset += 46 + nl + ex + comment;
  }
  const cache = new Map();
  return { has: n => entries.has(n), read(n) {
    if (cache.has(n)) return cache.get(n);
    const e = entries.get(n); if (!e) throw new Error('PPTX 引用的页面或资源不存在');
    const data = buffer.subarray(e.data, e.data + e.packed);
    const b = e.method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, e.bytes) });
    if (b.length !== e.bytes) throw new Error('PPTX 条目大小不符'); cache.set(n, b); return b;
  }, parse(n) { const b = this.read(n); if (b.length > 8 * 1024 * 1024) throw new Error('PPTX XML 过大'); return xml(b.toString('utf8')); } };
}
function relationships(pack, owner) {
  const rp = path.join(path.dirname(owner), '_rels', path.basename(owner) + '.rels');
  if (!pack.has(rp)) return new Map();
  const result = new Map();
  for (const r of children(pack.parse(rp), 'Relationship')) {
    if (attr(r, 'TargetMode') === 'External') continue;
    const target = attr(r, 'Target');
    if (!target || /[\\\0?#]|^[a-z]+:/i.test(target)) continue;
    // A package-root /ppt/... target is not a filesystem path.
    const dest = path.normalize(target.startsWith('/') ? target.slice(1) : path.join(path.dirname(owner), target));
    if (dest.startsWith('../')) continue;
    result.set(attr(r, 'Id'), { path: dest, type: attr(r, 'Type').split('/').pop() });
  }
  return result;
}
function themeOf(doc) {
  const colors = { bg1: 'FFFFFF', tx1: '000000', bg2: 'EEECE1', tx2: '1F497D', dk1: '000000', lt1: 'FFFFFF', accent1: '4472C4', accent2: 'ED7D31', accent3: 'A5A5A5', accent4: 'FFC000', accent5: '5B9BD5', accent6: '70AD47' };
  const scheme = all(doc, 'clrScheme')[0];
  for (const n of scheme?.c || []) colors[n.n] = attr(n.c[0], 'val', attr(n.c[0], 'lastClr', colors[n.n]));
  colors.bg1 = colors.lt1; colors.tx1 = colors.dk1; colors.bg2 = colors.lt2 || colors.bg2; colors.tx2 = colors.dk2 || colors.tx2;
  return colors;
}
function color(n, theme, fallback = '#000000') {
  const c = n?.c?.find(c => ['srgbClr', 'schemeClr', 'sysClr'].includes(c.n));
  let hex = c?.n === 'schemeClr' ? theme[attr(c, 'val')] : attr(c, 'lastClr', attr(c, 'val'));
  if (!/^[\da-f]{6}$/i.test(hex || '')) return fallback;
  let rgb = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
  for (const t of c.c) { const v = num(attr(t, 'val')) / 100000; if (t.n === 'tint') rgb = rgb.map(x => x + (255 - x) * v); if (t.n === 'shade') rgb = rgb.map(x => x * v); if (t.n === 'lumMod') rgb = rgb.map(x => x * v); if (t.n === 'lumOff') rgb = rgb.map(x => x + 255 * v); }
  const alpha = child(c, 'alpha');
  return `rgba(${rgb.map(x => Math.max(0, Math.min(255, Math.round(x)))).join(',')},${alpha ? Math.max(0, Math.min(1, num(attr(alpha, 'val')) / 100000)) : 1})`;
}
function fill(n, ctx, fallback = 'none') {
  if (child(n, 'noFill')) return 'none';
  if (child(n, 'solidFill')) return color(child(n, 'solidFill'), ctx.theme, fallback);
  const gradient = child(n, 'gradFill');
  if (gradient) {
    const stops = children(child(gradient, 'gsLst'), 'gs'); const id = `g${ctx.next++}`;
    const angle = num(attr(child(gradient, 'lin'), 'ang')) / 60000 * Math.PI / 180;
    ctx.defs.push(`<linearGradient id="${id}" x1="0" y1="0" x2="${Math.cos(angle)}" y2="${Math.sin(angle)}">${stops.map(s => `<stop offset="${num(attr(s, 'pos')) / 100000}" stop-color="${esc(color(s, ctx.theme))}"/>`).join('')}</linearGradient>`);
    return `url(#${id})`;
  }
  return fallback;
}
function box(n) {
  const off = child(n, 'off'), ext = child(n, 'ext');
  return { x: px(attr(off, 'x')), y: px(attr(off, 'y')), w: Math.max(0, px(attr(ext, 'cx'))), h: Math.max(0, px(attr(ext, 'cy'))), rot: num(attr(n, 'rot')) / 60000, flipH: attr(n, 'flipH') === '1', flipV: attr(n, 'flipV') === '1' };
}
function transform(b) { return `translate(${b.x} ${b.y}) translate(${b.w / 2} ${b.h / 2}) rotate(${b.rot}) scale(${b.flipH ? -1 : 1} ${b.flipV ? -1 : 1}) translate(${-b.w / 2} ${-b.h / 2})`; }
function cssFont(value) { return String(value || 'Arial').replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 80) || 'Arial'; }
function textbox(body, b, ctx, inherited = null, inset = null) {
  if (!body) return '';
  const bp = child(body, 'bodyPr');
  const para = children(body, 'p');
  const defaultR = child(child(inherited, 'lvl1pPr'), 'defRPr');
  const html = para.map(p => {
    const pp = child(p, 'pPr'); const rp = child(pp, 'defRPr') || defaultR; const end = child(p, 'endParaRPr');
    const bullet = child(pp, 'buChar'), auto = child(pp, 'buAutoNum');
    const line = child(pp, 'lnSpc');
    const ls = child(line, 'spcPts') ? `${num(attr(child(line, 'spcPts'), 'val')) / 100 * 4 / 3}px` : child(line, 'spcPct') ? `${num(attr(child(line, 'spcPct'), 'val')) / 100000}` : '1.2';
    const content = (p.c || []).filter(r => ['r', 'fld', 'br'].includes(r.n)).map(r => {
      if (r.n === 'br') return '<br/>';
      const rpr = child(r, 'rPr'); const size = Math.max(1, Math.min(250, num(attr(rpr, 'sz', attr(rp, 'sz', attr(end, 'sz', 1800))), 1800) / 100 * 4 / 3));
      const font = cssFont(attr(child(rpr, 'ea'), 'typeface', attr(child(rpr, 'latin'), 'typeface', attr(child(rp, 'latin'), 'typeface', 'Arial'))));
      const c = color(child(rpr, 'solidFill') || child(rp, 'solidFill'), ctx.theme, '#202020');
      return `<span style="font-size:${size}px;font-family:${esc(font)},Arial,'PingFang SC',sans-serif;color:${esc(c)};font-weight:${attr(rpr, 'b', attr(rp, 'b')) === '1' ? 700 : 400};font-style:${attr(rpr, 'i', attr(rp, 'i')) === '1' ? 'italic' : 'normal'};text-decoration:${attr(rpr, 'u') && attr(rpr, 'u') !== 'none' ? 'underline' : 'none'}">${esc(text(child(r, 't')))}</span>`;
    }).join('');
    const align = ({ ctr: 'center', r: 'right', just: 'justify' })[attr(pp, 'algn')] || 'left';
    const before = num(attr(child(child(pp, 'spcBef'), 'spcPts'), 'val')) / 75;
    const after = num(attr(child(child(pp, 'spcAft'), 'spcPts'), 'val')) / 75;
    return `<div style="text-align:${align};line-height:${ls};margin:${before}px 0 ${after}px;white-space:pre-wrap;overflow-wrap:break-word">${bullet ? esc(attr(bullet, 'char')) + ' ' : auto ? '• ' : ''}${content || '<br/>'}</div>`;
  }).join('');
  const x = inset ? px(attr(inset, 'marL', 91440)) : px(attr(bp, 'lIns', 91440));
  const y = inset ? px(attr(inset, 'marT', 45720)) : px(attr(bp, 'tIns', 45720));
  const right = inset ? px(attr(inset, 'marR', 91440)) : px(attr(bp, 'rIns', 91440));
  const bottom = inset ? px(attr(inset, 'marB', 45720)) : px(attr(bp, 'bIns', 45720));
  const alignV = attr(inset || bp, 'anchor');
  const align = alignV === 'ctr' ? 'center' : alignV === 'b' ? 'flex-end' : 'flex-start';
  const w = Math.max(0, b.w - x - right), h = Math.max(0, b.h - y - bottom);
  return `<foreignObject x="${x}" y="${y}" width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;display:flex;flex-direction:column;justify-content:${align};overflow:hidden">${html}</div></foreignObject>`;
}
function chart(doc, b, ctx) {
  const plot = all(doc, 'plotArea')[0], type = plot?.c?.find(n => /Chart$/.test(n.n));
  const series = children(type, 'ser');
  if (!type || !['barChart', 'lineChart'].includes(type.n) || !series.length || child(type, 'grouping') && attr(child(type, 'grouping'), 'val') === 'stacked') { ctx.warn.add('部分图表类型仅显示提示'); return `<text x="10" y="30" font-size="18" fill="#66717e">该图表暂不支持静态预览</text>`; }
  const points = n => all(n, 'pt').sort((a, b) => num(attr(a, 'idx')) - num(attr(b, 'idx'))).map(p => text(child(p, 'v'))).slice(0, 100);
  const cats = points(child(series[0], 'cat')); const values = series.map(s => points(child(s, 'val')).map(v => num(v)));
  const n = Math.max(...values.map(v => v.length));
  if (!n || n > 100 || series.length > 20) return '';
  const title = all(child(all(doc, 'chart')[0], 'title'), 't').map(text).join('');
  const min = Math.min(0, ...values.flat()), max = Math.max(1, ...values.flat());
  const left = 48, top = title ? 40 : 12, right = 15, bottom = 35;
  const cw = Math.max(10, b.w - left - right), ch = Math.max(10, b.h - top - bottom);
  const yy = v => top + (max - v) / (max - min) * ch; let svg = title ? `<text x="${b.w / 2}" y="22" text-anchor="middle" font-size="17" fill="#222">${esc(title)}</text>` : '';
  for (let i = 0; i <= 4; i++) { const value = min + (max - min) * i / 4; svg += `<line x1="${left}" x2="${left + cw}" y1="${yy(value)}" y2="${yy(value)}" stroke="#d9dfe5"/><text x="${left - 7}" y="${yy(value) + 4}" text-anchor="end" font-size="12" fill="#63717e">${esc(Math.round(value * 10) / 10)}</text>`; }
  svg += `<line x1="${left}" x2="${left + cw}" y1="${yy(0)}" y2="${yy(0)}" stroke="#758492"/>`;
  const gap = cw / n;
  series.forEach((s, k) => {
    const c = fill(child(s, 'spPr'), ctx, color({ c: [{ n: 'schemeClr', a: { val: `accent${k % 6 + 1}` }, c: [] }] }, ctx.theme, '#1c7293'));
    if (type.n === 'lineChart') svg += `<polyline fill="none" stroke="${esc(c)}" stroke-width="2" points="${values[k].map((v, i) => `${left + (i + .5) * gap},${yy(v)}`).join(' ')}"/>`;
    else { const bw = gap * .65 / series.length; values[k].forEach((v, i) => { svg += `<rect x="${left + i * gap + gap * .175 + k * bw}" y="${Math.min(yy(v), yy(0))}" width="${bw}" height="${Math.abs(yy(v) - yy(0))}" fill="${esc(c)}"/>`; }); }
  });
  cats.forEach((c, i) => { svg += `<text x="${left + (i + .5) * gap}" y="${top + ch + 20}" text-anchor="middle" font-size="13" fill="#63717e">${esc(c)}</text>`; });
  ctx.warn.add('图表按文件缓存数据静态展示，样式可能略有差异'); return svg;
}
function table(tbl, b, ctx) {
  const cols = children(child(tbl, 'tblGrid'), 'gridCol').map(c => px(attr(c, 'w'))); let y = 0, svg = '';
  for (const row of children(tbl, 'tr')) { const h = px(attr(row, 'h')); let x = 0, col = 0;
    for (const cell of children(row, 'tc')) { const span = Math.max(1, Math.min(cols.length, num(attr(cell, 'gridSpan'), 1))); const w = cols.slice(col, col + span).reduce((s, v) => s + v, 0); col += span;
      const pr = child(cell, 'tcPr'); if (attr(cell, 'hMerge') !== '1' && attr(cell, 'vMerge') !== '1') svg += `<g transform="translate(${x} ${y})"><rect width="${w}" height="${h}" fill="${esc(fill(pr, ctx, '#ffffff'))}" stroke="${esc(color(child(child(pr, 'lnL'), 'solidFill'), ctx.theme, '#dbe2e8'))}" stroke-width="1"/>${textbox(child(cell, 'txBody'), { w, h }, ctx, null, pr)}</g>`;
      x += w;
    } y += h;
  } return svg;
}
function nodes(tree, ctx, rels, pack, placeholderLookup = null, inherited = false) {
  let result = '';
  for (const n of tree?.c || []) {
    if (!['sp', 'pic', 'cxnSp', 'graphicFrame', 'grpSp'].includes(n.n)) continue;
    const ph = all(n, 'ph')[0]; if (inherited && ph) continue;
    if (n.n === 'grpSp') {
      const xf = child(child(n, 'grpSpPr'), 'xfrm'), b = box(xf), off = child(xf, 'chOff'), ex = child(xf, 'chExt');
      const sx = px(attr(ex, 'cx')) ? b.w / px(attr(ex, 'cx')) : 1, sy = px(attr(ex, 'cy')) ? b.h / px(attr(ex, 'cy')) : 1;
      result += `<g transform="${transform(b)} scale(${sx} ${sy}) translate(${-px(attr(off, 'x'))} ${-px(attr(off, 'y'))})">${nodes(n, ctx, rels, pack)}</g>`; continue;
    }
    const pr = child(n, 'spPr');
    const fallback = ph && placeholderLookup?.get(attr(ph, 'idx', '0'));
    const xf = child(pr, 'xfrm') || child(n, 'xfrm') || child(child(fallback, 'spPr'), 'xfrm');
    if (!xf) { ctx.warn.add('部分继承版式对象未显示'); continue; }
    const b = box(xf); if (!b.w && !b.h) continue;
    let content = '';
    if (n.n === 'pic') {
      const blip = child(child(n, 'blipFill'), 'blip'), link = rels.get(attr(blip, 'r:embed'));
      const imagePath = link?.path || ''; const ext = path.extname(imagePath).toLowerCase(); const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' })[ext];
      if (mime && pack.has(imagePath)) { const data = pack.read(imagePath); if (data.length <= 10 * 1024 * 1024) content = `<image width="${b.w}" height="${b.h}" preserveAspectRatio="none" href="data:${mime};base64,${data.toString('base64')}"/>`; }
      if (!content) ctx.warn.add('部分图片或媒体格式未显示');
      if (child(child(n, 'blipFill'), 'srcRect')) ctx.warn.add('裁剪图片可能存在显示差异');
    } else if (n.n === 'graphicFrame') {
      const gd = child(child(n, 'graphic'), 'graphicData'); const tbl = child(gd, 'tbl'), c = child(gd, 'chart');
      if (tbl) content = table(tbl, b, ctx);
      else if (c) { const link = rels.get(attr(c, 'r:id')); if (link && pack.has(link.path)) content = chart(pack.parse(link.path), b, ctx); }
      else ctx.warn.add('SmartArt、媒体等复杂对象暂不显示');
    } else {
      const geometry = attr(child(pr, 'prstGeom'), 'prst', 'rect'), ln = child(pr, 'ln');
      const f = fill(pr, ctx), stroke = fill(ln, ctx, 'none'), sw = Math.max(.1, px(attr(ln, 'w', 9525)));
      const common = `fill="${esc(f)}" stroke="${esc(stroke)}" stroke-width="${sw}"`;
      if (geometry === 'ellipse') content = `<ellipse cx="${b.w / 2}" cy="${b.h / 2}" rx="${b.w / 2}" ry="${b.h / 2}" ${common}/>`;
      else if (geometry === 'line' || n.n === 'cxnSp') content = `<line x1="0" y1="0" x2="${b.w}" y2="${b.h}" stroke="${esc(stroke === 'none' ? '#777' : stroke)}" stroke-width="${sw}"/>`;
      else if (geometry === 'triangle') content = `<polygon points="${b.w / 2},0 ${b.w},${b.h} 0,${b.h}" ${common}/>`;
      else { if (!['rect', 'roundRect'].includes(geometry) || child(pr, 'custGeom')) ctx.warn.add('部分特殊形状使用矩形近似显示'); content = `<rect width="${b.w}" height="${b.h}" rx="${geometry === 'roundRect' ? Math.min(b.w, b.h) * .08 : 0}" ${common}/>`; }
      const body = child(n, 'txBody') || child(fallback, 'txBody'); content += textbox(body, b, ctx, child(child(fallback, 'txBody'), 'lstStyle'));
      if (child(pr, 'effectLst') || child(pr, 'effectDag')) ctx.warn.add('阴影和特效可能存在显示差异');
    }
    result += `<g transform="${transform(b)}">${content}</g>`;
    if (result.length > LIMIT) throw new Error('PPTX 页面预览超限');
  } return result;
}
function renderPptx(buffer) {
  const pack = zip(buffer), presentation = pack.parse('ppt/presentation.xml'), rels = relationships(pack, 'ppt/presentation.xml');
  const size = child(presentation, 'sldSz'), width = px(attr(size, 'cx', 12192000)), height = px(attr(size, 'cy', 6858000));
  if (width < 10 || height < 10 || width > 10000 || height > 10000) throw new Error('PPTX 页面尺寸无效');
  const ids = children(child(presentation, 'sldIdLst'), 'sldId'); if (!ids.length || ids.length > 80) throw new Error('PPTX 预览仅支持 1–80 页');
  const warnings = new Set(), pages = []; let total = 0;
  for (const id of ids) {
    const link = rels.get(attr(id, 'r:id')); if (!link || link.type !== 'slide') throw new Error('PPTX 页面关系无效');
    const doc = pack.parse(link.path), sr = relationships(pack, link.path);
    const layoutPath = [...sr.values()].find(r => r.type === 'slideLayout')?.path;
    const layout = layoutPath && pack.has(layoutPath) ? pack.parse(layoutPath) : null;
    const lr = layout ? relationships(pack, layoutPath) : new Map(); const masterPath = [...lr.values()].find(r => r.type === 'slideMaster')?.path;
    const master = masterPath && pack.has(masterPath) ? pack.parse(masterPath) : null; const mr = master ? relationships(pack, masterPath) : new Map();
    const themePath = [...mr.values()].find(r => r.type === 'theme')?.path;
    const theme = themeOf(themePath && pack.has(themePath) ? pack.parse(themePath) : null);
    const ctx = { theme, defs: [], next: 0, warn: warnings };
    const cs = child(doc, 'cSld'), lc = child(layout, 'cSld'), mc = child(master, 'cSld');
    const lookup = new Map(); for (const n of child(lc, 'spTree')?.c || []) { const ph = all(n, 'ph')[0]; if (ph) lookup.set(attr(ph, 'idx', '0'), n); }
    const bg = child(child(cs, 'bg'), 'bgPr') || child(child(lc, 'bg'), 'bgPr') || child(child(mc, 'bg'), 'bgPr');
    const background = fill(bg, ctx, '#ffffff');
    const inherited = attr(doc, 'showMasterSp', '1') !== '0' ? nodes(child(mc, 'spTree'), ctx, mr, pack, null, true) + nodes(child(lc, 'spTree'), ctx, lr, pack, null, true) : '';
    const content = nodes(child(cs, 'spTree'), ctx, sr, pack, lookup);
    const title = all(cs, 't').map(text).find(t => t.trim()) || `第 ${pages.length + 1} 页`;
    if (all(doc, 'timing').length || all(doc, 'transition').length) warnings.add('预览为静态页面，不播放动画或视频');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"><title>${esc(title)}</title><defs>${ctx.defs.join('')}</defs><rect width="${width}" height="${height}" fill="${esc(background)}"/>${inherited}${content}</svg>`;
    total += Buffer.byteLength(svg); if (total > LIMIT) throw new Error('PPTX 预览总大小超限');
    pages.push({ title: title.slice(0, 120), svg });
  }
  return { kind: 'slides', mime: MIME, width, height, pages, warnings: [...warnings] };
}
// Heavy parsing is isolated from the Electron UI thread and bounded in time.
function renderPptxAsync(buffer) {
  const { Worker } = require('node:worker_threads');
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { buffer }, resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32 } });
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); worker.terminate().catch(() => {}); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('PPTX 预览超时')), 30000);
    worker.once('message', value => value.error ? finish(new Error(value.error)) : finish(null, value.result));
    worker.once('error', error => finish(error));
    worker.once('exit', () => { if (!settled) finish(new Error('PPTX 预览进程中断')); });
  });
}
const { isMainThread, workerData, parentPort } = require('node:worker_threads');
if (!isMainThread && workerData?.buffer) {
  try { parentPort.postMessage({ result: renderPptx(Buffer.from(workerData.buffer)) }); }
  catch { parentPort.postMessage({ error: 'PPTX 文件无效、已加密或超过预览限制' }); }
}
module.exports = { renderPptx, renderPptxAsync };
