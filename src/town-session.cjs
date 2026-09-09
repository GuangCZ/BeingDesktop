'use strict';

// Contracts: https://beings.town/api/{bonfire,fireside,beings,scrolls,channels}/help (2026-09-07).
// Town uses IP Trust. A Loom token is never a Town credential.
const {scrollId, libraryRoute, scrollListDto, scrollDto, beingsDto} = require('./town-library-contract.cjs');
const {relaySource} = require('./town-result-source.cjs');
const TOWN_ORIGIN = 'https://beings.town';
const TOWN_AUTH_DETAIL = 'Town 拒绝了本机的 GET 读取请求（401/403），当前连接没有消息读取权限。';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_QR_BYTES = 256 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const ROUTES = new Set(['/api', '/api/bonfire/mentions', '/api/bonfire/hear', '/api/bonfire/speak', '/api/fireside/list', '/api/fireside/members', '/api/fireside/hear', '/api/channels/status', '/api/channels/register', '/api/channels/credentials']);

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value, limit = 2000) {
  return typeof value === 'string' ? value.slice(0, limit * 2).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, limit) : '';
}
function sequence(value) { return Number.isSafeInteger(value) && value >= 0; }
function validId(value) { return typeof value === 'string' && ID.test(value); }
function firesideId(value) {
  const number = typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1) throw failure('INVALID_REQUEST', '请选择有效的围炉。');
  return number;
}
function checkAborted(signal) { if (signal?.aborted) throw failure('ABORTED', '读取已取消。'); }
function plainRequest(value, allowed, required = allowed) {
  if (!record(value) || Object.getPrototypeOf(value) !== Object.prototype) throw failure('INVALID_REQUEST', '请求格式无效。');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value')) || required.some(key => !Object.hasOwn(descriptors, key))) throw failure('INVALID_REQUEST', '请求格式无效。');
  return value;
}

function imageData(bytes, mime) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_QR_BYTES) return '';
  const valid = mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    || mime === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return valid ? `data:${mime};base64,${bytes.toString('base64')}` : '';
}

function inlineQr(value) {
  if (typeof value !== 'string' || value.length > MAX_QR_BYTES * 1.4) return '';
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2].length % 4) return '';
  const bytes = Buffer.from(match[2], 'base64');
  return bytes.toString('base64') === match[2] ? imageData(bytes, match[1]) : '';
}

function membersDto(value) {
  if (!record(value) || !Array.isArray(value.community)) throw failure('INVALID_RESPONSE', 'Town 成员目录格式发生变化，请稍后重试。');
  const seen = new Set();
  return value.community.slice(0, 2000).filter(member => record(member) && validId(member.being_id) && !seen.has(member.being_id) && seen.add(member.being_id))
    .map(member => ({id: member.being_id, name: text(member.display_name, 100) || member.being_id, description: text(member.about, 500)}));
}

function messagesDto(value, members = []) {
  if (!record(value) || value.ok !== true || !Array.isArray(value.messages) || !sequence(value.global_latest_seq)) throw failure('INVALID_RESPONSE', '篝火消息格式发生变化，请稍后重试。');
  const seen = new Set();
  const messages = value.messages.slice(0, 200).filter(item => record(item) && sequence(item.seq) && typeof item.message === 'string' && typeof item.being === 'string' && !seen.has(item.seq) && seen.add(item.seq))
    .map(item => {
      const byName = members.filter(member => member.name === item.being);
      const byId = members.find(member => member.id === item.being);
      // Duplicate display names are intentionally not attributed to one member.
      const beingId = validId(item.being_id) ? item.being_id : byId?.id || (byName.length === 1 ? byName[0].id : '');
      return {id: String(item.seq), beingId, beingName: text(item.being, 100), content: text(item.message, 4000), createdAt: text(item.at, 64), revisedAt: text(item.revised_at, 64), mentions: []};
    })
    .sort((left, right) => Number(left.id) - Number(right.id));
  return {messages, latestSeq: value.global_latest_seq, ...relaySource(value)};
}

function firesidesDto(value) {
  if (!record(value) || !Array.isArray(value.owned) || !Array.isArray(value.joined)) throw failure('INVALID_RESPONSE', '围炉列表格式发生变化，请稍后重试。');
  const seen = new Set();
  const rooms = entries => entries.slice(0, 2000).filter(room => record(room) && Number.isSafeInteger(room.id) && room.id > 0 && typeof room.name === 'string' && !seen.has(room.id) && seen.add(room.id))
    .map(room => ({id: room.id, name: text(room.name, 200), ...(sequence(room.member_count) ? {member_count: room.member_count} : {})}));
  // Owned rings can contain private invite keys. Only display fields leave main.
  return {owned: rooms(value.owned), joined: rooms(value.joined)};
}

