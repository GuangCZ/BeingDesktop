'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

const backgroundURL = pathToFileURL(path.resolve(__dirname, '../extensions/being-anywhere/background.mjs'));
const extensionID = 'being-anywhere-test-extension';
const extensionURL = name => `chrome-extension://${extensionID}/${name}`;
const trustedSender = name => ({id: extensionID, url: extensionURL(name || 'sidepanel.html')});
const pageSender = (windowId = 7) => ({id: extensionID, url: 'https://source.example/article?private=removed#fragment', tab: {id: 12, windowId, title: 'Actual page title'}});
const stageMessage = (text = 'Selected passage', prompt = '') => ({type: 'being:stage', selection: {text, title: 'Forged title', url: 'https://forged.example/'}, prompt});
const flush = () => new Promise(resolve => setImmediate(resolve));

function event() {
  const listeners = [];
  return {listeners, addListener: listener => listeners.push(listener), emit: (...args) => listeners.map(listener => listener(...args))};
}

async function harness(t) {
  const calls = [];
  const values = {};
  const localValues = {connection: {url: 'https://being.example/loom/Being?token=fixture-only-token'}};
  const originalGlobals = new Map(['chrome', 'window', 'document', 'location'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const session = {
    async setAccessLevel(value) {calls.push(['session.access', value]);},
    async get(key) {
      calls.push(['session.get', key]);
      if (key === null || key === undefined) return structuredClone(values);
      const keys = typeof key === 'string' ? [key] : Array.isArray(key) ? key : Object.keys(key);
      return Object.fromEntries(keys.map(name => [name, structuredClone(values[name])]));
    },
    async set(value) {calls.push(['session.set', structuredClone(value)]); Object.assign(values, structuredClone(value));},
    async remove(keys) {calls.push(['session.remove', keys]); for (const key of [].concat(keys)) delete values[key];}
  };
  const chrome = {
    runtime: {id: extensionID, getURL: extensionURL, getManifest: () => ({version: '0.2.1'}), onInstalled: event(), onMessage: event()},
    storage: {session, local: {async get(key) {return {[key]: structuredClone(localValues[key])};}, async setAccessLevel(value) {calls.push(['local.access', value]);}}},
    contextMenus: {onClicked: event(), async removeAll() {calls.push(['menus.removeAll']);}, create(value) {calls.push(['menus.create', value]);}},
    sidePanel: {async open(value) {calls.push(['panel.open', value]);}},
    commands: {onCommand: event()},
    scripting: {async executeScript(value) {calls.push(['scripting.execute', value]); return [{result: {text: 'Captured passage', title: 'Captured title', url: 'https://source.example/article'}}];}},
    tabs: {
      onRemoved: event(),
      async get(tabId) {calls.push(['tabs.get', tabId]); return {id: tabId, windowId: 7, url: 'https://source.example/article'};},
      async sendMessage(tabId, value, options) {calls.push(['tabs.sendMessage', tabId, structuredClone(value), options]); throw new Error('No content script fixture');}
    },
    windows: {onRemoved: event()}
  };
  globalThis.chrome = chrome;
  const module = await import(`${backgroundURL.href}?case=${randomUUID()}`);
  await flush();
  calls.length = 0;
  t.after(async () => {
    await flush();
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const send = (message, sender) => new Promise((resolve, reject) => {
    try {
      const accepted = chrome.runtime.onMessage.listeners[0](message, sender, resolve);
      if (!accepted) resolve({ignored: true});
    } catch (error) {reject(error);}
  });
  return {chrome, module, calls, values, localValues, send};
}

test('background ignores foreign senders, unexpected pages, and malformed messages', async t => {
  const {send, calls} = await harness(t);
  for (const sender of [{id: 'another-extension', url: extensionURL('sidepanel.html')}, {id: extensionID, url: extensionURL('unexpected.html')}, {id: extensionID, url: 'https://attacker.example/'}]) {
    assert.deepEqual(await send({...stageMessage(), tabId: 12}, sender), {ignored: true});
  }
  for (const message of [null, undefined, false, 'being:stage', [], {type: 'unknown'}]) {
    assert.deepEqual(await send(message, trustedSender()), {ignored: true});
  }
  assert.deepEqual(calls, []);
});

test('content senders cannot read selections, consume queued data, or read configuration', async t => {
  const {send, values, calls} = await harness(t);
  values['queue:7'] = [{id: 'context-1', selection: {text: 'Private queued text'}, prompt: ''}];
  for (const message of [{type: 'being:capture', tabId: 99}, {type: 'being:consume', windowId: 7, id: 'context-1'}, {type: 'being:settings'}, {type: 'being:configuration'}]) {
    assert.deepEqual(await send(message, pageSender()), {ignored: true});
  }
  assert.equal(values['queue:7'].length, 1);
  assert.deepEqual(calls, []);
});

test('content staging opens the panel first and replaces claimed source metadata', async t => {
  const {send, values, calls} = await harness(t);
  assert.deepEqual(await send(stageMessage('  Quoted text  ', '  Explain it  '), pageSender()), {ok: true});
  assert.deepEqual(calls[0], ['panel.open', {windowId: 7}]);
  assert.deepEqual(values['queue:7'][0].selection, {text: 'Quoted text', title: 'Actual page title', url: 'https://source.example/article'});
  assert.equal(values['queue:7'][0].prompt, 'Explain it');
  assert.match(values['queue:7'][0].id, /^[a-f0-9-]{36}$/);
});

test('concurrent staging preserves every item and isolates browser windows', async t => {
  const {send, values} = await harness(t);
  const result = await Promise.all(Array.from({length: 8}, (_, i) => send(stageMessage(`Passage ${i}`), pageSender(i % 2 ? 8 : 7))));
  assert(result.every(item => item.ok));
  assert.deepEqual(values['queue:7'].map(item => item.selection.text), ['Passage 0', 'Passage 2', 'Passage 4', 'Passage 6']);
  assert.deepEqual(values['queue:8'].map(item => item.selection.text), ['Passage 1', 'Passage 3', 'Passage 5', 'Passage 7']);
  assert.equal(new Set([...values['queue:7'], ...values['queue:8']].map(item => item.id)).size, 8);
});

test('queue and payload limits leave existing contexts intact', async t => {
  const {send, values} = await harness(t);
  const result = await Promise.all(Array.from({length: 11}, (_, i) => send(stageMessage(`Passage ${i}`), pageSender())));
  assert.equal(result.filter(item => item.ok).length, 10);
  assert.equal(values['queue:7'].length, 10);
  assert.equal(result[10].ok, false);
  assert.match(result[10].error, /10/);
  assert.equal((await send(stageMessage('Text', 'x'.repeat(8001)), pageSender(8))).ok, false);
  assert.equal((await send({...stageMessage(), prompt: {}}, pageSender(8))).ok, false);
  assert.equal(values['queue:8'], undefined);
  assert.equal((await send(stageMessage('x'.repeat(21000)), pageSender(8))).ok, true);
  assert.equal(values['queue:8'][0].selection.text.length, 20000);
});

test('trusted pages may capture and consume only the requested queued item', async t => {
  const {send, values} = await harness(t);
  await send(stageMessage('Keep this'), pageSender());
  await send(stageMessage('Remove this'), pageSender());
  await send(stageMessage('Other window'), pageSender(8));
  const capture = await send({type: 'being:capture', tabId: 12}, trustedSender('popup.html'));
  assert.equal(capture.ok, true);
  assert.equal(capture.selection.text, 'Captured passage');
  assert.deepEqual(await send({type: 'being:consume', windowId: 7, id: values['queue:7'][1].id}, trustedSender()), {ok: true});
  assert.deepEqual(values['queue:7'].map(item => item.selection.text), ['Keep this']);
  assert.equal(values['queue:8'][0].selection.text, 'Other window');
});

test('trusted popup staging resolves the target window from Chrome tab data', async t => {
  const {send, values, calls} = await harness(t);
  assert.deepEqual(await send({...stageMessage(), tabId: 12, windowId: 999}, trustedSender('popup.html')), {ok: true});
  assert.deepEqual(calls[0], ['tabs.get', 12]);
  assert.equal(values['queue:7'].length, 1);
  assert.equal(values['queue:999'], undefined);
});

test('invalid consumption identifiers cannot create or mutate queue keys', async t => {
  const {send, values, calls} = await harness(t);
  for (const message of [{type: 'being:consume', id: 'item'}, {type: 'being:consume', windowId: '7', id: 'item'}, {type: 'being:consume', windowId: 7, id: null}, {type: 'being:consume', windowId: 7, id: ''}]) {
    const response = await send(message, trustedSender());
    assert(response.ignored || response.ok === false);
  }
  assert.deepEqual(values, {});
  assert(!calls.some(item => item[0] === 'session.set'));
});

test('selection capture excludes password and other sensitive input types', async t => {
  const {module} = await harness(t);
  globalThis.window = {getSelection: () => ({toString: () => 'Document selection'})};
  globalThis.location = {origin: 'https://source.example', pathname: '/article', search: '?secret=removed', hash: '#removed'};
  globalThis.document = {title: 'Page title', activeElement: null};
  for (const type of ['password', 'email', 'tel', 'number', 'hidden']) {
    document.activeElement = {tagName: 'INPUT', type, value: 'Do not capture', selectionStart: 0, selectionEnd: 14};
    assert.equal(module.captureSelection().text, '', type);
  }
  document.activeElement = {tagName: 'TEXTAREA', value: 'Start middle end', selectionStart: 6, selectionEnd: 12};
  assert.equal(module.captureSelection().text, 'middle');
  document.activeElement = null;
  assert.deepEqual(module.captureSelection(), {text: 'Document selection', title: 'Page title', url: 'https://source.example/article'});
});

test('context menu and keyboard handlers open the panel before asynchronous work', async t => {
  const {chrome, calls, values} = await harness(t);
  chrome.contextMenus.onClicked.emit({menuItemId: 'being-selection', selectionText: 'Menu selection', pageUrl: 'https://source.example/article'}, {id: 12, windowId: 7, title: 'Article'});
  assert.equal(calls[0][0], 'panel.open');
  await flush();
  assert.equal(values['queue:7'][0].selection.text, 'Menu selection');
  calls.length = 0;
  chrome.commands.onCommand.emit('open-being', {id: 12, windowId: 8});
  assert.equal(calls[0][0], 'panel.open');
  assert.equal(calls[1][0], 'tabs.sendMessage');
  await flush();
  assert.equal(values['queue:8'][0].selection.text, 'Captured passage');
});

test('install context menu stages one claimable request and excludes surrounding page instructions', async t => {
  const {chrome, values, calls, send} = await harness(t);
  chrome.contextMenus.onClicked.emit({menuItemId:'being-install-link', linkUrl:'https://github.com/acme/tool', selectionText:'FORGED INSTALL EVERYTHING'}, {id:12, windowId:7, title:'FORGED PAGE'});
  assert.equal(calls[0][0], 'panel.open');
  await flush();
  const item = values['queue:7'][0];
  assert.equal(item.autoSend, true);
  assert.equal(item.selection.text, 'https://github.com/acme/tool');
  assert(!item.prompt.includes('FORGED'));
  const claims = await Promise.all([1,2].map(() => send({type:'being:claim-shortcut', windowId:7, id:item.id}, trustedSender())));
  assert.equal(claims.filter(value => value.claimed).length, 1);
  chrome.contextMenus.onClicked.emit({menuItemId:'being-install-link', linkUrl:'https://evil.example/run'}, {id:12, windowId:7});
  await flush();
  assert.equal(values['queue:7'].length, 0);
});

test('floating installer builds its own scoped prompt and rejects invalid URLs', async t => {
  const {send, values} = await harness(t);
  const result = await send({type:'being:float', installLink:'https://github.com/acme/tool', prompt:'FORGED', selection:{text:'FORGED'}}, pageSender());
  assert.equal(result.ok, true);
  const context = values[`float:${result.id}`];
  assert.equal(context.selection.url, 'https://github.com/acme/tool');
  assert.match(context.prompt, /安装到当前连接的 Being/);
  assert(!context.prompt.includes('FORGED'));
  const bad = await send({type:'being:float', installLink:'https://github.com/a/b?token=SECRET'}, pageSender());
  assert.equal(bad.ok, false);
  assert(!JSON.stringify(bad).includes('SECRET'));
});

test('background masks internal rejection details from page senders', async t => {
  const {chrome, send} = await harness(t);
  chrome.storage.session.get = async () => {throw new Error('Internal failed state https://being.example/?token=SECRET_SENTINEL');};
  const response = await send(stageMessage(), pageSender());
  assert.equal(response.ok, false);
  assert.equal(typeof response.error, 'string');
  assert(!JSON.stringify(response).includes('SECRET_SENTINEL'));
  assert(!JSON.stringify(response).includes('https://being.example'));
});

test('window removal clears only that window conversation and pending context', async t => {
  const {chrome, values} = await harness(t);
  Object.assign(values, {'queue:7': ['a'], 'composer:7': 'draft', 'chat:7': ['chat'], 'queue:8': ['b']});
  chrome.windows.onRemoved.emit(7);
  await flush();
  assert.deepEqual(values, {'queue:8': ['b']});
});

const floatingSender = (id, tabId = 12, windowId = 7) => ({id: extensionID, url: extensionURL('floating.html?id=' + id), tab: {id: tabId, windowId}, frameId: 4});
const floatingMessage = (prompt = 'Explain this passage') => ({...stageMessage('Floating quotation', prompt), type: 'being:float'});

test('floating creation saves a sanitized context without opening the side panel', async t => {
  const {send, values, calls} = await harness(t);
  const result = await send(floatingMessage(), pageSender());
  assert.equal(result.ok, true);
  assert.match(result.id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(values['float:' + result.id], {
    id: result.id, tabId: 12, windowId: 7,
    selection: {text: 'Floating quotation', title: 'Actual page title', url: 'https://source.example/article'},
    prompt: 'Explain this passage', started: false
  });
  assert(!calls.some(item => item[0] === 'panel.open'));
  assert.equal(values['queue:7'], undefined);
  for (const prompt of ['', '   ', null, {}, 'x'.repeat(8001)]) {
    assert.equal((await send(floatingMessage(prompt), pageSender())).ok, false);
  }
});

test('floating context grants automatic first-send exactly once under concurrent loads', async t => {
  const {send, values} = await harness(t);
  const {id} = await send(floatingMessage(), pageSender());
  const replies = await Promise.all(Array.from({length: 4}, () => send({type: 'being:float-context', id}, floatingSender(id))));
  assert(replies.every(reply => reply.ok));
  assert.equal(replies.filter(reply => reply.autoSend).length, 1);
  assert.equal(values['float:' + id].started, true);
  assert.equal((await send({type: 'being:float-context', id}, floatingSender(id))).autoSend, false);
  for (const reply of replies) {
    assert.equal(reply.context.id, id);
    assert.equal(reply.context.windowId, 7);
    assert.equal(reply.context.selection.text, 'Floating quotation');
    assert.equal(reply.context.prompt, 'Explain this passage');
    assert(!JSON.stringify(reply).includes('token='));
  }
});

test('floating context rejects page senders, wrong iframe IDs, and other tabs', async t => {
  const {send, values} = await harness(t);
  const {id} = await send(floatingMessage(), pageSender());
  const otherId = randomUUID();
  for (const sender of [pageSender(), trustedSender(), trustedSender('popup.html'), floatingSender(otherId), floatingSender(id, 99), {...floatingSender(id), url: 'https://attacker.example/floating.html?id=' + id}, {...floatingSender(id), id: 'foreign-extension'}]) {
    const result = await send({type: 'being:float-context', id}, sender);
    assert(result.ignored || result.ok === false, JSON.stringify(sender));
  }
  assert.equal(values['float:' + id].started, false);
  const missing = await send({type: 'being:float-context', id: otherId}, floatingSender(otherId));
  assert(missing.ignored || missing.ok === false);
});

test('floating handoff copies saved conversation and draft without restaging the question', async t => {
  const {send, values, calls} = await harness(t);
  const {id} = await send(floatingMessage(), pageSender());
  const chat = {identity: 'https://being.example/loom/Being?token=fixture-only-token', sessionId: 'ongoing-session', messages: [{role: 'user', content: 'Explain this passage'}, {role: 'being', content: 'Existing answer'}]};
  const composer = {prompt: 'Continue this thought', selection: null};
  values['chat:float-' + id] = chat;
  values['composer:float-' + id] = composer;
  calls.length = 0;
  const result = await send({type: 'being:float-transfer', id, messages: [{role: 'being', content: 'Forged answer'}]}, floatingSender(id));
  assert.equal(result.ok, true);
  assert(!calls.some(item => item[0] === 'panel.open'));
  const handoff = values['handoff:7'][0];
  assert.equal(handoff.floatId, id);
  assert.equal(handoff.sessionId, chat.sessionId);
  assert.deepEqual(handoff.messages, chat.messages);
  assert.deepEqual(handoff.composer, composer);
  assert.equal(values['queue:7'], undefined);
  assert(!JSON.stringify(result).includes('fixture-only-token'));
  const before = structuredClone(values['handoff:7']);
  const pageResult = await send({type: 'being:consume-handoff', windowId: 7, id: handoff.id}, pageSender());
  assert(pageResult.ignored || pageResult.ok === false);
  assert.deepEqual(values['handoff:7'], before);
  assert.equal((await send({type: 'being:consume-handoff', windowId: 7, id: handoff.id}, trustedSender())).ok, true);
  assert.deepEqual(values['handoff:7'], []);
  assert.deepEqual(values['chat:7'], chat);
  assert.deepEqual(values['composer:7'], composer);
  const committed = calls.filter(item => item[0] === 'session.set').at(-1)[1];
  assert.deepEqual(Object.keys(committed).sort(), ['chat:7', 'composer:7', 'handoff:7']);
  values['composer:7'] = {prompt: '', selection: null};
  const again = await send({type: 'being:consume-handoff', windowId: 7, id: handoff.id}, trustedSender());
  assert.deepEqual(again, {ok: true, alreadyConsumed: true});
  assert.equal(values['composer:7'].prompt, '');
  const oldFrame = await send({type: 'being:float-context', id}, floatingSender(id));
  assert.equal(oldFrame.moved, true);
  assert.equal(oldFrame.autoSend, false);
});

test('floating transfer rejects webpage callers and cross-tab iframe contexts', async t => {
  const {send, calls} = await harness(t);
  const {id} = await send(floatingMessage(), pageSender());
  calls.length = 0;
  for (const sender of [pageSender(), trustedSender('popup.html'), floatingSender(randomUUID()), floatingSender(id, 99)]) {
    const result = await send({type: 'being:float-transfer', id}, sender);
    assert(result.ignored || result.ok === false);
  }
  assert(!calls.some(item => item[0] === 'session.set'));
});

test('floating creation masks internal storage details from webpages', async t => {
  const {chrome, send} = await harness(t);
  chrome.storage.session.set = async () => {throw new Error('Internal https://being.example/?token=FLOAT_SECRET_SENTINEL');};
  const result = await send(floatingMessage(), pageSender());
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  assert(!JSON.stringify(result).includes('FLOAT_SECRET_SENTINEL'));
  assert(!JSON.stringify(result).includes('https://being.example'));
});


test('floating handoff rejects a changed Being identity and deduplicates repeated transfers', async t => {
  const {send, values, localValues} = await harness(t);
  const {id} = await send(floatingMessage(), pageSender());
  values['chat:float-' + id] = {identity: 'https://other.example/loom?token=OLD_SECRET_SENTINEL', sessionId: 'old', messages: [{role: 'being', content: 'Previous Being'}]};
  const rejected = await send({type: 'being:float-transfer', id}, floatingSender(id));
  assert.equal(rejected.ok, false);
  assert(!JSON.stringify(rejected).includes('OLD_SECRET_SENTINEL'));
  assert.equal(values['handoff:7'], undefined);
  values['chat:float-' + id].identity = localValues.connection.url;
  const results = await Promise.all(Array.from({length: 4}, () => send({type: 'being:float-transfer', id}, floatingSender(id))));
  assert(results.every(result => result.ok));
  assert.equal(values['handoff:7'].length, 1);
});

test('floating release removes only the originating tab context and retained drafts', async t => {
  const {send, values} = await harness(t);
  const {id} = await send(floatingMessage(), pageSender());
  values['chat:float-' + id] = {messages: [{content: 'Private answer'}]};
  values['composer:float-' + id] = {prompt: 'Private unsent draft'};
  const other = await send(floatingMessage(), {...pageSender(), tab: {id: 99, windowId: 7, title: 'Other tab'}});
  const denied = await send({type: 'being:float-release', id}, {...pageSender(), tab: {id: 99, windowId: 7}});
  assert(denied.ignored || denied.ok === false);
  assert(values['float:' + id]);
  assert.equal((await send({type: 'being:float-release', id}, pageSender())).ok, true);
  assert.equal(values['float:' + id], undefined);
  assert.equal(values['chat:float-' + id], undefined);
  assert.equal(values['composer:float-' + id], undefined);
  assert(values['float:' + other.id]);
});

test('tab removal clears its floating conversations while preserving another tab', async t => {
  const {chrome, send, values} = await harness(t);
  const {id} = await send(floatingMessage(), pageSender());
  values['chat:float-' + id] = {messages: [{content: 'Private answer'}]};
  values['composer:float-' + id] = {prompt: 'Private unsent draft'};
  const other = await send(floatingMessage(), {...pageSender(), tab: {id: 99, windowId: 7, title: 'Other tab'}});
  chrome.tabs.onRemoved.emit(12, {windowId: 7});
  await flush();
  assert.equal(values['float:' + id], undefined);
  assert.equal(values['chat:float-' + id], undefined);
  assert.equal(values['composer:float-' + id], undefined);
  assert(values['float:' + other.id]);
});

test('widget inspection and activation accept only the extension popup', async t => {
  const {send, calls} = await harness(t);
  for (const sender of [pageSender(), trustedSender(), trustedSender('options.html'), {...trustedSender('popup.html'), tab: {id: 12}}, {id: 'another-extension', url: extensionURL('popup.html')}, {id: extensionID, url: extensionURL('popup.html?forged=true')}]) {
    for (const type of ['being:widget-status', 'being:widget-activate']) {
      assert.deepEqual(await send({type, tabId: 12}, sender), {ignored: true});
    }
  }
  assert.deepEqual(calls, []);
});

test('widget inspection validates top-frame replies without installing scripts', async t => {
  const {chrome, send, calls} = await harness(t);
  let response;
  chrome.tabs.sendMessage = async (tabId, message, options) => {
    calls.push(['tabs.sendMessage', tabId, message, options]);
    return response;
  };
  for (const value of [undefined, {}, {ok: true}, {ok: true, version: '0.2.1', visible: 'yes'}, {ok: true, version: '0.2.0', visible: true}, {ok: false, version: '0.2.1', visible: true}]) {
    response = value;
    assert.deepEqual(await send({type: 'being:widget-status', tabId: 12}, trustedSender('popup.html')), {ok: true, status: 'missing', version: '0.2.1', visible: false});
  }
  response = {ok: true, version: '0.2.1', visible: false};
  assert.deepEqual(await send({type: 'being:widget-status', tabId: 12}, trustedSender('popup.html')), {ok: true, status: 'ready', version: '0.2.1', visible: false});
  assert(calls.filter(call => call[0] === 'tabs.sendMessage').every(call => call[2].type === 'being:widget-status' && call[3].frameId === 0));
  assert(!calls.some(call => call[0] === 'scripting.execute' || call[0] === 'panel.open' || call[0] === 'session.set'));
});

test('widget actions reject invalid tabs and identify restricted page schemes', async t => {
  const {chrome, send, calls} = await harness(t);
  for (const tabId of [undefined, null, '12', -1, 1.5, NaN]) {
    for (const type of ['being:widget-status', 'being:widget-activate']) {
      assert.equal((await send({type, tabId}, trustedSender('popup.html'))).ok, false);
    }
  }
  assert.deepEqual(calls, []);
  for (const url of ['edge://newtab/', 'chrome://extensions/', 'file:///C:/private.txt', 'chrome-extension://pdf-viewer/document.html', undefined]) {
    chrome.tabs.get = async tabId => ({id: tabId, url});
    assert.deepEqual(await send({type: 'being:widget-status', tabId: 12}, trustedSender('popup.html')), {ok: true, status: 'restricted', version: '0.2.1', visible: false});
    const activate = await send({type: 'being:widget-activate', tabId: 12}, trustedSender('popup.html'));
    assert.equal(activate.ok, false);
    assert.equal(activate.status, 'restricted');
  }
  assert.deepEqual(calls, []);
});

test('widget activation installs a missing top frame and tolerates restricted child frames', async t => {
  const {chrome, send, calls, values} = await harness(t);
  let loaded = false, visible = false;
  chrome.tabs.sendMessage = async (tabId, message, options) => {
    calls.push(['tabs.sendMessage', tabId, structuredClone(message), options]);
    if (!loaded) throw new Error('No receiver');
    if (message.type === 'being:show') {visible = true; return {ok: true};}
    return {ok: true, version: '0.2.1', visible};
  };
  chrome.scripting.executeScript = async value => {
    calls.push(['scripting.execute', value]);
    if (value.target.allFrames) throw new Error('Restricted child https://private.example/?token=SECRET_SENTINEL');
    loaded = true;
    return [{frameId: 0}];
  };
  const result = await send({type: 'being:widget-activate', tabId: 12, selection: {text: '  Saved selection  ', title: 'Saved title', url: 'https://source.example/article?token=REMOVE#fragment'}}, trustedSender('popup.html'));
  assert.deepEqual(result, {ok: true, status: 'ready', version: '0.2.1', visible: true});
  assert.deepEqual(calls.filter(call => call[0] === 'scripting.execute').map(call => call[1]), [
    {target: {tabId: 12, frameIds: [0]}, files: ['content.js']},
    {target: {tabId: 12, allFrames: true}, files: ['content.js']},
  ]);
  const shown = calls.find(call => call[0] === 'tabs.sendMessage' && call[2].type === 'being:show');
  assert.deepEqual(shown.slice(1), [12, {type: 'being:show', selection: {text: 'Saved selection', title: 'Saved title', url: 'https://source.example/article'}}, {frameId: 0}]);
  assert(!calls.some(call => call[0] === 'panel.open'));
  assert.deepEqual(values, {});
});

test('widget activation reuses the installed script and verifies that it becomes visible', async t => {
  const {chrome, send, calls} = await harness(t);
  let visible = false;
  chrome.tabs.sendMessage = async (tabId, message, options) => {
    calls.push(['tabs.sendMessage', tabId, message, options]);
    if (message.type === 'being:show') {visible = true; return {ok: true};}
    return {ok: true, version: '0.2.1', visible};
  };
  assert.deepEqual(await send({type: 'being:widget-activate', tabId: 12}, trustedSender('popup.html')), {ok: true, status: 'ready', version: '0.2.1', visible: true});
  assert(!calls.some(call => call[0] === 'scripting.execute'));
  assert.deepEqual(calls.filter(call => call[0] === 'tabs.sendMessage').map(call => call[2].type), ['being:widget-status', 'being:show', 'being:widget-status']);
  assert.deepEqual(calls.find(call => call[2]?.type === 'being:show')[2], {type: 'being:show'});
});

test('widget activation masks permission failures and succeeds when permission is restored', async t => {
  const {chrome, send, calls} = await harness(t);
  let allowed = false, loaded = false, visible = false;
  chrome.tabs.sendMessage = async (_tabId, message) => {
    if (!loaded) throw new Error('No receiver');
    if (message.type === 'being:show') {visible = true; return {ok: true};}
    return {ok: true, version: '0.2.1', visible};
  };
  chrome.scripting.executeScript = async value => {
    calls.push(['scripting.execute', value]);
    if (!allowed) throw new Error('Permission denied https://private.example/?token=SECRET_SENTINEL');
    loaded = true;
    return [];
  };
  const first = await send({type: 'being:widget-activate', tabId: 12}, trustedSender('popup.html'));
  assert.equal(first.ok, false);
  assert.equal(first.status, 'missing');
  assert.equal(first.visible, false);
  assert(!JSON.stringify(first).includes('SECRET_SENTINEL'));
  assert(!JSON.stringify(first).includes('private.example'));
  allowed = true;
  assert.deepEqual(await send({type: 'being:widget-activate', tabId: 12}, trustedSender('popup.html')), {ok: true, status: 'ready', version: '0.2.1', visible: true});
});

test('widget activation never reports success for an unresponsive or invisible widget', async t => {
  const {chrome, send} = await harness(t);
  chrome.tabs.sendMessage = async () => ({ok: true, version: '0.2.1', visible: false});
  const invisible = await send({type: 'being:widget-activate', tabId: 12}, trustedSender('popup.html'));
  assert.equal(invisible.ok, false);
  assert.equal(invisible.visible, false);
  chrome.tabs.sendMessage = async () => ({ok: true});
  const malformed = await send({type: 'being:widget-activate', tabId: 12}, trustedSender('popup.html'));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.visible, false);
  assert.match(malformed.error, /刷新网页/);
});

test('only popup shortcuts can stage automatic sends without consuming a custom popup draft', async t => {
  const {send, values} = await harness(t);
  const draft = {prompt: 'Keep my unfinished custom question', selection: {text: 'Original draft quotation'}, tabId: 12};
  values.popupDraft = structuredClone(draft);
  const preset = '请用三个要点总结这段内容。';
  assert.deepEqual(await send({...stageMessage('Shortcut quotation', preset), tabId: 12, autoSend: true}, trustedSender('popup.html')), {ok: true});
  assert.deepEqual(values.popupDraft, draft);
  assert.equal(values['queue:7'][0].autoSend, true);
  assert.equal(values['queue:7'][0].prompt, preset);
  assert.equal(values['queue:7'][0].selection.text, 'Shortcut quotation');
  await send({...stageMessage('Page request', preset), autoSend: true}, pageSender());
  await send({...stageMessage('Sidebar request', preset), tabId: 12, autoSend: true}, trustedSender());
  assert.equal(values['queue:7'][1].autoSend, undefined);
  assert.equal(values['queue:7'][2].autoSend, undefined);
});

test('automatic shortcut claims accept only the trusted sidebar and validate identifiers', async t => {
  const {send, values, calls} = await harness(t);
  values['queue:7'] = [{id: 'shortcut-1', autoSend: true, prompt: 'Explain', selection: {text: 'Keep queued'}}];
  for (const sender of [pageSender(), trustedSender('popup.html'), trustedSender('options.html'), {...trustedSender(), tab: {id: 12}}, {id: 'another-extension', url: extensionURL('sidepanel.html')}, {id: extensionID, url: extensionURL('sidepanel.html?forged=true')}]) {
    assert.deepEqual(await send({type: 'being:claim-shortcut', windowId: 7, id: 'shortcut-1'}, sender), {ignored: true});
  }
  for (const input of [{windowId: '7', id: 'shortcut-1'}, {windowId: -1, id: 'shortcut-1'}, {windowId: 7, id: ''}, {windowId: 7, id: null}]) {
    assert.equal((await send({type: 'being:claim-shortcut', ...input}, trustedSender())).ok, false);
  }
  assert.equal(values['queue:7'].length, 1);
  assert.deepEqual(calls, []);
});

test('concurrent sidebar shortcut claims grant a single send and never claim ordinary contexts', async t => {
  const {send, values, calls} = await harness(t);
  const shortcut = {id: 'shortcut-1', autoSend: true, prompt: 'Exact preset', selection: {text: 'Exact selection'}};
  const ordinary = {id: 'ordinary-1', prompt: 'Manual draft', selection: {text: 'Manual quote'}};
  values['queue:7'] = [ordinary, shortcut];
  values['queue:8'] = [{...shortcut, id: 'other-window'}];
  const results = await Promise.all(Array.from({length: 6}, () => send({type: 'being:claim-shortcut', windowId: 7, id: shortcut.id}, trustedSender())));
  assert.equal(results.filter(result => result.claimed).length, 1);
  assert(results.every(result => result.ok));
  assert.deepEqual(results.find(result => result.claimed).item, shortcut);
  assert.deepEqual(values['queue:7'], [ordinary]);
  assert.equal(values['queue:8'].length, 1);
  assert.equal(calls.filter(call => call[0] === 'session.set').length, 1);
  assert.deepEqual(await send({type: 'being:claim-shortcut', windowId: 7, id: shortcut.id}, trustedSender()), {ok: true, claimed: false});
  assert.deepEqual(await send({type: 'being:claim-shortcut', windowId: 7, id: ordinary.id}, trustedSender()), {ok: true, claimed: false});
  assert.deepEqual(values['queue:7'], [ordinary]);
});

test('a failed shortcut claim retains the intent and masks internal storage details', async t => {
  const {chrome, send, values} = await harness(t);
  const shortcut = {id: 'shortcut-1', autoSend: true, prompt: 'Exact preset', selection: {text: 'Exact selection'}};
  values['queue:7'] = [shortcut];
  chrome.storage.session.set = async () => {throw new Error('Storage failure https://private.example/?token=CLAIM_SECRET_SENTINEL');};
  const result = await send({type: 'being:claim-shortcut', windowId: 7, id: shortcut.id}, trustedSender());
  assert.equal(result.ok, false);
  assert(!JSON.stringify(result).includes('CLAIM_SECRET_SENTINEL'));
  assert(!JSON.stringify(result).includes('private.example'));
  assert.deepEqual(values['queue:7'], [shortcut]);
});
