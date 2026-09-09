'use strict';

const {randomUUID} = require('node:crypto');
const {performance} = require('node:perf_hooks');
const {parseConnection} = require('./security.cjs');
const os = require('node:os');
const WebSocket = require('ws');

const MAX_MESSAGE_BYTES = 131072;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING = 4;
const MAX_REQUESTS = 16384;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_DEADLINE_MS = 90000;
const targetReceipt = place => ({type:'text',text:JSON.stringify({execution_target:{place,hostname:os.hostname(),platform:process.platform}})});
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const string = (maxLength, minLength = 1) => ({type:'string',minLength,maxLength});
const tabId = string(128);
const terminalScope = {sessionId:{type:'string',pattern:UUID},sessionToken:{type:'string',pattern:UUID}};
const terminalId = {type:'string',pattern:UUID};
const requestId = {type:'string',pattern:UUID};
const revision = {type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER};
const tool = (name, description, properties, required = []) => ({name,description,inputSchema:{type:'object',properties:{...properties,place:string(128),target_portal:string(128)},required:[...required,'place','target_portal'],additionalProperties:false}});
const definitions = [
  tool('desktop_browser_tabs','List tabs in Being Desktop. Requires local approval.',{}),
  tool('desktop_browser_open','Open an HTTP(S) page in Being Desktop. Omit tabId for a new tab. Requires local approval.',{url:string(8192),tabId},['url']),
  tool('desktop_browser_read','Read visible page text and element selectors. Use the returned revision for subsequent actions. Requires local approval.',{tabId,expectedRevision:revision},['tabId']),
  tool('desktop_browser_click','Click one visible element in the previously read page revision. Requires local approval.',{tabId,selector:string(512),expectedRevision:revision},['tabId','selector','expectedRevision']),
  tool('desktop_browser_fill','Fill one visible input without submitting. Password and file fields are unavailable. Requires local approval.',{tabId,selector:string(512),text:string(8000,0),expectedRevision:revision},['tabId','selector','text','expectedRevision']),
  tool('desktop_browser_screenshot','Capture the browser viewport at the previously read page revision. Requires local approval.',{tabId,expectedRevision:revision},['tabId','expectedRevision']),
  tool('desktop_console_run','Run a command in the selected local workspace. Returns a jobId. Requires local approval.',{command:string(16000),cwd:string(4096)},['command']),
  tool('desktop_console_status','Read command status and output. Supply jobId to select one job. Requires local approval.',{jobId:{type:'string',pattern:UUID}}),
  tool('desktop_console_stop','Stop one command job owned by Being Desktop. Requires local approval.',{jobId:{type:'string',pattern:UUID}},['jobId']),
  tool('desktop_terminal_create','Create and SHOW a persistent interactive PowerShell/ConPTY terminal shared with the user. Use the current message session binding. Runs within the user-authorized task without a separate local approval. Reuse requestId on retries. Survives reply completion and chat switches.',{...terminalScope,requestId,cwd:string(4096)},['sessionId','sessionToken','requestId']),
  tool('desktop_terminal_write','Write to this conversation\'s interactive terminal. Include \\r to press Enter or \\u0003 for Ctrl+C. Use only for the user-authorized task; never type account credentials or make user-only authorization decisions. Reuse requestId on retries to avoid executing twice.',{...terminalScope,terminalId,requestId,data:string(16000)},['sessionId','sessionToken','terminalId','requestId','data']),
  tool('desktop_terminal_read','Read incremental output from this conversation\'s terminal. Pass afterSequence from the previous sequence; continue while hasMore. A running shell or no new output does not prove a command completed or is waiting for input. No separate local approval.',{...terminalScope,terminalId,afterSequence:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER}},['sessionId','sessionToken','terminalId']),
  tool('desktop_terminal_list','List only interactive terminals owned by this conversation. No separate local approval.',terminalScope,['sessionId','sessionToken']),
  tool('desktop_terminal_show','Show and select this conversation\'s shared terminal so the user can take over required account steps. Does not stop its process. No separate local approval.',{...terminalScope,terminalId},['sessionId','sessionToken','terminalId']),
  tool('desktop_terminal_close','Explicitly close this conversation\'s terminal and its processes. Only close when requested or when your task-owned terminal is no longer needed; never close merely because a reply ends. Reuse requestId on retries.',{...terminalScope,terminalId,requestId},['sessionId','sessionToken','terminalId','requestId']),
];
const workerScope={sessionId:{type:'string',pattern:UUID},sessionToken:{type:'string',pattern:UUID}};
const nullable=rule=>({...rule,type:['string','null'],...(rule.enum?{enum:[...rule.enum,null]}:{})});
definitions.push(
  tool('desktop_worker_start','Delegate a bounded task to an external agent in the selected workspace. Include context, scope and acceptance criteria in prompt. Returns immediately; completion is sent through Heart callback. Evaluate using status and record the conclusion with desktop_worker_status action=review. Reuse requestId on retries. For follow-up verification/repair, set parentWorkerId and reuse the parent review.followUpRequestId.',{...workerScope,requestId:{type:'string',pattern:UUID},parentWorkerId:{type:'string',pattern:UUID},agentId:string(32),title:string(160),prompt:string(24000)},['sessionId','sessionToken','requestId','title','prompt']),
  tool('desktop_worker_list','List only the workers belonging to this conversation.',workerScope,['sessionId','sessionToken']),
  tool('desktop_worker_status','Read, evaluate or present a completed Desktop worker result; this tool cannot execute commands. For requested webpage delivery, action=present requires sessionId, sessionToken, workerId and exactly one of artifactPath (HTML entry relative to the worker workspace; Desktop hosts static files) or url (an existing HTTP/S service). All unused fields are null. Desktop prepares a result card in the ORIGINAL CONVERSATION, with an Open preview button for its OWN embedded browser. Keep final delivery in that conversation; never send the user to Worker details or ask them to enter a file path. Do not ask a CLI to find iab or its own browser. Then action=read exposes presentation.state; loaded confirms loading only, not interaction tests. Set fields unused by the selected action to null; never invent placeholder UUIDs or outcomes. Default action=read requires sessionId, sessionToken, workerId. For Heart completion events with source=being-desktop-worker and result.protocol=being-desktop-worker-result/1, use action=receive with callbackId=result.callback_id and the declared Portal target; all other fields are null. The trusted bridge validates its saved owner/task and returns the CURRENT original-conversation scope. No historical token is needed for receive. Then read the authoritative result. action=review requires sessionId, sessionToken, workerId, outcome, summary and concrete evidence; callbackId is null. The desktop delivers that conclusion to the original conversation; do not repeat it in a separate reply. alreadyReviewed means no repeated report or dispatch. Missing evidence uses needs_verification; delegate verification to CLI with parentWorkerId and review.followUpRequestId.',{sessionId:nullable(workerScope.sessionId),sessionToken:nullable(workerScope.sessionToken),workerId:nullable({type:'string',pattern:UUID}),action:{type:'string',enum:['read','receive','review','present']},callbackId:nullable({type:'string',pattern:UUID}),outcome:nullable({type:'string',enum:['passed','failed','needs_verification']}),summary:nullable(string(8000)),evidence:nullable(string(8000)),url:nullable(string(8192)),artifactPath:nullable(string(4096))}),
  tool('desktop_worker_wait','Wait up to 30 seconds for this worker to finish, then return its status and recent events. Repeat while running; evaluate results before reporting completion.',{...workerScope,workerId:{type:'string',pattern:UUID}},['sessionId','sessionToken','workerId']),
  tool('desktop_worker_cancel','Stop an external worker owned by this conversation.',{...workerScope,workerId:{type:'string',pattern:UUID}},['sessionId','sessionToken','workerId']),
);

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed) { return record(value) && Object.keys(value).every(key => allowed.includes(key)); }
function empty(value) { return record(value) && Object.keys(value).length === 0; }
function validId(value) { return Number.isSafeInteger(value) && value >= 0 || typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value); }
function boundedText(value, minimum, maximum) { return typeof value === 'string' && value.length >= minimum && value.length <= maximum && !value.includes('\0'); }
function normalizeWorkerArguments(name,args) {
  if(!record(args))return args;
  const clean={...args};
  // Some model adapters fill optional properties with empty strings or null.
  // Only discard empty fields that have no meaning for the selected operation.
  let optional=[];
  if(name==='desktop_worker_start')optional=['parentWorkerId','agentId'];
  if(name==='desktop_worker_status') {
    if(clean.action===''||clean.action===null)delete clean.action;
    const action=clean.action||'read';
    optional=action==='receive'?['sessionId','sessionToken','workerId','outcome','summary','evidence','url','artifactPath']:
      action==='review'?['callbackId','url','artifactPath']:action==='present'?['callbackId','outcome','summary','evidence','url','artifactPath']:['callbackId','outcome','summary','evidence','url','artifactPath'];
  }
  for(const key of optional)if(clean[key]===''||clean[key]===null)delete clean[key];
  return clean;
}
function validArguments(name, args) {
  args=normalizeWorkerArguments(name,args);
  const schema = definitions.find(item => item.name === name)?.inputSchema;
  // Hearth consumes the routing selector before forwarding MCP arguments.
  if (!schema || !keys(args,Object.keys(schema.properties)) || schema.required.some(key => key !== 'place' && !Object.hasOwn(args,key))) return false;
  for (const [key,value] of Object.entries(args)) {
    const rule = schema.properties[key];
    const types=Array.isArray(rule.type)?rule.type:[rule.type];
    if(value===null&&types.includes('null'))continue;
    if(rule.enum&&!rule.enum.includes(value))return false;
    if (types.includes('string') && (!boundedText(value,rule.minLength ?? 0,rule.maxLength ?? 128) || rule.pattern && !new RegExp(rule.pattern).test(value))) return false;
    if (rule.type === 'integer' && (!Number.isSafeInteger(value) || value < rule.minimum)) return false;
  }
  if(name==='desktop_worker_status') {
    const action=args.action||'read';
    const required=action==='receive'?['callbackId']:action==='review'?['sessionId','sessionToken','workerId','outcome','summary','evidence']:['sessionId','sessionToken','workerId'];
    if(required.some(key=>!Object.hasOwn(args,key)||args[key]===null))return false;
    const allowed=[...required,'action','place','target_portal',...(action==='present'?['url','artifactPath']:[])];
    if(Object.keys(args).some(key=>!allowed.includes(key)))return false;
    if(action==='present'&&Boolean(args.url)===Boolean(args.artifactPath))return false;
  }
  if (name === 'desktop_browser_open') {
    try {
      const url = new URL(args.url);
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || /[\x00-\x20\x7f]/.test(args.url)) return false;
    } catch { return false; }
  }
  return true;
}

