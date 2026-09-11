'use strict';

// Disconnect resilience for Desktop's own message layer, ported from loom.html (2468–2700,
// 3945–4030, 4087–4330). The governing fact: the server buffers a whole breath in
// /api/stream/active and a client disconnect does not interrupt it. So a broken stream is never
// an error to report — it is a question to ask the server, followed by one of three moves:
//   - still progressing, or finished with a tail we have not read → cut over to the replay buffer
//   - gone or taken over by another client                         → the reply is on disk; reconcile
//   - the server has not moved either                              → wait, and ask again later
//
// Two disciplines carried over verbatim:
//   - One writer at a time (Loom's F1/F2). A live reader that is still alive is cut off before the
//     replay poller starts, or both write the same text into the same conversation. Every writer
//     holds an epoch, and a stale one stops at its next opportunity.
//   - History is the only durable sink. Live and replay events reach the renderer; only history
//     rows reach the store, through one reconcile path either way.
//
// What changes for Desktop: a stream is not ours by virtue of being the one we opened. Replay is
// routed by scene exactly like live events (BeingChat.replay), so taking over another client's
// stream is safe — its scenes are dropped, ours are delivered — and it is the right thing after a
// 202, because that is where a spliced reply comes out.

const {sceneId, sessionFromScene} = require('./being-chat.cjs');

// Silence budgets per phase (loom.html:2506). Slower is better than killing a legitimately slow
// tool: run_command or browse_web can take five minutes.
const STALL_MS = {awaiting_first: 75000, reasoning: 90000, text: 45000, tool: 300000};
const STALL_BACKOFF_MS = [30000, 60000, 120000];
const STALL_GIVEUP_MS = 15 * 60 * 1000;
const WATCHDOG_TICK_MS = 5000;
// `usage` is deliberately not progress: it can arrive alone at the very end.
const PROGRESS = new Set(['content_block_delta', 'thinking', 'reasoning', 'tool_use', 'tool_result', 'message_stop', 'error']);
const POLL_INITIAL_MS = 500;
const POLL_MAX_INTERVAL_MS = 5000;
const POLL_ABSOLUTE_MAX_MS = 30 * 60 * 1000;
const POLL_MAX_NET_FAILS = 6;
const AUTONOMOUS_POLL_MS = 2000;
const CATCH_UP_INITIAL_MS = 2000;
const CATCH_UP_MAX_INTERVAL_MS = 30000;
const CATCH_UP_ABSOLUTE_MAX_MS = 5 * 60 * 1000;
const RECOVERY_BACKOFF_MS = [2000, 5000, 10000, 30000];
const CURSOR_SYNC_DELAYS = [0, 500, 1000];
const MAX_INCREMENTAL_PAGES = 10;
const gone = code => code === 'NOT_CONNECTED' || code === 'SESSION_CHANGED' || code === 'AUTH_REQUIRED';

// Per stream: when stalling began, when the next probe is due, and the backoff step.
function stallTracker(clock) {
  return {firstStalledAt: 0, nextProbeAt: 0, index: 0,
    due() { return clock() >= this.nextProbeAt; },
    onStalled() {
      const now = clock();
      if (!this.firstStalledAt) this.firstStalledAt = now;
      const delay = STALL_BACKOFF_MS[Math.min(this.index++, STALL_BACKOFF_MS.length - 1)];
      this.nextProbeAt = now + delay;
      return {totalMs: now - this.firstStalledAt, nextInMs: delay};
    }};
}

class BeingRecovery {
  constructor({chat, store, timers = {setTimeout, clearTimeout}, clock = Date.now, onEvent = () => {}, onState = () => {}} = {}) {
    if (!chat || !store) throw new TypeError('BeingRecovery needs a chat client and a store');
    Object.assign(this, {chat, store, timers, clock, onEvent, onState});
    this._epoch = 0;
    this._live = null; this._poll = null; this._catchUp = null; this._autonomous = null; this._pending = null;
    this._reconcile = null;
    this._phase = {phase: 'idle'};
    // Conversation-level events pass straight through; the watchdog listens to the connection.
    this.chat.onEvent = event => { try { this.onEvent(event); } catch { /* Observers cannot affect recovery. */ } };
  }

  state() { return {...this._phase, pending: !!this._pending, live: !!this._live, replaying: !!this._poll, catchingUp: !!this._catchUp, watching: !!this._autonomous}; }

