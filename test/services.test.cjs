'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { PortalService, safeListWorkspace, sanitizeText } = require('../src/services.cjs');

const LOOM = 'https://echo.example.test/being/?token=unit-only-secret-value&api=https%3A%2F%2Fecho.example.test%2Fbeing';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'being-services-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('being-services-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const executable = path.join(directory, 'heart-portal-test.exe');
  const configPath = path.join(directory, 'portal.toml');
  await fs.writeFile(executable, 'This fixture is never executed.');
  await fs.writeFile(configPath, 'relay_secret = "short-secret-value"\n');
  return { directory, executable, configPath };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 7654;
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    queueMicrotask(() => child.emit('exit', null, signal));
    return true;
  };
  return child;
}

function serviceHarness(options = {}) {
  const calls = [];
  const child = fakeChild();
  const events = [];
  const service = new PortalService({
    platform: 'win32',
    inspectProcesses: async () => [],
    spawnImpl: (...args) => { calls.push(args); queueMicrotask(() => child.emit('spawn')); return child; },
    onEvent: (event) => events.push(event),
    ...options,
  });
  return { service, calls, child, events };
}

test('workspace lists directories first and exposes only metadata', async (t) => {
  const { directory } = await fixture(t);
  await fs.mkdir(path.join(directory, 'z-folder'));
  await fs.writeFile(path.join(directory, 'a-file.txt'), 'secret file contents');
  const files = await safeListWorkspace(directory);
  assert.equal(files[0].name, 'z-folder');
  assert.deepEqual(files[0], { name: 'z-folder', type: 'directory', size: 0, relativePath: 'z-folder' });
  assert.equal(files.find((item) => item.name === 'a-file.txt').size, 20);
  assert.ok(!JSON.stringify(files).includes('secret file contents'));
});

test('workspace rejects traversal, absolute paths, ADS and non-directory targets', async (t) => {
  const { directory } = await fixture(t);
  for (const relative of ['..', '../elsewhere', 'folder/../../elsewhere', '..\\elsewhere', 'C:\\Windows', '/etc', '\\\\server\\share', 'portal.toml:secret', 'portal.toml', 'bad\0path']) {
    await assert.rejects(safeListWorkspace(directory, relative));
  }
});

test('workspace omits symlinks and rejects traversal through a directory junction', async (t) => {
  const { directory } = await fixture(t);
  const root = path.join(directory, 'workspace');
  const outside = path.join(directory, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'hidden.txt'), 'not listed');
  try { await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Host does not permit test symlinks.'); throw error; }
  assert.deepEqual(await safeListWorkspace(root), []);
  await assert.rejects(safeListWorkspace(root, 'link'));
  await assert.rejects(safeListWorkspace(path.join(root, 'link')));
});

test('workspace caps directory results at 200 entries', async (t) => {
  const { directory } = await fixture(t);
  await Promise.all(Array.from({ length: 205 }, (_, index) => fs.writeFile(path.join(directory, `item-${index}.txt`), '')));
  assert.equal((await safeListWorkspace(directory)).length, 200);
});

test('existing external Portal prevents a duplicate and is never terminated', async (t) => {
  const paths = await fixture(t);
  const { service, calls } = serviceHarness({ inspectProcesses: async () => [{ pid: 9001, name: 'heart-portal-x86_64-pc-windows-msvc.exe', executable: 'elsewhere' }] });
  service.configure(paths);
  assert.equal((await service.start({ connectUrl: LOOM })).status, 'external');
  assert.equal(service.state.owned, false);
  assert.equal(service.state.health, 'unknown');
  assert.equal((await service.stop()).pid, 9001);
  await service.dispose();
  assert.equal(calls.length, 0);
});

