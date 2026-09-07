'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {typographyCSS} = require('./typography.cjs');
const {colorsCSS,normalizeColors} = require('./ui-theme.cjs');
const {applyLoomMessageNavigator} = require('./loom-message-navigator.cjs');
const {applyLoomActivity} = require('./loom-activity.cjs');
const {applyLoomAttachments} = require('./loom-attachments.cjs');
const typographyUpdates = new WeakMap();
const typographyKeys = new WeakMap();
const colorUpdates = new WeakMap();
const colorKeys = new WeakMap();

// Only the embedded Loom document receives this sheet, never browser tool pages.
function applyContentColors(contents, settings) {
  const css = colorsCSS(settings);
  const previous = colorUpdates.get(contents) || Promise.resolve();
  const update = previous.catch(() => {}).then(async () => {
    if (contents.isDestroyed()) return false;
    const isLoom = await contents.executeJavaScript("document.documentElement.dataset.beingDesktopTheme === 'codex' && Boolean(document.querySelector('#app #messages') && document.querySelector('#input-row textarea#input'))");
    if (!isLoom || contents.isDestroyed()) return false;
    const key = await contents.insertCSS(css, {cssOrigin: 'user'});
    const oldKey = colorKeys.get(contents);
    colorKeys.set(contents, key);
    if (oldKey && !contents.isDestroyed()) await contents.removeInsertedCSS(oldKey);
    return true;
  });
  colorUpdates.set(contents, update);
  return update;
}

// Replace only this adapter's previous preference sheet, keeping remote styles intact.
function applyContentTypography(contents, settings) {
  const css = typographyCSS(settings);
  const previous = typographyUpdates.get(contents) || Promise.resolve();
  const update = previous.catch(() => {}).then(async () => {
    if (contents.isDestroyed()) return;
    const key = await contents.insertCSS(css, {cssOrigin: 'user'});
    const oldKey = typographyKeys.get(contents);
    typographyKeys.set(contents, key);
    if (oldKey && !contents.isDestroyed()) await contents.removeInsertedCSS(oldKey);
  });
  typographyUpdates.set(contents, update);
  return update;
}

// Presentation only: retain Loom's own message, attachment and settings handlers.
async function applyLoomTheme(contents, colors = normalizeColors()) {
  if (contents.isDestroyed()) return false;
  const isLoom = await contents.executeJavaScript("Boolean(document.querySelector('#app #messages') && document.querySelector('#input-row textarea#input'))");
  if (!isLoom || contents.isDestroyed()) return false;
  const [typography, theme] = await Promise.all([
    fs.readFile(path.join(__dirname, '../renderer/typography.css'), 'utf8'),
    fs.readFile(path.join(__dirname, 'loom-theme.css'), 'utf8')
  ]);
  if (contents.isDestroyed()) return;
  await contents.insertCSS(`${typography}\n${theme}`, {cssOrigin: 'user'});
  if (contents.isDestroyed()) return;
  await contents.executeJavaScript(`(() => {
    const row = document.getElementById('input-row');
    const input = document.getElementById('input');
    const files = document.getElementById('file-input');
    if (!row || !input || !document.getElementById('messages')) return false;
    document.documentElement.dataset.beingDesktopTheme = 'codex';
    input.placeholder = '随意输入…';
    if (files && !document.getElementById('desktop-attach')) {
      const attach = document.createElement('button');
      attach.id = 'desktop-attach';
      attach.type = 'button';
      attach.title = '添加附件';
      attach.setAttribute('aria-label', '添加附件');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M12 5v14M5 12h14');
      svg.append(path);
      attach.append(svg);
      attach.addEventListener('click', () => files.click());
      row.append(attach);
    }
    return true;
  })()`);
  await applyContentColors(contents, colors);
  await applyLoomAttachments(contents);
  await applyLoomActivity(contents);
  await applyLoomMessageNavigator(contents);
}

module.exports = {applyLoomTheme, applyContentTypography, applyContentColors};
