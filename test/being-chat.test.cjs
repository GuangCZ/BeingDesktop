'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {BeingChat, consumeEvents, sceneId, sessionFromScene, inScene, historyRow, imageBlocks, imageBytes} = require('../src/being-chat.cjs');

const DESKTOP = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sceneA = sceneId(DESKTOP, A), sceneB = sceneId(DESKTOP, B);
const token = 'c'.repeat(64);
const json = (value, status = 200) => new Response(value === null ? null : JSON.stringify(value), {status, headers: value === null ? {} : {'Content-Type': 'application/json'}});
const sse = frames => new Response(frames.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {headers: {'Content-Type': 'text/event-stream'}});

function fixture(fetchImpl) {
  let context = {connected: true, connection: {url: `https://echo.beings.town/cz_being/?token=${token}`}, revision: 1};
  const calls = [], events = [];
  const chat = new BeingChat({getContext: () => context, desktopId: DESKTOP, clientVersion: '0.8.24',
    onEvent: event => events.push(event),
    fetchImpl: async (url, options) => { calls.push({url: new URL(url), options, body: options.body ? JSON.parse(options.body) : null}); return fetchImpl(new URL(url), options); }});
  return {chat, calls, events, reconnect: () => { context = {...context, revision: 2}; }};
}

test('a conversation is a scene, and the scene names the conversation back', () => {
  assert.equal(sceneA, `desktop-${DESKTOP}-${A}`);
  assert.equal(sessionFromScene(DESKTOP, sceneA), A);
  assert.equal(sessionFromScene(DESKTOP, sceneB), B);
  // Another Desktop's scene, the Loom page's own scene, and malformed names are all not ours.
  assert.equal(sessionFromScene(DESKTOP, sceneId(A, B)), '');
  assert.equal(sessionFromScene(DESKTOP, 'loom-being'), '');
  assert.equal(sessionFromScene(DESKTOP, `desktop-${DESKTOP}-not-a-uuid`), '');
  assert.throws(() => sceneId(DESKTOP, 'nope'), {code: 'INVALID_REQUEST'});
});

test('unscoped history rows belong to no conversation, unlike Loom where they pass', () => {
  assert.equal(inScene({scene_id: sceneA}, sceneA), true);
  assert.equal(inScene({scene_id: sceneB}, sceneA), false);
  // Loom admits these; Desktop must not, or every old message shows up in every conversation.
  assert.equal(inScene({}, sceneA), false);
  assert.equal(inScene({from: 'system', content: '[breath yielded to human]'}, sceneA), false);
  assert.equal(historyRow({seq: 3, role: 'assistant', content: 'hi', at: 'x', scene_id: sceneA}).role, 'being');
  assert.equal(historyRow({seq: 0, role: 'user', content: 'hi'}), null);
});

test('one timeline read fans out to every conversation and the cursor only moves forward', async () => {
  const rows = [{seq: 11, role: 'user', content: 'a?', scene_id: sceneA}, {seq: 13, role: 'assistant', content: 'b!', scene_id: sceneB},
    {seq: 12, role: 'assistant', content: 'a!', scene_id: sceneA}, {seq: 14, role: 'user', content: 'sep', from: 'system'}];
  const f = fixture(async () => json({messages: rows}));
  const page = await f.chat.history({after: 10, limit: 100});
  assert.deepEqual(page.rows.map(row => row.seq), [11, 12, 13, 14]);
  assert.equal(page.cursor, 14); assert.equal(page.more, false); assert.equal(page.ignoredAfter, false);
  assert.equal(f.calls[0].url.searchParams.get('after'), '10');
  // The chat endpoints authenticate by query token; Authorization is rejected with 403 here.
  assert.equal(f.calls[0].url.searchParams.get('token'), token);
  assert.equal(f.calls[0].options.headers.Authorization, undefined);
  assert.deepEqual(page.rows.filter(row => inScene(row, sceneA)).map(row => row.seq), [11, 12]);
  assert.deepEqual(page.rows.filter(row => inScene(row, sceneB)).map(row => row.seq), [13]);
});

