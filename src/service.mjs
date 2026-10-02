import { randomUUID } from 'node:crypto';
import { stat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseAddress, publicSession, messageEnvelope } from './address.mjs';
import { listClaudeSessions, findClaudeSession } from './adapters/claude.mjs';
import { listCodexSessions, findCodexSession, sendCodexMessage } from './adapters/codex.mjs';
import { SessionMailbox } from './session-mailbox.mjs';
import { sendVisibleClaudeMessage } from './runtime/claude-runtime.mjs';
import { createRuntime } from './runtime/factory.mjs';
import { createOpenCodeAdapter } from './adapters/opencode.mjs';
import { controlTurnEnded } from './maintenance-recovery.mjs';
import { SessionLifecycle } from './session-lifecycle.mjs';
import { readAccessPolicy } from './access-policy.mjs';
import { createClaudeNativeUi } from './native-ui-adapter.mjs';
import { readPromptSettings } from './prompt-settings.mjs';
import { applyMessageAffixes } from '../public/prompt-templates.mjs';

export class CooperationService {
  constructor({ store, root, codexContext, codexBridge, onMessage = () => {}, adapters, lifecycleDirectories, runtimeFactory, accessPolicy } = {}) {
    this.accessPolicy = accessPolicy;
    this.store = store; this.root = root; this.codexContext = codexContext; this.codexBridge = codexBridge; this.onMessage = onMessage;
    this.adapters = adapters || {
      claude: { list: listClaudeSessions, find: findClaudeSession, send: sendVisibleClaudeMessage, ...createClaudeNativeUi({ root }) },
      codex: { list: listCodexSessions, find: findCodexSession, send: sendCodexMessage },
      opencode: createOpenCodeAdapter({ root }),
    };
    // Injected transports may provide their own runtime. Production Codex
    // deliveries read the existing native owner; the send still uses App Tools.
    this.deliveryRuntimeFactory = runtimeFactory || (!adapters ? session => createRuntime(session, { opencode: this.adapters.opencode }) : null);
    if (store?.reserveLifecycle) this.lifecycle = new SessionLifecycle({ store, root, adapters: this.adapters, directories: lifecycleDirectories, accessPolicy,
      runtimeFactory: runtimeFactory || (session => createRuntime(session, { opencode: this.adapters.opencode })) });
    if (store?.admit) this.mailbox = new SessionMailbox({ store, onMessage,
      deliverMessage: async record => {
        const access = this.accessPolicy || await readAccessPolicy(); access.assert(record.from.cwd); access.assert(record.to.cwd);
        if (record.to.client === 'codex' && this.deliveryRuntimeFactory) {
          let runtime;
          try {
            runtime = this.deliveryRuntimeFactory(record.to);
            const current = await runtime.status();
            if (current.quota) return { status: 'deferred', notSubmitted: true, runtime: current,
              detail: '接收会话额度不足，消息已保留，等待额度恢复。' };
          } catch { /* An unavailable observer is not evidence of exhausted quota. */ }
          finally { runtime?.close?.(); }
        }
        const context = record.to.client === 'codex' && this.codexBridge ? await this.codexBridge.getContext() : this.codexContext;
        try { return await this.adapters[record.to.client].send({ ...await this.deliveryPayload(record), context }); }
        catch (error) { if (record.to.client === 'codex') this.codexBridge?.invalidate(); throw error; }
      },
      deliverResume: async item => {
        const runtime = createRuntime(item.to, { opencode: this.adapters.opencode });
        try {
          const current = await runtime.status(); const cycle = store.cycle(item.cycleId);
          if (current.instanceId !== cycle.triggerRuntime.instanceId || !controlTurnEnded(cycle, current))
            return { status: 'failed', error: '恢复业务前原生轮次已改变，请核对是否仍需继续原任务。' };
          return await runtime.sendControl(item.text, current);
        } finally { runtime.close(); }
      } });
  }
  async deliveryPayload(record) {
    const affixes = record.messageAffixes || (await readPromptSettings(this.root)).values.messages[record.to.client];
    const envelope = messageEnvelope(record.from, record.text, record.id);
    return { targetId: record.to.id, targetSession: record.to, messageId: record.id,
      text: record.to.client === 'opencode' ? envelope : applyMessageAffixes(envelope, affixes),
      ...(record.to.client === 'opencode' ? { messageAffixes: { prefix: affixes.prefix, suffix: affixes.suffix } } : {}) };
  }
  async sessions({ directory, directories, recursive = false }) {
    const access = this.accessPolicy || await readAccessPolicy();
    if (Array.isArray(directories)) {
      directories = directories.filter(d => access.permits(d.path, d.recursive));
      const results = await Promise.allSettled(directories.filter(d => d.enabled !== false).map(d => this.sessions({ directory: d.path, recursive: d.recursive })));
      const merged = new Map(), warnings = [], directoryResults = [];
      const selected = directories.filter(d => d.enabled !== false);
      for (const [i, result] of results.entries()) {
        const root = selected[i];
        if (result.status === 'rejected') { warnings.push(`${root.path}：${result.reason.message}`); directoryResults.push({ ...root, error: result.reason.message }); continue; }
        directoryResults.push({ ...root, error: null }); warnings.push(...result.value.warnings);
        for (const session of result.value.sessions) {
          const key = session.address; const old = merged.get(key);
          if (old) old.directoryIds.push(root.id);
          else merged.set(key, { ...session, directoryIds: [root.id], policy: this.store.getPolicy?.(session) || null,
            monitoring: this.store.getSnapshot?.(session) || null, cycle: this.publicCycle(this.store.activeCycle?.(session)), queueCount: this.store.queueCount?.(session) || 0, queueState: this.store.queueState?.(session) || {} });
        }
      }
      return { directories: directoryResults, sessions: [...merged.values()].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')), warnings: [...new Set(warnings)] };
    }
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('请填写工作目录。');
    access.assert(directory, recursive);
    const absolute = await realpath(resolve(directory));
    access.assert(absolute, recursive);
    if (!(await stat(absolute)).isDirectory()) throw new Error('所选路径不是目录。');
    const results = await Promise.allSettled(Object.entries(this.adapters).map(async ([client, adapter]) => ({ client, ...await adapter.list({ directory: absolute, recursive }) })));
    const sessions = [], warnings = [];
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === 'rejected') warnings.push(`${Object.keys(this.adapters)[index]}：${result.reason.message}`);
      else { sessions.push(...result.value.sessions.map(publicSession)); warnings.push(...(result.value.warnings || [])); }
    }
    return { directory: absolute, sessions: sessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')), warnings };
  }
  publicCycle(cycle) {
    if (!cycle) return null;
    return Object.fromEntries(['id', 'state', 'previousState', 'trigger', 'wasWorkingAtTrigger', 'createdAt', 'updatedAt', 'reason', 'handoffPath', 'lastAttemptOutcome', 'completedAt', 'lastReceiptIssue', 'lateReceiptAccepted'].map(key => [key, cycle[key]]));
  }
  async send({ from, to, message }, source) {
    if (typeof message !== 'string' || !message.trim()) throw new Error('消息内容不能为空。');
    if (Buffer.byteLength(message, 'utf8') > 256 * 1024) throw new Error('单条消息最多 256 KiB，请缩短报告。');
    const target = parseAddress(to);
    const sender = parseAddress(`${from?.client}:${from?.id}`);
    if (!this.adapters[sender.client] || !this.adapters[target.client]) throw new Error('该客户端尚未在当前管理服务接入。');
    if (target.client === sender.client && target.id === sender.id) throw new Error('发送方和接收方是同一会话。');
    const senderSession = await this.adapters[sender.client].find(sender.id);
    if (!senderSession) throw new Error('无法确认发送方会话身份，请从该会话启动 CLI 或 MCP。');
    const targetSession = await this.adapters[target.client].find(target.id);
    if (!targetSession) throw new Error('找不到指定接收会话，请检查地址。');
    const access = this.accessPolicy || await readAccessPolicy(); access.assert(senderSession.cwd); access.assert(targetSession.cwd);
    if (senderSession.client === targetSession.client && (senderSession.client === 'opencode'
      ? senderSession.id === targetSession.id : senderSession.id.toLowerCase() === targetSession.id.toLowerCase())) throw new Error('发送方和接收方是同一会话。');
    const prompts = await readPromptSettings(this.root);
    const { prefix, suffix } = prompts.values.messages[target.client];
    const record = {
      id: randomUUID(), createdAt: new Date().toISOString(), status: 'pending',
      from: publicSession(senderSession), to: publicSession(targetSession), text: message,
      messageAffixes: { prefix, suffix }, promptRevision: prompts.revision,
      ...(source ? { source } : {}),
    };
    if (this.mailbox) {
      const saved = await this.mailbox.send(record);
      return { messageId: saved.id, status: saved.status, to: saved.to.address,
        ...(saved.cycleId ? { cycleId: saved.cycleId } : {}), ...(saved.error ? { error: saved.error } : {}), ...(saved.detail ? { detail: saved.detail } : {}) };
    }
    await this.store.create(record);
    this.onMessage(record.id);
    try {
      const result = await this.adapters[target.client].send({ ...await this.deliveryPayload(record), context: this.codexContext });
      await this.store.update(record.id, { ...result, status: result.status || 'unknown', completedAt: new Date().toISOString() });
    } catch (error) {
      await this.store.update(record.id, { status: error.outcome === 'unknown' ? 'unknown' : 'failed', error: error.message, completedAt: new Date().toISOString() });
    }
    this.onMessage(record.id);
    const saved = this.store.messages.get(record.id);
    // Do not expose history, session discovery, endpoints, or credentials to agents.
    return { messageId: saved.id, status: saved.status, to: saved.to.address, ...(saved.error ? { error: saved.error } : {}), ...(saved.detail ? { detail: saved.detail } : {}) };
  }
}
