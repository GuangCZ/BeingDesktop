'use strict';

// Opt-in acceptance against the SHA-256 pinned official binary. Only loopback
// MCP and a disposable fixture kit are used; no real Being or installed kit.
const fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{setTimeout:wait}=require('node:timers/promises');
const crypto=require('node:crypto'),assert=require('node:assert/strict');
const {portalRelease}=require('../src/portal-installer.cjs');

async function run() {
  const executable=process.argv[2];
  assert.ok(path.isAbsolute(executable),'Pass an absolute path to the official installed candidate');
  const release=portalRelease();
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(executable)).digest('hex'),release.sha256);
  const root=path.resolve(__dirname,'../.local',`portal-hot-reload-${crypto.randomUUID()}`);
  const kits=path.join(root,'kits'),kit=path.join(kits,'fixture');await fs.mkdir(kit,{recursive:true});
  const config=path.join(root,'portal.toml'),code=path.join(kit,'server.cjs'),started=path.join(root,'slow-started');
  const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  await fs.writeFile(config,`name = "desktop-hot-reload-fixture"\nbind = "127.0.0.1:${port}"\nworkspace = ${JSON.stringify(root)}\nkits_enabled = true\nkits_dir = ${JSON.stringify(kits)}\n[tools]\nexec = false\nfile = false\nscreenshot = false\nweb_fetch = false\nsearch = false\ncustom_tools_enabled = false\n`);
  const codeFor=version=>`const readline=require('node:readline');const fs=require('node:fs');const version=${JSON.stringify(version)};readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;const reply=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');if(r.method==='initialize')reply({protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1.0.0'}});else if(r.method==='tools/list')reply({tools:[{name:'ping',description:'fixture',inputSchema:{type:'object'}},{name:'slow',description:'fixture',inputSchema:{type:'object'}},{name:'added',description:'fixture',inputSchema:{type:'object'}}]});else if(r.method==='tools/call'){const result={content:[{type:'text',text:JSON.stringify({version,pid:process.pid})}]};if(r.params.name==='slow'){fs.writeFileSync(${JSON.stringify(started)},'started');setTimeout(()=>reply(result),2500);}else reply(result);}});`;
  const manifest=version=>({name:'fixture',version,command:[process.execPath,code],tools:[{name:'ping',description:'fixture ping',params:{type:'object'}},{name:'slow',description:'fixture slow',params:{type:'object'}},...(version!=='1.0.0'?[{name:'added',description:'new fixture tool',params:{type:'object'}}]:[])]});
  await fs.writeFile(code,codeFor('one'));await fs.writeFile(path.join(kit,'manifest.json'),JSON.stringify(manifest('1.0.0')));
  const token=crypto.randomBytes(32).toString('hex');
  const child=spawn(executable,['--config',config],{cwd:root,shell:false,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HEART_PORTAL_SUPERVISED:'1',PORTAL_MCP_TOKEN:token,RUST_LOG:'info',...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})}});
  let logs='',socket;const pending=new Map();let next=0,notifications=0;
  child.stdout.on('data',b=>{logs+=b;});child.stderr.on('data',b=>{logs+=b;});
  const checks=[];const check=name=>{checks.push(name);console.log(`PASS ${name}`);};
  const report={version:release.version,sha256:release.sha256,scope:'Official binary; loopback MCP; disposable fixture kit; no production Being or installed kit',checks};
  const until=async fn=>{for(let n=0;n<150;n++){if(await fn())return;await wait(100);}throw new Error('Fixture timed out');};
  try {
    await until(async()=>{
      if(child.exitCode!==null)throw new Error('Official Portal exited before the loopback listener was ready');
      return new Promise(resolve=>{const candidate=net.createConnection({host:'127.0.0.1',port});candidate.once('error',()=>{candidate.destroy();resolve(false);});candidate.once('connect',()=>{socket=candidate;resolve(true);});});
    });
    let buffer='';socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;const message=JSON.parse(line);if(message.method==='notifications/tools/list_changed')notifications++;const request=pending.get(message.id);if(request){pending.delete(message.id);clearTimeout(request.timer);message.error?request.reject(new Error('MCP fixture request failed')):request.resolve(message.result);}}});
    const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP fixture response timed out'));},15000);pending.set(id,{resolve,reject,timer});socket.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
    const tool=async(name,args={})=>{const result=await call('tools/call',{name,arguments:args});assert.notEqual(result.isError,true);return JSON.parse(result.content.find(c=>c.type==='text').text);};
    await call('auth',{token});const init=await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'desktop-fixture',version:'1'}});
    assert.equal(init.serverInfo.version,release.version);assert.equal(init.capabilities.tools.listChanged,true);check('official-binary-initializes-with-list-change-support');
    const status=await tool('portal_status');assert.equal(status.portal.version,release.version);assert.equal(status.kits.refresh_interval_seconds,5);assert.equal(status.capabilities.portal_config_hot_reload,false);check('read-only-runtime-status-confirms-version-and-capabilities');
    const first=await tool('fixture_ping');assert.equal(first.version,'one');
    const slow=tool('fixture_slow');await until(()=>fs.stat(started).then(()=>true,()=>false));
    const before=notifications;await fs.writeFile(code,codeFor('two'));
    await tool('portal_kits_reload',{kit:'fixture'});await until(()=>notifications>before);
    const second=await tool('fixture_ping');assert.equal(second.version,'two');assert.notEqual(second.pid,first.pid);
    assert.equal((await slow).version,'one');assert.equal(child.exitCode,null);check('kit-code-reload-switches-process-while-in-flight-call-finishes');
    const automatic=notifications;await fs.writeFile(code,codeFor('three'));
    const manifestPath=path.join(kit,'manifest.json');await fs.writeFile(manifestPath+'.tmp',JSON.stringify(manifest('1.1.0')));await fs.rename(manifestPath+'.tmp',manifestPath);
    await until(()=>notifications>automatic);assert.ok((await call('tools/list')).tools.some(t=>t.name==='fixture_added'));
    assert.equal((await tool('fixture_added')).version,'three');check('manifest-change-refreshes-tool-list-and-code-without-portal-restart');
    assert.equal((await tool('portal_status')).portal.pid,status.portal.pid);check('portal-process-remains-the-same-through-both-reloads');
    report.passed=true;
  } catch(error) {report.passed=false;report.error=error.message;throw error;}
  finally {
    socket?.destroy();for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('Fixture ended'));}
    if(child.exitCode===null){child.kill('SIGINT');await Promise.race([once(child,'exit'),wait(12000)]);if(child.exitCode===null)child.kill('SIGKILL');}
    // Test logs only; the child never received production connection credentials.
    await fs.writeFile(path.join(root,'runtime.log'),logs.replaceAll(token,'[fixture token]'));
    await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({passed:report.passed,checks:checks.length,report:path.join(root,'report.json')}));
  }
}
run().catch(error=>{console.error(error.message);process.exitCode=1;});
