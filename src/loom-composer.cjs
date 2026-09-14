'use strict';

const fs = require('node:fs');
const path = require('node:path');
const kitCatalog = require('../renderer/kit-catalog.js');
const {tokenAtCaret, composerSuggestions, replaceComposerToken, composerReferences, buildKitPrompt} = require('../renderer/composer-helpers.js');
const kitIconCache = new Map();
const BUILTIN_KITS = Object.freeze([
  Object.freeze({id:'being-search',name:'search',description:'网络搜索 · 搜索互联网并读取网页正文。',builtin:'search'}),
  Object.freeze({id:'being-browse',name:'browse',description:'网页读取 · 读取公开网页，支持 JavaScript 渲染。',builtin:'browse'}),
]);

function bundledKitIcon(id) {
  const source = Object.hasOwn(kitCatalog, id) ? kitCatalog[id].icon : '';
  if (!/^assets\/(?:brands|kit-symbols)\/[a-zA-Z0-9_-]+\.(?:svg|png)$/.test(source)) return '';
  if (!kitIconCache.has(source)) {
    try {
      // Embed only bundled artwork; the remote page never receives local file URLs.
      const bytes = fs.readFileSync(path.join(__dirname, '../renderer', source));
      const mime = source.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
      kitIconCache.set(source, `data:${mime};base64,${bytes.toString('base64')}`);
    } catch { kitIconCache.set(source, ''); }
  }
  return kitIconCache.get(source);
}

// The remote page receives DOM enhancements in an isolated world, never a preload.
const COMPOSER_WORLD_ID = 1107;
const COMPOSER_KEY = '__beingDesktopComposer';

function normalizeComposerData(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  const clean = (text, limit) => typeof text === 'string' ? text.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : '';
  const normalize = (items, kind) => {
    const result = [], ids = new Set(), handles = new Set();
    for (const item of Array.isArray(items) ? items.slice(0, 1000) : []) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) || ids.has(item.id)) continue;
      const name = clean(item.name || item.display_name || item.id, 100);
      let handle = kind === 'member' ? item.id : name.replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_.-]/gu, '') || item.id;
      if (handles.has(handle.toLocaleLowerCase())) handle = `${handle}-${item.id}`;
      if (handles.has(handle.toLocaleLowerCase())) continue;
      ids.add(item.id);
      handles.add(handle.toLocaleLowerCase());
      result.push({id:item.id, name, handle, description:clean(item.description || item.bio, 220), kind, installed:item.installed === true || BUILTIN_KITS.includes(item), icon:kind === 'kit' ? bundledKitIcon(item.id) : '', builtin:kind === 'kit' && BUILTIN_KITS.includes(item) ? item.builtin : ''});
    }
    return result;
  };
  return {kits:normalize([...BUILTIN_KITS, ...(Array.isArray(value.kits) ? value.kits.filter(item => item?.installed === true).slice(0,1000) : [])], 'kit'), members:normalize(value.members, 'member'), kitsError:clean(value.kitsError, 200), membersError:clean(value.membersError, 200)};
}

