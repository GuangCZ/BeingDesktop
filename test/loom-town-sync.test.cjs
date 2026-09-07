'use strict';

const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const path = require('node:path');
const {normalizeTownSyncRecords, matchTownSyncMessage, applyLoomTownSync, detachLoomTownSync} = require('../src/loom-town-sync.cjs');
const record = () => {
  const requestId = randomUUID();
  return {requestId, route:'/api/bonfire/hear', beingId:'cz_being', prompt:`[Being Desktop Town sync:${requestId}]\n请读取 Town。\n只返回本轮 JSON。`};
};
const envelope = (item, extra = {}) => ({protocol:'being-town-agent-read/1', requestId:item.requestId, route:item.route, beingId:item.beingId, httpStatus:200, data:{messages:[],latestSeq:0}, ...extra});

if (!process.versions.electron) {
  const test = require('node:test');
  test('only explicit complete owned records enter the task registry; getters are not executed', () => {
    const valid = record();
    let invoked = 0;
    const getter = {...valid};
    Object.defineProperty(getter, 'prompt', {get(){invoked++;throw new Error('Getter executed');}});
    const inputs = [valid, getter, {...valid,requestId:'fake'}, {...valid,route:'/api/chat/stream'}, {...valid,beingId:'../other'}, {...valid,prompt:'Quoted '+valid.prompt}, {...valid,token:'not-allowed'}];
    Object.defineProperty(inputs, '7', {get(){invoked++;throw new Error('Array getter executed');}});
    assert.deepEqual(normalizeTownSyncRecords(inputs), [{...valid,prompt:valid.prompt.replace(/\s+/g,' ')}]);
    assert.equal(invoked,0);
    assert.deepEqual(normalizeTownSyncRecords([valid,{...valid,beingId:'another'}]),[]);
  });

  test('verified Scroll and Being read routes use the same enrolled task marker', () => {
    for (const route of ['/api/scrolls', '/api/scrolls/desktop-notes', '/api/beings']) {
      const own = {...record(), route}, records = normalizeTownSyncRecords([own]);
      assert.equal(records.length, 1);
      assert.deepEqual(matchTownSyncMessage('user', own.prompt, records), {requestId:own.requestId, kind:'request'});
      assert.deepEqual(matchTownSyncMessage('being', JSON.stringify(envelope(own)), records), {requestId:own.requestId, kind:'result'});
    }
    for (const route of ['/api/scrolls/help', '/api/scrolls/search', '/api/scrolls/a/b', '/api/scrolls/../private', '/api/scrolls/a?token=x', '/api/beings/private']) assert.deepEqual(normalizeTownSyncRecords([{...record(),route}]), []);
  });

  test('channel task projection requires its own protocol, exact registered identity and complete fixed JSON schema', () => {
    for (const channel of ['feishu','wechat']) for (const operation of ['begin','status']) {
      const own={...record(),route:`/desktop/channel/${channel}/${operation}`}, records=normalizeTownSyncRecords([own]);
      assert.equal(records.length,1);
      const data={protocol:'being-desktop-channel-result/1',requestId:own.requestId,route:own.route,beingId:own.beingId,channel,status:'pending',detail:'在渠道页继续操作'};
      assert.deepEqual(matchTownSyncMessage('being',JSON.stringify(data),records),{requestId:own.requestId,kind:'result'});
      assert.deepEqual(matchTownSyncMessage('user',own.prompt,records),{requestId:own.requestId,kind:'request'});
      assert.equal(matchTownSyncMessage('being',JSON.stringify(envelope(own)),records),null);
      for (const patch of [{requestId:randomUUID()}, {route:own.route+'/extra'}, {beingId:'other'}, {channel:'other'}, {status:'invented'}, {detail:null}, {qrCodeUrl:4}, {extra:'human prose'}, {protocol:'legacy'}]) assert.equal(matchTownSyncMessage('being',JSON.stringify({...data,...patch}),records),null);
      for (const key of Object.keys(data)) {const missing={...data};delete missing[key];assert.equal(matchTownSyncMessage('being',JSON.stringify(missing),records),null);}
      for (const message of ['请分析以下结果：'+JSON.stringify(data),JSON.stringify(data)+'\n用户追加问题',JSON.stringify(data).slice(0,-1)]) assert.equal(matchTownSyncMessage('being',message,records),null);
    }
    for (const route of ['/desktop/channel/wecom/begin','/desktop/channel/wechat/send','/desktop/channel/wechat/begin?extra=1']) assert.deepEqual(normalizeTownSyncRecords([{...record(),route}]),[]);
  });

  test('only the full registered prompt matches; quoted identifiers and ordinary user JSON remain visible', () => {
    const own = record(), other = record(), records = normalizeTownSyncRecords([own]);
    assert.deepEqual(matchTownSyncMessage('user',own.prompt,records),{requestId:own.requestId,kind:'request'});
    for(const text of [other.prompt, `看看 ${own.prompt}`, `${own.prompt}\n我还有个问题`, `[Being Desktop Town sync:${own.requestId}]`, JSON.stringify(envelope(own))]) assert.equal(matchTownSyncMessage('user',text,records),null);
    assert.equal(matchTownSyncMessage('being',own.prompt,records),null);
  });

  test('replies require exact protocol, known UUID, route, Being and complete JSON envelope', () => {
    const own=record(), records=normalizeTownSyncRecords([own]);
    assert.deepEqual(matchTownSyncMessage('being',JSON.stringify(envelope(own)),records),{requestId:own.requestId,kind:'result'});
    for(const patch of [{protocol:'other'},{requestId:randomUUID()},{route:'/api/fireside/list'},{beingId:'other'},{httpStatus:'200'},{httpStatus:99},{httpStatus:600},{data:null},{data:'result'},{additional:'prose'}]) assert.equal(matchTownSyncMessage('being',JSON.stringify(envelope(own,patch)),records),null);
    for(const text of ['not JSON',JSON.stringify(envelope(own)).slice(0,-1),`说明\n${JSON.stringify(envelope(own))}`,JSON.stringify([envelope(own)])]) assert.equal(matchTownSyncMessage('being',text,records),null);
    assert.equal(matchTownSyncMessage('system',JSON.stringify(envelope(own)),records),null);
  });

  test('only a registered completion acknowledgment belongs to a task after data moved to the tool mirror',()=>{
    const own=record(),records=normalizeTownSyncRecords([own]);
    assert.deepEqual(matchTownSyncMessage('being',`[Being Desktop Town sync:${own.requestId}] 已完成。`,records),{requestId:own.requestId,kind:'result'});
    assert.equal(matchTownSyncMessage('being',`[Being Desktop Town sync:${randomUUID()}] 已完成。`,records),null);
    assert.equal(matchTownSyncMessage('being',`[Being Desktop Town sync:${own.requestId}] 已完成，但请求失败`,records),null);
  });

  test('only exact enrolled failure and incomplete receipts are projected as task results',()=>{
    const own=record(), records=normalizeTownSyncRecords([own]);
    for (const receipt of ['失败。','结果不完整。']) {
      const message=`[Being Desktop Town sync:${own.requestId}] ${receipt}`;
      assert.deepEqual(matchTownSyncMessage('being',message,records),{requestId:own.requestId,kind:'result'});
      assert.equal(matchTownSyncMessage('user',message,records),null);
      assert.equal(matchTownSyncMessage('being',`[Being Desktop Town sync:${randomUUID()}] ${receipt}`,records),null);
      assert.equal(matchTownSyncMessage('being',`${message}\n我来回答刚才的问题`,records),null);
      assert.equal(matchTownSyncMessage('being',`示例：${message}`,records),null);
      assert.equal(matchTownSyncMessage('being',`\`${message}\``,records),null);
    }
    for (const receipt of ['失败了。','读取失败。','结果不完整，但可以继续。']) assert.equal(matchTownSyncMessage('being',`[Being Desktop Town sync:${own.requestId}] ${receipt}`,records),null);
  });

  test('registration is bounded and disposed web contents receive no injection', async () => {
    const items=Array.from({length:260},record);
    assert.deepEqual(normalizeTownSyncRecords(items).map(item=>item.requestId),items.slice(-256).map(item=>item.requestId));
    const contents={isDestroyed:()=>true,executeJavaScriptInIsolatedWorld(){throw new Error('Destroyed view used');}};
    assert.equal(await applyLoomTownSync(contents,items),false);
    await detachLoomTownSync(contents);
  });

  test('only Fireside list invitation-key redaction metadata may extend the result envelope', () => {
    const own={...record(),route:'/api/fireside/list'}, records=normalizeTownSyncRecords([own]);
    const valid={redactedFields:['data.owned[0].key','data.joined[12].key']};
    assert.deepEqual(matchTownSyncMessage('being',JSON.stringify(envelope(own,valid)),records),{requestId:own.requestId,kind:'result'});
    for(const fields of [[],['data.owned[0].key','data.owned[0].key']]) assert.ok(matchTownSyncMessage('being',JSON.stringify(envelope(own,{redactedFields:fields})),records));
    for(const fields of ['data.owned[0].key',['data.messages[0].message'],['data.owned[0].token'],['data.owned[0].key.extra'],['data.owned[-1].key'],['data.owned[01].key'],['data.owned[10000].key'],[{}],Array(4001).fill('data.owned[0].key')]) assert.equal(matchTownSyncMessage('being',JSON.stringify(envelope(own,{redactedFields:fields})),records),null);
    const other=record();
    assert.equal(matchTownSyncMessage('being',JSON.stringify(envelope(other,valid)),normalizeTownSyncRecords([other])),null);
  });

  test('isolated Electron projects owned final rows away without changing history, drafts, unknown tools, or quoted examples', async () => {
    const {spawn} = require('node:child_process');
    const env={...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(require('electron'),[__filename],{cwd:path.resolve(__dirname,'..'),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';
      child.stdout.on('data',chunk=>{stdout+=chunk;});
      child.stderr.on('data',chunk=>{stderr+=chunk;});
      child.once('error',reject);
      child.once('exit',code=>resolve({code,stdout,stderr}));
    });
    assert.equal(result.code,0,result.stderr);
    assert.match(result.stdout,/TOWN_SYNC_DOM_OK/);
  });
} else {
  const {app,BrowserWindow}=require('electron');
  const os=require('node:os');
  app.setPath('userData',path.join(os.tmpdir(),`being-town-sync-test-${randomUUID()}`));
  app.disableHardwareAcceleration();
  let win;
  app.whenReady().then(async()=>{
    const own=record(), other=record();
    win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    let networkCalls=0;
    win.webContents.session.webRequest.onBeforeRequest((request,callback)=>{
      if(!request.url.startsWith('data:text/html,')) {networkCalls++;callback({cancel:true});} else callback({});
    });
    await win.loadURL('data:text/html,'+encodeURIComponent('<!doctype html><meta charset="utf-8"><div id="app"><div id="messages"></div><div id="input-row"><textarea id="input"></textarea><button id="send-btn">发送</button></div></div>'));
    const execute=code=>win.webContents.executeJavaScript(code);
    const settle=()=>execute('new Promise(resolve=>setTimeout(resolve,0))');
    await execute(String.raw`(() => {
      const input=document.getElementById('input');input.value='保留这份草稿 /browse';input.focus();input.setSelectionRange(2,6);
      window.fixtureWrites=0;window.fixtureSends=0;window.fixtureEvents=0;
      const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value');
      Object.defineProperty(input,'value',{get(){return setter.get.call(this);},set(value){window.fixtureWrites++;setter.set.call(this,value);}});
      input.addEventListener('input',()=>window.fixtureEvents++);
      document.getElementById('send-btn').addEventListener('click',()=>window.fixtureSends++);
      window.fixtureAdd=(id,role,text,mode='plain')=>{
        const row=document.createElement('div');row.id=id;row.className='message '+role;
        const meta=document.createElement('div');meta.className='meta';meta.textContent=role;
        const content=document.createElement('div');content.className='content';
        if(mode==='stream')content.classList.add('stream-cursor');
        if(mode==='code'){
          const block=document.createElement('div');block.className='code-block';
          const label=document.createElement('div');label.className='code-lang';label.textContent='json';
          const pre=document.createElement('pre');const code=document.createElement('code');code.textContent=text;pre.append(code);block.append(label,pre);content.append(block);
        }else if(mode==='quote'){
          const quote=document.createElement('blockquote');quote.textContent=text;content.append(quote);
        }else {for(const line of text.split('\n')){const p=document.createElement('p');p.textContent=line;content.append(p);}}
        row.append(meta,content);document.getElementById('messages').append(row);return row;
      };
    })()`);
    const add=async(id,role,text,mode)=>{await execute(`window.fixtureAdd(${JSON.stringify(id)},${JSON.stringify(role)},${JSON.stringify(text)},${JSON.stringify(mode||'plain')})`);await settle();};
    const state=()=>execute(`(() => {
      const rows=Array.from(document.querySelectorAll('#messages > .message'));
      return {hidden:rows.filter(row=>row.classList.contains('being-desktop-town-task-hidden')).map(row=>row.id),buttons:document.querySelectorAll('.being-desktop-town-task-toggle').length,
        controlsVisible:Array.from(document.querySelectorAll('.being-desktop-town-task-controls')).filter(node=>!node.hidden).length,
        draft:document.getElementById('input').value,selection:[document.getElementById('input').selectionStart,document.getElementById('input').selectionEnd],focus:document.activeElement.id,
        writes:window.fixtureWrites,sends:window.fixtureSends,events:window.fixtureEvents,mainWorld:typeof window.__beingDesktopTownSync};
    })()`);
    await add('owned-prompt','user',own.prompt);
    await add('owned-json','being',JSON.stringify(envelope(own)));
    await add('normal-user','user','这是什么意思？');
    await add('unknown-id','user',other.prompt);
    await add('quote','user',own.prompt,'quote');
    await add('user-json','user',JSON.stringify(envelope(own)));
    await add('wrong-being','being',JSON.stringify(envelope(own,{beingId:'other'})));
    assert.equal(await applyLoomTownSync(win.webContents,[own]),true);
    await settle();
    let current=await state();
    assert.deepEqual(current.hidden,['owned-prompt','owned-json']);
    assert.equal(current.buttons,1);
    assert.equal(current.controlsVisible,1);
    assert.equal(current.draft,'保留这份草稿 /browse');
    assert.deepEqual(current.selection,[2,6]);
    assert.equal(current.focus,'input');
    assert.equal(current.writes+current.sends+current.events,0);
    assert.equal(current.mainWorld,'undefined');
    assert.equal(await execute("getComputedStyle(document.getElementById('owned-prompt')).display"),'none');
    assert.equal(await execute("document.querySelector('#owned-prompt > .meta').getClientRects().length"),0);
    assert.equal(await execute("document.querySelector('#owned-prompt > button')===null"),true);
    await execute("document.querySelector('.being-desktop-town-task-toggle').click()");
    await settle();
    assert.equal(await execute("document.querySelector('.being-desktop-town-task-toggle').getAttribute('aria-expanded')"),'true');
    assert.deepEqual((await state()).hidden,[]);
    assert.notEqual(await execute("getComputedStyle(document.getElementById('owned-prompt')).display"),'none');
    await applyLoomTownSync(win.webContents,[own]);
    await settle();
    assert.equal(await execute("document.querySelector('.being-desktop-town-task-toggle').getAttribute('aria-expanded')"),'true');
    assert.equal((await state()).buttons,1);
    await execute("document.querySelector('.being-desktop-town-task-toggle').click()");
    await settle();
    await add('streamed','being',JSON.stringify(envelope(own)),'stream');
    assert.ok(!(await state()).hidden.includes('streamed'));
    await execute("document.querySelector('#streamed > .content').classList.remove('stream-cursor')");
    await settle();
    assert.ok((await state()).hidden.includes('streamed'));
    await add('code-json','being',JSON.stringify(envelope(own)),'code');
    assert.ok(!(await state()).hidden.includes('code-json'));
    await add('owned-completion','being',`[Being Desktop Town sync:${own.requestId}] 已完成。`);
    assert.ok((await state()).hidden.includes('owned-completion'));
    await add('owned-failure','being',`[Being Desktop Town sync:${own.requestId}] 失败。`);
    await add('owned-incomplete','being',`[Being Desktop Town sync:${own.requestId}] 结果不完整。`);
    assert.ok((await state()).hidden.includes('owned-failure'));
    assert.ok((await state()).hidden.includes('owned-incomplete'));
    await add('failure-example','being',`[Being Desktop Town sync:${own.requestId}] 失败。`,'code');
    assert.ok(!(await state()).hidden.includes('failure-example'));
    await add('mixed-completion','being',`[Being Desktop Town sync:${own.requestId}] 已完成。\n另外，我来回答你的问题。`);
    await add('quoted-completion','being',`[Being Desktop Town sync:${own.requestId}] 已完成。`,'quote');
    await add('unknown-tool','tool','http https://beings.town/api/bonfire/hear');
    assert.ok(!(await state()).hidden.some(id=>['mixed-completion','quoted-completion','unknown-tool'].includes(id)));
    await add('prose-json','being','请查看下面的结果：'+JSON.stringify(envelope(own)));
    assert.ok(!(await state()).hidden.includes('prose-json'));
    await add('extra-content','user',own.prompt);
    await execute("document.getElementById('extra-content').append(document.createTextNode('另有用户补充')); ");
    await settle();
    assert.ok(!(await state()).hidden.includes('extra-content'));
    await execute("document.querySelector('#owned-json > .content').textContent='这是后续普通回复';");
    await settle();
    assert.ok(!(await state()).hidden.includes('owned-json'));
    assert.equal(await execute("document.querySelector('#owned-json > button')===null"),true);
    await execute("document.getElementById('streamed').remove()");
    await settle();
    await applyLoomTownSync(win.webContents,[]);
    await settle();
    assert.deepEqual((await state()).hidden,[]);
    assert.equal((await state()).controlsVisible,0);
    assert.equal(await execute("document.querySelector('#code-json code').textContent"),JSON.stringify(envelope(own)));
    await applyLoomTownSync(win.webContents,[own]);
    await settle();
    await detachLoomTownSync(win.webContents);
    await settle();
    current=await state();
    assert.equal(current.buttons,0);
    assert.deepEqual(current.hidden,[]);
    assert.equal(current.draft,'保留这份草稿 /browse');
    assert.deepEqual(current.selection,[2,6]);
    assert.equal(current.focus,'input');
    assert.equal(current.writes+current.sends+current.events,0);
    assert.equal(networkCalls,0);
    await add('after-detach','user',own.prompt);
    assert.equal((await state()).buttons,0);
    const channelOwn={...record(),route:'/desktop/channel/wechat/begin'};
    const channelResult={protocol:'being-desktop-channel-result/1',requestId:channelOwn.requestId,route:channelOwn.route,beingId:channelOwn.beingId,channel:'wechat',status:'pending',detail:'请在渠道页继续'};
    await applyLoomTownSync(win.webContents,[own,channelOwn]);
    await add('channel-prompt','user',channelOwn.prompt);
    await add('channel-result','being',JSON.stringify(channelResult));
    await add('channel-quote','being',JSON.stringify(channelResult),'quote');
    assert.ok((await state()).hidden.includes('channel-prompt'));
    assert.ok((await state()).hidden.includes('channel-result'));
    assert.ok(!(await state()).hidden.includes('channel-quote'));
    assert.equal((await state()).buttons,1);
    await applyLoomTownSync(win.webContents,[own]);
    await settle();
    assert.ok(!(await state()).hidden.includes('channel-result'));
    assert.ok((await state()).hidden.includes('after-detach'));
    await execute("const previousMessages=document.getElementById('messages');window.detachedMessages=previousMessages;const replacement=document.createElement('div');replacement.id='messages';previousMessages.replaceWith(replacement);");
    await settle();
    assert.equal((await state()).buttons,0);
    assert.equal(await execute("window.detachedMessages.querySelectorAll('.being-desktop-town-task-hidden').length"),0);
    await applyLoomTownSync(win.webContents,[own]);
    await add('replacement-owned','user',own.prompt);
    assert.deepEqual((await state()).hidden,['replacement-owned']);
    assert.equal((await state()).buttons,1);
    await detachLoomTownSync(win.webContents);
    process.stdout.write('TOWN_SYNC_DOM_OK\n');
    win.destroy();app.quit();
  }).catch(error=>{
    process.stderr.write(`${error.stack}\n`);
    if(win&&!win.isDestroyed())win.destroy();
    app.exit(1);
  });
}
