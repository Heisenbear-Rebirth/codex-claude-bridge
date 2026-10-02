import { randomUUID } from 'node:crypto';
import { sessionKey } from './management-store.mjs';
import { readCodexUsageLimits } from './adapters/codex.mjs';
import { publicCodexQuota, quotaHead, quotaIdentity, freshAvailableQuota } from './quota-state.mjs';
import { readPromptSettings } from './prompt-settings.mjs';
import { renderPromptTemplate } from '../public/prompt-templates.mjs';
import { normalizeDirectory } from './directory-service.mjs';

export const quotaSettingKey = session => 'quota-recovery:' + sessionKey(session);
const enabled = policy => policy?.enabled && policy.mode === 'automatic';
const unsafe = r => r.capabilities?.automaticMaintenance === false || r.goalStatus === 'active' || r.subagentHistoryPresent
  || r.backgroundTasks > 0 || r.queuedNativeInputs > 0 || r.pendingRequests > 0 || r.pendingClientControls > 0
  || r.pendingHostControls > 0 || r.unconfirmedSubmissions > 0 || r.turnOrderUncertain;
const eventIdentity = r => JSON.stringify([r.instanceId, r.quota?.turnId, r.model ?? null, r.effort ?? null,
  r.permissionMode ?? null, r.permissionFingerprint ?? null]);