test('process inspection failure blocks start instead of assuming no existing process', async (t) => {
  const paths = await fixture(t);
  const { service, calls } = serviceHarness({ inspectProcesses: async () => { throw new Error('access denied'); } });
  service.configure(paths);
  await assert.rejects(service.start({ connectUrl: LOOM }), /无法确认/);
  assert.equal(calls.length, 0);
  assert.equal(service.state.status, 'error');
});

test('starts only selected Portal with fixed argv and no shell; concurrent start is deduplicated', async (t) => {
  const paths = await fixture(t);
  const { service, child, calls } = serviceHarness();
  service.configure(paths);
  const first = service.start({ connectUrl: LOOM });
  const second = service.start({ connectUrl: LOOM });
  assert.equal(first, second);
  await first;
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], paths.executable);
  assert.deepEqual(calls[0][1], ['--config', paths.configPath, '--connect', new URL(LOOM).toString(), '--name', 'being-desktop']);
  assert.equal(calls[0][2].env.HEART_PORTAL_SUPERVISED, '1');
  const {env:childEnvironment,...spawnOptions}=calls[0][2];
  assert.deepEqual(spawnOptions, { cwd: paths.directory, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(service.state.status, 'running');
  assert.equal(service.state.owned, true);
  assert.equal(service.state.health, 'unknown');
  assert.ok(!JSON.stringify(service.state).includes('unit-only-secret-value'));
  assert.throws(() => service.configure({ configPath: paths.configPath }), /先停止/);
  await service.dispose();
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(service.state.status, 'stopped');
  assert.match(service.state.detail, /Windows 强制终止/);
  assert.match(service.state.detail, /未确认/);
});

test('rejects missing connection, insecure remote URL, unexpected executable and missing config', async (t) => {
  const paths = await fixture(t);
  const { service, calls } = serviceHarness();
  service.configure(paths);
  await assert.rejects(service.start(), /先连接/);
  for (const connectUrl of ['http://echo.example.test/?token=x', 'file:///tmp/a', 'https://user:pass@echo.example.test/']) await assert.rejects(service.start({ connectUrl }));
  service.configure({ executable: process.execPath });
  await assert.rejects(service.start({ connectUrl: LOOM }), /heart-portal/);
  service.configure({ executable: paths.executable, configPath: path.join(paths.directory, 'missing.toml') });
  await assert.rejects(service.start({ connectUrl: LOOM }), /不存在/);
  assert.equal(calls.length, 0);
});

test('relay health changes only for observed upstream handshake/disconnection log patterns', async (t) => {
  const paths = await fixture(t);
  const { service, child } = serviceHarness();
  service.configure(paths);
  await service.start({ connectUrl: LOOM });
  child.stdout.write('Portal listening on 127.0.0.1:8000; unrelated connected\n');
  assert.equal(service.state.health, 'unknown');
  child.stderr.write('INFO Portal relay handshake OK — starting MCP server on WebSocket bridge\n');
  assert.equal(service.state.health, 'connected');
  child.stderr.write('WARN relay session ended: heartbeat timeout\n');
  assert.equal(service.state.health, 'disconnected');
  await service.stop();
  assert.equal(service.state.health, 'unknown');
  child.stderr.write('INFO Portal relay handshake OK — starting MCP server on WebSocket bridge\n');
  assert.equal(service.state.health, 'unknown');
});

test('unknown logs are dropped instead of exposing URLs, config secrets, keys or bearer values', async (t) => {
  const paths = await fixture(t);
  const { service, child, events } = serviceHarness();
  service.configure(paths);
  await service.start({ connectUrl: LOOM });
  const eventCount = events.length;
  child.stdout.write('URL https://user:password@echo.example.test/being/?key=abc&secret=def#fragment relay_secret="short-secret-value" token=unit-only-');
  child.stdout.write('secret-value Authorization: Bearer access-value\n');
  child.stdout.write('unlabelled short-secret-value from config\n');
  const serialized = JSON.stringify({ logs: service.logs, events, state: service.state });
  for (const secret of ['password@', '?key=abc', 'secret=def', '#fragment', 'short-secret-value', 'unit-only-secret-value', 'access-value']) assert.ok(!serialized.includes(secret), `leaked ${secret}`);
  assert.equal(events.length, eventCount);
  await service.stop();
});

