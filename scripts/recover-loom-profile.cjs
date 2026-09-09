'use strict';
// Read an offline copy of a legacy profile; stage an additive import for next startup.
const {app, BrowserWindow, session, safeStorage} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {randomUUID, createHash} = require('node:crypto');
const {parseConnection, sessionPartition} = require('../src/security.cjs');
const source = path.resolve(process.argv[2]);
const target = path.resolve(process.argv[3]);
const temporary = path.join(os.tmpdir(), 'being-session-recovery-' + randomUUID());
require('node:fs').mkdirSync(temporary,{recursive:true});
require('node:fs').copyFileSync(path.join(source,'Local State'),path.join(temporary,'Local State'));
app.setPath('userData', temporary);
app.on('window-all-closed',()=>{});
let win;
app.whenReady().then(async()=>{
  const settings = JSON.parse(await fs.readFile(path.join(source,'settings.json'),'utf8'));
  const connection = parseConnection(safeStorage.decryptString(Buffer.from(settings.credential,'base64')));
  const partition = sessionPartition(connection);
  const storage = path.join(source,'Partitions',partition.slice(8),'Local Storage');
  const copy = path.join(temporary,'legacy-partition');
  await fs.cp(storage,path.join(copy,'Local Storage'),{recursive:true});
  const isolated = session.fromPath(copy);
  // Resolve the original origin entirely offline, without loading Loom or sending credentials.
  isolated.protocol.handle(new URL(connection.displayUrl).protocol.slice(0,-1),()=>new Response('<!doctype html><title>Recovery</title>',{headers:{'Content-Type':'text/html'}}));
  win = new BrowserWindow({show:false,webPreferences:{session:isolated,sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await win.loadURL(connection.displayUrl);
  const entries = await win.webContents.executeJavaScript(`Object.entries(localStorage).filter(([key])=>key.startsWith('being-desktop-sessions-v1:'))`);
  if (!entries.length) { console.log(JSON.stringify({sessions:0,messages:0,staged:false})); return; }
  const payload = {origin:new URL(connection.displayUrl).origin,entries};
  payload.id = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const directory = path.join(target,'session-recovery');
  await fs.mkdir(directory,{recursive:true});
  const output = path.join(directory,partition.slice(8)+'.json');
  // Retain previous exports as backups as well as leaving the source profile untouched.
  await fs.copyFile(output,output+'.'+randomUUID()+'.bak').catch(error=>{if(error.code!=='ENOENT')throw error;});
  await fs.writeFile(output,JSON.stringify(payload),{mode:0o600});
  const key = 'being-desktop-sessions-v1:' + new URL(connection.displayUrl).pathname;
  const index = JSON.parse(new Map(entries).get(key) || 'null');
  const count = (index?.items || []).reduce((total,item)=>total+(JSON.parse(new Map(entries).get(key+':'+item.id)||'null')?.messages?.length || 0),0);
  console.log(JSON.stringify({recoveryFile:output,sessions:index?.items?.length || 0,messages:count}));
}).catch(error=>{console.error('Profile recovery failed:',error.code || error.name);process.exitCode=1;}).finally(()=>{
  if(win)win.destroy();
  app.quit();
});
