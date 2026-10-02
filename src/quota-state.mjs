// Account quota is separate from context-window usage. Never infer exhaustion
// from assistant prose, a generic HTTP 429, or the passage of a reset timestamp.
const percent = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
const iso = value => {
  const ms = typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 && ms < 8640000000000000 ? new Date(ms).toISOString() : null;
};
export function codexQuotaFailure(turn) {
  if (!turn || !['failed', 'interrupted', 'completed'].includes(turn.status)) return null;
  const errors = [turn.error, ...(turn.items || []).filter(i => ['error', 'system-error'].includes(i.type)).map(i => i.errorInfo || i.error)];
  const match = errors.some(e => e === 'usageLimitExceeded' || e?.codexErrorInfo === 'usageLimitExceeded'
    || e?.type === 'usageLimitExceeded' || e?.codexErrorInfo?.type === 'usageLimitExceeded');
  return match ? { kind: 'usage_limit', source: 'codex-native-error', turnId: turn.turnId || turn.id, autoResume: true } : null;
}
export function claudeQuotaEvent(info) {
  if (!info || !['allowed', 'allowed_warning', 'rejected'].includes(info.status)) return null;
  return { status: info.status, kind: typeof info.rateLimitType === 'string' ? info.rateLimitType : 'unknown',
    resetsAt: iso(info.resetsAt), usedPercent: percent(info.utilization) === null ? null : info.utilization * 100 };
}
const window = (id, used, reset) => ({ id, usedPercent: percent(used), resetsAt: iso(reset) });
function result(source, windows, complete, queriedAt = new Date().toISOString()) {
  const blocked = windows.filter(w => w.usedPercent !== null && w.usedPercent >= 100);
  return { source, queriedAt, status: blocked.length ? 'exhausted' : complete && windows.length && windows.every(w => w.usedPercent !== null) ? 'available' : 'unknown',
    windows, nextResetAt: blocked.map(w => w.resetsAt).filter(Boolean).sort().at(-1) || null };
}
export function publicCodexQuota(value) {
  const byId = value?.rateLimitsByLimitId;
  const limits = byId && typeof byId === 'object' && Object.keys(byId).length ? Object.entries(byId) : value?.rateLimits ? [['codex', value.rateLimits]] : [];
  const windows = []; let complete = limits.length > 0;
  for (const [id, limit] of limits) {
    if (!limit?.primary) complete = false;
    for (const key of ['primary', 'secondary']) if (limit?.[key]) windows.push(window(id + ':' + key, limit[key].usedPercent, limit[key].resetsAt));
  }
  return result('codex-account-rate-limits', windows, complete && value?.ordinaryUsageAllowed !== false);
}
export function publicClaudeQuota(value, model) {
  const limits = value?.rate_limits, windows = [];
  let complete = value?.rate_limits_available === true && Boolean(limits?.five_hour && limits?.seven_day);
  if (limits) for (const key of ['five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_opus', 'seven_day_sonnet']) {
    if (key === 'seven_day_opus' && model && !/opus/i.test(model) || key === 'seven_day_sonnet' && model && !/sonnet/i.test(model)) continue;
    if (limits[key]) windows.push(window(key, limits[key].utilization, limits[key].resets_at));
  }
  // Keep all explicit model-scoped constraints: their display names are not a
  // reliable machine mapping. Missing entries are not fabricated as zero.
  for (const entry of limits?.model_scoped || []) windows.push(window('model:' + entry.display_name, entry.utilization, entry.resets_at));
  return result('claude-native-get-usage', windows, complete);
}
export function quotaHead(runtime) { return runtime.latestTurn?.id || runtime.lastCompletedTurnId || null; }
export function quotaIdentity(runtime) {
  return JSON.stringify([runtime.instanceId, quotaHead(runtime), runtime.activityRevision, runtime.model ?? null, runtime.effort ?? null,
    runtime.permissionMode ?? null, runtime.permissionFingerprint ?? null]);
}
export function freshAvailableQuota(quota, now = Date.now()) {
  const age = now - Date.parse(quota?.queriedAt);
  return quota?.status === 'available' && age >= 0 && age <= 60000;
}
