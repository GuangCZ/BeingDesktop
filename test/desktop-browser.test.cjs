'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {DesktopBrowser, BROWSER_PARTITION, MAX_BROWSER_TABS, normalizeBrowserUrl} = require('../src/desktop-browser.cjs');

class Contents extends EventEmitter {
  constructor() {
    super();
    this.url = '';
    this.history = [];
    this.index = -1;
    this.loading = false;
    this.destroyed = false;
    this.pending = [];
    this.navigationHistory = {
      canGoBack:() => this.index > 0,
      canGoForward:() => this.index < this.history.length - 1,
      goBack:() => { this.url = this.history[--this.index]; this.emit('did-navigate'); },
      goForward:() => { this.url = this.history[++this.index]; this.emit('did-navigate'); },
    };
  }
  loadURL(url) {
    this.emit('did-start-navigation', {url,isMainFrame:true,isSameDocument:false});
    this.url = url;
    this.history.splice(this.index + 1);
    this.history.push(url);
    this.index++;
    this.loading = true;
    this.emit('did-start-loading');
    return new Promise((resolve, reject) => this.pending.push({resolve, reject}));
  }
  finish(title = 'Fixture page') {
    this.loading = false;
    this.emit('did-navigate');
    this.emit('page-title-updated', {}, title);
    this.emit('did-stop-loading');
    this.pending.at(-1)?.resolve();
  }
  getURL() { return this.url; }
  executeJavaScriptInIsolatedWorld() { return Promise.resolve(true); }
  isLoading() { return this.loading; }
  isDestroyed() { return this.destroyed; }
  setWindowOpenHandler(handler) { this.popup = handler; }
  stop() { this.stopped = true; this.loading = false; this.emit('did-stop-loading'); }
  reload() { this.reloaded = true; this.loading = true; }
  close(options) { this.closeOptions = options; this.destroyed = true; }
}

function fixture() {
  const views = [], changes = [], attached = [];
  const ses = new EventEmitter();
  Object.assign(ses, {
    setPermissionRequestHandler(handler) { this.requestPermission = handler; },
    setPermissionCheckHandler(handler) { this.checkPermission = handler; },
    setDevicePermissionHandler(handler) { this.devicePermission = handler; },
    webRequest:{onBeforeRequest(handler) { this.before = handler; }},
  });
  const window = {
    isDestroyed:() => false,
    getContentSize:() => [1000, 700],
    contentView:{
      addChildView(view) { attached.push(view); },
      removeChildView(view) { attached.splice(attached.indexOf(view), 1); },
    },
  };
  class View {
    constructor(options) { this.options = options; this.webContents = new Contents(); views.push(this); }
    setBounds(bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds || {x:0,y:0,width:0,height:0}; }
    setVisible(visible) { this.visible = visible; }
    setBackgroundColor(color) { this.color = color; }
  }
  const browser = new DesktopBrowser({WebContentsView:View, session:{fromPartition(name) { assert.equal(name, BROWSER_PARTITION); return ses; }}, getWindow:() => window, onChange:value => changes.push(value)});
  return {browser, views, changes, attached, ses, window};
}

function event(url, isMainFrame = true) {
  return {url, isMainFrame, prevented:false, preventDefault() { this.prevented = true; }};
}

test('browser address input supports real web URLs and local developer previews', () => {
  assert.equal(normalizeBrowserUrl('example.com/docs'), 'https://example.com/docs');
  assert.equal(normalizeBrowserUrl(' https://example.com:443/a?q=1 '), 'https://example.com/a?q=1');
  assert.equal(normalizeBrowserUrl('localhost:3000'), 'http://localhost:3000/');
  assert.equal(normalizeBrowserUrl('127.0.0.1:8317/management.html'), 'http://127.0.0.1:8317/management.html');
  assert.equal(normalizeBrowserUrl('[::1]:8080'), 'http://[::1]:8080/');
  assert.equal(normalizeBrowserUrl('http://192.168.1.20:8080'), 'http://192.168.1.20:8080/');
});

test('address parser rejects executable and privileged schemes, credentials and malformed values', () => {
  for (const value of ['javascript:alert(1)', 'file:///C:/secret', 'data:text/html,hello', 'being://app/', 'about:blank', 'chrome://settings', 'devtools://a', '//evil.test/', 'https://user:password@example.com', 'https://user@example.com', 'https:example.com', 'example.com\n.evil.test', 'search some text', 'localhost:999999', '', null, {}, 4, 'x'.repeat(9000)]) {
    assert.throws(() => normalizeBrowserUrl(value), undefined, String(value));
  }
});

