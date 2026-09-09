'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {randomUUID} = require('node:crypto');

const DEADLINE_MS = 15000;
const STORAGE_KEY = 'being-desktop-scenario-marker';

async function deadline(promise, label, milliseconds = DEADLINE_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Scenario timed out: ${label}`)), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

function eventPromise(emitter, name, predicate = () => true, label = name) {
  let handler;
  const promise = new Promise(resolve => {
    handler = (...args) => {
      if (predicate(...args)) resolve(args);
    };
    emitter.on(name, handler);
  });
  const waiting = deadline(promise, label).finally(() => emitter.removeListener(name, handler));
  // A preceding assertion may fail before its paired event is awaited.
  waiting.catch(() => {});
  return waiting;
}

function json(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  response.end(JSON.stringify(body));
}

function fixtureHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Local desktop scenario fixture</title></head>
<body><div id="app"><h1>Local scenario fixture</h1><div id="messages"><div class="message being"><div class="content"><p>No real Being connection is used.</p><table><tr><th>Feature</th><td>Reading</td></tr></table><pre><code>const example = 1;</code></pre></div></div></div><form id="input-row"><textarea id="input"></textarea><button id="send-btn" type="submit">Send</button></form></div><script>
'use strict';
window.fixtureDraftEvents = {input: 0, click: 0, submit: 0};
document.getElementById('input').addEventListener('input', () => window.fixtureDraftEvents.input++);
document.getElementById('send-btn').addEventListener('click', () => window.fixtureDraftEvents.click++);
document.getElementById('input-row').addEventListener('submit', event => { event.preventDefault(); window.fixtureDraftEvents.submit++; });
const parameters = new URLSearchParams(location.search);
const before = localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
if (parameters.has('write')) localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, parameters.get('write'));
fetch('/_fixture/report?visit=' + encodeURIComponent(parameters.get('visit')), {
  method: 'POST', headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({before, requireType: typeof window.require, processType: typeof window.process,
    bridgeType: typeof window.beingDesktop, origin: location.origin})
});
</script></body></html>`;
}

async function listen(server) {
  await deadline(new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  }), 'local fixture listen');
  return `http://127.0.0.1:${server.address().port}`;
}

