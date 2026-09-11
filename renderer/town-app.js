'use strict';

(() => {
  const ids = new Set(['grove', 'channel', 'portal', 'fireside', 'bonfire', 'inbox', 'scroll', 'beings']);
  const libraryIds = new Set(['scroll', 'beings']);
  const names = { grove: '工具市场', channel: '消息渠道', portal: '电脑连接', fireside: '围炉', bonfire: '篝火', inbox: '私信', scroll: '卷轴', beings: '居民名录' };
  const subtitles = {
    grove: '为 Being 发现新的能力。',
    channel: '让 Being 出现在你常用的聊天工具里。',
    portal: '把这台电脑上的工作区交给 Being 使用。',
    fireside: 'Town 实时同步围炉消息，断线恢复后自动更新。',
    bonfire: 'Town 实时同步篝火消息，断线恢复后自动更新。',
    inbox: '收到的私信。进入页面、手动刷新或收到新私信时读取。',
    scroll: '浏览卷轴文档，在这里继续阅读。',
    beings: '认识 Town 的 Being 与人类伙伴。',
  };
  const statusNames = {
    unknown: '待确认', auth_required: '需要授权', unavailable: '暂不可用', ready: '可访问',
    connected: '已连接', connecting: '连接中', pending: '等待确认', working: 'Being 正在处理', registered: '已登记',
    downloaded: '已下载', installed: '已安装 · 尚未确认加载', loaded: '已加载',
    running: '运行中', external: '已有 Portal', stopped: '已停止', not_configured: '尚未部署',
    downloading: '下载中', verifying: '校验中', extracting: '解包中', deploying: '部署中',
    error: '操作失败', failed: '操作失败', uncertain: '结果待确认', unsupported: '暂不支持',
    needs_setup: '安装条件需处理', blocked: '安装条件未满足', installing: '部署中',
    existing_configuration: '已有配置 · 已保留', access_required: '需要授权',
    waiting: '等待扫码', expired: '二维码已过期', disabled: '已停用', disconnected: '未连接',
  };
  const ui = {};
  let bridge;
  let options;
  let root;
  let current = 'grove';
  let publicState = {};
  let town = { access: {}, identity: {} };
  let identityKey = '';
  let epoch = 0;
  let groveRequest = 0;
  let detailRequest = 0;
  let roomRequest = 0;
  let roomSelection = 0;
  let channelRequest = 0;
  let navigation = 0;
  let townRevision = 0;
  let lastPublicRender = '';
  let messageSubscription = null;
  let bonfireMembersCollapsed = false;
  const busy = new Set();
  const townReads = new Map();
  const model = {
    grove: { kits: [], count: 0, query: '', category: '', status: 'idle', error: '', selected: '', detail: null, detailStatus: 'idle', detailError: '', checks: new Map(), operations: new Map(), operationErrors: new Map(), batch: null, batchRunning: false, expanded: new Set(), scrollTop: 0 },
    channel: { selected: 'feishu', wizard: false, status: 'unknown', detail: '', qr: '', step: 0 },
    portal: { confirm: false, status: '', detail: '', permissions: { files: true, exec: false, web: false } },
    fireside: { rooms: [], selected: '', messages: [], members: [], status: 'idle', error: '', messageError: '', roomError: '', latestSeq: null, refresh: {}, drafts: new Map(), replies: new Map(), deliveries: [], showMembers: null, dialog: '', hasOlder: false, lastRefresh: null, loadingOlder: false, olderError: '' },
    bonfire: { messages: [], members: [], status: 'idle', error: '', memberError: '', sendError: '', draft: '', sender: '', latestSeq: null, refresh: {}, mentionIndex: 0, mentionClosed: false, replyTo: null, hasOlder: false, lastRefresh: null, loadingOlder: false, olderError: '' },
    inbox: { messages: [], status: 'idle', error: '', sendError: '', recipient: '', draft: '', replyTo: null },
  };

  const string = (value, fallback = '') => typeof value === 'string' && value ? value : fallback;
  const array = (value) => Array.isArray(value) ? value : [];
  const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const node = (tag, className, value) => {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (value !== undefined) result.textContent = String(value);
    return result;
  };
  const append = (parent, ...children) => { parent.append(...children.filter(Boolean)); return parent; };
  // Town tags every message with who actually spoke: "being" is the Being itself, while
  // "client:<name>" is a human speaking through a paired client token. Only the borrowed
  // case is labelled, matching the SDK reference client.
  const viaBadge = (entry) => {
    const via = string(entry.via);
    return via.startsWith('client:') ? node('span', 'ta-message-via', `借 ${via.slice(7)}`) : null;
  };
  // Town reports the parent of a reply as {id, beingId, preview}; the preview is a short excerpt.
  const replyQuote = (entry) => {
    const parent = record(entry.replyTo);
    if (!parent.id) return null;
    const who = string(parent.beingId, '某位 Being');
    const preview = string(parent.preview);
    return append(node('div', 'ta-message-quote'), node('span', 'ta-message-quote-who', `回复 ${who}`), node('span', 'ta-message-quote-text', preview || '（原文未提供）'));
  };
  const replyButton = (entry, onReply) => {
    const control = button('回复', () => onReply(entry), 'ta-quiet ta-message-reply');
    control.setAttribute('aria-label', `回复 ${string(entry.beingName, string(entry.senderName, '这条消息'))}`);
    return control;
  };
  // Shown above a composer while a reply target is pending.
  const replyBanner = (parent, onCancel) => {
    const target = record(parent);
    if (!target.id) return null;
    const strip = append(node('div', 'ta-reply-banner'),
      node('span', 'ta-reply-banner-text', `正在回复 ${string(target.beingName, string(target.beingId, '某位 Being'))}：${string(target.preview, '（原文未提供）').slice(0, 60)}`),
      button('取消', onCancel, 'ta-quiet ta-reply-cancel'));
    return strip;
  };
  const text = (target, value) => { target.textContent = value == null ? '' : String(value); };
  const visible = (target, show) => { target.hidden = !show; };
  const button = (label, action, variant = '', id = '') => {
    const result = node('button', `ta-button ${variant}`, label);
    result.type = 'button';
    if (id) result.id = id;
    result.addEventListener('click', action);
    return result;
  };
  const icon = (name) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  };
  const badge = (value, label = '') => {
    const tone = ['connected', 'loaded', 'running', 'ready'].includes(value) ? 'good' : ['error', 'failed'].includes(value) ? 'error' : ['uncertain', 'auth_required', 'unsupported'].includes(value) ? 'warning' : 'neutral';
    return node('span', `ta-badge ta-${tone}`, label || statusNames[value] || '待确认');
  };
  const message = (title, description, action) => append(node('div', 'ta-empty'), node('h3', '', title), node('p', '', description), action);
  const notice = () => { const result = node('p', 'ta-notice'); result.setAttribute('role', 'status'); result.hidden = true; return result; };
  const setNotice = (target, value, error = false) => { text(target, value); target.classList.toggle('ta-error', error); target.hidden = !value; };
  const errorText = (error) => string(error?.message, '操作没有完成，请稍后重试。').slice(0, 400);
  const access = (id) => {
    const value = town.access?.[id];
    const status = typeof value === 'string' ? value : string(value?.status, 'unknown');
    return status === 'access_required' ? 'auth_required' : status;
  };
  const can = (id) => access(id) === 'ready';
  const canSendFireside = () => can('firesideSend') || can('fireside');
  const canSendBonfire = () => publicState.connection?.status === 'connected';
  // reply_to only travels on the paired client path; the Being relay fallback has no way to carry it,
  // so the control is not offered when replying would silently drop the parent.
  const canReply = () => record(town.client).paired === true;
  const beingName = () => string(town.identity?.displayName, string(publicState.connection?.beingName, '当前 Being'));
  const beingId = () => string(town.identity?.beingId);
  const sameEpoch = (value) => value === epoch;
  const activeRoute = (value) => value === navigation && !root.hidden;
  const visibleModule = (id) => root && !root.hidden && current === id;
  const connected = () => publicState.connection?.status === 'connected';
  const townReadKey = () => JSON.stringify([epoch, current, current === 'fireside' ? [model.fireside.selected, roomSelection] : '']);
  const refreshErrors = {
    AUTH_REQUIRED: '请在「设置 → 连接」中用 Being 提供的六位配对码连接 Town。',
    IDENTITY_MISMATCH: '后台身份与当前 Being 不一致，请重新连接。',
    BACKGROUND_UNAVAILABLE: '消息读取接口暂不可用，请稍后手动更新。',
    NOT_CONNECTED: '请先连接 Being。', NETWORK_ERROR: '连接暂时中断，请稍后手动更新。',
    RATE_LIMITED: '请求较频繁，请稍后手动更新。', SERVICE_ERROR: 'Town 服务暂时不可用，请稍后手动更新。',
    INVALID_RESPONSE: '消息格式未通过检查，已保留上次同步内容。',
    TOWN_TOOL_NOT_CALLED: 'Being 没有调用消息读取工具。请在模型设置检查工具限制，再立即同步。',
    RESULT_SOURCE_NOT_CONFIGURED: 'Being 的读取结果只有摘要，尚未配置完整结果通道；刷新显示不会补全消息。',
    BUSY: 'Being 正在处理其他消息，请空闲后再点击更新。',
    READINESS_UNKNOWN: '未能确认 Being 是否空闲，本次读取未发送。请重试。',
    RESULT_UNCONFIRMED: '读取已发送，但尚未取得可核对结果。自动检查已停止，请在功能任务中查看。',
    REQUEST_ACCEPTED: '请求已送达 Being，结果待确认。请等待当前对话完成，不要重复提交。',
    SBS_NOT_CONFIGURED: '后台采集尚未设置，可立即同步。',
    INCOMPLETE_RESULT: 'Being 的工具结果不完整，已保留上次同步内容。',
    RESULT_SOURCE_UNAVAILABLE: '本机工具结果通道暂不可用，请稍后手动更新。',
  };
  const backgroundNotConfigured = (state) => state.refresh?.errorCode === 'SBS_NOT_CONFIGURED' || state.refresh?.reason === 'sbs_not_configured';

  function refreshLabel(state) {
    const status = record(state.refresh);
    const timestamp = (value, label) => {
      const date = value ? new Date(value) : null;
      return date && !Number.isNaN(date.getTime()) ? `${label} ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '';
    };
    const checked = timestamp(status.lastCheckedAt, '最近检查');
    const collected = timestamp(status.lastSuccessAt, '最近采集');
    const paused = status.status === 'paused';
    const permission = /auth|trust|permission/i.test(`${status.reason || ''} ${status.errorCode || ''}`);
    const prefix = !connected() ? '等待连接' : paused && permission ? 'Town 需要配对' : backgroundNotConfigured(state) ? '后台采集尚未设置，可立即同步' : status.errorCode === 'REQUEST_ACCEPTED' ? '请求已送达 · 等待 Being 完成' : status.reason === 'being_busy' ? 'Being 正忙 · 稍后可读取一次' : status.status === 'refreshing' ? '正在同步 Town 消息' : status.status === 'error' ? '结果检查失败 · 可刷新显示' : status.reason === 'waiting_sbs' || !collected ? '等待 Town 同步' : '已显示读取结果';
    return [prefix, checked, collected, status.stale ? '显示上次同步内容' : ''].filter(Boolean).join(' · ');
  }

  function acceptTownMessages(value) {
    const envelope = record(value);
    // dm arrives as a bare hint: the inbox is not part of background collection.
    if (envelope.kind === 'dm') { if (visibleModule('inbox')) void loadInbox(); return true; }
    if (!['bonfire', 'fireside'].includes(envelope.kind)) return false;
    if (envelope.kind === 'fireside' && envelope.firesideId !== model.fireside.selected) return false;
    const snapshot = record(envelope.snapshot);
    const identity = record(snapshot.identity);
    const expected = record(town.identity);
    if (!connected() || !identity.beingId || identity.beingId !== expected.beingId || identity.connectionRevision !== expected.connectionRevision || identity.identityRevision !== expected.identityRevision) return false;
    const state = model[envelope.kind];
    state.messages = array(snapshot.messages);
    state.source = snapshot.source === 'being_relay' ? 'being_relay' : '';
    state.latestSeq = snapshot.latestSeq ?? null;
    // The accumulated timeline says whether history continues above what is shown, and where the
    // last refresh that brought something new started.
    state.hasOlder = snapshot.hasOlder === true;
    const refresh = record(snapshot.lastRefresh);
    state.lastRefresh = Number.isSafeInteger(refresh.boundarySeq) ? {at: Number(refresh.at) || 0, boundarySeq: refresh.boundarySeq} : null;
    state.refresh = record(envelope.status);
    if (envelope.kind === 'bonfire') state.status = state.refresh.status === 'refreshing' ? 'loading' : state.refresh.status;
    state[envelope.kind === 'fireside' ? 'messageError' : 'error'] = ['paused', 'error'].includes(state.refresh.status) ? refreshErrors[state.refresh.errorCode] || (state.refresh.status === 'paused' ? '后台读取已暂停，恢复连接后继续。' : '后台读取暂时失败，请稍后重试。') : '';
    if (visibleModule(envelope.kind)) {
      if (envelope.kind === 'bonfire') renderBonfire();
      else renderMessages();
    }
    return true;
  }

  // Older history above the shown messages: one bounded walk per request, triggered from the
  // top of the list. The reply is the same envelope a refresh returns.
  async function loadOlderMessages(kind) {
    const state = model[kind];
    if (!connected() || state.loadingOlder || !state.hasOlder) return;
    const firesideId = kind === 'fireside' ? model.fireside.selected : '';
    if (kind === 'fireside' && !firesideId) return;
    const requestEpoch = epoch, selection = roomSelection;
    const isCurrent = () => sameEpoch(requestEpoch) && (kind !== 'fireside' || selection === roomSelection && model.fireside.selected === firesideId);
    state.loadingOlder = true; state.olderError = '';
    renderTimeline(kind);
    try {
      const result = await call('loadOlderTownMessages', kind === 'fireside' ? { kind, firesideId } : { kind });
      if (isCurrent()) acceptTownMessages(result);
    } catch (error) {
      if (isCurrent()) state.olderError = errorText(error);
    } finally {
      if (isCurrent()) { state.loadingOlder = false; renderTimeline(kind); }
    }
  }
  function renderTimeline(kind) {
    if (!visibleModule(kind)) return;
    if (kind === 'bonfire') renderBonfire(); else renderMessages();
  }
  // The control above the first message: more history, loading it, or the beginning of the feed.
  function olderControl(kind) {
    const state = model[kind];
    if (state.loadingOlder) return node('p', 'ta-timeline-edge ta-muted', '正在读取更早的消息…');
    if (state.olderError) return append(node('p', 'ta-timeline-edge'), node('span', 'ta-muted', state.olderError), button('重试', () => { state.olderError = ''; void loadOlderMessages(kind); }, 'ta-quiet'));
    if (state.hasOlder) return button('加载更早的消息', () => { void loadOlderMessages(kind); }, 'ta-quiet ta-load-older');
    return state.messages.length ? node('p', 'ta-timeline-edge ta-muted', '已经是最早的消息') : null;
  }
  // "The last refresh started here": the divider before the first message the last refresh brought.
  function refreshMarker(state, entries) {
    const boundary = state.lastRefresh?.boundarySeq;
    if (!Number.isSafeInteger(boundary)) return { before: null, node: null };
    const first = entries.find((entry) => Number(entry.id) > boundary);
    if (!first) return { before: null, node: null };
    const at = state.lastRefresh.at ? new Date(state.lastRefresh.at) : null;
    const stamp = at && !Number.isNaN(at.getTime()) ? at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
    const marker = node('div', 'ta-refresh-mark'); marker.setAttribute('role', 'separator');
    marker.append(node('span', '', `上次刷新到这里${stamp ? ` · ${stamp}` : ''}`));
    return { before: first.id, node: marker };
  }
  // The sticky jump control at the foot of a list: to the refresh marker when there is one, else
  // to the newest message. Shown only while the target is out of view.
  function jumpControl(container) {
    const control = button('', () => {
      const marker = container.querySelector('.ta-refresh-mark');
      if (marker) container.scrollTop = Math.max(0, marker.offsetTop - 12);
      else container.scrollTop = container.scrollHeight;
      updateJump(container);
    }, 'ta-jump');
    control.hidden = true;
    return control;
  }
  function updateJump(container) {
    const control = container.querySelector('.ta-jump');
    if (!control) return;
    const marker = container.querySelector('.ta-refresh-mark');
    const top = container.scrollTop, bottom = top + container.clientHeight;
    let away;
    if (marker) {
      // The list is the marker's offsetParent, so offsetTop is its place in the scrolled content.
      const at = marker.offsetTop;
      away = at < top || at > bottom - 40;
      text(control, '直达上次刷新处');
    } else {
      away = container.scrollHeight - bottom > 120;
      text(control, '回到最新');
    }
    control.hidden = !away;
  }
  function watchTimeline(container, kind) {
    container.addEventListener('scroll', () => {
      updateJump(container);
      if (container.scrollTop < 80 && model[kind].hasOlder && !model[kind].loadingOlder) void loadOlderMessages(kind);
    }, { passive: true });
  }
  // Keep what the reader is looking at when older messages are inserted above it.
  function keepPosition(container, before, nearBottom, changed) {
    if (changed || nearBottom) { container.scrollTop = container.scrollHeight; return; }
    const firstId = Number(container.dataset.firstId || 0), previousFirst = Number(before.firstId || 0);
    const prepended = firstId && previousFirst && firstId < previousFirst;
    container.scrollTop = prepended ? before.scrollTop + (container.scrollHeight - before.scrollHeight) : before.scrollTop;
  }

  async function readTownMessages(kind, firesideId = '', manual = false) {
    const requestEpoch = epoch;
    const selection = roomSelection;
    const isCurrent = () => sameEpoch(requestEpoch) && (kind !== 'fireside' || selection === roomSelection && model.fireside.selected === firesideId);
    const request = kind === 'fireside' ? { kind, firesideId } : { kind };
    try {
      const result = await call(manual ? 'refreshTownMessages' : 'getTownMessageSnapshot', request);
      if (isCurrent()) acceptTownMessages(result);
    } catch (error) {
      if (!isCurrent()) return;
      const state = model[kind];
      const waiting = ['SBS_NOT_CONFIGURED', 'WAITING_SBS'].includes(error?.code);
      state[kind === 'fireside' ? 'messageError' : 'error'] = waiting ? '' : errorText(error);
      if (kind === 'bonfire') state.status = waiting ? 'waiting' : 'error';
      state.refresh = { ...state.refresh, status: waiting ? 'waiting' : 'error', stale: state.messages.length > 0 };
      if (waiting) Object.assign(state.refresh, {errorCode: error.code, reason: error.code === 'SBS_NOT_CONFIGURED' ? 'sbs_not_configured' : 'waiting_sbs'});
      if (visibleModule(kind)) { if (kind === 'bonfire') renderBonfire(); else renderMessages(); }
    }
  }

  async function call(method, value) {
    if (typeof bridge?.[method] !== 'function') throw new Error('此功能尚未接通，请先更新桌面应用。');
    return value === undefined ? bridge[method]() : bridge[method](value);
  }

  async function cachedData(method, value, withMetadata = false) {
    if (typeof bridge?.getTownCachedData !== 'function') return null;
    try {
      const result = await call('getTownCachedData', value === undefined ? { method } : { method, value });
      return result?.cached === true ? withMetadata ? result : result.data : null;
    } catch { return null; }
  }

  async function assist(operation, target = ui.notice) {
    if (busy.has('assistance')) return;
    const route = navigation;
    const requestEpoch = epoch;
    busy.add('assistance');
    try {
      await call('prepareTownAssistance', { operation });
      if (activeRoute(route) && sameEpoch(requestEpoch)) options.onNavigateChat?.();
    } catch (error) { if (activeRoute(route) && sameEpoch(requestEpoch)) setNotice(target, errorText(error), true); }
    finally { busy.delete('assistance'); }
  }

  function helpButton(operation, label = '请 Being 协助', target) {
    return button(label, () => void assist(operation, target), 'ta-quiet');
  }

  function authNote(id, operation) {
    const connected = publicState.connection?.status === 'connected';
    return append(node('div', 'ta-auth-note'), icon('shield'), append(node('div'),
      node('strong', '', '桌面授权尚未接通'),
      node('p', '', connected ? 'Loom 已连接。这个服务仍需要独立的 Town 授权，可请 Being 协助。' : '先连接 Being，再由 Being 协助使用这个服务。')),
    connected ? helpButton(operation) : button('连接 Being', () => options.onNavigateChat?.(), 'ta-quiet'));
  }

  function buildTownPairing() {
    ui.pairPanel = node('div', 'ta-town-pair');
    ui.pairPanel.setAttribute('aria-label', 'Town 连接');
    ui.pairStatus = node('p', 'field-help');
    ui.pairStatus.setAttribute('role', 'status');
    ui.pairNotice = notice();
    ui.pairCode = node('input'); ui.pairCode.type = 'password'; ui.pairCode.maxLength = 6;
    ui.pairCode.placeholder = '六位配对码'; ui.pairCode.autocomplete = 'off'; ui.pairCode.setAttribute('aria-label', 'Town 六位配对码');
    ui.pairSubmit = button('配对 Town', async () => {
      if (busy.has('town-pair')) return;
      const code = ui.pairCode.value.trim().toUpperCase(); ui.pairCode.value = '';
      const requestEpoch = epoch;
      setNotice(ui.pairNotice, '');
      busy.add('town-pair'); renderTownPairing();
      try {
        const result = await call('pairTownClient', {code});
        if (!sameEpoch(requestEpoch)) return;
        town.client = result;
        await loadTownState();
      } catch (error) { if (sameEpoch(requestEpoch)) setNotice(ui.pairNotice, errorText(error), true); }
      finally { busy.delete('town-pair'); renderTownPairing(); }
    }, 'ta-primary', 'town-pair-submit');
    ui.pairHelp = button('向 Being 获取配对码', async () => {
      try { await call('prepareTownPairing'); options.onNavigateChat?.(); }
      catch (error) { setNotice(ui.pairNotice, errorText(error), true); }
    }, 'ta-quiet', 'town-pair-help');
    ui.pairForget = button('清除本机配对', async () => {
      setNotice(ui.pairNotice, '');
      try { await call('forgetTownClient'); await loadTownState(); renderTownPairing(); }
      catch (error) { setNotice(ui.pairNotice, errorText(error), true); }
    }, 'ta-quiet', 'town-pair-forget');
    ui.pairSubmit.className = 'button primary small-button';
    ui.pairHelp.className = ui.pairForget.className = 'button quiet small-button';
    append(ui.pairPanel, ui.pairStatus, append(node('div', 'inline-actions'), ui.pairCode, ui.pairSubmit, ui.pairHelp, ui.pairForget), ui.pairNotice);
    document.getElementById('town-connection-controls')?.replaceChildren(ui.pairPanel);
  }

  function renderTownPairing() {
    if (!ui.pairPanel) return;
    const client = record(town.client), paired = client.paired === true;
    const needsPair = !paired || ['auth_required', 'identity_mismatch'].includes(client.status);
    const labels = {paused: 'Town 同步已暂停', connected: 'Town 实时连接已建立', connecting: 'Town 正在连接', reconnecting: 'Town 连接中断，正在重连', auth_required: 'Town 需要配对', identity_mismatch: 'Town 身份不一致，请重新配对'};
    text(ui.pairStatus, labels[client.status] || '连接 Town 后直接同步消息');
    for (const control of [ui.pairCode, ui.pairSubmit, ui.pairHelp]) control.hidden = !needsPair;
    ui.pairForget.hidden = !paired;
    ui.pairSubmit.disabled = !connected() || busy.has('town-pair');
    ui.pairHelp.disabled = !connected();
  }

  function build() {
    root.classList.add('town-app');
    root.setAttribute('aria-label', 'Town 应用');
    ui.heading = node('h2');
    ui.subtitle = node('p', 'ta-subtitle');
    ui.refresh = button('刷新', () => void refresh(), 'ta-quiet', 'town-app-refresh');
    ui.readOnce = button('立即同步', () => void requestReadOnce(), 'ta-secondary', 'town-app-read-once');
    ui.readOnce.title = '直接从 Town 获取最新消息。';
    ui.readOnce.hidden = true;
    const tasks = button('功能任务', () => options.onTasks?.(current), 'ta-quiet', 'town-feature-tasks');
    tasks.hidden = typeof options.onTasks !== 'function';
    const top = append(node('header', 'ta-page-header'), append(node('div'), ui.heading, ui.subtitle), append(node('div', 'ta-actions'), tasks, ui.refresh, ui.readOnce));
    ui.notice = notice();
    ui.content = node('div', 'ta-app-content');
    buildTownPairing();
    root.replaceChildren(top, ui.notice, ui.content);
    buildGrove();
    buildChannel();
    buildPortal();
    buildFireside();
    buildBonfire();
    buildInbox();
    window.beingTownLibrary?.init({ root: ui.content, bridge, onNavigateChat: options.onNavigateChat });
  }

  function buildGrove() {
    const page = ui.grovePage = node('section', 'ta-module ta-grove');
    page.setAttribute('aria-label', 'Grove 工具市场');
    const browse = ui.groveBrowse = node('div', 'ta-grove-browse');
    const heading = append(node('header', 'ta-grove-heading'), node('h2', '', '工具市场'), node('p', '', subtitles.grove));
    const toolbar = node('div', 'ta-grove-searchbar');
    const searchField = node('div', 'ta-grove-search-field');
    ui.groveSearch = node('input', 'ta-grove-search');
    ui.groveSearch.type = 'search';
    ui.groveSearch.id = 'grove-search';
    ui.groveSearch.placeholder = '搜索工具包、作者或用途';
    ui.groveSearch.setAttribute('aria-label', '搜索 Grove 工具包');
    ui.groveSearch.autocomplete = 'off';
    ui.groveSearch.addEventListener('input', () => { model.grove.query = ui.groveSearch.value; renderGroveList(); });
    ui.groveClear = button('清除搜索', () => { model.grove.query = ''; ui.groveSearch.value = ''; renderGroveList(); ui.groveSearch.focus(); }, 'ta-grove-search-clear');
    ui.groveClear.replaceChildren(node('span', '', '×'));
    ui.groveClear.setAttribute('aria-label', '清除搜索');
    ui.groveRefresh = button('刷新目录', () => void loadGrove(), 'ta-grove-refresh', 'grove-refresh');
    ui.groveRefresh.replaceChildren(icon('refresh'));
    ui.groveRefresh.setAttribute('aria-label', '刷新工具市场');
    ui.groveRefresh.title = '刷新工具市场';
    append(toolbar, append(searchField, icon('search'), ui.groveSearch, ui.groveClear), ui.groveRefresh);
    ui.groveCategories = node('div', 'ta-grove-categories');
    ui.groveCategories.id = 'grove-categories';
    ui.groveCategories.setAttribute('role', 'group');
    ui.groveCategories.setAttribute('aria-label', '按用途筛选工具包');
    ui.groveCount = node('p', 'ta-grove-count');
    ui.groveCount.setAttribute('role', 'status');
    ui.groveCount.setAttribute('aria-live', 'polite');
    ui.groveBatch = button('安装可一键安装的 Kit', () => void installEligibleKits(), 'ta-secondary', 'grove-install-eligible');
    ui.groveBatchResult = node('section', 'ta-grove-batch-result');
    ui.groveBatchResult.id = 'grove-batch-result';
    ui.groveBatchResult.setAttribute('role', 'status');
    ui.groveBatchResult.setAttribute('aria-live', 'polite');
    ui.groveList = node('div', 'ta-kit-list');
    ui.groveList.setAttribute('aria-label', '工具包列表');
    ui.groveList.setAttribute('role', 'list');
    ui.groveDetail = node('section', 'ta-kit-detail');
    ui.groveDetail.setAttribute('aria-label', '工具包详情');
    append(browse, heading, append(node('div', 'ta-grove-sticky-tools'), toolbar, ui.groveCategories), append(node('div', 'ta-grove-list-actions'), ui.groveCount, ui.groveBatch), ui.groveBatchResult, ui.groveList);
    append(page, browse, ui.groveDetail);
    page.addEventListener('keydown', (event) => {
      if (!model.grove.selected && !event.isComposing && !event.ctrlKey && !event.metaKey && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        const cards = Array.from(ui.groveList.querySelectorAll('[data-kit-id]'));
        const index = cards.indexOf(document.activeElement);
        if (cards.length && (index >= 0 || document.activeElement === ui.groveSearch)) {
          event.preventDefault();
          const target = index < 0 ? (event.key === 'ArrowDown' ? 0 : cards.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + cards.length) % cards.length;
          cards[target].focus();
        }
      }
      if (event.key === 'Escape' && model.grove.selected && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault(); returnToGrove();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (current === 'grove' && !root.hidden && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !event.isComposing) {
        event.preventDefault();
        if (model.grove.selected) returnToGrove();
        ui.groveSearch.focus(); ui.groveSearch.select();
      }
    });
    ui.content.append(page);
  }

  function kitMetadata(kit) {
    return record(window.groveKitCatalog?.[String(kit.id || kit.name || '')]);
  }

  function kitDescription(kit) {
    return string(kitMetadata(kit).description, string(kit.description, string(kit.manifest?.description, '发布者尚未提供用途说明。')));
  }

  function kitPublisher(kit) {
    const name = string(kit.display_name, string(kit.being_id, '发布者未知'));
    const handle = string(kit.being_id);
    return handle && name.toLocaleLowerCase() !== handle.toLocaleLowerCase() ? `${name} · @${handle}` : name;
  }

  function kitIcon(kit, large = false) {
    const frame = node('span', `ta-kit-symbol${large ? ' ta-kit-symbol-large' : ''}`);
    frame.setAttribute('aria-hidden', 'true');
    const id = String(kit.id || '');
    const fallback = node('span', 'ta-kit-initial', string(kit.name, '?').slice(0, 1).toUpperCase());
    frame.append(fallback);
    const metadata = kitMetadata(kit);
    const source = string(metadata.icon);
    // Only passive bundled assets can be selected; remote URLs never reach img.src.
    if (/^[a-zA-Z0-9_-]{1,100}$/.test(id) && /^assets\/(?:brands|kit-symbols)\/[a-zA-Z0-9_-]+\.(?:svg|png)$/.test(source)) {
      frame.classList.add(metadata.iconStyle === 'brand' ? 'ta-kit-symbol-brand' : 'ta-kit-symbol-custom');
      if (['codex', 'jira', 'claude', 'cursor', 'opencode', 'linear', 'feishu'].includes(metadata.brand)) frame.dataset.brand = metadata.brand;
      const image = node('img'); image.alt = ''; image.width = large ? 60 : 40; image.height = image.width;
      image.decoding = 'async'; image.loading = large ? 'eager' : 'lazy'; image.draggable = false;
      image.addEventListener('load', () => { fallback.hidden = true; });
      image.addEventListener('error', () => { image.remove(); fallback.hidden = false; }, { once: true });
      image.src = `./${source}`;
      frame.append(image);
    }
    return frame;
  }

  function renderGroveCategories() {
    const categories = ['开发', '协作', '知识', '工具', '其他'].filter((category) => model.grove.kits.some((kit) => string(kitMetadata(kit).category, '其他') === category));
    const key = JSON.stringify(categories);
    if (ui.groveCategories.dataset.items !== key) {
      ui.groveCategories.dataset.items = key;
      ui.groveCategories.replaceChildren();
      for (const category of ['', ...categories]) {
        const item = button(category || '全部', () => { model.grove.category = category; renderGroveList(); }, 'ta-grove-category');
        item.dataset.category = category;
        ui.groveCategories.append(item);
      }
    }
    if (model.grove.category && !categories.includes(model.grove.category)) model.grove.category = '';
    for (const item of ui.groveCategories.children) item.setAttribute('aria-pressed', String(item.dataset.category === model.grove.category));
  }

  function renderGroveList() {
    const grove = model.grove;
    renderGroveBatch();
    renderGroveCategories();
    const query = grove.query.trim().toLocaleLowerCase();
    const kits = grove.kits.filter((kit) => (!grove.category || string(kitMetadata(kit).category, '其他') === grove.category)
      && [kit.name, kit.description, kitDescription(kit), kit.display_name, kit.being_id].some((value) => string(value).toLocaleLowerCase().includes(query)));
    visible(ui.groveClear, Boolean(grove.query));
    ui.groveRefresh.disabled = busy.has('grove-list');
    text(ui.groveCount, grove.status === 'loading' ? '正在读取公开目录…' : `${kits.length} 个工具包${grove.count > grove.kits.length ? ` · 已载入 ${grove.kits.length} / ${grove.count} 个，搜索范围为已载入目录` : ''}`);
    const fingerprint = JSON.stringify([grove.kits, grove.count, query, grove.category, grove.status, grove.error]);
    if (ui.groveList.dataset.rendered === fingerprint) return;
    ui.groveList.dataset.rendered = fingerprint;
    ui.groveList.replaceChildren();
    ui.groveList.setAttribute('aria-busy', String(grove.status === 'loading'));
    if (grove.status === 'loading' && !grove.kits.length) ui.groveList.append(message('正在读取工具市场', '正在获取 Grove 的公开目录。'));
    else if (grove.error) ui.groveList.append(message('目录暂时无法读取', grove.error, button('重新读取', () => void loadGrove(), 'ta-secondary')));
    else if (!kits.length) ui.groveList.append(message(query || grove.category ? '没有匹配的工具包' : '暂时没有工具包', query || grove.category ? '换个名称或用途试试。' : '可以稍后刷新公开目录。'));
    for (const kit of kits) {
      const id = String(kit.id || kit.name || '');
      const row = button('', () => void selectKit(id), 'ta-kit-row ta-kit-card');
      row.dataset.kitId = id;
      const name = string(kit.name, '未命名工具包');
      const duplicateName = grove.kits.some((other) => other.id !== kit.id && other.name === kit.name);
      const displayName = duplicateName && kit.being_id ? `${name} · @${kit.being_id}` : name;
      const title = node('strong', 'ta-kit-title', displayName);
      title.title = displayName;
      const description = node('span', 'ta-kit-description', kitDescription(kit)); description.title = kitDescription(kit);
      const meta = kitPublisher(kit);
      append(row, kitIcon(kit), append(node('span', 'ta-kit-copy'), title, description, node('span', 'ta-kit-meta', meta)));
      ui.groveList.append(append(node('div', 'ta-kit-item'), row));
      row.parentElement.setAttribute('role', 'listitem');
    }
    if (grove.kits.length < grove.count && grove.status !== 'loading') {
      ui.groveList.append(button('加载更多工具包', () => void loadGrove(true), 'ta-secondary ta-load-more'));
    }
  }

  function detailField(label, value, mono = false) {
    return append(node('div', 'ta-detail-field'), node('dt', '', label), node('dd', mono ? 'ta-mono' : '', value));
  }

  function safeSource(value) {
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
      return `${url.origin}${url.pathname}`;
    } catch { return ''; }
  }

  function groveInstallMode(detail, checked) {
    const assessment = record(checked?.assessment);
    if (checked?.status === 'needs_being' || assessment.mode === 'being') return 'being';
    if (assessment.mode === 'one_click') return 'one_click';
    return detail?.assessment?.installMode === 'one_click' || detail?.assessment?.mode === 'one_click' ? 'one_click' : 'being';
  }

  function groveOutcome(result) {
    if (result.status === 'installed') return '已安装';
    if (result.status === 'needs_being' || result.assessment?.mode === 'being') return '需要 Being 协助';
    if (result.status === 'failed') return '安装失败';
    if (result.status === 'ready') return result.action === 'prepare' ? '环境检查通过，可以一键安装' : '环境检查通过';
    return '部分安装条件仍待确认';
  }

  function groveResultReasons(result) {
    const reasons = array(result.assessment?.reasons).map((reason) => typeof reason === 'string' ? reason : string(reason?.detail)).filter(Boolean);
    return [...new Set([string(result.detail), ...reasons].filter(Boolean))];
  }

  function renderGroveBatch() {
    const grove = model.grove;
    ui.groveBatch.disabled = grove.batchRunning || grove.operations.size > 0;
    text(ui.groveBatch, grove.batchRunning ? '正在检查并批量安装…' : '安装可一键安装的 Kit');
    ui.groveBatch.setAttribute('aria-busy', String(grove.batchRunning));
    visible(ui.groveBatchResult, grove.batchRunning || Boolean(grove.batch));
    const fingerprint = JSON.stringify([grove.batchRunning, grove.batch]);
    if (ui.groveBatchResult.dataset.rendered === fingerprint) return;
    ui.groveBatchResult.dataset.rendered = fingerprint;
    ui.groveBatchResult.replaceChildren();
    if (grove.batchRunning) { ui.groveBatchResult.append(node('p', '', '正在逐项检查本机环境并安装符合条件的 Kit。可以继续浏览，进度不会重复启动。')); return; }
    if (!grove.batch) return;
    const results = array(grove.batch.results);
    const installed = results.filter((result) => result.status === 'installed').length;
    const assistance = results.filter((result) => result.status === 'needs_being' || result.status !== 'installed' && result.status !== 'failed' && result.assessment?.mode === 'being').length;
    const failed = results.filter((result) => result.status === 'failed').length;
    ui.groveBatchResult.append(node('p', 'ta-grove-check-outcome', `批量结果：已安装 ${installed} · 需要 Being ${assistance} · 失败 ${failed}`));
    if (grove.batch.detail) ui.groveBatchResult.append(node('p', 'ta-muted', grove.batch.detail));
    const list = node('ul', 'ta-grove-batch-items');
    for (const result of results) {
      const name = string(result.kit?.name, string(grove.kits.find((kit) => String(kit.id) === String(result.id))?.name, String(result.id || 'Kit')));
      const item = append(node('li'), button(`${name} · ${groveOutcome(result)}`, () => void selectKit(String(result.id)), 'ta-quiet'));
      const reasons = groveResultReasons(result);
      if (reasons.length) item.append(node('p', 'ta-muted', reasons.join('；')));
      if (result.status === 'installed') item.append(node('p', 'ta-muted', result.loaded === true ? 'Portal 已加载；工具业务调用未验证。' : '已写入本机；待 Portal 加载，工具业务调用未验证。'));
      list.append(item);
    }
    if (results.length) ui.groveBatchResult.append(list);
  }

  function renderGroveDetail() {
    const grove = model.grove;
    visible(ui.groveBrowse, !grove.selected);
    visible(ui.groveDetail, Boolean(grove.selected));
    ui.grovePage.classList.toggle('has-detail', Boolean(grove.selected));
    if (!grove.selected) return;
    const checked = grove.checks.get(grove.selected);
    const operation = grove.operations.get(grove.selected);
    const operationError = grove.operationErrors.get(grove.selected);
    const fingerprint = JSON.stringify([grove.selected, grove.detail, grove.detailStatus, grove.detailError, checked, operation, operationError, grove.batchRunning, publicState.connection?.status]);
    if (ui.groveDetail.dataset.rendered === fingerprint) return;
    ui.groveDetail.dataset.rendered = fingerprint;
    const focusedId = ui.groveDetail.contains(document.activeElement) ? document.activeElement.id : '';
    ui.groveDetail.replaceChildren();
    const back = button('工具市场', returnToGrove, 'ta-quiet ta-detail-back', 'grove-back');
    back.prepend(node('span', 'ta-grove-back-arrow', '‹'));
    back.setAttribute('aria-label', '返回工具包列表');
    const breadcrumb = append(node('nav', 'ta-grove-breadcrumb'), back, node('span', 'ta-grove-breadcrumb-divider', '/'), node('span', 'ta-grove-breadcrumb-name', string(grove.detail?.name, '工具包详情')));
    breadcrumb.setAttribute('aria-label', '工具包导航');
    ui.groveDetail.append(breadcrumb);
    if (grove.detailStatus === 'loading' && !grove.detail) { ui.groveDetail.append(message('正在读取详情', '核对工具包元数据与安装说明。')); return; }
    if (!grove.detail) { ui.groveDetail.append(message('详情暂时无法读取', grove.detailError || '请重新选择工具包。', button('重试', () => void selectKit(grove.selected), 'ta-secondary'))); return; }
    const detail = { ...grove.kits.find((kit) => String(kit.id || kit.name) === grove.selected), ...grove.detail, id: grove.selected };
    const manifest = record(detail.manifest);
    const provision = record(manifest.provision);
    const setup = record(detail.setup_guide);
    const metadata = kitMetadata(detail);
    const content = node('div', 'ta-grove-detail-content');
    const heading = node('header', 'ta-grove-detail-heading');
    const title = node('h3', 'ta-detail-title', string(detail.name, '工具包')); title.id = 'grove-detail-title'; title.tabIndex = -1;
    const version = string(detail.version, string(manifest.version));
    const byline = append(node('p', 'ta-grove-byline'), node('span', '', kitPublisher(detail)), version ? node('span', 'ta-grove-version', `v${version}`) : null);
    const oneClick = groveInstallMode(detail, checked) === 'one_click';
    const installed = checked?.status === 'installed' || checked?.assessment?.localInstalled === true && checked?.assessment?.localMcpRegistered === true;
    const busyAction = Boolean(operation) || grove.batchRunning;
    const mainLabel = operation === 'install' ? '正在检查并安装…' : operation === 'assistance' ? '正在准备消息…' : installed ? checked?.loaded === true ? '已安装' : '加载到 Portal' : oneClick ? '一键安装' : '请 Being 协助安装';
    const install = button(mainLabel, () => void (oneClick || installed ? installKit() : assistKit()), 'ta-primary', 'grove-install');
    install.disabled = busyAction || installed && checked?.loaded === true;
    install.setAttribute('aria-busy', String(operation === 'install' || operation === 'assistance'));
    const inspect = button(operation === 'prepare' ? '正在检查…' : checked ? '重新检查环境' : '检查安装环境', () => void prepareKit(), 'ta-quiet', 'grove-prepare');
    inspect.disabled = busyAction;
    inspect.setAttribute('aria-busy', String(operation === 'prepare'));
    const mainActions = append(node('div', 'ta-grove-primary-action'), append(node('div', 'ta-grove-action-buttons'), install, inspect), node('span', 'ta-muted', installed ? '安装与加载状态见下方' : oneClick ? '自动检查环境，满足条件后安装' : '生成安装草稿，确认后由你发送'));
    append(heading, kitIcon(detail, true), append(node('div', 'ta-grove-detail-title-row'), append(node('div', 'ta-grove-detail-summary'), title, node('p', 'ta-detail-description', kitDescription(detail)), byline), mainActions));
    content.append(heading);
    if (checked) {
      const assessment = record(checked.assessment);
      const checks = append(node('section', 'ta-grove-checks'), node('h4', '', checked.action === 'install' ? '安装结果' : '安装环境检查'), node('p', 'ta-grove-check-outcome', groveOutcome(checked)));
      checks.id = 'grove-checks'; checks.setAttribute('role', 'status');
      const reasons = groveResultReasons(checked);
      if (reasons.length) {
        const list = node('ul', 'ta-requirements');
        for (const reason of reasons) list.append(node('li', '', reason));
        checks.append(list);
      }
      if (array(assessment.checks).length) {
        const list = node('ul', 'ta-grove-environment-checks');
        const statuses = { passed: '通过', ready: '通过', ok: '通过', installed: '已安装', missing: '缺失', failed: '未通过', blocked: '未通过', unknown: '待确认', warning: '待处理', needs_being: '需要 Being', skipped: '未执行' };
        for (const item of assessment.checks) list.append(append(node('li'), node('strong', '', `${string(item.label, '环境检查')} · ${statuses[item.status] || '待确认'}`), item.detail ? node('p', 'ta-muted', item.detail) : null));
        checks.append(list);
      }
      checks.append(node('p', 'ta-muted', checked.action === 'prepare' ? '本次仅检查环境，没有执行安装。' : checked.status === 'installed' ? '本机安装完成，Portal 加载与工具业务调用状态分别列在下方。' : '请根据结果处理未满足的安装条件。'));
      if (!installed) {
        const help = button('请 Being 协助安装', () => void assistKit(), 'ta-quiet', 'grove-assist');
        help.disabled = busyAction; checks.append(help);
      }
      content.append(checks);
    }
    if (grove.detailError) {
      const failure = node('p', 'ta-grove-check-error ta-error', grove.detailError); failure.setAttribute('role', 'alert'); content.append(failure);
    }
    if (operationError) { const failure = node('p', 'ta-grove-check-error ta-error', operationError); failure.setAttribute('role', 'alert'); content.append(failure); }
    const tools = array(manifest.tools);
    const capabilities = array(metadata.capabilities).filter((value) => typeof value === 'string' && value).slice(0, 3);
    const capabilitySection = append(node('section', 'ta-detail-section ta-grove-capabilities'), node('h4', '', '可以做什么'));
    const capabilityList = node('ul', 'ta-grove-capability-list');
    if (capabilities.length) for (const capability of capabilities) capabilityList.append(node('li', '', capability));
    else for (const tool of tools.slice(0, 3)) capabilityList.append(node('li', '', string(tool.description, string(tool.name, '发布者尚未描述这项能力。'))));
    if (!capabilityList.children.length) capabilityList.append(node('li', '', kitDescription(detail)));
    append(capabilitySection, capabilityList); content.append(capabilitySection);

    const technical = groveDisclosure('technical', '工具与安装要求', tools.length ? `${tools.length} 项声明工具` : '查看技术详情');
    const toolSection = append(node('section', 'ta-grove-technical-section'), node('h4', '', '工具清单'), node('p', 'ta-muted', '来自发布者的 manifest，尚未验证实际加载与调用。'));
    for (const tool of tools) append(toolSection, append(node('div', 'ta-tool'), node('code', '', string(tool.name, '未命名工具')), node('p', '', string(tool.description, '尚无描述'))));
    if (!tools.length) toolSection.append(node('p', 'ta-muted', '发布者尚未提供工具清单。'));
    technical.append(toolSection);
    const info = node('dl', 'ta-details');
    const source = safeSource(detail.source_url) || safeSource(detail.download_url);
    if (source) info.append(detailField('公开来源', source, true));
    const platforms = array(manifest.platform).length ? manifest.platform : array(manifest.platforms?.supported).length ? manifest.platforms.supported : array(provision.platforms);
    info.append(detailField('平台声明', platforms.length ? platforms.join(' / ') : '未声明 · 安装前需检查'));
    const runtime = typeof manifest.runtime === 'string' ? manifest.runtime : string(provision.runtime?.name);
    if (runtime) info.append(detailField('运行环境', runtime, true));
    technical.append(info);
    const deps = array(provision.deps).length ? provision.deps : array(setup.deps);
    const requirements = append(node('section', 'ta-grove-technical-section'), node('h4', '', '依赖与配置'));
    if (deps.length) {
      const list = node('ul', 'ta-requirements');
      for (const dep of deps) list.append(node('li', '', typeof dep === 'string' ? dep : [string(dep.name), string(dep.description)].filter(Boolean).join(' · ') || '未命名依赖'));
      requirements.append(list);
    } else requirements.append(node('p', 'ta-muted', '发布者尚无结构化依赖清单。检查安装条件时会核对平台与启动命令。'));
    if (array(provision.env).length) requirements.append(node('p', 'ta-muted', `发布者声明了 ${provision.env.length} 项环境配置，需在安全设置通道中配置。`));
    technical.append(requirements); content.append(technical);
    const localAssessment = record(checked?.assessment);
    const localInstalled = checked?.status === 'installed' || localAssessment.localInstalled === true;
    const localRegistered = checked?.status === 'installed' || localAssessment.localMcpRegistered === true;
    const local = groveDisclosure('local', '本机状态', localInstalled ? '已安装' : checked ? '已检查' : '尚未检测');
    const localInfo = append(node('dl', 'ta-details'), detailField('本机文件', localInstalled ? '已安装' : localAssessment.localInstalled === false ? '未安装' : '未确认'), detailField('MCP 登记', localRegistered ? '已登记' : localAssessment.localMcpRegistered === false ? '未登记' : '未确认'), detailField('Portal 加载', checked?.loaded === true ? '已加载' : checked?.loaded === false || localInstalled ? '待 Portal 加载' : '未确认'), detailField('工具业务调用', '未验证'));
    append(local, localInfo, node('p', 'ta-muted', '本机文件与 MCP 登记结果独立于 Portal 加载状态。目录声明和安装完成均不代表工具业务调用已验证。'));
    content.append(local);
    ui.groveDetail.append(content);
    if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
  }

  function groveDisclosure(key, label, hint) {
    const expandedKey = `${model.grove.selected}:${key}`;
    const section = node('details', 'ta-grove-disclosure');
    section.dataset.section = key;
    section.open = model.grove.expanded.has(expandedKey);
    append(section, append(node('summary'), node('span', '', label), node('span', 'ta-muted', hint), node('span', 'ta-grove-disclosure-arrow', '›')));
    section.addEventListener('toggle', () => { if (section.open) model.grove.expanded.add(expandedKey); else model.grove.expanded.delete(expandedKey); });
    return section;
  }

  function returnToGrove() {
    const previousId = model.grove.selected;
    model.grove.selected = ''; model.grove.detail = null; detailRequest += 1;
    renderGrove();
    ui.grovePage.scrollTop = model.grove.scrollTop;
    const row = Array.from(ui.groveList.querySelectorAll('[data-kit-id]')).find((item) => item.dataset.kitId === previousId);
    (row || ui.groveSearch).focus({ preventScroll: true });
  }

  function renderGrove() { renderGroveList(); renderGroveDetail(); }

  async function loadGrove(more = false) {
    if (busy.has('grove-list')) return;
    const request = ++groveRequest;
    busy.add('grove-list');
    model.grove.status = 'loading'; model.grove.error = '';
    renderGroveList();
    try {
      if (!more && !model.grove.kits.length) {
        const cachedKits = [], knownCached = new Set();
        let offset = 0;
        let firstCapturedAt = null;
        for (let page = 0; page < 10 && offset < 100; page += 1) {
          const entry = await cachedData('getGroveCatalog', { limit: 100 - offset, offset }, true);
          if (request !== groveRequest) return;
          if (!entry) break;
          // A newer first page invalidates older continuation pages even when the total is unchanged.
          if (offset && (!Number.isSafeInteger(firstCapturedAt) || !Number.isSafeInteger(entry.lastSuccessAt) || entry.lastSuccessAt <= firstCapturedAt)) break;
          if (!offset) firstCapturedAt = entry.lastSuccessAt;
          const cached = entry.data;
          const kits = array(cached.kits);
          for (const kit of kits) {
            const id = String(kit.id || kit.name);
            if (!knownCached.has(id)) { knownCached.add(id); cachedKits.push(kit); }
          }
          model.grove.kits = [...cachedKits];
          model.grove.count = Math.max(cachedKits.length, Number.isSafeInteger(cached.count) ? cached.count : cachedKits.length);
          renderGroveList();
          offset += kits.length;
          if (!kits.length || offset >= model.grove.count) break;
        }
      }
      const collected = more ? [...model.grove.kits] : [];
      const known = new Set(collected.map((kit) => String(kit.id || kit.name)));
      let offset = collected.length;
      let count = offset;
      // Servers may cap a page below the requested limit. Fill one bounded batch.
      for (let page = 0, received = 0; page < 10 && received < 100; page += 1) {
        const result = record(await call('getGroveCatalog', { limit: 100 - received, offset }));
        if (request !== groveRequest) return;
        const kits = array(result.kits);
        count = Number.isSafeInteger(result.count) ? result.count : offset + kits.length;
        let added = 0;
        for (const kit of kits) {
          const id = String(kit.id || kit.name);
          if (!known.has(id)) { known.add(id); collected.push(kit); added += 1; }
        }
        offset += kits.length; received += kits.length;
        if (!added || offset >= count) break;
      }
      model.grove.kits = collected;
      model.grove.count = Math.max(collected.length, count);
      model.grove.status = 'ready';
    } catch (error) { if (request === groveRequest) { model.grove.error = errorText(error); model.grove.status = 'error'; } }
    finally { busy.delete('grove-list'); renderGroveList(); renderGroveDetail(); }
  }

  async function selectKit(id) {
    const request = ++detailRequest;
    const changedKit = model.grove.selected !== id;
    if (!model.grove.selected) model.grove.scrollTop = ui.grovePage.scrollTop;
    if (changedKit) model.grove.detail = null;
    model.grove.selected = id; model.grove.detailStatus = 'loading'; model.grove.detailError = '';
    renderGrove();
    if (changedKit) ui.grovePage.scrollTop = 0;
    if (changedKit && current === 'grove' && !root.hidden) document.getElementById('grove-back')?.focus({ preventScroll: true });
    try {
      if (!model.grove.detail) {
        const cached = await cachedData('getGroveDetail', id);
        if (request !== detailRequest || model.grove.selected !== id) return;
        if (cached) { model.grove.detail = record(cached); renderGroveDetail(); }
      }
      const detail = await call('getGroveDetail', id);
      if (request !== detailRequest || model.grove.selected !== id) return;
      model.grove.detail = record(detail); model.grove.detailStatus = 'ready';
    } catch (error) { if (request === detailRequest) { model.grove.detailError = errorText(error); model.grove.detailStatus = 'error'; } }
    finally { if (request === detailRequest) renderGroveDetail(); }
  }

  async function runGroveKitAction(action) {
    const id = model.grove.selected;
    const grove = model.grove;
    if (!id || !grove.detail || grove.operations.has(id) || grove.batchRunning) return;
    const route = navigation;
    const requestEpoch = epoch;
    grove.operations.set(id, action); grove.operationErrors.delete(id); renderGrove();
    try {
      const method = { prepare: 'prepareGroveInstallation', install: 'installGroveKit', assistance: 'prepareGroveAssistance' }[action];
      const result = record(await call(method, { id }));
      if (action === 'assistance') {
        if (activeRoute(route) && sameEpoch(requestEpoch) && grove.selected === id) options.onNavigateChat?.();
      } else {
        grove.checks.set(id, { ...result, id, action, status: string(result.status, 'unknown'), detail: string(result.detail, result.status ? '' : '操作已返回，但安装状态尚未确认。') });
      }
    } catch (error) { grove.operationErrors.set(id, errorText(error)); }
    finally { grove.operations.delete(id); renderGrove(); }
  }

  function prepareKit() { return runGroveKitAction('prepare'); }
  function installKit() { return runGroveKitAction('install'); }
  function assistKit() { return runGroveKitAction('assistance'); }

  async function installEligibleKits() {
    const grove = model.grove;
    if (grove.batchRunning || grove.operations.size) return;
    grove.batchRunning = true; grove.batch = null; renderGrove();
    try {
      const result = record(await call('installEligibleGroveKits', {}));
      grove.batch = { ...result, results: array(result.results).map((item) => ({ ...record(item), id: String(item.id || item.kit?.id || ''), action: 'install' })) };
      if (!Array.isArray(result.results)) grove.batch.detail = string(result.detail, '批量操作已返回，但未提供安装结果。');
      for (const item of grove.batch.results) if (item.id) { grove.checks.set(item.id, item); grove.operationErrors.delete(item.id); }
    } catch (error) { grove.batch = { results: [], detail: `批量安装未完成：${errorText(error)}` }; }
    finally { grove.batchRunning = false; renderGrove(); }
  }

  function buildChannel() {
    const page = ui.channelPage = node('section', 'ta-module ta-channel');
    page.setAttribute('aria-label', '消息渠道');
    ui.channelCards = node('div', 'ta-channel-cards');
    for (const [id, name, subtitle, logoFile] of [['feishu', '飞书', '连接飞书机器人', 'feishu.svg'], ['wechat', '微信', '检查可用连接方式', 'wechat.jpg'], ['wecom', '企业微信', '暂不支持', 'wecom.jpg']]) {
      const card = button('', () => {
        if (model.channel.selected === id) return;
        channelRequest += 1;
        busy.delete('channel-status'); busy.delete('channel-connect');
        Object.assign(model.channel, { selected: id, wizard: false, qr: '', detail: '', status: 'unknown', step: 0 }); renderChannel();
      }, 'ta-channel-card');
      card.dataset.channel = id;
      const logo = node('img', 'ta-channel-symbol');
      logo.src = `assets/brands/${logoFile}`;
      logo.alt = '';
      logo.width = 38;
      logo.height = 38;
      logo.draggable = false;
      append(card, logo, node('strong', '', name), node('span', 'ta-muted', subtitle));
      ui.channelCards.append(card);
    }
    ui.channelBody = node('div', 'ta-channel-body');
    append(page, ui.channelCards, ui.channelBody);
    ui.content.append(page);
  }

  function renderChannel() {
    const channel = model.channel;
    for (const card of ui.channelCards.children) { const selected = card.dataset.channel === channel.selected; card.classList.toggle('is-selected', selected); card.setAttribute('aria-pressed', String(selected)); }
    ui.channelBody.replaceChildren();
    if (channel.selected === 'wecom') { ui.channelBody.append(message('暂不支持企业微信', '当前连接服务未提供企业微信接入。请选择飞书，或检查微信可用的连接方式。')); return; }
    const feishu = channel.selected === 'feishu';
    const title = feishu ? '连接飞书' : '连接微信';
    const connected = publicState.connection?.status === 'connected';
    const pending = busy.has('channel-status') || busy.has('channel-connect');
    append(ui.channelBody, append(node('div', 'ta-card-heading'), node('h3', '', title), badge(channel.status)));
    if (!connected) ui.channelBody.append(node('p', 'ta-notice', '请先在连接设置中连接 Being，再完成渠道配置。'));
    if (!channel.wizard) {
      const start = button(`请 Being ${title}`, () => { channel.wizard = true; channel.step = 0; renderChannel(); void beginChannel(); }, 'ta-primary', 'channel-connect');
      start.disabled = !connected || pending;
      append(ui.channelBody, node('p', 'ta-body-copy', feishu ? '将连接请求发给当前 Being，在这里查看机器人配置说明和连接状态。' : '将连接请求发给当前 Being，由 Being 在后台检查可用的接入方式，回复会显示在这里。'), start);
      return;
    }
    const steps = node('ol', 'ta-wizard-steps');
    const labels = feishu ? ['请求 Being', '配置说明', '确认状态'] : ['请求 Being', '查看回复', '确认状态'];
    labels.forEach((label, index) => steps.append(append(node('li', index === channel.step ? 'is-current' : ''), node('span', 'ta-step-number', index + 1), node('span', '', label))));
    ui.channelBody.append(steps);
    const content = node('div', 'ta-wizard-content');
    if (feishu) {
      append(content, node('h4', '', '飞书连接说明'), node('p', '', 'Being 会在这里回复机器人配置步骤。应用凭据请按 Being 提供的安全配置方式填写。'));
    } else {
      append(content, node('h4', '', '微信接入状态'), node('p', '', channel.qr ? '使用微信扫描 Being 返回的二维码，完成微信接入后请 Being 确认连接状态。' : 'Being 会检查微信的可用接入方式，并在这里回复操作步骤或连接状态。'));
      if (channel.qr) { const image = node('img', 'ta-qr'); image.src = channel.qr; image.alt = '微信连接授权二维码'; content.append(image); }
    }
    append(content, append(node('div', 'ta-actions'), button(pending ? 'Being 正在处理…' : '请 Being 检查状态', () => void checkChannel(), 'ta-secondary', 'channel-check')));
    const check = content.querySelector('#channel-check'); check.disabled = !connected || pending;
    if (channel.detail) content.append(node('p', 'ta-notice', channel.detail));
    ui.channelBody.append(content);
  }

  function applyChannelResult(result) {
    model.channel.status = string(result.status, 'unknown');
    model.channel.detail = string(result.detail, statusNames[model.channel.status] || '连接状态待确认');
    if (model.channel.status === 'pending') model.channel.detail = `Being 已收到请求，实际连接状态仍待确认。${result.detail ? ` ${result.detail}` : ''}`;
    const qr = string(result.qrCodeDataUrl);
    model.channel.qr = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(qr) && qr.length <= 2000000 ? qr : '';
    if (['expired', 'connected', 'disconnected', 'disabled'].includes(result.status)) model.channel.qr = '';
    model.channel.step = result.status === 'connected' ? 2 : 1;
  }

  async function channelOperation(method, payload, busyKey) {
    if (publicState.connection?.status !== 'connected' || busy.has('channel-connect') || busy.has('channel-status')) return;
    const requestEpoch = epoch;
    const selected = model.channel.selected;
    const request = ++channelRequest;
    busy.add(busyKey); model.channel.wizard = true; model.channel.detail = ''; model.channel.qr = ''; renderChannel();
    try {
      const response = record(await call(method, { ...payload, connectionRevision: town.identity?.connectionRevision }));
      if (!sameEpoch(requestEpoch) || request !== channelRequest || selected !== model.channel.selected) return;
      const candidate = method === 'checkChannelStatus' && Array.isArray(response.channels) ? record(response.channels.find((entry) => entry.channel === selected)) : response;
      const result = candidate.channel && candidate.channel !== selected ? {} : candidate;
      applyChannelResult(result);
    } catch (error) { if (sameEpoch(requestEpoch) && request === channelRequest && selected === model.channel.selected) { model.channel.status = 'error'; model.channel.detail = errorText(error); } }
    finally { if (request === channelRequest) { busy.delete(busyKey); renderChannel(); } }
  }

  const beginChannel = () => channelOperation('beginChannelConnection', { channel: model.channel.selected }, 'channel-connect');
  const checkChannel = () => channelOperation('checkChannelStatus', { channel: model.channel.selected }, 'channel-status');

  function buildPortal() {
    ui.portalPage = node('section', 'ta-module ta-portal');
    ui.portalPage.setAttribute('aria-label', '电脑连接');
    ui.content.append(ui.portalPage);
  }

  function renderPortal() {
    const portal = record(publicState.portal);
    const installation = record(town.portalInstall);
    const local = model.portal;
    const page = ui.portalPage;
    page.replaceChildren();
    const machine = string(publicState.machine?.hostname, '当前电脑');
    const workspace = string(town.portalWorkspace?.path);
    const readOnly = town.portalWorkspace?.readOnly || portal.status === 'external';
    const state = busy.has('deploy') ? string(installation.status, local.status) : ['running', 'external', 'error'].includes(portal.status) ? portal.status : local.status || string(portal.status, 'not_configured');
    append(page, append(node('div', 'ta-computer-card'), append(node('span', 'ta-computer-icon'), icon('terminal')), append(node('div', 'ta-computer-copy'), node('h3', '', machine), node('p', 'ta-muted', `${beingName()} 的本机工作区`)), badge(state)));
    const workspaceCard = append(node('section', 'ta-panel'), node('h4', '', '工作区'), node('p', 'ta-mono ta-workspace-path', workspace || (readOnly ? '尚未确认，请核对原配置' : '尚未选择文件夹')));
    const choose = button(workspace ? '更换文件夹' : '选择文件夹', async () => {
      if (busy.has('workspace')) return;
      busy.add('workspace'); choose.disabled = true;
      try { const result = await options.onSelectPortalWorkspace?.(); if (result?.workspace) setState(result); }
      catch (error) { local.detail = errorText(error); }
      finally { busy.delete('workspace'); renderPortal(); }
    }, 'ta-secondary', 'portal-app-workspace');
    choose.disabled = readOnly || busy.has('deploy') || busy.has('workspace');
    append(workspaceCard, node('p', 'ta-muted', readOnly ? '沿用已部署 Portal 的配置工作区；Desktop 项目目录独立保存。' : '一键配置时创建 Portal 专用工作区；与 Desktop 项目目录分别保存。'), choose);
    page.append(workspaceCard);
    if (portal.status === 'external' || portal.management === 'external') {
      page.append(append(node('section', 'ta-panel'), node('h4', '', '优先使用已有 Portal'),
        node('p', '', portal.pid ? '已有进程正在运行，沿用原部署配置和管理方式。' : '已有部署当前未运行，请由原启动方式恢复。'),
        node('p', 'ta-mono', string(portal.deployment?.configPath, '配置位置尚未确认')),
        node('p', 'ta-muted', '工作区与名称来自配置文件；在线连接和实际工具目标需另行确认。'),
        button('打开连接设置', () => options.onNavigateSettings?.(), 'ta-quiet', 'portal-app-settings')));
      return;
    }
    const permissions = append(node('section', 'ta-panel'), node('h4', '', '工具权限'),
      node('p', 'ta-muted', '在设置 → 本机 Portal 中查看和修改文件、命令、截图及自定义工具权限。'),
      button('打开权限设置', () => options.onNavigateSettings?.(), 'ta-quiet', 'portal-app-permissions'),
      node('p', 'ta-muted', '工作区是默认操作目录，Portal 不是操作系统沙箱。'));
    page.append(permissions);
    const release = append(node('section', 'ta-panel'), node('h4', '', '计划安装：官方 Portal v0.8.0'), node('p', 'ta-mono', 'github.com/d5z/heart-portal'));
    release.append(node('p', 'ta-muted', installation.verified === true ? '托管安装包校验：已通过' : '托管安装包校验：尚未确认通过'));
    page.append(release);
    const existing = ['running', 'external'].includes(portal.status);
    const existingConfiguration = Boolean(portal.executable || portal.configPath);
    if (existing) page.append(append(node('div', 'ta-auth-note'), icon('check'), append(node('div'), node('strong', '', '检测到已有 Portal'), node('p', '', portal.connectionCurrent === false ? `Portal 仍连接 ${string(portal.connectionBeingName, '之前的 Being')}。请在连接设置先停止，再启动以连接当前 Being。` : portal.owned ? '部署时将优先检查现有配置，避免重复启动。' : '这是其他方式启动的进程。应用会检查可复用状态，并保留它的原管理方式。'))));
    if (existingConfiguration) page.append(append(node('div', 'ta-auth-note'), icon('settings'), append(node('div'), node('strong', '', '已选择 Portal 程序或配置'), node('p', '', '现有文件与进程会保留。可前往连接设置检查并启动。')), button('打开连接设置', () => options.onNavigateSettings?.(), 'ta-quiet', 'portal-app-settings')));
    if (local.detail || installation.detail || portal.detail) page.append(node('p', 'ta-notice', local.detail || installation.detail || portal.detail));
    if (installation.recovery && !busy.has('deploy')) {
      const recovery = record(installation.recovery);
      const programNames = { retained_verified: '已保留校验通过的程序', not_confirmed: '程序保留状态未确认' };
      const configNames = { saved: '配置已保存', not_created: '未创建配置', removed: '临时配置已移除', cleanup_failed: '临时配置未能清理' };
      const processState = ['running', 'stopped', 'external', 'error'].includes(portal.status) ? portal.status : string(recovery.process, 'unknown');
      const details = append(node('section', 'ta-panel'), node('h4', '', '部署失败后的处理状态'));
      append(details, node('p', '', `程序：${programNames[recovery.program] || '未确认'}`), node('p', '', `配置：${configNames[recovery.configuration] || '未确认'}`), node('p', '', `进程：${statusNames[processState] || '待确认'}`));
      page.append(details);
    }
    if (busy.has('deploy')) {
      const phases = { checking: '核对安装包', download: '下载官方程序', hash: '校验文件摘要', install: '准备本机程序', starting: '启动 Portal', running: 'Portal 已启动', not_started: '尚未启动' };
      const progressBox = append(node('div', 'ta-deployment-progress'), node('h4', '', phases[installation.phase] || '正在准备 Portal'));
      if (Number.isFinite(installation.receivedBytes) && Number.isFinite(installation.totalBytes) && installation.totalBytes > 0) {
        const progress = node('progress'); progress.max = installation.totalBytes; progress.value = Math.min(installation.totalBytes, installation.receivedBytes);
        progress.setAttribute('aria-label', 'Portal 下载进度');
        append(progressBox, progress, node('p', 'ta-muted', `${(installation.receivedBytes / 1024 / 1024).toFixed(1)} / ${(installation.totalBytes / 1024 / 1024).toFixed(1)} MB`));
      } else progressBox.append(node('p', 'ta-muted', '进度将随主进程状态更新。'));
      page.insertBefore(progressBox, workspaceCard.nextSibling); return;
    }
    const ready = Boolean(workspace) && publicState.connection?.status === 'connected' && town.platformSupported !== false;
    if (publicState.connection?.status !== 'connected') page.append(node('p', 'ta-muted', '请先连接 Being，等待会话加载完成后再部署 Portal。'));
    if (town.platformSupported === false) page.append(node('p', 'ta-warning', '当前平台暂无已校验的 Portal 安装包。'));
    const deploy = button(existing || existingConfiguration ? '一键检查并连接 Portal' : '一键部署 Heart Portal', () => void deployPortal(), 'ta-primary', 'portal-app-deploy');
    deploy.disabled = !ready;
    const launch = append(node('section', 'ta-panel ta-portal-launch'), node('h4', '', '一键部署'), node('p', '', `将 ${machine} 的工作区连接给 ${beingName()}。点击后自动下载、校验、配置并启动官方 Portal。`), node('p', 'ta-muted', '文件读写与搜索开启 · 命令执行关闭 · 第三方工具包不加载。网络与 OAuth 基础能力保留。'), deploy);
    launch.append(helpButton('portal-setup', '请 Being 协助'));
    page.insertBefore(launch, workspaceCard.nextSibling);
  }

  async function deployPortal() {
    if (busy.has('deploy') || !town.portalWorkspace?.path || publicState.connection?.status !== 'connected' || town.platformSupported === false) return;
    const requestEpoch = epoch;
    busy.add('deploy'); model.portal.confirm = false; model.portal.detail = ''; model.portal.status = 'deploying'; renderPortal();
    try {
      const result = record(await call('deployPortal', { confirmed: true, permissions: { ...model.portal.permissions } }));
      if (!sameEpoch(requestEpoch)) return;
      if (result.state?.connection) setState(result.state);
      model.portal.status = string(result.status, string(result.state?.portal?.status, 'unknown'));
      model.portal.detail = string(result.detail, '部署请求已处理，请根据 Portal 运行与连接状态确认结果。');
    } catch (error) { if (sameEpoch(requestEpoch)) { model.portal.status = 'error'; model.portal.detail = errorText(error); } }
    finally { busy.delete('deploy'); renderPortal(); }
  }

  function buildFireside() {
    const page = ui.firesidePage = node('section', 'ta-module ta-fireside');
    page.setAttribute('aria-label', 'Fireside 围炉群聊');
    const rooms = node('aside', 'ta-room-sidebar');
    rooms.setAttribute('aria-label', '围炉列表');
    const actions = append(node('div', 'ta-room-actions'), button('创建围炉', () => showRoomDialog('create'), 'ta-quiet', 'fireside-create'), button('加入', () => showRoomDialog('join'), 'ta-quiet', 'fireside-join'));
    ui.roomList = node('div', 'ta-room-list');
    append(rooms, actions, ui.roomList);
    ui.roomCenter = node('div', 'ta-room-center');
    ui.roomHeading = node('div', 'ta-room-heading');
    ui.roomTitle = node('h3'); ui.roomTitle.id = 'fireside-room-name';
    ui.roomStatus = node('p', 'ta-muted'); ui.roomStatus.id = 'fireside-refresh-status';
    const membersToggle = button('成员', () => { model.fireside.showMembers = !ui.firesidePage.classList.contains('show-members'); renderMembers(); }, 'ta-quiet', 'fireside-members-toggle');
    membersToggle.setAttribute('aria-expanded', 'false'); membersToggle.setAttribute('aria-controls', 'fireside-members');
    append(ui.roomHeading, ui.roomTitle, membersToggle);
    ui.roomNotice = notice();
    ui.roomMessages = node('div', 'ta-room-messages');
    ui.roomMessages.setAttribute('aria-label', '围炉消息');
    ui.roomMessages.setAttribute('aria-live', 'polite');
    watchTimeline(ui.roomMessages, 'fireside');
    ui.roomComposer = node('div', 'ta-composer ta-fireside-composer ta-capsule-composer');
    ui.roomDraft = node('textarea', 'ta-input ta-capsule-input');
    ui.roomDraft.id = 'fireside-draft'; ui.roomDraft.rows = 1; ui.roomDraft.maxLength = 32000;
    ui.roomDraft.placeholder = '写下围炉消息…'; ui.roomDraft.setAttribute('aria-label', '围炉消息草稿');
    ui.roomDraft.addEventListener('input', () => { model.fireside.drafts.set(model.fireside.selected || 'local', ui.roomDraft.value); renderComposer(); });
    ui.roomDraft.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      if (!canSendFireside()) return;
      event.preventDefault();
      if (!ui.roomSend.disabled) void sendMessage();
    });
    ui.roomSend = button('', () => { if (canSendFireside()) void sendMessage(); else void carryFiresideDraft(); }, 'ta-capsule-submit', 'fireside-send');
    ui.roomSendLabel = node('span', 'visually-hidden');
    ui.roomSendIcon = icon('external');
    append(ui.roomSend, ui.roomSendLabel, ui.roomSendIcon);
    append(ui.roomComposer, append(node('div', 'ta-composer-capsule'), ui.roomDraft, ui.roomSend));
    ui.roomReply = node('div', 'ta-reply-slot');
    append(ui.roomCenter, ui.roomHeading, ui.roomStatus, ui.roomNotice, ui.roomMessages, ui.roomReply, ui.roomComposer);
    ui.roomMembers = node('aside', 'ta-members'); ui.roomMembers.id = 'fireside-members'; ui.roomMembers.setAttribute('aria-label', '围炉成员');
    ui.roomDialog = node('div', 'ta-room-dialog'); ui.roomDialog.hidden = true;
    append(page, rooms, ui.roomCenter, ui.roomMembers, ui.roomDialog);
    ui.content.append(page);
  }

  function renderRooms() {
    const fireside = model.fireside;
    ui.roomList.replaceChildren();
    if (!connected()) ui.roomList.append(message('连接 Being 后读取围炉', ''));
    else if (fireside.status === 'loading' && !fireside.rooms.length) ui.roomList.append(message('读取围炉中', ''));
    else if (fireside.error) ui.roomList.append(message('暂时无法读取围炉', fireside.error, button('重试', () => void loadRooms(), 'ta-secondary')));
    else if (fireside.status === 'ready' && !fireside.rooms.length) ui.roomList.append(message('还没有围炉', ''));
    else if (fireside.status === 'idle') ui.roomList.append(message('围炉目录尚未读取', '配对 Town 后可直接读取围炉目录。'));
    for (const room of connected() ? fireside.rooms : []) {
      const id = String(room.id);
      const row = button('', () => void selectRoom(id, { readOnce: true }), 'ta-room-row');
      row.classList.toggle('is-selected', id === fireside.selected); row.setAttribute('aria-pressed', String(id === fireside.selected));
      append(row, node('span', 'ta-room-avatar', string(room.name, '围').slice(0, 1)), append(node('span', 'ta-room-row-copy'), node('strong', '', string(room.name, '未命名围炉')), node('span', 'ta-muted', `${room.owned ? '我创建的' : '已加入'}${Number.isSafeInteger(room.member_count) ? ` · ${room.member_count} 位成员` : ''}`)));
      ui.roomList.append(row);
    }
  }

  function renderMembers() {
    const fireside = model.fireside;
    const expanded = fireside.showMembers ?? root.clientWidth > 960;
    ui.firesidePage.classList.toggle('show-members', expanded);
    ui.roomHeading.querySelector('#fireside-members-toggle').setAttribute('aria-expanded', String(expanded));
    ui.roomMembers.replaceChildren(append(node('div', 'ta-members-heading'), node('h4', '', '成员'), button('收起', () => { fireside.showMembers = false; renderMembers(); }, 'ta-quiet ta-members-close')));
    if (!fireside.selected || !connected()) return;
    if (!fireside.members.length) { ui.roomMembers.append(node('p', 'ta-muted', '暂未取得成员列表。')); return; }
    for (const member of fireside.members) {
      const name = memberName(member);
      append(ui.roomMembers, append(node('div', 'ta-member'), node('span', 'ta-member-avatar', name.slice(0, 1)), append(node('span', 'ta-member-copy'), node('strong', '', name), node('span', 'ta-muted', memberId(member) === beingId() ? '当前 Being' : memberId(member)))));
    }
  }

  function renderComposer() {
    const fireside = model.fireside;
    const enabled = canSendFireside() && Boolean(fireside.selected) && connected();
    if (ui.roomReply) {
      if (!canReply()) fireside.replies.delete(fireside.selected);
      ui.roomReply.replaceChildren();
      const banner = replyBanner(fireside.replies.get(fireside.selected), () => { fireside.replies.delete(fireside.selected); renderFireside(); });
      if (banner) ui.roomReply.append(banner);
    }
    const pending = busy.has(`send:${fireside.selected}`);
    const canCarry = publicState.connection?.status === 'connected' && Number.isSafeInteger(town.identity?.connectionRevision);
    const carryPending = busy.has('draft-handoff');
    const uncertain = fireside.deliveries.some(entry => entry.room === fireside.selected && entry.message === ui.roomDraft.value && entry.status === 'uncertain');
    ui.roomSend.disabled = !ui.roomDraft.value.trim() || (canSendFireside() ? !enabled || pending : !canCarry || carryPending);
    text(ui.roomSendLabel, canSendFireside() ? pending ? '处理中…' : uncertain ? '核对发送结果' : '发送' : carryPending ? '正在准备草稿…' : '带草稿到 Loom');
    ui.roomSendIcon.querySelector('use').setAttribute('href', canSendFireside() ? '#i-arrow' : '#i-external');
    ui.roomSend.classList.toggle('is-send', canSendFireside());
    ui.roomSend.setAttribute('aria-busy', String(pending || carryPending));
  }

  async function carryFiresideDraft() {
    const draft = ui.roomDraft.value;
    const revision = town.identity?.connectionRevision;
    if (!draft.trim() || busy.has('draft-handoff') || publicState.connection?.status !== 'connected' || !Number.isSafeInteger(revision)) return;
    const route = navigation;
    const requestEpoch = epoch;
    busy.add('draft-handoff'); model.fireside.roomError = ''; setNotice(ui.roomNotice, ''); renderComposer();
    try {
      const result = record(await call('prepareFiresideDraft', { draft, connectionRevision: revision }));
      if (!sameEpoch(requestEpoch) || !activeRoute(route)) return;
      if (result.prepared !== true) throw new Error('Loom 草稿准备结果未确认，本机草稿已保留。');
      options.onNavigateChat?.();
    } catch (error) {
      if (sameEpoch(requestEpoch)) { model.fireside.roomError = errorText(error); if (activeRoute(route)) setNotice(ui.roomNotice, model.fireside.roomError, true); }
    } finally { busy.delete('draft-handoff'); renderComposer(); }
  }

  function renderMessages() {
    const fireside = model.fireside;
    const room = fireside.rooms.find((entry) => String(entry.id) === fireside.selected);
    text(ui.roomTitle, room ? string(room.name, '未命名围炉') : '围炉');
    const showStatus = Boolean(fireside.selected);
    text(ui.roomStatus, showStatus ? refreshLabel(fireside) : '');
    visible(ui.roomStatus, showStatus);
    const error = [fireside.roomError, fireside.messageError].filter(Boolean).join(' ');
    setNotice(ui.roomNotice, error, Boolean(error));
    const messagesKey = JSON.stringify([connected(), fireside.selected, room?.name, fireside.messages, fireside.deliveries, busy.has('room'), error, fireside.refresh.status, backgroundNotConfigured(fireside), canReply(), fireside.hasOlder, fireside.loadingOlder, fireside.olderError, fireside.lastRefresh]);
    if (ui.roomMessages.dataset.rendered === messagesKey) { renderComposer(); return; }
    const nearBottom = ui.roomMessages.scrollHeight - ui.roomMessages.scrollTop - ui.roomMessages.clientHeight < 80;
    const before = { scrollTop: ui.roomMessages.scrollTop, scrollHeight: ui.roomMessages.scrollHeight, firstId: ui.roomMessages.dataset.firstId };
    const changedRoom = ui.roomMessages.dataset.room !== fireside.selected;
    ui.roomMessages.dataset.rendered = messagesKey; ui.roomMessages.dataset.room = fireside.selected;
    ui.roomMessages.dataset.firstId = connected() && fireside.messages.length ? String(fireside.messages[0].id) : '';
    ui.roomMessages.replaceChildren();
    if (connected() && room && fireside.messages.length) ui.roomMessages.append(olderControl('fireside'));
    const marker = refreshMarker(fireside, connected() && room ? fireside.messages : []);
    if (!connected()) ui.roomMessages.append(message('连接 Being 后同步围炉', ''));
    else if (!room) ui.roomMessages.append(message('选择一个围炉', ''));
    else if (!fireside.messages.length && (busy.has('room') || fireside.refresh.status === 'refreshing')) ui.roomMessages.append(message('读取消息中', ''));
    else if (!fireside.messages.length && error) ui.roomMessages.append(message('消息尚未同步', error));
    else if (!fireside.messages.length && !fireside.refresh.lastSuccessAt) ui.roomMessages.append(message(backgroundNotConfigured(fireside) ? '后台采集尚未设置' : '等待 Town 同步', '配对 Town 后自动同步，也可点击立即同步。'));
    else if (!fireside.messages.length) ui.roomMessages.append(message('这里还没有消息', ''));
    for (const entry of connected() ? fireside.messages : []) {
      if (marker.node && entry.id === marker.before) ui.roomMessages.append(marker.node);
      const mine = bonfireSender(entry) === beingId();
      const messageNode = node('article', `ta-message${mine ? ' is-mine' : ''}`);
      const time = entry.createdAt || entry.at ? new Date(entry.createdAt || entry.at) : null;
      const timestamp = time && !Number.isNaN(time.getTime()) ? time.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const author = string(entry.beingName, string(entry.speaker_name, bonfireSender(entry) || 'Being'));
      append(messageNode,
        append(node('div', 'ta-message-meta'), node('strong', '', author), viaBadge(entry), node('span', '', `${timestamp}${entry.revisedAt || entry.revised_at ? ' · 已编辑' : ''}`),
          canSendFireside() && canReply() ? replyButton({...entry, beingName: author}, startFiresideReply) : null),
        replyQuote(entry),
        node('p', 'ta-message-body', string(entry.content, string(entry.message))));
      ui.roomMessages.append(messageNode);
    }
    for (const delivery of canSendFireside() ? fireside.deliveries.filter((entry) => entry.room === fireside.selected) : []) {
      const label = { pending: '发送中…', failed: '发送未完成', uncertain: '发送结果待确认' }[delivery.status] || '待确认';
      const item = append(node('article', `ta-message is-mine ta-delivery ta-${delivery.status}`), node('div', 'ta-message-meta', `${beingName()} · ${label}`), node('p', 'ta-message-body', delivery.message));
      if (delivery.status === 'uncertain') item.append(node('p', 'ta-warning', '上游可能已经收到。再次提交此草稿只核对原请求，不会重发。'));
      if (delivery.status === 'failed') item.append(button('放回草稿', () => {
        if (ui.roomDraft.value) { setNotice(ui.roomNotice, '已有草稿，请先处理当前草稿。', true); return; }
        model.fireside.drafts.set(fireside.selected, delivery.message); ui.roomDraft.value = delivery.message;
        fireside.deliveries = fireside.deliveries.filter((entry) => entry !== delivery); renderMessages(); renderComposer();
      }, 'ta-quiet'));
      ui.roomMessages.append(item);
    }
    ui.roomMessages.append(jumpControl(ui.roomMessages));
    keepPosition(ui.roomMessages, before, nearBottom, changedRoom);
    updateJump(ui.roomMessages);
    renderComposer();
  }

  function renderFireside() { renderRooms(); renderMessages(); renderMembers(); }

  async function loadRooms() {
    if (!connected() || busy.has('rooms')) { if (visibleModule('fireside')) renderFireside(); return; }
    const requestEpoch = epoch;
    busy.add('rooms'); model.fireside.status = 'loading'; model.fireside.error = ''; renderRooms();
    try {
      const result = record(await call('getFiresides'));
      if (!sameEpoch(requestEpoch)) return;
      // Only retain room display fields. Invite keys never enter application state.
      const safeRoom = (room, owned) => ({ id: room.id, name: string(room.name), member_count: room.member_count, owned });
      model.fireside.rooms = [...array(result.owned).map((room) => safeRoom(room, true)), ...array(result.joined).map((room) => safeRoom(room, false))];
      model.fireside.status = result.cached === false || result.status?.reason === 'waiting_sbs' && !result.status?.lastSuccessAt ? 'idle' : 'ready';
      if (model.fireside.selected && !model.fireside.rooms.some((room) => String(room.id) === model.fireside.selected)) { model.fireside.selected = ''; model.fireside.messages = []; model.fireside.members = []; model.fireside.refresh = {}; model.fireside.messageError = ''; }
    } catch (error) { if (sameEpoch(requestEpoch)) { model.fireside.status = 'error'; model.fireside.error = errorText(error); } }
    finally { busy.delete('rooms'); if (visibleModule('fireside')) renderFireside(); }
  }

  async function selectRoom(id, { manual = false, readOnce = false, includeRooms = false } = {}) {
    if (!connected() || !model.fireside.rooms.some((room) => String(room.id) === id)) return;
    const request = ++roomRequest;
    const requestEpoch = epoch;
    const route = navigation;
    const fireside = model.fireside;
    const changedRoom = fireside.selected !== id;
    fireside.selected = id; fireside.roomError = '';
    if (changedRoom) { roomSelection += 1; fireside.messages = []; fireside.members = []; fireside.refresh = {}; fireside.messageError = ''; ui.roomDraft.value = fireside.drafts.get(id) || ''; }
    busy.add('room'); renderCurrent();
    // The member directory updates independently so it cannot delay cached messages or a fresh read.
    void (async () => {
      try {
        const result = await call('getFiresideMembers', id);
        if (request !== roomRequest || !sameEpoch(requestEpoch)) return;
        fireside.members = array(result?.members || result);
      } catch {
        if (request !== roomRequest || !sameEpoch(requestEpoch)) return;
        fireside.roomError = '成员列表未能读取。';
      }
      if (visibleModule('fireside')) renderFireside();
    })();
    await readTownMessages('fireside', id, manual);
    if (request !== roomRequest || !sameEpoch(requestEpoch)) return;
    busy.delete('room');
    if (visibleModule('fireside')) renderFireside();
    if (readOnce && activeRoute(route) && current === 'fireside') await requestReadOnce({ includeRooms });
  }

  async function sendMessage() {
    const fireside = model.fireside;
    const room = fireside.selected;
    const messageText = ui.roomDraft.value;
    if (!canSendFireside() || !connected() || !room || !messageText.trim() || busy.has(`send:${room}`)) return;
    const requestEpoch = epoch;
    const delivery = fireside.deliveries.find(entry => entry.room === room && entry.message === messageText) || {room, message: messageText, requestId: crypto.randomUUID()};
    delivery.status = 'pending';
    if (!fireside.deliveries.includes(delivery)) fireside.deliveries.push(delivery);
    fireside.drafts.set(room, messageText); fireside.roomError = '';
    busy.add(`send:${room}`); renderMessages();
    try {
      const parent = fireside.replies.get(room);
      const result = record(await call('sendFiresideMessage', { firesideId: room, message: messageText, connectionRevision: town.identity?.connectionRevision, requestId: delivery.requestId, ...(parent ? { replyTo: parent.id } : {}) }));
      if (!sameEpoch(requestEpoch)) return;
      if (result.status === 'uncertain' || result.ok !== true) delivery.status = 'uncertain';
      else {
        fireside.deliveries = fireside.deliveries.filter((entry) => entry !== delivery);
        fireside.replies.delete(room);
        if (fireside.drafts.get(room) === messageText) fireside.drafts.set(room, '');
        if (fireside.selected === room) {
          if (ui.roomDraft.value === messageText) ui.roomDraft.value = '';
          if (visibleModule('fireside')) await requestReadOnce();
        }
      }
    } catch (error) {
      if (!sameEpoch(requestEpoch)) return;
      // Only an explicit pre-send rejection is safe to label as failed.
      delivery.status = ['VALIDATION', 'INVALID_REQUEST', 'AUTH_REQUIRED', 'NOT_SENT'].includes(error?.code) ? 'failed' : 'uncertain';
      if (fireside.selected === room) fireside.roomError = errorText(error);
    } finally { if (sameEpoch(requestEpoch)) { busy.delete(`send:${room}`); renderMessages(); } }
  }

  function showRoomDialog(kind) {
    const container = ui.roomDialog;
    model.fireside.dialog = kind;
    container.replaceChildren(); container.hidden = false;
    const card = node('section', 'ta-dialog-card'); card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-label', kind === 'create' ? '创建围炉' : '加入围炉');
    const close = () => { container.replaceChildren(); container.hidden = true; model.fireside.dialog = ''; ui.firesidePage.querySelector(kind === 'create' ? '#fireside-create' : '#fireside-join')?.focus(); };
    append(card, append(node('div', 'ta-card-heading'), node('h3', '', kind === 'create' ? '创建围炉' : '加入围炉'), button('关闭', close, 'ta-quiet')));
    if (!can('fireside')) {
      append(card, node('p', '', kind === 'create' ? '创建一个受邀的小圈子。当前桌面授权尚未接通，可由 Being 协助创建。' : '邀请密钥用于加入私密围炉。当前没有安全提交通道，此处暂不收集密钥。'), helpButton(kind === 'create' ? 'fireside-create' : 'fireside-join'));
    } else {
      const field = node('input', 'ta-input'); field.type = kind === 'join' ? 'password' : 'text'; field.autocomplete = 'off'; field.maxLength = kind === 'join' ? 64 : 64; field.id = 'fireside-dialog-input';
      const label = node('label', 'ta-field-label', kind === 'create' ? '围炉名称' : '邀请密钥'); label.htmlFor = field.id;
      const feedback = notice();
      const submit = button(kind === 'create' ? '创建' : '加入', async () => {
        if (!field.value.trim() || busy.has('room-mutation')) return;
        const requestEpoch = epoch;
        busy.add('room-mutation'); submit.disabled = true;
        try {
          const value = field.value; if (kind === 'join') field.value = '';
          await call(kind === 'create' ? 'createFireside' : 'joinFireside', kind === 'create' ? { name: value.trim() } : { key: value });
          if (sameEpoch(requestEpoch)) { close(); await loadRooms(); }
        } catch (error) { if (sameEpoch(requestEpoch)) setNotice(feedback, errorText(error), true); }
        finally { busy.delete('room-mutation'); submit.disabled = false; }
      }, 'ta-primary');
      append(card, label, field, feedback, submit);
    }
    container.append(card);
    card.querySelector('button')?.focus();
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(card.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)'));
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
  }

  const memberId = (member) => string(member.being_id, string(member.beingId, string(member.id)));
  const memberName = (member) => string(member.display_name, string(member.displayName, string(member.name, memberId(member))));
  const bonfireSender = (entry) => string(entry.being, string(entry.being_id, string(entry.beingId, string(entry.speaker))));

  function buildBonfire() {
    const page = ui.bonfirePage = node('section', 'ta-module ta-bonfire');
    page.setAttribute('aria-label', '篝火对话');
    const sidebar = node('aside', 'ta-bonfire-sidebar'); sidebar.setAttribute('aria-label', 'Being 成员筛选');
    ui.bonfireMembers = node('div', 'ta-bonfire-members');
    ui.bonfireMembers.id = 'bonfire-members';
    ui.bonfireMembersToggle = button('', () => {
      bonfireMembersCollapsed = !bonfireMembersCollapsed;
      renderBonfireMembersLayout();
    }, 'ta-quiet ta-bonfire-members-toggle', 'bonfire-members-toggle');
    ui.bonfireMembersToggle.append(icon('chevron'));
    ui.bonfireMembersToggle.setAttribute('aria-controls', 'bonfire-members');
    append(sidebar, append(node('div', 'ta-bonfire-members-heading'), node('h3', '', 'Being members'), ui.bonfireMembersToggle), ui.bonfireMembers);
    renderBonfireMembersLayout();
    const center = node('div', 'ta-room-center');
    ui.bonfireMessages = node('div', 'ta-room-messages'); ui.bonfireMessages.id = 'bonfire-messages';
    ui.bonfireMessages.setAttribute('role', 'log'); ui.bonfireMessages.setAttribute('aria-label', '篝火消息'); ui.bonfireMessages.setAttribute('aria-live', 'polite');
    watchTimeline(ui.bonfireMessages, 'bonfire');
    const composer = node('div', 'ta-composer ta-bonfire-composer ta-capsule-composer');
    ui.bonfireDraft = node('textarea', 'ta-input ta-capsule-input'); ui.bonfireDraft.id = 'bonfire-draft'; ui.bonfireDraft.rows = 1; ui.bonfireDraft.maxLength = 4000;
    ui.bonfireDraft.placeholder = '在篝火里聊聊…'; ui.bonfireDraft.setAttribute('aria-label', '篝火消息草稿');
    ui.bonfireDraft.setAttribute('aria-autocomplete', 'list'); ui.bonfireDraft.setAttribute('aria-controls', 'bonfire-mentions');
    ui.bonfireMentions = node('div', 'ta-mention-menu'); ui.bonfireMentions.id = 'bonfire-mentions'; ui.bonfireMentions.setAttribute('role', 'listbox'); ui.bonfireMentions.setAttribute('aria-label', '提及 Being'); ui.bonfireMentions.hidden = true;
    ui.bonfireDraft.addEventListener('input', () => { model.bonfire.draft = ui.bonfireDraft.value; model.bonfire.mentionIndex = 0; model.bonfire.mentionClosed = false; renderBonfireComposer(); });
    ui.bonfireDraft.addEventListener('click', () => { model.bonfire.mentionClosed = false; renderBonfireComposer(); });
    ui.bonfireDraft.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      const suggestions = bonfireSuggestions();
      if (!ui.bonfireMentions.hidden && suggestions.length) {
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault(); model.bonfire.mentionIndex = (model.bonfire.mentionIndex + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length; renderBonfireComposer(); return;
        }
        if (event.key === 'Escape') { event.preventDefault(); model.bonfire.mentionClosed = true; renderBonfireComposer(); return; }
        if (['Enter', 'Tab'].includes(event.key) && !event.shiftKey) { event.preventDefault(); insertBonfireMention(suggestions[model.bonfire.mentionIndex] || suggestions[0]); return; }
      }
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!ui.bonfireSend.disabled) void sendBonfire(); }
    });
    ui.bonfireSend = button('', () => void sendBonfire(), 'ta-capsule-submit is-send', 'bonfire-send');
    ui.bonfireSendLabel = node('span', 'visually-hidden');
    append(ui.bonfireSend, ui.bonfireSendLabel, icon('arrow'));
    append(composer, append(node('div', 'ta-composer-capsule'), ui.bonfireMentions, ui.bonfireDraft, ui.bonfireSend));
    ui.bonfireFeedback = node('p', 'visually-hidden'); ui.bonfireFeedback.id = 'bonfire-send-feedback'; ui.bonfireFeedback.setAttribute('role', 'status');
    ui.bonfireSend.setAttribute('aria-describedby', ui.bonfireFeedback.id);
    append(composer, ui.bonfireFeedback);
    ui.bonfireReply = node('div', 'ta-reply-slot');
    append(center, ui.bonfireMessages, ui.bonfireReply, composer);
    append(page, sidebar, center); ui.content.append(page);
  }

  function mentionToken() {
    const draft = ui.bonfireDraft;
    const match = /(?:^|\s)@([^\s@]*)$/.exec(draft.value.slice(0, draft.selectionStart));
    return match ? { query: match[1].toLocaleLowerCase(), start: draft.selectionStart - match[1].length - 1, end: draft.selectionStart } : null;
  }

  function bonfireSuggestions() {
    const token = mentionToken();
    if (!token || model.bonfire.mentionClosed) return [];
    return model.bonfire.members.filter((member) => memberId(member) && [memberId(member), memberName(member)].some((value) => value.toLocaleLowerCase().includes(token.query))).slice(0, 8);
  }

  function insertBonfireMention(member) {
    const token = mentionToken(); if (!token) return;
    const draft = ui.bonfireDraft;
    const mention = `@${memberId(member)} `;
    draft.setRangeText(mention, token.start, token.end, 'end');
    model.bonfire.draft = draft.value; model.bonfire.mentionClosed = true;
    renderBonfireComposer(); draft.focus();
  }

  function renderBonfireComposer() {
    const state = model.bonfire;
    const connected = publicState.connection?.status === 'connected';
    if (ui.bonfireReply) {
      if (!canReply()) state.replyTo = null;
      ui.bonfireReply.replaceChildren();
      const banner = replyBanner(state.replyTo, () => { state.replyTo = null; renderBonfire(); });
      if (banner) ui.bonfireReply.append(banner);
    }
    ui.bonfireSend.disabled = !connected || !state.draft.trim() || busy.has('bonfire-send');
    text(ui.bonfireSendLabel, busy.has('bonfire-send') ? '处理中…' : state.sendRequest?.content === state.draft && state.sendRequest.uncertain ? '核对发送结果' : '发送到篝火');
    ui.bonfireSend.setAttribute('aria-busy', String(busy.has('bonfire-send')));
    const feedback = state.sendRequest?.uncertain ? '发送结果待确认，草稿已保留。' : state.sendError;
    text(ui.bonfireFeedback, feedback || '');
    ui.bonfireSend.title = feedback || ui.bonfireSendLabel.textContent;
    const suggestions = connected ? bonfireSuggestions() : [];
    if (state.mentionIndex >= suggestions.length) state.mentionIndex = 0;
    ui.bonfireMentions.replaceChildren();
    const showing = connected && Boolean(mentionToken()) && !state.mentionClosed;
    visible(ui.bonfireMentions, showing);
    ui.bonfireDraft.setAttribute('aria-expanded', String(showing));
    ui.bonfireDraft.removeAttribute('aria-activedescendant');
    if (showing && !suggestions.length) ui.bonfireMentions.append(node('p', 'ta-muted', state.memberError ? '成员暂时无法读取，请刷新重试。' : state.status === 'loading' ? '正在读取成员…' : '没有匹配的 Being'));
    suggestions.forEach((member, index) => {
      const item = button('', () => insertBonfireMention(member), 'ta-mention-option');
      item.id = `bonfire-mention-${index}`; item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(index === state.mentionIndex));
      item.addEventListener('mousedown', (event) => event.preventDefault());
      append(item, node('strong', '', memberName(member)), node('span', 'ta-muted', `@${memberId(member)}`));
      ui.bonfireMentions.append(item);
      if (showing && index === state.mentionIndex) ui.bonfireDraft.setAttribute('aria-activedescendant', item.id);
    });
  }

  function renderBonfireMembersLayout() {
    ui.bonfirePage.classList.toggle('members-collapsed', bonfireMembersCollapsed);
    ui.bonfireMembers.hidden = bonfireMembersCollapsed;
    const label = bonfireMembersCollapsed ? '展开成员栏' : '收起成员栏';
    ui.bonfireMembersToggle.title = label;
    ui.bonfireMembersToggle.setAttribute('aria-label', label);
    ui.bonfireMembersToggle.setAttribute('aria-expanded', String(!bonfireMembersCollapsed));
  }

  function renderBonfire() {
    const state = model.bonfire;
    const connected = publicState.connection?.status === 'connected';
    ui.bonfireMessages.title = [state.error, state.refresh.stale ? '显示上次同步内容' : ''].filter(Boolean).join(' · ');
    const membersKey = JSON.stringify([connected, state.members, state.sender, state.memberError]);
    if (ui.bonfireMembers.dataset.rendered !== membersKey) {
      ui.bonfireMembers.dataset.rendered = membersKey; ui.bonfireMembers.replaceChildren();
      const filter = (id) => { state.sender = id; renderBonfire(); };
      const all = button('全部消息', () => filter(''), 'ta-room-row'); all.setAttribute('aria-pressed', String(!state.sender)); all.classList.toggle('is-selected', !state.sender); ui.bonfireMembers.append(all);
      for (const member of connected ? state.members : []) {
        const id = memberId(member); const name = memberName(member);
        const row = button('', () => filter(id), 'ta-room-row ta-bonfire-member'); row.dataset.beingId = id; row.setAttribute('aria-pressed', String(state.sender === id)); row.classList.toggle('is-selected', state.sender === id);
        append(row, node('span', 'ta-member-avatar', name.slice(0, 1)), append(node('span', 'ta-member-copy'), node('strong', '', name), node('span', 'ta-muted', `@${id}`))); ui.bonfireMembers.append(row);
      }
      if (connected && !state.members.length) ui.bonfireMembers.append(node('p', 'ta-muted', state.memberError ? '成员列表暂不可用' : '尚无成员数据'));
    }
    const shown = connected ? state.messages.filter((entry) => !state.sender || bonfireSender(entry) === state.sender) : [];
    const messagesKey = JSON.stringify([connected, shown, state.sender, state.status === 'loading' && !state.messages.length, Boolean(state.refresh.lastSuccessAt), backgroundNotConfigured(state), state.error, state.source, canReply(), state.hasOlder, state.loadingOlder, state.olderError, state.lastRefresh]);
    if (ui.bonfireMessages.dataset.rendered !== messagesKey) {
      const nearBottom = ui.bonfireMessages.scrollHeight - ui.bonfireMessages.scrollTop - ui.bonfireMessages.clientHeight < 80;
      const before = { scrollTop: ui.bonfireMessages.scrollTop, scrollHeight: ui.bonfireMessages.scrollHeight, firstId: ui.bonfireMessages.dataset.firstId };
      const previousSender = ui.bonfireMessages.dataset.sender;
      ui.bonfireMessages.dataset.rendered = messagesKey; ui.bonfireMessages.dataset.sender = state.sender; ui.bonfireMessages.replaceChildren();
      ui.bonfireMessages.dataset.firstId = shown.length ? String(shown[0].id) : '';
      if (connected && shown.length) ui.bonfireMessages.append(olderControl('bonfire'));
      const marker = refreshMarker(state, shown);
      if (!connected) ui.bonfireMessages.append(message('连接 Being，加入篝火', '', button('连接设置', () => options.onNavigateSettings?.(), 'ta-secondary')));
      else if (!shown.length) ui.bonfireMessages.append(message(state.error ? '消息尚未同步' : state.status === 'loading' ? '正在同步 Town 消息' : !state.refresh.lastSuccessAt ? backgroundNotConfigured(state) ? '后台采集尚未设置' : '等待 Town 同步' : state.sender ? '这位 Being 暂无消息' : '篝火里还没有消息', state.error || (!state.refresh.lastSuccessAt ? '配对 Town 后自动同步，也可点击立即同步。' : '')));
      for (const entry of shown) {
        if (marker.node && entry.id === marker.before) ui.bonfireMessages.append(marker.node);
        const sender = bonfireSender(entry);
        const member = state.members.find((value) => memberId(value) === sender);
        const author = string(entry.beingName, string(entry.speaker_name, string(entry.display_name, member ? memberName(member) : sender || 'Being')));
        const time = entry.at || entry.created_at || entry.createdAt; const date = time ? new Date(time) : null;
        const timestamp = date && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        const item = node('article', `ta-message${sender === beingId() ? ' is-mine' : ''}`);
        append(item,
          append(node('div', 'ta-message-meta'), node('strong', '', author), viaBadge(entry), node('span', '', `${timestamp}${entry.revisedAt || entry.revised_at ? ' · 已编辑' : ''}${state.source === 'being_relay' ? ' · Being 转交 · 原文未独立核验' : ''}`),
            canSendBonfire() && canReply() ? replyButton({...entry, beingName: author}, startBonfireReply) : null),
          replyQuote(entry),
          node('p', 'ta-message-body', string(entry.content, string(entry.message)))); ui.bonfireMessages.append(item);
      }
      ui.bonfireMessages.append(jumpControl(ui.bonfireMessages));
      keepPosition(ui.bonfireMessages, before, nearBottom, previousSender !== state.sender);
      updateJump(ui.bonfireMessages);
    }
    renderBonfireComposer();
  }

  async function loadBonfireMembers() {
    if (!connected()) return;
    const requestEpoch = epoch;
    const state = model.bonfire;
    try {
      if (!state.members.length) {
        const cached = await cachedData('getBeingMembers');
        if (!sameEpoch(requestEpoch)) return;
        if (cached) {
          state.members = array(cached?.members || cached?.beings || cached).filter((member) => memberId(record(member)));
          if (visibleModule('bonfire')) renderBonfire();
        }
      }
      const result = await call('getBeingMembers');
      if (!sameEpoch(requestEpoch)) return;
      state.members = array(result?.members || result?.beings || result).filter((member) => memberId(record(member))); state.memberError = '';
    } catch {
      if (!sameEpoch(requestEpoch)) return;
      state.memberError = '成员列表暂时无法读取，可点击刷新重试。';
    }
    if (visibleModule('bonfire')) renderBonfire();
  }

  async function loadBonfire(manual = false) {
    if (!connected()) { if (visibleModule('bonfire')) renderBonfire(); return; }
    await Promise.all([readTownMessages('bonfire', '', manual), loadBonfireMembers()]);
  }

  function replyTarget(entry, author) {
    return {id: String(entry.id), beingId: string(entry.beingId, string(entry.senderId)), beingName: author, preview: string(entry.content).slice(0, 200)};
  }
  function startBonfireReply(entry) {
    model.bonfire.replyTo = replyTarget(entry, string(entry.beingName, '某位 Being'));
    renderBonfire(); ui.bonfireDraft?.focus({preventScroll: true});
  }
  function startFiresideReply(entry) {
    model.fireside.replies.set(model.fireside.selected, replyTarget(entry, string(entry.beingName, '某位 Being')));
    renderFireside(); ui.roomDraft?.focus({preventScroll: true});
  }
  function startInboxReply(entry) {
    const state = model.inbox;
    state.replyTo = replyTarget(entry, string(entry.senderName, '某位 Being'));
    // A reply is addressed to whoever sent the message being replied to.
    state.recipient = string(entry.senderId, string(entry.senderName));
    renderInbox(); ui.inboxDraft?.focus({preventScroll: true});
  }

  async function sendBonfire() {
    const state = model.bonfire; const content = state.draft;
    if (!content.trim() || publicState.connection?.status !== 'connected' || busy.has('bonfire-send')) return;
    const requestEpoch = epoch;
    const handles = new Set(Array.from(content.matchAll(/(?:^|\s)@([A-Za-z0-9][A-Za-z0-9_-]{0,99})(?=$|[^A-Za-z0-9_-])/g), (match) => match[1]));
    if (state.sendRequest?.content !== content) state.sendRequest = {content, requestId: crypto.randomUUID(), uncertain: false};
    const sendRequest = state.sendRequest;
    const mentions = state.members.map(memberId).filter((id) => handles.has(id));
    busy.add('bonfire-send'); state.sendError = ''; renderBonfire();
    try {
      let result;
      try {
        result = record(await call('sendBonfireMessage', { content, mentions: [...new Set(mentions)], connectionRevision: town.identity?.connectionRevision, requestId: sendRequest.requestId, ...(state.replyTo ? { replyTo: state.replyTo.id } : {}) }));
      } catch (error) {
        if (sameEpoch(requestEpoch)) {
          sendRequest.uncertain = !['VALIDATION', 'INVALID_REQUEST', 'AUTH_REQUIRED', 'NOT_SENT'].includes(error?.code);
          state.sendError = sendRequest.uncertain ? '发送结果待确认，草稿已保留。再次提交此草稿只核对原请求，不会重发。' : `${errorText(error)} 草稿已保留。`;
        }
        return;
      }
      if (!sameEpoch(requestEpoch)) return;
      if (result.ok !== true || result.status === 'uncertain') { sendRequest.uncertain = true; state.sendError = '发送结果待确认，草稿已保留。再次提交此草稿只核对原请求，不会重发。'; return; }
      if (state.sendRequest === sendRequest) { state.sendRequest = null; state.replyTo = null; }
      if (state.draft === content) { state.draft = ''; ui.bonfireDraft.value = ''; }
      state.sender = ''; state.mentionClosed = true;
      try { await options.onBonfireSent?.(result); }
      catch {
        // A confirmed publication must not become a send failure when progress cannot be updated.
        if (sameEpoch(requestEpoch)) setNotice(ui.notice, '消息已发送，新手引导进度暂未更新。可以在设置中继续引导。', true);
      }
      if (!sameEpoch(requestEpoch)) return;
      try { if (visibleModule('bonfire')) await requestReadOnce(); }
      catch {
        if (sameEpoch(requestEpoch)) state.error = '消息已发送，暂时无法刷新篝火。可以稍后刷新显示。';
      }
    } finally { if (sameEpoch(requestEpoch)) { busy.delete('bonfire-send'); renderBonfire(); } }
  }

  function clearPrivate({ preserveDraft = false } = {}) {
    if (ui.pairCode) ui.pairCode.value = '';
    if (ui.pairNotice) setNotice(ui.pairNotice, '');
    epoch += 1; roomRequest += 1; roomSelection += 1;
    townReads.clear();
    channelRequest += 1; busy.delete('channel-status'); busy.delete('channel-connect');
    model.fireside.rooms = []; model.fireside.selected = ''; model.fireside.messages = []; model.fireside.members = [];
    if (!preserveDraft) model.fireside.drafts.clear();
    if (!preserveDraft) model.bonfire.sendRequest = null;
    model.fireside.deliveries = []; model.fireside.error = ''; model.fireside.messageError = ''; model.fireside.roomError = ''; model.fireside.status = 'idle'; model.fireside.refresh = {}; model.fireside.latestSeq = null;
    model.channel.status = 'unknown'; model.channel.detail = ''; model.channel.qr = ''; model.channel.wizard = false;
    Object.assign(model.bonfire, { messages: [], members: [], status: 'idle', error: '', memberError: '', sendError: '', sender: '', latestSeq: null, refresh: {}, mentionClosed: true });
    if (!preserveDraft) { model.bonfire.draft = ''; if (ui.bonfireDraft) ui.bonfireDraft.value = ''; }
    if (ui.roomDraft && !preserveDraft) ui.roomDraft.value = '';
    if (ui.roomDialog) { ui.roomDialog.replaceChildren(); ui.roomDialog.hidden = true; }
    town = { access: {}, identity: {} };
    townRevision += 1;
    model.portal.confirm = false;
    busy.delete('room');
  }

  function acceptTownState(next) {
    if (JSON.stringify(next) === JSON.stringify(town)) return;
    const previousId = beingId();
    const nextId = string(next.identity?.beingId);
    const nextAccess = next.access?.fireside;
    const previousRevision = town.identity?.connectionRevision;
    const nextRevision = next.identity?.connectionRevision;
    const previousIdentity = town.identity?.identityRevision;
    const nextIdentity = next.identity?.identityRevision;
    const comparableIdentity = Number.isSafeInteger(previousIdentity) && Number.isSafeInteger(nextIdentity);
    const changedIdentity = comparableIdentity ? previousIdentity !== nextIdentity : Boolean(previousId && nextId && nextId !== previousId);
    if (changedIdentity) clearPrivate();
    else if ((Number.isSafeInteger(previousRevision) && previousRevision !== nextRevision) || (can('fireside') && nextAccess !== 'ready' && nextAccess?.status !== 'ready')) clearPrivate({ preserveDraft: true });
    town = next;
    townRevision += 1;
  }

  async function loadTownState() {
    const requestEpoch = epoch;
    const channelSelectionRequest = channelRequest;
    const revision = townRevision;
    const route = navigation;
    try {
      const result = record(await call('getTownAppState'));
      if (!sameEpoch(requestEpoch) || revision !== townRevision) return;
      acceptTownState(result);
      if (channelSelectionRequest === channelRequest && result.channel?.channel === model.channel.selected) applyChannelResult(result.channel);
    } catch (error) { if (sameEpoch(requestEpoch) && activeRoute(route)) setNotice(ui.notice, errorText(error), true); }
  }

  function renderCurrent() {
    renderTownPairing();
    if (!root || root.hidden) return;
    ui.readOnce.disabled = !connected() || townReads.has(townReadKey());
    text(ui.readOnce, townReads.has(townReadKey()) ? '正在请求…' : '立即同步');
    if (current === 'grove') renderGrove();
    if (current === 'channel') renderChannel();
    if (current === 'portal') renderPortal();
    if (current === 'fireside') renderFireside();
    if (current === 'bonfire') renderBonfire();
    if (current === 'inbox') renderInbox();
  }

  function setState(next) {
    if (!next || typeof next !== 'object') return;
    window.beingTownLibrary?.setState(next);
    const connection = record(next.connection);
    const nextTown = next.townApp || next.town;
    const identityRevision = nextTown?.identity?.identityRevision;
    const key = Number.isSafeInteger(identityRevision)
      ? JSON.stringify(['identity', identityRevision])
      : JSON.stringify(['target', connection.displayUrl || '', connection.beingName || '']);
    const previousStatus = publicState.connection?.status;
    const previousPortal = JSON.stringify(publicState.portal);
    const previousWorkspace = publicState.workspace?.path;
    const changed = key !== identityKey;
    if (changed) { clearPrivate(); identityKey = key; }
    else if (previousStatus === 'connected' && connection.status !== 'connected') clearPrivate({ preserveDraft: true });
    publicState = next;
    if (nextTown && typeof nextTown === 'object') acceptTownState(nextTown);
    if (previousWorkspace !== next.workspace?.path) model.portal.confirm = false;
    if (!busy.has('deploy') && previousPortal !== JSON.stringify(next.portal)) { model.portal.status = ''; model.portal.detail = ''; }
    const fingerprint = JSON.stringify([key, connection.status, next.workspace?.path, next.machine?.hostname, next.portal, town]);
    if (fingerprint !== lastPublicRender) { lastPublicRender = fingerprint; renderCurrent(); }
    if (root && changed) void loadTownState().then(renderCurrent);
  }

  async function requestReadOnce({ includeRooms = false } = {}) {
    if (!['bonfire', 'fireside'].includes(current) || !connected()) return;
    const page = current;
    const firesideId = page === 'fireside' ? model.fireside.selected : '';
    const request = firesideId ? { kind: page, firesideId } : { kind: page };
    if (page === 'fireside') request.selectionRevision = roomSelection;
    if (page === 'fireside' && firesideId && includeRooms) request.includeRooms = true;
    const route = navigation;
    const requestEpoch = epoch;
    const key = townReadKey();
    const selection = roomSelection;
    const isCurrent = () => sameEpoch(requestEpoch) && activeRoute(route) && current === page && (page !== 'fireside' || model.fireside.selected === firesideId && roomSelection === selection);
    let pending = townReads.get(key);
    if (!pending) { pending = call('requestTownRead', request); townReads.set(key, pending); }
    setNotice(ui.notice, '');
    renderCurrent();
    try {
      const result = await pending;
      if (!isCurrent()) return;
      acceptTownMessages(result);
      if (page === 'fireside') {
        await loadRooms();
        if (result?.removed === true) {
          if (sameEpoch(requestEpoch) && activeRoute(route) && current === page && !model.fireside.selected) setNotice(ui.notice, '围炉目录已更新，请重新选择围炉。');
          return;
        }
        if (isCurrent() && firesideId) await selectRoom(firesideId);
      } else await loadBonfire();
      if (isCurrent()) setNotice(ui.notice, '');
    } catch (error) {
      if (isCurrent()) setNotice(ui.notice, refreshErrors[error?.code] || errorText(error), !['REQUEST_ACCEPTED', 'BUSY'].includes(error?.code));
    } finally {
      if (townReads.get(key) === pending) townReads.delete(key);
      renderCurrent();
    }
  }

  async function refresh() {
    if (libraryIds.has(current)) { await window.beingTownLibrary?.refresh(); return; }
    if (busy.has('refresh')) return;
    const route = navigation;
    const page = current;
    const revision = townRevision;
    const requestEpoch = epoch;
    busy.add('refresh'); ui.refresh.disabled = true; setNotice(ui.notice, '');
    try {
      const result = record(await call('refreshTownApp'));
      if (!sameEpoch(requestEpoch)) return;
      if (revision === townRevision) acceptTownState(result);
      if (!activeRoute(route)) return;
      if (page === 'grove') await loadGrove();
      if (page === 'fireside') { await loadRooms(); if (activeRoute(route) && model.fireside.selected) await selectRoom(model.fireside.selected, { manual: true }); }
      if (page === 'bonfire') await loadBonfire(true);
      if (page === 'channel') await checkChannel();
      if (page === 'inbox') await loadInbox();
    } catch (error) { if (sameEpoch(requestEpoch) && activeRoute(route)) setNotice(ui.notice, errorText(error), true); }
    finally { busy.delete('refresh'); ui.refresh.disabled = false; renderCurrent(); }
  }


  function buildInbox() {
    const page = ui.inboxPage = node('section', 'ta-module ta-inbox');
    page.setAttribute('aria-label', 'Town 私信');
    const center = node('div', 'ta-room-center');
    ui.inboxMessages = node('div', 'ta-room-messages'); ui.inboxMessages.id = 'inbox-messages';
    ui.inboxMessages.setAttribute('role', 'log'); ui.inboxMessages.setAttribute('aria-label', '私信'); ui.inboxMessages.setAttribute('aria-live', 'polite');
    ui.inboxReply = node('div', 'ta-reply-slot');

    const composer = node('div', 'ta-composer ta-inbox-composer');
    ui.inboxRecipient = node('input', 'ta-input ta-inbox-recipient'); ui.inboxRecipient.id = 'inbox-recipient';
    ui.inboxRecipient.type = 'text'; ui.inboxRecipient.maxLength = 100;
    ui.inboxRecipient.placeholder = '收件人：being_id 或展示名';
    ui.inboxRecipient.setAttribute('aria-label', '私信收件人');
    ui.inboxRecipient.addEventListener('input', () => { model.inbox.recipient = ui.inboxRecipient.value; renderInboxComposer(); });

    ui.inboxDraft = node('textarea', 'ta-input'); ui.inboxDraft.id = 'inbox-draft'; ui.inboxDraft.rows = 2; ui.inboxDraft.maxLength = 32000;
    ui.inboxDraft.placeholder = '写一条私信…'; ui.inboxDraft.setAttribute('aria-label', '私信草稿');
    ui.inboxDraft.addEventListener('input', () => { model.inbox.draft = ui.inboxDraft.value; renderInboxComposer(); });
    ui.inboxDraft.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!ui.inboxSend.disabled) void sendInboxMessage(); }
    });
    ui.inboxSend = button('发送私信', () => void sendInboxMessage(), 'ta-secondary is-send', 'inbox-send');
    ui.inboxFeedback = node('p', 'ta-notice'); ui.inboxFeedback.setAttribute('role', 'status'); ui.inboxFeedback.hidden = true;
    append(composer, ui.inboxRecipient, ui.inboxDraft, append(node('div', 'ta-inbox-actions'), ui.inboxSend));

    append(center, ui.inboxMessages, ui.inboxReply, composer, ui.inboxFeedback);
    append(page, center); ui.content.append(page);
  }

  function renderInbox() {
    const state = model.inbox;
    if (!ui.inboxMessages) return;
    ui.inboxMessages.replaceChildren();
    if (!connected()) ui.inboxMessages.append(message('连接 Being 后查看私信', ''));
    else if (!record(town.client).paired) ui.inboxMessages.append(message('私信需要配对 Town', '私信只能通过配对的客户端读取和发送，请先在设置里配对。'));
    else if (state.status === 'loading' && !state.messages.length) ui.inboxMessages.append(message('正在读取私信', ''));
    else if (state.error && !state.messages.length) ui.inboxMessages.append(message('私信尚未同步', state.error));
    else if (!state.messages.length) ui.inboxMessages.append(message('还没有收到私信', ''));
    for (const entry of connected() ? state.messages : []) {
      const time = entry.createdAt ? new Date(entry.createdAt) : null;
      const timestamp = time && !Number.isNaN(time.getTime()) ? time.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const author = string(entry.senderName, string(entry.senderId, '未知'));
      const item = node('article', 'ta-message');
      append(item,
        append(node('div', 'ta-message-meta'), node('strong', '', author), viaBadge(entry), node('span', '', timestamp),
          canReply() ? replyButton(entry, startInboxReply) : null),
        replyQuote(entry),
        node('p', 'ta-message-body', string(entry.content)));
      ui.inboxMessages.append(item);
    }
    renderInboxComposer();
  }

  function renderInboxComposer() {
    const state = model.inbox;
    if (!ui.inboxSend) return;
    const paired = record(town.client).paired === true;
    if (!paired) state.replyTo = null;
    ui.inboxReply.replaceChildren();
    const banner = replyBanner(state.replyTo, () => { state.replyTo = null; renderInbox(); });
    if (banner) ui.inboxReply.append(banner);
    const pending = busy.has('inbox-send');
    // Replying sets the recipient in state; mirror it into the field without disturbing typing.
    if (ui.inboxRecipient.value !== state.recipient) ui.inboxRecipient.value = state.recipient;
    // Private messages have no Being-relay fallback: an unpaired profile cannot send them at all.
    ui.inboxRecipient.disabled = ui.inboxDraft.disabled = !connected() || !paired;
    ui.inboxSend.disabled = !connected() || !paired || pending || !state.recipient.trim() || !state.draft.trim();
    text(ui.inboxSend, pending ? '处理中…' : '发送私信');
    ui.inboxSend.setAttribute('aria-busy', String(pending));
    setNotice(ui.inboxFeedback, state.sendError, Boolean(state.sendError));
  }

  async function loadInbox() {
    const state = model.inbox;
    if (!connected() || !record(town.client).paired || busy.has('inbox-read')) return;
    const requestEpoch = epoch;
    busy.add('inbox-read'); state.status = 'loading'; if (visibleModule('inbox')) renderInbox();
    try {
      const result = record(await call('getDirectMessages'));
      if (!sameEpoch(requestEpoch)) return;
      state.messages = array(result.messages); state.error = ''; state.status = 'ready';
    } catch (error) {
      if (!sameEpoch(requestEpoch)) return;
      state.error = errorText(error); state.status = 'error';
    } finally {
      if (sameEpoch(requestEpoch)) { busy.delete('inbox-read'); if (visibleModule('inbox')) renderInbox(); }
    }
  }

  async function sendInboxMessage() {
    const state = model.inbox;
    const recipient = state.recipient.trim(), content = state.draft;
    if (!recipient || !content.trim() || busy.has('inbox-send') || !connected() || !record(town.client).paired) return;
    const requestEpoch = epoch;
    busy.add('inbox-send'); state.sendError = ''; renderInboxComposer();
    try {
      const result = record(await call('sendDirectMessage', { recipient, content, ...(state.replyTo ? { replyTo: state.replyTo.id } : {}) }));
      if (!sameEpoch(requestEpoch)) return;
      if (result.ok !== true) { state.sendError = '发送结果待确认，草稿已保留。刷新后核对再决定是否重发。'; return; }
      state.draft = ''; state.replyTo = null; ui.inboxDraft.value = '';
      await loadInbox();
    } catch (error) {
      if (!sameEpoch(requestEpoch)) return;
      // Only an explicit pre-send rejection is safe to describe as "not sent".
      state.sendError = ['INVALID_REQUEST', 'AUTH_REQUIRED', 'NOT_SENT'].includes(error?.code)
        ? `${errorText(error)} 草稿已保留。`
        : '发送结果待确认，草稿已保留。刷新后核对再决定是否重发。';
    } finally { if (sameEpoch(requestEpoch)) { busy.delete('inbox-send'); renderInboxComposer(); } }
  }

  async function open(id, { requestRead = true } = {}) {
    if (!ids.has(id) || !root) return;
    const route = ++navigation;
    if (current !== id && ui.roomDialog) { ui.roomDialog.replaceChildren(); ui.roomDialog.hidden = true; model.fireside.dialog = ''; }
    current = id;
    window.beingTownLibrary?.hide();
    root.dataset.townModule = id;
    text(ui.heading, names[id]); text(ui.subtitle, id === 'bonfire' && !requestRead ? '向小镇的大家打个招呼。修改下方草稿，准备好后点击发送。' : subtitles[id]); visible(ui.subtitle, Boolean(subtitles[id])); setNotice(ui.notice, '');
    text(ui.refresh, ['bonfire', 'fireside'].includes(id) ? '刷新显示' : '刷新');
    visible(ui.readOnce, ['bonfire', 'fireside'].includes(id));
    for (const key of ids) if (ui[`${key}Page`]) visible(ui[`${key}Page`], key === id);
    visible(ui.refresh, !libraryIds.has(id));
    renderTownPairing();
    if (libraryIds.has(id)) { await window.beingTownLibrary?.open(id); return; }
    renderCurrent();
    const requestEpoch = epoch;
    const cachedMessages = id === 'bonfire' && connected() && beingId() ? readTownMessages('bonfire') : null;
    const cachedRooms = id === 'fireside' && connected() && beingId() ? loadRooms() : null;
    const cachedMembers = id === 'bonfire' && connected() && beingId() ? loadBonfireMembers() : null;
    const groveContent = id === 'grove' ? Promise.all([loadGrove(), model.grove.selected ? selectKit(model.grove.selected) : null]) : null;
    await loadTownState();
    if (!activeRoute(route) || !sameEpoch(requestEpoch)) return;
    renderCurrent();
    if (id === 'grove') await groveContent;
    if (id === 'fireside') {
      await (cachedRooms || loadRooms());
      if (!activeRoute(route) || !sameEpoch(requestEpoch)) return;
      if (model.fireside.selected) await selectRoom(model.fireside.selected, { readOnce: requestRead, includeRooms: true });
      else if (requestRead) await requestReadOnce();
    }
    if (id === 'inbox') await loadInbox();
    if (id === 'bonfire' && connected()) {
      const members = cachedMembers || loadBonfireMembers();
      await (cachedMessages || readTownMessages('bonfire'));
      if (!activeRoute(route) || !sameEpoch(requestEpoch)) return;
      await Promise.all([members, requestRead ? requestReadOnce() : null]);
    }
  }

  function startOnboardingGreeting() {
    if (!root) return Promise.resolve();
    const opening = open('bonfire', { requestRead: false });
    if (!model.bonfire.draft && !ui.bonfireDraft.value) {
      model.bonfire.draft = '大家好！我刚来到 Town，很高兴认识大家，期待在这里一起交流！';
      ui.bonfireDraft.value = model.bonfire.draft;
    }
    model.bonfire.mentionClosed = true;
    renderBonfireComposer();
    ui.bonfireDraft.focus({ preventScroll: true });
    return opening;
  }

  function init(config) {
    if (root) return;
    options = record(config); bridge = options.bridge;
    root = document.getElementById('page-town-app');
    if (!root) throw new Error('Town 应用容器不存在。');
    build();
    for (const id of ids) if (ui[`${id}Page`]) visible(ui[`${id}Page`], false);
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (current === 'fireside') renderMembers(); }).observe(root);
    if (typeof bridge.onTownMessages === 'function') messageSubscription = bridge.onTownMessages(acceptTownMessages);
    window.addEventListener('pagehide', () => { messageSubscription?.(); messageSubscription = null; window.beingTownLibrary?.hide(); }, { once: true });
    if (typeof MutationObserver === 'function') new MutationObserver(() => {
      if (root.hidden) window.beingTownLibrary?.hide();
      else renderCurrent();
    }).observe(root, { attributes: true, attributeFilter: ['hidden'] });
  }

  window.beingTownApp = Object.freeze({ init, setState, open, startOnboardingGreeting });
})();
