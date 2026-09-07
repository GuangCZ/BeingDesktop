'use strict';

// Run only with Electron and an isolated profile; all fixture pages are in memory.
const {app, BrowserWindow, WebContentsView, Menu, ipcMain, protocol, session} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {normalizeAppMenuRequest, captureMenuEditingTarget, getDesktopWindowState, createDesktopMenuTemplate} = require('../src/desktop-menu.cjs');

if (!process.env.BEING_MENU_TEST_PROFILE) throw new Error('An isolated menu test profile is required.');
app.setPath('userData', path.resolve(process.env.BEING_MENU_TEST_PROFILE));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
protocol.registerSchemesAsPrivileged([{scheme: 'being', privileges: {standard: true, secure: true}}]);
app.on('window-all-closed', () => {});
const report = {passed: false, checks: [], externalRequests: 0, fixturePresentation: 'offscreen, opacity 0, no taskbar button or foreground focus'};
let win, view, activeMenu, editingTarget;
const timeout = setTimeout(() => { console.error('Native menu fixture timed out.'); app.exit(1); }, 25000);
const shellHtml = '<!doctype html><html><body><button id="menu">编辑</button><textarea id="editor">shell draft</textarea></body></html>';
const remoteHtml = '<!doctype html><html><body><textarea id="editor">remote draft</textarea></body></html>';

async function check(label, run) { await run(); report.checks.push(label); }
async function textState(contents) {
  return contents.executeJavaScript('({value:editor.value,start:editor.selectionStart,end:editor.selectionEnd,active:document.activeElement.id})');
}
async function focusEditor(contents) {
  contents.focus();
  await contents.executeJavaScript('editor.focus();editor.setSelectionRange(editor.value.length,editor.value.length)');
}
function editMenu(preferred) {
  return Menu.buildFromTemplate(createDesktopMenuTemplate('edit', {
    sendCommand() {}, closeWindow() {}, editTarget: captureMenuEditingTarget(win, preferred),
  }));
}
async function editClick(menu, label, focusedContents) {
  menu.items.find(item => item.label === label).click({}, win, focusedContents);
  await focusedContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 0))');
}