test('browser creates an isolated sandboxed page without privileged preload or homepage requests', () => {
  const {browser, views} = fixture();
  const state = browser.newTab();
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].url, '');
  assert.equal(views[0].webContents.pending.length, 0);
  const preferences = views[0].options.webPreferences;
  for (const key of ['sandbox', 'contextIsolation', 'webSecurity']) assert.equal(preferences[key], true);
  for (const key of ['nodeIntegration', 'nodeIntegrationInSubFrames', 'nodeIntegrationInWorker', 'webviewTag', 'navigateOnDragDrop', 'allowRunningInsecureContent']) assert.equal(preferences[key], false);
  assert.equal(Object.hasOwn(preferences, 'preload'), false);
  browser.destroy();
});

test('viewport attaches only the active page and clips dimensions to the host window', () => {
  const {browser, views, attached} = fixture();
  browser.setViewport({visible:true, bounds:{x:200.9, y:100.9, width:9999, height:9999}});
  const first = browser.newTab({url:'https://example.com'}).activeTabId;
  const second = browser.newTab({url:'https://example.org'}).activeTabId;
  assert.deepEqual(attached, [views[1]]);
  assert.equal(views[0].visible, false);
  assert.deepEqual(views[1].bounds, {x:200, y:100, width:800, height:600});
  browser.activateTab(first);
  assert.deepEqual(attached, [views[0]]);
  browser.setViewport({visible:false});
  assert.deepEqual(attached, []);
  browser.closeTab(second);
  assert.equal(views[1].webContents.destroyed, true);
  browser.closeTab(first);
  assert.deepEqual(browser.snapshot().tabs, []);
  assert.equal(browser.snapshot().activeTabId, null);
  browser.destroy();
});

test('history, loading, title, reload and stop reflect the active browser tab', () => {
  const {browser, views} = fixture();
  browser.newTab({url:'example.com'});
  const wc = views[0].webContents;
  assert.equal(browser.snapshot().tabs[0].isLoading, true);
  wc.finish('First page');
  assert.equal(browser.snapshot().tabs[0].title, 'First page');
  assert.equal(browser.snapshot().tabs[0].isLoading, false);
  browser.navigate({url:'example.org'});
  wc.finish('Second page');
  assert.equal(browser.snapshot().tabs[0].canGoBack, true);
  browser.goBack();
  assert.equal(browser.snapshot().tabs[0].url, 'https://example.com/');
  assert.equal(browser.snapshot().tabs[0].canGoForward, true);
  browser.goForward();
  assert.equal(browser.snapshot().tabs[0].url, 'https://example.org/');
  browser.reload();
  assert.equal(wc.reloaded, true);
  browser.stop();
  assert.equal(wc.stopped, true);
  assert.equal(browser.snapshot().tabs[0].isLoading, false);
  browser.destroy();
});

test('all frame navigations and redirects enforce the protocol boundary', () => {
  const {browser, views, ses} = fixture();
  browser.newTab({url:'https://example.com'});
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
    const blocked = event('being://app/index.html');
    views[0].webContents.emit(name, blocked);
    assert.equal(blocked.prevented, true, name);
    const allowed = event('http://localhost:3000');
    views[0].webContents.emit(name, allowed);
    assert.equal(allowed.prevented, false, name);
  }
  const frame = event('file:///C:/secret', false);
  views[0].webContents.emit('will-frame-navigate', frame);
  assert.equal(frame.prevented, true);
  let intercepted;
  ses.webRequest.before({url:'being://app/', resourceType:'mainFrame'}, value => { intercepted = value; });
  assert.deepEqual(intercepted, {cancel:true});
  ses.webRequest.before({url:'https://example.com/script.js', resourceType:'script'}, value => { intercepted = value; });
  assert.deepEqual(intercepted, {cancel:false});
  const attach = event('https://example.org');
  views[0].webContents.emit('will-attach-webview', attach);
  assert.equal(attach.prevented, true);
  browser.destroy();
});

test('website popups become safe internal tabs and never native windows', async () => {
  const {browser, views} = fixture();
  const first = browser.newTab({url:'https://example.com'}).activeTabId;
  assert.deepEqual(views[0].webContents.popup({url:'https://example.org', disposition:'background-tab'}), {action:'deny'});
  await Promise.resolve();
  assert.equal(browser.snapshot().tabs.length, 2);
  assert.equal(browser.snapshot().activeTabId, first);
  assert.deepEqual(views[0].webContents.popup({url:'javascript:alert(1)'}), {action:'deny'});
  assert.deepEqual(views[0].webContents.popup({url:'file:///C:/secret'}), {action:'deny'});
  await Promise.resolve();
  assert.equal(browser.snapshot().tabs.length, 2);
  browser.destroy();
});

