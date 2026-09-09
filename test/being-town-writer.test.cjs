'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {BeingTownWriter} = require('../src/being-town-writer.cjs');
const {TownSession} = require('../src/town-session.cjs');
const {parseConnection} = require('../src/security.cjs');
const connection = parseConnection('https://heart.example/alice/?token=private-test-token&api=https://heart.example/alice');
const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const json = value => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
const request = change => ({kind: 'bonfire', content: '原文\n保持不变', connectionRevision: 1, requestId: randomUUID(), ...change});
function fixture(change = {}, options = {}) {
  const context = {connection, connected: true, beingName: 'alice', connectionId: 1, identityRevision: 1};
  const calls = [], payloads = [], notices = [];
  const streamId = randomUUID();
  let events = [];
  let inspection = false;
  const writer = new BeingTownWriter({getContext: () => context, onRequest: notice => notices.push(notice), fetchImpl: async (url, init) => {
    calls.push({url, init});
    if (init.method === 'GET') {
      if (inspection) return json({stream_id: change.wrongStream ? randomUUID() : streamId, finished: true, events: events.map(([event, data], index) => ({seq: index + 1, event, data}))});
      return change.busy ? json({finished: false}) : new Response(null, {status: 204});
    }
    const prompt = JSON.parse(init.body).message;
    const input = JSON.parse(prompt.match(/原生 http 工具：(.*?)。不添加/s)[1]);
    payloads.push(input);
    if (input.method === 'GET') {
      if (change.identityError) throw Error('preflight network error');
      const data = {being: change.identity || 'alice', mentions: [], latest_id: 0};
      const summary = JSON.stringify({body: JSON.stringify(data), headers: {long: 'x'.repeat(200)}}).slice(0, 120);
      const raw = event('tool_use', {name: 'http', input}) + event('tool_result', {name: 'http', is_error: false, summary}) + event('message_stop', {});
      if (change.beforeWrite) change.beforeWrite(context);
      return new Response(raw, {headers: {'content-type': 'text/event-stream'}});
    }
    if (change.writeError) throw Error('network lost after send');
    const body = {ok: true, seq: 17, being: 'alice', mentions: [], ...change.receipt};
    events = [
      ['meta', {stream_id: streamId}],
      ['tool_use', {id: 'call-1', name: 'http', input: {...input, ...change.input}}],
      ['tool_result', {tool_use_id: 'call-1', name: 'http', is_error: false, summary: JSON.stringify({body: JSON.stringify(body)}), ...change.result}],
      ['message_stop', {}],
    ];
    if (change.noTool) events = [['content_block_delta', {delta: {text: JSON.stringify(body)}}], ['message_stop', {}]];
    if (change.extraTool) events.splice(3, 0, ['tool_use', {name: 'http', input}]);
    if (change.afterWrite) await change.afterWrite(context);
    if (change.accepted) return new Response(null, {status: 202});
    return new Response((change.partial ? events.slice(0, -1) : events).map(([name, data]) => event(name, data)).join(''), {headers: {'content-type': 'text/event-stream'}});
  }, ...options});
  return {writer, calls, payloads, notices, context, inspect: () => { inspection = true; }, complete: () => { change.partial = false; }};
}

for (const kind of ['bonfire', 'fireside']) test(`${kind}: native identity check precedes a single publication with exact content and bound room`, async () => {
  const f = fixture(); const value = request({kind, ...(kind === 'fireside' ? {firesideId: '83'} : {})});
  const result = await f.writer.send(value);
  assert.deepEqual(result, {ok: true, id: '17', mentions: [], requestId: value.requestId});
  assert.deepEqual(f.payloads.map(input => input.method), ['GET', 'POST']);
  assert.equal(f.payloads[1].url, `https://beings.town/api/${kind}/speak`);
  assert.deepEqual(f.payloads[1].body, {message: value.content, ...(kind === 'fireside' ? {fireside_id: 83} : {})});
  assert(f.calls.every(call => new URL(call.url).origin === 'https://heart.example'));
  assert(f.notices.every(notice => !notice.prompt.includes(connection.token)));
});

for (const change of [{busy: true}, {identity: 'somebody-else'}, {identityError: true}, {beforeWrite: context => { context.connectionId++; }}]) test(`preflight stops publication: ${Object.keys(change)[0]}`, async () => {
  const f = fixture(change);
  await assert.rejects(f.writer.send(request()), {code: 'NOT_SENT'});
  assert(!f.payloads.some(input => input.method === 'POST'));
});

for (const [name, change] of Object.entries({
  'lost response': {writeError: true}, 'accepted only': {accepted: true}, 'model prose': {noTool: true},
  'missing completion': {partial: true}, 'different identity': {receipt: {being: 'bob'}}, 'missing message number': {receipt: {seq: null}},
  'altered content': {input: {body: {message: 'changed'}}}, 'wrong destination': {input: {url: 'https://beings.town/api/fireside/speak'}},
  'injected headers': {input: {headers: {Authorization: 'fake'}}}, 'mismatched tool result': {result: {tool_use_id: 'another-call'}},
  'extra publication': {extraTool: true}, 'truncated body': {result: {summary: '{"body":"{\\"ok\\":true,\\"seq\\":17'}},
  'HTTP rejection': {result: {summary: JSON.stringify({status: 403, body: {ok: true, seq: 17, being: 'alice', mentions: []}})}},
  'error result': {result: {is_error: true}},
})) test(`${name} never becomes success and repeating the draft never posts again`, async () => {
  const f = fixture(change); const value = request();
  await assert.rejects(f.writer.send(value), {code: 'RESULT_UNKNOWN'});
  await assert.rejects(f.writer.send({...value, requestId: randomUUID()}), {code: 'RESULT_UNKNOWN'});
  assert.equal(f.payloads.filter(input => input.method === 'POST').length, 1);
});

