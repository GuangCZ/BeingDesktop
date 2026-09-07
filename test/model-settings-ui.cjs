'use strict';

// Exercise the real renderer and preload using isolated IPC fixtures. No live
// Being, credential, saved profile, or network connection is touched.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {randomUUID, createHash} = require('node:crypto');
const {pathToFileURL, fileURLToPath} = require('node:url');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const {spawn} = require('node:child_process');
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], {cwd: root, env, windowsHide: true, stdio: 'inherit'});
  child.on('error', error => {process.stderr.write(`${error.message}\n`); process.exitCode = 1;});
  child.on('exit', code => {process.exitCode = code ?? 1;});
} else {
  const {app, BrowserWindow, ipcMain} = require('electron');
  const renderer = path.join(root, 'renderer');
  const entry = path.join(renderer, 'index.html');
  const runRoot = path.join(root, '.local', `model-settings-ui-${randomUUID()}`);
  const report = {
    version: require('../package.json').version,
    scope: 'Real renderer and preload, offline IPC fixtures, hidden Electron window. No live model configuration or network requests.',
    checks: [], calls: [], screenshots: [], observations: [], errors: [], blockedRequests: [],
  };
  const fixtureState = {
    version: report.version,
    machine: {hostname: 'Preview PC', user: 'Preview'},
    connection: {configured: false, beingName: '', displayUrl: '', status: 'disconnected'},
    workspace: {path: '', files: []},
    portal: {status: 'not_configured', health: 'unknown', executable: '', configPath: '', pid: null, owned: false, detail: ''},
    runtime: {configStatus: 'unknown', model: '', provider: '', baseUrl: ''},
    townApp: {platformSupported: true, access: {}, identity: {identityRevision: 1, connectionRevision: 1}, portalWorkspace: {path: 'C:\\Fixture\\workspace', isDefault: true}, portalInstall: {status: 'idle', phase: '', detail: ''}},
  };
  const toolsState = {browser: {tabs: [], activeTabId: null}, console: {jobs: []}, link: {status: 'disconnected'}, requests: [], workspace: ''};
  const initialConfig = {model: 'fixture-model-a', provider: 'openai', baseUrl: 'https://model.fixture.invalid/v1', hasApiKey: true};
  const providers = [
    {id: 'openai', name: 'OpenAI compatible', baseUrl: 'https://default-openai.fixture.invalid/v1'},
    {id: 'anthropic', name: 'Anthropic', baseUrl: 'https://anthropic.fixture.invalid/v1'},
  ];
  const models = [
    {id: 'fixture-model-a', presetId: 'fixture-a', name: 'Fixture A', provider: 'openai', baseUrl: '', hasApiKey: true},
    {id: 'fixture-model-b', presetId: 'fixture-b', name: 'Fixture B', provider: 'openai', baseUrl: '', hasApiKey: true},
    {id: 'fixture-model-b', presetId: 'fixture-b', name: 'Anthropic B', provider: 'anthropic', baseUrl: '', hasApiKey: true},
    {id: 'fixture-endpoint-model', name: 'Endpoint Needed', provider: 'unknown-provider', baseUrl: '', hasApiKey: false},
  ];
  let configResult = {config: {...initialConfig}, models, providers, connectionId: 1, modelsError: ''};
  let loadMode = 'ready';
  let saveMode = 'ready';
  let deferredLoad;
  let deferredSave;
  let win;
  app.setPath('userData', path.join(runRoot, 'profile'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('force-prefers-reduced-motion');
  app.on('window-all-closed', () => {});
  const check = (name, passed, detail) => {
    report.checks.push({name, passed: Boolean(passed), ...(detail === undefined ? {} : {detail})});
    assert(passed, name);
  };
  const execute = script => {
    assert.equal(win.webContents.getURL(), pathToFileURL(entry).href);
    return win.webContents.executeJavaScript(script);
  };
  const settle = () => execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const waitFor = async (condition, label) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await condition()) return;
      await settle();
    }
    throw new Error(`Fixture did not reach ${label}`);
  };
  const domWait = (condition, label = condition) => waitFor(() => execute(`Boolean(${condition})`), label);
  const calls = method => report.calls.filter(call => call.method === method);
  const publish = async () => {
    win.webContents.send('being:state', structuredClone(fixtureState));
    await settle();
  };
  async function edit(id, value, event = 'input') {
    await execute(`(() => {const el=document.getElementById(${JSON.stringify(id)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
    await settle();
  }
  async function selectModel(label) {
    const value = await execute(`(() => {const option=[...document.getElementById('model-select').options].find(item=>item.textContent.startsWith(${JSON.stringify(`${label} ·`)}));if(!option)throw new Error('Fixture model option missing');return option.value})()`);
    await edit('model-select', value, 'change');
  }
  async function click(selector, {disabled = false} = {}) {
    await execute(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'nearest'})`);
    await settle();
    const point = await execute(`(() => {
      const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect();
      const x=r.x+r.width/2,y=r.y+r.height/2;
      if(!el.contains(document.elementFromPoint(x,y)))throw new Error('Fixture click target is obscured.');
      if(el.disabled&&!${disabled})throw new Error('Fixture click target is disabled.');
      return {x:Math.round(x),y:Math.round(y)};
    })()`);
    win.webContents.sendInputEvent({type: 'mouseMove', ...point});
    win.webContents.sendInputEvent({type: 'mouseDown', button: 'left', clickCount: 1, ...point});
    win.webContents.sendInputEvent({type: 'mouseUp', button: 'left', clickCount: 1, ...point});
    await settle();
  }
  const snapshot = `(() => {
    const geometry = id => {
      const el=document.getElementById(id);if(!el)return null;
      const r=el.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,visible:!!el.getClientRects().length,disabled:!!el.disabled};
    };
    const page=document.getElementById('page-settings');
    return {width:innerWidth,height:innerHeight,bodyWidth:document.documentElement.scrollWidth,
      settingsWidth:page.clientWidth,settingsScrollWidth:page.scrollWidth,
      controls:Object.fromEntries(['model-settings','model-provider','model-base-url','model-api-key','model-select','model-custom-name','model-config-refresh','model-config-save'].map(id=>[id,geometry(id)]))};
  })()`;
  async function capture(name, align = 'start') {
    await execute(`document.activeElement?.blur();document.getElementById('model-settings').scrollIntoView({block:${JSON.stringify(align)}})`);
    await settle();
    const observation = await execute(snapshot);
    report.observations.push({phase: name, ...observation});
    let previousHash = '';
    let stableFrames = 0;
    let latestPaint;
    for (let attempt = 0; attempt < 30 && stableFrames < 3; attempt++) {
      const painted = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {win.webContents.removeListener('paint', listener); reject(new Error('Offscreen paint timed out.'));}, 5000);
        const listener = (_event, _dirty, image) => {
          if (image.getSize().width !== observation.width || image.getSize().height !== observation.height) return;
          clearTimeout(timer);win.webContents.removeListener('paint', listener);resolve(image);
        };
        win.webContents.on('paint', listener);
      });
      win.webContents.invalidate();
      latestPaint = await painted;
      const card = observation.controls['model-settings'];
      const crop = {x: Math.max(0, Math.ceil(card.x)), y: Math.max(0, Math.ceil(card.y))};
      crop.width = Math.floor(Math.min(card.right, observation.width)) - crop.x;
      crop.height = Math.floor(Math.min(card.bottom, observation.height)) - crop.y;
      const hash = createHash('sha256').update(latestPaint.crop(crop).toBitmap()).digest('hex');
      stableFrames = hash === previousHash ? stableFrames + 1 : 0;
      previousHash = hash;
      // Allow Chromium to replace a cropped prior frame after offscreen resize.
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(stableFrames >= 3, 'The model settings screenshot did not settle after resize.');
    const output = path.join(runRoot, `${name}.png`);
    await fs.writeFile(output, latestPaint.toPNG());
    report.screenshots.push({path: output, width: observation.width, height: observation.height});
    check(`${name}-no-horizontal-overflow`, observation.bodyWidth <= observation.width && observation.settingsScrollWidth <= observation.settingsWidth + 1, observation);
    for (const [id, control] of Object.entries(observation.controls)) {
      if (control.visible) check(`${name}-${id}-fits`, control.x >= 0 && control.right <= observation.width && control.width > 0, control);
    }
  }
  function handle(method, callback) {
    ipcMain.handle(`being:${method}`, (event, ...args) => {
      assert.equal(event.sender, win.webContents);
      assert.equal(event.senderFrame, win.webContents.mainFrame);
      report.calls.push({method, args: structuredClone(args)});
      return callback(...args);
    });
  }
  async function run() {
    await fs.mkdir(runRoot, {recursive: true});
    await app.whenReady();
    handle('getState', () => fixtureState);
    handle('refresh', () => fixtureState);
    handle('getTownCatalog', () => require('../src/town.cjs').getTownCatalog());
    handle('getTownAppState', () => fixtureState.townApp);
    handle('getDesktopTools', () => toolsState);
    handle('getTerminalState', () => ({sessions: [], activeSessionId: null}));
    handle('listWorkspace', () => ({files: []}));
    handle('setView', () => ({}));
    handle('setBrowserView', () => ({}));
    handle('getModelConfig', () => {
      if (loadMode === 'error') throw new Error('模型配置读取失败，请重试。');
      if (loadMode === 'pending') {
        assert.equal(deferredLoad, undefined);
        return new Promise((resolve, reject) => {deferredLoad = {resolve, reject};});
      }
      return structuredClone(configResult);
    });
    handle('saveModelConfig', value => {
      if (saveMode === 'error') throw new Error('模型配置保存失败，请重试。');
      if (saveMode === 'pending') {
        assert.equal(deferredSave, undefined);
        return new Promise((resolve, reject) => {deferredSave = {resolve, reject};});
      }
      configResult = {...configResult, config: {model: value.model, provider: value.provider, baseUrl: value.baseUrl, hasApiKey: true}};
      return structuredClone(configResult);
    });
    for (const method of ['sendFiresideMessage', 'sendBonfireMessage']) handle(method, () => {throw new Error('The model fixture must never send a message.');});
    win = new BrowserWindow({show: false, frame: false, width: 1440, height: 980, useContentSize: true,
      webPreferences: {preload: path.join(root, 'src', 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: `model-ui-${randomUUID()}`}});
    win.webContents.setFrameRate(30);
    win.webContents.on('console-message', event => {if (event.level === 'error') report.errors.push(event.message);});
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      if (details.url.startsWith('file:')) allowed = fileURLToPath(details.url).startsWith(renderer + path.sep);
      if (!allowed) report.blockedRequests.push(details.url);
      callback({cancel: !allowed});
    });
    await win.loadFile(entry);
    await domWait(`document.getElementById('app-version').textContent.includes(${JSON.stringify(report.version)})`, 'initial public state');
    await click('#header-settings');
    await click('[data-settings-section="models"]');
    await domWait("document.body.dataset.page==='settings'");
    check('model-panel-is-selected-and-other-panels-are-hidden', await execute("document.getElementById('model-settings').checkVisibility()&&!document.getElementById('settings-connect-form').checkVisibility()&&!document.getElementById('portal-settings').checkVisibility()"));
    check('disconnected-cannot-load-or-save', await execute("document.getElementById('model-config-refresh').disabled&&document.getElementById('model-config-save').disabled") && calls('getModelConfig').length === 0);

    loadMode = 'error';
    fixtureState.connection = {configured: true, beingName: 'preview_being', displayUrl: 'https://fixture.invalid/loom/preview_being', status: 'connected'};
    fixtureState.runtime = {configStatus: 'connected', model: initialConfig.model, provider: initialConfig.provider, baseUrl: initialConfig.baseUrl};
    await publish();
    await domWait("document.getElementById('model-config-status').textContent.includes('读取失败')");
    check('initial-read-error-disables-editing-and-allows-retry', await execute("document.getElementById('model-select').disabled&&document.getElementById('model-config-save').disabled&&!document.getElementById('model-config-refresh').disabled"));
    loadMode = 'ready';
    await click('#model-config-refresh');
    await domWait("document.getElementById('model-select').selectedOptions[0]?.textContent.startsWith('Fixture A ·')", 'supported models loaded');
    check('list-retry-loads-through-preload', calls('getModelConfig').length === 2);
    check('supported-list-and-custom-option', await execute("(()=>{const options=[...document.getElementById('model-select').options];return options.length===5&&new Set(options.map(option=>option.value)).size===5&&options.some(option=>option.value==='__custom__')})()"));
    check('existing-key-is-never-filled', await execute("document.getElementById('model-api-key').type==='password'&&document.getElementById('model-api-key').value===''"));
    await capture('01-supported-list-1440');

    await selectModel('Fixture B');
    check('same-provider-model-keeps-configured-proxy', await execute(`document.getElementById('model-base-url').value===${JSON.stringify(initialConfig.baseUrl)}`));
    await publish();
    check('periodic-state-preserves-model-selection', await execute("document.getElementById('model-select').selectedOptions[0].textContent.startsWith('Fixture B ·')"));
    await click('#model-config-save');
    await waitFor(() => calls('saveModelConfig').length === 1, 'supported-model save');
    const savedSupported = calls('saveModelConfig')[0].args[0];
    check('supported-model-save-omits-blank-key', savedSupported.model === 'fixture-model-b' && savedSupported.provider === 'openai' && savedSupported.baseUrl === initialConfig.baseUrl && savedSupported.connectionId === 1 && !Object.hasOwn(savedSupported, 'apiKey'));

    await selectModel('Endpoint Needed');
    check('provider-without-default-clears-previous-endpoint', await execute("document.getElementById('model-provider').value==='unknown-provider'&&document.getElementById('model-base-url').value===''&&document.getElementById('model-service-settings').open"));
    await selectModel('Anthropic B');
    check('duplicate-model-and-preset-ids-select-correct-provider', await execute("document.getElementById('model-provider').value==='anthropic'&&document.getElementById('model-base-url').value==='https://anthropic.fixture.invalid/v1'&&document.getElementById('model-service-settings').open"));
    await edit('model-select', '__custom__', 'change');
    await domWait("!document.getElementById('model-custom-field').hidden");
    await edit('model-custom-name', 'custom/fixture-model:latest');
    if (!await execute("document.getElementById('model-service-settings').open")) await click('#model-service-settings > summary');
    await edit('model-base-url', 'https://custom.fixture.invalid/v1');
    await edit('model-api-key', 'fixture-only-key');
    await publish();
    check('periodic-state-preserves-entire-custom-draft', await execute("document.getElementById('model-custom-name').value==='custom/fixture-model:latest'&&document.getElementById('model-base-url').value==='https://custom.fixture.invalid/v1'&&document.getElementById('model-api-key').value==='fixture-only-key'"));
    await click('#model-config-refresh');
    await domWait("!document.getElementById('model-config-refresh').disabled");
    check('explicit-list-refresh-preserves-custom-draft', await execute("document.getElementById('model-select').value==='__custom__'&&document.getElementById('model-custom-name').value==='custom/fixture-model:latest'&&document.getElementById('model-api-key').value==='fixture-only-key'"));
    win.setContentSize(1000, 900);
    await domWait('innerWidth===1000&&innerHeight===900');
    await capture('02-custom-draft-1000');
    saveMode = 'pending';
    await click('#model-config-save');
    await waitFor(() => deferredSave, 'custom-model save');
    check('pending-save-disables-submit', await execute("document.getElementById('model-config-save').disabled"));
    await execute("document.getElementById('model-config-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
    await settle();
    check('duplicate-submit-does-not-duplicate-save', calls('saveModelConfig').length === 2);
    const savedCustom = calls('saveModelConfig')[1].args[0];
    check('custom-save-sends-config-and-new-key', savedCustom.model === 'custom/fixture-model:latest' && savedCustom.provider === 'anthropic' && savedCustom.baseUrl === 'https://custom.fixture.invalid/v1' && savedCustom.apiKey === 'fixture-only-key');
    configResult = {...configResult, config: {...savedCustom, hasApiKey: true}};
    delete configResult.config.apiKey;
    const pendingSave = deferredSave; deferredSave = undefined; saveMode = 'ready';
    pendingSave.resolve(structuredClone(configResult));
    await domWait("document.getElementById('model-api-key').value===''");
    check('saved-custom-stays-editable-with-key-cleared', await execute("document.getElementById('model-select').value==='__custom__'&&document.getElementById('model-custom-name').value==='custom/fixture-model:latest'"));

    await edit('model-custom-name', 'custom/retry-model');
    saveMode = 'error';
    await click('#model-config-save');
    await domWait("document.getElementById('model-config-status').textContent.includes('保存失败')");
    check('save-error-keeps-draft-and-allows-retry', await execute("document.getElementById('model-custom-name').value==='custom/retry-model'&&!document.getElementById('model-config-save').disabled"));
    check('error-feedback-hides-electron-wrapper', await execute("!document.getElementById('model-config-status').textContent.includes('Error invoking remote method')"));
    await capture('03-save-error-1000', 'end');
    saveMode = 'ready';
    await click('#model-config-save');
    await domWait("!document.getElementById('model-config-status').textContent.includes('保存失败')");

    loadMode = 'error';
    await click('#model-config-refresh');
    await domWait("document.getElementById('model-config-status').textContent.includes('读取失败')");
    check('read-error-offers-retry', await execute("!document.getElementById('model-config-refresh').disabled"));
    loadMode = 'ready';
    configResult = {config: {...initialConfig}, models: [], providers, connectionId: 1, modelsError: ''};
    await click('#model-config-refresh');
    await domWait("document.getElementById('model-select').value==='__custom__'");
    check('empty-list-allows-custom-model', await execute("!document.getElementById('model-custom-field').hidden&&document.getElementById('model-custom-name').value==='fixture-model-a'"));
    await capture('04-empty-list-1000');

    configResult.modelsError = '支持模型列表读取失败，可使用自定义模型。';
    await click('#model-config-refresh');
    await domWait("document.getElementById('model-list-status').textContent.includes('失败')");
    check('list-error-keeps-custom-configuration-available', await execute("!document.getElementById('model-custom-name').disabled"));

    loadMode = 'pending';
    await click('#model-config-refresh');
    await waitFor(() => deferredLoad, 'deferred model load');
    const oldLoad = deferredLoad; deferredLoad = undefined;
    loadMode = 'ready';
    configResult = {config: {model: 'new-being-model', provider: 'openai', baseUrl: 'https://new-being.fixture.invalid/v1', hasApiKey: false}, models: [], providers, connectionId: 2, modelsError: ''};
    fixtureState.connection = {...fixtureState.connection, beingName: 'new_being', displayUrl: 'https://fixture.invalid/loom/new_being'};
    fixtureState.townApp.identity.identityRevision += 1;
    fixtureState.runtime = {...fixtureState.runtime, model: configResult.config.model, baseUrl: configResult.config.baseUrl};
    await publish();
    await domWait("document.getElementById('model-custom-name').value==='new-being-model'");
    oldLoad.resolve({config: {...initialConfig, model: 'stale-model'}, models: [], providers, connectionId: 1, modelsError: ''});
    await settle();
    check('previous-identity-load-cannot-replace-new-config', await execute("document.getElementById('model-custom-name').value==='new-being-model'&&document.getElementById('model-base-url').value==='https://new-being.fixture.invalid/v1'"));

    await edit('model-custom-name', 'old-being-save');
    saveMode = 'pending';
    await click('#model-config-save');
    await waitFor(() => deferredSave, 'deferred old identity save');
    const oldSave = deferredSave; deferredSave = undefined;
    saveMode = 'ready';
    configResult = {...configResult, config: {...configResult.config, model: 'latest-being-model'}, connectionId: 3};
    fixtureState.connection = {...fixtureState.connection, beingName: 'latest_being', displayUrl: 'https://fixture.invalid/loom/latest_being'};
    fixtureState.townApp.identity.identityRevision += 1;
    await publish();
    await domWait("document.getElementById('model-custom-name').value==='latest-being-model'");
    oldSave.resolve({config: {...initialConfig, model: 'stale-save-model'}, models: [], providers, connectionId: 2, modelsError: ''});
    await settle();
    check('previous-identity-save-cannot-replace-new-config', await execute("document.getElementById('model-custom-name').value==='latest-being-model'&&!document.getElementById('model-config-status').textContent.includes('已保存')"));

    await edit('model-custom-name', 'old-being-draft');
    await edit('model-api-key', 'discard-on-disconnect');
    fixtureState.connection = {configured: false, beingName: '', displayUrl: '', status: 'disconnected'};
    fixtureState.townApp.identity.identityRevision += 1;
    await publish();
    check('disconnect-clears-draft-and-secret', await execute("document.getElementById('model-api-key').value===''&&document.getElementById('model-custom-name').value!=='old-being-draft'&&document.getElementById('model-config-save').disabled"));
    check('model-settings-never-send-being-messages', calls('sendFiresideMessage').length + calls('sendBonfireMessage').length === 0);
    check('fixture-window-never-shown', BrowserWindow.getAllWindows().every(item => !item.isVisible()));
    check('no-network-attempts', report.blockedRequests.length === 0, report.blockedRequests);
    check('no-renderer-errors', report.errors.length === 0, report.errors);
    report.passed = true;
  }
  const deadline = setTimeout(() => {report.passed = false; report.error = 'Model settings fixture exceeded its deadline.'; void finish();}, 60000);
  let finishing = false;
  async function finish() {
    if (finishing) return;
    finishing = true;
    clearTimeout(deadline);
    if (win && !win.isDestroyed()) win.destroy();
    await fs.mkdir(runRoot, {recursive: true});
    const reportPath = path.join(runRoot, 'report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({passed: report.passed, checks: report.checks.length, report: reportPath, screenshots: report.screenshots.map(item => item.path), error: report.error}) + '\n');
    app.exit(report.passed ? 0 : 1);
  }
  run().catch(error => {report.passed = false; report.error = error.stack || error.message;}).finally(finish);
}
