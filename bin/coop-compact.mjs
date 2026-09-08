#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseAddress } from '../src/address.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
try {
  if (!args.includes('--to')) throw new Error('Use: node bin/coop-compact.mjs --to claude:SESSION_ID [--status|--context]');
  const target = parseAddress(value('--to'));
  if (target.client !== 'claude') throw new Error('This entry currently supports the Claude process wrapper only.');
  const folder = join(root, '.cooperation', 'claude-wrapper', 'instances');
  const files = await readdir(folder).catch(() => []);
  const candidates = [];
  for (const filename of files) {
    if (!filename.endsWith('.json')) continue;
    try {
      const record = JSON.parse(await readFile(join(folder, filename), 'utf8'));
      if (record.sessionId !== target.id.toLowerCase()) continue;
      const url = new URL(record.endpoint);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^[a-f0-9]{64}$/.test(record.token)) continue;
      const response = await fetch(new URL('/status', url), { headers: { Authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(2000) });
      if (!response.ok) continue;
      const current = await response.json();
      if (current.instanceId === record.instanceId && current.sessionId === target.id.toLowerCase()) candidates.push({ record, current });
    } catch { /* Stale instance records do not identify a live target. */ }
  }
  if (candidates.length !== 1) throw new Error(candidates.length ? 'This session has multiple live wrappers. Close duplicate instances first.' : 'No live wrapper for this session. Reopen the selected Claude VS Code session through the configured wrapper.');
  const { record, current } = candidates[0];
  if (args.includes('--context')) {
    const url = new URL('/context', record.endpoint); url.searchParams.set('sessionId', target.id.toLowerCase());
    const response = await fetch(url, { headers: { Authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(20000) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Context query failed.');
    console.log(JSON.stringify(result, null, 2));
  }
  else if (args.includes('--status')) { console.log(JSON.stringify(current, null, 2)); }
  else {
    if (!current.canCompact) throw new Error('The selected session is busy, initializing, or waiting for a control/permission response.');
    const requestId = randomUUID();
    const response = await fetch(new URL('/compact', record.endpoint), { method: 'POST', headers: { Authorization: `Bearer ${record.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: target.id.toLowerCase(), instanceId: record.instanceId, requestId }), signal: AbortSignal.timeout(130000) });
    const result = await response.json(); console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'completed') process.exitCode = result.status === 'unknown' ? 2 : 1;
  }
} catch (error) { console.error(error.name === 'TimeoutError' ? 'Compaction outcome unknown. Inspect the session; do not retry automatically.' : error.message); process.exitCode = 1; }