async function createFixture() {
  const events = new EventEmitter();
  const reports = new Map();
  const controls = new Map();
  const held = new Set();
  const timeoutClosed = new Set();
  const allResponses = new Set();
  const requestCounts = new Map();
  const channelRequests = [];
  const heartReadRequests = [];
  const townAgentRequests = [];
  let townResultMode='full';
  let externalRequests = 0;
  let redirectResponse = null;
  let externalOrigin;

  function control(apiPath, token) {
    const key = `${apiPath}|${token}`;
    if (!controls.has(key)) controls.set(key, {key, model: `fixture-${apiPath.slice(1)}`, configMode: 'ok', streamMode: 'ok', sideBySide: true});
    return controls.get(key);
  }

  const external = http.createServer((request, response) => {
    externalRequests++;
    response.end('Local browser navigation fixture.');
    events.emit('external-request', {url:request.url,referer:request.headers.referer || ''});
  });
  const server = http.createServer((request, response) => {
    allResponses.add(response);
    response.once('close', () => allResponses.delete(response));
    const url = new URL(request.url, 'http://127.0.0.1');
    requestCounts.set(url.pathname, (requestCounts.get(url.pathname) || 0) + 1);

    if (url.pathname === '/_fixture/report' && request.method === 'POST') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => {
        body += chunk;
        if (body.length > 8192) request.destroy();
      });
      request.on('end', () => {
        try {
          const report = JSON.parse(body);
          const visit = url.searchParams.get('visit');
          reports.set(visit, report);
          json(response, 200, {accepted: true});
          events.emit('report', visit, report);
        } catch { json(response, 400, {error: 'Invalid fixture report'}); }
      });
      return;
    }
    if (url.pathname === '/loom') {
      response.writeHead(302, {Location: `/loom/${url.search}`, 'Cache-Control': 'no-store'});
      response.end();
      return;
    }
    if (url.pathname === '/loom/') {
      response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
      response.end(fixtureHtml());
      return;
    }
    if (url.pathname === '/redirect-away/') {
      redirectResponse = response;
      events.emit('redirect-ready');
      return;
    }
    if (/^\/(being-a|being-b)\/api\/chat\/stream$/.test(url.pathname) && request.method === 'POST') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => {
        body += chunk;
        if (body.length > 65536) request.destroy();
      });
      request.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const sync = payload.message?.match(/^\[Being Desktop Town sync:([a-f0-9-]{36})\]/);
          if (sync && payload.message.includes('读取路线：')) {
            const target = new URL(payload.message.match(/https:\/\/beings\.town\/api\/[A-Za-z0-9_/?=&-]+/)[0]);
            const route = target.pathname;
            townAgentRequests.push({path:url.pathname, route, method:'GET', payload});
            const data = route === '/api/bonfire/hear' ? {ok:true,being:'loom',global_latest_seq:7,messages:[{seq:7,being:'fixture-peer',message:'Native Being GET message',at:'2026-09-07'}]}
              : route === '/api/fireside/list' ? {owned:[{id:1,name:'Being GET room'}],joined:[]}
                : route === '/api/fireside/members' ? [{being_id:'loom',display_name:'Fixture Being'}]
                  : {being:'loom',latest_seq:3,messages:[{seq:3,being:'loom',message:'Native Being private GET',at:'2026-09-07'}]};
            const reply=JSON.stringify({protocol:'being-town-agent-read/1',requestId:sync[1],route,beingId:'loom',httpStatus:200,data});
            response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});
            response.write('event: tool_use\ndata: '+JSON.stringify({name:'http',input:JSON.stringify({method:'GET',url:target.href})})+'\n\n');
            response.write('event: tool_result\ndata: '+JSON.stringify({name:'http',is_error:false,...(townResultMode==='full'?{content:JSON.stringify({status:200,body:JSON.stringify(data),headers:{}})}:{summary:'HTTP 200 result summary truncated by Loom'})})+'\n\n');
            response.end('event: content_block_delta\ndata: '+JSON.stringify({delta:{text:reply}})+'\n\nevent: message_stop\ndata: {}\n\n');
            return;
          }
          channelRequests.push({path: url.pathname, token: url.searchParams.get('token'), payload,
            cookie: request.headers.cookie, referer: request.headers.referer});
          assert.equal(typeof payload.message, 'string');
          const channel = /"channel"\s*:\s*"feishu"/.test(payload.message) ? 'feishu' : 'wechat';
          const route = payload.message.match(/任务路线：([^。]+)。/)?.[1];
          const beingId = payload.message.match(/当前 Being：([^；]+)；/)?.[1];
          assert(sync && [`/desktop/channel/${channel}/begin`, `/desktop/channel/${channel}/status`].includes(route) && beingId);
          const reply = JSON.stringify({protocol:'being-desktop-channel-result/1', requestId:sync[1], route, beingId, channel, status:'connected', detail:'Local channel fixture is connected.'});
          response.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store'});
          response.write('event: content_block_delta\ndata: ' + JSON.stringify({delta: {text: reply.slice(0, 25)}}) + '\n\n');
          response.end('event: content_block_delta\ndata: ' + JSON.stringify({delta: {text: reply.slice(25)}}) +
            '\n\nevent: message_stop\ndata: ' + JSON.stringify({session_id: 'fixture-background-' + channel}) + '\n\n');
        } catch { json(response, 400, {error: 'Invalid channel fixture message'}); }
      });
      return;
    }
    const heartRead = url.pathname.match(/^\/(being-a|being-b)\/api\/desktop-town\/v1\/(bonfire\/hear|fireside\/list|fireside\/members|fireside\/hear)$/);
    if (heartRead && request.method === 'GET') {
      heartReadRequests.push({path: url.pathname, query: url.search, method: request.method, hasBearer: Boolean(request.headers.authorization?.startsWith('Bearer '))});
      if (!request.headers.authorization?.startsWith('Bearer ')) { json(response, 401, {error: {code: 'AUTH_REQUIRED'}}); return; }
      const route = heartRead[2];
      const data = route === 'bonfire/hear' ? {ok: true, being: 'loom', global_latest_seq: 1, messages: [{seq: 1, being: 'fixture-peer', message: 'Read through Heart', at: '2026-09-07'}]}
        : route === 'fireside/list' ? {owned: [{id: 1, name: 'Local Heart room'}], joined: []}
          : route === 'fireside/members' ? [{being_id: 'loom', display_name: 'Fixture Being'}]
            : {being: 'loom', latest_seq: 1, messages: [{seq: 1, being: 'loom', message: 'Private Heart fixture message', at: '2026-09-07'}]};
      json(response, 200, {protocol: 'being-town-readonly/1', beingId: 'loom', data});
      return;
    }
    const match = url.pathname.match(/^\/(being-a|being-b)\/api\/(status|llm\/config|stream\/active)$/);
    if (!match) { json(response, 404, {error: 'Unknown fixture path'}); return; }
    const activeControl = control(`/${match[1]}`, url.searchParams.get('token') || '');
    const route = match[2];
    if (route === 'status') { json(response, 200, {status: 'running', name: match[1]}); return; }
    if (route === 'stream/active') {
      if (activeControl.streamMode === '500') json(response, 500, {error: 'Fixture stream failure'});
      else if (activeControl.streamMode === 'malformed') json(response, 200, {});
      else json(response, 200, {finished: true, events: []});
      return;
    }
    if (['500', '401'].includes(activeControl.configMode)) {
      json(response, Number(activeControl.configMode), {error: 'Fixture config failure'});
      return;
    }
    if (activeControl.configMode === 'timeout') {
      const id = randomUUID();
      response.once('close', () => {
        if (!response.writableEnded) { timeoutClosed.add(id); events.emit('timeout-closed', id); }
      });
      events.emit('timeout-started', id);
      return;
    }
    const data = {model: activeControl.model, provider: 'fixture', base_url: 'https://model.example.invalid/v1', sbs_enabled: activeControl.sideBySide};
    if (activeControl.configMode === 'hold') {
      const entry = {key: activeControl.key, response, data};
      held.add(entry);
      events.emit('config-held', entry);
      return;
    }
    json(response, 200, data);
  });

  try {
    externalOrigin = await listen(external);
    const origin = await listen(server);
    return {
      origin, externalOrigin, events, reports, control, timeoutClosed, channelRequests, heartReadRequests, townAgentRequests,
      setTownResultMode:mode=>{townResultMode=mode;},
      externalRequests: () => externalRequests,
      url(apiPath, token, options = {}) {
        const url = new URL(options.noSlash ? '/loom' : '/loom/', origin);
        url.searchParams.set('api', origin + apiPath);
        url.searchParams.set('token', token);
        url.searchParams.set('visit', options.visit || randomUUID());
        if (options.secret !== undefined) url.searchParams.set('relay_secret', options.secret);
        if (options.write !== undefined) url.searchParams.set('write', options.write);
        return url.href;
      },
      release(entry, replacement = {}) {
        assert(held.has(entry), 'Only a fixture-held response may be released');
        held.delete(entry);
        json(entry.response, 200, {...entry.data, ...replacement});
      },
      redirectReady: () => Boolean(redirectResponse),
      releaseRedirect() {
        assert(redirectResponse, 'A fixture redirect must be pending');
        redirectResponse.writeHead(302, {Location: externalOrigin + '/redirect-target', 'Cache-Control': 'no-store'});
        redirectResponse.end();
        redirectResponse = null;
      },
      counts: () => Object.fromEntries(requestCounts),
      async close() {
        for (const response of allResponses) response.destroy();
        for (const instance of [server, external]) {
          instance.closeAllConnections();
          if (instance.listening) await deadline(new Promise(resolve => instance.close(resolve)), 'fixture close', 4000);
        }
        events.removeAllListeners();
      },
    };
  } catch (error) {
    for (const instance of [server, external]) {
      instance.closeAllConnections();
      if (instance.listening) instance.close();
    }
    throw error;
  }
}

