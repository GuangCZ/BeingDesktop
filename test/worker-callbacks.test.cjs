'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {Orchestration}=require('../src/orchestration.cjs');
const {createCallbackSender,createContinuationSender,callbackPayload}=require('../src/worker-callbacks.cjs');
const {parseConnection,sessionPartition}=require('../src/security.cjs');
const {validArguments}=require('../src/desktop-tool-link.cjs');

async function fixture(t,{send=async()=>({accepted:true,status:202,inboxId:'42',detail:'accepted'}),report=async()=>{}}={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'being-callbacks-'));
  const sessionId=randomUUID(),otherId=randomUUID(),children=[];let available=false,now=1000;
  const manager=new Orchestration({directory,getWorkspace:()=>directory,getSessionIds:()=>[sessionId,otherId],
    detect:async()=>[{id:'codex',path:'fixture',status:'ready'}],callbacks:{send,ready:()=>available,report,now:()=>now},
    launch:options=>{let finish;const child={...options,done:new Promise(resolve=>{finish=resolve;}),finish,stop:async()=>finish({code:null,stopped:true})};children.push(child);return child;}});
  await manager.selectOwner('owner');await manager.configure({enabled:true},async()=>{});
  const args={...manager.context(sessionId),requestId:randomUUID(),title:'Verify fixture',prompt:'Read the fixture and require exact text EXPECTED. Do not edit.'};
  async function complete(worker,code=0){const child=children.at(-1);child.onData('stdout','{"type":"item.completed","item":{"type":"agent_message","text":"EXPECTED"}}\n{"type":"turn.completed"}\n');child.finish({code});await manager.finalizing.get(worker.id);return manager.get(worker.id);}
  t.after(async()=>{await manager.dispose();assert.ok(directory.startsWith(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});});
  return {manager,directory,args,sessionId,otherId,children,complete,enable:()=>{available=true;},advance:()=>{now+=120000;}};
}

test('terminal result and stable notification are on disk before native delivery',async t=>{
  const sent=[];let f;
  f=await fixture(t,{send:async worker=>{
    const disk=JSON.parse(await fs.readFile(f.manager.historyPath(),'utf8'));
    assert.equal(disk[0].status,'completed');assert.equal(disk[0].result,'EXPECTED');
    assert.equal(disk[0].completion.id,worker.completion.id);sent.push(callbackPayload(worker));
    return {accepted:true,status:202,inboxId:'7',detail:'accepted'};
  }});
  const worker=await f.manager.run(f.args);await f.complete(worker);
  assert.equal(sent.length,0);f.enable();await f.manager.callbacks.pump();
  assert.equal(sent.length,1);assert.equal(sent[0].task_id,worker.id);
  assert.equal(sent[0].result.desktop_session_id,f.sessionId);
  assert.doesNotMatch(JSON.stringify(sent[0]),/sessionToken|taskPrompt|EXPECTED/);
  assert.equal(f.manager.get(worker.id).completion.state,'accepted');
  await f.manager.callbacks.pump();assert.equal(sent.length,1);
});

test('response loss retries the same logical signal without launching the CLI again',async t=>{
  const sent=[];const f=await fixture(t,{send:async worker=>{sent.push(callbackPayload(worker));if(sent.length===1)throw new Error('response lost');return {accepted:true,inboxId:'9'};}});
  const worker=await f.manager.run(f.args);await f.complete(worker);f.enable();await f.manager.callbacks.pump();
  assert.equal(f.manager.get(worker.id).status,'completed');assert.equal(f.manager.get(worker.id).completion.state,'retrying');
  f.advance();await f.manager.callbacks.pump();assert.deepEqual(sent[0],sent[1]);assert.equal(f.children.length,1);
});

