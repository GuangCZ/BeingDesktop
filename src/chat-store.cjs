'use strict';

// Per-conversation transcripts, the conversation list, and the one global history cursor —
// persisted together in a single encrypted file per Being.
//
// The durable transcript is history and only history: every stored row carries the server's `seq`.
// Live stream text is deliberately not stored. The in-flight bubble lives in the renderer and
// vanishes once history confirms it, which removes the entire class of "the live row and the
// durable row duplicated each other" bugs and costs nothing: a reply cut short by a quit is
// already in the Being's timeline, so the next history read recovers it.
//
// Three invariants ported from Loom's IndexedDB cache (loom.html:3620 / 3600 / 3660):
//   1. Rows and cursor are written in one transaction. Here that is structural rather than
//      procedural — both live in one file, replaced atomically — so the cursor can never move past
//      rows that failed to land, which would make the next `after=` skip them forever.
//   2. Baseline discipline. Before a full baseline exists, increments accumulate in memory but are
//      not persisted: otherwise a `limit=5` cursor sync writes five rows, and the next launch sees
//      only those five with every earlier message unreachable.
//   3. The cursor only moves forward, and the cache is an accelerator rather than the source of
//      truth. With encryption unavailable the store still works in memory and each launch re-reads.

const {sessionFromScene} = require('./being-chat.cjs');
const {unwrapMessage} = require('./orchestration-message.cjs');

const MAX_SESSIONS = 100;
const MAX_ROWS = 300;
const MAX_CONTENT = 100000;
const MAX_TITLE = 120;
const MAX_PAYLOAD = 6 * 1024 * 1024;
// Images are the one thing history cannot give back: the Being keeps the text of a message and
// nothing of its images (measured 2026-09-11). So a row remembers small previews of what was sent
// with it — a local annotation, sized so a transcript full of them still fits the payload budget.
const MAX_ROW_IMAGES = 8;
const MAX_THUMB = 48 * 1024;
const MAX_IMAGE_NAME = 120;
const THUMB = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const IMAGE_TYPE = /^image\/(?:png|jpeg|webp|gif)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const seq = value => Number.isSafeInteger(value) && value > 0;
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const copyRow = row => (row.images ? {...row, images: row.images.map(image => ({...image}))} : {...row});

function storedRow(value) {
  if (!plain(value) || !seq(value.seq) || typeof value.content !== 'string') return null;
  const row = {seq: value.seq, role: value.role === 'user' ? 'user' : 'being', content: (value.role === 'user' ? unwrapMessage(value.content) : value.content).slice(0, MAX_CONTENT), at: text(value.at, 64)};
  if (typeof value.from === 'string') row.from = value.from.slice(0, 64);
  const images = rowImages(value.images);
  if (images.length) row.images = images;
  return row;
}

// Previews of the images a message went out with: `{media_type, name?, thumb?}`, the thumb a small
// data URL. Entries that do not fit are dropped rather than failing the row they annotate.
function rowImages(value) {
  if (!Array.isArray(value)) return [];
  const images = [];
  for (const entry of value.slice(0, MAX_ROW_IMAGES)) {
    if (!plain(entry) || typeof entry.media_type !== 'string' || !IMAGE_TYPE.test(entry.media_type)) continue;
    const image = {media_type: entry.media_type};
    if (typeof entry.name === 'string' && entry.name) image.name = entry.name.slice(0, MAX_IMAGE_NAME);
    if (typeof entry.thumb === 'string' && entry.thumb.length <= MAX_THUMB && THUMB.test(entry.thumb)) image.thumb = entry.thumb;
    images.push(image);
  }
  return images;
}

function storedSession(value) {
  if (!plain(value) || typeof value.id !== 'string' || !UUID.test(value.id) || !Array.isArray(value.rows)) return null;
  const rows = [];
  for (const entry of value.rows.slice(-MAX_ROWS)) {
    const row = storedRow(entry);
    if (!row) return null;
    if (rows.length && row.seq <= rows[rows.length - 1].seq) return null;
    rows.push(row);
  }
  return {
    id: value.id.toLowerCase(), title: text(value.title, MAX_TITLE),
    createdAt: time(value.createdAt) ? value.createdAt : 0,
    truncated: value.truncated === true, rows,
  };
}

