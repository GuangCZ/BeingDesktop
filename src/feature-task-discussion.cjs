'use strict';

const {prepareLoomDraft} = require('./town.cjs');

const STATUS = {running:'进行中',waiting:'等待结果核对',succeeded:'已完成',failed:'未完成',cancelled:'已结束本地跟踪，远端执行未取消',needs_input:'需要你决定'};

async function discussFeatureTask(id, {getLedger, getContext, prepareDraft = prepareLoomDraft}) {
  if (typeof id !== 'string' || id.length > 128) throw new Error('请选择有效的功能任务。');
  const ledger = getLedger();
  const task = ledger.get(id);
  if (!task) throw new Error('任务不存在或连接身份已变化，请重新选择。');
  const context = getContext();
  const current = () => {
    if (getLedger() !== ledger) throw new Error('连接身份已变化，任务内容未转交。');
    const next = getContext();
    if (next.connection !== context.connection || next.generation !== context.generation) throw new Error('连接已变化，请重新选择任务。');
    return next;
  };
  // The ledger contains a bounded, sanitized summary, never raw tool payloads.
  const prompt = [
    '我选择将这个功能任务带到聊天里讨论。请先根据下面的记录说明结果或下一步，涉及执行、安装或发送消息时，先和我确认具体操作。',
    `任务：${task.title}`,
    `状态：${STATUS[task.status] || '待核对'}`,
    task.summary ? `结果摘要：${task.summary}` : '',
    task.detail ? `当前情况：${task.detail}` : '',
    task.mayDelayChat ? '这个任务使用 Being 执行，目前尚未确认与聊天执行队列隔离。' : '',
  ].filter(Boolean).join('\n');
  await prepareDraft(prompt, current);
  current();
  return {prepared:true,taskId:id};
}

module.exports = {discussFeatureTask};
