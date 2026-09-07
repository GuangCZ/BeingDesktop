'use strict';

// Native Chromium fetch against a loopback fixture; never contact a configured Being.
// Chrome permission/storage APIs are stubbed only for the real options page flow.
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {randomUUID, createHash} = require('node:crypto');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const {spawn} = require('node:child_process');
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], {cwd: root, env, stdio: 'inherit', windowsHide: true});
  child.on('error', error => {console.error(error.message); process.exitCode = 1;});
  child.on('exit', code => {process.exitCode = code ?? 1;});
} else {
  const {app, BrowserWindow} = require('electron');
  const http = require('node:http');
  const extensionRoot = path.resolve(process.env.BEING_ANYWHERE_FIXTURE_ROOT || path.join(root, 'extensions', 'being-anywhere'));
  const output = path.join(root, '.local', 'being-anywhere-native-fetch-' + randomUUID());
  const report = {
    scope: 'Isolated Electron Chromium renderer with untouched native fetch and a real loopback HTTP server. The actual options HTML/module uses stubbed Chrome permissions and storage only. No real Being, installed Edge/Chrome extension, or browser host-permission behavior is tested.',
    extensionRoot, checks: [], requests: [], externalRequests: []
  };
  const check = (name, passed) => {report.checks.push({name, passed: Boolean(passed)}); assert(passed, name);};
  let win;
  let server;
  app.setPath('userData', path.join(output, 'profile'));
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const finish = code => {
    clearTimeout(watchdog);
    fs.mkdirSync(output, {recursive: true});
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({report: path.join(output, 'report.json'), passed: report.checks.filter(item => item.passed).length, total: report.checks.length, failure: report.failure, requests: report.requests}, null, 2));
    if (win && !win.isDestroyed()) win.destroy();
    server?.closeAllConnections();
    server?.close();
    app.exit(code);
  };
  const watchdog = setTimeout(() => {report.failure = 'Native fetch verification timed out'; finish(1);}, 30000);
  const execute = script => win.webContents.executeJavaScript(script);
  const waitFor = async (script, label) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await execute(`Boolean(${script})`)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Fixture did not reach ' + label);
  };

  app.whenReady().then(async () => {
    const source = fs.readFileSync(path.join(extensionRoot, 'being-client.mjs'));
    report.sourceSha256 = createHash('sha256').update(source).digest('hex');
    const optionsSource = fs.readFileSync(path.join(extensionRoot, 'options.mjs'));
    report.optionsSourceSha256 = createHash('sha256').update(optionsSource).digest('hex');
    const mime = {'.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png'};
    const icons = fs.readdirSync(path.join(extensionRoot, 'icons')).filter(name => /^being-(?:\d+\.png|small\.svg)$/.test(name)).map(name => `icons/${name}`);
    const files = new Map(['options.html', 'options.mjs', 'being-client.mjs', 'ui.css', ...icons].map(name => [name, fs.readFileSync(path.join(extensionRoot, name))]));
    const setup = `
      window.__optionsFixture = {local: {}, permissions: [], accessLevels: [], nativeFetch: globalThis.fetch, trustedSubmit: false};
      const state = window.__optionsFixture;
      const storage = {get: async key => key == null ? structuredClone(state.local) : {[key]: structuredClone(state.local[key])}, set: async values => Object.assign(state.local, structuredClone(values)), remove: async key => {delete state.local[key];}, setAccessLevel: async value => {state.accessLevels.push(value);}};
      window.chrome = {permissions: {request: async value => {state.permissions.push(value); return true;}, remove: async () => true}, storage: {local: storage, session: {get: async () => ({}), remove: async () => {}}}};
      document.addEventListener('submit', event => {state.trustedSubmit = event.isTrusted;}, true);
    `;
    server = http.createServer(async (request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        let body = '';
        for await (const chunk of request) body += chunk;
        report.requests.push({method: request.method, path: url.pathname, query: url.search, hasCookie: Boolean(request.headers.cookie), hasReferer: Boolean(request.headers.referer), body: body ? JSON.parse(body) : null});
        if (request.method === 'GET' && url.pathname === '/api/status') {
          response.writeHead(200, {'Content-Type': 'application/json'});
          response.end(JSON.stringify({being_name: 'Fixture only', status: 'ready'}));
        } else if (request.method === 'GET' && url.pathname === '/api/history') {
          response.writeHead(200, {'Content-Type': 'application/json'});
          response.end(JSON.stringify({messages: [{role: 'being', content: 'Native history fixture', seq: 1}]}));
        } else if (request.method === 'POST' && url.pathname === '/api/chat/stream') {
          response.writeHead(200, {'Content-Type': 'text/event-stream'});
          const bytes = Buffer.from('event: content_block_delta\ndata: {"delta":{"text":"原生流式回复"}}\n\nevent: message_stop\ndata: {"session_id":"native-fixture-session"}\n\n');
          response.write(bytes.subarray(0, 58));
          setImmediate(() => response.end(bytes.subarray(58)));
        } else {response.writeHead(404); response.end();}
        return;
      }
      if (url.pathname === '/fixture-setup.js') {
        response.writeHead(200, {'Content-Type': 'text/javascript'});
        response.end(setup);
        return;
      }
      const filename = url.pathname.slice(1);
      if (files.has(filename)) {
        let content = files.get(filename);
        if (filename === 'options.html') content = content.toString().replace('<script type="module" src="options.mjs">', '<script src="fixture-setup.js"></script><script type="module" src="options.mjs">');
        response.writeHead(200, {'Content-Type': mime[path.extname(filename)]});
        response.end(content);
        return;
      }
      response.writeHead(200, {'Content-Type': 'text/html'});
      response.end('<!doctype html><html><body>Isolated native fetch verification</body></html>');
    });
    await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
    const origin = 'http://127.0.0.1:' + server.address().port;
    win = new BrowserWindow({show: false, width: 900, height: 950, webPreferences: {nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false}});
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url.startsWith(origin + '/') || details.url === 'about:blank';
      if (!allowed) report.externalRequests.push(details.url);
      callback({cancel: !allowed});
    });
    await win.loadURL(origin + '/');
    report.client = await execute(`(async () => {
      const nativeFetch = globalThis.fetch;
      const {BeingClient} = await import('/being-client.mjs');
      const capture = async operation => {try {return {ok: true, value: await operation()};} catch (error) {return {ok: false, name: error.name, code: error.code, message: error.message};}};
      const receiver = {fetch: nativeFetch};
      const client = new BeingClient(location.origin);
      const events = [];
      return {
        nativeFetch: String(nativeFetch),
        rawWrongReceiver: await capture(async () => (await receiver.fetch(location.origin + '/api/status')).json()),
        status: await capture(() => client.status()),
        history: await capture(() => client.readHistory()),
        send: await capture(() => client.send({message: 'Native fixture question', onEvent: event => events.push(event)})),
        events,
        bound: await capture(() => new BeingClient(location.origin, nativeFetch.bind(globalThis)).status()),
        wrapped: await capture(() => new BeingClient(location.origin, (...args) => globalThis.fetch(...args)).status()),
        nativeUnchanged: globalThis.fetch === nativeFetch
      };
    })()`);
    const client = report.client;
    check('Renderer uses untouched native Chromium fetch', client.nativeUnchanged && /\[native code\]/u.test(client.nativeFetch));
    check('Wrong receiver reproduces the original browser failure', !client.rawWrongReceiver.ok && client.rawWrongReceiver.name === 'TypeError' && /Illegal invocation/u.test(client.rawWrongReceiver.message));
    check('Default client status reaches the server and parses JSON', client.status.ok && client.status.value.status === 'ready');
    check('Default client history reaches the server and parses messages', client.history.ok && client.history.value[0]?.content === 'Native history fixture');
    check('Default client sends and completes a native HTTP SSE response', client.send.ok && client.send.value.accepted === false);
    check('Native SSE preserves UTF-8 content and completion events', client.events.length === 2 && client.events[0].data.delta.text === '原生流式回复' && client.events[1].type === 'message_stop' && client.events[1].data.session_id === 'native-fixture-session');
    check('Explicit bound and wrapper transports remain supported', client.bound.ok && client.wrapped.ok);
    check('Wrong receiver never reaches HTTP and default operations each send once', report.requests.length === 5 && report.requests.filter(item => item.method === 'POST').length === 1);

    await win.loadURL(origin + '/options.html');
    await waitFor('window.__optionsFixture && document.readyState === "complete"', 'options module initialization');
    await execute(`document.getElementById('loom-url').value = location.origin`);
    const point = await execute(`(() => {const rect = document.getElementById('connect').getBoundingClientRect(); return {x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)};})()`);
    win.webContents.sendInputEvent({type: 'mouseDown', ...point, button: 'left', clickCount: 1});
    win.webContents.sendInputEvent({type: 'mouseUp', ...point, button: 'left', clickCount: 1});
    await waitFor('window.__optionsFixture.local.connection || !document.getElementById("error").hidden', 'options connection result');
    report.options = await execute(`(() => {const state = window.__optionsFixture; return {local: state.local, permissions: state.permissions, accessLevels: state.accessLevels, trustedSubmit: state.trustedSubmit, nativeUnchanged: globalThis.fetch === state.nativeFetch, result: document.getElementById('result').textContent, error: document.getElementById('error').textContent, inputCleared: document.getElementById('loom-url').value === '', buttonEnabled: !document.getElementById('connect').disabled};})()`);
    check('Real options form receives a trusted submit with native fetch untouched', report.options.trustedSubmit && report.options.nativeUnchanged);
    check('Save verifies the server then stores the loopback connection', report.options.local.connection?.url === origin + '/' && report.options.result.startsWith('已连接') && !report.options.error);
    check('Save requests only the configured origin and protects local storage', report.options.permissions.length === 1 && report.options.permissions[0].origins[0] === origin + '/*' && report.options.accessLevels[0]?.accessLevel === 'TRUSTED_CONTEXTS');
    check('Successful save clears the connection input and restores its button', report.options.inputCleared && report.options.buttonEnabled);
    check('Options validation makes exactly one additional status GET', report.requests.length === 6 && report.requests[5].method === 'GET' && report.requests[5].path === '/api/status');
    check('All requests stay local, omit cookies/referrers, and send only the fixture question', report.externalRequests.length === 0 && report.requests.every(item => !item.hasCookie && !item.hasReferer) && report.requests.filter(item => item.method === 'POST')[0].body.message === 'Native fixture question');
    report.readCounts = {status: report.requests.filter(item => item.path === '/api/status').length, history: report.requests.filter(item => item.path === '/api/history').length, chatPosts: report.requests.filter(item => item.method === 'POST').length};
    finish(0);
  }).catch(error => {report.failure = error.message; finish(1);});
}
