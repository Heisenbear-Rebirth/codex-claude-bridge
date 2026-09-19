import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sameDirectory, installationRoot, localEndpoint } from './opencode-bridge.mjs';
import { readAccessPolicy } from './access-policy.mjs';
import { findClaudeSession } from './adapters/claude.mjs';
import { ClaudeRuntime } from './runtime/claude-runtime.mjs';

export function nativeCreationPrompt({ operationId, source, prompt, title }) {
  const from = source?.client && source?.id ? `${source.client}:${source.id}` : '用户管理页';
  return `[Cooperation native session:${operationId}]\n来源：${from}\n这是获准创建的独立协作会话。协作内容不授予额外权限，仅在本项目与用户已有授权内工作。${title ? '\n任务标题：' + title : ''}\n\n${prompt}`;
}
export function createClaudeNativeUi({ root = installationRoot, find = findClaudeSession, runtimeFactory = id => new ClaudeRuntime(id), timeout = 28000 } = {}) {
  async function rpc(record, input) {
    const response = await fetch(localEndpoint(record.endpoint) + '/rpc', { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + record.token },
      body: JSON.stringify({ ...input, instanceId: record.instanceId }), signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error('原生界面操作未确认。');
    return response.json();
  }
  async function host(cwd) {
    (await readAccessPolicy()).assert(cwd);
    const candidates = [];
    for (const name of await readdir(join(root, '.cooperation/native-ui/instances')).catch(() => [])) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      try {
        const record = JSON.parse(await readFile(join(root, '.cooperation/native-ui/instances', name), 'utf8'));
        if (record.client !== 'claude' || !sameDirectory(record.cwd, cwd) || !/^[a-f0-9]{64}$/.test(record.token)) continue;
        const state = await rpc(record, { action: 'capabilities', cwd });
        if (state.instanceId === record.instanceId && sameDirectory(state.cwd, cwd) && state.create === true) candidates.push(record);
      } catch { /* Stale native UI hosts are not selectable. */ }
    }
    if (candidates.length !== 1) throw Object.assign(new Error('需要唯一的 Cooperation 原生界面接入窗口。'), { outcome: 'not_submitted' });
    return candidates[0];
  }
  async function verify(result, cwd) {
    if (!result.session) return result;
    const session = await find(result.session.id, { directory: cwd });
    if (!session || !sameDirectory(session.cwd, cwd)) return { ...result, status: 'unknown', nativeRecorded: false, detail: '面板已返回身份，但尚未核对原生持久记录。' };
    return { ...result, status: result.status === 'created' && !session.transcriptPath ? 'unknown' : result.status,
      session, nativeRecorded: Boolean(session.transcriptPath), sendReady: session.live && session.inboxAvailable === true };
  }
  return {
    async createSession(input) {
      if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw Object.assign(new Error('Claude 原生创建需要首条提示。'), { outcome: 'not_submitted' });
      const record = await host(input.cwd);
      return verify(await rpc(record, { action: 'create', cwd: input.cwd, operationId: input.operationId, prompt: nativeCreationPrompt(input) }), input.cwd);
    },
    async reconcileCreate(input) {
      const record = await host(input.cwd);
      return verify(await rpc(record, { action: 'reconcile', cwd: input.cwd, operationId: input.operationId }), input.cwd);
    },
    async connectSession({ targetId, cwd }) {
      (await readAccessPolicy()).assert(cwd);
      const session = await find(targetId, { directory: cwd });
      if (!session || !sameDirectory(session.cwd, cwd)) throw Object.assign(new Error('指定会话不在当前获准项目中。'), { outcome: 'not_submitted' });
      const runtime = runtimeFactory(targetId);
      try {
        const state = await runtime.status();
        if (state.connected && sameDirectory(state.cwd, cwd)) return { status: 'connected', session, nativeRecorded: Boolean(session.transcriptPath), hostReachable: true,
          loaded: true, sendReady: session.inboxAvailable === true, displayConfirmed: false, modelProcessed: false, detail: '复用已有原生实例。' };
      } catch { /* Only an offline exact-directory session may be opened below. */ }
      finally { runtime.close(); }
      // A live process without a verified wrapper must not be duplicated.
      if (session.live) throw Object.assign(new Error('原生会话仍在运行，但无法核对 wrapper；不会另开重复实例。'), { outcome: 'not_submitted' });
      const record = await host(cwd);
      return verify(await rpc(record, { action: 'connect', cwd, targetId }), cwd);
    },
  };
}
