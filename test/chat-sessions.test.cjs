'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {ChatSessions} = require('../src/chat-sessions.cjs');
const {sceneId} = require('../src/being-chat.cjs');

const DESKTOP = '11111111-1111-4111-8111-111111111111';
const token = 'c'.repeat(64);
const json = (value, status = 200) => () => new Response(value === null ? null : JSON.stringify(value), {status, headers: value === null ? {} : {'Content-Type': 'application/json'}});
const sse = frames => () => new Response(frames.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {headers: {'Content-Type': 'text/event-stream'}});
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)); };

function fixture({disk = null} = {}) {
  let now = 1_000_000, id = 0, uuid = 0;
  const queue = new Map();
  const timers = {setTimeout: (fn, ms) => { const t = ++id; queue.set(t, {at: now + ms, fn}); return t; }, clearTimeout: t => queue.delete(t)};
  const advance = async ms => {
    const target = now + ms; await settle();
    while (true) {
      const next = [...queue.entries()].filter(([, entry]) => entry.at <= target).sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      queue.delete(next[0]); now = next[1].at; await next[1].fn(); await settle();
    }
    now = target; await settle();
  };
  const routes = new Map(), defaults = new Map(), calls = [];
  const on = (path, responder) => { if (!routes.has(path)) routes.set(path, []); routes.get(path).push(responder); };
  const always = (path, responder) => defaults.set(path, responder);
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url), path = parsed.pathname.replace(/^\/cz_being/, '');
    calls.push({path, body: options.body ? JSON.parse(options.body) : null});
    const responder = routes.get(path)?.shift() || defaults.get(path);
    if (!responder) throw new Error(`no route: ${path}`);
    return responder(parsed, options);
  };
  let stored = disk; const saves = [];
  const cache = {load: async () => stored, save: async (key, value) => { saves.push(value); stored = value; return true; }};
  const context = {connected: true, connection: {url: `https://echo.beings.town/cz_being/?token=${token}`}, revision: 1};
  const events = [], states = [];
  const sessions = new ChatSessions({getContext: () => context, desktopId: DESKTOP, cache, clientVersion: '0.8.24', fetchImpl, timers, clock: () => now,
    randomUUID: () => `${String(++uuid).padStart(8, '0')}-0000-4000-8000-000000000000`,
    onEvent: event => events.push(event), onState: state => states.push(state)});
  always('/api/history', json({messages: []}));
  always('/api/stream/active', json(null, 204));
  return {sessions, events, states, calls, on, always, advance, disk: () => stored, saves};
}

test('starting binds an identity, seeds a first conversation and reads the baseline', async () => {
  const f = fixture();
  f.on('/api/history', json({messages: [{seq: 1, role: 'user', content: '早', at: 't', scene_id: sceneId(DESKTOP, '00000001-0000-4000-8000-000000000000')}]}));
  const snapshot = await f.sessions.start('identity-a');
  assert.equal(snapshot.open, true); assert.equal(snapshot.sessions.length, 1); assert.equal(snapshot.active, snapshot.sessions[0].id);
  assert.equal(snapshot.cursor, 1); assert.equal(snapshot.seeded, true);
  assert.deepEqual(f.sessions.view(snapshot.active).rows.map(row => row.content), ['早']);
  assert.equal(f.calls.filter(call => call.path === '/api/stream/active').length, 1);
});

