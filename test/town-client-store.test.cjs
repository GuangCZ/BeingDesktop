'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const {TownClientStore} = require('../src/town-client-store.cjs');
const key = crypto.randomBytes(32);
const safeStorage = {isEncryptionAvailable: () => true,
  encryptString(value) {const iv = crypto.randomBytes(16), c = crypto.createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([iv, c.update(value), c.final()]);},
  decryptString(bytes) {const d = crypto.createDecipheriv('aes-256-cbc', key, bytes.subarray(0, 16)); return Buffer.concat([d.update(bytes.subarray(16)), d.final()]).toString();}};
test('client token store encrypts, isolates connection identities, persists restart and removes locally', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'town-sdk-')); t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const store = new TownClientStore({directory, safeStorage}), token = 'a'.repeat(64);
  await store.save('key-a', 'alice', token);
  const file = path.join(directory, (await fs.readdir(directory))[0]), wire = await fs.readFile(file, 'utf8');
  assert.equal(wire.includes(token), false); assert.equal(wire.includes('alice'), false);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(await new TownClientStore({directory, safeStorage}).load('key-a', 'alice'), token);
  assert.equal(await store.load('key-a', 'bob'), null); assert.equal(await store.load('key-b', 'alice'), null);
  await fs.copyFile(file, store._file('key-b')); assert.equal(await store.load('key-b', 'alice'), null);
  await store.remove('key-a'); assert.equal(await store.load('key-a', 'alice'), null);
});
test('unavailable and plaintext backends never persist client tokens', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'town-sdk-')); t.after(() => fs.rm(directory, {recursive: true, force: true}));
  for (const storage of [{...safeStorage, isEncryptionAvailable: () => false}, {...safeStorage, getSelectedStorageBackend: () => 'basic_text'}]) {
    const store = new TownClientStore({directory, safeStorage: storage}); await assert.rejects(store.save('key', 'alice', 'a'.repeat(64)), {code: 'AUTH_REQUIRED'});
  }
  assert.deepEqual(await fs.readdir(directory), []);
});