test('log ring is bounded and defensive copies cannot alter internal state', async (t) => {
  const paths = await fixture(t);
  const { service, child } = serviceHarness();
  service.configure(paths);
  await service.start({ connectUrl: LOOM });
  for (let index = 0; index < 120; index++) child.stderr.write('INFO Portal relay handshake OK — starting MCP server on WebSocket bridge\n');
  assert.equal(service.logs.length, 100);
  const copied = service.logs;
  copied[0].detail = 'modified';
  service.state.status = 'external';
  assert.notEqual(service.logs[0].detail, 'modified');
  assert.equal(service.state.status, 'running');
  await service.stop();
});

test('spawn failures have sanitized user-facing messages and no owned process', async (t) => {
  const paths = await fixture(t);
  const child = fakeChild();
  const { service } = serviceHarness({ spawnImpl: () => { queueMicrotask(() => child.emit('error', new Error(`secret=${LOOM}`))); return child; } });
  service.configure(paths);
  await assert.rejects(service.start({ connectUrl: LOOM }), /启动失败/);
  assert.equal(service.state.owned, false);
  assert.equal(service.state.pid, null);
  assert.equal(service.state.status, 'error');
  assert.ok(!JSON.stringify(service.logs).includes('unit-only-secret-value'));
});

test('sanitizeText redacts credential-shaped content without requiring known secrets', () => {
  const text = sanitizeText('token=tok secret="sec" relay_secret=relay api_key=api key=keyval Bearer authval https://user:pass@host/path?token=urltok#hash sk-abc123 ' + 'a'.repeat(64));
  for (const secret of ['=tok ', '"sec"', '=relay ', '=api ', '=keyval ', 'authval', 'user:pass', 'urltok', '#hash', 'sk-abc123', 'a'.repeat(64)]) assert.ok(!text.includes(secret), secret);
  assert.match(text, /https:\/\/host\/path/);
  assert.ok(!sanitizeText('Cookie: session=private-cookie; preference=private-pref').includes('private-'));
  assert.ok(!sanitizeText('{"cookie":"private-json-cookie"}').includes('private-json-cookie'));
  assert.ok(!sanitizeText('Authorization: Basic private-authentication').includes('private-authentication'));
});

test('a failed stop preserves ownership until the child actually exits', async (t) => {
  const paths = await fixture(t);
  const { service, child } = serviceHarness();
  service.configure(paths);
  await service.start({ connectUrl: LOOM });
  const actualKill = child.kill;
  child.kill = () => { queueMicrotask(() => child.emit('error', new Error('denied'))); return true; };
  await assert.rejects(service.stop(), /停止 Portal 失败/);
  assert.equal(service.state.owned, true);
  assert.equal(service.state.pid, child.pid);
  child.kill = actualKill;
  await service.stop();
  assert.equal(service.state.owned, false);
});

test('tool calls, results, chat bodies, file contents and process command lines never become activity', async (t) => {
  const paths = await fixture(t);
  const { service, child, events } = serviceHarness();
  service.configure(paths);
  await service.start({ connectUrl: LOOM });
  const eventCount = events.length;
  const payloads = [
    'INFO portal_exec command="git config user.name PrivatePerson" result="private-result"',
    'DEBUG request={"message":"private-chat-body","role":"user"}',
    'INFO portal_file_read result="private-file-contents without any key marker"',
    'CommandLine: heart-portal.exe --connect https://echo.test/?token=private-query --config private-config',
    'Cookie: session=private-cookie; preferences=private-preferences',
    'Authorization: Basic private-authorization-header',
    'ERROR tool failure with private-tool-payload',
    'INFO portal_exec: Portal relay handshake OK — starting MCP server on WebSocket bridge',
    '{"message":"Portal relay handshake OK — starting MCP server on WebSocket bridge"}',
  ];
  for (const payload of payloads) child.stdout.write(`${payload}\n`);
  assert.equal(events.length, eventCount);
  assert.equal(service.state.health, 'unknown');
  const serialized = JSON.stringify({ state: service.state, logs: service.logs, events });
  assert.ok(!serialized.includes('private-'));
  assert.ok(!serialized.includes('PrivatePerson'));
  assert.equal(service._droppedLogLines, payloads.length);
  await service.stop();
});

