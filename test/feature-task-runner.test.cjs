'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {FeatureTasks} = require('../src/feature-tasks.cjs');
const {FeatureTaskRunner, currentTask} = require('../src/feature-task-runner.cjs');

function setup() {
  let sequence = 0;
  let ledger = new FeatureTasks({createId: () => `task-${++sequence}`, identityKey: 'alice'});
  const runner = new FeatureTaskRunner({getLedger: () => ledger});
  return {runner, get ledger() { return ledger; }, replace() { ledger = new FeatureTasks({createId: () => `task-${++sequence}`, identityKey: 'bob'}); }};
}

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
const bonfire = {kind: 'bonfire', snapshot: {messages: [{content: 'private message'}]}, status: {status: 'ready', errorCode: ''}};

test('only allowlisted user operations create task records', async () => {
  const context = setup();
  for (const name of ['getTownMessageSnapshot', 'refreshTownMessages', 'getFiresides', 'sendBonfireMessage', 'unknown']) assert.equal(context.runner.run(name, [], () => 42), 42);
  assert.equal(context.ledger.list().length, 0);
  assert.equal(context.runner.run('requestTownRead', [{kind: 'invalid'}], () => 'validation handled by caller'), 'validation handled by caller');
  const result = await context.runner.run('requestTownRead', [{kind: 'bonfire'}], () => bonfire);
  assert.equal(result, bonfire);
  assert.equal(context.ledger.list()[0].summary, '已读取 1 条篝火消息。');
  assert.equal(context.ledger.list()[0].mayDelayChat, true);
  assert.doesNotMatch(JSON.stringify(context.ledger.snapshot()), /private message/);
});

test('identical concurrent requests share the same promise even with reordered object keys', async () => {
  const context = setup(), pending = deferred(); let sends = 0;
  const first = context.runner.run('listScrolls', [{offset: 0, limit: 10}], () => { sends++; return pending.promise; });
  const second = context.runner.run('listScrolls', [{limit: 10, offset: 0}], () => { sends++; return pending.promise; });
  assert.equal(first, second);
  await Promise.resolve(); assert.equal(sends, 1);
  assert.equal(context.ledger.list().length, 1);
  pending.resolve({scrolls: []}); await first;
  assert.equal(context.ledger.list()[0].status, 'succeeded');
});

test('a settled request never replays itself; a new explicit invocation can run again', async () => {
  const context = setup(); let sends = 0;
  const fn = () => { sends++; return {status: 'pending'}; };
  await context.runner.run('beginChannelConnection', [{channel: 'wechat'}], fn);
  assert.equal(context.ledger.list()[0].status, 'waiting');
  await Promise.resolve(); assert.equal(sends, 1);
  await context.runner.run('beginChannelConnection', [{channel: 'wechat'}], fn);
  assert.equal(sends, 2);
});

test('returning to a Fireside starts a new selection while the previous selection is still settling', async () => {
  const context = setup(), previous = deferred(), current = deferred();
  const calls = [];
  const read = (firesideId, selectionRevision, pending) => context.runner.run('requestTownRead', [{kind: 'fireside', firesideId, selectionRevision}], () => {
    calls.push({firesideId, selectionRevision});
    return pending.promise;
  });
  const first = read('1', 1, previous);
  const firstResult = assert.rejects(first, {code: 'SESSION_CHANGED'});
  const selected = read('1', 3, current);
  const duplicate = read('1', 3, current);
  assert.notEqual(first, selected);
  assert.equal(selected, duplicate);
  await Promise.resolve();
  assert.deepEqual(calls, [{firesideId: '1', selectionRevision: 1}, {firesideId: '1', selectionRevision: 3}]);
  const result = {kind: 'fireside', firesideId: '1', snapshot: {messages: []}, status: {status: 'ready', errorCode: ''}};
  current.resolve(result);
  assert.equal(await selected, result);
  previous.reject(Object.assign(new Error('Previous room selection was cancelled'), {code: 'SESSION_CHANGED'}));
  await firstResult;
  assert.equal(context.ledger.list().filter(task => task.status === 'succeeded').length, 1);
  assert.equal(context.ledger.list().filter(task => task.status === 'failed').length, 1);
});

