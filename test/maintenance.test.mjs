import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ManagementStore } from '../src/management-store.mjs';
import { SessionMailbox } from '../src/session-mailbox.mjs';
import { CheckpointService } from '../src/checkpoint-service.mjs';
import { MaintenanceController } from '../src/maintenance-controller.mjs';

async function harness(t, wasWorking = false) {
  const root = await mkdtemp(join(resolve('.'), '.maintenance-test-'));
  const store = await new ManagementStore(join(root, '.cooperation')).init();
  const target = { client: 'claude', id: '11111111-1111-4111-8111-111111111111', cwd: root, name: 'fixture' };
  let count = 0, compactCount = 0, interruptCount = 0;
  const delivered = [];
  const state = { connected: true, activity: wasWorking ? 'running' : 'idle', activeTurnId: wasWorking ? 'original' : null,
    instanceId: 'fixture-instance', activityRevision: 1, model: 'fixed', permissionMode: 'original', queuedNativeInputs: 0, backgroundTasks: 0,
    capabilities: { readActivity: true, interrupt: true, sendControl: true, compact: true, observeCompletion: true } };
  const usage = { usedTokens: 600, contextWindowTokens: 1000, contextEpoch: 0 };
  const runtime = {
    async status() { return structuredClone(state); },
    async sendControl(text) { const id = 'control-' + (++count); state.activity = 'running'; state.activeTurnId = id; delivered.push(text); return { status: 'submitted', activeTurnId: id, requestId: id }; },
    async interrupt() { interruptCount++; state.activity = 'idle'; state.lastCompletedTurnId = state.activeTurnId; state.activeTurnId = null; return { status: 'acknowledged' }; },
    async compact() { compactCount++; usage.contextEpoch++; usage.usedTokens = 100; state.lastCompletedTurnId = 'compact-' + compactCount;
      return { status: 'completed', requestId: state.lastCompletedTurnId, completedAt: new Date().toISOString(), boundary: { trigger: 'manual' } }; }, close() {},
  };
  const monitor = { sample: async () => ({ runtime: structuredClone(state), usage: { ...usage }, decision: { trigger: wasWorking ? 'hard' : 'soft', wasWorkingAtTrigger: wasWorking } }), runtime: () => runtime, close() {} };
  const service = { adapters: { claude: { find: async () => target } }, mailbox: new SessionMailbox({ store,
    deliverMessage: async m => { delivered.push(m.text); return { status: 'submitted' }; }, deliverResume: async () => { delivered.push('continue'); return { status: 'submitted' }; } }) };
  const controller = new MaintenanceController({ root, store, service, monitor });
  const checkpoints = new CheckpointService({ root, store });
  t.after(async () => { await controller.close(); await service.mailbox.close(); store.close(); assert.ok(root.startsWith(resolve('.') + '\\') || root.startsWith(resolve('.') + '/')); await rm(root, { recursive: true, force: true }); });
  const policy = { enabled: true, softPercent: 50, hardPercent: 80, mode: 'automatic' };
  const cycle = await controller.trigger(target, policy, await monitor.sample());
  const endTurn = () => { state.lastCompletedTurnId = state.activeTurnId; state.activeTurnId = null; state.activity = 'idle'; };
  const receipt = async stage => {
    const c = store.cycle(cycle.id); const tokens = store.getSetting('cycle-tokens:' + c.id);
    return checkpoints.accept({ from: target, cycleId: c.id, stage, receiptToken: tokens[stage], documentPath: c.handoffPath });
  };
  return { root, store, target, state, runtime, controller, checkpoints, service, cycle, delivered, endTurn, receipt,
    compactCount: () => compactCount, interruptCount: () => interruptCount };
}
for (const working of [false, true]) test(`two-phase ${working ? 'hard-running' : 'soft-idle'} maintenance waits for both control turns, preserves FIFO and resumes conditionally`, async t => {
  const h = await harness(t, working); const id = h.cycle.id;
  if (working) { assert.equal(h.interruptCount(), 1); await h.controller.advance(id); await h.controller.advance(id); }
  const cycle = h.store.cycle(id);
  assert.equal(cycle.state, 'writing_handoff');
  await mkdir(dirname(cycle.handoffPath), { recursive: true }); await writeFile(cycle.handoffPath, '# Context\nKeep constraints and next steps.');
  const incoming = text => h.service.mailbox.send({ id: randomUUID(), createdAt: new Date().toISOString(), from: { ...h.target, client: 'codex' }, to: h.target, text });
  assert.equal((await incoming('first-message')).status, 'queued');
  assert.equal((await h.receipt('handoff')).status, 'accepted');
  assert.equal((await h.receipt('handoff')).duplicate, true);
  await h.controller.advance(id); assert.equal(h.compactCount(), 0); // ACK tool has not returned / its turn is still active.
  h.endTurn(); await h.controller.advance(id); await h.controller.advance(id); assert.equal(h.compactCount(), 1);
  await h.controller.advance(id); await h.controller.advance(id); assert.equal(h.store.cycle(id).state, 'restoring');
  assert.equal((await incoming('second-message')).status, 'queued');
  assert.equal(h.delivered.includes('first-message'), false);
  await h.receipt('restored'); await h.controller.advance(id); assert.equal(h.delivered.includes('first-message'), false);
  h.endTurn(); await h.controller.advance(id);
  assert.equal(h.store.cycle(id).state, 'completed');
  assert.deepEqual(h.delivered.slice(2), working ? ['continue', 'first-message', 'second-message'] : ['first-message', 'second-message']);
  assert.equal(h.compactCount(), 1);
});

