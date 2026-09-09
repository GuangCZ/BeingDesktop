'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {launchAgent,agentEnvironment}=require('../src/agent-process.cjs');

test('workers preserve local CLI authentication and proxy routing without Desktop credentials or code injection',()=>{
  assert.deepEqual(agentEnvironment({PATH:'fixture',HTTPS_PROXY:'http://127.0.0.1:7890',http_proxy:'http://127.0.0.1:7890',NO_PROXY:'localhost',ALL_PROXY:'socks5://127.0.0.1:7890',CODEX_HOME:'fixture-profile',OPENAI_API_KEY:'private',NODE_OPTIONS:'private',ELECTRON_RUN_AS_NODE:'1',https_proxy:'invalid\0value'}),
    {PATH:'fixture',HTTPS_PROXY:'http://127.0.0.1:7890',http_proxy:'http://127.0.0.1:7890',NO_PROXY:'localhost',ALL_PROXY:'socks5://127.0.0.1:7890',CODEX_HOME:'fixture-profile',OPENAI_API_KEY:'private'});
});

test('native worker transport preserves prompt text as data without shell evaluation',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'being-agent-transport-'));
  t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());await fs.rm(directory,{recursive:true,force:true});});
  const file=path.join(directory,'echo-input.cjs');
  await fs.writeFile(file,"process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({text})));\n");
  const input='中文需求\n"quoted" \'single\' `backtick`\n$(throw "must not run") & echo unsafe\n';
  let output='',errors='';
  const child=launchAgent({file:process.execPath,args:[file],input,cwd:directory,onData:(stream,text)=>{if(stream==='stdout')output+=text;else errors+=text;}});
  const result=await child.done;assert.equal(result.code,0,errors);
  assert.equal(JSON.parse(output.trim()).text.replaceAll('\r\n','\n').trimEnd(),input.trimEnd());
});

test('each Desktop passes only its own CLI environment through the real child transport', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'desktop-local-environment-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const probe=path.join(dir,'probe.cjs');
  await fs.writeFile(probe, `process.stdout.write(JSON.stringify({key:process.env.OPENAI_API_KEY,url:process.env.OPENAI_BASE_URL,home:process.env.CODEX_HOME,proxy:process.env.HTTPS_PROXY,ca:process.env.NODE_EXTRA_CA_CERTS,being:process.env.BEING_LOOM_URL,node:process.env.NODE_OPTIONS}));`);
  for(const name of ['desktop-a','desktop-b']) {
    let output='';
    const source={...process.env,OPENAI_API_KEY:'synthetic-'+name,OPENAI_BASE_URL:'http://127.0.0.1/'+name,CODEX_HOME:path.join(dir,name),HTTPS_PROXY:'http://127.0.0.1:1234',BEING_LOOM_URL:'synthetic-private',NODE_OPTIONS:'--this-must-not-reach-node'};
    delete source.NODE_EXTRA_CA_CERTS;
    const child=launchAgent({file:process.execPath,args:[probe],cwd:dir,environment:source,onData:(stream,text)=>{if(stream==='stdout')output+=text;}});
    assert.equal((await child.done).code,0);
    assert.deepEqual(JSON.parse(output),{key:'synthetic-'+name,url:'http://127.0.0.1/'+name,home:path.join(dir,name),proxy:source.HTTPS_PROXY});
  }
});

test('CLI configuration directories and trusted certificates survive without disabling TLS verification',()=>{
  const actual=agentEnvironment({XDG_CONFIG_HOME:'/config',XDG_DATA_HOME:'/data',OPENAI_BASE_URL:'http://127.0.0.1/v1',CURSOR_API_KEY:'synthetic-cursor',XAI_API_KEY:'synthetic-xai',NODE_EXTRA_CA_CERTS:'/ca.pem',SSL_CERT_FILE:'/trust.pem',NODE_TLS_REJECT_UNAUTHORIZED:'0',BEING_TOKEN:'synthetic-being',AWS_SECRET_ACCESS_KEY:'unrelated'});
  assert.deepEqual(actual,{XDG_CONFIG_HOME:'/config',XDG_DATA_HOME:'/data',OPENAI_BASE_URL:'http://127.0.0.1/v1',CURSOR_API_KEY:'synthetic-cursor',XAI_API_KEY:'synthetic-xai',NODE_EXTRA_CA_CERTS:'/ca.pem',SSL_CERT_FILE:'/trust.pem'});
});