test('callback restores current original-session scope and cannot access a different owner or cancelled task',async t=>{
  const f=await fixture(t),worker=await f.manager.run(f.args);const final=await f.complete(worker);
  f.manager.sessions.clear();
  const received=await f.manager.callbacks.receive(final.completion.id);
  assert.equal(received.scope.sessionId,f.sessionId);assert.notEqual(received.scope.sessionToken,f.args.sessionToken);
  assert.equal(received.worker.taskPrompt,f.args.prompt);
  await assert.rejects(f.manager.tool('desktop_worker_status',{...f.manager.context(f.otherId),workerId:worker.id}),/其他会话/);
  await f.manager.stop(worker.id);await assert.rejects(f.manager.callbacks.receive(final.completion.id),/有效任务/);
  await f.manager.selectOwner('different-owner');await assert.rejects(f.manager.callbacks.receive(final.completion.id),/有效任务/);
});

test('wait and native receive share a single durable review and original-session report',async t=>{
  const reports=[];const f=await fixture(t,{report:async worker=>reports.push(worker)}),worker=await f.manager.run(f.args);
  const wait=f.manager.tool('desktop_worker_wait',{...f.args,workerId:worker.id});await f.complete(worker);
  const polled=JSON.parse((await wait).content[0].text);
  const received=await f.manager.callbacks.receive(polled.completion.id);
  const review={...received.scope,workerId:worker.id,outcome:'passed',summary:'The fixture matches.',evidence:'CLI read returned exactly EXPECTED.'};
  await f.manager.callbacks.review(review);
  await f.manager.callbacks.review({...review,summary:'duplicate must not replace the first conclusion'});
  f.enable();await f.manager.callbacks.pump();await f.manager.callbacks.pump();
  assert.equal(reports.length,1);assert.equal(reports[0].sessionId,f.sessionId);assert.equal(reports[0].review.summary,review.summary);
  const duplicate=await f.manager.callbacks.receive(polled.completion.id);assert.equal(duplicate.alreadyReviewed,true);assert.equal(duplicate.scope,undefined);
});

test('insufficient evidence is distinct from passing and follow-up dispatch cannot duplicate',async t=>{
  const f=await fixture(t),worker=await f.manager.run(f.args);const final=await f.complete(worker);
  await f.manager.callbacks.review({...f.args,workerId:worker.id,outcome:'needs_verification',summary:'Artifact has not been checked.',evidence:'Worker preview was truncated.'});
  assert.equal(f.manager.get(worker.id).review.status,'needs_verification');
  await assert.rejects(f.manager.run({...f.args,parentWorkerId:worker.id,requestId:randomUUID()}),/followUpRequestId/);
  const follow={...f.args,parentWorkerId:worker.id,requestId:final.review.followUpRequestId};
  const child=await f.manager.run(follow);const duplicate=await f.manager.run({...follow,requestId:randomUUID()});
  assert.equal(child.id,duplicate.id);assert.equal(f.children.length,2);
});

test('restart recovers an interrupted notification and a fresh tool binding without replaying execution',async t=>{
  const f=await fixture(t),worker=await f.manager.run(f.args);const final=await f.complete(worker);
  f.manager.workers[0].completion.state='sending';f.manager.workers[0].review.status='processing';await f.manager.flush();
  await f.manager.selectOwner('other');await f.manager.selectOwner('owner');
  const restored=f.manager.get(worker.id);assert.equal(restored.completion.state,'pending');assert.equal(restored.review.status,'pending');
  const received=await f.manager.callbacks.receive(final.completion.id);assert.equal(received.scope.sessionId,f.sessionId);assert.equal(f.children.length,1);
});

test('cancellation during transport suppresses the late receipt and mode-off pauses delivery',async t=>{
  let resolve;const f=await fixture(t,{send:()=>new Promise(done=>{resolve=done;})}),worker=await f.manager.run(f.args);await f.complete(worker);
  await f.manager.configure({enabled:false},async()=>{});f.enable();await f.manager.callbacks.pump();assert.equal(resolve,undefined);
  await f.manager.configure({enabled:true},async()=>{});
  const pump=f.manager.callbacks.pump();while(!resolve)await new Promise(done=>setImmediate(done));
  await f.manager.stop(worker.id);resolve({accepted:true,inboxId:'10'});await pump;
  assert.equal(f.manager.get(worker.id).completion.state,'suppressed');assert.equal(f.manager.get(worker.id).review.status,'cancelled');
});

