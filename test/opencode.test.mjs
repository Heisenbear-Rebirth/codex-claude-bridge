import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, randomInt } from 'node:crypto';
import { createServer } from 'node:http';
import { createOpenCodeBridge, nativeMessageId, localEndpoint, listenOpenCodeBridge } from '../src/opencode-bridge.mjs';
import { createOpenCodeAdapter } from '../src/adapters/opencode.mjs';
import { createRuntime } from '../src/runtime/factory.mjs';
import { startServer } from '../src/http-server.mjs';
import { ContextMonitor } from '../src/context-monitor.mjs';
import { ManagementStore } from '../src/management-store.mjs';
import { parseAddress, messageEnvelope } from '../src/address.mjs';
import { validatePolicy, evaluatePolicy } from '../src/context-policy.mjs';
import { contextSourcePath } from '../src/context-usage.mjs';
import { detectSender } from '../src/identity.mjs';
import { visiblePeerMessage } from '../src/claude-peer-visibility.mjs';
import { PromptSettings } from '../src/prompt-settings.mjs';
import { defaultPromptValues } from '../public/prompt-templates.mjs';
import { addressOf, visibleAddresses, connectionGuidance, openCodeContextState } from '../public/ui-state.mjs';

async function fixture(t, options = {}) {
  const parent = resolve('.cooperation/opencode-tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-'));
  const sessions = ['ses_TestSenderABC123', 'ses_TestReceiverDEF456'].map(id => ({ id, directory: root, title: id, time: { updated: Date.now() } }));
  const messages = new Map(), calls = [], states = {}, creates = [];
  let loseResponse = false;
  const client = { session: {
    async list() { return { data: [...sessions, { id: 'ses_OtherDirectory123', directory: join(root, 'other') }] }; },
    async get({ path }) { return { data: sessions.find(s => s.id === path.id) }; },
    async status() { return { data: states }; },
    async message({ path }) { return { data: messages.get(path.messageID) }; },
    async messages({ path }) { return { data: [...messages.values()].filter(m => m.info.sessionID === path.id) }; },
    async create(input) {
      creates.push(input);
      const session = { ...input.body, id: 'ses_Created' + creates.length + 'ABC123', directory: root, time: { updated: Date.now() } };
      sessions.push(session);
      if (loseResponse) throw new Error('Lost creation response');
      return { data: session };
    },
    async promptAsync(input) {
      calls.push(input); messages.set(input.body.messageID, { info: { id: input.body.messageID, sessionID: input.path.id, role: 'user' }, parts: input.body.parts });
      if (loseResponse) throw new Error('Lost native response');
      return { data: undefined, response: { ok: true, status: 204 } };
    },
  }, config: { providers: async () => ({ data: { providers: [{ id: 'fixture', models: { actual: { limit: { context: 10000 } } } }] } }) } };
  const bridges = [];
  const connect = async (extra = {}) => { const bridge = await createOpenCodeBridge({ client, directory: root }, { root, acceptUserMessages: true, ...options, ...extra }); bridges.push(bridge); return bridge; };
  const bridge = await connect(), adapter = createOpenCodeAdapter({ root });
  t.after(async () => { for (const b of bridges) await b.close().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  return { root, bridge, adapter, client, calls, states, sessions, connect, messages, creates, lose: () => { loseResponse = true; } };
}

test('OpenCode preserves case-sensitive native addresses and Claude peer provenance guards', () => {
  const s = { client: 'opencode', id: 'ses_NativeMixedCase123', name: 'OpenCode' };
  assert.deepEqual(parseAddress('opencode://title:' + s.id), { client: s.client, id: s.id });
  assert.equal(addressOf(s), 'opencode:' + s.id);
  assert.throws(() => parseAddress('opencode:notASession'), /ses_/);
  const uuid = randomUUID(), sid = randomUUID();
  const frame = { type: 'user', session_id: sid, uuid, isReplay: true, isSynthetic: true, origin: { kind: 'peer' }, message: { role: 'user', content: messageEnvelope(s, 'hello', uuid) } };
  assert.equal(visiblePeerMessage(frame, sid).isSynthetic, false);
  const forged = { ...frame, origin: { kind: 'human' } }; assert.equal(visiblePeerMessage(forged, sid), forged);
  const mismatch = { ...frame, message: { role: 'user', content: frame.message.content.replace('发送方地址：opencode:', '发送方地址：codex:') } };
  assert.equal(visiblePeerMessage(mismatch, sid), mismatch);
  const visible = visibleAddresses([{ id: 'dir' }], [{ ...s, directoryIds: ['dir'] }], new Set(['dir']), new Set(['dir:opencode']));
  assert.deepEqual([...visible], ['opencode:' + s.id]);
  assert.equal(connectionGuidance({ client: 'opencode', status: { reason: 'no_sessions' } }).title, '连接 OpenCode');
});

test('OpenCode native message IDs match native length and monotonic timestamp encoding', () => {
  const before = Date.now(), first = nativeMessageId(), second = nativeMessageId(), after = Date.now();
  assert.match(first, /^msg_[0-9a-f]{26}$/); assert.ok(second > first);
  const milliseconds = BigInt('0x' + first.slice(4, 16)) >> 12n, mask = (1n << 36n) - 1n;
  assert.ok(milliseconds >= (BigInt(before) & mask) && milliseconds <= (BigInt(after) & mask));
  for (const url of ['https://127.0.0.1', 'http://example.com', 'http://127.0.0.1/path', 'http://name:pass@127.0.0.1']) assert.throws(() => localEndpoint(url));
});

test('OpenCode discovers only the registered directory and sends during busy without overriding settings', async t => {
  const f = await fixture(t), targetId = f.sessions[1].id;
  assert.equal((await f.adapter.list({ directory: f.root })).sessions.length, 2);
  f.states[targetId] = { type: 'busy' };
  const runtime = createRuntime({ client: 'opencode', id: targetId }, { opencode: f.adapter });
  assert.equal((await runtime.status()).activity, 'running');
  const messageId = randomUUID(), input = { targetId, messageId, text: 'source-labelled cooperation text', targetSession: { cwd: f.root } };
  const [result, parallel] = await Promise.all([f.adapter.send(input), f.adapter.send(input)]);
  assert.equal(result.nativeMessageId, parallel.nativeMessageId); assert.equal(f.calls.length, 1);
  assert.equal(result.status, 'submitted'); assert.equal(result.nativeRecorded, true);
  assert.equal(result.modelProcessed, false); assert.equal(result.displayConfirmed, false);
  assert.deepEqual(Object.keys(f.calls[0].body).sort(), ['messageID', 'parts']);
  assert.match(f.calls[0].body.parts[0].text, /不是用户的新授权/);
  assert.equal((await runtime.status()).activity, 'running');
  const again = await f.adapter.send(input); assert.equal(again.duplicate, true); assert.equal(f.calls.length, 1);
  await runtime.close();
});

test('OpenCode uncertain sends retain their native ID across plugin restart and never resend', async t => {
  const f = await fixture(t); f.lose();
  const input = { targetId: f.sessions[1].id, text: 'uncertain delivery', messageId: randomUUID() };
  const first = await f.adapter.send(input); assert.equal(first.status, 'unknown');
  await f.bridge.close(); await f.connect();
  const second = await f.adapter.send(input);
  assert.equal(second.nativeMessageId, first.nativeMessageId); assert.equal(second.nativeRecorded, true);
  assert.equal(second.status, 'unknown'); assert.equal(f.calls.length, 1);
  const conflict = await f.adapter.send({ ...input, text: 'different content' }); assert.equal(conflict.status, 'unknown'); assert.equal(f.calls.length, 1);
});

test('OpenCode applies saved or enqueue-time affixes once, including an empty prefix, without reloading the plugin', async t => {
  const f = await fixture(t), settings = new PromptSettings(f.root), values = defaultPromptValues(), targetId = f.sessions[1].id;
  values.messages.opencode = { prefix: 'custom prefix', suffix: 'custom suffix' }; await settings.save(values, 0);
  const firstInput = { targetId, text: 'original', messageId: randomUUID() };
  await f.adapter.send(firstInput);
  assert.equal(f.calls[0].body.parts[0].text, 'custom prefix\n\noriginal\n\ncustom suffix');
  values.messages.opencode = { prefix: 'later prefix', suffix: '' }; await settings.save(values, 1);
  assert.equal((await f.adapter.send(firstInput)).duplicate, true);
  assert.equal(f.calls.length, 1);
  await f.adapter.send({ targetId, text: 'queued', messageId: randomUUID(), messageAffixes: { prefix: '', suffix: 'frozen suffix' } });
  assert.equal(f.calls[1].body.parts[0].text, 'queued\n\nfrozen suffix');
  await f.adapter.send({ targetId, text: 'latest', messageId: randomUUID() });
  assert.equal(f.calls[2].body.parts[0].text, 'later prefix\n\nlatest');
});

test('OpenCode peer delivery preserves the selected model, agent and variant across consecutive messages', async t => {
  const f = await fixture(t), session = f.sessions[1];
  session.model = { providerID: 'selected', id: 'working-model', variant: 'max' }; session.agent = 'plan';
  const original = f.client.session.promptAsync;
  f.client.session.promptAsync = async input => {
    // Match the native behavior: omitted variant is not inherited.
    session.model = { providerID: input.body.model?.providerID, id: input.body.model?.modelID, variant: input.body.variant };
    session.agent = input.body.agent;
    return original(input);
  };
  for (const text of ['first queued message', 'second queued message']) {
    assert.equal((await f.adapter.send({ targetId: session.id, text, messageId: randomUUID() })).status, 'submitted');
    assert.deepEqual(session.model, { providerID: 'selected', id: 'working-model', variant: 'max' });
    assert.equal(session.agent, 'plan');
  }
  for (const call of f.calls) { assert.equal(call.body.variant, 'max'); assert.equal(call.body.tools, undefined); }
});

test('OpenCode peer delivery inherits the last native user selection on older sessions without persisted settings', async t => {
  const f = await fixture(t), target = f.sessions[1], nativeId = nativeMessageId();
  f.messages.set(nativeId, { info: { id: nativeId, sessionID: target.id, role: 'user', time: { created: Date.now() },
    agent: 'build', model: { providerID: 'selected', modelID: 'working-model', variant: 'high' } }, parts: [] });
  await f.adapter.send({ targetId: target.id, text: 'keep the selection', messageId: randomUUID() });
  assert.deepEqual(f.calls[0].body.model, { providerID: 'selected', modelID: 'working-model' });
  assert.equal(f.calls[0].body.agent, 'build'); assert.equal(f.calls[0].body.variant, 'high');
});

test('OpenCode rejects default receive policy, moved directories and duplicate native backends', async t => {
  const f = await fixture(t, { acceptUserMessages: false });
  const disabled = await f.adapter.send({ targetId: f.sessions[1].id, text: 'not opted in', messageId: randomUUID() });
  assert.equal(disabled.status, 'failed'); assert.equal(f.calls.length, 0);
  await assert.rejects(f.adapter.send({ targetId: f.sessions[1].id, targetSession: { cwd: join(f.root, 'other') }, text: 'wrong directory', messageId: randomUUID() }));
  await f.connect(); await assert.rejects(f.adapter.find(f.sessions[0].id), /多个后端/);
  assert.equal(f.calls.length, 0);
});

test('OpenCode bridge requires loopback host, secret, instance and bounded operations', async t => {
  const f = await fixture(t), r = f.bridge.record;
  assert.ok(Number(new URL(r.endpoint).port) >= 20000);
  const competing = createServer(); let choices = 0;
  await listenOpenCodeBridge(competing, () => choices++ === 0 ? Number(new URL(r.endpoint).port) : randomInt(20000, 65536));
  assert.ok(choices >= 2); await new Promise(resolve => competing.close(resolve));
  const request = (body, headers = {}) => fetch(r.endpoint + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + r.token, ...headers }, body: JSON.stringify(body) });
  assert.equal((await request({ action: 'list', instanceId: r.instanceId }, { Authorization: 'Bearer invalid' })).status, 403);
  assert.equal((await request({ action: 'list', instanceId: randomUUID() })).status, 400);
  assert.equal((await request({ action: 'list', instanceId: r.instanceId }, { Origin: r.endpoint })).status, 403);
  assert.equal((await request({ action: 'abort', instanceId: r.instanceId })).status, 400);
  await assert.rejects(f.adapter.verifySender({ instanceId: r.instanceId, proof: 'a'.repeat(64) }));
});

