'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {spawn} = require('node:child_process');
const crypto = require('node:crypto');
const {GroveInstaller,REVIEWED_RECIPES,reviewedRecipe,parseTarArchive,probeMcp,createCodexMcpShim} = require('../src/grove-installer.cjs');

// Public, reviewed codex-win 1.0.0 archive. Keeping the exact bytes makes these tests offline.
const BUNDLE = Buffer.from('H4sIAAAAAAAA/+1U204bMRDNc75itE8gZZNdrlIrUBGiVVRuKpWqCiEwuxMweO2t7eUihNSP6Bf2Szq2N7AJobSiVK2UechGx56Lz5yZgkk+QGO7Z0bJ1stYkibJ0sJCKwk2/p1fXEha6eLcQrq8mMyl7l6aLqdpK2n9BauMZRqg9Vwbf9x/YjdtgEiyAqNXEGUqx6v4ksuo4+AL1IYr6U7SbtJNApqjyTQvbX2y7nxga30X9lCTB3z/+g0yrYyJS8HsQOkCZj5xmatL0ytYtrPX2+SyuprtwlulzzGHgVYFUMRSYM9X0IUPlYRBJQSE6AaNK8R04FhTGOwAXmFWWQR3vwMaGYXhAk031Gg1k6ZU2roKjc25CjiyE9SEWV2hBzJVFEzmBO2H10cdiIqsjI1/THTgb5VaXfCaCkcYQbqSlnvWAtBgUVIcn86jDRJXV9KlyOO34TgaMmR8ATnTnnuI6DM/5/4IR1WowlNf+pt17GHmRu7A1/pm/64Ax8Z1GdoreBMea+ROiXKtD3cRYEaWxaxvpz31THN5AkSgtAQwC0SBAaEyJsR1M67GLxXXmDd4rk+4pGET4vCUS98ZSgA1BvEJvFFUAuNBBAAzdSAD2wTQgoLVFUiXXoNzY5VV1CSBmTXg6eoF+nqeMjjmkunr2ahOfuu/Qx5RXvycxp3dje21/uHabv/w/cbnp0mji3CO10C9rAks6FcAyzKSLswQTGzBUXiZUCdcHoGSGQYPYvPd7kf3ptPZR5gcMGFw9DHtWkeRVUrc6+KBHmtdtye/YI/WnwUGEi9Hp+3eo2SaeYnePNSUOj6jFjSLpmEpUVuOox7hpCjtGNqIZawmiTViTaq3L7nlTEBFEwp1xIbDbdM78l14ZsIt30lFc6w5DfajuQztkWN19bvZUFaFn363xGIl3SzRAqDVaEqWYXypuUUH5UzS8ordWoyDrqKDZjHtCWU1FbQ/5P9gREb17cmqiTWWjeF+uPtpCcoKaR1zY916yJR0C4/ZFxGQPXUk9fMnOX60Sb8owT/Ba9uN6G1ralOb2tT+UfsB7bXdKAAOAAA=','base64');
const ASYNC_BUNDLE = Buffer.from('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','base64');
const PYTHON_BUNDLE = Buffer.from('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','base64');
const ID = 'TAYvq0_YCoEKQqV4PjzGp';
const RECIPE = REVIEWED_RECIPES[ID];

function rawDetail(id = ID,bundle = BUNDLE) {
  const recipe = REVIEWED_RECIPES[id];
  return {id,name:recipe.name,version:recipe.version,description:'Reviewed public tool package',being_id:'hex',display_name:'Hex',status:'sprouting',has_bundle:true,schema_complete:true,bundle_hash:recipe.hash,bundle_size:recipe.size,download_url:`https://beings.town/api/grove/${id}/download`,manifest:JSON.parse(parseTarArchive(bundle).get('manifest.json').toString()),setup_guide:{steps:[],deps:[],env_template:{}}};
}