function result(value) {
  if (!keys(value,['content','isError']) || !Array.isArray(value.content) || value.content.length > 16 || Object.hasOwn(value,'isError') && typeof value.isError !== 'boolean') throw new Error('Invalid tool result');
  const content = value.content.map(block => {
    if (keys(block,['type','text']) && block.type === 'text' && typeof block.text === 'string' && Buffer.byteLength(block.text,'utf8') <= 1024 * 1024) return {type:'text',text:block.text};
    if (keys(block,['type','mimeType','data']) && block.type === 'image' && ['image/png','image/jpeg','image/webp'].includes(block.mimeType) && typeof block.data === 'string' && block.data.length > 0 && block.data.length <= MAX_RESPONSE_BYTES && block.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(block.data) && Buffer.from(block.data,'base64').toString('base64') === block.data) return {type:'image',mimeType:block.mimeType,data:block.data};
    throw new Error('Invalid tool content');
  });
  return {content,isError:value.isError === true};
}

class DesktopToolLink {
  #socket = null;
  #generation = 0;
  #initialized = false;
  #disposed = false;
  #pending = new Map();
  #seen = new Set();
  #onChange;
  #invokeTool;
  #WebSocket;
  #clock;
  #timers;
  #handshakeTimer = null;
  #heartbeatTimer = null;
  #connecting = null;
  #portalName = `being-desktop-tools-${randomUUID().replaceAll('-','').slice(0,12)}`;
  #state = {status:'disconnected',error:'',lastCall:null,calls:0};
  #toolAllowed;