test('OpenCode native tool identity sends through isolated manager; caller-supplied from is refused', async t => {
  const f = await fixture(t);
  const manager = await startServer({ root: f.root, port: 0, adapters: { opencode: f.adapter }, startMonitoring: false });
  try {
    const context = { directory: f.root, sessionID: f.sessions[0].id, messageID: nativeMessageId(), abort: new AbortController().signal,
      ask: async request => { assert.equal(request.permission, 'cooperation_send_message'); } };
    const args = { to: 'opencode:' + f.sessions[1].id, message: 'verified native sender' };
    const result = JSON.parse(await f.bridge.sendMessage(args, context)); assert.equal(result.status, 'submitted');
    const saved = manager.store.getMessage(result.messageId); assert.equal(saved.from.id, context.sessionID); assert.ok(saved.nativeMessageId);
    assert.equal(saved.source.kind, 'opencode-tool-context'); assert.equal(saved.source.nativeMessageId, context.messageID);
    assert.equal(saved.source.instanceId, f.bridge.record.instanceId);
    assert.match(f.calls[0].body.parts[0].text, new RegExp('发送方地址：opencode:' + context.sessionID));
    await assert.rejects(f.bridge.sendMessage({ ...args, from: 'forged' }, context), /Only to and message/);
    await assert.rejects(f.bridge.sendMessage(args, { ...context, directory: join(f.root, 'other') }), /ToolContext/);
    const connection = JSON.parse(await readFile(join(f.root, '.cooperation/connection.json'), 'utf8'));
    for (const client of ['opencode', 'OpenCode', ' opencode']) {
      const forged = await fetch(manager.url + '/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + connection.token },
        body: JSON.stringify({ ...args, from: { client, id: context.sessionID } }) });
      assert.equal(forged.status, 400);
    }
    assert.equal(f.calls.length, 1);
    const config = await (await fetch(manager.url + '/api/config')).json();
    const filter = await (await fetch(manager.url + '/api/messages?addresses=' + encodeURIComponent(JSON.stringify(['opencode:' + context.sessionID])))).json();
    assert.equal(filter.messages.length, 1);
    const rejected = await fetch(manager.url + '/api/policies', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Coop-UI': config.csrfToken }, body: JSON.stringify({ address: args.to, policy: { autoCompress: true } }) });
    assert.equal(rejected.status, 400);
  } finally { await manager.close(); }
});

