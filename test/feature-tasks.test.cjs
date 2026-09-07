'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {FeatureTasks} = require('../src/feature-tasks.cjs');

function setup(options = {}) {
  let timestamp = 1000;
  let sequence = 0;
  const changes = [];
  const tasks = new FeatureTasks({now: () => timestamp, createId: () => `task-${++sequence}`, onChange: value => changes.push(value), ...options});
  return {tasks, changes, tick(value = 1) { timestamp += value; }, begin(input = {}) { return tasks.begin({feature: 'bonfire', operation: 'read', title: '读取篝火消息', execution: 'being', ...input}); }};
}

test('functional work owns its progress and result without invoking a transport', () => {
  const context = setup();
  const started = context.begin();
  assert.equal(started.mayDelayChat, true);
  assert.equal(started.status, 'running');
  context.tick(50);
  context.tasks.update(started.id, {status: 'waiting', detail: '请求已送达，等待实际结果', requestId: 'request-1'});
  context.tick(50);
  const done = context.tasks.complete(started.id, {summary: '已读取 10 条篝火消息'});
  assert.equal(done.status, 'succeeded');
  assert.equal(done.finishedAt, 1100);
  assert.equal(done.createdAt, 1000);
  assert.equal(done.requestId, 'request-1');
  assert.equal(done.summary, '已读取 10 条篝火消息');
  assert.equal(done.detail, '');
  assert.equal(context.changes.length, 3);
  assert.deepEqual(context.changes[2].records, [done]);
});

test('local work never claims it can delay Being chat', () => {
  const context = setup();
  const task = context.begin({feature: 'portal', operation: 'install', execution: 'local'});
  assert.equal(task.mayDelayChat, false);
  assert.equal(task.execution, 'local');
});

test('terminal records cannot be resurrected by late success, errors or progress', () => {
  for (const terminal of ['succeeded', 'failed', 'cancelled']) {
    const context = setup();
    const task = context.begin();
    const before = context.tasks.update(task.id, {status: terminal, detail: '终态'});
    context.tick(100);
    assert.deepEqual(context.tasks.update(task.id, {status: 'running', detail: '延迟回调'}), before);
    assert.deepEqual(context.tasks.complete(task.id, {summary: '迟到结果'}), before);
    assert.deepEqual(context.tasks.fail(task.id, {code: 'NETWORK_ERROR'}), before);
    assert.equal(context.changes.length, 2);
  }
});

test('active task identifiers and execution fields cannot be changed through patches', () => {
  const context = setup(); const task = context.begin();
  for (const patch of [{id: 'other'}, {execution: 'local'}, {mayDelayChat: false}, {prompt: 'hidden'}, {status: 'done'}, {requestId: 'https://example.test/?token=secret'}]) assert.throws(() => context.tasks.update(task.id, patch), TypeError);
  assert.equal(context.tasks.get(task.id).status, 'running');
  assert.equal(context.changes.length, 1);
});

test('task errors never expose upstream messages, headers, or response bodies', () => {
  const context = setup(); const task = context.begin();
  const error = Object.assign(new Error('Authorization: Bearer secret; https://host/path?token=secret'), {code: 'NETWORK_ERROR', response: {password: 'secret'}});
  const failed = context.tasks.fail(task.id, error);
  assert.equal(failed.errorCode, 'NETWORK_ERROR');
  assert.equal(failed.detail, '连接暂时中断，请稍后重试。');
  assert.doesNotMatch(JSON.stringify(failed), /secret|Authorization|password|response/);
  const other = context.begin();
  assert.equal(context.tasks.fail(other.id, {code: 'SECRET_TOKEN_VALUE', message: 'private prompt'}).errorCode, 'REQUEST_FAILED');
});

test('public text strips credential URLs, bearer values and token assignments', () => {
  const context = setup();
  const task = context.begin({title: '读取 https://user:pw@example.test/being/?token=url-secret'});
  context.tasks.update(task.id, {detail: 'Bearer bearer-secret; token=query-secret api_key=key-secret sk-abcdefghijklm'});
  context.tasks.complete(task.id, {summary: 'password=pass-secret refresh_token=refresh-secret cookie=session-secret key=bare-secret'});
  const text = JSON.stringify(context.tasks.snapshot());
  assert.doesNotMatch(text, /url-secret|bearer-secret|query-secret|key-secret|abcdefghijklm|pass-secret|refresh-secret|session-secret|bare-secret|user:pw/);
  assert.match(text, /已隐藏/);
});

test('text and record counts are bounded without dropping active work', () => {
  const context = setup({maxRecords: 2});
  const first = context.begin({title: '标题'.repeat(1000)});
  context.tick();
  const second = context.begin();
  assert.equal(first.title.length, 160);
  assert.throws(() => context.begin(), {code: 'TASK_LIMIT_REACHED'});
  context.tasks.complete(first.id, {summary: '结果'.repeat(1000)});
  assert.equal(context.tasks.get(first.id).summary.length, 1200);
  context.tick();
  const third = context.begin();
  assert.equal(context.tasks.get(first.id), null);
  assert.deepEqual(context.tasks.list().map(task => task.id), [third.id, second.id]);
});

test('callers and observers cannot mutate retained records', () => {
  const context = setup(); const task = context.begin();
  task.title = 'changed';
  context.tasks.get(task.id).title = 'changed';
  context.tasks.list()[0].title = 'changed';
  context.tasks.snapshot().records[0].title = 'changed';
  context.changes[0].records[0].title = 'changed';
  assert.equal(context.tasks.get(task.id).title, '读取篝火消息');
  const throwing = setup({onChange: () => { throw new Error('observer failed'); }});
  assert.equal(throwing.begin().status, 'running');
});

