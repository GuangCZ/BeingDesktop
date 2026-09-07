'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DesktopTerminal } = require('../src/desktop-terminal.cjs');

class FakePty {
  constructor(pid) { this.pid = pid; this.data = new Set(); this.exit = new Set(); this.errors = new Set(); this.writes = []; this.sizes = []; this.kills = 0; }
  onData(listener) { this.data.add(listener); return { dispose: () => this.data.delete(listener) }; }
  onExit(listener) { this.exit.add(listener); return { dispose: () => this.exit.delete(listener) }; }
  emit(text) { for (const listener of this.data) listener(text); }
  end(exitCode = 0) { for (const listener of this.exit) listener({ exitCode }); }
  write(value) { this.writes.push(value); }
  resize(cols, rows) { this.sizes.push({ cols, rows }); }
  kill() { this.kills++; this.end(1); }
  on(name, listener) { if (name === 'error') this.errors.add(listener); }
  removeListener(name, listener) { if (name === 'error') this.errors.delete(listener); }
}

function fixture(options = {}) {
  const calls = [];
  const pty = { spawn: (...args) => { const handle = new FakePty(1000 + calls.length); calls.push({ args, handle }); return handle; } };
  const service = new DesktopTerminal({ pty, getWorkspace: () => path.resolve(__dirname, '..'), platform: 'win32', ...options });
  return { service, calls };
}

test('terminal construction is lazy and snapshots contain no output or environment', async () => {
  const { service, calls } = fixture();
  assert.deepEqual(service.snapshot(), { sessions: [], activeSessionId: null });
  assert.equal(calls.length, 0);
  await service.dispose();
  await assert.rejects(service.create(), /关闭/);
});

test('creation selects a real directory, ConPTY and an interactive shell with a clean environment', async () => {
  const { service, calls } = fixture({ environment: {
    SystemRoot: 'C:\\Windows', Path: 'safe-path', OPENAI_API_KEY: 'private', BEING_TOKEN: 'private',
    HTTP_PROXY: 'http://user:secret@proxy', ELECTRON_RUN_AS_NODE: '1', OTHER: 'private',
  } });
  try {
    const { sessionId } = await service.create({ cols: 91, rows: 22 });
    const [file, args, options] = calls[0].args;
    assert.match(file, /powershell\.exe$/i);
    assert.deepEqual(args, ['-NoLogo', '-NoProfile']);
    assert.equal(options.useConpty, true);
    assert.equal(options.conptyInheritCursor, false);
    assert.equal(options.env.Path, 'safe-path');
    assert.equal(options.env.TERM, 'xterm-256color');
    for (const key of ['OPENAI_API_KEY', 'BEING_TOKEN', 'HTTP_PROXY', 'ELECTRON_RUN_AS_NODE', 'OTHER']) assert.equal(options.env[key], undefined);
    assert.equal(service.snapshot().activeSessionId, sessionId);
    assert.equal(service.snapshot().sessions[0].cols, 91);
    assert.equal(service.snapshot().sessions[0].status, 'running');
  } finally { await service.dispose(); }
});

test('input, Ctrl+C and terminal responses go to the same persistent session', async () => {
  const { service, calls } = fixture();
  try {
    const { sessionId: id } = await service.create();
    for (const data of ['cd child\r', 'echo 中文🙂\r', '\x03', '\x1b[A', '\x1b[1;1R']) service.write({ id, data });
    assert.deepEqual(calls[0].handle.writes, ['cd child\r', 'echo 中文🙂\r', '\x03', '\x1b[A', '\x1b[1;1R']);
    assert.equal(calls.length, 1);
    assert.throws(() => service.write({ id, data: '界'.repeat(23000) }), /64 KiB/);
    assert.throws(() => service.write({ id, data: null }), /64 KiB/);
    assert.throws(() => service.write({ id: 'unknown', data: 'x' }), /不存在/);
  } finally { await service.dispose(); }
});

test('resize validates before native calls and ignores identical dimensions', async () => {
  const { service, calls } = fixture();
  try {
    const { sessionId: id } = await service.create();
    service.resize({ id, cols: 100, rows: 30 });
    service.resize({ id, cols: 120, rows: 42 });
    assert.deepEqual(calls[0].handle.sizes, [{ cols: 120, rows: 42 }]);
    for (const [cols, rows] of [[0, 20], [501, 20], [80, 201], [80.5, 20], [80, NaN]]) assert.throws(() => service.resize({ id, cols, rows }), /尺寸/);
    assert.equal(calls[0].handle.sizes.length, 1);
  } finally { await service.dispose(); }
});

