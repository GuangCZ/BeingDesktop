'use strict';

// Desktop's own message layer. Talks to the five Being endpoints directly instead of injecting
// scripts into the Loom page, so conversations need no in-body routing protocol:
//   POST /api/chat/stream   send; streams when the Being is idle, splices when it is breathing
//   GET  /api/history       timeline (limit / after)
//   GET  /api/stream/active probe + replay buffer
//   POST /api/stop          interrupt
//   GET  /api/status        being identity
//
// A Desktop conversation is a scene, and the scene name encodes the conversation, so any event or
// history row routes back to its conversation with no registry. `scene_id` is the only routing key
// the server persists; `client_ref` is echoed on meta but never stored, so it only confirms that a
// live stream is the one we asked for.
//
// Measured against a real Being on 2026-09-11 (see docs/desktop-message-layer.md):
//   - Sends are serialized server-side. Two concurrent sends from different scenes both landed, in
//     order, each reply carrying its own scene_id: attribution survives concurrency.
//   - A send that arrives mid-breath returns `202 {"spliced":true}` and gets no stream of its own.
//     Its reply appears on whichever connection is already open, after a meta event with
//     `continuation: true` switches scenes. A connection therefore belongs to no single
//     conversation, and events must be routed by scene rather than filtered to the sender —
//     filtering would drop a spliced reply that no other connection will ever deliver.
//   - Replay events carry scene_id as well, shaped `{event, seq, data}`, so a recovered buffer
//     fans out exactly like a live stream.
//   - Images go as multimodal content blocks (`content: [{type:'text'}, {type:'image'}]`) in place
//     of `message`; the Being sees them directly, without a vision tool. The server accepts only
//     `text`, `image` and `image_url` blocks — an `audio` block is refused with 422 before anything
//     is recorded — and a 9.5 MB PNG went through. History keeps the text alone: the image is not
//     persisted anywhere and the next breath cannot see it. A block list with no text lands no user
//     row at all and the Being answers the previous text instead, so text is required.

const {randomUUID} = require('node:crypto');
const {parseConnection} = require('./security.cjs');

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE = 200000;
const MAX_EVENTS = 5000;
const HISTORY_LIMIT = 100;
// The image envelope measured on 2026-09-11: one 9.5 MB PNG was accepted, so a message's images
// stay within that total. Formats are the ones Loom's attachment path already sent to Heart.
const IMAGE_TYPES = /^image\/(?:png|jpeg|webp|gif)$/;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 8;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MESSAGES = {
  NOT_CONNECTED: '请先连接 Being。',
  SESSION_CHANGED: 'Being 连接已变化，旧请求已取消。',
  INVALID_REQUEST: '请求参数无效。',
  INVALID_RESPONSE: 'Being 返回格式无效。',
  NETWORK_ERROR: '与 Being 的连接中断，请稍后重试。',
  SERVICE_ERROR: 'Being 服务暂时不可用。',
  AUTH_REQUIRED: 'Being 连接凭据无效，请重新连接。',
  ABORTED: '请求已取消。',
  RESULT_UNKNOWN: '发送结果未确认，请刷新后核对再决定是否重发。',
};
const fail = code => Object.assign(new Error(MESSAGES[code] || MESSAGES.SERVICE_ERROR), {code});

// A Desktop conversation maps to exactly one scene, and the mapping is reversible both ways.
function sceneId(desktopId, sessionId) {
  if (!UUID.test(desktopId || '') || !UUID.test(sessionId || '')) throw fail('INVALID_REQUEST');
  return `desktop-${desktopId}-${sessionId}`;
}

