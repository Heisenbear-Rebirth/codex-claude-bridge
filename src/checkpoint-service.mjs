import { readFile, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { sessionKey } from './management-store.mjs';
import { normalizeDirectory } from './directory-service.mjs';

export const receiptHash = token => createHash('sha256').update(String(token)).digest('hex');
function equalHash(a, b) { return typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
export class CheckpointService {
  constructor({ store, root, onReceipt = () => {} }) { this.store = store; this.root = root; this.onReceipt = onReceipt; }
  async accept({ from, cycleId, stage, receiptToken, documentPath }) {
    if (!['handoff', 'restored'].includes(stage)) throw new Error('无效的回执阶段。');
    const cycle = this.store.cycle(cycleId);
    if (!cycle || sessionKey(from) !== sessionKey(cycle.session)) throw new Error('回执发送方不属于当前维护流程。');
    if (!equalHash(receiptHash(receiptToken), cycle.receiptHashes?.[stage])) throw new Error('回执凭证不匹配。');
    const existing = this.store.checkpoint(cycleId, stage);
    if (existing) {
      if (documentPath && normalizeDirectory(documentPath) !== normalizeDirectory(existing.documentPath)) throw new Error('重复回执的文档路径发生变化。');
      return { status: 'accepted', cycleId, stage, duplicate: true };
    }
    const expected = stage === 'handoff' ? 'writing_handoff' : 'restoring';
    if ((cycle.state === 'waiting_client' ? cycle.previousState : cycle.state) !== expected || !cycle.controlDispatched) throw new Error('该维护流程目前不接受此阶段的回执。');
    if (typeof documentPath !== 'string' || !isAbsolute(documentPath)) throw new Error('请提供交付文档的绝对路径。');
    const allowedRoot = await realpath(cycle.session.cwd);
    const actual = await realpath(documentPath);
    const rel = relative(allowedRoot, actual);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('交付文档必须位于目标会话获准的工作目录内。');
    const info = await stat(actual);
    if (!info.isFile() || info.size === 0 || info.size > 2 * 1024 * 1024) throw new Error('交付文档必须是非空文件，且不能超过 2 MiB。');
    const bytes = await readFile(actual); const documentHash = createHash('sha256').update(bytes).digest('hex');
    if (stage === 'restored' && documentHash !== cycle.documentHash) throw new Error('恢复时的交付文档与第一次回执的内容不一致。');
    const receipt = { at: new Date().toISOString(), from, documentPath: actual, documentHash, bytes: bytes.length, cycleId, stage };
    const backupDir = join(this.root, '.cooperation', 'handoff-copies', cycleId);
    await mkdir(backupDir, { recursive: true });
    // Only the validated document is copied, always into this project's storage.
    if (stage === 'handoff') await writeFile(join(backupDir, 'handoff.md'), bytes, { flag: 'wx' }).catch(async error => {
      if (error.code !== 'EEXIST' || createHash('sha256').update(await readFile(join(backupDir, 'handoff.md'))).digest('hex') !== documentHash) throw error;
    });
    this.store.transaction(() => {
      const current = this.store.cycle(cycleId);
      const duplicate = this.store.checkpoint(cycleId, stage);
      if (duplicate && duplicate.documentHash === documentHash) return;
      if (current.revision !== cycle.revision || (current.state === 'waiting_client' ? current.previousState : current.state) !== expected) throw new Error('维护流程在校验期间已改变，请核对后重试回执。');
      this.store.saveCheckpoint(cycleId, stage, receipt);
      this.store.updateCycle(cycleId, stage === 'handoff' ? 'awaiting_handoff_end' : 'awaiting_restore_end',
        { ...(stage === 'handoff' ? { documentHash, handoffPath: actual } : {}), receiptAt: receipt.at });
    });
    // The controller observes this transition on its next tick, after the tool
    // response and native turn end. It never compacts inside this HTTP request.
    this.onReceipt(cycleId); return { status: 'accepted', cycleId, stage, duplicate: false };
  }
}
