const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { StringDecoder } = require('node:string_decoder');
const { JsonStore } = require('./store.cjs');
const { renderPptxAsync } = require('./pptx-preview.cjs');

const allowedExtensions = new Set(['.pdf', '.docx', '.doc', '.txt', '.md', '.csv', '.xlsx', '.xls', '.pptx', '.ppt', '.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.webp']);
const previewFormats = {
  '.txt': { kind: 'text', mime: 'text/plain', limit: 400 * 1024 },
  '.md': { kind: 'text', mime: 'text/markdown', limit: 400 * 1024 },
  '.csv': { kind: 'text', mime: 'text/csv', limit: 400 * 1024 },
  '.html': { kind: 'html', mime: 'text/html', limit: 2 * 1024 * 1024 },
  '.htm': { kind: 'html', mime: 'text/html', limit: 2 * 1024 * 1024 },
  '.png': { kind: 'image', mime: 'image/png', limit: 10 * 1024 * 1024 },
  '.jpg': { kind: 'image', mime: 'image/jpeg', limit: 10 * 1024 * 1024 },
  '.jpeg': { kind: 'image', mime: 'image/jpeg', limit: 10 * 1024 * 1024 },
  '.gif': { kind: 'image', mime: 'image/gif', limit: 10 * 1024 * 1024 },
  '.webp': { kind: 'image', mime: 'image/webp', limit: 10 * 1024 * 1024 },
  '.pptx': { kind: 'slides', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', limit: 25 * 1024 * 1024 },
  '.pdf': { kind: 'pdf', mime: 'application/pdf', limit: 25 * 1024 * 1024 }
};

function matchesPreviewMagic(content, extension) {
  if (extension === '.png') return content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === '.jpg' || extension === '.jpeg') return content.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (extension === '.gif') return ['GIF87a', 'GIF89a'].some(header => content.subarray(0, 6).equals(Buffer.from(header)));
  if (extension === '.webp') return content.length >= 12 && content.subarray(0, 4).equals(Buffer.from('RIFF')) && content.subarray(8, 12).equals(Buffer.from('WEBP'));
  return extension === '.pdf' && content.subarray(0, 5).equals(Buffer.from('%PDF-'));
}
const categories = new Set(['规范', '模板', '项目资料', '其他']);
const maxFileBytes = 25 * 1024 * 1024;
const readableExtensions = new Set(['.txt', '.md', '.csv', '.pdf', '.docx', '.doc']);
const execFileAsync = promisify(execFile);

function normalizeMetadata(input = {}) {
  const category = String(input.category || '其他');
  if (!categories.has(category)) throw new Error('资料分类无效');
  const tags = Array.isArray(input.tags) ? input.tags : [];
  if (tags.length > 8 || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.trim().length > 24)) throw new Error('资料标签无效');
  return { category, tags: [...new Set(tags.map(tag => tag.trim()))] };
}

function normalizeOrigin(origin) {
  const text = (value, max) => (value == null ? null : String(value).slice(0, max));
  return { kind: 'agent', taskId: text(origin.taskId, 100), taskTitle: text(origin.taskTitle, 120), workspace: text(origin.workspace, 80), agent: text(origin.agent, 40), messageId: text(origin.messageId, 100) };
}

function publicDocument(document) {
  const { storedName, ...visible } = document;
  return visible;
}

class DocumentService {
  constructor(indexPath, filesDirectory) {
    this.index = new JsonStore(indexPath, () => ({ items: [] }));
    this.filesDirectory = filesDirectory;
    this.slidePreviewCache = new Map();
  }

  async initialize() { await this.index.initialize(); }

  async list() {
    const data = await this.index.read();
    return data.items.map(publicDocument);
  }

