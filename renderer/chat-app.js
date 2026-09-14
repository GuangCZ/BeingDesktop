'use strict';
// Desktop-native conversation view. Draws what the main process projects for one conversation —
// durable history rows, the message just sent, the reply being streamed — and owns the composer.
// Nothing here talks to the Being: every action is an IPC call, every byte shown came through it.
//
// The markup mirrors what Loom's page looked like under Desktop's theme (src/loom-theme.css): a
// meta line ("you · 13:44:23" / "<being> · 13:44:23"), the content below it, consecutive messages
// grouped, a "— 13:40:01 —" divider after a long silence, thinking dots before the first token.
(() => {
  // Read lazily: the shell installs it before scripts run, fixtures install it afterwards.
  const bridge = () => window.beingDesktop;
  const $ = id => document.getElementById(id);
  const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
  const icon = d => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); svg.append(path); return svg; };
  const NOTICE_KEY = 'being-chat-notice-v1';
  const PHASES = {
    streaming: 'Being 正在回复…', replaying: '连接恢复中，正在续读回复…', reconnecting: '连接中断了，正在自动恢复…',
    'catching-up': '消息已送达，Being 正在处理其他会话，等它回到这里…', watching: 'being 正在呼吸…',
  };
  // Loom's grouping rules: same speaker within a minute shares one meta line; more than five
  // minutes of silence gets a divider.
  const GROUP_MS = 60000, GAP_MS = 300000;
  // Images go to the Being as content blocks with the text and are not kept by it (measured
  // 2026-09-11: history holds the text alone, and a message of images with no text lands no row).
  // The envelope is the measured one: PNG/JPEG/WebP/GIF, 10 MB per message. A small preview is
  // what the transcript keeps of each image, since nothing will ever come back for it.
  const IMAGE_TYPES = /^image\/(?:png|jpeg|webp|gif)$/, MAX_IMAGE_BYTES = 10 * 1024 * 1024, MAX_IMAGES = 8, THUMB_EDGE = 256, MAX_THUMB = 48 * 1024;
  // Loom's activity labels for tool_use events (tuiLabels), shown on the inline activity line.
  const TOOL_LABELS = {thinking: '在思考', remember: '在回忆', learn: '在反思', search_web: '在搜索', browse_web: '在浏览', read_file: '在阅读', write_file: '在编写', run_command: '在执行', list_files: '在查看', portal_exec: '在执行', act: '在行动'};
  const ui = {};
  const local = {mode: 'native', connected: false, beingName: 'being', chat: null, active: '', view: null, version: -1, live: null, activity: null, waiting: false, sending: false, stopping: false, pinned: true, frame: null, pending: [], reading: 0};
  local.references = [];
  const drafts = new Map();
  let selectionUI, composerUI;
  let mentionMembers = [];

  // The one argument worth showing for a tool call (Loom's extractKeyArg over parseToolInput).
  function keyArg(raw) {
    let input = raw;
    if (typeof raw === 'string') { try { input = JSON.parse(raw); } catch { input = {}; } }
    if (!input || typeof input !== 'object') return '';
    const cut = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
    const base = value => value.split(/[\\/]/).filter(Boolean).pop() || value;
    if (typeof input.query === 'string') return cut(input.query, 60);
    if (typeof input.path === 'string') return base(input.path);
    if (typeof input.file_path === 'string') return base(input.file_path);
    if (typeof input.command === 'string') return cut(input.command, 50);
    if (typeof input.url === 'string') { try { return new URL(input.url).hostname; } catch { return cut(input.url, 40); } }
    if (typeof input.topic === 'string') return cut(input.topic, 40);
    if (typeof input.content === 'string') return cut(input.content, 40);
    for (const value of Object.values(input)) if (typeof value === 'string' && value) return cut(value, 40);
    return '';
  }

  const epoch = at => { const value = new Date(at || '').getTime(); return Number.isNaN(value) ? 0 : value; };
  const clock = at => { const value = epoch(at); return value ? new Date(value).toLocaleTimeString('en-US', {hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'}) : ''; };

  // Minimal, safe markdown with Loom's output shape (marked with breaks:true): paragraphs with hard
  // line breaks, fenced code in a .code-block with its language label, lists, headings, quotes,
  // rules, bold, italic, inline code. Links are shown as text — the shell's CSP forbids navigation
  // from here anyway — and nothing is ever parsed as HTML.
  function renderMarkdown(text) {
    const fragment = document.createDocumentFragment();
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    let paragraph = [], list = null, quote = [], code = null;
    const flushParagraph = () => { if (paragraph.length) { fragment.append(inline(node('p'), paragraph.join('\n'))); paragraph = []; } };
    const flushList = () => { if (list) { fragment.append(list); list = null; } };
    const flushQuote = () => { if (quote.length) { fragment.append(inline(node('blockquote'), quote.join('\n'))); quote = []; } };
    const flushAll = () => { flushParagraph(); flushList(); flushQuote(); };
    const emitCode = () => {
      const block = node('div', 'code-block');
      if (code.lang) block.append(node('div', 'code-lang', code.lang));
      const pre = node('pre'); pre.append(node('code', code.lang ? `lang-${code.lang}` : '', code.lines.join('\n'))); block.append(pre);
      fragment.append(block); code = null;
    };
    for (const line of lines) {
      if (code) { if (/^\s*```/.test(line)) emitCode(); else code.lines.push(line); continue; }
      const fence = /^\s*```\s*([\w#+.-]{0,20})\s*$/.exec(line);
      if (fence) { flushAll(); code = {lang: fence[1].toLowerCase(), lines: []}; continue; }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); fragment.append(node('hr')); continue; }
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) { flushAll(); fragment.append(inline(node(`h${heading[1].length}`), heading[2])); continue; }
      const quoted = /^\s*>\s?(.*)$/.exec(line);
      if (quoted) { flushParagraph(); flushList(); quote.push(quoted[1]); continue; }
      flushQuote();
      const bullet = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line);
      if (bullet) {
        flushParagraph();
        const kind = bullet[2] ? 'ol' : 'ul';
        if (!list || list.tagName.toLowerCase() !== kind) { flushList(); list = node(kind); }
        list.append(inline(node('li'), bullet[3])); continue;
      }
      if (!line.trim()) { flushAll(); continue; }
      flushList();
      paragraph.push(line);
    }
    if (code) emitCode();
    flushAll();
    const walker = document.createTreeWalker(fragment, 4);
    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      if (!textNode.parentElement?.closest('code, pre, .chat-link')) textNode.nodeValue = window.beingTownMentions?.displayText(textNode.nodeValue, mentionMembers) ?? textNode.nodeValue;
    }
    return fragment;
  }
  function inline(target, text) {
    const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))|(\n)/g;
    let last = 0, match;
    while ((match = pattern.exec(text))) {
      if (match.index > last) target.append(text.slice(last, match.index));
      if (match[1]) target.append(node('code', '', match[1].slice(1, -1)));
      else if (match[2]) target.append(node('strong', '', match[2].slice(2, -2)));
      else if (match[3]) target.append(node('em', '', match[3].slice(1, -1)));
      else if (match[4]) { const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(match[4]); const span = node('span', 'chat-link', link[1]); span.title = link[2]; target.append(span); }
      else target.append(node('br'));
      last = pattern.lastIndex;
    }
    if (last < text.length) target.append(text.slice(last));
    return target;
  }

  function build() {
    const host = $('chat-native');
    if (!host || ui.root) return;
    ui.root = host;
    ui.notice = node('div', 'chat-notice');
    ui.notice.hidden = true;
    const noticeText = node('span', '', '所有会话共享同一个 being 的记忆，会话只是你的浏览视图。更早的记录（v1.7.0 之前）没有场景标记，未归入任何会话，可在 Loom 页面查看完整时间线。');
    const noticeClose = node('button', 'chat-notice-close', '知道了');
    noticeClose.type = 'button';
    noticeClose.addEventListener('click', () => { try { localStorage.setItem(NOTICE_KEY, '1'); } catch { /* ignore */ } ui.notice.hidden = true; });
    ui.notice.append(noticeText, noticeClose);
    ui.stream = node('div', 'chat-stream');
    ui.stream.setAttribute('role', 'log');
    ui.stream.setAttribute('aria-live', 'polite');
    ui.stream.addEventListener('scroll', () => { local.pinned = ui.stream.scrollHeight - ui.stream.scrollTop - ui.stream.clientHeight < 48; });
    // The composer area is Loom's #input-area under Desktop's theme: the pill, then a status line.
    ui.area = node('div', 'chat-composer-area');
    ui.composer = node('form', 'chat-composer');
    ui.input = node('textarea', 'chat-input');
    ui.input.placeholder = '随意输入…';
    ui.input.rows = 1;
    ui.input.setAttribute('aria-label', '给 Being 发消息，Enter 发送，Shift+Enter 换行');
    ui.input.addEventListener('keydown', event => { if (composerUI?.keydown(event)) return; if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(event); } });
    // The textarea grows with its content in CSS; older engines get the same by hand.
    if (!CSS.supports?.('field-sizing', 'content')) ui.input.addEventListener('input', () => { ui.input.style.height = 'auto'; ui.input.style.height = `${Math.min(ui.input.scrollHeight, 210)}px`; });
    ui.send = node('button', 'chat-send');
    ui.send.type = 'submit';
    ui.send.title = '发送'; ui.send.setAttribute('aria-label', '发送');
    ui.send.append(icon('M12 20V5M5 12l7-7 7 7'));
    ui.stop = node('button', 'chat-stop', '■');
    ui.stop.type = 'button';
    ui.stop.title = '停止生成'; ui.stop.setAttribute('aria-label', '停止生成');
    ui.stop.hidden = true;
    ui.stop.addEventListener('click', () => { void stop(); });
    // Images: a picker button, paste, and drop anywhere on the view; the tray above the pill holds
    // what will go with the next message.
    ui.attach = node('button', 'chat-attach');
    ui.attach.type = 'button';
    ui.attach.title = '添加图片 · 也可粘贴或拖入 · 每条消息最多 10 MB'; ui.attach.setAttribute('aria-label', '添加图片');
    ui.attach.append(icon('M21.4 11.05l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5'));
    ui.picker = node('input');
    ui.picker.type = 'file'; ui.picker.accept = 'image/png,image/jpeg,image/webp,image/gif'; ui.picker.multiple = true; ui.picker.hidden = true;
    ui.picker.setAttribute('aria-label', '选择图片');
    ui.picker.addEventListener('change', () => { void addFiles(ui.picker.files); ui.picker.value = ''; });
    ui.attach.addEventListener('click', () => ui.picker.click());
    ui.input.addEventListener('paste', event => {
      const files = [...(event.clipboardData?.files || [])].filter(file => IMAGE_TYPES.test(file.type));
      if (files.length) { event.preventDefault(); void addFiles(files); }
    });
    host.addEventListener('dragover', event => { if ([...(event.dataTransfer?.types || [])].includes('Files')) { event.preventDefault(); host.classList.add('is-dragover'); } });
    host.addEventListener('dragleave', event => { if (!host.contains(event.relatedTarget)) host.classList.remove('is-dragover'); });
    host.addEventListener('drop', event => { event.preventDefault(); host.classList.remove('is-dragover'); void addFiles(event.dataTransfer?.files); });
    ui.tray = node('div', 'chat-tray');
    ui.tray.hidden = true;
    ui.tray.setAttribute('aria-label', '待发送的图片');
    ui.composer.append(ui.attach, ui.picker, ui.input, ui.stop, ui.send);
    ui.references = node('div', 'chat-composer-references'); ui.references.hidden = true;
    ui.composer.prepend(ui.references);
    ui.send.addEventListener('click', event => { event.preventDefault(); void send(event); });
    ui.composer.addEventListener('submit', event => { event.preventDefault(); void send({isTrusted: false}); });
    ui.phase = node('div', 'chat-phase');
    ui.area.append(ui.tray, ui.composer, ui.phase);
    host.append(ui.notice, ui.stream, ui.area);
    composerUI = window.beingChatComposer?.install({input: ui.input, composer: ui.composer, area: ui.area, getBridge: bridge, getSession: () => local.active, onMembersChanged: members => { mentionMembers = members; repaint(); }});
    selectionUI = window.beingChatSelection?.install({root: host, stream: ui.stream, input: ui.input,
      getSession: () => local.active, isConnected: () => local.connected && !!local.active,
      addReference: reference => {
        const references = window.beingChatReferences.validate([...local.references, reference]);
        local.references = references; renderReferences();
      }, renderMarkdown, interleave, onRelease: () => repaint()});
    bridge()?.onChatEvent?.(onEvent);
  }

  function renderReferences() {
    if (!ui.references) return;
    ui.references.replaceChildren();
    ui.references.hidden = !local.references.length;
    ui.composer.classList.toggle('has-references', !!local.references.length);
    if (local.references.length) ui.references.append(window.beingChatSelection.referenceChip(local.references, {
      remove: () => { local.references = []; renderReferences(); ui.input.focus(); },
      removeOne: index => { local.references.splice(index, 1); renderReferences(); ui.input.focus(); },
    }));
  }

  // Add images to the next message: type and size checked here so the user hears about it before
  // anything is read, previews drawn as each file lands.
  async function addFiles(list) {
    const files = [...(list || [])].filter(file => file instanceof File);
    if (!files.length || ui.input.disabled) return;
    let total = local.pending.reduce((sum, image) => sum + image.size, 0), refused = '';
    const accepted = [];
    for (const file of files) {
      if (!IMAGE_TYPES.test(file.type)) { refused = `${file.name || '文件'} 不是图片，只支持 PNG、JPEG、WebP、GIF。`; continue; }
      if (local.pending.length + accepted.length >= MAX_IMAGES) { refused = `一条消息最多 ${MAX_IMAGES} 张图片。`; break; }
      if (total + file.size > MAX_IMAGE_BYTES) { refused = `${file.name || '图片'} 放不下了：一条消息的图片合计不能超过 10 MB。`; continue; }
      total += file.size; accepted.push(file);
    }
    if (refused) window.beingShell?.toast?.(refused, true);
    const session = local.active;
    local.reading += accepted.length; renderTray();
    await Promise.all(accepted.map(async file => {
      try {
        const [data, thumb] = await Promise.all([base64(file), thumbnail(file)]);
        // The conversation changed while reading: this image was meant for the other one.
        if (local.active === session) local.pending.push({id: `${Date.now()}-${Math.random()}`, name: file.name || '图片', media_type: file.type, size: file.size, data, thumb});
      } catch { window.beingShell?.toast?.(`${file.name || '图片'} 读取失败，请重新添加。`, true); }
      finally { local.reading--; renderTray(); }
    }));
    ui.input.focus();
  }
  function base64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => { const value = String(reader.result || ''); const at = value.indexOf(','); at >= 0 ? resolve(value.slice(at + 1)) : reject(new Error('unreadable')); };
      reader.onerror = () => reject(reader.error || new Error('unreadable'));
      reader.readAsDataURL(file);
    });
  }
  // A small JPEG on white: transparent PNGs stay legible and a transcript of previews stays small.
  async function thumbnail(file) {
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, THUMB_EDGE / Math.max(bitmap.width, bitmap.height, 1));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const url = canvas.toDataURL('image/jpeg', 0.7);
      return url.length <= MAX_THUMB ? url : '';
    } catch { return ''; }
  }
  function renderTray() {
    if (!ui.tray) return;
    ui.tray.replaceChildren();
    for (const image of local.pending) {
      const card = node('div', 'chat-tray-item');
      card.append(preview(image));
      const remove = node('button', 'chat-tray-remove', '×');
      remove.type = 'button'; remove.title = '移除'; remove.setAttribute('aria-label', `移除 ${image.name}`);
      remove.addEventListener('click', () => { local.pending = local.pending.filter(item => item !== image); renderTray(); ui.input.focus(); });
      card.append(remove);
      ui.tray.append(card);
    }
    if (local.reading) ui.tray.append(node('div', 'chat-tray-note', `正在读取 ${local.reading} 张图片…`));
    else if (local.pending.length) ui.tray.append(node('div', 'chat-tray-note', `${local.pending.length} 张图片将随下一条消息发送 · Being 只在这一轮看到它们，记录里保留缩略图`));
    ui.tray.hidden = !ui.tray.childNodes.length;
  }
  // One image as the transcript shows it: the preview, or the name when there is none.
  function preview(image) {
    if (image.thumb) { const img = node('img', 'chat-image'); img.src = image.thumb; img.alt = image.name || '图片'; img.title = image.name || ''; return img; }
    return node('span', 'chat-image chat-image-name', image.name || '图片');
  }

  function setState(appState) {
    build();
    if (!ui.root) return;
    local.mode = appState?.settings?.chatMode === 'loom' ? 'loom' : 'native';
    local.connected = appState?.connection?.status === 'connected';
    local.beingName = appState?.connection?.beingName || 'being';
    local.chat = appState?.chat || null;
    const active = local.chat?.open ? local.chat.active : '';
    const visible = local.mode === 'native' && appState?.connection?.configured === true;
    ui.root.hidden = !visible;
    if (!visible) { selectionUI?.sync(); composerUI?.sync(appState); return; }
    const typography = appState?.settings?.typography || {};
    ui.root.style.setProperty('--chat-font-size', `${[14, 15, 16].includes(typography.chatFontSize) ? typography.chatFontSize : 14}px`);
    ui.root.style.setProperty('--code-font-size', `${[12, 13, 14].includes(typography.codeFontSize) ? typography.codeFontSize : 12}px`);
    if (active !== local.active) {
      if (local.active) drafts.set(local.active, {text: ui.input.value, images: local.pending, references: local.references});
      local.active = active; local.view = null; local.live = null; local.activity = null; local.version = -1; local.pinned = true;
      const draft = drafts.get(active);
      ui.input.value = draft?.text || ''; ui.input.style.height = 'auto';
      local.pending = draft?.images || []; local.references = draft?.references || [];
      renderTray(); renderReferences();
    }
    selectionUI?.sync();
    const session = local.chat?.sessions.find(item => item.id === active);
    const recovery = local.chat?.recovery || {};
    const phase = recovery.phase || 'idle';
    // A hint about another conversation's breath belongs under that conversation, not this one.
    const hint = ((!recovery.sessionId || recovery.sessionId === active) && recovery.hint) || PHASES[phase] || '';
    ui.phase.textContent = local.connected ? (local.chat?.degraded ? `${hint}${hint ? ' · ' : ''}本机未加密，记录仅保留在内存` : hint) : '尚未连接';
    ui.input.disabled = !local.connected || !active;
    ui.send.disabled = ui.input.disabled || local.sending;
    ui.attach.disabled = ui.input.disabled;
    composerUI?.sync(appState);
    ui.stop.hidden = !(session && (session.busy || session.inFlight)) && !['streaming', 'replaying'].includes(phase);
    ui.stop.disabled = local.stopping;
    // Our reader is up for this conversation: show the Being at work from the moment the message
    // leaves, not from its first token. (inFlight lags the phase by one broadcast, so check both.)
    local.waiting = !!(session && (session.inFlight || (recovery.sessionId === active && (phase === 'streaming' || phase === 'replaying'))));
    try { ui.notice.hidden = !local.chat?.open || localStorage.getItem(NOTICE_KEY) === '1'; } catch { ui.notice.hidden = false; }
    if (active && local.chat && local.chat.version !== local.version) void refresh();
    else render();
  }

  async function refresh() {
    const id = local.active, version = local.chat?.version ?? -1;
    if (!id || !bridge()?.chatView) return;
    try {
      const view = await bridge().chatView(id);
      if (view.sessionId !== local.active) return;
      local.view = view; local.version = version;
      local.live = view.live ? {text: view.live.text, think: view.live.think, at: view.live.at} : null;
      render();
    } catch (error) { ui.phase.textContent = error?.message || '记录读取失败'; }
  }

  // The activity line Desktop drew inline in the being's row (Loom's #tui-bar): what the Being is
  // doing right now, and a log of the breath so far behind a disclosure.
  function activityLine({text = '', think = '', live = false} = {}) {
    const current = live ? local.activity?.current : null;
    const details = node('details', 'chat-think');
    const summary = node('summary', 'chat-think-line');
    const label = current ? (current.error ? `${current.label} ✗` : current.label) : live ? (text ? '正在回复' : think ? '思考中' : '等待回复') : '思考过程';
    const preview = current ? current.arg : (think ? think.trim().slice(-60) : '');
    summary.append(node('span', 'chat-think-prompt', '⟩'), node('span', 'chat-think-label', label), node('span', 'chat-think-preview', preview));
    if (live) summary.append(node('span', 'chat-think-cursor', '▊'));
    const body = node('div', 'chat-think-body');
    for (const entry of (live && local.activity?.log) || []) body.append(node('div', 'chat-think-entry', `${entry.label} ${entry.arg} ${entry.done ? (entry.error ? '✗' : '✓') : '…'}`.trim()));
    if (think) body.append(node('div', 'chat-think-text', think));
    if (!body.childNodes.length) body.append(node('div', 'chat-think-text', '（没有思考过程）'));
    details.append(summary, body);
    return details;
  }

  // One message: meta line, the activity line while the Being works on it, content.
  function bubble(role, text, {pending = false, partial = false, think = '', at = '', live = false, images = null} = {}) {
    const article = node('article', `chat-message is-${role}${pending ? ' is-pending' : ''}${live ? ' is-live' : ''}`);
    const note = partial ? '回复中断，等待记录核对' : pending ? '等待记录确认' : '';
    article.append(node('div', 'chat-meta', [role === 'user' ? 'you' : local.beingName, clock(at), note].filter(Boolean).join(' · ')));
    if (think || live) article.append(activityLine({text, think, live}));
    if (Array.isArray(images) && images.length) {
      const strip = node('div', 'chat-images');
      strip.setAttribute('aria-label', `${images.length} 张图片`);
      for (const image of images) strip.append(preview(image));
      article.append(strip);
    }
    const decoded = role === 'user' ? window.beingChatReferences?.decode(text) : null;
    if (decoded?.references.length) article.append(window.beingChatSelection.referenceChip(decoded.references, {onClose: repaint}));
    if (decoded) text = decoded.text;
    const body = node('div', 'chat-body');
    // Loom streams escaped text and renders markdown once the moment is whole; so do we.
    if (live) body.textContent = text; else body.append(renderMarkdown(text));
    article.append(body);
    return article;
  }

  function workerResult(item) {
    const article = node('article', 'chat-message is-being');
    article.append(node('div', 'chat-meta', [local.beingName, clock(item.at)].filter(Boolean).join(' · ')));
    const card = node('section', 'chat-worker-result');
    card.dataset.workerId = item.workerId;
    const labels = {passed: '已完成', failed: '未完成', needs_verification: '待补充验证', ready: '结果已就绪'};
    card.append(node('div', 'chat-worker-status', labels[item.status] || '待补充验证'), node('h3', '', item.title), node('div', 'chat-worker-summary', item.summary));
    if (item.preview) {
      const open = node('button', 'chat-worker-open', '打开预览');
      open.type = 'button';
      open.addEventListener('click', async () => {
        open.disabled = true;
        try { await bridge().chatOpenWorkerResult({sessionId: item.sessionId, workerId: item.workerId}); }
        catch (error) { ui.phase.textContent = error.message || '结果预览未能打开'; }
        finally { open.disabled = false; }
      });
      card.append(open);
    }
    if (item.evidence) {
      const details = node('details', 'chat-worker-evidence');
      details.append(node('summary', '', '查看验证依据'), node('div', '', item.evidence));
      card.append(details);
    }
    article.append(card);
    return article;
  }

  // Newest at the bottom. Durable rows keep their seq order; a transient item goes after every row
  // that already existed when it was made (`after`, so a skewed clock cannot lift it above them),
  // then in time order among the rows that landed since — an unconfirmed reply sits where it was
  // spoken, not under whatever came later.
  function interleave(rows, transient) {
    const place = item => {
      const at = epoch(item.at);
      let index = 0;
      while (index < rows.length && Number.isFinite(rows[index].seq) && rows[index].seq <= (item.after || 0)) index++;
      while (index < rows.length && (!at || epoch(rows[index].at) <= at)) index++;
      return index - 0.5;
    };
    return [...rows.map((row, index) => ({...row, key: index})), ...transient.map(item => ({...item, key: place(item)}))]
      .sort((left, right) => left.key - right.key || epoch(left.at) - epoch(right.at));
  }

  function render() {
    if (!ui.stream || ui.root.hidden || selectionUI?.isSelecting()) return;
    const view = local.view;
    const fragment = document.createDocumentFragment();
    if (view?.rows.length && local.chat?.sessions.find(item => item.id === local.active)?.truncated) {
      const more = node('button', 'chat-more', '记录已裁剪，重新读取最新窗口');
      more.type = 'button';
      more.addEventListener('click', async () => { more.disabled = true; try { await bridge().chatReload(); } catch (error) { ui.phase.textContent = error.message; } });
      fragment.append(more);
    }
    const rows = (view?.rows || []).map(row => ({role: row.role === 'user' ? 'user' : 'being', text: row.content, at: row.at, seq: row.seq, images: row.images}));
    const items = interleave(rows, [
      ...(view?.workerResults || []).map(item => ({...item, role: 'being', workerResult: true})),
      ...(view?.sent || []).map(item => ({role: 'user', text: item.text, at: item.at, after: item.after, pending: true, images: item.images})),
      ...(view?.replied || []).map(item => ({role: 'being', text: item.text, at: item.at, after: item.after, pending: true, partial: item.partial === true, think: item.think})),
    ]);
    if (local.live && (local.live.text || local.live.think)) items.push({role: 'being', text: local.live.text, think: local.live.think, at: local.live.at, live: true});
    let lastRole = '', lastAt = 0;
    for (const item of items) {
      const at = epoch(item.at);
      const gap = lastAt && at ? Math.abs(at - lastAt) : 0;
      if (gap > GAP_MS) fragment.append(node('div', 'time-gap', `— ${clock(lastAt)} —`));
      const element = item.workerResult ? workerResult(item) : bubble(item.role, item.text, item);
      if (item.role === lastRole && gap <= GROUP_MS && !item.pending && !item.live) element.classList.add('is-consecutive');
      fragment.append(element);
      lastRole = item.role; if (at) lastAt = at;
    }
    ui.live = items.length && items[items.length - 1].live ? fragment.lastChild : null;
    // Loom's thinking indicator: the Being has the message and has not said anything yet — three
    // dots, or the tool it is using, until the first token arrives.
    if (local.waiting && !ui.live) {
      const thinking = node('article', 'chat-message is-being chat-thinking');
      thinking.append(node('div', 'chat-meta', local.beingName));
      if (local.activity?.log.length) thinking.append(activityLine({live: true}));
      else {
        const dots = node('div', 'chat-body');
        for (let i = 0; i < 3; i++) dots.append(node('span', 'chat-dot'));
        thinking.append(dots);
      }
      fragment.append(thinking);
    }
    ui.stream.replaceChildren(fragment);
    if (local.pinned) ui.stream.scrollTop = ui.stream.scrollHeight;
  }

  const repaint = () => { if (local.frame === null) local.frame = requestAnimationFrame(() => { local.frame = null; render(); }); };

  // Live deltas and tool activity update the last bubble in place; anything else re-reads the projection.
  function onEvent(event) {
    if (!event || event.sessionId !== local.active) return;
    if (event.type === 'delta' || event.type === 'think') {
      local.live = local.live || {text: '', think: '', at: new Date().toISOString()};
      if (event.type === 'delta') local.live.text += event.text; else local.live.think += event.text;
      repaint();
      return;
    }
    if (event.type === 'tool_use') {
      const data = event.data || {};
      const name = typeof data.name === 'string' && data.name ? data.name : 'tool';
      const entry = {label: TOOL_LABELS[name] || name, arg: keyArg(data.input), done: false, error: false};
      local.activity = local.activity || {log: [], current: null};
      local.activity.log.push(entry); local.activity.current = entry;
      repaint();
      return;
    }
    if (event.type === 'tool_result') {
      const entry = local.activity?.log.slice().reverse().find(item => !item.done);
      if (entry) { entry.done = true; entry.error = event.data?.is_error === true; local.activity.current = entry.error ? entry : null; }
      repaint();
      return;
    }
    if (event.type === 'reply' || event.type === 'error' || event.type === 'settled') { local.live = null; local.activity = null; }
    local.version = -1;
    void refresh();
  }

  async function send(event) {
    const text = ui.input.value;
    if (local.sending || ui.input.disabled || !local.active || !bridge()?.chatSend) return;
    if (local.reading) { window.beingShell?.toast?.('图片还在读取，稍等一下再发送。'); return; }
    // Images alone land no row and get the previous message answered: the Being needs the words.
    if (!text.trim()) { if (local.references.length) window.beingShell?.toast?.('输入想讨论的问题，再连同引用一起发送。'); else if (local.pending.length) window.beingShell?.toast?.('给图片配一句话再发送。', true); return; }
    let plan;
    try { plan = composerUI?.prepare(text, event) || {text}; }
    catch (error) { window.beingShell?.toast?.(error.message, true); return; }
    local.sending = true; ui.send.disabled = true;
    const sessionId = local.active, images = local.pending, references = local.references;
    ui.input.value = ''; ui.input.style.height = 'auto'; composerUI?.refresh();
    local.pending = []; local.references = []; renderTray(); renderReferences();
    // The Being is at work from this moment; the projection catches up a broadcast later.
    local.waiting = true; render();
    try {
      const result = await bridge().chatSend({sessionId, text: plan.text, ...(references.length ? {references} : {}), ...(images.length ? {images: images.map(({name, media_type, data, thumb}) => ({name, media_type, data, thumb}))} : {})});
      if (result?.spliced) window.beingShell?.toast?.('消息已送达，Being 正在处理其他会话，回复稍后到达。');
      await composerUI?.publish(plan, result);
    } catch (error) {
      const draft = local.active === sessionId ? {text: ui.input.value, images: local.pending, references: local.references} : drafts.get(sessionId);
      const restored = {text: text + (draft?.text ? '\n' + draft.text : ''), images: [...images, ...(draft?.images || [])], references: [...references, ...(draft?.references || [])]};
      drafts.set(sessionId, restored);
      if (local.active === sessionId) { ui.input.value = restored.text; local.pending = restored.images; local.references = restored.references; local.waiting = false; renderTray(); renderReferences(); render(); }
      window.beingShell?.toast?.(error?.message || '发送失败', true);
    } finally { local.sending = false; ui.send.disabled = ui.input.disabled; if (local.active === sessionId) { ui.input.focus(); composerUI?.refresh(); } }
  }

  async function stop() {
    if (local.stopping || !local.active || !bridge()?.chatStop) return;
    local.stopping = true; ui.stop.disabled = true;
    try {
      const result = await bridge().chatStop({sessionId: local.active});
      if (result.stopped) return;
      if (result.reason === 'other-scene') {
        const who = result.ownerTitle ? `「${result.ownerTitle}」` : '另一个会话';
        if (window.confirm(`Being 正在回复的是${who}，不是这个会话。要停止那边的回复吗？`)) await bridge().chatStop({sessionId: local.active, force: true});
      } else if (result.reason === 'unknown') {
        // A bubble just closed: the last speaker is known, the next one is not.
        const last = result.ownerTitle ? `刚说完的是「${result.ownerTitle}」，接下来轮到谁还不确定。` : '无法确认 Being 正在回复哪个会话。';
        if (window.confirm(`${last}仍要停止当前这口气吗？`)) await bridge().chatStop({sessionId: local.active, force: true});
      } else if (result.reason === 'autonomous') window.beingShell?.toast?.('Being 正在自己思考，没有属于会话的回复可以停止。');
      else window.beingShell?.toast?.('当前没有正在进行的回复。');
    } catch (error) { window.beingShell?.toast?.(error?.message || '停止失败', true); }
    finally { local.stopping = false; ui.stop.disabled = false; }
  }

  window.beingChat = {setState, refresh, isNative: () => local.mode === 'native'};
})();
