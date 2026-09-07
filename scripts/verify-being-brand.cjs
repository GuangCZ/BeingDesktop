'use strict';

// This offline fixture inspects the bundled brand in the desktop shell only.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {pathToFileURL, fileURLToPath} = require('node:url');
const {randomUUID, createHash} = require('node:crypto');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const {spawn} = require('node:child_process');
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], {cwd: root, env, windowsHide: true, stdio: 'inherit'});
  child.on('error', error => {process.stderr.write(`${error.message}\n`); process.exitCode = 1;});
  child.on('exit', code => {process.exitCode = code ?? 1;});
} else {
  const {app, BrowserWindow} = require('electron');
  const renderer = path.join(root, 'renderer');
  const runRoot = path.join(root, '.local', `being-brand-${randomUUID()}`);
  const fixture = path.join(runRoot, 'fixture.html');
  const report = {version: require('../package.json').version, scope: 'Offline brand layout and image loading; no application services or credentials.', checks: [], screenshots: [], observations: []};
  let win;
  let forbiddenRequests = 0;
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
      const r=element.getBoundingClientRect();
      return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};
    };
    const image = selector => {
      const element=document.querySelector(selector);
      return {selector,...rect(element),loaded:element.complete&&element.naturalWidth>0,naturalWidth:element.naturalWidth,naturalHeight:element.naturalHeight,source:element.getAttribute('src'),currentSource:element.currentSrc,sourceSet:element.getAttribute('srcset'),objectFit:getComputedStyle(element).objectFit,visible:Boolean(element.getClientRects().length)};
    };
    const sidebar=document.querySelector('.sidebar');
    const toolbar=document.querySelector('.titlebar-sidebar');
    const brandRow=document.querySelector('.sidebar-brand');
    const brand=document.querySelector('.sidebar-brand-name');
    const nav=document.querySelector('.primary-nav');
    const toggle=document.querySelector('#toggle-sidebar');
    return {width:innerWidth,height:innerHeight,bodyWidth:document.documentElement.scrollWidth,bodyHeight:document.documentElement.scrollHeight,
      welcome:image('.welcome-brand-icon'),
      titlebar:rect(document.querySelector('.titlebar')),toolbar:rect(toolbar),sidebar:rect(sidebar),
      brandRow:rect(brandRow),brand:rect(brand),brandText:brand.textContent.trim(),brandTag:brand.tagName,
      brandFont:{family:getComputedStyle(brand).fontFamily,size:getComputedStyle(brand).fontSize,weight:getComputedStyle(brand).fontWeight,synthesis:getComputedStyle(brand).fontSynthesis,spacing:getComputedStyle(brand).letterSpacing,
        loaded:[...document.fonts].some(face=>face.family.includes('Silkscreen')&&face.weight==='700'&&face.status==='loaded')},
      brandPrecedesNav:brandRow.parentElement===sidebar&&brand.parentElement===brandRow&&brandRow.nextElementSibling===nav,
      toolbarOnlyToggle:toolbar.children.length===1&&toolbar.firstElementChild===toggle,
      toggleVisible:Boolean(toggle.getClientRects().length),
      nav:rect(nav),navRows:[...nav.querySelectorAll('.nav-button')].map(element=>({id:element.id||element.dataset.page,...rect(element)})),
      onboarding:rect(document.querySelector('#onboarding')),connect:rect(document.querySelector('#onboarding-connect')),
      brandHidden:!brand.getClientRects().length&&!brandRow.getClientRects().length};
  })()`;

  async function capture(name, state) {
    let image;
    let previousHash = '';
    let ready = false;
    for (let attempt = 0; attempt < 24 && !ready; attempt++) {
      const previousFrame = frameSequence;
      const painted = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {win.webContents.removeListener('paint', listener); reject(new Error('Offscreen paint timed out.'));}, 3000);
        const listener = () => {
          if (frameSequence > previousFrame) {clearTimeout(timer); win.webContents.removeListener('paint', listener); resolve(latestPaint);}
        };
        win.webContents.on('paint', listener);
      });
      win.webContents.invalidate();
      image = await painted;
      const size = image.getSize();
      if (size.width === state.width && size.height === state.height) {
        const pixels = image.toBitmap();
        const logosHaveContrast = [state.welcome].filter(icon => icon.visible).every(icon => {
          let min = 255;
          let max = 0;
          for (let y = Math.ceil(icon.y); y < Math.floor(icon.bottom); y++) {
            for (let x = Math.ceil(icon.x); x < Math.floor(icon.right); x++) {
              const offset = (y * size.width + x) * 4;
              const value = .0722 * pixels[offset] + .7152 * pixels[offset + 1] + .2126 * pixels[offset + 2];
              min = Math.min(min, value); max = Math.max(max, value);
            }
          }
          return max - min > 40;
        });
        const hash = createHash('sha256').update(pixels).digest('hex');
        ready = logosHaveContrast && hash === previousHash;
        previousHash = logosHaveContrast ? hash : '';
      }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
    }
    check(`${name}-welcome-painted`, ready);
    assert(ready, 'Welcome image did not settle into a visible offscreen frame.');
    const output = path.join(runRoot, `${name}.png`);
    await fs.writeFile(output, image.toPNG());
    report.screenshots.push(output);
  }

  async function run() {
    for (const size of [64, 80, 96, 112, 128, 160, 192, 256]) {
      await fs.access(path.join(renderer, `assets/being/being-icon-${size}.png`));
    }
    await fs.access(path.join(renderer, 'assets/being/being-icon.ico'));
    await fs.mkdir(runRoot, {recursive: true});
    const source = await fs.readFile(path.join(renderer, 'index.html'), 'utf8');
    const html = source.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
      .replace('<head>', `<head><base href="${pathToFileURL(renderer + path.sep).href}">`)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    await fs.writeFile(fixture, html);
    await app.whenReady();
    win = new BrowserWindow({show: false, frame: false, width: 1440, height: 940, useContentSize: true,
      webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: `being-brand-${randomUUID()}`}});
    win.webContents.on('paint', (_event, _dirty, image) => {frameSequence++; latestPaint = image;});
    win.webContents.setFrameRate(30);
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      if (details.url.startsWith('file:')) {
        const file = fileURLToPath(details.url);
        allowed = file === fixture || file.startsWith(renderer + path.sep);
      }
      if (!allowed) forbiddenRequests++;
      callback({cancel: !allowed});
    });
    await win.loadFile(fixture);
    await execute(`(async()=>{
      for(const page of document.querySelectorAll('.page'))page.hidden=page.id!=='page-chat';
      document.getElementById('inspector').hidden=true;
      document.getElementById('sidebar-town-status').textContent='品牌图标预览';
      document.getElementById('app-version').textContent=${JSON.stringify(report.version)};
      await Promise.all([...document.querySelectorAll('.welcome-brand-icon')].map(image=>image.decode()));
      await document.fonts.ready;
    })()`);
    for (const [name, width, height] of [['01-being-welcome-1440', 1440, 940], ['02-being-welcome-1000', 1000, 700]]) {
      win.setContentSize(width, height);
      await settle();
      const state = await execute(snapshot);
      report.observations.push({phase: name, ...state});
      const icon = state.welcome;
      check(`${name}-welcome-loaded`, icon.loaded && icon.naturalWidth > 0 && icon.naturalWidth === icon.naturalHeight && icon.source === 'assets/being/being-icon-64.png' && /being-icon-(64|80|96|112|128|160|192|256)\.png$/.test(icon.currentSource));
      check(`${name}-welcome-64px`, icon.width === 64 && icon.height === 64 && icon.objectFit === 'contain');
      check(`${name}-welcome-visible`, icon.visible && icon.x >= 0 && icon.y >= 0 && icon.right <= width && icon.bottom <= height);
      check(`${name}-toolbar-only-sidebar-toggle`, state.toolbarOnlyToggle && state.toggleVisible);
      check(`${name}-toolbar-36px`, state.titlebar.height === 36);
      check(`${name}-sidebar-268px`, state.sidebar.width === 268 && state.toolbar.width === 268);
      check(`${name}-being-heading`, state.brandText === 'Being' && state.brandTag === 'H2' && state.brandPrecedesNav);
      check(`${name}-selected-pixel-font-loaded`, state.brandFont.family.replaceAll('"', '').startsWith('Silkscreen,') && state.brandFont.loaded, state.brandFont);
      check(`${name}-selected-brand-size-and-weight`, state.brandFont.size === '32px' && state.brandFont.weight === '700' && state.brandFont.synthesis === 'none' && state.brandFont.spacing === '-1px');
      check(`${name}-heading-below-toolbar`, state.brandRow.y >= state.titlebar.bottom && state.brand.y >= state.brandRow.y);
      check(`${name}-heading-row-48px`, state.brandRow.height === 48);
      check(`${name}-heading-left-8px`, state.brand.x === 8);
      check(`${name}-brand-contained`, state.brand.x >= state.sidebar.x && state.brand.right <= state.sidebar.right && state.brand.bottom <= state.brandRow.bottom);
      check(`${name}-primary-navigation-order`, state.navRows.map(row => row.id).join(',') === 'chat,workspace,nav-browser,nav-console,nav-town');
      check(`${name}-primary-navigation-31px-rows`, state.navRows.length === 5 && state.navRows.every(row => row.height === 31));
      check(`${name}-primary-navigation-zero-gap`, state.navRows.every((row, index, rows) => index === 0 || row.y === rows[index - 1].bottom));
      check(`${name}-navigation-below-heading`, state.nav.y >= state.brandRow.bottom);
      check(`${name}-no-horizontal-overflow`, state.bodyWidth <= width && state.onboarding.right <= width && state.connect.right <= width);
      check(`${name}-no-vertical-overflow`, state.bodyHeight <= height);
      check(`${name}-connect-visible`, state.connect.y >= state.onboarding.y && state.connect.bottom <= Math.min(height, state.onboarding.bottom));
      await capture(name, state);
    }
    await execute("document.body.classList.add('sidebar-collapsed')");
    await settle();
    const collapsed = await execute(snapshot);
    check('collapsed-sidebar-hides-brand-together', collapsed.brandHidden && collapsed.toggleVisible && collapsed.welcome.visible);
    check('collapsed-sidebar-has-no-horizontal-overflow', collapsed.bodyWidth <= collapsed.width);
    check('no-external-requests', forbiddenRequests === 0, forbiddenRequests);
    report.passed = report.checks.every(item => item.passed);
  }
  run().catch(error => {report.passed = false; report.error = error.message;}).finally(async () => {
    await fs.mkdir(runRoot, {recursive: true});
    const reportPath = path.join(runRoot, 'report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({passed: report.passed, checks: report.checks.length, failed: report.checks.filter(item => !item.passed).map(item => item.name), report: reportPath, screenshots: report.screenshots, error: report.error || null}) + '\n');
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(report.passed ? 0 : 1);
  });
}