test('OpenCode observation cannot read legacy logs, request maintenance or use guessed CLI identity', async t => {
  const f = await fixture(t), store = await new ManagementStore(join(f.root, '.cooperation')).init();
  const monitor = new ContextMonitor({ store, service: { adapters: { opencode: f.adapter } } });
  try {
    const sample = await monitor.sample({ client: 'opencode', id: f.sessions[0].id, cwd: f.root });
    assert.equal(sample.usage, null); assert.equal(sample.runtime.connected, true); assert.equal(sample.runtime.capabilities.automaticMaintenance, false);
    assert.equal(sample.decision.action, 'disabled');
    const runtime = createRuntime(sample.session, { opencode: f.adapter });
    await assert.rejects(runtime.compact(), /尚未就绪/); await assert.rejects(runtime.interrupt(), /尚未就绪/);
    await assert.rejects(contextSourcePath(sample.session), /not supported/);
    await assert.rejects(detectSender({ client: 'opencode', metadata: { sessionID: f.sessions[0].id } }), /原生插件/);
    assert.equal(validatePolicy({ session: sample.session, enabled: true, softPercent: 50, hardPercent: 80 }).enabled, true);
    assert.equal(evaluatePolicy({ policy: { enabled: true, session: sample.session }, runtime: { connected: true, activity: 'idle' }, usage: { usedTokens: 90, contextWindowTokens: 100 } }).action, 'disabled');
  } finally { monitor.close(); store.close(); }
});