test('recognized relay failures expose fixed categories without raw errors or URLs', async (t) => {
  const paths = await fixture(t);
  const { service, child, events } = serviceHarness();
  service.configure(paths);
  await service.start({ connectUrl: LOOM });
  child.stderr.write('2026-09-06T10:20:30.000Z  INFO heart_portal::relay_client: Portal connect mode: relay wss://private-host/?token=private-token (being_id=private-being)\n');
  child.stderr.write('2026-09-06T10:20:30.100Z  WARN heart_portal::relay_client: relay session error after 2s: private-tool-response; retry in 2s\n');
  assert.equal(service.state.health, 'disconnected');
  assert.ok(events.some((event) => event.title === 'Portal 中继已断开'));
  assert.ok(!JSON.stringify({ logs: service.logs, events, state: service.state }).includes('private-'));
  await service.stop();
});

test('an immediate handshake during the spawn event is not reset to unknown after start', async (t) => {
  const paths = await fixture(t);
  const child = fakeChild();
  const { service } = serviceHarness({ spawnImpl: () => {
    queueMicrotask(() => {
      child.emit('spawn');
      child.stderr.write('2026-09-06T10:20:30.000Z  INFO heart_portal::relay_client: Portal relay handshake OK — starting MCP server on WebSocket bridge\n');
    });
    return child;
  } });
  service.configure(paths);
  const state = await service.start({ connectUrl: LOOM });
  assert.equal(state.status, 'running');
  assert.equal(state.owned, true);
  assert.equal(state.health, 'connected');
  assert.match(state.detail, /握手成功/);
  await service.stop();
});

test('late logs from an exited child cannot change a newly started Portal health', async (t) => {
  const paths = await fixture(t);
  const children = [fakeChild(), fakeChild()];
  let next = 0;
  const { service } = serviceHarness({ spawnImpl: () => {
    const child = children[next++];
    queueMicrotask(() => child.emit('spawn'));
    return child;
  } });
  service.configure(paths);
  await service.start({ connectUrl: LOOM });
  await service.stop();
  await service.start({ connectUrl: LOOM });
  children[0].stderr.write('INFO Portal relay handshake OK — starting MCP server on WebSocket bridge\n');
  assert.equal(service.state.health, 'unknown');
  children[1].stderr.write('INFO Portal relay handshake OK — starting MCP server on WebSocket bridge\n');
  assert.equal(service.state.health, 'connected');
  await service.stop();
});

for (const outcome of ['empty result', 'inspection error']) {
  test(`an older inspection ${outcome} cannot overwrite a newly started owned Portal`, async (t) => {
    const paths = await fixture(t);
    let finishOldInspection;
    const pendingInspection = new Promise((resolve, reject) => {
      finishOldInspection = () => outcome === 'empty result' ? resolve([]) : reject(new Error('old inspection failed'));
    });
    let inspectionCount = 0;
    const { service, child } = serviceHarness({ inspectProcesses: () => ++inspectionCount === 1 ? pendingInspection : Promise.resolve([]) });
    service.configure(paths);
    const oldInspection = service.inspect();
    await service.start({ connectUrl: LOOM });
    child.stderr.write('INFO Portal relay handshake OK — starting MCP server on WebSocket bridge\n');
    const ownedState = service.state;
    assert.equal(ownedState.status, 'running');
    assert.equal(ownedState.owned, true);
    assert.equal(ownedState.pid, child.pid);
    assert.equal(ownedState.health, 'connected');
    finishOldInspection();
    assert.deepEqual(await oldInspection, ownedState);
    assert.deepEqual(service.state, ownedState);
    await service.stop();
  });
}

