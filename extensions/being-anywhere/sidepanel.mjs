import { BeingClient, parseConnection, composeMessage, normalizeSelection } from './being-client.mjs';
import { sendAndFollow } from './reply-followup.mjs';
import { createActivityView } from './activity-view.mjs';
import { installRequest, parseInstallLink, installSummary } from './install-link.mjs';

const $ = id => document.getElementById(id);
const progress = createActivityView({ container: $('being-progress'), scrollContainer: $('messages') });
const floatingMode = location.pathname.endsWith('/floating.html');
const floatingId = floatingMode ? new URL(location.href).searchParams.get('id') : null;
let storageScope, floatingContext = null, transferred = false, handoffs = [], adoptingHandoff = false;
let connection = null, client = null, selection = null, sessionId = null, queue = [], messages = [];
let windowId, busy = false, controller = null, connectionEpoch = 0, adopting = false, composing = false;
let saveChain = Promise.resolve(), composerChain = Promise.resolve();
const error = text => { $('error').textContent = text || ''; $('error').hidden = !text; };
const busyState = value => {
  busy = value;
  $('stop').hidden = !value;
  $('history').disabled = value || transferred || adopting;
  $('send').disabled = value || transferred || adopting;
  if ($('transfer')) $('transfer').disabled = value || transferred || adopting || !client;
  document.querySelectorAll('[data-prompt]').forEach(button => { button.disabled = value || transferred || adopting || adoptingHandoff; });
  for (const id of ['install-toggle', 'install-submit', 'install-url', 'install-kind']) if ($(id)) $(id).disabled = value || transferred || adopting || adoptingHandoff;
};

function persistChat() {
  const epoch = connectionEpoch;
  const snapshot = { identity: connection?.url, sessionId, messages: messages.slice(-100) };
  saveChain = saveChain.catch(() => {}).then(() => epoch === connectionEpoch ? chrome.storage.session.set({ [`chat:${storageScope}`]: snapshot }) : undefined);
  return saveChain;
}
function persistComposer() {
  const snapshot = { prompt: $('prompt').value, selection };
  composerChain = composerChain.catch(() => {}).then(() => chrome.storage.session.set({ [`composer:${storageScope}`]: snapshot }));
  return composerChain;
}
function renderContext() {
  $('context').hidden = !selection?.text;
  $('source-title').textContent = selection?.title || '网页选区';
  $('source-title').title = selection?.url || '';
  $('source-text').textContent = selection?.text || '';
  $('prompt').placeholder = selection?.text ? '问问这段内容…' : '继续问…';
}
function appendMessage(message) {
  $('welcome').hidden = true;
  const article = document.createElement('article');
  article.className = `message ${message.role}`;
  const label = document.createElement('div');
  label.className = 'message-label';
  if (message.role === 'being') {
    const logo = document.createElement('img');
    logo.src = 'icons/being-20.png';
    logo.srcset = [16, 20, 24, 32, 40, 48, 64, 80, 96, 112, 128, 160, 192, 256].map(size => `icons/being-${size}.png ${size}w`).join(', ');
    logo.sizes = '18px';
    logo.alt = '';
    label.append(logo);
  }
  label.append(document.createTextNode(message.role === 'user' ? '你' : message.role === 'being' ? connection?.beingName || 'Being' : '提示'));
  const copy = document.createElement('button'); copy.className = 'message-copy'; copy.textContent = '复制'; copy.title = '复制消息';
  copy.addEventListener('click', () => { void navigator.clipboard.writeText(message.content).then(() => { copy.textContent = '已复制'; }, () => error('复制失败，请选中文字手动复制。')); });
  label.append(copy);
  const content = document.createElement('div'); content.className = 'message-content'; content.textContent = message.role === 'user' ? installSummary(message.content) || message.content : message.content;
  article.append(label, content);
  if (message.selection?.text) {
    const details = document.createElement('details'), summary = document.createElement('summary'), quote = document.createElement('p');
    summary.textContent = '引用';
    summary.title = message.selection.title || '选中内容';
    quote.textContent = message.selection.text;
    details.append(summary, quote);
    if (message.selection.url) {
      const link = document.createElement('a'); link.textContent = '查看来源 ↗'; link.href = message.selection.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; details.append(link);
    }
    article.append(details);
  }
  $('transcript').append(article);
  return content;
}
function repaint() {
  $('transcript').replaceChildren(); $('welcome').hidden = messages.length > 0;
  for (const message of messages) appendMessage(message);
}
function scroll() { $('messages').scrollTop = $('messages').scrollHeight; }
function note(content) { const message = { role: 'system', content }; messages.push(message); appendMessage(message); scroll(); }

