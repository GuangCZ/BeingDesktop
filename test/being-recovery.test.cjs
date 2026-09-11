'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {BeingChat, sceneId} = require('../src/being-chat.cjs');
const {ChatStore} = require('../src/chat-store.cjs');
const {BeingRecovery, STALL_MS, STALL_GIVEUP_MS, CATCH_UP_ABSOLUTE_MAX_MS} = require('../src/being-recovery.cjs');

const DESKTOP = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sceneA = sceneId(DESKTOP, A), sceneB = sceneId(DESKTOP, B);
const token = 'c'.repeat(64);
const json = (value, status = 200) => () => new Response(value === null ? null : JSON.stringify(value), {status, headers: value === null ? {} : {'Content-Type': 'application/json'}});
const row = (seq, scene, content, role = 'assistant') => ({seq, role, content, at: 't', scene_id: scene});
const replayEvent = (seq, scene, text) => ({event: 'content_block_delta', seq, data: {scene_id: scene, delta: {text}}});
const stopEvent = (seq, scene) => ({event: 'message_stop', seq, data: {scene_id: scene}});
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)); };

// A stream the test feeds by hand. Aborting the request errors the reader, as a real socket would.
function sse() {
  let controller = null;
  const encoder = new TextEncoder();
  const stream = {
    open: (url, options) => {
      const body = new ReadableStream({start(c) { controller = c; options.signal?.addEventListener('abort', () => { try { c.error(new DOMException('aborted', 'AbortError')); } catch { /* already closed */ } }); }});
      return new Response(body, {status: 200, headers: {'Content-Type': 'text/event-stream'}});
    },
    push: (type, data) => controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)),
    close: () => { try { controller.close(); } catch { /* already errored */ } },
    // A reset socket errors the reader; a proxy timing out closes it cleanly. Both happen.
    error: () => { try { controller.error(new TypeError('socket reset')); } catch { /* already closed */ } },
  };
  return stream;
}

function fixture() {
  let now = 1_000_000, id = 0;
  const queue = new Map();
  const timers = {setTimeout: (fn, ms) => { const t = ++id; queue.set(t, {at: now + ms, fn}); return t; }, clearTimeout: t => queue.delete(t)};
  const advance = async ms => {
    const target = now + ms;
    // Let in-flight promise chains register their timers before scanning the queue.
    await settle();
    while (true) {
      const next = [...queue.entries()].filter(([, entry]) => entry.at <= target).sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      queue.delete(next[0]); now = next[1].at;
      await next[1].fn(); await settle();
    }
    now = target; await settle();
  };
  const routes = new Map(), defaults = new Map(), calls = [];
  const on = (path, responder) => { if (!routes.has(path)) routes.set(path, []); routes.get(path).push(responder); };
  const always = (path, responder) => defaults.set(path, responder);
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url), path = parsed.pathname.replace(/^\/cz_being/, '');
    calls.push({path, after: parsed.searchParams.get('after'), body: options.body ? JSON.parse(options.body) : null});
    const responder = routes.get(path)?.shift() || defaults.get(path);
    if (!responder) throw new Error(`no route: ${path}`);
    return responder(parsed, options);
  };
  const context = {connected: true, connection: {url: `https://echo.beings.town/cz_being/?token=${token}`}, revision: 1};
  const chat = new BeingChat({getContext: () => context, desktopId: DESKTOP, fetchImpl});
  const store = new ChatStore({desktopId: DESKTOP, clock: () => now});
  const events = [], states = [];
  const recovery = new BeingRecovery({chat, store, timers, clock: () => now, onEvent: event => events.push(event), onState: state => states.push(state.phase + (state.hint ? `:${state.hint}` : ''))});
  always('/api/history', json({messages: []}));
  return {chat, store, recovery, events, states, calls, on, always, advance, pending: () => queue.size, clock: () => now,
    replies: () => events.filter(event => event.type === 'reply').map(event => [event.sessionId, event.text]),
    paths: () => calls.map(call => call.path)};
}

