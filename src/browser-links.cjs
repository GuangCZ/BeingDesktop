'use strict';

const {normalizeBrowserUrl} = require('./desktop-browser.cjs');

function createBrowserLinks({getBrowser, showBrowser, isCurrent = () => true, onError = () => {}}) {
  function open(url) {
    if (!isCurrent()) throw new Error('当前页面已关闭，无法打开网页。');
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('仅支持在内置浏览器中打开 HTTP 和 HTTPS 网页。');
    const target = normalizeBrowserUrl(url);
    const snapshot = getBrowser().newTab({url:target});
    showBrowser();
    return {opened:true,tabId:snapshot.activeTabId};
  }
  function tryOpen(url) {
    if (!isCurrent()) return false;
    try { open(url); return true; }
    catch (error) { onError(error); return false; }
  }
  function popup(details) {
    // Create the tab after Electron finishes denying the separate native window.
    queueMicrotask(() => tryOpen(details.url));
    return {action:'deny'};
  }
  return {open,tryOpen,popup};
}

module.exports = {createBrowserLinks};
