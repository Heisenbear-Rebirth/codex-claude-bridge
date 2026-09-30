import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultPromptValues, validatePromptValues } from '../public/prompt-templates.mjs';

const filename = root => join(root, '.cooperation', 'prompt-settings.json');
function decode(text) {
  if (Buffer.byteLength(text) > 256 * 1024) throw Error('提示词配置文件过大。');
  const data = JSON.parse(text);
  if (data.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 1) throw Error('提示词配置版本无效。');
  return { ...data, values: validatePromptValues(data.values) };
}
const initial = () => ({ version: 1, revision: 0, values: defaultPromptValues() });
export async function readPromptSettings(root) {
  if (!root) return initial();
  try { return decode(await readFile(filename(root), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return initial(); throw Error('无法读取提示词设置：' + error.message); }
}
export function claudeDisplayLabel(root) {
  // A damaged optional display preference must never break the native stream.
  try { return decode(readFileSync(filename(root), 'utf8')).values.messages.claude.label; }
  catch { return defaultPromptValues().messages.claude.label; }
}
export class PromptSettings {
  constructor(root) { this.root = root; this.pending = Promise.resolve(); }
  read() { return readPromptSettings(this.root); }
  save(values, expectedRevision) {
    const checked = validatePromptValues(values);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw Error('请先读取当前提示词设置再保存。');
    const work = this.pending.catch(() => {}).then(async () => {
      const current = await this.read();
      if (expectedRevision !== current.revision) throw Object.assign(Error('提示词已在其他窗口修改；请重新打开设置后再保存。'), { statusCode: 409 });
      const next = { version: 1, revision: current.revision + 1, updatedAt: new Date().toISOString(), values: checked };
      await mkdir(join(this.root, '.cooperation'), { recursive: true });
      const file = filename(this.root), temporary = file + '.' + randomUUID() + '.tmp';
      try { await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
      finally { await unlink(temporary).catch(() => {}); }
      return next;
    });
    this.pending = work; return work;
  }
  async close() { await this.pending.catch(() => {}); }
}
