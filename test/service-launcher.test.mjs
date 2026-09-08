import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, rm, access, mkdir, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
test('launchers start once, authenticate shutdown, and stop only their own manager', { skip: process.platform !== 'win32' }, async t => {
  const root = resolve('.');
  const scratch = await mkdtemp(join(root, '.launcher-test-with spaces-'));
  const helper = join(scratch, 'bin', 'coop-service.mjs');
  const run = action => exec(process.env.ComSpec || 'cmd.exe', ['/d', '/c', action === 'start' ? '启动项目.cmd' : '关闭项目.cmd'], { cwd: scratch, env: { ...process.env, COOP_NO_BROWSER: '1' }, windowsHide: true, timeout: 40000 });
  t.after(async () => {
    await run('stop').catch(() => {});
    assert.ok(scratch.startsWith(root + '\\') || scratch.startsWith(root + '/'));
    await rm(scratch, { recursive: true, force: true });
  });
  for (const folder of ['src', 'bin', 'public']) await cp(join(root, folder), join(scratch, folder), { recursive: true });
  for (const filename of ['启动项目.cmd', '关闭项目.cmd']) await cp(join(root, filename), join(scratch, filename));
  const first = await run('start'); assert.match(first.stdout, /Started:/);
  const filename = join(scratch, '.cooperation', 'connection.json');
  const before = JSON.parse(await readFile(filename, 'utf8'));
  const again = await run('start'); assert.match(again.stdout, /Already running:/);
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).pid, before.pid);
  assert.equal((await fetch(before.url + '/api/service/status')).status, 401);
  const headers = { Authorization: 'Bearer ' + before.token, 'Content-Type': 'application/json' };
  const status = await (await fetch(before.url + '/api/service/status', { headers })).json();
  assert.equal(status.root, scratch); assert.equal(status.pid, before.pid);
  const stale = await fetch(before.url + '/api/service/stop', { method: 'POST', headers, body: JSON.stringify({ pid: before.pid, startedAt: 'stale' }) });
  assert.equal(stale.status, 409);
  assert.match((await run('stop')).stdout, /manager stopped/);
  await assert.rejects(access(filename));
  assert.match((await run('stop')).stdout, /already stopped/);
});

test('stopping the manager preserves an existing Claude transport and permits new Claude launches', { skip: process.platform !== 'win32' }, async t => {
  const root = resolve('.');
  const scratch = await mkdtemp(join(root, '.launcher-test-claude-'));
  const peers = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(fn) {
    const end = Date.now() + 6000;
    do { const value = await fn(); if (value) return value; await delay(30); } while (Date.now() < end);
    throw new Error('Claude fixture did not reach expected state.');
  }
  const manager = action => exec(process.execPath, [join(scratch, 'bin', 'coop-service.mjs'), action], {
    cwd: scratch, env: { ...process.env, COOP_NO_BROWSER: '1' }, windowsHide: true, timeout: 40000,
  });
  t.after(async () => {
    await manager('stop').catch(() => {});
    for (const peer of peers) {
      peer.process.stdin.end();
      await Promise.race([peer.exited, delay(2000)]);
      if (peer.process.exitCode === null) peer.process.kill();
      await peer.exited;
    }
    assert.ok(scratch.startsWith(root + '\\') || scratch.startsWith(root + '/'));
    await rm(scratch, { recursive: true, force: true });
  });
  for (const folder of ['src', 'bin', 'public']) await cp(join(root, folder), join(scratch, folder), { recursive: true });
  async function claudePeer() {
    const id = randomUUID(), data = join(scratch, 'wrapper-' + id);
    await mkdir(data); await writeFile(join(data, 'config.json'), JSON.stringify({ enabled: true, directories: [scratch] }));
    const child = spawn(join(root, 'bin', 'claude-wrapper.exe'), [process.execPath, join(root, 'test', 'fixtures', 'claude-wrapper-child.mjs'),
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--resume', id],
      { cwd: scratch, env: { ...process.env, COOP_WRAPPER_DATA_DIRECTORY: data }, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    child.stderr.resume();
    const messages = [], exited = new Promise(resolve => child.once('close', resolve));
    createInterface({ input: child.stdout }).on('line', line => messages.push(JSON.parse(line)));
    const peer = { process: child, exited, messages, send: m => child.stdin.write(JSON.stringify(m) + '\n'), id };
    peers.push(peer);
    peer.send({ type: 'control_request', request_id: 'initialize', request: { subtype: 'initialize' } });
    const registry = await until(async () => {
      const folder = join(data, 'instances');
      for (const filename of await readdir(folder).catch(() => [])) {
        if (!filename.endsWith('.json')) continue;
        const record = JSON.parse(await readFile(join(folder, filename), 'utf8'));
        if (record.initialized) return record;
      }
    });
    peer.status = async () => (await fetch(registry.endpoint + '/status', { headers: { Authorization: 'Bearer ' + registry.token } })).json();
    return peer;
  }
  await manager('start');
  const first = await claudePeer();
  first.send({ type: 'user', session_id: first.id, message: { role: 'user', content: 'permission' } });
  await until(() => first.messages.some(m => m.request_id === 'fixture-permission'));
  const before = await first.status(); assert.equal(before.activity, 'waiting_permission');
  await manager('stop');
  const after = await first.status();
  assert.equal(after.childPid, before.childPid); assert.equal(after.wrapperPid, before.wrapperPid);
  assert.equal(after.activity, 'waiting_permission');
  assert.equal(first.messages.some(m => m.type === 'fixture_permission_answer'), false);
  assert.equal(first.process.exitCode, null);
  first.send({ type: 'control_response', response: { subtype: 'success', request_id: 'fixture-permission', response: { behavior: 'deny', message: 'Original IDE decision' } } });
  await until(() => first.messages.some(m => m.type === 'fixture_permission_answer'));
  first.send({ type: 'user', session_id: first.id, message: { role: 'user', content: 'normal-input-after-manager-stopped' } });
  await until(() => first.messages.some(m => m.fixtureReceivedExactly && m.message?.content === 'normal-input-after-manager-stopped'));
  await until(async () => (await first.status()).activity === 'idle');
  const second = await claudePeer();
  second.send({ type: 'user', session_id: second.id, message: { role: 'user', content: 'new-peer-without-manager' } });
  await until(() => second.messages.some(m => m.type === 'assistant'));
  assert.equal(second.process.exitCode, null);
  await assert.rejects(access(join(scratch, '.cooperation', 'connection.json')));
});
