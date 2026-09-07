'use strict';

const ACTIVITY_WORLD_ID = 1110;

// Present activity and composer controls through the desktop shell.
function installLoomActivity() {
  const key = '__beingDesktopActivity';
  const app = document.getElementById('app');
  const wrapper = document.getElementById('tui-wrapper');
  const bar = wrapper?.querySelector('#tui-bar');
  const log = wrapper?.querySelector('#activity-log');
  if (!app || !bar || !log) return false;
  if (globalThis[key]?.wrapper === wrapper) return true;
  globalThis[key]?.destroy();

  const row = document.getElementById('input-row');
  const stop = document.createElement('button');
  stop.id = 'desktop-stop';
  stop.type = 'button';
  stop.title = '停止生成';
  stop.setAttribute('aria-label', '停止生成');
  stop.textContent = '■';
  stop.hidden = true;
  stop.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const nativeStop = bar.querySelector('.tui-stop');
    if (bar.classList.contains('active') && nativeStop && !nativeStop.disabled) nativeStop.click();
  });
  row?.append(stop);

  const home = document.createComment('Desktop activity home');
  wrapper.before(home);
  wrapper.dataset.desktopInlineActivity = '';
  let host = null, placeholder = null, lastUser = null, metaText = '';
  let scroller = null, following = false;
  let expanded = false, disclosure = null, disclosureAttributes = null;
  const disclosureNames = ['role', 'tabindex', 'aria-expanded', 'aria-controls', 'aria-label', 'title', 'data-desktop-activity-toggle'];
  const empty = document.createElement('div');
  empty.className = 'desktop-activity-empty';
  empty.textContent = '...';

  function releaseDisclosure() {
    if (!disclosure) return;
    for (const name of disclosureNames) {
      const value = disclosureAttributes[name];
      if (value === null) disclosure.removeAttribute(name);
      else disclosure.setAttribute(name, value);
    }
    disclosure = null;
    disclosureAttributes = null;
  }

  function updateDisclosure(open) {
    const line = bar.querySelector('.tui-line');
    if (line !== disclosure) {
      releaseDisclosure();
      disclosure = line;
      if (line) disclosureAttributes = Object.fromEntries(disclosureNames.map(name => [name, line.getAttribute(name)]));
    }
    if (!line) return;
    line.dataset.desktopActivityToggle = '';
    line.setAttribute('role', 'button');
    line.tabIndex = 0;
    line.setAttribute('aria-controls', 'activity-log');
    line.setAttribute('aria-expanded', String(open));
    line.setAttribute('aria-label', open ? '收起思考与行动详情' : '展开思考与行动详情');
    line.title = open ? '收起过程详情' : '展开过程详情';
  }

  function toggleDetails(event) {
    if (!bar.classList.contains('active') || !event.target.closest?.('[data-desktop-activity-toggle]')
        || event.target.closest('button, a, input, textarea, select')) return;
    if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
    // Keep Loom's document click handler from moving keyboard focus to the composer.
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    expanded = !(expanded || log.classList.contains('pinned'));
    log.classList.remove('pinned');
    disclosure?.focus({preventScroll:true});
    update();
  }
  bar.addEventListener('click', toggleDetails);
  bar.addEventListener('keydown', toggleDetails);
  const onScroll = () => {
    following = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  };
  const resize = new ResizeObserver(() => {
    if (following && scroller?.isConnected && wrapper.dataset.active === 'true') scroller.scrollTop = scroller.scrollHeight;
  });
  resize.observe(wrapper);

  function clearHost() {
    host?.removeAttribute('data-desktop-activity-host');
    host = null;
  }

  function restore() {
    clearHost();
    if (home.isConnected && wrapper.previousSibling !== home) home.after(wrapper);
    placeholder?.remove();
    placeholder = null;
  }

  function observe() {
    observer.observe(app, {childList:true, subtree:true, attributes:true, attributeFilter:['class']});
  }

  function update() {
    // Ignore our own reparenting, while still observing native streaming updates.
    observer.disconnect();
    try {
      const messages = app.querySelector('#messages');
      if (messages !== scroller) {
        scroller?.removeEventListener('scroll', onScroll);
        scroller = messages;
        following = false;
        if (scroller) {
          scroller.addEventListener('scroll', onScroll, {passive:true});
          onScroll();
        }
      }
      const barActive = bar.classList.contains('active');
      const canStop = Boolean(barActive && bar.querySelector('.tui-stop'));
      stop.hidden = !canStop;
      stop.disabled = Boolean(bar.querySelector('.tui-stop')?.disabled);
      row?.classList.toggle('desktop-generating', canStop);
      const hasDetails = Array.from(log.childNodes).some(node => node !== empty && (node.nodeType === 1 || node.textContent.trim()));
      if (!barActive) expanded = false;
      if (!hasDetails) log.classList.remove('pinned');
      const open = expanded || log.classList.contains('pinned');
      wrapper.dataset.expanded = String(open);
      updateDisclosure(open);
      if (open && !hasDetails && barActive) {
        if (empty.parentElement !== log) log.append(empty);
      } else empty.remove();
      const active = barActive || (log.classList.contains('pinned') && hasDetails);
      wrapper.dataset.active = String(active);
      if (!messages || !active) {
        restore();
        return;
      }

      const rows = Array.from(messages.children).filter(node => node.matches('.message') && node !== placeholder);
      const user = rows.findLast(node => node.classList.contains('user')) || null;
      if (user !== lastUser) {
        lastUser = user;
        metaText = '';
        placeholder?.remove();
        placeholder = null;
      }
      const current = rows.slice(user ? rows.indexOf(user) + 1 : 0);
      const target = current.findLast(node => node.matches('.being, .assistant'));
      const thinking = rows.findLast(node => node.classList.contains('thinking-indicator'));
      if (!target && thinking) metaText = thinking.querySelector('.meta')?.textContent || metaText;
      if (target) {
        metaText = target.querySelector('.meta')?.textContent || metaText;
      } else if (!placeholder || !placeholder.isConnected) {
        placeholder?.remove();
        placeholder = document.createElement('div');
        placeholder.className = 'message being thinking-indicator';
        placeholder.dataset.desktopActivityPlaceholder = '';
        if (metaText) {
          const meta = document.createElement('div');
          meta.className = 'meta';
          meta.textContent = metaText;
          placeholder.append(meta);
        }
        messages.append(placeholder);
      }

      const nextHost = target || placeholder;
      if (host !== nextHost) {
        clearHost();
        host = nextHost;
        host.dataset.desktopActivityHost = '';
      }
      if (wrapper.parentElement !== host) {
        const content = host.querySelector(':scope > .content');
        host.insertBefore(wrapper, content);
      }
      if (target && placeholder) {
        placeholder.remove();
        placeholder = null;
      }
    } finally {
      observe();
    }
  }

  const observer = new MutationObserver(update);
  function destroy() {
    observer.disconnect();
    resize.disconnect();
    scroller?.removeEventListener('scroll', onScroll);
    bar.removeEventListener('click', toggleDetails);
    bar.removeEventListener('keydown', toggleDetails);
    releaseDisclosure();
    stop.remove();
    row?.classList.remove('desktop-generating');
    empty.remove();
    restore();
    home.remove();
    wrapper.removeAttribute('data-desktop-inline-activity');
    wrapper.removeAttribute('data-active');
    wrapper.removeAttribute('data-expanded');
    window.removeEventListener('pagehide', destroy);
    delete globalThis[key];
  }
  globalThis[key] = {wrapper, destroy};
  window.addEventListener('pagehide', destroy, {once:true});
  update();
  return true;
}

async function applyLoomActivity(contents) {
  if (contents.isDestroyed()) return false;
  return contents.executeJavaScriptInIsolatedWorld(ACTIVITY_WORLD_ID, [{code:`(${installLoomActivity.toString()})()`}]);
}

module.exports = {applyLoomActivity, ACTIVITY_WORLD_ID};
