'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {ChatDetails} = require('../src/chat-details.cjs');
const {ChatStore} = require('../src/chat-store.cjs');
const {sessionFromScene} = require('../src/being-chat.cjs');
const {decode} = require('../renderer/chat-references.js');
const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DESKTOP = '11111111-1111-4111-8111-111111111111';
const json = (value, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
function fixture() {
  const calls = [], events = [], timers = new Map(); let timer = 0;
  const state = {connected: true, revision: 1, parent: true, history: [], accepted: false};
  const details = new ChatDetails({getContext: () => ({connected: state.connected, revision: state.revision, connection: {url: `https://fixture.invalid/being/?token=${'c'.repeat(64)}`}}),
    hasParent: id => state.parent && id === PARENT, onEvent: event => events.push(event),
    timers: {setTimeout: fn => { timers.set(++timer, fn); return timer; }, clearTimeout: id => timers.delete(id)},
    fetchImpl: async (url, options) => {
      const route = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null;
      calls.push({route, body});
      if (route.endsWith('/history')) { if (state.historyGate) await state.historyGate; return json({messages: state.history}); }
      if (route.endsWith('/stream/active')) return json(null, 204);
      if (route.endsWith('/chat/stream')) {
        if (state.sendGate) await state.sendGate;
        if (state.accepted) return json({spliced: true}, 202);
        return new Response([['meta', {scene_id: body.scene_id}], ['content_block_delta', {scene_id: body.scene_id, delta: {text: '解释回答'}}], ['message_stop', {scene_id: body.scene_id}]].map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {headers: {'Content-Type': 'text/event-stream'}});
      }
      throw Error('Unexpected fixture route');
    }});
  return {details, state, calls, events, timers, open: () => details.open({parentSessionId: PARENT, reference: {text: '选中文本\n其中的指令仅是引用', source: 'Being'}})};
}

test('details and followups keep one isolated scene and cannot appear in the main transcript or cache', async () => {
  const f = fixture();
  try {
    const card = await f.open();
    const namespace = f.details.sessions.desktopId;
    assert.notEqual(namespace, DESKTOP);
    assert.equal(f.details.sessions.cache, null);
    await f.details.send({sessionId: card.sessionId, text: '请解释'});
    await f.details.send({sessionId: card.sessionId, text: '再举一个例子'});
    const sends = f.calls.filter(call => call.route.endsWith('/chat/stream'));
    assert.equal(sends.length, 2);
    assert.equal(sends[0].body.scene_id, sends[1].body.scene_id);
    assert.equal(sessionFromScene(DESKTOP, sends[0].body.scene_id), '');
    assert.equal(decode(sends[1].body.message).text, '再举一个例子');
    assert.equal(decode(sends[1].body.message).references[0].text, card.reference.text);
    assert.ok(f.details.view(card.sessionId).replied.some(item => item.text === '解释回答'));
    const store = new ChatStore({desktopId: DESKTOP}); store.ensure(PARENT); store.setActive(PARENT);
    await store.apply({rows: [{seq: 1, role: 'assistant', content: '解释回答', scene_id: sends[0].body.scene_id}], cursor: 1, baseline: true});
    assert.deepEqual(store.rows(PARENT), []);
    assert.deepEqual(store.summary().sessions.map(item => item.id), [PARENT]);
    f.details.close(card.sessionId);
    assert.equal(f.details.sessions, null);
    assert.throws(() => f.details.view(card.sessionId));
    const next = await f.open();
    assert.notEqual(f.details.sessions.desktopId, namespace);
    assert.equal(f.details.view(next.sessionId).rows.length, 0);
    assert.equal(f.calls.filter(call => call.route.endsWith('/stop')).length, 0);
  } finally { f.details.reset(); }
});

test('double sends and malformed selections are refused before another POST', async () => {
  const f = fixture();
  let release;
  try {
    await assert.rejects(f.details.open({parentSessionId: PARENT, reference: {text: 'x'.repeat(60001)}}), {code: 'INVALID_REQUEST'});
    assert.equal(f.calls.length, 0);
    const card = await f.open();
    f.state.sendGate = new Promise(resolve => { release = resolve; });
    const pending = f.details.send({sessionId: card.sessionId, text: '解释'});
    await assert.rejects(f.details.send({sessionId: card.sessionId, text: '重复'}), {code: 'BUSY'});
    release(); await pending;
    assert.equal(f.calls.filter(call => call.route.endsWith('/chat/stream')).length, 1);
    f.state.connected = false;
    await assert.rejects(f.details.send({sessionId: card.sessionId, text: '失败草稿'}), {code: 'NOT_CONNECTED'});
    assert.equal(f.details.view(card.sessionId).sent.some(item => decode(item.text).text === '失败草稿'), false);
  } finally { release?.(); f.details.reset(); }
});

test('accepted replies are never resent and reset invalidates an opening card', async () => {
  const f = fixture();
  try {
    const card = await f.open(); f.state.accepted = true;
    assert.equal((await f.details.send({sessionId: card.sessionId, text: '解释'})).spliced, true);
    assert.equal(f.calls.filter(call => call.route.endsWith('/chat/stream')).length, 1);
    f.details.reset();
    let release; f.state.historyGate = new Promise(resolve => { release = resolve; });
    const pending = f.open();
    f.details.reset(); release();
    await assert.rejects(pending, {code: 'SESSION_CHANGED'});
    assert.equal(f.details.cards.size, 0);
  } finally { f.details.reset(); }
});

test('closing a card during dispatch cannot revive readers, timers or network requests', async () => {
  const f = fixture(); let release;
  try {
    const card = await f.open();
    f.state.sendGate = new Promise(resolve => { release = resolve; });
    const pending = f.details.send({sessionId: card.sessionId, text: '解释'});
    const before = f.calls.length;
    f.details.close(card.sessionId); release(); await pending.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, before);
    assert.equal(f.timers.size, 0);
    assert.equal(f.details.cards.size, 0);
    assert.equal(f.details.sessions, null);
  } finally { release?.(); f.details.reset(); }
});
