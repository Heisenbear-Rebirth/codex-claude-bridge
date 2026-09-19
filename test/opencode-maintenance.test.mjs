import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID, randomInt } from 'node:crypto';
import { createOpenCodeBridge, nativeMessageId } from '../src/opencode-bridge.mjs';
import { createOpenCodeAdapter } from '../src/adapters/opencode.mjs';
import { startServer } from '../src/http-server.mjs';
import { readRestartEvidence, restartPlan } from '../src/maintenance-recovery.mjs';

async function fixture(t, { working = false } = {}) {
  const parent = resolve('.cooperation/opencode-maintenance-tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-'));
  await mkdir(join(root, '.cooperation')); await writeFile(join(root, '.cooperation/session-lifecycle-cancelled.json'), '{}');
  const session = { id: 'ses_MaintenanceCaseABC123', directory: root, agent: 'build', model: { id: 'actual', providerID: 'fixture', variant: 'high' }, permission: [{ permission: '*', pattern: '*', action: 'ask' }] };
  const target = { id: session.id, client: 'opencode', cwd: root }, rows = [], calls = [], permission = [], children = [];
  let bridge, manager, busy = false, compactions = 0, interrupts = 0, losePrompt = false, failCompact = false, hangCompact = false, releaseCompact;
  const user = (id = nativeMessageId(), parts = [{ type: 'text', text: 'business' }]) => {
    const row = { info: { id, sessionID: session.id, role: 'user', agent: session.agent,
      model: { providerID: 'fixture', modelID: 'actual', variant: 'high' }, time: { created: Date.now() } }, parts };
    rows.push(row); return row;
  };
  const assistant = (parent, total = 0, summary = false) => {
    const row = { info: { id: nativeMessageId(), sessionID: session.id, role: 'assistant', parentID: parent.info.id, agent: 'build', providerID: 'fixture', modelID: 'actual', summary,
      time: { created: Date.now() }, tokens: { total, input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] };
    rows.push(row); busy = true; return row;
  };
  const finish = (total = 100) => {
    const row = rows.findLast(r => r.info.role === 'assistant');
    row.info.time.completed = Date.now(); row.info.finish = 'stop'; row.info.tokens = { total, input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }; busy = false;
    return row;
  };
  assistant(user(), working ? 850 : 600); finish(working ? 850 : 600); busy = working;
  const client = { session: {
    get: async () => ({ data: session }), list: async () => ({ data: [session] }),
    status: async () => ({ data: busy ? { [session.id]: { type: 'busy' } } : {} }),
    children: async () => ({ data: children }),
    messages: async ({ query } = {}) => ({ data: structuredClone(query?.limit ? rows.slice(-query.limit) : rows) }),
    message: async ({ path }) => ({ data: structuredClone(rows.find(r => r.info.id === path.messageID)) }),
    promptAsync: async ({ body }) => {
      calls.push(structuredClone(body)); const row = { info: { id: body.messageID, sessionID: session.id, role: 'user', agent: body.agent || 'build', model: { ...body.model, variant: body.variant }, time: { created: Date.now() } }, parts: body.parts };
      await bridge.beforeMessage({ sessionID: session.id }, { message: row.info, parts: row.parts });
      rows.push(row); bridge.event({ event: { type: 'message.updated', properties: { info: row.info } } }); assistant(row);
      if (losePrompt) throw Error('transport lost'); return { response: { ok: true, status: 204 } };
    },
    abort: async () => { interrupts++; busy = false; const last = finish(850); last.info.error = { name: 'MessageAbortedError' }; return { data: true }; },
    summarize: async ({ body }) => {
      assert.equal(body.auto, false); assert.deepEqual({ providerID: body.providerID, modelID: body.modelID }, { providerID: 'fixture', modelID: 'actual' });
      compactions++; const row = assistant(user(nativeMessageId(), [{ type: 'compaction', auto: false }]), 900, true);
      if (hangCompact) await new Promise(done => { releaseCompact = done; });
      finish(900); if (failCompact) row.info.error = { name: 'APIError' };
      return { data: true };
    },
  }, _client: { get: async ({ url }) => ({ data: url === '/permission' ? permission : [] }) },
  config: { providers: async () => ({ data: { providers: [{ id: 'fixture', models: { actual: { limit: { context: 1000 } } } }] } }) } };
  const connect = async () => { bridge = await createOpenCodeBridge({ client, directory: root }, { root, acceptUserMessages: true, maintenanceHooks: true }); return bridge; };
  await connect(); const adapter = createOpenCodeAdapter({ root });
  const start = async () => { manager = await startServer({ root, port: randomInt(20000, 65000), adapters: { opencode: adapter }, startMonitoring: false }); return manager; };
  await start();
  t.after(async () => { releaseCompact?.(); await manager.close(); await bridge.close(); await rm(root, { recursive: true, force: true }); });
  const policy = manager.store.savePolicy(target, { enabled: true, mode: 'automatic' });
  const begin = async () => {
    const sample = await manager.monitor.sample(target); assert.equal(sample.decision.action, 'trigger');
    return manager.controller.trigger(target, policy, sample);
  };
  const receipt = async (cycleId, stage, overrides = {}) => {
    const cycle = manager.store.cycle(cycleId), tokens = manager.store.getSetting('cycle-tokens:' + cycleId);
    if (stage === 'handoff') { await mkdir(dirname(cycle.handoffPath), { recursive: true }); await writeFile(cycle.handoffPath, '# Handoff\nKeep the original task and constraints.'); }
    return JSON.parse(await bridge.checkpoint({ cycleId, stage, receiptToken: tokens[stage], documentPath: cycle.handoffPath, ...overrides },
      { sessionID: session.id, messageID: rows.findLast(r => r.info.role === 'assistant').info.id, directory: root, abort: new AbortController().signal }));
  };
  const advanceTo = async (id, state) => {
    for (let i = 0; i < 20; i++) { if (manager.store.cycle(id).state === state) return; await manager.controller.advance(id); await new Promise(setImmediate); }
    assert.equal(manager.store.cycle(id).state, state, manager.store.cycle(id).reason);
  };
  return { root, session, target, rows, calls, client, adapter, children, permission, user, assistant, finish, begin, receipt, advanceTo, start, connect,
    get bridge() { return bridge; }, get manager() { return manager; }, get busy() { return busy; }, set busy(value) { busy = value; },
    counts: () => ({ compactions, interrupts }), lose: () => { losePrompt = true; }, fail: () => { failCompact = true; },
    hang: () => { hangCompact = true; }, release: () => releaseCompact?.() };
}

