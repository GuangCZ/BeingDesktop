'use strict';
// Public SDK protocol: jeremyliu16/beings-town-client-sdk, 2026-09-10.
const {validateTownToolResult} = require('./being-town-reader.cjs');
const {libraryRoute, libraryQuery} = require('./town-library-contract.cjs');
const ORIGIN = 'https://beings.town';
const MAX = 1024 * 1024;
const IDENTITY_QUERY = {since_id: '9223372036854775807'};
const ROUTES = new Map([
  ['/api/bonfire/hear', ['since', 'limit', 'compact']], ['/api/bonfire/mentions', ['since_id']],
  ['/api/fireside/list', []], ['/api/fireside/members', ['fireside_id']], ['/api/fireside/hear', ['fireside_id', 'since', 'limit', 'compact']],
  ['/api/messages', []],
]);
const MESSAGES = {AUTH_REQUIRED: '请用 Being 提供的六位配对码连接 Town。', IDENTITY_MISMATCH: 'Town 授权身份与当前 Being 不一致，请重新配对。',
  NOT_CONNECTED: '请先连接 Being。', SESSION_CHANGED: 'Being 连接已变化，旧 Town 请求已取消。', INVALID_REQUEST: 'Town 请求参数无效。',
  INVALID_RESPONSE: 'Town 返回格式无效，已保留上次同步内容。', NETWORK_ERROR: 'Town 连接中断，请稍后重试。', RATE_LIMITED: 'Town 请求过于频繁，请稍后重试。',
  SERVICE_ERROR: 'Town 服务暂时不可用。', ABORTED: 'Town 请求已取消。', BUSY: 'Town 正在配对，请等待完成。',
  NOT_SENT: '本次消息未发送。', RESULT_UNKNOWN: '发送结果未确认，请刷新消息核对后再决定是否重发。'};
