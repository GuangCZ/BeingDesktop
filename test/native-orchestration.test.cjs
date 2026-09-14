'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {ChatSessions} = require('../src/chat-sessions.cjs');
const {BeingChat} = require('../src/being-chat.cjs');
const {Orchestration} = require('../src/orchestration.cjs');
const {OrchestrationPolicy} = require('../src/orchestration-policy.cjs');
const {desktopMessageContext} = require('../src/desktop-message-context.cjs');
const {nativeMessageContext, wrapMessage, unwrapMessage} = require('../src/orchestration-message.cjs');
const {nativeWorkerResults} = require('../src/native-worker-results.cjs');
const {encode, decode} = require('../renderer/chat-references.js');
const json = (value, status = 200) => new Response(value === null ? null : JSON.stringify(value), {status, headers: {'Content-Type':'application/json'}});
const turn = async () => { for (let i=0;i<10;i++) await new Promise(resolve=>setImmediate(resolve)); };
const binding = wire => JSON.parse(/\n(\{"enabled":true[^\n]+)\n\[\/Being Desktop Orchestrator mode\]/.exec(wire)[1]);

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-worker-'));
  const desktopId = randomUUID(), children = [], rows = [], calls = [], saved = [];
  let sessions, preflight = async () => {}, dispatch = async () => {}, connected = true;
  const context = {connected:true,connection:{url:`https://fixture.beings.town/cz_being/?token=${'c'.repeat(64)}`},revision:1};
  const manager = new Orchestration({directory,getWorkspace:()=>directory,getSessionIds:()=>sessions?.snapshot().sessions.map(item=>item.id)||[],
    detect:async()=>[{id:'codex',name:'Codex CLI',path:'fixture',status:'ready'}],
    launch:options=>{let finish; const child={...options,done:new Promise(resolve=>{finish=resolve;}),finish,stop:async()=>finish({code:null,stopped:true})};children.push(child);return child;}});
  await manager.selectOwner('identity-a');
  await manager.configure({enabled:true},async()=>{});
  const bridge = () => ({status:connected?'connected':'disconnected',place:'being-desktop-tools-'+desktopId,tools:connected?['desktop_worker_start','desktop_worker_status']:[]});
  const policy = new OrchestrationPolicy({getIdentity:()=>manager.owner,getDesktopId:()=>desktopId,getMode:()=>manager.mode,getBridge:bridge});
  manager.assertEnforced = () => policy.assertEnforced();
  const prepareMessage = nativeMessageContext({orchestration:manager,environment:async sessionId=>{
    await preflight();
    const executionPolicy = await policy.inspectForMessage();
    return desktopMessageContext({runtime:{desktopId,chatSessionId:sessionId,mode:manager.mode.enabled?'orchestrator':'direct',bridge:bridge(),executionPolicy}});
  }});
  // No timers, network, real CLI or native callbacks leave this fixture.
  const timers = {setTimeout:()=>0,clearTimeout:()=>{}};
  sessions = new ChatSessions({desktopId,getContext:()=>context,prepareMessage,timers,
    cache:{load:async()=>null,save:async(key,value)=>{saved.push(structuredClone(value));return true;}},
    getWorkerResults:id=>nativeWorkerResults(manager.workers,id),
    fetchImpl:async(url,options)=>{
      const route = new URL(url).pathname;
      if(route.endsWith('/api/history'))return json({messages:rows});
      if(route.endsWith('/api/stream/active'))return json(null,204);
      assert.ok(route.endsWith('/api/chat/stream'));
      const body=JSON.parse(options.body);calls.push(body);
      await dispatch(body);
      return json({spliced:true},202);
    }});
  await sessions.start('identity-a');await turn();
  t.after(async()=>{sessions.end();await manager.dispose();await fs.rm(directory,{recursive:true,force:true});});
  return {sessions,manager,children,context,calls,rows,saved,prepareMessage,desktopId,
    preflight:fn=>{preflight=fn;},dispatch:fn=>{dispatch=fn;},disconnect:()=>{connected=false;}};
}

