'use strict';

const {randomUUID} = require('node:crypto');

const STATUSES = new Set(['running', 'waiting', 'succeeded', 'failed', 'cancelled', 'needs_input']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const RESTART_DETAIL = '应用已重新启动，执行状态待核对；不会自动重发。';
const ERROR_DETAILS = Object.freeze({
  AUTH_REQUIRED: '此功能需要授权，请在对应功能页面完成连接。',
  IDENTITY_MISMATCH: '连接身份不一致，请检查 Being 连接后重试。',
  NOT_CONNECTED: '请先连接 Being。',
  NETWORK_ERROR: '连接暂时中断，请稍后重试。',
  SERVICE_ERROR: '服务暂时不可用，请稍后重试。',
  RATE_LIMITED: '请求过于频繁，请稍后重试。',
  BUSY: 'Being 当时正在处理其他请求，本次操作未发送。请打开功能页重试。',
  READINESS_UNKNOWN: '未能确认 Being 是否空闲，本次操作未发送。请打开功能页重试。',
  REQUEST_ACCEPTED: '请求已送达，执行结果尚待确认；不会自动重发。',
  SESSION_CHANGED: '连接已变化，当前界面不再跟踪此请求。',
  ABORTED: '本地等待已停止，远端执行状态需另行确认。',
  INCOMPLETE_RESULT: '返回结果不完整，请在功能页面检查后重试。',
  INVALID_RESPONSE: '返回结果无法读取，请在功能页面检查后重试。',
  TOWN_TOOL_NOT_CALLED: 'Being 未执行 Town 读取工具，请在模型设置检查原生 http 工具是否被限制。',
  RESULT_SOURCE_UNAVAILABLE: '本机结果通道暂不可用，请稍后重试。',
  RESULT_SOURCE_NOT_CONFIGURED: '未配置完整工具结果通道，无法从 Loom 摘要恢复消息。',
  REQUEST_FAILED: '功能执行失败，请在对应功能页面检查后重试。',
});

function plain(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function fields(value, allowed, name) {
  if (!plain(value)) throw new TypeError(`Invalid ${name}`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value'))) throw new TypeError(`Invalid ${name} fields`);
  return value;
}

function identifier(value, name, max = 80) {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) throw new TypeError(`Invalid ${name}`);
  return value;
}

function identity(value) {
  if (value === '') return '';
  return identifier(value, 'identity key', 128);
}

function safeText(value, limit) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new TypeError('Task text must be a string');
  return value.slice(0, limit * 8)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/https?:\/\/[^\s<>\[\]()"']+/gi, '[链接]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[已隐藏]')
    .replace(/\b(authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|key|password|secret|credential|cookie)\b(["']?\s*[:=]\s*["']?)[^\s,;&"']+/gi, '$1$2[已隐藏]')
    .slice(0, limit);
}

function stamp(value) { return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000; }
function copy(value) { return structuredClone(value); }

class FeatureTasks {
  constructor({onChange = () => {}, now = Date.now, createId = randomUUID, maxRecords = 100, identityKey = '', initialSnapshot, initialRecords, initialIdentityKey} = {}) {
    if (typeof onChange !== 'function' || typeof now !== 'function' || typeof createId !== 'function') throw new TypeError('Invalid feature task callbacks');
    if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 200) throw new RangeError('Invalid feature task limit');
    this.onChange = onChange;
    this.now = now;
    this.createId = createId;
    this.maxRecords = maxRecords;
    this.identityKey = identity(identityKey);
    this._records = new Map();
    const source = initialSnapshot || (initialRecords === undefined ? null : {version: 1, identityKey: initialIdentityKey, records: initialRecords});
    if (plain(source) && source.version === 1 && source.identityKey === this.identityKey && Array.isArray(source.records)) this._restore(source.records);
  }

  begin(input) {
    const {feature, operation, title, execution = 'local'} = fields(input, ['feature', 'operation', 'title', 'execution'], 'feature task');
    identifier(feature, 'feature');
    identifier(operation, 'operation');
    if (!['being', 'local'].includes(execution)) throw new TypeError('Invalid task execution');
    const safeTitle = safeText(title, 160).trim();
    if (!safeTitle) throw new TypeError('Task title is required');
    let oldest;
    if (this._records.size >= this.maxRecords) {
      oldest = [...this._records.values()].filter(task => TERMINAL.has(task.status)).sort((a, b) => a.updatedAt - b.updatedAt || a.createdAt - b.createdAt)[0];
      if (!oldest) { const error = new Error('Too many active feature tasks'); error.code = 'TASK_LIMIT_REACHED'; throw error; }
    }
    let id;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = identifier(this.createId(), 'task ID', 128);
      if (!this._records.has(candidate)) { id = candidate; break; }
    }
    if (!id) throw new Error('Could not allocate a unique feature task ID');
    const timestamp = this._now();
    const task = {id, feature, operation, title: safeTitle, execution, mayDelayChat: execution === 'being', status: 'running', detail: '', summary: '', requestId: '', errorCode: '', createdAt: timestamp, updatedAt: timestamp, finishedAt: null};
    if (oldest) this._records.delete(oldest.id);
    this._records.set(id, task);
    this._changed();
    return copy(task);
  }

  update(id, patch) {
    const values = fields(patch, ['status', 'detail', 'requestId'], 'task update');
    if (values.status !== undefined && !STATUSES.has(values.status)) throw new TypeError('Invalid task status');
    const changes = {};
    if (values.status !== undefined) changes.status = values.status;
    if (values.detail !== undefined) changes.detail = safeText(values.detail, 600);
    if (values.requestId !== undefined) changes.requestId = values.requestId === '' ? '' : identifier(values.requestId, 'request ID', 128);
    return this._patch(id, changes);
  }

  complete(id, options = {}) {
    const {summary} = fields(options, ['summary'], 'task completion');
    return this._patch(id, {status: 'succeeded', summary: safeText(summary, 1200), detail: '', errorCode: ''});
  }

  fail(id, error) {
    // Raw backend errors may contain credentials, HTTP bodies, or user prompts.
    const descriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : null;
    const candidate = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
    const errorCode = typeof candidate === 'string' && Object.hasOwn(ERROR_DETAILS, candidate) ? candidate : 'REQUEST_FAILED';
    return this._patch(id, {status: 'failed', errorCode, detail: ERROR_DETAILS[errorCode]});
  }

  cancel(id, options = {}) {
    const {detail} = fields(options, ['detail'], 'local task cancellation');
    return this._patch(id, {status: 'cancelled', detail: safeText(detail === undefined ? '已停止本地跟踪，远端执行状态需另行确认。' : detail, 600)});
  }

  get(id) { const task = this._records.get(id); return task ? copy(task) : null; }

  list(options = {}) {
    const {feature} = fields(options, ['feature'], 'task filter');
    if (feature !== undefined) identifier(feature, 'feature');
    return [...this._records.values()].reverse().filter(task => feature === undefined || task.feature === feature).map(copy);
  }

  snapshot() { return {version: 1, identityKey: this.identityKey, records: this.list()}; }

  reset({identityKey = this.identityKey} = {}) {
    this.identityKey = identity(identityKey);
    this._records.clear();
    this._changed();
    return this.snapshot();
  }

  _now() {
    const timestamp = this.now();
    if (!stamp(timestamp)) throw new TypeError('Invalid feature task clock');
    return timestamp;
  }

  _patch(id, values) {
    const task = this._records.get(id);
    if (!task) return null;
    // A late callback cannot resurrect or overwrite a completed local record.
    if (TERMINAL.has(task.status)) return copy(task);
    if (Object.entries(values).every(([key, value]) => task[key] === value)) return copy(task);
    const updatedAt = Math.max(task.updatedAt, this._now());
    Object.assign(task, values);
    task.updatedAt = updatedAt;
    task.finishedAt = TERMINAL.has(task.status) ? task.updatedAt : null;
    this._changed();
    return copy(task);
  }

  _changed() {
    // An observer failure must not cancel the operation being tracked.
    try { this.onChange(this.snapshot()); } catch {}
  }

  _restore(records) {
    const restored = [];
    for (const candidate of records.slice(0, 200)) {
      try {
        fields(candidate, ['id', 'feature', 'operation', 'title', 'execution', 'mayDelayChat', 'status', 'detail', 'summary', 'requestId', 'errorCode', 'createdAt', 'updatedAt', 'finishedAt'], 'stored task');
        const {id, feature, operation, execution, status, createdAt, updatedAt, finishedAt} = candidate;
        identifier(id, 'task ID', 128); identifier(feature, 'feature'); identifier(operation, 'operation');
        if (!['being', 'local'].includes(execution) || !STATUSES.has(status) || !stamp(createdAt) || !stamp(updatedAt) || updatedAt < createdAt) continue;
        if (TERMINAL.has(status) ? !stamp(finishedAt) || finishedAt < createdAt || finishedAt > updatedAt : finishedAt !== null) continue;
        const title = safeText(candidate.title, 160).trim();
        if (!title) continue;
        const task = {id, feature, operation, title, execution, mayDelayChat: execution === 'being', status: TERMINAL.has(status) ? status : 'waiting', detail: TERMINAL.has(status) ? safeText(candidate.detail, 600) : RESTART_DETAIL, summary: safeText(candidate.summary, 1200), requestId: candidate.requestId ? identifier(candidate.requestId, 'request ID', 128) : '', errorCode: Object.hasOwn(ERROR_DETAILS, candidate.errorCode) ? candidate.errorCode : '', createdAt, updatedAt, finishedAt};
        // Legacy Town rows were left waiting after their request had ended.
        // Recover their presentation without replaying a remote operation.
        if (!TERMINAL.has(status) && ['bonfire', 'fireside', 'scroll'].includes(feature) && execution === 'being') {
          const blockedBeforeSend = !task.requestId && candidate.detail === 'Being 正在处理其他请求，本次操作尚未完成；不会自动重发。';
          Object.assign(task, blockedBeforeSend
            ? {status:'failed', errorCode:'READINESS_UNKNOWN', detail:'旧版未发送这次读取，却留下了等待状态。请打开功能页重新读取。', finishedAt:updatedAt}
            : {status:'needs_input', detail:'应用已重新启动，旧读取结果尚未确认，本地已无等待队列。请在功能页检查；不会自动重发。'});
        }
        restored.push(task);
      } catch {}
    }
    for (const task of restored.sort((a, b) => b.createdAt - a.createdAt).slice(0, this.maxRecords).reverse()) if (!this._records.has(task.id)) this._records.set(task.id, task);
  }
}

module.exports = {FeatureTasks};
