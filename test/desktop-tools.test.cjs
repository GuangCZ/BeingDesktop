'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DesktopTools } = require('../src/desktop-tools.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options={}) {
  let workspace = 'E:\\fixture-workspace';
  class Browser {
    constructor({ onChange }) { this.onChange = onChange; this.tabs = [{ id: 'browser-fixture', revision: 3, url: 'https://public.example.test/a', title: 'Fixture' }]; this.actions = []; this.preparations = []; this.nextPreparation = null; this.destroyed = false; }
    snapshot() { return { tabs: structuredClone(this.tabs), activeTabId: this.tabs[0]?.id || null }; }
    newTab(args) { this.actions.push(['new', args]); return this.snapshot(); }
    navigate(args) { this.actions.push(['navigate', args]); return this.snapshot(); }
    async readPage(id, revision) { this.actions.push(['read', id, revision]); return { text: 'visible fixture page' }; }
    async prepareAction(args) { this.preparations.push(args); return this.nextPreparation ? this.nextPreparation.promise : { targetToken: 'fixture-target-token', summary: 'Fixture target' }; }
    async click(args) { this.actions.push(['click', args]); return { clicked: true }; }
    async fill(args) { this.actions.push(['fill', args]); return { filled: true }; }
    destroy() { this.destroyed = true; }
  }
  class Console {
    constructor({ onChange }) { this.onChange = onChange; this.jobs = []; this.calls = []; this.stops = []; this.nextRun = null; this.disposed = false; }
    snapshot() { return { jobs: structuredClone(this.jobs) }; }
    async run(args) {
      this.calls.push(args);
      const result = this.nextRun ? await this.nextRun.promise : { jobId: `job-${this.calls.length}` };
      this.jobs.push({ id: result.jobId, command: args.command, cwd: args.cwd, status: 'running', output: [{ stream: 'stdout', text: `output for ${result.jobId}` }] });
      return result;
    }
    async stop(id) { this.stops.push(id); return { stopped: true }; }
    async dispose() { this.disposed = true; }
  }
  class ToolLink {
    constructor({ onChange, invokeTool }) { this.onChange = onChange; this.invokeTool = invokeTool; this.status = 'disconnected'; this.controllers = []; }
    snapshot() { return { status: this.status }; }
    async connect() { this.status = 'connected'; this.onChange(); }
    disconnect() { this.status = 'disconnected'; for (const controller of this.controllers) controller.abort(); this.controllers = []; this.onChange(); }
    dispose() { this.disconnect(); }
    call(name, args, requestKey) {
      const controller = new AbortController();
      this.controllers.push(controller);
      return { controller, promise: this.invokeTool(name, args, { signal: controller.signal, requestKey }) };
    }
  }
  const changes = [];
  const tools = new DesktopTools({ Browser, Console, ToolLink, getWorkspace: () => workspace, getConnection: () => ({ url: 'https://unused.example.test', token: 'never-used' }), onChange: state => changes.push(state),...options });
  return { tools, changes, setWorkspace: value => { workspace = value; } };
}

function requestId(tools) { return tools.snapshot().requests.at(-1).id; }
function body(result) { return JSON.parse(result.content[0].text); }
function nextTurn() { return new Promise(resolve => setImmediate(resolve)); }

test('scoped terminal commands run without a second approval and survive tool reconnects',async t=>{
  const sessions=[],writes=[],shown=[];
  const id=require('node:crypto').randomUUID();
  const terminal={snapshot:()=>({sessions}),async create(){sessions.push({id,status:'running'});return {sessionId:id};},
    readSince:()=>({id,sequence:0,data:''}),write:value=>{writes.push(value);return {written:true};}};
  const {tools}=fixture({getTerminal:()=>terminal,showTerminal:id=>shown.push(id)});t.after(()=>tools.dispose());
  const scope=tools.terminalTools.scope(require('node:crypto').randomUUID());
  const created=await tools.link.call('desktop_terminal_create',{...scope,requestId:require('node:crypto').randomUUID()}).promise;
  assert.equal(body(created).terminalId,id);assert.deepEqual(shown,[id]);assert.equal(tools.snapshot().requests.length,0);
  tools.disconnectLink();
  const written=await tools.link.call('desktop_terminal_write',{...scope,terminalId:id,requestId:require('node:crypto').randomUUID(),data:'test\r'}).promise;
  assert.equal(body(written).written,true);assert.equal(writes.length,1);assert.equal(sessions.length,1);
  const rejected=await tools.link.call('desktop_terminal_read',{...scope,sessionToken:require('node:crypto').randomUUID(),terminalId:id}).promise;
  assert.equal(rejected.isError,true);assert.match(rejected.content[0].text,/会话绑定/);
});

