'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { DesktopConsole, consoleEnvironment } = require('../src/desktop-console.cjs');

function fixture(options = {}) {
  const calls = [];
  const children = [];
  const service = new DesktopConsole({
    platform: 'win32', getWorkspace: () => path.resolve(__dirname, '..'),
    spawnImpl: (...args) => {
      calls.push(args);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.killCalls = 0;
      child.kill = () => {
        child.killCalls++;
        child.signalCode = 'SIGTERM';
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      child.complete = (code = 0) => {
        child.exitCode = code;
        child.emit('close', code, null);
      };
      children.push(child);
      return child;
    },
    ...options,
  });
  return { service, calls, children };
}

test('console inherits only an explicit environment allowlist', () => {
  assert.deepEqual(consoleEnvironment({
    PATH: 'tools', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\fixture',
    BEING_LOOM_URL: 'private', coworkToken: 'private', OPENAI_API_KEY: 'private',
    HTTP_PROXY: 'private', HTTPS_PROXY: 'private', NODE_OPTIONS: 'private',
    ELECTRON_RUN_AS_NODE: '1', arbitraryAppSecret: 'private',
  }), { PATH: 'tools', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\fixture' });
});

test('invalid commands and working directories never launch a process', async (t) => {
  const { service, calls } = fixture();
  t.after(() => service.dispose());
  for (const command of [undefined, '', '  ', 'bad\0command', 'x'.repeat(65537)]) await assert.rejects(service.run({ command }));
  for (const cwd of ['', '..', path.join(__dirname, 'missing-console-workspace'), __filename]) await assert.rejects(service.run({ command: 'echo ok', cwd }));
  assert.equal(calls.length, 0);
});

test('commands use stdin and a hidden owned runner without interpolation', async (t) => {
  const { service, calls, children } = fixture();
  t.after(() => service.dispose());
  const command = "Write-Output '中文 `$HOME; \"quoted\"'\nexit 4";
  const { jobId } = await service.run({ command });
  const [shell, args, options] = calls[0];
  assert.match(shell, /powershell\.exe$/);
  assert.equal(options.windowsHide, true);
  assert.equal(options.shell, false);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.ok(!args.some(value => value.includes(command)));
  assert.equal(children[0].stdin.read().toString('utf8'), command);
  const runner = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  assert.match(runner, /CreateJobObject/);
  assert.match(runner, /AssignProcessToJobObject/);
  assert.match(runner, /0x2000/);
  children[0].emit('spawn');
  children[0].stdout.write(Buffer.from('中文输出\n'));
  children[0].stderr.write('error output\n');
  children[0].complete(4);
  const job = service.snapshot().jobs.find(item => item.id === jobId);
  assert.equal(job.status, 'failed');
  assert.equal(job.exitCode, 4);
  assert.equal(job.output[0].text, '中文输出\n');
  assert.equal(job.output[1].stream, 'stderr');
  assert.ok(job.endedAt);
});

test('output limits preserve valid Unicode and independent stdout/stderr streams', async (t) => {
  const { service, children } = fixture({ maxOutputBytes: 1024 });
  t.after(() => service.dispose());
  await service.run({ command: 'fixture output' });
  children[0].stdout.write('旧'.repeat(1000));
  children[0].stderr.write('末尾🙂'.repeat(120));
  const job = service.snapshot().jobs[0];
  assert.equal(job.truncated, true);
  assert.ok(job.output.reduce((size, item) => size + Buffer.byteLength(item.text), 0) <= 1024);
  assert.ok(job.output.every(item => !item.text.includes('�')));
  assert.equal(job.output.at(-1).stream, 'stderr');
  assert.ok(job.output.at(-1).text.endsWith('末尾🙂'));
});

test('pending asynchronous runs reserve concurrency and disposal cancels pending launch', async () => {
  let release;
  const { service, calls, children } = fixture({ maxConcurrent: 1, getWorkspace: () => new Promise(resolve => { release = resolve; }) });
  const first = service.run({ command: 'first' });
  await assert.rejects(service.run({ command: 'second' }), /最多同时/);
  await service.dispose();
  release(path.resolve(__dirname));
  await assert.rejects(first, /已经关闭/);
  assert.equal(calls.length, 0);
  assert.equal(children.length, 0);
});

test('stop targets only its retained child, is idempotent, and leaves other jobs running', async (t) => {
  const { service, children } = fixture();
  t.after(() => service.dispose());
  const first = await service.run({ command: 'first' });
  const second = await service.run({ command: 'second' });
  children.forEach(child => child.emit('spawn'));
  const stopping = service.stop(first.jobId);
  const again = service.stop(first.jobId);
  assert.deepEqual(await stopping, { stopped: true });
  assert.deepEqual(await again, { stopped: true });
  assert.equal(children[0].killCalls, 1);
  assert.equal(children[1].killCalls, 0);
  assert.equal(service.snapshot().jobs.find(job => job.id === second.jobId).status, 'running');
  assert.deepEqual(await service.stop(first.jobId), { stopped: false });
  assert.deepEqual(await service.stop('unknown-job'), { stopped: false });
});

test('clear and snapshot cannot rerun commands or mutate retained output', async (t) => {
  const { service, children, calls } = fixture();
  t.after(() => service.dispose());
  const { jobId } = await service.run({ command: 'one command' });
  children[0].stdout.write('before clear');
  const copy = service.snapshot();
  copy.jobs[0].output[0].text = 'modified';
  assert.equal(service.snapshot().jobs[0].output[0].text, 'before clear');
  assert.deepEqual(service.clear(jobId), { cleared: 1 });
  assert.equal(service.snapshot().jobs[0].output.length, 0);
  children[0].stdout.write('after clear');
  assert.equal(service.snapshot().jobs[0].output[0].text, 'after clear');
  assert.equal(calls.length, 1);
});

test('history evicts completed jobs while retaining a running job', async (t) => {
  const { service, children } = fixture({ maxJobs: 2 });
  t.after(() => service.dispose());
  const first = await service.run({ command: 'long job' });
  await service.run({ command: 'short job' });
  children[1].complete();
  const last = await service.run({ command: 'last job' });
  assert.deepEqual(service.snapshot().jobs.map(job => job.id), [first.jobId, last.jobId]);
});

test('spawn failure is a reviewable failed job and cannot leak a concurrency slot', async () => {
  const { service } = fixture({ maxConcurrent: 1, spawnImpl: () => { throw new Error('fixture failure'); } });
  await service.run({ command: 'first' });
  await service.run({ command: 'second' });
  assert.ok(service.snapshot().jobs.every(job => job.status === 'failed' && job.endedAt));
  await service.dispose();
});

test('cancellation while a workspace resolves prevents any process launch', async (t) => {
  let release;
  const { service, calls } = fixture({ getWorkspace: () => new Promise(resolve => { release = resolve; }) });
  t.after(() => service.dispose());
  const controller = new AbortController();
  const running = service.run({ command: 'cancelled before launch', signal: controller.signal });
  controller.abort();
  release(path.resolve(__dirname));
  await assert.rejects(running, /取消/);
  assert.equal(calls.length, 0);
  await assert.rejects(service.run({ command: 'already cancelled', signal: controller.signal }), /取消/);
  assert.equal(calls.length, 0);
});

test('cancellation stops only a still-starting owned process and releases its listener after spawn', async (t) => {
  const { service, children } = fixture();
  t.after(() => service.dispose());
  const startup = new AbortController();
  const { jobId } = await service.run({ command: 'startup cancellation', signal: startup.signal });
  startup.abort();
  await service.stop(jobId);
  assert.equal(children[0].killCalls, 1);
  assert.equal(service.snapshot().jobs[0].status, 'stopped');

  const established = new AbortController();
  await service.run({ command: 'approved established command', signal: established.signal });
  children[1].emit('spawn');
  established.abort();
  assert.equal(children[1].killCalls, 0);
  assert.equal(service.snapshot().jobs[1].status, 'running');
});

test('failed disposal restores command availability and allows a later clean shutdown', async () => {
  const { service, children } = fixture();
  await service.run({ command: 'job whose first stop fails' });
  children[0].emit('spawn');
  const originalKill = children[0].kill;
  children[0].kill = () => false;
  await assert.rejects(service.dispose(), /未能停止/);
  assert.equal(service.snapshot().jobs[0].status, 'running');
  const next = await service.run({ command: 'new command after failed shutdown' });
  assert.ok(next.jobId);
  assert.equal(children.length, 2);
  children[0].kill = originalKill;
  await service.dispose();
  assert.ok(service.snapshot().jobs.every(job => job.status === 'stopped'));
  await assert.rejects(service.run({ command: 'after successful disposal' }), /已经关闭/);
});
