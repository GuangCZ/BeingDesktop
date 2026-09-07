const $ = id => document.getElementById(id);
let tab = null, selection = null, busy = false, activating = false, composing = false, initialized = false, widgetStatus = 'checking';
let draftSave = Promise.resolve();
const installedVersion = chrome.runtime.getManifest().version;
$('installed-version').textContent = `v${installedVersion}`;
const error = text => { $('error').textContent = text; $('error').hidden = !text; };
const draftKey = 'popupDraft';
function updateButtons() {
  $('continue').disabled = !initialized || busy || activating;
  $('activate-widget').disabled = !tab || busy || activating || widgetStatus === 'checking' || widgetStatus === 'restricted';
  $('activate-widget').textContent = activating ? '正在启用…' : widgetStatus === 'ready' ? '显示当前页浮窗' : '启用当前页浮窗';
  document.querySelectorAll('[data-prompt]').forEach(button => { button.disabled = !initialized || !tab || busy || activating; });
}
function renderWidget(result) {
  widgetStatus = result?.ok === true && result.version === installedVersion && typeof result.visible === 'boolean' && ['ready', 'missing', 'restricted'].includes(result.status) ? result.status : 'unknown';
  $('widget-status').textContent = {
    ready: '划词浮窗已就绪', missing: '划词浮窗未载入，点击下方按钮启用。',
    restricted: '页面受限制，请在普通网页中使用。', unknown: '暂时无法检查浮窗状态，可点击下方按钮重试。',
  }[widgetStatus];
  updateButtons();
}
async function activateWidget() {
  if (!tab || busy || activating) return;
  activating = true; updateButtons(); error('');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'being:widget-activate', tabId: tab.id, selection });
    renderWidget(result);
    if (widgetStatus === 'ready' && result.visible === true) window.close();
    else error('未能显示浮窗，请刷新网页后重试，或检查扩展的站点访问权限。');
  } catch {
    renderWidget(null); error('未能启用浮窗，请刷新网页并重新打开扩展后重试。');
  } finally { activating = false; updateButtons(); }
}
function persist() {
  const snapshot = { prompt: $('prompt').value, selection, tabId: tab?.id };
  draftSave = draftSave.catch(() => {}).then(() => chrome.storage.session.set({ [draftKey]: snapshot }));
  return draftSave;
}
function render() {
  $('context').hidden = !selection?.text;
  $('source-title').textContent = selection?.title || '网页选区'; $('source-text').textContent = selection?.text || '';
  $('hint').textContent = selection?.text ? `已选中 ${selection.text.length.toLocaleString()} 字` : '先在网页划词，或直接输入问题。';
}
async function stage(event, shortcutPrompt) {
  event.preventDefault();
  const shortcut = typeof shortcutPrompt === 'string';
  if (!initialized || !tab || busy || activating || (!shortcut && (composing || event.isComposing)) || (shortcut && !event.isTrusted)) return;
  const prompt = shortcut ? shortcutPrompt : $('prompt').value.trim();
  if (!prompt && !selection?.text) { error('输入一个问题，或先在网页选中内容。'); $('prompt').focus(); return; }
  busy = true; updateButtons();
  try {
    // Open synchronously; preserve the custom draft before staging a shortcut intent.
    const opened = chrome.sidePanel.open({ windowId: tab.windowId });
    const payload = { type: 'being:stage', tabId: tab.id, selection, prompt, ...(shortcut ? { autoSend: true } : {}) };
    const staged = shortcut ? Promise.all([opened, persist()]).then(() => chrome.runtime.sendMessage(payload)) : chrome.runtime.sendMessage(payload);
    const [result] = await Promise.all([staged, opened]);
    if (!result?.ok) throw new Error(result?.error || '无法加入侧栏，请重试。');
    if (!shortcut) await chrome.storage.session.remove(draftKey);
    window.close();
  } catch (err) { error(err.message || '无法打开侧栏，请重试。'); }
  finally { busy = false; updateButtons(); }
}
$('activate-widget').addEventListener('click', () => { void activateWidget(); });
$('form').addEventListener('submit', event => { void stage(event); });
$('prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void stage(event); } });
$('prompt').addEventListener('compositionstart', () => { composing = true; });
$('prompt').addEventListener('compositionend', () => { composing = false; });
$('prompt').addEventListener('input', () => { void persist().catch(() => error('草稿暂存失败，请保留当前窗口。')); });
$('remove').addEventListener('click', () => { selection = null; render(); void persist(); });
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', event => { void stage(event, button.dataset.prompt); }));
$('settings').addEventListener('click', () => { void chrome.runtime.openOptionsPage(); });
$('open-panel').addEventListener('click', event => { event.preventDefault(); if (tab) void chrome.sidePanel.open({ windowId: tab.windowId }).then(() => window.close(), () => error('无法打开侧栏，请重试。')); });
async function initialize() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !Number.isInteger(tab.id)) { renderWidget(null); throw new Error('No active tab'); }
  try { renderWidget(await chrome.runtime.sendMessage({ type: 'being:widget-status', tabId: tab.id })); }
  catch { renderWidget(null); }
  const saved = (await chrome.storage.session.get(draftKey))[draftKey];
  if (saved?.tabId === tab?.id && (saved.prompt || saved.selection?.text)) { $('prompt').value = saved.prompt || ''; selection = saved.selection; }
  else {
    const result = await chrome.runtime.sendMessage({ type: 'being:capture', tabId: tab.id });
    if (result?.ok) selection = result.selection;
    else error(result?.error || '此页面无法读取选区，请粘贴内容后提问。');
  }
  initialized = true; updateButtons(); render(); $('prompt').focus();
}
void initialize().catch(() => { if (widgetStatus === 'checking') renderWidget(null); render(); error('此页面不支持读取选区。可直接打开侧栏粘贴内容。'); });
