'use strict';

// Opt-in Windows integration: only loopback traffic and MCP metadata requests.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');
const { PortalService } = require('../../src/services.cjs');
const { LoopbackRelay, frame, until } = require('./portal-loopback.cjs');

const execFileAsync = promisify(execFile);
const TEST_ROOT = path.resolve(__dirname, '../../.local/portal-test');
const EXPECTED_HASH = '9f0fb1200d756b5c450cc3ff57752648ab4df70622b82df92033f4167426d355';
const BLACKHOLE_MS = 110000;

class SilentProxy {
  constructor(relayPort) {
    this.relayPort = relayPort;
    this.pairs = new Set();
    this.blackhole = false;
    this.blackholeStarted = null;
    this.droppedClientToRelayBytes = 0;
    this.droppedRelayToClientBytes = 0;
    this.clientEndsDuringBlackhole = [];
    this.lastRelayDataForwarded = null;
    this.server = net.createServer((client) => {
      const upstream = net.connect({ host: '127.0.0.1', port: relayPort });
      const pair = { client, upstream };
      this.pairs.add(pair);
      client.setNoDelay(true);
      upstream.setNoDelay(true);
      client.on('data', (data) => {
        if (this.blackhole) this.droppedClientToRelayBytes += data.length;
        else upstream.write(data);
      });
      upstream.on('data', (data) => {
        if (this.blackhole) this.droppedRelayToClientBytes += data.length;
        else { this.lastRelayDataForwarded = performance.now(); client.write(data); }
      });
      client.on('end', () => {
        if (this.blackhole) this.clientEndsDuringBlackhole.push(performance.now() - this.blackholeStarted);
        upstream.end();
      });
      upstream.on('end', () => client.end());
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.on('close', () => { upstream.destroy(); this.pairs.delete(pair); });
      upstream.on('close', () => { client.destroy(); this.pairs.delete(pair); });
    });
  }

  async listen() {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.port = this.server.address().port;
  }

  beginBlackhole() {
    assert.equal(this.blackhole, false);
    this.blackholeStarted = performance.now();
    this.lastGoodRelayFrame = this.lastRelayDataForwarded;
    // Deliberately do not close, pause, reconnect, or destroy any existing socket.
    this.blackhole = true;
  }

  endBlackhole() {
    this.blackholeDurationMs = performance.now() - this.blackholeStarted;
    this.blackhole = false;
  }

  async close() {
    for (const { client, upstream } of this.pairs) { client.destroy(); upstream.destroy(); }
    if (this.server.listening) await new Promise((resolve) => this.server.close(resolve));
  }
}

function inspectHeartbeatOutput(stream, observations, fault) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.includes('no relay heartbeat response within 90s (D-077)')) {
        observations.push({ category: 'upstream-90-second-heartbeat-timeout', elapsedSinceBlackholeMs: performance.now() - fault.blackholeStarted });
      }
    }
    if (pending.length > 65536) pending = '';
  });
}

