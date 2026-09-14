'use strict';

window.beingPortalUpdates = (() => {
  const $ = id => document.getElementById(id);
  const clean = value => typeof value === 'string' ? value : '';
  let bridge, onState, onOpenSettings, onError;
  let initialized = false, pending = false, opening = false, changing = false, feedback = '';
  let update = {};

  function render() {
    if (!initialized) return;
    const external = update.status === 'external';
    const available = update.available === true;
    const maintenance = update.maintenance || {};
    const busy = changing || maintenance.busy === true;
    const ready = ['ready','waiting'].includes(maintenance.phase);
    const recovery = maintenance.phase === 'recovery_required';
    $('portal-update-cancel').hidden = maintenance.phase !== 'downloading';
    $('portal-update-cancel').disabled = typeof bridge?.cancelPortalDownload !== 'function';
    $('portal-update-download').hidden = !available || !maintenance.supported || ready || recovery;
    $('portal-update-download').disabled = busy || typeof bridge?.downloadPortalUpdate !== 'function';
    $('portal-update-apply').hidden = !ready;
    $('portal-update-apply').disabled = busy || !maintenance.supported || typeof bridge?.applyPortalUpdate !== 'function';
    $('portal-update-apply').textContent = maintenance.running ? '停止并更新' : '更新并启动';
    $('portal-update-recover').hidden = !recovery;
    $('portal-update-recover').disabled = busy || typeof bridge?.recoverPortalUpdate !== 'function';
    $('portal-maintenance-status').textContent = clean(maintenance.detail) + (ready ? ' 应用时会短暂断连；请在工具任务结束后操作。' : '');
    $('portal-maintenance-status').hidden = !maintenance.detail;
    $('portal-update-panel').setAttribute('aria-busy', String(busy || pending));
    const checking = pending || update.checking === true || update.status === 'checking';
    const failed = Boolean(feedback) || update.status === 'error';
    const current = clean(update.currentVersion);
    const latest = clean(update.latestVersion);
    $('portal-update-version').textContent = external ? (current ? `${current} · 外部管理` : '已有 Portal · 版本未确认') : current || (update.status === 'not_installed' ? '尚未配置' : '未识别');
    $('portal-update-check').disabled = busy || checking || typeof bridge?.checkPortalUpdates !== 'function';
    $('portal-update-check').textContent = checking ? (external ? '读取中…' : '检查中…') : external ? '刷新状态' : failed ? '重试检查' : '检查更新';
    $('portal-update-open').hidden = !available;
    $('portal-update-open').disabled = opening || typeof bridge?.openPortalUpdate !== 'function';
    $('portal-update-open').textContent = opening ? '正在打开…' : '查看更新';
    $('portal-update-entry').hidden = !available;
    $('portal-update-entry').title = latest ? `Portal ${latest} 可用，查看更新` : '查看 Portal 更新';
    $('portal-update-entry').closest('.statusbar')?.classList.toggle('has-portal-update', available);
    $('portal-update-panel').setAttribute('aria-busy', String(checking || busy));
    $('portal-update-panel').classList.toggle('has-update', available);
    const status = $('portal-update-status');
    const disclosure = status.closest('details');
    if (disclosure && (checking || failed)) disclosure.open = true;
    let message = '';
    if (external) message = 'Portal 正在运行，由外部程序管理。';
    else if (available) message = `发现 Portal 新版本${latest ? ` ${latest}` : ''}，可查看更新。`;
    else if (checking) message = '正在检查 Portal 更新…';
    else if (failed) message = '本次无法检查 Portal 更新。';
    else if (update.status === 'not_installed') message = '选择 Portal 程序后，可检查其版本和更新。';
    else if (!current && ['unknown', 'current'].includes(update.status)) message = `无法识别所选 Portal 程序版本${latest ? `；官方最新版本为 ${latest}` : ''}。`;
    else if (update.status === 'current' && current) message = latest && current !== latest ? '所选 Portal 程序无需更新。' : '所选 Portal 程序已是最新版本。';
    else if (update.status === 'unknown') message = '暂时无法确认 Portal 是否需要更新。';
    else message = '每 6 小时自动检查 Portal 新版本，也可手动检查。';
    if (available && checking) message += ' 正在重新检查…';
    if (available && failed) message += ' 本次检查未完成，保留上次更新提示。';
    if (status.textContent !== message) status.textContent = message;
    status.classList.toggle('tone-warning', available);
    status.classList.toggle('tone-error', failed && !available);
    let detail = feedback || clean(update.detail);
    if(failed && latest && update.checkedAt) detail += ` 上次成功确认的稳定版为 ${latest}，本次尚未确认是否有更新。`;
    if(failed && update.retryAt) detail += ` 可在 ${new Date(update.retryAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})} 后重试。`;
    $('portal-update-detail').textContent = detail;
    $('portal-update-detail').hidden = !detail;
    const checkedAt = update.checkedAt ? new Date(update.checkedAt) : null;
    $('portal-update-checked').textContent = checkedAt && !Number.isNaN(checkedAt.getTime())
      ? `${external ? '状态读取' : '上次检查'} ${checkedAt.toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false})}` : '';
    $('portal-update-checked').hidden = !$('portal-update-checked').textContent;
  }

  async function check() {
    if ($('portal-update-check').disabled || pending) return;
    pending = true;
    feedback = '';
    render();
    try {
      const state = await bridge.checkPortalUpdates();
      onState?.(state);
    } catch (error) {
      feedback = clean(error?.message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || '检查未完成，请稍后重试。';
    } finally {
      pending = false;
      render();
    }
  }

  async function open() {
    if ($('portal-update-open').disabled || opening || !update.available) return;
    opening = true;
    render();
    try {
      await bridge.openPortalUpdate();
    } catch (error) {
      onError?.(clean(error?.message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || '更新页面未能打开，请重试。');
    } finally {
      opening = false;
      render();
    }
  }

  async function change(method) {
    if(changing || update.maintenance?.busy || typeof bridge?.[method] !== 'function')return;
    changing=true;feedback='';render();
    try { onState?.(await bridge[method]()); }
    catch(error) { feedback=clean(error?.message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || 'Portal 更新未完成，请检查状态。'; }
    finally { changing=false;render(); }
  }

  function setState(value) {
    if (JSON.stringify(value || {}) !== JSON.stringify(update)) feedback = '';
    update = value && typeof value === 'object' ? value : {};
    render();
  }

  function init(options) {
    if (initialized || !$('portal-update-panel')) return;
    initialized = true;
    ({bridge, onState, onOpenSettings, onError} = options);
    $('portal-update-check').addEventListener('click', () => { void check(); });
    $('portal-update-open').addEventListener('click', () => { void open(); });
    $('portal-update-cancel').addEventListener('click',()=>{if(typeof bridge?.cancelPortalDownload==='function')void bridge.cancelPortalDownload().then(state=>onState?.(state)).catch(()=>{});});
    for(const [id,method] of [['portal-update-download','downloadPortalUpdate'],['portal-update-apply','applyPortalUpdate'],['portal-update-recover','recoverPortalUpdate']]) $(id).addEventListener('click',()=>{if(!$(id).disabled)void change(method);});
    $('portal-update-entry').addEventListener('click', () => onOpenSettings?.());
    render();
  }

  return {init, setState};
})();