test('invalid creation dimensions and invalid directories never spawn', async () => {
  const { service, calls } = fixture();
  for (const options of [{ cols: 0 }, { rows: 201 }, { cwd: 'relative' }, { cwd: __filename }, { cwd: path.join(__dirname, 'missing-terminal-fixture') }]) {
    await assert.rejects(service.create(options));
  }
  assert.equal(calls.length, 0);
  await service.dispose();
});

test('the eight-session limit includes concurrent pending creates', async () => {
  let release;
  const workspace = new Promise(resolve => { release = resolve; });
  const { service, calls } = fixture({ getWorkspace: () => workspace });
  try {
    const creates = Array.from({ length: 8 }, () => service.create());
    await assert.rejects(service.create(), /8 个终端/);
    release(path.resolve(__dirname, '..'));
    await Promise.all(creates);
    assert.equal(calls.length, 8);
    await assert.rejects(service.create(), /8 个终端/);
  } finally { await service.dispose(); }
});

test('dispose during asynchronous workspace resolution prevents the spawn', async () => {
  let release;
  const workspace = new Promise(resolve => { release = resolve; });
  const { service, calls } = fixture({ getWorkspace: () => workspace });
  const pending = service.create();
  await service.dispose();
  release(path.resolve(__dirname, '..'));
  await assert.rejects(pending, /关闭/);
  assert.equal(calls.length, 0);
});

test('replay sequence and streaming sequence avoid loss or duplicate delivery', async () => {
  const events = [];
  const { service, calls } = fixture({ onData: event => events.push(event) });
  try {
    const { sessionId: id } = await service.create();
    calls[0].handle.emit('one');
    const replay = service.read(id);
    calls[0].handle.emit('two');
    assert.equal(replay.data, 'one');
    assert.equal(replay.sequence, 1);
    assert.equal(replay.data + events.filter(event => event.sequence > replay.sequence).map(event => event.data).join(''), 'onetwo');
    assert.deepEqual(events.map(event => event.id), [id, id]);
    assert.equal('data' in service.snapshot().sessions[0], false);
  } finally { await service.dispose(); }
});

test('replay memory and individual stream chunks are bounded without splitting Unicode', async () => {
  const events = [];
  const { service, calls } = fixture({ onData: event => events.push(event) });
  try {
    const { sessionId: id } = await service.create();
    calls[0].handle.emit('界🙂'.repeat(400000) + 'tail-marker');
    const replay = service.read(id);
    assert.equal(replay.truncated, true);
    assert.ok(Buffer.byteLength(replay.data) <= 1024 * 1024);
    assert.ok(replay.data.endsWith('tail-marker'));
    for (const event of events) {
      assert.ok(Buffer.byteLength(event.data) <= 64 * 1024);
      assert.equal(event.data, Buffer.from(event.data, 'utf8').toString('utf8'));
    }
    assert.equal(replay.data, Buffer.from(replay.data, 'utf8').toString('utf8'));
  } finally { await service.dispose(); }
});

test('observer failures cannot lose replay or interrupt terminal teardown', async () => {
  const { service, calls } = fixture({ onChange: () => { throw new Error('observer'); }, onData: () => { throw new Error('observer'); } });
  const { sessionId: id } = await service.create();
  calls[0].handle.emit('still-available');
  assert.equal(service.read(id).data, 'still-available');
  await service.dispose();
  assert.equal(calls[0].handle.kills, 1);
});

test('closing a session stops only its owned PTY, preserves others and deduplicates', async () => {
  const { service, calls } = fixture();
  try {
    const { sessionId: first } = await service.create();
    const { sessionId: second } = await service.create();
    service.activate(first);
    await Promise.all([service.close(first), service.close(first)]);
    assert.equal(calls[0].handle.kills, 1);
    assert.equal(calls[1].handle.kills, 0);
    assert.equal(service.snapshot().activeSessionId, second);
    assert.equal(calls[0].handle.data.size, 0);
    assert.equal(calls[0].handle.exit.size, 0);
  } finally { await service.dispose(); }
});

