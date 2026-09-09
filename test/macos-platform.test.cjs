'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {Readable} = require('node:stream');
const {desktopPlatform, desktopEnvironment} = require('../src/platform.cjs');
const {PortalService, PORTAL_NAME, inspectMacProcesses, parseMacProcesses} = require('../src/services.cjs');
const {portalRelease, PortalInstaller} = require('../src/portal-installer.cjs');
const {parsePortalRelease, readPortalVersion} = require('../src/portal-updates.cjs');
const {DesktopTerminal} = require('../src/desktop-terminal.cjs');
const {DesktopConsole} = require('../src/desktop-console.cjs');
const {commandForInput, createDesktopMenuTemplate} = require('../src/desktop-menu.cjs');

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'being-mac-test-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  return root;
}
async function until(predicate) {
  for (let i = 0; i < 150; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve,20)); }
  throw new Error('Expected local process state was not reached');
}

test('Finder environment finds Homebrew without evaluating a shell or adding relative PATH entries', () => {
  const source = {HOME:'/Users/fixture', PATH:'.:/custom/bin::relative:/custom/bin', BEING_TOKEN:'private'};
  const env = desktopEnvironment(source,'darwin');
  assert.equal(env.PATH.split(':')[0],'/custom/bin');
  for (const dir of ['/opt/homebrew/bin','/usr/local/bin','/Users/fixture/.local/bin','/bin']) assert.ok(env.PATH.split(':').includes(dir));
  assert.equal(env.PATH.split(':').filter(dir=>dir==='/custom/bin').length,1);
  assert.ok(env.PATH.split(':').every(dir=>path.posix.isAbsolute(dir)));
  assert.equal(source.PATH,'.:/custom/bin::relative:/custom/bin');
  assert.equal(desktopPlatform('darwin','arm64').shell,'zsh');
  assert.equal(desktopPlatform('darwin','x64').portalSupported,true);
  assert.equal(desktopPlatform('linux','x64').portalSupported,false);
});

test('Mac process inspection reads executable names only, including paths with spaces', async () => {
  const calls=[];
  const processes=await inspectMacProcesses(async(...args)=>{calls.push(args);return {stdout:' 123 /Users/a b/.heart-portal/heart-portal\n 124 /tmp/heart-portal-macos-arm64\n 125 /bin/zsh\n'};});
  assert.equal(calls[0][0],'/bin/ps');
  assert.deepEqual(calls[0][1],['-axo','pid=,comm=']);
  assert.equal(calls[0][2].shell,false);
  assert.ok(calls[0][2].timeout > 0);
  assert.equal(processes[0].executable,'/Users/a b/.heart-portal/heart-portal');
  assert.ok(PORTAL_NAME.test(processes[1].name));
  assert.equal(PORTAL_NAME.test('heart-portal-macos-arm64.evil'),false);
  assert.throws(()=>parseMacProcesses('invalid process output'));
  assert.throws(()=>parseMacProcesses(''));
});

test('existing Mac Portal is external, is never spawned or stopped, and a failed inspection fails closed', async () => {
  let failed=false,spawns=0;
  const portal=new PortalService({platform:'darwin',spawnImpl:()=>{spawns++;},inspectProcesses:async()=>{
    if(failed)throw new Error('permission denied');
    return [{pid:123,name:'heart-portal',executable:'/Users/fixture/.heart-portal/heart-portal'}];
  }});
  assert.equal((await portal.inspect()).status,'external');
  assert.equal(portal.state.owned,false);
  await portal.stop();
  assert.equal(portal.state.status,'external');
  assert.equal(spawns,0);
  failed=true;
  assert.equal((await portal.inspect()).status,'error');
  assert.equal(portal.state.pid,null);
});

for(const arch of ['arm64','x64']) test(`Mac ${arch} installer selects pinned bytes, publishes executable permissions and detects permission damage`, {skip:process.platform==='win32'}, async t => {
  const root=await temporary(t),release=portalRelease('darwin',arch),events=[];
  assert.ok(release.url.endsWith(arch==='arm64'?'heart-portal-macos-arm64':'heart-portal-macos-x86_64'));
  assert.notEqual(release.sha256,portalRelease('win32','x64').sha256);
  const installer=new PortalInstaller({userDataDir:root,platform:'darwin',arch,
    requestImpl:(url,options,callback)=>{
      assert.equal(url.href,release.url);
      const request=new EventEmitter();
      request.end=()=>queueMicrotask(()=>{const response=Readable.from([Buffer.alloc(release.size)]);response.statusCode=200;response.headers={};callback(response);});
      return request;
    },
    createHashImpl:()=>({update(){},digest(){return release.sha256;}}),
  });
  const result=await installer.install({onProgress:event=>events.push(event)});
  assert.equal(result.verified,true);
  assert.equal(path.basename(result.executable),'heart-portal');
  assert.ok(result.executable.includes(`darwin-${arch}`));
  if (process.platform !== 'win32') assert.equal((await fs.stat(result.executable)).mode & 0o777,0o700);
  assert.ok(events.every(event=>event.totalBytes===release.size));
  assert.equal((await installer.inspect()).verified,true);
  if (process.platform !== 'win32') {
    await fs.chmod(result.executable,0o600);
    assert.equal((await installer.inspect()).verified,false);
  }
});