test('Native OpenCode usage reaches the monitor and full-capacity percentage without enabling maintenance', async t => {
  const f = await fixture(t), session = { client: 'opencode', id: f.sessions[0].id, cwd: f.root };
  f.messages.set('msg_Usage', { info: { id: 'msg_Usage', sessionID: session.id, role: 'assistant', modelID: 'actual', providerID: 'fixture',
    time: { created: Date.now(), completed: Date.now() }, tokens: { total: 1234 } }, parts: [] });
  const store = await new ManagementStore(join(f.root, '.cooperation')).init();
  const monitor = new ContextMonitor({ store, service: { adapters: { opencode: f.adapter } } });
  try {
    const sample = await monitor.sample(session);
    assert.equal(sample.usage.usedTokens, 1234); assert.equal(sample.usage.usedPercent, 12.34);
    assert.equal(sample.runtime.capabilities.automaticMaintenance, false);
    assert.equal(store.getSnapshot(session).usage.contextWindowTokens, 10000);
  } finally { monitor.close(); store.close(); }
});

test('OpenCode usage diagnostics distinguish old plugins, missing samples, failures and recovery through HTTP', async t => {
  const f = await fixture(t), session = { client: 'opencode', id: f.sessions[0].id, cwd: f.root };
  const manager = await startServer({ root: f.root, port: 0, adapters: { opencode: f.adapter }, startMonitoring: false });
  assert.ok(Number(new URL(manager.url).port) >= 20000);
  try {
    const config = await (await fetch(manager.url + '/api/config')).json();
    const sample = async () => {
      const response = await fetch(manager.url + '/api/runtime', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Coop-UI': config.csrfToken },
        body: JSON.stringify({ address: addressOf(session), native: true }) });
      assert.equal(response.status, 200);
      return response.json();
    };
    const nativeStatus = f.adapter.status;
    f.adapter.status = async () => ({ connected: true, activity: 'running', capabilities: { readActivity: true }, usage: null });
    let monitoring = await sample();
    assert.equal(openCodeContextState({ ...session, monitoring }).label, '插件需要重新加载');
    assert.match(openCodeContextState({ ...session, monitoring }).detail, /当前任务结束后.*重新打开 OpenCode/);
    f.adapter.status = nativeStatus;
    monitoring = await sample();
    assert.equal(monitoring.runtime.usageState, 'no_measurement');
    assert.equal(openCodeContextState({ ...session, monitoring }).label, '等待原生回复统计');
    const nativeMessages = f.client.session.messages;
    f.client.session.messages = async () => { throw new Error('private native failure'); };
    monitoring = await sample();
    assert.equal(monitoring.runtime.connected, true); assert.equal(monitoring.runtime.usageState, 'query_failed');
    assert.equal(openCodeContextState({ ...session, monitoring }).label, '上下文读取失败');
    assert.ok(!JSON.stringify(monitoring).includes('private native failure'));
    f.client.session.messages = nativeMessages;
    const message = { info: { id: 'msg_Diagnostics', sessionID: session.id, role: 'assistant', modelID: 'unlisted', providerID: 'fixture',
      time: { created: Date.now(), completed: Date.now() }, tokens: { total: 2345 } }, parts: [] };
    f.messages.set(message.info.id, message);
    monitoring = await sample();
    assert.equal(monitoring.usage.usedTokens, 2345); assert.equal(monitoring.runtime.usageState, 'capacity_unknown');
    assert.equal(openCodeContextState({ ...session, monitoring }).label, '模型容量未知');
    message.info.modelID = 'actual';
    monitoring = await sample();
    assert.equal(monitoring.runtime.usageState, 'ready'); assert.equal(monitoring.usage.usedPercent, 23.45);
    assert.equal(openCodeContextState({ ...session, monitoring }).label, '上下文已接入');
    assert.equal(monitoring.runtime.capabilities.automaticMaintenance, false);
    assert.equal(openCodeContextState({ ...session, monitoring: { runtime: { connected: false } } }).label, 'OpenCode 未连接');
    assert.equal(openCodeContextState(session).label, '等待上下文状态');
    assert.equal(openCodeContextState({ client: 'claude' }), null);
    assert.equal(f.calls.length, 0); assert.equal(f.creates.length, 0);
  } finally { await manager.close(); }
});

