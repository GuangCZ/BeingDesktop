'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {Orchestration}=require('../src/orchestration.cjs');
const {normalizeEvent}=require('../src/worker-events.cjs');
const {detectAgents}=require('../src/agent-kits.cjs');
const {toolDefinitions,validArguments}=require('../src/desktop-tool-link.cjs');
const {DesktopTools}=require('../src/desktop-tools.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'being-workers-'));
  const sessionId=randomUUID(),otherId=randomUUID(),children=[];
  const agents=[{id:'codex',name:'Codex CLI',path:'fixture',status:'ready'}];
  const manager=new Orchestration({directory,getWorkspace:()=>directory,getSessionIds:()=>[sessionId,otherId],detect:async()=>agents,
    launch:options=>{let finish;const child={...options,done:new Promise(resolve=>{finish=resolve;}),finish:result=>finish(result),stop:async()=>{finish({code:null,stopped:true});}};children.push(child);return child;}});
  await manager.selectOwner('owner-one');
  await manager.configure({enabled:true},async()=>{});
  const args={...manager.context(sessionId),requestId:randomUUID(),title:'Test worker',prompt:'Inspect only the fixture.'};
  t.after(async()=>{await manager.dispose();assert.ok(directory.startsWith(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});});
  return {manager,args,sessionId,otherId,children,directory};
}

test('result presentation is bound to a completed worker and preserves its review and CLI execution count',async t=>{
  const {manager,args,children,otherId}=await fixture(t),worker=await manager.run(args);
  let presentations=0;manager.presentation={open:async(value,input,{current})=>{assert.equal(current(),true);assert.equal(input.artifactPath,'game/index.html');presentations++;return {state:'loading',artifactPath:input.artifactPath,tabId:'fixture'};},describe:value=>value,dispose:async()=>{}};
  await assert.rejects(manager.present({...args,workerId:worker.id,artifactPath:'game/index.html'}),/完成/);
  children[0].onData('stdout','{"type":"turn.completed"}\n');children[0].finish({code:0});await manager.finalizing.get(worker.id);
  await assert.rejects(manager.present({...manager.context(otherId),workerId:worker.id,artifactPath:'game/index.html'}),/本会话/);
  const before=manager.get(worker.id).review;
  const result=await manager.tool('desktop_worker_status',{...args,workerId:worker.id,action:'present',artifactPath:'game/index.html'});
  assert.equal(JSON.parse(result.content[0].text).presentation.state,'loading');
  assert.deepEqual(manager.get(worker.id).review,before);assert.equal(children.length,1);assert.equal(presentations,1);
  const saved=JSON.parse(await fs.readFile(manager.historyPath(),'utf8'));assert.equal(saved[0].presentation.artifactPath,'game/index.html');
  await assert.rejects(manager.present({...args,workerId:worker.id,artifactPath:'game/index.html'},{signal:AbortSignal.abort()}),/取消/);
  assert.equal(presentations,1);
  await assert.rejects(manager.openResult(worker.id,otherId),/没有可打开/);
  manager.mode.enabled=false;
  await manager.openResult(worker.id,args.sessionId);assert.equal(presentations,2);assert.equal(children.length,1);
});