test('native complete body is accepted even if only later response headers are truncated', async () => {
  const summary = JSON.stringify({body: JSON.stringify({being: 'alice', mentions: [], ok: true, seq: 21}), headers: {value: 'x'.repeat(200)}}).slice(0, 120);
  const f = fixture({result: {summary}});
  assert.equal((await f.writer.send(request())).id, '21');
});

test('uncertain request can recover only from its original complete native stream, with no new prompt', async () => {
  const f = fixture({partial: true}); const value = request();
  await assert.rejects(f.writer.send(value), {code: 'RESULT_UNKNOWN'});
  f.inspect();
  assert.equal((await f.writer.send(value)).id, '17');
  assert.equal(f.payloads.length, 2);
  assert.equal((await f.writer.send(value)).id, '17');
  assert.equal(f.payloads.length, 2);
});

test('a replacement stream cannot confirm an older pending send', async () => {
  const f = fixture({partial: true, wrongStream: true}); const value = request();
  await assert.rejects(f.writer.send(value), {code: 'RESULT_UNKNOWN'}); f.inspect();
  await assert.rejects(f.writer.send(value), {code: 'RESULT_UNKNOWN'});
  assert.equal(f.payloads.length, 2);
});

test('pending journal survives restart without storing content or credentials', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'town-send-test-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const journalPath = path.join(directory, 'journal.json');
  const value = request();
  await assert.rejects(fixture({writeError: true}, {journalPath}).writer.send(value), {code: 'RESULT_UNKNOWN'});
  const raw = await fs.readFile(journalPath, 'utf8');
  assert(!raw.includes(value.content)); assert(!raw.includes(connection.token)); assert(!raw.includes(connection.url));
  const restarted = fixture({}, {journalPath});
  await assert.rejects(restarted.writer.send({...value, requestId: randomUUID()}), {code: 'RESULT_UNKNOWN'});
  assert.equal(restarted.payloads.length, 0);
  assert.equal((await fs.stat(journalPath)).mode & 0o777, 0o600);
});

test('corrupt persistence stops a new send before any network activity', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'town-send-test-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const journalPath = path.join(directory, 'journal.json'); await fs.writeFile(journalPath, '{broken');
  const f = fixture({}, {journalPath});
  await assert.rejects(f.writer.send(request()), {code: 'NOT_SENT'}); assert.equal(f.calls.length, 0);
});

test('double clicks cannot dispatch a concurrent operation', async () => {
  let release, entered; const ready = new Promise(resolve => { entered = resolve; });
  const f = fixture({afterWrite: async () => { entered(); await new Promise(resolve => { release = resolve; }); }});
  const first = f.writer.send(request()); await ready;
  await assert.rejects(f.writer.send(request()), {code: 'NOT_SENT'}); release();
  assert.equal((await first).ok, true);
  assert.equal(f.payloads.length, 2);
});

test('identity switch after dispatch leaves the old operation uncertain', async () => {
  const f = fixture({afterWrite: context => { context.connectionId++; }});
  await assert.rejects(f.writer.send(request()), {code: 'RESULT_UNKNOWN'});
});

test('rotating credentials for the same Being does not bypass pending-send protection', async () => {
  const f = fixture({writeError: true}); const value = request();
  await assert.rejects(f.writer.send(value), {code: 'RESULT_UNKNOWN'});
  f.context.connection = parseConnection(connection.url.replace('private-test-token', 'rotated-test-token'));
  await assert.rejects(f.writer.send({...value, requestId: randomUUID()}), {code: 'RESULT_UNKNOWN'});
  assert.equal(f.payloads.filter(input => input.method === 'POST').length, 1);
});

test('presentation callback failures cannot change a verified send or trigger another dispatch', async () => {
  const f = fixture({}, {onChange: () => {throw Error('render failed');}, onRequest: () => {throw Error('history failed');}});
  assert.equal((await f.writer.send(request())).ok, true);
  assert.equal(f.payloads.length, 2);
});

test('network fallback is selected by a read before any chat POST; a lost POST never falls back', async () => {
  const f = fixture(); const fallbackCalls = [];
  const network = f.writer.fetchImpl;
  f.writer.fetchImpl = async () => { throw Error('primary unavailable'); };
  f.writer.fallbackFetchImpl = async (...args) => { fallbackCalls.push(args[1].method); return network(...args); };
  assert.equal((await f.writer.send(request())).ok, true);
  assert.deepEqual(fallbackCalls, ['GET', 'POST', 'GET', 'POST']);
  let fallback = 0; const lost = fixture({writeError: true}, {fallbackFetchImpl: async () => { fallback++; }});
  await assert.rejects(lost.writer.send(request()), {code: 'RESULT_UNKNOWN'});
  assert.equal(fallback, 0);
});

test('Bonfire session routes sends through Being without probing desktop IP Trust', async () => {
  const writes = [], reads = [];
  const session = new TownSession({getContext: () => ({configured: true, connected: true, connectionId: 1, identityRevision: 1, beingName: 'alice'}),
    fetchImpl: async url => { reads.push(url); throw Error('Unexpected direct request'); },
    writeImpl: async value => { writes.push(value); return {ok: true, id: '99'}; }});
  const value = {content: '  原文\n', mentions: [], connectionRevision: 1, requestId: randomUUID()};
  assert.equal((await session.sendBonfireMessage(value)).ok, true);
  assert.equal(writes[0].content, value.content); assert.equal(writes[0].requestId, value.requestId); assert.deepEqual(reads, []);
});
