'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {TownClient} = require('../src/town-client.cjs');
const {TownSession} = require('../src/town-session.cjs');
const {beingsDto, scrollListDto} = require('../src/town-library-contract.cjs');
const token = 'a'.repeat(64), townId = 't_alice', otherId = 't_bob';
const json = value => new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}});
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({pinned = '', identity = {town_id: townId, mentions: []}, hello = {town_id: townId, anonymous: false, token_kind: 'client'}, respond} = {}) {
  let context = {key: 'loom-alice', beingId: 'alice', revision: 1, connected: true};
  const calls = [], pins = [], events = [];
  const saved = {token, townId: pinned};
  const store = {loadCredential: async () => ({...saved}), bindTownId: async (key, beingId, credential, id, current) => {
    assert.equal(current(), true); assert.equal(key, context.key); assert.equal(beingId, context.beingId); assert.equal(credential === token, true);
    pins.push(id); saved.townId = id;
  }};
  const client = new TownClient({getContext: () => context, store, onEvent: event => events.push(event), fetchImpl: async (url, options) => {
    const route = new URL(url).pathname; calls.push({route, method: options.method || 'GET'});
    assert.equal(options.headers.Authorization === `Bearer ${token}`, true); assert.equal(new URL(url).searchParams.has('token'), false);
    if (route === '/api/bonfire/mentions') return json(typeof identity === 'function' ? await identity() : identity);
    if (route === '/api/client/stream') return new Response(new ReadableStream({start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: hello\ndata: ${JSON.stringify(hello)}\n\nevent: bonfire\ndata: {"message":"not a trusted snapshot"}\n\n`));
      options.signal.addEventListener('abort', () => {try {controller.close();} catch {}});
    }}), {headers: {'Content-Type': 'text/event-stream'}});
    return json(respond ? respond(route, options) : {ok: true, town_id: townId, global_latest_seq: 1, messages: []});
  }});
  const session = new TownSession({getContext: () => ({configured: true, connected: true, beingName: context.beingId, connectionId: context.revision}),
    readImpl: (...args) => client.read(...args), fetchImpl: async () => json({community: [{town_id: otherId, display_name: 'Bob'}]})});
  return {client, session, calls, pins, events, saved, store, switch() {context = {...context, key: 'loom-bob', beingId: 'bob', revision: 2}; client.reset();}};
}
test('existing paired credential resolves a different Town namespace only after REST and SSE agree', async t => {
  const f = fixture(); t.after(() => f.client.reset());
  await f.client.read('/api/bonfire/hear');
  assert.deepEqual(f.pins, [townId]); assert.equal(f.saved.token === token, true);
  assert.deepEqual(f.calls.map(call => call.route), ['/api/bonfire/mentions', '/api/client/stream', '/api/bonfire/hear']);
  assert.equal(f.client.state().beingId, 'alice'); assert.equal(JSON.stringify(f.client.state()).includes(token), false);
  f.client.reset(); await f.client.read('/api/bonfire/hear');
  assert.equal(f.pins.length, 1); assert.equal(f.calls.filter(call => call.route.endsWith('/stream')).length, 1);
});
test('SSE migration waits for REST verification before delivering the following events', async t => {
  let resolve;
  const f = fixture({identity: () => new Promise(done => {resolve = done;})}); t.after(() => f.client.reset());
  f.client.lifecycle({enabled: true}); await tick();
  assert.equal(f.client.state().status, 'connecting'); assert.deepEqual(f.events, []);
  resolve({town_id: townId, mentions: []}); await tick();
  assert.equal(f.client.state().status, 'connected'); assert.deepEqual(f.events, [{type: 'hello'}, {type: 'bonfire'}]);
  assert.deepEqual(f.pins, [townId]);
});
test('disagreeing REST and SSE identities never pin, read protected history, or send', async t => {
  const f = fixture({hello: {town_id: otherId, anonymous: false, token_kind: 'client'}}); t.after(() => f.client.reset());
  await assert.rejects(f.client.speak({kind: 'bonfire', message: 'fixture only'}), {code: 'IDENTITY_MISMATCH'});
  assert.deepEqual(f.pins, []); assert.equal(f.calls.some(call => call.method === 'POST' || call.route.endsWith('/hear')), false);
});
test('a new SSE identity cannot be accepted against an unrelated legacy REST format', async t => {
  const f = fixture({identity: {being: 'alice', mentions: []}}); t.after(() => f.client.reset());
  f.client.lifecycle({enabled: true}); await tick();
  assert.equal(f.client.state().status, 'identity_mismatch'); assert.deepEqual(f.pins, []); assert.deepEqual(f.events, []);
});
test('a persisted Town identity cannot be replaced by a later credential response', async t => {
  const f = fixture({pinned: townId, identity: {town_id: otherId, mentions: []}, hello: {town_id: otherId, anonymous: false, token_kind: 'client'}}); t.after(() => f.client.reset());
  await assert.rejects(f.client.read('/api/bonfire/hear'), {code: 'IDENTITY_MISMATCH'});
  f.client.lifecycle({enabled: true}); await tick();
  assert.equal(f.client.state().status, 'identity_mismatch'); assert.deepEqual(f.events, []); assert.deepEqual(f.pins, []);
});
test('missing identity is a protocol error, while conflicting legacy identity still blocks migration', async t => {
  for (const [identity, code] of [[{mentions: []}, 'INVALID_RESPONSE'], [{town_id: townId, being: 'mallory', mentions: []}, 'IDENTITY_MISMATCH'], [{town_id: null, being: 'alice', mentions: []}, 'INVALID_RESPONSE']]) {
    const f = fixture({identity}); t.after(() => f.client.reset());
    await assert.rejects(f.client.read('/api/bonfire/hear'), {code}); assert.deepEqual(f.pins, []); assert.equal(f.calls.length, 1);
  }
});
test('Being switch during migration cannot bind or publish an old response', async t => {
  let resolve;
  const f = fixture({identity: () => new Promise(done => {resolve = done;})}); t.after(() => f.client.reset());
  const pending = f.client.read('/api/bonfire/hear'); await tick(); f.switch(); resolve({town_id: townId, mentions: []});
  await assert.rejects(pending, {code: 'SESSION_CHANGED'}); assert.deepEqual(f.pins, []); assert.deepEqual(f.events, []);
});
test('storage failure preserves pairing and blocks migration without fetching history', async t => {
  const f = fixture(); t.after(() => f.client.reset()); f.store.bindTownId = async () => {throw new Error('private storage diagnostic');};
  await assert.rejects(f.client.read('/api/bonfire/hear'), {code: 'STORAGE_ERROR'});
  assert.equal(f.saved.townId, ''); assert.equal(f.saved.token === token, true); assert.equal(f.calls.some(call => call.route.endsWith('/hear')), false);
});
test('Town message, reply, member, and inbox identities survive the full DTO pipeline', async t => {
  const f = fixture({pinned: townId, respond: route => {
    if (route === '/api/fireside/members') return [{town_id: otherId, display_name: 'Bob', key: 'hidden'}];
    if (route === '/api/messages') return {messages: [{id: 'dm1', sender_town_id: otherId, sender_display: 'Bob', recipient_town_id: townId, content: 'private fixture', reply_to: 'dm0', reply_to_sender: townId, reply_to_preview: 'earlier'}]};
    const messages = [{seq: 1, town_id: otherId, speaker_name: 'Bob', message: 'fixture', reply_to: 0, reply_to_town_id: townId, reply_to_preview: 'original'}];
    return {ok: true, town_id: townId, messages, global_latest_seq: 1, latest_seq: 1};
  }}); t.after(() => f.client.reset());
  for (const result of [await f.session.getBonfireMessages(), await f.session.getFiresideMessages({firesideId: 7})]) {
    assert.equal(result.messages.length, 1); assert.equal(result.messages[0].beingId, otherId); assert.equal(result.messages[0].beingName, 'Bob'); assert.equal(result.messages[0].replyTo.beingId, townId);
  }
  const members = await f.session.getFiresideMembers(7); assert.equal(members.members[0].being_id, otherId); assert.equal(JSON.stringify(members).includes('hidden'), false);
  const inbox = await f.session.getDirectMessages(); assert.equal(inbox.messages[0].senderId, otherId); assert.equal(inbox.messages[0].senderName, 'Bob');
  assert.equal((await f.session.getMembers()).members[0].id, otherId); assert.equal((await f.session.listBeings()).beings[0].id, otherId);
});
test('modern read envelopes cannot normalize away an authenticated identity mismatch', async t => {
  const f = fixture({pinned: townId, respond: () => ({town_id: otherId, ok: true, messages: [], global_latest_seq: 0})}); t.after(() => f.client.reset());
  await assert.rejects(f.session.getBonfireMessages(), {code: 'IDENTITY_MISMATCH'});
});
test('modern send receipts keep unknown results distinct and never repeat a POST', async t => {
  let receiptId = townId;
  const f = fixture({pinned: townId, respond: () => ({ok: true, town_id: receiptId, seq: 1, mentions: [], via: 'client:fixture'})}); t.after(() => f.client.reset());
  assert.equal((await f.client.speak({kind: 'bonfire', message: 'fixture'})).ok, true);
  receiptId = otherId;
  await assert.rejects(f.client.speak({kind: 'bonfire', message: 'second fixture'}), {code: 'RESULT_UNKNOWN'});
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 2);
  await assert.rejects(f.client.sendDirectMessage({recipient: townId, content: 'fixture'}), {code: 'NOT_SENT'});
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 2);
});
test('public directories and scrolls use Town identities without leaking private fields', () => {
  assert.equal(beingsDto([{town_id: otherId, display_name: 'Bob'}])[0].id, otherId);
  assert.throws(() => beingsDto([{town_id: null, being_id: 'bob', display_name: 'Bob'}]), {code: 'INVALID_RESPONSE'});
  const value = scrollListDto({scrolls: [{id: 'note1', title: 'Fixture', town_id: otherId, display_name: 'Bob', visibility: 'private', revision: 1, share_token: 'private'}], total: 1, offset: 0, limit: 1}, {limit: 1});
  assert.equal(value.scrolls[0].beingId, otherId); assert.equal(Object.hasOwn(value.scrolls[0], 'share_token'), false);
});
