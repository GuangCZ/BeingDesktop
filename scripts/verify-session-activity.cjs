'use strict';

// Render the actual desktop shell against a local, fixed preload. No service,
// saved user profile, credentials, or network connection participates in this run.
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
  const runRoot = path.join(root, '.local', `session-activity-${randomUUID()}`);
  const fixture = path.join(runRoot, 'fixture.html');
  const preload = path.join(runRoot, 'preload.cjs');
  const report = {
    version: require('../package.json').version,
    scope: 'Actual renderer HTML, CSS and app.js; isolated local fake state and catalog; no real services or credentials.',
    checks: [], screenshots: [], observations: [], errors: [],
  };
  const fixtureState = {
    version: report.version,
    connection: {configured: true, beingName: 'preview_being', displayUrl: 'https://fixture.invalid/loom/', status: 'connected'},
    machine: {hostname: 'Preview PC', user: 'Preview'},
    workspace: {path: 'E:\\Example\\Sidebar preview project', files: []},
  };
  let win;
  let blockedRequests = 0;
  let latestPaint;
  let frameSequence = 0;
  app.setPath('userData', path.join(runRoot, 'profile'));
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  const check = (name, passed, detail) => report.checks.push({name, passed: Boolean(passed), ...(detail === undefined ? {} : {detail})});
  const execute = script => {
    assert.equal(win.webContents.getURL(), pathToFileURL(fixture).href);
    return win.webContents.executeJavaScript(script);
  };
  const settle = () => execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  async function capture(name) {
    const size = await execute('({width:innerWidth,height:innerHeight})');
    let previousHash = '';
    let outputImage;
    for (let attempt = 0; attempt < 30; attempt++) {
      const previousFrame = frameSequence;
      const painted = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {win.webContents.removeListener('paint', listener); reject(new Error('Offscreen paint timed out.'));}, 3000);
        const listener = () => {
          if (frameSequence > previousFrame) {clearTimeout(timer); win.webContents.removeListener('paint', listener); resolve(latestPaint);}
        };
        win.webContents.on('paint', listener);
      });
      win.webContents.invalidate();
      const image = await painted;
      const actual = image.getSize();
      if (actual.width !== size.width || actual.height !== size.height) {
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }
      const hash = createHash('sha256').update(image.crop({x:0,y:36,width:268,height:size.height-36}).toBitmap()).digest('hex');
      if (hash === previousHash) {outputImage = image; break;}
      previousHash = hash;
      await settle();
    }
    assert(outputImage, `Offscreen sidebar did not settle at ${size.width}x${size.height}; last paint was ${JSON.stringify(latestPaint?.getSize())}.`);
    const output = path.join(runRoot, `${name}.png`);
    await fs.writeFile(output, outputImage.toPNG());
    report.screenshots.push(output);
    if (name === '03-minimum-bottom') {
      const sidebarOutput = path.join(runRoot, 'sidebar-1000x700.png');
      const sidebar = await win.webContents.capturePage({x:0,y:36,width:268,height:664});
      await fs.writeFile(sidebarOutput, sidebar.toPNG());
      report.screenshots.push(sidebarOutput);
    }
  }

  async function run() {
    await fs.mkdir(runRoot, {recursive: true});
    const source = await fs.readFile(path.join(renderer, 'index.html'), 'utf8');
    const html = source.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
      .replace('<head>', `<head><base href="${pathToFileURL(renderer + path.sep).href}">`)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
      .replace('</head>', '<script src="app.js" defer></script></head>');
    await fs.writeFile(fixture, html);
    await fs.writeFile(preload, `'use strict';
      const {contextBridge,ipcRenderer}=require('electron');
      contextBridge.exposeInMainWorld('beingDesktop',{
        getState:()=>ipcRenderer.invoke('sidebar-fixture:state'),
        refresh:()=>ipcRenderer.invoke('sidebar-fixture:state'),
        getTownCatalog:()=>ipcRenderer.invoke('sidebar-fixture:catalog'),
        setView:async()=>({}),
        onState:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('sidebar-fixture:update',listener);return()=>ipcRenderer.removeListener('sidebar-fixture:update',listener);}
      });`);
    await app.whenReady();
    ipcMain.handle('sidebar-fixture:state', () => fixtureState);
    ipcMain.handle('sidebar-fixture:catalog', () => require('../src/town.cjs').getTownCatalog());
    win = new BrowserWindow({show: false, frame: false, width: 1440, height: 940, useContentSize: true,
      webPreferences: {preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: `session-activity-${randomUUID()}`}});
    win.webContents.on('paint', (_event, _dirty, image) => {frameSequence++; latestPaint = image;});
    win.webContents.on('console-message', event => {if (event.level === 'error') report.errors.push(event.message);});
    win.webContents.setFrameRate(30);
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      if (details.url.startsWith('file:')) {
        const file = fileURLToPath(details.url);
        allowed = file === fixture || file.startsWith(renderer + path.sep);
      }
      if (!allowed) blockedRequests++;
      callback({cancel: !allowed});
    });
    await win.loadFile(fixture);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:true});
    win.webContents.focus();
    await execute(`new Promise((resolve,reject)=>{
      const ready=()=>document.querySelectorAll('.town-sidebar-feature').length===${require('../src/town.cjs').getTownCatalog().features.length}&&document.getElementById('sidebar-being-name').textContent==='preview_being';
      if(ready())return resolve();
      const observer=new MutationObserver(()=>{if(ready()){clearTimeout(timer);observer.disconnect();resolve();}});
      const timer=setTimeout(()=>{observer.disconnect();reject(new Error('Offline renderer did not finish mounting.'));},5000);
      observer.observe(document.body,{subtree:true,childList:true,characterData:true});
    })`);
    await execute('document.fonts.ready');
    await settle();
    win.webContents.send('sidebar-fixture:update', {...fixtureState,
      chatSessions:{activeId:'one',items:[{id:'one',title:'会话 1'},{id:'two',title:'会话 2'},{id:'three',title:'会话 3'}]},
      chatSessionActivity:{one:'talking',two:'waiting',three:'inactive'}});
    await settle();
    const lights = await execute(`Array.from(document.querySelectorAll('#chat-session-list .session-shortcut')).map(button=>{
      const dot=button.querySelector('.session-activity-light'),style=getComputedStyle(dot);
      return {label:button.getAttribute('aria-label'),color:style.backgroundColor,width:dot.getBoundingClientRect().width};
    })`);
    check('session-lights-three-states', lights.length===3 && lights[0].label.includes('正在和 Being 通话') && lights[1].label.includes('消息等待') && lights[2].label.includes('未激活'), lights);
    check('session-lights-visible-colors', lights.length===3 && lights.every(light=>light.width===8) && lights[0].color==='rgb(74, 222, 128)' && lights[1].color==='rgb(250, 204, 21)' && lights[2].color==='rgba(0, 0, 0, 0)', lights);
    const breathing = await execute(`Array.from(document.querySelectorAll('.session-activity-light')).map(dot=>{
      const animation=dot.getAnimations()[0];
      if(!animation)return null;
      animation.pause();
      const start=animation.effect.getTiming().delay+2400;
      animation.currentTime=start;
      const dim=Number(getComputedStyle(dot).opacity);
      animation.currentTime=start+1200;
      const bright=Number(getComputedStyle(dot).opacity);
      return {name:animation.animationName,dim,bright};
    })`);
    check('active-lights-breathe-inactive-stays-still', breathing.length===3 && breathing.slice(0,2).every(value=>value?.name==='session-light-breathe' && Math.abs(value.dim-value.bright)>.1) && breathing[2]===null, breathing);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    check('reduced-motion-keeps-lights-static', await execute(`Array.from(document.querySelectorAll('.session-activity-light')).every(dot=>dot.getAnimations().length===0)`));
    await capture('04-session-activity-lights');
    check('no-renderer-errors', report.errors.length === 0, report.errors);
    check('no-external-requests', blockedRequests === 0, blockedRequests);
    report.passed = report.checks.every(item => item.passed);
  }

  run().catch(error => {report.passed = false; report.error = error.stack || error.message;}).finally(async () => {
    await fs.mkdir(runRoot, {recursive: true});
    const reportPath = path.join(runRoot, 'report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({passed:report.passed,checks:report.checks.length,failed:report.checks.filter(item=>!item.passed).map(item=>item.name),report:reportPath,screenshots:report.screenshots,error:report.error||null})+'\n');
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(report.passed ? 0 : 1);
  });
}
