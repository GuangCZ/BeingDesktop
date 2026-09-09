'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {PortalService}=require('../src/services.cjs');
const {PortalUpdates}=require('../src/portal-updates.cjs');
function fixture() {
 let processes=[{pid:42,name:'heart-portal',executable:__filename}];
 let now=1000,reads=0;
 const portal=new PortalService({inspectProcesses:async()=>processes,now:()=>now,readExternalVersion:async()=>{reads++;return '0.8.0';},spawnImpl:()=>{throw new Error('Must not start Portal');}});
 return {portal,setProcesses:value=>{processes=value;},setNow:value=>{now=value;},reads:()=>reads};
}
test('external read reports real version and process path without adopting desktop configuration',async()=>{
 const {portal,reads}=fixture();const result=await portal.inspect();
 assert.equal(result.observedVersion,'0.8.0');assert.equal(result.observedExecutable,__filename);
 assert.equal(result.executable,'');assert.equal(result.configPath,'');assert.equal(result.owned,false);
 assert.equal(new PortalUpdates({getPortal:()=>portal.state}).state().currentVersion,'0.8.0');
 await portal.stop();assert.equal(portal.state.pid,42);assert.equal(reads(),1);
});
test('version reads are cached for a minute and manual refresh bypasses cache',async()=>{
 const {portal,reads,setNow}=fixture();await portal.inspect();await portal.inspect();assert.equal(reads(),1);
 await portal.inspect({forceVersion:true});assert.equal(reads(),2);
 setNow(62000);await portal.inspect();assert.equal(reads(),3);
});
test('exited process clears observed metadata',async()=>{
 const {portal,setProcesses}=fixture();await portal.inspect();setProcesses([]);
 const result=await portal.inspect();assert.equal(result.observedVersion,'');assert.equal(result.observedExecutable,'');assert.equal(result.pid,null);
});
test('PID reused during version read cannot report the old result',async()=>{
 const {portal,setProcesses}=fixture();portal.readExternalVersion=async()=>{setProcesses([{pid:42,name:'other',executable:'/bin/other'}]);return '0.8.0';};
 const result=await portal.inspect();assert.equal(result.status,'error');assert.equal(result.observedVersion,'');
});
test('probe failure keeps verified process state and never returns raw errors',async()=>{
 const {portal}=fixture();portal.readExternalVersion=async()=>{throw new Error('secret-sentinel');};
 const result=await portal.inspect();assert.equal(result.status,'external');assert.equal(result.observedVersion,'');assert.ok(!JSON.stringify(result).includes('secret-sentinel'));
});
test('configuration change while a version read is pending discards the result',async()=>{
 const {portal}=fixture();let finish;
 portal.readExternalVersion=()=>new Promise(resolve=>{finish=resolve;});
 const pending=portal.inspect();await new Promise(resolve=>setImmediate(resolve));
 portal.configure({executable:__filename});finish('0.8.0');
 const result=await pending;assert.equal(result.status,'not_configured');assert.equal(result.pid,null);
});
