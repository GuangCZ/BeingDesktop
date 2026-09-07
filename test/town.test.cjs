'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const {getTownCatalog,townPageUrl,prepareTownFeature,prepareTownAssistance,prepareFiresideDraft} = require('../src/town.cjs');

function fixture({draft='',readyState='complete',url='https://loom.example/being/?token=not-for-the-catalog'}={}) {
  const events = [];
  let submissions = 0, executions = 0;
  const field = {tagName:'TEXTAREA',value:draft,disabled:false,readOnly:false,
    dispatchEvent(event){events.push({type:event.type,bubbles:event.bubbles});return true;},focus(){events.push({type:'focus'});}};
  const send = {click(){submissions++;}};
  const messages = {};
  const row = {contains(value){return value === field || value === send;}};
  const app = {contains(value){return value === row || value === messages;}};
  const elements = {app,messages,'input-row':row,input:field,'send-btn':send};
  const sandbox = {document:{readyState,documentElement:{dataset:{}},getElementById(id){return elements[id];}},location:new URL(url),crypto:{randomUUID},Event:class {constructor(type,options){this.type=type;this.bubbles=options.bubbles;}}};
  const connection = {displayUrl:'https://loom.example/being/',url};
  const frame = {isDestroyed:()=>false,detached:false,
    async executeJavaScript(script){assert.equal(this,frame);executions++;return vm.runInNewContext(script,sandbox);}};
  const contents = {mainFrame:frame,isDestroyed:()=>false,isLoadingMainFrame:()=>false,getURL:()=>url,
    executeJavaScript(){assert.fail('Drafts must execute on the captured frame, not WebContents');}};
  let context = {connection,view:{webContents:contents},generation:4,revision:2,configured:true,status:'connected',exiting:false};
  return {field,elements,sandbox,contents,frame,events,getContext:()=>({...context}),change:patch=>{context={...context,...patch};},get submissions(){return submissions;},get executions(){return executions;}};
}

test('Town catalog exposes nine navigation features and only public static URLs',()=>{
  const catalog = getTownCatalog();
  assert.deepEqual(catalog.features.map(item=>item.id).sort(),['scroll','ember','bonfire','fireside','beings','grove','portal','channel','workspace'].sort());
  assert.equal(catalog.checkedAt,'2026-09-06');
  assert.equal(catalog.sourceUrl,'https://beings.town/');
  const publicUrls = [catalog.sourceUrl,...catalog.features.filter(item=>item.url).map(item=>item.url)];
  assert.deepEqual(publicUrls.sort(),['https://beings.town/','https://beings.town/embers','https://beings.town/grove'].sort());
  for (const value of publicUrls) {
    const url = new URL(value);
    assert.equal(url.protocol,'https:');assert.equal(url.host,'beings.town');
    assert.equal(url.search,'');assert.equal(url.hash,'');assert.equal(url.username,'');assert.equal(url.password,'');
  }
  assert.deepEqual(catalog.features.filter(item=>item.mode==='app').map(item=>item.id).sort(),['beings','bonfire','channel','fireside','grove','portal','scroll']);
  assert.equal(catalog.features.filter(item=>item.mode==='being').length,1);
  assert.deepEqual(catalog.features.filter(item=>item.mode==='web').map(item=>item.id),['ember']);
  assert.notEqual(catalog.features.find(item=>item.id==='fireside').description,catalog.features.find(item=>item.id==='bonfire').description);
  catalog.features[0].url='https://evil.example/';
  catalog.features.splice(1);
  assert.equal(getTownCatalog().features.length,9);
  assert.equal(getTownCatalog().features[0].url,undefined);
});

test('Town public page whitelist rejects URLs, credential parameters and prototype keys',()=>{
  assert.equal(townPageUrl('home'),'https://beings.town/');
  assert.equal(townPageUrl('grove'),'https://beings.town/grove');
  assert.equal(townPageUrl('ember'),'https://beings.town/embers');
  for (const id of [null,undefined,{},['grove'],42,'','Grove','__proto__','constructor','toString','grove?token=secret','https://beings.town/grove','javascript:alert(1)','../grove','embers','portal','scroll','a'.repeat(500)]) {
    assert.throws(()=>townPageUrl(id),Error);
  }
});