test('OpenCode native lifecycle identity creates once, inherits settings, connects unchanged and sends through FIFO', async t => {
  const f = await fixture(t);
  f.sessions[0].model = { id: 'actual', providerID: 'fixture' }; f.sessions[0].agent = 'plan';
  f.sessions[0].permission = [{ permission: 'bash', pattern: '*', action: 'deny' }];
  const manager = await startServer({ root: f.root, port: 0, adapters: { opencode: f.adapter }, startMonitoring: false });
  try {
    const context = { directory: f.root, sessionID: f.sessions[0].id, messageID: nativeMessageId(), abort: new AbortController().signal, ask: async () => {} };
    const args = { requestId: 'native-create-001', client: 'opencode', directory: f.root, title: 'New independent session' };
    const [a, b] = await Promise.all([f.bridge.lifecycle('create', args, context), f.bridge.lifecycle('create', args, context)]);
    const result = JSON.parse(a); assert.equal(result.status, 'created'); assert.equal(result.address, JSON.parse(b).address); assert.equal(f.creates.length, 1);
    assert.equal(f.creates[0].body.parentID, undefined); assert.deepEqual(f.creates[0].body.model, f.sessions[0].model);
    assert.equal(f.creates[0].body.agent, 'plan'); assert.deepEqual(f.creates[0].body.permission.at(-1), f.sessions[0].permission[0]);
    assert.equal(result.displayConfirmed, false); assert.equal(result.sendReady, true);
    const connected = JSON.parse(await f.bridge.lifecycle('connect', { requestId: 'native-connect-001', directory: f.root, to: result.address }, context));
    assert.equal(connected.address, result.address); assert.equal(connected.status, 'connected'); assert.equal(f.creates.length, 1);
    const sent = JSON.parse(await f.bridge.sendMessage({ to: result.address, message: 'authorized initial task' }, context));
    assert.equal(sent.status, 'submitted'); assert.equal(manager.store.getMessage(sent.messageId).from.id, context.sessionID);
    assert.equal(manager.store.getPolicy(result.session), null);
    await assert.rejects(f.bridge.lifecycle('create', { ...args, title: 'Conflicting title' }, context));
    assert.equal(f.creates.length, 1);
  } finally { await manager.close(); }
});

