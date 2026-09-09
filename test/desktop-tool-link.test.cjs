'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {DesktopToolLink,toolDefinitions,validArguments,MAX_MESSAGE_BYTES,MAX_RESPONSE_BYTES,MAX_PENDING,MAX_BUFFERED_BYTES} = require('../src/desktop-tool-link.cjs');
const {parseConnection} = require('../src/security.cjs');

const request = (method,params = {},id = 1) => ({jsonrpc:'2.0',id,method,params});
const initialized = id => request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'local-test',version:'1.0'}},id);
const PLACE = 'being-desktop-tools-123456789abc';
const boundResult = (value, place = PLACE) => ({...value,content:[{type:'text',text:JSON.stringify({execution_target:{place,hostname:require('node:os').hostname(),platform:process.platform}})},...value.content]});
const call = (name = 'desktop_browser_tabs',args = {},id = 3) => request('tools/call',{name,arguments:{place:PLACE,target_portal:PLACE,...args}},id);
const tick = () => new Promise(resolve => setImmediate(resolve));
const success = {content:[{type:'text',text:'LOCAL_RESULT'}],isError:false};
const jobId = 'abcdefab-1234-5678-9abc-0123456789ab';

test('worker optional placeholders are removed before invocation without relaxing required bindings',async()=>{
  const h=harness({toolAllowed:name=>name.startsWith('desktop_worker_')});
  const socket=await h.ready();
  const args={sessionId:jobId,sessionToken:jobId,requestId:jobId,title:'Read fixture',prompt:'Read only.',parentWorkerId:'',agentId:null};
  socket.message(call('desktop_worker_start',args));await tick();
  assert.equal(h.calls.length,1);assert.equal(Object.hasOwn(h.calls[0].args,'parentWorkerId'),false);
  assert.equal(Object.hasOwn(h.calls[0].args,'agentId'),false);
  assert.equal(validArguments('desktop_worker_start',{...args,target_portal:PLACE,sessionToken:''}),false);
  assert.equal(validArguments('desktop_worker_start',{...args,target_portal:PLACE,parentWorkerId:'invalid'}),false);
  const receipt={action:'receive',callbackId:jobId,sessionId:'',sessionToken:null,workerId:'',outcome:'',summary:'',evidence:null,target_portal:PLACE};
  assert.equal(validArguments('desktop_worker_status',receipt),true);
  assert.equal(validArguments('desktop_worker_status',{...receipt,callbackId:''}),false);
  assert.equal(validArguments('desktop_worker_status',{...receipt,sessionId:jobId}),false);
  assert.equal(validArguments('desktop_worker_status',{action:'review',sessionId:jobId,sessionToken:jobId,workerId:jobId,outcome:'passed',summary:'OK',evidence:'',callbackId:null,target_portal:PLACE}),false);
  h.link.dispose();
});

function harness(options = {}) {
  const sockets = [], changes = [], calls = [], timeouts = new Map(), intervals = new Map();
  let time = 0, timerId = 0;
  class FakeSocket extends EventTarget {
    constructor(url) { super();this.url = url;this.readyState = 0;this.bufferedAmount = 0;this.sent = [];sockets.push(this); }
    open() { this.readyState = 1;this.dispatchEvent(new Event('open')); }
    message(value) { this.dispatchEvent(new MessageEvent('message',{data:typeof value === 'string' || value instanceof ArrayBuffer ? value : JSON.stringify(value)})); }
    send(text) { if (this.failSend) throw new Error('PRIVATE_TRANSPORT_ERROR');this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3;this.dispatchEvent(new Event('close')); }
    on(event,callback) { this.addEventListener(event,callback); }
    ping() { if (this.failSend) throw new Error('PRIVATE_TRANSPORT_ERROR');this.pings = (this.pings || 0)+1; }
    pong() { this.dispatchEvent(new Event('pong')); }
  }
  const link = new DesktopToolLink({
    portalName:PLACE,toolAllowed:options.toolAllowed,
    onChange:snapshot => { changes.push(snapshot);options.onChange?.(snapshot,link); },
    invokeTool:(name,args,context) => { calls.push({name,args,context});return options.invokeTool ? options.invokeTool(name,args,context) : structuredClone(success); },
    WebSocketImpl:FakeSocket,clock:() => time,
    timers:{setTimeout:callback => { const id = ++timerId;timeouts.set(id,callback);return id; },clearTimeout:id => timeouts.delete(id),setInterval:callback => { const id = ++timerId;intervals.set(id,callback);return id; },clearInterval:id => intervals.delete(id)},
  });
  const connect = value => link.connect(value || parseConnection('https://fixture.invalid/being-id/?token=PRIVATE_TOKEN'));
  const ready = async (initialize = true) => {
    const connected = connect();
    const socket = sockets.at(-1);
    socket.open();socket.message({ok:true,relay_keepalive:'text-v1'});
    await connected;
    if (initialize) socket.message(initialized(1));
    return socket;
  };
  return {link,sockets,changes,calls,timeouts,intervals,connect,ready,advance:value => {time += value;},heartbeat:() => {for (const callback of [...intervals.values()]) callback();}};
}