  constructor({onChange = () => {}, invokeTool, portalName, toolAllowed = name=>!name.startsWith('desktop_worker_'), WebSocketImpl = WebSocket, clock = () => performance.now(), timers = globalThis} = {}) {
    if (typeof invokeTool !== 'function' || typeof onChange !== 'function') throw new Error('工具调用处理器无效。');
    this.#onChange = onChange;
    this.#invokeTool = invokeTool;
    this.#toolAllowed = toolAllowed;
    this.#WebSocket = WebSocketImpl;
    this.#clock = clock;
    this.#timers = timers;
    if (portalName !== undefined) {
      if (!/^[a-zA-Z0-9._-]{1,128}$/.test(portalName)) throw new Error('Invalid desktop Portal name');
      this.#portalName = portalName;
    }
  }

  snapshot() {
    return {...this.#state,lastCall:this.#state.lastCall && {...this.#state.lastCall},pending:[...this.#pending.values()].map(item => ({id:item.key,name:item.name,startedAt:item.startedAt}))};
  }

  capabilities() {
    return {status:this.#state.status,place:this.#portalName,hostname:os.hostname(),platform:process.platform,
      tools:this.#state.status==='connected' && this.#initialized?definitions.filter(item=>this.#toolAllowed(item.name)).map(item=>item.name):[]};
  }

  #changed() { try { this.#onChange(this.snapshot()); } catch { /* Observers cannot affect tool dispatch. */ } }

  #end(status = 'disconnected', error = '') {
    const socket = this.#socket;
    this.#socket = null;
    this.#generation++;
    this.#initialized = false;
    this.#timers.clearTimeout(this.#handshakeTimer);
    this.#timers.clearInterval(this.#heartbeatTimer);
    this.#handshakeTimer = null;
    this.#heartbeatTimer = null;
    const connecting = this.#connecting;
    this.#connecting = null;
    connecting?.reject(new Error(error || '工具连接已断开。'));
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#seen.clear();
    this.#state.status = status;
    this.#state.error = error;
    if (pending.length) this.#state.lastCall = {name:pending.at(-1).name,status:'cancelled',at:Date.now()};
    for (const item of pending) item.controller.abort();
    try { socket?.close(status === 'error' ? 1008 : 1000,'Desktop tools disconnected'); } catch { /* The local session is already revoked. */ }
    this.#changed();
  }

  #send(value) {
    if (!this.#socket || this.#socket.readyState !== 1) return false;
    let text;
    try { text = JSON.stringify(value); } catch { return false; }
    if (Buffer.byteLength(text,'utf8') > MAX_RESPONSE_BYTES) return false;
    if (this.#socket.bufferedAmount > MAX_BUFFERED_BYTES) { this.#end('error','工具连接发送拥塞，请重新连接。'); return false; }
    try { this.#socket.send(text); return true; }
    catch { this.#end('error','工具连接发送失败，请重新连接。'); return false; }
  }

  #error(id, code, message) { this.#send({jsonrpc:'2.0',id,error:{code,message}}); }

  connect(connection) {
    if (this.#disposed) return Promise.reject(new Error('工具连接已关闭。'));
    if (this.#socket) return Promise.reject(new Error('工具连接已在使用，请先断开。'));
    let parsed, loom, beingId;
    try {
      if (!record(connection)) throw new Error('connection');
      parsed = parseConnection(connection.url);
      loom = new URL(parsed.url);
      beingId = loom.pathname.split('/').filter(Boolean)[0];
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(beingId || '') || !boundedText(parsed.token,1,4096) || /[\r\n]/.test(parsed.token) || connection.token !== parsed.token) throw new Error('identity');
    } catch { return Promise.reject(new Error('Loom 连接缺少有效的 Being 身份或令牌。')); }
    const relay = new URL('/_relay',loom.origin);
    relay.protocol = loom.protocol === 'http:' ? 'ws:' : 'wss:';
    let socket;
    try { socket = new this.#WebSocket(relay.href); }
    catch { this.#state.status = 'error';this.#state.error = '工具连接无法建立。';this.#changed();return Promise.reject(new Error(this.#state.error)); }
    this.#socket = socket;
    const generation = ++this.#generation;
    const current = () => this.#socket === socket && generation === this.#generation;
    this.#state.status = 'connecting';
    this.#state.error = '';
    this.#initialized = false;
    this.#seen.clear();
    let handshake = {being_id:beingId,loom_token:parsed.token,portal_name:this.#portalName};
    let lastSeen = this.#clock();
    let textKeepalive = false;
    // Older relays acknowledge authentication without advertising text keepalive.
    socket.on?.('pong',() => { if (current() && !textKeepalive && this.#state.status === 'connected') lastSeen = this.#clock(); });
    const connected = new Promise((resolve,reject) => { this.#connecting = {resolve,reject}; });
    this.#handshakeTimer = this.#timers.setTimeout(() => { if (current()) this.#end('error','工具连接握手未完成，请重新连接。'); },10000);
    this.#handshakeTimer?.unref?.();
    socket.addEventListener('open',() => {
      if (!current()) { handshake = null; return; }
      this.#send(handshake);
      handshake = null;
    });
    socket.addEventListener('message',({data}) => {
      if (!current()) return;
      if (typeof data !== 'string' || Buffer.byteLength(data,'utf8') > MAX_MESSAGE_BYTES) { this.#end('error','工具连接收到不支持的数据。'); return; }
      let message;
      try { message = JSON.parse(data); } catch {
        if (this.#state.status === 'connecting') this.#end('error','工具连接握手被拒绝。');
        else this.#error(null,-32700,'Invalid JSON.');
        return;
      }
      if (this.#state.status === 'connecting') {
        if (!keys(message,['ok','being_id','relay_keepalive']) || message.ok !== true || Object.hasOwn(message,'being_id') && message.being_id !== beingId || Object.hasOwn(message,'relay_keepalive') && message.relay_keepalive !== 'text-v1') { this.#end('error','工具连接握手被拒绝。');return; }
        textKeepalive = message.relay_keepalive === 'text-v1';
        if (!textKeepalive && (typeof socket.ping !== 'function' || typeof socket.on !== 'function')) { this.#end('error','工具连接不支持服务器的心跳协议。');return; }
        this.#timers.clearTimeout(this.#handshakeTimer);
        this.#handshakeTimer = null;
        this.#state.status = 'connected';
        lastSeen = this.#clock();
        const waiting = this.#connecting;
        this.#connecting = null;
        this.#heartbeatTimer = this.#timers.setInterval(() => {
          if (!current()) return;
          if (this.#clock() - lastSeen > HEARTBEAT_DEADLINE_MS) { this.#end('error','工具连接已失去响应，请重新连接。');return; }
          if (textKeepalive) this.#send({type:'keepalive'});
          else {
            if (socket.bufferedAmount > MAX_BUFFERED_BYTES) { this.#end('error','工具连接发送拥塞，请重新连接。');return; }
            try { socket.ping('bd',error => { if (error && current()) this.#end('error','工具连接发送失败，请重新连接。'); }); }
            catch { this.#end('error','工具连接发送失败，请重新连接。'); }
          }
        },HEARTBEAT_INTERVAL_MS);
        this.#heartbeatTimer?.unref?.();
        this.#changed();
        if (current()) waiting?.resolve(this.snapshot());
        else waiting?.reject(new Error('工具连接已断开。'));
        return;
      }
      if (textKeepalive && keys(message,['type']) && message.type === 'keepalive_ack') { lastSeen = this.#clock();return; }
      if (this.#message(message,generation)) lastSeen = this.#clock();
    });
    socket.addEventListener('error',() => { handshake = null;if (current()) this.#end('error','工具连接发生网络错误，请重新连接。'); });
    socket.addEventListener('close',() => { handshake = null;if (current()) this.#end('error','工具连接已断开，请重新连接。'); });
    this.#changed();
    return connected;
  }

  #message(message,generation) {
    if (!record(message)) { this.#error(null,-32600,'Single request object required.');return false; }
    const hasId = Object.hasOwn(message,'id');
    const id = hasId && validId(message.id) ? message.id : null;
    if (!keys(message,['jsonrpc','id','method','params']) || message.jsonrpc !== '2.0' || !boundedText(message.method,1,128) || hasId && id === null) {
      if (hasId) this.#error(id,-32600,'Invalid request.');
      return false;
    }
    const params = Object.hasOwn(message,'params') ? message.params : {};
    if (!hasId) {
      if (message.method === 'notifications/initialized' && this.#initialized && empty(params)) return true;
      if (message.method === 'notifications/cancelled' && this.#initialized && keys(params,['requestId','reason']) && validId(params.requestId) && (!Object.hasOwn(params,'reason') || boundedText(params.reason,0,1024))) {
        const item = this.#pending.get(JSON.stringify(params.requestId));
        if (item) {
          this.#pending.delete(JSON.stringify(params.requestId));
          item.controller.abort();
          this.#state.lastCall = {name:item.name,status:'cancelled',at:Date.now()};
          this.#changed();
        }
        return true;
      }
      return false;
    }
    const key = JSON.stringify(id);
    if (this.#seen.has(key)) { this.#error(id,-32600,'Request identifier already used.');return false; }
    if (this.#seen.size >= MAX_REQUESTS) { this.#end('error','本次工具连接已达到请求上限，请重新连接。');return false; }
    this.#seen.add(key);
    if (message.method === 'initialize') {
      if (this.#initialized || !keys(params,['protocolVersion','capabilities','clientInfo']) || !boundedText(params.protocolVersion,1,128) || !record(params.capabilities) || !keys(params.clientInfo,['name','version','title']) || !boundedText(params.clientInfo.name,1,128) || !boundedText(params.clientInfo.version,1,128) || Object.hasOwn(params.clientInfo,'title') && !boundedText(params.clientInfo.title,1,128)) { this.#error(id,-32602,'Invalid initialization parameters.');return false; }
      this.#initialized = this.#send({jsonrpc:'2.0',id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{listChanged:false}},serverInfo:{name:'being-desktop-tools',version:'1.0.0'}}});
      return this.#initialized;
    }
    if (message.method === 'ping') {
      if (!empty(params)) { this.#error(id,-32602,'Parameters not permitted.');return false; }
      return this.#send({jsonrpc:'2.0',id,result:{}});
    }
    if (!this.#initialized) { this.#error(id,-32002,'Initialize the tool session first.');return false; }
    if (message.method === 'tools/list') {
      if (!empty(params)) { this.#error(id,-32602,'Parameters not permitted.');return false; }
      const tools = structuredClone(definitions.filter(tool=>this.#toolAllowed(tool.name)));
      for (const tool of tools) {
        tool.inputSchema.properties.place = {type:'string',enum:[this.#portalName],description:'Routing selector for Hearth. Also set target_portal to the same value for endpoint verification.'};
        tool.inputSchema.properties.target_portal = {type:'string',enum:[this.#portalName],description:'Required end-to-end execution target. Retained after routing; a missing or mismatched value is rejected before execution.'};
        tool.description += ` Execution host: ${JSON.stringify(os.hostname())}, OS: ${process.platform}; Portal: ${this.#portalName}.`;
      }
      return this.#send({jsonrpc:'2.0',id,result:{tools}});
    }
    if (message.method !== 'tools/call') { this.#error(id,-32601,'Method not permitted.');return false; }
    if (!keys(params,['name','arguments']) || !validArguments(params.name,params.arguments) || !this.#toolAllowed(params.name)) { this.#error(id,-32602,'Tool arguments not permitted.');return false; }
    if (params.arguments.target_portal !== this.#portalName || Object.hasOwn(params.arguments,'place') && params.arguments.place !== this.#portalName) { this.#error(id,-32602,'Portal target mismatch; tool was not executed. Set target_portal to the advertised endpoint and place to the same routing selector.');return false; }
    if (this.#pending.size >= MAX_PENDING) { this.#error(id,-32000,'Too many pending desktop tool requests.');return false; }
    const item = {key:randomUUID(),name:params.name,startedAt:Date.now(),controller:new AbortController()};
    this.#pending.set(key,item);
    this.#state.calls++;
    this.#state.lastCall = {name:item.name,status:'pending',at:item.startedAt};
    this.#changed();
    void this.#invoke(id,key,item,normalizeWorkerArguments(params.name,structuredClone(params.arguments)),generation);
    return true;
  }

  async #invoke(id,key,item,args,generation) {
    delete args.place;
    delete args.target_portal;
    const active = () => generation === this.#generation && this.#pending.get(key) === item && !item.controller.signal.aborted;
    let removeAbort = () => {};
    try {
      if (!active()) return;
      const cancelled = new Promise((_,reject) => {
        const abort = () => reject(new Error('Cancelled'));
        item.controller.signal.addEventListener('abort',abort,{once:true});
        removeAbort = () => item.controller.signal.removeEventListener('abort',abort);
      });
      const operation = Promise.resolve().then(() => {
        if (!active()) throw new Error('Cancelled');
        return this.#invokeTool(item.name,args,{signal:item.controller.signal,requestKey:item.key});
      });
      const value = result(await Promise.race([operation,cancelled]));
      value.content.unshift(targetReceipt(this.#portalName));
      if (!active()) return;
      if (!this.#send({jsonrpc:'2.0',id,result:value})) throw new Error('Result unavailable');
      this.#state.lastCall = {name:item.name,status:value.isError ? 'failed' : 'completed',at:Date.now()};
    } catch {
      if (!active()) return;
      this.#send({jsonrpc:'2.0',id,result:{content:[targetReceipt(this.#portalName),{type:'text',text:'Desktop tool was not completed. Check the local approval or tool status.'}],isError:true}});
      this.#state.lastCall = {name:item.name,status:'failed',at:Date.now()};
    } finally {
      removeAbort();
      if (generation === this.#generation && this.#pending.get(key) === item) { this.#pending.delete(key);this.#changed(); }
    }
  }

  disconnect() { this.#end();return this.snapshot(); }
  dispose() { this.#disposed = true;return this.disconnect(); }
}

module.exports = {DesktopToolLink,toolDefinitions:(workerMode=false) => structuredClone(definitions.filter(tool=>tool.name.startsWith('desktop_worker_')===workerMode)),validArguments,MAX_MESSAGE_BYTES,MAX_RESPONSE_BYTES,MAX_PENDING,MAX_REQUESTS,MAX_BUFFERED_BYTES};