// Reject a whole payload rather than silently repair it: a cursor that survived while its rows did
// not is exactly the corruption invariant 1 exists to prevent, so a doubtful file is better re-read.
function snapshot(value) {
  if (!plain(value) || value.version !== 1 || !Number.isSafeInteger(value.cursor) || value.cursor < 0) return null;
  if (typeof value.seeded !== 'boolean' || !Array.isArray(value.sessions) || value.sessions.length > MAX_SESSIONS) return null;
  const sessions = [], seen = new Set();
  for (const entry of value.sessions) {
    const session = storedSession(entry);
    if (!session || seen.has(session.id)) return null;
    if (session.rows.length && session.rows[session.rows.length - 1].seq > value.cursor) return null;
    seen.add(session.id);
    sessions.push(session);
  }
  const active = typeof value.active === 'string' && seen.has(value.active.toLowerCase()) ? value.active.toLowerCase() : '';
  return {version: 1, cursor: value.cursor, seeded: value.seeded, active, sessions};
}

class ChatStore {
  constructor({cache, identityKey = '', desktopId, clock = Date.now, onChange = () => {}} = {}) {
    if (typeof desktopId !== 'string' || !UUID.test(desktopId)) throw new TypeError('Invalid Desktop identity');
    Object.assign(this, {cache, identityKey, desktopId, clock, onChange});
    this._state = {version: 1, cursor: 0, seeded: false, active: '', sessions: []};
    this._loaded = false;
    this._writes = Promise.resolve(true);
    this._failed = false;
  }

  get cursor() { return this._state.cursor; }
  get seeded() { return this._state.seeded; }
  get degraded() { return this._failed; }

  // The cache is an accelerator: a file that will not load leaves an empty store, and the next
  // history read rebuilds everything from the Being.
  async load() {
    if (this._loaded) return this.summary();
    this._loaded = true;
    try {
      const value = await this.cache?.load(this.identityKey);
      const next = value ? snapshot(value) : null;
      if (next) this._state = next;
    } catch { /* An unreadable cache is a cache miss, never a startup failure. */ }
    return this.summary();
  }

  summary() {
    return {
      cursor: this._state.cursor, seeded: this._state.seeded, active: this._state.active, degraded: this._failed,
      sessions: this._state.sessions.map(session => ({
        id: session.id, title: session.title, createdAt: session.createdAt,
        updatedAt: session.rows.at(-1)?.at || session.createdAt, truncated: session.truncated,
        count: session.rows.length, lastSeq: session.rows.length ? session.rows[session.rows.length - 1].seq : 0,
      })),
    };
  }

  rows(sessionId) {
    const session = this._find(sessionId);
    return session ? session.rows.map(copyRow) : [];
  }

  // Annotate a durable row with the previews of the images its message carried. A local fact, so
  // it is persisted without announcing a change: nothing about the transcript's rows moved.
  attach(sessionId, rowSeq, images) {
    const session = this._find(sessionId);
    const row = session && seq(rowSeq) ? session.rows.find(item => item.seq === rowSeq) : null;
    const previews = rowImages(images);
    if (!row || row.images || !previews.length) return false;
    row.images = previews;
    void this._persist();
    return true;
  }

  _find(sessionId) {
    return typeof sessionId === 'string' ? this._state.sessions.find(session => session.id === sessionId.toLowerCase()) || null : null;
  }

  // A conversation exists as soon as it is opened, before any message: the scene name is derived
  // from its id, so the id has to be stable from the start.
  ensure(sessionId, {title = ''} = {}) {
    if (typeof sessionId !== 'string' || !UUID.test(sessionId)) throw new TypeError('Invalid conversation id');
    const id = sessionId.toLowerCase();
    const existing = this._find(id);
    if (existing) return existing;
    const session = {id, title: text(title, MAX_TITLE), createdAt: time(this.clock()) ? this.clock() : 0, truncated: false, rows: []};
    this._state.sessions.push(session);
    // Oldest conversations fall off the list, never the one in front of the user.
    while (this._state.sessions.length > MAX_SESSIONS) {
      const index = this._state.sessions.findIndex(item => item.id !== id && item.id !== this._state.active);
      if (index < 0) break;
      this._state.sessions.splice(index, 1);
    }
    return session;
  }

  rename(sessionId, title) {
    const session = this._find(sessionId);
    if (!session) return false;
    session.title = text(title, MAX_TITLE);
    return true;
  }

  setActive(sessionId) {
    const session = this._find(sessionId);
    this._state.active = session ? session.id : '';
    return !!session;
  }

