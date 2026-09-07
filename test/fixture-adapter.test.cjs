'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { FixtureAdapter, handleMcpText, TOOL_NAME, FIXTURE_MARKER, MAX_MESSAGE_BYTES, MAX_MESSAGES } = require('./integration/fixture-adapter.cjs');

const request = (method, params = {}, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const invoke = () => request('tools/call', { name: TOOL_NAME, arguments: {} });
const deny = (text) => {
  const outcome = handleMcpText(text);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.fixtureProcessed, false);
  assert.ok(!JSON.stringify(outcome).includes('PRIVATE_INPUT'));
  return outcome;
};

test('fixture tool returns exactly the agreed fixed MCP result', () => {
  const outcome = handleMcpText(invoke());
  assert.equal(outcome.fixtureProcessed, true);
  assert.deepEqual(outcome.response.result, { content: [{ type: 'text', text: 'BEING_TOOL_ROUNDTRIP_OK_V1' }], isError: false });
  assert.equal(FIXTURE_MARKER, 'BEING_TOOL_ROUNDTRIP_OK_V1');
  assert.equal(TOOL_NAME, 'diagnostics_roundtrip');
});

test('tool list exposes one zero-argument capability and no native Portal tools', () => {
  const result = handleMcpText(request('tools/list')).response.result;
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].name, TOOL_NAME);
  assert.deepEqual(result.tools[0].inputSchema, { type: 'object', properties: {}, additionalProperties: false });
});

test('initialize accepts standard protocol metadata without reflecting it', () => {
  const outcome = handleMcpText(request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'PRIVATE_INPUT', version: '1.0.0' } }));
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.fixtureProcessed, false);
  assert.deepEqual(outcome.response.result, { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'being-desktop-fixture-adapter', version: '1.0.0' } });
});

test('protocol ping is distinct from the fixture tool', () => {
  const outcome = handleMcpText(request('ping'));
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.fixtureProcessed, false);
  assert.deepEqual(outcome.response.result, {});
});

test('zero and string request identifiers are preserved only in responses', () => {
  for (const id of [0, 'run-123:request-1']) assert.equal(handleMcpText(request('ping', {}, id)).response.id, id);
});

test('results are fresh values; mutations cannot affect subsequent fixed outputs', () => {
  const first = handleMcpText(invoke());
  first.response.result.content[0].text = 'modified';
  assert.equal(handleMcpText(invoke()).response.result.content[0].text, FIXTURE_MARKER);
  const tools = handleMcpText(request('tools/list'));
  tools.response.result.tools.push({ name: 'portal_exec' });
  assert.equal(handleMcpText(request('tools/list')).response.result.tools.length, 1);
});