test('a server that ignores after is reported, never allowed to drag the cursor backwards', async () => {
  const f = fixture(async () => json({messages: [{seq: 5, role: 'user', content: 'old', scene_id: sceneA}]}));
  const page = await f.chat.history({after: 100});
  assert.deepEqual(page.rows, []); assert.equal(page.cursor, 100); assert.equal(page.ignoredAfter, true);
  const empty = await fixture(async () => json({messages: []})).chat.history({after: 100});
  assert.equal(empty.cursor, 100); assert.equal(empty.ignoredAfter, false);
});

test('the first page omits after and reports more when it fills the limit', async () => {
  const messages = Array.from({length: 2}, (unused, index) => ({seq: index + 1, role: 'user', content: 'x', scene_id: sceneA}));
  const f = fixture(async () => json({messages}));
  const page = await f.chat.history({limit: 2});
  assert.equal(f.calls[0].url.searchParams.has('after'), false);
  assert.equal(page.more, true); assert.equal(page.cursor, 2);
});

test('a send carries only human text, its scene, a declaration and a ref', async () => {
  const f = fixture(async () => sse([['meta', {scene_id: sceneA, stream_id: 's1', client_ref: 'ignored'}], ['content_block_delta', {scene_id: sceneA, delta: {text: '你好'}}], ['message_stop', {scene_id: sceneA}]]));
  const deltas = [];
  const result = await f.chat.send({sessionId: A, text: '在吗', sceneMeta: {scene_label: '会话一'}, onDelta: value => deltas.push(value)});
  assert.deepEqual(Object.keys(f.calls[0].body).sort(), ['client_ref', 'message', 'scene_id', 'scene_meta']);
  assert.equal(f.calls[0].body.message, '在吗');
  assert.equal(f.calls[0].body.scene_id, sceneA);
  assert.deepEqual(f.calls[0].body.scene_meta, {client: 'being-desktop/0.8.24', scene_label: '会话一'});
  assert.match(f.calls[0].body.client_ref, /^req-/);
  assert.equal(result.streamed, true); assert.equal(result.replies, 1); assert.equal(result.streamId, 's1');
  assert.deepEqual(deltas, ['你好']);
  assert.deepEqual(f.events.filter(event => event.type === 'reply'), [{sessionId: A, type: 'reply', text: '你好'}]);
});

test('client_ref confirms the stream is ours; a foreign echo does not', async () => {
  const f = fixture(async (url, options) => sse([['meta', {scene_id: sceneA, stream_id: 's1', client_ref: JSON.parse(options.body).client_ref}]]));
  assert.equal((await f.chat.send({sessionId: A, text: 'x'})).confirmed, true);
  const g = fixture(async () => sse([['meta', {scene_id: sceneA, stream_id: 's1', client_ref: 'req-someone-else'}]]));
  assert.equal((await g.chat.send({sessionId: A, text: 'x'})).confirmed, false);
});

test('a spliced send is delivered even though it gets no stream of its own', async () => {
  const f = fixture(async () => json({spliced: true}, 202));
  const result = await f.chat.send({sessionId: A, text: 'x'});
  // Reporting this as a failure would make the user resend and queue a duplicate.
  assert.equal(result.ok, true); assert.equal(result.streamed, false); assert.equal(result.spliced, true);
  assert.deepEqual(f.events, [{sessionId: A, type: 'spliced', scene: sceneA}]);
  assert.equal(f.chat.inFlight(A), false);
});

