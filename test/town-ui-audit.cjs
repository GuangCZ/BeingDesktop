'use strict';

const FEATURE_IDS = Object.freeze(['scroll', 'bonfire', 'beings', 'portal', 'grove', 'ember', 'workspace', 'channel', 'fireside']);
const APP_IDS = Object.freeze(['grove','channel','portal','fireside','bonfire','scroll','beings']);
const EXPECTED_MODES = Object.freeze({ grove: 'app', channel:'app', fireside:'app', bonfire:'app', ember: 'web', portal: 'app', scroll:'app', beings:'app' });

// All scripts target the trusted shell through runUiAudit's guarded executor.
// No external page, remote message or final installation action is activated.
const TOWN_SCRIPTS = Object.freeze({
  open: `(() => { const el = document.getElementById('nav-town'); if (!el) return false; el.click(); return true; })()`,
  top: `(() => { const el = document.getElementById('page-town'); if (!el) return false; el.scrollTo(0, 0); return true; })()`,
  english: `(() => { const el = document.getElementById('town-search'); if (!el) return false; el.value = 'Fireside'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  chinese: `(() => { const el = document.getElementById('town-search'); if (!el) return false; el.value = '围炉'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  missing: `(() => { const el = document.getElementById('town-search'); if (!el) return false; el.value = 'zzzz_ui_audit_no_match'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  clear: `(() => { const el = document.getElementById('town-search-clear'); if (!el) return false; el.click(); return true; })()`,
  toggleSection: `(() => { const el = document.getElementById('sidebar-town-toggle'); if (!el) return false; el.click(); return true; })()`,
  normalize: `(async () => {
    const sidebar = document.getElementById('sidebar-town-toggle');
    if (sidebar?.getAttribute('aria-expanded') === 'false') sidebar.click();
    const count = document.querySelectorAll('button[data-town-group]').length;
    for (let index = 0; index < count; index += 1) {
      const group = document.querySelector('button[data-town-group][aria-expanded="false"]');
      if (!group) break;
      group.click();
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    const search = document.getElementById('town-search');
    if (search?.value) document.getElementById('town-search-clear')?.click();
    return Boolean(sidebar && search);
  })()`,
  collapseGroups: `(async () => {
    const count = document.querySelectorAll('button[data-town-group]').length;
    for (let index = 0; index < count; index += 1) {
      const group = document.querySelector('button[data-town-group][aria-expanded="true"]');
      if (!group) break;
      group.click();
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return count;
  })()`,
  expandGroups: `(async () => {
    const count = document.querySelectorAll('button[data-town-group]').length;
    for (let index = 0; index < count; index += 1) {
      const group = document.querySelector('button[data-town-group][aria-expanded="false"]');
      if (!group) break;
      group.click();
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return count;
  })()`,
  portalPrepare: `(() => { const el = document.querySelector('button[data-town-action="portal"]'); if (!el) return false; el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return true; })()`,
  portalOpen: `(() => { const el = document.querySelector('button[data-town-action="portal"]'); if (!el || el.disabled) return false; el.click(); return true; })()`,
  portalSection: `(() => {
    const el = document.getElementById('portal-settings');
    const rect = el?.getBoundingClientRect();
    return { exists: Boolean(el), visible: Boolean(el && el.getClientRects().length && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight) };
  })()`,
  snapshot: `(() => {
    const known = ['scroll', 'bonfire', 'beings', 'portal', 'grove', 'ember', 'workspace', 'channel', 'fireside'];
    const rectangle = el => {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const rendered = el => {
      if (!el || !el.getClientRects().length) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const visible = el => {
      if (!rendered(el)) return false;
      const rect = el.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
    };
    const uncovered = el => {
      if (!visible(el)) return false;
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return Boolean(hit && (hit === el || el.contains(hit)));
    };
    const rows = [...document.querySelectorAll('#town-feature-list article[data-feature-id]')].map(el => {
      const id = el.dataset.featureId;
      const action = known.includes(id) ? el.querySelector('button[data-town-action]') : null;
      return { id: known.includes(id) ? id : 'unexpected',
        mode: ['being', 'web', 'local','app'].includes(el.dataset.featureMode) ? el.dataset.featureMode : 'unexpected',
        availability: ['connection-required', 'ready', 'available', 'unavailable'].includes(el.dataset.availability) ? el.dataset.availability : 'other',
        rendered: rendered(el), visible: visible(el), rect: rectangle(el),
        selected: el.classList.contains('selected') && el.getAttribute('aria-current') === 'true',
        actionExists: Boolean(action), actionDisabled: Boolean(action?.disabled), actionVisible: visible(action), actionUncovered: uncovered(action),
        actionClaimsReady: Boolean(action && /就绪|ready/i.test(action.textContent || '')) };
    });
    const sidebar = [...document.querySelectorAll('#sidebar-town-content button[data-town-feature]')].map(el => ({
      id: known.includes(el.dataset.townFeature) ? el.dataset.townFeature : 'unexpected',
      visible: visible(el), rendered: rendered(el), uncovered: uncovered(el), active: el.classList.contains('active'), rect: rectangle(el)
    }));
    const count = document.getElementById('town-count');
    const countMatch = (count?.textContent || '').match(/[0-9]+/);
    return {
      count: countMatch ? Number(countMatch[0]) : null,
      rows, sidebar,
      groups: [...document.querySelectorAll('button[data-town-group]')].map((el, index) => ({ index, expanded: el.getAttribute('aria-expanded') === 'true' })),
      sidebarExpanded: document.getElementById('sidebar-town-toggle')?.getAttribute('aria-expanded') === 'true',
      sidebarContentRendered: rendered(document.getElementById('sidebar-town-content')),
      searchExists: Boolean(document.getElementById('town-search')),
      searchEmpty: document.getElementById('town-search')?.value === '',
      emptyVisible: visible(document.getElementById('town-empty')),
      connectionNoteVisible: visible(document.getElementById('town-connection-note')),
      app: {id:document.getElementById('page-town-app')?.dataset.townModule || '',visible:visible(document.getElementById('page-town-app')),
        modules:[...document.querySelectorAll('#page-town-app .ta-module')].map(el=>({id:['grove','channel','portal','fireside','bonfire'].find(id=>el.classList.contains('ta-'+id)) || 'unknown',visible:visible(el),rect:rectangle(el)}))}
    };
  })()`
});

const MODULE_SCRIPTS = Object.freeze({
  snapshot: `(() => {
    const root = document.getElementById('page-town-app');
    const visible = el => { const r=el?.getBoundingClientRect(); return Boolean(el && el.getClientRects().length && r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth && getComputedStyle(el).visibility!=='hidden'); };
    const geometry = el => { if(!el)return null;const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;let clipped=false;for(let p=el.parentElement;p;p=p.parentElement){const s=getComputedStyle(p),b=p.getBoundingClientRect();if(['auto','scroll','hidden'].includes(s.overflowY)&&(y<b.top+p.clientTop||y>=b.top+p.clientTop+p.clientHeight))clipped=true;if(['auto','scroll','hidden'].includes(s.overflowX)&&(x<b.left+p.clientLeft||x>=b.left+p.clientLeft+p.clientWidth))clipped=true;}const hit=document.elementFromPoint(x,y);return {visible:visible(el),uncovered:visible(el)&&Boolean(hit&&(hit===el||el.contains(hit))),clipped,disabled:Boolean(el.disabled),rect:{x:r.x,y:r.y,width:r.width,height:r.height}};};
    const grove = document.querySelector('.ta-grove');
    const channel = document.querySelector('.ta-channel');
    const portal = document.querySelector('.ta-portal');
    const fireside = document.querySelector('.ta-fireside');
    const list = document.querySelector('.ta-kit-list');
    const text = list?.textContent || '';
    const workspace = document.querySelector('.ta-workspace-path')?.textContent || '';
    return {id:root?.dataset.townModule,root:geometry(root),
      controls:Object.fromEntries(['grove-search','channel-connect','portal-app-workspace','portal-app-deploy','portal-app-confirm','fireside-draft','fireside-send','fireside-create','fireside-join','bonfire-draft','bonfire-send','scroll-search','beings-search'].map(id=>[id,geometry(document.getElementById(id))])),
      grove:{rows:list?.querySelectorAll('.ta-kit-row').length||0,loading:text.includes('正在读取工具市场'),error:text.includes('目录暂时无法读取'),empty:text.includes('没有匹配的工具包')||text.includes('暂时没有工具包'),searchPresent:Boolean(grove?.querySelector('#grove-search')),browseVisible:visible(grove?.querySelector('.ta-grove-browse')),detailVisible:visible(grove?.querySelector('.ta-kit-detail'))},
      channel:{cards:[...channel.querySelectorAll('[data-channel]')].map(el=>({id:el.dataset.channel,selected:el.getAttribute('aria-pressed')==='true',...geometry(el)})),wizardSteps:channel.querySelectorAll('.ta-wizard-steps li').length,credentialInputs:channel.querySelectorAll('input').length,secretIsPassword:channel.querySelector('#channel-app-secret')?.type==='password',qrImages:channel.querySelectorAll('img.ta-qr').length,wecomUnsupported:channel.textContent.includes('暂不支持企业微信')},
      portal:{workspaceMissing:workspace==='尚未选择文件夹',permissions:['files','exec','web','extensions'].map(id=>{const el=document.getElementById('portal-permission-'+id);return {id,exists:Boolean(el),interactive:Boolean(el?.matches('input,button,select')),text:el?.textContent||''};}),planUnverified:portal?.textContent.includes('计划配置')&&portal?.textContent.includes('当前实例：尚未验证实际能力'),sandboxLimitVisible:portal?.textContent.includes('不是操作系统沙箱'),confirmVisible:visible(portal?.querySelector('.ta-inline-confirm'))},
      fireside:{columns:['.ta-room-sidebar','.ta-room-center','.ta-members'].map(selector=>({selector,present:Boolean(fireside?.querySelector(selector)),...geometry(fireside?.querySelector(selector))})),rooms:fireside?.querySelectorAll('.ta-room-row').length||0,members:fireside?.querySelectorAll('.ta-member').length||0,messages:fireside?.querySelectorAll('.ta-message').length||0,locked:fireside?.textContent.includes('围炉与消息尚未同步'),draftEmpty:document.getElementById('fireside-draft')?.value==='',draftPreserved:document.getElementById('fireside-draft')?.value==='Town 本机草稿审查，未发送。'}
    };
  })()`,
  groveMissing: `(() => {const el=document.getElementById('grove-search');el.value='zzzz_grove_audit_no_match';el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,
  groveClear: `(() => {const el=document.getElementById('grove-search');el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,
  channelWizard: `(() => {const el=document.getElementById('channel-connect');if(!el||el.disabled)return false;el.scrollIntoView({block:'nearest'});el.click();return true;})()`,
  portalReview: `(() => {const el=document.getElementById('portal-app-deploy');if(!el)return false;el.scrollIntoView({block:'nearest'});return el.textContent.includes('一键');})()`,
  portalReturn: `(() => {const el=document.querySelector('.ta-inline-confirm .ta-quiet');if(el)el.click();return true;})()`,
  draftStart: `(() => {const el=document.getElementById('fireside-draft'),send=document.getElementById('fireside-send');if(!el||el.value!==''||!send?.textContent.includes('带草稿到 Loom'))return {started:false};window.__beingTownDraftAudit=true;el.value='Town 本机草稿审查，未发送。';el.dispatchEvent(new Event('input',{bubbles:true}));const composing=new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true});const legacy=new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true,cancelable:true});const newline=new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true});const enter=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});el.dispatchEvent(composing);el.dispatchEvent(legacy);el.dispatchEvent(newline);el.dispatchEvent(enter);return {started:true,composingPreserved:!composing.defaultPrevented,legacyPreserved:!legacy.defaultPrevented,newlinePreserved:!newline.defaultPrevented,enterPreserved:!enter.defaultPrevented,handoffLabel:send.textContent.includes('带草稿到 Loom')};})()`,
  draftCleanup: `(() => {if(window.__beingTownDraftAudit){const el=document.getElementById('fireside-draft');if(el?.value==='Town 本机草稿审查，未发送。'){el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));}delete window.__beingTownDraftAudit;}return true;})()`
});
const CHANNEL_SCRIPTS = Object.freeze(Object.fromEntries(['feishu','wechat','wecom'].map(id=>[id,`(() => {const el=document.querySelector('.ta-channel [data-channel="${id}"]');if(!el)return false;el.scrollIntoView({block:'nearest'});el.click();return true;})()`])));

// This fixed feature list comes from the reviewed product requirement, not the
// application's catalog module. The scripts never interpolate page data.
const FEATURE_SCRIPTS = Object.freeze(Object.fromEntries(FEATURE_IDS.map(id => [id, Object.freeze({
  prepare: `(() => { const el = document.querySelector('#sidebar-town-content button[data-town-feature="${id}"]'); if (!el) return false; el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return true; })()`,
  select: `(() => { const el = document.querySelector('#sidebar-town-content button[data-town-feature="${id}"]'); if (!el || el.disabled) return false; el.click(); return true; })()`
})])));

async function runTownUiAudit({ win, execute, observe, settle, check, report }) {
  const town = { actionScope: 'Native Town modules, local wizards, reversible local draft and Portal deployment review only; no external pages, remote sends, private API calls or installation.', observations: [],modules:[] };
  report.town = town;
  const snapshot = async phase => {
    await settle();
    const result = await execute(TOWN_SCRIPTS.snapshot);
    town.observations.push({ phase, ...result });
    return result;
  };
  const idsEqual = values => values.length === FEATURE_IDS.length && new Set(values).size === FEATURE_IDS.length && FEATURE_IDS.every(id => values.includes(id));
  const filteredIds = result => result.rows.filter(row => row.rendered).map(row => row.id);
  const assertCatalog = (phase, result, configured) => {
    check(`${phase}.nine-feature-rows`, idsEqual(result.rows.map(row => row.id)), { count: result.rows.length });
    check(`${phase}.nine-sidebar-features`, idsEqual(result.sidebar.map(row => row.id)), { count: result.sidebar.length });
    check(`${phase}.displayed-count-nine`, result.count === 9, { actual: result.count });
    const incorrectModes = result.rows.filter(row => row.mode !== (EXPECTED_MODES[row.id] || 'being')).map(row => row.id);
    check(`${phase}.reviewed-action-types`, incorrectModes.length === 0 && result.rows.length === 9, { incorrectModes });
    if (!configured) {
      const draftRows = result.rows.filter(row => row.mode === 'being');
      const invalid = draftRows.filter(row => !row.actionExists || !row.actionDisabled || row.availability !== 'connection-required' || row.actionClaimsReady).map(row => row.id);
      check(`${phase}.unconfigured-being-actions-disabled`, draftRows.length === 1 && invalid.length === 0, { count: draftRows.length, invalid });
      check(`${phase}.connection-required-note`, result.connectionNoteVisible);
    }
  };

  check('town.navigation-exists', await execute(TOWN_SCRIPTS.open));
  check('town.initial-controls', await execute(TOWN_SCRIPTS.normalize));
  const initialShell = await observe('town-01-overview-1440');
  check('town.page-active-native-hidden', initialShell.page === 'town' && !initialShell.native.visible);
  const initial = await snapshot('overview-1440');
  assertCatalog('town.initial', initial, initialShell.connection.configured);

  for (const [language, script] of [['english', TOWN_SCRIPTS.english], ['chinese', TOWN_SCRIPTS.chinese]]) {
    check(`town.search-${language}-input`, await execute(script));
    const result = await snapshot(`search-${language}`);
    const filtered = filteredIds(result);
    check(`town.search-${language}-fireside`, filtered.length === 1 && filtered[0] === 'fireside' && !result.emptyVisible, { filtered });
  }
  await execute(TOWN_SCRIPTS.missing);
  const empty = await snapshot('search-empty');
  check('town.search-empty-result', filteredIds(empty).length === 0 && empty.emptyVisible, { count: filteredIds(empty).length, emptyVisible: empty.emptyVisible });
  check('town.search-clear-control', await execute(TOWN_SCRIPTS.clear));
  const cleared = await snapshot('search-cleared');
  check('town.search-clear-restores-nine', cleared.searchEmpty && !cleared.emptyVisible && idsEqual(filteredIds(cleared)), { count: filteredIds(cleared).length });

  check('town.section-collapse-control', await execute(TOWN_SCRIPTS.toggleSection));
  const sectionClosed = await snapshot('section-collapsed');
  check('town.section-collapsed', !sectionClosed.sidebarExpanded && !sectionClosed.sidebarContentRendered);
  await execute(TOWN_SCRIPTS.toggleSection);
  const sectionOpen = await snapshot('section-expanded');
  check('town.section-restored', sectionOpen.sidebarExpanded && sectionOpen.sidebarContentRendered && idsEqual(sectionOpen.sidebar.map(item => item.id)));
  const groupCount = await execute(TOWN_SCRIPTS.collapseGroups);
  const groupsClosed = await snapshot('groups-collapsed');
  check('town.groups-collapse', groupCount > 0 && groupsClosed.groups.every(group => !group.expanded) && groupsClosed.sidebar.every(item => !item.rendered), { groups: groupCount });
  await execute(TOWN_SCRIPTS.expandGroups);
  const groupsOpen = await snapshot('groups-restored');
  check('town.groups-restore', groupsOpen.groups.length === groupCount && groupsOpen.groups.every(group => group.expanded) && groupsOpen.sidebar.every(item => item.rendered));

  for (const id of FEATURE_IDS) {
    check(`town.select-${id}-exists`, await execute(FEATURE_SCRIPTS[id].prepare));
    const before = await snapshot(`before-select-${id}`);
    const item = before.sidebar.find(candidate => candidate.id === id);
    check(`town.select-${id}-reachable`, item?.visible && item.uncovered, { rect: item?.rect || null });
    check(`town.select-${id}-click`, await execute(FEATURE_SCRIPTS[id].select));
    const shell = await observe(`town-select-${id}`, { capture: APP_IDS.includes(id) });
    const selected = await snapshot(`selected-${id}`);
    const row = selected.rows.find(candidate => candidate.id === id);
    if (APP_IDS.includes(id)) {
      const active = selected.app.modules.filter(module=>module.visible);
      check(`town.select-${id}-native-module`,shell.page==='town-app'&&!shell.native.visible&&selected.app.visible&&selected.app.id===id&&active.length===1&&active[0].id===id,{active});
    } else {
      check(`town.select-${id}-visible-detail`, shell.page === 'town' && !shell.native.visible && row?.selected && row.visible && row.actionVisible && row.actionUncovered,
        { selected: Boolean(row?.selected), visible: Boolean(row?.visible), actionVisible: Boolean(row?.actionVisible), actionUncovered: Boolean(row?.actionUncovered), rect: row?.rect || null });
    }
  }

  win.setSize(1000, 700, false);
  await execute(TOWN_SCRIPTS.open);
  await execute(TOWN_SCRIPTS.top);
  const narrowShell = await observe('town-02-overview-1000');
  check('town.minimum-size', narrowShell.page === 'town' && narrowShell.viewport.width === 1000 && narrowShell.viewport.height === 700);
  const narrow = await snapshot('overview-1000');
  assertCatalog('town.narrow', narrow, narrowShell.connection.configured);
  await execute(FEATURE_SCRIPTS.fireside.prepare);
  const narrowSidebar = await snapshot('narrow-fireside-control');
  const firesideControl = narrowSidebar.sidebar.find(item => item.id === 'fireside');
  check('town.narrow-sidebar-last-feature-reachable', firesideControl?.visible && firesideControl.uncovered);
  await execute(FEATURE_SCRIPTS.fireside.select);
  const narrowSelected = await snapshot('narrow-fireside-selected');
  check('town.narrow-last-module-reachable', narrowSelected.app.id==='fireside'&&narrowSelected.app.visible);

  for (const id of APP_IDS) {
    await execute(FEATURE_SCRIPTS[id].select);
    const shell = await observe(`town-module-${id}-1000`);
    const module = await execute(MODULE_SCRIPTS.snapshot);
    town.modules.push({width:1000,...module});
    check(`town.module-${id}-1000-native-hidden`,shell.page==='town-app'&&!shell.native.visible&&module.id===id&&module.root.visible);
    const primaryId = {grove:'grove-search',channel:'channel-connect',portal:'portal-app-workspace',fireside:'fireside-draft',bonfire:'bonfire-draft',scroll:'scroll-search',beings:'beings-search'}[id];
    const control = module.controls[primaryId];
    check(`town.module-${id}-1000-primary-reachable`,control?.visible&&control.uncovered&&!control.clipped,{control});
    if(id==='grove') {
      check('town.grove-real-load-state',module.grove.searchPresent&&module.grove.browseVisible&&!module.grove.detailVisible&&(module.grove.rows>0||module.grove.loading||module.grove.error||module.grove.empty),module.grove);
      await execute(MODULE_SCRIPTS.groveMissing);
      const filtered = await execute(MODULE_SCRIPTS.snapshot);
      check('town.grove-search-no-invented-results',filtered.grove.rows===0&&(filtered.grove.empty||filtered.grove.loading||filtered.grove.error),filtered.grove);
      await execute(MODULE_SCRIPTS.groveClear);
    }
    if(id==='channel') {
      check('town.channel-three-platform-cards',module.channel.cards.length===3&&['feishu','wechat','wecom'].every(id=>module.channel.cards.some(card=>card.id===id&&card.visible&&card.uncovered&&!card.clipped)),module.channel);
      for(const channel of ['feishu','wechat']) {
        await execute(CHANNEL_SCRIPTS[channel]);
        // Registration can mutate a real Town channel. Exercise that flow only in the offline fixture.
        const setup = await execute(MODULE_SCRIPTS.snapshot);
        check(`town.channel-${channel}-setup-action-visible`,Boolean(setup.controls['channel-connect']?.visible),setup.channel);
      }
      await execute(CHANNEL_SCRIPTS.wecom);
      check('town.channel-wecom-distinct-unsupported',(await execute(MODULE_SCRIPTS.snapshot)).channel.wecomUnsupported);
      await execute(CHANNEL_SCRIPTS.feishu);
    }
    if(id==='portal') {
      check('town.portal-plan-without-verified-capability-claims',module.portal.permissions.length===4&&module.portal.permissions.every(item=>item.exists&&!item.interactive&&item.text.length>12)&&module.portal.sandboxLimitVisible&&module.portal.planUnverified,module.portal);
      if(module.portal.workspaceMissing||!shell.connection.configured||shell.connection.status!=='connected')check('town.portal-deployment-prerequisites-enforced',module.controls['portal-app-deploy']?.disabled===true,module.portal);
      else if(await execute(MODULE_SCRIPTS.portalReview)) {
        const review=await execute(MODULE_SCRIPTS.snapshot);
        check('town.portal-one-click-plan-visible',!review.portal.confirmVisible&&Boolean(review.controls['portal-app-deploy']),review.portal);
      }
    }
    if(id==='fireside') {
      check('town.fireside-three-column-structure',module.fireside.columns.length===3&&module.fireside.columns.every(column=>column.present));
      if(module.fireside.locked)check('town.fireside-locked-without-invented-data',module.fireside.rooms===0&&module.fireside.members===0&&module.fireside.messages===0&&module.controls['fireside-send']?.disabled,module.fireside);
      try {
        const draft=await execute(MODULE_SCRIPTS.draftStart);
        if(draft.started){check('town.fireside-local-enter-and-ime-never-submit',draft.composingPreserved&&draft.legacyPreserved&&draft.newlinePreserved&&draft.enterPreserved&&draft.handoffLabel,draft);await execute(FEATURE_SCRIPTS.channel.select);await execute(FEATURE_SCRIPTS.fireside.select);check('town.fireside-local-draft-survives-module-switch',(await execute(MODULE_SCRIPTS.snapshot)).fireside.draftPreserved);}
      } finally {await execute(MODULE_SCRIPTS.draftCleanup);}
    }
  }
  await execute(TOWN_SCRIPTS.normalize);
  win.setSize(1440, 940, false);
}

module.exports = { runTownUiAudit };



