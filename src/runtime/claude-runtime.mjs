import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { sendClaudeMessage } from '../adapters/claude.mjs';
import { readAccessPolicy } from '../access-policy.mjs';

// Controllers pass operation options; older callers pass the UUID directly.
function controlRequestId(options) {
  const id = typeof options === 'string' ? options : options?.requestId;
  if (id === undefined) return randomUUID();
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid Claude control request ID.');
  return id;
}

export class ClaudeRuntime {
  constructor(sessionId, { folder = fileURLToPath(new URL('../../.cooperation/claude-wrapper/instances/', import.meta.url)) } = {}) {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('Invalid Claude session ID.');
    this.id = sessionId.toLowerCase(); this.folder = folder;
  }
  async connect() {
    const access = await readAccessPolicy();
    const candidates = [];
    for (const filename of (await readdir(this.folder).catch(() => [])).filter(f => f.endsWith('.json'))) {
      try {
        const record = JSON.parse(await readFile(join(this.folder, filename), 'utf8'));
        if (record.sessionId !== this.id) continue;
        if (!access.permits(record.cwd)) continue;
        const url = new URL(record.endpoint);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^[a-f0-9]{64}$/.test(record.token)) continue;
        const response = await fetch(new URL('/status', url), { headers: { Authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(2000) });
        if (!response.ok) continue;
        const state = await response.json();
        if (state.instanceId === record.instanceId && state.sessionId === this.id) candidates.push(record);
      } catch { /* Unreachable stale registry entries never establish online state. */ }
    }
    if (candidates.length !== 1) throw new Error(candidates.length ? 'CLAUDE_MULTIPLE_INSTANCES' : 'CLAUDE_OFFLINE');
    this.record = candidates[0]; return this;
  }
  async request(path, body) {
    if (!this.record) await this.connect();
    let response;
    try { response = await fetch(new URL(path, this.record.endpoint), {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${this.record.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(path === '/compact' ? 130000 : 20000),
    }); } catch { throw Object.assign(new Error('CLAUDE_CONNECTION_LOST'), { outcome: body ? 'unknown' : 'unavailable', retryable: false }); }
    const value = await response.json();
    if (!response.ok && !value.status) throw new Error(value.error || 'CLAUDE_REQUEST_REJECTED');
    return value;
  }
  async status() {
    const state = await this.request('/status');
    if (state.instanceId !== this.record.instanceId || state.sessionId !== this.id) throw new Error('CLAUDE_INSTANCE_CHANGED');
    const requiresReopen = state.capabilities?.quotaRecovery !== true || state.capabilities?.peerQuotaRecovery !== true || state.capabilities?.inputLifecycle !== true;
    return { client: 'claude', ...state, requiresReopen, ...(requiresReopen ? {
      capabilities: { ...state.capabilities, automaticMaintenance: false },
      detail: '当前 Claude 接入需要更新；请在当前任务结束后正常重开此面板一次，加载额度与排队状态修复。自动维护已暂停。',
    } : {}) };
  }
  async context() { return this.request('/context?sessionId=' + encodeURIComponent(this.id)); }
  async quota() { return (await this.request('/quota?sessionId=' + encodeURIComponent(this.id))).quota; }
  async resumeQuota(text, expected, options) {
    if (expected.activity !== 'quota_limited' || !expected.quota?.autoResume) return { status: 'state_conflict' };
    return this.control('quota-resume', expected, { text, requestId: controlRequestId(options), canDispatch: options?.canDispatch });
  }
  async control(kind, expected, { text, requestId = randomUUID(), canDispatch } = {}) {
    const now = await this.status();
    if (now.protocolVersion !== 2) throw new Error('CLAUDE_WRAPPER_REOPEN_REQUIRED');
    if (now.requiresReopen && kind !== 'interrupt') return { status: 'state_conflict' };
    if (expected.instanceId !== now.instanceId || expected.activityRevision !== now.activityRevision || expected.activeTurnId !== now.activeTurnId || canDispatch && !canDispatch())
      return { status: 'state_conflict' };
    return this.request('/' + kind, { sessionId: this.id, instanceId: now.instanceId, requestId,
      expectedTurnId: now.activeTurnId, expectedActivityRevision: now.activityRevision, ...(text === undefined ? {} : { text }) });
  }
  async sendMessage(text, { kind = 'peer', expected, requestId = randomUUID() } = {}) {
    if (kind === 'maintenance') {
      if (!expected || expected.activity !== 'idle') return { status: 'state_conflict' };
      return this.control('prompt', expected, { text, requestId });
    }
    if (kind !== 'peer') throw new Error('Invalid Claude message kind.');
    // Peer delivery is valid while busy and must never invoke interrupt or
    // pretend that external agent content is a user/maintenance instruction.
    let visibility, observed;
    try {
      const state = await this.status();
      observed = state;
      visibility = { replayEnabled: state.capabilities?.peerMessageVisibility === true,
        historyEnabled: state.capabilities?.peerHistoryVisibility === true, displayConfirmed: false };
    } catch { visibility = { replayEnabled: false, historyEnabled: false, displayConfirmed: false }; }
    const deferred = state => ({ status: 'deferred', notSubmitted: true, detail: '接收会话额度不足，消息已保留，等待额度恢复。', runtime: { client: 'claude', ...state } });
    if (observed?.quota) return deferred(observed);
    let prepared = false;
    const observe = action => this.request('/peer-intent', { sessionId: this.id, instanceId: observed.instanceId, messageId: requestId, action });
    if (observed?.capabilities?.peerQuotaRecovery) {
      let result;
      try { result = await observe('prepare'); }
      catch { return { status: 'deferred', notSubmitted: true, reason: 'receiver_unavailable', detail: '暂时无法确认接收会话状态，消息已保留，稍后自动重试。' }; }
      if (result.status === 'deferred') return result.runtime?.quota ? deferred(result.runtime) : result;
      if (result.status !== 'ready') return { status: 'deferred', notSubmitted: true, reason: 'receiver_unavailable', detail: '接收会话尚未就绪，消息已保留。' };
      prepared = true;
    }
    let result;
    try { result = await this.sendPeer({ targetId: this.id, text, messageId: requestId }); }
    catch (error) {
      if (prepared && error.outcome === 'not_submitted') await observe('cancel').catch(() => {});
      throw error;
    }
    if (prepared && result.status === 'failed') await observe('cancel').catch(() => {});
    return { ...result, visibility, ...(!visibility.replayEnabled
      ? { detail: '本次使用普通 peer 通道；接收端尚未启用可见消息，请在工作结束后重新打开已接入的 Claude 面板。' } : {}) };
  }
  sendPeer(args) { return sendClaudeMessage(args); }
  async sendControl(text, expected, options) { return this.sendMessage(text, { kind: 'maintenance', expected, requestId: controlRequestId(options) }); }
  async interrupt(expected, options) { return this.control('interrupt', expected, { requestId: controlRequestId(options) }); }
  async compact(expected, options) {
    const requestId = controlRequestId(options);
    const current = await this.status();
    if (current.requiresReopen || current.activity !== 'idle' || !current.canCompact || (expected && (current.instanceId !== expected.instanceId || current.activityRevision !== expected.activityRevision))) return { status: 'state_conflict' };
    return this.request('/compact', { sessionId: this.id, instanceId: current.instanceId, requestId });
  }
  close() {}
}

export async function sendVisibleClaudeMessage({ targetId, text, messageId } = {}) {
  const runtime = new ClaudeRuntime(targetId);
  try { return await runtime.sendMessage(text, { kind: 'peer', requestId: messageId }); }
  finally { runtime.close(); }
}
