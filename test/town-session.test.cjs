'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {TownSession, TOWN_AUTH_DETAIL} = require('../src/town-session.cjs');
const {TownRefresh} = require('../src/town-refresh.cjs');

function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return {promise, resolve}; }
function json(value, status = 200) { return new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}}); }
function harness(overrides = {}) {
  const context = {configured: true, connected: true, connectionId: 5, identityRevision: 1, beingName: 'alice', token: 'LOOM_SECRET_MUST_STAY_LOCAL'};
  const calls = [];
  const session = new TownSession({getContext: () => ({...context}), readImpl: overrides.readImpl ?? null, fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    calls.push({url: parsed, options});
    if (overrides.request) { const result = await overrides.request(parsed, options, calls); if (result !== undefined) return result; }
    if (parsed.pathname === '/api') return json({community: [{being_id: 'alice', display_name: 'Alice', about: null}, {being_id: 'echo', display_name: 'Echo', about: 'A resident'}]});
    if (parsed.pathname === '/api/bonfire/mentions') return json({being: 'alice', mentions: [], latest_id: 0});
    if (parsed.pathname === '/api/bonfire/hear') return json({ok: true, global_latest_seq: 4, messages: [{seq: 4, being: 'Echo', message: 'Hello', at: '2026-09-07T12:00:00+08:00', revised_at: null}]});
    if (parsed.pathname === '/api/bonfire/speak') return json({ok: true, seq: 5, being: 'alice', mentions: ['Echo']});
    if (parsed.pathname === '/api/fireside/list') return json({owned: [{id: 7, name: 'Our ring', member_count: 2, key: 'PRIVATE_INVITE_KEY'}], joined: [{id: 9, name: 'Another ring', member_count: 3}]});
    if (parsed.pathname === '/api/fireside/members') return json([{being_id: 'alice', display_name: 'Alice', joined_at: '2026-09-07T12:00:00+08:00'}, {being_id: 'echo', display_name: 'Echo', joined_at: null}]);
    if (parsed.pathname === '/api/fireside/hear') return json({being: 'alice', latest_seq: 8, messages: [{seq: 8, being: 'echo', speaker_name: 'Echo', message: 'Welcome', at: '2026-09-07T12:00:00+08:00', revised_at: null, mentions: ['alice']}]});
    if (parsed.pathname === '/api/channels/status') return json({channels: [{channel: 'feishu', status: 'connected', app_id: 'cli_example', app_secret: 'SHOULD_NOT_LEAK'}, {channel: 'wechat', status: 'pending'}]});
    if (parsed.pathname === '/api/channels/register') return json({ok: true, status: 'pending', qr_code_url: 'https://weixin.qq.com/q/fixture'});
    if (parsed.pathname === '/api/channels/credentials') return json({ok: true, app_secret: 'SHOULD_NOT_LEAK'});
    throw new Error('Unexpected endpoint');
  }});
  return {session, context, calls};
}

test('public member directory uses homepage without credentials and filters malformed IDs', async () => {
  const {session, context, calls} = harness({request: url => url.pathname === '/api' ? json({community: [{being_id: 'echo', display_name: 'Echo'}, {being_id: '../secret', display_name: 'Invalid'}, {being_id: 'echo', display_name: 'Duplicate'}]}) : undefined});
  context.connected = false;
  assert.deepEqual(await session.getMembers(), {members: [{id: 'echo', name: 'Echo', description: ''}], source: 'public'});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, 'https://beings.town/api');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(!JSON.stringify(calls).includes(context.token));
});

test('untrusted Town network reports auth_required without sending a message', async () => {
  const {session, calls} = harness({request: url => url.pathname === '/api/bonfire/mentions' ? json({error: 'private upstream detail'}, 401) : undefined});
  await assert.rejects(session.sendBonfireMessage({content: 'Hi', mentions: ['echo'], connectionRevision: 5}), {code: 'AUTH_REQUIRED', message: TOWN_AUTH_DETAIL});
  assert.equal(calls.length, 1);
  assert.equal(session.state().bonfire.status, 'auth_required');
});

test('IP Trust identity must match the selected Loom identity', async () => {
  const {session, calls} = harness({request: url => url.pathname === '/api/bonfire/mentions' ? json({being: 'somebody-else', mentions: []}) : undefined});
  await assert.rejects(session.beginChannelConnection({channel: 'wechat', connectionRevision: 5}), {code: 'IDENTITY_MISMATCH'});
  assert.equal(calls.length, 1);
  assert.equal(session.state().channel.status, 'error');
});