  _setPhase(phase, extra = {}) {
    this._phase = {phase, ...extra};
    try { this.onState(this.state()); } catch { /* Observers cannot affect recovery. */ }
  }

  _later(ms, callback) { return this.timers.setTimeout(callback, Math.max(0, ms)); }

  // A writer ended for good. Any conversation it left with an open bubble gets told, so a bubble
  // cut off by a disconnect does not sit there streaming forever; history then reconciles it.
  _settle(router) {
    if (!router) return;
    for (const sessionId of router.settle()) { try { this.onEvent({sessionId, type: 'settled'}); } catch { /* Observers cannot affect recovery. */ } }
  }
  _cancel(timer) { if (timer) this.timers.clearTimeout(timer); }

  /**
   * Send on behalf of a conversation and see its reply through, whatever the connection does.
   *
   * Resolves once the message is delivered and its reply is either fully read (`streamed`) or
   * handed to a recovery path (`recovering`). Only pre-dispatch failures reject.
   */
  async send({sessionId, text, images = [], sceneMeta, signal, onDelta = () => {}} = {}) {
    // A new live writer invalidates every replay poller and any older reader (F2).
    this._stopPoll(); this._stopCatchUp();
    const controller = new AbortController();
    const live = {epoch: ++this._epoch, sessionId, controller, streamId: '', liveSeq: 0, phase: 'awaiting_first', router: null,
      lastProgress: this.clock(), stall: stallTracker(this.clock), busy: false, timer: null, cutover: null, recover: false, gaveUp: false};
    // The router outlives this connection: a cutover hands it to the replay poller with its
    // half-built reply text intact.
    live.router = this.chat.router({scene: sceneId(this.chat.desktopId, sessionId), sessionId, onDelta, onProgress: progress => this._progress(live, progress)});
    this._live = live;
    this._setPhase('streaming', {sessionId});
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    live.timer = this._later(WATCHDOG_TICK_MS, () => this._watchdogTick(live));
    let result = null, failure = null;
    try {
      result = await this.chat.send({sessionId, text, images, sceneMeta, signal: combined, router: live.router});
    } catch (error) { failure = error; }
    // The reader is over either way; release the writer slot before any recovery path looks at it.
    this._cancel(live.timer); live.timer = null;
    if (this._live === live) this._live = null;
    if (result) {
      if (!result.streamed) {
        // 202: the reply comes out on whatever connection is open, or nowhere. Watch history for
        // it, and take over the running stream if there is one — that is where a splice surfaces.
        this.startCatchUpWatcher({sessionId});
        return result;
      }
      // SSE close is end-of-turn (loom.html:2995). Trust it: the reply is on disk before Done, so
      // pull it with its seq. But a close that delivered no reply to the asking conversation is
      // either a breath that yielded elsewhere or a proxy cutting a live breath — both are the
      // 202 situation in disguise, and the catch-up watcher handles both.
      this._settle(live.router);
      if (result.replies === 0) { this.startCatchUpWatcher({sessionId}); return result; }
      this._setPhase('idle');
      void this.syncCursor();
      return result;
    }
    const progress = failure?.progress || {streamId: live.streamId, liveSeq: live.liveSeq};
    if (live.cutover) {
      this.cutoverToReplay({streamId: progress.streamId || live.streamId, fromSeq: progress.liveSeq, sessionId, initial: live.cutover, router: live.router});
      return {ok: true, streamed: false, recovering: 'replay', ...progress};
    }
    if (live.recover) { await this.recoverViaHistory({router: live.router}); return {ok: true, streamed: false, recovering: 'history', ...progress}; }
    if (live.gaveUp) { await this.recoverViaHistory({router: live.router}); return {ok: true, streamed: false, recovering: 'history', gaveUp: true, ...progress}; }
    if (failure?.code !== 'RESULT_UNKNOWN') { this._settle(live.router); this._setPhase('idle'); throw failure; }
    if (signal?.aborted) {
      // The user stopped reading, not the Being breathing: the reply still lands in history.
      this._settle(live.router);
      this.startCatchUpWatcher({sessionId});
      return {ok: true, streamed: false, recovering: 'catch-up', ...progress};
    }
    // The message landed and the breath continues without us: recover rather than report. The
    // router travels with the intent so a later cutover continues the same half-built reply.
    this.queueDisconnectRecovery({streamId: progress.streamId, localSeq: progress.liveSeq, sessionId, router: live.router});
    return {ok: true, streamed: false, recovering: 'probe', ...progress};
  }