test('a sent message shows at once, streams its reply, and both are confirmed by history', async () => {
  const f = fixture();
  await f.sessions.start('identity-a');
  const id = f.sessions.snapshot().active, scene = sceneId(DESKTOP, id);
  f.on('/api/chat/stream', sse([['meta', {scene_id: scene, stream_id: 's1'}], ['reasoning', {scene_id: scene, text: '想'}],
    ['content_block_delta', {scene_id: scene, delta: {text: '你好'}}], ['message_stop', {scene_id: scene}]]));
  // History has not caught up yet on the first sync; the confirming rows land on the reload.
  f.on('/api/history', json({messages: []}));
  const sending = f.sessions.send({sessionId: id, text: '在吗'});
  await settle();
  // The body carries the human text, the scene and its label — nothing else.
  const post = f.calls.find(call => call.path === '/api/chat/stream').body;
  assert.deepEqual(post, {message: '在吗', scene_id: scene, scene_meta: {client: 'being-desktop/0.8.24', scene_label: '新会话'}, client_ref: post.client_ref});
  const result = await sending;
  assert.equal(result.streamed, true);
  await f.advance(0);
  const before = f.sessions.view(id);
  assert.deepEqual(before.sent.map(item => item.text), ['在吗']);
  assert.deepEqual(before.replied.map(item => [item.text, item.think]), [['你好', '想']]);
  f.on('/api/history', json({messages: [{seq: 5, role: 'user', content: '在吗', at: 't', scene_id: scene}, {seq: 6, role: 'assistant', content: '你好', at: 't', scene_id: scene}]}));
  await f.sessions.reload();
  const after = f.sessions.view(id);
  // History confirmed both: the transient items retire and the durable rows take their place.
  assert.deepEqual(after.rows.map(row => [row.role, row.content]), [['user', '在吗'], ['being', '你好']]);
  assert.deepEqual(after.sent, []); assert.deepEqual(after.replied, []); assert.equal(after.live, null);
  assert.deepEqual(f.events.map(event => event.type), ['sent', 'meta', 'think', 'delta', 'reply']);
});

test('a live reply is visible while streaming', async () => {
  const f = fixture();
  await f.sessions.start('identity-a');
  const id = f.sessions.snapshot().active, scene = sceneId(DESKTOP, id);
  let controller;
  f.on('/api/chat/stream', () => new Response(new ReadableStream({start(c) { controller = c; }}), {headers: {'Content-Type': 'text/event-stream'}}));
  const sending = f.sessions.send({sessionId: id, text: 'x'});
  await settle();
  controller.enqueue(new TextEncoder().encode(`event: meta\ndata: ${JSON.stringify({scene_id: scene, stream_id: 's1'})}\n\nevent: content_block_delta\ndata: ${JSON.stringify({scene_id: scene, delta: {text: '正在'}})}\n\n`));
  await settle();
  assert.equal(f.sessions.view(id).live.text, '正在');
  assert.equal(f.sessions.snapshot().sessions[0].busy, true);
  controller.enqueue(new TextEncoder().encode(`event: message_stop\ndata: ${JSON.stringify({scene_id: scene})}\n\n`));
  controller.close();
  await sending;
  assert.equal(f.sessions.view(id).live, null);
});

test('a spliced send stays visible as sent and reports it was delivered', async () => {
  const f = fixture();
  await f.sessions.start('identity-a');
  const id = f.sessions.snapshot().active;
  f.on('/api/chat/stream', json({spliced: true}, 202));
  const result = await f.sessions.send({sessionId: id, text: '排队'});
  assert.deepEqual(result, {ok: true, streamed: false, spliced: true, recovering: ''});
  assert.deepEqual(f.sessions.view(id).sent.map(item => item.text), ['排队']);
  assert.equal(f.sessions.snapshot().recovery.catchingUp, true);
});

test('a send that never left is withdrawn from the transcript', async () => {
  const f = fixture();
  await f.sessions.start('identity-a');
  const id = f.sessions.snapshot().active;
  f.on('/api/chat/stream', json({}, 500));
  await assert.rejects(f.sessions.send({sessionId: id, text: '没发出去'}), {code: 'SERVICE_ERROR'});
  assert.deepEqual(f.sessions.view(id).sent, []);
});