test('Bonfire reads use documented since and limit and normalize full messages', async () => {
  const {session, calls} = harness();
  const result = await session.getBonfireMessages({since: 3, limit: 20});
  assert.deepEqual(result.messages[0], {id: '4', beingId: 'echo', beingName: 'Echo', content: 'Hello', createdAt: '2026-09-07T12:00:00+08:00', revisedAt: '', mentions: []});
  assert.equal(result.latestSeq, 4);
  assert.equal(calls[0].url.searchParams.get('since_id'), '9223372036854775807');
  assert.equal(calls[1].url.searchParams.get('since'), '3');
  assert.equal(calls[1].url.searchParams.get('limit'), '20');
});

test('Session to Refresh preserves a complete 32000-character Fireside message and Bonfire keeps its 4000 limit', async () => {
  const content = '围'.repeat(31993) + 'THE_END';
  for (const kind of ['fireside', 'bonfire']) {
    const {session} = harness({readImpl: async route => {
      assert.equal(route, `/api/${kind}/hear`);
      return {ok: true, being: 'alice', latest_seq: 8, global_latest_seq: 8, messages: [{seq: 8, being: 'echo', speaker_name: 'Echo', message: content, at: '2026-09-07T12:00:00+08:00'}]};
    }});
    const reader = new TownRefresh({
      getIdentity: () => ({beingId: 'alice', connectionRevision: 5, identityRevision: 1}),
      readSnapshot: ({signal, limit}) => kind === 'fireside'
        ? session.getFiresideMessages({firesideId: 7, limit}, {signal})
        : session.getBonfireMessages({limit}, {signal}),
      clock: {now: () => 1000, setTimeout: () => ({unref() {}}), clearTimeout() {}},
    });
    try {
      reader.start();
      const snapshot = await reader.refresh();
      const expected = kind === 'fireside' ? content : content.slice(0, 4000);
      assert.equal(snapshot.messages[0].content, expected);
      assert.equal(reader.snapshot().messages[0].content, expected);
      assert.equal(snapshot.latestSeq, 8);
      assert.equal(reader.status().stale, false);
      assert.equal(reader.status().errorCode, '');
    } finally { reader.stop(); }
  }
});

test('only explicit Bonfire submit sends, with each selected member represented once', async () => {
  const {session, calls, context} = harness();
  await session.getMembers();
  await session.getBonfireMessages();
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 0);
  const result = await session.sendBonfireMessage({content: '@echo hello', mentions: ['echo', 'echo'], connectionRevision: 5});
  assert.deepEqual(result, {ok: true, id: '5', mentions: ['Echo']});
  const write = calls.find(call => call.options.method === 'POST');
  assert.deepEqual(JSON.parse(write.options.body), {message: '@echo hello'});
  assert.equal(write.url.pathname, '/api/bonfire/speak');
  assert.ok(!JSON.stringify(calls).includes(context.token));
});

test('mentions are verified from the real directory and added without substring confusion', async () => {
  const {session, calls} = harness();
  await session.sendBonfireMessage({content: '@echo-extra hello', mentions: ['echo'], connectionRevision: 5});
  assert.equal(JSON.parse(calls.at(-1).options.body).message, '@echo\n@echo-extra hello');
  await assert.rejects(session.sendBonfireMessage({content: 'Hello', mentions: ['invented-being'], connectionRevision: 5}), {code: 'INVALID_REQUEST'});
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
});

test('stale revision is rejected before any network request', async () => {
  const {session, calls} = harness();
  await assert.rejects(session.sendBonfireMessage({content: 'Hi', mentions: [], connectionRevision: 4}), {code: 'SESSION_CHANGED'});
  await assert.rejects(session.updateFeishuCredentials({appId: 'cli_fixture', appSecret: 'secret', connectionRevision: 4}), {code: 'SESSION_CHANGED'});
  assert.equal(calls.length, 0);
});

