import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { join, relative, isAbsolute } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { samePermissionSelection } from './runtime/codex-runtime.mjs';
import { publicSession } from './address.mjs';
import { receiptHash } from './checkpoint-service.mjs';
import { sessionKey } from './management-store.mjs';
import { handoffPrompt, restorePrompt, continuePrompt } from './maintenance-prompts.mjs';
import { maintenanceStage, restartCandidate, restartPlan, readRestartEvidence, controlTurnEnded } from './maintenance-recovery.mjs';
import { normalizeDirectory } from './directory-service.mjs';

const terminal = new Set(['completed', 'cancelled', 'needs_attention', 'user_intervened']);
const active = s => ['running', 'waiting_permission', 'waiting_input'].includes(s.activity);
const deadline = ms => new Date(Date.now() + ms).toISOString();
const stageTimeout = { interrupting: 30000, writing_handoff: 10 * 60_000, awaiting_handoff_end: 60000, compacting: 5 * 60_000, restoring: 5 * 60_000, awaiting_restore_end: 60000 };

function completedClaudeCompaction(cycle, runtime) {
  const requestId = cycle.compactResult?.requestId;
  if (!requestId || runtime.lastCompletedTurnId !== requestId) return null;
  return [runtime.lastCompaction, cycle.compactResult].find(result => result?.status === 'completed'
    && result.requestId === requestId && (!result.sessionId || result.sessionId === cycle.session.id)
    && Date.parse(result.completedAt) >= Date.parse(cycle.compactIntentAt)) || null;
}

