'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_IDENTITY_BYTES = 64 * 1024 * 1024;
const MAX_IDENTITY_ENTRIES = 128;
const MAX_ARRAY_LENGTH = 10000;
const MAX_DEPTH = 12;
const MAX_NODES = 50000;
const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const validKey = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const miss = () => ({cached: false, data: null, lastSuccessAt: null});

// Copy only bounded JSON data. Inspect descriptors so a caller's getter or
// toJSON function can never execute while a cache entry is being prepared.
function snapshot(value) {
  const ancestors = new Set();
  let nodes = 0, bytes = 0;
  const reserve = size => {
    bytes += size;
    if (bytes > MAX_FILE_BYTES) throw new TypeError('Town cache data is too large');
  };
  const copy = (current, depth) => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new TypeError('Town cache data is too complex');
    if (current === null || typeof current === 'boolean') { reserve(5); return current; }
    if (typeof current === 'number' && Number.isFinite(current)) { reserve(24); return current; }
    if (typeof current === 'string') { reserve(Buffer.byteLength(current, 'utf8') + 2); return current; }
    const array = Array.isArray(current);
    if (!array && !plain(current) || array && Object.getPrototypeOf(current) !== Array.prototype || ancestors.has(current)) throw new TypeError('Town cache requires JSON data');
    const keys = Reflect.ownKeys(current);
    if (array && (current.length > MAX_ARRAY_LENGTH || keys.length !== current.length + 1) || !array && keys.length > 2000) throw new TypeError('Town cache has too many entries');
    ancestors.add(current);
    reserve(2);
    const result = array ? [] : {};
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || array && !/^(0|[1-9]\d*)$/.test(key)) throw new TypeError('Town cache requires JSON keys');
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new TypeError('Town cache requires JSON fields');
      if (!array && descriptor.value === undefined) continue;
      reserve(Buffer.byteLength(key, 'utf8') + 4);
      Object.defineProperty(result, key, {value: copy(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true});
    }
    ancestors.delete(current);
    return result;
  };
  return copy(value, 0);
}

