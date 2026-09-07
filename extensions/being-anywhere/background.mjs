import { normalizeSelection } from './being-client.mjs';
import { createFloatingController } from './floating-controller.mjs';
import { installRequest } from './install-link.mjs';
const floating = createFloatingController(chrome);

const MENU = 'being-selection';
const INSTALL_MENU = 'being-install-link';
const locks = new Map();
const publicErrors = new Set(['找不到当前浏览器窗口。', '提问不能超过 8,000 字。', '侧栏中已有 10 段待处理选区，请先处理后继续。', '此页面不允许读取选区。请复制内容后粘贴到侧栏。']);
const trustedPages = new Set(['popup.html', 'sidepanel.html', 'options.html'].map(path => chrome.runtime.getURL(path)));
const initialize = async () => {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  ]);
};
void initialize();
chrome.runtime.onInstalled.addListener(() => {
  void chrome.contextMenus.removeAll().then(() => {
    chrome.contextMenus.create({id: MENU, title: '询问 BeingAnywhere', contexts: ['selection']});
    chrome.contextMenus.create({id: INSTALL_MENU, title: '安装 MCP / Skill 到 Being', contexts: ['link'], targetUrlPatterns: ['https://github.com/*', 'https://raw.githubusercontent.com/*']});
  });
});

function serialize(windowId, task) {
  const work = (locks.get(windowId) || Promise.resolve()).catch(() => {}).then(task);
  locks.set(windowId, work);
  void work.finally(() => { if (locks.get(windowId) === work) locks.delete(windowId); }).catch(() => {});
  return work;
}

async function stage(windowId, value, autoSend = false) {
  if (!Number.isInteger(windowId)) throw new Error('找不到当前浏览器窗口。');
  if (typeof value.prompt !== 'string' || value.prompt.length > 8000) throw new Error('提问不能超过 8,000 字。');
  return serialize(windowId, async () => {
    const key = `queue:${windowId}`;
    const queue = (await chrome.storage.session.get(key))[key] || [];
    if (queue.length >= 10) throw new Error('侧栏中已有 10 段待处理选区，请先处理后继续。');
    if (autoSend && !value.prompt.trim()) throw new Error('提问不能超过 8,000 字。');
    queue.push({ id: crypto.randomUUID(), selection: normalizeSelection(value.selection), prompt: value.prompt.trim(), ...(autoSend ? { autoSend: true } : {}) });
    await chrome.storage.session.set({ [key]: queue });
    return { ok: true };
  });
}

// This function runs in the isolated world. It returns only the user's selection.
export function captureSelection() {
  const active = document.activeElement;
  let text = '';
  if (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') {
    if (active.tagName === 'TEXTAREA' || ['text', 'search', 'url'].includes(active.type)) {
      text = active.value.slice(active.selectionStart || 0, active.selectionEnd || 0);
    }
  } else text = window.getSelection()?.toString() || '';
  return { text: text.slice(0, 20000), title: document.title.slice(0, 300), url: location.origin + location.pathname };
}

async function capture(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'being:capture-selection' });
    if (response?.ok && response.selection?.text) return normalizeSelection(response.selection);
  } catch { /* Restricted pages may need the explicit activeTab fallback. */ }
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: captureSelection });
    return normalizeSelection(results.find(item => item.result?.text)?.result || results[0]?.result);
  } catch {
    throw new Error('此页面不允许读取选区。请复制内容后粘贴到侧栏。');
  }
}

const widgetError = '此页面暂时不能启用浮窗，请刷新网页，或检查扩展的站点访问权限后重试。';
const widgetRestricted = '此页面不支持扩展浮窗，请在普通网页中使用。';

async function probeWidget(tabId, version) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'being:widget-status' }, { frameId: 0 });
    if (result?.ok === true && result.version === version && typeof result.visible === 'boolean') return result;
  } catch { /* An already-open page may not have the content script yet. */ }
  return null;
}

