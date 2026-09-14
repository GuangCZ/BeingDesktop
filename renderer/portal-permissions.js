(() => {
  'use strict';
  const labels = {file:'文件读写',exec:'命令执行',screenshot:'屏幕截图',search:'文件搜索',web_fetch:'网页搜索',custom_tools_enabled:'自定义工具'};
  const $ = id => document.getElementById(id);
  const errorText=error=>(error?.message || '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  const configKey=value=>JSON.stringify([value.portal?.management,value.portal?.management==='external'?value.portal?.deployment?.configPath:value.portal?.configPath,Boolean(value.portal?.adopted)]);
  let bridge, onState, state = {}, loaded = null, busy = false, reading = false, generation = 0;
  function render() {
    const unavailable = busy || state.portalUpdate?.maintenance?.busy || !loaded || state.portal?.status==='external'&&!state.portal?.adopted;
    for (const key of Object.keys(labels)) $(`portal-permission-${key}`).disabled = unavailable;
    $('portal-permission-save').disabled = unavailable;
    $('portal-permission-refresh').disabled = busy;
    $('portal-permission-save').textContent = busy ? reading ? '读取中…' : '保存中…' : state.portal?.owned || state.portal?.adopted&&state.portal?.pid ? '保存并重启' : '保存';
  }
  function message(value) { $('portal-permission-status').textContent = value; }
  async function read() {
    if (busy) return;
    const revision = ++generation;
    loaded = null; busy = true; reading = true; render(); message('正在读取配置…');
    try {
      const result = await bridge.getPortalPermissions();
      if (revision!==generation) return;
      loaded = result;
      for (const key of Object.keys(labels)) $(`portal-permission-${key}`).checked = result.permissions[key];
      message('');
    } catch (error) { if(revision===generation) message(errorText(error) || '无法读取权限。'); }
    finally { busy = false; reading = false; render(); }
  }
  async function save() {
    if (busy || !loaded) return;
    const request = {...loaded,permissions:Object.fromEntries(Object.keys(labels).map(key=>[key,$(`portal-permission-${key}`).checked]))};
    busy = true; render(); message('正在保存权限…');
    try {
      const result = await bridge.savePortalPermissions(request);
      onState?.(result.state);
      loaded = null;
      message(result.detail);
    } catch (error) { loaded=null; message(errorText(error) || '保存失败，请重新读取权限。'); }
    finally { busy = false; reading = false; render(); }
  }
  window.beingPortalPermissions = {
    init(options) {
      bridge=options.bridge; onState=options.onState;
      for (const [key,label] of Object.entries(labels)) {
        const row=document.createElement('label'); row.className='portal-permission-row';
        const text=document.createElement('span'); text.textContent=label;
        const input=document.createElement('input'); input.type='checkbox'; input.id=`portal-permission-${key}`; input.disabled=true;
        input.setAttribute('role','switch');
        input.addEventListener('change',()=>message('有未保存的更改'));
        row.append(text,input); $('portal-permission-fields').append(row);
      }
      $('portal-permissions').addEventListener('toggle',()=>{if($('portal-permissions').open)void read();});
      $('portal-permission-refresh').addEventListener('click',()=>void read());
      $('portal-permission-save').addEventListener('click',()=>void save());
      render();
    },
    setState(next) {
      const changed=configKey(state)!==configKey(next);
      if (changed) {
        generation++; loaded=null;
        message('配置已变化，请重新读取权限。');
      }
      state=next; render();
      if(changed && !busy && $('portal-permissions').open)void read();
    },
  };
})();
