'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {readRuntime}=require('../src/runtime.cjs');
const ok=value=>({status:'fulfilled',value});
const failed={status:'rejected',reason:new Error('private error must not surface')};
const configuration={model:'model-a',provider:'openai-responses',base_url:'https://user:secret@example.test/v1?token=private',sbs_enabled:true};

test('configuration failure leaves health independently connected but clears model and SBS',()=>{
  const prior=readRuntime([ok({}),ok(configuration),ok(null)],'first');
  assert.equal(prior.model,'model-a');
  const current=readRuntime([ok({}),failed,ok(null)],'second');
  assert.equal(current.status,'connected');
  assert.equal(current.configStatus,'error');
  assert.equal(current.model,'');
  assert.equal(current.baseUrl,'');
  assert.equal(current.sideBySide.configured,null);
  assert.equal(current.configCheckedAt,'second');
  assert.doesNotMatch(JSON.stringify(current),/private|model-a/);
});
test('restored configuration is fresh without claiming effective SBS or model execution',()=>{
  const current=readRuntime([failed,ok(configuration),ok({finished:false})],'third');
  assert.equal(current.status,'error');
  assert.equal(current.configStatus,'connected');
  assert.equal(current.baseUrl,'https://example.test/v1');
  assert.deepEqual(current.sideBySide,{configured:true,active:null});
  assert.equal(current.activeStream.active,true);
});
test('malformed configuration and ambiguous stream payloads remain unknown',()=>{
  for(const value of [null,[],{},'not config']) {
    const current=readRuntime([ok({}),ok(value),ok({})],'now');
    assert.equal(current.configStatus,'error');
    assert.equal(current.activeStream.active,null);
  }
  assert.equal(readRuntime([failed,failed,failed],'now').activeStream.active,null);
  assert.equal(readRuntime([ok({}),ok(configuration),ok({finished:true})],'now').activeStream.active,false);
});

test('runtime exposes stream identity and latest execution phase without retaining event payloads', () => {
  const result = readRuntime([ok({}), ok(configuration), ok({finished:false, stream_id:'stream-1', session_id:'session-1', events:[
    {event:'reasoning', data:{text:'private reasoning'}},
    {event:'tool_use', data:{name:'browse_web', input:{token:'private-token'}}}
  ]})], 'now');
  assert.deepEqual(result.activeStream, {active:true,id:'stream-1',sessionId:'session-1',phase:'tool',tool:'browse_web'});
  assert.doesNotMatch(JSON.stringify(result), /private/);
  const completed = readRuntime([ok({}), ok(configuration), ok({finished:true,stream_id:'old',events:[]})], 'later');
  assert.deepEqual(completed.activeStream, {active:false});
});
