'use strict';
const {app,BrowserWindow}=require('electron');
const http=require('node:http');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
const {prepareLoomSessions}=require('../src/loom-sessions.cjs');
const {desktopMessageContext}=require('../src/desktop-message-context.cjs');
app.setPath('userData',path.join(app.getPath('temp'),'being-environment-'+randomUUID()));
let win,revision=1,fail=false,calls=0;
const requests=[];
const server=http.createServer(async(req,res)=>{
  if(req.url==='/api/chat/stream') {
    let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('event: message_stop\ndata: {}\n\n');return;
  }
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><div id="messages"></div>');
});
const run=code=>win.webContents.executeJavaScript(code);
const deadline=setTimeout(()=>app.exit(1),20000);
app.whenReady().then(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  await prepareLoomSessions(win.webContents,null,null,{enabled:false},async sessionId=>{
    calls++;if(fail)throw new Error('Host not ready');
    return desktopMessageContext({runtime:{chatSessionId:sessionId,workspace:'workspace-'+revision,bridge:{status:revision===1?'disconnected':'connected'}}});
  });
  await win.loadURL(origin+'/loom');
  const send=body=>run(`fetch('/api/chat/stream',{method:'POST',body:JSON.stringify(${JSON.stringify(body)})}).then(r=>r.text())`);
  await send({message:'First prompt'});
  assert.match(requests[0].message,/workspace-1/);assert.match(requests[0].message,/disconnected/);
  revision=2;
  const content=[{type:'text',text:'Second prompt'},{type:'image',media_type:'image/png',data:'dGVzdA=='}];
  await send({content});
  assert.match(requests[1].content[0].text,/workspace-2/);assert.match(requests[1].content[0].text,/connected/);
  assert.deepEqual(requests[1].content.slice(1),content);
  fail=true;await assert.rejects(send({message:'Must not send'}),/桌面环境/);
  assert.equal(requests.length,2);
  const before=calls;
  // A child frame cannot obtain a host scope through the exposed CDP binding.
  await run(`new Promise(resolve=>{const f=document.createElement('iframe');f.onload=()=>{f.contentWindow.__beingDesktopRequestEnvironment(JSON.stringify({id:crypto.randomUUID(),sessionId:__beingDesktopSessions.list().activeId}));setTimeout(resolve,50);};document.body.append(f);})`);
  assert.equal(calls,before);
  console.log('PASS: per-send host environment updates, multimodal preservation, unavailable host blocks POST, and child frames cannot obtain host scopes.');
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{clearTimeout(deadline);win?.destroy();server.close();app.exit(process.exitCode || 0);});
