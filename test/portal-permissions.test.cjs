'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createPortalConfig,DEFAULT_PERMISSIONS}=require('../src/portal-config.cjs');
const {grovePortalConfigText}=require('../src/grove-portal.cjs');
const {inspectPortalPermissions,savePortalPermissions}=require('../src/portal-permissions.cjs');

async function fixture(t,grove=false) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'being-permissions-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const configPath=path.join(root,'portal.toml');
  const managed={workspace:root,configPath,executable:path.join(root,'heart-portal.exe'),...(grove?{groveKitsDir:path.join(root,'kits')}:{})};
  let {toml}=await createPortalConfig({workspace:root});
  if(grove)toml=grovePortalConfigText(toml,managed.groveKitsDir);
  await fs.writeFile(configPath,toml);
  return {settings:{managedPortal:managed,portalConfig:configPath,portalExecutable:managed.executable},toml,configPath};
}

test('legacy managed permissions can enable execution while preserving Grove and unrelated settings',async t=>{
  const f=await fixture(t,true);
  const before=await inspectPortalPermissions(f.settings);
  assert.deepEqual(before.permissions,DEFAULT_PERMISSIONS);
  let saved=false;
  await savePortalPermissions({settings:f.settings,request:{revision:before.revision,permissions:{...before.permissions,exec:true,screenshot:true}},persist:async()=>{saved=true;}});
  assert.equal(saved,true);
  const after=await inspectPortalPermissions(f.settings);
  assert.equal(after.permissions.exec,true);
  assert.equal(after.permissions.screenshot,true);
  assert.equal(after.source.text,f.toml.replace('exec = false','exec = true').replace('screenshot = false','screenshot = true'));
  const {capabilities}=await createPortalConfig({workspace:f.settings.managedPortal.workspace,permissions:after.permissions});
  assert.ok(capabilities.advertisedTools.includes('portal_exec'));
  assert.ok(capabilities.advertisedTools.includes('portal_process'));
  assert.ok(!capabilities.disabledAtDispatch.includes('portal_exec'));
});

test('persistence failure rolls back file and metadata',async t=>{
  const f=await fixture(t);const old=f.settings.managedPortal;
  const before=await inspectPortalPermissions(f.settings);
  await assert.rejects(savePortalPermissions({settings:f.settings,request:{revision:before.revision,permissions:{...before.permissions,exec:true}},persist:async()=>{throw Error('disk');}}),/未能保存/);
  assert.equal(f.settings.managedPortal,old);
  assert.equal(await fs.readFile(f.configPath,'utf8'),f.toml);
  assert.deepEqual(await fs.readdir(path.dirname(f.configPath)),['portal.toml']);
});

test('stale revisions, external edits and custom selections are never overwritten',async t=>{
  const f=await fixture(t);const before=await inspectPortalPermissions(f.settings);
  await assert.rejects(savePortalPermissions({settings:f.settings,request:{revision:'old',permissions:before.permissions},persist:async()=>{}}),/已变化/);
  await fs.appendFile(f.configPath,'# user edit\n');
  await assert.rejects(inspectPortalPermissions(f.settings),/外部修改/);
  assert.equal(await fs.readFile(f.configPath,'utf8'),f.toml+'# user edit\n');
  await assert.rejects(inspectPortalPermissions({...f.settings,portalExecutable:'different'}),/手动选择/);
});

test('malformed permissions cannot modify a configuration',async t=>{
  const f=await fixture(t);
  for(const permissions of [null,{}, {...DEFAULT_PERMISSIONS,exec:'true'},{...DEFAULT_PERMISSIONS,extra:true}]) {
    await assert.rejects(savePortalPermissions({settings:f.settings,request:{permissions},persist:async()=>{}}),/开关设置/);
  }
  assert.equal(await fs.readFile(f.configPath,'utf8'),f.toml);
});

test('disabling enforceable permissions updates the dispatch summary without hiding enforcement gaps',async t=>{
  const f=await fixture(t);
  const {capabilities}=await createPortalConfig({workspace:f.settings.managedPortal.workspace,permissions:{...DEFAULT_PERMISSIONS,file:false,search:false,web_fetch:false}});
  assert.ok(capabilities.disabledAtDispatch.includes('portal_file_write'));
  assert.ok(capabilities.hiddenButCallable.includes('portal_search'));
  assert.ok(capabilities.hiddenButCallable.includes('portal_web_fetch'));
  assert.ok(capabilities.advertisedTools.includes('portal_oauth_authorize'));
});