function firesideMembersDto(value) {
  if (!Array.isArray(value)) throw failure('INVALID_RESPONSE', '围炉成员格式发生变化，请稍后重试。');
  const seen = new Set();
  return {members: value.slice(0, 2000).filter(member => record(member) && validId(member.being_id) && !seen.has(member.being_id) && seen.add(member.being_id))
    .map(member => ({being_id: member.being_id, display_name: text(member.display_name, 100) || member.being_id, joined_at: text(member.joined_at, 64)}))};
}

function firesideMessagesDto(value, expected) {
  if (!record(value) || value.being !== expected.beingId) throw failure('IDENTITY_MISMATCH', 'Town 授权身份与当前 Being 不一致，请检查连接。');
  if (!Array.isArray(value.messages) || !sequence(value.latest_seq) || value.messages.some(item => record(item) && item.truncated === true)) throw failure('INVALID_RESPONSE', '围炉消息格式发生变化，请稍后重试。');
  const seen = new Set();
  const messages = value.messages.slice(0, 200).filter(item => record(item) && sequence(item.seq) && validId(item.being) && typeof item.message === 'string' && !seen.has(item.seq) && seen.add(item.seq))
    .map(item => ({id: String(item.seq), beingId: item.being, beingName: text(item.speaker_name, 100) || item.being, content: text(item.message, 32000), createdAt: text(item.at, 64), revisedAt: text(item.revised_at, 64), mentions: Array.isArray(item.mentions) ? [...new Set(item.mentions.filter(validId))].slice(0, 20) : []}))
    .sort((left, right) => Number(left.id) - Number(right.id));
  return {messages, latestSeq: value.latest_seq};
}

function channelDto(value, channel) {
  const source = record(value) ? value : {};
  const known = new Set(['connected', 'disconnected', 'pending', 'registered', 'disabled', 'waiting', 'expired', 'error']);
  const status = known.has(source.status) ? source.status : 'unknown';
  // Channel response prose can contain credentials. Keep the UI description local.
  const result = {channel, status, detail: status === 'unknown' ? '渠道状态尚未确认，请刷新后查看。' : ''};
  if (typeof source.app_id === 'string' && /^cli_[A-Za-z0-9_-]{1,120}$/.test(source.app_id)) result.appId = source.app_id;
  // Registration may return a QR image. Only pass images on documented service domains.
  const qr = source.qr_code_url || source.qrcode_url || source.qr_url || source.qrcode || source.qr_code;
  const inline = inlineQr(qr);
  if (inline) result.qrCodeDataUrl = inline;
  if (typeof qr === 'string' && qr.length <= 4096) {
    try {
      const url = new URL(qr);
      if (url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && ['beings.town', 'weixin.qq.com', 'wx.qq.com', 'open.weixin.qq.com'].includes(url.hostname)) result.qrCodeUrl = url.href;
    } catch { /* Unknown QR formats stay unavailable instead of becoming active content. */ }
  }
  return result;
}

class TownSession {
  constructor({getContext, fetchImpl = globalThis.fetch, readImpl = null, onChange = () => {}} = {}) {
    if (typeof getContext !== 'function' || typeof fetchImpl !== 'function' || readImpl !== null && typeof readImpl !== 'function') throw new Error('Town 会话配置无效。');
    Object.assign(this, {getContext, fetchImpl, readImpl, onChange});
    this._epoch = 0;
    this._requests = new Set();
    this._mutations = new Set();
    this._members = null;
    this._state = {bonfire: {status: 'unknown', detail: ''}, fireside: {status: 'unknown', detail: ''}, channel: {status: 'unknown', detail: ''}, scroll: {status: 'unknown', detail: ''}, beings: {status: 'unknown', detail: ''}};
  }

  state() { return Object.fromEntries(Object.entries(this._state).map(([area, state]) => [area, {...state}])); }

  reset() {
    this._epoch++;
    for (const controller of this._requests) controller.abort();
    this._requests.clear();
    this._mutations.clear();
    this._members = null;
    this._state = {bonfire: {status: 'unknown', detail: ''}, fireside: {status: 'unknown', detail: ''}, channel: {status: 'unknown', detail: ''}, scroll: {status: 'unknown', detail: ''}, beings: {status: 'unknown', detail: ''}};
  }