  _progress(live, {type, liveSeq, streamId}) {
    if (this._live !== live) return;
    if (streamId) live.streamId = streamId;
    live.liveSeq = Math.max(live.liveSeq, liveSeq);
    if (!PROGRESS.has(type)) return;
    live.lastProgress = this.clock();
    live.stall = stallTracker(this.clock);
    if (type === 'tool_use') live.phase = 'tool';
    else if (type === 'tool_result' || type === 'content_block_delta') live.phase = 'text';
    else if (type === 'thinking' || type === 'reasoning') live.phase = 'reasoning';
  }

  // Watchdog (loom.html:2753). Expiry does not abort: it asks the server first, and only the
  // verdict decides whether to switch channels, fall back to history, or keep waiting.
  async _watchdogTick(live) {
    live.timer = null;
    if (this._live !== live) return;
    const stalledFor = this.clock() - live.lastProgress;
    if (!live.busy && stalledFor >= (STALL_MS[live.phase] || STALL_MS.awaiting_first) && live.stall.due()) {
      live.busy = true;
      try { await this._onWatchdogExpired(live); } catch { /* A failed probe is retried on the next tick. */ }
      live.busy = false;
    }
    if (this._live === live) live.timer = this._later(WATCHDOG_TICK_MS, () => this._watchdogTick(live));
  }

  async _onWatchdogExpired(live) {
    if (!live.streamId) {
      // Not even meta arrived: there is nothing to probe for. Give up on this connection; history
      // still recovers whatever the Being says.
      if (live.stall.onStalled().totalMs >= STALL_GIVEUP_MS) { live.gaveUp = true; live.controller.abort(); }
      return;
    }
    let probe;
    try { probe = await this.chat.probe({streamId: live.streamId, after: live.liveSeq, localSeq: live.liveSeq}); }
    catch (error) { probe = {verdict: gone(error?.code) ? 'abandoned' : 'unreachable'}; }
    if (this._live !== live || live.cutover || live.recover) return;
    switch (probe.verdict) {
      case 'progressing': case 'finished': live.cutover = probe; live.controller.abort(); return;
      case 'gone': case 'superseded': live.recover = true; live.controller.abort(); return;
      case 'abandoned': live.gaveUp = true; live.controller.abort(); return;
      case 'stalled': {
        const {totalMs, nextInMs} = live.stall.onStalled();
        if (totalMs >= STALL_GIVEUP_MS) { live.gaveUp = true; live.controller.abort(); return; }
        this._setPhase('streaming', {sessionId: live.sessionId, hint: `服务端也没有新进展，${Math.round(nextInMs / 1000)} 秒后再检查一次`});
        return;
      }
      default: {
        const {totalMs} = live.stall.onStalled();
        this._setPhase('streaming', {sessionId: live.sessionId, hint: '连接中断了，正在自动恢复…'});
        if (totalMs >= STALL_GIVEUP_MS) { live.gaveUp = true; live.controller.abort(); }
      }
    }
  }

  // Seamless cutover (loom.html:2615): fold the buffer from `fromSeq` on, so the text joins with
  // not one character repeated or missing, then keep polling until the breath finishes.
  cutoverToReplay({streamId, fromSeq = 0, sessionId = '', initial = null, router = null} = {}) {
    this._stopPoll(); this._stopAutonomous();
    const epoch = ++this._epoch;
    // F1: a live reader that is still alive must be killed, not just forgotten. Its router, with
    // the reply text so far, is what the poller continues from.
    if (this._live && !this._live.controller.signal.aborted) {
      router = router || this._live.router; sessionId = sessionId || this._live.sessionId;
      this._live.cutover = this._live.cutover || {verdict: 'progressing', events: []}; this._live.controller.abort();
    }
    // A pending recovery this cutover does not continue is abandoned; its half-built reply settles.
    if (this._pending && this._pending.router !== router) this._settle(this._pending.router);
    this._pending = null;
    const poll = {epoch, streamId, sessionId, cursor: fromSeq, interval: POLL_INITIAL_MS, netFails: 0, deadline: this.clock() + POLL_ABSOLUTE_MAX_MS, timer: null,
      router: router || this.chat.router({sessionId})};
    this._poll = poll;
    this._setPhase('replaying', {sessionId, streamId});
    if (initial?.events?.length) poll.cursor = this.chat.replay({events: initial.events, from: poll.cursor, router: poll.router}).cursor;
    if (initial?.verdict === 'finished') { this._finishReplay(poll); return; }
    poll.timer = this._later(poll.interval, () => this._pollOnce(poll));
  }