async function fixture(t,overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'being-grove-test-'));
  t.after(async()=>{if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('being-grove-test-')) await fs.rm(root,{recursive:true,force:true});});
  const kitsDir = path.join(root,'kits');
  await fs.mkdir(kitsDir);
  const nodePath = path.join(root,'node.exe'),appData = path.join(root,'appdata');
  const codexPath = path.join(appData,'npm','node_modules','@openai','codex','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe');
  await fs.mkdir(path.dirname(codexPath),{recursive:true});
  await fs.writeFile(nodePath,'fake node'); await fs.writeFile(codexPath,'fake codex');
  const calls = [],probes = [];
  const archive = overrides.fixtureBundle || BUNDLE;
  let detail = rawDetail(overrides.recipeId || ID,archive);
  const fetchImpl = async(url,options)=>{
    assert.equal(options.redirect,'error'); assert.equal(options.credentials,'omit');
    assert.match(url,/^https:\/\/beings\.town\/api\/grove\//);
    if (url.endsWith('/download')) return new Response(overrides.bundle || archive,{headers:{'Content-Type':'application/gzip'}});
    return new Response(JSON.stringify(detail),{headers:{'Content-Type':'application/json'}});
  };
  const runCommand = async(file,args)=>{
    calls.push({file,args});
    if (args[0] === 'login') return {code:0,stdout:'',stderr:'Logged in using ChatGPT'};
    return {code:0,stdout:file === nodePath ? 'v24.13.1' : 'codex-cli 0.144.4',stderr:''};
  };
  const engine = new GroveInstaller({kitsDir,nodePath,codexPath,platform:'win32',arch:'x64',env:{PATH:root,APPDATA:appData},fetchImpl,runCommand,probeMcp:async(command,options)=>{
    probes.push({command,options});
    assert.ok(options.expectedTools.includes('codex'));
    return {verified:true};
  },...overrides});
  return {engine,root,kitsDir,nodePath,codexPath,calls,probes,setDetail:value=>{detail=value;}};
}

function tar(items) {
  const chunks = [];
  for (const {name,type = '0',body = 'hello'} of items) {
    const bytes = Buffer.from(body),header = Buffer.alloc(512);
    header.write(name,0,100); header.write('0000600\0',100); header.write('0000000\0',108); header.write('0000000\0',116);
    header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124); header.write('00000000000\0',136); header.fill(32,148,156); header.write(type,156); header.write('ustar\0',257);
    header.write(header.reduce((sum,value)=>sum+value,0).toString(8).padStart(6,'0')+'\0 ',148);
    chunks.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));
  }
  return zlib.gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));
}

test('reviewed recipes require the exact public identity, version, hash and size',()=>{
  const detail = rawDetail();
  assert.equal(reviewedRecipe(detail),RECIPE);
  for (const patch of [{id:'other'},{name:'other'},{version:'1.0.1'},{bundle_hash:'a'.repeat(64)},{bundle_size:804}]) assert.equal(reviewedRecipe({...detail,...patch}),null);
});

test('tar parsing rejects unsafe paths, links, duplicate Windows names and corrupt headers',()=>{
  for (const name of ['../escape','/absolute','C:/drive','safe:stream','safe\\escape','a/../b','CON','nul.txt','a.','a ']) assert.throws(()=>parseTarArchive(tar([{name}])),/路径/);
  for (const type of ['1','2','5','x']) assert.throws(()=>parseTarArchive(tar([{name:'safe',type}])),/归档项目/);
  assert.throws(()=>parseTarArchive(tar([{name:'File'},{name:'file'}])),/重复/);
  const corrupt = zlib.gunzipSync(tar([{name:'safe'}])); corrupt[101] ^= 1;
  assert.throws(()=>parseTarArchive(zlib.gzipSync(corrupt)),/校验/);
  assert.throws(()=>parseTarArchive(zlib.gzipSync(Buffer.alloc(2*1024*1024+512))),/有界/);
});

test('prepare checks the archive and runtime without creating an install or starting MCP',async t=>{
  const f = await fixture(t);
  const result = await f.engine.prepare(ID);
  assert.equal(result.status,'ready'); assert.equal(result.assessment.installable,true); assert.equal(result.loaded,false);
  assert.equal(f.probes.length,0); assert.deepEqual(await fs.readdir(f.kitsDir),[]);
  assert.deepEqual(f.calls.map(call=>call.args),[['--version'],['--version'],['login','status']]);
});

