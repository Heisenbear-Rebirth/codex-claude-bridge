import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { parseAddress, displayAddress, messageEnvelope } from '../src/address.mjs';
import { MessageStore } from '../src/store.mjs';
import { CooperationService } from '../src/service.mjs';

test('copied addresses round trip, including colon and Unicode in the title', () => {
  const session = { client: 'codex', id: '11111111-1111-4111-8111-111111111111', name: '研究: 协作 / α' };
  for (const input of [displayAddress(session), `codex:${session.id}`, `codex://threads/${session.id}`]) assert.deepEqual(parseAddress(input), { client: 'codex', id: session.id });
  assert.deepEqual(parseAddress(`vscode://anthropic.claude-code/open?session=${session.id}`), { client: 'claude', id: session.id });
  for (const input of ['../../secrets', 'codex:../something', 'https://unrelated.example', 'codex://threads/']) assert.throws(() => parseAddress(input));
  const text = '报告：不必改写正文。\n\n结论保留。';
  assert.ok(messageEnvelope(session, text, 'unique').endsWith(text));
  assert.ok(messageEnvelope(session, text, 'unique').includes(displayAddress(session)));
});

test('audit persists name snapshots and recovers an unfinished send without resending', async (t) => {
  const directory = await mkdtemp(join(resolve('.'), '.core-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new MessageStore(directory).init();
  const sender = { client: 'codex', id: 'sender-123', name: '原名称', cwd: 'E:\\Project', displayAddress: 'codex://原名称:sender-123' };
  await store.create({ id: 'one', createdAt: '2026-09-07T00:00:00Z', status: 'pending', from: sender, to: { ...sender, client: 'claude' }, text: 'Original report' });
  sender.name = '新名称';
  assert.equal(store.messages.get('one').from.name, '原名称');
  await appendFile(store.file, '{"incomplete"');
  const reloaded = await new MessageStore(directory).init();
  assert.equal(reloaded.messages.get('one').status, 'unknown');
  await reloaded.update('one', { status: 'submitted' });
  assert.equal((await new MessageStore(directory).init()).messages.get('one').status, 'submitted');
  assert.ok((await readFile(store.file, 'utf8')).includes('Original report'));
});

test('service logs before delivery, adds real sender, and records uncertain failure once', async (t) => {
  const directory = await mkdtemp(join(resolve('.'), '.service-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new MessageStore(directory).init();
  const sender = { client: 'codex', id: 'sender-123', name: '实现者', cwd: directory };
  const recipient = { client: 'claude', id: 'target-123', name: '审查者', cwd: directory };
  let count = 0;
  const service = new CooperationService({ store, adapters: {
    codex: { find: async () => sender },
    claude: { find: async () => recipient, send: async ({ text }) => {
      count++; assert.equal(store.list().length, 1); assert.equal(store.list()[0].status, 'pending');
      assert.ok(text.startsWith('发送方：codex://实现者:sender-123')); assert.ok(text.endsWith('报告原文'));
      throw Object.assign(new Error('connection lost after write'), { outcome: 'unknown' });
    } },
  } });
  const result = await service.send({ from: sender, to: 'claude:target-123', message: '报告原文' });
  assert.equal(count, 1); assert.equal(result.status, 'unknown');
  assert.equal(store.list()[0].text, '报告原文');
  assert.deepEqual(Object.keys(result).sort(), ['error', 'messageId', 'status', 'to']);
});

test('MCP exposes message and checkpoint tools, not discovery or history', async () => {
  const child = spawn(process.execPath, ['bin/coop.mjs', 'mcp', '--client', 'codex'], { cwd: resolve('.'), windowsHide: true });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
  await new Promise((done, reject) => { child.on('error', reject); child.on('close', done); });
  const result = JSON.parse(output.trim()).result;
  assert.deepEqual(result.tools.map((tool) => tool.name), ['send_message', 'context_checkpoint']);
  assert.deepEqual(Object.keys(result.tools[0].inputSchema.properties), ['to', 'message']);
});