test('a reply cut off mid-stream stays as a partial until history settles it', async () => {
  const f = fixture();
  await f.sessions.start('identity-a');
  const id = f.sessions.snapshot().active, scene = sceneId(DESKTOP, id);
  let controller;
  f.on('/api/chat/stream', () => new Response(new ReadableStream({start(c) { controller = c; }}), {headers: {'Content-Type': 'text/event-stream'}}));
  const sending = f.sessions.send({sessionId: id, text: 'x'});
  await settle();
  controller.enqueue(new TextEncoder().encode(`event: meta\ndata: ${JSON.stringify({scene_id: scene, stream_id: 's1'})}\n\nevent: content_block_delta\ndata: ${JSON.stringify({scene_id: scene, delta: {text: '说到一半的一句很长的话，'}})}\n\n`));
  await settle();
  f.on('/api/history', json({messages: [{seq: 5, role: 'assistant', content: '说到一半的一句很长的话，后面还有', at: 't', scene_id: scene}]}));
  controller.error(new TypeError('socket reset'));
  await sending;
  await settle();
  // The stream is gone: no cursor blinking forever, the text so far is a partial, and the durable
  // row it is a prefix of confirms it.
  const view = f.sessions.view(id);
  assert.equal(view.live, null);
  assert.deepEqual(view.replied, []);
  assert.deepEqual(view.rows.map(row => row.content), ['说到一半的一句很长的话，后面还有']);
});

test('confirmation tolerates a prefix in either direction, but not a short one', async () => {
  const f = fixture();
  await f.sessions.start('identity-a');
  const id = f.sessions.snapshot().active, scene = sceneId(DESKTOP, id);
  f.on('/api/chat/stream', json({spliced: true}, 202));
  await f.sessions.send({sessionId: id, text: '好'});
  f.on('/api/chat/stream', json({spliced: true}, 202));
  await f.sessions.send({sessionId: id, text: '这一条足够长，长到服务端截掉了结尾也认得出来'});
  f.on('/api/history', json({messages: [
    {seq: 1, role: 'user', content: '好的，我知道了', at: 't', scene_id: scene},
    {seq: 2, role: 'user', content: '这一条足够长，长到服务端截掉了结尾', at: 't', scene_id: scene}]}));
  await f.sessions.reload();
  // 「好」 is a prefix of row 1 but too short to prove anything; the long one is confirmed by a
  // row that is a prefix of it (the server trimmed the tail).
  assert.deepEqual(f.sessions.view(id).sent.map(item => item.text), ['好']);
});

test('transient items nobody confirms expire instead of lingering', async () => {
  const f = fixture();
  await f.sessions.start('identity-a');
  const id = f.sessions.snapshot().active, scene = sceneId(DESKTOP, id);
  f.on('/api/chat/stream', json({spliced: true}, 202));
  await f.sessions.send({sessionId: id, text: '幽灵'});
  for (let seq = 1; seq <= 3; seq++) {
    f.on('/api/history', json({messages: [{seq, role: 'assistant', content: `别的 ${seq}`, at: 't', scene_id: scene}]}));
    await f.sessions.reload();
  }
  assert.deepEqual(f.sessions.view(id).sent, []);
});

