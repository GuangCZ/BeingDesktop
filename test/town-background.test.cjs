'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {TownBackground} = require('../src/town-background.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

async function settle() { for (let count = 0; count < 20; count++) await Promise.resolve(); }

function fakeClock() {
  let now = 1000, nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) { const id = nextId++; timers.set(id, {at: now + delay, callback}); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(duration) {
      const target = now + duration;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].callback(); await settle();
      }
      now = target; await settle();
    },
    pending: () => timers.size,
  };
}

function snapshot(content, id = 1) {
  return {messages: [{id: String(id), beingId: 'echo', beingName: 'Echo', content, createdAt: '2026-09-07', revisedAt: '', mentions: []}], latestSeq: id};
}

function harness({read = () => snapshot('Town message'), readCachedSnapshot, bonfireCache, getCacheKey, onUpdate} = {}) {
  let identity = {beingId: 'alice', connectionRevision: 1, identityRevision: 1};
  const calls = [], updates = [], statuses = [], clock = fakeClock();
  const call = async (kind, value, options) => {
    const entry = {kind, value, signal: options.signal}; calls.push(entry);
    return read(entry, calls.length);
  };
  const townSession = {
    getBonfireMessages: (value, options) => call('bonfire', value, options),
    getFiresideMessages: (value, options) => call('fireside', value, options),
  };
  const background = new TownBackground({townSession, getIdentity: () => identity, clock, bonfireCache, getCacheKey, ...(readCachedSnapshot ? {readCachedSnapshot} : {}),
    onUpdate(value) { updates.push(structuredClone(value)); onUpdate?.(value); },
    onStatus() { statuses.push(background.metadata()); },
  });
  return {background, clock, calls, updates, statuses, setIdentity(value) { identity = value; }};
}

test('startup restores persistent Bonfire messages before polling or an explicit Being read', async t => {
  const disk = deferred(), upstream = deferred(), events = [];
  const cached = {...snapshot('Saved before exit', 7), capturedAt: 500, revision: 'manual:1', manual: true};
  const {background, calls, updates} = harness({
    bonfireCache: {load: () => disk.promise, save: () => {}}, getCacheKey: () => 'alice-session',
    readCachedSnapshot: () => { events.push('poll'); return upstream.promise; },
    onUpdate: value => { if (value.snapshot.messages[0]?.content === 'Saved before exit') events.push('restored'); },
  });
  t.after(() => background.stop());
  background.lifecycle({enabled: true});
  const requested = background.requestRead({kind: 'bonfire'});
  await settle();
  assert.equal(calls.length, 0);
  assert.deepEqual(events, []);
  disk.resolve(cached);
  await background.restore();
  assert.equal(background.snapshot({kind: 'bonfire'}).snapshot.messages[0].content, 'Saved before exit');
  assert.equal(events[0], 'restored');
  await requested;
  assert.equal(calls.length, 1);
  assert.ok(updates.some(value => value.snapshot.messages[0]?.content === 'Saved before exit' && value.status.stale));
  assert.equal(background.snapshot({kind: 'bonfire'}).snapshot.messages[0].content, 'Town message');
  upstream.resolve({...snapshot('Older collection'), capturedAt: 100, revision: 'sbs:old'});
  await settle();
  assert.equal(background.snapshot({kind: 'bonfire'}).snapshot.messages[0].content, 'Town message');
});

test('Fireside restores its own persistent messages before polling and an explicit read', async t => {
  const disk = deferred(), poll = deferred(), saved = [], events = [];
  const cached = {...snapshot('Saved room seven', 7), capturedAt: 500, revision: 'room-seven', manual: true};
  const {background, calls} = harness({
    bonfireCache: {load: key => key.endsWith(':fireside:7') ? disk.promise : null, save: (key, value) => saved.push({key, value})}, getCacheKey: () => 'alice-session',
    readCachedSnapshot: value => { if (value.kind === 'fireside') events.push('poll'); return poll.promise; },
    onUpdate: value => { if (value.snapshot.messages[0]?.content === 'Saved room seven') events.push('restored'); },
  });
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await background.restore();
  background.reconcileRooms({owned: [{id: 7}], joined: []});
  const restoring = background.cachedSnapshot({kind: 'fireside', firesideId: '7'});
  const requested = background.requestRead({kind: 'fireside', firesideId: '7'});
  await settle();
  assert.equal(calls.length, 0); assert.deepEqual(events, []);
  disk.resolve(cached);
  const restored = await restoring;
  assert.equal(restored.snapshot.messages[0].content, 'Saved room seven');
  assert.equal(events[0], 'restored');
  await requested;
  assert.deepEqual(saved.map(value => value.key), ['alice-session:fireside:7']);
  assert.equal(saved[0].value.messages[0].content, 'Town message');
});

