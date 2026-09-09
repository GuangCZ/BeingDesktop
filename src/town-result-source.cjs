'use strict';

// This marker is assigned only by the local reader, never by remote JSON.
const relayed = new WeakSet();
function markBeingRelay(value) { relayed.add(value); return value; }
function relaySource(value) { return relayed.has(value) ? {source: 'being_relay'} : {}; }
module.exports = {markBeingRelay, relaySource};