test('connection switch during authorization cannot send or repopulate state', async () => {
  const gate = deferred();
  const {session, calls, context} = harness({request: url => url.pathname === '/api/bonfire/mentions' ? gate.promise : undefined});
  const sending = session.sendBonfireMessage({content: 'Hi', mentions: [], connectionRevision: 5});
  context.connectionId++;
  session.reset();
  gate.resolve(json({being: 'alice', mentions: []}));
  await assert.rejects(sending, {code: 'SESSION_CHANGED'});
  assert.equal(calls.length, 1);
  assert.equal(session.state().bonfire.status, 'unknown');
});

test('uncertain send is never retried and duplicate in-flight writes are rejected', async () => {
  const gate = deferred();
  const started = deferred();
  const {session, calls} = harness({request: url => {
    if (url.pathname === '/api/bonfire/speak') { started.resolve(); return gate.promise; }
  }});
  const value = {content: 'Hello', mentions: [], connectionRevision: 5};
  const sending = session.sendBonfireMessage(value);
  await started.promise;
  await assert.rejects(session.sendBonfireMessage(value), {code: 'BUSY'});
  gate.resolve(new Response('lost', {status: 502}));
  await assert.rejects(sending, {code: 'RESULT_UNKNOWN'});
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
});

test('channel fixed flow uses documented bodies and never returns submitted secrets', async () => {
  const {session, calls} = harness();
  const started = await session.beginChannelConnection({channel: 'wechat', connectionRevision: 5});
  assert.equal(started.qrCodeUrl, 'https://weixin.qq.com/q/fixture');
  assert.deepEqual(JSON.parse(calls.find(call => call.url.pathname === '/api/channels/register').options.body), {channel: 'wechat', being_id: 'alice'});
  const saved = await session.updateFeishuCredentials({appId: 'cli_fixture', appSecret: 'PRIVATE_APP_SECRET', connectionRevision: 5});
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), {channel: 'feishu', app_id: 'cli_fixture', app_secret: 'PRIVATE_APP_SECRET'});
  assert.equal(saved.status, 'pending');
  const state = await session.getChannelStatus();
  assert.equal(state.channels[0].status, 'connected');
  assert.ok(!JSON.stringify({saved, state, session: session.state()}).includes('SECRET'));
  assert.ok(!JSON.stringify(state).includes('SHOULD_NOT_LEAK'));
});

test('channel unknown status stays unknown and untrusted QR links never reach UI', async () => {
  const {session} = harness({request: url => url.pathname === '/api/channels/register' ? json({ok: true, message: 'app_secret=DO_NOT_SHOW', qr_code_url: 'https://attacker.invalid/qr', status: 'magic-success'}) : undefined});
  const result = await session.beginChannelConnection({channel: 'wechat', connectionRevision: 5});
  assert.equal(result.status, 'unknown');
  assert.equal(result.qrCodeUrl, undefined);
  assert.ok(!JSON.stringify(result).includes('DO_NOT_SHOW'));
});

test('verified QR images are proxied as bounded data images without renderer network access', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nPwAAAAASUVORK5CYII=';
  const {session, calls} = harness({request: url => url.hostname === 'weixin.qq.com' ? new Response(Buffer.from(png, 'base64'), {headers: {'Content-Type': 'image/png'}}) : undefined});
  const result = await session.beginChannelConnection({channel: 'wechat', connectionRevision: 5});
  assert.equal(result.qrCodeDataUrl, `data:image/png;base64,${png}`);
  assert.equal(calls.at(-1).options.credentials, 'omit');
  assert.equal(calls.at(-1).options.redirect, 'error');
  assert.equal(calls.at(-1).options.body, undefined);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
});

test('inline SVG and malformed raster QR responses never become renderable data', async () => {
  const {session} = harness({request: url => url.pathname === '/api/channels/register' ? json({ok: true, qr_code: 'data:image/svg+xml;base64,PHN2Zy8+'}) : undefined});
  const result = await session.beginChannelConnection({channel: 'wechat', connectionRevision: 5});
  assert.equal(result.qrCodeDataUrl, undefined);
  const raster = harness({request: url => url.hostname === 'weixin.qq.com' ? new Response('<script/>', {headers: {'Content-Type': 'image/png'}}) : undefined});
  const invalid = await raster.session.beginChannelConnection({channel: 'wechat', connectionRevision: 5});
  assert.equal(invalid.qrCodeDataUrl, '');
  assert.match(invalid.detail, /扫码图像暂时无法读取/);
});

