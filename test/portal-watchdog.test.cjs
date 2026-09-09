'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {PortalWatchdog} = require('../src/portal-watchdog.cjs');

function fixture(options = {}) {
  let time = 100000;
  let starts = 0;
  let probes = 0;
  let nextPid = 100;
  const timers = new Map();
  const context = {identity:1, ready:true, blocked:false};
  const state = {status:'stopped', executable:'portal.exe', configPath:'portal.toml', owned:false, pid:null, health:'unknown'};
  const portal = {state, inspect:async()=>state};
  const watchdog = new PortalWatchdog({portal, getContext:()=>({...context}),
    startPortal:async()=>{starts++; Object.assign(state,{status:'running', owned:true, pid:nextPid++}); return state;},
    checkHealth:async()=>{probes++; return {status:'unknown', detail:'No handshake yet', checks:[]};},
    now:()=>time, setTimer:(fn, delay)=>{const id={}; timers.set(id,{fn, delay}); return id;}, clearTimer:id=>timers.delete(id),
    ...options});
  watchdog.start();
  return {watchdog, portal, state, context, timers, starts:()=>starts, probes:()=>probes,
    advance:ms=>{time+=ms;}, crash:()=>Object.assign(state,{status:'stopped', owned:false, pid:null})};
}

test('startup starts a configured Portal and schedules regular monitoring', async () => {
  const f = fixture();
  await f.watchdog.tick();
  assert.equal(f.starts(), 1);
  assert.equal(f.watchdog.state().status, 'monitoring');
  await f.watchdog.healthTask;
  assert.equal(f.probes(), 1);
  assert.equal(f.watchdog.state().health.status, 'unknown');
  assert.equal(f.timers.size, 1);
  assert.ok([...f.timers.values()][0].delay <= 5000);
});

test('existing external Portal is checked without taking ownership or duplicating it', async () => {
  const f = fixture(); Object.assign(f.state,{status:'external', pid:77});
  await f.watchdog.tick(); await f.watchdog.healthTask;
  assert.equal(f.starts(), 0); assert.equal(f.probes(), 1);
  assert.equal(f.state.owned, false);
  f.crash(); await f.watchdog.tick();
  assert.equal(f.starts(), 1);
});

test('rapid exits use exponential backoff capped at sixty seconds', async () => {
  const f = fixture();
  for (const delay of [2000,4000,8000,16000,32000,60000,60000]) {
    await f.watchdog.tick();
    const starts = f.starts();
    f.crash(); await f.watchdog.tick();
    assert.equal(f.starts(), starts);
    assert.equal(f.watchdog.state().status,'backoff');
    f.advance(delay - 1); await f.watchdog.tick();
    assert.equal(f.starts(), starts);
    f.advance(1);
  }
});

test('a stable minute resets crash backoff', async () => {
  const f = fixture();
  await f.watchdog.tick(); f.crash(); f.advance(2000); await f.watchdog.tick();
  f.advance(60000); await f.watchdog.tick();
  assert.equal(f.watchdog.state().attempts,0);
  f.crash(); await f.watchdog.tick();
  assert.equal(f.watchdog.state().attempts,1);
});

test('manual stop remains paused until explicit start even across suspend', async () => {
  const f = fixture(); await f.watchdog.tick();
  f.watchdog.pause(); f.crash(); f.advance(90000);
  await f.watchdog.tick(); assert.equal(f.starts(),1);
  f.watchdog.stop(); f.watchdog.start(); await f.watchdog.tick();
  assert.equal(f.starts(),1);
  f.watchdog.resume(); await f.watchdog.tick(); assert.equal(f.starts(),2);
});

test('missing connection or paths waits for configuration', async () => {
  const f = fixture(); f.context.ready=false;
  await f.watchdog.tick(); assert.equal(f.starts(),0);
  assert.equal(f.watchdog.state().status,'waiting');
  f.context.ready=true; f.state.configPath='';
  await f.watchdog.tick(); assert.equal(f.starts(),0);
  f.state.configPath='new.toml'; await f.watchdog.tick(); assert.equal(f.starts(),1);
});

test('unknown process inspection cannot cause a duplicate start', async () => {
  const f = fixture(); f.state.status='error';
  await f.watchdog.tick(); assert.equal(f.starts(),0);
  assert.equal(f.watchdog.state().status,'error');
});

test('blocked mutations and shutdown prevent startup', async () => {
  const f = fixture(); f.context.blocked=true;
  await f.watchdog.tick(); assert.equal(f.starts(),0);
  f.context.blocked=false; f.watchdog.stop(); await f.watchdog.tick();
  assert.equal(f.starts(),0); assert.equal(f.timers.size,0);
});

test('stop while inspection is pending prevents a late startup', async () => {
  const f = fixture(); let finish;
  f.portal.inspect=()=>new Promise(resolve=>{finish=resolve;});
  const checking=f.watchdog.tick(); await Promise.resolve(); await Promise.resolve();
  f.watchdog.stop(); finish(); await checking;
  assert.equal(f.starts(),0); assert.equal(f.timers.size,0);
});