test('a spliced reply arriving on another conversation stream is routed, not dropped', async () => {
  // Measured live: after A's message_stop, a `continuation` meta handed the connection to B.
  const f = fixture(async () => sse([
    ['meta', {scene_id: sceneA, stream_id: 's1'}],
    ['content_block_delta', {scene_id: sceneA, delta: {text: 'A回'}}],
    ['message_stop', {scene_id: sceneA}],
    ['meta', {continuation: true, scene_id: sceneB}],
    ['reasoning', {scene_id: sceneB, text: '想一下'}],
    ['content_block_delta', {scene_id: sceneB, delta: {text: 'B回'}}],
    ['message_stop', {scene_id: sceneB}],
  ]));
  const deltas = [];
  const result = await f.chat.send({sessionId: A, text: 'x', onDelta: value => deltas.push(value)});
  // The caller asked for A, so only A's reply counts as its own and only A's text reaches onDelta.
  assert.equal(result.replies, 1); assert.deepEqual(deltas, ['A回']);
  assert.deepEqual(f.events.filter(event => event.type === 'reply'),
    [{sessionId: A, type: 'reply', text: 'A回'}, {sessionId: B, type: 'reply', text: 'B回'}]);
  // Reply text is buffered per conversation: B's answer must never land in A's bubble.
  assert.deepEqual(f.events.filter(event => event.type === 'delta'),
    [{sessionId: A, type: 'delta', text: 'A回'}, {sessionId: B, type: 'delta', text: 'B回'}]);
  // Thinking is shown live but kept out of the reply text.
  assert.deepEqual(f.events.filter(event => event.type === 'think'), [{sessionId: B, type: 'think', text: '想一下'}]);
  assert.equal(result.foreign, 0);
});

test('another client scene on the same Being is dropped, and counted', async () => {
  const f = fixture(async () => sse([
    ['meta', {scene_id: sceneA, stream_id: 's1'}],
    ['meta', {continuation: true, scene_id: 'loom-being'}],
    ['content_block_delta', {scene_id: 'loom-being', delta: {text: '不属于 Desktop'}}],
    ['message_stop', {scene_id: 'loom-being'}],
  ]));
  const result = await f.chat.send({sessionId: A, text: 'x'});
  assert.equal(result.replies, 0); assert.equal(result.foreign, 2);
  assert.deepEqual(f.events.filter(event => event.type === 'reply'), []);
  // A meta for a foreign scene still reports, so the caller can see the connection was handed away.
  assert.deepEqual(f.events.at(-1), {sessionId: A, type: 'meta', streamId: 's1', scene: 'loom-being', confirmed: false});
});

test('meta does not consume a seq, so non-meta events stay one to one with the server', async () => {
  const f = fixture(async () => sse([['meta', {scene_id: sceneA, stream_id: 's1'}], ['reasoning', {scene_id: sceneA, text: 't'}],
    ['content_block_delta', {scene_id: sceneA, delta: {text: 'x'}}], ['meta', {continuation: true, scene_id: sceneA}], ['message_stop', {scene_id: sceneA}]]));
  assert.equal((await f.chat.send({sessionId: A, text: 'x'})).liveSeq, 3);
});

test('a yielded breath emits one bubble per message_stop', async () => {
  const f = fixture(async () => sse([['meta', {scene_id: sceneA, stream_id: 's1'}],
    ['content_block_delta', {scene_id: sceneA, delta: {text: '一'}}], ['message_stop', {scene_id: sceneA}],
    ['content_block_delta', {scene_id: sceneA, delta: {text: '二'}}], ['message_stop', {scene_id: sceneA}]]));
  const result = await f.chat.send({sessionId: A, text: 'x'});
  assert.equal(result.replies, 2); assert.equal(result.trailing, '');
  assert.deepEqual(f.events.filter(event => event.type === 'reply').map(event => event.text), ['一', '二']);
});

