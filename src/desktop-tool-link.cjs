'use strict';

const {randomUUID} = require('node:crypto');
const {performance} = require('node:perf_hooks');
const {parseConnection} = require('./security.cjs');

const MAX_MESSAGE_BYTES = 131072;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING = 4;
const MAX_REQUESTS = 16384;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_DEADLINE_MS = 90000;
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const string = (maxLength, minLength = 1) => ({type:'string',minLength,maxLength});
const tabId = string(128);
const revision = {type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER};
const tool = (name, description, properties, required = []) => ({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
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
];

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed) { return record(value) && Object.keys(value).every(key => allowed.includes(key)); }
function empty(value) { return record(value) && Object.keys(value).length === 0; }
function validId(value) { return Number.isSafeInteger(value) && value >= 0 || typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value); }
function boundedText(value, minimum, maximum) { return typeof value === 'string' && value.length >= minimum && value.length <= maximum && !value.includes('\0'); }
function validArguments(name, args) {
  const schema = definitions.find(item => item.name === name)?.inputSchema;
  if (!schema || !keys(args,Object.keys(schema.properties)) || schema.required.some(key => !Object.hasOwn(args,key))) return false;
  for (const [key,value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (rule.type === 'string' && (!boundedText(value,rule.minLength ?? 0,rule.maxLength ?? 128) || rule.pattern && !new RegExp(rule.pattern).test(value))) return false;
    if (rule.type === 'integer' && (!Number.isSafeInteger(value) || value < rule.minimum)) return false;
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

  constructor({onChange = () => {}, invokeTool, WebSocketImpl = globalThis.WebSocket, clock = () => performance.now(), timers = globalThis} = {}) {
    if (typeof invokeTool !== 'function' || typeof onChange !== 'function') throw new Error('工具调用处理器无效。');
    this.#onChange = onChange;
    this.#invokeTool = invokeTool;
    this.#WebSocket = WebSocketImpl;
    this.#clock = clock;
    this.#timers = timers;
  }

  snapshot() {
    return {...this.#state,lastCall:this.#state.lastCall && {...this.#state.lastCall},pending:[...this.#pending.values()].map(item => ({id:item.key,name:item.name,startedAt:item.startedAt}))};
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
        if (!keys(message,['ok','relay_keepalive']) || message.ok !== true || message.relay_keepalive !== 'text-v1') { this.#end('error','工具连接握手被拒绝。');return; }
        this.#timers.clearTimeout(this.#handshakeTimer);
        this.#handshakeTimer = null;
        this.#state.status = 'connected';
        lastSeen = this.#clock();
        const waiting = this.#connecting;
        this.#connecting = null;
        this.#heartbeatTimer = this.#timers.setInterval(() => {
          if (!current()) return;
          if (this.#clock() - lastSeen > HEARTBEAT_DEADLINE_MS) { this.#end('error','工具连接已失去响应，请重新连接。');return; }
          this.#send({type:'keepalive'});
        },HEARTBEAT_INTERVAL_MS);
        this.#heartbeatTimer?.unref?.();
        this.#changed();
        if (current()) waiting?.resolve(this.snapshot());
        else waiting?.reject(new Error('工具连接已断开。'));
        return;
      }
      if (keys(message,['type']) && message.type === 'keepalive_ack') { lastSeen = this.#clock();return; }
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
      return this.#send({jsonrpc:'2.0',id,result:{tools:definitions}});
    }
    if (message.method !== 'tools/call') { this.#error(id,-32601,'Method not permitted.');return false; }
    if (!keys(params,['name','arguments']) || !validArguments(params.name,params.arguments)) { this.#error(id,-32602,'Tool arguments not permitted.');return false; }
    if (this.#pending.size >= MAX_PENDING) { this.#error(id,-32000,'Too many pending desktop tool requests.');return false; }
    const item = {key:randomUUID(),name:params.name,startedAt:Date.now(),controller:new AbortController()};
    this.#pending.set(key,item);
    this.#state.calls++;
    this.#state.lastCall = {name:item.name,status:'pending',at:item.startedAt};
    this.#changed();
    void this.#invoke(id,key,item,structuredClone(params.arguments),generation);
    return true;
  }

  async #invoke(id,key,item,args,generation) {
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
      if (!active()) return;
      if (!this.#send({jsonrpc:'2.0',id,result:value})) throw new Error('Result unavailable');
      this.#state.lastCall = {name:item.name,status:value.isError ? 'failed' : 'completed',at:Date.now()};
    } catch {
      if (!active()) return;
      this.#send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:'Desktop tool was not completed. Check the local approval or tool status.'}],isError:true}});
      this.#state.lastCall = {name:item.name,status:'failed',at:Date.now()};
    } finally {
      removeAbort();
      if (generation === this.#generation && this.#pending.get(key) === item) { this.#pending.delete(key);this.#changed(); }
    }
  }

  disconnect() { this.#end();return this.snapshot(); }
  dispose() { this.#disposed = true;return this.disconnect(); }
}

module.exports = {DesktopToolLink,toolDefinitions:() => structuredClone(definitions),validArguments,MAX_MESSAGE_BYTES,MAX_RESPONSE_BYTES,MAX_PENDING,MAX_REQUESTS,MAX_BUFFERED_BYTES};
