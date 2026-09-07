'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {DEFAULT_COLORS, PRESETS, normalizeColors, validateColors, themeVariables} = require('../renderer/theme-colors.js');
const {colorsCSS, saveColors} = require('../src/ui-theme.cjs');
const {applyContentColors} = require('../src/loom-theme.cjs');

const invalid = {name: 'Error', message: 'Invalid UI color configuration.'};

test('stored colors recover each damaged field while preserving valid custom values', () => {
  for (const record of [null, [], true, '#ffffff', 20, new Date()]) assert.deepEqual(normalizeColors(record), DEFAULT_COLORS);
  assert.deepEqual(normalizeColors({background: '#FFEECC', sidebar: 'red', text: '#142235', extra: 'future'}), {
    ...DEFAULT_COLORS, background: '#ffeecc', text: '#142235',
  });
  const restored = normalizeColors();
  restored.accent = '#000000';
  assert.equal(DEFAULT_COLORS.accent, '#ececec');
});

test('IPC requires exactly six own hexadecimal data properties', () => {
  for (const value of [undefined, null, [], {}, {...DEFAULT_COLORS, extra: '#000000'},
    {...DEFAULT_COLORS, [Symbol('extra')]: '#000000'}, Object.assign(Object.create(null), DEFAULT_COLORS),
    Object.assign(Object.create({inherited: true}), DEFAULT_COLORS)]) assert.throws(() => validateColors(value), invalid);
  for (const color of [true, 0, {}, null, '#fff', 'red', '#11223344', ' #112233', '#11223g', 'var(--text)', '#112233; } body { display:none']) {
    for (const field of Object.keys(DEFAULT_COLORS)) {
      assert.throws(() => validateColors({...DEFAULT_COLORS, [field]: color}), invalid);
    }
  }
  const input = {...DEFAULT_COLORS, accent: '#AB12CD'};
  assert.deepEqual(validateColors(input), {...DEFAULT_COLORS, accent: '#ab12cd'});
  assert.equal(input.accent, '#AB12CD');
});

test('color recovery and validation never invoke property accessors or expose proxy errors', () => {
  let reads = 0;
  const value = {...DEFAULT_COLORS};
  Object.defineProperty(value, 'accent', {get() { reads++; return '#ffffff'; }});
  assert.deepEqual(normalizeColors(value), DEFAULT_COLORS);
  assert.throws(() => validateColors(value), invalid);
  assert.equal(reads, 0);
  const hostile = new Proxy({}, {getPrototypeOf() { throw new Error('private caller data'); }});
  assert.deepEqual(normalizeColors(hostile), DEFAULT_COLORS);
  assert.throws(() => validateColors(hostile), invalid);
});

