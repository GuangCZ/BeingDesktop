'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {app,dialog} = require('electron');

if (process.platform !== 'darwin' || app.isPackaged) throw new Error('Use development Electron on macOS.');
if (process.env.BEING_LOOM_URL) throw new Error('Mac checks require an isolated account-free profile.');
const root=path.resolve(__dirname,'../.local/mac-validation');
fs.mkdirSync(root,{recursive:true});
const profile=fs.mkdtempSync(path.join(root,'electron-profile-'));
process.env.BEING_DATA_DIR=profile;
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1);};
const deadline=setTimeout(()=>{console.error('Mac Electron test timed out');app.exit(1);},45000);

require('../src/main.cjs').startDesktop({portalUpdateChecksEnabled:false,onReady:async({win,getState,refresh,shutdown,stopRefresh})=>{
  const report={passed:false,checks:[]};
  const execute=expression=>win.webContents.executeJavaScript(expression);
  const check=(label,condition)=>{assert.ok(condition,label);report.checks.push(label);console.log(label);};
  try {
    console.log('Mac check: window ready');
    win.webContents.setBackgroundThrottling(false);
    win.showInactive();
    stopRefresh();await refresh();
    const state=getState();
    check('macOS capabilities reach the renderer',state.machine.platform==='darwin' && state.machine.shell==='zsh' && state.townApp.platformSupported);
    check('process inspection succeeds without account credentials',state.portal.status!=='error' && !state.connection.configured);
    report.portal={status:state.portal.status,owned:state.portal.owned};
    // Keep the renderer fixture stable across unrelated backend state events.
    // No account or Portal process is created by this visual-only fixture.
    await execute(`(async()=>{
      window.macOriginalOnboardingSetState=window.beingOnboarding.setState;
      window.beingOnboarding.setState=state=>window.macOriginalOnboardingSetState({...state,onboarding:{step:'portal',completed:false},portal:{status:'external',health:'unknown',owned:false,pid:123}});
      window.beingOnboarding.setState(await window.beingDesktop.getState());
    })()`);
    for(let i=0;i<100;i++) {
      if(await execute(`!document.documentElement.dataset.setupDirection && document.querySelector('#setup-wizard').getAttribute('aria-labelledby') === 'setup-title-portal'`))break;
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    check('external Portal onboarding offers continue and hides deployment',await execute(`document.querySelector('#setup-wizard').open && !document.querySelector('[data-card="portal"]').hidden && !document.documentElement.dataset.setupDirection && document.querySelector('#setup-portal-deploy').hidden && !document.querySelector('#setup-portal-next').hidden && document.querySelector('#setup-title-portal').textContent.includes('已有') && !document.querySelector('#setup-feedback-portal').classList.contains('is-error')`));
    fs.writeFileSync(path.join(root,'portal-step.png'),(await win.webContents.capturePage()).toPNG());
    await execute(`window.beingOnboarding.setState=window.macOriginalOnboardingSetState;delete window.macOriginalOnboardingSetState`);
    const initial=await execute(`window.beingDesktop.terminalAction('create',{cwd:${JSON.stringify(profile)}})`);
    const id=initial.activeSessionId;
    check('real native PTY starts zsh',initial.sessions[0].title==='zsh' && initial.sessions[0].status==='running');
    await execute(`document.querySelector('#setup-close')?.click();window.beingTools.show('console')`);
    check('terminal can be revealed in the actual UI',await execute(`window.beingTerminal.reveal(${JSON.stringify(id)})`));
    const command="printf '\\nMAC_PTY_%s\\n' '中文'; printf 'ZSH=%s\\n' \"$ZSH_VERSION\"\r";
    await execute(`window.beingDesktop.terminalAction('write',{id:${JSON.stringify(id)},data:${JSON.stringify(command)}})`);
    let output='';
    for(let i=0;i<100;i++) {
      output=(await execute(`window.beingDesktop.readTerminal(${JSON.stringify(id)})`)).data;
      if(output.includes('MAC_PTY_中文') && /ZSH=\d/.test(output))break;
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    check('interactive zsh executes and returns Unicode through IPC',output.includes('MAC_PTY_中文') && /ZSH=\d/.test(output));
    await execute(`window.beingDesktop.terminalAction('resize',{id:${JSON.stringify(id)},cols:90,rows:24})`);
    await new Promise(resolve=>setTimeout(resolve,150));
    const screenshot=await win.webContents.capturePage();
    fs.writeFileSync(path.join(root,'terminal.png'),screenshot.toPNG());
    await execute(`window.beingDesktop.terminalAction('close',${JSON.stringify(id)})`);
    check('PTY close confirms termination',(await execute('window.beingDesktop.getTerminalState()')).sessions.length===0);
    await execute(`window.beingDesktop.desktopAction('console.run',{cwd:${JSON.stringify(profile)},command:"printf MAC_CONSOLE_OK"})`);
    let job;
    for(let i=0;i<100;i++) {
      job=(await execute('window.beingDesktop.getDesktopTools()')).console.jobs.at(-1);
      if(job?.status==='completed')break;
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    check('console executes through production IPC',job?.status==='completed' && job.output.some(item=>item.text.includes('MAC_CONSOLE_OK')));
    check('renderer retains Node isolation',await execute("typeof require === 'undefined' && typeof process === 'undefined'"));
    report.passed=true;
  } catch(error) {report.error=error.message;process.exitCode=1;}
  finally {
    clearTimeout(deadline);
    fs.writeFileSync(path.join(root,'electron-report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
    await shutdown();
    if(!report.passed)app.exit(1);
  }
}});
