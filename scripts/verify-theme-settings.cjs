'use strict';

// Exercise the shipped theme settings in an isolated Electron renderer. The
// fixture retains its own colors across reloads and never accesses user data.
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
  const runRoot = path.join(root, '.local', `theme-settings-${randomUUID()}`);
  const fixture = path.join(runRoot, 'fixture.html');
  const preload = path.join(runRoot, 'preload.cjs');
  const keys = ['background', 'sidebar', 'titlebar', 'surface', 'text', 'accent'];
  const report = {
    scope: 'Actual index.html, styles, theme-colors.js, theme-settings.js and app.js; isolated local IPC fixture; no user data or services.',
    checks: [], screenshots: [], observations: [], errors: [],
  };
  const fixtureState = {
    version: require('../package.json').version,
    connection: { configured: true, beingName: 'preview_being', displayUrl: 'https://fixture.invalid/loom/', status: 'connected' },
    machine: { hostname: 'Preview PC', user: 'Preview' },
    workspace: { path: '', files: [] },
    settings: { closeToTray: true, colors: {} },
  };
  const calls = [];
  let win;
  let blockedRequests = 0;
  let failNextSave = false;
  let latestPaint;
  let frameSequence = 0;
  app.setPath('userData', path.join(runRoot, 'profile'));
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  const check = (name, passed, detail) => report.checks.push({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) });
  const execute = script => {
    assert.equal(win.webContents.getURL(), pathToFileURL(fixture).href);
    return win.webContents.executeJavaScript(script);
  };
  const settle = () => execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const saveCalls = () => calls.filter(call => call.method === 'setColors');
  const equalColors = (left, right) => keys.every(key => left[key]?.toLowerCase() === right[key]?.toLowerCase());
  const rgb = hex => `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(', ')})`;
  const snapshot = `(() => {
    const rect = element => {
      if (!element) return null;
      const r=element.getBoundingClientRect(),s=getComputedStyle(element);
      return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,
        visible:!!element.getClientRects().length&&s.visibility!=='hidden',background:s.backgroundColor,color:s.color};
    };
    const keys=${JSON.stringify(keys)}, section=document.querySelector('#appearance-settings');
    return {width:innerWidth,height:innerHeight,bodyWidth:document.documentElement.scrollWidth,bodyHeight:document.documentElement.scrollHeight,
      page:document.body.dataset.page,section:rect(section),settings:rect(document.querySelector('#page-settings')),
      settingsOverflow:document.querySelector('#page-settings').scrollWidth>document.querySelector('#page-settings').clientWidth,
      background:rect(document.body),sidebar:rect(document.querySelector('#sidebar')),titlebar:rect(document.querySelector('.titlebar')),
      primary:rect(document.querySelector('#theme-save')),status:document.querySelector('#theme-status').textContent,
      busy:section.getAttribute('aria-busy')==='true',saveDisabled:document.querySelector('#theme-save').disabled,
      colors:Object.fromEntries(keys.map(key=>[key,document.querySelector('#theme-'+key+'-hex').value])),
      pickers:Object.fromEntries(keys.map(key=>[key,document.querySelector('#theme-'+key+'-picker').value])),
      controls:[...section.querySelectorAll('input,button')].map(element=>({id:element.id,preset:element.dataset.themePreset,disabled:element.disabled,label:element.getAttribute('aria-label'),...rect(element)})),
      variables:Object.fromEntries(['--background','--sidebar','--window-chrome','--surface','--text','--accent'].map(key=>[key,getComputedStyle(document.documentElement).getPropertyValue(key).trim()]))};
  })()`;

  async function waitFor(expression, message = 'Renderer did not reach expected state.') {
    await execute(`new Promise((resolve,reject)=>{
      const ready=()=>(${expression});
      if(ready())return resolve();
      const observer=new MutationObserver(()=>{if(ready()){clearTimeout(timer);observer.disconnect();resolve();}});
      const timer=setTimeout(()=>{observer.disconnect();reject(new Error(${JSON.stringify(message)}));},5000);
      observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true});
    })`);
    await settle();
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

  async function pasteHex(key, value) {
    await execute(`(()=>{const input=document.querySelector('#theme-${key}-hex');input.focus();input.select();})()`);
    await win.webContents.debugger.sendCommand('Input.insertText', { text: value });
    await settle();
  }

  async function setPicker(key, value) {
    await execute(`(()=>{const input=document.querySelector('#theme-${key}-picker');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await settle();
  }

  async function refreshState() {
    win.webContents.send('theme-fixture:state', structuredClone(fixtureState));
    await settle();
  }

  async function save() {
    await click('#theme-save');
    await waitFor("document.querySelector('#appearance-settings').getAttribute('aria-busy')!=='true'", 'Saving colors did not settle.');
  }

  async function capture(name) {
    await execute("document.activeElement.blur();document.querySelector('#settings-content').scrollTop=0");
    await settle();
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
      const hash = createHash('sha256').update(image.toBitmap()).digest('hex');
      if (hash === previousHash) { output = image; break; }
      previousHash = hash;
      await settle();
    }
    assert(output, `Theme settings did not settle at ${size.width}x${size.height}.`);
    const outputPath = path.join(runRoot, `${name}.png`);
    await fs.writeFile(outputPath, output.toPNG());
    report.screenshots.push(outputPath);
  }

  async function run() {
    await fs.mkdir(runRoot, { recursive: true });
    const source = await fs.readFile(path.join(renderer, 'index.html'), 'utf8');
    const html = source.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
      .replace('<head>', `<head><base href="${pathToFileURL(renderer + path.sep).href}">`)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
      .replace('</head>', '<script src="theme-colors.js" defer></script><script src="theme-settings.js" defer></script><script src="app.js" defer></script></head>');
    await fs.writeFile(fixture, html);
    await fs.writeFile(preload, `'use strict';
      const {contextBridge,ipcRenderer}=require('electron');
      const bridge={};
      for(const method of ['getState','refresh','getTownCatalog','setColors','setView','getWindowState','minimize','maximize','close'])
        bridge[method]=value=>ipcRenderer.invoke('theme-fixture:call',method,value);
      for(const [name,channel] of [['onState','state'],['onWindowState','window-state'],['onCommand','command']])
        bridge[name]=callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('theme-fixture:'+channel,listener);return()=>ipcRenderer.removeListener('theme-fixture:'+channel,listener);};
      contextBridge.exposeInMainWorld('beingDesktop',bridge);`);
    await app.whenReady();
    ipcMain.handle('theme-fixture:call', (_event, method, value) => {
      calls.push({ method, value });
      if (method === 'getState' || method === 'refresh') return structuredClone(fixtureState);
      if (method === 'getTownCatalog') return require('../src/town.cjs').getTownCatalog();
      if (method === 'getWindowState') return { maximized: false, fullscreen: false };
      if (method === 'setColors') {
        if (failNextSave) { failNextSave = false; throw new Error('配色保存失败，请重试。'); }
        fixtureState.settings.colors = structuredClone(value);
        return structuredClone(fixtureState);
      }
      return {};
    });
    win = new BrowserWindow({ show: false, frame: false, width: 1440, height: 940, useContentSize: true,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: `theme-settings-${randomUUID()}` } });
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
    await waitFor("document.querySelector('#appearance-settings')&&document.querySelector('#sidebar-being-name').textContent==='preview_being'", 'Offline renderer did not initialize theme settings.');
    await execute('document.fonts.ready');
    await click('.nav-button[data-page="settings"]');
    check('settings-open-on-general-with-one-visible-panel', await execute("document.querySelector('[data-settings-section=general]').getAttribute('aria-current')==='page'&&[...document.querySelectorAll('[data-settings-panel]')].filter(panel=>!panel.hidden).length===1"));
    await capture('general-1440x940');
    // Orchestration also documents permissions; use both terms to select Portal.
    await execute("const search=document.querySelector('#settings-search');search.value='Portal 权限';search.dispatchEvent(new Event('input'))");
    check('search-finds-portal-by-setting-content', await execute("[...document.querySelectorAll('[data-settings-section]')].filter(button=>!button.hidden).map(button=>button.dataset.settingsSection).join(',')==='portal'"));
    await execute("document.querySelector('#settings-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    check('search-enter-opens-result-and-focuses-heading', await execute("document.querySelector('#portal-settings').checkVisibility()&&document.activeElement.id==='settings-heading'"));
    await execute("document.querySelector('#settings-search').value='no-such-setting-938';document.querySelector('#settings-search').dispatchEvent(new Event('input'))");
    check('search-empty-result-is-announced', await execute("document.querySelector('.settings-search-empty').checkVisibility()"));
    await execute("document.querySelector('#settings-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    check('escape-clears-search-without-closing-settings', await execute("document.body.dataset.page==='settings'&&document.querySelector('#settings-search').value===''&&[...document.querySelectorAll('[data-settings-section]')].every(button=>!button.hidden)"));
    await click('[data-settings-section="general"]');
    await execute("document.querySelector('[data-settings-section=general]').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}))");
    check('navigation-end-focuses-last-category', await execute("document.activeElement.dataset.settingsSection==='about'"));
    await click('.settings-back');
    check('back-restores-app-and-settings-trigger-focus', await execute("document.body.dataset.page==='chat'&&document.activeElement.id==='header-settings'"));
    await execute('openPortalUpdateSettings()');
    check('portal-shortcut-reveals-correct-panel', await execute("document.body.dataset.page==='settings'&&document.querySelector('#portal-settings').checkVisibility()"));
    await click('[data-settings-section="appearance"]');
    let value = await execute(snapshot);
    const defaults = value.colors;
    check('appearance-section-is-visible-in-settings', value.page === 'settings' && value.section.visible);
    check('all-six-color-fields-initialize-valid-defaults', keys.every(key => /^#[0-9a-f]{6}$/i.test(defaults[key]) && defaults[key].toLowerCase() === value.pickers[key].toLowerCase()), defaults);
    check('clean-defaults-do-not-enable-save', value.saveDisabled);
    check('appearance-section-precedes-connection-settings', await execute("document.querySelector('#appearance-settings').compareDocumentPosition(document.querySelector('#settings-connect-form'))&Node.DOCUMENT_POSITION_FOLLOWING"));
    await capture('defaults-1440x940');

    const custom = { background: '#112233', sidebar: '#192d42', titlebar: '#243650', surface: '#2a4055', text: '#e1f2fa', accent: '#65c8a7' };
    for (const key of keys) {
      await setPicker(key, custom[key]);
      value = await execute(snapshot);
      check(`${key}-picker-updates-hex-live`, value.colors[key].toLowerCase() === custom[key], value.colors[key]);
    }
    check('preview-does-not-save-implicitly', saveCalls().length === 0);
    await click('[data-settings-section="general"]');
    await click('[data-settings-section="appearance"]');
    check('category-switch-preserves-unsaved-colors', equalColors((await execute(snapshot)).colors, custom) && saveCalls().length === 0);
    check('custom-background-applies-to-visible-body', value.background.background === rgb(custom.background), value.background.background);
    check('custom-sidebar-applies-to-visible-sidebar', value.sidebar.background === rgb(custom.sidebar), value.sidebar.background);
    check('custom-titlebar-applies-to-visible-titlebar', value.titlebar.background === rgb(custom.titlebar), value.titlebar.background);
    check('custom-text-applies-to-visible-body', value.background.color === rgb(custom.text), value.background.color);
    check('custom-accent-applies-to-primary-button', value.primary.background === rgb(custom.accent), value.primary);
    check('custom-surface-updates-shared-token', value.variables['--surface'].toLowerCase() === custom.surface, value.variables['--surface']);
    await refreshState();
    value = await execute(snapshot);
    check('unrelated-state-refresh-preserves-preview-and-draft', equalColors(value.colors, custom) && value.background.background === rgb(custom.background) && !value.saveDisabled, value.colors);
    await pasteHex('accent', '#AABBCC');
    await execute("document.querySelector('#theme-accent-hex').blur()");
    await settle();
    value = await execute(snapshot);
    custom.accent = '#aabbcc';
    check('hex-paste-updates-picker-and-live-button', value.colors.accent.toLowerCase() === custom.accent && value.pickers.accent.toLowerCase() === custom.accent && value.primary.background === rgb(custom.accent), { color: value.colors.accent, picker: value.pickers.accent, button: value.primary.background });
    for (const [key, pasted, normalized] of [['titlebar', '#246', '#224466'], ['sidebar', '203854', '#203854']]) {
      await pasteHex(key, pasted);
      await execute(`document.querySelector('#theme-${key}-hex').blur()`);
      await settle();
      custom[key] = normalized;
      value = await execute(snapshot);
      check(`${key}-hex-shorthand-normalizes-on-blur`, value.colors[key] === normalized && value.pickers[key] === normalized && value[key].background === rgb(normalized), { color: value.colors[key], picker: value.pickers[key], background: value[key].background });
    }
    await save();
    value = await execute(snapshot);
    check('save-sends-complete-custom-palette', saveCalls().length === 1 && equalColors(saveCalls()[0].value, custom), saveCalls()[0]?.value);
    check('saved-palette-clears-dirty-status', value.saveDisabled && /已保存|保存成功/.test(value.status), value.status);
    await capture('custom-1440x940');

    await win.loadFile(fixture);
    await waitFor("document.querySelector('#sidebar-being-name').textContent==='preview_being'", 'Reloaded renderer did not initialize.');
    await click('.nav-button[data-page="settings"]');
    await click('[data-settings-section="appearance"]');
    value = await execute(snapshot);
    check('saved-colors-survive-renderer-reload', equalColors(value.colors, custom) && value.background.background === rgb(custom.background) && value.titlebar.background === rgb(custom.titlebar), value.colors);
    await pasteHex('background', '#zzzzzz');
    value = await execute(snapshot);
    const beforeInvalid = saveCalls().length;
    await execute("document.querySelector('#theme-save').click()");
    await settle();
    check('invalid-hex-blocks-save', value.saveDisabled && saveCalls().length === beforeInvalid && /颜色|色值|十六|HEX|#[0-9a-f]/i.test(value.status), value.status);
    check('invalid-hex-keeps-last-valid-preview', value.background.background === rgb(custom.background), value.background.background);
    await refreshState();
    value = await execute(snapshot);
    check('state-refresh-preserves-invalid-draft-for-correction', value.colors.background === '#zzzzzz' && value.saveDisabled, value.colors.background);
    custom.background = '#182b3c';
    await pasteHex('background', custom.background);
    value = await execute(snapshot);
    check('corrected-hex-enables-save', !value.saveDisabled && value.background.background === rgb(custom.background));
    failNextSave = true;
    await save();
    value = await execute(snapshot);
    check('failed-save-keeps-draft-and-allows-retry', !value.saveDisabled && equalColors(value.colors, custom) && /失败|重试/.test(value.status) && !/已保存|保存成功/.test(value.status), value.status);
    check('failed-save-leaves-fixture-store-unchanged', fixtureState.settings.colors.background !== custom.background, fixtureState.settings.colors);
    await refreshState();
    value = await execute(snapshot);
    check('state-refresh-after-failure-keeps-retry-draft', equalColors(value.colors, custom) && !value.saveDisabled, value.colors);
    await save();
    value = await execute(snapshot);
    check('retry-persists-draft-successfully', equalColors(fixtureState.settings.colors, custom) && value.saveDisabled && /已保存|保存成功/.test(value.status), value.status);
    const beforeCancel = saveCalls().length;
    await setPicker('accent', '#77ccbb');
    await pasteHex('text', '#oops');
    await click('#theme-cancel');
    value = await execute(snapshot);
    check('cancel-discards-valid-and-invalid-edits-without-saving', equalColors(value.colors, custom) && value.saveDisabled && value.primary.background === rgb(custom.accent) && saveCalls().length === beforeCancel, { colors: value.colors, status: value.status });

    const presets = await execute("[...document.querySelectorAll('[data-theme-preset]')].map(element=>({id:element.dataset.themePreset,label:element.textContent.trim()}))");
    check('preset-choices-are-available', presets.length >= 2, presets);
    for (const preset of presets) {
      const count = saveCalls().length;
      await click(`[data-theme-preset="${preset.id}"]`);
      value = await execute(snapshot);
      check(`preset-${preset.id}-previews-without-writing`, saveCalls().length === count && keys.every(key => /^#[0-9a-f]{6}$/i.test(value.colors[key])) && value.background.background === rgb(value.colors.background), value.colors);
      if (preset.id === 'light') await capture('light-1440x940');
    }
    failNextSave = true;
    const beforeReset = saveCalls().length;
    await click('#theme-reset');
    await waitFor("document.querySelector('#appearance-settings').getAttribute('aria-busy')!=='true'", 'Reset colors did not settle.');
    value = await execute(snapshot);
    check('failed-reset-keeps-default-preview-and-allows-retry', equalColors(value.colors, defaults) && !value.saveDisabled && /失败|重试/.test(value.status) && !/已保存|保存成功/.test(value.status), { colors: value.colors, status: value.status });
    check('failed-reset-leaves-saved-palette-unchanged', equalColors(fixtureState.settings.colors, custom), fixtureState.settings.colors);
    await refreshState();
    value = await execute(snapshot);
    check('state-refresh-after-failed-reset-preserves-default-draft', equalColors(value.colors, defaults) && !value.saveDisabled, value.colors);
    await click('#theme-reset');
    await waitFor("document.querySelector('#appearance-settings').getAttribute('aria-busy')!=='true'", 'Retry resetting colors did not settle.');
    value = await execute(snapshot);
    check('reset-restores-and-saves-all-default-colors', equalColors(value.colors, defaults) && equalColors(fixtureState.settings.colors, defaults) && value.saveDisabled, { colors: value.colors, stored: fixtureState.settings.colors, status: value.status });
    check('reset-retry-repeats-complete-default-save', saveCalls().length === beforeReset + 2 && equalColors(saveCalls().at(-1).value, defaults), saveCalls().at(-1)?.value);

    for (const [name, width, height] of [['wide', 1440, 940], ['minimum', 1000, 700]]) {
      win.setContentSize(width, height);
      await execute("document.querySelector('#settings-content').scrollTop=0");
      await settle();
      value = await execute(snapshot);
      report.observations.push({ phase: name, ...value });
      check(`${name}-settings-fit-window-without-horizontal-overflow`, value.bodyWidth <= width && value.bodyHeight <= height && !value.settingsOverflow && value.section.right <= width, value.section);
      check(`${name}-theme-controls-stay-inside-card`, value.controls.filter(control => control.visible).every(control => control.x >= value.section.x && control.right <= value.section.right && control.y >= value.section.y && control.bottom <= value.section.bottom), value.controls);
      check(`${name}-color-inputs-have-accessible-names`, await execute("[...document.querySelectorAll('#appearance-settings input')].every(input=>Boolean(input.labels?.length||input.getAttribute('aria-label')||input.getAttribute('aria-labelledby')))"));
      await capture(`settings-${width}x${height}`);
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
