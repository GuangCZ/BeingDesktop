'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {SbsTownResults, connectionKey} = require('../src/sbs-town-results.cjs');
const id = '12345678-1234-4234-8234-123456789abc';
const now = Date.parse('2026-09-07T06:00:00Z');
function setup(overrides = {}) {
  let connection = {url: 'https://example.test/alice/?token=test', beingName: 'alice'};
  const record = {requestId: id, source: 'sbs', beingId: 'alice', route: '/api/bonfire/hear', query: {limit: '10'}, createdAt: now - 60000, expiresAt: now + 540000};
  let manifest = {version: 1, connectionKey: connectionKey(connection), records: [record]};
  let result = {protocol: 'being-town-tool-result/1', requestId: id, beingId: 'alice', route: record.route, httpStatus: 200, capturedAt: new Date(now - 1000).toISOString(), data: {being: 'alice', ok: true, global_latest_seq: 2, messages: [{seq: 2, being: 'alice', message: 'original text', at: 'today'}]}};
  let calls = 0;
  const reader = new SbsTownResults({getConnection: () => connection, getRegistrations: () => manifest, results: {poll: async (...args) => {calls++; return overrides.poll ? overrides.poll(...args) : result;}}, now: () => now});
  return {reader, record, get calls() {return calls;}, get result() {return result;}, set result(value) {result = value;}, get manifest() {return manifest;}, set manifest(value) {manifest = value;}, set connection(value) {connection = value;}};
}

test('a registered original result keeps its actual capture time across cache polls', async () => {
  const context = setup();
  const first = await context.reader.readSnapshot({kind: 'bonfire'});
  const next = await context.reader.readSnapshot({kind: 'bonfire'});
  assert.equal(first.messages[0].content, 'original text');
  assert.equal(next.capturedAt, now - 1000);
  assert.equal(next.revision, id);
  assert.equal(context.calls, 1);
});

test('missing or pending enrollments wait without fabricating an empty feed', async () => {
  const context = setup(); context.result = null;
  await assert.rejects(context.reader.readSnapshot({kind: 'bonfire'}), {code: 'WAITING_SBS'});
  context.manifest = null;
  await assert.rejects(context.reader.readSnapshot({kind: 'bonfire'}), {code: 'SBS_NOT_CONFIGURED'});
  assert.equal(context.calls, 1);
});

test('expired enrollments cannot be polled or refresh a previous capture time', async () => {
  const context = setup();
  const first = await context.reader.readSnapshot({kind: 'bonfire'});
  context.record.expiresAt = now;
  const next = await context.reader.readSnapshot({kind: 'bonfire'});
  assert.deepEqual(next, first);
  assert.equal(context.calls, 1);
  const expired = setup(); expired.record.expiresAt = now;
  await assert.rejects(expired.reader.readSnapshot({kind: 'bonfire'}), {code: 'SBS_NOT_CONFIGURED'});
  assert.equal(expired.calls, 0);
});

test('connection changes clear private snapshots and reject late results', async () => {
  let resolve;
  const context = setup({poll: () => new Promise(done => {resolve = done;})});
  const flight = context.reader.readSnapshot({kind: 'bonfire'});
  await Promise.resolve();
  context.connection = {url: 'https://example.test/bob/?token=other', beingName: 'bob'};
  resolve(context.result);
  await assert.rejects(flight, {code: 'SESSION_CHANGED'});
  await assert.rejects(context.reader.readSnapshot({kind: 'bonfire'}), {code: 'SBS_NOT_CONFIGURED'});
});

test('SBS results require actual identity rather than the correlation identifier', async () => {
  for (const identity of [undefined, 'bob']) {
    const context = setup(); context.result.data.being = identity;
    await assert.rejects(context.reader.readSnapshot({kind: 'bonfire'}), {code: 'IDENTITY_MISMATCH'});
  }
});

test('truncated data and missing or impossible capture timestamps fail closed', async () => {
  const truncated = setup(); truncated.result.data.messages[0].truncated = true;
  await assert.rejects(truncated.reader.readSnapshot({kind: 'bonfire'}), {code: 'INCOMPLETE_RESULT'});
  for (const capturedAt of [undefined, 'yesterday', new Date(now + 5000).toISOString(), new Date(now - 100000).toISOString()]) {
    const context = setup(); context.result.capturedAt = capturedAt;
    await assert.rejects(context.reader.readSnapshot({kind: 'bonfire'}), {code: 'INCOMPLETE_RESULT'});
  }
});

test('room, query, and manifest identity mismatches never reach the result transport', async () => {
  const context = setup();
  await assert.rejects(context.reader.readSnapshot({kind: 'fireside', firesideId: '9'}), {code: 'SBS_NOT_CONFIGURED'});
  context.record.query.compact = 'true';
  await assert.rejects(context.reader.readSnapshot({kind: 'bonfire'}), {code: 'SBS_NOT_CONFIGURED'});
  context.manifest = {version: 1, connectionKey: 'other', records: [context.record]};
  await assert.rejects(context.reader.readSnapshot({kind: 'bonfire'}), {code: 'SBS_NOT_CONFIGURED'});
  assert.equal(context.calls, 0);
});

test('cancelling a result read rejects its late response', async () => {
  let resolve;
  const context = setup({poll: () => new Promise(done => {resolve = done;})});
  const controller = new AbortController();
  const flight = context.reader.readSnapshot({kind: 'bonfire', signal: controller.signal});
  await Promise.resolve(); controller.abort(); resolve(context.result);
  await assert.rejects(flight, {code: 'ABORTED'});
});

