'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {BeingTownReader} = require('../src/being-town-reader.cjs');
const {relaySource} = require('../src/town-result-source.cjs');
const {messagesDto} = require('../src/town-session.cjs');
const {parseConnection} = require('../src/security.cjs');

const SECRET = 'only-for-loom-test-token';
const CONNECTION = parseConnection(`https://heart.example/cz_being/?token=${SECRET}&api=https://heart.example/cz_being`);
const ROUTE = '/api/bonfire/hear';
const RAW = {ok: true, being: 'cz_being', messages: [{seq: 9, being: 'other', message: 'hello'}], global_latest_seq: 9};
const idle = () => new Response(null, {status: 204});
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
function requestInfo(options) {
  const message = JSON.parse(options.body).message;
  return {message, requestId: message.match(/^\[Being Desktop Town sync:([^\]]+)\]/)[1], route: message.match(/读取路线：([^。]+)。/)[1], target: message.match(/HTTP GET：(https:\/\/[^，]+)/)[1]};
}
function stream(options, change = {}) {
  const info = requestInfo(options);
  const envelope = {protocol: 'being-town-agent-read/1', requestId: info.requestId, route: info.route, beingId: 'cz_being', httpStatus: 200, data: RAW, ...change.envelope};
  const input = {method: 'GET', url: info.target, ...change.input};
  let content = '';
  if (!change.noTool) {
    content += event('tool_use', {name: change.name || 'http', input: JSON.stringify(input), ...change.use});
    if (!change.noResult) content += event('tool_result', {name: 'http', is_error: false, summary: '{"status":200,"body":{"messages":[ ... truncated', ...change.result});
  }
  content += event('content_block_delta', {delta: {text: change.reply ?? JSON.stringify(envelope)}});
  if (!change.noStop) content += event('message_stop', {});
  content += change.suffix || '';
  if (change.crlf) content = content.replace(/\n/g, '\r\n');
  let body = content;
  if (change.chunked) {
    const bytes = new TextEncoder().encode(content);
    let offset = 0;
    body = new ReadableStream({pull(controller) { if (offset >= bytes.length) controller.close(); else { controller.enqueue(bytes.slice(offset, offset + 7)); offset += 7; } }});
  }
  return new Response(body, {status: 200, headers: {'Content-Type': 'text/event-stream; charset=utf-8'}});
}
function fixture(overrides = {}, change = {}) {
  const calls = [], requests = [], mirrorCalls = [];
  let connection = CONNECTION;
  const toolResults = {
    prepare: async record => { mirrorCalls.push({method: 'prepare', record}); },
    read: async record => { mirrorCalls.push({method: 'read', record}); return {protocol: 'being-town-tool-result/1', requestId: record.requestId, route: record.route, beingId: record.beingId, httpStatus: 200, data: RAW, ...change.envelope}; },
    release: async record => { mirrorCalls.push({method: 'release', record}); },
  };
  const reader = new BeingTownReader({getConnection: () => connection, fetchImpl: async (url, options) => { calls.push({url, options}); return options.method === 'GET' ? idle() : stream(options, change); }, onRequest: record => requests.push(record), toolResults, ...overrides});
  return {reader, calls, requests, mirrorCalls, setConnection: value => { connection = value; }};
}

function relayFixture(change = {}, options = {}) {
  const data = {ok: true, messages: [{seq: 9, being: 'other', message: '<script>untrusted message</script>', at: '2026-09-09T17:00:00+08:00', revised_at: null}], global_latest_seq: 9, returned: 1, total_count: 1};
  const reader = new BeingTownReader({getConnection: () => CONNECTION, allowBonfireRelay: true, fetchImpl: async (_url, init) => {
    if (init.method === 'GET') return idle();
    const info = requestInfo(init);
    const envelope = {protocol: 'being-town-relay/1', requestId: info.requestId, route: info.route, beingId: 'cz_being', httpStatus: 200, data, ...change.envelope};
    return stream(init, {reply: JSON.stringify(envelope), ...change, result: {summary: JSON.stringify({body: JSON.stringify(data)}).slice(0, 120), ...change.result}});
  }, ...options});
  return {reader, data};
}

test('Bonfire compatibility mode transfers a real read with explicit unverified provenance', async () => {
  const {LocalTownResults} = require('../src/local-town-results.cjs');
  const {reader, data} = relayFixture({}, {toolResults: new LocalTownResults({getConfig: () => null})});
  const result = await reader.read(ROUTE, {query: {limit: 10}});
  assert.deepEqual(result, data);
  assert.equal(reader.state().lastRead.source, 'being_relay');
  assert.deepEqual(relaySource(result), {source: 'being_relay'});
  assert.equal(messagesDto(result).source, 'being_relay');
  assert.equal(messagesDto({...data, source: 'being_relay'}).source, undefined, 'remote fields cannot forge local provenance');
});

