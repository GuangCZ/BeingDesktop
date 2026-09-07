'use strict';

const {randomUUID} = require('node:crypto');
const {sanitizeText} = require('./services.cjs');
const RESULT_PROTOCOL = 'being-desktop-channel-result/1';
const CHANNELS = new Set(['feishu', 'wechat']);
const STATUSES = new Set(['connected', 'disconnected', 'pending', 'registered', 'disabled', 'waiting', 'expired', 'error', 'unknown', 'unsupported']);
const MAX_REPLY = 512 * 1024;
const MAX_QR_BYTES = 256 * 1024;
const sequence = value => Number.isSafeInteger(value) && value >= 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => Object.assign(new Error(message), {code});

function request(value) {
  if (!record(value) || Object.getPrototypeOf(value) !== Object.prototype) throw fail('INVALID_REQUEST', '渠道请求格式无效。');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== 2 || ['channel', 'connectionRevision'].some(key => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value'))) throw fail('INVALID_REQUEST', '渠道请求格式无效。');
  if (!sequence(value.connectionRevision) || !CHANNELS.has(value.channel)) throw fail('INVALID_REQUEST', '请选择飞书或微信渠道，并重新检查当前连接。');
  return value;
}

function clean(value, secrets) {
  if (typeof value !== 'string') return '';
  for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]');
  return sanitizeText(value).replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
}

function qrImage(value) {
  if (typeof value !== 'string' || value.length > MAX_QR_BYTES * 1.4) return '';
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2].length % 4) return '';
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_QR_BYTES || bytes.toString('base64') !== match[2]) return '';
  const valid = match[1] === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || match[1] === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    || match[1] === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return valid ? value : '';
}

function qrUrl(value, secrets) {
  if (typeof value !== 'string' || value.length > 4096 || secrets.some(secret => secret && (value.includes(secret) || value.includes(encodeURIComponent(secret))))) return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && ['beings.town', 'weixin.qq.com', 'wx.qq.com', 'open.weixin.qq.com'].includes(url.hostname)) return url.href;
  } catch { /* Unrecognized QR addresses remain plain response data. */ }
  return '';
}

function outcome(reply, channel, secrets, expected = null) {
  let data;
  const trimmed = reply.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  try { data = JSON.parse(fenced ? fenced[1] : trimmed); } catch { /* Prose never proves a connection succeeded. */ }
  if (expected && (!record(data) || data.protocol !== RESULT_PROTOCOL || data.requestId !== expected.requestId
    || data.route !== expected.route || data.beingId !== expected.beingId || data.channel !== channel
    || Object.keys(data).some(key => !['protocol','requestId','route','beingId','channel','status','detail','qrCodeUrl','qrCodeDataUrl'].includes(key)))) {
    return {channel, status:'unknown', detail:'渠道回复无法对应本次功能任务，连接结果尚未确认。请稍后检查状态。'};
  }
  if (!record(data) || data.channel !== channel || !STATUSES.has(data.status) || typeof data.detail !== 'string') {
    return {channel, status: 'unknown', detail: clean(reply, secrets) || 'Being 已回复，连接状态仍待确认。'};
  }
  const result = {channel, status: data.status, detail: clean(data.detail, secrets) || 'Being 已返回渠道处理结果。'};
  const qr = qrImage(data.qrCodeDataUrl);
  if (!['connected', 'disconnected', 'disabled', 'expired'].includes(data.status)) {
    if (qr) result.qrCodeDataUrl = qr;
    else {
      const url = qrUrl(data.qrCodeUrl, secrets);
      if (url) result.qrCodeUrl = url;
    }
  }
  return result;
}