// Store only sanitized Town DTOs supplied by the main process. Account and
// resource keys are included in the encrypted payload as well as its path.
class TownDataCache {
  constructor({directory, safeStorage, clock = Date.now} = {}) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('Invalid Town cache directory');
    if (typeof clock !== 'function') throw new TypeError('Invalid Town cache clock');
    this.directory = path.resolve(directory);
    this.safeStorage = safeStorage;
    this.clock = clock;
    this._writes = new Map();
    this._identityWrites = new Map();
    this._failed = new Set();
  }

  _available() {
    try {
      return this.safeStorage?.isEncryptionAvailable() === true
        && typeof this.safeStorage.encryptString === 'function' && typeof this.safeStorage.decryptString === 'function';
    } catch { return false; }
  }

  _valid(identityKey, resourceKey) { return validKey(identityKey, 256) && validKey(resourceKey, 32768); }
  _key(identityKey, resourceKey) { return JSON.stringify([identityKey, resourceKey]); }
  _directory(identityKey) { return path.join(this.directory, hash(identityKey)); }
  _file(identityKey, resourceKey) { return path.join(this._directory(identityKey), `${hash(resourceKey)}.bin`); }

  async load(identityKey, resourceKey) {
    if (!this._valid(identityKey, resourceKey)) return miss();
    try {
      const key = this._key(identityKey, resourceKey);
      while (this._writes.has(key)) await this._writes.get(key);
      if (!this._available()) return miss();
      const file = this._file(identityKey, resourceKey);
      const stat = await fs.stat(file);
      if (!stat.isFile() || !stat.size || stat.size > MAX_FILE_BYTES) return miss();
      const ciphertext = await fs.readFile(file);
      if (!ciphertext.length || ciphertext.length > MAX_FILE_BYTES) return miss();
      const decoded = this.safeStorage.decryptString(ciphertext);
      if (typeof decoded !== 'string' || Buffer.byteLength(decoded, 'utf8') > MAX_FILE_BYTES) return miss();
      const payload = JSON.parse(decoded);
      if (!plain(payload) || payload.version !== 1 || payload.identityKey !== identityKey || payload.resourceKey !== resourceKey || !validTime(payload.lastSuccessAt)) return miss();
      return {cached: true, data: snapshot(payload.data), lastSuccessAt: payload.lastSuccessAt};
    } catch { return miss(); }
  }

  async save(identityKey, resourceKey, data) {
    if (!this._valid(identityKey, resourceKey)) return false;
    let payload;
    try {
      const next = snapshot(data), lastSuccessAt = this.clock();
      if (!validTime(lastSuccessAt)) return false;
      payload = JSON.stringify({version: 1, identityKey, resourceKey, data: next, lastSuccessAt});
      if (Buffer.byteLength(payload, 'utf8') > MAX_FILE_BYTES) return false;
    } catch { return false; }
    return this._enqueue(identityKey, resourceKey, () => this._write(identityKey, resourceKey, payload));
  }

  _enqueue(identityKey, resourceKey, operation) {
    const key = this._key(identityKey, resourceKey);
    // Serialize each identity's writes and evictions together so concurrent
    // saves cannot evict an entry while another save is replacing it.
    const previous = this._identityWrites.get(identityKey) || Promise.resolve();
    const pending = previous.then(operation).catch(() => false).then(success => {
      if (success) this._failed.delete(key);
      else this._failed.add(key);
      return success;
    }).finally(() => {
      if (this._writes.get(key) === pending) this._writes.delete(key);
      if (this._identityWrites.get(identityKey) === pending) this._identityWrites.delete(identityKey);
    });
    this._writes.set(key, pending);
    this._identityWrites.set(identityKey, pending);
    return pending;
  }

  async _write(identityKey, resourceKey, payload) {
    let temporary;
    try {
      if (!this._available()) return false;
      const ciphertext = this.safeStorage.encryptString(payload);
      if (!Buffer.isBuffer(ciphertext) || !ciphertext.length || ciphertext.length > MAX_FILE_BYTES) return false;
      await fs.mkdir(this._directory(identityKey), {recursive: true});
      const file = this._file(identityKey, resourceKey);
      temporary = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, ciphertext, {flag: 'wx', mode: 0o600});
      await fs.rename(temporary, file);
      temporary = null;
      await this._prune(identityKey, file);
      return true;
    } catch { return false; }
    finally {
      if (temporary) { try { await fs.unlink(temporary); } catch { /* Preserve the previous complete entry after a failed write. */ } }
    }
  }

  async _prune(identityKey, keep) {
    const directory = this._directory(identityKey), entries = [];
    for (const name of await fs.readdir(directory)) {
      if (!/^[a-f0-9]{64}\.bin$/.test(name)) continue;
      const file = path.join(directory, name), stat = await fs.stat(file);
      if (stat.isFile()) entries.push({file, size: stat.size, time: stat.mtimeMs});
    }
    entries.sort((left, right) => left.time - right.time || left.file.localeCompare(right.file));
    let count = entries.length, bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (count <= MAX_IDENTITY_ENTRIES && bytes <= MAX_IDENTITY_BYTES) break;
      if (entry.file === keep) continue;
      await fs.unlink(entry.file);
      count--;
      bytes -= entry.size;
    }
  }

  async invalidate(identityKey, resourceKey) {
    if (!this._valid(identityKey, resourceKey)) return false;
    return this._enqueue(identityKey, resourceKey, async () => {
      try { await fs.unlink(this._file(identityKey, resourceKey)); return true; }
      catch (error) { return error.code === 'ENOENT'; }
    });
  }

  async flush() {
    while (this._writes.size) await Promise.all(this._writes.values());
    return this._failed.size === 0;
  }
}

module.exports = {TownDataCache};
