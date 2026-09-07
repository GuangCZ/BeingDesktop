'use strict';

// Exercise the real shell and preload in a hidden window with local IPC fixtures.
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
  const runRoot = path.join(root, '.local', `portal-updates-ui-${randomUUID()}`);
  const report = {version: require('../package.json').version, scope: 'Hidden real renderer and preload, offline IPC fixtures, no update installation or Being message.', checks: [], calls: [], screenshots: [], errors: [], blockedRequests: []};
  const baseUpdate = {status: 'idle', currentVersion: '0.5.0', latestVersion: '', releaseUrl: '', checkedAt: null, detail: '', checking: false, available: false};
  const fixtureState = {
    version: report.version,
    machine: {hostname: 'Preview PC', user: 'Preview'},
    connection: {configured: false, beingName: '', displayUrl: '', status: 'disconnected'},
    workspace: {path: '', files: []},
    portal: {status: 'stopped', health: 'unknown', executable: 'C:\\Preview\\heart-portal.exe', configPath: 'C:\\Preview\\portal.json', owned: false, pid: null, detail: ''},
    portalUpdate: {...baseUpdate},
    townApp: {platformSupported: true, access: {}, identity: {}, portalWorkspace: {path: 'C:\\Preview\\portal-workspace', isDefault: true}, portalInstall: {status: 'idle', phase: '', detail: ''}},
  };
  let win, pendingCheck, rejectOpen = false;
  app.setPath('userData', path.join(runRoot, 'profile'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('force-prefers-reduced-motion');
  app.on('window-all-closed', () => {});
  const check = (name, passed, detail) => {report.checks.push({name, passed: Boolean(passed), ...(detail === undefined ? {} : {detail})}); assert(passed, name);};
  const execute = script => {assert.equal(win.webContents.getURL(), pathToFileURL(entry).href); return win.webContents.executeJavaScript(script);};
  const settle = () => execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const waitFor = async (condition, label) => {for (let i = 0; i < 100; i++) {if (await condition()) return; await settle();} throw new Error(`Fixture did not reach ${label}`);};
  const domWait = (condition, label = condition) => waitFor(() => execute(`Boolean(${condition})`), label);
  const calls = method => report.calls.filter(call => call.method === method);
  const publish = async changes => {fixtureState.portalUpdate = {...baseUpdate, ...changes}; win.webContents.send('being:state', structuredClone(fixtureState)); await settle();};
  const visible = id => execute(`(() => {const e=document.getElementById(${JSON.stringify(id)}),r=e.getBoundingClientRect();return !e.hidden&&r.width>0&&r.height>0;})()`);

  function handle(method, callback) {
    ipcMain.handle(`being:${method}`, (event, ...args) => {
      assert.equal(event.sender, win.webContents);
      assert.equal(event.senderFrame, win.webContents.mainFrame);
      report.calls.push({method, args: structuredClone(args)});
      return callback(...args);
    });
  }

  async function click(id) {
    await execute(`document.getElementById(${JSON.stringify(id)}).scrollIntoView({block:'center',inline:'nearest'})`);
    await settle();
    const point = await execute(`(() => {const e=document.getElementById(${JSON.stringify(id)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw new Error('Click target obscured');return {x:Math.round(x),y:Math.round(y)};})()`);
    win.webContents.sendInputEvent({type: 'mouseMove', ...point});
    win.webContents.sendInputEvent({type: 'mouseDown', button: 'left', clickCount: 1, ...point});
    win.webContents.sendInputEvent({type: 'mouseUp', button: 'left', clickCount: 1, ...point});
    await settle();
  }

  async function capture(name) {
    await settle();
    let latest, previous = '', stable = 0;
    for (let attempt = 0; attempt < 30 && stable < 2; attempt++) {
      const painted = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {win.webContents.removeListener('paint', listener); reject(new Error('Offscreen paint timed out'));}, 5000);
        const listener = (_event, _dirty, image) => {clearTimeout(timer); win.webContents.removeListener('paint', listener); resolve(image);};
        win.webContents.on('paint', listener);
      });
      win.webContents.invalidate(); latest = await painted;
      const hash = createHash('sha256').update(latest.toBitmap()).digest('hex');
      stable = hash === previous ? stable + 1 : 0; previous = hash;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(stable >= 2, 'Screenshot did not settle');
    const output = path.join(runRoot, `${name}.png`);
    await fs.writeFile(output, latest.toPNG());
    report.screenshots.push(output);
    return output;
  }

  async function run() {
    await fs.mkdir(runRoot, {recursive: true});
    await app.whenReady();
    handle('getState', () => fixtureState);
    handle('refresh', () => fixtureState);
    handle('getWindowState', () => ({maximized: false}));
    handle('getTownCatalog', () => require('../src/town.cjs').getTownCatalog());
    handle('getTownAppState', () => fixtureState.townApp);
    handle('getDesktopTools', () => ({browser: {tabs: [], activeTabId: null}, console: {jobs: []}, link: {status: 'disconnected'}, requests: [], workspace: ''}));
    handle('getTerminalState', () => ({sessions: [], activeSessionId: null}));
    for (const method of ['setView', 'setBrowserView', 'markShellEditingTarget']) handle(method, () => ({}));
    handle('checkPortalUpdates', (...args) => {
      assert.deepEqual(args, []);
      assert.equal(pendingCheck, undefined);
      return new Promise((resolve, reject) => {pendingCheck = {resolve, reject};});
    });
    handle('openPortalUpdate', (...args) => {assert.deepEqual(args, []); if (rejectOpen) throw new Error('无法打开官方更新页面，请重试。'); return {opened: true};});
    for (const method of ['deployPortal', 'startPortal', 'stopPortal', 'prepareTownAssistance', 'sendFiresideMessage', 'sendBonfireMessage']) handle(method, () => {throw new Error('The update fixture must not install, stop, start, or send.');});
    win = new BrowserWindow({show: false, frame: false, width: 1440, height: 980, useContentSize: true, webPreferences: {preload: path.join(root, 'src', 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: `portal-updates-${randomUUID()}`}});
    win.webContents.setFrameRate(30);
    win.webContents.on('console-message', event => {if (event.level === 'error') report.errors.push(event.message);});
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url.startsWith('file:') && fileURLToPath(details.url).startsWith(renderer + path.sep);
      if (!allowed) report.blockedRequests.push(details.url);
      callback({cancel: !allowed});
    });
    await win.loadFile(entry);
    await domWait(`document.getElementById('app-version').textContent===${JSON.stringify(report.version)}`);
    check('idle-does-not-show-update-entry', !await visible('portal-update-entry'));
    check('renderer-does-not-start-an-update-check', calls('checkPortalUpdates').length === 0);
    const available = {status: 'available', latestVersion: '0.6.0', releaseUrl: 'https://github.com/fixture/releases/tag/v0.6.0', checkedAt: '2026-09-07T01:00:00.000Z', available: true};
    await publish(available);
    check('background-update-keeps-chat-open', await execute("document.body.dataset.page==='chat'"));
    check('global-entry-visible-on-chat', await visible('portal-update-entry'));
    check('background-update-does-not-open-release-page', calls('openPortalUpdate').length === 0);
    await capture('01-chat-update-1440');
    await click('portal-update-entry');
    check('global-entry-opens-portal-settings', await execute("document.body.dataset.page==='settings'&&document.activeElement.id==='portal-settings'"));
    check('settings-show-both-versions', await execute("document.getElementById('portal-update-version').textContent==='0.5.0'&&document.getElementById('portal-update-status').textContent.includes('0.6.0')"));
    check('release-button-visible-for-update', await visible('portal-update-open'));
    await click('portal-update-open');
    check('release-button-uses-real-preload-ipc-without-url', calls('openPortalUpdate').length === 1 && calls('openPortalUpdate')[0].args.length === 0);
    await click('portal-update-check');
    await waitFor(() => pendingCheck, 'manual check IPC');
    check('manual-check-uses-real-preload-ipc', calls('checkPortalUpdates').length === 1);
    check('manual-check-indicates-pending', await execute("document.getElementById('portal-update-check').disabled&&document.getElementById('portal-update-check').textContent.includes('检查中')&&document.getElementById('portal-update-panel').getAttribute('aria-busy')==='true'"));
    await click('portal-update-check');
    await execute("document.getElementById('portal-update-check').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
    check('pending-check-deduplicates-repeated-clicks', calls('checkPortalUpdates').length === 1);
    const first = pendingCheck; pendingCheck = undefined;
    fixtureState.portalUpdate = {...baseUpdate, ...available, status: 'error', detail: '网络暂时不可用，请稍后重试。'};
    first.resolve(structuredClone(fixtureState));
    await domWait("!document.getElementById('portal-update-check').disabled");
    check('check-response-reaches-shell-state', await execute("document.getElementById('portal-update-detail').textContent.includes('网络暂时不可用')"));
    check('failure-preserves-known-update', await visible('portal-update-open') && await execute("!document.getElementById('portal-update-entry').hidden&&document.getElementById('portal-update-status').textContent.includes('保留上次更新提示')&&document.getElementById('portal-update-status').checkVisibility()"));
    check('failed-check-can-be-retried', await execute("document.getElementById('portal-update-check').textContent==='重试检查'"));
    win.setContentSize(720, 900);
    await domWait('innerWidth===720&&innerHeight===900');
    await execute("document.getElementById('portal-update-panel').scrollIntoView({block:'center'})");
    await capture('02-update-error-720');
    const geometry = await execute("(() => {const ids=['portal-update-version','portal-update-check','portal-update-open'];return {width:innerWidth,bodyWidth:document.documentElement.scrollWidth,settingsWidth:document.getElementById('page-settings').clientWidth,settingsScrollWidth:document.getElementById('page-settings').scrollWidth,controls:ids.map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,x:r.x,right:r.right,width:r.width};})};})()");
    check('narrow-page-has-no-horizontal-overflow', geometry.bodyWidth <= geometry.width && geometry.settingsScrollWidth <= geometry.settingsWidth + 1, geometry);
    check('narrow-update-controls-fit-viewport', geometry.controls.every(item => item.x >= 0 && item.right <= geometry.width && item.width > 0), geometry.controls);
    await publish({status: 'current', currentVersion: '0.6.0', latestVersion: '0.6.0', checkedAt: available.checkedAt});
    check('current-version-hides-update-entry', !await visible('portal-update-entry') && !await visible('portal-update-open'));
    check('current-version-is-confirmed', await execute("document.getElementById('portal-update-status').textContent==='所选 Portal 程序已是最新版本。'"));
    await publish({status: 'current', currentVersion: '0.7.0', latestVersion: '0.6.0', detail: '所选程序版本高于官方稳定版。'});
    check('newer-local-version-does-not-claim-matching-latest', !await visible('portal-update-entry') && await execute("document.getElementById('portal-update-status').textContent==='所选 Portal 程序无需更新。'&&document.getElementById('portal-update-detail').textContent.includes('高于官方稳定版')"));
    await publish({status: 'unknown', currentVersion: '', latestVersion: '0.6.0'});
    check('unknown-version-is-not-current', await execute("document.getElementById('portal-update-version').textContent==='未识别'&&document.getElementById('portal-update-status').textContent.includes('无法识别')&&!document.getElementById('portal-update-status').textContent.includes('已是最新')"));
    await capture('03-unknown-version-720');
    await publish({status: 'not_installed', currentVersion: ''});
    check('not-installed-is-explicit', await execute("document.getElementById('portal-update-version').textContent==='尚未安装'&&document.getElementById('portal-update-status').textContent.includes('安装 Portal 后')"));
    await publish({status: 'checking', checking: true});
    check('background-check-disables-manual-check', await execute("document.getElementById('portal-update-check').disabled&&document.getElementById('portal-update-status').textContent.includes('正在检查')"));
    await publish({status: 'error', detail: '无法连接版本服务。'});
    check('error-without-known-update-does-not-claim-current', !await visible('portal-update-entry') && await execute("document.getElementById('portal-update-status').textContent.includes('无法检查')&&!document.getElementById('portal-update-status').textContent.includes('已是最新')"));
    await click('portal-update-check');
    await waitFor(() => pendingCheck, 'retry IPC');
    const second = pendingCheck; pendingCheck = undefined; second.reject(new Error('网络检查失败，请重试。'));
    await domWait("!document.getElementById('portal-update-check').disabled");
    check('ipc-check-error-is-actionable-and-clean', await execute("document.getElementById('portal-update-detail').textContent==='网络检查失败，请重试。'&&document.getElementById('portal-update-check').textContent==='重试检查'"));
    await publish(available);
    rejectOpen = true;
    await click('portal-update-open');
    await domWait("document.querySelector('#toast-region .toast span')?.textContent.includes('无法打开官方更新页面')");
    check('release-open-error-reaches-user-feedback', await execute("document.querySelector('#toast-region .toast span').textContent==='无法打开官方更新页面，请重试。'"));
    check('release-open-failure-keeps-update-available', await visible('portal-update-open') && await execute("!document.getElementById('portal-update-entry').hidden&&!document.getElementById('portal-update-open').disabled"));
    win.webContents.send('being:command', 'chat');
    await domWait("document.body.dataset.page==='chat'");
    win.webContents.send('being:command', 'portal-updates');
    await domWait("document.body.dataset.page==='settings'");
    check('native-notification-command-opens-portal-settings', await execute("document.activeElement.id==='portal-settings'"));
    check('fixture-never-installs-starts-stops-or-sends', ['deployPortal', 'startPortal', 'stopPortal', 'prepareTownAssistance', 'sendFiresideMessage', 'sendBonfireMessage'].every(method => calls(method).length === 0));
    check('fixture-window-never-shown', BrowserWindow.getAllWindows().every(item => !item.isVisible()));
    check('no-network-attempts', report.blockedRequests.length === 0, report.blockedRequests);
    check('no-renderer-errors', report.errors.length === 0, report.errors);
    report.passed = true;
  }

  const deadline = setTimeout(() => {report.passed = false; report.error = 'Portal update UI fixture exceeded its deadline.'; void finish();}, 60000);
  let finishing = false;
  async function finish() {
    if (finishing) return;
    finishing = true; clearTimeout(deadline);
    if (win && !win.isDestroyed()) win.destroy();
    await fs.mkdir(runRoot, {recursive: true});
    const reportPath = path.join(runRoot, 'report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({passed: report.passed, checks: report.checks.length, report: reportPath, screenshots: report.screenshots, error: report.error}) + '\n');
    app.exit(report.passed ? 0 : 1);
  }
  run().catch(error => {report.passed = false; report.error = error.stack || error.message;}).finally(finish);
}