test('receipt rejects a different session, wrong stage, wrong token and changed document', async t => {
  const h = await harness(t); const cycle = h.store.cycle(h.cycle.id); const tokens = h.store.getSetting('cycle-tokens:' + cycle.id);
  await mkdir(dirname(cycle.handoffPath), { recursive: true }); await writeFile(cycle.handoffPath, 'original');
  const request = { from: h.target, cycleId: cycle.id, stage: 'handoff', receiptToken: tokens.handoff, documentPath: cycle.handoffPath };
  await assert.rejects(h.checkpoints.accept({ ...request, from: { ...h.target, id: 'different' } }), /发送方/);
  await assert.rejects(h.checkpoints.accept({ ...request, stage: 'restored', receiptToken: tokens.restored }), /阶段/);
  await assert.rejects(h.checkpoints.accept({ ...request, receiptToken: 'wrong' }), /凭证/);
  await h.checkpoints.accept(request); h.endTurn(); await h.controller.advance(cycle.id); await h.controller.advance(cycle.id); await h.controller.advance(cycle.id); await h.controller.advance(cycle.id);
  await writeFile(cycle.handoffPath, 'modified'); await assert.rejects(h.receipt('restored'), /内容不一致/);
  assert.equal(h.store.activeCycle(h.target).id, cycle.id);
});
test('native user intervention leaves the lock and queue for the user to resolve', async t => {
  const h = await harness(t); h.state.activeTurnId = 'new-native-user-turn';
  await h.controller.advance(h.cycle.id); assert.equal(h.store.cycle(h.cycle.id).state, 'user_intervened');
  assert.equal(h.compactCount(), 0);
  assert.equal(h.store.activeCycle(h.target).id, h.cycle.id);
});
test('a finished control turn without its receipt requires attention; explicit retry reuses the existing lock', async t => {
  const h = await harness(t); h.endTurn(); await h.controller.advance(h.cycle.id);
  assert.equal(h.store.cycle(h.cycle.id).state, 'needs_attention'); assert.equal(h.compactCount(), 0);
  await h.controller.retry(h.cycle.id);
  assert.equal(h.store.cycle(h.cycle.id).state, 'writing_handoff');
  assert.equal(h.store.activeCycle(h.target).id, h.cycle.id); assert.equal(h.compactCount(), 0);
});
test('reconciliation resumes a confirmed compaction without sending another compact command', async t => {
  const h = await harness(t); const id = h.cycle.id, cycle = h.store.cycle(id);
  await mkdir(dirname(cycle.handoffPath), { recursive: true }); await writeFile(cycle.handoffPath, 'context');
  await h.receipt('handoff'); h.endTurn(); await h.controller.advance(id); await h.controller.advance(id);
  assert.equal(h.compactCount(), 1);
  h.store.updateCycle(id, 'needs_attention', { previousState: 'compacting', reason: 'simulated restart' });
  await h.controller.reconcile(id);
  assert.equal(h.store.cycle(id).state, 'restoring'); assert.equal(h.compactCount(), 1);
  assert.equal(h.store.cycle(id).compactDispatched, true);
  h.endTurn(); await h.controller.advance(id); await h.controller.retry(id);
  assert.equal(h.compactCount(), 1); assert.equal(h.store.cycle(id).compactDispatched, true);
});
