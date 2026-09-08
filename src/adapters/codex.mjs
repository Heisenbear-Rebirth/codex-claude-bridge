import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const LIVE_STATUS_WARNING = 'Codex history metadata does not report whether a conversation is currently running; live status is unknown.';
const USER_SESSION_SOURCES = new Set(['cli', 'vscode', 'exec', 'mcp', 'app', 'desktop']);
const MAX_SESSION_NAME_LENGTH = 120;

function homeDirectory(value) {
  return value || process.env.CODEX_HOME || join(homedir(), '.codex');
}

function adapterError(code, message, outcome = 'not_submitted') {
  return Object.assign(new Error(message), { code, outcome, retryable: false });
}

function plainDirectory(value) {
  const portable = value.replaceAll('\\', '/');
  if (/^\/\/\?\/UNC\//i.test(portable)) return `//${portable.slice(8)}`;
  return portable.startsWith('//?/') ? portable.slice(4) : portable;
}

function normalizeDirectory(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  value = plainDirectory(value);
  const windowsPath = /^[a-z]:[\\/]/i.test(value) || value.startsWith('//');
  const pathApi = windowsPath ? win32 : posix;
  let normalized = pathApi.normalize(value.replaceAll('\\', '/')).replaceAll('\\', '/');
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '');
  return windowsPath || process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function matchesDirectory(cwd, directory, recursive) {
  if (directory == null) return true;
  const target = normalizeDirectory(directory);
  const candidate = normalizeDirectory(cwd);
  if (!target || !candidate) return false;
  return candidate === target || (recursive && candidate.startsWith(target.endsWith('/') ? target : `${target}/`));
}

function timestamp(row) {
  for (const [key, scale] of [['updated_at_ms', 1], ['updated_at', 1000], ['created_at_ms', 1], ['created_at', 1000]]) {
    if (row[key] == null) continue;
    const number = Number(row[key]);
    if (!Number.isFinite(number) || number <= 0) continue;
    const date = new Date(number * scale);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

function isUserSession(row) {
  if (typeof row.agent_role === 'string' && row.agent_role.trim()) return false;
  if (typeof row.agent_path === 'string' && row.agent_path.trim() && row.agent_path !== '/root') return false;
  if (row.thread_source != null && row.thread_source !== '' && row.thread_source !== 'user') return false;
  let source = row.source;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { /* Legacy values are plain strings. */ }
  }
  // Structured sources describe internal agents (including approval reviewers).
  // Missing provenance cannot establish that a database row is a user conversation.
  return typeof source === 'string' && USER_SESSION_SOURCES.has(source);
}

function sessionName(row) {
  if (typeof row.name === 'string' && row.name.trim()) {
    const name = row.name.trim().replace(/\s+/gu, ' ');
    const characters = Array.from(name);
    return characters.length > MAX_SESSION_NAME_LENGTH
      ? `${characters.slice(0, MAX_SESSION_NAME_LENGTH - 1).join('')}…` : name;
  }
  // Older databases may put the entire first input into title. Do not publish it.
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  if (title && !/[\r\n]/.test(title) && Array.from(title).length <= MAX_SESSION_NAME_LENGTH) return title;
  return '未命名 Codex 会话';
}

function toSession(row) {
  return {
    client: 'codex',
    id: String(row.id),
    name: sessionName(row),
    cwd: row.cwd ? plainDirectory(row.cwd) : null,
    status: 'unknown',
    live: false,
    updatedAt: timestamp(row),
  };
}

async function readSessions({ codexHome, id } = {}) {
  const warnings = [];
  let databases;
  try {
    databases = (await readdir(homeDirectory(codexHome), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name))
      .sort((a, b) => Number(b.name.match(/\d+/)[0]) - Number(a.name.match(/\d+/)[0]));
  } catch (error) {
    warnings.push(error.code === 'ENOENT' ? 'Codex history directory was not found.' : 'Codex history directory could not be read.');
    return { sessions: [], warnings };
  }
  if (databases.length === 0) return { sessions: [], warnings: ['No Codex history database was found.'] };

  // A newer schema replaces older state databases. Do not merge stale generations.
  for (const entry of databases) {
    let database;
    try {
      database = new DatabaseSync(join(homeDirectory(codexHome), entry.name), { readOnly: true });
      database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;');
      const columns = new Set(database.prepare('PRAGMA table_info(threads)').all().map((column) => column.name));
      if (!columns.has('id') || !columns.has('cwd')) {
        warnings.push(`Unsupported Codex history schema in ${entry.name}.`);
        continue;
      }
      // Never SELECT *: these tables also contain prompts, previews and history paths.
      if (!columns.has('source')) warnings.push(`Codex history schema in ${entry.name} cannot identify user conversations; unverified rows are hidden.`);
      const selected = ['id', 'name', 'title', 'cwd', 'updated_at_ms', 'updated_at', 'created_at_ms', 'created_at', 'source', 'thread_source', 'agent_role', 'agent_path']
        .filter((column) => columns.has(column));
      const statement = database.prepare(`SELECT ${selected.map((column) => `"${column}"`).join(', ')} FROM threads${id == null ? '' : ' WHERE id = ?'}`);
      const rows = id == null ? statement.all() : statement.all(id);
      return { sessions: rows.filter((row) => typeof row.id === 'string' && row.id && isUserSession(row)).map(toSession), warnings: [...warnings, LIVE_STATUS_WARNING] };
    } catch {
      warnings.push(`Codex history database ${entry.name} could not be read.`);
    } finally {
      database?.close();
    }
  }
  return { sessions: [], warnings };
}

export async function listCodexSessions({ directory, recursive = false, codexHome } = {}) {
  if (directory != null && (typeof directory !== 'string' || !directory.trim())) {
    throw adapterError('CODEX_INVALID_DIRECTORY', 'A non-empty directory is required.');
  }
  const result = await readSessions({ codexHome });
  return {
    ...result,
    sessions: result.sessions.filter((session) => matchesDirectory(session.cwd, directory, recursive))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') || a.id.localeCompare(b.id)),
  };
}

export async function findCodexSession(id, { codexHome } = {}) {
  if (typeof id !== 'string' || !id.trim()) return null;
  const { sessions } = await readSessions({ codexHome, id: id.trim() });
  return sessions[0] || null;
}

async function discoverBridge(codexHome) {
  const root = join(homeDirectory(codexHome), 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
  let versions;
  try {
    versions = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }));
  } catch {
    return null;
  }
  for (const version of versions) {
    const candidate = join(root, version.name, 'server.mjs');
    try {
      await access(candidate);
      return candidate;
    } catch { /* An incomplete cache entry may have no bridge. */ }
  }
  return null;
}

