'use strict';
const path=require('node:path');
const fs=require('node:fs/promises');
const assert=require('node:assert/strict');

if (!process.versions.electron) {
  const {spawnSync}=require('node:child_process');
  (async()=>{
    const root=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'being-restart-test-'));
    for(const phase of ['write','read']) {
      const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
      const result=spawnSync(require('electron'),[__filename,phase,root],{env,encoding:'utf8',windowsHide:true});
      assert.equal(result.status,0,result.stderr+result.stdout);
    }
    console.log('PASS: two independent app processes retain active session, session list and messages');
  })().catch(error=>{console.error(error);process.exitCode=1;});
} else {
  const {app,BrowserWindow,session}=require('electron');
  const {prepareLoomSessions}=require('../src/loom-sessions.cjs');
  const [phase,root]=process.argv.slice(2);
  app.setPath('userData',path.join(root,'profile'));
  let win;
  app.whenReady().then(async()=>{
    const persistent=session.fromPartition('persist:restart-fixture');
    persistent.protocol.handle('https',()=>new Response('<!doctype html><div id="messages"></div>',{headers:{'Content-Type':'text/html'}}));
    win=new BrowserWindow({show:false,webPreferences:{session:persistent,sandbox:true,contextIsolation:true}});
    await prepareLoomSessions(win.webContents);
    await win.loadURL('https://restart.invalid/loom/Being');
    const evaluate=code=>win.webContents.executeJavaScript(code);
    if(phase==='write') {
      await evaluate(`document.getElementById('messages').innerHTML='<div class="message user"><div class="content">Remember this project</div></div>';globalThis.__beingDesktopSessions.flush()`);
      const first=await evaluate('globalThis.__beingDesktopSessions.list().activeId');
      const second=await evaluate('globalThis.__beingDesktopSessions.change(null)');
      await fs.writeFile(path.join(root,'expected.json'),JSON.stringify({first,second}));
      await evaluate('globalThis.__beingDesktopSessions.flush()');
      persistent.flushStorageData();
    } else {
      const expected=JSON.parse(await fs.readFile(path.join(root,'expected.json')));
      const listing=await evaluate('globalThis.__beingDesktopSessions.list()');
      assert.equal(listing.activeId,expected.second);
      assert.equal(listing.items.length,2);
      const saved=await evaluate(`JSON.parse(localStorage.getItem('being-desktop-sessions-v1:/loom/Being:'+${JSON.stringify(expected.first)}))`);
      assert.equal(saved.messages[0].content,'Remember this project');
      const child=await evaluate(`JSON.parse(localStorage.getItem('being-desktop-sessions-v1:/loom/Being:'+${JSON.stringify(expected.second)}))`);
      assert.match(child.context,/Remember this project/);
    }
  }).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{if(win)win.destroy();app.quit();});
}
