'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {TownRefresh} = require('../src/town-refresh.cjs');

const MINUTE = 60000;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
async function settle() { for (let step = 0; step < 20; step++) await Promise.resolve(); }
function fakeClock() {
  let time = 1000, serial = 0;
  const timers = new Map();
  return {
    timers, now: () => time,
    setTimeout(callback, delay) {
      const id = ++serial;
      const handle = {id, unreferenced: false, unref() { this.unreferenced = true; }};
      timers.set(id, {callback, due: time + delay, handle});
      return handle;
    },
    clearTimeout(handle) { timers.delete(handle.id); },
    async advance(amount) {
      const target = time + amount;
      while (true) {
        const next = [...timers.values()].filter(timer => timer.due <= target).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        time = next.due; timers.delete(next.handle.id); next.callback(); await settle();
      }
      time = target; await settle();
    },
  };
}
function entry(id, content = `Message ${id}`) {
  return {id: String(id), beingId: 'alice', beingName: 'Alice', content, createdAt: '2026-09-07T09:00:00Z', revisedAt: '', mentions: []};
}
function data(messages = [entry(1)], latestSeq = messages.length ? Math.max(...messages.map(item => Number(item.id))) : 0) { return {messages, latestSeq}; }
function fault(code, extra = {}) { return Object.assign(new Error('PRIVATE_REMOTE_DETAIL'), {code, ...extra}); }
function harness(options = {}) {
  const clock = fakeClock();
  const state = {identity: {beingId: 'alice', connectionRevision: 1, identityRevision: 1}, result: data(), calls: [], snapshots: [], statuses: []};
  const reader = new TownRefresh({
    clock, getIdentity: () => state.identity,
    readSnapshot: args => { state.calls.push(args); return options.read ? options.read(args, state) : state.result; },
    onSnapshot: value => state.snapshots.push(value), onStatus: value => state.statuses.push(value),
    ...options.overrides,
  });
  return {reader, clock, state};
}

test('persistent cache rebinds the identity and retains manual receipts against older background results', async t => {
  const {reader, state} = harness({overrides: {cached: true, automatic: false}});
  t.after(() => reader.stop());
  const cached = {...data([entry(7, 'Saved content')]), capturedAt: 500, revision: 'manual:1', manual: true};
  assert.equal(reader.restoreCache(cached), true);
  cached.messages[0].content = 'Mutated caller';
  assert.deepEqual(reader.snapshot().identity, state.identity);
  assert.equal(reader.snapshot().messages[0].content, 'Saved content');
  assert.equal(reader.status().lastSuccessAt, 500);
  assert.equal(reader.status().lastCheckedAt, null);
  assert.equal(reader.status().stale, true);
  reader.start();
  for (const capturedAt of [400, 500]) {
    state.result = {...data([entry(6, 'Older data')]), capturedAt, revision: `sbs:${capturedAt}`};
    await reader.refresh();
    assert.equal(reader.snapshot().messages[0].content, 'Saved content');
  }
  state.result = {...data([entry(8, 'Fresh data')]), capturedAt: 900, revision: 'sbs:new'};
  await reader.refresh();
  assert.equal(reader.snapshot().messages[0].content, 'Fresh data');
  assert.equal(reader.restoreCache({...cached, capturedAt: 9999}), false);
});

test('invalid disk snapshots are ignored and successful persistence observers cannot disrupt refresh', async t => {
  const saved = [];
  const {reader, state} = harness({overrides: {cached: true, automatic: false, onSuccess: value => { saved.push(value); throw new Error('Disk unavailable'); }}});
  t.after(() => reader.stop());
  const valid = {...data(), capturedAt: 500, revision: 'sbs:1', manual: false};
  for (const value of [null, {}, {...valid, latestSeq: -1}, {...valid, capturedAt: 'today'}, {...valid, manual: null}, {...valid, messages: [{id: 3, content: 'Invalid ID'}]}]) {
    assert.equal(reader.restoreCache(value), false);
    assert.deepEqual(reader.snapshot().messages, []);
  }
  reader.start();
  state.result = {...valid, capturedAt: 600, revision: 'sbs:2'};
  await reader.refresh();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].capturedAt, 600);
  assert.equal(saved[0].revision, 'sbs:2');
  state.result = {};
  await assert.rejects(reader.refresh(), {code: 'INVALID_RESPONSE'});
  assert.equal(saved.length, 1);
  assert.equal(reader.snapshot().messages.length, 1);
});