test('relay mode still prefers complete native results and trusted mirrors', async () => {
  for (const viaMirror of [false, true]) {
    const options = viaMirror ? {toolResults: {prepare: async () => {}, release: async () => {}, read: async item => ({protocol: 'being-town-tool-result/1', requestId: item.requestId, route: item.route, beingId: item.beingId, httpStatus: 200, data: RAW})}} : {};
    const {reader} = relayFixture(viaMirror ? {reply: 'bad prose'} : {result: {content: JSON.stringify({status: 200, body: RAW})}}, options);
    const result = await reader.read(ROUTE);
    assert.deepEqual(result, RAW);
    assert.equal(messagesDto(result).source, undefined);
    assert.equal(reader.state().lastRead.source, viaMirror ? 'tool_result_mirror' : 'tool_result');
  }
});

test('relay never accepts refusals, unrelated tools, failed reads or partial streams', async () => {
  for (const change of [{noTool: true}, {noResult: true}, {noStop: true}, {name: 'portal_exec'}, {input: {url: 'https://example.com/'}}, {result: {summary: 'unrelated summary'}}, {result: {is_error: true}}, {result: {content: JSON.stringify({status: 401, body: {}})}}, {reply: '失败'}, {envelope: {requestId: 'different'}}, {envelope: {beingId: 'alice'}}]) {
    const {reader} = relayFixture(change);
    await assert.rejects(reader.read(ROUTE));
    assert.equal(reader.state().lastRead, null);
  }
});

test('relay rejects missing, duplicated, truncated, out-of-window and credential-bearing messages', async () => {
  const {data} = relayFixture();
  const bad = [
    {...data, returned: 2}, {...data, total_count: 0}, {...data, total_count: 2}, {...data, truncated: true},
    {...data, messages: [...data.messages, ...data.messages], returned: 2},
    {...data, messages: [{...data.messages[0], seq: 10}]},
    {...data, messages: [{...data.messages[0], at: 'not-a-date'}]},
    {...data, messages: [{...data.messages[0], message: SECRET}]},
    {...data, messages: [{...data.messages[0], full_length: 5000}]},
    {...data, messages: [{...data.messages[0], message: 'a'.repeat(4001)}]},
  ];
  for (const value of bad) {
    const {reader} = relayFixture({envelope: {data: value}});
    await assert.rejects(reader.read(ROUTE, {query: {limit: 10}}));
    assert.equal(reader.state().lastRead, null);
  }
});

test('live Town contract allows absent revised_at on unedited messages', async () => {
  const {data} = relayFixture();
  delete data.messages[0].revised_at;
  const {reader} = relayFixture({envelope: {data}});
  const result = await reader.read(ROUTE, {query: {limit: 3}});
  assert.equal(messagesDto(result).messages[0].revisedAt, '');
  assert.equal(messagesDto(result).source, 'being_relay');
});

test('a network failure during readiness selects fallback before sending a single POST', async () => {
  const primary = [], fallback = [];
  const {reader} = fixture({fetchImpl: async (_url, init) => { primary.push(init.method); throw new Error('net::ERR_CONNECTION_CLOSED'); }, fallbackFetchImpl: async (_url, init) => {
    fallback.push(init.method);
    return init.method === 'GET' ? idle() : stream(init, {result: {content: JSON.stringify({status: 200, body: RAW})}});
  }});
  assert.deepEqual(await reader.read(ROUTE), RAW);
  assert.deepEqual(primary, ['GET']);
  assert.deepEqual(fallback, ['GET', 'POST']);
});

test('fallback never retries POSTs or bypasses an HTTP readiness rejection', async () => {
  for (const mode of ['busy', 'auth', 'post']) {
    let fallbackCalls = 0, posts = 0;
    const {reader} = fixture({fetchImpl: async (_url, init) => {
      if (init.method === 'POST') { posts++; throw new Error('connection lost after dispatch'); }
      return mode === 'busy' ? json({finished: false}) : mode === 'auth' ? json({}, 401) : idle();
    }, fallbackFetchImpl: async () => { fallbackCalls++; return idle(); }});
    await assert.rejects(reader.read(ROUTE), {code: {busy:'BUSY', auth:'AUTH_REQUIRED', post:'SERVICE_ERROR'}[mode]});
    assert.equal(fallbackCalls, 0);
    assert.equal(posts, mode === 'post' ? 1 : 0);
  }
});

test('real Loom event shape: truncated summary requires the actual tool-result mirror', async () => {
  const {reader, calls, requests, mirrorCalls} = fixture({}, {chunked: true, crlf: true, reply: 'Completed.'});
  assert.deepEqual(await reader.read(ROUTE, {query: {limit: 100, compact: true}}), RAW);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).pathname, '/cz_being/api/stream/active');
  assert.equal(new URL(calls[1].url).pathname, '/cz_being/api/chat/stream');
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, 'https://heart.example');
    assert.equal(new URL(call.url).searchParams.get('token'), SECRET);
    assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.cache, 'no-store'); assert.equal(call.options.referrerPolicy, 'no-referrer');
  }
  const sent = JSON.parse(calls[1].options.body);
  assert.deepEqual(Object.keys(sent), ['message']);
  assert.equal(sent.message.includes(SECRET), false);
  assert.equal(sent.message.includes('/api/bonfire/mentions'), false);
  assert.equal(sent.message.includes('session_id'), false);
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(requests[0]).sort(), ['beingId', 'prompt', 'requestId', 'route']);
  assert.equal(requests[0].prompt, sent.message);
  assert.equal(reader.state().lastRead.source, 'tool_result_mirror');
  assert.deepEqual(mirrorCalls.map(call => call.method), ['prepare', 'read', 'release']);
  assert.deepEqual(Object.keys(mirrorCalls[0].record).sort(), ['beingId', 'query', 'requestId', 'route']);
  assert.deepEqual(mirrorCalls[0].record.query, {limit: '100', compact: 'true'});
  assert.equal(JSON.stringify(mirrorCalls).includes(SECRET), false);
  assert.equal(sent.message.includes('不要转述、复制或补全'), true);
});