test('construction remains disconnected and never starts transport',() => {
  const h = harness();
  assert.equal(h.sockets.length,0);
  assert.deepEqual(h.link.snapshot(),{status:'disconnected',error:'',lastCall:null,calls:0,pending:[]});
  assert.deepEqual(Object.keys(h.link),[]);
});
test('orchestrator discovery exposes only worker tools and rejects stale execution calls',async()=>{
  let enabled=true;
  const h=harness({toolAllowed:name=>name.startsWith('desktop_worker_')===enabled});
  const socket=await h.ready();socket.message(request('tools/list',{},2));
  assert.deepEqual(socket.sent.at(-1).result.tools.map(tool=>tool.name),toolDefinitions(true).map(tool=>tool.name));
  socket.message(call('desktop_console_run',{command:'pwd'},3));await tick();assert.equal(h.calls.length,0);
  const scope={sessionId:jobId,sessionToken:jobId};socket.message(call('desktop_worker_list',scope,4));await tick();assert.equal(h.calls.length,1);
  enabled=false;socket.message(call('desktop_worker_list',scope,5));await tick();assert.equal(h.calls.length,1);
});

test('explicit browser, console and scoped terminal schemas are defensive copies',() => {
  const definitions = toolDefinitions();
  assert.equal(definitions.length,15);
  assert.deepEqual(definitions.map(item => item.name),['desktop_browser_tabs','desktop_browser_open','desktop_browser_read','desktop_browser_click','desktop_browser_fill','desktop_browser_screenshot','desktop_console_run','desktop_console_status','desktop_console_stop','desktop_terminal_create','desktop_terminal_write','desktop_terminal_read','desktop_terminal_list','desktop_terminal_show','desktop_terminal_close']);
  assert.ok(definitions.every(item => item.inputSchema.additionalProperties === false));
  definitions[0].name = 'changed';
  assert.equal(toolDefinitions()[0].name,'desktop_browser_tabs');
});

test('every advertised tool requires the exact target and rejects other hosts before dispatch',async()=>{
  const h=harness();const socket=await h.ready();socket.message(request('tools/list',{},2));
  for(const tool of socket.sent.at(-1).result.tools) {
    assert.ok(tool.inputSchema.required.includes('place'));
    assert.deepEqual(tool.inputSchema.properties.place.enum,[PLACE]);
  }
  for(const [index,place] of [undefined,null,'mac','being-desktop'].entries()) {
    socket.message(call('desktop_browser_tabs',{target_portal:place},10+index));await tick();
    assert.equal(h.calls.length,0);
    assert.equal(socket.sent.at(-1).error.code,-32602);
  }
  socket.message(call('desktop_browser_tabs',{place:PLACE},20));await tick();
  assert.deepEqual(h.calls[0].args,{});
  assert.equal(JSON.parse(socket.sent.at(-1).result.content[0].text).execution_target.place,PLACE);
  h.link.dispose();
});

test('Hearth may consume place while the endpoint still requires the matching target_portal',async()=>{
  const h=harness();const socket=await h.ready();
  socket.message(request('tools/call',{name:'desktop_browser_tabs',arguments:{target_portal:PLACE}},51));await tick();
  assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0].args,{});
  socket.message(request('tools/call',{name:'desktop_browser_tabs',arguments:{place:PLACE}},52));await tick();
  assert.equal(h.calls.length,1);assert.equal(socket.sent.at(-1).error.code,-32602);
  socket.message(request('tools/call',{name:'desktop_browser_tabs',arguments:{target_portal:'wrong-host'}},53));await tick();
  assert.equal(h.calls.length,1);assert.equal(socket.sent.at(-1).error.code,-32602);
  h.link.dispose();
});

