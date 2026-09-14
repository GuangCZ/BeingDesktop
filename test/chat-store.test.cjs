'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {ChatStore, snapshot} = require('../src/chat-store.cjs');
const {sceneId} = require('../src/being-chat.cjs');

const DESKTOP = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sceneA = sceneId(DESKTOP, A), sceneB = sceneId(DESKTOP, B);
const row = (seq, scene, content = 'x', role = 'assistant') => ({seq, role, content, at: '2026-09-11T00:00:00Z', ...(scene ? {scene_id: scene} : {})});

function fixture({fail = false, disk = null} = {}) {
  const saves = [];
  let stored = disk;
  const cache = {
    load: async () => stored,
    save: async (identityKey, value) => { saves.push({identityKey, value}); if (fail) return false; stored = value; return true; },
  };
  const changes = [];
  const store = new ChatStore({cache, identityKey: 'https://echo.beings.town/cz_being', desktopId: DESKTOP, clock: () => 1757000000000, onChange: value => changes.push(value)});
  return {store, saves, changes, disk: () => stored};
}

test('nothing is persisted before a baseline exists', async () => {
  const f = fixture();
  await f.store.load();
  // Invariant 2: a five-row cursor sync must not become the whole of the persisted history.
  const result = await f.store.apply({rows: [row(11, sceneA)], cursor: 11});
  assert.equal(result.stored, 1); assert.equal(result.persisted, false);
  assert.deepEqual(f.saves, []);
  // The rows are still usable in memory; only the disk waits for a baseline.
  assert.deepEqual(f.store.rows(A).map(item => item.seq), [11]);
  assert.equal(f.store.cursor, 11); assert.equal(f.store.seeded, false);
  const seeded = await f.store.apply({rows: [row(12, sceneA)], cursor: 12, baseline: true});
  assert.equal(seeded.persisted, true); assert.equal(f.store.seeded, true);
  // A baseline replaces rather than merges: the earlier increment is not smuggled in.
  assert.deepEqual(f.store.rows(A).map(item => item.seq), [12]);
});

test('rows and the cursor are persisted as one replacement', async () => {
  const f = fixture();
  await f.store.load();
  await f.store.apply({rows: [row(5, sceneA)], cursor: 5, baseline: true});
  await f.store.apply({rows: [row(7, sceneB)], cursor: 7});
  // Invariant 1: every write carries both, so a cursor can never outrun the rows it counted.
  const written = f.saves.at(-1).value;
  assert.equal(written.cursor, 7);
  assert.deepEqual(written.sessions.map(session => [session.id, session.rows.map(item => item.seq)]), [[A, [5]], [B, [7]]]);
});

test('the cursor only moves forward', async () => {
  const f = fixture();
  await f.store.load();
  await f.store.apply({rows: [row(50, sceneA)], cursor: 50, baseline: true});
  const back = await f.store.apply({rows: [], cursor: 10});
  assert.equal(back.cursor, 50); assert.equal(f.store.cursor, 50);
});

test('one page fans out to the conversations it names and skips the rest', async () => {
  const f = fixture();
  await f.store.load();
  const result = await f.store.apply({baseline: true, cursor: 20, rows: [
    row(11, sceneA, 'A 问', 'user'), row(12, sceneA, 'A 答'), row(13, sceneB, 'B 答'),
    row(14, 'loom-being', '别的客户端'), row(15, sceneId(A, B), '别的 Desktop'),
    {seq: 16, role: 'user', content: '[breath yielded to human]', from: 'system'},
    {seq: 0, role: 'user', content: '坏行'},
  ]});
  assert.equal(result.stored, 3); assert.equal(result.skipped, 4);
  assert.deepEqual(f.store.rows(A).map(item => [item.seq, item.role]), [[11, 'user'], [12, 'being']]);
  assert.deepEqual(f.store.rows(B).map(item => item.seq), [13]);
  // Unroutable rows still advance the cursor, or every read would fetch them again forever.
  assert.equal(f.store.cursor, 20);
});

test('a conversation seen only in history joins the list', async () => {
  const f = fixture();
  await f.store.load();
  await f.store.apply({rows: [row(9, sceneB)], cursor: 9, baseline: true});
  assert.deepEqual(f.store.summary().sessions.map(session => session.id), [B]);
});

test('rows merge in seq order, and a re-read replaces rather than duplicates', async () => {
  const f = fixture();
  await f.store.load();
  await f.store.apply({rows: [row(30, sceneA, '三十')], cursor: 30, baseline: true});
  await f.store.apply({rows: [row(10, sceneA, '十'), row(20, sceneA, '二十'), row(30, sceneA, '三十改')], cursor: 30});
  assert.deepEqual(f.store.rows(A).map(item => [item.seq, item.content]), [[10, '十'], [20, '二十'], [30, '三十改']]);
});

