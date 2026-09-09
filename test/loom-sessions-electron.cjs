'use strict';
const {app,BrowserWindow}=require('electron');
const http=require('node:http');
const assert=require('node:assert/strict');
const {prepareLoomSessions,changeLoomSession}=require('../src/loom-sessions.cjs');
const pending=new Map(),windows=[];
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/api/chat/stream'){
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);const id=/会话id：([0-9a-f-]{36})/.exec(body.message)[1];assert.match(body.message,/每条对用户的回复/);
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();
  const finish=text=>res.end('event: content_block_delta\ndata: '+JSON.stringify({delta:{text}})+'\n\nevent: message_stop\ndata: '+JSON.stringify({session_id:'unrelated-runtime-id'})+'\n\n');
  finish.write=text=>res.write('event: content_block_delta\ndata: '+JSON.stringify({delta:{text}})+'\n\n');
  pending.set(id,finish);return;
 }
 if(url.pathname==='/api/history'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({messages:[{session_id:'foreign',role:'being',content:'Must never appear'}]}));return;}
 res.setHeader('Content-Type','text/html');
 res.end(`<!doctype html><html><body><div id="messages"></div><script>
 let sessionId=null,isStreaming=false;window.ready=false;
 function append(role,text){const node=document.createElement('div');node.className='message '+role;const content=document.createElement('div');content.className='content';content.textContent=text;node.append(content);document.getElementById('messages').append(node);}
 fetch('/api/history').then(r=>r.json()).then(data=>{for(const m of data.messages)append(m.role,m.content);window.ready=true;});
 window.startReply=()=>{isStreaming=true;append('user','Current project');window.reply=fetch('/api/chat/stream',{method:'POST',body:JSON.stringify({message:'Continue'})}).then(r=>r.text()).then(text=>{for(const line of text.split('\\n'))if(line.startsWith('data:')){const d=JSON.parse(line.slice(5));if(d.delta?.text)append('being',d.delta.text);}isStreaming=false;});};
 </script></body></html>`);
});
const evaluate=(win,code)=>win.webContents.executeJavaScript(code);
const contents=win=>evaluate(win,'document.getElementById("messages").textContent');
async function until(fn){for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Fixture did not settle');}
const partition='session-background-'+Date.now();
async function open(id=null){const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false,partition}});windows.push(win);await prepareLoomSessions(win.webContents,id);await win.loadURL(`http://127.0.0.1:${server.address().port}/loom`);await until(()=>evaluate(win,'window.ready'));return win;}
const deadline=setTimeout(()=>app.exit(1),20000);
app.whenReady().then(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const first=await open(),id=await evaluate(first,'globalThis.__beingDesktopSessions.list().activeId');
 assert.equal(await contents(first),'');
 await evaluate(first,'startReply();true');await until(()=>pending.has(id));
 const change=await changeLoomSession(first.webContents,null);assert.equal(change.ok,true);
 const second=await open(change.sessionId);assert.equal(await contents(second),'');
 await evaluate(second,'startReply();true');await until(()=>pending.has(change.sessionId));
 assert.equal((await changeLoomSession(second.webContents,id)).ok,true);
 assert.equal(await evaluate(first,'isStreaming'),true);
 assert.equal(await evaluate(second,'isStreaming'),true);
 pending.get(change.sessionId).write(`会话id：${id}\nFirst arrives`);
 await until(async()=>/First arrives/.test(await contents(first)));
 assert.doesNotMatch(await contents(second),/First arrives/);
 assert.equal(await evaluate(second,'isStreaming'),true,'The routed text must be visible before transport completion');
 pending.get(change.sessionId)(' on the second connection');await evaluate(second,'window.reply');
 pending.get(id)(`会话id：${change.sessionId}\nSecond arrives on the first connection`);await evaluate(first,'window.reply');
 await until(async()=>/First arrives/.test(await contents(first)) && /Second arrives/.test(await contents(second)));
 assert.match(await contents(first),/First arrives on the second connection/);assert.doesNotMatch(await contents(first),/Second arrives/);
 assert.match(await contents(second),/Second arrives on the first connection/);assert.doesNotMatch(await contents(second),/First arrives/);
 for(const win of [first,second])assert.equal(await evaluate(win,'document.querySelectorAll(".message.being").length'),1);
 // Flush both page-owned snapshots while changing selection in opposite directions.
 await changeLoomSession(first.webContents,change.sessionId);
 await changeLoomSession(second.webContents,id);
 const restoredFirst=await open(id),restoredSecond=await open(change.sessionId);
 assert.match(await contents(restoredFirst),/First arrives on the second connection/);
 assert.match(await contents(restoredSecond),/Second arrives on the first connection/);
 assert.equal((await evaluate(first,'globalThis.__beingDesktopSessions.list().items.length')),2);
 assert.equal(await evaluate(restoredFirst,'globalThis.__beingDesktopSessions.list().activeId'),id);
 console.log('PASS: simultaneous streams, switching while busy, interleaved completion, separate persistence and restoration');
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{clearTimeout(deadline);for(const win of windows)win.destroy();server.close();app.quit();});