test('a reply that called tools is confirmed by its final text block, and remembers what it followed', async () => {
  const f = fixture();
  f.on('/api/history', json({messages: [{seq: 3, role: 'user', content: '上一轮', at: 't', scene_id: sceneId(DESKTOP, '00000001-0000-4000-8000-000000000000')}]}));
  await f.sessions.start('identity-a');
  const id = f.sessions.snapshot().active, scene = sceneId(DESKTOP, id);
  // Measured 2026-09-11: after 「我去翻记忆。」→ remember → 「翻完了…」 the Being stores 「翻完了…」 alone.
  f.on('/api/chat/stream', sse([['meta', {scene_id: scene, stream_id: 's1'}],
    ['content_block_delta', {scene_id: scene, delta: {text: '我去翻记忆。'}}],
    ['tool_use', {scene_id: scene, name: 'remember', input: '{"query":"时间线"}'}], ['tool_result', {scene_id: scene, name: 'remember'}],
    ['content_block_delta', {scene_id: scene, delta: {text: '翻完了，这次 remember 没有命中，'}}], ['content_block_delta', {scene_id: scene, delta: {text: '只找到旁边的几条。'}}],
    ['message_stop', {scene_id: scene}]]));
  f.on('/api/history', json({messages: []}));
  await f.sessions.send({sessionId: id, text: '回忆一下'});
  await f.advance(0);
  const view = f.sessions.view(id);
  // The whole of what was said stays visible until history speaks; both items follow row 3.
  assert.deepEqual(view.replied.map(item => [item.text, item.final, item.after]), [['我去翻记忆。翻完了，这次 remember 没有命中，只找到旁边的几条。', '翻完了，这次 remember 没有命中，只找到旁边的几条。', 3]]);
  assert.deepEqual(view.sent.map(item => item.after), [3]);
  assert.equal(view.replied[0].at, new Date(1_000_000).toISOString());
  f.on('/api/history', json({messages: [{seq: 3, role: 'user', content: '上一轮', at: 't', scene_id: scene}, {seq: 4, role: 'user', content: '回忆一下', at: 't', scene_id: scene}, {seq: 7, role: 'assistant', content: '翻完了，这次 remember 没有命中，只找到旁边的几条。', at: 't', scene_id: scene}]}));
  await f.sessions.reload();
  assert.deepEqual(f.sessions.view(id).replied, []);
  assert.deepEqual(f.sessions.view(id).rows.map(row => row.seq), [3, 4, 7]);
});

test('a reply history already holds retires the moment it closes', async () => {
  const f = fixture();
  await f.sessions.start('identity-a');
  const id = f.sessions.snapshot().active, scene = sceneId(DESKTOP, id);
  let controller;
  f.on('/api/chat/stream', () => new Response(new ReadableStream({start(c) { controller = c; }}), {headers: {'Content-Type': 'text/event-stream'}}));
  const sending = f.sessions.send({sessionId: id, text: '慢一点'});
  await settle();
  controller.enqueue(new TextEncoder().encode(`event: meta\ndata: ${JSON.stringify({scene_id: scene, stream_id: 's1'})}\n\nevent: content_block_delta\ndata: ${JSON.stringify({scene_id: scene, delta: {text: '这一句先到了记录里'}})}\n\n`));
  await settle();
  // A read lands the row while the bubble is still open (another window reconciled, say).
  f.on('/api/history', json({messages: [{seq: 5, role: 'user', content: '慢一点', at: 't', scene_id: scene}, {seq: 6, role: 'assistant', content: '这一句先到了记录里', at: 't', scene_id: scene}]}));
  await f.sessions.reload();
  assert.equal(f.sessions.view(id).live.text, '这一句先到了记录里');
  controller.enqueue(new TextEncoder().encode(`event: message_stop\ndata: ${JSON.stringify({scene_id: scene})}\n\n`));
  controller.close();
  await sending;
  await f.advance(0);
  // No duplicate bubble under the row, and no wait for the next read.
  assert.deepEqual(f.sessions.view(id).replied, []);
  assert.equal(f.sessions.view(id).live, null);
});

test('expiry counts reads that landed rows, per item, and ignores renames', async () => {
  const f = fixture();
  await f.sessions.start('identity-a');
  const id = f.sessions.snapshot().active, scene = sceneId(DESKTOP, id);
  f.on('/api/chat/stream', json({spliced: true}, 202));
  await f.sessions.send({sessionId: id, text: '幽灵'});
  // Metadata changes are not evidence: the message is still waiting for its row.
  for (const title of ['一', '二', '三']) f.sessions.rename(id, title);
  await settle();
  assert.deepEqual(f.sessions.view(id).sent.map(item => item.text), ['幽灵']);
  // Neither are reads that land nothing new for this conversation.
  for (let pass = 0; pass < 3; pass++) { f.on('/api/history', json({messages: []})); await f.sessions.reload(); }
  assert.deepEqual(f.sessions.view(id).sent.map(item => item.text), ['幽灵']);
  // A neighbour being confirmed no longer gives the ghost another life.
  f.on('/api/chat/stream', json({spliced: true}, 202));
  await f.sessions.send({sessionId: id, text: '正常'});
  f.on('/api/history', json({messages: [{seq: 1, role: 'user', content: '正常', at: 't', scene_id: scene}]}));
  await f.sessions.reload();
  for (let seq = 2; seq <= 3; seq++) {
    f.on('/api/history', json({messages: [{seq, role: 'assistant', content: `别的 ${seq}`, at: 't', scene_id: scene}]}));
    await f.sessions.reload();
  }
  assert.deepEqual(f.sessions.view(id).sent, []);
});

