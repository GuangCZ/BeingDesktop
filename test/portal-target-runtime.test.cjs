'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createHash}=require('node:crypto');
const {prepareTargetRuntime}=require('../src/portal-target-runtime.cjs');

test('bundled runtime is verified and staged without replacing the previous executable or configuration',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'portal-runtime-'));
  const resourcesPath=path.join(root,'resources'),userData=path.join(root,'profile');
  const directory=path.join(resourcesPath,'portal-target-binding');await fs.mkdir(directory,{recursive:true});
  const bytes=Buffer.from('fixture runtime');
  await fs.writeFile(path.join(directory,'heart-portal.exe'),bytes);
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify({sha256:createHash('sha256').update(bytes).digest('hex')}));
  const original=path.join(root,'old.exe');await fs.writeFile(original,'original');
  const settings={portalExecutable:original,portalConfig:'existing.toml',credential:'unchanged',managedPortal:{executable:original,configPath:'existing.toml',permissions:{file:true}}};
  assert.equal(await prepareTargetRuntime({resourcesPath,userData,settings}),true);
  assert.equal(await fs.readFile(original,'utf8'),'original');
  assert.equal(settings.portalConfig,'existing.toml');assert.equal(settings.credential,'unchanged');
  assert.equal(settings.managedPortal.executable,settings.portalExecutable);
  assert.deepEqual(await fs.readFile(settings.portalExecutable),bytes);
  assert.equal(await prepareTargetRuntime({resourcesPath,userData,settings}),false);
  await fs.writeFile(path.join(directory,'heart-portal.exe'),'tampered');
  await assert.rejects(prepareTargetRuntime({resourcesPath,userData,settings}),/integrity/);
});

test('external configuration never triggers bundled runtime migration',async()=>{
  const settings={portalExecutable:'/existing/heart-portal',portalConfig:'/existing/portal.toml'};
  const before=structuredClone(settings);
  assert.equal(await prepareTargetRuntime({resourcesPath:'/not-read',userData:'/not-written',settings}),false);
  assert.deepEqual(settings,before);
});
