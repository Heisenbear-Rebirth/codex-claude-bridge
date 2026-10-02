import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = info => Boolean(info?.time?.completed && (info.error || info.finish && !['tool-calls', 'unknown'].includes(info.finish)));
const pending = part => part.type === 'tool' && ['pending', 'running'].includes(part.state?.status);
const validSession = id => /^ses_[A-Za-z0-9_-]{8,128}$/.test(id || '');
const validOperation = id => /^[0-9a-f-]{36}$/.test(id || '');
const validMessage = id => /^msg_[A-Za-z0-9]+$/.test(id || '');

export function openCodeHead(session, messages, nativeState, children = []) {
  const rows = messages.filter(m => m.info?.sessionID === session.id)
    .filter(m => !session.revert?.messageID || m.info.id < session.revert.messageID)
    .sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id));
  const user = rows.findLast(m => m.info.role === 'user');
  const replies = rows.filter(m => m.info.role === 'assistant' && m.info.parentID === user?.info.id);
  const last = replies.at(-1), busy = nativeState && nativeState.type !== 'idle';
  const pendingTools = replies.flatMap(m => m.parts || []).filter(pending).length;
  const ended = !busy && !pendingTools && terminal(last?.info);
  const rateLimited = ended && last?.info.error?.name === 'APIError' && last.info.error.data?.statusCode === 429;
  const selected = session.model || user?.info.model;
  const model = selected && { providerID: selected.providerID, modelID: selected.id || selected.modelID };
  const variant = session.model?.variant ?? user?.info.model?.variant ?? 'default';
  return { rows, user, last, modelSelection: model, model: model ? model.providerID + '/' + model.modelID : null,
    agent: session.agent || user?.info.agent, effort: variant, permissionMode: hash(session.permission || []),
    activity: busy ? 'running' : pendingTools ? 'unknown' : rateLimited ? 'quota_limited' : 'idle', pendingTools,
    quota: rateLimited ? { turnId: user.info.id, kind: 'unknown_rate_limit', source: 'opencode-native-error', autoResume: false } : null,
    activeTurnId: busy ? user?.info.id || null : null,
    latestTurn: user ? { id: user.info.id, status: ended ? last.info.error ? last.info.error.name === 'MessageAbortedError' ? 'interrupted' : 'failed' : 'completed' : 'running',
      itemTypes: (user.parts || []).some(p => p.type === 'compaction') ? ['contextCompaction'] : ['userMessage'],
      completedAt: ended ? new Date(last.info.time.completed).toISOString() : null } : null,
    lastCompletedTurnId: ended ? user.info.id : null,
    // An old child can still own background work after its parent becomes idle.
    // Until the native API exposes a complete job list, any child blocks control.
    subagentHistoryPresent: children.length > 0,
  };
}

