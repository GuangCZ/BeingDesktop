'use strict';

const {normalizeColors, validateColors, themeVariables} = require('../renderer/theme-colors.js');

function colorsCSS(value) {
  const variables = themeVariables(value);
  return `:root { ${Object.entries(variables).map(([name, color]) => `${name}: ${color} !important;`).join(' ')} color-scheme: ${variables['--color-scheme']} !important; }`;
}

async function saveColors(value, {settings, persist}) {
  let colors;
  try { colors = validateColors(value); }
  catch { throw new Error('请使用完整的六位十六进制颜色，例如 #181818。'); }
  const hadColors = Object.hasOwn(settings, 'colors');
  const previous = settings.colors;
  settings.colors = colors;
  try { await persist(); }
  catch {
    if (hadColors) settings.colors = previous;
    else delete settings.colors;
    throw new Error('配色未能保存，请重试。');
  }
  return {...colors};
}

module.exports = {normalizeColors, colorsCSS, saveColors};
