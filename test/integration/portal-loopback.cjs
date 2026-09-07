'use strict';

// This opt-in integration test runs a verified official binary against a local fixture.
// It never connects to a real Being and never sends a tools/call request.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { PortalService } = require('../../src/services.cjs');

const execFileAsync = promisify(execFile);
const TEST_ROOT = path.resolve(__dirname, '../../.local/portal-test');
const EXPECTED_HASH = '9f0fb1200d756b5c450cc3ff57752648ab4df70622b82df92033f4167426d355';

function frame(opcode, value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  assert.ok(body.length < 65536);
  const header = Buffer.alloc(body.length < 126 ? 2 : 4);
  header[0] = 0x80 | opcode;
  header[1] = body.length < 126 ? body.length : 126;
  if (body.length >= 126) header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

class LoopbackRelay extends EventEmitter {
  constructor(token, { beingId = 'desktop-integration', portalName = 'desktop-integration' } = {}) {
    super();
    this.token = token;
    this.beingId = beingId;
    this.portalName = portalName;
    this.sockets = new Set();
    this.accepted = 0;
    this.rejected = 0;
    this.metadataReplies = 0;
    this.methodsSent = [];
    this.toolNames = [];
    this.server = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
    this.server.on('upgrade', (request, socket, head) => this.upgrade(request, socket, head));
  }

  async listen(port = 0) {
    this.server.listen(port, '127.0.0.1');
    await once(this.server, 'listening');
    this.port = this.server.address().port;
  }

  async pause() {
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) await new Promise((resolve) => this.server.close(resolve));
  }

  upgrade(request, socket, head) {
    if (request.url !== '/_relay' || socket.remoteAddress !== '127.0.0.1' || !request.headers['sec-websocket-key']) return socket.destroy();
    const accept = crypto.createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let authenticated = false;
    const sendJson = (value) => socket.write(frame(1, JSON.stringify(value)));
    const sendRequest = (id, method, params = {}) => {
      assert.ok(['initialize', 'tools/list'].includes(method));
      this.methodsSent.push(method);
      sendJson({ jsonrpc: '2.0', id, method, params });
    };
    const consume = (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > 1024 * 1024) return socket.destroy();
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15;
        if (!(buffer[0] & 128) || !(buffer[1] & 128)) return socket.destroy();
        let size = buffer[1] & 127;
        let offset = 2;
        if (size === 126) {
          if (buffer.length < 4) return;
          size = buffer.readUInt16BE(2);
          offset = 4;
        } else if (size === 127) return socket.destroy();
        if (buffer.length < offset + 4 + size) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + size));
        for (let index = 0; index < size; index++) payload[index] ^= mask[index % 4];
        buffer = buffer.subarray(offset + 4 + size);
        if (opcode === 8) return socket.end(frame(8, Buffer.alloc(0)));
        if (opcode === 9) { socket.write(frame(10, payload)); continue; }
        if (opcode !== 1) continue;
        let message;
        try { message = JSON.parse(payload.toString('utf8')); } catch { return socket.destroy(); }
        if (!authenticated) {
          if (message.being_id !== this.beingId || message.loom_token !== this.token || message.portal_name !== this.portalName) {
            this.rejected++;
            sendJson({ ok: false });
            this.emit('change');
            continue;
          }
          authenticated = true;
          this.accepted++;
          sendJson({ ok: true, relay_keepalive: 'text-v1' });
          sendRequest(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'desktop-loopback-fixture', version: '1.0.0' } });
          this.emit('change');
        } else if (message.type === 'keepalive') {
          sendJson({ type: 'keepalive_ack' });
        } else if (message.id === 1 && message.result) {
          this.runtimeVersion = message.result.serverInfo?.version;
          sendRequest(2, 'tools/list');
        } else if (message.id === 2 && Array.isArray(message.result?.tools)) {
          this.toolNames = message.result.tools.map((tool) => tool.name);
          this.metadataReplies++;
          this.emit('change');
        }
        if (authenticated && Object.hasOwn(message, 'id') && Object.hasOwn(message, 'result')) this.emit('rpc_response', message);
      }
    };
    socket.on('data', consume);
    if (head.length) consume(head);
  }
}

function until(emitter, predicate, label, timeout = 25000) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); emitter.removeListener('change', check); };
    const check = () => { if (predicate()) { finish(); resolve(); } };
    const timer = setTimeout(() => { finish(); reject(new Error(`Timed out: ${label}`)); }, timeout);
    emitter.on('change', check);
  });
}

