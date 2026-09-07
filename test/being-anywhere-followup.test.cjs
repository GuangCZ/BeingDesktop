'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const clientModule = import('../extensions/being-anywhere/being-client.mjs');
const followupModule = import('../extensions/being-anywhere/reply-followup.mjs');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const sse = (...events) => new Response(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
const item = (seq, event, data = {}) => ({ seq, event, data });
const delta = (text) => ({ delta: { text } });
const active = (events, finished = false, streamId = 'mine', nextSeq = events.at(-1)?.seq + 1 || 1) => ({ stream_id: streamId, finished, next_seq: nextSeq, events });
const baseline = [{ role: 'user', content: 'Older question', seq: 1 }, { role: 'being', content: 'Older reply', seq: 2 }];
const submitted = { role: 'user', content: 'My question', seq: 3 };
const reply = (content, seq = 4) => ({ role: 'being', content, seq });

async function fixture({ snapshots = [], history = [...baseline, submitted], post = () => json({ spliced: true }, 202), baselineStream = null, baselineHistory = baseline } = {}) {
  const { BeingClient } = await clientModule;
  const { sendAndFollow } = await followupModule;
  const calls = [];
  const events = [];
  const states = [];
  const waits = [];
  let posts = 0;
  let polls = 0;
  const client = new BeingClient('https://fixture.example/loom?token=private-token', async (url, options) => {
    const route = new URL(url);
    calls.push({ path: route.pathname, after: route.searchParams.get('after'), method: options.method, signal: options.signal });
    if (options.method === 'POST') { posts += 1; return post(options); }
    if (route.pathname.endsWith('/api/history')) {
      const result = !posts ? baselineHistory : typeof history === 'function' ? history(polls) : history;
      if (result instanceof Error) throw result;
      return json({ messages: result });
    }
    assert.ok(route.pathname.endsWith('/api/stream/active'));
    const result = !posts ? baselineStream : snapshots[polls++];
    if (result === undefined) throw new Error('Missing fixture snapshot');
    if (result instanceof Error) throw result;
    return result === null ? new Response(null, { status: 204 }) : json(result);
  });
  return {
    events, states, waits, calls, posts: () => posts,
    send: (extra = {}) => sendAndFollow(client, { message: 'My question', onEvent: (event) => events.push(event), onState: (state) => states.push(state), wait: async (ms) => { waits.push(ms); }, ...extra })
  };
}

test('accepted sends stream correlated replay once and wait for finished beyond multiple message_stop events', async () => {
  const f = await fixture({ snapshots: [
    active([item(1, 'thinking', { text: 'Considering it' })]),
    active([item(1, 'thinking', { text: 'Considering it' }), item(2, 'content_block_delta', delta('First')), item(3, 'message_stop', { session_id: 'session-1' })]),
    active([item(4, 'tool_use', { name: 'browse_web' }), item(5, 'tool_result', { content: 'Found' }), item(6, 'content_block_delta', delta('Second')), item(7, 'message_stop', { session_id: 'session-2' })], false),
    active([], true, 'mine', 8)
  ] });
  assert.deepEqual(await f.send(), { accepted: true, completed: true });
  assert.equal(f.posts(), 1);
  assert.deepEqual(f.events.filter((event) => event.type === 'content_block_delta').map((event) => event.data.delta.text), ['First', 'Second']);
  assert.equal(f.events.filter((event) => event.type === 'message_stop').length, 2);
  assert.equal(f.events.filter((event) => event.type === 'thinking').length, 1);
  assert.deepEqual(f.calls.filter((call) => call.path.endsWith('/active')).map((call) => call.after), [null, '0', '1', '3', '7']);
  assert.deepEqual(f.waits, [500, 500, 500]);
});

test('accepted splice excludes the pre-submit buffer and remainder of an older unfinished reply', async () => {
  const f = await fixture({
    baselineStream: active([item(1, 'content_block_delta', delta('Old reply prefix'))], false, 'old-breath'),
    snapshots: [active([
      item(1, 'content_block_delta', delta('Old reply prefix')),
      item(2, 'content_block_delta', delta('Old reply remainder')),
      item(3, 'message_stop'), item(4, 'thinking', { text: 'Now considering this question' }),
      item(5, 'content_block_delta', delta('My actual reply')), item(6, 'message_stop')
    ], true, 'old-breath')]
  });
  assert.deepEqual(await f.send(), { accepted: true, completed: true });
  assert.deepEqual(f.events.map((event) => event.type), ['thinking', 'content_block_delta', 'message_stop']);
  assert.equal(f.events[1].data.delta.text, 'My actual reply');
  assert.equal(f.calls.at(-2).after, '1');
});

test('accepted splice can follow the next reply after an already completed baseline boundary', async () => {
  const f = await fixture({
    baselineStream: active([item(1, 'content_block_delta', delta('Old')), item(2, 'message_stop')]),
    snapshots: [active([item(3, 'content_block_delta', delta('Mine')), item(4, 'message_stop')], true)]
  });
  assert.equal((await f.send()).completed, true);
  assert.deepEqual(f.events.filter((event) => event.type === 'content_block_delta').map((event) => event.data.delta.text), ['Mine']);
});

test('missing, duplicated, or unsequenced user anchors never fabricate an answer or completion', async () => {
  for (const history of [baseline, [...baseline, { ...submitted, seq: 0 }], [...baseline, submitted, { ...submitted, seq: 4 }]]) {
    const f = await fixture({ history, snapshots: [active([item(1, 'content_block_delta', delta('Unrelated')), item(2, 'message_stop')], true)] });
    assert.deepEqual(await f.send(), { accepted: true, unconfirmed: true });
    assert.equal(f.posts(), 1);
    assert.deepEqual(f.events, []);
    assert.equal(f.states.at(-1), 'unconfirmed');
  }
});

test('an anchor that appears on a later history snapshot unlocks replay without resending', async () => {
  const f = await fixture({
    history: (polls) => polls < 2 ? baseline : [...baseline, submitted],
    snapshots: [active([item(1, 'thinking', { text: 'Starting' })]), active([item(1, 'thinking', { text: 'Starting' }), item(2, 'content_block_delta', delta('Mine')), item(3, 'message_stop')], true)]
  });
  assert.equal((await f.send()).completed, true);
  assert.equal(f.posts(), 1);
  assert.equal(f.events.filter((event) => event.type === 'thinking').length, 1);
});

test('history recovery ends at the next user and never attributes that later reply to this request', async () => {
  for (const mine of [[], [reply('My own reply')]]) {
    const f = await fixture({
      history: [...baseline, submitted, ...mine, { role: 'user', content: 'Different user turn', seq: 5 }, reply('Other reply', 6)],
      snapshots: [active([item(1, 'content_block_delta', delta('Other replay')), item(2, 'message_stop')], true, 'another')]
    });
    assert.deepEqual(await f.send(), mine.length ? { accepted: true, completed: true } : { accepted: true, unconfirmed: true });
    assert.deepEqual(f.events.filter((event) => event.type === 'content_block_delta').map((event) => event.data.delta.text), mine.map((row) => row.content));
  }
});

test('cleared replay recovers only new anchored persisted messages', async () => {
  const f = await fixture({ history: [...baseline, submitted, reply('Completed answer')], snapshots: [null] });
  assert.deepEqual(await f.send(), { accepted: true, completed: true });
  assert.deepEqual(f.events, [{ type: 'content_block_delta', data: delta('Completed answer') }, { type: 'message_stop', data: {} }]);
});

test('normal live SSE emits before EOF and the default result remains unchanged', async () => {
  const encoder = new TextEncoder();
  let streamController;
  let firstEvent;
  const first = new Promise((resolve) => { firstEvent = resolve; });
  const f = await fixture({ post: () => new Response(new ReadableStream({ start(controller) { streamController = controller; } }), { headers: { 'Content-Type': 'text/event-stream' } }) });
  const result = f.send({ onEvent: (event) => { f.events.push(event); firstEvent(); } });
  while (!streamController) await Promise.resolve();
  streamController.enqueue(encoder.encode('event: content_block_delta\ndata: {"delta":{"text":"Arrives now"}}\n\n'));
  await first;
  assert.equal(f.events[0].data.delta.text, 'Arrives now');
  assert.equal(f.calls.filter((call) => call.path.endsWith('/active')).length, 1);
  streamController.enqueue(encoder.encode('event: message_stop\ndata: {}\n\n'));
  streamController.close();
  assert.deepEqual(await result, { accepted: false });
  assert.equal(f.posts(), 1);
});

test('a dropped live stream resumes by stream ID and counts unsupported frames in its cursor', async () => {
  const f = await fixture({
    post: () => sse(['meta', { stream_id: 'mine' }], ['content_block_delta', delta('Part')], ['usage', { tokens: 4 }]),
    snapshots: [active([item(1, 'content_block_delta', delta('Part')), item(2, 'usage', { tokens: 4 }), item(3, 'content_block_delta', delta('ial answer')), item(4, 'message_stop')], true)]
  });
  assert.deepEqual(await f.send(), { accepted: false, completed: true });
  assert.equal(f.posts(), 1);
  assert.deepEqual(f.events.filter((event) => event.type === 'content_block_delta').map((event) => event.data.delta.text), ['Part', 'ial answer']);
  assert.equal(f.calls.find((call) => call.after !== null)?.after, '2');
  assert.ok(f.states.includes('reconnecting'));
});

test('ring-buffer gaps append only a verified history suffix and reject conflicting history', async () => {
  for (const finalText of ['Partial complete answer', 'Conflicting answer']) {
    const f = await fixture({
      post: () => sse(['meta', { stream_id: 'mine' }], ['content_block_delta', delta('Partial')]),
      history: [...baseline, submitted, reply(finalText)],
      snapshots: [active([item(7, 'message_stop')], true)]
    });
    assert.deepEqual(await f.send(), finalText.startsWith('Partial') ? { accepted: false, completed: true } : { accepted: false, unconfirmed: true });
    assert.equal(f.events.filter((event) => event.type === 'content_block_delta').map((event) => event.data.delta.text).join(''), finalText.startsWith('Partial') ? finalText : 'Partial');
  }
});

test('persisted intermediate replies do not mark an unfinished breath complete after a replay gap', async () => {
  const f = await fixture({
    history: [...baseline, submitted, reply('An intermediate reply')],
    snapshots: [active([item(7, 'message_stop')], false)]
  });
  assert.deepEqual(await f.send(), { accepted: true, unconfirmed: true });
  assert.equal(f.states.at(-1), 'unconfirmed');
  assert.equal(f.posts(), 1);
});

test('an older unfinished reply persisted after a spliced user anchor is not attributed to that user', async () => {
  const f = await fixture({
    baselineStream: active([item(1, 'content_block_delta', delta('An older'))]),
    history: [...baseline, submitted, reply('An older answer')],
    snapshots: [active([item(2, 'content_block_delta', delta(' answer')), item(3, 'message_stop')], true)]
  });
  assert.deepEqual(await f.send(), { accepted: true, unconfirmed: true });
  assert.deepEqual(f.events, []);
});

test('a replacement stream is never appended as a continuation of the owned stream', async () => {
  const f = await fixture({
    post: () => sse(['meta', { stream_id: 'mine' }], ['content_block_delta', delta('My partial')]),
    snapshots: [active([item(1, 'content_block_delta', delta('Unrelated')), item(2, 'message_stop')], true, 'replacement')]
  });
  assert.deepEqual(await f.send(), { accepted: false, unconfirmed: true });
  assert.equal(f.events.filter((event) => event.type === 'content_block_delta').map((event) => event.data.delta.text).join(''), 'My partial');
});

test('network failures are bounded and use only GET after the single accepted POST', async () => {
  const f = await fixture({ snapshots: Array.from({ length: 6 }, () => new Error('private endpoint and token')) });
  assert.deepEqual(await f.send(), { accepted: true, unconfirmed: true });
  assert.equal(f.posts(), 1);
  assert.equal(f.waits.length, 5);
  assert.deepEqual(f.states, ['waiting', 'reconnecting', 'unconfirmed']);
  assert.doesNotMatch(JSON.stringify(f.events), /private/u);
});

test('empty polls preserve an active tool phase and a restored connection resumes that phase', async () => {
  const f = await fixture({ snapshots: [
    active([item(1, 'tool_use', { name: 'browse_web' })]),
    active([], false, 'mine', 2),
    new Error('Temporary disconnection'),
    active([], false, 'mine', 2),
    active([item(2, 'content_block_delta', delta('Done')), item(3, 'message_stop')], true)
  ] });
  assert.equal((await f.send()).completed, true);
  assert.deepEqual(f.states, ['waiting', 'reconnecting', 'acting']);
});

test('abort interrupts pending JSON and SSE reads and cancels their underlying body', async () => {
  const { BeingClient, consumeSSE } = await clientModule;
  for (const format of ['json', 'sse']) {
    const controller = new AbortController();
    let cancelled = false;
    let entered;
    const reading = new Promise((resolve) => { entered = resolve; });
    const body = new ReadableStream({
      pull() { entered(); },
      cancel() { cancelled = true; }
    });
    const client = new BeingClient('https://fixture.example', async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }));
    const result = format === 'json' ? client.readActiveStream({ signal: controller.signal }) : consumeSSE(body, () => {}, { signal: controller.signal });
    await reading;
    controller.abort('Private reason');
    await assert.rejects(result, (error) => error.name === 'AbortError' && !error.message.includes('Private'));
    assert.equal(cancelled, true, format);
    assert.equal(body.locked, false, format);
  }
});

