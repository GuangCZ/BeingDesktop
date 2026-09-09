'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {launchAgent,agentEnvironment}=require('../src/agent-process.cjs');

test('workers preserve configured CLI proxy routing without inheriting unrelated credentials or code injection variables',()=>{
  assert.deepEqual(agentEnvironment({PATH:'fixture',HTTPS_PROXY:'http://127.0.0.1:7890',http_proxy:'http://127.0.0.1:7890',NO_PROXY:'localhost',ALL_PROXY:'socks5://127.0.0.1:7890',CODEX_HOME:'fixture-profile',OPENAI_API_KEY:'private',NODE_OPTIONS:'private',ELECTRON_RUN_AS_NODE:'1',https_proxy:'invalid\0value'}),
    {PATH:'fixture',HTTPS_PROXY:'http://127.0.0.1:7890',http_proxy:'http://127.0.0.1:7890',NO_PROXY:'localhost',ALL_PROXY:'socks5://127.0.0.1:7890',CODEX_HOME:'fixture-profile'});
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