test('a dispatched send whose stream breaks is never reported as not sent', async () => {
  const f = fixture(async () => new Response(new ReadableStream({start(controller) { controller.error(new Error('reset')); }}), {headers: {'Content-Type': 'text/event-stream'}}));
  await assert.rejects(f.chat.send({sessionId: A, text: 'x'}), {code: 'RESULT_UNKNOWN'});
  const g = fixture(async () => { throw new Error('offline'); });
  await assert.rejects(g.chat.send({sessionId: A, text: 'x'}), {code: 'NETWORK_ERROR'});
  assert.equal(g.calls.length, 1);
});

test('a send refuses malformed input before touching the network', async () => {
  const f = fixture(async () => json({}));
  for (const args of [{sessionId: 'x', text: 'y'}, {sessionId: A, text: '   '}, {sessionId: A, text: 'a\0b'}, {sessionId: A, text: 'y', sceneMeta: []}]) {
    await assert.rejects(f.chat.send(args), {code: 'INVALID_REQUEST'});
  }
  assert.equal(f.calls.length, 0);
});

test('reconnecting mid-stream stops reading rather than mixing two timelines', async () => {
  const f = fixture(async () => sse([['meta', {scene_id: sceneA, stream_id: 's1'}],
    ['content_block_delta', {scene_id: sceneA, delta: {text: '一'}}], ['content_block_delta', {scene_id: sceneA, delta: {text: '二'}}], ['message_stop', {scene_id: sceneA}]]));
  // The message was already accepted, so the failure must not claim it was never sent.
  await assert.rejects(f.chat.send({sessionId: A, text: 'x', onDelta: () => f.reconnect()}), {code: 'RESULT_UNKNOWN'});
  assert.deepEqual(f.events.filter(event => event.type === 'delta').map(event => event.text), ['一']);
  assert.deepEqual(f.events.filter(event => event.type === 'reply'), []);
});

test('a send cancelled after dispatch reports an unknown result, never a failure', async () => {
  const f = fixture(async () => sse([['meta', {scene_id: sceneA, stream_id: 's1'}],
    ['content_block_delta', {scene_id: sceneA, delta: {text: 'x'}}], ['content_block_delta', {scene_id: sceneA, delta: {text: 'y'}}], ['message_stop', {scene_id: sceneA}]]));
  const controller = new AbortController();
  await assert.rejects(f.chat.send({sessionId: A, text: 'x', signal: controller.signal, onDelta: () => controller.abort()}), {code: 'RESULT_UNKNOWN'});
  // A send cancelled before dispatch never reached the Being, and says so.
  const g = fixture(async () => sse([]));
  await assert.rejects(g.chat.send({sessionId: A, text: 'x', signal: AbortSignal.abort()}), {code: 'ABORTED'});
});

test('a probe reads the replay buffer, its scene and where to resume', async () => {
  const f = fixture(async () => json({stream_id: 's1', finished: false, next_seq: 4, origin: 'human', trigger_message: '问题',
    events: [{event: 'reasoning', seq: 1, data: {scene_id: sceneA, text: 'The'}}, {event: 'content_block_delta', seq: 2, data: {scene_id: sceneA, delta: {text: 'x'}}},
      {event: 'reasoning', seq: 3, data: {scene_id: sceneB, text: 'now B'}}]}));
  const active = await f.chat.probe({localSeq: 2});
  assert.equal(active.verdict, 'progressing'); assert.equal(active.nextSeq, 4); assert.equal(active.serverSeq, 3); assert.equal(active.streamId, 's1');
  assert.equal(active.origin, 'human'); assert.equal(active.autonomous, false); assert.equal(active.trigger, '问题');
  // Caught up with the server means stalled, not progressing: Loom's watchdog keeps waiting.
  assert.equal((await f.chat.probe({localSeq: 3})).verdict, 'stalled');
  // Replay events carry scene_id, so recovery fans out exactly like a live stream. The newest
  // event names the conversation currently being spoken to.
  assert.deepEqual(active.scenes, [sceneA, sceneB]); assert.equal(active.scene, sceneB);
  assert.deepEqual(active.events.map(event => event.type), ['reasoning', 'content_block_delta', 'reasoning']);
  assert.deepEqual(active.events.map(event => sessionFromScene(DESKTOP, event.data.scene_id)), [A, A, B]);
});

