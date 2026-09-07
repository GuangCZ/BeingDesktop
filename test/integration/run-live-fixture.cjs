'use strict';

const {app, safeStorage} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {randomBytes, timingSafeEqual} = require('node:crypto');
const {parseConnection} = require('../../src/security.cjs');
const {FixtureAdapter, handleMcpText, TOOL_NAME, FIXTURE_MARKER} = require('./fixture-adapter.cjs');

// Only the explicit, fixed-field report below is a diagnostic output channel.
for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = () => {};

const ACTIVE_PIPE = '\\\\.\\pipe\\being-desktop-live-fixture-active';
const appRoot = path.resolve(__dirname, '../..');
const localRoot = path.join(appRoot, '.local');
const runId = process.env.BEING_LIVE_RUN_ID || '';
const PORTAL_NAME = `desktop-diagnostics-${runId.replace(/-/g, '').slice(0, 12)}`;
const checkOnly = process.env.BEING_LIVE_CHECK === '1';
const durationSeconds = Number(process.env.BEING_LIVE_DURATION_SECONDS);
let profilePath = '';
let adapter = null;
let controlServer = null;
let activeServer = null;
let lifetimeTimer = null;
let finishing = null;
let stoppedAdapter = null;
let handshakeAccepted = false;
let implementationMatchesExpected = false;
let status = 'idle';
let lastFixture = null;
const checkFlags = {independentProfileGuard: false, systemEncryptionAvailable: false, copiedCredentialMatchesSaved: false,
  copiedCredentialUnlocked: false, savedConnectionValid: false, websocketConstructorAvailable: false,
  fixedFixtureResultMatches: false, connectionAttempted: false};
const sockets = new Set();
const counterNames = ['received','accepted','denied','fixtureExecutions','responsesSent','fixtureResponsesSent'];
const counters = Object.fromEntries(counterNames.map(name => [name, 0]));

function regularDirectory(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid fixture directory');
}

function readJsonFile(target, maximumSize) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumSize) throw new Error('Invalid fixture input');
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function reportSnapshot() {
  if (checkOnly) {
    return {runId, checkOnly: true,
      passed: Object.entries(checkFlags).filter(([name]) => name !== 'connectionAttempted').every(([, value]) => value === true) && !checkFlags.connectionAttempted,
      ...checkFlags};
  }
  return {
    runId,
    portalName: PORTAL_NAME,
    handshakeStatus: status,
    handshakeAccepted,
    requestCounts: {...counters},
    lastFixture,
    fixedResultMatch: {
      expectedMarker: FIXTURE_MARKER,
      implementationMatchesExpected,
      executions: counters.fixtureExecutions,
      responsesSent: counters.fixtureResponsesSent,
      remoteReceiptVerified: false,
    },
  };
}

function writeReport() {
  if (!profilePath) return false;
  try {
    const target = path.join(profilePath, checkOnly ? 'check-report.json' : 'live-report.json');
    const temporary = target + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(reportSnapshot(), null, 2), {mode: 0o600});
    fs.renameSync(temporary, target);
    return true;
  } catch { return false; }
}

async function stopAdapter() {
  if (stoppedAdapter) return stoppedAdapter;
  stoppedAdapter = (async () => {
    clearTimeout(lifetimeTimer);
    await adapter?.dispose();
    status = 'stopped';
    writeReport();
  })();
  return stoppedAdapter;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise(resolve => server.close(resolve));
}

function finish(failed = false) {
  if (finishing) return finishing;
  finishing = (async () => {
    try { await stopAdapter(); } catch { failed = true; }
    if (failed) { status = 'error'; writeReport(); }
    for (const socket of sockets) socket.destroy();
    await closeServer(controlServer);
    await closeServer(activeServer);
    if (profilePath) {
      try { fs.unlinkSync(path.join(profilePath, 'control.json')); } catch {}
    }
    app.exit(failed ? 1 : 0);
  })();
  return finishing;
}

function listen(server, name) {
  return new Promise((resolve, reject) => {
    const onError = () => { server.removeListener('listening', onReady); reject(new Error('Fixture control endpoint unavailable')); };
    const onReady = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onReady);
    server.listen(name);
  });
}

function trackSocket(socket) {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  socket.on('error', () => socket.destroy());
  socket.setTimeout(5000, () => socket.destroy());
}

async function createControl() {
  // Only one live diagnostic fixture launched by this app may run at a time.
  activeServer = net.createServer(socket => { trackSocket(socket); socket.end(); });
  await listen(activeServer, ACTIVE_PIPE);
  activeServer.on('error', () => { void finish(true); });

  const pipeName = `being-desktop-live-${runId}`;
  const capability = randomBytes(32);
  controlServer = net.createServer(socket => {
    trackSocket(socket);
    let input = '';
    let dispatched = false;
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      if (dispatched) return;
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > 4096) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      dispatched = true;
      let request;
      try { request = JSON.parse(input.trim()); } catch { socket.destroy(); return; }
      input = '';
      if (!request || request.action !== 'stop' || request.runId !== runId || typeof request.capability !== 'string' || !/^[a-f0-9]{64}$/.test(request.capability)
        || !timingSafeEqual(Buffer.from(request.capability, 'hex'), capability)) { socket.destroy(); return; }
      request = null;
      void stopAdapter().then(() => {
        socket.end(JSON.stringify({runId, stopped: true}) + '\n', () => { void finish(); });
      }, () => { socket.destroy(); void finish(true); });
    });
  });
  await listen(controlServer, `\\\\.\\pipe\\${pipeName}`);
  controlServer.on('error', () => { void finish(true); });
  fs.writeFileSync(path.join(profilePath, 'control.json'), JSON.stringify({runId, pipeName, capability: capability.toString('hex')}), {mode: 0o600, flag: 'wx'});
}

