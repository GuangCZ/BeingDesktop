'use strict';

const {endpoint} = require('./security.cjs');
const {sanitizeText} = require('./services.cjs');

const MAX_RESPONSE_BYTES = 1024 * 1024;
const RECENT_MS = 24 * 60 * 60 * 1000;
const CHANNELS = ['feishu', 'wechat'];
const BEING_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const CHANNEL_STATUSES = new Set(['connected', 'registered', 'pending', 'disconnected', 'disabled', 'waiting', 'expired', 'error']);
const MESSAGES = {
  NOT_CONNECTED: '请先连接 Being，再读取当前配置。',
  SESSION_CHANGED: 'Being 连接已变化，请重新读取当前配置。',
  ABORTED: '配置检查已取消。',
  INVALID_IDENTITY: 'Being 返回的身份格式无效，请检查 Loom 地址后重试。',
  INVALID_RESPONSE: '当前配置未能确认，请稍后重新读取。',
};
function failure(code) { return Object.assign(new Error(MESSAGES[code]), {code}); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function displayText(value, limit, secrets = []) {
  if (typeof value !== 'string') return '';
  return sanitizeText(value.replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, '[已隐藏地址]'), secrets)
    .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, limit);
}
function responseSecrets(value, connection) {
  const values = [connection.token, connection.secret];
  if (record(value)) for (const [key, item] of Object.entries(value)) {
    if (/(?:secret|token|api[_-]?key|password|credential)/i.test(key) && typeof item === 'string') values.push(item);
  }
  return values;
}
function creationDate(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
function identityDto(value, now, secrets) {
  const id = typeof value.being_id === 'string' && BEING_ID.test(value.being_id) ? value.being_id : '';
  const name = displayText(value.being_name || value.name, 100, secrets);
  const createdAt = creationDate(value.created || value.born);
  const age = createdAt === null ? null : now - Date.parse(createdAt);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value.created || value.born);
  return {status: id || name || createdAt ? 'ready' : 'unknown', id, name, createdAt,
    lifecycle: age === null || age < 0 || dateOnly && age < 3 * RECENT_MS ? 'unknown' : dateOnly || age > RECENT_MS ? 'existing' : 'recent'};
}
function modelDto(value, secrets) {
  if (typeof value.model !== 'string' || value.model.length > 512 || typeof value.provider !== 'string' || value.provider.length > 100
      || /[\x00-\x1f\x7f]/.test(value.model + value.provider)) return {status: 'unknown', name: '', provider: ''};
  const name = displayText(value.model, 512, secrets), provider = displayText(value.provider, 100, secrets);
  // A valid explicit empty model is distinct from a failed or missing response.
  const status = value.model.trim() ? 'configured' : !value.provider.trim() ? 'unconfigured' : 'unknown';
  return {status, name, provider};
}
function channelsDto(value) {
  const entries = Array.isArray(value?.channels) ? value.channels : [];
  const items = CHANNELS.map(channel => {
    const matches = entries.filter(item => record(item) && item.channel === channel);
    const status = matches.length === 1 && CHANNEL_STATUSES.has(matches[0].status) ? matches[0].status : 'unknown';
    // Inactive and failed registrations are not proof that credentials are absent.
    return {channel, status, configured: ['connected', 'registered', 'pending', 'waiting'].includes(status) ? true : null};
  });
  const status = items.every(item => item.status !== 'unknown') ? 'ready' : 'unknown';
  return {status, items, detail: status === 'ready' ? '' : '渠道配置尚未全部确认，可稍后重试或在渠道设置中查看。'};
}
function summaryStatus(value) {
  const known = [value.identity.status === 'ready', value.model.status !== 'unknown',
    value.channels.status === 'ready', value.portal.status === 'ready'];
  return known.every(Boolean) ? 'ready' : known.some(Boolean) || value.channels.items.some(item => item.status !== 'unknown') ? 'partial' : 'error';
}
function emptySummary(context, now) {
  return {status: 'loading', beingId: displayText(context.beingId || context.beingName, 100, responseSecrets(null, context.connection)),
    connectionRevision: context.connectionId, checkedAt: new Date(now).toISOString(),
    identity: {status: 'unknown', id: '', name: '', createdAt: null, lifecycle: 'unknown'},
    model: {status: 'unknown', name: '', provider: ''},
    channels: channelsDto(null),
    portal: {status: 'unknown', items: [], detail: '当前 Being 的远端 Portal 状态尚未确认；本机 Portal 可在下一步单独配置。'}};
}
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure('ABORTED'));
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function cancelBody(response) {
  try { void response.body?.cancel().catch(() => {}); } catch { /* Cleanup cannot replace the read result. */ }
}
async function responseJson(response, signal) {
  if (!response.ok || !(response.headers.get('content-type') || '').toLowerCase().includes('application/json')
      || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    cancelBody(response);
    throw failure('INVALID_RESPONSE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw failure('INVALID_RESPONSE');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw failure('INVALID_RESPONSE');
      chunks.push(Buffer.from(part.value));
    }
  } finally { void reader.cancel().catch(() => {}); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('INVALID_RESPONSE'); }
  if (!record(value) || value.ok === false || Object.hasOwn(value, 'error')) throw failure('INVALID_RESPONSE');
  return value;
}