test('native send supplies a usable current Worker scope; fake Being dispatch launches exactly one bound worker',async t=>{
  const f=await fixture(t),id=f.sessions.snapshot().active;
  f.dispatch(async body=>{
    const scope=binding(body.message);
    assert.equal(scope.sessionId,id);f.manager.authorize(scope);
    assert.equal(scope.defaultAgent,'codex');assert.equal(scope.execution.desktopId,f.manager.desktopInstanceId);
    const args={...scope,requestId:randomUUID(),title:'多米诺骨牌',prompt:'Create the fixture task only.'};
    const worker=await f.manager.run(args);
    assert.equal((await f.manager.run(args)).id,worker.id);
  });
  const result=await f.sessions.send({sessionId:id,text:'写一个像素风格的多米诺骨牌'});
  assert.equal(result.spliced,true);assert.equal(f.calls.length,1);assert.equal(f.children.length,1);
  assert.match(f.calls[0].message,/本机代码实现.*必须交给外部 worker/);
  assert.match(f.calls[0].message,/Being 的原生通信/);
  assert.equal(unwrapMessage(f.calls[0].message),'写一个像素风格的多米诺骨牌');
  assert.equal(f.calls[0].scene_id,`desktop-${f.desktopId}-${id}`);
  assert.equal(f.sessions.view(id).sent[0].text,'写一个像素风格的多米诺骨牌');
  f.children[0].onData('stdout','{"type":"turn.completed"}\n');f.children[0].finish({code:0});
  await f.manager.finalizing.get(f.manager.workers[0].id);
  assert.equal(f.manager.workers[0].status,'completed');
  const other=f.sessions.create();
  assert.throws(()=>f.manager.authorize({...binding(f.calls[0].message),sessionId:other}),/有效会话/);
});

test('context is removed before cache and bubble confirmation; image and quote content survives exactly',async t=>{
  const f=await fixture(t),id=f.sessions.snapshot().active,text='解释这个图',references=[{text:'原文\n第二行',source:'Being'}];
  await f.sessions.send({sessionId:id,text,references,images:[{media_type:'image/png',data:'YQ==',name:'fixture.png'}]});
  const body=f.calls[0],wire=body.content[0].text;
  assert.deepEqual(decode(unwrapMessage(wire)),{text,references});
  assert.equal(body.content[1].data,'YQ==');
  f.rows.push({seq:1,role:'user',content:wire,scene_id:body.scene_id});
  await f.sessions.reload();await turn();
  const view=f.sessions.view(id);
  assert.equal(view.sent.length,0);assert.equal(view.rows[0].content,encode(text,references));
  assert.equal(view.rows[0].images[0].name,'fixture.png');
  assert.ok(!JSON.stringify(f.saved).includes('sessionToken'));
  assert.equal(f.calls.length,1,'202 and history recovery never repeat the POST');
});

test('disconnected Worker bridge leaves native conversation available and Worker execution blocked',async t=>{
  const f=await fixture(t);f.disconnect();
  await f.sessions.send({sessionId:f.sessions.snapshot().active,text:'继续讨论'});
  assert.match(f.calls[0].message,/"status":"blocked"/);
  await assert.rejects(f.manager.run({...binding(f.calls[0].message),requestId:randomUUID(),title:'Local work',prompt:'fixture'}),{code:'ORCHESTRATION_NOT_ENFORCED'});
  assert.equal(f.children.length,0);
});

