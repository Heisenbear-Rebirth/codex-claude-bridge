const stages = ['保存进度', '整理上下文', '恢复任务'];
export function maintenanceView(cycle, runtime = {}) {
  const stage = ['needs_attention', 'user_intervened', 'waiting_client'].includes(cycle.state) ? cycle.previousState : cycle.state;
  const index = ['compacting'].includes(stage) ? 1 : ['restoring', 'awaiting_restore_end'].includes(stage) ? 2 : 0;
  const paused = ['needs_attention', 'user_intervened'].includes(cycle.state);
  const view = { stages, index, paused, title: ['正在保存进度', '正在整理上下文', '正在恢复任务'][index],
    description: ['模型正在整理接下来继续工作所需的信息。完成后会自动进入下一步。', '已保存任务进度，正在释放上下文空间。', '模型正在读取已保存的进度，完成后按原任务继续。'][index], primary: null };
  if (cycle.state === 'interrupting') return { ...view, title: '正在暂停当前工作', description: '原任务暂停后，会先保存进度，再整理上下文。' };
  if (cycle.state === 'awaiting_handoff_end') return { ...view, title: '进度已保存', description: '等待当前回复结束，随后自动整理上下文。' };
  if (cycle.state === 'awaiting_restore_end') return { ...view, title: '任务进度已恢复', description: cycle.wasWorkingAtTrigger ? '当前回复结束后，会自动继续原任务。' : '当前回复结束后，维护即完成。' };
  if (cycle.state === 'waiting_client') return { ...view, title: '等待会话重新连接', description: '请打开原来的会话。任务进度和待处理消息已保留，连接后会自动检查。' };
  if (runtime.activity === 'waiting_permission' || runtime.activity === 'waiting_input') return { ...view, title: '等待你的确认', description: '请在原会话中处理权限请求或问题，之后会自动接续。' };
  if (!paused) return view;
  const reason = cycle.reason || '';
  let description = '维护已暂停，已保存的进度和待处理消息会保留。检查会话后可从当前步骤继续。';
  if (/模型|思考强度|权限选项/.test(reason)) description = '会话设置发生了变化。请先确认原会话的设置，再继续这次维护。';
  else if (/新输入|新业务|用户/.test(reason)) description = '检测到新的会话操作。请确认是否仍需继续这次维护。';
  else if (/额度/.test(reason)) description = '额度暂时不足。恢复后，可从当前步骤继续维护。';
  else if (cycle.lastReceiptIssue || /回执|超时/.test(reason)) description = '尚未确认这一步是否完成。已有文档可以保留，检查后继续，无需从头开始。';
  const canRetry = /^目标轮次已结束，但系统未收到阶段回执/.test(reason) && ['writing_handoff', 'restoring'].includes(stage);
  return { ...view, title: '维护需要确认', description, primary: { action: canRetry ? 'retry' : 'reconcile',
    label: canRetry ? index === 0 ? '继续保存进度' : '继续恢复任务' : '检查并继续' } };
}
export function maintenanceDiagnostic(session, cycle, runtime = {}) {
  // Deliberately select public support fields; never serialize the whole session.
  return { client: session.client, sessionId: session.id, cycleId: cycle.id, state: cycle.state, previousState: cycle.previousState,
    reason: cycle.reason || null, lastReceiptIssue: cycle.lastReceiptIssue || null, createdAt: cycle.createdAt, updatedAt: cycle.updatedAt,
    activity: runtime.activity, connected: runtime.connected, model: runtime.model, requiresReopen: runtime.requiresReopen === true };
}

export function quotaView(session) {
  const runtime = session.monitoring?.runtime || {}, quota = runtime.quota;
  const saved = session.monitoring?.quotaRecovery;
  const record = !quota || saved?.eventId === quota.turnId ? saved : null;
  if (!quota && !runtime.quotaRestart?.pending && !['waiting', 'sending', 'attention'].includes(record?.state)) return null;
  const enabled = session.policy?.enabled === true && session.policy.mode === 'automatic';
  let title = '等待额度恢复', description;
  if (runtime.quotaRestart?.pending) { title = '正在核对退出前的状态'; description = runtime.quotaRestart.reason; }
  else if (session.client === 'opencode' && quota) { title = 'OpenCode 限流需要处理'; description = '已暂停上下文压缩及排队投递。当前没有可核验的统一额度查询，请在原会话处理额度或限流并继续；恢复正常后再释放队列。'; }
  else if (runtime.connected === false && record) { title = '等待原会话重新连接'; description = '退出前的额度记录已保留。打开原会话后自动核对，并重新检测可用额度。'; }
  else if (!enabled) description = '因额度不足中断，已暂停上下文压缩。启用自动管理后可自动检测额度并在状态允许时继续。';
  else if (runtime.requiresReopen) { title = '接入需要更新'; description = runtime.detail; }
  else if (session.cycle) { title = '维护等待额度恢复'; description = '自动管理已开启。此次上下文维护因额度不足暂停，恢复后请核对当前维护步骤并继续。'; }
  else if (record?.reason) {
    description = record.reason;
    if (record.state === 'attention') title = '自动继续需要确认';
    if (record.state === 'cancelled') title = '自动继续已暂停';
    if (record.state === 'sending') title = '正在继续任务';
    if (record.state === 'waiting' && record.blockedReason) title = '正在检测额度，等待会话就绪';
  } else if (quota?.autoResume === false) description = '自动管理已开启。此次中断尚不满足自动继续条件，请核对原会话；上下文压缩已暂停。';
  else description = runtime.activity === 'quota_limited'
    ? '自动管理已开启，正在检测额度，确认恢复后自动继续。'
    : '自动管理已开启，正在核对原生状态并检测额度；确认可继续前暂停上下文压缩。';
  return { title, description, resetAt: record?.quota?.nextResetAt || quota?.resetsAt,
    nextCheckAt: enabled && !runtime.requiresReopen && record?.state === 'waiting' ? record.nextCheckAt : null };
}