test('identity changes isolate old request callbacks and duplicate maps', async () => {
  const context = setup(), firstPending = deferred(), secondPending = deferred();
  const oldLedger = context.ledger;
  const first = context.runner.run('listScrolls', [{}], () => firstPending.promise);
  context.replace();
  const second = context.runner.run('listScrolls', [{}], () => secondPending.promise);
  assert.notEqual(first, second);
  firstPending.resolve({scrolls: []}); await first;
  assert.equal(oldLedger.list()[0].status, 'succeeded');
  assert.equal(context.ledger.list()[0].status, 'running');
  secondPending.resolve({scrolls: [{title: 'new'}]}); await second;
  assert.equal(context.ledger.list()[0].summary, '已读取 1 份卷轴的目录。');
});

test('request correlation stays inside asynchronous task context and never stores the prompt', async () => {
  const context = setup();
  assert.equal(currentTask(), null);
  await context.runner.run('requestTownRead', [{kind: 'bonfire'}], async () => {
    await Promise.resolve();
    const active = currentTask();
    assert.equal(active.ledger, context.ledger);
    assert.equal(active.task.feature, 'bonfire');
    context.runner.recordRequest({requestId: 'request-1', prompt: 'private prompt', token: 'private token'});
    return bonfire;
  });
  assert.equal(context.runner.currentTask(), null);
  assert.equal(context.ledger.list()[0].requestId, 'request-1');
  assert.doesNotMatch(JSON.stringify(context.ledger.snapshot()), /private prompt|private token/);
  assert.equal(context.runner.recordRequest({requestId: 'outside'}), null);
});

test('independent concurrent tasks retain their own AsyncLocalStorage request identifiers', async () => {
  const context = setup(), release = deferred();
  const first = context.runner.run('getScroll', [{id: 'one'}], async () => { await release.promise; context.runner.recordRequest({requestId: 'one'}); return {scroll: {title: 'one'}}; });
  const second = context.runner.run('getScroll', [{id: 'two'}], async () => { context.runner.recordRequest({requestId: 'two'}); release.resolve(); return {scroll: {title: 'two'}}; });
  await Promise.all([first, second]);
  assert.deepEqual(context.ledger.list().map(task => task.requestId).sort(), ['one', 'two']);
});

test('accepted and unknown execution results stay waiting and preserve original errors', async () => {
  for (const code of ['REQUEST_ACCEPTED', 'RESULT_UNKNOWN']) {
    const context = setup();
    const error = Object.assign(new Error('raw secret payload'), {code});
    await assert.rejects(context.runner.run('listScrolls', [{}], () => { throw error; }), candidate => candidate === error);
    assert.equal(context.ledger.list()[0].status, 'waiting');
    assert.doesNotMatch(JSON.stringify(context.ledger.snapshot()), /raw secret/);
  }
  const context = setup();
  const result = {accepted: true};
  assert.equal(await context.runner.run('listScrolls', [{}], () => result), result);
  assert.equal(context.ledger.list()[0].status, 'waiting');
});

test('response errors cannot appear as successful tasks while existing UI receives the same result', async () => {
  for (const response of [{error: {code: 'NETWORK_ERROR', message: 'secret'}}, {__townError: true, code: 'SERVICE_ERROR'}, {ok: false, code: 'SERVICE_ERROR'}]) {
    const context = setup();
    assert.equal(await context.runner.run('getGroveCatalog', [{}], () => response), response);
    assert.equal(context.ledger.list()[0].status, 'failed');
    assert.doesNotMatch(JSON.stringify(context.ledger.snapshot()), /secret/);
  }
});

