'use strict';

// Offline UI fixture only: this does not install an extension or verify Chrome API behavior.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const root = path.resolve(__dirname, '..');

function installFixture(manifestVersion) {
  const connection = {url: 'https://loom.fixture.example/loom/Being?token=fixture-only-token'};
  const restored = new URLSearchParams(location.search).has('persist') ? JSON.parse(sessionStorage.getItem('being-fixture-state') || 'null') : null;
  const state = window.__fixture = window.parent !== window && window.parent.__fixture || {
    calls: [], requests: [], chatRequests: [], local: {connection}, session: {}, holdNext: false,
    captured: {text: '真正有价值的工具，应该让思考自然地延续。', title: '阅读与思考 · 示例文章', url: 'https://article.example/reading'},
    permissionGranted: true, messageListeners: [], bootstrapRace: new URLSearchParams(location.search).has('race')
  };
  if (restored) Object.assign(state, restored, {messageListeners: []});
  if (new URLSearchParams(location.search).has('progress')) state.streamPlan = [{method: 'POST', defer: true}];
  const persist = () => {
    if (new URLSearchParams(location.search).has('persist')) sessionStorage.setItem('being-fixture-state', JSON.stringify({calls: state.calls, requests: state.requests, chatRequests: state.chatRequests, local: state.local, session: state.session}));
  };
  const floatingId = new URLSearchParams(location.search).get('id');
  if (floatingId && !state.session['float:' + floatingId]) state.session['float:' + floatingId] = {id: floatingId, windowId: 7, tabId: 12, selection: structuredClone(state.captured), prompt: '这段话对我有什么启发？', started: false};
  const changed = state.changed || (state.changed = []);
  const event = () => ({addListener(listener) {changed.push(listener);}});
  const storage = area => ({
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(state[area]);
      const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const result = Object.fromEntries(names.map(key => [key, structuredClone(state[area][key])]));
      if (area === 'session' && names.includes('queue:7') && state.bootstrapRace) {
        state.bootstrapRace = false;
        state.session['queue:7'] = [{id: 'race-item', selection: {text: '并发到达的新选区', title: 'Latest article', url: 'https://article.example/latest'}, prompt: ''}];
        state.local.connection = {url: 'https://loom.fixture.example/loom/Latest?token=fixture-new-token'};
        queueMicrotask(() => {
          changed.forEach(listener => listener({'queue:7': {newValue: structuredClone(state.session['queue:7'])}}, 'session'));
          changed.forEach(listener => listener({connection: {newValue: structuredClone(state.local.connection)}}, 'local'));
        });
        await Promise.resolve();
      }
      return result;
    },
    async set(values) {
      const updates = {};
      for (const [key, value] of Object.entries(values)) {
        updates[key] = {oldValue: structuredClone(state[area][key]), newValue: structuredClone(value)};
        state[area][key] = structuredClone(value);
      }
      persist();
      queueMicrotask(() => changed.forEach(listener => listener(updates, area)));
    },
    async remove(keys) {
      const updates = {};
      for (const key of [].concat(keys)) {updates[key] = {oldValue: state[area][key]}; delete state[area][key];}
      persist();
      queueMicrotask(() => changed.forEach(listener => listener(updates, area)));
    },
    async setAccessLevel() {}
  });
  const local = storage('local'), session = storage('session');
  window.chrome = {
    runtime: {
      id: 'offline-fixture', getURL: name => `${location.origin}/${name}`,
      getManifest: () => ({version: manifestVersion}),
      onMessage: {addListener: listener => state.messageListeners.push(listener)},
      async openOptionsPage() {state.calls.push({type: 'options.open'});},
      async sendMessage(message) {
        state.calls.push(structuredClone(message));
        if (message.type === 'being:widget-status') return {ok: true, status: state.widgetReady ? 'ready' : 'missing', version: manifestVersion, visible: false};
        if (message.type === 'being:widget-activate') {
          if (state.failNextWidget) {state.failNextWidget = false; return {ok: false, status: 'missing', version: manifestVersion, visible: false};}
          state.widgetReady = true;
          return {ok: true, status: 'ready', version: manifestVersion, visible: true};
        }
        if (message.type === 'being:capture') return {ok: true, selection: structuredClone(state.captured)};
        if (message.type === 'being:stage') {
          state.stageSettled = false;
          const item = {id: crypto.randomUUID(), selection: structuredClone(message.selection), prompt: message.prompt, autoSend: message.autoSend === true};
          await session.set({'queue:7': [...(state.session['queue:7'] || []), item]});
          state.stageSettled = true;
          return {ok: true};
        }
        if (message.type === 'being:claim-shortcut') {
          const key = 'queue:' + message.windowId;
          const item = (state.session[key] || []).find(entry => entry.id === message.id && entry.autoSend === true);
          if (!item) return {ok: true, claimed: false};
          await session.set({[key]: state.session[key].filter(entry => entry.id !== message.id)});
          if (state.holdNextShortcutClaim) {state.holdNextShortcutClaim = false; await new Promise(resolve => {state.releaseShortcutClaim = resolve;});}
          return {ok: true, claimed: true, item};
        }
        if (message.type === 'being:float') {
          if (state.holdNextFloat) {state.holdNextFloat = false; await new Promise(resolve => {state.releaseFloat = resolve;});}
          if (state.failNextFloat) {state.failNextFloat = false; return {ok: false, error: 'Internal https://being.example/?token=SHOULD_STAY_PRIVATE'};}
          const id = crypto.randomUUID();
          await session.set({['float:' + id]: {id, tabId: 12, windowId: 7, selection: structuredClone(message.selection), prompt: message.prompt, started: false}});
          return {ok: true, id};
        }
        if (message.type === 'being:float-context') {
          const value = state.session['float:' + message.id];
          if (!value) return {ok: false, error: '浮窗已过期。'};
          const autoSend = !value.started && !value.moved;
          await session.set({['float:' + message.id]: {...value, started: true}});
          return {ok: true, context: {id: value.id, windowId: value.windowId, selection: value.selection, prompt: value.prompt}, autoSend, moved: value.moved === true};
        }
        if (message.type === 'being:float-transfer') {
          const chat = state.session['chat:float-' + message.id];
          const composer = state.session['composer:float-' + message.id];
          await session.set({'handoff:7': [...(state.session['handoff:7'] || []), {id: crypto.randomUUID(), identity: chat.identity, sessionId: chat.sessionId, messages: chat.messages, composer, floatId: message.id}], ['float:' + message.id]: {...state.session['float:' + message.id], moved: true}});
          return {ok: true};
        }
        if (message.type === 'being:consume-handoff') {
          const key = 'handoff:' + message.windowId;
          const handoff = (state.session[key] || []).find(item => item.id === message.id);
          if (!handoff) return {ok: true, alreadyConsumed: true};
          await session.set({[key]: (state.session[key] || []).filter(item => item.id !== message.id), ['chat:' + message.windowId]: {identity: handoff.identity, sessionId: handoff.sessionId, messages: handoff.messages}, ['composer:' + message.windowId]: handoff.composer || {prompt: '', selection: null}});
          return {ok: true, handoff};
        }
        if (message.type === 'being:consume') {
          const key = `queue:${message.windowId}`;
          await session.set({[key]: (state.session[key] || []).filter(item => item.id !== message.id)});
          return {ok: true};
        }
        return {ok: false, error: 'Unsupported fixture message'};
      }
    },
    storage: {local, session, onChanged: event()},
    windows: {async getCurrent() {return {id: 7};}},
    tabs: {
      async query() {return [{id: 12, windowId: 7, title: state.captured.title, url: state.captured.url}];},
      async get() {return {id: 12, windowId: 7};},
      async create(value) {state.calls.push({type: 'tabs.create', ...value});}
    },
    sidePanel: {async open(value) {state.calls.push({type: 'panel.open', whileStagePending: state.stageSettled !== true, ...value});}},
    permissions: {
      async contains(value) {state.calls.push({type: 'permission.contains', ...value}); return state.permissionGranted;},
      async request(value) {state.calls.push({type: 'permission.request', ...value}); state.permissionGranted = true; return true;},
      async remove(value) {state.calls.push({type: 'permission.remove', ...value}); return true;}
    }
  };
  window.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.origin !== 'https://loom.fixture.example') throw new Error('Fixture blocked unexpected endpoint');
    const request = {url: url.href, method: options.method, body: options.body ? JSON.parse(options.body) : null};
    state.requests.push(request);
    if (options.method === 'POST' && url.pathname.endsWith('/api/chat/stream')) state.chatRequests.push(request);
    persist();
    if (url.pathname.endsWith('/api/status')) return new Response(JSON.stringify(state.statusOverride || {name: 'Being', status: 'ready'}), {headers: {'Content-Type': 'application/json'}});
    if (url.pathname.endsWith('/api/history')) {
      const history = structuredClone(state.historyOverride || {messages: [{role: 'user', content: '之前的话题是什么？', seq: 1}, {role: 'being', content: '我们聊到了让工具融入阅读和思考。', seq: 2}]});
      if (state.recoveryMode && state.chatRequests.length) history.messages.push({role: 'user', content: state.chatRequests.at(-1).body.message, seq: 3}, ...(state.recoveryHistory || []));
      return new Response(JSON.stringify(history), {headers: {'Content-Type': 'application/json'}});
    }
    if (url.pathname.endsWith('/api/stream/active')) {
      if (state.recoveryMode && state.chatRequests.length) return new Promise((resolve, reject) => {
        const read = {after: Number(url.searchParams.get('after') || 0), released: false};
        (state.activeReads ||= []).push(read);
        read.release = data => {read.released = true; resolve(new Response(JSON.stringify(data), {headers: {'Content-Type': 'application/json'}}));};
        options.signal?.addEventListener('abort', () => {read.aborted = true; reject(new DOMException('Aborted', 'AbortError'));}, {once: true});
      });
      return new Response(null, {status: 204});
    }
    if (!url.pathname.endsWith('/api/chat/stream')) throw new Error('Fixture route unavailable');
    const encoder = new TextEncoder();
    const planned = state.streamPlan?.shift();
    if (planned) {
      if (planned.method && planned.method !== (options.method || 'GET')) throw new Error('Unexpected fixture stream method');
      if (planned.status === 202) return new Response(JSON.stringify(planned.body || {}), {status: 202, headers: {'Content-Type': 'application/json'}});
      const stream = {closed: false, aborted: false, events: []};
      (state.liveStreams ||= []).push(stream);
      const response = () => new Response(new ReadableStream({
        start(controller) {
          stream.push = (type, data) => {
            if (stream.closed) throw new Error('Fixture cannot push into a closed stream');
            stream.events.push({type, data});
            controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
          };
          stream.close = () => {if (!stream.closed) {stream.closed = true; controller.close();}};
          const abort = () => {if (!stream.closed) {stream.closed = true; stream.aborted = true; controller.error(new DOMException('Aborted', 'AbortError'));}};
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener('abort', abort, {once: true});
        },
        cancel() {stream.closed = true;}
      }), {headers: {'Content-Type': 'text/event-stream'}});
      if (planned.defer) return new Promise((resolve, reject) => {
        stream.release = () => resolve(response());
        options.signal?.addEventListener('abort', () => {stream.aborted = true; reject(new DOMException('Aborted', 'AbortError'));}, {once: true});
      });
      return response();
    }
    const hold = state.holdNext; state.holdNext = false;
    const body = new ReadableStream({
      start(controller) {
        const push = (type, data) => controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
        push('meta', {session_id: 'fixture-session-1'});
        push('content_block_delta', {delta: {text: '这段话强调：工具应该融入你的思考过程。\n\n你可以先保留关键观点，再继续追问它与你的工作有什么关系。'}});
        if (hold) options.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), {once: true});
        else {push('message_stop', {session_id: 'fixture-session-1'}); controller.close();}
      }
    });
    return new Response(body, {headers: {'Content-Type': 'text/event-stream'}});
  };
  window.close = () => {state.calls.push({type: 'window.close'});};
}