function prompt(operation, channel, expected) {
  const task = operation === 'begin'
    ? '请实际处理此渠道的连接：核对当前支持方式；若支持则登记渠道并返回下一步与真实授权二维码；若不支持，明确返回 unsupported。'
    : '请只读检查此渠道当前的真实连接状态，返回已存在的连接信息和下一步。不要登记渠道、重新连接或修改配置。';
  return `[Being Desktop Town sync:${expected.requestId}]\n这是用户在 Being Desktop 消息渠道页面主动发起的功能任务。当前 Being：${expected.beingId}；任务路线：${expected.route}。请为当前 Being 处理 ${channel} 渠道。\n${task}\n沿用你当前已有的服务访问能力，不要要求用户向 Heart 申请 IP Trust 授权，不要部署 Portal、申请桌面授权或修改网络信任设置。若现有能力无法完成，请在结果 detail 中直接说明具体限制，不得声称成功。不要操作其他渠道、发送测试消息或索要聊天中的应用密钥。如果需要凭据，请给出平台提供的专用安全配置入口及操作说明。\n请根据实际服务返回的结果，仅回复 JSON：{"protocol":"${RESULT_PROTOCOL}","requestId":"${expected.requestId}","route":"${expected.route}","beingId":"${expected.beingId}","channel":"${channel}","status":"connected|disconnected|pending|registered|disabled|waiting|expired|error|unknown|unsupported","detail":"简洁的中文结果与下一步","qrCodeUrl":"可选；真实服务返回的 HTTPS 二维码图片地址","qrCodeDataUrl":"可选；仅真实服务二维码的 PNG/JPEG/WebP base64 data URL"}。protocol、requestId、route、beingId、channel 必须保持原值，不要添加其他字段、Markdown 代码块或额外文字；无二维码时省略对应字段。失败也使用同一 JSON 结构，status 为 error 或 unsupported，具体原因放在 detail。不能确认时 status 必须是 unknown；不能编造二维码或连接成功。所有凭据、令牌和私密配置都不得出现在回复中。`;
}

class ChannelBeing {
  constructor({getContext, fetchImpl = globalThis.fetch, onChange = () => {}, onRequest = null} = {}) {
    if (typeof getContext !== 'function' || typeof fetchImpl !== 'function' || onRequest !== null && typeof onRequest !== 'function') throw new Error('Being 渠道连接配置无效。');
    Object.assign(this, {getContext, fetchImpl, onChange, onRequest});
    this._epoch = 0;
    this._active = null;
    this._sessions = new Map();
    this._state = {channel: '', status: 'unknown', detail: ''};
  }

  state() { return {...this._state}; }

  _set(status, detail = '', channel = '', qrCodeDataUrl = '') {
    this._state = {channel, status, detail, ...(qrCodeDataUrl ? {qrCodeDataUrl} : {})};
    try { this.onChange(this.state()); } catch { /* Observers cannot change request results. */ }
  }

  reset() {
    this._epoch++;
    this._active?.controller.abort();
    this._active = null;
    this._sessions.clear();
    this._set('unknown');
  }