test('Fireside cache survives switching rooms and reconnects with the current identity', async t => {
  const records = new Map();
  let key = 'alice-session';
  const {background, setIdentity} = harness({
    bonfireCache: {load: async key => records.get(key), save: (key, value) => records.set(key, structuredClone(value))}, getCacheKey: () => key,
    read: call => snapshot(`Private room ${call.value.firesideId}`, Number(call.value.firesideId)),
  });
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await background.restore();
  await background.requestRead({kind: 'fireside', firesideId: '7'});
  await background.requestRead({kind: 'fireside', firesideId: '8'});
  assert.equal((await background.cachedSnapshot({kind: 'fireside', firesideId: '7'})).snapshot.messages[0].content, 'Private room 7');
  const identity = {beingId: 'alice', connectionRevision: 2, identityRevision: 1};
  setIdentity(identity); background.lifecycle({enabled: true}); await background.restore();
  const restored = await background.cachedSnapshot({kind: 'fireside', firesideId: '8'});
  assert.equal(restored.snapshot.messages[0].content, 'Private room 8');
  assert.deepEqual(restored.snapshot.identity, identity);
  key = 'another-alice-session';
  setIdentity({...identity, connectionRevision: 3, identityRevision: 2}); background.lifecycle({enabled: true}); await background.restore();
  assert.deepEqual((await background.cachedSnapshot({kind: 'fireside', firesideId: '8'})).snapshot.messages, []);
  assert.equal(records.size, 2);
});

test('switching rooms while disk restore is pending rejects the old request before it can read or publish', async t => {
  const disk = deferred();
  const {background, calls, updates} = harness({
    bonfireCache: {load: key => key.endsWith(':fireside:7') ? disk.promise : null, save: () => {}}, getCacheKey: () => 'alice-session',
  });
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await background.restore();
  const oldSnapshot = assert.rejects(background.cachedSnapshot({kind: 'fireside', firesideId: '7'}), {code: 'SESSION_CHANGED'});
  const oldRead = assert.rejects(background.requestRead({kind: 'fireside', firesideId: '7'}), {code: 'SESSION_CHANGED'});
  await settle();
  await background.cachedSnapshot({kind: 'fireside', firesideId: '8'});
  const cut = updates.length;
  disk.resolve({...snapshot('Removed private content'), capturedAt: 500, revision: 'old', manual: true});
  await Promise.all([oldSnapshot, oldRead]);
  assert.equal(calls.length, 0);
  assert.ok(!JSON.stringify(updates.slice(cut)).includes('Removed private content'));
  assert.deepEqual(background.snapshot({kind: 'fireside', firesideId: '8'}).snapshot.messages, []);
});

test('reconciled room removal prevents an outstanding or later persistent restore', async t => {
  const disk = deferred(), loaded = [];
  const {background, updates} = harness({
    bonfireCache: {load: key => { loaded.push(key); return key.endsWith(':fireside:7') ? disk.promise : null; }, save: () => {}}, getCacheKey: () => 'alice-session',
  });
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await background.restore();
  background.reconcileRooms({owned: [{id: 7}], joined: []});
  const pending = assert.rejects(background.cachedSnapshot({kind: 'fireside', firesideId: '7'}), {code: 'SESSION_CHANGED'});
  await settle();
  background.reconcileRooms({owned: [], joined: [{id: 8}]});
  const cut = updates.length;
  disk.resolve({...snapshot('Removed private content'), capturedAt: 500, revision: 'old', manual: true});
  await pending;
  await assert.rejects(background.cachedSnapshot({kind: 'fireside', firesideId: '7'}), {code: 'AUTH_REQUIRED'});
  await assert.rejects(background.requestRead({kind: 'fireside', firesideId: '7'}), {code: 'AUTH_REQUIRED'});
  assert.equal(loaded.filter(key => key.endsWith(':fireside:7')).length, 1);
  assert.ok(!JSON.stringify(updates.slice(cut)).includes('Removed private content'));
  assert.equal(background.metadata().fireside, null);
});

