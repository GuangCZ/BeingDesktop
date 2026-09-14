'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {DesktopUpdates, updateSupport, prepareMacUpdate, readPublishedVersion, RELEASE_API, CHECK_INTERVAL_MS} = require('../src/desktop-updates.cjs');

function fixture({version = '0.8.26', enabled = true, supported = true, available = true, prepareInstall} = {}) {
  const calls = [], updater = new EventEmitter();
  let clock = 1, interval;
  updater.checkForUpdates = async () => {calls.push('check');return {updateInfo: {version}, isUpdateAvailable: available};};
  updater.downloadUpdate = async () => {calls.push('download');updater.emit('download-progress', {percent: 48});updater.emit('update-downloaded');};
  updater.quitAndInstall = () => calls.push('install');
  const updates = new DesktopUpdates({version: '0.8.25', unsupported: supported ? '' : 'unsupported',
    createUpdater: () => updater, getEnabled: () => enabled, getPublishedVersion: null, now: () => clock,
    onReady: () => calls.push('notify'), prepareInstall,
    setIntervalImpl: callback => {interval = callback;calls.push('timer');return 1;},
    clearIntervalImpl: () => {interval = null;calls.push('clear');}});
  return {updates, updater, calls, enable: value => {enabled = value;}, tick: () => {clock += CHECK_INTERVAL_MS;interval?.();}};
}
test('hourly checks only detect updates; explicit download runs once and never installs', async () => {
  const f = fixture();f.updates.start();f.updates.start();await f.updates.check();
  assert.equal(CHECK_INTERVAL_MS, 60 * 60 * 1000);
  assert.deepEqual(f.calls, ['timer', 'check']);
  assert.equal(f.updates.state().status, 'available');
  const download = f.updates.download();assert.equal(download, f.updates.download());
  await f.updates.check({manual: true});await download;
  assert.deepEqual(f.calls, ['timer', 'check', 'download', 'notify']);
  assert.equal(f.updates.state().status, 'ready');assert.equal(f.updates.state().progress, 100);
  assert.equal(f.updater.autoInstallOnAppQuit, false);assert.equal(f.updater.autoDownload, false);
  f.tick();await f.updates.check({manual: true});assert.equal(f.calls.filter(x => x === 'check').length, 1);
  f.updates.stop();
});
test('setting off disables background requests, manual check detects and explicit download works', async () => {
  const f = fixture({enabled: false});f.updates.start();await f.updates.check();assert.deepEqual(f.calls, []);
  await f.updates.check({manual: true});assert.equal(f.updates.state().status, 'available');
  assert.deepEqual(f.calls, ['check']);await f.updates.download();assert.equal(f.updates.state().status, 'ready');
});
test('disabling during check prevents the automatic download', async () => {
  const f = fixture();let resolve;
  f.updater.checkForUpdates = () => new Promise(done => {resolve = done;});
  const pending = f.updates.check();f.enable(false);
  resolve({updateInfo: {version: '0.8.26'}, isUpdateAvailable: true});await pending;
  assert.equal(f.updates.state().status, 'available');assert.deepEqual(f.calls, []);
});
test('same version, downgrade, unsupported OS and staged rollout never download', async () => {
  for (const options of [{version: '0.8.25'}, {version: '0.8.24'}, {available: false}]) {
    const f = fixture(options);await f.updates.check();await f.updates.download();assert.deepEqual(f.calls, ['check']);assert.equal(f.updates.state().status, options.version === '0.8.24' ? 'ahead' : 'current');
  }
  const f = fixture({supported: false});f.updates.start();await f.updates.check({manual: true});assert.deepEqual(f.calls, []);
});
test('malformed and prerelease versions are not downloaded', async () => {
  for (const version of ['0.8.26-beta.1', '', '<script>']) {
    const f = fixture({version});await f.updates.check();assert.equal(f.updates.state().status, 'error');assert.deepEqual(f.calls, ['check']);
  }
});
test('older and equal published releases without update manifests skip the updater entirely', async () => {
  for (const version of ['0.8.24', '0.8.25']) {
    const f = fixture();let created = 0;
    f.updates.getPublishedVersion = () => readPublishedVersion({fetchImpl: async () => new Response(JSON.stringify({tag_name: `v${version}`, draft: false, prerelease: false, assets: []}))});
    f.updates.createUpdater = () => {created++;throw new Error('latest-mac.yml missing');};
    await f.updates.check({manual: true});
    assert.equal(f.updates.state().status, version === '0.8.24' ? 'ahead' : 'current');
    assert.equal(f.updates.state().latestVersion, version);
    assert.equal(f.updates.state().checkedAt, new Date(1).toISOString());
    assert.equal(created, 0);assert.deepEqual(f.calls, []);
    await f.updates.install(() => {throw new Error('must not install or downgrade');});
  }
});
test('a newer published version checks the manifest and waits for download', async () => {
  const f = fixture();f.updates.getPublishedVersion = async () => '0.8.26';
  await f.updates.check();assert.equal(f.updates.state().status, 'available');
  assert.deepEqual(f.calls, ['check']);await f.updates.download();assert.equal(f.updates.state().status, 'ready');
  assert.deepEqual(f.calls, ['check', 'download', 'notify']);
});
test('newer releases with missing manifests remain errors instead of current/ahead', async () => {
  const f = fixture();f.updates.getPublishedVersion = async () => '0.8.26';
  f.updater.checkForUpdates = async () => {throw new Error('latest.yml missing');};
  await f.updates.check();assert.equal(f.updates.state().status, 'error');assert.equal(f.updates.state().latestVersion, '0.8.26');
  assert(!f.calls.includes('download'));
});
test('failed release requests cannot turn a stale ahead result into a successful check', async () => {
  const f = fixture();f.updates.getPublishedVersion = async () => '0.8.24';await f.updates.check();
  assert.equal(f.updates.state().status, 'ahead');
  f.updates.getPublishedVersion = async () => {throw new Error('network token=PRIVATE');};
  await f.updates.check({manual: true});assert.equal(f.updates.state().status, 'error');
  assert.deepEqual(f.calls, []);assert(!JSON.stringify(f.updates.state()).includes('PRIVATE'));
});
test('published-version request is fixed, bounded, unauthenticated and validates stable tags', async () => {
  const release = {tag_name: 'v0.8.25', draft: false, prerelease: false};
  assert.equal(await readPublishedVersion({fetchImpl: async (url, options) => {
    assert.equal(url, RELEASE_API);assert.equal(options.credentials, 'omit');assert.equal(options.redirect, 'error');
    assert(!options.headers.Authorization);return new Response(JSON.stringify(release));
  }}), '0.8.25');
  for (const data of [{}, {...release, draft: true}, {...release, prerelease: true}, {...release, tag_name: 'v0.8.26-beta.1'}, {...release, tag_name: 'garbage'}])
    await assert.rejects(readPublishedVersion({fetchImpl: async () => new Response(JSON.stringify(data))}));
  for (const status of [403, 404, 429, 500])
    await assert.rejects(readPublishedVersion({fetchImpl: async () => new Response('{}', {status})}));
  await assert.rejects(readPublishedVersion({fetchImpl: async () => new Response('<html>offline</html>')}));
  await assert.rejects(readPublishedVersion({fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1))}), /too large/);
  await assert.rejects(readPublishedVersion({timeoutMs: 5, fetchImpl: (_url, {signal}) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('timeout')), {once: true});
  })}), /timeout/);
});
test('network/checksum failures remain retryable and do not expose raw URLs or install', async () => {
  for (const method of ['checkForUpdates', 'downloadUpdate']) {
    const f = fixture();const original = f.updater[method];
    f.updater[method] = async () => {throw new Error('https://secret.invalid/?token=PRIVATE');};
    await f.updates.check();await f.updates.download();assert.equal(f.updates.state().status, 'error');assert(!JSON.stringify(f.updates.state()).includes('PRIVATE'));
    await f.updates.install(() => {throw new Error('must not quit');});
    f.updater[method] = original;await f.updates.check({manual: true});await f.updates.download();assert.equal(f.updates.state().status, 'ready');
  }
});
test('concurrent checks share a request, and completed checks respect one-hour schedule', async () => {
  const f = fixture({version: '0.8.25'});const a = f.updates.check();assert.equal(a, f.updates.check({manual: true}));await a;
  await f.updates.check();assert.equal(f.calls.length, 1);await f.updates.check({manual: true});assert.equal(f.calls.length, 2);
  f.updates.start();f.tick();await f.updates.check();assert.equal(f.calls.filter(x => x === 'check').length, 3);f.updates.stop();
});
test('installation waits for native verification and successful shutdown, duplicate clicks ignored', async () => {
  let finish;const f = fixture({prepareInstall: () => new Promise(resolve => {finish = resolve;})});
  await f.updates.check();await f.updates.download();let stops = 0;
  const install = f.updates.install(async apply => {stops++;apply();return true;});
  await f.updates.install(() => {throw new Error('duplicate');});assert.equal(stops, 0);finish();await install;
  assert.equal(stops, 1);assert.equal(f.calls.filter(x => x === 'install').length, 1);
});
test('failed native verification does not shut down; blocked shutdown allows retry', async () => {
  const f = fixture({prepareInstall: async () => {throw new Error('bad signature');}});await f.updates.check();await f.updates.download();
  await f.updates.install(() => {throw new Error('must not quit');});assert.equal(f.updates.state().status, 'error');assert(!f.calls.includes('install'));
  const g = fixture();await g.updates.check();await g.updates.download();await g.updates.install(async () => false);assert.equal(g.updates.state().status, 'ready');assert(!g.calls.includes('install'));
});
test('installer errors after cleanup request recovery of the old app exactly once', async () => {
  for (const synchronous of [true, false]) {
    const f = fixture();let recovered = 0;
    f.updates.onInstallError = () => {recovered++;};
    await f.updates.check();await f.updates.download();
    f.updater.quitAndInstall = () => {
      if(synchronous)throw new Error('cannot launch');
      queueMicrotask(() => f.updater.emit('error', new Error('launch failed')));
    };
    await f.updates.install(async apply => {apply();return true;});
    assert.equal(recovered, 1);assert.equal(f.updates.state().status, 'error');
  }
});
test('native mac preflight waits for native completion, cleans listeners on errors and timeout', async () => {
  const native = new EventEmitter();native.checkForUpdates = () => {};
  const ready = prepareMacUpdate(native);native.emit('update-downloaded');await ready;
  const failed = prepareMacUpdate(native);native.emit('error', new Error('signature'));await assert.rejects(failed, /验证/);
  await assert.rejects(prepareMacUpdate(native, 5), /超时/);
  assert.equal(native.listenerCount('error'), 0);assert.equal(native.listenerCount('update-downloaded'), 0);
});
test('support detection excludes source runs, portable/unpacked Windows and missing publish config', () => {
  const base = {packaged: true, platform: 'darwin', executable: '/app/Being', resourcesPath: '/app/resources', exists: () => true};
  assert.equal(updateSupport(base), '');assert.match(updateSupport({...base, packaged: false}), /开发/);
  assert.match(updateSupport({...base, platform: 'win32', portable: true}), /便携/);
  assert.match(updateSupport({...base, platform: 'win32', exists: p => !p.endsWith('.exe')}), /便携/);
  assert.match(updateSupport({...base, exists: () => false}), /未配置/);
  assert.match(updateSupport({...base, platform: 'linux'}), /平台/);
});
