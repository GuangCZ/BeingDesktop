'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {loadDesktopId,desktopPortalName}=require('../src/desktop-identity.cjs');
test('Desktop ID survives restarts while separate profiles get separate tool targets',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'desktop-id-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const a=await loadDesktopId(path.join(dir,'mac')),b=await loadDesktopId(path.join(dir,'win'));
  assert.notEqual(a,b);assert.equal(await loadDesktopId(path.join(dir,'mac')),a);
  assert.notEqual(desktopPortalName(a),desktopPortalName(b));
  if(process.platform!=='win32')assert.equal((await fs.stat(path.join(dir,'mac','desktop-id.json'))).mode&0o777,0o600);
});
test('concurrent first launches publish one complete Desktop identity',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'desktop-id-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const ids=await Promise.all(Array.from({length:16},()=>loadDesktopId(dir)));
  assert.equal(new Set(ids).size,1);assert.deepEqual(await fs.readdir(dir),['desktop-id.json']);
});
test('invalid Desktop identity is preserved and never silently replaced',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'desktop-id-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'desktop-id.json');await fs.writeFile(file,'broken');
  await assert.rejects(loadDesktopId(dir),/原文件已保留/);assert.equal(await fs.readFile(file,'utf8'),'broken');
  assert.throws(()=>desktopPortalName('bad\nroute'),/身份无效/);
});
