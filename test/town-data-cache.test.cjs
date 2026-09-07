'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createCipheriv, createDecipheriv, createHash, randomBytes} = require('node:crypto');
const {TownDataCache} = require('../src/town-data-cache.cjs');

const identity = 'persist:being-example';
const resource = 'getFiresideMessages:{"id":"example","limit":100}';
const capturedAt = 1788750000000;
const hash = value => createHash('sha256').update(value).digest('hex');
const filename = (directory, identityKey = identity, resourceKey = resource) => path.join(directory, hash(identityKey), `${hash(resourceKey)}.bin`);
const miss = {cached: false, data: null, lastSuccessAt: null};
const restored = data => ({cached: true, data, lastSuccessAt: capturedAt});

function encryptedStorage() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

async function fixture(t, options = {}) {
  const base = path.resolve(__dirname, '../.local');
  await fs.mkdir(base, {recursive: true});
  const directory = await fs.mkdtemp(path.join(base, 'town-data-cache-test-'));
  const safeStorage = options.safeStorage || encryptedStorage();
  const cache = new TownDataCache({directory, safeStorage, clock: () => capturedAt, ...options});
  t.after(async () => {
    await cache.flush();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), base);
    assert.ok(path.basename(resolved).startsWith('town-data-cache-test-'));
    await fs.rm(resolved, {recursive: true, force: true});
  });
  return {directory, safeStorage, cache};
}

test('Town data restores in a new instance with its fetch time and encrypted content', async t => {
  const {directory, safeStorage, cache} = await fixture(t);
  const data = {messages: [{id: '1', content: 'Previously fetched synthetic Fireside message'}], latestSeq: 1};
  assert.deepEqual(await cache.load(identity, resource), miss);
  assert.equal(await cache.save(identity, resource, data), true);
  assert.equal(await cache.flush(), true);
  const raw = await fs.readFile(filename(directory));
  assert.ok(!raw.includes(Buffer.from(data.messages[0].content)));
  assert.ok(!raw.includes(Buffer.from(identity)));
  assert.ok(!raw.includes(Buffer.from(resource)));
  const second = new TownDataCache({directory, safeStorage});
  assert.deepEqual(await second.load(identity, resource), restored(data));
  const loaded = await second.load(identity, resource);
  loaded.data.messages[0].content = 'Mutated caller copy';
  assert.deepEqual(await second.load(identity, resource), restored(data));
});

test('exact identities and resource parameters have isolated cache entries', async t => {
  const {directory, cache} = await fixture(t);
  const otherIdentity = 'persist:being-example-other';
  const otherResource = 'getFiresideMessages:{"id":"another","limit":100}';
  await Promise.all([
    cache.save(identity, resource, {content: 'First room'}),
    cache.save(identity, otherResource, {content: 'Second room'}),
    cache.save(otherIdentity, resource, {content: 'Different account'}),
    cache.save('public', resource, {content: 'Public data'}),
  ]);
  assert.deepEqual(await cache.load(identity, resource), restored({content: 'First room'}));
  assert.deepEqual(await cache.load(identity, otherResource), restored({content: 'Second room'}));
  assert.deepEqual(await cache.load(otherIdentity, resource), restored({content: 'Different account'}));
  assert.deepEqual(await cache.load('public', resource), restored({content: 'Public data'}));
  assert.deepEqual(await cache.load(identity.toUpperCase(), resource), miss);
  await fs.copyFile(filename(directory), filename(directory, identity, otherResource));
  assert.deepEqual(await cache.load(identity, otherResource), miss);
  await fs.copyFile(filename(directory), filename(directory, otherIdentity, resource));
  assert.deepEqual(await cache.load(otherIdentity, resource), miss);
});

test('a load immediately after concurrent saves waits for the newest immutable snapshot', async t => {
  let now = capturedAt;
  const {directory, cache} = await fixture(t, {clock: () => now++});
  const pending = [];
  for (let index = 0; index < 12; index++) pending.push(cache.save(identity, resource, {index}));
  const last = {messages: [{content: 'Last submitted value'}]};
  pending.push(cache.save(identity, resource, last));
  last.messages[0].content = 'Changed after save';
  assert.deepEqual(await cache.load(identity, resource), {cached: true, data: {messages: [{content: 'Last submitted value'}]}, lastSuccessAt: capturedAt + 12});
  assert.ok((await Promise.all(pending)).every(Boolean));
  assert.equal(await cache.flush(), true);
  assert.ok((await fs.readdir(path.dirname(filename(directory)))).every(name => name.endsWith('.bin')));
});

