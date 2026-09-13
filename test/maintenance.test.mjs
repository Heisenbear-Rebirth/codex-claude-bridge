import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ManagementStore } from '../src/management-store.mjs';
import { SessionMailbox } from '../src/session-mailbox.mjs';
import { CheckpointService } from '../src/checkpoint-service.mjs';
import { MaintenanceController } from '../src/maintenance-controller.mjs';

async function harness(t, wasWorking = false, delayedInterrupt = false, recoveryEvidence) {
  const root = await mkdtemp(join(resolve('.'), '.maintenance-test-'));
  const store = await new ManagementStore(join(root, '.cooperation')).init();
  const target = { client: 'claude', id: '11111111-1111-4111-8111-111111111111', cwd: root, name: 'fixture' };
  let count = 0, compactCount = 0, interruptCount = 0;
  const delivered = [];
  const state = { connected: true, activity: wasWorking ? 'running' : 'idle', activeTurnId: wasWorking ? 'original' : null,
    sessionId: target.id, cwd: root, instanceId: 'fixture-instance', activityRevision: 1, model: 'fixed', permissionMode: 'original', queuedNativeInputs: 0, backgroundTasks: 0,
    capabilities: { readActivity: true, interrupt: true, sendControl: true, compact: true, observeCompletion: true } };
  const usage = { usedTokens: 600, contextWindowTokens: 1000, contextEpoch: 0 };
  const runtime = {
    async status() { return structuredClone(state); },
    async sendControl(text) { const id = 'control-' + (++count); state.activity = 'running'; state.activeTurnId = id; delivered.push(text); return { status: 'submitted', activeTurnId: id, requestId: id }; },
    async interrupt() { interruptCount++; if (!delayedInterrupt) { state.activity = 'idle'; state.lastCompletedTurnId = state.activeTurnId; state.activeTurnId = null; } return { status: 'acknowledged' }; },
    async compact() { compactCount++; usage.contextEpoch++; usage.usedTokens = 100; state.lastCompletedTurnId = 'compact-' + compactCount;
      return { status: 'completed', requestId: state.lastCompletedTurnId, completedAt: new Date().toISOString(), boundary: { trigger: 'manual' } }; }, close() {},
  };
  const monitor = { sample: async () => ({ runtime: structuredClone(state), usage: { ...usage }, decision: { trigger: wasWorking ? 'hard' : 'soft', wasWorkingAtTrigger: wasWorking } }), runtime: () => runtime, close() {} };
  const service = { adapters: { claude: { find: async () => target } }, mailbox: new SessionMailbox({ store,
    deliverMessage: async m => { delivered.push(m.text); return { status: 'submitted' }; }, deliverResume: async () => { delivered.push('continue'); return { status: 'submitted' }; } }) };
  const controller = new MaintenanceController({ root, store, service, monitor, recoveryEvidence });
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

test('shutdown waits for the active observation despite later timer ticks', async t => {
  let began, release, monitorClosed = false;
  const started = new Promise(resolve => { began = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const controller = new MaintenanceController({ root: resolve('.'), intervalMs: 2,
    store: { activeCycles: () => [], policies: () => [], event() {} }, service: {},
    monitor: { async observeAll() { began(); await gate; return new Map(); }, close() { monitorClosed = true; } },
  });
  t.after(async () => { release(); await controller.close(); });
  controller.start();
  // Keep the test alive while the controller's unref'ed interval starts.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await started;
    const active = controller.tickPromise;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(controller.tickPromise, active);
    const closing = controller.close();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(monitorClosed, false);
    release(); await closing;
    assert.equal(monitorClosed, true);
  } finally { clearTimeout(keepAlive); }
});

test('a Claude HTTP timeout keeps polling and restores after the same compaction completes late', async t => {
  const h = await harness(t), id = h.cycle.id, c = h.store.cycle(id);
  await mkdir(dirname(c.handoffPath), { recursive: true }); await writeFile(c.handoffPath, 'context');
  await h.receipt('handoff'); h.endTurn(); await h.controller.advance(id);
  const compact = h.runtime.compact; let completion;
  h.runtime.compact = async () => {
    const previous = h.state.lastCompletedTurnId;
    completion = await compact();
    h.state.activity = 'running'; h.state.activeTurnId = completion.requestId;
    h.state.lastCompletedTurnId = previous; h.state.compactionRequestId = completion.requestId;
    return { status: 'unknown', requestId: completion.requestId, sessionId: h.target.id };
  };
  await h.controller.advance(id); assert.equal(h.store.cycle(id).state, 'compacting');
  await h.controller.advance(id); assert.equal(h.store.cycle(id).state, 'compacting');
  assert.equal(h.compactCount(), 1); assert.equal(h.delivered.length, 1);
  h.state.activity = 'idle'; h.state.activeTurnId = null; h.state.compactionRequestId = null;
  h.state.lastCompletedTurnId = completion.requestId; h.state.lastCompaction = completion;
  await h.controller.advance(id); await h.controller.advance(id);
  assert.equal(h.store.cycle(id).state, 'restoring'); assert.equal(h.delivered.length, 2);
  assert.equal(h.store.cycle(id).compactResult.status, 'completed');
  await h.receipt('restored'); h.endTurn(); await h.controller.advance(id);
  assert.equal(h.store.cycle(id).state, 'completed'); assert.equal(h.compactCount(), 1);
});

test('late compaction reconciliation rejects another request or a newer native turn', async t => {
  const h = await harness(t), id = h.cycle.id, c = h.store.cycle(id);
  await mkdir(dirname(c.handoffPath), { recursive: true }); await writeFile(c.handoffPath, 'context');
  await h.receipt('handoff'); h.endTurn(); await h.controller.advance(id); await h.controller.advance(id);
  const completion = h.store.cycle(id).compactResult;
  h.store.updateCycle(id, 'needs_attention', { previousState: 'compacting', compactResult: { status: 'unknown', requestId: completion.requestId } });
  h.state.lastCompaction = { ...completion, requestId: 'different-request' };
  await assert.rejects(h.controller.reconcile(id), /没有足够/);
  h.state.lastCompaction = completion; h.state.lastCompletedTurnId = 'newer-native-turn';
  await assert.rejects(h.controller.reconcile(id), /没有足够/);
  assert.equal(h.store.cycle(id).state, 'needs_attention'); assert.equal(h.compactCount(), 1);
  h.state.lastCompletedTurnId = completion.requestId;
  await h.controller.reconcile(id);
  assert.equal(h.store.cycle(id).state, 'restoring'); assert.equal(h.compactCount(), 1);
});


test('hard maintenance waits for original native completion after interrupt acknowledgment before sending a visible prompt', async t => {
  const h = await harness(t, true, true), id = h.cycle.id;
  assert.equal(h.interruptCount(), 1); assert.equal(h.delivered.length, 0);
  await h.controller.advance(id); await h.controller.advance(id);
  assert.equal(h.state.activity, 'running'); assert.equal(h.delivered.length, 0); assert.equal(h.interruptCount(), 1);
  h.endTurn(); await h.controller.advance(id);
  assert.equal(h.delivered.length, 0);
  await h.controller.advance(id);
  assert.equal(h.delivered.length, 1); assert.ok(h.delivered[0].includes('context_checkpoint'));
  assert.equal(h.compactCount(), 0);
});


async function reconnect(h, instance = 'restarted') {
  h.state.instanceId = instance; h.state.activity = 'idle'; h.state.activeTurnId = null;
  h.state.lastCompletedTurnId = null; h.state.activityRevision++;
  h.controller.recoveryPollAt.clear(); await h.controller.advance(h.cycle.id);
}
test('offline maintenance pauses its deadline and keeps queued messages until the same client returns', async t => {
  const h=await harness(t), id=h.cycle.id;
  h.state.connected=false; h.store.updateCycle(id,h.store.cycle(id).state,{deadlineAt:new Date(0).toISOString()});
  await h.controller.advance(id); assert.equal(h.store.cycle(id).state,'waiting_client');
  assert.equal(h.store.activeCycle(h.target).id,id); assert.equal(h.compactCount(),0);
  h.state.connected=true; h.controller.recoveryPollAt.clear(); await h.controller.advance(id);
  assert.equal(h.store.cycle(id).state,'writing_handoff'); assert.equal(h.delivered.length,1);
});
test('new Claude instance retries only the unfinished maintenance prompt once', async t => {
  let lastInputId='control-1';
  const h=await harness(t,false,false,async()=>({verified:true,lastInputId,source:'fixture'}));
  await reconnect(h); assert.equal(h.store.cycle(h.cycle.id).controlDispatched,false);
  assert.equal(h.delivered.length,1); await h.controller.advance(h.cycle.id);
  assert.equal(h.delivered.length,2); assert.equal(h.interruptCount(),0); assert.equal(h.compactCount(),0);
  await h.controller.advance(h.cycle.id); assert.equal(h.delivered.length,2);
});
test('accepted handoff survives a new instance without resending or compacting twice', async t => {
  const h=await harness(t,false,false,async()=>({verified:true,lastInputId:'control-1',source:'fixture'}));
  const c=h.store.cycle(h.cycle.id); await mkdir(dirname(c.handoffPath),{recursive:true});await writeFile(c.handoffPath,'unchanged document');
  await h.receipt('handoff'); await reconnect(h);
  assert.equal(h.store.cycle(c.id).state,'awaiting_handoff_end');
  await h.controller.advance(c.id);await h.controller.advance(c.id);
  assert.equal(h.compactCount(),1);assert.equal(h.delivered.length,1);
});
test('late handoff receipt is accepted while waiting for reconnection', async t => {
  const h=await harness(t),c=h.store.cycle(h.cycle.id);await mkdir(dirname(c.handoffPath),{recursive:true});await writeFile(c.handoffPath,'doc');
  h.state.connected=false;await h.controller.advance(c.id);
  assert.equal(h.store.cycle(c.id).state,'waiting_client');
  assert.equal((await h.receipt('handoff')).status,'accepted');
  assert.equal(h.store.cycle(c.id).state,'awaiting_handoff_end');
});
test('new business input never auto-resumes or triggers another prompt', async t => {
  const h=await harness(t,false,false,async()=>({verified:true,lastInputId:'new-business-input',source:'fixture'}));
  await reconnect(h);assert.equal(h.store.cycle(h.cycle.id).state,'needs_attention');assert.equal(h.store.cycle(h.cycle.id).recoveryBlocked,true);
  await h.controller.advance(h.cycle.id);assert.equal(h.delivered.length,1);
});
test('restored receipt after restart releases FIFO and continues only after verified idle boundary', async t => {
  let lastInputId='control-1';
  const h=await harness(t,true,false,async()=>({verified:true,lastInputId,source:'fixture'})),id=h.cycle.id;
  await h.controller.advance(id);await h.controller.advance(id);
  const c=h.store.cycle(id);await mkdir(dirname(c.handoffPath),{recursive:true});await writeFile(c.handoffPath,'doc');
  await h.receipt('handoff');h.endTurn();await h.controller.advance(id);await h.controller.advance(id);await h.controller.advance(id);await h.controller.advance(id);
  await h.receipt('restored');lastInputId=h.store.cycle(id).controlTurnId;
  await h.service.mailbox.send({id:randomUUID(),createdAt:new Date().toISOString(),from:{...h.target,client:'codex'},to:h.target,text:'queued-after-restore'});
  await reconnect(h);assert.equal(h.store.cycle(id).state,'awaiting_restore_end');
  await h.controller.advance(id);assert.equal(h.store.cycle(id).state,'completed');
  assert.deepEqual(h.delivered.slice(-2),['continue','queued-after-restore']);assert.equal(h.compactCount(),1);
});


test('changed document and changed selected settings block restart recovery', async t => {
  const h=await harness(t,false,false,async()=>({verified:true,lastInputId:'control-1',source:'fixture'}));
  const c=h.store.cycle(h.cycle.id);await mkdir(dirname(c.handoffPath),{recursive:true});await writeFile(c.handoffPath,'before');await h.receipt('handoff');
  await writeFile(c.handoffPath,'changed');await reconnect(h);
  assert.equal(h.store.cycle(c.id).recoveryBlocked,true);assert.equal(h.compactCount(),0);
});
test('a known model change never triggers an automatic resend after restart',async t=>{
  const h=await harness(t,false,false,async()=>({verified:true,lastInputId:'control-1'}));
  h.state.model='different';await reconnect(h);assert.equal(h.store.cycle(h.cycle.id).recoveryBlocked,true);assert.equal(h.delivered.length,1);
});
test('a receipt arriving during recovery evidence read is not overwritten',async t=>{
  let accept;
  const h=await harness(t,false,false,async()=>{await accept();return {verified:true,lastInputId:'control-1'};});
  const c=h.store.cycle(h.cycle.id);await mkdir(dirname(c.handoffPath),{recursive:true});await writeFile(c.handoffPath,'doc');accept=()=>h.receipt('handoff');
  await reconnect(h);assert.equal(h.store.cycle(c.id).state,'awaiting_handoff_end');assert.equal(h.delivered.length,1);
});


test('Codex instance recovery uses the native completed turn ID and retains accepted handoff',async t=>{
  const h=await harness(t,false,false,async()=>({verified:true,lastInputId:'control-1',terminal:true,source:'codex-native-head'}));
  const c=h.store.cycle(h.cycle.id);await mkdir(dirname(c.handoffPath),{recursive:true});await writeFile(c.handoffPath,'doc');await h.receipt('handoff');
  h.store.updateCycle(c.id,'awaiting_handoff_end',{session:{...c.session,client:'codex'}});
  h.state.latestTurn={id:'control-1',status:'completed',itemTypes:['userMessage']};
  await reconnect(h);assert.equal(h.store.cycle(c.id).state,'awaiting_handoff_end');
  await h.controller.advance(c.id);assert.equal(h.store.cycle(c.id).state,'compacting');assert.equal(h.delivered.length,1);
});
test('missing or unknown completion after new instance stops compaction rather than repeating it',async t=>{
  const h=await harness(t,false,false,async()=>({verified:true,lastInputId:'compact-unknown',compactCompleted:false,source:'fixture'}));
  const c=h.store.cycle(h.cycle.id);await mkdir(dirname(c.handoffPath),{recursive:true});await writeFile(c.handoffPath,'doc');await h.receipt('handoff');
  h.store.updateCycle(c.id,'compacting',{compactDispatched:true,compactIntentAt:new Date().toISOString()});
  await reconnect(h);assert.equal(h.store.cycle(c.id).recoveryBlocked,true);assert.equal(h.compactCount(),0);
});
