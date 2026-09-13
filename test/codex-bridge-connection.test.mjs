import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CodexBridgeConnection, rememberCodexBridge, rememberCodexEnvironment } from '../src/codex-bridge-connection.mjs';
import { startServer } from '../src/http-server.mjs';
const context = suffix => ({ pipePath: '\\\\.\\pipe\\cooperation-test-' + suffix, callerThreadId: '11111111-1111-4111-8111-111111111111', nodePath: process.execPath });
async function fixture(t) {
  const base = resolve('.'), root = await mkdtemp(join(base, '.bridge-test-'));
  t.after(async () => { assert.equal(resolve(root).startsWith(base + '\\') || resolve(root).startsWith(base + '/'), true); await rm(root, { recursive: true, force: true }); });
  return root;
}
test('a manager started without Codex environment recovers the saved authorized connection', async t => {
  const root = await fixture(t), saved = context('first'), probes = [];
  assert.equal(await rememberCodexBridge(root, saved), true);
  const bridge = await new CodexBridgeConnection({ root, probe: async candidate => { probes.push(candidate); }, intervalMs: 60000 }).init();
  try {
    assert.equal(bridge.status().connected, true); assert.deepEqual(await bridge.getContext(), saved);
    assert.ok(probes.length >= 1);
    assert.equal(JSON.stringify(bridge.status()).includes(saved.pipePath), false);
    assert.equal(JSON.stringify(bridge.status()).includes(saved.callerThreadId), false);
  } finally { await bridge.close(); }
});
test('a running manager picks up a new app connection and handles a disconnect without sending', async t => {
  const root = await fixture(t), first = context('first'), second = context('second'); let available = first.pipePath;
  await rememberCodexBridge(root, first);
  const bridge = await new CodexBridgeConnection({ root, probe: async candidate => { if (candidate.pipePath !== available) throw Error('disconnected'); }, intervalMs: 60000 }).init();
  try {
    available = null; await bridge.refresh(); assert.equal(bridge.status().connected, false);
    await assert.rejects(bridge.getContext(), { code: 'CODEX_CONNECTION_UNAVAILABLE', outcome: 'not_submitted' });
    available = second.pipePath; await rememberCodexBridge(root, second);
    assert.deepEqual(await bridge.getContext(), second); assert.equal(bridge.status().connected, true);
  } finally { await bridge.close(); }
});
test('capture needs a real environment connection and never invents a caller identity', async t => {
  const root = await fixture(t), first = context('first');
  assert.equal(await rememberCodexEnvironment(root, { CODEX_APP_TOOLS_PIPE_PATH: first.pipePath }), false);
  await rememberCodexBridge(root, first);
  assert.equal(await rememberCodexEnvironment(root, {}), false);
  assert.equal(await rememberCodexEnvironment(root, { CODEX_APP_TOOLS_PIPE_PATH: context('second').pipePath, CODEX_MCP_NODE_PATH: process.execPath }), true);
  const saved = JSON.parse(await readFile(join(root, '.cooperation/codex-bridge.json'), 'utf8')).context;
  assert.equal(saved.callerThreadId, first.callerThreadId); assert.equal(saved.pipePath, context('second').pipePath);
  assert.equal(await rememberCodexBridge(root, { ...first, pipePath: 'https://example.invalid' }), false);
});
test('invalid persisted connection data cannot start an executable', async t => {
  const root = await fixture(t); await mkdir(join(root, '.cooperation'));
  await writeFile(join(root, '.cooperation/codex-bridge.json'), JSON.stringify({ version: 1, context: { ...context('first'), nodePath: 'relative-script' } }));
  let probes = 0;
  const bridge = await new CodexBridgeConnection({ root, probe: async () => { probes++; }, intervalMs: 60000 }).init();
  try { assert.equal(bridge.status().connected, false); assert.equal(probes, 0); } finally { await bridge.close(); }
});
test('HTTP readiness survives service restart and never exposes the saved connection', async t => {
  const root = await fixture(t), saved = context('persisted');
  let server = await startServer({ root, port: 0, startMonitoring: false, codexContext: saved, bridgeProbe: async candidate => assert.deepEqual(candidate, saved) });
  try {
    const first = await (await fetch(server.url + '/api/bridge')).json(); assert.equal(first.connected, true);
    await server.close();
    server = await startServer({ root, port: 0, startMonitoring: false, bridgeProbe: async candidate => assert.deepEqual(candidate, saved) });
    const config = await (await fetch(server.url + '/api/config')).json(); assert.equal(config.bridge.codex, true);
    const text = JSON.stringify(config); assert.equal(text.includes(saved.pipePath), false); assert.equal(text.includes(saved.callerThreadId), false);
  } finally { await server.close(); }
});
test('Codex MCP initialization automatically publishes its host connection', async t => {
  const root = await fixture(t), saved = context(randomUUID());
  const source = 'import {startMcp} from ' + JSON.stringify(pathToFileURL(resolve('src/mcp.mjs')).href) + '; startMcp(' + JSON.stringify({ root, client: 'codex' }) + ');';
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: root, windowsHide: true, env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: saved.pipePath, CODEX_THREAD_ID: saved.callerThreadId, CODEX_MCP_NODE_PATH: saved.nodePath }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.resume();
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(Error('MCP initialization failed'))); });
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  await exited; assert.equal(JSON.parse(output.trim()).result.serverInfo.name, 'cooperation');
  assert.deepEqual(JSON.parse(await readFile(join(root, '.cooperation/codex-bridge.json'), 'utf8')).context, saved);
});