test('Mac installer rejects a Windows payload even when the size matches the expected Mac asset', async t => {
  const root=await temporary(t),release=portalRelease('darwin','arm64');
  const installer=new PortalInstaller({userDataDir:root,platform:'darwin',arch:'arm64',requestImpl:(_url,_options,callback)=>{
    const request=new EventEmitter();request.end=()=>queueMicrotask(()=>{const response=Readable.from([Buffer.alloc(release.size,0x4d)]);response.statusCode=200;response.headers={};callback(response);});return request;
  }});
  await assert.rejects(installer.install(),/校验失败/);
  assert.deepEqual(await fs.readdir(installer.versionDir),[]);
});

test('Mac update checks require the current architecture asset and can probe a native binary name', async () => {
  const name='heart-portal-macos-arm64';
  const release={tag_name:'v0.8.1',draft:false,prerelease:false,html_url:'https://github.com/d5z/heart-portal/releases/tag/v0.8.1',assets:[{name,state:'uploaded',size:10,browser_download_url:`https://github.com/d5z/heart-portal/releases/download/v0.8.1/${name}`}]};
  assert.equal(parsePortalRelease(release,{platform:'darwin',arch:'arm64'}).version,'0.8.1');
  assert.throws(()=>parsePortalRelease(release,{platform:'darwin',arch:'x64'}),/当前平台/);
  assert.equal(await readPortalVersion(path.resolve('heart-portal-macos-arm64'),{statImpl:async()=>({isFile:()=>true,isSymbolicLink:()=>false}),execImpl:async(file,args)=>{
    assert.deepEqual(args,['--version']);return {stdout:'heart-portal 0.8.0\n'};
  }}),'0.8.0');
});

test('Mac terminal uses zsh PTY without Windows flags or inherited credentials and never signals an exited PID', async () => {
  let exit,calls=[],kills=0;
  const handle={pid:123,onData:()=>({dispose(){}}),onExit:fn=>{exit=fn;return {dispose(){}};},kill:()=>{kills++;exit({exitCode:0});}};
  const terminal=new DesktopTerminal({platform:'darwin',getWorkspace:()=>process.cwd(),environment:{PATH:'/bin',HOME:'/Users/fixture',LANG:'en_US.UTF-8',BEING_LOOM_URL:'private',ELECTRON_RUN_AS_NODE:'1'},pty:{spawn:(...args)=>{calls.push(args);return handle;}}});
  const {sessionId}=await terminal.create();
  assert.equal(calls[0][0],'/bin/zsh');
  assert.deepEqual(calls[0][1],['-f','-i']);
  assert.equal(calls[0][2].useConpty,undefined);
  assert.equal(calls[0][2].env.BEING_LOOM_URL,undefined);
  assert.equal(calls[0][2].env.ELECTRON_RUN_AS_NODE,undefined);
  assert.equal(calls[0][2].env.LANG,'en_US.UTF-8');
  assert.equal(terminal.snapshot().sessions[0].title,'zsh');
  exit({exitCode:0});
  await terminal.close(sessionId);
  assert.equal(kills,0);
  await terminal.dispose();
});

test('Mac menu uses Command while Windows retains Control shortcuts', () => {
  const input={type:'keyDown',key:'1',meta:true};
  assert.equal(commandForInput(input,'darwin'),'chat');
  assert.equal(commandForInput(input,'win32'),null);
  assert.equal(commandForInput({...input,meta:false,control:true},'darwin'),null);
  assert.equal(commandForInput({...input,meta:false,control:true},'win32'),'chat');
  const menu=createDesktopMenuTemplate('file',{sendCommand(){},closeWindow(){}},'darwin');
  assert.equal(menu[0].accelerator,'Cmd+1');
  assert.equal(menu.at(-1).accelerator,'Cmd+W');
});

test('real Mac console preserves Unicode, working directory and exit status without inheriting app secrets', {skip:process.platform!=='darwin'}, async t => {
  const root=await temporary(t),service=new DesktopConsole({getWorkspace:()=>root,environment:{...process.env,BEING_MAC_TEST_SECRET:'must-not-inherit'}});
  t.after(()=>service.dispose());
  const {jobId}=await service.run({command:"printf '%s\\n' '中文 $HOME `literal`'; pwd; test -z \"${BEING_MAC_TEST_SECRET+x}\" || exit 99; exit 7"});
  await until(()=>!service._children.has(jobId));
  const job=service.snapshot().jobs.find(job=>job.id===jobId);
  assert.equal(job.exitCode,7);
  assert.equal(job.status,'failed');
  const output=job.output.map(item=>item.text).join('');
  assert.ok(output.includes('中文 $HOME `literal`'));
  assert.ok(output.includes(root));
});

test('real Mac console cancellation closes its process group while leaving another job alive', {skip:process.platform!=='darwin'}, async t => {
  const root=await temporary(t),service=new DesktopConsole({getWorkspace:()=>root});
  t.after(()=>service.dispose());
  const first=await service.run({command:'sleep 30 & wait'}),second=await service.run({command:'sleep 30 & wait'});
  await until(()=>service.snapshot().jobs.every(job=>job.status==='running'));
  await service.stop(first.jobId);
  assert.equal(service.snapshot().jobs.find(job=>job.id===first.jobId).status,'stopped');
  assert.equal(service.snapshot().jobs.find(job=>job.id===second.jobId).status,'running');
  await service.stop(second.jobId);
});

test('real Mac console reaps ordinary background descendants after the shell exits', {skip:process.platform!=='darwin'}, async t => {
  const root=await temporary(t),service=new DesktopConsole({getWorkspace:()=>root});
  t.after(()=>service.dispose());
  const {jobId}=await service.run({command:'sleep 30 & exit 0'});
  await until(()=>!service._children.has(jobId));
  assert.equal(service.snapshot().jobs.find(job=>job.id===jobId).status,'completed');
});