const rejectedFrames = [
  ['invalid JSON', '{PRIVATE_INPUT'],
  ['batch requests', `[${invoke()}]`],
  ['JSON null', 'null'],
  ['JSON primitive', '"PRIVATE_INPUT"'],
  ['multiple JSON messages in one frame', `${invoke()}\n${invoke()}`],
  ['wrong protocol version', '{"jsonrpc":"1.0","id":1,"method":"ping"}'],
  ['missing method', '{"jsonrpc":"2.0","id":1}'],
  ['null identifier', request('ping', {}, null)],
  ['object identifier', request('ping', {}, { value: 'PRIVATE_INPUT' })],
  ['negative identifier', request('ping', {}, -1)],
  ['unsafe integer identifier', request('ping', {}, Number.MAX_SAFE_INTEGER + 1)],
  ['fractional identifier', request('ping', {}, 1.25)],
  ['unbounded identifier', request('ping', {}, 'x'.repeat(129))],
  ['unknown top-level fields', '{"jsonrpc":"2.0","id":1,"method":"ping","command":"PRIVATE_INPUT"}'],
  ['top-level prototype field', '{"jsonrpc":"2.0","id":1,"method":"ping","__proto__":{"x":1}}'],
  ['fixture arguments omitted', request('tools/call', { name: TOOL_NAME })],
  ['fixture arguments null', request('tools/call', { name: TOOL_NAME, arguments: null })],
  ['fixture arguments array', request('tools/call', { name: TOOL_NAME, arguments: [] })],
  ['fixture arguments string', request('tools/call', { name: TOOL_NAME, arguments: 'PRIVATE_INPUT' })],
  ['file path argument', request('tools/call', { name: TOOL_NAME, arguments: { path: 'PRIVATE_INPUT' } })],
  ['shell command argument', request('tools/call', { name: TOOL_NAME, arguments: { command: 'PRIVATE_INPUT' } })],
  ['network URL argument', request('tools/call', { name: TOOL_NAME, arguments: { url: 'https://PRIVATE_INPUT.invalid/' } })],
  ['nested arbitrary arguments', request('tools/call', { name: TOOL_NAME, arguments: { nested: { data: 'PRIVATE_INPUT' } } })],
  ['prototype fixture argument', `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${TOOL_NAME}","arguments":{"__proto__":{}}}}`],
  ['extra call parameter', request('tools/call', { name: TOOL_NAME, arguments: {}, path: 'PRIVATE_INPUT' })],
  ['different fixture spelling', request('tools/call', { name: 'Diagnostics_roundtrip', arguments: {} })],
  ['parameterized ping', request('ping', { command: 'PRIVATE_INPUT' })],
  ['tool list cursor', request('tools/list', { cursor: 'PRIVATE_INPUT' })],
  ['initialize extra host parameter', request('initialize', { workspace: 'PRIVATE_INPUT' })],
  ['initialize non-object capabilities', request('initialize', { capabilities: [] })],
];
for (const [name, text] of rejectedFrames) test(`rejects ${name}`, () => deny(text));

for (const name of ['portal_exec', 'portal_process', 'portal_file_read', 'portal_file_write', 'portal_file_edit', 'portal_file_list', 'portal_search', 'portal_screenshot', 'portal_web_fetch', 'portal_web_search', 'portal_oauth_authorize', 'portal_tools_reload', 'portal_kit_usage', 'custom_tool']) {
  test(`never dispatches ${name}`, () => deny(request('tools/call', { name, arguments: {} })));
}

test('unknown methods and resource requests have fixed errors without echoing input', () => {
  for (const method of ['resources/read', 'prompts/get', 'sampling/createMessage', 'PRIVATE_INPUT']) {
    const outcome = deny(request(method, {}));
    assert.equal(outcome.response.error.message, 'Method not permitted.');
  }
});

test('notifications never execute the diagnostic tool and never receive a response', () => {
  const text = JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: TOOL_NAME, arguments: {} } });
  assert.equal(deny(text).response, null);
  assert.equal(deny('{"jsonrpc":"2.0","method":"notifications/initialized"}').response, null);
});

test('UTF-8 byte limit is enforced before parsing and covers multibyte input', () => {
  assert.equal(deny('x'.repeat(MAX_MESSAGE_BYTES + 1)).category, 'oversize_rejected');
  const text = '中'.repeat(Math.ceil(MAX_MESSAGE_BYTES / 3));
  assert.ok(text.length < MAX_MESSAGE_BYTES);
  assert.equal(deny(text).category, 'oversize_rejected');
});

test('binary payloads are not coerced into JSON', () => {
  assert.equal(deny(Buffer.from(invoke())).category, 'non_text_rejected');
  assert.equal(deny(new ArrayBuffer(8)).category, 'non_text_rejected');
});