test('server stream errors remain errors and never trigger resending or replay', async () => {
  const f = await fixture({ post: () => sse(['meta', { stream_id: 'mine' }], ['error', { message: 'private data' }]) });
  await assert.rejects(f.send(), /回复中断/u);
  assert.equal(f.posts(), 1);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/active')).length, 1);
  assert.doesNotMatch(JSON.stringify(f.events), /private data/u);
});

test('an aborted polling wait releases its timer and never schedules another GET', async () => {
  const { waitForFollowup } = await followupModule;
  const controller = new AbortController();
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const f = await fixture({ snapshots: [active([item(1, 'thinking', { text: 'Working' })])] });
  const result = f.send({ signal: controller.signal, wait: (ms, signal) => { const pending = waitForFollowup(ms, signal); entered(); return pending; } });
  await waiting;
  const calls = f.calls.length;
  controller.abort('private cancellation reason');
  await assert.rejects(result, (error) => error.name === 'AbortError' && !error.message.includes('private'));
  assert.equal(f.calls.length, calls);
  assert.equal(f.posts(), 1);
});

test('pre-aborted requests perform no read or POST', async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.send({ signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(f.calls, []);
});

test('active replay schema rejects unsafe cursors and malformed or oversized replay entries', async () => {
  const { BeingClient } = await clientModule;
  for (const value of [null, [], {}, { finished: false }, active([item(0, 'thinking')]), active([item(1, 'thinking'), item(1, 'thinking')]), active([item(1, 'thinking', null)]), active([item(1, 'thinking')], true, 's', 1), active(Array.from({ length: 2001 }, (_, index) => item(index + 1, 'thinking')))]) {
    const client = new BeingClient('https://fixture.example', async () => json(value));
    await assert.rejects(client.readActiveStream(), /无法识别/u);
  }
  let calls = 0;
  const client = new BeingClient('https://fixture.example', async () => { calls += 1; return new Response(null, { status: 204 }); });
  for (const after of [-1, NaN, '3', Infinity]) await assert.rejects(client.readActiveStream({ after }), /无法识别/u);
  assert.equal(calls, 0);
  assert.equal(await client.readActiveStream({ after: 0 }), null);
});