function installComposer(initialData, key, helpers) {
  if (globalThis[key]) { globalThis[key].update(initialData); return true; }
  const input = document.getElementById('input');
  const row = document.getElementById('input-row');
  const send = document.getElementById('send-btn');
  const messages = document.getElementById('messages');
  const app = document.getElementById('app');
  if (!app || !input || input.tagName !== 'TEXTAREA' || !row || !send || !messages || !row.contains(input) || !row.contains(send) || !app.contains(row) || !app.contains(messages)) return false;
  const root = document.documentElement;
  let data = initialData, token = null, suggestions = [], selected = 0, composing = false, compositionTimer = null, closedToken = '', pending = null, destroyed = false;
  const queue = [], listeners = [];
  const menu = document.createElement('div');
  menu.id = 'desktop-composer-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'listbox');
  const notice = document.createElement('div');
  notice.id = 'desktop-composer-notice';
  notice.setAttribute('aria-live', 'polite');
  const status = document.createElement('div');
  status.id = 'desktop-composer-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  row.append(menu);
  row.parentElement.append(notice, status);
  const original = {placeholder:input.placeholder, role:input.getAttribute('role'), autocomplete:input.getAttribute('aria-autocomplete'), controls:input.getAttribute('aria-controls')};
  input.placeholder = '输入消息，/ 调用 Kit，@ 通知 Being';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', menu.id);
  input.setAttribute('aria-expanded', 'false');

  const valid = () => !destroyed && document.documentElement === root && input.isConnected && send.isConnected;
  const on = (target, name, callback, capture = false) => {
    target.addEventListener(name, callback, capture);
    listeners.push(() => target.removeEventListener(name, callback, capture));
  };
  const close = () => {
    menu.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    token = null;
    suggestions = [];
  };
  const consume = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  function renderSelection() {
    for (let i = 0; i < menu.children.length; i++) {
      const child = menu.children[i];
      if (child.dataset.index !== undefined) child.setAttribute('aria-selected', Number(child.dataset.index) === selected ? 'true' : 'false');
    }
    const active = menu.querySelector(`[data-index="${selected}"]`);
    if (active) { input.setAttribute('aria-activedescendant', active.id); active.scrollIntoView({block:'nearest'}); }
  }
  function refresh() {
    if (!valid()) return;
    const members = helpers.composerReferences(input.value, data.members, '@');
    const kits = helpers.composerReferences(input.value, data.kits, '/');
    const lines = [];
    if (kits.length) lines.push(`调用 ${kits.map(item => '/' + item.handle).join('、')} · 由 Being 检查可用性并调用`);
    if (members.length) lines.push(`发送后此消息会公开到篝火，并通知 ${members.map(item => '@' + item.name).join('、')}`);
    notice.textContent = lines.join('　');
    notice.hidden = lines.length === 0;
    if (composing || document.activeElement !== input || input.disabled || input.readOnly) { close(); return; }
    const nextToken = helpers.tokenAtCaret(input.value, input.selectionStart, input.selectionEnd);
    if (!nextToken || closedToken === `${nextToken.start}:${nextToken.prefix}${nextToken.query}`) { close(); return; }
    const previous = token && `${token.start}:${token.prefix}${token.query}`;
    token = nextToken;
    suggestions = helpers.composerSuggestions(data, token);
    if (previous !== `${token.start}:${token.prefix}${token.query}`) selected = 0;
    selected = Math.min(selected, Math.max(0, suggestions.length - 1));
    menu.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'desktop-composer-heading';
    heading.textContent = token.kind === 'kit' ? '选择 Kit' : '通知 Being member';
    menu.append(heading);
    if (!suggestions.length) {
      const empty = document.createElement('div');
      empty.className = 'desktop-composer-empty';
      const error = token.kind === 'kit' ? data.kitsError : data.membersError;
      empty.textContent = error || (token.query ? '没有匹配结果' : token.kind === 'kit' ? '暂无可用 Kit' : '暂无 Being member');
      menu.append(empty);
    }
    for (let index = 0; index < suggestions.length; index++) {
      const item = suggestions[index];
      const option = document.createElement('button');
      option.type = 'button';
      option.tabIndex = -1;
      option.id = `desktop-composer-option-${index}`;
      option.className = 'desktop-composer-option';
      option.dataset.index = String(index);
      option.setAttribute('role', 'option');
      if (item.kind === 'kit') {
        const icon = document.createElement('span');
        icon.className = 'desktop-composer-icon';
        icon.setAttribute('aria-hidden', 'true');
        const fallback = document.createElement('span');
        fallback.className = 'desktop-composer-initial';
        fallback.textContent = Array.from(item.name)[0]?.toUpperCase() || '?';
        icon.append(fallback);
        if (item.icon) {
          const image = document.createElement('img');
          image.alt = '';
          image.width = image.height = 32;
          image.draggable = false;
          image.addEventListener('load', () => { fallback.hidden = true; });
          image.addEventListener('error', () => { image.remove(); fallback.hidden = false; }, {once:true});
          image.src = item.icon;
          icon.append(image);
        }
        option.append(icon);
      }
      const copy = document.createElement('span');
      copy.className = 'desktop-composer-copy';
      const label = document.createElement('strong');
      label.textContent = token.prefix + (item.kind === 'member' ? item.name : item.handle);
      const detail = document.createElement('span');
      detail.className = 'desktop-composer-detail';
      detail.textContent = item.kind === 'member' ? `@${item.id}${item.description ? ' · ' + item.description : ''}` : item.description || '由 Being 调用工具包';
      copy.append(label, detail);
      option.append(copy);
      option.addEventListener('mousedown', event => event.preventDefault());
      option.addEventListener('click', event => { if (event.isTrusted) { consume(event); select(index); } });
      menu.append(option);
    }
    menu.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    renderSelection();
  }
  function select(index) {
    if (!valid() || !token || !suggestions[index] || composing) return;
    const current = helpers.tokenAtCaret(input.value, input.selectionStart, input.selectionEnd);
    if (!current || current.start !== token.start || current.query !== token.query || current.kind !== token.kind) { refresh(); return; }
    const replacement = helpers.replaceComposerToken(input.value, token, suggestions[index]);
    input.value = replacement.text;
    input.setSelectionRange(replacement.caret, replacement.caret);
    closedToken = '';
    input.dispatchEvent(new Event('input', {bubbles:true}));
    input.focus();
    refresh();
  }
  function settleSend(candidate) {
    if (pending !== candidate || !valid()) return;
    pending = null;
    if (input.value === '') {
      if (candidate.memberIds.length) {
        queue.push({id:candidate.id, type:'mentions', text:candidate.text, memberIds:candidate.memberIds});
        status.textContent = '正在通知篝火中的 Being…';
        status.dataset.state = 'pending';
      }
    } else if (input.value === candidate.expanded && candidate.expanded !== candidate.text) {
      // Loom did not accept the send; preserve the user's original draft.
      input.value = candidate.text;
      input.setSelectionRange(candidate.start, candidate.end);
      input.dispatchEvent(new Event('input', {bubbles:true}));
    }
    refresh();
  }
  function sending(event) {
    if (!valid() || !event.isTrusted || composing || input.disabled || input.readOnly || send.disabled || pending || !input.value.trim()) return;
    const text = input.value;
    const memberIds = helpers.composerReferences(text, data.members, '@').map(item => item.id);
    const expanded = helpers.buildKitPrompt(text, data.kits);
    if (!memberIds.length && text === expanded) { close(); return; }
    if (memberIds.length > 20 || (memberIds.length && text.length > 4000) || queue.length >= 20) {
      consume(event);
      status.textContent = memberIds.length > 20 ? '每条消息最多通知 20 位 Being。' : text.length > 4000 ? '篝火通知最多 4000 个字符，请缩短消息后发送。' : '通知仍在处理，请稍后发送。';
      status.dataset.state = 'error';
      return;
    }
    const candidate = {id:crypto.randomUUID(), text, expanded, memberIds, start:input.selectionStart, end:input.selectionEnd};
    pending = candidate;
    close();
    if (expanded !== text) {
      input.value = expanded;
      input.dispatchEvent(new Event('input', {bubbles:true}));
    }
    // Native Loom clears an accepted draft synchronously. Never publish rejected sends.
    // A microtask can run between capture and target listeners in Chromium.
    // A new task observes the completed native event dispatch instead.
    setTimeout(() => settleSend(candidate), 0);
  }
  on(document, 'keydown', event => {
    if (event.target !== input || !valid()) return;
    if (composing || event.isComposing || event.keyCode === 229) {
      if (event.key === 'Enter') event.stopImmediatePropagation();
      return;
    }
    if (!menu.hidden && !event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      if (event.key === 'Escape') { consume(event); closedToken = token ? `${token.start}:${token.prefix}${token.query}` : ''; close(); return; }
      if (suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        consume(event);
        selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
        renderSelection();
        return;
      }
      if (suggestions.length && (event.key === 'Enter' || event.key === 'Tab')) { consume(event); select(selected); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey) sending(event);
  }, true);
  on(document, 'click', event => {
    if (event.target === send || send.contains(event.target)) sending(event);
    else if (!row.contains(event.target)) close();
  }, true);
  on(input, 'input', () => { closedToken = ''; refresh(); });
  on(input, 'click', refresh);
  on(input, 'keyup', event => { if (!['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(event.key)) refresh(); });
  on(input, 'focus', refresh);
  on(input, 'blur', close);
  on(input, 'compositionstart', () => { clearTimeout(compositionTimer); composing = true; close(); });
  // Match Loom's compositionend grace period so the IME commit cannot select or send.
  on(input, 'compositionend', () => { clearTimeout(compositionTimer); compositionTimer = setTimeout(() => { composing = false; refresh(); }, 50); });

  globalThis[key] = Object.freeze({
    update(next) { data = next; refresh(); },
    drain() { return valid() ? queue.splice(0, queue.length) : []; },
    report(result) {
      if (!valid()) return;
      status.dataset.state = result.status === 'sent' ? 'sent' : 'error';
      status.textContent = result.detail || (result.status === 'sent' ? '已在篝火通知 Being。' : '篝火通知未完成；请在篝火页面确认发送结果。');
    },
    detach() {
      destroyed = true;
      clearTimeout(compositionTimer);
      for (const remove of listeners) remove();
      queue.length = 0;
      menu.remove(); notice.remove(); status.remove();
      input.placeholder = original.placeholder;
      for (const [attribute, previous] of [['role',original.role],['aria-autocomplete',original.autocomplete],['aria-controls',original.controls]]) {
        if (previous === null) input.removeAttribute(attribute); else input.setAttribute(attribute, previous);
      }
      input.removeAttribute('aria-expanded'); input.removeAttribute('aria-activedescendant');
      delete globalThis[key];
    }
  });
  refresh();
  return true;
}

async function inComposerWorld(contents, code) {
  if (!contents || contents.isDestroyed()) return null;
  return contents.executeJavaScriptInIsolatedWorld(COMPOSER_WORLD_ID, [{code}]);
}

async function applyLoomComposer(contents, value = {}) {
  const data = normalizeComposerData(value);
  const helpers = `{tokenAtCaret:${tokenAtCaret.toString()},composerSuggestions:${composerSuggestions.toString()},replaceComposerToken:${replaceComposerToken.toString()},composerReferences:${composerReferences.toString()},buildKitPrompt:${buildKitPrompt.toString()}}`;
  // buildKitPrompt needs the same pure reference matcher in the isolated lexical scope.
  const code = `(() => { const composerReferences = ${composerReferences.toString()}; return (${installComposer.toString()})(${JSON.stringify(data)}, ${JSON.stringify(COMPOSER_KEY)}, ${helpers}); })()`;
  return inComposerWorld(contents, code);
}

async function updateLoomComposerData(contents, value = {}) {
  return inComposerWorld(contents, `globalThis[${JSON.stringify(COMPOSER_KEY)}]?.update(${JSON.stringify(normalizeComposerData(value))})`);
}

async function takeLoomComposerIntents(contents) {
  return await inComposerWorld(contents, `globalThis[${JSON.stringify(COMPOSER_KEY)}]?.drain() || []`) || [];
}

async function reportLoomComposerResult(contents, value = {}) {
  const result = {id:typeof value.id === 'string' ? value.id.slice(0, 100) : '', status:value.status === 'sent' ? 'sent' : 'error', detail:typeof value.detail === 'string' ? value.detail.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300) : ''};
  return inComposerWorld(contents, `globalThis[${JSON.stringify(COMPOSER_KEY)}]?.report(${JSON.stringify(result)})`);
}

async function detachLoomComposer(contents) {
  return inComposerWorld(contents, `globalThis[${JSON.stringify(COMPOSER_KEY)}]?.detach()`);
}

module.exports = {COMPOSER_WORLD_ID, normalizeComposerData, tokenAtCaret, composerSuggestions, replaceComposerToken, composerReferences, buildKitPrompt, applyLoomComposer, updateLoomComposerData, takeLoomComposerIntents, reportLoomComposerResult, detachLoomComposer};
