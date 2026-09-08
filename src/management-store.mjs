import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { POLICY_DEFAULTS, validatePolicy } from './context-policy.mjs';
import { matchesDirectories, containsDirectory } from './directory-service.mjs';

const json = value => JSON.stringify(value);
const parse = row => row ? JSON.parse(row.data) : null;
const now = () => new Date().toISOString();
export const sessionKey = s => `${s.hostId || 'local'}:${s.client}:${s.id || s.sessionId}`;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : json(value)).digest('hex');
const processAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

export class ManagementStore {
  constructor(directory) { this.directory = directory; this.file = join(directory, 'management.sqlite'); this.warnings = []; this.managerToken = null; }
  async init() {
    await mkdir(this.directory, { recursive: true });
    this.db = new DatabaseSync(this.file);
    if (this.db.prepare('PRAGMA user_version').get().user_version > 1) { this.db.close(); this.db = null; throw new Error('管理数据库版本高于当前程序，请使用匹配版本。'); }
    this.db.exec(`PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS manager (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, pid INTEGER NOT NULL, epoch INTEGER NOT NULL, started_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS directories (id TEXT PRIMARY KEY, normalized TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS policies (session_key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (session_key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mailboxes (session_key TEXT PRIMARY KEY, next_sequence INTEGER NOT NULL DEFAULT 0, locked_cycle TEXT, blocked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cycles (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS active_cycle_per_session ON cycles(session_key) WHERE state NOT IN ('completed','cancelled');
      CREATE TABLE IF NOT EXISTS checkpoints (cycle_id TEXT NOT NULL, stage TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(cycle_id,stage));
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, target_key TEXT NOT NULL, sequence INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, target_key TEXT NOT NULL, sequence INTEGER NOT NULL, priority INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS dispatch_order ON outbox(target_key,priority,sequence);
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
      PRAGMA user_version=1;`);
    return this;
  }
  transaction(fn) {
    if (this.transactionDepth) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.transactionDepth = 1;
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; } finally { this.transactionDepth = 0; }
  }
  event(type, data) { this.db.prepare('INSERT INTO events(type,at,data) VALUES(?,?,?)').run(type, now(), json(data)); }
  getSetting(key) { return parse(this.db.prepare('SELECT data FROM settings WHERE key=?').get(key)); }
  setSetting(key, value) { this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, json(value)); }
  acquireManager() {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM manager WHERE id=1').get();
      if (existing && processAlive(existing.pid)) throw new Error('此项目已有管理服务实例；请使用现有服务。');
      this.managerToken = randomUUID();
      this.db.prepare('INSERT INTO manager VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,pid=excluded.pid,epoch=excluded.epoch,started_at=excluded.started_at')
        .run(this.managerToken, process.pid, (existing?.epoch || 0) + 1, now());
      this.recoverInFlight(); return this.managerToken;
    });
  }
  assertManager() {
    if (this.managerToken && this.db.prepare('SELECT token FROM manager WHERE id=1').get()?.token !== this.managerToken) throw new Error('管理服务的所有权已改变。');
  }
  recoverInFlight() {
    for (const row of this.db.prepare("SELECT * FROM outbox WHERE status='sending'").all()) {
      this.finishOutbox(row.id, { status: 'unknown', error: '上次服务退出前未确认发送结果，请核对原会话。' });
    }
    for (const cycle of this.activeCycles()) {
      this.updateCycle(cycle.id, 'needs_attention', { previousState: ['needs_attention', 'user_intervened'].includes(cycle.state) ? cycle.previousState : cycle.state, reason: '服务重启，需核对上一次外部操作及原生轮次后继续。' });
    }
  }
  close() {
    if (!this.db) return;
    if (this.managerToken) this.db.prepare('DELETE FROM manager WHERE id=1 AND token=?').run(this.managerToken);
    this.db.close(); this.db = null;
  }
  get messages() { return new Map(this.db.prepare('SELECT id,data FROM messages').all().map(row => [row.id, parse(row)])); }
  getMessage(id) { return parse(this.db.prepare('SELECT data FROM messages WHERE id=?').get(id)); }
  create(message) {
    this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(message.id, sessionKey(message.to), message.sequence || 0, message.status, message.createdAt, json(message));
  }
  update(id, patch) {
    const message = this.getMessage(id); if (!message) throw new Error('消息不存在。');
    Object.assign(message, patch);
    this.db.prepare('UPDATE messages SET status=?,data=? WHERE id=?').run(message.status, json(message), id);
    return message;
  }
  list({ directories = [], directory = '', recursive = false, q = '', client = 'all' } = {}) {
    const scopes = directories.length ? directories : directory ? [{ path: directory, recursive }] : [];
    const query = String(q).toLocaleLowerCase();
    return this.db.prepare('SELECT data FROM messages ORDER BY created_at DESC').all().map(parse).filter(message => matchesDirectories(message, scopes)
      && (client === 'all' || message.from.client === client || message.to.client === client)
      && (!query || [message.text, message.from.displayAddress, message.to.displayAddress, message.id, message.error].some(v => String(v || '').toLocaleLowerCase().includes(query))));
  }
  directories() { return this.db.prepare('SELECT data FROM directories ORDER BY rowid').all().map(parse); }
  saveDirectory(directory) {
    const old = parse(this.db.prepare('SELECT data FROM directories WHERE normalized=?').get(directory.normalized));
    const record = { id: old?.id || directory.id || randomUUID(), label: directory.label || directory.path, recursive: false, enabled: true, ...old, ...directory };
    this.db.prepare('INSERT INTO directories VALUES(?,?,?) ON CONFLICT(normalized) DO UPDATE SET data=excluded.data').run(record.id, record.normalized, json(record));
    return record;
  }
  removeDirectory(id) {
    const directory = this.directories().find(d => d.id === id); if (!directory) return;
    const active = this.activeCycles().filter(c => containsDirectory(c.session.cwd, directory.path, directory.recursive));
    if (active.length) throw new Error('该目录有正在维护的会话，请先完成或取消维护。');
    this.db.prepare('DELETE FROM directories WHERE id=?').run(id);
  }
  getPolicy(session) { return parse(this.db.prepare('SELECT data FROM policies WHERE session_key=?').get(sessionKey(session))); }
  savePolicy(session, patch = {}) {
    const old = this.getPolicy(session);
    const policy = validatePolicy({ enabled: false, ...POLICY_DEFAULTS[session.client], session: { client: session.client, id: session.id, hostId: session.hostId || 'local' },
      mode: 'observe', usageBasis: 'full-context-window', ...old, ...patch, revision: (old?.revision || 0) + 1 });
    if (!['observe', 'automatic'].includes(policy.mode)) throw new Error('未知的管理模式。');
    this.db.prepare('INSERT INTO policies VALUES(?,?) ON CONFLICT(session_key) DO UPDATE SET data=excluded.data').run(sessionKey(session), json(policy));
    this.event('policy_saved', policy); return policy;
  }
  policies() { return this.db.prepare('SELECT data FROM policies').all().map(parse); }
  saveSnapshot(session, data) { this.db.prepare('INSERT INTO snapshots VALUES(?,?) ON CONFLICT(session_key) DO UPDATE SET data=excluded.data').run(sessionKey(session), json(data)); }
  getSnapshot(session) { return parse(this.db.prepare('SELECT data FROM snapshots WHERE session_key=?').get(sessionKey(session))); }
  mailbox(key) { this.db.prepare('INSERT OR IGNORE INTO mailboxes(session_key) VALUES(?)').run(key); return this.db.prepare('SELECT * FROM mailboxes WHERE session_key=?').get(key); }
  activeCycle(session) { return parse(this.db.prepare("SELECT data FROM cycles WHERE session_key=? AND state NOT IN ('completed','cancelled')").get(sessionKey(session))); }
  activeCycles() { return this.db.prepare("SELECT data FROM cycles WHERE state NOT IN ('completed','cancelled')").all().map(parse); }
  cycle(id) { return parse(this.db.prepare('SELECT data FROM cycles WHERE id=?').get(id)); }
  lastCycle(session) { return parse(this.db.prepare('SELECT data FROM cycles WHERE session_key=? ORDER BY rowid DESC LIMIT 1').get(sessionKey(session))); }
  createCycle(data) {
    return this.transaction(() => {
      this.assertManager(); const key = sessionKey(data.session); const box = this.mailbox(key);
      if (box.locked_cycle || box.blocked || this.db.prepare("SELECT 1 FROM outbox WHERE target_key=? AND status='sending'").get(key)) throw new Error('会话已有维护流程或未确认的投递。');
      const cycle = { ...data, id: data.id || randomUUID(), revision: 1, createdAt: now(), updatedAt: now() };
      this.db.prepare('INSERT INTO cycles VALUES(?,?,?,?)').run(cycle.id, key, cycle.state, json(cycle));
      this.db.prepare('UPDATE mailboxes SET locked_cycle=? WHERE session_key=?').run(cycle.id, key);
      this.event('cycle_created', { id: cycle.id, session: cycle.session, state: cycle.state }); return cycle;
    });
  }
  updateCycle(id, state, patch = {}, expectedRevision) {
    this.assertManager(); const current = this.cycle(id); if (!current) throw new Error('维护流程不存在。');
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error('维护流程版本已改变。');
    const next = { ...current, ...patch, state, revision: current.revision + 1, updatedAt: now() };
    this.db.prepare('UPDATE cycles SET state=?,data=? WHERE id=?').run(state, json(next), id);
    this.event('cycle_state', { id, state, revision: next.revision }); return next;
  }
  checkpoint(cycleId, stage) { return parse(this.db.prepare('SELECT data FROM checkpoints WHERE cycle_id=? AND stage=?').get(cycleId, stage)); }
  saveCheckpoint(cycleId, stage, receipt) { this.db.prepare('INSERT INTO checkpoints VALUES(?,?,?)').run(cycleId, stage, json(receipt)); this.event('checkpoint', { cycleId, stage, at: receipt.at }); }
  admit(message) {
    return this.transaction(() => {
      this.assertManager(); const key = sessionKey(message.to); const box = this.mailbox(key); const sequence = box.next_sequence + 1;
      this.db.prepare('UPDATE mailboxes SET next_sequence=? WHERE session_key=?').run(sequence, key);
      const saved = { ...message, sequence, status: 'queued', ...(box.locked_cycle ? { cycleId: box.locked_cycle, detail: '接收会话正在维护，消息已持久排队。' } : {}) };
      this.create(saved);
      this.db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').run(saved.id, key, sequence, 1, 'ready', json({ kind: 'message', messageId: saved.id, to: saved.to }));
      this.event('message_admitted', { id: saved.id, targetKey: key, sequence, cycleId: box.locked_cycle }); return saved;
    });
  }
  claimNext(key) {
    return this.transaction(() => {
      this.assertManager(); const box = this.mailbox(key); if (box.locked_cycle || box.blocked) return null;
      if (this.db.prepare("SELECT 1 FROM outbox WHERE target_key=? AND status='held'").get(key)) return null;
      if (this.db.prepare("SELECT 1 FROM outbox WHERE target_key=? AND status='sending'").get(key)) return null;
      const row = this.db.prepare("SELECT * FROM outbox WHERE target_key=? AND status='ready' ORDER BY priority,sequence LIMIT 1").get(key);
      if (!row) return null;
      this.db.prepare("UPDATE outbox SET status='sending' WHERE id=?").run(row.id);
      const data = parse(row); if (data.kind === 'message') this.update(data.messageId, { status: 'pending' });
      this.event('dispatch_intent', { id: row.id, targetKey: key }); return { id: row.id, targetKey: key, ...data };
    });
  }
  finishOutbox(id, result) {
    return this.transaction(() => {
    const row = this.db.prepare('SELECT * FROM outbox WHERE id=?').get(id); if (!row) throw new Error('出站记录不存在。');
    const data = parse(row); const uncertain = result.status === 'unknown';
    const resumeFailed = data.kind === 'resume' && result.status !== 'submitted';
    this.db.prepare('UPDATE outbox SET status=? WHERE id=?').run(uncertain ? 'unknown' : resumeFailed ? 'failed' : 'done', id);
    if (uncertain || resumeFailed) this.db.prepare('UPDATE mailboxes SET blocked=1 WHERE session_key=?').run(row.target_key);
    if (data.kind === 'message') this.update(data.messageId, { ...result, detail: result.detail || null, error: result.error || null, completedAt: now() });
    this.event('dispatch_result', { id, ...result });
    });
  }
  queueCount(session) { return this.db.prepare("SELECT count(*) AS n FROM outbox WHERE target_key=? AND status<>'done'").get(sessionKey(session)).n; }
  queueState(session) { return Object.fromEntries(this.db.prepare("SELECT status,count(*) AS n FROM outbox WHERE target_key=? AND status<>'done' GROUP BY status").all(sessionKey(session)).map(row => [row.status, row.n])); }
  resolveDelivery(id, outcome) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM outbox WHERE id=?').get(id);
      if (!row || !['unknown', 'failed'].includes(row.status) || !['submitted', 'not_submitted'].includes(outcome)) throw new Error('该出站记录不支持此确认操作。');
      this.db.prepare('UPDATE outbox SET status=? WHERE id=?').run(outcome === 'submitted' ? 'done' : 'ready', id);
      const item = parse(row);
      if (item.kind === 'message') this.update(item.messageId, { status: outcome === 'submitted' ? 'submitted' : 'queued',
        detail: outcome === 'submitted' ? '用户核对原会话后确认已提交。' : '用户确认未提交，允许重新投递。', error: null });
      const uncertain = this.db.prepare("SELECT 1 FROM outbox WHERE target_key=? AND status IN ('unknown','failed')").get(row.target_key);
      this.db.prepare('UPDATE mailboxes SET blocked=? WHERE session_key=?').run(uncertain ? 1 : 0, row.target_key);
      this.event('delivery_manually_resolved', { id, outcome }); return row.target_key;
    });
  }
  releaseHeld(session) {
    return this.transaction(() => {
      const key = sessionKey(session); if (this.mailbox(key).locked_cycle) throw new Error('该会话仍在维护，暂不能释放队列。');
      for (const row of this.db.prepare("SELECT id,data FROM outbox WHERE target_key=? AND status='held'").all(key)) {
        this.db.prepare("UPDATE outbox SET status='ready' WHERE id=?").run(row.id);
        const item = parse(row); if (item.kind === 'message') this.update(item.messageId, { status: 'queued', detail: '用户释放了保留的消息。' });
      }
      this.event('held_messages_released', { targetKey: key }); return key;
    });
  }
  readyTargets() { return this.db.prepare("SELECT DISTINCT target_key FROM outbox WHERE status='ready'").all().map(r => r.target_key); }
  releaseCycle(cycleId, { resumeText, cancel = false, releaseMessages = true } = {}) {
    return this.transaction(() => {
      this.assertManager(); const cycle = this.cycle(cycleId); if (!cycle) throw new Error('维护流程不存在。');
      const key = sessionKey(cycle.session); const box = this.mailbox(key);
      if (box.locked_cycle !== cycleId) throw new Error('会话锁与当前流程不一致。');
      if (resumeText) this.db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').run('continue:' + cycleId, key, 0, 0, 'ready', json({ kind: 'resume', text: resumeText, to: cycle.session, cycleId }));
      if (!releaseMessages) {
        for (const row of this.db.prepare("SELECT id,data FROM outbox WHERE target_key=? AND status='ready'").all(key)) {
          this.db.prepare("UPDATE outbox SET status='held' WHERE id=?").run(row.id);
          const item = parse(row); if (item.kind === 'message') this.update(item.messageId, { status: 'held', detail: '维护已取消；消息按用户选择保留，等待手动释放。' });
        }
      }
      this.updateCycle(cycleId, cancel ? 'cancelled' : 'completed', { completedAt: now(), resumed: Boolean(resumeText) });
      this.db.prepare('UPDATE mailboxes SET locked_cycle=NULL WHERE session_key=?').run(key); return cycle;
    });
  }
  async migrateLegacy({ dryRun = false } = {}) {
    const source = join(this.directory, 'messages.jsonl'); let content;
    try { content = await readFile(source, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { sourceFound: false, imported: 0 }; throw e; }
    const sourceHash = hash(content), old = this.getSetting('legacy_migration');
    if (old) { if (old.sourceHash !== sourceHash) throw new Error('旧 JSONL 在迁移后发生变化；请停止旧服务并核对两份记录。'); return { ...old, alreadyImported: true }; }
    const messages = new Map();
    for (const [index, line] of content.split('\n').entries()) {
      if (!line.trim()) continue;
      let event; try { event = JSON.parse(line); } catch { throw new Error(`旧日志第 ${index + 1} 行不完整；原文已保留，迁移未执行。`); }
      if (event.type === 'created' && event.message?.id) messages.set(event.message.id, event.message);
      else if (event.type === 'status' && messages.has(event.id)) Object.assign(messages.get(event.id), event.patch);
    }
    const verificationHash = hash([...messages.values()].map(m => ({ id: m.id, text: m.text, from: m.from, to: m.to, status: m.status })));
    const report = { sourceFound: true, sourceHash, verificationHash, imported: messages.size, at: now() };
    if (dryRun) return report;
    const backup = join(this.directory, 'backups', 'messages-' + sourceHash.slice(0, 16) + '.jsonl');
    await mkdir(join(this.directory, 'backups'), { recursive: true });
    try { await writeFile(backup, content, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (hash(await readFile(backup, 'utf8')) !== sourceHash) throw new Error('旧消息日志备份校验失败。');
    this.transaction(() => {
      for (const message of messages.values()) {
        const existing = this.getMessage(message.id);
        if (existing && hash(existing) !== hash(message)) throw new Error('迁移发现重复消息 ID 内容冲突。');
        if (!existing) this.create(message);
      }
      const imported = [...messages.keys()].map(id => this.getMessage(id));
      if (hash(imported.map(m => ({ id: m.id, text: m.text, from: m.from, to: m.to, status: m.status }))) !== verificationHash) throw new Error('迁移内容校验失败。');
      for (const message of imported.filter(m => m.status === 'pending')) this.update(message.id, { status: 'unknown', error: '迁移前未确认投递结果，不会自动重发。' });
      this.setSetting('legacy_migration', report); this.event('legacy_migrated', report);
    });
    return report;
  }
}
