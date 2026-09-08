import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';

// Observe framing without changing the bytes forwarded between the IDE and CLI.
export class JsonLineObserver {
  constructor(onMessage, maximum = 32 * 1024 * 1024) { this.decoder = new StringDecoder('utf8'); this.buffer = ''; this.discarding = false; this.atBoundary = true; this.maximum = maximum; this.onMessage = onMessage; }
  push(chunk) {
    const text = this.decoder.write(chunk);
    this.atBoundary = chunk.length > 0 ? chunk[chunk.length - 1] === 10 : this.atBoundary;
    const parts = text.split('\n');
    for (let index = 0; index < parts.length; index++) {
      if (!this.discarding) this.buffer += parts[index];
      if (this.buffer.length > this.maximum) { this.buffer = ''; this.discarding = true; }
      if (index < parts.length - 1) {
        if (!this.discarding) { try { this.onMessage(JSON.parse(this.buffer)); } catch { /* Observing never changes the original transport. */ } }
        this.buffer = ''; this.discarding = false;
      }
    }
  }
}

export class ClaudeProtocolState {
  constructor(sessionId = null) {
    this.sessionId = sessionId; this.initialized = false; this.active = false; this.inputEnded = false;
    this.hostRequests = new Map(); this.childRequests = new Map(); this.userSequence = 0;
    this.lastResultAt = null; this.permissionMode = null; this.activityRevision = 0; this.activeTurnId = null;
    this.lastCompletedTurnId = null; this.queuedInputIds = []; this.model = null; this.effort = null;
    this.capacities = new Map(); this.usage = null; this.contextEpoch = 0; this.backgroundTasks = new Set();
  }
  begin(id) {
    if (!this.active) { this.active = true; this.activeTurnId = id || `observed-${randomUUID()}`; this.activityRevision++; }
  }
  host(message) {
    if (message.type === 'user') {
      this.userSequence++;
      if (this.active) { this.queuedInputIds.push(message.uuid || `input-${this.userSequence}`); this.activityRevision++; }
      else this.begin(message.uuid);
      if (this.usage) this.usage.historyChangedAfterMeasurement = true;
    }
    if (message.type === 'control_request' && message.request_id) this.hostRequests.set(message.request_id, message.request?.subtype);
    if (message.type === 'control_response' && this.childRequests.delete(message.response?.request_id)) this.activityRevision++;
  }
  child(message) {
    if (message.parent_tool_use_id) return;
    if (this.sessionId && message.session_id && message.session_id.toLowerCase() !== this.sessionId) return;
    if (typeof message.session_id === 'string' && /^[0-9a-f-]{36}$/i.test(message.session_id)) this.sessionId = message.session_id.toLowerCase();
    if (message.type === 'control_response') {
      const id = message.response?.request_id;
      if (this.hostRequests.get(id) === 'initialize' && message.response?.subtype === 'success') this.initialized = true;
      this.hostRequests.delete(id);
    }
    if (message.type === 'system' && message.subtype === 'init') {
      this.initialized = true;
      if (typeof message.permissionMode === 'string') this.permissionMode = message.permissionMode;
      if (typeof message.model === 'string') this.model = message.model;
    }
    if (message.type === 'control_request' && message.request_id) {
      this.childRequests.set(message.request_id, message.request?.subtype || 'unknown'); this.activityRevision++;
    }
    if (message.type === 'control_cancel_request' && this.childRequests.delete(message.request_id)) this.activityRevision++;
    if (['assistant', 'stream_event', 'tool_progress', 'tool_use_summary'].includes(message.type)
      || (message.type === 'system' && message.subtype === 'status' && message.status === 'compacting')) this.begin();
    if (message.type === 'system' && message.subtype === 'compact_boundary') { this.contextEpoch++; this.usage = null; }
    if (message.type === 'system' && message.subtype === 'task_started') this.backgroundTasks.add(message.task_id);
    if (message.type === 'system' && message.subtype === 'task_notification') this.backgroundTasks.delete(message.task_id);
    const api = message.type === 'assistant' ? message.message : message.type === 'stream_event' && message.event?.type === 'message_start' ? message.event.message : null;
    if (api?.usage) this.observeApiUsage(api.model, api.usage);
    if (message.type === 'stream_event' && message.event?.type === 'message_delta' && this.usage?.source === 'claude-passive-api-usage'
      && Number.isFinite(message.event.usage?.output_tokens)) {
      this.usage.outputTokens = message.event.usage.output_tokens;
      this.usage.usedTokens = this.usage.inputTokens + this.usage.outputTokens;
      this.usage.measuredAt = new Date().toISOString(); this.applyCapacity();
    }
    if (message.type === 'result') {
      for (const [model, usage] of Object.entries(message.modelUsage || {})) {
        if (Number.isFinite(usage.contextWindow) && usage.contextWindow > 0) this.capacities.set(model, usage.contextWindow);
      }
      if (this.usage) this.applyCapacity();
      this.lastCompletedTurnId = this.activeTurnId; this.activeTurnId = null;
      this.active = false; this.activityRevision++; this.lastResultAt = new Date().toISOString();
      // Queued native inputs make the boundary unavailable until their next output.
      if (this.queuedInputIds.length) this.begin(this.queuedInputIds.shift());
    }
  }
  observeApiUsage(model, usage) {
    if (typeof model !== 'string') return;
    this.model = model;
    const values = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].map(key => usage[key]);
    if (!values.every(n => Number.isFinite(n) && n >= 0)) return;
    const inputTokens = values.reduce((a, b) => a + b, 0), outputTokens = Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0;
    this.usage = { source: 'claude-passive-api-usage', model, inputTokens, outputTokens, usedTokens: inputTokens + outputTokens,
      measuredAt: new Date().toISOString(), contextEpoch: this.contextEpoch, historyChangedAfterMeasurement: false };
    this.applyCapacity();
  }
  applyCapacity() {
    const capacity = this.capacities.get(this.usage.model) ?? null;
    this.usage.contextWindowTokens = capacity;
    this.usage.usedPercent = capacity ? Math.round(this.usage.usedTokens * 10000 / capacity) / 100 : null;
  }
  observeNativeUsage(usage) {
    if (usage.model && usage.contextWindowTokens > 0) this.capacities.set(usage.model, usage.contextWindowTokens);
    this.usage = { ...usage, measuredAt: usage.queriedAt, contextEpoch: this.contextEpoch, historyChangedAfterMeasurement: false };
  }
  activity() {
    if (this.inputEnded) return 'offline';
    if (!this.initialized) return 'initializing';
    const requests = [...this.childRequests.values()];
    if (requests.includes('can_use_tool')) return 'waiting_permission';
    if (requests.includes('request_user_dialog')) return 'waiting_input';
    if (requests.length || this.hostRequests.size) return 'unknown';
    return this.active ? 'running' : 'idle';
  }
  canCompact(atBoundary = true) { return this.initialized && this.sessionId && !this.active && !this.inputEnded && this.hostRequests.size === 0 && this.childRequests.size === 0 && !this.queuedInputIds.length && !this.backgroundTasks.size && atBoundary; }
  publicState() { return { sessionId: this.sessionId, initialized: this.initialized, busy: this.active,
    activity: this.activity(), activityRevision: this.activityRevision, activeTurnId: this.activeTurnId, turnIdSource: 'wrapper-observed-input',
    lastCompletedTurnId: this.lastCompletedTurnId, queuedNativeInputs: this.queuedInputIds.length, backgroundTasks: this.backgroundTasks.size,
    pendingHostControls: this.hostRequests.size, pendingClientControls: this.childRequests.size,
    inputEnded: this.inputEnded, lastResultAt: this.lastResultAt, permissionMode: this.permissionMode, model: this.model, effort: this.effort,
    usage: this.usage }; }
}
