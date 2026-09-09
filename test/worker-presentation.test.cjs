'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {WorkerPresentation}=require('../src/worker-presentation.cjs');

async function fixture(t){
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'being-presentation-'));
  await fs.mkdir(path.join(cwd,'game'));await fs.writeFile(path.join(cwd,'game','index.html'),'<title>Game</title><script src="app.js"></script>');
  await fs.writeFile(path.join(cwd,'game','app.js'),'window.game=true');await fs.writeFile(path.join(cwd,'game','.env'),'SECRET');await fs.writeFile(path.join(cwd,'private.json'),'SECRET');
  const tabs=[];let shown=0;
  const browser={snapshot:()=>({tabs,activeTabId:tabs.at(-1)?.id,visible:shown>0}),newTab:({url})=>{tabs.push({id:'tab-'+tabs.length,url,title:'',isLoading:true,error:''});return {activeTabId:tabs.at(-1).id};},activateTab:()=>{},reload:()=>{}};
  const presentation=new WorkerPresentation({browser,showBrowser:()=>{shown++;}}),worker={id:'worker',cwd};
  t.after(async()=>{await presentation.dispose();await fs.rm(cwd,{recursive:true,force:true});});
  return {presentation,worker,tabs,browser,shown:()=>shown,cwd};
}
function request(url,options={}){
  return new Promise((resolve,reject)=>{const req=http.get(url,options,res=>{let body='';res.on('data',data=>body+=data);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);});
}

test('Desktop serves completed static output and opens its own browser without a CLI service',async t=>{
  const f=await fixture(t),value=await f.presentation.open(f.worker,{artifactPath:'game/index.html'});
  assert.equal(f.shown(),1);assert.equal(value.state,'loading');assert.equal(f.tabs.length,1);
  assert.equal(new URL(value.url).hostname,'127.0.0.1');assert.match((await request(value.url)).body,/<title>Game<\/title>/);
  assert.equal((await request(new URL('app.js',value.url))).body,'window.game=true');
  f.tabs[0].isLoading=false;f.tabs[0].title='Game';assert.equal(f.presentation.describe(value).state,'loaded');
  const again=await f.presentation.open({...f.worker,presentation:value},{artifactPath:'game/index.html'});
  assert.equal(again.tabId,value.tabId);assert.equal(again.url,value.url);assert.equal(f.tabs.length,1);
  f.tabs[0].url='https://example.invalid/';assert.equal(f.presentation.describe(value).state,'navigated');
  f.tabs.length=0;assert.equal(f.presentation.describe(value).state,'closed');
  await f.presentation.dispose();await assert.rejects(request(value.url));
});

test('static preview rejects hidden files, traversal, cross-origin requests, methods and paths outside the artifact',async t=>{
  const f=await fixture(t),value=await f.presentation.open(f.worker,{artifactPath:'game'}),origin=new URL(value.url).origin;
  for(const relative of ['/.env','/%2e%2e%2fprivate.json','/..%5cprivate.json'])assert.equal((await request(origin+relative)).status,403);
  assert.equal((await request(origin+'/private.json')).status,404);
  assert.equal((await request(value.url,{headers:{Origin:'https://unrelated.invalid'}})).status,403);
  assert.equal((await request(value.url,{headers:{Host:'unrelated.invalid'}})).status,403);
  assert.equal((await request(value.url,{method:'POST'})).status,405);
  await assert.rejects(f.presentation.open(f.worker,{artifactPath:'../outside.html'}));
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'being-presentation-outside-'));
  t.after(()=>fs.rm(outside,{recursive:true,force:true}));await fs.writeFile(path.join(outside,'index.html'),'OUTSIDE');
  await fs.symlink(outside,path.join(f.cwd,'game','escape'),'junction');
  assert.equal((await request(origin+'/escape/index.html')).status,403);
  await assert.rejects(f.presentation.open(f.worker,{artifactPath:'game/escape/index.html'}),/工作区/);
});

test('presentation does not execute arbitrary URLs and reports browser failures honestly',async t=>{
  const f=await fixture(t);
  for(const url of ['file:///C:/x.html','javascript:alert(1)','https://user:pass@example.invalid/'])await assert.rejects(f.presentation.open(f.worker,{url}));
  await assert.rejects(f.presentation.open(f.worker,{url:'https://example.invalid',artifactPath:'game'}));
  assert.equal(f.tabs.length,0);
  const value=await f.presentation.open(f.worker,{url:'http://127.0.0.1:4178/'});
  f.tabs[0].isLoading=false;f.tabs[0].error='failed';assert.equal(f.presentation.describe(value).state,'failed');
});

test('revoked task binding cannot open a browser or retain a newly acquired preview',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.presentation.open(f.worker,{artifactPath:'game'},{current:()=>false}),/取消/);
  assert.equal(f.tabs.length,0);assert.equal(f.presentation.servers.size,0);
});

test('concurrent retries reuse one presentation and reject a conflicting target',async t=>{
  const f=await fixture(t);let finish,started;
  const showing=new Promise(resolve=>{started=resolve;});
  f.presentation.showBrowser=()=>{started();return new Promise(resolve=>{finish=resolve;});};
  const first=f.presentation.open(f.worker,{artifactPath:'game'});await showing;
  const retry=f.presentation.open(f.worker,{artifactPath:'game'});
  await assert.rejects(f.presentation.open(f.worker,{url:'http://localhost:9999'}),/另一结果/);
  finish();assert.deepEqual(await retry,await first);assert.equal(f.tabs.length,1);assert.equal(f.presentation.servers.size,1);
});

test('preparing a result leaves the conversation visible until its preview is opened',async t=>{
  const f=await fixture(t),value=await f.presentation.open(f.worker,{artifactPath:'game'},{reveal:false});
  assert.equal(f.shown(),0);assert.equal(value.visible,false);
  await f.presentation.open({...f.worker,presentation:value},{artifactPath:'game'});
  assert.equal(f.shown(),1);assert.equal(f.tabs.length,1);
});