test('connection derives the relay and first path identity without credentials in URL or snapshot',async () => {
  const h = harness();
  const connection = parseConnection('https://fixture.invalid/being-id/nested/?token=PRIVATE_TOKEN&api=https://fixture.invalid/different-api');
  const connected = h.connect(connection);
  const socket = h.sockets[0];socket.open();
  assert.equal(socket.url,'wss://fixture.invalid/_relay');
  assert.equal(socket.sent[0].being_id,'being-id');
  assert.equal(socket.sent[0].loom_token,'PRIVATE_TOKEN');
  assert.match(socket.sent[0].portal_name,/^being-desktop-tools-[a-f0-9]{12}$/);
  socket.message({ok:true,relay_keepalive:'text-v1'});await connected;
  assert.equal(h.link.snapshot().status,'connected');
  assert.ok(!JSON.stringify(h.changes).includes('PRIVATE_TOKEN'));
  assert.ok(!JSON.stringify(h.changes).includes('fixture.invalid'));
  assert.equal(Object.hasOwn(h.link.snapshot(),'toolsDiscovered'),false);
  h.link.dispose();
});

for (const [name,value] of [
  ['null',null],['empty',{}],['missing token',parseConnection('https://fixture.invalid/being/')],
  ['mismatched token',{...parseConnection('https://fixture.invalid/being/?token=one'),token:'two'}],
  ['invalid identity',parseConnection('https://fixture.invalid/being%20name/?token=one')],
  ['external HTTP',{url:'http://fixture.invalid/being/?token=one',token:'one'}],
  ['URL credentials',{url:'https://name:pass@fixture.invalid/being/?token=one',token:'one'}],
]) test(`invalid connection: ${name}`,async () => {
  const h = harness();await assert.rejects(h.link.connect(value));assert.equal(h.sockets.length,0);
});

test('active connection cannot be silently replaced; dispose is permanent',async () => {
  const h = harness();await h.ready();
  await assert.rejects(h.connect());assert.equal(h.sockets.length,1);
  h.link.dispose();await assert.rejects(h.connect());assert.equal(h.sockets.length,1);
});

for (const response of [{ok:false},{ok:true,being_id:'wrong-being'},{ok:true,relay_keepalive:'other'},{ok:true,relay_keepalive:'text-v1',jsonrpc:'2.0'},{ok:true,relay_keepalive:'text-v1',token:'PRIVATE_TOKEN'},'{']) {
  test(`rejects unsupported relay handshake ${JSON.stringify(response)}`,async () => {
    const h = harness();const connection = h.connect();h.sockets[0].open();h.sockets[0].message(response);
    await assert.rejects(connection);assert.equal(h.link.snapshot().status,'error');assert.equal(h.calls.length,0);
  });
}

test('the live relay handshake negotiates WebSocket ping/pong when text keepalive is absent',async()=>{
  const h=harness();const connected=h.connect();const socket=h.sockets[0];socket.open();
  socket.message({being_id:'being-id',ok:true});await connected;
  h.heartbeat();assert.equal(socket.pings,1);assert.equal(socket.sent.length,1);
  h.advance(85000);socket.pong();h.advance(10000);h.heartbeat();
  assert.equal(h.link.snapshot().status,'connected');assert.equal(h.calls.length,0);
  h.advance(90001);h.heartbeat();assert.equal(h.link.snapshot().status,'error');
});

test('fallback heartbeat write failures revoke the authenticated connection',async()=>{
  const h=harness();const connected=h.connect();const socket=h.sockets[0];socket.open();socket.message({ok:true});await connected;
  socket.failSend=true;h.heartbeat();assert.equal(h.link.snapshot().status,'error');
  assert.ok(!JSON.stringify(h.changes).includes('PRIVATE_TRANSPORT_ERROR'));
});

