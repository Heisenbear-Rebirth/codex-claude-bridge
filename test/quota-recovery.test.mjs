import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { publicCodexQuota, publicClaudeQuota, freshAvailableQuota } from '../src/quota-state.mjs';
import { ClaudeProtocolState } from '../src/claude-wrapper-state.mjs';
import { projectCodexState } from '../src/runtime/codex-runtime.mjs';
import { ManagementStore } from '../src/management-store.mjs';
import { QuotaRecovery, quotaSettingKey } from '../src/quota-recovery.mjs';
import { MaintenanceController } from '../src/maintenance-controller.mjs';
import { evaluatePolicy } from '../src/context-policy.mjs';
import { SessionMailbox } from '../src/session-mailbox.mjs';
import { defaultPromptValues, validatePromptValues } from '../public/prompt-templates.mjs';

const codexUsage = (primary = 1, secondary = 2) => ({ ordinaryUsageAllowed: true,
  rateLimitsByLimitId: { codex: { primary: { usedPercent: primary, resetsAt: 1000 }, secondary: { usedPercent: secondary, resetsAt: 2000 } } } });
const claudeUsage = (five = 1, seven = 2) => ({ rate_limits_available: true,
  rate_limits: { five_hour: { utilization: five, resets_at: '2000-01-01T00:00:00Z' }, seven_day: { utilization: seven, resets_at: '2000-01-02T00:00:00Z' } },
  session: { secret: 'never-retain' }, behaviors: { history: 'never-retain' } });
test('fresh quota reads require positive capacity in all known windows; elapsed resets and missing data never authorize continuation', () => {
  for (const fn of [publicCodexQuota, publicClaudeQuota]) assert.equal(fn({}).status, 'unknown');
  for (const [fn, data] of [[publicCodexQuota, codexUsage], [publicClaudeQuota, claudeUsage]]) {
    assert.equal(fn(data(100, 0)).status, 'exhausted');
    assert.equal(fn(data(0, 100)).status, 'exhausted');
    assert.equal(fn(data(null, 0)).status, 'unknown');
    assert.equal(freshAvailableQuota(fn(data(10, 20))), true);
    assert.equal(freshAvailableQuota({ ...fn(data()), queriedAt: '2000-01-01T00:00:00Z' }), false);
  }
  const missing = codexUsage(); delete missing.rateLimitsByLimitId.codex.primary;
  assert.equal(publicCodexQuota(missing).status, 'unknown');
  assert.equal(publicCodexQuota({ ...codexUsage(), ordinaryUsageAllowed: false }).status, 'unknown');
  const c = claudeUsage(); c.rate_limits.model_scoped = [{ display_name: 'Opus', utilization: 100 }];
  assert.equal(publicClaudeQuota(c).status, 'exhausted');
  assert.equal(JSON.stringify(publicClaudeQuota(c)).includes('never-retain'), false);
  const d = codexUsage(); d.rateLimitsByLimitId.base_model_inference = { primary: { usedPercent: 100 } };
  assert.equal(publicCodexQuota(d).status, 'exhausted');
});
test('Codex recognizes only a structured quota failure on the head, not ordinary interrupted turns, prose or historical failures', () => {
  const state = { id: randomUUID(), cwd: resolve('.'), threadRuntimeStatus: { type: 'idle' }, turns: [
    { turnId: 'failed', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded', message: 'private text' }, items: [] },
  ] };
  const limited = projectCodexState(state); assert.equal(limited.activity, 'quota_limited'); assert.equal(limited.quota.turnId, 'failed');
  assert.equal(JSON.stringify(limited).includes('private text'), false);
  for (const error of [null, { codexErrorInfo: 'httpConnectionFailed', httpStatusCode: 429 }]) {
    state.turns.push({ turnId: randomUUID(), status: 'interrupted', error, items: [{ type: 'agentMessage', text: 'usageLimitExceeded' }] });
    assert.equal(projectCodexState(state).activity, 'idle');
  }
});
test('Claude quota events alone do not stop active work; only failed turns become quota_limited, manual input or stop cancels continuation', () => {
  const s = new ClaudeProtocolState(randomUUID()); s.initialized = true;
  s.host({ type: 'user', uuid: 'first' });
  s.child({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1 } });
  assert.equal(s.activity(), 'running');
  s.child({ type: 'result', is_error: false }); assert.equal(s.activity(), 'idle');
  s.host({ type: 'user', uuid: 'second' });
  s.child({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1 } });
  s.child({ type: 'assistant', error: 'rate_limit' });
  s.child({ type: 'result', is_error: true }); assert.equal(s.activity(), 'quota_limited');
  assert.equal(s.quota.turnId, 'second'); assert.equal(s.quota.autoResume, true);
  assert.equal(Boolean(s.canCompact()), false); assert.equal(Boolean(s.canQuery()), true);
  s.host({ type: 'control_request', request_id: 'human-stop', request: { subtype: 'interrupt' } });
  assert.equal(s.quota.autoResume, false);
  s.child({ type: 'control_response', response: { request_id: 'human-stop', subtype: 'success' } });
  s.host({ type: 'user', uuid: 'manual-next' }); assert.equal(s.quota, null);
  s.child({ type: 'assistant', parent_tool_use_id: 'child', error: 'rate_limit' });
  s.child({ type: 'result', is_error: true }); assert.equal(s.quota, null);
  s.host({ type: 'user', uuid: 'unknown-limit' });
  s.child({ type: 'assistant', error: 'rate_limit' }); s.child({ type: 'result', is_error: true });
  assert.equal(s.quota.kind, 'unknown_rate_limit'); assert.equal(s.quota.autoResume, false); assert.equal(s.canCompact(), false);
});

