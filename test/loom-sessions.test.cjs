'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const {installSessions,changeLoomSession} = require('../src/loom-sessions.cjs');

function fixture(storage = new Map()) {
  const calls = [];
  let reply = {messages:[]};
  const context = vm.createContext({
    URL, Request, Response, TextDecoderStream, TextEncoderStream, TransformStream,
    crypto:webcrypto, location:{href:'https://fixture.invalid/loom/Being',origin:'https://fixture.invalid',pathname:'/loom/Being'},
    localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
    document:{addEventListener(){}},
    fetch:async(url,options)=>{calls.push({url:String(url),options});return reply instanceof Response ? reply : Response.json(reply);}
  });
  vm.runInContext('window=globalThis;window.top=window;', context);
  vm.runInContext(`(${installSessions.toString()})()`, context);
  return {context, storage, calls, api:context.__beingDesktopSessions, respond:value=>{reply=value;}};
}

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

test('history and recovery reject other sessions and untagged global messages', async () => {
  const f = fixture(), id = f.api.list().activeId;
  f.respond({messages:[{session_id:id,content:'own'},{session_id:'other',content:'foreign'},{content:'global'}]});
  const response = await f.context.fetch('/api/history?limit=100');
  assert.deepEqual((await response.json()).messages.map(m=>m.content), ['own']);
  assert.equal(new URL(f.calls[0].url).searchParams.get('session_id'), id);
  for (const data of [{stream_id:'global'}, {session_id:'other',events:[]}]) {
    f.respond(data);
    assert.equal((await f.context.fetch('/api/stream/active')).status, 204);
  }
  f.respond({session_id:id,events:[{data:{text:'own'}},{data:{session_id:'other',text:'foreign'}}]});
  assert.equal((await (await f.context.fetch('/api/stream/active')).json()).events.length, 1);
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
  assert.equal(body.session_id,child.api.list().activeId);
  assert.match(body.message,/Our project is Being/);
  assert.match(body.message,/Continue/);
  await child.context.fetch('/api/chat/stream',{method:'POST',body:JSON.stringify({message:'Next'})});
  assert.equal(JSON.parse(child.calls.at(-1).options.body).message,'Next');
});

test('foreign completion frames fail closed; valid SSE survives split CRLF boundaries', async () => {
  for (const foreign of [false,true]) {
    const f = fixture(), id = f.api.list().activeId;
    const source = 'event: message_stop\r\ndata: '+JSON.stringify({session_id:foreign?'other':id})+'\r\n\r\n';
    f.respond(new Response(new ReadableStream({start(controller){
      for(const character of source)controller.enqueue(new TextEncoder().encode(character));
      controller.close();
    }}),{headers:{'Content-Type':'text/event-stream'}}));
    const response = await f.context.fetch('/api/chat/stream',{method:'POST',body:'{"message":"Hello"}'});
    if(foreign)await assert.rejects(response.text(),/会话 ID 不匹配/);
    else assert.match(await response.text(), new RegExp(id));
  }
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
  assert.equal(first.session_id,child.api.list().activeId);
  assert.match(first.content[0].text,/Keep the original design context/);
  assert.deepEqual(first.content.slice(1),content);
  await child.context.fetch('/api/chat/stream',{method:'POST',body:JSON.stringify({content})});
  assert.deepEqual(JSON.parse(child.calls.at(-1).options.body).content,content);
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
