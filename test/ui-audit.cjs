'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { runTownUiAudit } = require('./town-ui-audit.cjs');

const TRUSTED_URL = 'being://app/index.html';
const TOTAL_BUDGET_MS = 25000;

// These scripts only inspect the trusted shell or activate its layout controls.
// Never evaluate JavaScript in the remote Loom WebContentsView.
const SCRIPTS = Object.freeze({
  install: `(() => {
    if (window.__beingUiAudit) return false;
    const audit = { errors: 0, rejections: 0 };
    audit.onError = () => { audit.errors += 1; };
    audit.onRejection = () => { audit.rejections += 1; };
    window.addEventListener('error', audit.onError);
    window.addEventListener('unhandledrejection', audit.onRejection);
    window.__beingUiAudit = audit;
    return true;
  })()`,
  remove: `(() => {
    const audit = window.__beingUiAudit;
    if (!audit) return { errors: 0, rejections: 0 };
    window.removeEventListener('error', audit.onError);
    window.removeEventListener('unhandledrejection', audit.onRejection);
    delete window.__beingUiAudit;
    return { errors: audit.errors, rejections: audit.rejections };
  })()`,
  settle: `new Promise(resolve => {
    const timer = setTimeout(() => resolve(true), 180);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timer);
      setTimeout(() => resolve(true), 50);
    }));
  })`,
  baseline: `(() => {
    const chat = document.querySelector('button[data-page="chat"]');
    const sidebar = document.getElementById('toggle-sidebar');
    const inspector = document.getElementById('toggle-inspector');
    if (!chat || !sidebar || !inspector) return false;
    chat.click();
    if (document.body.classList.contains('sidebar-collapsed')) sidebar.click();
    if (!document.getElementById('inspector').hidden) inspector.click();
    return true;
  })()`,
  sidebar: `(() => { const el = document.getElementById('toggle-sidebar'); if (!el) return false; el.click(); return true; })()`,
  inspector: `(() => { const el = document.getElementById('toggle-inspector'); if (!el) return false; el.click(); return true; })()`,
  closeInspector: `(() => { const el = document.getElementById('close-inspector'); if (!el) return false; el.click(); return true; })()`,
  settings: `(() => { const el = document.getElementById('header-settings'); if (!el) return false; el.click(); return true; })()`,
  workspace: `(() => { const el = document.querySelector('button[data-page="workspace"]'); if (!el) return false; el.click(); return true; })()`,
  chat: `(() => { const el = document.querySelector('button[data-page="chat"]'); if (!el) return false; el.click(); return true; })()`,
  readingSnapshot: `(async () => {
    const state = await window.beingDesktop.getState();
    const chat = document.getElementById('reading-chat-size');
    const code = document.getElementById('reading-code-size');
    const reset = document.getElementById('reading-reset');
    const settings = state.settings?.typography;
    return {
      settings: settings ? {chatFontSize:settings.chatFontSize,codeFontSize:settings.codeFontSize} : null,
      controlsPresent: Boolean(chat?.tagName === 'SELECT' && code?.tagName === 'SELECT' && reset && document.getElementById('reading-status')),
      chatOptions: chat ? Array.from(chat.options, option => option.value) : [],
      codeOptions: code ? Array.from(code.options, option => option.value) : [],
      chatValue: chat?.value, codeValue: code?.value,
      busy: document.getElementById('reading-settings')?.getAttribute('aria-busy') === 'true',
      resetDisabled: Boolean(reset?.disabled),
      shellFonts: ['body','.nav-button','#portal-executable','#portal-config','#settings-model-url'].map(selector => {
        const el = document.querySelector(selector);
        return {selector,present:Boolean(el),fontSize:el ? getComputedStyle(el).fontSize : null};
      })
    };
  })()`,
  snapshot: `(async () => {
    const publicState = await window.beingDesktop.getState();
    const states = ['idle', 'connecting', 'connected', 'disconnected', 'error'];
    const rectangle = el => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    const isVisible = el => {
      if (!el || !el.getClientRects().length) return false;
      const style = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' &&
        Number(style.opacity) !== 0 && b.width > 0 && b.height > 0 &&
        b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight;
    };
    const centerClippedByScroll = (el, centerY) => {
      for (let ancestor = el?.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const overflowY = getComputedStyle(ancestor).overflowY;
        if (!['auto', 'scroll', 'hidden'].includes(overflowY)) continue;
        const rect = ancestor.getBoundingClientRect();
        const paddingTop = rect.top + ancestor.clientTop;
        const paddingBottom = paddingTop + ancestor.clientHeight;
        if (centerY < paddingTop || centerY >= paddingBottom) return true;
      }
      return false;
    };
    const selectors = [
      ['toggle-sidebar', '#toggle-sidebar'], ['toggle-inspector', '#toggle-inspector'],
      ['close-inspector', '#close-inspector'], ['header-settings', '#header-settings'],
      ['nav-chat', 'button[data-page="chat"]'], ['nav-workspace', 'button[data-page="workspace"]'],
      ['nav-town', '#nav-town'], ['sidebar-town-toggle', '#sidebar-town-toggle'],
      ['nav-settings', 'button[data-page="settings"]'], ['active-session', '#active-session'],
      ['window-minimize', '#window-minimize'], ['window-maximize', '#window-maximize'],
      ['window-close', '#window-close']
    ];
    const controls = selectors.map(([id, selector]) => {
      const el = document.querySelector(selector);
      const rect = rectangle(el);
      const visible = isVisible(el);
      const center = rect && { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const hit = visible && document.elementFromPoint(center.x, center.y);
      return { id, exists: Boolean(el), visible, disabled: Boolean(el && el.disabled), rect,
        centerClippedByScroll: Boolean(el && center && centerClippedByScroll(el, center.y)),
        centerUncovered: visible ? Boolean(hit && (hit === el || el.contains(hit))) : null,
        expanded: el && ['true', 'false'].includes(el.getAttribute('aria-expanded')) ? el.getAttribute('aria-expanded') : null };
    });
    const regions = ['sidebar', 'content-grid', 'page-chat', 'page-settings', 'page-workspace', 'page-town', 'page-town-app', 'inspector', 'onboarding', 'loom-host'];
    const containers = regions.map(id => {
      const el = document.getElementById(id);
      const visible = isVisible(el);
      return { id, exists: Boolean(el), visible, rect: rectangle(el),
        horizontalOverflow: visible ? Math.max(0, el.scrollWidth - el.clientWidth) : 0,
        verticalOverflow: visible ? Math.max(0, el.scrollHeight - el.clientHeight) : 0 };
    });
    const active = ['chat', 'settings', 'workspace', 'town', 'town-app'].filter(page => {
      const el = document.getElementById('page-' + page);
      return Boolean(el && !el.hidden);
    });
    return {
      viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
      page: active.length === 1 ? active[0] : 'invalid',
      sidebarCollapsed: document.body.classList.contains('sidebar-collapsed'),
      inspectorHidden: Boolean(document.getElementById('inspector')?.hidden),
      inspectorClassHidden: Boolean(document.getElementById('content-grid')?.classList.contains('inspector-hidden')),
      onboardingVisible: isVisible(document.getElementById('onboarding')),
      onboardingForm: {
        exists: Boolean(document.getElementById('onboarding-connect-form')),
        visible: isVisible(document.getElementById('onboarding-connect-form')),
        passwordInput: document.getElementById('onboarding-url')?.type === 'password',
        inputRequired: Boolean(document.getElementById('onboarding-url')?.required),
        submitVisible: isVisible(document.getElementById('onboarding-connect'))
      },
      loomVisible: isVisible(document.getElementById('loom-host')),
      connection: { configured: Boolean(publicState.connection?.configured),
        status: states.includes(publicState.connection?.status) ? publicState.connection.status : 'other' },
      documentHidden: document.hidden,
      documentOverflow: { horizontal: Math.max(0, document.documentElement.scrollWidth - innerWidth),
        vertical: Math.max(0, document.documentElement.scrollHeight - innerHeight) },
      controls, containers,
      errors: { errors: window.__beingUiAudit?.errors || 0, rejections: window.__beingUiAudit?.rejections || 0 }
    };
  })()`
});

