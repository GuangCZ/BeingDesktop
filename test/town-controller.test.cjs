'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { TownController, requireTownIdentity } = require('../src/town-controller.cjs');

const confirmation = () => ({ confirmed: true, permissions: { files: true, exec: false, web: false } });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function harness(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'being-town-controller-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('being-town-controller-test-'));
    return fs.rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, 'workspace');
  const installedDirectory = path.join(root, 'managed-portal', 'v0.8.0');
  await fs.mkdir(workspace);
  await fs.mkdir(installedDirectory, { recursive: true });
  const executable = path.join(installedDirectory, 'heart-portal.exe');
  await fs.writeFile(executable, 'Non-executable unit-test fixture');
  const calls = [];
  const context = {
    configured: true, connected: true, exiting: false,
    workspace, portalExecutable: '', portalConfig: '', beingName: 'fixture-being',
    connectionId: 'private-identity-fixture', credential: 'private-credential-fixture',
    ...overrides.context,
  };
  const portalState = { status: 'not_configured', owned: false, detail: '', ...overrides.portalState };
  const installation = { status: 'installed', phase: 'not_started', version: '0.8.0', executable, verified: true, started: false };
  const h = { root, workspace, installedDirectory, executable, calls, context, portalState, installation, saved: null, progress: [] };
  h.defaultWorkspace = path.join(root, 'portal-workspace');
  const installer = {
    async inspect() {
      calls.push('installer.inspect');
      return overrides.inspectInstallation ? overrides.inspectInstallation(h) : { ...installation };
    },
    async install(options) {
      calls.push('installer.install');
      options.onProgress({ phase: 'download', receivedBytes: 0, totalBytes: 12193280 });
      if (overrides.install) return overrides.install(h, options);
      options.onProgress({ phase: 'hash', receivedBytes: 12193280, totalBytes: 12193280 });
      options.onProgress({ phase: 'install', receivedBytes: 12193280, totalBytes: 12193280 });
      return { ...installation };
    },
  };
  const portal = {
    get state() { return { ...portalState }; },
    async inspect() { calls.push('portal.inspect'); if (overrides.inspectPortal) await overrides.inspectPortal(h); return { ...portalState }; },
  };
  h.controller = new TownController({
    installer, portal, getContext: () => ({ ...context }), platform: overrides.platform || 'win32', arch: overrides.arch || 'x64',
    defaultWorkspace: h.defaultWorkspace,
    ...(overrides.configFactory ? { configFactory: overrides.configFactory } : {}),
    async saveDeployment(value) {
      calls.push('save');
      h.saved = { ...value };
      assert.equal((await fs.stat(value.configPath)).isFile(), true);
      Object.assign(context, { workspace: value.workspace, portalExecutable: value.executable, portalConfig: value.configPath, managedPortal: { ...value } });
      if (overrides.save) await overrides.save(h, value);
    },
    async startPortal() {
      calls.push('start');
      assert.ok(h.saved, 'Starting requires a saved deployment');
      if (overrides.start) return overrides.start(h);
      return { status: 'running', health: 'unknown' };
    },
    onChange() {
      h.progress.push(h.controller.state().portalInstall);
      if (overrides.onChange) overrides.onChange(h);
    },
  });
  return h;
}

test('deployment requires exact confirmation and the supported permission combination', async t => {
  const h = await harness(t);
  for (const value of [undefined, null, [], {}, { ...confirmation(), confirmed: false },
    { ...confirmation(), extra: true }, { confirmed: true, permissions: {} },
    { confirmed: true, permissions: { files: false, exec: false, web: false } },
    { confirmed: true, permissions: { files: true, exec: true, web: false } },
    { confirmed: true, permissions: { files: true, exec: false, web: true } }]) {
    await assert.rejects(h.controller.deploy(value), /确认/);
  }
  assert.deepEqual(h.calls, []);
});

test('inherited, accessor, symbol, and hidden confirmation fields are not accepted', async t => {
  let getterReads = 0;
  const inheritedPermissions = Object.assign(Object.create({ web: false }), { files: true, exec: false, extra: true });
  const withHidden = Object.defineProperty(confirmation(), 'extra', { value: true });
  const inputs = [
    { ...confirmation(), [Symbol('extra')]: true }, withHidden,
    Object.create(confirmation()), { confirmed: true, permissions: inheritedPermissions },
    { get confirmed() { getterReads++; return true; }, permissions: confirmation().permissions },
  ];
  for (const value of inputs) {
    const h = await harness(t);
    await assert.rejects(h.controller.deploy(value), /确认/);
    assert.deepEqual(h.calls, []);
  }
  assert.equal(getterReads, 0);
});

