'use strict';
const {randomUUID} = require('node:crypto');
const {DesktopBrowser} = require('./desktop-browser.cjs');
const {DesktopConsole} = require('./desktop-console.cjs');
const {DesktopToolLink} = require('./desktop-tool-link.cjs');
const {DesktopTerminalTools} = require('./desktop-terminal-tools.cjs');

const textResult = value => ({content:[{type:'text',text:JSON.stringify(value)}],isError:false});
class DesktopTools {
  constructor({WebContentsView,session,getWindow,getConnection,getWorkspace,onChange,orchestration,getTerminal=()=>null,showTerminal=()=>{},Browser=DesktopBrowser,Console=DesktopConsole,ToolLink=DesktopToolLink}) {
    this.onChange=onChange;this.getConnection=getConnection;this.getWorkspace=getWorkspace;
    this.orchestration=orchestration;
    this.getTerminal=getTerminal;
    this.terminalTools=new DesktopTerminalTools({getTerminal,showTerminal});
    this.requests=new Map();this.remoteJobs=new Set();this.jobOrigins=new Map();this.generation=0;this.disposed=false;this.notifyQueued=false;this.requestResult=null;
    this.browser=new Browser({WebContentsView,session,getWindow,onChange:()=>this.changed()});
    this.console=new Console({getWorkspace,onChange:()=>this.changed()});
    this.link=new ToolLink({onChange:()=>this.changed(),toolAllowed:name=>orchestration?.mode.enabled?name.startsWith('desktop_worker_'):!name.startsWith('desktop_worker_') && (!name.startsWith('desktop_terminal_') || Boolean(getTerminal()) && ['win32','darwin'].includes(process.platform)),invokeTool:(name,args,context)=>this.request(name,args,context)});
  }
  snapshot() {
    const consoleState=this.console.snapshot(),jobIds=new Set(consoleState.jobs.map(job=>job.id));
    for(const id of this.jobOrigins.keys())if(!jobIds.has(id))this.jobOrigins.delete(id);
    consoleState.jobs=consoleState.jobs.map(job=>({...job,origin:this.jobOrigins.get(job.id)||'you'}));
    return {browser:this.browser.snapshot(),console:consoleState,link:this.link.snapshot(),
      workspace:this.getWorkspace() || '',requestResult:this.requestResult,
      requests:[...this.requests.values()].map(r=>({id:r.id,name:r.name,args:r.args,target:r.target,status:r.status,targetSummary:r.targetSummary,reviewJobs:r.reviewJobs}))};
  }
  changed() {
    if(this.disposed || this.notifyQueued)return;
    this.notifyQueued=true;
    setImmediate(()=>{this.notifyQueued=false;if(!this.disposed)this.onChange?.(this.snapshot());});
  }
  async perform(action,value) {
    if(this.disposed)throw new Error('桌面工具已关闭。');
    switch(action) {
      case 'browser.new': this.browser.newTab(value);break;
      case 'browser.activate': this.browser.activateTab(value);break;
      case 'browser.close': this.browser.closeTab(value);break;
      case 'browser.navigate': this.browser.navigate(value);break;
      case 'browser.back': this.browser.goBack(value);break;
      case 'browser.forward': this.browser.goForward(value);break;
      case 'browser.reload': this.browser.reload(value);break;
      case 'browser.stop': this.browser.stop(value);break;
      case 'console.run': await this.console.run(value);break;
      case 'console.stop': await this.console.stop(value);break;
      case 'console.clear': this.console.clear(value);break;
      case 'link.connect': {
        const connection=this.getConnection();if(!connection)throw new Error('请先连接 Being。');
        this.disconnectLink();await this.link.connect(connection);break;
      }
      case 'link.disconnect': this.disconnectLink();break;
      case 'request.allow': await this.decide(value,true);break;
      case 'request.deny': await this.decide(value,false);break;
      default: throw new Error('未知桌面工具操作。');
    }
    this.changed();return this.snapshot();
  }
  request(name,args,{signal,requestKey}={}) {
    if(this.orchestration?.mode.enabled) {
      if(!name.startsWith('desktop_worker_'))return Promise.reject(new Error('编排模式下 Being 只能调度 worker，不能直接执行桌面工具。'));
      return this.orchestration.tool(name,args,{signal});
    }
    if(name.startsWith('desktop_worker_'))return Promise.reject(new Error('编排模式未开启。'));
    if(this.disposed || signal?.aborted)return Promise.reject(new Error('调用已取消。'));
    if(name.startsWith('desktop_terminal_'))return this.terminalTools.invoke(name,structuredClone(args),{signal}).then(textResult).catch(error=>({
      content:[{type:'text',text:/^(终端|只能操作本会话|同一 requestId|当前会话的终端|交互终端|本版本的交互终端|最多同时保留|请先选择有效|无法启动 (?:PowerShell|zsh)|无法连接 (?:PowerShell|zsh))/.test(error?.message || '') ? error.message : '交互终端操作未完成，请读取终端列表和当前消息的会话绑定后核对。'}],isError:true,
    }));
    if(this.requests.size>=8)return Promise.reject(new Error('待确认调用过多，请稍后重试。'));
    const frozen=structuredClone(args);
    let target='本机';
    if(name.startsWith('desktop_browser_') && frozen.tabId) {
      const tab=this.browser.snapshot().tabs.find(t=>t.id===frozen.tabId);
      if(!tab)return Promise.reject(new Error('浏览器标签已关闭。'));
      if(frozen.expectedRevision!==undefined && frozen.expectedRevision!==tab.revision)return Promise.reject(new Error('页面已变化，请重新读取。'));
      frozen.expectedRevision=tab.revision;target=tab.url || tab.title;
    }
    if(name==='desktop_console_run') {frozen.cwd=frozen.cwd || this.getWorkspace();target=frozen.cwd || '尚未选择工作区';}
    if(name==='desktop_console_status' && frozen.jobId && !this.remoteJobs.has(frozen.jobId))return Promise.reject(new Error('只能读取本次 Being 连接发起的命令。'));
    if(name==='desktop_console_stop' && !this.remoteJobs.has(frozen.jobId))return Promise.reject(new Error('只能停止本次 Being 连接发起的命令。'));
    const generation=this.generation;
    const reviewJobs=name.startsWith('desktop_console_') && name!=='desktop_console_run'?
      this.console.snapshot().jobs.filter(job=>this.remoteJobs.has(job.id)&&(!frozen.jobId||frozen.jobId===job.id)).map(job=>({id:job.id,command:job.command,cwd:job.cwd})):[];
    const enqueue=prepared=>{
      if(this.disposed || signal?.aborted || generation!==this.generation)return Promise.reject(new Error('调用已取消。'));
      if(this.requests.size>=8)return Promise.reject(new Error('待确认调用过多，请稍后重试。'));
      return new Promise((resolve,reject)=>{
        const id=requestKey || randomUUID();
        const abort=()=>{this.requests.delete(id);reject(new Error('Being 连接已结束，调用已取消。'));this.changed();};
        this.requests.set(id,{id,name,args:frozen,target,status:'pending',resolve,reject,signal,abort,generation,
          targetToken:prepared?.targetToken,targetSummary:prepared?.summary,reviewJobs});
        signal?.addEventListener('abort',abort,{once:true});this.changed();
      });
    };
    if(['desktop_browser_click','desktop_browser_fill'].includes(name))return this.browser.prepareAction({id:frozen.tabId,selector:frozen.selector,expectedRevision:frozen.expectedRevision,kind:name==='desktop_browser_click'?'click':'fill'}).then(enqueue);
    return enqueue();
  }
  async decide(id,allow) {
    const request=this.requests.get(id);
    if(!request || request.status!=='pending')throw new Error('该调用已处理或已取消。');
    if(!allow) {this.finish(request,new Error('用户拒绝了本次调用。'));return;}
    request.status='running';this.changed();
    try {
      if(request.signal?.aborted)throw new Error('调用已取消。');
      if(request.generation!==this.generation)throw new Error('调用所属连接已变化。');
      const result=await this.invoke(request.name,request.args,{signal:request.signal,generation:request.generation,targetToken:request.targetToken,reviewJobIds:request.reviewJobs.map(job=>job.id)});
      this.finish(request,null,result);
    } catch(error) {this.finish(request,error);}
  }
  finish(request,error,result) {
    request.signal?.removeEventListener('abort',request.abort);
    this.requests.delete(request.id);
    this.requestResult={id:request.id,status:error?'failed':'completed',message:error?String(error.message):'Being 调用已完成。'};
    if(error)request.reject(error);else request.resolve(result);
    this.changed();
  }
  async invoke(name,args,{signal,generation=this.generation,targetToken,reviewJobIds}={}) {
    if(this.orchestration?.mode.enabled)throw new Error('编排模式下禁止 Being 直接执行桌面工具。');
    const id=args.tabId,revision=args.expectedRevision;
    if(signal?.aborted || generation!==this.generation)throw new Error('调用已取消。');
    if(id && revision!==undefined && this.browser.snapshot().tabs.find(tab=>tab.id===id)?.revision!==revision)throw new Error('请求已过期：页面或操作目标已变化，请重新申请。');
    switch(name) {
      case 'desktop_browser_tabs':return textResult(this.browser.snapshot());
      case 'desktop_browser_open':return textResult(id?this.browser.navigate({id,url:args.url}):this.browser.newTab({url:args.url}));
      case 'desktop_browser_read':return textResult(await this.browser.readPage(id,revision));
      case 'desktop_browser_click':return textResult(await this.browser.click({id,selector:args.selector,expectedRevision:revision,targetToken}));
      case 'desktop_browser_fill':return textResult(await this.browser.fill({id,selector:args.selector,text:args.text,expectedRevision:revision,targetToken}));
      case 'desktop_browser_screenshot': {
        const shot=await this.browser.screenshot(id,revision);
        return {content:[{type:'image',mimeType:shot.mimeType,data:shot.data}],isError:false};
      }
      case 'desktop_console_run': {
        const job=await this.console.run({...args,signal});this.jobOrigins.set(job.jobId,'being');
        if(signal?.aborted || generation!==this.generation){await this.console.stop(job.jobId);throw new Error('连接已结束，命令已停止。');}
        this.remoteJobs.add(job.jobId);return textResult(job);
      }
      case 'desktop_console_status':return textResult({jobs:this.console.snapshot().jobs.filter(job=>this.remoteJobs.has(job.id)&&(!reviewJobIds||reviewJobIds.includes(job.id))&&(!args.jobId||job.id===args.jobId))});
      case 'desktop_console_stop':return textResult(await this.console.stop(args.jobId));
      default:throw new Error('工具不可用。');
    }
  }
  disconnectLink() {
    this.generation++;this.remoteJobs.clear();this.link.disconnect();
    for(const request of [...this.requests.values()])this.finish(request,new Error('工具连接已断开。'));
    this.changed();
  }
  async dispose() {
    this.disconnectLink();await this.console.dispose();this.browser.destroy();this.disposed=true;
  }
}
module.exports={DesktopTools};
