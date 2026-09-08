import { sessionKey } from './management-store.mjs';

export class SessionMailbox {
  constructor({ store, deliverMessage, deliverResume, onMessage = () => {} }) {
    this.store = store; this.deliverMessage = deliverMessage; this.deliverResume = deliverResume; this.onMessage = onMessage;
    this.running = new Map(); this.closed = false;
  }
  async send(record) {
    const saved = this.store.admit(record); this.onMessage(saved.id);
    const key = sessionKey(record.to);
    if (!this.store.mailbox(key).locked_cycle) await this.drain(key);
    return this.store.getMessage(saved.id);
  }
  drain(key) {
    if (this.closed) return Promise.resolve();
    if (this.running.has(key)) return this.running.get(key);
    const task = this.dispatch(key).finally(() => this.running.delete(key));
    this.running.set(key, task); return task;
  }
  async dispatch(key) {
    while (!this.closed) {
      const item = this.store.claimNext(key); if (!item) return;
      let result;
      try {
        result = item.kind === 'message' ? await this.deliverMessage(this.store.getMessage(item.messageId)) : await this.deliverResume(item);
        if (!['submitted', 'unknown', 'failed'].includes(result?.status)) result = { status: 'failed', error: '原生客户端未接受该操作。' };
      } catch (error) { result = { status: error.outcome === 'unknown' ? 'unknown' : 'failed', error: error.message }; }
      this.store.finishOutbox(item.id, result); this.onMessage(item.messageId || item.id);
    }
  }
  async flush() { await Promise.all(this.store.readyTargets().map(key => this.drain(key))); }
  async close() { this.closed = true; await Promise.allSettled([...this.running.values()]); }
}