test('complete tool_result has priority over model prose and supports tool IDs', async () => {
  const {reader} = fixture({}, {use: {id: 'native-1'}, result: {tool_use_id: 'native-1', content: JSON.stringify({status: 200, body: RAW})}, reply: 'Finished.'});
  assert.deepEqual(await reader.read(ROUTE), RAW);
  assert.equal(reader.state().lastRead.source, 'tool_result');
});

test('a completed refusal without native tools reports the missing read and never uses the mirror', async () => {
  const {reader, mirrorCalls} = fixture({}, {noTool: true, reply: '[Being Desktop Town sync:fixture] 失败。'});
  await assert.rejects(reader.read(ROUTE), error => error.code === 'TOWN_TOOL_NOT_CALLED' && error.message.includes('原生 http'));
  assert.equal(reader.state().lastRead, null);
  assert.deepEqual(mirrorCalls.map(call => call.method), ['prepare', 'release']);
});

test('successful native HTTP with only a Loom summary requires a configured full-result transport', async () => {
  const {LocalTownResults} = require('../src/local-town-results.cjs');
  const {reader} = fixture({toolResults: new LocalTownResults({getConfig: () => null})}, {reply: '已完成。'});
  await assert.rejects(reader.read(ROUTE), {code: 'RESULT_SOURCE_NOT_CONFIGURED'});
  assert.equal(reader.state().lastRead, null);
});

test('tagged success, failure and incomplete receipts remain presentation only; actual tools determine task outcomes', async () => {
  for (const [receipt, change, expectedCode] of [
    ['已完成。', {noTool:true}, 'TOWN_TOOL_NOT_CALLED'],
    ['失败。', {result:{content:JSON.stringify({status:500,body:{error:'upstream unavailable'}})}}, 'SERVICE_ERROR'],
    ['结果不完整。', {result:{content:JSON.stringify({status:200,truncated:true,body:RAW})}}, 'INCOMPLETE_RESULT'],
  ]) {
    let submitted;
    const {reader} = fixture({fetchImpl:async (_url, options) => {
      if (options.method === 'GET') return idle();
      submitted = requestInfo(options);
      const marker=`[Being Desktop Town sync:${submitted.requestId}]`;
      for (const outcome of ['已完成。','失败。','结果不完整。']) assert.ok(submitted.message.includes(`只回复 ${marker} ${outcome}`));
      assert.ok(submitted.message.includes('以上回执只能选择一条，不要附加解释或其他文字'));
      assert.match(submitted.message, /仅适用于本次读取请求/);
      return stream(options,{...change,reply:`${marker} ${receipt}`});
    }});
    await assert.rejects(reader.read(ROUTE),{code:expectedCode});
    assert.ok(submitted);
    assert.equal(reader.state().lastRead,null);
  }
});

test('all five route contracts return actual unmodified Town JSON through the tool mirror', async () => {
  for (const [route, query, data] of [
    [ROUTE, {}, RAW],
    ['/api/bonfire/mentions', {since_id: '9223372036854775807'}, {being: 'cz_being', mentions: []}],
    ['/api/fireside/list', {}, {owned: [], joined: []}],
    ['/api/fireside/members', {fireside_id: 2}, [{being: 'member'}]],
    ['/api/fireside/hear', {fireside_id: 2, since: 0, limit: 100}, {being: 'cz_being', messages: [], latest_seq: 0}],
  ]) {
    const {reader} = fixture({}, {envelope: {data}});
    assert.deepEqual(await reader.read(route, {query}), data);
  }
});

test('Scroll and resident reads require real bounded tool data and preserve exact pagination', async () => {
  const summary = {id: 'wer79LxF', being_id: 'cz_being', display_name: 'Being', title: 'A note', visibility: 'private', revision: 1};
  for (const [route, query, data] of [
    ['/api/scrolls', {offset: 0, limit: 50, visibility: 'private'}, {scrolls: [summary], total: 1, offset: 0, limit: 50}],
    ['/api/scrolls/wer79LxF', {offset: 10000, limit: 10000}, {...summary, content: '🧭', total_length: 10001, offset: 10000, limit: 10000, has_more: false}],
    ['/api/beings', {}, [{being_id: 'cz_being', display_name: 'Being', status: 'active'}]],
  ]) {
    const {reader, mirrorCalls} = fixture({}, {envelope: {data}});
    assert.deepEqual(await reader.read(route, {query}), data);
    assert.equal(mirrorCalls[0].record.route, route);
    assert.deepEqual(mirrorCalls[0].record.query, Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)])));
  }
  const incomplete = fixture({}, {envelope: {data: {...summary, content: 'part', total_length: 9000, offset: 0, limit: 10000, has_more: false}}});
  await assert.rejects(incomplete.reader.read('/api/scrolls/wer79LxF', {query: {limit: 10000}}), {code: 'INVALID_RESPONSE'});
});

