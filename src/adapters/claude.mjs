import { createReadStream } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METADATA_KEYS = new Set(['type', 'sessionId', 'cwd', 'customTitle', 'aiTitle', 'timestamp']);
const MAX_REGISTRY_BYTES = 256 * 1024;
const MAX_KEY_BYTES = 4096;
export const MAX_CLAUDE_MESSAGE_BYTES = 256 * 1024;
const TRANSPORT_TIMEOUT_MS = 8000;

function fault(code, message) {
  return Object.assign(new Error(message), { code });
}

function configPath(configDir) {
  return path.resolve(configDir || process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'));
}

function canonicalDirectory(value) {
  if (typeof value !== 'string' || !value) return null;
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function withinDirectory(candidate, directory, recursive) {
  const child = canonicalDirectory(candidate);
  const parent = canonicalDirectory(directory);
  if (!child || !parent) return false;
  if (child === parent) return true;
  return recursive && child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

function projectSlug(directory) {
  return path.resolve(directory).replace(/[^a-zA-Z0-9]/g, '-');
}

function sameSlug(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function iso(value) {
  const date = typeof value === 'number' || typeof value === 'string' ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function mostRecent(...values) {
  const timestamps = values.map(iso).filter(Boolean).sort();
  return timestamps.at(-1) ?? null;
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the OS knows the process but denies this caller access.
    return error.code === 'EPERM';
  }
}

async function directoryEntries(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readSmallJson(filename, maximumBytes) {
  const info = await stat(filename);
  if (!info.isFile() || info.size > maximumBytes) throw fault('CLAUDE_INVALID_METADATA', 'Claude metadata file has an unexpected size.');
  return JSON.parse(await readFile(filename, 'utf8'));
}

// Read only selected top-level scalar fields. In particular, message content,
// tool arguments and tool results are skipped without JSON deserialization.
function topLevelMetadata(line) {
  const result = Object.create(null);
  let index = 0;
  const whitespace = () => { while (/\s/.test(line[index] ?? '') && index < line.length) index += 1; };
  const stringEnd = (start) => {
    let cursor = start + 1;
    while (cursor < line.length) {
      if (line[cursor] === '\\') { cursor += 2; continue; }
      if (line[cursor] === '"') return cursor + 1;
      cursor += 1;
    }
    return line.length;
  };
  whitespace();
  if (line[index++] !== '{') return result;
  while (index < line.length) {
    whitespace();
    if (line[index] !== '"') break;
    const keyEnd = stringEnd(index);
    let key;
    try { key = keyEnd - index <= 128 ? JSON.parse(line.slice(index, keyEnd)) : null; } catch { break; }
    index = keyEnd;
    whitespace();
    if (line[index++] !== ':') break;
    whitespace();
    const start = index;
    let depth = 0;
    while (index < line.length) {
      const character = line[index];
      if (character === '"') { index = stringEnd(index); continue; }
      if (character === '[' || character === '{') depth += 1;
      else if (character === ']' || character === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if (character === ',' && depth === 0) break;
      index += 1;
    }
    if (METADATA_KEYS.has(key) && index - start <= 8192) {
      try {
        const value = JSON.parse(line.slice(start, index));
        if (typeof value === 'string' || typeof value === 'number') result[key] = value;
      } catch { /* Ignore a partially written or malformed metadata field. */ }
    }
    if (line[index] !== ',') break;
    index += 1;
  }
  return result;
}

async function transcriptMetadata(filename, expectedId, fallbackCwd) {
  const fileInfo = await stat(filename);
  const metadata = { id: expectedId, cwd: fallbackCwd ?? null, customTitle: null, aiTitle: null, transcriptPath: filename, updatedAt: iso(fileInfo.mtimeMs) };
  let hasSessionCwd = false;
  const input = createReadStream(filename, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const fields = topLevelMetadata(line);
      if (fields.sessionId && fields.sessionId.toLowerCase() !== expectedId.toLowerCase()) continue;
      // Later cwd fields follow shell directory changes, not the session's project.
      if (!hasSessionCwd && typeof fields.cwd === 'string' && fields.cwd) { metadata.cwd = fields.cwd; hasSessionCwd = true; }
      if (fields.type === 'custom-title' && typeof fields.customTitle === 'string') metadata.customTitle = fields.customTitle.trim() || null;
      if (fields.type === 'ai-title' && typeof fields.aiTitle === 'string') metadata.aiTitle = fields.aiTitle.trim() || null;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return metadata;
}

async function verifyRegistryLifetimes(records, warnings) {
  if (process.platform !== 'win32') return;
  const candidates = records.filter(record => record.live && (record.procStartFt || record.procStart));
  if (!candidates.length) return;
  const pids = [...new Set(candidates.map(record => record.pid))];
  // Numeric PIDs were validated by alive(). Query metadata only, in one batch;
  // old registry files may refer to PIDs now owned by unrelated processes.
  const script = '$taskProcesses = @(Get-Process -Id ' + pids.join(',')
    + ' -ErrorAction SilentlyContinue | ForEach-Object { try { [pscustomobject]@{pid=$_.Id; start=$_.StartTime.ToFileTimeUtc().ToString()} } catch {} }); ConvertTo-Json -Compress -InputObject $taskProcesses';
  let starts = new Map();
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 });
    const values = JSON.parse(stdout.trim());
    starts = new Map((Array.isArray(values) ? values : [values]).map(value => [value.pid, value.start]));
  } catch { warnings.push('Could not verify Claude registry process lifetimes; unverified records are not treated as live.'); }
  for (const record of candidates) record.live = starts.get(record.pid) === String(record.procStartFt || record.procStart);
}

async function liveRecords(root, { id, directory, recursive = false } = {}, warnings = []) {
  const folder = path.join(root, 'sessions');
  const records = [];
  for (const entry of await directoryEntries(folder)) {
    if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) continue;
    const filename = path.join(folder, entry.name);
    try {
      const record = await readSmallJson(filename, MAX_REGISTRY_BYTES);
      if (!UUID.test(record.sessionId ?? '') || record.pid !== Number(entry.name.slice(0, -5))) continue;
      if (id && record.sessionId.toLowerCase() !== id.toLowerCase()) continue;
      if (directory && !withinDirectory(record.cwd, directory, recursive)) continue;
      records.push({ ...record, sessionId: record.sessionId.toLowerCase(), registryFile: filename, live: alive(record.pid) });
    } catch (error) {
      if (error.code !== 'ENOENT' && id) warnings.push('One Claude live-session record could not be read.');
    }
  }
  await verifyRegistryLifetimes(records, warnings);
  return records;
}

function combine(metadata, records = []) {
  const ordered = [...records].sort((left, right) => Number(right.live) - Number(left.live) || (right.updatedAt ?? right.startedAt ?? 0) - (left.updatedAt ?? left.startedAt ?? 0));
  const record = ordered[0];
  const id = metadata?.id ?? record.sessionId;
  const live = Boolean(record?.live);
  return {
    client: 'claude',
    id,
    name: metadata?.customTitle || metadata?.aiTitle || (record?.nameSource !== 'derived' ? record?.name : null) || `Claude ${id.slice(0, 8)}`,
    cwd: record?.cwd || metadata?.cwd || null,
    status: live ? 'running' : 'offline',
    live,
    updatedAt: mostRecent(metadata?.updatedAt, record?.updatedAt, record?.statusUpdatedAt, record?.startedAt),
    ...(metadata?.transcriptPath ? { transcriptPath: metadata.transcriptPath } : {}),
    ...(record?.registryFile ? { registryFile: record.registryFile } : {}),
    ...(record ? { pid: record.pid, inboxAvailable: typeof record.messagingSocketPath === 'string' && record.messagingSocketPath.length > 0 } : {}),
  };
}

export async function listClaudeSessions({ directory = process.cwd(), recursive = false, configDir } = {}) {
  const root = configPath(configDir);
  const requestedDirectory = path.resolve(directory);
  const warnings = [];
  const records = await liveRecords(root, { directory: requestedDirectory, recursive }, warnings);
  const saved = new Map();
  const projects = path.join(root, 'projects');
  const slug = projectSlug(requestedDirectory);
  for (const project of await directoryEntries(projects)) {
    if (!project.isDirectory()) continue;
    const exactSlug = sameSlug(project.name, slug);
    if (!exactSlug && !recursive) continue;
    const comparedName = process.platform === 'win32' ? project.name.toLowerCase() : project.name;
    const comparedSlug = process.platform === 'win32' ? slug.toLowerCase() : slug;
    if (!exactSlug && !comparedName.startsWith(comparedSlug + '-')) continue;
    // Encoded names cannot be safely decoded back into directories, so the
    // metadata's actual cwd is always checked before exposing a saved session.
    const folder = path.join(projects, project.name);
    for (const entry of await directoryEntries(folder)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const id = entry.name.slice(0, -6);
      if (!UUID.test(id)) continue;
      try {
        const metadata = await transcriptMetadata(path.join(folder, entry.name), id.toLowerCase(), exactSlug ? requestedDirectory : null);
        if (withinDirectory(metadata.cwd, requestedDirectory, recursive)) saved.set(id.toLowerCase(), metadata);
      } catch (error) {
        if (error.code !== 'ENOENT') warnings.push(`Could not read metadata for Claude session ${id}.`);
      }
    }
  }
  const grouped = new Map();
  for (const record of records) {
    const group = grouped.get(record.sessionId) ?? [];
    group.push(record);
    grouped.set(record.sessionId, group);
  }
  const liveIds = [...grouped].filter(([, group]) => group.some(record => record.live)).map(([id]) => id);
  const ids = new Set([...saved.keys(), ...liveIds]);
  const sessions = [...ids].map((id) => {
    const group = grouped.get(id) ?? [];
    if (group.filter((record) => record.live).length > 1) warnings.push(`Claude session ${id} is open in multiple processes; sending will require a single live target.`);
    return combine(saved.get(id), group);
  }).sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '') || left.id.localeCompare(right.id));
  return { sessions, warnings };
}

export async function findClaudeSession(id, { configDir } = {}) {
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  const root = configPath(configDir);
  const exactId = id.toLowerCase();
  const records = await liveRecords(root, { id: exactId });
  const projects = path.join(root, 'projects');
  let metadata;
  for (const project of await directoryEntries(projects)) {
    if (!project.isDirectory()) continue;
    const filename = path.join(projects, project.name, `${exactId}.jsonl`);
    try {
      await access(filename);
      const candidate = await transcriptMetadata(filename, exactId, records[0]?.cwd);
      if (!metadata || (candidate.updatedAt ?? '') > (metadata.updatedAt ?? '')) metadata = candidate;
    } catch (error) {
      if (error.code !== 'ENOENT') throw fault('CLAUDE_METADATA_UNAVAILABLE', 'Could not read the selected Claude session metadata.');
    }
  }
  return metadata || records.some(record => record.live) ? combine(metadata, records) : null;
}

function canonicalEndpoint(endpoint) {
  if (typeof endpoint !== 'string') throw fault('CLAUDE_INBOX_UNAVAILABLE', 'The Claude session has no peer inbox.');
  if (process.platform === 'win32') {
    const match = /^\\\\\.\\pipe\\([a-zA-Z0-9_-]+)$/.exec(endpoint);
    if (!match) throw fault('CLAUDE_INVALID_INBOX', 'Claude inbox is not a local named pipe.');
    return `\\\\.\\pipe\\${match[1].toLowerCase()}`;
  }
  if (!path.isAbsolute(endpoint) || endpoint.includes('\0')) throw fault('CLAUDE_INVALID_INBOX', 'Claude inbox is not a local socket path.');
  return path.resolve(endpoint);
}

async function validateProcessLifetime(record, key) {
  if (!alive(record.pid)) throw fault('CLAUDE_SESSION_OFFLINE', 'The selected Claude process is no longer running.');
  if (record.procStartFt && key.procStartFt && record.procStartFt !== key.procStartFt) throw fault('CLAUDE_STALE_INBOX', 'Claude registry and inbox key belong to different process lifetimes.');
  const expectedFiletime = record.procStartFt || key.procStartFt;
  if (process.platform === 'win32' && expectedFiletime) {
    if (!/^\d+$/.test(expectedFiletime)) throw fault('CLAUDE_STALE_INBOX', 'Claude process identity metadata is invalid.');
    // Fixed read-only command with an already validated numeric PID. No shell
    // interpolation of paths, message content or authentication material.
    const command = `(Get-Process -Id ${record.pid} -ErrorAction Stop).StartTime.ToFileTimeUtc().ToString()`;
    let stdout;
    try {
      ({ stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { timeout: 3000, windowsHide: true, maxBuffer: 4096 }));
    } catch {
      throw fault('CLAUDE_PROCESS_UNVERIFIED', 'Could not verify the selected Claude process lifetime.');
    }
    if (stdout.trim() !== expectedFiletime) throw fault('CLAUDE_STALE_INBOX', 'The Claude inbox metadata is stale.');
  }
}

function writeFrames(endpoint, frames) {
  return new Promise((resolve, reject) => {
    let wrote = false;
    let settled = false;
    const socket = createConnection(endpoint);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error && !wrote) reject(fault(error.code === 'EPERM' || error.code === 'EACCES' ? 'CLAUDE_INBOX_ACCESS_DENIED' : 'CLAUDE_INBOX_UNREACHABLE', error.code === 'EPERM' || error.code === 'EACCES' ? 'Access to the Claude peer inbox was denied.' : 'Could not connect to the Claude peer inbox.'));
      else resolve(error ? 'unknown' : 'submitted');
    };
    const timer = setTimeout(() => finish(fault('ETIMEDOUT', 'Claude peer inbox write timed out.')), TRANSPORT_TIMEOUT_MS);
    socket.once('error', finish);
    socket.once('connect', () => {
      wrote = true;
      // The endpoint has no auth or delivery ACK. A successful end callback
      // means transport submission only; the agent's response is independent.
      socket.end(frames, (error) => finish(error));
    });
    socket.once('close', () => {
      if (!settled) finish(fault('ECONNRESET', 'Claude peer inbox closed before write completion.'));
    });
  });
}

