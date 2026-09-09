'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {windowAppearance, systemAppearance, applyWindowAppearance} = require('../src/desktop-appearance.cjs');

test('native glass is macOS-only and accessibility disables native transparency', () => {
  for (const platform of ['win32', 'linux']) {
    assert.deepEqual(windowAppearance({platform, background: '#181818'}), {frame: false, backgroundColor: '#181818'});
  }
  const mac = windowAppearance({platform: 'darwin', background: '#181818'});
  assert.equal(mac.titleBarStyle, 'hidden');
  assert.equal(mac.frame, true);
  assert.equal(mac.vibrancy, 'sidebar');
  assert.equal(mac.backgroundColor, '#00000000');
  for (const preference of ['reducedTransparency', 'highContrast']) {
    const result = windowAppearance({platform: 'darwin', background: '#abcdef', [preference]: true});
    assert.equal(result.vibrancy, undefined);
    assert.equal(result.backgroundColor, '#abcdef');
  }
});

test('saving a palette retains vibrancy and runtime accessibility changes remove and restore it', () => {
  const calls = [];
  const win = {setBackgroundColor: value => calls.push(['background', value]), setVibrancy: value => calls.push(['vibrancy', value])};
  const theme = {prefersReducedTransparency: false, shouldUseHighContrastColors: false};
  applyWindowAppearance(win, theme, '#ffffff', 'darwin');
  theme.prefersReducedTransparency = true;
  applyWindowAppearance(win, theme, '#ffffff', 'darwin');
  theme.prefersReducedTransparency = false;
  applyWindowAppearance(win, theme, '#222222', 'darwin');
  assert.deepEqual(calls, [
    ['background', '#00000000'], ['vibrancy', 'sidebar'],
    ['background', '#ffffff'], ['vibrancy', null],
    ['background', '#00000000'], ['vibrancy', 'sidebar'],
  ]);
  assert.deepEqual(systemAppearance({}), {reducedTransparency: false, highContrast: false});
});