test('a live reply that completes is pulled into the store with its seq', async () => {
  const f = fixture();
  const stream = sse();
  f.on('/api/chat/stream', stream.open);
  f.on('/api/history', json({messages: [row(1, sceneA, '问', 'user'), row(2, sceneA, '答')]}));
  const sending = f.recovery.send({sessionId: A, text: '问'});
  await settle();
  stream.push('meta', {scene_id: sceneA, stream_id: 's1'});
  stream.push('content_block_delta', {scene_id: sceneA, delta: {text: '答'}});
  stream.push('message_stop', {scene_id: sceneA});
  stream.close();
  const result = await sending;
  assert.equal(result.streamed, true);
  await f.advance(0);
  assert.deepEqual(f.replies(), [[A, '答']]);
  assert.deepEqual(f.store.rows(A).map(item => item.seq), [1, 2]);
  assert.equal(f.store.cursor, 2);
  assert.equal(f.recovery.state().phase, 'idle');
  assert.equal(f.pending(), 0);
});

test('a spliced send watches history until this conversation gets its reply', async () => {
  const f = fixture();
  f.on('/api/chat/stream', json({spliced: true}, 202));
  f.always('/api/stream/active', json(null, 204));
  // Nothing yet, then another conversation's reply, then ours.
  f.on('/api/history', json({messages: []}));
  f.on('/api/history', json({messages: [row(5, sceneB, 'B 的')]}));
  f.on('/api/history', json({messages: [row(6, sceneA, 'A 的')]}));
  const result = await f.recovery.send({sessionId: A, text: 'x'});
  assert.equal(result.streamed, false); assert.equal(result.spliced, true);
  assert.equal(f.recovery.state().catchingUp, true);
  await f.advance(2000);
  assert.equal(f.recovery.state().catchingUp, true);
  await f.advance(4000);
  // B's reply does not satisfy A's watcher: the wait is per conversation.
  assert.equal(f.recovery.state().catchingUp, true);
  assert.deepEqual(f.store.rows(B).map(item => item.seq), [5]);
  await f.advance(8000);
  assert.equal(f.recovery.state().catchingUp, false);
  assert.deepEqual(f.store.rows(A).map(item => item.seq), [6]);
  assert.equal(f.recovery.state().phase, 'idle');
  // Backoff doubled between reads: 2s, 4s, 8s.
  assert.deepEqual(f.calls.filter(call => call.path === '/api/history').length, 3);
});

test('a spliced send takes over the running stream, where its reply surfaces as a continuation', async () => {
  const f = fixture();
  f.on('/api/chat/stream', json({spliced: true}, 202));
  // Another client's human stream is running; the buffer already holds their text and then ours.
  f.on('/api/stream/active', json({stream_id: 'theirs', finished: false, next_seq: 3, origin: 'human', events: [replayEvent(1, 'loom-being', '别人的'), stopEvent(2, 'loom-being')]}));
  f.on('/api/stream/active', json({stream_id: 'theirs', finished: true, next_seq: 5, origin: 'human', events: [replayEvent(3, sceneA, '我们的'), stopEvent(4, sceneA)]}));
  f.on('/api/history', json({messages: [row(9, sceneA, '我们的')]}));
  await f.recovery.send({sessionId: A, text: 'x'});
  await settle();
  assert.equal(f.recovery.state().replaying, true);
  await f.advance(500);
  assert.deepEqual(f.replies(), [[A, '我们的']]);
  assert.equal(f.recovery.state().replaying, false);
  await f.advance(0);
  assert.deepEqual(f.store.rows(A).map(item => item.seq), [9]);
  assert.equal(f.recovery.state().catchingUp, false);
});

test('a stream that breaks mid-reply is resumed from the replay buffer without repeating a character', async () => {
  const f = fixture();
  const stream = sse();
  f.on('/api/chat/stream', stream.open);
  f.on('/api/stream/active', json({stream_id: 's1', finished: false, next_seq: 4, origin: 'human', events: [replayEvent(3, sceneA, '半')]}));
  f.on('/api/stream/active', json({stream_id: 's1', finished: true, next_seq: 6, origin: 'human', events: [replayEvent(4, sceneA, '句'), stopEvent(5, sceneA)]}));
  f.on('/api/history', json({messages: [row(20, sceneA, '一半句')]}));
  const sending = f.recovery.send({sessionId: A, text: 'x'});
  await settle();
  stream.push('meta', {scene_id: sceneA, stream_id: 's1'});
  stream.push('content_block_delta', {scene_id: sceneA, delta: {text: '一'}});
  stream.push('reasoning', {scene_id: sceneA, text: 'thinking'});
  await settle();
  stream.error();
  const result = await sending;
  assert.equal(result.recovering, 'probe'); assert.equal(result.liveSeq, 2);
  await settle();
  // The probe resumed after our seq 2, so seq 3 onward is folded in and nothing is repeated.
  assert.equal(f.calls.find(call => call.path === '/api/stream/active').after, '2');
  await f.advance(500);
  assert.deepEqual(f.events.filter(event => event.type === 'delta').map(event => event.text), ['一', '半', '句']);
  // The router rode along with the pending recovery, so the reply is whole, not the tail.
  assert.deepEqual(f.replies(), [[A, '一半句']]);
  await f.advance(0);
  assert.deepEqual(f.store.rows(A).map(item => item.content), ['一半句']);
  assert.equal(f.recovery.state().phase, 'idle');
});