test('persisted receipt stays paired with validated messages and errors never replace the disk record', async t => {
  const saved = [];
  let value = {...snapshot('Fresh collection', 8), capturedAt: 600, revision: 'sbs:8'};
  const {background} = harness({
    bonfireCache: {load: async () => null, save: (key, record) => saved.push({key, record})}, getCacheKey: () => 'alice-session',
    readCachedSnapshot: async () => { if (value instanceof Error) throw value; return value; },
  });
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await background.restore(); await settle();
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], {key: 'alice-session', record: {...snapshot('Fresh collection', 8), capturedAt: 600, revision: 'sbs:8', manual: false}});
  value = Object.assign(new Error('Unavailable'), {code: 'WAITING_SBS'});
  await assert.rejects(background.refresh({kind: 'bonfire'}), {code: 'WAITING_SBS'});
  assert.equal(saved.length, 1);
  assert.equal(background.snapshot({kind: 'bonfire'}).snapshot.messages[0].content, 'Fresh collection');
  value = {messages: [], latestSeq: 8, capturedAt: 800, revision: 'sbs:empty'};
  await background.refresh({kind: 'bonfire'});
  assert.deepEqual(saved.at(-1).record, {...value, manual: false});
});

test('reconnect restores the same connection cache with current revisions and switching sessions isolates it', async t => {
  const records = new Map();
  let key = 'alice-session';
  const {background, setIdentity} = harness({
    bonfireCache: {load: async key => records.get(key), save: (key, value) => records.set(key, structuredClone(value))}, getCacheKey: () => key,
  });
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await background.restore();
  await background.requestRead({kind: 'bonfire'});
  const identity = {beingId: 'alice', connectionRevision: 2, identityRevision: 1};
  setIdentity(identity); background.lifecycle({enabled: true}); await background.restore();
  const restored = background.snapshot({kind: 'bonfire'});
  assert.equal(restored.snapshot.messages[0].content, 'Town message');
  assert.deepEqual(restored.snapshot.identity, identity);
  assert.equal(restored.status.stale, true);
  key = 'another-alice-session';
  setIdentity({...identity, connectionRevision: 3, identityRevision: 2});
  background.lifecycle({enabled: true}); await background.restore();
  assert.deepEqual(background.snapshot({kind: 'bonfire'}).snapshot.messages, []);
  assert.equal(records.size, 1);
});

test('late disk loads and reads cannot cross a connection change or restart work after stop', async () => {
  const old = deferred();
  let key = 'alice-session';
  const {background, setIdentity, calls, updates} = harness({
    bonfireCache: {load: key => key === 'alice-session' ? old.promise : null, save: () => {}}, getCacheKey: () => key,
  });
  background.lifecycle({enabled: true});
  const requested = background.requestRead({kind: 'bonfire'});
  const rejected = assert.rejects(requested, {code: 'SESSION_CHANGED'});
  await settle();
  key = 'bob-session'; setIdentity({beingId: 'bob', connectionRevision: 2, identityRevision: 2});
  background.lifecycle({enabled: true}); await background.restore();
  const cut = updates.length;
  old.resolve({...snapshot('Private old content'), capturedAt: 500, revision: 'old', manual: true});
  await rejected;
  assert.deepEqual(background.snapshot({kind: 'bonfire'}).snapshot.messages, []);
  assert.ok(!JSON.stringify(updates.slice(cut)).includes('Private old content'));
  background.stop();
  assert.equal(calls.length, 0);

  const pending = deferred();
  const stopped = harness({bonfireCache: {load: () => pending.promise, save: () => {}}, getCacheKey: () => 'stopped',
    readCachedSnapshot: () => { throw new Error('Must not poll'); }});
  stopped.background.lifecycle({enabled: true}); stopped.background.stop();
  pending.resolve({...snapshot('Old content'), capturedAt: 500, revision: 'old', manual: true});
  await stopped.background.restore(); await settle();
  assert.equal(stopped.background.metadata().bonfire.running, false);
  assert.deepEqual(stopped.background.snapshot({kind: 'bonfire'}).snapshot.messages, []);
});