test('a live-shaped relay authenticates and answers actual WebSocket ping frames',{timeout:10000},async t=>{
  const {WebSocketServer}=require('ws');
  const {once}=require('node:events');
  const server=new WebSocketServer({host:'127.0.0.1',port:0});
  let heartbeat,now=0;
  const link=new DesktopToolLink({invokeTool:()=>success,clock:()=>now,timers:{
    setTimeout,clearTimeout,setInterval:callback=>{heartbeat=callback;return 1;},clearInterval:()=>{},
  }});
  t.after(()=>{link.dispose();server.close();});
  await once(server,'listening');
  const accepted=once(server,'connection');
  const connected=link.connect(parseConnection(`http://127.0.0.1:${server.address().port}/being-id/?token=LOCAL_ONLY_TOKEN`));
  const [socket]=await accepted;
  const [data]=await once(socket,'message');const auth=JSON.parse(data);
  assert.equal(auth.loom_token,'LOCAL_ONLY_TOKEN');
  socket.send(JSON.stringify({being_id:auth.being_id,ok:true}));await connected;
  const ping=once(socket,'ping');heartbeat();assert.equal((await ping)[0].toString(),'bd');
  // A subsequent MCP frame establishes that the preceding Pong was processed.
  const reply=once(socket,'message');socket.send(JSON.stringify(initialized(1)));await reply;
  now=90001;heartbeat();assert.equal(link.snapshot().status,'error');
});

test('handshake timeout rejects and removes its timers without retrying',async () => {
  const h = harness();const connection = h.connect();for (const callback of [...h.timeouts.values()]) callback();
  await assert.rejects(connection);assert.equal(h.timeouts.size,0);assert.equal(h.intervals.size,0);assert.equal(h.sockets.length,1);
});

test('a connecting close rejects pending connect instead of leaving it unresolved',async () => {
  const h = harness();const connection = h.connect();h.sockets[0].close();await assert.rejects(connection);
});

test('metadata initialization is required before tools; ping never dispatches a tool',async () => {
  const h = harness();const socket = await h.ready(false);
  socket.message(call());assert.equal(socket.sent.at(-1).error.code,-32002);
  socket.message(request('ping',{},4));assert.deepEqual(socket.sent.at(-1).result,{});
  socket.message(initialized(5));assert.equal(socket.sent.at(-1).result.protocolVersion,'2024-11-05');
  socket.message({jsonrpc:'2.0',method:'notifications/initialized',params:{}});
  socket.message(request('tools/list',{},6));assert.equal(socket.sent.at(-1).result.tools.length,15);
  assert.equal(h.calls.length,0);h.link.dispose();
});

const argumentCases = [
  ['desktop_browser_tabs',{},true],['desktop_browser_tabs',{url:'PRIVATE'},false],
  ['desktop_browser_open',{url:'https://example.com'},true],['desktop_browser_open',{url:'http://127.0.0.1:8000'},true],
  ['desktop_browser_open',{url:'file:///C:/private'},false],['desktop_browser_open',{url:'javascript:alert(1)'},false],
  ['desktop_browser_open',{url:'https://user:pass@example.com'},false],['desktop_browser_open',{url:'https://example.com/\n'},false],
  ['desktop_browser_read',{tabId:'tab-1'},true],['desktop_browser_read',{},false],
  ['desktop_browser_click',{tabId:'tab-1',selector:'button',expectedRevision:2},true],
  ['desktop_browser_click',{tabId:'tab-1',selector:'button'},false],
  ['desktop_browser_click',{tabId:'tab-1',selector:'button',expectedRevision:'2'},false],
  ['desktop_browser_click',{tabId:'tab-1',selector:'x'.repeat(513),expectedRevision:2},false],
  ['desktop_browser_fill',{tabId:'tab-1',selector:'input',text:'',expectedRevision:0},true],
  ['desktop_browser_fill',{tabId:'tab-1',selector:'input',text:'x'.repeat(8001),expectedRevision:0},false],
  ['desktop_browser_screenshot',{tabId:'tab-1',expectedRevision:0},true],
  ['desktop_browser_screenshot',{tabId:'tab-1',expectedRevision:-1},false],
  ['desktop_console_run',{command:'Write-Output TEST',cwd:'E:\\workspace'},true],
  ['desktop_console_run',{command:''},false],['desktop_console_run',{command:'bad\0command'},false],
  ['desktop_console_run',{command:'safe',env:{TOKEN:'PRIVATE'}},false],
  ['desktop_console_status',{},true],['desktop_console_status',{jobId},true],
  ['desktop_console_stop',{jobId},true],['desktop_console_stop',{jobId:'123'},false],
  ['desktop_console_stop',{pid:123},false],['portal_exec',{command:'anything'},false],
];
for (const [index,[name,args,accepted]] of argumentCases.entries()) test(`tool argument contract ${index+1}: ${name}`,() => assert.equal(validArguments(name,{place:PLACE,target_portal:PLACE,...args}),accepted));

