import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { findClaudeSession, listClaudeSessions, sendClaudeMessage, MAX_CLAUDE_MESSAGE_BYTES } from '../src/adapters/claude.mjs';

async function fixture(t) {
  const workspace = path.resolve(process.cwd());
  const base = path.join(workspace, 'test');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, '.claude-fixture-'));
  await mkdir(path.join(root, 'sessions'), { recursive: true });
  await mkdir(path.join(root, 'projects'), { recursive: true });
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), base);
    assert.ok(path.basename(resolved).startsWith('.claude-fixture-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return root;
}

async function transcript(root, cwd, id, records) {
  const folder = path.join(root, 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, `${id}.jsonl`), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

async function registry(root, id, cwd, extra = {}) {
  await writeFile(path.join(root, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id, cwd, startedAt: Date.now(), entrypoint: 'claude-vscode', name: 'generated-peer-name', ...extra }));
}

test('Claude listing merges live metadata and UI custom title without exposing message content', async (t) => {
  const root = await fixture(t);
  const cwd = path.join(root, 'selected-project');
  const id = randomUUID();
  await transcript(root, cwd, id, [
    { type: 'user', sessionId: id, cwd, message: { content: 'PRIVATE_CHAT_BODY with fake metadata: "customTitle":"Wrong"' } },
    { type: 'ai-title', sessionId: id, aiTitle: 'Generated title' },
    { type: 'custom-title', sessionId: id, customTitle: 'My VS Code title' },
    { type: 'ai-title', sessionId: id, aiTitle: 'Later generated title' },
  ]);
  await registry(root, id, cwd);
  const { sessions, warnings } = await listClaudeSessions({ directory: cwd, configDir: root });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].name, 'My VS Code title');
  assert.equal(sessions[0].id, id);
  assert.equal(sessions[0].live, true);
  assert.equal(sessions[0].status, 'running');
  assert.equal(warnings.length, 0);
  assert.ok(!JSON.stringify(sessions).includes('PRIVATE_CHAT_BODY'));
  assert.equal((await findClaudeSession(id, { configDir: root })).name, 'My VS Code title');
  assert.equal(await findClaudeSession('My VS Code title', { configDir: root }), null);
});

test('directory selection excludes siblings and includes saved descendant sessions only when recursive', async (t) => {
  const root = await fixture(t);
  const cwd = path.join(root, 'selected');
  const childCwd = path.join(cwd, 'child');
  const siblingCwd = path.join(root, 'selected-other');
  const ownId = randomUUID();
  const childId = randomUUID();
  const siblingId = randomUUID();
  for (const [directory, id, title] of [[cwd, ownId, 'Saved'], [childCwd, childId, 'Child'], [siblingCwd, siblingId, 'Excluded sibling']]) {
    await transcript(root, directory, id, [{ type: 'user', sessionId: id, cwd: directory, message: { content: 'never returned' } }, { type: 'ai-title', sessionId: id, aiTitle: title }]);
  }
  assert.deepEqual((await listClaudeSessions({ directory: cwd, configDir: root })).sessions.map((session) => session.id), [ownId]);
  const recursive = await listClaudeSessions({ directory: cwd, recursive: true, configDir: root });
  assert.deepEqual(new Set(recursive.sessions.map((session) => session.id)), new Set([ownId, childId]));
  assert.ok(recursive.sessions.every((session) => !session.live && session.status === 'offline'));
  assert.equal((await findClaudeSession(siblingId, { configDir: root })).name, 'Excluded sibling');
  assert.equal(await findClaudeSession(randomUUID(), { configDir: root }), null);
});

