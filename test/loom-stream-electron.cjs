'use strict';
// Exercise the deployed Loom consumer offline with production desktop routing.
// The HTML capture stays outside the package and all external requests are blocked.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {prepareLoomSessions}=require('../src/loom-sessions.cjs');
const {applyLoomActivity}=require('../src/loom-activity.cjs');
const theme=fs.readFileSync(path.join(__dirname,'../src/loom-theme.css'),'utf8');
const page=fs.readFileSync(process.argv[2] || path.join(__dirname,'../.local/loom-stream-source.html'),'utf8');
app.setPath('userData',path.join(app.getPath('temp'),'being-stream-fixture-'+randomUUID()));
let win,active,response,posts=0,acceptOnly=false,failActive=false;
const history=[];
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.endsWith('/api/chat/stream')) {
    posts++;let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);
    const header=body.message.match(/^会话id：[^\n]+\n请求id：[^\n]+\n/m)[0];
    active={stream_id:randomUUID(),next_seq:1,finished:false,events:[],header};response=res;
    if (acceptOnly) {res.writeHead(202,{'Content-Type':'application/json'});res.end(JSON.stringify({spliced:true}));return;}
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();
    res.write(`event: meta\ndata: ${JSON.stringify({stream_id:active.stream_id})}\n\n`);return;
  }
  if(url.pathname.endsWith('/api/stream/active')) {
    if(failActive){res.writeHead(503);res.end('fixture unavailable');return;}
    if(!active){res.writeHead(204);res.end();return;}
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({...active,events:active.events.filter(e=>e.seq>Number(url.searchParams.get('after') || 0))}));return;
  }
  if(url.pathname.endsWith('/api/history')) {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({messages:history}));return;}
  if(url.pathname.endsWith('/health')) {res.end('OK fixture');return;}
  if(url.pathname.includes('/api/')) {res.setHeader('Content-Type','application/json');res.end('{}');return;}
  res.setHeader('Content-Type','text/html');res.end(page);
});
const run=code=>win.webContents.executeJavaScript(code);
async function until(code) {
  for(let i=0;i<400;i++) {if(await run(code))return;await new Promise(resolve=>setTimeout(resolve,25));}
  throw new Error('Fixture did not reach: '+code);
}
function event(type,data,{live=true}={}) {
  active.events.push({seq:active.next_seq++,event:type,data});
  if(live)response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}