test('only a valid call reaches the host with an abort signal and opaque request key',async () => {
  const h = harness();const socket = await h.ready();
  socket.message(call('desktop_browser_open',{url:'https://example.com/PRIVATE_URL'}));await tick();
  assert.equal(h.calls.length,1);
  assert.ok(h.calls[0].context.signal instanceof AbortSignal);
  assert.match(h.calls[0].context.requestKey,new RegExp('^[a-f0-9-]{36}$'));
  assert.equal(h.calls[0].args.url,'https://example.com/PRIVATE_URL');
  assert.deepEqual(socket.sent.at(-1),{jsonrpc:'2.0',id:3,result:boundResult(success)});
  assert.equal(h.link.snapshot().lastCall.status,'completed');assert.equal(h.link.snapshot().pending.length,0);
  assert.ok(!JSON.stringify(h.changes).includes('PRIVATE_URL'));assert.ok(!JSON.stringify(h.changes).includes('LOCAL_RESULT'));
  h.link.dispose();
});

test('host errors are replaced by a fixed MCP error without exception text',async () => {
  const h = harness({invokeTool:() => {throw new Error('PRIVATE_FILE_AND_TOKEN');}});const socket = await h.ready();
  socket.message(call());await tick();assert.equal(socket.sent.at(-1).result.isError,true);
  assert.ok(!JSON.stringify(socket.sent).includes('PRIVATE_FILE_AND_TOKEN'));assert.equal(h.link.snapshot().lastCall.status,'failed');h.link.dispose();
});

test('images stay native MCP image blocks',async () => {
  const content = [{type:'image',mimeType:'image/png',data:Buffer.from('LOCAL_FIXTURE').toString('base64')}];
  const h = harness({invokeTool:() => ({content})});const socket = await h.ready();socket.message(call('desktop_browser_screenshot',{tabId:'tab-1',expectedRevision:1}));await tick();
  assert.deepEqual(socket.sent.at(-1).result,boundResult({content,isError:false}));h.link.dispose();
});

test('combined tool content is capped by the full serialized response limit',async () => {
  const text = 'x'.repeat(1024*1024);
  const h = harness({invokeTool:() => ({content:Array.from({length:9},() => ({type:'text',text}))})});
  const socket = await h.ready();socket.message(call());await tick();
  assert.equal(socket.sent.at(-1).result.isError,true);
  assert.ok(Buffer.byteLength(JSON.stringify(socket.sent.at(-1))) < MAX_RESPONSE_BYTES);
  assert.equal(h.link.snapshot().lastCall.status,'failed');h.link.dispose();
});

test('a realistic large image result is validated and returned within the byte cap',async () => {
  const data = Buffer.alloc(1024*1024,17).toString('base64');
  const h = harness({invokeTool:() => ({content:[{type:'image',mimeType:'image/png',data}]})});
  const socket = await h.ready();socket.message(call('desktop_browser_screenshot',{tabId:'tab-1',expectedRevision:1}));await tick();
  assert.equal(socket.sent.at(-1).result.content[1].data,data);assert.equal(h.link.snapshot().lastCall.status,'completed');h.link.dispose();
});

for (const [index,value] of [null,{content:'text'},{content:[{type:'resource',resource:{uri:'file:///private'}}]},{content:[{type:'image',mimeType:'image/svg+xml',data:'QUJD'}]},{content:[{type:'image',mimeType:'image/png',data:'not base64'}]},{content:[{type:'text',text:'x'.repeat(1024*1024+1)}]},{content:[],extra:'PRIVATE'}].entries()) {
  test(`invalid output is bounded and rejected ${index+1}`,async () => {
    const h = harness({invokeTool:() => value});const socket = await h.ready();socket.message(call());await tick();assert.equal(socket.sent.at(-1).result.isError,true);h.link.dispose();
  });
}

