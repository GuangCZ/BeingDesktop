'use strict';

function sessionActivity(queue) {
  const pending = queue?.pending || [];
  if (pending.some(item => ['waiting', 'responding'].includes(item.status))) return 'talking';
  if (queue?.queued?.length || pending.some(item => ['sending', 'accepted'].includes(item.status))) return 'waiting';
  return 'inactive';
}

async function readSessionActivity(views, statuses) {
  return Promise.all([...views].map(async ([id, view]) => {
    const contents = view.webContents;
    let snapshot = null;
    try {
      if (!contents.isDestroyed() && !contents.isLoadingMainFrame() && statuses.get(view)?.status === 'connected') {
        snapshot = await contents.executeJavaScript('({queue:globalThis.__beingDesktopTaskQueue?.snapshot() || null,routingWarning:Boolean(globalThis.__beingDesktopSessions?.list().routingWarning)})');
      }
    } catch { /* An unavailable page is inactive until its next successful read. */ }
    return {id, view, queue:snapshot?.queue || null, routingWarning:Boolean(snapshot?.routingWarning), activity:sessionActivity(snapshot?.queue)};
  }));
}

module.exports = {sessionActivity, readSessionActivity};