if (!process.versions.electron) {
  const {spawn} = require('node:child_process');
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], {cwd: root, env, windowsHide: true, stdio: 'inherit'});
  child.on('error', error => {process.stderr.write(`${error.message}\n`); process.exitCode = 1;});
  child.on('exit', code => {process.exitCode = code ?? 1;});
} else {
  const {app, BrowserWindow, protocol, session: electronSession} = require('electron');
  const extensionRoot = path.resolve(process.env.BEING_ANYWHERE_FIXTURE_ROOT || path.join(root, 'extensions', 'being-anywhere'));
  const runRoot = path.join(root, '.local', `being-anywhere-${randomUUID()}`);
  const report = {scope: 'Offline Electron page fixture with fake Chrome APIs and Loom responses. This is not Chrome extension installation, host-permission, side-panel-gesture, or real Being connectivity verification.', extensionRoot, checks: [], screenshots: [], consoleErrors: [], externalRequests: [], platformWarnings: []};
  const mime = {'.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml'};
  let win;
  let popupShortcutItem;
  app.on('window-all-closed', () => {});
  app.setPath('userData', path.join(runRoot, 'profile'));
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  protocol.registerSchemesAsPrivileged([{scheme: 'being-fixture', privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true}}]);
  const check = (name, passed, detail) => {report.checks.push({name, passed: Boolean(passed), ...(detail === undefined ? {} : {detail})}); assert(passed, name);};
  const execute = script => win.webContents.executeJavaScript(script);
  const waitFor = async (condition, label) => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await execute(`Boolean(${condition})`)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Fixture did not reach ${label}`);
  };
  async function screenshot(name) {
    const frames = [win.webContents.mainFrame, ...win.webContents.mainFrame.framesInSubtree.filter(frame => frame !== win.webContents.mainFrame)];
    const imageStates = [];
    for (const frame of frames) imageStates.push(...await frame.executeJavaScript('Promise.all(Array.from(document.images, async img => {try {await img.decode();} catch {} return {src:img.src,loaded:img.naturalWidth > 0};}))'));
    if (imageStates.some(item => !item.loaded)) (report.imageWarnings ||= []).push({name, images:imageStates.filter(item => !item.loaded)});
    await execute('document.fonts.ready');
    await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const expected = await execute('({width: innerWidth, height: innerHeight})');
    let captureTimer;
    let png;
    try {
      png = await Promise.race([
        (async () => {
          for (let attempt = 0; attempt < 3; attempt++) {
            const capture = await win.webContents.capturePage();
            const size = capture.getSize();
            const buffer = capture.toPNG();
            if (buffer.length && size.width === expected.width && size.height === expected.height) return buffer;
            win.webContents.invalidate();
            await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
          }
          throw new Error('Fixture page capture was empty or had stale viewport dimensions: ' + name);
        })(),
        new Promise((resolve, reject) => {captureTimer = setTimeout(() => reject(new Error('Fixture page capture timed out: ' + name)), 3000);})
      ]);
    } finally {clearTimeout(captureTimer);}
    (report.screenshotSizes ||= []).push({name, ...expected});
    const output = path.join(runRoot, `${name}.png`);
    await fs.writeFile(output, png); report.screenshots.push(output);
  }
  async function load(page, width, height) {
    win.setContentSize(width, height);
    await win.loadURL(`being-fixture://extension/${page}`);
    await waitFor('window.__fixture && document.readyState === "complete"', page);
  }
  const setInput = (id, value) => execute(`(() => {const element=document.getElementById(${JSON.stringify(id)});element.value=${JSON.stringify(value)};element.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const click = id => execute(`document.getElementById(${JSON.stringify(id)}).click()`);
  const trustedClick = async (selector, index = 0) => {
    const rect = await execute(`(() => {const element = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; const rect = element.getBoundingClientRect(); return {x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)};})()`);
    win.webContents.sendInputEvent({type: 'mouseDown', ...rect, button: 'left', clickCount: 1});
    win.webContents.sendInputEvent({type: 'mouseUp', ...rect, button: 'left', clickCount: 1});
    await execute('new Promise(resolve => requestAnimationFrame(resolve))');
  };
  const grayscale = color => {
    const channels = color.match(/[\d.]+/g)?.map(Number);
    return channels?.length >= 3 && channels[0] === channels[1] && channels[1] === channels[2];
  };
  const sourcePngLogo = logo => logo.loaded && /\/icons\/being-(16|20|24|32|40|48|64|80|96|112|128|160|192|256)\.png$/.test(logo.currentSrc) && Boolean(logo.srcset && logo.sizes);
  async function verifyFlatTheme(surface) {
    const theme = await execute(`(async () => {
      const logos = Array.from(document.querySelectorAll('.brand img, .welcome img, .message-label img, .being-progress-logo'));
      await Promise.all(logos.map(image => image.decode()));
      const styles = ['body', '.primary', '.composer', '.context-card', '.input-box', '.error'].flatMap(selector => {
        const element = document.querySelector(selector);
        if (!element) return [];
        const style = getComputedStyle(element);
        return [{selector, color: style.color, background: style.backgroundColor, border: style.borderTopColor, shadow: style.boxShadow, image: style.backgroundImage}];
      });
      return {logos: logos.map(image => ({src: image.getAttribute('src'), currentSrc: image.currentSrc, srcset: image.getAttribute('srcset'), sizes: image.getAttribute('sizes'), loaded: image.complete && image.naturalWidth > 0})), styles};
    })()`);
    check(surface + '-uses-flat-monochrome-ui-and-existing-logo', theme.logos.length > 0 && theme.logos.every(sourcePngLogo) && theme.styles.every(style => grayscale(style.color) && grayscale(style.background) && grayscale(style.border) && style.shadow === 'none' && style.image === 'none'), theme);
  }

  async function verifySidebar() {
    await load('sidepanel.html', 400, 850);
    await waitFor('document.getElementById("connection-label").textContent.includes("loom.fixture.example")', 'configured sidebar');
    check('sidebar-initially-no-model-request', await execute('__fixture.chatRequests.length === 0'));
    check('sidebar-no-horizontal-overflow', await execute('document.documentElement.scrollWidth <= innerWidth'));
    await verifyFlatTheme('sidebar');
    await screenshot('01-sidebar-welcome');
    await execute('chrome.storage.session.set({"queue:7":[{id:"fixture-selection-1",selection:__fixture.captured,prompt:""}]})');
    await waitFor('!document.getElementById("context").hidden && (__fixture.session["queue:7"] || []).length === 0', 'selection adoption');
    check('sidebar-selection-preview', await execute('document.getElementById("source-text").textContent === __fixture.captured.text'));
    check('sidebar-selection-is-not-sent-until-submit', await execute('__fixture.chatRequests.length === 0'));
    await setInput('prompt', '请用三个要点总结这段内容。');
    await screenshot('02-sidebar-selection');
    await click('send');
    await waitFor('__fixture.chatRequests.length === 1 && !document.getElementById("send").disabled && document.querySelectorAll(".message.being").length === 1', 'first streamed reply');
    check('sidebar-first-send-includes-quotation', await execute('__fixture.chatRequests[0].body.message.includes(__fixture.captured.text) && __fixture.chatRequests[0].body.message.includes(__fixture.captured.url)'));
    check('sidebar-clears-submitted-context', await execute('document.getElementById("context").hidden && document.getElementById("prompt").value === ""'));
    await setInput('prompt', '可以举一个具体例子吗？'); await click('send');
    await waitFor('__fixture.chatRequests.length === 2 && !document.getElementById("send").disabled', 'continued reply');
    check('sidebar-continues-same-session', await execute('__fixture.chatRequests[1].body.session_id === "fixture-session-1"'));
    check('sidebar-followup-does-not-repeat-consumed-quote', await execute('!__fixture.chatRequests[1].body.message.includes(__fixture.captured.text)'));
    await screenshot('03-sidebar-conversation');
    await execute('__fixture.holdNext = true'); await setInput('prompt', '继续展开。'); await click('send');
    await waitFor('!document.getElementById("stop").hidden && __fixture.chatRequests.length === 3', 'stoppable reply');
    await click('stop'); await waitFor('!document.getElementById("send").disabled', 'stopped reply');
    check('sidebar-stop-preserves-partial-reply', await execute('document.getElementById("transcript").textContent.includes("已停止接收") && document.querySelectorAll(".message.being").length === 3'));
    await click('history'); await waitFor('document.getElementById("activity").textContent.includes("已同步")', 'history sync');
    check('sidebar-history-replaces-transcript', await execute('document.querySelectorAll(".message").length === 2 && document.getElementById("transcript").textContent.includes("我们聊到了")'));
    await click('settings');
    check('sidebar-settings-entry', await execute('__fixture.calls.some(item => item.type === "options.open")'));
    win.setContentSize(300, 650);
    await execute('new Promise(resolve => requestAnimationFrame(resolve))');
    check('sidebar-narrow-layout', await execute('document.documentElement.scrollWidth <= innerWidth && document.getElementById("send").getBoundingClientRect().right <= innerWidth'));
    await screenshot('04-sidebar-narrow');
  }

  async function verifyInstallLinks(mode) {
    await load(mode === 'floating' ? 'floating.html?id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' : 'sidepanel.html', 400, 760);
    await waitFor('!document.getElementById("send").disabled', 'install view ready');
    await setInput('prompt', '保留普通聊天草稿');
    await trustedClick('#install-toggle');
    await setInput('install-url', 'https://github.com/acme/tool?token=private');
    const before = await execute('__fixture.chatRequests.length');
    await trustedClick('#install-submit');
    check(mode+'-invalid-install-link-never-sends', await execute(`__fixture.chatRequests.length === ${before} && !document.getElementById('error').hidden`));
    await setInput('install-url', 'https://github.com/acme/tool/blob/main/SKILL.md');
    check(mode+'-paste-alone-never-installs', await execute(`__fixture.chatRequests.length === ${before}`));
    await trustedClick('#install-submit');
    await waitFor(`__fixture.chatRequests.length === ${before+1} && !document.getElementById('send').disabled`, 'installation conversation reply');
    check(mode+'-install-directly-sends-scoped-request', await execute(`__fixture.chatRequests.at(-1).body.message.includes('Skill 安装到当前连接的 Being') && __fixture.chatRequests.at(-1).body.message.includes('没有兼容的 Skill 加载器')`));
    check(mode+'-install-keeps-ordinary-draft', await execute(`document.getElementById('prompt').value === '保留普通聊天草稿' && document.getElementById('install-form').hidden`));
    check(mode+'-install-does-not-fabricate-success', await execute(`document.getElementById('activity').textContent === '就绪'`));
    win.setContentSize(300, 650);
    await trustedClick('#install-toggle');
    check(mode+'-install-narrow-layout', await execute('document.documentElement.scrollWidth <= innerWidth && document.getElementById("install-submit").getBoundingClientRect().right <= innerWidth'));
    await screenshot(mode+'-install-link');
  }

  async function verifyPopup() {
    await load('popup.html', 380, 560);
    await waitFor('!document.getElementById("context").hidden', 'popup capture');
    check('popup-displays-captured-selection', await execute('document.getElementById("source-text").textContent === __fixture.captured.text'));
    check('popup-no-horizontal-overflow', await execute('document.documentElement.scrollWidth <= innerWidth'));
    await verifyFlatTheme('popup');
    await setInput('prompt', '保留我的自定义问题，不要被快捷操作覆盖。');
    await screenshot('05-popup-selection');
    await execute('document.getElementById("prompt").dispatchEvent(new CompositionEvent("compositionstart", {bubbles: true, data: "zhong"}))');
    await trustedClick('.chips [data-prompt]', 0);
    await waitFor('__fixture.calls.some(item => item.type === "window.close")', 'popup handoff');
    await execute('document.getElementById("prompt").dispatchEvent(new CompositionEvent("compositionend", {bubbles: true, data: "中"}))');
    check('popup-prompt-shortcut-directly-sends-without-filling-draft', await execute('document.getElementById("prompt").value === "保留我的自定义问题，不要被快捷操作覆盖。" && __fixture.session.popupDraft.prompt === "保留我的自定义问题，不要被快捷操作覆盖。"'));
    const handoff = await execute('__fixture.calls.filter(item => ["panel.open","being:stage"].includes(item.type))');
    check('popup-opens-panel-without-awaiting-handoff', handoff.length === 2 && handoff.some(item => item.type === 'panel.open' && item.whileStagePending));
    const staged = handoff.find(item => item.type === 'being:stage');
    check('popup-handoff-preserves-context-and-question', staged.selection.text.includes('思考') && staged.prompt.includes('三个要点') && staged.autoSend === true);
    check('popup-preserves-custom-draft-after-shortcut-handoff', await execute('__fixture.session.popupDraft.prompt === "保留我的自定义问题，不要被快捷操作覆盖。" && __fixture.session["queue:7"].length === 1 && __fixture.session["queue:7"][0].autoSend === true'));
    popupShortcutItem = await execute('structuredClone(__fixture.session["queue:7"][0])');
    await click('remove'); await setInput('prompt', ''); await click('continue');
    check('popup-empty-submit-asks-for-input', await execute('!document.getElementById("error").hidden && document.getElementById("error").textContent.includes("输入")'));
    check('popup-never-calls-model-directly', await execute('__fixture.chatRequests.length === 0'));
    await load('popup.html', 380, 640);
    await waitFor('!document.getElementById("activate-widget").disabled && !document.getElementById("context").hidden', 'popup widget status');
    check('popup-shows-installed-version-and-missing-widget', await execute('document.getElementById("installed-version").textContent === "v" + chrome.runtime.getManifest().version && document.getElementById("widget-status").textContent.includes("未载入")'));
    await trustedClick('details.widget-tools > summary');
    await screenshot('18-popup-widget-not-loaded');
    await execute('__fixture.failNextWidget = true');
    await trustedClick('#activate-widget');
    await waitFor('!document.getElementById("activate-widget").disabled && !document.getElementById("error").hidden', 'widget activation failure');
    check('popup-widget-activation-failure-keeps-popup-open', await execute('!__fixture.calls.some(item => item.type === "window.close") && __fixture.chatRequests.length === 0'));
    await trustedClick('#activate-widget');
    await waitFor('__fixture.calls.some(item => item.type === "window.close")', 'widget activation success');
    check('popup-widget-activation-carries-selection-without-sending', await execute('__fixture.calls.filter(item => item.type === "being:widget-activate").length === 2 && __fixture.calls.find(item => item.type === "being:widget-activate").selection.text === __fixture.captured.text && __fixture.chatRequests.length === 0'));

  }

  async function verifyDirectChatShortcuts(surface) {
    const floating = surface === 'floating';
    const floatingId = 'cd2221de-b378-4e47-9ab9-cdd89f2e4c1f';
    await load(floating ? 'floating.html?id=' + floatingId : 'sidepanel.html', floating ? 408 : 400, floating ? 520 : 850);
    await waitFor('!document.getElementById("send").disabled && document.getElementById("connection-label").textContent.includes("loom.fixture.example")', surface + ' shortcuts ready');
    if (floating) await waitFor('__fixture.chatRequests.length === 1 && document.querySelectorAll(".message.being").length === 1 && !document.getElementById("send").disabled', 'floating shortcut base conversation');
    else {
      await execute('chrome.storage.session.set({"queue:7":[{id:"direct-shortcut-selection",selection:__fixture.captured,prompt:""}]})');
      await waitFor('document.getElementById("source-text").textContent === __fixture.captured.text && (__fixture.session["queue:7"] || []).length === 0', 'sidebar shortcut selection');
    }
    const savedDraft = '这是一条尚未发送的自定义草稿，请完整保留。';
    await setInput('prompt', savedDraft);
    const actions = await execute('Array.from(document.querySelectorAll(".chips [data-prompt]"), button => button.dataset.prompt)');
    assert.equal(actions.length, 3, surface + ' has three shortcuts');
    for (let index = 0; index < actions.length; index++) {
      const expectedCount = (floating ? 1 : 0) + index + 1;
      await execute('document.getElementById("prompt").dispatchEvent(new CompositionEvent("compositionstart", {bubbles: true, data: "zhong"}))');
      await trustedClick('.chips [data-prompt]', index);
      await waitFor('__fixture.chatRequests.length === ' + expectedCount + ' && !document.getElementById("send").disabled', surface + ' direct shortcut ' + index);
      await execute('document.getElementById("prompt").dispatchEvent(new CompositionEvent("compositionend", {bubbles: true, data: "中"}))');
      const state = await execute('({request:__fixture.chatRequests.at(-1).body,count:__fixture.chatRequests.length,draft:document.getElementById("prompt").value,storedDraft:__fixture.session[' + JSON.stringify('composer:' + (floating ? 'float-' + floatingId : '7')) + ']?.prompt,source:document.getElementById("source-text").textContent,contextHidden:document.getElementById("context").hidden})');
      check(surface + '-shortcut-' + ['summary', 'explain', 'translate'][index] + '-sends-once-without-draft-pollution', state.count === expectedCount && state.request.message.includes(actions[index]) && !state.request.message.includes(savedDraft) && state.draft === savedDraft && state.storedDraft === savedDraft && (floating || (!state.contextHidden && state.source.includes('思考') && state.request.message.includes(state.source))) && (expectedCount === 1 || state.request.session_id === 'fixture-session-1'));
    }
  }

  async function verifyPopupShortcutQueue() {
    await execute('sessionStorage.removeItem("being-fixture-state")');
    await load('sidepanel.html?persist=1', 400, 850);
    await waitFor('document.getElementById("connection-label").textContent.includes("loom.fixture.example") && !document.getElementById("send").disabled', 'popup shortcut target');
    const savedSelection = {text: '侧栏原有引用，需要继续保留。', title: 'Original sidebar reference', url: 'https://original.example/article'};
    await execute('chrome.storage.session.set({"queue:7":[{id:"existing-sidebar-reference",selection:' + JSON.stringify(savedSelection) + ',prompt:""}]})');
    await waitFor('document.getElementById("source-text").textContent === ' + JSON.stringify(savedSelection.text) + ' && (__fixture.session["queue:7"] || []).length === 0', 'existing sidebar reference');
    let savedDraft = '侧栏中已有的草稿，不是本次快捷提问。';
    await setInput('prompt', savedDraft);
    const blockedItem = {id: 'ordinary-pending-item', selection: savedSelection, prompt: ''};
    await execute('__fixture.holdNextShortcutClaim = true');
    await execute('chrome.storage.session.set({"queue:7":' + JSON.stringify([blockedItem, popupShortcutItem]) + '})');
    await waitFor('typeof __fixture.releaseShortcutClaim === "function" && __fixture.chatRequests.length === 0', 'deferred popup shortcut claim');
    await execute('document.getElementById("prompt").dispatchEvent(new CompositionEvent("compositionstart", {bubbles: true, data: "zhong"}))');
    savedDraft += '正在输入的中文';
    await setInput('prompt', savedDraft);
    await execute('__fixture.releaseShortcutClaim()');
    await waitFor('__fixture.chatRequests.length === 1 && !document.getElementById("send").disabled', 'popup shortcut claimed and sent');
    const sent = await execute('({request:__fixture.chatRequests[0].body,draft:document.getElementById("prompt").value,source:document.getElementById("source-text").textContent,queue:__fixture.session["queue:7"],claims:__fixture.calls.filter(item => item.type === "being:claim-shortcut")})');
    check('popup-shortcut-queue-sends-its-own-selection-once', sent.claims.length === 1 && sent.claims[0].id === popupShortcutItem.id && sent.request.message.includes(popupShortcutItem.prompt) && sent.request.message.includes(popupShortcutItem.selection.text) && !sent.request.message.includes(savedSelection.text) && !sent.request.message.includes(savedDraft));
    check('popup-shortcut-queue-keeps-existing-sidebar-draft-and-reference', sent.draft === savedDraft && sent.source === savedSelection.text && sent.queue.length === 1 && sent.queue[0].id === blockedItem.id);
    check('popup-shortcut-claimed-before-ime-still-sends-and-preserves-composition', sent.request.message.includes(popupShortcutItem.prompt) && sent.draft.endsWith('正在输入的中文') && sent.claims.length === 1);
    await execute('document.getElementById("prompt").dispatchEvent(new CompositionEvent("compositionend", {bubbles: true, data: "中文"}))');
    win.reload();
    await waitFor('window.__fixture && document.getElementById("prompt").value === ' + JSON.stringify(savedDraft) + ' && !document.getElementById("send").disabled', 'popup shortcut target reload');
    check('popup-shortcut-queue-reload-never-reposts-claimed-action', await execute('__fixture.chatRequests.length === 1 && __fixture.calls.filter(item => item.type === "being:claim-shortcut").length === 1 && __fixture.session["queue:7"].every(item => item.id !== ' + JSON.stringify(popupShortcutItem.id) + ')'));
    await execute('sessionStorage.removeItem("being-fixture-state")');
  }

  const progressState = state => 'document.querySelector("#being-progress .being-progress")?.dataset.state === ' + JSON.stringify(state);
  const pushLive = (index, type, data) => execute('__fixture.liveStreams[' + index + '].push(' + JSON.stringify(type) + ', ' + JSON.stringify(data) + ')');
  const activeProgressAnimation = 'Array.from(document.querySelectorAll(".being-progress-motion i"), node => getComputedStyle(node).animationName).some(name => name !== "none")';
  const noProgressAnimation = 'Array.from(document.querySelectorAll(".being-progress-motion i"), node => getComputedStyle(node).animationName).every(name => name === "none")';

  async function verifyStreamingActivity(surface) {
    const floating = surface === 'floating';
    const prefix = surface + '-streaming';
    await load(floating ? 'floating.html?id=260bf34c-cc74-4a96-9678-fc16c119029f&progress=1' : 'sidepanel.html', floating ? 408 : 400, floating ? 520 : 850);
    if (!floating) {
      await waitFor('!document.getElementById("send").disabled && document.getElementById("connection-label").textContent.includes("loom.fixture.example")', prefix + ' configured');
      await execute('__fixture.streamPlan = [{method:"POST",defer:true}]');
      await setInput('prompt', '这段内容的核心是什么？请结合资料说明。');
      await click('send');
    }
    await waitFor('__fixture.liveStreams?.length === 1 && typeof __fixture.liveStreams[0].release === "function"', prefix + ' waiting for response headers');
    check(prefix + '-shows-live-state-before-response-arrives', await execute('document.querySelector("#being-progress .being-progress")?.dataset.active === "true" && !document.getElementById("stop").hidden && document.querySelectorAll(".message.being").length === 0 && ' + activeProgressAnimation));
    const progressLogo = await execute('(async () => {const image = document.querySelector(".being-progress-logo"); await image.decode(); return {currentSrc: image.currentSrc, srcset: image.getAttribute("srcset"), sizes: image.getAttribute("sizes"), loaded: image.complete && image.naturalWidth > 0};})()');
    check(prefix + '-loads-source-png-progress-logo', sourcePngLogo(progressLogo) && progressLogo.sizes === '19px', progressLogo);
    check(prefix + '-uses-read-only-baseline-and-one-post', await execute('__fixture.chatRequests.length === 1 && __fixture.requests.filter(item => item.url.includes("/api/history")).length === 1 && __fixture.requests.filter(item => item.url.includes("/api/stream/active")).length === 1'));
    await execute('__fixture.liveStreams[0].release()');
    await waitFor('typeof __fixture.liveStreams[0].push === "function"', prefix + ' response stream open');
    await pushLive(0, 'meta', {session_id: 'fixture-session-1'});
    await pushLive(0, 'thinking', {text: '先梳理这段内容的核心观点。'});
    await waitFor(progressState('thinking') + ' && document.querySelector(".being-process-content")?.textContent.includes("核心观点")', prefix + ' first thinking chunk');
    check(prefix + '-thinking-arrives-without-answer-or-finish', await execute('document.querySelectorAll(".message.being").length === 0 && !__fixture.liveStreams[0].closed && !document.querySelector(".being-process").open && document.querySelector(".being-progress-status").textContent === "Being 在思考" && ' + activeProgressAnimation));
    await trustedClick('.being-process-summary');
    await pushLive(0, 'reasoning', {delta: {text: '\n再核对相关资料，区分事实与推断。'}});
    await waitFor('document.querySelector(".being-process-content")?.textContent.includes("事实与推断")', prefix + ' incremental reasoning');
    check(prefix + '-streams-process-text-into-user-opened-disclosure', await execute('document.querySelector(".being-process").open && document.querySelector(".being-process-content").textContent === "先梳理这段内容的核心观点。\\n再核对相关资料，区分事实与推断。"'));
    if (floating) await screenshot('23-floating-thinking');
    await pushLive(0, 'tool_use', {id: 'lookup-1', name: 'web_search', input: {query: '上下文连续性与阅读效率'}});
    await waitFor(progressState('acting') + ' && document.querySelector(".being-process-item[data-kind=tool][data-status=running]")', prefix + ' action running');
    check(prefix + '-tool-use-shows-animated-action', await execute('document.querySelector(".being-progress-status").textContent === "Being 在行动" && document.querySelector(".being-process-item[data-kind=thinking]").dataset.status === "complete" && document.querySelector(".being-process-item[data-kind=tool]").textContent.includes("上下文连续性") && ' + activeProgressAnimation));
    if (floating) await screenshot('24-floating-action');
    await pushLive(0, 'tool_result', {tool_use_id: 'lookup-1', name: 'web_search', is_error: false, result: '已找到两项相关资料。'});
    await waitFor('document.querySelector(".being-process-item[data-kind=tool]")?.dataset.status === "complete"', prefix + ' action completed');
    check(prefix + '-tool-result-shows-success-and-result', await execute('document.querySelector(".being-process-item[data-kind=tool]").textContent.includes("完成") && document.querySelector(".being-process-item[data-kind=tool]").textContent.includes("两项相关资料")'));
    await pushLive(0, 'tool_use', {id: 'lookup-2', name: 'browse_web', input: {url: 'https://article.example/unavailable'}});
    await pushLive(0, 'tool_result', {tool_use_id: 'lookup-2', name: 'browse_web', is_error: true, result: '该页面暂时无法读取。'});
    await waitFor('document.querySelector(".being-process-item[data-kind=tool][data-status=error]")', prefix + ' failed action result');
    check(prefix + '-tool-result-distinguishes-failure-without-ending-turn', await execute('document.querySelector(".being-process-item[data-status=error]").textContent.includes("未完成") && document.querySelector(".being-progress").dataset.active === "true" && document.getElementById("send").disabled'));
    await pushLive(0, 'content_block_delta', {delta: {text: '核心是保留上下文，'}});
    await waitFor(progressState('replying') + ' && document.querySelector(".message.being .message-content")?.textContent === "核心是保留上下文，"', prefix + ' first answer chunk');
    check(prefix + '-renders-first-answer-before-later-chunks-or-finish', await execute('document.querySelector(".message.being .message-content").classList.contains("is-streaming") && !__fixture.liveStreams[0].closed && document.getElementById("send").disabled'));
    await pushLive(0, 'content_block_delta', {delta: {text: '让问题自然延续。'}});
    await waitFor('document.querySelector(".message.being .message-content")?.textContent === "核心是保留上下文，让问题自然延续。"', prefix + ' appended answer chunk');
    check(prefix + '-appends-answer-without-duplicating-message', await execute('document.querySelectorAll(".message.being").length === 1 && __fixture.chatRequests.length === 1'));
    if (floating) {
      await screenshot('25-floating-streaming-answer');
      win.setContentSize(300, 520);
      await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      check(prefix + '-expanded-process-and-live-answer-fit-300px', await execute('document.documentElement.scrollWidth <= innerWidth && document.querySelector(".being-progress").getBoundingClientRect().right <= innerWidth && document.getElementById("send").getBoundingClientRect().right <= innerWidth'));
      await screenshot('26-floating-streaming-narrow');
      win.setContentSize(408, 520);
    }
    win.webContents.debugger.attach('1.3');
    try {
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
      await waitFor('matchMedia("(prefers-reduced-motion: reduce)").matches', prefix + ' reduced motion');
      check(prefix + '-reduced-motion-disables-indicator-and-cursor-animations', await execute(noProgressAnimation + ' && getComputedStyle(document.querySelector(".message-content.is-streaming"), "::after").animationName === "none" && document.querySelector(".being-progress-status").textContent === "Being 在回复"'));
    } finally {
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features: []});
      win.webContents.debugger.detach();
    }
    await pushLive(0, 'message_stop', {session_id: 'fixture-session-1'});
    await waitFor('document.querySelectorAll(".message-content.is-streaming").length === 0', prefix + ' message stop removes cursor');
    check(prefix + '-message-stop-keeps-stream-lock-until-eof', await execute('document.getElementById("send").disabled && !__fixture.liveStreams[0].closed'));
    await execute('__fixture.liveStreams[0].close()');
    await waitFor(progressState('complete') + ' && !document.getElementById("send").disabled', prefix + ' finished');
    check(prefix + '-completion-stops-animation-and-collapses-process', await execute('document.querySelector(".being-progress").dataset.active === "false" && !document.querySelector(".being-process").open && document.querySelectorAll(".message-content.is-streaming").length === 0 && ' + noProgressAnimation));
    if (floating) await screenshot('27-floating-streaming-complete');
    await execute('__fixture.streamPlan = [{method:"POST"}]');
    await setInput('prompt', '再补充一个例子。');
    await click('send');
    await waitFor('__fixture.liveStreams?.length === 2 && typeof __fixture.liveStreams[1].push === "function"', prefix + ' second controlled answer');
    await pushLive(1, 'thinking', {text: '从写作场景举例。'});
    await pushLive(1, 'content_block_delta', {delta: {text: '写作时，可以先保留这条观点。'}});
    await waitFor('document.querySelectorAll(".message.being").length === 2 && document.querySelectorAll(".message.being .message-content")[1].textContent.includes("保留这条观点")', prefix + ' stoppable partial answer');
    await click('stop');
    await waitFor(progressState('stopped') + ' && !document.getElementById("send").disabled', prefix + ' stopped');
    check(prefix + '-stop-keeps-partial-text-and-removes-all-live-effects', await execute('__fixture.liveStreams[1].aborted && document.querySelectorAll(".message.being .message-content")[1].textContent === "写作时，可以先保留这条观点。" && document.querySelector(".being-progress").dataset.active === "false" && document.querySelectorAll(".message-content.is-streaming").length === 0 && ' + noProgressAnimation));
  }

  async function verifyAcceptedReplyRecovery() {
    await load('sidepanel.html', 400, 850);
    await waitFor('!document.getElementById("send").disabled && document.getElementById("connection-label").textContent.includes("loom.fixture.example")', 'accepted reply configured');
    await execute('__fixture.recoveryMode = true; __fixture.streamPlan = [{method:"POST",status:202,body:{spliced:true}}]');
    await setInput('prompt', '这条已接收的消息也需要自动显示回复。');
    await click('send');
    await waitFor('__fixture.activeReads?.length === 1', 'accepted reply read-only followup');
    check('accepted-reply-remains-active-without-second-post', await execute('__fixture.chatRequests.length === 1 && document.getElementById("send").disabled && document.querySelector(".being-progress").dataset.active === "true" && document.querySelector(".being-progress").dataset.state === "waiting" && document.querySelector(".being-progress-status").textContent === "等待 Being" && document.querySelectorAll(".message.being").length === 0 && ' + activeProgressAnimation));
    const release = (index, events, nextSeq, finished = false) => execute('__fixture.activeReads[' + index + '].release(' + JSON.stringify({stream_id: 'fixture-recovered-stream', finished, next_seq: nextSeq, events}) + ')');
    await release(0, [{seq: 1, event: 'thinking', data: {text: '消息已接收，正在接续处理。'}}], 2);
    await waitFor(progressState('thinking') + ' && document.querySelector(".being-process-content")?.textContent.includes("接续处理")', 'accepted reply thinking replay');
    check('accepted-reply-replays-thinking-via-get', await execute('__fixture.chatRequests.length === 1 && document.querySelectorAll(".message.being").length === 0 && ' + activeProgressAnimation));
    await waitFor('__fixture.activeReads.length === 2', 'accepted reply next cursor read');
    await release(1, [{seq: 2, event: 'content_block_delta', data: {delta: {text: '已经接上回复，'}}}], 3);
    await waitFor('document.querySelector(".message.being .message-content")?.textContent === "已经接上回复，"', 'accepted reply first answer delta');
    check('accepted-reply-streams-partial-before-completion', await execute('document.getElementById("send").disabled && document.querySelector(".message-content.is-streaming") && __fixture.chatRequests.length === 1'));
    await waitFor('__fixture.activeReads.length === 3', 'accepted reply final cursor read');
    await release(2, [{seq: 3, event: 'content_block_delta', data: {delta: {text: '无需再次发送。'}}}, {seq: 4, event: 'message_stop', data: {session_id: 'fixture-session-recovered'}}], 5, true);
    await waitFor(progressState('complete') + ' && !document.getElementById("send").disabled', 'accepted reply recovered completion');
    check('accepted-reply-completes-with-single-post-and-monotonic-get-cursor', await execute('__fixture.chatRequests.length === 1 && __fixture.activeReads.length === 3 && __fixture.activeReads[0].after === 0 && __fixture.activeReads[1].after > 0 && __fixture.activeReads[2].after > __fixture.activeReads[1].after && document.querySelectorAll(".message.being").length === 1 && document.querySelector(".message.being .message-content").textContent === "已经接上回复，无需再次发送。" && document.querySelectorAll(".message-content.is-streaming").length === 0 && ' + noProgressAnimation));
    check('accepted-reply-checks-own-user-message-in-history', await execute('__fixture.requests.filter(item => item.url.includes("/api/history")).length >= 2 && !document.getElementById("transcript").textContent.includes("我们聊到了")'));
    await screenshot('28-sidebar-accepted-reply');
  }

  async function verifyOptions() {
    await load('options.html', 860, 1050);
    await waitFor('document.getElementById("result").textContent.includes("已保存")', 'saved settings');
    check('settings-do-not-echo-saved-token', await execute('!document.body.innerText.includes("fixture-only-token") && document.getElementById("loom-url").value === "" && document.getElementById("loom-url").type === "password"'));
    check('settings-no-horizontal-overflow', await execute('document.documentElement.scrollWidth <= innerWidth'));
    await verifyFlatTheme('settings');
    await setInput('loom-url', 'http://remote.example/loom?token=invalid'); await click('connect');
    check('settings-reject-insecure-remote-address', await execute('!document.getElementById("error").hidden && __fixture.requests.length === 0 && !__fixture.calls.some(item => item.type === "permission.request")'));
    await setInput('loom-url', 'https://loom.fixture.example/loom/Being?token=fixture-replacement-token'); await click('connect');
    await waitFor('document.getElementById("result").textContent.startsWith("已连接")', 'settings verification');
    check('settings-save-requires-configured-origin-permission', await execute('__fixture.calls.some(item => item.type === "permission.request" && item.origins.length === 1 && item.origins[0] === "https://loom.fixture.example/*")'));
    check('settings-verify-before-saving', await execute('__fixture.requests.length === 1 && __fixture.requests[0].url.includes("/api/status") && __fixture.local.connection.url.includes("fixture-replacement-token")'));
    check('settings-clears-credential-input-after-save', await execute('document.getElementById("loom-url").value === "" && !document.body.innerText.includes("fixture-replacement-token")'));
    await screenshot('06-settings-connected');
    await execute('chrome.storage.session.set({"chat:7":{messages:[{content:"Private chat"}]},"composer:7":{prompt:"Unsaved draft"}})');
    await click('disconnect');
    await waitFor('document.getElementById("result").textContent.startsWith("已断开")', 'settings disconnect');
    check('settings-disconnect-removes-credentials-and-chat', await execute('__fixture.local.connection === undefined && __fixture.session["chat:7"] === undefined'));
    check('settings-disconnect-preserves-unsent-draft', await execute('__fixture.session["composer:7"].prompt === "Unsaved draft"'));
    check('settings-disconnect-removes-host-permission', await execute('__fixture.calls.some(item => item.type === "permission.remove")'));
    await screenshot('07-settings-disconnected');
  }

  async function verifyBootstrapRace() {
    await load('sidepanel.html?race=1', 400, 850);
    await waitFor('document.getElementById("source-text").textContent === "并发到达的新选区"', 'latest queue during initialization');
    check('sidebar-prefers-new-queue-event-to-stale-initial-read', await execute('document.getElementById("source-text").textContent === "并发到达的新选区"'));
    check('sidebar-prefers-new-connection-event-to-stale-initial-read', await execute('document.getElementById("connection-label").textContent.startsWith("Latest")'));
    await waitFor('(__fixture.session["queue:7"] || []).length === 0', 'race queue consumption');
    check('sidebar-consumes-racing-context-once', await execute('__fixture.calls.filter(item => item.type === "being:consume").length === 1'));
  }

  async function verifyFloatingConversation() {
    const floatingId = '810ba016-a416-4010-8739-88cc0a5aff2d';
    const page = 'floating.html?id=' + floatingId + '&persist=1';
    await load(page, 408, 520);
    await waitFor('__fixture.chatRequests.length === 1 && !document.getElementById("send").disabled && document.querySelectorAll(".message.being").length === 1', 'floating automatic first answer');
    check('floating-first-question-sends-automatically-once', await execute('__fixture.chatRequests.length === 1 && __fixture.chatRequests[0].body.message.includes(__fixture.captured.text)'));
    check('floating-answer-uses-existing-conversation-ui', await execute('!document.getElementById("transfer").hidden && document.documentElement.scrollWidth <= innerWidth'));
    await verifyFlatTheme('floating');
    await screenshot('08-floating-answer');
    await setInput('prompt', '举个与写作相关的例子。'); await click('send');
    await waitFor('__fixture.chatRequests.length === 2 && !document.getElementById("send").disabled', 'floating followup answer');
    check('floating-followup-preserves-session', await execute('__fixture.chatRequests[1].body.session_id === "fixture-session-1" && !__fixture.chatRequests[1].body.message.includes(__fixture.captured.text)'));
    win.reload();
    await waitFor('window.__fixture && document.querySelectorAll(".message.being").length === 2 && !document.getElementById("send").disabled', 'restored floating conversation');
    check('floating-reload-does-not-post-original-question-again', await execute('__fixture.chatRequests.length === 2 && __fixture.calls.filter(item => item.type === "being:float-context").length === 2'));
    check('floating-reload-preserves-transcript', await execute('document.querySelectorAll(".message.user").length === 2'));
    await execute('__fixture.holdNext = true'); await setInput('prompt', '继续写下去。'); await click('send');
    await waitFor('__fixture.chatRequests.length === 3 && !document.getElementById("stop").hidden', 'floating active stream');
    check('floating-transfer-disabled-during-response', await execute('document.getElementById("transfer").disabled'));
    await click('stop'); await waitFor('!document.getElementById("send").disabled', 'floating stream stopped');
    await setInput('prompt', '保留这个还没发送的追问');
    await click('transfer');
    await waitFor('(__fixture.session["handoff:7"] || []).length === 1', 'floating session transfer');
    const transferred = await execute('structuredClone(__fixture.session["handoff:7"][0])');
    check('floating-transfer-carries-session-messages-and-draft', transferred.sessionId === 'fixture-session-1' && transferred.messages.length >= 6 && transferred.composer.prompt === '保留这个还没发送的追问');
    check('floating-transfer-does-not-post-again', await execute('__fixture.chatRequests.length === 3 && !__fixture.calls.some(item => item.type === "being:stage")'));
    win.setContentSize(280, 440);
    await execute('new Promise(resolve => requestAnimationFrame(resolve))');
    check('floating-narrow-layout', await execute('document.documentElement.scrollWidth <= innerWidth && document.getElementById("send").getBoundingClientRect().right <= innerWidth'));
    await screenshot('09-floating-narrow');
    win.reload();
    await waitFor('window.__fixture && document.getElementById("activity").textContent.includes("已移到侧栏") && document.getElementById("send").disabled', 'moved floating frame reload');
    check('floating-transferred-frame-cannot-resend-after-reload', await execute('__fixture.chatRequests.length === 3 && document.getElementById("prompt").disabled && document.getElementById("transfer").disabled'));
    await execute('sessionStorage.removeItem("being-fixture-state")');
    await load('sidepanel.html?persist=1', 400, 850);
    await waitFor('document.getElementById("connection-label").textContent.includes("loom.fixture.example")', 'sidebar transfer target');
    await execute('chrome.storage.session.set({"handoff:7":[' + JSON.stringify(transferred) + ']})');
    await waitFor('document.getElementById("prompt").value === "保留这个还没发送的追问" && (__fixture.session["handoff:7"] || []).length === 0', 'sidebar adopts floating conversation');
    check('sidebar-handoff-restores-transcript-without-reposting', await execute('document.querySelectorAll(".message.user").length === 3 && __fixture.chatRequests.length === 0'));
    await click('send');
    await waitFor('__fixture.chatRequests.length === 1 && !document.getElementById("send").disabled', 'sidebar continues transferred conversation');
    check('sidebar-handoff-followup-uses-floating-session', await execute('__fixture.chatRequests[0].body.session_id === "fixture-session-1" && !__fixture.chatRequests[0].body.message.includes(__fixture.captured.text)'));
    await screenshot('10-sidebar-transferred-conversation');
    win.reload();
    await waitFor('window.__fixture && document.querySelectorAll(".message.user").length === 4 && !document.getElementById("send").disabled', 'restored sidebar transferred conversation');
    check('sidebar-handoff-reload-does-not-restore-consumed-draft', await execute('__fixture.chatRequests.length === 1 && document.getElementById("prompt").value === "" && (__fixture.session["handoff:7"] || []).length === 0'));
    await setInput('prompt', '已有侧栏草稿');
    const pending = {...transferred, id: 'pending-fixture-handoff'};
    await execute('chrome.storage.session.set({"handoff:7":[' + JSON.stringify(pending) + ']})');
    await waitFor('!document.getElementById("incoming").hidden', 'pending handoff notice');
    check('sidebar-handoff-keeps-existing-draft', await execute('document.getElementById("prompt").value === "已有侧栏草稿" && __fixture.session["handoff:7"].length === 1'));
    await setInput('prompt', ''); await click('incoming');
    await waitFor('(__fixture.session["handoff:7"] || []).length === 0', 'explicit pending handoff adoption');
    check('sidebar-pending-handoff-does-not-resend', await execute('__fixture.chatRequests.length === 1'));
  }

  async function verifyFloatingWindow() {
    await load('article-fixture.html', 1100, 780);
    await waitFor('__fixture.messageListeners.length === 1', 'content script registration');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled: true});
    const find = (node, className, remaining) => {
      const attributes = Object.fromEntries(Array.from({length: (node.attributes || []).length / 2}, (_, i) => [node.attributes[i * 2], node.attributes[i * 2 + 1]]));
      if (attributes.class?.split(' ').includes(className) && remaining.value-- === 0) return node;
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {const found = find(child, className, remaining); if (found) return found;}
      return null;
    };
    const node = async (className, index = 0) => {
      const {root: dom} = await win.webContents.debugger.sendCommand('DOM.getDocument', {depth: -1, pierce: true});
      const found = find(dom, className, {value: index}); assert(found, 'Missing floating ' + className); return found;
    };
    const box = async (className, index = 0) => {
      const found = await node(className, index);
      try {return (await win.webContents.debugger.sendCommand('DOM.getBoxModel', {nodeId: found.nodeId})).model;} catch (error) {throw new Error('Floating box ' + className + ': ' + error.message);}
    };
    const inside = async (className, width, height) => {
      const model = await box(className);
      return model.border[0] >= 0 && model.border[1] >= 0 && model.border[4] <= width && model.border[5] <= height;
    };
    const inspect = async (className, expression) => {
      const found = await node(className);
      const resolved = await win.webContents.debugger.sendCommand('DOM.resolveNode', {nodeId: found.nodeId});
      const {result} = await win.webContents.debugger.sendCommand('Runtime.callFunctionOn', {objectId: resolved.object.objectId, functionDeclaration: 'function() { return ' + expression + '; }', returnByValue: true, awaitPromise: true});
      return result.value;
    };
    const press = async (className, index = 0) => {
      const model = await box(className, index);
      const x = Math.round((model.content[0] + model.content[2]) / 2), y = Math.round((model.content[1] + model.content[5]) / 2);
      win.webContents.sendInputEvent({type: 'mouseDown', x, y, button: 'left', clickCount: 1});
      win.webContents.sendInputEvent({type: 'mouseUp', x, y, button: 'left', clickCount: 1});
      await execute('new Promise(resolve => requestAnimationFrame(resolve))');
    };
    const selectParagraph = async index => {
      const point = await execute('(() => {const rect = document.querySelector("main p:nth-of-type(' + index + ')").getBoundingClientRect(); return {x: Math.round(rect.left + 10), y: Math.round(rect.top + 10)};})()');
      win.webContents.sendInputEvent({type: 'mouseDown', ...point, button: 'left', clickCount: 1});
      win.webContents.sendInputEvent({type: 'mouseUp', ...point, button: 'left', clickCount: 1});
      await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const selected = await execute('(() => {document.activeElement?.blur(); const paragraph = document.querySelector("main p:nth-of-type(' + index + ')"); const range = document.createRange(); range.selectNodeContents(paragraph); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); const rect = paragraph.getBoundingClientRect(); return {text: paragraph.textContent, x: Math.round(rect.left + 10), y: Math.round(rect.top + 10)};})()');
      win.webContents.sendInputEvent({type: 'mouseUp', x: selected.x, y: selected.y, button: 'left', clickCount: 1});
      await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      (report.selectionProbes ||= []).push({paragraph: index, ...await inspect('panel', '({hidden:this.hidden,className:this.className,active:this.getRootNode().activeElement?.tagName,pageActive:document.activeElement?.tagName,pageSelection:getSelection()?.toString()})')});
      return selected.text;
    };
    const draft = value => inspect('composer', '(() => {const input = this.querySelector("textarea"); input.focus(); input.value = ' + JSON.stringify(value) + '; input.dispatchEvent(new Event("input", {bubbles: true})); return input.value;})()');
    try {
      await execute('(() => {const range = document.createRange(); range.selectNodeContents(document.querySelector("main p:nth-of-type(2)")); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);})()');
      win.webContents.sendInputEvent({type: 'mouseUp', x: 540, y: 263, button: 'left', clickCount: 1});
      await waitFor('Boolean(document.querySelector("[data-being-anywhere]"))', 'automatic compact selection widget');
      await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      check('floating-window-mounts-with-isolated-shadow', await execute('document.querySelector("[data-being-anywhere]").shadowRoot === null'));
      const compact = await box('compact');
      check('floating-selection-automatically-shows-compact-question', compact.width <= 380 && compact.height <= 150);
      check('floating-compact-inside-viewport', await inside('compact', 1100, 780));
      check('floating-selection-preserves-page-focus', await execute('document.activeElement === document.body'));
      check('floating-window-does-not-contact-being-on-selection', await execute('__fixture.chatRequests.length === 0 && !__fixture.calls.some(item => ["being:stage","being:float"].includes(item.type))'));
      const compactLogo = await inspect('mark', '(async () => {const image = this.matches("img") ? this : this.querySelector("img"); if (!image) return {loaded: false}; await image.decode(); return {src: image.src, currentSrc: image.currentSrc, srcset: image.getAttribute("srcset"), sizes: image.getAttribute("sizes"), loaded: image.complete && image.naturalWidth > 0, background: getComputedStyle(image).backgroundColor};})()');
      const compactStyle = await inspect('panel', '({background:getComputedStyle(this).backgroundColor,color:getComputedStyle(this).color,shadow:getComputedStyle(this).boxShadow,buttonBackground:getComputedStyle(this.querySelector(".submit")).backgroundColor,buttonColor:getComputedStyle(this.querySelector(".submit")).color})');
      check('floating-compact-uses-flat-monochrome-ui-and-loaded-original-logo', sourcePngLogo(compactLogo) && compactLogo.background === 'rgba(0, 0, 0, 0)' && compactStyle.shadow === 'none' && [compactStyle.background, compactStyle.color, compactStyle.buttonBackground, compactStyle.buttonColor].every(grayscale), {logo: compactLogo, styles: compactStyle});
      await screenshot('11-selection-compact-question');
      win.setContentSize(300, 550);
      await execute('new Promise(resolve => requestAnimationFrame(resolve))');
      check('floating-compact-narrow-viewport', await inside('compact', 300, 550));
      await screenshot('12-selection-compact-narrow');
      win.setContentSize(1100, 780);
      await execute('new Promise(resolve => requestAnimationFrame(resolve))');
      check('floating-compact-panel-and-input-hide-scrollbars', await inspect('panel', 'getComputedStyle(this).overflowY === "hidden" && getComputedStyle(this.querySelector("textarea")).overflowY === "hidden" && getComputedStyle(this.querySelector("textarea")).scrollbarWidth === "none"'));
      await execute('__fixture.holdNextFloat = true');
      await press('chip', 0);
      await waitFor('__fixture.calls.filter(item => item.type === "being:float").length === 1', 'trusted explain shortcut');
      check('floating-explain-shortcut-expands-before-context-response', (await box('expanded')).height > 300 && await execute('__fixture.chatRequests.length === 0 && typeof __fixture.releaseFloat === "function"'));
      check('floating-explain-shortcut-does-not-fill-input', await inspect('composer', 'this.querySelector("textarea").value === ""'));
      check('floating-trusted-submit-saves-selection-and-question', await execute('__fixture.calls.some(item => item.type === "being:float" && item.selection.text === __fixture.captured.text && item.prompt === "请用通俗易懂的语言解释这段内容。")'));
      check('floating-submit-expands-without-opening-side-panel', await execute('!__fixture.calls.some(item => ["being:stage", "panel.open"].includes(item.type))'));
      await screenshot('13-selection-quick-action-loading');
      await execute('__fixture.releaseFloat()');
      await waitFor('__fixture.chatRequests.length === 1', 'embedded floating reply');
      check('floating-explain-shortcut-sends-exactly-once', await execute('__fixture.calls.filter(item => item.type === "being:float").length === 1 && __fixture.chatRequests.length === 1 && __fixture.chatRequests[0].body.message.includes("请用通俗易懂的语言解释这段内容。") && __fixture.chatRequests[0].body.message.includes(__fixture.captured.text)'));
      check('floating-expanded-inside-viewport', await inside('expanded', 1100, 780));
      const iframe = await node('conversation-frame');
      const attributes = Object.fromEntries(Array.from({length: (iframe.attributes || []).length / 2}, (_, i) => [iframe.attributes[i * 2], iframe.attributes[i * 2 + 1]]));
      check('floating-dialog-uses-trusted-extension-frame', attributes.src.startsWith('being-fixture://extension/floating.html?id=') && !attributes.src.includes('token='));
      await screenshot('14-selection-expanded-conversation');
      win.setContentSize(300, 550);
      await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      check('floating-expanded-narrow-viewport', await inside('expanded', 300, 550));
      await screenshot('15-selection-expanded-narrow');
      const currentFloatId = await execute('__fixture.calls.find(item => item.type === "being:float-context").id');
      await execute('dispatchEvent(new MessageEvent("message", {source: window, origin: location.origin, data: {type: "being:float-dismiss", id: ' + JSON.stringify(currentFloatId) + '}}))');
      check('floating-ignores-webpage-dismiss-spoof', !(await inspect('expanded', 'this.hidden')));
      await press('minimize');
      check('floating-minimize-retains-mounted-conversation', (await box('minimized')).height < 100 && await execute('__fixture.chatRequests.length === 1'));
      await press('minimize');
      check('floating-restore-does-not-repost', (await box('expanded')).height > 300 && await execute('__fixture.chatRequests.length === 1'));
      await press('chat-close');
      check('floating-close-hides-dialog', await inspect('panel', 'this.hidden'));
      win.setContentSize(1100, 780);
      const summarySelection = await selectParagraph(3);
      check('floating-new-selection-after-close-shows-compact-question', !(await inspect('compact', 'this.hidden')) && (await box('compact')).height < 150);
      await screenshot('16-selection-new-question');
      const drafted = '我还没发出的自定义问题，请为我保留。';
      await draft(drafted);
      await execute('__fixture.failNextFloat = true');
      await press('chip', 1);
      report.retryProbe = await inspect('panel', '({hidden:this.hidden,className:this.className,active:this.getRootNode().activeElement?.tagName,error:this.querySelector(".error").textContent,prompt:this.querySelector("textarea").value})');
      check('floating-failed-open-restores-question-draft', (await box('compact')).height < 180 && await inspect('composer', 'this.querySelector("textarea").value') === drafted);
      check('floating-failed-open-does-not-expose-internal-error', !(await inspect('error', 'this.hidden')) && !(await inspect('error', 'this.textContent')).includes('SHOULD_STAY_PRIVATE'));
      check('floating-failed-open-does-not-contact-model', await execute('__fixture.chatRequests.length === 1'));
      await screenshot('17-selection-retry-question');
      await press('chip', 1);
      await waitFor('__fixture.chatRequests.length === 2', 'summary shortcut retry');
      const summaries = await execute('__fixture.calls.filter(item => item.type === "being:float").slice(1)');
      check('floating-summary-shortcut-retry-preserves-selection-and-sends-once', summaries.length === 2 && summaries.every(item => item.prompt === '请总结这段内容，提炼关键观点。' && item.selection.text === summarySelection) && await execute('__fixture.chatRequests[1].body.message.includes("请总结这段内容，提炼关键观点。")'));
      check('floating-summary-shortcut-does-not-overwrite-existing-draft', await inspect('composer', 'this.querySelector("textarea").value') === drafted);
      await screenshot('18-selection-summary-direct');
      await press('chat-close');
      const translationSelection = await selectParagraph(4);
      const translationDraft = '我的英文草稿还没发送。';
      await draft(translationDraft);
      await inspect('composer', 'this.querySelector("textarea").dispatchEvent(new CompositionEvent("compositionstart", {bubbles: true, data: "zhong"}))');
      await press('submit');
      check('floating-manual-send-does-not-submit-unfinished-composition', await execute('__fixture.chatRequests.length === 2') && (await box('compact')).height < 150);
      await press('chip', 2);
      await waitFor('__fixture.chatRequests.length === 3', 'translation shortcut');
      check('floating-shortcut-sends-while-draft-composition-is-active', await inspect('composer', 'this.querySelector("textarea").value') === translationDraft);
      await inspect('composer', 'this.querySelector("textarea").dispatchEvent(new CompositionEvent("compositionend", {bubbles: true, data: "中"}))');
      const translated = await execute('__fixture.calls.filter(item => item.type === "being:float")');
      check('floating-translate-shortcut-sends-preset-and-selection-once', translated.length === 4 && translated[3].prompt === '请将这段内容翻译成简体中文；如果原文已是中文，请翻译成英文。' && translated[3].selection.text === translationSelection && await execute('__fixture.chatRequests[2].body.message.includes("请将这段内容翻译成简体中文")'));
      check('floating-translate-shortcut-does-not-overwrite-existing-draft', await inspect('composer', 'this.querySelector("textarea").value') === translationDraft);
      check('floating-translate-shortcut-expands-into-conversation', (await box('expanded')).height > 300);
      await press('chat-close');
      const longSelection = await selectParagraph(3);
      const longDraft = '请结合这段内容，解释阅读、工具和思考之间的关系，并举例说明如何在工作中延续对话。'.repeat(28) + '\n最后一段也需要完整发送：END-OF-DRAFT。';
      await press('prompt-field');
      await draft(longDraft);
      win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Tab'});
      win.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Tab'});
      await execute('new Promise(resolve => requestAnimationFrame(resolve))');
      report.previewFocusProbe = await inspect('composer', '({active:this.getRootNode().activeElement?.outerHTML,documentFocus:document.hasFocus(),readonly:this.querySelector("textarea").readOnly,disabled:this.querySelector(".chip").disabled,previewHidden:this.querySelector(".prompt-preview").hidden})');
      const preview = await inspect('prompt-field', '({hasPreview:this.classList.contains("has-preview"),hidden:this.querySelector(".prompt-preview").hidden,text:this.querySelector(".prompt-preview").textContent,value:this.querySelector("textarea").value,clamp:getComputedStyle(this.querySelector(".prompt-preview")).webkitLineClamp,overflow:getComputedStyle(this.querySelector(".prompt-preview")).overflowY,height:this.querySelector(".prompt-preview").clientHeight,scrollHeight:this.querySelector(".prompt-preview").scrollHeight,inputOverflow:getComputedStyle(this.querySelector("textarea")).overflowY})');
      await screenshot('19-selection-long-draft-preview');
      check('floating-long-draft-blur-shows-two-line-ellipsis-preview', preview.hasPreview && !preview.hidden && preview.clamp === '2' && preview.overflow === 'hidden' && preview.height <= 38 && preview.scrollHeight > preview.height, {hasPreview: preview.hasPreview, hidden: preview.hidden, clamp: preview.clamp, overflow: preview.overflow, height: preview.height, scrollHeight: preview.scrollHeight});
      check('floating-long-draft-preview-keeps-complete-input-without-scrollbar', preview.text === longDraft && preview.value === longDraft && preview.inputOverflow === 'hidden' && (await box('compact')).height < 150);
      await press('prompt-field');
      check('floating-long-draft-focus-restores-editable-input', await inspect('prompt-field', 'this.querySelector(".prompt-preview").hidden && !this.classList.contains("has-preview") && this.getRootNode().activeElement === this.querySelector("textarea") && !this.querySelector("textarea").readOnly'));
      await execute('__fixture.failNextFloat = true');
      await press('submit');
      check('floating-long-draft-failed-submit-preserves-complete-input', !(await inspect('compact', 'this.hidden')) && await inspect('composer', 'this.querySelector("textarea").value') === longDraft && await execute('__fixture.chatRequests.length === 3'));
      await press('submit');
      await waitFor('__fixture.chatRequests.length === 4', 'complete long question retry');
      const longCalls = await execute('__fixture.calls.filter(item => item.type === "being:float").slice(4)');
      check('floating-long-draft-submit-sends-complete-text-and-selection', longCalls.length === 2 && longCalls.every(item => item.prompt === longDraft && item.selection.text === longSelection) && await execute('__fixture.chatRequests[3].body.message.includes(' + JSON.stringify(longDraft) + ')'));
      check('floating-long-draft-continues-in-expanded-chat-without-extra-request', (await box('expanded')).height > 300 && await execute('__fixture.chatRequests.length === 4'));
      await screenshot('20-selection-long-draft-conversation');
      await press('chat-close');
      const nativeSelection = await selectParagraph(4);
      await press('prompt-field');
      const nativeQuestion = '这段话为什么重要？';
      await win.webContents.insertText(nativeQuestion);
      await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      check('floating-real-input-click-and-typing-keeps-question-open', !(await inspect('compact', 'this.hidden')) && await inspect('composer', 'this.querySelector("textarea").value') === nativeQuestion);
      const highlight = await execute('(() => {const entry = Array.from(CSS.highlights.entries()).find(([name]) => name.startsWith("being-anywhere-selection-")); if (!entry) return null; const range = Array.from(entry[1])[0]; const element = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement; const style = getComputedStyle(element, "::highlight(" + entry[0] + ")"); return {text:range.toString(),rects:Array.from(range.getClientRects(), rect => ({width:rect.width,height:rect.height})),background:style.backgroundColor,connected:range.commonAncestorContainer.isConnected,nativeSelection:getSelection()?.toString()};})()');
      check('floating-input-focus-preserves-visible-source-highlight', highlight && highlight.text === nativeSelection && highlight.connected && highlight.rects.some(rect => rect.width > 0 && rect.height > 0) && highlight.background !== 'rgba(0, 0, 0, 0)', highlight);
      await screenshot('21-selection-preserved-while-typing');
      await press('submit');
      await waitFor('__fixture.chatRequests.length === 5', 'native typed question with original quote');
      const nativeSent = await execute('__fixture.calls.filter(item => item.type === "being:float").at(-1)');
      check('floating-native-typed-question-sends-original-selection', nativeSent.prompt === nativeQuestion && nativeSent.selection.text === nativeSelection && await execute('__fixture.chatRequests.at(-1).body.message.includes(' + JSON.stringify(nativeSelection) + ')'));
      await press('chat-close');
      check('floating-close-clears-preserved-source-highlight', await execute('!Array.from(CSS.highlights.keys()).some(name => name.startsWith("being-anywhere-selection-"))'));
      await execute('document.querySelector("main p:nth-of-type(2)").textContent = "https://github.com/acme/tool/blob/main/SKILL.md"');
      await selectParagraph(2);
      check('floating-selected-github-link-offers-install', await inspect('install-link', '!this.hidden'));
      const installCount = await execute('__fixture.calls.filter(item => item.type === "being:float").length');
      await press('install-link');
      await waitFor(`__fixture.calls.filter(item => item.type === 'being:float').length === ${installCount+1}`, 'compact install gesture');
      check('floating-install-sends-selected-url-once', await execute(`__fixture.calls.filter(item => item.type === 'being:float').at(-1).installLink === 'https://github.com/acme/tool/blob/main/SKILL.md'`));
    } finally {win.webContents.debugger.detach();}
  }

  async function run() {
    await fs.mkdir(runRoot, {recursive: true});
    await app.whenReady();
    process.on('warning', warning => {if (warning.name === 'ExtensionLoadWarning') report.platformWarnings.push(warning.message);});
    const manifestSession = electronSession.fromPartition(`persist:being-anywhere-manifest-${randomUUID()}`);
    manifestSession.webRequest.onBeforeRequest((details, callback) => callback({cancel: !details.url.startsWith('chrome-extension://')}));
    const loaded = await manifestSession.extensions.loadExtension(extensionRoot);
    check('electron-can-parse-extension-manifest', loaded.name === 'BeingAnywhere' && loaded.manifest.manifest_version === 3);
    report.manifestProbe = {name: loaded.name, version: loaded.version, note: 'Electron manifest parsing only; Electron does not implement Chrome sidePanel.'};
    manifestSession.extensions.removeExtension(loaded.id);
    const originDirectory = path.join(runRoot, 'origin-probe');
    await fs.mkdir(originDirectory, {recursive: true});
    await Promise.all([
      fs.writeFile(path.join(originDirectory, 'manifest.json'), JSON.stringify({manifest_version: 3, name: 'Being fixture origin probe', version: '1.0.0'})),
      fs.writeFile(path.join(originDirectory, 'probe.html'), '<!doctype html><html><head><title>Origin fixture</title></head><body></body></html>')
    ]);
    const originExtension = await manifestSession.extensions.loadExtension(originDirectory);
    const originProbe = new BrowserWindow({show: false, webPreferences: {session: manifestSession, sandbox: true, contextIsolation: true, nodeIntegration: false}});
    try {
      await originProbe.loadURL('chrome-extension://' + originExtension.id + '/probe.html');
      report.extensionOriginProbe = await originProbe.webContents.executeJavaScript('new Promise(resolve => {addEventListener("message", event => {if (event.data === "fixture-origin-probe") resolve({urlOrigin: new URL(location.href).origin, messageOrigin: event.origin});}, {once: true}); postMessage("fixture-origin-probe", "*");})');
      check('extension-message-origin-matches-url-origin', report.extensionOriginProbe.urlOrigin === report.extensionOriginProbe.messageOrigin, report.extensionOriginProbe);
    } finally {originProbe.destroy(); manifestSession.extensions.removeExtension(originExtension.id);}
    win = new BrowserWindow({show: false, frame: false, width: 400, height: 850, useContentSize: true, webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: `being-anywhere-${randomUUID()}`}});
    win.webContents.setFrameRate(30);
    win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    win.webContents.on('console-message', details => {if (details.level === 'error' || details.level === 'warning') report.consoleErrors.push(details.message);});
    win.webContents.session.protocol.handle('being-fixture', async request => {
      const name = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
      if (name === 'article-fixture.html') return new Response('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>阅读与思考 · 示例文章</title><script src="fixture-chrome.js"></script><link rel="stylesheet" href="article-fixture.css"></head><body><main><p class="kicker">READING NOTES / 2026</p><h1>让思考自然地延续</h1><p>真正有价值的工具，应该让思考自然地延续。</p><p>阅读不只是收集更多信息。它让我们在不同观点之间建立联系，逐步形成自己的判断。</p><p>当一句话引发好奇，我们可以停下来，问一个更具体的问题：它如何影响我现在正在做的事？</p><p>保留上下文，让对话从这里继续。</p></main><script src="content.js"></script></body></html>', {headers: {'Content-Type':'text/html', 'Content-Security-Policy':"script-src 'self'; object-src 'none'; base-uri 'none'"}});
      if (name === 'article-fixture.css') return new Response('body{margin:0;background:#f5f3ed;color:#343d35;font:18px/1.9 Georgia,"Microsoft YaHei",serif}main{max-width:740px;margin:86px auto}h1{font-size:38px;font-weight:500;letter-spacing:-1px;margin-bottom:26px}p{margin:0 0 23px}.kicker{font:11px/1.4 system-ui;letter-spacing:2.5px;color:#71826e}', {headers:{'Content-Type':'text/css'}});
      if (name === 'fixture-chrome.js') return new Response(`(${installFixture.toString()})(${JSON.stringify(loaded.version)})`, {headers: {'Content-Type': 'text/javascript'}});
      const file = path.resolve(extensionRoot, name);
      if (!file.startsWith(extensionRoot + path.sep)) return new Response('Not found', {status: 404});
      try {
        let content = await fs.readFile(file);
        if (path.extname(file) === '.html') content = Buffer.from(content.toString('utf8').replace('<head>', '<head><script src="fixture-chrome.js"></script>'));
        return new Response(content, {headers: {'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Content-Security-Policy': "script-src 'self'; object-src 'none'; base-uri 'none'"}});
      } catch {return new Response('Not found', {status: 404});}
    });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url.startsWith('being-fixture://extension/');
      if (!allowed) report.externalRequests.push(details.url);
      callback({cancel: !allowed});
    });
    await verifySidebar();
    await verifyInstallLinks('sidebar');
    await verifyInstallLinks('floating');
    await verifyPopup();
    await verifyPopupShortcutQueue();
    await verifyDirectChatShortcuts('sidebar');
    await verifyDirectChatShortcuts('floating');
    await verifyOptions();
    await verifyBootstrapRace();
    await verifyFloatingConversation();
    await verifyFloatingWindow();
    await verifyStreamingActivity('floating');
    await verifyStreamingActivity('sidebar');
    await verifyAcceptedReplyRecovery();
    check('fixture-no-external-requests', report.externalRequests.length === 0);
    check('fixture-no-renderer-errors', report.consoleErrors.length === 0, report.consoleErrors);
    report.passed = true;
  }
  run().catch(error => {report.passed = false; report.error = error.message;}).finally(async () => {
    await fs.mkdir(runRoot, {recursive: true});
    const reportPath = path.join(runRoot, 'report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({passed: report.passed, scope: report.scope, checks: report.checks.length, failed: report.checks.filter(item => !item.passed).map(item => item.name), report: reportPath, screenshots: report.screenshots, error: report.error || null}) + '\n');
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(report.passed ? 0 : 1);
  });
}
