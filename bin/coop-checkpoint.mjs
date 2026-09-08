#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { detectSender } from '../src/identity.mjs';
import { checkpointViaManager } from '../src/client.mjs';

// Dedicated entry point for a narrow native permission rule. It cannot start
// services or send peer messages, and it never accepts a caller-supplied ID.
export function checkpointArguments(args) {
  const names = new Map([['--cycle', 'cycleId'], ['--stage', 'stage'], ['--receipt-token', 'receiptToken'], ['--document', 'documentPath'], ['--client', 'client']]);
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = names.get(args[i]);
    if (!key || result[key] !== undefined || typeof args[i + 1] !== 'string') throw new Error('Invalid or repeated checkpoint option.');
    result[key] = args[i + 1];
  }
  if (!/^[0-9a-f-]{36}$/i.test(result.cycleId || '') || !['handoff', 'restored'].includes(result.stage)
    || !/^[a-z0-9_-]{20,100}$/i.test(result.receiptToken || '') || !result.documentPath
    || (result.client && !['claude', 'codex'].includes(result.client))) throw new Error('A valid cycle, stage, receipt token and document are required.');
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { client, ...payload } = checkpointArguments(process.argv.slice(2));
    const from = await detectSender({ client });
    const result = await checkpointViaManager(fileURLToPath(new URL('../', import.meta.url)), { from, ...payload });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