for (const working of [false, true]) test(`OpenCode ${working ? 'hard' : 'soft'} full maintenance uses native receipts, compacts once and resumes conditionally`, async t => {
  const f = await fixture(t, { working }), cycle = await f.begin(), id = cycle.id;
  await f.advanceTo(id, 'writing_handoff'); await f.manager.controller.advance(id);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].agent, 'build'); assert.equal(f.calls[0].variant, 'high'); assert.equal(f.calls[0].tools, undefined);
  const queued = await f.manager.service.mailbox.send({ id: randomUUID(), createdAt: new Date().toISOString(), from: { ...f.target, client: 'codex' }, to: f.target, text: 'queued work' });
  assert.equal(queued.status, 'queued');
  assert.equal((await f.receipt(id, 'handoff')).status, 'accepted');
  await f.manager.controller.advance(id); assert.equal(f.counts().compactions, 0);
  f.finish(650); await f.advanceTo(id, 'restoring'); await f.manager.controller.advance(id);
  assert.equal(f.calls.length, 2); assert.equal(f.counts().compactions, 1);
  assert.equal((await f.receipt(id, 'restored')).status, 'accepted');
  await f.manager.controller.advance(id); assert.equal(f.manager.store.cycle(id).state, 'awaiting_restore_end');
  f.finish(100); await f.advanceTo(id, 'completed');
  assert.equal(f.calls.length, working ? 4 : 3);
  if (working) assert.match(f.calls[2].parts[0].text, /维护已完成/);
  assert.match(f.calls.at(-1).parts[0].text, /queued work/);
  assert.deepEqual(f.counts(), { interrupts: Number(working), compactions: 1 });
});

