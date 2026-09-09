'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
(async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'portal-bound-binary-'));
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const config=path.join(root,'portal.toml');
  await fs.writeFile(config,`name="fixture-windows"\nbind="127.0.0.1:${port}"\nworkspace=${JSON.stringify(root)}\nkits_enabled=false\n`);
  const child=spawn(path.resolve(process.argv[2] || 'dist-target-binding/win-unpacked/resources/portal-target-binding/heart-portal.exe'),['--config',config],{windowsHide:true,stdio:'pipe'});
  let socket;
  try {
    for(let i=0;i<100;i++) {
      try {socket=await new Promise((resolve,reject)=>{const s=net.connect(port,'127.0.0.1',()=>resolve(s));s.once('error',reject);});break;}
      catch {await new Promise(resolve=>setTimeout(resolve,25));}
    }
    assert.ok(socket,'Portal did not listen');
    let buffer='',nextId=0;const pending=new Map();
    socket.on('data',chunk=>{buffer+=chunk;let boundary;while((boundary=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,boundary);buffer=buffer.slice(boundary+1);if(line.trim()){const reply=JSON.parse(line);pending.get(reply.id)?.(reply);pending.delete(reply.id);}}});
    const rpc=(method,params)=>new Promise(resolve=>{const id=++nextId;pending.set(id,resolve);socket.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
    const tools=(await rpc('tools/list',{})).result.tools;
    assert.ok(tools.length>0);
    for(const tool of tools){assert.ok(tool.inputSchema.required.includes('place'));assert.ok(tool.inputSchema.required.includes('target_portal'));assert.deepEqual(tool.inputSchema.properties.target_portal.enum,['fixture-windows']);}
    for(const place of [undefined,'fixture-mac']) {
      const reply=await rpc('tools/call',{name:'portal_file_write',arguments:{place:'fixture-windows',target_portal:place,path:'proof.txt',content:'bound'}});
      assert.equal(reply.error.code,-32602);
      await assert.rejects(fs.access(path.join(root,'proof.txt')));
    }
    const reply=await rpc('tools/call',{name:'portal_file_write',arguments:{target_portal:'fixture-windows',path:'proof.txt',content:'bound'}});
    assert.notEqual(reply.result.isError,true);
    assert.equal(JSON.parse(reply.result.content[0].text).execution_target.place,'fixture-windows');
    assert.equal(await fs.readFile(path.join(root,'proof.txt'),'utf8'),'bound');
    console.log('PASS: packaged Portal schemas, rejected targets without writes, successful bound write and receipt');
  } finally {socket?.destroy();child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
