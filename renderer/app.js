'use strict';

const bridge = window.beingDesktop;
const $ = (id) => document.getElementById(id);
const initialState = {
  version: '0.1.0',
  machine: { hostname: '', user: '' },
  connection: { configured: false, displayUrl: '', beingName: '', status: 'disconnected', error: '', updatedAt: null },
  workspace: { path: '', files: [] },
  portal: { status: 'not_configured', health: 'unknown', executable: '', configPath: '', pid: null, owned: false, detail: '' },
  runtime: { status: 'unknown', error: '', checkedAt: null, configStatus: 'unknown', configError: '', configCheckedAt: null, model: '', provider: '', baseUrl: '', sideBySide: { configured: null, active: null }, activeStream: { active: null } },
  localProxy: { status: 'unknown', baseUrl: 'http://127.0.0.1:8317/v1' },
  activity: [],
  settings: { closeToTray: true, typography: { chatFontSize: 14, codeFontSize: 12 } },
};

let state = structuredClone(initialState);
let currentPage = 'chat';
let editingSession = null;
let featureTaskView=null;
const pageHistory = [{page: 'chat', feature: ''}];
let pageHistoryIndex = 0;
let inspectorVisible = false;
let sidebarVisible = true;
let currentFolder = '';
let listedWorkspace = '';
let fileRequest = 0;
let loadingFolderKey = '';
let viewFrame = null;
let lastView = '';
let toastTimer = null;
const pending = new Set();
const townFeatureIds = new Set(['scroll', 'bonfire', 'fireside', 'beings', 'portal', 'grove', 'ember', 'workspace', 'channel']);
const townRows = new Map();
const townSidebarButtons = new Map();
const townGroups = new Map();
const townCollapsedGroups = new Set();
let townCatalog = { status: 'loading', features: [], checkedAt: null, error: '' };
let townCatalogLoading = false;
let selectedTownFeature = '';
const nativeTownModules = new Set(['grove','channel','portal','fireside','bonfire','scroll','beings']);
let townBusyAction = '';
let typographyFeedback = { status: 'idle', message: '' };
let portalSelfTestRevision = 0;
const portalTestIdentity = value => JSON.stringify([value.connection?.configured, value.connection?.displayUrl, value.connection?.beingName, value.portal?.pid, value.portal?.owned, value.portal?.executable, value.portal?.configPath, value.portal?.health, value.portal?.connectionCurrent]);
let portalSetup = { status: 'idle', detail: '' };

function portalSetupIdentity(value = state) {
  return JSON.stringify([value.connection?.beingName, value.connection?.displayUrl, value.townApp?.identity?.identityRevision, value.townApp?.identity?.connectionRevision]);
}

const connectionNames = { disconnected: '已断开', connecting: '连接中', connected: '已连接', error: '连接失败' };
const portalNames = { not_configured: '未配置', stopped: '已停止', running: '运行中', external: '运行中（外部）', error: '状态异常' };
const portalStatusLabel = portal => portal.status === 'external' && !portal.pid ? '已有部署（未运行）' : portalNames[portal.status] || '状态未知';
const statusTone = (value) => ({ connected: 'good', healthy: 'good', ok: 'good', available: 'good', reachable: 'good', running: 'good', connecting: 'warning', external: 'warning', error: 'error', unhealthy: 'error', unavailable: 'error', unreachable: 'error' }[value] || 'unknown');
const text = (id, value) => {
  const target = $(id);
  if (target) target.textContent = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
};
const str = (value, fallback = '') => typeof value === 'string' && value.length ? value : fallback;
const basename = (path) => str(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
const booleanLabel = (value) => value === true ? '已开启' : value === false ? '已关闭' : '未知';
const booleanTone = (value) => value === true ? 'good' : 'unknown';

function icon(name, small = false) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  if (small) svg.classList.add('small');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = String(content);
  return node;
}

function setTone(id, tone) {
  const target = $(id);
  if (!target) return;
  target.classList.remove('tone-good', 'tone-warning', 'tone-error', 'tone-unknown');
  target.classList.add(`tone-${tone}`);
}

function setDot(id, tone) {
  const target = $(id);
  if (target) target.className = `status-dot ${tone}`;
}

function setValue(id, value, tone) {
  text(id, value);
  if (tone) setTone(id, tone);
}

function formattedTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function connectionLabel() {
  if (!state.connection.configured) return '尚未连接';
  return connectionNames[state.connection.status] || '状态未知';
}

function healthLabel(value) {
  if (['healthy', 'ok', 'connected'].includes(value)) return '已确认';
  if (['unhealthy', 'error', 'disconnected'].includes(value)) return '连接异常';
  return '待确认';
}

function proxyLabel(value) {
  if (['connected', 'healthy', 'ok', 'available', 'reachable', 'running'].includes(value)) return '本机 API 可达';
  if (['error', 'unhealthy', 'unavailable', 'unreachable', 'stopped', 'disconnected'].includes(value)) return '不可访问';
  return '未知';
}

function acceptState(next) {
  if (!next || typeof next !== 'object' || !next.connection) return;
  if (portalSetupIdentity(next) !== portalSetupIdentity()) portalSetup = { status: 'idle', detail: '' };
  if (portalTestIdentity(next) !== portalTestIdentity(state)) {
    portalSelfTestRevision++;
    $('portal-self-test-result').hidden = true;
  }
  const previousWorkspace = state.workspace.path;
  state = {
    ...initialState,
    ...next,
    machine: { ...initialState.machine, ...next.machine },
    connection: { ...initialState.connection, ...next.connection },
    workspace: { ...initialState.workspace, ...next.workspace },
    portal: { ...initialState.portal, ...next.portal },
    runtime: {
      ...initialState.runtime,
      ...next.runtime,
      sideBySide: { ...initialState.runtime.sideBySide, ...next.runtime?.sideBySide },
      activeStream: { ...initialState.runtime.activeStream, ...next.runtime?.activeStream },
    },
    localProxy: { ...initialState.localProxy, ...next.localProxy },
    settings: {
      ...initialState.settings,
      ...next.settings,
      typography: { ...initialState.settings.typography, ...next.settings?.typography },
    },
    activity: Array.isArray(next.activity) ? next.activity : [],
  };
  if (state.workspace.path !== previousWorkspace) {
    currentFolder = '';
    listedWorkspace = '';
    loadingFolderKey = '';
    fileRequest += 1;
  }
  render();
  window.beingOrchestration?.setState(state.orchestration);
  if (currentPage === 'workspace' && state.workspace.path && listedWorkspace !== state.workspace.path) {
    void loadFiles('');
  }
}

