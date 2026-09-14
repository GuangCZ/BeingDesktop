'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { PortalInstaller, PORTAL_RELEASE, isAllowedPortalAssetUrl } = require('../src/portal-installer.cjs');

const body = Buffer.alloc(PORTAL_RELEASE.size, 0x42);
// This dependency isolates filesystem publishing tests; real SHA-256 rejection is tested separately.
function acceptedHash() {
  let length = 0;
  return { update(chunk) { length += chunk.length; }, digest() { assert.equal(length, body.length); return PORTAL_RELEASE.sha256; } };
}

function fakeTransport(steps) {
  const requests = [];
  const requestImpl = (url, options, callback) => {
    requests.push({ url: url.toString(), options });
    const request = new EventEmitter();
    request.destroy = error => request.emit('error', error);
    request.end = () => queueMicrotask(() => {
      const step = steps.shift();
      if (!step || step.error) { request.emit('error', new Error(step?.error || 'Unexpected request')); return; }
      const response = Readable.from(step.chunks || [step.body || Buffer.alloc(0)]);
      response.statusCode = step.statusCode ?? 200;
      response.headers = step.headers || {};
      callback(response);
    });
    return request;
  };
  return { requestImpl, requests };
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'being-portal-install-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('being-portal-install-test-'));
    return fs.rm(root, { recursive: true, force: true });
  });
  const installer = new PortalInstaller({ userDataDir: root, platform:'win32', arch:'x64', release:{...PORTAL_RELEASE,apiUrl:undefined}, ...options });
  return { root, installer };
}

test('release is fixed to the verified official Windows v0.8.3 asset', () => {
  assert.equal(PORTAL_RELEASE.url, 'https://github.com/d5z/heart-portal/releases/download/v0.8.3/heart-portal-windows-x86_64.exe');
  assert.equal(PORTAL_RELEASE.size, 12004864);
  assert.equal(PORTAL_RELEASE.sha256, '5aec4a09bada241ebba3d8335042cc47cc552f4ff66e831ad5f0d370bab88032');
  assert.equal(Object.isFrozen(PORTAL_RELEASE), true);
});

test('redirect URL policy permits only HTTPS GitHub asset hosts without userinfo', () => {
  for (const value of ['https://github.com/asset', 'https://release-assets.githubusercontent.com/asset?signature=fixed-fixture',
    'https://objects.githubusercontent.com/asset', 'https://github-releases.githubusercontent.com/asset']) {
    assert.equal(isAllowedPortalAssetUrl(value), true);
  }
  for (const value of ['http://github.com/asset', 'file:///asset', 'https://github.com.evil.test/asset',
    'https://evil.test/asset', 'https://user:pass@github.com/asset', 'https://github.com:444/asset',
    'https://127.0.0.1/asset', 'not a URL']) assert.equal(isAllowedPortalAssetUrl(value), false);
});

test('inspection of an empty installation performs no writes or downloads', async t => {
  const transport = fakeTransport([]);
  const { root, installer } = await fixture(t, transport);
  const result = await installer.inspect();
  assert.equal(result.status, 'not_installed');
  assert.equal(result.started, false);
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(transport.requests.length, 0);
});

test('verified download publishes atomically, reports safe phases, and is idempotent', async t => {
  const transport = fakeTransport([{ headers: { 'content-length': String(body.length) }, body }]);
  const { root, installer } = await fixture(t, { ...transport, createHashImpl: acceptedHash });
  const events = [];
  const result = await installer.install({ onProgress: event => events.push(event) });
  assert.equal(result.status, 'installed');
  assert.equal(result.verified, true);
  assert.equal(result.started, false);
  assert.equal(result.executable, path.join(root, 'managed-portal', 'v0.8.3', 'heart-portal.exe'));
  assert.deepEqual(await fs.readFile(result.executable), body);
  assert.deepEqual([...new Set(events.map(event => event.phase))], ['download', 'hash', 'install', 'not_started']);
  for (const event of events) assert.deepEqual(Object.keys(event).sort(), ['phase', 'receivedBytes', 'totalBytes']);
  assert.deepEqual(await fs.readdir(path.dirname(result.executable)), ['heart-portal.exe']);
  assert.equal((await installer.install()).verified, true);
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0].url, PORTAL_RELEASE.url);
  assert.equal(transport.requests[0].options.method, 'GET');
  assert.deepEqual(Object.keys(transport.requests[0].options.headers).sort(), ['Accept', 'User-Agent']);
});

test('concurrent calls on one installer share one download', async t => {
  const transport = fakeTransport([{ body }]);
  const { installer } = await fixture(t, { ...transport, createHashImpl: acceptedHash });
  const a = installer.install();
  const b = installer.install();
  assert.equal(a, b);
  assert.equal((await a).verified, true);
  assert.equal(transport.requests.length, 1);
});

test('same-size corrupted existing binary is not treated as installed', async t => {
  const transport = fakeTransport([]);
  const { installer } = await fixture(t, transport);
  await fs.mkdir(installer.versionDir, { recursive: true });
  await fs.writeFile(installer.executable, body);
  assert.equal((await installer.inspect()).status, 'invalid');
  assert.equal(transport.requests.length, 0);
});

test('real SHA-256 mismatch preserves existing file and removes only its own temporary download', async t => {
  const transport = fakeTransport([{ body }]);
  const { installer } = await fixture(t, transport);
  await fs.mkdir(installer.versionDir, { recursive: true });
  await fs.writeFile(installer.executable, 'old-invalid-binary');
  await fs.writeFile(path.join(installer.versionDir, 'unrelated.tmp'), 'keep');
  await assert.rejects(installer.install(), /校验失败/);
  assert.equal(await fs.readFile(installer.executable, 'utf8'), 'old-invalid-binary');
  assert.deepEqual((await fs.readdir(installer.versionDir)).sort(), ['heart-portal.exe', 'unrelated.tmp']);
});

