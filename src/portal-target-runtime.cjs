'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');

// Install the bundled target-aware runtime without replacing a running executable.
async function prepareTargetRuntime({resourcesPath,userData,settings}) {
  if (!settings.portalExecutable || !settings.portalConfig) return false;
  const directory=path.join(resourcesPath,'portal-target-binding');
  let manifest;
  try { manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8')); }
  catch(error) { if(error.code==='ENOENT')return false;throw error; }
  if(!/^[a-f0-9]{64}$/.test(manifest.sha256))throw new Error('Invalid bundled Portal digest');
  const bytes=await fs.readFile(path.join(directory,'heart-portal.exe'));
  if(createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)throw new Error('Bundled Portal integrity mismatch');
  const destination=path.join(userData,'managed-portal','target-binding-'+manifest.sha256.slice(0,16));
  await fs.mkdir(destination,{recursive:true});
  const executable=path.join(destination,'heart-portal.exe');
  const current=await fs.readFile(executable).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!current?.equals(bytes)) {
    const temp=executable+'.tmp';await fs.writeFile(temp,bytes,{mode:0o700});await fs.rename(temp,executable);
  }
  if(settings.portalExecutable===executable)return false;
  const previous=settings.portalExecutable;
  settings.portalExecutable=executable;
  if(settings.managedPortal?.executable===previous)settings.managedPortal={...settings.managedPortal,executable};
  return true;
}

module.exports={prepareTargetRuntime};