  _finishReplay(poll) {
    if (this._poll === poll) this._poll = null;
    this._settle(poll.router);
    this._setPhase('idle');
    void this.syncCursor();
  }

  async _pollOnce(poll) {
    poll.timer = null;
    if (this._poll !== poll || poll.epoch !== this._epoch) return;
    if (this.clock() > poll.deadline) { await this.recoverViaHistory({router: poll.router}); return; }
    try {
      const probe = await this.chat.probe({streamId: poll.streamId, after: poll.cursor, localSeq: poll.cursor});
      if (this._poll !== poll) return;
      poll.netFails = 0;
      // Gone: the stream was cleaned up, so its content is on disk. Superseded: another client
      // started a new breath; align through history rather than silently finalize.
      if (probe.verdict === 'gone' || probe.verdict === 'superseded') { await this.recoverViaHistory({router: poll.router}); return; }
      if (probe.events.length) poll.cursor = this.chat.replay({events: probe.events, from: poll.cursor, router: poll.router}).cursor;
      if (this._poll !== poll) return;
      if (probe.verdict === 'finished') { this._finishReplay(poll); return; }
    } catch (error) {
      if (gone(error?.code)) { this._poll = null; this._setPhase('idle'); return; }
      if (++poll.netFails >= POLL_MAX_NET_FAILS) {
        // Hand off to the reconnect path; it will probe its way back when the network returns.
        this._poll = null;
        this.queueDisconnectRecovery({streamId: poll.streamId, localSeq: poll.cursor, sessionId: poll.sessionId, router: poll.router});
        return;
      }
      poll.interval = Math.min(poll.interval * 1.5, POLL_MAX_INTERVAL_MS);
    }
    if (this._poll === poll) poll.timer = this._later(poll.interval, () => this._pollOnce(poll));
  }

  _stopPoll() { if (this._poll) { this._cancel(this._poll.timer); this._settle(this._poll.router); this._poll = null; } }

  // The stream is gone (server-side cleanup) or another client's: the reply is on disk, and the
  // assistant moment lands before Done, so history is guaranteed to have the whole of it.
  async recoverViaHistory({router = null} = {}) {
    this._stopPoll();
    this._epoch++;
    this._settle(this._pending?.router); this._pending = null;
    this._settle(router);
    const result = await this.reconcile();
    // A recovery for an older conversation may resolve while a newer one is being read live.
    if (!this._live) this._setPhase('idle');
    // If what displaced our stream is an autonomous breath, watch it and reconcile when it ends.
    void this.checkActiveStream({autonomousOnly: true});
    return result;
  }

  async applyVerdict(probe, {streamId, localSeq = 0, sessionId = '', router = null} = {}) {
    switch (probe.verdict) {
      case 'progressing': case 'finished':
        this.cutoverToReplay({streamId: probe.streamId || streamId, fromSeq: localSeq, sessionId, initial: probe, router});
        return 'cutover';
      case 'gone': case 'superseded':
        await this.recoverViaHistory({router});
        return 'recovered';
      case 'stalled':
        this._setPhase('reconnecting', {sessionId, hint: '服务端还没有新进展，正在继续等待…'});
        return 'stalled';
      default:
        this._setPhase('reconnecting', {sessionId, hint: '连接中断了，正在自动恢复…'});
        return 'unreachable';
    }
  }

  // Remember the intent and honour it when the server answers again (loom.html:2702). No button
  // for the user to press: the retry is bounded and automatic.
  queueDisconnectRecovery({streamId = '', localSeq = 0, sessionId = '', router = null} = {}) {
    if (this._pending) this._cancel(this._pending.timer);
    this._pending = {streamId, localSeq, sessionId, router, attempts: 0, timer: null, startedAt: this.clock()};
    this._setPhase('reconnecting', {sessionId, hint: '连接中断了，正在自动恢复…'});
    void this.runPendingRecovery();
  }

