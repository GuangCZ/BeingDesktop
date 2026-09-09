'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('production startup has no environment-triggered fixture runner or account-copying smoke launcher', () => {
  for (const file of ['src/desktop-entry.cjs', 'src/main.cjs', 'Start.ps1']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /BEING_SMOKE|BEING_SCENARIOS|BEING_UI_AUDIT|runSmoke|runDesktopScenarios|runUiAudit/);
    assert.doesNotMatch(source, /require\(['"]\.\.\/test\//);
    assert.doesNotMatch(source, /Copy-Item[^\n]*(?:taskSettings|taskEncryptionState)/);
  }
});
