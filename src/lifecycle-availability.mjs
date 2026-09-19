import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
export function lifecycleEnabled(root = resolve(import.meta.dirname, '..')) {
  return !existsSync(join(root, 'session-lifecycle-cancelled.json'))
    && !existsSync(join(root, '.cooperation', 'session-lifecycle-cancelled.json'));
}
