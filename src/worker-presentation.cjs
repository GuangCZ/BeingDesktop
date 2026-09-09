'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {normalizeBrowserUrl}=require('./desktop-browser.cjs');

const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.wasm':'application/wasm','.mp3':'audio/mpeg','.mp4':'video/mp4'};
const inside=(root,file)=>{const relative=path.relative(root,file);return relative===''||!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);};

// Desktop serves static output; it never runs build scripts or application code.
class WorkerPresentation {
  constructor({browser,showBrowser}) {Object.assign(this,{browser,showBrowser});this.servers=new Map();this.pending=new Map();this.revision=0;}
  describe(value) {
    if(!value)return null;
    const snapshot=this.browser.snapshot(),tab=snapshot.tabs.find(tab=>tab.id===value.tabId);
    const state=!tab?'closed':tab.url!==value.url?'navigated':tab.error?'failed':tab.isLoading?'loading':'loaded';
    return {...value,state,visible:Boolean(tab&&snapshot.visible&&snapshot.activeTabId===tab.id),title:tab?.title||value.title||'',error:tab?.error||'',
      detail:({closed:'结果标签页已关闭，可重新打开。',navigated:'结果标签页已导航到其他页面。',failed:'结果页面加载失败，请检查产物或服务。',loading:'正在内置浏览器加载结果。',loaded:'结果已在 Desktop 内置浏览器加载；不代表交互验收已通过。'})[state]};
  }
  async staticUrl(worker,artifactPath,current) {
    const workspace=await fs.realpath(worker.cwd);
    let file=await fs.realpath(path.resolve(workspace,artifactPath));
    if(!inside(workspace,file))throw new Error('结果入口必须位于此 Worker 的工作区内。');
    if((await fs.stat(file)).isDirectory())file=await fs.realpath(path.join(file,'index.html'));
    if(!inside(workspace,file)||path.extname(file).toLowerCase()!=='.html'||!(await fs.stat(file)).isFile())throw new Error('静态结果请提供工作区内的 HTML 入口或包含 index.html 的目录。');
    const root=path.dirname(file),key=worker.id+':'+file;
    const existing=this.servers.get(key);if(existing)return existing.url;
    if(this.servers.size>=16)throw new Error('静态结果预览已达上限，请重启桌面端后重试。');
    const server=http.createServer((req,res)=>{void (async()=>{
      const reject=status=>{res.writeHead(status);res.end();};
      const origin='http://127.0.0.1:'+server.address().port;
      if(req.headers.host!==new URL(origin).host||req.headers.origin&&req.headers.origin!==origin)return reject(403);
      if(!['GET','HEAD'].includes(req.method))return reject(405);
      let relative;try{relative=decodeURIComponent(new URL(req.url,origin).pathname).slice(1);}catch{return reject(400);}
      if(!relative)relative=path.basename(file);
      if(relative.split(/[\\/]/).some(part=>part==='..'||part.startsWith('.'))||relative.includes(':')||relative.includes('\0'))return reject(403);
      let target;try{target=await fs.realpath(path.resolve(root,relative));}catch{return reject(404);}
      if(!inside(root,target)||!MIME[path.extname(target).toLowerCase()])return reject(403);
      const info=await fs.stat(target);if(!info.isFile())return reject(404);
      if(info.size>32*1024*1024)return reject(413);
      const body=req.method==='HEAD'?null:await fs.readFile(target);
      res.writeHead(200,{'Content-Type':MIME[path.extname(target).toLowerCase()],'Content-Length':info.size,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(body);
    })().catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
    if(!current()){server.close();server.closeAllConnections();throw new Error('结果展示已取消。');}
    const url='http://127.0.0.1:'+server.address().port+'/'+encodeURIComponent(path.basename(file));
    this.servers.set(key,{server,url});return url;
  }
  async open(worker,args,{current=()=>true,reveal=true}={}) {
    const key=JSON.stringify([args.artifactPath||null,args.url||null,reveal]),pending=this.pending.get(worker.id);
    if(pending){
      if(pending.key!==key)throw new Error('此 Worker 的另一结果正在打开，请稍后重试。');
      const value=await pending.promise;if(!current())throw new Error('结果展示已取消。');return value;
    }
    const revision=this.revision,valid=()=>revision===this.revision&&current();
    const work=(async()=>{
      const artifactPath=args.artifactPath||null,inputUrl=args.url||null;
      if(Boolean(artifactPath)===Boolean(inputUrl))throw new Error('请指定一个结果 HTML 路径或网页 URL。');
      if(artifactPath&&(typeof artifactPath!=='string'||artifactPath.length>4096))throw new Error('结果路径无效。');
      if(inputUrl&&(typeof inputUrl!=='string'||!/^https?:\/\//i.test(inputUrl)))throw new Error('结果网页仅支持 HTTP 和 HTTPS 地址。');
      const url=artifactPath?await this.staticUrl(worker,artifactPath,valid):normalizeBrowserUrl(inputUrl);
      if(!valid())throw new Error('结果展示已取消。');
      const previous=worker.presentation;
      const existing=previous&&previous.url===url&&this.browser.snapshot().tabs.find(tab=>tab.id===previous.tabId&&tab.url===url);
      let tabId;
      if(existing){tabId=existing.id;if(reveal)this.browser.activateTab(tabId);if(existing.error)this.browser.reload(tabId);}
      else {
        const before=new Set(this.browser.snapshot().tabs.map(tab=>tab.id));
        const snapshot=this.browser.newTab({url,active:reveal});
        tabId=snapshot.tabs?.find(tab=>!before.has(tab.id))?.id||snapshot.activeTabId;
      }
      const value={tabId,url,artifactPath,requestedUrl:inputUrl,openedAt:new Date().toISOString()};
      if(reveal)await this.showBrowser();
      if(!valid())throw new Error('结果展示所属会话已变化。');
      return this.describe(value);
    })();
    this.pending.set(worker.id,{key,promise:work});
    try{return await work;}finally{if(this.pending.get(worker.id)?.promise===work)this.pending.delete(worker.id);}
  }
  async dispose(){this.revision++;await Promise.all([...this.servers.values()].map(({server})=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})));this.servers.clear();}
}
module.exports={WorkerPresentation};