test('draft preparation rejects unknown and non-being IDs before evaluating page code',async()=>{
  const loom = fixture();
  for (const id of [null,{},['search'],'__proto__','constructor','search;alert(1)','https://evil.example/','home','grove','ember','portal','Search']) {
    await assert.rejects(prepareTownFeature(id,loom.getContext));
  }
  assert.equal(loom.executions,0);
  assert.equal(loom.field.value,'');
});

test('each Being feature fills a fixed draft and only emits input without sending',async()=>{
  const drafts = [];
  for (const feature of getTownCatalog().features.filter(item=>item.mode==='being')) {
    const loom = fixture();
    assert.deepEqual(await prepareTownFeature(feature.id,loom.getContext),{prepared:true});
    assert.ok(loom.field.value.length>20);
    assert.ok(loom.field.value.includes(feature.name));
    assert.deepEqual(loom.events,[{type:'input',bubbles:true},{type:'focus'}]);
    assert.equal(loom.submissions,0);
    drafts.push(loom.field.value);
  }
  assert.equal(new Set(drafts).size,drafts.length);
});

test('moved capabilities retain legacy draft IPC without restoring old navigation entries',async()=>{
  const modes = {fireside:'app', search:undefined, browse:undefined};
  for (const id of ['fireside','search','browse']) {
    assert.equal(getTownCatalog().features.find(feature=>feature.id===id)?.mode,modes[id]);
    const loom = fixture();
    assert.deepEqual(await prepareTownFeature(id,loom.getContext),{prepared:true});
    assert.ok(loom.field.value.includes(id[0].toUpperCase()+id.slice(1)));
    assert.deepEqual(loom.events,[{type:'input',bubbles:true},{type:'focus'}]);
    assert.equal(loom.submissions,0);
  }
});

test('Channel and Bonfire cannot fall back to asking Being through legacy draft IPC',async()=>{
  const loom=fixture();
  for (const id of ['channel','bonfire']) await assert.rejects(prepareTownFeature(id,loom.getContext));
  for (const operation of ['channel-feishu','channel-wechat','channel-status']) await assert.rejects(prepareTownAssistance({operation},loom.getContext));
  assert.equal(loom.executions,0);
  assert.equal(loom.submissions,0);
});

test('each native module assistance operation prepares only its fixed draft without sending',async()=>{
  const operations=['fireside-list','fireside-create','fireside-join','fireside-send','grove-register','portal-setup'];
  const drafts=[];
  for(const operation of operations){
    const loom=fixture();
    assert.deepEqual(await prepareTownAssistance({operation},loom.getContext),{prepared:true});
    assert.ok(loom.field.value.length>35);
    assert.deepEqual(loom.events,[{type:'input',bubbles:true},{type:'focus'}]);
    assert.equal(loom.submissions,0);
    drafts.push(loom.field.value);
  }
  assert.equal(new Set(drafts).size,operations.length);
});

test('module assistance preserves existing drafts and requires a connected Loom document',async()=>{
  for(const draft of ['my unsent text',' \n\t']){
    const loom=fixture({draft});
    await assert.rejects(prepareTownAssistance({operation:'fireside-send'},loom.getContext),/已有草稿.*已保留原文/);
    assert.equal(loom.field.value,draft);assert.deepEqual(loom.events,[]);assert.equal(loom.submissions,0);
  }
  const loom=fixture();loom.change({connection:null});
  await assert.rejects(prepareTownAssistance({operation:'fireside-list'},loom.getContext),/请先连接/);
  assert.equal(loom.executions,0);
});

test('module assistance rejects arbitrary prompts, extra keys and accessor objects before page evaluation',async()=>{
  let getters=0;
  const accessor=Object.defineProperty({},'operation',{enumerable:true,get(){getters++;return 'fireside-send';}});
  const symbol=Symbol('hidden');
  const invalid=[undefined,null,[],1,'fireside-send',{}, {operation:'unknown'}, {operation:'fireside-send',message:'send arbitrary text'}, {operation:'fireside-send',token:'private'}, {operation:'fireside-send',[symbol]:true},accessor,Object.assign(Object.create(null),{operation:'fireside-send'}),Object.create({operation:'fireside-send'})];
  const loom=fixture();
  for(const value of invalid)await assert.rejects(prepareTownAssistance(value,loom.getContext),/有效的 Being 协助操作/);
  assert.equal(getters,0);assert.equal(loom.executions,0);assert.equal(loom.field.value,'');
});

