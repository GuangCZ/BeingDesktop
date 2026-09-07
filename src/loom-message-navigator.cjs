'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const NAVIGATOR_WORLD_ID = 1108;

// This adapter only reads rendered messages and scrolls Loom's existing viewport.
function installMessageNavigator() {
  const key = '__beingDesktopMessageNavigator';
  const messages = document.querySelector('#app #messages');
  if (!messages) return false;
  if (globalThis[key]?.messages === messages) return true;
  globalThis[key]?.destroy();

  const make = (tag, id, parent) => {
    const node = document.createElement(tag);
    node.id = id;
    parent.append(node);
    return node;
  };
  const navigator = make('div', 'desktop-message-navigator', document.body);
  navigator.hidden = true;
  const rail = make('div', 'desktop-message-rail', navigator);
  rail.tabIndex = 0;
  rail.setAttribute('role', 'slider');
  rail.setAttribute('aria-label', '已加载消息定位：上下键预览，Enter 跳转');
  rail.setAttribute('aria-orientation', 'vertical');
  rail.setAttribute('aria-valuemin', '1');
  rail.setAttribute('aria-controls', 'messages');
  const ticks = make('div', 'desktop-message-ticks', rail);
  ticks.setAttribute('aria-hidden', 'true');
  const preview = make('div', 'desktop-message-preview', navigator);
  preview.setAttribute('role', 'tooltip');
  preview.hidden = true;
  const title = make('div', 'desktop-message-preview-title', preview);
  const body = make('div', 'desktop-message-preview-body', preview);

  let entries = [], positions = [], active = 0, selected = null, frame = 0, jumpFrame = 0;
  let dirty = true, destroyed = false, dragging = false, pointerInside = false, keyboardFocus = false;
  let wheelDelta = 0, wheelTime = 0, railHeight = 0;
  const listeners = [];
  const on = (target, type, listener, options) => {
    target.addEventListener(type, listener, options);
    listeners.push(() => target.removeEventListener(type, listener, options));
  };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const contentText = node => {
    if (!node) return '';
    const content = node.querySelector('.content');
    if (!content) return '';
    // Read plain rendered text; never copy message markup into the tooltip.
    return content.innerText.replace(/\s+/g, ' ').trim().slice(0, 600);
  };
  function dismiss() {
    selected = null;
    preview.hidden = true;
    rail.removeAttribute('aria-describedby');
    wheelDelta = 0;
    schedule();
  }
  function schedule(measure = false) {
    if (destroyed) return;
    dirty ||= measure;
    if (!frame) frame = requestAnimationFrame(render);
  }
  const resize = new ResizeObserver(() => schedule(true));
  const observed = new Set();
  resize.observe(messages);
  resize.observe(document.documentElement);

  function collect() {
    const previous = entries[selected]?.node;
    const nodes = Array.from(messages.children).filter(node => node.matches('.message') && node.getClientRects().length);
    const users = nodes.filter(node => node.classList.contains('user'));
    const anchors = users.length ? users : nodes.filter(node => node.matches('.being, .assistant') && !node.classList.contains('thinking-indicator'));
    const replies = new Map();
    let user = null;
    for (const node of nodes) {
      if (node.classList.contains('user')) user = node;
      else if (user && node.matches('.being, .assistant') && !node.classList.contains('thinking-indicator') && !replies.has(user)) replies.set(user, node);
    }
    entries = anchors.map(node => ({node, reply: replies.get(node)}));
    selected = previous ? entries.findIndex(entry => entry.node === previous) : null;
    if (selected === -1) selected = null;
    const current = new Set(nodes);
    for (const node of observed) {
      if (!current.has(node)) { resize.unobserve(node); observed.delete(node); }
    }
    for (const node of nodes) {
      if (!observed.has(node)) { resize.observe(node); observed.add(node); }
    }
    const top = messages.getBoundingClientRect().top + messages.clientTop;
    positions = entries.map(entry => entry.node.getBoundingClientRect().top - top + messages.scrollTop);
  }
  function render() {
    frame = 0;
    if (!messages.isConnected) return;
    if (dirty) { dirty = false; collect(); }
    const rect = messages.getBoundingClientRect();
    const available = Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top);
    navigator.hidden = entries.length < 2 || messages.scrollHeight <= messages.clientHeight + 2 || available < 90 || rect.width < 180;
    messages.toggleAttribute('data-desktop-message-navigation', !navigator.hidden);
    if (navigator.hidden) { selected = null; preview.hidden = true; return; }
    railHeight = Math.min(300, available - 48, Math.max(30, (entries.length - 1) * 10 + 20));
    navigator.style.left = `${Math.max(0, rect.left) + 4}px`;
    navigator.style.top = `${Math.max(0, rect.top) + (available - railHeight) / 2}px`;
    rail.style.height = `${railHeight}px`;

    let low = 0, high = positions.length - 1;
    const readingTop = messages.scrollTop + 24;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (positions[middle] <= readingTop) low = middle;
      else high = middle - 1;
    }
    active = messages.scrollTop + messages.clientHeight >= messages.scrollHeight - 2 ? entries.length - 1 : low;
    const index = selected ?? active;
    rail.setAttribute('aria-valuemax', String(entries.length));
    rail.setAttribute('aria-valuenow', String(index + 1));
    rail.setAttribute('aria-valuetext', `第 ${index + 1} / ${entries.length} 条消息`);

    // Sample long histories visually; pointer, wheel and keys still reach every turn.
    const count = Math.min(entries.length, Math.floor((railHeight - 20) / 6) + 1);
    while (ticks.childElementCount < count) ticks.append(document.createElement('span'));
    while (ticks.childElementCount > count) ticks.lastElementChild.remove();
    const selectedTick = Math.round(index / (entries.length - 1) * (count - 1));
    const activeTick = Math.round(active / (entries.length - 1) * (count - 1));
    Array.from(ticks.children).forEach((tick, i) => {
      const distance = Math.abs(i - selectedTick);
      const width = selected === null ? (i === activeTick ? 16 : 6) : [26, 19, 13, 9][distance] || 6;
      tick.style.width = `${width}px`;
      tick.style.top = `${10 + i / (count - 1) * (railHeight - 20)}px`;
      tick.dataset.current = String(i === activeTick);
      tick.dataset.selected = String(selected !== null && i === selectedTick);
    });
    preview.hidden = selected === null;
    if (selected === null) { rail.removeAttribute('aria-describedby'); return; }
    const entry = entries[selected];
    title.textContent = contentText(entry.node) || (entry.node.classList.contains('user') ? '附件消息' : 'Being 的回复');
    body.textContent = contentText(entry.reply) || (entry.reply ? '正在回复…' : entry.node.classList.contains('user') ? '暂无回复' : '');
    body.hidden = !body.textContent;
    rail.setAttribute('aria-describedby', preview.id);
    preview.style.width = `${Math.min(322, innerWidth - navigator.getBoundingClientRect().left - 50)}px`;
    const center = navigator.getBoundingClientRect().top + 10 + selected / (entries.length - 1) * (railHeight - 20);
    preview.style.top = `${clamp(center - preview.offsetHeight / 2, Math.max(8, rect.top + 8), Math.min(innerHeight, rect.bottom) - preview.offsetHeight - 8) - navigator.getBoundingClientRect().top}px`;
  }
  function select(index) {
    if (!entries.length) return;
    selected = clamp(index, 0, entries.length - 1);
    schedule();
  }
  function fromPointer(event) {
    const rect = rail.getBoundingClientRect();
    select(Math.round(clamp((event.clientY - rect.top - 10) / (railHeight - 20), 0, 1) * (entries.length - 1)));
  }
  function cancelJump() {
    cancelAnimationFrame(jumpFrame);
    jumpFrame = 0;
  }
  function jump() {
    cancelJump();
    const entry = entries[selected ?? active];
    if (!entry?.node.isConnected) return;
    const place = () => {
      const top = entry.node.getBoundingClientRect().top - messages.getBoundingClientRect().top - messages.clientTop + messages.scrollTop - 20;
      messages.scrollTo({top: Math.max(0, top), behavior: 'instant'});
      // Update Loom's scrollLock before another streaming chunk can auto-follow.
      messages.dispatchEvent(new Event('scroll'));
    };
    place();
    // Loom may already have queued an unconditional bottom scroll for this frame.
    // Correct only that bottom jump, once; subsequent user input cancels this work.
    jumpFrame = requestAnimationFrame(() => {
      jumpFrame = 0;
      if (!destroyed && entry.node.isConnected && entries[selected ?? active]?.node === entry.node
          && messages.scrollTop + messages.clientHeight >= messages.scrollHeight - 2) place();
    });
    schedule();
  }
  on(rail, 'pointerenter', event => { pointerInside = true; fromPointer(event); });
  on(rail, 'pointermove', event => { fromPointer(event); if (dragging) jump(); });
  on(rail, 'pointerleave', () => { pointerInside = false; if (!dragging && !keyboardFocus) dismiss(); });
  on(rail, 'pointerdown', event => {
    if (event.button !== 0) return;
    dragging = true;
    keyboardFocus = false;
    rail.focus({preventScroll:true});
    rail.setPointerCapture(event.pointerId);
    fromPointer(event);
    jump();
  });
  on(rail, 'pointerup', event => {
    dragging = false;
    if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);
  });
  on(rail, 'lostpointercapture', () => { dragging = false; if (!pointerInside && !keyboardFocus) dismiss(); });
  on(rail, 'click', event => {
    // Loom focuses its composer on document clicks; keep navigation keys on the rail.
    event.stopPropagation();
    if (event.detail) fromPointer(event);
    jump();
  });
  on(rail, 'wheel', event => {
    if (event.ctrlKey || event.metaKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.timeStamp - wheelTime > 180 || Math.sign(wheelDelta) !== Math.sign(event.deltaY)) wheelDelta = 0;
    wheelTime = event.timeStamp;
    wheelDelta += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? railHeight : 1);
    if (Math.abs(wheelDelta) < 32) return;
    select((selected ?? active) + Math.sign(wheelDelta));
    wheelDelta = 0;
    jump();
  }, {passive: false});
  on(rail, 'focus', () => { keyboardFocus = !pointerInside; if (selected === null) select(active); });
  on(rail, 'blur', () => { keyboardFocus = false; if (!pointerInside) dismiss(); });
  on(rail, 'keydown', event => {
    keyboardFocus = true;
    const index = selected ?? active;
    const next = {ArrowUp:index - 1, ArrowLeft:index - 1, ArrowDown:index + 1, ArrowRight:index + 1, Home:0, End:entries.length - 1};
    if (Object.hasOwn(next, event.key)) { event.preventDefault(); select(next[event.key]); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); jump(); }
    else if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
  });
  on(messages, 'scroll', () => schedule(), {passive: true});
  for (const type of ['wheel', 'pointerdown', 'touchmove', 'keydown']) {
    on(document, type, event => { if (!rail.contains(event.target)) cancelJump(); }, {capture:true, passive:true});
  }
  on(window, 'resize', () => schedule(true));
  const observer = new MutationObserver(() => schedule(true));
  observer.observe(messages, {childList:true, subtree:true, characterData:true, attributes:true, attributeFilter:['class', 'style', 'hidden']});
  const replacement = new MutationObserver(() => {
    if (!messages.isConnected) {
      navigator.hidden = true;
      if (document.querySelector('#app #messages')) {
        destroy();
        installMessageNavigator();
      }
    }
  });
  replacement.observe(document.body, {childList:true, subtree:true});
  function destroy() {
    destroyed = true;
    cancelAnimationFrame(frame);
    cancelJump();
    observer.disconnect();
    replacement.disconnect();
    resize.disconnect();
    for (const remove of listeners) remove();
    messages.removeAttribute('data-desktop-message-navigation');
    navigator.remove();
    delete globalThis[key];
  }
  globalThis[key] = {messages, destroy};
  on(window, 'pagehide', destroy, {once:true});
  schedule(true);
  return true;
}

async function applyLoomMessageNavigator(contents) {
  if (contents.isDestroyed()) return false;
  const css = await fs.readFile(path.join(__dirname, 'loom-message-navigator.css'), 'utf8');
  if (contents.isDestroyed()) return false;
  await contents.insertCSS(css, {cssOrigin:'user'});
  if (contents.isDestroyed()) return false;
  return contents.executeJavaScriptInIsolatedWorld(NAVIGATOR_WORLD_ID, [{code:`(${installMessageNavigator.toString()})()`}]);
}

module.exports = {applyLoomMessageNavigator, NAVIGATOR_WORLD_ID};