  async runPendingRecovery() {
    const pending = this._pending;
    if (!pending) return 'idle';
    this._cancel(pending.timer); pending.timer = null;
    let probe;
    try { probe = await this.chat.probe({streamId: pending.streamId, after: pending.localSeq, localSeq: pending.localSeq}); }
    catch (error) { probe = {verdict: gone(error?.code) ? 'abandoned' : 'unreachable'}; }
    if (this._pending !== pending) return 'idle';
    if (probe.verdict === 'abandoned') { this._pending = null; this._settle(pending.router); if (!this._live) this._setPhase('idle'); return 'abandoned'; }
    let action = probe.verdict;
    if (probe.verdict !== 'unreachable') { this._pending = null; action = await this.applyVerdict(probe, pending); }
    if (action !== 'stalled' && action !== 'unreachable') return action;
    // Not ready yet: keep the intent and ask again later, until the absolute deadline.
    if (this.clock() - pending.startedAt >= POLL_ABSOLUTE_MAX_MS) { this._pending = null; await this.recoverViaHistory({router: pending.router}); return 'recovered'; }
    this._pending = pending;
    pending.timer = this._later(RECOVERY_BACKOFF_MS[Math.min(pending.attempts++, RECOVERY_BACKOFF_MS.length - 1)], () => { void this.runPendingRecovery(); });
    return action;
  }

  // After a 202 the reply lands in history without a stream of ours to announce it. Poll history
  // with backoff until a Being row for this conversation appears (loom.html:3996), and meanwhile
  // take over whatever stream is running: a spliced reply surfaces on it as a continuation.
  startCatchUpWatcher({sessionId} = {}) {
    this._stopCatchUp();
    const watch = {sessionId, startedAt: this.clock(), sinceSeq: this.store.cursor, delay: CATCH_UP_INITIAL_MS, timer: null};
    this._catchUp = watch;
    this._setPhase('catching-up', {sessionId});
    const tick = async () => {
      watch.timer = null;
      if (this._catchUp !== watch) return;
      // A live stream of ours will draw everything; do not race it with history reads.
      if (this._live) return;
      // Any reconcile — this one, a finished replay's, an autonomous breath's — satisfies the watch.
      await this.reconcile();
      if (this._catchUp !== watch) return;
      // Silence is a legitimate outcome — a tool-only breath, or a considered no-reply — and the
      // wire cannot tell it from "not yet". Giving up is therefore reported neutrally, not as an error.
      if (this.clock() - watch.startedAt >= CATCH_UP_ABSOLUTE_MAX_MS) { this._catchUp = null; this._setPhase('idle', {sessionId, gaveUp: true, hint: '这口气没有留下给这个会话的话。'}); return; }
      watch.delay = Math.min(watch.delay * 2, CATCH_UP_MAX_INTERVAL_MS);
      watch.timer = this._later(watch.delay, tick);
    };
    watch.timer = this._later(watch.delay, tick);
    void this.checkActiveStream();
  }

  _stopCatchUp() { if (this._catchUp) { this._cancel(this._catchUp.timer); this._catchUp = null; } }

  // An autonomous breath (beating / callback / leftover) has a stream_id and origin but no events
  // (loom.html:4011): replaying it would hang a thinking bubble that never resolves. Poll only
  // `finished`, then let history bring in whatever it wrote.
  watchAutonomous({streamId, origin = ''} = {}) {
    if (this._live || !streamId) return;
    if (this._autonomous?.streamId === streamId) return;
    this._stopAutonomous();
    const watch = {streamId, origin, deadline: this.clock() + POLL_ABSOLUTE_MAX_MS, timer: null};
    this._autonomous = watch;
    this._setPhase('watching', {origin, hint: {beating: 'being 正在自己想事情…', callback: 'being 正在处理一条回调…', leftover: 'being 正在回答排队的消息…'}[origin] || 'being 正在呼吸…'});
    const tick = async () => {
      watch.timer = null;
      if (this._autonomous !== watch) return;
      let done = this.clock() > watch.deadline;
      if (!done) {
        try {
          const probe = await this.chat.probe({streamId});
          done = probe.verdict === 'gone' || probe.verdict === 'superseded' || probe.verdict === 'finished';
        } catch (error) { if (gone(error?.code)) { this._autonomous = null; this._setPhase('idle'); return; } }
      }
      if (this._autonomous !== watch) return;
      if (done) { this._autonomous = null; await this.reconcile(); if (!this._live && !this._poll) this._setPhase('idle'); return; }
      watch.timer = this._later(AUTONOMOUS_POLL_MS, tick);
    };
    watch.timer = this._later(AUTONOMOUS_POLL_MS, tick);
  }

