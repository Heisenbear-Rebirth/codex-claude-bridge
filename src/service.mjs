import { randomUUID } from 'node:crypto';
import { stat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseAddress, publicSession, messageEnvelope } from './address.mjs';
import { listClaudeSessions, findClaudeSession } from './adapters/claude.mjs';
import { listCodexSessions, findCodexSession, sendCodexMessage } from './adapters/codex.mjs';
import { SessionMailbox } from './session-mailbox.mjs';
import { ClaudeRuntime, sendVisibleClaudeMessage } from './runtime/claude-runtime.mjs';
import { CodexRuntime } from './runtime/codex-runtime.mjs';
import { controlTurnEnded } from './maintenance-recovery.mjs';

export class CooperationService {
  constructor({ store, codexContext, codexBridge, onMessage = () => {}, adapters } = {}) {
    this.store = store; this.codexContext = codexContext; this.codexBridge = codexBridge; this.onMessage = onMessage;
    this.adapters = adapters || {
      claude: { list: listClaudeSessions, find: findClaudeSession, send: sendVisibleClaudeMessage },
      codex: { list: listCodexSessions, find: findCodexSession, send: sendCodexMessage },
    };
    if (store?.admit) this.mailbox = new SessionMailbox({ store, onMessage,
      deliverMessage: async record => {
        const context = record.to.client === 'codex' && this.codexBridge ? await this.codexBridge.getContext() : this.codexContext;
        try { return await this.adapters[record.to.client].send({ targetId: record.to.id, text: messageEnvelope(record.from, record.text, record.id), messageId: record.id, context }); }
        catch (error) { if (record.to.client === 'codex') this.codexBridge?.invalidate(); throw error; }
      },
      deliverResume: async item => {
        const runtime = item.to.client === 'codex' ? new CodexRuntime(item.to.id) : new ClaudeRuntime(item.to.id);
        try {
          const current = await runtime.status(); const cycle = store.cycle(item.cycleId);
          if (current.instanceId !== cycle.triggerRuntime.instanceId || !controlTurnEnded(cycle, current))
            return { status: 'failed', error: '恢复业务前原生轮次已改变，请核对是否仍需继续原任务。' };
          return await runtime.sendControl(item.text, current);
        } finally { runtime.close(); }
      } });
  }
  async sessions({ directory, directories, recursive = false }) {
    if (Array.isArray(directories)) {
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
    const absolute = await realpath(resolve(directory));
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
    return Object.fromEntries(['id', 'state', 'previousState', 'trigger', 'wasWorkingAtTrigger', 'createdAt', 'updatedAt', 'reason', 'handoffPath', 'lastAttemptOutcome', 'completedAt'].map(key => [key, cycle[key]]));
  }
  async send({ from, to, message }) {
    if (typeof message !== 'string' || !message.trim()) throw new Error('消息内容不能为空。');
    if (Buffer.byteLength(message, 'utf8') > 256 * 1024) throw new Error('单条消息最多 256 KiB，请缩短报告。');
    const target = parseAddress(to);
    const sender = parseAddress(`${from?.client}:${from?.id}`);
    if (target.client === sender.client && target.id === sender.id) throw new Error('发送方和接收方是同一会话。');
    const senderSession = await this.adapters[sender.client].find(sender.id);
    if (!senderSession) throw new Error('无法确认发送方会话身份，请从该会话启动 CLI 或 MCP。');
    const targetSession = await this.adapters[target.client].find(target.id);
    if (!targetSession) throw new Error('找不到指定接收会话，请检查地址。');
    if (senderSession.client === targetSession.client && senderSession.id.toLowerCase() === targetSession.id.toLowerCase()) throw new Error('发送方和接收方是同一会话。');
    const record = {
      id: randomUUID(), createdAt: new Date().toISOString(), status: 'pending',
      from: publicSession(senderSession), to: publicSession(targetSession), text: message,
    };
    if (this.mailbox) {
      const saved = await this.mailbox.send(record);
      return { messageId: saved.id, status: saved.status, to: saved.to.address,
        ...(saved.cycleId ? { cycleId: saved.cycleId } : {}), ...(saved.error ? { error: saved.error } : {}), ...(saved.detail ? { detail: saved.detail } : {}) };
    }
    await this.store.create(record);
    this.onMessage(record.id);
    try {
      const result = await this.adapters[target.client].send({ targetId: target.id, text: messageEnvelope(record.from, message, record.id), messageId: record.id, context: this.codexContext });
      await this.store.update(record.id, { status: result.status || 'unknown', transport: result.transport, completedAt: new Date().toISOString(), ...(result.detail ? { detail: result.detail } : {}) });
    } catch (error) {
      await this.store.update(record.id, { status: error.outcome === 'unknown' ? 'unknown' : 'failed', error: error.message, completedAt: new Date().toISOString() });
    }
    this.onMessage(record.id);
    const saved = this.store.messages.get(record.id);
    // Do not expose history, session discovery, endpoints, or credentials to agents.
    return { messageId: saved.id, status: saved.status, to: saved.to.address, ...(saved.error ? { error: saved.error } : {}), ...(saved.detail ? { detail: saved.detail } : {}) };
  }
}
