'use strict';

const {createHash} = require('node:crypto');
const {validateTownToolResult} = require('./being-town-reader.cjs');
const {messagesDto, firesideMessagesDto} = require('./town-session.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const error = (code, message) => Object.assign(new Error(message), {code});
const waiting = () => error('WAITING_SBS', '等待 Being 后台读取。');
const invalid = () => error('INCOMPLETE_RESULT', '后台读取结果不完整，已保留上次内容。');
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

function connectionKey(connection) {
  if (!connection?.url || !connection?.beingName) return '';
  return createHash('sha256').update(connection.url).digest('hex');
}

// This adapter can only poll enrolled local results. It cannot send a message
// to Being, schedule a breath, or fall back to model-authored text.
class SbsTownResults {
  constructor({getConnection, getRegistrations, results, now = Date.now}) {
    if (typeof getConnection !== 'function' || typeof getRegistrations !== 'function' || typeof results?.poll !== 'function' || typeof now !== 'function') throw new TypeError('Invalid SBS result callbacks');
    Object.assign(this, {getConnection, getRegistrations, results, now});
    this._key = '';
    this._epoch = 0;
    this._cache = new Map();
    this._completed = new Map();
  }

  reset() { this._epoch++; this._key = ''; this._cache.clear(); this._completed.clear(); }

  async readSnapshot({kind, firesideId = '', limit = 10, signal}) {
    if (!['bonfire', 'fireside'].includes(kind) || !Number.isInteger(limit) || limit < 1 || limit > 200 || kind === 'fireside' && (!/^[1-9]\d{0,15}$/.test(firesideId) || !Number.isSafeInteger(Number(firesideId)))) throw error('INVALID_REQUEST', '请选择有效的消息来源。');
    const connection = this.getConnection();
    const key = connectionKey(connection);
    if (!key) throw error('NOT_CONNECTED', '请先连接 Being。');
    if (this._key !== key) { this.reset(); this._key = key; }
    const epoch = this._epoch;
    const current = () => {
      if (signal?.aborted) throw error('ABORTED', '后台结果读取已取消。');
      if (this._epoch !== epoch || connectionKey(this.getConnection()) !== key) throw error('SESSION_CHANGED', 'Being 连接已变化，旧后台结果已丢弃。');
    };
    current();
    const route = kind === 'bonfire' ? '/api/bonfire/hear' : '/api/fireside/hear';
    const slot = `${route}:${firesideId}:${limit}`;
    const manifest = await this.getRegistrations();
    current();
    const records = plain(manifest) && manifest.version === 1 && manifest.connectionKey === key && Array.isArray(manifest.records) ? manifest.records.slice(0, 8) : [];
    const candidates = records.filter(item => plain(item) && item.source === 'sbs' && UUID.test(item.requestId) && item.beingId === connection.beingName && item.route === route && plain(item.query)
      && Object.keys(item.query).length === (kind === 'bonfire' ? 1 : 2) && String(item.query.limit) === String(limit)
      && (kind === 'bonfire' || String(item.query.fireside_id) === firesideId)
      && Number.isSafeInteger(item.createdAt) && Number.isSafeInteger(item.expiresAt) && item.expiresAt > this.now() && item.createdAt <= this.now() && item.expiresAt - item.createdAt <= 1800000)
      .sort((a, b) => b.createdAt - a.createdAt);
    const fields = ['protocol', 'requestId', 'route', 'beingId', 'httpStatus', 'data', 'capturedAt'];
    for (const record of candidates) {
      const cached = this._cache.get(slot);
      if (cached?.revision === record.requestId || this._completed.get(record.requestId) === slot) continue;
      const result = await this.results.poll(record, {signal});
      current();
      // A future enrollment must not hide a completed result on app startup.
      // Invalid results and business errors still stop the read.
      if (!result) continue;
      if (!plain(result) || Object.keys(result).length !== fields.length || fields.some(field => !Object.hasOwn(result, field)) || result.protocol !== 'being-town-tool-result/1' || result.requestId !== record.requestId || result.route !== route || result.beingId !== connection.beingName || result.httpStatus !== 200) throw invalid();
      if (!plain(result.data) || result.data.being !== connection.beingName) throw error('IDENTITY_MISMATCH', '后台结果的 Being 身份不匹配。');
      const capturedAt = typeof result.capturedAt === 'string' ? Date.parse(result.capturedAt) : NaN;
      if (!Number.isSafeInteger(capturedAt) || capturedAt < record.createdAt - 1000 || capturedAt > this.now() + 1000 || capturedAt >= record.expiresAt) throw invalid();
      const data = validateTownToolResult(result.data, route, connection.beingName, record.query);
      const value = kind === 'bonfire' ? messagesDto(data) : firesideMessagesDto(data, {beingId: connection.beingName});
      const snapshot = {...value, capturedAt, revision: record.requestId};
      // Another reader may have installed a newer capture while this poll waited.
      const latest = this._cache.get(slot);
      if (!latest || snapshot.capturedAt > latest.capturedAt) this._cache.set(slot, snapshot);
      // Enrollment order does not imply capture order. Check every unseen
      // candidate, retaining bounded receipts to avoid re-fetching consumed IDs.
      this._completed.set(record.requestId, slot);
      if (this._completed.size > 64) this._completed.delete(this._completed.keys().next().value);
    }
    const cached = this._cache.get(slot);
    if (cached) return structuredClone(cached);
    if (candidates.length) throw waiting();
    throw error('SBS_NOT_CONFIGURED', '后台采集尚未设置，可请 Being 读取一次。');
  }
}

module.exports = {SbsTownResults, connectionKey};