test('unsupported platform or architecture fails before inspecting processes or installing', async t => {
  for (const [platform, arch] of [['darwin', 'ia32'], ['linux', 'x64'], ['win32', 'arm64']]) {
    const h = await harness(t, { platform, arch });
    assert.equal(h.controller.state().platformSupported, false);
    await assert.rejects(h.controller.deploy(confirmation()), /已校验/);
    assert.deepEqual(h.calls, []);
  }
});

test('Mac deployment supports both architectures and retains external Portal ownership', async t => {
  for (const arch of ['arm64','x64']) {
    const h = await harness(t,{platform:'darwin',arch,portalState:{status:'external',pid:123,owned:false}});
    assert.equal(h.controller.state().platformSupported,true);
    const result=await h.controller.deploy(confirmation());
    assert.equal(result.status,'external');
    assert.deepEqual(h.calls,['portal.inspect']);
    assert.equal(h.saved,null);
  }
});

test('Mac fresh deployment persists the selected release metadata before starting', async t => {
  const h = await harness(t,{platform:'darwin',arch:'arm64'});
  const result=await h.controller.deploy(confirmation());
  assert.equal(result.status,'running');
  assert.ok(h.calls.indexOf('save')<h.calls.indexOf('start'));
  assert.equal(h.controller.state().portalInstall.totalBytes,12930864);
});

test('unconfigured, disconnected, and exiting contexts cannot begin deployment', async t => {
  for (const context of [{ configured: false }, { connected: false }, { exiting: true }]) {
    const h = await harness(t, { context });
    await assert.rejects(h.controller.deploy(confirmation()), /连接 Being/);
    assert.deepEqual(h.calls, []);
  }
});

test('missing real workspace fails before any download or persistence', async t => {
  const h = await harness(t);
  h.context.workspace = path.join(h.root, 'does-not-exist');
  await assert.rejects(h.controller.deploy(confirmation()), /工作区/);
  assert.deepEqual(h.calls, ['portal.inspect']);
  assert.equal(await fs.stat(h.context.workspace).then(() => true, () => false), false);
});

test('one-click configuration previews and creates a dedicated default workspace, then reuses it', async t => {
  const h = await harness(t, { context: { workspace: '' } });
  assert.deepEqual(h.controller.state().portalWorkspace, { path: h.defaultWorkspace, automatic: true });
  await assert.rejects(fs.stat(h.defaultWorkspace), { code: 'ENOENT' });
  await assert.rejects(h.controller.deploy({ confirmed: false }), /确认/);
  await assert.rejects(fs.stat(h.defaultWorkspace), { code: 'ENOENT' });
  assert.equal((await h.controller.deploy(confirmation())).status, 'running');
  const realWorkspace = await fs.realpath(h.defaultWorkspace);
  assert.equal(h.context.workspace, realWorkspace);
  assert.equal(h.saved.workspace, realWorkspace);
  assert.deepEqual(h.controller.state().portalWorkspace, { path: realWorkspace, automatic: false });
  assert.equal(JSON.parse(/^workspace = (.+)$/m.exec(await fs.readFile(h.saved.configPath, 'utf8'))[1]), realWorkspace);
  assert.deepEqual(await fs.readdir(realWorkspace), []);
  const saved = { ...h.saved };
  h.calls.length = 0;
  await h.controller.deploy(confirmation());
  assert.deepEqual(h.calls, ['portal.inspect', 'installer.inspect', 'start']);
  assert.deepEqual(h.saved, saved);
});

test('an owned Portal for a previous identity is preserved without reporting it as the current connection', async t => {
  const h = await harness(t, { context: { identityRevision: 2, portalIdentityRevision: 1 }, portalState: { status: 'running', owned: true } });
  const result = await h.controller.deploy(confirmation());
  assert.equal(result.status, 'existing_connection');
  assert.match(result.detail, /之前的 Being/);
  assert.deepEqual(h.calls, ['portal.inspect']);
  assert.equal(h.saved, null);
});