function readingActionScript(id, value, expected) {
  if (!['reading-chat-size','reading-code-size','reading-reset'].includes(id)) throw new Error('Unsupported reading audit control.');
  return `new Promise((resolve, reject) => {
    const expected = ${JSON.stringify(expected)};
    const control = document.getElementById(${JSON.stringify(id)});
    const panel = document.getElementById('reading-settings');
    const chat = document.getElementById('reading-chat-size');
    const code = document.getElementById('reading-code-size');
    if (!control || !panel || !chat || !code || control.disabled) return reject(new Error('Reading audit control unavailable'));
    panel.scrollIntoView({block:'center'});
    const rect = control.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (!hit || (hit !== control && !control.contains(hit))) return reject(new Error('Reading audit control is covered'));
    let latest, finished = false, unsubscribe = () => {};
    const finish = error => {
      if (finished) return;
      finished = true; clearTimeout(timer); observer.disconnect(); unsubscribe();
      error ? reject(error) : resolve(true);
    };
    const check = () => {
      const settings = latest?.settings?.typography;
      if (settings?.chatFontSize === expected.chatFontSize && settings?.codeFontSize === expected.codeFontSize &&
          chat.value === String(expected.chatFontSize) && code.value === String(expected.codeFontSize) &&
          !chat.disabled && !code.disabled && panel.getAttribute('aria-busy') !== 'true') finish();
    };
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => finish(new Error('Reading setting did not finish saving')), 1400);
    observer.observe(panel,{attributes:true,childList:true,characterData:true,subtree:true});
    unsubscribe = window.beingDesktop.onState(state => {latest = state; check();});
    try {
      if (${JSON.stringify(id)} === 'reading-reset') control.click();
      else {control.value = ${JSON.stringify(value)}; control.dispatchEvent(new Event('change',{bubbles:true}));}
      window.beingDesktop.getState().then(state => {latest = state; check();},finish);
    } catch (error) {finish(error);}
  })`;
}