export class MaintenanceController {
  constructor({ root, store, service, monitor, onUpdate = () => {}, intervalMs = 2000, recoveryEvidence = readRestartEvidence }) {
    this.root = root; this.store = store; this.service = service; this.monitor = monitor; this.onUpdate = onUpdate;
    this.recoveryEvidence = recoveryEvidence; this.recoveryPollAt = new Map();
    this.intervalMs = intervalMs; this.running = new Map(); this.closed = false;
  }
  start() {
    if (!this.timer) {
      this.timer = setInterval(() => { if (!this.closed && !this.ticking) this.tickPromise = this.tick().catch(error => this.store.event('manager_error', { error: error.message })); }, this.intervalMs); this.timer.unref();
      this.recoveryPromise = Promise.allSettled(this.store.activeCycles().filter(c => c.state === 'needs_attention' && c.reason?.startsWith('服务重启'))
        .map(c => this.reconcile(c.id).catch(() => {})));
    }
  }
  async tick() {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      // Active cycles keep their lock even when a user disables the monitor.
      const cycles = this.store.activeCycles();
      for (const cycle of cycles.filter(c => !terminal.has(c.state) || restartCandidate(c))) void this.advance(cycle.id);
      const observed = this.monitor.observeAll ? await this.monitor.observeAll() : null;
      await Promise.allSettled(this.store.policies().filter(p => p.enabled).map(async policy => {
        if (this.closed) return;
        const session = policy.session;
        if (this.store.activeCycle(session)) return;
        const sample = observed?.get(sessionKey(session)) || await this.monitor.sample(session);
        const latestPolicy = this.store.getPolicy(session);
        if (!latestPolicy?.enabled || latestPolicy.mode !== 'automatic' || latestPolicy.revision !== policy.revision) return;
        if (policy.mode === 'automatic' && sample.decision.action === 'trigger') {
          try { await this.trigger(session, policy, sample); }
          catch (e) { this.store.saveSnapshot(session, { ...sample, decision: { action: 'attention', reason: e.message } }); this.onUpdate(session); }
        }
      }));
      void this.service.mailbox?.flush().catch(error => this.store.event('mailbox_error', { error: error.message }));
    } finally { this.ticking = false; }
  }
  async trigger(session, policy, sample) {
    const runtime = sample.runtime;
    if (runtime.capabilities?.automaticMaintenance === false) throw new Error('此客户端的原生控制尚待本机验收，目前仅开放观察模式。');
    const required = ['readActivity', 'sendControl', 'compact', 'observeCompletion', ...(sample.decision.wasWorkingAtTrigger ? ['interrupt'] : [])];
    if (!required.every(c => runtime.capabilities?.[c])) throw new Error('目标客户端的维护能力尚未就绪。');
    if (runtime.goalStatus === 'active' || runtime.backgroundTasks > 0 || runtime.queuedNativeInputs > 0 || runtime.subagentHistoryPresent) throw new Error('会话仍有原生目标、子agent、后台工作或已排队输入，暂不能自动维护。');
    const metadata = await this.service.adapters[session.client].find(session.id);
    if (!metadata?.cwd) throw new Error('无法确认目标会话的工作目录。');
    const target = publicSession(metadata);
    const id = randomUUID(), stageTokens = { handoff: randomBytes(24).toString('base64url'), restored: randomBytes(24).toString('base64url') };
    const state = sample.decision.wasWorkingAtTrigger ? 'interrupting' : 'writing_handoff';
    const cycle = this.store.transaction(() => {
      const created = this.store.createCycle({ id, session: target, state, trigger: sample.decision.trigger,
        policy, wasWorkingAtTrigger: sample.decision.wasWorkingAtTrigger, triggerRuntime: runtime, triggerUsage: sample.usage,
        originalTurnId: runtime.activeTurnId, contextEpoch: sample.usage.contextEpoch,
        handoffPath: join(target.cwd, '.cooperation', 'handoffs', target.client, target.id, id + '.md'),
        receiptHashes: { handoff: receiptHash(stageTokens.handoff), restored: receiptHash(stageTokens.restored) },
        deadlineAt: deadline(stageTimeout[state]), controlDispatched: false });
      // Tokens are private to this local service, never returned by a management API.
      this.store.setSetting('cycle-tokens:' + id, stageTokens); return created;
    });
    this.onUpdate(target); await this.advance(cycle.id); return this.store.cycle(cycle.id);
  }
  advance(id) {
    if (this.running.has(id)) return this.running.get(id);
    const task = this.step(id).catch(error => {
      const cycle = this.store.cycle(id);
      if (cycle && !terminal.has(cycle.state)) this.attention(cycle, error.message, error.outcome || 'unknown');
    }).finally(() => this.running.delete(id));
    this.running.set(id, task); return task;
  }
  attention(cycle, reason, outcome = 'unknown') {
    this.store.updateCycle(cycle.id, 'needs_attention', { previousState: maintenanceStage(cycle), reason, lastAttemptOutcome: outcome }); this.onUpdate(cycle.session);
  }
  transition(cycle, state, patch = {}) {
    const updated = this.store.updateCycle(cycle.id, state, { deadlineAt: deadline(stageTimeout[state] || 60000), ...patch });
    this.onUpdate(cycle.session); return updated;
  }
  waitForClient(cycle, reason = '客户端暂不可用，等待重新连接后自动核对接续。') {
    if (cycle.state === 'waiting_client') return;
    this.store.updateCycle(cycle.id, 'waiting_client', { previousState: maintenanceStage(cycle), reason,
      disconnectedAt: new Date().toISOString(), remainingStageMs: Math.max(1000, Date.parse(cycle.deadlineAt) - Date.now()) || 1000 });
    this.onUpdate(cycle.session);
  }
  async recoverClient(cycle, sample) {
    const runtime = sample.runtime;
    if (runtime.activity !== 'idle') { this.waitForClient(cycle, '客户端已重连，等待当前轮次结束后核对接续。'); return; }
    const blocked = reason => {
      const current = this.store.cycle(cycle.id);
      if (current?.revision !== cycle.revision) return;
      this.store.updateCycle(cycle.id, 'needs_attention', { previousState: maintenanceStage(cycle), reason, recoveryBlocked: true });
      this.onUpdate(cycle.session);
    };
    if (runtime.sessionId?.toLowerCase() !== cycle.session.id.toLowerCase()
      || !runtime.cwd || normalizeDirectory(runtime.cwd) !== normalizeDirectory(cycle.session.cwd))
      return blocked('重连会话的 ID 或工作目录与原流程不一致。');
    if (runtime.queuedNativeInputs > 0 || runtime.backgroundTasks > 0 || runtime.subagentHistoryPresent
      || runtime.goalStatus === 'active' || runtime.pendingRequests > 0 || runtime.pendingClientControls > 0
      || runtime.pendingHostControls > 0 || runtime.unconfirmedSubmissions > 0 || runtime.capabilities?.automaticMaintenance === false)
      return blocked('重连后仍有原生队列、目标、权限请求或后台工作，需人工核对。');
    for (const field of ['model', 'effort', 'permissionMode']) {
      const current = field === 'model' ? runtime.model || sample.usage?.model : runtime[field];
      if (cycle.triggerRuntime[field] != null && current != null && current !== cycle.triggerRuntime[field])
        return blocked('重连后的模型、思考强度或权限选项已改变，需人工核对。');
    }
    if (!samePermissionSelection(cycle.triggerRuntime, runtime)) return blocked('重连后的原生权限选项已改变，需人工核对。');
    const evidence = await this.recoveryEvidence(cycle, sample, { root: this.root });
    if (evidence.cwd && normalizeDirectory(evidence.cwd) !== normalizeDirectory(cycle.session.cwd)) return blocked('原生历史工作目录与维护会话不一致。');
    const plan = restartPlan(cycle, evidence, { handoff: this.store.checkpoint(cycle.id, 'handoff'), restored: this.store.checkpoint(cycle.id, 'restored') });
    if (plan.action === 'wait') { this.waitForClient(cycle, plan.reason); return; }
    if (plan.action === 'attention') return blocked(plan.reason);
    if (cycle.documentHash) {
      try {
        const allowed = await realpath(cycle.session.cwd), filename = await realpath(cycle.handoffPath), rel = relative(allowed, filename);
        if (!rel || rel.startsWith('..') || isAbsolute(rel)
          || createHash('sha256').update(await readFile(filename)).digest('hex') !== cycle.documentHash)
          return blocked('交付文档位置或内容已经变化，未自动接续。');
      } catch { return blocked('交付文档暂不可核对，未自动接续。'); }
    }
    // Recheck after disk reads so a new native turn or checkpoint cannot be overwritten.
    const now = await this.monitor.runtime(cycle.session).status(), current = this.store.cycle(cycle.id);
    if (this.closed || current?.revision !== cycle.revision || now.activity !== 'idle'
      || now.instanceId !== runtime.instanceId || now.activityRevision !== runtime.activityRevision
      || now.latestTurn?.id !== runtime.latestTurn?.id) return;
    const changed = runtime.instanceId !== cycle.triggerRuntime.instanceId;
    this.store.event('client_reconnected', { id: cycle.id, fromInstance: cycle.triggerRuntime.instanceId,
      toInstance: runtime.instanceId, stage: plan.stage, resending: plan.resending === true, source: evidence.source });
    this.transition(current, plan.stage, { ...plan.patch,
      triggerRuntime: { ...cycle.triggerRuntime, instanceId: runtime.instanceId },
      recoveryBoundary: plan.endedControl ? { instanceId: runtime.instanceId, activityRevision: runtime.activityRevision, controlTurnId: cycle.controlTurnId } : null,
      recoveryCount: (cycle.recoveryCount || 0) + Number(changed), recoveryBlocked: false, disconnectedAt: null, reason: null,
      reconnectedAt: new Date().toISOString() });
  }
  async step(id) {
    let cycle = this.store.cycle(id);
    if (this.closed || !cycle || terminal.has(cycle.state) && !restartCandidate(cycle)) return;
    if (cycle.state === 'waiting_client' || restartCandidate(cycle)) {
      if (Date.now() < (this.recoveryPollAt.get(id) || 0)) return;
      this.recoveryPollAt.set(id, Date.now() + 5000);
    }
    const sample = await this.monitor.sample(cycle.session);
    cycle = this.store.cycle(id);
    if (!cycle || terminal.has(cycle.state) && !restartCandidate(cycle)) return;
    const state = sample.runtime;
    if (!state.connected || ['offline','unloaded','initializing'].includes(state.activity)) { this.waitForClient(cycle); return; }
    if (state.activity === 'unknown') {
      if (cycle.state !== 'waiting_client' && Date.now() > Date.parse(cycle.deadlineAt)) this.attention(cycle, '维护阶段超时；会话锁及排队消息已保留。');
      return;
    }
    const adapter = this.monitor.runtime(cycle.session);
    if (cycle.triggerRuntime.instanceId !== state.instanceId) { await this.recoverClient(cycle, sample); return; }
    if (restartCandidate(cycle)) return; // Same live instance is not permission to resend a failed prompt.
    if (cycle.state === 'waiting_client') {
      // A transient disconnect from the same process needs no rebind or replay.
      this.transition(cycle, cycle.previousState, { reason: null, disconnectedAt: null,
        deadlineAt: deadline(cycle.remainingStageMs || stageTimeout[cycle.previousState] || 60000) }); return;
    }
    if (Date.now() > Date.parse(cycle.deadlineAt)) return this.attention(cycle, '维护阶段超时；会话锁及排队消息已保留。');
    if (state.queuedNativeInputs > 0 || state.backgroundTasks > 0 || state.subagentHistoryPresent) return this.attention(cycle, '检测到原生队列、子agent或后台工作，停止自动推进。');
    if (cycle.triggerRuntime.model && state.model && cycle.triggerRuntime.model !== state.model)
      return this.attention(cycle, '维护期间模型发生变化，请核对用户操作。');
    if ((cycle.triggerRuntime.effort && state.effort && cycle.triggerRuntime.effort !== state.effort)
      || !samePermissionSelection(cycle.triggerRuntime, state)
      || (cycle.triggerRuntime.permissionMode && state.permissionMode && cycle.triggerRuntime.permissionMode !== state.permissionMode))
      return this.attention(cycle, '维护期间思考强度或权限发生变化，请核对用户操作。');
    if (['writing_handoff', 'restoring', 'awaiting_handoff_end', 'awaiting_restore_end'].includes(cycle.state)
      && cycle.controlTurnId && active(state) && state.activeTurnId !== cycle.controlTurnId) {
      this.store.updateCycle(id, 'user_intervened', { previousState: cycle.state, reason: '检测到维护以外的新原生输入，已停止自动推进。' });
      this.onUpdate(cycle.session); return;
    }
    if (cycle.state === 'interrupting') {
      if (state.activity === 'idle') return this.transition(cycle, 'writing_handoff', { controlDispatched: false });
      if (cycle.interruptDispatched) return;
      if (state.activeTurnId !== cycle.originalTurnId) return this.attention(cycle, '目标已进入另一个业务轮次；旧中断请求未发送。', 'not_submitted');
      cycle = this.store.updateCycle(id, cycle.state, { interruptDispatched: true, interruptIntentAt: new Date().toISOString() });
      const result = await adapter.interrupt(state);
      this.store.updateCycle(id, cycle.state, { interruptResult: result });
      if (result.status !== 'acknowledged') this.attention(cycle, '原生中断未得到确定确认，未重试。', result.status === 'state_conflict' ? 'not_submitted' : 'unknown');
      return;
    }
    if (['writing_handoff', 'restoring'].includes(cycle.state)) {
      if (cycle.controlDispatched) {
        if (active(state) && cycle.controlTurnId && state.activeTurnId !== cycle.controlTurnId)
          this.attention(cycle, '检测到维护控制轮次以外的新输入，请核对原会话。');
        else if (state.activity === 'idle' && cycle.controlTurnId && (cycle.session.client === 'claude'
          ? state.lastCompletedTurnId === cycle.controlTurnId : state.latestTurn?.id === cycle.controlTurnId))
          this.attention(cycle, '目标轮次已结束，但系统未收到阶段回执。请检查目标会话中的权限或执行结果。', 'failed');
        return;
      }
      if (state.activity !== 'idle') return this.attention(cycle, '交付或恢复提示发送前出现了新的业务轮次。', 'not_submitted');
      const stage = cycle.state === 'writing_handoff' ? 'handoff' : 'restored';
      const tokens = this.store.getSetting('cycle-tokens:' + id);
      if (!tokens?.[stage]) return this.attention(cycle, '维护阶段凭证不可用。', 'not_submitted');
      cycle = this.store.updateCycle(id, cycle.state, { controlDispatched: true, controlTurnId: null, recoveryBoundary: null, controlIntentAt: new Date().toISOString() });
      const prompt = stage === 'handoff' ? handoffPrompt(this.root, cycle, tokens[stage]) : restorePrompt(this.root, cycle, tokens[stage]);
      const result = await adapter.sendControl(prompt, state);
      const current = this.store.cycle(id);
      this.store.updateCycle(id, current.state, { controlTurnId: result.activeTurnId || result.requestId || null, controlResult: result });
      if (result.status !== 'submitted') this.attention(current, '维护提示的投递结果未确认。', result.status === 'state_conflict' ? 'not_submitted' : 'unknown');
      return;
    }
    const endedControl = controlTurnEnded(cycle, state);
    if (cycle.state === 'awaiting_handoff_end') {
      if (!endedControl) return;
      return this.transition(cycle, 'compacting', { compactDispatched: false, preCompactEpoch: sample.usage?.contextEpoch });
    }
    if (cycle.state === 'compacting') {
      if (cycle.compactDispatched) {
        const claudeCompletion = cycle.session.client === 'claude' ? completedClaudeCompaction(cycle, state) : null;
        const finished = cycle.session.client === 'claude'
          ? Boolean(claudeCompletion)
          : sample.usage?.contextEpoch !== cycle.preCompactEpoch && Date.parse(sample.usage?.lastCompactionAt) >= Date.parse(cycle.compactIntentAt)
            && sample.usage.recordedTurnState === 'task_complete' && state.latestTurn?.itemTypes.includes('contextCompaction');
        if (finished && state.activity === 'idle') return this.transition(cycle, 'restoring', { controlDispatched: false, controlTurnId: null,
          ...(claudeCompletion ? { compactResult: claudeCompletion } : {}), compactCompletedAt: new Date().toISOString() });
        const lateResult = state.lastCompaction;
        if (cycle.session.client === 'claude' && lateResult?.requestId === cycle.compactResult?.requestId
          && ['failed', 'not_compacted'].includes(lateResult?.status)) {
          this.store.updateCycle(id, cycle.state, { compactResult: lateResult });
          return this.attention(cycle, '原生压缩未成功完成。', 'failed');
        }
        return;
      }
      if (state.activity !== 'idle') return this.attention(cycle, '压缩前出现了新的原生输入。', 'not_submitted');
      cycle = this.store.updateCycle(id, cycle.state, { compactDispatched: true, compactIntentAt: new Date().toISOString() });
      const result = await adapter.compact(state);
      this.store.updateCycle(id, cycle.state, { compactResult: result });
      // The wrapper keeps observing an operation after its HTTP wait expires.
      // Keep polling that exact request; a timeout is not a compaction failure.
      const awaitingLateResult = cycle.session.client === 'claude' && result.status === 'unknown' && Boolean(result.requestId);
      if (!['completed', 'acknowledged'].includes(result.status) && !awaitingLateResult)
        this.attention(cycle, '原生压缩失败或结果不确定；没有重复压缩。', result.status === 'failed' ? 'failed' : 'unknown');
      return;
    }
    if (cycle.state === 'awaiting_restore_end') {
      if (!endedControl) return;
      const restorePercent = sample.usage?.contextWindowTokens > 0 ? sample.usage.usedTokens * 100 / sample.usage.contextWindowTokens : null;
      this.store.updateCycle(id, cycle.state, { restoreUsage: sample.usage, restoreOverThreshold: restorePercent !== null && restorePercent >= cycle.policy.softPercent });
      this.store.releaseCycle(id, { resumeText: cycle.wasWorkingAtTrigger ? continuePrompt(cycle) : null });
      this.store.setSetting('cycle-tokens:' + id, null);
      await this.service.mailbox?.drain(sessionKey(cycle.session)); this.onUpdate(cycle.session);
    }
  }
  async cancel(id, releaseMessages) {
    const cycle = this.store.cycle(id); if (!cycle || ['completed', 'cancelled'].includes(cycle.state)) throw new Error('该流程已结束。');
    if (this.running.has(id)) throw new Error('原生操作正在返回，请稍后取消。');
    this.store.releaseCycle(id, { cancel: true, releaseMessages }); this.store.setSetting('cycle-tokens:' + id, null);
    if (releaseMessages) await this.service.mailbox?.drain(sessionKey(cycle.session));
    this.onUpdate(cycle.session);
  }
  async retry(id) {
    const cycle = this.store.cycle(id);
    const documentStage = ['writing_handoff', 'restoring'].includes(cycle?.previousState);
    if (!['needs_attention', 'user_intervened'].includes(cycle?.state)
      || (!documentStage && !['not_submitted', 'failed'].includes(cycle.lastAttemptOutcome))) throw new Error('该操作结果仍不确定，不能自动重试。');
    const state = await this.monitor.runtime(cycle.session).status();
    if (state.activity !== 'idle') throw new Error('请先确认原生会话处于空闲状态。');
    if (cycle.previousState === 'compacting' && cycle.compactResult?.boundary) throw new Error('已观察到原生压缩边界，不能直接重复压缩，请核对原会话。');
    if (documentStage && this.store.checkpoint(id, cycle.previousState === 'writing_handoff' ? 'handoff' : 'restored')) throw new Error('该阶段已有回执，请核对原生轮次结束状态。');
    this.transition(cycle, cycle.previousState, { controlDispatched: documentStage ? false : cycle.controlDispatched,
      controlTurnId: documentStage ? null : cycle.controlTurnId,
      compactDispatched: cycle.previousState === 'compacting' ? false : cycle.compactDispatched,
      interruptDispatched: cycle.previousState === 'interrupting' ? false : cycle.interruptDispatched,
      triggerRuntime: { ...cycle.triggerRuntime, instanceId: state.instanceId }, recoveryBlocked: false, recoveryBoundary: null, reason: null });
    await this.advance(id);
  }
  async reconcile(id) {
    const cycle = this.store.cycle(id);
    if (!cycle || !['needs_attention', 'user_intervened'].includes(cycle.state) || this.running.has(id)) throw new Error('该流程当前无需核对恢复。');
    const sample = await this.monitor.sample(cycle.session), runtime = sample.runtime;
    if (runtime.connected && runtime.activity === 'idle' && runtime.instanceId !== cycle.triggerRuntime.instanceId) {
      await this.recoverClient(cycle, sample); return;
    }
    if (!runtime.connected || runtime.activity !== 'idle' || runtime.instanceId !== cycle.triggerRuntime.instanceId) throw new Error('原生实例未处于可确认的空闲状态。');
    for (const field of ['model', 'effort', 'permissionMode']) {
      if (cycle.triggerRuntime[field] != null && runtime[field] != null && cycle.triggerRuntime[field] !== runtime[field]) throw new Error('原生模型、思考强度或权限选项与触发时不一致。');
    }
    if (!samePermissionSelection(cycle.triggerRuntime, runtime)) throw new Error('原生权限选项与触发时不一致。');
    const stage = cycle.previousState;
    const lastTurnId = cycle.session.client === 'claude' ? runtime.lastCompletedTurnId : runtime.latestTurn?.id;
    let next, patch = {};
    if (stage === 'compacting') {
      const complete = cycle.session.client === 'claude'
        ? Boolean(completedClaudeCompaction(cycle, runtime))
        : (sample.usage?.contextEpoch !== cycle.preCompactEpoch
        && Date.parse(sample.usage?.lastCompactionAt) >= Date.parse(cycle.compactIntentAt)
        && sample.usage?.recordedTurnState === 'task_complete' && runtime.latestTurn?.itemTypes?.includes('contextCompaction'));
      if (!complete) throw new Error('没有足够的原生压缩完成证据，保持原锁且不重复压缩。');
      if (!this.store.checkpoint(id, 'handoff')) throw new Error('第一阶段回执缺失。');
      next = 'restoring'; patch = { controlDispatched: false, controlTurnId: null, compactCompletedAt: new Date().toISOString() };
    } else if (stage === 'interrupting') {
      if (lastTurnId !== cycle.originalTurnId) throw new Error('无法把当前空闲状态与原业务轮次对应。');
      next = 'writing_handoff'; patch = { controlDispatched: false, controlTurnId: null };
    } else if (['awaiting_handoff_end', 'awaiting_restore_end'].includes(stage)) {
      if (!controlTurnEnded(cycle, runtime) || !this.store.checkpoint(id, stage === 'awaiting_handoff_end' ? 'handoff' : 'restored')) throw new Error('回执或对应控制轮次尚未确认结束。');
      next = stage;
    } else throw new Error('该阶段需要回执；请在核对原会话后重新发送交付／恢复请求。');
    if (cycle.documentHash) {
      const allowed = await realpath(cycle.session.cwd), filename = await realpath(cycle.handoffPath), path = relative(allowed, filename);
      if (!path || path.startsWith('..') || isAbsolute(path)) throw new Error('交付文档已不在原工作目录内。');
      if (createHash('sha256').update(await readFile(filename)).digest('hex') !== cycle.documentHash) throw new Error('交付文档内容已改变。');
    }
    const current = this.store.cycle(id);
    if (current.revision !== cycle.revision) throw new Error('流程在核对期间发生变化。');
    this.store.event('cycle_reconciled', { id, previousState: stage, nextState: next, observedAt: sample.observedAt });
    this.transition(current, next, { ...patch, reason: null, reconciliationAt: new Date().toISOString() });
    await this.advance(id);
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    await this.tickPromise; await this.recoveryPromise; await Promise.allSettled([...this.running.values()]); this.monitor.close();
  }
}