function harness() {
  const sockets = [];
  const events = [];
  const timeouts = new Map();
  const intervals = new Map();
  let nextTimer = 0;
  let now = 0;
  class FakeSocket extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; this.closes = []; sockets.push(this); }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    message(value) { this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' || value instanceof ArrayBuffer ? value : JSON.stringify(value) })); }
    send(text) { if (this.throwOnSend) throw new Error('PRIVATE_TRANSPORT_BODY'); this.sent.push(JSON.parse(text)); }
    close(code, reason) { this.readyState = 3; this.closes.push({ code, reason }); this.dispatchEvent(new Event('close')); }
  }
  const adapter = new FixtureAdapter({
    WebSocketImpl: FakeSocket,
    onEvent: (event) => events.push(event),
    clock: () => now,
    timers: {
      setTimeout: (callback) => { const id = ++nextTimer; timeouts.set(id, callback); return id; },
      clearTimeout: (id) => timeouts.delete(id),
      setInterval: (callback) => { const id = ++nextTimer; intervals.set(id, callback); return id; },
      clearInterval: (id) => intervals.delete(id),
    },
  });
  const connect = (overrides = {}) => adapter.connect({ relayUrl: 'wss://fixture.invalid/_relay', beingId: 'fixture-test', loomToken: 'PRIVATE_TEST_TOKEN', portalName: 'desktop-diagnostics', ...overrides });
  const ready = async () => { const connected = connect(); sockets.at(-1).open(); sockets.at(-1).message({ ok: true, relay_keepalive: 'text-v1' }); await connected; return sockets.at(-1); };
  return { adapter, sockets, events, timeouts, intervals, connect, ready, advance: (milliseconds) => { now += milliseconds; }, tick: () => { for (const callback of [...intervals.values()]) callback(); } };
}

test('module and adapter construction never initiate transport or expose credentials', () => {
  const fixture = harness();
  assert.equal(fixture.sockets.length, 0);
  assert.deepEqual(Object.keys(fixture.adapter), []);
  assert.equal(fixture.adapter.state.status, 'idle');
});

test('relay credentials appear only in the outbound handshake, never endpoint or events', async () => {
  const fixture = harness();
  const socket = await fixture.ready();
  assert.equal(socket.url, 'wss://fixture.invalid/_relay');
  assert.deepEqual(socket.sent[0], { being_id: 'fixture-test', loom_token: 'PRIVATE_TEST_TOKEN', portal_name: 'desktop-diagnostics' });
  assert.ok(!JSON.stringify({ events: fixture.events, state: fixture.adapter.state, adapter: fixture.adapter }).includes('PRIVATE_TEST_TOKEN'));
  await fixture.adapter.stop();
});

test('handshake is mandatory before processing MCP calls', async () => {
  const fixture = harness();
  const connected = fixture.connect();
  const socket = fixture.sockets[0];
  socket.open();
  socket.message(invoke());
  await assert.rejects(connected, /did not complete/);
  assert.equal(fixture.adapter.state.counters.fixtureExecutions, 0);
  assert.equal(fixture.adapter.state.status, 'error');
  assert.equal(socket.sent.length, 1);
});

test('handshake strictly requires true and the negotiated text keepalive mode', async () => {
  for (const handshake of [{ ok: 'true', relay_keepalive: 'text-v1' }, { ok: true }, { ok: false }, { ok: true, relay_keepalive: 'text-v1', method: 'tools/call' }]) {
    const fixture = harness();
    const connected = fixture.connect();
    fixture.sockets[0].open();
    fixture.sockets[0].message(handshake);
    await assert.rejects(connected);
    assert.equal(fixture.intervals.size, 0);
    assert.equal(fixture.timeouts.size, 0);
  }
});

test('one valid fixture request increments processing and queued-response counters exactly once', async () => {
  const fixture = harness();
  const socket = await fixture.ready();
  socket.message(request('tools/list'));
  socket.message(request('ping'));
  assert.equal(fixture.adapter.state.counters.fixtureExecutions, 0);
  socket.message(invoke());
  assert.equal(fixture.adapter.state.counters.fixtureExecutions, 1);
  assert.equal(fixture.adapter.state.counters.fixtureResponsesSent, 1);
  assert.deepEqual(fixture.adapter.state.lastFixture, { requestIdSha256: createHash('sha256').update('1').digest('hex'), processingCount: 1, responseQueued: true });
  assert.deepEqual(socket.sent.at(-1).result, { content: [{ type: 'text', text: FIXTURE_MARKER }], isError: false });
  socket.message(request('tools/call', { name: 'portal_exec', arguments: {} }));
  assert.equal(fixture.adapter.state.counters.fixtureExecutions, 1);
  assert.equal(fixture.adapter.state.counters.denied, 1);
  await fixture.adapter.stop();
});