async function runDesktopScenarios({app, win, getView, getState, refresh}) {
  assert.equal(process.env.BEING_SCENARIOS, '1', 'Integration scenarios require the explicit BEING_SCENARIOS=1 flag');
  assert.match(path.basename(app.getPath('userData')), /^being-desktop-scenarios-[a-f0-9-]{36}$/i,
    'Scenarios require a dedicated being-desktop-scenarios-<UUID> profile');
  assert.equal(getState().connection.configured, false, 'Refusing to replace an existing Being connection');
  assert.equal(win.webContents.getURL(), 'being://app/index.html', 'Scenarios require the trusted local shell');
  const checks = [];
  let activeCheck = 'initial fixture setup';
  const fixture = await createFixture();
  const townRequests = [];
  const guardedSession = require('electron').session.defaultSession;
  guardedSession.webRequest.onBeforeRequest({urls:['https://beings.town/*']},(details,callback)=>{
    townRequests.push({url:details.url,method:details.method});
    callback({cancel:true});
  });
  const tokenA = 'fixture-account-a';
  const tokenB = 'fixture-account-b';
  const startedAt = new Date().toISOString();

  async function shellCall(method, ...args) {
    assert(['connect', 'disconnect', 'reconnect','changeChatSession','getState', 'getDesktopTools','desktopAction','getTownCatalog', 'openTownPage', 'prepareTownFeature', 'prepareFiresideDraft','setTypography','getTownAppState','getFiresides','getFiresideMessages','getFiresideMembers','requestTownRead','refreshTownMessages','beginChannelConnection','updateFeishuCredentials','checkChannelStatus','getFeatureTasks','getFeatureTask','discussFeatureTask'].includes(method));
    return deadline(win.webContents.executeJavaScript(`window.beingDesktop.${method}(${args.map(value => JSON.stringify(value)).join(',')})`), `shell ${method}`);
  }

  async function loaded(contents, expectedUrl) {
    const targetView = getView();
    const targetUrl = new URL(expectedUrl);
    const expectedDisplayUrl = targetUrl.origin + targetUrl.pathname;
    assert.equal(targetView?.webContents, contents, 'The fixture must wait on its own Loom view');
    await deadline((async () => {
      await contents.executeJavaScript(`new Promise(resolve => {
        if (document.readyState === 'complete') resolve();
        else window.addEventListener('load', () => resolve(), {once: true});
      })`);
      // Theme application completes asynchronously after did-finish-load. Subscribe
      // before requesting a snapshot so neither an early nor a late state is lost.
      await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        const finish = error => { clearTimeout(timer); unsubscribe(); error ? reject(error) : resolve(); };
        const timer = setTimeout(() => finish(new Error('Fixture connection did not become ready')), ${DEADLINE_MS});
        const check = state => {
          const connection = state.connection;
          if (!connection?.configured || connection.displayUrl !== ${JSON.stringify(expectedDisplayUrl)}) {
            finish(new Error('Fixture connection changed while awaiting readiness'));
          } else if (connection.status === 'error') {
            finish(new Error('Fixture page reported a connection error'));
          } else if (connection.status === 'connected') {
            finish();
          }
        };
        unsubscribe = window.beingDesktop.onState(check);
        window.beingDesktop.getState().then(check, finish);
      })`);
      assert.equal(contents.isDestroyed(), false, 'The ready fixture view must still exist');
      const actualUrl = new URL(contents.getURL());
      assert.equal(actualUrl.origin, targetUrl.origin);
      assert.equal(actualUrl.pathname.replace(/\/+$/, ''), targetUrl.pathname.replace(/\/+$/, ''));
      assert.equal(actualUrl.searchParams.get('visit'), targetUrl.searchParams.get('visit'), 'The loaded document must belong to this fixture visit');
      assert.equal(await contents.executeJavaScript('document.readyState'), 'complete', 'The fixture document must finish loading');
      assert.equal(getView(), targetView, 'The active view must not change while awaiting readiness');
      assert.equal(getState().connection.displayUrl, expectedDisplayUrl);
      assert.equal(getState().connection.status, 'connected');
    })(), 'fixture page load');
  }

  async function visit(apiPath, token, options = {}) {
    const visitId = randomUUID();
    const reportEvent = eventPromise(fixture.events, 'report', id => id === visitId, 'remote fixture safety report');
    const url = fixture.url(apiPath, token, {...options, visit: visitId});
    await shellCall('connect', url);
    const view = getView();
    assert(view && !view.webContents.isDestroyed(), 'Connecting must create a live Loom view');
    await loaded(view.webContents, url);
    const [, report] = await reportEvent;
    assert.equal(report.origin, fixture.origin);
    assert.equal(report.requireType, 'undefined', 'Remote Loom must not expose require');
    assert.equal(report.processType, 'undefined', 'Remote Loom must not expose process');
    assert.equal(report.bridgeType, 'undefined', 'Remote Loom must not expose the desktop bridge');
    assert.equal(view.webContents.session.isPersistent(), true, 'Loom storage must use a persistent session');
    if (!options.skipRefresh) await deadline(refresh(), 'connected fixture refresh');
    return {report, contents: view.webContents, url};
  }

  async function check(name, fn) {
    activeCheck = name;
    await fn();
    checks.push({name, passed: true});
  }

  function unknownConfig() {
    const runtime = getState().runtime;
    assert.equal(runtime.status, 'connected', 'The healthy status API must stay distinct from config failure');
    assert.equal(runtime.configStatus, 'error');
    assert.equal(runtime.model, '');
    assert.equal(runtime.provider, '');
    assert.equal(runtime.baseUrl, '');
    assert.equal(runtime.sideBySide.configured, null);
    assert.equal(runtime.sideBySide.active, null);
    assert(runtime.configError, 'Configuration failure must be visible');
  }

  try {
    await deadline(refresh(), 'initial empty-profile refresh');
    await check('Town catalog remains available without a Being connection and rejects unsafe actions', async () => {
      const catalog = await shellCall('getTownCatalog');
      assert.equal(catalog.features.length, 9);
      assert.equal(catalog.features.filter(item => item.mode === 'being').length, 1);
      assert.deepEqual(catalog.features.filter(item => item.mode === 'app').map(item=>item.id).sort(), ['beings','bonfire','channel','fireside','grove','portal','scroll']);
      assert.deepEqual(catalog.features.filter(item => item.mode === 'web').map(item=>item.id), ['ember']);
      assert(catalog.features.some(item => item.id === 'fireside'));
      assert.equal(catalog.features.find(item => item.id === 'workspace').label, '云端工作空间');
      await assert.rejects(shellCall('prepareTownFeature', 'scroll'));
      for (const id of ['__proto__', 'constructor', 'https://example.test/', 'home?token=secret']) {
        await assert.rejects(shellCall('openTownPage', id));
        await assert.rejects(shellCall('prepareTownFeature', id));
      }
      assert.equal(getView() == null, true, 'An unconfigured profile must not create a native Loom view');
    });
    await check('persistent storage: A -> B -> A; different API backends do not share storage', async () => {
      const a = await visit('/being-a', tokenA, {write: 'only-api-a'});
      assert.equal(a.report.before, null, 'New A session must be empty');
      assert.equal(getState().runtime.model, 'fixture-being-a');
      const b = await visit('/being-b', tokenA, {write: 'only-api-b'});
      assert.equal(b.report.before, null, 'B must not see A storage on the same Loom page origin');
      assert.equal(getState().runtime.model, 'fixture-being-b');
      const again = await visit('/being-a', tokenA);
      assert.equal(again.report.before, 'only-api-a', 'Returning to A must retain its own storage');
    });

    await check('switching sessions retains the original busy WebContents and restores it without reloading', async () => {
      const original=getView(), url=original.webContents.getURL();
      const id=getState().chatSessions.activeId;
      await original.webContents.executeJavaScript('window.isStreaming=true;window.sessionReuseMarker="retained";true');
      await shellCall('changeChatSession',null);
      const next=getView();
      assert.notEqual(next,original);
      await loaded(next.webContents,url);
      assert.equal(original.webContents.isDestroyed(),false);
      await shellCall('changeChatSession',id);
      assert.equal(getView(),original);
      assert.equal(await original.webContents.executeJavaScript('window.sessionReuseMarker'),'retained');
      assert.equal(await original.webContents.executeJavaScript('window.isStreaming'),true);
      await original.webContents.executeJavaScript('window.isStreaming=false');
    });

    await check('reading preferences apply live, survive a new view, and reset without sending input', async () => {
      const inspect = contents => contents.executeJavaScript(`(() => {
        const sizes = {};
        for (const selector of ['.message .content', '.message .content table', '#input', '.message .content code']) sizes[selector] = getComputedStyle(document.querySelector(selector)).fontSize;
        return {sizes, events: {...window.fixtureDraftEvents}};
      })()`);
      const verify = async (chatFontSize, codeFontSize) => {
        const actual = await inspect(getView().webContents);
        assert.deepEqual(actual.sizes, {'.message .content':chatFontSize+'px', '.message .content table':chatFontSize+'px', '#input':chatFontSize+'px', '.message .content code':codeFontSize+'px'});
        assert.deepEqual(actual.events, {input:0, click:0, submit:0});
        assert.deepEqual(getState().settings.typography, {chatFontSize, codeFontSize});
        const stored = JSON.parse(await require('node:fs/promises').readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
        assert.deepEqual(stored.typography, {chatFontSize, codeFontSize});
      };
      await shellCall('setTypography', {chatFontSize:16,codeFontSize:14});
      await verify(16,14);
      await shellCall('setTypography', {chatFontSize:15,codeFontSize:13});
      await verify(15,13);
      await visit('/being-a', tokenA);
      await verify(15,13);
      await assert.rejects(shellCall('setTypography', {chatFontSize:200,codeFontSize:13}));
      await verify(15,13);
      await shellCall('setTypography', {chatFontSize:14,codeFontSize:12});
      await verify(14,12);
    });

    await check('Town action prepares a draft through trusted IPC without sending or overwriting text', async () => {
      const contents = getView().webContents;
      const prepared = await shellCall('prepareTownFeature', 'fireside');
      assert.equal(prepared.prepared, true);
      const first = await contents.executeJavaScript(`({value:document.getElementById('input').value,events:{...window.fixtureDraftEvents}})`);
      assert.match(first.value, /Fireside|围炉/);
      assert.deepEqual(first.events, {input: 1, click: 0, submit: 0});
      await assert.rejects(shellCall('prepareTownFeature', 'search'), /已有草稿/);
      const preserved = await contents.executeJavaScript(`({value:document.getElementById('input').value,events:{...window.fixtureDraftEvents}})`);
      assert.deepEqual(preserved, first);
      await contents.executeJavaScript(`document.getElementById('input').value = '  ';`);
      await assert.rejects(shellCall('prepareTownFeature', 'search'), /已有草稿/);
      assert.equal(await contents.executeJavaScript(`document.getElementById('input').value`), '  ');
      await contents.executeJavaScript(`document.getElementById('input').value = ''; document.getElementById('input').disabled = true;`);
      await assert.rejects(shellCall('prepareTownFeature', 'search'));
      assert.deepEqual(await contents.executeJavaScript('window.fixtureDraftEvents'), first.events);
      await contents.executeJavaScript(`document.getElementById('input').disabled = false;`);
      assert.equal(fixture.externalRequests(), 0);
    });

    await check('Town cache reads stay silent and explicit read-once drives validated native GET without editing the draft', async () => {
        const before = await getView().webContents.executeJavaScript('({...window.fixtureDraftEvents})');
        const countBefore = townRequests.length;
        const heartBefore = fixture.heartReadRequests.length;
        const chatBefore = fixture.channelRequests.length;
        const town = await shellCall('getTownAppState');
        assert.doesNotMatch(JSON.stringify(town),/fixture-account-a|fixture-account-b|fixture-relay-/);
        const agentBefore=fixture.townAgentRequests.length;
        await shellCall('getFiresides');
        await shellCall('getFiresideMembers','1');
        await assert.rejects(shellCall('getFiresideMessages',{firesideId:'1',limit:10}),/SBS_NOT_CONFIGURED|后台采集尚未设置/);
        await assert.rejects(shellCall('refreshTownMessages',{kind:'fireside',firesideId:'1'}),/SBS_NOT_CONFIGURED|后台采集尚未设置/);
        assert.equal(fixture.townAgentRequests.length,agentBefore,'Cache getters and result refresh must not send a Being message');
        assert.equal((await shellCall('requestTownRead',{kind:'fireside'})).rooms.owned[0].name,'Being GET room');
        const requested=await shellCall('requestTownRead',{kind:'fireside',firesideId:'1'});
        assert.equal(requested.snapshot.messages[0].content,'Native Being private GET');
        assert.equal(requested.members.members[0].being_id,'loom');
        assert.equal((await shellCall('getFiresides')).owned[0].name,'Being GET room');
        assert.equal((await shellCall('getFiresideMembers','1')).members[0].being_id,'loom');
        const reads=fixture.townAgentRequests.slice(agentBefore);
        assert.equal(reads.length,3);
        assert(reads.every(read=>read.method==='GET'&&!Object.hasOwn(read.payload,'session_id')));
        assert.equal(townRequests.length,countBefore,'Protected Town GET must execute inside Being');
        fixture.setTownResultMode('summary');
        try { await assert.rejects(shellCall('requestTownRead',{kind:'fireside',firesideId:'1'}),/RESULT_SOURCE_UNAVAILABLE|INCOMPLETE_RESULT|工具结果/); }
        finally { fixture.setTownResultMode('full'); }
        assert.equal(fixture.heartReadRequests.length, 0, 'Town reads must never request a Heart bridge');
        assert.equal(heartBefore, 0);
        assert.doesNotMatch(JSON.stringify(townRequests),/token=|fixture-account-a|fixture-account-b|fixture-relay-|\/api\/chat|\/api\/callback|\/speak/);
        assert.equal(fixture.channelRequests.length, chatBefore);
        assert.deepEqual(await getView().webContents.executeJavaScript('({...window.fixtureDraftEvents})'), before);
        assert.equal(getState().townApp.sync.bonfire.intervalMs,60000);
        assert(!Object.hasOwn(getState().townApp.sync.bonfire,'messages'));
        assert.equal(fixture.externalRequests(),0);
        assert.equal(getState().connection.status,'connected','Background Town reads must preserve the Loom connection');
    });

    await check('feature tasks own functional results while chat discussion remains an explicit editable draft', async () => {
      const before=await shellCall('getFeatureTasks');
      const tasks=before.tasks.filter(task=>task.feature==='fireside');
      assert(tasks.some(task=>task.status==='succeeded'&&task.summary.includes('围炉')),'A verified read must have its own successful task');
      assert(tasks.some(task=>task.status==='failed'),'A failed read must keep its own error state');
      assert(tasks.every(task=>task.mayDelayChat===true));
      assert(tasks.some(task=>/^[a-f0-9-]{36}$/.test(task.requestId)));
      assert.doesNotMatch(JSON.stringify(before),/fixture-account|fixture-relay|\[Being Desktop Town sync:|"prompt"/);
      const requests=fixture.townAgentRequests.length;
      await shellCall('getFeatureTasks');
      await shellCall('getFiresides');
      assert.equal((await shellCall('getFeatureTasks')).tasks.length,before.tasks.length,'Local display refresh must not create feature tasks');
      assert.equal(fixture.townAgentRequests.length,requests);
      const selected=tasks.find(task=>task.status==='succeeded');
      const contents=getView().webContents;
      await contents.executeJavaScript('document.getElementById("input").value="";');
      const events=await contents.executeJavaScript('({...window.fixtureDraftEvents})');
      assert.deepEqual(await shellCall('discussFeatureTask',selected.id),{prepared:true,taskId:selected.id});
      const draft=await contents.executeJavaScript('document.getElementById("input").value');
      assert.match(draft,/我选择将这个功能任务带到聊天里讨论/);
      assert.match(draft,/尚未确认与聊天执行队列隔离/);
      const after=await contents.executeJavaScript('({...window.fixtureDraftEvents})');
      assert.equal(after.input,events.input+1);
      assert.equal(after.click,events.click);
      assert.equal(after.submit,events.submit);
      await assert.rejects(shellCall('discussFeatureTask',selected.id),/已有草稿/);
      assert.equal(await contents.executeJavaScript('document.getElementById("input").value'),draft);
      await contents.executeJavaScript('document.getElementById("input").value="";');
      await win.webContents.executeJavaScript('document.getElementById("nav-tasks").click();');
      assert.equal(await win.webContents.executeJavaScript('document.body.dataset.page'),'tasks');
      assert.equal(await win.webContents.executeJavaScript('document.getElementById("page-tasks").hidden'),false);
      await win.webContents.executeJavaScript('document.querySelector("button[data-page=chat]").click();');
      assert.equal(fixture.townAgentRequests.length,requests,'Task inspection and discussion draft must never dispatch an LLM request');
    });

    await check('channel actions use background Being messages without Town authorization or changing the Loom draft', async () => {
      const contents = getView().webContents;
      const view = getView();
      const loomUrl = contents.getURL();
      const shellUrl = win.webContents.getURL();
      const shellPage = await win.webContents.executeJavaScript('document.body.dataset.page');
      const draft = 'Keep this unfinished Loom message while connecting channels.';
      await contents.executeJavaScript(`document.getElementById('input').value = ${JSON.stringify(draft)};`);
      const inspectDraft = () => contents.executeJavaScript(`({draft:document.getElementById('input').value,events:{...window.fixtureDraftEvents}})`);
      const before = await inspectDraft();
      const town = await shellCall('getTownAppState');
      const connectionRevision = town.identity.connectionRevision;
      const townBefore = townRequests.length;
      const postsBefore = fixture.channelRequests.length;
      const connected = await shellCall('beginChannelConnection', {channel: 'wechat', connectionRevision});
      assert.equal(connected.channel, 'wechat');
      assert.equal(connected.status, 'connected');
      const checked = await shellCall('checkChannelStatus', {channel: 'wechat', connectionRevision});
      assert.equal(checked.channels.length, 1);
      assert.equal(checked.channels[0].channel, 'wechat');
      assert.equal(checked.channels[0].status, 'connected');
      const feishu = await shellCall('beginChannelConnection', {channel: 'feishu', connectionRevision});
      assert.equal(feishu.channel, 'feishu');
      assert.equal(feishu.status, 'connected');
      const posts = fixture.channelRequests.slice(postsBefore);
      assert.equal(posts.length, 3, 'Each channel action must reach the selected Being through the chat stream API');
      for (const request of posts) {
        assert.equal(request.path, '/being-a/api/chat/stream');
        assert.equal(request.token, tokenA);
        assert.equal(request.cookie, undefined);
        assert.equal(request.referer, undefined);
        assert.doesNotMatch(request.payload.message, new RegExp(draft));
      }
      assert.equal(posts[0].payload.session_id, undefined);
      assert.equal(posts[1].payload.session_id, 'fixture-background-wechat', 'Follow-up checks must use only the channel response session');
      assert.equal(posts[2].payload.session_id, undefined, 'Feishu must not reuse the WeChat background session');
      await assert.rejects(shellCall('updateFeishuCredentials', {appId: 'cli_fixture', appSecret: 'fixture-secret', connectionRevision}));
      assert.equal(fixture.channelRequests.length, postsBefore + 3, 'Raw channel credentials must not be sent as chat messages');
      assert.doesNotMatch(JSON.stringify(posts), /cli_fixture|fixture-secret/);
      await assert.rejects(shellCall('beginChannelConnection', {channel: 'wechat', connectionRevision: connectionRevision + 1}), /连接|变化|更新/);
      assert.equal(fixture.channelRequests.length, postsBefore + 3, 'A stale page must not send a channel message');
      assert.equal(townRequests.length, townBefore, 'Channel operations must not request Heart or Town authorization');
      assert.deepEqual(await inspectDraft(), before);
      assert.equal(getView(), view);
      assert.equal(contents.getURL(), loomUrl);
      assert.equal(win.webContents.getURL(), shellUrl);
      assert.equal(await win.webContents.executeJavaScript('document.body.dataset.page'), shellPage);
      assert.equal(fixture.externalRequests(), 0);
      await contents.executeJavaScript(`document.getElementById('input').value = '';`);
    });

    await check('channel background requests follow the selected Being and reset its conversation session', async () => {
      const previousTasks=(await shellCall('getFeatureTasks')).tasks;
      assert(previousTasks.length>0);
      await visit('/being-b', tokenB);
      assert.equal(await shellCall('getFeatureTask',previousTasks[0].id),null);
      await assert.rejects(shellCall('discussFeatureTask',previousTasks[0].id),/不存在|身份/);
      const contents = getView().webContents;
      const before = await contents.executeJavaScript('({...window.fixtureDraftEvents})');
      const town = await shellCall('getTownAppState');
      const townBefore = townRequests.length;
      const postsBefore = fixture.channelRequests.length;
      const checked = await shellCall('checkChannelStatus', {channel: 'wechat', connectionRevision: town.identity.connectionRevision});
      assert.equal(checked.channels[0].status, 'connected');
      const posts = fixture.channelRequests.slice(postsBefore);
      assert.equal(posts.length, 1);
      assert.equal(posts[0].path, '/being-b/api/chat/stream');
      assert.equal(posts[0].token, tokenB);
      assert.equal(posts[0].payload.session_id, undefined, 'Changing Being identity must discard the previous background channel session');
      assert.equal(townRequests.length, townBefore);
      assert.deepEqual(await contents.executeJavaScript('({...window.fixtureDraftEvents})'), before);
      await visit('/being-a', tokenA);
      assert.deepEqual((await shellCall('getFeatureTasks')).tasks.map(task=>task.id),previousTasks.map(task=>task.id),'Returning to A must retain its one task history without B records');
    });

    await check('Fireside local draft reaches only the matching Loom input and is never submitted',async()=>{
      const contents=getView().webContents;
      const before=await contents.executeJavaScript('({...window.fixtureDraftEvents})');
      const town=await shellCall('getTownAppState');
      const revision=town.identity.connectionRevision;
      assert(Number.isSafeInteger(revision));
      const draft='Local Fireside fixture <img src=x onerror="window.fixtureInjected=true">';
      assert.deepEqual(await shellCall('prepareFiresideDraft',{draft,connectionRevision:revision}),{prepared:true});
      const actual=await contents.executeJavaScript('({draft:document.getElementById("input").value,events:{...window.fixtureDraftEvents},injected:window.fixtureInjected===true})');
      assert(actual.draft.endsWith(draft));assert.equal(actual.injected,false);
      assert.deepEqual(actual.events,{input:before.input+1,click:before.click,submit:before.submit});
      await assert.rejects(shellCall('prepareFiresideDraft',{draft:'another draft',connectionRevision:revision}),/已有草稿/);
      await assert.rejects(shellCall('prepareFiresideDraft',{draft:'stale draft',connectionRevision:revision+1}),/连接身份已变化/);
      assert.equal(await contents.executeJavaScript('document.getElementById("input").value'),actual.draft);
      await contents.executeJavaScript('document.getElementById("input").value="";');
      const expectedUrl=contents.getURL();
      const tasksBefore=(await shellCall('getFeatureTasks')).tasks.map(task=>task.id);
      await shellCall('reconnect');
      const reconnected=getView().webContents;
      await loaded(reconnected,expectedUrl);
      assert.deepEqual((await shellCall('getFeatureTasks')).tasks.map(task=>task.id),tasksBefore,'Reconnect must retain task ownership');
      const nextTown=await shellCall('getTownAppState');
      assert.equal(nextTown.identity.identityRevision,town.identity.identityRevision,'Reconnect must retain the same Being identity');
      assert(nextTown.identity.connectionRevision>revision,'A new Loom view must require a new handoff revision');
      await assert.rejects(shellCall('prepareFiresideDraft',{draft:'old-view draft',connectionRevision:revision}),/连接身份已变化/);
      assert.deepEqual(await shellCall('prepareFiresideDraft',{draft:'reconnected local draft',connectionRevision:nextTown.identity.connectionRevision}),{prepared:true});
      assert.deepEqual(await reconnected.executeJavaScript('({...window.fixtureDraftEvents})'),{input:1,click:0,submit:0});
      await reconnected.executeJavaScript('document.getElementById("input").value="";');
    });

    await check('isolated native modules handle Grove states, composition and a mocked one-click deployment', async () => {
      const {BrowserWindow} = require('electron');
      const fixtureWindow = new BrowserWindow({show:false,width:1000,height:700,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,partition:`town-module-fixture-${randomUUID()}`}});
      let requests=0;
      fixtureWindow.webContents.session.webRequest.onBeforeRequest((_details,callback)=>{requests++;callback({cancel:true});});
      try {
        await fixtureWindow.loadURL('about:blank');
        const frame=fixtureWindow.webContents.mainFrame;
        const execute=async script=>{
          assert.equal(fixtureWindow.webContents.getURL(),'about:blank');
          assert.equal(fixtureWindow.webContents.mainFrame,frame);
          return deadline(frame.executeJavaScript(script),'isolated Town module fixture');
        };
        const source=await require('node:fs/promises').readFile(path.join(__dirname,'..','renderer','town-app.js'),'utf8');
        await execute(`document.body.replaceChildren(Object.assign(document.createElement('main'),{id:'page-town-app'}));`);
        await execute(source);
        const result=await execute(`(async()=>{
          const calls={catalog:0,rooms:0,members:0,snapshots:0,refreshes:0,reads:0,send:0,deploy:0,assist:0,handoff:0,handoffRevisions:[],channel:0};
          let mode='empty',authorized=false,connectionRevision=4,identityRevision=1;
          const state={connection:{configured:true,status:'connected',displayUrl:'https://fixture.invalid/loom/',beingName:'Local fixture'},workspace:{path:''},portal:{status:'not_configured'}};
          const town=()=>({identity:{beingId:'fixture-being',displayName:'Local fixture',connectionRevision,identityRevision},access:{fireside:authorized?'ready':'auth_required',firesideRead:authorized?'ready':'auth_required',channel:'auth_required'},platformSupported:true});
          const kit={id:'fixture-kit',name:'Fixture MCP',version:'1.0.0',description:'A local test fixture',status:'sprouting',being_id:'fixture-being'};
          const bridge={getTownAppState:async()=>town(),refreshTownApp:async()=>town(),getGroveCatalog:async()=>{calls.catalog++;if(mode==='error')throw new Error('Fixture catalog unavailable');return {kits:mode==='data'?[kit]:[],count:mode==='data'?1:0,returned:mode==='data'?1:0};},getGroveDetail:async()=>({...kit,manifest:{name:kit.name,command:['node','server.mjs'],tools:[]}}),getFiresides:async()=>{calls.rooms++;return {owned:authorized?[{id:1,name:'Fixture room'}]:[],joined:[],cached:authorized};},getFiresideMembers:async()=>{calls.members++;return {members:[]};},requestTownRead:async()=>{calls.reads++;return {};},sendFiresideMessage:async()=>{calls.send++;return {status:'sent'};},deployPortal:async()=>{calls.deploy++;return {};},prepareTownAssistance:async()=>{calls.assist++;return {prepared:true};}};
          bridge.getTownMessageSnapshot=async request=>{calls.snapshots++;return {kind:request.kind,firesideId:request.firesideId||'',snapshot:{identity:town().identity,messages:[],latestSeq:0},status:{status:'ready',intervalMs:60000,lastSuccessAt:Date.now(),stale:false}};};
          bridge.refreshTownMessages=async request=>{calls.refreshes++;return bridge.getTownMessageSnapshot(request);};
          bridge.onTownMessages=()=>()=>{};
          bridge.prepareFiresideDraft=async value=>{calls.handoff++;calls.handoffRevisions.push(value.connectionRevision);if(value.connectionRevision!==connectionRevision)throw new Error('Unexpected fixture revision');return {prepared:true};};
          bridge.beginChannelConnection=async()=>{calls.channel++;return {status:'pending'};};
          const app=window.beingTownApp,flush=()=>new Promise(resolve=>setTimeout(resolve,0));
          const publish=()=>app.setState(JSON.parse(JSON.stringify({...state,townApp:town()})));
          app.init({bridge});publish();await app.open('grove');
          const empty=document.querySelector('.ta-kit-list').textContent.includes('暂时没有工具包');
          mode='data';document.getElementById('town-app-refresh').click();await flush();
          const data=document.querySelectorAll('.ta-kit-row').length===1;
          const search=document.getElementById('grove-search');search.value='no-such-kit';search.dispatchEvent(new Event('input',{bubbles:true}));
          const filtered=document.querySelectorAll('.ta-kit-row').length===0&&document.querySelector('.ta-kit-list').textContent.includes('没有匹配的工具包');
          search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));mode='error';document.getElementById('town-app-refresh').click();await flush();
          const error=document.querySelector('.ta-kit-list').textContent.includes('目录暂时无法读取');
          await app.open('channel');const channels=[];
          for(const id of ['feishu','wechat']){document.querySelector('[data-channel="'+id+'"]').click();document.getElementById('channel-connect').click();await flush();channels.push({id,steps:document.querySelectorAll('.ta-wizard-steps li').length,inputs:document.querySelectorAll('.ta-channel input').length,qr:document.querySelectorAll('.ta-channel .ta-qr').length});}
          await app.open('portal');const missingWorkspaceDisabled=document.getElementById('portal-app-deploy').disabled;
          state.workspace.path='C:/Local-fixture/workspace';publish();document.getElementById('portal-app-deploy').click();
          await flush();const confirmation=calls.deploy===1&&!document.getElementById('portal-app-confirm');
          const permissions=Boolean(document.getElementById('portal-app-permissions'));
          const portalPlan=document.querySelector('.ta-portal').textContent.includes('工具权限')&&!document.querySelector('.ta-portal').textContent.includes('计划关闭');
          await app.open('fireside');const privateRoomReads=calls.reads,lockedSend=document.getElementById('fireside-send').disabled;
          const localDraft=document.getElementById('fireside-draft');localDraft.value='Local draft for Loom';localDraft.dispatchEvent(new Event('input',{bubbles:true}));
          const localHandoffEnabled=!document.getElementById('fireside-send').disabled&&document.getElementById('fireside-send').textContent.includes('带草稿到 Loom');
          const localEnter=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});localDraft.dispatchEvent(localEnter);await flush();
          const localEnterPreserved=!localEnter.defaultPrevented&&calls.handoff===0&&calls.send===0;
          document.getElementById('fireside-send').click();await flush();
          authorized=true;publish();await app.open('fireside');
          const authorizedOpenIdle=calls.reads===0&&calls.members===0&&calls.refreshes===0;
          document.getElementById('town-app-refresh').click();await flush();
          const explicitListOnly=calls.reads===0&&calls.members===0&&calls.refreshes===0;
          document.querySelector('.ta-room-row').click();await flush();
          const selectionCacheOnly=calls.reads===0&&calls.members===1&&calls.refreshes===0&&calls.snapshots===1;
          const field=document.getElementById('fireside-draft');field.value='Local composition fixture';field.dispatchEvent(new Event('input',{bubbles:true}));const enabled=!document.getElementById('fireside-send').disabled;
          const events=[new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}),new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true,cancelable:true}),new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true})];
          events.forEach(event=>field.dispatchEvent(event));await flush();
          const beforePageSwitch={rooms:calls.rooms,members:calls.members,refreshes:calls.refreshes,reads:calls.reads};
          await app.open('channel');await app.open('fireside');
          const pageSwitchIdle=calls.reads===beforePageSwitch.reads&&calls.refreshes===beforePageSwitch.refreshes;
          const draftPreserved=field.value==='Local composition fixture';
          authorized=false;state.connection.status='error';publish();await flush();
          const disconnectedDraftPreserved=field.value==='Local composition fixture'&&document.getElementById('fireside-send').disabled;
          connectionRevision=5;state.connection.status='connecting';publish();await flush();
          const reconnectingDraftPreserved=field.value==='Local composition fixture';
          state.connection.status='connected';publish();await app.open('fireside');
          const reconnectedDraftPreserved=field.value==='Local composition fixture'&&!document.getElementById('fireside-send').disabled;
          const reconnectIdle=calls.reads===beforePageSwitch.reads&&calls.refreshes===beforePageSwitch.refreshes;
          document.getElementById('fireside-send').click();await flush();
          authorized=true;publish();await app.open('fireside');document.getElementById('town-app-refresh').click();await flush();document.querySelector('.ta-room-row').click();await flush();
          const roomDraftMapPreserved=field.value==='Local composition fixture';
          identityRevision=2;connectionRevision=6;publish();await app.open('fireside');
          const identityChangeCleared=field.value==='';
          document.getElementById('town-app-refresh').click();await flush();
          document.querySelector('.ta-room-row').click();await flush();
          const identityChangeClearedMap=field.value==='';
          return {empty,data,filtered,error,channels,missingWorkspaceDisabled,confirmation,permissions,portalPlan,privateRoomReads,lockedSend,localHandoffEnabled,localEnterPreserved,authorizedOpenIdle,explicitListOnly,selectionCacheOnly,pageSwitchIdle,reconnectIdle,enabled,compositionPreserved:events.every(event=>!event.defaultPrevented),draftPreserved,disconnectedDraftPreserved,reconnectingDraftPreserved,reconnectedDraftPreserved,roomDraftMapPreserved,identityChangeCleared,identityChangeClearedMap,calls};
        })()`);
        for(const key of ['empty','data','filtered','error','missingWorkspaceDisabled','confirmation','portalPlan','lockedSend','localHandoffEnabled','localEnterPreserved','authorizedOpenIdle','explicitListOnly','selectionCacheOnly','pageSwitchIdle','reconnectIdle','enabled','compositionPreserved','draftPreserved','disconnectedDraftPreserved','reconnectingDraftPreserved','reconnectedDraftPreserved','roomDraftMapPreserved','identityChangeCleared','identityChangeClearedMap'])assert.equal(result[key],true,key);
        assert.equal(result.privateRoomReads,0,'Opening Fireside must not drive Being');
        assert.deepEqual(result.channels,[{id:'feishu',steps:3,inputs:0,qr:0},{id:'wechat',steps:3,inputs:0,qr:0}]);
        assert.equal(result.permissions,true);
        assert.equal(result.calls.catalog,3);assert.equal(result.calls.send,0);assert.equal(result.calls.deploy,1);assert.equal(result.calls.channel,2);assert.equal(result.calls.assist,0);assert.equal(result.calls.handoff,2);assert.deepEqual(result.calls.handoffRevisions,[4,5]);assert.equal(requests,0);
      } finally {if(!fixtureWindow.isDestroyed())fixtureWindow.destroy();}
    });

    await check('persistent storage: same API with another token has a separate identity', async () => {
      const other = await visit('/being-a', tokenB, {write: 'only-account-b'});
      assert.equal(other.report.before, null, 'Another account token must not inherit A storage');
      const original = await visit('/being-a', tokenA);
      assert.equal(original.report.before, 'only-api-a');
      const again = await visit('/being-a', tokenB);
      assert.equal(again.report.before, 'only-account-b');
    });

    await check('persistent storage: secret A -> B -> A isolates storage with the same API and token', async () => {
      const first = await visit('/being-a', tokenA, {secret: 'fixture-relay-a', write: 'only-relay-a'});
      assert.equal(first.report.before, null, 'A new relay secret must not inherit the token-only session storage');
      const second = await visit('/being-a', tokenA, {secret: 'fixture-relay-b', write: 'only-relay-b'});
      assert.equal(second.report.before, null, 'Changing only the relay secret must not inherit the previous secret storage');
      const again = await visit('/being-a', tokenA, {secret: 'fixture-relay-a'});
      assert.equal(again.report.before, 'only-relay-a', 'Restoring the first relay secret must restore its own storage');
    });

    await check('late responses from A cannot overwrite the active B connection', async () => {
      await visit('/being-a', tokenA);
      await deadline(refresh(), 'drain refresh before holding A');
      const controlA = fixture.control('/being-a', tokenA);
      controlA.configMode = 'hold';
      const heldEvent = eventPromise(fixture.events, 'config-held', entry => entry.key === controlA.key);
      const oldRefresh = refresh();
      const [entry] = await heldEvent;
      await visit('/being-b', tokenA, {skipRefresh: true});
      controlA.configMode = 'ok';
      fixture.release(entry, {model: 'obsolete-a-response'});
      await deadline(oldRefresh, 'release stale A refresh');
      assert.notEqual(getState().runtime.model, 'obsolete-a-response');
      await deadline(refresh(), 'refresh current B after old A settles');
      assert.equal(getState().runtime.model, 'fixture-being-b');
    });

    const controlB = fixture.control('/being-b', tokenA);
    for (const status of ['500', '401']) {
      await check(`config HTTP ${status} clears old model and side-by-side claims`, async () => {
        controlB.configMode = status;
        await deadline(refresh(), `config ${status} refresh`);
        unknownConfig();
      });
    }

    await check('config timeout becomes unknown after the client aborts the held response', async () => {
      controlB.configMode = 'timeout';
      const started = eventPromise(fixture.events, 'timeout-started');
      const pendingRefresh = refresh();
      const [timeoutId] = await started;
      const closed = fixture.timeoutClosed.has(timeoutId) ? Promise.resolve() : eventPromise(fixture.events, 'timeout-closed', id => id === timeoutId);
      await deadline(pendingRefresh, 'config AbortSignal timeout', 18000);
      await closed;
      unknownConfig();
      assert(fixture.timeoutClosed.has(timeoutId), 'The unresponded fixture request must actually be aborted');
    });

    await check('successful config recovery replaces unknown values with fresh values', async () => {
      controlB.configMode = 'ok';
      controlB.model = 'fixture-b-restored';
      controlB.sideBySide = false;
      await deadline(refresh(), 'configuration recovery');
      const runtime = getState().runtime;
      assert.equal(runtime.configStatus, 'connected');
      assert.equal(runtime.configError, '');
      assert.equal(runtime.model, 'fixture-b-restored');
      assert.equal(runtime.sideBySide.configured, false);
      assert.equal(runtime.sideBySide.active, null, 'Saved side-by-side configuration is not proof of runtime activation');
      assert(runtime.checkedAt && runtime.configCheckedAt);
    });

    for (const mode of ['500', 'malformed']) {
      await check(`stream ${mode} remains unknown instead of reporting idle`, async () => {
        controlB.streamMode = mode;
        await deadline(refresh(), `stream ${mode} refresh`);
        assert.equal(getState().runtime.activeStream.active, null);
        assert.equal(getState().runtime.configStatus, 'connected');
      });
    }
    await check('stream recovery can explicitly report no active response', async () => {
      controlB.streamMode = 'ok';
      await deadline(refresh(), 'stream recovery');
      assert.equal(getState().runtime.activeStream.active, false);
    });

    await check('remote web links open isolated built-in tabs and retain the Loom session', async () => {
      const contents = getView().webContents;
      const currentUrl = contents.getURL();
      const target = fixture.externalOrigin + '/outside-link';
      const popupTarget = fixture.externalOrigin + '/outside-popup';
      const beforeTabs = (await shellCall('getDesktopTools')).browser.tabs;
      let createdWindows = 0;
      const onCreated = () => { createdWindows++; };
      contents.on('did-create-window', onCreated);
      try {
        const popupRequest = eventPromise(fixture.events, 'external-request', request=>request.url==='/outside-popup');
        const popupWasNull = await deadline(contents.executeJavaScript(`window.open(${JSON.stringify(popupTarget)}, '_blank') === null`, true), 'internal remote popup');
        const [popup] = await popupRequest;
        assert.equal(popupWasNull, true);
        assert.equal(popup.referer, '', 'Opening a browser tab must not forward the credentialed Loom URL');
        assert.equal(createdWindows, 0);
        const linkRequest = eventPromise(fixture.events, 'external-request', request=>request.url==='/outside-link');
        const navigation = eventPromise(contents, 'will-navigate', (_event, url) => url === target);
        await deadline(contents.executeJavaScript(`location.assign(${JSON.stringify(target)}); true;`, true), 'request remote navigation');
        const [event] = await navigation;
        const [link] = await linkRequest;
        assert.equal(event.defaultPrevented, true, 'The app must keep the Loom view on its connected page');
        assert.equal(contents.getURL(), currentUrl);
        assert.equal(link.referer, '');
        assert.equal(getState().connection.status, 'connected');
        const added = (await shellCall('getDesktopTools')).browser.tabs.filter(tab=>!beforeTabs.some(before=>before.id===tab.id));
        assert.deepEqual(added.map(tab=>tab.url).sort(), [target,popupTarget].sort());
        const {session,webContents} = require('electron');
        const {BROWSER_PARTITION} = require('../src/desktop-browser.cjs');
        const browserPages = webContents.getAllWebContents().filter(item=>item.session===session.fromPartition(BROWSER_PARTITION));
        await Promise.all(browserPages.map(page=>page.isLoadingMainFrame()?eventPromise(page,'did-stop-loading'):Promise.resolve()));
        for (const url of [target,popupTarget]) {
          const page = browserPages.find(item=>item.getURL()===url);
          assert(page, 'The opened link must have its own browser contents');
          assert.equal(page.session, session.fromPartition(BROWSER_PARTITION));
          assert.notEqual(page.session, contents.session);
          assert.equal(Boolean(page.getLastWebPreferences().preload), false);
        }
        for (const tab of added) await shellCall('desktopAction','browser.close',tab.id);
      } finally { contents.removeListener('did-create-window', onCreated); }
    });

    await check('same-page trailing-slash redirect loads successfully', async () => {
      const result = await visit('/being-b', tokenA, {noSlash: true});
      assert.equal(new URL(result.contents.getURL()).pathname, '/loom/');
      assert.equal(getState().connection.status, 'connected');
    });

    await check('cross-origin entry redirect is rejected with a recoverable error', async () => {
      const requestsBefore = fixture.externalRequests();
      const url = new URL('/redirect-away/', fixture.origin);
      url.searchParams.set('api', fixture.origin + '/being-b');
      url.searchParams.set('token', tokenA);
      const ready = eventPromise(fixture.events, 'redirect-ready');
      await shellCall('connect', url.href);
      if (!fixture.redirectReady()) await ready;
      const contents = getView().webContents;
      const redirected = eventPromise(contents, 'will-redirect');
      fixture.releaseRedirect();
      const [event] = await redirected;
      assert.equal(event.defaultPrevented, true);
      assert.equal(getState().connection.status, 'error');
      assert(getState().connection.error, 'A rejected entry redirect must leave a visible recovery path');
      assert.equal(fixture.externalRequests(), requestsBefore);
    });

    await check('disconnect removes the fixture view and resets runtime state', async () => {
      await shellCall('disconnect');
      assert.equal(getView(), null);
      assert.equal(getState().connection.configured, false);
      assert.equal(getState().runtime.status, 'unknown');
      assert.equal(getState().runtime.model, '');
    });
    return {passed: true, startedAt, finishedAt: new Date().toISOString(), checks, nativeBoundaryReports: fixture.reports.size,
      fixtureRequests: fixture.counts(), externalRequests: fixture.externalRequests()};
  } catch (error) {
    error.scenarioReport = {passed: false, startedAt, finishedAt: new Date().toISOString(), checks, failedCheck: activeCheck,
      failedAfter: checks.length, error: error.message};
    throw error;
  } finally {
    try { if (getState().connection.configured) await shellCall('disconnect'); }
    finally { guardedSession.webRequest.onBeforeRequest(null); await fixture.close(); }
  }
}

module.exports = {runDesktopScenarios};