test('natural exit preserves scrollback and exit code but blocks new input', async () => {
  const { service, calls } = fixture();
  try {
    const { sessionId: id } = await service.create();
    calls[0].handle.emit('last output');
    calls[0].handle.end(7);
    assert.equal(service.snapshot().sessions[0].exitCode, 7);
    assert.equal(service.snapshot().sessions[0].status, 'exited');
    assert.equal(service.read(id).data, 'last output');
    assert.throws(() => service.write({ id, data: 'x' }), /结束/);
    assert.throws(() => service.resize({ id, cols: 90, rows: 30 }), /结束/);
    await service.close(id);
    assert.equal(calls[0].handle.kills, 1);
  } finally { await service.dispose(); }
});

test('failed native close is retryable and never drops ownership', async () => {
  const { service, calls } = fixture();
  const { sessionId: id } = await service.create();
  const original = calls[0].handle.kill.bind(calls[0].handle);
  calls[0].handle.kill = () => { throw new Error('owned PTY is busy'); };
  await assert.rejects(service.close(id), /busy/);
  assert.equal(service.snapshot().sessions.length, 1);
  calls[0].handle.kill = original;
  await service.close(id);
  assert.equal(service.snapshot().sessions.length, 0);
  await service.dispose();
});

test('failed dispose restores a usable service and a later successful dispose closes it', async () => {
  const { service, calls } = fixture();
  const { sessionId: first } = await service.create();
  const originalKill = calls[0].handle.kill.bind(calls[0].handle);
  calls[0].handle.kill = () => { throw new Error('fixture close failure'); };
  await assert.rejects(service.dispose(), /fixture close failure/);
  assert.equal(service.disposed, false);
  assert.equal(service.snapshot().sessions[0].id, first);
  assert.equal(service.snapshot().sessions[0].status, 'running');
  const { sessionId: second } = await service.create();
  service.write({ id: second, data: 'still usable\r' });
  assert.deepEqual(calls[1].handle.writes, ['still usable\r']);
  calls[0].handle.kill = originalKill;
  await service.close(first);
  await service.dispose();
  assert.equal(service.disposed, true);
  assert.equal(service.snapshot().sessions.length, 0);
  assert.equal(calls[0].handle.kills, 1);
  assert.equal(calls[1].handle.kills, 1);
  await assert.rejects(service.create(), /关闭/);
});

test('failed spawn releases the create slot and unsupported platforms do not launch', async () => {
  const { service } = fixture({ pty: { spawn: () => { throw new Error('native load failed'); } } });
  for (let index = 0; index < 10; index++) await assert.rejects(service.create(), /无法启动/);
  assert.equal(service.pendingCreates, 0);
  assert.equal(service.snapshot().sessions.length, 0);
  await service.dispose();
  const unsupported = fixture({ platform: 'linux' });
  await assert.rejects(unsupported.service.create(), /Windows/);
  assert.equal(unsupported.calls.length, 0);
  await unsupported.service.dispose();
});

test('native stream errors are handled inside the owning session', async () => {
  const { service, calls } = fixture();
  try {
    const { sessionId: id } = await service.create();
    for (const handler of calls[0].handle.errors) handler(new Error('native failure'));
    assert.match(service.read(id).data, /连接已中断/);
    assert.equal(service.snapshot().sessions[0].status, 'exited');
    assert.equal(calls[0].handle.kills, 1);
  } finally { await service.dispose(); }
  assert.equal(calls[0].handle.errors.size, 0);
});

test('natural shell exit releases its pinned node-pty worker and pipe without touching another session', async () => {
  const { service, calls } = fixture();
  try {
    await service.create();
    await service.create();
    let pipes = 0;
    let workers = 0;
    calls[0].handle._agent = { inSocket: { destroy: () => { pipes++; } }, _conoutSocketWorker: { dispose: () => { workers++; } } };
    calls[0].handle.end(0);
    assert.equal(pipes, 1);
    assert.equal(workers, 1);
    assert.equal(calls[1].handle.kills, 0);
    calls[0].handle.end(0);
    assert.equal(pipes, 1);
  } finally { await service.dispose(); }
});
