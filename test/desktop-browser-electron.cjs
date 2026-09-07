'use strict';

const {app, BrowserWindow, WebContentsView, session} = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {DesktopBrowser, BROWSER_PARTITION} = require('../src/desktop-browser.cjs');

if (!process.env.BEING_BROWSER_TEST_PROFILE) throw new Error('An isolated browser test profile is required.');
app.setPath('userData', path.resolve(process.env.BEING_BROWSER_TEST_PROFILE));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
app.on('window-all-closed', () => {});
const checks = [];
const report = {passed:false,checks,externalRequests:0};
let window, browser, server;
const heldResponses = new Set();
const timeout = setTimeout(() => { console.error('Browser fixture timed out.'); app.exit(1); }, 60000);

function check(label, run) { run(); checks.push(label); }
function until(predicate, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 12000;
    const next = () => {
      try {
        if (predicate()) return resolve();
        if (Date.now() > deadline) return reject(new Error(`Fixture state not reached: ${label}`));
        setTimeout(next, 30);
      } catch (error) { reject(error); }
    };
    next();
  });
}
function ready(id) {
  return until(() => {
    const tab = browser.tabs.get(id);
    return tab && !tab.view.webContents.isLoading() && !tab.isLoading && tab.documentToken;
  }, 'browser document ready');
}