export class OpenCodeMaintenance {
  constructor({ client, native, root, directory, instanceId, hooks = false }) {
    Object.assign(this, { client, native, root, directory, instanceId });
    this.supported = hooks && ['get','messages','message','status','children','promptAsync','summarize','abort'].every(k => typeof client.session?.[k] === 'function')
      && typeof client._client?.get === 'function';
    this.inputs = new Map(); this.gates = new Map(); this.owned = new Set(); this.jobs = new Set(); this.compacting = new Set(); this.active = new Map();
  }
  inputState(id) { if (!this.inputs.has(id)) this.inputs.set(id, { revision: 0, pending: new Set() }); return this.inputs.get(id); }
  async beforeMessage(input, output) {
    if (!this.supported || this.owned.has(output.message.id)) return;
    const state = this.inputState(input.sessionID); state.revision++; state.pending.add(output.message.id);
    // Hold only during a single native control RPC, never throughout maintenance.
    // The original request continues unchanged once the operation returns.
    await this.gates.get(input.sessionID)?.promise;
  }
  event({ event }) {
    if (event.type === 'message.updated' && event.properties?.info?.role === 'user') {
      const info = event.properties.info; this.inputState(info.sessionID).pending.delete(info.id);
      this.owned.delete(info.id);
    }
  }
  async requests(url, id) {
    const result = await this.client._client.get({ url, query: { directory: this.directory }, signal: AbortSignal.timeout(10000) });
    if (result.error || result.response && !result.response.ok || !Array.isArray(result.data)) throw Error('Native requests unavailable');
    return result.data.filter(r => r.sessionID === id).length;
  }
  async snapshot(id) {
    if (!validSession(id)) throw Error('Invalid session');
    const session = await this.native('get', id);
    const [messages, states, children, permissions, questions] = await Promise.all([
      this.native('messages', id, { query: { directory: this.directory, limit: 200 } }), this.native('status'), this.native('children', id),
      this.requests('/permission', id), this.requests('/question', id),
    ]);
    const head = openCodeHead(session, messages, states?.[id], children);
    const input = this.inputState(id);
    for (const row of head.rows) input.pending.delete(row.info.id);
    const activity = permissions ? 'waiting_permission' : questions ? 'waiting_input' : head.activity;
    const revision = hash([head.user?.info.id, head.last?.info.id, head.latestTurn?.status, activity, head.pendingTools,
      head.model, head.agent, head.effort, head.permissionMode, session.revert || null, children.map(c => c.id), input.revision, [...input.pending]]);
    const state = { sessionId: id, cwd: this.directory, instanceId: this.instanceId, connected: true, activity,
      activityRevision: revision, activeTurnId: head.activeTurnId, latestTurn: head.latestTurn, lastCompletedTurnId: head.lastCompletedTurnId,
      quota: head.quota,
      model: head.model, modelSelection: head.modelSelection, agent: head.agent, effort: head.effort, permissionMode: head.permissionMode,
      subagentHistoryPresent: head.subagentHistoryPresent, pendingRequests: permissions + questions, queuedNativeInputs: input.pending.size,
      reverted: Boolean(session.revert), observedAt: new Date().toISOString(),
      capabilities: { automaticMaintenance: true, sendControl: true, compact: true, interrupt: true, observeCompletion: true } };
    const entry = await this.lastCompact(id);
    if (entry) {
      state.lastCompaction = entry.completion || this.compactionEvidence(entry, head);
      if (!entry.completion && state.lastCompaction.status === 'completed')
        await this.save(this.file(id, entry.requestId), { ...entry, completion: state.lastCompaction });
    }
    // The recent-message window eventually moves past the summary. Keep its
    // identity so a long session does not silently revert to the initial epoch.
    const epochFile = join(this.folder(id), 'context-epoch.json');
    let epoch = await this.load(epochFile);
    const summary = head.rows.findLast(m => m.info.role === 'assistant' && m.info.summary && terminal(m.info) && !m.info.error);
    if (summary && (!epoch || summary.info.time.completed > epoch.completedAt || summary.info.time.completed === epoch.completedAt && summary.info.id > epoch.id)) {
      epoch = { id: summary.info.id, completedAt: summary.info.time.completed };
      await mkdir(this.folder(id), { recursive: true }); await this.save(epochFile, epoch);
    }
    state.contextEpoch = epoch?.id || 'initial';
    return { state, head };
  }
  folder(id) { if (!validSession(id)) throw Error('Invalid session'); return join(this.root, '.cooperation/opencode/maintenance', id); }
  file(id, requestId) { if (!validOperation(requestId)) throw Error('Invalid operation'); return join(this.folder(id), requestId + '.json'); }
  async load(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  async save(file, entry, exclusive = false) {
    if (exclusive) return writeFile(file, JSON.stringify(entry), { flag: 'wx', mode: 0o600 });
    const tmp = file + '.' + randomUUID() + '.tmp';
    try { await writeFile(tmp, JSON.stringify(entry), { flag: 'wx', mode: 0o600 }); await rename(tmp, file); }
    finally { await unlink(tmp).catch(() => {}); }
  }
  async lastCompact(id) {
    const ref = await this.load(join(this.folder(id), 'last-compaction.json'));
    return ref ? this.load(this.file(id, ref.requestId)) : null;
  }
  compactionEvidence(entry, head) {
    const base = { requestId: entry.requestId, sessionId: entry.targetId, status: 'unknown' };
    if (entry.result?.status === 'state_conflict') return { ...base, status: 'state_conflict' };
    if (this.compacting.has(entry.targetId)) return base;
    const boundary = head.rows.findIndex(m => m.info.id === entry.beforeId);
    if (boundary < 0) return base;
    const users = head.rows.slice(boundary + 1).filter(m => m.info.role === 'user');
    if (users.length !== 1 || !users[0].parts?.some(p => p.type === 'compaction' && p.auto === false)) return base;
    const parent = users[0].info;
    if (parent.time.created < Date.parse(entry.createdAt)) return base;
    const summary = head.rows.findLast(m => m.info.role === 'assistant' && m.info.parentID === parent.id && m.info.summary === true);
    if (!summary?.info.time?.completed) return { ...base, nativeMessageId: parent.id };
    const successful = terminal(summary.info) && !summary.info.error && head.latestTurn?.id === parent.id && head.latestTurn.status === 'completed';
    return { ...base, nativeMessageId: parent.id, status: summary.info.error ? 'failed' : successful ? 'completed' : 'unknown',
      summaryMessageId: summary.info.id, completedAt: new Date(summary.info.time.completed).toISOString() };
  }
  async status(id) { return (await this.snapshot(id)).state; }
  async operate(input) {
    if (!this.supported) throw Error('OpenCode 维护插件尚未就绪。');
    const { targetId: id, requestId, kind, expected, text, messageId } = input;
    if (!['prompt','interrupt','compact'].includes(kind) || !validOperation(requestId) || !validSession(id)) throw Error('Invalid maintenance operation');
    if (kind === 'prompt' && (!validMessage(messageId) || typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 256 * 1024)) throw Error('Invalid control message');
    const signature = hash([id, kind, text, messageId, expected]);
    if (this.active.has(id)) {
      const old = this.active.get(id);
      return old.signature === signature ? old.work : { status: 'state_conflict', requestId };
    }
    const work = this.run(input, signature).finally(() => this.active.delete(id));
    this.active.set(id, { signature, work }); return work;
  }
  async run(input, fingerprint) {
    const { targetId: id, requestId, kind, expected, text, messageId } = input, file = this.file(id, requestId);
    const old = await this.load(file);
    if (old) {
      if (old.fingerprint !== fingerprint) throw Error('Maintenance operation ID conflict');
      if (old.result?.status === 'state_conflict') return { status: 'state_conflict', requestId, duplicate: true };
      if (kind === 'compact') return { ...(old.completion || this.compactionEvidence(old, (await this.snapshot(id)).head)), duplicate: true };
      if (kind === 'prompt') {
        const row = await this.native('message', id, { path: { id, messageID: old.messageId } }).catch(() => null);
        const recorded = row?.info?.sessionID === id && row.info.role === 'user'
          && hash((row.parts || []).filter(p => p.type === 'text').map(p => p.text).join('\n')) === old.textHash;
        return { status: recorded ? 'submitted' : 'unknown', requestId, activeTurnId: old.messageId, duplicate: true };
      }
      return { ...old.result, requestId, duplicate: true };
    }
    if (this.compacting.has(id)) return { status: 'state_conflict', requestId };
    let release;
    const gate = { promise: new Promise(done => { release = done; }) }; this.gates.set(id, gate);
    if (messageId) this.owned.add(messageId);
    try {
      const { state, head } = await this.snapshot(id);
      if (!expected || expected.instanceId !== this.instanceId || expected.activityRevision !== state.activityRevision
        || expected.sessionId !== id || state.pendingRequests || state.queuedNativeInputs || state.subagentHistoryPresent || state.reverted
        || !state.modelSelection?.providerID || !state.modelSelection.modelID || !state.agent
        || (kind === 'interrupt' ? state.activity !== 'running' || !state.activeTurnId || state.activeTurnId !== expected.activeTurnId
          : state.activity !== 'idle' || !state.lastCompletedTurnId)) return { status: 'state_conflict', requestId };
      await mkdir(this.folder(id), { recursive: true });
      const entry = { targetId: id, requestId, kind, fingerprint, messageId, textHash: kind === 'prompt' ? hash(text) : null,
        beforeId: head.user?.info.id, createdAt: new Date().toISOString(), result: { status: 'unknown' } };
      await this.save(file, entry, true);
      if (kind === 'compact') await this.save(join(this.folder(id), 'last-compaction.json'), { requestId });
      // Recheck after durable IO. Native user requests arriving here are held by
      // chat.message and change the revision, so no stale control is submitted.
      const current = await this.snapshot(id);
      if (current.state.activityRevision !== state.activityRevision) {
        entry.result = { status: 'state_conflict' }; await this.save(file, entry);
        return { ...entry.result, requestId };
      }
      const submit = async () => {
        try {
          if (kind === 'prompt') await this.native('promptAsync', id, { body: { messageID: messageId,
            model: state.modelSelection, agent: state.agent, variant: state.effort,
            parts: [{ type: 'text', text }] } });
          else if (kind === 'interrupt') await this.native('abort', id);
          else await this.native('summarize', id, { body: { ...state.modelSelection, auto: false }, signal: AbortSignal.timeout(300000) });
          entry.result = { status: kind === 'prompt' ? 'submitted' : 'acknowledged' };
        } catch { entry.result = { status: 'unknown' }; }
        await this.save(file, entry);
      };
      if (kind === 'compact') {
        // Long native call is owned by the plugin, not the manager HTTP timeout.
        // Native input remains usable during compaction. New input makes its
        // completion evidence ambiguous and the controller stops the cycle.
        this.compacting.add(id);
        const job = submit().finally(() => { this.jobs.delete(job); this.compacting.delete(id); });
        this.jobs.add(job); void job.catch(() => {});
        return { status: 'acknowledged', requestId };
      }
      await submit(); return { ...entry.result, requestId, ...(kind === 'prompt' ? { activeTurnId: messageId } : {}) };
    } finally {
      if (this.gates.get(id) === gate) this.gates.delete(id);
      release();
    }
  }
  async close() { await Promise.allSettled([...this.jobs, ...[...this.active.values()].map(item => item.work)]); }
}
