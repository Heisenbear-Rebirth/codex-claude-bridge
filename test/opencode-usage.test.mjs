import test from 'node:test';
import assert from 'node:assert/strict';
import { openCodeUsage } from '../src/opencode-usage.mjs';
import { evaluatePolicy } from '../src/context-policy.mjs';
const session = { id: 'ses_UsageABC123', tokens: { total: 999999 } };
const providers = [{ id: 'native', models: { actual: { limit: { context: 10000 } } } }];
const row = (id, tokens, extra = {}) => ({ info: { id, sessionID: session.id, role: 'assistant', providerID: 'native', modelID: 'actual', time: { created: 1, completed: 2 }, tokens, ...extra }, parts: [] });
const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 500, write: 75 } };
test('OpenCode uses only the latest response including cache and actual model capacity', () => {
  const usage = openCodeUsage(session, [row('msg_1', { ...tokens, total: 9000 }), row('msg_2', tokens)], providers);
  assert.equal(usage.usedTokens, 695); assert.equal(usage.usedPercent, 6.95); assert.equal(usage.model, 'native/actual');
  assert.equal(usage.historyChangedAfterMeasurement, false);
  assert.equal(openCodeUsage(session, [row('msg_2', { ...tokens, total: 777 })], providers).usedTokens, 777);
});

test('Busy OpenCode tool steps retain measured usage for hard thresholds; new user input invalidates it', () => {
  const user = { info: { id: 'msg_0', role: 'user', sessionID: session.id, time: { created: 0 } }, parts: [] };
  const measured = row('msg_1', { total: 9000 }, { parentID: user.info.id });
  const streaming = row('msg_2', { total: 0 }, { parentID: user.info.id, time: { created: 3 } });
  let usage = openCodeUsage(session, [user, measured, streaming], providers);
  assert.equal(usage.historyChangedAfterMeasurement, true); assert.equal(usage.maintenanceMeasurementValid, true);
  const policy = { session: { client: 'opencode' }, enabled: true, softPercent: 50, hardPercent: 80 };
  const runtime = { connected: true, activity: 'running', capabilities: { automaticMaintenance: true } };
  assert.equal(evaluatePolicy({ policy, runtime, usage }).trigger, 'hard');
  usage = openCodeUsage(session, [user, measured, streaming, { info: { ...user.info, id: 'msg_3', time: { created: 4 } } }], providers);
  assert.equal(usage.maintenanceMeasurementValid, false); assert.equal(evaluatePolicy({ policy, runtime, usage }).action, 'wait');
});

test('Compaction invalidates pre-summary usage and restored measurements use a new epoch without counting reasoning twice', () => {
  const summary = row('msg_2', { total: 9900 }, { summary: true, finish: 'stop', time: { created: 3, completed: 4 } });
  assert.equal(openCodeUsage(session, [row('msg_1', tokens), summary], providers), null);
  const restored = row('msg_3', { ...tokens, total: 0 }, { time: { created: 5, completed: 6 } });
  const usage = openCodeUsage(session, [row('msg_1', tokens), summary, restored], providers);
  assert.equal(usage.usedTokens, 695); assert.equal(usage.contextEpoch, summary.info.id);
});
test('Unknown capacity, partial counters and fresh streaming placeholders remain honest', () => {
  assert.equal(openCodeUsage(session, [row('msg_1', tokens)]).usedPercent, null);
  assert.equal(openCodeUsage(session, [row('msg_1', { input: 10 })], providers), null);
  assert.equal(openCodeUsage(session, [], providers), null);
  const usage = openCodeUsage(session, [row('msg_1', tokens), row('msg_2', { total: 0, input: 0, output: 0, cache: { read: 0, write: 0 } }, { time: { created: 3 } })], providers);
  assert.equal(usage.usedTokens, 695); assert.equal(usage.historyChangedAfterMeasurement, true);
});
test('Revert, foreign sessions, model switches and compaction cannot masquerade as a fresh reading', () => {
  const messages = [row('msg_1', tokens), row('msg_2', { ...tokens, total: 9000 })];
  assert.equal(openCodeUsage({ ...session, revert: { messageID: 'msg_2' } }, messages, providers).usedTokens, 695);
  assert.equal(openCodeUsage(session, [row('msg_1', tokens, { sessionID: 'foreign' })], providers), null);
  assert.equal(openCodeUsage(session, [row('msg_1', tokens, { summary: true })], providers), null);
  assert.equal(openCodeUsage({ ...session, model: { id: 'new', providerID: 'native' } }, messages, providers).historyChangedAfterMeasurement, true);
});
