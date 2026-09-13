import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonLineObserver, ClaudeProtocolState } from './claude-wrapper-state.mjs';
import { NativeContextChannel } from './claude-context-channel.mjs';
import { PeerMessageVisibility } from './claude-peer-visibility.mjs';
import { loadPeerHistory } from './claude-peer-history.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const normalize = value => resolve(value).replace(/^\\\\\?\\/, '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const dataDirectory = process.env.COOP_WRAPPER_DATA_DIRECTORY ? resolve(process.env.COOP_WRAPPER_DATA_DIRECTORY) : join(root, '.cooperation', 'claude-wrapper');
if (!normalize(dataDirectory).startsWith(normalize(root) + '/')) throw new Error('Wrapper data must stay inside the Cooperation project.');
const [binary, ...args] = process.argv.slice(2);
if (!binary) { process.stderr.write('[Cooperation] Missing original Claude executable.\n'); process.exit(1); }
let enabled = false;
let peerMessageVisibility = process.env.COOP_PEER_MESSAGE_VISIBILITY !== '0';
// Reopening must not append old messages as if they were new arrivals.
let peerHistoryVisibility = process.env.COOP_PEER_HISTORY_VISIBILITY === '1';
try {
  const config = JSON.parse(await readFile(join(dataDirectory, 'config.json'), 'utf8'));
  peerMessageVisibility &&= config.peerMessageVisibility !== false;
  peerHistoryVisibility = process.env.COOP_PEER_HISTORY_VISIBILITY !== '0'
    && (peerHistoryVisibility || config.peerHistoryVisibility === true);
  enabled = config.enabled === true && Array.isArray(config.directories) && config.directories.some(directory => normalize(directory) === normalize(process.cwd()))
    && args.includes('stream-json') && args.includes('--input-format');
} catch { /* No project configuration means pure passthrough. */ }
const child = spawn(binary, args, { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const resumeAt = args.indexOf('--resume');
const resumed = resumeAt >= 0 && /^[0-9a-f-]{36}$/i.test(args[resumeAt + 1] || '') ? args[resumeAt + 1].toLowerCase() : null;
const state = new ClaudeProtocolState(resumed);
const instanceId = randomUUID();
const token = randomBytes(32).toString('hex');
const registryFile = join(dataDirectory, 'instances', `${process.pid}-${instanceId}.json`);
let server, endpoint, pending, closing = false, writing = Promise.resolve(), lastSnapshot = '', lastCompaction = null;
let controlPending = null, lastControl = null;
const controlOperations = new Map();
let registryTimer;
let visibilityHistory = { status: enabled && peerMessageVisibility && peerHistoryVisibility ? 'pending' : 'disabled', count: 0 };
let historyRestoreSession = null;
const auditFile = join(dataDirectory, 'compactions.jsonl');
const audit = event => appendFile(auditFile, JSON.stringify({ at: new Date().toISOString(), instanceId, ...event }) + '\n', 'utf8');
function publicState() { return { ...state.publicState(), wrapperPid: process.pid, childPid: child.pid, instanceId, cwd: process.cwd(),
  protocolVersion: 2, connected: !closing && !state.inputEnded, observedAt: new Date().toISOString(),
  capabilities: { readActivity: true, interrupt: true, sendControl: true, compact: true, observeCompletion: true, passiveUsage: true,
    hardAutomation: false, peerMessageVisibility: enabled && peerMessageVisibility, peerHistoryVisibility: enabled && peerMessageVisibility && peerHistoryVisibility },
  visibilityHistory,
  canCompact: Boolean(!pending && !controlPending && !contextChannel.active && state.canCompact(inputObserver.atBoundary)),
  compactionRequestId: pending?.id || null, lastCompaction, controlPending, lastControl }; }
function persist() {
  if (!enabled || !endpoint || closing) return;
  const snapshot = { ...publicState(), endpoint, token, createdAt: startedAt };
  delete snapshot.observedAt; // Do not rewrite the registry for every streamed token.
  const signature = JSON.stringify(snapshot);
  if (signature === lastSnapshot) return; lastSnapshot = signature;
  if (registryTimer) return;
  registryTimer = setTimeout(() => {
    registryTimer = null;
    writing = writing.then(async () => { await writeFile(registryFile + '.tmp', lastSnapshot + '\n', 'utf8'); await rename(registryFile + '.tmp', registryFile); })
      .catch(() => { lastSnapshot = ''; process.stderr.write('[Cooperation] Could not publish wrapper state.\n'); });
  }, 100);
}
async function finishCompaction(status, extra = {}) {
  const operation = pending;
  if (!operation) return;
  clearTimeout(operation.timer);
  pending = null;
  lastCompaction = { requestId: operation.id, sessionId: operation.sessionId, status, ...extra, completedAt: new Date().toISOString() };
  await audit({ type: 'finished', ...lastCompaction }).catch(() => {});
  operation.resolve(lastCompaction); persist();
}
const inputObserver = new JsonLineObserver(message => { state.host(message); persist(); });
const outputObserver = new JsonLineObserver(message => {
  state.child(message);
  if (message.parent_tool_use_id || (message.session_id && state.sessionId !== message.session_id.toLowerCase())) return;
  if (message.type === 'result' && controlPending) {
    lastControl = { ...controlPending, status: state.lastCompletedTurnId === controlPending.requestId ? 'completed' : 'unknown',
      resultSubtype: message.subtype, isError: message.is_error === true, completedAt: state.lastResultAt };
    controlPending = null;
    void audit({ type: 'control_finished', ...lastControl }).catch(() => {});
  }
  if (pending && message.session_id && message.session_id.toLowerCase() !== pending.sessionId) { persist(); return; }
  if (pending && message.type === 'system' && message.subtype === 'compact_boundary') {
    pending.boundary = { trigger: message.compact_metadata?.trigger, preTokens: message.compact_metadata?.pre_tokens, observedAt: new Date().toISOString() };
    void audit({ type: 'compact_boundary', requestId: pending.id, sessionId: pending.sessionId, ...pending.boundary }).catch(() => {});
  }
  if (pending && message.type === 'result') {
    const boundary = pending.boundary;
    void finishCompaction(boundary && message.is_error !== true ? 'completed' : message.is_error ? 'failed' : 'not_compacted', {
      boundary: boundary || null, resultSubtype: message.subtype, isError: message.is_error === true,
      ...(boundary ? {} : { detail: 'The command ended without an observed compact_boundary.' }),
    });
  }
  persist();
});
const startedAt = new Date().toISOString();
const contextChannel = new NativeContextChannel(bytes => child.stdin.write(bytes), subtype => !pending &&
  (subtype === 'interrupt' ? state.initialized && state.active && !state.inputEnded && inputObserver.atBoundary : !controlPending && state.canCompact(inputObserver.atBoundary)));
process.stdin.on('data', chunk => { if (enabled) inputObserver.push(chunk); if (!child.stdin.destroyed && !child.stdin.write(chunk)) process.stdin.pause(); });
child.stdin.on('drain', () => process.stdin.resume());
process.stdin.on('end', () => { state.inputEnded = true; child.stdin.end(); persist(); });
process.stdin.on('error', () => child.stdin.end());
child.stdin.on('error', () => { state.inputEnded = true; persist(); });
const peerVisibility = new PeerMessageVisibility(() => state.sessionId);
function writeIdeOutput(chunk) { if (!process.stdout.write(chunk)) child.stdout.pause(); }
function forwardOutput(chunk) {
  // Activity and maintenance observe original native messages, not display copies.
  if (enabled) outputObserver.push(chunk);
  if (enabled && peerMessageVisibility) peerVisibility.push(chunk, writeIdeOutput);
  else writeIdeOutput(chunk);
  if (enabled && peerMessageVisibility && peerHistoryVisibility && state.initialized && state.sessionId && !historyRestoreSession) {
    historyRestoreSession = state.sessionId;
    const restoreEpoch = state.contextEpoch;
    void loadPeerHistory({ sessionId: historyRestoreSession, cwd: process.cwd() }).then(result => {
      if (closing || state.sessionId !== historyRestoreSession) return;
      if (pending || state.contextEpoch !== restoreEpoch) {
        visibilityHistory = { status: 'unavailable', count: 0, reason: 'context_changed_during_restore' }; persist(); return;
      }
      peerVisibility.restoreHistory(result.frames, writeIdeOutput);
      visibilityHistory = { status: result.status, count: result.frames.length, truncated: result.truncated || false,
        ...(result.reason ? { reason: result.reason } : {}) };
      persist();
    }).catch(() => { visibilityHistory = { status: 'unavailable', count: 0, reason: 'history_read_failed' }; persist(); });
  }
}
child.stdout.on('data', chunk => { if (enabled) contextChannel.push(chunk, forwardOutput); else forwardOutput(chunk); });
child.stdout.on('end', () => { contextChannel.end(forwardOutput); peerVisibility.end(writeIdeOutput); });
process.stdout.on('drain', () => child.stdout.resume());
process.stdout.on('error', () => child.kill());
child.stderr.pipe(process.stderr);
child.once('error', async () => { process.stderr.write('[Cooperation] Failed to launch the original Claude process.\n'); await cleanup(1); });
child.once('close', (code, signal) => { void cleanup(code ?? (signal ? 1 : 0)); });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { child.kill(); setTimeout(() => process.exit(1), 3000).unref(); });
async function cleanup(code) {
  if (closing) return; closing = true;
  clearTimeout(registryTimer);
  contextChannel.close();
  if (pending) await finishCompaction('unknown', { detail: 'The original Claude process exited before completion was confirmed.' });
  server?.close(); server?.closeAllConnections();
  await writing;
  if (enabled) { await unlink(registryFile).catch(() => {}); await unlink(registryFile + '.tmp').catch(() => {}); }
  process.exit(code);
}
function authorized(request) {
  const value = request.headers.authorization || '';
  const expected = `Bearer ${token}`;
  return value.length === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
async function directoryStillEnabled() {
  try { const config = JSON.parse(await readFile(join(dataDirectory, 'config.json'), 'utf8'));
    return config.enabled === true && config.directories?.some(directory => normalize(directory) === normalize(process.cwd()));
  } catch { return false; }
}
function reply(response, status, body) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); }
async function readRequest(request) {
  let body = ''; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 128 * 1024) throw new Error('Request too large.'); }
  return JSON.parse(body);
}
async function control(kind, body) {
  const signature = createHash('sha256').update(JSON.stringify({ kind, ...body })).digest('hex');
  const old = controlOperations.get(body.requestId);
  if (old) return old.signature === signature ? old.promise : { status: 'request_id_conflict' };
  if (controlOperations.size >= 128) return { status: 'needs_attention', detail: 'Control operation ledger is full; reopen this wrapper at an idle boundary.' };
  const execute = async () => {
    const unchanged = () => state.sessionId === body.sessionId && state.activityRevision === body.expectedActivityRevision
      && (state.activeTurnId ?? null) === (body.expectedTurnId ?? null);
    const available = () => !pending && !contextChannel.active && inputObserver.atBoundary && !state.inputEnded
      && (kind === 'interrupt' ? state.active && Boolean(body.expectedTurnId) && !state.backgroundTasks.size
        : !controlPending && state.canCompact(inputObserver.atBoundary));
    if (!unchanged()) return { status: 'state_conflict' };
    if (!available()) return { status: 'busy' };
    await audit({ type: 'control_intent', kind, requestId: body.requestId, sessionId: body.sessionId,
      expectedTurnId: body.expectedTurnId ?? null, expectedActivityRevision: body.expectedActivityRevision, signature });
    if (!unchanged()) return { status: 'state_conflict' };
    if (!available()) return { status: 'busy' };
    let result;
    if (kind === 'interrupt') {
      const response = await contextChannel.interrupt();
      result = { status: 'acknowledged', requestId: body.requestId, expectedTurnId: body.expectedTurnId, ...response };
      // Acknowledgement is not a completed turn. State waits for the original result.
    } else {
      const frame = { type: 'user', session_id: body.sessionId, uuid: body.requestId, parent_tool_use_id: null,
        message: { role: 'user', content: body.text } };
      state.host(frame);
      controlPending = { requestId: body.requestId, sessionId: body.sessionId, submittedAt: new Date().toISOString() };
      child.stdin.write(JSON.stringify(frame) + '\n');
      result = { status: 'submitted', ...controlPending, activeTurnId: state.activeTurnId };
    }
    await audit({ type: 'control_dispatch', kind, ...result }).catch(() => {}); persist(); return result;
  };
  const promise = execute().catch(error => ({ status: error.outcome === 'failed' ? 'failed' : 'unknown', requestId: body.requestId,
    detail: 'Native control outcome was not confirmed. No retry was made.' }));
  controlOperations.set(body.requestId, { signature, promise }); return promise;
}
async function compact(sessionId, requestId) {
  if (pending || controlPending || contextChannel.active || !state.canCompact(inputObserver.atBoundary)) return { status: 'busy', detail: 'The selected session is not at an idle input boundary.' };
  if (sessionId !== state.sessionId) return { status: 'wrong_session' };
  const sequence = state.userSequence;
  let resolveOperation;
  const result = new Promise(resolve => { resolveOperation = resolve; });
  pending = { id: requestId, sessionId, resolve: resolveOperation, boundary: null };
  try {
    await audit({ type: 'requested', requestId, sessionId });
    // A normal IDE message may arrive while the audit append is pending.
    if (sequence !== state.userSequence || !state.canCompact(inputObserver.atBoundary)) { await finishCompaction('busy'); return result; }
    const frame = { type: 'user', session_id: sessionId, uuid: requestId, parent_tool_use_id: null, message: { role: 'user', content: '/compact' } };
    state.host(frame);
    child.stdin.write(JSON.stringify(frame) + '\n');
    pending.timer = setTimeout(() => {
      if (!pending || pending.id !== requestId) return;
      const timedOut = { requestId, sessionId, status: 'unknown', detail: 'No completion result within 120 seconds. No retry was made.' };
      void audit({ type: 'timeout', ...timedOut }).catch(() => {});
      pending.resolve(timedOut); // Keep pending until a late result or process exit.
      persist();
    }, 120000);
    persist(); return result;
  } catch { await finishCompaction('failed', { detail: 'Could not persist or submit the compaction request.' }); return result; }
}
if (enabled) {
  try {
    await mkdir(join(dataDirectory, 'instances'), { recursive: true });
    server = createServer(async (request, response) => {
      try {
        if (!authorized(request)) return reply(response, 401, { error: 'Unauthorized' });
        const controlsEnabled = await directoryStillEnabled();
        if (request.method === 'GET' && request.url === '/status') {
          const state = publicState();
          return reply(response, 200, { ...state, controlsEnabled,
            capabilities: { ...state.capabilities, automaticMaintenance: controlsEnabled, interrupt: controlsEnabled, sendControl: controlsEnabled, compact: controlsEnabled },
            canCompact: state.canCompact && controlsEnabled });
        }
        if (!controlsEnabled) return reply(response, 403, { error: 'Control access for this directory is disabled.' });
        if (request.method === 'GET' && request.url.startsWith('/context?')) {
          const query = new URL(request.url, 'http://127.0.0.1');
          if (query.searchParams.get('sessionId') !== state.sessionId) return reply(response, 400, { error: 'Wrong session.' });
          try { const usage = await contextChannel.query(); state.observeNativeUsage(usage); persist(); return reply(response, 200, { sessionId: state.sessionId, instanceId, usage }); }
          catch (error) { return reply(response, 409, { error: error.message }); }
        }
        if (request.method === 'POST' && ['/interrupt', '/prompt'].includes(request.url)) {
          const body = await readRequest(request);
          if (Object.keys(body).some(key => !['sessionId', 'requestId', 'instanceId', 'expectedTurnId', 'expectedActivityRevision', 'text'].includes(key))
            || body.sessionId !== state.sessionId || body.instanceId !== instanceId || !/^[0-9a-f-]{36}$/i.test(body.requestId || '')
            || !Number.isInteger(body.expectedActivityRevision) || (request.url === '/prompt' && (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 50000)))
            return reply(response, 400, { error: 'Invalid target or control request.' });
          const result = await control(request.url.slice(1), body);
          return reply(response, ['busy', 'state_conflict', 'request_id_conflict'].includes(result.status) ? 409 : 200, result);
        }
        if (request.method !== 'POST' || request.url !== '/compact') return reply(response, 404, { error: 'Not found' });
        const body = await readRequest(request);
        if (Object.keys(body).some(key => !['sessionId', 'requestId', 'instanceId'].includes(key))
          || !/^[0-9a-f-]{36}$/i.test(body.sessionId || '') || !/^[0-9a-f-]{36}$/i.test(body.requestId || '') || body.instanceId !== instanceId) return reply(response, 400, { error: 'Invalid target or request.' });
        const result = await compact(body.sessionId.toLowerCase(), body.requestId);
        reply(response, result.status === 'busy' ? 409 : 200, result);
      } catch { if (!response.headersSent) reply(response, 500, { error: 'Wrapper request failed.' }); }
    });
    server.requestTimeout = 150000;
    await new Promise((resolveServer, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveServer); });
    endpoint = `http://127.0.0.1:${server.address().port}`; persist();
  } catch { enabled = false; server?.close(); process.stderr.write('[Cooperation] Control endpoint unavailable; normal Claude transport continues.\n'); }
}
