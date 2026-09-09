'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PortalUpdates, parseVersion, compareVersions, parsePortalRelease: parseRelease, readPortalVersion,
  RELEASE_API, CHECK_INTERVAL_MS, RETRY_INTERVAL_MS,
} = require('../src/portal-updates.cjs');

const parsePortalRelease = value => parseRelease(value,{platform:'win32',arch:'x64'});
const EXECUTABLE = require('node:path').resolve('fixture-portal', 'heart-portal');
const NEW_EXECUTABLE = require('node:path').resolve('fixture-portal-next', 'heart-portal');

function release(version = '0.9.0') {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/d5z/heart-portal/releases/tag/v${version}`,
    assets: [{
      name: 'heart-portal-windows-x86_64.exe',
      state: 'uploaded',
      size: 12_193_280,
      browser_download_url: `https://github.com/d5z/heart-portal/releases/download/v${version}/heart-portal-windows-x86_64.exe`,
    }],
  };
}

function response(body = release(), status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture(t, overrides = {}) {
  let executable = EXECUTABLE;
  let time = 86_400_000;
  const requests = [];
  const reads = [];
  const notifications = [];
  const changes = [];
  const timers = [];
  const clearedTimers = [];
  const service = new PortalUpdates({platform:'win32',arch:'x64',
    getExecutable: () => executable,
    readVersion: async value => { reads.push(value); return '0.8.0'; },
    fetchImpl: async (url, options) => { requests.push({ url: String(url), options }); return response(); },
    now: () => time,
    onChange: snapshot => changes.push(snapshot),
    onAvailable: async snapshot => notifications.push(snapshot),
    getNotifiedVersion: () => '',
    setIntervalImpl: (callback, interval) => {
      const timer = { callback, interval, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalImpl: timer => clearedTimers.push(timer),
    ...overrides,
  });
  t.after(() => service.stop());
  return {
    service, requests, reads, notifications, changes, timers, clearedTimers,
    setExecutable: value => { executable = value; },
    advance: delta => { time += delta; },
    now: () => time,
  };
}

test('Portal versions are parsed strictly and compared numerically with SemVer precedence', () => {
  assert.deepEqual(parseVersion('v0.8.0'), {
    version: '0.8.0', major: 0, minor: 8, patch: 0, prerelease: [],
  });
  for (const value of ['', null, {}, '0.8', '0.08.0', '01.8.0', '0.8.00', 'latest', '0.8.0garbage']) {
    assert.equal(parseVersion(value), null, String(value));
    assert.equal(compareVersions(value, '0.8.0'), null, String(value));
  }
  for (const [older, newer] of [
    ['0.9.9', '0.10.0'], ['0.8.9', '0.8.10'], ['0.99.99', '1.0.0'],
    ['1.0.0-alpha', '1.0.0-alpha.1'], ['1.0.0-alpha.2', '1.0.0-alpha.10'],
    ['1.0.0-beta.2', '1.0.0-beta.a'], ['1.0.0-rc.1', '1.0.0'],
  ]) {
    assert.equal(compareVersions(older, newer), -1, `${older} < ${newer}`);
    assert.equal(compareVersions(newer, older), 1, `${newer} > ${older}`);
  }
  assert.equal(compareVersions('v0.8.0', '0.8.0'), 0);
  assert.equal(compareVersions('0.8.0+build.1', '0.8.0+build.2'), 0);
});

test('only the official stable release with its matching uploaded Windows asset is accepted', () => {
  assert.equal(RELEASE_API, 'https://api.github.com/repos/d5z/heart-portal/releases/latest');
  assert.deepEqual(parsePortalRelease(release('0.10.0')), {
    version: '0.10.0', url: 'https://github.com/d5z/heart-portal/releases/tag/v0.10.0',
  });
  const invalid = [
    null, {}, { ...release(), draft: true }, { ...release(), prerelease: true },
    release('0.9.0-rc.1'), { ...release(), tag_name: 'latest' },
    { ...release(), html_url: 'https://github.com.evil.test/d5z/heart-portal/releases/tag/v0.9.0' },
    { ...release(), html_url: 'https://github.com/other/heart-portal/releases/tag/v0.9.0' },
    { ...release(), html_url: 'https://github.com/d5z/heart-portal/releases/tag/v9.9.9' },
    { ...release(), html_url: 'http://github.com/d5z/heart-portal/releases/tag/v0.9.0' },
    { ...release(), assets: [] },
    { ...release(), assets: [{ ...release().assets[0], state: 'new' }] },
    { ...release(), assets: [{ ...release().assets[0], size: 0 }] },
    { ...release(), assets: [{ ...release().assets[0], size: 1.5 }] },
    { ...release(), assets: [{ ...release().assets[0], name: 'heart-portal-linux-x86_64' }] },
    { ...release(), assets: [{ ...release().assets[0], browser_download_url: 'https://evil.test/portal.exe' }] },
    { ...release(), assets: [{ ...release().assets[0], browser_download_url: 'https://github.com/d5z/heart-portal/releases/download/v0.8.0/heart-portal-windows-x86_64.exe' }] },
  ];
  for (const body of invalid) {
    assert.throws(() => parsePortalRelease(body), error => {
      assert.match(error.message, /[\u4e00-\u9fff]/);
      assert.doesNotMatch(error.message, /evil\.test/);
      return true;
    });
  }
});

test('the local version probe only reads a regular Portal executable with a hidden shell-free command', async () => {
  const calls = [];
  const options = {
    statImpl: async executable => {
      assert.equal(executable, EXECUTABLE);
      return { isFile: () => true, isSymbolicLink: () => false };
    },
    execImpl: async (...args) => { calls.push(args); return { stdout: 'heart-portal v0.8.0\r\n' }; },
  };
  assert.equal(await readPortalVersion(EXECUTABLE, options), '0.8.0');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], EXECUTABLE);
  assert.deepEqual(calls[0][1], ['--version']);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(calls[0][2].shell, false);
  assert.ok(calls[0][2].timeout > 0);
  assert.ok(calls[0][2].maxBuffer > 0);
  for (const executable of ['', 'relative\\heart-portal.exe', 'C:\\Portal\\other.exe', `${EXECUTABLE}\n--execute`]) {
    assert.equal(await readPortalVersion(executable, options), '');
  }
  assert.equal(calls.length, 1);
  for (const stat of [
    { isFile: () => false, isSymbolicLink: () => false },
    { isFile: () => true, isSymbolicLink: () => true },
  ]) {
    assert.equal(await readPortalVersion(EXECUTABLE, { ...options, statImpl: async () => stat }), '');
  }
  assert.equal(calls.length, 1);
  assert.equal(await readPortalVersion(EXECUTABLE, {
    ...options, execImpl: async () => ({ stdout: 'other-tool 0.8.0' }),
  }), '');
  assert.equal(await readPortalVersion(EXECUTABLE, {
    ...options, execImpl: async () => { throw new Error('process failed'); },
  }), '');
});

test('an unconfigured Portal skips process inspection and the network', async t => {
  const f = fixture(t);
  f.setExecutable('');
  const state = await f.service.check();
  assert.equal(state.status, 'not_installed');
  assert.equal(state.available, false);
  assert.equal(state.checking, false);
  assert.equal(f.reads.length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.notifications.length, 0);
});

test('a newer official release publishes the current and latest versions and notifies once', async t => {
  const f = fixture(t);
  const state = await f.service.check();
  assert.equal(state.status, 'available');
  assert.equal(state.currentVersion, '0.8.0');
  assert.equal(state.latestVersion, '0.9.0');
  assert.equal(state.releaseUrl, release().html_url);
  assert.equal(state.available, true);
  assert.equal(state.checking, false);
  assert.ok(state.checkedAt);
  assert.equal(f.notifications.length, 1);
  assert.equal(f.notifications[0].latestVersion, '0.9.0');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, RELEASE_API);
  assert.equal(f.requests[0].options.method, 'GET');
  assert.equal(f.requests[0].options.credentials, 'omit');
  assert.equal(f.requests[0].options.body, undefined);
  assert.deepEqual(f.reads, [EXECUTABLE]);
  await f.service.check({ force: true });
  assert.equal(f.notifications.length, 1);
  assert.equal(f.requests.length, 2);
});

