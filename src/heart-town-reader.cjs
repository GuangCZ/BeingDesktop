'use strict';

const PROTOCOL = 'being-town-readonly/1';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const IDENTITY_QUERY = '9223372036854775807';
const ROUTES = Object.freeze({
  '/api/bonfire/hear': ['since', 'limit', 'compact'],
  '/api/bonfire/mentions': ['since_id'],
  '/api/fireside/list': [],
  '/api/fireside/members': ['fireside_id'],
  '/api/fireside/hear': ['fireside_id', 'since', 'limit', 'compact'],
});
const MESSAGES = Object.freeze({
  INVALID_REQUEST: '后台消息读取参数无效。',
  NOT_CONNECTED: '请先连接 Being。',
  AUTH_REQUIRED: 'Heart 后台消息通道尚未授权，请检查连接。',
  IDENTITY_MISMATCH: 'Heart 后台消息通道的授权身份与当前 Being 不一致。',
  BACKGROUND_UNAVAILABLE: 'Heart 尚未安装可用的后台消息读取服务。',
  SESSION_CHANGED: '连接身份已变化，已丢弃上次后台读取结果。',
  ABORTED: '后台消息读取已取消。',
  RATE_LIMITED: '后台消息请求过于频繁，请稍后重试。',
  SERVICE_ERROR: 'Heart 后台消息服务暂时不可用。',
  NETWORK_ERROR: '无法连接 Heart 后台消息服务，请检查网络。',
  INVALID_RESPONSE: 'Heart 后台消息服务返回了无效结果。',
});
function failure(code) { const error = new Error(MESSAGES[code]); error.code = code; return error; }
function record(value) { return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype; }
function ownFields(value, allowed) {
  if (!record(value)) throw failure('INVALID_REQUEST');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value'))) throw failure('INVALID_REQUEST');
  return value;
}
function numberParam(value, minimum, maximum) {
  const parsed = typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw failure('INVALID_REQUEST');
  return String(parsed);
}
function queryDto(route, input = {}) {
  if (typeof route !== 'string' || !Object.hasOwn(ROUTES, route)) throw failure('INVALID_REQUEST');
  const value = ownFields(input, ROUTES[route]);
  const query = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'since_id') {
      if (item !== IDENTITY_QUERY) throw failure('INVALID_REQUEST');
      query[key] = IDENTITY_QUERY;
    } else if (key === 'compact') {
      if (![true, false, 'true', 'false'].includes(item)) throw failure('INVALID_REQUEST');
      query[key] = String(item);
    } else query[key] = numberParam(item, key === 'since' ? 0 : 1, key === 'limit' ? 200 : Number.MAX_SAFE_INTEGER);
  }
  if (route === '/api/bonfire/mentions' && !Object.hasOwn(query, 'since_id') || ['/api/fireside/members', '/api/fireside/hear'].includes(route) && !Object.hasOwn(query, 'fireside_id')) throw failure('INVALID_REQUEST');
  return query;
}

function connectionDto(value) {
  if (!value || typeof value !== 'object') throw failure('NOT_CONNECTED');
  const {apiBase, token, beingName} = value;
  if (typeof apiBase !== 'string' || apiBase.length > 8192 || /[\x00-\x20\x7f\\]/.test(apiBase) || typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token) || typeof beingName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(beingName)) throw failure('NOT_CONNECTED');
  let api;
  try { api = new URL(apiBase); } catch { throw failure('NOT_CONNECTED'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname);
  if (!(api.protocol === 'https:' || api.protocol === 'http:' && local) || api.username || api.password || api.search || api.hash) throw failure('NOT_CONNECTED');
  // parseConnection already requires a common Loom/API origin. Recheck when
  // its original URL is supplied, so an altered apiBase cannot move a token.
  if (value.url !== undefined) {
    let loom;
    try { loom = new URL(value.url); } catch { throw failure('NOT_CONNECTED'); }
    if (loom.origin !== api.origin || loom.username || loom.password) throw failure('NOT_CONNECTED');
  }
  return {apiBase: api.href.replace(/\/+$/, ''), token, beingName};
}

function jsonType(response) {
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return {json: mime === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(mime), html: mime === 'text/html' || mime === 'application/xhtml+xml'};
}
function cancelBody(response) {
  try { void response?.body?.cancel().catch(() => {}); } catch { /* Cleanup must not hide the outcome. */ }
}