test('an inspection started before launch cannot overwrite a subsequent process exit', async (t) => {
  const paths = await fixture(t);
  let finishOldInspection;
  const pendingInspection = new Promise((resolve) => { finishOldInspection = resolve; });
  let inspectionCount = 0;
  const { service, child } = serviceHarness({ inspectProcesses: () => ++inspectionCount === 1 ? pendingInspection : Promise.resolve([]) });
  service.configure(paths);
  const oldInspection = service.inspect();
  await service.start({ connectUrl: LOOM });
  child.emit('exit', 2, null);
  const exitedState = service.state;
  assert.equal(exitedState.status, 'error');
  finishOldInspection([]);
  assert.deepEqual(await oldInspection, exitedState);
  assert.deepEqual(service.state, exitedState);
});

test('managed Cowork token is passed only in the selected child environment, never argv or public state', async t => {
  const paths = await fixture(t);
  const { service, calls } = serviceHarness();
  const coworkToken = 'a1'.repeat(32);
  const hostHadPortalToken = Object.hasOwn(process.env, 'PORTAL_TOKEN');
  service.configure(paths);
  await service.start({ connectUrl: LOOM, coworkToken });
  assert.equal(calls[0][0], paths.executable);
  assert.notEqual(calls[0][2].env, process.env);
  assert.equal(calls[0][2].env.PORTAL_TOKEN, coworkToken);
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(calls[0][1].some(argument => argument.includes(coworkToken)), false);
  assert.equal(Object.hasOwn(process.env, 'PORTAL_TOKEN'), hostHadPortalToken);
  assert.equal((await fs.readFile(paths.configPath, 'utf8')).includes(coworkToken), false);
  assert.equal(JSON.stringify({ state: service.state, logs: service.logs }).includes(coworkToken), false);
  await service.stop();
});

test('invalid managed Cowork token values are rejected before spawning', async t => {
  const paths = await fixture(t);
  const { service, calls } = serviceHarness();
  service.configure(paths);
  for (const coworkToken of ['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'A'.repeat(64), null, 42, {}]) {
    await assert.rejects(service.start({ connectUrl: LOOM, coworkToken }), /本机接口凭据无效/);
  }
  assert.equal(calls.length, 0);
});

test('Cowork token cannot escape through known lifecycle summaries, unknown logs, or child errors', async t => {
  const paths = await fixture(t);
  const { service, child, events } = serviceHarness();
  const coworkToken = 'b2'.repeat(32);
  service.configure(paths);
  await service.start({ connectUrl: LOOM, coworkToken });
  child.stdout.write(`PORTAL_TOKEN=${coworkToken}\n`);
  child.stderr.write(`INFO Portal connect mode: relay https://fixture.invalid/?token=${coworkToken}\n`);
  child.stderr.write(`WARN relay session ended: Authorization: Bearer ${coworkToken}\n`);
  child.emit('error', new Error(`token=${coworkToken}`));
  assert.equal(JSON.stringify({ state: service.state, logs: service.logs, events }).includes(coworkToken), false);
  assert.equal(service.state.owned, true);
  await service.stop();
});

test('existing external Portal does not receive or trigger a child environment for the new Cowork token', async t => {
  const paths = await fixture(t);
  const { service, calls } = serviceHarness({ inspectProcesses: async () => [{ pid: 9001, name: 'heart-portal.exe' }] });
  service.configure(paths);
  assert.equal((await service.start({ connectUrl: LOOM, coworkToken: 'c3'.repeat(32) })).status, 'external');
  assert.equal(calls.length, 0);
  await service.stop();
});
