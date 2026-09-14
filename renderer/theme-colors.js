(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.beingThemeColors = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const DEFAULT_COLORS = Object.freeze({
    background: '#181818', sidebar: '#202020', titlebar: '#202020',
    surface: '#242424', text: '#ececec', accent: '#ececec',
  });
  const PRESETS = Object.freeze([
    Object.freeze({id: 'default', name: 'Codex 深色', colors: DEFAULT_COLORS}),
    Object.freeze({id: 'light', name: '柔和浅色', colors: Object.freeze({
      background: '#f8f8f7', sidebar: '#eeeeec', titlebar: '#eeeeec',
      surface: '#ffffff', text: '#242424', accent: '#3259b8',
    })}),
    Object.freeze({id: 'warm', name: '暖夜', colors: Object.freeze({
      background: '#211e1c', sidebar: '#2c2522', titlebar: '#2c2522',
      surface: '#312a26', text: '#eee6db', accent: '#ddb583',
    })}),
  ]);
  const fields = Object.freeze(Object.keys(DEFAULT_COLORS));
  const invalidMessage = 'Invalid UI color configuration.';
  const isColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  const plainObject = value => value !== null && typeof value === 'object'
    && Object.getPrototypeOf(value) === Object.prototype;
  const dataValue = descriptor => descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;

  function normalizeColors(value) {
    try {
      if (!plainObject(value)) return {...DEFAULT_COLORS};
      const descriptors = Object.getOwnPropertyDescriptors(value);
      return Object.fromEntries(fields.map(field => {
        const color = dataValue(descriptors[field]);
        return [field, isColor(color) ? color.toLowerCase() : DEFAULT_COLORS[field]];
      }));
    } catch { return {...DEFAULT_COLORS}; }
  }

  function validateColors(value) {
    try {
      if (!plainObject(value)) throw new Error(invalidMessage);
      const keys = Reflect.ownKeys(value);
      if (keys.length !== fields.length || fields.some(field => !keys.includes(field))) throw new Error(invalidMessage);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      return Object.fromEntries(fields.map(field => {
        const color = dataValue(descriptors[field]);
        if (!isColor(color)) throw new Error(invalidMessage);
        return [field, color.toLowerCase()];
      }));
    } catch { throw new Error(invalidMessage); }
  }

  function rgb(color) { return [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16)); }
  function mix(base, foreground, amount) {
    const a = rgb(base), b = rgb(foreground);
    return `#${a.map((channel, index) => Math.round(channel + (b[index] - channel) * amount).toString(16).padStart(2, '0')).join('')}`;
  }
  function luminance(color) {
    const [r, g, b] = rgb(color).map(channel => {
      const value = channel / 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    });
    return .2126 * r + .7152 * g + .0722 * b;
  }
  function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + .05) / (Math.min(la, lb) + .05);
  }
  function readable(background, preferred) {
    if (preferred && contrast(background, preferred) >= 4.5) return preferred;
    return contrast(background, '#181818') >= contrast(background, '#ffffff') ? '#181818' : '#ffffff';
  }

  function themeVariables(value) {
    const colors = validateColors(value);
    const {background, sidebar, titlebar, surface, text, accent} = colors;
    const surfaceText = readable(surface, text), sidebarText = readable(sidebar, text), chromeText = readable(titlebar, text);
    const input = mix(surface, surfaceText, .04), inputText = readable(input, text);
    const bodyText = readable(background, text);
    const accentContrast = readable(accent);
    return {
      '--color-scheme': luminance(background) > .4 ? 'light' : 'dark',
      '--background': background, '--sidebar': sidebar, '--window-chrome': titlebar,
      '--surface': surface, '--text': text, '--accent': accent,
      '--input': input, '--hover': mix(surface, surfaceText, .06),
      '--line': mix(background, bodyText, .113), '--line-soft': mix(background, bodyText, .08),
      '--muted': mix(background, bodyText, .655), '--faint': mix(background, bodyText, .595),
      '--accent-contrast': accentContrast, '--accent-hover': mix(accent, accentContrast === '#181818' ? '#ffffff' : '#000000', .12),
      '--sidebar-text': sidebarText, '--sidebar-muted': mix(sidebar, sidebarText, .66),
      '--sidebar-hover': mix(sidebar, sidebarText, .08), '--sidebar-line': mix(sidebar, sidebarText, .14),
      '--chrome-text': chromeText, '--chrome-muted': mix(titlebar, chromeText, .66),
      '--chrome-hover': mix(titlebar, chromeText, .08), '--chrome-line': mix(titlebar, chromeText, .14),
      '--surface-text': surfaceText, '--surface-muted': mix(surface, surfaceText, .66),
      '--surface-hover': mix(surface, surfaceText, .1), '--surface-line': mix(surface, surfaceText, .16),
      '--input-text': inputText, '--input-muted': mix(input, inputText, .6),
      '--link': contrast(background, accent) >= 4.5 ? accent : bodyText,
    };
  }
  return Object.freeze({DEFAULT_COLORS, PRESETS, normalizeColors, validateColors, themeVariables});
});
