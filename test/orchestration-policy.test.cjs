'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {OrchestrationPolicy}=require('../src/orchestration-policy.cjs');
const {desktopPortalName}=require('../src/desktop-identity.cjs');
function fixture() {
  let id=randomUUID(),identity='shared-being';
  const mode={enabled:false};
  const bridge={place:desktopPortalName(id),status:'connected',tools:['desktop_worker_start','desktop_worker_status']};
  const gate=new OrchestrationPolicy({getDesktopId:()=>id,getIdentity:()=>identity,getMode:()=>mode,getBridge:()=>bridge,
    readConfig:()=>assert.fail('must not read shared model'),saveConfig:()=>assert.fail('must not write shared model'),fetchImpl:()=>assert.fail('must not contact a shared gateway')});
  return {gate,mode,bridge,setId:value=>{id=value;},setIdentity:value=>{identity=value;}};
}
test('Desktop mode switches and preflight never read or mutate Being model settings',async()=>{
  const f=fixture();await f.gate.configure(true);f.mode.enabled=true;await f.gate.assertEnforced();
  assert.equal(f.gate.state.status,'enforced');assert.equal(f.gate.state.scope,'desktop');
  await f.gate.configure(false);f.mode.enabled=false;assert.equal(f.gate.state.status,'disabled');
  await assert.rejects(f.gate.assertEnforced(),/未启用/);
});
test('one Being can have a direct Desktop and an orchestrator Desktop independently',async()=>{
  const mac=fixture(),win=fixture();
  await mac.gate.configure(false);await win.gate.configure(true);win.mode.enabled=true;
  await win.gate.assertEnforced();assert.equal(mac.mode.enabled,false);
  await mac.gate.configure(false);await win.gate.assertEnforced();
  assert.notEqual(mac.bridge.place,win.bridge.place);
});
test('another Desktop bridge cannot satisfy local preflight even on the same Being',async()=>{
  const a=fixture(),b=fixture();a.mode.enabled=true;a.bridge.place=b.bridge.place;
  await assert.rejects(a.gate.assertEnforced(),/本机 Worker/);
  assert.equal(a.gate.state.status,'blocked');
});
test('missing dispatch and direct tools in an orchestrator bridge fail closed',async()=>{
  const f=fixture();f.mode.enabled=true;
  f.bridge.tools=[];await assert.rejects(f.gate.assertEnforced(),/未连接/);
  f.bridge.tools=['desktop_worker_start','desktop_console_run'];await assert.rejects(f.gate.assertEnforced(),/范围未生效/);
  f.bridge.tools=['desktop_worker_start'];f.bridge.status='disconnected';await assert.rejects(f.gate.assertEnforced(),/未连接/);
});
test('invalid identity cannot configure mode; a disconnected Being cannot dispatch',async()=>{
  const f=fixture();f.setId('malformed');await assert.rejects(f.gate.configure(true),/身份/);
  const g=fixture();g.setIdentity('');await assert.rejects(g.gate.configure(true),/连接 Being/);
  g.mode.enabled=true;await assert.rejects(g.gate.assertEnforced(),/身份/);
});
