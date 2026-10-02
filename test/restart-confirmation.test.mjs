import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ManagementStore, sessionKey } from '../src/management-store.mjs';
import { QuotaRecovery, quotaSettingKey } from '../src/quota-recovery.mjs';
import { publicClaudeQuota } from '../src/quota-state.mjs';
import { openCodeHead } from '../src/opencode-maintenance.mjs';
import { evaluatePolicy } from '../src/context-policy.mjs';

async function fixture(t, client = 'claude') {
  const root = await mkdtemp(join(resolve('.cooperation'), 'consent-test-'));
  let store = await new ManagementStore(join(root, '.cooperation')).init(); store.acquireManager();
  const session = { client, id: randomUUID(), name: 'Original session', cwd: root };
  const runtime = { sessionId: session.id, cwd: root, connected: true, instanceId: 'same-native', activity: 'idle', activityRevision: 1,
    latestTurn: { id: 'original', status: 'completed' }, lastCompletedTurnId: 'original', model: 'fixed', effort: 'high', permissionMode: 'ask', capabilities: { automaticMaintenance: true } };
  store.savePolicy(session, { enabled: true, mode: 'automatic', session }); store.saveSnapshot(session, { session, runtime: structuredClone(runtime) });
  const sample = () => { const s = { session, runtime: structuredClone(runtime) }; store.saveSnapshot(session, s); return s; };
  const reboot = async () => { store.close(); store = await new ManagementStore(join(root, '.cooperation')).init(); store.acquireManager(); };
  const queue = () => store.admit({ id: randomUUID(), createdAt: new Date().toISOString(), from: { ...session, client: 'codex' }, to: session, text: 'retained' });
  const decide = (action = 'approve', items = store.restartConfirmation.list()) => store.restartConfirmation.decide({
    bootId: store.restartConfirmation.bootId, items: items.map(({ id, revision }) => ({ id, revision })), action });
  t.after(async () => { store.close(); assert.ok(root.startsWith(resolve('.cooperation') + sep)); await rm(root, { recursive: true, force: true }); });
  return { root, session, runtime, sample, reboot, queue, decide, get store() { return store; }, get gate() { return store.restartConfirmation; } };
}

for (const client of ['codex', 'claude', 'opencode']) test(`${client}: prior queue needs boot-scoped consent, which may precede the client connection`, async t => {
  const h = await fixture(t, client), message = h.queue(); await h.reboot(); const key = sessionKey(h.session);
  assert.equal(h.store.claimNext(key), null); assert.equal(h.gate.list().length, 1);
  h.decide('defer'); assert.equal(h.store.claimNext(key), null); assert.equal(h.gate.list()[0].status, 'deferred');
  h.decide(); assert.equal(h.store.claimNext(key), null, 'old connected snapshot is not a current connection');
  h.runtime.connected = false; h.runtime.activity = 'offline'; h.sample(); assert.equal(h.store.claimNext(key), null);
  h.runtime.connected = true; h.runtime.activity = 'idle'; h.sample();
  const item = h.store.claimNext(key); assert.equal(item.id, message.id); h.store.finishOutbox(item.id, { status: 'submitted' });
  assert.equal(h.store.claimNext(key), null);
  h.queue(); await h.reboot(); assert.equal(h.store.claimNext(key), null); assert.equal(h.gate.list().length, 1);
});

test('consent is atomic, rejects stale boot/revision or duplicate selections, and does not authorize newly discovered work', async t => {
  const h = await fixture(t); h.queue(); await h.reboot(); const old = h.gate.list();
  h.gate.require(h.session, 'quota:new-failure', '额度恢复后继续');
  assert.throws(() => h.decide('approve', old), /改变/); assert.equal(h.gate.blocks(h.session), true);
  assert.throws(() => h.decide('approve', [h.gate.list()[0], h.gate.list()[0]]), /格式/);
  const previousBoot = h.gate.bootId; h.decide(); assert.equal(h.gate.blocks(h.session), false);
  h.gate.require(h.session, 'maintenance:new-cycle', '接续维护'); assert.equal(h.gate.blocks(h.session), true);
  await h.reboot(); assert.throws(() => h.gate.decide({ bootId: previousBoot, items: old, action: 'approve' }), /过期/);
});

test('defer survives page refresh and a subsequent service boot asks again without dropping queued data', async t => {
  const h = await fixture(t); const message = h.queue(); await h.reboot(); h.decide('defer');
  const saved = h.gate.list(); assert.equal(saved[0].status, 'deferred'); assert.deepEqual(h.gate.list(), saved);
  await h.reboot(); assert.equal(h.gate.list()[0].status, 'pending'); assert.equal(h.store.getMessage(message.id).text, 'retained');
});

