'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const helpers = source.slice(source.indexOf('  async function loadCachedFiresides()'), source.indexOf('  async function loadFeatureHistory()'));

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return {promise, resolve};
}

function harness(snapshot) {
  return new Function('townCachedReads', `
    let generation=1, identityRevision=1;
    let townRoomCache={owned:[],joined:[],cached:false};
    const townMemberCache=new Map();
    const reconciled=[];
    const townBackground={reconcileRooms:value=>reconciled.push(value)};
    ${helpers}
    return {rooms:loadCachedFiresides,members:loadCachedFiresideMembers,reconciled,
      setRooms:value=>{townRoomCache=value;},setMembers:(id,value)=>townMemberCache.set(id,value),
      switchIdentity:()=>{generation++;identityRevision++;townRoomCache={owned:[],joined:[],cached:false};townMemberCache.clear();},
      getMembers:id=>townMemberCache.get(id)};
  `)({snapshot});
}

const rooms = {owned: [{id: '7', name: 'Saved room'}], joined: []};
const savedRooms = {cached: true, data: rooms, lastSuccessAt: 1000};

test('a cold room list restores locally and reconciles memberships before a room is selected', async () => {
  const app = harness(async request => { assert.equal(request.method, 'getFiresides'); return savedRooms; });
  assert.deepEqual(await app.rooms(), {...rooms, cached: true, lastSuccessAt: 1000});
  assert.deepEqual(app.reconciled, [rooms]);
  const copy = await app.rooms(); copy.owned.length = 0;
  assert.equal((await app.rooms()).owned.length, 1);
});

test('new live room data wins over an older disk read', async () => {
  const gate = deferred();
  const app = harness(() => gate.promise);
  const pending = app.rooms();
  const fresh = {owned: [{id: '8'}], joined: [], cached: true, lastSuccessAt: 2000};
  app.setRooms(fresh); gate.resolve(savedRooms);
  assert.deepEqual(await pending, fresh);
  assert.deepEqual(app.reconciled, []);
});

test('room members restore separately and removed rooms do not restore old members', async () => {
  const requests = [];
  const app = harness(async request => { requests.push(request); return request.method === 'getFiresides' ? savedRooms : {cached: true, data: {members: [{id: 'alice'}]}, lastSuccessAt: 1100}; });
  assert.equal((await app.members('7')).members[0].id, 'alice');
  assert.deepEqual(await app.members('8'), {members: [], cached: false});
  assert.equal(requests.filter(request => request.method === 'getFiresideMembers').length, 1);
});

test('an identity switch between a validated disk result and the helper continuation cannot restore old members', async () => {
  const gate = deferred();
  const app = harness(request => request.method === 'getFiresides' ? Promise.resolve(savedRooms) : gate.promise);
  await app.rooms();
  const pending = app.members('7');
  await Promise.resolve();
  // Simulate a result which has already passed the cache coordinator check.
  app.switchIdentity();
  gate.resolve({cached: true, data: {members: [{id: 'old-private'}]}, lastSuccessAt: 1000});
  await assert.rejects(pending, {code: 'SESSION_CHANGED'});
  assert.equal(app.getMembers('7'), undefined);
});

test('identity switches during room restoration also reject a member load', async () => {
  const gate = deferred();
  const app = harness(() => gate.promise);
  const pending = app.members('7');
  app.switchIdentity(); gate.resolve(savedRooms);
  await assert.rejects(pending, {code: 'SESSION_CHANGED'});
  assert.equal(app.getMembers('7'), undefined);
});