test('starts once immediately and schedules one unreferenced read after a full minute', async () => {
  const {reader, clock, state} = harness();
  reader.start(); reader.start(); await settle();
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].limit, 10);
  assert.deepEqual(state.calls[0].identity, state.identity);
  assert.equal(clock.timers.size, 1);
  assert.ok([...clock.timers.values()][0].handle.unreferenced);
  await clock.advance(MINUTE - 1); assert.equal(state.calls.length, 1);
  await clock.advance(1); assert.equal(state.calls.length, 2);
  reader.stop(); assert.equal(clock.timers.size, 0);
});

test('manual mode never reads on start, reset, resume or restart', async () => {
  const {reader, clock, state} = harness({overrides: {automatic: false}});
  reader.start(); reader.start();
  reader.pause('offline'); reader.resume();
  reader.pause('suspended'); reader.resume();
  reader.reset();
  reader.stop(); reader.start();
  await clock.advance(20 * MINUTE);
  assert.equal(state.calls.length, 0);
  assert.equal(clock.timers.size, 0);
  assert.equal(reader.status().status, 'waiting');
  assert.equal(reader.status().reason, 'manual');
  assert.equal(reader.status().nextRefreshAt, null);
  const result = await reader.refresh();
  assert.equal(result.messages[0].id, '1');
  await clock.advance(20 * MINUTE);
  assert.equal(state.calls.length, 1);
  assert.equal(clock.timers.size, 0);
  assert.equal(reader.status().status, 'ready');
  assert.equal(reader.status().reason, 'manual');
  assert.equal(reader.status().nextRefreshAt, null);
  reader.stop();
});

test('manual mode joins one requested read and never retries rejected reads', async () => {
  const gate = deferred();
  let rejected = false;
  const {reader, clock, state} = harness({overrides: {automatic: false}, read: () => rejected ? Promise.reject(fault('BUSY')) : gate.promise});
  reader.start();
  const first = reader.refresh(); const second = reader.refresh();
  assert.equal(first, second);
  await clock.advance(20 * MINUTE);
  assert.equal(state.calls.length, 1);
  gate.resolve(data()); await first;
  rejected = true;
  await assert.rejects(reader.refresh(), {code: 'BUSY'});
  await clock.advance(20 * MINUTE);
  assert.equal(state.calls.length, 2);
  assert.equal(clock.timers.size, 0);
  assert.equal(reader.status().reason, 'manual');
  assert.equal(reader.status().nextRefreshAt, null);
  assert.equal(reader.snapshot().messages[0].id, '1');
  reader.stop();
});

test('automatic refresh setting accepts only explicit booleans', () => {
  for (const automatic of ['false', 0, null]) assert.throws(() => harness({overrides: {automatic}}), TypeError);
});

test('accepted requests stay pending without fault backoff or any automatic replay', async () => {
  for (const automatic of [false, true]) {
    const {reader, clock, state} = harness({overrides: {automatic}, read: () => { throw fault('REQUEST_ACCEPTED'); }});
    reader.start();
    if (!automatic) await assert.rejects(reader.refresh(), {code: 'REQUEST_ACCEPTED', message: '请求已送达 Being，结果待确认；不会自动重发。'});
    await settle();
    reader.pause('offline'); reader.resume();
    reader.stop(); reader.start();
    await clock.advance(30 * MINUTE);
    assert.equal(state.calls.length, 1);
    assert.equal(clock.timers.size, 0);
    assert.equal(reader.status().status, 'waiting');
    assert.equal(reader.status().reason, 'being_pending');
    assert.equal(reader.status().errorCode, 'REQUEST_ACCEPTED');
    assert.equal(reader.status().failureCount, 0);
    assert.equal(reader.status().nextRefreshAt, null);
    reader.stop();
  }
});

