'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {PORTAL_NAME} = require('./services.cjs');

async function runPortalSelfTest({portal, connectionCurrent, probeRuntime, isCurrent = () => true}) {
  const snapshot = portal.state;
  const checks = [];
  const add = (label, status, detail) => checks.push({label, status, detail});
  const external = snapshot.status === 'external' && !snapshot.owned;
  if (external) add('程序与配置', 'unknown', '此 Portal 由外部程序管理，桌面端未读取其配置。无需为此重新选择文件。');
  else {
    const files = await Promise.all([snapshot.executable, snapshot.configPath].map(async file => {
      try { return Boolean(file) && (await fs.lstat(file)).isFile(); } catch { return false; }
    }));
    add('程序与配置', files.every(Boolean) ? 'passed' : 'failed', files.every(Boolean) ? '程序与配置文件存在。' : '程序或配置文件缺失，请重新选择文件。');
  }
  let alive = false;
  try {
    const processes = await portal.inspectProcesses();
    alive = Boolean(snapshot.pid) && processes.some(item => item.pid === snapshot.pid && (external
      ? PORTAL_NAME.test(item.name || path.basename(item.executable || ''))
      : item.executable && item.executable.toLowerCase() === snapshot.executable.toLowerCase()));
    add('Portal 进程', alive ? 'passed' : 'failed', alive ? external ? `已核实外部 Portal 进程 PID ${snapshot.pid} 正在运行。` : `已核实进程 PID ${snapshot.pid} 与所选程序匹配。` : external ? '原有 Portal 进程已退出或不再匹配，请在原启动位置检查。' : '未找到匹配的运行进程，请检查运行状态后启动 Portal。');
  } catch {
    add('Portal 进程', 'unknown', '无法读取本机进程信息，请检查系统权限。');
  }
  if (!probeRuntime) add('Being 运行时', 'failed', '尚未配置 Being，请先连接。');
  else {
    try {
      const result = await probeRuntime();
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid response');
      add('Being 运行时', 'passed', '当前 Being 的状态接口可访问。');
    } catch {
      add('Being 运行时', 'failed', '状态接口访问失败或响应无效，请检查网络、Loom 地址与连接凭据。');
    }
  }
  const current = portal.state;
  if (!isCurrent() || current.pid !== snapshot.pid || current.executable !== snapshot.executable || current.configPath !== snapshot.configPath || current.owned !== snapshot.owned) {
    return {status: 'unknown', checkedAt: new Date().toISOString(), detail: '检测期间连接或进程发生变化，请重新自测。', checks: []};
  }
  if (external) add('中继握手', 'unknown', '桌面端未接入外部 Portal 的握手日志，无法确认它与当前 Being 的连接。请在原启动位置查看日志。');
  else if (connectionCurrent === false) add('中继握手', 'failed', 'Portal 仍连接之前的 Being，请停止后重新启动。');
  else if (alive && current.owned && connectionCurrent === true && current.health === 'connected') add('中继握手', 'passed', '当前进程日志已报告握手成功；本次未执行工具调用。');
  else if (current.health === 'disconnected') add('中继握手', 'failed', '日志报告中继断开，请等待自动重连后重新自测。');
  else add('中继握手', 'unknown', '尚无当前 Being 的握手成功记录。运行时可访问不代表 Portal 已连通；请检查 Portal 日志。');
  const status = checks.some(item => item.status === 'failed') ? 'failed' : checks.some(item => item.status === 'unknown') ? 'unknown' : 'passed';
  return {status, checkedAt: new Date().toISOString(), detail: {passed:'连接检查通过。', failed:'自测发现问题，请按下方结果处理。', unknown:'自测完成，连接仍有未确认项。'}[status], checks};
}

module.exports = {runPortalSelfTest};