test('browser pages cannot request native permissions, devices or downloads', () => {
  const {browser, views, ses} = fixture();
  browser.newTab({url:'https://example.com'});
  let granted;
  ses.requestPermission(views[0].webContents, 'media', value => { granted = value; });
  assert.equal(granted, false);
  assert.equal(ses.checkPermission(), false);
  assert.equal(ses.devicePermission(), false);
  const download = event('https://example.com/file');
  ses.emit('will-download', download, {}, views[0].webContents);
  assert.equal(download.prevented, true);
  assert.match(browser.snapshot().tabs[0].notice, /下载/);
  assert.equal(browser.snapshot().tabs[0].error, '');
  browser.destroy();
});

test('UI snapshots redact credentials and contain no contents objects or page body', () => {
  const {browser, views} = fixture();
  browser.newTab({url:'https://example.com/?token=private-fixture&query=visible&api_key=secret-fixture#access_token=hidden-fixture'});
  views[0].webContents.finish('Public title');
  const value = JSON.stringify(browser.snapshot());
  assert.equal(value.includes('private-fixture'), false);
  assert.equal(value.includes('secret-fixture'), false);
  assert.equal(value.includes('hidden-fixture'), false);
  assert.match(value, /query=visible/);
  assert.deepEqual(Object.keys(browser.snapshot().tabs[0]), ['id', 'title', 'url', 'isLoading', 'canGoBack', 'canGoForward', 'error', 'notice', 'revision']);
  assert.match(views[0].webContents.getURL(), /token=private-fixture/);
  views[0].webContents.finish('https://example.com/?token=private-fixture');
  assert.equal(JSON.stringify(browser.snapshot()).includes('private-fixture'), false);
  browser.destroy();
});

test('stale page failures and closed-tab failures cannot overwrite a newer navigation', async () => {
  const {browser, views} = fixture();
  browser.newTab({url:'https://example.com/old'});
  const wc = views[0].webContents, old = wc.pending[0];
  browser.navigate({url:'https://example.com/new'});
  wc.finish();
  old.reject(new Error('secret-fixture in an obsolete network error'));
  await Promise.resolve();
  assert.equal(browser.snapshot().tabs[0].error, '');
  browser.navigate({url:'https://example.com/closed'});
  const pending = wc.pending.at(-1);
  browser.closeTab(browser.snapshot().activeTabId);
  pending.reject(new Error('secret-fixture after closing'));
  await Promise.resolve();
  assert.deepEqual(browser.snapshot().tabs, []);
  browser.destroy();
});

test('failed main frames show a sanitized error while aborted loads and subframes stay quiet', () => {
  const {browser, views} = fixture();
  browser.newTab({url:'https://example.com'});
  const wc = views[0].webContents;
  wc.emit('did-fail-load', {}, -3, 'secret-fixture', 'https://example.com', true);
  assert.equal(browser.snapshot().tabs[0].error, '');
  wc.emit('did-fail-load', {}, -105, 'secret-fixture', 'https://example.com', false);
  assert.equal(browser.snapshot().tabs[0].error, '');
  wc.emit('did-fail-load', {}, -105, 'secret-fixture', 'https://example.com', true);
  assert.match(browser.snapshot().tabs[0].error, /找不到/);
  assert.equal(JSON.stringify(browser.snapshot()).includes('secret-fixture'), false);
  browser.destroy();
});

test('invalid commands and viewport values leave the browser unchanged', () => {
  const {browser} = fixture();
  browser.newTab();
  const before = browser.snapshot();
  for (const operation of [
    () => browser.newTab({active:'yes'}),
    () => browser.newTab(null),
    () => browser.activateTab({}),
    () => browser.closeTab('missing'),
    () => browser.navigate({url:'file:///secret'}),
    () => browser.setViewport({visible:1, bounds:{x:0, y:0, width:10, height:10}}),
    () => browser.setViewport({visible:true, bounds:{x:0, y:-1, width:10, height:10}}),
    () => browser.setViewport({visible:true, bounds:{x:0, y:0, width:NaN, height:10}}),
    () => browser.setViewport({visible:true, bounds:{x:0, y:0, width:100001, height:10}}),
  ]) assert.throws(operation);
  assert.deepEqual(browser.snapshot(), before);
  browser.destroy();
});

test('tab limits and disposal release all page resources without beforeunload prompts', () => {
  const {browser, views, ses} = fixture();
  for (let i = 0; i < MAX_BROWSER_TABS; i++) browser.newTab();
  assert.throws(() => browser.newTab(), /最多/);
  browser.destroy();
  browser.destroy();
  assert.equal(ses.listenerCount('will-download'), 0);
  assert.equal(ses.webRequest.before, null);
  for (const view of views) {
    assert.equal(view.webContents.destroyed, true);
    assert.deepEqual(view.webContents.closeOptions, {waitForBeforeUnload:false});
    assert.equal(view.webContents.eventNames().length, 0);
  }
  assert.throws(() => browser.newTab(), /已经关闭/);
});

