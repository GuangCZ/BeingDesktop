'use strict';
// Runs inside the existing isolated Electron fixture; every bridge operation is in memory.
const {normalizeComposerData} = require('../src/loom-composer.cjs');
module.exports = async ({execute, check, settle, capture, win}) => {
  const flush = async () => { await settle(); await settle(); };
  const draft = async text => { await execute(`(()=>{const i=document.querySelector('.chat-input');i.value=${JSON.stringify(text)};i.focus();i.setSelectionRange(i.value.length,i.value.length);i.dispatchEvent(new Event('input',{bubbles:true}));})()`); await flush(); };
  const key = async keyCode => { win.webContents.sendInputEvent({type:'keyDown',keyCode}); win.webContents.sendInputEvent({type:'keyUp',keyCode}); await flush(); };
  const data = {...normalizeComposerData({kits:[{id:'not-installed',name:'Uninstalled Market Kit'},{installed:true,id:'fixture-kit',name:'Fixture Tools',description:'测试工具目录'}],members:[{id:'alice',name:'Alice',bio:'写作伙伴'},{id:'bob',name:'Bob',bio:'设计伙伴'}]}),connectionRevision:101};
  await execute(`(()=>{
    fixture.composerData=${JSON.stringify(data)};fixture.catalogCalls=0;fixture.publicCalls=[];fixture.calls.send=[];fixture.toasts=[];
    fixture.sendGate=null;fixture.sendError='';fixture.publicError='';fixture.sendResult={ok:true,streamed:true};
    beingDesktop.getChatComposerData=async()=>{fixture.catalogCalls++;if(fixture.catalogGate)await fixture.catalogGate;if(fixture.catalogError)throw Error('unavailable');return structuredClone(fixture.composerData);};
    beingDesktop.chatSend=async value=>{fixture.calls.send.push(structuredClone(value));if(fixture.sendGate)await fixture.sendGate;if(fixture.sendError)throw Error(fixture.sendError);return fixture.sendResult;};
    beingDesktop.sendBonfireMessage=async value=>{fixture.publicCalls.push(structuredClone(value));if(fixture.publicError)throw Error(fixture.publicError);return {ok:true,id:'123',mentions:value.mentions};};
    fixture.current=fixture.state(200);fixture.current.townApp={identity:{connectionRevision:101}};beingChat.setState(fixture.current);
  })()`); await flush();
  await draft('/');
  await check('native slash lists builtins and installed Kits only', `document.querySelectorAll('.chat-composer-option').length===3&&!document.querySelector('.chat-composer-menu').hidden&&fixture.catalogCalls>=1`);
  await check('native menu uses the selected surface theme for readable highlights', `getComputedStyle(document.querySelector('.chat-composer-option')).backgroundColor==='rgb(230, 230, 230)'&&getComputedStyle(document.querySelector('.chat-composer-option')).color==='rgb(32, 32, 32)'`);
  await capture('native-slash-kits');
  await key('Down'); await key('Tab');
  await check('native arrows and Tab insert Browse without sending', `document.querySelector('.chat-input').value==='/browse '&&fixture.calls.send.length===0&&document.querySelector('.chat-composer-menu').hidden`);
  await draft('/Fixture'); await key('Enter');
  await check('native Enter selects a Kit without sending', `document.querySelector('.chat-input').value==='/Fixture-Tools '&&fixture.calls.send.length===0`);
  await draft('/search 测试'); await key('Enter');
  await check('native slash send expands the built-in request once', `fixture.calls.send.length===1&&fixture.calls.send[0].text.includes('网络搜索（Search）')&&fixture.calls.send[0].text.endsWith('/search 测试')&&fixture.publicCalls.length===0`);
  await draft('https://example.invalid/a user@example.invalid');
  await check('native composer ignores URLs and emails', `document.querySelector('.chat-composer-menu').hidden`);
  await draft('@'); await key('Escape');
  await check('Escape closes native suggestions and preserves the draft', `document.querySelector('.chat-composer-menu').hidden&&document.querySelector('.chat-input').value==='@'`);
  await draft('@Ali'); await key('Enter');
  await check('native mention inserts display name and announces public sharing', `document.querySelector('.chat-input').value==='@Alice '&&document.querySelector('.chat-composer-notice').textContent.includes('公开到篝火')&&fixture.publicCalls.length===0`);
  await capture('native-mention-notice');
  await draft('@alice 合作讨论');
  await execute(`document.querySelector('.chat-send').click()`); await flush();
  await check('synthetic mention clicks preserve the draft and publish nothing', `fixture.publicCalls.length===0&&fixture.calls.send.length===1&&document.querySelector('.chat-input').value==='@alice 合作讨论'`);
  await execute(`document.querySelector('.chat-input').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))`); await key('Enter');
  await execute(`document.querySelector('.chat-input').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));document.querySelector('.chat-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
  await check('IME commit and its trailing Enter never send or publish', `fixture.calls.send.length===1&&fixture.publicCalls.length===0`);
  await execute(`new Promise(resolve=>setTimeout(resolve,65))`); await key('Enter');
  await check('trusted Enter sends the original mention to Bonfire exactly once', `fixture.calls.send.length===2&&fixture.publicCalls.length===1&&fixture.publicCalls[0].content==='@alice 合作讨论'&&fixture.publicCalls[0].mentions.join()==='alice'&&fixture.publicCalls[0].connectionRevision===101&&typeof fixture.publicCalls[0].requestId==='string'&&fixture.toasts.at(-1).message.includes('Town 已接受')`);
  await draft('/browse @bob 查看网页'); await key('Enter');
  await check('public mention never includes expanded Kit instructions', `fixture.calls.send.at(-1).text.includes('网页读取（Browse）')&&fixture.publicCalls.at(-1).content==='/browse @bob 查看网页'`);
  await execute(`fixture.sendError='私聊失败'`); await draft('@alice 失败的草稿'); await key('Enter');
  await check('private failure restores the raw draft and never posts publicly', `fixture.publicCalls.length===2&&document.querySelector('.chat-input').value==='@alice 失败的草稿'`);
  await execute(`fixture.sendError='';fixture.publicError='通知状态未知'`); await draft('@alice 通知失败'); await key('Enter');
  await check('public failure never restores an already sent private draft or retries', `fixture.publicCalls.length===3&&document.querySelector('.chat-input').value===''&&fixture.toasts.at(-1).message.includes('不会自动重发')`);
  await execute(`fixture.publicError='';fixture.sendResult={ok:true,streamed:false,spliced:false,recovering:'unknown'}`); await draft('@alice 待确认'); await key('Enter');
  await check('uncertain private delivery does not publish a mention', `fixture.publicCalls.length===3&&fixture.toasts.at(-1).message.includes('尚未发布')`);
  await execute(`fixture.sendResult={ok:true,streamed:true};fixture.sendGate=new Promise(resolve=>fixture.releaseComposerSend=resolve);void 0`); await draft('@alice 连接变化'); await key('Enter');
  await execute(`fixture.current.townApp.identity.connectionRevision=102;fixture.composerData.connectionRevision=102;beingChat.setState(fixture.current);fixture.releaseComposerSend()`); await flush();
  await check('connection change fences pending public notification', `fixture.publicCalls.length===3&&fixture.toasts.at(-1).message.includes('连接已变化')`);
  await execute(`fixture.sendGate=null`); await draft('甲的草稿 @');
  await execute(`fixture.current.chat.active=fixture.B;beingChat.setState(fixture.current)`); await draft('乙的草稿');
  await execute(`fixture.current.chat.active=fixture.A;beingChat.setState(fixture.current)`); await flush();
  await check('session switching retains each draft and recalculates suggestions', `document.querySelector('.chat-input').value==='甲的草稿 @'&&document.querySelectorAll('.chat-composer-option').length===2`);
  await execute(`fixture.catalogError=true;fixture.current.townApp.identity.connectionRevision=103;beingChat.setState(fixture.current)`); await flush(); await draft('/');
  await check('failed catalog keeps builtins and offers an accessible icon-only retry', `document.querySelectorAll('.chat-composer-option').length===2&&!!document.querySelector('.chat-composer-retry svg')&&document.querySelector('.chat-composer-retry').textContent===''&&document.querySelector('.chat-composer-retry').getAttribute('aria-label')==='重新加载'`);
  await capture('composer-load-error-retry-icon');
  await draft('@alice 成员未加载'); await key('Enter');
  await check('unavailable directory sends the raw private message with an explicit notification warning', `document.querySelector('.chat-input').value===''&&fixture.calls.send.at(-1).text==='@alice 成员未加载'&&fixture.publicCalls.length===3&&fixture.toasts.at(-1).message.includes('可能不会触发通知')`);
  await draft('@'); await execute(`fixture.catalogError=false;fixture.composerData.connectionRevision=103;document.querySelector('.chat-composer-retry').click()`); await flush();
  await check('retry repopulates member suggestions and removes the retry button', `document.querySelectorAll('.chat-composer-option').length===2&&!document.querySelector('.chat-composer-retry')`);
  const point = await execute(`(()=>{const r=document.querySelectorAll('.chat-composer-option')[1].getBoundingClientRect();return{x:Math.round(r.left+20),y:Math.round(r.top+r.height/2)}})()`);
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point}); win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point}); await flush();
  await check('native pointer selection inserts the selected Being', `document.querySelector('.chat-input').value==='@Bob '`);
  win.setContentSize(390,650); await draft('@');
  await check('native suggestions fit a narrow viewport', `(()=>{const r=document.querySelector('.chat-composer-menu').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`);
  await capture('native-mentions-narrow');
  await execute(`fixture.sendResult={ok:true,streamed:false,spliced:true}`); await draft('@alice 点击发送');
  const sendPoint = await execute(`(()=>{const r=document.querySelector('.chat-send').getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...sendPoint}); win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...sendPoint}); await flush();
  await check('trusted send button publishes once after confirmed queued delivery', `fixture.publicCalls.length===4&&fixture.publicCalls.at(-1).content==='@alice 点击发送'&&document.querySelector('.chat-input').value===''`);

  await execute(`fixture.catalogGate=new Promise(resolve=>fixture.releaseCatalog=resolve);fixture.current.townApp.identity.connectionRevision=104;beingChat.setState(fixture.current);fixture.current.connection.status='disconnected';beingChat.setState(fixture.current);fixture.releaseCatalog()`); await flush();
  await check('late catalog responses cannot reopen a disconnected composer', `document.querySelector('.chat-input').disabled&&document.querySelector('.chat-composer-menu').hidden`);
  await execute(`fixture.catalogGate=null;fixture.current.connection.status='connected';fixture.current.townApp.identity.connectionRevision=105;fixture.composerData.connectionRevision=105;fixture.composerData.members=[
    {id:'t_hidden_yomi',handle:'t_hidden_yomi',name:'YomiyaHina',kind:'member',description:'伙伴'},
    {id:'t_twin_a',handle:'t_twin_a',name:'Twin Name',kind:'member',description:'第一位'},
    {id:'t_twin_b',handle:'t_twin_b',name:'Twin Name',kind:'member',description:'第二位'}
  ];beingChat.setState(fixture.current)`); await flush();
  await draft('@Yom'); await key('Enter');
  await check('selecting a Being keeps Town ID out of the composer', `document.querySelector('.chat-input').value==='@YomiyaHina '&&!document.querySelector('.chat-input').value.includes('t_hidden')`);
  await capture('native-display-name-mention');
  await draft('@YomiyaHina 你好'); await key('Enter');
  await check('display name is resolved to the selected Town ID only when sending', `fixture.publicCalls.at(-1).content==='@t_hidden_yomi 你好'&&fixture.publicCalls.at(-1).mentions.join()==='t_hidden_yomi'`);
  await draft('@Twin'); await key('Down'); await key('Enter');
  await check('a selected duplicate name with spaces stays readable', `document.querySelector('.chat-input').value==='@Twin Name '`);
  await draft('你好 @Twin Name '); await draft('你好 @Twin Name 请看看');
  await execute(`fixture.current.chat.active=fixture.B;beingChat.setState(fixture.current)`); await draft('另一会话');
  await execute(`fixture.current.chat.active=fixture.A;beingChat.setState(fixture.current)`); await flush(); await key('Enter');
  await check('editing surrounding text and switching sessions retain the chosen duplicate identity', `fixture.publicCalls.at(-1).content==='你好 @t_twin_b 请看看'&&fixture.publicCalls.at(-1).mentions.join()==='t_twin_b'`);

  await execute(`fixture.views[fixture.A]={sessionId:fixture.A,version:300,rows:[
    {seq:31,role:'user',content:'@t_hidden_yomi 历史消息',at:'2026-09-14T10:00:00Z'},
    {seq:32,role:'being',content:'@t_hidden_yomi 的回复',at:'2026-09-14T10:01:00Z'}
  ],sent:[{text:'@t_hidden_yomi 待确认消息',at:'2026-09-14T10:02:00Z',after:32}],replied:[],live:null};fixture.current.chat.version=300;beingChat.setState(fixture.current)`); await flush();
  await check('pending and historical message bubbles display Being names', `document.querySelector('.chat-message.is-pending .chat-body').textContent==='@YomiyaHina 待确认消息'&&document.querySelector('.chat-message.is-user .chat-body').textContent==='@YomiyaHina 历史消息'&&!document.querySelector('.chat-stream').textContent.includes('@t_hidden_yomi')`);
  await capture('message-mention-display-names');
  await check('message display never rewrites canonical history or pending message data', `fixture.views[fixture.A].rows[0].content==='@t_hidden_yomi 历史消息'&&fixture.views[fixture.A].sent[0].text==='@t_hidden_yomi 待确认消息'`);
  await execute(`fixture.composerData.members[0].name='Yomiya 新名字';fixture.current.townApp.identity.connectionRevision=106;fixture.composerData.connectionRevision=106;beingChat.setState(fixture.current)`); await flush();
  await check('member data refresh updates existing bubble names', `document.querySelector('.chat-message.is-pending .chat-body').textContent==='@Yomiya 新名字 待确认消息'`);
  await execute(`fixture.composerData.members[0].name='<img src=x onerror=alert(1)> **名字**';fixture.current.townApp.identity.connectionRevision=107;fixture.composerData.connectionRevision=107;beingChat.setState(fixture.current)`); await flush();
  await check('display names remain plain text rather than HTML or Markdown', `document.querySelector('.chat-message.is-pending .chat-body').textContent.includes('@<img src=x onerror=alert(1)> **名字**')&&!document.querySelector('.chat-message.is-pending .chat-body img')&&!document.querySelector('.chat-message.is-pending .chat-body strong')`);
  await execute(`fixture.views[fixture.A].rows[0].content='代码：'+String.fromCharCode(96)+'@t_hidden_yomi'+String.fromCharCode(96)+' [文档](https://example.invalid/@t_hidden_yomi)';fixture.current.chat.version=301;beingChat.setState(fixture.current)`); await flush();
  await check('literal code and link destinations retain their original IDs', `document.querySelector('.chat-message.is-user code').textContent==='@t_hidden_yomi'&&document.querySelector('.chat-message.is-user .chat-link').title==='https://example.invalid/@t_hidden_yomi'`);

};
