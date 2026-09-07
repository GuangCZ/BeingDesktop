'use strict';

// Exercise the shipped renderer in Electron, using only fixed, local IPC data.
// A fresh profile and denied network keep this independent of the installed app.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const renderer = path.join(root, 'renderer');
  const runRoot = path.join(root, '.local', `window-chrome-${randomUUID()}`);
  const fixture = path.join(runRoot, 'fixture.html');
  const preload = path.join(runRoot, 'preload.cjs');
  const report = {
    scope: 'Actual index.html, styles, app.js and town-app.js; isolated fixed preload; no user data or services.',
    checks: [], screenshots: [], observations: [], errors: [],
  };
  const identity = { beingId: 'preview-being', displayName: 'preview_being', identityRevision: 1, connectionRevision: 1 };
  const townState = { identity, access: { fireside: 'ready', bonfire: 'ready' } };
  const fixtureState = {
    version: require('../package.json').version,
    connection: { configured: true, beingName: 'preview_being', displayUrl: 'https://fixture.invalid/loom/', status: 'connected' },
    machine: { hostname: 'Preview PC', user: 'Preview' },
    workspace: { path: '', files: [] },
    townApp: townState,
  };
  const calls = [];
  let win;
  let blockedRequests = 0;
  let latestPaint;
  let frameSequence = 0;
  let windowState = { maximized: false, fullscreen: false };
  app.setPath('userData', path.join(runRoot, 'profile'));
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  const check = (name, passed, detail) => report.checks.push({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) });
  const execute = script => {
    assert.equal(win.webContents.getURL(), pathToFileURL(fixture).href);
    return win.webContents.executeJavaScript(script);
  };
  const settle = () => execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const snapshot = `(() => {
    const rect = element => {
      if (!element) return null;
      const r=element.getBoundingClientRect(),style=getComputedStyle(element);
      const visible=Boolean(element.getClientRects().length)&&style.visibility!=='hidden';
      const hit=visible&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,visible,
        hit:Boolean(hit&&element.contains(hit)),appRegion:style.getPropertyValue('-webkit-app-region'),
        background:style.backgroundColor,disabled:Boolean(element.disabled),label:element.getAttribute('aria-label'),
        expanded:element.getAttribute('aria-expanded'),text:element.textContent.trim()};
    };
    const get=selector=>rect(document.querySelector(selector));
    return {width:innerWidth,height:innerHeight,bodyWidth:document.documentElement.scrollWidth,bodyHeight:document.documentElement.scrollHeight,
      titlebar:get('.titlebar'),navigation:get('.titlebar-navigation'),toolbar:get('.workspace-toolbar'),main:get('.main-area'),
      sidebar:get('#sidebar'),inspector:get('#inspector'),content:get('#content-grid'),title:get('#page-title'),actions:get('.header-actions'),
      drag:get('.titlebar-drag-space'),controls:get('.window-controls'),
      titleButtons:[...document.querySelectorAll('.titlebar button')].map(element=>({id:element.id,menu:element.dataset.appMenu,...rect(element)})),
      sidebarButton:get('#toggle-sidebar'),inspectorButton:get('#toggle-inspector'),back:get('#navigate-back'),forward:get('#navigate-forward'),
      maximizeIcon:document.querySelector('#window-maximize use')?.getAttribute('href'),maximizeLabel:document.querySelector('#window-maximize')?.getAttribute('aria-label'),
      page:document.body.dataset.page,module:document.getElementById('page-town-app').dataset.townModule||'',
      selectedFeature:document.querySelector('.town-sidebar-feature[aria-current="true"]')?.dataset.townFeature||'',
      townModuleVisible:!document.getElementById('page-town-app').hidden,
      focusedMenu:document.activeElement.dataset.appMenu||''};
  })()`;

  async function capture(name) {
    const size = await execute('({width:innerWidth,height:innerHeight})');
    let previousHash = '';
    let output;
    for (let attempt = 0; attempt < 30; attempt++) {
      const previousFrame = frameSequence;
      const painted = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { win.webContents.removeListener('paint', listener); reject(new Error('Offscreen paint timed out.')); }, 3000);
        const listener = () => {
          if (frameSequence > previousFrame) { clearTimeout(timer); win.webContents.removeListener('paint', listener); resolve(latestPaint); }
        };
        win.webContents.on('paint', listener);
      });
      win.webContents.invalidate();
      const image = await painted;
      const actual = image.getSize();
      if (actual.width !== size.width || actual.height !== size.height) { await settle(); continue; }
      const hash = createHash('sha256').update(image.crop({ x: 0, y: 0, width: size.width, height: 90 }).toBitmap()).digest('hex');
      if (hash === previousHash) { output = image; break; }
      previousHash = hash;
      await settle();
    }
    if (!output && latestPaint) await fs.writeFile(path.join(runRoot, 'unsettled.png'), latestPaint.toPNG());
    assert(output, `Window chrome did not settle at ${size.width}x${size.height}; latest paint was ${JSON.stringify(latestPaint?.getSize())}.`);
    const outputPath = path.join(runRoot, `${name}.png`);
    await fs.writeFile(outputPath, output.toPNG());
    report.screenshots.push(outputPath);
    if (name === 'wide-1440x940') {
      const previewPath = path.join(runRoot, 'topbar-preview.png');
      const preview = await win.webContents.capturePage({ x: 0, y: 0, width: 1440, height: 160 });
      await fs.writeFile(previewPath, preview.toPNG());
      report.screenshots.push(previewPath);
    }
  }

  async function click(selector) {
    const point = await execute(`(() => {
      const element=document.querySelector(${JSON.stringify(selector)});
      if(!element)throw new Error('Missing click target: '+${JSON.stringify(selector)});
      element.scrollIntoView({block:'nearest'});
      const r=element.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
      if(element.disabled||!element.contains(document.elementFromPoint(x,y)))throw new Error('Click target is disabled or obscured: '+${JSON.stringify(selector)});
      return {x:Math.round(x),y:Math.round(y)};
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await settle();
  }

  async function key(key, { selector, alt = false } = {}) {
    if (selector) await execute(`document.querySelector(${JSON.stringify(selector)}).focus({preventScroll:true})`);
    const codes = { ArrowLeft: 37, ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 27, ' ': 32, Home: 36, End: 35, F10: 121 };
    const event = { key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: codes[key] || key.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: codes[key] || key.toUpperCase().charCodeAt(0), modifiers: alt ? 1 : 0 };
    if (key === 'Enter' || key === ' ') { event.text = key === 'Enter' ? '\r' : ' '; event.unmodifiedText = event.text; }
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...event, text: '', unmodifiedText: '' });
    await settle();
  }

  function checkLayout(name, value) {
    report.observations.push({ phase: name, ...value });
    check(`${name}-titlebar-is-46px-full-width`, value.titlebar.y === 0 && value.titlebar.x === 0 && value.titlebar.height === 46 && value.titlebar.width === value.width, value.titlebar);
    check(`${name}-workspace-toolbar-is-second-row`, value.toolbar.y === 46 && value.toolbar.height === 44 && value.toolbar.x === value.main.x && value.toolbar.right === value.width, value.toolbar);
    check(`${name}-content-starts-below-toolbar`, value.content.y === 90 && value.content.bottom <= value.height, value.content);
    check(`${name}-window-controls-right-aligned`, value.controls.right === value.width && value.controls.y >= 0 && value.controls.bottom <= 46, value.controls);
    check(`${name}-toolbar-context-does-not-overlap-actions`, value.title.right <= value.actions.x && value.actions.right <= value.toolbar.right, { title: value.title, actions: value.actions });
    check(`${name}-top-navigation-does-not-overlap-window-controls`, value.navigation.right <= value.controls.x && value.navigation.y >= 0 && value.navigation.bottom <= 46);
    const buttons = value.titleButtons.filter(button => button.visible);
    check(`${name}-titlebar-buttons-fit-and-do-not-overlap`, buttons.every((button, index) => button.y >= 0 && button.bottom <= 46 && button.right <= value.width && buttons.every((other, otherIndex) => index === otherIndex || button.right <= other.x || other.right <= button.x)), buttons);
    check(`${name}-clickable-controls-are-no-drag`, buttons.every(button => button.appRegion === 'no-drag'), buttons.map(({ id, menu, appRegion }) => ({ id, menu, appRegion })));
    check(`${name}-retains-empty-drag-space`, value.drag && value.drag.appRegion === 'drag' && value.drag.width > 120, value.drag);
    check(`${name}-no-window-overflow`, value.bodyWidth <= value.width && value.bodyHeight <= value.height);
  }

  async function checkRoute(name, page, feature = '') {
    const value = await execute(snapshot);
    check(name, value.page === page && (!feature || (value.selectedFeature === feature && (page !== 'town-app' || (value.module === feature && value.townModuleVisible)))), { page: value.page, module: value.module, selectedFeature: value.selectedFeature, title: value.title.text });
    return value;
  }

  async function run() {
    await fs.mkdir(runRoot, { recursive: true });
    const source = await fs.readFile(path.join(renderer, 'index.html'), 'utf8');
    const html = source.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
      .replace('<head>', `<head><base href="${pathToFileURL(renderer + path.sep).href}">`)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
      .replace('</head>', '<script src="town-app.js" defer></script><script src="app.js" defer></script></head>');
    await fs.writeFile(fixture, html);
    await fs.writeFile(preload, `'use strict';
      const {contextBridge,ipcRenderer}=require('electron');
      const bridge={};
      for(const method of ['getState','refresh','getTownCatalog','getTownAppState','getFiresides','getTownMessageSnapshot','getBeingMembers','setView','openAppMenu','getWindowState','minimize','maximize','close'])
        bridge[method]=value=>ipcRenderer.invoke('chrome-fixture:call',method,value);
      for(const [name,channel] of [['onState','state'],['onWindowState','window-state'],['onCommand','command']])
        bridge[name]=callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('chrome-fixture:'+channel,listener);return()=>ipcRenderer.removeListener('chrome-fixture:'+channel,listener);};
      contextBridge.exposeInMainWorld('beingDesktop',bridge);`);
    await app.whenReady();
    ipcMain.handle('chrome-fixture:call', (_event, method, value) => {
      const call = { method, value };
      calls.push(call);
      if (method === 'getState' || method === 'refresh') return fixtureState;
      if (method === 'getTownCatalog') return require('../src/town.cjs').getTownCatalog();
      if (method === 'getTownAppState') return townState;
      if (method === 'getFiresides') return { owned: [], joined: [] };
      if (method === 'getBeingMembers') return { members: [{ id: 'preview-being', name: 'preview_being' }, { id: 'studio-being', name: 'Studio' }] };
      if (method === 'getTownMessageSnapshot') return { kind: value.kind, firesideId: value.firesideId || '', snapshot: { identity, latestSeq: 1, messages: [{ id: '1', beingId: 'studio-being', beingName: 'Studio', content: '今天一起把桌面工作区整理得更顺手。', at: '2026-09-06T12:00:00.000Z' }] }, status: { status: 'ready', lastSuccessAt: '2026-09-06T12:00:00.000Z', stale: false } };
      if (method === 'getWindowState') return windowState;
      if (method === 'openAppMenu') return execute('document.activeElement.id').then(focusedId => { call.focusedId = focusedId; return {}; });
      return {};
    });
    win = new BrowserWindow({ show: false, frame: false, width: 1440, height: 940, useContentSize: true,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: `window-chrome-${randomUUID()}` } });
    win.webContents.on('paint', (_event, _dirty, image) => { frameSequence++; latestPaint = image; });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    win.webContents.setFrameRate(30);
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      if (details.url.startsWith('file:')) {
        const file = fileURLToPath(details.url);
        allowed = file === fixture || file.startsWith(renderer + path.sep);
      }
      if (!allowed) blockedRequests++;
      callback({ cancel: !allowed });
    });
    await win.loadFile(fixture);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    win.webContents.focus();
    await execute(`new Promise((resolve,reject)=>{
      const ready=()=>document.querySelector('.town-sidebar-feature[data-town-feature="bonfire"]')&&document.getElementById('sidebar-being-name').textContent==='preview_being';
      if(ready())return resolve();
      const observer=new MutationObserver(()=>{if(ready()){clearTimeout(timer);observer.disconnect();resolve();}});
      const timer=setTimeout(()=>{observer.disconnect();reject(new Error('Offline renderer did not mount.'));},5000);
      observer.observe(document.body,{subtree:true,childList:true,characterData:true});
    })`);
    await execute('document.fonts.ready');
    await settle();
    let value = await execute(snapshot);
    check('history-starts-with-disabled-arrows', value.back.disabled && value.forward.disabled);
    check('menu-labels-match-reference', value.titleButtons.filter(button => button.menu).map(button => button.text).join(',') === '文件,编辑,视图,帮助');
    await click('.nav-button[data-page="workspace"]');
    await checkRoute('workspace-navigation', 'workspace');
    await click('.nav-button[data-page="settings"]');
    await click('#navigate-back');
    await checkRoute('pointer-back-restores-workspace', 'workspace');
    await key('ArrowLeft', { alt: true });
    value = await checkRoute('alt-left-restores-chat', 'chat');
    check('history-beginning-disables-back', value.back.disabled && !value.forward.disabled);
    await key('ArrowRight', { alt: true });
    await checkRoute('alt-right-restores-workspace', 'workspace');
    await click('#navigate-forward');
    value = await checkRoute('pointer-forward-restores-settings', 'settings');
    check('history-end-disables-forward', !value.back.disabled && value.forward.disabled);
    await click('.town-sidebar-feature[data-town-feature="bonfire"]');
    await checkRoute('opens-real-bonfire-module', 'town-app', 'bonfire');
    await click('.town-sidebar-feature[data-town-feature="fireside"]');
    await checkRoute('opens-real-fireside-module', 'town-app', 'fireside');
    await click('#navigate-back');
    await checkRoute('back-restores-bonfire-module-content', 'town-app', 'bonfire');
    await click('#navigate-forward');
    await checkRoute('forward-restores-fireside-module-content', 'town-app', 'fireside');
    await click('#navigate-back');
    await click('.nav-button[data-page="chat"]');
    value = await execute(snapshot);
    check('new-navigation-discards-forward-history', value.forward.disabled);
    await click('.nav-button[data-page="chat"]');
    await click('#navigate-back');
    await checkRoute('repeated-route-does-not-duplicate-history', 'town-app', 'bonfire');
    await execute(`new Promise((resolve,reject)=>{
      const ready=()=>document.querySelector('.ta-bonfire .ta-message');
      if(ready())return resolve();
      const observer=new MutationObserver(()=>{if(ready()){clearTimeout(timer);observer.disconnect();resolve();}});
      const timer=setTimeout(()=>{observer.disconnect();reject(new Error('Fixed Bonfire messages did not render.'));},5000);
      observer.observe(document.getElementById('page-town-app'),{subtree:true,childList:true});
    })`);

    for (const [name, width, height] of [['wide', 1440, 940], ['minimum', 1000, 700]]) {
      win.setContentSize(width, height);
      await settle();
      const before = await execute(snapshot);
      checkLayout(name, before);
      await execute('document.activeElement.blur()');
      await capture(`${name}-${width}x${height}`);
      await click('#toggle-sidebar');
      value = await execute(snapshot);
      check(`${name}-sidebar-collapse-frees-full-workspace-width`, !value.sidebar.visible && value.main.x === 0 && value.toolbar.x === 0 && value.sidebarButton.expanded === 'false');
      check(`${name}-sidebar-toggle-keeps-titlebar-position`, value.navigation.x === before.navigation.x && value.navigation.width === before.navigation.width);
      await click('#toggle-sidebar');
      value = await execute(snapshot);
      check(`${name}-sidebar-expand-restores-workspace-position`, value.sidebar.visible && value.main.x === before.main.x && value.sidebarButton.expanded === 'true');
      await click('#toggle-inspector');
      value = await execute(snapshot);
      check(`${name}-inspector-opens-below-workspace-toolbar`, value.inspector.visible && value.inspector.y >= 90 && value.inspector.bottom <= height && value.inspectorButton.expanded === 'true', value.inspector);
      check(`${name}-inspector-toggle-preserves-toolbar`, value.toolbar.x === before.toolbar.x && value.toolbar.width === before.toolbar.width);
      await capture(`${name}-inspector`);
      await click('#toggle-inspector');
    }

    for (const menu of ['file', 'edit', 'view', 'help']) {
      const selector = `[data-app-menu="${menu}"]`;
      const rect = await execute(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,bottom:r.bottom};})()`);
      const count = calls.filter(call => call.method === 'openAppMenu').length;
      await click(selector);
      const menuCalls = calls.filter(call => call.method === 'openAppMenu');
      const payload = menuCalls.at(-1)?.value;
      check(`${menu}-menu-opens-at-button-bottom`, menuCalls.length === count + 1 && payload?.menu === menu && Math.abs(payload.x - rect.x) <= 1 && Math.abs(payload.y - rect.bottom) <= 1, payload);
    }
    await key('ArrowRight', { selector: '[data-app-menu="file"]' });
    check('menu-arrow-right-moves-focus', (await execute(snapshot)).focusedMenu === 'edit');
    await key('ArrowLeft');
    check('menu-arrow-left-moves-focus', (await execute(snapshot)).focusedMenu === 'file');
    const menuCount = calls.filter(call => call.method === 'openAppMenu').length;
    await key('Enter', { selector: '[data-app-menu="help"]' });
    const menuCalls = calls.filter(call => call.method === 'openAppMenu');
    check('enter-opens-focused-menu', menuCalls.length === menuCount + 1 && menuCalls.at(-1)?.value?.menu === 'help');
    await execute("document.getElementById('bonfire-draft').focus({preventScroll:true})");
    await click('[data-app-menu="edit"]');
    check('pointer-menu-preserves-edit-target-focus', calls.filter(call => call.method === 'openAppMenu').at(-1)?.focusedId === 'bonfire-draft' && await execute("document.activeElement.id==='bonfire-draft'"));
    await key('F10');
    check('f10-focuses-first-menu', (await execute(snapshot)).focusedMenu === 'file');
    await key('ArrowRight');
    await key('ArrowDown');
    const keyboardMenu = calls.filter(call => call.method === 'openAppMenu').at(-1);
    check('keyboard-edit-menu-restores-editor-before-native-action', keyboardMenu?.value?.menu === 'edit' && keyboardMenu.focusedId === 'bonfire-draft');
    await key('Escape');
    check('escape-returns-from-menubar-to-editor', await execute("document.activeElement.id==='bonfire-draft'"));

    const normal = await execute(snapshot);
    windowState = { maximized: true, fullscreen: false };
    win.webContents.send('chrome-fixture:window-state', windowState);
    await settle();
    const maximized = await execute(snapshot);
    check('maximized-state-updates-icon-and-label', maximized.maximizeIcon !== normal.maximizeIcon && maximized.maximizeLabel !== normal.maximizeLabel && /还原|恢复/.test(maximized.maximizeLabel), { normal: { icon: normal.maximizeIcon, label: normal.maximizeLabel }, maximized: { icon: maximized.maximizeIcon, label: maximized.maximizeLabel } });
    windowState = { maximized: false, fullscreen: false };
    win.webContents.send('chrome-fixture:window-state', windowState);
    await settle();
    value = await execute(snapshot);
    check('restored-state-restores-icon-and-label', value.maximizeIcon === normal.maximizeIcon && value.maximizeLabel === normal.maximizeLabel);
    for (const [id, method] of [['window-minimize', 'minimize'], ['window-maximize', 'maximize'], ['window-close', 'close']]) {
      const count = calls.filter(call => call.method === method).length;
      await click(`#${id}`);
      check(`${id}-dispatches-bridge-action`, calls.filter(call => call.method === method).length === count + 1);
    }
    check('no-renderer-errors', report.errors.length === 0, report.errors);
    check('no-external-requests', blockedRequests === 0, blockedRequests);
    report.passed = report.checks.every(item => item.passed);
  }

  run().catch(error => { report.passed = false; report.error = error.stack || error.message; }).finally(async () => {
    await fs.mkdir(runRoot, { recursive: true });
    const reportPath = path.join(runRoot, 'report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify({ passed: report.passed, checks: report.checks.length, failed: report.checks.filter(item => !item.passed).map(item => item.name), report: reportPath, screenshots: report.screenshots, error: report.error || null })}\n`);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(report.passed ? 0 : 1);
  });
}
