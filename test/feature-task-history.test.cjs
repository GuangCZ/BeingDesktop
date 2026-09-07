'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createCipheriv, createDecipheriv, randomBytes, randomUUID, createHash} = require('node:crypto');
const {FeatureTaskHistory} = require('../src/feature-task-history.cjs');

function encryptedStorage() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
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
  const result = await fs.mkdtemp(path.join(base, 'feature-task-history-test-'));
  t.after(async () => {
    const resolved = path.resolve(result);
    assert.equal(path.dirname(resolved), base);
    assert(path.basename(resolved).startsWith('feature-task-history-test-'));
    await fs.rm(resolved, {recursive: true, force: true});
  });
  return result;
}

function record(beingId = 'cz_being') {
  const requestId = randomUUID();
  return {requestId, route: '/api/bonfire/hear', beingId, prompt: `[Being Desktop Town sync:${requestId}]\nRaw private prompt goes here.`};
}

const begin = history => history.ledger.begin({feature: 'bonfire', operation: 'read', title: '读取篝火', execution: 'being'});

test('encrypts owned requests and ledger atomically, restores interrupted reads for user review', async t => {
  const dir = await directory(t), safeStorage = encryptedStorage(), events = [];
  const first = new FeatureTaskHistory({identityKey: 'persist:first', directory: dir, safeStorage, onChange: event => events.push(event)});
  await first.restore();
  const task = begin(first), own = record();
  assert(first.register(own));
  first.ledger.update(task.id, {requestId: own.requestId, detail: '读取中'});
  assert.equal(await first.flush(), true);
  const raw = await fs.readFile(first.filePath);
  assert(!raw.includes(Buffer.from('Raw private prompt')));
  assert(!raw.includes(Buffer.from('读取篝火')));
  assert.deepEqual((await fs.readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  assert.equal(path.basename(first.filePath), createHash('sha256').update('persist:first').digest('hex') + '.bin');
  assert(events.every(event => Object.keys(event).every(key => ['tasks', 'persistenceError'].includes(key))));
  assert(!JSON.stringify(events).includes('Raw private prompt'));
  const second = new FeatureTaskHistory({identityKey: 'persist:first', directory: dir, safeStorage});
  await second.restore();
  assert.equal(second.ledger.get(task.id).status, 'needs_input');
  assert.match(second.ledger.get(task.id).detail, /不会自动重发/);
  assert.equal(second.records[0].requestId, own.requestId);
  assert.equal(second.records[0].prompt, own.prompt.replace(/\s+/g, ' '));
});

test('different identities have different encrypted files and exact isolation', async t => {
  const dir = await directory(t), safeStorage = encryptedStorage();
  const a = new FeatureTaskHistory({identityKey: 'identity-a', directory: dir, safeStorage});
  const b = new FeatureTaskHistory({identityKey: 'identity-b', directory: dir, safeStorage});
  await Promise.all([a.restore(), b.restore()]);
  const taskA = begin(a), taskB = begin(b);
  a.ledger.complete(taskA.id, {summary: 'A'}); b.ledger.complete(taskB.id, {summary: 'B'});
  await Promise.all([a.flush(), b.flush()]);
  assert.notEqual(a.filePath, b.filePath);
  const againA = new FeatureTaskHistory({identityKey: 'identity-a', directory: dir, safeStorage});
  const againB = new FeatureTaskHistory({identityKey: 'identity-b', directory: dir, safeStorage});
  await Promise.all([againA.restore(), againB.restore()]);
  assert.equal(againA.ledger.get(taskA.id).summary, 'A');
  assert.equal(againA.ledger.get(taskB.id), null);
  assert.equal(againB.ledger.get(taskB.id).summary, 'B');
});

test('corrupt or foreign ciphertext is never replaced after failed restore', async t => {
  const dir = await directory(t), safeStorage = encryptedStorage();
  for (const kind of ['corrupt', 'foreign', 'schema']) {
    const history = new FeatureTaskHistory({identityKey: `identity-${kind}`, directory: dir, safeStorage});
    const original = kind === 'corrupt' ? Buffer.from('corrupt ciphertext') : safeStorage.encryptString(JSON.stringify({version: 1, identityKey: kind === 'foreign' ? 'other' : history.identityKey, ledger: {version: 1, identityKey: history.identityKey, records: []}, ...(kind === 'schema' ? {} : {records: []})}));
    await fs.writeFile(history.filePath, original);
    await history.restore();
    begin(history); history.register(record());
    assert.equal(await history.flush(), false);
    assert.equal(history.persistenceError, true);
    assert.deepEqual(await fs.readFile(history.filePath), original);
  }
});

test('unavailable encryption keeps records in memory and writes no plaintext', async t => {
  const dir = await directory(t);
  let encryptionCalls = 0;
  const history = new FeatureTaskHistory({identityKey: 'locked', directory: dir, safeStorage: {isEncryptionAvailable: () => false, encryptString() {encryptionCalls++; return Buffer.from('plaintext');}}});
  await history.restore();
  const task = begin(history); history.register(record());
  assert.equal(await history.flush(), false);
  assert.equal(history.ledger.get(task.id).status, 'running');
  assert.equal(encryptionCalls, 0);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('an encryption failure preserves the last complete encrypted version', async t => {
  const dir = await directory(t), safeStorage = encryptedStorage();
  const history = new FeatureTaskHistory({identityKey: 'encrypt-failure', directory: dir, safeStorage});
  await history.restore();
  const task = begin(history); await history.flush();
  const original = await fs.readFile(history.filePath);
  safeStorage.encryptString = () => {throw new Error('Credential acquisition failed');};
  history.ledger.complete(task.id, {summary: 'Completed in memory'});
  assert.equal(await history.flush(), false);
  assert.deepEqual(await fs.readFile(history.filePath), original);
  assert.deepEqual((await fs.readdir(dir)).filter(name => name.endsWith('.tmp')), []);
});

test('serialized saves retain the latest mutation even while the prior write is pending', async t => {
  const dir = await directory(t), safeStorage = encryptedStorage();
  const history = new FeatureTaskHistory({identityKey: 'latest', directory: dir, safeStorage});
  await history.restore();
  const encrypt = safeStorage.encryptString;
  let encryptions = 0;
  safeStorage.encryptString = value => {
    encryptions++;
    if (encryptions === 1) queueMicrotask(() => {history.ledger.complete(task.id, {summary: 'The final result'});});
    return encrypt(value);
  };
  const task = begin(history);
  for (let i = 0; i < 30; i++) history.ledger.update(task.id, {detail: `Progress ${i}`});
  await history.flush();
  assert.equal(encryptions, 2);
  const second = new FeatureTaskHistory({identityKey: 'latest', directory: dir, safeStorage}); await second.restore();
  assert.equal(second.ledger.get(task.id).status, 'succeeded');
  assert.equal(second.ledger.get(task.id).summary, 'The final result');
  assert.deepEqual((await fs.readdir(dir)).filter(name => name.endsWith('.tmp')), []);
});

test('registration uses exact normalized owned records, rejects getters and is capped at 256', async t => {
  const dir = await directory(t), safeStorage = encryptedStorage();
  const history = new FeatureTaskHistory({identityKey: 'records', directory: dir, safeStorage}); await history.restore();
  const own = record();
  assert(history.register(own)); assert(history.register(own));
  assert.equal(history.records.length, 1);
  assert.equal(history.register({...own, route: '/api/chat/stream'}), false);
  let invoked = 0;
  const unsafe = {...own}; Object.defineProperty(unsafe, 'prompt', {get() {invoked++; throw new Error('Getter invoked');}});
  assert.equal(history.register(unsafe), false); assert.equal(invoked, 0);
  assert.equal(history.register({...own, beingId: 'another'}), false);
  assert.equal(history.records.length, 0);
  for (let i = 0; i < 258; i++) history.register(record());
  assert.equal(history.records.length, 256);
  const copy = history.records; copy[0].prompt = 'changed';
  assert.notEqual(history.records[0].prompt, 'changed');
  await history.flush();
});

test('same history restore is idempotent and callback failures do not interrupt work', async t => {
  const dir = await directory(t), safeStorage = encryptedStorage();
  const history = new FeatureTaskHistory({identityKey: 'idempotent', directory: dir, safeStorage, onChange() {throw new Error('Observer failed');}});
  await Promise.all([history.restore(), history.restore()]);
  const ledger = history.ledger, task = begin(history);
  await history.restore();
  assert.equal(history.ledger, ledger);
  assert.equal(history.ledger.get(task.id).status, 'running');
  assert.equal(await history.flush(), true);
});

test('a changed ledger identity cannot overwrite the original account history', async t => {
  const dir = await directory(t), safeStorage = encryptedStorage();
  const history = new FeatureTaskHistory({identityKey: 'identity-original', directory: dir, safeStorage}); await history.restore();
  begin(history); await history.flush();
  const original = await fs.readFile(history.filePath);
  history.ledger.reset({identityKey: 'identity-other'});
  assert.equal(await history.flush(), false);
  assert.deepEqual(await fs.readFile(history.filePath), original);
});

test('unsafe identities never become filesystem paths', async t => {
  const dir = await directory(t);
  for (const identityKey of ['', '../other', 'a/b', 'a\\b', 'a'.repeat(129)]) assert.throws(() => new FeatureTaskHistory({identityKey, directory: dir, safeStorage: encryptedStorage()}), /identity/);
});