test('oversized or HTML responses fail closed', async () => {
  const large = harness({request: () => new Response('{}', {headers: {'Content-Type': 'application/json', 'Content-Length': String(1024 * 1024 + 1)}})});
  await assert.rejects(large.session.getMembers(), {code: 'INVALID_RESPONSE'});
  const html = harness({request: () => new Response('<html>Login</html>', {headers: {'Content-Type': 'text/html'}})});
  await assert.rejects(html.session.getMembers(), {code: 'INVALID_RESPONSE'});
});

test('invalid and accessor requests are rejected without invoking getters or the network', async () => {
  const {session, calls} = harness();
  let invoked = false;
  await assert.rejects(session.sendBonfireMessage({get content() { invoked = true; return 'bad'; }, mentions: [], connectionRevision: 5}), {code: 'INVALID_REQUEST'});
  await assert.rejects(session.getBonfireMessages({since: -1}), {code: 'INVALID_REQUEST'});
  await assert.rejects(session.beginChannelConnection({channel: 'other', connectionRevision: 5}), {code: 'INVALID_REQUEST'});
  await assert.rejects(session.updateFeishuCredentials({appId: 'cli_fixture', appSecret: 'line\nbreak', connectionRevision: 5}), {code: 'INVALID_REQUEST'});
  assert.equal(invoked, false);
  assert.equal(calls.length, 0);
});

test('Fireside list and members keep display data while stripping invite keys and extra fields', async () => {
  const {session, calls, context} = harness({request: url => {
    if (url.pathname === '/api/fireside/list') return json({owned: [{id: 7, name: 'Our\u0000 ring', member_count: 2, key: 'PRIVATE_INVITE_KEY'}, {id: '../bad', name: 'Invalid'}], joined: [{id: 7, name: 'Duplicate'}, {id: 9, name: 'Another ring', secret: 'PRIVATE_SECRET'}]});
    if (url.pathname === '/api/fireside/members') return json([{being_id: 'alice', display_name: 'Alice', joined_at: '2026-09-07', secret: 'PRIVATE_SECRET'}, {being_id: 'alice', display_name: 'Duplicate'}, {being_id: '../bad'}, {being_id: 'echo', display_name: 'Echo\u202e'}]);
  }});
  const rooms = await session.getFiresides();
  assert.deepEqual(rooms, {owned: [{id: 7, name: 'Our ring', member_count: 2}], joined: [{id: 9, name: 'Another ring'}]});
  const members = await session.getFiresideMembers('7');
  assert.deepEqual(members, {members: [{being_id: 'alice', display_name: 'Alice', joined_at: '2026-09-07'}, {being_id: 'echo', display_name: 'Echo', joined_at: ''}]});
  assert.equal(calls.at(-1).url.href, 'https://beings.town/api/fireside/members?fireside_id=7');
  assert.equal(session.state().fireside.status, 'ready');
  assert.ok(calls.every(call => call.options.method === 'GET' && call.options.credentials === 'omit' && !call.url.searchParams.has('token')));
  assert.ok(!JSON.stringify({rooms, members, calls}).includes(context.token));
  assert.ok(!JSON.stringify({rooms, members}).includes('PRIVATE'));
});

test('Fireside hear validates identity and normalizes complete ordered snapshots', async () => {
  const {session, calls} = harness({request: url => url.pathname === '/api/fireside/hear' ? json({being: 'alice', latest_seq: 8, messages: [
    {seq: 8, being: 'echo', speaker_name: 'Echo', message: 'Welcome\u0000', at: '2026-09-07', revised_at: '2026-09-08', mentions: ['alice', 'alice', '../bad'], key: 'SECRET'},
    {seq: 6, being: 'alice', message: 'Earlier', mentions: []},
    {seq: 8, being: 'echo', message: 'Duplicate'},
    {seq: -1, being: 'echo', message: 'Invalid'},
  ]}) : undefined});
  const result = await session.getFiresideMessages({firesideId: '7'});
  assert.deepEqual(result, {messages: [
    {id: '6', beingId: 'alice', beingName: 'alice', content: 'Earlier', createdAt: '', revisedAt: '', mentions: []},
    {id: '8', beingId: 'echo', beingName: 'Echo', content: 'Welcome', createdAt: '2026-09-07', revisedAt: '2026-09-08', mentions: ['alice']},
  ], latestSeq: 8});
  assert.equal(calls[1].url.href, 'https://beings.town/api/fireside/hear?fireside_id=7&limit=10');
  assert.equal(calls[1].options.body, undefined);
  await session.getFiresideMessages({firesideId: 7, since: 6, limit: 20});
  assert.equal(calls.at(-1).url.searchParams.get('since'), '6');
  assert.equal(calls.at(-1).url.searchParams.get('limit'), '20');
});