async function widgetState(message, activate) {
  const version = chrome.runtime.getManifest().version;
  if (!Number.isInteger(message.tabId) || message.tabId < 0) {
    return { ok: false, error: '找不到当前网页，请重新打开扩展。' };
  }
  try {
    const tab = await chrome.tabs.get(message.tabId);
    if (!/^https?:\/\//.test(tab.url || '')) {
      return { ok: !activate, status: 'restricted', version, visible: false, ...(activate ? { error: widgetRestricted } : {}) };
    }
    let state = await probeWidget(tab.id, version);
    if (!activate) return { ok: true, status: state ? 'ready' : 'missing', version, visible: state?.visible || false };
    if (!state) {
      // Install the top frame first so an inaccessible child frame cannot prevent activation.
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['content.js'] });
      state = await probeWidget(tab.id, version);
      if (!state) return { ok: false, status: 'missing', version, visible: false, error: '扩展已更新，请刷新网页后重试。' };
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] });
      } catch { /* The top frame remains usable when cross-origin frames are restricted. */ }
    }
    const selection = normalizeSelection(message.selection);
    const shown = await chrome.tabs.sendMessage(tab.id, {
      type: 'being:show', ...(selection.text ? { selection } : {}),
    }, { frameId: 0 });
    const visible = await probeWidget(tab.id, version);
    if (shown?.ok !== true || !visible?.visible) return { ok: false, status: 'missing', version, visible: false, error: widgetError };
    return { ok: true, status: 'ready', version, visible: true };
  } catch {
    return { ok: false, status: 'missing', version, visible: false, error: activate ? widgetError : '无法检查当前页浮窗，请重新打开扩展。' };
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === INSTALL_MENU && tab?.id) {
    let request;
    try { request = installRequest(info.linkUrl); } catch { return; }
    const opened = chrome.sidePanel.open({windowId: tab.windowId});
    void opened.then(() => stage(tab.windowId, {prompt: request.prompt, selection: {text: request.link.url, title: request.link.repository, url: request.link.url}}, true)).catch(() => {});
    return;
  }
  if (info.menuItemId !== MENU || !tab?.id) return;
  const opened = chrome.sidePanel.open({ windowId: tab.windowId });
  void stage(tab.windowId, { selection: { text: info.selectionText, title: tab.title, url: info.frameUrl || info.pageUrl || tab.url }, prompt: '' }).catch(() => {});
  void opened.catch(() => {});
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'open-being' || !tab?.id) return;
  const opened = chrome.sidePanel.open({ windowId: tab.windowId });
  void capture(tab.id).then(selection => stage(tab.windowId, { selection, prompt: '' })).catch(() => {});
  void opened.catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false;
  const floatingJob = floating.handle(message, sender);
  if (floatingJob) { void floatingJob.then(sendResponse); return true; }
  const trusted = !sender.tab && trustedPages.has(sender.url);
  let job;
  if (trusted && sender.url === chrome.runtime.getURL('popup.html') && ['being:widget-status', 'being:widget-activate'].includes(message.type)) {
    const activate = message.type === 'being:widget-activate';
    job = activate ? serialize(`widget:${message.tabId}`, () => widgetState(message, true)) : widgetState(message, false);
  } else if (message.type === 'being:stage' && sender.tab) {
    // Open before any await so Chrome retains the content-script click gesture.
    const opened = chrome.sidePanel.open({ windowId: sender.tab.windowId });
    job = opened.then(() => stage(sender.tab.windowId, {
      selection: { ...message.selection, url: sender.url, title: sender.tab.title }, prompt: message.prompt,
    }));
  } else if (trusted && message.type === 'being:stage') {
    const autoSend = sender.url === chrome.runtime.getURL('popup.html') && message.autoSend === true;
    job = chrome.tabs.get(message.tabId).then(tab => stage(tab.windowId, message, autoSend)).then(async result => {
      if (sender.url === chrome.runtime.getURL('popup.html') && !autoSend) await chrome.storage.session.remove('popupDraft');
      return result;
    });
  } else if (trusted && sender.url === chrome.runtime.getURL('sidepanel.html') && message.type === 'being:claim-shortcut') {
    if (!Number.isInteger(message.windowId) || message.windowId < 0 || typeof message.id !== 'string' || !message.id || message.id.length > 100) {
      sendResponse({ ok: false, error: '无效的快捷提问。' });
      return false;
    }
    job = serialize(message.windowId, async () => {
      const key = `queue:${message.windowId}`;
      const queue = (await chrome.storage.session.get(key))[key] || [];
      const item = queue.find(entry => entry.id === message.id && entry.autoSend === true);
      if (!item) return { ok: true, claimed: false };
      // Remove the intent before granting its single network send, including after a reload.
      await chrome.storage.session.set({ [key]: queue.filter(entry => entry.id !== item.id) });
      return { ok: true, claimed: true, item };
    });
  } else if (trusted && message.type === 'being:capture') {
    job = capture(message.tabId).then(selection => ({ ok: true, selection }));
  } else if (trusted && message.type === 'being:consume') {
    if (!Number.isInteger(message.windowId) || message.windowId < 0 || typeof message.id !== 'string' || !message.id || message.id.length > 100) {
      sendResponse({ ok: false, error: '无效的选区请求。' });
      return false;
    }
    job = serialize(message.windowId, async () => {
      const key = `queue:${message.windowId}`;
      const queue = (await chrome.storage.session.get(key))[key] || [];
      await chrome.storage.session.set({ [key]: queue.filter(item => item.id !== message.id) });
      return { ok: true };
    });
  } else return false;
  void job.then(sendResponse, error => sendResponse({ ok: false, error: publicErrors.has(error?.message) ? error.message : '操作失败，请重试。' }));
  return true;
});

chrome.windows.onRemoved.addListener(windowId => {
  void chrome.storage.session.remove([`queue:${windowId}`, `composer:${windowId}`, `chat:${windowId}`]);
});

chrome.tabs.onRemoved?.addListener(tabId => { void floating.cleanup('tabId', tabId).catch(() => {}); });
chrome.windows.onRemoved.addListener(windowId => { void floating.cleanup('windowId', windowId).catch(() => {}); });