class HeartTownReader {
  constructor({getConnection, fetchImpl = globalThis.fetch} = {}) {
    if (typeof getConnection !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('Invalid Heart Town reader callbacks');
    this.getConnection = getConnection;
    this.fetchImpl = fetchImpl;
  }

  _connection() {
    try { return connectionDto(this.getConnection()); }
    catch { throw failure('NOT_CONNECTED'); }
  }

  _current(expected) {
    let current;
    try { current = this._connection(); } catch { throw failure('SESSION_CHANGED'); }
    if (current.apiBase !== expected.apiBase || current.token !== expected.token || current.beingName !== expected.beingName) throw failure('SESSION_CHANGED');
  }

  async read(route, options = {}) {
    ownFields(options, ['query', 'signal']);
    const query = queryDto(route, options.query);
    const signal = options.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw failure('INVALID_REQUEST');
    if (signal?.aborted) throw failure('ABORTED');
    const expected = this._connection();
    const target = new URL(expected.apiBase + '/api/desktop-town/v1' + route.slice(4));
    for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    const cancelled = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(failure('ABORTED')), {once: true}));
    let response;
    try {
      const request = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw failure('ABORTED');
        this._current(expected);
        return this.fetchImpl(target.href, {
          method: 'GET', headers: {Accept: 'application/json', Authorization: `Bearer ${expected.token}`},
          credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal,
        });
      }).then(value => { if (controller.signal.aborted) cancelBody(value); return value; });
      response = await Promise.race([request, cancelled]);
      this._current(expected);
      if (controller.signal.aborted) throw failure('ABORTED');
      if (response.redirected || response.status >= 300 && response.status < 400) throw failure('BACKGROUND_UNAVAILABLE');
      if (response.url && response.url !== target.href) throw failure('INVALID_RESPONSE');
      const type = jsonType(response);
      if (response.status === 401 || response.status === 403) {
        let errorData;
        if (type.json) { try { errorData = await this._json(response, cancelled); } catch { /* Untrusted error bodies do not replace the fixed authorization message. */ } }
        this._current(expected);
        if (controller.signal.aborted) throw failure('ABORTED');
        const identityError = response.status === 403 && record(errorData) && Object.keys(errorData).length === 1 && record(errorData.error) && Object.keys(errorData.error).length === 1 && errorData.error.code === 'IDENTITY_MISMATCH';
        throw failure(identityError ? 'IDENTITY_MISMATCH' : 'AUTH_REQUIRED');
      }
      if ([404, 405].includes(response.status) || type.html) throw failure('BACKGROUND_UNAVAILABLE');
      if (response.status === 429) throw failure('RATE_LIMITED');
      if (response.status !== 200) throw failure('SERVICE_ERROR');
      if (!type.json) throw failure('INVALID_RESPONSE');
      const envelope = await this._json(response, cancelled);
      this._current(expected);
      if (controller.signal.aborted) throw failure('ABORTED');
      if (!record(envelope) || Object.keys(envelope).length !== 3 || envelope.protocol !== PROTOCOL || !Object.hasOwn(envelope, 'beingId') || !Object.hasOwn(envelope, 'data')) throw failure('INVALID_RESPONSE');
      if (envelope.beingId !== expected.beingName) throw failure('IDENTITY_MISMATCH');
      if (route === '/api/fireside/members' ? !Array.isArray(envelope.data) : !record(envelope.data)) throw failure('INVALID_RESPONSE');
      return envelope.data;
    } catch (error) {
      if (controller.signal.aborted) throw failure('ABORTED');
      this._current(expected);
      if (Object.hasOwn(MESSAGES, error?.code)) throw failure(error.code);
      throw failure('NETWORK_ERROR');
    } finally {
      signal?.removeEventListener('abort', abort);
      controller.abort();
      cancelBody(response);
    }
  }

  async _json(response, cancelled) {
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw failure('INVALID_RESPONSE');
    const reader = response.body?.getReader();
    if (!reader) throw failure('INVALID_RESPONSE');
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const part = await Promise.race([reader.read(), cancelled]);
        if (part.done) break;
        length += part.value.byteLength;
        if (length > MAX_RESPONSE_BYTES) throw failure('INVALID_RESPONSE');
        chunks.push(Buffer.from(part.value));
      }
    } finally {
      try { void reader.cancel().catch(() => {}); } catch { /* Cleanup does not replace validation errors. */ }
      try { reader.releaseLock(); } catch { /* An aborted read may still own its lock. */ }
    }
    const body = Buffer.concat(chunks).toString('utf8');
    if (/^\s*<(?:!doctype\s+html|html)\b/i.test(body)) throw failure('BACKGROUND_UNAVAILABLE');
    try { return JSON.parse(body); } catch { throw failure('INVALID_RESPONSE'); }
  }
}

module.exports = {HeartTownReader};