async function connectionsFor(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const command = `@(Get-NetTCPConnection -OwningProcess ${pid} -ErrorAction SilentlyContinue | Select-Object @{Name='State';Expression={$_.State.ToString()}},LocalAddress,LocalPort,RemoteAddress,RemotePort) | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, shell: false });
  const data = stdout.trim() ? JSON.parse(stdout) : [];
  return Array.isArray(data) ? data : [data];
}

async function run() {
  assert.equal(process.platform, 'win32', 'This integration test requires Windows.');
  const executable = path.join(TEST_ROOT, 'heart-portal-windows-x86_64.exe');
  const actualHash = crypto.createHash('sha256').update(await fs.readFile(executable)).digest('hex');
  assert.equal(actualHash, EXPECTED_HASH, 'Official release digest mismatch.');
  const { stdout } = await execFileAsync(executable, ['--version'], { windowsHide: true, shell: false });
  assert.equal(stdout.trim(), 'heart-portal 0.8.0');
  const token = crypto.randomBytes(24).toString('hex');
  const workspace = path.join(TEST_ROOT, 'workspace');
  const kits = path.join(TEST_ROOT, 'kits');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(kits, { recursive: true });
  const configPath = path.join(TEST_ROOT, 'portal-integration.toml');
  await fs.writeFile(configPath, [
    'name = "desktop-integration"',
    'bind = "127.0.0.1:0"',
    `workspace = ${JSON.stringify(workspace.replaceAll('\\', '/'))}`,
    `kits_dir = ${JSON.stringify(kits.replaceAll('\\', '/'))}`,
    'kits_enabled = false',
    `portal_mcp_token = "${token}"`,
    '[tools]',
    'exec = false', 'file = false', 'screenshot = false', 'web_fetch = false', 'search = false', 'custom_tools_enabled = false',
    '[security]', 'exec_allowlist = []', 'max_file_size = 1024',
    '[cowork]', 'enabled = true', 'http_port = 0', '',
  ].join('\n'));
  const relay = new LoopbackRelay(token);
  const changed = new EventEmitter();
  const events = [];
  const service = new PortalService({
    onEvent: (event) => { events.push(event); changed.emit('change'); },
    spawnImpl: (file, args, options) => spawn(file, args, { ...options, env: { ...process.env, PORTAL_TOKEN: token, LOOM_TOKEN: token, PORTAL_MCP_TOKEN: token, RUST_LOG: 'info' } }),
  });
  service.configure({ executable, configPath });
  const checks = [];
  const report = {
    recordedAt: new Date().toISOString(),
    release: 'https://github.com/d5z/heart-portal/releases/tag/v0.8.0',
    executableVersion: stdout.trim(), sha256: actualHash,
    environment: { platform: process.platform, arch: process.arch, productionBeingContacted: false, remotePortalModified: false },
    checks,
  };
  const checkpoint = (name, detail) => { checks.push({ name, passed: true, detail }); console.log(`PASS ${name}`); };
  try {
    await relay.listen();
    const connectUrl = `http://127.0.0.1:${relay.port}/desktop-integration/?token=${token}`;
    const initial = await service.inspect();
    assert.equal(initial.status, 'stopped', 'An existing Portal was found or inspection failed; this test will not interfere.');
    await service.start({ connectUrl, portalName: 'desktop-integration' });
    await until(changed, () => service.state.health === 'connected', 'first relay handshake');
    await until(relay, () => relay.metadataReplies === 1, 'first MCP metadata');
    const firstPid = service.state.pid;
    assert.ok(firstPid > 0 && service.state.owned && service.state.status === 'running');
    assert.equal(relay.runtimeVersion, '0.8.0');
    assert.deepEqual([...relay.toolNames].sort(), ['portal_oauth_authorize', 'portal_tools_reload']);
    checkpoint('real-binary-start-and-handshake', { pid: firstPid, serverVersion: relay.runtimeVersion, advertisedTools: relay.toolNames });

    const tcp = await connectionsFor(firstPid);
    report.tcpObservation = tcp;
    assert.ok(tcp.length > 0);
    const listening = tcp.filter((connection) => connection.State === 'Listen');
    const established = tcp.filter((connection) => connection.State === 'Established');
    assert.ok(listening.length > 0 && established.length > 0);
    assert.ok(listening.every((connection) => connection.LocalAddress === '127.0.0.1'));
    assert.ok(established.every((connection) => connection.LocalAddress === '127.0.0.1' && connection.RemoteAddress === '127.0.0.1'));
    checkpoint('loopback-network-only', { listeners: listening.length, established: established.length, listenerAddresses: [...new Set(listening.map((item) => item.LocalAddress))] });

    const observer = new PortalService();
    observer.configure({ executable, configPath });
    const observed = await observer.start({ connectUrl, portalName: 'desktop-integration' });
    assert.equal(observed.status, 'external');
    assert.equal(observed.pid, firstPid);
    await observer.stop();
    assert.doesNotThrow(() => process.kill(firstPid, 0));
    checkpoint('native-duplicate-detection-and-external-stop-noop', { pid: firstPid });

    await relay.pause();
    await until(changed, () => service.state.health === 'disconnected', 'network-loss state');
    assert.equal(service.state.pid, firstPid);
    assert.equal(service.state.status, 'running');
    checkpoint('network-loss-visible-with-process-still-running', { health: service.state.health });
    await relay.listen(relay.port);
    await until(changed, () => service.state.health === 'connected', 'automatic relay reconnection');
    await until(relay, () => relay.metadataReplies === 2, 'reconnected MCP metadata');
    assert.equal(service.state.pid, firstPid);
    checkpoint('relay-reconnect-without-process-restart', { pidUnchanged: true });

    await service.stop();
    assert.equal(service.state.status, 'stopped');
    assert.equal(service.state.owned, false);
    assert.throws(() => process.kill(firstPid, 0));
    checkpoint('owned-process-stop', { processExited: true, gracefulCleanupVerified: false });
    await service.start({ connectUrl, portalName: 'desktop-integration' });
    await until(changed, () => service.state.health === 'connected', 'restart handshake');
    await until(relay, () => relay.metadataReplies === 3, 'restart MCP metadata');
    const secondPid = service.state.pid;
    assert.notEqual(secondPid, firstPid);
    checkpoint('explicit-process-restart', { firstPid, secondPid });
    await service.stop();

    const invalidUrl = `http://127.0.0.1:${relay.port}/desktop-integration/?token=invalid-fixture-token`;
    await service.start({ connectUrl: invalidUrl, portalName: 'desktop-integration' });
    await until(relay, () => relay.rejected > 0, 'rejected fixture authentication');
    await until(changed, () => service.state.health === 'disconnected', 'rejected handshake state');
    assert.equal(relay.metadataReplies, 3);
    checkpoint('rejected-handshake-never-marked-connected', { metadataCallsAfterRejection: 0, health: service.state.health });
    await service.stop();

    assert.ok(relay.methodsSent.every((method) => ['initialize', 'tools/list'].includes(method)));
    assert.equal((await fs.readdir(workspace)).length, 0);
    assert.ok(!JSON.stringify(events).includes(token));
    assert.ok(!JSON.stringify(events).includes('invalid-fixture-token'));
    assert.ok(events.every((event) => !/https?:\/\/|--connect|tools\/call/.test(event.detail)));
    checkpoint('no-tools-called-no-workspace-writes-no-secrets-in-activity', { methods: [...new Set(relay.methodsSent)], workspaceEntries: 0 });
    report.result = 'passed';
  } finally {
    await service.dispose();
    await relay.pause();
    report.serviceActivity = events;
    report.finalState = service.state;
    report.limitations = [
      'Loopback relay is a controlled fixture, not a production Heart runtime or a real Being.',
      'Only MCP initialize and tools/list are sent; no tools/call, chat messages, file operations or external commands are invoked.',
      'Windows Node termination is forced; graceful Portal descendant cleanup is not claimed.',
      'Upstream v0.8.0 still advertises OAuth and tools_reload with tools disabled; several dispatch paths do not enforce the corresponding advertisement flag.',
      'Cowork is authenticated on loopback; disabled Cowork fallback health would bind 0.0.0.0 in upstream v0.8.0 and is not used.',
      'WebSocket disconnect/reconnect is exercised; a silent 90-second heartbeat blackhole is not exercised.',
    ];
    await fs.writeFile(path.join(TEST_ROOT, 'integration-result.json'), JSON.stringify(report, null, 2));
  }
}

module.exports = { LoopbackRelay, frame, until, connectionsFor };

if (require.main === module) {
  run().catch((error) => { console.error(`Integration failed: ${error.message}`); process.exitCode = 1; });
}
