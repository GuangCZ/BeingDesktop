'use strict';
(() => {
  const node = (tag, cls, text) => { const el = document.createElement(tag); el.className = cls || ''; if (text !== undefined) el.textContent = text; return el; };
  const button = (cls, text, action) => { const el = node('button', cls, text); el.type = 'button'; el.addEventListener('click', action); return el; };
  const bridge = () => window.beingDesktop;
  const notify = error => window.beingShell?.toast?.(error?.message || '操作未完成', true);

  function referenceChip(references, {remove, removeOne, onClose} = {}) {
    const wrap = node('div', 'chat-reference');
    const chip = node('div', 'chat-reference-chip');
    const label = button('chat-reference-label', `${references.length} 条引用`, () => show(!wrap.classList.contains('is-open')));
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M8 10h8M8 14h5M7 20l-3 1V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3H7Z');
    icon.append(path); label.prepend(icon);
    const popover = node('div', 'chat-reference-popover');
    popover.id = `chat-reference-${crypto.randomUUID()}`;
    popover.setAttribute('role', 'region'); popover.setAttribute('aria-label', '所选文本全文');
    label.setAttribute('aria-controls', popover.id); label.setAttribute('aria-expanded', 'false');
    const show = open => {
      const wasOpen = wrap.classList.contains('is-open');
      wrap.classList.toggle('is-open', open); label.setAttribute('aria-expanded', String(open));
      if (!open) { if (wasOpen) onClose?.(); return; }
      const bounds = (wrap.closest('.chat-detail-card') || wrap.closest('#chat-native')).getBoundingClientRect();
      const rect = chip.getBoundingClientRect();
      popover.style.position = 'fixed'; popover.style.bottom = 'auto'; popover.style.right = 'auto';
      popover.style.width = `${Math.min(560, bounds.width - 32)}px`;
      const above = rect.top - bounds.top, below = bounds.bottom - rect.bottom;
      const down = above < Math.min(180, below);
      popover.style.maxHeight = `${Math.min(360, Math.max(80, (down ? below : above) - 24))}px`;
      popover.style.left = `${Math.max(bounds.left + 12, Math.min(rect.left, bounds.right - popover.offsetWidth - 12))}px`;
      popover.style.top = `${down ? rect.bottom + 8 : rect.top - popover.offsetHeight - 8}px`;
      wrap.classList.toggle('opens-down', down);
    };
    const list = node('ol');
    references.forEach((reference, index) => {
      const item = node('li');
      item.append(node('div', 'chat-reference-source', `所选文本 · ${reference.source}`), node('div', 'chat-reference-text', reference.text));
      if (removeOne) item.append(button('chat-reference-delete', '移除此引用', () => removeOne(index)));
      list.append(item);
    });
    popover.append(list); chip.append(label);
    if (remove) {
      const clear = button('chat-reference-remove', '', remove);
      clear.setAttribute('aria-label', '移除全部引用');
      const cross = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      cross.setAttribute('viewBox', '0 0 16 16'); cross.setAttribute('aria-hidden', 'true');
      const strokes = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      strokes.setAttribute('d', 'M4 4l8 8M12 4l-8 8');
      cross.append(strokes); clear.append(cross); chip.append(clear);
    }
    wrap.append(chip, popover);
    wrap.addEventListener('pointerenter', () => show(true));
    wrap.addEventListener('pointerleave', () => { if (!wrap.contains(document.activeElement)) show(false); });
    label.addEventListener('focus', () => show(true));
    wrap.addEventListener('focusout', event => { if (!wrap.contains(event.relatedTarget)) show(false); });
    wrap.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); show(false); } });
    return wrap;
  }

  function install({root, stream, input, getSession, isConnected, addReference, renderMarkdown, interleave, onRelease}) {
    let selected = null, pressing = false, frame = null, disposed = false;
    let lastSession = getSession();
    const cards = new Map();
    const toolbar = node('div', 'chat-selection-toolbar'); toolbar.hidden = true;
    toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', '所选文本操作');
    const hide = () => {
      const wasOpen = !toolbar.hidden;
      toolbar.hidden = true; selected = null;
      CSS.highlights?.delete('chat-selected');
      if (wasOpen) onRelease();
    };
    const clearSelection = () => { window.getSelection()?.removeAllRanges(); hide(); };
    const add = button('', '添加到对话', () => {
      if (!selected || selected.sessionId !== getSession()) return hide();
      try { addReference(selected.reference); clearSelection(); input.focus(); } catch (error) { notify(error); }
    });
    const details = button('', '更多详情', () => {
      if (!selected || selected.sessionId !== getSession()) return hide();
      const value = selected; clearSelection(); void openDetail(value);
    });
    toolbar.append(add, details);
    toolbar.addEventListener('pointerdown', event => event.preventDefault());
    root.append(toolbar);

    function capture() {
      frame = null;
      if (pressing || root.hidden) return;
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed || !selection.toString().trim()) return hide();
      const range = selection.getRangeAt(0);
      const element = value => value.nodeType === Node.ELEMENT_NODE ? value : value.parentElement;
      const body = element(range.startContainer)?.closest('.chat-body');
      if (!body || !stream.contains(body) || !body.contains(range.endContainer)) return hide();
      const rects = [...range.getClientRects()].filter(rect => rect.width && rect.height);
      const bounds = stream.getBoundingClientRect();
      const rect = rects.find(rect => rect.bottom > bounds.top && rect.top < bounds.bottom);
      if (!rect) return hide();
      selected = {sessionId: getSession(), reference: {text: selection.toString(), source: body.closest('.is-user') ? 'you' : 'Being'}};
      toolbar.hidden = false; add.disabled = details.disabled = !isConnected();
      const width = toolbar.offsetWidth, height = toolbar.offsetHeight;
      toolbar.style.left = `${Math.max(bounds.left + 8, Math.min(rect.left, bounds.right - width - 8))}px`;
      const last = rects.filter(rect => rect.bottom > bounds.top && rect.top < bounds.bottom).at(-1);
      const top = rect.top - height >= bounds.top + 4 ? Math.max(bounds.top + 4, rect.top - height - 8) : last.bottom + 8;
      toolbar.style.top = `${Math.max(bounds.top + 4, Math.min(top, bounds.bottom - height - 4))}px`;
      if (CSS.highlights && typeof Highlight === 'function') CSS.highlights.set('chat-selected', new Highlight(range.cloneRange()));
    }
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(capture); };
    document.addEventListener('selectionchange', schedule);
    stream.addEventListener('pointerdown', () => { pressing = true; });
    document.addEventListener('pointerup', () => { pressing = false; schedule(); onRelease(); });
    document.addEventListener('pointercancel', () => { pressing = false; hide(); });
    document.addEventListener('pointerdown', event => { if (!stream.contains(event.target) && !toolbar.contains(event.target)) hide(); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !toolbar.hidden) { event.preventDefault(); clearSelection(); input.focus(); }
      else if (event.key === 'Tab' && !toolbar.hidden && !toolbar.contains(document.activeElement)) { event.preventDefault(); add.focus(); }
    });
    stream.addEventListener('scroll', hide);
    window.addEventListener('resize', hide);

    function closeDetail(card, focus = true) {
      if (cards.get(card.parentSessionId) !== card) return;
      cards.delete(card.parentSessionId); card.closed = true; card.root.remove();
      if (card.sessionId) void bridge().chatDetailClose(card.sessionId).catch(notify);
      if (focus) input.focus();
    }
    async function openDetail({sessionId: parentSessionId, reference}) {
      if (!bridge()?.chatDetailOpen || !isConnected()) return;
      const previous = cards.get(parentSessionId);
      if (previous) closeDetail(previous, false);
      const card = {parentSessionId, reference, sessionId: '', closed: false, sending: false, refreshId: 0, pinned: true};
      cards.set(parentSessionId, card);
      card.root = node('section', 'chat-detail-card'); card.root.tabIndex = -1; card.root.setAttribute('role', 'dialog'); card.root.setAttribute('aria-label', '更多详情 · 临时会话');
      const header = node('header', 'chat-detail-header');
      const close = button('chat-detail-close', '×', () => closeDetail(card)); close.setAttribute('aria-label', '关闭解释卡片');
      header.append(node('strong', '', '更多详情'), node('span', 'chat-detail-badge', '临时会话'), close);
      card.messages = node('div', 'chat-detail-messages'); card.messages.setAttribute('role', 'log'); card.messages.setAttribute('aria-live', 'polite');
      card.messages.addEventListener('scroll', () => { card.pinned = card.messages.scrollHeight - card.messages.scrollTop - card.messages.clientHeight < 48; });
      card.status = node('div', 'chat-detail-status', '正在打开…'); card.status.setAttribute('role', 'status');
      card.form = node('form', 'chat-detail-composer');
      card.input = node('textarea', 'chat-detail-input'); card.input.rows = 1; card.input.placeholder = '继续追问…'; card.input.setAttribute('aria-label', '在解释卡片中继续追问');
      card.send = node('button', 'chat-detail-send', '↑'); card.send.type = 'submit'; card.send.setAttribute('aria-label', '发送追问');
      card.stop = button('chat-detail-stop', '停止', async () => {
        card.stop.disabled = true;
        try { const result = await bridge().chatDetailStop(card.sessionId); if (!result.stopped) card.status.textContent = '当前回复不属于这张卡片，未停止其他会话。'; }
        catch (error) { card.status.textContent = error.message; }
        finally { card.stop.disabled = false; }
      }); card.stop.hidden = true;
      card.form.append(card.input, card.stop, card.send);
      card.form.addEventListener('submit', event => { event.preventDefault(); void sendDetail(card); });
      card.input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void sendDetail(card); } });
      card.root.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); closeDetail(card); } });
      const source = node('div', 'chat-detail-source'); source.append(referenceChip([reference]));
      card.root.append(header, node('p', 'chat-detail-notice', '关闭后不保留本地卡片；Being 仍可能保留对话并共享记忆。'), source, card.messages, card.status, card.form);
      root.append(card.root); sync(); card.root.focus();
      try {
        const view = await bridge().chatDetailOpen({parentSessionId, reference});
        if (card.closed || disposed) { void bridge().chatDetailClose(view.sessionId).catch(notify); return; }
        card.sessionId = view.sessionId;
        sync(); if (!card.root.hidden && document.activeElement === card.root) card.input.focus();
        await sendDetail(card, '请解释所选文本的含义，补充必要的背景，并用一个具体例子帮助我理解。');
      } catch (error) { if (!card.closed) { card.status.textContent = error.message; card.input.disabled = true; card.send.disabled = true; } }
    }
    async function sendDetail(card, initial) {
      const text = initial || card.input.value;
      if (card.closed || card.sending || !card.sessionId || !text.trim() || !isConnected()) return;
      card.sending = true; card.error = ''; card.input.value = ''; card.send.disabled = true; card.stop.hidden = false;
      card.status.textContent = '正在解释…';
      try { await bridge().chatDetailSend({sessionId: card.sessionId, text}); }
      catch (error) { if (!card.closed) { card.input.value = text + (card.input.value ? '\n' + card.input.value : ''); card.error = error.message; } }
      finally { card.sending = false; if (!card.closed) { await refreshDetail(card); sync(); } }
    }
    async function refreshDetail(card) {
      if (!card.sessionId || card.closed) return;
      const request = ++card.refreshId;
      try {
        const view = await bridge().chatDetailView(card.sessionId);
        if (card.closed || request !== card.refreshId) return;
        const scroll = card.messages.scrollTop;
        const fragment = document.createDocumentFragment();
        const items = interleave(view.rows.map(row => ({...row, text: row.content})), [
          ...view.sent.map(row => ({...row, role: 'user'})), ...view.replied.map(row => ({...row, role: 'being'})),
        ]);
        if (view.live) items.push({role: 'being', text: view.live.text || '正在思考…'});
        for (const item of items) {
          const row = node('div', `chat-detail-message is-${item.role}`);
          row.append(node('div', 'chat-meta', item.role === 'user' ? 'you' : 'Being'));
          const body = node('div', 'chat-body'); body.append(renderMarkdown(item.role === 'user' ? window.beingChatReferences.decode(item.text).text : item.text)); row.append(body); fragment.append(row);
        }
        card.messages.replaceChildren(fragment);
        card.messages.scrollTop = card.pinned ? card.messages.scrollHeight : scroll;
        const phase = view.recovery?.phase;
        card.busy = card.sending || ['streaming', 'replaying', 'catching-up', 'reconnecting'].includes(phase);
        card.status.textContent = card.error || view.recovery?.hint || (card.busy ? '正在解释…' : '');
        card.stop.hidden = !card.busy; sync();
      } catch (error) { if (!card.closed) card.status.textContent = error.message; }
    }
    bridge()?.onChatDetailEvent?.(event => {
      if (event.type === 'reset') { for (const card of cards.values()) { card.closed = true; card.root.remove(); } cards.clear(); return; }
      for (const card of cards.values()) if (!event.sessionId || card.sessionId === event.sessionId) {
        if (event.type === 'error') card.error = event.message || '解释回复中断。';
        void refreshDetail(card);
      }
    });
    function sync() {
      const session = getSession();
      if (session !== lastSession || !isConnected() || root.hidden) {
        hide(); pressing = false;
        for (const reference of stream.querySelectorAll('.chat-reference.is-open')) {
          reference.classList.remove('is-open'); reference.querySelector('.chat-reference-label').setAttribute('aria-expanded', 'false');
        }
      }
      lastSession = session;
      for (const card of cards.values()) {
        card.root.hidden = card.parentSessionId !== getSession();
        card.input.disabled = !isConnected() || !card.sessionId;
        card.send.disabled = card.input.disabled || card.sending;
      }
    }
    return {sync, isSelecting: () => pressing || !toolbar.hidden || !!stream.querySelector('.chat-reference.is-open'), reset: () => { disposed = true; hide(); for (const card of [...cards.values()]) closeDetail(card, false); }};
  }
  window.beingChatSelection = {install, referenceChip};
})();