test('a probe distinguishes gone, finished, superseded and autonomous', async () => {
  assert.equal((await fixture(async () => json(null, 204)).chat.probe({})).verdict, 'gone');
  assert.equal((await fixture(async () => json({stream_id: 's1', finished: true, events: []})).chat.probe({})).verdict, 'finished');
  const taken = await fixture(async () => json({stream_id: 's2', events: [{event: 'reasoning', seq: 1, data: {scene_id: sceneA, text: 'x'}}]})).chat.probe({streamId: 's1'});
  assert.equal(taken.verdict, 'superseded'); assert.deepEqual(taken.events, []);
  // An autonomous breath has a stream but no events; only waiting and history can follow it.
  const own = await fixture(async () => json({stream_id: 's3', finished: false, next_seq: 1, origin: 'beating', events: []})).chat.probe({});
  assert.equal(own.autonomous, true); assert.equal(own.verdict, 'stalled'); assert.equal(own.scene, '');
});

test('a probe resumes from after, and the resume point comes from next_seq not the tail', async () => {
  const f = fixture(async () => json({stream_id: 's1', finished: false, next_seq: 9, origin: 'human', events: [{event: 'content_block_delta', seq: 8, data: {scene_id: sceneA, delta: {text: 'x'}}}]}));
  const active = await f.chat.probe({after: 7, localSeq: 7});
  assert.equal(f.calls[0].url.searchParams.get('after'), '7');
  assert.equal(active.nextSeq, 9); assert.equal(active.serverSeq, 8); assert.equal(active.verdict, 'progressing');
  const untold = await fixture(async () => json({stream_id: 's1', events: [{event: 'reasoning', seq: 8, data: {scene_id: sceneA, text: 'x'}}]})).chat.probe({after: 7});
  assert.equal(untold.nextSeq, 9);
});

test('a replay buffer is folded in by the same routing as a live stream', async () => {
  const f = fixture(async () => json({}));
  const result = f.chat.replay({from: 1, events: [
    {type: 'reasoning', seq: 1, data: {scene_id: sceneA, text: 'already delivered'}},
    {type: 'content_block_delta', seq: 2, data: {scene_id: sceneA, delta: {text: 'A回'}}},
    {type: 'message_stop', seq: 3, data: {scene_id: sceneA}},
    {type: 'content_block_delta', seq: 4, data: {scene_id: sceneB, delta: {text: 'B回'}}},
    {type: 'message_stop', seq: 5, data: {scene_id: sceneB}},
    {type: 'content_block_delta', seq: 6, data: {scene_id: 'loom-being', delta: {text: '别人的'}}},
  ]});
  assert.equal(result.cursor, 6); assert.equal(result.liveSeq, 5); assert.equal(result.foreign, 1);
  assert.deepEqual(f.events.filter(event => event.type === 'reply'), [{sessionId: A, type: 'reply', text: 'A回'}, {sessionId: B, type: 'reply', text: 'B回'}]);
  // Nothing at or before `from` is delivered twice.
  assert.deepEqual(f.events.filter(event => event.type === 'think'), []);
});

test('stop refuses to interrupt a breath that belongs to another conversation', async () => {
  const active = {stream_id: 's1', finished: false, events: [{event: 'reasoning', seq: 1, data: {scene_id: sceneB, text: 'x'}}]};
  const f = fixture(async url => url.pathname.endsWith('/api/stop') ? json({ok: true}) : json(active));
  const refused = await f.chat.stop({sessionId: A});
  assert.deepEqual(refused, {stopped: false, reason: 'other-scene', scene: sceneB});
  assert.deepEqual(f.calls.map(call => call.url.pathname), ['/cz_being/api/stream/active']);
  // Once the user answers the prompt that refusal produces, force stops it.
  assert.equal((await f.chat.stop({sessionId: A, force: true})).stopped, true);
  assert.equal(f.calls.at(-1).url.pathname, '/cz_being/api/stop');
});

