'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const {TownClient} = require('../src/town-client.cjs');
const {TownSession, messagesDto} = require('../src/town-session.cjs');
const {TownController} = require('../src/town-controller.cjs');
const {TownCachedReads} = require('../src/town-cached-reads.cjs');
const {BeingTownWriter} = require('../src/being-town-writer.cjs');
const M = require('../renderer/town-mentions.js');
const choices = [{town_id:'t_a',display_name:'Neuromancer'},{town_id:'t_b',display_name:'Neuromancer'}];
const warnings = [{mention:'@Neuromancer',reason:'ambiguous',candidates:choices,server_field:'preserve this'}];
const json = (value,status=200) => new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function clientFixture(response, onEvent=()=>{}) {
  const context={key:'test-session',beingId:'cz_being',revision:1,connected:true};
  const calls=[];
  const profile={town_id:'t_self',display_name:'Before',mentions:[]};
  const client=new TownClient({getContext:()=>context,store:{loadCredential:async()=>({token:'a'.repeat(64),townId:'t_self'})},onEvent,
    fetchImpl:async(url,options)=>{
      const route=new URL(url).pathname;calls.push({route,method:options.method});
      if(route==='/api/bonfire/mentions')return json(profile);
      assert(response,'No unexpected external route');return response(route,options);
    }});
  return {client,calls,profile,context};
}
function preload(invoke) {
  let api;
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/preload.cjs'),'utf8'),{require:name=>{
    assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(_,value)=>{api=value;}},ipcRenderer:{invoke,on(){},removeListener(){}}};
  }});
  return api;
}
test('P1 speak keeps mention_warnings verbatim and emits exactly one simulated POST',async()=>{
  const f=clientFixture(()=>json({ok:true,town_id:'t_self',seq:17,mentions:['t_c'],mention_warnings:warnings}));
  const result=await f.client.speak({kind:'bonfire',message:'@Neuromancer hello'});
  assert.equal(result.ok,true);assert.deepEqual(result.mention_warnings,warnings);assert.deepEqual(result.mentions,['t_c']);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('P1 private recipient 400 reads candidates and preserves a definite not-sent result through preload',async()=>{
  const f=clientFixture(()=>json({error:'ambiguous recipient',candidates:[...choices,{town_id:'../invalid',display_name:'No'}]},400));
  let captured;
  await assert.rejects(f.client.sendDirectMessage({recipient:'Neuromancer',content:'fixture'}),e=>{captured=e;return e.code==='NOT_SENT'&&e.detail==='ambiguous recipient';});
  assert.deepEqual(captured.candidates,choices);
  const api=preload(async()=>({__townError:true,code:captured.code,message:captured.message,candidates:captured.candidates,detail:captured.detail}));
  await assert.rejects(api.sendDirectMessage({}),e=>e.code==='NOT_SENT'&&JSON.stringify(e.candidates)===JSON.stringify(choices)&&e.detail==='ambiguous recipient');
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('P1 malformed candidate fields cannot become executable UI or escape the IPC DTO',()=>{
  assert.deepEqual(M.candidates([{town_id:'t_a',display_name:'<img src=x>',secret:'hidden'},{town_id:'t_a',display_name:'duplicate'},null]),[{town_id:'t_a',display_name:'<img src=x>'}]);
});
function relayFixture({townId='t_self',resultTownId='t_self',preflightTownId='t_self'}={}) {
  const native=[];
  const writer=new BeingTownWriter({getContext:()=>({connection:{url:'https://heart.example/cz_being/?token=fixture-only&api=https://heart.example/cz_being'},connected:true,beingName:'cz_being',townId,connectionId:1,identityRevision:1}),
    fetchImpl:async(_url,options)=>{
      if(options.method==='GET')return new Response(null,{status:204});
      const prompt=JSON.parse(options.body).message;
      const input=JSON.parse(prompt.match(/原生 http 工具：(.*?)。不添加/s)[1]);native.push(input);
      const body=input.method==='GET'?{town_id:preflightTownId,mentions:[]}:{ok:true,town_id:resultTownId,seq:17,mentions:[],mention_warnings:warnings};
      const events=[['tool_use',{id:'one',name:'http',input}],['tool_result',{tool_use_id:'one',name:'http',is_error:false,content:JSON.stringify({status:200,body:JSON.stringify(body)})}],['message_stop',{}]];
      return new Response(events.map(([name,data])=>`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
    }});
  return {writer,native};
}
test('P1 relay accepts pinned town_id-only receipts and returns warnings on deduplicated completion',async()=>{
  const f=relayFixture(),request={kind:'bonfire',content:'@Neuromancer fixture',connectionRevision:1,requestId:randomUUID()};
  const receipt=await f.writer.send(request);
  assert.deepEqual(receipt.mention_warnings,warnings);assert.deepEqual(await f.writer.send(request),receipt);
  assert.equal(f.native.filter(c=>c.method==='POST').length,1);
});
test('P1 relay cannot accept an unbound or conflicting Town identity',async()=>{
  for(const options of [{townId:''},{preflightTownId:'t_other'}]) {
    const f=relayFixture(options);await assert.rejects(f.writer.send({kind:'bonfire',content:'fixture',connectionRevision:1}),{code:'NOT_SENT'});
    assert.equal(f.native.some(c=>c.method==='POST'),false);
  }
  const f=relayFixture({resultTownId:'t_other'});await assert.rejects(f.writer.send({kind:'bonfire',content:'fixture',connectionRevision:1}),{code:'RESULT_UNKNOWN'});
  assert.equal(f.native.filter(c=>c.method==='POST').length,1);
});
test('P1 identity exposes distinct Loom, verified Town and display fields',async()=>{
  const f=clientFixture();
  assert.equal(f.client.state().townId,'');
  const identity=await f.client.identity();
  assert.deepEqual(identity,{loomBeingId:'cz_being',townId:'t_self',displayName:'Before'});
  assert.equal(f.client.state().beingId,'cz_being');assert.equal(f.client.state().loomBeingId,'cz_being');assert.equal(f.client.state().townId,'t_self');
  const controller=new TownController({installer:{},portal:{state:{}},getContext:()=>({beingName:'cz_being',townId:'t_self',displayName:'After'})});
  assert.equal(controller.state().identity.loomBeingId,'cz_being');assert.equal(controller.state().identity.townId,'t_self');assert.equal(controller.state().identity.displayName,'After');
  f.client.reset();assert.equal(f.client.state().townId,'');
});
test('P1 own-message classification uses only the verified Town ID even after a display-name change',()=>{
  for(const displayName of ['Before','After']) {
    const identity={loomBeingId:'cz_being',beingId:'cz_being',townId:'t_self',displayName};
    assert.equal(M.isOwnMessage('t_self',identity),true);assert.equal(M.isOwnMessage('cz_being',identity),false);assert.equal(M.isOwnMessage(displayName,identity),false);assert.equal(M.isOwnMessage('t_other',identity),false);
  }
  assert.equal(M.isOwnMessage('',{townId:''}),false);
});
test('P1 ambiguous and reused historical names stay unknown while an explicit ID survives',()=>{
  const envelope={ok:true,global_latest_seq:1,messages:[{seq:1,being:'Echo',message:'past'}]};
  for(const members of [[{id:'t_new_owner',name:'Echo'}],[{id:'t_a',name:'Echo'},{id:'t_b',name:'Echo'}],[]]) {
    const row=messagesDto(envelope,members).messages[0];assert.equal(row.beingId,'');assert.equal(row.authorUnknown,true);assert.equal(row.beingName,'Echo');
  }
  envelope.messages[0].town_id='t_original';
  const row=messagesDto(envelope,[{id:'t_new_owner',name:'Echo'}]).messages[0];assert.equal(row.townId,'t_original');assert.equal(row.beingId,'t_original');assert.equal(row.authorUnknown,undefined);
});
test('P1 channel reads verify town_id-only preflight and status against the pinned binding',async()=>{
  for(const wrong of [false,true]) {
    const calls=[];
    const session=new TownSession({getContext:()=>({configured:true,connected:true,beingName:'cz_being',townId:'t_self',connectionId:1}),fetchImpl:async(url,options)=>{
      calls.push(options.method);return new URL(url).pathname==='/api/bonfire/mentions'?json({town_id:'t_self',mentions:[]}):json({town_id:wrong?'t_other':'t_self',channels:[{channel:'feishu',ready:true}]});
    }});
    if(wrong)await assert.rejects(session.getChannelStatus(),{code:'IDENTITY_MISMATCH'});
    else assert.equal((await session.getChannelStatus()).channels[0].status,'connected');
    assert.ok(calls.every(method=>method==='GET'));
  }
});
test('P1 members cache keys current metadata by ID, expires, refreshes manually and fences rename invalidation',async()=>{
  let time=1000,calls=0,name='Before',release;
  const session=new TownSession({getContext:()=>({}),now:()=>time,membersTtlMs:50,fetchImpl:async()=>{calls++;if(release===true)await new Promise(resolve=>{release=resolve;});return json({community:[{town_id:'t_self',display_name:name},{town_id:'t_other',display_name:name}]});}});
  assert.equal((await session.getMembers()).members.length,2);await session.getMembers();assert.equal(calls,1);
  time+=51;name='After';assert.equal((await session.getMembers()).members[0].name,'After');assert.equal(calls,2);
  await session.getMembers({force:true});assert.equal(calls,3);assert.equal(session.memberDisplayName('t_self'),'After');
  release=true;const pending=session.getMembers({force:true});await new Promise(resolve=>setImmediate(resolve));session.invalidateMembers();release();
  await assert.rejects(pending,{code:'SESSION_CHANGED'});assert.equal(session.memberCacheState().expiresAt,0);assert.equal(session.memberDisplayName('t_self'),'');
});
test('P1 verified local profile refresh emits cache invalidation without sending a message',async()=>{
  const events=[];const session=new TownSession({getContext:()=>({}),fetchImpl:async()=>json({community:[{town_id:'t_self',display_name:'Before'}]})});
  await session.getMembers();
  const f=clientFixture(null,event=>{events.push(event);session.invalidateMembers();});
  await f.client.identity();f.profile.display_name='After';await f.client.identity({force:true});
  assert.deepEqual(events,[{type:'profile_changed',townId:'t_self'}]);assert.equal(session.memberCacheState().expiresAt,0);assert.ok(f.calls.every(c=>c.method==='GET'));
});
test('P1 persisted member snapshots expire and in-flight pre-rename reads cannot repopulate them',async()=>{
  let time=1000,saved={cached:true,data:{members:[{id:'t_self',name:'Before'}]},lastSuccessAt:1000},release;
  const reads=new TownCachedReads({now:()=>time,membersTtlMs:50,getContext:()=>({connected:true,identityKey:'one',revision:1}),cache:{load:async()=>saved,save:async()=>assert.fail('Invalidated read must not persist')}});
  assert.equal((await reads.snapshot({method:'getBeingMembers'})).cached,true);time+=51;assert.equal((await reads.snapshot({method:'getBeingMembers'})).cached,false);
  const pending=reads.read('getBeingMembers',undefined,()=>new Promise(resolve=>{release=resolve;}));reads.invalidateMembers();release({members:[]});await assert.rejects(pending,{code:'SESSION_CHANGED'});
});
test('P1 manual names resolve only exact unique matches, picker gets duplicates, unknown syntax remains raw',()=>{
  const members=[{id:'t_a',name:'Neuromancer'},{id:'t_b',name:'Shared'},{id:'t_c',name:'Shared'},{id:'t_space',name:'Two Words'}];
  assert.equal(M.resolve('@Neuromancer hi',members).text,'@t_a hi');assert.deepEqual(M.resolve('@Neuromancer hi',members).members,['t_a']);
  const duplicate=M.resolve('@Shared hi',members);assert.equal(duplicate.ambiguous.length,1);assert.deepEqual(duplicate.members,[]);assert.equal(duplicate.ambiguous[0].candidates.length,2);
  for(const text of ['@neuromancer hi','@Unknown hi','@Two Words hi']) {const result=M.resolve(text,members);assert.equal(result.text,text);assert.ok(result.unresolved.length);}
  assert.deepEqual(M.resolve('https://x.test/@Shared mail@Shared',members).ambiguous,[]);
});