function render() {
  if (state.machine.platform) document.documentElement.dataset.platform = state.machine.platform;
  window.beingPortalUpdates?.setState(state.portalUpdate);
  window.beingPortalPermissions?.setState(state);
  window.beingThemeSettings?.setState(state);
  window.beingOnboarding?.setState(state);
  window.beingTownApp?.setState(state);
  window.beingModelSettings?.setState(state);
  const connection = state.connection;
  const portal = state.portal;
  const runtime = state.runtime;
  const name = str(connection.beingName, 'Being');
  const connected = connection.status === 'connected';
  const label = connectionLabel();
  const tone = connection.status === 'connecting' ? 'connecting' : statusTone(connection.status);
  text('sidebar-being-name', name);
  text('loom-being-name', name);
  document.body.classList.toggle('has-connection', connection.configured === true);
  if ($('active-session')) $('active-session').hidden = !connection.configured || Boolean(state.chatSessions?.items?.length);
  if ($('new-chat-session')) $('new-chat-session').disabled = !connected;
  const sessionList = $('chat-session-list');
  if ($('session-route-warning')) $('session-route-warning').hidden = !connection.configured || !state.chatSessions?.routingWarning;
  if (sessionList && (!editingSession || !connected)) {
    editingSession = null;
    sessionList.replaceChildren();
    for (const item of connection.configured ? state.chatSessions?.items || [] : []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-shortcut';
      button.classList.toggle('active', item.id === state.chatSessions.activeId);
      if (item.id === state.chatSessions.activeId) button.setAttribute('aria-current', 'page');
      const activity = state.chatSessionActivity?.[item.id];
      const activityLabel = activity === 'talking' ? '正在和 Being 通话' : activity === 'waiting' ? '消息等待' : '未激活';
      const dot = document.createElement('span');
      dot.className = `session-activity-light ${activity === 'talking' ? 'talking' : activity === 'waiting' ? 'waiting' : 'inactive'}`;
      // Keep the breathing phase continuous when state updates rebuild the list.
      dot.style.animationDelay = `-${(document.timeline.currentTime || 0) % 2400}ms`;
      dot.setAttribute('aria-hidden', 'true');
      const title = document.createElement('span');
      title.className = 'session-title';
      title.textContent = `${name} · ${item.title}`;
      button.append(dot, title);
      button.setAttribute('aria-label', `${name} · ${item.title}，${activityLabel}`);
      button.title = `${item.title} · ${activityLabel}\nSession ID: ${item.id}`;
      button.disabled = !connected;
      button.addEventListener('click', () => selectChatSession(item.id));
      button.addEventListener('contextmenu',async event=>{
        event.preventDefault();
        if(!connected)return;
        try {
          const choice=await bridge.showSessionMenu(item.id);
          if(choice==='rename') {
            const current=state.chatSessions?.items.find(session=>session.id===item.id);
            const target=[...sessionList.querySelectorAll('.session-shortcut')].find(node=>node.dataset.sessionId===item.id);
            if(current && target)renameChatSession(current,target);
          } else if(choice==='forget' && window.confirm(`删除会话「${item.title}」？Being 的记忆不受影响，只是本机不再显示这个视图。`)) {
            await bridge.chatForgetSession(item.id);
          }
        } catch(error){showToast(error.message);}
      });
      button.dataset.sessionId=item.id;
      sessionList.append(button);
      window.beingOrchestration?.appendSession(sessionList,item.id);
    }
  }
  if ($('session-empty')) $('session-empty').hidden = Boolean(connection.configured);
  renderPageContext();
  text('sidebar-status', label);
  text('footer-status', label);
  setDot('sidebar-status-dot', tone);
  setDot('footer-status-dot', tone);
  setDot('header-status-dot', tone);
  text('header-status-label', label);
  text('app-version', state.version);
  text('settings-version', state.version);
  text('settings-platform', state.machine.name || state.machine.platform || '');
  renderMachine();
  $('onboarding').hidden = connection.configured;
  $('loom-panel').hidden = !connection.configured;
  const nativeChat = state.settings?.chatMode !== 'loom';
  window.beingChat?.setState(state);
  if ($('loom-host')) $('loom-host').hidden = nativeChat && connection.configured;
  if ($('chat-mode')) $('chat-mode').value = nativeChat ? 'native' : 'loom';
  $('loom-placeholder').hidden = connected;
  $('loom-placeholder').classList.toggle('is-static', connection.status !== 'connecting');
  text('loom-placeholder-title', connection.status === 'connecting' ? `正在连接 ${name}` : connection.status === 'error' ? '连接暂时遇到了问题' : '对话已断开');
  text('loom-placeholder-detail', connection.status === 'error' ? str(connection.error, '请检查网络与 Loom 地址，再重新连接。') : connection.status === 'connecting' ? '正在打开现有 Loom 会话…' : '重新连接后，继续原来的会话。');
  $('reconnect-placeholder').hidden = connection.status === 'connecting';
  text('loom-status-label', label);
  setDot('loom-status-dot', tone);
  const workspaceName = basename(state.workspace.path);
  text('sidebar-workspace-name', workspaceName || '选择文件夹');
  text('sidebar-workspace-hint', state.workspace.path ? `${str(state.machine.hostname, '本机')} · 本机目录` : '尚未选择本机工作区');
  $('workspace-shortcut').title = state.workspace.path || '选择本机工作区';
  text('footer-workspace', state.workspace.path || '尚未选择工作区');
  $('footer-workspace').title = state.workspace.path || '';
  text('workspace-name', workspaceName || '工作区');
  text('workspace-path', state.workspace.path);
  $('workspace-selected').hidden = !state.workspace.path;
  $('workspace-empty').hidden = Boolean(state.workspace.path);

  setValue('settings-connection-status', label, statusTone(connection.status));
  $('settings-current-connection').hidden = !connection.configured;
  text('settings-connection-url', connection.displayUrl);
  setValue('settings-portal-status', portalStatusLabel(portal), statusTone(portal.status));
  text('portal-executable', str(portal.management === 'external' ? portal.observedExecutable || portal.deployment?.executable : portal.executable, '尚未确认'));
  text('portal-config', str(portal.management === 'external' ? portal.deployment?.configPath : portal.configPath, '尚未确认'));
  setValue('portal-process-detail', `${portalStatusLabel(portal)}${portal.pid ? ` · PID ${portal.pid}` : ''}`, statusTone(portal.status));
  setValue('portal-health-detail', portal.connectionCurrent === false ? '仍连接之前的 Being' : healthLabel(portal.health), portal.connectionCurrent === false ? 'warning' : statusTone(portal.health));
  text('portal-owner-detail', portal.owned ? '此 Portal 由桌面应用启动，可以在这里停止。' : portal.status === 'external' ? '沿用已有 Portal 部署，请在原启动位置管理。' : '应用只管理自己启动的 Portal 进程。');
  text('portal-detail', str(portal.detail));
  $('portal-detail').hidden = !portal.detail;
  text('portal-observed-path', portal.status === 'external' && portal.observedExecutable ? `程序位置：${portal.observedExecutable}` : '');
  $('portal-observed-path').hidden = !portal.observedExecutable || portal.status !== 'external';
  const watchdog = portal.watchdog;
  $('portal-watchdog-detail').hidden = !watchdog;
  text('portal-watchdog-detail', watchdog ? `${watchdog.detail}${watchdog.retryAt ? ` 下次重试：${new Date(watchdog.retryAt).toLocaleTimeString()}` : ''}` : '');
  const autoHealth = watchdog?.health;
  $('portal-auto-health').hidden = !autoHealth;
  if (autoHealth) {
    const names = {passed:'通过', failed:'未通过', unknown:'未确认', checking:'检查中'};
    text('portal-auto-health-summary', `自动健康检查 · ${names[autoHealth.status] || '未确认'}${autoHealth.checkedAt ? ` · ${new Date(autoHealth.checkedAt).toLocaleTimeString()}` : ''}`);
    text('portal-auto-health-result', formatPortalReport(autoHealth));
  }
  const logBox = $('portal-log-output');
  const followLogs = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 24;
  const logText = portal.status === 'external'
    ? '此 Portal 由外部程序管理，桌面端未接入它的日志。\n请在原启动位置查看日志；连接状态请参考上方健康检查。'
    : (portal.logs || []).map(item => `[${item.time}] ${item.level} · ${item.title}\n${item.detail}`).join('\n\n') || '暂无 Portal 日志。桌面端启动 Portal 后，日志会显示在这里。';
  if (logBox.textContent !== logText) {
    logBox.textContent = logText;
    if (followLogs) logBox.scrollTop = logBox.scrollHeight;
  }
  renderPortalSetup();
  renderConfiguration();
  renderSideBySide();
  $('close-to-tray').checked = state.settings.closeToTray === true;
  $('window-close')?.setAttribute('title', state.settings.closeToTray ? '关闭到托盘，不会暂停 Being' : '关闭桌面端，不会暂停 Being');
  renderInspector();
  renderButtons();
  renderTownAvailability();
  scheduleView();
}

function formatPortalReport(report) {
  const names = {passed:'通过', failed:'未通过', unknown:'未确认', checking:'检查中'};
  return [report.detail, ...(report.checks || []).map(check => `${check.label} · ${names[check.status] || '未确认'}\n${check.detail}`)].filter(Boolean).join('\n\n');
}

function renderSideBySide() {
  const { configured, active } = state.runtime.sideBySide;
  ['settings-sbs-configured', 'inspector-sbs-saved'].forEach((id) => setValue(id, booleanLabel(configured), booleanTone(configured)));
  ['settings-sbs-active', 'inspector-sbs-active'].forEach((id) => setValue(id, booleanLabel(active), booleanTone(active)));
  let note = '等待运行时确认。';
  if (typeof configured === 'boolean' && typeof active === 'boolean') {
    note = configured === active ? '保存的配置与运行状态一致。' : '保存的配置尚未在运行时生效。请在 Loom 确认重启要求。';
  } else if (typeof configured === 'boolean') {
    note = '已读取保存配置；当前是否生效，仍需运行时确认。';
  } else if (state.runtime.configStatus === 'error') {
    note = '配置读取失败，已保存的状态未知。运行状态仍需 Being 确认。';
  }
  text('settings-sbs-note', note);
  text('inspector-sbs-note', note);
}

function renderConfiguration() {
  const runtime = state.runtime;
  const available = runtime.configStatus === 'connected';
  const failed = runtime.configStatus === 'error';
  const unknownLabel = failed ? '配置读取失败' : '当前配置未知';
  text('settings-model', available ? str(runtime.model, '未提供模型名称') : unknownLabel);
  text('settings-provider', available ? str(runtime.provider, '未提供') : '未知');
  text('settings-model-url', available ? str(runtime.baseUrl, '未提供') : '未知');
  text('footer-model', available && runtime.model ? `模型配置 · ${runtime.model}` : unknownLabel);
  setValue('settings-config-status', available ? '已读取' : failed ? '读取失败' : '未知', available ? 'good' : failed ? 'error' : 'unknown');
  const checkTime = formattedTime(runtime.configCheckedAt);
  let detail = available ? (checkTime ? `配置检查于 ${checkTime}。` : '已读取 Being 当前报告的模型配置。') : failed ? str(runtime.configError, '无法读取 Being 的模型配置。请检查连接后刷新。') : '尚未读取当前模型配置，请连接 Being 后刷新状态。';
  if (failed && checkTime) detail = `配置检查于 ${checkTime}。${detail}`;
  text('settings-config-detail', detail);
  text('inspector-config-detail', detail);
  setTone('settings-config-detail', failed ? 'error' : 'unknown');
  setTone('inspector-config-detail', failed ? 'error' : 'unknown');
}

function renderMachine() {
  const hostname = str(state.machine.hostname, '尚未确认');
  const user = str(state.machine.user, '尚未确认');
  text('workspace-machine-name', hostname);
  text('workspace-machine-user', user);
  text('inspector-machine-name', hostname);
  text('inspector-machine-user', user);
  text('settings-machine-name', `${hostname} / ${user}`);
  let serviceHost = '尚未连接';
  if (state.connection.displayUrl) {
    try { serviceHost = new URL(state.connection.displayUrl).host; }
    catch { serviceHost = '入口地址已配置'; }
  }
  text('inspector-service-host', serviceHost);
}

function renderInspector() {
  const connection = state.connection;
  const runtime = state.runtime;
  const portal = state.portal;
  const hasStreamState = typeof runtime.activeStream.active === 'boolean';
  const processing = runtime.activeStream.active === true;
  const connected = connection.status === 'connected';
  const runtimeConnected = runtime.status === 'connected';
  let presenceTitle = '尚未连接';
  let presenceDetail = '连接 Loom 后查看运行状态。';
  if (connection.status === 'connecting') {
    presenceTitle = '正在连接';
    presenceDetail = '正在连接已有会话，等待 Loom 就绪。';
  } else if (connection.status === 'error') {
    presenceTitle = '连接需要恢复';
    presenceDetail = '请检查连接状态。重连不会自动重发消息。';
  } else if (connected && runtimeConnected && processing) {
    presenceTitle = '正在处理消息';
    presenceDetail = '运行时报告有活动响应。下方可查看当前会话已发送的消息和待发队列。';
  } else if (connected && runtimeConnected && hasStreamState) {
    presenceTitle = 'Being 已连接';
    presenceDetail = '已连接 Being，目前没有活动响应。';
  } else if (connected) {
    presenceTitle = 'Loom 已连接';
    presenceDetail = runtimeConnected ? '运行时可访问，消息处理状态尚未确认。' : '对话界面已打开，运行时状态仍待确认。';
  } else if (connection.configured) {
    presenceTitle = '连接暂时断开';
    presenceDetail = '重新连接，即可返回原来的 Loom 会话。';
  }
  text('presence-title', presenceTitle);
  text('presence-detail', presenceDetail);
  text('presence-runtime', runtimeConnected ? '运行时已连接' : runtime.status === 'error' ? '运行时连接异常' : '运行时未知');
  setDot('presence-dot', statusTone(runtime.status));
  setValue('inspector-loom', connectionLabel(), statusTone(connection.status));
  setValue('inspector-runtime', runtimeConnected ? '已连接' : runtime.status === 'error' ? '连接异常' : '未知', statusTone(runtime.status));
  setValue('inspector-stream', processing ? '正在响应' : hasStreamState ? '无活动响应' : '未知', processing ? 'good' : 'unknown');
  const connectionError = str(connection.error) || str(runtime.error);
  text('inspector-connection-error', connectionError);
  $('inspector-connection-error').hidden = !connectionError;
  setValue('inspector-portal', portalStatusLabel(portal), portal.status === 'running' ? 'good' : statusTone(portal.status));
  setValue('inspector-health', healthLabel(portal.health), statusTone(portal.health));
  text('inspector-portal-note', portal.status === 'running' ? `进程${portal.pid ? ` ${portal.pid}` : ''}由桌面管理。工具连接以健康状态为准。` : portal.status === 'external' ? '已有外部部署，桌面应用不会接管其启停。' : portal.detail || '选择 Portal 程序与配置后，可以在此管理。');
  text('inspector-model', runtime.configStatus === 'connected' ? str(runtime.model, '未提供模型名称') : runtime.configStatus === 'error' ? '配置读取失败' : '当前配置未知');
  text('inspector-provider', runtime.configStatus === 'connected' ? str(runtime.provider, '未提供') : '未知');
  setValue('inspector-proxy', proxyLabel(state.localProxy.status), statusTone(state.localProxy.status));
  const updated = formattedTime(runtime.checkedAt);
  text('last-updated', updated ? `更新于 ${updated}` : '等待首次更新');
  renderActivity();
  renderMessageQueue();
}

