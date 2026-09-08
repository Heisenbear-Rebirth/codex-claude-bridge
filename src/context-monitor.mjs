import { CodexRuntime } from './runtime/codex-runtime.mjs';
import { ClaudeRuntime } from './runtime/claude-runtime.mjs';
import { IncrementalContextReader } from './context-usage.mjs';
import { evaluatePolicy } from './context-policy.mjs';
import { sessionKey } from './management-store.mjs';

export class ContextMonitor {
  constructor({ store, service, runtimeFactory, onUpdate = () => {} }) {
    this.store = store; this.service = service; this.onUpdate = onUpdate; this.clients = new Map(); this.readers = new Map();
    this.runtimeFactory = runtimeFactory || (session => session.client === 'codex' ? new CodexRuntime(session.id) : new ClaudeRuntime(session.id));
    this.inFlight = new Map();
  }
  runtime(session) { const key = sessionKey(session); if (!this.clients.has(key)) this.clients.set(key, this.runtimeFactory(session)); return this.clients.get(key); }
  sample(session, { native = false } = {}) {
    const key = sessionKey(session); if (this.inFlight.has(key)) return this.inFlight.get(key);
    const work = this.readSample(session, native).finally(() => this.inFlight.delete(key)); this.inFlight.set(key, work); return work;
  }
  async readSample(session, native) {
    const key = sessionKey(session), adapter = this.runtime(session);
    let runtime, usage, error;
    try {
      runtime = await adapter.status();
      if (session.client === 'claude') {
        usage = runtime.usage;
        if (runtime.activity === 'idle' && (native || !usage || !(usage.contextWindowTokens > 0))) {
          try { usage = (await adapter.context()).usage; runtime = await adapter.status(); usage = runtime.usage || usage; }
          catch (e) { error = e.message; }
        }
      } else {
        if (!this.readers.has(key)) this.readers.set(key, new IncrementalContextReader(session.client, session.id));
        try { usage = await this.readers.get(key).read(); } catch (e) { error = e.message; }
      }
    } catch (e) { error = e.message; runtime = { connected: false, activity: 'offline', observedAt: new Date().toISOString(), capabilities: {} }; this.clients.delete(key); adapter.close(); }
    const policy = this.store.getPolicy(session);
    const cycle = this.store.activeCycle(session);
    const lastCycle = this.store.lastCycle(session);
    const decision = evaluatePolicy({ policy, runtime, usage, cycle, lastCycle });
    const sample = { session, runtime, usage: usage || null, decision, error: error || null, observedAt: new Date().toISOString() };
    this.store.saveSnapshot(session, sample); this.onUpdate(session); return sample;
  }
  close() { for (const adapter of this.clients.values()) adapter.close(); this.clients.clear(); }
}
