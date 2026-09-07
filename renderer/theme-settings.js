'use strict';

window.beingThemeSettings = (() => {
  const model = window.beingThemeColors;
  const fields = [
    {key: 'titlebar', label: '标题栏', detail: '顶部菜单和窗口区域'},
    {key: 'sidebar', label: '侧栏', detail: '导航、项目与会话列表'},
    {key: 'background', label: '主背景', detail: '页面与对话的背景'},
    {key: 'surface', label: '面板', detail: '卡片、输入框与工具面板'},
    {key: 'text', label: '文字', detail: '正文与主要标签'},
    {key: 'accent', label: '强调色', detail: '主要按钮与选中状态'},
  ];
  const $ = id => document.getElementById(id);
  let bridge, onState, initialized = false, busy = false;
  let saved = model.normalizeColors(), draft = {...saved}, feedback = '', failed = false;
  const invalid = new Set();
  const same = (left, right) => fields.every(({key}) => left[key] === right[key]);
  const dirty = () => invalid.size > 0 || !same(draft, saved);
  let applied = '';

  function canonicalHex(value) {
    const hex = value.trim().replace(/^#/, '');
    if (/^[\da-f]{3}$/i.test(hex)) return '#' + [...hex].map(char => char + char).join('').toLowerCase();
    return /^[\da-f]{6}$/i.test(hex) ? '#' + hex.toLowerCase() : null;
  }

  function applyPreview() {
    const identity = JSON.stringify(draft);
    if (identity === applied) return;
    const variables = model.themeVariables(draft);
    for (const [key, value] of Object.entries(variables)) document.documentElement.style.setProperty(key, value);
    document.documentElement.style.colorScheme = variables['--color-scheme'] || 'dark';
    applied = identity;
    window.dispatchEvent(new CustomEvent('being-theme-change', {detail: {...draft}}));
  }

  function render() {
    const changed = dirty();
    const preset = model.PRESETS.find(item => same(item.colors, draft));
    $('theme-current-name').textContent = preset?.name || '自定义';
    for (const button of document.querySelectorAll('[data-theme-preset]')) {
      button.setAttribute('aria-pressed', String(!invalid.size && button.dataset.themePreset === preset?.id));
      button.disabled = busy;
    }
    $('theme-fields').disabled = busy;
    $('theme-save').disabled = busy || !changed || invalid.size > 0;
    $('theme-save').textContent = busy ? '保存中…' : '保存';
    $('theme-reset').disabled = busy || (!changed && same(saved, model.DEFAULT_COLORS));
    $('theme-cancel').hidden = !changed;
    $('theme-cancel').disabled = busy;
    $('appearance-settings').setAttribute('aria-busy', String(busy));
    $('theme-status').textContent = busy ? '正在保存配色…' : invalid.size
      ? '请输入有效的 HEX 色值，如 #5B8DEF。'
      : feedback || (changed ? '有未保存的更改' : '');
    $('theme-status').classList.toggle('tone-error', !busy && (failed || invalid.size > 0));
  }

  function fillFields() {
    for (const {key} of fields) {
      $(`theme-${key}-picker`).value = draft[key];
      $(`theme-${key}-hex`).value = draft[key];
      $(`theme-${key}-hex`).removeAttribute('aria-invalid');
    }
  }

  function edit(key, value, source, commit = false) {
    if (busy) return;
    feedback = '';
    failed = false;
    const color = canonicalHex(value);
    const input = $(`theme-${key}-hex`);
    if (!color) {
      invalid.add(key);
      input.setAttribute('aria-invalid', 'true');
    } else {
      invalid.delete(key);
      input.removeAttribute('aria-invalid');
      draft[key] = color;
      $(`theme-${key}-picker`).value = color;
      if (source === 'picker' || commit) input.value = color;
      applyPreview();
    }
    render();
  }

  function choose(colors) {
    draft = model.normalizeColors(colors);
    invalid.clear();
    feedback = '';
    failed = false;
    fillFields();
    applyPreview();
    render();
  }

  async function save() {
    if (busy || invalid.size || !dirty()) return;
    const colors = model.validateColors(draft);
    busy = true;
    failed = false;
    render();
    try {
      if (!bridge?.setColors) throw new Error('颜色设置暂时无法保存，请重新打开桌面端。');
      const next = await bridge.setColors(colors);
      const confirmed = model.validateColors(next?.settings?.colors);
      if (!same(confirmed, colors)) throw new Error('配色保存未能确认，请重试。');
      saved = {...confirmed};
      draft = {...confirmed};
      feedback = '配色已保存，下次打开会继续使用。';
      fillFields();
      onState?.(next);
    } catch (error) {
      failed = true;
      feedback = String(error?.message || '配色未能保存，请重试。').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    } finally {
      busy = false;
      render();
    }
  }

  function setState(state) {
    if (!initialized) return;
    const preserve = busy || dirty();
    saved = model.normalizeColors(state?.settings?.colors);
    if (!preserve) {
      draft = {...saved};
      fillFields();
      applyPreview();
    }
    render();
  }

  function init(options) {
    if (initialized || !model || !$('appearance-settings')) return;
    initialized = true;
    bridge = options.bridge;
    onState = options.onState;
    for (const preset of model.PRESETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'theme-preset';
      button.dataset.themePreset = preset.id;
      button.setAttribute('aria-pressed', 'false');
      const swatches = document.createElement('span');
      swatches.className = 'theme-preset-swatches';
      swatches.setAttribute('aria-hidden', 'true');
      for (const key of ['sidebar', 'background', 'surface', 'text']) swatches.style.setProperty(`--preview-${key}`, preset.colors[key]);
      for (const key of ['titlebar', 'sidebar', 'background', 'surface', 'accent']) {
        const swatch = document.createElement('i');
        swatch.style.backgroundColor = preset.colors[key];
        swatches.append(swatch);
      }
      const label = document.createElement('span');
      label.textContent = preset.name;
      button.append(swatches, label);
      button.addEventListener('click', () => choose(preset.colors));
      $('theme-presets').append(button);
    }
    for (const {key, label, detail} of fields) {
      const row = document.createElement('div');
      row.className = 'theme-field';
      const copy = document.createElement('label');
      copy.htmlFor = `theme-${key}-hex`;
      const name = document.createElement('span');
      name.textContent = label;
      const hint = document.createElement('span');
      hint.className = 'field-help';
      hint.textContent = detail;
      copy.append(name, hint);
      const inputs = document.createElement('div');
      inputs.className = 'theme-color-control';
      const picker = document.createElement('input');
      picker.type = 'color';
      picker.id = `theme-${key}-picker`;
      picker.setAttribute('aria-label', `选择${label}颜色`);
      picker.addEventListener('input', () => edit(key, picker.value, 'picker'));
      picker.addEventListener('change', () => edit(key, picker.value, 'picker', true));
      const hex = document.createElement('input');
      hex.type = 'text';
      hex.id = `theme-${key}-hex`;
      hex.className = 'theme-hex';
      hex.maxLength = 7;
      hex.autocomplete = 'off';
      hex.spellcheck = false;
      hex.placeholder = '#5B8DEF';
      hex.setAttribute('aria-describedby', 'theme-status');
      hex.addEventListener('input', () => edit(key, hex.value, 'hex'));
      hex.addEventListener('change', () => edit(key, hex.value, 'hex', true));
      inputs.append(picker, hex);
      row.append(copy, inputs);
      $('theme-fields').append(row);
    }
    $('theme-form').addEventListener('submit', event => {event.preventDefault(); void save();});
    $('theme-cancel').addEventListener('click', () => choose(saved));
    $('theme-reset').addEventListener('click', () => {
      choose(model.DEFAULT_COLORS);
      if (dirty()) void save();
    });
    fillFields();
    applyPreview();
    render();
  }
  return {init, setState};
})();