test('a busy Being waits one minute without an error banner or growing failure backoff', async () => {
  const {reader, clock, state} = harness({read: () => { throw fault('BUSY'); }});
  reader.start(); await settle();
  assert.equal(reader.status().status, 'waiting');
  assert.equal(reader.status().reason, 'being_busy');
  assert.equal(reader.status().failureCount, 0);
  await clock.advance(MINUTE);
  assert.equal(state.calls.length, 2);
  assert.equal(reader.status().nextRefreshAt, clock.now() + MINUTE);
  assert.equal(reader.status().failureCount, 0);
  reader.stop();
});

test('manual and automatic requests join the same flight without an immediate queued refresh', async () => {
  const gate = deferred();
  const {reader, clock, state} = harness({read: () => gate.promise});
  reader.start(); await settle();
  const first = reader.refresh(); const second = reader.refresh();
  assert.equal(first, second);
  await clock.advance(10 * MINUTE);
  assert.equal(state.calls.length, 1); assert.equal(clock.timers.size, 0);
  gate.resolve(data()); await first; await settle();
  assert.equal(state.calls.length, 1);
  assert.equal(reader.status().nextRefreshAt, clock.now() + MINUTE);
  await clock.advance(MINUTE - 1); assert.equal(state.calls.length, 1);
  await clock.advance(1); assert.equal(state.calls.length, 2);
  reader.stop();
});

test('manual refresh can run immediately while scheduled reads remain completion based', async () => {
  const {reader, clock, state} = harness();
  reader.start(); await settle(); await clock.advance(10);
  await reader.refresh();
  assert.equal(state.calls.length, 2);
  assert.equal(reader.status().nextRefreshAt, clock.now() + MINUTE);
  await clock.advance(MINUTE - 1); assert.equal(state.calls.length, 2);
  await clock.advance(1); assert.equal(state.calls.length, 3);
  reader.stop();
});

test('full snapshots replace edits and deletions, deduplicate IDs, sort and cap the latest window', async () => {
  const {reader, state} = harness({overrides: {limit: 100}});
  state.result = data(Array.from({length: 200}, (_, index) => entry(200 - index)));
  reader.start(); await settle();
  assert.equal(reader.snapshot().messages.length, 100);
  assert.equal(reader.snapshot().messages[0].id, '101');
  assert.equal(reader.snapshot().messages.at(-1).id, '200');
  state.result = data([entry(200, 'old'), {...entry(200, 'revised'), revisedAt: '2026-09-07T10:00:00Z'}, entry(201)], 201);
  await reader.refresh();
  assert.deepEqual(reader.snapshot().messages.map(value => [value.id, value.content]), [['200', 'revised'], ['201', 'Message 201']]);
  state.result = data([], 201); await reader.refresh();
  assert.deepEqual(reader.snapshot().messages, []);
  assert.equal(reader.snapshot().latestSeq, 201);
  reader.stop();
});

test('unchanged snapshots do not publish new messages and returned values cannot mutate the cache', async () => {
  const {reader, state} = harness();
  state.result = data([entry(1, 'PRIVATE_MESSAGE_SENTINEL')]);
  reader.start(); await settle();
  await reader.refresh(); assert.equal(state.snapshots.length, 1);
  const snapshot = reader.snapshot(); snapshot.messages[0].content = 'changed'; snapshot.identity.beingId = 'bob';
  state.snapshots[0].messages.length = 0;
  assert.equal(reader.snapshot().messages[0].content, 'PRIVATE_MESSAGE_SENTINEL');
  assert.equal(reader.snapshot().identity.beingId, 'alice');
  assert.ok(!JSON.stringify(reader.status()).includes('PRIVATE_MESSAGE_SENTINEL'));
  assert.ok(!JSON.stringify(state.statuses).includes('PRIVATE_MESSAGE_SENTINEL'));
  reader.stop();
});

