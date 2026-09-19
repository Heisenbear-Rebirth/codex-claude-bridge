import { createOpenCodeAdapter } from '../adapters/opencode.mjs';
import { randomUUID } from 'node:crypto';
import { nativeMessageId } from '../opencode-bridge.mjs';

export class OpenCodeRuntime {
  constructor(id, adapter = createOpenCodeAdapter()) { this.id = id; this.adapter = adapter; }
  status() { return this.adapter.status(this.id); }
  close() {}
  async context() { return { usage: (await this.status()).usage }; }
  async control(kind, expected, options = {}) {
    if (!expected?.capabilities?.automaticMaintenance) throw new Error('OpenCode 维护插件尚未就绪。');
    return this.adapter.control(this.id, { kind, expected, requestId: options.requestId || randomUUID(), ...options });
  }
  sendControl(text, expected, options = {}) { return this.control('prompt', expected, { messageId: options.messageId || nativeMessageId(), ...options, text }); }
  interrupt(expected, options = {}) { return this.control('interrupt', expected, options); }
  compact(expected, options = {}) { return this.control('compact', expected, options); }
}
