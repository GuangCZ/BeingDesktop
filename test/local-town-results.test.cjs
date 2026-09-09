'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {LocalTownResults}=require('../src/local-town-results.cjs');
const record={requestId:'f9168c5e-ceb2-4faa-b6bf-329bf39fa1e4',beingId:'alice',route:'/api/bonfire/hear',query:{limit:'1'}};
const config={baseUrl:'http://127.0.0.1:8317',key:'x'.repeat(64)};
test('an absent mirror is distinct from a failed configured transport and never makes a request',async()=>{
 const adapter=new LocalTownResults({getConfig:()=>null,fetchImpl:async()=>assert.fail('Unconfigured transport must stay offline')});
 await adapter.prepare(record);await adapter.release(record);
 for(const operation of ['read','poll'])await assert.rejects(adapter[operation](record),{code:'RESULT_SOURCE_NOT_CONFIGURED'});
});
test('local tool result traffic is authenticated, bounded to loopback, and never contains a Loom connection',async()=>{
 const calls=[];const adapter=new LocalTownResults({getConfig:()=>config,fetchImpl:async(url,options)=>{calls.push({url,options});return options.method==='GET'?Response.json({data:{messages:[]}}):new Response(null,{status:204});}});
 await adapter.prepare(record);assert.deepEqual(await adapter.read(record),{data:{messages:[]}});await adapter.release(record);
 assert.deepEqual(calls.map(call=>call.options.method),['PUT','GET','DELETE']);
 assert(calls.every(call=>call.url==='http://127.0.0.1:8317/desktop-town/v1/reads/'+record.requestId&&call.options.credentials==='omit'&&call.options.redirect==='error'&&call.options.headers.Authorization==='Bearer '+config.key));
 assert.deepEqual(JSON.parse(calls[0].options.body),{beingId:record.beingId,route:record.route,query:record.query});
});
test('pending, malformed and oversized tool results cannot become empty success',async()=>{
 for(const response of [new Response(null,{status:202}),new Response('broken',{headers:{'content-type':'application/json'}}),new Response('x'.repeat(1024*1024+1),{headers:{'content-type':'application/json'}})]){
  const adapter=new LocalTownResults({getConfig:()=>config,fetchImpl:async()=>response});
  await assert.rejects(adapter.read(record),error=>['INCOMPLETE_RESULT','RESULT_SOURCE_UNAVAILABLE'].includes(error.code));
 }
});
test('invalid local configuration cannot transmit the mirror key',async()=>{
 for(const baseUrl of ['https://remote.example','http://127.0.0.1:8318','http://user@127.0.0.1:8317','http://127.0.0.1:8317/?token=secret']){
  const adapter=new LocalTownResults({getConfig:()=>({...config,baseUrl}),fetchImpl:async()=>assert.fail('Network call with unsafe configuration')});
  await assert.rejects(adapter.prepare(record),{code:'RESULT_SOURCE_UNAVAILABLE'});
 }
});
test('SBS polling enrolls an explicit source and only accepts the matching pending identity',async()=>{
 const calls=[];let wrong=false;
 const adapter=new LocalTownResults({getConfig:()=>config,fetchImpl:async(url,options)=>{
  calls.push(options);
  return options.method==='PUT'?new Response(null,{status:201}):Response.json({pending:true,requestId:record.requestId,beingId:wrong?'other':record.beingId,route:record.route},{status:202});
 }});
 await adapter.prepare({...record,source:'sbs'});
 assert.equal(JSON.parse(calls[0].body).source,'sbs');
 assert.equal(await adapter.poll(record),null);
 wrong=true;await assert.rejects(adapter.poll(record));
 assert.deepEqual(calls.map(value=>value.method),['PUT','GET','GET']);
});

test('native Town business errors preserve only exact bounded fixed codes',async()=>{
 for(const [code,status] of Object.entries({AUTH_REQUIRED:403,IDENTITY_MISMATCH:403,RATE_LIMITED:429,SERVICE_ERROR:502,INCOMPLETE_RESULT:502})){
  const adapter=new LocalTownResults({getConfig:()=>config,fetchImpl:async()=>Response.json({error:{code}},{status})});
  await assert.rejects(adapter.read(record),error=>error.code===code&&!error.message.includes('private'));
 }
});

test('control authentication failures and unrecognized forbidden bodies remain source unavailable',async()=>{
 for(const [status,body,type] of [
  [401,JSON.stringify({error:{code:'AUTH_REQUIRED'}}),'application/json'],
  [403,JSON.stringify({error:{code:'INVALID_REQUEST'}}),'application/json'],
  [403,JSON.stringify({error:{code:'IDENTITY_MISMATCH',message:'private response'}}),'application/json'],
  [403,JSON.stringify({error:{code:'AUTH_REQUIRED'},private:'extra'}),'application/json'],
  [403,JSON.stringify({error:{code:'SECRET_UNKNOWN_CODE'}}),'application/json'],
  [403,'private forbidden page','text/html'],
  [403,'{incomplete private response','application/json'],
  [403,' '.repeat(4097)+JSON.stringify({error:{code:'AUTH_REQUIRED'}}),'application/json'],
 ]){
  const adapter=new LocalTownResults({getConfig:()=>config,fetchImpl:async()=>new Response(body,{status,headers:{'content-type':type}})});
  await assert.rejects(adapter.read(record),error=>error.code==='RESULT_SOURCE_UNAVAILABLE'&&!/private|SECRET/.test(error.message));
 }
 for(const operation of ['prepare','release']){
  const adapter=new LocalTownResults({getConfig:()=>config,fetchImpl:async()=>Response.json({error:{code:'AUTH_REQUIRED'}},{status:403})});
  await assert.rejects(adapter[operation](record),{code:'RESULT_SOURCE_UNAVAILABLE'});
 }
});
