import { readFile } from 'node:fs/promises';
import { resolve, join, win32, posix } from 'node:path';

const installationRoot = resolve(import.meta.dirname, '..');
function canonical(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let path = value.replaceAll('\\', '/').replace(/^\/\/\?\//, '');
  path = (/^[a-z]:\//i.test(path) ? win32 : posix).normalize(path).replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' || /^[a-z]:\//i.test(path) ? path.toLowerCase() : path;
}
export class DirectoryAccessPolicy {
  constructor(protectedDirectories = []) {
    if (!Array.isArray(protectedDirectories) || protectedDirectories.some(p => !canonical(p))) throw new Error('Invalid protected-directory policy.');
    this.denied = protectedDirectories.map(canonical);
  }
  permits(directory, recursive = false) {
    const path = canonical(directory);
    if (!path) return false;
    return !this.denied.some(root => path === root || path.startsWith(root + '/') || recursive && root.startsWith(path + '/'));
  }
  assert(directory, recursive = false) {
    if (!this.permits(directory, recursive)) throw Object.assign(new Error('目标目录受保护，禁止发现、读取和会话操作。'), { code: 'DIRECTORY_PROTECTED', outcome: 'not_submitted' });
  }
}
export async function readAccessPolicy(root = installationRoot) {
  // Product policy configured by the operator only. Restrictions on a coding
  // agent's own file access must never be copied into this runtime denylist.
  let input;
  try { input = JSON.parse(await readFile(join(root, '.cooperation', 'access-policy.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return new DirectoryAccessPolicy(); throw error; }
  if (input.version !== 1) throw new Error('Unsupported directory access policy.');
  return new DirectoryAccessPolicy(input.protectedDirectories);
}
