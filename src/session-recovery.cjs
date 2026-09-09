'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {sessionPartition} = require('./security.cjs');

async function readSessionRecovery(directory, connection) {
  const file = path.join(directory, 'session-recovery', sessionPartition(connection).slice(8) + '.json');
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (data.origin !== new URL(connection.displayUrl).origin || !Array.isArray(data.entries) || typeof data.id !== 'string') return null;
    return data;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Runs before session initialization. Existing conversations are never overwritten.
function importSessionRecovery(recovery, desktopId) {
  if (!recovery || window !== window.top || recovery.origin !== location.origin) return;
  const legacyKey = 'being-desktop-sessions-v1:' + location.pathname;
  const owner = localStorage.getItem(legacyKey + ':desktop-owner');
  if (desktopId && ((owner && owner !== desktopId) || (recovery.desktopId && recovery.desktopId !== desktopId))) return;
  const scopedKey = desktopId && 'being-desktop-sessions-v2:' + desktopId + ':' + location.pathname;
  // Before the first migration, merge into the legacy store so initialization
  // can migrate the complete history. Subsequent recoveries use the new store.
  const key = scopedKey && localStorage.getItem(scopedKey) ? scopedKey : legacyKey;
  const marker = key + ':recovery:' + recovery.id;
  if (localStorage.getItem(marker) || localStorage.getItem(legacyKey + ':recovery:' + recovery.id)) return;
  const entries = new Map(recovery.entries);
  const incoming = JSON.parse(entries.get(legacyKey) || 'null');
  if (!incoming?.items?.length) return;
  const current = JSON.parse(localStorage.getItem(key) || 'null') || {active:incoming.active,items:[]};
  for (const item of incoming.items) {
    const saved = JSON.parse(entries.get(legacyKey + ':' + item.id) || 'null') || item;
    const existing = current.items.find(value => value.id === item.id);
    if (existing) {
      const prior = JSON.parse(localStorage.getItem(key + ':' + item.id) || 'null') || existing;
      if (JSON.stringify(prior.messages || []) === JSON.stringify(saved.messages || []) && prior.context === saved.context) continue;
    }
    const id = existing ? crypto.randomUUID() : item.id;
    const restored = {...saved, id, title:existing ? `${saved.title}（恢复副本）` : saved.title,
      messages:(saved.messages || []).map(message=>({...message,session_id:id}))};
    localStorage.setItem(key + ':' + id, JSON.stringify(restored));
    current.items.push({id,title:restored.title});
  }
  localStorage.setItem(key, JSON.stringify(current));
  localStorage.setItem(marker, '1');
}

module.exports = {readSessionRecovery, importSessionRecovery};
