'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {restoreOnboarding, validateOnboardingStep, saveOnboardingStep, completeOnboardingAfterBonfire} = require('../src/onboarding.cjs');

test('empty profiles start with Loom even if desktop preferences have been saved', () => {
  for (const settings of [undefined, {}, {credential: '', workspace: '', portalExecutable: '', portalConfig: ''},
    {closeToTray: false, typography: {chatFontSize: 16, codeFontSize: 14}}]) {
    assert.deepEqual(restoreOnboarding(settings), {step: 'loom', completed: false});
  }
});

test('legacy profiles with an existing connection, workspace, or Portal skip the guide', () => {
  for (const settings of [{credential: 'encrypted-value'}, {workspace: 'C:\\workspace'},
    {portalExecutable: 'C:\\heart-portal.exe'}, {portalConfig: 'C:\\portal.toml'},
    {managedPortal: {workspace: 'C:\\workspace'}}]) {
    assert.deepEqual(restoreOnboarding(settings), {step: 'complete', completed: true});
  }
});

test('saved progress wins over legacy migration and exposes only canonical public fields', () => {
  for (const step of ['loom', 'review', 'portal', 'channel', 'grove', 'town', 'bonfire', 'complete']) {
    const settings = {credential: 'encrypted-value', onboarding: {step,
      completed: step !== 'complete', url: 'https://example.test/?token=secret', token: 'secret'}};
    assert.deepEqual(restoreOnboarding(settings), {step, completed: step === 'complete'});
    assert.equal(settings.onboarding.token, 'secret');
  }
});

test('malformed stored steps recover according to the existing profile', () => {
  for (const onboarding of [null, false, 3, 'complete', [], {}, {step: 'unknown'}, {completed: true}]) {
    assert.deepEqual(restoreOnboarding({onboarding}), {step: 'loom', completed: false});
    assert.deepEqual(restoreOnboarding({onboarding, credential: 'encrypted-value'}), {step: 'complete', completed: true});
  }
});

test('missing or locked credentials return unfinished guides to Loom while completed guides stay complete', () => {
  for (const credential of ['', 'unavailable-encrypted-value']) {
    for (const step of ['loom', 'review', 'portal', 'channel', 'grove', 'town', 'bonfire', 'complete']) {
      const settings = {credential, onboarding: {step, completed: step === 'complete'}};
      assert.deepEqual(restoreOnboarding(settings, {configured: false}),
        step === 'complete' ? {step: 'complete', completed: true} : {step: 'loom', completed: false});
      assert.deepEqual(restoreOnboarding(settings, {configured: true}), {step, completed: step === 'complete'});
    }
  }
});

test('only explicit valid steps can advance and a configured Loom is required after its card', () => {
  for (const value of [undefined, null, false, 0, '', 'PORTAL', ' complete', {}, [], new String('portal')]) {
    assert.throws(() => validateOnboardingStep(value, true), /无效的新手引导步骤/);
  }
  assert.deepEqual(validateOnboardingStep('loom', false), {step: 'loom', completed: false});
  for (const step of ['review', 'portal', 'channel', 'grove', 'town', 'bonfire', 'complete']) {
    for (const configured of [undefined, false, 'true', 1]) {
      assert.throws(() => validateOnboardingStep(step, configured), /请先配置 Loom 连接/);
    }
    assert.deepEqual(validateOnboardingStep(step, true), {step, completed: step === 'complete'});
  }
});

test('a new connection retains Loom progress and each later step resumes from saved settings', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'being-onboarding-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const filename = path.join(directory, 'settings.json');
  const settings = {onboarding: restoreOnboarding(), credential: 'encrypted-value'};
  const persist = () => fs.writeFile(filename, JSON.stringify(settings));
  await persist();
  assert.deepEqual(restoreOnboarding(JSON.parse(await fs.readFile(filename, 'utf8'))), {step: 'loom', completed: false});
  for (const step of ['review', 'portal', 'channel', 'grove', 'town', 'bonfire', 'complete']) {
    const result = await saveOnboardingStep(step, {settings, configured: true, persist});
    const restored = restoreOnboarding(JSON.parse(await fs.readFile(filename, 'utf8')));
    assert.deepEqual(restored, {step, completed: step === 'complete'});
    assert.deepEqual(result, restored);
  }
});

test('failed persistence preserves the previous progress and hides raw storage errors', async () => {
  for (const initial of [undefined, {step: 'portal', completed: false}]) {
    const settings = initial ? {onboarding: initial} : {};
    await assert.rejects(saveOnboardingStep('channel', {settings, configured: true,
      persist: async () => { throw new Error('Storage path contains private profile data'); }}),
    {message: '新手引导进度未能保存，请重试。'});
    assert.equal(settings.onboarding, initial);
    assert.equal(Object.hasOwn(settings, 'onboarding'), initial !== undefined);
  }
});

