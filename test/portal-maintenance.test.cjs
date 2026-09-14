'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {Readable} = require('node:stream');
const {EventEmitter} = require('node:events');
const {PortalInstaller} = require('../src/portal-installer.cjs');
const {PortalMaintenance, compatibleRelease, fileHash, durableJson} = require('../src/portal-maintenance.cjs');
const {hash} = require('../src/portal-launchagent.cjs');

async function fixture(t, {running = true, verify} = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'portal-maintenance-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const original = path.join(root,'heart-portal.exe'), configPath = path.join(root,'portal.toml');
  await fs.writeFile(original,'old-version'); await fs.writeFile(configPath,'name = "fixture"\n');
  const bytes = Buffer.from('candidate-version');
  const release = {version:'0.8.3',size:bytes.length,sha256:hash(bytes),url:'https://github.com/d5z/heart-portal/releases/download/v0.8.3/heart-portal-windows-x86_64.exe'};
  let executable = original, context = 'one', failStart = false;
  const actions = [];
  const adapter = {kind:'desktop',
    state:async()=>({kind:'desktop',executable,configPath,running,pid:running?123:null,version:executable===original?'0.8.0':'0.8.3'}),
    stop:async()=>{actions.push('stop');running=false;},
    start:async()=>{actions.push('start');if(failStart && executable!==original)throw new Error('Failed startup');running=true;},
    activate:async file=>{actions.push(file===original?'restore':'activate');executable=file;},
  };
  const createInstaller = release=>new PortalInstaller({userDataDir:root,platform:'win32',arch:'x64',release,
    requestImpl:(_url,_options,callback)=>{
      const request=new EventEmitter();request.end=()=>queueMicrotask(()=>{
        const response=Readable.from([bytes]);response.headers={};response.statusCode=200;callback(response);
      });return request;
    }});
  const controller = new PortalMaintenance({userDataDir:root,platform:'win32',arch:'x64',resolveAdapter:async()=>adapter,
    createInstaller,readVersion:async file=>(await fs.readFile(file)).equals(bytes)?'0.8.3':'0.8.0',
    getContext:()=>context,verify:verify || (async()=>({passed:true,connection:'fixture',tools:'fixture'}))});
  await controller.initialize();
  return {root,original,configPath,release,bytes,actions,adapter,controller,createInstaller,
    context:value=>{context=value;},failStart:()=>{failStart=true;}};
}

test('compatibility permits tested 0.8 releases and rejects a new protocol line',()=>{
  for(const v of ['0.8.3','0.8.4','0.8.20'])assert.equal(compatibleRelease(v),true);
  for(const v of ['0.8.0','0.9.0','1.0.0','0.8.4-rc.1','invalid'])assert.equal(compatibleRelease(v),false);
});
test('background staging never stops a live instance, and automatic apply waits for a stopped instance',async t=>{
  const f=await fixture(t);await f.controller.stage(f.release);
  assert.deepEqual(f.actions,[]);assert.equal(f.controller.state().phase,'ready');
  await f.controller.apply();assert.equal(f.controller.state().phase,'waiting');assert.deepEqual(f.actions,[]);
  assert.equal(await fs.readFile(f.original,'utf8'),'old-version');
});
test('explicit stop and apply verifies before committing, with a retained rollback binary',async t=>{
  const f=await fixture(t);await f.controller.stage(f.release);await f.controller.apply({restart:true});
  assert.deepEqual(f.actions,['stop','activate','start']);assert.equal(f.controller.state().phase,'complete');
  assert.equal(await fs.readFile(f.original,'utf8'),'old-version');
  await assert.rejects(fs.stat(f.controller.journalFile),{code:'ENOENT'});
  const dirs=(await fs.readdir(f.controller.directory)).filter(s=>/^[a-f0-9-]{36}$/.test(s));
  const result=JSON.parse(await fs.readFile(path.join(f.controller.directory,dirs[0],'result.json'),'utf8'));
  assert.equal(result.phase,'committed');assert.equal(result.outcome,'complete');
  assert.equal(await fileHash(result.backup),hash(Buffer.from('old-version')));
});
test('a failed startup restores the old executable selection and restarts the old instance',async t=>{
  const f=await fixture(t);f.failStart();await f.controller.stage(f.release);
  await assert.rejects(f.controller.apply({restart:true}),/已恢复旧版本/);
  assert.deepEqual(f.actions,['stop','activate','start','stop','restore','start']);
  assert.equal((await f.adapter.state()).executable,f.original);assert.equal(f.controller.state().phase,'rolled_back');
});
test('a live PID without connection/tool verification rolls back',async t=>{
  const f=await fixture(t,{verify:async()=>({passed:false})});await f.controller.stage(f.release);
  await assert.rejects(f.controller.apply({restart:true}),/已恢复旧版本/);
  assert.equal((await f.adapter.state()).executable,f.original);
});
test('changing configuration after staging rejects the update before stopping anything',async t=>{
  const f=await fixture(t);await f.controller.stage(f.release);await fs.appendFile(f.configPath,'# user changed\n');
  await assert.rejects(f.controller.apply({restart:true}),/程序或配置已变化/);assert.deepEqual(f.actions,[]);
});
test('tampered candidate bytes are rejected even if the version string is unchanged',async t=>{
  const f=await fixture(t);await f.controller.stage(f.release);await fs.writeFile(f.createInstaller(f.release).executable,Buffer.alloc(f.bytes.length));
  await assert.rejects(f.controller.apply({restart:true}),/更新包已变化/);assert.deepEqual(f.actions,[]);
});
test('download metadata without a digest never starts a download or stop',async t=>{
  const f=await fixture(t);await assert.rejects(f.controller.stage({...f.release,sha256:''}),/SHA-256/);assert.deepEqual(f.actions,[]);
});
test('changing Being during download discards the staged activation request',async t=>{
  const f=await fixture(t);const make=f.controller.createInstaller;
  f.controller.createInstaller=release=>{const i=make(release),install=i.install.bind(i);i.install=async options=>{const r=await install(options);f.context('two');return r;};return i;};
  await assert.rejects(f.controller.stage(f.release),/Being 连接已变化/);assert.deepEqual(f.actions,[]);
});
test('an interrupted replacement recovers from a durable transaction rather than retrying the update',async t=>{
  const f=await fixture(t);await f.controller.stage(f.release);
  const pending=f.controller._pending,id=require('node:crypto').randomUUID(),directory=path.join(f.controller.directory,id);
  await fs.mkdir(directory);const backup=path.join(directory,'heart-portal');await fs.copyFile(f.original,backup);
  const previous=await f.adapter.state();await f.adapter.stop();await f.adapter.activate(pending.candidate);
  await durableJson(f.controller.journalFile,{id,directory,backup,plistBackup:'',phase:'replacing',previous,pending,context:'one'});
  f.actions.length=0;await f.controller.run(()=>f.controller.recover());
  assert.deepEqual(f.actions,['stop','restore','start']);assert.equal((await f.adapter.state()).executable,f.original);
});
test('corrupted backup leaves a recovery record instead of overwriting the original selection',async t=>{
  const f=await fixture(t,{verify:async()=>({passed:false})});await f.controller.stage(f.release);
  const start=f.adapter.start;f.adapter.start=async()=>{
    const tx=JSON.parse(await fs.readFile(f.controller.journalFile,'utf8'));await fs.writeFile(tx.backup,'tampered');await start();
  };
  await assert.rejects(f.controller.apply({restart:true}),/恢复尚未确认/);
  assert.equal(f.controller.state().phase,'recovery_required');assert.ok(await fs.stat(f.controller.journalFile));
});