test('a rejected preflight ends locally and a later explicit read can complete independently', async () => {
  const context=setup();
  await assert.rejects(context.runner.run('requestTownRead',[{kind:'bonfire'}],()=>{throw Object.assign(new Error('busy'),{code:'BUSY'});}),{code:'BUSY'});
  const rejected=context.ledger.list()[0];
  assert.equal(rejected.status,'failed');assert.equal(rejected.requestId,'');assert.match(rejected.detail,/未发送/);
  await context.runner.run('requestTownRead',[{kind:'bonfire'}],()=>bonfire);
  assert.equal(context.ledger.list()[0].status,'succeeded');assert.equal(context.ledger.get(rejected.id).status,'failed');
});

test('explicit busy and accepted transport states take precedence over stale result arrays', async () => {
  for (const status of ['accepted', 'busy', 'BUSY', 202]) {
    const context = setup();
    await context.runner.run('listScrolls', [{}], () => ({status, scrolls: []}));
    assert.equal(context.ledger.list()[0].status, ['busy', 'BUSY'].includes(status) ? 'failed' : 'waiting');
  }
});

test('Town old snapshots never count as a successful new request when status reports failure or waiting', async () => {
  for (const [code, expected] of [['REQUEST_ACCEPTED', 'waiting'], ['BUSY', 'failed'], ['READINESS_UNKNOWN', 'failed'], ['RESULT_UNCONFIRMED', 'needs_input'], ['NETWORK_ERROR', 'failed']]) {
    const context = setup();
    const response = {...bonfire, status: {status: 'waiting', errorCode: code}};
    await context.runner.run('requestTownRead', [{kind: 'bonfire'}], () => response);
    assert.equal(context.ledger.list()[0].status, expected);
    assert.equal(context.ledger.list()[0].summary, '');
  }
});

test('Grove installation checks require user setup and never claim installation', async () => {
  const context = setup();
  await context.runner.run('prepareGroveInstallation', [{id: 'kit'}], () => ({status: 'needs_setup', kit: {name: 'name', env: {API_KEY: 'private'}}, assessment: {blocked: true}}));
  const task = context.ledger.list()[0];
  assert.equal(task.status, 'needs_input');
  assert.equal(task.mayDelayChat, false);
  assert.match(task.detail, /尚未安装或运行脚本/);
  assert.doesNotMatch(JSON.stringify(task), /private|API_KEY/);
});

test('Channel outcomes distinguish QR authorization, pending, unsupported and confirmed statuses', async () => {
  for (const [result, expected] of [[{status: 'pending'}, 'waiting'], [{status: 'unknown'}, 'waiting'], [{status: 'pending', qrCodeDataUrl: 'data:image/png;base64,private'}, 'needs_input'], [{status: 'registered'}, 'needs_input'], [{status: 'unsupported'}, 'failed'], [{status: 'connected'}, 'succeeded']]) {
    const context = setup();
    await context.runner.run('beginChannelConnection', [{channel: 'wechat'}], () => ({...result, detail: 'secret raw channel response'}));
    assert.equal(context.ledger.list()[0].status, expected);
    assert.doesNotMatch(JSON.stringify(context.ledger.snapshot()), /base64|secret raw|qrCode/);
  }
});

test('Channel checks can report disconnection while a connection operation still needs action', async () => {
  const context = setup();
  await context.runner.run('checkChannelStatus', [{channel: 'feishu'}], () => ({status: 'disconnected'}));
  assert.equal(context.ledger.list()[0].status, 'succeeded');
  await context.runner.run('beginChannelConnection', [{channel: 'feishu'}], () => ({status: 'disconnected'}));
  assert.equal(context.ledger.list()[0].status, 'needs_input');
});

test('Portal status confirms local process operations without implying a verified relay', async () => {
  const context = setup();
  await context.runner.run('startPortal', [], () => ({portal: {status: 'running', health: 'unknown'}}));
  assert.equal(context.ledger.list()[0].status, 'succeeded');
  assert.match(context.ledger.list()[0].summary, /中继连接状态.*确认/);
  await context.runner.run('stopPortal', [], () => ({portal: {status: 'external'}}));
  assert.equal(context.ledger.list()[0].status, 'needs_input');
  await context.runner.run('deployPortal', [], () => ({status: 'existing_connection'}));
  assert.equal(context.ledger.list()[0].status, 'needs_input');
  await context.runner.run('stopPortal', [], () => ({portal: {status: 'stopped'}}));
  assert.equal(context.ledger.list()[0].status, 'succeeded');
});