test('a clean close that delivered no reply is treated like a splice, not a finished turn', async () => {
  const f = fixture();
  const stream = sse();
  f.on('/api/chat/stream', stream.open);
  // The breath is still running server-side; a proxy closed our socket cleanly.
  f.on('/api/stream/active', json({stream_id: 's1', finished: true, next_seq: 4, origin: 'human', events: [replayEvent(2, sceneA, '全部'), stopEvent(3, sceneA)]}));
  f.on('/api/history', json({messages: [row(70, sceneA, '全部')]}));
  const sending = f.recovery.send({sessionId: A, text: 'x'});
  await settle();
  stream.push('meta', {scene_id: sceneA, stream_id: 's1'});
  stream.push('reasoning', {scene_id: sceneA, text: 'hmm'});
  await settle();
  stream.close();
  const result = await sending;
  assert.equal(result.streamed, true); assert.equal(result.replies, 0);
  await f.advance(0);
  assert.deepEqual(f.replies(), [[A, '全部']]);
  assert.deepEqual(f.store.rows(A).map(item => item.seq), [70]);
});

test('a stream that is gone after a break is recovered from history', async () => {
  const f = fixture();
  const stream = sse();
  f.on('/api/chat/stream', stream.open);
  f.on('/api/stream/active', json(null, 204));
  f.always('/api/stream/active', json(null, 204));
  f.on('/api/history', json({messages: [row(30, sceneA, '落盘了')]}));
  const sending = f.recovery.send({sessionId: A, text: 'x'});
  await settle();
  stream.push('meta', {scene_id: sceneA, stream_id: 's1'});
  await settle();
  stream.error();
  await sending;
  await settle();
  assert.deepEqual(f.store.rows(A).map(item => item.content), ['落盘了']);
  assert.equal(f.recovery.state().phase, 'idle');
});

test('an unreachable server keeps the recovery intent and retries with backoff', async () => {
  const f = fixture();
  const stream = sse();
  f.on('/api/chat/stream', stream.open);
  f.on('/api/stream/active', () => { throw new Error('offline'); });
  f.on('/api/stream/active', () => { throw new Error('offline'); });
  f.on('/api/stream/active', json({stream_id: 's1', finished: true, next_seq: 3, origin: 'human', events: [replayEvent(1, sceneA, '回'), stopEvent(2, sceneA)]}));
  const sending = f.recovery.send({sessionId: A, text: 'x'});
  await settle();
  stream.push('meta', {scene_id: sceneA, stream_id: 's1'});
  await settle();
  stream.error();
  await sending;
  await settle();
  assert.equal(f.recovery.state().pending, true); assert.equal(f.recovery.state().phase, 'reconnecting');
  await f.advance(2000);
  assert.equal(f.recovery.state().pending, true);
  await f.advance(5000);
  assert.equal(f.recovery.state().pending, false);
  assert.deepEqual(f.replies(), [[A, '回']]);
});

test('the watchdog probes instead of aborting, and cuts over when the server has moved on', async () => {
  const f = fixture();
  const stream = sse();
  f.on('/api/chat/stream', stream.open);
  f.on('/api/stream/active', json({stream_id: 's1', finished: true, next_seq: 4, origin: 'human', events: [replayEvent(2, sceneA, '后半'), stopEvent(3, sceneA)]}));
  const sending = f.recovery.send({sessionId: A, text: 'x'});
  await settle();
  stream.push('meta', {scene_id: sceneA, stream_id: 's1'});
  stream.push('content_block_delta', {scene_id: sceneA, delta: {text: '前半'}});
  await settle();
  // Silence in the text phase for longer than its budget: the socket is dead but the breath is not.
  await f.advance(STALL_MS.text + WATCHDOG);
  const result = await sending;
  assert.equal(result.recovering, 'replay');
  await f.advance(0);
  assert.deepEqual(f.events.filter(event => event.type === 'delta').map(event => event.text), ['前半', '后半']);
  // The live half and the replayed half join into one bubble: not a character repeated or lost.
  assert.deepEqual(f.replies(), [[A, '前半后半']]);
});
const WATCHDOG = 5000;