test('stop proceeds for its own breath, and asks when ownership cannot be proven', async () => {
  const mine = {stream_id: 's1', finished: false, events: [{event: 'reasoning', seq: 1, data: {scene_id: sceneA, text: 'x'}}]};
  const f = fixture(async url => url.pathname.endsWith('/api/stop') ? json({ok: true}) : json(mine));
  assert.deepEqual(await f.chat.stop({sessionId: A}), {stopped: true, reason: 'matched', scene: sceneA});
  const blind = fixture(async () => json({stream_id: 's1', finished: false, events: []}));
  assert.deepEqual(await blind.chat.stop({sessionId: A}), {stopped: false, reason: 'unknown', scene: ''});
  assert.deepEqual(blind.calls.map(call => call.url.pathname), ['/cz_being/api/stream/active']);
  const idle = fixture(async () => json(null, 204));
  assert.equal((await idle.chat.stop({sessionId: A})).reason, 'idle');
  const own = fixture(async () => json({stream_id: 's1', finished: false, origin: 'beating', events: []}));
  assert.equal((await own.chat.stop({sessionId: A})).reason, 'autonomous');
});

test('stop asks when a bubble just closed, because the next speaker may be another scene', async () => {
  // Our message_stop is the last thing in the buffer: a continuation for another conversation may
  // be the very next event, so "our scene" proves nothing about what a stop would interrupt.
  const closed = {stream_id: 's1', finished: false, events: [{event: 'content_block_delta', seq: 1, data: {scene_id: sceneA, delta: {text: 'x'}}}, {event: 'message_stop', seq: 2, data: {scene_id: sceneA}}]};
  const f = fixture(async () => json(closed));
  assert.equal((await f.chat.probe({})).speaking, false);
  assert.deepEqual(await f.chat.stop({sessionId: A}), {stopped: false, reason: 'unknown', scene: sceneA});
  assert.equal(f.calls.some(call => call.url.pathname.endsWith('/api/stop')), false);
  const forced = fixture(async url => url.pathname.endsWith('/api/stop') ? json({ok: true}) : json(closed));
  assert.deepEqual(await forced.chat.stop({sessionId: A, force: true}), {stopped: true, reason: 'forced', scene: sceneA});
});

test('a settled router names the conversations it left mid-bubble, once', () => {
  const f = fixture(async () => json(null, 204));
  const router = f.chat.router({scene: sceneA, sessionId: A});
  router.handle('meta', {scene_id: sceneA, stream_id: 's1'});
  router.handle('content_block_delta', {scene_id: sceneA, delta: {text: '一半'}});
  router.handle('meta', {continuation: true, scene_id: sceneB});
  router.handle('content_block_delta', {scene_id: sceneB, delta: {text: '完整'}});
  router.handle('message_stop', {scene_id: sceneB});
  assert.deepEqual(router.settle(), [A]);
  assert.deepEqual(router.settle(), []);
  assert.equal(router.state().trailing, '');
});

test('an unreachable Being reports plainly, and a bad token asks to reconnect', async () => {
  await assert.rejects(fixture(async () => json({}, 403)).chat.status(), {code: 'AUTH_REQUIRED'});
  await assert.rejects(fixture(async () => json({}, 500)).chat.status(), {code: 'SERVICE_ERROR'});
  await assert.rejects(fixture(async () => new Response('<html>', {headers: {'Content-Type': 'text/html'}})).chat.status(), {code: 'INVALID_RESPONSE'});
  const f = fixture(async () => json({being_name: 'cz_being'}));
  assert.deepEqual(await f.chat.status(), {beingName: 'cz_being'});
});