test('concurrency is bounded before the host receives additional calls',async () => {
  const h = harness({invokeTool:() => new Promise(() => {})});const socket = await h.ready();
  for (let id=3;id<3+MAX_PENDING+1;id++) socket.message(call('desktop_browser_tabs',{},id));
  await tick();assert.equal(h.calls.length,MAX_PENDING);assert.equal(h.link.snapshot().pending.length,MAX_PENDING);
  assert.equal(socket.sent.at(-1).error.code,-32000);
  const snapshot = h.link.snapshot();snapshot.pending[0].name = 'changed';assert.equal(h.link.snapshot().pending[0].name,'desktop_browser_tabs');
  h.link.dispose();await tick();assert.ok(h.calls.every(item => item.context.signal.aborted));assert.equal(h.link.snapshot().pending.length,0);
});

test('duplicate request IDs cannot replay tool calls, including after completion',async () => {
  const h = harness();const socket = await h.ready();socket.message(call());await tick();socket.message(call());await tick();
  assert.equal(h.calls.length,1);assert.equal(socket.sent.at(-1).error.code,-32600);h.link.dispose();
});

test('disconnect aborts pending approvals and drops results after reconnect',async () => {
  let finish;const h = harness({invokeTool:() => new Promise(resolve => {finish = resolve;})});const old = await h.ready();
  old.message(call('desktop_browser_tabs',{},'private-request-id'));await tick();h.link.disconnect();
  assert.equal(h.calls[0].context.signal.aborted,true);
  const oldLength = old.sent.length;const fresh = await h.ready();const freshLength = fresh.sent.length;
  finish(success);old.message(call());await tick();
  assert.equal(old.sent.length,oldLength);assert.equal(fresh.sent.length,freshLength);assert.equal(h.calls.length,1);
  assert.ok(!JSON.stringify(h.changes).includes('private-request-id'));h.link.dispose();
});

test('MCP cancellation aborts only its request and suppresses the late result',async () => {
  let finish;const h = harness({invokeTool:() => new Promise(resolve => {finish = resolve;})});const socket = await h.ready();socket.message(call());await tick();
  const count = socket.sent.length;socket.message({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:3,reason:'PRIVATE_REASON'}});
  assert.equal(h.calls[0].context.signal.aborted,true);assert.equal(h.link.snapshot().pending.length,0);assert.equal(h.link.snapshot().lastCall.status,'cancelled');
  finish(success);await tick();assert.equal(socket.sent.length,count);assert.ok(!JSON.stringify(h.changes).includes('PRIVATE_REASON'));h.link.dispose();
});

test('notifications never run tools; unknown methods and extra fields are rejected',async () => {
  const h = harness();const socket = await h.ready();const start = socket.sent.length;
  socket.message({jsonrpc:'2.0',method:'tools/call',params:{name:'desktop_browser_tabs',arguments:{}}});
  assert.equal(socket.sent.length,start);
  for (const frame of [request('resources/read',{},3),{...call('desktop_browser_tabs',{},4),extra:'PRIVATE'},call('desktop_browser_tabs',{constructor:'PRIVATE'},5),request('tools/list',{cursor:'PRIVATE'},6),request('ping',{message:'PRIVATE'},7)]) socket.message(frame);
  await tick();assert.equal(h.calls.length,0);assert.ok(socket.sent.slice(start).every(item => item.error));h.link.dispose();
});

test('malformed IDs, batches and prototype fields never dispatch',async () => {
  const h = harness();const socket = await h.ready();
  for (const frame of [[],null,'null','PRIVATE_INVALID_JSON',{...call(),id:null},{...call(),id:-1},{...call(),id:2.5},{...call(),id:{}},{...call(),id:'x'.repeat(129)},JSON.stringify(call()).replace('"arguments":{','"arguments":{"__proto__":{},')]) socket.message(frame);
  await tick();assert.equal(h.calls.length,0);assert.equal(h.link.snapshot().pending.length,0);h.link.dispose();
});

test('binary or oversized frames revoke the connection instead of coercing data',async () => {
  for (const input of [new ArrayBuffer(2),'中'.repeat(Math.ceil(MAX_MESSAGE_BYTES/3))]) {
    const h = harness();const socket = await h.ready();socket.message(input);assert.equal(h.link.snapshot().status,'error');assert.equal(h.calls.length,0);
  }
});

