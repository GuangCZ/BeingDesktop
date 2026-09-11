'use strict';

// Desktop-native conversations: the one object the main process and the renderer talk to.
// Binds a BeingChat, a ChatStore and a BeingRecovery to one Being identity at a time, keeps the
// transient state history cannot hold yet — the message just sent, the reply being streamed — and
// projects everything as plain data for IPC.
//
// Transient items are confirmed, never persisted: a sent message and a finished reply stay in
// memory only until a history row with the same text arrives for that conversation, then the
// durable row replaces them. If confirmation never comes they expire rather than linger.
//
// Each item remembers the newest row that existed when it was made (`after`), so the renderer can
// place it after what it followed rather than below whatever landed later.

const {BeingChat, sceneId, imageBytes, IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES} = require('./being-chat.cjs');
const {ChatStore} = require('./chat-store.cjs');
const {BeingRecovery} = require('./being-recovery.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TITLE = 80;
const MAX_TEXT = 200000;
// An item nobody confirms expires once this many reads have landed new rows for its conversation
// without one matching. Reads that land nothing prove nothing, and neither does renaming a session.
const CONFIRM_MISSES = 3;
// A false confirmation only retires a preview a moment early (the durable row is the truth); a
// missed one shows a cut-off bubble next to its own row until it expires. So the guard is low:
// enough to refuse 「好」 or "OK", not a full sentence.
const PREFIX_MIN = 8;
const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
const fail = (code, message) => Object.assign(new Error(message), {code});
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const THUMB = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_THUMB = 48 * 1024;
const MAX_IMAGE_NAME = 120;

// The images of one message as the renderer hands them over: the bytes to send, and a preview to
// keep. The bytes go to the Being and are gone; the preview is what the transcript remembers.
function splitImages(images) {
  if (images === undefined || images === null) return {blocks: [], previews: []};
  if (!Array.isArray(images)) throw fail('INVALID_REQUEST', '图片参数无效。');
  if (images.length > MAX_IMAGES) throw fail('INVALID_REQUEST', `一条消息最多 ${MAX_IMAGES} 张图片。`);
  const blocks = [], previews = [];
  let total = 0;
  for (const image of images) {
    if (!image || typeof image !== 'object' || Array.isArray(image)) throw fail('INVALID_REQUEST', '图片参数无效。');
    const {media_type: mediaType, data, name, thumb} = image;
    if (typeof mediaType !== 'string' || !IMAGE_TYPES.test(mediaType)) throw fail('INVALID_REQUEST', '图片格式仅支持 PNG、JPEG、WebP、GIF。');
    if (typeof data !== 'string' || !data || data.length % 4 !== 0 || !BASE64.test(data)) throw fail('INVALID_REQUEST', '图片数据无效，请重新添加。');
    total += imageBytes(data);
    if (total > MAX_IMAGE_BYTES) throw fail('INVALID_REQUEST', '一条消息的图片合计不能超过 10 MB。');
    blocks.push({media_type: mediaType, data});
    const preview = {media_type: mediaType};
    if (typeof name === 'string' && name.trim()) preview.name = name.trim().slice(0, MAX_IMAGE_NAME);
    if (typeof thumb === 'string' && thumb.length <= MAX_THUMB && THUMB.test(thumb)) preview.thumb = thumb;
    previews.push(preview);
  }
  return {blocks, previews};
}

class ChatSessions {
  constructor({getContext, desktopId, cache = null, clientVersion = '', fetchImpl, timers, clock = Date.now, randomUUID = require('node:crypto').randomUUID, onEvent = () => {}, onState = () => {}} = {}) {
    if (typeof desktopId !== 'string' || !UUID.test(desktopId)) throw new TypeError('Invalid Desktop identity');
    Object.assign(this, {getContext, desktopId, cache, clientVersion, fetchImpl, timers, clock, randomUUID, onEvent, onState});
    this.chat = new BeingChat({getContext, desktopId, clientVersion, ...(fetchImpl ? {fetchImpl} : {})});
    this.store = null; this.recovery = null; this.identityKey = '';
    this._transient = new Map();
    this._version = 0;
  }

  get open() { return this.recovery !== null; }

  _touch() { this._version++; try { this.onState(this.snapshot()); } catch { /* Observers cannot affect the session. */ } }

  _emit(event) { try { this.onEvent(event); } catch { /* Observers cannot affect the session. */ } }

  // `cut` is where the reply's final text block starts (the text before the last tool call);
  // `seen` is the newest row seq the last confirmation pass looked at.
  _slot(sessionId) {
    let slot = this._transient.get(sessionId);
    if (!slot) { slot = {sent: [], replied: [], live: null, think: '', cut: 0, seen: this._lastSeq(sessionId)}; this._transient.set(sessionId, slot); }
    return slot;
  }

  _lastSeq(sessionId) {
    return this.store?.summary().sessions.find(session => session.id === sessionId)?.lastSeq || 0;
  }

  _now() { return new Date(this.clock()).toISOString(); }

  // Bind to one Being. The cache key is the connection identity, so switching Beings switches files.
  async start(identityKey) {
    if (typeof identityKey !== 'string' || !identityKey) throw new TypeError('Invalid identity key');
    this.end();
    this.identityKey = identityKey;
    const store = new ChatStore({cache: this.cache, identityKey, desktopId: this.desktopId, clock: this.clock, onChange: () => this._confirm()});
    this.store = store;
    this.recovery = new BeingRecovery({chat: this.chat, store, ...(this.timers ? {timers: this.timers} : {}), clock: this.clock,
      onEvent: event => this._onEvent(event), onState: () => this._touch()});
    await store.load();
    if (this.store !== store) return this.snapshot();
    if (!store.summary().sessions.length) store.ensure(this.randomUUID(), {title: '新会话'});
    if (!store.summary().active) store.setActive(store.summary().sessions[0].id);
    this._touch();
    await this.recovery.reconcile({full: !store.seeded});
    if (this.store !== store) return this.snapshot();
    void this.recovery.checkActiveStream();
    this._touch();
    return this.snapshot();
  }

  // Unbind from the Being. Distinct from stop(): that interrupts one conversation's breath.
  end() {
    if (this.recovery) this.recovery.dispose();
    this.chat.reset();
    this.recovery = null; this.store = null; this.identityKey = '';
    this._transient.clear();
    this._touch();
  }

  _require() {
    if (!this.store || !this.recovery) throw fail('NOT_CONNECTED', '请先连接 Being。');
    return {store: this.store, recovery: this.recovery};
  }

  snapshot() {
    const summary = this.store ? this.store.summary() : {cursor: 0, seeded: false, active: '', degraded: false, sessions: []};
    return {
      open: this.open, version: this._version, identityKey: this.identityKey ? 'bound' : '',
      active: summary.active, cursor: summary.cursor, seeded: summary.seeded, degraded: summary.degraded,
      sessions: summary.sessions.map(session => {
        const slot = this._transient.get(session.id);
        return {...session, busy: !!(slot && (slot.live || slot.sent.length)), inFlight: this.chat.inFlight(session.id)};
      }),
      recovery: this.recovery ? this.recovery.state() : {phase: 'idle'},
    };
  }

  // Everything the renderer draws for one conversation: durable rows, then the transient tail.
  view(sessionId) {
    const {store} = this._require();
    if (!store.summary().sessions.some(session => session.id === sessionId)) throw fail('INVALID_REQUEST', '会话不存在。');
    const slot = this._transient.get(sessionId);
    const item = ({misses, ...rest}) => rest;
    return {
      sessionId, version: this._version, rows: store.rows(sessionId),
      sent: slot ? slot.sent.map(item) : [],
      replied: slot ? slot.replied.map(item) : [],
      live: slot?.live ? {text: slot.live.text, think: slot.think, at: slot.live.at} : null,
    };
  }

  create({title = ''} = {}) {
    const {store} = this._require();
    const id = this.randomUUID();
    store.ensure(id, {title: normalize(title).slice(0, MAX_TITLE) || '新会话'});
    store.setActive(id);
    void store.touch();
    this._touch();
    return id;
  }

  select(sessionId) {
    const {store} = this._require();
    if (!store.setActive(sessionId)) throw fail('INVALID_REQUEST', '会话不存在。');
    void store.touch();
    this._touch();
    return true;
  }

  rename(sessionId, title) {
    const {store} = this._require();
    const clean = normalize(title);
    if (!clean || clean.length > MAX_TITLE) throw fail('INVALID_REQUEST', '会话名须为 1–80 个字符。');
    if (!store.rename(sessionId, clean)) throw fail('INVALID_REQUEST', '会话不存在。');
    void store.touch();
    this._touch();
    return true;
  }

  forget(sessionId) {
    const {store} = this._require();
    if (this.chat.inFlight(sessionId)) throw fail('BUSY', '该会话正在等待回复，稍后再删除。');
    if (!store.forget(sessionId)) throw fail('INVALID_REQUEST', '会话不存在。');
    this._transient.delete(sessionId);
    if (!store.summary().sessions.length) store.ensure(this.randomUUID(), {title: '新会话'});
    if (!store.summary().active) store.setActive(store.summary().sessions[0].id);
    void store.touch();
    this._touch();
    return true;
  }

  /**
   * Send for a conversation. The message shows at once as `sent` and is confirmed by history; the
   * reply streams as `live`, closes into `replied`, and is confirmed the same way.
   *
   * Images ride along as content blocks and need text with them: a message of images alone lands
   * no row and the Being answers the previous text (measured 2026-09-11). History will confirm the
   * text; the previews move onto the confirming row, since history holds nothing of the images.
   */
  async send({sessionId, text, images} = {}) {
    const {store, recovery} = this._require();
    const session = store.summary().sessions.find(item => item.id === sessionId);
    if (!session) throw fail('INVALID_REQUEST', '会话不存在。');
    const {blocks, previews} = splitImages(images);
    if (typeof text !== 'string' || !text.trim()) throw fail('INVALID_REQUEST', blocks.length ? '图片需要配一句话一起发送。' : '消息不能为空。');
    if ([...text].length > MAX_TEXT) throw fail('INVALID_REQUEST', '消息过长。');
    const slot = this._slot(sessionId);
    const item = {text, at: this._now(), after: this._lastSeq(sessionId), misses: 0, ...(previews.length ? {images: previews} : {})};
    slot.sent.push(item);
    this._touch();
    this._emit({sessionId, type: 'sent', text, images: previews.length});
    try {
      // scene_meta carries the static identity of this conversation, not prose about tools.
      const result = await recovery.send({sessionId, text, images: blocks, sceneMeta: {scene_label: session.title || '桌面会话'}});
      return {ok: true, streamed: result.streamed === true, spliced: result.spliced === true, recovering: result.recovering || ''};
    } catch (error) {
      // Pre-dispatch failures only: the message never left, so it must not look sent.
      slot.sent = slot.sent.filter(entry => entry !== item);
      this._touch();
      throw error;
    }
  }

  async stop({sessionId, force = false} = {}) {
    const {recovery} = this._require();
    if (typeof sessionId !== 'string' || !UUID.test(sessionId)) throw fail('INVALID_REQUEST', '会话不存在。');
    const result = await recovery.stop({sessionId, force: force === true});
    // The refusal names the conversation whose breath it is, if it is one of ours.
    const owner = result.scene ? this.store?.summary().sessions.find(item => sceneId(this.desktopId, item.id) === result.scene) : null;
    return {...result, ownerTitle: owner ? owner.title : ''};
  }

  // Re-read the newest window as a fresh baseline: the "load again" the renderer offers when a
  // transcript was trimmed, and the recovery for a cache that went stale.
  async reload() {
    const {recovery} = this._require();
    const result = await recovery.reconcile({full: true});
    this._touch();
    return {ok: !result.error, added: result.added, error: result.error};
  }

  _onEvent(event) {
    const {sessionId, type} = event;
    if (!sessionId) return;
    const slot = this._slot(sessionId);
    if (type === 'delta') { slot.live = slot.live || {text: '', at: this._now()}; slot.live.text += event.text; }
    else if (type === 'think') { slot.live = slot.live || {text: '', at: this._now()}; slot.think += event.text; }
    // A tool call closes a text block. The Being persists only the block after its last tool call
    // (measured 2026-09-11: 「我去翻记忆。」→ remember → 「翻完了…」 stores 「翻完了…」 alone), so the
    // final block is what history will confirm, while the whole text is what was said.
    else if (type === 'tool_use') { if (slot.live) slot.cut = slot.live.text.length; }
    else if (type === 'reply') {
      // One item per message_stop, never per breath: history stores each stop as its own row.
      // A partial this reply completes (a replay from seq 0 re-streams what a broken connection
      // had half delivered) is superseded by it. Its time is the close, like the row's will be.
      if (event.text) {
        slot.replied = slot.replied.filter(item => !(item.partial && event.text.startsWith(item.text)));
        slot.replied.push(this._replied(sessionId, slot, event.text));
      }
      slot.live = null; slot.think = ''; slot.cut = 0;
      // The row may have landed already (a replay of a reply history holds): retire at once.
      this._confirm(sessionId);
    }
    else if (type === 'settled') {
      // The writer ended without closing this bubble: keep what arrived as a partial so history
      // can confirm it (a prefix match) or retire it, instead of a cursor that blinks forever.
      if (slot.live?.text) slot.replied.push({...this._replied(sessionId, slot, slot.live.text), partial: true});
      slot.live = null; slot.think = ''; slot.cut = 0;
      this._confirm(sessionId);
    }
    else if (type === 'error') { slot.live = null; slot.think = ''; slot.cut = 0; this._touch(); }
    this._emit(event);
  }

  _replied(sessionId, slot, text) {
    const cut = Math.min(slot.cut, text.length);
    return {text, final: cut ? text.slice(cut) : text, think: slot.think, at: this._now(), after: this._lastSeq(sessionId), misses: 0};
  }

  // Durable rows confirm transient items: a matching text for that conversation retires the
  // item. Items nobody confirms after a few more rows have landed expire, so a transcript can
  // never show the same message twice or keep a ghost forever.
  //
  // Matching tolerates a prefix in either direction, because an interrupted stream leaves us a
  // prefix of what the Being persisted, and a trimmed persistence leaves the Being a prefix of what
  // we streamed. Short prefixes are refused so 「好」 cannot confirm against any row starting with it.
  // A reply matches by its whole text or by its final block, since that block is all the Being
  // keeps of a reply that called tools.
  _confirm(only = '') {
    if (!this.store) return;
    for (const [sessionId, slot] of this._transient) {
      if (only && sessionId !== only) continue;
      const lastSeq = this._lastSeq(sessionId);
      // A miss is a read that landed rows for this conversation without confirming the item.
      const landed = lastSeq > slot.seen;
      slot.seen = lastSeq;
      if (!slot.sent.length && !slot.replied.length) continue;
      const byRole = {user: [], being: []};
      for (const row of this.store.rows(sessionId)) byRole[row.role]?.push({seq: row.seq, text: normalize(row.content), images: row.images});
      const matches = (full, mine) => full === mine || (Math.min(full.length, mine.length) >= PREFIX_MIN && (full.startsWith(mine) || mine.startsWith(full)));
      // The confirming row. A sent message's row cannot predate the send, so only rows that landed
      // after the item was made count for it — an older row saying the same words is not its
      // record and must not take its previews. A reply's row may already be there when the reply
      // closes (history read during a replay), so any matching row retires a reply.
      const confirming = (item, role, strict, ...texts) => {
        let found = null;
        for (const text of texts) {
          const mine = normalize(text);
          if (!mine) continue;
          for (const row of byRole[role]) {
            if (!matches(row.text, mine)) continue;
            if (row.seq > (item.after || 0)) return row;
            if (!strict) found = found || row;
          }
        }
        return found;
      };
      const keep = (item, role, strict, ...texts) => {
        const row = confirming(item, role, strict, ...texts);
        if (row) {
          if (item.images && !row.images) this.store.attach(sessionId, row.seq, item.images);
          return false;
        }
        if (landed) item.misses = (item.misses || 0) + 1;
        return (item.misses || 0) < CONFIRM_MISSES;
      };
      slot.sent = slot.sent.filter(item => keep(item, 'user', true, item.text));
      slot.replied = slot.replied.filter(item => keep(item, 'being', false, item.text, item.final));
    }
    this._touch();
  }
}

module.exports = {ChatSessions};