test('Portal update response errors are failures even when the outer call resolved', async () => {
  const context = setup();
  await context.runner.run('checkPortalUpdates', [], () => ({portalUpdate: {status: 'error'}}));
  assert.equal(context.ledger.list()[0].status, 'failed');
  await context.runner.run('checkPortalUpdates', [], () => ({portalUpdate: {status: 'available', releaseUrl: 'https://example.test/?token=secret'}}));
  assert.equal(context.ledger.list()[0].status, 'succeeded');
  assert.doesNotMatch(JSON.stringify(context.ledger.snapshot()), /example.test|secret/);
});

test('curated library and Grove summaries contain titles and counts, not raw bodies or setup data', async () => {
  const context = setup();
  await context.runner.run('getScroll', [{id: 'one'}], () => ({scroll: {title: '日志', content: 'private body'}}));
  await context.runner.run('getGroveCatalog', [{}], () => ({kits: [{name: 'one', description: 'private manifest'}]}));
  await context.runner.run('getGroveDetail', ['one'], () => ({name: 'One', setup_guide: {env_template: {TOKEN: 'private setup'}}}));
  await context.runner.run('requestTownRead', [{kind: 'fireside'}], () => ({rooms: {owned: [{id: 1, description: 'private room'}], joined: []}}));
  assert.ok(context.ledger.list().every(task => task.status === 'succeeded'));
  assert.doesNotMatch(JSON.stringify(context.ledger.snapshot()), /private body|private manifest|private setup|private room|env_template/);
});

test('unknown response shapes remain unconfirmed and raw backend exceptions retain identity', async () => {
  const context = setup();
  await context.runner.run('getScroll', [{id: 'one'}], () => ({message: 'done'}));
  assert.equal(context.ledger.list()[0].status, 'waiting');
  const error = new Error('private upstream exception');
  await assert.rejects(context.runner.run('getGroveDetail', ['one'], () => Promise.reject(error)), candidate => candidate === error);
  assert.equal(context.ledger.list()[0].status, 'failed');
  assert.doesNotMatch(JSON.stringify(context.ledger.snapshot()), /private upstream/);
});

test('a full active ledger never prevents stopping Portal but still blocks new tracked work', async () => {
  const ledger = new FeatureTasks({maxRecords: 1});
  const existing = ledger.begin({feature: 'channel', operation: 'connect', title: '渠道授权', execution: 'being'});
  ledger.update(existing.id, {status: 'waiting'});
  const runner = new FeatureTaskRunner({getLedger: () => ledger});
  let stopped = 0;
  const result = {portal: {status: 'stopped'}};
  assert.equal(await runner.run('stopPortal', [], async () => { stopped++; return result; }), result);
  assert.equal(stopped, 1);
  assert.equal(ledger.list().length, 1);
  assert.equal(ledger.get(existing.id).status, 'waiting');
  let started = 0;
  assert.throws(() => runner.run('startPortal', [], () => { started++; }), {code: 'TASK_LIMIT_REACHED'});
  assert.equal(started, 0);
});

test('the full-ledger stop escape preserves stop failures and never swallows unrelated bookkeeping errors', async () => {
  const ledger = new FeatureTasks({maxRecords: 1});
  ledger.begin({feature: 'portal', operation: 'inspect', title: '待核对'});
  const runner = new FeatureTaskRunner({getLedger: () => ledger});
  const stopError = new Error('Portal could not stop');
  await assert.rejects(runner.run('stopPortal', [], async () => { throw stopError; }), error => error === stopError);
  let stopped = false;
  const ledgerError = new Error('Unexpected ledger failure');
  ledger.begin = () => { throw ledgerError; };
  assert.throws(() => runner.run('stopPortal', [], () => { stopped = true; }), error => error === ledgerError);
  assert.equal(stopped, false);
});
