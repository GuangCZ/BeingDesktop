'use strict';

const {AsyncLocalStorage} = require('node:async_hooks');
const {createHash} = require('node:crypto');

const context = new AsyncLocalStorage();
const WAITING_CODES = new Set(['REQUEST_ACCEPTED', 'RESULT_UNKNOWN', 'WAITING_SBS', 'SBS_NOT_CONFIGURED']);
const WAITING_DETAIL = '请求结果尚待确认；不会自动重发。';
const OPERATIONS = Object.freeze({
  listScrolls: ['scroll', 'list', '读取卷轴目录', 'being'],
  getScroll: ['scroll', 'read', '读取卷轴正文', 'being'],
  getGroveCatalog: ['grove', 'list', '读取工具包目录', 'local'],
  getGroveDetail: ['grove', 'inspect', '查看工具包', 'local'],
  prepareGroveInstallation: ['grove', 'prepare', '检查工具包安装条件', 'local'],
  installGroveKit: ['grove', 'install', '安装工具包', 'local'],
  installEligibleGroveKits: ['grove', 'install_batch', '批量安装工具包', 'local'],
  deployPortal: ['portal', 'deploy', '部署 Portal', 'local'],
  startPortal: ['portal', 'start', '启动 Portal', 'local'],
  stopPortal: ['portal', 'stop', '停止 Portal', 'local'],
  checkPortalUpdates: ['portal', 'check_updates', '检查 Portal 更新', 'local'],
  beginChannelConnection: ['channel', 'connect', '连接消息渠道', 'being'],
  checkChannelStatus: ['channel', 'check', '检查消息渠道状态', 'being'],
});

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function own(value, key) {
  const property = object(value) ? Object.getOwnPropertyDescriptor(value, key) : null;
  return property && Object.hasOwn(property, 'value') ? property.value : undefined;
}

function definition(name, first) {
  if (name === 'requestTownRead') {
    const kind = own(first, 'kind');
    if (!['bonfire', 'fireside'].includes(kind)) return null;
    return {feature: kind, operation: kind === 'fireside' && !own(first, 'firesideId') ? 'list' : 'read', title: kind === 'bonfire' ? '读取篝火消息' : own(first, 'firesideId') ? '读取围炉消息' : '读取围炉目录', execution: 'being'};
  }
  if (!Object.hasOwn(OPERATIONS, name)) return null;
  const [feature, operation, title, execution] = OPERATIONS[name];
  return {feature, operation, title, execution};
}

