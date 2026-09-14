'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {discoverWindowsManager,SUPPORT_FILES}=require('../src/portal-windows-manager.cjs');
async function fixture(t) {
  const home=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'portal-win-manager-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const root=path.join(home,'.heart-portal');await fs.mkdir(root);
  const executable=path.join(root,'heart-portal.exe'),configPath=path.join(root,'portal.toml');
  await fs.writeFile(executable,'old');await fs.writeFile(configPath,'fixture');
  const launchPath=path.join(root,'.portal-launch.json'),launch={protocol:1,arguments:['--config',configPath],environment:{PORTAL_CONNECT_LINK:'private-fixture-value'}};
  await fs.writeFile(launchPath,JSON.stringify(launch));let running=true,mismatch=false;const calls=[];
  const execImpl=async(file,args,options)=>{
    calls.push({file,args});assert.equal(options.env.PORTAL_CONNECT_LINK,undefined);
    if(args[0]==='status')return {stdout:JSON.stringify({root,ready:running,supervised:running,pid:mismatch?2:1})};
    if(args[0]==='stop')running=false;
    if(!args.length)running=true;
    if(args[0]==='--export-windows-runtime')for(const name of SUPPORT_FILES)await fs.writeFile(path.join(args[1],name),'next-'+name);
    return {stdout:''};
  };
  const options={home,executable,configPath,execImpl,readVersion:async()=> '0.8.3',inspectProcesses:async()=>running?[{pid:1,executable}]:[]};
  return {root,launchPath,launch,calls,options,mismatch:()=>{mismatch=true;}};
}
test('Windows adoption retains saved launch and original CLI without returning credentials',async t=>{
  const f=await fixture(t),adapter=await discoverWindowsManager(f.options);assert.ok(adapter);
  assert.doesNotMatch(JSON.stringify(await adapter.state()),/private-fixture|environment|arguments/);
  await adapter.stop();assert.equal((await adapter.state()).running,false);await adapter.start();assert.equal((await adapter.state()).running,true);
  assert.deepEqual(JSON.parse(await fs.readFile(f.launchPath)),f.launch);
  assert.ok(f.calls.some(c=>c.args[0]==='stop'));assert.ok(f.calls.some(c=>c.args.length===0));
});
test('Windows mismatched process, changed launch and legacy versions cannot be adopted',async t=>{
  const f=await fixture(t);assert.equal(await discoverWindowsManager({...f.options,readVersion:async()=> '0.8.0'}),null);
  const adapter=await discoverWindowsManager(f.options);f.mismatch();assert.equal(await discoverWindowsManager(f.options),null);
  await fs.writeFile(f.launchPath,JSON.stringify({...f.launch,name:'changed'}));await assert.rejects(adapter.stop(),/启动配置已变化/);
  assert.ok(f.calls.every(c=>c.args[0]==='status'));
});
test('version-matched Windows support files are backed up and rollback handles previously absent files',async t=>{
  const f=await fixture(t),adapter=await discoverWindowsManager(f.options),scripts=path.join(f.root,'scripts'),transaction=path.join(f.root,'transaction');
  await fs.mkdir(scripts);await fs.mkdir(transaction);await fs.writeFile(path.join(scripts,SUPPORT_FILES[0]),'previous');
  const records=await adapter.prepareUpdate(transaction,f.options.executable);
  await adapter.stop();await adapter.replaceSupport(transaction,records);
  for(const name of SUPPORT_FILES)assert.equal(await fs.readFile(path.join(scripts,name),'utf8'),'next-'+name);
  await adapter.replaceSupport(transaction,records,true);
  assert.deepEqual(await fs.readdir(scripts),[SUPPORT_FILES[0]]);assert.equal(await fs.readFile(path.join(scripts,SUPPORT_FILES[0]),'utf8'),'previous');
});