test('report retries preserve accepted callback state and committed evaluation',async t=>{
  let reports=0;const f=await fixture(t,{report:async()=>{if(++reports===1)throw new Error('renderer unavailable');}}),worker=await f.manager.run(f.args);await f.complete(worker);f.enable();await f.manager.callbacks.pump();
  await f.manager.callbacks.review({...f.args,workerId:worker.id,outcome:'failed',summary:'Criteria not met.',evidence:'No expected artifact.'});
  while(f.manager.callbacks.pending)await new Promise(done=>setImmediate(done));
  assert.equal(f.manager.get(worker.id).completion.state,'accepted');assert.equal(f.manager.get(worker.id).review.status,'failed');
  await f.manager.callbacks.pump();assert.equal(f.manager.get(worker.id).review.reported,true);assert.equal(reports,2);
});

test('native sender uses owning Loom token, rejects HTML success, and classifies HTTP retries',async()=>{
  const connection=parseConnection('https://fixture.invalid/being/?token=fixture-secret');
  const worker={id:randomUUID(),sessionId:randomUUID(),requestId:randomUUID(),status:'completed',endedAt:'2026-09-09T00:00:00Z',title:'Fixture',completion:{id:randomUUID()}};
  const requests=[];let response=()=>Response.json({accepted:true,inbox_id:3},{status:202});
  const send=createCallbackSender({getConnection:()=>connection,fetchImpl:async(url,options)=>{requests.push({url,options});return response();}});
  const context={owner:sessionPartition(connection),signal:new AbortController().signal};
  assert.equal((await send(worker,context)).accepted,true);
  const url=new URL(requests[0].url);assert.equal(url.pathname,'/being/api/callback');assert.equal(url.searchParams.get('token'),'fixture-secret');
  assert.equal(requests[0].options.redirect,'error');assert.doesNotMatch(requests[0].options.body,/fixture-secret|sessionToken/);
  response=()=>new Response('<html>login</html>',{headers:{'Content-Type':'text/html'}});assert.equal((await send(worker,context)).accepted,false);
  response=()=>Response.json({error:'busy'},{status:503});assert.equal((await send(worker,context)).retryable,true);
  response=()=>Response.json({error:'forbidden'},{status:403});assert.equal((await send(worker,context)).retryable,false);
  await assert.rejects(send(worker,{...context,owner:'different'}),/身份已变化/);
});

test('receive is the only callback tool without a historical session token; review still requires scope',()=>{
  const target={place:'fixture',target_portal:'fixture'};
  assert.equal(validArguments('desktop_worker_status',{...target,action:'receive',callbackId:randomUUID()}),true);
  assert.equal(validArguments('desktop_worker_status',{...target,action:'receive',callbackId:'fake'}),false);
  assert.equal(validArguments('desktop_worker_status',{...target,action:'receive',callbackId:randomUUID(),sessionToken:randomUUID()}),false);
  assert.equal(validArguments('desktop_worker_status',{...target,action:'review',workerId:randomUUID(),outcome:'passed',summary:'OK',evidence:'OK'}),false);
  const schema=require('../src/desktop-tool-link.cjs').toolDefinitions(true).find(tool=>tool.name==='desktop_worker_status').inputSchema;
  for(const key of ['sessionId','sessionToken','workerId','callbackId','outcome','summary','evidence'])assert.ok(schema.properties[key].type.includes('null'));
  const strictArgs={...target,action:'receive',callbackId:randomUUID(),sessionId:null,sessionToken:null,workerId:null,outcome:null,summary:null,evidence:null};
  assert.equal(validArguments('desktop_worker_status',strictArgs),true);
  assert.equal(validArguments('desktop_worker_status',{...strictArgs,callbackId:null}),false);
  assert.equal(validArguments('desktop_worker_status',{...strictArgs,action:'review',sessionId:randomUUID(),workerId:randomUUID(),summary:'OK',evidence:'OK',outcome:'passed'}),false);
});