test('theme presets provide safe variables and keep the default base appearance', () => {
  assert.equal(PRESETS.length, 3);
  for (const preset of PRESETS) {
    assert.deepEqual(validateColors(preset.colors), preset.colors);
    for (const [name, color] of Object.entries(themeVariables(preset.colors))) {
      assert.match(name, /^--[a-z-]+$/);
      if (name === '--color-scheme') assert.match(color, /^(light|dark)$/);
      else assert.match(color, /^#[0-9a-f]{6}$/);
    }
  }
  const vars = themeVariables(DEFAULT_COLORS);
  assert.equal(vars['--background'], '#181818');
  assert.equal(vars['--input'], '#2c2c2c');
  assert.equal(vars['--hover'], '#303030');
  assert.equal(vars['--line'], '#303030');
  assert.equal(vars['--line-soft'], '#292929');
  assert.equal(vars['--muted'], '#a3a3a3');
  assert.equal(vars['--faint'], '#969696');
  assert.equal(vars['--sidebar-text'], '#ececec');
});

test('mixed light and dark surfaces select legible foregrounds independently', () => {
  const vars = themeVariables({...DEFAULT_COLORS, background: '#ffffff', text: '#181818',
    sidebar: '#000000', titlebar: '#ffffff', surface: '#ffffff', accent: '#000000'});
  assert.equal(vars['--sidebar-text'], '#ffffff');
  assert.equal(vars['--chrome-text'], '#181818');
  assert.equal(vars['--surface-text'], '#181818');
  assert.equal(vars['--input-text'], '#181818');
  assert.equal(vars['--accent-contrast'], '#ffffff');
  assert.equal(vars['--color-scheme'], 'light');
  assert.equal(themeVariables({...DEFAULT_COLORS, accent: '#ffffff'})['--accent-contrast'], '#181818');
});

test('native CSS accepts only validated values and sets native control color scheme', () => {
  const css = colorsCSS(PRESETS[1].colors);
  assert.match(css, /--background: #f8f8f7 !important;/);
  assert.match(css, /color-scheme: light !important;/);
  assert.throws(() => colorsCSS({...DEFAULT_COLORS, background: '#fff; color:red'}), invalid);
  assert.throws(() => themeVariables({...DEFAULT_COLORS, customStyle: 'body{}'}), invalid);
});

test('browser and native modules produce the same color model', async () => {
  const source = await fs.readFile(path.join(__dirname, '../renderer/theme-colors.js'), 'utf8');
  const sandbox = vm.createContext({window: {}});
  vm.runInContext(source, sandbox);
  const result = vm.runInContext('JSON.stringify(window.beingThemeColors.themeVariables(window.beingThemeColors.PRESETS[1].colors))', sandbox);
  assert.deepEqual(JSON.parse(result), themeVariables(PRESETS[1].colors));
});

test('saving persists custom colors and preserves unrelated preferences across restore', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'being-colors-'));
  try {
    const file = path.join(directory, 'settings.json');
    const settings = {workspace: 'E:/work', typography: {chatFontSize: 16, codeFontSize: 13}, closeToTray: false};
    const result = await saveColors(PRESETS[1].colors, {settings, persist: () => fs.writeFile(file, JSON.stringify(settings))});
    const restored = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(normalizeColors(restored.colors), PRESETS[1].colors);
    assert.equal(restored.workspace, 'E:/work');
    assert.equal(restored.closeToTray, false);
    assert.deepEqual(restored.typography, {chatFontSize: 16, codeFontSize: 13});
    result.background = '#000000';
    assert.equal(settings.colors.background, '#f8f8f7');
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('save failure rolls back the prior value and does not introduce absent settings', async () => {
  for (const settings of [{workspace: 'keep'}, {workspace: 'keep', colors: {...DEFAULT_COLORS}}]) {
    const before = structuredClone(settings);
    await assert.rejects(saveColors(PRESETS[1].colors, {settings, persist: async () => { throw new Error('disk full'); }}), /配色未能保存/);
    assert.deepEqual(settings, before);
  }
  let writes = 0;
  await assert.rejects(saveColors({...DEFAULT_COLORS, accent: 'red'}, {settings: {}, persist: async () => { writes++; }}), /六位十六进制/);
  assert.equal(writes, 0);
});

test('saving resolves only after durable preferences are written', async () => {
  let complete;
  let finished = false;
  const written = new Promise(resolve => { complete = resolve; });
  const settings = {};
  const saving = saveColors(DEFAULT_COLORS, {settings, persist: () => written}).then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  complete();
  await saving;
  assert.equal(finished, true);
});

test('Loom color updates replace only their previous sheet in order', async () => {
  const events = [];
  let key = 0;
  const contents = {
    isDestroyed: () => false,
    executeJavaScript: async () => true,
    insertCSS: async (css, options) => { const id = `colors-${++key}`; events.push(['insert', id, css, options]); return id; },
    removeInsertedCSS: async id => { events.push(['remove', id]); },
  };
  await Promise.all([applyContentColors(contents, DEFAULT_COLORS), applyContentColors(contents, PRESETS[1].colors)]);
  assert.deepEqual(events.map(event => event.slice(0, 2)), [['insert', 'colors-1'], ['insert', 'colors-2'], ['remove', 'colors-1']]);
  assert.match(events[1][2], /--background: #f8f8f7 !important;/);
  assert.deepEqual(events[1][3], {cssOrigin: 'user'});
});

test('Loom injection skips unrecognized and destroyed documents and recovers after a failed insert', async () => {
  let inserts = 0, destroyed = false, recognized = false, fail = false;
  const contents = {
    isDestroyed: () => destroyed,
    executeJavaScript: async () => recognized,
    insertCSS: async () => { inserts++; if (fail) throw new Error('navigation'); return 'sheet'; },
    removeInsertedCSS: async () => {},
  };
  assert.equal(await applyContentColors(contents, DEFAULT_COLORS), false);
  recognized = true;
  destroyed = true;
  assert.equal(await applyContentColors(contents, DEFAULT_COLORS), false);
  assert.equal(inserts, 0);
  destroyed = false;
  fail = true;
  await assert.rejects(applyContentColors(contents, DEFAULT_COLORS), /navigation/);
  fail = false;
  assert.equal(await applyContentColors(contents, PRESETS[1].colors), true);
  assert.equal(inserts, 2);
});
