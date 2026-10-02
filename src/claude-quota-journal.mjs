import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readClaudeHistoryHead } from './maintenance-recovery.mjs';
import { normalizeDirectory } from './directory-service.mjs';

const uuid = value => /^[0-9a-f-]{36}$/i.test(value || '');
const fields = ['model', 'effort', 'permissionMode'];
// Only protocol metadata is retained, never prompt or transcript text. This
// ledger outlives both the wrapper registry and the management service.
export class ClaudeQuotaJournal {
  constructor({ directory, sessionId, cwd, readHead = readClaudeHistoryHead }) {
    Object.assign(this, { directory, sessionId, cwd, readHead });
    this.loaded = false; this.candidate = null; this.nextRead = 0; this.generation = 0;
    this.reason = null; this.failed = false;
    this.load();
  }
  load() {
    if (this.loaded || !uuid(this.sessionId)) return;
    this.loaded = true; this.file = join(this.directory, this.sessionId + '.json');
    let saved;
    try { saved = JSON.parse(readFileSync(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') { this.failed = true; this.reason = '退出前的额度记录暂不可核对，请检查原会话。'; return; }
      return; // Absence is not evidence of a quota failure.
    }
    if (saved?.version === 1 && saved.sessionId === this.sessionId && saved.cwd
      && normalizeDirectory(saved.cwd) === normalizeDirectory(this.cwd) && saved.quota && uuid(saved.lastInputId)) {
      this.candidate = saved; this.reason = '正在核对退出前的限额轮次，确认后继续检测额度。';
    }
  }
  get pending() { return Boolean(this.candidate) || this.failed; }
  observe(state) {
    if (!this.sessionId && state.sessionId) { this.sessionId = state.sessionId; this.load(); }
    if (!this.file) return;
    // Initialization and replay alone cannot replace a previous failure.
    if (!state.lastObservedInputId && !state.userStopped && !state.active) return;
    this.generation++; this.candidate = null; this.failed = false; this.reason = null;
    const record = { version: 1, sessionId: this.sessionId, cwd: this.cwd,
      lastInputId: state.lastObservedInputId, quota: state.quota, lastQuotaAssistantId: state.lastQuotaAssistantId,
      ...Object.fromEntries(fields.map(key => [key, state[key] ?? null])) };
    const signature = JSON.stringify(record);
    if (signature === this.signature) return;
    try {
      mkdirSync(this.directory, { recursive: true });
      writeFileSync(this.file + '.tmp', signature + '\n', { mode: 0o600, flush: true });
      renameSync(this.file + '.tmp', this.file); this.signature = signature;
    } catch {
      this.failed = true; this.reason = '额度恢复记录未能保存，自动恢复已暂停。';
      // Remove any stale authority when invalidation cannot be saved.
      try { unlinkSync(this.file); } catch {}
    }
  }
  async restore(state) {
    if (!this.candidate || !state.initialized || state.active || state.inputEnded || state.hostRequests.size
      || state.childRequests.size || state.queuedInputIds.length || state.backgroundTasks.size || state.expectedPeers.size) return;
    if (this.reading) return this.reading;
    if (Date.now() < this.nextRead) return;
    this.nextRead = Date.now() + 5000;
    const candidate = this.candidate, generation = this.generation, revision = state.activityRevision;
    this.reading = (async () => {
      const head = await this.readHead({ id: this.sessionId, cwd: this.cwd });
      if (this.candidate !== candidate || this.generation !== generation || state.activityRevision !== revision
        || state.active || state.userStopped || state.lastObservedInputId) return;
      if (!head.verified) return;
      if (!head.cwd || normalizeDirectory(head.cwd) !== normalizeDirectory(this.cwd) || head.lastInputId !== candidate.lastInputId
        || fields.some(key => candidate[key] != null && state[key] != null && candidate[key] !== state[key])) {
        // Verified new input/settings supersede the old failure.
        this.candidate = null; this.reason = null;
        state.lastObservedInputId = head.lastInputId; this.observe(state); return;
      }
      if (fields.some(key => candidate[key] != null && state[key] == null)) return;
      if (!head.quotaError && !(candidate.lastQuotaAssistantId && candidate.lastQuotaAssistantId === head.lastAssistantId)) return;
      state.quota = candidate.quota; state.lastCompletedTurnId = candidate.quota.turnId;
      state.lastObservedInputId = candidate.lastInputId; state.lastQuotaAssistantId = candidate.lastQuotaAssistantId;
      state.activityRevision++; this.observe(state);
    })().finally(() => { this.reading = null; });
    return this.reading;
  }
}