test('install probes outside the live kits directory, preserves original manifest and is idempotent',async t=>{
  const f = await fixture(t);
  const installed = await f.engine.install(ID);
  assert.equal(installed.status,'installed'); assert.equal(installed.loaded,false); assert.equal(installed.assessment.localMcpRegistered,true);
  assert.equal(path.dirname(f.probes[0].options.cwd),f.root); assert.notEqual(f.probes[0].options.cwd,installed.installPath);
  const manifest = JSON.parse(await fs.readFile(path.join(installed.installPath,'manifest.json'),'utf8'));
  assert.deepEqual(manifest.command,[f.nodePath,path.join(installed.installPath,'desktop-mcp-shim.cjs')]);
  assert.deepEqual(manifest.tools.map(tool=>tool.name),['codex','codex_reply']);
  const original = JSON.parse(await fs.readFile(path.join(installed.installPath,'manifest.grove-original.json'),'utf8'));
  assert.deepEqual(original.command,['codex','mcp-server']);
  const receipt = JSON.parse(await fs.readFile(installed.receiptPath,'utf8'));
  assert.equal(receipt.recipeVersion,2); assert.equal(receipt.mcpVerified,true);
  const prepared = await f.engine.prepare(ID);
  assert.equal(prepared.status,'installed'); assert.equal(prepared.assessment.localInstalled,true);
  const again = await f.engine.install(ID);
  assert.equal(again.status,'installed'); assert.equal(again.alreadyInstalled,true);
  assert.equal((await f.engine.verifyInstalledRoot()).verified,true);
});

test('modified files and unrelated user directories are retained and blocked',async t=>{
  const f = await fixture(t);
  const target = path.join(f.kitsDir,RECIPE.name);
  await fs.mkdir(target); await fs.writeFile(path.join(target,'notes.txt'),'user data');
  assert.equal((await f.engine.install(ID)).status,'failed');
  assert.equal(await fs.readFile(path.join(target,'notes.txt'),'utf8'),'user data');
  assert.equal(f.probes.length,0);
  assert.equal((await f.engine.verifyInstalledRoot()).verified,false);
});

test('receipt verification refuses modified installed manifest before activation',async t=>{
  const f = await fixture(t);
  const result = await f.engine.install(ID);
  await fs.appendFile(path.join(result.installPath,'manifest.json'),' ');
  assert.equal((await f.engine.prepare(ID)).status,'needs_being');
  assert.equal((await f.engine.verifyInstalledRoot()).verified,false);
  assert.equal((await f.engine.install(ID)).status,'failed');
});

test('a failed MCP probe never exposes an install in the live kits root',async t=>{
  const f = await fixture(t,{probeMcp:async()=>{throw new Error('Kit MCP failure');}});
  const result = await f.engine.install(ID);
  assert.equal(result.status,'failed'); assert.equal(result.loaded,false);
  assert.deepEqual(await fs.readdir(f.kitsDir),[]);
  assert.ok((await fs.readdir(f.root)).every(name=>!name.startsWith('.being-kit-install-')));
});

test('a changed release or corrupt bundle requires reassessment without launching programs',async t=>{
  const f = await fixture(t);
  f.setDetail({...rawDetail(),version:'2.0.0'});
  assert.equal((await f.engine.install(ID)).status,'needs_being'); assert.equal(f.calls.length,0);
  const corrupt = Buffer.from(BUNDLE); corrupt[50] ^= 1;
  const g = await fixture(t,{bundle:corrupt});
  assert.equal((await g.engine.install(ID)).status,'needs_being'); assert.equal(g.calls.length,0);
});

test('missing login and unsupported platforms prevent installation',async t=>{
  const f = await fixture(t,{runCommand:async(file,args)=>args[0] === 'login' ? {code:1,stdout:'',stderr:'Not logged in'} : {code:0,stdout:file.endsWith('node.exe')?'v24.13.1':'codex-cli 0.144.4',stderr:''}});
  assert.equal((await f.engine.prepare(ID)).status,'needs_being'); assert.equal(f.probes.length,0);
  const g = await fixture(t,{platform:'linux'});
  assert.equal((await g.engine.prepare(ID)).status,'needs_being'); assert.equal(g.calls.length,0);
});

test('nonreviewed and incomplete workflow kits return Being assistance reasons',async t=>{
  const f = await fixture(t);
  const detail = {...rawDetail(),id:'jM-oec68MUWwUdF8yLjO8',name:'claude-sdk'};
  f.setDetail(detail);
  const result = await f.engine.prepare(detail.id);
  assert.equal(result.status,'needs_being'); assert.match(result.assessment.reasons[0],/缺少 server.mjs/);
  assert.equal(f.calls.length,0);
});

test('root activation refuses an unrelated eager kit next to a verified install',async t=>{
  const f = await fixture(t);
  await f.engine.install(ID);
  await fs.mkdir(path.join(f.kitsDir,'unexpected'));
  await fs.writeFile(path.join(f.kitsDir,'unexpected','manifest.json'),'{"eager":true}');
  assert.equal((await f.engine.verifyInstalledRoot()).verified,false);
});