test('transient failures preserve prior content and success time with bounded minute backoff', async () => {
  let broken = false;
  const {reader, clock, state} = harness({read: () => { if (broken) throw fault('NETWORK_ERROR'); return data(); }});
  reader.start(); await settle();
  const successAt = reader.status().lastSuccessAt; broken = true;
  for (const delay of [MINUTE, 2 * MINUTE, 4 * MINUTE, 5 * MINUTE, 5 * MINUTE]) {
    await assert.rejects(reader.refresh(), {code: 'NETWORK_ERROR'});
    assert.equal(reader.status().nextRefreshAt, clock.now() + delay);
    assert.equal(reader.status().lastSuccessAt, successAt);
    assert.equal(reader.status().stale, true);
    assert.equal(reader.snapshot().messages.length, 1);
    assert.ok(!JSON.stringify(reader.status()).includes('PRIVATE_REMOTE_DETAIL'));
  }
  broken = false; await reader.refresh();
  assert.equal(reader.status().failureCount, 0); assert.equal(reader.status().stale, false);
  assert.equal(reader.status().nextRefreshAt, clock.now() + MINUTE);
  assert.equal(state.snapshots.length, 1); reader.stop();
});

test('rate limiting honors bounded retry delay and never retries sooner than a minute', async () => {
  const {reader, clock} = harness({read: () => { throw fault('RATE_LIMITED', {retryAfterMs: 180000}); }});
  reader.start(); await settle();
  assert.equal(reader.status().nextRefreshAt, clock.now() + 180000);
  reader.stop();
  const fast = harness({read: () => { throw fault('RATE_LIMITED', {retryAfterMs: 2}); }});
  fast.reader.start(); await settle();
  assert.equal(fast.reader.status().nextRefreshAt, fast.clock.now() + MINUTE);
  fast.reader.stop();
});

test('authorization, identity and unavailable errors pause until manual retry or reset', async () => {
  for (const code of ['AUTH_REQUIRED', 'IDENTITY_MISMATCH', 'BACKGROUND_UNAVAILABLE']) {
    let broken = true;
    const {reader, clock, state} = harness({read: () => { if (broken) throw fault(code); return data(); }});
    reader.start(); await settle();
    assert.equal(reader.status().status, 'paused'); assert.equal(reader.status().errorCode, code);
    assert.equal(clock.timers.size, 0);
    await clock.advance(60 * MINUTE); reader.resume(); await settle();
    assert.equal(state.calls.length, 1);
    reader.pause('suspended'); reader.resume(); await settle();
    assert.equal(state.calls.length, 1);
    broken = false; await reader.refresh();
    assert.equal(state.calls.length, 2); assert.equal(reader.status().status, 'ready');
    reader.stop();
  }
});

test('pause aborts in-flight work and resume coalesces without replaying missed ticks', async () => {
  const gate = deferred();
  const {reader, clock, state} = harness({read: (_args, current) => current.calls.length === 1 ? gate.promise : data([entry(2)])});
  reader.start(); await settle();
  const pending = reader.refresh(); const rejected = assert.rejects(pending, {code: 'SESSION_CHANGED'});
  reader.pause('suspended'); assert.equal(state.calls[0].signal.aborted, true);
  await clock.advance(20 * MINUTE); assert.equal(state.calls.length, 1);
  await assert.rejects(reader.refresh(), {code: 'PAUSED'});
  reader.resume(); reader.resume(); await settle();
  assert.equal(state.calls.length, 2);
  gate.resolve(data([entry(1, 'STALE')])); await rejected;
  assert.equal(reader.snapshot().messages[0].id, '2');
  assert.equal(clock.timers.size, 1); reader.stop();
});

test('stop and restart cannot silently retry a blocked authorization failure', async () => {
  const {reader, clock, state} = harness({read: () => { throw fault('AUTH_REQUIRED'); }});
  reader.start(); await settle(); reader.stop();
  await clock.advance(10 * MINUTE); reader.start(); await settle();
  assert.equal(state.calls.length, 1);
  assert.equal(reader.status().status, 'paused'); assert.equal(clock.timers.size, 0);
  reader.reset(); await settle(); assert.equal(state.calls.length, 2);
  reader.stop();
});