for (const client of ['codex', 'claude']) for (const timing of ['failure-before-stop', 'failure-while-manager-off', 'failure-after-reconnect'])
  test(`${client}: ${timing} quota continuation waits for confirmation and submits at most once`, async t => {
    const h = await fixture(t, client); let sent = 0;
    const fail = () => { Object.assign(h.runtime, { activity: 'quota_limited', activeTurnId: null, latestTurn: { id: 'original', status: 'failed' },
      quota: { turnId: 'original', kind: 'usage_limit', autoResume: true } }); };
    if (timing === 'failure-before-stop') { fail(); h.sample(); }
    else { Object.assign(h.runtime, { activity: 'running', activeTurnId: 'original', latestTurn: { id: 'original', status: 'inProgress' } }); h.sample(); }
    await h.reboot();
    if (timing === 'failure-after-reconnect') h.sample(); fail();
    const adapter = { status: async () => structuredClone(h.runtime), quota: async () => publicClaudeQuota({ rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 1 }, seven_day: { utilization: 1 } } }),
      resumeQuota: async (text, state, options) => { assert.equal(options.canDispatch(), true); sent++; return { status: 'submitted', activeTurnId: 'continued' }; } };
    const monitor = { runtime: () => adapter };
    const recovery = new QuotaRecovery({ root: h.root, store: h.store, monitor, service: { adapters: { [client]: { find: async () => h.session } } },
      readCodex: async () => ({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 1 }, secondary: { usedPercent: 1 } } } }), pollMs: 0 });
    const handle = () => recovery.handle(h.session, h.store.getPolicy(h.session), h.sample());
    await handle(); assert.equal(sent, 0); assert.equal(h.gate.list().length, 1);
    h.decide('defer'); await handle(); assert.equal(sent, 0);
    h.decide(); await handle(); await handle(); assert.equal(sent, 1);
    assert.equal(h.store.getSetting(quotaSettingKey(h.session)).state, 'submitted'); recovery.close();
  });

test('new normal work after reconnection retires the startup watch; its later quota failure is handled normally', async t => {
  const h = await fixture(t); await h.reboot(); h.sample();
  h.runtime.activity = 'quota_limited'; h.runtime.quota = { turnId: 'new-turn', autoResume: true }; h.runtime.latestTurn = { id: 'new-turn', status: 'failed' }; h.sample();
  assert.equal(h.gate.list().length, 0);
});

test('a native completion or new user input retires obsolete quota consent without releasing uncertain outbox', async t => {
  const h = await fixture(t); h.runtime.quota = { turnId: 'original', autoResume: true }; h.runtime.activity = 'quota_limited'; h.sample();
  const message = h.queue(); h.store.db.prepare("UPDATE outbox SET status='sending' WHERE id=?").run(message.id); await h.reboot();
  h.decide(); h.runtime.quota = null; h.runtime.activity = 'idle'; h.runtime.latestTurn = { id: 'new-input', status: 'completed' }; h.sample();
  assert.equal(h.store.claimNext(sessionKey(h.session)), null); assert.equal(h.store.getMessage(message.id).status, 'unknown');
});

test('OpenCode structured 429 on the current ended turn holds maintenance; prose, past failures and native retries do not become quota proof', () => {
  const session = { id: 'ses_Example123', model: { id: 'model', providerID: 'fixture' } }, rows = [
    { info: { id: 'msg_1', sessionID: session.id, role: 'user', time: { created: 1 } }, parts: [] },
    { info: { id: 'msg_2', sessionID: session.id, role: 'assistant', parentID: 'msg_1', time: { created: 2, completed: 3 }, error: { name: 'APIError', data: { statusCode: 429, message: 'private' } } }, parts: [] },
  ];
  const state = openCodeHead(session, rows, { type: 'idle' });
  assert.equal(state.activity, 'quota_limited'); assert.equal(state.quota.autoResume, false); assert.equal(JSON.stringify(state.quota).includes('private'), false);
  assert.equal(evaluatePolicy({ policy: { enabled: true, mode: 'automatic' }, runtime: state }).action, 'wait_quota');
  assert.equal(openCodeHead(session, rows, { type: 'retry' }).quota, null);
  rows[1].info.error.data.statusCode = 500; assert.equal(openCodeHead(session, rows, {}).quota, null);
  rows[1].info.error.data.statusCode = 429; rows.push({ info: { id: 'msg_3', sessionID: session.id, role: 'user', time: { created: 4 } }, parts: [] });
  assert.equal(openCodeHead(session, rows, { type: 'idle' }).quota, null);
});
