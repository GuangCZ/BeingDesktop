'use strict';

// This hidden fixture applies the production Loom adapter to local presentation DOM.
// It does not load credentials, contact services, select files or send messages.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {pathToFileURL, fileURLToPath} = require('node:url');
const {randomUUID, createHash} = require('node:crypto');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const {spawn} = require('node:child_process');
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], {cwd: root, env, windowsHide: true, stdio: 'inherit'});
  child.on('error', error => {process.stderr.write(`${error.message}\n`); process.exitCode = 1;});
  child.on('exit', code => {process.exitCode = code ?? 1;});
} else {
  const {app, BrowserWindow} = require('electron');
  const {applyLoomTheme} = require('../src/loom-theme.cjs');
  const runRoot = path.join(root, '.local', `capsule-composer-${randomUUID()}`);
  const fixture = path.join(runRoot, 'fixture.html');
  const report = {version: require('../package.json').version,
    scope: 'Offline composer presentation fixture with production theme and simulated local textarea resizing. No real Loom session, attachments or sending.',
    checks: [], screenshots: [], observations: []};
  let win;
  let forbiddenRequests = 0;
  let latestPaint;
  let frameSequence = 0;
  app.setPath('userData', path.join(runRoot, 'profile'));
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  const check = (name, passed, detail) => report.checks.push({name, passed: Boolean(passed), ...(detail === undefined ? {} : {detail})});
  const execute = script => {
    assert.equal(win.webContents.getURL(), pathToFileURL(fixture).href);
    return win.webContents.executeJavaScript(script);
  };
  const settle = () => execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const snapshot = `(() => {
    const rect = element => {const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    const row=document.getElementById('input-row'),input=document.getElementById('input'),send=document.getElementById('send-btn'),attach=document.getElementById('desktop-attach'),pending=document.getElementById('pending-files');
    return {width:innerWidth,height:innerHeight,bodyWidth:document.documentElement.scrollWidth,
      row:rect(row),input:rect(input),send:rect(send),attach:rect(attach),pending:rect(pending),
      radius:parseFloat(getComputedStyle(row).borderTopLeftRadius),border:getComputedStyle(row).borderColor,
      inputScroll:input.scrollHeight,inputClient:input.clientHeight,inputOverflow:getComputedStyle(input).overflowY,
      fontSize:getComputedStyle(input).fontSize,focused:document.activeElement.id,
      contentSizing:CSS.supports('field-sizing','content')&&getComputedStyle(input).fieldSizing==='content',inlineHeight:input.style.height,
      attachOutline:getComputedStyle(attach).outlineStyle,sendDisabled:send.disabled,
      theme:document.documentElement.dataset.beingDesktopTheme,
      attachments:pending.childElementCount,events:{...window.fixtureEvents}};
  })()`;

  async function capture(name, state) {
    let image;
    let previousHash = '';
    let ready = false;
    for (let attempt = 0; attempt < 30 && !ready; attempt++) {
      const previousFrame = frameSequence;
      const painted = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {win.webContents.removeListener('paint', listener); reject(new Error('Offscreen paint timed out.'));}, 3000);
        const listener = () => {
          if (frameSequence > previousFrame) {clearTimeout(timer); win.webContents.removeListener('paint', listener); resolve(latestPaint);}
        };
        win.webContents.on('paint', listener);
      });
      win.webContents.invalidate();
      image = await painted;
      const size = image.getSize();
      if (size.width === state.width && size.height === state.height) {
        const pixels = image.toBitmap();
        const x=Math.round(state.row.x+state.row.width/2),y=Math.round(state.row.y+state.row.height/2);
        const offset=(y*size.width+x)*4;
        const composerPainted=pixels[offset]>30&&pixels[offset]<80;
        const hash=createHash('sha256').update(pixels).digest('hex');
        ready=composerPainted&&hash===previousHash;
        previousHash=composerPainted?hash:'';
      }
      if (!ready) await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert(ready, 'Composer did not settle into a visible offscreen frame.');
    const output = path.join(runRoot, `${name}.png`);
    await fs.writeFile(output, image.toPNG());
    report.screenshots.push(output);
  }

  async function run() {
    await fs.mkdir(runRoot, {recursive:true});
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Composer presentation fixture</title><style>
      *{box-sizing:border-box}html,body{height:100%;overflow:hidden}#app{display:flex;flex-direction:column}#messages{flex:1;overflow:auto}#header{display:flex;align-items:center}#input-area{flex-shrink:0}#input-row{display:flex;gap:8px;align-items:flex-end}#input{flex:1;min-width:0;resize:none;padding:10px 14px;border:1px solid #333;border-radius:20px;font:14px/1.5 sans-serif;max-height:200px;overflow-y:auto}#send-btn{display:flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer}#send-btn svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}#file-input{display:none}#pending-files{display:flex;flex-wrap:wrap;gap:8px}#pending-files:empty{display:none}.pending-file{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid #404040;border-radius:10px;color:#ddd;background:#292929}.pending-file button{background:transparent;border:0;color:#aaa;cursor:pointer}.fixture-caption{padding:20px 28px;color:#888;font:12px/1.5 sans-serif}
    </style></head><body><div id="app"><div id="header"></div><div id="messages"><div class="message being"><div class="content"><p>胶囊式输入框</p></div></div></div><div id="input-area"><div id="pending-files"></div><div id="input-row"><textarea id="input" rows="1" style="height:45px" placeholder="message being..."></textarea><button id="send-btn" aria-label="发送" disabled><svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button></div><input id="file-input" type="file" multiple></div></div><script>
      window.fixtureEvents={send:0,files:0};
      document.getElementById('send-btn').addEventListener('click',()=>fixtureEvents.send++);
      document.getElementById('file-input').addEventListener('click',event=>{event.preventDefault();fixtureEvents.files++;});
      window.fixtureResize=()=>{const input=document.getElementById('input');input.style.height='auto';input.style.height=input.scrollHeight+'px';document.getElementById('send-btn').disabled=!input.value.trim();};
      document.getElementById('input').addEventListener('input',fixtureResize);
    </script></body></html>`;
    await fs.writeFile(fixture, html);
    await app.whenReady();
    win = new BrowserWindow({show:false,frame:false,width:1100,height:560,useContentSize:true,
      webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true,partition:`capsule-${randomUUID()}`}});
    win.webContents.on('paint',(_event,_dirty,image)=>{frameSequence++;latestPaint=image;});
    win.webContents.setFrameRate(30);
    win.webContents.session.webRequest.onBeforeRequest((details,callback)=>{
      const allowed=details.url.startsWith('file:')&&fileURLToPath(details.url)===fixture;
      if(!allowed)forbiddenRequests++;
      callback({cancel:!allowed});
    });
    await win.loadFile(fixture);
    await applyLoomTheme(win.webContents);
    await execute("document.fonts.ready.then(()=>{document.body.style.caretColor='transparent';})");
    await settle();
    const initial=await execute(snapshot);
    report.observations.push({phase:'empty',...initial});
    check('production-theme-applied',initial.theme==='codex');
    check('native-content-sizing-supported-and-active',initial.contentSizing);
    check('legacy-inline-height-does-not-expand-empty-composer',initial.inlineHeight==='45px'&&initial.input.height===24);
    check('empty-composer-is-compact-capsule',initial.row.height>=48&&initial.row.height<=64&&initial.radius>=initial.row.height/2-1,initial.row);
    check('empty-send-remains-disabled',initial.sendDisabled);
    await capture('01-capsule-empty',initial);

    await execute("document.getElementById('input').focus();document.getElementById('input').value='帮我整理今天的灵感';document.getElementById('input').dispatchEvent(new Event('input',{bubbles:true}));");
    await settle();
    const focused=await execute(snapshot);
    report.observations.push({phase:'focused',...focused});
    check('focus-indicator-remains-visible',focused.focused==='input'&&focused.border!==initial.border);
    check('single-line-does-not-jump-to-tall-editor',focused.row.height<=64,focused.row);
    check('typed-send-is-enabled',!focused.sendDisabled);
    check('upstream-inline-resize-keeps-capsule-layout',focused.inlineHeight.endsWith('px')&&focused.contentSizing&&focused.row.height<=64);
    await capture('02-capsule-focused',focused);

    await execute("document.getElementById('input').value='整理本周计划\\n列出三个优先事项\\n并保留一个自由探索的方向';fixtureResize();document.getElementById('input').blur();");
    await settle();
    const multi=await execute(snapshot);
    report.observations.push({phase:'multiline',...multi});
    check('multiline-grows-with-content',multi.row.height>focused.row.height&&multi.input.height>focused.input.height);
    check('multiline-content-does-not-overlap-controls',multi.input.x>=multi.attach.right&&multi.input.right<=multi.send.x,{input:multi.input,attach:multi.attach,send:multi.send});
    check('multiline-buttons-remain-contained',[multi.send,multi.attach].every(r=>r.x>=multi.row.x&&r.y>=multi.row.y&&r.right<=multi.row.right&&r.bottom<=multi.row.bottom));
    await capture('03-capsule-multiline',multi);

    await execute("document.getElementById('pending-files').innerHTML='<div class=\"pending-file\"><span>设计草稿.png</span><button aria-label=\"移除附件\">×</button></div><div class=\"pending-file\"><span>本周计划.md</span><button aria-label=\"移除附件\">×</button></div>';document.getElementById('input').value='看看这两个附件';fixtureResize();document.getElementById('input').focus();");
    for (let tab=0;tab<2;tab++) {
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
      await settle();
    }
    await settle();
    const attached=await execute(snapshot);
    report.observations.push({phase:'attachments',...attached});
    check('attachments-remain-above-composer',attached.attachments===2&&attached.pending.bottom<=attached.row.y);
    check('attachment-keyboard-focus-has-visible-indicator',attached.focused==='desktop-attach'&&(attached.attachOutline!=='none'||attached.border!==initial.border));
    await capture('04-capsule-attachments',attached);

    win.setContentSize(420,560);
    await execute("document.getElementById('input').value='窄窗口下也能自然输入和换行，左右按钮不会挤到正文。';fixtureResize();document.getElementById('desktop-attach').blur();");
    await settle();
    const narrow=await execute(snapshot);
    report.observations.push({phase:'narrow',...narrow});
    check('narrow-composer-stays-in-viewport',narrow.bodyWidth<=narrow.width&&narrow.row.x>=0&&narrow.row.right<=narrow.width);
    check('narrow-text-does-not-overlap-controls',narrow.input.x>=narrow.attach.right&&narrow.input.right<=narrow.send.x);
    await capture('05-capsule-narrow',narrow);

    await execute("document.getElementById('input').value=Array.from({length:24},(_,i)=>'第 '+(i+1)+' 行：长文本检查').join('\\n');fixtureResize();");
    await settle();
    const long=await execute(snapshot);
    report.observations.push({phase:'long',...long});
    check('long-text-height-remains-bounded',long.input.height<=220&&long.inputScroll>long.inputClient&&['auto','scroll'].includes(long.inputOverflow),{height:long.input.height,scroll:long.inputScroll,client:long.inputClient});
    check('long-editor-stays-usable',long.row.y>=0&&long.row.bottom<=long.height);
    check('no-send-or-file-chooser-invocations',long.events.send===0&&long.events.files===0,long.events);
    check('no-external-requests',forbiddenRequests===0,forbiddenRequests);
    report.passed=report.checks.every(item=>item.passed);
  }
  run().catch(error=>{report.passed=false;report.error=error.stack||error.message;}).finally(async()=>{
    await fs.mkdir(runRoot,{recursive:true});
    const reportPath=path.join(runRoot,'report.json');
    await fs.writeFile(reportPath,JSON.stringify(report,null,2));
    process.stdout.write(JSON.stringify({passed:report.passed,checks:report.checks.length,failed:report.checks.filter(item=>!item.passed).map(item=>item.name),report:reportPath,screenshots:report.screenshots,error:report.error||null})+'\n');
    if(win&&!win.isDestroyed())win.destroy();
    app.exit(report.passed?0:1);
  });
}