test('the watchdog respects the slower tool budget', async () => {
  const f = fixture();
  const stream = sse();
  f.on('/api/chat/stream', stream.open);
  const sending = f.recovery.send({sessionId: A, text: 'x'});
  await settle();
  stream.push('meta', {scene_id: sceneA, stream_id: 's1'});
  stream.push('tool_use', {scene_id: sceneA, name: 'run_command'});
  await settle();
  await f.advance(STALL_MS.text + WATCHDOG * 2);
  // Well past the text budget, still inside the tool budget: no probe was made.
  assert.equal(f.calls.filter(call => call.path === '/api/stream/active').length, 0);
  stream.push('tool_result', {scene_id: sceneA});
  stream.push('content_block_delta', {scene_id: sceneA, delta: {text: '好了'}});
  stream.push('message_stop', {scene_id: sceneA});
  stream.close();
  assert.equal((await sending).streamed, true);
});

test('a server that has stalled too is waited on with backoff, then given up on', async () => {
  const f = fixture();
  const stream = sse();
  f.on('/api/chat/stream', stream.open);
  f.always('/api/stream/active', json({stream_id: 's1', finished: false, next_seq: 1, origin: 'human', events: []}));
  f.on('/api/history', json({messages: [row(40, sceneA, '最终落盘')]}));
  const sending = f.recovery.send({sessionId: A, text: 'x'});
  await settle();
  stream.push('meta', {scene_id: sceneA, stream_id: 's1'});
  await settle();
  await f.advance(STALL_MS.awaiting_first + WATCHDOG);
  assert.equal(f.calls.filter(call => call.path === '/api/stream/active').length, 1);
  assert.match(f.states.at(-1), /秒后再检查一次/);
  // Probes back off 30s, 60s, 120s rather than hammering a server that has nothing to say:
  // the first probe fired at 75s, so the next is due at 105s, on the tick at 105s.
  await f.advance(24000);
  assert.equal(f.calls.filter(call => call.path === '/api/stream/active').length, 1);
  await f.advance(WATCHDOG);
  assert.equal(f.calls.filter(call => call.path === '/api/stream/active').length, 2);
  await f.advance(STALL_GIVEUP_MS);
  const result = await sending;
  assert.equal(result.gaveUp, true); assert.equal(result.recovering, 'history');
  await settle();
  assert.deepEqual(f.store.rows(A).map(item => item.content), ['最终落盘']);
});

test('a replay poller that keeps failing hands off to the reconnect path', async () => {
  const f = fixture();
  f.on('/api/stream/active', json({stream_id: 's1', finished: false, next_seq: 2, origin: 'human', events: [replayEvent(1, sceneA, 'x')]}));
  for (let i = 0; i < 6; i++) f.on('/api/stream/active', () => { throw new Error('offline'); });
  await f.recovery.checkActiveStream();
  assert.equal(f.recovery.state().replaying, true);
  await f.advance(60000);
  assert.equal(f.recovery.state().replaying, false);
  assert.equal(f.recovery.state().pending, true);
});

test('an autonomous breath is watched, not replayed, and reconciled when it ends', async () => {
  const f = fixture();
  f.on('/api/stream/active', json({stream_id: 'auto', finished: false, next_seq: 1, origin: 'beating', events: []}));
  f.on('/api/stream/active', json({stream_id: 'auto', finished: false, next_seq: 1, origin: 'beating', events: []}));
  f.on('/api/stream/active', json(null, 204));
  f.on('/api/history', json({messages: [row(50, sceneA, '自己想完了')]}));
  assert.equal(await f.recovery.checkActiveStream(), 'autonomous');
  assert.equal(f.recovery.state().watching, true);
  assert.match(f.states.at(-1), /自己想事情/);
  await f.advance(2000);
  assert.equal(f.recovery.state().watching, true);
  await f.advance(2000);
  assert.equal(f.recovery.state().watching, false);
  assert.deepEqual(f.store.rows(A).map(item => item.content), ['自己想完了']);
  assert.equal(f.recovery.state().phase, 'idle');
});

