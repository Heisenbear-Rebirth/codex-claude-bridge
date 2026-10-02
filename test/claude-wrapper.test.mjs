import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { JsonLineObserver, ClaudeProtocolState } from '../src/claude-wrapper-state.mjs';
import { ClaudeRuntime } from '../src/runtime/claude-runtime.mjs';
import { startServer } from '../src/http-server.mjs';
import { PromptSettings } from '../src/prompt-settings.mjs';
import { defaultPromptValues } from '../public/prompt-templates.mjs';
import { quotaSettingKey } from '../src/quota-recovery.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'test', 'fixtures', 'claude-wrapper-child.mjs');
const launcher = join(root, 'bin', 'claude-wrapper.exe');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(read, description, timeout = 10000) {
  const end = Date.now() + timeout;
  do { const value = await read(); if (value) return value; await sleep(40); } while (Date.now() < end);
  throw new Error(`Timed out: ${description}`);
}
async function harness(t, extraArgs = [], prepare) {
  const parent = join(root, 'verification', 'wrapper-test-temp'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'case-'));
  await writeFile(join(directory, 'config.json'), JSON.stringify({ enabled: true, directories: [directory] }));
  const id = randomUUID();
  const prepared = await prepare?.({ directory, id });
  const processHandle = spawn(launcher, [process.execPath, fixture, '--input-format', 'stream-json', '--output-format', 'stream-json', '--resume', id, ...extraArgs], {
    cwd: directory, env: { ...process.env, COOP_WRAPPER_DATA_DIRECTORY: directory, ...prepared?.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [], stderr = [];
  const exited = new Promise(resolve => processHandle.once('close', code => resolve(code)));
  createInterface({ input: processHandle.stdout }).on('line', line => { try { messages.push(JSON.parse(line)); } catch { messages.push({ invalid: line }); } });
  processHandle.stderr.on('data', data => stderr.push(data.toString()));
  const send = message => processHandle.stdin.write(JSON.stringify(message) + '\n');
  async function registry() {
    const folder = join(directory, 'instances');
    const files = await readdir(folder).catch(() => []);
    for (const file of files.filter(name => name.endsWith('.json'))) {
      try { const record = JSON.parse(await readFile(join(folder, file), 'utf8')); if (record.sessionId === id) return record; } catch { /* atomic update */ }
    }
    return null;
  }
  async function status() { const record = await registry(); if (!record) return null; const result = await fetch(record.endpoint + '/status', { headers: { Authorization: `Bearer ${record.token}` } }); return { record, state: await result.json() }; }
  t.after(async () => { processHandle.stdin.end(); await Promise.race([exited, sleep(3000)]); if (processHandle.exitCode === null) processHandle.kill(); await exited;
    await prepared?.close?.();
    assert.ok(resolve(directory).startsWith(resolve(parent) + '\\') || resolve(directory).startsWith(resolve(parent) + '/'));
    await rm(directory, { recursive: true, force: true }); });
  send({ type: 'control_request', request_id: 'init-test', request: { subtype: 'initialize' } });
  const ready = await until(async () => { const current = await status(); return current?.state.canCompact ? current : null; }, 'wrapper ready: ' + stderr.join(''));
  assert.ok(Number(new URL(ready.record.endpoint).port) >= 20000, 'wrapper HTTP uses a Fetch-compatible port');
  async function compact(token = ready.record.token) {
    const current = await status();
    const response = await fetch(current.record.endpoint + '/compact', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: id, requestId: randomUUID(), instanceId: current.record.instanceId }) });
    return { httpStatus: response.status, body: await response.json() };
  }
  async function control(kind, extra = {}) {
    const current = await status();
    const body = { sessionId: id, instanceId: current.record.instanceId, requestId: randomUUID(),
      expectedTurnId: current.state.activeTurnId, expectedActivityRevision: current.state.activityRevision, ...extra };
    const response = await fetch(current.record.endpoint + '/' + kind, { method: 'POST', headers: { Authorization: `Bearer ${current.record.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { httpStatus: response.status, body: await response.json(), request: body };
  }
  return { directory, id, processHandle, messages, stderr, send, status, compact, control, exited };
}

test('JSON observer preserves split Unicode and partial-line boundaries', () => {
  const seen = []; const observer = new JsonLineObserver(message => seen.push(message));
  const bytes = Buffer.from(JSON.stringify({ text: '中文🙂"\\' }) + '\n');
  for (const byte of bytes) observer.push(Buffer.from([byte]));
  assert.deepEqual(seen, [{ text: '中文🙂"\\' }]); assert.equal(observer.atBoundary, true);
  observer.push(Buffer.from('{')); assert.equal(observer.atBoundary, false);
});

test('Claude runtime accepts controller operation options through the real wrapper for prompt, interrupt and compact', async t => {
  const h = await harness(t), runtime = new ClaudeRuntime(h.id, { folder: join(h.directory, 'instances') });
  const promptId = randomUUID(), interruptId = randomUUID(), compactId = randomUUID();
  const initial = await runtime.status();
  const prompt = await runtime.sendControl('hold', initial, { requestId: promptId });
  assert.equal(prompt.status, 'submitted'); assert.equal(prompt.requestId, promptId);
  const running = await until(async () => { const s = await runtime.status(); return s.activity === 'running' && s.activeTurnId === promptId ? s : null; }, 'runtime prompt running');
  const interrupted = await runtime.interrupt(running, { requestId: interruptId });
  assert.equal(interrupted.status, 'acknowledged'); assert.equal(interrupted.requestId, interruptId);
  const idle = await until(async () => { const s = await runtime.status(); return s.activity === 'idle' && s.canCompact ? s : null; }, 'runtime interrupt completed');
  const compacted = await runtime.compact(idle, { requestId: compactId });
  assert.equal(compacted.status, 'completed'); assert.equal(compacted.requestId, compactId);
  const frames = h.messages.filter(m => m.fixtureReceivedExactly);
  assert.ok(frames.some(m => m.uuid === promptId && m.message.content === 'hold'));
  assert.ok(frames.some(m => m.uuid === compactId && m.message.content === '/compact'));
  assert.ok(frames.every(m => typeof m.uuid === 'string'));
});
test('pending permission and SDK control requests block compaction', () => {
  const state = new ClaudeProtocolState(randomUUID());
  state.host({ type: 'control_request', request_id: 'i', request: { subtype: 'initialize' } });
  assert.equal(Boolean(state.canCompact()), false);
  state.child({ type: 'control_response', response: { request_id: 'i', subtype: 'success' } });
  assert.equal(Boolean(state.canCompact()), true);
  state.child({ type: 'control_request', request_id: 'p', request: { subtype: 'can_use_tool' } });
  assert.equal(Boolean(state.canCompact()), false);
  state.host({ type: 'control_response', response: { request_id: 'p' } });
  assert.equal(Boolean(state.canCompact()), true);
});

test('old Claude wrapper is observation-only until it can classify quota interruptions', async () => {
  const runtime = new ClaudeRuntime(randomUUID()); runtime.record = { instanceId: 'old' };
  runtime.request = async () => ({ sessionId: runtime.id, instanceId: 'old', activity: 'idle', connected: true, protocolVersion: 2,
    capabilities: { automaticMaintenance: true, readActivity: true } });
  const current = await runtime.status(); assert.equal(current.requiresReopen, true); assert.equal(current.capabilities.automaticMaintenance, false);
  assert.match(current.detail, /重开/);
});
test('Windows executable preserves arguments and exit behavior', { skip: process.platform !== 'win32' }, async () => {
  const values = ['space here', '中文🙂', 'quote"inside', 'trailing\\', '', '{"path":"C:\\a b\\"}'];
  const child = spawn(launcher, [process.execPath, fixture, '--show-args', ...values], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; });
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 0); assert.deepEqual(JSON.parse(output).args, ['--show-args', ...values]);
});
test('wrapper forwards normal turns and permission replies without answering for the IDE', { skip: process.platform !== 'win32' }, async t => {
  const h = await harness(t);
  const message = { type: 'user', session_id: h.id, message: { role: 'user', content: 'echo 中文🙂"\\' }, custom: { nested: [1, false] } };
  h.send(message);
  await until(() => h.messages.find(value => value.fixtureReceivedExactly), 'normal message');
  assert.deepEqual(h.messages.find(value => value.fixtureReceivedExactly), { ...message, fixtureReceivedExactly: true });
  assert.ok(h.messages.some(value => value.type === 'assistant'));
  h.send({ type: 'user', session_id: h.id, message: { role: 'user', content: 'permission' } });
  await until(() => h.messages.find(value => value.request_id === 'fixture-permission'), 'permission request');
  await sleep(100);
  assert.equal(h.messages.some(value => value.type === 'fixture_permission_answer'), false);
  assert.equal((await h.compact()).httpStatus, 409);
  const response = { subtype: 'success', request_id: 'fixture-permission', response: { behavior: 'deny', message: 'Keep the original permission flow.' } };
  h.send({ type: 'control_response', response });
  await until(() => h.messages.find(value => value.type === 'fixture_permission_answer'), 'permission response');
  assert.deepEqual(h.messages.find(value => value.type === 'fixture_permission_answer').response, response);
});
test('external compact requires authorization and confirms boundary plus result in the same process', { skip: process.platform !== 'win32' }, async t => {
  const h = await harness(t); const before = await h.status();
  assert.equal((await h.compact('invalid')).httpStatus, 401);
  const result = await h.compact(); assert.equal(result.body.status, 'completed'); assert.equal(result.body.boundary.trigger, 'manual');
  const after = await h.status(); assert.equal(after.state.childPid, before.state.childPid);
  const received = h.messages.filter(message => message.type === 'user' && message.message.content === '/compact');
  assert.equal(received.length, 1); assert.equal(received[0].session_id, h.id);
  assert.equal(h.messages.some(message => message.invalid), false);
});
test('successful command result without a compact boundary is not reported as compaction', { skip: process.platform !== 'win32' }, async t => {
  const h = await harness(t, ['--no-boundary']); const result = await h.compact();
  assert.equal(result.body.status, 'not_compacted');
});
test('ending IDE input exits cleanly and removes the instance record', { skip: process.platform !== 'win32' }, async t => {
  const h = await harness(t); h.processHandle.stdin.end(); assert.equal(await h.exited, 0);
  assert.deepEqual((await readdir(join(h.directory, 'instances'))).filter(name => name.endsWith('.json')), []);
});
test('native context query stays read-only and its reply does not enter the IDE request map', { skip: process.platform !== 'win32' }, async t => {
  const h = await harness(t); const { record } = await h.status();
  const response = await fetch(record.endpoint + '/context?sessionId=' + h.id, { headers: { Authorization: `Bearer ${record.token}` } });
  const result = await response.json(); assert.equal(response.status, 200); assert.equal(result.usage.usedPercent, 15);
  assert.equal(JSON.stringify(result).includes('not-returned'), false);
  assert.equal(h.messages.some(message => message.response?.request_id?.startsWith('cooperation-context-')), false);
  assert.equal((await h.status()).state.canCompact, true);
  h.send({ type: 'user', session_id: h.id, message: { role: 'user', content: 'after-context-query' } });
  await until(() => h.messages.some(message => message.fixtureReceivedExactly), 'normal input after context query');
});

test('quota-limited native wrapper blocks compact and ordinary prompts, queries only quota, resumes once in the original process', async t => {
  const h = await harness(t), runtime = new ClaudeRuntime(h.id, { folder: join(h.directory, 'instances') });
  const before = await runtime.status(), failedId = randomUUID();
  h.send({ type: 'user', uuid: failedId, session_id: h.id, message: { role: 'user', content: 'quota-failure' } });
  const limited = await until(async () => { const s = await runtime.status(); return s.activity === 'quota_limited' ? s : null; }, 'quota failure observed');
  assert.equal(limited.quota.turnId, failedId); assert.equal(limited.canCompact, false);
  assert.equal((await h.compact()).body.status, 'busy'); assert.equal((await h.control('prompt', { text: 'blocked' })).body.status, 'busy');
  assert.equal((await runtime.resumeQuota('continue', limited, { requestId: randomUUID() })).status, 'busy');
  const quota = await runtime.quota(); assert.equal(quota.status, 'available');
  assert.equal(JSON.stringify(quota).includes('not-returned'), false);
  assert.ok(h.messages.some(m => m.type === 'fixture_quota_request' && m.skipBehaviors === true));
  assert.equal(h.messages.some(m => m.response?.request_id?.startsWith('cooperation-context-')), false);
  const requestId = randomUUID(), sent = await runtime.resumeQuota('continue', limited, { requestId, quota });
  assert.equal(sent.status, 'submitted');
  await until(async () => (await runtime.status()).lastCompletedTurnId === requestId, 'continued turn finished');
  assert.equal((await runtime.status()).childPid, before.childPid);
  const repeat = await h.control('quota-resume', { requestId, text: 'continue', expectedTurnId: limited.activeTurnId, expectedActivityRevision: limited.activityRevision });
  assert.equal(repeat.body.status, 'submitted');
  assert.equal(h.messages.filter(m => m.fixtureReceivedExactly && m.uuid === requestId).length, 1);
});
test('folded native inputs do not strand Claude quota recovery; actual wrapper and manager continue once in the same process', async t => {
  let manager, target;
  const h = await harness(t, [], async ({ directory, id }) => {
    target = { client: 'claude', id, cwd: directory, name: 'folded quota fixture' };
    const adapters = Object.fromEntries(['codex', 'claude', 'opencode'].map(client => [client, {
      list: async () => ({ sessions: client === 'claude' ? [target] : [] }), find: async value => value === id ? target : null,
    }]));
    manager = await startServer({ root: directory, port: 0, startMonitoring: false, adapters,
      runtimeFactory: () => new ClaudeRuntime(id, { folder: join(directory, 'instances') }) });
    await writeFile(join(directory, 'quota-utilization.json'), JSON.stringify({ value: 100 }));
    return { close: () => manager.close() };
  });
  manager.store.savePolicy(target, { enabled: true, mode: 'automatic' });
  const values = defaultPromptValues(); values.maintenance.quotaContinue = '从未完成的任务接续，已收到的追加输入不重复发送。';
  await new PromptSettings(h.directory).save(values, 0);
  const original = (await h.status()).state, originalId = randomUUID();
  h.send({ type: 'user', session_id: h.id, uuid: originalId, message: { role: 'user', content: 'hold' } });
  await until(async () => (await h.status()).state.activeTurnId === originalId, 'original native turn started');
  const busyQuota = await manager.monitor.runtime(target).quota(); assert.equal(busyQuota.status, 'exhausted');
  assert.equal((await h.status()).state.activeTurnId, originalId);
  for (let i = 0; i < 2; i++) h.send({ type: 'user', session_id: h.id, uuid: randomUUID(), message: { role: 'user', content: 'fold-into-current-turn' } });
  await until(() => h.messages.filter(m => m.type === 'command_lifecycle' && m.state === 'started').length === 2, 'both additional inputs consumed');
  h.send({ type: 'fixture_finish_folded_quota' });
  const limited = await until(async () => { const s = (await h.status()).state; return s.activity === 'quota_limited' ? s : null; }, 'quota failure has no phantom turn');
  assert.equal(limited.activeTurnId, null); assert.equal(limited.queuedNativeInputs, 0); assert.equal(limited.quota.turnId, originalId);
  await manager.controller.tick(); assert.equal(manager.store.getSetting(quotaSettingKey(target)).state, 'waiting');
  assert.equal(manager.store.activeCycle(target), null);
  await writeFile(join(h.directory, 'quota-utilization.json'), JSON.stringify({ value: 5 }));
  await until(async () => {
    const record = manager.store.getSetting(quotaSettingKey(target));
    if (record.state === 'submitted') return true;
    assert.equal(record.state, 'waiting', JSON.stringify(record));
    manager.store.setSetting(quotaSettingKey(target), { ...record, nextCheckAt: '2000-01-01T00:00:00Z' });
    await manager.controller.tick(); return manager.store.getSetting(quotaSettingKey(target)).state === 'submitted';
  }, 'native quota polling confirms availability and submits once');
  await until(async () => (await h.status()).state.activity === 'idle', 'quota continuation finished');
  await manager.controller.tick();
  assert.equal(h.messages.filter(m => m.fixtureReceivedExactly && m.message?.content === values.maintenance.quotaContinue).length, 1);
  assert.equal(h.messages.filter(m => m.fixtureReceivedExactly && m.message?.content === 'fold-into-current-turn').length, 2);
  assert.equal((await h.status()).state.childPid, original.childPid);
});
test('revoking a project control directory leaves native traffic intact and closes external operations', { skip: process.platform !== 'win32' }, async t => {
  const h = await harness(t); await writeFile(join(h.directory, 'config.json'), JSON.stringify({ enabled: true, directories: [] }));
  const state = (await h.status()).state; assert.equal(state.controlsEnabled, false); assert.equal(state.canCompact, false);
  assert.equal((await h.control('prompt', { text: 'blocked' })).httpStatus, 403);
  h.send({ type: 'user', session_id: h.id, message: { role: 'user', content: 'native-still-works' } });
  await until(() => h.messages.some(m => m.fixtureReceivedExactly && m.message?.content === 'native-still-works'), 'native transport after revocation');
});
test('abrupt launcher termination kills its proxy and original child process', { skip: process.platform !== 'win32' }, async t => {
  const h = await harness(t); const state = (await h.status()).state;
  h.processHandle.kill(); await h.exited;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await until(() => !alive(state.wrapperPid) && !alive(state.childPid), 'job children stopped', 5000);
});

test('external prompt, passive busy usage, exact interrupt and same-process resume', { skip: process.platform !== 'win32' }, async t => {
  const h = await harness(t); const before = await h.status();
  await fetch(before.record.endpoint + '/context?sessionId=' + h.id, { headers: { Authorization: `Bearer ${before.record.token}` } });
  const sent = await h.control('prompt', { text: 'hold' }); assert.equal(sent.body.status, 'submitted');
  const active = await until(async () => { const s = (await h.status()).state; return s.activity === 'running' && s.usage?.source === 'claude-passive-api-usage' ? s : null; }, 'passive busy usage');
  assert.equal(active.activeTurnId, sent.request.requestId); assert.equal(active.usage.usedTokens, 120050);
  assert.equal(active.usage.contextWindowTokens, 200000); assert.equal(active.usage.usedPercent, 60.03);
  assert.equal((await h.control('interrupt', { expectedTurnId: 'previous-turn' })).body.status, 'state_conflict');
  assert.equal((await h.status()).state.activity, 'running');
  const interrupted = await h.control('interrupt'); assert.equal(interrupted.body.status, 'acknowledged');
  await until(async () => (await h.status()).state.activity === 'idle', 'original result confirms idle');
  assert.equal(h.messages.some(m => m.response?.request_id?.startsWith('cooperation-interrupt-')), false);
  const resumed = await h.control('prompt', { text: 'resumed' }); assert.equal(resumed.body.status, 'submitted');
  await until(async () => (await h.status()).state.lastControl?.requestId === resumed.request.requestId, 'control prompt completed');
  const after = (await h.status()).state; assert.equal(after.lastControl.status, 'completed');
  assert.equal(after.childPid, before.state.childPid); assert.equal(after.permissionMode, before.state.permissionMode);
  const duplicate = await h.control('prompt', resumed.request); assert.equal(duplicate.body.status, 'submitted');
  assert.equal(h.messages.filter(m => m.fixtureReceivedExactly && m.uuid === resumed.request.requestId).length, 1);
  assert.equal((await h.control('prompt', { ...resumed.request, text: 'changed' })).body.status, 'request_id_conflict');
});

test('permission interruption cancels the native request without answering it', { skip: process.platform !== 'win32' }, async t => {
  const h = await harness(t); await h.control('prompt', { text: 'permission' });
  await until(async () => (await h.status()).state.activity === 'waiting_permission', 'permission classified');
  assert.equal((await h.control('interrupt')).body.status, 'acknowledged');
  await until(async () => (await h.status()).state.activity === 'idle', 'permission canceled and turn ended');
  assert.equal(h.messages.some(m => m.type === 'fixture_permission_answer'), false);
});

test('passive capacity remains unknown for a new model and ignores subagent usage', () => {
  const s = new ClaudeProtocolState(randomUUID());
  s.observeNativeUsage({ model: 'first', usedTokens: 100, contextWindowTokens: 200000 });
  s.child({ type: 'assistant', message: { model: 'second', usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } } });
  assert.equal(s.usage.usedTokens, 60); assert.equal(s.usage.usedPercent, null);
  s.child({ type: 'assistant', parent_tool_use_id: 'subagent', message: { model: 'first', usage: { input_tokens: 999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  assert.equal(s.usage.usedTokens, 60);
  s.child({ type: 'result', modelUsage: { second: { contextWindow: 1000, inputTokens: 9999999 } } });
  assert.equal(s.usage.usedPercent, 6); assert.equal(s.usage.usedTokens, 60);
  s.child({ type: 'system', subtype: 'compact_boundary' }); assert.equal(s.usage, null); assert.equal(s.contextEpoch, 1);
});

test('Claude synthetic service messages cannot change the selected model or replace real context usage', () => {
  const s = new ClaudeProtocolState(randomUUID());
  s.child({ type: 'system', subtype: 'init', model: 'claude-real-model' });
  s.observeApiUsage('claude-real-model', { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 400 });
  const before = structuredClone(s.usage);
  s.child({ type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  assert.equal(s.model, 'claude-real-model'); assert.deepEqual(s.usage, before);
});

test('Claude session selection stays distinct from per-response model metadata and tracks acknowledged user changes', () => {
  const s = new ClaudeProtocolState(randomUUID()); s.child({ type: 'system', subtype: 'init', model: 'chosen-model' });
  const usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  s.observeApiUsage('operation-model', usage); assert.equal(s.model, 'chosen-model'); assert.equal(s.usage.model, 'operation-model');
  s.host({ type: 'control_request', request_id: 'model-choice', request: { subtype: 'set_model', model: 'new-choice' } });
  assert.equal(s.model, 'chosen-model');
  s.child({ type: 'control_response', response: { request_id: 'model-choice', subtype: 'success' } });
  assert.equal(s.model, 'new-choice');
  s.observeApiUsage('resolved-api-model', usage); assert.equal(s.model, 'new-choice');
});

test('real wrapper and manager accept long-running handoff plus synthetic notices, then compact and restore once with both receipts', async t => {
  let manager, target;
  const h = await harness(t, [], async ({ directory, id }) => {
    target = { client: 'claude', id, cwd: directory, name: 'isolated maintenance fixture' };
    const adapters = Object.fromEntries(['codex', 'claude', 'opencode'].map(client => [client, { list: async () => ({ sessions: client === 'claude' ? [target] : [] }), find: async value => value === id ? target : null }]));
    manager = await startServer({ root: directory, port: 0, startMonitoring: false, adapters,
      runtimeFactory: () => new ClaudeRuntime(id, { folder: join(directory, 'instances') }) });
    return { env: { COOP_FIXTURE_MANAGER_PATH: join(directory, '.cooperation', 'connection.json') }, close: () => manager.close() };
  });
  const original = (await h.status()).state;
  const policy = manager.store.savePolicy(target, { enabled: true, mode: 'automatic' });
  const sample = await manager.monitor.sample(target, { native: true }); sample.decision = { trigger: 'soft', wasWorkingAtTrigger: false };
  const cycle = await manager.controller.trigger(target, policy, sample);
  await until(() => h.messages.some(m => m.type === 'fixture_pending_checkpoint' && m.stage === 'handoff'), 'native handoff requested');
  manager.store.updateCycle(cycle.id, 'writing_handoff', { deadlineAt: '2000-01-01T00:00:00Z' });
  await manager.controller.advance(cycle.id); assert.equal(manager.store.cycle(cycle.id).state, 'writing_handoff');
  assert.equal((await h.status()).state.model, 'fixture'); h.send({ type: 'fixture_release_checkpoint' });
  await until(async () => manager.store.checkpoint(cycle.id, 'handoff') && (await h.status()).state.activity === 'idle', 'real handoff receipt accepted');
  await manager.controller.advance(cycle.id); await manager.controller.advance(cycle.id); await manager.controller.advance(cycle.id); await manager.controller.advance(cycle.id);
  await until(() => h.messages.some(m => m.type === 'fixture_pending_checkpoint' && m.stage === 'restored'), 'native restore requested');
  h.send({ type: 'fixture_release_checkpoint' });
  await until(async () => manager.store.checkpoint(cycle.id, 'restored') && (await h.status()).state.activity === 'idle', 'real restored receipt accepted');
  await manager.controller.advance(cycle.id);
  assert.equal(manager.store.cycle(cycle.id).state, 'completed');
  assert.deepEqual(h.messages.filter(m => m.type === 'fixture_receipt').map(m => [m.stage, m.status]), [['handoff', 'accepted'], ['restored', 'accepted']]);
  assert.equal(h.messages.filter(m => m.fixtureReceivedExactly && m.message?.content === '/compact').length, 1);
  assert.equal((await h.status()).state.childPid, original.childPid);
});

test('Codex peer wakes a quota-limited Claude; later messages stay queued and configured continuation is sent once before FIFO release', async t => {
  let manager, target, sender, nativeInput; const delivered = [];
  const h = await harness(t, [], async ({ directory, id }) => {
    target = { client: 'claude', id, cwd: directory, name: 'receiver' };
    sender = { client: 'codex', id: randomUUID(), cwd: directory, name: 'sender with available quota' };
    const makeRuntime = () => {
      const runtime = new ClaudeRuntime(id, { folder: join(directory, 'instances') });
      runtime.sendPeer = async input => {
        delivered.push(input); nativeInput({ type: 'fixture_peer_delivery', uuid: input.messageId, text: input.text });
        return { status: 'submitted' };
      }; return runtime;
    };
    const adapters = {
      codex: { list: async () => ({ sessions: [] }), find: async value => value === sender.id ? sender : null },
      claude: { list: async () => ({ sessions: [target] }), find: async value => value === id ? target : null,
        send: async input => makeRuntime().sendMessage(input.text, { requestId: input.messageId }) },
      opencode: { list: async () => ({ sessions: [] }), find: async () => null },
    };
    manager = await startServer({ root: directory, port: 0, startMonitoring: false, adapters, runtimeFactory: makeRuntime });
    await writeFile(join(directory, 'quota-utilization.json'), JSON.stringify({ value: 100 }));
    return { env: { COOP_FIXTURE_MANAGER_PATH: join(directory, '.cooperation', 'connection.json') }, close: () => manager.close() };
  });
  nativeInput = h.send;
  const before = (await h.status()).state;
  manager.store.savePolicy(target, { enabled: true, mode: 'automatic' });
  const values = defaultPromptValues(); values.maintenance.quotaContinue = '使用我保存的提示词继续处理原任务和待处理消息。';
  await new PromptSettings(h.directory).save(values, 0);
  await manager.monitor.sample(target, { native: true });
  const first = await manager.service.send({ from: sender, to: 'claude:' + target.id, message: 'first peer message' });
  assert.equal(first.status, 'submitted');
  const limited = await until(async () => { const s = (await h.status()).state; return s.quota?.kind === 'five_hour' ? s : null; }, 'first peer detects subscription quota');
  assert.equal(limited.quota.autoResume, true); assert.equal(limited.quota.turnId, first.messageId);
  // The management snapshot is still idle here. The final native check must
  // defer this delivery without losing or misreporting it as sent.
  const second = await manager.service.send({ from: sender, to: 'claude:' + target.id, message: 'second peer message' });
  const third = await manager.service.send({ from: sender, to: 'claude:' + target.id, message: 'third peer message' });
  assert.equal(second.status, 'queued'); assert.equal(third.status, 'queued'); assert.equal(delivered.length, 1);
  await manager.controller.tick(); assert.equal(manager.store.getSetting(quotaSettingKey(target)).state, 'waiting');
  assert.equal(h.messages.filter(m => m.fixtureReceivedExactly && m.message?.content === values.maintenance.quotaContinue).length, 0);
  await writeFile(join(h.directory, 'quota-utilization.json'), JSON.stringify({ value: 5 }));
  const waiting = manager.store.getSetting(quotaSettingKey(target));
  manager.store.setSetting(quotaSettingKey(target), { ...waiting, nextCheckAt: '2000-01-01T00:00:00Z' });
  await manager.controller.tick();
  await until(async () => (await h.status()).state.lastControl?.status === 'completed', 'configured continuation completed');
  assert.equal(manager.store.getSetting(quotaSettingKey(target)).state, 'submitted');
  await manager.monitor.sample(target, { native: true }); await manager.service.mailbox.flush();
  assert.deepEqual(delivered.map(m => m.messageId), [first.messageId, second.messageId, third.messageId]);
  assert.equal(manager.store.getMessage(second.messageId).status, 'submitted'); assert.equal(manager.store.getMessage(third.messageId).status, 'submitted');
  await until(async () => (await h.status()).state.activity === 'idle', 'queued peer messages processed');
  await manager.controller.tick(); await manager.service.mailbox.flush();
  assert.equal(h.messages.filter(m => m.fixtureReceivedExactly && m.message?.content === values.maintenance.quotaContinue).length, 1);
  assert.equal(delivered.length, 3); assert.equal((await h.status()).state.childPid, before.childPid);
  assert.equal(manager.store.activeCycle(target), null);
});