const sameFailure = (record, r) => {
  try { return JSON.stringify(JSON.parse(record.eventIdentity).slice(1)) === JSON.stringify(JSON.parse(eventIdentity(r)).slice(1)); }
  catch { return false; }
};
const awaitingSelection = (record, r) => {
  try { const before = JSON.parse(record.eventIdentity), after = JSON.parse(eventIdentity(r));
    return before.slice(2).some((value, i) => value != null && after[i + 2] == null); }
  catch { return false; }
};
function resumeBlock(r) {
  if (r.requiresReopen) return '请在任务结束后重开此 Claude 面板，加载额度与排队状态修复。';
  if (r.turnOrderUncertain) return '等待原生轮次记录同步，确认当前轮次后再自动继续。';
  if (r.queuedNativeInputs > 0 || r.unconfirmedSubmissions > 0) return '等待原生客户端确认待处理输入，暂不发送继续消息。';
  if (r.pendingRequests > 0 || r.pendingClientControls > 0 || r.pendingHostControls > 0
    || ['waiting_permission', 'waiting_input'].includes(r.activity)) return '请先处理原会话中的待确认操作，再自动继续。';
  if (unsafe(r)) return '原生目标、后台工作或客户端能力尚待核对，暂不发送继续消息。';
  if (r.activity !== 'quota_limited') return '等待原生轮次结束并确认中断状态，再自动继续。';
  return null;
}
export class QuotaRecovery {
  constructor({ root, store, service, monitor, onUpdate = () => {}, pollMs = 60000, readCodex = readCodexUsageLimits }) {
    Object.assign(this, { root, store, service, monitor, onUpdate, pollMs, readCodex }); this.closed = false;
    this.observerId = randomUUID();
  }
  save(session, record, sample) {
    this.store.assertManager(); this.store.setSetting(quotaSettingKey(session), record);
    const previous = sample || this.store.getSnapshot(session);
    if (previous) this.store.saveSnapshot(session, { ...previous, quotaRecovery: record });
    this.onUpdate(session); return record;
  }
  async read(session, adapter) {
    if (session.client === 'claude') return adapter.quota();
    if (!this.codexReading && Date.now() >= (this.codexNextRead || 0)) {
      this.codexNextRead = Date.now() + this.pollMs;
      this.codexReading = (async () => publicCodexQuota(await this.readCodex(
        this.service.codexBridge ? await this.service.codexBridge.getContext() : this.service.codexContext)))()
        .catch(() => ({ status: 'unknown', queriedAt: new Date().toISOString(), windows: [] }))
        .then(value => { this.codexValue = value; return value; }).finally(() => { this.codexReading = null; });
    }
    return this.codexReading || this.codexValue;
  }
  async handle(session, policy, sample) {
    if (!['codex', 'claude'].includes(session.client)) return false;
    const runtime = sample.runtime, key = quotaSettingKey(session);
    this.store.restartConfirmation?.observe(sample.session || session, runtime);
    let record = this.store.getSetting(key);
    const cancel = reason => { if (record && ['waiting', 'sending', 'attention'].includes(record.state)) record = this.save(session, { ...record, state: 'cancelled', reason }, sample); };
    if (!enabled(policy)) { cancel('自动管理已关闭，停止自动继续。'); return Boolean(runtime.quota); }
    if (!runtime.connected) return Boolean(record && ['waiting', 'sending', 'attention'].includes(record.state));
    if (['initializing', 'unloaded'].includes(runtime.activity)) return Boolean(record && ['waiting', 'sending', 'attention'].includes(record.state));
    if (runtime.quotaRestart?.pending) {
      if (record?.state === 'waiting') this.save(session, { ...record, blockedReason: runtime.quotaRestart.reason }, sample);
      return true;
    }
    if (record?.state === 'sending' && (!runtime.quota || record.eventId === runtime.quota.turnId)) {
      record = this.save(session, { ...record, state: 'attention', reason: '上次继续消息的发送结果不确定，请核对原会话；不会重复发送。' }, sample);
    }
    if (!runtime.quota) {
      const head = quotaHead(runtime) || runtime.lastObservedInputId;
      if (record && (runtime.userStopped || head && (head !== record.turnId || runtime.activity === 'idle'))) cancel('原会话已有新的轮次或限额记录已解除，旧继续请求已取消。');
      if (record?.state === 'waiting' && runtime.activity === 'idle' && !head) record = this.save(session, { ...record, state: 'attention',
        reason: '原客户端已重开，但退出前的限额轮次尚无可核对记录。请在原会话确认下一步；已保留排队消息。' }, sample);
      return Boolean(record && ['waiting', 'sending', 'attention'].includes(record.state));
    }
    const blockedReason = resumeBlock(runtime);
    const eventId = runtime.quota.turnId;
    if (!record || record.eventId !== eventId) {
      const failures = record?.state === 'submitted' && record.result?.activeTurnId === runtime.quota.turnId ? (record.recoveryFailures || 0) + 1 : 0;
      record = this.save(session, {
      eventId, turnId: runtime.quota.turnId, identity: quotaIdentity(runtime), eventIdentity: eventIdentity(runtime),
      failure: runtime.quota,
      observerId: this.observerId,
      resumeBound: !blockedReason, blockedReason, state: 'waiting', createdAt: new Date().toISOString(),
      recoveryFailures: failures, nextCheckAt: failures ? new Date(Date.now() + Math.min(900000, this.pollMs * 2 ** Math.min(failures, 4))).toISOString() : null,
      reason: failures ? '继续后再次受限，已延后检测，避免连续重试。' : '因额度不足中断；每分钟检测额度，恢复后自动继续。', requestId: randomUUID(),
      }, sample);
    }
    // An uncertain delivery stays held across instance changes. Neither a new
    // process nor a quota query proves that the previous send did not happen.
    if (record.state === 'attention') return true;
    if (record.state === 'waiting' && record.identity !== quotaIdentity(runtime) && awaitingSelection(record, runtime)) {
      this.save(session, { ...record, blockedReason: '等待客户端同步原模型、思考强度和权限选项，再核对额度恢复。' }, sample); return true;
    }
    if (record.state === 'waiting' && record.identity !== quotaIdentity(runtime) && sameFailure(record, runtime)
      && (record.observerId !== this.observerId || JSON.parse(record.identity)[0] !== runtime.instanceId)) {
      const target = session.cwd ? session : await this.service.adapters?.[session.client]?.find(session.id);
      if (runtime.sessionId !== session.id || !target?.cwd || !runtime.cwd
        || normalizeDirectory(target.cwd) !== normalizeDirectory(runtime.cwd)) {
        cancel('重连后的会话或工作目录无法与原限额记录对应，未自动继续。'); return true;
      }
      if (blockedReason || quotaHead(runtime) !== record.turnId || !runtime.quota.autoResume) {
        this.save(session, { ...record, blockedReason: blockedReason || '等待原限额轮次与原生记录同步。' }, sample); return true;
      }
      // The current native failure is the evidence; elapsed reset times and
      // stale manager snapshots alone never authorize rebinding.
      record = this.save(session, { ...record, identity: quotaIdentity(runtime), eventIdentity: eventIdentity(runtime),
        observerId: this.observerId, resumeBound: true, blockedReason: null, nextCheckAt: null,
        reconnectedAt: new Date().toISOString() }, sample);
    }
    if ((record.eventIdentity && record.eventIdentity !== eventIdentity(runtime))
      || record.resumeBound !== false && record.identity !== quotaIdentity(runtime) || !runtime.quota.autoResume) {
      cancel(runtime.quota.kind === 'unknown_rate_limit' ? '已检测到限流中断，但尚未确认订阅额度窗口；暂停压缩，等待人工核对。'
        : '原生轮次、设置或人工停止状态已变化，旧继续请求已取消。'); return true;
    }
    if (record.state !== 'waiting' || this.closed) return true;
    if (typeof this.monitor.runtime(session).resumeQuota !== 'function') {
      this.save(session, { ...record, state: 'attention', reason: '原生目标、后台工作或客户端能力尚待核对，未自动继续。' }, sample); return true;
    }
    if (record.resumeBound === false && !blockedReason)
      record = this.save(session, { ...record, resumeBound: true, identity: quotaIdentity(runtime), blockedReason: null }, sample);
    else if (record.blockedReason !== blockedReason)
      record = this.save(session, { ...record, blockedReason }, sample);
    if (Date.now() < Date.parse(record.nextCheckAt)) return true;
    record = this.save(session, { ...record, nextCheckAt: new Date(Date.now() + this.pollMs).toISOString() }, sample);
    const adapter = this.monitor.runtime(session);
    let quota;
    try { quota = await this.read(session, adapter); } catch { quota = { status: 'unknown', windows: [], queriedAt: new Date().toISOString() }; }
    const ready = freshAvailableQuota(quota) && Date.parse(quota.queriedAt) >= Date.parse(record.createdAt);
    const quotaReason = ready ? '额度已恢复。' : quota?.status === 'exhausted' ? '额度尚未恢复，继续等待。' : '暂未确认可用额度，保留等待状态。';
    record = this.save(session, { ...record, quota, reason: blockedReason ? quotaReason + blockedReason
      : ready ? '额度已恢复，正在核对原会话。' : quotaReason }, sample);
    if (!ready || blockedReason || this.closed) return true;
    if (this.store.restartConfirmation?.blocks(session)) {
      this.save(session, { ...record, reason: '额度已恢复，等待在管理页面确认项目重启后的接续。' }, sample); return true;
    }
    const prompts = await readPromptSettings(this.root);
    const current = await adapter.status();
    if (quotaIdentity(current) !== record.identity || current.activity !== 'quota_limited' || !current.quota?.autoResume || unsafe(current)) {
      cancel('检测期间原会话状态发生变化，未发送旧继续消息。'); return true;
    }
    if (this.closed || !enabled(this.store.getPolicy(session))) { cancel('自动管理已关闭，停止自动继续。'); return true; }
    if (this.store.activeCycle(session)) return true;
    if (this.store.restartConfirmation?.blocks(session)) return true;
    const text = renderPromptTemplate(prompts.values.maintenance.quotaContinue, { sessionId: session.id, client: session.client });
    // Durable intent precedes external delivery. A crash or unknown response
    // never authorizes a second send of this failed turn's continuation.
    record = this.save(session, { ...record, state: 'sending', promptRevision: prompts.revision,
      intentAt: new Date().toISOString(), reason: '正在发送额度恢复后的继续消息。' }, sample);
    let response;
    try { response = await adapter.resumeQuota(text, current, { requestId: record.requestId, quota,
      canDispatch: () => !this.closed && enabled(this.store.getPolicy(session)) && !this.store.activeCycle(session)
        && !this.store.restartConfirmation?.blocks(session) }); }
    catch { response = { status: 'unknown' }; }
    const submitted = response.status === 'submitted', conflict = ['state_conflict', 'busy'].includes(response.status);
    this.save(session, { ...record, state: submitted ? 'submitted' : conflict ? 'cancelled' : 'attention',
      result: { status: response.status, activeTurnId: response.activeTurnId || null },
      reason: submitted ? '额度已恢复，已向原会话提交一次继续消息。' : conflict ? '发送前原会话发生变化，未发送继续消息。'
        : '继续消息结果未确认，请核对原会话；不会重复发送。' }, sample);
    return true;
  }
  close() { this.closed = true; }
}
