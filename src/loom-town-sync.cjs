'use strict';

const {libraryRoute} = require('./town-library-contract.cjs');

const TOWN_SYNC_WORLD_ID = 1109;
const KEY = '__beingDesktopTownSync';
const MAX_RECORDS = 256;

function normalizeTownSyncRecords(value) {
  if (!Array.isArray(value)) return [];
  const result = new Map(), conflicts = new Set();
  const routes = new Set(['/api/bonfire/hear', '/api/bonfire/mentions', '/api/fireside/list', '/api/fireside/members', '/api/fireside/hear']);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (let index = Math.max(0, value.length - MAX_RECORDS); index < value.length; index++) {
    const item = Object.getOwnPropertyDescriptor(value, index)?.value;
    if (!item || Object.getPrototypeOf(item) !== Object.prototype) continue;
    const fields = Object.getOwnPropertyDescriptors(item), keys = ['requestId', 'route', 'beingId', 'prompt'];
    if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => !fields[key] || !Object.hasOwn(fields[key], 'value') || typeof fields[key].value !== 'string')) continue;
    const next = Object.fromEntries(keys.map(key => [key, fields[key].value]));
    if (!uuid.test(next.requestId) || !routes.has(next.route) && !libraryRoute(next.route) && !/^\/desktop\/channel\/(feishu|wechat)\/(begin|status)$/.test(next.route) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(next.beingId)
      || next.prompt.length > 160000 || !next.prompt.startsWith(`[Being Desktop Town sync:${next.requestId}]`)) continue;
    next.prompt = next.prompt.replace(/\s+/g, ' ').trim();
    if (conflicts.has(next.requestId)) continue;
    const previous = result.get(next.requestId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(next)) { result.delete(next.requestId); conflicts.add(next.requestId); }
    else result.set(next.requestId, next);
  }
  return [...result.values()];
}

function matchTownSyncMessage(role, text, records) {
  if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) return null;
  if (role === 'user') {
    const normalized = text.replace(/\s+/g, ' ').trim();
    const record = records.find(item => item.prompt === normalized);
    return record ? {requestId:record.requestId, kind:'request'} : null;
  }
  if (role !== 'being') return null;
  const completion=records.find(item=>['已完成。','已完成','失败。','结果不完整。'].some(receipt=>text.trim()===`[Being Desktop Town sync:${item.requestId}] ${receipt}`));
  if(completion)return {requestId:completion.requestId,kind:'result'};
  let value;
  try { value = JSON.parse(text.trim()); } catch { return null; }
  if (value && typeof value === 'object' && !Array.isArray(value) && value.protocol === 'being-desktop-channel-result/1') {
    const required = ['protocol','requestId','route','beingId','channel','status','detail'];
    if (!required.every(key => Object.hasOwn(value,key))
      || Object.keys(value).some(key => ![...required,'qrCodeUrl','qrCodeDataUrl'].includes(key))
      || !['connected','disconnected','pending','registered','disabled','waiting','expired','error','unknown','unsupported'].includes(value.status)
      || typeof value.detail !== 'string'
      || ['qrCodeUrl','qrCodeDataUrl'].some(key => Object.hasOwn(value,key) && typeof value[key] !== 'string')
      || !['feishu','wechat'].includes(value.channel)
      || ![`/desktop/channel/${value.channel}/begin`,`/desktop/channel/${value.channel}/status`].includes(value.route)) return null;
    const own = records.find(item => item.requestId === value.requestId && item.route === value.route && item.beingId === value.beingId);
    return own ? {requestId:own.requestId,kind:'result'} : null;
  }
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).some(key => !['protocol','requestId','route','beingId','httpStatus','data','redactedFields'].includes(key))
    || !['protocol','requestId','route','beingId','httpStatus','data'].every(key => Object.hasOwn(value, key))
    || value.protocol !== 'being-town-agent-read/1' || !Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599
    || value.data === null || typeof value.data !== 'object') return null;
  if (Object.hasOwn(value, 'redactedFields') && (value.route !== '/api/fireside/list' || !Array.isArray(value.redactedFields)
    || value.redactedFields.length > 4000 || value.redactedFields.some(field => typeof field !== 'string' || !/^data\.(owned|joined)\[(0|[1-9]\d{0,3})\]\.key$/.test(field)))) return null;
  const record = records.find(item => !item.route.startsWith('/desktop/channel/') && item.requestId === value.requestId && item.route === value.route && item.beingId === value.beingId);
  return record ? {requestId:record.requestId, kind:'result'} : null;
}

