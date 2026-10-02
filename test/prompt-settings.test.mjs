import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, randomInt } from 'node:crypto';
import { PromptSettings, readPromptSettings, claudeDisplayLabel } from '../src/prompt-settings.mjs';
import { defaultPromptValues, validatePromptValues, renderPromptTemplate } from '../public/prompt-templates.mjs';
import { startServer } from '../src/http-server.mjs';
import { PeerMessageVisibility } from '../src/claude-peer-visibility.mjs';
import { messageEnvelope } from '../src/address.mjs';

async function fixture(t, cleanup = true) {
  const root = await mkdtemp(join(resolve('.cooperation'), 'prompt-settings-test-'));
  if (cleanup) t.after(() => rm(root, { recursive: true, force: true })); return root;
}
test('prompt settings validate required receipts, literal substitutions, field bounds and concurrent revisions', async t => {
  const root = await fixture(t), settings = new PromptSettings(root), values = defaultPromptValues();
  assert.equal((await settings.read()).revision, 0);
  values.messages.opencode.prefix = ''; values.messages.claude.label = '';
  values.maintenance.handoff = '保存到 {{documentPath}}\n{{checkpoint}}';
  const results = await Promise.allSettled([settings.save(values, 0), settings.save(defaultPromptValues(), 0)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.statusCode, 409);
  assert.deepEqual((await new PromptSettings(root).read()).values, values);
  assert.equal(claudeDisplayLabel(root), '');
  const bad = structuredClone(values); bad.maintenance.restore = '缺少回执'; assert.throws(() => validatePromptValues(bad), /checkpoint/);
  bad.maintenance.restore = '{{checkpoint}} {{unknown}}'; assert.throws(() => validatePromptValues(bad), /未知变量/);
  bad.maintenance.restore = '{{checkpoint}} {{checkpoint}}'; assert.throws(() => validatePromptValues(bad), /一个/);
  bad.maintenance.restore = '{{checkpoint}}'; bad.messages.codex.suffix = 'x'.repeat(16385); assert.throws(() => validatePromptValues(bad), /长度/);
  assert.equal(renderPromptTemplate('{{documentPath}} {{checkpoint}}', { documentPath: '$&{{checkpoint}}', checkpoint: '<token>' }), '$&{{checkpoint}} <token>');
});

test('HTTP prompt editing requires CSRF, survives reload, previews only examples and freezes queued message affixes', async t => {
  const root = await fixture(t, false), sessions = ['codex', 'claude', 'opencode'].map(client => ({ client, id: client === 'opencode' ? 'ses_CustomPrompts123' : randomUUID(), cwd: root, name: client }));
  const delivered = [];
  const adapters = Object.fromEntries(sessions.map(s => [s.client, { find: async id => id === s.id ? s : null, list: async () => ({ sessions: [s] }),
    send: async input => { delivered.push({ client: s.client, ...input }); return { status: 'submitted' }; } }]));
  let manager = await startServer({ root, port: 0, startMonitoring: false, adapters });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const config = await (await fetch(manager.url + '/api/config')).json();
  const initial = await (await fetch(manager.url + '/api/prompt-settings')).json();
  assert.equal(initial.revision, 0); assert.match(initial.samples.opencode.handoffCheckpoint, /cooperation_context_checkpoint/);
  assert.match(initial.samples.claude.restoreCheckpoint, /运行时生成/);
  const values = structuredClone(initial.values);
  for (const client of ['codex','claude','opencode']) { values.messages[client].prefix = client + ' prefix'; values.messages[client].suffix = client + ' suffix'; }
  const post = (body, csrf = config.csrfToken) => fetch(manager.url + '/api/prompt-settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Coop-UI': csrf }, body: JSON.stringify(body) });
  assert.equal((await post({ values, expectedRevision: 0 }, 'wrong')).status, 403);
  assert.equal((await post({ values, expectedRevision: 0 })).status, 200);
  assert.equal((await post({ values, expectedRevision: 0 })).status, 409);
  const cycle = manager.store.createCycle({ session: sessions[1], state: 'writing_handoff' });
  const queued = await manager.service.send({ from: sessions[0], to: 'claude:' + sessions[1].id, message: 'literal body <script>' });
  assert.equal(queued.status, 'queued');
  values.messages.claude.prefix = 'new prefix';
  assert.equal((await post({ values, expectedRevision: 1 })).status, 200);
  manager.store.releaseCycle(cycle.id, { cancel: true, releaseMessages: true }); await manager.service.mailbox.flush();
  assert.ok(delivered[0].text.startsWith('claude prefix\n\n发送方：'));
  assert.ok(delivered[0].text.endsWith('literal body <script>\n\nclaude suffix'));
  for (const target of [sessions[0], sessions[2]]) await manager.service.send({ from: sessions[1], to: target.client + ':' + target.id, message: 'next message' });
  assert.ok(delivered.find(x => x.client === 'codex').text.startsWith('codex prefix\n\n'));
  const native = delivered.find(x => x.client === 'opencode');
  assert.ok(native.text.startsWith('发送方：')); assert.deepEqual(native.messageAffixes, { prefix: 'opencode prefix', suffix: 'opencode suffix' });
  await manager.close(); manager = await startServer({ root, port: 0, startMonitoring: false, adapters });
  assert.deepEqual((await (await fetch(manager.url + '/api/prompt-settings')).json()).values, values);
  assert.equal((await readPromptSettings(root)).revision, 2);
});

test('Claude display labels reload from project settings without changing original peer content', async t => {
  const root = await fixture(t), settings = new PromptSettings(root), values = defaultPromptValues(), sessionId = randomUUID(), id = randomUUID();
  const envelope = messageEnvelope({ client: 'codex', id: randomUUID(), name: 'sender' }, 'body', id);
  const frame = { type: 'user', session_id: sessionId, uuid: id, isReplay: true, isSynthetic: true, origin: { kind: 'peer' }, message: { role: 'user', content: envelope } };
  const visibility = new PeerMessageVisibility(() => sessionId, 1024 * 1024, () => claudeDisplayLabel(root));
  const output = [], emit = chunk => output.push(JSON.parse(chunk));
  values.messages.claude.label = '【自定义协作】'; await settings.save(values, 0);
  visibility.push(Buffer.from(JSON.stringify(frame) + '\n'), emit);
  assert.equal(output[0].message.content, '【自定义协作】\n' + envelope);
  assert.equal(frame.message.content, envelope);
  values.messages.claude.label = ''; await settings.save(values, 1);
  const id2 = randomUUID(), next = { ...frame, uuid: id2, message: { role: 'user', content: envelope.replace(id, id2) } };
  visibility.push(Buffer.from(JSON.stringify(next) + '\n'), emit);
  assert.equal(output[1].message.content, next.message.content); assert.equal(output[1].isSynthetic, false);
});