test('presentation schema accepts one nullable target only for the presentation action',()=>{
  const scope={sessionId:randomUUID(),sessionToken:randomUUID(),workerId:randomUUID(),target_portal:'desktop',action:'present',callbackId:null,outcome:null,summary:null,evidence:null};
  assert.equal(validArguments('desktop_worker_status',{...scope,url:null,artifactPath:'game/index.html'}),true);
  assert.equal(validArguments('desktop_worker_status',{...scope,url:'http://127.0.0.1:4178',artifactPath:null}),true);
  assert.equal(validArguments('desktop_worker_status',{...scope,url:null,artifactPath:null}),false);
  assert.equal(validArguments('desktop_worker_status',{...scope,url:'http://localhost',artifactPath:'game'}),false);
  assert.equal(validArguments('desktop_worker_status',{...scope,action:'read',artifactPath:'game'}),false);
  assert.equal(validArguments('desktop_worker_status',{...scope,action:'read',artifactPath:null,url:null}),true);
});
test('enabling requires an executable default agent and persistence succeeds before changing mode',async t=>{
  const {manager}=await fixture(t);
  await manager.configure({enabled:false},async()=>{});
  manager.detect=async()=>[];
  await assert.rejects(manager.configure({enabled:true},async()=>assert.fail('must not save')),/没有可执行/);
  assert.equal(manager.mode.enabled,false);
  await assert.rejects(manager.configure({enabled:false},async()=>{throw new Error('disk failed');}),/disk failed/);
  assert.equal(manager.mode.enabled,false);
});
test('an unavailable bridge still prevents worker launch after chat readiness is inspected',async t=>{
  const {OrchestrationPolicy}=require('../src/orchestration-policy.cjs');
  const {manager,args,children}=await fixture(t),desktopId=randomUUID();
  const gate=new OrchestrationPolicy({getIdentity:()=>manager.owner,getDesktopId:()=>desktopId,getMode:()=>manager.mode,
    getBridge:()=>({status:'disconnected',place:'being-desktop-tools-'+desktopId,tools:[]})});
  manager.assertEnforced=()=>gate.assertEnforced();
  assert.equal((await gate.inspectForMessage()).status,'blocked');
  await assert.rejects(manager.run(args),{code:'ORCHESTRATION_NOT_ENFORCED'});
  assert.equal(children.length,0);assert.equal(manager.workers.length,0);
});
test('worker dispatch is session bound, deduplicated, and serializes the shared checkout',async t=>{
  const {manager,args,otherId,children}=await fixture(t);
  await assert.rejects(manager.run({...args,sessionToken:randomUUID()}),/有效会话/);
  const worker=await manager.run(args);
  assert.equal((await manager.run(args)).id,worker.id);assert.equal(children.length,1);
  await assert.rejects(manager.tool('desktop_worker_status',{...manager.context(otherId),workerId:worker.id}),/其他会话/);
  await assert.rejects(manager.run({...args,requestId:randomUUID()}),/工作区已有/);
  assert.ok(children[0].input.endsWith('\n\n'+args.prompt));
  assert.equal(JSON.parse(children[0].input.split('\n')[1]).workspace,children[0].cwd);
  assert.ok(children[0].args.includes('--skip-git-repo-check'));
  assert.equal(children[0].args[children[0].args.indexOf('--sandbox')+1],'workspace-write');
  assert.ok(!children[0].args.some(arg=>arg.includes('dangerously')));
  children[0].onData('stdout','{"type":"item.started","item":{"id":"t1","type":"command_execution","command":"pwd"}}\n{"type":"item.com');
  children[0].onData('stdout','pleted","item":{"id":"t1","type":"command_execution","status":"completed","aggregated_output":"fixture"}}\n{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"Verified fixture"}}\n{"type":"turn.completed"}\n');
  children[0].finish({code:0});await tick();
  const result=manager.get(worker.id);assert.equal(result.status,'completed');assert.equal(result.result,'Verified fixture');
  assert.equal(result.events.filter(event=>event.kind==='tool').length,2);
  assert.equal(result.sessionId,args.sessionId);
});
test('exit zero without a success event fails; cancel and process errors are terminal',async t=>{
  const {manager,args,children}=await fixture(t);
  let worker=await manager.run(args);children[0].finish({code:0});await tick();assert.equal(manager.get(worker.id).status,'failed');
  worker=await manager.run({...args,requestId:randomUUID()});await manager.stop(worker.id);await tick();assert.equal(manager.get(worker.id).status,'cancelled');
  worker=await manager.run({...args,requestId:randomUUID()});children[2].onData('stdout','{"type":"turn.failed","error":{"message":"Login required"}}\n');children[2].finish({code:1});await tick();
  assert.equal(manager.get(worker.id).status,'failed');
});