const deadline=setTimeout(()=>{console.error('Native stream fixture timed out');app.exit(1);},40000);
app.whenReady().then(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  win.webContents.on('console-message',details=>{if(details.level==='error')console.error('Loom fixture:',details.message);});
  win.webContents.session.webRequest.onBeforeRequest((request,callback)=>callback({cancel:!request.url.startsWith(origin+'/')&&!request.url.startsWith('data:')}));
  await prepareLoomSessions(win.webContents);
  // Rendering is deterministic and offline; the native stream/watchdog stays intact.
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:'globalThis.marked={Renderer:class{},setOptions(){},parse(text){const el=document.createElement("span");el.textContent=text;return el.innerHTML;}};'});
  await win.loadURL(origin+'/fixture');
  await win.webContents.insertCSS(theme);
  await until('typeof consumeChatStream==="function" && connState==="online"');
  await applyLoomActivity(win.webContents);
  await run('void send("Native consumer diagnostic");true');
  await until('Boolean(currentStreamId)');
  const reasoning='Fixture reasoning '.repeat(30)+'REASONING_TAIL';
  const input={path:'fixture',details:'Full argument '.repeat(30)+'ARGUMENT_TAIL',literal:'<img src=x onerror="globalThis.injected=true">'};
  const result={name:'fixture_read',is_error:false,summary:'Short summary',output:'Full result '.repeat(30)+'RESULT_TAIL'};
  event('reasoning',{text:reasoning});
  await until('livePhase==="reasoning" && liveSeq===1');
  event('tool_use',{name:'fixture_read',input});
  await until('livePhase==="tool" && liveSeq===2');
  assert.equal(await run('stallBudgetMs()'),300000);
  assert.equal(await run('probeStream(currentStreamId,liveSeq).then(p=>p.verdict)'),'stalled');
  event('tool_result',result);
  event('content_block_delta',{delta:{text:active.header+'FIRST_VISIBLE_PREFIX'}});
  await until('document.getElementById("messages").textContent.includes("FIRST_VISIBLE_PREFIX") && liveSeq===4');
  assert.equal(await run('isStreaming'),true);
  await until('document.querySelector(".desktop-process")?.textContent.includes("RESULT_TAIL")');
  assert.equal(await run('document.querySelector(".desktop-process [data-event=reasoning] pre").textContent'),reasoning);
  assert.deepEqual(JSON.parse(await run('document.querySelector(".desktop-process [data-event=tool_use] pre").textContent')).input,input);
  assert.deepEqual(JSON.parse(await run('document.querySelector(".desktop-process [data-event=tool_result] pre").textContent')),result);
  assert.equal(await run('Boolean(globalThis.injected) || Boolean(document.querySelector(".desktop-process img"))'),false);
  assert.equal(await run('getComputedStyle(document.querySelector(".desktop-process pre")).maxHeight'),'none');
  assert.equal(await run('document.querySelector(".desktop-process").open'),true);
  assert.equal(await run('document.querySelector(".desktop-process [data-event=tool_use]").open'),false);
  assert.equal(await run('document.querySelector(".desktop-process [data-event=tool_use]").dataset.status'),'done');
  assert.equal(await run('document.querySelector(".desktop-process [data-event=tool_use] [data-event=tool_result]") !== null'),true);
  assert.equal(await run('getComputedStyle(document.querySelector(".desktop-process-body")).overflowY'),'auto');
  await run('document.querySelector(".desktop-process [data-event=reasoning] summary").click();true');
  assert.equal(await run('document.querySelector(".desktop-process [data-event=reasoning]").open'),true);
  await run('document.querySelector(".desktop-process [data-event=reasoning] summary").click();true');
  await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(__dirname,'../.local/process-active.png'),(await win.webContents.capturePage()).toPNG());
  await run('globalThis.__beingDesktopSessions.poll()');
  assert.equal(await run('document.querySelectorAll(".message.being:not(.thinking-indicator)").length'),1);
  // Disconnect only the response. The server keeps the same turn and replay log.
  response.destroy();
  event('content_block_delta',{delta:{text:' RECOVERED_FINAL_MARKER'}},{live:false});
  event('message_stop',{}, {live:false});active.finished=true;
  history.push({role:'assistant',content:active.header+'FIRST_VISIBLE_PREFIX RECOVERED_FINAL_MARKER',seq:1,at:new Date().toISOString()});
  const toolLikeBody='{"name":"act","args":{"example":"TOOL_LIKE_BODY_TAIL"}}';
  history.push({role:'assistant',content:active.header+toolLikeBody,seq:2,at:new Date().toISOString()});
  await until('document.getElementById("messages").textContent.includes("RECOVERED_FINAL_MARKER") && !isStreaming');
  await until('document.querySelector(".desktop-process").dataset.finished === "true"');
  assert.equal(await run('document.querySelector(".desktop-process").open'),false);
  assert.match(await run('document.querySelector(".desktop-process-heading").textContent'),/^已处理 .*秒 · 1 次工具调用$/);
  await run('document.querySelector(".desktop-process-heading").click();document.querySelector(".desktop-process [data-event=tool_use] summary").click();true');
  assert.equal(await run('document.querySelector(".desktop-process [data-event=tool_use]").open'),true);
  await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(__dirname,'../.local/process-expanded.png'),(await win.webContents.capturePage()).toPNG());
  const text=await run('document.getElementById("messages").textContent');
  assert.equal(text.split('FIRST_VISIBLE_PREFIX').length,2);assert.equal(text.split('RECOVERED_FINAL_MARKER').length,2);
  await run('globalThis.__beingDesktopSessions.poll()');
  assert.equal(await run('document.getElementById("messages").textContent.includes("TOOL_LIKE_BODY_TAIL")'),true,'Tool-like body text must not be removed');
  assert.equal(await run('__beingDesktopTaskQueue.snapshot().pending.length'),0);
  assert.equal(posts,1,'Recovery must never resubmit the prompt');
  assert.equal(await run('document.querySelectorAll(".stream-cursor").length'),0);
  await run('actionLogClear();__beingDesktopSessions.flush()');
  assert.equal(await run('document.querySelectorAll(".desktop-process [data-event=tool_use]").length'),1);
  assert.equal(await run('document.querySelector(".desktop-process").nextElementSibling.classList.contains("being")'),true);
  await win.reload();
  await until('document.querySelector(".desktop-process")?.textContent.includes("RESULT_TAIL") && document.getElementById("messages").textContent.includes("RECOVERED_FINAL_MARKER")');
  assert.equal(await run('document.querySelectorAll(".desktop-process [data-event=tool_use]").length'),1);
  assert.equal(await run('document.querySelector(".desktop-process [data-event=reasoning] pre").textContent'),reasoning);
  assert.equal(await run('document.querySelector(".desktop-process").open'),false);
  assert.equal(await run('document.getElementById("messages").textContent.includes("TOOL_LIKE_BODY_TAIL")'),true,'History rendering must also preserve tool-like text');
  const sessionId=await run('__beingDesktopSessions.list().activeId');
  await run('__beingDesktopSessions.change(null);sessionStorage.clear()');
  await win.reload();
  await until('__beingDesktopSessions.list().activeId!=='+JSON.stringify(sessionId)+' && typeof send==="function"');
  assert.equal(await run('document.querySelectorAll(".desktop-process").length'),0,'Another session must not inherit process panels');
  assert.equal(posts,1);
  // A 202 has no SSE body. Recovery must start without navigation/reconnection
  // and remain isolated until a reply identifies this session and request.
  active = null;
  acceptOnly = true;
  await win.webContents.insertCSS(theme);
  await applyLoomActivity(win.webContents);
  await run('void send("Accepted follow-up");true');
  await until('__beingDesktopTaskQueue.snapshot().pending.some(item=>item.accepted)');
  await until('Boolean(document.querySelector("#tui-bar[data-desktop-accepted-progress].active"))');
  assert.equal(await run('document.querySelector("#tui-bar .tui-thinking").textContent'),'在思考');
  assert.equal(await run('Boolean(document.getElementById("desktop-accepted-progress"))'),false,'Use native Loom activity instead of a receipt card');
  assert.equal(await run('getComputedStyle(document.getElementById("tui-wrapper")).display'),'flex');
  assert.equal(await run('isStreaming'),false);
  const acceptedStream = active;
  active = null;
  await until('__beingDesktopSessions.progress()?.finished && document.getElementById("tui-bar").textContent.includes("等待 Being 返回进度")');
  assert.equal(await run('__beingDesktopTaskQueue.snapshot().pending.length'),1,'No stream is not proof of completion');
  failActive = true;
  await until('document.getElementById("tui-bar").textContent.includes("正在重连")');
  failActive = false;
  active = acceptedStream;
  event('reasoning',{text:'ACCEPTED_REASONING'}, {live:false});
  await until('document.getElementById("tui-bar").textContent.includes("等待本条消息回复")');
  assert.equal(await run('document.getElementById("messages").textContent.includes("ACCEPTED_REASONING")'),false,'Unattributed events must remain private');
  event('tool_use',{name:'foreign_tool',input:{secret:'FOREIGN_ARGUMENT'}}, {live:false});
  await until('document.querySelector("#tui-bar .tui-thinking").textContent === "在行动"');
  assert.equal(await run('document.getElementById("messages").textContent.includes("FOREIGN_ARGUMENT")'),false,'Only the generic Being phase may be shown before routing');
  event('tool_result',{name:'foreign_tool',output:'done'}, {live:false});
  await win.reload();
  await until('Boolean(document.querySelector("#tui-bar[data-desktop-accepted-progress].active"))');
  await win.webContents.insertCSS(theme);
  await applyLoomActivity(win.webContents);
  event('content_block_delta',{delta:{text:active.header+'ACCEPTED_PARTIAL'}}, {live:false});
  await until('document.getElementById("messages").textContent.includes("ACCEPTED_PARTIAL") && isStreaming');
  await until('document.querySelector(".desktop-process")?.textContent.includes("ACCEPTED_REASONING")');
  event('tool_use',{name:'accepted_tool',input:{query:'fixture'}}, {live:false});
  await until('document.querySelector("#tui-bar .tui-thinking")?.textContent === "在行动"');
  await until('document.querySelector(".desktop-process")?.textContent.includes("accepted_tool")');
  assert.equal(await run('getComputedStyle(document.getElementById("tui-wrapper")).display'),'flex','Process history must not hide the native live status');
  await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(__dirname,'../.local/accepted-progress-active.png'),(await win.webContents.capturePage()).toPNG());
  event('tool_result',{name:'accepted_tool',output:'ACCEPTED_RESULT'}, {live:false});
  event('content_block_delta',{delta:{text:' ACCEPTED_FINAL'}}, {live:false});
  event('message_stop',{}, {live:false});active.finished=true;
  history.push({role:'assistant',content:active.header+'ACCEPTED_PARTIAL ACCEPTED_FINAL',seq:3,at:new Date().toISOString()});
  await until('document.getElementById("messages").textContent.includes("ACCEPTED_FINAL") && !isStreaming && !document.querySelector("#tui-bar[data-desktop-accepted-progress]")');
  assert.equal(await run('__beingDesktopTaskQueue.snapshot().pending.length'),0);
  assert.equal(posts,2,'Accepted recovery must not send the message again');
  // The upstream can emit the same 525 twice, then repeat it in replay.
  acceptOnly=false;active=null;
  const upstreamError={message:'LLM API error 525 <unknown status code>: <html>UPSTREAM_HTML_FIXTURE</html>'};
  for(let attempt=1;attempt<=2;attempt++){
    await run('void send("Model error fixture '+attempt+'");true');
    await until('Boolean(currentStreamId)');
    event('error',upstreamError);event('error',upstreamError);active.finished=true;response.end();
    await until('!isStreaming');
    await run('__beingDesktopSessions.poll()');
    await until('document.querySelectorAll(".message[data-model-error-key]").length==='+attempt);
    assert.equal(await run('document.getElementById("messages").textContent.includes("UPSTREAM_HTML_FIXTURE")'),false);
    await until('document.querySelectorAll(".desktop-process [data-event=error]").length==='+attempt);
    assert.equal(posts,2+attempt,'Model errors must not resubmit the task');
  }
  await run('__beingDesktopSessions.flush()');
  await win.reload();
  await until('document.querySelectorAll(".message[data-model-error-key]").length===2');
  assert.equal(await run('document.getElementById("messages").textContent.includes("UPSTREAM_HTML_FIXTURE")'),false);
  active=null;
  await run('void send("Orchestration error fixture");true');
  await until('Boolean(currentStreamId)');
  const policyError={message:'LLM API error 502 Bad Gateway: '+JSON.stringify({error:{type:'orchestration_response_error',code:'upstream_response_incomplete',message:'PRIVATE_UPSTREAM_DETAIL'}})};
  event('error',policyError);event('error',policyError);active.finished=true;response.end();
  await until('!isStreaming && document.getElementById("messages").textContent.includes("模型输出未完成")');
  await run('__beingDesktopSessions.poll();__beingDesktopSessions.flush()');
  await win.reload();
  await until('document.querySelectorAll(".message[data-model-error-key]").length===3');
  assert.equal(await run('document.getElementById("messages").textContent.includes("PRIVATE_UPSTREAM_DETAIL")'),false);
  assert.equal(await run('Array.from(document.querySelectorAll(".message.being")).filter(row=>row.textContent.includes("模型输出未完成")).length'),1);
  assert.equal(posts,5,'Orchestration failures must not automatically resubmit work');
  for(let sync=0;sync<4;sync++)await run('reconcileHistory();__beingDesktopSessions.flush()');
  assert.equal(await run('document.querySelectorAll(".message[data-model-error-key]").length'),3,'Native reconciliation must not duplicate an error that lost request metadata');
  fs.writeFileSync(path.join(__dirname,'../.local/model-error-fixed.png'),(await win.webContents.capturePage()).toPNG());
  const cardSessionId=await run('__beingDesktopSessions.list().activeId');
  const delivered={sessionId:cardSessionId,requestId:randomUUID(),workerId:randomUUID(),title:'像素贪吃蛇',status:'ready',summary:'游戏文件已生成，可直接打开预览。',evidence:'<img src=x onerror="globalThis.resultInjected=true">',preview:true};
  await run('__beingDesktopSessions.deliverWorkerReview('+JSON.stringify(delivered)+')');
  await until('document.querySelectorAll(".desktop-worker-result").length===1');
  for(let sync=0;sync<4;sync++){
    await run('reconcileHistory()');
    await run('__beingDesktopSessions.flush()');
    assert.equal(await run('Array.from(document.querySelectorAll("#messages > .message.being")).filter(row=>row.textContent.includes("游戏文件已生成，可直接打开预览。")).length'),1,'Native incremental history must not append a delivered worker result again');
  }
  assert.equal(await run('document.querySelector(".desktop-worker-result-evidence").open'),false);
  assert.equal(await run('Boolean(document.querySelector(".desktop-worker-result img")) || Boolean(globalThis.resultInjected)'),false);
  let openedResult='';win.webContents.setWindowOpenHandler(details=>{openedResult=details.url;return {action:'deny'};});
  await run('document.querySelector(".desktop-worker-result-open").click()');
  assert.equal(openedResult,'https://being-desktop-result.invalid/open/'+delivered.workerId);
  delivered.status='passed';delivered.summary='游戏已完成，规则测试通过。';delivered.evidence='Rules: 9/9';
  await run('__beingDesktopSessions.deliverWorkerReview('+JSON.stringify(delivered)+')');
  await until('document.querySelector(".desktop-worker-result-summary").textContent.includes("规则测试通过")');
  assert.equal(await run('document.querySelectorAll(".desktop-worker-result").length'),1);
  for(let sync=0;sync<4;sync++){
    await run('reconcileHistory();__beingDesktopSessions.flush()');
    assert.equal(await run('Array.from(document.querySelectorAll("#messages > .message.being")).filter(row=>row.textContent.includes("游戏已完成，规则测试通过。")).length'),1,'Final assessment updates must not be repeated by history polling');
  }
  await run('(()=>{const body=document.querySelector(".desktop-worker-result").closest(".message").dataset.workerResultText;for(let i=0;i<5;i++)addMessage("being",body,false);__beingDesktopSessions.flush();})()');
  await run('__beingDesktopSessions.flush()');await win.reload();
  await until('document.querySelector(".desktop-worker-result-summary")?.textContent.includes("规则测试通过")');
  assert.equal(await run('Array.from(document.querySelectorAll("#messages > .message.being")).filter(row=>row.textContent.includes("游戏已完成，规则测试通过。")).length'),1,'Existing metadata-free copies must be repaired on reload');
  await run('__beingDesktopSessions.change('+JSON.stringify(sessionId)+');sessionStorage.clear()');await win.reload();
  await until('__beingDesktopSessions.list().activeId==='+JSON.stringify(sessionId));
  assert.equal(await run('document.querySelectorAll(".desktop-worker-result").length'),0,'A result must remain in its original conversation');
  await run('__beingDesktopSessions.change('+JSON.stringify(cardSessionId)+');sessionStorage.clear()');await win.reload();
  await until('document.querySelectorAll(".desktop-worker-result").length===1');
  await require('../src/loom-theme.cjs').applyLoomTheme(win.webContents);
  await until('getComputedStyle(document.querySelector(".desktop-worker-result")).paddingTop==="20px"');
  assert.equal(await run('getComputedStyle(document.querySelector(".desktop-worker-result-open")).paddingTop'),'8px');
  assert.equal(await run('getComputedStyle(document.querySelector(".desktop-worker-result-title")).fontSize'),'18px');
  assert.equal(await run('document.querySelectorAll(".message[data-model-error-key]").length'),3,'Result cards must preserve earlier errors');
  assert.equal(await run('document.getElementById("messages").textContent.includes("Model error fixture 1")'),true,'Result cards must preserve user messages');
  await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(__dirname,'../.local/conversation-result-card.png'),(await win.webContents.capturePage()).toPNG());
  console.log('PASS: full received reasoning, tool arguments/results are visible, inert, deduplicated, retained after completion/reload, and isolated by session; native streaming recovers a dropped connection without resubmission.');
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{clearTimeout(deadline);win?.destroy();server.close();app.exit(process.exitCode || 0);});
