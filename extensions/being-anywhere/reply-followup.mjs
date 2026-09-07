const MAX_NETWORK_FAILURES = 6;
const MAX_REPLAY_EVENTS = 50000;
const MAX_REPLY_CHARS = 8 * 1024 * 1024;
const STREAM_ERROR = 'Being 的回复中断，请查看已有内容后再决定是否重试。';

const aborted = () => new DOMException('请求已取消。', 'AbortError');
function checkAbort(signal) { if (signal?.aborted) throw aborted(); }

// This delay spaces GET polls; it never times out an upstream request or turn.
export function waitForFollowup(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(finish, ms);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(aborted()); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

function orderedHistory(history) {
  let previous = 0;
  return Array.isArray(history) && history.every((item) => {
    if (!Number.isSafeInteger(item.seq) || item.seq <= previous) return false;
    previous = item.seq;
    return true;
  });
}

function historyAnchor(history, baselineSeq, message, anchorSeq) {
  if (!orderedHistory(history)) return { ambiguous: true };
  const candidates = history.filter((item) => item.seq > baselineSeq && item.role === 'user' && item.content === message);
  if (candidates.length > 1) return { ambiguous: true };
  const anchor = candidates[0];
  if (!anchor) return { ambiguous: Boolean(anchorSeq) };
  if (anchorSeq && anchorSeq !== anchor.seq) return { ambiguous: true };
  const index = history.indexOf(anchor);
  const later = history.slice(index + 1);
  const nextUser = later.findIndex((item) => item.role === 'user');
  return {
    anchorSeq: anchor.seq,
    superseded: nextUser >= 0,
    replies: (nextUser >= 0 ? later.slice(0, nextUser) : later).filter((item) => item.role === 'being' && item.content)
  };
}

function baselineHasPendingReply(stream) {
  if (!stream || stream.finished) return false;
  // An unfinished breath with no retained boundary cannot be assigned to the
  // submitted message. Wait for a new reply boundary instead of replaying it.
  let pending = true;
  for (const item of stream.events) {
    if (item.type === 'message_stop') pending = false;
    else if (['content_block_delta', 'thinking', 'reasoning', 'tool_use'].includes(item.type)) pending = true;
  }
  return pending;
}

/** Send once, then read only correlated continuation events from Loom. */
export async function sendAndFollow(client, {
  message, sessionId, signal, onEvent = () => {}, onState = () => {}, wait = waitForFollowup
}) {
  checkAbort(signal);
  const baseline = await Promise.allSettled([
    client.readHistory({ signal }), client.readActiveStream({ signal })
  ]);
  checkAbort(signal);
  const baselineHistory = baseline[0].status === 'fulfilled' && orderedHistory(baseline[0].value) ? baseline[0].value : null;
  const baselineSeq = baselineHistory?.at(-1)?.seq || 0;
  const baselineActive = baseline[1].status === 'fulfilled' ? baseline[1].value : null;
  let streamId = null;
  let cursor = 0;
  let sawError = false;
  let accepted = false;
  let anchorSeq = null;
  let eventCount = 0;
  let replyChars = 0;
  let pendingText = '';
  const completedTexts = [];
  let completedBoundary = false;
  let lastState = '';
  let semanticState = 'waiting';
  const state = (value) => { if (value !== lastState) { lastState = value; onState(value); } };
  const unconfirmed = () => { state('unconfirmed'); return { accepted, unconfirmed: true }; };
  const emit = (event) => {
    if (++eventCount > MAX_REPLAY_EVENTS) throw Object.assign(new Error('Being 返回的内容过长，已停止接收。'), { code: 'limit' });
    if (event.type === 'error') {
      sawError = true;
      onEvent({ type: 'error', data: { message: STREAM_ERROR } });
      throw new Error(STREAM_ERROR);
    }
    if (event.type === 'meta' && typeof event.data.stream_id === 'string') streamId = event.data.stream_id;
    if (['thinking', 'reasoning', 'tool_result'].includes(event.type)) semanticState = 'thinking';
    else if (event.type === 'tool_use') semanticState = 'acting';
    else if (event.type === 'content_block_delta') semanticState = 'replying';
    else if (event.type === 'message_stop') semanticState = 'waiting';
    if (event.type === 'content_block_delta' && typeof event.data.delta?.text === 'string') {
      pendingText += event.data.delta.text;
      replyChars += event.data.delta.text.length;
      if (replyChars > MAX_REPLY_CHARS) throw Object.assign(new Error('Being 返回的内容过长，已停止接收。'), { code: 'limit' });
      completedBoundary = false;
    } else if (event.type === 'message_stop') {
      if (pendingText) completedTexts.push(pendingText);
      pendingText = '';
      completedBoundary = true;
    } else if (['thinking', 'reasoning', 'tool_use'].includes(event.type)) completedBoundary = false;
    onEvent(event);
  };

  try {
    const result = await client.send({
      message, sessionId, signal, onEvent: emit,
      onFrame: ({ type }) => { if (type !== 'meta') cursor += 1; }
    });
    if (!result.accepted) return result;
    accepted = true;
    state('waiting');
  } catch (error) {
    checkAbort(signal);
    if (error?.name === 'AbortError' || sawError || !streamId || ['auth', 'response', 'limit', 'connection', 'origin'].includes(error?.code)) throw error;
    state('reconnecting');
  }

  // A 202 has no request-specific stream identity. Both pre-send snapshots are
  // required to exclude old history and a pre-existing stream's replay buffer.
  if (accepted && (!baselineHistory || baseline[1].status !== 'fulfilled')) return unconfirmed();
  let skipExistingReply = false;
  if (accepted && baselineActive?.streamId && !baselineActive.finished) {
    streamId = baselineActive.streamId;
    cursor = baselineActive.nextSeq - 1;
    skipExistingReply = baselineHasPendingReply(baselineActive);
  }
  const hadUnfinishedOlderReply = skipExistingReply;
  let failures = 0;
  let interval = 500;
  let firstPoll = true;

  const recoverHistory = (correlation, turnFinished = true) => {
    if (!correlation?.anchorSeq || correlation.ambiguous || !correlation.replies?.length) return unconfirmed();
    // An old reply can be persisted after a spliced user message. Its history
    // position alone does not prove that it answers the new request.
    if (hadUnfinishedOlderReply && !completedTexts.length && !pendingText) return unconfirmed();
    const texts = correlation.replies.map((item) => item.content);
    if (completedTexts.some((text, index) => texts[index] !== text)) return unconfirmed();
    if (pendingText && !texts[completedTexts.length]?.startsWith(pendingText)) return unconfirmed();
    for (let index = completedTexts.length; index < texts.length; index += 1) {
      const remaining = texts[index].slice(index === completedTexts.length ? pendingText.length : 0);
      if (remaining) emit({ type: 'content_block_delta', data: { delta: { text: remaining } } });
      emit({ type: 'message_stop', data: {} });
    }
    return turnFinished ? { accepted, completed: true } : unconfirmed();
  };

  while (true) {
    checkAbort(signal);
    if (!firstPoll) await wait(interval, signal);
    firstPoll = false;
    checkAbort(signal);
    let active;
    let history;
    try {
      [active, history] = await Promise.all([
        client.readActiveStream({ after: cursor, signal }), client.readHistory({ signal })
      ]);
      checkAbort(signal);
      failures = 0;
    } catch (error) {
      checkAbort(signal);
      if (error?.name === 'AbortError') throw error;
      state('reconnecting');
      if (++failures >= MAX_NETWORK_FAILURES) return unconfirmed();
      interval = Math.min(interval * 1.5, 5000);
      continue;
    }

    const correlation = baselineHistory ? historyAnchor(history, baselineSeq, message, anchorSeq) : null;
    if (correlation?.ambiguous) return unconfirmed();
    if (correlation?.anchorSeq) anchorSeq = correlation.anchorSeq;
    if (correlation?.superseded) return recoverHistory(correlation);
    if (!active?.streamId) return recoverHistory(correlation);
    if (accepted && !anchorSeq) {
      if (active.finished) return unconfirmed();
      state('waiting');
      interval = Math.min(interval * 1.5, 5000);
      continue;
    }

    if (streamId && active.streamId !== streamId) return recoverHistory(correlation);
    if (!streamId) {
      if (baselineActive?.streamId === active.streamId) return recoverHistory(correlation);
      streamId = active.streamId;
      cursor = 0;
      emit({ type: 'meta', data: { stream_id: streamId } });
    }
    if (lastState === 'reconnecting') state(semanticState);

    const fresh = active.events.filter((item) => item.seq > cursor);
    // A ring-buffer gap cannot be repaired by appending fragments. History is
    // only usable when it agrees with every already rendered reply prefix.
    if (active.nextSeq <= cursor || (fresh.length && fresh[0].seq !== cursor + 1) || (!fresh.length && active.nextSeq > cursor + 1)) return recoverHistory(correlation, active.finished);
    let progressed = false;
    for (const item of fresh) {
      if (item.seq !== cursor + 1) return recoverHistory(correlation, active.finished);
      cursor = item.seq;
      if (skipExistingReply) {
        if (item.type === 'message_stop') skipExistingReply = false;
        continue;
      }
      if (item.supported) {
        emit({ type: item.type, data: item.data });
        progressed = true;
      }
    }
    if (active.finished) {
      if (completedBoundary && !skipExistingReply) return { accepted, completed: true };
      return recoverHistory(correlation);
    }
    if (!progressed && semanticState === 'waiting') state('waiting');
    else lastState = '';
    interval = fresh.length ? 500 : Math.min(interval * 1.5, 5000);
  }
}
