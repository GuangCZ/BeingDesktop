'use strict';
// Native counterpart of Loom's composer. Parsing stays shared with its isolated-world adapter.
(() => {
  const H = window.beingComposerHelpers, M = window.beingTownMentions;
  const builtins = () => ({kits: [
    {id: 'being-search', name: 'search', handle: 'search', kind: 'kit', builtin: 'search', description: '网络搜索 · 搜索互联网并读取网页正文。'},
    {id: 'being-browse', name: 'browse', handle: 'browse', kind: 'kit', builtin: 'browse', description: '网页读取 · 读取公开网页，支持 JavaScript 渲染。'},
  ], members: [], kitsError: '', membersError: ''});
  const el = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls; if (text) n.textContent = text; return n; };
  function install({input, composer, area, getBridge, getSession, onMembersChanged = () => {}}) {
    const menu = el('div', 'chat-composer-menu'); menu.id = 'chat-composer-menu'; menu.hidden = true; menu.setAttribute('role', 'listbox');
    const notice = el('div', 'chat-composer-notice'); notice.hidden = true; notice.setAttribute('aria-live', 'polite');
    const resultNotice = el('div', 'chat-composer-notice'); resultNotice.hidden = true; resultNotice.setAttribute('role', 'status');
    composer.append(menu); area.append(notice, resultNotice);
    input.placeholder = '输入消息，/ 调用 Kit，@ 通知 Being';
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-controls', menu.id);
    let data = builtins(), identity = '', session = '', connected = false, loading = false, loaded = false, epoch = 0;
    let token = null, items = [], selected = 0, dismissed = '', composing = false, compositionUntil = 0, ambiguity = null, membersExpiresAt = 0, membersRevision = null;
    let selections = [], previousText = input.value;
    const selectedDrafts = new Map();
    function trackSelections() { selections = M.rebaseSelections(previousText, input.value, selections); previousText = input.value; }
    const key = t => t ? `${t.start}:${t.prefix}${t.query}` : '';
    function close() { menu.hidden = true; token = null; items = []; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
    function select(index) {
      const current = ambiguity && input.value === ambiguity.draft ? {...ambiguity, kind: 'member', prefix: '@'} : H.tokenAtCaret(input.value, input.selectionStart, input.selectionEnd);
      if (!current || key(current) !== key(token) || !items[index] || composing) return;
      trackSelections();
      const item = items[index], label = item.kind === 'member' ? M.memberName(item) || item.id : item.handle;
      const replacement = H.replaceComposerToken(input.value, current, {...item, handle:label});
      input.value = replacement.text; trackSelections();
      if (item.kind === 'member') {
        const end = current.start + label.length + 1;
        selections = selections.filter(range => range.end <= current.start || range.start >= end);
        selections.push({start:current.start, end, id:M.memberId(item), label});
      }
      input.setSelectionRange(replacement.caret, replacement.caret);
      ambiguity = null; dismissed = ''; input.focus(); input.dispatchEvent(new Event('input', {bubbles: true}));
    }
    function selection() {
      for (const option of menu.querySelectorAll('[role="option"]')) option.setAttribute('aria-selected', Number(option.dataset.index) === selected ? 'true' : 'false');
      const active = menu.querySelector(`[data-index="${selected}"]`);
      if (active) { input.setAttribute('aria-activedescendant', active.id); active.scrollIntoView({block: 'nearest'}); }
    }
    async function load(force = false) {
      if (loading || !connected || !getBridge()?.getChatComposerData) return;
      const ticket = epoch; loading = true; refresh();
      try {
        const result = await getBridge().getChatComposerData({force});
        if (ticket !== epoch) return;
        data = {...result, members: [...M.memberMap(result.members).values()]}; loaded = true; onMembersChanged(data.members);
        membersExpiresAt = result.expiresAt || Date.now() + 60000; membersRevision = result.revision ?? membersRevision;
      } catch {
        if (ticket !== epoch) return;
        data = {...builtins(), kitsError: '工具目录暂时无法加载。', membersError: 'Being 成员暂时无法加载。'}; loaded = true;
      } finally { if (ticket === epoch) { loading = false; refresh(); } }
    }
    function refresh() {
      trackSelections();
      const resolved = M.resolve(input.value, Date.now() < membersExpiresAt ? data.members : [], selections);
      const members = data.members.filter(member => resolved.members.includes(member.id));
      const kits = H.composerReferences(input.value, data.kits, '/');
      const lines = [];
      if (kits.length) lines.push(`调用 ${kits.map(i => '/' + i.handle).join('、')}`);
      if (members.length) lines.push(`发送后此消息会公开到篝火，并通知 ${members.map(i => '@' + i.name).join('、')}`);
      if (resolved.ambiguous.length) lines.push('提及有重名，发送前请选择具体 Being');
      if (resolved.unresolved.length) lines.push(`未识别提及：${resolved.unresolved.map(name => '@' + name).join('、')}，将按原文发送，可能不会触发通知`);
      notice.textContent = lines.join(' · '); notice.hidden = !lines.length;
      if (!connected || input.disabled || input.readOnly || document.activeElement !== input || composing || Date.now() < compositionUntil) { close(); return; }
      if (ambiguity && ambiguity.draft !== input.value) ambiguity = null;
      const next = ambiguity ? {...ambiguity, kind: 'member', prefix: '@'} : H.tokenAtCaret(input.value, input.selectionStart, input.selectionEnd);
      if (!next || dismissed === key(next)) { close(); return; }
      if (key(next) !== key(token)) selected = 0;
      token = next; items = ambiguity ? ambiguity.candidates : H.composerSuggestions(data, token); selected = Math.min(selected, Math.max(0, items.length - 1));
      menu.replaceChildren(el('div', 'chat-composer-heading', token.kind === 'kit' ? '已安装 Kit · 内置能力' : ambiguity ? '名字有歧义，请选择具体 Being' : '通知 Being · 消息将公开到篝火'));
      for (let index = 0; index < items.length; index++) {
        const item = items[index], option = el('button', 'chat-composer-option');
        option.type = 'button'; option.tabIndex = -1; option.id = `chat-composer-option-${index}`; option.dataset.index = String(index); option.setAttribute('role', 'option');
        const icon = el('span', 'chat-composer-icon', Array.from(item.name)[0]?.toUpperCase() || '?'); icon.setAttribute('aria-hidden', 'true');
        if (item.icon?.startsWith('data:image/')) { const image = el('img', ''); image.alt = ''; image.src = item.icon; image.addEventListener('error', () => image.remove(), {once:true}); icon.append(image); }
        const copy = el('span', 'chat-composer-copy'); copy.append(el('strong', '', token.prefix + (item.kind === 'member' ? item.name : item.handle)), el('span', 'chat-composer-detail', item.kind === 'member' ? `@${item.id}${item.description ? ' · ' + item.description : ''}` : item.description));
        option.append(icon, copy); option.addEventListener('mousedown', e => e.preventDefault()); option.addEventListener('click', () => select(index)); menu.append(option);
      }
      const error = token.kind === 'kit' ? data.kitsError : data.membersError;
      if (!items.length || loading || error) {
        const status = el('div', 'chat-composer-empty', loading ? '正在加载…' : error || (token.query ? '没有匹配结果' : '暂无 Being 成员'));
        if (error && !loading) {
          const retry = el('button', 'chat-composer-retry'); retry.type = 'button'; retry.title = '重新加载'; retry.setAttribute('aria-label', '重新加载');
          const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', 'M20 11a8 8 0 1 0-2.4 6.7M20 4v7h-7'); icon.append(path); retry.append(icon);
          retry.addEventListener('mousedown', e => e.preventDefault()); retry.addEventListener('click', () => void load(true)); status.append(retry);
        }
        menu.append(status);
      }
      menu.hidden = false; input.setAttribute('aria-expanded', 'true'); selection();
    }
    function sync(state) {
      const nextIdentity = JSON.stringify([state?.connection?.beingName, state?.connection?.displayUrl, state?.townApp?.identity?.connectionRevision, state?.townApp?.identity?.identityRevision, state?.connection?.status]);
      connected = state?.connection?.status === 'connected' && state?.settings?.chatMode !== 'loom';
      const revision = state?.townApp?.memberDirectory?.revision;
      if (membersRevision !== null && revision !== undefined && membersRevision !== revision) { loaded = false; membersExpiresAt = 0; ambiguity = null; epoch++; loading = false; }
      if (revision !== undefined) membersRevision = revision;
      if (identity !== nextIdentity) { identity = nextIdentity; selections = []; selectedDrafts.clear(); previousText = input.value; epoch++; data = builtins(); onMembersChanged([]); loaded = false; loading = false; dismissed = ''; close(); }
      if (session !== getSession()) { selectedDrafts.set(session, {text:previousText, selections}); session = getSession(); const saved = selectedDrafts.get(session); selections = saved?.text === input.value ? saved.selections : []; previousText = input.value; dismissed = ''; ambiguity = null; resultNotice.hidden = true; close(); }
      refresh();
      if (connected && !loaded && !loading) void load();
    }
    function keydown(event) {
      if (event.isComposing || event.keyCode === 229 || composing || Date.now() < compositionUntil) return event.key === 'Enter';
      if (menu.hidden) return false;
      if (event.key === 'Escape') { ambiguity = null; dismissed = key(token); close(); event.preventDefault(); return true; }
      if (['ArrowDown', 'ArrowUp'].includes(event.key) && items.length) { selected = (selected + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; selection(); event.preventDefault(); return true; }
      if (['Enter', 'Tab'].includes(event.key) && !event.shiftKey) { event.preventDefault(); if (items.length) select(selected); else { dismissed = key(token); close(); } return true; }
      return false;
    }
    function prepare(text, event) {
      if (composing || Date.now() < compositionUntil || event?.isComposing) throw new Error('请完成输入后再发送。');
      const fresh = loaded && !loading && !data.membersError && Date.now() < membersExpiresAt;
      if (!fresh && !data.membersError && /(^|\s)@[^\s/@]+/u.test(text)) { if (!loading) void load(); throw new Error('成员目录正在刷新，请稍后再发送。'); }
      trackSelections();
      const resolved = M.resolve(text, fresh ? data.members : [], selections);
      if (!fresh && /(^|\s)@[^\s/@]+/u.test(text) && !loading) void load();
      if (resolved.ambiguous.length) {
        ambiguity = {...resolved.ambiguous[0], draft: text}; dismissed = '';
        input.focus(); input.setSelectionRange(ambiguity.end, ambiguity.end); refresh();
        throw new Error('名字有歧义，请先从候选列表选择具体 Being，再发送。');
      }
      const members = resolved.members;
      if (members.length && (!event?.isTrusted || !Number.isSafeInteger(data.connectionRevision))) throw new Error('请在输入框按 Enter 或点击发送，确认公开通知 Being。');
      if (members.length && text.includes('\0')) throw new Error('公开通知不能包含空字符，请检查消息内容。');
      if (members.length > 20 || (members.length && resolved.text.length > 4000)) throw new Error('公开通知最多提及 20 位 Being，消息不能超过 4000 字。');
      if (resolved.unresolved.length) window.beingShell?.toast?.(`未识别提及：${resolved.unresolved.map(name => '@' + name).join('、')}；按原文发送，可能不会触发通知。`);
      resultNotice.hidden = true;
      return {text: H.buildKitPrompt(resolved.text, data.kits), raw: resolved.text, members, connectionRevision: data.connectionRevision, epoch};
    }
    async function publish(plan, result) {
      if (!plan.members.length) return;
      const toast = (message, error = true) => window.beingShell?.toast?.(message, error);
      if (!result?.ok || (!result.streamed && !result.spliced)) { toast('聊天送达状态待确认，尚未发布篝火通知；不会自动重发。'); return; }
      if (plan.epoch !== epoch || !connected) { toast('Being 连接已变化，尚未发布篝火通知。'); return; }
      try {
        const receipt = await getBridge().sendBonfireMessage({content: plan.raw, mentions: plan.members, connectionRevision: plan.connectionRevision, requestId: crypto.randomUUID()});
        if (receipt?.ok !== true || !receipt.id) { toast('篝火通知未确认送达，请打开篝火检查；不会自动重发。'); return; }
        M.renderReceipt(resultNotice, receipt, '消息已公开到篝火。');
        toast(receipt.mention_warnings?.length ? '消息已公开到篝火；提及警告请查看下方候选列表。' : receipt.mentions?.length ? '消息已公开到篝火，Town 已接受提及通知。' : '消息已公开到篝火；Town 尚未确认提及通知。', false);
      } catch { toast('篝火通知未确认送达，请打开篝火检查；不会自动重发。'); }
    }
    for (const name of ['input', 'click', 'keyup', 'focus']) input.addEventListener(name, () => {
      const previousKind = token?.kind; refresh();
      if (!loading && (token?.kind === 'kit' && previousKind !== 'kit' && loaded || token?.kind === 'member' && Date.now() >= membersExpiresAt)) void load();
    });
    input.addEventListener('blur', () => setTimeout(() => { if (!menu.contains(document.activeElement)) close(); }, 0));
    input.addEventListener('compositionstart', () => { composing = true; close(); });
    input.addEventListener('compositionend', () => { composing = false; compositionUntil = Date.now() + 50; setTimeout(refresh, 55); });
    getBridge()?.onTownMembersInvalidated?.(() => { membersExpiresAt = 0; loaded = false; ambiguity = null; epoch++; loading = false; void load(); });
    close();
    return {sync, refresh, keydown, prepare, publish};
  }
  window.beingChatComposer = {install};
})();
