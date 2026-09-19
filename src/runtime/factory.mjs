import { CodexRuntime } from './codex-runtime.mjs';
import { ClaudeRuntime } from './claude-runtime.mjs';
import { OpenCodeRuntime } from './opencode-runtime.mjs';

export function createRuntime(session, { opencode } = {}) {
  if (session.client === 'codex') return new CodexRuntime(session.id);
  if (session.client === 'claude') return new ClaudeRuntime(session.id);
  if (session.client === 'opencode') return new OpenCodeRuntime(session.id, opencode);
  throw new Error('Unsupported native client.');
}
