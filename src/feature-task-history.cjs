'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {FeatureTasks} = require('./feature-tasks.cjs');
const {normalizeTownSyncRecords} = require('./loom-town-sync.cjs');

const MAX_FILE_BYTES = 128 * 1024 * 1024;

class FeatureTaskHistory {
  constructor({identityKey, directory, safeStorage, onChange = () => {}} = {}) {
    if (typeof identityKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(identityKey)) throw new TypeError('Invalid task history identity');
    if (typeof directory !== 'string' || !directory || typeof onChange !== 'function') throw new TypeError('Invalid task history configuration');
    this.identityKey = identityKey;
    this.directory = path.resolve(directory);
    this.filePath = path.join(this.directory, `${createHash('sha256').update(identityKey).digest('hex')}.bin`);
    this.safeStorage = safeStorage;
    this.onChange = onChange;
    this._persistenceError = false;
    this._records = [];
    this._blocked = false;
    this._dirty = false;
    this._generation = 0;
    this._restorePromise = null;
    this._savePromise = null;
    this.ledger = this._ledger();
  }

  get records() { return structuredClone(this._records); }
  get persistenceError() { return this._persistenceError; }

  _ledger(initialSnapshot) {
    return new FeatureTasks({identityKey: this.identityKey, initialSnapshot, onChange: () => {
      this._generation++;
      this._notify();
      void this.save();
    }});
  }

  _notify() {
    try { this.onChange({tasks: this.ledger.list(), persistenceError: this.persistenceError}); } catch {}
  }

  _encryptionAvailable() {
    try {
      return typeof this.safeStorage?.isEncryptionAvailable === 'function'
        && this.safeStorage.isEncryptionAvailable() === true
        && typeof this.safeStorage.encryptString === 'function'
        && typeof this.safeStorage.decryptString === 'function';
    } catch { return false; }
  }

  async restore() {
    if (!this._restorePromise) this._restorePromise = this._restore();
    await this._restorePromise;
    return this;
  }

  async _restore() {
    if (!this._encryptionAvailable()) { this._blocked = true; this._persistenceError = true; this._notify(); return; }
    try {
      const stat = await fs.stat(this.filePath);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid encrypted task history');
      const ciphertext = await fs.readFile(this.filePath);
      if (ciphertext.length > MAX_FILE_BYTES) throw new Error('Invalid encrypted task history');
      const payload = JSON.parse(this.safeStorage.decryptString(ciphertext));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).length !== 4 || payload.version !== 1 || payload.identityKey !== this.identityKey
        || !payload.ledger || payload.ledger.version !== 1 || payload.ledger.identityKey !== this.identityKey
        || !Array.isArray(payload.ledger.records) || !Array.isArray(payload.records) || payload.records.length > 256) {
        throw new Error('Task history identity or schema mismatch');
      }
      // Preserve work submitted while the first disk read was still pending.
      const current = this.ledger.snapshot();
      const currentIds = new Set(current.records.map(task => task.id));
      const records = this._generation ? [...current.records, ...payload.ledger.records.filter(task => !currentIds.has(task?.id))] : payload.ledger.records;
      this.ledger = this._ledger({...payload.ledger, records});
      this._records = normalizeTownSyncRecords([...payload.records, ...this._records]);
    } catch (error) {
      if (error?.code !== 'ENOENT') { this._blocked = true; this._persistenceError = true; }
    }
    this._notify();
  }

  register(record) {
    const candidate = normalizeTownSyncRecords([record]);
    if (candidate.length !== 1) return false;
    const next = normalizeTownSyncRecords([...this._records, candidate[0]]);
    const accepted = next.some(item => item.requestId === candidate[0].requestId);
    if (JSON.stringify(next) !== JSON.stringify(this._records)) {
      this._records = next;
      this._generation++;
      this._notify();
      void this.save();
    }
    return accepted;
  }

  save() {
    this._dirty = true;
    if (!this._savePromise) this._savePromise = this._drain().finally(() => {
      this._savePromise = null;
      if (this._dirty && !this._blocked) void this.save();
    });
    return this._savePromise;
  }

  async _drain() {
    await this.restore();
    while (this._dirty && !this._blocked) {
      this._dirty = false;
      let temporary;
      try {
        if (!this._encryptionAvailable()) { this._blocked = true; throw new Error('Task history encryption unavailable'); }
        if (this.ledger.identityKey !== this.identityKey) { this._blocked = true; throw new Error('Task history identity changed'); }
        const payload = JSON.stringify({version: 1, identityKey: this.identityKey, ledger: this.ledger.snapshot(), records: this._records});
        let ciphertext;
        try { ciphertext = this.safeStorage.encryptString(payload); }
        catch { this._blocked = true; throw new Error('Task history encryption failed'); }
        if (!Buffer.isBuffer(ciphertext) || !ciphertext.length || ciphertext.length > MAX_FILE_BYTES) {
          this._blocked = true;
          throw new Error('Invalid encrypted task history');
        }
        await fs.mkdir(this.directory, {recursive: true});
        temporary = `${this.filePath}.${randomUUID()}.tmp`;
        await fs.writeFile(temporary, ciphertext, {flag: 'wx', mode: 0o600});
        await fs.rename(temporary, this.filePath);
        temporary = null;
        if (this.persistenceError) { this._persistenceError = false; this._notify(); }
      } catch {
        this._persistenceError = true;
        this._dirty = false;
        this._notify();
      } finally {
        if (temporary) { try { await fs.unlink(temporary); } catch {} }
      }
    }
    return !this.persistenceError;
  }

  async flush() {
    while (this._savePromise) await this._savePromise;
    return !this.persistenceError;
  }
}

module.exports = {FeatureTaskHistory};