test('accepted results schedule one explicit continuation after idle without rerunning the worker',async t=>{
  const f=await fixture(t),worker=await f.manager.run(f.args);await f.complete(worker);f.enable();await f.manager.callbacks.pump();
  let busy=true,sends=0;
  f.manager.callbacks.resume=async(value,{beforeSend})=>{
    if(busy)return {busy:true};
    assert.equal(value.sessionId,f.sessionId);assert.equal(await beforeSend(),true);
    const saved=JSON.parse(await fs.readFile(f.manager.historyPath(),'utf8'));
    assert.equal(saved[0].completion.continuation.state,'sending');sends++;return {accepted:true};
  };
  await f.manager.callbacks.pump();assert.equal(sends,0);busy=false;
  await f.manager.callbacks.pump();await f.manager.callbacks.pump();assert.equal(sends,1);assert.equal(f.children.length,1);
  assert.equal(f.manager.get(worker.id).review.status,'pending');assert.equal(f.manager.get(worker.id).completion.continuation.state,'accepted');
});

test('uncertain continuation delivery is not blindly posted again and cancellation wins before dispatch',async t=>{
  const f=await fixture(t),worker=await f.manager.run(f.args);await f.complete(worker);f.enable();await f.manager.callbacks.pump();
  let sends=0;f.manager.callbacks.resume=async(value,{beforeSend})=>{await beforeSend();sends++;throw new Error('response lost');};
  await f.manager.callbacks.pump();await f.manager.callbacks.pump();assert.equal(sends,1);
  assert.equal(f.manager.get(worker.id).completion.state,'accepted');assert.equal(f.manager.get(worker.id).completion.continuation.state,'uncertain');
  const stored=f.manager.workers[0];delete stored.completion.continuation;
  f.manager.callbacks.resume=async(value,{beforeSend})=>{await f.manager.stop(worker.id);assert.equal(await beforeSend(),false);return {skipped:true};};
  await f.manager.callbacks.pump();assert.equal(f.manager.get(worker.id).review.status,'cancelled');
});

test('continuation sender uses explicit original-task notification and never changes SBS',async()=>{
  const connection=parseConnection('https://fixture.invalid/being/?token=fixture-secret'),requests=[];
  const worker={id:randomUUID(),sessionId:randomUUID(),completion:{id:randomUUID()}};let committed=false;
  const send=createContinuationSender({getConnection:()=>connection,getTarget:()=> 'desktop-fixture',fetchImpl:async(url,options)=>{
    requests.push({url,options});if(url.includes('/active'))return new Response(null,{status:204});
    assert.equal(committed,true);return new Response('event: done\ndata: {}\n\n',{headers:{'Content-Type':'text/event-stream'}});
  }});
  const context={owner:sessionPartition(connection),signal:new AbortController().signal,beforeSend:async()=>{committed=true;return true;}};
  assert.equal((await send(worker,context)).accepted,true);assert.equal(requests.length,2);
  assert.match(JSON.parse(requests[1].options.body).message,/automatic Desktop notification/);
  assert.ok(requests[1].options.body.includes(worker.sessionId));assert.ok(requests[1].options.body.includes(worker.completion.id));
  assert.doesNotMatch(requests[1].options.body,/fixture-secret|sessionToken/);
  assert.equal(new URL(requests[1].url).pathname,'/being/api/chat/stream');
  await assert.rejects(send(worker,{...context,owner:'different'}),/identity/);
});