// The image blocks of one message: `[{media_type, data}]`, base64 payloads only, within the
// measured envelope. Anything else is refused before the network, like the other inputs.
function imageBlocks(images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images) || images.length > MAX_IMAGES) throw fail('INVALID_REQUEST');
  let total = 0;
  return images.map(image => {
    if (!image || typeof image !== 'object' || Array.isArray(image)) throw fail('INVALID_REQUEST');
    const {media_type: mediaType, data} = image;
    if (typeof mediaType !== 'string' || !IMAGE_TYPES.test(mediaType)) throw fail('INVALID_REQUEST');
    if (typeof data !== 'string' || !data || data.length % 4 !== 0 || !BASE64.test(data)) throw fail('INVALID_REQUEST');
    total += imageBytes(data);
    if (total > MAX_IMAGE_BYTES) throw fail('INVALID_REQUEST');
    return {type: 'image', media_type: mediaType, data};
  });
}

// Decoded size of a base64 payload, without decoding it.
function imageBytes(data) {
  return Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}

// Reverse of sceneId: the routing step for every event and history row. Empty means the scene is
// not one of ours — another Desktop, or the Loom page's own `loom-*` scene on the same Being.
function sessionFromScene(desktopId, scene) {
  if (typeof scene !== 'string' || !UUID.test(desktopId || '')) return '';
  const prefix = `desktop-${desktopId}-`;
  if (!scene.startsWith(prefix)) return '';
  const sessionId = scene.slice(prefix.length);
  return UUID.test(sessionId) ? sessionId : '';
}

// Unlike Loom, a row without a scene predates scene support and belongs to no conversation in
// particular: Desktop multiplexes several conversations on one timeline, so admitting unscoped
// rows would show every old message in every conversation. Separator rows (`from: system`,
// e.g. `[breath yielded to human]`) are unscoped too. Such rows surface only through a session's
// own stored transcript, which is why the renderer must tell the user that pre-scene history is
// hidden rather than let it look like data loss.
function inScene(row, scene) {
  const value = row && typeof row === 'object' ? row.scene_id : null;
  return typeof value === 'string' && value === scene;
}

function historyRow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const seq = Number(value.seq);
  if (!Number.isSafeInteger(seq) || seq <= 0) return null;
  if (typeof value.content !== 'string') return null;
  const role = value.role === 'user' ? 'user' : 'being';
  const row = {seq, role, content: value.content.slice(0, MAX_MESSAGE), at: typeof value.at === 'string' ? value.at.slice(0, 64) : ''};
  if (typeof value.from === 'string') row.from = value.from.slice(0, 64);
  if (typeof value.scene_id === 'string') row.scene_id = value.scene_id.slice(0, 200);
  return row;
}

// SSE reader. Server-Sent Events are framed by blank lines; `data:` lines concatenate.
async function consumeEvents(body, onEvent) {
  if (!body) throw fail('INVALID_RESPONSE');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let pending = '', type = '', data = [], size = 0;
  const flush = () => {
    if (data.length) {
      let parsed;
      try { parsed = JSON.parse(data.join('\n')); } catch { throw fail('INVALID_RESPONSE'); }
      onEvent(type || 'message', parsed);
    }
    type = ''; data = []; size = 0;
  };
  const line = value => {
    if (!value) return flush();
    size += value.length;
    if (size > MAX_BYTES) throw fail('INVALID_RESPONSE');
    if (value.startsWith(':')) return;
    const at = value.indexOf(':');
    const key = at < 0 ? value : value.slice(0, at);
    const content = at < 0 ? '' : value.slice(at + 1).replace(/^ /, '');
    if (key === 'event') type = content;
    if (key === 'data') data.push(content);
  };
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      pending += decoder.decode(part.value, {stream: true});
      let match;
      while ((match = /\r\n|\r(?!$)|\n/.exec(pending))) {
        line(pending.slice(0, match.index));
        pending = pending.slice(match.index + match[0].length);
      }
      if (pending.length + size > MAX_BYTES) throw fail('INVALID_RESPONSE');
    }
    // A truncated trailing event is discarded; history reconciliation recovers it.
  } finally { void reader.cancel().catch(() => {}); }
}