test('Fireside reads keep real authorization errors and never fall back to chat or callback', async () => {
  for (const status of [401, 403]) {
    const {session, calls} = harness({request: url => url.pathname === '/api/bonfire/mentions' ? json({error: 'private detail'}, status) : undefined});
    await assert.rejects(session.getFiresides(), {code: 'AUTH_REQUIRED', message: TOWN_AUTH_DETAIL});
    await assert.rejects(session.getFiresideMembers('7'), {code: 'AUTH_REQUIRED'});
    await assert.rejects(session.getFiresideMessages({firesideId: '7'}), {code: 'AUTH_REQUIRED'});
    assert.equal(session.state().fireside.status, 'auth_required');
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.url.pathname === '/api/bonfire/mentions' && call.options.method === 'GET'));
  }
  const wrong = harness({request: url => url.pathname === '/api/fireside/hear' ? json({being: 'another-being', latest_seq: 8, messages: []}) : undefined});
  await assert.rejects(wrong.session.getFiresideMessages({firesideId: 7}), {code: 'IDENTITY_MISMATCH'});
  assert.equal(wrong.session.state().fireside.status, 'error');
});

test('Fireside rejects malformed, truncated and wrapped member responses', async () => {
  const cases = [
    ['/api/fireside/list', {owned: [], joined: 'bad'}, session => session.getFiresides()],
    ['/api/fireside/members', {members: []}, session => session.getFiresideMembers(7)],
    ['/api/fireside/hear', {being: 'alice', latest_seq: '8', messages: []}, session => session.getFiresideMessages({firesideId: 7})],
    ['/api/fireside/hear', {being: 'alice', latest_seq: 8, messages: [{seq: 8, being: 'echo', message: 'Partial', truncated: true}]}, session => session.getFiresideMessages({firesideId: 7})],
  ];
  for (const [route, response, read] of cases) {
    const {session} = harness({request: url => url.pathname === route ? json(response) : undefined});
    await assert.rejects(read(session), {code: 'INVALID_RESPONSE'});
  }
});

test('room identifiers and signal properties cannot enter renderer-controlled request JSON', async () => {
  const {session, calls} = harness();
  for (const id of [0, -1, 1.5, '../7', '07', '7?token=x', '9007199254740992', {id: 7}]) {
    await assert.rejects(session.getFiresideMembers(id), {code: 'INVALID_REQUEST'});
    await assert.rejects(session.getFiresideMessages({firesideId: id}), {code: 'INVALID_REQUEST'});
  }
  await assert.rejects(session.getFiresides({signal: {}}), {code: 'INVALID_REQUEST'});
  await assert.rejects(session.getBonfireMessages({signal: {}}), {code: 'INVALID_REQUEST'});
  await assert.rejects(session.getFiresideMessages({firesideId: 7, signal: {}}), {code: 'INVALID_REQUEST'});
  await assert.rejects(session.getFiresideMessages({firesideId: 7, limit: 201}), {code: 'INVALID_REQUEST'});
  assert.equal(calls.length, 0);
});

test('a cancelled background read never starts network requests or changes state', async () => {
  const {session, calls} = harness();
  const controller = new AbortController();
  controller.abort();
  const options = {signal: controller.signal};
  await assert.rejects(session.getBonfireMessages({}, options), {code: 'ABORTED'});
  await assert.rejects(session.getFiresides({}, options), {code: 'ABORTED'});
  await assert.rejects(session.getFiresideMembers(7, options), {code: 'ABORTED'});
  await assert.rejects(session.getFiresideMessages({firesideId: 7}, options), {code: 'ABORTED'});
  assert.equal(calls.length, 0);
  assert.equal(session.state().bonfire.status, 'unknown');
  assert.equal(session.state().fireside.status, 'unknown');
});

