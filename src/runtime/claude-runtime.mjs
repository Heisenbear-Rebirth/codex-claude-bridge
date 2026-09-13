import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { sendClaudeMessage } from '../adapters/claude.mjs';

export class ClaudeRuntime {
  constructor(sessionId, { folder = fileURLToPath(new URL('../../.cooperation/claude-wrapper/instances/', import.meta.url)) } = {}) {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('Invalid Claude session ID.');
    this.id = sessionId.toLowerCase(); this.folder = folder;
  }
  async connect() {
    const candidates = [];
    for (const filename of (await readdir(this.folder).catch(() => [])).filter(f => f.endsWith('.json'))) {
      try {
        const record = JSON.parse(await readFile(join(this.folder, filename), 'utf8'));
        if (record.sessionId !== this.id) continue;
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
    return { client: 'claude', ...state };
  }
  async context() { return this.request('/context?sessionId=' + encodeURIComponent(this.id)); }
  async control(kind, expected, { text, requestId = randomUUID() } = {}) {
    const now = await this.status();
    if (now.protocolVersion !== 2) throw new Error('CLAUDE_WRAPPER_REOPEN_REQUIRED');
    if (expected.instanceId !== now.instanceId || expected.activityRevision !== now.activityRevision || expected.activeTurnId !== now.activeTurnId)
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
    let visibility;
    try {
      const state = await this.status();
      visibility = { replayEnabled: state.capabilities?.peerMessageVisibility === true,
        historyEnabled: state.capabilities?.peerHistoryVisibility === true, displayConfirmed: false };
    } catch { visibility = { replayEnabled: false, historyEnabled: false, displayConfirmed: false }; }
    const result = await this.sendPeer({ targetId: this.id, text, messageId: requestId });
    return { ...result, visibility, ...(!visibility.replayEnabled
      ? { detail: '本次使用普通 peer 通道；接收端尚未启用可见消息，请在工作结束后重新打开已接入的 Claude 面板。' } : {}) };
  }
  sendPeer(args) { return sendClaudeMessage(args); }
  async sendControl(text, expected, requestId) { return this.sendMessage(text, { kind: 'maintenance', expected, requestId }); }
  async interrupt(expected, requestId) { return this.control('interrupt', expected, { requestId }); }
  async compact(expected) {
    const current = await this.status();
    if (current.activity !== 'idle' || !current.canCompact || (expected && (current.instanceId !== expected.instanceId || current.activityRevision !== expected.activityRevision))) return { status: 'state_conflict' };
    return this.request('/compact', { sessionId: this.id, instanceId: current.instanceId, requestId: randomUUID() });
  }
  close() {}
}

export async function sendVisibleClaudeMessage({ targetId, text, messageId } = {}) {
  const runtime = new ClaudeRuntime(targetId);
  try { return await runtime.sendMessage(text, { kind: 'peer', requestId: messageId }); }
  finally { runtime.close(); }
}