  _set(area, status, detail = '') {
    this._state[area] = {status, detail};
    try { this.onChange(this.state()); } catch { /* View updates cannot change results. */ }
  }

  _context(expected, connectionRevision) {
    const current = this.getContext();
    const beingId = current.beingId || current.beingName;
    if (!current.configured || !current.connected || current.exiting || !validId(beingId) || !sequence(current.connectionId)) throw failure('NOT_CONNECTED', '请先连接 Being 并等待会话加载完成。');
    const identity = {beingId, connectionId: current.connectionId, identityRevision: current.identityRevision, epoch: this._epoch};
    if (expected && Object.keys(identity).some(key => identity[key] !== expected[key]) || connectionRevision !== undefined && current.connectionId !== connectionRevision) throw failure('SESSION_CHANGED', '连接身份已变化，请在当前 Being 下重新操作。');
    return identity;
  }

  async _request(route, {query, body, expected, mutation = false, signal} = {}) {
    if (!ROUTES.has(route) && !libraryRoute(route)) throw failure('INVALID_REQUEST', '不支持此 Town 操作。');
    if (expected) this._context(expected);
    checkAborted(signal);
    const url = new URL(route, TOWN_ORIGIN);
    if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    this._requests.add(controller);
    try {
      const response = await this.fetchImpl(url.href, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {Accept: 'application/json'} : {Accept: 'application/json', 'Content-Type': 'application/json'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
      });
      if (expected) this._context(expected);
      checkAborted(signal);
      if (response.status === 401 || response.status === 403) throw failure('AUTH_REQUIRED', TOWN_AUTH_DETAIL);
      if (response.status === 429) throw failure('RATE_LIMITED', 'Town 请求过于频繁，请稍后重试。');
      if (!response.ok) throw failure(mutation ? 'RESULT_UNKNOWN' : 'SERVICE_ERROR', mutation ? '操作未获确认，请先刷新状态；不要重复提交。' : 'Town 暂时不可用，请稍后重试。');
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes('application/json')) throw failure(mutation ? 'RESULT_UNKNOWN' : 'INVALID_RESPONSE', 'Town 返回了无法识别的结果，请先刷新状态。');
      const declaredLength = Number(response.headers.get('content-length'));
      if (declaredLength > MAX_RESPONSE_BYTES) throw failure('INVALID_RESPONSE', 'Town 返回的数据过大。');
      const reader = response.body?.getReader();
      if (!reader) throw failure('INVALID_RESPONSE', 'Town 返回的数据不完整。');
      const chunks = [];
      let length = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > MAX_RESPONSE_BYTES) throw failure('INVALID_RESPONSE', 'Town 返回的数据过大。');
          chunks.push(Buffer.from(part.value));
        }
      } finally { try { await reader.cancel(); } catch { /* A completed response needs no cancellation. */ } }
      if (expected) this._context(expected);
      checkAborted(signal);
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure(mutation ? 'RESULT_UNKNOWN' : 'INVALID_RESPONSE', 'Town 返回了无法识别的结果，请先刷新状态。'); }
      if ((!record(value) && !(['/api/fireside/members', '/api/beings'].includes(route) && Array.isArray(value))) || value.ok === false || Object.hasOwn(value, 'error')) throw failure(mutation ? 'RESULT_UNKNOWN' : 'SERVICE_ERROR', mutation ? '操作未获确认，请先刷新状态；不要重复提交。' : 'Town 暂时无法完成此操作。');
      return value;
    } catch (error) {
      if (expected) this._context(expected);
      checkAborted(signal);
      if (error?.code && ['AUTH_REQUIRED', 'RATE_LIMITED', 'RESULT_UNKNOWN', 'SERVICE_ERROR', 'INVALID_RESPONSE', 'SESSION_CHANGED', 'NOT_CONNECTED'].includes(error.code)) throw error;
      throw failure(mutation ? 'RESULT_UNKNOWN' : 'NETWORK_ERROR', mutation ? '连接中断，操作结果未知，请先刷新状态；不要重复提交。' : '无法连接 Town，请检查网络后重试。');
    } finally { signal?.removeEventListener('abort', abort); controller.abort(); this._requests.delete(controller); }
  }

  async _authorized(area, expected, {signal} = {}) {
    try {
      // This read neither marks mentions nor fetches message history. Its identity
      // binds IP Trust to the selected Loom Being before any write is attempted.
      const identity = await this._request('/api/bonfire/mentions', {expected, signal, query: {since_id: '9223372036854775807'}});
      if (identity.being !== expected.beingId) throw failure('IDENTITY_MISMATCH', 'Town 授权身份与当前 Being 不一致，请检查连接。');
      this._context(expected);
      checkAborted(signal);
      this._set(area, 'ready');
    } catch (error) {
      this._context(expected);
      if (error.code === 'ABORTED') throw error;
      this._set(area, error.code === 'AUTH_REQUIRED' ? 'auth_required' : 'error', error.message);
      throw error;
    }
  }

  async getMembers({signal} = {}) {
    const epoch = this._epoch;
    // The public homepage redirects to this canonical same-origin directory.
    const value = await this._request('/api', {signal});
    if (epoch !== this._epoch) throw failure('SESSION_CHANGED', '连接身份已变化，请重新读取成员。');
    const members = membersDto(value);
    this._members = members;
    return {members, source: 'public'};
  }

  async listScrolls(value = {}, {signal} = {}) {
    plainRequest(value, ['offset', 'limit', 'visibility'], []);
    if (value.offset !== undefined && (!sequence(value.offset) || value.offset > 4294967295) || value.limit !== undefined && (!sequence(value.limit) || value.limit < 1 || value.limit > 200) || value.visibility !== undefined && !['private', 'shared', 'public'].includes(value.visibility)) throw failure('INVALID_REQUEST', '卷轴列表分页参数无效。');
    const query = {offset: value.offset ?? 0, limit: value.limit ?? 50, ...(value.visibility === undefined ? {} : {visibility: value.visibility})};
    const expected = this._context();
    return this._read('scroll', expected, async request => scrollListDto(await request('/api/scrolls', {query}), query), {signal});
  }

  async getScroll(value, {signal} = {}) {
    plainRequest(value, ['id', 'offset', 'limit'], ['id']);
    if (!scrollId(value.id) || value.offset !== undefined && (!sequence(value.offset) || value.offset > 4294967295) || value.limit !== undefined && (!sequence(value.limit) || value.limit < 1 || value.limit > 10000)) throw failure('INVALID_REQUEST', '请选择有效的卷轴和正文页码。');
    const query = {offset: value.offset ?? 0, limit: value.limit ?? 10000};
    const expected = this._context();
    return this._read('scroll', expected, async request => scrollDto(await request(`/api/scrolls/${value.id}`, {query}), value.id, query), {signal});
  }

  async listBeings(value = {}, {signal} = {}) {
    plainRequest(value, [], []);
    const epoch = this._epoch;
    const context = this.getContext();
    const unchanged = () => {
      const current = this.getContext();
      if (epoch !== this._epoch || ['connectionId', 'identityRevision', 'beingId', 'beingName'].some(key => current[key] !== context[key])) throw failure('SESSION_CHANGED', '连接身份已变化，请重新读取居民目录。');
    };
    checkAborted(signal);
    const detail = '人类伙伴信息暂未公开。';
    try {
      // The public homepage contains the complete community. Periodic directory
      // refreshes need neither a Being chat turn nor protected Town credentials.
      unchanged();
      const value = await this._request('/api', {signal});
      unchanged();
      checkAborted(signal);
      const beings = beingsDto({beings: value.community});
      this._set('beings', 'ready');
      return {beings, source: 'public', detail: `Town 公开居民目录。${detail}`};
    } catch (error) {
      unchanged();
      if (error.code !== 'ABORTED') this._set('beings', 'error', error.message);
      throw error;
    }
  }

  async getBonfireMessages(value = {}, {signal} = {}) {
    plainRequest(value, ['since', 'limit'], []);
    if (value.since !== undefined && !sequence(value.since) || value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 200)) throw failure('INVALID_REQUEST', '篝火消息分页参数无效。');
    const expected = this._context();
    return this._read('bonfire', expected, async request => {
      const [response, members] = await Promise.all([
        request('/api/bonfire/hear', {query: {limit: value.limit || 10, ...(value.since === undefined ? {} : {since: value.since})}}),
        this._members ? Promise.resolve(this._members) : this.getMembers({signal}).then(result => result.members).catch(error => { if (error.code === 'ABORTED') throw error; return []; }),
      ]);
      this._context(expected);
      checkAborted(signal);
      return messagesDto(response, members);
    }, {signal});
  }

  async getFiresides(value = {}, {signal} = {}) {
    plainRequest(value, [], []);
    const expected = this._context();
    return this._read('fireside', expected, async request => firesidesDto(await request('/api/fireside/list')), {signal});
  }

  async getFiresideMembers(value, {signal} = {}) {
    const id = firesideId(value);
    const expected = this._context();
    return this._read('fireside', expected, async request => firesideMembersDto(await request('/api/fireside/members', {query: {fireside_id: id}})), {signal});
  }

  async getFiresideMessages(value, {signal} = {}) {
    plainRequest(value, ['firesideId', 'since', 'limit'], ['firesideId']);
    const id = firesideId(value.firesideId);
    if (value.since !== undefined && !sequence(value.since) || value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 200)) throw failure('INVALID_REQUEST', '围炉消息分页参数无效。');
    const expected = this._context();
    return this._read('fireside', expected, async request => firesideMessagesDto(await request('/api/fireside/hear', {query: {fireside_id: id, limit: value.limit || 10, ...(value.since === undefined ? {} : {since: value.since})}}), expected), {signal});
  }

  async _beingRequest(route, {query, expected, signal}) {
    this._context(expected);
    checkAborted(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    this._requests.add(controller);
    try {
      const value = await this.readImpl(route, {query, signal: controller.signal});
      this._context(expected);
      checkAborted(signal);
      return value;
    } catch (error) {
      this._context(expected);
      checkAborted(signal);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      this._requests.delete(controller);
      controller.abort();
    }
  }

  async _read(area, expected, callback, {signal} = {}) {
    try {
      const throughBeing = Boolean(this.readImpl && ['bonfire', 'fireside', 'scroll', 'beings'].includes(area));
      // The Being reader verifies the native HTTP tool result and identity.
      // Desktop IP authorization is unrelated to this execution context.
      if (!throughBeing) await this._authorized(area, expected, {signal});
      checkAborted(signal);
      const request = (route, options = {}) => throughBeing
        ? this._beingRequest(route, {...options, expected, signal})
        : this._request(route, {...options, expected, signal});
      const value = await callback(request);
      this._context(expected);
      checkAborted(signal);
      if (throughBeing) this._set(area, 'ready');
      return value;
    }
    catch (error) { this._context(expected); if (error.code !== 'ABORTED') this._set(area, error.code === 'AUTH_REQUIRED' ? 'auth_required' : 'error', error.message); throw error; }
  }

  async _mutate(area, expected, callback) {
    if (this._mutations.has(area)) throw failure('BUSY', '当前操作正在提交，请等待结果。');
    const marker = `${this._epoch}:${area}`;
    this._mutations.add(area);
    try { await this._authorized(area, expected); return await callback(); }
    catch (error) { this._context(expected); this._set(area, error.code === 'AUTH_REQUIRED' ? 'auth_required' : 'error', error.message); throw error; }
    finally { if (marker === `${this._epoch}:${area}`) this._mutations.delete(area); }
  }

  async sendBonfireMessage(value) {
    plainRequest(value, ['content', 'mentions', 'connectionRevision']);
    if (typeof value.content !== 'string' || !value.content.trim() || value.content.length > 4000 || /[\x00]/.test(value.content) || !Array.isArray(value.mentions) || value.mentions.length > 20 || value.mentions.some(id => typeof id !== 'string' || !ID.test(id)) || !sequence(value.connectionRevision)) throw failure('INVALID_REQUEST', '请输入 1–4000 字的篝火消息，并选择有效成员。');
    const expected = this._context(undefined, value.connectionRevision);
    return this._mutate('bonfire', expected, async () => {
      const mentions = [...new Set(value.mentions)];
      const {members} = mentions.length ? await this.getMembers() : {members: []};
      this._context(expected);
      if (mentions.some(id => !members.some(member => member.id === id))) throw failure('INVALID_REQUEST', '所选 Being 已不在成员目录，请重新选择。');
      const missing = mentions.filter(id => !new RegExp(`(^|\\s)@${id}(?=$|[^A-Za-z0-9_-])`).test(value.content));
      const message = (missing.map(id => `@${id}`).join(' ') + (missing.length ? '\n' : '') + value.content).trim();
      if (message.length > 4000) throw failure('INVALID_REQUEST', '加入 @成员后消息超过 4000 字，请缩短内容。');
      const response = await this._request('/api/bonfire/speak', {expected, body: {message}, mutation: true});
      if (response.ok !== true || !sequence(response.seq) || response.being !== expected.beingId || !Array.isArray(response.mentions)) throw failure('RESULT_UNKNOWN', '篝火未返回完整发送确认，请刷新消息后核对；不要重复提交。');
      this._set('bonfire', 'ready');
      return {ok: true, id: String(response.seq), mentions: response.mentions.filter(name => typeof name === 'string').slice(0, 20).map(name => text(name, 100))};
    });
  }

  async getChannelStatus({signal} = {}) {
    const expected = this._context();
    return this._read('channel', expected, async () => {
      const value = await this._request('/api/channels/status', {expected, signal, query: {being_id: expected.beingId}});
      const list = Array.isArray(value.channels) ? value.channels : record(value.channels) ? Object.entries(value.channels).map(([channel, entry]) => ({...(record(entry) ? entry : {}), channel})) : [value];
      return {channels: ['feishu', 'wechat'].map(channel => channelDto(list.find(item => record(item) && item.channel === channel), channel))};
    }, {signal});
  }

  async beginChannelConnection(value) {
    plainRequest(value, ['channel', 'connectionRevision']);
    if (!['feishu', 'wechat'].includes(value.channel) || !sequence(value.connectionRevision)) throw failure('INVALID_REQUEST', '请选择飞书或微信渠道。');
    const expected = this._context(undefined, value.connectionRevision);
    return this._mutate('channel', expected, async () => {
      const response = await this._request('/api/channels/register', {expected, body: {channel: value.channel, being_id: expected.beingId}, mutation: true});
      const result = channelDto(response, value.channel);
      if (response.ok !== true && !['registered', 'pending', 'waiting', 'connected'].includes(result.status)) throw failure('RESULT_UNKNOWN', '渠道登记结果尚未确认，请先刷新状态。');
      if (result.qrCodeUrl && !result.qrCodeDataUrl) {
        result.qrCodeDataUrl = await this._qrImage(result.qrCodeUrl, expected);
        if (!result.qrCodeDataUrl) result.detail = '渠道已登记，扫码图像暂时无法读取，请刷新渠道状态。';
      }
      return {ok: true, ...result};
    });
  }

  async _qrImage(url, expected) {
    // Only URLs already validated by channelDto reach this reader. Remote SVG,
    // HTML, redirects, cookies and scripts never enter the privileged renderer.
    this._context(expected);
    const controller = new AbortController();
    this._requests.add(controller);
    try {
      const response = await this.fetchImpl(url, {method: 'GET', headers: {Accept: 'image/png,image/jpeg,image/webp'}, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal});
      this._context(expected);
      const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!response.ok || !['image/png', 'image/jpeg', 'image/webp'].includes(mime) || Number(response.headers.get('content-length')) > MAX_QR_BYTES) return '';
      const reader = response.body?.getReader();
      if (!reader) return '';
      const chunks = [];
      let length = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > MAX_QR_BYTES) return '';
          chunks.push(Buffer.from(part.value));
        }
      } finally { try { await reader.cancel(); } catch { /* Cleanup does not change channel registration. */ } }
      this._context(expected);
      return imageData(Buffer.concat(chunks), mime);
    } catch { this._context(expected); return ''; }
    finally { controller.abort(); this._requests.delete(controller); }
  }

  async updateFeishuCredentials(value) {
    plainRequest(value, ['appId', 'appSecret', 'connectionRevision']);
    if (typeof value.appId !== 'string' || !/^cli_[A-Za-z0-9_-]{1,120}$/.test(value.appId) || typeof value.appSecret !== 'string' || value.appSecret.length < 1 || value.appSecret.length > 4096 || /[\x00-\x20\x7f]/.test(value.appSecret) || !sequence(value.connectionRevision)) throw failure('INVALID_REQUEST', '请输入有效的飞书 App ID 和 App Secret。');
    const expected = this._context(undefined, value.connectionRevision);
    return this._mutate('channel', expected, async () => {
      const response = await this._request('/api/channels/credentials', {expected, body: {channel: 'feishu', app_id: value.appId, app_secret: value.appSecret}, mutation: true});
      if (response.ok !== true) throw failure('RESULT_UNKNOWN', '飞书配置结果尚未确认，请先刷新渠道状态。');
      return {ok: true, channel: 'feishu', status: 'pending', detail: '凭据已提交，请在飞书完成机器人设置并刷新连接状态。'};
    });
  }
}

module.exports = {TownSession, TOWN_AUTH_DETAIL, messagesDto, firesideMessagesDto};
