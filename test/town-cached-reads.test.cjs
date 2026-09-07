'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {TownCachedReads} = require('../src/town-cached-reads.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function harness() {
  const data = new Map();
  let context = {identityKey: 'alice-session', revision: 1, identityRevision: 1, connected: true};
  const cache = {
    async load(identity, resource) { return structuredClone(data.get(JSON.stringify([identity, resource])) || {cached: false, data: null, lastSuccessAt: null}); },
    async save(identity, resource, value) { data.set(JSON.stringify([identity, resource]), {cached: true, data: structuredClone(value), lastSuccessAt: 1000}); return true; },
  };
  const reads = new TownCachedReads({cache, getContext: () => context});
  return {reads, cache, data, setContext(value) { context = {...context, ...value}; }};
}

test('private pages and visibility filters use canonical distinct cache keys', async () => {
  const {reads} = harness();
  await reads.read('listScrolls', {limit: 50, offset: 0}, async value => ({scrolls: [{id: 'first'}], query: value}));
  const first = await reads.snapshot({method: 'listScrolls'});
  assert.equal(first.cached, true);
  assert.equal(first.data.scrolls[0].id, 'first');
  assert.deepEqual(first.data.query, {offset: 0, limit: 50});
  for (const value of [{offset: 1}, {limit: 100}, {visibility: 'shared'}]) assert.equal((await reads.snapshot({method: 'listScrolls', value})).cached, false);
  await reads.read('getScroll', {id: 'first', offset: 10000}, async () => ({scroll: {id: 'first', content: 'Continuation'}}));
  assert.equal((await reads.snapshot({method: 'getScroll', value: {id: 'first'}})).cached, false);
  assert.equal((await reads.snapshot({method: 'getScroll', value: {id: 'first', offset: 10000, limit: 10000}})).data.scroll.content, 'Continuation');
  await reads.read('getFiresideMembers', '7', async () => ({members: [{id: 'alice'}]}));
  assert.equal((await reads.snapshot({method: 'getFiresideMembers', value: '8'})).cached, false);
});

test('new sessions cannot restore private data but reconnect to the same account can', async () => {
  const {reads, setContext} = harness();
  await reads.read('getFiresides', undefined, async () => ({owned: [{id: '7'}], joined: []}));
  setContext({revision: 2});
  assert.equal((await reads.snapshot({method: 'getFiresides'})).cached, true);
  setContext({identityKey: 'bob-session', revision: 3, identityRevision: 2});
  assert.equal((await reads.snapshot({method: 'getFiresides'})).cached, false);
  setContext({identityKey: 'alice-session', connected: false});
  assert.equal((await reads.snapshot({method: 'getFiresides'})).cached, false);
  await assert.rejects(reads.read('getFiresides', undefined, () => assert.fail('Disconnected private reader')), {code: 'NOT_CONNECTED'});
});

test('public directories and Grove catalog remain cached when disconnected or changing Being', async () => {
  const {reads, setContext} = harness();
  for (const [method, value, data] of [
    ['listBeings', {}, {beings: [{id: 'alice'}]}], ['getBeingMembers', undefined, {members: [{id: 'alice'}]}],
    ['getGroveCatalog', {limit: 100}, {kits: [{id: 'kit'}]}], ['getGroveDetail', 'kit', {id: 'kit', name: 'Kit'}],
  ]) await reads.read(method, value, async () => data);
  setContext({identityKey: '', connected: false, revision: 2});
  assert.equal((await reads.snapshot({method: 'listBeings'})).data.beings[0].id, 'alice');
  assert.equal((await reads.snapshot({method: 'getBeingMembers'})).data.members[0].id, 'alice');
  assert.equal((await reads.snapshot({method: 'getGroveCatalog', value: {offset: 0, limit: 100}})).data.kits[0].id, 'kit');
  assert.equal((await reads.snapshot({method: 'getGroveDetail', value: 'kit'})).data.id, 'kit');
});

test('cache reads cannot invoke writes or accept arbitrary methods, getters or malformed selectors', async () => {
  const {reads, data} = harness();
  for (const value of [null, {}, {method: 'sendBonfireMessage'}, {method: 'getState'}, {method: 'getScroll', value: {id: '../secret'}},
    {method: 'listScrolls', value: {offset: -1}}, {method: 'getGroveCatalog', value: {limit: 101}},
    {method: 'getFiresideMembers', value: '01'}, {method: 'listBeings', value: {token: 'secret'}},
    {method: 'listBeings', arbitrary: true}, {get method() { assert.fail('Getter must not execute'); }}]) {
    await assert.rejects(reads.snapshot(value), {code: 'INVALID_REQUEST'});
  }
  assert.equal(data.size, 0);
});

test('failed live requests retain cached data and authoritative empty results replace it', async () => {
  const {reads} = harness();
  await reads.read('listScrolls', {}, async () => ({scrolls: [{id: 'old'}]}));
  await assert.rejects(reads.read('listScrolls', {}, async () => { throw new Error('Offline'); }), /Offline/);
  assert.equal((await reads.snapshot({method: 'listScrolls'})).data.scrolls[0].id, 'old');
  await reads.read('listScrolls', {}, async () => ({scrolls: []}));
  assert.deepEqual((await reads.snapshot({method: 'listScrolls'})).data.scrolls, []);
});

test('late private reads and disk loads are rejected across identity changes', async () => {
  const {reads, cache, data, setContext} = harness();
  const live = deferred();
  const request = reads.read('listScrolls', {}, () => live.promise);
  setContext({identityKey: 'bob-session', revision: 2, identityRevision: 2});
  live.resolve({scrolls: [{id: 'alice-private'}]});
  await assert.rejects(request, {code: 'SESSION_CHANGED'});
  assert.equal(data.size, 0);
  const disk = deferred();
  cache.load = () => disk.promise;
  const snapshot = reads.snapshot({method: 'getFiresides'});
  setContext({identityKey: 'carol-session', revision: 3, identityRevision: 3});
  disk.resolve({cached: true, data: {owned: [{id: 'bob-private'}]}});
  await assert.rejects(snapshot, {code: 'SESSION_CHANGED'});
});

test('an older overlapping live read cannot overwrite a newer saved response', async () => {
  const {reads} = harness();
  const old = deferred();
  const pending = reads.read('getGroveCatalog', {}, () => old.promise);
  await reads.read('getGroveCatalog', {}, async () => ({kits: [{id: 'new'}]}));
  old.resolve({kits: [{id: 'old'}]}); await pending;
  assert.equal((await reads.snapshot({method: 'getGroveCatalog'})).data.kits[0].id, 'new');
});

test('persistence failures do not reject a validated live result', async () => {
  const {reads, cache} = harness();
  for (const save of [() => { throw new Error('Unavailable'); }, async () => { throw new Error('Disk full'); }, async () => false]) {
    cache.save = save;
    assert.deepEqual(await reads.read('listBeings', {}, async () => ({beings: []})), {beings: []});
  }
});