async function adoptNext() {
  if (floatingMode || busy || composing || adoptingHandoff || adopting || !queue.length) return;
  const shortcut = queue.find(item => item.autoSend === true);
  if (shortcut) {
    if (!client || transferred) return;
    const epoch = connectionEpoch;
    let advanced = false;
    adopting = true; busyState(busy);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'being:claim-shortcut', windowId, id: shortcut.id });
      if (!result?.ok) throw new Error();
      queue = queue.filter(item => item.id !== shortcut.id); renderQueue(); advanced = true;
      if (epoch !== connectionEpoch || !result.claimed) return;
      const item = result.item;
      if (item?.autoSend !== true || typeof item.prompt !== 'string' || !item.prompt.trim()) throw new Error();
      await send(undefined, { prompt: item.prompt, selection: normalizeSelection(item.selection), claimed: true });
    } catch { error('快捷提问暂未启动，请重试；已发送的提问不会自动重发。'); }
    finally {
      adopting = false;
      busyState(busy);
      if (advanced || epoch !== connectionEpoch) { void adoptHandoff(); void adoptNext(); }
    }
    return;
  }
  if ($('prompt').value.trim() || selection?.text) return;
  adopting = true;
  const item = queue[0];
  selection = normalizeSelection(item.selection); $('prompt').value = item.prompt || ''; renderContext();
  try {
    await persistComposer();
    const result = await chrome.runtime.sendMessage({ type: 'being:consume', windowId, id: item.id });
    if (!result?.ok) throw new Error();
  } catch { error('选区已载入，但暂存状态未更新。请勿重复加入相同内容。'); }
  finally { adopting = false; busyState(busy); if (queue.some(item => item.autoSend === true)) void adoptNext(); }
  $('prompt').focus();
}
function renderQueue() {
  $('pending').hidden = queue.length === 0;
  $('pending').textContent = queue.some(item => item.autoSend === true) ? `${queue.length} 项待处理 · 空闲时自动提问` : `${queue.length} 段网页内容待加入`;
}
function setQueue(items) {
  queue = Array.isArray(items) ? items : [];
  renderQueue();
  void adoptNext();
}

