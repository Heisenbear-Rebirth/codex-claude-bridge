import { createServer } from 'node:http';
import { randomBytes, randomUUID, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseAddress } from './address.mjs';
import { openCodeUsage } from './opencode-usage.mjs';
import { readAccessPolicy } from './access-policy.mjs';
import { OpenCodeMaintenance } from './opencode-maintenance.mjs';
import { readPromptSettings } from './prompt-settings.mjs';
import { applyMessageAffixes, validatePromptValues } from '../public/prompt-templates.mjs';

export const installationRoot = resolve(import.meta.dirname, '..');
export const sameDirectory = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
const digest = text => createHash('sha256').update(text).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const sessionId = value => typeof value === 'string' && /^ses_[A-Za-z0-9_-]{8,128}$/.test(value);
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function localEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('OpenCode bridge requires an exact loopback endpoint.');
  return url.origin;
}
let clock = 0n;
export function nativeMessageId() {
  // OpenCode 1.18 IDs encode the low 48 bits of milliseconds * 4096.
  const now = BigInt(Date.now()) * 4096n;
  clock = now > clock ? now : clock + 1n;
  return 'msg_' + BigInt.asUintN(48, clock).toString(16).padStart(12, '0') + randomBytes(7).toString('hex');
}
const capabilities = { readActivity: true, sendMessage: true, automaticMaintenance: false, sendControl: false, compact: false, interrupt: false, observeCompletion: false };

export async function listenOpenCodeBridge(server, choosePort = () => randomInt(20000, 65536)) {
  // Windows may allocate port 0 from a low custom dynamic range. Some such
  // ports (e.g. 6000/6667/10080) are rejected by the native Fetch client.
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      await new Promise((ok, fail) => {
        const error = e => { server.off('listening', ready); fail(e); };
        const ready = () => { server.off('error', error); ok(); };
        server.once('error', error); server.once('listening', ready);
        server.listen(choosePort(), '127.0.0.1');
      });
      return;
    } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
  }
  throw new Error('No available local OpenCode bridge port.');
}

