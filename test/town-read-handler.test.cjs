'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const handlerSource = mainSource.match(/handle\('requestTownRead',([\s\S]*?)\);\r?\n\s*handle\('sendBonfireMessage'/)?.[1];
assert.ok(handlerSource, 'Production Town read handler must be available');

function harness() {
  const calls = [];
  const rooms = {owned: [{id: 1, name: 'Room one'}], joined: []};
  const townSession = {
    async getFiresides() { calls.push({method: 'rooms'}); return rooms; },
    async getFiresideMembers(firesideId) { calls.push({method: 'members', firesideId}); return {members: []}; },
  };
  const townBackground = {
    async requestRead(value) { calls.push({method: 'read', value}); return {kind: value.kind, firesideId: value.firesideId, snapshot: {messages: []}, status: {status: 'ready'}}; },
    reconcileRooms(value) { calls.push({method: 'reconcile', value}); },
  };
  const handler = new Function('townSession', 'townBackground', 'townCachedReads', `
    const generation = 1, identityRevision = 1;
    let townRoomCache = {owned: [], joined: []};
    const townMemberCache = new Map();
    return (${handlerSource});
  `)(townSession, townBackground, {read: (_method, value, read) => read(value)});
  return {handler, calls, rooms};
}

test('Fireside selection revisions stay out of the actual Town read selector', async () => {
  for (const selectionRevision of [undefined, 0, 3, Number.MAX_SAFE_INTEGER]) {
    const {handler, calls} = harness();
    const value = {kind: 'fireside', firesideId: '1', ...(selectionRevision === undefined ? {} : {selectionRevision})};
    const result = await handler(value);
    assert.deepEqual(calls, [{method: 'read', value: {kind: 'fireside', firesideId: '1'}}, {method: 'members', firesideId: '1'}]);
    assert.equal(result.status.status, 'ready');
    assert.equal(value.selectionRevision, selectionRevision);
  }
});

test('Fireside directory requests accept the selection revision without requesting room messages', async () => {
  const {handler, calls, rooms} = harness();
  const result = await handler({kind: 'fireside', selectionRevision: 0});
  assert.deepEqual(calls, [{method: 'rooms'}, {method: 'reconcile', value: rooms}]);
  assert.deepEqual(result.rooms.owned, rooms.owned);
  assert.equal(result.rooms.cached, true);
});

test('opening a cached Fireside refreshes the directory before reading its messages', async () => {
  const {handler, calls, rooms} = harness();
  const result = await handler({kind: 'fireside', firesideId: '1', selectionRevision: 0, includeRooms: true});
  assert.deepEqual(calls, [{method: 'rooms'}, {method: 'reconcile', value: rooms}, {method: 'read', value: {kind: 'fireside', firesideId: '1'}}, {method: 'members', firesideId: '1'}]);
  assert.equal(result.status.status, 'ready');
});

test('a room removed from the refreshed directory does not read its messages or members', async () => {
  const {handler, calls, rooms} = harness();
  const result = await handler({kind: 'fireside', firesideId: '2', includeRooms: true});
  assert.deepEqual(calls, [{method: 'rooms'}, {method: 'reconcile', value: rooms}]);
  assert.equal(result.removed, true);
  assert.deepEqual(result.rooms.owned, rooms.owned);
});

test('only Fireside requests accept an explicit boolean directory refresh flag', async () => {
  const {handler, calls} = harness();
  for (const includeRooms of [undefined, null, 1, 'true', {}]) await assert.rejects(handler({kind: 'fireside', firesideId: '1', includeRooms}), {code: 'INVALID_REQUEST'});
  await assert.rejects(handler({kind: 'bonfire', includeRooms: true}), {code: 'INVALID_REQUEST'});
  assert.equal(calls.length, 0);
});

test('invalid selection revisions reject before any Town read', async () => {
  const {handler, calls} = harness();
  for (const selectionRevision of [undefined, null, -1, 0.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(handler({kind: 'fireside', firesideId: '1', selectionRevision}), {code: 'INVALID_REQUEST'});
  }
  await assert.rejects(handler({kind: 'bonfire', selectionRevision: 0}), {code: 'INVALID_REQUEST'});
  assert.deepEqual(calls, []);
});