test('OpenCode refuses forged checkpoint provenance and receipts from another native control turn', async t => {
  const f = await fixture(t), c = await f.begin(), token = f.manager.store.getSetting('cycle-tokens:' + c.id).handoff;
  await assert.rejects(f.manager.checkpoints.accept({ from: f.target, cycleId: c.id, stage: 'handoff', receiptToken: token, documentPath: c.handoffPath }), /原生工具/);
  await assert.rejects(f.receipt(c.id, 'handoff', { receiptToken: 'wrong' }), /回执被拒绝/);
  f.assistant(f.user());
  await assert.rejects(f.receipt(c.id, 'handoff'), /回执被拒绝/);
  await f.manager.controller.advance(c.id); assert.equal(f.manager.store.cycle(c.id).state, 'user_intervened');
  assert.equal(f.counts().compactions, 0);
});

test('OpenCode successful HTTP compaction with a native summary error never restores or repeats', async t => {
  const f = await fixture(t); f.fail(); const c = await f.begin();
  await f.receipt(c.id, 'handoff'); f.finish(); await f.advanceTo(c.id, 'needs_attention');
  assert.equal(f.counts().compactions, 1); assert.equal(f.calls.length, 1);
  await f.manager.controller.advance(c.id); assert.equal(f.counts().compactions, 1);
});

test('OpenCode late compaction completion remains owned by the plugin and is recovered after manager restart', async t => {
  const f = await fixture(t); f.hang(); const c = await f.begin();
  await f.receipt(c.id, 'handoff'); f.finish(); await f.advanceTo(c.id, 'compacting'); await f.manager.controller.advance(c.id);
  assert.equal(f.counts().compactions, 1); await f.manager.close(); await f.start();
  f.release();
  for (let i = 0; i < 20 && f.busy; i++) await new Promise(setImmediate);
  await f.manager.controller.reconcile(c.id);
  await f.advanceTo(c.id, 'restoring');
  assert.equal(f.counts().compactions, 1);
});

test('OpenCode uncertain prompt delivery is reconciled without a second submission, including plugin restart', async t => {
  const f = await fixture(t); f.lose();
  const runtime = f.manager.monitor.runtime(f.target), expected = await runtime.status();
  const args = { kind: 'prompt', requestId: randomUUID(), messageId: nativeMessageId(), text: 'test control', expected };
  const first = await f.adapter.control(f.target.id, args); assert.equal(first.status, 'unknown');
  const second = await f.adapter.control(f.target.id, args); assert.equal(second.status, 'submitted'); assert.equal(f.calls.length, 1);
  await f.bridge.close(); await f.connect();
  const next = await runtime.status();
  // A new instance refuses a stale caller snapshot before attempting any write.
  assert.equal((await f.adapter.control(f.target.id, args)).status, 'state_conflict');
  assert.notEqual(next.instanceId, expected.instanceId); assert.equal(f.calls.length, 1);
});

test('OpenCode late authenticated receipts resolve a lost control response without replaying either stage', async t => {
  const f = await fixture(t); f.lose(); const c = await f.begin();
  assert.equal(c.state, 'writing_handoff'); assert.equal(f.calls.length, 1);
  await f.receipt(c.id, 'handoff'); f.finish(); await f.advanceTo(c.id, 'restoring'); await f.manager.controller.advance(c.id);
  assert.equal(f.calls.length, 2); await f.receipt(c.id, 'restored'); f.finish(); await f.advanceTo(c.id, 'completed');
  assert.equal(f.calls.length, 2); assert.equal(f.counts().compactions, 1);
});