test('a late poll cannot replace a newer concurrent capture or return an older snapshot', async () => {
  for (const pending of [false, true]) {
    let resolve;
    const context = setup({poll: record => record.requestId === id
      ? new Promise(done => {resolve = done;})
      : {...context.result, requestId: record.requestId, capturedAt: new Date(now).toISOString(), data: {...context.result.data, global_latest_seq: 3, messages: [{seq: 3, being: 'alice', message: 'newer text', at: 'today'}]}}});
    const oldFlight = context.reader.readSnapshot({kind: 'bonfire'});
    await Promise.resolve();
    context.manifest.records = [{...context.record, requestId: '12345678-1234-4234-8234-123456789abd', createdAt: now - 500}];
    const newer = await context.reader.readSnapshot({kind: 'bonfire'});
    assert.equal(newer.latestSeq, 3);
    resolve(pending ? null : context.result);
    assert.deepEqual(await oldFlight, newer);
    assert.deepEqual(await context.reader.readSnapshot({kind: 'bonfire'}), newer);
    assert.equal(context.calls, 2);
  }
});

test('a pending future enrollment does not hide an older completed result after startup', async () => {
  const polled = [];
  const context = setup({poll: record => {polled.push(record.requestId); return record.requestId === id ? context.result : null;}});
  const newer = {...context.record, requestId: '12345678-1234-4234-8234-123456789abd', createdAt: now - 500};
  context.manifest.records.push(newer);
  const snapshot = await context.reader.readSnapshot({kind: 'bonfire'});
  assert.equal(snapshot.revision, id);
  assert.equal(snapshot.capturedAt, now - 1000);
  assert.deepEqual(polled, [newer.requestId, id]);
  assert.deepEqual(await context.reader.readSnapshot({kind: 'bonfire'}), snapshot);
  assert.deepEqual(polled, [newer.requestId, id, newer.requestId]);
});

test('invalid and rejected enrollments are not hidden by an older completed result', async () => {
  for (const business of [false, true]) {
    const polled = [];
    const context = setup({poll: record => {
      polled.push(record.requestId);
      if (record.requestId === id) return context.result;
      if (business) throw Object.assign(new Error('Denied'), {code: 'AUTH_REQUIRED'});
      return {...context.result, requestId: record.requestId, capturedAt: 'invalid'};
    }});
    const newer = {...context.record, requestId: '12345678-1234-4234-8234-123456789abd', createdAt: now - 500};
    context.manifest.records.push(newer);
    await assert.rejects(context.reader.readSnapshot({kind: 'bonfire'}), {code: business ? 'AUTH_REQUIRED' : 'INCOMPLETE_RESULT'});
    assert.deepEqual(polled, [newer.requestId]);
  }
});

test('cancellation and connection changes stop pending enrollment fallback', async () => {
  for (const cancel of [false, true]) {
    let resolve;
    const polled = [];
    const context = setup({poll: record => {polled.push(record.requestId); return new Promise(done => {resolve = done;});}});
    const newer = {...context.record, requestId: '12345678-1234-4234-8234-123456789abd', createdAt: now - 500};
    context.manifest.records.push(newer);
    const controller = new AbortController();
    const flight = context.reader.readSnapshot({kind: 'bonfire', signal: controller.signal});
    await Promise.resolve();
    if (cancel) controller.abort();
    else context.connection = {url: 'https://example.test/bob/?token=other', beingName: 'bob'};
    resolve(null);
    await assert.rejects(flight, {code: cancel ? 'ABORTED' : 'SESSION_CHANGED'});
    assert.deepEqual(polled, [newer.requestId]);
  }
});

test('capture time wins over enrollment order, including a completed cached candidate', async () => {
  for (const delayed of [false, true]) {
    let olderPending = delayed;
    const polled = [];
    const context = setup({poll: record => {
      polled.push(record.requestId);
      if (record.requestId === id) return olderPending ? null : context.result;
      return {...context.result, requestId: record.requestId, capturedAt: new Date(now - 5000).toISOString(), data: {...context.result.data, global_latest_seq: 3, messages: [{seq: 3, being: 'alice', message: 'earlier capture', at: 'today'}]}};
    }});
    context.result = {...context.result, capturedAt: new Date(now).toISOString(), data: {...context.result.data, global_latest_seq: 4, messages: [{seq: 4, being: 'alice', message: 'later capture', at: 'today'}]}};
    const newer = {...context.record, requestId: '12345678-1234-4234-8234-123456789abd', createdAt: now - 10000};
    context.manifest.records.push(newer);
    const first = await context.reader.readSnapshot({kind: 'bonfire'});
    assert.equal(first.latestSeq, delayed ? 3 : 4);
    assert.deepEqual(polled, [newer.requestId, id]);
    olderPending = false;
    const final = await context.reader.readSnapshot({kind: 'bonfire'});
    assert.equal(final.latestSeq, 4);
    assert.equal(final.revision, id);
    assert.equal(final.capturedAt, now);
    assert.deepEqual(polled, delayed ? [newer.requestId, id, id] : [newer.requestId, id]);
    const count = polled.length;
    assert.deepEqual(await context.reader.readSnapshot({kind: 'bonfire'}), final);
    assert.equal(polled.length, count);
  }
});