test('cancelling authorization aborts the request and never advances to hear', async () => {
  const started = deferred();
  const controller = new AbortController();
  const {session, calls} = harness({request: (url, options) => {
    if (url.pathname === '/api/bonfire/mentions') return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true});
      started.resolve();
    });
  }});
  const reading = session.getBonfireMessages({}, {signal: controller.signal});
  await started.promise;
  controller.abort();
  await assert.rejects(reading, {code: 'ABORTED'});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(session.state().bonfire.status, 'unknown');
  assert.equal(session._requests.size, 0);
});

test('cancelling a hear body stops its stream without a service error or cached partial result', async () => {
  const started = deferred();
  const controller = new AbortController();
  const {session, calls} = harness({request: (url, options) => {
    if (url.pathname === '/api/fireside/hear') return new Response(new ReadableStream({start(stream) {
      stream.enqueue(new TextEncoder().encode('{"being":"alice",'));
      options.signal.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), {once: true});
      started.resolve();
    }}), {headers: {'Content-Type': 'application/json'}});
  }});
  const reading = session.getFiresideMessages({firesideId: '7'}, {signal: controller.signal});
  await started.promise;
  controller.abort();
  await assert.rejects(reading, {code: 'ABORTED'});
  assert.equal(calls.at(-1).options.signal.aborted, true);
  assert.equal(session.state().fireside.status, 'ready');
  assert.equal(session._requests.size, 0);
});

test('identity reset during a Fireside read rejects late responses and preserves reset state', async () => {
  const gate = deferred();
  const started = deferred();
  const {session, calls, context} = harness({request: url => {
    if (url.pathname === '/api/fireside/hear') { started.resolve(); return gate.promise; }
  }});
  const reading = session.getFiresideMessages({firesideId: 7});
  await started.promise;
  context.connectionId++;
  session.reset();
  gate.resolve(json({being: 'alice', latest_seq: 8, messages: []}));
  await assert.rejects(reading, {code: 'SESSION_CHANGED'});
  assert.equal(calls.at(-1).options.signal.aborted, true);
  assert.equal(session.state().fireside.status, 'unknown');
});

test('Heart reads bypass the desktop IP Trust probe and retain the Town message contract', async () => {
  const reads = [];
  const {session, calls} = harness({readImpl: async (route, options) => {
    reads.push({route, options});
    return {ok: true, global_latest_seq: 9, messages: [{seq: 9, being: 'echo', message: 'From Heart'}]};
  }});
  const result = await session.getBonfireMessages({limit: 20, since: 7});
  assert.equal(result.messages[0].content, 'From Heart');
  assert.deepEqual(reads.map(read => read.route), ['/api/bonfire/hear']);
  assert.deepEqual(reads[0].options.query, {limit: 20, since: 7});
  assert.deepEqual(calls.map(call => call.url.pathname), ['/api']);
  assert.equal(session.state().bonfire.status, 'ready');
});

test('an unavailable Heart reader never falls back to a protected desktop Town request', async () => {
  const {session, calls} = harness({readImpl: async () => { throw Object.assign(new Error('Heart reader is not deployed'), {code: 'BACKGROUND_UNAVAILABLE'}); }});
  await assert.rejects(session.getFiresides(), {code: 'BACKGROUND_UNAVAILABLE'});
  assert.equal(calls.length, 0);
  assert.equal(session.state().fireside.status, 'error');
});

test('reset aborts Heart requests and cannot publish a late private room response', async () => {
  const gate = deferred(), started = deferred();
  let requestSignal;
  const {session, context, calls} = harness({readImpl: async (_route, options) => {
    requestSignal = options.signal; started.resolve(); return gate.promise;
  }});
  const reading = session.getFiresideMessages({firesideId: '7'});
  await started.promise;
  context.connectionId++;
  session.reset();
  assert(requestSignal.aborted);
  gate.resolve({being: 'alice', latest_seq: 0, messages: []});
  await assert.rejects(reading, {code: 'SESSION_CHANGED'});
  assert.equal(calls.length, 0);
  assert.equal(session.state().fireside.status, 'unknown');
  assert.equal(session._requests.size, 0);
});

test('cancelling the native scheduler cancels its Heart read without changing access state', async () => {
  const started = deferred();
  const controller = new AbortController();
  const {session} = harness({readImpl: (_route, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), {once: true});
    started.resolve();
  })});
  const reading = session.getFiresides({}, {signal: controller.signal});
  await started.promise;
  controller.abort();
  await assert.rejects(reading, {code: 'ABORTED'});
  assert.equal(session.state().fireside.status, 'unknown');
  assert.equal(session._requests.size, 0);
});