test('library tool routes reject path injection, write endpoints, credentials and malformed limits before chat', async () => {
  const {reader, calls} = fixture();
  for (const [route, query] of [
    ['/api/scrolls/help', {}], ['/api/scrolls/search', {}], ['/api/scrolls/../beings', {}],
    ['/api/scrolls/a/comments', {}], ['/api/scrolls/a?token=x', {}],
    ['/api/scrolls', {token: SECRET}], ['/api/scrolls', {limit: 201}], ['/api/scrolls', {visibility: 'all'}],
    ['/api/scrolls', {offset: '01'}], ['/api/scrolls', {offset: 4294967296}],
    ['/api/scrolls/a', {limit: 10001}], ['/api/scrolls/a', {visibility: 'public'}],
    ['/api/beings', {limit: 200}], ['/api/beings/register', {}],
  ]) await assert.rejects(reader.read(route, {query}), {code: 'INVALID_REQUEST'});
  assert.equal(calls.length, 0);
});

test('invalid routes, write paths, pagination, getters and caller options never fetch', async () => {
  const {reader, calls} = fixture();
  for (const [route, options] of [
    ['https://evil.example/api/bonfire/hear', {}], ['/api/bonfire/speak', {}],
    [ROUTE, {query: {limit: 201}}], [ROUTE, {query: {since: -1}}], [ROUTE, {query: {limit: '01'}}],
    [ROUTE, {query: {token: SECRET}}], [ROUTE, {query: {get limit() { throw new Error('must not read'); }}}],
    [ROUTE, {headers: {Authorization: SECRET}}], [ROUTE, {signal: {aborted: false}}],
    [ROUTE, {onRequest:'untrusted-callback'}], [ROUTE, {get onRequest() {throw new Error('must not read');}}],
    ['/api/bonfire/mentions', {}], ['/api/bonfire/mentions', {query: {since_id: 0}}],
    ['/api/fireside/list', {query: {limit: 1}}], ['/api/fireside/hear', {query: {fireside_id: 0}}],
  ]) await assert.rejects(reader.read(route, options), {code: 'INVALID_REQUEST'});
  assert.equal(calls.length, 0);
});

test('known busy, unknown, malformed and failed active checks never submit chat', async () => {
  for (const [active, code] of [[json({finished:false}), 'BUSY'], ...[json({active: false}), json([]), new Response('<html>', {status: 200}), json({}, 500), new Error('private network detail')].map(value => [value, 'READINESS_UNKNOWN'])]) {
    let count = 0, callback = 0;
    const {reader} = fixture({onRequest: () => callback++, fetchImpl: async (_url, options) => { count++; assert.equal(options.method, 'GET'); if (active instanceof Error) throw active; return active; }});
    await assert.rejects(reader.read(ROUTE), {code});
    assert.equal(count, 1); assert.equal(callback, 0);
  }
});

test('local main runtime must be explicitly idle and cannot bypass fresh remote active check', async () => {
  for (const runtime of [{activeStream: {active: true}}, {}, null]) {
    const {reader, calls} = fixture({getRuntime: () => runtime});
    await assert.rejects(reader.read(ROUTE), {code: runtime?.activeStream?.active === true ? 'BUSY' : 'READINESS_UNKNOWN'}); assert.equal(calls.length, 0);
  }
  let count = 0;
  const {reader} = fixture({getRuntime: () => ({activeStream: {active: false}}), fetchImpl: async (_url, options) => { count++; return options.method === 'GET' ? json({finished: true}) : stream(options); }});
  assert.deepEqual(await reader.read(ROUTE), RAW); assert.equal(count, 2);
});

test('HTTP 202 records acceptance and pending reads only probe until a separate new read', async () => {
  for (const ready of [idle, () => json({finished: true})]) {
    let posts = 0, gets = 0, busy = false;
    const {reader, requests, mirrorCalls} = fixture({
      getRuntime: () => ({activeStream: {active: busy}}),
      fetchImpl: async (_url, options) => {
        if (options.method === 'GET') { gets++; return busy ? json({finished: false}) : ready(); }
        return ++posts === 1 ? json({accepted: true}, 202) : stream(options);
      },
    });
    await assert.rejects(reader.read(ROUTE), {code: 'REQUEST_ACCEPTED'});
    assert.equal(reader.state().pending, true);
    assert.equal(reader.state().lastRead, null);
    assert.deepEqual(mirrorCalls.map(call => call.method), ['prepare', 'release']);
    busy = true;
    await assert.rejects(reader.read(ROUTE), {code: 'REQUEST_ACCEPTED'});
    assert.equal(reader.state().pending, true);
    busy = false;
    await assert.rejects(reader.read(ROUTE), {code: 'REQUEST_ACCEPTED'});
    assert.equal(reader.state().pending, false);
    assert.equal(gets, 3); assert.equal(posts, 1); assert.equal(requests.length, 1);
    assert.deepEqual(await reader.read(ROUTE), RAW);
    assert.equal(gets, 4); assert.equal(posts, 2);
  }
});