test('mixed keepalive/MCP frames cannot extend liveness or invoke tools',async () => {
  const h = harness();const socket = await h.ready();h.advance(85000);socket.message({type:'keepalive_ack',...call()});h.advance(6000);h.heartbeat();
  assert.equal(h.link.snapshot().status,'error');assert.equal(h.calls.length,0);assert.equal(h.sockets.length,1);
});

test('valid keepalive acknowledges liveness without execution or automatic retry',async () => {
  const h = harness();const socket = await h.ready();h.advance(85000);socket.message({type:'keepalive_ack'});h.advance(10000);h.heartbeat();
  assert.equal(h.link.snapshot().status,'connected');assert.deepEqual(socket.sent.at(-1),{type:'keepalive'});h.advance(90001);h.heartbeat();assert.equal(h.link.snapshot().status,'error');assert.equal(h.sockets.length,1);
});

test('backpressure and send failures revoke the session with no raw network error',async () => {
  for (const failure of ['buffer','send']) {
    const h = harness();const socket = await h.ready();if (failure === 'buffer') socket.bufferedAmount = MAX_BUFFERED_BYTES+1;else socket.failSend = true;
    socket.message(request('ping',{},3));assert.equal(h.link.snapshot().status,'error');assert.ok(!JSON.stringify(h.changes).includes('PRIVATE_TRANSPORT_ERROR'));
  }
});

test('onChange disconnection before dispatch prevents invocation',async () => {
  const h = harness({onChange:(snapshot,link) => {if (snapshot.pending.length) link.disconnect();}});const socket = await h.ready();socket.message(call());await tick();assert.equal(h.calls.length,0);assert.equal(h.link.snapshot().status,'disconnected');
});

test('onChange disconnection during handshake rejects the connect result',async () => {
  const h = harness({onChange:(snapshot,link) => {if (snapshot.status === 'connected') link.disconnect();}});
  const connected = h.connect();h.sockets[0].open();h.sockets[0].message({ok:true,relay_keepalive:'text-v1'});
  await assert.rejects(connected);assert.equal(h.link.snapshot().status,'disconnected');assert.equal(h.intervals.size,0);
});

test('a local relay performs real native-WebSocket tool discovery and a fixed call', {timeout:15000},async t => {
  const {LoopbackRelay,frame,until} = require('./integration/portal-loopback.cjs');
  const relay = new LoopbackRelay('LOCAL_ONLY_TOKEN',{beingId:'local-desktop-tool-test'});
  class LocalWebSocket extends WebSocket {
    constructor(url) { assert.match(url,/^ws:\/\/127\.0\.0\.1:[0-9]+\/_relay$/);super(url); }
    send(text) {
      const value = JSON.parse(text);
      if (Object.hasOwn(value,'portal_name')) {assert.match(value.portal_name,/^being-desktop-tools-[a-f0-9]{12}$/);relay.portalName = value.portal_name;}
      return super.send(text);
    }
  }
  const calls = [];
  const link = new DesktopToolLink({WebSocketImpl:LocalWebSocket,invokeTool:async(name,args) => {calls.push({name,args});return success;}});
  t.after(async () => {link.dispose();await relay.pause();});
  await relay.listen();
  await link.connect(parseConnection(`http://127.0.0.1:${relay.port}/local-desktop-tool-test/?token=LOCAL_ONLY_TOKEN`));
  await until(relay,() => relay.metadataReplies === 1,'desktop tool metadata',5000);
  assert.deepEqual(relay.toolNames,toolDefinitions().map(item => item.name));
  const response = new Promise(resolve => relay.on('rpc_response',value => {if (value.id === 'local-call') resolve(value);}));
  for (const socket of relay.sockets) socket.write(frame(1,JSON.stringify(call('desktop_browser_tabs',{place:relay.portalName,target_portal:relay.portalName},'local-call'))));
  assert.deepEqual(await response,{jsonrpc:'2.0',id:'local-call',result:boundResult(success,relay.portalName)});assert.deepEqual(calls,[{name:'desktop_browser_tabs',args:{}}]);
  assert.equal(link.snapshot().status,'connected');assert.equal(link.snapshot().lastCall.status,'completed');
});
