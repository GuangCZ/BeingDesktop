'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {DesktopTerminalTools}=require('../src/desktop-terminal-tools.cjs');

function fixture() {
  const sessions=[],writes=[],shown=[],closed=[];
  const terminal={
    snapshot:()=>({sessions}),
    async create({cwd}) {const id=randomUUID();sessions.push({id,cwd,status:'running'});return {sessionId:id};},
    write(value) {writes.push(value);return {written:true};},
    readSince(id,afterSequence) {return {id,sequence:afterSequence+1,data:'fixture'};},
    activate() {},
    async close(id) {closed.push(id);sessions.splice(sessions.findIndex(item=>item.id===id),1);return {closed:true};},
  };
  const tools=new DesktopTerminalTools({getTerminal:()=>terminal,showTerminal:id=>shown.push(id)});
  const scope=tools.scope(randomUUID());
  return {tools,scope,sessions,writes,shown,closed,terminal};
}

test('the conversation shares one visible terminal and retried creates/writes execute once',async()=>{
  const f=fixture(),create={...f.scope,requestId:randomUUID(),cwd:'E:\\workspace'};
  const [first,duplicate]=await Promise.all([f.tools.invoke('desktop_terminal_create',create),f.tools.invoke('desktop_terminal_create',create)]);
  assert.equal(first.terminalId,duplicate.terminalId);assert.equal(f.sessions.length,1);assert.deepEqual(f.shown,[first.terminalId]);
  const write={...f.scope,terminalId:first.terminalId,requestId:randomUUID(),data:'Write-Output "hello"\r'};
  await f.tools.invoke('desktop_terminal_write',write);await f.tools.invoke('desktop_terminal_write',write);
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].data,write.data);
  await assert.rejects(f.tools.invoke('desktop_terminal_write',{...write,data:'different\r'}),/requestId/);
  assert.equal((await f.tools.invoke('desktop_terminal_read',{...f.scope,terminalId:first.terminalId,afterSequence:9})).sequence,10);
  assert.equal(f.closed.length,0,'Reply boundaries and read operations cannot close a terminal');
});

test('tokens, terminal ownership and identity reset prevent cross-conversation access',async()=>{
  const f=fixture(),first=await f.tools.invoke('desktop_terminal_create',{...f.scope,requestId:randomUUID()});
  const other=f.tools.scope(randomUUID());
  assert.deepEqual(await f.tools.invoke('desktop_terminal_list',other),{sessions:[]});
  for(const name of ['desktop_terminal_read','desktop_terminal_write','desktop_terminal_show','desktop_terminal_close']) {
    await assert.rejects(f.tools.invoke(name,{...other,terminalId:first.terminalId,requestId:randomUUID(),data:'x'}),/本会话/);
    await assert.rejects(f.tools.invoke(name,{...f.scope,sessionToken:randomUUID(),terminalId:first.terminalId}),/会话绑定/);
  }
  f.sessions.push({id:'human-terminal',status:'running'});
  await assert.rejects(f.tools.invoke('desktop_terminal_read',{...f.scope,terminalId:'human-terminal'}),/本会话/);
  f.tools.reset();
  await assert.rejects(f.tools.invoke('desktop_terminal_read',{...f.scope,terminalId:first.terminalId}),/会话绑定/);
  assert.equal(f.sessions.length,2,'Revoking tool ownership leaves user-visible processes available');
});

test('cancellation before creation never spawns, and reset during creation cleans only its new terminal',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();
  await assert.rejects(f.tools.invoke('desktop_terminal_create',{...f.scope,requestId:randomUUID()},{signal:controller.signal}));
  assert.equal(f.sessions.length,0);
  const original=f.terminal.create;let release;
  f.terminal.create=async args=>{await new Promise(resolve=>{release=resolve;});return original(args);};
  const creating=f.tools.invoke('desktop_terminal_create',{...f.scope,requestId:randomUUID()});
  await new Promise(resolve=>setImmediate(resolve));f.tools.reset();release();
  await assert.rejects(creating,/会话绑定/);assert.equal(f.sessions.length,0);assert.equal(f.closed.length,1);
});

test('explicit close is idempotent and cannot reuse a write request ID',async()=>{
  const f=fixture(),created=await f.tools.invoke('desktop_terminal_create',{...f.scope,requestId:randomUUID()});
  const args={...f.scope,terminalId:created.terminalId,requestId:randomUUID()};
  await f.tools.invoke('desktop_terminal_close',args);await f.tools.invoke('desktop_terminal_close',args);
  assert.equal(f.closed.length,1);
});
