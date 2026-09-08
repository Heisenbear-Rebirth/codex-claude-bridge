#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseAddress } from '../src/address.mjs';
import { CodexRuntime } from '../src/runtime/codex-runtime.mjs';
import { ClaudeRuntime } from '../src/runtime/claude-runtime.mjs';

const args = process.argv.slice(2);
const value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
let runtime;
try {
  const target = parseAddress(value('--to') || '');
  runtime = target.client === 'codex' ? new CodexRuntime(target.id) : new ClaudeRuntime(target.id);
  const action = args[0];
  if (!['status', 'context', 'prompt', 'interrupt'].includes(action)) throw new Error('Use: coop-runtime.mjs status|context|prompt|interrupt --to client:ID');
  if (action === 'status') console.log(JSON.stringify(await runtime.status(), null, 2));
  else if (action === 'context') {
    if (target.client !== 'claude') throw new Error('Use coop-context.mjs for Codex recorded context.');
    console.log(JSON.stringify(await runtime.context(), null, 2));
  } else {
    const expected = JSON.parse(await readFile(value('--expected-file'), 'utf8'));
    const result = action === 'prompt' ? await runtime.sendControl(await readFile(value('--file'), 'utf8'), expected) : await runtime.interrupt(expected);
    console.log(JSON.stringify(result, null, 2));
    if (!['submitted', 'acknowledged'].includes(result.status)) process.exitCode = 2;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { runtime?.close(); }