test('accepted requests remain pending after unknown or failed active probes without another POST', async () => {
  let nextActive = idle, posts = 0;
  const {reader} = fixture({fetchImpl: async (_url, options) => options.method === 'GET' ? nextActive() : (posts++, json({accepted: true}, 202))});
  await assert.rejects(reader.read(ROUTE), {code: 'REQUEST_ACCEPTED'});
  for (const active of [() => json({active: false}), () => json({}, 500), () => { throw new Error('private upstream failure'); }]) {
    nextActive = active;
    await assert.rejects(reader.read(ROUTE), {code: 'REQUEST_ACCEPTED'});
    assert.equal(reader.state().pending, true); assert.equal(posts, 1);
  }
});

test('all reads queued before acceptance stay probe-only even after the pending request becomes idle', async () => {
  const gate = deferred(); let posts = 0, gets = 0;
  const {reader} = fixture({fetchImpl: async (_url, options) => {
    if (options.method === 'GET') { gets++; return idle(); }
    if (++posts > 1) return stream(options);
    await gate.promise; return json({accepted: true}, 202);
  }});
  const results = Promise.allSettled([reader.read(ROUTE), reader.read(ROUTE), reader.read(ROUTE), reader.read(ROUTE)]);
  await flush(); gate.resolve();
  for (const result of await results) {
    assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'REQUEST_ACCEPTED');
  }
  assert.equal(posts, 1); assert.equal(gets, 4); assert.equal(reader.state().pending, false);
  assert.deepEqual(await reader.read(ROUTE), RAW); assert.equal(posts, 2);
});

test('reset and connection replacement do not carry accepted state into a new connection', async () => {
  for (const reset of [true, false]) {
    let posts = 0;
    const instance = fixture({fetchImpl: async (_url, options) => options.method === 'GET' ? idle() : ++posts === 1 ? json({accepted: true}, 202) : stream(options)});
    await assert.rejects(instance.reader.read(ROUTE), {code: 'REQUEST_ACCEPTED'});
    if (reset) { instance.reader.reset(); assert.equal(instance.reader.state().pending, false); }
    else instance.setConnection(parseConnection(CONNECTION.url.replace(SECRET, 'replacement-token')));
    assert.deepEqual(await instance.reader.read(ROUTE), RAW);
    assert.equal(instance.reader.state().pending, false); assert.equal(posts, 2);
  }
});

test('unsupported injected background mode does not invent API fields or execute', async () => {
  const {reader, calls} = fixture({backgroundMode: () => 'backboard-unknown'});
  await assert.rejects(reader.read(ROUTE), {code: 'BACKGROUND_UNAVAILABLE'});
  assert.equal(calls.length, 0);
});

function acceptedFixture({poll, ...options} = {}) {
  const methods = [], released = [], prepared = [], progress = [];
  const instance = fixture({maxResultPolls: 3, pollDelay: async () => {}, ...options,
    fetchImpl: async (_url, init) => { methods.push(init.method); return init.method === 'GET' ? idle() : json({accepted:true}, 202); },
    toolResults: {
      prepare: async value => prepared.push(value), release: async value => released.push(value), read: async () => { throw new Error('Must poll accepted results'); },
      poll: async (value, settings) => poll(value, settings),
    },
  });
  return {...instance, methods, released, prepared, progress};
}
const acceptedEnvelope = (value, changes = {}) => ({protocol:'being-town-tool-result/1',requestId:value.requestId,route:value.route,beingId:value.beingId,httpStatus:200,data:RAW,...changes});

test('202 follows the original native GET result to completion without resending or releasing early', async () => {
  let checks = 0;
  const context = acceptedFixture({poll: async value => {
    assert.equal(context.released.length, 0);
    assert.equal(value.requestId, context.prepared[0].requestId);
    return ++checks === 3 ? acceptedEnvelope(value) : null;
  }});
  assert.deepEqual(await context.reader.read(ROUTE, {onProgress:value=>context.progress.push(value)}), RAW);
  assert.deepEqual(context.methods, ['GET', 'POST']);
  assert.deepEqual(context.progress.map(value=>value.checks), [1,2,3]);
  assert.equal(context.released.length, 1);
  assert.equal(context.reader.state().pending, false);
  assert.equal(context.reader.state().lastRead.source, 'tool_result_mirror');
});

test('202 result polling is bounded, preserves unresolved registration, and never fabricates completion', async () => {
  let checks = 0;
  const context = acceptedFixture({poll: async () => { checks++; return null; }});
  await assert.rejects(context.reader.read(ROUTE), {code:'RESULT_UNCONFIRMED'});
  assert.equal(checks, 3); assert.deepEqual(context.methods, ['GET','POST']);
  assert.equal(context.released.length, 0); assert.equal(context.reader.state().lastRead, null);
});

test('202 refuses stale identities, routes and truncated tool data instead of accepting a receipt', async () => {
  for (const [changes, code] of [[{requestId:'wrong'},'INVALID_RESPONSE'], [{beingId:'other'},'INVALID_RESPONSE'], [{route:'/api/fireside/list'},'INVALID_RESPONSE'], [{httpStatus:500},'SERVICE_ERROR'], [{data:{...RAW,truncated:true}},'INCOMPLETE_RESULT']]) {
    const context = acceptedFixture({poll: async value => acceptedEnvelope(value, changes)});
    await assert.rejects(context.reader.read(ROUTE), {code});
    assert.equal(context.reader.state().lastRead, null);
    assert.deepEqual(context.methods, ['GET','POST']);
  }
});