test('remote command stays pending until an explicit approval and freezes its reviewed cwd', async (t) => {
  const { tools, setWorkspace } = fixture();
  t.after(() => tools.dispose());
  const args = { command: 'Write-Output fixture' };
  const call = tools.link.call('desktop_console_run', args);
  const id = requestId(tools);
  args.command = 'mutated after request';
  setWorkspace('E:\\different-workspace');
  assert.equal(tools.console.calls.length, 0);
  assert.equal(tools.snapshot().requests[0].args.command, 'Write-Output fixture');
  assert.equal(tools.snapshot().requests[0].args.cwd, 'E:\\fixture-workspace');
  await tools.perform('request.allow', id);
  assert.equal(body(await call.promise).jobId, 'job-1');
  assert.equal(tools.console.calls.length, 1);
  assert.equal(tools.console.calls[0].cwd, 'E:\\fixture-workspace');
  assert.equal(tools.snapshot().requests.length, 0);
});

test('duplicate approval or denial clicks cannot execute an approved command twice', async (t) => {
  const { tools } = fixture();
  t.after(() => tools.dispose());
  tools.console.nextRun = deferred();
  const call = tools.link.call('desktop_console_run', { command: 'Write-Output fixture' });
  const id = requestId(tools);
  const first = tools.perform('request.allow', id);
  await assert.rejects(tools.perform('request.allow', id), /处理|执行/);
  await assert.rejects(tools.perform('request.deny', id), /处理|执行/);
  assert.equal(tools.console.calls.length, 1);
  tools.console.nextRun.resolve({ jobId: 'only-job' });
  await first;
  assert.equal(body(await call.promise).jobId, 'only-job');
});

test('denial and signal cancellation never launch pending work', async (t) => {
  const { tools } = fixture();
  t.after(() => tools.dispose());
  const denied = tools.link.call('desktop_console_run', { command: 'first' });
  const deniedResult = assert.rejects(denied.promise, /拒绝/);
  await tools.perform('request.deny', requestId(tools));
  await deniedResult;
  const cancelled = tools.link.call('desktop_console_run', { command: 'second' });
  const cancelledResult = assert.rejects(cancelled.promise, /取消|断开|结束/);
  cancelled.controller.abort();
  await cancelledResult;
  assert.equal(tools.console.calls.length, 0);
  assert.equal(tools.snapshot().requests.length, 0);
});

test('disconnect revokes every pending approval without launching commands', async (t) => {
  const { tools } = fixture();
  t.after(() => tools.dispose());
  const calls = Array.from({ length: 3 }, (_, index) => tools.link.call('desktop_console_run', { command: `fixture ${index}` }));
  const results = calls.map(call => assert.rejects(call.promise, /取消|断开|结束/));
  await tools.perform('link.disconnect');
  await Promise.all(results);
  assert.equal(tools.snapshot().requests.length, 0);
  assert.equal(tools.console.calls.length, 0);
});