test('MCP probe sends only initialize, initialized and tools/list',async t=>{
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'being-grove-test-'));
  t.after(async()=>{if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('being-grove-test-')) await fs.rm(root,{recursive:true,force:true});});
  const script = path.join(root,'mcp.cjs'),trace = path.join(root,'trace.jsonl');
  await fs.writeFile(script,`const fs=require('fs'),readline=require('readline');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(m)+'\\n');if(m.id===1)console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}}}}));if(m.id===2)console.log(JSON.stringify({jsonrpc:'2.0',id:2,result:{tools:[{name:'health',inputSchema:{type:'object'}}]}}));});`);
  const result = await probeMcp([process.execPath,script],{cwd:root,env:process.env,expectedTools:['health']});
  assert.equal(result.verified,true);
  const messages = (await fs.readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(messages.map(message=>message.method),['initialize','notifications/initialized','tools/list']);
});

test('Codex Async adapter starts the reviewed server without Portal env support or model tasks',async t=>{
  const id = 'OteJGwtOzLqL7jmyZ2PfM';
  let launcher = '';
  const f = await fixture(t,{recipeId:id,fixtureBundle:ASYNC_BUNDLE,probeMcp:async(command,options)=>{
    launcher = await fs.readFile(command[1],'utf8');
    assert.match(launcher,/CODEX_ASYNC_KIT_HOME = dirname/);
    assert.match(launcher,/delete process.env\[key\]/);
    assert.match(launcher,/startServer\(\)/);
    return probeMcp([process.execPath,command[1]],options);
  }});
  assert.equal((await f.engine.prepare(id)).status,'ready');
  const installed = await f.engine.install(id);
  assert.equal(installed.status,'installed');
  const manifest = JSON.parse(await fs.readFile(path.join(installed.installPath,'manifest.json'),'utf8'));
  assert.equal(manifest.command[1],path.join(installed.installPath,'desktop-launcher.mjs'));
  assert.equal(manifest.env,undefined);
  assert.match(launcher,/BEINGS_TOWN_GROVE_TOKEN/);
  assert.match(launcher,/CODEX_ASYNC_LOOM_URL/);
  assert.equal((await f.engine.prepare(id)).assessment.localInstalled,true);
});

test('Python recipe maps complete schemas and verifies Python independently from Codex login',async t=>{
  const id = 'MMfnXR7ZlRrN5n94vJIFz';
  const invoked = [];
  let stagedManifest;
  const f = await fixture(t,{recipeId:id,fixtureBundle:PYTHON_BUNDLE,runCommand:async(file,args)=>{
    invoked.push(args);
    return {code:0,stdout:'Python 3.12.10',stderr:''};
  },probeMcp:async(command,options)=>{
    assert.equal(command[1],'-B');
    stagedManifest = JSON.parse(await fs.readFile(path.join(options.cwd,'manifest.json'),'utf8'));
    return {verified:true};
  }});
  f.engine.pythonPath = f.nodePath;
  const result = await f.engine.install(id);
  assert.equal(result.status,'installed');
  assert.deepEqual(invoked,[['--version']]);
  assert.equal(result.assessment.runtime.name,'python');
  assert.equal(stagedManifest.tools.length,5);
  for (const tool of stagedManifest.tools) assert.deepEqual(tool.params,tool.inputSchema);
  assert.equal(stagedManifest.command[2],path.join(result.installPath,'grove_publish_mcp.py'));
});

test('only codex-win changes recipe version and old receipts are preserved without overwrite',async t=>{
  assert.equal(REVIEWED_RECIPES[ID].recipeVersion,2);
  assert.equal(REVIEWED_RECIPES.OteJGwtOzLqL7jmyZ2PfM.recipeVersion || 1,1);
  assert.equal(REVIEWED_RECIPES.MMfnXR7ZlRrN5n94vJIFz.recipeVersion || 1,1);
  const f = await fixture(t);
  const installed = await f.engine.install(ID);
  const receipt = JSON.parse(await fs.readFile(installed.receiptPath,'utf8'));
  receipt.recipeVersion = 1;
  const previous = JSON.stringify(receipt);
  await fs.writeFile(installed.receiptPath,previous);
  assert.equal((await f.engine.install(ID)).status,'failed');
  assert.equal(await fs.readFile(installed.receiptPath,'utf8'),previous);
});