async function configure(value) {
  const epoch = ++connectionEpoch;
  controller?.abort(); progress.reset(); busyState(true); client = null; connection = null; sessionId = null; messages = []; repaint();
  $('open-loom').hidden = true; $('connection-label').textContent = '尚未连接 Being';
  if (transferred) { busyState(false); return; }
  if (!value?.url) { $('activity').textContent = '尚未连接'; busyState(false); return; }
  try {
    const nextConnection = parseConnection(value.url);
    const nextClient = new BeingClient(nextConnection);
    const saved = (await chrome.storage.session.get(`chat:${storageScope}`))[`chat:${storageScope}`];
    if (epoch !== connectionEpoch) return;
    connection = nextConnection; client = nextClient;
    $('connection-label').textContent = `${connection.beingName} · ${new URL(connection.displayUrl).host}`;
    $('open-loom').hidden = false;
    if (saved?.identity === connection.url) { messages = saved.messages || []; sessionId = saved.sessionId || null; repaint(); scroll(); }
    $('activity').textContent = '就绪';
  } catch { if (epoch === connectionEpoch) error('保存的连接无效，请在设置中重新连接。'); }
  finally { if (epoch === connectionEpoch) { busyState(false); if (!floatingMode) void adoptNext(); } }
}
async function send(event, shortcut = null) {
  event?.preventDefault();
  if (busy || transferred || (adopting && !shortcut?.claimed) || (composing && !shortcut)) return;
  const prompt = shortcut ? shortcut.prompt : $('prompt').value.trim();
  if (!prompt) { error(selection?.text ? '补充一个问题，或选择总结、解释、翻译。' : '请先输入想对 Being 说的话。'); $('prompt').focus(); return; }
  if (!client) { error('请先打开设置，连接你的 Being。'); return; }
  const submittedSelection = shortcut ? shortcut.selection : selection;
  let message;
  try { message = composeMessage(prompt, submittedSelection); } catch (err) { error(err.message); return; }
  const epoch = connectionEpoch, thisClient = client;
  controller = new AbortController(); const signal = controller.signal;
  const localUser = { role: 'user', content: prompt, selection: submittedSelection };
  messages.push(localUser); appendMessage(localUser); scroll();
  busyState(true); error(''); $('activity').textContent = '正在发送…';
  progress.start();
  let reply = null, replyElement = null, cleared = false, lastSave = 0;
  const clearSubmitted = () => {
    if (cleared) return;
    cleared = true;
    if (shortcut) return;
    if ($('prompt').value.trim() === prompt && selection === submittedSelection) {
      $('prompt').value = ''; selection = null; renderContext(); void persistComposer().catch(() => {});
    }
  };
  try {
    await Promise.all([persistChat(), shortcut ? persistComposer() : Promise.resolve()]);
    const result = await sendAndFollow(thisClient, { message, sessionId, signal, onState: state => {
      if (epoch !== connectionEpoch) return;
      progress.setState(state);
      $('activity').textContent = ({ reconnecting: '正在接续…', thinking: '思考中…', acting: '处理中…', replying: '回复中…', sending: '正在发送…' })[state] || '等待回复…';
    }, onEvent: event => {
      if (epoch !== connectionEpoch) return;
      clearSubmitted();
      progress.handle(event);
      if (event.type === 'content_block_delta') {
        const delta = event.data.delta?.text;
        if (typeof delta !== 'string' || !delta) return;
        const nearBottom = $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 100;
        if (!reply) { reply = { role: 'being', content: '' }; messages.push(reply); replyElement = appendMessage(reply); }
        reply.content += delta; replyElement.textContent = reply.content; replyElement.classList.add('is-streaming');
        $('activity').textContent = '回复中…'; if (nearBottom) scroll();
      } else if (event.type === 'message_stop') {
        if (typeof event.data.session_id === 'string') sessionId = event.data.session_id;
        replyElement?.classList.remove('is-streaming');
        reply = null; replyElement = null;
      } else if (event.type === 'tool_use') $('activity').textContent = '处理中…';
      else if (event.type === 'thinking' || event.type === 'reasoning') $('activity').textContent = '思考中…';
      if (Date.now() - lastSave > 700 || event.type === 'message_stop') { lastSave = Date.now(); void persistChat().catch(() => {}); }
    } });
    if (epoch !== connectionEpoch) return;
    clearSubmitted();
    replyElement?.classList.remove('is-streaming');
    if (result.unconfirmed) {
      progress.finish('unconfirmed');
      $('activity').textContent = '等待回复';
      note('回复尚未确认，可同步历史查看。');
    } else {
      progress.finish('complete');
      $('activity').textContent = '就绪';
    }
  } catch (err) {
    if (epoch !== connectionEpoch) return;
    replyElement?.classList.remove('is-streaming');
    progress.finish(err.name === 'AbortError' ? 'stopped' : 'error');
    if (err.name === 'AbortError') note('已停止接收。Being 可能仍在处理，稍后可同步历史查看结果。');
    else { error(err.message || '连接失败，请稍后重试。'); note('本次回复未完整接收。请先同步历史核对是否送达，再决定是否重发。'); }
    $('activity').textContent = '请同步历史核对';
  } finally {
    if (epoch === connectionEpoch) {
      busyState(false); controller = null; await persistChat().catch(() => error('本地记录未能保存，请同步 Being 历史查看。'));
      if (!floatingMode) { void adoptHandoff(); void adoptNext(); }
    }
  }
}

