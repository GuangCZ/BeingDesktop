'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {app} = require('electron');
const {sanitizeText} = require('../src/services.cjs');

// Development checks start with fixture preferences only, never a copied account.
function fixtureProfile() {
  if (app.isPackaged) throw new Error('Use the development Electron runtime for desktop checks.');
  if (process.env.BEING_LOOM_URL) throw new Error('Desktop checks require a fixture connection.');
  const local = path.resolve(__dirname, '../.local');
  fs.mkdirSync(local, {recursive: true});
  const profile = process.env.BEING_DATA_DIR ? path.resolve(process.env.BEING_DATA_DIR) : fs.mkdtempSync(path.join(local, 'desktop-check-'));
  fs.mkdirSync(profile, {recursive: true});
  const relative = path.relative(fs.realpathSync(local), fs.realpathSync(profile));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Desktop checks require a new profile under .local.');
  for (const name of fs.readdirSync(profile)) {
    if (['stdout.log', 'stderr.log'].includes(name)) continue;
    if (name !== 'settings.json') throw new Error('Desktop check profile must start empty except for display preferences.');
    const settings = JSON.parse(fs.readFileSync(path.join(profile, name), 'utf8'));
    if (!settings || Object.keys(settings).some(key => key !== 'typography')) throw new Error('Only fixture typography settings may be preloaded.');
  }
  process.env.BEING_DATA_DIR = profile;
}

fixtureProfile();
require('../src/main.cjs').startDesktop({
  portalUpdateChecksEnabled: false,
  onReady: async context => {
    if (process.env.BEING_SCENARIOS === '1') {
      context.stopRefresh();
      const reportPath = path.join(app.getPath('userData'), 'scenarios-report.json');
      let report;
      try { report = await require('./electron-scenarios.cjs').runDesktopScenarios(context); }
      catch (error) { report = error.scenarioReport || {passed: false, error: sanitizeText(error.message)}; }
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      await context.shutdown();
    } else if (process.env.BEING_SMOKE_REPORT) {
      await require('./desktop-smoke.cjs').runSmoke(context);
    } else {
      await context.shutdown();
      throw new Error('Select a desktop check before starting the harness.');
    }
  },
});