test('a registered live peer can start quota tracking without IDE input, while unrelated historical replay cannot wake the session', () => {
  const s = new ClaudeProtocolState(randomUUID()); s.initialized = true;
  const peer = uuid => ({ type: 'user', session_id: s.sessionId, uuid, isReplay: true, origin: { kind: 'peer' }, message: { role: 'user', content: 'fixture' } });
  s.child(peer(randomUUID())); assert.equal(s.activity(), 'idle');
  const id = randomUUID(); s.expectPeer(id); s.child(peer(id)); assert.equal(s.activeTurnId, id);
  s.child({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1 } });
  s.child({ type: 'assistant', error: 'rate_limit' }); s.child({ type: 'result', is_error: true });
  assert.equal(s.quota.kind, 'five_hour'); assert.equal(s.quota.autoResume, true); assert.equal(s.quota.turnId, id);
  assert.equal(s.expectedPeers.size, 0);
});

test('registered peer output during existing work preserves the original turn and manual-stop choice', () => {
  const s = new ClaudeProtocolState(randomUUID()); s.initialized = true; s.host({ type: 'user', uuid: 'original-turn' });
  const id = randomUUID(); s.expectPeer(id); s.child({ type: 'user', uuid: id, origin: { kind: 'peer' }, message: { role: 'user' } });
  assert.equal(s.activeTurnId, 'original-turn'); assert.equal(s.expectedPeers.size, 0);
  s.child({ type: 'result' }); s.userStopped = true;
  const later = randomUUID(); s.expectPeer(later); s.child({ type: 'user', uuid: later, origin: { kind: 'peer' }, message: { role: 'user' } });
  s.child({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } });
  s.child({ type: 'assistant', error: 'rate_limit' }); s.child({ type: 'result', is_error: true }); assert.equal(s.quota.autoResume, false);
});