test('brief pause and repeated resume cannot shorten the automatic interval', async () => {
  const {reader, clock, state} = harness();
  reader.start(); await settle(); await clock.advance(1000);
  reader.pause(); reader.resume(); reader.resume(); await settle();
  assert.equal(state.calls.length, 1);
  assert.equal(reader.status().status, 'waiting'); assert.equal(reader.status().reason, '');
  await clock.advance(MINUTE - 1); assert.equal(state.calls.length, 1);
  await clock.advance(1); assert.equal(state.calls.length, 2);
  reader.stop();
});

test('identity reset aborts old transport and cannot let its finally replace the new timer', async () => {
  const gate = deferred();
  const {reader, clock, state} = harness({read: (_args, current) => current.calls.length === 1 ? gate.promise : data([entry(2, 'NEW_IDENTITY')])});
  reader.start(); await settle();
  const pending = reader.refresh(); const rejected = assert.rejects(pending, {code: 'SESSION_CHANGED'});
  state.identity = {beingId: 'bob', connectionRevision: 2, identityRevision: 2};
  reader.reset(); await settle();
  assert.equal(state.calls[0].signal.aborted, true);
  assert.equal(state.calls[1].identity.beingId, 'bob');
  gate.resolve(data([entry(1, 'OLD_IDENTITY')])); await rejected;
  assert.equal(reader.snapshot().identity.beingId, 'bob');
  assert.equal(reader.snapshot().messages[0].content, 'NEW_IDENTITY');
  assert.equal(clock.timers.size, 1); reader.stop();
});

test('identity change without an explicit reset is checked before committing a response', async () => {
  const gate = deferred();
  const {reader, state} = harness({read: (_args, current) => current.calls.length === 1 ? gate.promise : data([entry(2)])});
  reader.start(); await settle();
  state.identity = {beingId: 'bob', connectionRevision: 2, identityRevision: 2};
  gate.resolve(data([entry(1)])); await settle();
  assert.equal(state.calls.length, 2);
  assert.equal(reader.snapshot().identity.beingId, 'bob');
  assert.equal(reader.snapshot().messages[0].id, '2'); reader.stop();
});

test('missing or malformed identity clears cached messages and last success before pausing', async () => {
  for (const identity of [null, {beingId: 'bob'}, {beingId: 'bob', connectionRevision: 2, identityRevision: 2, token: 'DO_NOT_LEAK'}]) {
    const {reader, state, clock} = harness();
    reader.start(); await settle(); assert.equal(reader.snapshot().messages.length, 1);
    state.identity = identity;
    await assert.rejects(reader.refresh(), {code: identity ? 'IDENTITY_MISMATCH' : 'NOT_CONNECTED'});
    assert.deepEqual(reader.snapshot(), {identity: null, messages: [], latestSeq: null});
    assert.equal(reader.status().lastSuccessAt, null); assert.equal(clock.timers.size, 0);
    assert.ok(!JSON.stringify(state.statuses).includes('DO_NOT_LEAK'));
    assert.equal(state.calls.length, 1); reader.stop();
  }
});

test('getIdentity exceptions and getters cannot retain previous identity or leak details', async () => {
  let broken = false;
  const {reader} = harness({overrides: {getIdentity: () => { if (broken) throw new Error('PRIVATE_IDENTITY_ERROR'); return {beingId: 'alice', connectionRevision: 1, identityRevision: 1}; }}});
  reader.start(); await settle(); broken = true;
  await assert.rejects(reader.refresh(), error => error.code === 'IDENTITY_MISMATCH' && !error.message.includes('PRIVATE'));
  assert.equal(reader.status().lastSuccessAt, null); assert.equal(reader.snapshot().messages.length, 0); reader.stop();
  let getterUsed = false;
  const invalid = harness(); invalid.state.identity = {get beingId() { getterUsed = true; return 'alice'; }, connectionRevision: 1, identityRevision: 1};
  invalid.reader.start(); await settle(); assert.equal(getterUsed, false); assert.equal(invalid.state.calls.length, 0); invalid.reader.stop();
});

