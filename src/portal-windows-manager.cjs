'use strict';

// Reuse the official Windows supervisor's saved launch, PID/start-time checks,
// stop and start commands. Never rebuild a credential-bearing command line.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {regular,hash,LaunchAgentPortal}=require('./portal-launchagent.cjs');
const {directoryChain}=require('./portal-installer.cjs');
const {readPortalVersion,compareVersions}=require('./portal-updates.cjs');
const {randomUUID}=require('node:crypto');
const execute=promisify(execFile);
const SUPPORT_FILES=Object.freeze(['portal-lifecycle.ps1','portal-supervisor.ps1','portal-supervisor-bootstrap.ps1','portal-supervisor-hidden.vbs']);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const launchHash=bytes=>hash(Buffer.from(JSON.stringify(canonical(JSON.parse(bytes)))));
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();

class WindowsPortalManager {
  constructor({descriptor,execImpl=execute,inspectProcesses}={}) {
    Object.assign(this,{descriptor,execImpl,inspectProcesses});this.kind='windows-supervisor';this.inPlace=true;
  }
  async validate() {
    const bytes=await regular(this.descriptor.launchPath);
    if(launchHash(bytes)!==this.descriptor.launchHash)throw new Error('Portal 原启动配置已变化，请重新检查。');
  }
  async command(args, executable=this.descriptor.executable) {
    const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','COMSPEC'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
    try {return await this.execImpl(executable,args,{cwd:this.descriptor.root,shell:false,windowsHide:true,timeout:120000,maxBuffer:1024*1024,env});}
    catch {throw new Error('Portal 原 Windows 守护操作未完成，请刷新状态后重试。');}
  }
  async state() {
    await this.validate();
    const {stdout}=await this.command(['status']);
    let status;try{status=JSON.parse(stdout);}catch{throw new Error('Portal Windows 状态无法确认。');}
    if(!samePath(status.root,this.descriptor.root)||typeof status.ready!=='boolean'||typeof status.supervised!=='boolean')throw new Error('Portal Windows 部署身份不匹配。');
    const processes=await this.inspectProcesses();
    const matches=processes.filter(item=>samePath(item.executable,this.descriptor.executable));
    if(matches.length>1 || matches.length===1&&(!status.ready||!status.supervised||matches[0].pid!==status.pid))throw new Error('Portal 进程与原 Windows 守护不匹配。');
    return {...this.descriptor,kind:this.kind,running:matches.length===1,pid:matches[0]?.pid||null};
  }
  async stop() {
    await this.validate();await this.command(['stop']);
    if((await this.inspectProcesses()).some(item=>samePath(item.executable,this.descriptor.executable)))throw new Error('Windows Portal 尚未退出，不能更新。');
  }
  async start() {await this.validate();await this.command([]);}
  mark() {return LaunchAgentPortal.prototype.mark.call(this);}
  health(marker) {return LaunchAgentPortal.prototype.health.call(this,marker);}
  async prepareUpdate(directory,candidate) {
    const next=path.join(directory,'native-next'),previous=path.join(directory,'native-previous');
    await fs.mkdir(next,{mode:0o700});await fs.mkdir(previous,{mode:0o700});
    await this.command(['--export-windows-runtime',next],candidate);
    const files=[];
    for(const name of SUPPORT_FILES) {
      const target=path.join(this.descriptor.root,'scripts',name),backup=path.join(previous,name),source=path.join(next,name);
      const nextHash=hash(await regular(source));let previousHash=null;
      try {const bytes=await regular(target);previousHash=hash(bytes);await fs.writeFile(backup,bytes,{flag:'wx',mode:0o600});}
      catch(error){if(error.code!=='ENOENT')throw error;}
      files.push({name,previousHash,nextHash});
    }
    return files;
  }
  async replaceSupport(directory,files,rollback=false) {
    if(!Array.isArray(files)||files.length!==SUPPORT_FILES.length||new Set(files.map(f=>f.name)).size!==SUPPORT_FILES.length
        ||files.some(f=>!SUPPORT_FILES.includes(f.name)))throw new Error('Portal 守护备份记录无效。');
    const scripts=path.join(this.descriptor.root,'scripts');await directoryChain(scripts,true);
    for(const file of files) {
      const target=path.join(scripts,file.name);
      let currentHash=null;try{currentHash=hash(await regular(target));}catch(error){if(error.code!=='ENOENT')throw error;}
      if(![file.previousHash,file.nextHash].includes(currentHash))throw new Error('Portal 守护文件已变化，停止恢复。');
      if(rollback&&file.previousHash===null){if(currentHash!==null)await fs.unlink(target);continue;}
      const source=path.join(directory,rollback?'native-previous':'native-next',file.name),bytes=await regular(source);
      if(hash(bytes)!==(rollback?file.previousHash:file.nextHash))throw new Error('Portal 守护文件校验失败。');
      const temporary=path.join(scripts,`.desktop-${randomUUID()}.tmp`);
      try{await fs.writeFile(temporary,bytes,{flag:'wx',mode:0o600});await fs.rename(temporary,target);}
      finally{await fs.unlink(temporary).catch(()=>{});}
    }
  }
}

async function discoverWindowsManager({executable,configPath,home=os.homedir(),execImpl=execute,inspectProcesses,readVersion=readPortalVersion}={}) {
  try {
    if(!path.isAbsolute(executable)||!path.isAbsolute(configPath)||!inspectProcesses)return null;
    const data=await fs.realpath(path.join(home,'.heart-portal')),real=await fs.realpath(executable),relative=path.relative(data,real);
    if(relative.startsWith('..')||path.isAbsolute(relative)||!relative)return null;
    const versionOrder=compareVersions(await readVersion(executable),'0.8.3');if(versionOrder===null||versionOrder<0)return null;
    const root=path.dirname(executable),launchPath=path.join(root,'.portal-launch.json');
    const bytes=await regular(launchPath),launch=JSON.parse(bytes);
    if(launch.protocol!==1||!Array.isArray(launch.arguments)||launch.arguments[0]!=='--config'||!samePath(launch.arguments[1],configPath))return null;
    const descriptor={executable,configPath,root,launchPath,launchHash:launchHash(bytes),logPath:path.join(root,'portal-runtime.log'),errorLogPath:path.join(root,'portal-runtime.err.log')};
    const adapter=new WindowsPortalManager({descriptor,execImpl,inspectProcesses});await adapter.state();return adapter;
  }catch{return null;}
}
module.exports={WindowsPortalManager,discoverWindowsManager,SUPPORT_FILES};