test('valid empty data remains distinguishable from a cache miss', async t => {
  const {cache} = await fixture(t);
  for (const data of [null, false, 0, '', [], {}, {owned: [], joined: []}]) {
    assert.equal(await cache.save(identity, resource, data), true);
    assert.deepEqual(await cache.load(identity, resource), restored(data));
  }
  assert.equal(await cache.save(identity, resource, {value: 1, absent: undefined}), true);
  assert.deepEqual(await cache.load(identity, resource), restored({value: 1}));
});

test('corrupt, oversized and invalid payloads are cache misses and can recover', async t => {
  const {directory, safeStorage, cache} = await fixture(t);
  await cache.save(identity, resource, {valid: true});
  const file = filename(directory);
  await fs.writeFile(file, Buffer.from('Broken ciphertext'));
  assert.deepEqual(await cache.load(identity, resource), miss);
  for (const patch of [{version: 2}, {lastSuccessAt: -1}, {lastSuccessAt: 'yesterday'}, {identityKey: 'other'}, {resourceKey: 'other'}, {data: undefined}]) {
    const payload = {version: 1, identityKey: identity, resourceKey: resource, lastSuccessAt: capturedAt, data: {}, ...patch};
    await fs.writeFile(file, safeStorage.encryptString(JSON.stringify(payload)));
    assert.deepEqual(await cache.load(identity, resource), miss);
  }
  await fs.truncate(file, 8 * 1024 * 1024 + 1);
  assert.deepEqual(await cache.load(identity, resource), miss);
  await fs.writeFile(file, Buffer.alloc(0));
  assert.deepEqual(await cache.load(identity, resource), miss);
  assert.equal(await cache.save(identity, resource, {recovered: true}), true);
  assert.deepEqual(await cache.load(identity, resource), restored({recovered: true}));
});

test('unavailable or broken encryption never writes a plaintext fallback', async t => {
  const {directory, cache} = await fixture(t, {safeStorage: {isEncryptionAvailable: () => false}});
  assert.equal(await cache.save(identity, resource, {content: 'Synthetic private message'}), false);
  assert.deepEqual(await cache.load(identity, resource), miss);
  assert.equal(await cache.flush(), false);
  assert.deepEqual(await fs.readdir(directory), []);
  cache.safeStorage = {isEncryptionAvailable() { throw new Error('Unavailable'); }};
  assert.equal(await cache.save(identity, resource, {}), false);
  assert.deepEqual(await cache.load(identity, resource), miss);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('failed encryption preserves the previous entry and a later save recovers', async t => {
  const {directory, safeStorage, cache} = await fixture(t);
  await cache.save(identity, resource, {version: 1});
  const original = await fs.readFile(filename(directory)), encrypt = safeStorage.encryptString;
  safeStorage.encryptString = () => { throw new Error('Encryption failed'); };
  assert.equal(await cache.save(identity, resource, {version: 2}), false);
  assert.equal(await cache.flush(), false);
  assert.deepEqual(await fs.readFile(filename(directory)), original);
  assert.deepEqual(await cache.load(identity, resource), restored({version: 1}));
  safeStorage.encryptString = encrypt;
  assert.equal(await cache.save(identity, resource, {version: 3}), true);
  assert.equal(await cache.flush(), true);
  assert.deepEqual(await cache.load(identity, resource), restored({version: 3}));
});

test('a failed atomic replacement preserves its previous entry and cleans up the temporary file', async t => {
  const {directory, cache} = await fixture(t);
  await cache.save(identity, resource, {version: 1});
  const original = await fs.readFile(filename(directory));
  const rename = t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('Replacement failed'), {code: 'EACCES'}); });
  assert.equal(await cache.save(identity, resource, {version: 2}), false);
  rename.mock.restore();
  assert.equal(await cache.flush(), false);
  assert.deepEqual(await fs.readFile(filename(directory)), original);
  assert.deepEqual(await fs.readdir(path.dirname(filename(directory))), [path.basename(filename(directory))]);
  assert.deepEqual(await cache.load(identity, resource), restored({version: 1}));
});

