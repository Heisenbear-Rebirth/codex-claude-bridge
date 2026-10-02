import { readFile, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { sessionKey } from './management-store.mjs';
import { normalizeDirectory } from './directory-service.mjs';
import { modelChanged } from './model-identity.mjs';
import { samePermissionSelection } from './runtime/codex-runtime.mjs';

export const receiptHash = token => createHash('sha256').update(String(token)).digest('hex');
function equalHash(a, b) { return typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
const stageOf = cycle => ['waiting_client', 'needs_attention'].includes(cycle.state) ? cycle.previousState : cycle.state;
export const recoverableReceiptPause = cycle => cycle.state === 'needs_attention' && !cycle.recoveryBlocked && (
  /^维护阶段超时|^目标轮次已结束，但系统未收到阶段回执|^维护提示的投递结果未确认|^服务重启/.test(cycle.reason || '')
  || ['CLAUDE_CONNECTION_LOST', 'CODEX_CONNECTION_LOST'].includes(cycle.reason));
function canReceive(cycle, expected) {
  return cycle.controlDispatched && stageOf(cycle) === expected
    && (cycle.state === expected || cycle.state === 'waiting_client' || recoverableReceiptPause(cycle));
}
function stateError(cycle, code = 'CHECKPOINT_STAGE_UNAVAILABLE') {
  const ended = ['completed', 'cancelled'].includes(cycle.state);
  return Object.assign(new Error(ended ? '这次维护已结束，请停止提交旧的回执。'
    : ['needs_attention', 'user_intervened'].includes(cycle.state)
      ? '本次维护已暂停，暂不能确认交付。已写好的文档请保留；在管理页选择“检查并继续”后，可重试同一回执，无需重写文档。'
      : '当前维护阶段已变化，请核对最新的保存或恢复请求，再提交对应回执。'), { code, statusCode: 409 });
}
export class CheckpointService {
  constructor({ store, root, onReceipt = () => {}, readRuntime }) { this.store = store; this.root = root; this.onReceipt = onReceipt; this.readRuntime = readRuntime; }
  async accept(input, source) {
    try { return await this.acceptReceipt(input, source); }
    catch (error) {
      // Persist only authenticated stage diagnostics, never the receipt token,
      // submitted document, command line or conversation content.
      const cycle = typeof input?.cycleId === 'string' ? this.store.cycle(input.cycleId) : null;
      if (cycle && input?.from && sessionKey(input.from) === sessionKey(cycle.session)
        && equalHash(receiptHash(input.receiptToken), cycle.receiptHashes?.[input.stage])) {
        const issue = { at: new Date().toISOString(), stage: input.stage, state: cycle.state,
          code: error.code || 'CHECKPOINT_VALIDATION_FAILED', reason: error.message };
        this.store.event('checkpoint_rejected', { cycleId: cycle.id, ...issue });
        this.store.updateCycle(cycle.id, cycle.state, { lastReceiptIssue: issue });
        this.onReceipt(cycle.id);
      }
      throw error;
    }
  }
  async verifyLate(cycle, source) {
    if (!this.readRuntime || !cycle.controlTurnId) throw stateError(cycle);
    const runtime = await this.readRuntime(cycle.session);
    const head = runtime.activity === 'idle' ? runtime.latestTurn?.id || runtime.lastCompletedTurnId : runtime.activeTurnId;
    if (!runtime.connected || runtime.instanceId !== cycle.triggerRuntime.instanceId || head !== cycle.controlTurnId
      || !['idle', 'running', 'waiting_permission', 'waiting_input'].includes(runtime.activity)
      || runtime.queuedNativeInputs > 0 || runtime.unconfirmedSubmissions > 0 || runtime.quota
      || modelChanged(cycle.triggerRuntime.model, runtime.model) || !samePermissionSelection(cycle.triggerRuntime, runtime)
      || ['effort', 'permissionMode'].some(key => cycle.triggerRuntime[key] != null && runtime[key] != null && cycle.triggerRuntime[key] !== runtime[key])
      || cycle.session.client === 'opencode' && source?.nativeUserMessageId !== head) throw stateError(cycle, 'CHECKPOINT_NATIVE_TURN_CHANGED');
  }
  async acceptReceipt({ from, cycleId, stage, receiptToken, documentPath }, source) {
    if (!['handoff', 'restored'].includes(stage)) throw new Error('无效的回执阶段。');
    const cycle = this.store.cycle(cycleId);
    if (!cycle || sessionKey(from) !== sessionKey(cycle.session)) throw new Error('回执发送方不属于当前维护流程。');
    if (!equalHash(receiptHash(receiptToken), cycle.receiptHashes?.[stage])) throw new Error('回执凭证不匹配。');
    const existing = this.store.checkpoint(cycleId, stage);
    if (from.client === 'opencode' && (source?.kind !== 'opencode-tool-context'
      || source.instanceId !== cycle.triggerRuntime.instanceId || source.nativeUserMessageId !== (existing?.nativeUserMessageId || cycle.controlTurnId)))
      throw new Error('OpenCode 回执必须来自当前维护控制轮次的原生工具。');
    if (existing) {
      if (documentPath && normalizeDirectory(documentPath) !== normalizeDirectory(existing.documentPath)) throw new Error('重复回执的文档路径发生变化。');
      return { status: 'accepted', cycleId, stage, duplicate: true };
    }
    const expected = stage === 'handoff' ? 'writing_handoff' : 'restoring';
    if (!canReceive(cycle, expected)) throw stateError(cycle);
    if (typeof documentPath !== 'string' || !isAbsolute(documentPath)) throw new Error('请提供交付文档的绝对路径。');
    const allowedRoot = await realpath(cycle.session.cwd);
    const actual = await realpath(documentPath);
    const rel = relative(allowedRoot, actual);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('交付文档必须位于目标会话获准的工作目录内。');
    const info = await stat(actual);
    if (!info.isFile() || info.size === 0 || info.size > 2 * 1024 * 1024) throw new Error('交付文档必须是非空文件，且不能超过 2 MiB。');
    const bytes = await readFile(actual); const documentHash = createHash('sha256').update(bytes).digest('hex');
    if (stage === 'restored' && documentHash !== cycle.documentHash) throw new Error('恢复时的交付文档与第一次回执的内容不一致。');
    const receipt = { at: new Date().toISOString(), from, documentPath: actual, documentHash, bytes: bytes.length, cycleId, stage,
      ...(from.client === 'opencode' ? { nativeUserMessageId: source.nativeUserMessageId, nativeMessageId: source.nativeMessageId } : {}) };
    const backupDir = join(this.root, '.cooperation', 'handoff-copies', cycleId);
    await mkdir(backupDir, { recursive: true });
    // A concurrent rejection may leave an unaccepted copy. Content-addressed
    // copies cannot poison a later valid attempt with a different document.
    const backupPath = join(backupDir, 'handoff-' + documentHash + '.md');
    if (stage === 'handoff') await writeFile(backupPath, bytes, { flag: 'wx' }).catch(async error => {
      if (error.code !== 'EEXIST' || createHash('sha256').update(await readFile(backupPath)).digest('hex') !== documentHash) throw error;
    });
    if (stage === 'handoff') receipt.backupPath = backupPath;
    const observed = this.store.cycle(cycleId);
    const late = cycle.state === 'needs_attention' || observed.state === 'needs_attention';
    if (late) {
      if (!canReceive(observed, expected)) throw stateError(observed);
      await this.verifyLate(observed, source);
    }
    this.store.transaction(() => {
      const current = this.store.cycle(cycleId);
      const duplicate = this.store.checkpoint(cycleId, stage);
      if (duplicate && duplicate.documentHash === documentHash) return;
      // Delivery results and live-turn observations also increment revision.
      // Reject a different attempt or phase, not those harmless metadata updates.
      if (!canReceive(current, expected) || current.controlRequestId !== cycle.controlRequestId
        || current.receiptHashes?.[stage] !== cycle.receiptHashes?.[stage]
        || current.triggerRuntime.instanceId !== cycle.triggerRuntime.instanceId
        || cycle.controlTurnId && current.controlTurnId !== cycle.controlTurnId
        || current.state === 'needs_attention' && !late) throw stateError(current, 'CHECKPOINT_STATE_CHANGED');
      this.store.saveCheckpoint(cycleId, stage, receipt);
      this.store.updateCycle(cycleId, stage === 'handoff' ? 'awaiting_handoff_end' : 'awaiting_restore_end',
        { ...(stage === 'handoff' ? { documentHash, handoffPath: actual } : {}), receiptAt: receipt.at,
          deadlineAt: new Date(Date.now() + 60000).toISOString(), reason: null, lastReceiptIssue: null,
          ...(late ? { recoveryBlocked: false, lateReceiptAccepted: true } : {}) });
    });
    // The controller observes this transition on its next tick, after the tool
    // response and native turn end. It never compacts inside this HTTP request.
    this.onReceipt(cycleId); return { status: 'accepted', cycleId, stage, duplicate: false };
  }
}