test('concurrent wakeups share one startup operation', async () => {
  const f = fixture();
  const first=f.watchdog.tick(); assert.equal(first,f.watchdog.tick());
  f.watchdog.wake(); await first; assert.equal(f.starts(),1);
});

test('health probe runs every thirty seconds and handshake changes trigger a fresh check', async () => {
  const f=fixture(); await f.watchdog.tick(); await f.watchdog.healthTask;
  f.advance(29999); await f.watchdog.tick(); assert.equal(f.probes(),1);
  f.advance(1); await f.watchdog.tick(); await f.watchdog.healthTask; assert.equal(f.probes(),2);
  f.state.health='connected'; await f.watchdog.tick(); await f.watchdog.healthTask; assert.equal(f.probes(),3);
});

test('hanging network health checks cannot block process recovery and are cancelled', async () => {
  const signals=[];
  const f=fixture({checkHealth:signal=>{signals.push(signal); return new Promise(()=>{});}});
  await f.watchdog.tick(); assert.equal(signals.length,1);
  f.crash(); f.advance(2000); await f.watchdog.tick();
  assert.equal(f.starts(),2); assert.equal(signals[0].aborted,true);
  f.watchdog.stop(); assert.equal(signals[1].aborted,true);
});

test('previous identity health results are discarded', async () => {
  let finish;
  const f=fixture({checkHealth:()=>new Promise(resolve=>{finish=resolve;})});
  await f.watchdog.tick(); const old=f.watchdog.healthTask;
  f.context.identity++;
  finish({status:'passed',detail:'old connection'}); await old;
  assert.notEqual(f.watchdog.state().health.detail,'old connection');
});

test('failed starts retry with backoff without leaking errors', async () => {
  let calls=0;
  const f=fixture({startPortal:async()=>{calls++;throw new Error('token=private-value');}});
  await f.watchdog.tick(); assert.equal(calls,1);
  assert.equal(f.watchdog.state().status,'backoff');
  assert.ok(!JSON.stringify(f.watchdog.state()).includes('private-value'));
  await f.watchdog.tick(); assert.equal(calls,1);
  f.advance(2000); await f.watchdog.tick(); assert.equal(calls,2);
});

test('network health failure never kills or restarts a live Portal', async () => {
  const f=fixture({checkHealth:async()=>({status:'failed',detail:'runtime unreachable'})});
  await f.watchdog.tick(); await f.watchdog.healthTask;
  f.advance(60000); await f.watchdog.tick(); await f.watchdog.healthTask;
  assert.equal(f.starts(),1); assert.equal(f.watchdog.state().health.status,'failed');
});

test('real child process exit is observed and recovered without duplicate processes', async t => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const os = require('node:os');
  const {spawn} = require('node:child_process');
  const {once} = require('node:events');
  const {PortalService} = require('../src/services.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'portal-watchdog-'));
  const executable = path.join(root,'heart-portal-fixture.exe');
  const configPath = path.join(root,'portal.toml');
  await fs.writeFile(executable,'Fixture placeholder, never executed.',{mode:0o700});
  await fs.writeFile(configPath,'name = "watchdog-fixture"');
  const children = [];
  const timers = new Map();
  let clock = 100000;
  let watchdog;
  const portal = new PortalService({
    inspectProcesses:async()=>[],
    spawnImpl:()=>{
      // An isolated idle Node child exercises real process exit events without a Being.
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      children.push(child); return child;
    },
    onEvent:event=>{if(event.title==='Portal 已退出')watchdog.wake();}});
  watchdog=new PortalWatchdog({portal, startPortal:()=>portal.start({connectUrl:'http://127.0.0.1:12345/'}),
    getContext:()=>({identity:1,ready:true,blocked:false}), now:()=>clock,
    setTimer:(fn,delay)=>{const id={};timers.set(id,{fn,delay});return id;},clearTimer:id=>timers.delete(id)});
  t.after(async()=>{
    watchdog.stop(); await portal.dispose();
    assert.equal(path.dirname(root),os.tmpdir());
    assert.ok(path.basename(root).startsWith('portal-watchdog-'));
    await fs.rm(root,{recursive:true,force:true});
  });
  portal.configure({executable,configPath}); watchdog.start();
  await watchdog.tick(); assert.equal(children.length,1);
  const firstPid=portal.state.pid;
  const exited=once(children[0],'exit'); children[0].kill(); await exited;
  assert.equal(portal.state.owned,false);
  assert.equal([...timers.values()][0].delay,0);
  clock+=2000; await watchdog.tick();
  assert.equal(children.length,2); assert.notEqual(portal.state.pid,firstPid);
  assert.equal(portal.state.status,'running');
  await watchdog.tick(); assert.equal(children.length,2);
  watchdog.pause(); await portal.stop(); clock+=60000; await watchdog.tick();
  assert.equal(children.length,2); assert.equal(portal.state.owned,false);
});
