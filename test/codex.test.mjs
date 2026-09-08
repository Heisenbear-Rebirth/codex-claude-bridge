import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { findCodexSession, listCodexSessions, sendCodexMessage } from '../src/adapters/codex.mjs';

async function workspaceFixture(t) {
  // All temporary databases and mock bridges stay inside the project workspace.
  const root = await mkdtemp(join(resolve('.'), '.codex-adapter-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function makeDatabase(root, version = 5) {
  const database = new DatabaseSync(join(root, `state_${version}.sqlite`));
  database.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, name TEXT, title TEXT, cwd TEXT,
    updated_at INTEGER, updated_at_ms INTEGER,
    first_user_message TEXT, preview TEXT,
    source TEXT DEFAULT 'vscode', thread_source TEXT DEFAULT 'user',
    agent_role TEXT, agent_path TEXT
  )`);
  return database;
}

test('lists directory history completely, without guessing live state or exposing conversation text', async (t) => {
  const root = await workspaceFixture(t);
  const database = makeDatabase(root);
  const insert = database.prepare('INSERT INTO threads (id,name,title,cwd,updated_at,updated_at_ms,first_user_message,preview) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('old', null, 'Old title', '\\\\?\\E:\\Projects\\Cooperation', 1700000000, null, 'PRIVATE BODY', 'PRIVATE PREVIEW');
  insert.run('new', 'Custom name', 'Original title', 'e:/projects/cooperation/', 1800000000, 1800000000123, 'PRIVATE BODY', 'PRIVATE PREVIEW');
  insert.run('child', null, 'Child', 'E:/Projects/Cooperation/sub', 1800000001, null, '', '');
  insert.run('neighbor', null, 'Neighbor', 'E:/Projects/Cooperation-other', 1800000001, null, '', '');
  for (let index = 0; index < 150; index += 1) insert.run(`historic-${index}`, null, `Historic ${index}`, 'E:/Projects/Cooperation', 1600000000 + index, null, '', '');
  database.close();
  const result = await listCodexSessions({ codexHome: root, directory: 'E:/Projects/COOPERATION' });
  assert.equal(result.sessions.length, 152);
  assert.equal(result.sessions[0].id, 'new');
  assert.equal(result.sessions[0].name, 'Custom name');
  assert.equal(result.sessions.find((entry) => entry.id === 'old').cwd, 'E:/Projects/Cooperation');
  assert.equal(result.sessions[0].updatedAt, '2027-01-15T08:00:00.123Z');
  assert.ok(result.sessions.every((entry) => entry.status === 'unknown' && entry.live === false));
  assert.ok(result.warnings.some((warning) => warning.includes('live status is unknown')));
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.deepEqual(Object.keys(result.sessions[0]).sort(), ['client', 'cwd', 'id', 'live', 'name', 'status', 'updatedAt']);
  const nested = await listCodexSessions({ codexHome: root, directory: 'E:/Projects/Cooperation', recursive: true });
  assert.equal(nested.sessions.length, 153);
  assert.ok(nested.sessions.some((entry) => entry.id === 'child'));
  assert.ok(!nested.sessions.some((entry) => entry.id === 'neighbor'));
});

test('hides internal workers and reviewers from discovery and precise ID lookup while retaining legacy user conversations', async (t) => {
  const root = await workspaceFixture(t);
  const database = makeDatabase(root);
  const insert = database.prepare('INSERT INTO threads (id,title,cwd,source,thread_source,agent_role,agent_path) VALUES (?,?,?,?,?,?,?)');
  insert.run('user', 'User title', '/project', 'vscode', 'user', null, null);
  insert.run('legacy-user', 'Legacy title', '/project', 'vscode', null, null, null);
  insert.run('worker', 'INTERNAL WORKER PROMPT', '/project', JSON.stringify({ subagent: { thread_spawn: { depth: 1 } } }), 'subagent', null, '/root/worker');
  insert.run('reviewer', 'INTERNAL REVIEW PROMPT', '/project', JSON.stringify({ subagent: { other: 'guardian' } }), 'guardian_review', null, null);
  insert.run('legacy-worker', 'INTERNAL LEGACY PROMPT', '/project', JSON.stringify({ subagent: { other: 'review' } }), null, null, null);
  insert.run('role-worker', 'INTERNAL ROLE PROMPT', '/project', 'vscode', 'user', 'reviewer', null);
  insert.run('path-worker', 'INTERNAL PATH PROMPT', '/project', 'vscode', 'user', null, '/root/task');
  insert.run('unknown', 'UNVERIFIED PROMPT', '/project', null, null, null, null);
  database.close();
  const result = await listCodexSessions({ codexHome: root, directory: '/project' });
  assert.deepEqual(result.sessions.map((session) => session.id).sort(), ['legacy-user', 'user']);
  assert.ok(!JSON.stringify(result).includes('INTERNAL'));
  for (const id of ['worker', 'reviewer', 'legacy-worker', 'role-worker', 'path-worker', 'unknown']) {
    assert.equal(await findCodexSession(id, { codexHome: root }), null);
  }
});

test('protects session labels from long or multiline input while preserving explicit names', async (t) => {
  const root = await workspaceFixture(t);
  const database = makeDatabase(root);
  const insert = database.prepare('INSERT INTO threads (id,name,title,cwd) VALUES (?,?,?,?)');
  insert.run('named', ' Actual\n user name ', 'PROMPT '.repeat(1000), '/project');
  insert.run('short', null, 'A concise title', '/project');
  insert.run('long-input', null, 'PRIVATE INPUT '.repeat(1000), '/project');
  insert.run('multiline-input', null, 'PRIVATE INPUT\nSecond line', '/project');
  insert.run('empty', null, '', '/project');
  insert.run('long-name', '😀'.repeat(140), null, '/project');
  database.close();
  const { sessions } = await listCodexSessions({ codexHome: root });
  const names = Object.fromEntries(sessions.map((session) => [session.id, session.name]));
  assert.equal(names.named, 'Actual user name');
  assert.equal(names.short, 'A concise title');
  for (const id of ['long-input', 'multiline-input', 'empty']) assert.equal(names[id], '未命名 Codex 会话');
  assert.equal(Array.from(names['long-name']).length, 120);
  assert.ok(names['long-name'].endsWith('…'));
  assert.ok(!JSON.stringify(sessions).includes('PRIVATE INPUT'));
});

test('matches extended UNC history directories without confusing neighboring shares', async (t) => {
  const root = await workspaceFixture(t);
  const database = makeDatabase(root);
  const insert = database.prepare('INSERT INTO threads (id,title,cwd) VALUES (?,?,?)');
  insert.run('share', 'Share', '\\\\?\\UNC\\Server\\Project\\directory');
  insert.run('child', 'Child', '\\\\Server\\Project\\directory\\child');
  insert.run('neighbor', 'Neighbor', '\\\\Server\\Project2\\directory');
  database.close();
  const result = await listCodexSessions({ codexHome: root, directory: '\\\\server\\project\\directory', recursive: true });
  assert.deepEqual(result.sessions.map((entry) => entry.id).sort(), ['child', 'share']);
});

test('finds exact IDs in the newest database without reviving stale schema generations', async (t) => {
  const root = await workspaceFixture(t);
  const old = makeDatabase(root, 4);
  old.prepare('INSERT INTO threads (id,title,cwd) VALUES (?,?,?)').run('stale', 'Old generation', '/project');
  old.close();
  const current = makeDatabase(root, 5);
  current.prepare('INSERT INTO threads (id,title,cwd) VALUES (?,?,?)').run('actual', 'Current title', '/project');
  current.close();
  assert.equal((await findCodexSession('actual', { codexHome: root })).name, 'Current title');
  assert.equal(await findCodexSession('stale', { codexHome: root }), null);
  assert.equal(await findCodexSession("' OR 1=1 --", { codexHome: root }), null);
  assert.equal(await findCodexSession('', { codexHome: root }), null);
});

test('history reads preserve the database and tolerate missing or incompatible schemas', async (t) => {
  const root = await workspaceFixture(t);
  const database = makeDatabase(root);
  database.prepare('INSERT INTO threads (id,title,cwd) VALUES (?,?,?)').run('entry', 'Title', '/project');
  database.close();
  const before = await readFile(join(root, 'state_5.sqlite'));
  await listCodexSessions({ codexHome: root });
  assert.deepEqual(await readFile(join(root, 'state_5.sqlite')), before);
  const incompatible = new DatabaseSync(join(root, 'state_6.sqlite'));
  incompatible.exec('CREATE TABLE unrelated (id TEXT)');
  incompatible.close();
  const fallback = await listCodexSessions({ codexHome: root });
  assert.equal(fallback.sessions.length, 1);
  assert.ok(fallback.warnings.some((warning) => warning.includes('Unsupported')));
  const missing = await listCodexSessions({ codexHome: join(root, 'missing') });
  assert.equal(missing.sessions.length, 0);
  assert.ok(missing.warnings.length > 0);
});

async function mockBridge(t, { behavior = 'success', discover = false } = {}) {
  const root = await workspaceFixture(t);
  const bridgeDirectory = discover ? join(root, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools', '0.1.12') : root;
  await mkdir(bridgeDirectory, { recursive: true });
  const bridgePath = join(bridgeDirectory, 'server.mjs');
  const logPath = join(root, 'calls.jsonl');
  const pidPath = join(root, 'bridge.pid');
  const script = `
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
const behavior = ${JSON.stringify(behavior)};
createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(request) + '\\n');
  if (request.id == null) return;
  const reply = result => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result}) + '\\n');
  if (request.method === 'initialize') return reply({protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'mock',version:'1'}});
  if (request.method === 'tools/list') return reply({tools:behavior === 'missing-tool' ? [] : [{name:'send_message_to_thread'}]});
  if (request.method === 'tools/call') {
    if (behavior === 'timeout') return;
    if (behavior === 'exit') return process.exit(1);
    if (behavior === 'reject') return reply({isError:true,content:[{type:'text',text:'Rejected'}]});
    return reply({isError:false,content:[{type:'text',text:JSON.stringify({threadId:request.params.arguments.threadId})}]});
  }
}).on('close', () => process.exit(0));
`;
  await writeFile(bridgePath, script);
  if (discover) {
    const old = join(root, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools', '0.1.9');
    await mkdir(old, { recursive: true });
    await writeFile(join(old, 'server.mjs'), 'throw new Error("Wrong old bridge selected");');
  }
  return {
    root, logPath, pidPath,
    context: {
      nodePath: process.execPath,
      pipePath: 'mock-pipe-not-a-real-app',
      callerThreadId: 'real-source-from-startup',
      ...(discover ? { codexHome: root } : { bridgePath }),
      requestTimeoutMs: 150,
      handshakeTimeoutMs: 5000,
    },
  };
}

test('external stdio bridge sends once with source metadata separate from the exact target', async (t) => {
  const fixture = await mockBridge(t, { discover: true });
  const text = 'Business sender: claude:sender-123\nMessage with a newline and 中文';
  const result = await sendCodexMessage({ targetId: 'target-456', text, context: fixture.context });
  assert.equal(result.status, 'submitted');
  assert.equal(result.transport, 'codex-app-tools');
  assert.equal(result.targetId, 'target-456');
  const calls = (await readFile(fixture.logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map((entry) => entry.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.deepEqual(calls[3].params.arguments, { threadId: 'target-456', prompt: text });
  assert.deepEqual(calls[3].params._meta, { 'openai/threadId': 'real-source-from-startup' });
  const pid = Number(await readFile(fixture.pidPath, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('a timed-out send has unknown delivery, is cancelled, and is never retried', async (t) => {
  const fixture = await mockBridge(t, { behavior: 'timeout' });
  await assert.rejects(sendCodexMessage({ targetId: 'target', text: 'test', context: fixture.context }), (error) => {
    assert.equal(error.code, 'CODEX_BRIDGE_TIMEOUT');
    assert.equal(error.outcome, 'unknown');
    assert.equal(error.retryable, false);
    return true;
  });
  const calls = (await readFile(fixture.logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter((entry) => entry.method === 'tools/call').length, 1);
  assert.ok(calls.some((entry) => entry.method === 'notifications/cancelled'));
  const pid = Number(await readFile(fixture.pidPath, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('missing connection and missing bridge fail before any submission', async (t) => {
  const root = await workspaceFixture(t);
  await assert.rejects(sendCodexMessage({ targetId: 'target', text: 'test', context: { pipePath: '', callerThreadId: '' } }), { code: 'CODEX_CONTEXT_MISSING', outcome: 'not_submitted' });
  await assert.rejects(sendCodexMessage({ targetId: 'target', text: 'test', context: { pipePath: 'mock', callerThreadId: 'source', codexHome: root } }), { code: 'CODEX_BRIDGE_MISSING', outcome: 'not_submitted' });
});

test('unavailable send tool fails before submission, while a lost send response stays unknown', async (t) => {
  const noTool = await mockBridge(t, { behavior: 'missing-tool' });
  await assert.rejects(sendCodexMessage({ targetId: 'target', text: 'test', context: noTool.context }), { code: 'CODEX_SEND_UNAVAILABLE', outcome: 'not_submitted' });
  const lost = await mockBridge(t, { behavior: 'exit' });
  await assert.rejects(sendCodexMessage({ targetId: 'target', text: 'test', context: lost.context }), { code: 'CODEX_BRIDGE_CLOSED', outcome: 'unknown', retryable: false });
});
