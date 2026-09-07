'use strict';

// Read contracts checked against /api/scrolls/help, /api/beings/help and a public
// /api/scrolls/{id} response on 2026-09-07. Never infer human identities from IDs.
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const RESERVED_SCROLL_IDS = new Set(['help', 'search', 'graph', 'match']);
const VISIBILITY = new Set(['private', 'shared', 'public']);
const record = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const sequence = value => Number.isSafeInteger(value) && value >= 0;
const invalid = message => Object.assign(new Error(message), {code: 'INVALID_RESPONSE'});
const badRequest = () => Object.assign(new Error('Town 阅读参数无效。'), {code: 'INVALID_REQUEST'});
const display = (value, limit) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, limit) : '';

function scrollId(value) { return typeof value === 'string' && ID.test(value) && !RESERVED_SCROLL_IDS.has(value); }
function detailId(route) {
  if (typeof route !== 'string' || !route.startsWith('/api/scrolls/')) return null;
  const id = route.slice('/api/scrolls/'.length);
  return scrollId(id) ? id : null;
}
function libraryRoute(route) { return route === '/api/beings' || route === '/api/scrolls' || detailId(route) !== null; }
function libraryQuery(route, value = {}) {
  if (!libraryRoute(route) || !record(value)) throw badRequest();
  const allowed = route === '/api/beings' ? [] : route === '/api/scrolls' ? ['offset', 'limit', 'visibility'] : ['offset', 'limit'];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value'))) throw badRequest();
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'visibility') {
      if (!VISIBILITY.has(item)) throw badRequest();
      result[key] = item;
    } else {
      const number = typeof item === 'string' && /^(0|[1-9]\d*)$/.test(item) ? Number(item) : item;
      if (!sequence(number) || key === 'limit' && (number < 1 || number > (route === '/api/scrolls' ? 200 : 10000)) || key === 'offset' && number > 4294967295) throw badRequest();
      result[key] = String(number);
    }
  }
  return result;
}

function summaryDto(value) {
  if (!record(value) || !scrollId(value.id) || typeof value.title !== 'string' || typeof value.being_id !== 'string' || !ID.test(value.being_id) || !VISIBILITY.has(value.visibility) || !sequence(value.revision) || value.revision < 1) throw invalid('卷轴文档格式发生变化，请刷新后重试。');
  return {
    id: value.id, title: display(value.title, 400), beingId: value.being_id,
    beingName: display(value.display_name, 100) || value.being_id,
    visibility: value.visibility, kind: display(value.kind, 30), lifecycle: display(value.lifecycle, 30),
    tags: Array.isArray(value.tags) ? [...new Set(value.tags.filter(tag => typeof tag === 'string').slice(0, 50).map(tag => display(tag, 100)))] : [],
    createdAt: display(value.created_at, 64), updatedAt: display(value.updated_at, 64), revision: value.revision,
  };
}

function scrollListDto(value, query = {}) {
  if (!record(value) || value.ok === false || Object.hasOwn(value, 'error') || !Array.isArray(value.scrolls) || !sequence(value.total) || !sequence(value.offset) || !sequence(value.limit) || value.limit < 1 || value.limit > 200 || value.scrolls.length > value.limit || value.scrolls.length > value.total || value.offset !== Number(query.offset ?? 0) || value.limit !== Number(query.limit ?? 50)) throw invalid('卷轴列表格式发生变化，请刷新后重试。');
  const scrolls = value.scrolls.map(summaryDto);
  if (new Set(scrolls.map(scroll => scroll.id)).size !== scrolls.length || scrolls.length !== Math.min(value.limit, Math.max(0, value.total - value.offset))) throw invalid('卷轴列表不完整，请刷新后重试。');
  return {scrolls, total: value.total, offset: value.offset, limit: value.limit, hasMore: value.offset + value.scrolls.length < value.total};
}

function scrollDto(value, id, query = {}) {
  const scroll = summaryDto(value);
  if (scroll.id !== id || value.ok === false || Object.hasOwn(value, 'error') || typeof value.content !== 'string' || !sequence(value.total_length) || !sequence(value.offset) || !sequence(value.limit) || value.limit < 1 || value.limit > 10000 || typeof value.has_more !== 'boolean' || value.offset !== Number(query.offset ?? 0) || value.limit !== Number(query.limit ?? 10000)) throw invalid('卷轴正文格式发生变化，请刷新后重试。');
  const length = [...value.content].length;
  if (length > value.limit || value.offset + length > value.total_length || value.has_more !== (value.offset + length < value.total_length) || value.has_more && length !== value.limit) throw invalid('卷轴正文不完整，请刷新后重试。');
  return {scroll: {...scroll, content: display(value.content, 20000), totalLength: value.total_length, offset: value.offset, limit: value.limit, nextOffset: value.offset + length, hasMore: value.has_more}};
}

function beingsDto(value) {
  const list = Array.isArray(value) ? value : record(value) && Array.isArray(value.beings) ? value.beings : null;
  if (!list || list.length > 2000 || record(value) && (value.ok === false || Object.hasOwn(value, 'error') || value.has_more !== undefined && value.has_more !== false || value.hasMore !== undefined && value.hasMore !== false || value.total !== undefined && (!sequence(value.total) || value.total !== list.length) || value.offset !== undefined && value.offset !== 0)) throw invalid('Town 居民目录不完整，请刷新后重试。');
  const seen = new Set();
  return list.map(value => {
    if (!record(value) || typeof value.being_id !== 'string' || !ID.test(value.being_id) || typeof value.display_name !== 'string' || seen.has(value.being_id)) throw invalid('Town 居民目录格式发生变化，请刷新后重试。');
    seen.add(value.being_id);
    return {id: value.being_id, name: display(value.display_name, 100) || value.being_id, description: display(value.about, 500), status: display(value.status, 50), human: null};
  });
}

module.exports = {scrollId, detailId, libraryRoute, libraryQuery, scrollListDto, scrollDto, beingsDto};
