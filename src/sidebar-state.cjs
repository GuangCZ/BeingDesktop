'use strict';
const path = require('node:path');
const UUID = /^[0-9a-f-]{36}$/i;
const validPath = value => typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f]/.test(value) && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));

function sidebarState(saved, scope, workspace = '') {
  const projects = [...new Set((Array.isArray(saved?.projects) ? saved.projects : [workspace]).filter(validPath))].slice(0, 100);
  const source = scope && saved?.owners?.[scope];
  const tasks = {};
  for (const [id, value] of Object.entries(source?.tasks || {}).slice(0, 10000)) {
    if (!UUID.test(id) || !value || typeof value !== 'object') continue;
    tasks[id] = {pinned: value.pinned === true, archived: value.archived === true,
      project: projects.includes(value.project) ? value.project : '',
      touchedAt: Number.isFinite(value.touchedAt) ? value.touchedAt : 0};
  }
  return {scope: scope || '', projects, tasks};
}

function updateSidebar(saved, scope, workspace, action, sessionIds = [], now = Date.now()) {
  if (action?.scope !== scope || (!scope && action.type !== 'remove-project')) throw new Error('连接已变化，请重试。');
  const next = sidebarState(saved, scope, workspace);
  if (action.type === 'remove-project') {
    if (!next.projects.includes(action.project)) throw new Error('项目不存在。');
    next.projects = next.projects.filter(item => item !== action.project);
    for (const task of Object.values(next.tasks)) if (task.project === action.project) task.project = '';
  } else {
    if (!UUID.test(action?.id) || !sessionIds.includes(action.id)) throw new Error('会话不存在。');
    const task = next.tasks[action.id] || {pinned: false, archived: false, project: '', touchedAt: 0};
    if (action.type === 'pin') { task.pinned = !task.pinned; if (task.pinned) task.archived = false; }
    else if (action.type === 'archive') { task.archived = !task.archived; if (task.archived) task.pinned = false; }
    else if (action.type === 'move') {
      if (action.project !== '' && !next.projects.includes(action.project)) throw new Error('项目不存在。');
      task.project = action.project;
    } else if (action.type === 'touch') task.touchedAt = now;
    else throw new Error('侧栏操作无效。');
    next.tasks[action.id] = task;
  }
  return {...saved, projects: next.projects, owners: scope ? {...saved?.owners, [scope]: {tasks: next.tasks}} : {...saved?.owners}};
}
module.exports = {sidebarState, updateSidebar, validPath};
