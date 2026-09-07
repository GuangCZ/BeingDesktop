'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {normalizeAppMenuRequest, commandForInput, createDesktopMenuTemplate} = require('../src/desktop-menu.cjs');

test('native menu positions stay inside content bounds and reject unsupported payloads', () => {
  const bounds = {width: 1000, height: 700};
  assert.deepEqual(normalizeAppMenuRequest({menu: 'file', x: 121.4, y: 41.6}, bounds), {menu: 'file', x: 121, y: 42});
  assert.deepEqual(normalizeAppMenuRequest({menu: 'view', x: -200, y: 100000}, bounds), {menu: 'view', x: 0, y: 699});
  for (const value of [null, undefined, [], {}, {menu: 'constructor', x: 0, y: 0}, {menu: 'file', x: '1', y: 0},
    {menu: 'edit', x: NaN, y: 0}, {menu: 'help', x: 0, y: Infinity}]) {
    assert.throws(() => normalizeAppMenuRequest(value, bounds), /请选择有效的应用菜单/);
  }
});

test('Loom forwards supported desktop shortcuts and leaves editing combinations alone', () => {
  const keyDown = {type: 'keyDown', control: false, alt: false, shift: false, meta: false};
  for (const [key, expected] of [['ArrowLeft', 'navigate-back'], ['ArrowRight', 'navigate-forward']]) {
    assert.equal(commandForInput({...keyDown, alt: true, key}), expected);
    for (const modifier of ['shift', 'control', 'meta']) assert.equal(commandForInput({...keyDown, alt: true, [modifier]: true, key}), null);
    assert.equal(commandForInput({...keyDown, key}), null);
    assert.equal(commandForInput({...keyDown, type: 'keyUp', alt: true, key}), null);
  }
  for (const [key, expected] of [['B', 'toggle-sidebar'], ['1', 'chat'], ['2', 'workspace'], [',', 'settings']]) {
    assert.equal(commandForInput({...keyDown, control: true, key}), expected);
    for (const modifier of ['shift', 'alt', 'meta']) assert.equal(commandForInput({...keyDown, control: true, [modifier]: true, key}), null);
  }
  for (const key of ['c', 'v', 'x', 'z', 'a', 'r', 'constructor', '__proto__']) assert.equal(commandForInput({...keyDown, control: true, key}), null);
});

test('menu actions dispatch desktop commands while close preserves the native window lifecycle', () => {
  const commands = [];
  let closed = 0;
  const callbacks = {sendCommand: command => commands.push(command), closeWindow: () => closed++};
  for (const name of ['file', 'view', 'help']) {
    const items = createDesktopMenuTemplate(name, callbacks);
    for (const item of items) {
      if (item.accelerator) assert.equal(item.registerAccelerator, false, 'Existing keyboard handlers must own shortcut execution');
      item.click?.();
    }
  }
  assert.equal(closed, 1);
  assert.deepEqual(commands, ['chat', 'workspace', 'select-workspace', 'settings', 'navigate-back', 'navigate-forward',
    'toggle-sidebar', 'toggle-inspector', 'refresh', 'open-browser', 'open-console', 'about']);
  const editing = createDesktopMenuTemplate('edit', callbacks).filter(item => item.type !== 'separator');
  assert.deepEqual(editing.map(item => item.role), ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
  assert.ok(editing.every(item => !item.click));
  assert.throws(() => createDesktopMenuTemplate('unknown', callbacks), /请选择有效的应用菜单/);
});

test('sandbox bridge filters commands and keeps native events outside renderer callbacks', async () => {
  let api;
  const calls = [], listeners = new Map();
  const state = {maximized: true};
  const ipcRenderer = {
    async invoke(channel, ...args) { calls.push({channel, args}); return channel === 'being:getWindowState' ? state : null; },
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) { if (listeners.get(channel) === listener) listeners.delete(channel); },
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8');
  vm.runInNewContext(source, {require(name) {
    assert.equal(name, 'electron');
    return {ipcRenderer, contextBridge: {exposeInMainWorld(_name, value) { api = value; }}};
  }});
  assert.equal(await api.getWindowState(), state);
  const request = {menu: 'file', x: 100, y: 42};
  assert.equal(await api.openAppMenu(request), null);
  assert.deepEqual(calls, [{channel: 'being:getWindowState', args: []}, {channel: 'being:openAppMenu', args: [request]}]);
  const commands = [], states = [];
  const stopCommands = api.onCommand((...args) => commands.push(args));
  const stopState = api.onWindowState((...args) => states.push(args));
  const event = {sender: {private: true}};
  for (const command of ['navigate-back', 'navigate-forward', 'toggle-sidebar', 'toggle-inspector', 'chat', 'workspace', 'settings',
    'select-workspace', 'refresh', 'open-browser', 'open-console', 'about', '__proto__', 'unexpected', null]) {
    listeners.get('being:command')(event, command);
  }
  assert.equal(commands.length, 12);
  assert.ok(commands.every(args => args.length === 1 && typeof args[0] === 'string'));
  listeners.get('being:window-state')(event, state);
  assert.deepEqual(states, [[state]]);
  stopCommands(); stopState();
  assert.equal(listeners.size, 0);
  for (const value of [undefined, null, {}, 'callback']) {
    assert.throws(() => api.onCommand(value), /Expected callback/);
    assert.throws(() => api.onWindowState(value), /Expected callback/);
  }
});

test('captured Edit actions keep their target and ignore an editor destroyed while the menu is open', () => {
  let destroyed = false;
  const actions = [];
  const editTarget = {isDestroyed: () => destroyed};
  for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) editTarget[role] = () => actions.push(role);
  const items = createDesktopMenuTemplate('edit', {editTarget}).filter(item => item.type !== 'separator');
  for (const item of items) {
    assert.equal(item.role, undefined, 'Native roles must not override the captured editing target');
    assert.equal(item.registerAccelerator, false);
    item.click();
  }
  assert.deepEqual(actions, ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
  destroyed = true;
  for (const item of items) item.click();
  assert.equal(actions.length, 6);
});