test('connecting, selecting rooms, recovering and advancing minutes never wake Being', async t => {
  const {background, clock, calls} = harness();
  t.after(() => background.stop());
  background.lifecycle({enabled: true});
  await settle();
  assert.equal(background.metadata().bonfire.reason, 'manual');
  background.snapshot({kind: 'fireside', firesideId: '7'});
  await clock.advance(600000);
  background.snapshot({kind: 'fireside', firesideId: '8'});
  background.lifecycle({enabled: false, reason: 'offline'});
  background.lifecycle({enabled: true});
  background.lifecycle({enabled: false, reason: 'suspended'});
  background.lifecycle({enabled: true});
  await clock.advance(600000);
  assert.equal(calls.length, 0);
  assert.equal(clock.pending(), 0);
  assert.equal(background.metadata().fireside.reason, 'manual');
  assert.equal(background.metadata().bonfire.nextRefreshAt, null);
  await background.refresh({kind: 'bonfire'});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'bonfire');
  assert.deepEqual(calls[0].value, {limit: 10});
  assert.ok(calls[0].signal instanceof AbortSignal);
  await clock.advance(600000);
  assert.equal(calls.length, 1);
  assert.equal(clock.pending(), 0);
  assert.equal(background.metadata().bonfire.reason, 'manual');
  assert.equal(background.metadata().bonfire.intervalMs, 60000);
});

test('one selected room shares in-flight reads and switching aborts only the previous room', async t => {
  const oldRoom = deferred();
  const {background, calls, updates, clock} = harness({read: call => call.value.firesideId === '7' ? oldRoom.promise : snapshot(call.kind === 'fireside' ? 'Room eight' : 'Bonfire')});
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await settle();
  await background.refresh({kind: 'bonfire'});
  background.snapshot({kind: 'fireside', firesideId: '7'});
  await settle();
  const first = background.refresh({kind: 'fireside', firesideId: '7'});
  const second = background.refresh({kind: 'fireside', firesideId: '7'});
  const rejected = Promise.all([assert.rejects(first, {code: 'SESSION_CHANGED'}), assert.rejects(second, {code: 'SESSION_CHANGED'})]);
  await clock.advance(60000);
  assert.equal(calls.filter(call => call.value.firesideId === '7').length, 1);
  const oldCall = calls.find(call => call.value.firesideId === '7');
  const updateCount = updates.length;
  background.snapshot({kind: 'fireside', firesideId: '8'}); await settle();
  await background.refresh({kind: 'fireside', firesideId: '8'});
  assert.equal(oldCall.signal.aborted, true);
  assert.equal(calls.filter(call => call.value.firesideId === '8').length, 1);
  oldRoom.resolve(snapshot('OLD PRIVATE ROOM')); await rejected; await settle();
  assert.ok(updates.slice(updateCount).every(update => update.firesideId !== '7'));
  assert.ok(!JSON.stringify(updates.slice(updateCount)).includes('OLD PRIVATE ROOM'));
  assert.equal(background.snapshot({kind: 'fireside', firesideId: '8'}).snapshot.messages[0].content, 'Room eight');
  assert.equal(background.metadata().bonfire.status, 'ready');
});

test('repeated snapshots of the current room stay local before and after a manual read', async t => {
  const {background, calls} = harness();
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await settle();
  background.snapshot({kind: 'fireside', firesideId: '7'}); await settle();
  for (let count = 0; count < 10; count++) background.snapshot({kind: 'fireside', firesideId: '7'});
  await settle();
  assert.equal(calls.length, 0);
  await background.refresh({kind: 'fireside', firesideId: '7'});
  for (let count = 0; count < 10; count++) background.snapshot({kind: 'fireside', firesideId: '7'});
  assert.equal(calls.length, 1);
  assert.equal(background.snapshot({kind: 'fireside', firesideId: '7'}).snapshot.messages.length, 1);
});

