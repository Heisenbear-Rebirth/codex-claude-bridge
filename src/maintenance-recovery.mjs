import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
export const maintenanceStage = cycle => cycle.state === 'waiting_client' || cycle.state === 'needs_attention' ? cycle.previousState : cycle.state;
export function restartCandidate(cycle) {
  return cycle.state === 'needs_attention' && !cycle.recoveryBlocked && (
    cycle.reason?.startsWith('原生客户端实例已经改变') || cycle.reason?.startsWith('服务重启')
    || cycle.reason?.startsWith('维护阶段超时') || cycle.reason?.startsWith('目标轮次已结束，但系统未收到阶段回执')
    || ['CLAUDE_CONNECTION_LOST', 'CLAUDE_OFFLINE', 'CODEX_CONNECTION_LOST'].includes(cycle.reason));
}
export function controlTurnEnded(cycle, state) {
  if (state.activity !== 'idle' || !cycle.controlTurnId) return false;
  if (cycle.session.client !== 'claude') return state.latestTurn?.id === cycle.controlTurnId && ['completed','interrupted','failed'].includes(state.latestTurn.status);
  if (state.lastCompletedTurnId === cycle.controlTurnId) return true;
  const proof = cycle.recoveryBoundary;
  return !state.lastCompletedTurnId && proof?.instanceId === state.instanceId && proof.controlTurnId === cycle.controlTurnId
    && proof.activityRevision === state.activityRevision;
}
async function scan(file, visit, maximum = 128 * 1024 * 1024) {
  const info = await stat(file);
  if (!info.isFile() || info.size === 0 || info.size > maximum) throw Error('history_unavailable');
  const decoder = new StringDecoder('utf8'); let pending = '';
  const input = createReadStream(file, { start: 0, end: info.size - 1, signal: AbortSignal.timeout(5000) });
  try {
    for await (const chunk of input) {
      pending += decoder.write(chunk);
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (line.length > 2 * 1024 * 1024) throw Error('history_unavailable');
        if (line.trim()) visit(JSON.parse(line));
      }
      if (pending.length > 2 * 1024 * 1024) throw Error('history_unavailable');
    }
  } finally { input.destroy(); }
  pending += decoder.end();
  const after = await stat(file);
  if (pending.length || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw Error('history_changing');
}
// Only selected-session evidence is returned; no chat text, tokens or account data.
export async function readRestartEvidence(cycle, sample, { root, configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude') } = {}) {
  if (cycle.session.client === 'codex') {
    const turn = sample.runtime.latestTurn, usage = sample.usage;
    return { verified: Boolean(turn?.id) && ['completed','interrupted','failed'].includes(turn?.status), lastInputId: turn?.id, terminal: ['completed','interrupted','failed'].includes(turn?.status),
      compactCompleted: turn?.status === 'completed' && turn.itemTypes?.includes('contextCompaction') === true
        && usage?.recordedTurnState === 'task_complete' && stamp(usage.lastCompactionAt) !== null
        && stamp(cycle.compactIntentAt) !== null && stamp(usage.lastCompactionAt) >= stamp(cycle.compactIntentAt),
      source: 'codex-native-head' };
  }
  if (!UUID.test(cycle.session.id || '')) return { verified: false, reason: 'invalid_session' };
  const file = join(resolve(configDir), 'projects', resolve(cycle.session.cwd).replace(/[^a-zA-Z0-9]/g, '-'), cycle.session.id.toLowerCase() + '.jsonl');
  let lastInput = null, boundary = null, firstCwd = null, latestAssistant = null;
  try {
    await scan(file, record => {
      if (record?.sessionId?.toLowerCase?.() !== cycle.session.id.toLowerCase() || record.isSidechain || record.teamName) return;
      firstCwd ||= typeof record.cwd === 'string' ? record.cwd : null;
      if (record.type === 'system' && record.subtype === 'compact_boundary') boundary = { at: record.timestamp, trigger: record.compactMetadata?.trigger || record.compact_metadata?.trigger };
      if (record.type === 'user' && !record.isCompactSummary && !record.isVisibleInTranscriptOnly) {
        const blocks = record.message?.content;
        if (typeof blocks === 'string' || Array.isArray(blocks) && blocks.length && blocks.every(b => ['text','image','document'].includes(b?.type))) {
          lastInput = { id: record.uuid, at: record.timestamp }; latestAssistant = null;
        }
      }
      if (record.type === 'assistant') latestAssistant = { at: record.timestamp, stopReason: record.message?.stop_reason };
    });
  } catch (error) { return { verified: false, reason: error.message === 'history_changing' ? 'history_changing' : 'history_unavailable' }; }
  const result = { verified: UUID.test(lastInput?.id || '') && Boolean(firstCwd), lastInputId: lastInput?.id,
    lastInputAt: lastInput?.at, cwd: firstCwd, terminal: latestAssistant?.stopReason === 'end_turn', source: 'claude-transcript', compactCompleted: false };
  if (!cycle.compactDispatched || !root || !boundary || stamp(cycle.compactIntentAt) === null) return result;
  let requested = null, completed = null, newerControl = false;
  try {
    await scan(join(root, '.cooperation', 'claude-wrapper', 'compactions.jsonl'), record => {
      if (record?.sessionId !== cycle.session.id || stamp(record.at) === null || stamp(record.at) < stamp(cycle.compactIntentAt)) return;
      if (record.type === 'requested') { requested = record; completed = null; newerControl = false; }
      if (requested && record.type === 'finished' && record.requestId === requested.requestId) completed = record;
      if (requested && record.type === 'control_dispatch') newerControl = true;
    }, 32 * 1024 * 1024);
  } catch { return result; }
  const requestId = cycle.compactResult?.requestId || requested?.requestId;
  result.compactRequestId = requestId;
  result.compactCompleted = Boolean(requestId && requested?.requestId === requestId
    && requested.instanceId === cycle.triggerRuntime.instanceId && completed?.instanceId === requested.instanceId
    && completed.status === 'completed' && completed.boundary?.trigger === 'manual' && boundary.trigger === 'manual' && !newerControl
    && stamp(boundary.at) !== null && stamp(boundary.at) >= stamp(cycle.compactIntentAt)
    && stamp(boundary.at) <= stamp(completed.at)
    && (lastInput?.id === requestId || stamp(lastInput?.at) !== null && stamp(lastInput.at) <= stamp(requested.at)));
  return result;
}

export function restartPlan(cycle, evidence, { handoff, restored } = {}) {
  const stage = maintenanceStage(cycle), fail = reason => ({ action: 'attention', reason });
  if (!evidence?.verified) return { action: 'wait', reason: '等待可核对的原生历史记录。' };
  const sameControl = cycle.controlTurnId && evidence.lastInputId === cycle.controlTurnId;
  const beforeIntent = cycle.session.client === 'claude' && stamp(evidence.lastInputAt) !== null
    && stamp(cycle.controlIntentAt || cycle.createdAt) !== null
    && stamp(evidence.lastInputAt) <= stamp(cycle.controlIntentAt || cycle.createdAt);
  if (stage === 'interrupting') {
    if (evidence.lastInputId !== cycle.originalTurnId && !(cycle.session.client === 'claude'
      && stamp(evidence.lastInputAt) !== null && stamp(evidence.lastInputAt) <= stamp(cycle.createdAt))) return fail('重启后检测到原业务轮次之外的新输入，需人工核对。');
    return { action: 'resume', stage: 'writing_handoff', patch: { controlDispatched: false, controlTurnId: null } };
  }
  if (stage === 'compacting') {
    if (!handoff) return fail('交付回执缺失，不能自动接续压缩。');
    if (cycle.compactDispatched) return evidence.compactCompleted
      ? { action: 'resume', stage: 'restoring', patch: { controlDispatched: false, controlTurnId: null, compactCompletedAt: new Date().toISOString() } }
      : fail('压缩结果无法确认；已保留队列，不会自动重复压缩。');
    return sameControl ? { action: 'resume', stage, patch: {} } : fail('压缩前的原生轮次已改变，需人工核对。');
  }
  if (!['writing_handoff','awaiting_handoff_end','restoring','awaiting_restore_end'].includes(stage)) return fail('该维护阶段不能自动接续。');
  const restoring = stage === 'restoring' || stage === 'awaiting_restore_end';
  if (restoring && !handoff) return fail('交付回执缺失，不能自动恢复。');
  const knownUnsent = !cycle.controlDispatched && !cycle.controlTurnId && (beforeIntent
    || restoring && evidence.compactCompleted
    || !restoring && evidence.lastInputId === cycle.triggerRuntime.latestTurn?.id);
  if (!sameControl && !knownUnsent) return fail('重启后检测到维护之外的新输入，需人工核对。');
  const received = restoring ? restored : handoff;
  if (received) return { action: 'resume', stage: restoring ? 'awaiting_restore_end' : 'awaiting_handoff_end', patch: {}, endedControl: true };
  if (stage.startsWith('awaiting_')) return fail('对应阶段回执缺失，需人工核对。');
  return { action: 'resume', stage, patch: { controlDispatched: false, controlTurnId: null }, resending: true };
}
