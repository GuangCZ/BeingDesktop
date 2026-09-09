'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {desktopEnvironment} = require('./platform.cjs');
const {launchAgent} = require('./agent-process.cjs');

const AGENTS = Object.freeze([
  {id:'codex',name:'Codex CLI',commands:['codex'],help:['exec','--help'],features:['--json','--sandbox','--skip-git-repo-check'],args:['exec','--json','--sandbox','workspace-write','--skip-git-repo-check','--color','never','-']},
  {id:'cursor',name:'Cursor CLI',commands:['cursor-agent','agent'],help:['--help'],features:['--output-format','--print'],args:['--print','--output-format','stream-json']},
  {id:'grok',name:'Grok Build CLI',commands:['grok'],help:['--help'],features:['--output-format','--prompt-file'],args:['--output-format','streaming-json']},
]);
async function executable(commands, override = '') {
  const dirs = [...new Set((desktopEnvironment().PATH || '').split(path.delimiter).filter(dir=>path.isAbsolute(dir)).concat([
    path.join(os.homedir(),'.local','bin'),path.join(os.homedir(),'.cargo','bin'),
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA,'npm')] : []),
  ]))];
  const candidates = override ? [override] : dirs.flatMap(dir=>commands.flatMap(name=>(process.platform==='win32'?['.exe','.cmd','.ps1']:['']).map(ext=>path.join(dir,name+ext))));
  for (const file of candidates) {
    if(!path.isAbsolute(file) || /[\0\r\n]/.test(file))continue;
    try { if((await fs.stat(file)).isFile()){await fs.access(file,process.platform==='win32'?fs.constants.F_OK:fs.constants.X_OK);return file;} } catch {}
  }
  return '';
}
async function probe(file,args,launch=launchAgent) {
  let output = '', overflow = false;
  const child = launch({file,args,cwd:os.homedir(),onData:(_stream,text)=>{if(output.length+text.length>65536)overflow=true;output=(output+text).slice(0,65536);}});
  // Local capability probes are bounded; executing workers have no deadline.
  const timer = setTimeout(()=>{void child.stop().catch(()=>{});},15000);
  try { const result=await child.done;return {...result,output,overflow}; }
  finally { clearTimeout(timer); }
}
async function detectAgents(paths = {}, {find=executable,run=probe} = {}) {
  return Promise.all(AGENTS.map(async agent=>{
    const base={id:agent.id,name:agent.name,path:'',status:'missing',detail:'未找到可执行程序。',auth:'unknown'};
    try {
      const file=await find(agent.commands,paths[agent.id] || '');
      if(!file)return base;
      base.path=file;
      const help=await run(file,agent.help);
      if(help.code!==0 || help.overflow || !agent.features.every(flag=>help.output.includes(flag)))return {...base,status:'incompatible',detail:'程序无法运行或不支持所需的事件输出接口。'};
      if(agent.id==='codex') {
        const auth=await run(file,['login','status']);
        if(auth.code!==0)return {...base,status:'needs_auth',auth:'required',detail:'请先在终端完成 codex login，再重新检测。'};
        return {...base,status:'ready',auth:'configured',detail:'执行接口与本机登录状态已确认。'};
      }
      return {...base,status:'ready',detail:'执行接口可用；登录状态将在执行时确认，沿用 CLI 权限配置。'};
    } catch {return {...base,status:'error',detail:'检测失败，请检查程序路径。'};}
  }));
}
function normalizeMode(value) {
  const paths={};
  for(const agent of AGENTS) if(typeof value?.paths?.[agent.id]==='string')paths[agent.id]=value.paths[agent.id].slice(0,4096);
  return {enabled:value?.enabled===true,defaultAgent:AGENTS.some(agent=>agent.id===value?.defaultAgent)?value.defaultAgent:'codex',paths};
}
module.exports={AGENTS,detectAgents,normalizeMode,executable,probe};
