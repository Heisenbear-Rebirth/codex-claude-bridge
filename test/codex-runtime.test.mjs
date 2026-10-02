import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { CodexIpc } from '../src/runtime/codex-ipc.mjs';
import { CodexRuntime, projectCodexState, permissionSelection, samePermissionSelection } from '../src/runtime/codex-runtime.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ManagementStore } from '../src/management-store.mjs';
import { CooperationService } from '../src/service.mjs';
import { MaintenanceController } from '../src/maintenance-controller.mjs';
import { PromptSettings } from '../src/prompt-settings.mjs';
import { defaultPromptValues } from '../public/prompt-templates.mjs';
import { evaluatePolicy } from '../src/context-policy.mjs';
import { quotaSettingKey } from '../src/quota-recovery.mjs';

const sessionId = '11111111-1111-4111-8111-111111111111';
function state(status = 'idle', turnId = 'turn-one') {
  return { id: sessionId, cwd: 'E:/Projects/Cooperation', resumeState: 'resumed',
    latestModel: 'original-model', latestReasoningEffort: 'high', currentPermissions: { selection: 'original' },
    threadRuntimeStatus: { type: status, activeFlags: [] }, turns: [],
    turnHistory: { kind: 'canonical', history: { islands: [{ entries: [{ value: 'one' }] }], entitiesByKey: { one: {
      turnId, status: status === 'active' ? 'inProgress' : 'completed', items: [{ type: 'agentMessage', text: 'private-message-text' }],
    } } } }, requests: [] };
}
test('canonical runtime metadata drops all conversation text and classifies waiting or inconsistent states', () => {
  const source = state('active'); const projected = projectCodexState(source);
  assert.equal(projected.activeTurnId, 'turn-one'); assert.equal(projected.activity, 'running');
  assert.equal(JSON.stringify(projected).includes('private-message-text'), false);
  source.threadRuntimeStatus.activeFlags = ['waitingOnApproval'];
  assert.equal(projectCodexState(source).activity, 'waiting_permission');
  source.threadRuntimeStatus.activeFlags = ['waitingOnUserInput'];
  assert.equal(projectCodexState(source).activity, 'waiting_input');
  source.threadRuntimeStatus = { type: 'idle' }; assert.equal(projectCodexState(source).activity, 'unknown');
});
test('native visualization roots do not masquerade as a user permission change; other roots and policies remain significant', () => {
  const base = { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', runtimeWorkspaceRoots: ['E:/Project'], sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['E:/Project'], networkAccess: false } };
  const expanded = structuredClone(base);
  const generated = 'C:/User/.codex/visualizations/2026/09/07/' + sessionId;
  expanded.runtimeWorkspaceRoots.push(generated); expanded.sandboxPolicy.writableRoots.push(generated);
  assert.deepEqual(permissionSelection(base, sessionId, 'C:/User/.codex'), permissionSelection(expanded, sessionId, 'C:/User/.codex'));
  expanded.sandboxPolicy.writableRoots.push('E:/Other');
  assert.notDeepEqual(permissionSelection(base, sessionId, 'C:/User/.codex'), permissionSelection(expanded, sessionId, 'C:/User/.codex'));
  const changed = structuredClone(base); changed.approvalPolicy = 'never';
  assert.notDeepEqual(permissionSelection(base, sessionId), permissionSelection(changed, sessionId));
});
test('compaction effort is separate from the user thread selection', () => {
  const s = state(); s.latestReasoningEffort = 'minimal'; s.latestThreadSettings = { effort: 'high' };
  assert.equal(projectCodexState(s).effort, 'high'); assert.equal(projectCodexState(s).lastOperationEffort, 'minimal');
  s.latestThreadSettings.effort = 'low'; assert.equal(projectCodexState(s).effort, 'low');
});
test('workspaceWrite implicitly includes cwd; explicit materialization is equivalent without hiding other root changes', () => {
  const a = state(); a.currentPermissions = { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false } };
  const before = projectCodexState(a); a.currentPermissions.sandboxPolicy.writableRoots.push(a.cwd);
  const after = projectCodexState(a); assert.equal(before.permissionFingerprint, after.permissionFingerprint);
  assert.equal(samePermissionSelection({ permissionFingerprint: after.legacyPermissionFingerprints[1], permissionFingerprintBasis: 'permission-selection-excluding-native-visualization-root' }, after), true);
  a.currentPermissions.sandboxPolicy.writableRoots.push('E:/Other'); assert.equal(samePermissionSelection(before, projectCodexState(a)), false);
});