app.whenReady().then(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/redirect') { response.writeHead(302, {Location:'being://app/index.html'}); response.end(); return; }
    if (url.pathname === '/slow') { heldResponses.add(response); response.once('close', () => heldResponses.delete(response)); return; }
    if (url.pathname === '/download') { response.writeHead(200, {'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="fixture.txt"'}); response.end('Synthetic fixture download.'); return; }
    response.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store'});
    response.end(`<!doctype html><html><head><title>Browser fixture ${url.pathname}</title><style>body{background:#fafafa;color:#111;font:16px sans-serif;padding:20px}button,input{margin:8px;padding:8px}</style></head><body>
      <h1>Local browser fixture</h1><p id="bridge"></p><p id="clicked">Not clicked</p>
      <form id="form"><input id="note" aria-label="Note"><textarea id="draft" aria-label="Draft"></textarea><input id="password" type="password" value="private-fixture-password"><input id="upload" type="file"><button id="submit">Submit</button></form>
      <button id="click" onclick="document.querySelector('#clicked').textContent='Clicked once'">Click fixture</button>
      <button class="duplicate">Duplicate A</button><button class="duplicate">Duplicate B</button><button id="hidden" style="display:none">Hidden</button><div style="opacity:0"><input id="transparent"></div>
      <a id="next" href="/b">Next fixture</a><button id="popup" onclick="window.open('/popup','_blank')">Popup</button><button id="blocked-popup" onclick="window.open('about:blank','_blank')">Blocked popup</button><a id="download" href="/download" download>Download fixture</a><p id="unrelated">Unrelated animation</p>
      <script>document.querySelector('#bridge').textContent=JSON.stringify({requireType:typeof require,processType:typeof process,bridgeType:typeof beingDesktop});window.events={input:0,change:0,submit:0};document.querySelector('#note').addEventListener('input',()=>events.input++);document.querySelector('#note').addEventListener('change',()=>events.change++);document.querySelector('#form').addEventListener('submit',event=>{event.preventDefault();events.submit++});</script>
      </body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  window = new BrowserWindow({show:false,width:1000,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true}});
  function FixtureView(options) { return new WebContentsView({...options,webPreferences:{...options.webPreferences,offscreen:true,backgroundThrottling:false}}); }
  browser = new DesktopBrowser({WebContentsView:FixtureView,session,getWindow:() => window});
  browser.setViewport({visible:true,bounds:{x:100,y:100,width:800,height:500}});
  const first = browser.newTab({url:`${origin}/a`}).activeTabId;
  await ready(first);
  const wc = browser.tabs.get(first).view.webContents;
  check('real WebContentsView loads localhost without exposing native bridge or Node', () => assert.equal(wc.session, session.fromPartition(BROWSER_PARTITION)));
  const page = await browser.readPage(first);
  check('page inspection sees rendered text but never password values', () => {
    assert.match(page.text, /"requireType":"undefined","processType":"undefined","bridgeType":"undefined"/);
    assert.equal(JSON.stringify(page).includes('private-fixture-password'), false);
    assert.equal(page.elements.some(element => element.selector === '#password' || element.selector === '#upload'), false);
    assert.ok(page.elements.some(element => element.selector === '#note'));
  });
  await browser.fill({id:first,selector:'#note',text:'Synthetic fixture input',expectedRevision:page.revision});
  const field = await wc.executeJavaScript('({value:document.querySelector("#note").value,events:window.events})');
  check('fill dispatches input and change without submitting a form', () => assert.deepEqual(field, {value:'Synthetic fixture input',events:{input:1,change:1,submit:0}}));
  for (const selector of ['#password','#upload','#hidden','#transparent','.duplicate']) {
    await assert.rejects(browser.fill({id:first,selector,text:'blocked'}));
    checks.push(`fill rejects restricted or ambiguous target ${selector}`);
  }
  await browser.click({id:first,selector:'#click',expectedRevision:page.revision});
  check('structured click acts on the selected visible element', () => {});
  assert.match((await browser.readPage(first)).text, /Clicked once/);
  const prepare = (selector,kind) => browser.prepareAction({id:first,selector,kind,expectedRevision:page.revision});
  let target = await prepare('#click','click');
  await wc.executeJavaScript('document.querySelector("#click").outerHTML=document.querySelector("#click").outerHTML');
  await assert.rejects(browser.click({id:first,selector:'#click',expectedRevision:page.revision,targetToken:target.targetToken}), /请求已过期/);
  checks.push('replacing a same-selector button expires its pending approval');
  target = await prepare('#note','fill');
  await wc.executeJavaScript('document.querySelector("#note").value="New manual fixture value"');
  await assert.rejects(browser.fill({id:first,selector:'#note',text:'Should not replace manual value',expectedRevision:page.revision,targetToken:target.targetToken}), /请求已过期/);
  assert.equal(await wc.executeJavaScript('document.querySelector("#note").value'), 'New manual fixture value');
  checks.push('changing a field value expires its pending fill without overwriting it');
  target = await prepare('#submit','click');
  await wc.executeJavaScript('document.querySelector("#draft").value="Changed related form field"');
  await assert.rejects(browser.click({id:first,selector:'#submit',expectedRevision:page.revision,targetToken:target.targetToken}), /请求已过期/);
  assert.equal(await wc.executeJavaScript('events.submit'), 0);
  checks.push('related form value changes invalidate a prepared submit target');
  target = await prepare('#click','click');
  await wc.executeJavaScript('document.querySelector("#unrelated").textContent="A different animation frame"');
  await browser.click({id:first,selector:'#click',expectedRevision:page.revision,targetToken:target.targetToken});
  checks.push('unrelated page animation preserves the reviewed target approval');
  await assert.rejects(browser.click({id:first,selector:'#click',expectedRevision:page.revision,targetToken:target.targetToken}), /请求已过期/);
  checks.push('a target token cannot authorize the same action twice');
  target = await prepare('#click','click');
  await wc.executeJavaScript('document.querySelector("#click").textContent="Changed button purpose"');
  await assert.rejects(browser.click({id:first,selector:'#click',expectedRevision:page.revision,targetToken:target.targetToken}), /请求已过期/);
  checks.push('changed button text expires the reviewed target');
  target = await prepare('#next','click');
  await wc.executeJavaScript('document.querySelector("#next").href="/changed-destination"');
  await assert.rejects(browser.click({id:first,selector:'#next',expectedRevision:page.revision,targetToken:target.targetToken}), /请求已过期/);
  await wc.executeJavaScript('document.querySelector("#next").href="/b"');
  checks.push('changed link destination cannot reuse the reviewed click');
  target = await prepare('#click','click');
  for (let index = 0; index < 32; index++) await prepare('#click','click');
  await assert.rejects(browser.click({id:first,selector:'#click',expectedRevision:page.revision,targetToken:target.targetToken}), /请求已过期/);
  checks.push('per-document target tokens remain bounded and evicted tokens expire');
  try {
    const shot = await browser.screenshot(first, page.revision);
    check('native screenshot returns a bounded PNG without showing the test window', () => {
      assert.equal(shot.mimeType, 'image/png');
      assert.ok(shot.width > 0 && shot.width <= 1600 && shot.height > 0 && shot.height <= 1600);
      assert.equal(Buffer.from(shot.data, 'base64').subarray(1, 4).toString(), 'PNG');
      assert.equal(window.isVisible(), false);
    });
    report.nativeScreenshot = {available:true};
  } catch (error) {
    let reason = '';
    try { await wc.capturePage(); } catch (captureError) { reason = captureError.message; }
    assert.equal(reason, 'UnknownVizError');
    check('never-shown native view capture failure is surfaced without leaking Chromium errors', () => assert.match(error.message, /无法截取当前网页/));
    report.nativeScreenshot = {available:false,reason:'UnknownVizError in a never-shown hidden WebContentsView; visible-window capture needs separate validation.'};
  }
  await session.fromPartition('fixture-loom-isolation').cookies.set({url:origin,name:'loom-private-fixture',value:'private-fixture-cookie'});
  check('browser session cannot read the separate Loom session cookie', () => {});
  assert.equal((await wc.session.cookies.get({url:origin,name:'loom-private-fixture'})).length, 0);
  await browser.click({id:first,selector:'#next',expectedRevision:page.revision});
  await until(() => browser.snapshot().tabs[0].url.endsWith('/b'), 'link navigation');
  await ready(first);
  check('link click navigates and advances the document revision', () => assert.ok(browser.snapshot().tabs[0].revision > page.revision));
  await assert.rejects(browser.readPage(first, page.revision), /页面已变化/);
  await assert.rejects(browser.click({id:first,selector:'#click',expectedRevision:page.revision}), /页面已变化/);
  checks.push('approval captured for an older page cannot act on its replacement');
  browser.goBack(first);
  await until(() => browser.snapshot().tabs[0].url.endsWith('/a'), 'back navigation');
  await ready(first);
  check('native browser history supports back and forward', () => assert.equal(browser.snapshot().tabs[0].canGoForward, true));
  browser.goForward(first);
  await until(() => browser.snapshot().tabs[0].url.endsWith('/b'), 'forward navigation');
  await ready(first);
  await browser.click({id:first,selector:'#popup'});
  await until(() => browser.snapshot().tabs.length === 2, 'internal popup tab');
  const second = browser.snapshot().activeTabId;
  await ready(second);
  check('window.open becomes an internal tab with no additional BrowserWindow', () => assert.equal(BrowserWindow.getAllWindows().length, 1));
  browser.closeTab(second);
  check('closing a tab destroys its contents and restores the preceding tab', () => assert.equal(browser.snapshot().activeTabId, first));
  await browser.click({id:first,selector:'#blocked-popup'});
  check('blocked popups show a notice while keeping the committed page attached', () => {
    assert.equal(browser.snapshot().tabs[0].error, '');
    assert.match(browser.snapshot().tabs[0].notice, /弹出窗口/);
    assert.equal(window.contentView.children.includes(browser.tabs.get(first).view), true);
  });
  await wc.executeJavaScript('document.querySelector("#download").click()', true);
  await until(() => /下载/.test(browser.snapshot().tabs[0].notice), 'download notice');
  check('blocked downloads show a notice while keeping the committed page attached', () => {
    assert.equal(browser.snapshot().tabs[0].error, '');
    assert.equal(window.contentView.children.includes(browser.tabs.get(first).view), true);
  });
  browser.navigate({id:first,url:`${origin}/redirect`});
  await until(() => !!browser.snapshot().tabs[0].notice && !browser.snapshot().tabs[0].isLoading, 'blocked redirect');
  await ready(first);
  check('blocked redirects preserve the committed page and its inspection binding', () => {
    assert.equal(wc.getURL().startsWith('being:'), false);
    assert.equal(browser.snapshot().tabs[0].error, '');
    assert.equal(window.contentView.children.includes(browser.tabs.get(first).view), true);
  });
  assert.match((await browser.readPage(first)).text, /Local browser fixture/);
  browser.navigate({id:first,url:`${origin}/slow`});
  await until(() => heldResponses.size > 0, 'held local response');
  browser.stop(first);
  check('stop cancels an in-progress local page load', () => assert.equal(browser.snapshot().tabs[0].isLoading, false));
  browser.setViewport({visible:false});
  check('hiding the browser detaches its native view', () => assert.equal(window.contentView.children.includes(browser.tabs.get(first).view), false));
  report.passed = true;
}).catch(error => {
  report.error = error.stack;
  if (browser) report.browserState = browser.snapshot();
  const tab = browser?.tabs.get(browser.activeTabId);
  if (tab && !tab.view.webContents.isDestroyed()) report.history = tab.view.webContents.navigationHistory.getAllEntries().map(({url,title}) => ({url,title}));
}).finally(async () => {
  clearTimeout(timeout);
  if (browser) browser.destroy();
  if (window && !window.isDestroyed()) window.destroy();
  for (const response of heldResponses) response.destroy();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await fs.writeFile(path.join(app.getPath('userData'), 'browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({passed:report.passed,checks:checks.length,report:path.join(app.getPath('userData'), 'browser-report.json'),error:report.error || ''}));
  app.exit(report.passed ? 0 : 1);
});
