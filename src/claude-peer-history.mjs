import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { JsonLineObserver } from './claude-wrapper-state.mjs';
import { visiblePeerMessage } from './claude-peer-visibility.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Read only the selected session's file. Do not enumerate sessions, edit Claude's
// transcript, or recover messages merely marked submitted in our own outbox.
export async function loadPeerHistory({ sessionId, cwd, configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), limit = 200 } = {}) {
  if (!UUID.test(sessionId || '') || typeof cwd !== 'string' || !cwd || !Number.isInteger(limit) || limit < 1 || limit > 200)
    return { status: 'unavailable', reason: 'invalid_target', frames: [] };
  const slug = resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  const file = join(resolve(configDir), 'projects', slug, sessionId.toLowerCase() + '.jsonl');
  let input;
  const nodes = new Map(); let tip = null, overflow = false;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size === 0) return { status: 'completed', frames: [], truncated: false };
    const observer = new JsonLineObserver(record => {
      if (overflow || !record || typeof record !== 'object' || record.isSidechain || record.teamName
        || record.sessionId?.toLowerCase?.() !== sessionId.toLowerCase() || !UUID.test(record.uuid || '')
        || !['user', 'assistant', 'system', 'attachment', 'progress'].includes(record.type)) return;
      if (nodes.size >= 200000) { overflow = true; return; }
      const raw = record.type === 'user' && record.isMeta === true && record.origin?.kind === 'peer'
        ? { type: 'user', uuid: record.uuid, session_id: sessionId.toLowerCase(), parent_tool_use_id: null,
          isReplay: true, isSynthetic: true, origin: record.origin, timestamp: record.timestamp, message: record.message } : null;
      const shown = raw ? visiblePeerMessage(raw, sessionId) : null;
      const frame = shown && shown !== raw ? shown : null;
      nodes.set(record.uuid, { parent: record.parentUuid, frame });
      if (['user', 'assistant'].includes(record.type)) tip = record.uuid;
    }, 1024 * 1024);
    input = createReadStream(file, { start: 0, end: info.size - 1, signal: AbortSignal.timeout(5000) });
    for await (const chunk of input) observer.push(chunk);
    if (overflow) return { status: 'unavailable', reason: 'history_limit', frames: [] };
    // Follow the current branch backwards. Rewound or sidechain messages must
    // not reappear merely because their old records remain in the JSONL file.
    const visited = new Set(), frames = []; let cursor = tip;
    while (cursor && nodes.has(cursor) && !visited.has(cursor)) {
      visited.add(cursor); const node = nodes.get(cursor);
      if (node.frame) frames.push(node.frame);
      cursor = node.parent;
    }
    const truncated = frames.length > limit;
    return { status: 'completed', frames: frames.slice(0, limit).reverse(), truncated };
  } catch (error) {
    return { status: 'unavailable', reason: error.code === 'ENOENT' ? 'history_not_found' : 'history_read_failed', frames: [] };
  } finally { input?.destroy(); }
}
