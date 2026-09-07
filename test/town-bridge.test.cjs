'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8');
const townMethods = ['getTownCachedData', 'listScrolls', 'getScroll', 'listBeings', 'getBeingMembers', 'getBonfireMessages', 'getFiresides', 'getFiresideMessages', 'getFiresideMembers', 'getTownMessageSnapshot', 'refreshTownMessages', 'sendBonfireMessage', 'beginChannelConnection', 'updateFeishuCredentials', 'checkChannelStatus'];
const codes = ['AUTH_REQUIRED', 'INVALID_REQUEST', 'IDENTITY_MISMATCH', 'NOT_CONNECTED', 'SESSION_CHANGED', 'BUSY', 'RATE_LIMITED', 'RESULT_UNKNOWN', 'NETWORK_ERROR', 'SERVICE_ERROR', 'INVALID_RESPONSE', 'BACKGROUND_UNAVAILABLE', 'NOT_RUNNING', 'PAUSED'];

function harness(result) {
  let api;
  const calls = [];
  const listeners = new Map();
  const ipcRenderer = {
    async invoke(channel, ...args) { calls.push({channel, args}); return typeof result === 'function' ? result(channel, args) : result; },
    on(channel, listener) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel).add(listener); },
    removeListener(channel, listener) { listeners.get(channel)?.delete(listener); },
  };
  const contextBridge = {exposeInMainWorld(name, value) { assert.equal(name, 'beingDesktop'); api = value; }};
  vm.runInNewContext(source, {require(name) { assert.equal(name, 'electron', 'Sandboxed preload must not require arbitrary local modules'); return {contextBridge, ipcRenderer}; }}, {filename: 'preload.cjs'});
  return {api, calls, listeners, emit(channel, event, value) { for (const listener of listeners.get(channel) || []) listener(event, value); }};
}

test('all Town read and write IPC methods preserve authentication codes across the preload boundary', async () => {
  const {api, calls} = harness({__townError: true, code: 'AUTH_REQUIRED', message: 'Town 尚未授权。'});
  assert.ok(Object.isFrozen(api));
  for (const method of townMethods) {
    const request = {connectionRevision: 5};
    await assert.rejects(api[method](request), {code: 'AUTH_REQUIRED', message: 'Town 尚未授权。'});
    assert.equal(calls.at(-1).channel, `being:${method}`);
    assert.deepEqual(calls.at(-1).args, [request]);
  }
});

test('preload preserves each supported Town outcome so UI can distinguish safe retry and unknown results', async () => {
  for (const code of codes) {
    const {api} = harness({__townError: true, code, message: `说明 ${code}`});
    await assert.rejects(api.sendBonfireMessage({}), {code, message: `说明 ${code}`});
  }
});

test('unknown Town error codes never expose arbitrary remote messages', async () => {
  for (const code of ['UNRECOGNIZED', '__proto__', 'constructor', '', null, 1, {private: true}]) {
    const {api} = harness({__townError: true, code, message: 'REMOTE_PRIVATE_CREDENTIALS'});
    await assert.rejects(api.getBonfireMessages({}), {code: 'TOWN_ERROR', message: 'Town 操作未完成，请稍后重试。'});
  }
});

test('Town errors expose bounded message and code without copying upstream fields', async () => {
  const {api} = harness({__townError: true, code: 'SERVICE_ERROR', message: '文'.repeat(3000), secret: 'DO_NOT_COPY', detail: {token: 'DO_NOT_COPY'}, stack: 'REMOTE_STACK'});
  await assert.rejects(api.checkChannelStatus(), error => {
    assert.equal(error.code, 'SERVICE_ERROR');
    assert.equal(error.message, '文'.repeat(2000));
    assert.equal(error.secret, undefined);
    assert.equal(error.detail, undefined);
    assert.ok(!String(error.stack).includes('REMOTE_STACK'));
    return true;
  });
});

test('malformed Town messages use a fixed user-facing fallback', async () => {
  for (const message of [undefined, null, 6, {}, ['secret']]) {
    const {api} = harness({__townError: true, code: 'AUTH_REQUIRED', message});
    await assert.rejects(api.getBeingMembers(), {code: 'AUTH_REQUIRED', message: 'Town 操作未完成，请稍后重试。'});
  }
});

test('successful Town DTOs pass through unchanged and require an exact error marker', async () => {
  for (const result of [{ok: true, members: [{id: 'echo', name: 'Echo'}]}, {code: 'AUTH_REQUIRED', message: 'Ordinary data'}, {__townError: false, code: 'AUTH_REQUIRED'}, {__townError: 'true', code: 'AUTH_REQUIRED'}, null]) {
    const {api} = harness(result);
    for (const method of townMethods) assert.equal(await api[method](), result);
  }
});

test('ordinary desktop methods retain their existing IPC return and rejection behavior', async () => {
  const envelope = {__townError: true, code: 'AUTH_REQUIRED', message: 'Opaque ordinary data'};
  const {api, calls} = harness(envelope);
  for (const method of ['getState', 'getGroveCatalog', 'deployPortal', 'connect', 'getDesktopTools']) {
    assert.equal(await api[method]('argument'), envelope);
    assert.equal(calls.at(-1).channel, `being:${method}`);
  }
  const failure = new Error('Native IPC rejection');
  const rejected = harness(() => { throw failure; });
  await assert.rejects(rejected.api.getState(), error => error === failure);
  await assert.rejects(rejected.api.sendBonfireMessage(), error => error === failure);
});

test('Town message subscriptions expose only DTO values and unsubscribe independently', () => {
  const {api, calls, listeners, emit} = harness();
  const receivedA = [], receivedB = [];
  const stopA = api.onTownMessages((...values) => receivedA.push(values));
  const stopB = api.onTownMessages((...values) => receivedB.push(values));
  const envelope = {kind: 'fireside', firesideId: '7', snapshot: {messages: [], latestSeq: 0}, status: {status: 'ready'}};
  const nativeEvent = {sender: {private: true}};
  emit('being:town-messages', nativeEvent, envelope);
  assert.deepEqual(receivedA, [[envelope]]);
  assert.deepEqual(receivedB, [[envelope]]);
  assert.equal(receivedA[0].includes(nativeEvent), false);
  stopA(); stopA();
  emit('being:town-messages', nativeEvent, envelope);
  assert.equal(receivedA.length, 1);
  assert.equal(receivedB.length, 2);
  stopB();
  assert.equal(listeners.get('being:town-messages').size, 0);
  emit('being:town-messages', nativeEvent, envelope);
  assert.equal(receivedB.length, 2);
  assert.equal(calls.length, 0);
});

test('Town message subscription rejects invalid callbacks before registering a listener', () => {
  const {api, listeners} = harness();
  for (const callback of [null, undefined, 1, {}, 'callback']) assert.throws(() => api.onTownMessages(callback), /Expected callback/);
  assert.equal(listeners.size, 0);
});
