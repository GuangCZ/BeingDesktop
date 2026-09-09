'use strict';

class PortalWatchdog {
  constructor({portal, startPortal, getContext, checkHealth, serialize = fn => fn(), onChange = () => {},
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout}) {
    Object.assign(this, {portal, startPortal, getContext, checkHealth, serialize, onChange, now, setTimer, clearTimer});
    this.active = false;
    this.paused = false;
    this.timer = null;
    this.pending = null;
    this.healthTask = null;
    this.healthController = null;
    this.healthKey = '';
    this.nextHealthAt = 0;
    this.nextAttemptAt = 0;
    this.attempts = 0;
    this.externalObserved = false;
    this.observedPid = null;
    this.runningSince = null;
    this.contextKey = '';
    this.report = {status:'inactive', detail:'自动守护尚未启动。', attempts:0, starts:0, retryAt:null, health:null};
  }

  state() { return structuredClone(this.report); }

  _update(patch) {
    Object.assign(this.report, patch);
    this.onChange();
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.wake();
  }

  stop() {
    this.active = false;
    this.clearTimer(this.timer);
    this.timer = null;
    this._cancelHealth();
    this._update({status:'inactive', detail:'自动守护已暂停。', retryAt:null});
  }

  pause() {
    this.paused = true;
    this._cancelHealth();
    this._update({status:'paused', detail:'已手动停止；本次桌面会话暂停自动拉起，点击启动可恢复。', retryAt:null, health:null});
  }

  resume() {
    this.paused = false;
    this.attempts = 0;
    this.nextAttemptAt = 0;
    this.wake();
  }

  wake() {
    if (!this.active) return;
    this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = null; void this.tick(); }, 0);
    this.timer?.unref?.();
  }

  _allowed() { return this.active && !this.paused && !this.getContext().blocked; }

  tick() {
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(() => this.serialize(() => this._tick())).catch(() => {
      if (this._allowed()) this._update({status:'error', detail:'自动检查未完成，将继续重试。'});
    }).finally(() => {
      this.pending = null;
      if (!this.active) return;
      this.clearTimer(this.timer);
      const delay = this.nextAttemptAt > this.now() ? Math.min(5000, this.nextAttemptAt - this.now()) : 5000;
      this.timer = this.setTimer(() => { this.timer = null; void this.tick(); }, delay);
      this.timer?.unref?.();
    });
    return this.pending;
  }

  async _tick() {
    if (!this._allowed()) return;
    const context = this.getContext();
    const state = this.portal.state;
    const key = JSON.stringify([context.identity, state.executable, state.configPath]);
    if (key !== this.contextKey) {
      this.contextKey = key;
      this.attempts = 0;
      this.nextAttemptAt = 0;
      this._cancelHealth();
      this._update({health:null});
    }
    await this.portal.inspect();
    if (!this._allowed() || context.identity !== this.getContext().identity) return;
    const current = this.portal.state;
    if (current.status === 'external' || current.management === 'external') this.externalObserved = true;
    this._update({checkedAt:new Date(this.now()).toISOString()});
    if (current.pid && ['running','external'].includes(current.status)) {
      if (this.observedPid !== current.pid) {
        this.observedPid = current.pid;
        this.runningSince = this.now();
      }
      if (this.now() - this.runningSince >= 60000) { this.attempts = 0; this.nextAttemptAt = 0; }
      this._update({status:'monitoring', detail:current.owned ? '自动守护中：每 5 秒检查进程，退出后自动拉起；每 30 秒检查连接健康。' : '正在检查已有 Portal；配置和重启由原部署方式管理。', retryAt:null, attempts:this.attempts});
      this._health(context, current);
      return;
    }
    this.observedPid = null;
    this.runningSince = null;
    this._cancelHealth();
    this._update({health:null});
    if (current.status === 'error') {
      this._update({status:'error', detail:'无法确认已有进程，暂缓自动启动；5 秒后重新检查。', retryAt:null});
      return;
    }
    if (this.externalObserved || context.allowAutomaticStart === false) {
      this._update({status:'waiting', detail:'已有 Portal 优先；等待原管理方式恢复，Desktop 不会接管或启动另一实例。', retryAt:null});
      return;
    }
    if (!context.ready || !current.executable || !current.configPath) {
      this._update({status:'waiting', detail:'等待保存 Being 连接、Portal 程序和配置后自动启动。', retryAt:null});
      return;
    }
    if (this.now() < this.nextAttemptAt) {
      this._update({status:'backoff', detail:'Portal 未运行，正在等待自动重试。', retryAt:new Date(this.nextAttemptAt).toISOString()});
      return;
    }
    this.attempts++;
    this._update({status:'starting', detail:'正在自动启动 Portal…', attempts:this.attempts, retryAt:null});
    try {
      const result = await this.startPortal();
      if (result.owned) this._update({starts:this.report.starts + 1});
    } catch {
      // Never expose spawn arguments, configuration contents, or connection credentials.
    }
    this.nextAttemptAt = this.now() + Math.min(60000, 2000 * (2 ** Math.min(this.attempts - 1, 5)));
    if (!this._allowed()) return;
    const started = this.portal.state;
    if (started.pid && ['running','external'].includes(started.status)) {
      this.observedPid = started.pid;
      this.runningSince = this.now();
      this._update({status:'monitoring', detail:'Portal 已运行，自动守护已启用。', retryAt:null});
      this._health(this.getContext(), started);
    } else {
      this._update({status:'backoff', detail:'Portal 自动启动未完成，请检查程序与配置；将自动重试。', retryAt:new Date(this.nextAttemptAt).toISOString()});
    }
  }

  _cancelHealth() {
    this.healthController?.abort();
    this.healthController = null;
    this.healthTask = null;
    this.healthKey = '';
    this.nextHealthAt = 0;
  }

  _health(context, state) {
    if (!this.checkHealth) return;
    const key = JSON.stringify([context.identity, state.pid, state.owned, state.health]);
    if (key !== this.healthKey) { this._cancelHealth(); this.healthKey = key; }
    if (this.healthTask || this.now() < this.nextHealthAt) return;
    const controller = new AbortController();
    this.healthController = controller;
    this._update({health:{status:'checking', detail:'正在自动检查进程、Being 运行时与中继握手…', checks:[]}});
    // Network health checks must not hold up process recovery or the mutation queue.
    this.healthTask = Promise.resolve().then(() => this.checkHealth(controller.signal)).then(result => {
      if (this._allowed() && this.healthController === controller && context.identity === this.getContext().identity && state.pid === this.portal.state.pid) this._update({health:result});
    }).catch(() => {
      if (this._allowed() && this.healthController === controller) this._update({health:{status:'unknown', detail:'自动健康检查未完成，将重新检查。', checks:[]}});
    }).finally(() => {
      if (this.healthController !== controller) return;
      this.healthTask = null;
      this.nextHealthAt = this.now() + 30000;
    });
  }
}

module.exports = {PortalWatchdog};
