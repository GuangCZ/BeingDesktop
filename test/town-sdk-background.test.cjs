'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {TownBackground} = require('../src/town-background.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));
const identity = {beingId: 'alice', connectionRevision: 1, identityRevision: 1};
const snapshot = n => ({messages: [{id: String(n), content: 'message ' + n, beingId: 'alice'}], latestSeq: n});
test('SDK background starts without SBS; an event during REST triggers a second authoritative read', async t => {
  let calls = 0, resolve;
  const feed = new TownBackground({direct: true, getIdentity: () => identity, townSession: {getBonfireMessages: async () => {calls++; if (calls === 2) return new Promise(r => {resolve = r;}); return snapshot(calls);}}});
  t.after(() => feed.stop()); feed.lifecycle({enabled: true}); await delay(10); assert.equal(calls, 1);
  feed.notifyEvent({type: 'bonfire'}); await delay(280); assert.equal(calls, 2);
  feed.notifyEvent({type: 'bonfire'}); resolve(snapshot(2)); await delay(10);
  assert.equal(calls, 3); assert.equal((await feed.cachedSnapshot({kind: 'bonfire'})).snapshot.latestSeq, 3);
});
test('SSE reconciliation after resume does not publish a response from the prior identity', async t => {
  let current = identity, calls = 0;
  const feed = new TownBackground({direct: true, getIdentity: () => current, townSession: {getBonfireMessages: async () => snapshot(++calls)}});
  t.after(() => feed.stop()); feed.lifecycle({enabled: true}); await delay(10); feed.notifyEvent({type: 'hello'});
  current = {...identity, beingId: 'bob', identityRevision: 2}; feed.lifecycle({enabled: true}); await delay(280);
  const data = await feed.cachedSnapshot({kind: 'bonfire'}); assert.equal(data.snapshot.identity.beingId, 'bob'); assert.equal(calls, 2);
});
