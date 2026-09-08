import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CodexIpc } from './codex-ipc.mjs';
import { normalizeDirectory } from '../directory-service.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
const text = value => typeof value === 'string' ? value : null;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export function permissionSelection(permissions, sessionId, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), cwd) {
  if (!permissions) return null;
  const selected = structuredClone(permissions);
  const root = normalizeDirectory(codexHome) + '/visualizations/';
  const nativeRoot = path => {
    const value = normalizeDirectory(path);
    return value.startsWith(root) && /^\d{4}\/\d{2}\/\d{2}\//.test(value.slice(root.length))
      && value.slice(root.length).split('/').length === 4 && value.endsWith('/' + sessionId.toLowerCase());
  };
  // Native compaction omits the app-owned visualization root; a normal turn
  // restores it. Compare user permission choices without this per-turn root.
  for (const [container, key] of [[selected, 'runtimeWorkspaceRoots'], [selected.sandboxPolicy, 'writableRoots']]) {
    if (Array.isArray(container?.[key])) container[key] = [...new Set(container[key].filter(path => !nativeRoot(path)).map(normalizeDirectory))].sort();
  }
  if (cwd && selected.sandboxPolicy?.type === 'workspaceWrite') {
    selected.sandboxPolicy.writableRoots = [...new Set([...(selected.sandboxPolicy.writableRoots || []), normalizeDirectory(cwd)])].sort();
  }
  return canonical(selected);
}
export function samePermissionSelection(before, after) {
  if (!before.permissionFingerprint || !after.permissionFingerprint) return true;
  if (before.permissionFingerprint === after.permissionFingerprint) return true;
  return before.permissionFingerprintBasis === 'permission-selection-excluding-native-visualization-root'
    && after.legacyPermissionFingerprints?.includes(before.permissionFingerprint) === true;
}
export function projectCodexState(s) {
  // Only retain control metadata. The IPC snapshot may contain history text;
  // neither the runtime snapshot nor its event log keeps that text.
  const history = s.turnHistory?.kind === 'canonical' ? s.turnHistory.history : null;
  const canonical = history?.islands?.flatMap(island => island.entries?.map(entry => history.entitiesByKey?.[entry.value]) || []).filter(Boolean) || [];
  const turns = [...canonical, ...(Array.isArray(s.turns) ? s.turns : [])];
  const active = turns.filter(t => t.status === 'inProgress' && t.turnId);
  const activeIds = [...new Set(active.map(t => t.turnId))];
  const latest = canonical.at(-1) || turns.at(-1);
  const flags = s.threadRuntimeStatus?.activeFlags || [];
  let activity = 'unknown';
  if (s.threadRuntimeStatus?.type === 'notLoaded' || s.resumeState === 'needs_resume') activity = 'unloaded';
  else if (flags.includes('waitingOnApproval')) activity = 'waiting_permission';
  else if (flags.includes('waitingOnUserInput')) activity = 'waiting_input';
  else if (s.threadRuntimeStatus?.type === 'active' && activeIds.length === 1) activity = 'running';
  else if (s.threadRuntimeStatus?.type === 'idle' && activeIds.length === 0 && !s.requests?.length) activity = 'idle';
  const model = text(s.latestModel) || text(s.latestCollaborationMode?.settings?.model);
  const effort = s.latestThreadSettings?.effort !== undefined ? text(s.latestThreadSettings.effort)
    : s.latestCollaborationMode?.settings?.reasoning_effort !== undefined ? text(s.latestCollaborationMode.settings.reasoning_effort) : text(s.latestReasoningEffort);
  const permissions = permissionSelection(s.currentPermissions, s.id, undefined, s.cwd);
  const implicitCwd = structuredClone(permissions);
  if (implicitCwd?.sandboxPolicy?.type === 'workspaceWrite') implicitCwd.sandboxPolicy.writableRoots = implicitCwd.sandboxPolicy.writableRoots.filter(path => path !== normalizeDirectory(s.cwd));
  return { activity, activeTurnId: activeIds.length === 1 ? activeIds[0] : null,
    subagentHistoryPresent: turns.some(turn => turn.items?.some(item => item.type === 'collabAgentToolCall')),
    pendingRequests: s.requests?.length || 0, runtimeStatus: text(s.threadRuntimeStatus?.type),
    activeFlags: flags.filter(v => typeof v === 'string'), model, effort, lastOperationEffort: text(s.latestReasoningEffort),
    effortSource: s.latestThreadSettings?.effort !== undefined ? 'thread-settings' : s.latestCollaborationMode?.settings?.reasoning_effort !== undefined ? 'collaboration-settings' : 'latest-operation',
    permissionFingerprint: hash(permissions), permissionFingerprintBasis: 'permission-selection-v2-implicit-workspace-root',
    legacyPermissionFingerprints: [hash(permissions), hash(implicitCwd)], cwd: text(s.cwd),
    goalStatus: text(s.threadGoal?.status), unconfirmedSubmissions: s.unconfirmedTurnSubmissions?.length || 0,
    latestTurn: latest ? { id: text(latest.turnId), status: text(latest.status),
      itemTypes: [...new Set(latest.items?.map(i => i.type).filter(v => typeof v === 'string') || [])] } : null };
}

