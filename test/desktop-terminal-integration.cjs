'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { stripVTControlCharacters } = require('node:util');
const { createRequire } = require('node:module');

const verifyArchive = process.argv.includes('--archive');
const archive = path.resolve(__dirname, '../dist-0.8.0/win-unpacked/resources/app.asar');
let terminalModule = path.resolve(__dirname, '../src/desktop-terminal.cjs');
let packagedPtyModule = null;
let DesktopTerminal;
const electron = process.versions.electron ? require('electron') : null;

function initializeFixture() {
  if (electron) {
    const profile = path.resolve(__dirname, `../.local/terminal-native-fixtures/electron-profile-${process.pid}`);
    fsSync.mkdirSync(profile, { recursive: true });
    electron.app.setPath('userData', profile);
    electron.app.disableHardwareAcceleration();
  }
  if (verifyArchive) {
    assert.ok(electron, 'Archive verification must run in Electron with ASAR support.');
    // Electron's patched fs presents ASAR as a virtual directory. original-fs
    // checks the physical archive; module resolution still uses ASAR-aware fs.
    assert.ok(require('original-fs').statSync(archive).isFile(), 'The exact production archive must exist.');
    terminalModule = path.join(archive, 'src/desktop-terminal.cjs');
    const archivedRequire = createRequire(terminalModule);
    assert.equal(archivedRequire.resolve(terminalModule), terminalModule);
    assert.equal(archivedRequire(path.join(archive, 'package.json')).version, '0.8.0');
    packagedPtyModule = archivedRequire.resolve('node-pty');
    const packageRoot = path.join(archive, 'node_modules/node-pty') + path.sep;
    const unpackedPackageRoot = path.join(archive + '.unpacked', 'node_modules/node-pty') + path.sep;
    assert.ok(packagedPtyModule.startsWith(packageRoot) || packagedPtyModule.startsWith(unpackedPackageRoot), `node-pty must resolve inside the production archive or its unpacked directory, never the workspace. Resolved: ${packagedPtyModule}`);
    const nativeRoot = path.join(archive + '.unpacked', 'node_modules/node-pty/prebuilds/win32-x64');
    for (const relative of ['conpty.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']) {
      assert.ok(fsSync.statSync(path.join(nativeRoot, relative)).isFile(), `Production unpacked native asset missing: ${relative}`);
    }
  }
  ({ DesktopTerminal } = require(terminalModule));
}
const checks = [];
const observers = new Set();
let service;

function view(id) {
  const state = service.snapshot().sessions.find(item => item.id === id);
  return { state, text: state ? stripVTControlCharacters(service.read(id).data) : '' };
}

function waitFor(id, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      observers.delete(observe);
      reject(new Error(`Terminal fixture condition timed out: ${view(id).text.slice(-1200)}`));
    }, 25000);
    function observe() {
      const current = view(id);
      if (!predicate(current)) return;
      clearTimeout(timer);
      observers.delete(observe);
      resolve(current);
    }
    observers.add(observe);
    observe();
  });
}

function send(id, command) { service.write({ id, data: `${command}\r` }); }
function exists(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }

async function main() {
  if (process.platform !== 'win32') throw new Error('This ConPTY integration fixture requires Windows.');
  initializeFixture();
  if (electron) await electron.app.whenReady();
  const base = path.resolve(__dirname, '../.local/terminal-native-fixtures');
  await fs.mkdir(base, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(base, 'terminal-'));
  for (const relative of ['child', 'AppData/Roaming', 'AppData/Local', 'tmp']) await fs.mkdir(path.join(workspace, relative), { recursive: true });
  service = new DesktopTerminal({
    getWorkspace: () => workspace,
    environment: {
      ...process.env, USERPROFILE: workspace, HOME: workspace, APPDATA: path.join(workspace, 'AppData/Roaming'),
      LOCALAPPDATA: path.join(workspace, 'AppData/Local'), TEMP: path.join(workspace, 'tmp'), TMP: path.join(workspace, 'tmp'),
      BEING_TOKEN: 'fixture-private-value', OPENAI_API_KEY: 'fixture-private-value', HTTP_PROXY: 'http://fixture-private-value@127.0.0.1',
    },
    onChange: () => { for (const observe of observers) observe(); },
    onData: ({ id, data }) => {
      // A real terminal answers DSR; this headless fixture supplies the same reply.
      if (data.includes('\x1b[6n')) service.write({ id, data: '\x1b[1;1R' });
      for (const observe of observers) observe();
    },
  });
  try {
    const { sessionId: first } = await service.create({ cols: 100, rows: 28 });
    await waitFor(first, current => /PS .*?>/.test(current.text));
    send(first, "$fixtureVariable = 41; if($env:BEING_TOKEN -or $env:OPENAI_API_KEY -or $env:HTTP_PROXY){throw 'unexpected fixture env'}; Write-Output ('TERMINAL_'+'READY'); Write-Output ('中文'+'输出🙂')");
    await waitFor(first, current => current.text.includes('TERMINAL_READY') && current.text.includes('中文输出🙂'));
    checks.push('Interactive ConPTY startup, Unicode output and filtered secret environment');

    send(first, "Set-Location child; Write-Output ('PERSIST_' + ($fixtureVariable + 1)); Write-Output ('CURRENT_' + (Get-Location).Path)");
    const persistent = await waitFor(first, current => current.text.includes('PERSIST_42') && current.text.includes('CURRENT_' + path.join(workspace, 'child')));
    assert.equal(persistent.state.status, 'running');
    service.resize({ id: first, cols: 120, rows: 36 });
    assert.equal(service.snapshot().sessions[0].cols, 120);
    checks.push('One shell preserves variables and cd across commands and resizes without recreation');

    send(first, "$answer = Read-Host 'fixture input'; Write-Output ('ANSWER_' + $answer)");
    await waitFor(first, current => current.text.includes('fixture input:'));
    service.write({ id: first, data: 'interactive-ok\r' });
    await waitFor(first, current => current.text.includes('ANSWER_interactive-ok'));
    send(first, "Write-Output ('BEFORE_'+'INTERRUPT'); Start-Sleep -Seconds 120");
    await waitFor(first, current => current.text.includes('BEFORE_INTERRUPT'));
    service.write({ id: first, data: '\x03' });
    await waitFor(first, current => /PS [^\r\n]+>\s*$/.test(current.text.slice(current.text.lastIndexOf('BEFORE_INTERRUPT') + 'BEFORE_INTERRUPT'.length)));
    send(first, "Write-Output ('AFTER_'+'INTERRUPT')");
    await waitFor(first, current => current.text.includes('AFTER_INTERRUPT'));
    checks.push('Read-Host accepts live input; Ctrl+C interrupts the active command while preserving the shell');

    const { sessionId: second } = await service.create();
    await waitFor(second, current => /PS .*?>/.test(current.text));
    const independentPid = service.snapshot().sessions.find(item => item.id === second).pid;
    const childCode = Buffer.from("Write-Output ('ATTACHED_PID:' + $PID); Start-Sleep -Seconds 120", 'utf16le').toString('base64');
    send(first, `& "$PSHOME\\powershell.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${childCode}`);
    const attached = await waitFor(first, current => /ATTACHED_PID:(\d+)/.test(current.text));
    const childPid = Number(attached.text.match(/ATTACHED_PID:(\d+)/)[1]);
    assert.equal(exists(childPid), true);
    await service.close(first);
    assert.equal(exists(childPid), false);
    assert.equal(exists(independentPid), true);
    send(second, "Write-Output ('SECOND_'+'SURVIVES')");
    await waitFor(second, current => current.text.includes('SECOND_SURVIVES'));
    checks.push('Closing a PTY terminates its attached child console process and preserves another session');

    send(second, 'exit 7');
    const exited = await waitFor(second, current => current.state?.status === 'exited');
    assert.equal(exited.state.exitCode, 7);
    assert.ok(exited.text.includes('SECOND_SURVIVES'));
    await service.close(second);
    assert.equal(service.snapshot().sessions.length, 0);
    checks.push('Natural exit retains final output and exit code until the terminal tab is closed');
    if (verifyArchive) {
      assert.ok(require.cache[terminalModule], 'The actual production terminal module was not loaded.');
      assert.ok(require.cache[packagedPtyModule], 'The actual production node-pty module was not loaded.');
      for (const key of Object.keys(require.cache)) {
        if (/[\\/]node_modules[\\/]node-pty[\\/]/.test(key)) {
          assert.ok(key.startsWith(archive + path.sep) || key.startsWith(archive + '.unpacked' + path.sep), 'A workspace node-pty module was loaded.');
        }
      }
      checks.push('Production app.asar terminal and bundled node-pty only; unpacked native DLL and worker load without workspace fallback');
    }
    process.stdout.write(JSON.stringify({ passed: true, runtime: electron ? `Electron ${process.versions.electron}` : `Node ${process.versions.node}`, productionArchive: verifyArchive, checks }, null, 2) + '\n');
  } finally { await service.dispose(); }
}

main().then(() => { if (electron) electron.app.exit(0); }).catch(error => {
  process.stderr.write((error.stack || String(error)) + '\n');
  if (electron) electron.app.exit(1);
  else process.exitCode = 1;
});
