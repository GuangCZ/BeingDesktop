'use strict';

// Opt-in real-binary test. The only MCP requests are initialize and tools/list.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { PortalService } = require('../src/services.cjs');
const { createPortalConfig } = require('../src/portal-config.cjs');
const { PORTAL_RELEASE } = require('../src/portal-installer.cjs');
const { LoopbackRelay, until, connectionsFor } = require('./integration/portal-loopback.cjs');

async function run() {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.BEING_PORTAL_DEPLOYMENT_TEST, '1', 'Use the isolated-environment launcher.');
  for (const key of ['PORTAL_TOKEN', 'LOOM_TOKEN', 'PORTAL_MCP_TOKEN', 'BEING_LOOM_URL']) assert.equal(Object.hasOwn(process.env, key), false);
  const directory = path.resolve(process.env.BEING_PORTAL_DEPLOYMENT_REPORT_DIR || '');
  assert.equal(path.dirname(directory), path.resolve(__dirname, '../.local'));
  assert.match(path.basename(directory), /^portal-deployment-integration-[a-f0-9]{32}$/);
  await fs.mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, 'report.json');
  const report = {
    startedAt: new Date().toISOString(), result: 'running', stage: 'binary-verification', checks: [],
    scope: { productionBeing: false, remoteWrites: false, normalProfileRead: false, toolsCalled: false, network: 'loopback-only' },
  };
  const checkpoint = (name, detail = {}) => {
    report.checks.push({ name, passed: true, ...detail });
    console.log(`PASS ${name}`);
  };
  let service, relay, childPid;
  const events = [];
  const secrets = [];
  try {
    const executable = path.resolve(__dirname, '../.local/portal-test/heart-portal-windows-x86_64.exe');
    const digest = crypto.createHash('sha256').update(await fs.readFile(executable)).digest('hex');
    assert.equal(digest, PORTAL_RELEASE.sha256);
    const { stdout } = await promisify(execFile)(executable, ['--version'], { shell: false, windowsHide: true });
    assert.equal(stdout.trim(), 'heart-portal 0.8.0');
    report.binary = { version: '0.8.0', sha256: digest, bytes: (await fs.stat(executable)).size };
    checkpoint('official-binary-digest-and-version');

    report.stage = 'generate-config';
    const workspace = path.join(directory, 'workspace');
    await fs.mkdir(workspace);
    const configuration = await createPortalConfig({ workspace, name: 'desktop-deployment-fixture', kitsDir: path.join(directory, 'disabled-kits') });
    const configPath = path.join(directory, 'generated-portal.toml');
    await fs.writeFile(configPath, configuration.toml, { flag: 'wx' });
    assert.equal(configuration.capabilities.strictSandbox, false);
    assert.deepEqual(await fs.readdir(workspace), []);
    checkpoint('generated-config-written-with-no-authorized-url-or-token');

    const relayToken = crypto.randomBytes(32).toString('hex');
    const coworkToken = crypto.randomBytes(32).toString('hex');
    secrets.push(relayToken, coworkToken);
    relay = new LoopbackRelay(relayToken, { beingId: 'desktop-deployment-fixture', portalName: 'desktop-deployment-fixture' });
    const changed = new EventEmitter();
    let spawnCount = 0;
    service = new PortalService({
      onEvent(event) { events.push(event); changed.emit('change'); },
      spawnImpl(file, args, options) {
        assert.equal(file, executable);
        assert.equal(options.env.PORTAL_TOKEN, coworkToken);
        assert.equal(Object.hasOwn(process.env, 'PORTAL_TOKEN'), false);
        assert.notEqual(options.env, process.env);
        assert.equal(args.some(argument => argument.includes(coworkToken)), false);
        assert.equal(options.shell, false);
        assert.equal(options.windowsHide, true);
        spawnCount++;
        return spawn(file, args, options);
      },
    });
    service.configure({ executable, configPath });
    report.stage = 'native-existing-process-check';
    const existing = await service.inspect();
    if (existing.status !== 'stopped') {
      report.result = 'blocked';
      report.blocker = existing.status === 'external' ? 'existing-external-portal-preserved' : 'native-inspection-unavailable';
      return report;
    }
    await relay.listen();
    report.stage = 'start-and-mcp-metadata';
    await service.start({ connectUrl: `http://127.0.0.1:${relay.port}/desktop-deployment-fixture/?token=${relayToken}`, portalName: 'desktop-deployment-fixture', coworkToken });
    childPid = service.state.pid;
    await until(changed, () => service.state.health === 'connected', 'deployment fixture handshake');
    await until(relay, () => relay.metadataReplies === 1, 'deployment fixture metadata');
    assert.equal(relay.runtimeVersion, '0.8.0');
    assert.deepEqual([...relay.toolNames].sort(), [...configuration.capabilities.advertisedTools].sort());
    assert.equal(service.state.status, 'running');
    assert.equal(service.state.owned, true);
    assert.equal(spawnCount, 1);
    checkpoint('actual-generated-toml-load-and-relay-handshake', { pid: childPid, advertisedToolCount: relay.toolNames.length });
    checkpoint('cowork-token-in-target-child-env-only', { ownChildCount: spawnCount, parentTokenPresent: false, tokenInArgv: false });

    report.stage = 'network-and-scope-observation';
    const connections = await connectionsFor(childPid);
    const listeners = connections.filter(connection => connection.State === 'Listen');
    const established = connections.filter(connection => connection.State === 'Established');
    assert.ok(listeners.length > 0);
    assert.ok(established.length > 0);
    assert.ok(listeners.every(connection => connection.LocalAddress === '127.0.0.1'));
    assert.ok(established.every(connection => connection.LocalAddress === '127.0.0.1' && connection.RemoteAddress === '127.0.0.1'));
    checkpoint('only-loopback-listeners-and-established-connections', { listeners: listeners.length, established: established.length });
    assert.deepEqual([...new Set(relay.methodsSent)].sort(), ['initialize', 'tools/list']);
    assert.deepEqual(await fs.readdir(workspace), []);
    assert.equal(configuration.toml.includes(relayToken) || configuration.toml.includes(coworkToken), false);
    const publicData = JSON.stringify({ events, state: service.state, logs: service.logs });
    assert.ok(secrets.every(secret => !publicData.includes(secret)));
    checkpoint('no-tool-calls-no-workspace-writes-no-public-secrets', { methods: ['initialize', 'tools/list'], workspaceEntries: 0 });

    report.stage = 'owned-process-stop';
    await service.stop();
    assert.equal(service.state.owned, false);
    assert.equal(service.state.status, 'stopped');
    let alive = true;
    try { process.kill(childPid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    assert.equal(alive, false);
    checkpoint('only-owned-child-stopped-and-confirmed-exited', { pid: childPid });
    report.result = 'passed';
    report.stage = 'complete';
    return report;
  } catch {
    report.result = 'failed';
    report.failure = 'An assertion failed at the recorded stage; no raw errors or credentials were exported.';
    return report;
  } finally {
    if (service) {
      try { await service.dispose(); }
      catch { report.result = 'failed'; report.cleanup = 'Owned Portal stop was not confirmed.'; }
    }
    if (relay) await relay.pause();
    report.finishedAt = new Date().toISOString();
    report.finalState = service?.state || null;
    report.activity = events;
    report.limitations = [
      'Controlled loopback relay only; no production Heart or Being was contacted.',
      'Only initialize/tools/list metadata was requested; file, exec, screenshot, web and OAuth tools were not called.',
      'Cowork token injection was observed at the actual child spawn boundary; authenticated Cowork business routes were not invoked.',
      'Windows termination is forced; descendant cleanup with active tools is not proven.',
    ];
    const serialized = JSON.stringify(report, null, 2);
    assert.ok(secrets.every(secret => !serialized.includes(secret)));
    await fs.writeFile(reportPath, serialized);
    console.log(JSON.stringify({ result: report.result, reportPath, ownPortalPid: childPid || null }));
  }
}

if (require.main === module) run().then(report => { process.exitCode = report.result === 'passed' ? 0 : 1; }).catch(() => { console.error('Deployment integration failed before a safe report was available.'); process.exitCode = 1; });
module.exports = { run };