export class CodexRuntime {
  constructor(sessionId, { ipc = new CodexIpc(), timeoutMs = 5000 } = {}) {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('Invalid Codex session ID.');
    this.id = sessionId.toLowerCase(); this.ipc = ipc; this.timeoutMs = timeoutMs;
    this.snapshot = null; this.ownerId = null; this.activityRevision = 0; this.waiters = new Set();
    this.onBroadcast = frame => {
      if (frame.method === 'client-status-changed' && frame.params?.clientId === this.ownerId && frame.params.status === 'disconnected') {
        this.snapshot = null; this.ownerId = null; return;
      }
      if (frame.method !== 'thread-stream-state-changed' || frame.version !== 11 || frame.sourceClientId !== this.ownerId
        || frame.params?.hostId !== 'local' || frame.params?.conversationId !== this.id) return;
      const change = frame.params.change;
      if (change?.type === 'snapshot') {
        if (change.conversationState?.id !== this.id || !Number.isInteger(change.revision) || change.revision < (this.snapshot?.streamRevision || 0)) return;
        let projected; try { projected = projectCodexState(change.conversationState); } catch { return; }
        const signature = hash({ activity: projected.activity, activeTurnId: projected.activeTurnId,
          pendingRequests: projected.pendingRequests, model: projected.model, effort: projected.effort,
          permissions: projected.permissionFingerprint, goal: projected.goalStatus, subagents: projected.subagentHistoryPresent });
        if (signature !== this.signature) { this.activityRevision++; this.signature = signature; }
        this.snapshot = { ...projected, activityRevision: this.activityRevision, streamRevision: change.revision, observedAt: new Date().toISOString() };
        for (const resolve of this.waiters) resolve(this.snapshot); this.waiters.clear();
      } else if (change?.type === 'patches') this.dirty = true;
    };
    this.onDisconnect = () => { this.snapshot = null; this.ownerId = null; };
    this.ipc.on('broadcast', this.onBroadcast); this.ipc.on('disconnected', this.onDisconnect);
  }
  async connect() { await this.ipc.connect(); return this; }
  async status() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refresh().finally(() => { this.refreshing = null; }); return this.refreshing;
  }
  async refresh() {
    const base = { client: 'codex', sessionId: this.id, connected: false, activity: 'offline',
      activeTurnId: null, activityRevision: null, instanceId: null, observedAt: new Date().toISOString(),
      capabilities: { readActivity: true, interrupt: true, sendControl: true, compact: true, observeCompletion: true,
        wakeUnloaded: false, hardAutomation: true, automaticMaintenance: true } };
    try {
      await this.connect();
      const owner = await this.ipc.request('thread-owner-discovery', { hostId: 'local', conversationId: this.id });
      if (owner.resultType !== 'success' || !owner.handledByClientId) {
        this.snapshot = null; this.ownerId = null;
        return { ...base, activity: 'unloaded', appConnected: true, detail: 'No live desktop owner; open this existing task in the native app.' };
      }
      if (this.ownerId !== owner.handledByClientId) { this.snapshot = null; this.signature = null; }
      this.ownerId = owner.handledByClientId;
      const snapshot = await new Promise((resolve, reject) => {
        let timer;
        const done = value => { clearTimeout(timer); this.waiters.delete(done); resolve(value); };
        timer = setTimeout(() => { this.waiters.delete(done); reject(new Error('CODEX_SNAPSHOT_TIMEOUT')); }, this.timeoutMs);
        this.waiters.add(done);
        try { this.ipc.following(this.id, this.ownerId); } catch (error) { clearTimeout(timer); this.waiters.delete(done); reject(error); }
      });
      const parallelUnverified = snapshot.subagentHistoryPresent || snapshot.goalStatus === 'active';
      return { ...base, ...snapshot, connected: true, instanceId: this.ownerId,
        capabilities: { ...base.capabilities, hardAutomation: !parallelUnverified, automaticMaintenance: !parallelUnverified } };
    } catch (error) { return { ...base, activity: this.ipc.connected ? 'unknown' : 'offline', detail: error.message }; }
  }
  async checkExpected(expected, activity) {
    const current = await this.status();
    if (!current.connected || current.instanceId !== expected.instanceId || current.activeTurnId !== expected.activeTurnId
      || current.activityRevision !== expected.activityRevision || (activity && current.activity !== activity)) return null;
    return current;
  }
  async interrupt(expected) {
    const current = await this.checkExpected(expected);
    if (!current || !current.activeTurnId || !['running', 'waiting_permission', 'waiting_input'].includes(current.activity)) return { status: 'state_conflict' };
    if (current.goalStatus === 'active') return { status: 'needs_attention', detail: 'Automatic goal hold/resume is not yet verified.' };
    const response = await this.ipc.request('thread-follower-interrupt-turn', {
      conversationId: this.id, mode: 'descendant-cleanup', expectedTurnId: current.activeTurnId,
    }, this.ownerId, 20000);
    return response.resultType === 'success' ? { status: response.result?.interruptedTurnId === current.activeTurnId ? 'acknowledged' : 'state_conflict',
      interruptedTurnId: response.result?.interruptedTurnId ?? null } : { status: 'unknown', detail: 'Native interrupt did not confirm its outcome.' };
  }
  async sendControl(message, expected) {
    if (typeof message !== 'string' || !message.trim()) throw new Error('A non-empty control message is required.');
    const current = await this.checkExpected(expected, 'idle');
    if (!current) return { status: 'state_conflict' };
    const response = await this.ipc.request('thread-follower-start-turn', { conversationId: this.id,
      turnStart: { request: { threadId: this.id, input: [{ type: 'text', text: message, text_elements: [] }] },
        context: { inheritThreadSettings: true } } }, this.ownerId, 20000);
    const turn = response.result?.result?.turn;
    return response.resultType === 'success' ? { status: 'submitted', activeTurnId: turn?.id || null }
      : { status: 'unknown', detail: 'Native start did not confirm its outcome.' };
  }
  async compact(expected) {
    if (!await this.checkExpected(expected, 'idle')) return { status: 'state_conflict' };
    const response = await this.ipc.request('thread-follower-compact-thread', { conversationId: this.id }, this.ownerId, 20000);
    return { status: response.resultType === 'success' ? 'acknowledged' : 'unknown' };
  }
  close() {
    if (this.ipc.connected && this.ownerId) { try { this.ipc.following(this.id, this.ownerId, false); } catch {} }
    this.ipc.off('broadcast', this.onBroadcast); this.ipc.off('disconnected', this.onDisconnect); this.ipc.close();
  }
}