test('unsupported data never invokes accessors or replaces a valid entry', async t => {
  const {cache} = await fixture(t);
  await cache.save(identity, resource, {valid: true});
  let called = false;
  const getter = Object.defineProperty({}, 'value', {enumerable: true, get() { called = true; return 'Unsafe'; }});
  const cycle = {};
  cycle.child = cycle;
  let deep = {};
  for (let index = 0; index < 14; index++) deep = {child: deep};
  for (const data of [getter, cycle, deep, new Date(), {toJSON() { called = true; return {}; }}, [undefined], {value: Infinity}, {value: NaN}, {value: 1n}, () => {}, Array(2), Array(10001).fill(0), 'x'.repeat(8 * 1024 * 1024 + 1)]) {
    assert.equal(await cache.save(identity, resource, data), false);
  }
  assert.equal(called, false);
  assert.deepEqual(await cache.load(identity, resource), restored({valid: true}));
  const protoField = JSON.parse('{"__proto__":{"example":true}}');
  assert.equal(await cache.save(identity, resource, protoField), true);
  assert.deepEqual(await cache.load(identity, resource), restored(protoField));
  assert.equal({}.example, undefined);
});

test('invalid keys and clocks fail without creating cache paths', async t => {
  const {directory, cache} = await fixture(t);
  for (const [identityKey, resourceKey] of [['', resource], [identity, ''], ['bad\nidentity', resource], [identity, 'bad\nresource'], ['x'.repeat(257), resource], [identity, 'x'.repeat(32769)]]) {
    assert.equal(await cache.save(identityKey, resourceKey, {}), false);
    assert.deepEqual(await cache.load(identityKey, resourceKey), miss);
    assert.equal(await cache.invalidate(identityKey, resourceKey), false);
  }
  cache.clock = () => -1;
  assert.equal(await cache.save(identity, resource, {}), false);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('invalidation is ordered with saves and isolates other resources', async t => {
  const {cache} = await fixture(t);
  const first = cache.save(identity, resource, {version: 1});
  const other = cache.save(identity, 'other', {version: 2});
  const invalidation = cache.invalidate(identity, resource);
  assert.deepEqual(await cache.load(identity, resource), miss);
  assert.ok((await Promise.all([first, other, invalidation])).every(Boolean));
  assert.deepEqual(await cache.load(identity, 'other'), restored({version: 2}));
  assert.equal(await cache.invalidate(identity, resource), true);
  const remove = cache.invalidate(identity, resource);
  const replacement = cache.save(identity, resource, {version: 3});
  assert.deepEqual(await cache.load(identity, resource), restored({version: 3}));
  assert.ok((await Promise.all([remove, replacement])).every(Boolean));
});

test('each identity retains at most 128 entries and preserves the newly saved resource', async t => {
  const {directory, safeStorage, cache} = await fixture(t);
  await cache.save(identity, resource, {current: true});
  const identityDirectory = path.dirname(filename(directory));
  const old = new Date(capturedAt - 1000);
  await Promise.all(Array.from({length: 130}, async (_, index) => {
    const resourceKey = `old-resource:${index}`, file = filename(directory, identity, resourceKey);
    await fs.writeFile(file, safeStorage.encryptString(JSON.stringify({version: 1, identityKey: identity, resourceKey, lastSuccessAt: capturedAt, data: {index}})));
    await fs.utimes(file, old, old);
  }));
  await cache.save('public', resource, {unrelated: true});
  assert.equal(await cache.save(identity, resource, {current: 'refreshed'}), true);
  assert.equal((await fs.readdir(identityDirectory)).length, 128);
  assert.deepEqual(await cache.load(identity, resource), restored({current: 'refreshed'}));
  assert.deepEqual(await cache.load('public', resource), restored({unrelated: true}));
});

test('each identity keeps encrypted entry bytes below the disk budget', async t => {
  const {directory, cache} = await fixture(t);
  await cache.save(identity, resource, {current: true});
  const identityDirectory = path.dirname(filename(directory));
  const old = new Date(capturedAt - 1000);
  await Promise.all(Array.from({length: 9}, async (_, index) => {
    const file = filename(directory, identity, `old-resource:${index}`);
    await fs.writeFile(file, Buffer.alloc(0));
    await fs.truncate(file, 8 * 1024 * 1024);
    await fs.utimes(file, old, old);
  }));
  assert.equal(await cache.save(identity, resource, {current: 'refreshed'}), true);
  const stats = await Promise.all((await fs.readdir(identityDirectory)).map(name => fs.stat(path.join(identityDirectory, name))));
  assert.ok(stats.reduce((sum, stat) => sum + stat.size, 0) <= 64 * 1024 * 1024);
  assert.deepEqual(await cache.load(identity, resource), restored({current: 'refreshed'}));
});
