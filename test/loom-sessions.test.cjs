'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const {installSessions,prepareLoomSessions,changeLoomSession} = require('../src/loom-sessions.cjs');
const {desktopMessageContext} = require('../src/desktop-message-context.cjs');
const {createSessionRouter} = require('../src/loom-session-routing.cjs');

function fixture(storage = new Map()) {
  const calls = [];
  let reply = {messages:[]};
  const context = vm.createContext({
    URL, Request, Response, TextEncoder, Uint8Array, TextDecoderStream, TextEncoderStream, TransformStream,
    crypto:webcrypto, location:{href:'https://fixture.invalid/loom/Being',origin:'https://fixture.invalid',pathname:'/loom/Being'},
    localStorage:{get length(){return storage.size;},key:index=>[...storage.keys()][index],getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
    document:{addEventListener(){}},
    fetch:async(url,options)=>{calls.push({url:String(url),options});return reply instanceof Response ? reply : Response.json(reply);}
  });
  vm.runInContext('window=globalThis;window.top=window;', context);
  vm.runInContext(`(${installSessions.toString()})(null,${createSessionRouter.toString()},${JSON.stringify(desktopMessageContext({platform:'win32',hostname:'CZ'}))})`, context);
  return {context, storage, calls, api:context.__beingDesktopSessions, respond:value=>{reply=value;}};
}

test('saved model errors are compacted and deduplicated without changing user text or separate requests',async()=>{
  const f=fixture(),id=f.api.list().activeId;
  const key=[...f.storage.keys()].find(key=>key.endsWith(':'+id));
  const session=JSON.parse(f.storage.get(key));
  const error='⚠ LLM API error 525 <unknown status code>: <html>UPSTREAM_HTML</html>';
  session.messages=[{role:'user',content:error,at:'1'},
    {role:'being',content:error,request_id:'first',at:'2'},
    {role:'being',content:error,request_id:'first',at:'2'},
    {role:'being',content:error,request_id:'second',at:'2'}];
  f.storage.set(key,JSON.stringify(session));
  for(let reload=0;reload<2;reload++){
    const next=fixture(f.storage);
    const {messages}=await (await next.context.fetch('/api/history')).json();
    assert.equal(messages.length,3);assert.equal(messages[0].content,error);
    for(const message of messages.slice(1)){
      assert.match(message.content,/模型接口请求失败（HTTP 525）/);
      assert.doesNotMatch(message.content,/UPSTREAM_HTML/);assert.equal(message.model_error_status,525);
    }
  }
});

test('orchestration errors retain their category across rendering and reload without exposing raw server text',async()=>{
  for(const [code,label] of [['worker_only','旧网关未区分'],['disallowed_tool','未授权的工具'],['unsupported_output','不允许的输出类型'],['invalid_response','响应格式异常'],['upstream_response_failed','上游模型生成失败'],['upstream_response_incomplete','上游模型提前结束'],['upstream_stream_error','上游模型返回流错误'],['response_too_large','超出网关容量']]){
    const f=fixture(),id=f.api.list().activeId,key='being-desktop-sessions-v1:/loom/Being';
    const raw='LLM API error 502 Bad Gateway: '+JSON.stringify({error:{type:code==='worker_only'?'orchestration_policy_error':'orchestration_response_error',code,message:'PRIVATE_RAW_HTML',reason:'PRIVATE_REASON'}});
    const session=JSON.parse(f.storage.get(key+':'+id));
    session.messages=[{role:'user',content:raw},{role:'being',content:raw,request_id:'r'}];
    f.storage.set(key+':'+id,JSON.stringify(session));
    for(let reload=0;reload<2;reload++){
      const next=fixture(f.storage),{messages}=await (await next.context.fetch('/api/history')).json();
      assert.equal(messages[0].content,raw);assert.ok(messages[1].content.includes(label));
      assert.doesNotMatch(messages[1].content,/PRIVATE_/);
      assert.equal(messages[1].model_error_status,502);
    }
  }
});

test('legacy compacted errors recover the original category only from their own request and session',async()=>{
  const f=fixture(),id=f.api.list().activeId,key='being-desktop-sessions-v1:/loom/Being';
  const raw='LLM API error 502 Bad Gateway: '+JSON.stringify({error:{type:'orchestration_policy_error',code:'worker_only'}});
  const content='模型接口请求失败（HTTP 502），Being 本轮回复已中断。';
  const session=JSON.parse(f.storage.get(key+':'+id));
  session.messages=[{role:'being',content,request_id:'matching',at:'2026-09-09T05:02:39.469Z'},{role:'being',content,at:'2026-09-09T05:02:39.469Z'},{role:'being',content,request_id:'other'}];
  f.storage.set(key+':'+id,JSON.stringify(session));
  for(const [sid,rid]of [[id,'matching'],['foreign','other']])f.storage.set(key+':events:'+sid+':delivery',JSON.stringify({requestId:rid,entries:[{event:'error',data:{message:raw}}]}));
  const next=fixture(f.storage),{messages}=await (await next.context.fetch('/api/history')).json();
  assert.equal(messages.length,2);
  assert.match(messages[0].content,/旧网关未区分/);assert.equal(messages[1].content,content);
});

test('worker review is stored for the original conversation once while another conversation is active',async()=>{
  const f=fixture(),original=f.api.list().activeId;
  f.api.change(null);const other=fixture(f.storage),selected=other.api.list().activeId;
  const review={sessionId:original,requestId:webcrypto.randomUUID(),status:'passed',summary:'Artifact verified.',evidence:'The worker read the expected content.'};
  assert.equal(await other.api.deliverWorkerReview(review),true);
  assert.equal(await other.api.deliverWorkerReview(review),true);
  const received=[...f.storage.entries()].filter(([key])=>key.includes(':reply:')).map(([,value])=>JSON.parse(value));
  assert.equal(received.length,1);assert.equal(received[0].session_id,original);assert.match(received[0].content,/Artifact verified/);
  assert.equal(other.api.list().activeId,selected);
  assert.equal(await other.api.deliverWorkerReview({...review,sessionId:webcrypto.randomUUID()}),false);
});

test('saved history repairs duplicate local receipts without merging user text or different requests',async()=>{
  const f=fixture(),id=f.api.list().activeId,key='being-desktop-sessions-v1:/loom/Being';
  const receipt={session_id:id,role:'being',request_id:webcrypto.randomUUID(),delivery_id:'worker-review:first',route_id:'first',content:'The same final result.',at:'2026-09-09T01:00:00Z'};
  const other={...receipt,request_id:webcrypto.randomUUID(),delivery_id:'worker-review:second',route_id:'second',at:'2026-09-09T02:00:00Z'};
  for(const item of [receipt,other])f.storage.set(key+':reply:'+item.route_id,JSON.stringify(item));
  const session=JSON.parse(f.storage.get(key+':'+id));
  session.messages=[{role:'user',content:receipt.content},receipt,{...receipt},other,{role:'being',request_id:webcrypto.randomUUID(),content:receipt.content},
    {...receipt,content:'Unrelated text with a legacy misplaced identifier.'}];
  f.storage.set(key+':'+id,JSON.stringify(session));
  const repaired=fixture(f.storage);
  const messages=JSON.parse(repaired.storage.get(key+':'+id)).messages;
  assert.equal(messages.length,5);assert.equal(messages[0].role,'user');
  assert.equal(messages.filter(item=>item.content===receipt.content).length,4);
  assert.equal(messages.at(-1).content,'Unrelated text with a legacy misplaced identifier.');
});

test('metadata-free copies of a unique worker receipt are repaired and stay repaired after reload',async()=>{
  const f=fixture(),id=f.api.list().activeId,key='being-desktop-sessions-v1:/loom/Being';
  const receipt={session_id:id,role:'being',request_id:webcrypto.randomUUID(),delivery_id:'worker-review:only',route_id:'only',content:'Unique worker summary.',at:'2026-09-09T01:00:00Z'};
  f.storage.set(key+':reply:only',JSON.stringify(receipt));
  const session=JSON.parse(f.storage.get(key+':'+id));
  session.messages=[{role:'user',content:receipt.content},receipt,...Array.from({length:6},()=>({role:'being',content:receipt.content,at:receipt.at}))];
  f.storage.set(key+':'+id,JSON.stringify(session));
  for(let reload=0;reload<3;reload++){
    fixture(f.storage);
    const messages=JSON.parse(f.storage.get(key+':'+id)).messages;
    assert.equal(messages.length,2);assert.equal(messages[1].delivery_id,receipt.delivery_id);
  }
});

test('unrouted streams expose only a generic activity phase, including empty incremental polls', async () => {
  const f = fixture();
  f.respond({stream_id:'unrouted',finished:false,events:[{seq:1,event:'tool_use',data:{name:'private-tool',input:{secret:'private-argument'}}}]});
  assert.equal((await f.context.fetch('/api/stream/active')).status,204);
  assert.equal(f.api.progress().phase,'tool');
  assert.equal(f.api.progress().owned,false);
  assert.doesNotMatch(JSON.stringify(f.api.progress()),/private/);
  f.respond({stream_id:'unrouted',finished:false,events:[]});
  await f.context.fetch('/api/stream/active?after=1');
  assert.equal(f.api.progress().phase,'tool');
  f.respond(new Response(null,{status:204}));
  await f.context.fetch('/api/stream/active');
  assert.equal(f.api.progress().finished,true);
  assert.equal(f.api.progress().phase,undefined);
});

test('every text and multimodal request carries the desktop origin without changing user content', async () => {
  const f = fixture();
  const content = [{type:'text',text:'去 Mac 上做'}, {type:'image',media_type:'image/png',data:'cGl4ZWxz'}];
  for (const body of [{message:'这台机器'}, {message:'下一条'}, {content}]) {
    await f.context.fetch('/api/chat/stream', {method:'POST',body:JSON.stringify(body)});
    const sent = JSON.parse(f.calls.at(-1).options.body);
    const text = sent.message || sent.content[0].text;
    assert.match(text, /消息来源：Being Desktop/);
    assert.match(text, /当前 Portal：being-desktop/);
    assert.match(text, /操作系统："Windows"/);
    assert.match(text, /主机名："CZ"/);
    assert.match(text, /place/);
    assert.match(text, /以用户指定为准/);
    assert.equal(text.split('[Being Desktop 当前消息环境]').length, 2);
    if (body.content) {
      assert.deepEqual(sent.content.slice(1), content);
      assert.equal(Object.hasOwn(sent, 'message'), false);
    } else assert.ok(sent.message.endsWith(body.message));
  }
  assert.ok([...f.storage.values()].every(value => !value.includes('当前消息环境')));
});
test('orchestrator requests carry only their own delegation scope and block incomplete initialization',async()=>{
  const f=fixture();f.context.__beingDesktopOrchestration={enabled:true};
  await assert.rejects(f.context.fetch('/api/chat/stream',{method:'POST',body:JSON.stringify({message:'task'})}),/初始化/);
  assert.equal(f.calls.length,0);
  const scope={enabled:true,sessionId:f.api.list().activeId,sessionToken:webcrypto.randomUUID(),defaultAgent:'codex'};
  f.context.__beingDesktopOrchestration=scope;
  await f.context.fetch('/api/chat/stream',{method:'POST',body:JSON.stringify({message:'task'})});
  const message=JSON.parse(f.calls.at(-1).options.body).message;
  assert.ok(message.includes(scope.sessionToken));assert.match(message,/desktop_worker_wait/);assert.match(message,/不得直接执行/);
  f.context.__beingDesktopOrchestration={enabled:false};
  await f.context.fetch('/api/chat/stream',{method:'POST',body:JSON.stringify({message:'normal'})});
  assert.ok(!JSON.parse(f.calls.at(-1).options.body).message.includes(scope.sessionToken));
});

test('Request inputs carry origin, while unrelated origins and Town sync remain untouched', async () => {
  const f = fixture();
  const url = 'https://fixture.invalid/api/chat/stream';
  await f.context.fetch(new Request(url, {method:'POST',body:JSON.stringify({message:'hello'})}));
  assert.match(JSON.parse(f.calls.at(-1).options.body).message, /当前 Portal：being-desktop/);
  for (const [target, message] of [['https://other.invalid/api/chat/stream', 'hello'], [url, '[Being Desktop Town sync: fixture]']]) {
    const body = JSON.stringify({message});
    await f.context.fetch(target, {method:'POST',body});
    assert.equal(f.calls.at(-1).options.body, body);
  }
});

test('production page initialization embeds host environment before Loom scripts run', async () => {
  const scripts = [];
  await prepareLoomSessions({getURL:()=> 'about:blank', debugger:{attach(){}, async sendCommand(method, params) {
    if (method === 'Page.addScriptToEvaluateOnNewDocument') scripts.push(params.source);
  }}});
  assert.ok(scripts[0].includes(JSON.stringify(desktopMessageContext())));
  assert.match(desktopMessageContext({platform:'darwin',hostname:'mac'}), /macOS/);
  assert.match(desktopMessageContext({platform:'linux',hostname:'host\nspoof'}), /host\\nspoof/);
});

test('separate UUIDs persist across reload and switching; unknown IDs fail', () => {
  const first = fixture();
  const original = first.api.list().activeId;
  first.api.change(null);
  const second = fixture(first.storage);
  assert.notEqual(second.api.list().activeId, original);
  assert.equal(second.api.list().items.length, 2);
  second.api.change(original);
  assert.equal(fixture(first.storage).api.list().activeId, original);
  assert.throws(()=>second.api.change('foreign'), /会话不存在/);
});

test('history routes by reply headers and ignores runtime session IDs and global messages', async () => {
  const f = fixture(), id = f.api.list().activeId;
  f.respond({messages:[{role:'being',session_id:'runtime',content:`会话id：${id}\nown`},{role:'being',session_id:id,content:'global'}]});
  const response = await f.context.fetch('/api/history?limit=100');
  assert.deepEqual((await response.json()).messages.map(m=>m.content), ['own']);
  assert.equal(new URL(f.calls[0].url).searchParams.has('session_id'), false);
  f.respond({stream_id:'global', events:[{seq:1,event:'content_block_delta',data:{delta:{text:`会话id：${id}\nrecovered`}}},{seq:2,event:'message_stop',data:{session_id:'runtime'}}]});
  assert.equal((await f.context.fetch('/api/stream/active')).status,200);
  f.respond({messages:[]});
  assert.deepEqual((await (await f.context.fetch('/api/history')).json()).messages.map(m=>m.content), ['own','recovered']);
});

test('new sessions inherit parent context without copying parent messages into their history', async () => {
  const f = fixture(), id = f.api.list().activeId;
  const key = [...f.storage.keys()][0];
  const saved = JSON.parse(f.storage.get(key));
  saved.messages = [{session_id:id, role:'user',content:'Our project is Being'}];
  f.storage.set(key,JSON.stringify(saved));
  fixture(f.storage).api.change(null);
  const child = fixture(f.storage);
  assert.deepEqual((await (await child.context.fetch('/api/history')).json()).messages, []);
  await child.context.fetch('/api/chat/stream',{method:'POST',body:JSON.stringify({message:'Continue',session_id:id})});
  const body = JSON.parse(child.calls.at(-1).options.body);
  assert.equal(body.session_id,id);
  assert.match(body.message,new RegExp(child.api.list().activeId));
  assert.match(body.message,/Our project is Being/);
  assert.match(body.message,/Continue/);
  await child.context.fetch('/api/chat/stream',{method:'POST',body:JSON.stringify({message:'Next'})});
  assert.match(JSON.parse(child.calls.at(-1).options.body).message,/Next$/);
});

test('reply on the wrong connection routes to its declared session, not its transport session', async () => {
  const f = fixture(), first=f.api.list().activeId, second=f.api.change(null);
  const source='event: content_block_delta\r\ndata: '+JSON.stringify({delta:{text:`会话id：${second}\nFor session two`}})+'\r\n\r\nevent: message_stop\r\ndata: '+JSON.stringify({session_id:first})+'\r\n\r\n';
  f.respond(new Response(new ReadableStream({start(controller){for(const char of source)controller.enqueue(new TextEncoder().encode(char));controller.close();}}),{headers:{'Content-Type':'text/event-stream'}}));
  const response=await f.context.fetch('/api/chat/stream',{method:'POST',body:'{"message":"Hello"}'});
  assert.doesNotMatch(await response.text(),/For session two/);
  f.respond({messages:[]});
  assert.deepEqual((await (await f.context.fetch('/api/history')).json()).messages,[]);
  const target=fixture(f.storage);
  assert.deepEqual((await (await target.context.fetch('/api/history')).json()).messages.map(m=>m.content),['For session two']);
});

test('inherited context preserves multimodal content without introducing a message override', async () => {
  const f = fixture(), key = [...f.storage.keys()][0];
  const saved = JSON.parse(f.storage.get(key));
  saved.messages = [{role:'user',content:'Keep the original design context'}];
  f.storage.set(key,JSON.stringify(saved));
  fixture(f.storage).api.change(null);
  const child = fixture(f.storage);
  const content = [{type:'text',text:'Review this image'}, {type:'image',media_type:'image/png',data:'cGl4ZWxz'}];
  await child.context.fetch('/api/chat/stream',{method:'POST',body:JSON.stringify({content})});
  const first = JSON.parse(child.calls.at(-1).options.body);
  assert.equal(Object.hasOwn(first,'message'),false);
  assert.equal(first.session_id,undefined);
  assert.match(first.content[1].text,new RegExp(child.api.list().activeId));
  assert.match(first.content[0].text,/Keep the original design context/);
  assert.deepEqual(first.content.slice(2),content);
  await child.context.fetch('/api/chat/stream',{method:'POST',body:JSON.stringify({content})});
  assert.deepEqual(JSON.parse(child.calls.at(-1).options.body).content.slice(1),content);
});

test('switching while streaming cannot reassign an in-flight reply', () => {
  const f=fixture();
  vm.runInContext('let isStreaming = true',f.context);
  const original=f.api.list().activeId;
  const next=f.api.change(null);
  assert.notEqual(next,original);
  assert.equal(f.api.list().activeId,original);
  assert.equal(f.api.list().items.length,2);
});

test('untagged and unknown replies are isolated; tool requests retain their original protocol', async () => {
  const f=fixture(), id=f.api.list().activeId;
  for(const text of ['No routing header', '会话id：00000000-0000-0000-0000-000000000000\nUnknown', '[Being Desktop Town sync:fixture] 已完成。']) {
    f.respond(new Response('event: content_block_delta\ndata: '+JSON.stringify({delta:{text}})+'\n\nevent: message_stop\ndata: '+JSON.stringify({session_id:id})+'\n\n',{headers:{'Content-Type':'text/event-stream'}}));
    assert.doesNotMatch(await (await f.context.fetch('/api/chat/stream',{method:'POST',body:'{"message":"hello"}'})).text(),/No routing|Unknown|已完成/);
  }
  f.respond({messages:[]});
  assert.deepEqual((await (await f.context.fetch('/api/history')).json()).messages,[]);
  assert.equal(f.api.list().routingWarning,true);
  const body=JSON.stringify({message:'[Being Desktop Town sync:fixture] Read the tool state'});
  await f.context.fetch('/api/chat/stream',{method:'POST',body});
  assert.equal(f.calls.at(-1).options.body,body);
});

test('repeated history and recovery receipts do not duplicate a routed reply', async () => {
  const f=fixture(), id=f.api.list().activeId;
  const record={role:'being',content:`会话id：${id}\n请求id：${webcrypto.randomUUID()}\nA single answer`};
  f.respond({messages:[record,record]});
  for(let i=0;i<3;i++)assert.equal((await (await f.context.fetch('/api/history')).json()).messages.length,1);
});

test('session failures cross the renderer boundary as safe, readable data', async () => {
  const f=fixture();
  const contents={executeJavaScript:code=>Promise.resolve(vm.runInContext(code,f.context))};
  let result;
  const original=f.api.list().activeId;
  f.context.localStorage.setItem=()=>{const error=new Error('private details');error.name='QuotaExceededError';throw error;};
  result=await changeLoomSession(contents,null);
  assert.match(result.message,/存储空间不足/);
  assert.equal(f.api.list().items.length,1);
  assert.equal(f.api.list().activeId,original);
  vm.runInContext('globalThis.__beingDesktopSessions=undefined',f.context);
  assert.match((await changeLoomSession(contents,null)).message,/尚未就绪/);
  assert.match((await changeLoomSession({executeJavaScript:()=>Promise.reject(new Error('target closed'))},null)).message,/正在加载或已关闭/);
});

test('routed streams preserve progress events and replay sequence numbers for the native watchdog',async()=>{
  const f=fixture(),id=f.api.list().activeId;
  const events=[['meta',{stream_id:'stream-progress'}],['thinking',{text:'working'}],['tool_use',{name:'read_fixture'}],['tool_result',{name:'read_fixture',is_error:false}],['content_block_delta',{delta:{text:`会话id：${id}\nVisible reply`}}],['usage',{tokens:10}],['message_stop',{}]];
  const wire=events.map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  f.respond(new Response(wire,{headers:{'Content-Type':'text/event-stream'}}));
  const filtered=await (await f.context.fetch('/api/chat/stream',{method:'POST',body:'{"message":"hello"}'})).text();
  assert.deepEqual([...filtered.matchAll(/event: (\w+)/g)].map(m=>m[1]),events.map(e=>e[0]));
  assert.doesNotMatch(filtered,/Visible reply/);
  f.respond({stream_id:'stream-progress',finished:false,next_seq:8,events:[{seq:7,event:'thinking',data:{text:'continuing'}}]});
  const probe=await f.context.fetch('/api/stream/active');
  assert.equal(probe.status,200,'An owned live stream must not look gone to the watchdog');
  assert.equal((await probe.json()).next_seq,8);
});

test('live interruption resumes from replay without duplicated prefixes or a new POST',async()=>{
  const f=fixture(),id=f.api.list().activeId;
  const first=`会话id：${id}\n请求id：${webcrypto.randomUUID()}\nFirst half`;
  const events=[{seq:1,event:'content_block_delta',data:{delta:{text:first}}}];
  f.respond(new Response(`event: meta\ndata: {"stream_id":"resume-1"}\n\nevent: content_block_delta\ndata: ${JSON.stringify(events[0].data)}\n\n`,{headers:{'Content-Type':'text/event-stream'}}));
  await assert.rejects((await f.context.fetch('/api/chat/stream',{method:'POST',body:'{"message":"hello"}'})).text(),{name:'TypeError'});
  events.push({seq:2,event:'content_block_delta',data:{delta:{text:' and recovered tail'}}},{seq:3,event:'message_stop',data:{}});
  f.respond({stream_id:'resume-1',finished:true,next_seq:4,events});
  const replay=await (await f.context.fetch('/api/stream/active?after=1')).json();
  assert.equal(replay.finished,true);assert.ok(replay.events.filter(e=>e.event==='content_block_delta').every(e=>e.data.delta.text===''));
  f.respond({messages:[]});
  assert.deepEqual((await (await f.context.fetch('/api/history')).json()).messages.map(m=>m.content),['First half and recovered tail']);
  assert.equal(f.calls.filter(c=>c.options?.method==='POST').length,1);
});

test('a final SSE frame without a trailing blank line still completes its routed reply',async()=>{
  const f=fixture(),id=f.api.list().activeId;
  f.respond(new Response(`event: content_block_delta\r\ndata: ${JSON.stringify({delta:{text:`会话id：${id}\nComplete`}})}\r\n\r\nevent: message_stop\r\ndata: {}`,{headers:{'Content-Type':'text/event-stream'}}));
  await (await f.context.fetch('/api/chat/stream',{method:'POST',body:'{"message":"hello"}'})).text();
  f.respond({messages:[]});assert.deepEqual((await (await f.context.fetch('/api/history')).json()).messages.map(m=>m.content),['Complete']);
});


test('renaming persists across pages and automatic naming never overwrites manual names', () => {
  const f=fixture(), id=f.api.list().activeId;
  assert.match(id,/^[0-9a-f-]{36}$/);
  const background=fixture(f.storage);
  assert.equal(f.api.rename(id,'修复登录',true),true);
  assert.equal(background.api.list().items[0].title,'修复登录');
  background.api.flush();
  assert.equal(f.api.list().items[0].title,'修复登录');
  background.api.rename(id,'我的登录任务');
  assert.equal(f.api.rename(id,'自动标题',true),false);
  f.api.flush();
  assert.equal(fixture(f.storage).api.list().items[0].title,'我的登录任务');
  assert.throws(()=>f.api.rename(id,'  '));
  assert.throws(()=>f.api.rename(id,'a\nb'));
  assert.throws(()=>f.api.rename('missing','name'));
  const next=f.api.change(null);
  f.api.rename(next,'第二个任务');
  f.api.flush();
  assert.equal(f.api.list().items.find(item=>item.id===next).title,'第二个任务');
});

test('automatic title input is sent once in orchestration and preserves the raw user message',async()=>{
  const f=fixture(), inputs=[];
  f.context.__beingDesktopEnvironment=async(id,input)=>{inputs.push(input);return '';};
  const send=message=>f.context.fetch('/api/chat/stream',{method:'POST',body:JSON.stringify({message})});
  await send('普通消息');assert.equal(inputs.at(-1),'');
  f.context.__beingDesktopOrchestration={enabled:true,sessionId:f.api.list().activeId,sessionToken:webcrypto.randomUUID()};
  await send('整理登录流程');assert.equal(inputs.at(-1),'整理登录流程');
  await send('补充说明');assert.equal(inputs.at(-1),'');
});