test('no body, id, header or remote error content enters adapter events', async () => {
  const fixture = harness();
  const socket = await fixture.ready();
  socket.message(request('PRIVATE_INPUT', { command: 'PRIVATE_INPUT', Authorization: 'PRIVATE_INPUT' }, 'private-id'));
  socket.message(request('tools/call', { name: TOOL_NAME, arguments: { path: 'PRIVATE_INPUT' } }));
  socket.dispatchEvent(new Event('error'));
  const serialized = JSON.stringify({ events: fixture.events, state: fixture.adapter.state });
  assert.ok(!serialized.includes('PRIVATE_'));
  assert.ok(!serialized.includes('private-id'));
  assert.equal(fixture.timeouts.size, 0);
  assert.equal(fixture.intervals.size, 0);
});

test('handshake timeout is deterministic and leaves no timers', async () => {
  const fixture = harness();
  const connected = fixture.connect();
  for (const callback of [...fixture.timeouts.values()]) callback();
  await assert.rejects(connected);
  assert.equal(fixture.adapter.state.lastEvent, 'handshake_timeout');
  assert.equal(fixture.timeouts.size, 0);
  assert.equal(fixture.intervals.size, 0);
});

test('heartbeat emits only protocol keepalive and stale liveness closes without reconnect', async () => {
  const fixture = harness();
  const socket = await fixture.ready();
  fixture.advance(15000);
  fixture.tick();
  assert.deepEqual(socket.sent.at(-1), { type: 'keepalive' });
  fixture.advance(75001);
  fixture.tick();
  assert.equal(fixture.adapter.state.status, 'disconnected');
  assert.equal(fixture.adapter.state.lastEvent, 'heartbeat_timeout');
  assert.equal(fixture.sockets.length, 1);
  assert.equal(fixture.intervals.size, 0);
});

test('mixed keepalive and MCP frames are rejected instead of executed or extending liveness', async () => {
  const fixture = harness();
  const socket = await fixture.ready();
  fixture.advance(85000);
  socket.message({ type: 'keepalive_ack', jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL_NAME, arguments: {} } });
  fixture.advance(5001);
  fixture.tick();
  assert.equal(fixture.adapter.state.counters.fixtureExecutions, 0);
  assert.equal(fixture.adapter.state.status, 'disconnected');
});

test('stopping is idempotent and late socket messages cannot reactivate processing', async () => {
  const fixture = harness();
  const socket = await fixture.ready();
  await fixture.adapter.stop();
  await fixture.adapter.stop();
  socket.message(invoke());
  socket.message({ ok: true, relay_keepalive: 'text-v1' });
  assert.equal(socket.closes.length, 1);
  assert.equal(fixture.adapter.state.status, 'stopped');
  assert.equal(fixture.adapter.state.counters.fixtureExecutions, 0);
  assert.equal(fixture.intervals.size, 0);
});

test('active sockets cannot be replaced by a second connect call', async () => {
  const fixture = harness();
  await fixture.ready();
  await assert.rejects(fixture.connect(), /already active/);
  assert.equal(fixture.sockets.length, 1);
  await fixture.adapter.dispose();
});

test('transport rejects credential URLs, insecure remote URLs and production Portal names before connection', async () => {
  const fixture = harness();
  for (const relayUrl of ['wss://fixture.invalid/_relay?token=PRIVATE_INPUT', 'wss://user:pass@fixture.invalid/_relay', 'ws://remote.invalid/_relay', 'https://fixture.invalid/_relay', 'wss://fixture.invalid/wrong']) await assert.rejects(fixture.connect({ relayUrl }));
  for (const portalName of ['cz-win', 'portal', '', 'desktop-diagnostics with spaces']) await assert.rejects(fixture.connect({ portalName }));
  assert.equal(fixture.sockets.length, 0);
});

test('binary and oversized transport frames close without fixture execution', async () => {
  for (const payload of [new ArrayBuffer(10), 'x'.repeat(MAX_MESSAGE_BYTES + 1)]) {
    const fixture = harness();
    const socket = await fixture.ready();
    socket.message(payload);
    assert.equal(fixture.adapter.state.status, 'error');
    assert.equal(fixture.adapter.state.counters.fixtureExecutions, 0);
  }
});