test('Claude command lifecycle settles folded inputs before quota failure without inventing another running turn', () => {
  const s = new ClaudeProtocolState(randomUUID()); s.initialized = true;
  s.host({ type: 'user', uuid: 'original' });
  for (const id of ['folded-1', 'folded-2']) {
    s.host({ type: 'user', uuid: id });
    s.child({ type: 'command_lifecycle', command_uuid: id, state: 'started' });
  }
  s.child({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } });
  s.child({ type: 'assistant', error: 'rate_limit' });
  for (const id of ['original', 'folded-1', 'folded-2']) s.child({ type: 'command_lifecycle', command_uuid: id, state: 'cancelled' });
  s.child({ type: 'result', is_error: true });
  assert.equal(s.activity(), 'quota_limited'); assert.equal(s.activeTurnId, null);
  assert.equal(s.publicState().queuedNativeInputs, 0); assert.equal(s.quota.turnId, 'original');
  assert.equal(s.quota.autoResume, true); assert.equal(Boolean(s.canQuery()), true);
});
test('Claude retains unacknowledged inputs at a result boundary and starts them only on native evidence', () => {
  const s = new ClaudeProtocolState(randomUUID()); s.initialized = true;
  s.host({ type: 'user', uuid: 'original' }); s.host({ type: 'user', uuid: 'queued' });
  s.child({ type: 'assistant', error: 'rate_limit' }); s.child({ type: 'result', is_error: true });
  assert.equal(s.activeTurnId, null); assert.equal(s.publicState().queuedNativeInputs, 1);
  assert.equal(s.activity(), 'quota_limited'); assert.equal(Boolean(s.canQuery()), false);
  s.child({ type: 'command_lifecycle', command_uuid: 'unrelated-replay', state: 'started' });
  assert.equal(s.activeTurnId, null);
  s.child({ type: 'command_lifecycle', command_uuid: 'queued', state: 'started' });
  assert.equal(s.activeTurnId, 'queued'); assert.equal(s.quota, null);
  s.child({ type: 'result', is_error: false }); assert.equal(s.activity(), 'idle');
});
test('Claude native replay acknowledgements settle only known queued inputs, not historical user messages', () => {
  const s = new ClaudeProtocolState(randomUUID()); s.initialized = true;
  s.host({ type: 'user', uuid: 'original' }); s.host({ type: 'user', uuid: 'folded' });
  s.child({ type: 'user', uuid: 'folded', isReplay: true, message: { role: 'user', content: 'fixture' } });
  assert.equal(s.publicState().queuedNativeInputs, 0); assert.equal(s.activeTurnId, 'original');
  s.child({ type: 'result' });
  s.child({ type: 'user', uuid: 'historical', isReplay: true, message: { role: 'user', content: 'fixture' } });
  assert.equal(s.activity(), 'idle'); assert.equal(s.activeTurnId, null);
});

