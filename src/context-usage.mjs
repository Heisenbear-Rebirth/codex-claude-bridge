import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { readdir, stat, open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';

const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const sum = values => values.every(value => value !== null) ? values.reduce((a, b) => a + b, 0) : null;
const percentage = (used, size) => used !== null && size > 0 ? Math.round(used / size * 10000) / 100 : null;

export function createUsageAccumulator(client, id) {
  let latest = null, latestBoundary = null, model = null, lifecycle = null, pendingHistoryChange = false;
  let knownWindow = null, windowModel = null, pendingWindow = null;
  const usageFields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
  return {
    add(row) {
      const p = row.payload || {};
      if (client === 'codex') {
        if (row.type === 'turn_context') {
          if (p.model && model && p.model !== model) { latest = null; pendingHistoryChange = true; }
          model = p.model || model;
          if (pendingWindow && p.turn_id === pendingWindow.turnId) { knownWindow = pendingWindow.window; windowModel = model; pendingWindow = null; }
        }
        if (row.type === 'compacted') { latestBoundary = row.timestamp; latest = null; pendingHistoryChange = true; }
        if (row.type === 'response_item' && (['function_call_output', 'custom_tool_call_output'].includes(p.type)
          || (p.type === 'message' && p.role !== 'assistant'))) pendingHistoryChange = true;
        if (row.type === 'event_msg' && ['task_started', 'task_complete', 'task_interrupted'].includes(p.type)) lifecycle = p.type;
        if (row.type === 'event_msg' && p.type === 'task_started') {
          pendingHistoryChange = true;
          const window = count(p.model_context_window);
          if (window > 0) pendingWindow = { turnId: p.turn_id, window };
        }
        if (row.type === 'token_usage_record') {
          // Per-response usage is written before a long-running tool returns.
          // turn_token_usage and thread_token_usage are cumulative, never context.
          if (p.thread_id !== id || !p.usage || count(p.usage.total_tokens) === null) return;
          const window = windowModel === model ? knownWindow : null;
          latest = { source: 'codex-rollout-api-usage', observedAt: row.timestamp, model,
            usedTokens: p.usage.total_tokens, contextWindowTokens: window, usedPercent: percentage(p.usage.total_tokens, window),
            apiTurnId: p.turn_id || null, rawLastUsage: Object.fromEntries(usageFields.map(key => [key, count(p.usage[key])])) };
          pendingHistoryChange = false; return;
        }
        if (row.type !== 'event_msg' || p.type !== 'token_count' || !p.info?.last_token_usage) return;
        const last = p.info.last_token_usage;
        const window = count(p.info.model_context_window);
        const used = count(last.total_tokens);
        if (window > 0) { knownWindow = window; windowModel = model; }
        if (latest?.source === 'codex-rollout-api-usage' && ['input_tokens', 'output_tokens', 'total_tokens'].every(key => count(last[key]) === latest.rawLastUsage[key])) {
          latest.contextWindowTokens = window; latest.usedPercent = percentage(latest.usedTokens, window);
          return; // A delayed duplicate counter must not erase intervening tool output.
        }
        latest = { source: 'codex-rollout-token-count', observedAt: row.timestamp, model, usedTokens: used,
          contextWindowTokens: window, usedPercent: percentage(used, window),
          rawLastUsage: Object.fromEntries(usageFields.map(key => [key, count(last[key])])) };
        pendingHistoryChange = false;
      } else {
        if (row.sessionId && row.sessionId.toLowerCase() !== id.toLowerCase()) return;
        if (row.parent_tool_use_id || row.isSidechain) return;
        if (row.type === 'system' && row.subtype === 'compact_boundary') { latestBoundary = row.timestamp; latest = null; pendingHistoryChange = true; return; }
        if (row.type === 'user') pendingHistoryChange = true;
        if (row.type !== 'assistant' || !row.message?.usage) return;
        const usage = row.message.usage;
        model = row.message.model || model;
        const input = count(usage.input_tokens);
        const creation = count(usage.cache_creation_input_tokens);
        const read = count(usage.cache_read_input_tokens);
        const output = count(usage.output_tokens);
        const used = sum([input, creation, read]);
        latest = { source: 'claude-transcript-last-api-usage', observedAt: row.timestamp, model,
          usedTokens: used, withLastOutputTokens: used === null || output === null ? null : used + output,
          contextWindowTokens: null, usedPercent: null,
          rawLastUsage: { input_tokens: input, cache_creation_input_tokens: creation, cache_read_input_tokens: read, output_tokens: output } };
        pendingHistoryChange = false;
      }
    },
    result() {
      return { client, sessionId: id, ...latest, available: Boolean(latest), measuredAt: latest?.observedAt || null,
        contextEpoch: latestBoundary || 'initial',
        lastCompactionAt: latestBoundary, freshness: latest ? 'last-recorded-event' : 'unavailable',
        historyChangedAfterMeasurement: pendingHistoryChange,
        ...(client === 'codex' ? { recordedTurnState: lifecycle } : {}),
        detail: client === 'codex' ? 'Uses per-response token_usage_record.usage or legacy last_token_usage, never turn/thread cumulative totals. Capacity comes from native task_started or token_count. Unreported changes remain marked stale.'
          : 'Input includes cache creation and cache reads. The transcript does not establish current model capacity; unknown capacity and percentage remain null.' };
    },
  };
}
export async function readUsageFile({ client, id, filename }) {
  const accumulator = createUsageAccumulator(client, id);
  const input = createReadStream(filename, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try { for await (const line of lines) { let row; try { row = JSON.parse(line); } catch { continue; } accumulator.add(row); } }
  finally { lines.close(); input.destroy(); }
  return { ...accumulator.result(), queriedAt: new Date().toISOString() };
}
export async function readRecordedContext({ client, id }) {
  return readUsageFile({ client, id, filename: await contextSourcePath({ client, id }) });
}
export async function contextSourcePath({ client, id }) {
  let filename;
  if (client === 'claude') {
    const { findClaudeSession } = await import('./adapters/claude.mjs');
    filename = (await findClaudeSession(id))?.transcriptPath;
  }
  else {
    const { findCodexSession } = await import('./adapters/codex.mjs');
    const home = process.env.CODEX_HOME || join(homedir(), '.codex');
    if (!await findCodexSession(id, { codexHome: home })) throw new Error('Codex user conversation not found.');
    const names = (await readdir(home)).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    const { DatabaseSync } = await import('node:sqlite');
    for (const name of names) {
      const db = new DatabaseSync(join(home, name), { readOnly: true });
      try { db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;'); filename = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(id)?.rollout_path; }
      catch { continue; } finally { db.close(); }
      break;
    }
    if (filename) {
      const plain = path => path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
      filename = plain(filename);
      const rel = relative(resolve(plain(home)), resolve(filename)); if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Unexpected Codex log location.');
    }
  }
  if (!filename) throw new Error('No saved usage source for the selected conversation.');
  return filename;
}

export class IncrementalContextReader {
  constructor(client, id) { this.client = client; this.id = id; this.offset = 0; this.pending = ''; this.decoder = new StringDecoder('utf8'); this.accumulator = createUsageAccumulator(client, id); }
  async read() {
    this.filename ||= await contextSourcePath({ client: this.client, id: this.id });
    const info = await stat(this.filename);
    if (info.size < this.offset || (this.birthtimeMs !== undefined && info.birthtimeMs !== this.birthtimeMs)) {
      this.offset = 0; this.pending = ''; this.decoder = new StringDecoder('utf8'); this.accumulator = createUsageAccumulator(this.client, this.id);
    }
    this.birthtimeMs = info.birthtimeMs;
    const file = await open(this.filename, 'r');
    try {
      while (this.offset < info.size) {
        const buffer = Buffer.alloc(Math.min(1024 * 1024, info.size - this.offset));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, this.offset); if (!bytesRead) break;
        this.offset += bytesRead; const lines = (this.pending + this.decoder.write(buffer.subarray(0, bytesRead))).split('\n');
        this.pending = lines.pop();
        for (const line of lines) { try { this.accumulator.add(JSON.parse(line)); } catch {} }
        if (this.pending.length > 32 * 1024 * 1024) throw new Error('上下文日志单行超过支持的大小。');
      }
    } finally { await file.close(); }
    return { ...this.accumulator.result(), queriedAt: new Date().toISOString() };
  }
}

export function publicNativeContext(usage) {
  const total = count(usage?.totalTokens), size = count(usage?.rawMaxTokens);
  return { source: 'claude-native-get-context-usage', model: typeof usage?.model === 'string' ? usage.model : null,
    usedTokens: total, contextWindowTokens: size, usedPercent: percentage(total, size),
    reportedPercent: count(usage?.percentage),
    categories: Array.isArray(usage?.categories) ? usage.categories.map(category => ({ name: String(category.name || '').slice(0, 120), tokens: count(category.tokens), deferred: category.isDeferred === true })) : [],
    queriedAt: new Date().toISOString(), detail: 'Native context estimate. Full model capacity is distinct from the UI auto-compaction budget. No chat, memory-file, or tool-content details are returned.' };
}
