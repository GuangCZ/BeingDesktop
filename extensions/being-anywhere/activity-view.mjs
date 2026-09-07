const LABELS = {
  sending: '正在发送', thinking: 'Being 在思考', acting: 'Being 在行动',
  replying: 'Being 在回复', waiting: '等待 Being', reconnecting: '正在接续',
  complete: '已完成', stopped: '已停止', error: '连接中断', unconfirmed: '等待回复'
};
const LIVE_STATES = new Set(['sending', 'thinking', 'acting', 'replying', 'waiting', 'reconnecting']);
const MAX_ENTRIES = 24;
const MAX_TEXT = 24000;

function textValue(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => typeof part === 'string' ? part : part?.text || '').join('\n');
  if (value && typeof value === 'object') return typeof value.text === 'string' ? value.text : '';
  return '';
}

function safeText(value, limit = MAX_TEXT) {
  const text = textValue(value);
  const truncated = text.length > limit;
  const clean = text.slice(0, limit)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/https?:\/\/[^\s<>"']+/gi, value => {
      try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return '[链接]'; }
    })
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk|sk-proj|ghp|github_pat)-?[A-Za-z0-9_-]{20,}\b/g, '[已隐藏]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}"']+)/gi, '$1[已隐藏]');
  return clean + (truncated ? '…' : '');
}

function toolLabel(name) {
  const clean = safeText(name, 100).trim();
  if (/search|lookup|query/i.test(clean)) return '搜索';
  if (/browse|fetch|navigate|open_url|web/i.test(clean)) return '读取网页';
  if (/read|inspect|list|find/i.test(clean)) return '读取内容';
  if (/write|edit|patch|create|save/i.test(clean)) return '更新内容';
  if (/exec|shell|bash|terminal|run/i.test(clean)) return '执行操作';
  return clean || '执行操作';
}

function toolInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  for (const key of ['query', 'search_query', 'title']) {
    if (typeof input[key] === 'string') return safeText(input[key], 300);
  }
  if (typeof input.url === 'string') return safeText(input.url, 300);
  for (const key of ['file_path', 'path', 'filename']) {
    if (typeof input[key] === 'string') return safeText(input[key].split(/[\\/]/).pop(), 180);
  }
  return '';
}

