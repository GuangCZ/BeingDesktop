'use strict';

// Offline Electron UI fixture. Installation and draft calls are controlled promises.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {pathToFileURL, fileURLToPath} = require('node:url');
const project = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const {spawn} = require('node:child_process');
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], {cwd: project, env, windowsHide: true, stdio: 'inherit'});
  child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const {app, BrowserWindow} = require('electron');
  const renderer = path.join(project, 'renderer');
  const output = path.join(project, '.local', `grove-install-ui-${randomUUID()}`);
  const report = {checks: [], screenshots: [], scope: 'Offline UI fixtures only; no real software installation or message sending.'};
  let win;
  let forbiddenRequests = 0;
  app.setPath('userData', path.join(output, 'profile'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.on('window-all-closed', () => {});
  const execute = script => win.webContents.executeJavaScript(script);
  const settle = () => execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const click = async selector => { await execute(`document.querySelector(${JSON.stringify(selector)}).click()`); await settle(); };
  async function check(name, script) {
    const passed = await execute(script);
    report.checks.push({name, passed: passed === true});
    assert.equal(passed, true, name);
    process.stdout.write(`${name}: passed\n`);
  }
  async function select(id) {
    if (await execute("Boolean(document.getElementById('grove-back'))")) await click('#grove-back');
    await click(`[data-kit-id="${id}"]`);
  }
  async function capture(name) {
    await settle();
    const file = path.join(output, `${name}.png`);
    await fs.writeFile(file, (await win.webContents.capturePage()).toPNG());
    report.screenshots.push(file);
  }

  async function run() {
    await fs.mkdir(output, {recursive: true});
    const html = await fs.readFile(path.join(renderer, 'index.html'), 'utf8');
    const icons = html.match(/<svg\b[^>]*class="icon-library"[^>]*>[\s\S]*?<\/svg>/)?.[0] || '';
    const entry = path.join(output, 'fixture.html');
    await fs.writeFile(entry, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="${pathToFileURL(renderer + path.sep).href}"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="town-app.css"><style>html,body{margin:0;width:100%;height:100%}#page-town-app{height:100vh;width:100vw}.town-app [hidden]{display:none!important}</style><script src="town-app.js" defer></script></head><body>${icons}<main id="page-town-app"></main></body></html>`);
    await app.whenReady();
    win = new BrowserWindow({show: false, width: 1100, height: 850, useContentSize: true, webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: `grove-install-${randomUUID()}`}});
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const file = details.url.startsWith('file:') ? fileURLToPath(details.url) : '';
      const allowed = file === entry || file.startsWith(renderer + path.sep);
      if (!allowed) forbiddenRequests++;
      callback({cancel: !allowed});
    });
    await win.loadFile(entry);
    await execute(`(async () => {
      window.fixture = {calls: [], pending: [], navigate: 0, checks: {}, kits: [
        {id:'direct',name:'可直接安装的测试工具',assessment:{installMode:'one_click'},manifest:{tools:[{name:'example.run',description:'测试工具'}]}},
        {id:'assisted',name:'需要配置的测试工具',assessment:{installMode:'being'},manifest:{}},
        {id:'fallback',name:'环境待检查的测试工具',assessment:{installMode:'one_click'},manifest:{}}
      ]};
      fixture.result = (id,status,detail) => ({id,status,detail,loaded:false,kit:fixture.kits.find(kit=>kit.id===id),assessment:{mode:status==='needs_being'?'being':'one_click',installable:status==='ready',blocked:status==='needs_being',localInstalled:status==='installed',localMcpRegistered:status==='installed',reasons:status==='needs_being'?['缺少需要授权的配置']:[],checks:[{label:'运行环境',status:status==='needs_being'?'missing':'passed',detail:'本机环境检查结果'}]}});
      fixture.hold = (method,value) => {fixture.calls.push({method,value});return new Promise((resolve,reject)=>fixture.pending.push({method,value,resolve,reject}));};
      fixture.state = {connection:{status:'connected'},portal:{status:'not_configured'},townApp:{identity:{beingId:'test',identityRevision:1,connectionRevision:1},access:{},platformSupported:true}};
      const bridge = {
        getTownAppState:async()=>fixture.state.townApp,refreshTownApp:async()=>fixture.state.townApp,
        getGroveCatalog:async()=>({kits:fixture.kits,count:fixture.kits.length}),getGroveDetail:async id=>fixture.kits.find(kit=>kit.id===id),
        prepareGroveInstallation:async value=>{fixture.calls.push({method:'prepareGroveInstallation',value});return fixture.checks[value.id]||fixture.result(value.id,'ready','环境检查通过');},
        installGroveKit:value=>fixture.hold('installGroveKit',value),
        prepareGroveAssistance:async value=>{fixture.calls.push({method:'prepareGroveAssistance',value});fixture.draft='KitID: '+value.id+'。原因：需要配置。请 Being 协助安装。';return {status:'draft_ready'};},
        installEligibleGroveKits:value=>fixture.hold('installEligibleGroveKits',value)
      };
      beingTownApp.init({bridge,onNavigateChat:()=>{fixture.navigate++;}});beingTownApp.setState(fixture.state);await beingTownApp.open('grove');
    })()`);
    await settle();
    await check('opening and refreshing the catalog do not install anything', `fixture.calls.length===0&&document.getElementById('grove-install-eligible').textContent==='安装可一键安装的 Kit'`);
    await select('direct');
    await check('a candidate uses backend metadata for one-click routing', `document.getElementById('grove-install').textContent==='一键安装'&&document.getElementById('grove-prepare').textContent==='检查安装环境'`);
    await click('#grove-prepare');
    await check('environment check only calls the preparation endpoint', `fixture.calls.length===1&&fixture.calls[0].method==='prepareGroveInstallation'&&document.getElementById('grove-checks').textContent.includes('本次仅检查环境，没有执行安装')&&document.getElementById('grove-checks').textContent.includes('运行环境 · 通过')`);
    await click('#grove-install');
    await click('#grove-install');
    await check('one click installs once and shows the combined checking and installation state', `fixture.calls.filter(call=>call.method==='installGroveKit').length===1&&document.getElementById('grove-install').disabled&&document.getElementById('grove-install').textContent==='正在检查并安装…'&&document.getElementById('grove-prepare').disabled`);
    await select('assisted');
    await check('a different Kit does not inherit the pending Kit status', `document.getElementById('grove-install').textContent==='请 Being 协助安装'&&!document.getElementById('grove-install').disabled&&!document.getElementById('grove-checks')`);
    await click('#grove-back');
    await click('#grove-refresh');
    await check('refresh preserves the in-flight batch exclusion', `document.getElementById('grove-install-eligible').disabled&&fixture.calls.filter(call=>call.method==='installGroveKit').length===1`);
    await select('direct');
    await execute(`void beingTownApp.open('channel');void beingTownApp.open('grove')`); await settle();
    await check('reopening the page does not resubmit or unlock installation', `fixture.calls.filter(call=>call.method==='installGroveKit').length===1&&document.getElementById('grove-install').disabled&&document.getElementById('grove-install').textContent==='正在检查并安装…'`);
    await execute(`fixture.pending.shift().resolve(fixture.result('direct','installed','本机文件与 MCP 已登记'))`); await settle();
    await check('installation and Portal loading are reported separately', `document.getElementById('grove-install').textContent==='加载到 Portal'&&!document.getElementById('grove-install').disabled&&document.querySelector('[data-section="local"]').textContent.includes('待 Portal 加载')&&document.querySelector('[data-section="local"]').textContent.includes('工具业务调用未验证')`);
    await capture('installed-desktop');
    await click('#grove-install');
    await click('#grove-install');
    await check('pending Portal activation retries through one idempotent installation call', `fixture.calls.filter(call=>call.method==='installGroveKit').length===2&&fixture.calls.at(-1).value.id==='direct'&&fixture.pending.length===1&&document.getElementById('grove-install').disabled`);
    await execute(`fixture.pending.shift().resolve({...fixture.result('direct','installed','Portal 已加载'),loaded:true})`); await settle();
    await check('confirmed Portal loading completes and disables the installation action', `document.getElementById('grove-install').textContent==='已安装'&&document.getElementById('grove-install').disabled&&document.querySelector('[data-section="local"]').textContent.includes('Portal 加载已加载')`);
    await select('fallback');
    await execute(`fixture.checks.fallback=fixture.result('fallback','needs_being','需要 Being 协助补充配置')`);
    await click('#grove-prepare');
    await check('live environment failure downgrades the candidate to Being assistance', `document.getElementById('grove-install').textContent==='请 Being 协助安装'&&document.getElementById('grove-checks').textContent.includes('缺少需要授权的配置')`);
    await click('#grove-install');
    await check('Being handoff prepares the selected Kit draft without sending a message', `fixture.navigate===1&&fixture.draft.includes('KitID: fallback')&&fixture.calls.at(-1).method==='prepareGroveAssistance'&&fixture.calls.at(-1).value.id==='fallback'&&fixture.calls.filter(call=>call.method==='installGroveKit').length===2`);
    await click('#grove-back');
    await click('#grove-install-eligible');
    await click('#grove-install-eligible');
    await click('#grove-refresh');
    await check('batch installation is submitted once across clicks and refresh', `fixture.calls.filter(call=>call.method==='installEligibleGroveKits').length===1&&document.getElementById('grove-install-eligible').disabled&&document.getElementById('grove-batch-result').textContent.includes('正在逐项检查本机环境')`);
    await select('assisted');
    await check('batch installation locks per-Kit mutation controls', `document.getElementById('grove-install').disabled&&document.getElementById('grove-prepare').disabled`);
    await execute(`fixture.pending.shift().resolve({results:[fixture.result('direct','installed','直接安装成功'),fixture.result('assisted','needs_being','账号配置需要 Being'),fixture.result('fallback','failed','安装进程退出，测试失败原因')]})`); await settle();
    await click('#grove-back');
    await check('batch results show counts, each reason, and pending Portal loading', `document.getElementById('grove-batch-result').textContent.includes('已安装 1 · 需要 Being 1 · 失败 1')&&document.getElementById('grove-batch-result').textContent.includes('账号配置需要 Being')&&document.getElementById('grove-batch-result').textContent.includes('安装进程退出，测试失败原因')&&document.getElementById('grove-batch-result').textContent.includes('待 Portal 加载')&&!document.getElementById('grove-install-eligible').disabled`);
    await capture('batch-desktop');
    win.setContentSize(720, 850); await settle();
    await check('the batch action and report fit the narrow viewport', `document.documentElement.scrollWidth<=innerWidth&&document.getElementById('grove-install-eligible').getBoundingClientRect().right<=innerWidth&&document.getElementById('grove-batch-result').getBoundingClientRect().right<=innerWidth`);
    await capture('batch-narrow');
    await select('fallback');
    await click('#grove-install');
    await execute(`fixture.pending.shift().reject(new Error('模拟安装错误'))`); await settle();
    await check('a rejected install leaves a retryable error on its own Kit', `document.getElementById('grove-install').textContent==='一键安装'&&!document.getElementById('grove-install').disabled&&document.querySelector('.ta-kit-detail').textContent.includes('模拟安装错误')`);
    await select('assisted');
    await check('installation errors do not bleed into another Kit', `!document.querySelector('.ta-kit-detail').textContent.includes('模拟安装错误')`);
    assert.equal(forbiddenRequests, 0, 'Fixture must not make external requests');
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    process.stdout.write(`Report: ${path.join(output, 'report.json')}\n`);
  }
  run().then(() => {win?.destroy();app.exit(0);}).catch(async error => {
    report.error = error.stack;
    await fs.mkdir(output, {recursive: true});
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    process.stderr.write(`${error.stack}\nReport: ${path.join(output, 'report.json')}\n`);
    win?.destroy();app.exit(1);
  });
}