test('Being output reads include only jobs approved for the current connection', async (t) => {
  const { tools } = fixture();
  t.after(() => tools.dispose());
  await tools.perform('link.connect');
  await tools.perform('console.run', { command: 'local-only', cwd: 'E:\\fixture-workspace' });
  const remote = tools.link.call('desktop_console_run', { command: 'remote-approved' });
  await tools.perform('request.allow', requestId(tools));
  const remoteId = body(await remote.promise).jobId;
  await assert.rejects(tools.link.call('desktop_console_status', { jobId: 'job-1' }).promise, /只能读取/);
  await assert.rejects(tools.link.call('desktop_console_stop', { jobId: 'job-1' }).promise, /只能停止/);
  const status = tools.link.call('desktop_console_status', {});
  await tools.perform('request.allow', requestId(tools));
  assert.deepEqual(body(await status.promise).jobs.map(job => job.id), [remoteId]);
  await tools.perform('link.disconnect');
  await tools.perform('link.connect');
  await assert.rejects(tools.link.call('desktop_console_status', { jobId: remoteId }).promise, /只能读取/);
});

test('an old approved run finishing after reconnect cannot grant its output to the new Being session', async (t) => {
  const { tools } = fixture();
  t.after(() => tools.dispose());
  await tools.perform('link.connect');
  tools.console.nextRun = deferred();
  const old = tools.link.call('desktop_console_run', { command: 'old session delayed start' });
  const rejected = assert.rejects(old.promise, /取消|断开|结束/);
  const allowing = tools.perform('request.allow', requestId(tools));
  await tools.perform('link.disconnect');
  await rejected;
  await tools.perform('link.connect');
  tools.console.nextRun.resolve({ jobId: 'old-session-job' });
  await allowing;
  const status = tools.link.call('desktop_console_status', {});
  await tools.perform('request.allow', requestId(tools));
  assert.deepEqual(body(await status.promise).jobs, []);
});

test('approval cannot navigate a tab whose reviewed page revision changed while waiting', async (t) => {
  const { tools, changes } = fixture();
  t.after(() => tools.dispose());
  const call = tools.link.call('desktop_browser_open', { tabId: 'browser-fixture', url: 'https://public.example.test/target' });
  const id = requestId(tools);
  tools.browser.tabs[0].revision++;
  const rejected = assert.rejects(call.promise, /变化|版本|重新读取/);
  await tools.perform('request.allow', id);
  await rejected;
  assert.equal(tools.browser.actions.length, 0);
  assert.equal(tools.snapshot().requestResult.id, id);
  assert.equal(tools.snapshot().requestResult.status, 'failed');
  assert.match(tools.snapshot().requestResult.message, /过期.*变化/);
  await nextTurn();
  assert.ok(changes.some(state => state.requestResult?.id === id && /过期/.test(state.requestResult.message)));
});

test('approval queue is bounded and missing tabs are never offered for approval', async (t) => {
  const { tools } = fixture();
  t.after(() => tools.dispose());
  await assert.rejects(tools.link.call('desktop_browser_read', { tabId: 'already-closed' }).promise, /关闭/);
  const calls = Array.from({ length: 8 }, () => tools.link.call('desktop_browser_tabs', {}));
  const results = calls.map(call => assert.rejects(call.promise, /取消|断开|结束/));
  await assert.rejects(tools.link.call('desktop_browser_tabs', {}).promise, /过多/);
  tools.disconnectLink();
  await Promise.all(results);
  assert.equal(tools.snapshot().requests.length, 0);
});

test('disposal revokes pending calls and rejects future local or remote operations', async () => {
  const { tools } = fixture();
  const pending = tools.link.call('desktop_console_run', { command: 'pending at exit' });
  const rejected = assert.rejects(pending.promise, /取消|断开|结束/);
  await tools.dispose();
  await rejected;
  assert.equal(tools.console.disposed, true);
  assert.equal(tools.browser.destroyed, true);
  await assert.rejects(tools.perform('console.run', { command: 'too late' }), /关闭/);
  await assert.rejects(tools.link.call('desktop_console_run', { command: 'too late' }).promise, /取消|关闭/);
});

