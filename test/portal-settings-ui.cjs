'use strict';

// Run the real shell and preload with isolated IPC fixtures. No Portal process,
// network request, saved profile, credential, or Being message is used.
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
  const runRoot = path.join(root, '.local', `portal-settings-ui-${randomUUID()}`);
  const defaultWorkspace = 'C:\\Users\\Preview\\AppData\\Roaming\\Being Desktop\\portal-workspace';
  const selectedWorkspace = 'E:\\Projects\\Portal UI fixture with a long workspace folder name';
  const report = {
    version: require('../package.json').version,
    scope: 'Real renderer and preload, offline IPC fixtures, hidden Electron window. Tests UI wiring; does not install Portal or contact Being.',
    checks: [], calls: [], screenshots: [], observations: [], errors: [], blockedRequests: [],
  };
  const fixtureState = {
    version: report.version,
    machine: {hostname: 'Preview PC', user: 'Preview'},
    connection: {configured: false, beingName: '', displayUrl: '', status: 'disconnected'},
    workspace: {path: '', files: []},
    portal: {status: 'not_configured', health: 'unknown', executable: '', configPath: '', pid: null, owned: false, detail: ''},
    townApp: {platformSupported: true, access: {}, identity: {}, portalWorkspace: {path: defaultWorkspace, isDefault: true}, portalInstall: {status: 'idle', phase: '', detail: ''}},
  };
  const toolsState = {browser: {tabs: [], activeTabId: null}, console: {jobs: []}, link: {status: 'disconnected'}, requests: [], workspace: ''};
  let win;
  let deployment;
  let latestPaint;
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
  const snapshot = `(() => {
    const geometry = id => {
      const el=document.getElementById(id); if(!el)return null;
      const r=el.getBoundingClientRect(),style=getComputedStyle(el);
      const visible=Boolean(el.getClientRects().length)&&style.visibility!=='hidden'&&r.width>0&&r.height>0;
      const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {visible,uncovered:visible&&Boolean(hit&&(hit===el||el.contains(hit))),disabled:Boolean(el.disabled),x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,text:el.textContent};
    };
    const page=document.getElementById('page-settings');
    return {width:innerWidth,height:innerHeight,page:document.body.dataset.page,bodyWidth:document.documentElement.scrollWidth,
      settingsWidth:page.clientWidth,settingsScrollWidth:page.scrollWidth,
      controls:Object.fromEntries(['portal-settings','portal-setup','portal-setup-assist','portal-setup-choose-workspace','portal-setup-status','portal-manual-settings'].map(id=>[id,geometry(id)])),
      workspace:document.getElementById('portal-setup-workspace')?.textContent,
      manualOpen:document.getElementById('portal-manual-settings')?.open};
  })()`;

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

  async function capture(name) {
    await execute("document.getElementById('" + (name==='permissions'?'portal-permissions':'portal-settings') + "').scrollIntoView({block:'start'})");
    await settle();
    const observation = await execute(snapshot);
    report.observations.push({phase: name, ...observation});
    let previousHash = '';
    let stableFrames = 0;
    for (let attempt = 0; attempt < 30 && stableFrames < 3; attempt++) {
      const painted = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {win.webContents.removeListener('paint', listener); reject(new Error('Offscreen paint timed out.'));}, 5000);
        const listener = (_event, _dirty, image) => {
          if (image.getSize().width !== observation.width || image.getSize().height !== observation.height) return;
          clearTimeout(timer); win.webContents.removeListener('paint', listener); resolve(image);
        };
        win.webContents.on('paint', listener);
      });
      win.webContents.invalidate();
      latestPaint = await painted;
      const card = observation.controls['portal-settings'];
      const crop = {x: Math.max(0, Math.ceil(card.x)), y: Math.max(0, Math.ceil(card.y))};
      crop.width = Math.floor(Math.min(card.right, observation.width)) - crop.x;
      crop.height = Math.floor(Math.min(card.bottom, observation.height)) - crop.y;
      const hash = createHash('sha256').update(latestPaint.crop(crop).toBitmap()).digest('hex');
      stableFrames = hash === previousHash ? stableFrames + 1 : 0;
      previousHash = hash;
      // Offscreen resize may first publish a cropped copy of the previous frame.
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(stableFrames >= 3, 'The Portal screenshot did not settle after resize.');
    const output = path.join(runRoot, `${name}.png`);
    await fs.writeFile(output, latestPaint.toPNG());
    report.screenshots.push({path: output, width: observation.width, height: observation.height});
    check(`${name}-no-horizontal-overflow`, observation.bodyWidth <= observation.width && observation.settingsScrollWidth <= observation.settingsWidth + 1, observation);
    return observation;
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
    handle('selectWorkspace', () => {
      fixtureState.workspace.path = selectedWorkspace;
      return fixtureState;
    });
    handle('deployPortal', value => {
      assert.deepEqual(value, {confirmed: true, permissions: {files: true, exec: false, web: false}});
      assert.equal(deployment, undefined, 'Only one deployment may be pending');
      return new Promise((resolve, reject) => {deployment = {resolve, reject};});
    });
    handle('prepareTownAssistance', value => {
      assert.deepEqual(value, {operation: 'portal-setup'});
      return {prepared: true};
    });
    handle('selectPortalExecutable', () => fixtureState);
    handle('selectPortalConfig', () => fixtureState);
    handle('startPortal', () => fixtureState);
    handle('stopPortal', () => fixtureState);
    let permissions={...require('../src/portal-config.cjs').DEFAULT_PERMISSIONS};
    handle('getPortalPermissions',()=>({permissions,revision:'fixture-revision',configPath:fixtureState.portal.configPath}));
    handle('savePortalPermissions',request=>{
      assert.equal(request.revision,'fixture-revision');
      assert.equal(request.configPath,fixtureState.portal.configPath);
      permissions=request.permissions;
      return {state:fixtureState,detail:'权限已保存，Portal 已重启，等待工具重新注册。'};
    });
    // Any attempted send is recorded and rejected; successful completion requires zero sends.
    for (const method of ['sendFiresideMessage', 'sendBonfireMessage']) handle(method, () => {throw new Error('The Portal fixture must never send a message.');});

    win = new BrowserWindow({show: false, frame: false, width: 1440, height: 980, useContentSize: true,
      webPreferences: {preload: path.join(root, 'src', 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: `portal-ui-${randomUUID()}`}});
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
    await execute("document.querySelector('#header-settings').click()");
    await click('[data-settings-section="portal"]');
    await domWait("document.body.dataset.page==='settings'");
    check('disconnected-setup-disabled', await execute("document.getElementById('portal-setup').disabled"));
    check('settings-do-not-auto-deploy', calls('deployPortal').length === 0);
    check('manual-paths-collapsed-by-default', await execute("document.getElementById('portal-manual-settings').tagName==='DETAILS'&&!document.getElementById('portal-manual-settings').open"));

    fixtureState.connection = {configured: true, beingName: 'preview_being', displayUrl: 'https://fixture.invalid/loom/preview_being', status: 'connected'};
    await publish();
    await domWait('!document.getElementById("portal-setup").disabled');
    check('empty-workspace-uses-backend-default', await execute(`document.getElementById('portal-setup-workspace').textContent===${JSON.stringify(defaultWorkspace)}`));
    await capture('01-default-workspace-1440');
    await click('#portal-setup-choose-workspace');
    await domWait(`document.getElementById('portal-setup-workspace').textContent===${JSON.stringify(selectedWorkspace)}`);
    check('workspace-picker-uses-real-preload-ipc', calls('selectWorkspace').length === 1);
    check('choosing-workspace-keeps-portal-settings-open', await execute("document.body.dataset.page==='settings'"));

    await click('#portal-setup');
    await waitFor(() => deployment, 'deployment IPC');
    check('one-click-calls-deployment-with-conservative-permissions', calls('deployPortal').length === 1);
    check('setup-is-disabled-while-pending', await execute("document.getElementById('portal-setup').disabled"));
    await click('#portal-setup', {disabled: true});
    await execute("document.getElementById('portal-setup').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
    await settle();
    check('repeated-clicks-cannot-start-another-deployment', calls('deployPortal').length === 1);
    fixtureState.townApp.portalInstall = {status: 'installing', phase: 'download', detail: '正在下载官方程序。', receivedBytes: 5242880, totalBytes: 10485760};
    await publish();
    check('download-progress-follows-main-process-state', await execute("(()=>{const p=document.getElementById('portal-setup-progress');return !p.hidden&&p.max>0&&p.value/p.max===0.5})()"));
    await capture('02-download-progress-1440');

    fixtureState.townApp.portalInstall = {status: 'error', phase: 'download', detail: '下载未完成，请检查网络后重试。'};
    await publish();
    const failedDeployment = deployment; deployment = undefined;
    failedDeployment.reject(new Error('下载未完成，请检查网络后重试。'));
    await domWait('!document.getElementById("portal-setup").disabled', 'retry enabled after failure');
    check('failure-has-actionable-retry-and-live-feedback', await execute("document.getElementById('portal-setup').textContent.includes('重试')&&document.getElementById('portal-setup-status').getAttribute('role')==='status'&&document.getElementById('portal-setup-status').textContent.includes('下载未完成')"));
    check('failure-feedback-hides-electron-ipc-wrapper', await execute("!document.getElementById('portal-setup-status').textContent.includes('Error invoking remote method')&&![...document.querySelectorAll('.toast')].some(el=>el.textContent.includes('being:deployPortal'))"));
    check('failure-does-not-automatically-ask-being', calls('prepareTownAssistance').length === 0);
    win.setContentSize(900, 820);
    await domWait('innerWidth===900&&innerHeight===820');
    const narrow = await capture('03-failure-retry-900');
    for (const id of ['portal-setup', 'portal-setup-assist', 'portal-setup-choose-workspace']) {
      const control = narrow.controls[id];
      check(`${id}-within-narrow-viewport`, control?.visible && control.x >= 0 && control.right <= narrow.width && control.width > 0, control);
    }

    await click('#portal-setup-assist');
    await domWait("document.body.dataset.page==='chat'", 'assistance returns to Loom');
    check('assistance-only-prepares-one-draft', calls('prepareTownAssistance').length === 1);
    check('assistance-never-sends-a-message', calls('sendFiresideMessage').length + calls('sendBonfireMessage').length === 0);
    await execute("document.querySelector('#header-settings').click()");
    await click('[data-settings-section="portal"]');
    await click('#portal-setup');
    await waitFor(() => deployment, 'retry deployment IPC');
    check('retry-starts-exactly-one-new-deployment', calls('deployPortal').length === 2);
    fixtureState.portal = {status: 'running', health: 'healthy', executable: 'C:\\Fixture\\heart-portal.exe', configPath: 'C:\\Fixture\\portal.json', pid: 4242, owned: true, detail: 'Portal 已启动，连接健康已确认。'};
    fixtureState.townApp.portalInstall = {status: 'ready', phase: 'running', detail: 'Portal 已启动，连接健康已确认。', verified: true};
    await publish();
    const successfulDeployment = deployment; deployment = undefined;
    successfulDeployment.resolve({status: 'running', detail: fixtureState.portal.detail, state: structuredClone(fixtureState)});
    await domWait("document.getElementById('portal-process-detail').textContent.includes('4242')");
    check('success-shows-process-and-confirmed-health', await execute("document.getElementById('portal-process-detail').textContent.includes('运行中')&&document.getElementById('portal-health-detail').textContent.includes('已确认')"));
    check('healthy-state-confirms-connection-in-setup-feedback', await execute("document.getElementById('portal-setup-status').textContent.includes('配置已完成，Portal 已连接')"));
    check('only-owned-process-can-be-stopped', await execute("!document.getElementById('stop-portal').disabled"));
    await capture('04-configured-900');

    fixtureState.portal.connectionBeingName = 'previous_being';
    fixtureState.portal.connectionCurrent = false;
    await publish();
    check('previous-being-connection-is-not-presented-as-current', await execute("(()=>{const status=document.getElementById('portal-setup-status').textContent;return status.includes('previous_being')&&status.includes('先停止 Portal')&&!status.includes('配置已完成')})()"));
    check('previous-being-process-can-be-stopped-without-new-deployment', await execute("!document.getElementById('stop-portal').disabled") && calls('deployPortal').length === 2);
    await capture('05-previous-being-900');

    fixtureState.portal = {...fixtureState.portal, status: 'stopped', health: 'unknown', owned: false, pid: null};
    fixtureState.townApp.portalInstall = {status: 'idle', phase: '', detail: ''};
    await publish();
    check('manual-config-keeps-existing-start-path', await execute("document.getElementById('portal-setup').hidden&&!document.getElementById('start-portal').disabled"));
    await click('#portal-manual-settings > summary');
    check('manual-path-controls-remain-expandable', await execute("document.getElementById('portal-manual-settings').open&&document.getElementById('portal-executable').textContent.includes('heart-portal.exe')"));
    await click('#select-portal-executable');
    await click('#select-portal-config');
    await click('#start-portal');
    check('manual-actions-use-original-ipc', calls('selectPortalExecutable').length === 1 && calls('selectPortalConfig').length === 1 && calls('startPortal').length === 1);
    await click('#portal-permissions > summary');
    await domWait('!document.getElementById("portal-permission-exec").disabled');
    check('permissions-read-from-config',await execute('!document.getElementById("portal-permission-exec").checked&&document.getElementById("portal-permission-file").checked'));
    fixtureState.portal.owned=true;
    await publish();
    check('permission-save-explains-restart',await execute('document.getElementById("portal-permission-save").textContent.includes("重启")'));
    await click('#portal-permission-exec');
    check('permission-toggle-does-not-save',calls('savePortalPermissions').length===0);
    await click('#portal-permission-save');
    await domWait('document.getElementById("portal-permission-status").textContent.includes("已保存")');
    check('permission-save-sends-selected-flags',permissions.exec===true&&permissions.file===true&&permissions.screenshot===false);
    await click('#portal-permission-refresh');
    await domWait('!document.getElementById("portal-permission-exec").disabled');
    check('permissions-survive-reload',await execute('document.getElementById("portal-permission-exec").checked'));
    check('permission-controls-use-switch-semantics',await execute('[...document.querySelectorAll("#portal-permission-fields input")].every(input=>input.getAttribute("role")==="switch"&&getComputedStyle(input).appearance==="none")'));
    await execute('document.getElementById("portal-permission-screenshot").focus()');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
    await settle();
    check('permission-switch-supports-keyboard-without-saving',await execute('document.getElementById("portal-permission-screenshot").checked')&&calls('savePortalPermissions').length===1);
    await click('#portal-permission-refresh');
    await domWait('!document.getElementById("portal-permission-exec").disabled');
    await execute('dismissToast();document.getElementById("portal-manual-settings").open=false');
    win.setContentSize(1440,940);
    await settle();
    await capture('permissions');
    check('fixture-window-never-shown', BrowserWindow.getAllWindows().every(item => !item.isVisible()));
    check('no-network-attempts', report.blockedRequests.length === 0, report.blockedRequests);
    check('no-renderer-errors', report.errors.length === 0, report.errors);
    report.passed = true;
  }

  const deadline = setTimeout(() => {report.passed = false; report.error = 'Portal fixture exceeded its deadline.'; void finish();}, 60000);
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