function renderMessageQueue() {
  const host = $('message-task-queue');
  if (!host) return;
  if (state.connection.status !== 'connected') {
    host.replaceChildren(element('p', 'section-note', '正在等待当前会话的队列状态。'));
    return;
  }
  const queue = state.messageQueue;
  const active = state.runtime.activeStream;
  const phases = {awaiting_first:'等待首个响应事件', reasoning:'正在思考', tool:'正在调用工具', text:'正在输出回复', working:'工具已返回，继续处理', continuing:'本轮回复已输出，等待后续事件', error:'运行时报告错误'};
  const nodes = [];
  const pending = queue?.pending || [];
  const accepted = pending.filter(item => item.status === 'accepted');
  if (active.active === true && !pending.some(item => item.streamId && item.streamId === active.id)) {
    const card = element('div', 'message-task-card');
    card.append(element('strong', '', `运行时 · ${phases[active.phase] || '正在响应'}`));
    if (active.tool) card.append(element('p', '', active.tool));
    if (active.id) card.append(element('small', 'section-note', `流 ${active.id}`));
    card.append(element('p', 'section-note', '该响应尚未关联到本页发送的消息。'));
    nodes.push(card);
  }
  for (const item of pending.filter(item => item.status !== 'accepted')) {
    const card = element('div', 'message-task-card');
    const status = {sending:'正在发送', waiting:'已发送 · 等待运行时响应', interrupted:'连接中断 · 执行结果待确认', error:'运行时报告错误'};
    card.append(element('strong', '', item.status === 'responding' ? phases[item.phase] || '正在响应' : status[item.status] || '等待回复'));
    card.append(element('p', '', str(item.text, '附件消息')));
    if (item.tool) card.append(element('small', 'section-note', `工具：${item.tool}`));
    if (item.streamId) card.append(element('small', 'section-note', `流 ${item.streamId}`));
    const time = formattedTime(item.startedAt);
    if (time) card.append(element('small', 'section-note', `发送于 ${time}`));
    nodes.push(card);
  }
  if (!nodes.length) nodes.push(element('p', 'section-note', active.active === false ? '运行时当前没有活动响应。' : '运行时状态尚未确认。'));
  if (accepted.length) {
    nodes.push(element('p', 'section-note', `服务端已接收 · ${accepted.length} 条待确认`));
    for (const [index, item] of accepted.entries()) {
      const card = element('div', 'message-task-card');
      card.append(element('strong', '', `已接收 ${index + 1} · 处理结果未确认`));
      card.append(element('p', '', str(item.text, '附件消息')));
      const time = formattedTime(item.startedAt);
      if (time) card.append(element('small', 'section-note', `发送于 ${time}`));
      nodes.push(card);
    }
    nodes.push(element('p', 'section-note', '服务端尚未逐条确认开始或完成；以上按发送顺序排列。'));
  }
  nodes.push(element('p', 'section-note', queue?.queueKnown ? `本地待发 · ${queue.queued.length} 条` : '本地待发队列未知'));
  for (const [index, item] of (queue?.queued || []).entries()) {
    const card = element('div', 'message-task-card');
    card.append(element('strong', '', `排队 ${index + 1}${index === 0 ? ' · 下一条' : ''}`));
    card.append(element('p', '', str(item.text, '附件消息')));
    if (item.attachments) card.append(element('small', 'section-note', `${item.attachments} 个附件`));
    nodes.push(card);
  }
  host.replaceChildren(...nodes);
}

function renderActivity() {
  const activities = [...state.activity].sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0)).slice(0, 8);
  text('activity-count', state.activity.length);
  const list = $('activity-list');
  if (!activities.length) {
    list.replaceChildren(element('p', 'section-note', '还没有桌面活动。'));
    return;
  }
  const nodes = activities.map((entry) => {
    const level = ['error', 'warning'].includes(entry.level) ? entry.level : 'info';
    const item = element('div', `activity-item ${level}`);
    item.append(element('p', 'activity-item-title', str(entry.title, '桌面活动')));
    if (entry.detail) item.append(element('p', 'activity-item-detail', str(entry.detail)));
    const time = formattedTime(entry.time);
    if (time) item.append(element('time', 'activity-item-time', time));
    return item;
  });
  list.replaceChildren(...nodes);
}

function renderButtons() {
  const connecting = pending.has('connect') || pending.has('reconnect') || state.connection.status === 'connecting';
  ['onboarding-connect', 'settings-connect', 'settings-reconnect', 'reconnect-inline', 'reconnect-placeholder'].forEach((id) => { $(id).disabled = connecting; });
  text('settings-connect', pending.has('connect') ? '正在连接…' : '保存并连接');
  if ($('onboarding-connect')?.firstElementChild) $('onboarding-connect').firstElementChild.textContent = pending.has('connect') ? '正在连接…' : '连接 Being';
  $('settings-disconnect').disabled = pending.has('disconnect') || state.connection.status === 'disconnected';
  ['refresh-state', 'inspector-refresh'].forEach((id) => {
    $(id).disabled = pending.has('refresh');
    $(id).classList.toggle('is-busy', pending.has('refresh'));
    $(id).setAttribute('aria-busy', String(pending.has('refresh')));
  });
  const portalBusy = pending.has('startPortal') || pending.has('stopPortal') || pending.has('deployPortal') || state.townApp?.portalInstall?.status === 'installing';
  $('test-portal-connection').disabled = portalBusy || pending.has('testPortalConnection');
  text('test-portal-connection', pending.has('testPortalConnection') ? '自测中…' : '连接自测');
  $('start-portal').disabled = portalBusy || state.portal.management === 'external' || state.portal.owned || !state.portal.executable || !state.portal.configPath || ['running', 'external'].includes(state.portal.status);
  $('stop-portal').disabled = portalBusy || !state.portal.owned || !state.portal.pid;
  text('start-portal', pending.has('startPortal') ? '启动中…' : '启动');
  text('stop-portal', pending.has('stopPortal') ? '停止中…' : '停止');
  $('select-portal-executable').disabled = portalBusy || state.portal.owned || (state.portal.management === 'external' || state.portal.status === 'external');
  $('select-portal-config').disabled = portalBusy || state.portal.owned || (state.portal.management === 'external' || state.portal.status === 'external');
  renderPortalSetup();
  $('close-to-tray').disabled = pending.has('setCloseToTray');
  $('export-diagnostics').disabled = pending.has('exportDiagnostics');
  ['sidebar-select-workspace', 'workspace-select', 'workspace-empty-select'].forEach((id) => { $(id).disabled = pending.has('selectWorkspace'); });
  $('workspace-open').disabled = !state.workspace.path || pending.has('openWorkspace');
  $('back-to-loom').disabled = !state.connection.configured;
  renderTypographyControls();
}

function renderPortalSetup() {
  const button = $('portal-setup');
  if (!button) return;
  const portal = state.portal;
  const installation = state.townApp?.portalInstall || {};
  const busy = pending.has('deployPortal') || installation.status === 'installing';
  const connected = state.connection.status === 'connected';
  const existing = Boolean(portal.executable || portal.configPath);
  const running = portal.owned || portal.status === 'running';
  const failed = portalSetup.status === 'error' || installation.status === 'error';
  const workspace = state.townApp?.portalWorkspace?.path || '';
  const readOnly = state.townApp?.portalWorkspace?.readOnly || portal.status === 'external';
  const phases = { checking: '正在检查安装包…', download: '正在下载官方程序…', hash: '正在校验文件…', install: '正在安装程序…', starting: '正在连接 Being…' };
  button.hidden = (existing || portal.status === 'external') && !busy && !failed;
  button.disabled = busy || !connected || running || portal.status === 'external' || state.townApp?.platformSupported === false || !workspace || pending.has('startPortal') || pending.has('stopPortal');
  button.textContent = busy ? '连接中…' : failed ? '重试' : '连接';
  $('portal-settings').setAttribute('aria-busy', String(busy));
  $('portal-setup-workspace').closest('.path-setting').hidden = false;
  $('portal-setup-workspace-note').closest('details').hidden = portal.status === 'external';
  document.querySelector('.portal-setup-heading h4').textContent = portal.status === 'external' ? '已有 Portal' : '连接这台电脑';
  text('portal-setup-workspace', workspace || (readOnly ? '尚未确认，请核对原配置' : '正在读取默认文件夹…'));
  text('portal-setup-workspace-note', readOnly ? '沿用已部署 Portal 的工作区，Desktop 项目选择独立保存。' : '部署时创建专用工作区；与 Desktop 项目目录分别保存。');
  $('portal-setup-choose-workspace').disabled = busy || running || readOnly || pending.has('selectPortalWorkspace');
  const progress = $('portal-setup-progress');
  progress.hidden = !busy;
  if (busy && installation.phase === 'download' && Number.isFinite(installation.totalBytes) && installation.totalBytes > 0) {
    progress.max = installation.totalBytes;
    progress.value = Math.max(0, Math.min(installation.totalBytes, Number(installation.receivedBytes) || 0));
  } else progress.removeAttribute('value');
  let detail;
  if (busy) detail = phases[installation.phase] || '正在准备工作区和 Portal 配置…';
  else if (portal.status === 'external') detail = portal.pid ? '已检测到外部 Portal，工作区与权限沿用其原有配置，请在原启动位置管理。' : '已有 Portal 部署当前未运行；沿用原配置，请由原启动方式恢复。';
  else if (!connected) detail = '先连接 Being，等待会话加载完成。';
  else if (state.townApp?.platformSupported === false) detail = '当前平台暂无已校验的 Portal 安装包。';
  else if (running && portal.connectionCurrent === false) detail = `Portal 仍连接 ${portal.connectionBeingName || '之前的 Being'}。先停止 Portal，再启动以连接当前 Being。`;
  else if (running) detail = ['connected', 'healthy', 'ok'].includes(portal.health) ? '配置已完成，Portal 已连接。' : portal.health === 'disconnected' ? 'Portal 连接中断，可等待重连或请 Being 协助。' : 'Portal 已启动，正在等待连接确认。';
  else if (failed) detail = portalSetup.detail || installation.detail || '配置未完成，请重试或请 Being 协助。';
  else if (existing) detail = '已保留现有程序与配置，可点击下方「启动 Portal」。';
  else detail = '点击一次即可完成下载、配置和连接。';
  text('portal-setup-status', detail);
  $('portal-setup-status').hidden = !busy && !failed && connected && state.townApp?.platformSupported !== false && portal.status !== 'external' && !(running && (portal.connectionCurrent === false || !['connected', 'healthy', 'ok'].includes(portal.health)));
  setTone('portal-setup-status', failed && !busy && !running ? 'error' : 'unknown');
  $('portal-setup-assist').disabled = !connected || busy || pending.has('prepareTownAssistance');
}