test('Codex shim exposes codex_reply and translates calls using a synthetic offline upstream',async t=>{
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'being-grove-test-'));
  t.after(async()=>{if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('being-grove-test-')) await fs.rm(root,{recursive:true,force:true});});
  const upstream = path.join(root,'upstream.cjs'),shim = path.join(root,'shim.cjs');
  await fs.writeFile(upstream,`require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);let result;if(m.method==='tools/list')result={tools:[{name:'codex',inputSchema:{type:'object'}},{name:'codex-reply',inputSchema:{type:'object'}}]};else result={method:m.method,params:m.params};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`);
  await fs.writeFile(shim,createCodexMcpShim([process.execPath,upstream]));
  const child = spawn(process.execPath,[shim],{cwd:root,env:process.env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const answers = [];
  const completed = new Promise((resolve,reject)=>{
    let output = '',stderr = '';
    const timer = setTimeout(()=>{child.kill();reject(new Error('Synthetic shim did not close'));},10000);
    child.on('error',reject);
    child.stderr.on('data',chunk=>{stderr += chunk;});
    child.stdout.on('data',chunk=>{
      output += chunk;
      let newline;
      while ((newline = output.indexOf('\n')) >= 0) {
        answers.push(JSON.parse(output.slice(0,newline))); output = output.slice(newline+1);
        if (answers.length === 4) child.stdin.end();
      }
    });
    child.on('close',code=>{clearTimeout(timer);if(code === 0) resolve();else reject(new Error(`Synthetic shim exited ${code}: ${stderr}`));});
  });
  for (const message of [
    {id:1,method:'tools/list'},
    {id:2,method:'tools/call',params:{name:'codex_reply',arguments:{prompt:'fixture only'}}},
    {id:3,method:'tools/call',params:{name:'codex',arguments:{prompt:'fixture only'}}},
    {id:4,method:'ping',params:{marker:'unchanged'}},
  ]) child.stdin.write(`${JSON.stringify({jsonrpc:'2.0',...message})}\n`);
  await completed;
  assert.deepEqual(answers[0].result.tools.map(tool=>tool.name),['codex','codex_reply']);
  assert.equal(answers[1].result.params.name,'codex-reply');
  assert.equal(answers[1].result.params.arguments.prompt,'fixture only');
  assert.equal(answers[2].result.params.name,'codex');
  assert.deepEqual(answers[3].result,{method:'ping',params:{marker:'unchanged'}});
});

test('desktop PATH changes preserve both installed Codex adapters and their original receipts',async t=>{
  for (const [id,archive] of [[ID,BUNDLE],['OteJGwtOzLqL7jmyZ2PfM',ASYNC_BUNDLE]]) {
    const f = await fixture(t,{recipeId:id,fixtureBundle:archive,probeMcp:async()=>({verified:true})});
    const installed = await f.engine.install(id);
    assert.equal(installed.status,'installed');
    const originalReceipt = await fs.readFile(installed.receiptPath,'utf8');
    delete f.engine.env.PATH;
    f.engine.env.Path = 'C:\\Windows\\System32;C:\\Program Files\\nodejs';
    const prepared = await f.engine.prepare(id);
    assert.equal(prepared.status,'installed');
    assert.equal(prepared.assessment.localInstalled,true);
    assert.equal((await f.engine.verifyInstalledRoot()).verified,true);
    assert.equal((await f.engine.install(id)).alreadyInstalled,true);
    assert.equal(await fs.readFile(installed.receiptPath,'utf8'),originalReceipt);
  }
});

test('retaining PATH does not trust changed adapter code even with a matching forged receipt',async t=>{
  for (const [id,archive,name] of [[ID,BUNDLE,'desktop-mcp-shim.cjs'],['OteJGwtOzLqL7jmyZ2PfM',ASYNC_BUNDLE,'desktop-launcher.mjs']]) {
    const f = await fixture(t,{recipeId:id,fixtureBundle:archive,probeMcp:async()=>({verified:true})});
    const installed = await f.engine.install(id);
    const file = path.join(installed.installPath,name);
    const previous = await fs.readFile(file,'utf8');
    const altered = previous.replace("'node:","'unexpected:");
    assert.notEqual(altered,previous);
    await fs.writeFile(file,altered);
    const receipt = JSON.parse(await fs.readFile(installed.receiptPath,'utf8'));
    receipt.files[name] = crypto.createHash('sha256').update(altered).digest('hex');
    await fs.writeFile(installed.receiptPath,JSON.stringify(receipt));
    f.engine.env.PATH = 'C:\\Windows\\System32';
    assert.equal((await f.engine.prepare(id)).status,'needs_being');
    assert.equal((await f.engine.verifyInstalledRoot()).verified,false);
    assert.equal(await fs.readFile(file,'utf8'),altered);
  }
});