test('continuation treats an SSE model error as failure even when HTTP transport succeeds',async()=>{
  const connection=parseConnection('https://fixture.invalid/being/?token=fixture-secret');
  const worker={id:randomUUID(),sessionId:randomUUID(),completion:{id:randomUUID()}};
  let response=()=>new Response(new ReadableStream({start(controller){
    for(const chunk of ['event: err','or\r\ndata: {"message":"LLM API error 525 <html>UPSTREAM_HTML</html>"}\r\n','\r\nevent: done\ndata: {}\n\n'])controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  }}),{headers:{'Content-Type':'text/event-stream'}});
  const send=createContinuationSender({getConnection:()=>connection,getTarget:()=> 'desktop-fixture',fetchImpl:async url=>url.includes('/active')?new Response(null,{status:204}):response()});
  const context={owner:sessionPartition(connection),signal:new AbortController().signal,beforeSend:async()=>true};
  assert.deepEqual(await send(worker,context),{accepted:false,failed:true,retryable:true,status:525});
  response=()=>new Response('busy',{status:503});
  assert.deepEqual(await send(worker,context),{accepted:false,failed:true,retryable:true,status:503});
  response=()=>new Response('forbidden',{status:403});
  assert.deepEqual(await send(worker,context),{accepted:false,failed:true,retryable:false,status:403});
});

test('explicit model failures retry only evaluation with backoff and stop after three attempts',async t=>{
  const f=await fixture(t),worker=await f.manager.run(f.args);await f.complete(worker);f.enable();await f.manager.callbacks.pump();
  let sends=0;
  f.manager.callbacks.resume=async(value,{beforeSend})=>{
    assert.equal(await beforeSend(),true);sends++;
    await f.manager.callbacks.receive(value.completion.id);
    return {accepted:false,failed:true,retryable:true,status:525};
  };
  for(let attempt=1;attempt<=3;attempt++){
    await f.manager.callbacks.pump();
    const saved=f.manager.get(worker.id);
    assert.equal(saved.completion.state,'accepted');assert.equal(saved.review.status,'pending');
    assert.equal(saved.completion.continuation.attempts,attempt);
    assert.equal(saved.completion.continuation.state,attempt===3?'failed':'retrying');
    await f.manager.callbacks.pump();assert.equal(sends,attempt,'A retry must wait for backoff');f.advance();
  }
  await f.manager.callbacks.pump();assert.equal(sends,3);assert.equal(f.children.length,1);
  assert.equal(f.manager.get(worker.id).result,'EXPECTED');
});

test('a committed review survives a later model failure and is delivered without another continuation',async t=>{
  const f=await fixture(t),worker=await f.manager.run(f.args);await f.complete(worker);f.enable();await f.manager.callbacks.pump();
  let sends=0;f.manager.callbacks.resume=async(value,{beforeSend})=>{
    await beforeSend();sends++;
    await f.manager.callbacks.review({...f.args,workerId:worker.id,outcome:'passed',summary:'Verified.',evidence:'EXPECTED'});
    return {accepted:false,failed:true,retryable:true,status:525};
  };
  await f.manager.callbacks.pump();f.advance();await f.manager.callbacks.pump();await f.manager.callbacks.pump();
  assert.equal(f.manager.get(worker.id).review.status,'passed');assert.equal(f.manager.get(worker.id).review.reported,true);
  assert.equal(sends,1);assert.equal(f.children.length,1);
});

test('result previews are delivered to the original chat once and merged with a later review',async t=>{
  const reports=[];const f=await fixture(t,{report:async(worker,context)=>reports.push({worker,preview:context.presentationOnly})});
  const worker=await f.manager.run(f.args);await f.complete(worker);
  f.manager.workers[0].presentation={artifactPath:'game/index.html',reported:false};
  f.enable();await f.manager.callbacks.pump();await f.manager.callbacks.pump();
  assert.equal(reports.length,1);assert.equal(reports[0].preview,true);assert.equal(reports[0].worker.sessionId,f.sessionId);
  assert.equal(f.manager.get(worker.id).presentation.reported,true);
  await f.manager.callbacks.review({...f.args,workerId:worker.id,outcome:'passed',summary:'Game ready.',evidence:'Rules passed.'});
  while(f.manager.callbacks.pending)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reports.length,2);assert.equal(reports[1].preview,undefined);
  assert.equal(reports[1].worker.id,reports[0].worker.id);assert.equal(reports[1].worker.review.requestId,reports[0].worker.review.requestId);
  await f.manager.callbacks.pump();assert.equal(reports.length,2);assert.equal(f.children.length,1);
});
