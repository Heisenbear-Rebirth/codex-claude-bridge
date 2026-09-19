import { execFileSync } from 'node:child_process';

// A live PID may belong to an unrelated process after a reboot. Only reclaim
// when Windows proves that the current process was born after the lock.
export function managerProcessAlive(record) {
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return true;
  try { process.kill(record.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; return true; }
  const acquiredAt = Date.parse(record.started_at);
  if (process.platform !== 'win32' || !Number.isFinite(acquiredAt)) return true;
  try {
    const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${record.pid}' -ErrorAction Stop; if ($null -eq $p) { 'missing' } else { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }`;
    const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (result === 'missing') return false;
    const bornAt = result ? Number(result) : NaN;
    return !Number.isFinite(bornAt) || bornAt <= acquiredAt;
  } catch { return true; } // Unknown identity must not steal a live manager's lock.
}