test('Fireside handoff treats the exact user draft as data and only fills a Loom draft',async()=>{
  const loom=fixture();
  const draft='你好，"围炉"\n</script><img src=x onerror="globalThis.fixtureInjected=true"> ${notCode} `literal`';
  assert.deepEqual(await prepareFiresideDraft({draft,connectionRevision:4},loom.getContext),{prepared:true});
  assert.ok(loom.field.value.endsWith('\n\n'+draft));
  assert.match(loom.field.value,/尚未发送.*确认目标围炉/);
  assert.equal(loom.sandbox.fixtureInjected,undefined);
  assert.deepEqual(loom.events,[{type:'input',bubbles:true},{type:'focus'}]);
  assert.equal(loom.submissions,0);
});

test('Fireside handoff strictly validates its two data fields without invoking accessors',async()=>{
  let accesses=0;
  const accessor={connectionRevision:4};Object.defineProperty(accessor,'draft',{enumerable:true,get(){accesses++;return 'secret';}});
  const invalid=[null,undefined,[],{}, {draft:'x'}, {draft:'x',connectionRevision:'4'},{draft:'x',connectionRevision:-1},{draft:'x',connectionRevision:1.5},{draft:'x',connectionRevision:Infinity},{draft:'',connectionRevision:4},{draft:' \n',connectionRevision:4},{draft:'x'.repeat(32001),connectionRevision:4},{draft:42,connectionRevision:4},{draft:'x',connectionRevision:4,send:true},{draft:'x',connectionRevision:4,[Symbol('extra')]:true},Object.assign(Object.create(null),{draft:'x',connectionRevision:4}),accessor];
  const loom=fixture();
  for(const value of invalid)await assert.rejects(prepareFiresideDraft(value,loom.getContext),/有效的围炉协助草稿/);
  assert.equal(accesses,0);assert.equal(loom.executions,0);
});

test('Fireside handoff preserves existing Loom drafts and rejects stale connection revisions',async()=>{
  const loom=fixture({draft:'An existing Loom draft'});
  await assert.rejects(prepareFiresideDraft({draft:'new draft',connectionRevision:4},loom.getContext),/已有草稿.*已保留原文/);
  assert.equal(loom.field.value,'An existing Loom draft');assert.deepEqual(loom.events,[]);
  const stale=fixture();
  await assert.rejects(prepareFiresideDraft({draft:'new draft',connectionRevision:3},stale.getContext),/连接身份已变化/);
  assert.equal(stale.executions,0);assert.equal(stale.field.value,'');
});

test('Fireside handoff rejects a connection change during the document handshake before filling text',async()=>{
  for(const change of [{generation:5},{revision:3},{status:'disconnected'},{connection:null}]){
    const loom=fixture();const execute=loom.frame.executeJavaScript;
    loom.frame.executeJavaScript=async function(script){const result=await execute.call(this,script);loom.change(change);return result;};
    await assert.rejects(prepareFiresideDraft({draft:'local draft',connectionRevision:4},loom.getContext));
    assert.equal(loom.field.value,'');assert.deepEqual(loom.events,[]);assert.equal(loom.submissions,0);
  }
});

test('existing text and whitespace drafts are preserved with no input or focus event',async()=>{
  for (const draft of ['my unsent message',' \n\t','<script>alert(1)</script>']) {
    const loom = fixture({draft});
    await assert.rejects(prepareTownFeature('search',loom.getContext),/已有草稿.*已保留原文/);
    assert.equal(loom.field.value,draft);
    assert.deepEqual(loom.events,[]);
    assert.equal(loom.submissions,0);
  }
});

test('draft requires an active editable Loom document with the known structure',async()=>{
  for (const mutate of [
    loom=>{loom.sandbox.document.readyState='loading';},
    loom=>{delete loom.elements.messages;},
    loom=>{delete loom.elements['send-btn'];},
    loom=>{loom.elements.app.contains=()=>false;},
    loom=>{loom.elements['input-row'].contains=()=>false;},
    loom=>{loom.field.tagName='DIV';},
    loom=>{loom.field.disabled=true;},
    loom=>{loom.field.readOnly=true;},
    loom=>{loom.sandbox.location=new URL('https://loom.example/login');}
  ]) {
    const loom = fixture();mutate(loom);
    await assert.rejects(prepareTownFeature('scroll',loom.getContext),/未找到可用的 Loom 输入框|无法确认 Loom 当前文档/);
    assert.equal(loom.field.value,'');assert.deepEqual(loom.events,[]);
  }
});