function overlap(a, b) {
  return a && b && Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;
}

function expectedViewBounds(host, viewport) {
  const x = Math.max(0, Math.min(viewport.width, Math.round(host.x)));
  const y = Math.max(0, Math.min(viewport.height, Math.round(host.y)));
  return { x, y, width: Math.max(0, Math.min(viewport.width - x, Math.round(host.width))),
    height: Math.max(0, Math.min(viewport.height - y, Math.round(host.height))) };
}

async function runUiAudit({ win, getView, reportDir }) {
  if (!win || win.isDestroyed() || typeof getView !== 'function') throw new Error('UI audit window is unavailable.');
  if (win.webContents.getURL() !== TRUSTED_URL) throw new Error('UI audit requires the trusted local shell.');
  const localRoot = path.resolve(__dirname, '..', '.local');
  const destination = typeof reportDir === 'string' ? path.resolve(reportDir) : '';
  const relative = path.relative(localRoot, destination);
  if (!destination || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('UI audit reports must use a directory inside the project .local directory.');
  }
  const runRoot = path.dirname(destination);
  const profileRoot = path.resolve(process.env.BEING_DATA_DIR || '');
  if (!/^(?:smoke|ui-onboarding)-[a-f0-9]{32}$/i.test(path.basename(runRoot)) ||
      path.dirname(runRoot) !== localRoot || profileRoot !== path.join(runRoot,'profile')) {
    throw new Error('Reading preference audits require an isolated smoke or onboarding profile.');
  }
  const started = Date.now();
  let activeDeadline = started + 21500;
  const report = {
    schemaVersion: 1, passed: false, checks: [], observations: [], screenshots: [], captureResults: [],
    errors: { consoleErrors: 0, javascriptErrors: 0, unhandledRejections: 0, rendererGone: 0 },
    limits: {
      durationBudgetMs: TOTAL_BUDGET_MS,
      consoleScope: 'Trusted shell events observed after audit attachment only.',
      remoteInspection: 'Native Loom visibility, bounds and local screenshots only; no remote JavaScript.',
      layoutScope: 'Known shell controls and container geometry; no chat text or credential values exported.',
      currentStateOnly: true,
      connectionSettingsChanged: false,
      localSettingsChanged: 'Only isolated audit profile typography may change; reset through the UI is checked.'
    }
  };
  const check = (name, passed, observed = {}) => report.checks.push({ name, passed: Boolean(passed), observed });
  const bounded = async (operation, cap = 1800) => {
    const remaining = Math.min(cap, activeDeadline - Date.now());
    if (remaining <= 0) throw new Error('audit-time-budget');
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('audit-operation-timeout')), remaining);
      })]);
    } finally { clearTimeout(timer); }
  };
  const execute = script => bounded(() => {
    if (win.isDestroyed() || win.webContents.getURL() !== TRUSTED_URL) throw new Error('audit-untrusted-page');
    return win.webContents.executeJavaScript(script, true);
  });
  const settle = () => execute(SCRIPTS.settle);
  const readingAction = async (name, id, value, expected) => {
    try {
      const completed = await execute(readingActionScript(id,value,expected));
      check(name,completed);
    } catch (error) {
      check(name,false,{category:'reading-control-did-not-complete'});
      throw error;
    }
  };
  const readingSettingsEqual = (actual, expected) => actual?.chatFontSize === expected.chatFontSize && actual?.codeFontSize === expected.codeFontSize;
  const persistedReadingSettings = () => bounded(async () => {
    const saved = JSON.parse(await fs.readFile(path.join(profileRoot,'settings.json'),'utf8')).typography;
    return saved ? {chatFontSize:saved.chatFontSize,codeFontSize:saved.codeFontSize} : null;
  });
  const inspectReading = async (phase, expected) => {
    const observed = await execute(SCRIPTS.readingSnapshot);
    const persisted = await persistedReadingSettings();
    check(`reading.${phase}.state`, readingSettingsEqual(observed.settings,expected), {expected,actual:observed.settings});
    check(`reading.${phase}.persisted`, readingSettingsEqual(persisted,expected), {expected,actual:persisted});
    check(`reading.${phase}.controls`, observed.chatValue === String(expected.chatFontSize) && observed.codeValue === String(expected.codeFontSize) && !observed.busy,
      {chatValue:observed.chatValue,codeValue:observed.codeValue,busy:observed.busy});
    const text = observed.shellFonts.filter(item => ['body','.nav-button'].includes(item.selector));
    const code = observed.shellFonts.filter(item => !['body','.nav-button'].includes(item.selector));
    check(`reading.${phase}.shell-ui-size-unchanged`, text.every(item => item.present && item.fontSize === '14px'), {fonts:text});
    check(`reading.${phase}.shell-code-size`, code.every(item => item.present && item.fontSize === expected.codeFontSize + 'px'), {fonts:code});
    return observed;
  };
  const runReadingAudit = async () => {
    const initial = await execute(SCRIPTS.readingSnapshot);
    const available = initial.controlsPresent && initial.chatOptions.join(',') === '14,15,16' && initial.codeOptions.join(',') === '12,13,14' &&
      [14,15,16].includes(initial.settings?.chatFontSize) && [12,13,14].includes(initial.settings?.codeFontSize);
    check('reading.controls-and-options', available, {controlsPresent:initial.controlsPresent,chatOptions:initial.chatOptions,codeOptions:initial.codeOptions,settings:initial.settings});
    if (!available) return;
    const chatChanged = {chatFontSize:16,codeFontSize:initial.settings.codeFontSize};
    await readingAction('reading.chat-change-event','reading-chat-size','16',chatChanged);
    await inspectReading('chat-enlarged',chatChanged);
    const enlarged = {chatFontSize:16,codeFontSize:14};
    await readingAction('reading.code-change-event','reading-code-size','14',enlarged);
    await inspectReading('both-enlarged',enlarged);
    for (const [name,invalid] of [
      ['out-of-range',{chatFontSize:17,codeFontSize:14}],
      ['string-size',{chatFontSize:16,codeFontSize:'14'}],
      ['unknown-property',{chatFontSize:16,codeFontSize:14,fontFamily:'untrusted-font'}]
    ]) {
      const rejected = await execute(`window.beingDesktop.setTypography(${JSON.stringify(invalid)}).then(() => false, () => true)`);
      check(`reading.invalid-${name}-rejected`, rejected);
    }
    await inspectReading('after-invalid',enlarged);
    const defaults = {chatFontSize:14,codeFontSize:12};
    await readingAction('reading.reset-click','reading-reset',null,defaults);
    const reset = await inspectReading('reset',defaults);
    check('reading.reset-disabled-at-defaults', reset.resetDisabled);
    await execute(`(() => {document.getElementById('page-settings').scrollTop = 0; return true;})()`);
  };
  const onConsole = (details, legacyLevel) => {
    if (details?.level === 'error' || legacyLevel === 3) report.errors.consoleErrors += 1;
  };
  const onGone = () => { report.errors.rendererGone += 1; };
  const nativeState = () => {
    const nativeView = getView();
    if (!nativeView || nativeView.webContents.isDestroyed()) return { exists: false, visible: false, bounds: null };
    return { exists: true, visible: nativeView.getVisible(), bounds: nativeView.getBounds() };
  };
  const screenshot = async (phase, native = false) => {
    const filename = `${phase}${native ? '.loom' : '.shell'}.png`;
    const surface = native ? 'loom' : 'shell';
    const captureCheck = `${phase}.${surface}-capture`;
    const nativeView = native ? getView() : null;
    const target = native ? nativeView?.webContents : win;
    const failure = category => {
      check(captureCheck, false, { category });
      report.captureResults.push({ phase, surface, status: 'failed', category });
    };
    if (!target || target.isDestroyed()) return failure('capture-target-unavailable');
    if (native && (!nativeView.getVisible() || !win.isVisible() || win.isMinimized())) return failure('capture-target-hidden');
    try {
      const bitmap = await bounded(() => target.capturePage(undefined, { stayHidden: true, stayAwake: true }));
      if (bitmap.isEmpty()) return failure('capture-empty');
      await bounded(() => fs.writeFile(path.join(destination, filename), bitmap.toPNG()));
      check(captureCheck, true);
      report.captureResults.push({ phase, surface, status: 'saved' });
      report.screenshots.push({ phase, surface, file: filename, pixels: bitmap.getSize() });
    } catch (error) {
      failure(error?.message === 'audit-operation-timeout' ? 'capture-timeout' : 'capture-failed');
    }
  };
  const observe = async (phase, { capture = true, captureLoom = false } = {}) => {
    await settle();
    const snapshot = await execute(SCRIPTS.snapshot);
    let native = nativeState();
    const expectedVisible = snapshot.page === 'chat' && snapshot.connection.configured &&
      snapshot.connection.status === 'connected' && !snapshot.documentHidden;
    const host = snapshot.containers.find(item => item.id === 'loom-host')?.rect;
    const expectedBounds = host ? expectedViewBounds(host, snapshot.viewport) : null;
    const matches = () => Boolean(native.bounds && expectedBounds &&
      ['x', 'y', 'width', 'height'].every(key => Math.abs(native.bounds[key] - expectedBounds[key]) <= 1));
    // Allow one frame for renderer-to-main setView IPC to settle.
    if (native.visible !== expectedVisible || (expectedVisible && !matches())) {
      await settle();
      native = nativeState();
    }
    snapshot.native = native;
    snapshot.window = { visible: win.isVisible(), minimized: win.isMinimized() };
    report.observations.push({ phase, ...snapshot });
    check(`${phase}.one-active-page`, snapshot.page !== 'invalid', { page: snapshot.page });
    const activePage = snapshot.containers.find(item => item.id === `page-${snapshot.page}`);
    check(`${phase}.active-page-visible`, Boolean(activePage?.visible && activePage.rect.width > 0 && activePage.rect.height > 0),
      { page: snapshot.page, visible: Boolean(activePage?.visible), rect: activePage?.rect || null });
    if (snapshot.onboardingVisible) check(`${phase}.onboarding-form-ready`, Object.values(snapshot.onboardingForm).every(Boolean), snapshot.onboardingForm);
    check(`${phase}.document-overflow`, snapshot.documentOverflow.horizontal <= 1 && snapshot.documentOverflow.vertical <= 1, snapshot.documentOverflow);
    const horizontalOverflow = snapshot.containers.filter(item => item.visible && item.horizontalOverflow > 1).map(item => ({ id: item.id, pixels: item.horizontalOverflow }));
    check(`${phase}.container-widths`, horizontalOverflow.length === 0, { overflow: horizontalOverflow });
    const scrollClipped = snapshot.controls.filter(item => item.visible && item.centerClippedByScroll).map(item => item.id);
    const covered = snapshot.controls.filter(item => item.visible && !item.centerClippedByScroll && !item.disabled && !item.centerUncovered).map(item => item.id);
    const nativeOverlap = native.visible ? snapshot.controls.filter(item => item.visible && overlap(item.rect, native.bounds)).map(item => item.id) : [];
    check(`${phase}.controls-uncovered`, covered.length === 0 && nativeOverlap.length === 0, { covered, nativeOverlap, scrollClipped });
    check(`${phase}.native-visibility`, native.visible === expectedVisible, { expected: expectedVisible, actual: native.visible, nativeExists: native.exists });
    if (expectedVisible) {
      check(`${phase}.loom-host-visible`, snapshot.loomVisible && host?.width > 0 && host?.height > 0, { visible: snapshot.loomVisible, rect: host });
      check(`${phase}.native-bounds`, matches(), { expected: expectedBounds, actual: native.bounds });
    }
    if (capture) await screenshot(phase);
    if (captureLoom) {
      if (native.visible || expectedVisible) await screenshot(phase, true);
      else report.captureResults.push({ phase, surface: 'loom', status: 'not-applicable', category: 'no-visible-connected-loom' });
    }
    return snapshot;
  };
  const controlExpanded = (snapshot, id) => snapshot.controls.find(control => control.id === id)?.expanded;
  const windowTransition = async (event, operation) => {
    let listener;
    let timer;
    try {
      await bounded(() => new Promise(resolve => {
        listener = () => resolve(true);
        win.once(event, listener);
        timer = setTimeout(() => resolve(false), 600);
        operation();
      }), 800);
    } finally {
      clearTimeout(timer);
      if (listener) win.removeListener(event, listener);
    }
  };
  win.webContents.on('console-message', onConsole);
  win.webContents.on('render-process-gone', onGone);
  let instrumentationInstalled = false;
  try {
    await bounded(() => fs.mkdir(destination, { recursive: true }));
    instrumentationInstalled = await execute(SCRIPTS.install);
    check('instrumentation-attached', instrumentationInstalled);
    if (win.isMinimized()) win.restore();
    if (win.isMaximized()) win.unmaximize();
    win.setSize(1440, 940, false);
    win.showInactive();
    check('baseline-controls-present', await execute(SCRIPTS.baseline));
    const initial = await observe('01-chat-1440', { captureLoom: true });
    check('window-visible-for-audit', initial.window.visible && !initial.window.minimized && !initial.documentHidden,
      { visible: initial.window.visible, minimized: initial.window.minimized, documentHidden: initial.documentHidden });
    report.initialMode = initial.onboardingVisible ? 'onboarding' : initial.connection.status;
    check('initial-size-1440x940', initial.viewport.width === 1440 && initial.viewport.height === 940, initial.viewport);
    check('initial-chat-layout', initial.page === 'chat' && !initial.sidebarCollapsed && initial.inspectorHidden && initial.inspectorClassHidden);
    check('sidebar-click-collapse', await execute(SCRIPTS.sidebar));
    const collapsed = await observe('02-sidebar-collapsed');
    check('sidebar-collapse-state', collapsed.sidebarCollapsed && controlExpanded(collapsed, 'toggle-sidebar') === 'false');
    check('sidebar-click-expand', await execute(SCRIPTS.sidebar));
    const expanded = await observe('03-sidebar-expanded', { capture: false });
    check('sidebar-expand-state', !expanded.sidebarCollapsed && controlExpanded(expanded, 'toggle-sidebar') === 'true');
    check('inspector-click-open', await execute(SCRIPTS.inspector));
    const inspector = await observe('04-inspector-open');
    check('inspector-open-state', !inspector.inspectorHidden && !inspector.inspectorClassHidden && controlExpanded(inspector, 'toggle-inspector') === 'true');
    check('inspector-click-close', await execute(SCRIPTS.closeInspector));
    const inspectorClosed = await observe('05-inspector-closed', { capture: false });
    check('inspector-close-state', inspectorClosed.inspectorHidden && inspectorClosed.inspectorClassHidden && controlExpanded(inspectorClosed, 'toggle-inspector') === 'false');
    check('settings-click', await execute(SCRIPTS.settings));
    const settings = await observe('06-settings');
    check('settings-active-native-hidden', settings.page === 'settings' && !settings.native.visible);
    await runReadingAudit();
    check('workspace-click', await execute(SCRIPTS.workspace));
    const workspace = await observe('07-workspace');
    check('workspace-active-native-hidden', workspace.page === 'workspace' && !workspace.native.visible);
    await runTownUiAudit({ win, execute, observe, settle, check, report });
    check('chat-click', await execute(SCRIPTS.chat));
    const chat = await observe('08-return-chat', { capture: false });
    check('chat-active', chat.page === 'chat');
    win.setSize(1000, 700, false);
    const narrow = await observe('09-chat-1000', { captureLoom: true });
    check('minimum-size-1000x700', narrow.viewport.width === 1000 && narrow.viewport.height === 700, narrow.viewport);
    await execute(SCRIPTS.inspector);
    const narrowInspector = await observe('10-inspector-1000');
    check('minimum-inspector-open', !narrowInspector.inspectorHidden);
    await execute(SCRIPTS.closeInspector);
    await windowTransition('minimize', () => win.minimize());
    check('window-minimized', win.isMinimized());
    await windowTransition('restore', () => win.restore());
    check('window-restored', !win.isMinimized());
    await observe('11-restored', { capture: false });
  } catch (error) {
    const category = ['audit-time-budget', 'audit-operation-timeout', 'audit-untrusted-page'].includes(error?.message) ? error.message : 'audit-operation-failed';
    check('audit-completed', false, { category });
  } finally {
    activeDeadline = started + 24000;
    try {
      if (!win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        if (win.isMaximized()) win.unmaximize();
        win.setSize(1440, 940, false);
        await execute(SCRIPTS.baseline);
        const final = await observe('12-final-chat-1440', { captureLoom: true });
        check('final-layout-restored', final.page === 'chat' && !final.sidebarCollapsed && final.inspectorHidden &&
          final.inspectorClassHidden && final.viewport.width === 1440 && final.viewport.height === 940);
      } else check('final-layout-restored', false, { category: 'window-unavailable' });
    } catch { check('final-layout-restored', false, { category: 'restore-failed' }); }
    try {
      if (instrumentationInstalled) {
        const counts = await execute(SCRIPTS.remove);
        report.errors.javascriptErrors = counts.errors;
        report.errors.unhandledRejections = counts.rejections;
      }
    } catch { check('instrumentation-removed', false); }
    if (!win.webContents.isDestroyed()) {
      win.webContents.removeListener('console-message', onConsole);
      win.webContents.removeListener('render-process-gone', onGone);
    }
  }
  check('no-shell-javascript-errors', Object.values(report.errors).every(count => count === 0), report.errors);
  report.elapsedMs = Date.now() - started;
  check('duration-within-budget', report.elapsedMs < TOTAL_BUDGET_MS, { elapsedMs: report.elapsedMs, budgetMs: TOTAL_BUDGET_MS });
  report.passed = report.checks.every(item => item.passed);
  await fs.writeFile(path.join(destination, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

module.exports = { runUiAudit };