function installTownSync(initialRecords, key, matchMessage) {
  const app = document.getElementById('app'), messages = document.getElementById('messages');
  if (!app || !messages || messages.parentElement !== app) return false;
  if (globalThis[key]?.messages === messages) { globalThis[key].update(initialRecords); return true; }
  globalThis[key]?.detach();
  const hiddenClass = 'being-desktop-town-task-hidden';
  const states = new Map();
  let records = initialRecords, destroyed = false, queued = false, showTasks = false;
  const style = document.createElement('style');
  style.textContent = `#messages > .message.${hiddenClass}{display:none!important}
#app > .being-desktop-town-task-controls{flex:0 0 auto;display:flex;justify-content:flex-end;padding:8px max(28px,calc((100% - 780px)/2));border-bottom:1px solid var(--line,var(--border,#30363d))}
#app > .being-desktop-town-task-controls[hidden]{display:none!important}
.being-desktop-town-task-controls > button{padding:4px 0;min-width:0;min-height:0;border:0;background:transparent;color:var(--muted,var(--text-muted,#8b949e));font:inherit;font-size:12px;cursor:pointer;text-align:left}
.being-desktop-town-task-controls > button:hover{color:var(--text,#c9d1d9)}
.being-desktop-town-task-controls > button:focus-visible{outline:2px solid var(--accent,#58a6ff);outline-offset:3px}`;
  document.head.append(style);
  const controls = document.createElement('div'), toggle = document.createElement('button');
  controls.className = 'being-desktop-town-task-controls';
  controls.hidden = true;
  toggle.type = 'button';
  toggle.className = 'being-desktop-town-task-toggle';
  toggle.setAttribute('aria-controls', 'messages');
  toggle.title = '功能请求与回执归入功能任务。此处只切换显示，原始对话记录仍保留；后台任务仍可能占用聊天执行队列。';
  controls.append(toggle);
  messages.before(controls);

  // Reading rendered block boundaries is independent of display:none, so a
  // hidden message can still be revalidated without changing its contents.
  function visibleText(node) {
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    if (node.tagName === 'BR') return '\n';
    const text = Array.from(node.childNodes, visibleText).join('');
    return /^(P|DIV|PRE|LI|H[1-6])$/.test(node.tagName) ? `\n${text}\n` : text;
  }
  function messageText(content) {
    // Quoted or executable-looking examples are never projected away, even if
    // their text happens to contain an enrolled identifier or result envelope.
    if (content.querySelector('blockquote,script,style,iframe,object,input,textarea,select,pre,code,button,img,video,audio')) return null;
    return visibleText(content);
  }
  function restore(row) {
    if (!states.has(row)) return;
    row.classList.remove(hiddenClass);
    states.delete(row);
  }
  function render() {
    const count = new Set([...states.values()].map(state => state.requestId)).size;
    controls.hidden = count === 0;
    if (!count) showTasks = false;
    const label = `${showTasks ? '隐藏功能记录' : '查看功能记录'} · ${count}`;
    if (toggle.textContent !== label) toggle.textContent = label;
    toggle.setAttribute('aria-expanded', String(showTasks));
    for (const row of states.keys()) {
      if (row.classList.contains(hiddenClass) === showTasks) row.classList.toggle(hiddenClass, !showTasks);
    }
  }
  function scan() {
    queued = false;
    if (destroyed) return;
    if (!messages.isConnected || messages.parentElement !== app) { detach(); return; }
    if (controls.parentElement !== app) messages.before(controls);
    for (const row of states.keys()) if (row.parentElement !== messages) restore(row);
    for (const row of Array.from(messages.children)) {
      const role = row.classList.contains('user') && !row.classList.contains('being') ? 'user'
        : row.classList.contains('being') && !row.classList.contains('user') ? 'being' : '';
      const bodies = Array.from(row.children).filter(child => child.classList.contains('content'));
      const content = bodies.length === 1 ? bodies[0] : null;
      // Loom renders each message as meta + content. Additional visible content
      // is not attributed by proximity and must remain available in the chat.
      const plainRow = content && Array.from(row.childNodes).every(node => node === content
        || node.nodeType === 3 && !node.nodeValue.trim()
        || node.nodeType === 1 && node.classList.contains('meta'));
      const text = row.classList.contains('message') && !row.classList.contains('thinking-indicator') && plainRow && !content.classList.contains('stream-cursor') ? messageText(content) : null;
      const match = text === null ? null : matchMessage(role, text, records);
      if (match) states.set(row, {content, ...match}); else restore(row);
    }
    render();
  }
  const onToggle = event => { event.stopPropagation(); showTasks = !showTasks; render(); };
  toggle.addEventListener('click', onToggle);
  const observer = new MutationObserver(() => {
    if (!destroyed && !queued) { queued = true; queueMicrotask(scan); }
  });
  observer.observe(messages, {childList:true, subtree:true, characterData:true, attributes:true, attributeFilter:['class']});
  observer.observe(app, {childList:true});
  function detach() {
    destroyed = true;
    observer.disconnect();
    for (const row of states.keys()) restore(row);
    records = [];
    toggle.removeEventListener('click', onToggle);
    controls.remove();
    style.remove();
    delete globalThis[key];
  }
  globalThis[key] = Object.freeze({messages,
    update(next) { records = next; scan(); },
    detach,
  });
  scan();
  return true;
}

async function applyLoomTownSync(contents, records = []) {
  if (!contents || contents.isDestroyed()) return false;
  const normalized = normalizeTownSyncRecords(records);
  return contents.executeJavaScriptInIsolatedWorld(TOWN_SYNC_WORLD_ID, [{code:`(${installTownSync.toString()})(${JSON.stringify(normalized)},${JSON.stringify(KEY)},${matchTownSyncMessage.toString()})`}]);
}

async function detachLoomTownSync(contents) {
  if (!contents || contents.isDestroyed()) return;
  return contents.executeJavaScriptInIsolatedWorld(TOWN_SYNC_WORLD_ID, [{code:`globalThis[${JSON.stringify(KEY)}]?.detach()`}]);
}

module.exports = {TOWN_SYNC_WORLD_ID, normalizeTownSyncRecords, matchTownSyncMessage, applyLoomTownSync, detachLoomTownSync};