test('ending accepted tracking aborts polling, cleans the registration and ignores a late result', async () => {
  const gate = deferred(), started = deferred();
  let captured;
  const context = acceptedFixture({poll: async value => {captured=value;started.resolve();return gate.promise;}});
  const promise = context.reader.read(ROUTE);
  await started.promise;
  assert.equal(context.reader.stopTracking('wrong'), false);
  assert.equal(context.reader.stopTracking(captured.requestId), true);
  await assert.rejects(promise,{code:'ABORTED'});
  gate.resolve(acceptedEnvelope(captured)); await flush();
  assert.equal(context.released.length,1);assert.equal(context.reader.state().lastRead,null);
  assert.deepEqual(context.methods,['GET','POST']);
});

test('an expired accepted result registration requests reconciliation instead of claiming execution failure', async () => {
  const context=acceptedFixture({poll:async()=>{throw Object.assign(new Error('private result transport'),{code:'RESULT_SOURCE_UNAVAILABLE'});}});
  await assert.rejects(context.reader.read(ROUTE),{code:'RESULT_UNCONFIRMED'});
  assert.equal(context.reader.state().lastRead,null);assert.deepEqual(context.methods,['GET','POST']);
});

test('plain model output without a real matching http witness cannot become Town state', async () => {
  for (const change of [{noTool: true}, {noResult: true}, {name: 'shell'}, {input: {method: 'POST'}}, {input: {url: 'https://evil.example/api/bonfire/hear'}}, {input: {headers: {Authorization: 'secret'}}}, {input: {body: '{}'}}, {use: {id: 'a'}, result: {tool_use_id: 'b'}}]) {
    const {reader} = fixture({}, change);
    await assert.rejects(reader.read(ROUTE), {code: change.noTool ? 'TOWN_TOOL_NOT_CALLED' : 'INVALID_RESPONSE'});
  }
});

test('mirror request marker, route and Being envelope must match the submitted task', async () => {
  for (const envelope of [{requestId: 'old'}, {route: '/api/fireside/list'}, {beingId: 'other'}, {protocol: 'unknown'}, {httpStatus: '200'}, {unexpected: true}]) {
    const {reader} = fixture({}, {envelope});
    await assert.rejects(reader.read(ROUTE), {code: 'INVALID_RESPONSE'});
  }
});

test('raw Being identity mismatch is rejected for both tool data and mirror data', async () => {
  for (const change of [{envelope: {data: {...RAW, being: 'someone_else'}}}, {result: {content: JSON.stringify({status: 200, body: {...RAW, being: 'someone_else'}})}}]) {
    const {reader} = fixture({}, change);
    await assert.rejects(reader.read(ROUTE), {code: 'IDENTITY_MISMATCH'});
  }
});

test('truncated tool result and well-formed model JSON never become a successful snapshot', async () => {
  const {reader} = fixture({toolResults: null});
  await assert.rejects(reader.read(ROUTE, {query: {limit: 1}}), {code: 'INCOMPLETE_RESULT'});
  assert.equal(reader.state().lastRead, null);
  const bodyWithoutStatus = fixture({toolResults: null}, {result: {content: JSON.stringify(RAW)}});
  await assert.rejects(bodyWithoutStatus.reader.read(ROUTE), {code: 'INCOMPLETE_RESULT'});
});

test('actual tool or mirror HTTP error statuses are honored without using model claims', async () => {
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'AUTH_REQUIRED'], [429, 'RATE_LIMITED'], [500, 'SERVICE_ERROR']]) {
    const full = fixture({}, {result: {content: JSON.stringify({status, body: {error: SECRET}})}});
    await assert.rejects(full.reader.read(ROUTE), {code});
    const truncated = fixture({}, {result: {is_error: true}, envelope: {httpStatus: status, data: {error: SECRET}}});
    await assert.rejects(truncated.reader.read(ROUTE), {code});
  }
  const {reader} = fixture({}, {result: {is_error: true}});
  await assert.rejects(reader.read(ROUTE), {code: 'SERVICE_ERROR'});
});

test('HTTP and SSE failures return fixed local text without response body, URL or token', async () => {
  for (const response of [json({error: SECRET}, 401), json({error: SECRET}, 429), json({error: SECRET}, 500), new Response(event('error', {error: `https://evil.example/?token=${SECRET}`}), {headers: {'Content-Type': 'text/event-stream'}})]) {
    const {reader} = fixture({fetchImpl: async (_url, options) => options.method === 'GET' ? idle() : response});
    await assert.rejects(reader.read(ROUTE), error => !error.message.includes(SECRET) && !error.message.includes('http'));
  }
  const {reader} = fixture({}, {envelope: {data: {...RAW, messages: [{seq: 1, message: SECRET}]}}});
  await assert.rejects(reader.read(ROUTE), {code: 'INVALID_RESPONSE'});
});