  _context(revision, expected) {
    const context = this.getContext();
    if (!context?.configured || !context.connected || context.exiting || !context.connection?.url || !sequence(context.connectionId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(context.beingName || '')) throw fail('NOT_CONNECTED', '请先连接 Being 并等待会话加载完成。');
    const snapshot = {connectionId: context.connectionId, identityRevision: context.identityRevision, beingName: context.beingName, url: context.connection.url, epoch: this._epoch};
    if (revision !== context.connectionId || expected && Object.keys(snapshot).some(key => snapshot[key] !== expected[key])) throw fail('SESSION_CHANGED', '连接身份已变化，请在当前 Being 下重新操作。');
    return {context, snapshot};
  }

  beginChannelConnection(value) {
    request(value);
    return this._run('begin', value.channel, value.connectionRevision);
  }

  updateFeishuCredentials() {
    throw fail('INVALID_REQUEST', '应用密钥须在渠道服务的专用配置入口提交，请按 Being 返回的连接说明操作。');
  }

  async getChannelStatus(value) {
    request(value);
    const result = await this._run('status', value.channel, value.connectionRevision);
    return {...result, channels: [result]};
  }

  async _qrImage(url, controller, revision, snapshot) {
    this._context(revision, snapshot);
    try {
      const response = await this.fetchImpl(url, {method: 'GET', headers: {Accept: 'image/png,image/jpeg,image/webp'}, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal});
      this._context(revision, snapshot);
      const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!response.ok || response.redirected || !['image/png', 'image/jpeg', 'image/webp'].includes(mime) || Number(response.headers.get('content-length')) > MAX_QR_BYTES) {
        try { await response.body?.cancel(); } catch { /* Preserve the channel result. */ }
        return '';
      }
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
      } finally { try { await reader.cancel(); } catch { /* Preserve the channel result. */ } reader.releaseLock(); }
      this._context(revision, snapshot);
      return qrImage(`data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`);
    } catch {
      this._context(revision, snapshot);
      return '';
    }
  }

  async _run(operation, channel, revision) {
    const {context, snapshot} = this._context(revision);
    if (this._active) throw fail('BUSY', 'Being 正在处理渠道请求，请等待结果后再操作。');
    const controller = new AbortController();
    const active = {controller};
    this._active = active;
    const expected = {requestId:randomUUID(), route:`/desktop/channel/${channel}/${operation}`, beingId:context.beingName};
    const message = prompt(operation, channel, expected);
    const secrets = [context.connection.token, context.connection.secret].filter(Boolean);
    this._set('working', 'Being 正在处理渠道任务…', channel);
    let sent = false;
    try {
      const {BeingClient} = await import('../extensions/being-anywhere/being-client.mjs');
      this._context(revision, snapshot);
      const client = new BeingClient(context.connection.url, async (url, options) => {
        this._context(revision, snapshot);
        if (controller.signal.aborted) throw fail('SESSION_CHANGED', '连接身份已变化，请在当前 Being 下重新操作。');
        if (!sent) {
          try { this.onRequest?.({...expected,prompt:message}); } catch { /* Task bookkeeping does not change the request. */ }
          this._context(revision, snapshot);
          if (controller.signal.aborted) throw fail('SESSION_CHANGED', '连接身份已变化，请在当前 Being 下重新操作。');
        }
        sent = true;
        return this.fetchImpl(url, options);
      });
      let reply = '';
      let latestReply = '';
      let sessionId;
      const response = await client.send({message, sessionId: this._sessions.get(channel), signal: controller.signal, onEvent: event => {
        this._context(revision, snapshot);
        if (event.type === 'content_block_delta' && typeof event.data.delta?.text === 'string') {
          reply += event.data.delta.text;
          if (reply.length > MAX_REPLY) { controller.abort(); throw fail('INVALID_RESPONSE', 'Being 返回的渠道结果过长，请查看原对话。'); }
        }
        if (event.type === 'message_stop') {
          if (reply.trim()) latestReply = reply;
          reply = '';
          const id = event.data.session_id;
          if (typeof id === 'string' && id.length > 0 && id.length <= 512 && !/[\x00-\x1f\x7f]/.test(id)) sessionId = id;
        }
      }});
      this._context(revision, snapshot);
      if (sessionId) this._sessions.set(channel, sessionId);
      const result = response.accepted
        ? {channel, status: 'pending', detail: '请求已发送给 Being；Being 正在处理其他消息，渠道结果尚未确认。稍后可手动检查状态。'}
        : outcome(latestReply, channel, secrets, expected);
      if (result.qrCodeUrl) {
        const image = await this._qrImage(result.qrCodeUrl, controller, revision, snapshot);
        delete result.qrCodeUrl;
        if (image) result.qrCodeDataUrl = image;
        else result.detail = `${result.detail}\n扫码图像暂时无法读取，可稍后检查渠道状态。`;
      }
      this._context(revision, snapshot);
      this._set(result.status, result.detail, channel, result.qrCodeDataUrl);
      return result;
    } catch (error) {
      this._context(revision, snapshot);
      const auth = error?.message === '连接凭据无效或已过期，请更新 Loom 连接地址。';
      const code = auth ? 'AUTH_REQUIRED' : sent && operation !== 'status' ? 'RESULT_UNKNOWN' : 'SERVICE_ERROR';
      const detail = auth ? error.message : code === 'RESULT_UNKNOWN' ? '请求已尝试发送，渠道操作结果尚未确认。请稍后检查状态，不会自动重发。' : '无法取得 Being 的渠道结果，请稍后重新检查。';
      this._set('error', detail, channel);
      throw fail(code, detail);
    } finally {
      controller.abort();
      if (this._active === active) this._active = null;
    }
  }
}

module.exports = {ChannelBeing, parseChannelOutcome:outcome};
