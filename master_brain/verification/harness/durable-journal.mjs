import { appendFile, open, readFile, rm, unlink } from 'node:fs/promises';

export class DurableJournal {
  constructor({path}) {
    if (!path) throw new TypeError('path is required');
    this.path = path;
    this.closed = false;
    this.index = new Set();
    this._queue = Promise.resolve();
  }
  async _ensureOpen() { if (this.closed) throw new Error('journal is closed'); }
  async _acquireFileLock() {
    const lockPath = this.path + '.lock';
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const handle = await open(lockPath, 'wx');
        return async () => { await handle.close(); await unlink(lockPath).catch(() => {}); };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    throw new Error('journal lock acquisition timed out');
  }
  async _load() {
    await this._ensureOpen();
    try {
      const raw = await readFile(this.path, 'utf8');
      if (raw.length > 0 && !raw.endsWith('\\n')) throw new Error('journal has an incomplete tail record');
      this.index = new Set(raw.split('\\n').filter(Boolean).map(line => JSON.parse(line).event_id).filter(Boolean));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  async reset() {
    const release = await this._acquireFileLock();
    try { await this._ensureOpen(); await rm(this.path, {force:true}); this.index.clear(); }
    finally { await release(); }
  }
  async append(event={}) {
    const operation = async () => {
      const release = await this._acquireFileLock();
      try {
        await this._load();
        if (!event.event_id || !event.type) throw new TypeError('event_id and type are required');
        if (this.index.has(event.event_id)) return {status:'DUPLICATE', event_id:event.event_id};
        await appendFile(this.path, JSON.stringify(Object.freeze({...event}))+'\\n', 'utf8');
        this.index.add(event.event_id);
        return {status:'APPENDED', event_id:event.event_id};
      } finally { await release(); }
    };
    const result = this._queue.then(operation, operation);
    this._queue = result.then(() => undefined, () => undefined);
    return result;
  }
  async readAll() {
    await this._load();
    try {
      const raw = await readFile(this.path, 'utf8');
      return raw.split('\\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }
  async close() { this.closed = true; }
}
