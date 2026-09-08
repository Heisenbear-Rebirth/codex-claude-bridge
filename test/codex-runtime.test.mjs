import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { CodexIpc } from '../src/runtime/codex-ipc.mjs';
import { CodexRuntime, projectCodexState, permissionSelection, samePermissionSelection } from '../src/runtime/codex-runtime.mjs';

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
  const requests = []; let current = state(); const sockets = new Set();
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
          if (frame.method === 'thread-follower-start-turn') { result = { result: { turn: { id: 'turn-two' } } }; current = state('active', 'turn-two'); }
          send({ type: 'response', requestId: frame.requestId, resultType: 'success', handledByClientId: 'native-owner', result });
        } else if (frame.type === 'broadcast' && frame.params.following) {
          const valid = { type: 'broadcast', sourceClientId: 'native-owner', method: 'thread-stream-state-changed', version: 11,
            params: { conversationId: sessionId, hostId: 'local', change: { type: 'snapshot', revision: 10, conversationState: current } } };
          send({ ...valid, sourceClientId: 'unrelated-owner', params: { ...valid.params, change: { type: 'snapshot', revision: 999, conversationState: state('active', 'wrong-turn') } } });
          send(valid);
        }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const ipc = new CodexIpc({ endpoint: { host: '127.0.0.1', port: server.address().port }, timeoutMs: 1000 });
  const runtime = new CodexRuntime(sessionId, { ipc, timeoutMs: 1000 });
  t.after(async () => { runtime.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { runtime, requests, setState: s => { current = s; } };
}
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
