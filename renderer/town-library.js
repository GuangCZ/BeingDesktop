'use strict';

(() => {
  const PAGE_SIZE = 100;
  const CONTENT_SIZE = 10000;
  const REFRESH_MS = 60000;
  const ids = new Set(['scroll', 'beings']);
  const ui = {};
  let root;
  let bridge;
  let options;
  let current = '';
  let publicState = {};
  let identityKey = '';
  let epoch = 0;
  let timer = null;
  let observer = null;
  const newScroll = () => ({ items: [], total: 0, nextOffset: 0, query: '', selected: '', detail: null, firstPage: '', firstPageSavedAt: null, detailFirstPage: '', loading: false, detailLoading: false, error: '', detailError: '', loaded: false, hasMore: false, request: 0, detailRequest: 0 });
  const newBeings = () => ({ items: [], query: '', loading: false, loaded: false, error: '', detail: '', updatedAt: null, request: 0 });
  let scroll = newScroll();
  let beings = newBeings();
  const string = (value, fallback = '') => typeof value === 'string' && value ? value : fallback;
  const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const array = (value) => Array.isArray(value) ? value : [];
  const node = (tag, className, value) => {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (value !== undefined) result.textContent = String(value);
    return result;
  };
  const append = (parent, ...children) => { parent.append(...children.filter(Boolean)); return parent; };
  const button = (label, action, className = '') => {
    const result = node('button', `ta-button ${className}`, label);
    result.type = 'button';
    result.addEventListener('click', action);
    return result;
  };
  const notice = () => {
    const result = node('p', 'ta-notice');
    result.setAttribute('role', 'status');
    result.hidden = true;
    return result;
  };
  const setNotice = (target, value, error = false) => {
    target.textContent = value;
    target.hidden = !value;
    target.classList.toggle('ta-error', error);
  };
  const empty = (title, description) => append(node('div', 'ta-empty'), node('h3', '', title), node('p', '', description));
  const connected = () => publicState.connection?.status === 'connected';
  const visible = (id) => Boolean(root && current === id && !document.hidden && !root.closest('[hidden]') && !ui[`${id}Page`].hidden);
  const errorText = (error) => string(error?.message, '读取失败，请稍后重试。').slice(0, 400);
  const dateText = (value) => {
    const date = new Date(value);
    return value && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  };

  async function call(method, value = {}) {
    if (typeof bridge?.[method] !== 'function') throw new Error('此功能尚未接通，请先更新桌面应用。');
    return record(await bridge[method](value));
  }

  async function cached(method, value = {}) {
    if (typeof bridge?.getTownCachedData !== 'function') return null;
    try {
      const result = record(await bridge.getTownCachedData({ method, value }));
      return result.cached && result.data && typeof result.data === 'object' ? result : null;
    } catch { return null; }
  }

  const cacheTime = (saved) => Number.isSafeInteger(saved?.lastSuccessAt) && saved.lastSuccessAt >= 0 ? saved.lastSuccessAt : null;
  const currentListPage = (state, saved) => state.firstPageSavedAt !== null && cacheTime(saved) !== null && cacheTime(saved) > state.firstPageSavedAt;

  function searchInput(id, placeholder, onInput) {
    const input = node('input', 'ta-input');
    input.id = id;
    input.type = 'search';
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder);
    input.autocomplete = 'off';
    input.addEventListener('input', () => onInput(input.value));
    return input;
  }

  function build() {
    ui.scrollPage = node('section', 'ta-module ta-library-scroll');
    ui.scrollPage.setAttribute('aria-label', '卷轴文档浏览');
    const sidebar = node('aside', 'ta-library-sidebar');
    ui.scrollSearch = searchInput('scroll-search', '搜索卷轴标题、作者或标签', (value) => { scroll.query = value; renderScrollList(); });
    ui.scrollRefresh = button('刷新', () => void loadScrolls(), 'ta-quiet');
    ui.scrollRefresh.id = 'scroll-refresh';
    ui.scrollCount = node('p', 'ta-library-count');
    ui.scrollCount.setAttribute('aria-live', 'polite');
    ui.scrollNotice = notice();
    ui.scrollList = node('div', 'ta-library-scroll-list');
    ui.scrollList.setAttribute('aria-label', '卷轴列表');
    ui.scrollMore = button('加载更多卷轴', () => void loadScrolls(true), 'ta-secondary');
    ui.scrollMore.id = 'scroll-load-more';
    const scrollTools = append(node('div', 'ta-library-toolbar'), ui.scrollSearch, ui.scrollRefresh);
    append(sidebar, scrollTools, ui.scrollCount, ui.scrollNotice, ui.scrollList, ui.scrollMore);
    ui.scrollDocument = node('article', 'ta-library-document');
    ui.scrollDocument.id = 'scroll-document';
    ui.scrollDocument.setAttribute('aria-label', '卷轴正文');
    append(ui.scrollPage, sidebar, ui.scrollDocument);

    ui.beingsPage = node('section', 'ta-module ta-library-beings');
    ui.beingsPage.setAttribute('aria-label', '居民名录');
    ui.beingsSearch = searchInput('beings-search', '搜索 Being 或人类伙伴', (value) => { beings.query = value; renderBeingList(); });
    ui.beingsRefresh = button('刷新', () => void loadBeings(), 'ta-secondary');
    ui.beingsRefresh.id = 'beings-refresh';
    ui.beingsStatus = node('p', 'ta-library-sync');
    ui.beingsStatus.setAttribute('role', 'status');
    ui.beingsCount = node('p', 'ta-library-count');
    ui.beingsCount.setAttribute('aria-live', 'polite');
    ui.beingsNotice = notice();
    ui.beingsDescription = node('p', 'ta-library-description');
    ui.beingsList = node('div', 'ta-library-being-list');
    const toolbar = append(node('div', 'ta-library-toolbar'), ui.beingsSearch, ui.beingsRefresh);
    const summary = append(node('div', 'ta-library-summary'), ui.beingsCount, ui.beingsStatus);
    append(ui.beingsPage, toolbar, summary, ui.beingsDescription, ui.beingsNotice, ui.beingsList);
    for (const id of ids) { ui[`${id}Page`].hidden = true; root.append(ui[`${id}Page`]); }
  }

  function connectionEmpty() {
    const content = empty('先连接 Being', '连接后即可浏览当前 Being 可以访问的卷轴。');
    if (typeof options.onNavigateChat === 'function') content.append(button('前往对话', options.onNavigateChat, 'ta-secondary'));
    return content;
  }

  function renderScrollList() {
    const query = scroll.query.trim().toLocaleLowerCase();
    const items = scroll.items.filter((item) => [item.title, item.beingName, item.beingId, ...array(item.tags)].join(' ').toLocaleLowerCase().includes(query));
    ui.scrollSearch.disabled = !connected();
    ui.scrollRefresh.disabled = !connected() || scroll.loading;
    ui.scrollRefresh.textContent = scroll.loading ? '读取中…' : '刷新';
    ui.scrollList.setAttribute('aria-busy', String(scroll.loading));
    ui.scrollCount.textContent = connected() ? query ? `找到 ${items.length} 个卷轴${scroll.hasMore ? ' · 搜索已加载内容' : ''}` : `${scroll.total} 个卷轴${scroll.hasMore ? ` · 已加载 ${scroll.items.length}` : ''}` : '';
    setNotice(ui.scrollNotice, scroll.error ? `${scroll.error}${scroll.items.length ? ' 已保留上次读取的列表。' : ''}` : '', Boolean(scroll.error));
    ui.scrollMore.hidden = !scroll.hasMore || !connected();
    ui.scrollMore.disabled = scroll.loading;
    ui.scrollList.replaceChildren();
    if (!connected()) { ui.scrollList.append(connectionEmpty()); return; }
    if (!items.length) {
      const title = scroll.loading && !scroll.loaded ? '正在读取卷轴…' : scroll.error && !scroll.loaded ? '卷轴暂时无法读取' : !scroll.loaded ? '卷轴尚未读取' : query ? '没有匹配的卷轴' : '还没有卷轴';
      const detail = scroll.loading && !scroll.loaded ? '正在刷新，已有缓存会先显示在这里。' : !scroll.loaded ? '打开时先显示上次读取的列表，再从 Town 同步最新内容。' : query ? '试试其他标题、作者或标签。' : '这里会显示当前 Being 可以访问的笔记和文档。';
      ui.scrollList.append(empty(title, detail));
      return;
    }
    for (const item of items) {
      const row = button('', () => void selectScroll(item.id), 'ta-library-scroll-row');
      row.dataset.scrollId = item.id;
      row.setAttribute('aria-pressed', String(item.id === scroll.selected));
      const metadata = [item.beingName || item.beingId, dateText(item.updatedAt || item.createdAt)].filter(Boolean).join(' · ');
      append(row, node('strong', '', string(item.title, '未命名卷轴')), node('span', 'ta-library-item-meta', metadata));
      if (array(item.tags).length) row.append(node('span', 'ta-library-item-tags', item.tags.join(' · ')));
      ui.scrollList.append(row);
    }
  }

  function renderDocument() {
    const target = ui.scrollDocument;
    const position = target.scrollTop;
    target.setAttribute('aria-busy', String(scroll.detailLoading));
    target.replaceChildren();
    if (!connected()) { target.append(empty('卷轴', '连接 Being 后，选择左侧卷轴即可阅读。')); return; }
    if (!scroll.selected) { target.append(empty('选择一个卷轴', '在左侧浏览或搜索卷轴，正文会显示在这里。')); return; }
    const summary = scroll.items.find((item) => item.id === scroll.selected) || {};
    const detail = scroll.detail || summary;
    const header = node('header', 'ta-library-document-header');
    header.append(node('h3', '', string(detail.title, '未命名卷轴')));
    const visibility = { private: '私有', public: '公开', shared: '共享', unlisted: '未列出' }[detail.visibility];
    const metadata = [detail.beingName || detail.beingId, visibility, dateText(detail.updatedAt || detail.createdAt)].filter(Boolean).join(' · ');
    header.append(node('p', 'ta-library-item-meta', metadata));
    if (array(detail.tags).length) header.append(node('p', 'ta-library-item-tags', detail.tags.join(' · ')));
    target.append(header);
    if (scroll.detailError) {
      const error = notice();
      setNotice(error, `${scroll.detailError}${scroll.detail ? ' 已保留上次读取的正文。' : ''}`, true);
      target.append(error, button('重新读取正文', () => void selectScroll(scroll.selected), 'ta-secondary'));
    }
    if (!scroll.detail) {
      if (scroll.detailLoading) target.append(empty('正在读取正文…', '文档加载完成后会显示在这里。'));
      return;
    }
    const body = node('div', 'ta-library-document-body');
    renderDocumentText(body, string(scroll.detail.content));
    target.append(body);
    if (!scroll.detail.content) target.append(node('p', 'ta-muted', scroll.detail.hasMore ? '当前页没有可显示的正文，可继续阅读。' : '这个卷轴还没有正文。'));
    if (scroll.detail.hasMore) {
      const footer = node('footer', 'ta-library-document-footer');
      const count = scroll.detail.nextOffset;
      footer.append(node('p', 'ta-library-item-meta', `已读取 ${count.toLocaleString('zh-CN')} / ${Number(scroll.detail.totalLength || count).toLocaleString('zh-CN')} 字符`));
      const more = button(scroll.detailLoading ? '读取中…' : '继续阅读', () => void selectScroll(scroll.selected, true), 'ta-secondary');
      more.id = 'scroll-content-more';
      more.disabled = scroll.detailLoading;
      footer.append(more);
      target.append(footer);
    }
    target.scrollTop = position;
  }

  // Build a small readable Markdown subset from text nodes; document HTML never executes.
  function renderDocumentText(target, content) {
    const lines = content.replace(/\r\n?/g, '\n').split('\n');
    let paragraph = [];
    let code = null;
    let list = null;
    const flush = () => {
      if (paragraph.length) target.append(node('p', '', paragraph.join('\n')));
      paragraph = [];
      list = null;
    };
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        flush();
        if (code) { target.append(append(node('pre'), node('code', '', code.join('\n')))); code = null; }
        else code = [];
        continue;
      }
      if (code) { code.push(line); continue; }
      if (!line.trim()) { flush(); continue; }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) { flush(); target.append(node(`h${Math.min(heading[1].length + 2, 6)}`, '', heading[2])); continue; }
      if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { flush(); target.append(node('hr')); continue; }
      const quote = /^>\s?(.*)$/.exec(line);
      if (quote) { flush(); target.append(node('blockquote', '', quote[1])); continue; }
      const item = /^\s*(?:([-+*])|\d+[.)])\s+(.+)$/.exec(line);
      if (item) {
        const tag = item[1] ? 'ul' : 'ol';
        if (paragraph.length || list?.tagName.toLowerCase() !== tag) { flush(); list = node(tag); target.append(list); }
        list.append(node('li', '', item[2]));
        continue;
      }
      if (list) list = null;
      paragraph.push(line);
    }
    flush();
    if (code) target.append(append(node('pre'), node('code', '', code.join('\n'))));
  }

  function renderBeingList() {
    const query = beings.query.trim().toLocaleLowerCase();
    const items = beings.items.filter((item) => [item.name, item.id, item.description, item.human?.name, item.human?.id].join(' ').toLocaleLowerCase().includes(query));
    ui.beingsRefresh.disabled = beings.loading;
    ui.beingsRefresh.textContent = beings.loading ? '读取中…' : '刷新';
    ui.beingsList.setAttribute('aria-busy', String(beings.loading));
    ui.beingsCount.textContent = query ? `找到 ${items.length} 位居民 · 共 ${beings.items.length} 位` : `${beings.items.length} 位居民`;
    const updated = beings.updatedAt ? `最近更新 ${dateText(beings.updatedAt)}` : '尚未更新';
    ui.beingsStatus.textContent = `${beings.loading ? '正在刷新' : visible('beings') ? '每 60 秒自动刷新' : '自动刷新已暂停'} · ${updated}`;
    ui.beingsDescription.textContent = beings.detail || '查看 Town 的 Being 与已公开的人类伙伴。';
    setNotice(ui.beingsNotice, beings.error ? `${beings.error}${beings.items.length ? ' 已保留上次读取的名录，将自动重试。' : ''}` : '', Boolean(beings.error));
    ui.beingsList.replaceChildren();
    if (!items.length) {
      const title = beings.loading && !beings.loaded ? '正在读取居民名录…' : beings.error && !beings.loaded ? '名录暂时无法读取' : query ? '没有匹配的居民' : '暂无居民';
      ui.beingsList.append(empty(title, query ? '试试其他 Being 名称或人类伙伴。' : '读取完成后，这里会列出 Town 的 Being。'));
      return;
    }
    const heading = append(node('div', 'ta-library-being-heading'), node('span', '', 'Being'), node('span', '', '人类伙伴'));
    heading.setAttribute('aria-hidden', 'true');
    ui.beingsList.append(heading);
    for (const item of items) {
      const row = node('article', 'ta-library-being-row');
      row.dataset.beingId = item.id;
      const main = node('div', 'ta-library-being-profile');
      const title = node('div', 'ta-library-being-title');
      title.append(node('h3', '', string(item.name, string(item.id, 'Being'))));
      const statuses = { online: '在线', connected: '在线', offline: '离线', disconnected: '离线', active: '活跃', idle: '空闲', busy: '忙碌' };
      if (statuses[item.status]) title.append(node('span', `ta-badge ${['online', 'connected'].includes(item.status) ? 'ta-good' : ''}`, statuses[item.status]));
      main.append(title);
      if (item.id && item.name && item.id !== item.name) main.append(node('p', 'ta-library-item-meta', item.id));
      if (item.description) main.append(node('p', 'ta-library-being-description', item.description));
      const human = record(item.human);
      const partner = node('div', 'ta-library-human');
      partner.append(node('span', 'ta-library-human-label', '人类伙伴'));
      partner.append(node('strong', human.name || human.id ? '' : 'ta-muted', string(human.name, string(human.id, '未公开'))));
      if (human.id && human.name && human.id !== human.name) partner.append(node('p', 'ta-library-item-meta', human.id));
      append(row, main, partner);
      ui.beingsList.append(row);
    }
  }

  function applyScrollList(state, result, offset, base = null) {
    if (!Array.isArray(result.scrolls)) throw new Error('卷轴列表格式不完整，请稍后重试。');
    if (!Number.isSafeInteger(result.offset) || result.offset !== offset) throw new Error('卷轴分页信息不完整，请重新读取。');
    const items = result.scrolls.filter((item) => item && typeof item.id === 'string');
    const fingerprint = JSON.stringify(result);
    // Keep already loaded pages when the refreshed first page is unchanged.
    const retainPages = !base && state.firstPage === fingerprint && state.items.length > items.length;
    if (!retainPages) {
      state.items = base ? [...new Map([...base, ...items].map((item) => [item.id, item])).values()] : items;
      state.nextOffset = (Number.isSafeInteger(result.offset) ? result.offset : offset) + result.scrolls.length;
      state.hasMore = Boolean(result.hasMore) && items.length > 0;
    }
    if (!base) state.firstPage = fingerprint;
    state.total = Number.isSafeInteger(result.total) ? result.total : state.items.length;
    state.loaded = true;
    if (state.selected && !state.items.some((item) => item.id === state.selected)) {
      state.selected = ''; state.detail = null; state.detailFirstPage = ''; state.detailError = ''; state.detailRequest += 1; state.detailLoading = false;
    }
  }

  async function loadScrolls(more = false) {
    if (!root || !connected() || scroll.loading) return;
    const state = scroll;
    const expected = epoch;
    const request = ++state.request;
    const offset = more ? state.nextOffset : 0;
    const base = more ? [...state.items] : null;
    const active = () => expected === epoch && request === state.request;
    state.loading = true;
    state.error = '';
    renderScrollList();
    try {
      if (more || !state.loaded) {
        const saved = await cached('listScrolls', { offset, limit: PAGE_SIZE });
        if (!active()) return;
        if (saved && (!more || currentListPage(state, saved))) {
          try {
            applyScrollList(state, saved.data, offset, base);
            if (!more) state.firstPageSavedAt = cacheTime(saved);
            renderScrollList(); renderDocument();
            // Restore previously fetched continuation pages without asking Being.
            while (!more && state.hasMore) {
              const nextOffset = state.nextOffset;
              const next = await cached('listScrolls', { offset: nextOffset, limit: PAGE_SIZE });
              if (!active()) return;
              // Older pages may belong to a different listing with the same total.
              if (!next || !currentListPage(state, next) || next.data.total !== state.total) break;
              applyScrollList(state, next.data, nextOffset, [...state.items]);
              renderScrollList();
              if (state.nextOffset <= nextOffset) break;
            }
          } catch { /* Invalid cached data must not prevent a fresh read. */ }
        }
      }
      const result = await call('listScrolls', { offset, limit: PAGE_SIZE });
      if (!active()) return;
      applyScrollList(state, result, offset, base);
      if (!more) state.firstPageSavedAt = Date.now();
    } catch (error) { if (expected === epoch && request === state.request) state.error = errorText(error); }
    finally {
      if (expected === epoch && request === state.request) { state.loading = false; renderScrollList(); renderDocument(); }
    }
  }

  function applyDocument(state, result, id, offset, base = null) {
    const detail = record(result.scroll);
    if (detail.id !== id || typeof detail.content !== 'string') throw new Error('卷轴内容格式不完整，请重新读取。');
    if (!Number.isSafeInteger(detail.offset) || detail.offset !== offset || !Number.isSafeInteger(detail.limit) || detail.limit < 1) throw new Error('卷轴分页信息不完整，请重新读取。');
    if (!Number.isSafeInteger(detail.nextOffset) || detail.nextOffset < offset || detail.hasMore && detail.nextOffset === offset) throw new Error('卷轴分页信息不完整，请重新读取。');
    if (base && base.revision !== detail.revision) throw new Error('卷轴已更新，请刷新后重新阅读。');
    const fingerprint = JSON.stringify(detail);
    const retainPages = !base && state.detailFirstPage === fingerprint && state.detail?.nextOffset > detail.nextOffset;
    if (!retainPages) state.detail = { ...detail, content: `${base ? base.content : ''}${detail.content}`, hasMore: Boolean(detail.hasMore) };
    if (!base) state.detailFirstPage = fingerprint;
  }

  async function selectScroll(id, more = false) {
    if (!connected() || !scroll.items.some((item) => item.id === id)) return;
    if (more && (scroll.selected !== id || !scroll.detail?.hasMore || scroll.detailLoading)) return;
    const state = scroll;
    const expected = epoch;
    const request = ++state.detailRequest;
    const changed = state.selected !== id;
    if (changed) { state.detail = null; state.detailFirstPage = ''; ui.scrollDocument.scrollTop = 0; }
    const base = more ? state.detail : null;
    const active = () => expected === epoch && request === state.detailRequest && state.selected === id;
    state.selected = id;
    state.detailLoading = true;
    state.detailError = '';
    renderScrollList(); renderDocument();
    try {
      const offset = more ? base.nextOffset : 0;
      if (more || !state.detail) {
        const saved = await cached('getScroll', { id, offset, limit: CONTENT_SIZE });
        if (!active()) return;
        if (saved) {
          try {
            applyDocument(state, saved.data, id, offset, base);
            renderDocument();
            while (!more && state.detail.hasMore) {
              const nextOffset = state.detail.nextOffset;
              const next = await cached('getScroll', { id, offset: nextOffset, limit: CONTENT_SIZE });
              if (!active()) return;
              if (!next) break;
              applyDocument(state, next.data, id, nextOffset, state.detail);
              renderDocument();
            }
          } catch { /* Retain the valid cached prefix and refresh from upstream. */ }
        }
      }
      const result = await call('getScroll', { id, offset, limit: CONTENT_SIZE });
      if (!active()) return;
      applyDocument(state, result, id, offset, base);
    } catch (error) { if (expected === epoch && request === state.detailRequest) state.detailError = errorText(error); }
    finally {
      if (expected === epoch && request === state.detailRequest) { state.detailLoading = false; renderDocument(); }
    }
  }

  function pauseTimer() {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }

  function scheduleRefresh() {
    pauseTimer();
    if (!visible('beings') || beings.loading) return;
    timer = window.setTimeout(() => {
      timer = null;
      if (visible('beings')) void loadBeings();
    }, REFRESH_MS);
  }

  async function loadBeings(cacheFirst = false) {
    if (!root || beings.loading) return;
    pauseTimer();
    const state = beings;
    const expected = epoch;
    const request = ++state.request;
    state.loading = true;
    state.error = '';
    renderBeingList();
    try {
      if (cacheFirst && !state.loaded) {
        const saved = await cached('listBeings');
        if (expected !== epoch || request !== state.request) return;
        if (saved && Array.isArray(saved.data.beings)) {
          state.items = saved.data.beings.filter((item) => item && typeof item.id === 'string');
          state.detail = string(saved.data.detail);
          state.updatedAt = saved.lastSuccessAt;
          state.loaded = true;
          renderBeingList();
        }
      }
      const result = await call('listBeings');
      if (expected !== epoch || request !== state.request) return;
      if (!Array.isArray(result.beings)) throw new Error('居民名录格式不完整，请稍后重试。');
      state.items = result.beings.filter((item) => item && typeof item.id === 'string');
      state.detail = string(result.detail);
      state.updatedAt = Date.now();
      state.loaded = true;
    } catch (error) { if (expected === epoch && request === state.request) state.error = errorText(error); }
    finally {
      if (expected === epoch && request === state.request) { state.loading = false; renderBeingList(); scheduleRefresh(); }
    }
  }

  function clearPrivate() {
    epoch += 1;
    pauseTimer();
    scroll = newScroll();
    beings = newBeings();
    if (root) { ui.scrollSearch.value = ''; ui.beingsSearch.value = ''; }
  }

  function setState(next) {
    if (!next || typeof next !== 'object') return;
    const connection = record(next.connection);
    const identity = record((next.townApp || next.town)?.identity);
    const key = JSON.stringify([identity.identityRevision ?? null, identity.connectionRevision ?? null, identity.beingId || '', connection.displayUrl || '', connection.beingName || '']);
    const changed = key !== identityKey;
    const connectionChanged = publicState.connection?.status !== connection.status;
    if (changed || connectionChanged && connection.status !== 'connected') clearPrivate();
    identityKey = key;
    publicState = next;
    if (!root) return;
    if (!changed && !connectionChanged) return;
    renderScrollList(); renderDocument(); renderBeingList();
    if (changed || connectionChanged) {
      if (visible('scroll')) void loadScrolls();
      if (visible('beings')) void loadBeings(true);
    }
  }

  function visibilityChanged() {
    if (visible('beings')) scheduleRefresh();
    else pauseTimer();
    if (root) renderBeingList();
  }

  function init(config) {
    if (root) return;
    options = record(config);
    root = options.root;
    bridge = options.bridge;
    if (!root || typeof root.append !== 'function') throw new Error('卷轴和居民名录容器不存在。');
    build();
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('pagehide', () => { pauseTimer(); observer?.disconnect(); document.removeEventListener('visibilitychange', visibilityChanged); }, { once: true });
    if (typeof MutationObserver === 'function') {
      observer = new MutationObserver(visibilityChanged);
      for (let ancestor = root; ancestor; ancestor = ancestor.parentElement) observer.observe(ancestor, { attributes: true, attributeFilter: ['hidden'] });
    }
  }

  async function open(id) {
    if (!root || !ids.has(id)) return;
    current = id;
    for (const value of ids) ui[`${value}Page`].hidden = value !== id;
    pauseTimer();
    renderScrollList(); renderDocument(); renderBeingList();
    if (id === 'scroll') {
      const expected = epoch;
      const selected = scroll.selected;
      const detailRequest = scroll.detailRequest;
      await loadScrolls();
      if (expected === epoch && current === id && !scroll.loading && selected && scroll.selected === selected && scroll.detailRequest === detailRequest) await selectScroll(selected);
    }
    if (id === 'beings') await loadBeings(true);
  }

  function hide() {
    current = '';
    pauseTimer();
    if (root) for (const id of ids) ui[`${id}Page`].hidden = true;
  }

  async function refresh() {
    if (current === 'scroll') await loadScrolls();
    if (current === 'beings') await loadBeings();
  }

  window.beingTownLibrary = Object.freeze({ init, setState, open, hide, refresh });
})();