// The SDK client is supplied by OpenCode itself, including an in-process fetch
// for standalone TUI. Never start a replacement backend or copy provider keys.
export async function createOpenCodeBridge({ client, directory }, { root = installationRoot, directories = [root], acceptUserMessages = false, maintenanceHooks = false } = {}) {
  (await readAccessPolicy()).assert(directory);
  if (!directories.some(d => sameDirectory(d, directory))) throw new Error('OpenCode directory is not explicitly enabled for Cooperation.');
  const folder = join(root, '.cooperation', 'opencode', 'instances');
  const ledger = join(root, '.cooperation', 'opencode', 'deliveries');
  await mkdir(folder, { recursive: true }); await mkdir(ledger, { recursive: true });
  const instanceId = randomUUID(), token = randomBytes(32).toString('hex'), proofs = new Map(), inFlight = new Map();
  const query = { directory };
  const maintenance = new OpenCodeMaintenance({ client, native, root, directory, instanceId, hooks: maintenanceHooks });
  let modelCatalog = [], catalogAt = 0;
  async function usage(id) {
    const session = await native('get', id);
    const messages = await native('messages', id, { query: { ...query, limit: 100 } });
    if (Date.now() - catalogAt > 60000) {
      try {
        const result = await client.config.providers({ query, signal: AbortSignal.timeout(10000) });
        if (result.error || result.response && !result.response.ok) throw new Error('Model catalog unavailable');
        // Retain only model IDs and capacities, never provider credentials/options.
        modelCatalog = (result.data?.providers || []).map(p => ({ id: p.id, models: Object.fromEntries(Object.entries(p.models || {}).map(([id, m]) => [id, { limit: { context: m.limit?.context } }])) }));
        catalogAt = Date.now();
      } catch { modelCatalog = []; }
    }
    return openCodeUsage(session, messages, modelCatalog);
  }
  async function native(method, id, extra = {}) {
    const result = await client.session[method]({ query, ...(id ? { path: { id } } : {}), signal: AbortSignal.timeout(10000), ...extra });
    if (result.error || result.response && !result.response.ok) throw new Error('OpenCode native request failed (' + (result.response?.status || 'unknown') + ').');
    return result.data;
  }
  async function find(id) {
    if (!sessionId(id)) throw new Error('Invalid OpenCode session ID.');
    const session = await native('get', id);
    if (!session || session.id !== id || !sameDirectory(session.directory, directory) || session.parentID || session.time?.archived) return null;
    return { client: 'opencode', id, cwd: directory, name: session.title || 'OpenCode', live: true, status: 'connected',
      updatedAt: Number.isFinite(session.time?.updated) ? new Date(session.time.updated).toISOString() : null };
  }
  async function connection(id, status = 'connected') {
    const session = await find(id);
    if (!session) throw new Error('Native session unavailable.');
    return { status, session, nativeRecorded: true, hostReachable: true, loaded: true, sendReady: acceptUserMessages,
      instanceId, displayConfirmed: false, modelProcessed: false, reopenConfirmed: false,
      detail: '已连接同一原生后端，可通过返回地址通信；原生窗口显示需单独核对。' };
  }
  async function reconcileCreate(operationId) {
    if (!uuid(operationId)) throw new Error('Invalid operation ID.');
    try {
      const entry = JSON.parse(await readFile(join(root, '.cooperation', 'opencode', 'session-operations', operationId + '.json'), 'utf8'));
      if (entry.nativeSessionId) {
        const session = await native('get', entry.nativeSessionId);
        if (session?.metadata?.cooperationOperationId === operationId && sameDirectory(session.directory, directory)) return connection(session.id, 'created');
      }
    } catch { /* A missing local completion record still permits read-only native reconciliation. */ }
    const sessions = (await native('list')).filter(s => sameDirectory(s.directory, directory) && !s.parentID && !s.time?.archived
      && s.metadata?.cooperationOperationId === operationId);
    if (sessions.length > 1) throw new Error('Native operation is ambiguous.');
    return sessions.length ? connection(sessions[0].id, 'created') : { status: 'unknown', detail: '尚未核实原生创建记录；不会重试创建。' };
  }
  async function createSession(input) {
    if (!sameDirectory(input.cwd, directory) || !uuid(input.operationId)) throw new Error('Invalid creation scope.');
    const folder = join(root, '.cooperation', 'opencode', 'session-operations');
    await mkdir(folder, { recursive: true });
    const file = join(folder, input.operationId + '.json');
    const fingerprint = digest(JSON.stringify([directory, input.title, input.source?.client, input.source?.id]));
    let old;
    try { old = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (old) {
      if (old.fingerprint !== fingerprint) throw new Error('Creation ID conflict.');
      return reconcileCreate(input.operationId);
    }
    const body = { ...(input.title ? { title: input.title } : {}), metadata: { cooperationOperationId: input.operationId },
      permission: [{ permission: '*', pattern: '*', action: 'ask' }] };
    if (input.source?.client === 'opencode') {
      if (!await find(input.source.id)) throw new Error('Source session unavailable.');
      const source = await native('get', input.source.id);
      if (source.model) body.model = source.model;
      if (source.agent) body.agent = source.agent;
      if (source.permission?.length) body.permission = [...body.permission, ...source.permission];
    }
    // No parentID: independent native session, not a hidden subagent.
    const entry = { fingerprint, operationId: input.operationId, status: 'unknown', createdAt: new Date().toISOString() };
    await writeFile(file, JSON.stringify(entry), { flag: 'wx', mode: 0o600 });
    const created = await native('create', null, { body });
    if (!created || !sameDirectory(created.directory, directory) || created.parentID || !sessionId(created.id)) throw new Error('Native creation identity mismatch.');
    const temporary = file + '.' + randomUUID() + '.tmp';
    try { await writeFile(temporary, JSON.stringify({ ...entry, status: 'created', nativeSessionId: created.id }), { mode: 0o600 }); await rename(temporary, file); }
    finally { await unlink(temporary).catch(() => {}); }
    return connection(created.id, 'created');
  }
  async function evidence(entry) {
    const result = await native('message', entry.targetId, { path: { id: entry.targetId, messageID: entry.nativeMessageId } });
    const matched = result?.info?.id === entry.nativeMessageId && result.info.sessionID === entry.targetId && result.info.role === 'user'
      && digest((result.parts || []).filter(p => p.type === 'text').map(p => p.text).join('\n')) === entry.nativeTextHash;
    return { nativeRecorded: matched, modelProcessed: false, displayConfirmed: false };
  }
  async function promptSelection(id) {
    const session = await native('get', id);
    let model = session.model, agent = session.agent;
    if (!model || !agent) {
      const rows = await native('messages', id, { query: { directory, limit: 100 } });
      const user = rows.filter(row => row.info?.role === 'user' && row.info.sessionID === id
        && (!session.revert?.messageID || row.info.id < session.revert.messageID))
        .sort((a, b) => (a.info.time?.created || 0) - (b.info.time?.created || 0) || a.info.id.localeCompare(b.info.id)).at(-1);
      model ||= user?.info.model; agent ||= user?.info.agent;
    }
    return { ...(model?.providerID && (model.id || model.modelID) ? { model: { providerID: model.providerID, modelID: model.id || model.modelID } } : {}),
      ...(agent ? { agent } : {}), ...(model?.variant !== undefined ? { variant: model.variant } : {}) };
  }
  async function send(input) {
    if (!acceptUserMessages) throw new Error('OpenCode 原生 user 消息接收尚未显式开启。');
    if (!uuid(input.messageId) || typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 300 * 1024) throw new Error('Invalid Cooperation message.');
    if (!sameDirectory(input.cwd, directory) || !await find(input.targetId)) throw new Error('OpenCode target directory or session changed.');
    const prompts = (await readPromptSettings(root)).values;
    if (input.messageAffixes !== undefined) prompts.messages.opencode = input.messageAffixes;
    const text = applyMessageAffixes(input.text, validatePromptValues(prompts).messages.opencode);
    const filename = join(ledger, input.messageId + '.json');
    const fingerprint = digest(JSON.stringify([input.targetId, directory, text]));
    const inputFingerprint = digest(JSON.stringify([input.targetId, directory, input.text, input.messageAffixes || null]));
    let old;
    try { old = JSON.parse(await readFile(filename, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (old) {
      if (old.inputFingerprint ? old.inputFingerprint !== inputFingerprint : old.fingerprint !== fingerprint) throw new Error('Cooperation message ID was reused with different content or target.');
      return { ...old.result, nativeMessageId: old.nativeMessageId, ...(await evidence(old).catch(() => ({ nativeRecorded: false }))), duplicate: true };
    }
    const entry = { fingerprint, inputFingerprint, targetId: input.targetId, nativeMessageId: nativeMessageId(), nativeTextHash: digest(text),
      instanceId, createdAt: new Date().toISOString(), result: { status: 'unknown', transport: 'opencode-plugin', nativeRecorded: false, modelProcessed: false, displayConfirmed: false } };
    // Persist intent before native submission. A crash or lost response never retries it.
    await writeFile(filename, JSON.stringify(entry), { flag: 'wx', mode: 0o600 });
    try {
      // Native prompt_async clears an omitted variant. Explicitly inherit the
      // current selection so FIFO messages cannot reset reasoning after restore.
      const selection = await promptSelection(input.targetId);
      await native('promptAsync', input.targetId, { body: { messageID: entry.nativeMessageId, ...selection, parts: [{ type: 'text', text }] } });
      entry.result = { ...entry.result, status: 'submitted', detail: 'OpenCode 已接受原生 user 消息；模型处理与界面显示需独立核对。',
        ...(await evidence(entry).catch(() => ({ nativeRecorded: false }))) };
    } catch { entry.result.detail = 'OpenCode 投递结果不确定，请核对原生消息；不会自动重发。'; }
    await writeFile(filename, JSON.stringify(entry), { mode: 0o600 });
    return { ...entry.result, nativeMessageId: entry.nativeMessageId, instanceId };
  }
  async function dispatch(input) {
    if (input.instanceId !== instanceId) throw new Error('OpenCode bridge instance changed.');
    if (input.action === 'identity') {
      const proof = proofs.get(input.proof);
      if (!proof) throw new Error('No active native send_message invocation.');
      proofs.delete(input.proof); return proof;
    }
    if (input.action === 'list') {
      const sessions = await native('list');
      return { sessions: (sessions || []).filter(s => sameDirectory(s.directory, directory) && !s.parentID && !s.time?.archived)
        .map(s => ({ client: 'opencode', id: s.id, cwd: directory, name: s.title || 'OpenCode', live: true, status: 'connected', updatedAt: Number.isFinite(s.time?.updated) ? new Date(s.time.updated).toISOString() : null })), warnings: [] };
    }
    if (input.action === 'find') return find(input.targetId);
    if (input.action === 'lifecycle') return { create: true, connect: true, directory, instanceId };
    if (input.action === 'reconcile-create') {
      if (!sameDirectory(input.cwd, directory)) throw new Error('Directory mismatch.');
      return reconcileCreate(input.operationId);
    }
    if (input.action === 'connect') {
      if (!sameDirectory(input.cwd, directory)) throw new Error('Directory mismatch.');
      return connection(input.targetId);
    }
    if (input.action === 'create') return createSession(input);
    if (input.action === 'maintenance') {
      if (!await find(input.targetId)) throw new Error('OpenCode session unavailable.');
      return maintenance.operate(input);
    }
    if (input.action === 'status') {
      if (!await find(input.targetId)) throw new Error('OpenCode session unavailable.');
      const state = (await native('status'))?.[input.targetId];
      let measuredUsage = null, usageState = 'not_requested';
      if (input.includeUsage !== false) {
        try {
          measuredUsage = await usage(input.targetId);
          usageState = !measuredUsage ? 'no_measurement' : measuredUsage.contextWindowTokens > 0 ? 'ready' : 'capacity_unknown';
        } catch { usageState = 'query_failed'; }
      }
      let observed = null, maintenanceError = null;
      if (maintenance.supported) {
        try { observed = await maintenance.status(input.targetId); }
        catch { maintenanceError = '原生维护状态暂不可核对，自动维护已暂停。'; }
      }
      if (measuredUsage && observed?.contextEpoch) measuredUsage.contextEpoch = observed.contextEpoch;
      return { sessionId: input.targetId, cwd: directory, instanceId, connected: true,
        activity: !state || state.type === 'idle' ? 'idle' : ['busy', 'retry'].includes(state.type) ? 'running' : 'unknown',
        observedAt: new Date().toISOString(), ...observed,
        capabilities: { ...capabilities, ...observed?.capabilities, passiveUsage: true, sendMessage: acceptUserMessages },
        maintenanceError, usage: measuredUsage, usageState };
    }
    if (input.action === 'send') {
      const fingerprint = digest(JSON.stringify([input.targetId, input.cwd, input.text, input.messageAffixes]));
      if (inFlight.has(input.messageId)) {
        const pending = inFlight.get(input.messageId);
        if (pending.fingerprint !== fingerprint) throw new Error('Message ID conflict.');
        return pending.work;
      }
      const work = send(input).finally(() => inFlight.delete(input.messageId)); inFlight.set(input.messageId, { fingerprint, work }); return work;
    }
    throw new Error('Unsupported OpenCode bridge operation.');
  }
  const server = createServer(async (request, response) => {
    const reply = (code, value) => { response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    if (request.headers.host !== new URL(record.endpoint).host || request.headers.origin || request.headers['sec-fetch-site'] === 'cross-site'
      || !equal(request.headers.authorization, 'Bearer ' + token)) return reply(403, { error: 'OpenCode bridge authentication required.' });
    if (request.method !== 'POST' || request.url !== '/rpc' || !String(request.headers['content-type']).startsWith('application/json')) return reply(404, { error: 'Unknown operation.' });
    try {
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; if (length > 1024 * 1024) throw new Error('Request too large.'); chunks.push(chunk); }
      reply(200, await dispatch(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    } catch { reply(400, { error: 'OpenCode bridge request rejected; check target, instance and receive opt-in.' }); }
  });
  await listenOpenCodeBridge(server);
  server.unref();
  const record = { instanceId, token, endpoint: 'http://127.0.0.1:' + server.address().port, directory, pid: process.pid, startedAt: new Date().toISOString(), protocol: 1 };
  const registration = join(folder, instanceId + '.json');
  await writeFile(registration, JSON.stringify(record), { mode: 0o600 });
  return {
    record,
    beforeMessage: (input, output) => maintenance.beforeMessage(input, output),
    event: input => maintenance.event(input),
    async checkpoint(args, context) {
      if (!context || context.abort?.aborted || !sameDirectory(context.directory, directory) || !sessionId(context.sessionID)
        || !/^msg_/.test(context.messageID || '') || !await find(context.sessionID)) throw new Error('Missing native checkpoint identity.');
      if (Object.keys(args).some(k => !['cycleId','stage','receiptToken','documentPath'].includes(k))) throw new Error('Invalid checkpoint arguments.');
      const message = await native('message', context.sessionID, { path: { id: context.sessionID, messageID: context.messageID } });
      if (message?.info?.role !== 'assistant' || message.info.sessionID !== context.sessionID || !message.info.parentID) throw new Error('Invalid checkpoint control turn.');
      const proof = randomBytes(32).toString('hex');
      proofs.set(proof, { action: 'checkpoint', args, from: { client: 'opencode', id: context.sessionID }, cwd: directory,
        nativeMessageId: context.messageID, nativeUserMessageId: message.info.parentID });
      try {
        const connection = JSON.parse(await readFile(join(root, '.cooperation', 'connection.json'), 'utf8'));
        const response = await fetch(localEndpoint(connection.url) + '/api/opencode/checkpoint', { method: 'POST', redirect: 'error',
          headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId, proof }), signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error('维护回执被拒绝，请核对阶段、控制轮次和交付文档。');
        return JSON.stringify(await response.json());
      } finally { proofs.delete(proof); }
    },
    async lifecycle(action, args, context) {
      if (!['create', 'connect'].includes(action) || Object.keys(args).some(k => !['requestId','client','directory','title','to','prompt'].includes(k))) throw new Error('Invalid lifecycle arguments.');
      if (!context || !sameDirectory(context.directory, directory) || !sessionId(context.sessionID) || !/^msg_/.test(context.messageID || '') || context.abort?.aborted || !await find(context.sessionID)) throw new Error('Missing native ToolContext identity.');
      if (!sameDirectory(args.directory, directory)) throw new Error('Lifecycle target must be this native project directory.');
      await context.ask({ permission: 'cooperation_' + action + '_session', patterns: [args.to || args.client + ':' + directory], always: [], metadata: { action, directory, client: args.client, to: args.to } });
      const proof = randomBytes(32).toString('hex');
      proofs.set(proof, { action, args, from: { client: 'opencode', id: context.sessionID }, nativeMessageId: context.messageID, cwd: directory });
      try {
        const connection = JSON.parse(await readFile(join(root, '.cooperation', 'connection.json'), 'utf8'));
        const response = await fetch(localEndpoint(connection.url) + '/api/opencode/lifecycle', { method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ instanceId, proof }), signal: AbortSignal.timeout(45000) });
        if (!response.ok) throw new Error('Lifecycle request rejected.');
        return JSON.stringify(await response.json());
      } catch { throw new Error('会话操作未确认，请使用相同 requestId 和参数核对。'); }
      finally { proofs.delete(proof); }
    },
    async sendMessage(args, context) {
      if (!context || !sameDirectory(context.directory, directory) || !sessionId(context.sessionID) || !/^msg_/.test(context.messageID || '') || context.abort?.aborted)
        throw new Error('Missing native OpenCode ToolContext identity.');
      if (Object.keys(args).some(k => !['to', 'message'].includes(k))) throw new Error('Only to and message are accepted; sender comes from ToolContext.');
      parseAddress(args.to);
      if (typeof args.message !== 'string' || !args.message.trim() || Buffer.byteLength(args.message) > 256 * 1024) throw new Error('Invalid message.');
      if (!await find(context.sessionID)) throw new Error('Native sender session unavailable.');
      await context.ask({ permission: 'cooperation_send_message', patterns: [args.to], always: [], metadata: { to: args.to } });
      const proof = randomBytes(32).toString('hex');
      proofs.set(proof, { from: { client: 'opencode', id: context.sessionID }, to: args.to, message: args.message, nativeMessageId: context.messageID, cwd: directory });
      try {
        const connection = JSON.parse(await readFile(join(root, '.cooperation', 'connection.json'), 'utf8'));
        const endpoint = localEndpoint(connection.url);
        const response = await fetch(endpoint + '/api/opencode/send', { method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ instanceId, proof }), signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error('Cooperation rejected the native send request.');
        return JSON.stringify(await response.json());
      } catch { throw new Error('Cooperation send outcome is unconfirmed. Inspect communication history before retrying.'); }
      finally { proofs.delete(proof); }
    },
    async close() { await maintenance.close(); await Promise.allSettled([...inFlight.values()].map(item => item.work)); server.closeAllConnections(); await new Promise(ok => server.close(ok)); await unlink(registration).catch(() => {}); },
  };
}
