import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

// Append-only events preserve the names and exact text used at send time.
export class MessageStore {
  constructor(directory) { this.directory = directory; this.file = join(directory, 'messages.jsonl'); this.messages = new Map(); this.queue = Promise.resolve(); this.warnings = []; }
  async init() {
    await mkdir(this.directory, { recursive: true });
    let contents;
    try { contents = await readFile(this.file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return this; throw error; }
    const lines = contents.split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      try {
        const event = JSON.parse(lines[index]);
        if (event.type === 'created' && event.message?.id) this.messages.set(event.message.id, event.message);
        if (event.type === 'status' && this.messages.has(event.id)) Object.assign(this.messages.get(event.id), event.patch);
      } catch { this.warnings.push(`日志第 ${index + 1} 行无法读取，已保留原文件。`); }
    }
    // A process may exit between delivery and the final log write. Never resend it.
    for (const message of this.messages.values()) {
      if (message.status === 'pending') { message.status = 'unknown'; message.error = '上次进程结束前未确认发送结果；不会自动重发。'; }
    }
    // Repair only an incomplete trailing record boundary, preserving its bytes.
    if (contents && !contents.endsWith('\n')) await appendFile(this.file, '\n', 'utf8');
    return this;
  }
  async append(event) {
    const write = this.queue.then(() => appendFile(this.file, JSON.stringify(event) + '\n', 'utf8'));
    this.queue = write.catch(() => {});
    await write;
  }
  async create(message) {
    if (this.messages.has(message.id)) throw new Error('消息编号已存在。');
    await this.append({ type: 'created', message });
    this.messages.set(message.id, structuredClone(message));
    return message;
  }
  async update(id, patch) {
    await this.append({ type: 'status', id, patch });
    Object.assign(this.messages.get(id), patch);
  }
  list({ directory = '', q = '', client = 'all', recursive = false } = {}) {
    const normalized = normalizeDirectory(directory);
    const query = q.toLocaleLowerCase();
    return [...this.messages.values()].filter((message) => {
      if (normalized && ![message.from.cwd, message.to.cwd].some((cwd) => {
        const candidate = normalizeDirectory(cwd);
        return candidate === normalized || ((recursive === true || recursive === 'true') && candidate.startsWith(normalized + '/'));
      })) return false;
      if (client !== 'all' && message.from.client !== client && message.to.client !== client) return false;
      return !query || [message.text, message.from.displayAddress, message.to.displayAddress, message.id, message.error].some((value) => String(value || '').toLocaleLowerCase().includes(query));
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
function normalizeDirectory(value) {
  let text = String(value || '').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? text.toLowerCase() : text;
}