test('a room change after transport completion cannot relabel the new room as the old request', async t => {
  const gate = deferred();
  const {background} = harness({read: call => call.value.firesideId === '7' ? gate.promise : snapshot('Room eight')});
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await settle();
  background.snapshot({kind: 'fireside', firesideId: '7'}); await settle();
  const flight = background._room.refresh();
  await settle();
  // Resolve the reader and switch rooms before the outer IPC refresh resumes.
  const switched = flight.then(() => background.snapshot({kind: 'fireside', firesideId: '8'}));
  const requested = background.refresh({kind: 'fireside', firesideId: '7'});
  const rejected = assert.rejects(requested, {code: 'SESSION_CHANGED'});
  gate.resolve(snapshot('Room seven')); await switched; await rejected; await settle();
  await background.refresh({kind: 'fireside', firesideId: '8'});
  const current = background.snapshot({kind: 'fireside', firesideId: '8'});
  assert.equal(current.firesideId, '8');
  assert.equal(current.snapshot.messages[0].content, 'Room eight');
});

test('offline and sleep pauses retain stale data without reading on resume', async t => {
  const {background, calls, clock} = harness();
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await settle();
  background.snapshot({kind: 'fireside', firesideId: '7'}); await settle();
  await background.refresh({kind: 'bonfire'});
  await background.refresh({kind: 'fireside', firesideId: '7'});
  background.lifecycle({enabled: false, reason: 'offline'});
  assert.equal(background.metadata().bonfire.status, 'paused');
  assert.equal(background.metadata().fireside.status, 'paused');
  assert.equal(background.metadata().bonfire.stale, true);
  assert.equal(background.snapshot({kind: 'fireside', firesideId: '7'}).snapshot.messages.length, 1);
  await clock.advance(180000); assert.equal(calls.length, 2);
  await assert.rejects(background.refresh({kind: 'bonfire'}), {code: 'NOT_CONNECTED'});
  background.lifecycle({enabled: true}); await settle();
  assert.equal(calls.length, 2);
  background.lifecycle({enabled: true}); await settle(); assert.equal(calls.length, 2);
  background.lifecycle({enabled: false, reason: 'suspended'});
  assert.equal(background.metadata().bonfire.reason, 'suspended');
  await clock.advance(180000); assert.equal(calls.length, 2);
});

test('disconnect clears all cached messages and reconnect cannot expose the previous identity', async t => {
  const {background, setIdentity, calls, updates, clock} = harness({read: () => snapshot('PRIVATE ALICE MESSAGE')});
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await settle();
  background.snapshot({kind: 'fireside', firesideId: '7'}); await settle();
  await background.refresh({kind: 'bonfire'});
  await background.refresh({kind: 'fireside', firesideId: '7'});
  setIdentity(null); background.lifecycle({enabled: false});
  const disconnected = background.snapshot({kind: 'bonfire'});
  assert.equal(disconnected.snapshot.identity, null);
  assert.deepEqual(disconnected.snapshot.messages, []);
  assert.equal(background.metadata().fireside, null);
  const cut = updates.length;
  setIdentity({beingId: 'bob', connectionRevision: 2, identityRevision: 2});
  background.lifecycle({enabled: false});
  assert.deepEqual(background.snapshot({kind: 'bonfire'}).snapshot.messages, []);
  assert.ok(!JSON.stringify(updates.slice(cut)).includes('PRIVATE ALICE MESSAGE'));
  await clock.advance(120000); assert.equal(calls.length, 2);
  background.lifecycle({enabled: true}); await settle();
  assert.equal(calls.length, 2);
  await background.refresh({kind: 'bonfire'});
  assert.equal(calls.length, 3);
  assert.equal(background.snapshot({kind: 'bonfire'}).snapshot.identity.beingId, 'bob');
});

