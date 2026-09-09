'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const sequence = value => Number.isSafeInteger(value) && value >= 0;
const validKey = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);

function snapshot(value) {
  if (!plain(value) || !Array.isArray(value.messages) || value.messages.length > 200 || !sequence(value.latestSeq)
    || !sequence(value.capturedAt) || value.capturedAt > 8640000000000000 || typeof value.manual !== 'boolean'
    || typeof value.revision !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(value.revision)) return null;
  const messages = [];
  for (const entry of value.messages) {
    if (!plain(entry) || typeof entry.content !== 'string' || entry.content.length > 32000) return null;
    const id = typeof entry.id === 'string' && /^(0|[1-9]\d*)$/.test(entry.id) ? Number(entry.id) : entry.id;
    if (!sequence(id) || id > value.latestSeq) return null;
    const message = {id: String(id), content: entry.content};
    for (const [field, limit] of [['beingId', 100], ['beingName', 100], ['createdAt', 64], ['revisedAt', 64]]) {
      if (entry[field] !== undefined && (typeof entry[field] !== 'string' || entry[field].length > limit)) return null;
      if (entry[field] !== undefined) message[field] = entry[field];
    }
    if (entry.mentions !== undefined) {
      if (!Array.isArray(entry.mentions) || entry.mentions.length > 20 || entry.mentions.some(item => typeof item !== 'string' || item.length > 100)) return null;
      message.mentions = [...entry.mentions];
    }
    messages.push(message);
  }
  return {messages, latestSeq: value.latestSeq, capturedAt: value.capturedAt, revision: value.revision, manual: value.manual, ...(value.source === 'being_relay' ? {source: 'being_relay'} : {})};
}

// This store contains only validated message snapshots. Connection revisions
// belong to the running session and are rebound by the refresh coordinator.
class BonfireCache {
  constructor({directory, safeStorage} = {}) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('Invalid Bonfire cache directory');
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
      return snapshot(payload.snapshot);
    } catch { return null; }
  }

  async save(identityKey, value) {
    if (!validKey(identityKey)) return false;
    let payload;
    try {
      const next = snapshot(value);
      if (!next) return false;
      payload = JSON.stringify({version: 1, identityKey, snapshot: next});
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
      if (!this._available()) throw new Error('Bonfire cache encryption unavailable');
      const ciphertext = this.safeStorage.encryptString(payload);
      if (!Buffer.isBuffer(ciphertext) || !ciphertext.length || ciphertext.length > MAX_FILE_BYTES) throw new Error('Invalid encrypted Bonfire cache');
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

  async flush() {
    while (this._writes.size) await Promise.all(this._writes.values());
    return this._failed.size === 0;
  }
}

module.exports = {BonfireCache};
