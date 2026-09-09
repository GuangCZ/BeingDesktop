'use strict';

const MIN_INTERVAL = 60000;
const MAX_BACKOFF = 300000;
const BLOCKING_ERRORS = new Set(['AUTH_REQUIRED', 'IDENTITY_MISMATCH', 'BACKGROUND_UNAVAILABLE', 'NOT_CONNECTED']);
const SBS_WAITING_REASONS = Object.freeze({WAITING_SBS: 'waiting_sbs', SBS_NOT_CONFIGURED: 'sbs_not_configured'});
const ERROR_MESSAGES = Object.freeze({
  AUTH_REQUIRED: '后台消息通道尚未授权，请检查连接后重试。',
  IDENTITY_MISMATCH: '后台消息身份与当前 Being 不一致，请重新连接。',
  BACKGROUND_UNAVAILABLE: '当前 Being 暂未提供可用的后台消息通道。',
  NOT_CONNECTED: '请先连接 Being。',
  RATE_LIMITED: '后台消息请求过于频繁，稍后自动重试。',
  NETWORK_ERROR: '后台消息连接暂时中断，稍后自动重试。',
  SERVICE_ERROR: '后台消息服务暂时不可用，稍后自动重试。',
  INVALID_RESPONSE: '后台消息返回格式无效，已保留上次同步内容。',
  TOWN_TOOL_NOT_CALLED: 'Being 未执行 Town 读取工具，请在模型设置检查是否使用了限制原生 http 工具的入口。',
  SESSION_CHANGED: '后台消息读取已取消，连接或运行状态已变化。',
  NOT_RUNNING: '后台消息同步尚未启动。',
  PAUSED: '后台消息同步已暂停。',
  BUSY: 'Being 正在处理其他消息，本轮同步稍后重试。',
  READINESS_UNKNOWN: '无法确认 Being 是否空闲，本次读取未发送，请手动重试。',
  RESULT_UNCONFIRMED: '读取已发送，但自动检查未取得结果，请核对后再操作。',
  REQUEST_ACCEPTED: '请求已送达 Being，结果待确认；不会自动重发。',
  WAITING_SBS: '等待 Being 的后台读取结果，已保留上次同步内容。',
  SBS_NOT_CONFIGURED: '后台采集尚未设置，可请 Being 读取一次',
  INCOMPLETE_RESULT: 'Being 的工具结果不完整，已保留上次同步内容。',
  RESULT_SOURCE_UNAVAILABLE: '本机工具结果通道暂不可用，将自动重试。',
  RESULT_SOURCE_NOT_CONFIGURED: '未配置完整工具结果通道，Loom 摘要无法用于同步消息；刷新显示不会补全结果。',
});

function failure(code, automatic = true) {
  const message = automatic ? ERROR_MESSAGES[code] : ERROR_MESSAGES[code]
    .replace('稍后自动重试', '请稍后手动重试')
    .replace('将自动重试', '请手动重试')
    .replace('本轮同步稍后重试', '请稍后手动更新');
  const error = new Error(message);
  error.code = code;
  return error;
}

function record(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function sequence(value) { return Number.isSafeInteger(value) && value >= 0; }
function copy(value) { return structuredClone(value); }
function boundedText(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit * 2).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, limit) : '';
}

// Only public identity fields cross the transport boundary. Never pass the
// connection object, a Loom URL, or credentials to this scheduler.
function identityDto(value) {
  if (value === null || value === undefined) return null;
  const keys = ['beingId', 'connectionRevision', 'identityRevision'];
  if (!record(value)) throw failure('IDENTITY_MISMATCH');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value'))) throw failure('IDENTITY_MISMATCH');
  const {beingId, connectionRevision, identityRevision} = value;
  if (typeof beingId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(beingId) || !sequence(connectionRevision) || !sequence(identityRevision)) throw failure('IDENTITY_MISMATCH');
  return {beingId, connectionRevision, identityRevision};
}

