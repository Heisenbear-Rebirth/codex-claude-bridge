import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ManagementStore, sessionKey } from '../src/management-store.mjs';
import { SessionMailbox } from '../src/session-mailbox.mjs';
import { evaluatePolicy } from '../src/context-policy.mjs';
import { CooperationService } from '../src/service.mjs';

const project = resolve('.');
const sender = { client: 'codex', id: 'source-123', cwd: project, name: '原发送者' };
const recipient = { client: 'claude', id: 'target-123', cwd: project, name: '原接收者' };
const record = (text, to = recipient) => ({ id: randomUUID(), status: 'queued', createdAt: new Date().toISOString(), from: sender, to, text });
async function storeFixture(t) {
  const dir = await mkdtemp(join(project, '.management-test-')); const stores = [];
  const open = async () => { const s = await new ManagementStore(dir).init(); stores.push(s); return s; };
  t.after(async () => { for (const store of stores) store.close(); assert.ok(resolve(dir).startsWith(project + '\\') || resolve(dir).startsWith(project + '/')); await rm(dir, { recursive: true, force: true }); });
  return { dir, open, store: await open() };
}
test('legacy migration preserves exact text and identity snapshots, is idempotent, and rejects a changed source', async t => {
  const f = await storeFixture(t); const m = record('中文\n原文🙂'); m.status = 'submitted';
  const content = JSON.stringify({ type: 'created', message: m }) + '\n';
  await writeFile(join(f.dir, 'messages.jsonl'), content);
  const preview = await f.store.migrateLegacy({ dryRun: true }); assert.equal(preview.imported, 1); assert.equal(f.store.list().length, 0);
  const result = await f.store.migrateLegacy(); assert.equal(result.verificationHash, preview.verificationHash);
  assert.deepEqual(f.store.getMessage(m.id), m); assert.equal((await f.store.migrateLegacy()).alreadyImported, true);
  assert.equal(await readFile(join(f.dir, 'messages.jsonl'), 'utf8'), content);
  await writeFile(join(f.dir, 'messages.jsonl'), content + '{}\n'); await assert.rejects(f.store.migrateLegacy(), /变化/);
});
test('one manager per project and A policy changes do not alter B defaults', async t => {
  const f = await storeFixture(t); f.store.acquireManager(); const second = await f.open();
  assert.throws(() => second.acquireManager(), /已有管理服务/);
  assert.equal(f.store.savePolicy(sender).softPercent, 40);
  assert.equal(f.store.savePolicy(recipient).hardPercent, 80);
  f.store.savePolicy(sender, { softPercent: 30, hardPercent: 60 });
  assert.equal(f.store.getPolicy(recipient).softPercent, 50);
  assert.throws(() => f.store.savePolicy(sender, { softPercent: 99, hardPercent: 60 }));
});
test('a maintenance lock persists, new messages keep FIFO, and resume precedes queued messages', async t => {
  const f = await storeFixture(t); const cycle = f.store.createCycle({ session: recipient, state: 'writing_handoff' });
  const delivered = [];
  const mailbox = new SessionMailbox({ store: f.store, deliverMessage: async m => { delivered.push(m.text); return { status: 'submitted' }; }, deliverResume: async () => { delivered.push('continue'); return { status: 'submitted' }; } });
  t.after(() => mailbox.close());
  const first = await mailbox.send(record('one')); const second = await mailbox.send(record('two'));
  assert.equal(first.status, 'queued'); assert.equal(second.cycleId, cycle.id); assert.deepEqual(delivered, []);
  const reopened = await f.open(); assert.equal(reopened.activeCycle(recipient).id, cycle.id); assert.equal(reopened.queueCount(recipient), 2);
  f.store.releaseCycle(cycle.id, { resumeText: 'continue' });
  await Promise.all([mailbox.drain(sessionKey(recipient)), mailbox.send(record('three'))]);
  assert.deepEqual(delivered, ['continue', 'one', 'two', 'three']); assert.equal(f.store.queueCount(recipient), 0);
});
test('unknown delivery blocks only its recipient; restart never repeats its native send', async t => {
  const f = await storeFixture(t); let sent = 0;
  const mailbox = new SessionMailbox({ store: f.store, deliverMessage: async m => { sent++; return { status: m.to.id === recipient.id ? 'unknown' : 'submitted' }; } });
  t.after(() => mailbox.close());
  assert.equal((await mailbox.send(record('ambiguous'))).status, 'unknown');
  assert.equal((await mailbox.send(record('queued-after'))).status, 'queued');
  assert.equal((await mailbox.send(record('other', { ...recipient, id: 'other-123' }))).status, 'submitted');
  assert.equal(sent, 2);
  const reopened = await f.open(); assert.equal(reopened.claimNext(sessionKey(recipient)), null);
  assert.equal(reopened.list().length, 3);
});
test('a crash between dispatch and acknowledgement converts sending to unknown', async t => {
  const f = await storeFixture(t); const message = f.store.admit(record('will-be-uncertain'));
  f.store.claimNext(sessionKey(recipient)); f.store.close();
  const reopened = await f.open(); reopened.acquireManager();
  assert.equal(reopened.getMessage(message.id).status, 'unknown');
  assert.equal(reopened.claimNext(sessionKey(recipient)), null);
});
test('cross-directory message union and overlapping directory discovery deduplicate sessions', async t => {
  const f = await storeFixture(t); const child = join(f.dir, 'child');
  const { mkdir } = await import('node:fs/promises'); await mkdir(child);
  const session = { ...sender, cwd: child, updatedAt: '2026-09-07' };
  const service = new CooperationService({ store: f.store, adapters: { codex: { list: async () => ({ sessions: [session], warnings: [] }) } } });
  const result = await service.sessions({ directories: [{ id: 'root', path: f.dir, recursive: true }, { id: 'child', path: child }] });
  assert.equal(result.sessions.length, 1); assert.deepEqual(result.sessions[0].directoryIds, ['root', 'child']);
  f.store.create(record('cross', { ...recipient, cwd: child }));
  assert.equal(f.store.list({ directories: [{ path: child }] }).length, 1);
});
test('policy uses exact token ratios and rechecks soft threshold when active becomes idle', () => {
  for (const [client, soft, hard] of [['codex', 40, 55], ['claude', 50, 80]]) {
    const policy = { client, enabled: true, softPercent: soft, hardPercent: hard };
    const decide = (percent, activity) => evaluatePolicy({ policy, runtime: { connected: true, activity }, usage: { usedTokens: percent * 100, contextWindowTokens: 10000 } });
    assert.equal(decide(soft - 0.01, 'idle').action, 'monitor');
    assert.equal(decide(soft, 'running').action, 'monitor');
    assert.equal(decide(soft, 'idle').trigger, 'soft');
    assert.equal(decide(hard - 0.01, 'running').action, 'monitor');
    assert.equal(decide(hard, 'running').trigger, 'hard');
    assert.equal(decide(hard, 'waiting_permission').wasWorkingAtTrigger, true);
    assert.equal(decide(hard, 'unknown').action, 'wait');
  }
});
test('held messages prevent newer arrivals overtaking the retained queue', async t => {
  const f = await storeFixture(t); const cycle = f.store.createCycle({ session: recipient, state: 'writing_handoff' });
  f.store.admit(record('old')); f.store.releaseCycle(cycle.id, { cancel: true, releaseMessages: false });
  f.store.admit(record('new')); assert.equal(f.store.claimNext(sessionKey(recipient)), null);
  f.store.releaseHeld(recipient); const first = f.store.claimNext(sessionKey(recipient));
  assert.equal(f.store.getMessage(first.messageId).text, 'old'); f.store.finishOutbox(first.id, { status: 'submitted' });
  const second = f.store.claimNext(sessionKey(recipient)); assert.equal(f.store.getMessage(second.messageId).text, 'new');
});