const fail = code => Object.assign(new Error(MESSAGES[code] || MESSAGES.SERVICE_ERROR), {code});
const failWith = (code, message) => Object.assign(new Error(message), {code});
// Bonfire truncates past its limit silently; fireside returns 400. Both are rejected locally instead.
const SPEAK_LIMIT = {bonfire: 4000, fireside: 32000};
function readQuery(route, query = {}) {
  if (libraryRoute(route)) return libraryQuery(route, query);
  if (!ROUTES.has(route) || !query || Object.getPrototypeOf(query) !== Object.prototype || Object.keys(query).some(k => !ROUTES.get(route).includes(k))) throw fail('INVALID_REQUEST');
  for (const [key, value] of Object.entries(query)) {
    if (key === 'since_id') { if (value !== IDENTITY_QUERY.since_id) throw fail('INVALID_REQUEST'); }
    else if (key === 'compact') { if (![true, false, 'true', 'false'].includes(value)) throw fail('INVALID_REQUEST'); }
    else if (!['string', 'number'].includes(typeof value) || typeof value === 'string' && !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < (key === 'since' ? 0 : 1) || key === 'limit' && Number(value) > 200) throw fail('INVALID_REQUEST');
  }
  if (route === '/api/bonfire/mentions' && query.since_id !== IDENTITY_QUERY.since_id || ['/api/fireside/hear', '/api/fireside/members'].includes(route) && !query.fireside_id) throw fail('INVALID_REQUEST');
  return query;
}
async function consumeEvents(body, onEvent, onActivity = () => {}) {
  if (!body) throw fail('INVALID_RESPONSE');
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', {fatal: true});
  let pending = '', type = '', data = [], size = 0;
  function line(value) {
    if (!value) { if (data.length) { let parsed; try { parsed = JSON.parse(data.join('\n')); } catch { throw fail('INVALID_RESPONSE'); } onEvent(type, parsed); } type = ''; data = []; size = 0; return; }
    size += value.length; if (size > MAX) throw fail('INVALID_RESPONSE');
    if (value.startsWith(':')) return;
    const at = value.indexOf(':'), key = at < 0 ? value : value.slice(0, at), content = at < 0 ? '' : value.slice(at + 1).replace(/^ /, '');
    if (key === 'event') type = content;
    if (key === 'data') data.push(content);
  }
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break; onActivity();
      pending += decoder.decode(part.value, {stream: true});
      let match;
      while ((match = /\r\n|\r(?!$)|\n/.exec(pending))) { line(pending.slice(0, match.index)); pending = pending.slice(match.index + match[0].length); }
      if (pending.length + size > MAX) throw fail('INVALID_RESPONSE');
    }
    // Incomplete EOF events are discarded; reconnect reconciles via REST.
  } finally { void reader.cancel().catch(() => {}); }
}
class TownClient {
  constructor({getContext, store, fetchImpl = globalThis.fetch, onChange = () => {}, onEvent = () => {}, retryMs = 1000}) {
    Object.assign(this, {getContext, store, fetchImpl, onChange, onEvent, retryMs});
    this._epoch = 0; this._requests = new Set(); this._token = null; this._verified = ''; this._stream = null; this._timer = null; this._enabled = false; this._pairing = false;
    this._state = {status: 'unpaired', paired: false, beingId: '', errorCode: ''};
  }
  state() { return {...this._state}; }
  _set(value) { if (Object.keys(value).every(key => this._state[key] === value[key])) return; Object.assign(this._state, value); try { this.onChange(this.state()); } catch {} }
  _context(expected) {
    const c = this.getContext();
    if (!c?.connected || !c.key || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(c.beingId)) throw fail('NOT_CONNECTED');
    const next = {key: c.key, beingId: c.beingId, revision: c.revision, epoch: this._epoch};
    if (expected && JSON.stringify(next) !== JSON.stringify(expected)) throw fail('SESSION_CHANGED');
    return next;
  }
  reset() {
    this._epoch++; this._enabled = false; clearTimeout(this._timer); this._timer = null;
    for (const c of this._requests) c.abort(); this._requests.clear(); this._stream = null; this._token = null; this._verified = '';
    this._set({status: 'unpaired', paired: false, beingId: '', errorCode: ''});
  }
  async _credential(ctx) {
    if (!this._token) { const token = await this.store.load(ctx.key, ctx.beingId); this._context(ctx); this._token = token; }
    if (!this._token) throw fail('AUTH_REQUIRED');
    this._set({paired: true, beingId: ctx.beingId});
    return this._token;
  }
  async _json(route, {ctx, query, token, body, signal, write = false} = {}) {
    const controller = new AbortController(); this._requests.add(controller);
    const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
    const url = new URL(route, ORIGIN); for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
    try {
      if (combined.aborted) throw fail('ABORTED');
      const res = await this.fetchImpl(url.href, {method: body ? 'POST' : 'GET', headers: {Accept: 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {}), ...(body ? {'Content-Type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {}), signal: combined, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store'});
      try {
        this._context(ctx);
        if (res.status === 401) throw fail('AUTH_REQUIRED');
        // A client token is never forbidden on a read; on speak, 403 means "not a member of this fireside".
        if (res.status === 403) throw write ? failWith('NOT_SENT', '你不是该围炉的成员；本次消息未发送。') : fail('AUTH_REQUIRED');
        if (res.status === 429) throw fail('RATE_LIMITED');
        if (write && res.status === 400) throw failWith('NOT_SENT', 'Town 拒绝了本次发送参数；消息未发送。');
        if (!res.ok || res.redirected) throw fail('SERVICE_ERROR');
        if (!res.headers.get('content-type')?.includes('application/json') || Number(res.headers.get('content-length')) > MAX) throw fail('INVALID_RESPONSE');
        let length = 0; const chunks = [];
        for await (const chunk of res.body) { length += chunk.length; if (length > MAX) throw fail('INVALID_RESPONSE'); chunks.push(Buffer.from(chunk)); }
        this._context(ctx);
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || value.ok === false || Object.hasOwn(value, 'error')) throw fail('INVALID_RESPONSE');
        return value;
      } finally { void res.body?.cancel().catch(() => {}); }
    } catch (error) {
      this._context(ctx);
      if (signal?.aborted) throw fail('ABORTED');
      // Errors raised above already carry their own wording; only opaque failures are classified here.
      if (Object.hasOwn(MESSAGES, error.code)) throw error;
      const code = error instanceof SyntaxError ? 'INVALID_RESPONSE' : 'NETWORK_ERROR';
      // A write may already have reached Town. Never report an unconfirmed send as "not sent".
      throw fail(write && code === 'NETWORK_ERROR' ? 'RESULT_UNKNOWN' : code);
    } finally { controller.abort(); this._requests.delete(controller); }
  }
  async pair(value) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(k => k !== 'code') || typeof value.code !== 'string' || !/^[A-Z2-9]{6}$/.test(value.code.toUpperCase())) throw fail('INVALID_REQUEST');
    if (this._pairing) throw fail('BUSY');
    this._pairing = true;
    try {
      const ctx = this._context();
      this.store.assertAvailable?.();
      const data = await this._json('/api/client/pair/confirm', {ctx, body: {being_id: ctx.beingId, code: value.code.toUpperCase()}});
      if (data.being_id !== ctx.beingId || !/^[a-f0-9]{64}$/.test(data.token)) throw fail('IDENTITY_MISMATCH');
      await this.store.save(ctx.key, ctx.beingId, data.token); this._context(ctx);
      this.reset(); this._token = data.token; this._set({status: 'connecting', paired: true, beingId: ctx.beingId, errorCode: ''});
      this.lifecycle({enabled: true}); return this.state();
    } finally { this._pairing = false; }
  }
  async forget() { if (this._pairing) throw fail('BUSY'); const ctx = this._context(); this.reset(); await this.store.remove(ctx.key); return this.state(); }
  async read(route, {query = {}, signal} = {}) {
    query = readQuery(route, query);
    if (['/api/bonfire/hear', '/api/fireside/hear'].includes(route)) query = {compact: false, ...query};
    const ctx = this._context(); const token = await this._credential(ctx);
    if (this._verified !== ctx.key) {
      const identity = await this._json('/api/bonfire/mentions', {ctx, query: IDENTITY_QUERY, token, signal});
      if (identity.being !== ctx.beingId) throw fail('IDENTITY_MISMATCH');
      this._verified = ctx.key;
    }
    const value = await this._json(route, {ctx, query, token, signal}); this._context(ctx);
    return validateTownToolResult(value, route, ctx.beingId, query);
  }
  async speak(value) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).some(key => !['kind', 'message', 'firesideId', 'replyTo', 'signal'].includes(key))) throw fail('INVALID_REQUEST');
    const {kind, message, firesideId = '', replyTo = '', signal} = value;
    if (!['bonfire', 'fireside'].includes(kind)) throw fail('INVALID_REQUEST');
    if (typeof message !== 'string' || !message.trim() || message.includes('\0')) throw failWith('NOT_SENT', '请输入要发送的内容；本次消息未发送。');
    if ([...message].length > SPEAK_LIMIT[kind]) throw failWith('NOT_SENT', `消息超过 ${SPEAK_LIMIT[kind]} 字上限；本次消息未发送。`);
    if (kind === 'fireside' && (!/^[1-9]\d{0,15}$/.test(String(firesideId)) || !Number.isSafeInteger(Number(firesideId)))) throw failWith('NOT_SENT', '围炉无效；本次消息未发送。');
    // Town rejects a parent that does not exist, or that lives in another fireside or conversation.
    if (replyTo !== '' && (!/^[1-9]\d{0,15}$/.test(String(replyTo)) || !Number.isSafeInteger(Number(replyTo)))) throw failWith('NOT_SENT', '被回复的消息无效；本次消息未发送。');
    const ctx = this._context();
    const token = await this._credential(ctx);
    const body = {message, ...(kind === 'fireside' ? {fireside_id: Number(firesideId)} : {}), ...(replyTo !== '' ? {reply_to: Number(replyTo)} : {})};
    const result = await this._json(`/api/${kind}/speak`, {ctx, token, body, signal, write: true});
    this._context(ctx);
    if (result.ok !== true || !Number.isSafeInteger(result.seq) || result.seq < 1 || result.being !== ctx.beingId) throw fail('RESULT_UNKNOWN');
    const mentions = Array.isArray(result.mentions) ? result.mentions.filter(name => typeof name === 'string').slice(0, 20).map(name => name.slice(0, 100)) : [];
    // via is "client:<name>" here, but an IP-trusted Hearth host is short-circuited to "being".
    // Both are legitimate; the value is surfaced, never asserted.
    return {ok: true, id: String(result.seq), seq: result.seq, mentions, via: typeof result.via === 'string' ? result.via.slice(0, 120) : ''};
  }
  async sendDirectMessage(value) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).some(key => !['recipient', 'content', 'replyTo', 'signal'].includes(key))) throw fail('INVALID_REQUEST');
    const {recipient, content, replyTo = '', signal} = value;
    // Town resolves a recipient by being_id, then display name; it must land on exactly one being.
    if (typeof recipient !== 'string' || !recipient.trim() || recipient.length > 100 || recipient.includes('\0')) throw failWith('NOT_SENT', '请填写有效的收件人；本次私信未发送。');
    if (typeof content !== 'string' || !content.trim() || content.includes('\0')) throw failWith('NOT_SENT', '请输入要发送的内容；本次私信未发送。');
    if ([...content].length > SPEAK_LIMIT.fireside) throw failWith('NOT_SENT', `私信超过 ${SPEAK_LIMIT.fireside} 字上限；本次私信未发送。`);
    if (replyTo !== '' && (typeof replyTo !== 'string' || !replyTo.trim() || replyTo.length > 200)) throw failWith('NOT_SENT', '被回复的私信无效；本次私信未发送。');
    const ctx = this._context();
    if (recipient.trim() === ctx.beingId) throw failWith('NOT_SENT', 'Town 不允许给自己发私信；本次私信未发送。');
    const token = await this._credential(ctx);
    const body = {recipient: recipient.trim(), content, ...(replyTo !== '' ? {reply_to: replyTo} : {})};
    const result = await this._json('/api/messages', {ctx, token, body, signal, write: true});
    this._context(ctx);
    if (result.ok !== true || typeof result.message_id !== 'string' || !result.message_id) throw fail('RESULT_UNKNOWN');
    return {ok: true, id: result.message_id.slice(0, 200), recipient: typeof result.recipient === 'string' ? result.recipient.slice(0, 100) : '',
      via: typeof result.via === 'string' ? result.via.slice(0, 120) : ''};
  }
  lifecycle({enabled}) {
    if (!enabled) {
      this._enabled = false; clearTimeout(this._timer); this._timer = null;
      for (const controller of this._requests) controller.abort();
      this._stream = null; this._verified = '';
      if (['connected', 'connecting', 'reconnecting'].includes(this._state.status)) this._set({status: 'paused'});
      return;
    }
    this._enabled = true;
    if (!this._stream && !this._timer && !['auth_required', 'identity_mismatch'].includes(this._state.status)) void this._connect();
  }
  async _connect() {
    let ctx; try { ctx = this._context(); } catch { return; }
    const controller = new AbortController(); this._stream = controller; this._requests.add(controller);
    let hello = false, timer;
    try {
      const token = await this._credential(ctx); if (controller.signal.aborted) return;
      this._set({status: 'connecting', errorCode: ''});
      timer = setTimeout(() => controller.abort(), 20000);
      const url = new URL('/api/client/stream', ORIGIN); // Main-process fetch supports headers; no token in URLs.
      const res = await this.fetchImpl(url.href, {headers: {Accept: 'text/event-stream', Authorization: `Bearer ${token}`}, signal: controller.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store'});
      try {
        this._context(ctx);
        if ([401, 403].includes(res.status)) throw fail('AUTH_REQUIRED');
        if (!res.ok || res.redirected || !res.headers.get('content-type')?.includes('text/event-stream')) throw fail('SERVICE_ERROR');
        await consumeEvents(res.body, (type, data) => {
          this._context(ctx); if (controller.signal.aborted) throw fail('ABORTED');
          if (type === 'hello') {
            if (hello || data?.anonymous !== false || data.being_id !== ctx.beingId || data.token_kind !== 'client') throw fail('IDENTITY_MISMATCH');
            hello = true; this.retryMs = 1000; clearTimeout(timer); timer = setTimeout(() => controller.abort(), 90000); this._verified = ctx.key; this._set({status: 'connected', errorCode: ''}); this.onEvent({type: 'hello'});
          } else if (['bonfire', 'fireside', 'dm'].includes(type)) {
            if (!hello || !data || typeof data !== 'object' || Array.isArray(data)) throw fail('INVALID_RESPONSE');
            // Payload is an invalidation hint. REST remains authoritative.
            // A dm payload is an invalidation hint like the others; the inbox is re-read on demand.
            this.onEvent({type, ...(type === 'fireside' ? {firesideId: String(data.fireside_id || '')} : {})});
          } else if (type === 'error') throw fail('SERVICE_ERROR');
        }, () => { if (hello) { clearTimeout(timer); timer = setTimeout(() => controller.abort(), 90000); } });
      } finally { void res.body?.cancel().catch(() => {}); }
      throw fail('NETWORK_ERROR');
    } catch (error) {
      if (ctx.epoch !== this._epoch || !this._enabled || this._stream !== controller) return;
      const code = Object.hasOwn(MESSAGES, error.code) ? error.code : 'NETWORK_ERROR';
      this._verified = '';
      const blocked = ['AUTH_REQUIRED', 'IDENTITY_MISMATCH'].includes(code);
      this._set({status: code === 'AUTH_REQUIRED' ? 'auth_required' : code === 'IDENTITY_MISMATCH' ? 'identity_mismatch' : 'reconnecting', errorCode: code});
      if (!blocked) { this._timer = setTimeout(() => { this._timer = null; if (this._enabled) void this._connect(); }, this.retryMs); this.retryMs = Math.min(this.retryMs * 2, 30000); this._timer.unref?.(); }
    } finally { clearTimeout(timer); controller.abort(); this._requests.delete(controller); if (this._stream === controller) this._stream = null; }
  }
}
module.exports = {TownClient, consumeEvents};
