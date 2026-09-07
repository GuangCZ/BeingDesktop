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
  const runRoot = path.join(root, '.local', `sidebar-sections-${randomUUID()}`);
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
  const snapshot = `(() => {
    const rect = element => {
      const r=element.getBoundingClientRect(), style=getComputedStyle(element);
      const visible=Boolean(element.getClientRects().length)&&style.visibility!=='hidden';
      const cx=r.x+r.width/2,cy=r.y+r.height/2;
      const hit=visible&&document.elementFromPoint(cx,cy);
      return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,visible,
        hit:Boolean(hit&&element.contains(hit)),fontSize:style.fontSize,fontWeight:style.fontWeight,tag:element.tagName};
    };
    const town=document.getElementById('sidebar-town-content');
    const scroll=document.getElementById('sidebar-scroll');
    const session=document.getElementById('sidebar-session-content');
    const sessionToggle=document.getElementById('sidebar-session-toggle');
    const townToggle=document.getElementById('sidebar-town-toggle');
    const items=[...document.querySelectorAll('.town-sidebar-feature')];
    const stable={project:rect(document.getElementById('sidebar-project-title')),workspace:rect(document.getElementById('workspace-shortcut')),
      workspaceHint:rect(document.getElementById('sidebar-workspace-hint')),sessionHeading:rect(sessionToggle.closest('h2')),
      townHeading:rect(townToggle.closest('h2')),settings:rect(document.querySelector('.sidebar-bottom [data-page="settings"]')),
      footer:rect(document.querySelector('.sidebar-bottom'))};
    return {width:innerWidth,height:innerHeight,bodyWidth:document.documentElement.scrollWidth,bodyHeight:document.documentElement.scrollHeight,
      stable,sessionToggle:rect(sessionToggle),townToggle:rect(townToggle),session:{hidden:session.hidden,...rect(session),expanded:sessionToggle.getAttribute('aria-expanded'),controls:sessionToggle.getAttribute('aria-controls')},
      town:{hidden:town.hidden,...rect(town),expanded:townToggle.getAttribute('aria-expanded'),controls:townToggle.getAttribute('aria-controls'),
        scrollTop:town.scrollTop,scrollHeight:town.scrollHeight,clientHeight:town.clientHeight,overflowY:getComputedStyle(town).overflowY},
      outer:{...rect(scroll),scrollTop:scroll.scrollTop,scrollHeight:scroll.scrollHeight,clientHeight:scroll.clientHeight,overflowY:getComputedStyle(scroll).overflowY},
      last:{id:items.at(-1)?.dataset.townFeature,...rect(items.at(-1))},itemCount:items.length,
      currentPage:document.body.dataset.page,selectedFeature:items.find(item=>item.getAttribute('aria-current')==='true')?.dataset.townFeature||'',
      activeVisible:rect(document.getElementById('active-session')).visible,
      emptyVisible:rect(document.getElementById('session-empty')).visible};
  })()`;

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

  async function click(selector) {
    const point = await execute(`(() => {
      const element=document.querySelector(${JSON.stringify(selector)}),r=element.getBoundingClientRect();
      const x=r.x+r.width/2,y=r.y+r.height/2;
      if(!element.contains(document.elementFromPoint(x,y)))throw new Error('Click target is obscured.');
      return {x:Math.round(x),y:Math.round(y)};
    })()`);
    win.webContents.sendInputEvent({type: 'mouseMove', ...point});
    win.webContents.sendInputEvent({type: 'mouseDown', button: 'left', clickCount: 1, ...point});
    win.webContents.sendInputEvent({type: 'mouseUp', button: 'left', clickCount: 1, ...point});
    await settle();
  }

  async function key(selector, keyCode) {
    await execute(`document.querySelector(${JSON.stringify(selector)}).focus({preventScroll:true})`);
    const event = keyCode === 'Enter'
      ? {key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'}
      : {key:' ',code:'Space',windowsVirtualKeyCode:32,nativeVirtualKeyCode:32,text:' ',unmodifiedText:' '};
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown',...event});
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp',...event,text:'',unmodifiedText:''});
    await settle();
    report.observations.push({phase:`keyboard-${selector}-${keyCode}`, state:await execute(snapshot)});
  }

  function fixedPositions(name, before, after) {
    for (const [id, expected] of Object.entries(before.stable)) {
      const actual = after.stable[id];
      check(`${name}-${id}-fixed`, ['x','y','width','height'].every(key => Math.abs(actual[key] - expected[key]) < .5), {before: expected, after: actual});
      if (id !== 'footer') check(`${name}-${id}-unobscured`, actual.visible && actual.hit && actual.y >= 0 && actual.bottom <= after.height, actual);
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
      webPreferences: {preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: `sidebar-sections-${randomUUID()}`}});
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
      const ready=()=>document.querySelectorAll('.town-sidebar-feature').length===11&&document.getElementById('sidebar-being-name').textContent==='preview_being';
      if(ready())return resolve();
      const observer=new MutationObserver(()=>{if(ready()){clearTimeout(timer);observer.disconnect();resolve();}});
      const timer=setTimeout(()=>{observer.disconnect();reject(new Error('Offline renderer did not finish mounting.'));},5000);
      observer.observe(document.body,{subtree:true,childList:true,characterData:true});
    })`);
    await execute('document.fonts.ready');
    await settle();
    const initial = await execute(snapshot);
    check('three-semantic-h2-headings', ['project','sessionHeading','townHeading'].every(id => initial.stable[id].tag === 'H2'));
    check('three-headings-14px-600', ['project','sessionHeading','townHeading'].every(id => initial.stable[id].fontSize === '14px' && initial.stable[id].fontWeight === '600'), initial.stable);
    check('toggle-text-14px-600', [initial.sessionToggle,initial.townToggle].every(value => value.fontSize === '14px' && value.fontWeight === '600'));
    check('initial-session-expanded', !initial.session.hidden && initial.session.expanded === 'true' && initial.activeVisible);
    check('toggles-name-content', initial.session.controls === 'sidebar-session-content' && initial.town.controls === 'sidebar-town-content');
    await click('#sidebar-session-toggle');
    let state = await execute(snapshot);
    check('pointer-collapses-session', state.session.hidden && state.session.expanded === 'false' && !state.activeVisible);
    win.webContents.send('sidebar-fixture:update', {...fixtureState, connection: {...fixtureState.connection, status: 'connecting'}});
    await settle();
    state = await execute(snapshot);
    check('state-refresh-preserves-session-collapse', state.session.hidden && state.session.expanded === 'false' && !state.activeVisible);
    win.webContents.send('sidebar-fixture:update', fixtureState);
    await settle();
    await capture('01-session-collapsed-1440');
    await key('#sidebar-session-toggle', 'Enter');
    state = await execute(snapshot);
    check('enter-expands-session', !state.session.hidden && state.session.expanded === 'true' && state.activeVisible);
    await key('#sidebar-session-toggle', 'Space');
    state = await execute(snapshot);
    check('space-collapses-session', state.session.hidden && state.session.expanded === 'false');
    await key('#sidebar-session-toggle', 'Space');
    state = await execute(snapshot);
    check('space-restores-session', !state.session.hidden && state.session.expanded === 'true' && state.activeVisible);
    await click('#sidebar-town-toggle');
    state = await execute(snapshot);
    check('pointer-collapses-town', state.town.hidden && state.town.expanded === 'false');
    await key('#sidebar-town-toggle', 'Enter');
    state = await execute(snapshot);
    check('enter-restores-town', !state.town.hidden && state.town.expanded === 'true');
    await key('#sidebar-town-toggle', 'Space');
    state = await execute(snapshot);
    check('space-collapses-town', state.town.hidden && state.town.expanded === 'false');
    await key('#sidebar-town-toggle', 'Space');
    state = await execute(snapshot);
    check('space-restores-town', !state.town.hidden && state.town.expanded === 'true');

    for (const [name,width,height] of [['wide',1440,940],['minimum',1000,700]]) {
      win.setContentSize(width,height);
      await execute("document.querySelector('[data-page=chat]').click();document.getElementById('sidebar-town-content').scrollTop=0;document.activeElement.blur()");
      await settle();
      const before = await execute(snapshot);
      report.observations.push({phase: `${name}-top`, ...before});
      check(`${name}-outer-does-not-scroll`, before.outer.overflowY === 'hidden' && before.outer.scrollTop === 0 && before.outer.scrollHeight <= before.outer.clientHeight + 1, before.outer);
      check(`${name}-town-is-scrollable`, before.town.overflowY === 'auto' && before.town.clientHeight > 30 && before.town.scrollHeight > before.town.clientHeight, before.town);
      check(`${name}-town-below-fixed-heading`, before.town.y >= before.stable.townHeading.bottom && before.town.bottom <= before.stable.footer.y, before.town);
      check(`${name}-no-window-overflow`, before.bodyWidth <= width && before.bodyHeight <= height);
      await capture(`02-${name}-top`);
      await execute("(()=>{const town=document.getElementById('sidebar-town-content');town.scrollTop=town.scrollHeight})()");
      await settle();
      const after = await execute(snapshot);
      report.observations.push({phase: `${name}-bottom`, ...after});
      check(`${name}-town-reaches-bottom`, after.town.scrollTop > 0 && after.town.scrollTop + after.town.clientHeight >= after.town.scrollHeight - 1, after.town);
      fixedPositions(name, before, after);
      check(`${name}-last-item-visible-and-clickable`, after.last.visible && after.last.hit && after.last.y >= after.town.y && after.last.bottom <= after.town.bottom && after.last.bottom <= after.stable.footer.y, after.last);
      await capture(`03-${name}-bottom`);
      await click('.town-sidebar-feature[data-town-feature="workspace"]');
      const selected = await execute(snapshot);
      check(`${name}-last-item-navigates`, selected.currentPage === 'town' && selected.selectedFeature === 'workspace', {page:selected.currentPage,feature:selected.selectedFeature});
      fixedPositions(`${name}-navigation`, after, selected);
    }

    await click('#sidebar-session-toggle');
    win.webContents.send('sidebar-fixture:update', {...fixtureState, connection: {configured: false, status: 'disconnected', beingName: ''}});
    await settle();
    state = await execute(snapshot);
    check('disconnect-keeps-session-collapsed', state.session.hidden && !state.emptyVisible && state.session.expanded === 'false');
    await key('#sidebar-session-toggle', 'Enter');
    state = await execute(snapshot);
    check('expand-disconnected-session-shows-empty-state', !state.session.hidden && state.emptyVisible && !state.activeVisible);
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
