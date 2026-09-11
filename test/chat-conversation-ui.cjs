'use strict';

// Run with Electron. The native conversation view against an in-memory bridge; network is blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { app, BrowserWindow } = require('electron');
const project = path.resolve(__dirname, '..');
const renderer = path.join(project, 'renderer');
const output = path.join(project, '.local', `chat-conversation-${randomUUID()}`);
const report = { checks: [], screenshots: [], scope: 'Offline renderer fixture; no real messages, credentials or Being.' };
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
async function waitFor(selector) {
  for (let i = 0; i < 100; i++) { if (await execute(`document.querySelector(${JSON.stringify(selector)}) !== null`)) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`Timed out waiting for ${selector}`);
}
async function capture(name) {
  await settle();
  const image = await win.webContents.capturePage();
  const target = path.join(output, `${name}.png`);
  await fs.writeFile(target, image.toPNG());
  report.screenshots.push(target);
}

async function run() {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'fixture.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="${pathToFileURL(renderer + path.sep).href}"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="chat-app.css"><style>html,body{margin:0;width:100%;height:100%}.loom-panel{height:100vh;width:100vw}[hidden]{display:none!important}</style><script src="chat-app.js" defer></script></head><body><div class="loom-panel" id="loom-panel"><div id="chat-native" hidden></div></div></body></html>`);
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 960, height: 720, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: `chat-fixture-${randomUUID()}` } });
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
  await execute(`(() => {
    const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const beingReply='好的，看起来是这样：\\n\\n- **第一点**：函数名要改\\n- 第二点：加个 \`try\`\\n\\n\`\`\`js\\nconst x = 1;\\n\`\`\`\\n\\n参考 [文档](https://example.invalid/doc)。<b>不是标签</b>';
    window.fixture={A,B,calls:{views:0,send:[],stop:[],reload:0,forget:[]},confirms:[],confirmAnswer:true,toasts:[],
      views:{[A]:{sessionId:A,version:1,rows:[{seq:1,role:'user',content:'帮我看看这段代码',at:'2026-09-11T10:00:00Z'},{seq:2,role:'being',content:beingReply,at:'2026-09-11T10:00:30Z'}],sent:[],replied:[],live:null},
             [B]:{sessionId:B,version:1,rows:[{seq:3,role:'user',content:'乙会话的问题',at:'2026-09-11T11:00:00Z'}],sent:[],replied:[],live:null}},
      stopResult:{stopped:false,reason:'other-scene',scene:'desktop-x-'+B,ownerTitle:'乙'}};
    fixture.clock=iso=>new Date(iso).toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
    window.confirm=message=>{fixture.confirms.push(message);return fixture.confirmAnswer;};
    window.beingShell={toast:(message,error)=>fixture.toasts.push({message,error:!!error})};
    fixture.state=version=>({settings:{chatMode:'native'},connection:{configured:true,status:'connected',beingName:'cz_being'},
      chat:{open:true,version,active:A,cursor:3,seeded:true,degraded:false,recovery:{phase:'idle'},
        sessions:[{id:A,title:'代码审查',createdAt:0,truncated:false,count:2,lastSeq:2,busy:false,inFlight:false},{id:B,title:'乙',createdAt:0,truncated:false,count:1,lastSeq:3,busy:false,inFlight:false}]}});
    fixture.current=fixture.state(1);
    const bridge={
      chatView:async id=>{fixture.calls.views++;return structuredClone(fixture.views[id]);},
      chatSend:async value=>{fixture.calls.send.push(value);if(fixture.sendError)throw Object.assign(new Error(fixture.sendError),{code:'SERVICE_ERROR'});fixture.views[value.sessionId].sent.push({text:value.text,at:'2026-09-11T12:00:00Z',...(value.images?{images:value.images.map(({media_type,name,thumb})=>({media_type,name,thumb}))}:{})});fixture.views[value.sessionId].version++;return fixture.sendResult||{ok:true,streamed:true,spliced:false,recovering:''};},
      chatStop:async value=>{fixture.calls.stop.push(value);return value.force?{stopped:true,reason:'forced',scene:''}:fixture.stopResult;},
      chatReload:async()=>{fixture.calls.reload++;return {ok:true,added:0,error:''};},
      chatForgetSession:async id=>{fixture.calls.forget.push(id);return true;},
      onChatEvent:listener=>{fixture.emit=listener;return()=>{};},
    };
    window.beingDesktop=bridge;
    try{localStorage.removeItem('being-chat-notice-v1');}catch{}
    beingChat.setState(fixture.current);
  })()`);
  await settle(); await settle();
  await check('the native view mounts and draws durable rows for the active conversation', `!document.getElementById('chat-native').hidden&&fixture.calls.views===1&&document.querySelectorAll('.chat-message').length===2&&document.querySelector('.chat-message.is-being .chat-meta').textContent==='cz_being · '+fixture.clock('2026-09-11T10:00:30Z')&&document.querySelector('.chat-message.is-user .chat-meta').textContent==='you · '+fixture.clock('2026-09-11T10:00:00Z')`);
  await check('the notice about shared memory and hidden pre-scene history shows until dismissed', `!document.querySelector('.chat-notice').hidden&&document.querySelector('.chat-notice').textContent.includes('共享同一个 being 的记忆')`);
  await check('markdown renders bold, inline code, lists and fenced code, and never injects HTML', `(()=>{const being=document.querySelectorAll('.chat-message.is-being')[0];return being.querySelector('strong')?.textContent==='第一点'&&being.querySelector('li code')?.textContent==='try'&&being.querySelector('pre code')?.textContent==='const x = 1;'&&being.querySelector('.chat-link')?.title==='https://example.invalid/doc'&&being.querySelector('a')===null&&being.querySelector('b')===null&&being.textContent.includes('<b>不是标签</b>');})()`);
  await capture('chat-history');
  await execute(`document.querySelector('.chat-notice-close').click()`); await settle();
  await check('dismissing the notice remembers the choice', `document.querySelector('.chat-notice').hidden&&localStorage.getItem('being-chat-notice-v1')==='1'`);

  await execute(`(()=>{const input=document.querySelector('.chat-input');input.value='再帮我改一下';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`); await settle(); await settle();
  await check('Enter sends through the bridge with the active conversation and clears the composer', `fixture.calls.send.length===1&&fixture.calls.send[0].sessionId===fixture.A&&fixture.calls.send[0].text==='再帮我改一下'&&document.querySelector('.chat-input').value===''`);
  // Before any state comes back from the main process, the Being is already shown at work.
  await check('the thinking indicator appears the moment the message leaves', `document.querySelectorAll('.chat-thinking .chat-dot').length===3`);
  await execute(`fixture.current=fixture.state(2);fixture.current.chat.recovery={phase:'streaming',sessionId:fixture.A};fixture.current.chat.sessions[0].busy=true;beingChat.setState(fixture.current)`); await settle(); await settle();
  await check('the sent message shows at once as pending until history confirms it', `document.querySelectorAll('.chat-message.is-user.is-pending').length===1&&document.querySelector('.chat-message.is-user.is-pending .chat-meta').textContent==='you · '+fixture.clock('2026-09-11T12:00:00Z')+' · 等待记录确认'&&document.querySelector('.time-gap')?.textContent==='— '+fixture.clock('2026-09-11T10:00:30Z')+' —'&&document.querySelectorAll('.chat-thinking .chat-dot').length===3`);

  await execute(`fixture.emit({sessionId:fixture.A,type:'tool_use',data:{name:'search_web',input:'{"query":"语音输入"}'}})`); await settle(); await settle();
  await check('a tool call replaces the dots with what the Being is doing', `document.querySelector('.chat-thinking .chat-think-label')?.textContent==='在搜索'&&document.querySelector('.chat-thinking .chat-think-preview')?.textContent==='语音输入'&&document.querySelectorAll('.chat-dot').length===0`);
  await execute(`fixture.emit({sessionId:fixture.A,type:'tool_result',data:{is_error:false}})`); await settle(); await settle();
  await check('a finished tool call goes into the log and the line waits again', `document.querySelector('.chat-thinking .chat-think-label')?.textContent==='等待回复'&&document.querySelector('.chat-thinking .chat-think-entry')?.textContent==='在搜索 语音输入 ✓'`);

  await execute(`fixture.emit({sessionId:fixture.A,type:'think',text:'先想想'});fixture.emit({sessionId:fixture.A,type:'delta',text:'改成'});fixture.emit({sessionId:fixture.A,type:'delta',text:'这样'})`); await settle(); await settle();
  await check('live deltas stream into one being bubble with the thinking folded above it', `document.querySelectorAll('.chat-message.is-live').length===1&&document.querySelector('.chat-message.is-live .chat-body').textContent==='改成这样'&&document.querySelector('.chat-message.is-live .chat-think-text').textContent==='先想想'&&document.querySelector('.chat-message.is-live .chat-think-label').textContent==='正在回复'&&document.querySelector('.chat-message.is-live .chat-think-preview').textContent==='先想想'`);
  await execute(`fixture.emit({sessionId:fixture.B,type:'delta',text:'不该出现在甲里'})`); await settle();
  await check('another conversation stream never lands in the active one', `document.querySelector('.chat-message.is-live .chat-body').textContent==='改成这样'`);
  await capture('chat-streaming');
  await execute(`fixture.views[fixture.A].replied.push({text:'改成这样',think:'先想想',at:'2026-09-11T12:00:05Z'});fixture.views[fixture.A].version++;fixture.emit({sessionId:fixture.A,type:'reply',text:'改成这样'})`); await settle(); await settle();
  await check('a finished reply becomes a pending bubble awaiting history', `document.querySelectorAll('.chat-message.is-live').length===0&&document.querySelectorAll('.chat-message.is-being.is-pending').length===1`);
  await execute(`fixture.views[fixture.A]={...fixture.views[fixture.A],rows:[...fixture.views[fixture.A].rows,{seq:4,role:'user',content:'再帮我改一下',at:'2026-09-11T12:00:00Z'},{seq:5,role:'being',content:'改成这样',at:'2026-09-11T12:00:05Z'}],sent:[],replied:[]};fixture.current=fixture.state(3);beingChat.setState(fixture.current)`); await settle(); await settle();
  await check('history confirmation replaces the pending items with durable rows, nothing duplicated', `document.querySelectorAll('.chat-message').length===4&&document.querySelectorAll('.is-pending').length===0`);

  // A stream cut off mid-bubble: the writer settles it, the partial waits for history to check it.
  await execute(`fixture.emit({sessionId:fixture.A,type:'delta',text:'说到一半'})`); await settle(); await settle();
  await execute(`fixture.views[fixture.A].replied.push({text:'说到一半',think:'',at:'2026-09-11T12:01:00Z',partial:true});fixture.views[fixture.A].version++;fixture.emit({sessionId:fixture.A,type:'settled'})`); await settle(); await settle();
  await check('a settled writer turns the live bubble into a partial that says so', `document.querySelectorAll('.chat-message.is-live').length===0&&document.querySelectorAll('.chat-message.is-being.is-pending').length===1&&document.querySelector('.chat-message.is-being.is-pending .chat-meta').textContent.endsWith(' · 回复中断，等待记录核对')&&document.querySelector('.chat-message.is-being.is-pending .chat-body').textContent==='说到一半'`);
  await execute(`fixture.views[fixture.A]={...fixture.views[fixture.A],replied:[]};fixture.current=fixture.state(4);beingChat.setState(fixture.current)`); await settle(); await settle();

  // Newest at the bottom: a reply history never confirmed (it followed row 5, spoken 12:00:40) sits
  // between the rows it was spoken between, not under the exchange that came after it; a message
  // just sent follows every row it was sent after even when the local clock runs behind.
  await execute(`fixture.views[fixture.A]={...fixture.views[fixture.A],rows:[...fixture.views[fixture.A].rows,{seq:6,role:'user',content:'后来的问题',at:'2026-09-11T12:01:22Z'},{seq:7,role:'being',content:'后来的回答',at:'2026-09-11T12:01:42Z'}],sent:[{text:'刚发的',at:'2026-09-11T12:01:30Z',after:7}],replied:[{text:'没被记录确认的旧回复',think:'',at:'2026-09-11T12:00:40Z',after:5}]};fixture.current=fixture.state(5);beingChat.setState(fixture.current)`); await settle(); await settle();
  await check('transient items are drawn in time order among the rows, newest last', `[...document.querySelectorAll('.chat-message')].map(el=>el.querySelector('.chat-body').textContent).join('|')==='帮我看看这段代码|'+document.querySelectorAll('.chat-message')[1].querySelector('.chat-body').textContent+'|再帮我改一下|改成这样|没被记录确认的旧回复|后来的问题|后来的回答|刚发的'`);
  await capture('chat-interleaved');
  await execute(`fixture.views[fixture.A]={...fixture.views[fixture.A],rows:fixture.views[fixture.A].rows.slice(0,4),sent:[],replied:[]};fixture.current=fixture.state(6);beingChat.setState(fixture.current)`); await settle(); await settle();

  await execute(`fixture.current=fixture.state(6);fixture.current.chat.recovery={phase:'idle',sessionId:fixture.A,gaveUp:true,hint:'这口气没有留下给这个会话的话。'};beingChat.setState(fixture.current)`); await settle();
  await check('a catch-up that found nothing says so neutrally', `document.querySelector('.chat-phase').textContent==='这口气没有留下给这个会话的话。'&&document.querySelector('.chat-stop').hidden`);
  await execute(`fixture.current=fixture.state(6);fixture.current.chat.recovery={phase:'idle',sessionId:fixture.B,gaveUp:true,hint:'这口气没有留下给这个会话的话。'};beingChat.setState(fixture.current)`); await settle();
  await check('a hint about another conversation stays out of this header', `document.querySelector('.chat-phase').textContent===''`);

  await execute(`fixture.current=fixture.state(6);fixture.current.chat.recovery={phase:'catching-up'};fixture.current.chat.sessions[0].busy=true;beingChat.setState(fixture.current)`); await settle();
  await check('a recovery phase shows its hint and the stop button while the conversation is busy', `document.querySelector('.chat-phase').textContent.includes('消息已送达')&&!document.querySelector('.chat-stop').hidden`);
  await execute(`document.querySelector('.chat-stop').click()`); await settle(); await settle();
  await check('stopping another conversation breath asks first and names it, then forces on consent', `fixture.calls.stop.length===2&&fixture.calls.stop[0].force===undefined&&fixture.calls.stop[1].force===true&&fixture.confirms.length===1&&fixture.confirms[0].includes('「乙」')`);
  await execute(`fixture.confirmAnswer=false;fixture.calls.stop=[];document.querySelector('.chat-stop').click()`); await settle(); await settle();
  await check('declining the prompt leaves the other conversation alone', `fixture.calls.stop.length===1&&fixture.calls.stop[0].force===undefined`);
  await execute(`fixture.confirmAnswer=false;fixture.calls.stop=[];fixture.confirms=[];fixture.stopResult={stopped:false,reason:'unknown',scene:'desktop-x-'+fixture.A,ownerTitle:'代码审查'};document.querySelector('.chat-stop').click()`); await settle(); await settle();
  await check('a bubble that just closed names the last speaker and admits the next is unknown', `fixture.calls.stop.length===1&&fixture.confirms.length===1&&fixture.confirms[0].includes('刚说完的是「代码审查」')&&fixture.confirms[0].includes('仍要停止')`);

  await execute(`fixture.current=fixture.state(6);fixture.current.chat.sessions[0].truncated=true;beingChat.setState(fixture.current)`); await settle(); await settle();
  await check('a trimmed transcript offers a re-read', `document.querySelector('.chat-more')!==null`);
  await execute(`document.querySelector('.chat-more').click()`); await settle();
  await check('the re-read goes through the bridge', `fixture.calls.reload===1`);

  await execute(`fixture.sendError='Being 服务暂时不可用。';const input=document.querySelector('.chat-input');input.value='发不出去';document.querySelector('.chat-composer').requestSubmit()`); await settle(); await settle();
  await check('a send that fails before dispatch restores the draft and reports why', `document.querySelector('.chat-input').value==='发不出去'&&fixture.toasts.at(-1).message==='Being 服务暂时不可用。'&&fixture.toasts.at(-1).error===true`);
  await execute(`fixture.sendError='';fixture.sendResult={ok:true,streamed:false,spliced:true,recovering:''};document.querySelector('.chat-composer').requestSubmit()`); await settle(); await settle();
  await check('a spliced send tells the user the message was delivered and is queued', `fixture.toasts.at(-1).message.includes('已送达')&&fixture.toasts.at(-1).error===false`);

  // Images: pasted or dropped into the view, previewed in the tray, sent as blocks beside the
  // words, and kept as previews on the row that confirms the message (the Being keeps none).
  await check('the composer offers an image picker', `!document.querySelector('.chat-attach').disabled&&document.querySelector('.chat-composer input[type=file]').accept==='image/png,image/jpeg,image/webp,image/gif'`);
  await execute(`(async()=>{const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;const ctx=canvas.getContext('2d');ctx.fillStyle='#ffe600';ctx.fillRect(0,0,640,480);ctx.fillStyle='#009600';ctx.beginPath();ctx.arc(320,240,160,0,Math.PI*2);ctx.fill();const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));fixture.file=new File([blob],'probe.png',{type:'image/png'});fixture.sendResult=null;fixture.calls.send=[];fixture.toasts=[];const dt=new DataTransfer();dt.items.add(fixture.file);document.querySelector('.chat-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));})()`);
  await waitFor('.chat-tray-item img');
  await check('a pasted image lands in the tray with a small preview', `(async()=>{const img=document.querySelector('.chat-tray-item img');await img.decode();return document.querySelectorAll('.chat-tray-item').length===1&&img.src.startsWith('data:image/jpeg;base64,')&&img.naturalWidth===256&&img.naturalHeight===192&&!document.querySelector('.chat-tray').hidden&&document.querySelector('.chat-tray-note').textContent.includes('1 张图片');})()`);
  await execute(`document.querySelector('.chat-input').value='';document.querySelector('.chat-composer').requestSubmit()`); await settle();
  await check('an image without words is not sent', `fixture.calls.send.length===0&&fixture.toasts.at(-1).message==='给图片配一句话再发送。'&&fixture.toasts.at(-1).error===true&&document.querySelectorAll('.chat-tray-item').length===1`);
  await execute(`(()=>{const dt=new DataTransfer();dt.items.add(new File(['x'],'notes.txt',{type:'text/plain'}));document.getElementById('chat-native').dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));})()`); await settle(); await settle();
  await check('a dropped non-image is refused and says so', `fixture.toasts.at(-1).message.includes('不是图片')&&fixture.toasts.at(-1).error===true&&document.querySelectorAll('.chat-tray-item').length===1`);
  await execute(`document.querySelector('.chat-input').value='这是什么？';document.querySelector('.chat-composer').requestSubmit()`); await settle(); await settle();
  await check('the words and the image go together through the bridge, and the tray empties', `(()=>{const call=fixture.calls.send[0];return fixture.calls.send.length===1&&call.text==='这是什么？'&&call.images.length===1&&call.images[0].media_type==='image/png'&&call.images[0].name==='probe.png'&&/^[A-Za-z0-9+/]+=*$/.test(call.images[0].data)&&atob(call.images[0].data).startsWith('\\x89PNG')&&call.images[0].thumb.startsWith('data:image/jpeg;base64,')&&document.querySelector('.chat-tray').hidden&&document.querySelector('.chat-input').value==='';})()`);
  await execute(`fixture.current=fixture.state(8);beingChat.setState(fixture.current)`); await settle(); await settle();
  await check('the pending message shows its image preview above the words', `(()=>{const bubble=[...document.querySelectorAll('.chat-message.is-user.is-pending')].at(-1);return bubble.querySelector('.chat-images img')?.src.startsWith('data:image/jpeg;base64,')===true&&bubble.querySelector('.chat-images').nextElementSibling.classList.contains('chat-body');})()`);
  await execute(`(()=>{const sent=fixture.views[fixture.A].sent.pop();fixture.views[fixture.A].sent=[];fixture.views[fixture.A].rows.push({seq:8,role:'user',content:'这是什么？',at:'2026-09-11T12:05:00Z',images:sent.images});fixture.views[fixture.A].version++;fixture.current=fixture.state(9);beingChat.setState(fixture.current);})()`); await settle(); await settle();
  await check('a confirmed row keeps the preview of what was sent with it', `document.querySelectorAll('.is-pending').length===0&&[...document.querySelectorAll('.chat-message.is-user')].at(-1).querySelector('.chat-images img')?.src.startsWith('data:image/jpeg;base64,')===true`);
  await capture('chat-images');
  await execute(`(()=>{fixture.sendError='Being 服务暂时不可用。';fixture.calls.send=[];const dt=new DataTransfer();dt.items.add(fixture.file);document.getElementById('chat-native').dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));})()`);
  await waitFor('.chat-tray-item');
  await execute(`document.querySelector('.chat-input').value='再看一次';document.querySelector('.chat-composer').requestSubmit()`); await settle(); await settle();
  await check('a send that fails before dispatch gives the image back with the draft', `fixture.calls.send.length===1&&document.querySelector('.chat-input').value==='再看一次'&&document.querySelectorAll('.chat-tray-item').length===1&&fixture.toasts.at(-1).error===true`);
  await execute(`fixture.sendError='';document.querySelector('.chat-tray-remove').click()`); await settle();
  await check('removing a pending image empties the tray', `document.querySelector('.chat-tray').hidden&&document.querySelectorAll('.chat-tray-item').length===0`);
  await execute(`(()=>{const dt=new DataTransfer();dt.items.add(fixture.file);document.getElementById('chat-native').dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));})()`);
  await waitFor('.chat-tray-item');
  await execute(`document.querySelector('.chat-input').value=''`);

  await execute(`fixture.current=fixture.state(7);fixture.current.chat.active=fixture.B;beingChat.setState(fixture.current)`); await settle(); await settle();
  await check('switching conversations reloads the projection for the new one', `document.querySelectorAll('.chat-message').length===1&&document.querySelector('.chat-message').textContent.includes('乙会话的问题')`);
  await check('switching conversations leaves the other one\'s pending image behind', `document.querySelector('.chat-tray').hidden&&document.querySelectorAll('.chat-tray-item').length===0`);
  await execute(`fixture.current=fixture.state(7);fixture.current.chat.active=fixture.B;fixture.current.chat.degraded=true;beingChat.setState(fixture.current)`); await settle();
  await check('a store without encryption says the records stay in memory', `document.querySelector('.chat-phase').textContent.includes('仅保留在内存')`);
  await execute(`fixture.current=fixture.state(7);fixture.current.connection.status='disconnected';beingChat.setState(fixture.current)`); await settle();
  await check('disconnecting disables the composer', `document.querySelector('.chat-input').disabled&&document.querySelector('.chat-send').disabled&&document.querySelector('.chat-phase').textContent==='尚未连接'`);
  await execute(`fixture.current=fixture.state(7);fixture.current.settings.chatMode='loom';beingChat.setState(fixture.current)`); await settle();
  await check('loom mode hides the native view entirely', `document.getElementById('chat-native').hidden`);
  assert.equal(forbiddenRequests, 0, 'Fixture must never request remote resources');
}

run().then(() => { report.passed = true; }, error => { report.passed = false; report.error = error.stack; process.stderr.write(`${error.stack}\n`); }).finally(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`Report: ${path.join(output, 'report.json')}\n`);
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(report.passed ? 0 : 1);
});
