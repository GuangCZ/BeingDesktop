'use strict';
// Real electron-updater + loopback HTTP; deliberately never invokes an installer.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {randomUUID, createHash} = require('node:crypto');
if (!process.versions.electron) {
  const env = {...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], {env, stdio: 'inherit'});
  child.on('exit', code => {process.exitCode = code ?? 1;});
} else {
  const {app} = require('electron');
  const directory = path.resolve(__dirname, '../.local', `desktop-download-${randomUUID()}`);
  app.setPath('userData', path.join(directory, 'profile'));
  let server, engine;
  const deadline = setTimeout(() => {console.error('Download fixture timeout');app.exit(1);}, 30000);
  (async () => {
    await fs.mkdir(directory, {recursive: true});await app.whenReady();
    const {DesktopUpdates} = require('../src/desktop-updates.cjs');
    const {MacUpdater} = require('electron-updater');
    const bytes = Buffer.from('Synthetic update transport bytes; never an executable.');
    const name = 'Being-Desktop-99.0.0-macos-arm64.zip';
    let corrupt = false, downloads = 0;
    server = require('node:http').createServer((request, response) => {
      if (request.url.startsWith('/latest-mac.yml')) {
        response.setHeader('Content-Type', 'text/yaml');
        response.end(JSON.stringify({version: '99.0.0', files: [{url: name, size: bytes.length,
          sha512: createHash('sha512').update(corrupt ? 'different bytes' : bytes).digest('base64')}]}));
      } else if (request.url.startsWith(`/${name}`)) {
        downloads++;response.setHeader('Content-Length', bytes.length);response.end(bytes);
      } else {response.statusCode = 404;response.end();}
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    for (const bad of [false, true]) {
      corrupt = bad;
      const cache = path.join(directory, bad ? 'bad' : 'good');await fs.mkdir(cache, {recursive: true});
      const config = path.join(cache, 'app-update.yml');
      await fs.writeFile(config, JSON.stringify({updaterCacheDirName: 'test-cache'}));
      engine = new MacUpdater({provider: 'generic', url: `http://127.0.0.1:${server.address().port}`});
      engine.app = {version: app.getVersion(), name: 'Isolated update fixture', isPackaged: true,
        whenReady: () => app.whenReady(), userDataPath: cache, baseCachePath: cache, appUpdateConfigPath: config,
        quit: () => {throw new Error('Fixture must never quit for installation');}};
      engine.disableDifferentialDownload = true;
      const updater = new DesktopUpdates({version: app.getVersion(), createUpdater: () => engine, getPublishedVersion: null});
      const beforeDownloads = downloads;
      await updater.check({manual: true});
      assert.equal(updater.state().status, 'available');
      assert.equal(downloads, beforeDownloads, 'Checking never downloads payloads');
      await updater.download();
      assert.equal(updater.state().status, bad ? 'error' : 'ready');
      assert.equal(engine.squirrelDownloadedUpdate, false, 'Native installer was not invoked');
      engine.closeServerIfExists();
    }
    assert.equal(downloads, 2);
    console.log(JSON.stringify({passed: true, checks: ['real metadata request', 'real download with SHA512 validation', 'corrupted checksum rejected', 'no native installation'], directory}));
    return 0;
  })().catch(error => {console.error(error.message);return 1;}).then(code => {
    clearTimeout(deadline);engine?.closeServerIfExists();server?.close();app.exit(code);
  });
}
