'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createEventHistory} = require('../src/loom-event-history.cjs');

if (!process.versions.electron) {
  const environment = {...process.env}; delete environment.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
    env:environment, windowsHide:true, encoding:'utf8', timeout:30000,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.equal(result.status, 0);
} else {
  const {app, BrowserWindow, session} = require('electron');
  app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'loom-event-history-test-')));
  let win;
  app.whenReady().then(async () => {
    const isolated = session.fromPartition('event-history-fixture');
    isolated.protocol.handle('https', () => new Response('<div id="messages"></div>', {headers:{'Content-Type':'text/html'}}));
    win = new BrowserWindow({show:false, webPreferences:{session:isolated}});
    await win.loadURL('https://fixture.invalid');
    const run = code => win.webContents.executeJavaScript(code);
    for (const hasReply of [false, true]) {
      await run(`localStorage.clear(); localStorage.setItem('fixture:events:own:failed', JSON.stringify({
        id:'failed',requestId:'old-request',at:'2026-09-08T09:28:00.000Z',startSeq:1,finished:true,
        entries:[{seq:1,event:'error',data:{message:'Old 502'}}]
      })); true`);
      await win.reload();
      await run(`globalThis.saved = [
        {role:'user',request_id:'old-request',at:'2026-09-08T09:27:59.000Z'},
        ${hasReply ? "{role:'being',delivery_id:'failed',at:'2026-09-08T09:28:00.000Z'}," : ''}
        {role:'user',request_id:'new-request',at:'2026-09-08T09:34:40.000Z'},
        {role:'being',at:'2026-09-08T09:34:45.000Z'}
      ];
      document.getElementById('messages').innerHTML = '<div class="message system">Old notice</div><div class="message user" id="old">Old request</div><div class="message system">Error notice</div>${hasReply ? '<div class="message being" id="reply">Old reply</div>' : ''}<div class="message user" id="new">New request</div><div class="message being">New reply</div>';
      (${createEventHistory.toString()})({key:'fixture',ownId:'own',messages:()=>saved});
      document.dispatchEvent(new Event('DOMContentLoaded'));
      new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const order = await run(`[...document.getElementById('messages').children].map(node=>node.id || (node.classList.contains('desktop-process') ? 'process' : 'notice'))`);
      assert.ok(order.indexOf('process') > order.indexOf('old'), 'Old error must stay after its request despite system notices');
      assert.ok(order.indexOf('process') < order.indexOf('new'), 'Old error must never appear in the next turn');
      if (hasReply) assert.equal(order[order.indexOf('process') + 1], 'reply');
    }
    console.log('PASS: persisted error panels stay in their original turn with system notices, with or without a routed reply.');
  }).catch(error => {console.error(error); process.exitCode = 1;}).finally(() => {win?.destroy(); app.exit(process.exitCode || 0);});
}
