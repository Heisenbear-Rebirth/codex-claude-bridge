export const addressOf = session => session.client + ':' + session.id.toLowerCase();
export const autoCompressEnabled = policy => policy?.enabled === true && policy?.mode === 'automatic';
export function visibleAddresses(directories, sessions, expandedDirectories, expandedClients, query = '') {
  const needle = query.trim().toLocaleLowerCase(), visible = new Set();
  for (const directory of directories) {
    if (!expandedDirectories.has(directory.id)) continue;
    for (const client of ['claude', 'codex']) {
      if (!expandedClients.has(directory.id + ':' + client)) continue;
      for (const session of sessions) if (session.client === client && session.directoryIds?.includes(directory.id)
        && (!needle || (session.name + ' ' + session.id).toLocaleLowerCase().includes(needle))) visible.add(addressOf(session));
    }
  }
  return visible;
}
export function messageMatches(message, addresses) { return [message.from, message.to].some(s => addresses.has(addressOf(s))); }
export function validThresholds(soft, hard) {
  return Number.isFinite(soft) && Number.isFinite(hard) && soft > 0 && soft < hard && hard < 100;
}
// Serializes saves per session: an older slow response cannot overwrite a newer edit.
export class PolicySaver {
  constructor(send, notify) { this.send = send; this.notify = notify; this.pending = null; this.running = false; this.revision = 0; this.generation = 0; }
  async save(value) {
    this.pending = { value: structuredClone(value), generation: ++this.generation };
    if (this.running) return;
    this.running = true;
    while (this.pending) {
      const item = this.pending; this.pending = null; this.notify('saving', item);
      try {
        const policy = await this.send(item.value, this.revision);
        this.revision = policy.revision; this.notify(this.pending ? 'saving' : 'saved', { ...item, policy });
      } catch (error) {
        this.pending = null; this.notify('error', { ...item, error }); break;
      }
    }
    this.running = false;
  }
}
