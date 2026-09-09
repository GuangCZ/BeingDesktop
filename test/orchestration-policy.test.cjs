'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {OrchestrationPolicy,PROTOCOL}=require('../src/orchestration-policy.cjs');
function fixture() {
  let identity='being-one',record=null,current={connectionId:4,config:{model:'fixture',provider:'openai-responses',baseUrl:'https://proxy.fixture.invalid/v1'}};
  const writes=[];
  const gate=new OrchestrationPolicy({getIdentity:()=>identity,getRecord:()=>record,saveRecord:async value=>{record=value;writes.push({record:value});},readConfig:async()=>structuredClone(current),saveConfig:async value=>{assert.ok(record,'must save recovery record first');writes.push(value);current.config={...current.config,...value};},fetchImpl:async()=>Response.json({protocol:PROTOCOL,provider:'openai-responses',enforcement:'worker-tools-only'})});
  return {gate,writes,record:()=>record,current:()=>current,setIdentity:value=>{identity=value;}};
}
test('strict mode switches the remote model endpoint and restores its exact original URL',async()=>{
  const f=fixture();await f.gate.configure(true);
  assert.equal(f.record().originalBaseUrl,'https://proxy.fixture.invalid/v1');
  assert.equal(f.current().config.baseUrl,'https://proxy.fixture.invalid/orchestrator/v1');
  assert.equal(f.gate.state.status,'enforced');
  await f.gate.configure(false);assert.equal(f.current().config.baseUrl,'https://proxy.fixture.invalid/v1');assert.equal(f.record(),null);
});
test('a missing or dishonest capability endpoint cannot enable mode',async()=>{
  const f=fixture();f.gate.fetchImpl=async()=>Response.json({ok:true});
  await assert.rejects(f.gate.configure(true),/没有确认/);assert.equal(f.writes.length,0);
  f.gate.fetchImpl=async()=>new Response('not found',{status:404});
  await assert.rejects(f.gate.configure(true),/尚未提供/);assert.equal(f.writes.length,0);
});
test('preflight rejects an endpoint changed back to direct mode or a changed Being identity',async()=>{
  const f=fixture();await f.gate.configure(true);f.current().config.baseUrl='https://proxy.fixture.invalid/v1';
  await assert.rejects(f.gate.assertEnforced(),/消息已阻止/);assert.equal(f.gate.state.status,'blocked');
  f.setIdentity('being-two');await assert.rejects(f.gate.assertEnforced(),/绑定/);
});
test('remote mutation failure preserves recovery metadata and does not report enforcement',async()=>{
  const f=fixture();f.gate.saveConfig=async()=>{throw new Error('save failed');};
  await assert.rejects(f.gate.configure(true),/save failed/);assert.ok(f.record());assert.notEqual(f.gate.state.status,'enforced');
});
test('disabling never overwrites a separately changed model endpoint',async()=>{
  const f=fixture();await f.gate.configure(true);f.current().config.baseUrl='https://another.fixture.invalid/v1';f.current().config.provider='anthropic';
  await f.gate.configure(false);assert.equal(f.current().config.baseUrl,'https://another.fixture.invalid/v1');assert.equal(f.record(),null);
});

test('connection failure can retry the same capability endpoint without weakening validation',async()=>{
  const f=fixture(),requests=[];
  f.gate.fetchImpl=async()=>{throw new Error('net::ERR_CONNECTION_CLOSED');};
  f.gate.fallbackFetchImpl=async(url,options)=>{requests.push({url,options});return Response.json({protocol:PROTOCOL,provider:'openai-responses',enforcement:'worker-tools-only'});};
  await f.gate.configure(true);
  assert.equal(f.gate.state.status,'enforced');
  assert.ok(requests.every(({url,options})=>url==='https://proxy.fixture.invalid/orchestrator/capabilities'&&options.redirect==='error'&&options.credentials==='omit'));
  f.gate.fallbackFetchImpl=async()=>Response.json({ok:true});
  await assert.rejects(f.gate.assertEnforced(),/没有确认/);
  assert.equal(f.gate.state.status,'blocked');
});

test('HTTP refusal and invalid capability responses never trigger a fallback',async()=>{
  const f=fixture();let retries=0;
  f.gate.fallbackFetchImpl=async()=>{retries++;throw new Error('unexpected fallback');};
  for(const response of [new Response('denied',{status:403}),Response.json({ok:true})]){
    f.gate.fetchImpl=async()=>response;
    await assert.rejects(f.gate.configure(true));
  }
  assert.equal(retries,0);assert.equal(f.writes.length,0);
});
