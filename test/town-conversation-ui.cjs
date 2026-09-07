'use strict';

// Run with Electron. Every bridge call is an in-memory fixture; network access is blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { app, BrowserWindow } = require('electron');
const project = path.resolve(__dirname, '..');
const renderer = path.join(project, 'renderer');
const output = path.join(project, '.local', `town-conversation-${randomUUID()}`);
const report = { checks: [], screenshots: [], scope: 'Offline renderer fixture; no real messages, credentials or deployments.' };
let win;
let forbiddenRequests = 0;
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function execute(script) {
  assert.equal(win.webContents.getURL(), pathToFileURL(path.join(output, 'fixture.html')).href);
  return win.webContents.executeJavaScript(script);
}
async function check(name, script) {
  const result = await execute(script);
  report.checks.push({ name, passed: result === true });
  assert.equal(result, true, name);
  process.stdout.write(`${name}: passed\n`);
}
async function settle() { await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); }
async function capture(name) {
  // The renderer asset base must not redirect references to the fixture's inline sprite.
  await execute(`document.querySelectorAll('svg use[href^="#"]').forEach(use => use.setAttribute('href', location.href + use.getAttribute('href')))`);
  await settle();
  const image = await win.webContents.capturePage();
  const target = path.join(output, `${name}.png`);
  await fs.writeFile(target, image.toPNG());
  report.screenshots.push(target);
}