test('Codex reconnection progress does not mark a subsequently completed worker failed',async t=>{
  const {manager,args,children}=await fixture(t);
  const worker=await manager.run(args);
  children[0].onData('stdout','{"type":"error","message":"Reconnecting... 2/5 (request timed out)"}\n{"type":"turn.completed"}\n');
  children[0].finish({code:0});await tick();
  const result=manager.get(worker.id);
  assert.equal(result.status,'completed');
  assert.ok(result.events.some(event=>event.kind==='status'&&event.text.startsWith('Reconnecting')));
  assert.equal(result.events.some(event=>event.kind==='error'),false);
  assert.equal(normalizeEvent('codex',{type:'error',message:'Authentication failed'}).kind,'error');
});
test('wait returns final evidence and changing identity prevents cross-owner access',async t=>{
  const {manager,args,children}=await fixture(t);const worker=await manager.run(args);
  const waited=manager.tool('desktop_worker_wait',{...args,workerId:worker.id});
  children[0].onData('stdout','{"type":"turn.completed"}\n');children[0].finish({code:0});
  assert.equal(JSON.parse((await waited).content[0].text).status,'completed');
  await manager.selectOwner('owner-two');assert.equal(manager.snapshot().workers.length,0);
  await assert.rejects(manager.tool('desktop_worker_status',{...args,workerId:worker.id}),/有效会话/);
  await manager.selectOwner('owner-one');assert.equal(manager.get(worker.id).status,'completed');
});
test('restart marks running records interrupted without relaunch',async t=>{
  const {manager,args,children}=await fixture(t);const worker=await manager.run(args);
  await manager.flush();const file=manager.historyPath(),saved=await fs.readFile(file,'utf8');
  await manager.stopAll();await tick();await manager.flush();
  await fs.writeFile(file,saved);await manager.selectOwner('owner-two');await manager.selectOwner('owner-one');
  // Switching away persists the live ledger, so explicitly restore the simulated crash record before reopening.
  await manager.selectOwner('owner-two');await fs.writeFile(file,saved);await manager.selectOwner('owner-one');
  assert.equal(manager.get(worker.id).status,'interrupted');assert.equal(children.length,1);
});
test('mode cannot switch during a worker and cancelled acquisition cannot launch',async t=>{
  const {manager,args,children}=await fixture(t);let release;
  manager.detect=()=>new Promise(resolve=>{release=resolve;});
  const controller=new AbortController(),pending=manager.run(args,{signal:controller.signal});
  await assert.rejects(manager.configure({enabled:false},async()=>{}),/停止/);
  controller.abort();release([{id:'codex',path:'fixture',status:'ready'}]);
  await assert.rejects(pending,/取消/);assert.equal(children.length,0);
});
test('Codex, Cursor and Grok events preserve call IDs and redact credential-shaped text',()=>{
  const cursor=normalizeEvent('cursor',{type:'tool_call',subtype:'completed',call_id:'c1',tool_call:{readToolCall:{args:{path:'a.txt'},result:{success:{content:'secret=PRIVATE'}}}}});
  assert.equal(cursor.kind,'tool');assert.equal(cursor.callId,'c1');assert.ok(!cursor.output.includes('PRIVATE'));
  const grok=normalizeEvent('grok',{type:'tool_call_update',toolCallId:'g1',status:'completed',rawOutput:{lines:42}});
  assert.equal(grok.callId,'g1');assert.equal(grok.status,'completed');
  assert.equal(normalizeEvent('grok',{type:'end',stopReason:'max_tokens'}).success,false);
  assert.equal(normalizeEvent('codex',{type:'future.event'}),null);
});
test('detection distinguishes missing, incompatible and unauthenticated agents',async()=>{
  const result=await detectAgents({}, {find:async commands=>commands[0]==='grok'?'':commands[0],run:async(file,args)=>file==='codex'?args[0]==='exec'?{code:0,output:'--json --sandbox --skip-git-repo-check'}:{code:1,output:'Login required'}:{code:0,output:'unrelated executable'}});
  assert.deepEqual(result.map(agent=>agent.status),['needs_auth','incompatible','missing']);
});
test('desktop execution is denied in orchestrator mode and worker schemas require session binding',async()=>{
  const self={orchestration:{mode:{enabled:true},tool:async()=>({ok:true})}};
  await assert.rejects(DesktopTools.prototype.request.call(self,'desktop_console_run',{}),/只能调度/);
  await assert.rejects(DesktopTools.prototype.invoke.call(self,'desktop_console_run',{}),/禁止/);
  assert.deepEqual(await DesktopTools.prototype.request.call(self,'desktop_worker_list',{}),{ok:true});
  assert.equal(toolDefinitions(true).length,5);assert.ok(toolDefinitions(true).every(tool=>tool.name.startsWith('desktop_worker_')));
  assert.equal(validArguments('desktop_worker_start',{title:'title',prompt:'task'}),false);
});