test('a reloaded store resumes from its stored cursor and transcripts', async () => {
  const f = fixture();
  await f.store.load();
  await f.store.apply({rows: [row(41, sceneA, '记住我')], cursor: 41, baseline: true});
  f.store.rename(A, '会话一'); f.store.setActive(A);
  await f.store.touch();
  const again = fixture({disk: f.disk()});
  const summary = await again.store.load();
  assert.equal(summary.cursor, 41); assert.equal(summary.seeded, true); assert.equal(summary.active, A);
  assert.deepEqual(summary.sessions, [{id: A, title: '会话一', createdAt: 1757000000000, updatedAt: '2026-09-11T00:00:00Z', truncated: false, count: 1, lastSeq: 41}]);
  assert.deepEqual(again.store.rows(A).map(item => item.content), ['记住我']);
});

test('a corrupt or inconsistent file is a cache miss, not a startup failure', async () => {
  for (const disk of [
    {version: 2, cursor: 1, seeded: true, sessions: []},
    {version: 1, cursor: -1, seeded: true, sessions: []},
    // A cursor behind its own rows is the corruption invariant 1 exists to prevent.
    {version: 1, cursor: 5, seeded: true, sessions: [{id: A, rows: [{seq: 9, role: 'user', content: 'x'}]}]},
    {version: 1, cursor: 9, seeded: true, sessions: [{id: A, rows: [{seq: 2, role: 'user', content: 'x'}, {seq: 1, role: 'user', content: 'y'}]}]},
    {version: 1, cursor: 9, seeded: true, sessions: [{id: A, rows: []}, {id: A, rows: []}]},
    {version: 1, cursor: 9, seeded: 'yes', sessions: []},
  ]) {
    const f = fixture({disk});
    const summary = await f.store.load();
    assert.equal(summary.cursor, 0, JSON.stringify(disk));
    assert.equal(summary.seeded, false);
  }
  const thrown = new ChatStore({cache: {load: async () => { throw new Error('unreadable'); }}, desktopId: DESKTOP});
  assert.equal((await thrown.load()).cursor, 0);
});

test('a store with no cache at all still works in memory', async () => {
  const store = new ChatStore({desktopId: DESKTOP});
  await store.load();
  const result = await store.apply({rows: [row(3, sceneA)], cursor: 3, baseline: true});
  assert.equal(result.persisted, false); assert.equal(store.degraded, false);
  assert.deepEqual(store.rows(A).map(item => item.seq), [3]);
  assert.throws(() => new ChatStore({desktopId: 'nope'}), TypeError);
});

test('a failed write is reported and leaves the previous file intact', async () => {
  const f = fixture({fail: true});
  await f.store.load();
  assert.equal((await f.store.apply({rows: [row(4, sceneA)], cursor: 4, baseline: true})).persisted, false);
  assert.equal(f.store.degraded, true);
  assert.equal(await f.store.flush(), false);
  assert.equal(f.disk(), null);
  // Memory keeps serving, so a machine without encryption is degraded rather than broken.
  assert.deepEqual(f.store.rows(A).map(item => item.seq), [4]);
});