function snapshotDto(value, limit, identity) {
  if (!record(value) || !Array.isArray(value.messages) || value.messages.length > 200 || !sequence(value.latestSeq)) throw failure('INVALID_RESPONSE');
  const messages = new Map();
  for (const entry of value.messages) {
    if (!record(entry) || typeof entry.content !== 'string') throw failure('INVALID_RESPONSE');
    const id = typeof entry.id === 'string' && /^(0|[1-9]\d*)$/.test(entry.id) ? Number(entry.id) : entry.id;
    if (!sequence(id) || id > value.latestSeq) throw failure('INVALID_RESPONSE');
    const message = {
      id: String(id), beingId: boundedText(entry.beingId, 100), beingName: boundedText(entry.beingName, 100),
      content: boundedText(entry.content, 32000), createdAt: boundedText(entry.createdAt, 64), revisedAt: boundedText(entry.revisedAt, 64),
      mentions: Array.isArray(entry.mentions) ? entry.mentions.slice(0, 20).filter(item => typeof item === 'string').map(item => boundedText(item, 100)) : [],
    };
    // A full authoritative window replaces the previous window. The final
    // occurrence of an ID in this response wins; removed IDs stay removed.
    messages.set(id, message);
  }
  return {identity: copy(identity), messages: [...messages.values()].sort((left, right) => Number(left.id) - Number(right.id)).slice(-limit), latestSeq: value.latestSeq, ...(value.source === 'being_relay' ? {source: 'being_relay'} : {})};
}

function receiptDto(value) {
  if (!sequence(value.capturedAt) || value.capturedAt > 8640000000000000 || typeof value.revision !== 'string' || value.revision.length < 1 || value.revision.length > 128 || /[^\x21-\x7e]/.test(value.revision)) throw failure('INVALID_RESPONSE');
  return {capturedAt: value.capturedAt, revision: value.revision, manual: false};
}