test('Claude sender uses published peer auth, exact target and supplied text against a local mock inbox', async (t) => {
  const root = await fixture(t);
  const cwd = path.join(root, 'test-workspace');
  const id = randomUUID();
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\coop-claude-mock-${process.pid}-${randomUUID()}` : path.join(root, 'inbox.sock');
  const token = 'a'.repeat(32);
  const endpointHash = createHash('sha256').update(process.platform === 'win32' ? endpoint.toLowerCase() : endpoint).digest('hex');
  await registry(root, id, cwd, { messagingSocketPath: endpoint });
  await writeFile(path.join(root, 'sessions', `${process.pid}.${endpointHash}.key`), JSON.stringify({ peerToken: token }));
  let resolveReceived;
  let rejectReceived;
  const received = new Promise((resolve, reject) => { resolveReceived = resolve; rejectReceived = reject; });
  const peers = new Set();
  const server = createServer((socket) => {
    peers.add(socket);
    socket.once('close', () => peers.delete(socket));
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      input += chunk;
      const lines = input.trim().split('\n');
      if (lines.length >= 2) {
        try { resolveReceived(lines.map((line) => JSON.parse(line))); } catch (error) { rejectReceived(error); }
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  t.after(async () => {
    for (const peer of peers) peer.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const messageId = randomUUID();
  const text = '[From Codex test adapter]\nHere is a finding. No reply instruction has been added.';
  const result = await sendClaudeMessage({ targetId: id, text, messageId, configDir: root });
  const timeout = setTimeout(() => rejectReceived(new Error('Local mock inbox did not receive the frames.')), 2000);
  const [auth, frame] = await received.finally(() => clearTimeout(timeout));
  assert.deepEqual(auth, { type: 'auth', token });
  assert.equal(frame.type, 'user');
  assert.equal(frame.session_id, id);
  assert.equal(frame.uuid, messageId);
  assert.equal(frame.message.content, text);
  assert.equal(frame.from, undefined);
  assert.equal(frame.fromMode, undefined);
  assert.equal(result.status, 'submitted');
  assert.equal(result.deliveryConfirmed, false);
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(result).includes(endpoint));
});

test('Claude sender rejects invalid, offline and oversized targets before transport', async (t) => {
  const root = await fixture(t);
  await assert.rejects(sendClaudeMessage({ targetId: 'not-an-id', text: 'hello', configDir: root }), { code: 'CLAUDE_INVALID_SESSION_ID' });
  await assert.rejects(sendClaudeMessage({ targetId: randomUUID(), text: 'hello', configDir: root }), { code: 'CLAUDE_SESSION_OFFLINE' });
  await assert.rejects(sendClaudeMessage({ targetId: randomUUID(), text: 'x'.repeat(MAX_CLAUDE_MESSAGE_BYTES + 1), configDir: root }), { code: 'CLAUDE_MESSAGE_TOO_LARGE' });
  const id = randomUUID();
  await registry(root, id, path.join(root, 'workspace'), { messagingSocketPath: 'https://example.invalid/inbox' });
  await assert.rejects(sendClaudeMessage({ targetId: id, text: 'hello', configDir: root }), { code: 'CLAUDE_INVALID_INBOX' });
});


test('shell cwd changes do not move a conversation out of its project or discard its title', async t => {
  const root = await fixture(t), cwd = path.join(root, 'selected'), id = randomUUID();
  await transcript(root, cwd, id, [
    { type: 'user', sessionId: id, cwd, message: { content: 'private original prompt' } },
    { type: 'custom-title', sessionId: id, customTitle: 'gs' },
    { type: 'assistant', sessionId: id, cwd: path.join(cwd, 'research', 'src') },
  ]);
  await registry(root, id, cwd, { name: 'selected-a1', nameSource: 'derived' });
  const result = await listClaudeSessions({ directory: cwd, configDir: root });
  assert.equal(result.sessions.length, 1); assert.equal(result.sessions[0].name, 'gs');
  assert.equal(result.sessions[0].cwd, cwd);
  assert.equal((await findClaudeSession(id, { configDir: root })).cwd, cwd);
  const child = await listClaudeSessions({ directory: path.join(cwd, 'research'), configDir: root });
  assert.equal(child.sessions.length, 0);
});

test('expired registry-only entries are excluded while saved offline conversations remain visible', async t => {
  const root = await fixture(t), cwd = path.join(root, 'selected'), oldId = randomUUID(), liveId = randomUUID();
  const stale = { pid: 2147483647, sessionId: oldId, cwd, name: 'stale-process-name', startedAt: 1 };
  await writeFile(path.join(root, 'sessions', '2147483647.json'), JSON.stringify(stale));
  assert.equal((await listClaudeSessions({ directory: cwd, configDir: root })).sessions.length, 0);
  assert.equal(await findClaudeSession(oldId, { configDir: root }), null);
  await registry(root, liveId, cwd, { name: 'selected-a1', nameSource: 'derived' });
  let result = await listClaudeSessions({ directory: cwd, configDir: root });
  assert.equal(result.sessions.length, 1); assert.equal(result.sessions[0].id, liveId);
  assert.equal(result.sessions[0].name, 'Claude ' + liveId.slice(0, 8));
  await transcript(root, cwd, oldId, [{ type: 'user', sessionId: oldId, cwd }, { type: 'custom-title', sessionId: oldId, customTitle: 'Saved conversation' }]);
  result = await listClaudeSessions({ directory: cwd, configDir: root });
  assert.equal(result.sessions.length, 2);
  const saved = result.sessions.find(s => s.id === oldId);
  assert.equal(saved.name, 'Saved conversation'); assert.equal(saved.live, false);
});

test('a reused Windows PID cannot revive a stale Claude registry record', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), cwd = path.join(root, 'selected'), id = randomUUID();
  await registry(root, id, cwd, { procStart: '1' });
  assert.equal((await listClaudeSessions({ directory: cwd, configDir: root })).sessions.length, 0);
  assert.equal(await findClaudeSession(id, { configDir: root }), null);
  await transcript(root, cwd, id, [{ type: 'user', sessionId: id, cwd }, { type: 'ai-title', sessionId: id, aiTitle: 'Saved title' }]);
  const result = await listClaudeSessions({ directory: cwd, configDir: root });
  assert.equal(result.sessions.length, 1); assert.equal(result.sessions[0].live, false);
  assert.equal(result.sessions[0].name, 'Saved title');
});
