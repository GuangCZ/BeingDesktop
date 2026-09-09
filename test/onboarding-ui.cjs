'use strict';

// Exercise the real shell and preload with isolated IPC fixtures. This never
// opens a live Loom, installs software, sends a live message, or reads a saved profile.
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
  const runRoot = path.join(root, '.local', `onboarding-ui-${randomUUID()}`);
  const loomUrl = 'https://fixture.invalid/loom/preview_being?token=offline-fixture-only';
  const report = {
    version: require('../package.json').version,
    scope: 'Real renderer and preload, offline IPC fixtures, hidden Electron window. UI wiring and explicit simulated greeting delivery only; no live connection, installation, or message sending.',
    checks: [], calls: [], screenshots: [], observations: [], errors: [], blockedRequests: [],
  };
  const fixtureState = {
    version: report.version,
    machine: {hostname: 'Preview PC', user: 'Preview'},
    connection: {configured: false, beingName: '', displayUrl: '', status: 'disconnected'},
    onboarding: {step: 'loom', completed: false},
    onboardingInspection: null,
    workspace: {path: '', files: []},
    portal: {status: 'not_configured', health: 'unknown', executable: '', configPath: '', pid: null, owned: false, detail: ''},
    townApp: {
      platformSupported: true, access: {}, identity: {beingId: 'preview_being', displayName: 'Preview Being', identityRevision: 1, connectionRevision: 1},
      portalWorkspace: {path: 'C:\\Fixture\\portal-workspace', isDefault: true},
      portalInstall: {status: 'idle', phase: '', detail: ''},
    },
  };
  const toolsState = {browser: {tabs: [], activeTabId: null}, console: {jobs: []}, link: {status: 'disconnected'}, requests: [], workspace: ''};
  let win;
  let deployment;
  let failStep = '';
  let expectedGreeting = null;
  let greetingDelivery;
  let deferInspection = true;
  const inspections = [];
  const existingInspection = {
    status: 'partial', beingId: 'preview_being', connectionRevision: 1, checkedAt: '2026-09-08T04:00:00Z',
    identity: {status: 'ready', name: 'Preview Being', createdAt: '2025-01-01T00:00:00Z', lifecycle: 'existing'},
    model: {status: 'configured', name: 'Fixture Model', provider: 'Fixture Provider'},
    channels: {status: 'ready', items: [{channel: 'feishu', status: 'connected', configured: true}, {channel: 'wechat', status: 'disconnected', configured: null}], detail: ''},
    portal: {status: 'unknown', items: [], detail: '当前 Being 的远端 Portal 状态尚未确认；本机 Portal 可在下一步单独配置。'},
  };
  let nextInspection = structuredClone(existingInspection);
  const bonfireMessages = [];
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
  const stepVisible = step => `document.getElementById('setup-wizard')?.open&&!!document.querySelector('#setup-wizard [data-card="${step}"]')?.getClientRects().length`;
  const waitStep = step => domWait(stepVisible(step), `${step} card`);
  const latestView = () => calls('setView').at(-1)?.args[0];

  async function finishInspection(request, result = nextInspection) {
    const identity = fixtureState.townApp.identity;
    if (result.beingId === identity.beingId && result.connectionRevision === identity.connectionRevision) {
      fixtureState.onboardingInspection = structuredClone(result);
      await publish();
    }
    request.resolve(structuredClone(result));
    await settle();
  }

  async function click(selector, {disabled = false} = {}) {
    await execute(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'nearest'})`);
    await settle();
    const point = await execute(`(() => {
      const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect();
      const x=r.x+r.width/2,y=r.y+r.height/2;
      const hit=document.elementFromPoint(x,y);
      if(!el.contains(hit))throw new Error('Fixture click target '+${JSON.stringify(selector)}+' is obscured by '+(hit?.id||hit?.tagName||'viewport')+' at '+x+','+y+'.');
      if(el.disabled&&!${disabled})throw new Error('Fixture click target is disabled.');
      return {x:Math.round(x),y:Math.round(y)};
    })()`);
    win.webContents.sendInputEvent({type: 'mouseMove', ...point});
    win.webContents.sendInputEvent({type: 'mouseDown', button: 'left', clickCount: 1, ...point});
    win.webContents.sendInputEvent({type: 'mouseUp', button: 'left', clickCount: 1, ...point});
    await settle();
  }

  async function editLoom(value) {
    await execute(`(() => {const el=document.getElementById('setup-loom-url');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await settle();
  }

  async function restartOnboarding() {
    if (!await execute("document.body.dataset.page==='settings'")) await click('.nav-button[data-page="settings"]');
    await click('[data-settings-section="about"]');
    await click('#setup-restart');
  }

  async function editGreeting(value) {
    await execute(`(() => {const el=document.getElementById('bonfire-draft');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await settle();
  }

  async function sendGreeting(content, result) {
    expectedGreeting = content;
    const before = calls('sendBonfireMessage').length;
    await click('#bonfire-send');
    await waitFor(() => greetingDelivery, 'explicit greeting send');
    check('greeting-pending-keeps-onboarding-incomplete', fixtureState.onboarding.step === 'bonfire' && !fixtureState.onboarding.completed);
    await click('#bonfire-send', {disabled: true});
    check('greeting-pending-blocks-duplicate-clicks', calls('sendBonfireMessage').length === before + 1);
    if (result.ok === true && result.status !== 'uncertain') {
      bonfireMessages.push({id: result.id, being: 'preview_being', beingName: 'Preview Being', content, createdAt: '2026-09-07T04:00:00Z'});
      if (!result.onboardingError) {
        fixtureState.onboarding = {step: 'complete', completed: true};
        result.onboarding = structuredClone(fixtureState.onboarding);
        await publish();
      }
    }
    const delivery = greetingDelivery; greetingDelivery = undefined;
    delivery.resolve(result);
    await domWait("document.getElementById('bonfire-send').getAttribute('aria-busy')==='false'", 'greeting send finished');
    expectedGreeting = null;
  }

  async function load() {
    await win.loadFile(entry);
    await domWait(`document.getElementById('app-version').textContent.includes(${JSON.stringify(report.version)})`, 'initial public state');
    // Offscreen windows are hidden. Simulate a visible document so native-view
    // assertions prove modal suppression instead of document.hidden behavior.
    await execute("Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'))");
    await settle();
  }

  const snapshot = `(() => {
    const geometry = el => {
      if(!el)return null;
      const r=el.getBoundingClientRect(),style=getComputedStyle(el);
      const visible=Boolean(el.getClientRects().length)&&style.visibility!=='hidden'&&r.width>0&&r.height>0;
      const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {visible,uncovered:visible&&Boolean(hit&&(hit===el||el.contains(hit))),disabled:Boolean(el.disabled),x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};
    };
    const dialog=document.getElementById('setup-wizard');
    return {width:innerWidth,height:innerHeight,bodyWidth:document.documentElement.scrollWidth,open:dialog.open,
      dialog:geometry(dialog),dialogWidth:dialog.clientWidth,dialogScrollWidth:dialog.scrollWidth,
      cards:[...dialog.querySelectorAll('[data-card]')].map(el=>({step:el.dataset.card,...geometry(el)})),
      controls:Object.fromEntries([...(dialog.open?dialog.querySelectorAll('button[id],input[id]'):document.querySelectorAll('#setup-resume button,#bonfire-draft,#bonfire-send'))].map(el=>[el.id,geometry(el)]))};
  })()`;

  async function capture(name, expectedStep) {
    await settle();
    const observation = await execute(snapshot);
    report.observations.push({phase: name, ...observation});
    let previousHash = '';
    let stableFrames = 0;
    let paintedImage;
    for (let attempt = 0; attempt < 35 && stableFrames < 3; attempt++) {
      const painted = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {win.webContents.removeListener('paint', listener); reject(new Error('Offscreen paint timed out.'));}, 5000);
        const listener = (_event, _dirty, image) => {
          if (image.getSize().width !== observation.width || image.getSize().height !== observation.height) return;
          clearTimeout(timer); win.webContents.removeListener('paint', listener); resolve(image);
        };
        win.webContents.on('paint', listener);
      });
      win.webContents.invalidate();
      paintedImage = await painted;
      const bounds = observation.open ? observation.dialog : {x: 0, y: 0, right: observation.width, bottom: observation.height};
      const crop = {x: Math.max(0, Math.ceil(bounds.x)), y: Math.max(0, Math.ceil(bounds.y))};
      crop.width = Math.floor(Math.min(bounds.right, observation.width)) - crop.x;
      crop.height = Math.floor(Math.min(bounds.bottom, observation.height)) - crop.y;
      const hash = createHash('sha256').update(paintedImage.crop(crop).toBitmap()).digest('hex');
      stableFrames = hash === previousHash ? stableFrames + 1 : 0;
      previousHash = hash;
      // Offscreen resize may initially deliver the previous frame cropped.
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(stableFrames >= 3, 'The onboarding screenshot did not settle.');
    const output = path.join(runRoot, `${name}.png`);
    await fs.writeFile(output, paintedImage.toPNG());
    report.screenshots.push({path: output, width: observation.width, height: observation.height});
    if (expectedStep) {
      check(`${name}-one-card-visible`, observation.cards.filter(card => card.visible).length === 1 && observation.cards.find(card => card.visible)?.step === expectedStep);
      check(`${name}-dialog-within-viewport`, observation.dialog.x >= 0 && observation.dialog.y >= 0 && observation.dialog.right <= observation.width && observation.dialog.bottom <= observation.height);
    } else check(`${name}-native-bonfire-visible`, !observation.open && await execute("document.body.dataset.page==='town-app'&&document.getElementById('page-town-app').dataset.townModule==='bonfire'"));
    check(`${name}-no-horizontal-overflow`, observation.bodyWidth <= observation.width && observation.dialogScrollWidth <= observation.dialogWidth + 1);
    for (const [id, control] of Object.entries(observation.controls).filter(([, control]) => control.visible)) {
      check(`${name}-${id}-visible-and-uncovered`, control.uncovered && control.x >= 0 && control.y >= 0 && control.right <= observation.width && control.bottom <= observation.height);
    }
    return observation;
  }

  function handle(method, callback) {
    ipcMain.handle(`being:${method}`, (event, ...args) => {
      assert.equal(event.sender, win.webContents);
      assert.equal(event.senderFrame, win.webContents.mainFrame);
      report.calls.push({method, args: method === 'connect' ? ['[redacted Loom URL]'] : structuredClone(args)});
      return callback(...args);
    });
  }

  async function run() {
    await fs.mkdir(runRoot, {recursive: true});
    await app.whenReady();
    handle('getState', () => fixtureState);
    handle('getWindowState', () => ({maximized: false}));
    handle('refresh', () => fixtureState);
    handle('getTownCatalog', () => require('../src/town.cjs').getTownCatalog());
    handle('getTownAppState', () => fixtureState.townApp);
    handle('getTownCachedData', () => ({cached: false}));
    handle('getGroveCatalog', () => ({kits: [{id: 'fixture-notes', name: 'Fixture Notes', description: '离线示例工具包', version: '1.0.0', category: 'productivity'}], count: 1}));
    handle('getBeingMembers', () => ({members: [{id: 'preview_being', name: 'Preview Being'}, {id: 'neighbor', name: '小镇邻居'}]}));
    const townSnapshot = request => {
      assert.deepEqual(request, {kind: 'bonfire'});
      return {kind: 'bonfire', snapshot: {identity: structuredClone(fixtureState.townApp.identity), messages: structuredClone(bonfireMessages), latestSeq: bonfireMessages.length}, status: {status: 'ready', lastSuccessAt: '2026-09-07T04:00:00Z'}};
    };
    handle('getTownMessageSnapshot', townSnapshot);
    handle('refreshTownMessages', townSnapshot);
    handle('getModelConfig', () => ({config: {model: '', provider: '', baseUrl: '', hasApiKey: false}, models: [], providers: [], connectionId: 1, modelsError: ''}));
    handle('getDesktopTools', () => toolsState);
    handle('getFeatureTasks', () => ({tasks: []}));
    handle('markShellEditingTarget', () => ({}));
    handle('getTerminalState', () => ({sessions: [], activeSessionId: null}));
    handle('listWorkspace', () => ({files: []}));
    handle('setView', () => ({}));
    handle('setBrowserView', () => ({}));
    handle('setOnboardingStep', step => {
      assert(['loom', 'review', 'portal', 'channel', 'grove', 'town', 'bonfire', 'complete'].includes(step), 'Expected a known onboarding step');
      if (failStep === step) {failStep = ''; throw new Error('进度未能保存，请重试。');}
      fixtureState.onboarding = {step, completed: step === 'complete'};
      return structuredClone(fixtureState);
    });
    handle('connect', value => {
      require('../src/security.cjs').parseConnection(value);
      assert(value === loomUrl, 'Expected the fixture Loom URL');
      fixtureState.connection = {configured: true, beingName: 'preview_being', displayUrl: 'https://fixture.invalid/loom/preview_being', status: 'connecting'};
      return structuredClone(fixtureState);
    });
    handle('inspectOnboarding', () => {
      assert.equal(fixtureState.connection.status, 'connected', 'Inspect only after Loom connects');
      if (deferInspection) return new Promise((resolve, reject) => {inspections.push({resolve, reject});});
      fixtureState.onboardingInspection = structuredClone(nextInspection);
      return structuredClone(nextInspection);
    });
    handle('cancelOnboardingInspection', () => {
      for (const request of inspections.splice(0)) request.reject(new Error('配置读取已取消。'));
      return {};
    });
    handle('deployPortal', value => {
      assert.deepEqual(value, {confirmed: true, permissions: {files: true, exec: false, web: false}});
      assert.equal(deployment, undefined, 'Only one deployment may be pending');
      return new Promise((resolve, reject) => {deployment = {resolve, reject};});
    });
    handle('startPortal', () => {
      fixtureState.portal = {...fixtureState.portal, status: 'running', health: 'healthy', pid: 4242, owned: true, detail: '已有 Portal 已启动，连接健康已确认。'};
      return structuredClone(fixtureState);
    });
    handle('sendBonfireMessage', value => {
      assert.notEqual(expectedGreeting, null, 'A greeting requires an explicit fixture Send click');
      assert.deepEqual(value, {content: expectedGreeting, mentions: expectedGreeting.includes('@neighbor') ? ['neighbor'] : [], connectionRevision: 1});
      assert.equal(greetingDelivery, undefined, 'Only one greeting may be pending');
      return new Promise(resolve => {greetingDelivery = {resolve};});
    });
    for (const method of ['sendFiresideMessage', 'beginChannelConnection', 'prepareTownAssistance', 'prepareTownFeature', 'checkChannelStatus', 'prepareGroveInstallation', 'requestTownRead']) {
      handle(method, () => {throw new Error('The onboarding fixture must never initiate Being messages.');});
    }

    win = new BrowserWindow({show: false, frame: false, width: 1440, height: 980, useContentSize: true,
      webPreferences: {preload: path.join(root, 'src', 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: `onboarding-ui-${randomUUID()}`}});
    win.webContents.setFrameRate(30);
    win.webContents.on('console-message', event => {if (event.level === 'error') report.errors.push(event.message);});
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      if (details.url.startsWith('file:')) allowed = fileURLToPath(details.url).startsWith(renderer + path.sep);
      if (!allowed) report.blockedRequests.push(new URL(details.url).origin);
      callback({cancel: !allowed});
    });

    await load();
    await waitStep('loom');
    check('first-launch-opens-a-native-modal', await execute("document.getElementById('setup-wizard').tagName==='DIALOG'&&document.getElementById('setup-wizard').matches(':modal')"));
    check('loom-input-initially-focused', await execute("document.activeElement.id==='setup-loom-url'"));
    check('no-setup-side-effects-on-first-launch', calls('connect').length === 0 && calls('inspectOnboarding').length === 0 && calls('deployPortal').length === 0 && calls('setOnboardingStep').length === 0);
    await capture('01-loom-1440', 'loom');

    await editLoom('not-a-url');
    await click('#setup-loom-connect');
    await domWait("!document.getElementById('setup-loom-connect').disabled", 'invalid URL feedback');
    check('invalid-url-keeps-first-card', await execute(stepVisible('loom')) && fixtureState.connection.configured === false && calls('setOnboardingStep').length === 0);
    check('invalid-url-has-feedback', await execute("Boolean(document.getElementById('setup-feedback-loom').textContent.trim())||!document.getElementById('setup-loom-url').validity.valid"));
    await editLoom(loomUrl);
    await click('#setup-loom-connect');
    await waitFor(() => calls('connect').length === 2, 'connection IPC');
    await domWait("document.getElementById('setup-loom-connect').disabled", 'connecting controls');
    check('connecting-does-not-advance', await execute(stepVisible('loom')) && calls('setOnboardingStep').length === 0);
    check('connecting-does-not-inspect-unready-connection', calls('inspectOnboarding').length === 0);
    check('native-loom-hidden-while-connecting', latestView()?.visible === false);
    fixtureState.connection.status = 'connected';
    await publish();
    await domWait("!document.getElementById('setup-wizard').open", 'connected Loom suppresses automatic guide');
    check('successful-loom-closes-auto-guide-without-inspection', calls('inspectOnboarding').length === 0);
    fixtureState.onboardingAutoSuppressed = true;
    await restartOnboarding();
    await click('#setup-loom-existing');
    await waitFor(() => inspections.length === 1, 'configuration inspection IPC');
    check('configuration-loading-keeps-loom-card', await execute(stepVisible('loom')) && calls('setOnboardingStep').length === 0);
    check('configuration-loading-has-progress-feedback', await execute("document.getElementById('setup-wizard').getAttribute('aria-busy')==='true'&&Boolean(document.getElementById('setup-feedback-loom').textContent.trim())"));
    check('inspection-is-read-only', calls('deployPortal').length === 0 && calls('startPortal').length === 0 && calls('sendBonfireMessage').length === 0 && calls('beginChannelConnection').length === 0);
    check('native-loom-hidden-during-inspection', latestView()?.visible === false);
    await publish();
    check('repeated-connected-state-does-not-duplicate-inspection', calls('inspectOnboarding').length === 1);
    await finishInspection(inspections.shift());
    deferInspection = false;
    await waitStep('review');
    check('connected-inspection-advances-once-and-persists-review', fixtureState.onboarding.step === 'review' && calls('setOnboardingStep').filter(call => call.args[0] === 'review').length === 1);
    check('existing-being-is-recognized-on-first-desktop-use', await execute("(()=>{const copy=document.getElementById('setup-review-identity').textContent;return copy.includes('Preview Being')&&/已有|既有|使用中|已创建|创建于/.test(copy)&&!copy.includes('刚创建')})()"));
    check('review-shows-existing-model', await execute("document.getElementById('setup-review-model').textContent.includes('Fixture Model')"));
    check('review-shows-existing-channel-state', await execute("(()=>{const copy=document.getElementById('setup-review-channels').textContent;return copy.includes('飞书')&&/已连接|已配置/.test(copy)&&copy.includes('微信')&&copy.includes('已断开')&&!copy.includes('未配置')})()"));
    check('review-distinguishes-local-portal-from-unknown-remote-state', await execute("/未提供|未知|未确认|无法确认/.test(document.getElementById('setup-review-portals').textContent)&&/这台电脑|本机/.test(document.getElementById('setup-review-local-portal').textContent)"));
    check('review-waits-for-an-explicit-choice', calls('deployPortal').length === 0 && calls('sendBonfireMessage').length === 0 && fixtureState.onboarding.step === 'review');
    await capture('02-review-existing-1440', 'review');
    win.setContentSize(680, 820);
    await domWait('innerWidth===680&&innerHeight===820');
    await capture('02-review-existing-680', 'review');
    win.setContentSize(1440, 980);
    await domWait('innerWidth===1440&&innerHeight===980');
    await click('#setup-review-continue');
    await waitStep('portal');
    check('explicit-setup-choice-persists-portal', fixtureState.onboarding.step === 'portal' && calls('setOnboardingStep').filter(call => call.args[0] === 'portal').length === 1);
    check('native-loom-hidden-behind-connected-modal', latestView()?.visible === false);
    check('connection-does-not-deploy-portal', calls('deployPortal').length === 0);
    check('secret-input-cleared-after-connection', await execute("document.getElementById('setup-loom-url').value===''"));
    await capture('02-portal-1440', 'portal');

    await click('#setup-portal-deploy');
    await waitFor(() => deployment, 'deployment IPC');
    check('explicit-deployment-is-conservative-and-single', calls('deployPortal').length === 1 && await execute("document.getElementById('setup-portal-deploy').disabled"));
    await click('#setup-portal-deploy', {disabled: true});
    await execute("document.getElementById('setup-portal-deploy').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
    await settle();
    check('duplicate-clicks-do-not-deploy-twice', calls('deployPortal').length === 1);
    fixtureState.townApp.portalInstall = {status: 'installing', phase: 'download', detail: '正在下载官方程序。', receivedBytes: 5242880, totalBytes: 10485760};
    await publish();
    check('deployment-progress-reaches-card', await execute("document.getElementById('setup-feedback-portal').textContent.includes('下载')"));
    check('download-progress-follows-main-process-bytes', await execute("(()=>{const progress=document.getElementById('setup-portal-progress');return !progress.hidden&&progress.max>0&&progress.value/progress.max===0.5})()"));
    check('deployment-stays-on-portal', await execute(stepVisible('portal')));

    fixtureState.townApp.portalInstall = {status: 'error', phase: 'download', detail: '下载未完成，请检查网络后重试。'};
    await publish();
    const failed = deployment; deployment = undefined;
    failed.reject(new Error('下载未完成，请检查网络后重试。'));
    await domWait("!document.getElementById('setup-portal-deploy').disabled", 'retry after deployment failure');
    check('deployment-error-keeps-actionable-feedback', await execute("document.getElementById('setup-feedback-portal').textContent.includes('下载未完成')"));
    check('deployment-error-hides-ipc-wrapper', await execute("!document.getElementById('setup-feedback-portal').textContent.includes('Error invoking remote method')"));
    win.setContentSize(1000, 740);
    await domWait('innerWidth===1000&&innerHeight===740');
    await capture('03-portal-retry-1000', 'portal');
    await click('#setup-portal-deploy');
    await waitFor(() => deployment, 'retry deployment IPC');
    check('retry-starts-one-additional-deployment', calls('deployPortal').length === 2);
    fixtureState.portal = {status: 'running', health: 'healthy', executable: 'C:\\Fixture\\heart-portal.exe', configPath: 'C:\\Fixture\\portal.json', pid: 4242, owned: true, detail: 'Portal 已启动，连接健康已确认。'};
    fixtureState.townApp.portalInstall = {status: 'ready', phase: 'running', detail: fixtureState.portal.detail, verified: true};
    await publish();
    const succeeded = deployment; deployment = undefined;
    succeeded.resolve({status: 'running', detail: fixtureState.portal.detail, state: structuredClone(fixtureState)});
    await domWait("!document.getElementById('setup-portal-next').hidden&&!document.getElementById('setup-portal-next').disabled", 'portal continue');
    await click('#setup-portal-next');
    await waitStep('channel');
    check('portal-continue-persists-channel-step', fixtureState.onboarding.step === 'channel');
    check('channel-card-retains-discovered-configuration', await execute("/已连接|已配置/.test(document.getElementById('setup-channel-status-feishu').textContent)&&document.getElementById('setup-channel-status-wechat').textContent.includes('已断开')&&document.getElementById('setup-channel-configure').textContent.includes('管理 Channel')"));
    await capture('04-channel-1000', 'channel');

    await click('#setup-channel-back');
    await waitStep('portal');
    await click('#setup-portal-back');
    await waitStep('review');
    await click('#setup-review-back');
    await waitStep('loom');
    check('back-navigation-keeps-existing-connection', fixtureState.connection.status === 'connected' && calls('connect').length === 2);
    await click('#setup-loom-existing');
    await waitStep('review');
    check('continue-existing-requests-fresh-inspection', calls('inspectOnboarding').length === 2);
    await click('#setup-review-continue');
    await waitStep('portal');
    check('continue-existing-does-not-reconnect', calls('connect').length === 2);
    await click('#setup-portal-next');
    await waitStep('channel');

    await click('#setup-channel-configure');
    await domWait("!document.getElementById('setup-wizard').open&&document.body.dataset.page==='town-app'&&document.getElementById('page-town-app').dataset.townModule==='channel'", 'channel configuration page');
    check('configure-channel-retains-pending-progress', !fixtureState.onboarding.completed && fixtureState.onboarding.step === 'channel');
    check('channel-configuration-requires-another-explicit-action', await execute("Boolean(document.getElementById('channel-connect'))"));
    check('channel-handoff-offers-visible-resume', await execute("!document.getElementById('setup-resume').hidden&&!document.getElementById('setup-resume-next').disabled"));
    failStep = 'grove';
    await click('#setup-resume-next');
    await domWait("!document.getElementById('setup-resume-next').disabled", 'Grove progress persistence retry');
    check('handoff-persistence-error-retains-current-page-and-step', fixtureState.onboarding.step === 'channel' && await execute("!document.getElementById('setup-wizard').open&&document.getElementById('page-town-app').dataset.townModule==='channel'"));
    check('handoff-persistence-error-has-feedback', await execute("document.getElementById('setup-resume-description').textContent.includes('重试')"));
    await click('#setup-resume-next');
    await waitStep('grove');
    win.setContentSize(1440, 980);
    await domWait('innerWidth===1440&&innerHeight===980');
    await capture('05-grove-1440', 'grove');
    win.setContentSize(680, 820);
    await domWait('innerWidth===680&&innerHeight===820');
    await capture('06-grove-680', 'grove');
    await click('#setup-grove-open');
    await domWait("!document.getElementById('setup-wizard').open&&document.getElementById('page-town-app').dataset.townModule==='grove'", 'native Grove catalog');
    await waitFor(() => calls('getGroveCatalog').length > 0, 'offline Grove catalog read');
    check('grove-opens-market-without-pretending-installation-completed', !fixtureState.onboarding.completed && fixtureState.onboarding.step === 'grove' && calls('prepareGroveInstallation').length === 0);
    await click('#setup-resume-next');
    await waitStep('town');
    await capture('07-town-680', 'town');
    win.setContentSize(1440, 980);
    await domWait('innerWidth===1440&&innerHeight===980');
    await capture('08-town-1440', 'town');
    check('town-introduces-bonfire-fireside-and-scroll', await execute("(()=>{const copy=document.querySelector('[data-card=\"town\"]').textContent;return ['篝火','围炉','卷轴'].every(label=>copy.includes(label))})()"));
    await click('#setup-town-back');
    await waitStep('grove');
    await click('#setup-grove-skip');
    await waitStep('town');
    check('skip-grove-continues-to-town-without-installing', fixtureState.onboarding.step === 'town' && calls('prepareGroveInstallation').length === 0);
    await click('#setup-town-next');
    await waitStep('bonfire');
    await capture('09-bonfire-1440', 'bonfire');
    win.setContentSize(680, 820);
    await domWait('innerWidth===680&&innerHeight===820');
    await capture('10-bonfire-680', 'bonfire');
    check('bonfire-explains-public-publication', await execute("document.querySelector('[data-card=\"bonfire\"]').textContent.includes('公开')"));
    await click('#setup-bonfire-open');
    await domWait("!document.getElementById('setup-wizard').open&&document.getElementById('page-town-app').dataset.townModule==='bonfire'&&!document.getElementById('bonfire-send').disabled", 'native greeting composer');
    await waitFor(() => calls('getBeingMembers').length > 0, 'offline Bonfire member read');
    check('opening-bonfire-only-prefills-and-focuses-draft', await execute("document.getElementById('bonfire-draft').value==='大家好！我刚来到 Town，很高兴认识大家，期待在这里一起交流！'&&document.activeElement.id==='bonfire-draft'") && calls('sendBonfireMessage').length === 0 && calls('requestTownRead').length === 0);
    check('opening-bonfire-does-not-complete-onboarding', fixtureState.onboarding.step === 'bonfire' && !fixtureState.onboarding.completed);
    await capture('11-native-greeting-680');
    const greeting = '大家好！我是新来的 Preview，很高兴认识大家！';
    await editGreeting(greeting);
    await click('#setup-resume-next');
    await waitStep('bonfire');
    await click('#setup-bonfire-back');
    await waitStep('town');
    await click('#setup-town-next');
    await waitStep('bonfire');
    await click('#setup-bonfire-open');
    await domWait("!document.getElementById('setup-wizard').open", 'return to edited draft');
    check('returning-to-bonfire-preserves-edited-draft', await execute(`document.getElementById('bonfire-draft').value===${JSON.stringify(greeting)}`));
    check('navigation-never-sends-a-greeting-or-read-request', calls('sendBonfireMessage').length === 0 && calls('requestTownRead').length === 0);
    for (const [label, result] of [['uncertain', {ok: true, status: 'uncertain'}], ['missing-acknowledgment', {status: 'sent'}]]) {
      await sendGreeting(greeting, result);
      check(`${label}-retains-draft-and-pending-onboarding`, await execute(`document.getElementById('bonfire-draft').value===${JSON.stringify(greeting)}`) && fixtureState.onboarding.step === 'bonfire' && !fixtureState.onboarding.completed);
      check(`${label}-explains-uncertain-send`, await execute("document.querySelector('.ta-bonfire .ta-notice').textContent.includes('待确认')"));
    }
    const progressCalls = calls('setOnboardingStep').length;
    await execute("window.beingOnboarding.onBonfireSent({ok:true,id:'100',mentions:[]})");
    await settle();
    check('unassociated-send-receipt-cannot-complete-a-new-guide', fixtureState.onboarding.step === 'bonfire' && !fixtureState.onboarding.completed && calls('setOnboardingStep').length === progressCalls);
    await sendGreeting(greeting, {ok: true, id: '101', mentions: []});
    await domWait("document.getElementById('setup-resume').hidden&&document.getElementById('bonfire-draft').value===''", 'confirmed greeting completion');
    check('confirmed-edited-greeting-completes-onboarding', fixtureState.onboarding.completed && fixtureState.onboarding.step === 'complete');
    check('confirmed-greeting-appears-in-native-message-log', await execute(`document.getElementById('bonfire-messages').textContent.includes(${JSON.stringify(greeting)})`));
    win.setContentSize(1440, 980);
    await domWait('innerWidth===1440&&innerHeight===980');
    await capture('12-native-greeting-complete-1440');
    await load();
    check('completed-onboarding-is-suppressed-after-reload', !await execute("document.getElementById('setup-wizard').open"));
    check('completed-flow-restores-native-loom', latestView()?.visible === true);

    fixtureState.onboarding = {step: 'bonfire', completed: false};
    await load();
    await restartOnboarding();
    await waitStep('bonfire');
    await click('#setup-bonfire-open');
    const retryGreeting = '大家好，期待在 Town 与大家交流！';
    await editGreeting(retryGreeting);
    await sendGreeting(retryGreeting, {ok: true, id: '102', onboardingError: '进度未能保存，请重试。'});
    check('sent-greeting-clears-draft-despite-progress-persistence-error', await execute("document.getElementById('bonfire-draft').value===''") && !fixtureState.onboarding.completed);
    check('progress-error-offers-save-without-resending', await execute("document.getElementById('setup-resume-next').textContent.includes('保存')&&document.getElementById('setup-resume-description').textContent.includes('无需再次发送')"));
    const sendsBeforeSave = calls('sendBonfireMessage').length;
    failStep = 'complete';
    await click('#setup-resume-next');
    await domWait("!document.getElementById('setup-resume-next').disabled", 'completion save failure');
    check('completion-save-failure-retains-retry-and-does-not-resend', !fixtureState.onboarding.completed && calls('sendBonfireMessage').length === sendsBeforeSave && await execute("!document.getElementById('setup-resume').hidden"));
    await click('#setup-resume-next');
    await domWait("document.getElementById('setup-resume').hidden", 'completion save retry');
    check('completion-save-retry-finishes-without-another-message', fixtureState.onboarding.completed && calls('sendBonfireMessage').length === sendsBeforeSave);
    await load();
    check('retried-completion-is-suppressed-after-reload', !await execute("document.getElementById('setup-wizard').open"));

    fixtureState.portal = {status: 'not_configured', health: 'unknown', executable: '', configPath: '', pid: null, owned: false, detail: ''};
    fixtureState.townApp.portalInstall = {status: 'idle', phase: '', detail: ''};
    await publish();
    await click('#header-settings');
    await restartOnboarding();
    await waitStep('loom');
    check('settings-restarts-onboarding', fixtureState.onboarding.step === 'loom' && fixtureState.onboarding.completed === false);
    await click('#setup-loom-existing');
    await waitStep('review');
    await click('#setup-review-continue');
    await waitStep('portal');
    await click('#setup-portal-skip');
    await waitStep('channel');
    check('portal-skip-does-not-deploy', calls('deployPortal').length === 2);
    await click('#setup-close');
    await domWait("!document.getElementById('setup-wizard').open", 'dismissed wizard');
    check('dismiss-retains-pending-progress', fixtureState.onboarding.step === 'channel' && fixtureState.onboarding.completed === false);
    await publish();
    check('background-state-does-not-reopen-dismissed-wizard', !await execute("document.getElementById('setup-wizard').open"));
    await load();
    check('connected-pending-guide-stays-closed-after-reload', !await execute("document.getElementById('setup-wizard').open"));
    await restartOnboarding();
    await waitStep('channel');
    check('pending-onboarding-resumes-manually', fixtureState.onboarding.step === 'channel' && latestView()?.visible === false);
    await click('#setup-channel-skip');
    await waitStep('grove');
    check('channel-skip-continues-to-grove-without-opening-channel', !fixtureState.onboarding.completed && fixtureState.onboarding.step === 'grove' && await execute("document.body.dataset.page==='settings'"));
    for (const pendingStep of ['grove', 'town', 'bonfire']) {
      fixtureState.onboarding = {step: pendingStep, completed: false};
      await load();
      check(`${pendingStep}-does-not-auto-open-after-reload`, !await execute("document.getElementById('setup-wizard').open"));
      await restartOnboarding();
      await waitStep(pendingStep);
      check(`${pendingStep}-resumes-after-reload`, fixtureState.onboarding.step === pendingStep && latestView()?.visible === false);
      await click('#setup-close');
      await publish();
      check(`${pendingStep}-dismiss-retains-step-without-reopening`, fixtureState.onboarding.step === pendingStep && !fixtureState.onboarding.completed && !await execute("document.getElementById('setup-wizard').open"));
      await load();
      check(`${pendingStep}-does-not-auto-open-after-reload`, !await execute("document.getElementById('setup-wizard').open"));
      await restartOnboarding();
      await waitStep(pendingStep);
    }
    fixtureState.onboarding = {step: 'grove', completed: false};
    await load();
    await restartOnboarding();
    await waitStep('grove');
    await click('#setup-grove-open');
    await domWait("!document.getElementById('setup-wizard').open&&!document.getElementById('setup-resume').hidden", 'Grove handoff before disconnect');
    const savedConnection = structuredClone(fixtureState.connection);
    const savedIdentity = structuredClone(fixtureState.townApp.identity);
    fixtureState.connection = {configured: false, beingName: '', displayUrl: '', status: 'disconnected'};
    fixtureState.townApp.identity = {identityRevision: 2, connectionRevision: 2};
    fixtureState.onboarding = {step: 'loom', completed: false};
    await publish();
    check('identity-reset-clears-stale-grove-resume', await execute("document.getElementById('setup-resume').hidden") && fixtureState.onboarding.step === 'loom');
    await click('#header-settings');
    await restartOnboarding();
    await waitStep('loom');
    check('settings-resumes-loom-after-identity-reset', fixtureState.onboarding.step === 'loom' && !fixtureState.onboarding.completed);
    fixtureState.connection = savedConnection;
    fixtureState.townApp.identity = savedIdentity;
    fixtureState.onboarding = {step: 'complete', completed: true};
    await load();
    check('previously-completed-profiles-do-not-restart-new-steps', !await execute("document.getElementById('setup-wizard').open") && latestView()?.visible === true);

    const portalFixture = {status: 'stopped', health: 'unknown', executable: 'C:\\Fixture\\heart-portal.exe', configPath: 'C:\\Fixture\\existing-portal.json', pid: null, owned: false, detail: ''};
    const loadPortalFixture = async value => {
      fixtureState.portal = {...portalFixture, ...value};
      fixtureState.townApp.portalInstall = {status: 'idle', phase: '', detail: ''};
      fixtureState.onboarding = {step: 'portal', completed: false};
      await load();
      await restartOnboarding();
      await waitStep('portal');
    };
    const originalDeployments = calls('deployPortal').length;
    await loadPortalFixture({});
    check('existing-portal-does-not-promise-new-permissions', await execute("document.getElementById('setup-portal-permissions').hidden"));
    check('existing-portal-explains-existing-configuration', await execute("(()=>{const copy=document.querySelector('#setup-wizard [data-card=\"portal\"] .setup-description').textContent;return /已有|现有|原有/.test(copy)&&!copy.includes('自动下载')})()"));
    await click('#setup-portal-deploy');
    await domWait("!document.getElementById('setup-portal-next').hidden&&!document.getElementById('setup-portal-next').disabled", 'started existing Portal');
    check('existing-portal-starts-through-original-ipc', calls('startPortal').length === 1 && calls('deployPortal').length === originalDeployments);

    for (const [label, partial] of [['executable-only', {configPath: ''}], ['config-only', {executable: ''}]]) {
      await loadPortalFixture(partial);
      check(`${label}-offers-settings-repair`, await execute("document.getElementById('setup-portal-deploy').textContent.trim()==='检查 Portal 设置'"));
      check(`${label}-does-not-show-continue`, await execute("document.getElementById('setup-portal-next').hidden"));
      await click('#setup-portal-deploy');
      await domWait("!document.getElementById('setup-wizard').open&&document.body.dataset.page==='settings'", `${label} opens settings`);
      check(`${label}-keeps-pending-portal-progress`, fixtureState.onboarding.step === 'portal' && fixtureState.onboarding.completed === false);
      check(`${label}-does-not-deploy-or-start`, calls('deployPortal').length === originalDeployments && calls('startPortal').length === 1);
      await restartOnboarding();
      await waitStep('portal');
      check(`${label}-settings-resumes-same-card`, fixtureState.onboarding.step === 'portal');
    }

    const ownedError = '已有 Portal 进程异常，请检查设置。';
    await loadPortalFixture({status: 'error', owned: true, pid: 4242, detail: ownedError});
    check('owned-error-shows-actual-portal-detail', await execute(`document.getElementById('setup-feedback-portal').textContent.includes(${JSON.stringify(ownedError)})`));
    check('owned-error-does-not-claim-started', await execute("!document.getElementById('setup-feedback-portal').textContent.includes('已启动')&&document.getElementById('setup-portal-next').hidden"));
    check('owned-error-offers-settings-repair', await execute("document.getElementById('setup-portal-deploy').textContent.trim()==='检查 Portal 设置'&&!document.getElementById('setup-portal-deploy').hidden"));
    win.setContentSize(1000, 740);
    await domWait('innerWidth===1000&&innerHeight===740');
    await capture('13-owned-portal-error-1000', 'portal');
    await click('#setup-portal-deploy');
    await domWait("!document.getElementById('setup-wizard').open&&document.body.dataset.page==='settings'", 'owned Portal error settings');
    check('owned-error-does-not-start-another-process', calls('deployPortal').length === originalDeployments && calls('startPortal').length === 1);
    check('owned-error-keeps-pending-progress', fixtureState.onboarding.step === 'portal' && fixtureState.onboarding.completed === false);
    await restartOnboarding();
    await waitStep('portal');

    await loadPortalFixture({status: 'error', owned: false, detail: '上次启动失败，请重试。'});
    check('unowned-error-allows-existing-start-retry', await execute("(()=>{const button=document.getElementById('setup-portal-deploy');return !button.hidden&&!button.disabled&&/启动|重试/.test(button.textContent)&&document.getElementById('setup-portal-next').hidden})()"));
    await click('#setup-portal-deploy');
    await domWait("!document.getElementById('setup-portal-next').hidden&&!document.getElementById('setup-portal-next').disabled", 'retry existing Portal start');
    check('unowned-error-retries-existing-config-without-deploying', calls('startPortal').length === 2 && calls('deployPortal').length === originalDeployments);

    const setupCallsBeforeReview = {deployments: calls('deployPortal').length, starts: calls('startPortal').length, greetings: calls('sendBonfireMessage').length};
    const loadInspectionFixture = async ({step = 'loom', result = existingInspection, deferred = false} = {}) => {
      assert.equal(inspections.length, 0, 'Previous inspection fixture must be settled');
      nextInspection = structuredClone(result);
      deferInspection = deferred;
      fixtureState.connection = structuredClone(savedConnection);
      fixtureState.townApp.identity = structuredClone(savedIdentity);
      fixtureState.onboardingInspection = null;
      fixtureState.onboarding = {step, completed: false};
      await load();
      await restartOnboarding();
      await waitStep(step);
    };

    await loadInspectionFixture();
    fixtureState.connection.status = 'disconnected';
    await publish();
    await editLoom(loomUrl);
    await click('#setup-loom-connect');
    await domWait("document.getElementById('setup-loom-connect').disabled", 'connection pending before dismissal');
    const inspectionsBeforeConnectionDismissal = calls('inspectOnboarding').length;
    await click('#setup-close');
    fixtureState.connection.status = 'connected';
    await publish();
    check('dismissing-while-connecting-does-not-inspect-or-reopen-after-connection', calls('inspectOnboarding').length === inspectionsBeforeConnectionDismissal && fixtureState.onboarding.step === 'loom' && !await execute("document.getElementById('setup-wizard').open"));

    await loadInspectionFixture({deferred: true});
    await click('#setup-loom-existing');
    await waitFor(() => inspections.length === 1, 'cancellable inspection request');
    const progressBeforeInspectionDismissal = calls('setOnboardingStep').length;
    await click('#setup-close');
    await domWait("!document.getElementById('setup-wizard').open", 'dismissed inspection');
    await waitFor(() => calls('cancelOnboardingInspection').length === 1, 'cancel inspection IPC');
    check('dismissing-loading-cancels-inspection-without-advancing', inspections.length === 0 && fixtureState.onboarding.step === 'loom' && calls('setOnboardingStep').length === progressBeforeInspectionDismissal);
    await publish();
    check('cancelled-inspection-does-not-reopen-wizard', !await execute("document.getElementById('setup-wizard').open"));

    await loadInspectionFixture({deferred: true});
    await click('#setup-loom-existing');
    await waitFor(() => inspections.length === 1, 'failed inspection request');
    const progressBeforeInspectionFailure = calls('setOnboardingStep').length;
    inspections.shift().reject(new Error('配置状态暂时读取失败，请重试。'));
    await domWait("!document.getElementById('setup-loom-existing').disabled", 'inspection failure retry');
    check('inspection-request-failure-does-not-advance', fixtureState.onboarding.step === 'loom' && calls('setOnboardingStep').length === progressBeforeInspectionFailure && await execute(stepVisible('loom')));
    check('inspection-request-failure-has-actionable-feedback', await execute("document.getElementById('setup-feedback-loom').textContent.includes('重试')&&!document.getElementById('setup-feedback-loom').textContent.includes('Error invoking remote method')"));
    const failedInspectionCalls = calls('inspectOnboarding').length;
    await publish();
    check('failed-inspection-is-not-repeated-by-background-state', calls('inspectOnboarding').length === failedInspectionCalls);

    const partialInspection = {
      ...structuredClone(existingInspection), status: 'partial',
      identity: {status: 'unknown', name: '', createdAt: null, lifecycle: 'unknown'},
      model: {status: 'unknown', name: '', provider: ''},
      channels: {status: 'unknown', items: [{channel: 'feishu', status: 'unknown', configured: null}, {channel: 'wechat', status: 'unknown', configured: null}], detail: '暂时无法确认 Channel 状态。'},
      portal: {status: 'unknown', items: [], detail: '暂时无法确认 Portal 状态。'},
    };
    nextInspection = partialInspection;
    await click('#setup-loom-existing');
    await waitFor(() => inspections.length === 1, 'partial inspection retry');
    await finishInspection(inspections.shift());
    await waitStep('review');
    check('partial-inspection-stops-at-review', fixtureState.onboarding.step === 'review' && !fixtureState.onboarding.completed);
    check('partial-results-show-unknown-instead-of-new-or-unconfigured', await execute("['identity','model','channels'].every(key=>{const copy=document.getElementById('setup-review-'+key).textContent;return /未知|未确认|无法确认|暂未|未能|未提供|读取失败|无法读取/.test(copy)&&!/24 小时内创建|已有 Being|未配置|尚未选择模型/.test(copy)})"));
    check('partial-review-offers-retry-and-continue', await execute("['setup-review-retry','setup-review-continue'].every(id=>{const el=document.getElementById(id);return !el.hidden&&!el.disabled})"));
    check('native-loom-remains-hidden-behind-partial-review', latestView()?.visible === false);
    await capture('14-review-partial-1000', 'review');
    await click('#setup-review-retry');
    await waitFor(() => inspections.length === 1, 'review retry inspection');
    inspections.shift().reject(new Error('读取失败，请稍后重试。'));
    await domWait("!document.getElementById('setup-review-retry').disabled", 'review retry failure');
    check('review-retry-failure-retains-review', fixtureState.onboarding.step === 'review' && await execute(stepVisible('review')));
    nextInspection = structuredClone(existingInspection);
    await click('#setup-review-retry');
    await waitFor(() => inspections.length === 1, 'successful review retry');
    await finishInspection(inspections.shift());
    check('review-retry-replaces-unknown-with-current-configuration', await execute("document.getElementById('setup-review-model').textContent.includes('Fixture Model')&&/已连接|已配置/.test(document.getElementById('setup-review-channels').textContent)"));
    await click('#setup-review-continue');
    await waitStep('portal');
    check('review-continue-requires-explicit-portal-action', calls('deployPortal').length === setupCallsBeforeReview.deployments && calls('startPortal').length === setupCallsBeforeReview.starts);

    await loadInspectionFixture({result: {...structuredClone(existingInspection), identity: {...existingInspection.identity, lifecycle: 'unknown'}}});
    await click('#setup-loom-existing');
    await waitStep('review');
    check('known-creation-date-without-age-classification-remains-visible', await execute("(()=>{const copy=document.getElementById('setup-review-identity').textContent;return copy.includes('2025')&&!copy.includes('时间未提供')&&!/24 小时内创建|已有 Being/.test(copy)})()"));

    const recentInspection = {
      ...structuredClone(existingInspection),
      identity: {status: 'ready', name: 'Recently Created Being', createdAt: '2026-09-08T03:00:00Z', lifecycle: 'recent'},
      model: {status: 'unconfigured', name: '', provider: ''},
      channels: {status: 'unknown', items: [{channel: 'feishu', status: 'unknown', configured: null}, {channel: 'wechat', status: 'unknown', configured: null}], detail: '暂时无法确认 Channel 状态。'},
    };
    await loadInspectionFixture({step: 'review', result: recentInspection, deferred: true});
    await waitFor(() => inspections.length === 1, 'reinspect resumed review without a cached report');
    check('resumed-review-keeps-native-view-hidden-during-refresh', latestView()?.visible === false);
    await finishInspection(inspections.shift());
    check('recent-being-is-identified-from-server-creation-metadata', await execute("(()=>{const copy=document.getElementById('setup-review-identity').textContent;return copy.includes('Recently Created Being')&&/刚创建|刚刚创建|新创建|最近创建|24 小时|24小时/.test(copy)})()"));
    check('confirmed-missing-model-is-distinct-from-unknown-channel-state', await execute("/未配置|尚未选择模型/.test(document.getElementById('setup-review-model').textContent)&&/未知|暂未确认/.test(document.getElementById('setup-review-channels').textContent)&&!document.getElementById('setup-review-channels').textContent.includes('未配置')"));
    await capture('15-review-recent-1000', 'review');

    await loadInspectionFixture({deferred: true});
    await click('#setup-loom-existing');
    await waitFor(() => inspections.length === 1, 'Being A inspection');
    const staleInspection = inspections.shift();
    const progressBeforeIdentityChange = calls('setOnboardingStep').length;
    fixtureState.connection = {configured: true, beingName: 'another_being', displayUrl: 'https://fixture.invalid/loom/another_being', status: 'connected'};
    fixtureState.townApp.identity = {beingId: 'another_being', displayName: 'Another Being', identityRevision: 2, connectionRevision: 2};
    fixtureState.onboarding = {step: 'loom', completed: false};
    fixtureState.onboardingInspection = null;
    await publish();
    await finishInspection(staleInspection, existingInspection);
    await domWait("!document.getElementById('setup-loom-existing').disabled", 'new identity ready to inspect');
    check('old-being-inspection-cannot-advance-new-being', fixtureState.onboarding.step === 'loom' && calls('setOnboardingStep').length === progressBeforeIdentityChange && await execute(stepVisible('loom')));
    check('old-being-inspection-is-not-retained-for-new-being', fixtureState.onboardingInspection === null);
    nextInspection = {...structuredClone(existingInspection), beingId: 'another_being', connectionRevision: 2, identity: {...existingInspection.identity, name: 'Another Being'}};
    await click('#setup-loom-existing');
    await waitFor(() => inspections.length === 1, 'Being B inspection');
    await finishInspection(inspections.shift());
    await waitStep('review');
    check('new-being-review-uses-current-identity-only', await execute("document.getElementById('setup-review-identity').textContent.includes('Another Being')&&!document.getElementById('setup-review-identity').textContent.includes('Preview Being')"));
    await click('#setup-review-finish');
    await domWait("!document.getElementById('setup-wizard').open", 'experienced user direct completion');
    check('experienced-user-can-finish-without-repeating-setup-or-greeting', fixtureState.onboarding.completed && fixtureState.onboarding.step === 'complete' && calls('deployPortal').length === setupCallsBeforeReview.deployments && calls('startPortal').length === setupCallsBeforeReview.starts && calls('sendBonfireMessage').length === setupCallsBeforeReview.greetings);
    await load();
    check('review-direct-completion-persists-after-reload', !await execute("document.getElementById('setup-wizard').open") && latestView()?.visible === true);

    const forbidden = ['sendFiresideMessage', 'beginChannelConnection', 'prepareTownAssistance', 'prepareTownFeature', 'checkChannelStatus', 'prepareGroveInstallation', 'requestTownRead'];
    check('wizard-never-installs-or-prepares-being-messages-automatically', forbidden.every(method => calls(method).length === 0));
    check('only-explicit-greeting-clicks-invoke-simulated-send', calls('sendBonfireMessage').length === 4);
    check('fixture-window-never-shown', BrowserWindow.getAllWindows().every(item => !item.isVisible()));
    check('no-network-attempts', report.blockedRequests.length === 0, report.blockedRequests);
    fixtureState.onboarding = {step: 'portal', completed: false};
    fixtureState.onboardingAutoSuppressed = true;
    for (const status of ['connecting', 'error', 'disconnected']) {
      fixtureState.connection.status = status;
      await load();
      check(`verified-loom-stays-suppressed-on-reload-${status}`, !await execute("document.getElementById('setup-wizard').open"));
    }
    fixtureState.onboardingAutoSuppressed = false;
    fixtureState.connection.status = 'connecting';
    await load();
    check('saved-link-waits-for-validation-without-guide-flash', !await execute("document.getElementById('setup-wizard').open"));
    fixtureState.connection.status = 'error';
    await publish();
    check('never-verified-link-failure-keeps-guide-available', await execute("document.getElementById('setup-wizard').open"));
    fixtureState.connection.status = 'connected';
    await publish();
    check('recovered-link-closes-automatic-guide', !await execute("document.getElementById('setup-wizard').open"));
    check('no-renderer-errors', report.errors.length === 0, report.errors);
    check('report-does-not-contain-fixture-credential', !JSON.stringify(report).includes('offline-fixture-only'));
    report.passed = true;
  }

  const deadline = setTimeout(() => {report.passed = false; report.error = 'Onboarding fixture exceeded its deadline.'; void finish();}, 60000);
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
