'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createCipheriv, createDecipheriv, createHash, randomBytes} = require('node:crypto');
const {BonfireCache} = require('../src/bonfire-cache.cjs');

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

async function directory(t) {
  const base = path.resolve(__dirname, '../.local');
  await fs.mkdir(base, {recursive: true});
  const result = await fs.mkdtemp(path.join(base, 'bonfire-cache-test-'));
  t.after(async () => {
    const resolved = path.resolve(result);
    assert.equal(path.dirname(resolved), base);
    assert.ok(path.basename(resolved).startsWith('bonfire-cache-test-'));
    await fs.rm(resolved, {recursive: true, force: true});
  });
  return result;
}

function snapshot(content = 'Previously fetched Bonfire message', latestSeq = 1) {
  return {messages: [{id: String(latestSeq), beingId: 'echo', beingName: 'Echo', content, createdAt: '2026-09-07', revisedAt: '', mentions: []}],
    latestSeq, capturedAt: 1788750000000 + latestSeq, revision: `manual:${latestSeq}`, manual: true};
}

const filename = (directory, key) => path.join(directory, createHash('sha256').update(key).digest('hex') + '.bin');

test('persisted Being relay snapshots retain their unverified source label', async t => {
  const dir = await directory(t), safeStorage = encryptedStorage();
  const cache = new BonfireCache({directory: dir, safeStorage});
  const value = {...snapshot(), source: 'being_relay'};
  assert.equal(await cache.save('relay-test', value), true);
  assert.deepEqual(await new BonfireCache({directory: dir, safeStorage}).load('relay-test'), value);
});

test('encrypted snapshots survive a new store instance without exposing message text', async t => {
  const dir = await directory(t), safeStorage = encryptedStorage(), identityKey = 'persist:being-alice';
  const first = new BonfireCache({directory: dir, safeStorage});
  assert.equal(await first.load(identityKey), null);
  const expected = snapshot();
  assert.equal(await first.save(identityKey, expected), true);
  assert.equal(await first.flush(), true);
  const raw = await fs.readFile(filename(dir, identityKey));
  assert.ok(!raw.includes(Buffer.from(expected.messages[0].content)));
  assert.deepEqual(await fs.readdir(dir), [path.basename(filename(dir, identityKey))]);
  const second = new BonfireCache({directory: dir, safeStorage});
  assert.deepEqual(await second.load(identityKey), expected);
  const loaded = await second.load(identityKey);
  loaded.messages[0].content = 'Mutated caller copy';
  assert.deepEqual(await second.load(identityKey), expected);
});

test('identities are isolated and a file copied under a different key is rejected', async t => {
  const dir = await directory(t), safeStorage = encryptedStorage(), cache = new BonfireCache({directory: dir, safeStorage});
  await Promise.all([cache.save('persist:being-alice', snapshot('Alice cache')), cache.save('persist:being-bob', snapshot('Bob cache'))]);
  assert.equal((await cache.load('persist:being-alice')).messages[0].content, 'Alice cache');
  assert.equal((await cache.load('persist:being-bob')).messages[0].content, 'Bob cache');
  await fs.copyFile(filename(dir, 'persist:being-alice'), filename(dir, 'persist:being-carol'));
  assert.equal(await cache.load('persist:being-carol'), null);
  assert.equal(await cache.load('persist:being-other'), null);
});

test('corruption, invalid schema and oversized files are cache misses', async t => {
  const dir = await directory(t), safeStorage = encryptedStorage(), cache = new BonfireCache({directory: dir, safeStorage}), identityKey = 'persist:being-alice';
  const file = filename(dir, identityKey);
  await fs.writeFile(file, Buffer.from('Broken ciphertext'));
  assert.equal(await cache.load(identityKey), null);
  for (const value of [{...snapshot(), latestSeq: -1}, {...snapshot(), capturedAt: 'yesterday'}, {...snapshot(), messages: [{id: '1', content: 123}]}]) {
    await fs.writeFile(file, safeStorage.encryptString(JSON.stringify({version: 1, identityKey, snapshot: value})));
    assert.equal(await cache.load(identityKey), null);
  }
  await fs.truncate(file, 8 * 1024 * 1024 + 1);
  assert.equal(await cache.load(identityKey), null);
  assert.equal(await cache.save(identityKey, snapshot('Recovered cache')), true);
  assert.equal((await cache.load(identityKey)).messages[0].content, 'Recovered cache');
});