test('adding a read-only Heart transport cannot move writes or channel settings into it', async () => {
  let reads = 0;
  const {session, calls} = harness({readImpl: async () => { reads++; throw new Error('Unexpected bridge call'); }});
  await session.sendBonfireMessage({content: 'Explicit fixture send', mentions: [], connectionRevision: 5});
  await session.getChannelStatus();
  assert.equal(reads, 0);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert(calls.some(call => call.url.pathname === '/api/channels/status'));
});

const scrollSummary = (changes = {}) => ({id: 'wer79LxF', being_id: 'alice', display_name: 'Alice', title: 'A document', visibility: 'private', created_at: '2026-09-07T00:00:00Z', updated_at: '2026-09-07T01:00:00Z', kind: 'note', lifecycle: 'seed', tags: ['notes'], revision: 2, share_token: 'PRIVATE_SHARE_TOKEN', ...changes});

test('Scroll browsing uses authenticated read routes and keeps only display fields', async () => {
  const reads = [];
  const {session, calls} = harness({readImpl: async (route, options) => {
    reads.push({route, query: options.query});
    return route === '/api/scrolls'
      ? {scrolls: [scrollSummary(), scrollSummary({id: 'another-note'})], total: 8, offset: 2, limit: 2}
      : scrollSummary({content: '🧭A', total_length: 3, offset: 0, limit: 2, has_more: true, source_context: 'INTERNAL_CONTEXT'});
  }});
  const list = await session.listScrolls({offset: 2, limit: 2, visibility: 'private'});
  assert.equal(list.scrolls[0].beingId, 'alice');
  assert.equal(list.scrolls[0].beingName, 'Alice');
  assert.equal(list.hasMore, true);
  const detail = await session.getScroll({id: 'wer79LxF', limit: 2});
  assert.equal(detail.scroll.content, '🧭A');
  assert.equal(detail.scroll.totalLength, 3);
  assert.equal(detail.scroll.nextOffset, 2);
  assert.equal(detail.scroll.hasMore, true);
  assert.deepEqual(reads, [
    {route: '/api/scrolls', query: {offset: 2, limit: 2, visibility: 'private'}},
    {route: '/api/scrolls/wer79LxF', query: {offset: 0, limit: 2}},
  ]);
  assert.equal(calls.length, 0);
  assert.equal(session.state().scroll.status, 'ready');
  assert(!JSON.stringify({list, detail}).includes('PRIVATE_SHARE_TOKEN'));
  assert(!JSON.stringify(detail).includes('INTERNAL_CONTEXT'));
});

test('Scroll malformed metadata, duplicate entries and incomplete content cannot become documents', async () => {
  for (const [raw, read] of [
    [{scrolls: [scrollSummary()], total: 1, offset: 1, limit: 50}, session => session.listScrolls()],
    [{scrolls: [scrollSummary(), scrollSummary()], total: 2, offset: 0, limit: 50}, session => session.listScrolls()],
    [{scrolls: [], total: 1, offset: 0, limit: 50}, session => session.listScrolls()],
    [{scrolls: [scrollSummary({being_id: undefined})], total: 1, offset: 0, limit: 50}, session => session.listScrolls()],
    [scrollSummary({id: 'another', content: '', total_length: 0, offset: 0, limit: 10000, has_more: false}), session => session.getScroll({id: 'wer79LxF'})],
    [scrollSummary({content: 'Partial', total_length: 999, offset: 0, limit: 10000, has_more: false}), session => session.getScroll({id: 'wer79LxF'})],
    [scrollSummary({content: 'Partial', total_length: 20000, offset: 0, limit: 10000, has_more: true}), session => session.getScroll({id: 'wer79LxF'})],
  ]) {
    const {session} = harness({readImpl: async () => raw});
    await assert.rejects(read(session), {code: 'INVALID_RESPONSE'});
  }
});