test('title generation uses an isolated CLI, ignores duplicate requests and cleans up',async t=>{
  const {manager,sessionId,children,directory}=await fixture(t);
  const pending=manager.generateTitle(sessionId,'修复登录');
  assert.equal(await manager.generateTitle(sessionId,'duplicate'),'');
  while(!children.length)await tick();
  const child=children[0];
  assert.notEqual(child.cwd,directory);
  assert.ok(child.args.includes('read-only'));
  assert.ok(child.input.includes('修复登录'));
  child.onData('stdout',JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'登录修复'}})+'\n');
  child.onData('stdout',JSON.stringify({type:'turn.completed'})+'\n');
  child.finish({code:0});
  assert.equal(await pending,'登录修复');
  assert.equal(manager.workers.length,0);
  await assert.rejects(fs.stat(child.cwd),{code:'ENOENT'});
});

test('failed CLI naming keeps the default title and disabled mode never launches',async t=>{
  const {manager,sessionId,children}=await fixture(t);
  const pending=manager.generateTitle(sessionId,'task');
  while(!children.length)await tick();
  children[0].finish({code:1});
  assert.equal(await pending,'');
  await manager.configure({enabled:false},async()=>{});
  assert.equal(await manager.generateTitle(sessionId,'task'),'');
  assert.equal(children.length,1);
});

test('separate Desktops reject each other capabilities and keep tasks and execution targets local',async t=>{
  const a=await fixture(t),b=await fixture(t);
  const aId=randomUUID(),bId=randomUUID();
  a.manager.getExecutionContext=()=>({desktopId:aId,place:'desktop-a',apiKey:'must-not-enter-prompt'});
  b.manager.getExecutionContext=()=>({desktopId:bId,place:'desktop-b',apiKey:'must-not-enter-prompt'});
  // Even identical conversation IDs do not make per-Desktop capabilities interchangeable.
  b.manager.getSessionIds=()=>[a.sessionId];
  const bArgs={...b.manager.context(a.sessionId),requestId:randomUUID(),title:'B',prompt:'Task B'};
  await assert.rejects(b.manager.run(a.args),/有效会话/);
  await assert.rejects(a.manager.run(bArgs),/有效会话/);
  const wa=await a.manager.run(a.args),wb=await b.manager.run(bArgs);
  assert.equal(a.children.length,1);assert.equal(b.children.length,1);
  assert.notEqual(wa.execution.desktopInstanceId,wb.execution.desktopInstanceId);
  assert.equal(wa.execution.workspace,await fs.realpath(a.directory));assert.equal(wb.execution.workspace,await fs.realpath(b.directory));
  assert.equal(wa.execution.place,'desktop-a');assert.equal(wb.execution.place,'desktop-b');
  assert.equal(wa.execution.desktopId,aId);assert.equal(wb.execution.desktopId,bId);
  assert.doesNotMatch(a.children[0].input,/must-not-enter-prompt/);
  assert.throws(()=>a.manager.get(wb.id),/不存在/);
  await a.manager.stop(wa.id);assert.equal(b.manager.get(wb.id).status,'running');
  await a.manager.configure({enabled:false},async()=>{});assert.equal(b.manager.mode.enabled,true);
});


test('copied foreign Desktop worker history cannot be read or resume callbacks',async t=>{
  const a=await fixture(t),b=await fixture(t);
  const id=randomUUID();a.manager.getExecutionContext=()=>({desktopId:id});
  const worker=await a.manager.run(a.args);await a.manager.stop(worker.id);await a.manager.flush();
  await b.manager.selectOwner('other');
  b.manager.getExecutionContext=()=>({desktopId:randomUUID()});
  await fs.mkdir(b.directory,{recursive:true});
  await fs.copyFile(a.manager.historyPath(),require('node:path').join(b.manager.directory,require('node:path').basename(a.manager.historyPath())));
  await b.manager.selectOwner('owner-one');
  assert.equal(b.manager.workers.length,0);assert.throws(()=>b.manager.get(worker.id),/不存在/);
  await assert.rejects(b.manager.callbacks.receive(randomUUID()),/有效任务/);
});