test('disconnected, loading, exiting and foreign pages never receive a draft script',async()=>{
  for (const mutate of [
    loom=>loom.change({connection:null}),loom=>loom.change({configured:false}),
    loom=>loom.change({status:'connecting'}),loom=>loom.change({status:'error'}),
    loom=>loom.change({exiting:true}),loom=>loom.change({view:null}),
    loom=>{loom.contents.isDestroyed=()=>true;},loom=>{loom.contents.isLoadingMainFrame=()=>true;},
    loom=>{loom.frame.isDestroyed=()=>true;},loom=>{loom.frame.detached=true;},
    loom=>{loom.contents.mainFrame=null;},
    loom=>{loom.contents.getURL=()=> 'https://evil.example/being/';}
  ]) {
    const loom = fixture();mutate(loom);
    await assert.rejects(prepareTownFeature('search',loom.getContext));
    assert.equal(loom.executions,0);assert.equal(loom.field.value,'');
  }
});

test('an asynchronous result from an old view, generation or document is never accepted',async()=>{
  const changes = [{generation:5},{revision:3},{status:'error'},{connection:{displayUrl:'https://loom.example/other/'}},{view:{webContents:{isDestroyed:()=>false}}}]
    .map(patch=>loom=>loom.change(patch));
  changes.push(loom=>{loom.contents.mainFrame={...loom.frame};},loom=>{loom.frame.isDestroyed=()=>true;},loom=>{loom.frame.detached=true;});
  for (const phase of [1,2]) {
    for (const change of changes) {
      const loom = fixture();
      const execute = loom.frame.executeJavaScript;
      let complete, reached, calls = 0;
      const waiting = new Promise(resolve=>{reached=resolve;});
      loom.frame.executeJavaScript=function(script) {
        if (++calls === phase) return new Promise(resolve=>{complete=resolve;reached();});
        return execute.call(this,script);
      };
      const pending = prepareTownFeature('search',loom.getContext);
      await Promise.race([waiting,pending.then(()=>assert.fail('The chosen frame operation must be reached'))]);
      change(loom);complete(phase === 1 ? randomUUID() : 'prepared');
      await assert.rejects(pending);
    }
  }
  // Reuse the same frame and main-process revision, but replace its document
  // between the nonce read and the write. No input may reach the new document.
  for (const replacement of [{}, {beingDesktopTownDocument:randomUUID()}]) {
    const loom = fixture();
    const nextDocument = fixture();
    nextDocument.sandbox.document.documentElement.dataset = replacement;
    const execute = loom.frame.executeJavaScript;
    let calls = 0;
    loom.frame.executeJavaScript = async function(script) {
      if (++calls === 2) loom.sandbox.document = nextDocument.sandbox.document;
      return execute.call(this,script);
    };
    await assert.rejects(prepareTownFeature('search',loom.getContext),/未找到可用的 Loom 输入框/);
    assert.equal(calls,2);
    assert.equal(loom.field.value,'');
    assert.deepEqual(loom.events,[]);
    assert.equal(loom.submissions,0);
    assert.equal(nextDocument.field.value,'');
    assert.deepEqual(nextDocument.events,[]);
    assert.equal(nextDocument.submissions,0);
  }
  for (const invalid of ['not-a-uuid','private-token',{},null]) {
    const loom = fixture();
    let calls = 0;
    loom.frame.executeJavaScript = async()=>{calls++;return invalid;};
    await assert.rejects(prepareTownFeature('search',loom.getContext),/无法确认 Loom 当前文档/);
    assert.equal(calls,1);
    assert.equal(loom.field.value,'');
  }
});

test('page execution errors cannot leak page content or secrets through the native error',async()=>{
  const loom = fixture();
  loom.frame.executeJavaScript=async()=>{throw new Error('private-token page body');};
  await assert.rejects(prepareTownFeature('search',loom.getContext),error=>{
    assert.doesNotMatch(error.message,/private-token|page body/);
    assert.match(error.message,/无法确认 Loom 当前文档/);
    return true;
  });
});