test('stop then reset clears data without issuing a new request', async () => {
  const {reader, state, clock} = harness();
  reader.start(); await settle(); reader.stop(); reader.reset();
  await clock.advance(20 * MINUTE);
  assert.equal(state.calls.length, 1); assert.equal(reader.status().status, 'stopped');
  assert.equal(reader.snapshot().messages.length, 0);
  await assert.rejects(reader.refresh(), {code: 'NOT_RUNNING'});
});

test('malformed transport results preserve the previous complete window', async () => {
  const {reader, state} = harness();
  reader.start(); await settle();
  const malformed = [null, {messages: [], latestSeq: -1}, data([entry(3)], 2), data([{id: 'bad', content: 'x'}], 5), data(Array.from({length: 201}, (_, index) => entry(index)))];
  for (const value of malformed) {
    state.result = value;
    await assert.rejects(reader.refresh(), {code: 'INVALID_RESPONSE'});
    assert.equal(reader.snapshot().messages[0].id, '1'); assert.equal(reader.status().stale, true);
  }
  reader.stop();
});

test('limits are configurable only within the supported minute and message bounds', async () => {
  for (const options of [{intervalMs: 59999}, {intervalMs: 300001}, {limit: 0}, {limit: 201}]) {
    assert.throws(() => new TownRefresh({readSnapshot: () => data(), getIdentity: () => null, ...options}), RangeError);
  }
  const {reader, state} = harness({overrides: {limit: 200}});
  state.result = data(Array.from({length: 200}, (_, index) => entry(index)));
  reader.start(); await settle(); assert.equal(reader.snapshot().messages.length, 200);
  assert.equal(state.calls[0].limit, 200); reader.stop();
});

test('snapshot and status observers cannot alter results by throwing', async () => {
  const {reader, clock} = harness({overrides: {onSnapshot: () => { throw new Error('Observer failed'); }, onStatus: () => { throw new Error('Observer failed'); }}});
  reader.start(); await settle();
  assert.equal(reader.status().status, 'ready'); assert.equal(reader.snapshot().messages.length, 1);
  assert.equal(clock.timers.size, 1); reader.stop();
});

test('cached revisions preserve capture time and cannot overwrite data with repeated or older results', async () => {
  const {reader, clock, state} = harness({overrides: {cached: true}});
  state.result = {...data([entry(1, 'Original')]), capturedAt: 500, revision: 'capture:one'};
  reader.start(); await settle();
  assert.equal(reader.status().lastSuccessAt, 500);
  assert.equal(reader.status().lastCheckedAt, 1000);
  assert.equal(reader.status().revision, 'capture:one');
  state.result = {...data([entry(2, 'Different content under the same revision')]), capturedAt: 900, revision: 'capture:one'};
  await clock.advance(MINUTE);
  assert.equal(reader.status().lastSuccessAt, 500);
  assert.equal(reader.status().lastCheckedAt, clock.now());
  assert.equal(reader.snapshot().messages[0].content, 'Original');
  assert.equal(state.snapshots.length, 1);
  state.result = {...data([entry(3, 'Older capture')]), capturedAt: 400, revision: 'capture:old'};
  await reader.refresh();
  assert.equal(reader.status().revision, 'capture:one');
  assert.equal(reader.snapshot().messages[0].content, 'Original');
  state.result = {...data([], 3), capturedAt: clock.now() - 10, revision: 'capture:two'};
  await reader.refresh();
  assert.equal(reader.status().lastSuccessAt, clock.now() - 10);
  assert.equal(reader.status().revision, 'capture:two');
  assert.deepEqual(reader.snapshot().messages, []);
  assert.equal(reader.status().reason, 'sbs');
  reader.stop();
});

