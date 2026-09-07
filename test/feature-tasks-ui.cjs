'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {randomUUID, createHash} = require('node:crypto');
const {pathToFileURL, fileURLToPath} = require('node:url');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const {spawn} = require('node:child_process');
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], {cwd: root, env, windowsHide: true, stdio: 'inherit'});
  child.on('error', error => {process.stderr.write(`${error.message}\n`); process.exitCode = 1;});
  child.on('exit', code => {process.exitCode = code ?? 1;});
} else {
  const {app, BrowserWindow} = require('electron');
  const runRoot = path.join(root, '.local', `feature-tasks-ui-${randomUUID()}`);
  const entry = path.join(__dirname, 'feature-tasks-fixture.html');
  const report = {scope: 'Offline feature task renderer fixture; no Being connection or chat message.', checks: [], screenshots: [], errors: [], blockedRequests: []};
  let win;
  app.setPath('userData', path.join(runRoot, 'profile'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('force-prefers-reduced-motion');
  app.on('window-all-closed', () => {});
  const check = (name, passed, detail) => {report.checks.push({name, passed: Boolean(passed), ...(detail === undefined ? {} : {detail})}); assert(passed, name);};
  const execute = script => {assert.equal(win.webContents.getURL(), pathToFileURL(entry).href); return win.webContents.executeJavaScript(script);};
  const settle = () => execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const condition = async script => {for (let i = 0; i < 100; i++) {if (await execute(`Boolean(${script})`)) return; await settle();} throw new Error(`Unmet fixture condition: ${script}`);};
  const publish = tasks => execute(`featureTasksFixture.state.listener({tasks:${JSON.stringify(tasks)}})`);
  const click = selector => execute(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const select = (selector, value) => execute(`(() => {const e=document.querySelector(${JSON.stringify(selector)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const readCalls = () => execute("featureTasksFixture.state.calls.filter(c=>c.method==='getFeatureTasks').length");
  const tasks = [
    {id: 'bonfire-running', feature: 'bonfire', operation: 'read', title: '读取篝火消息', status: 'running', execution: 'being', mayDelayChat: true, detail: '已发送读取请求，等待 Being 的工具结果。', summary: '', createdAt: 1788763800000, updatedAt: 1788763900000, finishedAt: null},
    {id: 'portal-ready', feature: 'portal', operation: 'check', title: '检查 Portal 更新', status: 'succeeded', execution: 'local', mayDelayChat: false, summary: '当前 Portal 已是最新版本。', detail: '0.5.0', createdAt: 1788762800000, updatedAt: 1788762900000, finishedAt: 1788762900000},
    {id: 'grove-decision', feature: 'grove', operation: 'install', title: '安装 Codex 工具', status: 'needs_input', execution: 'local', mayDelayChat: false, summary: '选择安装位置后继续。', createdAt: 1788761800000, updatedAt: 1788761900000, finishedAt: null},
    {id: 'scroll-failed', feature: 'scroll', operation: 'read', title: '读取卷轴目录', status: 'failed', execution: 'being', mayDelayChat: true, summary: '连接暂时中断，目录未能读取。', detail: '已保留上次阅读位置。', createdAt: 1788760800000, updatedAt: 1788760900000, finishedAt: 1788760900000},
  ];

  async function capture(name) {
    await settle();
    let image, previous = '', stable = 0;
    for (let attempt = 0; attempt < 25 && stable < 2; attempt++) {
      const painted = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {win.webContents.removeListener('paint', listener); reject(new Error('Offscreen paint timed out'));}, 5000);
        const listener = (_event, _dirty, result) => {clearTimeout(timer); win.webContents.removeListener('paint', listener); resolve(result);};
        win.webContents.on('paint', listener);
      });
      win.webContents.invalidate(); image = await painted;
      const hash = createHash('sha256').update(image.toBitmap()).digest('hex');
      stable = hash === previous ? stable + 1 : 0; previous = hash;
      await settle();
    }
    assert(stable >= 2, 'Screenshot did not settle');
    const output = path.join(runRoot, `${name}.png`);
    await fs.writeFile(output, image.toPNG()); report.screenshots.push(output);
  }

  async function run() {
    await fs.mkdir(runRoot, {recursive: true}); await app.whenReady();
    win = new BrowserWindow({show: false, frame: false, width: 1060, height: 780, useContentSize: true, webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: `feature-tasks-${randomUUID()}`}});
    win.webContents.setFrameRate(30);
    win.webContents.on('console-message', event => {if (event.level === 'error') report.errors.push(event.message);});
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url.startsWith('file:') && fileURLToPath(details.url).startsWith(root + path.sep);
      if (!allowed) report.blockedRequests.push(details.url); callback({cancel: !allowed});
    });
    await win.loadFile(entry); await condition('window.featureTasksFixture?.state.read');
    check('loading-state-is-visible', await execute("document.querySelector('.ft-empty h3').textContent==='正在读取任务…'&&document.querySelector('.feature-tasks').getAttribute('aria-busy')==='true'"));
    await publish(tasks); await execute('featureTasksFixture.state.read.resolve({tasks:[]})'); await settle();
    check('live-update-wins-over-stale-initial-list', await execute("document.querySelectorAll('.ft-task').length===4&&document.querySelector('.ft-detail h3').textContent==='读取篝火消息'"));
    check('being-task-discloses-chat-contention', await execute("document.querySelector('.ft-execution').textContent==='使用 Being，聊天可能等待'"));
    check('running-task-does-not-offer-ending-local-tracking', await execute("!document.querySelector('[data-action=end-tracking]')"));
    await publish(tasks.map(task=>task.id==='bonfire-running'?{...task,requestId:'accepted-native-get'}:task));
    check('submitted-read-offers-ending-local-result-polling', await execute("document.querySelector('[data-action=end-tracking]').textContent==='结束本地跟踪'"));
    await publish(tasks);
    check('viewing-tasks-does-not-prepare-chat', await execute("featureTasksFixture.state.calls.every(c=>c.method==='getFeatureTasks')&&featureTasksFixture.state.drafts.length===0"));
    await click('[data-task-id="portal-ready"]');
    check('native-task-does-not-claim-model-use', await execute("document.querySelector('.ft-execution').textContent==='本机执行'"));
    await publish([...tasks.map(task => task.id === 'bonfire-running' ? {...task, status: 'waiting'} : task)]);
    check('selection-survives-background-task-updates', await execute("document.querySelector('.ft-detail h3').textContent==='检查 Portal 更新'"));
    await select('[aria-label="按状态筛选"]', 'needs_input');
    check('decision-filter-shows-only-local-action-needed', await execute("document.querySelectorAll('.ft-task').length===1&&document.querySelector('[data-action=navigate]').textContent==='到功能页处理'"));
    check('decision-task-offers-local-tracking-control', await execute("document.querySelector('[data-action=end-tracking]').textContent==='结束本地跟踪'"));
    await click('[data-action="navigate"]');
    check('decision-navigates-to-feature-without-sending', await execute("featureTasksFixture.state.navigation[0].feature==='grove'&&featureTasksFixture.state.navigation[0].id==='grove-decision'&&featureTasksFixture.state.drafts.length===0"));
    await select('[aria-label="按状态筛选"]', 'all'); await select('[aria-label="按功能筛选"]', 'scroll');
    check('feature-filter-shows-corresponding-failure', await execute("document.querySelectorAll('.ft-task').length===1&&document.querySelector('.ft-result h4').textContent==='未完成的原因'&&document.querySelector('.ft-result p').textContent.includes('连接暂时中断')"));
    await capture('01-failed-task-1060');
    await click('[data-action="discuss"]'); await click('[data-action="discuss"]');
    check('explicit-discussion-deduplicates-pending-clicks', await execute("featureTasksFixture.state.calls.filter(c=>c.method==='discussFeatureTask').length===1&&document.querySelector('[data-action=discuss]').disabled"));
    await execute("featureTasksFixture.state.discussion.resolve({prepared:true,taskId:'scroll-failed'})"); await settle();
    check('discussion-only-produces-reviewable-draft', await execute("featureTasksFixture.state.drafts.length===1&&featureTasksFixture.state.drafts[0].draft.prepared===true&&featureTasksFixture.state.drafts[0].id==='scroll-failed'&&document.querySelector('.ft-draft-hint').textContent.includes('编辑后由你发送')"));
    await click('[data-action="discuss"]'); await execute("featureTasksFixture.state.discussion.reject(new Error('准备草稿失败，请重试。'))"); await settle();
    check('draft-failure-keeps-task-and-result-visible', await execute("document.querySelector('.ft-draft-hint').textContent==='准备草稿失败，请重试。'&&document.querySelector('.ft-result p').textContent.includes('连接暂时中断')&&!document.querySelector('[data-action=discuss]').disabled"));
    await select('[aria-label="按状态筛选"]', 'succeeded');
    check('empty-filter-has-guidance', await execute("document.querySelector('.ft-empty h3').textContent==='没有符合筛选的任务'"));
    await execute("featureTasksFixture.controller.select('bonfire-running')");
    check('programmatic-selection-clears-unrelated-filters', await execute("document.querySelector('.ft-detail h3').textContent==='读取篝火消息'&&document.querySelectorAll('.ft-task').length===4"));
    const malicious = {...tasks[0], id: 'untrusted', title: '<img src=x onerror=alert(1)>', summary: '<script>window.compromised=true</script>', status: 'succeeded'};
    await publish([malicious]);
    check('task-result-is-inert-text', await execute("document.querySelector('.ft-detail h3').textContent.includes('<img')&&document.querySelector('.ft-result p').textContent.includes('<script>')&&!document.querySelector('.feature-tasks img')&&!window.compromised"));
    await publish(tasks); await execute("featureTasksFixture.controller.select('grove-decision')");
    await capture('02-decide-task-1060');
    win.setContentSize(430, 790); await condition('innerWidth===430'); await capture('03-task-narrow-430');
    const geometry = await execute("({viewport:innerWidth,body:document.documentElement.scrollWidth,root:document.querySelector('.feature-tasks').scrollWidth,content:document.querySelector('.ft-content').scrollWidth,detail:document.querySelector('.ft-detail').scrollWidth})");
    check('narrow-layout-has-no-horizontal-overflow', Object.entries(geometry).filter(([key]) => key !== 'viewport').every(([, width]) => width <= geometry.viewport), geometry);
    const beforeRefresh = await readCalls(); await click('.ft-header .ft-button'); await condition('featureTasksFixture.state.read');
    await execute("featureTasksFixture.state.read.reject(new Error('读取任务列表失败，请重试。'))"); await settle();
    check('refresh-list-failure-preserves-previous-result', await execute("document.querySelector('.ft-notice').textContent==='读取任务列表失败，请重试。'&&document.querySelectorAll('.ft-task').length===4&&document.querySelector('.ft-detail h3').textContent==='安装 Codex 工具'"));
    check('refresh-only-reads-local-list-once', await readCalls() === beforeRefresh + 1);
    await execute(`featureTasksFixture.state.listener({tasks:${JSON.stringify(tasks)},persistenceError:true})`);
    check('persistence-failure-warns-without-clearing-tasks', await execute("document.querySelector('.ft-notice').textContent.includes('任务记录暂未保存，重启后可能无法恢复。当前操作不受影响。')&&document.querySelectorAll('.ft-task').length===4&&document.querySelector('.ft-detail h3').textContent==='安装 Codex 工具'"));
    await click('.ft-header .ft-button'); await execute("featureTasksFixture.state.read.reject(new Error('列表读取失败。'))"); await settle();
    check('read-error-preserves-persistence-warning', await execute("document.querySelector('.ft-notice').textContent.includes('列表读取失败。')&&document.querySelector('.ft-notice').textContent.includes('重启后可能无法恢复')"));
    await execute(`featureTasksFixture.state.listener({tasks:${JSON.stringify(tasks)},persistenceError:false})`);
    check('successful-persistence-clears-only-its-warning', await execute("document.querySelector('.ft-notice').textContent==='列表读取失败。'&&document.querySelectorAll('.ft-task').length===4"));
    const waitingTasks = tasks.map(task => task.id === 'bonfire-running' ? {...task, status: 'waiting'} : task);
    await publish(waitingTasks); await execute("featureTasksFixture.controller.select('bonfire-running')");
    check('ending-tracking-discloses-remote-execution-is-unchanged', await execute("document.querySelector('.ft-tracking-hint').textContent==='停止本地结果检查并关闭记录，Being 端执行不会取消。'"));
    const discussionCount = await execute("featureTasksFixture.state.calls.filter(c=>c.method==='discussFeatureTask').length");
    await click('[data-action="end-tracking"]'); await click('[data-action="end-tracking"]');
    check('ending-tracking-deduplicates-pending-clicks', await execute("featureTasksFixture.state.calls.filter(c=>c.method==='endFeatureTaskTracking').length===1&&document.querySelector('[data-action=end-tracking]').disabled"));
    await execute("featureTasksFixture.state.ending.reject(new Error('本地记录暂时无法更新，请重试。'))"); await settle();
    check('ending-tracking-failure-preserves-waiting-task', await execute("document.querySelector('.ft-status').textContent==='等待中'&&document.querySelector('.ft-tracking .ft-error').textContent==='本地记录暂时无法更新，请重试。'&&!document.querySelector('[data-action=end-tracking]').disabled"));
    await click('[data-action="end-tracking"]');
    const endedTasks = waitingTasks.map(task => task.id === 'bonfire-running' ? {...task, status: 'cancelled', detail: '', finishedAt: 1788764900000, updatedAt: 1788764900000} : task);
    await publish(endedTasks); await execute(`featureTasksFixture.state.ending.resolve(${JSON.stringify(endedTasks[0])})`); await settle();
    check('local-end-event-is-not-presented-as-remote-cancellation', await execute("document.querySelector('.ft-status').textContent==='已结束跟踪'&&document.querySelector('.ft-result p').textContent==='已结束本地跟踪，Being 端执行状态需另行确认。'&&!document.querySelector('[data-action=end-tracking]')"));
    check('ending-tracking-never-prepares-or-sends-chat', await execute("featureTasksFixture.state.calls.filter(c=>c.method==='discussFeatureTask').length") === discussionCount);
    await select('[aria-label="按状态筛选"]', 'cancelled');
    check('ended-tracking-filter-uses-local-wording', await execute("document.querySelector('[aria-label=按状态筛选]').selectedOptions[0].textContent==='已结束跟踪'&&document.querySelectorAll('.ft-task').length===1"));
    await execute('void featureTasksFixture.mount({feature:"portal"})'); await execute(`featureTasksFixture.state.read.resolve({tasks:${JSON.stringify(tasks)}})`); await settle();
    check('scoped-feature-panel-hides-unrelated-tasks', await execute("document.querySelectorAll('.ft-task').length===1&&document.querySelector('[aria-label=按功能筛选]').parentElement.hidden&&document.querySelector('.ft-detail h3').textContent==='检查 Portal 更新'"));
    check('remount-unsubscribes-previous-listener', await execute('featureTasksFixture.state.subscriptions===1'));
    await publish([]);
    check('empty-ledger-does-not-imply-being-job', await execute("document.querySelector('.ft-empty h3').textContent==='还没有功能任务'"));
    await execute('void featureTasksFixture.controller.refresh()'); await execute('featureTasksFixture.controller.destroy(); featureTasksFixture.state.read.resolve({tasks:[]})'); await settle();
    check('destroy-rejects-late-list-and-unsubscribes', await execute("featureTasksFixture.state.subscriptions===0&&!document.querySelector('.feature-tasks')"));
    check('no-remote-cancellation-or-background-chat-methods', await execute("featureTasksFixture.state.calls.every(c=>['getFeatureTasks','discussFeatureTask','endFeatureTaskTracking'].includes(c.method))"));
    check('fixture-window-is-never-shown', BrowserWindow.getAllWindows().every(item => !item.isVisible()));
    check('no-network-attempts', report.blockedRequests.length === 0, report.blockedRequests);
    check('no-renderer-errors', report.errors.length === 0, report.errors);
    report.passed = true;
  }

  let finishing = false;
  const deadline = setTimeout(() => {report.passed = false; report.error = 'Feature task UI fixture exceeded deadline.'; void finish();}, 60000);
  async function finish() {
    if (finishing) return; finishing = true; clearTimeout(deadline);
    if (win && !win.isDestroyed()) win.destroy();
    await fs.mkdir(runRoot, {recursive: true});
    const reportPath = path.join(runRoot, 'report.json'); await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({passed: report.passed, checks: report.checks.length, report: reportPath, screenshots: report.screenshots, error: report.error}) + '\n');
    app.exit(report.passed ? 0 : 1);
  }
  run().catch(error => {report.passed = false; report.error = error.stack || error.message;}).finally(finish);
}