  forget(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId.toLowerCase() : '';
    const index = this._state.sessions.findIndex(session => session.id === id);
    if (index < 0) return false;
    this._state.sessions.splice(index, 1);
    if (this._state.active === id) this._state.active = '';
    // The cursor stays where it is. Rewinding it to re-read a deleted conversation's rows would
    // re-deliver every other conversation's rows as well.
    return true;
  }

  /**
   * Fold one timeline page into the conversations it belongs to.
   *
   * `baseline` marks a full load rather than an increment, which is what lifts the seeded gate.
   * Rows whose scene names no conversation of ours — another Desktop's, the Loom page's, or the
   * unscoped rows that predate scene support — advance the cursor without being stored.
   */
  async apply({rows = [], cursor = 0, baseline = false} = {}) {
    if (!Array.isArray(rows) || !Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError('Invalid history page');
    let stored = 0, skipped = 0;
    // History never carries images, so a row that comes back keeps the previews the local one had.
    const previews = new Map(this._state.sessions.map(session => [session.id, new Map(session.rows.filter(row => row.images).map(row => [row.seq, row.images]))]));
    if (baseline) for (const session of this._state.sessions) session.rows = [];
    for (const value of rows) {
      const row = storedRow(value);
      const target = row ? sessionFromScene(this.desktopId, value?.scene_id) : '';
      if (!row || !target) { skipped++; continue; }
      // A conversation can arrive from history alone: another Desktop window opened it, or the
      // local list was lost while the Being's timeline kept the scene.
      const session = this.ensure(target);
      const kept = previews.get(session.id)?.get(row.seq);
      if (kept && !row.images) row.images = kept;
      const at = session.rows.findIndex(item => item.seq >= row.seq);
      if (at < 0) session.rows.push(row);
      else if (session.rows[at].seq === row.seq) session.rows[at] = row;
      else session.rows.splice(at, 0, row);
      if (session.rows.length > MAX_ROWS) { session.rows.splice(0, session.rows.length - MAX_ROWS); session.truncated = true; }
      stored++;
    }
    if (baseline) this._state.seeded = true;
    // Invariant 3: the cursor only advances.
    this._state.cursor = Math.max(this._state.cursor, cursor);
    const persisted = await this._persist();
    this.onChange(this.summary());
    return {stored, skipped, cursor: this._state.cursor, persisted};
  }

  async touch() {
    const persisted = await this._persist();
    this.onChange(this.summary());
    return persisted;
  }

  // Invariant 2: nothing is written before a baseline exists, so a small cursor-sync page can
  // never become the whole of the persisted history.
  async _persist() {
    if (!this._state.seeded || !this.cache) return false;
    const payload = this._payload();
    if (!payload) { this._failed = true; return false; }
    // Invariant 1: rows and cursor go out as one atomic replacement, so a failed write leaves the
    // previous complete pair intact instead of a cursor that has outrun its rows.
    const pending = this._writes.then(() => this.cache.save(this.identityKey, payload)).catch(() => false)
      .then(ok => { this._failed = !ok; return ok; });
    this._writes = pending;
    return pending;
  }

  // Trim oldest rows until the snapshot fits the budget. Age is the right thing to give up: the
  // conversation stays readable and `truncated` tells the renderer to offer a re-read.
  _payload() {
    const state = {version: 1, cursor: this._state.cursor, seeded: true, active: this._state.active,
      sessions: this._state.sessions.map(session => ({...session, rows: session.rows.map(copyRow)}))};
    for (let attempt = 0; attempt < MAX_SESSIONS * 4; attempt++) {
      let size;
      try { size = Buffer.byteLength(JSON.stringify(state), 'utf8'); } catch { return null; }
      if (size <= MAX_PAYLOAD) return snapshot(state);
      const widest = state.sessions.filter(session => session.rows.length)
        .sort((left, right) => right.rows.length - left.rows.length)[0];
      if (!widest) return null;
      widest.rows.splice(0, Math.max(1, Math.ceil(widest.rows.length / 8)));
      widest.truncated = true;
      const live = this._find(widest.id);
      if (live) live.truncated = true;
    }
    return null;
  }

  async flush() {
    let pending;
    do { pending = this._writes; await pending.catch(() => false); } while (pending !== this._writes);
    return !this._failed;
  }
}

module.exports = {ChatStore, snapshot};
