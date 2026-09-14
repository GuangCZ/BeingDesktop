'use strict';
// Production shell, native macOS window and isolated profile. No account,
// downloads, user preferences or external service mutations are needed.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {app, dialog} = require('electron');
const {PRESETS} = require('../renderer/theme-colors.js');
if (process.platform !== 'darwin' || app.isPackaged || process.env.BEING_LOOM_URL) throw new Error('Run with development Electron on macOS without BEING_LOOM_URL.');
const root = path.resolve(__dirname, '../.local/glass-validation-' + Date.now());
fs.mkdirSync(root, {recursive: true});
process.env.BEING_DATA_DIR = fs.mkdtempSync(path.join(root, 'profile-'));
const report = {passed: false, checks: [], screenshots: []};
const server = require('node:http').createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end('<!doctype html><html><title>Local layout check</title><body style="font:16px -apple-system;padding:32px;color:#242424;background:#f8f8f7"><h1>浏览器</h1><p>本地页面 · 原生视图位置检查</p></body></html>');
});
const deadline = setTimeout(() => {console.error('Glass validation timed out'); app.exit(1);}, 60000);
dialog.showErrorBox = (title, message) => {console.error(title, message); app.exit(1);};

require('../src/main.cjs').startDesktop({portalUpdateChecksEnabled: false, onReady: async ({win, stopRefresh, shutdown}) => {
  const execute = script => win.webContents.executeJavaScript(script);
  const check = (name, value) => {assert.ok(value, name); report.checks.push(name);};
  const settle = () => execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const capture = async name => {
    await settle();
    await new Promise(resolve => setTimeout(resolve, 180));
    const file = path.join(root, `${name}.png`);
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
    report.screenshots.push(file);
  };
  const layout = () => execute(`(() => {
    const rect = selector => {const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const visible = selector => document.querySelector(selector).checkVisibility();
    return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,
      sidebar:rect('.sidebar'),toolbar:rect('.workspace-toolbar'),navigation:rect('.titlebar-navigation'),
      content:rect('.page-column'),settings:rect('.settings-content'),
      nativeOnly:!visible('.window-controls')&&!visible('.app-menubar'),
      glass:getComputedStyle(document.querySelector('.header-actions')).backdropFilter,
      background:getComputedStyle(document.body).backgroundColor};
  })()`);
  try {
    stopRefresh();
    win.webContents.setBackgroundThrottling(false);
    await execute('document.fonts.ready');
    await settle();
    check('production preload identifies macOS', await execute("document.documentElement.dataset.platform==='darwin'"));
    report.nativeBackground = win.getBackgroundColor();
    report.nativePreferences = require('../src/desktop-appearance.cjs').systemAppearance(require('electron').nativeTheme);
    check('native traffic lights occupy reserved titlebar space', win.getWindowButtonPosition()?.x === 20);
    await execute("document.querySelector('#setup-close').click()");
    for (const preset of PRESETS.filter(item => ['default', 'light'].includes(item.id))) {
      await execute(`window.beingDesktop.setColors(${JSON.stringify(preset.colors)})`);
      await settle();
      for (const [width, height] of [[1440, 940], [1000, 700]]) {
        win.setContentSize(width, height);
        await settle();
        let value = await layout();
        check(`${preset.id} ${width}: native window controls replace HTML controls`, value.nativeOnly);
        check(`${preset.id} ${width}: navigation clears traffic lights`, value.navigation.x >= 88);
        check(`${preset.id} ${width}: toolbar clears navigation and content`, value.toolbar.x >= value.navigation.right && value.toolbar.bottom <= value.content.y);
        check(`${preset.id} ${width}: layout stays inside window`, !value.overflow && value.content.right <= width && value.content.bottom <= height);
        check(`${preset.id} ${width}: the header has no extra opaque pill`, await execute("getComputedStyle(document.querySelector('.header-actions')).backgroundColor==='rgba(0, 0, 0, 0)' && getComputedStyle(document.querySelector('.header-actions')).boxShadow==='none'"));
        check(`${preset.id} ${width}: the frame uses a translucent tint`, await execute("getComputedStyle(document.body).backgroundColor==='rgba(0, 0, 0, 0)' && parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--glass-opacity'))<100"));
        await capture(`${preset.id}-home-${width}`);
        await execute("document.querySelector('#toggle-inspector').click()");
        await settle();
        check(`${preset.id} ${width}: inspector fits`, await execute("document.querySelector('#inspector').getBoundingClientRect().right<=innerWidth"));
        await execute("document.querySelector('#toggle-inspector').click();document.querySelector('#toggle-sidebar').click()");
        await settle();
        value = await layout();
        check(`${preset.id} ${width}: collapsed sidebar keeps toolbar clear`, value.toolbar.x >= value.navigation.right);
        await execute("document.querySelector('#toggle-sidebar').click();changePage('settings');document.querySelector('[data-settings-section=appearance]').click()");
        await settle();
        value = await layout();
        check(`${preset.id} ${width}: settings fits without horizontal scrolling`, value.settings.right <= width && !value.overflow && await execute("document.querySelector('#settings-content').scrollWidth<=document.querySelector('#settings-content').clientWidth"));
        await capture(`${preset.id}-settings-${width}`);
        await execute("document.querySelector('.settings-back').click()");
      }
    }
    await execute(`renderWindowState({platform:'darwin',focused:true,reducedTransparency:true});`);
    check('reduced transparency uses opaque navigation and removes blur', await execute(`getComputedStyle(document.querySelector('.header-actions')).backdropFilter==='none' && getComputedStyle(document.documentElement).getPropertyValue('--glass-opacity').trim()==='100%'`));
    check('reduced transparency also removes popup and card blur', await execute(`(()=>{const popup=document.createElement('div');popup.className='chat-detail-card';document.body.append(popup);const value=getComputedStyle(popup);const ok=value.backdropFilter==='none'&&value.backgroundColor===getComputedStyle(document.documentElement).getPropertyValue('--background').trim().replace(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i,(_,r,g,b)=>'rgb('+[r,g,b].map(v=>parseInt(v,16)).join(', ')+')');popup.remove();return ok})()`));
    await capture('reduced-transparency');
    await execute(`renderWindowState({platform:'darwin',focused:true,highContrast:true});`);
    await execute("changePage('settings')");
    check('increased contrast gives selected navigation a visible outline', await execute("getComputedStyle(document.querySelector('.settings-nav-item[aria-current]')).outlineStyle==='solid'"));
    await execute("document.querySelector('.settings-back').click()");
    await execute(`(async()=>renderWindowState(await window.beingDesktop.getWindowState()))()`);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
    check('reduced motion removes navigation transitions', await execute("getComputedStyle(document.querySelector('.nav-button')).transitionDuration==='0s'"));
    win.webContents.debugger.detach();
    win.setContentSize(1440, 940);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await execute(`window.beingDesktop.desktopAction('browser.new',{url:'http://127.0.0.1:${server.address().port}'})`);
    await execute("window.beingTools.show('browser')");
    await new Promise(resolve => setTimeout(resolve, 400));
    const child = win.contentView.children.find(view => view.webContents && view.webContents !== win.webContents && view.getVisible());
    check('real browser WebContentsView is mounted after glass layout', Boolean(child));
    const bounds = child.getBounds();
    const slot = await execute("(()=>{const r=document.querySelector('.browser-surface').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};})()");
    check('native browser view matches DOM slot', ['x','y','width','height'].every(key => Math.abs(slot[key]-bounds[key])<=1));
    await capture('browser');
    await execute("window.beingTools.hide();document.querySelector('#setup-wizard').showModal()");
    await capture('onboarding');
    check('renderer retains Node isolation', await execute("typeof require==='undefined' && typeof process==='undefined'"));
    report.passed = true;
  } catch (error) {report.error = error.stack;}
  finally {
    clearTimeout(deadline);
    server.close();
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await shutdown();
    if (!report.passed) app.exit(1);
  }
}});
