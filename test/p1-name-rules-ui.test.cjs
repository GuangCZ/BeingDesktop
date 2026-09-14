'use strict';
// Component harness: real renderer controllers, deterministic DOM, and in-memory IPC/HTTP.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const {TownClient} = require('../src/town-client.cjs');
const {normalizeComposerData} = require('../src/loom-composer.cjs');
const M = require('../renderer/town-mentions.js'), H = require('../renderer/composer-helpers.js');
const choices = [{town_id:'t_a',display_name:'Shared'},{town_id:'t_b',display_name:'Shared'}];
const warnings = [{mention:'@Shared',reason:'ambiguous',candidates:choices}];
class Event {
  constructor(type, fields={}) { this.type=type;Object.assign(this,fields); }
  preventDefault(){this.defaultPrevented=true;}
}
function dom() {
  const document={activeElement:null};
  class Element {
    constructor(tag){this.ownerDocument=document;this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};this.listeners={};this.hidden=false;this.className='';this.value='';this.selectionStart=this.selectionEnd=0;this._text='';
      this.classList={contains:name=>this.className.split(' ').includes(name),toggle:(name,force)=>{const set=new Set(this.className.split(' ').filter(Boolean));if(force??!set.has(name))set.add(name);else set.delete(name);this.className=[...set].join(' ');},add:name=>this.classList.toggle(name,true),remove:name=>this.classList.toggle(name,false)};
    }
    append(...nodes){for(const child of nodes){this.children.push(child);child.parentElement=this;}}
    replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}
    set textContent(value){this.children=[];this._text=String(value??'');}
    get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
    setAttribute(key,value){this.attributes[key]=String(value);}
    getAttribute(key){return this.attributes[key]??null;}
    removeAttribute(key){delete this.attributes[key];}
    addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);}
    dispatchEvent(event){for(const fn of this.listeners[event.type]||[])fn(event);return !event.defaultPrevented;}
    click(){this.dispatchEvent(new Event('click',{isTrusted:true}));}
    focus(){document.activeElement=this;}
    contains(target){return this===target||this.children.some(child=>child.contains(target));}
    setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
    setRangeText(text,start,end){this.value=this.value.slice(0,start)+text+this.value.slice(end);this.setSelectionRange(start+text.length,start+text.length);}
    scrollIntoView(){}
    remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);}
    querySelectorAll(selector){
      const matches=node=>{
        const attr=/^\[([^=]+)="([^"]*)"\]$/.exec(selector);
        if(attr)return (attr[1]==='data-index'?node.dataset.index:node.getAttribute(attr[1]))===attr[2];
        if(selector.startsWith('.'))return node.classList.contains(selector.slice(1));
        return node.tagName===selector.toUpperCase();
      };
      const all=[];const visit=node=>{for(const child of node.children){if(matches(child))all.push(child);visit(child);}};visit(this);return all;
    }
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  }
  document.createElement=tag=>new Element(tag);document.createElementNS=(_,tag)=>new Element(tag);document.documentElement=new Element('html');
  return {document,element:tag=>new Element(tag)};
}
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
async function nativeFixture() {
  const {document,element}=dom(),input=element('textarea'),composer=element('form'),area=element('div');composer.append(input);area.append(composer);
  let clock=1000,active='session-a',invalidated;
  const calls=[],loads=[],toasts=[];
  let raw={kits:[],members:[{id:'t_unique',name:'Neuromancer'},{id:'t_a',name:'Shared'},{id:'t_b',name:'Shared'}]};
  const bridge={getChatComposerData:async options=>{loads.push(options);return {...normalizeComposerData(raw),connectionRevision:1,expiresAt:clock+60000,revision:1};},sendBonfireMessage:async value=>{calls.push(value);return {ok:true,id:'17',mentions:[],mention_warnings:warnings};},onTownMembersInvalidated:callback=>{invalidated=callback;}};
  class Clock extends Date {static now(){return clock;}}
  const window={beingComposerHelpers:H,beingTownMentions:M,beingShell:{toast:(message,error)=>toasts.push({message,error})}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/chat-composer.js'),'utf8'),{window,document,Event,Date:Clock,setTimeout,crypto:{randomUUID}});
  const controller=window.beingChatComposer.install({input,composer,area,getBridge:()=>bridge,getSession:()=>active});input.focus();
  const state={connection:{status:'connected',beingName:'cz_being'},settings:{chatMode:'native'},townApp:{identity:{connectionRevision:1},memberDirectory:{revision:1}}};
  controller.sync(state);await flush();
  return {controller,input,composer,area,bridge,calls,loads,toasts,state,draft(value){input.value=value;input.setSelectionRange(value.length,value.length);input.focus();input.dispatchEvent(new Event('input'));},advance(ms){clock+=ms;},members(value){raw={...raw,members:value};},invalidate(){invalidated();},switch(){active='session-b';controller.sync(state);}};
}
test('P1 SDK -> preload -> native composer exposes published status and warning candidates without reposting',async()=>{
  const f=await nativeFixture();let posts=0,api;
  const client=new TownClient({getContext:()=>({key:'one',beingId:'cz_being',revision:1,connected:true}),store:{loadCredential:async()=>({token:'a'.repeat(64),townId:'t_self'})},fetchImpl:async(url,options)=>{
    const value=new URL(url).pathname==='/api/bonfire/mentions'?{town_id:'t_self',mentions:[]}:{ok:true,town_id:'t_self',seq:17,mentions:['t_unique'],mention_warnings:warnings};if(options.method==='POST')posts++;
    return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  }});
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/preload.cjs'),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(_,value)=>{api=value;}},ipcRenderer:{on(){},removeListener(){},invoke:async(_name,value)=>client.speak({kind:'bonfire',message:value.content})}})});
  f.bridge.sendBonfireMessage=api.sendBonfireMessage;
  f.draft('@Neuromancer hello');const plan=f.controller.prepare(f.input.value,{isTrusted:true});assert.equal(plan.raw,'@t_unique hello');
  await f.controller.publish(plan,{ok:true,streamed:true});
  const status=f.area.children.find(child=>child.getAttribute('role')==='status');
  assert.equal(status.hidden,false);assert.match(status.textContent,/消息已公开到篝火/);assert.match(status.textContent,/提及有歧义/);assert.match(status.textContent,/Shared · t_a/);assert.match(status.textContent,/Shared · t_b/);
  assert.equal(status.querySelectorAll('button').length,0);assert.equal(posts,1);assert.ok(f.toasts.every(t=>!t.error));
});
test('P1 native pre-send ambiguity binds the chosen Town ID while displaying its name',async()=>{
  const f=await nativeFixture();f.draft('@Shared hello');
  assert.throws(()=>f.controller.prepare(f.input.value,{isTrusted:true}),/歧义/);
  const menu=f.composer.querySelector('.chat-composer-menu'),options=menu.querySelectorAll('[role="option"]');
  assert.equal(menu.hidden,false);assert.equal(options.length,2);assert.match(options[0].textContent,/@t_a/);assert.match(options[1].textContent,/@t_b/);assert.equal(f.calls.length,0);
  options[1].click();assert.equal(f.input.value,'@Shared hello');assert.equal(f.calls.length,0);
  const plan=f.controller.prepare(f.input.value,{isTrusted:true});
  assert.deepEqual(plan.members,['t_b']);assert.equal(plan.raw,'@t_b hello');
});
test('P1 unresolvable native name remains original and warns that notification may not fire',async()=>{
  const f=await nativeFixture();f.draft('@unknown hello');const plan=f.controller.prepare(f.input.value,{isTrusted:true});
  assert.equal(plan.text,'@unknown hello');assert.equal(plan.raw,'@unknown hello');assert.deepEqual(plan.members,[]);assert.match(f.toasts.at(-1).message,/可能不会触发通知/);
  await f.controller.publish(plan,{ok:true,streamed:true});assert.equal(f.calls.length,0);
});
test('P1 an unavailable native directory preserves the raw message and warns without publishing it',async()=>{
  const f=await nativeFixture();f.bridge.getChatComposerData=async()=>{throw new Error('fixture offline');};f.invalidate();await flush();
  f.draft('@Neuromancer hello');await flush();
  const plan=f.controller.prepare(f.input.value,{isTrusted:true});
  assert.equal(plan.text,'@Neuromancer hello');assert.equal(plan.raw,'@Neuromancer hello');assert.deepEqual(plan.members,[]);
  assert.match(f.toasts.at(-1).message,/可能不会触发通知/);
  await f.controller.publish(plan,{ok:true,streamed:true});assert.equal(f.calls.length,0);await flush();
});
test('P1 member expiry and rename notification refresh the directory without showing a healthy-state retry button',async()=>{
  const f=await nativeFixture();f.members([{id:'t_unique',name:'Renamed'}]);f.advance(60001);f.draft('@');await flush();
  assert.match(f.composer.textContent,/Renamed/);assert.doesNotMatch(f.composer.textContent,/Neuromancer/);
  assert.equal(f.composer.querySelector('.chat-composer-retry'),null);
  f.members([{id:'t_unique',name:'Again'}]);f.invalidate();await flush();assert.match(f.composer.textContent,/Again/);assert.doesNotMatch(f.composer.textContent,/Renamed/);
});
test('P1 cached identities never make a synthetic native mention publishable',async()=>{
  const f=await nativeFixture();f.draft('@Neuromancer hello');assert.throws(()=>f.controller.prepare(f.input.value,{isTrusted:false}),/确认公开/);assert.equal(f.calls.length,0);
});
function townFixture(mode='bonfire') {
  const {document,element}=dom();const window={beingTownMentions:M,addEventListener(){}};
  // Expose component entrypoints in this VM only; production code remains unchanged.
  const source=fs.readFileSync(require.resolve('../renderer/town-app.js'),'utf8').replace('window.beingTownApp = Object.freeze({ init, setState, open, startOnboardingGreeting });',`window.fixture = {ui,model,sendBonfire,sendInboxMessage,renderBonfireComposer,renderInboxComposer,isMine,setup(value,adapter,mode){publicState=value;town=value.townApp;bridge=adapter;options={};root=document.createElement('main');current=mode;renderBonfire=renderBonfireComposer;requestReadOnce=async()=>{};}};`);
  vm.runInNewContext(source,{window,document,crypto:{randomUUID},Date,Map,Set});
  const fixture=window.fixture;
  for(const key of ['bonfireDraft','bonfireSend','bonfireSendLabel','bonfireFeedback','bonfireReceipt','bonfireMentions','bonfireReply','inboxRecipient','inboxDraft','inboxSend','inboxFeedback','inboxReply'])fixture.ui[key]=element(key.includes('Draft')?'textarea':'div');
  const calls=[];
  const bridge={sendBonfireMessage:async value=>{calls.push(value);return {ok:true,id:'17',mentions:[],mention_warnings:warnings};},sendDirectMessage:async value=>{calls.push(value);throw Object.assign(new Error('收件人有歧义；本次私信未发送。'),{code:'NOT_SENT',candidates:choices});}};
  const state={connection:{status:'connected'},townApp:{identity:{loomBeingId:'cz_being',beingId:'cz_being',townId:'t_self',connectionRevision:1},client:{paired:true},access:{}}};
  fixture.setup(state,bridge,mode);
  fixture.model.bonfire.members=[{id:'t_a',name:'Shared'},{id:'t_b',name:'Shared'},{id:'t_unique',name:'Neuromancer'}];fixture.model.bonfire.membersExpiresAt=Date.now()+60000;
  return {...fixture,calls,bridge,state};
}
test('P1 Bonfire success clears the draft, lists warnings and cannot resend on a second empty submit',async()=>{
  const f=townFixture();f.model.bonfire.draft='@Neuromancer hello';f.ui.bonfireDraft.value=f.model.bonfire.draft;
  await f.sendBonfire();assert.equal(f.calls.length,1);assert.equal(f.calls[0].content,'@t_unique hello');assert.equal(f.model.bonfire.draft,'');assert.equal(f.model.bonfire.sendRequest,null);
  assert.match(f.ui.bonfireReceipt.textContent,/消息已发布/);assert.match(f.ui.bonfireReceipt.textContent,/Shared · t_a/);assert.match(f.ui.bonfireReceipt.textContent,/Shared · t_b/);
  await f.sendBonfire();assert.equal(f.calls.length,1);
});
test('P1 Bonfire manual duplicate name opens its existing picker without posting',async()=>{
  const f=townFixture();f.model.bonfire.draft='@Shared hello';f.ui.bonfireDraft.value=f.model.bonfire.draft;
  await f.sendBonfire();assert.equal(f.calls.length,0);assert.equal(f.ui.bonfireMentions.hidden,false);assert.equal(f.ui.bonfireMentions.querySelectorAll('button').length,2);
  f.ui.bonfireMentions.querySelectorAll('button')[1].click();assert.equal(f.calls.length,0);assert.equal(f.model.bonfire.draft,'@t_b  hello');
});
test('P1 repeated Bonfire submit during directory refresh performs only one publication',async()=>{
  const f=townFixture();let release;
  const directory=new Promise(resolve=>{release=resolve;});
  f.bridge.getBeingMembers=async()=>directory;f.model.bonfire.membersExpiresAt=0;
  f.model.bonfire.draft='@Neuromancer hello';f.ui.bonfireDraft.value=f.model.bonfire.draft;
  const first=f.sendBonfire(),second=f.sendBonfire();assert.equal(f.calls.length,0);
  release({members:f.model.bonfire.members,expiresAt:Date.now()+60000});await Promise.all([first,second]);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].content,'@t_unique hello');assert.equal(f.model.bonfire.draft,'');
});
test('P1 private ambiguity shows display_name + town_id choices and keeps the original draft',async()=>{
  const f=townFixture('inbox');f.model.inbox.recipient='Shared';f.model.inbox.draft='private fixture';f.ui.inboxDraft.value='private fixture';
  await f.sendInboxMessage();assert.equal(f.calls.length,1);assert.equal(f.model.inbox.draft,'private fixture');
  assert.match(f.ui.inboxFeedback.textContent,/未发送/);assert.match(f.ui.inboxFeedback.textContent,/Shared · t_a/);assert.match(f.ui.inboxFeedback.textContent,/Shared · t_b/);
  f.ui.inboxFeedback.querySelectorAll('button')[1].click();assert.equal(f.model.inbox.recipient,'t_b');assert.equal(f.model.inbox.draft,'private fixture');assert.equal(f.calls.length,1);
});
test('P1 Town UI self-attribution does not compare Loom IDs or display names with message authors',()=>{
  const f=townFixture();assert.equal(f.isMine('t_self'),true);assert.equal(f.isMine('cz_being'),false);assert.equal(f.isMine('Neuromancer'),false);
  f.state.townApp.identity.townId='';assert.equal(f.isMine(''),false);assert.equal(f.isMine('cz_being'),false);
});
test('P1 warning candidate markup remains inert text in the shared UI component',()=>{
  const {element}=dom(),target=element('div');
  M.renderReceipt(target,{mention_warnings:[{mention:'@x',candidates:[{town_id:'t_a',display_name:'<img src=x onerror=alert(1)>'}]}]});
  assert.equal(target.querySelectorAll('img').length,0);assert.match(target.textContent,/<img src=x onerror=alert\(1\)> · t_a/);
});
