const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { JsonStore } = require('./store.cjs');

const allowedExtensions = new Set(['.pdf', '.docx', '.doc', '.txt', '.md', '.csv', '.xlsx', '.xls', '.pptx', '.ppt']);
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

function publicDocument(document) {
  const { storedName, ...visible } = document;
  return visible;
}

class DocumentService {
  constructor(indexPath, filesDirectory) {
    this.index = new JsonStore(indexPath, () => ({ items: [] }));
    this.filesDirectory = filesDirectory;
  }

  async initialize() { await this.index.initialize(); }

  async list() {
    const data = await this.index.read();
    return data.items.map(publicDocument);
  }

  async upload(workspaceId, filePaths) {
    if (!Array.isArray(filePaths) || !filePaths.length || filePaths.length > 10) throw new Error('一次最多上传 10 份资料');
    const newItems = [];
    const copied = [];
    try {
      await fs.mkdir(this.filesDirectory, { recursive: true, mode: 0o700 });
      for (const sourcePath of filePaths) {
        const name = path.basename(sourcePath);
        const extension = path.extname(name).toLowerCase();
        if (!allowedExtensions.has(extension)) throw new Error(`不支持的文件格式：${name}`);
        const stat = await fs.stat(sourcePath);
        if (!stat.isFile() || stat.size > maxFileBytes) throw new Error(`文件过大或不是普通文件：${name}`);
        const id = crypto.randomUUID();
        const storedName = `${id}${extension}`;
        const destination = path.join(this.filesDirectory, storedName);
        await fs.copyFile(sourcePath, destination);
        copied.push(destination);
        await fs.chmod(destination, 0o600);
        newItems.push({ id, workspaceId, name, storedName, size: stat.size, category: '其他', tags: [], status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
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