test('conversations are created, selected, renamed and forgotten, and persist', async () => {
  const f = fixture();
  await f.sessions.start('identity-a');
  const first = f.sessions.snapshot().active;
  const second = f.sessions.create({title: '  第二个  '});
  assert.equal(f.sessions.snapshot().active, second);
  assert.equal(f.sessions.rename(second, '改名'), true);
  assert.throws(() => f.sessions.rename(second, ''), {code: 'INVALID_REQUEST'});
  assert.equal(f.sessions.select(first), true);
  assert.throws(() => f.sessions.select('cccccccc-cccc-4ccc-8ccc-cccccccccccc'), {code: 'INVALID_REQUEST'});
  assert.equal(f.sessions.forget(second), true);
  assert.deepEqual(f.sessions.snapshot().sessions.map(session => session.id), [first]);
  await settle();
  // The list is persisted with the transcripts: a fresh start on the same identity sees it.
  const again = fixture({disk: f.disk()});
  const snapshot = await again.sessions.start('identity-a');
  assert.deepEqual(snapshot.sessions.map(session => session.id), [first]); assert.equal(snapshot.active, first);
  // Forgetting the last conversation leaves a fresh one rather than an empty list.
  again.sessions.forget(first);
  assert.equal(again.sessions.snapshot().sessions.length, 1);
});

test('stop names the conversation whose breath it refused to interrupt', async () => {
  const f = fixture();
  await f.sessions.start('identity-a');
  const a = f.sessions.snapshot().active, b = f.sessions.create({title: '乙'});
  f.on('/api/stream/active', json({stream_id: 's1', finished: false, next_seq: 2, origin: 'human', events: [{event: 'reasoning', seq: 1, data: {scene_id: sceneId(DESKTOP, b), text: 'x'}}]}));
  const refused = await f.sessions.stop({sessionId: a});
  assert.equal(refused.stopped, false); assert.equal(refused.reason, 'other-scene'); assert.equal(refused.ownerTitle, '乙');
  f.on('/api/stop', json({ok: true}));
  assert.equal((await f.sessions.stop({sessionId: a, force: true})).stopped, true);
});

test('stopping the binding disposes recovery and forgets everything in memory', async () => {
  const f = fixture();
  await f.sessions.start('identity-a');
  const id = f.sessions.snapshot().active;
  f.on('/api/chat/stream', json({spliced: true}, 202));
  await f.sessions.send({sessionId: id, text: 'x'});
  f.sessions.end();
  assert.equal(f.sessions.open, false);
  assert.throws(() => f.sessions.view(id), {code: 'NOT_CONNECTED'});
  await assert.rejects(f.sessions.send({sessionId: id, text: 'x'}), {code: 'NOT_CONNECTED'});
  assert.equal(f.sessions.snapshot().sessions.length, 0);
});