async function setupPortal() {
  if ($('portal-setup').disabled || pending.has('deployPortal')) return;
  const identity = portalSetupIdentity();
  portalSetup = { status: 'installing', detail: '' };
  const result = await perform('deployPortal', { confirmed: true, permissions: { files: true, exec: false, web: false } });
  if (identity !== portalSetupIdentity()) return;
  portalSetup = result.ok
    ? { status: result.value?.status || 'ready', detail: result.value?.detail || '' }
    : { status: 'error', detail: result.error || '配置未完成，请重试。' };
  if (result.ok) await perform('getState');
  renderPortalSetup();
}

async function askBeingAboutPortal() {
  if ($('portal-setup-assist').disabled) return;
  const identity = portalSetupIdentity();
  const result = await perform('prepareTownAssistance', { operation: 'portal-setup' });
  if (result.ok && identity === portalSetupIdentity()) {
    changePage('chat');
    showToast('已准备 Portal 协助草稿，可补充错误后发送。');
  }
}

function renderTypographyControls() {
  const typography = state.settings.typography;
  const busy = pending.has('setTypography');
  const chatSize = [14, 15, 16].includes(typography.chatFontSize) ? typography.chatFontSize : 14;
  const codeSize = [12, 13, 14].includes(typography.codeFontSize) ? typography.codeFontSize : 12;
  if (!busy) {
    if ($('reading-chat-size')) $('reading-chat-size').value = String(chatSize);
    if ($('reading-code-size')) $('reading-code-size').value = String(codeSize);
  }
  ['reading-chat-size', 'reading-code-size'].forEach((id) => { if ($(id)) $(id).disabled = busy; });
  if ($('reading-reset')) $('reading-reset').disabled = busy || (chatSize === 14 && codeSize === 12);
  $('reading-settings')?.setAttribute('aria-busy', String(busy));
  text('reading-status', busy ? '正在保存字号…' : typographyFeedback.message || '选择后立即保存，仅影响桌面显示。');
  setTone('reading-status', typographyFeedback.status === 'error' ? 'error' : 'unknown');
}

async function saveTypography(typography) {
  if (pending.has('setTypography')) return;
  typographyFeedback = { status: 'saving', message: '正在保存字号…' };
  const result = await perform('setTypography', typography);
  typographyFeedback = result.ok
    ? { status: 'saved', message: '已保存阅读字号，仅影响桌面显示。' }
    : { status: 'error', message: str(result.error, '字号未能保存，请重试。') };
  renderTypographyControls();
}

function renderPageContext() {
  const name = str(state.connection.beingName, 'Being');
  const titles = {
    chat: state.connection.configured ? name : '对话',
    workspace: basename(state.workspace.path) || '本机工作区',
    town: 'Town 功能',
    tasks: '功能任务',
    workers: 'Worker 执行详情',
    'town-app': {grove:'工具市场 · Grove',channel:'消息渠道 · Channel',portal:'设备连接 · Portal',fireside:'围炉 · Fireside',bonfire:'篝火 · Bonfire',scroll:'卷轴 · Scroll',beings:'居民名录 · Beings'}[selectedTownFeature] || 'Town',
    settings: '设置',
  };
  text('page-title', titles[currentPage]);
  if ($('page-title')) $('page-title').title = titles[currentPage];
  $('page-context-icon')?.setAttribute('href', `#i-${{chat: 'chat', workspace: 'folder', town: 'panel', tasks:'check', workers:'cpu', 'town-app': 'panel', settings: 'settings'}[currentPage]}`);
  text('page-eyebrow', '');
  text('titlebar-caption', currentPage === 'workspace' && state.workspace.path ? '本机工作区' : '');
  const session = $('active-session');
  if (session) {
    session.classList.toggle('active', currentPage === 'chat');
    if (currentPage === 'chat') session.setAttribute('aria-current', 'page');
    else session.removeAttribute('aria-current');
  }
  document.body.dataset.page = currentPage;
  renderTownSelection();
}

