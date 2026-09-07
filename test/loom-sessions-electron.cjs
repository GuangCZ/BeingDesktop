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
  const body=JSON.parse(raw);assert.equal(body.session_id,url.searchParams.get('session_id'));
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();
  pending.set(body.session_id,text=>res.end('event: content_block_delta\ndata: '+JSON.stringify({delta:{text}})+'\n\nevent: message_stop\ndata: '+JSON.stringify({session_id:body.session_id})+'\n\n'));return;
 }
 if(url.pathname==='/api/history'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({messages:[{session_id:'foreign',role:'being',content:'Must never appear'}]}));return;}
 res.setHeader('Content-Type','text/html');
 res.end(`<!doctype html><html><body><div id="messages"></div><script>
 let sessionId=null,isStreaming=false;window.ready=false;
 function append(role,text){const node=document.createElement('div');node.className='message '+role;const content=document.createElement('div');content.className='content';content.textContent=text;node.append(content);document.getElementById('messages').append(node);}
 fetch('/api/history').then(r=>r.json()).then(data=>{for(const m of data.messages)append(m.role,m.content);window.ready=true;});
 window.startReply=()=>{isStreaming=true;append('user','Current project');window.reply=fetch('/api/chat/stream',{method:'POST',body:JSON.stringify({message:'Continue'})}).then(r=>r.text()).then(text=>{for(const line of text.split('\\n'))if(line.startsWith('data:')){const d=JSON.parse(line.slice(5));if(d.delta)append('being',d.delta.text);}isStreaming=false;});};
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
 const first=await open(),id=await evaluate(first,'sessionId');
 assert.equal(await contents(first),'');
 await evaluate(first,'startReply();true');await until(()=>pending.has(id));
 const change=await changeLoomSession(first.webContents,null);assert.equal(change.ok,true);
 const second=await open(change.sessionId);assert.equal(await contents(second),'');
 await evaluate(second,'startReply();true');await until(()=>pending.has(change.sessionId));
 assert.equal((await changeLoomSession(second.webContents,id)).ok,true);
 assert.equal(await evaluate(first,'isStreaming'),true);
 assert.equal(await evaluate(second,'isStreaming'),true);
 pending.get(change.sessionId)('Second finishes first');await evaluate(second,'window.reply');
 pending.get(id)('First finishes in background');await evaluate(first,'window.reply');
 assert.match(await contents(first),/First finishes in background/);assert.doesNotMatch(await contents(first),/Second finishes/);
 assert.match(await contents(second),/Second finishes first/);assert.doesNotMatch(await contents(second),/First finishes/);
 // Flush both page-owned snapshots while changing selection in opposite directions.
 await changeLoomSession(first.webContents,change.sessionId);
 await changeLoomSession(second.webContents,id);
 const restoredFirst=await open(id),restoredSecond=await open(change.sessionId);
 assert.match(await contents(restoredFirst),/First finishes in background/);
 assert.match(await contents(restoredSecond),/Second finishes first/);
 assert.equal((await evaluate(first,'globalThis.__beingDesktopSessions.list().items.length')),2);
 assert.equal(await evaluate(restoredFirst,'sessionId'),id);
 console.log('PASS: simultaneous streams, switching while busy, interleaved completion, separate persistence and restoration');
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{clearTimeout(deadline);for(const win of windows)win.destroy();server.close();app.quit();});