test('a disconnected Being never reaches the network', async () => {
  const chat = new BeingChat({getContext: () => ({connected: false}), desktopId: DESKTOP, fetchImpl: async () => { throw new Error('should not fetch'); }});
  await assert.rejects(chat.status(), {code: 'NOT_CONNECTED'});
  await assert.rejects(chat.send({sessionId: A, text: 'x'}), {code: 'NOT_CONNECTED'});
});

test('the SSE reader rejects an oversized or malformed frame', async () => {
  const seen = [];
  await consumeEvents(new Response('event: a\r\ndata: {"n":1}\r\n\r\n:comment\n\ndata: {"n":2}\n\n').body, (type, data) => seen.push([type, data.n]));
  assert.deepEqual(seen, [['a', 1], ['message', 2]]);
  await assert.rejects(consumeEvents(new Response('data: {oops\n\n').body, () => {}), {code: 'INVALID_RESPONSE'});
});

// Measured 2026-09-11: images travel as content blocks beside the text, the server accepts only
// `text`, `image` and `image_url` blocks (an `audio` block is refused with 422 before anything is
// recorded), a 9.5 MB PNG went through, and history keeps the text alone.
test('images go as content blocks with the text, in place of message', async () => {
  const f = fixture(async () => sse([['meta', {scene_id: sceneA, stream_id: 's1'}], ['content_block_delta', {scene_id: sceneA, delta: {text: '黄底绿圆'}}], ['message_stop', {scene_id: sceneA}]]));
  const data = Buffer.from('png-bytes').toString('base64');
  const result = await f.chat.send({sessionId: A, text: '这是什么？', images: [{media_type: 'image/png', data, name: 'ignored.png', thumb: 'ignored'}]});
  assert.equal(result.replies, 1);
  const body = f.calls[0].body;
  assert.deepEqual(Object.keys(body).sort(), ['client_ref', 'content', 'scene_id', 'scene_meta']);
  assert.deepEqual(body.content, [{type: 'text', text: '这是什么？'}, {type: 'image', media_type: 'image/png', data}]);
  // Only the bytes and their type reach the Being; previews and names are the transcript's business.
  assert.equal(JSON.stringify(body).includes('ignored'), false);
});

test('a send without images keeps the plain message body', async () => {
  const f = fixture(async () => sse([['meta', {scene_id: sceneA, stream_id: 's1'}], ['message_stop', {scene_id: sceneA}]]));
  await f.chat.send({sessionId: A, text: '在吗', images: []});
  assert.deepEqual(Object.keys(f.calls[0].body).sort(), ['client_ref', 'message', 'scene_id', 'scene_meta']);
});

test('images outside the measured envelope are refused before the network', async () => {
  const f = fixture(async () => json({}));
  const data = Buffer.from('png-bytes').toString('base64');
  const big = Buffer.alloc(6 * 1024 * 1024).toString('base64');
  for (const images of [
    'nope', [null], [{media_type: 'image/svg+xml', data}], [{media_type: 'audio/wav', data}], [{media_type: 'image/png', data: ''}],
    [{media_type: 'image/png', data: 'not base64!'}], [{media_type: 'image/png', data: 'abc'}],
    [{media_type: 'image/png', data: big}, {media_type: 'image/png', data: big}],
    Array.from({length: 9}, () => ({media_type: 'image/png', data})),
  ]) await assert.rejects(f.chat.send({sessionId: A, text: 'x', images}), {code: 'INVALID_REQUEST'});
  // Text is required with images: a block list of images alone lands no row (measured).
  await assert.rejects(f.chat.send({sessionId: A, text: '  ', images: [{media_type: 'image/png', data}]}), {code: 'INVALID_REQUEST'});
  assert.equal(f.calls.length, 0);
  assert.equal(imageBytes(big), 6 * 1024 * 1024);
  assert.deepEqual(imageBlocks([{media_type: 'image/jpeg', data}]), [{type: 'image', media_type: 'image/jpeg', data}]);
});
