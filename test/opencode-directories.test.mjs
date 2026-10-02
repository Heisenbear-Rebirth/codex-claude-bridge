import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Cooperation from '../plugins/opencode.mjs';
import { openCodeDirectoryEnabled } from '../src/opencode-directories.mjs';
import { createOpenCodeAdapter } from '../src/adapters/opencode.mjs';
import { listClaudeSessions } from '../src/adapters/claude.mjs';
import { startServer } from '../src/http-server.mjs';
import { readAccessPolicy } from '../src/access-policy.mjs';

async function fixture(t) {
  const parent = resolve('.cooperation/multi-directory-tests'); await mkdir(parent, { recursive: true });
  const base = await mkdtemp(join(parent, 'case-'));
  const root = join(base, 'manager'), a = join(base, 'project-a'), b = join(base, 'project-b'), configDir = join(base, 'claude');
  for (const p of [join(root, '.cooperation'), a, b, join(configDir, 'sessions')]) await mkdir(p, { recursive: true });
  await writeFile(join(root, '.cooperation/session-lifecycle-cancelled.json'), '{}');
  const claudeId = randomUUID();
  await writeFile(join(configDir, 'sessions', process.pid + '.json'), JSON.stringify({ sessionId: claudeId, pid: process.pid, cwd: b, name: 'Claude fixture' }));
  const adapters = { opencode: createOpenCodeAdapter({ root }), claude: { list: query => listClaudeSessions({ ...query, configDir }) } };
  const manager = await startServer({ root, port: 0, adapters, startMonitoring: false,
    runtimeFactory: () => ({ status: async () => ({ connected: false, capabilities: {} }), close() {} }) });
  const hooks = [];
  t.after(async () => { for (const hook of hooks) await hook.dispose?.(); await manager.close(); await rm(base, { recursive: true, force: true }); });
  const csrf = (await (await fetch(manager.url + '/api/config')).json()).csrfToken;
  const post = async (path, body) => {
    const response = await fetch(manager.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Coop-UI': csrf }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return response.json();
  };
  let nativeCalls = 0;
  const nativeSession = { id: 'ses_MultiDirectoryABC123', directory: a, title: 'OpenCode fixture', time: { updated: Date.now() } };
  const client = { session: { list: async () => { nativeCalls++; return { data: [nativeSession] }; } } };
  const connect = async (directory, options = {}) => {
    const hook = await Cooperation({ client, directory }, { root, directories: [root], ...options }); hooks.push(hook); return hook;
  };
  return { base, root, a, b, manager, post, connect, nativeSession, claudeId, nativeCalls: () => nativeCalls };
}

test('Managed projects enable the global OpenCode plugin and both clients appear outside installation directory', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.connect(f.a), {});
  assert.equal(f.nativeCalls(), 0);
  const a = (await f.post('/api/directories', { path: f.a })).directory;
  const b = (await f.post('/api/directories', { path: f.b })).directory;
  const hook = await f.connect(f.a);
  assert.deepEqual(Object.keys(hook.tool), ['cooperation_send_message', 'cooperation_context_checkpoint']);
  const result = await f.post('/api/sessions', { directoryIds: [a.id, b.id] });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.sessions.map(s => s.client).sort(), ['claude', 'opencode']);
  assert.equal(result.sessions.find(s => s.client === 'opencode').id, f.nativeSession.id);
  assert.equal(result.sessions.find(s => s.client === 'claude').id, f.claudeId);
  await f.post('/api/directories/remove', { id: a.id });
  assert.deepEqual(await f.connect(f.a), {});
  const remaining = await f.post('/api/sessions', { directoryIds: [a.id, b.id] });
  assert.deepEqual(remaining.sessions.map(s => s.client), ['claude']);
});

test('Managed directory matching honors recursion, disabled directories and an explicit strict plugin scope', async t => {
  const f = await fixture(t), options = { root: f.root, directories: [f.root] };
  let directory = (await f.post('/api/directories', { path: f.a })).directory;
  const child = join(f.a, 'child');
  assert.equal(await openCodeDirectoryEnabled(child, options), false);
  assert.equal(await openCodeDirectoryEnabled(f.a + '-other', options), false);
  directory = (await f.post('/api/directories', { path: f.a, recursive: true })).directory;
  assert.equal(await openCodeDirectoryEnabled(child, options), true);
  assert.equal(await openCodeDirectoryEnabled(f.a, { ...options, followManagedDirectories: false }), false);
  f.manager.store.saveDirectory({ ...directory, enabled: false });
  assert.equal(await openCodeDirectoryEnabled(child, options), false);
  assert.equal(await openCodeDirectoryEnabled(f.a, { ...options, directories: [f.a], followManagedDirectories: false }), true);
  assert.equal(f.nativeCalls(), 0);
});

test('Offline and mismatched managers cannot authorize new projects; agent restrictions are not product defaults', async t => {
  const f = await fixture(t), offlineRoot = join(f.base, 'offline-manager');
  await mkdir(join(offlineRoot, '.cooperation'), { recursive: true });
  assert.equal(await openCodeDirectoryEnabled(f.a, { root: offlineRoot }), false);
  assert.equal(await openCodeDirectoryEnabled(f.a, { root: offlineRoot, directories: [f.a] }), true);
  await f.post('/api/directories', { path: f.a });
  const connection = await readFile(join(f.root, '.cooperation/connection.json'));
  await writeFile(join(offlineRoot, '.cooperation/connection.json'), connection);
  assert.equal(await openCodeDirectoryEnabled(f.a, { root: offlineRoot }), false);
  const policy = await readAccessPolicy(offlineRoot);
  assert.equal(policy.permits(f.a), true); assert.equal(policy.permits(f.b), true);
  await assert.rejects(openCodeDirectoryEnabled(f.a, { root: f.root, followManagedDirectories: 'yes' }), /boolean/);
  assert.equal(f.nativeCalls(), 0);
});