async function fixture(t, client) {
  const root = await mkdtemp(join(resolve('.cooperation'), 'quota-test-'));
  const store = await new ManagementStore(join(root, '.cooperation')).init();
  const session = { client, id: randomUUID(), cwd: root, name: 'Quota fixture' };
  const state = { client, sessionId: session.id, cwd: root, connected: true, activity: 'quota_limited', instanceId: 'original-instance', activityRevision: 3,
    activeTurnId: null, latestTurn: { id: 'failed-turn', status: 'failed' }, lastCompletedTurnId: 'failed-turn', model: 'original-model', effort: 'high',
    permissionMode: 'original', quota: { kind: 'usage_limit', turnId: 'failed-turn', autoResume: true }, capabilities: { automaticMaintenance: true } };
  store.savePolicy(session, { enabled: true, mode: 'automatic' });
  let used = 100, reads = 0, sent = [], resumedStatus = 'submitted', readHook = null, controlCount = 0;
  const runtime = { status: async () => structuredClone(state), quota: async () => {
    reads++; if (readHook) await readHook(); return publicClaudeQuota(claudeUsage(used));
  }, resumeQuota: async (text, expected, options) => {
    sent.push({ text, expected, options }); return { status: resumedStatus, activeTurnId: 'resumed-turn' };
  }, sendControl: async () => { controlCount++; return { status: 'unknown' }; }, compact: async () => { controlCount++; }, close() {} };
  const sample = async () => {
    const value = { session, runtime: structuredClone(state), usage: { usedTokens: 99, contextWindowTokens: 100, contextEpoch: 1 } };
    value.decision = evaluatePolicy({ ...value, policy: store.getPolicy(session) }); store.saveSnapshot(session, value); return value;
  };
  const monitor = { sample, runtime: () => runtime, close() {} };
  const service = { adapters: { [client]: { find: async () => session } }, mailbox: new SessionMailbox({ store,
    deliverMessage: async () => { throw Error('Quota held message must not be delivered'); } }) };
  const controller = new MaintenanceController({ root, store, service, monitor });
  const readCodex = async () => { reads++; if (readHook) await readHook(); return codexUsage(used); };
  controller.quotaRecovery.readCodex = readCodex;
  const handler = () => controller.quotaRecovery.handle(session, store.getPolicy(session), awaitSample());
  function awaitSample() { return { session, runtime: structuredClone(state) }; }
  const forcePoll = () => { const record = store.getSetting(quotaSettingKey(session));
    if (record) store.setSetting(quotaSettingKey(session), { ...record, nextCheckAt: '2000-01-01T00:00:00Z' });
    controller.quotaRecovery.codexNextRead = 0;
  };
  t.after(async () => { await controller.close(); await service.mailbox.close(); store.close();
    assert.ok(root.startsWith(resolve('.cooperation') + sep)); await rm(root, { recursive: true, force: true }); });
  return { root, store, session, state, runtime, monitor, service, controller, handler, sample, forcePoll, sent,
    record: () => store.getSetting(quotaSettingKey(session)), setUsed: n => { used = n; }, setOutcome: v => { resumedStatus = v; },
    setReadHook: f => { readHook = f; }, reads: () => reads, controls: () => controlCount,
    restart: () => { controller.quotaRecovery = new QuotaRecovery({ root, store, service, monitor, readCodex }); } };
}
for (const client of ['claude', 'codex']) {
  for (const order of ['manager-first', 'client-first']) test(`${client}: ${order} reboot rebinds a verified failed head and continues once`, async t => {
    const h = await fixture(t, client); await h.handler();
    const requestId = h.record().requestId;
    h.state.connected = false; h.state.activity = 'offline';
    if (order === 'manager-first') { h.restart(); await h.handler(); }
    h.state.connected = true; h.state.activity = 'quota_limited'; h.state.instanceId = 'reopened'; h.state.activityRevision = 1;
    if (order === 'client-first') h.restart();
    h.setUsed(0); h.forcePoll(); await h.handler(); await h.handler();
    assert.equal(h.record().state, 'submitted'); assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].options.requestId, requestId);
  });
  test(`${client}: manager-only restart can rebind the same native head after observation revision resets`, async t => {
    const h = await fixture(t, client); await h.handler(); h.restart(); h.state.activityRevision = 1;
    h.setUsed(0); h.forcePoll(); await h.handler(); assert.equal(h.sent.length, 1);
  });
  test(`${client}: reboot waits for selected settings to synchronize before rebinding`, async t => {
    const h = await fixture(t, client); await h.handler(); h.restart(); h.state.instanceId = 'reopened'; h.state.model = null;
    h.setUsed(0); h.forcePoll(); await h.handler(); assert.equal(h.record().state, 'waiting'); assert.equal(h.sent.length, 0);
    h.state.model = 'original-model'; await h.handler(); assert.equal(h.sent.length, 1);
  });
  test(`${client}: a reboot never releases an uncertain send or accepts changed settings`, async t => {
    const h = await fixture(t, client); await h.handler();
    h.store.setSetting(quotaSettingKey(h.session), { ...h.record(), state: 'sending' });
    h.restart(); h.state.instanceId = 'reopened'; h.state.activityRevision = 1; h.setUsed(0); h.forcePoll();
    await h.handler(); assert.equal(h.record().state, 'attention'); assert.equal(h.sent.length, 0);
    const other = await fixture(t, client); await other.handler(); other.restart(); other.state.instanceId = 'new'; other.state.model = 'changed';
    other.setUsed(0); other.forcePoll(); await other.handler(); assert.equal(other.sent.length, 0); assert.equal(other.record().state, 'cancelled');
  });
  test(`${client}: quota is checked while native state settles, then continuation waits for a safe boundary`, async t => {
    const h = await fixture(t, client); h.state.activity = 'unknown'; h.state.queuedNativeInputs = 1;
    await h.handler(); assert.equal(h.reads(), 1); assert.equal(h.record().state, 'waiting'); assert.equal(h.sent.length, 0);
    h.setUsed(0); h.forcePoll(); await h.handler(); assert.equal(h.reads(), 2); assert.equal(h.sent.length, 0);
    assert.match(h.record().reason, /输入|状态|轮次/);
    h.state.activity = 'quota_limited'; h.state.queuedNativeInputs = 0; h.state.activityRevision++;
    h.forcePoll(); await h.handler(); assert.equal(h.sent.length, 1); assert.equal(h.record().state, 'submitted');
  });
  test(`${client}: full manager tick holds compression and FIFO at 99% context, reads restored quota and submits exactly one same-session continuation`, async t => {
    const h = await fixture(t, client);
    await h.controller.tick(); assert.equal(h.record().state, 'waiting'); assert.equal(h.controls(), 0); assert.equal(h.store.activeCycle(h.session), null);
    const message = { id: randomUUID(), createdAt: new Date().toISOString(), from: { client: 'codex', id: randomUUID() }, to: h.session, text: 'queued' };
    assert.equal((await h.service.mailbox.send(message)).status, 'queued'); assert.equal(h.store.claimNext(`local:${client}:${h.session.id}`), null);
    await h.controller.tick(); assert.equal(h.reads(), 1); assert.equal(h.sent.length, 0);
    h.setUsed(20); h.forcePoll(); await h.controller.tick();
    assert.equal(h.record().state, 'submitted'); assert.equal(h.sent.length, 1); assert.equal(h.controls(), 0);
    assert.equal(h.sent[0].expected.sessionId, h.session.id); assert.equal(h.sent[0].expected.model, 'original-model'); assert.equal(h.sent[0].expected.effort, 'high');
    assert.match(h.sent[0].text, /额度已恢复/);
    h.restart(); await h.controller.tick(); await h.controller.tick(); assert.equal(h.sent.length, 1);
  });
  test(`${client}: unknown send survives coordinator restart without retry; user movement releases old hold`, async t => {
    const h = await fixture(t, client); h.setUsed(0); h.setOutcome('unknown'); await h.handler();
    assert.equal(h.record().state, 'attention'); h.restart(); await h.handler(); assert.equal(h.sent.length, 1);
    h.state.quota = null; h.state.activity = 'idle'; h.state.latestTurn.id = 'manual-turn'; await h.handler();
    assert.equal(h.record().state, 'cancelled'); assert.equal(h.sent.length, 1);
  });
  test(`${client}: crash after persisted send intent does not resend`, async t => {
    const h = await fixture(t, client); await h.handler();
    h.store.setSetting(quotaSettingKey(h.session), { ...h.record(), state: 'sending' }); h.restart(); await h.handler();
    assert.equal(h.record().state, 'attention'); assert.equal(h.sent.length, 0);
  });
  test(`${client}: reopened client with no native head retains an uncertain send as attention`, async t => {
    const h = await fixture(t, client); await h.handler();
    h.store.setSetting(quotaSettingKey(h.session), { ...h.record(), state: 'sending' }); h.restart();
    Object.assign(h.state, { instanceId: 'reopened', activity: 'idle', quota: null, latestTurn: null, lastCompletedTurnId: null });
    await h.handler(); assert.equal(h.record().state, 'attention'); assert.equal(h.sent.length, 0);
  });
  test(`${client}: manual native changes or policy disable during quota query invalidate continuation`, async t => {
    for (const change of [h => { h.state.activityRevision++; }, h => { h.state.instanceId = 'new'; },
      h => { h.state.model = 'changed'; }, h => { h.store.savePolicy(h.session, { enabled: false }); }]) {
      const h = await fixture(t, client); h.setUsed(0); h.setReadHook(async () => change(h)); await h.handler();
      assert.equal(h.sent.length, 0); assert.equal(h.record().state, 'cancelled');
    }
  });
  test(`${client}: repeated quota failure after a resumed turn backs off instead of immediately resending`, async t => {
    const h = await fixture(t, client); h.setUsed(0); await h.handler();
    h.state.quota.turnId = 'resumed-turn'; h.state.latestTurn.id = 'resumed-turn'; h.state.activityRevision++;
    await h.handler(); assert.equal(h.sent.length, 1); assert.equal(h.record().recoveryFailures, 1);
    assert.ok(Date.parse(h.record().nextCheckAt) > Date.now() + 60000);
  });
}
test('old prompt settings gain an editable quota continuation while rejecting unfilled maintenance variables', () => {
  const old = defaultPromptValues(); delete old.maintenance.quotaContinue;
  assert.match(validatePromptValues(old).maintenance.quotaContinue, /额度已恢复/);
  const invalid = defaultPromptValues(); invalid.maintenance.quotaContinue = '{{documentPath}}';
  assert.throws(() => validatePromptValues(invalid), /只支持/);
});