test('message_stop and stream completion are required even when the mirror is available', async () => {
  for (const change of [{noStop: true}, {suffix: event('content_block_delta', {delta: {text: 'partial'}})}]) {
    const {reader} = fixture({}, change);
    await assert.rejects(reader.read(ROUTE), {code: 'INVALID_RESPONSE'});
  }
});

test('model-reported messages are ignored even when valid and conflicting with actual tool data', async () => {
  const forged = {...RAW, messages: [{seq: 999, message: 'fabricated'}], global_latest_seq: 999};
  const {reader} = fixture({}, {reply: JSON.stringify({protocol: 'being-town-agent-read/1', data: forged})});
  assert.deepEqual(await reader.read(ROUTE, {query: {limit: 1}}), RAW);
});

test('truncated false is not evidence unless complete status and JSON body are available', async () => {
  for (const body of [{status: 200, truncated: false, body: '{"messages":['}, {truncated: false, body: RAW}, {status: 200, truncated: true, body: RAW}]) {
    const {reader} = fixture({toolResults: null}, {result: {content: JSON.stringify(body)}});
    await assert.rejects(reader.read(ROUTE, {query: {limit: 1}}), {code: 'INCOMPLETE_RESULT'});
  }
  const {reader} = fixture({toolResults: null}, {result: {content: JSON.stringify({status: 200, truncated: false, body: JSON.stringify(RAW)})}});
  assert.deepEqual(await reader.read(ROUTE, {query: {limit: 1}}), RAW);
});

test('compact or truncated message bodies cannot be presented as complete text', async () => {
  for (const data of [{...RAW, truncated: true}, {...RAW, messages: [{message: 'preview', truncated: true}]}, {...RAW, messages: [{message: 'preview', full_length: 300}]}]) {
    const {reader} = fixture({}, {envelope: {data}});
    await assert.rejects(reader.read(ROUTE), {code: 'INCOMPLETE_RESULT'});
  }
});

test('mirror pending result is checked once and released without long polling', async () => {
  const records = [];
  const {reader} = fixture({toolResults: {
    prepare: async value => records.push(['prepare', value]),
    read: async value => { records.push(['read', value]); throw Object.assign(new Error('202 pending'), {code: 'INCOMPLETE_RESULT'}); },
    release: async value => records.push(['release', value]),
  }});
  await assert.rejects(reader.read(ROUTE), {code: 'INCOMPLETE_RESULT'});
  assert.deepEqual(records.map(([name]) => name), ['prepare', 'read', 'release']);
});

test('mirror registration failure prevents POST and release cannot conceal the failure', async () => {
  let releases = 0;
  const {reader, calls} = fixture({toolResults: {
    prepare: async () => { throw Object.assign(new Error('missing mirror'), {code: 'INCOMPLETE_RESULT'}); },
    read: async () => assert.fail('must not read'),
    release: async () => { releases++; throw new Error('cleanup failure'); },
  }});
  await assert.rejects(reader.read(ROUTE), {code: 'INCOMPLETE_RESULT'});
  assert.equal(calls.length, 1); assert.equal(releases, 1);
});

test('full SSE tool data needs no mirror read but still releases the registration', async () => {
  const {reader, mirrorCalls} = fixture({}, {result: {content: JSON.stringify({status: 200, body: RAW})}});
  assert.deepEqual(await reader.read(ROUTE), RAW);
  assert.deepEqual(mirrorCalls.map(call => call.method), ['prepare', 'release']);
});

test('identity changes or cancellation while reading the mirror discard its late data', async () => {
  for (const reset of [true, false]) {
    const gate = deferred(), entered = deferred(), abort = new AbortController();
    let released = 0;
    const {reader} = fixture({toolResults: {
      prepare: async () => {},
      read: async record => { entered.resolve(); await gate.promise; return {protocol: 'being-town-tool-result/1', requestId: record.requestId, route: record.route, beingId: record.beingId, httpStatus: 200, data: RAW}; },
      release: async () => { released++; },
    }});
    const result = reader.read(ROUTE, {signal: abort.signal});
    await entered.promise;
    if (reset) reader.reset(); else abort.abort();
    await assert.rejects(result, {code: reset ? 'SESSION_CHANGED' : 'ABORTED'});
    gate.resolve(); await flush();
    assert.equal(released, 1); assert.equal(reader.state().lastRead, null);
  }
});

test('identity changes during mirror cleanup cannot return data or keep old identity metadata', async () => {
  const instance = fixture({toolResults: {
    prepare: async () => {},
    read: async () => assert.fail('full tool data needs no mirror read'),
    release: async () => { instance.setConnection(parseConnection(CONNECTION.url.replace(SECRET, 'next-token'))); },
  }}, {result: {content: JSON.stringify({status: 200, body: RAW})}});
  await assert.rejects(instance.reader.read(ROUTE), {code: 'SESSION_CHANGED'});
  assert.equal(instance.reader.state().lastRead, null);
});

test('oversized SSE data is rejected before it can enter the Town cache', async () => {
  const {reader} = fixture({}, {reply: 'x'.repeat(1024 * 1024 + 1)});
  await assert.rejects(reader.read(ROUTE), {code: 'INVALID_RESPONSE'});
});

