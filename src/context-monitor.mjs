import { publicSession } from './address.mjs';
import { CodexRuntime } from './runtime/codex-runtime.mjs';
import { ClaudeRuntime } from './runtime/claude-runtime.mjs';
import { IncrementalContextReader } from './context-usage.mjs';
import { evaluatePolicy } from './context-policy.mjs';
import { sessionKey } from './management-store.mjs';

export class ContextMonitor {
  constructor({ store, service, runtimeFactory, onUpdate = () => {} }) {
    this.store = store; this.service = service; this.onUpdate = onUpdate; this.clients = new Map(); this.readers = new Map();
    this.runtimeFactory = runtimeFactory || (session => session.client === 'codex' ? new CodexRuntime(session.id) : new ClaudeRuntime(session.id));
    this.inFlight = new Map(); this.discovered = []; this.discoveryAt = 0; this.discoverySignature = ''; this.closed = false;
    this.nextSampleAt = new Map(); this.nativeQueryAt = new Map();
  }
  runtime(session) { const key = sessionKey(session); if (!this.clients.has(key)) this.clients.set(key, this.runtimeFactory(session)); return this.clients.get(key); }
  async observeAll() {
    if (this.closed) return new Map();
    const directories = this.store.directories(), signature = JSON.stringify(directories);
    if (signature !== this.discoverySignature || Date.now() - this.discoveryAt >= 15000) {
      const result = await this.service.sessions({ directories });
      this.discovered = result.sessions;
      this.discoverySignature = signature; this.discoveryAt = Date.now();
      const retained = new Set([...this.discovered, ...this.store.policies().filter(p => p.enabled).map(p => p.session),
        ...this.store.activeCycles().map(c => c.session)].map(sessionKey));
      for (const [key, client] of this.clients) if (!retained.has(key)) {
        client.close(); this.clients.delete(key); this.readers.delete(key); this.nextSampleAt.delete(key); this.nativeQueryAt.delete(key);
      }
    }
    const result = new Map();
    const sessions = [...this.discovered]; let index = 0;
    // Keep large directory sets from starting unbounded native operations.
    const worker = async () => {
      while (!this.closed && index < sessions.length) {
        const session = sessions[index++], key = sessionKey(session);
        if (this.store.activeCycle(session)) continue;
        if (Date.now() < (this.nextSampleAt.get(key) || 0)) { const cached = this.store.getSnapshot(session); if (cached) result.set(key, cached); continue; }
        const sample = await this.sample(session); result.set(key, sample);
        this.nextSampleAt.set(key, Date.now() + (sample.runtime.connected ? 1800 : 10000));
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(4, sessions.length) }, worker)); return result;
  }
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
        if (runtime.activity === 'idle' && (native || !usage || !(usage.contextWindowTokens > 0) || usage.historyChangedAfterMeasurement)
          && (native || Date.now() - (this.nativeQueryAt.get(key) || 0) >= 15000)) {
          this.nativeQueryAt.set(key, Date.now());
          try { usage = (await adapter.context()).usage; runtime = await adapter.status(); usage = runtime.usage || usage; }
          catch (e) { error = e.message; }
        }
      } else {
        if (!this.readers.has(key)) this.readers.set(key, new IncrementalContextReader(session.client, session.id));
        try { usage = await this.readers.get(key).read(); } catch (e) { error = e.message; }
      }
    } catch (e) { error = e.message; runtime = { connected: false, activity: 'offline', observedAt: new Date().toISOString(), capabilities: {} }; this.clients.delete(key); adapter.close(); }
    if (!usage) {
      try {
        if (!this.readers.has(key)) this.readers.set(key, new IncrementalContextReader(session.client, session.id));
        usage = await this.readers.get(key).read();
      } catch { /* No native process or saved record is represented as unknown, never zero. */ }
    }
    const policy = this.store.getPolicy(session);
    const cycle = this.store.activeCycle(session), lastCycle = this.store.lastCycle(session);
    const decision = evaluatePolicy({ policy, runtime, usage, cycle, lastCycle });
    const sample = { session: { ...publicSession(session), hostId: session.hostId || 'local' }, runtime, usage: usage || null, decision, error: error || null, observedAt: new Date().toISOString() };
    this.store.saveSnapshot(session, sample); this.onUpdate(session); return sample;
  }
  close() { this.closed = true; for (const adapter of this.clients.values()) adapter.close(); this.clients.clear(); }
}