function requestKey(name, args) {
  let entries = 0;
  function normalize(value, depth = 0) {
    if (++entries > 500 || depth > 8) throw new TypeError('Feature task arguments exceed the supported size');
    if (value === undefined) return ['undefined'];
    if (value === null) return ['null'];
    if (typeof value === 'string') {
      if (value.length > 16384) throw new TypeError('Feature task arguments exceed the supported size');
      return ['string', value];
    }
    if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return [typeof value, value];
    if (Array.isArray(value)) return ['array', value.map(item => normalize(item, depth + 1))];
    if (!object(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Invalid feature task arguments');
    const properties = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(properties).some(key => typeof key !== 'string' || !Object.hasOwn(properties[key], 'value'))) throw new TypeError('Invalid feature task argument fields');
    return ['object', Object.keys(properties).sort().map(key => [key, normalize(properties[key].value, depth + 1)])];
  }
  // Only a digest is retained for duplicate suppression, never the input data.
  return createHash('sha256').update(name).update('\0').update(JSON.stringify(normalize(args))).digest('hex');
}

function currentTask() {
  const active = context.getStore();
  if (!active) return null;
  const task = active.ledger.get(active.id);
  return task ? {ledger: active.ledger, task} : null;
}

function wait(ledger, id, detail = WAITING_DETAIL) { ledger.update(id, {status: 'waiting', detail}); }
function input(ledger, id, detail) { ledger.update(id, {status: 'needs_input', detail}); }
function failed(ledger, id, error) {
  const code = own(error, 'code');
  if (code === 'RESULT_UNCONFIRMED') { input(ledger, id, '请求已发送，但自动检查尚未取得可核对的结果。请在功能页检查；不会自动重发。'); return; }
  if (WAITING_CODES.has(code)) {
    wait(ledger, id);
  } else ledger.fail(id, error);
}

function responseFailure(result) {
  const error = own(result, 'error');
  if (error !== undefined && error !== null && error !== false && error !== '') return object(error) ? error : {code: own(result, 'code')};
  if (own(result, '__townError') === true || own(result, 'ok') === false) return {code: own(result, 'code')};
  return null;
}

function finish(name, first, result, ledger, id) {
  const failure = responseFailure(result);
  if (failure) { failed(ledger, id, failure); return; }
  if (own(result, 'accepted') === true || WAITING_CODES.has(own(result, 'code'))) { failed(ledger, id, {code: own(result, 'code') || 'REQUEST_ACCEPTED'}); return; }
  if (['busy', 'BUSY'].includes(own(result, 'status')) || own(result, 'code') === 'BUSY') { ledger.fail(id, {code:'BUSY'}); return; }
  if (own(result, 'status') === 'accepted' || own(result, 'status') === 202) { wait(ledger, id); return; }
  if (['error', 'failed'].includes(own(result, 'status'))) { ledger.fail(id, {code: own(result, 'code')}); return; }
  const done = summary => ledger.complete(id, {summary});
  if (name === 'requestTownRead') {
    const state = own(result, 'status');
    const errorCode = own(state, 'errorCode');
    if (errorCode) { failed(ledger, id, {code: errorCode}); return; }
    if (own(first, 'kind') === 'fireside' && !own(first, 'firesideId')) {
      const rooms = own(result, 'rooms'), owned = own(rooms, 'owned'), joined = own(rooms, 'joined');
      if (Array.isArray(owned) && Array.isArray(joined)) { done(`已读取围炉目录：创建 ${owned.length} 个，加入 ${joined.length} 个。`); return; }
    } else {
      const messages = own(own(result, 'snapshot'), 'messages');
      if (own(state, 'status') === 'ready' && Array.isArray(messages)) { done(`已读取 ${messages.length} 条${own(first, 'kind') === 'bonfire' ? '篝火' : '围炉'}消息。`); return; }
    }
    wait(ledger, id); return;
  }
  if (name === 'listScrolls' && Array.isArray(own(result, 'scrolls'))) { done(`已读取 ${result.scrolls.length} 份卷轴的目录。`); return; }
  if (name === 'getScroll' && typeof own(own(result, 'scroll'), 'title') === 'string') { done(`已读取卷轴《${result.scroll.title.slice(0, 160)}》当前页。`); return; }
  if (name === 'getGroveCatalog' && Array.isArray(own(result, 'kits'))) { done(`已读取 ${result.kits.length} 个工具包。`); return; }
  if (name === 'getGroveDetail' && typeof own(result, 'name') === 'string') { done(`已读取工具包 ${result.name.slice(0, 160)} 的说明。`); return; }
  if (name === 'prepareGroveInstallation' && own(result, 'status') === 'needs_setup') { input(ledger, id, '安装条件检查完成，请在工具包页面查看要求并完成配置；尚未安装或运行脚本。'); return; }
  if (['prepareGroveInstallation','installGroveKit'].includes(name)) {
    if (own(result, 'status') === 'needs_being') { input(ledger,id,own(result,'detail') || '此工具包需要 Being 协助，请在详情页查看原因。'); return; }
    if (['ready','installed'].includes(own(result,'status'))) { done(own(result,'detail') || '工具包检查已完成。'); return; }
  }
  if (name === 'installEligibleGroveKits' && Array.isArray(own(result,'results'))) {
    const items=result.results, installed=items.filter(item=>item.status==='installed').length, needs=items.filter(item=>item.status==='needs_being').length, errors=items.filter(item=>item.status==='failed').length;
    done(`批量检查 ${items.length} 个 Kit：本机已安装 ${installed} 个，需 Being 协助 ${needs} 个，失败 ${errors} 个。加载状态见工具市场。`); return;
  }
  if (['deployPortal', 'startPortal', 'stopPortal'].includes(name)) {
    const portal = name === 'deployPortal' ? result : own(result, 'portal');
    const status = own(portal, 'status');
    if (status === 'error') { ledger.fail(id, {code: 'SERVICE_ERROR'}); return; }
    if (name === 'stopPortal' && ['stopped', 'not_configured'].includes(status)) { done('Portal 本地进程已停止。'); return; }
    if (name !== 'stopPortal' && status === 'running') { done('Portal 本地进程已启动；中继连接状态请在 Portal 页面确认。'); return; }
    if (['external', 'existing_configuration', 'existing_connection', 'not_configured', 'stopped'].includes(status)) { input(ledger, id, status === 'external' ? 'Portal 由外部程序管理，请在 Portal 页面查看当前状态。' : 'Portal 尚未完成此操作，请在 Portal 页面核对程序、配置和连接。'); return; }
    wait(ledger, id); return;
  }
  if (name === 'checkPortalUpdates') {
    const update = own(result, 'portalUpdate'), status = own(update, 'status');
    if (status === 'error') { ledger.fail(id, {code: 'NETWORK_ERROR'}); return; }
    if (status === 'available') { done('检查完成：Portal 有新版本，可在设置中查看。'); return; }
    if (status === 'current') { done('检查完成：Portal 已是当前稳定版本。'); return; }
    if (['not_installed', 'unknown'].includes(status)) { input(ledger, id, '请先在 Portal 页面确认已配置的程序版本，再检查更新。'); return; }
    wait(ledger, id); return;
  }
  if (['beginChannelConnection', 'checkChannelStatus'].includes(name)) {
    const status = own(result, 'status');
    const label = own(first, 'channel') === 'feishu' ? '飞书' : own(first, 'channel') === 'wechat' ? '微信' : '渠道';
    if (status === 'connected') { done(`Being 返回：${label}已连接。`); return; }
    if (status === 'error') { ledger.fail(id, {code: 'SERVICE_ERROR'}); return; }
    if (status === 'unsupported') { ledger.update(id, {status: 'failed', detail: `当前 Being 尚不支持连接${label}。`}); return; }
    if (status === 'disconnected' && name === 'checkChannelStatus') { done(`Being 返回：${label}当前未连接。`); return; }
    if (['registered', 'disabled', 'expired', 'disconnected', 'needs_input', 'needs_setup'].includes(status) || own(result, 'qrCodeDataUrl') || own(result, 'qrCodeUrl')) { input(ledger, id, `请在${label}功能页查看授权或配置步骤；连接尚未确认。`); return; }
    wait(ledger, id); return;
  }
  wait(ledger, id, '返回结果尚不足以确认操作完成，请在对应功能页面查看。');
}

class FeatureTaskRunner {
  constructor({getLedger} = {}) {
    if (typeof getLedger !== 'function') throw new TypeError('Feature task runner requires getLedger');
    this.getLedger = getLedger;
    this._flights = new WeakMap();
  }

  currentTask() { return currentTask(); }

  recordRequest(record) {
    const active = context.getStore();
    const requestId = own(record, 'requestId');
    if (!active || typeof requestId !== 'string') return null;
    return active.ledger.update(active.id, {requestId});
  }

  run(name, args, fn) {
    if (typeof fn !== 'function') throw new TypeError('Feature task callback is required');
    const values = Array.isArray(args) ? args : args === undefined ? [] : [args];
    const source = values[0];
    const first = {kind: own(source, 'kind'), firesideId: own(source, 'firesideId'), channel: own(source, 'channel')};
    const taskDefinition = definition(name, first);
    if (!taskDefinition) return fn();
    const ledger = this.getLedger();
    if (!ledger || ['begin', 'update', 'complete', 'fail', 'get'].some(key => typeof ledger[key] !== 'function')) throw new TypeError('Invalid feature task ledger');
    const key = requestKey(name, values);
    let flights = this._flights.get(ledger);
    if (!flights) { flights = new Map(); this._flights.set(ledger, flights); }
    if (flights.has(key)) return flights.get(key);
    let task;
    try { task = ledger.begin(taskDefinition); }
    catch (error) {
      // A full display ledger must never prevent stopping a local process.
      if (name === 'stopPortal' && own(error, 'code') === 'TASK_LIMIT_REACHED') return fn();
      throw error;
    }
    // The captured ledger belongs to the initiating identity for the entire run.
    const promise = Promise.resolve().then(() => context.run({ledger, id: task.id}, async () => {
      try {
        const result = await fn();
        finish(name, first, result, ledger, task.id);
        return result;
      } catch (error) {
        failed(ledger, task.id, error);
        throw error;
      }
    })).finally(() => { if (flights.get(key) === promise) flights.delete(key); });
    flights.set(key, promise);
    return promise;
  }
}

module.exports = {FeatureTaskRunner, currentTask};