app.whenReady().then(async () => {
  await protocol.handle('being', () => new Response(shellHtml, {headers: {'Content-Type': 'text/html; charset=utf-8'}}));
  const remoteSession = session.fromPartition('menu-fixture-remote');
  await remoteSession.protocol.handle('https', () => new Response(remoteHtml, {headers: {'Content-Type': 'text/html; charset=utf-8'}}));
  for (const target of [session.defaultSession, remoteSession]) target.webRequest.onBeforeRequest((request, callback) => {
    const allowed = request.url === 'being://app/index.html' || request.url === 'https://menu-fixture.invalid/';
    if (!allowed) report.externalRequests++;
    callback({cancel: !allowed});
  });
  win = new BrowserWindow({show: false, x: -32000, y: -32000, width: 900, height: 600, opacity: 0, focusable: false, skipTaskbar: true, frame: false,
    webPreferences: {preload: path.resolve(__dirname, '../src/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false}});
  win.removeMenu();
  win.on('show', () => { win.hide(); });
  for (const event of ['maximize', 'unmaximize']) win.on(event, () => win.webContents.send('being:window-state', getDesktopWindowState(win)));
  const handle = (name, handler) => ipcMain.handle(`being:${name}`, (event, ...args) => {
    assert.equal(event.sender, win.webContents);
    assert.equal(event.senderFrame, win.webContents.mainFrame);
    assert.equal(event.senderFrame.url, 'being://app/index.html');
    return handler(...args);
  });
  handle('getWindowState', () => getDesktopWindowState(win));
  handle('markShellEditingTarget', () => { editingTarget = win.webContents; });
  handle('maximize', () => { if (win.isMaximized()) win.unmaximize(); else win.maximize(); });
  handle('minimize', () => win.minimize());
  handle('openAppMenu', async value => {
    const [width, height] = win.getContentSize();
    const request = normalizeAppMenuRequest(value, {width, height});
    activeMenu = Menu.buildFromTemplate(createDesktopMenuTemplate(request.menu, {sendCommand() {}, closeWindow() {}, editTarget: captureMenuEditingTarget(win, editingTarget)}));
    activeMenu.once('menu-will-show', () => {
      report.popupWillShow = true;
      setImmediate(() => activeMenu.closePopup(win));
    });
    activeMenu.once('menu-will-close', () => { report.popupWillClose = true; });
    await new Promise(resolve => activeMenu.popup({window: win, x: request.x, y: request.y, callback: resolve}));
    return null;
  });
  await win.loadURL('being://app/index.html');
  view = new WebContentsView({webPreferences: {session: remoteSession, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false}});
  win.contentView.addChildView(view);
  view.setBounds({x: 0, y: 100, width: 900, height: 450});
  view.setVisible(true);
  const remote = view.webContents;
  remote.on('focus', () => { editingTarget = remote; report.nativeRemoteFocus = true; });
  await remote.loadURL('https://menu-fixture.invalid/');
  for (const contents of [win.webContents, remote]) {
    contents.debugger.attach('1.3');
    await contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled: true});
  }
  await check('actual preload exposes window state and trusted shell editing marker', async () => {
    assert.deepEqual(await win.webContents.executeJavaScript('beingDesktop.getWindowState()'), {maximized: false});
    await win.webContents.executeJavaScript('beingDesktop.markShellEditingTarget()');
    assert.equal(editingTarget, win.webContents);
    assert.equal(await remote.executeJavaScript('typeof beingDesktop'), 'undefined');
  });
  await check('captured remote Edit target survives shell menu-button focus', async () => {
    await focusEditor(remote);
    await remote.debugger.sendCommand('Input.insertText', {text: ' added'});
    assert.equal((await textState(remote)).value, 'remote draft added');
    const menu = editMenu(remote);
    win.webContents.focus();
    await win.webContents.executeJavaScript('document.getElementById("menu").focus()');
    await editClick(menu, '撤销', win.webContents);
    assert.equal((await textState(remote)).value, 'remote draft');
    assert.equal((await textState(win.webContents)).value, 'shell draft');
    await editClick(menu, '重做', win.webContents);
    assert.equal((await textState(remote)).value, 'remote draft added');
    await editClick(menu, '全选', win.webContents);
    const selected = await textState(remote);
    assert.equal(selected.start, 0);
    assert.equal(selected.end, selected.value.length);
  });
  await check('shell editing marker directs Edit to the shell after a remote draft', async () => {
    await focusEditor(win.webContents);
    await win.webContents.executeJavaScript('beingDesktop.markShellEditingTarget()');
    await win.webContents.debugger.sendCommand('Input.insertText', {text: ' added'});
    await editClick(editMenu(editingTarget), '撤销', win.webContents);
    assert.equal((await textState(win.webContents)).value, 'shell draft');
    assert.equal((await textState(remote)).value, 'remote draft added');
  });
  await check('hidden or detached native editors fall back to the current shell', async () => {
    view.setVisible(false);
    assert.equal(captureMenuEditingTarget(win, remote), win.webContents);
    view.setVisible(true);
    win.contentView.removeChildView(view);
    assert.equal(captureMenuEditingTarget(win, remote), win.webContents);
    win.contentView.addChildView(view);
  });
  await check('native popup emits lifecycle events and resolves after closePopup', async () => {
    const value = await win.webContents.executeJavaScript('beingDesktop.openAppMenu({menu:"edit",x:110,y:40})');
    assert.equal(value, null);
    assert.equal(report.popupWillShow, true);
    assert.equal(report.popupWillClose, true);
    assert.equal(win.isVisible(), false);
  });
  await check('maximize and restore emit the state consumed by the real preload', async () => {
    await win.webContents.executeJavaScript('window.fixtureStates=[];beingDesktop.onWindowState(state=>fixtureStates.push(state));beingDesktop.maximize()');
    win.hide();
    const maximized = await win.webContents.executeJavaScript('beingDesktop.getWindowState()');
    report.hiddenMaximizeSupported = maximized.maximized;
    if (maximized.maximized) {
      await win.webContents.executeJavaScript('beingDesktop.maximize()');
      win.hide();
      assert.deepEqual(await win.webContents.executeJavaScript('beingDesktop.getWindowState()'), {maximized: false});
      const states = await win.webContents.executeJavaScript('fixtureStates');
      assert.ok(states.some(state => state.maximized));
      assert.ok(states.some(state => !state.maximized));
    }
    assert.equal(win.isVisible(), false);
  });
  await check('minimize and restore execute on the hidden native window', async () => {
    await win.webContents.executeJavaScript('beingDesktop.minimize()');
    report.hiddenMinimizeSupported = win.isMinimized();
    win.restore();
    win.hide();
    assert.equal(win.isMinimized(), false);
    assert.equal(win.isVisible(), false);
  });
  assert.equal(report.externalRequests, 0);
  report.passed = true;
}).catch(error => { report.error = error.stack; }).finally(async () => {
  clearTimeout(timeout);
  if (activeMenu) activeMenu.closePopup(win);
  if (view && !view.webContents.isDestroyed()) view.webContents.close();
  if (win && !win.isDestroyed()) win.destroy();
  await fs.mkdir(app.getPath('userData'), {recursive: true});
  const output = path.join(app.getPath('userData'), 'menu-report.json');
  await fs.writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({passed: report.passed, checks: report.checks.length, output, error: report.error || ''}));
  app.exit(report.passed ? 0 : 1);
});