export function createActivityView({ container, scrollContainer }) {
  if (!container?.ownerDocument) throw new TypeError('An activity container is required.');
  const document = container.ownerDocument;
  let section, status, details, preview, list;
  let entries = [];
  let thinkingEntry = null;
  let active = false;
  let destroyed = false;
  const tools = new Map();

  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function update(callback) {
    const follow = scrollContainer && scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < 64;
    callback();
    if (follow) scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }

  function state(next) {
    if (!section || !(next in LABELS)) return;
    section.dataset.state = next;
    section.dataset.active = String(active && LIVE_STATES.has(next));
    if (status.textContent !== LABELS[next]) status.textContent = LABELS[next];
  }

  function refreshPreview(entry = entries.at(-1)) {
    details.hidden = entries.length === 0;
    if (entry) preview.textContent = [entry.label, entry.text].filter(Boolean).join(' · ').replace(/\s+/g, ' ').trim();
  }

  function addEntry(kind, label, text = '', id = '') {
    const node = element('div', 'being-process-item');
    node.dataset.kind = kind;
    node.dataset.status = 'running';
    const heading = element('div', 'being-process-heading');
    heading.append(element('span', 'being-process-label', label));
    const outcome = element('span', 'being-process-outcome', '进行中');
    heading.append(outcome);
    const content = element('p', 'being-process-content', text);
    content.hidden = !text;
    node.append(heading, content);
    list.append(node);
    const entry = { node, content, outcome, kind, label, text, id };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) {
      const old = entries.shift();
      old.node.remove();
      if (old.id) tools.delete(old.id);
    }
    refreshPreview(entry);
    return entry;
  }

  function completeEntry(entry, outcome = 'complete') {
    if (!entry) return;
    entry.node.dataset.status = outcome;
    entry.outcome.textContent = outcome === 'error' ? '未完成' : outcome === 'stopped' ? '已停止' : outcome === 'unconfirmed' ? '待确认' : '完成';
  }

  function endThinking() {
    completeEntry(thinkingEntry);
    thinkingEntry = null;
  }

  function reset() {
    active = false;
    container.dataset.active = 'false';
    entries = [];
    thinkingEntry = null;
    tools.clear();
    container.replaceChildren();
    section = null;
    container.hidden = true;
  }

  function start() {
    if (destroyed) return;
    update(() => {
      reset();
      active = true;
      container.dataset.active = 'true';
      container.hidden = false;
      section = element('section', 'being-progress');
      section.setAttribute('aria-label', 'Being 动态');
      section.setAttribute('aria-live', 'off');
      const row = element('div', 'being-progress-row');
      const logo = element('img', 'being-progress-logo');
      logo.src = 'icons/being-20.png';
      logo.srcset = [16, 20, 24, 32, 40, 48, 64, 80, 96, 112, 128, 160, 192, 256].map(size => `icons/being-${size}.png ${size}w`).join(', ');
      logo.sizes = '19px';
      logo.alt = '';
      const motion = element('span', 'being-progress-motion');
      motion.setAttribute('aria-hidden', 'true');
      motion.append(element('i'), element('i'), element('i'));
      status = element('span', 'being-progress-status');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.setAttribute('aria-atomic', 'true');
      row.append(logo, status, motion);
      details = element('details', 'being-process');
      details.hidden = true;
      const summary = element('summary', 'being-process-summary');
      summary.append(element('span', 'being-process-caption', '过程'));
      preview = element('span', 'being-process-preview');
      const chevron = element('span', 'being-process-chevron', '⌄');
      chevron.setAttribute('aria-hidden', 'true');
      summary.append(preview, chevron);
      list = element('div', 'being-process-list');
      details.append(summary, list);
      section.append(row, details);
      container.append(section);
      state('sending');
    });
  }

  function handle(event) {
    if (!active || destroyed || !event) return;
    update(() => {
      const data = event.data || {};
      if (event.type === 'thinking' || event.type === 'reasoning') {
        state('thinking');
        const delta = textValue(typeof data === 'string' ? data : data.delta?.thinking ?? data.delta?.reasoning ?? data.delta?.text ?? data.thinking ?? data.reasoning ?? data.text ?? data.content ?? data.delta);
        if (!delta) return;
        if (!thinkingEntry) thinkingEntry = addEntry('thinking', '思考');
        thinkingEntry.rawText = ((thinkingEntry.rawText || '') + delta).slice(0, MAX_TEXT + 1);
        thinkingEntry.text = safeText(thinkingEntry.rawText);
        thinkingEntry.content.textContent = thinkingEntry.text;
        thinkingEntry.content.hidden = false;
        refreshPreview(thinkingEntry);
      } else if (event.type === 'tool_use') {
        endThinking();
        state('acting');
        const id = String(data.id || data.tool_use_id || data.tool_call_id || '');
        let entry = id && tools.get(id);
        if (!entry) {
          entry = addEntry('tool', toolLabel(data.name || data.tool_name), toolInput(data.input || data.arguments), id);
          if (id) tools.set(id, entry);
        }
        refreshPreview(entry);
      } else if (event.type === 'tool_result') {
        endThinking();
        const id = String(data.tool_use_id || data.tool_call_id || data.id || '');
        const pending = id ? tools.get(id) : entries.findLast(item => item.kind === 'tool' && !item.id && item.node.dataset.status === 'running');
        const entry = pending || addEntry('tool', toolLabel(data.name || data.tool_name), '', id);
        if (id) tools.set(id, entry);
        const failed = data.is_error === true || data.success === false || data.status === 'error' || Boolean(data.error);
        completeEntry(entry, failed ? 'error' : 'complete');
        const result = safeText(data.content ?? data.output ?? data.result ?? data.text ?? data.error?.message, 4000);
        if (result) {
          entry.text = [entry.text, result].filter(Boolean).join('\n');
          entry.content.textContent = entry.text;
          entry.content.hidden = false;
        }
        refreshPreview(entry);
        state(entries.some(item => item.kind === 'tool' && item.node.dataset.status === 'running') ? 'acting' : 'thinking');
      } else if (event.type === 'content_block_delta') {
        endThinking();
        state('replying');
      } else if (event.type === 'message_stop') {
        endThinking();
        state('waiting');
      } else if (event.type === 'meta' && section.dataset.state === 'sending') {
        state('thinking');
      } else if (event.type === 'error') {
        finish('error');
      }
    });
  }

  function setState(next) {
    if (active && !destroyed) update(() => state(next));
  }

  function finish(outcome = 'complete') {
    if (!section || destroyed) return;
    update(() => {
      active = false;
      container.dataset.active = 'false';
      const final = ['complete', 'stopped', 'error', 'unconfirmed'].includes(outcome) ? outcome : 'complete';
      for (const entry of entries) {
        if (entry.node.dataset.status === 'running') completeEntry(entry, final === 'complete' && entry.kind === 'tool' ? 'unconfirmed' : final);
      }
      thinkingEntry = null;
      details.open = false;
      state(final);
      if (!entries.length && final === 'complete') container.hidden = true;
    });
  }

  reset();
  return { start, handle, setState, finish, reset, destroy() { reset(); destroyed = true; } };
}
