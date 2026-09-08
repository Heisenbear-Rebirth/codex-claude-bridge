import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ManagementStore } from './management-store.mjs';
import { CooperationService } from './service.mjs';
import { validateDirectory } from './directory-service.mjs';
import { parseAddress, publicSession } from './address.mjs';
import { POLICY_DEFAULTS } from './context-policy.mjs';
import { ContextMonitor } from './context-monitor.mjs';
import { MaintenanceController } from './maintenance-controller.mjs';
import { CheckpointService } from './checkpoint-service.mjs';
import { readWrapperDirectories, wrapperEnabledFor, WrapperDirectorySettings } from './wrapper-directories.mjs';
import { containsDirectory } from './directory-service.mjs';

export async function startServer({ root, port = 47821, host = '127.0.0.1', defaultDirectory = root, codexContext, adapters, runtimeFactory, startMonitoring = true } = {}) {
  if (host !== '127.0.0.1') throw new Error('管理台仅允许监听 127.0.0.1。');
  const dataDirectory = join(root, '.cooperation');
  await mkdir(dataDirectory, { recursive: true });
  let previous;
  try { previous = JSON.parse(await readFile(join(dataDirectory, 'connection.json'), 'utf8')); } catch {}
  if (previous?.url) {
    const location = new URL(previous.url);
    if (location.protocol === 'http:' && location.hostname === '127.0.0.1') {
      let alive = false;
      try { alive = (await fetch(new URL('/api/config', location), { signal: AbortSignal.timeout(1500) })).ok; } catch {}
      if (alive) throw new Error(`管理服务已经运行：${location.origin}`);
    }
  }
  const store = await new ManagementStore(dataDirectory).init();
  try {
    store.acquireManager(); await store.migrateLegacy();
    if (!store.directories().length) store.saveDirectory(await validateDirectory(defaultDirectory));
  } catch (error) { store.close(); throw error; }
  const token = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(24).toString('hex');
  const streams = new Set();
  const publish = (event, data) => { for (const response of streams) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const service = new CooperationService({ store, codexContext, adapters, onMessage: (id) => {
    for (const response of streams) response.write(`event: message\ndata: ${JSON.stringify({ id })}\n\n`);
  } });
  const monitor = new ContextMonitor({ store, service, runtimeFactory, onUpdate: session => publish('management', { client: session.client, id: session.id }) });
  const controller = new MaintenanceController({ root, store, service, monitor, onUpdate: session => publish('management', { client: session.client, id: session.id }) });
  const checkpoints = new CheckpointService({ root, store, onReceipt: cycleId => publish('management', { cycleId }) });
  const wrapperSettings = new WrapperDirectorySettings(root);
  const directoryRecords = async () => { const config = await readWrapperDirectories(root); return store.directories().map(d => ({ ...d, claudeControlEnabled: wrapperEnabledFor(config, d.path) })); };
  const scope = ids => {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('目录筛选格式不正确。');
    return store.directories().filter(d => ids.includes(d.id));
  };
  const resolveSession = async address => {
    const target = parseAddress(address); const found = await service.adapters[target.client].find(target.id);
    if (!found) throw new Error('找不到指定的会话。'); return publicSession(found);
  };
  let actualPort = port;
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const expectedHost = `127.0.0.1:${actualPort}`;
    if (request.headers.host !== expectedHost) return json(response, 403, { error: '无效的本机访问地址。' });
    if (request.headers.origin && request.headers.origin !== `http://${expectedHost}`) return json(response, 403, { error: '不接受跨站请求。' });
    if (request.headers['sec-fetch-site'] === 'cross-site') return json(response, 403, { error: '不接受跨站请求。' });
    const url = new URL(request.url, `http://${expectedHost}`);
    try {
      if (request.method === 'GET' && url.pathname === '/api/config') {
        return json(response, 200, { version: '0.2.0', defaultDirectory, directories: await directoryRecords(), policyDefaults: POLICY_DEFAULTS, csrfToken,
          bridge: { codex: Boolean(codexContext?.pipePath && codexContext?.callerThreadId) }, warnings: store.warnings });
      }
      if (request.method === 'POST' && url.pathname === '/api/sessions') {
        if (!equal(request.headers['x-coop-ui'], csrfToken)) return json(response, 403, { error: '请从本地管理页面查询会话。' });
        const query = await body(request);
        const result = await service.sessions(query.directoryIds ? { directories: scope(query.directoryIds) } : query);
        const wrapper = await readWrapperDirectories(root);
        for (const session of result.sessions) if (session.client === 'claude') session.controlAccess = {
          directoryEnabled: wrapperEnabledFor(wrapper, session.cwd), detail: wrapperEnabledFor(wrapper, session.cwd) ? '读取状态以确认接入；旧会话可能需要重开。' : '当前会话目录尚未允许 Claude 控制接入。' };
        return json(response, 200, result);
      }
      if (request.method === 'GET' && url.pathname === '/api/directories') return json(response, 200, { directories: await directoryRecords() });
      if (request.method === 'GET' && url.pathname === '/api/monitoring') {
        return json(response, 200, { sessions: store.db.prepare('SELECT data FROM snapshots').all().map(row => {
          const snapshot = JSON.parse(row.data); return { ...snapshot, policy: store.getPolicy(snapshot.session),
            cycle: service.publicCycle(store.activeCycle(snapshot.session)), lastCycle: service.publicCycle(store.lastCycle(snapshot.session)), queueCount: store.queueCount(snapshot.session), queueState: store.queueState(snapshot.session) };
        }) });
      }
      if (request.method === 'POST' && ['/api/directories', '/api/directories/remove', '/api/directories/claude-control', '/api/policies', '/api/runtime', '/api/cycles/action', '/api/messages/resolve', '/api/queue/release'].includes(url.pathname)) {
        if (!equal(request.headers['x-coop-ui'], csrfToken)) return json(response, 403, { error: '请从本地管理页面操作。' });
        const input = await body(request);
        if (url.pathname === '/api/directories') {
          const directory = store.saveDirectory({ ...await validateDirectory(input.path), label: typeof input.label === 'string' ? input.label.slice(0, 200) : '', recursive: input.recursive === true });
          return json(response, 200, { directory, directories: await directoryRecords() });
        }
        if (url.pathname === '/api/directories/remove') { store.removeDirectory(input.id); return json(response, 200, { directories: await directoryRecords() }); }
        if (url.pathname === '/api/directories/claude-control') {
          const directory = store.directories().find(d => d.id === input.id);
          if (!directory || typeof input.enabled !== 'boolean') throw new Error('请指定已添加的目录及启用状态。');
          if (!input.enabled && store.activeCycles().some(c => c.session.client === 'claude' && containsDirectory(c.session.cwd, directory.path))) throw new Error('该目录正在维护，请先结束维护再关闭接入。');
          await wrapperSettings.set(directory.path, input.enabled);
          store.event('wrapper_directory_control', { directoryId: input.id, enabled: input.enabled });
          return json(response, 200, { directories: await directoryRecords(), detail: '配置已保存；已打开的 Claude 会话需要重新打开，且沿用已配置的官方启动器。' });
        }
        if (url.pathname === '/api/policies') {
          const session = await resolveSession(input.address);
          const patch = input.policy || {};
          if (Object.keys(patch).some(key => !['enabled', 'mode', 'softPercent', 'hardPercent'].includes(key))) throw new Error('不支持的策略字段。');
          const policy = store.savePolicy(session, patch); publish('management', { client: session.client, id: session.id });
          return json(response, 200, { policy });
        }
        if (url.pathname === '/api/runtime') return json(response, 200, await monitor.sample(await resolveSession(input.address), { native: input.native === true }));
        if (url.pathname === '/api/cycles/action') {
          if (input.action === 'retry') await controller.retry(input.id);
          else if (input.action === 'reconcile') await controller.reconcile(input.id);
          else if (['cancel-release', 'cancel-hold'].includes(input.action)) await controller.cancel(input.id, input.action === 'cancel-release');
          else throw new Error('未知的维护操作。');
          return json(response, 200, { cycle: service.publicCycle(store.cycle(input.id)) });
        }
        if (url.pathname === '/api/messages/resolve') {
          const key = store.resolveDelivery(input.id, input.outcome); await service.mailbox.drain(key); publish('message', { id: input.id });
          return json(response, 200, { status: 'accepted' });
        }
        if (url.pathname === '/api/queue/release') {
          const session = await resolveSession(input.address); await service.mailbox.drain(store.releaseHeld(session));
          return json(response, 200, { status: 'accepted' });
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/messages') {
        const query = Object.fromEntries(url.searchParams);
        if (url.searchParams.has('directoryIds')) query.directories = scope(JSON.parse(url.searchParams.get('directoryIds')));
        const messages = query.directories?.length === 0 ? [] : store.list(query);
        return json(response, 200, { messages, total: messages.length });
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        response.write(': connected\n\n'); streams.add(response);
        const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 25000);
        request.on('close', () => { clearInterval(heartbeat); streams.delete(response); });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/send') {
        if (!equal(request.headers.authorization, `Bearer ${token}`)) return json(response, 401, { error: '需要本机通信客户端凭据。' });
        const result = await service.send(await body(request));
        return json(response, 200, result);
      }
      if (request.method === 'POST' && url.pathname === '/api/checkpoint') {
        if (!equal(request.headers.authorization, `Bearer ${token}`)) return json(response, 401, { error: '需要本机通信客户端凭据。' });
        return json(response, 200, await checkpoints.accept(await body(request)));
      }
      const assets = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
      if (request.method === 'GET' && assets[url.pathname]) {
        const [filename, type] = assets[url.pathname];
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        response.end(await readFile(join(root, 'public', filename))); return;
      }
      json(response, 404, { error: '接口不存在。' });
    } catch (error) { json(response, error.statusCode || 400, { error: error.message }); }
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); }
  catch (error) { await controller.close(); await service.mailbox.close(); store.close(); throw error; }
  actualPort = server.address().port;
  const connection = { url: `http://${host}:${actualPort}`, token, pid: process.pid, startedAt: new Date().toISOString() };
  const connectionFile = join(dataDirectory, 'connection.json');
  await writeFile(connectionFile, JSON.stringify(connection, null, 2) + '\n', { mode: 0o600 });
  if (startMonitoring) controller.start();
  let closed = false;
  async function close() {
    if (closed) return; closed = true;
    await controller.close(); await service.mailbox.close();
    for (const response of streams) response.end();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    try { const saved = JSON.parse(await readFile(connectionFile, 'utf8')); if (saved.pid === process.pid) await unlink(connectionFile); } catch { /* Already removed. */ }
    store.close();
  }
  return { server, url: connection.url, close, service, store, monitor, controller, checkpoints };
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function json(response, status, value) {
  if (response.headersSent) { response.end(); return; }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
async function body(request) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) { const error = new Error('请使用 JSON 请求。'); error.statusCode = 415; throw error; }
  let length = 0; const chunks = [];
  for await (const chunk of request) { length += chunk.length; if (length > 1024 * 1024) throw new Error('请求内容过大。'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
