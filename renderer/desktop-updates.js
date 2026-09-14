'use strict';

window.beingDesktopUpdates = (() => {
  const $ = id => document.getElementById(id);
  let bridge, onState, openSettings, update = {}, pending = false, feedback = '';
  function render() {
    if (!bridge) return;
    const busy = pending || ['checking', 'downloading', 'installing'].includes(update.status);
    $('desktop-update-version').textContent = update.currentVersion || '未知';
    $('desktop-update-enabled').checked = update.enabled !== false;
    $('desktop-update-enabled').disabled = pending || !update.supported;
    $('desktop-update-check').disabled = busy || !update.supported || update.status === 'ready';
    $('desktop-update-check').textContent = update.status === 'checking' ? '检查中…' : update.status === 'error' ? '重新检查' : '检查更新';
    $('desktop-update-download').hidden = !update.available || !['available', 'error'].includes(update.status);
    $('desktop-update-download').disabled = busy;
    $('desktop-update-install').hidden = !['ready', 'installing'].includes(update.status);
    $('desktop-update-install').disabled = busy;
    const summaries = {
      idle: update.enabled === false ? '自动检查已关闭，可手动检查。' : '将自动检查新版本。',
      checking: '正在检查新版本…',
      current: '当前没有可用更新。',
      ahead: `当前版本领先于发布版 ${update.latestVersion || ''}，无需更新。`,
      available: `发现新版本 ${update.latestVersion || ''}`,
      downloading: `正在下载更新 · ${Math.round(update.progress || 0)}%`,
      ready: `版本 ${update.latestVersion || ''} 已下载`,
      installing: '正在验证更新并准备重启…',
      error: '更新未完成，请稍后重试。',
      unsupported: '此运行方式暂不支持自动更新。',
    };
    $('desktop-update-status').textContent = feedback || summaries[update.status] || summaries.idle;
    $('desktop-update-detail').textContent = update.detail || '准备好后会提示重启安装。';
    $('desktop-update-panel').dataset.updateStatus = feedback ? 'error' : update.status || 'idle';
    $('desktop-update-progress').hidden = update.status !== 'downloading';
    $('desktop-update-progress').value = update.progress || 0;
    $('desktop-update-panel').setAttribute('aria-busy', String(busy));
    const entry = $('desktop-update-entry');
    entry.hidden = !update.available && !['available', 'downloading', 'ready', 'installing'].includes(update.status);
    entry.disabled = busy;
    const label = update.status === 'ready' ? `Desktop ${update.latestVersion || ''} 已下载，查看并安装`
      : update.status === 'downloading' ? `正在下载 Desktop 更新 · ${Math.round(update.progress || 0)}%`
      : `下载 Desktop ${update.latestVersion || ''} 更新`;
    entry.title = label;
    entry.setAttribute('aria-label', label);
    entry.querySelector('use').setAttribute('href', update.status === 'ready' ? '#i-refresh' : '#i-arrow-down');
  }
  async function run(method, ...args) {
    if (pending) return;
    pending = true; feedback = ''; render();
    try { onState(await bridge[method](...args)); }
    catch { feedback = '操作未完成，请稍后重试。'; }
    finally { pending = false; render(); }
  }
  function init(options) {
    ({bridge, onState, openSettings} = options);
    $('desktop-update-check').addEventListener('click', () => { void run('checkDesktopUpdates'); });
    $('desktop-update-download').addEventListener('click', () => { void run('downloadDesktopUpdate'); });
    $('desktop-update-install').addEventListener('click', () => { void run('installDesktopUpdate'); });
    $('desktop-update-open').addEventListener('click', () => { void run('openDesktopRelease'); });
    $('desktop-update-enabled').addEventListener('change', event => { void run('setDesktopAutoUpdate', event.target.checked); });
    $('desktop-update-entry').addEventListener('click', () => { if (update.status === 'ready') openSettings(); else void run('downloadDesktopUpdate'); });
    render();
  }
  function setState(value) { update = value || {}; render(); }
  return {init, setState};
})();
