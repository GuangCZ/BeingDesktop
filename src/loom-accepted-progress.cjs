'use strict';

// A 202 receipt ends the POST, but does not end the user's task. Follow it
// without resubmitting messages or claiming another session's active stream.
function installAcceptedProgress() {
  if (globalThis.__beingDesktopAcceptedProgress) return;
  let timer = null, running = false, stopped = false, mounted = false;
  let healthy = true, ownsIndicator = false;
  const pending = () => globalThis.__beingDesktopTaskQueue?.snapshot().pending.filter(item=>item.accepted) || [];
  function render() {
    if (!mounted || typeof tuiSet !== 'function') return;
    const bar = document.getElementById('tui-bar');
    const streaming = typeof isStreaming !== 'undefined' && isStreaming;
    const items = pending();
    if (!items.length) {
      bar?.removeAttribute('data-desktop-accepted-progress');
      if (ownsIndicator && !streaming && typeof tuiClear === 'function') tuiClear();
      ownsIndicator = false;
      return;
    }
    bar?.setAttribute('data-desktop-accepted-progress', '');
    // An attached stream owns the native label, preview, stop button and log.
    // Never overwrite its tool name or reset its elapsed timer on each poll.
    if (streaming) { ownsIndicator = false; return; }
    ownsIndicator = true;
    const active = globalThis.__beingDesktopSessions?.progress();
    const item = items.at(-1);
    const phase = active && !active.finished ? active.phase : null;
    const label = !healthy ? '正在重连' : phase === 'tool' ? '在行动' : phase === 'text' ? '在回复' : item.spliced || phase ? '在思考' : '等待回应';
    tuiSet(phase === 'tool' ? 'act' : 'thinking', label, {preview:''});
    if (typeof setTuiHint === 'function') setTuiHint(!healthy ? '正在恢复进度连接' : !phase ? '等待 Being 返回进度' : !active.owned ? 'Being 当前状态 · 等待本条消息回复' : '');
  }
  function refresh() {
    if (stopped || !mounted) return;
    render();
    if (!pending().length) { clearTimeout(timer); timer = null; return; }
    if (!running && timer === null) timer = setTimeout(tick, 1000);
  }
  async function tick() {
    timer = null;
    if (stopped || running || !pending().length) return;
    running = true;
    try {
      healthy = await globalThis.__beingDesktopSessions.poll();
      const active = globalThis.__beingDesktopSessions.progress();
      // The router must establish ownership before Loom can attach its UI.
      if (!stopped && healthy && active?.owned && !active.finished && typeof isStreaming !== 'undefined' && !isStreaming && typeof checkActiveStream === 'function') await checkActiveStream();
    } catch { healthy = false; }
    finally { running = false; refresh(); }
  }
  globalThis.__beingDesktopAcceptedProgress = {refresh};
  document.addEventListener('DOMContentLoaded', () => {
    mounted = true;
    if (typeof addMessage === 'function') {
      const nativeAddMessage = addMessage;
      addMessage = function(role, text, ...args) {
        if (role === 'system' && pending().length && ['消息已送达，being 正在思考中', '消息已送达', '✅ 消息已送达，being 会在思考间隙看到'].includes(text)) {
          refresh();
          return document.getElementById('tui-bar');
        }
        return nativeAddMessage(role, text, ...args);
      };
    }
    refresh();
  }, {once:true});
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); }, {once:true});
}

module.exports = {installAcceptedProgress};
