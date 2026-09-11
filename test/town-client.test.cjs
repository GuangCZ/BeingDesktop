'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {TownClient, consumeEvents} = require('../src/town-client.cjs');
const {TownSession} = require('../src/town-session.cjs');
const token = 'a'.repeat(64);
const json = (v, status = 200) => new Response(JSON.stringify(v), {status, headers: {'Content-Type': 'application/json'}});
const bonfire = {ok: true, messages: [{seq: 1, being: 'alice', message: '原文', at: '2026-09-10T00:00:00Z'}], global_latest_seq: 1};
const tick = () => new Promise(r => setImmediate(r));
function fixture(fetchImpl) {
  let context = {key: 'account-a', beingId: 'alice', revision: 1, connected: true};
  const calls = [], saved = [], events = [];
  let stream;
  const store = {load: async () => token, save: async (...v) => saved.push(v), remove: async () => {}};
  const client = new TownClient({getContext: () => context, store, retryMs: 10,
    onEvent: e => events.push(e), fetchImpl: async (url, options) => {
      calls.push({url: new URL(url), options});
      if (fetchImpl) return fetchImpl(url, options);
      if (new URL(url).pathname === '/api/client/stream') return new Response(new ReadableStream({start(c) { stream = c; options.signal.addEventListener('abort', () => { try { c.close(); } catch {} }); }}), {headers: {'Content-Type': 'text/event-stream'}});
      if (new URL(url).pathname === '/api/bonfire/mentions') return json({being: 'alice', mentions: []});
      return json(bonfire);
    }});
  return {client, calls, saved, events, store, switch: () => {context = {...context, beingId: 'bob', key: 'account-b', revision: 2}; client.reset();},
    end: () => stream.close(),
    push: (type, data) => stream.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`))};
}
test('SDK direct reads use only Town client bearer auth, verify identity, preserve full text', async () => {
  const f = fixture();
  const session = new TownSession({getContext: () => ({configured: true, connected: true, beingName: 'alice', connectionId: 1}), readImpl: (...args) => f.client.read(...args), fetchImpl: async () => json({community: []})});
  const result = await session.getBonfireMessages({limit: 10});
  assert.equal(result.messages[0].content, '原文'); assert.equal(f.calls.length, 2);
  for (const {url, options} of f.calls) {
    assert.equal(url.origin, 'https://beings.town'); assert.equal(url.searchParams.has('token'), false);
    assert.equal(options.headers.Authorization, `Bearer ${token}`); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
  }
  assert.equal(f.calls[0].url.searchParams.get('since_id'), '9223372036854775807');
});
test('unpaired reads never dispatch to Being or fall back to anonymous Town', async () => {
  const f = fixture(); f.store.load = async () => null;
  await assert.rejects(f.client.read('/api/bonfire/hear'), {code: 'AUTH_REQUIRED'}); assert.equal(f.calls.length, 0);
});
test('wrong identity stops before fetching message history', async () => {
  const f = fixture(async () => json({being: 'bob', mentions: []}));
  await assert.rejects(f.client.read('/api/bonfire/hear'), {code: 'IDENTITY_MISMATCH'}); assert.equal(f.calls.length, 1);
});
test('stale REST response cannot cross a Being switch', async () => {
  let resolve; const f = fixture(() => new Promise(r => {resolve = r;}));
  const pending = f.client.read('/api/bonfire/hear'); await tick(); f.switch(); resolve(json({being: 'alice', mentions: []}));
  await assert.rejects(pending, {code: 'SESSION_CHANGED'});
});
test('REST failures redact upstream messages and do not retry or return partial results', async () => {
  for (const status of [401, 403, 429, 500]) {
    const f = fixture(async () => json({error: token}, status));
    await assert.rejects(f.client.read('/api/bonfire/hear'), e => !e.message.includes(token) && e.code === ([401, 403].includes(status) ? 'AUTH_REQUIRED' : status === 429 ? 'RATE_LIMITED' : 'SERVICE_ERROR'));
    assert.equal(f.calls.length, 1);
  }
});
test('route allowlist excludes token management and arbitrary hosts', async () => {
  const f = fixture();
  for (const route of ['/api/client/token', '/api/token', 'https://evil.test/api', '//evil.test/api']) await assert.rejects(f.client.read(route), {code: 'INVALID_REQUEST'});
  // The inbox is allowed now, but still takes no caller-supplied query parameters.
  for (const query of [{limit: 10}, {since: 1}, {token: 'injected'}]) await assert.rejects(f.client.read('/api/messages', {query}), {code: 'INVALID_REQUEST'});
  for (const query of [{limit: false}, {limit: {}}, {limit: 201}, {limit: '1e2'}, {token: 'injected'}]) await assert.rejects(f.client.read('/api/bonfire/hear', {query}), {code: 'INVALID_REQUEST'});
  assert.equal(f.calls.length, 0);
});
test('pair persists only encrypted-store input and returns public status without token', async () => {
  const f = fixture(async url => new URL(url).pathname.endsWith('/confirm') ? json({ok: true, being_id: 'alice', token}) : new Response('', {status: 401}));
  const result = await f.client.pair({code: 'AB3XY9'});
  assert.deepEqual(f.saved, [['account-a', 'alice', token]]); assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(f.calls[0].options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(f.calls[0].options.body), {being_id: 'alice', code: 'AB3XY9'});
  f.client.reset();
});
test('secure storage unavailable fails before consuming the one-time pairing code', async () => {
  const f = fixture(); f.store.assertAvailable = () => {throw Object.assign(new Error('Unavailable'), {code: 'AUTH_REQUIRED'});};
  await assert.rejects(f.client.pair({code: 'AB3XY9'}), {code: 'AUTH_REQUIRED'}); assert.equal(f.calls.length, 0);
});
test('SSE authenticates hello, emits only safe invalidation hints, and stops on identity change', async () => {
  const f = fixture(); f.client.lifecycle({enabled: true}); await tick();
  f.push('hello', {being_id: 'alice', token_kind: 'client', anonymous: false});
  f.push('bonfire', {message: 'untrusted content', seq: 10}); f.push('fireside', {fireside_id: 7, message: token}); f.push('dm', {content: token}); await tick();
  // dm now reaches the app as a bare invalidation hint: the inbox is re-read over REST,
  // and no part of the pushed payload is carried into the emitted event.
  assert.deepEqual(f.events, [{type: 'hello'}, {type: 'bonfire'}, {type: 'fireside', firesideId: '7'}, {type: 'dm'}]);
  assert.equal(JSON.stringify(f.events).includes(token), false);
  assert.equal(f.client.state().status, 'connected'); assert.equal(JSON.stringify(f.client.state()).includes(token), false);
  f.switch(); await tick(); assert.equal(f.client.state().paired, false);
});
test('anonymous, being-level and foreign SSE hello fail closed without reconnection loop', async () => {
  for (const hello of [{being_id: 'alice', token_kind: 'being', anonymous: false}, {being_id: 'bob', token_kind: 'client', anonymous: false}, {anonymous: true}]) {
    const f = fixture(); f.client.lifecycle({enabled: true}); await tick(); f.push('hello', hello); await tick();
    assert.equal(f.client.state().status, 'identity_mismatch'); assert.equal(f.client._timer, null); assert.equal(f.events.length, 0); f.client.reset();
  }
});
test('SSE data before hello is rejected; network EOF reconnects and hello requests reconciliation', async () => {
  const f = fixture(); f.client.lifecycle({enabled: true}); await tick(); f.push('bonfire', {seq: 1}); await tick();
  assert.equal(f.events.length, 0); assert.equal(f.client.state().status, 'reconnecting'); assert.ok(f.client._timer); f.client.reset();
});
test('fragmented UTF-8, CRLF, comments, multiline data and incomplete EOF are parsed safely', async () => {
  const input = ': heartbeat\r\nevent: bonfire\r\ndata: {"message":\r\ndata: "中文"}\r\n\r\nevent: dm\ndata: {"partial":true}';
  const bytes = new TextEncoder().encode(input), events = [];
  const body = new ReadableStream({start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); }});
  await consumeEvents(body, (type, data) => events.push({type, data})); assert.deepEqual(events, [{type: 'bonfire', data: {message: '中文'}}]);
});
test('oversized SSE event is cancelled without publishing', async () => {
  let cancelled = false;
  const body = new ReadableStream({start(c) {c.enqueue(new TextEncoder().encode('data: ' + 'a'.repeat(1024 * 1024 + 1)));}, cancel() {cancelled = true;}});
  await assert.rejects(consumeEvents(body, () => assert.fail()), {code: 'INVALID_RESPONSE'}); assert.equal(cancelled, true);
});

test('SSE EOF reconnects once and revalidates hello before reconciling', async t => {
  const f = fixture(); t.after(() => f.client.reset()); f.client.lifecycle({enabled: true}); await tick();
  f.push('hello', {being_id: 'alice', token_kind: 'client', anonymous: false}); await tick();
  f.client.retryMs = 10; f.end(); await new Promise(r => setTimeout(r, 30));
  assert.equal(f.calls.length, 2); assert.equal(f.client.state().status, 'connecting');
  f.push('hello', {being_id: 'alice', token_kind: 'client', anonymous: false}); await tick();
  assert.deepEqual(f.events, [{type: 'hello'}, {type: 'hello'}]);
  assert.ok(f.calls.every(call => !call.url.searchParams.has('token') && call.options.headers.Authorization === `Bearer ${token}`));
  f.client.lifecycle({enabled: false}); await tick(); assert.equal(f.client._stream, null); assert.equal(f.client._timer, null);
});

test('paired speak posts directly with the client token and never dispatches a Being turn', async () => {
  const f = fixture(async (url) => new URL(url).pathname === '/api/bonfire/speak'
    ? json({ok: true, seq: 892, being: 'alice', mentions: ['bob'], via: 'client:my-desktop'})
    : json(bonfire));
  const receipt = await f.client.speak({kind: 'bonfire', message: '大家好'});
  assert.deepEqual(receipt, {ok: true, id: '892', seq: 892, mentions: ['bob'], via: 'client:my-desktop'});
  assert.equal(f.calls.length, 1);
  const {url, options} = f.calls[0];
  assert.equal(url.href, 'https://beings.town/api/bonfire/speak');
  assert.equal(url.searchParams.has('token'), false);
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(options.body), {message: '大家好'});
});

test('fireside speak carries the ring id and reports non-membership as not sent', async () => {
  const ok = fixture(async () => json({ok: true, seq: 6, being: 'alice', mentions: [], via: 'client:my-desktop'}));
  assert.equal((await ok.client.speak({kind: 'fireside', message: '在圈里说话', firesideId: '10'})).seq, 6);
  assert.deepEqual(JSON.parse(ok.calls[0].options.body), {message: '在圈里说话', fireside_id: 10});

  const denied = fixture(async () => json({error: 'not a member'}, 403));
  await assert.rejects(denied.client.speak({kind: 'fireside', message: 'hi', firesideId: '10'}), {code: 'NOT_SENT'});
});

test('speak rejects over-limit text locally instead of letting bonfire truncate it silently', async () => {
  const f = fixture(async () => json({ok: true, seq: 1, being: 'alice', mentions: []}));
  await assert.rejects(f.client.speak({kind: 'bonfire', message: 'x'.repeat(4001)}), {code: 'NOT_SENT'});
  await assert.rejects(f.client.speak({kind: 'fireside', message: 'x'.repeat(32001), firesideId: '1'}), {code: 'NOT_SENT'});
  assert.equal(f.calls.length, 0);
  // The bonfire limit counts code points, so text just inside it still dispatches.
  await f.client.speak({kind: 'bonfire', message: '字'.repeat(4000)});
  assert.equal(f.calls.length, 1);
});

test('an unconfirmed write is never reported as unsent, and an unpaired one asks for pairing', async () => {
  const lost = fixture(async () => { throw new TypeError('network down'); });
  await assert.rejects(lost.client.speak({kind: 'bonfire', message: 'hi'}), {code: 'RESULT_UNKNOWN'});

  const unpaired = fixture(); unpaired.store.load = async () => null;
  await assert.rejects(unpaired.client.speak({kind: 'bonfire', message: 'hi'}), {code: 'AUTH_REQUIRED'});
  assert.equal(unpaired.calls.length, 0);
});

test('a receipt for another being is treated as unconfirmed rather than accepted', async () => {
  const f = fixture(async () => json({ok: true, seq: 5, being: 'mallory', mentions: []}));
  await assert.rejects(f.client.speak({kind: 'bonfire', message: 'hi'}), {code: 'RESULT_UNKNOWN'});
});

test('an IP-trusted host reporting via=being is surfaced, not rejected', async () => {
  const f = fixture(async () => json({ok: true, seq: 7, being: 'alice', mentions: [], via: 'being'}));
  assert.equal((await f.client.speak({kind: 'bonfire', message: 'hi'})).via, 'being');
});

test('bonfire shows the server display name, matching fireside, instead of the being id', async () => {
  const f = fixture(async (url) => new URL(url).pathname === '/api/bonfire/mentions'
    ? json({being: 'alice', mentions: []})
    : json({ok: true, global_latest_seq: 1, messages: [{seq: 1, being: 'alice', speaker_name: 'Alice', message: 'hi', at: '2026-09-10T00:00:00Z'}]}));
  const session = new TownSession({getContext: () => ({configured: true, connected: true, beingName: 'alice', connectionId: 1}), readImpl: (...a) => f.client.read(...a), fetchImpl: async () => json({community: []})});
  const {messages} = await session.getBonfireMessages({limit: 10});
  assert.equal(messages[0].beingName, 'Alice');
  assert.equal(messages[0].beingId, 'alice');
});

test('reply metadata is carried on reads and sent on speak, and only for a real parent', async () => {
  const f = fixture(async (url) => new URL(url).pathname === '/api/bonfire/mentions'
    ? json({being: 'alice', mentions: []})
    : json({ok: true, global_latest_seq: 2, messages: [
      {seq: 1, being: 'alice', message: '原帖', at: '2026-09-10T00:00:00Z'},
      {seq: 2, being: 'bob', message: '回复', at: '2026-09-10T00:01:00Z', reply_to: 1, reply_to_being: 'alice', reply_to_preview: '原帖'}]}));
  const session = new TownSession({getContext: () => ({configured: true, connected: true, beingName: 'alice', connectionId: 1}), readImpl: (...a) => f.client.read(...a), fetchImpl: async () => json({community: []})});
  const {messages} = await session.getBonfireMessages({limit: 10});
  assert.equal(messages[0].replyTo, undefined);
  assert.deepEqual(messages[1].replyTo, {id: '1', beingId: 'alice', preview: '原帖'});

  const w = fixture(async () => json({ok: true, seq: 3, being: 'alice', mentions: [], via: 'client:desk', reply_to: 1}));
  await w.client.speak({kind: 'bonfire', message: '我也说一句', replyTo: '1'});
  assert.deepEqual(JSON.parse(w.calls[0].options.body), {message: '我也说一句', reply_to: 1});
  await assert.rejects(w.client.speak({kind: 'bonfire', message: 'x', replyTo: 'abc'}), {code: 'NOT_SENT'});
});

test('inbox reads over the client token and keeps the order Town returned', async () => {
  const f = fixture(async (url) => new URL(url).pathname === '/api/bonfire/mentions' ? json({being: 'alice', mentions: []}) : json({messages: [
    {id: 'm2', sender: 'bob', sender_name: 'Bob', recipient: 'alice', content: '第二条', created_at: '2026-09-10T02:00:00Z', via: 'client:phone'},
    {id: 'm1', sender: 'carol', recipient: 'alice', content: '第一条', created_at: '2026-09-10T01:00:00Z', via: 'being', reply_to: 'm0', reply_to_sender: 'alice', reply_to_preview: '更早'}]}));
  const session = new TownSession({getContext: () => ({configured: true, connected: true, beingName: 'alice', connectionId: 1}), readImpl: (...a) => f.client.read(...a), fetchImpl: async () => json({community: []})});
  const {messages} = await session.getDirectMessages();
  assert.deepEqual(messages.map(m => m.id), ['m2', 'm1']);
  assert.equal(messages[0].senderName, 'Bob');
  assert.equal(messages[1].senderName, 'carol');
  assert.equal(messages[0].via, 'client:phone');
  assert.deepEqual(messages[1].replyTo, {id: 'm0', beingId: 'alice', preview: '更早'});
  assert.equal(f.calls.at(-1).url.href, 'https://beings.town/api/messages');
  assert.equal(f.calls.at(-1).options.headers.Authorization, `Bearer ${token}`);
});

test('a private message to yourself is refused locally, before any request', async () => {
  const f = fixture(async () => json({ok: true, message_id: 'm9', recipient: 'bob', via: 'client:desk'}));
  await assert.rejects(f.client.sendDirectMessage({recipient: 'alice', content: 'hi'}), {code: 'NOT_SENT'});
  assert.equal(f.calls.length, 0);
  const receipt = await f.client.sendDirectMessage({recipient: 'bob', content: 'hi'});
  assert.deepEqual(receipt, {ok: true, id: 'm9', recipient: 'bob', via: 'client:desk'});
  assert.deepEqual(JSON.parse(f.calls[0].options.body), {recipient: 'bob', content: 'hi'});
});