test('short-message floods stop at a bounded received count', async () => {
  const fixture = harness();
  const socket = await fixture.ready();
  for (let index = 0; index < MAX_MESSAGES + 10; index++) socket.message(request('ping'));
  assert.equal(fixture.adapter.state.lastEvent, 'message_limit_reached');
  assert.equal(fixture.adapter.state.counters.received, MAX_MESSAGES + 1);
  assert.equal(fixture.adapter.state.counters.fixtureExecutions, 0);
});

test('response send failure cannot claim a marker was queued successfully', async () => {
  const fixture = harness();
  const socket = await fixture.ready();
  socket.throwOnSend = true;
  socket.message(invoke());
  assert.equal(fixture.adapter.state.status, 'error');
  assert.equal(fixture.adapter.state.counters.fixtureExecutions, 1);
  assert.equal(fixture.adapter.state.counters.fixtureResponsesSent, 0);
  assert.equal(fixture.adapter.state.lastFixture.responseQueued, false);
  assert.equal(fixture.adapter.state.lastEvent, 'send_failed');
  assert.ok(!JSON.stringify(fixture.events).includes('PRIVATE_TRANSPORT_BODY'));
});

test('output backpressure does not permit unbounded queues', async () => {
  const fixture = harness();
  const socket = await fixture.ready();
  socket.bufferedAmount = 65537;
  socket.message(request('ping'));
  assert.equal(fixture.adapter.state.status, 'error');
  assert.equal(fixture.adapter.state.counters.responsesSent, 0);
});

test('fixture correlation records only a typed request-id digest and defensive metadata', async () => {
  const fixture = harness();
  const socket = await fixture.ready();
  socket.message(request('tools/call', { name: TOOL_NAME, arguments: {} }, 'private-run-id'));
  const state = fixture.adapter.state;
  assert.equal(state.lastFixture.requestIdSha256, createHash('sha256').update(JSON.stringify('private-run-id')).digest('hex'));
  assert.ok(!JSON.stringify({ state, events: fixture.events }).includes('private-run-id'));
  state.lastFixture.responseQueued = false;
  assert.equal(fixture.adapter.state.lastFixture.responseQueued, true);
  await fixture.adapter.stop();
});

test('native Node WebSocket completes a fixed fixture call through the loopback relay', { timeout: 15000 }, async (t) => {
  const { LoopbackRelay, frame, until } = require('./integration/portal-loopback.cjs');
  const relay = new LoopbackRelay('LOCAL_TEST_ONLY', { beingId: 'local-fixture', portalName: 'desktop-diagnostics' });
  const adapter = new FixtureAdapter();
  t.after(async () => { await adapter.stop(); await relay.pause(); });
  await relay.listen();
  await adapter.connect({ relayUrl: `ws://127.0.0.1:${relay.port}/_relay`, beingId: 'local-fixture', loomToken: 'LOCAL_TEST_ONLY', portalName: 'desktop-diagnostics' });
  await until(relay, () => relay.metadataReplies === 1, 'adapter metadata', 5000);
  assert.deepEqual(relay.toolNames, [TOOL_NAME]);
  const responseReceived = new Promise((resolve) => relay.on('rpc_response', (value) => { if (value.id === 'local-test-call') resolve(value); }));
  for (const socket of relay.sockets) socket.write(frame(1, request('tools/call', { name: TOOL_NAME, arguments: {} }, 'local-test-call')));
  const response = await responseReceived;
  assert.deepEqual(response, { jsonrpc: '2.0', id: 'local-test-call', result: { content: [{ type: 'text', text: FIXTURE_MARKER }], isError: false } });
  assert.equal(adapter.state.counters.fixtureExecutions, 1);
  assert.equal(adapter.state.counters.fixtureResponsesSent, 1);
  assert.equal(adapter.state.lastFixture.requestIdSha256, createHash('sha256').update(JSON.stringify('local-test-call')).digest('hex'));
});