async function run() {
  if (process.platform !== 'win32' || (process.env.BEING_LIVE_START === '1') === checkOnly) throw new Error('Explicit Windows fixture mode required');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId)) throw new Error('Invalid fixture run identifier');
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 300) throw new Error('Invalid fixture lifetime');
  const expectedName = `being-desktop-live-${runId}`;
  const candidate = path.join(localRoot, expectedName);
  if (path.dirname(candidate) !== localRoot || path.basename(candidate) !== expectedName) throw new Error('Invalid fixture profile');
  for (const directory of [appRoot, localRoot, candidate, path.join(localRoot, 'profile')]) regularDirectory(directory);
  profilePath = candidate;
  checkFlags.independentProfileGuard = true;
  app.setName('Being Desktop Live Fixture');
  app.setPath('userData', profilePath);
  app.commandLine.appendSwitch('disable-logging');
  await app.whenReady();
  lifetimeTimer = setTimeout(() => { void finish(); }, (checkOnly ? 15 : durationSeconds) * 1000);
  if (!checkOnly) await createControl();

  const copied = readJsonFile(path.join(profilePath, 'settings.json'), 1024 * 1024);
  const current = readJsonFile(path.join(localRoot, 'profile', 'settings.json'), 1024 * 1024);
  if (typeof copied.credential !== 'string' || !copied.credential || copied.credential !== current.credential) throw new Error('The fixture must use the currently saved encrypted connection');
  checkFlags.copiedCredentialMatchesSaved = true;
  checkFlags.systemEncryptionAvailable = safeStorage.isEncryptionAvailable();
  if (!checkFlags.systemEncryptionAvailable) throw new Error('System credential protection unavailable');
  const savedConnection = parseConnection(safeStorage.decryptString(Buffer.from(copied.credential, 'base64')));
  checkFlags.copiedCredentialUnlocked = true;
  copied.credential = '';
  current.credential = '';
  const loom = new URL(savedConnection.url);
  const beingId = decodeURIComponent(loom.pathname.split('/').filter(Boolean)[0] || '');
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(beingId) || !savedConnection.token) throw new Error('Saved Loom identity is invalid for the diagnostic relay');
  checkFlags.savedConnectionValid = true;
  checkFlags.websocketConstructorAvailable = typeof globalThis.WebSocket === 'function';
  if (!checkFlags.websocketConstructorAvailable) throw new Error('Fixture transport constructor unavailable');
  const relay = new URL('/_relay', loom.origin);
  relay.protocol = loom.protocol === 'https:' ? 'wss:' : 'ws:';

  const knownResult = handleMcpText(JSON.stringify({jsonrpc: '2.0', id: 'local-fixture-check', method: 'tools/call', params: {name: TOOL_NAME, arguments: {}}}));
  implementationMatchesExpected = knownResult.fixtureProcessed === true && knownResult.response?.result?.content?.length === 1
    && knownResult.response.result.content[0].type === 'text' && knownResult.response.result.content[0].text === FIXTURE_MARKER;
  if (!implementationMatchesExpected) throw new Error('Fixture constant does not match');
  checkFlags.fixedFixtureResultMatches = true;
  if (checkOnly) {
    savedConnection.url = '';
    savedConnection.token = '';
    savedConnection.secret = '';
    writeReport();
    await finish();
    return;
  }
  if (finishing || stoppedAdapter) return;
  adapter = new FixtureAdapter({onEvent(event) {
    const allowedStates = ['idle','connecting','connected','disconnected','error','stopped'];
    status = allowedStates.includes(event.status) ? event.status : 'error';
    if (event.category === 'handshake_accepted' && event.status === 'connected') handshakeAccepted = true;
    for (const name of counterNames) {
      const value = event.counters?.[name];
      if (Number.isSafeInteger(value) && value >= 0) counters[name] = value;
    }
    const result = event.lastFixture;
    if (result && /^[a-f0-9]{64}$/.test(result.requestIdSha256) && Number.isSafeInteger(result.processingCount)
      && result.processingCount >= 0 && typeof result.responseQueued === 'boolean') {
      lastFixture = {requestIdSha256: result.requestIdSha256, processingCount: result.processingCount, responseQueued: result.responseQueued};
    }
    if (!writeReport() && !finishing) queueMicrotask(() => { void finish(true); });
    if (['error','disconnected'].includes(status) && !finishing) queueMicrotask(() => { void finish(true); });
  }});
  writeReport();
  const target = {relayUrl: relay.href, beingId, loomToken: savedConnection.token, portalName: PORTAL_NAME};
  savedConnection.url = '';
  savedConnection.token = '';
  savedConnection.secret = '';
  checkFlags.connectionAttempted = true;
  try { await adapter.connect(target); }
  finally { target.loomToken = ''; }
}

process.on('uncaughtException', () => { void finish(true); });
process.on('unhandledRejection', () => { void finish(true); });
process.on('SIGINT', () => { void finish(); });
process.on('SIGTERM', () => { void finish(); });
app.on('before-quit', event => { if (!finishing) { event.preventDefault(); void finish(); } });
void run().catch(() => {
  // Cancelling an in-flight handshake is expected during an owned stop request.
  if (!stoppedAdapter && !finishing) void finish(true);
});