class TownRefresh {
  constructor({readSnapshot, getIdentity, onSnapshot = () => {}, onStatus = () => {}, onSuccess = () => {}, intervalMs = MIN_INTERVAL, limit = 10, automatic = true, cached = false, clock = {}} = {}) {
    if ([readSnapshot, getIdentity, onSnapshot, onStatus, onSuccess].some(value => typeof value !== 'function')) throw new TypeError('Invalid Town refresh callbacks');
    if (!Number.isInteger(intervalMs) || intervalMs < MIN_INTERVAL || intervalMs > MAX_BACKOFF || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Invalid Town refresh interval or limit');
    if (typeof automatic !== 'boolean' || typeof cached !== 'boolean') throw new TypeError('Invalid Town refresh settings');
    this.readSnapshot = readSnapshot;
    this.getIdentity = getIdentity;
    this.onSnapshot = onSnapshot;
    this.onStatus = onStatus;
    this.onSuccess = onSuccess;
    this.intervalMs = intervalMs;
    this.limit = limit;
    this.automatic = automatic;
    this.cached = cached;
    this.clock = {now: clock.now || Date.now, setTimeout: clock.setTimeout || setTimeout, clearTimeout: clock.clearTimeout || clearTimeout};
    if (Object.values(this.clock).some(value => typeof value !== 'function')) throw new TypeError('Invalid Town refresh clock');
    this._running = false;
    this._paused = '';
    this._blocked = '';
    this._epoch = 0;
    this._flight = null;
    this._timer = null;
    this._automaticNotBefore = 0;
    this._identityKey = '';
    this._receipt = null;
    this._manualRevision = 0;
    this._cached = {identity: null, messages: [], latestSeq: null};
    this._metadata = {status: 'stopped', reason: '', intervalMs, nextRefreshAt: null, lastAttemptAt: null, lastCheckedAt: null, lastSuccessAt: null, revision: null, stale: false, errorCode: '', failureCount: 0};
    this._statusKey = JSON.stringify(this.status());
  }

  // This metadata is safe for application status and diagnostics. Message
  // content is available only through snapshot() and onSnapshot.
  status() { return {...this._metadata, running: this._running}; }
  snapshot() { return copy(this._cached); }

  cacheRecord() {
    if (this._cached.latestSeq === null || this._metadata.lastSuccessAt === null) return null;
    return copy({messages: this._cached.messages, latestSeq: this._cached.latestSeq,
      ...(this._cached.source === 'being_relay' ? {source: 'being_relay'} : {}),
      capturedAt: this._metadata.lastSuccessAt, revision: this._receipt?.revision || `local:${this._metadata.lastSuccessAt}`, manual: this._receipt?.manual ?? true});
  }

  // Disk records belong to a stable connection key. Rebind them to this session
  // only before reading starts; a late disk result must never replace live data.
  restoreCache(value) {
    if (this._running || this._flight || this._cached.latestSeq !== null) return false;
    try {
      const identity = this._identity();
      if (!identity || !record(value) || typeof value.manual !== 'boolean') return false;
      const next = snapshotDto(value, this.limit, identity);
      const receipt = {...receiptDto(value), manual: value.manual};
      this._identityKey = JSON.stringify(identity);
      this._receipt = this.cached ? receipt : null;
      this._replace(next);
      this._patch({reason: 'local_cache', lastSuccessAt: receipt.capturedAt, revision: receipt.revision, stale: true});
      return true;
    } catch { return false; }
  }

  start() {
    if (this._running) return this.status();
    this._running = true;
    this._paused = '';
    if (!this.automatic) this._waitForManual();
    else if (this._blocked === 'REQUEST_ACCEPTED') this._patch({status: 'waiting', reason: 'being_pending'});
    else if (this._blocked) this._patch({status: 'paused', reason: this._blocked});
    else this._automatic();
    return this.status();
  }

  stop() {
    this._running = false;
    this._paused = '';
    this._invalidate();
    this._patch({status: 'stopped', reason: '', nextRefreshAt: null});
    return this.status();
  }

  pause(reason = 'suspended') {
    this._paused = ['suspended', 'offline', 'idle'].includes(reason) ? reason : 'suspended';
    this._invalidate();
    this._patch({status: this._running ? 'paused' : 'stopped', reason: this._paused, nextRefreshAt: null, stale: this._cached.latestSeq !== null});
    return this.status();
  }

  resume() {
    if (!this._paused) return this.status();
    this._paused = '';
    if (this._running && !this.automatic) this._waitForManual();
    else if (this._running && !this._blocked) this._automatic();
    else if (this._running && this._blocked === 'REQUEST_ACCEPTED') this._patch({status: 'waiting', reason: 'being_pending'});
    else this._patch({status: this._running ? 'paused' : 'stopped', reason: this._blocked});
    return this.status();
  }

  reset() {
    this._invalidate();
    this._blocked = '';
    this._identityKey = '';
    this._receipt = null;
    this._automaticNotBefore = 0;
    this._replace({identity: null, messages: [], latestSeq: null});
    this._patch({status: this._running ? 'paused' : 'stopped', reason: this._paused, nextRefreshAt: null, lastAttemptAt: null, lastCheckedAt: null, lastSuccessAt: null, revision: null, stale: false, errorCode: '', failureCount: 0});
    if (this._running && !this._paused) this._automatic();
    return this.status();
  }

  // Manual refresh bypasses an authorization/unavailable pause, but never a
  // lifecycle pause or stop. It joins an active request without queueing work.
  refresh() {
    if (!this._running) return Promise.reject(failure('NOT_RUNNING'));
    if (this._paused) return Promise.reject(failure('PAUSED'));
    this._blocked = '';
    return this._read();
  }

  // This entry point is only for an explicit action. It never becomes the
  // scheduled reader and supersedes a cache request that is already in flight.
  requestRead(readSnapshot) {
    if (typeof readSnapshot !== 'function') return Promise.reject(new TypeError('Invalid explicit Town reader'));
    if (!this._running) return Promise.reject(failure('NOT_RUNNING'));
    if (this._paused) return Promise.reject(failure('PAUSED'));
    if (this._flight?.explicit && this._isCurrent(this._flight)) return this._flight.promise;
    this._invalidate();
    this._blocked = '';
    return this._read(readSnapshot, true);
  }

  _automatic() {
    if (!this._running || this._paused) return;
    if (!this.automatic) { this._waitForManual(); return; }
    if (this._blocked) return;
    if (!this._flight && this.clock.now() < this._automaticNotBefore) {
      const waiting = Object.hasOwn(SBS_WAITING_REASONS, this._metadata.errorCode) || ['REQUEST_ACCEPTED', 'BUSY'].includes(this._metadata.errorCode);
      this._patch({status: this._metadata.errorCode && !waiting ? 'error' : 'waiting', reason: this.cached ? SBS_WAITING_REASONS[this._metadata.errorCode] || (this._metadata.errorCode === 'REQUEST_ACCEPTED' ? 'being_pending' : 'sbs') : ''});
      this._schedule(this._automaticNotBefore - this.clock.now());
      return;
    }
    void this._read().catch(() => {});
  }

  _waitForManual() {
    this._clearTimer();
    if (Object.hasOwn(SBS_WAITING_REASONS, this._metadata.errorCode)) {
      this._patch({status: 'waiting', reason: SBS_WAITING_REASONS[this._metadata.errorCode], nextRefreshAt: null});
      return;
    }
    if (this._metadata.errorCode === 'REQUEST_ACCEPTED') {
      this._patch({status: 'waiting', reason: 'being_pending', nextRefreshAt: null});
      return;
    }
    const status = this._metadata.errorCode
      ? this._blocked ? 'paused' : this._metadata.errorCode === 'BUSY' ? 'waiting' : 'error'
      : this._cached.latestSeq === null ? 'waiting' : 'ready';
    this._patch({status, reason: 'manual', nextRefreshAt: null});
  }

  _patch(value) {
    Object.assign(this._metadata, value);
    const state = this.status();
    const key = JSON.stringify(state);
    if (key === this._statusKey) return;
    this._statusKey = key;
    try { this.onStatus(state); } catch { /* Observers cannot change synchronization. */ }
  }

  _replace(value) {
    if (JSON.stringify(this._cached) === JSON.stringify(value)) return;
    this._cached = value;
    try { this.onSnapshot(this.snapshot()); } catch { /* Observers cannot change synchronization. */ }
  }

  _clearTimer() {
    if (this._timer !== null) this.clock.clearTimeout(this._timer);
    this._timer = null;
  }

  _invalidate() {
    this._epoch++;
    this._clearTimer();
    const previous = this._flight;
    this._flight = null;
    previous?.controller.abort();
  }

  _identity() {
    let value;
    try { value = this.getIdentity(); } catch { throw failure('IDENTITY_MISMATCH'); }
    return identityDto(value);
  }

  _isCurrent(flight) {
    if (this._epoch !== flight.epoch || this._flight !== flight || flight.controller.signal.aborted) return false;
    let identity;
    try { identity = this._identity(); } catch { identity = null; }
    if (JSON.stringify(identity) === flight.identityKey) return true;
    this.reset();
    return false;
  }

  _failed(error, explicit = false) {
    const code = Object.hasOwn(ERROR_MESSAGES, error?.code) && !['SESSION_CHANGED', 'NOT_RUNNING', 'PAUSED'].includes(error.code) ? error.code : 'NETWORK_ERROR';
    if (code === 'REQUEST_ACCEPTED') {
      this._blocked = this.cached ? '' : code;
      this._patch({status: 'waiting', reason: 'being_pending', errorCode: code, nextRefreshAt: null});
      return {error: failure(code), delay: this.intervalMs};
    }
    if (Object.hasOwn(SBS_WAITING_REASONS, code)) {
      this._blocked = '';
      this._patch({status: 'waiting', reason: SBS_WAITING_REASONS[code], errorCode: code, failureCount: 0, stale: this._cached.latestSeq !== null, nextRefreshAt: null});
      return {error: failure(code), delay: this.intervalMs};
    }
    if (code === 'BUSY') {
      this._patch({status: 'waiting', reason: 'being_busy', errorCode: code, nextRefreshAt: null});
      return {error: failure(code, this.automatic && !explicit), delay: this.intervalMs};
    }
    this._blocked = BLOCKING_ERRORS.has(code) && !(this.cached && explicit) ? code : '';
    this._patch({status: this._blocked ? 'paused' : 'error', reason: this._blocked, errorCode: code, failureCount: this._metadata.failureCount + 1, stale: this._cached.latestSeq !== null, nextRefreshAt: null});
    const base = Math.min(MAX_BACKOFF, this.intervalMs * 2 ** Math.min(3, this._metadata.failureCount - 1));
    const retryAfter = code === 'RATE_LIMITED' && Number.isFinite(error?.retryAfterMs) ? Math.min(MAX_BACKOFF, Math.max(0, error.retryAfterMs)) : 0;
    return {error: failure(code, this.automatic && !explicit), delay: Math.max(this.intervalMs, base, retryAfter)};
  }

  _schedule(delay) {
    if (!this.automatic) {
      this._clearTimer();
      if (this._running && !this._paused && !this._flight) this._waitForManual();
      return;
    }
    if (!this._running || this._paused || this._blocked || this._flight) return;
    this._clearTimer();
    const epoch = this._epoch;
    this._timer = this.clock.setTimeout(() => {
      this._timer = null;
      if (epoch !== this._epoch) return;
      this._patch({nextRefreshAt: null});
      this._automatic();
    }, Math.max(this.intervalMs, delay));
    this._timer?.unref?.();
    this._patch({nextRefreshAt: this.clock.now() + Math.max(this.intervalMs, delay)});
  }

  _read(readSnapshot = this.readSnapshot, explicit = false) {
    let identity;
    try { identity = this._identity(); if (!identity) throw failure('NOT_CONNECTED'); }
    catch (error) {
      this._invalidate();
      this._identityKey = '';
      this._receipt = null;
      this._replace({identity: null, messages: [], latestSeq: null});
      this._patch({lastAttemptAt: null, lastCheckedAt: null, lastSuccessAt: null, revision: null, stale: false, failureCount: 0});
      const outcome = this._failed(error);
      return Promise.reject(outcome.error);
    }
    const identityKey = JSON.stringify(identity);
    if (this._identityKey && this._identityKey !== identityKey) {
      this._invalidate();
      this._receipt = null;
      this._replace({identity: null, messages: [], latestSeq: null});
      this._patch({lastAttemptAt: null, lastCheckedAt: null, lastSuccessAt: null, revision: null, stale: false, errorCode: '', failureCount: 0});
    }
    this._identityKey = identityKey;
    if (this._flight) return this._flight.promise;
    this._clearTimer();
    const flight = {epoch: this._epoch, identityKey, controller: new AbortController(), promise: null, explicit};
    this._flight = flight;
    this._automaticNotBefore = this.clock.now() + this.intervalMs;
    let delay = this.intervalMs;
    flight.promise = Promise.resolve().then(() => {
      if (!this._isCurrent(flight)) throw failure('SESSION_CHANGED');
      return readSnapshot({signal: flight.controller.signal, identity: copy(identity), limit: this.limit});
    }).then(value => {
      if (!this._isCurrent(flight)) throw failure('SESSION_CHANGED');
      const next = snapshotDto(value, this.limit, identity);
      const receipt = this.cached
        ? explicit ? {capturedAt: this.clock.now(), revision: `manual:${++this._manualRevision}`, manual: true} : receiptDto(value)
        : null;
      const unchanged = receipt && !explicit && this._receipt && (receipt.revision === this._receipt.revision || receipt.capturedAt < this._receipt.capturedAt || this._receipt.manual && receipt.capturedAt === this._receipt.capturedAt);
      if (!unchanged) {
        this._receipt = receipt;
        this._replace(next);
      }
      if (!this._isCurrent(flight)) throw failure('SESSION_CHANGED');
      const capturedAt = this._receipt?.capturedAt ?? this.clock.now();
      this._patch({status: 'ready', reason: this.cached ? explicit ? 'manual' : 'sbs' : '', lastCheckedAt: this.clock.now(), lastSuccessAt: capturedAt, revision: this._receipt?.revision ?? null, stale: this.cached && this.clock.now() - capturedAt > 2 * this.intervalMs, errorCode: '', failureCount: 0});
      if (this._isCurrent(flight)) {
        try { this.onSuccess(this.cacheRecord()); } catch { /* Persistence cannot change a successful read. */ }
      }
      return this.snapshot();
    }).catch(error => {
      if (!this._isCurrent(flight)) throw failure('SESSION_CHANGED');
      this._patch({lastCheckedAt: this.clock.now()});
      const outcome = this._failed(error, explicit);
      delay = outcome.delay;
      throw outcome.error;
    }).finally(() => {
      if (this._flight !== flight) return;
      this._flight = null;
      this._automaticNotBefore = this.clock.now() + delay;
      this._schedule(delay);
    });
    this._patch({status: 'refreshing', reason: this.cached && !explicit ? 'sbs' : '', lastAttemptAt: this.clock.now(), nextRefreshAt: null});
    return flight.promise;
  }
}

module.exports = {TownRefresh};