test('identity changes while inspecting processes prevent workspace creation and installation', async t => {
  const h = await harness(t, { context: { workspace: '', identityRevision: 1 }, inspectPortal(h) { h.context.identityRevision++; } });
  await assert.rejects(h.controller.deploy(confirmation()), /变化/);
  assert.deepEqual(h.calls, ['portal.inspect']);
  await assert.rejects(fs.stat(h.defaultWorkspace), { code: 'ENOENT' });
});

test('external and owned Portal instances are reused without installer, config writes, or new launch', async t => {
  for (const portalState of [{ status: 'external', owned: false }, { status: 'running', owned: true }]) {
    const h = await harness(t, { portalState });
    const result = await h.controller.deploy(confirmation());
    assert.equal(result.status, portalState.status);
    assert.deepEqual(h.calls, ['portal.inspect']);
    assert.deepEqual(await fs.readdir(h.installedDirectory), ['heart-portal.exe']);
  }
});

test('any existing program or configuration selection is preserved without automatic start', async t => {
  for (const context of [{ portalExecutable: 'existing-program' }, { portalConfig: 'existing-config' },
    { portalExecutable: 'existing-program', portalConfig: 'existing-config' }]) {
    const h = await harness(t, { context });
    assert.equal((await h.controller.deploy(confirmation())).status, 'existing_configuration');
    assert.deepEqual(h.calls, ['portal.inspect']);
    assert.equal(h.saved, null);
  }
});

test('uncertain process state blocks installer and launch', async t => {
  const h = await harness(t, { portalState: { status: 'error', detail: 'Process inspection unavailable' } });
  await assert.rejects(h.controller.deploy(confirmation()), /Process inspection/);
  assert.deepEqual(h.calls, ['portal.inspect']);
});

test('deployment validates workspace, installs, writes config, saves, then starts once', async t => {
  const h = await harness(t);
  const result = await h.controller.deploy(confirmation());
  assert.equal(result.status, 'running');
  assert.deepEqual(h.calls, ['portal.inspect', 'installer.install', 'save', 'start']);
  const toml = await fs.readFile(h.saved.configPath, 'utf8');
  assert.match(toml, /exec = false/);
  assert.match(toml, /workspace = /);
  assert.equal(h.saved.workspace, await fs.realpath(h.workspace));
  assert.equal(h.controller.state().portalInstall.capabilities.strictSandbox, false);
  assert.ok(h.progress.some(item => item.phase === 'hash'));
  assert.ok(h.progress.some(item => item.phase === 'install'));
  assert.match(result.detail, /等待中继/);
  assert.doesNotMatch(JSON.stringify(h.controller.state()), /private-identity|private-credential/);
});

test('save failure cleans the new configuration, retains the binary and unrelated files, and never launches', async t => {
  const h = await harness(t, { save() { throw new Error('Save failed'); } });
  await fs.writeFile(path.join(h.installedDirectory, 'keep.toml'), 'existing = true');
  await assert.rejects(h.controller.deploy(confirmation()));
  assert.equal(h.calls.includes('start'), false);
  assert.deepEqual((await fs.readdir(h.installedDirectory)).sort(), ['heart-portal.exe', 'keep.toml']);
  assert.deepEqual(h.controller.state().portalInstall.recovery,
    { program: 'retained_verified', configuration: 'removed', process: 'unknown' });
});

test('exclusive-create collision must not delete the preexisting configuration', async t => {
  const h = await harness(t);
  const fixedId = '11111111-2222-4333-8444-555555555555';
  t.mock.method(crypto, 'randomUUID', () => fixedId);
  const existing = path.join(h.installedDirectory, `desktop-${fixedId}.toml`);
  await fs.writeFile(existing, 'preserve_this = true');
  await assert.rejects(h.controller.deploy(confirmation()));
  assert.equal(h.calls.includes('save'), false);
  assert.equal(h.calls.includes('start'), false);
  assert.equal(await fs.readFile(existing, 'utf8'), 'preserve_this = true');
  assert.deepEqual(h.controller.state().portalInstall.recovery,
    { program: 'retained_verified', configuration: 'not_created', process: 'unknown' });
});