test('short and oversized bodies never publish an executable', async t => {
  for (const badBody of [Buffer.alloc(20), Buffer.alloc(PORTAL_RELEASE.size + 1)]) {
    const { installer } = await fixture(t, fakeTransport([{ body: badBody }]));
    await assert.rejects(installer.install(), /不完整|大小限制/);
    assert.deepEqual(await fs.readdir(installer.versionDir), []);
  }
});

test('invalid content lengths and HTTP failures are rejected before publication', async t => {
  for (const step of [{ statusCode: 403 }, { headers: { 'content-length': 'unknown' } },
    { headers: { 'content-length': String(PORTAL_RELEASE.size + 1) } }]) {
    const { installer } = await fixture(t, fakeTransport([step]));
    await assert.rejects(installer.install(), /下载/);
    assert.deepEqual(await fs.readdir(installer.versionDir), []);
  }
});

test('signed asset redirects are followed without exposing their URL in progress', async t => {
  const privateUrl = 'https://release-assets.githubusercontent.com/asset?signature=fixture-private';
  const transport = fakeTransport([{ statusCode: 302, headers: { location: privateUrl } }, { body }]);
  const { installer } = await fixture(t, { ...transport, createHashImpl: acceptedHash });
  const events = [];
  await installer.install({ onProgress: event => events.push(event) });
  assert.equal(transport.requests.length, 2);
  assert.doesNotMatch(JSON.stringify(events), /signature|private|https/);
});

test('untrusted redirects and loops fail without touching unrelated destinations', async t => {
  for (const location of ['https://evil.test/asset?token=fixture-secret', 'file:///C:/asset', 'http://github.com/asset']) {
    const transport = fakeTransport([{ statusCode: 302, headers: { location } }]);
    const { installer } = await fixture(t, transport);
    await assert.rejects(installer.install(), { message: 'Portal 下载跳转无效。' });
    assert.equal(transport.requests.length, 1);
  }
  const transport = fakeTransport(Array.from({ length: 6 }, () => ({ statusCode: 302, headers: { location: PORTAL_RELEASE.url } })));
  const { installer } = await fixture(t, transport);
  await assert.rejects(installer.install(), /跳转无效/);
  assert.equal(transport.requests.length, 5);
});

test('transport errors never expose request URLs or caller-controlled error text', async t => {
  const { installer } = await fixture(t, fakeTransport([{ error: 'https://private.test/?token=fixture-secret' }]));
  await assert.rejects(installer.install(), { message: 'Portal 下载失败，请检查网络后重试。' });
  assert.deepEqual(await fs.readdir(installer.versionDir), []);
});

test('invalid paths and directory links cannot redirect installer writes', async t => {
  for (const userDataDir of [undefined, '.', 'relative', 'bad\0path']) assert.throws(() => new PortalInstaller({ userDataDir }));
  const { root, installer } = await fixture(t, fakeTransport([]));
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, installer.managedDir, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installer.install(), /安装失败/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('a directory at the binary path is retained and rejected', async t => {
  const { installer } = await fixture(t, fakeTransport([]));
  await fs.mkdir(installer.executable, { recursive: true });
  await fs.writeFile(path.join(installer.executable, 'keep.txt'), 'keep');
  await assert.rejects(installer.install(), /安装目标/);
  assert.equal(await fs.readFile(path.join(installer.executable, 'keep.txt'), 'utf8'), 'keep');
});

test('progress observer failures do not interrupt a verified installation', async t => {
  const { installer } = await fixture(t, { ...fakeTransport([{ body }]), createHashImpl: acceptedHash });
  assert.equal((await installer.install({ onProgress() { throw new Error('observer'); } })).verified, true);
});

test('cached official asset passes real SHA-256 download and repeat-inspection checks without execution', async t => {
  const cached = path.resolve(__dirname, '../.local/portal-test/heart-portal-v0.8.3-windows-x86_64.exe');
  let officialBody;
  try { officialBody = await fs.readFile(cached); }
  catch (error) {
    if (error.code === 'ENOENT') { t.skip('Optional previously verified official asset is not cached.'); return; }
    throw error;
  }
  const transport = fakeTransport([{ body: officialBody }]);
  const { installer } = await fixture(t, transport);
  assert.equal((await installer.install()).verified, true);
  assert.equal((await installer.inspect()).verified, true);
  assert.equal((await installer.install()).verified, true);
  assert.equal(transport.requests.length, 1);
});

test('official API asset endpoint is a verified fallback when the release host fails',async t=>{
  const transport=fakeTransport([{error:'unreachable'},{body}]);
  const {installer}=await fixture(t,{...transport,release:PORTAL_RELEASE,createHashImpl:acceptedHash});
  assert.equal((await installer.install()).verified,true);
  assert.deepEqual(transport.requests.map(item=>item.url),[PORTAL_RELEASE.url,PORTAL_RELEASE.apiUrl]);
});
test('cancelled download removes staging bytes and does not try another endpoint',async t=>{
  const transport=fakeTransport([{body}]),controller=new AbortController();controller.abort();
  const {installer}=await fixture(t,{...transport,release:PORTAL_RELEASE});
  await assert.rejects(installer.install({signal:controller.signal}),/取消/);
  assert.equal(transport.requests.length,0);assert.deepEqual(await fs.readdir(installer.versionDir),[]);
});
