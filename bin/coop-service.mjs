#!/usr/bin/env node
import { readFile, mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { rememberCodexEnvironment } from '../src/codex-bridge-connection.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const data = join(root, '.cooperation');
const normalize = path => resolve(path).replaceAll('\\', '/').toLowerCase();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connection() {
  let record;
  try { record = JSON.parse(await readFile(join(data, 'connection.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Cannot read the local connection file.'); }
  const url = new URL(record.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || !/^[a-f0-9]{64}$/.test(record.token))
    throw new Error('Invalid local service connection.');
  return record;
}
async function status(record) {
  if (!record) return null;
  let response;
  try { response = await fetch(new URL('/api/service/status', record.url), { headers: { Authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(1500) }); }
  catch { return null; }
  if (response.status === 404) throw new Error('An older manager is running. Close its original terminal once, then use these launchers.');
  if (!response.ok) throw new Error('Service identity could not be verified. No process was stopped.');
  const current = await response.json();
  if (current.service !== 'cooperation' || normalize(current.root) !== normalize(root) || current.pid !== record.pid || current.startedAt !== record.startedAt)
    throw new Error('This connection does not identify the manager for this project.');
  return current;
}
function openPage(url) {
  if (process.env.COOP_NO_BROWSER === '1') return;
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, detached: true, stdio: 'ignore' });
  child.on('error', () => console.error('Could not open the browser. Open the printed URL manually.')); child.unref();
}
async function start() {
  await rememberCodexEnvironment(root);
  const saved = await connection(), current = await status(saved);
  if (current) {
    if (current.closing) throw new Error('The manager is still stopping. Try again shortly.');
    console.log(`Already running: ${saved.url}`); openPage(saved.url); return;
  }
  await mkdir(join(data, 'runtime-temp'), { recursive: true });
  const out = await open(join(data, 'service.stdout.log'), 'a'), err = await open(join(data, 'service.stderr.log'), 'a');
  let child, failure;
  try {
    child = spawn(process.execPath, [join(root, 'bin', 'coop.mjs'), 'serve', '--directory', root], {
      cwd: root, windowsHide: true, detached: true, stdio: ['ignore', out.fd, err.fd],
      env: { ...process.env, TEMP: join(data, 'runtime-temp'), TMP: join(data, 'runtime-temp') },
    });
    child.on('error', error => { failure = error; }); child.unref();
  } finally { await out.close(); await err.close(); }
  for (let i = 0; i < 60; i++) {
    if (failure) throw new Error('Could not start Node.js.');
    const record = await connection();
    if (record && await status(record)) { console.log(`Started: ${record.url}`); openPage(record.url); return; }
    if (child.exitCode !== null) throw new Error('Manager exited. See .cooperation/service.stderr.log.');
    await sleep(250);
  }
  throw new Error('Startup is not confirmed. Check .cooperation/service.stderr.log before trying again.');
}
async function stop() {
  const record = await connection();
  if (!await status(record)) { console.log('This project is already stopped.'); return; }
  const response = await fetch(new URL('/api/service/stop', record.url), {
    method: 'POST', headers: { Authorization: `Bearer ${record.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: record.pid, startedAt: record.startedAt }), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Manager did not accept shutdown. No process was killed.');
  for (let i = 0; i < 120; i++) {
    const saved = await connection();
    if (!saved || saved.pid !== record.pid || saved.startedAt !== record.startedAt || !await status(record)) { console.log('Project manager stopped.'); return; }
    await sleep(250);
  }
  console.log('Shutdown requested. The manager is finishing an active operation; no process was forcibly stopped.');
}
try {
  if (process.argv[2] === 'start') await start();
  else if (process.argv[2] === 'stop') await stop();
  else throw new Error('Use start or stop.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