export async function sendClaudeMessage({ targetId, text, messageId = randomUUID(), configDir } = {}) {
  if (typeof targetId !== 'string' || !UUID.test(targetId)) throw fault('CLAUDE_INVALID_SESSION_ID', 'A valid Claude session UUID is required.');
  if (typeof text !== 'string' || !text.trim()) throw fault('CLAUDE_EMPTY_MESSAGE', 'Message text must not be empty.');
  if (Buffer.byteLength(text, 'utf8') > MAX_CLAUDE_MESSAGE_BYTES) throw fault('CLAUDE_MESSAGE_TOO_LARGE', `Claude messages are limited to ${MAX_CLAUDE_MESSAGE_BYTES} UTF-8 bytes.`);
  if (typeof messageId !== 'string' || messageId.length < 1 || messageId.length > 128 || /[\u0000-\u001f]/.test(messageId)) throw fault('CLAUDE_INVALID_MESSAGE_ID', 'The message ID is invalid.');
  const root = configPath(configDir);
  const exactId = targetId.toLowerCase();
  const records = (await liveRecords(root, { id: exactId })).filter((record) => record.live);
  if (records.length === 0) throw fault('CLAUDE_SESSION_OFFLINE', 'The selected Claude session is not running.');
  if (records.length > 1) throw fault('CLAUDE_AMBIGUOUS_SESSION', 'The selected Claude session is open in multiple processes.');
  const record = records[0];
  const endpoint = canonicalEndpoint(record.messagingSocketPath);
  const endpointHash = createHash('sha256').update(endpoint).digest('hex');
  const keyPath = path.join(root, 'sessions', `${record.pid}.${endpointHash}.key`);
  let key;
  try {
    key = await readSmallJson(keyPath, MAX_KEY_BYTES);
  } catch {
    throw fault('CLAUDE_PEER_KEY_UNAVAILABLE', 'The selected Claude inbox authentication key is unavailable.');
  }
  if (typeof key.peerToken !== 'string' || !/^[a-f0-9]{32}$/.test(key.peerToken)) throw fault('CLAUDE_PEER_KEY_INVALID', 'The selected Claude inbox authentication key is invalid.');
  await validateProcessLifetime(record, key);
  const frame = { type: 'user', session_id: exactId, uuid: messageId, priority: 'next', message: { role: 'user', content: text } };
  const auth = JSON.stringify({ type: 'auth', token: key.peerToken });
  const payload = `${auth}\n${JSON.stringify(frame)}\n`;
  const status = await writeFrames(endpoint, payload);
  return { status, transport: 'claude-peer-inbox', client: 'claude', targetId: exactId, messageId, submittedAt: new Date().toISOString(), deliveryConfirmed: false };
}