for (const kind of ['click', 'fill']) {
  test(`${kind} waits for target preparation and approval passes the frozen target token`, async (t) => {
    const { tools } = fixture();
    t.after(() => tools.dispose());
    tools.browser.nextPreparation = deferred();
    const args = { tabId: 'browser-fixture', selector: '#reviewed-target', expectedRevision: 3, ...(kind === 'fill' ? { text: 'reviewed text' } : {}) };
    const call = tools.link.call(`desktop_browser_${kind}`, args);
    assert.equal(tools.snapshot().requests.length, 0);
    assert.equal(tools.browser.actions.length, 0);
    assert.deepEqual(tools.browser.preparations, [{ id: 'browser-fixture', selector: '#reviewed-target', expectedRevision: 3, kind }]);
    args.selector = '#changed-after-request';
    if (kind === 'fill') args.text = 'changed after request';
    const prepared = { targetToken: `${kind}-original-target-token`, summary: `Reviewed ${kind} target` };
    tools.browser.nextPreparation.resolve(prepared);
    await nextTurn();
    assert.equal(tools.snapshot().requests.length, 1);
    assert.equal(tools.snapshot().requests[0].targetSummary, `Reviewed ${kind} target`);
    assert.equal(tools.browser.actions.length, 0);
    prepared.targetToken = 'mutated-after-enqueue';
    const id = requestId(tools);
    await tools.perform('request.allow', id);
    assert.equal((await call.promise).isError, false);
    assert.deepEqual(tools.browser.actions, [[kind, {
      id: 'browser-fixture', selector: '#reviewed-target', expectedRevision: 3,
      targetToken: `${kind}-original-target-token`, ...(kind === 'fill' ? { text: 'reviewed text' } : {}),
    }]]);
  });
}

test('disconnect while a target is being prepared prevents a late approval card or page action', async (t) => {
  const { tools } = fixture();
  t.after(() => tools.dispose());
  await tools.perform('link.connect');
  tools.browser.nextPreparation = deferred();
  const call = tools.link.call('desktop_browser_click', { tabId: 'browser-fixture', selector: '#target', expectedRevision: 3 });
  const rejected = assert.rejects(call.promise, /取消|断开|结束/);
  assert.equal(tools.snapshot().requests.length, 0);
  await tools.perform('link.disconnect');
  await tools.perform('link.connect');
  tools.browser.nextPreparation.resolve({ targetToken: 'obsolete-target', summary: 'Old session target' });
  await rejected;
  await nextTurn();
  assert.equal(tools.snapshot().requests.length, 0);
  assert.equal(tools.browser.actions.length, 0);
});

test('an all-job output approval includes only the job range displayed when requested', async (t) => {
  const { tools } = fixture();
  t.after(() => tools.dispose());
  const first = tools.link.call('desktop_console_run', { command: 'first reviewed command' });
  await tools.perform('request.allow', requestId(tools));
  const firstId = body(await first.promise).jobId;
  const status = tools.link.call('desktop_console_status', {});
  const statusId = requestId(tools);
  assert.deepEqual(tools.snapshot().requests.find(request => request.id === statusId).reviewJobs, [{ id: firstId, command: 'first reviewed command', cwd: 'E:\\fixture-workspace' }]);
  const later = tools.link.call('desktop_console_run', { command: 'later separately approved command' });
  await tools.perform('request.allow', requestId(tools));
  const laterId = body(await later.promise).jobId;
  assert.notEqual(firstId, laterId);
  tools.console.jobs.find(job => job.id === firstId).output.push({ stream: 'stdout', text: 'new output from the reviewed job' });
  await tools.perform('request.allow', statusId);
  const jobs = body(await status.promise).jobs;
  assert.deepEqual(jobs.map(job => job.id), [firstId]);
  assert.equal(jobs[0].output.at(-1).text, 'new output from the reviewed job');
});

test('an empty output range cannot expand to commands started while approval waits', async (t) => {
  const { tools } = fixture();
  t.after(() => tools.dispose());
  const status = tools.link.call('desktop_console_status', {});
  const statusId = requestId(tools);
  assert.deepEqual(tools.snapshot().requests[0].reviewJobs, []);
  const later = tools.link.call('desktop_console_run', { command: 'first command after empty read request' });
  await tools.perform('request.allow', requestId(tools));
  await later.promise;
  await tools.perform('request.allow', statusId);
  assert.deepEqual(body(await status.promise).jobs, []);
});