test('taking over a stream at startup routes our scenes and drops the rest', async () => {
  const f = fixture();
  f.on('/api/stream/active', json({stream_id: 's9', finished: true, next_seq: 5, origin: 'human',
    events: [replayEvent(1, 'loom-being', '别人'), stopEvent(2, 'loom-being'), replayEvent(3, sceneB, 'B 的'), stopEvent(4, sceneB)]}));
  f.on('/api/history', json({messages: [row(60, sceneB, 'B 的')]}));
  assert.equal(await f.recovery.checkActiveStream(), 'cutover');
  await f.advance(0);
  assert.deepEqual(f.replies(), [[B, 'B 的']]);
  assert.deepEqual(f.store.rows(B).map(item => item.seq), [60]);
});

test('cutting over kills a live reader that is still alive (F1)', async () => {
  const f = fixture();
  const stream = sse();
  f.on('/api/chat/stream', stream.open);
  const sending = f.recovery.send({sessionId: A, text: 'x'});
  await settle();
  stream.push('meta', {scene_id: sceneA, stream_id: 's1'});
  await settle();
  f.recovery.cutoverToReplay({streamId: 's1', fromSeq: 1, sessionId: A, initial: {verdict: 'finished', events: [replayEvent(2, sceneA, '接管'), stopEvent(3, sceneA)]}});
  const result = await sending;
  assert.equal(result.recovering, 'replay');
  assert.deepEqual(f.replies(), [[A, '接管']]);
  assert.equal(f.recovery.state().live, false);
});

test('a user who stops reading gets the reply through history, not a probe', async () => {
  const f = fixture();
  const stream = sse();
  f.on('/api/chat/stream', stream.open);
  f.always('/api/stream/active', json(null, 204));
  const controller = new AbortController();
  const sending = f.recovery.send({sessionId: A, text: 'x', signal: controller.signal});
  await settle();
  stream.push('meta', {scene_id: sceneA, stream_id: 's1'});
  await settle();
  controller.abort();
  const result = await sending;
  assert.equal(result.recovering, 'catch-up');
  assert.equal(f.recovery.state().catchingUp, true); assert.equal(f.recovery.state().pending, false);
});

test('reconcile shares one in-flight read, pages increments and reads a baseline once', async () => {
  const f = fixture();
  f.on('/api/history', json({messages: Array.from({length: 100}, (unused, index) => row(index + 1, sceneA, 'x'))}));
  const [one, two] = await Promise.all([f.recovery.reconcile(), f.recovery.reconcile()]);
  assert.equal(one, two);
  assert.equal(f.calls.filter(call => call.path === '/api/history').length, 1);
  assert.equal(f.store.cursor, 100); assert.equal(f.store.seeded, true);
  // An increment that fills its page keeps paging from the new cursor.
  f.on('/api/history', json({messages: Array.from({length: 100}, (unused, index) => row(index + 101, sceneA, 'y'))}));
  f.on('/api/history', json({messages: [row(201, sceneB, 'z')]}));
  const more = await f.recovery.reconcile();
  assert.equal(more.added, 101); assert.equal(f.store.cursor, 201);
  assert.deepEqual(f.calls.filter(call => call.path === '/api/history').map(call => call.after), [null, '100', '200']);
  assert.deepEqual([...more.beings], [A, B]);
});

test('reconcile reports a failed read instead of throwing, and syncCursor retries it', async () => {
  const f = fixture();
  f.on('/api/history', () => { throw new Error('offline'); });
  f.on('/api/history', () => { throw new Error('offline'); });
  f.on('/api/history', json({messages: [row(1, sceneA, 'x')]}));
  const syncing = f.recovery.syncCursor();
  await f.advance(1500);
  const result = await syncing;
  assert.equal(result.error, ''); assert.equal(f.store.cursor, 1);
});

