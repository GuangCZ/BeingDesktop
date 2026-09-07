'use strict';

const {randomUUID} = require('node:crypto');

const BROWSER_PARTITION = 'persist:being-desktop-browser-v1';
const MAX_BROWSER_TABS = 16;
const MAX_URL_LENGTH = 8192;
const INSPECTION_WORLD = 1004;
const PRIVATE_PARAMETER = /(?:token|password|passwd|secret|api[_-]?key|authorization|credential|signature|^code$|^key$)/i;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label}格式无效。`);
  return value;
}

function navigationUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('请输入有效的网页地址。');
  const input = value.trim();
  if (!/^https?:\/\//i.test(input)) throw new TypeError('浏览器仅支持 HTTP 和 HTTPS 网页。');
  let url;
  try { url = new URL(input); } catch { throw new TypeError('请输入有效的网页地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new TypeError('网页地址不能包含登录凭据。');
  return url.href;
}

function normalizeBrowserUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('请输入有效的网页地址。');
  const input = value.trim();
  if (/^https?:\/\//i.test(input)) return navigationUrl(input);
  // Only hostname-like address input receives a scheme; arbitrary text is not executed or searched.
  if (/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i.test(input)) return navigationUrl(`http://${input}`);
  if (/^(?:[a-z0-9\u0080-\uffff](?:[a-z0-9\u0080-\uffff-]*[a-z0-9\u0080-\uffff])?\.)+[a-z0-9\u0080-\uffff-]+(?::\d{1,5})?(?:[/?#]|$)/i.test(input)) return navigationUrl(`https://${input}`);
  throw new TypeError('请输入 HTTP 或 HTTPS 地址，例如 localhost:3000。');
}

function safeUrl(value) {
  if (!value) return '';
  let url;
  try { url = new URL(navigationUrl(value)); } catch { return ''; }
  for (const key of [...url.searchParams.keys()]) if (PRIVATE_PARAMETER.test(key)) url.searchParams.set(key, '[redacted]');
  if (PRIVATE_PARAMETER.test(url.hash)) url.hash = '[redacted]';
  return url.href;
}

function safeTitle(value, fallback) {
  const title = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/https?:\/\/[^\s<>"']+/gi, match => safeUrl(match)).replace(/((?:token|password|secret|api[_-]?key|authorization|credential)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]').trim().slice(0, 180) : '';
  if (title) return title;
  try { return fallback ? new URL(fallback).hostname : '新标签页'; } catch { return '新标签页'; }
}

function normalizeBounds(value) {
  object(value, '浏览器显示区域');
  const result = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 100000) throw new TypeError('浏览器显示区域无效。');
    result[key] = Math.floor(value[key]);
  }
  return result;
}

function pageOperation(token, operation, args) {
  if (globalThis.__beingBrowserDocument !== token) return {error:'document_changed'};
  const visible = element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    if (!element.isConnected || rect.width <= 0 || rect.height <= 0 || style.visibility !== 'visible' || style.display === 'none') return false;
    return element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  };
  if (operation === 'read') {
    const selectors = element => {
      if (element.id) {
        const selector = `#${CSS.escape(element.id)}`;
        if (selector.length <= 512 && document.querySelectorAll(selector).length === 1) return selector;
      }
      const parts = [];
      for (let current = element; current && current.nodeType === 1; current = current.parentElement) {
        const tag = current.localName;
        const siblings = current.parentElement ? [...current.parentElement.children].filter(child => child.localName === tag) : [current];
        parts.unshift(siblings.length === 1 ? tag : `${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
      }
      const selector = parts.join(' > ');
      return selector.length <= 512 ? selector : '';
    };
    const all = [...document.querySelectorAll('a[href],button,input,textarea,select,[contenteditable="true"],[role="button"],[role="link"],[role="textbox"]')];
    const elements = [];
    let omitted = false;
    for (const element of all) {
      if (!visible(element) || element.matches('input[type="password"],input[type="file"],input[type="hidden"]')) continue;
      if (elements.length >= 80) { omitted = true; break; }
      const selector = selectors(element);
      if (!selector) continue;
      const label = element.getAttribute('aria-label') || [...(element.labels || [])].map(item => item.innerText).join(' ') || element.getAttribute('title') || element.getAttribute('placeholder') || element.innerText || '';
      elements.push({selector,tag:element.localName,role:element.getAttribute('role') || '',label:String(label).trim().slice(0, 180),type:element.getAttribute('type') || ''});
    }
    const text = document.body?.innerText || '';
    return {title:document.title,text:text.slice(0, 20000),elements,truncated:text.length > 20000 || omitted};
  }
  let matches;
  try { matches = [...document.querySelectorAll(args.selector)].filter(visible); }
  catch { return {error:args.targetToken ? 'target_changed' : 'invalid_selector'}; }
  if (matches.length !== 1) return {error:args.targetToken ? 'target_changed' : 'ambiguous_target'};
  const element = matches[0];
  const kind = operation === 'prepare' ? args.kind : operation;
  const unavailable = () => ({error:args.targetToken && operation !== 'prepare' ? 'target_changed' : 'unavailable_target'});
  if (element.matches('input[type="password"],input[type="file"],input[type="hidden"]') || element.disabled || element.getAttribute('aria-disabled') === 'true') return unavailable();
  if (kind === 'click') {
    if (element.closest('a[download]')) return unavailable();
    const anchor = element.closest('a[href]');
    if (anchor && !['http:', 'https:'].includes(new URL(anchor.href, location.href).protocol)) return unavailable();
    if (typeof element.click !== 'function') return unavailable();
  } else if (kind === 'fill') {
    if (element.readOnly || (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement) && !element.isContentEditable)) return unavailable();
    if (element instanceof HTMLInputElement && !['text','search','email','url','tel','number'].includes(element.type)) return unavailable();
  } else return {error:'invalid_operation'};

  if (operation === 'prepare' || args.targetToken) {
    const control = element.closest('button,a,input,textarea,select') || element;
    const form = control.form || control.closest('form');
    const fields = form ? [...form.elements] : [];
    const describe = target => {
      const type = String(target.type || '');
      const value = ['password','file'].includes(type) ? '' : String(target.value ?? '');
      const text = String(target.innerText || '');
      if (value.length > 16000 || text.length > 8000) throw new Error('Large target');
      return {tag:target.localName,type,name:target.getAttribute('name'),href:target.href || '',text,value,
        disabled:Boolean(target.disabled),readOnly:Boolean(target.readOnly),checked:Boolean(target.checked),
        role:target.getAttribute('role'),label:target.getAttribute('aria-label'),title:target.getAttribute('title'),
        action:target.formAction || '',method:target.formMethod || '',ariaDisabled:target.getAttribute('aria-disabled')};
    };
    let fingerprint;
    try {
      if (fields.length > 80) return unavailable();
      fingerprint = JSON.stringify({target:describe(element),control:describe(control),form:form ? {action:form.action,method:form.method,target:form.target} : null,fields:fields.map(describe)});
      if (fingerprint.length > 100000) return unavailable();
    } catch { return unavailable(); }
    const targets = globalThis.__beingBrowserTargets;
    if (!(targets instanceof Map)) return {error:'target_changed'};
    if (operation === 'prepare') {
      while (targets.size >= 32) targets.delete(targets.keys().next().value);
      targets.set(args.targetToken,{element,control,form,fields,kind,selector:args.selector,fingerprint,handler:control.onclick});
      const label = control.getAttribute('aria-label') || control.getAttribute('title') || control.getAttribute('placeholder') || control.innerText || control.getAttribute('name') || args.selector;
      return {targetToken:args.targetToken,summary:`${control.localName}${control.type ? ` (${control.type})` : ''} · ${String(label).trim().slice(0,180)}`};
    }
    const target = targets.get(args.targetToken);
    targets.delete(args.targetToken);
    if (!target || target.element !== element || target.control !== control || target.form !== form || target.kind !== operation || target.selector !== args.selector || target.fingerprint !== fingerprint || target.handler !== control.onclick || target.fields.length !== fields.length || fields.some((field,index) => target.fields[index] !== field)) return {error:'target_changed'};
  }

  if (operation === 'click') {
    element.click();
    return {clicked:true};
  }
  if (operation === 'fill') {
    if (element.readOnly) return {error:'unavailable_target'};
    if (element instanceof HTMLInputElement) {
      if (!['text','search','email','url','tel','number'].includes(element.type)) return {error:'unavailable_target'};
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, args.text);
    } else if (element instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, args.text);
    } else if (element.isContentEditable) {
      element.innerText = args.text;
    } else return {error:'unavailable_target'};
    element.dispatchEvent(new InputEvent('input', {bubbles:true,inputType:'insertText',data:args.text}));
    element.dispatchEvent(new Event('change', {bubbles:true}));
    return {filled:true};
  }
  return {error:'invalid_operation'};
}

const OPERATION_ERRORS = {
  document_changed:'页面已变化，请重新读取后重试。',
  target_changed:'请求已过期：页面或操作目标已变化。',
  invalid_selector:'网页元素选择器无效。',
  ambiguous_target:'请选择唯一且可见的网页元素。',
  unavailable_target:'该元素不支持此操作，请在浏览器中手动操作。',
};

class DesktopBrowser {
  constructor(options) {
    const {WebContentsView, session, getWindow, onChange = () => {}} = object(options, '浏览器选项');
    if (typeof WebContentsView !== 'function' || typeof session?.fromPartition !== 'function' || typeof getWindow !== 'function' || typeof onChange !== 'function') throw new TypeError('浏览器依赖无效。');
    this.View = WebContentsView;
    this.getWindow = getWindow;
    this.onChange = onChange;
    this.tabs = new Map();
    this.activeTabId = null;
    this.visible = false;
    this.bounds = {x:0, y:0, width:0, height:0};
    this.attached = null;
    this.destroyed = false;
    this.session = session.fromPartition(BROWSER_PARTITION);
    this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler(() => false);
    this.session.setDevicePermissionHandler(() => false);
    this.downloadHandler = (event, _item, contents) => {
      event.preventDefault();
      const tab = [...this.tabs.values()].find(item => item.view.webContents === contents);
      if (tab) this._notice(tab, '此浏览器暂不支持下载文件。');
    };
    this.session.on('will-download', this.downloadHandler);
    // This partition contains only browser pages. Resource URLs remain unrestricted,
    // while frame requests cannot bypass the same protocol rules as address input.
    this.session.webRequest.onBeforeRequest((details, callback) => {
      let cancel = false;
      if (['mainFrame', 'subFrame'].includes(details.resourceType)) {
        try { navigationUrl(details.url); } catch { cancel = true; }
      }
      callback({cancel});
    });
  }

  snapshot() {
    return {
      tabs:[...this.tabs.values()].map(tab => ({
        id:tab.id, title:safeTitle(tab.title, tab.url), url:safeUrl(tab.url),
        isLoading:tab.isLoading, canGoBack:tab.canGoBack, canGoForward:tab.canGoForward, error:tab.error, notice:tab.notice, revision:tab.revision,
      })),
      activeTabId:this.activeTabId,
      visible:this.visible,
    };
  }

  newTab(options = {}) {
    this._alive();
    object(options, '标签页选项');
    if (options.active !== undefined && typeof options.active !== 'boolean') throw new TypeError('标签页选项无效。');
    if (this.tabs.size >= MAX_BROWSER_TABS) throw new Error(`最多打开 ${MAX_BROWSER_TABS} 个标签页，请先关闭一个。`);
    const url = options.url === undefined || options.url === '' ? '' : normalizeBrowserUrl(options.url);
    const view = new this.View({webPreferences:{
      session:this.session, nodeIntegration:false, nodeIntegrationInSubFrames:false,
      nodeIntegrationInWorker:false, contextIsolation:true, sandbox:true,
      webSecurity:true, allowRunningInsecureContent:false, webviewTag:false,
      navigateOnDragDrop:false, safeDialogs:true, disableDialogs:true,
      spellcheck:true,
    }});
    const tab = {id:`browser-${randomUUID()}`, view, url:'', title:'', error:'', notice:'', committedUrl:'', isLoading:false, canGoBack:false, canGoForward:false, listeners:[], revision:0, requestRevision:0, documentToken:'', contextPromise:null};
    view.setVisible(false);
    view.setBackgroundColor('#171717');
    this.tabs.set(tab.id, tab);
    this._bind(tab);
    if (options.active !== false || !this.activeTabId) this.activeTabId = tab.id;
    if (url) this._load(tab, url);
    this._syncView();
    this._emit();
    return this.snapshot();
  }

  activateTab(id) {
    const tab = this._tab(id);
    this.activeTabId = tab.id;
    this._syncView();
    this._emit();
    return this.snapshot();
  }

  closeTab(id) {
    const tab = this._tab(id);
    const ids = [...this.tabs.keys()], index = ids.indexOf(tab.id);
    if (this.attached?.tab === tab) this._detach();
    this.tabs.delete(tab.id);
    tab.requestRevision++;
    for (const [name, handler] of tab.listeners) tab.view.webContents.removeListener(name, handler);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({waitForBeforeUnload:false});
    if (this.activeTabId === tab.id) this.activeTabId = ids[index + 1] || ids[index - 1] || null;
    this._syncView();
    this._emit();
    return this.snapshot();
  }

  navigate(options) {
    object(options, '导航选项');
    const url = normalizeBrowserUrl(options.url);
    const tab = this._tab(options.id);
    this._load(tab, url);
    this._syncView();
    this._emit();
    return this.snapshot();
  }

  goBack(id) { return this._history('back', id); }
  goForward(id) { return this._history('forward', id); }

  reload(id) {
    const tab = this._tab(id);
    if (tab.url) {
      tab.error = '';
      tab.notice = '';
      tab.view.webContents.reload();
      this._syncTab(tab);
      this._emit();
    }
    return this.snapshot();
  }

  stop(id) {
    const tab = this._tab(id);
    tab.requestRevision++;
    tab.view.webContents.stop();
    tab.isLoading = false;
    this._emit();
    return this.snapshot();
  }

  setViewport(options) {
    this._alive();
    object(options, '浏览器显示选项');
    if (typeof options.visible !== 'boolean') throw new TypeError('浏览器显示选项无效。');
    const bounds = options.bounds === undefined && !options.visible ? this.bounds : normalizeBounds(options.bounds);
    const changed = this.visible !== options.visible;
    this.visible = options.visible;
    this.bounds = bounds;
    this._syncView();
    if (changed) this._emit();
    return this.snapshot();
  }

  async readPage(id, expectedRevision) {
    const {tab, result, revision} = await this._operate(id, expectedRevision, 'read', {});
    return {tabId:tab.id, revision, title:safeTitle(result.title, tab.url), url:safeUrl(tab.url), text:result.text, elements:result.elements, truncated:result.truncated};
  }

  async prepareAction(options) {
    object(options, '操作确认选项');
    this._selector(options.selector);
    if (!['click','fill'].includes(options.kind)) throw new TypeError('操作确认类型无效。');
    const targetToken = randomUUID();
    const {result} = await this._operate(options.id, options.expectedRevision, 'prepare', {selector:options.selector,kind:options.kind,targetToken});
    return {targetToken,summary:safeTitle(result.summary, '')};
  }

  async click(options) {
    object(options, '点击选项');
    this._selector(options.selector);
    this._targetToken(options.targetToken);
    const {tab} = await this._operate(options.id, options.expectedRevision, 'click', {selector:options.selector,targetToken:options.targetToken});
    return {tabId:tab.id, clicked:true};
  }

  async fill(options) {
    object(options, '填写选项');
    this._selector(options.selector);
    this._targetToken(options.targetToken);
    if (typeof options.text !== 'string' || options.text.length > 8000 || options.text.includes('\u0000')) throw new TypeError('填写内容无效或超过 8000 个字符。');
    const {tab} = await this._operate(options.id, options.expectedRevision, 'fill', {selector:options.selector, text:options.text,targetToken:options.targetToken});
    return {tabId:tab.id, filled:true};
  }

  async screenshot(id, expectedRevision) {
    const {tab, revision} = this._operationTarget(id, expectedRevision);
    let bitmap;
    const {width, height} = tab.view.getBounds();
    if (width <= 0 || height <= 0) throw new Error('请先在浏览器中打开此标签页再截图。');
    try { bitmap = await tab.view.webContents.capturePage({x:0,y:0,width,height}, {stayHidden:true, stayAwake:true}); }
    catch { throw new Error('无法截取当前网页，请重试。'); }
    this._sameDocument(tab, revision);
    if (bitmap.isEmpty()) throw new Error('网页截图暂不可用，请重试。');
    let size = bitmap.getSize();
    if (Math.max(size.width, size.height) > 1600) {
      const scale = 1600 / Math.max(size.width, size.height);
      bitmap = bitmap.resize({width:Math.max(1, Math.round(size.width * scale)), height:Math.max(1, Math.round(size.height * scale))});
      size = bitmap.getSize();
    }
    const png = bitmap.toPNG();
    if (png.length > 8 * 1024 * 1024) throw new Error('网页截图过大，请缩小浏览器区域后重试。');
    return {tabId:tab.id, revision, mimeType:'image/png', data:png.toString('base64'), width:size.width, height:size.height};
  }

  destroy() {
    if (this.destroyed) return;
    this._detach();
    this.destroyed = true;
    for (const tab of this.tabs.values()) {
      tab.requestRevision++;
      for (const [name, handler] of tab.listeners) tab.view.webContents.removeListener(name, handler);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({waitForBeforeUnload:false});
    }
    this.tabs.clear();
    this.activeTabId = null;
    this.visible = false;
    this.session.removeListener('will-download', this.downloadHandler);
    this.session.webRequest.onBeforeRequest(null);
  }

  _alive() {
    if (this.destroyed) throw new Error('浏览器已经关闭。');
  }

  _tab(id = this.activeTabId) {
    this._alive();
    if (typeof id !== 'string' || id.length > 80 || !this.tabs.has(id)) throw new Error('请选择一个有效的浏览器标签页。');
    const tab = this.tabs.get(id);
    if (tab.view.webContents.isDestroyed()) throw new Error('此标签页已经关闭，请重新打开。');
    return tab;
  }

  _emit() {
    if (!this.destroyed) this.onChange(this.snapshot());
  }

  _load(tab, url) {
    const revision = ++tab.requestRevision;
    tab.url = navigationUrl(url);
    tab.title = '';
    tab.error = '';
    tab.notice = '';
    tab.isLoading = true;
    try {
      Promise.resolve(tab.view.webContents.loadURL(tab.url)).catch(error => {
        if (!this.tabs.has(tab.id) || tab.requestRevision !== revision || this.destroyed || tab.blockedRequestRevision === revision || error?.code === 'ERR_ABORTED' || error?.errno === -3) return;
        tab.error = '网页未能加载，请检查地址或网络后重试。';
        tab.isLoading = false;
        this._emit();
      });
    } catch {
      tab.error = '网页未能加载，请检查地址或网络后重试。';
      tab.isLoading = false;
    }
  }

  _history(direction, id) {
    const tab = this._tab(id), history = tab.view.webContents.navigationHistory;
    const available = direction === 'back' ? history.canGoBack() : history.canGoForward();
    if (available) {
      tab.error = '';
      tab.notice = '';
      if (direction === 'back') history.goBack(); else history.goForward();
      this._syncTab(tab);
      this._emit();
    }
    return this.snapshot();
  }

  _syncTab(tab) {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    const current = contents.getURL();
    if (current && current !== 'about:blank') {
      try { tab.url = navigationUrl(current); } catch { /* Never expose internal or blocked URLs. */ }
    }
    tab.isLoading = contents.isLoading();
    tab.canGoBack = contents.navigationHistory.canGoBack();
    tab.canGoForward = contents.navigationHistory.canGoForward();
  }

  _bind(tab) {
    const contents = tab.view.webContents;
    const on = (name, handler) => { contents.on(name, handler); tab.listeners.push([name, handler]); };
    const update = () => { if (this.tabs.has(tab.id)) { this._syncTab(tab); this._emit(); } };
    const guard = (event, legacyUrl, _inPlace, legacyMainFrame) => {
      const url = typeof event.url === 'string' ? event.url : legacyUrl;
      try { navigationUrl(url); }
      catch {
        event.preventDefault();
        if ((event.isMainFrame ?? legacyMainFrame) !== false) {
          tab.blockedRequestRevision = tab.requestRevision;
          tab.blockedRevision = tab.revision;
          const message = '已阻止不受支持的页面跳转，仅允许 HTTP 和 HTTPS。';
          if (tab.committedUrl) { this._syncTab(tab); this._notice(tab, message); }
          else { tab.error = message; this._emit(); }
        }
      }
    };
    on('will-navigate', guard);
    on('will-frame-navigate', guard);
    on('will-redirect', guard);
    on('will-attach-webview', event => event.preventDefault());
    on('did-start-navigation', (event, _url, _legacyInPlace, legacyMainFrame) => {
      if ((event.isMainFrame ?? legacyMainFrame) !== false) {
        tab.revision++;
        tab.documentToken = '';
        tab.contextPromise = null;
      }
    });
    on('dom-ready', () => this._prepareDocument(tab));
    on('did-start-loading', update);
    on('did-stop-loading', update);
    on('did-navigate', () => {
      try { tab.committedUrl = navigationUrl(contents.getURL()); tab.notice = ''; } catch { /* Internal error pages are not usable documents. */ }
      update();
    });
    on('did-navigate-in-page', (event, _url, isMainFrame) => {
      if ((event.isMainFrame ?? isMainFrame) !== false) { this._prepareDocument(tab); update(); }
    });
    on('page-title-updated', (_event, title) => { tab.title = safeTitle(title, tab.url); this._emit(); });
    on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame === false || code === -3) return;
      if (tab.blockedRevision === tab.revision) { tab.isLoading = false; this._emit(); return; }
      tab.committedUrl = '';
      tab.error = code === -105 ? '找不到此网站，请检查地址。' : '网页未能加载，请检查地址或网络后重试。';
      tab.isLoading = false;
      this._emit();
    });
    on('render-process-gone', () => {
      tab.committedUrl = '';
      tab.error = '此标签页意外关闭，请刷新重试。';
      tab.isLoading = false;
      this._emit();
    });
    contents.setWindowOpenHandler(details => {
      let url;
      try { url = navigationUrl(details.url); }
      catch { this._notice(tab, '已阻止不受支持的弹出窗口。'); return {action:'deny'}; }
      queueMicrotask(() => {
        if (this.destroyed || !this.tabs.has(tab.id)) return;
        try { this.newTab({url, active:details.disposition !== 'background-tab'}); }
        catch { this._notice(tab, '无法新建标签页，请关闭一个标签页后重试。'); }
      });
      return {action:'deny'};
    });
  }

  _notice(tab, message) {
    tab.notice = message;
    // A cancelled document navigation has no dom-ready event. Restore the
    // inspection binding for the committed page that remains on screen.
    if (tab.committedUrl && !tab.error && !tab.documentToken) this._prepareDocument(tab);
    this._emit();
  }

  _selector(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('网页元素选择器无效。');
  }

  _targetToken(value) {
    if (value !== undefined && (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))) throw new TypeError('操作确认标识无效。');
  }

  _operationTarget(id, expectedRevision) {
    const tab = this._tab(id);
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new TypeError('页面版本无效。');
    if (expectedRevision !== undefined && expectedRevision !== tab.revision) throw new Error(OPERATION_ERRORS.document_changed);
    if (!tab.url || tab.isLoading || tab.view.webContents.isLoading() || !tab.documentToken) throw new Error('网页正在加载或尚未准备好，请稍后重试。');
    return {tab, revision:tab.revision};
  }

  _sameDocument(tab, revision) {
    if (this.destroyed || this.tabs.get(tab.id) !== tab || tab.view.webContents.isDestroyed() || tab.revision !== revision) throw new Error(OPERATION_ERRORS.document_changed);
  }

  async _operate(id, expectedRevision, operation, args) {
    let target;
    try { target = this._operationTarget(id, expectedRevision); }
    catch (error) { if (args.targetToken && operation !== 'prepare') throw new Error(OPERATION_ERRORS.target_changed); throw error; }
    const {tab, revision} = target;
    const code = `(${pageOperation.toString()})(${JSON.stringify(tab.documentToken)},${JSON.stringify(operation)},${JSON.stringify(args)})`;
    let result;
    try { result = await tab.view.webContents.executeJavaScriptInIsolatedWorld(INSPECTION_WORLD, [{code}], operation === 'click' || operation === 'fill'); }
    catch { throw new Error('网页操作未完成，请重新读取页面后重试。'); }
    if (operation !== 'click' || !result?.clicked) {
      try { this._sameDocument(tab, revision); }
      catch (error) { if (args.targetToken && operation !== 'prepare') throw new Error(OPERATION_ERRORS.target_changed); throw error; }
    }
    if (args.targetToken && operation !== 'prepare' && result?.error === 'document_changed') throw new Error(OPERATION_ERRORS.target_changed);
    if (result?.error || !result) throw new Error(OPERATION_ERRORS[result?.error] || '网页操作未完成。');
    return {tab, revision, result};
  }

  _prepareDocument(tab) {
    const revision = tab.revision, token = randomUUID();
    const code = `globalThis.__beingBrowserDocument = ${JSON.stringify(token)}; globalThis.__beingBrowserTargets = new Map(); true;`;
    tab.contextPromise = tab.view.webContents.executeJavaScriptInIsolatedWorld(INSPECTION_WORLD, [{code}], false).then(() => {
      if (!this.destroyed && this.tabs.get(tab.id) === tab && tab.revision === revision) tab.documentToken = token;
    }).catch(() => {});
  }

  _detach() {
    const attached = this.attached;
    this.attached = null;
    if (!attached) return;
    if (!attached.tab.view.webContents.isDestroyed()) attached.tab.view.setVisible(false);
    if (!attached.window.isDestroyed()) attached.window.contentView.removeChildView(attached.tab.view);
  }

  _syncView() {
    const tab = this.tabs.get(this.activeTabId), window = this.getWindow();
    if (!this.visible || !tab?.url || tab.view.webContents.isDestroyed() || !window || window.isDestroyed()) { this._detach(); return; }
    const [width, height] = window.getContentSize();
    const x = Math.min(this.bounds.x, width), y = Math.min(this.bounds.y, height);
    const bounds = {x, y, width:Math.min(this.bounds.width, width - x), height:Math.min(this.bounds.height, height - y)};
    if (bounds.width <= 0 || bounds.height <= 0) { this._detach(); return; }
    if (this.attached?.tab !== tab || this.attached.window !== window) {
      this._detach();
      window.contentView.addChildView(tab.view);
      this.attached = {tab, window};
    }
    tab.view.setBounds(bounds);
    tab.view.setVisible(true);
  }
}

module.exports = {DesktopBrowser, BROWSER_PARTITION, MAX_BROWSER_TABS, normalizeBrowserUrl};