$('chat-form').addEventListener('submit', event => { void send(event); });
// The explicit install button is the user gesture; pasting a URL never sends.
$('install-toggle').addEventListener('click', event => {
  if (!event.isTrusted || busy || transferred || adopting || adoptingHandoff) return;
  const form = $('install-form'); form.hidden = !form.hidden;
  $('install-toggle').setAttribute('aria-expanded', String(!form.hidden));
  if (!form.hidden) {
    if (!$('install-url').value) {
      try { $('install-url').value = parseInstallLink(selection?.text || $('prompt').value).url; } catch { /* A normal passage is not an install link. */ }
    }
    $('install-url').focus();
  }
});
$('install-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!event.isTrusted || busy || transferred || adopting || adoptingHandoff) return;
  if (!client) { error('请先打开设置，连接你的 Being。'); return; }
  try {
    const request = installRequest($('install-url').value, $('install-kind').value);
    $('install-form').hidden = true; $('install-toggle').setAttribute('aria-expanded', 'false');
    // Preserve the ordinary chat draft and selection when starting installation.
    void send(undefined, {prompt: request.prompt, selection: {text: request.link.url, title: request.link.repository, url: request.link.url}});
  } catch (err) { error(err.message); }
});
$('install-url').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault(); });
$('prompt').addEventListener('input', () => { void persistComposer().catch(() => error('输入暂存失败，请保留当前窗口。')); });
$('prompt').addEventListener('compositionstart', () => { composing = true; });
$('prompt').addEventListener('compositionend', () => { composing = false; if (!floatingMode) void adoptNext(); });
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
});
$('remove-context').addEventListener('click', () => { selection = null; renderContext(); void persistComposer(); });
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', event => {
  if (!event.isTrusted || busy || transferred || adopting || adoptingHandoff) return;
  void send(undefined, { prompt: button.dataset.prompt, selection });
}));
$('settings').addEventListener('click', () => { void chrome.runtime.openOptionsPage(); });
$('open-loom').addEventListener('click', event => { event.preventDefault(); if (connection) void chrome.tabs.create({ url: connection.url }); });
$('stop').addEventListener('click', () => controller?.abort());
$('pending').addEventListener('click', () => {
  if (queue.some(item => item.autoSend === true)) void adoptNext();
  else if ($('prompt').value.trim() || selection?.text) error('请先发送当前草稿，或清空输入并移除当前引用，再加入下一段。');
  else void adoptNext();
});
$('attach').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    const result = await chrome.runtime.sendMessage({ type: 'being:capture', tabId: tab.id });
    if (!result?.ok) throw new Error(result?.error || '无法读取选区。');
    if (!result.selection?.text) throw new Error('请先在网页上选中文字，或使用网页中的 Be 划词按钮。');
    if (selection?.text) throw new Error('请先移除当前引用，再加入新的选区。');
    selection = result.selection; renderContext(); await persistComposer(); error('');
  } catch (err) { error(err.message); }
});
$('history').addEventListener('click', async () => {
  if (!client || busy) return;
  const epoch = connectionEpoch; controller = new AbortController(); busyState(true); error(''); $('activity').textContent = '同步中…';
  try {
    const history = await client.readHistory({ signal: controller.signal });
    if (epoch !== connectionEpoch) return;
    messages = history; progress.reset(); repaint(); scroll(); await persistChat(); $('activity').textContent = '已同步';
  } catch (err) { if (epoch === connectionEpoch) error(err.name === 'AbortError' ? '已取消历史同步。' : err.message); }
  finally { if (epoch === connectionEpoch) { busyState(false); controller = null; if (!floatingMode) void adoptNext(); } }
});


function setHandoffs(items) {
  handoffs = Array.isArray(items) ? items : [];
  $('incoming').hidden = !handoffs.length;
  $('incoming').textContent = handoffs.length + ' 段浮窗对话待接续 · 转到此侧栏';
  void adoptHandoff();
}
async function adoptHandoff() {
  if (floatingMode || busy || adopting || adoptingHandoff || !handoffs.length || $('prompt').value.trim() || selection?.text || !connection) return;
  const item = handoffs[0];
  if (item.identity !== connection.url) { error('待接续对话属于另一个 Being，请切回原连接后接续。'); return; }
  const epoch = connectionEpoch;
  adoptingHandoff = true; busyState(true); $('stop').hidden = true;
  $('prompt').disabled = true;
  document.querySelectorAll('[data-prompt], #attach, #remove-context').forEach(button => { button.disabled = true; });
  try {
    await Promise.all([saveChain, composerChain]);
    if (epoch !== connectionEpoch) return;
    const result = await chrome.runtime.sendMessage({ type: 'being:consume-handoff', windowId, id: item.id });
    if (!result?.ok) throw new Error();
    if (epoch !== connectionEpoch) return;
    if (result.alreadyConsumed) { handoffs = handoffs.filter(entry => entry.id !== item.id); return; }
    const received = result.handoff;
    if (!received || received.identity !== connection.url) throw new Error();
    messages = received.messages || []; sessionId = received.sessionId || null; progress.reset();
    $('prompt').value = received.composer?.prompt || '';
    selection = received.composer?.selection || null;
    repaint(); renderContext(); scroll();
    $('activity').textContent = '已接续';
  } catch { error('暂时无法接续，对话仍保存在待接续列表中，请重试。'); }
  finally {
    adoptingHandoff = false;
    $('prompt').disabled = false;
    document.querySelectorAll('[data-prompt], #attach, #remove-context').forEach(button => { button.disabled = false; });
    if (epoch === connectionEpoch) { busyState(false); void adoptNext(); }
  }
}
$('incoming').addEventListener('click', () => {
  if (busy || $('prompt').value.trim() || selection?.text) error('请先发送或清空当前草稿，再接续浮窗对话。');
  else void adoptHandoff();
});
$('transfer')?.addEventListener('click', () => {
  if (busy || transferred || !floatingContext || !client) return;
  const epoch = connectionEpoch;
  // Open now; save the transcript before handing it to the already-open side panel.
  const opened = chrome.sidePanel.open({ windowId });
  busyState(true); $('stop').hidden = true; error('');
  $('prompt').disabled = true;
  document.querySelectorAll('[data-prompt], #attach, #remove-context').forEach(button => { button.disabled = true; });
  void (async () => {
    try {
      await Promise.all([opened, persistChat(), persistComposer()]);
      if (epoch !== connectionEpoch) return;
      const result = await chrome.runtime.sendMessage({ type: 'being:float-transfer', id: floatingId });
      if (!result?.ok) throw new Error(result?.error || '无法移到侧栏，请重试。');
      transferred = true;
      $('activity').textContent = '已移到侧栏继续对话';
      $('prompt').disabled = true;
      window.parent.postMessage({ type: 'being:float-dismiss', id: floatingId }, '*');
    } catch { error('暂时无法移到侧栏，对话和输入仍保留在这里。'); }
    finally {
      if (epoch === connectionEpoch) busyState(false);
      if (!transferred) { $('prompt').disabled = false; document.querySelectorAll('[data-prompt], #attach, #remove-context').forEach(button => { button.disabled = false; }); }
    }
  })();
});