test('invalid or disconnected mutations leave settings untouched without persisting', async () => {
  const settings = {onboarding: {step: 'loom', completed: false}};
  const before = structuredClone(settings);
  let writes = 0;
  for (const [step, configured] of [['invalid', true], ['portal', false], ['complete', false]]) {
    await assert.rejects(saveOnboardingStep(step, {settings, configured, persist: async () => { writes++; }}));
    assert.deepEqual(settings, before);
  }
  assert.equal(writes, 0);
});

test('a confirmed Bonfire message completes the guide only after progress has persisted', async () => {
  const settings = {onboarding: {step: 'bonfire', completed: false}};
  const receipt = {ok: true, id: '12', mentions: []};
  let finishWrite;
  const pendingWrite = new Promise(resolve => { finishWrite = resolve; });
  let writes = 0, settled = false;
  const completion = completeOnboardingAfterBonfire(receipt, {settings, configured: true, isCurrent: () => true,
    persist: async () => { writes++; await pendingWrite; }});
  void completion.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(writes, 1);
  finishWrite();
  assert.deepEqual(await completion, {...receipt, onboarding: {step: 'complete', completed: true}});
  assert.deepEqual(settings.onboarding, {step: 'complete', completed: true});
  assert.deepEqual(receipt, {ok: true, id: '12', mentions: []});
});

test('missing or uncertain message confirmations cannot complete the guide', async () => {
  for (const receipt of [undefined, null, {}, {ok: false, id: '12', mentions: []},
    {ok: true, mentions: []}, {ok: true, id: '12'}, {ok: true, id: 'pending', mentions: []},
    {ok: true, id: '-1', mentions: []}, {ok: true, id: '9007199254740992', mentions: []}]) {
    const settings = {onboarding: {step: 'bonfire', completed: false}};
    const result = await completeOnboardingAfterBonfire(receipt, {settings, configured: true,
      isCurrent: () => true, persist: async () => assert.fail('Unconfirmed sends cannot persist completion')});
    assert.equal(result, receipt);
    assert.deepEqual(settings.onboarding, {step: 'bonfire', completed: false});
  }
});

test('confirmed messages preserve other steps, completed guides, and changed connections', async () => {
  const receipt = {ok: true, id: '12', mentions: []};
  for (const [step, configured, current] of [['loom', true, true], ['grove', true, true], ['town', true, true],
    ['complete', true, true], ['bonfire', false, true], ['bonfire', true, false]]) {
    const previous = {step, completed: step === 'complete'};
    const settings = {onboarding: previous};
    assert.equal(await completeOnboardingAfterBonfire(receipt, {settings, configured,
      isCurrent: () => current, persist: async () => assert.fail('Unrelated guides cannot be completed')}), receipt);
    assert.equal(settings.onboarding, previous);
  }
});

test('failed completion retains the successful send receipt and can retry saving without resending', async () => {
  const previous = {step: 'bonfire', completed: false};
  const settings = {onboarding: previous};
  const receipt = {ok: true, id: '12', mentions: ['Echo']};
  let writes = 0;
  const result = await completeOnboardingAfterBonfire(receipt, {settings, configured: true, isCurrent: () => true,
    persist: async () => { writes++; throw new Error('private filesystem detail'); }});
  assert.equal(result.ok, true);
  assert.equal(result.id, receipt.id);
  assert.equal(result.mentions, receipt.mentions);
  assert.equal(result.onboarding, undefined);
  assert.match(result.onboardingError, /消息已发送.*重试保存进度.*无需再次发送/);
  assert.doesNotMatch(result.onboardingError, /private filesystem detail/);
  assert.equal(settings.onboarding, previous);
  assert.equal(writes, 1);
  assert.deepEqual(await saveOnboardingStep('complete', {settings, configured: true,
    persist: async () => { writes++; }}), {step: 'complete', completed: true});
  assert.equal(writes, 2);
});

