'use strict';

const {scrollId} = require('./town-library-contract.cjs');
const PUBLIC_METHODS = new Set(['listBeings', 'getBeingMembers', 'getGroveCatalog', 'getGroveDetail']);
const NO_ARGS = new Set(['listBeings', 'getBeingMembers', 'getFiresides']);
const miss = () => ({cached: false, data: null, lastSuccessAt: null});
const invalid = () => Object.assign(new Error('Town 缓存读取参数无效。'), {code: 'INVALID_REQUEST'});
const changed = () => Object.assign(new Error('Being 连接已变化，请重新读取。'), {code: 'SESSION_CHANGED'});

function fields(value, allowed, required = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value')) || required.some(key => !Object.hasOwn(descriptors, key))) throw invalid();
  return value;
}

function number(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid();
  return value;
}

function resource(method, value) {
  let query;
  if (NO_ARGS.has(method)) query = {...fields(value === undefined ? {} : value, [])};
  else if (method === 'listScrolls') {
    const input = fields(value === undefined ? {} : value, ['offset', 'limit', 'visibility']);
    if (input.visibility !== undefined && !['private', 'shared', 'public'].includes(input.visibility)) throw invalid();
    query = {offset: number(input.offset, 0, 0, 4294967295), limit: number(input.limit, 50, 1, 200), ...(input.visibility === undefined ? {} : {visibility: input.visibility})};
  } else if (method === 'getScroll') {
    const input = fields(value, ['id', 'offset', 'limit'], ['id']);
    if (!scrollId(input.id)) throw invalid();
    query = {id: input.id, offset: number(input.offset, 0, 0, 4294967295), limit: number(input.limit, 10000, 1, 10000)};
  } else if (method === 'getGroveCatalog') {
    const input = fields(value === undefined ? {} : value, ['offset', 'limit']);
    query = {offset: number(input.offset, 0, 0, 100000), limit: number(input.limit, 30, 1, 100)};
  } else if (method === 'getGroveDetail') {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value)) throw invalid();
    query = value;
  } else if (method === 'getFiresideMembers') {
    if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) throw invalid();
    query = value;
  } else throw invalid();
  return {method, value: query, key: JSON.stringify([method, query]), public: PUBLIC_METHODS.has(method)};
}

// Only successful, already sanitized read DTOs enter this cache. Mutations and
// live connection/installation status never use it.
class TownCachedReads {
  constructor({cache, getContext}) {
    Object.assign(this, {cache, getContext});
    this._requests = new Map();
    this._serial = 0;
  }

  _context(request) {
    const context = this.getContext();
    const identityKey = request.public ? 'public-town-v1' : context.connected && context.identityKey;
    return {identityKey, revision: context.revision, identityRevision: context.identityRevision};
  }

  _current(request, context) {
    return request.public || JSON.stringify(this._context(request)) === JSON.stringify(context);
  }

  async snapshot(value) {
    fields(value, ['method', 'value'], ['method']);
    const request = resource(value.method, value.value);
    const context = this._context(request);
    if (!context.identityKey) return miss();
    const result = await this.cache.load(context.identityKey, request.key);
    if (!this._current(request, context)) throw changed();
    return result;
  }

  async read(method, value, read) {
    const request = resource(method, value);
    const context = this._context(request);
    if (!context.identityKey) throw Object.assign(new Error('请先连接 Being。'), {code: 'NOT_CONNECTED'});
    const key = JSON.stringify([context.identityKey, request.key]);
    const serial = ++this._serial;
    this._requests.set(key, serial);
    try {
      const result = await read(request.value);
      if (!this._current(request, context)) throw changed();
      if (this._requests.get(key) === serial) {
        try { void Promise.resolve(this.cache.save(context.identityKey, request.key, result)).catch(() => {}); } catch { /* Keep the successful live result if persistence fails. */ }
      }
      return result;
    } finally {
      if (this._requests.get(key) === serial) this._requests.delete(key);
    }
  }
}

module.exports = {TownCachedReads};