async function run() {
  await fs.mkdir(output, { recursive: true });
  const productionHtml = await fs.readFile(path.join(renderer, 'index.html'), 'utf8');
  const iconLibrary = productionHtml.match(/<svg\b[^>]*class="icon-library"[^>]*>[\s\S]*?<\/svg>/)?.[0];
  assert(iconLibrary, 'Production icon library must be available to the fixture');
  await fs.writeFile(path.join(output, 'fixture.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="${pathToFileURL(renderer + path.sep).href}"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="town-app.css"><style>html,body{margin:0;width:100%;height:100%}#page-town-app{height:100vh;width:100vw}.town-app [hidden]{display:none!important}</style><script src="town-app.js" defer></script></head><body>${iconLibrary}<main id="page-town-app"></main></body></html>`);
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1160, height: 850, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: `town-fixture-${randomUUID()}` } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    if (details.url.startsWith('file:')) {
      const file = fileURLToPath(details.url);
      allowed = file === path.join(output, 'fixture.html') || file.startsWith(renderer + path.sep);
    }
    if (!allowed) forbiddenRequests++;
    callback({ cancel: !allowed });
  });
  await win.loadFile(path.join(output, 'fixture.html'));
  await execute(`(async () => {
    const members = [{id:'alice',name:'Alice',description:'研究与写作'}, {id:'bob',name:'Bob',description:'产品与开发'}];
    window.fixture = {members,messages:[{id:1,beingId:'alice',beingName:'Alice',content:'正在整理今天的研究。',createdAt:'2026-09-07T09:00:00Z'},{id:2,beingId:'bob',beingName:'Bob',content:'我刚完成新的界面，欢迎来看看。',createdAt:'2026-09-07T09:01:00Z'}],roomMessages:{'1':[{id:'1',beingId:'alice',beingName:'Alice',content:'第一个围炉的消息',createdAt:'2026-09-07T09:00:00Z'}],'2':[{id:'2',beingId:'bob',beingName:'Bob',content:'第二个围炉的消息',createdAt:'2026-09-07T09:00:00Z'}]},calls:{messages:0,snapshots:0,manual:0,members:0,rooms:0,roomMembers:0,send:[],channel:[],credentials:[],deploy:[],assist:0,navigate:0,timers:0},cache:new Map(),hold:false,resolve:null,inflight:null,sendResult:{ok:true}};
    window.setTimeout=()=>{fixture.calls.timers++;throw new Error('Renderer polling is forbidden');};
    window.setInterval=window.setTimeout;
    fixture.state={connection:{status:'connected',beingName:'Alice',displayUrl:'https://fixture.invalid/alice/'},workspace:{path:'E:\\Projects\\Being'},machine:{hostname:'测试电脑'},portal:{status:'not_configured'},townApp:{identity:{beingId:'alice',displayName:'Alice',identityRevision:1,connectionRevision:1},access:{fireside:'auth_required',firesideRead:'ready'},platformSupported:true}};
    fixture.key=value=>value.kind+':'+(value.firesideId||'');
    fixture.envelope=(kind='bonfire',firesideId='',overrides={})=>({kind,firesideId,snapshot:{identity:structuredClone(fixture.state.townApp.identity),messages:structuredClone(kind==='bonfire'?fixture.messages:fixture.roomMessages[firesideId]||[]),latestSeq:100},status:{status:'ready',reason:'sbs',errorCode:'',intervalMs:60000,lastSuccessAt:'2026-09-07T09:01:00Z',lastCheckedAt:'2026-09-07T09:02:00Z',nextRefreshAt:'2026-09-07T09:03:00Z',stale:false,running:true},...overrides});
    fixture.publish=(value)=>{fixture.cache.set(fixture.key(value),structuredClone(value));fixture.listener(value);};
    fixture.refresh=(value)=>{fixture.calls.manual++;if(fixture.inflight)return fixture.inflight;fixture.calls.messages++;const result=fixture.envelope(value.kind,value.firesideId||'');if(!fixture.hold){fixture.publish(result);return Promise.resolve(result);}fixture.inflight=new Promise(resolve=>fixture.resolve=()=>{fixture.publish(result);resolve(result);fixture.inflight=null;fixture.resolve=null;});return fixture.inflight;};
    fixture.calls.reads=[];fixture.calls.messagesAtRead=[];fixture.pendingReads=[];fixture.holdRead=true;fixture.holdMembers=true;fixture.holdSnapshot=true;fixture.roomsAvailable=false;fixture.roomMembersAvailable=false;
    fixture.readRequestIs=(value,kind,firesideId='')=>{const {selectionRevision,includeRooms,...target}=value;return JSON.stringify(target)===JSON.stringify(firesideId?{kind,firesideId}:{kind})&&(kind==='fireside'?Number.isSafeInteger(selectionRevision)&&selectionRevision>=0:selectionRevision===undefined)&&(includeRooms===undefined||includeRooms===true&&kind==='fireside'&&Boolean(firesideId));};
    const bridge={getTownAppState:async()=>{if(fixture.holdTownState)await new Promise(resolve=>{fixture.resolveTownState=resolve;});return fixture.state.townApp;},refreshTownApp:async()=>fixture.state.townApp,
      getTownCachedData:async value=>value.method==='getBeingMembers'?{cached:true,data:{members:[{id:'alice',name:'Alice 本地缓存'}]}}:{cached:false,data:null},
      getBeingMembers:async()=>{fixture.calls.members++;if(fixture.holdMembers)await new Promise(resolve=>{fixture.resolveMembers=resolve;});return {members:fixture.members};},
      getTownMessageSnapshot:async value=>{fixture.calls.snapshots++;if(fixture.holdSnapshot)await new Promise(resolve=>{fixture.resolveSnapshot=resolve;});return fixture.cache.get(fixture.key(value))||fixture.envelope(value.kind,value.firesideId||'');},
      refreshTownMessages:value=>fixture.refresh(value),onTownMessages:listener=>{fixture.listener=listener;return()=>{fixture.listener=()=>{};};},
      getFiresides:async()=>{fixture.calls.rooms++;return fixture.roomsAvailable?{owned:[{id:'1',name:'设计小组',member_count:2}],joined:[{id:'2',name:'研究小组',member_count:2}],cached:true}:{owned:[],joined:[],cached:false,status:{reason:'waiting_sbs',lastSuccessAt:null}};},
      getFiresideMembers:async()=>{fixture.calls.roomMembers++;if(fixture.holdRoomMembers)await new Promise(resolve=>{fixture.resolveRoomMembers=resolve;});return {members:fixture.roomMembersAvailable?fixture.members:[]};},
      requestTownRead:async value=>{fixture.calls.reads.push(value);fixture.calls.messagesAtRead.push(Array.from(document.querySelectorAll('.ta-'+value.kind+' .ta-message'),message=>message.textContent));if(fixture.readAccepted)throw Object.assign(new Error('Fixture request accepted'),{code:'REQUEST_ACCEPTED'});if(fixture.readBusy)throw Object.assign(new Error('Fixture Being is busy'),{code:'BUSY'});const result=fixture.envelope(value.kind,value.firesideId||'');let emit=true;if(fixture.holdRead)await new Promise(resolve=>{const pending={value,resolve:(options={})=>{emit=options.emit!==false;fixture.pendingReads=fixture.pendingReads.filter(item=>item!==pending);resolve();}};fixture.pendingReads.push(pending);fixture.resolveRead=pending.resolve;});if(value.kind==='fireside'&&!value.firesideId){fixture.roomsAvailable=true;return {rooms:await fixture.bridge.getFiresides()};}fixture.roomMembersAvailable=value.kind==='fireside'||fixture.roomMembersAvailable;if(emit)fixture.publish(result);return result;},
      sendBonfireMessage:async value=>{fixture.calls.send.push(value);return fixture.sendResult;},
      beginChannelConnection:async value=>{fixture.calls.channel.push(value);return {status:value.channel==='feishu'?'ready':'unsupported',detail:value.channel==='feishu'?'准备机器人后填写凭据。':'当前服务尚未提供微信授权入口。'};},
      checkChannelStatus:async value=>{fixture.calls.channel.push(value);return {channels:[{channel:'wechat',status:'disconnected'},{channel:'feishu',status:'connected',detail:'连接检查通过。'}]};},
      updateFeishuCredentials:async value=>{fixture.calls.credentials.push(value);return {status:'connected',detail:'飞书已连接。'};},
      deployPortal:async value=>{fixture.calls.deploy.push(value);return {status:'running',detail:'Fixture Portal started.'};},
      prepareTownAssistance:async()=>{fixture.calls.assist++;throw new Error('Conversation fallback forbidden');}};
    fixture.bridge=bridge;beingTownApp.init({bridge,onNavigateSettings:()=>{},onNavigateChat:()=>{fixture.calls.navigate++;}});beingTownApp.setState(fixture.state);void beingTownApp.open('bonfire');
  })()`);
  await settle();
  await check('opening Bonfire waits for the local snapshot before requesting Being', `fixture.calls.snapshots===1&&typeof fixture.resolveSnapshot==='function'&&fixture.calls.members===1&&typeof fixture.resolveMembers==='function'&&fixture.calls.reads.length===0&&document.querySelectorAll('.ta-bonfire .ta-message').length===0`);
  await check('cached Bonfire members render while the fresh member directory is pending', `fixture.holdMembers&&document.querySelector('.ta-bonfire-members').textContent.includes('Alice 本地缓存')`);
  await execute(`fixture.holdSnapshot=false;fixture.resolveSnapshot()`); await settle();
  await check('Bonfire renders cached messages before requesting Being while the member directory remains pending', `fixture.calls.snapshots===1&&fixture.calls.manual===0&&fixture.calls.messages===0&&fixture.calls.rooms===0&&fixture.calls.roomMembers===0&&fixture.calls.members===1&&fixture.holdMembers&&fixture.calls.timers===0&&JSON.stringify(fixture.calls.reads)===JSON.stringify([{kind:'bonfire'}])&&fixture.pendingReads.length===1&&document.getElementById('town-app-read-once').disabled&&document.querySelectorAll('.ta-bonfire .ta-message').length===2&&fixture.calls.messagesAtRead[0].length===2&&fixture.calls.messagesAtRead[0][0].includes('正在整理今天的研究')`);
  await execute(`void beingTownApp.open('bonfire');void beingTownApp.open('bonfire')`); await settle();
  await check('repeated Bonfire clicks join the same in-flight Being read', `fixture.calls.reads.length===1&&fixture.pendingReads.length===1&&document.querySelectorAll('.ta-bonfire .ta-message').length===2`);
  await execute(`fixture.holdRead=false;fixture.resolveRead();fixture.holdMembers=false;fixture.resolveMembers()`); await settle();
  await check('the joined Bonfire read completes without leaving read controls busy', `fixture.pendingReads.length===0&&!document.getElementById('town-app-read-once').disabled`);
  await execute(`(async()=>{await beingTownApp.open('channel');fixture.beforeCachedOpen=fixture.calls.reads.length;const cached=fixture.envelope();cached.snapshot.messages[0].content='尚未联网时恢复的缓存消息';fixture.cache.set(fixture.key(cached),cached);fixture.holdTownState=true;void beingTownApp.open('bonfire');})()`); await settle();
  await check('Bonfire restores the local snapshot even while refreshing Town state is pending', `typeof fixture.resolveTownState==='function'&&document.getElementById('bonfire-messages').textContent.includes('尚未联网时恢复的缓存消息')&&fixture.calls.reads.length===fixture.beforeCachedOpen`);
  await execute(`fixture.holdTownState=false;fixture.resolveTownState()`); await settle();
  await check('cached Bonfire opening still requests exactly one fresh read after state is ready', `fixture.calls.reads.length===fixture.beforeCachedOpen+1&&fixture.calls.messagesAtRead.at(-1)[0].includes('尚未联网时恢复的缓存消息')&&document.getElementById('bonfire-messages').textContent.includes('正在整理今天的研究')&&!document.getElementById('town-app-read-once').disabled`);
  await execute(`fixture.afterBonfireOpen={reads:fixture.calls.reads.length,snapshots:fixture.calls.snapshots}`);
  await check('bonfire loads real fixture authors and members', `document.querySelectorAll('.ta-bonfire .ta-message').length===2&&document.querySelectorAll('.ta-bonfire-member').length===2&&document.querySelector('.ta-bonfire').textContent.includes('Bob')`);
  await execute(`document.querySelector('.ta-bonfire [data-being-id="bob"]').click()`);
  await check('member selection filters only displayed messages', `document.querySelectorAll('.ta-bonfire .ta-message').length===1&&document.querySelector('.ta-bonfire .ta-message').textContent.includes('Bob')&&fixture.calls.send.length===0`);
  await execute(`(()=>{const draft=document.getElementById('bonfire-draft');draft.value='@al';draft.setSelectionRange(3,3);draft.dispatchEvent(new Event('input'));draft.focus();})()`);
  await check('at completion shows matching Being', `!document.getElementById('bonfire-mentions').hidden&&document.querySelectorAll('#bonfire-mentions [role=option]').length===1&&document.getElementById('bonfire-mentions').textContent.includes('Alice')`);
  await capture('bonfire-desktop');
  await execute(`document.getElementById('bonfire-draft').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
  await check('selecting a mention does not send', `document.getElementById('bonfire-draft').value==='@alice '&&fixture.calls.send.length===0`);
  await execute(`(()=>{const draft=document.getElementById('bonfire-draft');draft.value+='请看一下';draft.dispatchEvent(new Event('input'));draft.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,cancelable:true}));})()`);
  await check('IME Enter preserves draft without sending', `fixture.calls.send.length===0&&document.getElementById('bonfire-draft').value==='@alice 请看一下'`);
  await execute(`document.getElementById('bonfire-send').click()`); await settle();
  await check('explicit send carries mention IDs and connection revision', `fixture.calls.send.length===1&&fixture.calls.send[0].content==='@alice 请看一下'&&fixture.calls.send[0].mentions.join(',')==='alice'&&fixture.calls.send[0].connectionRevision===1&&document.getElementById('bonfire-draft').value===''`);
  await check('explicit send checks existing results without another Being read', `fixture.calls.snapshots===fixture.afterBonfireOpen.snapshots&&fixture.calls.manual===1&&fixture.calls.reads.length===fixture.afterBonfireOpen.reads&&fixture.calls.timers===0&&!document.getElementById('bonfire-refresh-status').hidden&&document.getElementById('bonfire-refresh-status').textContent.includes('最近检查')&&document.getElementById('bonfire-refresh-status').textContent.includes('最近采集')&&document.getElementById('town-app-refresh').textContent==='刷新显示'&&document.getElementById('town-app-read-once').textContent==='请 Being 读取一次'&&document.querySelector('.ta-subtitle').textContent.includes('先显示上次缓存的消息，再请 Being 读取一次')`);
  await execute(`(()=>{const draft=document.getElementById('bonfire-draft');draft.value='尚未发送的草稿';draft.dispatchEvent(new Event('input'));draft.focus();draft.setSelectionRange(2,4);fixture.messages=Array.from({length:100},(_,i)=>({id:i+1,beingId:'bob',beingName:'Bob',content:'背景同步消息 '+i+' '+ '较长的内容用于核对滚动位置。'.repeat(3)}));fixture.publish(fixture.envelope());document.querySelector('.ta-bonfire [data-being-id="bob"]').click();document.getElementById('bonfire-messages').scrollTop=200;fixture.scroll=document.getElementById('bonfire-messages').scrollTop;fixture.messages[0].content='已修订的消息';fixture.messages[0].revisedAt='2026-09-07T10:00:00Z';fixture.messages.splice(1,1);fixture.publish(fixture.envelope());})()`); await settle();
  await check('background revisions and deletions preserve draft focus selection filter and scroll', `document.getElementById('bonfire-draft').value==='尚未发送的草稿'&&document.activeElement.id==='bonfire-draft'&&document.getElementById('bonfire-draft').selectionStart===2&&document.getElementById('bonfire-draft').selectionEnd===4&&document.querySelector('.ta-bonfire [data-being-id="bob"]').getAttribute('aria-pressed')==='true'&&document.getElementById('bonfire-messages').scrollTop===fixture.scroll&&document.querySelectorAll('.ta-bonfire .ta-message').length===99&&document.querySelector('.ta-bonfire .ta-message').textContent.includes('已编辑')`);
  await execute(`fixture.before=fixture.calls.manual;fixture.beforeHiddenReads=fixture.calls.reads.length;document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));document.getElementById('page-town-app').hidden=true;fixture.messages[0].content='页面隐藏时收到的新消息';fixture.publish(fixture.envelope());`); await settle();
  await check('focus and hidden background updates never request another Being read', `!document.getElementById('bonfire-messages').textContent.includes('页面隐藏时收到的新消息')&&fixture.calls.manual===fixture.before&&fixture.calls.reads.length===fixture.beforeHiddenReads&&fixture.calls.timers===0`);
  await execute(`(async()=>{document.getElementById('page-town-app').hidden=false;await beingTownApp.open('bonfire');})()`); await settle();
  await check('opening hidden Bonfire requests once and preserves the cached draft and filter', `document.getElementById('bonfire-messages').textContent.includes('页面隐藏时收到的新消息')&&document.getElementById('bonfire-draft').value==='尚未发送的草稿'&&document.querySelector('.ta-bonfire [data-being-id="bob"]').getAttribute('aria-pressed')==='true'&&fixture.calls.manual===fixture.before&&fixture.calls.reads.length===fixture.beforeHiddenReads+1&&fixture.calls.navigate===0&&fixture.calls.assist===0`);
  await execute(`fixture.hold=true;fixture.before=fixture.calls.messages;fixture.beforeExplicitReads=fixture.calls.reads.length;fixture.bridge.refreshTownMessages({kind:'bonfire'});document.getElementById('town-app-refresh').click()`); await settle();
  await execute(`document.getElementById('town-app-refresh').click();document.getElementById('town-app-refresh').click()`);
  await check('refresh display joins the in-flight result check without driving Being', `fixture.calls.messages===fixture.before+1&&fixture.resolve!==null&&document.getElementById('town-app-refresh').disabled&&fixture.calls.reads.length===fixture.beforeExplicitReads`);
  await execute(`fixture.hold=false;fixture.resolve()`); await settle();
  await execute(`fixture.holdRead=true;document.getElementById('town-app-read-once').click();document.getElementById('town-app-read-once').click()`); await settle();
  await check('explicit read-once is a separate single main-session request', `fixture.calls.reads.length===fixture.beforeExplicitReads+1&&fixture.calls.reads.at(-1).kind==='bonfire'&&document.getElementById('town-app-read-once').disabled&&!document.getElementById('town-app-refresh').disabled&&document.getElementById('bonfire-draft').value==='尚未发送的草稿'`);
  await execute(`fixture.holdRead=false;fixture.resolveRead()`); await settle();
  await execute(`fixture.readAccepted=true;document.getElementById('town-app-read-once').click()`); await settle();
  await check('accepted read is waiting rather than a claimed completed result', `document.querySelector('.ta-page-header + .ta-notice').textContent.includes('结果待确认')&&!document.querySelector('.ta-page-header + .ta-notice').textContent.includes('已显示本次读取结果')&&fixture.calls.reads.length===fixture.beforeExplicitReads+2`);
  await execute(`fixture.readAccepted=false;fixture.readBusy=true;void beingTownApp.open('bonfire')`); await settle();
  await check('a busy Being read from navigation is shown inline without claiming success', `document.querySelector('.ta-page-header + .ta-notice').textContent.includes('Being 正在处理其他消息')&&!document.querySelector('.ta-page-header + .ta-notice').textContent.includes('已显示本次读取结果')&&!document.getElementById('town-app-read-once').disabled&&fixture.calls.reads.length===fixture.beforeExplicitReads+3&&fixture.calls.navigate===0&&fixture.calls.assist===0`);
  await execute(`fixture.readBusy=false;fixture.beforeBackgroundReads=fixture.calls.reads.length`);
  await execute(`fixture.readAccepted=false;fixture.publish(fixture.envelope('bonfire','',{snapshot:{identity:structuredClone(fixture.state.townApp.identity),messages:[],latestSeq:null},status:{status:'waiting',reason:'waiting_sbs',lastSuccessAt:null,lastCheckedAt:'2026-09-07T09:05:00Z',stale:false}}))`); await settle();
  await check('an empty background cache distinguishes check time from collection time', `document.getElementById('bonfire-refresh-status').textContent.includes('等待 Being 后台读取')&&document.getElementById('bonfire-refresh-status').textContent.includes('最近检查')&&!document.getElementById('bonfire-refresh-status').textContent.includes('最近采集')&&document.getElementById('bonfire-messages').textContent.includes('等待 Being 后台读取')&&!document.getElementById('bonfire-messages').textContent.includes('篝火里还没有消息')`);
  await execute(`fixture.savedRefresh=fixture.bridge.refreshTownMessages;fixture.bridge.refreshTownMessages=async()=>{throw Object.assign(new Error('后台采集尚未设置，可请 Being 读取一次。'),{code:'SBS_NOT_CONFIGURED'});};document.getElementById('town-app-refresh').click()`); await settle();
  await check('missing background registration is not presented as a pending Being read', `document.getElementById('bonfire-refresh-status').textContent.includes('后台采集尚未设置，可请 Being 读取一次')&&document.getElementById('bonfire-messages').textContent.includes('后台采集尚未设置')&&!document.querySelector('.ta-bonfire').textContent.includes('等待 Being 后台读取')&&!document.getElementById('bonfire-refresh-status').textContent.includes('最近采集')&&fixture.calls.reads.length===fixture.beforeBackgroundReads`);
  await execute(`fixture.bridge.refreshTownMessages=fixture.savedRefresh;void 0`);
  await execute(`fixture.publish(fixture.envelope('bonfire','',{status:{status:'waiting',reason:'sbs_not_configured',errorCode:'SBS_NOT_CONFIGURED',lastSuccessAt:'2026-09-07T09:01:00Z',lastCheckedAt:'2026-09-07T09:06:00Z',stale:true}}))`); await settle();
  await check('missing background registration preserves cached messages and their collection time', `document.querySelectorAll('.ta-bonfire .ta-message').length===99&&document.getElementById('bonfire-refresh-status').textContent.includes('后台采集尚未设置')&&document.getElementById('bonfire-refresh-status').textContent.includes('最近采集 '+new Date('2026-09-07T09:01:00Z').toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}))&&document.getElementById('bonfire-refresh-status').textContent.includes('显示上次同步内容')`);
  await execute(`fixture.publish(fixture.envelope())`); await settle();
  await execute(`fixture.publish(fixture.envelope('bonfire','',{status:{status:'paused',reason:'AUTH_REQUIRED',errorCode:'AUTH_REQUIRED',intervalMs:60000,lastSuccessAt:'2026-09-07T09:01:00Z',stale:true,running:true}}))`); await settle();
  await check('authorization pause labels retained snapshot stale instead of claiming empty or fresh', `document.querySelectorAll('.ta-bonfire .ta-message').length===99&&document.querySelector('.ta-bonfire').textContent.includes('Being 读取被拒绝')&&document.querySelector('.ta-bonfire').textContent.includes('显示上次同步内容')&&fixture.calls.assist===0`);
  await execute(`fixture.sendResult={ok:false,status:'uncertain'};document.getElementById('bonfire-send').click()`); await settle();
  await check('uncertain send preserves draft and warns before retry', `document.getElementById('bonfire-draft').value==='尚未发送的草稿'&&document.querySelector('.ta-bonfire').textContent.includes('发送结果待确认')`);
  await execute(`fixture.holdRead=true;void beingTownApp.open('bonfire')`); await settle();
  await execute(`fixture.beforeIdentityReads=fixture.calls.reads.length;fixture.oldEnvelope=fixture.envelope();fixture.cache.clear();fixture.state={...fixture.state,connection:{...fixture.state.connection,beingName:'Carol'},townApp:{...fixture.state.townApp,identity:{beingId:'carol',displayName:'Carol',identityRevision:2,connectionRevision:2}}};beingTownApp.setState(fixture.state);fixture.listener(fixture.oldEnvelope);fixture.holdRead=false;fixture.resolveRead()`); await settle();
  await check('identity change clears private state and ignores the previous Being read completion', `document.getElementById('bonfire-draft').value===''&&document.querySelectorAll('.ta-bonfire .ta-message').length===0&&fixture.calls.reads.length===fixture.beforeIdentityReads&&!document.querySelector('.ta-page-header + .ta-notice').textContent.includes('已显示本次读取结果')`);
  await execute(`fixture.state={...fixture.state,connection:{...fixture.state.connection,status:'disconnected'}};beingTownApp.setState(fixture.state);void beingTownApp.open('bonfire')`); await settle();
  await check('opening Bonfire while disconnected does not request Being', `fixture.calls.reads.length===fixture.beforeIdentityReads&&document.getElementById('town-app-read-once').disabled`);
  await execute(`fixture.state={...fixture.state,connection:{...fixture.state.connection,status:'connected'}};beingTownApp.setState(fixture.state);document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'))`); await settle();
  await check('reconnecting and focus alone do not initiate a Being read', `fixture.calls.reads.length===fixture.beforeIdentityReads&&!document.getElementById('town-app-read-once').disabled`);
  await execute(`fixture.messages=[{id:3,beingId:'carol',beingName:'Carol',content:'新的身份消息'}];fixture.members=[{id:'carol',name:'Carol'}];fixture.publish(fixture.envelope())`); await settle();
  await check('new identity fetch is isolated from previous messages', `document.querySelector('.ta-bonfire').textContent.includes('新的身份消息')&&!document.querySelector('.ta-bonfire').textContent.includes('正在整理今天的研究')`);
  await execute(`fixture.obsolete=fixture.envelope();fixture.obsolete.snapshot.identity.connectionRevision=1;fixture.obsolete.snapshot.messages=[{id:99,content:'过期连接不应显示'}];fixture.listener(fixture.obsolete)`);
  await check('same Being with stale connection revision cannot overwrite messages', `document.querySelector('.ta-bonfire').textContent.includes('新的身份消息')&&!document.querySelector('.ta-bonfire').textContent.includes('过期连接不应显示')`);
  await execute(`fixture.beforeFireside={rooms:fixture.calls.rooms,members:fixture.calls.roomMembers,manual:fixture.calls.manual,reads:fixture.calls.reads.length};fixture.holdRead=true;void beingTownApp.open('fireside')`); await settle();
  await check('opening Fireside requests only the directory while displaying its cached state', `fixture.calls.rooms===fixture.beforeFireside.rooms+1&&fixture.calls.roomMembers===fixture.beforeFireside.members&&fixture.calls.manual===fixture.beforeFireside.manual&&fixture.calls.reads.length===fixture.beforeFireside.reads+1&&fixture.readRequestIs(fixture.calls.reads.at(-1),'fireside')&&document.querySelectorAll('.ta-fireside .ta-room-row').length===0&&document.querySelector('.ta-room-sidebar').textContent.includes('围炉目录尚未读取')&&!document.querySelector('.ta-room-sidebar').textContent.includes('等待 Being 后台读取')`);
  await execute(`document.getElementById('town-app-refresh').click()`); await settle();
  await check('refresh display does not create another directory read in the main session', `fixture.calls.rooms===fixture.beforeFireside.rooms+2&&fixture.calls.roomMembers===0&&fixture.calls.manual===fixture.beforeFireside.manual&&fixture.calls.reads.length===fixture.beforeFireside.reads+1&&document.querySelectorAll('.ta-fireside .ta-room-row').length===0`);
  await execute(`fixture.holdRead=false;fixture.resolveRead()`); await settle();
  await check('opening Fireside shows the returned directory without reading a room', `fixture.calls.reads.length===fixture.beforeFireside.reads+1&&fixture.calls.roomMembers===0&&document.querySelectorAll('.ta-fireside .ta-room-row').length===2`);
  await execute(`document.getElementById('town-app-read-once').click()`); await settle();
  await check('read-once without a selected room explicitly requests the directory only', `fixture.calls.reads.length===fixture.beforeFireside.reads+2&&fixture.readRequestIs(fixture.calls.reads.at(-1),'fireside')&&fixture.calls.roomMembers===0&&document.querySelectorAll('.ta-fireside .ta-room-row').length===2`);
  await execute(`fixture.beforeRoomSelect={snapshots:fixture.calls.snapshots,manual:fixture.calls.manual,reads:fixture.calls.reads.length,rooms:fixture.calls.rooms,members:fixture.calls.roomMembers};fixture.holdRead=true;fixture.holdSnapshot=true;fixture.holdRoomMembers=true;document.querySelector('.ta-fireside .ta-room-row').click()`); await settle();
  await check('Fireside waits for the local room snapshot before requesting Being', `fixture.calls.snapshots===fixture.beforeRoomSelect.snapshots+1&&fixture.calls.reads.length===fixture.beforeRoomSelect.reads&&fixture.calls.roomMembers===fixture.beforeRoomSelect.members+1&&fixture.holdRoomMembers`);
  await execute(`fixture.holdSnapshot=false;fixture.resolveSnapshot()`); await settle();
  await check('Fireside renders cached messages before the read even while members are pending', `fixture.calls.messagesAtRead.at(-1)[0].includes('第一个围炉的消息')&&fixture.calls.reads.length===fixture.beforeRoomSelect.reads+1&&fixture.holdRoomMembers&&document.querySelector('.ta-room-messages').textContent.includes('第一个围炉的消息')`);
  await execute(`fixture.holdRoomMembers=false;fixture.resolveRoomMembers()`); await settle();
  await check('selecting a room immediately requests its messages while displaying cached content', `fixture.calls.rooms===fixture.beforeRoomSelect.rooms&&fixture.calls.roomMembers===fixture.beforeRoomSelect.members+1&&fixture.calls.manual===fixture.beforeRoomSelect.manual&&fixture.calls.reads.length===fixture.beforeRoomSelect.reads+1&&fixture.readRequestIs(fixture.calls.reads.at(-1),'fireside','1')&&fixture.calls.snapshots===fixture.beforeRoomSelect.snapshots+1&&document.querySelector('.ta-fireside').textContent.includes('第一个围炉的消息')`);
  await execute(`fixture.firstRoomSelectionRevision=fixture.calls.reads.at(-1).selectionRevision;document.querySelector('.ta-fireside .ta-room-row').click();document.querySelector('.ta-fireside .ta-room-row').click()`); await settle();
  await check('repeated clicks on the selected room deduplicate the same selection revision', `fixture.calls.reads.length===fixture.beforeRoomSelect.reads+1&&fixture.pendingReads.length===1&&fixture.pendingReads[0].value.selectionRevision===fixture.firstRoomSelectionRevision&&document.getElementById('town-app-read-once').disabled`);
  await execute(`fixture.holdRead=false;fixture.resolveRead()`); await settle();
  await check('room navigation refreshes returned members without another Being request', `fixture.calls.reads.length===fixture.beforeRoomSelect.reads+1&&document.querySelectorAll('.ta-fireside .ta-member').length===1&&!document.getElementById('town-app-read-once').disabled`);
  await execute(`document.getElementById('town-app-refresh').click()`); await settle();
  await check('refreshing the selected room checks cached results without a Being message', `fixture.calls.manual===fixture.beforeRoomSelect.manual+1&&fixture.calls.reads.length===fixture.beforeRoomSelect.reads+1&&document.querySelector('.ta-fireside').textContent.includes('第一个围炉的消息')&&document.querySelectorAll('.ta-fireside .ta-member').length===1`);
  await execute(`document.getElementById('town-app-read-once').click()`); await settle();
  await check('read-once explicitly requests the same selected room revision and shows returned members', `fixture.calls.reads.length===fixture.beforeRoomSelect.reads+2&&fixture.readRequestIs(fixture.calls.reads.at(-1),'fireside','1')&&fixture.calls.reads.at(-1).selectionRevision===fixture.firstRoomSelectionRevision&&document.querySelectorAll('.ta-fireside .ta-member').length===1&&document.getElementById('fireside-send').textContent==='带草稿到 Loom'&&fixture.calls.assist===0`);
  await execute(`(()=>{const draft=document.getElementById('fireside-draft');draft.value='围炉尚未发送的协助草稿';draft.dispatchEvent(new Event('input'));draft.focus();fixture.roomMessages['1']=Array.from({length:60},(_,i)=>({id:String(i+1),beingId:'carol',beingName:'Carol',content:'围炉背景消息 '+i+' '+ '保留阅读位置。'.repeat(8)}));fixture.publish(fixture.envelope('fireside','1'));const list=document.querySelector('.ta-fireside .ta-room-messages');list.scrollTop=180;fixture.roomScroll=list.scrollTop;fixture.roomMessages['1'][0].content='围炉修订消息';fixture.roomMessages['1'][0].revisedAt='2026-09-07T10:00:00Z';fixture.roomMessages['1'].splice(1,1);fixture.publish(fixture.envelope('fireside','1'));})()`); await settle();
  await check('Fireside background changes preserve draft focus and scroll', `document.getElementById('fireside-draft').value==='围炉尚未发送的协助草稿'&&document.activeElement.id==='fireside-draft'&&document.querySelector('.ta-fireside .ta-room-messages').scrollTop===fixture.roomScroll&&document.querySelectorAll('.ta-fireside .ta-message').length===59&&document.querySelector('.ta-fireside .ta-message').textContent.includes('已编辑')&&fixture.calls.assist===0`);
  await capture('fireside-background');
  await execute(`fixture.beforeRoomSwitch={manual:fixture.calls.manual,reads:fixture.calls.reads.length};fixture.holdRead=true;fixture.firstRoomEnvelope=fixture.envelope('fireside','1');document.querySelector('.ta-fireside .ta-room-row').click()`); await settle();
  await execute(`document.querySelectorAll('.ta-fireside .ta-room-row')[1].click()`); await settle();
  await check('switching rooms requests the new target even while the previous room read is pending', `fixture.calls.reads.length===fixture.beforeRoomSwitch.reads+2&&fixture.readRequestIs(fixture.calls.reads.at(-1),'fireside','2')&&fixture.pendingReads.length===2&&document.querySelector('.ta-fireside .ta-room-messages').textContent.includes('第二个围炉的消息')&&document.getElementById('fireside-draft').value===''`);
  await execute(`fixture.pendingReads.find(item=>item.value.firesideId==='1').resolve();fixture.listener(fixture.firstRoomEnvelope)`); await settle();
  await check('late previous-room events and read completion cannot overwrite the selected room', `document.querySelector('.ta-fireside .ta-room-messages').textContent.includes('第二个围炉的消息')&&!document.querySelector('.ta-fireside .ta-room-messages').textContent.includes('围炉修订消息')&&document.getElementById('fireside-draft').value===''&&document.getElementById('town-app-read-once').disabled&&!document.querySelector('.ta-page-header + .ta-notice').textContent.includes('已显示本次读取结果')&&fixture.calls.reads.length===fixture.beforeRoomSwitch.reads+2`);
  await execute(`fixture.holdRead=false;fixture.pendingReads.find(item=>item.value.firesideId==='2').resolve()`); await settle();
  await check('the selected room completion updates its content and unlocks read controls', `document.querySelector('.ta-fireside .ta-room-messages').textContent.includes('第二个围炉的消息')&&!document.getElementById('town-app-read-once').disabled&&fixture.calls.manual===fixture.beforeRoomSwitch.manual&&fixture.calls.reads.length===fixture.beforeRoomSwitch.reads+2`);
  await execute(`fixture.beforeRoundTripReads=fixture.calls.reads.length;fixture.holdRead=true;fixture.roomMessages['1']=[{id:'old-a',beingId:'alice',beingName:'Alice',content:'旧围炉请求结果不应显示'}];document.querySelector('.ta-fireside .ta-room-row').click()`); await settle();
  await execute(`fixture.oldRoomRead=fixture.pendingReads[0];document.querySelectorAll('.ta-fireside .ta-room-row')[1].click()`); await settle();
  await execute(`fixture.roomMessages['1']=[{id:'new-a',beingId:'carol',beingName:'Carol',content:'重新选中的围炉读取结果'}];document.querySelector('.ta-fireside .ta-room-row').click()`); await settle();
  await check('returning to a previous room starts a new read instead of reusing its canceled request', `fixture.calls.reads.length===fixture.beforeRoundTripReads+3&&fixture.pendingReads.length===3&&fixture.calls.reads.slice(-3).every((value,index)=>fixture.readRequestIs(value,'fireside',['1','2','1'][index]))&&fixture.calls.reads.at(-1).selectionRevision>fixture.calls.reads.at(-3).selectionRevision&&document.getElementById('town-app-read-once').disabled`);
  // Canceled requests can settle after navigation; their reply must not act as the current read.
  await execute(`fixture.oldRoomRead.resolve({emit:false});fixture.pendingReads.find(item=>item.value.firesideId==='2').resolve({emit:false})`); await settle();
  await check('old completions after a room round trip cannot replace content or unlock the new read', `!document.querySelector('.ta-fireside .ta-room-messages').textContent.includes('旧围炉请求结果不应显示')&&!document.querySelector('.ta-fireside .ta-room-messages').textContent.includes('第二个围炉的消息')&&!document.querySelector('.ta-page-header + .ta-notice').textContent.includes('已显示本次读取结果')&&document.getElementById('town-app-read-once').disabled&&fixture.pendingReads.length===1`);
  await execute(`fixture.holdRead=false;fixture.pendingReads[0].resolve()`); await settle();
  await check('the current room read survives the round trip and displays its own result', `document.querySelector('.ta-fireside .ta-room-messages').textContent.includes('重新选中的围炉读取结果')&&!document.querySelector('.ta-fireside .ta-room-messages').textContent.includes('旧围炉请求结果不应显示')&&!document.getElementById('town-app-read-once').disabled&&fixture.calls.reads.length===fixture.beforeRoundTripReads+3`);
  await execute(`document.querySelectorAll('.ta-fireside .ta-room-row')[1].click()`); await settle();
  await execute(`(async()=>{fixture.beforeReturnReads=fixture.calls.reads.length;await beingTownApp.open('channel');fixture.roomMessages['2'][0].content='另一个页面打开时收到的围炉消息';fixture.publish(fixture.envelope('fireside','2'));await beingTownApp.open('fireside');})()`); await settle();
  await check('selected Fireside keeps its background cache across other pages', `document.querySelector('.ta-fireside .ta-room-messages').textContent.includes('另一个页面打开时收到的围炉消息')&&fixture.calls.navigate===0&&fixture.calls.assist===0&&fixture.calls.timers===0`);
  await check('returning to Fireside requests one read refreshing both the directory and selected room', `fixture.calls.manual===fixture.beforeRoomSwitch.manual&&fixture.calls.reads.length===fixture.beforeReturnReads+1&&fixture.readRequestIs(fixture.calls.reads.at(-1),'fireside','2')&&fixture.calls.reads.at(-1).includeRooms===true`);
  await execute(`fixture.publish(fixture.envelope('fireside','2',{snapshot:{identity:structuredClone(fixture.state.townApp.identity),messages:[],latestSeq:null},status:{status:'paused',reason:'AUTH_REQUIRED',errorCode:'AUTH_REQUIRED',intervalMs:60000,stale:false,running:true}}))`); await settle();
  await check('Fireside authorization failure is explicit and never rendered as an empty room', `document.querySelector('.ta-fireside').textContent.includes('Being 读取被拒绝')&&document.querySelector('.ta-fireside .ta-room-messages').textContent.includes('消息尚未同步')&&!document.querySelector('.ta-fireside .ta-room-messages').textContent.includes('这里还没有消息')`);
  await capture('fireside-authorization');
  await execute(`fixture.savedTownRead=fixture.bridge.requestTownRead;fixture.savedRooms=fixture.bridge.getFiresides;fixture.beforeRemovedRead=fixture.calls.reads.length;fixture.bridge.requestTownRead=async value=>{fixture.calls.reads.push(value);fixture.bridge.getFiresides=async()=>({owned:[{id:'1',name:'设计小组',member_count:2}],joined:[],cached:true});return {rooms:await fixture.bridge.getFiresides(),removed:true};};void beingTownApp.open('fireside')`); await settle();
  await check('a refreshed directory removes inaccessible room contents and explains the new selection', `fixture.calls.reads.length===fixture.beforeRemovedRead+1&&fixture.calls.reads.at(-1).includeRooms===true&&document.querySelectorAll('.ta-fireside .ta-room-row').length===1&&!document.querySelector('.ta-fireside .ta-room-messages').textContent.includes('另一个页面打开时收到的围炉消息')&&document.querySelector('.ta-page-header + .ta-notice').textContent.includes('围炉目录已更新，请重新选择围炉')`);
  await execute(`fixture.bridge.requestTownRead=fixture.savedTownRead;fixture.bridge.getFiresides=fixture.savedRooms;void 0`);
  await execute(`beingTownApp.open('channel')`); await settle();
  await execute(`document.getElementById('channel-connect').click()`); await settle();
  await check('channel submits request to current Being and shows secure setup guidance', `document.querySelectorAll('.ta-channel input').length===0&&document.querySelectorAll('.ta-wizard-steps li').length===3&&fixture.calls.channel[0].channel==='feishu'&&fixture.calls.channel[0].connectionRevision===2&&document.querySelector('.ta-channel').textContent.includes('安全配置方式')&&fixture.calls.assist===0&&fixture.calls.navigate===0`);
  await capture('channel-desktop');
  await check('channel flow does not collect or send credentials through conversation', `!document.getElementById('channel-save')&&!document.getElementById('channel-app-secret')&&fixture.calls.credentials.length===0`);
  await execute(`document.getElementById('channel-check').click()`); await settle();
  await check('status response selects current channel from list', `document.querySelector('.ta-channel').textContent.includes('连接检查通过。')&&document.querySelector('.ta-channel .ta-badge').textContent==='已连接'`);
  await execute(`fixture.bridge.beginChannelConnection=async value=>{fixture.calls.channel.push(value);return {channel:value.channel,detail:'Being 回复：<img src=x onerror="fixture.injected=true">请先确认微信接入方式。'};};document.querySelector('[data-channel="wechat"]').click();document.getElementById('channel-connect').click()`); await settle();
  await check('Being prose remains plain text and does not imply a confirmed connection', `document.querySelector('.ta-channel').textContent.includes('<img src=x onerror="fixture.injected=true">')&&document.querySelector('.ta-channel .ta-badge').textContent==='待确认'&&!document.querySelector('.ta-channel img[onerror]')&&!fixture.injected&&fixture.calls.assist===0&&fixture.calls.navigate===0`);
  await execute(`fixture.bridge.checkChannelStatus=async value=>({channel:value.channel,status:'pending',detail:'请求已接收。'});document.getElementById('channel-check').click()`); await settle();
  await check('accepted background request remains pending until actual connection is confirmed', `document.querySelector('.ta-channel .ta-badge').textContent==='等待确认'&&document.querySelector('.ta-channel').textContent.includes('Being 已收到请求，实际连接状态仍待确认。')&&!document.querySelector('.ta-channel').textContent.includes('已连接')&&fixture.calls.assist===0&&fixture.calls.navigate===0`);
  await capture('channel-being-pending');
  await execute(`fixture.bridge.checkChannelStatus=async()=>{throw Object.assign(new Error('Being 暂时无法处理，请重试。'),{code:'AUTH_REQUIRED'});};document.getElementById('channel-check').click()`); await settle();
  await check('background request errors appear inline without opening an authorization flow', `document.querySelector('.ta-channel .ta-badge').textContent==='操作失败'&&document.querySelector('.ta-channel').textContent.includes('Being 暂时无法处理，请重试。')&&!document.querySelector('.ta-channel .ta-auth-note')&&!document.getElementById('channel-check').disabled&&fixture.calls.assist===0&&fixture.calls.navigate===0`);
  await execute(`fixture.bridge.beginChannelConnection=()=>new Promise(resolve=>{fixture.resolveOldChannel=resolve;});document.querySelector('[data-channel="feishu"]').click();document.getElementById('channel-connect').click()`); await settle();
  await check('background processing has an explicit busy label and disables duplicate actions', `document.getElementById('channel-check').textContent==='Being 正在处理…'&&document.getElementById('channel-check').disabled`);
  await execute(`document.querySelector('[data-channel="wechat"]').click();document.querySelector('[data-channel="feishu"]').click();fixture.bridge.beginChannelConnection=()=>new Promise(resolve=>{fixture.resolveNewChannel=resolve;});document.getElementById('channel-connect').click();fixture.resolveOldChannel({channel:'feishu',status:'connected',detail:'旧请求不应显示。'})`); await settle();
  await check('switching away and back ignores the old result without unlocking the newer request', `!document.querySelector('.ta-channel').textContent.includes('旧请求不应显示。')&&document.querySelector('.ta-channel .ta-badge').textContent==='待确认'&&document.getElementById('channel-check').disabled&&document.getElementById('channel-check').textContent==='Being 正在处理…'`);
  await execute(`fixture.resolveNewChannel({channel:'feishu',status:'pending',detail:'这是新请求的回复。'})`); await settle();
  await check('current request reply survives stale completion and unlocks channel controls', `document.querySelector('.ta-channel').textContent.includes('这是新请求的回复。')&&!document.querySelector('.ta-channel').textContent.includes('旧请求不应显示。')&&!document.getElementById('channel-check').disabled&&document.querySelector('.ta-channel .ta-badge').textContent==='等待确认'`);
  await execute(`fixture.bridge.getTownAppState=async()=>({...fixture.state.townApp,channel:{channel:'wechat',status:'connected',detail:'其他渠道的状态不应显示。'}});beingTownApp.open('channel')`); await settle();
  await check('channel snapshots from another channel cannot replace the current reply', `document.querySelector('.ta-channel').textContent.includes('这是新请求的回复。')&&!document.querySelector('.ta-channel').textContent.includes('其他渠道的状态不应显示。')&&document.querySelector('.ta-channel .ta-badge').textContent==='等待确认'`);
  await execute(`fixture.bridge.getTownAppState=async()=>({...fixture.state.townApp,channel:{channel:'feishu',status:'pending',detail:'当前渠道的后台回复。'}});beingTownApp.open('channel')`); await settle();
  await check('matching channel snapshots retain honest pending status across navigation', `document.querySelector('.ta-channel').textContent.includes('当前渠道的后台回复。')&&document.querySelector('.ta-channel').textContent.includes('实际连接状态仍待确认')&&document.querySelector('.ta-channel .ta-badge').textContent==='等待确认'`);
  await execute(`fixture.bridge.getTownAppState=async()=>fixture.state.townApp;void 0`);
  await execute(`fixture.bridge.checkChannelStatus=()=>new Promise(resolve=>{fixture.resolvePreviousIdentity=resolve;});document.getElementById('channel-check').click();fixture.state={...fixture.state,townApp:{...fixture.state.townApp,identity:{...fixture.state.townApp.identity,connectionRevision:3}}};beingTownApp.setState(fixture.state);fixture.resolvePreviousIdentity({channel:'feishu',status:'connected',detail:'旧连接回复不应显示。'})`); await settle();
  await check('connection rebind clears channel state and ignores the previous connection reply', `document.querySelector('.ta-channel .ta-badge').textContent==='待确认'&&!document.querySelector('.ta-channel').textContent.includes('旧连接回复不应显示。')&&!document.getElementById('channel-connect').disabled&&fixture.calls.assist===0&&fixture.calls.navigate===0`);
  await execute(`document.querySelector('[data-channel="wecom"]').click()`);
  await check('unsupported channel is explicit without Being fallback', `document.querySelector('.ta-channel').textContent.includes('暂不支持企业微信')&&fixture.calls.assist===0`);
  await execute(`beingTownApp.open('portal')`); await settle();
  await capture('portal-desktop');
  await execute(`document.getElementById('portal-app-deploy').click()`); await settle();
  await check('one Portal click invokes deployment with visible permission plan', `fixture.calls.deploy.length===1&&fixture.calls.deploy[0].confirmed===true&&fixture.calls.deploy[0].permissions.files===true&&fixture.calls.deploy[0].permissions.exec===false&&fixture.calls.deploy[0].permissions.web===false&&!document.getElementById('portal-app-confirm')&&document.querySelectorAll('.ta-portal .ta-permission').length===4`);
  await execute(`fixture.groveQueries=[];fixture.groveDetailCalls=[];fixture.cachedKit={id:'cache-kit',name:'本地工具缓存',description:'之前读取的工具包',version:'1.0'};fixture.liveKit={...fixture.cachedKit,name:'更新后的工具包'};fixture.bridge.getTownCachedData=async({method,value})=>method==='getGroveCatalog'?(value.offset?{cached:true,lastSuccessAt:50,data:{kits:[{id:'obsolete-tail',name:'不应恢复的旧目录尾页'}],count:2}}:{cached:true,lastSuccessAt:100,data:{kits:[fixture.cachedKit],count:2}}):method==='getGroveDetail'?{cached:true,data:{...fixture.cachedKit,name:'缓存中的工具详情'}}:{cached:true,data:{members:fixture.members}};fixture.bridge.getGroveCatalog=async value=>{fixture.groveQueries.push(value);await new Promise((resolve,reject)=>{fixture.resolveGrove=resolve;fixture.rejectGrove=reject;});return {kits:[fixture.liveKit],count:1};};fixture.bridge.getGroveDetail=async id=>{fixture.groveDetailCalls.push(id);await new Promise((resolve,reject)=>{fixture.resolveGroveDetail=resolve;fixture.rejectGroveDetail=reject;});return {...fixture.liveKit,name:'最新工具详情'};};void beingTownApp.open('grove')`); await settle();
  await check('Grove displays its cached catalog before the live request completes', `fixture.groveQueries.length===1&&document.querySelector('.ta-grove').textContent.includes('本地工具缓存')&&!document.querySelector('.ta-grove').textContent.includes('暂时没有工具包')`);
  await check('Grove does not combine a newer cached first page with obsolete continuation pages', `document.querySelectorAll('.ta-kit-list .ta-kit-card').length===1&&!document.querySelector('.ta-kit-list').textContent.includes('不应恢复的旧目录尾页')`);
  await execute(`fixture.resolveGrove()`); await settle();
  await check('Grove replaces the cached catalog after a successful refresh', `document.querySelector('.ta-kit-list').textContent.includes('更新后的工具包')&&!document.querySelector('.ta-kit-list').textContent.includes('本地工具缓存')`);
  await execute(`document.querySelector('.ta-kit-card').click()`); await settle();
  await check('Grove displays cached detail while its live detail request is pending', `fixture.groveDetailCalls.length===1&&document.querySelector('.ta-kit-detail').textContent.includes('缓存中的工具详情')&&document.querySelector('.ta-kit-detail').textContent.includes('之前读取的工具包')&&!document.querySelector('.ta-kit-detail').textContent.includes('正在读取详情')`);
  await execute(`fixture.rejectGroveDetail(new Error('工具详情刷新失败'))`); await settle();
  await check('Grove retains cached detail when a refresh fails', `document.querySelector('.ta-kit-detail').textContent.includes('缓存中的工具详情')&&document.querySelector('.ta-kit-detail').textContent.includes('工具详情刷新失败')`);
  await execute(`document.getElementById('grove-back').click();const search=document.getElementById('grove-search');search.value='更新';search.dispatchEvent(new Event('input'));void beingTownApp.open('channel')`); await settle();
  await execute(`void beingTownApp.open('grove')`); await settle();
  await check('reopening Grove refreshes again while preserving the cached list and search', `fixture.groveQueries.length===2&&document.getElementById('grove-search').value==='更新'&&document.querySelector('.ta-kit-list').textContent.includes('更新后的工具包')`);
  await execute(`fixture.rejectGrove(new Error('工具目录刷新失败'))`); await settle();
  await check('Grove retains its cached catalog when a refresh fails', `document.querySelector('.ta-kit-list').textContent.includes('更新后的工具包')&&document.querySelector('.ta-kit-list').textContent.includes('工具目录刷新失败')`);
  await execute(`beingTownApp.open('bonfire')`); await settle();
  win.setSize(420, 740); await settle();
  await capture('bonfire-narrow');
  await check('narrow Bonfire composer remains inside viewport', `(()=>{const draft=document.getElementById('bonfire-draft').getBoundingClientRect();const send=document.getElementById('bonfire-send').getBoundingClientRect();return draft.width>100&&draft.left>=0&&draft.right<=innerWidth&&send.bottom<=innerHeight;})()`);
  assert.equal(forbiddenRequests, 0, 'Fixture must never request remote resources');
}

run().then(() => { report.passed = true; }, error => { report.passed = false; report.error = error.stack; process.stderr.write(`${error.stack}\n`); }).finally(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`Report: ${path.join(output, 'report.json')}\n`);
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(report.passed ? 0 : 1);
});