test('the catch-up watcher gives up after its deadline, and says so without blaming anyone', async () => {
  const f = fixture();
  f.on('/api/chat/stream', json({spliced: true}, 202));
  f.always('/api/stream/active', json(null, 204));
  await f.recovery.send({sessionId: A, text: 'x'});
  await f.advance(CATCH_UP_ABSOLUTE_MAX_MS + 30000);
  assert.equal(f.recovery.state().catchingUp, false);
  // Silence is a legitimate outcome the wire cannot distinguish from "not yet": neutral copy.
  assert.deepEqual(f.recovery.state(), {phase: 'idle', sessionId: A, gaveUp: true, hint: '这口气没有留下给这个会话的话。', pending: false, live: false, replaying: false, catchingUp: false, watching: false});
  assert.equal(f.pending(), 0);
});

test('a writer that ends for good settles the bubble it left open', async () => {
  const f = fixture();
  const stream = sse();
  f.on('/api/chat/stream', stream.open);
  f.always('/api/stream/active', json(null, 204));
  f.on('/api/history', json({messages: [row(30, sceneA, '一半')]}));
  const sending = f.recovery.send({sessionId: A, text: 'x'});
  await settle();
  stream.push('meta', {scene_id: sceneA, stream_id: 's1'});
  stream.push('content_block_delta', {scene_id: sceneA, delta: {text: '一半'}});
  await settle();
  stream.error();
  await sending;
  await settle();
  // The stream is gone, so the half-built reply is settled before history is read, exactly once.
  assert.deepEqual(f.events.filter(event => event.type === 'settled').map(event => event.sessionId), [A]);
  assert.deepEqual(f.store.rows(A).map(item => item.content), ['一半']);
  assert.equal(f.recovery.state().phase, 'idle');
});

test('a takeover from seq 0 settles the pending recovery it abandons', async () => {
  const f = fixture();
  const stream = sse();
  f.on('/api/chat/stream', stream.open);
  f.on('/api/chat/stream', json({spliced: true}, 202));
  // A's first probe finds the server unreachable and backs off; B's catch-up probes before that
  // backoff fires, so the whole buffer replays through a fresh router and A's pending is moot.
  f.on('/api/stream/active', () => { throw new Error('offline'); });
  f.on('/api/stream/active', json({stream_id: 's1', finished: true, next_seq: 6, origin: 'human',
    events: [replayEvent(1, sceneA, '一'), replayEvent(2, sceneA, '半句'), stopEvent(3, sceneA), {event: 'meta', seq: 0, data: {continuation: true, scene_id: sceneB}}, replayEvent(4, sceneB, '给B'), stopEvent(5, sceneB)]}));
  f.always('/api/stream/active', json(null, 204));
  const sending = f.recovery.send({sessionId: A, text: 'x'});
  await settle();
  stream.push('meta', {scene_id: sceneA, stream_id: 's1'});
  stream.push('content_block_delta', {scene_id: sceneA, delta: {text: '一'}});
  await settle();
  stream.error();
  assert.equal((await sending).recovering, 'probe');
  await settle();
  assert.equal(f.recovery.state().pending, true);
  await f.recovery.send({sessionId: B, text: 'y'});
  await settle();
  assert.equal(f.recovery.state().pending, false);
  // A's half bubble is settled before the replay rebuilds it whole; nothing is shown twice.
  assert.deepEqual(f.events.filter(event => ['settled', 'reply'].includes(event.type)).map(event => `${event.type}:${event.sessionId === A ? 'A' : 'B'}:${event.text || ''}`),
    ['settled:A:', 'reply:A:一半句', 'reply:B:给B']);
  await f.advance(10000);
  assert.equal(f.calls.filter(call => call.path === '/api/stream/active' && call.after === '1').length, 1);
});

test('dispose stops every timer and aborts the live reader', async () => {
  const f = fixture();
  const stream = sse();
  f.on('/api/chat/stream', stream.open);
  f.always('/api/stream/active', json(null, 204));
  const sending = f.recovery.send({sessionId: A, text: 'x'});
  await settle();
  stream.push('meta', {scene_id: sceneA, stream_id: 's1'});
  await settle();
  f.recovery.dispose();
  const result = await sending;
  assert.equal(result.gaveUp, true);
  assert.equal(f.pending(), 0);
  assert.equal(f.recovery.state().phase, 'idle');
});

test('a Being that goes away mid-recovery abandons it quietly', async () => {
  const f = fixture();
  f.on('/api/stream/active', json({}, 403));
  f.recovery.queueDisconnectRecovery({streamId: 's1', localSeq: 3, sessionId: A});
  await settle();
  assert.equal(f.recovery.state().pending, false);
  assert.equal(f.recovery.state().phase, 'idle');
});
