import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeDirectory } from './directory-service.mjs';

export async function readWrapperDirectories(root) {
  try { const config = JSON.parse(await readFile(join(root, '.cooperation', 'claude-wrapper', 'config.json'), 'utf8'));
    return { enabled: config.enabled === true, directories: Array.isArray(config.directories) ? config.directories.filter(d => typeof d === 'string') : [] };
  } catch { return { enabled: false, directories: [] }; }
}
export function wrapperEnabledFor(config, path) { return config.enabled && config.directories.some(d => normalizeDirectory(d) === normalizeDirectory(path)); }
export class WrapperDirectorySettings {
  constructor(root) { this.root = root; this.pending = Promise.resolve(); }
  set(path, enabled) {
    const operation = this.pending.then(async () => {
      const folder = join(this.root, '.cooperation', 'claude-wrapper'); await mkdir(folder, { recursive: true });
      const filename = join(folder, 'config.json'); let source = {};
      try { source = JSON.parse(await readFile(filename, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const directories = (source.directories || []).filter(d => normalizeDirectory(d) !== normalizeDirectory(path));
      if (enabled) directories.push(path);
      const next = { ...source, enabled: enabled ? true : source.enabled === true, directories };
      await writeFile(filename + '.tmp', JSON.stringify(next, null, 2) + '\n'); await rename(filename + '.tmp', filename); return next;
    });
    this.pending = operation.catch(() => {}); return operation;
  }
}
