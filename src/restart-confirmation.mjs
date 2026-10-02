import { randomUUID } from 'node:crypto';

const keyOf = s => `${s.hostId || 'local'}:${s.client}:${s.id || s.sessionId}`;
const headOf = r => r?.quota?.turnId || r?.activeTurnId || r?.latestTurn?.id || r?.lastObservedInputId || r?.lastCompletedTurnId;
const prefix = 'restart-confirmation:';
const resumableQuota = q => ['waiting', 'sending', 'attention'].includes(q?.state);

// Consent belongs to one service boot and the specific persisted work presented
// to the user. It never replaces native identity, receipts or delivery evidence.
export class RestartConfirmation {
  constructor(store) { this.store = store; this.bootId = randomUUID(); this.startedAt = new Date().toISOString(); this.seen = new Set(); }
  get(session) { return this.store.getSetting(prefix + (typeof session === 'string' ? session : keyOf(session))); }
  save(record) { this.store.setSetting(prefix + keyOf(record.session), record); return record; }
  start() {
    this.wasRestart = Boolean(this.store.getSetting('service-started')) || Boolean(this.store.db.prepare('SELECT 1 FROM snapshots LIMIT 1').get());
    this.store.setSetting('service-started', { bootId: this.bootId, startedAt: this.startedAt });
    const sessions = new Map();
    for (const row of this.store.db.prepare('SELECT data FROM snapshots').all()) {
      const sample = JSON.parse(row.data); if (sample.session) sessions.set(keyOf(sample.session), sample.session);
    }
    for (const p of this.store.policies()) sessions.set(keyOf(p.session), { ...sessions.get(keyOf(p.session)), ...p.session });
    for (const c of this.store.activeCycles()) sessions.set(keyOf(c.session), c.session);
    const queued = this.store.db.prepare("SELECT target_key,data FROM outbox WHERE status<>'done'").all();
    for (const row of queued) { const s = JSON.parse(row.data).to; if (s) sessions.set(row.target_key, s); }
    for (const session of sessions.values()) {
      const runtime = this.store.getSnapshot(session)?.runtime;
      this.save({ id: randomUUID(), bootId: this.bootId, session, revision: 1, status: 'watching', work: [],
        baselineHead: headOf(runtime) || null, baselineActive: ['running', 'waiting_permission', 'waiting_input'].includes(runtime?.activity),
        watching: true, createdAt: this.startedAt });
      const cycle = this.store.activeCycle(session);
      if (cycle) this.require(session, 'maintenance:' + cycle.id, '接续上下文维护');
      const quota = this.store.getSetting('quota-recovery:' + keyOf(session));
      if (resumableQuota(quota)) this.require(session, 'quota:' + (quota.eventId || quota.turnId), '额度恢复后接续原任务');
      else if (runtime?.quota) this.require(session, 'quota:' + runtime.quota.turnId, '核对额度中断并接续');
      if (queued.some(row => row.target_key === keyOf(session))) this.require(session, 'queue', '恢复此前保留的消息队列');
    }
  }
  require(session, workKey, label) {
    let record = this.get(session);
    if (!record || record.bootId !== this.bootId) record = { id: randomUUID(), bootId: this.bootId, session, revision: 0, work: [], watching: false, createdAt: this.startedAt };
    if (record.work.some(w => w.key === workKey)) return record;
    return this.save({ ...record, session: { ...record.session, ...session }, revision: record.revision + 1,
      status: 'pending', work: [...record.work, { key: workKey, label }] });
  }
  observe(session, runtime) {
    if (!this.wasRestart) return;
    const key = keyOf(session), first = !this.seen.has(key); this.seen.add(key);
    let record = this.get(session);
    if (!runtime?.connected || ['offline', 'unloaded', 'initializing', 'unknown'].includes(runtime.activity) || runtime.quotaRestart?.pending) {
      if (first && !record) this.save({ id: randomUUID(), bootId: this.bootId, session, revision: 1, work: [], status: 'watching', watching: true, createdAt: this.startedAt });
      return;
    }
    if (record?.work.some(w => w.key.startsWith('quota:')) && !runtime.quota && headOf(runtime)) {
      const work = record.work.filter(w => !w.key.startsWith('quota:')
        || w.key === 'quota:' + headOf(runtime) && runtime.activity !== 'idle');
      if (work.length !== record.work.length) record = this.save({ ...record, work, revision: record.revision + 1,
        status: work.length ? record.status : 'resolved' });
    }
    const watching = record?.watching || first;
    if (runtime.quota && watching) {
      record = this.require(session, 'quota:' + runtime.quota.turnId, '额度恢复后接续原任务');
      this.save({ ...record, watching: false }); return;
    }
    if (record?.watching) {
      // Keep watching a pre-shutdown turn that is still running: it can fail
      // after the manager reconnects. A new input retires that old watch.
      const keep = record.baselineActive && headOf(runtime) === record.baselineHead && ['running', 'waiting_permission', 'waiting_input'].includes(runtime.activity);
      if (!keep) this.save({ ...record, watching: false });
    }
  }
  blocks(session) { const r = this.get(session); return r?.bootId === this.bootId && ['pending', 'deferred'].includes(r.status); }
  canDrain(key) {
    const r = this.get(key);
    if (!r || r.bootId !== this.bootId || !r.work.length) return true;
    return !this.blocks(key) && this.seen.has(key) && this.store.getSnapshot(r.session)?.runtime?.connected === true;
  }
  assertAllowed(session) { if (this.blocks(session)) throw Error('项目已重启，请先在“待确认接续”中确认此会话。'); }
  list() {
    return this.store.db.prepare('SELECT data FROM settings WHERE key LIKE ?').all(prefix + '%').map(row => JSON.parse(row.data))
      .filter(r => r.bootId === this.bootId && ['pending', 'deferred'].includes(r.status))
      .map(r => ({ id: r.id, bootId: r.bootId, revision: r.revision, status: r.status, session: r.session, work: r.work,
        connected: this.store.getSnapshot(r.session)?.runtime?.connected === true }));
  }
  decide({ bootId, items, action }) {
    return this.store.transaction(() => {
      this.store.assertManager();
      if (bootId !== this.bootId || !['approve', 'defer'].includes(action) || !Array.isArray(items) || !items.length
        || new Set(items.map(i => i.id)).size !== items.length) throw Error('接续确认已过期或格式不正确，请刷新后重试。');
      const pending = this.list(), records = items.map(item => {
        const found = pending.find(r => r.id === item.id && r.revision === item.revision);
        if (!found) throw Error('待接续事项已改变，请刷新后重新确认。');
        return this.get(found.session);
      });
      for (const r of records) this.save({ ...r, status: action === 'approve' ? 'approved' : 'deferred', revision: r.revision + 1,
        decidedAt: new Date().toISOString() });
      if (action === 'approve') for (const r of records) {
        const key = 'quota-recovery:' + keyOf(r.session), quota = this.store.getSetting(key);
        if (quota?.state === 'waiting') this.store.setSetting(key, { ...quota, nextCheckAt: null });
      }
      this.store.event('restart_confirmation', { bootId, action, ids: records.map(r => r.id) });
      return this.list();
    });
  }
}