test('restarting preserves terminal results and marks unfinished work for reconciliation without replay', () => {
  const context = setup({identityKey: 'alice'});
  const done = context.begin(); context.tasks.complete(done.id, {summary: '原始摘要'});
  context.tick();
  const pending = context.begin(); context.tasks.update(pending.id, {status: 'needs_input', requestId: 'request-2'});
  let changed = 0;
  const restored = new FeatureTasks({identityKey: 'alice', initialSnapshot: context.tasks.snapshot(), onChange: () => changed++});
  assert.equal(restored.get(done.id).summary, '原始摘要');
  assert.equal(restored.get(pending.id).status, 'needs_input');
  assert.match(restored.get(pending.id).detail, /旧读取结果尚未确认，本地已无等待队列/);
  assert.equal(restored.get(pending.id).mayDelayChat, true);
  assert.equal(restored.get(pending.id).finishedAt, null);
  assert.equal(restored.get(pending.id).requestId, 'request-2');
  assert.equal(changed, 0);
});

test('restoration and reset never cross a connection identity boundary', () => {
  const context = setup({identityKey: 'alice'}); const task = context.begin();
  const snapshot = context.tasks.snapshot();
  assert.deepEqual(new FeatureTasks({identityKey: 'bob', initialSnapshot: snapshot}).list(), []);
  assert.deepEqual(new FeatureTasks({identityKey: 'alice', initialRecords: snapshot.records}).list(), []);
  assert.equal(new FeatureTasks({identityKey: 'alice', initialRecords: snapshot.records, initialIdentityKey: 'alice'}).list().length, 1);
  context.tasks.reset({identityKey: 'bob'});
  assert.equal(context.tasks.get(task.id), null);
  assert.equal(context.tasks.complete(task.id, {summary: 'old request completed'}), null);
  assert.equal(context.tasks.snapshot().identityKey, 'bob');
  assert.deepEqual(context.tasks.list(), []);
});

test('legacy rejected reads stop pretending to queue while accepted reads require reconciliation', () => {
  const context=setup({identityKey:'alice'});
  const blocked=context.begin();
  context.tasks.update(blocked.id,{status:'waiting',detail:'Being 正在处理其他请求，本次操作尚未完成；不会自动重发。'});
  context.tick(); const accepted=context.begin();
  context.tasks.update(accepted.id,{status:'waiting',requestId:'accepted-request',detail:'请求结果尚待确认；不会自动重发。'});
  const restored=new FeatureTasks({identityKey:'alice',initialSnapshot:context.tasks.snapshot()});
  assert.equal(restored.get(blocked.id).status,'failed');
  assert.match(restored.get(blocked.id).detail,/未发送/);
  assert.equal(restored.get(accepted.id).status,'needs_input');
  assert.equal(restored.get(accepted.id).requestId,'accepted-request');
});

test('invalid or hostile persisted fields cannot restore a task', () => {
  const context = setup({identityKey: 'alice'}); const task = context.begin();
  const candidates = [{...task, prompt: 'private'}, {...task, execution: 'remote'}, {...task, createdAt: -1}, {...task, requestId: 'Bearer token'}, {...task, status: 'succeeded', finishedAt: null}];
  const restored = new FeatureTasks({identityKey: 'alice', initialSnapshot: {version: 1, identityKey: 'alice', records: candidates}});
  assert.deepEqual(restored.list(), []);
});

test('feature filtering is exact, callback timestamps are monotonic, and duplicate updates are quiet', () => {
  const context = setup(); const first = context.begin(); context.tick();
  const second = context.begin({feature: 'fireside'});
  assert.deepEqual(context.tasks.list({feature: 'bonfire'}).map(task => task.id), [first.id]);
  assert.deepEqual(context.tasks.list({feature: 'fireside'}).map(task => task.id), [second.id]);
  context.tick(-500);
  assert.equal(context.tasks.update(first.id, {detail: '等待结果'}).updatedAt, 1000);
  context.tasks.update(first.id, {detail: '等待结果'});
  assert.equal(context.changes.length, 3);
});

test('accessors and prototype-bearing patches are rejected without evaluating them', () => {
  const context = setup(); const task = context.begin();
  const getter = {get detail() { throw new Error('must not run'); }};
  assert.throws(() => context.tasks.update(task.id, getter), /Invalid task update fields/);
  assert.throws(() => context.tasks.update(task.id, Object.create({status: 'succeeded'})), TypeError);
  const hostileError = {get code() { throw new Error('must not run'); }};
  assert.equal(context.tasks.fail(task.id, hostileError).errorCode, 'REQUEST_FAILED');
});

test('invalid allocation and clock callbacks leave existing records intact', () => {
  let timestamp = 1000;
  let nextId = 'first';
  const tasks = new FeatureTasks({maxRecords: 1, now: () => timestamp, createId: () => nextId});
  const input = {feature: 'bonfire', operation: 'read', title: '读取消息'};
  const first = tasks.begin(input);
  timestamp = NaN;
  assert.throws(() => tasks.complete(first.id), TypeError);
  assert.equal(tasks.get(first.id).status, 'running');
  timestamp = 1001;
  tasks.complete(first.id);
  nextId = 'invalid task ID';
  assert.throws(() => tasks.begin(input), TypeError);
  assert.equal(tasks.get(first.id).status, 'succeeded');
});