test('connection revision changes abort pending reads and clear the selected private room', async t => {
  const gate = deferred();
  const {background, setIdentity, calls, updates} = harness({read: call => call.value.firesideId === '7' ? gate.promise : snapshot('Bonfire')});
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await settle();
  background.snapshot({kind: 'fireside', firesideId: '7'}); await settle();
  const requested = background.refresh({kind: 'fireside', firesideId: '7'});
  const rejected = assert.rejects(requested, {code: 'SESSION_CHANGED'});
  await settle();
  const previous = calls.find(call => call.kind === 'fireside');
  const cut = updates.length;
  setIdentity({beingId: 'alice', connectionRevision: 2, identityRevision: 1});
  background.lifecycle({enabled: false});
  assert.equal(previous.signal.aborted, true);
  assert.equal(background.metadata().fireside, null);
  assert.deepEqual(background.snapshot({kind: 'bonfire'}).snapshot.messages, []);
  gate.resolve(snapshot('LATE PRIVATE MESSAGE')); await rejected; await settle();
  assert.ok(!JSON.stringify(updates.slice(cut)).includes('LATE PRIVATE MESSAGE'));
});

test('removal from the room list discards its cache without any further private reads', async t => {
  const {background, calls, clock} = harness();
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await settle();
  background.snapshot({kind: 'fireside', firesideId: '7'}); await settle();
  await background.refresh({kind: 'fireside', firesideId: '7'});
  background.reconcileRooms({owned: [{id: 7}], joined: []});
  assert.notEqual(background.metadata().fireside, null);
  background.reconcileRooms({owned: [], joined: [{id: 8}]});
  assert.equal(background.metadata().fireside, null);
  await clock.advance(180000);
  assert.equal(calls.filter(call => call.kind === 'fireside').length, 1);
});

test('diagnostic metadata omits messages and observer mutations cannot change cached data', async t => {
  const {background, statuses} = harness({read: () => ({...snapshot('PRIVATE MESSAGE'), token: 'PRIVATE_TOKEN'}), onUpdate: value => {
    value.snapshot.messages.splice(0); value.snapshot.identity = {beingId: 'attacker'};
  }});
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await settle();
  await background.refresh({kind: 'bonfire'});
  assert.ok(!JSON.stringify({metadata: background.metadata(), statuses}).includes('PRIVATE'));
  const result = background.snapshot({kind: 'bonfire'});
  assert.equal(result.snapshot.messages[0].content, 'PRIVATE MESSAGE');
  assert.equal(result.snapshot.identity.beingId, 'alice');
  assert.equal(result.snapshot.token, undefined);
});

test('authorization failures require manual retry using only the read transport', async t => {
  let allowed = false;
  const {background, calls, clock} = harness({read: () => {
    if (!allowed) { const error = new Error('REMOTE_PRIVATE_DETAIL'); error.code = 'AUTH_REQUIRED'; throw error; }
    return snapshot('Now authorized');
  }});
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await settle();
  await assert.rejects(background.refresh({kind: 'bonfire'}), {code: 'AUTH_REQUIRED'});
  assert.equal(background.metadata().bonfire.errorCode, 'AUTH_REQUIRED');
  assert.equal(background.metadata().bonfire.status, 'paused');
  await clock.advance(600000); assert.equal(calls.length, 1);
  allowed = true;
  const result = await background.refresh({kind: 'bonfire'});
  assert.equal(result.snapshot.messages[0].content, 'Now authorized');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.kind === 'bonfire'));
  assert.ok(!JSON.stringify(result).includes('REMOTE_PRIVATE_DETAIL'));
});

test('busy and transient failures never enqueue an automatic retry', async t => {
  for (const code of ['BUSY', 'NETWORK_ERROR', 'INCOMPLETE_RESULT', 'RESULT_SOURCE_UNAVAILABLE']) {
    const {background, calls, clock} = harness({read: () => { throw Object.assign(new Error('Remote failure'), {code}); }});
    t.after(() => background.stop());
    background.lifecycle({enabled: true});
    await assert.rejects(background.refresh({kind: 'bonfire'}), error => error.code === code && !error.message.includes('自动重试'));
    await clock.advance(1800000);
    background.lifecycle({enabled: false});
    background.lifecycle({enabled: true});
    await clock.advance(1800000);
    assert.equal(calls.length, 1);
    assert.equal(clock.pending(), 0);
    assert.equal(background.metadata().bonfire.reason, 'manual');
    assert.equal(background.metadata().bonfire.nextRefreshAt, null);
  }
});