test('startup failure preserves an already saved configuration for retry', async t => {
  const h = await harness(t, { start(h) { h.portalState.status = 'error'; throw new Error('Start failed'); } });
  await assert.rejects(h.controller.deploy(confirmation()));
  assert.equal((await fs.stat(h.saved.configPath)).isFile(), true);
  assert.equal(h.controller.state().portalInstall.phase, 'failed');
  assert.deepEqual(h.controller.state().portalInstall.recovery,
    { program: 'retained_verified', configuration: 'saved', process: 'error' });
});

test('one-click deployment restarts its verified saved configuration without another install', async t => {
  const h=await harness(t);
  await h.controller.deploy(confirmation());
  Object.assign(h.context,{portalExecutable:h.saved.executable,portalConfig:h.saved.configPath,managedPortal:{...h.saved}});
  h.calls.length=0;
  const result=await h.controller.deploy(confirmation());
  assert.equal(result.status,'running');
  assert.deepEqual(h.calls,['portal.inspect','installer.inspect','start']);
});

test('one-click retry preserves changed configurations and does not start them', async t => {
  const h=await harness(t);
  await h.controller.deploy(confirmation());
  Object.assign(h.context,{portalExecutable:h.saved.executable,portalConfig:h.saved.configPath,managedPortal:{...h.saved}});
  await fs.appendFile(h.saved.configPath,'\n# User customization\n');
  h.calls.length=0;
  await assert.rejects(h.controller.deploy(confirmation()),/未能启动/);
  assert.equal(h.calls.includes('start'),false);
  assert.match(await fs.readFile(h.saved.configPath,'utf8'),/User customization/);
});

test('one-click Portal retry accepts the verified Grove configuration extension',async t=>{
  const h=await harness(t);
  await h.controller.deploy(confirmation());
  const groveKitsDir=path.join(h.root,'grove-kits');
  await fs.mkdir(groveKitsDir);
  const {enableGrovePortal}=require('../src/grove-portal.cjs');
  const enabled=await enableGrovePortal({configPath:h.saved.configPath,kitsDir:groveKitsDir});
  assert.equal(enabled.ready,true);
  h.context.managedPortal={...h.saved,groveKitsDir};
  h.calls.length=0;
  assert.equal((await h.controller.deploy(confirmation())).status,'running');
  assert.deepEqual(h.calls,['portal.inspect','installer.inspect','start']);
});

test('one-click retry rejects modified binaries and workspace changes before launch', async t => {
  for(const change of ['binary','workspace']) {
    const h=await harness(t);
    await h.controller.deploy(confirmation());
    Object.assign(h.context,{portalExecutable:h.saved.executable,portalConfig:h.saved.configPath,managedPortal:{...h.saved}});
    if(change==='binary') h.installation.verified=false;
    else h.context.managedPortal.workspace='different-workspace';
    h.calls.length=0;
    await assert.rejects(h.controller.deploy(confirmation()));
    assert.equal(h.calls.includes('start'),false);
    assert.equal(h.calls.includes('installer.install'),false);
  }
});

test('identity, workspace, or selected paths changing during download leave the installed binary unstarted', async t => {
  for (const change of [h => { h.context.connectionId = 'new-identity'; },
    h => { h.context.identityRevision = 2; }, h => { h.context.beingName = 'different-being'; },
    h => { h.context.portalExecutable = 'different-program'; }, h => { h.context.portalConfig = 'different-config'; },
    h => { h.context.workspace = path.join(h.root, 'other-workspace'); }, h => { h.context.exiting = true; }]) {
    const h = await harness(t, { install(h) { change(h); return { ...h.installation }; } });
    await assert.rejects(h.controller.deploy(confirmation()), /变化/);
    assert.equal(h.calls.includes('save'), false);
    assert.equal(h.calls.includes('start'), false);
    assert.deepEqual(await fs.readdir(h.installedDirectory), ['heart-portal.exe']);
  }
});

test('loss of connected or configured state during download prevents saving and starting', async t => {
  for (const field of ['connected', 'configured']) {
    const h = await harness(t, { install(h) { h.context[field] = false; return { ...h.installation }; } });
    await assert.rejects(h.controller.deploy(confirmation()));
    assert.equal(h.calls.includes('save'), false);
    assert.equal(h.calls.includes('start'), false);
  }
});