  // origin (optional) records where an Agent-produced file came from, so the
  // personal space can show "来自 产品团队 ·「某项工作」".
  async upload(workspaceId, filePaths, { origin = null, names = [] } = {}) {
    if (!Array.isArray(filePaths) || !filePaths.length || filePaths.length > 10) throw new Error('一次最多上传 10 份资料');
    const newItems = [];
    const copied = [];
    try {
      await fs.mkdir(this.filesDirectory, { recursive: true, mode: 0o700 });
      for (const sourcePath of filePaths) {
        const supplied = names[filePaths.indexOf(sourcePath)];
        const name = typeof supplied === 'string' && supplied.trim() && !/[/\\\0]/.test(supplied) && Buffer.byteLength(supplied) <= 240 ? supplied : path.basename(sourcePath);
        const extension = path.extname(name).toLowerCase();
        if (extension !== path.extname(sourcePath).toLowerCase()) throw new Error('成果文件名称与格式不一致');
        if (!allowedExtensions.has(extension)) throw new Error(`不支持的文件格式：${name}`);
        const stat = await fs.stat(sourcePath);
        if (!stat.isFile() || stat.size > maxFileBytes) throw new Error(`文件过大或不是普通文件：${name}`);
        const id = crypto.randomUUID();
        const storedName = `${id}${extension}`;
        const destination = path.join(this.filesDirectory, storedName);
        await fs.copyFile(sourcePath, destination);
        copied.push(destination);
        await fs.chmod(destination, 0o600);
        newItems.push({ id, workspaceId, name, storedName, size: stat.size, category: '其他', tags: [], status: 'active', ...(origin ? { origin: normalizeOrigin(origin) } : {}), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      }
      await this.index.update(data => { data.items.unshift(...newItems); return data; });
      return newItems.map(publicDocument);
    } catch (error) {
      await Promise.allSettled(copied.map(file => fs.rm(file, { force: true })));
      throw error;
    }
  }

  async update(id, input) {
    const metadata = normalizeMetadata(input);
    let result;
    await this.index.update(data => {
      const item = data.items.find(document => document.id === id && document.status === 'active');
      if (!item) throw new Error('资料不存在');
      Object.assign(item, metadata, { updatedAt: new Date().toISOString() });
      result = publicDocument(item);
      return data;
    });
    return result;
  }

  async setArchived(id, archived) {
    let result;
    await this.index.update(data => {
      const item = data.items.find(document => document.id === id);
      if (!item) throw new Error('资料不存在');
      item.status = archived ? 'archived' : 'active';
      item.updatedAt = new Date().toISOString();
      result = publicDocument(item);
      return data;
    });
    return result;
  }

  async getFilePath(id) {
    const data = await this.index.read();
    const item = data.items.find(document => document.id === id && document.status === 'active');
    if (!item) throw new Error('资料不存在');
    return path.join(this.filesDirectory, item.storedName);
  }

  async preview(id, allowedWorkspaceIds) {
    let data;
    try { data = await this.index.read(); }
    catch { throw new Error('资料索引读取失败'); }
    const allowed = new Set([].concat(allowedWorkspaceIds).filter(value => typeof value === 'string' && value));
    const item = data.items.find(document => document.id === id && document.status === 'active' && allowed.has(document.workspaceId));
    if (!item) throw new Error('资料不存在或不属于允许的空间');
    const storedName = item.storedName;
    if (typeof storedName !== 'string' || !storedName || storedName === '.' || storedName === '..' || /[/\\\0]/.test(storedName) || path.isAbsolute(storedName) || path.win32.isAbsolute(storedName)) throw new Error('资料文件路径无效');
    const name = path.win32.basename(path.basename(String(item.name || '')));
    const extension = path.extname(name).toLowerCase();
    const format = previewFormats[extension];
    const result = { id: item.id, name, kind: format?.kind || 'unsupported', mime: format?.mime || 'application/octet-stream', truncated: false, reason: null };
    const unsupported = reason => ({ ...result, kind: 'unsupported', reason });
    let handle;
    try {
      const directoryStat = await fs.lstat(this.filesDirectory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error();
      const realDirectory = await fs.realpath(this.filesDirectory);
      const filePath = path.join(realDirectory, storedName);
      const entryStat = await fs.lstat(filePath);
      if (!entryStat.isFile() || entryStat.isSymbolicLink()) throw new Error();
      const realFilePath = await fs.realpath(filePath);
      const relative = path.relative(realDirectory, realFilePath);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error();
      // 不跟随读取期间被替换的符号链接，也不阻塞于被替换的管道文件。
      handle = await fs.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== entryStat.dev || stat.ino !== entryStat.ino) throw new Error();
      if (!format) return unsupported('暂不支持此格式的内嵌预览');
      if (format.kind !== 'text' && stat.size > format.limit) return unsupported(`文件超过 ${format.limit / (1024 * 1024)} MB 预览上限`);
      const content = Buffer.alloc(Math.min(stat.size, format.limit));
      let bytesRead = 0;
      while (bytesRead < content.length) {
        const read = await handle.read(content, bytesRead, content.length - bytesRead, bytesRead);
        if (!read.bytesRead) break;
        bytesRead += read.bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || bytesRead !== content.length) throw new Error();
      if (format.kind === 'text' || format.kind === 'html') {
        const truncated = stat.size > format.limit;
        return { ...result, text: new StringDecoder('utf8').write(content), truncated, reason: truncated ? '仅预览前 400 KB 文本' : null };
      }
      if (format.kind === 'slides') {
        if (content.length < 4 || !content.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return unsupported('文件内容与声明格式不符');
        const key = crypto.createHash('sha256').update(content).digest('hex');
        let pending = this.slidePreviewCache.get(key);
        if (!pending) {
          pending = renderPptxAsync(content).then(value => ({ ...result, ...value, pages: value.pages.map(page => ({ title: page.title, dataUrl: `data:image/svg+xml;base64,${Buffer.from(page.svg).toString('base64')}` })) }));
          this.slidePreviewCache.set(key, pending);
          if (this.slidePreviewCache.size > 2) this.slidePreviewCache.delete(this.slidePreviewCache.keys().next().value);
          pending.catch(() => this.slidePreviewCache.delete(key));
        }
        try { return { ...await pending, id: item.id, name }; }
        catch { return unsupported('PPTX 预览生成失败；文件可能损坏、加密或包含未支持的结构'); }
      }
      if (!matchesPreviewMagic(content, extension)) return unsupported('文件内容与声明格式不符');
      return { ...result, dataUrl: `data:${format.mime};base64,${content.toString('base64')}` };
    } catch {
      throw new Error('资料文件不可安全读取');
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async readForAgent(id, workspaceId) {
    const data = await this.index.read();
    const allowed = new Set([].concat(workspaceId).filter(Boolean));
    const item = data.items.find(document => document.id === id && document.status === 'active' && allowed.has(document.workspaceId));
    if (!item) throw new Error('所选资料不存在或不属于当前空间');
    const extension = path.extname(item.name).toLowerCase();
    if (!readableExtensions.has(extension)) throw new Error(`暂不能读取 ${item.name} 的正文；请改用 PDF、Word 或文本文件`);
    const filePath = path.join(this.filesDirectory, item.storedName);
    let text;
    if (['.txt', '.md', '.csv'].includes(extension)) {
      const content = await fs.readFile(filePath);
      text = content.subarray(0, 40000).toString('utf8');
    } else if (extension === '.pdf') {
      const binary = ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext', '/usr/bin/pdftotext'];
      let executable;
      for (const candidate of binary) {
        try { await fs.access(candidate, fs.constants.X_OK); executable = candidate; break; } catch { /* next */ }
      }
      if (!executable) throw new Error('这台 Mac 尚未安装 PDF 文字提取工具，无法引用 PDF 正文');
      const result = await execFileAsync(executable, ['-layout', '-enc', 'UTF-8', filePath, '-'], { timeout: 12000, maxBuffer: 512 * 1024 });
      text = result.stdout;
    } else {
      const result = await execFileAsync('/usr/bin/textutil', ['-convert', 'txt', '-stdout', filePath], { timeout: 12000, maxBuffer: 512 * 1024 });
      text = result.stdout;
    }
    const normalized = String(text || '').trim();
    if (!normalized) throw new Error(`${item.name} 没有可读取的文字；扫描件需要先做 OCR`);
    return { id: item.id, name: item.name, text: normalized.slice(0, 12000), truncated: normalized.length > 12000 };
  }
}

module.exports = { DocumentService, normalizeMetadata, allowedExtensions, readableExtensions };
