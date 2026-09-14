'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');

// Client tokens never enter settings, diagnostics, IPC, or renderer storage.
class TownClientStore {
  constructor({directory, safeStorage}) { Object.assign(this, {directory, safeStorage}); this._tail = Promise.resolve(); }
  _file(key) { return path.join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`); }
  _secure() {
    if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === 'basic_text')
      throw Object.assign(new Error('系统安全存储不可用，Town 配对凭据未保存。'), {code: 'AUTH_REQUIRED'});
  }
  assertAvailable() { this._secure(); }
  async loadCredential(key, beingId) {
    this._secure();
    try {
      const stat = await fs.stat(this._file(key));
      if (!stat.isFile() || stat.size > 8192) return null;
      const raw = await fs.readFile(this._file(key), 'utf8');
      if (raw.length > 8192) return null;
      const data = JSON.parse(this.safeStorage.decryptString(Buffer.from(JSON.parse(raw).encrypted, 'base64')));
      if (data.key !== key || data.beingId !== beingId || !/^[a-f0-9]{64}$/.test(data.token)) return null;
      if (data.townId !== undefined && (typeof data.townId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(data.townId))) throw new Error('Invalid Town binding');
      return {token: data.token, townId: data.townId || ''};
    } catch (error) { if (error.code === 'ENOENT') return null; throw Object.assign(new Error('Town 凭据无法读取，请重新配对。'), {code: 'AUTH_REQUIRED'}); }
  }
  async load(key, beingId) { return (await this.loadCredential(key, beingId))?.token || null; }
  _mutate(action) { const pending = this._tail.then(action); this._tail = pending.catch(() => {}); return pending; }
  save(key, beingId, token, townId = '') { return this._mutate(() => this._save(key, beingId, token, townId)); }
  async _save(key, beingId, token, townId = '') {
    this._secure();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid client token');
    if (townId && (typeof townId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(townId))) throw new Error('Invalid Town binding');
    await fs.mkdir(this.directory, {recursive: true, mode: 0o700});
    const file = this._file(key), temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify({version: 1, encrypted: this.safeStorage.encryptString(JSON.stringify({key, beingId, token, ...(townId ? {townId} : {})})).toString('base64')}), {mode: 0o600, flag: 'wx'});
      await fs.rename(temp, file);
    } finally { await fs.rm(temp, {force: true}).catch(() => {}); }
  }
  bindTownId(key, beingId, token, townId, isCurrent = () => true) {
    return this._mutate(async () => {
      if (typeof townId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(townId)) throw Object.assign(new Error('Town 身份编号无效。'), {code: 'INVALID_RESPONSE'});
      const saved = await this.loadCredential(key, beingId);
      if (!isCurrent() || !saved || saved.token !== token) throw Object.assign(new Error('Town 配对已变化，身份绑定未保存。'), {code: 'SESSION_CHANGED'});
      if (saved.townId && saved.townId !== townId) throw Object.assign(new Error('Town 返回的身份与已保存配对不一致。'), {code: 'IDENTITY_MISMATCH'});
      if (!saved.townId) await this._save(key, beingId, token, townId);
    });
  }
  remove(key) { return this._mutate(() => fs.rm(this._file(key), {force: true})); }
}
module.exports = {TownClientStore};
