'use strict';
const {randomUUID} = require('node:crypto');
const {ChatSessions} = require('./chat-sessions.cjs');
const {validate} = require('../renderer/chat-references.js');
const fail = (code, message) => Object.assign(new Error(message), {code});

// A fresh scene namespace and an in-memory store per open set of cards. Ordinary ChatSessions
// cannot import these rows, including after a reload. The Being's own memory is still shared.
class ChatDetails {
  constructor({getContext, hasParent, onEvent = () => {}, clientVersion = '', fetchImpl, timers} = {}) {
    Object.assign(this, {getContext, hasParent, onEvent, clientVersion, fetchImpl, timers});
    this.cards = new Map(); this.sessions = null; this.ready = null;
  }
  reset(notify = true) {
    const sessions = this.sessions;
    this.sessions = null; this.ready = null; this.cards.clear();
    sessions?.end();
    if (notify) this.onEvent({type: 'reset'});
  }
  async open({parentSessionId, reference} = {}) {
    if (!this.hasParent(parentSessionId)) throw fail('INVALID_REQUEST', '来源会话不存在。');
    try { reference = validate([reference])[0]; } catch (error) { throw fail('INVALID_REQUEST', error.message); }
    if (this.cards.size >= 8) throw fail('BUSY', '请先关闭一个解释卡片。');
    if (!this.sessions) {
      const sessions = new ChatSessions({desktopId: randomUUID(),
        getContext: () => this.sessions === sessions ? this.getContext() : {connected: false},
        clientVersion: this.clientVersion, fetchImpl: this.fetchImpl, timers: this.timers,
        onEvent: event => { if (this.sessions === sessions && this.cards.has(event.sessionId)) this.onEvent(event); },
        onState: () => { if (this.sessions === sessions) this.onEvent({type: 'state'}); }});
      this.sessions = sessions;
      this.ready = sessions.start('temporary-details');
    }
    const sessions = this.sessions;
    await this.ready;
    if (sessions !== this.sessions || !this.hasParent(parentSessionId)) throw fail('SESSION_CHANGED', '会话已变化，请重新选择文本。');
    if (this.cards.size >= 8) throw fail('BUSY', '请先关闭一个解释卡片。');
    const sessionId = sessions.create({title: '更多详情'});
    this.cards.set(sessionId, {sessionId, parentSessionId, reference, sending: false});
    return this.view(sessionId);
  }
  _card(id) {
    const card = this.cards.get(id);
    if (!card || !this.sessions || !this.hasParent(card.parentSessionId)) throw fail('INVALID_REQUEST', '解释卡片已关闭。');
    return card;
  }
  view(id) {
    const card = this._card(id);
    const state = this.sessions.snapshot();
    const recovery = state.recovery.sessionId && state.recovery.sessionId !== id ? {phase: 'idle'} : state.recovery;
    return {...card, ...this.sessions.view(id), recovery};
  }
  async send({sessionId, text} = {}) {
    const card = this._card(sessionId);
    if (card.sending) throw fail('BUSY', '这张卡片正在回复，请稍候。');
    card.sending = true;
    try { return await this.sessions.send({sessionId, text, references: [card.reference]}); }
    finally { card.sending = false; if (this.cards.has(sessionId)) this.onEvent({type: 'state', sessionId}); }
  }
  stop(sessionId) { this._card(sessionId); return this.sessions.stop({sessionId}); }
  close(id) {
    this.cards.delete(id);
    // Disposing readers never interrupts a Being's server-side breath or sends another message.
    if (!this.cards.size) this.reset(false);
    return true;
  }
}
module.exports = {ChatDetails};
