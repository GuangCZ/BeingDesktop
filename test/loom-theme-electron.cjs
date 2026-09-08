'use strict';

// Exercise the real preference injection in Chromium without services or user data.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const {randomUUID} = require('node:crypto');
const {app, BrowserWindow, ipcMain} = require('electron');
const {applyLoomTheme, applyContentColors} = require('../src/loom-theme.cjs');
const {PRESETS} = require('../renderer/theme-colors.js');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(__dirname, '../.local/loom-theme-test',randomUUID()));
let win, shell;
const html = `<!doctype html><style>:root{--bg:#0d1117;--text:#e6edf3}body{background:var(--bg);color:var(--text)}</style><div id="app"><div id="messages"><div class="message being"><div class="content">Theme regression</div></div></div><div id="input-area"><div id="input-row"><textarea id="input"></textarea><button id="send-btn">Send</button></div></div></div>`;
async function check(preset) {
  const actual = await win.webContents.executeJavaScript(`(() => {const s=getComputedStyle(document.querySelector('#app'));return {background:s.backgroundColor,text:s.color};})()`);
  const rgb = hex => `rgb(${[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).join(', ')})`;
  assert.equal(actual.background, rgb(preset.colors.background), preset.id+' conversation background');
  assert.equal(actual.text, rgb(preset.colors.text), preset.id+' conversation text');
  console.log('PASS', preset.id, actual);
}
app.whenReady().then(async()=>{
  win = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
  await applyLoomTheme(win.webContents,PRESETS[0].colors);
  await check(PRESETS[0]);
  // Real preset UI and preload: the shell must also preview inside the separate Loom renderer.
  let previewPending = Promise.resolve();
  ipcMain.handle('being:previewColors',(_event,colors)=>{
    previewPending=applyContentColors(win.webContents,colors);
    return previewPending;
  });
  ipcMain.handle('being:getState',()=>previewPending.then(()=>({})));
  shell = new BrowserWindow({show:false,webPreferences:{preload:path.join(__dirname,'../src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await shell.loadURL('data:text/html,'+encodeURIComponent('<div id="appearance-settings"><form id="theme-form"><div id="theme-current-name"></div><div id="theme-presets"></div><fieldset id="theme-fields"></fieldset><button id="theme-save"></button><button id="theme-reset"></button><button id="theme-cancel"></button><div id="theme-status"></div></form></div>'));
  for (const file of ['theme-colors.js','theme-settings.js']) await shell.webContents.executeJavaScript((await fs.readFile(path.join(__dirname,'../renderer',file),'utf8'))+';void 0;');
  await shell.webContents.executeJavaScript("beingThemeSettings.init({bridge:beingDesktop});document.querySelector('[data-theme-preset=light]').click()");
  // Flush all preference IPC sent by the preset click before checking the other renderer.
  await shell.webContents.executeJavaScript('beingDesktop.getState()');
  await check(PRESETS[1]);
  await shell.webContents.executeJavaScript("document.getElementById('theme-cancel').click()");
  await shell.webContents.executeJavaScript('beingDesktop.getState()');
  await check(PRESETS[0]);
  for (const preset of [PRESETS[1],PRESETS[0],PRESETS[2],PRESETS[1]]) {
    await applyContentColors(win.webContents,preset.colors);
    await check(preset);
  }
  await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
  await applyLoomTheme(win.webContents,PRESETS[1].colors);
  await check(PRESETS[1]);
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
