'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {adoptionRecord}=require('../src/portal-adoption.cjs');
const {inspectPortalPermissions,applyPortalPermissions}=require('../src/portal-permissions.cjs');
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'adopted-permissions-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const configPath=path.join(root,'portal.toml'),source='name = "existing"\nconnect_link = "private-fixture"\nworkspace = "/existing"\nkits_enabled = true\n[tools]\nexec = true # retained\nfile = true\n[security]\nexec_allowlist = ["safe"]\n';
  await fs.writeFile(configPath,source);let running=true;const actions=[];
  const adapter={kind:'launchagent',descriptor:{executable:path.join(root,'heart-portal'),configPath,label:'town.beings.heart-portal',wrapperHash:'original'},state:async()=>({executable:adapter.descriptor.executable,configPath,running,pid:running?123:null}),stop:async()=>{actions.push('stop');running=false;},start:async()=>{actions.push('start');running=true;},mark:async()=>[]};
  const settings={adoptedPortal:adoptionRecord(adapter),portalConfig:'/unrelated',portalExecutable:'/unrelated',managedPortal:{untouched:true}};
  const current=await inspectPortalPermissions(settings,{adapter}),request={configPath,revision:current.revision,permissions:{...current.permissions,exec:false}};
  return {root,configPath,source,adapter,settings,request,actions,persist:async()=>{throw Error('external permissions must not rewrite Desktop deployment settings');},verify:async()=>({passed:true,connected:true})};
}
test('adopted permissions use the original config and restart the original manager while preserving other bytes',async t=>{
  const f=await fixture(t),before=structuredClone(f.settings),result=await applyPortalPermissions(f);
  assert.equal(result.changed,true);assert.deepEqual(f.actions,['stop','start']);assert.deepEqual(f.settings,before);
  assert.equal(await fs.readFile(f.configPath,'utf8'),f.source.replace('exec = true','exec = false'));
  const backups=(await fs.readdir(f.root)).filter(name=>name.endsWith('.bak'));assert.equal(backups.length,1);
  assert.equal(await fs.readFile(path.join(f.root,backups[0]),'utf8'),f.source);
});
test('no-op save performs no writes or service actions',async t=>{
  const f=await fixture(t);f.request.permissions.exec=true;assert.equal((await applyPortalPermissions(f)).changed,false);
  assert.deepEqual(f.actions,[]);assert.deepEqual(await fs.readdir(f.root),['portal.toml']);
});
test('new permissions that fail restart verification are rolled back before restoring service',async t=>{
  const f=await fixture(t);let checks=0;f.verify=async()=>({passed:++checks>1});
  await assert.rejects(applyPortalPermissions(f),/已恢复原配置和运行状态/);
  assert.deepEqual(f.actions,['stop','start','stop','start']);assert.equal(await fs.readFile(f.configPath,'utf8'),f.source);
});
test('stale revisions and missing adoption do not stop or overwrite a service',async t=>{
  const f=await fixture(t);f.request.revision='old';await assert.rejects(applyPortalPermissions(f),/已变化/);assert.deepEqual(f.actions,[]);
  f.settings.adoptedPortal=null;await assert.rejects(inspectPortalPermissions(f.settings,{adapter:f.adapter}),/先一键接管/);
});
test('concurrent config edits are retained and the original service resumes after a rejected save',async t=>{
  const f=await fixture(t),stop=f.adapter.stop;f.adapter.stop=async()=>{await stop();await fs.appendFile(f.configPath,'# concurrent edit\n');};
  await assert.rejects(applyPortalPermissions(f),/已恢复运行/);assert.deepEqual(f.actions,['stop','start']);
  assert.equal(await fs.readFile(f.configPath,'utf8'),f.source+'# concurrent edit\n');
});