test('waiting for SBS preserves the last snapshot and capture time without counting a failure', async () => {
  let waiting = false;
  const {reader, clock, state} = harness({overrides: {cached: true}, read: () => {
    if (waiting) throw fault('WAITING_SBS');
    return {...data(), capturedAt: 500, revision: 'capture:one'};
  }});
  reader.start(); await settle(); waiting = true;
  await clock.advance(3 * MINUTE);
  assert.equal(state.calls.length, 4);
  assert.equal(reader.status().lastSuccessAt, 500);
  assert.equal(reader.status().lastCheckedAt, clock.now());
  assert.equal(reader.status().reason, 'waiting_sbs');
  assert.equal(reader.status().status, 'waiting');
  assert.equal(reader.status().failureCount, 0);
  assert.equal(reader.status().stale, true);
  assert.equal(reader.status().revision, 'capture:one');
  assert.equal(reader.snapshot().messages[0].id, '1');
  assert.equal(reader.status().nextRefreshAt, clock.now() + MINUTE);
  reader.stop();
});

test('missing or malformed cache receipts cannot masquerade as fresh snapshots', async () => {
  const {reader, state} = harness({overrides: {cached: true}});
  state.result = {...data(), capturedAt: 500, revision: 'capture:one'};
  reader.start(); await settle();
  for (const receipt of [{}, {capturedAt: '500', revision: 'x'}, {capturedAt: -1, revision: 'x'}, {capturedAt: 8640000000000001, revision: 'x'}, {capturedAt: 500, revision: ''}, {capturedAt: 500, revision: 'x\n'}, {capturedAt: 500, revision: 'x'.repeat(129)}]) {
    state.result = {...data([entry(2)]), ...receipt};
    await assert.rejects(reader.refresh(), {code: 'INVALID_RESPONSE'});
    assert.equal(reader.snapshot().messages[0].id, '1');
    assert.equal(reader.status().lastSuccessAt, 500);
    assert.equal(reader.status().revision, 'capture:one');
  }
  reader.stop();
});

test('cache identity reset clears the receipt and allows the new identity older capture', async () => {
  const {reader, state} = harness({overrides: {cached: true}});
  state.result = {...data([entry(1, 'Alice')]), capturedAt: 900, revision: 'alice:one'};
  reader.start(); await settle();
  state.identity = {beingId: 'bob', connectionRevision: 2, identityRevision: 2};
  state.result = {...data([entry(2, 'Bob')]), capturedAt: 400, revision: 'bob:one'};
  reader.reset(); await settle();
  assert.equal(reader.snapshot().identity.beingId, 'bob');
  assert.equal(reader.snapshot().messages[0].content, 'Bob');
  assert.equal(reader.status().lastSuccessAt, 400);
  assert.equal(reader.status().revision, 'bob:one');
  reader.stop();
});

test('an unconfigured SBS source remains distinct from waiting for a scheduled capture', async () => {
  let code = '';
  const {reader, clock, state} = harness({overrides: {cached: true}, read: () => {
    if (code) throw fault(code);
    return {...data(), capturedAt: 500, revision: 'capture:one'};
  }});
  reader.start(); await settle();
  code = 'SBS_NOT_CONFIGURED';
  await assert.rejects(reader.refresh(), {code, message: '后台采集尚未设置，可请 Being 读取一次'});
  reader.pause('offline'); reader.resume();
  assert.equal(reader.status().status, 'waiting');
  assert.equal(reader.status().reason, 'sbs_not_configured');
  await clock.advance(3 * MINUTE);
  assert.equal(reader.status().reason, 'sbs_not_configured');
  assert.equal(reader.status().failureCount, 0);
  assert.equal(reader.status().lastSuccessAt, 500);
  assert.equal(reader.status().lastCheckedAt, clock.now());
  assert.equal(reader.snapshot().messages[0].id, '1');
  assert.equal(reader.status().stale, true);
  assert.equal(state.calls.length, 5);
  code = 'WAITING_SBS';
  await clock.advance(MINUTE);
  assert.equal(reader.status().reason, 'waiting_sbs');
  assert.equal(reader.status().failureCount, 0);
  assert.equal(reader.status().nextRefreshAt, clock.now() + MINUTE);
  reader.stop();
});