class BeingChat {
  constructor({getContext, desktopId, fetchImpl = globalThis.fetch, onEvent = () => {}, clientVersion = ''} = {}) {
    Object.assign(this, {getContext, desktopId, fetchImpl, onEvent, clientVersion});
    this._epoch = 0;
    this._requests = new Set();
    // client_ref → sessionId for sends still in flight. Routing no longer needs it — the scene
    // name carries that — but the composer does, to show which conversations are awaiting a turn.
    this._pending = new Map();
  }

  reset() {
    this._epoch++;
    for (const controller of this._requests) controller.abort();
    this._requests.clear();
    this._pending.clear();
  }

  inFlight(sessionId) {
    for (const value of this._pending.values()) if (value === sessionId) return true;
    return false;
  }

  _context(expected) {
    const value = this.getContext();
    if (!value?.connected || !value.connection) throw fail('NOT_CONNECTED');
    let connection;
    try { connection = parseConnection(value.connection.url || value.connection); }
    catch { throw fail('NOT_CONNECTED'); }
    const next = {apiBase: connection.apiBase, token: connection.token, revision: value.revision ?? 0, epoch: this._epoch};
    if (expected && (next.apiBase !== expected.apiBase || next.token !== expected.token
      || next.revision !== expected.revision || next.epoch !== expected.epoch)) throw fail('SESSION_CHANGED');
    return next;
  }

  // The chat endpoints authenticate by query token: Authorization is rejected with 403 here,
  // the opposite of the Town client. Verified against a live Being on 2026-09-11.
  _url(ctx, route, query = {}) {
    const url = new URL(ctx.apiBase + route);
    url.searchParams.set('token', ctx.token);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    return url.href;
  }

  async _request(ctx, route, {method = 'GET', query, body, accept = 'application/json', signal, timeoutMs = 30000} = {}) {
    const controller = new AbortController();
    this._requests.add(controller);
    const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    try {
      if (combined.aborted) throw fail('ABORTED');
      const response = await this.fetchImpl(this._url(ctx, route, query), {
        method,
        headers: {Accept: accept, ...(body ? {'Content-Type': 'application/json'} : {})},
        ...(body ? {body: JSON.stringify(body)} : {}),
        signal: combined, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store',
      });
      this._context(ctx);
      if (response.status === 401 || response.status === 403) { void response.body?.cancel().catch(() => {}); throw fail('AUTH_REQUIRED'); }
      if (!response.ok || response.redirected) { void response.body?.cancel().catch(() => {}); throw fail('SERVICE_ERROR'); }
      return {response, controller, signal: combined};
    } catch (error) {
      this._requests.delete(controller); controller.abort();
      this._context(ctx);
      if (signal?.aborted) throw fail('ABORTED');
      if (Object.hasOwn(MESSAGES, error?.code)) throw error;
      throw fail('NETWORK_ERROR');
    }
  }