test('Scroll request capabilities, reserved routes and invalid pagination never reach a transport', async () => {
  let count = 0;
  const {session, calls} = harness({readImpl: async () => { count++; }});
  for (const id of ['../private', 'help', 'search', 'graph', 'match', 'a?token=x', '', 7]) await assert.rejects(session.getScroll({id}), {code: 'INVALID_REQUEST'});
  for (const value of [{offset: -1}, {offset: 4294967296}, {limit: 201}, {limit: '50'}, {visibility: 'all'}, {token: 'secret'}, {signal: {}}]) await assert.rejects(session.listScrolls(value), {code: 'INVALID_REQUEST'});
  await assert.rejects(session.getScroll({id: 'wer79LxF', limit: 10001}), {code: 'INVALID_REQUEST'});
  await assert.rejects(session.getScroll({get id() { throw new Error('Getter ran'); }}), {code: 'INVALID_REQUEST'});
  await assert.rejects(session.listBeings({headers: {}}), {code: 'INVALID_REQUEST'});
  assert.equal(count, 0);
  assert.equal(calls.length, 0);
});

test('a connection switch discards a private Scroll response and clears its access state', async () => {
  const started = deferred(), gate = deferred();
  const {session, context} = harness({readImpl: async () => { started.resolve(); return gate.promise; }});
  const pending = session.getScroll({id: 'wer79LxF'});
  await started.promise;
  context.connectionId++;
  session.reset();
  gate.resolve(scrollSummary({content: 'Old private document', total_length: 20, offset: 0, limit: 10000, has_more: false}));
  await assert.rejects(pending, {code: 'SESSION_CHANGED'});
  assert.equal(session.state().scroll.status, 'unknown');
});

test('directory data never infers a human relationship from IDs or unsupported response fields', async () => {
  const {session, calls} = harness({request: url => url.pathname === '/api' ? json({community: [{being_id: 'alice', display_name: 'Alice', about: 'A resident', human_name: 'Unsupported', token: 'SECRET'}]}) : undefined});
  const result = await session.listBeings({});
  assert.deepEqual(result.beings, [{id: 'alice', name: 'Alice', description: 'A resident', status: '', human: null}]);
  assert.equal(result.source, 'public');
  assert.match(result.detail, /人类伙伴信息暂未公开/);
  assert.equal(calls.length, 1);
  assert(!JSON.stringify(result).includes('SECRET'));
  assert(!JSON.stringify(result).includes('Unsupported'));
});

test('periodic directory reads show all public residents without occupying the Being conversation', async () => {
  let protectedReads = 0;
  const {session, calls, context} = harness({readImpl: async () => { protectedReads++; throw new Error('Must not occupy Being'); }});
  for (let refresh = 0; refresh < 2; refresh++) {
    const result = await session.listBeings();
    assert.equal(result.source, 'public');
    assert.deepEqual(result.beings.map(being => being.id), ['alice', 'echo']);
    assert(result.beings.every(being => being.human === null && being.status === ''));
    assert.equal(session.state().beings.status, 'ready');
  }
  assert.deepEqual(calls.map(call => call.url.pathname), ['/api', '/api']);
  assert.equal(protectedReads, 0);
  context.connected = false;
  assert.equal((await session.listBeings()).beings.length, 2);
});

test('public directory rejects stale identity and malformed partial records', async () => {
  const gate = deferred(), started = deferred();
  const {session, context} = harness({readImpl: async () => { throw Object.assign(new Error('busy'), {code: 'BUSY'}); }, request: url => {
    if (url.pathname === '/api') { started.resolve(); return gate.promise; }
  }});
  const pending = session.listBeings();
  await started.promise;
  context.identityRevision++;
  gate.resolve(json({community: [{being_id: 'alice', display_name: 'Alice'}]}));
  await assert.rejects(pending, {code: 'SESSION_CHANGED'});
  const invalid = harness({readImpl: async () => ({}), request: url => url.pathname === '/api' ? json({community: [{being_id: '../bad', display_name: 'Bad'}]}) : undefined});
  await assert.rejects(invalid.session.listBeings(), {code: 'INVALID_RESPONSE'});
});

test('cancelled library reads cannot start requests or publish access state', async () => {
  const {session, calls} = harness();
  const controller = new AbortController();
  controller.abort();
  const options = {signal: controller.signal};
  await assert.rejects(session.listScrolls({}, options), {code: 'ABORTED'});
  await assert.rejects(session.getScroll({id: 'wer79LxF'}, options), {code: 'ABORTED'});
  await assert.rejects(session.listBeings({}, options), {code: 'ABORTED'});
  assert.equal(calls.length, 0);
  assert.equal(session.state().scroll.status, 'unknown');
  assert.equal(session.state().beings.status, 'unknown');
});