test('equal and locally newer versions are current without update notifications', async t => {
  for (const localVersion of ['0.9.0', '0.10.0']) {
    const f = fixture(t, { readVersion: async () => localVersion });
    const state = await f.service.check();
    assert.equal(state.status, 'current');
    assert.equal(state.currentVersion, localVersion);
    assert.equal(state.available, false);
    assert.equal(f.notifications.length, 0);
  }
});

test('an unrecognized local version cannot be described as current or update available', async t => {
  const f = fixture(t, { readVersion: async () => 'unrecognized version output' });
  const state = await f.service.check();
  assert.equal(state.status, 'unknown');
  assert.equal(state.available, false);
  assert.equal(state.checking, false);
  assert.equal(f.notifications.length, 0);
});

test('a successful check is cached for six hours and force bypasses that cache', async t => {
  assert.equal(CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
  const f = fixture(t);
  await f.service.check();
  f.advance(CHECK_INTERVAL_MS - 1);
  await f.service.check();
  assert.equal(f.requests.length, 1);
  f.advance(1);
  await f.service.check();
  assert.equal(f.requests.length, 2);
  await f.service.check({ force: true });
  assert.equal(f.requests.length, 3);
});

test('a failed network check returns safe feedback and retries after fifteen minutes', async t => {
  assert.equal(RETRY_INTERVAL_MS, 15 * 60 * 1000);
  let calls = 0;
  const f = fixture(t, {
    fetchImpl: async () => {
      calls++;
      if (calls === 1) throw new Error('Authorization: Bearer secret-fixture-token');
      return response();
    },
  });
  const failed = await f.service.check();
  assert.equal(failed.status, 'error');
  assert.equal(failed.checking, false);
  assert.equal(failed.available, false);
  assert.doesNotMatch(failed.detail, /secret-fixture-token/);
  f.advance(RETRY_INTERVAL_MS - 1);
  await f.service.check();
  assert.equal(calls, 1);
  f.advance(1);
  assert.equal((await f.service.check()).status, 'available');
  assert.equal(calls, 2);
});

test('failed refresh retains a previously known available release without notifying again', async t => {
  let fail = false;
  const f = fixture(t, {
    fetchImpl: async () => {
      if (fail) return response({ message: 'rate limited' }, 403);
      return response();
    },
  });
  await f.service.check();
  fail = true;
  const state = await f.service.check({ force: true });
  assert.equal(state.status, 'error');
  assert.equal(state.available, true);
  assert.equal(state.currentVersion, '0.8.0');
  assert.equal(state.latestVersion, '0.9.0');
  assert.equal(state.releaseUrl, release().html_url);
  assert.equal(f.notifications.length, 1);
});

test('malformed and oversized server bodies become a safe error without an update notification', async t => {
  for (const body of ['not-json: secret-fixture-token', ' '.repeat(1024 * 1024 + 1)]) {
    const f = fixture(t, { fetchImpl: async () => new Response(body, { status: 200 }) });
    const state = await f.service.check();
    assert.equal(state.status, 'error');
    assert.equal(state.checking, false);
    assert.equal(state.available, false);
    assert.doesNotMatch(state.detail, /secret-fixture-token/);
    assert.equal(f.notifications.length, 0);
  }
});

test('a Portal updated in place is detected on refresh and clears the previous update notice', async t => {
  let version = '0.8.0';
  const f = fixture(t, { readVersion: async () => version });
  assert.equal((await f.service.check()).available, true);
  version = '0.9.0';
  const state = await f.service.check({ force: true });
  assert.equal(state.status, 'current');
  assert.equal(state.currentVersion, '0.9.0');
  assert.equal(state.available, false);
  assert.equal(f.notifications.length, 1);
});

test('observer failures do not fail a completed update check or its notification', async t => {
  const f = fixture(t, {
    onChange: () => { throw new Error('observer failed'); },
  });
  const state = await f.service.check();
  assert.equal(state.status, 'available');
  assert.equal(state.available, true);
  assert.equal(state.checking, false);
  assert.equal(f.notifications.length, 1);
});

for (const failure of ['throws', 'returns false']) {
  test(`a notification that ${failure} is retried on a later forced check and suppressed only after success`, async t => {
    const attempts = [];
    const f = fixture(t, {
      onAvailable: async state => {
        attempts.push(state.latestVersion);
        if (attempts.length === 1) {
          if (failure === 'throws') throw new Error('notification persistence failed');
          return false;
        }
        return true;
      },
    });
    const first = await f.service.check();
    assert.equal(first.status, 'available');
    assert.equal(first.available, true);
    assert.equal(first.checking, false);
    assert.deepEqual(attempts, ['0.9.0']);
    await f.service.check();
    assert.deepEqual(attempts, ['0.9.0']);
    const retry = await f.service.check({ force: true });
    assert.equal(retry.status, 'available');
    assert.deepEqual(attempts, ['0.9.0', '0.9.0']);
    await f.service.check({ force: true });
    assert.deepEqual(attempts, ['0.9.0', '0.9.0']);
  });
}

test('concurrent checks share one network request including forced checks', async t => {
  const entered = deferred();
  const pending = deferred();
  let calls = 0;
  const f = fixture(t, {
    fetchImpl: async () => { calls++; entered.resolve(); return pending.promise; },
  });
  const first = f.service.check();
  await entered.promise;
  assert.equal(f.service.state().checking, true);
  const second = f.service.check();
  const third = f.service.check({ force: true });
  pending.resolve(response());
  const states = await Promise.all([first, second, third]);
  assert.equal(calls, 1);
  assert.ok(states.every(state => state.status === 'available'));
  assert.equal(f.notifications.length, 1);
});

test('notifications honor persisted suppression and still announce a later new version', async t => {
  let latest = '0.9.0';
  const f = fixture(t, {
    getNotifiedVersion: () => '0.9.0',
    fetchImpl: async () => response(release(latest)),
  });
  assert.equal((await f.service.check()).available, true);
  assert.equal(f.notifications.length, 0);
  latest = '0.10.0';
  await f.service.check({ force: true });
  assert.equal(f.notifications.length, 1);
  assert.equal(f.notifications[0].latestVersion, '0.10.0');
});

test('changing the executable discards a stale version read and checks the new selection', async t => {
  const entered = deferred();
  const oldVersion = deferred();
  const f = fixture(t, {
    readVersion: async executable => {
      if (executable === EXECUTABLE) { entered.resolve(); return oldVersion.promise; }
      assert.equal(executable, NEW_EXECUTABLE);
      return '0.10.0';
    },
  });
  const oldCheck = f.service.check();
  await entered.promise;
  f.setExecutable(NEW_EXECUTABLE);
  f.service.changed();
  const state = await f.service.check();
  assert.equal(state.currentVersion, '0.10.0');
  assert.equal(state.status, 'current');
  oldVersion.resolve('0.1.0');
  await oldCheck;
  assert.equal(f.service.state().currentVersion, '0.10.0');
  assert.equal(f.service.state().available, false);
  assert.equal(f.notifications.length, 0);
});

test('changing the executable aborts and ignores an old server response even if fetch ignores abort', async t => {
  const entered = deferred();
  const oldResponse = deferred();
  let firstSignal;
  let calls = 0;
  const f = fixture(t, {
    readVersion: async executable => executable === EXECUTABLE ? '0.8.0' : '0.10.0',
    fetchImpl: async (_url, options) => {
      calls++;
      if (calls === 1) { firstSignal = options.signal; entered.resolve(); return oldResponse.promise; }
      return response();
    },
  });
  const oldCheck = f.service.check();
  await entered.promise;
  f.setExecutable(NEW_EXECUTABLE);
  f.service.changed();
  assert.equal((await f.service.check()).status, 'current');
  assert.equal(firstSignal.aborted, true);
  oldResponse.resolve(response(release('99.0.0')));
  await oldCheck;
  const state = f.service.state();
  assert.equal(state.status, 'current');
  assert.equal(state.currentVersion, '0.10.0');
  assert.equal(state.latestVersion, '0.9.0');
  assert.equal(f.notifications.length, 0);
});

test('removing the executable clears update state and cancels future requests', async t => {
  const f = fixture(t);
  await f.service.check();
  f.setExecutable('');
  f.service.changed();
  const state = await f.service.check();
  assert.equal(state.status, 'not_installed');
  assert.equal(state.available, false);
  assert.ok(!state.releaseUrl);
  assert.equal(f.requests.length, 1);
});

test('start checks immediately, schedules once, and stop clears the timer and aborts its request', async t => {
  const entered = deferred();
  let signal;
  const f = fixture(t, {
    fetchImpl: (_url, options) => new Promise((resolve, reject) => {
      signal = options.signal;
      signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
      entered.resolve();
    }),
  });
  f.service.start();
  f.service.start();
  await entered.promise;
  const pending = f.service.check();
  assert.equal(f.timers.length, 1);
  assert.ok(f.timers[0].interval > 0);
  f.service.stop();
  await pending;
  assert.equal(signal.aborted, true);
  assert.deepEqual(f.clearedTimers, [f.timers[0]]);
  assert.equal(f.notifications.length, 0);
  assert.equal(f.service.state().checking, false);
});

test('the automatic timer checks again when the successful check interval expires', async t => {
  let calls = 0;
  const updated = deferred();
  const f = fixture(t, {
    fetchImpl: async () => response(release(++calls === 1 ? '0.9.0' : '0.10.0')),
    onChange: state => {
      if (!state.checking && state.latestVersion === '0.10.0') updated.resolve();
    },
  });
  f.service.start();
  await f.service.check();
  assert.equal(calls, 1);
  f.advance(CHECK_INTERVAL_MS);
  f.timers[0].callback();
  await updated.promise;
  assert.equal(calls, 2);
  assert.equal(f.service.state().latestVersion, '0.10.0');
});

test('external Portal overrides unconfigured and stale update metadata without probing it', async t => {
  let portal = {status:'external'};
  let reads=0;
  const {service} = fixture(t,{getPortal:()=>portal,readVersion:async()=>{reads++;return '0.8.0';}});
  service._state={status:'available',currentVersion:'0.1.0',latestVersion:'0.8.0',available:true};
  const external=await service.check({force:true});
  assert.equal(external.status,'external');
  assert.equal(external.currentVersion,'');
  assert.equal(external.available,false);
  assert.equal(reads,0);
  portal={status:'stopped'};
  assert.notEqual(service.state().status,'external');
});
