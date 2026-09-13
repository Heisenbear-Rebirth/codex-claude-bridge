import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { loadPeerHistory } from '../src/claude-peer-history.mjs';
import { messageEnvelope } from '../src/address.mjs';
const hash = data => createHash('sha256').update(data).digest('hex');
async function setup(t) {
  const dir = await mkdtemp(join(resolve('.'), '.peer-history-test-')), sessionId = randomUUID();
  const configDir = join(dir, 'claude'), folder = join(configDir, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(folder, { recursive: true }); const file = join(folder, sessionId + '.jsonl');
  t.after(async () => { assert.ok(dir.startsWith(resolve('.') + sep)); await rm(dir, { recursive: true, force: true }); });
  const entry = (parentUuid, patch = {}) => ({ sessionId, uuid: randomUUID(), parentUuid, type: 'assistant', message: { role: 'assistant', content: [] }, ...patch });
  const peer = parentUuid => {
    const record = entry(parentUuid, { type: 'user', isMeta: true, origin: { kind: 'peer', from: 'unknown' } });
    record.message = { role: 'user', content: messageEnvelope({ client: 'codex', id: randomUUID(), name: 'test' }, 'history body', record.uuid) };
    return record;
  };
  const put = records => writeFile(file, records.map(x => JSON.stringify(x)).join('\n') + '\n');
  return { dir, sessionId, configDir, file, entry, peer, put, load: options => loadPeerHistory({ sessionId, cwd: dir, configDir, ...options }) };
}
test('history selects confirmed peers on the current branch and never rewrites the transcript', async t => {
  const h = await setup(t), start = h.entry(null), first = h.peer(start.uuid), stale = h.peer(first.uuid), current = h.peer(first.uuid), end = h.entry(current.uuid);
  const other = h.peer(end.uuid); other.sessionId = randomUUID();
  const side = h.peer(end.uuid); side.isSidechain = true;
  await h.put([start, first, stale, current, end, other, side]);
  const before = hash(await readFile(h.file)); const result = await h.load();
  assert.equal(result.status, 'completed'); assert.deepEqual(result.frames.map(x => x.uuid), [first.uuid, current.uuid]);
  assert.ok(result.frames.every(x => x.isReplay === true && x.isSynthetic === false && x.origin.kind === 'peer'));
  assert.equal(hash(await readFile(h.file)), before);
  assert.deepEqual((await h.load()).frames, result.frames);
});
test('malformed, non-Cooperation, missing and oversized history do not fabricate a delivery', async t => {
  const h = await setup(t), start = h.entry(null), noEnvelope = h.peer(start.uuid);
  noEnvelope.message.content = 'external peer';
  await h.put([start, noEnvelope, h.entry(noEnvelope.uuid)]);
  assert.deepEqual((await h.load()).frames, []);
  await writeFile(h.file, '{broken}\n' + 'x'.repeat(1024 * 1024 + 1) + '\n');
  assert.deepEqual((await h.load()).frames, []);
  assert.equal((await h.load({ sessionId: '../wrong' })).status, 'unavailable');
  assert.equal((await h.load({ sessionId: randomUUID() })).reason, 'history_not_found');
});
test('history bounds restoration to recent peers in original order and reports truncation', async t => {
  const h = await setup(t), start = h.entry(null), a = h.peer(start.uuid), b = h.peer(a.uuid), c = h.peer(b.uuid);
  await h.put([start, a, b, c, h.entry(c.uuid)]);
  const result = await h.load({ limit: 2 });
  assert.equal(result.truncated, true); assert.deepEqual(result.frames.map(x => x.uuid), [b.uuid, c.uuid]);
});