test('identity and workspace are checked again after asynchronous persistence before start', async t => {
  for (const field of ['connectionId', 'identityRevision', 'beingName', 'workspace', 'portalExecutable', 'portalConfig']) {
    const h = await harness(t, { save(h) { h.context[field] = 'changed-during-save'; } });
    await assert.rejects(h.controller.deploy(confirmation()));
    assert.equal(h.calls.includes('start'), false);
    assert.equal((await fs.stat(h.saved.configPath)).isFile(), true);
  }
});

test('duplicate deployment clicks share one workflow and a failed workflow can be retried', async t => {
  const started = deferred();
  const release = deferred();
  let attempts = 0;
  const h = await harness(t, { async install(h) {
    attempts++;
    if (attempts === 1) { started.resolve(); await release.promise; throw new Error('First fixture download failed'); }
    return { ...h.installation };
  } });
  const first = h.controller.deploy(confirmation());
  const duplicate = h.controller.deploy(confirmation());
  assert.equal(first, duplicate);
  const rejection = assert.rejects(first);
  await started.promise;
  assert.equal(h.calls.filter(call => call === 'installer.install').length, 1);
  release.resolve();
  await rejection;
  assert.equal((await h.controller.deploy(confirmation())).status, 'running');
  assert.equal(attempts, 2);
  assert.equal(h.calls.filter(call => call === 'start').length, 1);
});

test('public state does not publish credential-bearing failure text or unknown progress fields', async t => {
  const h = await harness(t, {
    install(h, { onProgress }) {
      onProgress({ phase: 'download', receivedBytes: 3, totalBytes: 12193280,
        authorization: 'Bearer fixture-private-secret', url: 'https://private.test/?token=fixture-private-secret' });
      throw new Error('Download https://private.test/?token=fixture-private-secret Authorization: Bearer fixture-private-secret');
    },
  });
  let failure;
  try { await h.controller.deploy(confirmation()); } catch (error) { failure = error; }
  assert.ok(failure);
  assert.doesNotMatch(failure.message, /fixture-private-secret|Authorization:/);
  assert.doesNotMatch(JSON.stringify(h.controller.state()), /fixture-private-secret|authorization|private\.test/);
  assert.doesNotMatch(JSON.stringify(h.progress), /fixture-private-secret|authorization|private\.test/);
});

test('observer exceptions do not interrupt deployment or leave serialization stuck', async t => {
  const h = await harness(t, { onChange() { throw new Error('Observer failed'); } });
  assert.equal((await h.controller.deploy(confirmation())).status, 'running');
});

test('a stale refresh cannot overwrite deployment progress after installation begins', async t => {
  const inspection = deferred();
  const inspectionStarted = deferred();
  const installation = deferred();
  const installationStarted = deferred();
  const h = await harness(t, {
    inspectInstallation() { inspectionStarted.resolve(); return inspection.promise; },
    async install(h, { onProgress }) {
      onProgress({ phase: 'download', receivedBytes: 10, totalBytes: 12193280 });
      installationStarted.resolve();
      await installation.promise;
      return { ...h.installation };
    },
  });
  const refresh = h.controller.refresh();
  await inspectionStarted.promise;
  const deployment = h.controller.deploy(confirmation());
  await installationStarted.promise;
  inspection.resolve({ ...h.installation, status: 'not_installed', phase: 'not_started', verified: false });
  await refresh;
  const phase = h.controller.state().portalInstall.phase;
  installation.resolve();
  await deployment;
  assert.equal(phase, 'download');
});

test('a refresh started before deployment cannot overwrite its completed state with an old failure', async t => {
  const inspection = deferred();
  const inspectionStarted = deferred();
  const h = await harness(t, { inspectInstallation() { inspectionStarted.resolve(); return inspection.promise; } });
  const refresh = h.controller.refresh();
  await inspectionStarted.promise;
  await h.controller.deploy(confirmation());
  inspection.reject(new Error('Earlier inspection failed'));
  await refresh;
  assert.equal(h.controller.state().portalInstall.status, 'installed');
  assert.equal(h.controller.state().portalInstall.phase, 'running');
});

test('Town identity-gated actions remain unavailable without a confirmed desktop authorization flow', () => {
  assert.throws(requireTownIdentity, /尚未提供已确认的桌面身份授权入口/);
});