// Measured 2026-09-11: images reach the Being as content blocks and never come back — history
// holds the text alone. The previews ride the pending item, then move onto the row that confirms it.
test('a message with images is sent as content blocks, and its previews land on the confirming row', async () => {
  const f = fixture();
  // The same words were sent once before, without images: that row must not take the previews.
  f.on('/api/history', json({messages: [{seq: 3, role: 'user', content: '这是什么？', at: 't', scene_id: sceneId(DESKTOP, '00000001-0000-4000-8000-000000000000')}]}));
  await f.sessions.start('identity-a');
  const id = f.sessions.snapshot().active, scene = sceneId(DESKTOP, id);
  f.on('/api/chat/stream', sse([['meta', {scene_id: scene, stream_id: 's1'}], ['content_block_delta', {scene_id: scene, delta: {text: '黄底绿圆'}}], ['message_stop', {scene_id: scene}]]));
  f.on('/api/history', json({messages: []}));
  const data = Buffer.from('png').toString('base64'), thumb = `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`;
  const result = await f.sessions.send({sessionId: id, text: '这是什么？', images: [{media_type: 'image/png', data, name: 'probe.png', thumb}, {media_type: 'image/webp', data, thumb: 'not a data url'}]});
  assert.equal(result.streamed, true);
  const post = f.calls.find(call => call.path === '/api/chat/stream').body;
  assert.deepEqual(post.content, [{type: 'text', text: '这是什么？'}, {type: 'image', media_type: 'image/png', data}, {type: 'image', media_type: 'image/webp', data}]);
  assert.equal(post.message, undefined);
  assert.deepEqual(f.events[0], {sessionId: id, type: 'sent', text: '这是什么？', images: 2});
  await f.advance(0);
  const pending = f.sessions.view(id).sent;
  assert.deepEqual(pending.map(item => item.images), [[{media_type: 'image/png', name: 'probe.png', thumb}, {media_type: 'image/webp'}]]);
  // The older row with the same text is not the one: the previews go to the row that landed after.
  f.on('/api/history', json({messages: [{seq: 3, role: 'user', content: '这是什么？', at: 't', scene_id: scene}, {seq: 5, role: 'user', content: '这是什么？', at: 't', scene_id: scene}, {seq: 6, role: 'assistant', content: '黄底绿圆', at: 't', scene_id: scene}]}));
  await f.sessions.reload();
  const view = f.sessions.view(id);
  assert.deepEqual(view.sent, []); assert.deepEqual(view.replied, []);
  assert.deepEqual(view.rows.map(row => [row.seq, row.images ? row.images.length : 0]), [[3, 0], [5, 2], [6, 0]]);
  assert.deepEqual(f.saves.at(-1).sessions[0].rows.find(row => row.seq === 5).images[0], {media_type: 'image/png', name: 'probe.png', thumb});
});

test('images need words with them and stay inside the measured envelope', async () => {
  const f = fixture();
  await f.sessions.start('identity-a');
  const id = f.sessions.snapshot().active;
  const data = Buffer.from('png').toString('base64');
  await assert.rejects(f.sessions.send({sessionId: id, text: '', images: [{media_type: 'image/png', data}]}), {code: 'INVALID_REQUEST', message: '图片需要配一句话一起发送。'});
  await assert.rejects(f.sessions.send({sessionId: id, text: 'x', images: [{media_type: 'audio/wav', data}]}), {code: 'INVALID_REQUEST', message: '图片格式仅支持 PNG、JPEG、WebP、GIF。'});
  await assert.rejects(f.sessions.send({sessionId: id, text: 'x', images: [{media_type: 'image/png', data: 'abc'}]}), {code: 'INVALID_REQUEST', message: '图片数据无效，请重新添加。'});
  const big = Buffer.alloc(6 * 1024 * 1024).toString('base64');
  await assert.rejects(f.sessions.send({sessionId: id, text: 'x', images: [{media_type: 'image/png', data: big}, {media_type: 'image/png', data: big}]}), {code: 'INVALID_REQUEST', message: '一条消息的图片合计不能超过 10 MB。'});
  await assert.rejects(f.sessions.send({sessionId: id, text: 'x', images: Array.from({length: 9}, () => ({media_type: 'image/png', data}))}), {code: 'INVALID_REQUEST', message: '一条消息最多 8 张图片。'});
  await assert.rejects(f.sessions.send({sessionId: id, text: 'x', images: 'nope'}), {code: 'INVALID_REQUEST'});
  assert.equal(f.calls.some(call => call.path === '/api/chat/stream'), false);
  assert.deepEqual(f.sessions.view(id).sent, []);
});