class OnboardingInspection {
  constructor({getContext, fetchImpl = globalThis.fetch, getChannelStatus, onChange = () => {}, now = Date.now}) {
    Object.assign(this, {getContext, fetchImpl, getChannelStatus, onChange, now});
    this.operation = null;
    this.summary = null;
    this.epoch = 0;
  }
  state() { return this.summary === null ? null : structuredClone(this.summary); }
  publish() { try { this.onChange(this.state()); } catch { /* View updates cannot change a read result. */ } }
  context(expected) {
    const current = this.getContext();
    if (expected && (current.connection !== expected.connection || current.connectionId !== expected.connectionId
        || current.identityRevision !== expected.identityRevision || current.beingId !== expected.beingId || current.beingName !== expected.beingName)) throw failure('SESSION_CHANGED');
    if (!current.connection || current.exiting) throw failure('NOT_CONNECTED');
    return current;
  }
  current(operation) {
    if (operation.epoch !== this.epoch || operation !== this.operation) throw failure(operation.cancelled ? 'ABORTED' : 'SESSION_CHANGED');
    this.context(operation.context);
    if (operation.invalidIdentity) throw failure('INVALID_IDENTITY');
    if (operation.controller.signal.aborted) throw failure('ABORTED');
  }
  cancel() {
    if (!this.operation) return this.state();
    const previous = this.operation;
    previous.cancelled = true;
    this.epoch++;
    this.operation = null;
    previous.controller.abort();
    if (this.summary?.status === 'loading') this.summary.status = summaryStatus(this.summary);
    this.publish();
    return this.state();
  }
  reset() {
    this.epoch++;
    const previous = this.operation;
    this.operation = null;
    previous?.controller.abort();
    this.summary = null;
    this.publish();
  }
  async request(operation, route) {
    this.current(operation);
    const {connection} = operation.context, signal = operation.controller.signal;
    const url = endpoint(connection, route);
    if (new URL(url).origin !== new URL(connection.url).origin) throw failure('INVALID_RESPONSE');
    const headers = {Accept: 'application/json'};
    if (connection.secret) headers['X-Relay-Secret'] = connection.secret;
    const pending = Promise.resolve(this.fetchImpl(url, {method: 'GET', headers, signal,
      redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store'})).then(response => {
      if (signal.aborted) { cancelBody(response); throw failure('ABORTED'); }
      return response;
    });
    const response = await abortable(pending, signal);
    try {
      this.current(operation);
      const value = await responseJson(response, signal);
      this.current(operation);
      return value;
    } catch (error) { cancelBody(response); throw error; }
  }
  inspect() {
    const context = this.context();
    if (this.operation) {
      try { this.current(this.operation); return this.operation.promise; } catch { this.reset(); }
    }
    const operation = {context, epoch: this.epoch, controller: new AbortController()};
    this.operation = operation;
    this.summary = emptySummary(context, this.now());
    this.publish();
    operation.promise = this.run(operation);
    return operation.promise;
  }
  async run(operation) {
    let finishIdentity;
    const identitySettled = new Promise(resolve => { finishIdentity = resolve; });
    const update = async (section, read) => {
      try {
        const value = await read();
        // Do not expose another section before the status identity has been checked.
        if (section !== 'identity') await identitySettled;
        this.current(operation);
        this.summary[section] = value;
        this.publish();
      } catch (error) {
        if (error?.code === 'INVALID_IDENTITY') {
          operation.invalidIdentity = true;
          operation.controller.abort();
        }
        this.current(operation);
      } finally { if (section === 'identity') finishIdentity(); }
    };
    try {
      await Promise.allSettled([
        update('identity', async () => {
          const value = await this.request(operation, '/api/status');
          if (Object.hasOwn(value, 'being_id') && (typeof value.being_id !== 'string' || !BEING_ID.test(value.being_id))) throw failure('INVALID_IDENTITY');
          // A generic /loom page may use a separate same-origin Being API path.
          // Only the authenticated status response supplies the authoritative ID.
          operation.channelBeingId = value.being_id || operation.context.beingId || operation.context.beingName;
          return identityDto(value, this.now(), responseSecrets(value, operation.context.connection));
        }),
        update('model', async () => {
          const value = await this.request(operation, '/api/llm/config');
          return modelDto(value, responseSecrets(value, operation.context.connection));
        }),
        update('channels', async () => {
          await identitySettled;
          this.current(operation);
          if (typeof operation.channelBeingId !== 'string' || !BEING_ID.test(operation.channelBeingId)) return channelsDto(null);
          return channelsDto(await abortable(this.getChannelStatus({signal: operation.controller.signal, beingId: operation.channelBeingId}), operation.controller.signal));
        }),
      ]);
      this.current(operation);
      this.summary.status = summaryStatus(this.summary);
      this.summary.checkedAt = new Date(this.now()).toISOString();
      this.publish();
      return this.state();
    } catch (error) {
      if (this.operation === operation && operation.invalidIdentity) {
        this.summary = emptySummary(operation.context, this.now());
        this.summary.status = 'error';
        this.publish();
      } else if (this.operation === operation) {
        this.summary = null;
        this.publish();
      }
      throw error;
    } finally {
      operation.controller.abort();
      if (this.operation === operation) this.operation = null;
    }
  }
}

module.exports = {OnboardingInspection, identityDto, modelDto, channelsDto, MAX_RESPONSE_BYTES};