test('unavailable encryption never falls back to a plaintext file', async t => {
  const dir = await directory(t);
  const cache = new BonfireCache({directory: dir, safeStorage: {isEncryptionAvailable: () => false}});
  assert.equal(await cache.save('persist:being-alice', snapshot()), false);
  assert.equal(await cache.load('persist:being-alice'), null);
  assert.equal(await cache.flush(), false);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('concurrent writes keep the last submitted snapshot and snapshot the caller value', async t => {
  const dir = await directory(t), cache = new BonfireCache({directory: dir, safeStorage: encryptedStorage()});
  const pending = [];
  for (let count = 1; count <= 12; count++) pending.push(cache.save('persist:being-alice', snapshot(`Version ${count}`, count)));
  const expected = snapshot('Final version', 13);
  pending.push(cache.save('persist:being-alice', expected));
  expected.messages[0].content = 'Mutation after save';
  assert.deepEqual(await cache.load('persist:being-alice'), snapshot('Final version', 13));
  assert.equal(await cache.flush(), true);
  assert.ok((await Promise.all(pending)).every(Boolean));
  assert.deepEqual(await cache.load('persist:being-alice'), snapshot('Final version', 13));
  assert.ok((await fs.readdir(dir)).every(file => !file.endsWith('.tmp')));
});

test('a failed save preserves the previous file and a later save can recover', async t => {
  const dir = await directory(t), safeStorage = encryptedStorage(), cache = new BonfireCache({directory: dir, safeStorage}), identityKey = 'persist:being-alice';
  await cache.save(identityKey, snapshot('Previous version'));
  const file = filename(dir, identityKey), original = await fs.readFile(file), encrypt = safeStorage.encryptString;
  safeStorage.encryptString = () => { throw new Error('Encryption failed'); };
  assert.equal(await cache.save(identityKey, snapshot('Unsaved version', 2)), false);
  assert.equal(await cache.flush(), false);
  assert.deepEqual(await fs.readFile(file), original);
  assert.equal((await cache.load(identityKey)).messages[0].content, 'Previous version');
  safeStorage.encryptString = encrypt;
  assert.equal(await cache.save(identityKey, snapshot('Recovered version', 3)), true);
  assert.equal(await cache.flush(), true);
  assert.equal((await cache.load(identityKey)).messages[0].content, 'Recovered version');
});

test('a failed atomic replacement retains the previous snapshot and removes its temporary file', async t => {
  const dir = await directory(t), cache = new BonfireCache({directory: dir, safeStorage: encryptedStorage()}), identityKey = 'persist:being-alice';
  await cache.save(identityKey, snapshot('Last complete snapshot'));
  const original = await fs.readFile(filename(dir, identityKey));
  const rename = t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('Replacement failed'), {code: 'EACCES'}); });
  assert.equal(await cache.save(identityKey, snapshot('Incomplete replacement', 2)), false);
  rename.mock.restore();
  assert.deepEqual(await fs.readFile(filename(dir, identityKey)), original);
  assert.ok((await fs.readdir(dir)).every(file => !file.endsWith('.tmp')));
  assert.equal((await cache.load(identityKey)).messages[0].content, 'Last complete snapshot');
});

test('authoritative empty snapshots persist and malformed values do not overwrite them', async t => {
  const dir = await directory(t), cache = new BonfireCache({directory: dir, safeStorage: encryptedStorage()}), identityKey = 'persist:being-alice';
  const empty = {...snapshot(), messages: [], latestSeq: 0};
  assert.equal(await cache.save(identityKey, empty), true);
  for (const value of [{...snapshot(), messages: Array.from({length: 501}, () => snapshot().messages[0])}, snapshot('x'.repeat(32001)), {...snapshot(), revision: 'invalid\nrevision'}, {...snapshot(), messages: [{...snapshot().messages[0], replyTo: {id: 'p', beingId: 'x'.repeat(101), preview: ''}}]}]) {
    assert.equal(await cache.save(identityKey, value), false);
  }
  assert.equal(await cache.save('', snapshot()), false);
  assert.equal(await cache.load('invalid\nkey'), null);
  assert.deepEqual(await cache.load(identityKey), empty);
});
