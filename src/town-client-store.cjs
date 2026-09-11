'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');

// Client tokens never enter settings, diagnostics, IPC, or renderer storage.
class TownClientStore {
  constructor({directory, safeStorage}) { Object.assign(this, {directory, safeStorage}); }
  _file(key) { return path.join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`); }
  _secure() {
    if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === 'basic_text')
      throw Object.assign(new Error('系统安全存储不可用，Town 配对凭据未保存。'), {code: 'AUTH_REQUIRED'});
  }
  assertAvailable() { this._secure(); }
  async load(key, beingId) {
    this._secure();
    try {
      const stat = await fs.stat(this._file(key));
      if (!stat.isFile() || stat.size > 8192) return null;
      const raw = await fs.readFile(this._file(key), 'utf8');
      if (raw.length > 8192) return null;
      const data = JSON.parse(this.safeStorage.decryptString(Buffer.from(JSON.parse(raw).encrypted, 'base64')));
      return data.key === key && data.beingId === beingId && /^[a-f0-9]{64}$/.test(data.token) ? data.token : null;
    } catch (error) { if (error.code === 'ENOENT') return null; throw Object.assign(new Error('Town 凭据无法读取，请重新配对。'), {code: 'AUTH_REQUIRED'}); }
  }
  async save(key, beingId, token) {
    this._secure();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid client token');
    await fs.mkdir(this.directory, {recursive: true, mode: 0o700});
    const file = this._file(key), temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify({version: 1, encrypted: this.safeStorage.encryptString(JSON.stringify({key, beingId, token})).toString('base64')}), {mode: 0o600, flag: 'wx'});
      await fs.rename(temp, file);
    } finally { await fs.rm(temp, {force: true}).catch(() => {}); }
  }
  async remove(key) { await fs.rm(this._file(key), {force: true}); }
}
module.exports = {TownClientStore};