async function initialize() {
  busyState(true);
  let initialFloat = null;
  if (floatingMode) {
    if (!/^[a-f0-9-]{36}$/.test(floatingId || '')) throw new Error('Invalid floating context');
    initialFloat = await chrome.runtime.sendMessage({ type: 'being:float-context', id: floatingId });
    if (!initialFloat?.ok) throw new Error('Expired floating context');
    floatingContext = initialFloat.context;
    windowId = floatingContext.windowId;
  } else windowId = (await chrome.windows.getCurrent()).id;
  storageScope = floatingMode ? 'float-' + floatingId : windowId;
  if (initialFloat?.moved) {
    transferred = true;
    $('prompt').disabled = true;
    busyState(false);
    note('这段对话已移到侧栏，请在侧栏继续。');
    $('activity').textContent = '已移到侧栏';
    return;
  }
  let initializing = true, revision = 0;
  const latest = {};
  chrome.storage.onChanged.addListener((changes, area) => {
    if (floatingMode && area === 'session' && changes[`float:${floatingId}`]?.newValue?.moved) {
      transferred = true; controller?.abort(); client = null;
      $('prompt').disabled = true; busyState(false);
      $('activity').textContent = '已移到侧栏';
    }
    if (area === 'local' && changes.connection) {
      if (initializing) { latest.connection = changes.connection.newValue; revision++; }
      else void configure(changes.connection.newValue);
    }
    if (!floatingMode && area === 'session' && changes[`queue:${windowId}`]) {
      if (initializing) latest.queue = changes[`queue:${windowId}`].newValue;
      else setQueue(changes[`queue:${windowId}`].newValue);
    }
    if (!floatingMode && area === 'session' && changes[`handoff:${windowId}`]) {
      if (initializing) latest.handoffs = changes[`handoff:${windowId}`].newValue;
      else setHandoffs(changes[`handoff:${windowId}`].newValue);
    }
  });
  const [local, session] = await Promise.all([chrome.storage.local.get('connection'), chrome.storage.session.get([`composer:${storageScope}`, `queue:${windowId}`, `handoff:${windowId}`])]);
  const draft = session[`composer:${storageScope}`];
  if (draft) { $('prompt').value = draft.prompt || ''; selection = draft.selection; renderContext(); }
  else if (initialFloat) { $('prompt').value = floatingContext.prompt; selection = floatingContext.selection; renderContext(); await persistComposer(); }
  let appliedRevision;
  do {
    appliedRevision = revision;
    await configure(Object.hasOwn(latest, 'connection') ? latest.connection : local.connection);
  } while (appliedRevision !== revision);
  initializing = false;
  if (floatingMode) {
    if (initialFloat.autoSend && client) await send();
    else if (!client) error('先在设置中连接 Being，然后在这里发送已保留的问题。');
    else if (!messages.length) error('这段提问已经启动过，请先同步历史核对是否送达，再决定是否重发。');
  } else {
    setHandoffs(Object.hasOwn(latest, 'handoffs') ? latest.handoffs : session[`handoff:${windowId}`]);
    setQueue(Object.hasOwn(latest, 'queue') ? latest.queue : session[`queue:${windowId}`]);
  }
}
window.addEventListener('pagehide', () => { controller?.abort(); });
void initialize().catch(() => { error(floatingMode ? '浮窗已过期，请重新选择网页内容并提问。' : '扩展初始化失败，请关闭侧栏后重新打开。'); busyState(true); $('stop').hidden = true; });