async function harness(t) {
  const requests = []; let current = state(), owner = 'native-owner'; const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let buffered = Buffer.alloc(0);
    const send = object => { const body = Buffer.from(JSON.stringify(object)); const size = Buffer.alloc(4); size.writeUInt32LE(body.length);
      const frame = Buffer.concat([size, body]); socket.write(frame.subarray(0, 3)); socket.write(frame.subarray(3)); };
    socket.on('data', bytes => {
      buffered = Buffer.concat([buffered, bytes]);
      while (buffered.length >= 4 && buffered.length >= buffered.readUInt32LE() + 4) {
        const length = buffered.readUInt32LE(); const frame = JSON.parse(buffered.subarray(4, length + 4)); buffered = buffered.subarray(length + 4);
        if (frame.type === 'request') {
          requests.push(frame);
          let result;
          if (frame.method === 'initialize') result = { clientId: 'independent-observer' };
          if (frame.method === 'thread-owner-discovery') result = {};
          if (frame.method === 'thread-follower-interrupt-turn') { result = { interruptedTurnId: frame.params.expectedTurnId }; current = state(); }
          if (frame.method === 'thread-follower-start-turn') { result = { result: { turn: { id: 'turn-two' } } };
            const next = state('active', 'turn-two'); current = { ...current, threadRuntimeStatus: next.threadRuntimeStatus, turnHistory: next.turnHistory }; }
          send({ type: 'response', requestId: frame.requestId, resultType: 'success', handledByClientId: owner, result });
        } else if (frame.type === 'broadcast' && frame.params.following) {
          const valid = { type: 'broadcast', sourceClientId: owner, method: 'thread-stream-state-changed', version: 11,
            params: { conversationId: sessionId, hostId: 'local', change: { type: 'snapshot', revision: 10, conversationState: current } } };
          send({ ...valid, sourceClientId: 'unrelated-owner', params: { ...valid.params, change: { type: 'snapshot', revision: 999, conversationState: state('active', 'wrong-turn') } } });
          send(valid);
        }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const makeRuntime = () => new CodexRuntime(sessionId, { ipc: new CodexIpc({ endpoint: { host: '127.0.0.1', port: server.address().port }, timeoutMs: 1000 }), timeoutMs: 1000 });
  const runtime = makeRuntime();
  t.after(async () => { runtime.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { runtime, requests, makeRuntime, setState: s => { current = s; }, restartNative: () => {
    owner = 'restarted-owner'; for (const socket of sockets) socket.destroy();
  } };
}

for (const order of ['manager-first', 'client-first']) test(`Codex IPC reconnect after ${order} restart continues the persisted failed turn once with original settings`, async t => {
  const h = await harness(t), root = await mkdtemp(join(resolve('.cooperation'), 'codex-restart-'));
  let store = await new ManagementStore(join(root, '.cooperation')).init(), controller;
  const target = { client: 'codex', id: sessionId, cwd: root };
  let used = 100;
  const native = state('idle', 'failed-before-restart'); native.cwd = root;
  Object.assign(native.turnHistory.history.entitiesByKey.one, { status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } }); h.setState(native);
  const monitor = { runtime: () => h.runtime, close() {}, sample: async () => ({ runtime: await h.runtime.status(), usage: {}, decision: {} }) };
  const start = () => {
    controller = new MaintenanceController({ root, store, monitor, service: { adapters: { codex: { find: async () => target } } } });
    controller.quotaRecovery.readCodex = async () => ({ rateLimits: { primary: { usedPercent: used } } });
  };
  t.after(async () => { await controller.close(); store.close(); assert.ok(root.startsWith(resolve('.cooperation') + sep)); await rm(root, { recursive: true, force: true }); });
  start(); store.savePolicy(target, { enabled: true, mode: 'automatic' }); await controller.tick();
  assert.equal(store.getSetting(quotaSettingKey(target)).state, 'waiting');
  await controller.close(); store.close();
  if (order === 'client-first') { h.restartNative(); await new Promise(resolve => setTimeout(resolve, 30)); }
  store = await new ManagementStore(join(root, '.cooperation')).init(); start();
  if (order === 'manager-first') { h.restartNative(); await new Promise(resolve => setTimeout(resolve, 30)); }
  used = 5; await controller.tick(); await controller.tick();
  assert.equal(store.getSetting(quotaSettingKey(target)).state, 'submitted');
  const starts = h.requests.filter(r => r.method === 'thread-follower-start-turn'); assert.equal(starts.length, 1);
  assert.equal(starts[0].targetClientId, 'restarted-owner'); assert.equal(starts[0].params.turnStart.context.inheritThreadSettings, true);
});
test('independent peer preserves native turn settings and refuses stale precise interruptions', async t => {
  const h = await harness(t); const idle = await h.runtime.status(); assert.equal(idle.activity, 'idle');
  const submitted = await h.runtime.sendControl('fixture text', idle); assert.equal(submitted.status, 'submitted');
  const sent = h.requests.find(r => r.method === 'thread-follower-start-turn');
  assert.deepEqual(Object.keys(sent.params.turnStart.request).sort(), ['input', 'threadId']);
  assert.equal(sent.params.turnStart.context.inheritThreadSettings, true);
  const active = await h.runtime.status(); assert.equal(active.activeTurnId, 'turn-two');
  h.setState(state('active', 'turn-three'));
  assert.equal((await h.runtime.interrupt(active)).status, 'state_conflict');
  assert.equal(h.requests.some(r => r.method === 'thread-follower-interrupt-turn'), false);
  const now = await h.runtime.status(); assert.equal((await h.runtime.interrupt(now)).status, 'acknowledged');
  const stopped = h.requests.find(r => r.method === 'thread-follower-interrupt-turn');
  assert.equal(stopped.params.expectedTurnId, 'turn-three'); assert.equal(stopped.version, 4);
  assert.equal(stopped.params.mode, 'descendant-cleanup');
  assert.equal(h.requests[0].sourceClientId, 'initializing-client');
  assert.equal(h.requests[1].sourceClientId, 'independent-observer');
});

test('quota continuation alone may start a limited native head and refuses raced user input while preserving native selections', async t => {
  const h = await harness(t), limited = state();
  limited.turnHistory.history.entitiesByKey.one.status = 'failed';
  limited.turnHistory.history.entitiesByKey.one.error = { codexErrorInfo: 'usageLimitExceeded' };
  h.setState(limited); const before = await h.runtime.status(); assert.equal(before.activity, 'quota_limited');
  assert.equal((await h.runtime.compact(before)).status, 'state_conflict');
  assert.equal((await h.runtime.sendControl('ordinary control', before)).status, 'state_conflict');
  const quota = { status: 'available', queriedAt: new Date().toISOString() };
  assert.equal((await h.runtime.resumeQuota('continue once', before, { quota, canDispatch: () => false })).status, 'state_conflict');
  h.setState(state('idle', 'new-human-turn'));
  assert.equal((await h.runtime.resumeQuota('continue once', before, { quota })).status, 'state_conflict');
  assert.equal(h.requests.some(r => r.method === 'thread-follower-start-turn'), false);
  h.setState(limited); const current = await h.runtime.status();
  assert.equal((await h.runtime.resumeQuota('continue once', current, { quota })).status, 'submitted');
  const sent = h.requests.find(r => r.method === 'thread-follower-start-turn');
  assert.equal(sent.params.turnStart.context.inheritThreadSettings, true);
  assert.deepEqual(Object.keys(sent.params.turnStart.request).sort(), ['input', 'threadId']);
});


test('old in-progress history does not block an idle head or hide the actual running turn', () => {
  const source = state();
  const history = source.turnHistory.history;
  history.islands[0].entries.unshift({ value: 'old' });
  history.entitiesByKey.old = { turnId: 'old-interrupted-turn', status: 'inProgress', items: [] };
  let snapshot = projectCodexState(source);
  assert.equal(snapshot.activity, 'idle'); assert.equal(snapshot.activeTurnId, null);
  assert.equal(snapshot.historicalInProgressTurns, 1);
  source.requests = [{ id: 'pending' }]; assert.equal(projectCodexState(source).activity, 'unknown'); source.requests = [];
  source.unconfirmedTurnSubmissions = [{}]; assert.equal(projectCodexState(source).activity, 'unknown'); source.unconfirmedTurnSubmissions = [];
  source.turns = [{ turnId: 'separate-live-turn', status: 'inProgress' }];
  assert.equal(projectCodexState(source).activity, 'unknown'); source.turns = [];
  history.entitiesByKey.one.status = 'inProgress';
  assert.equal(projectCodexState(source).activity, 'unknown');
  source.threadRuntimeStatus.type = 'active'; snapshot = projectCodexState(source);
  assert.equal(snapshot.activity, 'running'); assert.equal(snapshot.activeTurnId, 'turn-one');
  history.entitiesByKey.one.status = 'unexpected'; source.threadRuntimeStatus.type = 'idle';
  assert.equal(projectCodexState(source).activity, 'unknown');
});

test('Codex uses a newer legacy suffix linked to the canonical head, including quota errors and later successful turns', () => {
  const s = state(), old = s.turnHistory.history.entitiesByKey.one;
  s.turns = [structuredClone(old), { turnId: 'new-limit', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } }];
  let r = projectCodexState(s); assert.equal(r.latestTurn.id, 'new-limit'); assert.equal(r.activity, 'quota_limited');
  s.turnHistory.history.entitiesByKey.one = s.turns[1]; s.turns = [s.turns[1], { turnId: 'new-success', status: 'completed' }];
  r = projectCodexState(s); assert.equal(r.latestTurn.id, 'new-success'); assert.equal(r.quota, null); assert.equal(r.activity, 'idle');
});
test('Codex ambiguous mixed histories block compression and continuation until their order is established', () => {
  const s = state(); s.turns = [{ turnId: 'unlinked-limit', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } }];
  let r = projectCodexState(s); assert.equal(r.activity, 'unknown'); assert.equal(r.turnOrderUncertain, true);
  assert.equal(r.quota.turnId, 'unlinked-limit');
  assert.equal(evaluatePolicy({ runtime: r, policy: { enabled: true, softPercent: 40, hardPercent: 55 }, usage: { usedTokens: 99, contextWindowTokens: 100 } }).action, 'wait_quota');
  s.turnHistory.history.entitiesByKey.one = s.turns[0]; s.turns = [{ turnId: 'unlinked-success', status: 'completed' }];
  r = projectCodexState(s); assert.equal(r.activity, 'unknown'); assert.equal(r.turnOrderUncertain, true);
});
test('Codex dated mixed histories select the newer head and ignore older detached quota failures', () => {
  const s = state(); s.turnHistory.history.entitiesByKey.one.startedAt = 200;
  s.turns = [{ turnId: 'old-failure', status: 'failed', startedAt: 100, error: { codexErrorInfo: 'usageLimitExceeded' } }];
  assert.equal(projectCodexState(s).quota, null); assert.equal(projectCodexState(s).activity, 'idle');
  s.turns[0].startedAt = 300;
  assert.equal(projectCodexState(s).latestTurn.id, 'old-failure'); assert.equal(projectCodexState(s).activity, 'quota_limited');
});

test('Codex IPC and manager poll an ambiguous limited head, wait for synchronization, then continue once with native settings', async t => {
  const h = await harness(t), root = await mkdtemp(join(resolve('.cooperation'), 'codex-quota-sync-'));
  const store = await new ManagementStore(join(root, '.cooperation')).init();
  const target = { client: 'codex', id: sessionId, cwd: root };
  const source = state(); source.cwd = root;
  const failed = { turnId: 'pending-sync', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' }, items: [] };
  source.turns = [failed]; h.setState(source);
  let reads = 0, contextUsed = 99;
  const monitor = { runtime: () => h.runtime, close() {}, sample: async () => {
    const runtime = await h.runtime.status(), usage = { usedTokens: contextUsed, contextWindowTokens: 100 };
    return { session: target, runtime, usage, decision: evaluatePolicy({ runtime, usage, policy: store.getPolicy(target) }) };
  } };
  const controller = new MaintenanceController({ root, store, service: {}, monitor });
  controller.quotaRecovery.readCodex = async () => { reads++; return { rateLimits: { primary: { usedPercent: 5 } } }; };
  store.savePolicy(target, { enabled: true, mode: 'automatic' });
  t.after(async () => { await controller.close(); store.close(); assert.ok(root.startsWith(resolve('.cooperation') + sep)); await rm(root, { recursive: true, force: true }); });
  await controller.tick();
  let record = store.getSetting(quotaSettingKey(target)); assert.equal(record.state, 'waiting'); assert.equal(reads, 1);
  assert.match(record.reason, /轮次记录同步/);
  assert.equal(h.requests.some(r => ['thread-follower-start-turn', 'thread-follower-compact-thread'].includes(r.method)), false);
  source.turnHistory.history.entitiesByKey.one = failed; h.setState(source);
  store.setSetting(quotaSettingKey(target), { ...record, nextCheckAt: '2000-01-01T00:00:00Z' }); controller.quotaRecovery.codexNextRead = 0;
  await controller.tick(); record = store.getSetting(quotaSettingKey(target)); assert.equal(record.state, 'submitted');
  const starts = h.requests.filter(r => r.method === 'thread-follower-start-turn');
  assert.equal(starts.length, 1); assert.equal(starts[0].params.turnStart.context.inheritThreadSettings, true);
  // The fixture preserves legacy data; give its old completed head a timestamp
  // so the subsequent fresh turn is unambiguously newer.
  source.turnHistory.history.entitiesByKey.one = { turnId: 'after-continue', status: 'completed', startedAt: 300, items: [] };
  source.turns = [{ ...failed, startedAt: 100 }]; contextUsed = 10; h.setState(source);
  await controller.tick(); assert.equal(h.requests.filter(r => r.method === 'thread-follower-start-turn').length, 1);
  assert.equal((await h.runtime.status()).quota, null);
});

test('Claude peer to exhausted Codex: stale snapshot still defers, then native custom continuation precedes FIFO without changing settings', async t => {
  const h = await harness(t), root = await mkdtemp(join(resolve('.cooperation'), 'codex-peer-quota-'));
  const store = await new ManagementStore(join(root, '.cooperation')).init();
  const target = { client: 'codex', id: sessionId, cwd: root, name: 'receiver' }, sender = { client: 'claude', id: randomUUID(), cwd: root, name: 'sender' };
  let quotaUsed = 100, contextUsed = 10; const delivered = [];
  const native = (status, id) => { const value = state(status, id); value.cwd = root; return value; };
  h.setState(native('idle', 'before-peer'));
  const adapters = {
    claude: { find: async id => id === sender.id ? sender : null, list: async () => ({ sessions: [] }) },
    codex: { find: async id => id === target.id ? target : null, list: async () => ({ sessions: [target] }), send: async input => {
      delivered.push(input);
      const value = native(quotaUsed >= 100 ? 'idle' : 'active', input.messageId);
      if (quotaUsed >= 100) { value.turnHistory.history.entitiesByKey.one.status = 'failed';
        value.turnHistory.history.entitiesByKey.one.error = { codexErrorInfo: 'usageLimitExceeded' }; contextUsed = 99; }
      h.setState(value); return { status: 'submitted' };
    } },
  };
  const service = new CooperationService({ root, store, adapters, runtimeFactory: h.makeRuntime });
  const monitor = { runtime: () => h.runtime, close: () => h.runtime.close(), sample: async () => {
    const runtime = await h.runtime.status(), usage = { usedTokens: contextUsed, contextWindowTokens: 100, contextEpoch: 1 };
    const sample = { session: target, runtime, usage, decision: evaluatePolicy({ runtime, usage, policy: store.getPolicy(target) }) };
    store.saveSnapshot(target, sample); return sample;
  } };
  const controller = new MaintenanceController({ root, store, service, monitor });
  controller.quotaRecovery.readCodex = async () => ({ ordinaryUsageAllowed: true, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: quotaUsed, resetsAt: 1000 }, secondary: { usedPercent: 20, resetsAt: 2000 } },
  } });
  t.after(async () => { await controller.close(); await service.mailbox.close(); await service.lifecycle.close(); store.close();
    assert.ok(root.startsWith(resolve('.cooperation') + sep)); await rm(root, { recursive: true, force: true }); });
  store.savePolicy(target, { enabled: true, mode: 'automatic' });
  const values = defaultPromptValues(); values.maintenance.quotaContinue = '按已保存的提示词继续 Codex 原任务。'; await new PromptSettings(root).save(values, 0);
  await monitor.sample();
  const first = await service.send({ from: sender, to: 'codex:' + target.id, message: 'first' }); assert.equal(first.status, 'submitted');
  assert.equal((await h.runtime.status()).quota.turnId, first.messageId);
  const second = await service.send({ from: sender, to: 'codex:' + target.id, message: 'second' });
  const third = await service.send({ from: sender, to: 'codex:' + target.id, message: 'third' });
  assert.equal(second.status, 'queued'); assert.equal(third.status, 'queued'); assert.equal(delivered.length, 1);
  await controller.tick(); assert.equal(store.getSetting(quotaSettingKey(target)).state, 'waiting');
  assert.equal(h.requests.some(r => r.method === 'thread-follower-compact-thread'), false);
  quotaUsed = 5; contextUsed = 10;
  const record = store.getSetting(quotaSettingKey(target)); store.setSetting(quotaSettingKey(target), { ...record, nextCheckAt: '2000-01-01T00:00:00Z' }); controller.quotaRecovery.codexNextRead = 0;
  await controller.tick();
  const starts = h.requests.filter(r => r.method === 'thread-follower-start-turn');
  assert.equal(starts.length, 1); assert.equal(starts[0].params.turnStart.request.input[0].text, values.maintenance.quotaContinue);
  assert.equal(starts[0].params.turnStart.context.inheritThreadSettings, true);
  await monitor.sample(); await service.mailbox.flush();
  assert.deepEqual(delivered.map(m => m.messageId), [first.messageId, second.messageId, third.messageId]);
  const final = await h.runtime.status(); assert.equal(final.model, 'original-model'); assert.equal(final.effort, 'high');
  await controller.tick(); await service.mailbox.flush();
  assert.equal(h.requests.filter(r => r.method === 'thread-follower-start-turn').length, 1);
  assert.equal(delivered.length, 3); assert.equal(store.activeCycle(target), null);
});
