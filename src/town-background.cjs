'use strict';

const {TownRefresh} = require('./town-refresh.cjs');

function invalid(message = '请选择有效的 Town 消息来源。') {
  const error = new Error(message); error.code = 'INVALID_REQUEST'; return error;
}

function requestDto(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!Object.hasOwn(descriptors, 'kind') || !Object.hasOwn(descriptors.kind, 'value')) throw invalid();
  const keys = descriptors.kind.value === 'bonfire' ? ['kind'] : ['kind', 'firesideId'];
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value'))) throw invalid();
  if (value.kind === 'bonfire') return {kind: 'bonfire', firesideId: ''};
  if (value.kind !== 'fireside' || typeof value.firesideId !== 'string' || !/^[1-9]\d{0,15}$/.test(value.firesideId) || !Number.isSafeInteger(Number(value.firesideId))) throw invalid();
  return {kind: 'fireside', firesideId: value.firesideId};
}

// Cached feeds own one public feed and at most one selected private room.
// The automatic transport reads existing results. Only requestRead may ask
// Being to execute a new read when a cache transport is configured.
class TownBackground {
  constructor({townSession, getIdentity, readCachedSnapshot = null, bonfireCache = null, getCacheKey = () => '', onUpdate = () => {}, onStatus = () => {}, clock = {}}) {
    if (readCachedSnapshot !== null && typeof readCachedSnapshot !== 'function') throw new TypeError('Invalid Town cache reader');
    Object.assign(this, {townSession, getIdentity, readCachedSnapshot, bonfireCache, getCacheKey, onUpdate, onStatus, clock});
    this._cacheGeneration = 0;
    this._restorePromise = null;
    this._roomRestorePromise = null;
    this._roomGeneration = 0;
    this._allowedRooms = null;
    this._enabled = false;
    this._identityKey = '';
    this._room = null;
    this._roomId = '';
    this._bonfire = this._create('bonfire', '');
  }

  _create(kind, firesideId) {
    const current = () => kind === 'bonfire' || this._roomId === firesideId;
    const publish = () => {
      if (!current()) return;
      try { this.onUpdate(this._envelope(kind, firesideId)); } catch { /* Observers do not affect reading. */ }
    };
    return new TownRefresh({getIdentity: this.getIdentity, clock: this.clock, automatic: Boolean(this.readCachedSnapshot), cached: Boolean(this.readCachedSnapshot),
      readSnapshot: ({signal, limit}) => this.readCachedSnapshot
        ? this.readCachedSnapshot({kind, firesideId, limit, signal})
        : this._requestRead(kind, firesideId, {signal, limit}),
      onSnapshot: publish,
      onSuccess: value => {
        if (!current() || !this.bonfireCache || this._identityKey !== JSON.stringify(this.getIdentity())) return;
        const key = this._cacheKey(kind, firesideId);
        if (key) void Promise.resolve(this.bonfireCache.save(key, value)).catch(() => {});
      },
      onStatus: () => { if (current()) { try { this.onStatus(); } catch { /* Observers do not affect reading. */ } publish(); } },
    });
  }

  _requestRead(kind, firesideId, {signal, limit}) {
    return kind === 'bonfire'
      ? this.townSession.getBonfireMessages({limit}, {signal})
      : this.townSession.getFiresideMessages({firesideId, limit}, {signal});
  }

  _cacheKey(kind, firesideId) {
    const key = this.getCacheKey();
    return key && (kind === 'bonfire' ? key : `${key}:fireside:${firesideId}`);
  }

  _envelope(kind, firesideId) {
    const reader = kind === 'bonfire' ? this._bonfire : this._room;
    const snapshot = reader.snapshot();
    // An empty, initial error still carries its public connection identity.
    if (!snapshot.identity && snapshot.messages.length === 0) snapshot.identity = this.getIdentity();
    return {kind, firesideId, snapshot, status: reader.status()};
  }

  metadata() {
    return {bonfire: this._bonfire.status(), fireside: this._room?.status() || null};
  }

  lifecycle({enabled, reason = 'offline'}) {
    const identity = this.getIdentity();
    const key = JSON.stringify(identity);
    const changed = key !== this._identityKey;
    if (changed) {
      this._identityKey = key;
      this._enabled = false;
      this._bonfire.stop(); this._bonfire.reset();
      this.clearRoom();
      this._allowedRooms = null;
      const generation = ++this._cacheGeneration;
      const cacheKey = identity && this.bonfireCache ? this.getCacheKey() : '';
      this._restorePromise = cacheKey ? Promise.resolve().then(() => this.bonfireCache.load(cacheKey)).then(value => {
        if (generation === this._cacheGeneration && key === JSON.stringify(this.getIdentity()) && cacheKey === this.getCacheKey()) this._bonfire.restoreCache(value);
      }).catch(() => {}) : null;
    }
    const next = Boolean(enabled && identity);
    if (this._enabled === next) return;
    this._enabled = next;
    for (const reader of [this._bonfire, this._room].filter(Boolean)) {
      if (next) {
        const restoration = reader === this._bonfire ? this._restorePromise : this._roomRestorePromise;
        if (restoration && !reader.status().running) {
          const generation = this._cacheGeneration;
          void restoration.then(() => { if (generation === this._cacheGeneration && this._enabled && (reader === this._bonfire || reader === this._room)) this._start(reader); });
        } else this._start(reader);
      }
      else reader.pause(reason);
    }
  }

