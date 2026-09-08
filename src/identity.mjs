import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export async function detectSender({ client, metadata = {} } = {}) {
  let turn = metadata['x-codex-turn-metadata'];
  if (typeof turn === 'string') { try { turn = JSON.parse(turn); } catch { turn = null; } }
  const codexId = metadata['openai/threadId'] || metadata['openai/thread_id'] || turn?.thread_id;
  const chosen = client || process.env.COOP_CLIENT || (codexId ? 'codex' : null);
  if (chosen === 'codex' || (!chosen && process.env.CODEX_THREAD_ID && !process.env.CLAUDE_CODE_ENTRYPOINT)) {
    const id = codexId || process.env.CODEX_THREAD_ID;
    if (!id) throw new Error('当前进程没有 Codex 会话身份。');
    return { client: 'codex', id };
  }
  if (chosen && chosen !== 'claude') throw new Error('客户端类型必须是 codex 或 claude。');
  // Match a real ancestor process to Claude's live registry. No arbitrary --from flag.
  const ancestors = await processAncestors();
  const directory = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'sessions');
  let files;
  try { files = await readdir(directory); } catch { throw new Error('没有找到当前 Claude 会话的身份。请从 Claude 的工具进程启动此命令。'); }
  for (const pid of ancestors) {
    const filename = `${pid}.json`;
    if (!files.includes(filename)) continue;
    try {
      const record = JSON.parse(await readFile(join(directory, filename), 'utf8'));
      if (record.pid === pid && record.sessionId) return { client: 'claude', id: record.sessionId };
    } catch { /* A session can end while its process tree is inspected. */ }
  }
  if (!chosen && process.env.CODEX_THREAD_ID) return { client: 'codex', id: process.env.CODEX_THREAD_ID };
  throw new Error('无法从进程来源确认当前会话；请在 Codex 或 Claude Code 的工具环境中调用。');
}
async function processAncestors() {
  if (process.platform === 'win32') {
    const script = `$currentProcessId = ${process.pid}; $ancestorIds = @(); for ($step = 0; $step -lt 16 -and $currentProcessId -gt 0; $step++) { $entry = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $currentProcessId); if (-not $entry) { break }; $ancestorIds += [int]$entry.ProcessId; $currentProcessId = [int]$entry.ParentProcessId }; ConvertTo-Json -Compress -InputObject @($ancestorIds)`;
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000 });
    return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  }
  const result = [];
  let pid = process.pid;
  for (let index = 0; index < 16 && pid > 1; index++) {
    result.push(pid);
    try { const { stdout } = await exec('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 2000 }); pid = Number(stdout.trim()); } catch { break; }
  }
  return result;
}