function startBridge({ nodePath, bridgePath, pipePath, handshakeTimeoutMs, requestTimeoutMs }) {
  const child = spawn(nodePath, [bridgePath], {
    cwd: resolve('.'),
    env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: pipePath },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  const failAll = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  child.stderr.resume(); // Never expose bridge diagnostics containing connection details.
  child.stdin.on('error', () => failAll(adapterError('CODEX_BRIDGE_IO', 'Codex bridge input closed.')));
  child.once('error', () => {
    closed = true;
    failAll(adapterError('CODEX_BRIDGE_START_FAILED', 'Could not start the Codex App Tools bridge.'));
  });
  const exited = new Promise((done) => {
    child.once('close', () => {
      closed = true;
      failAll(adapterError('CODEX_BRIDGE_CLOSED', 'Codex App Tools bridge closed before completing the request.'));
      done();
    });
  });
  lines.on('line', (line) => {
    let response;
    try { response = JSON.parse(line); } catch {
      failAll(adapterError('CODEX_BRIDGE_PROTOCOL', 'Codex bridge returned an invalid protocol response.'));
      return;
    }
    if (response == null || typeof response !== 'object' || Array.isArray(response)) {
      failAll(adapterError('CODEX_BRIDGE_PROTOCOL', 'Codex bridge returned an invalid protocol response.'));
      return;
    }
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.error) request.reject(adapterError('CODEX_APP_REJECTED', 'Codex App rejected the bridge request.'));
    else request.resolve(response.result);
  });
  function notify(method, params) {
    if (!closed && child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
  }
  function request(method, params, timeout = handshakeTimeoutMs) {
    if (closed || !child.stdin.writable) return Promise.reject(adapterError('CODEX_BRIDGE_CLOSED', 'Codex App Tools bridge is not connected.'));
    const id = nextId++;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        notify('notifications/cancelled', { requestId: id, reason: 'Request deadline exceeded. Do not retry automatically.' });
        reject(adapterError('CODEX_BRIDGE_TIMEOUT', 'Codex App did not acknowledge the request before the deadline.'));
      }, timeout);
      pending.set(id, { resolve: resolveRequest, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  return {
    request,
    notify,
    call(name, args, callerThreadId) {
      return request('tools/call', { name, arguments: args, _meta: { 'openai/threadId': callerThreadId } }, requestTimeoutMs);
    },
    async close() {
      lines.close();
      failAll(adapterError('CODEX_BRIDGE_CLOSED', 'Codex bridge connection closed.'));
      if (!closed) child.stdin.end();
      let timer;
      await Promise.race([exited, new Promise((done) => { timer = setTimeout(done, 750); })]);
      clearTimeout(timer);
      if (!closed) {
        child.kill();
        await Promise.race([exited, new Promise((done) => { timer = setTimeout(done, 750); })]);
        clearTimeout(timer);
      }
    },
  };
}

/** Send once through the App bridge using the real originating Codex context. */
export async function sendCodexMessage({ targetId, text, context = {} } = {}) {
  if (typeof targetId !== 'string' || !targetId.trim() || typeof text !== 'string' || !text.trim()) {
    throw adapterError('CODEX_INVALID_MESSAGE', 'A target conversation ID and non-empty message are required.');
  }
  const pipePath = context.pipePath ?? process.env.CODEX_APP_TOOLS_PIPE_PATH;
  const callerThreadId = context.callerThreadId ?? process.env.CODEX_THREAD_ID;
  if (typeof pipePath !== 'string' || !pipePath.trim() || typeof callerThreadId !== 'string' || !callerThreadId.trim()) {
    throw adapterError('CODEX_CONTEXT_MISSING', 'Start the service from an authorized Codex App conversation so it inherits the App connection and caller identity.');
  }
  const bridgePath = context.bridgePath ?? await discoverBridge(context.codexHome);
  if (!bridgePath) throw adapterError('CODEX_BRIDGE_MISSING', 'The installed Codex App Tools MCP bridge was not found. Open Codex App and ensure its bundled app tools are available.');
  try { await access(bridgePath); } catch {
    throw adapterError('CODEX_BRIDGE_MISSING', 'The configured Codex App Tools MCP bridge does not exist or cannot be read.');
  }
  const bridge = startBridge({
    nodePath: context.nodePath ?? process.env.CODEX_MCP_NODE_PATH ?? process.execPath,
    bridgePath,
    pipePath,
    handshakeTimeoutMs: context.handshakeTimeoutMs ?? 10000,
    requestTimeoutMs: context.requestTimeoutMs ?? 45000,
  });
  let sendAttempted = false;
  try {
    await bridge.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'cooperation', version: '0.1.0' },
    });
    bridge.notify('notifications/initialized');
    const catalog = await bridge.request('tools/list', {});
    const tool = Array.isArray(catalog?.tools) ? catalog.tools.find((entry) => typeof entry?.name === 'string'
      && (entry.name === 'send_message_to_thread' || entry.name.endsWith('__send_message_to_thread'))) : null;
    if (!tool) throw adapterError('CODEX_SEND_UNAVAILABLE', 'The connected Codex App does not advertise send_message_to_thread.');
    sendAttempted = true;
    const result = await bridge.call(tool.name, { threadId: targetId.trim(), prompt: text }, callerThreadId);
    if (!result || result.isError === true || !Array.isArray(result.content)) {
      throw adapterError('CODEX_SEND_REJECTED', 'Codex App did not confirm the message submission.');
    }
    return { status: 'submitted', transport: 'codex-app-tools', targetId: targetId.trim(), submittedAt: new Date().toISOString() };
  } catch (error) {
    if (!error.code) error.code = 'CODEX_BRIDGE_ERROR';
    error.outcome = sendAttempted ? 'unknown' : 'not_submitted';
    error.retryable = false;
    if (sendAttempted) error.message += ' Delivery is unknown; inspect the target conversation before trying again.';
    throw error;
  } finally {
    await bridge.close();
  }
}
