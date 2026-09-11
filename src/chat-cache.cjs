'use strict';

// Encrypted single-file store for one Being's conversation transcripts, in the BonfireCache shape.
// Validation belongs to ChatStore's snapshot: this file only guards the envelope and the disk.

const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {snapshot} = require('./chat-store.cjs');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const validKey = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);

class ChatCache {
  constructor({directory, safeStorage} = {}) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('Invalid chat cache directory');
    this.directory = path.resolve(directory);
    this.safeStorage = safeStorage;
    this._writes = new Map();
    this._failed = new Set();
  }

  _available() {
    try {
      return this.safeStorage?.isEncryptionAvailable() === true
        && typeof this.safeStorage.encryptString === 'function' && typeof this.safeStorage.decryptString === 'function';
    } catch { return false; }
  }

  _file(identityKey) { return path.join(this.directory, `${createHash('sha256').update(identityKey).digest('hex')}.bin`); }

  async load(identityKey) {
    if (!validKey(identityKey) || !this._available()) return null;
    try {
      await this._writes.get(identityKey);
      const file = this._file(identityKey);
      const stat = await fs.stat(file);
      if (!stat.isFile() || !stat.size || stat.size > MAX_FILE_BYTES) return null;
      const ciphertext = await fs.readFile(file);
      if (!ciphertext.length || ciphertext.length > MAX_FILE_BYTES) return null;
      const decoded = this.safeStorage.decryptString(ciphertext);
      if (typeof decoded !== 'string' || Buffer.byteLength(decoded, 'utf8') > MAX_FILE_BYTES) return null;
      const payload = JSON.parse(decoded);
      if (!plain(payload) || payload.version !== 1 || payload.identityKey !== identityKey) return null;
      return snapshot(payload.state);
    } catch { return null; }
  }

  async save(identityKey, value) {
    if (!validKey(identityKey)) return false;
    let payload;
    try {
      const next = snapshot(value);
      if (!next) return false;
      payload = JSON.stringify({version: 1, identityKey, state: next});
      if (Buffer.byteLength(payload, 'utf8') > MAX_FILE_BYTES) return false;
    } catch { return false; }
    const previous = this._writes.get(identityKey) || Promise.resolve();
    const pending = previous.then(() => this._write(identityKey, payload)).finally(() => {
      if (this._writes.get(identityKey) === pending) this._writes.delete(identityKey);
    });
    this._writes.set(identityKey, pending);
    return pending;
  }

  async _write(identityKey, payload) {
    let temporary;
    try {
      if (!this._available()) throw new Error('Chat cache encryption unavailable');
      const ciphertext = this.safeStorage.encryptString(payload);
      if (!Buffer.isBuffer(ciphertext) || !ciphertext.length || ciphertext.length > MAX_FILE_BYTES) throw new Error('Invalid encrypted chat cache');
      await fs.mkdir(this.directory, {recursive: true});
      const file = this._file(identityKey);
      temporary = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, ciphertext, {flag: 'wx', mode: 0o600});
      await fs.rename(temporary, file);
      temporary = null;
      this._failed.delete(identityKey);
      return true;
    } catch {
      this._failed.add(identityKey);
      return false;
    } finally {
      if (temporary) { try { await fs.unlink(temporary); } catch { /* Keep the previous cache after a failed write. */ } }
    }
  }

  async remove(identityKey) {
    if (!validKey(identityKey)) return false;
    try { await fs.unlink(this._file(identityKey)); return true; }
    catch (error) { return error.code === 'ENOENT'; }
  }

  async flush() {
    while (this._writes.size) await Promise.all(this._writes.values());
    return this._failed.size === 0;
  }
}

module.exports = {ChatCache};