async function bonfireHandlerHarness({send, persist = async () => {}, broadcast = () => {}} = {}) {
  const source = await fs.readFile(path.join(__dirname, '../src/main.cjs'), 'utf8');
  const handlerSource = source.match(/handle\('sendBonfireMessage',([\s\S]*?)\);\r?\n\s*handle\('beginChannelConnection'/)?.[1];
  assert.ok(handlerSource, 'Production Bonfire send handler must be available');
  return new Function('townSession', 'completeOnboardingAfterBonfire', 'persist', 'broadcast', `
    let generation = 1, mutationTail = Promise.resolve();
    const disk = {onboarding: {step: 'bonfire', completed: false}};
    const state = {onboarding: {...disk.onboarding}, connection: {configured: true}};
    const handler = (${handlerSource});
    return {handler, settings: disk, state,
      blockWrites(promise) { mutationTail = promise; },
      switchConnection() { generation++; },
      changeStep(step) { disk.onboarding = {step, completed: step === 'complete'}; state.onboarding = {...disk.onboarding}; }
    };
  `)({sendBonfireMessage: send}, completeOnboardingAfterBonfire, persist, broadcast);
}

test('production send handler serializes completion and ignores a changed connection or guide', async () => {
  for (const change of ['connection', 'step']) {
    let finishQueue, sends = 0, writes = 0, broadcasts = 0;
    const queued = new Promise(resolve => { finishQueue = resolve; });
    const receipt = {ok: true, id: '12', mentions: []};
    const h = await bonfireHandlerHarness({send: async () => { sends++; return receipt; },
      persist: async () => { writes++; }, broadcast: () => { broadcasts++; }});
    h.blockWrites(queued);
    const sending = h.handler({content: 'Hello', mentions: [], connectionRevision: 1});
    await Promise.resolve();
    assert.equal(writes, 0);
    if (change === 'connection') h.switchConnection();
    else h.changeStep('town');
    finishQueue();
    assert.equal(await sending, receipt);
    assert.equal(sends, 1);
    assert.equal(writes, 0);
    assert.equal(broadcasts, 0);
    assert.equal(h.settings.onboarding.step, change === 'connection' ? 'bonfire' : 'town');
  }
});

test('production send handler publishes completion without obscuring successful sends if delivery fails', async () => {
  let writes = 0, broadcasts = 0;
  const receipt = {ok: true, id: '12', mentions: []};
  const h = await bonfireHandlerHarness({send: async () => receipt,
    persist: async () => { writes++; }, broadcast: () => { broadcasts++; throw new Error('Window closed'); }});
  assert.deepEqual(await h.handler({content: 'Hello', mentions: [], connectionRevision: 1}),
    {...receipt, onboarding: {step: 'complete', completed: true}});
  assert.deepEqual(h.state.onboarding, {step: 'complete', completed: true});
  assert.equal(writes, 1);
  assert.equal(broadcasts, 1);
});

test('preload forwards onboarding progress through the dedicated IPC channel', async () => {
  const source = await fs.readFile(path.join(__dirname, '../src/preload.cjs'), 'utf8');
  let api;
  const calls = [];
  const state = {onboarding: {step: 'channel', completed: false}};
  vm.runInNewContext(source, {require(name) {
    assert.equal(name, 'electron');
    return {contextBridge: {exposeInMainWorld(_name, value) { api = value; }},
      ipcRenderer: {async invoke(channel, ...args) { calls.push({channel, args}); return state; }}};
  }}, {filename: 'preload.cjs'});
  assert.equal(await api.setOnboardingStep('channel'), state);
  assert.equal(calls[0].channel, 'being:setOnboardingStep');
  assert.deepEqual(calls[0].args, ['channel']);
});

test('successful Loom connection persists automatic suppression without completing optional setup', async () => {
  const {rememberLoomConnection} = require('../src/onboarding.cjs');
  const settings = {onboarding: {step: 'portal', completed: false}};
  let saved, writes = 0;
  const persist = async () => { saved = JSON.parse(JSON.stringify(settings)); writes++; };
  await rememberLoomConnection({settings, persist});
  assert.equal(saved.onboardingLoomConnected, true);
  assert.deepEqual(restoreOnboarding(saved), {step: 'portal', completed: false});
  await saveOnboardingStep('loom', {settings, configured: true, persist});
  await rememberLoomConnection({settings, persist});
  assert.equal(writes, 2, 'manual setup and repeated connections retain suppression');
});

test('failed suppression save is retryable and hides filesystem details', async () => {
  const {rememberLoomConnection} = require('../src/onboarding.cjs');
  const settings = {};
  await assert.rejects(rememberLoomConnection({settings, persist: async () => {throw new Error('private filesystem');}}), error => /未能保存/.test(error.message) && !/private/.test(error.message));
  assert.equal(Object.hasOwn(settings, 'onboardingLoomConnected'), false);
  await rememberLoomConnection({settings, persist: async () => {}});
  assert.equal(settings.onboardingLoomConnected, true);
});
