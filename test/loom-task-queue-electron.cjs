'use strict';
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const output = path.resolve(__dirname, '../.local/message-task-queue');
app.setPath('userData', path.join(output, 'profile'));
let win;
app.whenReady().then(async () => {
  await fs.mkdir(output, {recursive:true});
  const source = await fs.readFile(path.resolve(__dirname, '../renderer/app.js'), 'utf8');
  const render = source.slice(source.indexOf('function renderMessageQueue()'), source.indexOf('\nfunction renderActivity()'));
  const css = pathToFileURL(path.resolve(__dirname, '../renderer/styles.css')).href;
  await fs.writeFile(path.join(output, 'fixture.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="${css}"><style>body{display:block;padding:24px;background:var(--background)}.fixture{width:304px;background:var(--surface);padding:16px}#message-task-queue{max-height:none}</style><div class="fixture"><h3>消息任务队列</h3><div id="message-task-queue"></div></div></html>`);
  win = new BrowserWindow({show:false,width:400,height:920,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true}});
  await win.loadFile(path.join(output, 'fixture.html'));
  await win.webContents.executeJavaScript(`
    const $=id=>document.getElementById(id);
    const str=(value,fallback='')=>typeof value==='string'&&value?value:fallback;
    const formattedTime=value=>value?new Date(value).toLocaleTimeString('zh-CN',{hour12:false}):'';
    const element=(tag,className,text)=>{const node=document.createElement(tag);node.className=className;node.textContent=text;return node;};
    let state={connection:{status:'connected'},runtime:{activeStream:{active:true,id:'stream-1'}},messageQueue:{queueKnown:true,pending:[
      {id:'1',text:'调研一下安卓平台的 phone use 能力',status:'responding',phase:'tool',tool:'browse_web',streamId:'stream-1',startedAt:'2026-09-08T00:00:00Z'},
      {id:'2',text:'进展怎么样了？',status:'accepted',startedAt:'2026-09-08T00:01:00Z'}
    ],queued:[{text:'整理成对比表格',attachments:1},{text:'再看看开源方案'}]}};
    ${render}
    renderMessageQueue();
  `);
  let text = await win.webContents.executeJavaScript("document.getElementById('message-task-queue').innerText");
  assert.match(text, /正在调用工具/);
  assert.match(text, /browse_web/);
  assert.match(text, /已接收 1/);
  assert.match(text, /本地待发 · 2 条/);
  assert.ok(text.indexOf('整理成对比表格') < text.indexOf('再看看开源方案'));
  await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await fs.writeFile(path.join(output, 'queue-preview.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("state.messageQueue.pending[0].text='<img src=x onerror=alert(1)>';renderMessageQueue()");
  assert.equal(await win.webContents.executeJavaScript("document.querySelectorAll('#message-task-queue img').length"), 0);
  await win.webContents.executeJavaScript("state.connection.status='disconnected';renderMessageQueue()");
  text = await win.webContents.executeJavaScript("document.getElementById('message-task-queue').innerText");
  assert.doesNotMatch(text, /browse_web|已接收 1/);
  console.log('PASS: message phases, accepted messages, FIFO, safe text, disconnected state.');
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{win?.destroy();app.exit(process.exitCode || 0);});