test('Unknown native creation reconciles by metadata across manager and plugin restart without a second create', async t => {
  const f = await fixture(t); f.lose();
  let manager = await startServer({ root: f.root, port: 0, adapters: { opencode: f.adapter }, startMonitoring: false });
  const args = { requestId: 'lost-response-001', client: 'opencode', directory: f.root };
  const origin = { kind: 'management-ui' };
  try {
    const first = await manager.service.lifecycle.execute('create', args, origin);
    assert.equal(first.status, 'unknown'); assert.equal(f.creates.length, 1);
    await manager.close(); await f.bridge.close(); await f.connect();
    manager = await startServer({ root: f.root, port: 0, adapters: { opencode: f.adapter }, startMonitoring: false });
    const result = await manager.service.lifecycle.execute('create', args, origin);
    assert.equal(result.status, 'created'); assert.equal(result.operationId, first.operationId); assert.equal(f.creates.length, 1);
  } finally { await manager.close(); }
});

test('Lifecycle rejects out-of-scope, forged identity, native proof replay and CSRF before any creation', async t => {
  const f = await fixture(t), manager = await startServer({ root: f.root, port: 0, adapters: { opencode: f.adapter }, startMonitoring: false });
  try {
    const args = { requestId: 'guards-create-001', client: 'opencode', directory: f.root };
    await assert.rejects(manager.service.lifecycle.execute('create', { ...args, directory: join(f.root,'outside') }, { kind: 'management-ui' }), /精确目录/);
    await assert.rejects(manager.service.lifecycle.execute('create', { ...args, from: 'forged' }, { kind: 'management-ui' }), /字段/);
    await assert.rejects(manager.service.lifecycle.execute('create', args, {}), /身份/);
    const connection = JSON.parse(await readFile(join(f.root, '.cooperation/connection.json'), 'utf8'));
    const post = (path, body, headers = {}) => fetch(manager.url+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    assert.equal((await post('/api/ui/lifecycle',{action:'create',args})).status,403);
    const config=await(await fetch(manager.url+'/api/config')).json();
    const rejected=await post('/api/ui/lifecycle',{action:'create',args:{...args,directory:join(f.root,'outside')}},{'X-Coop-UI':config.csrfToken});
    assert.equal((await rejected.json()).notSubmitted,true);
    assert.equal((await post('/api/lifecycle',{action:'create',args,from:{client:'opencode',id:f.sessions[0].id}},{Authorization:'Bearer '+connection.token})).status,400);
    assert.equal((await post('/api/opencode/lifecycle',{instanceId:f.bridge.record.instanceId,proof:'a'.repeat(64)},{Authorization:'Bearer '+connection.token})).status,400);
    assert.equal(f.creates.length,0);
  } finally { await manager.close(); }
});

test('Unknown creation without native evidence remains durable; directory and maintenance guards run before creation', async t => {
  const f=await fixture(t);let creates=0;
  const nativeCreate=f.adapter.createSession;
  f.adapter.createSession=async()=>{creates++;throw new Error('Transport lost before evidence');};
  let manager=await startServer({root:f.root,port:0,adapters:{opencode:f.adapter},startMonitoring:false});
  const args={requestId:'no-evidence-001',client:'opencode',directory:f.root};
  try{
    const first=await manager.service.lifecycle.execute('create',args,{kind:'management-ui'});assert.equal(first.status,'unknown');
    await manager.close();manager=await startServer({root:f.root,port:0,adapters:{opencode:f.adapter},startMonitoring:false});
    assert.equal((await manager.service.lifecycle.execute('create',args,{kind:'management-ui'})).status,'unknown');assert.equal(creates,1);
    f.adapter.createSession=nativeCreate;
    const source={client:'opencode',id:f.sessions[0].id,cwd:f.root};manager.store.createCycle({session:source,state:'writing_handoff'});
    await assert.rejects(manager.service.lifecycle.execute('create',{...args,requestId:'maintenance-001'},{kind:'opencode-tool-context',from:source}),/正在维护/);
    assert.equal(f.creates.length,0);
  }finally{await manager.close();}
});

test('Unverified Codex and Claude creation is explicit, while loaded instances can be checked without waking them', async t => {
  const f = await fixture(t), id = randomUUID(); let checks = 0;
  const adapters = Object.fromEntries(['codex','claude'].map(client => [client,{find:async()=>({client,id,cwd:f.root})}]));
  const manager = await startServer({ root:f.root,port:0,startMonitoring:false,adapters,runtimeFactory:()=>({status:async()=>{checks++;return{connected:true,capabilities:{}};},close(){}}) });
  try {
    for (const client of ['codex','claude']) {
      assert.equal((await manager.service.lifecycle.execute('create',{requestId:'unsupported-'+client,client,directory:f.root},{kind:'management-ui'})).status,'unsupported');
      const r=await manager.service.lifecycle.execute('connect',{requestId:'connect-'+client,to:client+':'+id.toUpperCase(),directory:f.root},{kind:'management-ui'});
      assert.equal(r.status,'connected'); assert.equal(r.displayConfirmed,false);
    }
    assert.equal(checks,2);
  } finally { await manager.close(); }
});