test('structured operations reject stale revisions, loading pages and invalid parameters before execution', async () => {
  const {browser, views} = fixture();
  browser.newTab({url:'https://example.com'});
  const first = browser.snapshot().tabs[0];
  assert.equal(first.revision, 1);
  await assert.rejects(browser.readPage(first.id, first.revision), /加载/);
  views[0].webContents.finish();
  browser.tabs.get(first.id).documentToken = 'synthetic-fixture-context';
  browser.navigate({url:'https://example.org'});
  assert.equal(browser.snapshot().tabs[0].revision, 2);
  await assert.rejects(browser.readPage(first.id, first.revision), /页面已变化/);
  await assert.rejects(browser.click({id:first.id,selector:'#note',expectedRevision:1}), /页面已变化/);
  await assert.rejects(browser.fill({id:first.id,selector:'#note',text:'private-fixture',expectedRevision:1}), /页面已变化/);
  await assert.rejects(browser.screenshot(first.id, 1), /页面已变化/);
  await assert.rejects(browser.click({selector:'x'.repeat(513)}), /选择器/);
  await assert.rejects(browser.fill({selector:'#note',text:'x'.repeat(8001)}), /8000/);
  await assert.rejects(browser.fill({selector:'#note',text:42}), /填写内容/);
  browser.destroy();
});

test('screenshots bound the native bitmap and discard an image captured across navigation', async () => {
  const {browser, views} = fixture();
  browser.setViewport({visible:true,bounds:{x:0,y:0,width:1000,height:700}});
  const first = browser.newTab({url:'https://example.com'}).activeTabId;
  views[0].webContents.finish();
  browser.tabs.get(first).documentToken = 'synthetic-fixture-context';
  const png = Buffer.from([137,80,78,71,13,10,26,10]);
  const bitmap = (width, height) => ({isEmpty:() => false,getSize:() => ({width,height}),resize:({width:w,height:h}) => bitmap(w,h),toPNG:() => png});
  views[0].webContents.capturePage = async (_rect, options) => {
    assert.equal(options.stayHidden, true);
    return bitmap(3200,2000);
  };
  const capture = await browser.screenshot(first, 1);
  assert.equal(capture.width, 1600);
  assert.equal(capture.height, 1000);
  assert.equal(capture.mimeType, 'image/png');
  assert.equal(capture.data, png.toString('base64'));
  views[0].webContents.capturePage = async () => { browser.navigate({id:first,url:'https://example.org'}); return bitmap(800,600); };
  await assert.rejects(browser.screenshot(first, 1), /页面已变化/);
  browser.destroy();
});

test('blocked navigation, downloads and popups keep a committed page visible and usable', async () => {
  const {browser, views, ses, attached} = fixture();
  browser.setViewport({visible:true,bounds:{x:0,y:0,width:800,height:600}});
  const id = browser.newTab({url:'https://example.com'}).activeTabId;
  const wc = views[0].webContents;
  wc.finish();
  wc.emit('did-start-navigation', {url:'mailto:fixture@example.test',isMainFrame:true,isSameDocument:false});
  const blocked = event('mailto:fixture@example.test');
  wc.emit('will-navigate', blocked);
  await Promise.resolve();
  assert.equal(blocked.prevented, true);
  assert.equal(browser.snapshot().tabs[0].error, '');
  assert.match(browser.snapshot().tabs[0].notice, /已阻止/);
  assert.ok(browser.tabs.get(id).documentToken);
  assert.deepEqual(attached, [views[0]]);
  assert.equal(views[0].visible, true);
  const download = event('https://example.com/file');
  ses.emit('will-download', download, {}, wc);
  assert.equal(browser.snapshot().tabs[0].error, '');
  assert.match(browser.snapshot().tabs[0].notice, /下载/);
  wc.popup({url:'javascript:alert(1)'});
  assert.equal(browser.snapshot().tabs[0].error, '');
  assert.match(browser.snapshot().tabs[0].notice, /弹出窗口/);
  assert.equal(views[0].visible, true);
  browser.navigate({id,url:'https://example.org'});
  assert.equal(browser.snapshot().tabs[0].notice, '');
  browser.destroy();
});

test('a blocked redirect with no committed page remains a fatal load error', () => {
  const {browser, views} = fixture();
  browser.newTab({url:'https://example.com/redirect'});
  views[0].webContents.emit('will-redirect', event('being://app/index.html'));
  assert.match(browser.snapshot().tabs[0].error, /已阻止/);
  assert.equal(browser.snapshot().tabs[0].notice, '');
  browser.destroy();
});