function changePage(page, {recordHistory = true} = {}) {
  if (!['chat', 'workspace', 'town', 'town-app', 'tasks', 'workers', 'settings'].includes(page)) return;
  if (page === 'settings' && currentPage !== 'settings') {
    settingsReturnPage = currentPage;
    window.beingTools?.hide();
  }
  const destination = {page, feature: ['town', 'town-app'].includes(page) ? selectedTownFeature : ''};
  const previous = pageHistory[pageHistoryIndex];
  if (recordHistory && (previous.page !== destination.page || previous.feature !== destination.feature)) {
    pageHistory.splice(pageHistoryIndex + 1);
    pageHistory.push(destination);
    if (pageHistory.length > 100) pageHistory.shift();
    pageHistoryIndex = pageHistory.length - 1;
  }
  currentPage = page;
  renderNavigation();
  renderPageContext();
  document.querySelectorAll('.page').forEach((section) => { section.hidden = section.id !== `page-${page}`; });
  document.querySelectorAll('button[data-page]').forEach((button) => {
    const selected = button.dataset.page === page || (page === 'town-app' && button.dataset.page === 'town');
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (page === 'workspace' && state.workspace.path && listedWorkspace !== state.workspace.path) void loadFiles(currentFolder);
  if (page === 'settings') window.beingModelSettings?.activate();
  if (page === 'tasks') void featureTaskView?.refresh();
  scheduleView();
}

function renderNavigation() {
  if ($('navigate-back')) $('navigate-back').disabled = pageHistoryIndex === 0;
  if ($('navigate-forward')) $('navigate-forward').disabled = pageHistoryIndex === pageHistory.length - 1;
}

function navigateHistory(direction) {
  const index = pageHistoryIndex + direction;
  if (index < 0 || index >= pageHistory.length) return;
  pageHistoryIndex = index;
  const destination = pageHistory[index];
  selectedTownFeature = destination.feature;
  window.beingTools?.hide();
  changePage(destination.page, {recordHistory: false});
  if (destination.page === 'town-app') window.beingTownApp?.open(destination.feature);
  if (destination.page === 'town' && townRows.has(destination.feature)) {
    $('town-search').value = '';
    filterTownCatalog();
    scrollWithinPage($('page-town'), townRows.get(destination.feature).row);
  }
}

function renderWindowState(value) {
  const root = document.documentElement;
  if (value?.platform) root.dataset.platform = value.platform;
  if (root.dataset.platform === 'darwin') {
    for (const target of document.querySelectorAll('[title*="Ctrl+"]')) target.title = target.title.replaceAll('Ctrl+', '⌘');
  }
  root.dataset.windowFocused = String(value?.focused !== false);
  root.dataset.fullscreen = String(value?.fullscreen === true);
  root.dataset.reducedTransparency = String(value?.reducedTransparency === true);
  root.dataset.highContrast = String(value?.highContrast === true);
  const maximized = value?.maximized === true;
  const button = $('window-maximize');
  if (!button) return;
  button.setAttribute('aria-label', maximized ? '还原窗口' : '最大化');
  button.title = maximized ? '还原窗口' : '最大化';
  button.querySelector('use')?.setAttribute('href', maximized ? '#i-restore' : '#i-maximize');
  scheduleView();
}

const appMenuButtons = [...document.querySelectorAll('[data-app-menu]')];
let appMenuPreviousFocus = null;
function focusAppMenu(button) {
  if (!appMenuButtons.includes(document.activeElement)) appMenuPreviousFocus = document.activeElement;
  for (const item of appMenuButtons) item.tabIndex = item === button ? 0 : -1;
  button?.focus({preventScroll: true});
}

async function openAppMenu(button) {
  if (!bridge?.openAppMenu || appMenuButtons.some(item => item.getAttribute('aria-expanded') === 'true')) return;
  const rect = button.getBoundingClientRect();
  for (const item of appMenuButtons) item.tabIndex = item === button ? 0 : -1;
  const keyboard = appMenuButtons.includes(document.activeElement);
  if (keyboard && appMenuPreviousFocus?.isConnected) appMenuPreviousFocus.focus({preventScroll: true});
  button.setAttribute('aria-expanded', 'true');
  try {
    await bridge.openAppMenu({menu: button.dataset.appMenu, x: Math.round(rect.left), y: Math.round(rect.bottom)});
  } catch (error) {
    showToast(str(error?.message, '菜单暂时无法打开，请重试。'), true);
  } finally {
    button.setAttribute('aria-expanded', 'false');
    if (keyboard) focusAppMenu(button);
  }
}

function toggleSidebar() {
  sidebarVisible = !sidebarVisible;
  document.body.classList.toggle('sidebar-collapsed', !sidebarVisible);
  const sidebar = $('sidebar');
  if (sidebar) sidebar.hidden = !sidebarVisible;
  const button = $('toggle-sidebar');
  button?.setAttribute('aria-expanded', String(sidebarVisible));
  button?.setAttribute('aria-label', sidebarVisible ? '收起侧栏' : '展开侧栏');
  if (button) button.title = `${sidebarVisible ? '收起' : '展开'}侧栏 · Ctrl+B`;
  scheduleView();
}

function toggleInspector(forceVisible) {
  inspectorVisible = typeof forceVisible === 'boolean' ? forceVisible : !inspectorVisible;
  if(inspectorVisible)window.beingTools?.hide();
  const inspector = $('inspector');
  if (inspector) inspector.hidden = !inspectorVisible;
  $('content-grid')?.classList.toggle('inspector-hidden', !inspectorVisible);
  const button = $('toggle-inspector');
  button?.setAttribute('aria-expanded', String(inspectorVisible));
  button?.setAttribute('aria-label', inspectorVisible ? '收起状态面板' : '展开状态面板');
  if (button) button.title = inspectorVisible ? '收起状态面板' : '展开状态面板';
  scheduleView();
}

function scheduleView() {
  if (viewFrame !== null) {
    cancelAnimationFrame(viewFrame);
    viewFrame = null;
  }
  const publishView = () => {
    if (!bridge?.setView) return;
    const rect = $('loom-host')?.getBoundingClientRect();
    const coordinate = (value) => Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
    const bounds = { x: coordinate(rect?.x), y: coordinate(rect?.y), width: coordinate(rect?.width), height: coordinate(rect?.height) };
    const visible = currentPage === 'chat' && state.settings?.chatMode === 'loom' && state.connection.configured && state.connection.status === 'connected' && !window.beingOnboarding?.isOpen() && !document.hidden && bounds.width > 0 && bounds.height > 0;
    const payload = { visible, bounds };
    const key = JSON.stringify(payload);
    if (key === lastView) return;
    lastView = key;
    void bridge.setView(payload).catch(() => { if (lastView === key) lastView = ''; });
  };
  if (document.hidden) {
    publishView();
    return;
  }
  viewFrame = requestAnimationFrame(() => {
    viewFrame = null;
    publishView();
  });
}

async function perform(method, ...args) {
  if (!bridge || typeof bridge[method] !== 'function') {
    showToast('桌面连接尚未就绪，请使用 Being Desktop 应用打开此页面。', true);
    return { ok: false };
  }
  if (pending.has(method)) return { ok: false };
  pending.add(method);
  renderButtons();
  try {
    const result = await bridge[method](...args);
    acceptState(result);
    return { ok: true, value: result };
  } catch (error) {
    const message = str(error?.message, '操作未完成，请查看连接状态后重试。').replace(/^Error invoking remote method 'being:[A-Za-z]+': (?:Error: )?/, '');
    showToast(message, true);
    return { ok: false, error: message };
  } finally {
    pending.delete(method);
    renderButtons();
  }
}

window.beingShell = Object.assign(window.beingShell || {}, {toast: (message, error = false) => showToast(message, error)});
function showToast(message, error = false) {
  clearTimeout(toastTimer);
  const toast = element('div', `toast${error ? ' error' : ''}`);
  toast.setAttribute('role', error ? 'alert' : 'status');
  toast.append(icon(error ? 'info' : 'check'), element('span', '', message));
  const close = element('button', 'icon-button');
  close.setAttribute('aria-label', '关闭提示');
  close.append(icon('close'));
  close.addEventListener('click', dismissToast);
  toast.append(close);
  $('toast-region').replaceChildren(toast);
  scheduleView();
  toastTimer = setTimeout(dismissToast, error ? 11000 : 5000);
}

function dismissToast() {
  clearTimeout(toastTimer);
  $('toast-region').replaceChildren();
  scheduleView();
}

function townActionLabel(mode, id) {
  if (id === 'scroll') return '浏览卷轴';
  if (id === 'beings') return '查看居民名录';
  return { being: '准备对话草稿', web: '打开网页（内置浏览器）', local: '打开本机 Portal 设置', app:'打开管理页' }[mode];
}

function renderTownCatalogStatus() {
  const ready = townCatalog.status === 'ready';
  const failed = townCatalog.status === 'error';
  const message = failed ? townCatalog.error : '正在读取 Town 功能目录…';
  text('town-status-message', message);
  text('sidebar-town-status', failed ? '功能目录读取失败' : '正在读取功能目录…');
  $('town-catalog-status').hidden = ready;
  $('sidebar-town-status').hidden = ready;
  $('town-retry').hidden = !failed;
  $('sidebar-town-retry').hidden = !failed;
  $('town-feature-list').hidden = !ready;
  $('sidebar-town-features').hidden = !ready;
  $('town-search').disabled = !ready;
  if (!ready) {
    text('town-count', failed ? '读取失败' : '读取中');
    $('town-empty').hidden = true;
  }
  $('page-town').setAttribute('aria-busy', String(townCatalogLoading));
  renderTownAvailability();
}

async function loadTownCatalog() {
  if (townCatalogLoading) return;
  townCatalogLoading = true;
  townCatalog.status = 'loading';
  renderTownCatalogStatus();
  try {
    if (typeof bridge?.getTownCatalog !== 'function') throw new Error('桌面功能目录尚未就绪。请使用更新后的 Being Desktop 重新打开。');
    const result = await bridge.getTownCatalog();
    const features = result?.features;
    const valid = Array.isArray(features) && features.length === townFeatureIds.size &&
      new Set(features.map((feature) => feature?.id)).size === townFeatureIds.size &&
      features.every((feature) => feature && townFeatureIds.has(feature.id) &&
        ['being', 'web', 'local', 'app'].includes(feature.mode) &&
        ['name', 'label', 'description', 'group'].every((key) => typeof feature[key] === 'string' && feature[key].trim()));
    if (!valid) throw new Error('Town 功能目录不完整或格式不正确，请重新读取。');
    townCatalog = { status: 'ready', features, checkedAt: result.checkedAt, error: '' };
    mountTownCatalog();
  } catch (error) {
    townCatalog.status = 'error';
    townCatalog.error = str(error?.message, '无法读取 Town 功能目录，请重试。');
  } finally {
    townCatalogLoading = false;
    renderTownCatalogStatus();
    if (townCatalog.status === 'ready') filterTownCatalog();
  }
}

function mountTownCatalog() {
  townRows.clear();
  townSidebarButtons.clear();
  townGroups.clear();
  $('sidebar-town-features').replaceChildren();
  $('town-feature-list').replaceChildren();
  const groups = new Map();
  for (const feature of townCatalog.features) {
    if (!groups.has(feature.group)) groups.set(feature.group, []);
    groups.get(feature.group).push(feature);
  }
  let groupIndex = 0;
  for (const [groupName, features] of groups) {
    const sidebarGroup = element('section', 'town-sidebar-group');
    const groupToggle = element('button', 'town-group-toggle');
    const groupItems = element('div', 'town-group-items');
    groupItems.id = `town-sidebar-group-${groupIndex++}`;
    groupToggle.dataset.townGroup = groupName;
    groupToggle.setAttribute('aria-controls', groupItems.id);
    groupToggle.setAttribute('aria-expanded', String(!townCollapsedGroups.has(groupName)));
    groupItems.hidden = townCollapsedGroups.has(groupName);
    groupToggle.append(element('span', '', groupName), icon('chevron', true));
    groupToggle.addEventListener('click', () => {
      const collapsed = !groupItems.hidden;
      groupItems.hidden = collapsed;
      groupToggle.setAttribute('aria-expanded', String(!collapsed));
      if (collapsed) townCollapsedGroups.add(groupName);
      else townCollapsedGroups.delete(groupName);
    });
    sidebarGroup.append(groupToggle, groupItems);
    $('sidebar-town-features').append(sidebarGroup);
    const mainGroup = element('section', 'town-main-group');
    mainGroup.append(element('h3', '', groupName));
    townGroups.set(groupName, { node: mainGroup, features });
    $('town-feature-list').append(mainGroup);
    for (const feature of features) {
      const modeIcon = { being: 'chat', web: 'external', local: 'terminal', app:'panel' }[feature.mode];
      const sidebarButton = element('button', 'town-sidebar-feature');
      sidebarButton.dataset.townFeature = feature.id;
      sidebarButton.title = `${feature.label} · ${feature.name}`;
      const sidebarCopy = element('span', 'town-sidebar-copy');
      sidebarCopy.append(element('span', 'town-sidebar-label', feature.label), element('span', 'town-sidebar-name', feature.name));
      sidebarButton.setAttribute('aria-label', `${feature.label} · ${feature.name}`);
      sidebarButton.append(icon(modeIcon, true), sidebarCopy);
      sidebarButton.addEventListener('click', () => selectTownFeature(feature.id));
      groupItems.append(sidebarButton);
      townSidebarButtons.set(feature.id, sidebarButton);

      const row = element('article', 'town-feature');
      row.id = `town-feature-${feature.id}`;
      row.dataset.featureId = feature.id;
      row.dataset.featureMode = feature.mode;
      row.tabIndex = -1;
      const copy = element('div', 'town-feature-copy');
      const heading = element('h3', 'town-feature-title', feature.label);
      heading.id = `town-title-${feature.id}`;
      heading.append(element('span', 'town-feature-name', feature.name));
      row.setAttribute('aria-labelledby', heading.id);
      copy.append(heading, element('p', 'town-feature-description', feature.description));
      if (feature.id === 'workspace') copy.append(element('p', 'town-feature-note', 'Town 上的临时文件与代码空间；与本机文件夹不自动同步。'));
      if (feature.id === 'portal') copy.append(element('p', 'town-feature-note', '这里管理当前电脑上的 Portal；进入设置不会启动或停止进程。'));
      const entry = element('div', 'town-feature-entry');
      entry.append(element('span', 'town-entry-kind', { being: 'Being 能力', web: '网页', local: '桌面管理', app:'桌面管理' }[feature.mode]));
      const action = element('button', 'button secondary small-button', townActionLabel(feature.mode, feature.id));
      action.dataset.townAction = feature.id;
      action.setAttribute('aria-label', `${feature.label}：${townActionLabel(feature.mode, feature.id)}`);
      action.setAttribute('aria-describedby', `town-action-hint-${feature.id}`);
      action.addEventListener('click', () => { void activateTownFeature(feature.id); });
      const hint = element('p', 'town-action-hint');
      hint.id = `town-action-hint-${feature.id}`;
      entry.append(action, hint);
      row.append(copy, entry);
      mainGroup.append(row);
      townRows.set(feature.id, { row, action, hint, feature });
    }
  }
  const checkedAt = new Date(townCatalog.checkedAt);
  text('town-catalog-source', townCatalog.checkedAt && !Number.isNaN(checkedAt.getTime())
    ? `目录核对于 ${checkedAt.toLocaleDateString('zh-CN')} · 实际权限与服务状态由相应入口确认。`
    : '实际权限与服务状态由相应入口确认。');
  renderTownSelection();
  renderTownAvailability();
}

function filterTownCatalog() {
  const query = $('town-search').value.trim().toLocaleLowerCase();
  let count = 0;
  for (const { row, feature } of townRows.values()) {
    const searchable = [feature.label, feature.name, feature.description, feature.group].join(' ').toLocaleLowerCase();
    row.hidden = Boolean(query && !searchable.includes(query));
    if (!row.hidden) count += 1;
  }
  for (const { node, features } of townGroups.values()) node.hidden = features.every((feature) => townRows.get(feature.id).row.hidden);
  $('town-search-clear').hidden = !query;
  $('town-empty').hidden = townCatalog.status !== 'ready' || count > 0;
  if (townCatalog.status === 'ready') text('town-count', query ? `${count} / ${townCatalog.features.length} 项` : `${townCatalog.features.length} 项`);
}

function renderTownSelection() {
  for (const [id, { row }] of townRows) {
    const selected = selectedTownFeature === id;
    row.classList.toggle('selected', selected);
    if (selected) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
    const button = townSidebarButtons.get(id);
    button?.classList.toggle('active', selected && ['town','town-app'].includes(currentPage));
    if (selected && ['town','town-app'].includes(currentPage)) button?.setAttribute('aria-current', 'true');
    else button?.removeAttribute('aria-current');
  }
}

function scrollWithinPage(page, target) {
  if (!page || !target) return;
  if (page.id === 'page-settings') {
    selectSettingsSection(target.closest('[data-settings-panel]')?.dataset.settingsPanel);
    page = $('settings-content');
  }
  page.scrollTop += target.getBoundingClientRect().top - page.getBoundingClientRect().top - 20;
}

function selectTownFeature(id) {
  if (!townRows.has(id)) return;
  if (nativeTownModules.has(id)) { openTownModule(id); return; }
  selectedTownFeature = id;
  $('town-search').value = '';
  filterTownCatalog();
  changePage('town');
  scrollWithinPage($('page-town'), townRows.get(id).row);
}

function openTownModule(id) {
  if (!nativeTownModules.has(id)) return;
  selectedTownFeature=id;
  changePage('town-app');
  window.beingTownApp?.open(id);
}

function renderTownAvailability() {
  const connected = state.connection.configured && state.connection.status === 'connected';
  if ($('town-connection-note')) $('town-connection-note').hidden = connected || townCatalog.status !== 'ready';
  for (const { row, action, hint, feature } of townRows.values()) {
    const requiresConnection = feature.mode === 'being' && !connected;
    row.dataset.availability = requiresConnection ? 'connection-required' : feature.mode === 'being' ? 'draft-ready' : feature.mode === 'web' ? 'web-link' : 'desktop-settings';
    action.disabled = requiresConnection || Boolean(townBusyAction);
    action.textContent = townBusyAction === feature.id ? '正在处理…' : townActionLabel(feature.mode, feature.id);
    hint.textContent = feature.mode === 'being'
      ? requiresConnection ? '连接 Being 后可准备草稿' : '仅填入草稿，不自动发送'
      : feature.mode === 'web' ? '在内置浏览器中继续' : feature.id === 'scroll' ? '在此阅读文档正文' : feature.id === 'beings' ? '展示 Being 与人类伙伴，每 60 秒刷新' : feature.mode === 'app' ? '在桌面查看流程与实际状态' : '权限以本机 Portal 配置为准';
  }
  if ($('town-open-home')) $('town-open-home').disabled = Boolean(townBusyAction);
}

async function openTownHome() {
  if (townBusyAction) return;
  townBusyAction = 'home';
  renderTownAvailability();
  try {
    if (typeof bridge?.openTownPage !== 'function') throw new Error('网页入口尚未就绪，请重新打开桌面应用。');
    await bridge.openTownPage('home');
  } catch (error) {
    showToast(str(error?.message, '网页未能打开，请重试。'), true);
  } finally {
    townBusyAction = '';
    renderTownAvailability();
  }
}

function openPortalUpdateSettings() {
  changePage('settings');
  scrollWithinPage($('page-settings'), $('portal-settings'));
  $('portal-settings')?.focus({preventScroll: true});
}

async function activateTownFeature(id) {
  const feature = townRows.get(id)?.feature;
  if (!feature || townBusyAction) return;
  if (feature.mode === 'app') { openTownModule(id); return; }
  if (feature.mode === 'local') {
    changePage('settings');
    scrollWithinPage($('page-settings'), $('portal-settings'));
    $('portal-settings')?.focus({ preventScroll: true });
    return;
  }
  if (feature.mode === 'being' && (!state.connection.configured || state.connection.status !== 'connected')) return;
  townBusyAction = id;
  renderTownAvailability();
  try {
    if (feature.mode === 'web') {
      if (typeof bridge?.openTownPage !== 'function') throw new Error('网页入口尚未就绪，请重新打开桌面应用。');
      await bridge.openTownPage(id);
    } else {
      if (typeof bridge?.prepareTownFeature !== 'function') throw new Error('对话草稿入口尚未就绪，请重新打开桌面应用。');
      changePage('chat');
      const result = await bridge.prepareTownFeature(id);
      if (result?.prepared !== true) throw new Error('未能准备对话草稿，请检查当前 Loom 对话后重试。');
      showToast('已填入对话草稿，补充需求后发送');
    }
  } catch (error) {
    showToast(str(error?.message, '功能入口未能打开，请重试。'), true);
  } finally {
    townBusyAction = '';
    renderTownAvailability();
  }
}

async function connect(formPrefix) {
  const input = $(`${formPrefix}-url`);
  const url = input.value.trim();
  if (!url) { input.focus(); return; }
  const result = await perform('connect', url);
  if (result.ok) {
    input.value = '';
    input.type = 'password';
    changePage('chat');
  }
}

function sizeLabel(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function renderBreadcrumbs() {
  const nodes = [];
  const root = element('button', '', basename(state.workspace.path) || '工作区');
  root.addEventListener('click', () => { void loadFiles(''); });
  nodes.push(root);
  const parts = currentFolder.split(/[\\/]/).filter(Boolean);
  parts.forEach((part, index) => {
    nodes.push(icon('chevron', true));
    const button = element('button', '', part);
    button.addEventListener('click', () => { void loadFiles(parts.slice(0, index + 1).join('/')); });
    nodes.push(button);
  });
  $('file-breadcrumbs').replaceChildren(...nodes);
}

async function loadFiles(relativePath = '') {
  if (!state.workspace.path || !bridge?.listWorkspace) return;
  const folderKey = `${state.workspace.path}|${relativePath}`;
  if (folderKey === loadingFolderKey) return;
  loadingFolderKey = folderKey;
  const request = ++fileRequest;
  const workspacePath = state.workspace.path;
  $('file-list').replaceChildren(element('p', 'file-list-message', '正在读取本机目录…'));
  $('workspace-refresh').disabled = true;
  try {
    const result = await bridge.listWorkspace(relativePath);
    if (request !== fileRequest || workspacePath !== state.workspace.path) return;
    const files = Array.isArray(result) ? result : Array.isArray(result?.files) ? result.files : [];
    currentFolder = relativePath;
    listedWorkspace = workspacePath;
    renderBreadcrumbs();
    text('file-count', `${files.length} 个项目`);
    if (!files.length) {
      $('file-list').replaceChildren(element('p', 'file-list-message', '这个文件夹还是空的。'));
      return;
    }
    const sorted = [...files].sort((a, b) => a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : str(a.name).localeCompare(str(b.name), 'zh-CN', { numeric: true }));
    const nodes = sorted.map((file) => {
      const isDirectory = file.type === 'directory';
      const row = element(isDirectory ? 'button' : 'div', `file-row ${isDirectory ? 'directory' : 'file-static'}`);
      row.append(icon(isDirectory ? 'folder' : 'file'), element('span', 'file-row-name', str(file.name)), element('span', 'file-row-size', isDirectory ? '文件夹' : sizeLabel(file.size)));
      if (isDirectory) {
        row.setAttribute('aria-label', `打开文件夹 ${str(file.name)}`);
        row.addEventListener('click', () => { void loadFiles(str(file.relativePath)); });
      }
      return row;
    });
    $('file-list').replaceChildren(...nodes);
  } catch (error) {
    if (request !== fileRequest) return;
    text('file-count', '读取失败');
    $('file-list').replaceChildren(element('p', 'file-list-message', str(error?.message, '无法读取此目录，请检查文件夹是否仍可访问。')));
  } finally {
    if (request === fileRequest) {
      $('workspace-refresh').disabled = false;
      loadingFolderKey = '';
    }
  }
}

async function selectWorkspace() {
  const result = await perform('selectWorkspace');
  if (result.ok && state.workspace.path) {
    changePage('workspace');
    if (listedWorkspace !== state.workspace.path) void loadFiles('');
  }
}

function mountMachineContext() {
  const identified = (tag, className, id, content) => {
    const node = element(tag, className, content);
    node.id = id;
    return node;
  };
  const detail = (label, id) => {
    const row = element('div', 'detail-row');
    row.append(element('span', '', label), identified('strong', '', id, '尚未确认'));
    return row;
  };
  const machineCard = element('div', 'machine-context-card');
  const machineIcon = element('span', 'machine-context-icon');
  machineIcon.append(icon('terminal'));
  const machineCopy = element('div', 'machine-context-copy');
  machineCopy.append(element('span', 'field-label', '当前这台电脑'), identified('strong', '', 'workspace-machine-name', '尚未确认'));
  const userCopy = element('div', 'machine-user-copy');
  userCopy.append(element('span', 'field-label', '本机用户'), identified('span', '', 'workspace-machine-user', '尚未确认'));
  machineCard.append(machineIcon, machineCopy, userCopy);
  const workspaceNote = $('page-workspace')?.querySelector('.permission-note');
  workspaceNote?.before(machineCard);
  const permissionCopy = workspaceNote?.querySelector('p');
  if (permissionCopy) permissionCopy.textContent = '此电脑上的文件夹；选择不会自动上传到 Town，也不代表 Portal 已获访问授权。';

  const portalSection = $('inspector-portal')?.closest('.inspector-section');
  portalSection?.querySelector('h3')?.replaceChildren(icon('terminal'), document.createTextNode('本机 Portal'));
  const portalProcessRow = $('inspector-portal')?.closest('.detail-row');
  portalProcessRow?.before(detail('运行电脑', 'inspector-machine-name'), detail('本机用户', 'inspector-machine-user'));

  const connectionSection = $('inspector-loom')?.closest('.inspector-section');
  connectionSection?.querySelector('h3')?.replaceChildren(icon('link'), document.createTextNode('Being 服务'));
  $('inspector-loom')?.closest('.detail-row')?.before(detail('服务入口', 'inspector-service-host'));

  const settingsMachine = element('div', 'settings-machine-context');
  settingsMachine.append(icon('terminal'), element('span', '', '运行于这台电脑'), identified('strong', '', 'settings-machine-name', '尚未确认'));
  $('portal-executable')?.closest('.settings-card')?.querySelector('.card-heading')?.after(settingsMachine);
  $('inspector-proxy')?.closest('.inspector-section')?.append(element('p', 'section-note', 'API 健康状态与模型调用结果分别核对。'));

  const settingsButton = element('button', 'icon-button');
  settingsButton.id = 'header-settings';
  settingsButton.setAttribute('aria-label', '打开连接与设置');
  settingsButton.title = '连接与设置 · Ctrl+,';
  settingsButton.append(icon('settings'));
  settingsButton.addEventListener('click', () => changePage('settings'));
  $('toggle-inspector')?.before(settingsButton);

  const modelCard = $('settings-model')?.closest('.settings-card');
  const configStatus = identified('span', 'badge', 'settings-config-status', '未知');
  modelCard?.querySelector('.card-heading')?.append(configStatus);
  modelCard?.querySelector('.card-heading')?.after(identified('p', 'configuration-status-note field-help', 'settings-config-detail', '尚未读取当前模型配置。'));
  $('inspector-model')?.after(identified('p', 'section-note configuration-status-note', 'inspector-config-detail', '尚未读取当前模型配置。'));
  const disconnectNote = element('p', 'field-help disconnect-note', '断开只移除桌面连接，不会暂停 Being。');
  $('settings-current-connection')?.append(disconnectNote);
}

mountMachineContext();

document.querySelectorAll('button[data-page]').forEach((button) => button.addEventListener('click', () => {
  if(button.dataset.page==='tasks')featureTaskView?.setFeature('');
  changePage(button.dataset.page);
}));
for (const section of ['project', 'session', 'town']) {
  const toggle = $(`sidebar-${section}-toggle`);
  toggle?.addEventListener('click', () => {
    const content = $(`sidebar-${section}-content`);
    content.hidden = !content.hidden;
    toggle.setAttribute('aria-expanded', String(!content.hidden));
  });
}
['town-retry', 'sidebar-town-retry'].forEach((id) => $(id)?.addEventListener('click', () => { void loadTownCatalog(); }));
$('town-search')?.addEventListener('input', filterTownCatalog);
$('town-search-clear')?.addEventListener('click', () => {
  $('town-search').value = '';
  filterTownCatalog();
  $('town-search').focus();
});
$('town-open-home')?.addEventListener('click', () => { void openTownHome(); });
$('town-connect')?.addEventListener('click', () => {
  changePage('settings');
  selectSettingsSection('connection');
  $('page-settings').scrollTop = 0;
  $('settings-url')?.focus({ preventScroll: true });
});
document.querySelectorAll('[data-reveal]').forEach((button) => button.addEventListener('click', () => {
  const input = $(button.dataset.reveal);
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
  button.setAttribute('aria-label', `${input.type === 'password' ? '显示' : '隐藏'} Loom 地址`);
}));
$('onboarding-connect-form').addEventListener('submit', (event) => { event.preventDefault(); void connect('onboarding'); });
$('settings-connect-form').addEventListener('submit', (event) => { event.preventDefault(); void connect('settings'); });
['refresh-state', 'inspector-refresh'].forEach((id) => $(id).addEventListener('click', () => { void perform('refresh'); }));
['settings-reconnect', 'reconnect-inline', 'reconnect-placeholder'].forEach((id) => $(id).addEventListener('click', () => { void perform('reconnect'); }));
$('settings-disconnect').addEventListener('click', () => { void perform('disconnect'); });
['sidebar-select-workspace', 'workspace-select', 'workspace-empty-select'].forEach((id) => $(id).addEventListener('click', () => { void selectWorkspace(); }));
$('workspace-shortcut').addEventListener('click', () => { if (state.workspace.path) changePage('workspace'); else void selectWorkspace(); });
$('workspace-open').addEventListener('click', () => { void perform('openWorkspace'); });
$('workspace-refresh').addEventListener('click', () => { void loadFiles(currentFolder); });
$('select-portal-executable').addEventListener('click', () => { void perform('selectPortalExecutable'); });
$('select-portal-config').addEventListener('click', () => { void perform('selectPortalConfig'); });
$('portal-setup').addEventListener('click', () => { void setupPortal(); });
$('portal-setup-assist').addEventListener('click', () => { void askBeingAboutPortal(); });
$('portal-setup-choose-workspace').addEventListener('click', () => { void perform('selectPortalWorkspace'); });
$('start-portal').addEventListener('click', () => { void perform('startPortal'); });
$('test-portal-connection').addEventListener('click', async () => {
  if (pending.has('testPortalConnection')) return;
  const revision = portalSelfTestRevision;
  const container = $('portal-self-test-result');
  container.textContent = '正在检查程序、进程、Being 运行时与中继握手…';
  container.hidden = false;
  const result = await perform('testPortalConnection');
  if (revision !== portalSelfTestRevision) return;
  const report = result.value;
  container.textContent = result.ok ? `连接自测 · ${new Date(report.checkedAt).toLocaleTimeString()}\n\n${formatPortalReport(report)}` : `自测未完成：${result.error || '桌面连接不可用'}`;
});
$('stop-portal').addEventListener('click', () => { void perform('stopPortal'); });
$('configure-portal').addEventListener('click', () => openTownModule('portal'));
$('back-to-loom').addEventListener('click', () => {
  changePage('chat');
  showToast('点击 Loom 对话界面右上角的齿轮，即可调整 Side by Side。');
});
$('close-to-tray').addEventListener('change', async (event) => { await perform('setCloseToTray', event.target.checked); render(); });
$('chat-mode')?.addEventListener('change', async (event) => { await perform('setChatMode', event.target.value); render(); scheduleView(); });
['reading-chat-size', 'reading-code-size'].forEach((id) => $(id)?.addEventListener('change', () => {
  void saveTypography({ chatFontSize: Number($('reading-chat-size').value), codeFontSize: Number($('reading-code-size').value) });
}));
$('reading-reset')?.addEventListener('click', () => { void saveTypography({ chatFontSize: 14, codeFontSize: 12 }); });
$('export-diagnostics').addEventListener('click', async () => {
  const result = await perform('exportDiagnostics');
  if (result.ok && result.value?.state) acceptState(result.value.state);
  if (result.ok && result.value?.exported === true) showToast('诊断已导出，可在保存的位置查看。');
});
$('toggle-inspector')?.addEventListener('click', () => toggleInspector());
$('close-inspector')?.addEventListener('click', () => toggleInspector(false));
$('toggle-sidebar')?.addEventListener('click', toggleSidebar);
$('navigate-back')?.addEventListener('click', () => navigateHistory(-1));
$('navigate-forward')?.addEventListener('click', () => navigateHistory(1));
for (const button of appMenuButtons) {
  button.addEventListener('mousedown', event => { if (event.button === 0) event.preventDefault(); });
  button.addEventListener('click', () => { void openAppMenu(button); });
  button.addEventListener('keydown', event => {
    const index = appMenuButtons.indexOf(button);
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? appMenuButtons.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + appMenuButtons.length) % appMenuButtons.length;
      focusAppMenu(appMenuButtons[next]);
    } else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      void openAppMenu(button);
    } else if (event.key === 'Escape') {
      if (appMenuPreviousFocus?.isConnected) appMenuPreviousFocus.focus({preventScroll: true});
      else button.blur();
    }
  });
}
for (const type of ['pointerdown', 'focusin']) {
  document.addEventListener(type, event => {
    if (!event.target.closest?.('.titlebar') && bridge?.markShellEditingTarget) {
      void bridge.markShellEditingTarget().catch(() => {});
    }
  });
}
$('active-session')?.addEventListener('click', () => changePage('chat'));
async function selectChatSession(id) {
  try {
    if (id !== null && id === state.chatSessions?.activeId) { changePage('chat'); return; }
    await bridge.changeChatSession(id);
    changePage('chat');
  } catch (error) { showToast(str(error?.message, '会话操作失败，请重试。'), true); }
}
$('new-chat-session')?.addEventListener('click', () => selectChatSession(null));
[['window-minimize', 'minimize'], ['window-maximize', 'maximize'], ['window-close', 'close']].forEach(([id, method]) => $(id).addEventListener('click', () => { void perform(method); }));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') dismissToast();
  if (event.defaultPrevented || event.repeat) return;
  if (document.documentElement.dataset.platform !== 'darwin' && event.key === 'F10' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
    event.preventDefault();
    focusAppMenu(appMenuButtons[0]);
    return;
  }
  if (event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    navigateHistory(event.key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  if (!(state.machine.platform === 'darwin' ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey || event.repeat) return;
  if (event.key.toLowerCase() === 'b') { event.preventDefault(); toggleSidebar(); }
  if (event.key === '1') { event.preventDefault(); changePage('chat'); }
  if (event.key === '2') { event.preventDefault(); changePage('workspace'); }
  if (event.key === ',') { event.preventDefault(); changePage('settings'); }
});
window.addEventListener('resize', scheduleView);
document.addEventListener('visibilitychange', scheduleView);
const hostResize = new ResizeObserver(scheduleView);
if ($('loom-host')) hostResize.observe($('loom-host'));
if ($('content-grid')) hostResize.observe($('content-grid'));

let settingsReturnPage = 'chat';
let activeSettingsSection = 'general';
const settingsSections = [
  {id: 'general', label: '常规', icon: 'settings', targets: ['close-to-tray', 'chat-mode'], keywords: '托盘 窗口 桌面 对话 模式 原生 Loom'},
  {id: 'appearance', label: '外观', icon: 'eye', targets: ['appearance-settings', 'reading-settings'], keywords: '颜色 配色 主题 字号 阅读'},
  {id: 'connection', label: '连接', icon: 'link', targets: ['settings-connect-form', 'town-connection-settings'], keywords: 'Being Loom Town 地址 授权 实时 同步 配对'},
  {id: 'models', label: '模型', icon: 'cpu', targets: ['model-settings'], keywords: 'API 服务 密钥 Side by Side'},
  {id: 'orchestration', label: '编排模式', icon: 'cpu', targets: ['orchestration-settings'], keywords: 'Orchestrator Worker Agent Kit Codex Cursor Grok 执行 工具'},
  {id: 'portal', label: '本机 Portal', icon: 'terminal', targets: ['portal-settings'], keywords: '工作区 工具 权限 程序 更新'},
  {id: 'about', label: '关于', icon: 'info', targets: ['export-diagnostics', 'setup-restart'], keywords: '版本 诊断 新手引导'},
];

function selectSettingsSection(id, {focus = false} = {}) {
  if (!settingsSections.some(section => section.id === id)) return;
  activeSettingsSection = id;
  for (const panel of document.querySelectorAll('[data-settings-panel]')) panel.hidden = panel.dataset.settingsPanel !== id;
  for (const button of document.querySelectorAll('[data-settings-section]')) {
    if (button.dataset.settingsSection === id) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  text('settings-heading', settingsSections.find(section => section.id === id).label);
  $('settings-content').scrollTop = 0;
  if (focus) $('settings-heading').focus({preventScroll: true});
  if (id === 'models' && currentPage === 'settings') window.beingModelSettings?.activate();
}

function initializeSettingsLayout() {
  const identified = (tag, className, id) => {
    const node = element(tag, className);
    node.id = id;
    return node;
  };
  const page = $('page-settings');
  const nav = element('nav', 'settings-navigation');
  nav.setAttribute('aria-label', '设置分类');
  const back = element('button', 'settings-back');
  back.type = 'button';
  back.append(icon('arrow'), element('span', '', '返回应用'));
  back.addEventListener('click', () => {
    changePage(settingsReturnPage);
    $('header-settings')?.focus();
  });
  const searchWrap = element('div', 'settings-search');
  const search = identified('input', '', 'settings-search');
  search.type = 'search';
  search.placeholder = '搜索设置';
  search.setAttribute('aria-label', '搜索设置');
  searchWrap.append(icon('search'), search);
  const links = element('div', 'settings-links');
  const empty = element('p', 'settings-search-empty', '未找到相关设置');
  empty.setAttribute('role', 'status');
  empty.hidden = true;
  nav.append(back, searchWrap, links, empty);
  const content = identified('div', 'settings-content', 'settings-content');
  const inner = element('div', 'settings-content-inner');
  const intro = page.querySelector('.settings-intro');
  intro.querySelector('p')?.remove();
  $('settings-heading').tabIndex = -1;
  inner.append(intro);
  content.append(inner);
  const contentFrame = element('div', 'settings-content-frame');
  contentFrame.append(content);
  page.prepend(nav, contentFrame);
  for (const section of settingsSections) {
    const button = element('button', 'settings-nav-item');
    button.type = 'button';
    button.dataset.settingsSection = section.id;
    button.setAttribute('aria-controls', `settings-panel-${section.id}`);
    button.append(icon(section.icon), element('span', '', section.label));
    button.addEventListener('click', () => selectSettingsSection(section.id, {focus: true}));
    links.append(button);
    const panel = identified('div', 'settings-panel', `settings-panel-${section.id}`);
    panel.dataset.settingsPanel = section.id;
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', section.label);
    for (const target of section.targets) {
      const card = $(target)?.closest('.settings-card');
      if (card) panel.append(card);
    }
    inner.append(panel);
  }
  $('settings-panel-about').append(page.querySelector('.settings-footnote'));
  search.addEventListener('input', () => {
    const terms = search.value.trim().toLocaleLowerCase().split(/\s+/);
    for (const section of settingsSections) {
      const haystack = `${section.label} ${section.keywords} ${$(`settings-panel-${section.id}`).textContent}`.toLocaleLowerCase();
      links.querySelector(`[data-settings-section="${section.id}"]`).hidden = !terms.every(term => haystack.includes(term));
    }
    empty.hidden = [...links.children].some(button => !button.hidden);
  });
  nav.addEventListener('keydown', event => {
    const buttons = [...links.children].filter(button => !button.hidden);
    if (event.key === 'Escape' && search.value) {
      event.preventDefault(); event.stopPropagation(); search.value = ''; search.dispatchEvent(new Event('input')); search.focus();
    } else if (event.target === search && event.key === 'Enter') {
      event.preventDefault(); buttons[0]?.click();
    } else if (event.target === search && event.key === 'ArrowDown') {
      event.preventDefault(); buttons[0]?.focus();
    } else if (buttons.includes(event.target) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const index = buttons.indexOf(event.target);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  });
  page.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    back.click();
  });
  selectSettingsSection(activeSettingsSection);
}

initializeSettingsLayout();
window.beingOrchestration?.init({bridge,onOpen:()=>changePage('workers'),onBack:()=>changePage('chat'),onUpdate:()=>render()});
window.beingThemeSettings?.init({bridge,onState:acceptState});
window.beingPortalPermissions?.init({bridge,onState:acceptState});
window.beingPortalUpdates?.init({bridge,onState:acceptState,onOpenSettings:openPortalUpdateSettings,onError:message=>showToast(message,true)});
function openFeatureTasks(feature='') {
  featureTaskView?.setFeature(feature);
  changePage('tasks');
}
featureTaskView=window.BeingFeatureTasks?.mount($('page-tasks'),{bridge,onNavigate:feature=>{
  if(nativeTownModules.has(feature))void openTownModule(feature);
  else changePage(feature==='workspace'?'workspace':'settings');
},onDraft:()=>changePage('chat')});
function updateTaskBadge(value) {
  const count=Array.isArray(value?.tasks)?value.tasks.filter(task=>['running','waiting','needs_input'].includes(task.status)).length:0;
  text('feature-task-count',String(count));
  if($('feature-task-count'))$('feature-task-count').hidden=count===0;
}
if(bridge?.onFeatureTasks)bridge.onFeatureTasks(updateTaskBadge);
if(bridge?.getFeatureTasks)void bridge.getFeatureTasks().then(updateTaskBadge).catch(()=>{});
window.beingTownApp?.init({bridge,onNavigateChat:()=>changePage('chat'),onSelectPortalWorkspace:()=>perform('selectPortalWorkspace'),onNavigateSettings:()=>changePage('settings'),onBack:()=>changePage('town'),onTasks:openFeatureTasks,onBonfireSent:result=>window.beingOnboarding?.onBonfireSent(result)});
window.beingTools?.init({bridge,onOpen:()=>toggleInspector(false),onLayout:scheduleView,onSelectWorkspace:()=>selectWorkspace()});
window.beingOnboarding?.init({bridge,onState:acceptState,onLayout:scheduleView,onOpen:()=>window.beingTools?.hide(),onChat:()=>changePage('chat'),onChannel:()=>openTownModule('channel'),onGrove:()=>openTownModule('grove'),onBonfire:()=>{selectedTownFeature='bonfire';changePage('town-app');void window.beingTownApp?.startOnboardingGreeting();},onComplete:()=>showToast('问候已送达篝火，新手引导完成。欢迎来到 Town！'),onPortalSettings:()=>{changePage('settings');scrollWithinPage($('page-settings'),$('portal-settings'));},onError:message=>showToast(message,true)});
render();
renderNavigation();
renderWindowState({maximized: false});
if (bridge?.onWindowState) bridge.onWindowState(renderWindowState);
if (bridge?.getWindowState) void bridge.getWindowState().then(renderWindowState).catch(() => {});
if (bridge?.onState) bridge.onState(acceptState);
if (bridge?.onCommand) {
  bridge.onCommand((command) => {
    if (command === 'toggle-sidebar') toggleSidebar();
    else if (command === 'navigate-back') navigateHistory(-1);
    else if (command === 'navigate-forward') navigateHistory(1);
    else if (command === 'toggle-inspector') toggleInspector();
    else if (command === 'select-workspace') void selectWorkspace();
    else if (command === 'refresh') void perform('refresh');
    else if (command === 'open-browser') window.beingTools?.show('browser');
    else if (command === 'open-console') window.beingTools?.show('console');
    else if (command === 'about') showToast(`Being Desktop ${state.version}`);
    else if (command === 'portal-updates') openPortalUpdateSettings();
    else if (['chat', 'workspace', 'settings'].includes(command)) changePage(command);
  });
}
void perform('getState');
void loadTownCatalog();

function renameChatSession(item, button) {
  if(editingSession)return;
  const editor=document.createElement('div');editor.className='session-shortcut session-editing';
  const input=document.createElement('input');input.className='session-name-input';input.value=item.title;input.maxLength=80;
  input.setAttribute('aria-label','会话名称');input.title='Enter 保存，Esc 取消';
  const dot=button.querySelector('.session-activity-light');if(dot)editor.append(dot.cloneNode(true));
  editor.append(input);button.replaceWith(editor);editingSession=editor;
  let saving=false,finished=false;
  const close=()=>{if(finished)return;finished=true;if(editingSession===editor)editingSession=null;render();};
  const save=async()=>{
    if(saving || finished || editingSession!==editor)return;
    const title=input.value.trim();
    if(!title || title===item.title){close();return;}
    saving=true;input.readOnly=true;
    try {
      await bridge.renameChatSession(item.id,title);
      const current=state.chatSessions?.items.find(session=>session.id===item.id);if(current)current.title=title;
      close();
    } catch(error){showToast(error.message);saving=false;input.readOnly=false;input.focus();input.select();}
  };
  input.addEventListener('keydown',event=>{
    if(event.isComposing)return;
    if(event.key==='Escape'){event.preventDefault();if(!saving)close();}
    if(event.key==='Enter'){event.preventDefault();void save();}
  });
  input.addEventListener('blur',()=>void save());
  input.focus();input.select();
}
