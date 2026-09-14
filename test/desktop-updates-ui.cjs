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
  const runRoot = path.join(root, '.local', `desktop-updates-ui-${randomUUID()}`);
  const report = {version: require('../package.json').version, scope: 'Real renderer and preload with offline Desktop update fixtures; no installation or live services.', checks: [], calls: [], screenshots: [], errors: [], blockedRequests: []};
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
  let win, pendingDownload, pendingCheck, pendingAdoption, rejectOpen = false, permissionFailure = false;
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
    handle('getFeatureTasks', () => ({tasks: []}));
    handle('getOrchestration', () => null);
    for (const method of ['setView', 'setBrowserView', 'markShellEditingTarget']) handle(method, () => ({}));
    handle('checkPortalUpdates', (...args) => {
      assert.deepEqual(args, []);
      assert.equal(pendingCheck, undefined);
      return new Promise((resolve, reject) => {pendingCheck = {resolve, reject};});
    });
    handle('getPortalPermissions',()=>{
      if(permissionFailure)throw new Error('无法读取权限，请重试。');
      return {permissions:{file:true,exec:true,screenshot:true,search:true,web_fetch:true,custom_tools_enabled:true},revision:'fixture-revision',configPath:'/existing/portal.toml'};
    });
    handle('savePortalPermissions',request=>({state:structuredClone(fixtureState),detail:'权限已保存，Portal 已通过原管理方式重启。'}));
    handle('adoptPortal',()=>new Promise((resolve,reject)=>{pendingAdoption={resolve,reject};}));
    handle('openPortalUpdate', (...args) => {assert.deepEqual(args, []); if (rejectOpen) throw new Error('无法打开官方更新页面，请重试。'); return {opened: true};});
    for(const method of ['downloadPortalUpdate','applyPortalUpdate','recoverPortalUpdate'])handle(method,()=>structuredClone(fixtureState));
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
    const send = async changes => {
      fixtureState.desktopUpdate = {currentVersion: report.version, latestVersion: '0.8.26', supported: true, enabled: true, status: 'idle', ...changes};
      win.webContents.send('being:state', structuredClone(fixtureState)); await settle();
    };
    handle('downloadDesktopUpdate', () => new Promise(resolve => {pendingDownload = resolve;}));
    handle('checkDesktopUpdates', () => new Promise(resolve => {pendingCheck = resolve;}));
    handle('setDesktopAutoUpdate', value => {fixtureState.desktopUpdate.enabled = value;return fixtureState;});
    handle('installDesktopUpdate', () => fixtureState);
    handle('openDesktopRelease', () => fixtureState);
    await send({status: 'available', available: true});
    check('available-does-not-auto-download', calls('downloadDesktopUpdate').length === 0);
    check('available-shows-sidebar-icon', await visible('desktop-update-entry'));
    check('icon-before-profile-ellipsis', await execute(`(() => {const icon=document.getElementById('desktop-update-entry').getBoundingClientRect(),more=document.querySelector('#sidebar-profile > .icon').getBoundingClientRect();return icon.right<=more.left&&Math.abs((icon.y+icon.height/2)-(more.y+more.height/2))<2;})()`));
    await capture('00-desktop-available');
    await click('desktop-update-entry');
    await waitFor(()=>pendingDownload,'explicit download');
    await execute("document.getElementById('desktop-update-entry').click()");
    check('single-download-ipc-no-arguments', calls('downloadDesktopUpdate').length===1&&calls('downloadDesktopUpdate')[0].args.length===0);
    check('download-keeps-chat-and-profile-closed', await execute("document.body.dataset.page==='chat'&&document.getElementById('sidebar-profile').getAttribute('aria-expanded')==='false'"));
    await send({status:'downloading',available:true,progress:48});
    check('sidebar-download-busy', await execute("document.getElementById('desktop-update-entry').disabled&&document.getElementById('desktop-update-entry').title.includes('48%')"));
    pendingDownload(structuredClone(fixtureState));pendingDownload=null;await settle();
    await send({status: 'ready', detail: '更新已下载，重启安装。'});
    check('background-update-keeps-chat-open', await execute("document.body.dataset.page==='chat'"));
    check('global-desktop-update-entry', await visible('desktop-update-entry'));
    await click('desktop-update-entry');
    check('opens-about-settings', await visible('desktop-update-panel'));
    check('install-visible', await visible('desktop-update-install'));
    await click('desktop-update-install');
    await domWait("!document.getElementById('desktop-update-install').disabled");
    check('explicit-install-ipc-no-arguments', calls('installDesktopUpdate').length===1&&calls('installDesktopUpdate')[0].args.length===0);
    check('mac-toggle-inner-bottom-corners-square', await execute(`(() => {document.documentElement.dataset.platform='darwin';const row=getComputedStyle(document.querySelector('#desktop-update-panel .switch-row')),outer=getComputedStyle(document.querySelector('.desktop-update-controls'));return row.borderBottomLeftRadius==='0px'&&row.borderBottomRightRadius==='0px'&&outer.borderBottomLeftRadius==='16px';})()`));
    await capture('01-desktop-ready');
    await send({status: 'current'});
    await execute("document.getElementById('desktop-update-enabled').click()");
    await domWait("!document.getElementById('desktop-update-enabled').disabled");
    check('setting-persists-through-real-preload',calls('setDesktopAutoUpdate')[0].args[0]===false);
    await click('desktop-update-check');
    await waitFor(()=>pendingCheck,'manual Desktop check');
    await execute("document.getElementById('desktop-update-check').click()");
    check('duplicate-check-disabled',calls('checkDesktopUpdates').length===1);
    await send({status:'downloading',progress:48,detail:'正在后台下载更新…'});
    check('download-progress-visible',await visible('desktop-update-progress'));
    check('progress-value',await execute("document.getElementById('desktop-update-progress').value===48"));
    await capture('02-desktop-downloading');
    pendingCheck(structuredClone(fixtureState));pendingCheck=null;await settle();
    await send({status:'error',detail:'更新未完成，可能是网络、安装包校验或系统权限问题。请重试，或前往发布页面下载。'});
    await capture('03-desktop-error');
    win.setContentSize(1000, 780);await settle();
    await capture('04-desktop-error-narrow');
    check('retry-available',await execute("!document.getElementById('desktop-update-check').disabled"));
    check('error-cannot-install',!await visible('desktop-update-install'));
    await click('desktop-update-open');await settle();
    check('release-page-ipc-no-url',calls('openDesktopRelease').length===1&&calls('openDesktopRelease')[0].args.length===0);
    await send({status:'ahead',latestVersion:'0.8.25',detail:'当前版本 0.8.26 高于最新发布版 0.8.25，无需更新。'});
    check('ahead-shows-published-version',await execute("document.getElementById('desktop-update-status').textContent.includes('领先于发布版 0.8.25')"));
    check('ahead-is-not-an-error-or-install-action',await execute("document.getElementById('desktop-update-panel').dataset.updateStatus==='ahead'&&document.getElementById('desktop-update-install').hidden&&document.getElementById('desktop-update-check').textContent==='检查更新'"));
    await capture('05-desktop-ahead');
    await send({status:'unsupported',supported:false,detail:'便携版请安装 Windows 安装版。'});
    check('unsupported-check-disabled',await execute("document.getElementById('desktop-update-check').disabled"));
    check('manual-download-fallback-visible',await visible('desktop-update-open'));
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