async function run() {
  assert.equal(process.platform, 'win32');
  const executable = path.join(TEST_ROOT, 'heart-portal-windows-x86_64.exe');
  const hash = crypto.createHash('sha256').update(await fs.readFile(executable)).digest('hex');
  assert.equal(hash, EXPECTED_HASH);
  const { stdout } = await execFileAsync(executable, ['--version'], { windowsHide: true, shell: false });
  assert.equal(stdout.trim(), 'heart-portal 0.8.0');
  const token = crypto.randomBytes(24).toString('hex');
  const workspace = path.join(TEST_ROOT, 'blackhole-workspace');
  const kits = path.join(TEST_ROOT, 'blackhole-kits');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(kits, { recursive: true });
  const configPath = path.join(TEST_ROOT, 'portal-blackhole.toml');
  await fs.writeFile(configPath, [
    'name = "desktop-integration"', 'bind = "127.0.0.1:0"',
    `workspace = ${JSON.stringify(workspace.replaceAll('\\', '/'))}`,
    `kits_dir = ${JSON.stringify(kits.replaceAll('\\', '/'))}`,
    'kits_enabled = false', `portal_mcp_token = "${token}"`,
    '[tools]', 'exec = false', 'file = false', 'screenshot = false', 'web_fetch = false', 'search = false', 'custom_tools_enabled = false',
    '[security]', 'exec_allowlist = []', 'max_file_size = 1024',
    '[cowork]', 'enabled = true', 'http_port = 0', '',
  ].join('\n'));
  const relay = new LoopbackRelay(token);
  let fault;
  let service;
  let heartbeatTimer;
  let progressTimer;
  const events = [];
  const heartbeatObservations = [];
  const changed = new EventEmitter();
  const report = {
    startedAt: new Date().toISOString(), result: 'incomplete',
    binary: { version: stdout.trim(), sha256: hash },
    environment: { platform: 'win32', productionBeingContacted: false, systemNetworkModified: false, systemSlept: false },
    checks: [],
  };
  const checkpoint = (name, detail) => { report.checks.push({ name, passed: true, detail }); console.log(`PASS ${name}`); };
  let firstDisconnectedAt = null;
  try {
    await relay.listen();
    fault = new SilentProxy(relay.port);
    await fault.listen();
    service = new PortalService({
      onEvent: (event) => {
        events.push(event);
        if (fault.blackholeStarted && service.state.health === 'disconnected' && firstDisconnectedAt === null) firstDisconnectedAt = performance.now();
        changed.emit('change');
      },
      spawnImpl: (file, args, options) => {
        const child = spawn(file, args, { ...options, env: { ...process.env, PORTAL_TOKEN: token, LOOM_TOKEN: token, PORTAL_MCP_TOKEN: token, RUST_LOG: 'info' } });
        inspectHeartbeatOutput(child.stdout, heartbeatObservations, fault);
        inspectHeartbeatOutput(child.stderr, heartbeatObservations, fault);
        return child;
      },
    });
    service.configure({ executable, configPath });
    assert.equal((await service.inspect()).status, 'stopped', 'Existing Portal or failed process inspection; this test will not interfere.');
    const connectUrl = `http://127.0.0.1:${fault.port}/desktop-integration/?token=${token}`;
    await service.start({ connectUrl, portalName: 'desktop-integration' });
    await until(changed, () => service.state.health === 'connected', 'pre-fault handshake');
    await until(relay, () => relay.metadataReplies === 1, 'pre-fault metadata');
    const initialPid = service.state.pid;
    checkpoint('real-portal-connected-through-loopback-fault-proxy', { pid: initialPid, metadataReplies: relay.metadataReplies });

    // Benign protocol acknowledgements make both dropping directions observable.
    heartbeatTimer = setInterval(() => {
      for (const socket of relay.sockets) if (!socket.destroyed) socket.write(frame(1, '{"type":"keepalive_ack"}'));
    }, 5000);
    fault.beginBlackhole();
    console.log(`BLACKHOLE started: dropping both directions for ${BLACKHOLE_MS / 1000}s without closing sockets`);
    progressTimer = setInterval(() => console.log(`BLACKHOLE elapsed=${Math.round((performance.now() - fault.blackholeStarted) / 1000)}s health=${service.state.health}`), 30000);
    await new Promise((resolve) => setTimeout(resolve, BLACKHOLE_MS));
    clearInterval(progressTimer);
    progressTimer = null;
    fault.endBlackhole();
    assert.ok(fault.blackholeDurationMs >= BLACKHOLE_MS);
    assert.ok(fault.droppedClientToRelayBytes > 0 && fault.droppedRelayToClientBytes > 0);
    checkpoint('silent-blackhole-held-bidirectionally-for-at-least-90-seconds', {
      durationMs: fault.blackholeDurationMs,
      droppedClientToRelayBytes: fault.droppedClientToRelayBytes,
      droppedRelayToClientBytes: fault.droppedRelayToClientBytes,
      existingSocketsClosedByFaultActivation: 0,
    });
    assert.ok(heartbeatObservations.length > 0, 'Portal must log its own 90-second heartbeat timeout.');
    assert.ok(firstDisconnectedAt !== null);
    assert.ok(firstDisconnectedAt - fault.lastGoodRelayFrame >= 89500);
    assert.equal(service.state.pid, initialPid);
    assert.equal(service.state.status, 'running');
    checkpoint('upstream-heartbeat-timeout-produces-disconnected-state', {
      firstDisconnectedAfterFaultMs: firstDisconnectedAt - fault.blackholeStarted,
      firstDisconnectedAfterLastForwardedRelayDataMs: firstDisconnectedAt - fault.lastGoodRelayFrame,
      heartbeatTimeoutObservations: heartbeatObservations,
      clientEndsDuringBlackholeMs: fault.clientEndsDuringBlackhole,
      processPidUnchanged: true,
    });
    console.log('BLACKHOLE ended: waiting for native Portal reconnect');
    await until(changed, () => service.state.health === 'connected', 'post-blackhole reconnect', 50000);
    await until(relay, () => relay.metadataReplies === 2, 'post-blackhole metadata', 25000);
    assert.equal(service.state.pid, initialPid);
    checkpoint('recovered-handshake-and-mcp-on-same-process', {
      recoveryAfterFaultEndMs: performance.now() - fault.blackholeStarted - fault.blackholeDurationMs,
      acceptedHandshakes: relay.accepted,
      metadataReplies: relay.metadataReplies,
      pid: service.state.pid,
    });
    assert.deepEqual([...new Set(relay.methodsSent)].sort(), ['initialize', 'tools/list']);
    assert.equal((await fs.readdir(workspace)).length, 0);
    assert.ok(!JSON.stringify(events).includes(token));
    checkpoint('no-tools-invoked-no-workspace-writes-no-credential-output', { methods: [...new Set(relay.methodsSent)], workspaceEntries: 0 });
    await service.stop();
    assert.throws(() => process.kill(initialPid, 0));
    checkpoint('owned-process-cleaned-up', { processExited: true, gracefulDescendantCleanupVerified: false });
    report.result = 'passed';
  } finally {
    clearInterval(heartbeatTimer);
    clearInterval(progressTimer);
    await service?.dispose();
    await fault?.close();
    await relay.pause();
    report.finishedAt = new Date().toISOString();
    report.serviceActivity = events;
    report.finalState = service?.state;
    report.limitations = [
      'Application/TCP-stream proxy drops bytes bidirectionally while kernel TCP acknowledgements continue; this is not a packet-level firewall blackhole.',
      'No production Heart, real Being, business tool invocation or system sleep is exercised.',
      'Portal detects missing WebSocket traffic via its own heartbeat timeout; the shell does not invent a timer-based health signal.',
      'Only initialize and tools/list are sent; keepalive_ack frames carry no business operation.',
      'Windows stop is forced and does not establish graceful descendant cleanup.',
    ];
    await fs.writeFile(path.join(TEST_ROOT, 'blackhole-result.json'), JSON.stringify(report, null, 2));
  }
}

run().catch((error) => { console.error(`Blackhole integration failed: ${error.message}`); process.exitCode = 1; });