test('OpenCode persisted compaction evidence survives plugin replacement and restores without a second compact', async t => {
  const f = await fixture(t), c = await f.begin();
  await f.receipt(c.id, 'handoff'); f.finish(); await f.advanceTo(c.id, 'compacting'); await f.manager.controller.advance(c.id);
  await f.bridge.close(); await f.connect();
  await f.advanceTo(c.id, 'restoring');
  assert.equal(f.counts().compactions, 1);
  assert.ok(f.manager.store.cycle(c.id).compactResult.nativeMessageId);
  await f.manager.controller.advance(c.id); await f.receipt(c.id, 'restored'); f.finish(); await f.advanceTo(c.id, 'completed');
});

test('OpenCode compaction epoch survives recent-history truncation and a later business turn can trigger maintenance', async t => {
  const f = await fixture(t), c = await f.begin();
  await f.receipt(c.id, 'handoff'); f.finish(); await f.advanceTo(c.id, 'restoring'); await f.manager.controller.advance(c.id);
  await f.receipt(c.id, 'restored'); f.finish(100); await f.advanceTo(c.id, 'completed');
  const epoch = (await f.manager.monitor.sample(f.target)).usage.contextEpoch;
  assert.notEqual(epoch, 'initial');
  for (let i = 0; i < 110; i++) { f.assistant(f.user()); f.finish(600); }
  await f.bridge.close(); await f.connect();
  const sample = await f.manager.monitor.sample(f.target);
  assert.equal(sample.usage.contextEpoch, epoch); assert.equal(sample.decision.action, 'trigger');
});

test('OpenCode native permissions, children, revert and changed settings prevent maintenance controls', async t => {
  const f = await fixture(t), runtime = f.manager.monitor.runtime(f.target), state = await runtime.status();
  f.permission.push({ sessionID: f.target.id });
  assert.equal((await f.manager.monitor.sample(f.target)).decision.action, 'wait');
  assert.equal((await runtime.sendControl('must not run', state)).status, 'state_conflict'); f.permission.length = 0;
  f.children.push({ id: 'ses_ChildABC123' });
  assert.equal((await runtime.compact(state)).status, 'state_conflict'); f.children.length = 0;
  f.session.model.variant = 'low';
  assert.equal((await runtime.sendControl('must not run', state)).status, 'state_conflict');
  f.session.model.variant = 'high'; f.session.revert = { messageID: f.rows[0].info.id };
  assert.equal((await runtime.compact(await runtime.status())).status, 'state_conflict');
  assert.equal(f.calls.length, 0); assert.equal(f.counts().compactions, 0);
});

test('OpenCode user input arriving before a native interrupt wins the revision check and is preserved', async t => {
  const f = await fixture(t, { working: true }), runtime = f.manager.monitor.runtime(f.target), expected = await runtime.status();
  const original = f.client.session.messages; let inject = true, inputFinished;
  f.client.session.messages = async () => {
    if (inject) {
      inject = false; const info = { id: nativeMessageId(), sessionID: f.target.id, role: 'user', time: { created: Date.now() } };
      inputFinished = f.bridge.beforeMessage({ sessionID: f.target.id }, { message: info }).then(() => { f.user(info.id); });
    }
    return original();
  };
  assert.equal((await runtime.interrupt(expected)).status, 'state_conflict'); await inputFinished;
  assert.equal(f.counts().interrupts, 0); assert.equal(f.rows.filter(r => r.info.role === 'user').length, 2);
});

test('OpenCode recovery preserves case-sensitive native IDs and never automatically resends an unreceipted control', async () => {
  const cycle = { session: { client: 'opencode' }, state: 'writing_handoff', controlDispatched: true, controlTurnId: 'msg_ABC' };
  const sample = { runtime: { activity: 'idle', latestTurn: { id: 'msg_ABC', status: 'completed' } } };
  const evidence = await readRestartEvidence(cycle, sample);
  assert.equal(evidence.verified, true); assert.equal(restartPlan(cycle, evidence).action, 'attention');
  assert.equal(restartPlan(cycle, { ...evidence, lastInputId: 'msg_abc' }, { handoff: {} }).action, 'attention');
});
