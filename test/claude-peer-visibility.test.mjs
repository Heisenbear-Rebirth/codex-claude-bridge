import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { visiblePeerMessage, PeerMessageVisibility } from '../src/claude-peer-visibility.mjs';
import { messageEnvelope } from '../src/address.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const session = randomUUID();
function peer(id = randomUUID(), sid = session) {
  return { type: 'user', session_id: sid, uuid: id, parent_tool_use_id: null, isReplay: true, isSynthetic: true,
    origin: { kind: 'peer', from: 'unknown', hostInjected: false },
    message: { role: 'user', content: messageEnvelope({ client: 'codex', id: randomUUID(), name: '发送者' }, '正文中文🙂', id) } };
}
function project(bytes, chunkSize = bytes.length, maximum) {
  const p = new PeerMessageVisibility(() => session, maximum), out = [];
  for (let i = 0; i < bytes.length; i += chunkSize) p.push(bytes.subarray(i, i + chunkSize), b => out.push(b));
  p.end(b => out.push(b)); return Buffer.concat(out);
}
test('peer projection preserves native object, provenance, UUID and replay identity', () => {
  const raw = peer(), before = structuredClone(raw), shown = visiblePeerMessage(raw, session);
  assert.deepEqual(raw, before); assert.equal(shown.isSynthetic, false);
  assert.equal(shown.uuid, raw.uuid); assert.equal(shown.isReplay, true); assert.deepEqual(shown.origin, raw.origin);
  assert.equal(shown.message.content, '【Cooperation 会话消息】\n' + raw.message.content);
  assert.deepEqual(visiblePeerMessage(shown, session), shown);
  const blocks = { ...raw, message: { role: 'user', content: [{ type: 'text', text: raw.message.content }, { type: 'text', text: 'more' }] } };
  const result = visiblePeerMessage(blocks, session);
  assert.equal(result.message.content[1], blocks.message.content[1]); assert.equal(result.isSynthetic, false);
});
test('unrelated, untrusted, subagent and mismatched frames pass byte-for-byte', () => {
  const raw = peer();
  const values = [null, {}, { ...raw, type: 'assistant' }, { ...raw, isReplay: false }, { ...raw, origin: { kind: 'human' } },
    { ...raw, origin: undefined }, { ...raw, parent_tool_use_id: 'subagent' }, { ...raw, session_id: randomUUID() },
    { ...raw, uuid: randomUUID() }, { ...raw, message: { role: 'user', content: 'ordinary peer' } },
    { ...raw, message: { role: 'user', content: [{ type: 'tool_result', content: raw.message.content }] } },
    { ...raw, message: { role: 'user', content: raw.message.content + '\n' + raw.message.content } },
    { ...raw, message: { role: 'user', content: raw.message.content.replace('发送方地址：codex:', '发送方地址：claude:') } }];
  const bytes = Buffer.from(values.map(v => JSON.stringify(v)).join('\r\n') + '\r\n');
  assert.deepEqual(project(bytes, 7), bytes);
  assert.equal(visiblePeerMessage(raw, null), raw);
});
test('split Unicode, mixed controls, malformed and incomplete lines preserve framing', () => {
  const raw = peer();
  const before = Buffer.from('not-json\r\n{"type":"control_response","response":{"request_id":"ide"}}\n');
  const after = Buffer.from('{"type":"result"}\n{"partial":"中文🙂');
  const all = Buffer.concat([before, Buffer.from(JSON.stringify(raw) + '\r\n'), after]);
  const expected = Buffer.concat([before, Buffer.from(JSON.stringify(visiblePeerMessage(raw, session)) + '\r\n'), after]);
  assert.deepEqual(project(all, 1), expected);
});
test('oversized frame passes unchanged and following normal frame still projects', () => {
  const raw = peer(), huge = Buffer.from('x'.repeat(3000) + '\n');
  const line = Buffer.from(JSON.stringify(raw) + '\n');
  assert.deepEqual(project(Buffer.concat([huge, line]), 37, 1024), Buffer.concat([huge, project(line)]));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(read) {
  for (let i = 0; i < 200; i++) { const result = await read(); if (result) return result; await sleep(30); }
  throw Error('Fixture timed out');
}
for (const mode of ['enabled', 'env-disabled', 'config-disabled']) test(`busy wrapper output projection: ${mode}`, { skip: process.platform !== 'win32' }, async t => {
  const parent = join(root, '.cooperation', 'peer-visibility-tests'); await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, 'case-')), id = randomUUID();
  await writeFile(join(dir, 'config.json'), JSON.stringify({ enabled: true, directories: [dir], peerMessageVisibility: mode !== 'config-disabled' }));
  const child = spawn(join(root, 'bin', 'claude-wrapper.exe'), [process.execPath, join(root, 'test', 'fixtures', 'claude-peer-visibility-child.mjs'), '--input-format', 'stream-json', '--output-format', 'stream-json', '--resume', id],
    { cwd: dir, windowsHide: true, env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, 'claude'), COOP_WRAPPER_DATA_DIRECTORY: dir, COOP_PEER_MESSAGE_VISIBILITY: mode === 'env-disabled' ? '0' : '1', COOP_PEER_HISTORY_VISIBILITY: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const output = [], errors = []; child.stderr.on('data', c => errors.push(c.toString()));
  const exited = new Promise(r => child.once('close', r));
  createInterface({ input: child.stdout }).on('line', line => output.push(JSON.parse(line)));
  t.after(async () => { child.stdin.end(); await Promise.race([exited, sleep(3000)]); if (child.exitCode === null) child.kill(); await exited;
    assert.ok(resolve(dir).startsWith(resolve(parent) + sep)); await rm(dir, { recursive: true, force: true }); });
  const initialize = { type: 'control_request', request_id: 'test-init', request: { subtype: 'initialize' } };
  child.stdin.write(JSON.stringify(initialize) + '\n');
  const record = await until(async () => {
    for (const name of await readdir(join(dir, 'instances')).catch(() => [])) if (name.endsWith('.json')) {
      try { const s = JSON.parse(await readFile(join(dir, 'instances', name), 'utf8')); if (s.initialized) return s; } catch {}
    }
  });
  async function status() { return (await fetch(record.endpoint + '/status', { headers: { Authorization: `Bearer ${record.token}` } })).json(); }
  const prompt = { type: 'user', session_id: id, uuid: randomUUID(), message: { role: 'user', content: 'hold' } };
  child.stdin.write(JSON.stringify(prompt) + '\n');
  const running = await until(async () => { const s = await status(); return s.activity === 'running' && s; });
  const replay = peer(randomUUID(), id);
  await writeFile(join(dir, 'replay.json'), JSON.stringify({ frames: [replay] }));
  const shown = await until(() => output.find(m => m.uuid === replay.uuid));
  assert.deepEqual(shown, mode === 'enabled' ? visiblePeerMessage(replay, id) : replay);
  const after = await status();
  for (const key of ['childPid', 'activeTurnId', 'activityRevision', 'activity', 'permissionMode', 'queuedNativeInputs']) assert.equal(after[key], running[key], key);
  assert.equal(after.capabilities.peerMessageVisibility, mode === 'enabled');
  assert.equal(after.capabilities.peerHistoryVisibility, false);
  assert.equal(after.visibilityHistory.status, 'disabled');
  assert.equal(output.filter(m => m.uuid === replay.uuid).length, 1);
  await writeFile(join(dir, 'replay.json'), JSON.stringify({ frames: [], finish: true }));
  await until(() => output.some(m => m.type === 'result'));
  assert.ok(output.some(m => m.message?.content?.[0]?.text === 'original-work-completed'));
  assert.equal((await status()).activity, 'idle');
  const inputs = (await readFile(join(dir, 'input.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(inputs, [initialize, prompt]); // No duplicate delivery, injected input or interrupt.
  assert.deepEqual(errors, []);
});


test('history replays wait for a full native line and skip already displayed UUIDs', () => {
  const p = new PeerMessageVisibility(() => session), a = peer(), b = peer(), out = [];
  const emit = chunk => out.push(chunk);
  p.push(Buffer.from(JSON.stringify(a) + '\n'), emit);
  p.push(Buffer.from('{"type":"assistant","message":'), emit);
  p.restoreHistory([a, b], emit);
  assert.equal(out.length, 1);
  p.push(Buffer.from('{"role":"assistant","content":[]}}\n'), emit);
  const values = Buffer.concat(out).toString().trim().split('\n').map(JSON.parse);
  assert.deepEqual(values.map(x => x.uuid).filter(Boolean), [a.uuid, b.uuid]);
  assert.equal(values[1].type, 'assistant'); assert.equal(values[2].isSynthetic, false);
  p.restoreHistory([a, b], emit); assert.equal(out.length, 3);
});


for (const historyEnabled of [false, true]) test(`reopened wrapper history opt-in=${historyEnabled}: no flood, prompt or transcript edits`, { skip: process.platform !== 'win32' }, async t => {
  const parent = join(root, '.cooperation', 'peer-visibility-tests'); await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, 'reopen-')), id = randomUUID(), configDir = join(dir, 'claude');
  t.after(async () => { assert.ok(resolve(dir).startsWith(resolve(parent) + sep)); await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(dir, 'config.json'), JSON.stringify({ enabled: true, directories: [dir], ...(historyEnabled ? { peerHistoryVisibility: true } : {}) }));
  const a = peer(randomUUID(), id), b = peer(randomUUID(), id);
  const folder = join(configDir, 'projects', resolve(dir).replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(folder, { recursive: true });
  const transcript = join(folder, id + '.jsonl');
  const record = (m, parentUuid) => ({ type: 'user', uuid: m.uuid, parentUuid, sessionId: id, isMeta: true, origin: m.origin, message: m.message });
  const contents = [record(a, null), record(b, a.uuid)].map(x => JSON.stringify(x)).join('\n') + '\n';
  await writeFile(transcript, contents);
  for (let restart = 0; restart < 3; restart++) {
    await rm(join(dir, 'replay.json'), { force: true });
    const child = spawn(join(root, 'bin', 'claude-wrapper.exe'), [process.execPath, join(root, 'test', 'fixtures', 'claude-peer-visibility-child.mjs'), '--input-format', 'stream-json', '--output-format', 'stream-json', '--resume', id],
      { cwd: dir, windowsHide: true, env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, COOP_WRAPPER_DATA_DIRECTORY: dir, COOP_PEER_MESSAGE_VISIBILITY: '1', COOP_PEER_HISTORY_VISIBILITY: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [], errors = []; const exited = new Promise(r => child.once('close', r));
    createInterface({ input: child.stdout }).on('line', line => output.push(JSON.parse(line)));
    child.stderr.on('data', b => errors.push(b.toString()));
    const initialize = { type: 'control_request', request_id: 'init-' + restart, request: { subtype: 'initialize' } };
    child.stdin.write(JSON.stringify(initialize) + '\n');
    try {
      const state = await until(async () => {
        for (const name of await readdir(join(dir, 'instances')).catch(() => [])) if (name.endsWith('.json')) {
          try { const s = JSON.parse(await readFile(join(dir, 'instances', name), 'utf8')); if (s.initialized && s.visibilityHistory?.status === (historyEnabled ? 'completed' : 'disabled')) return s; } catch {}
        }
      });
      assert.equal(state.activity, 'idle'); assert.equal(state.activeTurnId, null); assert.equal(state.queuedNativeInputs, 0);
      assert.equal(state.visibilityHistory.count, historyEnabled ? 2 : 0);
      assert.equal(state.capabilities.peerHistoryVisibility, historyEnabled);
      const restored = historyEnabled ? [a.uuid, b.uuid] : [];
      assert.deepEqual(output.filter(x => x.type === 'user').map(x => x.uuid), restored);
      const live = peer(randomUUID(), id), barrier = `replay-${restart}`;
      await writeFile(join(dir, 'replay.json'), JSON.stringify({ frames: [
        ...(historyEnabled ? [a, b, a, b] : []), live, live,
        { type: 'system', subtype: 'status', testBarrier: barrier },
      ] }));
      await until(() => output.some(x => x.testBarrier === barrier));
      assert.deepEqual(output.filter(x => x.type === 'user').map(x => x.uuid), [...restored, live.uuid]);
      assert.ok(output.filter(x => x.type === 'user').every(x => !x.isSynthetic && x.isReplay));
      assert.equal(await readFile(transcript, 'utf8'), contents); assert.deepEqual(errors, []);
    } finally {
      child.stdin.end(); await Promise.race([exited, sleep(3000)]); if (child.exitCode === null) child.kill(); await exited;
    }
  }
  const inputs = (await readFile(join(dir, 'input.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(inputs.map(x => x.type), ['control_request', 'control_request', 'control_request']);
  assert.ok(inputs.every(x => x.request.subtype === 'initialize'));
});


test('history and native replay share one display ledger in either arrival order', () => {
  for (const historyFirst of [false, true]) {
    const p = new PeerMessageVisibility(() => session), a = peer(), out = [];
    const emit = b => out.push(b), live = () => p.push(Buffer.from(JSON.stringify(a) + '\r\n'), emit);
    if (historyFirst) p.restoreHistory([a], emit); else live();
    live(); p.restoreHistory([a, a], emit); live();
    p.push(Buffer.from('{"type":"result","subtype":"success"}\n'), emit);
    p.end(emit);
    const values = Buffer.concat(out).toString().trim().split('\n').map(JSON.parse);
    assert.equal(values.filter(x => x.uuid === a.uuid).length, 1);
    assert.equal(values.at(-1).type, 'result');
  }
});

test('display deduplication normalizes UUID case and stays scoped to a session', () => {
  let current = session;
  const p = new PeerMessageVisibility(() => current), a = peer(), out = [];
  const emit = b => out.push(b);
  p.restoreHistory([a], emit);
  p.push(Buffer.from(JSON.stringify({ ...a, uuid: a.uuid.toUpperCase(), session_id: session.toUpperCase() }) + '\n'), emit);
  current = randomUUID();
  p.push(Buffer.from(JSON.stringify({ ...a, session_id: current }) + '\n'), emit);
  assert.equal(out.length, 2);
});
