export const POLICY_DEFAULTS = { codex: { softPercent: 40, hardPercent: 55 }, claude: { softPercent: 50, hardPercent: 80 } };
export function validatePolicy(policy) {
  const { softPercent: soft, hardPercent: hard } = policy;
  if (typeof soft !== 'number' || typeof hard !== 'number' || !Number.isFinite(soft) || !Number.isFinite(hard)
    || !(0 < soft && soft < hard && hard < 100)) throw new Error('阈值必须满足 0 < 空闲阈值 < 强停阈值 < 100。');
  if (typeof policy.enabled !== 'boolean') throw new Error('自动管理开关必须是布尔值。');
  return policy;
}
export function evaluatePolicy({ policy, runtime, usage, cycle, lastCycle } = {}) {
  const decision = (action, reason, extra = {}) => ({ action, reason, ...extra });
  if (!policy?.enabled) return decision('disabled', '此会话未启用自动管理。');
  if (cycle) return decision('maintenance', '正在进行上下文维护。');
  if (!runtime?.connected || !['idle', 'running', 'waiting_permission', 'waiting_input'].includes(runtime.activity)) return decision('wait', '等待可用的原生活动状态。');
  if (!usage || !Number.isFinite(usage.usedTokens) || !(usage.contextWindowTokens > 0)) return decision('wait', '上下文用量或模型容量未知。');
  if (usage.historyChangedAfterMeasurement) return decision('wait', '等待本轮新的上下文统计。');
  const percent = usage.usedTokens * 100 / usage.contextWindowTokens;
  const active = runtime.activity !== 'idle';
  if (percent < policy.softPercent) return decision('monitor', '低于空闲阈值。', { percent });
  if (lastCycle && lastCycle.contextEpoch === usage.contextEpoch && lastCycle.state === 'completed'
    && lastCycle.triggerRuntime?.instanceId === runtime.instanceId) return decision('attention', '本轮上下文已维护，等待新的压缩周期或业务进展。', { percent });
  if (lastCycle?.restoreOverThreshold && lastCycle.policy?.revision === policy.revision) return decision('attention', '恢复后仍超阈值，需要缩短交付文档或调整策略。', { percent });
  if (percent >= policy.hardPercent) return decision('trigger', '达到强停阈值。', { trigger: 'hard', wasWorkingAtTrigger: active, percent });
  if (active) return decision('monitor', '达到空闲阈值，当前任务继续；空闲后重新判断。', { percent });
  return decision('trigger', '空闲且达到空闲阈值。', { trigger: 'soft', wasWorkingAtTrigger: false, percent });
}
