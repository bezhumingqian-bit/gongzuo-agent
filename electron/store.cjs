const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const clone = value => JSON.parse(JSON.stringify(value));

class JsonStore {
  constructor(filePath, seedFactory) {
    this.filePath = filePath;
    this.seedFactory = seedFactory;
    this.queue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await this.write(this.seedFactory());
    }
    return this.read();
  }

  async read() {
    const raw = await fs.readFile(this.filePath, 'utf8');
    return JSON.parse(raw);
  }

  async write(value) {
    const tempPath = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tempPath, this.filePath);
    return clone(value);
  }

  async update(mutator) {
    const operation = this.queue.then(async () => {
      const current = await this.read();
      const next = await mutator(clone(current));
      return this.write(next);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}

module.exports = { JsonStore };
