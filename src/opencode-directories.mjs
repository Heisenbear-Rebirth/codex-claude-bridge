import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { containsDirectory } from './directory-service.mjs';
import { installationRoot, localEndpoint, sameDirectory } from './opencode-bridge.mjs';

// Global plugins run in every OpenCode project. The manager's saved directory
// selection supplies the product scope; no project files or native history are
// read here. Explicit plugin directories continue to work with manager offline.
export async function openCodeDirectoryEnabled(directory, options = {}) {
  const root = options.root || installationRoot;
  const directories = options.directories ?? [root];
  if (!Array.isArray(directories) || directories.some(d => typeof d !== 'string' || !d.trim()))
    throw new Error('Cooperation directories must be an array of explicit project paths.');
  if (options.followManagedDirectories !== undefined && typeof options.followManagedDirectories !== 'boolean')
    throw new Error('Cooperation followManagedDirectories must be a boolean.');
  if (directories.some(d => sameDirectory(d, directory))) return true;
  if (options.followManagedDirectories === false) return false;
  try {
    const connection = JSON.parse(await readFile(join(root, '.cooperation', 'connection.json'), 'utf8'));
    const endpoint = localEndpoint(connection.url), signal = AbortSignal.timeout(2000);
    const headers = { Authorization: 'Bearer ' + connection.token };
    const status = await fetch(endpoint + '/api/service/status', { headers, signal, redirect: 'error' });
    if (!status.ok) return false;
    const service = await status.json();
    if (service.service !== 'cooperation' || service.closing || !sameDirectory(service.root, root)) return false;
    const response = await fetch(endpoint + '/api/directories', { headers, signal, redirect: 'error' });
    if (!response.ok) return false;
    const data = await response.json();
    return Array.isArray(data.directories) && data.directories.some(d => d.enabled !== false && typeof d.path === 'string'
      && containsDirectory(directory, d.path, d.recursive === true));
  } catch { return false; }
}