test('malformed read selectors reject getters and extra keys without starting requests', async t => {
  const {background, calls} = harness();
  t.after(() => background.stop());
  let invoked = false;
  const values = [
    {get kind() { invoked = true; return 'bonfire'; }},
    {kind: 'bonfire', signal: {}},
    {kind: 'fireside', firesideId: 'not-a-number'},
    {kind: 'fireside', firesideId: '07'},
    {kind: 'fireside', firesideId: '9007199254740992'},
    {kind: 'fireside', firesideId: '7', extra: true},
    Object.assign(Object.create({kind: 'bonfire'}), {}),
  ];
  for (const value of values) assert.throws(() => background.snapshot(value), {code: 'INVALID_REQUEST'});
  assert.equal(invoked, false);
  assert.equal(calls.length, 0);
});

test('stop and restart preserve selected room metadata without starting reads', async t => {
  const {background, calls, clock} = harness();
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await settle();
  background.snapshot({kind: 'fireside', firesideId: '7'}); await settle();
  background.stop();
  assert.equal(clock.pending(), 0);
  await clock.advance(300000); assert.equal(calls.length, 0);
  background.lifecycle({enabled: true}); await settle();
  assert.equal(calls.length, 0);
  assert.equal(background.snapshot({kind: 'fireside', firesideId: '7'}).status.reason, 'manual');
  await background.refresh({kind: 'fireside', firesideId: '7'});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].value.firesideId, '7');
  await clock.advance(300000);
  assert.equal(calls.length, 1);
});

test('SBS polling, navigation and refresh only read cached results over multiple minutes', async t => {
  const cachedCalls = [];
  const {background, calls, clock} = harness({readCachedSnapshot: async value => {
    cachedCalls.push(value);
    return {...snapshot(`Cached ${value.kind}`), capturedAt: 500, revision: `${value.kind}:${value.firesideId}:1`};
  }});
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await settle();
  background.snapshot({kind: 'fireside', firesideId: '7'}); await settle();
  await clock.advance(3 * 60000);
  assert.equal(cachedCalls.length, 8);
  assert.equal(calls.length, 0);
  assert.ok(cachedCalls.every(value => value.limit === 10 && value.signal instanceof AbortSignal));
  await background.refresh({kind: 'bonfire'});
  assert.equal(cachedCalls.length, 9);
  background.snapshot({kind: 'fireside', firesideId: '8'}); await settle();
  background.lifecycle({enabled: false, reason: 'offline'});
  await clock.advance(120000);
  background.lifecycle({enabled: true}); await settle();
  await clock.advance(120000);
  assert.equal(calls.length, 0);
  assert.equal(background.metadata().bonfire.reason, 'sbs');
  assert.equal(background.metadata().bonfire.lastSuccessAt, 500);
  assert.equal(background.metadata().bonfire.lastCheckedAt, clock.now());
});

test('explicit reads supersede a pending cache read and cannot be overwritten by old cache', async t => {
  const cacheGate = deferred(), manualGate = deferred();
  const cachedCalls = [];
  const {background, calls, clock} = harness({read: () => manualGate.promise, readCachedSnapshot: async value => {
    cachedCalls.push(value);
    return cachedCalls.length === 1 ? cacheGate.promise : {...snapshot('OLD CACHE'), capturedAt: 500, revision: 'cache:old'};
  }});
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await settle();
  const first = background.requestRead({kind: 'bonfire'});
  const second = background.requestRead({kind: 'bonfire'});
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(cachedCalls[0].signal.aborted, true);
  manualGate.resolve(snapshot('EXPLICIT RESULT', 2));
  await Promise.all([first, second]);
  cacheGate.resolve({...snapshot('LATE CACHE'), capturedAt: 500, revision: 'cache:late'}); await settle();
  assert.equal(background.snapshot({kind: 'bonfire'}).snapshot.messages[0].content, 'EXPLICIT RESULT');
  assert.equal(background.metadata().bonfire.reason, 'manual');
  const capturedAt = background.metadata().bonfire.lastSuccessAt;
  await clock.advance(120000);
  assert.equal(calls.length, 1);
  assert.equal(cachedCalls.length, 3);
  assert.equal(background.metadata().bonfire.lastSuccessAt, capturedAt);
  assert.equal(background.snapshot({kind: 'bonfire'}).snapshot.messages[0].content, 'EXPLICIT RESULT');
});

