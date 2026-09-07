'use strict';

// A fixed-response diagnostic adapter, not an official Portal tool implementation.
// Importing this module never starts a connection or reads local credentials.
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');

const TOOL_NAME = 'diagnostics_roundtrip';
const FIXTURE_MARKER = 'BEING_TOOL_ROUNDTRIP_OK_V1';
const MAX_MESSAGE_BYTES = 16384;
const MAX_MESSAGES = 256;

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keysAllowed(value, allowed) { return object(value) && Object.keys(value).every((key) => allowed.includes(key)); }
function empty(value) { return object(value) && Object.keys(value).length === 0; }
function validId(value) { return Number.isSafeInteger(value) && value >= 0 || typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value); }
function shortString(value) { return typeof value === 'string' && value.length > 0 && value.length <= 128; }

function errorOutcome(id, code, message, category, notification = false) {
  return { accepted: false, fixtureProcessed: false, category, response: notification ? null : { jsonrpc: '2.0', id, error: { code, message } } };
}

function success(id, result, category, fixtureProcessed = false) {
  return { accepted: true, fixtureProcessed, category, response: { jsonrpc: '2.0', id, result } };
}

function handleMcpText(text) {
  if (typeof text !== 'string') return errorOutcome(null, -32600, 'Text frames required.', 'non_text_rejected');
  if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) return errorOutcome(null, -32600, 'Message too large.', 'oversize_rejected');
  let request;
  try { request = JSON.parse(text); } catch { return errorOutcome(null, -32700, 'Invalid JSON.', 'invalid_json_rejected'); }
  if (!object(request)) return errorOutcome(null, -32600, 'Single request object required.', 'invalid_request_rejected');
  const hasId = Object.hasOwn(request, 'id');
  const id = hasId && validId(request.id) ? request.id : null;
  if (!keysAllowed(request, ['jsonrpc', 'id', 'method', 'params']) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || !request.method.length || hasId && id === null) {
    return errorOutcome(id, -32600, 'Invalid request.', 'invalid_request_rejected', !hasId);
  }
  if (!hasId) return errorOutcome(null, -32600, 'Notifications are not executable.', 'notification_ignored', true);
  const params = Object.hasOwn(request, 'params') ? request.params : {};
  const invalidParams = () => errorOutcome(id, -32602, 'Parameters not permitted.', 'invalid_params_rejected');
  switch (request.method) {
    case 'initialize': {
      if (!keysAllowed(params, ['protocolVersion', 'capabilities', 'clientInfo'])) return invalidParams();
      if (Object.hasOwn(params, 'protocolVersion') && !shortString(params.protocolVersion)) return invalidParams();
      if (Object.hasOwn(params, 'capabilities') && !object(params.capabilities)) return invalidParams();
      if (Object.hasOwn(params, 'clientInfo') && (!keysAllowed(params.clientInfo, ['name', 'version']) || !shortString(params.clientInfo.name) || !shortString(params.clientInfo.version))) return invalidParams();
      return success(id, { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'being-desktop-fixture-adapter', version: '1.0.0' } }, 'initialize_accepted');
    }
    case 'ping':
      return empty(params) ? success(id, {}, 'ping_accepted') : invalidParams();
    case 'tools/list':
      if (!empty(params)) return invalidParams();
      return success(id, { tools: [{ name: TOOL_NAME, description: 'Return a fixed public diagnostic marker. No host capabilities.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }, 'tool_list_accepted');
    case 'tools/call':
      if (!keysAllowed(params, ['name', 'arguments']) || params.name !== TOOL_NAME || !Object.hasOwn(params, 'arguments') || !empty(params.arguments)) return invalidParams();
      return success(id, { content: [{ type: 'text', text: FIXTURE_MARKER }], isError: false }, 'fixture_processed', true);
    default:
      return errorOutcome(id, -32601, 'Method not permitted.', 'method_rejected');
  }
}

class FixtureAdapter {
  #socket = null;
  #generation = 0;
  #handshakeTimer = null;
  #heartbeatTimer = null;
  #pendingReject = null;
  #state = { status: 'idle', lastEvent: 'idle', lastFixture: null, counters: { received: 0, accepted: 0, denied: 0, fixtureExecutions: 0, responsesSent: 0, fixtureResponsesSent: 0 } };
  #onEvent;
  #WebSocket;
  #clock;
  #setTimeout;
  #clearTimeout;
  #setInterval;
  #clearInterval;

  constructor({ onEvent = () => {}, WebSocketImpl = globalThis.WebSocket, clock = () => performance.now(), timers = globalThis } = {}) {
    this.#onEvent = onEvent;
    this.#WebSocket = WebSocketImpl;
    this.#clock = clock;
    this.#setTimeout = timers.setTimeout.bind(timers);
    this.#clearTimeout = timers.clearTimeout.bind(timers);
    this.#setInterval = timers.setInterval.bind(timers);
    this.#clearInterval = timers.clearInterval.bind(timers);
  }

  get state() { return { ...this.#state, lastFixture: this.#state.lastFixture && { ...this.#state.lastFixture }, counters: { ...this.#state.counters } }; }

  #event(category) {
    this.#state.lastEvent = category;
    try { this.#onEvent({ category, ...this.state }); } catch { /* Observers cannot change dispatch behavior. */ }
  }

  #clearTimers() {
    this.#clearTimeout(this.#handshakeTimer);
    this.#clearInterval(this.#heartbeatTimer);
    this.#handshakeTimer = null;
    this.#heartbeatTimer = null;
  }

  #terminate(category, status = 'error', closeCode = 1008) {
    const socket = this.#socket;
    this.#generation++;
    this.#socket = null;
    this.#clearTimers();
    this.#state.status = status;
    const reject = this.#pendingReject;
    this.#pendingReject = null;
    reject?.(new Error('Fixture connection did not complete.'));
    try { socket?.close(closeCode, 'Diagnostic session ended'); } catch { /* Local processing is already disabled. */ }
    this.#event(category);
  }

  #send(value) {
    const socket = this.#socket;
    if (!socket || socket.readyState !== 1 || socket.bufferedAmount > 65536) { this.#terminate('send_unavailable'); return false; }
    try { socket.send(JSON.stringify(value)); return true; }
    catch { this.#terminate('send_failed'); return false; }
  }

  async connect({ relayUrl, beingId, loomToken, portalName = 'desktop-diagnostics' } = {}) {
    if (this.#socket) throw new Error('Fixture session is already active.');
    let url;
    try { url = new URL(relayUrl); } catch { throw new Error('Invalid relay endpoint.'); }
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'wss:' && !(url.protocol === 'ws:' && local)) || url.username || url.password || url.search || url.hash || url.pathname !== '/_relay') throw new Error('Invalid relay endpoint.');
    if (typeof beingId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(beingId) || typeof loomToken !== 'string' || loomToken.length < 1 || loomToken.length > 4096 || /[\r\n\0]/.test(loomToken)) throw new Error('Invalid relay identity.');
    if (typeof portalName !== 'string' || !/^desktop-diagnostics(?:-[a-zA-Z0-9_-]{1,48})?$/.test(portalName)) throw new Error('Use a dedicated diagnostic Portal name.');
    let socket;
    try { socket = new this.#WebSocket(url.toString()); } catch { throw new Error('Fixture transport initialization failed.'); }
    this.#socket = socket;
    const generation = ++this.#generation;
    const current = () => this.#socket === socket && this.#generation === generation;
    this.#state.status = 'connecting';
    this.#event('connecting');
    let handshake = { being_id: beingId, loom_token: loomToken, portal_name: portalName };
    let lastSeen = this.#clock();
    return new Promise((resolve, reject) => {
      this.#pendingReject = reject;
      this.#handshakeTimer = this.#setTimeout(() => { if (current()) this.#terminate('handshake_timeout'); }, 10000);
      socket.addEventListener('open', () => {
        if (!current()) { handshake = null; return; }
        this.#send(handshake);
        handshake = null;
      });
      socket.addEventListener('message', ({ data }) => {
        if (!current()) return;
        if (typeof data !== 'string') { this.#terminate('non_text_rejected', 'error', 1003); return; }
        if (Buffer.byteLength(data, 'utf8') > MAX_MESSAGE_BYTES) { this.#terminate('oversize_rejected', 'error', 1009); return; }
        if (++this.#state.counters.received > MAX_MESSAGES) { this.#terminate('message_limit_reached'); return; }
        let message;
        try { message = JSON.parse(data); } catch { message = null; }
        if (this.#state.status === 'connecting') {
          if (!keysAllowed(message, ['ok', 'relay_keepalive']) || message.ok !== true || message.relay_keepalive !== 'text-v1') { this.#terminate('handshake_rejected'); return; }
          this.#clearTimeout(this.#handshakeTimer);
          this.#handshakeTimer = null;
          this.#pendingReject = null;
          this.#state.status = 'connected';
          lastSeen = this.#clock();
          this.#heartbeatTimer = this.#setInterval(() => {
            if (!current()) return;
            if (this.#clock() - lastSeen > 90000) { this.#terminate('heartbeat_timeout', 'disconnected'); return; }
            this.#send({ type: 'keepalive' });
          }, 15000);
          this.#event('handshake_accepted');
          resolve(this.state);
          return;
        }
        if (keysAllowed(message, ['type']) && message.type === 'keepalive_ack') { lastSeen = this.#clock(); return; }
        const outcome = handleMcpText(data);
        if (outcome.accepted) { this.#state.counters.accepted++; lastSeen = this.#clock(); }
        else this.#state.counters.denied++;
        if (outcome.fixtureProcessed) {
          this.#state.counters.fixtureExecutions++;
          this.#state.lastFixture = { requestIdSha256: createHash('sha256').update(JSON.stringify(outcome.response.id)).digest('hex'), processingCount: this.#state.counters.fixtureExecutions, responseQueued: false };
        }
        if (outcome.response) {
          if (!this.#send(outcome.response)) return;
          this.#state.counters.responsesSent++;
          if (outcome.fixtureProcessed) { this.#state.counters.fixtureResponsesSent++; this.#state.lastFixture.responseQueued = true; }
        }
        this.#event(outcome.category);
      });
      socket.addEventListener('error', () => { handshake = null; if (current()) this.#terminate('transport_error'); });
      socket.addEventListener('close', () => { handshake = null; if (current()) this.#terminate('transport_closed', 'disconnected'); });
    });
  }

  async stop() { this.#terminate('stopped', 'stopped', 1000); return this.state; }
  async dispose() { return this.stop(); }
}

module.exports = { FixtureAdapter, handleMcpText, TOOL_NAME, FIXTURE_MARKER, MAX_MESSAGE_BYTES, MAX_MESSAGES };