  _stopAutonomous() { if (this._autonomous) { this._cancel(this._autonomous.timer); this._autonomous = null; } }

  // On startup, reconnect, or after a 202: take over whatever the Being is doing right now.
  async checkActiveStream({autonomousOnly = false} = {}) {
    if (this._live || this._poll) return 'busy';
    let probe;
    try { probe = await this.chat.probe({}); } catch { return 'unreachable'; }
    if (this._live || this._poll) return 'busy';
    if (probe.verdict === 'gone') return 'idle';
    if (probe.autonomous) { this.watchAutonomous({streamId: probe.streamId, origin: probe.origin}); return 'autonomous'; }
    if (autonomousOnly) return 'skipped';
    this.cutoverToReplay({streamId: probe.streamId, fromSeq: 0, initial: probe});
    return 'cutover';
  }

  // One history read feeds every conversation. Concurrent callers share the in-flight read.
  // `full` re-reads the latest page as a new baseline; otherwise increments page from the cursor.
  reconcile({full = false} = {}) {
    if (this._reconcile) return this._reconcile;
    const run = (async () => {
      const beings = new Set();
      let added = 0, cursor = this.store.cursor, ignoredAfter = false;
      const baseline = full || !this.store.seeded || cursor === 0;
      try {
        let after = baseline ? 0 : cursor;
        for (let pages = 0; pages < MAX_INCREMENTAL_PAGES; pages++) {
          const page = await this.chat.history({after, limit: 100});
          const result = await this.store.apply({rows: page.rows, cursor: page.cursor, baseline: baseline && pages === 0});
          for (const row of page.rows) if (row.role === 'being') { const id = sessionFromScene(this.chat.desktopId, row.scene_id); if (id) beings.add(id); }
          added += result.stored; cursor = result.cursor; ignoredAfter = page.ignoredAfter;
          // The baseline page is the newest window, so there is nothing "after" it to page for.
          if (baseline || !page.more || page.ignoredAfter) break;
          after = page.cursor;
        }
        return {added, beings, cursor, ignoredAfter, error: ''};
      } catch (error) {
        return {added, beings, cursor, ignoredAfter, error: error?.code || 'NETWORK_ERROR'};
      } finally {
        const watch = this._catchUp;
        if (watch && this.store.rows(watch.sessionId).some(row => row.role === 'being' && row.seq > watch.sinceSeq)) {
          this._cancel(watch.timer); this._catchUp = null;
          if (!this._live && !this._poll) this._setPhase('idle');
        }
      }
    })().finally(() => { if (this._reconcile === run) this._reconcile = null; });
    this._reconcile = run;
    return run;
  }

  // After a reply completes (loom.html:4126): the rows just landed are the ones the live channel
  // could not give a seq to, so this is their only way into the store. Three quick tries.
  async syncCursor() {
    let last = null;
    for (const delay of CURSOR_SYNC_DELAYS) {
      if (delay) await new Promise(resolve => this._later(delay, resolve));
      last = await this.reconcile();
      if (!last.error) return last;
      if (gone(last.error)) return last;
    }
    return last;
  }

  async onReconnected() {
    const action = await this.runPendingRecovery();
    if (action === 'idle') return this.checkActiveStream();
    return action;
  }

  // Delegated so the UI has one object to talk to; ownership rules live in BeingChat.stop.
  stop({sessionId, force = false} = {}) { return this.chat.stop({sessionId, force}); }

  dispose() {
    this._epoch++;
    if (this._live) { this._cancel(this._live.timer); this._live.gaveUp = true; this._live.controller.abort(); this._settle(this._live.router); }
    this._settle(this._pending?.router);
    this._stopPoll(); this._stopCatchUp(); this._stopAutonomous();
    if (this._pending) { this._cancel(this._pending.timer); this._pending = null; }
    this._setPhase('idle');
  }
}

module.exports = {BeingRecovery, stallTracker, STALL_MS, STALL_GIVEUP_MS, CATCH_UP_ABSOLUTE_MAX_MS, POLL_ABSOLUTE_MAX_MS};