  async _readJson(ctx, response) {
    if (response.status === 204) return null;
    if (!response.headers.get('content-type')?.includes('application/json')) throw fail('INVALID_RESPONSE');
    let length = 0; const chunks = [];
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > MAX_BYTES) throw fail('INVALID_RESPONSE');
      chunks.push(Buffer.from(chunk));
    }
    this._context(ctx);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw fail('INVALID_RESPONSE'); }
  }

  async _json(ctx, route, options = {}) {
    const {response, controller} = await this._request(ctx, route, options);
    try { return await this._readJson(ctx, response); }
    finally { void response.body?.cancel().catch(() => {}); this._requests.delete(controller); controller.abort(); }
  }

  async status({signal} = {}) {
    const ctx = this._context();
    const value = await this._json(ctx, '/api/status', {signal});
    return {beingName: typeof value?.being_name === 'string' ? value.being_name.slice(0, 100) : ''};
  }

  // One timeline read feeds every conversation: the cursor is global, the projection is per scene.
  // Callers pass `after` from their stored cursor and dispatch rows by scene_id themselves.
  async history({after = 0, limit = HISTORY_LIMIT, signal} = {}) {
    if (!Number.isSafeInteger(after) || after < 0) throw fail('INVALID_REQUEST');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw fail('INVALID_REQUEST');
    const ctx = this._context();
    const value = await this._json(ctx, '/api/history', {query: {limit, ...(after > 0 ? {after} : {})}, signal});
    if (!value || !Array.isArray(value.messages)) throw fail('INVALID_RESPONSE');
    const rows = value.messages.map(historyRow).filter(Boolean).sort((left, right) => left.seq - right.seq);
    // The cursor only moves forward: `fresh` holds rows past `after`, so its last seq exceeds it.
    // Taking the last row of the unfiltered page instead would move the cursor backwards whenever
    // the server ignores `after` — the one thing Loom's cache invariants forbid.
    const fresh = after > 0 ? rows.filter(row => row.seq > after) : rows;
    // A page that came back non-empty yet held nothing new means the server ignored `after`;
    // without this flag the caller cannot tell that apart from "no new messages" and would
    // re-read the same window forever.
    return {
      rows: fresh, cursor: fresh.length ? fresh[fresh.length - 1].seq : after,
      more: fresh.length >= limit, ignoredAfter: after > 0 && rows.length > 0 && fresh.length === 0,
    };
  }

  // Probe whether a stream is still breathing after a disconnect, and read its replay buffer from
  // `after` onward. Ported from Loom's probeStream (loom.html:2593): a client disconnect does not
  // interrupt a breath, so the right move on a broken stream is to ask the server what happened,
  // not to abort and report an error. Verdicts match Loom's so its decision table ports as-is.
  //
  // Replay events are shaped `{event, seq, data}`, seq counting from 1 within the stream; `nextSeq`
  // says where to resume. `scene` is the conversation being spoken to right now — the newest event
  // wins, because a continuation meta can hand the stream to another one. An autonomous breath
  // (origin beating / callback / leftover rather than human) has a stream_id but no events at all,
  // so it can only be waited out and then reconciled from history (loom.html:4011).
  async probe({streamId = '', after = 0, localSeq = 0, signal} = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(localSeq) || localSeq < 0) throw fail('INVALID_REQUEST');
    const ctx = this._context();
    const value = await this._json(ctx, '/api/stream/active', {query: after > 0 ? {after} : {}, signal});
    const empty = {events: [], streamId: '', nextSeq: 0, serverSeq: 0, scene: '', scenes: [], origin: '', autonomous: false, speaking: false, trigger: ''};
    if (value === null) return {verdict: 'gone', ...empty};
    if (!value || typeof value !== 'object') throw fail('INVALID_RESPONSE');
    const active = typeof value.stream_id === 'string' ? value.stream_id.slice(0, 128) : '';
    if (streamId && active && active !== streamId) return {verdict: 'superseded', ...empty, streamId: active};
    const events = (Array.isArray(value.events) ? value.events : []).slice(0, MAX_EVENTS)
      .map(item => item && typeof item === 'object' && !Array.isArray(item)
        ? {type: typeof item.event === 'string' ? item.event : 'message', seq: Number(item.seq) || 0, data: item.data} : null)
      .filter(Boolean);
    const seen = events.map(item => typeof item.data?.scene_id === 'string' ? item.data.scene_id : '').filter(Boolean);
    // With `after`, the buffer is only a tail, so the resume point must come from next_seq.
    const nextSeq = Number.isSafeInteger(value.next_seq) && value.next_seq > 0 ? value.next_seq : after + events.length + 1;
    const origin = typeof value.origin === 'string' ? value.origin.slice(0, 32) : '';
    // After a message_stop the next event may belong to another scene (a continuation), so the
    // buffer cannot say who speaks next: `speaking` is false and ownership must be asked, not guessed.
    const last = events.length ? events[events.length - 1] : null;
    const base = {events, streamId: active, nextSeq, serverSeq: Math.max(0, nextSeq - 1), origin, autonomous: origin !== '' && origin !== 'human',
      scene: seen.length ? seen[seen.length - 1] : '', scenes: [...new Set(seen)], speaking: !!last && last.type !== 'message_stop',
      trigger: typeof value.trigger_message === 'string' ? value.trigger_message.slice(0, 200) : ''};
    if (value.finished === true) return {verdict: 'finished', ...base};
    if (base.serverSeq > localSeq) return {verdict: 'progressing', ...base};
    return {verdict: 'stalled', ...base};
  }

  // Stopping is stream-scoped, never conversation-scoped: /api/stop takes no scene, so it
  // interrupts whatever breath is running — which, after a splice, may be another conversation's.
  // Refuse unless the active stream is provably this conversation's; `force` is the user answering
  // the prompt that refusal produces. Interrupting the wrong conversation leaves its user waiting
  // on an ending that never comes, and may persist a half-reply that reads as a whole one.
  async stop({sessionId, force = false, signal} = {}) {
    const scene = sceneId(this.desktopId, sessionId);
    if (!force) {
      const active = await this.probe({signal});
      if (active.verdict === 'gone' || active.verdict === 'finished') return {stopped: false, reason: 'idle', scene: active.scene};
      // An autonomous breath is the Being thinking for itself; no conversation owns it.
      if (active.autonomous) return {stopped: false, reason: 'autonomous', scene: ''};
      // No scene in the buffer, or a bubble just closed and the next speaker is not yet known:
      // ownership cannot be proven either way, and asking beats guessing.
      if (!active.scene || !active.speaking) return {stopped: false, reason: 'unknown', scene: active.scene};
      if (active.scene !== scene) return {stopped: false, reason: 'other-scene', scene: active.scene};
    }
    const ctx = this._context();
    await this._json(ctx, '/api/stop', {method: 'POST', body: {}, signal}).catch(error => {
      if (error?.code === 'INVALID_RESPONSE') return null;
      throw error;
    });
    return {stopped: true, reason: force ? 'forced' : 'matched', scene};
  }

  /**
   * Send one message on behalf of a conversation, and consume the stream if we are given one.
   *
   * The body carries only what the protocol needs: human text, the scene this conversation is,
   * a small scene declaration, and a correlation ref. No routing headers, no environment prose.
   * With images the text becomes the first of the content blocks; the text is still required,
   * because a message of images alone lands no row (measured 2026-09-11).
   */
  async send({sessionId, text, images = [], sceneMeta = {}, signal, onDelta = () => {}, onProgress = () => {}, router = null} = {}) {
    if (!UUID.test(sessionId || '')) throw fail('INVALID_REQUEST');
    if (typeof text !== 'string' || !text.trim() || text.includes('\0')) throw fail('INVALID_REQUEST');
    if ([...text].length > MAX_MESSAGE) throw fail('INVALID_REQUEST');
    if (!sceneMeta || Object.getPrototypeOf(sceneMeta) !== Object.prototype) throw fail('INVALID_REQUEST');
    const blocks = imageBlocks(images);
    const scene = sceneId(this.desktopId, sessionId);
    const clientRef = `req-${randomUUID()}`;
    const ctx = this._context();
    this._pending.set(clientRef, sessionId);
    const body = {
      ...(blocks.length ? {content: [{type: 'text', text}, ...blocks]} : {message: text}),
      scene_id: scene,
      scene_meta: {client: `being-desktop/${this.clientVersion || '0'}`, ...sceneMeta},
      client_ref: clientRef,
    };
    let dispatched = false;
    try {
      const {response, controller, signal: live} = await this._request(ctx, '/api/chat/stream',
        {method: 'POST', body, accept: 'text/event-stream', signal, timeoutMs: 600000});
      dispatched = true;
      try {
        // 202: spliced into the running breath. The message is delivered — treating this as a
        // failure would make the user resend and queue a duplicate — but the reply will surface
        // on another conversation's open connection or through catch-up, not here.
        if (response.status === 202) {
          const value = await this._readJson(ctx, response).catch(() => null);
          this.onEvent({sessionId, type: 'spliced', scene});
          return {ok: true, streamed: false, spliced: value?.spliced !== false, streamId: '', clientRef, confirmed: false, replies: 0, liveSeq: 0, foreign: 0, trailing: ''};
        }
        if (!response.headers.get('content-type')?.includes('text/event-stream')) throw fail('INVALID_RESPONSE');
        return await this._consume(ctx, {response, scene, clientRef, sessionId, onDelta, onProgress, live, router});
      } finally { void response.body?.cancel().catch(() => {}); this._requests.delete(controller); controller.abort(); }
    } catch (error) {
      // Once the POST is accepted the message may already be in the Being's timeline, so nothing
      // that fails afterwards may claim it was not sent — not a broken stream, not a reconnect,
      // not the user cancelling. Only pre-dispatch errors describe a send that did not happen.
      if (dispatched) throw Object.assign(fail('RESULT_UNKNOWN'), error?.progress ? {progress: error.progress} : {});
      throw error;
    } finally { this._pending.delete(clientRef); }
  }

  async _consume(ctx, {response, scene, clientRef, sessionId, onDelta, onProgress, live, router}) {
    router = router || this.router({scene, sessionId, onDelta, onProgress});
    router.expect(clientRef);
    try {
      await consumeEvents(response.body, (type, data) => {
        this._context(ctx);
        // Stop reading on our own account rather than waiting for the socket to notice the abort.
        if (live?.aborted) throw fail('ABORTED');
        router.handle(type, data);
      });
    } catch (error) {
      // How far the stream got is what recovery needs: the probe resumes from this seq.
      throw Object.assign(error, {progress: router.state()});
    }
    return {ok: true, streamed: true, spliced: false, clientRef, ...router.state()};
  }

  // Fold a replay buffer in by exactly the rules that fold a live stream. Events at or before
  // `from` were already delivered and are skipped; the return value says where the next probe
  // should resume. `sessionId` is the conversation that asked, if any — recovery of a stream we did
  // not start has none, and then no conversation is "ours" beyond what each event's scene says.
  replay({events = [], from = 0, router = null, sessionId = '', scene = ''} = {}) {
    if (!Array.isArray(events) || !Number.isSafeInteger(from) || from < 0) throw fail('INVALID_REQUEST');
    router = router || this.router({scene, sessionId});
    let cursor = from;
    for (const item of events) {
      if (!item || typeof item !== 'object') continue;
      const seq = Number(item.seq);
      if (Number.isFinite(seq) && seq <= cursor) continue;
      const type = typeof item.type === 'string' ? item.type : typeof item.event === 'string' ? item.event : 'message';
      router.handle(type, item.data ?? {});
      if (Number.isFinite(seq)) cursor = Math.max(cursor, seq);
    }
    return {cursor, ...router.state()};
  }

  /**
   * The per-event routing for one stream. Shared by the live reader and the replay path so a
   * recovered buffer and a live stream can never disagree about which conversation a reply is in.
   *
   * A router outlives a connection on purpose: when a live reader dies and the replay poller takes
   * over from its last seq, the same router carries the half-built reply text across, so the text
   * joins with not one character repeated or missing (Loom's cutoverToReplay, loom.html:2615).
   */
  router({scene = '', sessionId = '', onDelta = () => {}, onProgress = () => {}} = {}) {
    let streamId = '', liveSeq = 0, confirmed = false, current = scene, replies = 0, foreign = 0, clientRef = '';
    // One connection carries several conversations, so reply text accumulates per conversation.
    // A single connection-wide buffer would splice one Being's answer into another's bubble.
    const buffers = new Map();
    const emit = (target, event) => { if (!target) return; try { this.onEvent({sessionId: target, ...event}); } catch { /* Observers cannot affect the stream. */ } };
    const handle = (type, data) => {
      // meta never enters the server replay buffer and never consumes a seq. Every other event
      // does, exactly once: that 1:1 property is what lets a probe resume a stream mid-flight.
      if (type !== 'meta') liveSeq++;
      const eventScene = typeof data?.scene_id === 'string' ? data.scene_id : '';
      if (type === 'meta' && typeof data?.stream_id === 'string') streamId = data.stream_id;
      // Connection-level progress, before routing: a watchdog must see foreign events too, or its
      // idea of the stream's seq falls behind the server's and every probe looks like progress.
      try { onProgress({type, liveSeq, streamId}); } catch { /* Observers cannot affect the stream. */ }
      if (type === 'meta') {
        // client_ref is echoed here and nowhere else; it proves this stream is our request.
        if (clientRef && typeof data?.client_ref === 'string' && data.client_ref === clientRef) confirmed = true;
        // `continuation: true` hands the connection to whatever scene this meta names.
        if (eventScene) current = eventScene;
        emit(sessionFromScene(this.desktopId, current) || sessionId, {type: 'meta', streamId, scene: current, confirmed});
        return;
      }
      // Scene-addressed events route by their own scene; usage/error carry none and belong to
      // whichever conversation the last meta handed the connection to.
      const target = sessionFromScene(this.desktopId, eventScene || current);
      // A foreign scene is another Desktop's conversation, or the Loom page's own, on this same
      // Being. Dropping it is correct; counting it keeps that decision visible in diagnostics.
      if (!target) { foreign++; return; }
      if (type === 'error') { emit(target, {type: 'error', message: String(data?.message || '').slice(0, 2000)}); return; }
      // `reasoning` is the thinking stream. It is shown live but not folded into the reply text,
      // so a stop mid-thought cannot leave reasoning persisted as if it were the answer.
      if (type === 'reasoning') {
        const think = typeof data?.text === 'string' ? data.text : '';
        if (think) emit(target, {type: 'think', text: think});
        return;
      }
      if (type === 'content_block_delta') {
        const delta = typeof data?.delta?.text === 'string' ? data.delta.text : '';
        if (!delta) return;
        const buffer = (buffers.get(target) || '') + delta;
        if (buffer.length > MAX_MESSAGE) throw fail('INVALID_RESPONSE');
        buffers.set(target, buffer);
        if (target === sessionId) onDelta(delta);
        emit(target, {type: 'delta', text: delta});
        return;
      }
      if (type === 'message_stop') {
        // A yielded breath emits several message_stop events, and after a splice the later ones
        // belong to another conversation. Each closes only its own conversation's bubble.
        const buffer = buffers.get(target) || '';
        buffers.delete(target);
        if (target === sessionId) replies++;
        emit(target, {type: 'reply', text: buffer});
        return;
      }
      emit(target, {type, data});
    };
    const state = () => ({streamId, confirmed, replies, liveSeq, foreign, trailing: sessionId ? buffers.get(sessionId) || '' : ''});
    // A writer that ends for good settles its router: the conversations whose bubble is still open
    // are returned so they can be told, and the buffers are dropped so a second settle is a no-op.
    const settle = () => { const open = [...buffers.entries()].filter(([, text]) => text).map(([target]) => target); buffers.clear(); return open; };
    return {handle, state, settle, expect: ref => { clientRef = typeof ref === 'string' ? ref : ''; }, get sessionId() { return sessionId; }};
  }
}

module.exports = {BeingChat, consumeEvents, sceneId, sessionFromScene, inScene, historyRow, imageBlocks, imageBytes, IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES};