test('each queued read gets a fresh active check and main activity skips the next POST', async () => {
  const gate = deferred(); let getCount = 0, posts = 0;
  const {reader} = fixture({fetchImpl: async (_url, options) => {
    if (options.method === 'GET') return ++getCount === 1 ? idle() : json({finished: false});
    posts++; await gate.promise; return stream(options);
  }});
  const first = reader.read(ROUTE), second = reader.read('/api/fireside/list');
  const secondResult = assert.rejects(second, {code: 'BUSY'});
  await flush(); assert.equal(posts, 1); assert.equal(reader.state().queued, 1);
  gate.resolve(); assert.deepEqual(await first, RAW); await secondResult;
  assert.equal(getCount, 2); assert.equal(posts, 1);
});

test('queue is bounded and cancelled queued work never reaches the API', async () => {
  const gate = deferred(), abort = new AbortController(); let fetchCount = 0;
  const {reader} = fixture({fetchImpl: async (_url, options) => { fetchCount++; if (options.method === 'GET') { await gate.promise; return idle(); } return stream(options); }});
  const first = reader.read(ROUTE);
  const queued = [reader.read(ROUTE, {signal: abort.signal}), reader.read(ROUTE), reader.read(ROUTE), reader.read(ROUTE)];
  const settled = Promise.allSettled(queued);
  await assert.rejects(reader.read(ROUTE), {code: 'BUSY'});
  abort.abort(); reader.reset();
  await assert.rejects(first, {code: 'SESSION_CHANGED'});
  const results = await settled;
  assert.equal(results[0].reason.code, 'ABORTED');
  for (const result of results.slice(1)) assert.equal(result.reason.code, 'SESSION_CHANGED');
  gate.resolve(); await flush(); assert.ok(fetchCount <= 1); assert.equal(reader.state().lastRead, null);
});

test('cancel active read while fetch ignores AbortSignal and discard late response without stop call', async () => {
  const gate = deferred(), abort = new AbortController(); const calls = [];
  const {reader} = fixture({fetchImpl: async (url, options) => { calls.push(url); if (options.method === 'GET') return idle(); await gate.promise; return stream(options); }});
  const result = reader.read(ROUTE, {signal: abort.signal});
  await flush(); abort.abort(); await assert.rejects(result, {code: 'ABORTED'});
  gate.resolve(); await flush(); assert.equal(reader.state().lastRead, null);
  assert.equal(calls.length, 2); assert.equal(calls.some(url => url.includes('/stop')), false);
});

test('identity replacement during a response rejects stale results and reset clears metadata', async () => {
  const gate = deferred();
  const instance = fixture({fetchImpl: async (_url, options) => { if (options.method === 'GET') return idle(); await gate.promise; return stream(options); }});
  const result = instance.reader.read(ROUTE); await flush();
  instance.setConnection(parseConnection(CONNECTION.url.replace(SECRET, 'replacement-token')));
  gate.resolve(); await assert.rejects(result, {code: 'SESSION_CHANGED'});
  assert.equal(instance.reader.state().lastRead, null);
  const normal = fixture(); await normal.reader.read(ROUTE); normal.reader.reset();
  assert.equal(normal.reader.state().lastRead, null);
});

test('onRequest runs once just before POST and cannot leak credentials or enable a stale POST', async () => {
  const instance = fixture({onRequest: record => { assert.equal(JSON.stringify(record).includes(SECRET), false); instance.reader.reset(); }});
  await assert.rejects(instance.reader.read(ROUTE), {code: 'SESSION_CHANGED'});
  assert.equal(instance.calls.length, 1);
});

test('queued reads retain their own enrollment callbacks instead of borrowing the draining async task context', async () => {
  const {AsyncLocalStorage} = require('node:async_hooks');
  const scope = new AsyncLocalStorage(), gate = deferred(), entered = deferred(), enrolled = [], submitted = [];
  let fallback = 0;
  const {reader} = fixture({onRequest:()=>fallback++, fetchImpl:async (_url,options)=>{
    if (options.method === 'GET') return idle();
    submitted.push(requestInfo(options));
    if (submitted.length === 1) {entered.resolve();await gate.promise;}
    return stream(options);
  }});
  const enqueue = owner => scope.run(owner, () => {
    const captured = scope.getStore();
    return reader.read(ROUTE, {onRequest:record=>enrolled.push({owner:captured,record})});
  });
  const first=enqueue('first-task');
  await entered.promise;
  const second=enqueue('second-task');
  assert.equal(reader.state().queued,1);
  gate.resolve();
  await Promise.all([first,second]);
  assert.deepEqual(enrolled.map(item=>item.owner),['first-task','second-task']);
  assert.deepEqual(enrolled.map(item=>item.record.requestId),submitted.map(item=>item.requestId));
  assert.notEqual(enrolled[0].record.requestId,enrolled[1].record.requestId);
  assert.equal(fallback,0);
});

test('per-read enrollment reset cannot send a stale request and never calls the fallback twice', async () => {
  const instance = fixture();
  let ownedCalls=0;
  await assert.rejects(instance.reader.read(ROUTE,{onRequest:()=>{ownedCalls++;instance.reader.reset();}}),{code:'SESSION_CHANGED'});
  assert.equal(ownedCalls,1);
  assert.equal(instance.requests.length,0);
  assert.equal(instance.calls.length,1);
});