  _start(reader) { if (reader.status().running) reader.resume(); else reader.start(); }

  async restore() {
    let pending;
    do { pending = this._restorePromise; await pending; } while (pending !== this._restorePromise);
  }

  clearRoom() {
    const previous = this._room;
    this._roomGeneration++;
    this._roomRestorePromise = null;
    this._room = null; this._roomId = '';
    previous?.stop(); previous?.reset();
    if (previous) { try { this.onStatus(); } catch { /* Observers do not affect reading. */ } }
  }

  reconcileRooms(rooms) {
    const ids = new Set([...(rooms.owned || []), ...(rooms.joined || [])].map(room => String(room.id)));
    this._allowedRooms = ids;
    if (this._room && !ids.has(this._roomId)) this.clearRoom();
  }

  _select(value) {
    const request = requestDto(value);
    if (request.kind === 'fireside' && this._allowedRooms && !this._allowedRooms.has(request.firesideId)) {
      const error = new Error('当前 Being 已无法访问此围炉，请刷新围炉目录。'); error.code = 'AUTH_REQUIRED'; throw error;
    }
    if (request.kind === 'fireside' && request.firesideId !== this._roomId) {
      this.clearRoom();
      this._roomId = request.firesideId;
      this._room = this._create('fireside', request.firesideId);
      const reader = this._room;
      const generation = this._roomGeneration;
      const identityKey = this._identityKey;
      const cacheKey = this.getIdentity() && this.bonfireCache ? this._cacheKey(request.kind, request.firesideId) : '';
      const current = () => generation === this._roomGeneration && reader === this._room && identityKey === JSON.stringify(this.getIdentity()) && cacheKey === this._cacheKey(request.kind, request.firesideId);
      this._roomRestorePromise = cacheKey ? Promise.resolve().then(() => this.bonfireCache.load(cacheKey)).then(value => {
        if (current()) reader.restoreCache(value);
      }).catch(() => {}).then(() => { if (current() && this._enabled) this._start(reader); }) : null;
      if (this._enabled && !this._roomRestorePromise) this._start(reader);
    }
    return request;
  }

  snapshot(value) {
    const request = this._select(value);
    return this._envelope(request.kind, request.firesideId);
  }

  async cachedSnapshot(value) {
    const request = this._select(value);
    const reader = request.kind === 'bonfire' ? this._bonfire : this._room;
    const identityKey = JSON.stringify(this.getIdentity());
    await (request.kind === 'bonfire' ? this.restore() : this._roomRestorePromise);
    this._assertCurrent(request, reader, identityKey);
    return this._envelope(request.kind, request.firesideId);
  }

  _assertCurrent(request, reader, identityKey) {
    if (identityKey !== JSON.stringify(this.getIdentity()) || request.kind === 'fireside' && (reader !== this._room || request.firesideId !== this._roomId)) {
      const error = new Error('连接身份或选定围炉已变化，请重新读取消息。'); error.code = 'SESSION_CHANGED'; throw error;
    }
  }

  async refresh(value) {
    return this._refresh(value, false);
  }

  async requestRead(value) {
    return this._refresh(value, true);
  }

  async _refresh(value, explicit) {
    const request = this._select(value);
    const reader = request.kind === 'bonfire' ? this._bonfire : this._room;
    const identityKey = JSON.stringify(this.getIdentity());
    if (request.kind === 'bonfire' && this._restorePromise) await this.restore();
    if (request.kind === 'fireside' && this._roomRestorePromise) await this._roomRestorePromise;
    this._assertCurrent(request, reader, identityKey);
    if (!this._enabled) { const error = new Error('连接 Being 后再刷新 Town 消息。'); error.code = 'NOT_CONNECTED'; throw error; }
    if (explicit && this.readCachedSnapshot) await reader.requestRead(options => this._requestRead(request.kind, request.firesideId, options));
    else await reader.refresh();
    this._assertCurrent(request, reader, identityKey);
    return this._envelope(request.kind, request.firesideId);
  }

  stop() {
    this._enabled = false;
    this._cacheGeneration++;
    this._roomGeneration++;
    this._bonfire.stop();
    this._room?.stop();
  }
}

module.exports = {TownBackground};
