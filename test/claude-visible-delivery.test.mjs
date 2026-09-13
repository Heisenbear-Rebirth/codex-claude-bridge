import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ClaudeRuntime } from '../src/runtime/claude-runtime.mjs';
for (const activity of ['idle', 'running']) test(`unified peer sender preserves ${activity} activity and never interrupts`, async () => {
  const r = new ClaudeRuntime(randomUUID()), calls = [], requestId = randomUUID();
  r.status = async () => ({ activity, capabilities: { peerMessageVisibility: true, peerHistoryVisibility: true } });
  r.sendPeer = async args => { calls.push(args); return { status: 'submitted', transport: 'claude-peer-inbox' }; };
  r.control = async () => { throw Error('Peer must not use maintenance or interrupt'); };
  const sent = await r.sendMessage('peer message', { requestId });
  assert.deepEqual(calls, [{ targetId: r.id, text: 'peer message', messageId: requestId }]);
  assert.equal(sent.transport, 'claude-peer-inbox'); assert.equal(sent.visibility.replayEnabled, true);
  assert.equal(sent.visibility.displayConfirmed, false);
});
test('unified maintenance sender requires idle and uses the original expected-state control', async () => {
  const r = new ClaudeRuntime(randomUUID()), calls = [], requestId = randomUUID();
  r.control = async (...args) => { calls.push(args); return { status: 'submitted' }; };
  r.sendPeer = async () => { throw Error('Maintenance must preserve control turn tracking'); };
  assert.equal((await r.sendControl('handoff', { activity: 'running' })).status, 'state_conflict');
  assert.equal(calls.length, 0);
  const expected = { activity: 'idle', instanceId: 'native-instance', activityRevision: 3 };
  await r.sendControl('handoff', expected, requestId);
  assert.deepEqual(calls, [['prompt', expected, { text: 'handoff', requestId }]]);
});
test('old or disconnected visibility support is reported, never retried or upgraded to a user prompt', async () => {
  const r = new ClaudeRuntime(randomUUID()); let count = 0;
  r.status = async () => { throw Error('offline wrapper'); };
  r.sendPeer = async () => { count++; return { status: 'unknown' }; };
  const result = await r.sendMessage('test');
  assert.equal(count, 1); assert.equal(result.status, 'unknown'); assert.equal(result.visibility.replayEnabled, false);
  await assert.rejects(r.sendMessage('test', { kind: 'interrupt' }), /Invalid/);
  assert.equal(count, 1);
});
