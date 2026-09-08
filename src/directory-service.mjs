import { realpath, stat } from 'node:fs/promises';
import { resolve, win32, posix } from 'node:path';

export function normalizeDirectory(value) {
  let path = String(value || '').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').replaceAll('\\', '/');
  const windows = /^[a-z]:\//i.test(path) || path.startsWith('//');
  path = (windows ? win32 : posix).normalize(path).replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' || windows ? path.toLowerCase() : path;
}
export function containsDirectory(cwd, root, recursive = false) {
  if (!cwd || !root) return false;
  const child = normalizeDirectory(cwd), parent = normalizeDirectory(root);
  return child === parent || (recursive && child.startsWith(parent + '/'));
}
export async function validateDirectory(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请填写完整目录路径。');
  const path = await realpath(resolve(value));
  if (!(await stat(path)).isDirectory()) throw new Error('所选路径不是目录。');
  return { path, normalized: normalizeDirectory(path) };
}
export function matchesDirectories(message, directories) {
  return directories.length === 0 || directories.some(directory => [message.from.cwd, message.to.cwd]
    .some(cwd => containsDirectory(cwd, directory.path, directory.recursive === true || directory.recursive === 'true')));
}