test('conversations can be opened, renamed, activated and forgotten', async () => {
  const f = fixture();
  await f.store.load();
  f.store.ensure(A, {title: '一'});
  f.store.ensure(B);
  assert.equal(f.store.rename(B, '二'), true);
  assert.equal(f.store.rename('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'x'), false);
  assert.equal(f.store.setActive(B), true);
  assert.deepEqual(f.store.summary().sessions.map(session => session.title), ['一', '二']);
  assert.equal(f.store.forget(B), true);
  assert.equal(f.store.summary().active, '');
  assert.equal(f.store.forget(B), false);
  // Forgetting never rewinds the cursor: that would re-deliver every other conversation's rows.
  await f.store.apply({rows: [row(60, sceneA)], cursor: 60, baseline: true});
  f.store.forget(A);
  assert.equal(f.store.cursor, 60);
  assert.throws(() => f.store.ensure('not-a-uuid'), TypeError);
});

test('an oversized transcript gives up age, keeps the conversation, and says so', async () => {
  const f = fixture();
  await f.store.load();
  const big = Array.from({length: 120}, (unused, index) => row(index + 1, sceneA, 'x'.repeat(90000)));
  await f.store.apply({rows: big, cursor: 120, baseline: true});
  const written = f.saves.at(-1).value;
  assert.equal(written.sessions[0].truncated, true);
  assert.ok(written.sessions[0].rows.length < 120);
  // The newest rows are the ones kept, and the cursor is unaffected by trimming.
  assert.equal(written.sessions[0].rows.at(-1).seq, 120);
  assert.equal(written.cursor, 120);
  assert.equal(f.store.summary().sessions[0].truncated, true);
});

test('a conversation keeps only its most recent rows', async () => {
  const f = fixture();
  await f.store.load();
  await f.store.apply({rows: Array.from({length: 340}, (unused, index) => row(index + 1, sceneA, 'x')), cursor: 340, baseline: true});
  const rows = f.store.rows(A);
  assert.equal(rows.length, 300); assert.equal(rows[0].seq, 41); assert.equal(rows.at(-1).seq, 340);
  assert.equal(f.store.summary().sessions[0].truncated, true);
});

test('the snapshot validator is the contract, not a cleanup pass', () => {
  assert.equal(snapshot({version: 1, cursor: 0, seeded: false, sessions: []}).active, '');
  assert.equal(snapshot({version: 1, cursor: 1, seeded: true, active: A, sessions: [{id: A, rows: []}]}).active, A);
  // An active id naming no conversation is dropped rather than rejecting the file.
  assert.equal(snapshot({version: 1, cursor: 1, seeded: true, active: B, sessions: [{id: A, rows: []}]}).active, '');
  assert.equal(snapshot({version: 1, cursor: 1, seeded: true, sessions: [{id: 'x', rows: []}]}), null);
  assert.equal(snapshot(null), null);
});

test('concurrent applies serialize into ordered writes', async () => {
  const f = fixture();
  await f.store.load();
  await f.store.apply({rows: [row(1, sceneA)], cursor: 1, baseline: true});
  await Promise.all([f.store.apply({rows: [row(2, sceneA)], cursor: 2}), f.store.apply({rows: [row(3, sceneA)], cursor: 3})]);
  assert.equal(await f.store.flush(), true);
  assert.deepEqual(f.saves.map(save => save.value.cursor), [1, 2, 3]);
  assert.equal(f.disk().cursor, 3);
});

// History never returns images (measured 2026-09-11): a row's previews are a local annotation,
// attached when the message is confirmed and kept through every re-read of the row.
test('image previews attach to a durable row and survive a re-read and a fresh baseline', async () => {
  const f = fixture();
  await f.store.load();
  await f.store.apply({rows: [row(10, sceneA, '看看这张图', 'user'), row(11, sceneA, '黄底绿圆')], cursor: 11, baseline: true});
  const thumb = `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`;
  assert.equal(f.store.attach(A, 10, [{media_type: 'image/png', name: 'probe.png', thumb}, {media_type: 'image/gif'}, {media_type: 'text/plain'}, null, {media_type: 'image/png', thumb: 'javascript:alert(1)'}]), true);
  assert.deepEqual(f.store.rows(A)[0].images, [{media_type: 'image/png', name: 'probe.png', thumb}, {media_type: 'image/gif'}, {media_type: 'image/png'}]);
  // Attaching is idempotent per row, and refuses rows that are not there.
  assert.equal(f.store.attach(A, 10, [{media_type: 'image/png'}]), false);
  assert.equal(f.store.attach(A, 99, [{media_type: 'image/png'}]), false);
  assert.equal(f.store.attach(B, 10, [{media_type: 'image/png'}]), false);
  await f.store.flush();
  assert.deepEqual(f.disk().sessions[0].rows[0].images[0], {media_type: 'image/png', name: 'probe.png', thumb});
  // The row comes back from history without images; the previews stay with it.
  await f.store.apply({rows: [row(10, sceneA, '看看这张图', 'user'), row(12, sceneA, '还有吗', 'user')], cursor: 12});
  assert.equal(f.store.rows(A)[0].images.length, 3);
  await f.store.apply({rows: [row(10, sceneA, '看看这张图', 'user'), row(11, sceneA, '黄底绿圆')], cursor: 12, baseline: true});
  assert.equal(f.store.rows(A)[0].images.length, 3);
  assert.equal(f.store.rows(A)[1].images, undefined);
  // A reload validates the previews like everything else.
  const g = fixture({disk: f.disk()});
  await g.store.load();
  assert.equal(g.store.rows(A)[0].images.length, 3);
  const rows = f.store.rows(A);
  rows[0].images[0].name = 'mutated';
  assert.equal(f.store.rows(A)[0].images[0].name, 'probe.png');
});

test('previews that do not fit are dropped, never the row they annotate', async () => {
  const f = fixture();
  await f.store.load();
  await f.store.apply({rows: [row(10, sceneA, '图', 'user')], cursor: 10, baseline: true});
  assert.equal(f.store.attach(A, 10, [{media_type: 'image/png', thumb: `data:image/png;base64,${'A'.repeat(64 * 1024)}`}]), true);
  assert.deepEqual(f.store.rows(A)[0].images, [{media_type: 'image/png'}]);
  assert.equal(f.store.attach(A, 10, []), false);
  const many = Array.from({length: 12}, (_, i) => ({media_type: 'image/png', name: `${i}.png`}));
  await f.store.apply({rows: [{...row(11, sceneA, '多', 'user'), images: many}], cursor: 11});
  assert.equal(f.store.rows(A)[1].images.length, 8);
  assert.equal(snapshot({version: 1, cursor: 11, seeded: true, active: '', sessions: [{id: A, title: '', createdAt: 0, truncated: false, rows: [{seq: 1, role: 'user', content: 'x', at: '', images: 'nope'}]}]}).sessions[0].rows[0].images, undefined);
});