test('missing or failed cached results never fall back to a Being chat request', async t => {
  for (const code of ['WAITING_SBS', 'SBS_NOT_CONFIGURED', 'NETWORK_ERROR', 'INCOMPLETE_RESULT', 'RESULT_SOURCE_UNAVAILABLE']) {
    let checks = 0;
    const {background, calls, clock} = harness({readCachedSnapshot: () => { checks++; throw Object.assign(new Error('Private cache detail'), {code}); }});
    t.after(() => background.stop());
    background.lifecycle({enabled: true}); await settle();
    await clock.advance(5 * 60000);
    await assert.rejects(background.refresh({kind: 'bonfire'}), {code});
    assert.equal(calls.length, 0);
    assert.ok(checks > 1);
    assert.ok(!JSON.stringify(background.metadata()).includes('Private'));
    if (['WAITING_SBS', 'SBS_NOT_CONFIGURED'].includes(code)) {
      assert.equal(background.metadata().bonfire.reason, code === 'WAITING_SBS' ? 'waiting_sbs' : 'sbs_not_configured');
      assert.equal(background.metadata().bonfire.failureCount, 0);
      assert.equal(background.metadata().bonfire.lastSuccessAt, null);
      assert.equal(background.metadata().bonfire.lastCheckedAt, clock.now());
      assert.deepEqual(background.snapshot({kind: 'bonfire'}).snapshot.messages, []);
    }
  }
});

test('late cached and explicit private reads cannot cross room or identity changes', async t => {
  const cacheGate = deferred(), manualGate = deferred();
  const cachedCalls = [];
  const {background, calls, setIdentity, updates} = harness({read: () => manualGate.promise, readCachedSnapshot: value => {
    cachedCalls.push(value);
    return value.firesideId === '7' ? cacheGate.promise : {...snapshot('Current cache'), capturedAt: 500, revision: 'cache:current'};
  }});
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await settle();
  background.snapshot({kind: 'fireside', firesideId: '7'}); await settle();
  const requested = background.requestRead({kind: 'fireside', firesideId: '7'});
  const rejected = assert.rejects(requested, {code: 'SESSION_CHANGED'});
  await settle();
  background.snapshot({kind: 'fireside', firesideId: '8'}); await settle();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(cachedCalls.find(value => value.firesideId === '7').signal.aborted, true);
  const cut = updates.length;
  setIdentity({beingId: 'bob', connectionRevision: 2, identityRevision: 2});
  background.lifecycle({enabled: true}); await settle();
  manualGate.resolve(snapshot('LATE PRIVATE MANUAL'));
  cacheGate.resolve({...snapshot('LATE PRIVATE CACHE'), capturedAt: 900, revision: 'old:private'});
  await rejected; await settle();
  assert.ok(!JSON.stringify(updates.slice(cut)).includes('LATE PRIVATE'));
  assert.equal(background.snapshot({kind: 'bonfire'}).snapshot.identity.beingId, 'bob');
  assert.equal(background.metadata().fireside, null);
});

test('an accepted explicit read is never replayed while cache polling continues', async t => {
  let checks = 0;
  const {background, calls, clock} = harness({read: () => { throw Object.assign(new Error('Accepted'), {code: 'REQUEST_ACCEPTED'}); }, readCachedSnapshot: () => {
    checks++; throw Object.assign(new Error('Not captured yet'), {code: 'WAITING_SBS'});
  }});
  t.after(() => background.stop());
  background.lifecycle({enabled: true}); await settle();
  await assert.rejects(background.requestRead({kind: 'bonfire'}), {code: 'REQUEST_ACCEPTED'});
  assert.equal(background.metadata().bonfire.reason, 'being_pending');
  assert.equal(background.metadata().bonfire.failureCount, 0);
  await clock.advance(5 * 60000);
  assert.equal(calls.length, 1);
  assert.equal(checks, 6);
  assert.equal(background.metadata().bonfire.reason, 'waiting_sbs');
  assert.equal(background.metadata().bonfire.failureCount, 0);
});