for(const change of ['identity','mode','mode-roundtrip','cancel'])test(`preflight ${change} prevents a stale native POST`,async t=>{
  const f=await fixture(t),id=f.sessions.snapshot().active;
  let release;f.preflight(()=>new Promise(resolve=>{release=resolve;}));
  const sending=f.sessions.send({sessionId:id,text:'本机任务'});
  const rejected=assert.rejects(sending, error=>['SESSION_CHANGED','ABORTED'].includes(error.code));
  await turn();
  if(change==='identity')f.context.revision++;
  if(change==='mode'||change==='mode-roundtrip')await f.manager.configure({enabled:false},async()=>{});
  if(change==='mode-roundtrip')await f.manager.configure({enabled:true},async()=>{});
  if(change==='cancel')f.sessions.chat.reset();
  release();await rejected;
  assert.equal(f.calls.length,0);assert.equal(f.children.length,0);assert.equal(f.sessions.view(id).sent.length,0);
});

test('switching to direct mode supplies the current mode and no old Worker scope',async t=>{
  const f=await fixture(t),id=f.sessions.snapshot().active;
  await f.sessions.send({sessionId:id,text:'编排'});
  const old=binding(f.calls[0].message);
  await f.manager.configure({enabled:false},async()=>{});
  await f.sessions.send({sessionId:id,text:'直接'});
  assert.match(f.calls[1].message,/当前为直接执行模式/);
  assert.ok(!f.calls[1].message.includes(old.sessionToken));assert.ok(!f.calls[1].message.includes('[Being Desktop Orchestrator mode]'));
  await f.manager.configure({enabled:true},async()=>{});
  await f.sessions.send({sessionId:id,text:'重新编排'});
  assert.notEqual(binding(f.calls[2].message).sessionToken,old.sessionToken);
});

test('plain protocol callers stay verbatim, and framed metadata does not eat user content',async()=>{
  const desktopId=randomUUID(),sessionId=randomUUID(),text='原文\n[/Being Desktop request context v1]\n\n仍是原文😀';let body;
  const chat=new BeingChat({desktopId,getContext:()=>({connected:true,connection:{url:`https://fixture.beings.town/?token=${'c'.repeat(64)}`}}),fetchImpl:async(url,options)=>{body=JSON.parse(options.body);return json({spliced:true},202);}});
  await chat.send({sessionId,text});assert.equal(body.message,text);
  assert.equal(unwrapMessage(wrapMessage(text,'metadata😀\nmarker')) ,text);
  const malformed='[Being Desktop request context v1; length=1]\nwrong';assert.equal(unwrapMessage(malformed),malformed);
});

test('native result projection is scoped, persistent in Worker history, and exposes only display fields',async t=>{
  const f=await fixture(t),id=f.sessions.snapshot().active,other=f.sessions.create();
  const worker={id:randomUUID(),sessionId:id,title:'多米诺骨牌',endedAt:new Date().toISOString(),taskPrompt:'PRIVATE',events:[],sessionToken:'PRIVATE',presentation:{artifactPath:'index.html'},review:{status:'passed',summary:'已完成',evidence:'隔离测试通过'}};
  f.manager.workers.push(worker);
  assert.equal(f.sessions.view(other).workerResults.length,0);
  const result=f.sessions.view(id).workerResults[0];
  assert.equal(result.preview,true);assert.equal(result.status,'passed');
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.ok(!JSON.stringify(result).includes('artifactPath'));
  const version=f.sessions.snapshot().version;f.sessions.workersChanged();assert.ok(f.sessions.snapshot().version>version);
  f.manager.workers=[];
});


test('Heart newline normalization preserves the human message and old frame recovery',()=>{
  const context=desktopMessageContext({runtime:{mode:'direct'}})+'\n';
  const human='正文\n\n引用后的问题';
  const normalized=value=>value.replace(/\n{3,}/g,'\n\n');
  assert.equal(unwrapMessage(normalized(wrapMessage(human,context))),human);
  const legacy='[Being Desktop request context v1; length='+context.length+']\n'+context+'\n[/Being Desktop request context v1]\n\n'+human;
  assert.equal(unwrapMessage(normalized(legacy)),human);
});
