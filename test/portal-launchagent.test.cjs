'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {discoverLaunchAgent,launchBinding}=require('../src/portal-launchagent.cjs');

async function fixture(t) {
  const home=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'portal-launchagent-test-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const root=path.join(home,'.heart-portal'),agents=path.join(home,'Library','LaunchAgents');
  await fs.mkdir(root,{recursive:true});await fs.mkdir(agents,{recursive:true});
  const executable=path.join(root,'heart-portal'),configPath=path.join(root,'portal.toml'),wrapper=path.join(root,'auto-connect.zsh');
  await fs.writeFile(executable,'old');await fs.writeFile(configPath,'name = "fixture"');
  await fs.writeFile(wrapper,`#!/bin/zsh\nportal_binary='${executable}'\nportal_config='${configPath}'\nexec "$portal_binary" --config "$portal_config"\n`);
  const definition={Label:'town.beings.heart-portal',ProgramArguments:[wrapper],EnvironmentVariables:{PRIVATE_FIXTURE:'never-return-this'},KeepAlive:true};
  const plist=path.join(agents,definition.Label+'.plist');await fs.writeFile(plist,JSON.stringify(definition));
  let loaded=true,running=true,pid=123;
  const actions=[];
  const execImpl=async(file,args)=>{
    if(file.endsWith('plutil'))return {stdout:args.includes('-o')?await fs.readFile(args.at(-1),'utf8'):''};
    assert.equal(file,'/bin/launchctl');actions.push(args);
    if(args[0]==='print') {if(!loaded)throw Object.assign(new Error('private fixture error'),{code:113});return {stdout:`service {\n pid = ${running?pid:0}\n PRIVATE_FIXTURE=never-return-this\n}`};}
    if(args[0]==='bootout'){loaded=false;running=false;}
    else if(args[0]==='bootstrap'){loaded=true;running=true;}
    return {stdout:''};
  };
  const options={home,executable,configPath,execImpl,uid:501,inspectProcesses:async()=>running?[{pid,name:'heart-portal',executable}]:[]};
  return {home,root,plist,wrapper,definition,options,actions,unrelatedPid:()=>{pid=456;options.inspectProcesses=async()=>[{pid:123,name:'heart-portal',executable}];}};
}
test('recognized legacy Keychain launcher is controlled through its original service, without exposing plist environment',async t=>{
  const f=await fixture(t),adapter=await discoverLaunchAgent(f.options);assert.ok(adapter);
  const state=await adapter.state();assert.equal(state.pid,123);assert.doesNotMatch(JSON.stringify(state),/PRIVATE_FIXTURE|never-return-this|ProgramArguments/);
  await adapter.stop();assert.equal((await adapter.state()).running,false);await adapter.start();assert.equal((await adapter.state()).running,true);
  assert.ok(f.actions.some(args=>args[0]==='bootout'&&args[1]==='gui/501/town.beings.heart-portal'));
  assert.ok(f.actions.some(args=>args[0]==='bootstrap'&&args[2]===f.plist));
});
test('service PID mismatch prevents adopting or stopping an unrelated process',async t=>{
  const f=await fixture(t);f.unrelatedPid();assert.equal(await discoverLaunchAgent(f.options),null);
  assert.ok(f.actions.every(args=>args[0]==='print'));
});
test('changing the saved launcher invalidates an already discovered adapter',async t=>{
  const f=await fixture(t),adapter=await discoverLaunchAgent(f.options);await fs.appendFile(f.wrapper,'# changed\n');
  await assert.rejects(adapter.stop(),/启动方式已变化/);assert.ok(f.actions.every(args=>args[0]==='print'));
});
test('unknown arbitrary scripts remain observable but cannot be controlled',async t=>{
  const f=await fixture(t);await fs.writeFile(f.wrapper,'#!/bin/zsh\nrun-something-else\n');
  assert.equal(await discoverLaunchAgent(f.options),null);
  const interpreter=path.join(f.home,'env');await fs.writeFile(interpreter,'unrecognized interpreter fixture');
  assert.equal(await launchBinding({ProgramArguments:[interpreter,'heart-portal']}),null);
});
test('supervision marker preserves every existing plist field and can be rolled back byte for byte',async t=>{
  const f=await fixture(t),adapter=await discoverLaunchAgent(f.options);const before=await fs.readFile(f.plist);
  const backup=path.join(f.root,'backup.plist');await fs.writeFile(backup,before);
  await adapter.stop();await adapter.prepareSupervision();
  const after=JSON.parse(await fs.readFile(f.plist,'utf8'));
  assert.deepEqual(after,{...f.definition,EnvironmentVariables:{...f.definition.EnvironmentVariables,HEART_PORTAL_SUPERVISED:'1'}});
  await adapter.restorePlist(backup);assert.deepEqual(await fs.readFile(f.plist),before);
});
test('old log handshakes cannot certify a replacement process',async t=>{
  const f=await fixture(t),adapter=await discoverLaunchAgent(f.options),log=path.join(f.root,'runtime.log');
  adapter.descriptor.logPath=log;
  await fs.writeFile(log,'Portal tools: portal_status\nPortal relay handshake OK — starting MCP server on WebSocket bridge\n');
  const marker=await adapter.mark();assert.deepEqual(await adapter.health(marker),{connected:false,tools:false});
  await fs.appendFile(log,'Portal tools: portal_status, portal_kits_reload\nPortal relay handshake OK — starting MCP server on WebSocket bridge\n');
  assert.deepEqual(await adapter.health(marker),{connected:true,tools:true});
});

test('in-place upgrade refuses an executable outside the official runtime before stopping anything',async t=>{
  const f=await fixture(t),adapter=await discoverLaunchAgent(f.options);await adapter.prepareUpdate();
  const outside=path.join(f.home,'heart-portal');await fs.writeFile(outside,'old');adapter.descriptor.executable=outside;
  await assert.rejects(adapter.prepareUpdate(),/官方运行目录之外/);assert.ok(f.actions.every(args=>args[0]==='print'));
});
