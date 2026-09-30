import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { containsDirectory } from '../directory-service.mjs';
import { installationRoot, localEndpoint, sameDirectory } from '../opencode-bridge.mjs';
import { readAccessPolicy } from '../access-policy.mjs';

export function createOpenCodeAdapter({ root = installationRoot, timeout = 15000 } = {}) {
  const folder = join(root, '.cooperation', 'opencode', 'instances');
  async function records() {
    const access = await readAccessPolicy();
    const result = [];
    for (const name of await readdir(folder).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      try {
        const filename = join(folder, name); if ((await stat(filename)).size > 8192) continue;
        const r = JSON.parse(await readFile(filename, 'utf8'));
        if (!access.permits(r.directory)) continue;
        if (r.protocol !== 1 || name !== r.instanceId + '.json' || !/^[0-9a-f]{64}$/.test(r.token) || typeof r.directory !== 'string') continue;
        localEndpoint(r.endpoint); result.push(r);
      } catch { /* Malformed local registrations are not usable connections. */ }
    }
    return result;
  }
  async function rpc(record, input) {
    const response = await fetch(localEndpoint(record.endpoint) + '/rpc', { method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer ' + record.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, instanceId: record.instanceId }), signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error('OpenCode bridge rejected the operation.');
    return response.json();
  }
  async function target(id, expectedCwd) {
    const candidates = [];
    for (const record of await records()) {
      if (expectedCwd && !sameDirectory(record.directory, expectedCwd)) continue;
      try { const session = await rpc(record, { action: 'find', targetId: id }); if (session?.id === id && session.client === 'opencode' && sameDirectory(session.cwd, record.directory)) candidates.push({ record, session }); }
      catch { /* Stale instances cannot identify a target. */ }
    }
    if (candidates.length > 1) throw new Error('OpenCode 会话同时存在多个后端实例，无法唯一投递。');
    return candidates[0];
  }
  async function lifecycleBackend(cwd) {
    const candidates = [];
    for (const record of await records()) if (sameDirectory(record.directory, cwd)) {
      try {
        await rpc(record, { action: 'list' }); candidates.push(record);
      } catch { /* Offline plugins cannot establish a backend. */ }
    }
    if (candidates.length !== 1) throw Object.assign(new Error('需要唯一的已接入原生后端及新版插件。'), { outcome: 'not_submitted' });
    let state;
    try { state = await rpc(candidates[0], { action: 'lifecycle' }); }
    catch { throw Object.assign(new Error('原生插件需在工作结束后正常重载以支持生命周期操作。'), { outcome: 'not_submitted' }); }
    if (state.create !== true || state.instanceId !== candidates[0].instanceId || !sameDirectory(state.directory, cwd)) throw Object.assign(new Error('原生后端能力或目录不匹配。'), { outcome: 'not_submitted' });
    return candidates[0];
  }
  return {
    async control(id, input) {
      const selected = await target(id, input.expected?.cwd);
      if (!selected) throw new Error('OpenCode backend unavailable.');
      if (selected.record.instanceId !== input.expected?.instanceId) return { status: 'state_conflict', requestId: input.requestId };
      try { return await rpc(selected.record, { ...input, action: 'maintenance', targetId: id }); }
      catch { return { status: 'unknown', requestId: input.requestId, ...(input.messageId ? { activeTurnId: input.messageId } : {}) }; }
    },
    async createSession(input) {
      const record = await lifecycleBackend(input.cwd);
      if (input.source?.client === 'opencode' && input.source.instanceId && input.source.instanceId !== record.instanceId) throw Object.assign(new Error('创建前原生来源实例已改变。'), { outcome: 'not_submitted' });
      return rpc(record, { ...input, action: 'create' });
    },
    async reconcileCreate(input) {
      const record = await lifecycleBackend(input.cwd);
      return rpc(record, { action: 'reconcile-create', cwd: input.cwd, operationId: input.operationId });
    },
    async connectSession({ targetId, cwd }) {
      const selected = await target(targetId, cwd);
      if (!selected) throw new Error('OpenCode backend unavailable.');
      return rpc(selected.record, { action: 'connect', targetId, cwd });
    },
    async list({ directory, recursive = false }) {
      const sessions = [], warnings = [];
      for (const record of await records()) if (containsDirectory(record.directory, directory, recursive)) {
        try { sessions.push(...(await rpc(record, { action: 'list' })).sessions.filter(s => sameDirectory(s.cwd, record.directory))); }
        catch { warnings.push('OpenCode 接入实例不可连接，请在原后端检查插件。'); }
      }
      const unique = new Map(); for (const session of sessions) { if (unique.has(session.id)) warnings.push('OpenCode 会话存在多个后端；发送将被拒绝。'); unique.set(session.id, session); }
      return { sessions: [...unique.values()], warnings: [...new Set(warnings)] };
    },
    async find(id) { return (await target(id))?.session || null; },
    async status(id) {
      const selected = await target(id); if (!selected) throw new Error('OpenCode backend unavailable.');
      return rpc(selected.record, { action: 'status', targetId: id });
    },
    async send({ targetId, text, messageId, targetSession, messageAffixes }) {
      const selected = await target(targetId, targetSession?.cwd); if (!selected) throw new Error('OpenCode backend unavailable.');
      const current = await rpc(selected.record, { action: 'status', targetId, includeUsage: false });
      if (current.capabilities?.sendMessage !== true) return { status: 'failed', transport: 'opencode-plugin', error: 'OpenCode 原生 user 消息接收尚未显式开启。' };
      try { return await rpc(selected.record, { action: 'send', targetId, text, messageId, messageAffixes, cwd: targetSession?.cwd || selected.session.cwd }); }
      catch { return { status: 'unknown', transport: 'opencode-plugin', error: 'OpenCode 投递未确认，请核对原生记录，不要自动重发。' }; }
    },
    async verifySender({ instanceId, proof }) {
      if (!/^[0-9a-f]{64}$/.test(proof || '')) throw new Error('Invalid native sender proof.');
      const record = (await records()).find(r => r.instanceId === instanceId); if (!record) throw new Error('OpenCode sender instance unavailable.');
      const result = await rpc(record, { action: 'identity', proof });
      if (result?.from?.client !== 'opencode' || !sameDirectory(result.cwd, record.directory)) throw new Error('OpenCode sender identity mismatch.');
      return { ...result, instanceId: record.instanceId };
    },
  };
}
