import { join } from 'node:path';

function receiptInstruction(root, cycle, stage, token) {
  const args = { cycleId: cycle.id, stage, receiptToken: token, documentPath: cycle.handoffPath };
  const quote = value => "'" + String(value).replaceAll("'", cycle.session.client === 'codex' ? "''" : "'\\''") + "'";
  const entry = join(root, 'bin', 'coop-checkpoint.mjs').replaceAll('\\', '/');
  const command = ['node', /^[a-z0-9_./:-]+$/i.test(entry) ? entry : quote(entry), '--client', cycle.session.client,
    '--cycle', quote(cycle.id), '--stage', stage, '--receipt-token', quote(token), '--document', quote(cycle.handoffPath.replaceAll('\\', '/'))].join(' ');
  return `完成后调用 context_checkpoint：${JSON.stringify(args)}\n若无此工具，执行以下命令（${cycle.session.client === 'codex' ? 'PowerShell' : 'Bash'}）：\n${command}\n收到 status=accepted 后结束本轮，等待后续指令。`;
}
export function handoffPrompt(root, cycle, token) {
  return `即将压缩上下文，之后会读取交付文档来恢复上下文。请将接续任务所必需的信息保存到下方 documentPath，比如当前进展、关键约束或容易遗漏的事项。内容和组织方式自行判断。\n\n${receiptInstruction(root, cycle, 'handoff', token)}`;
}
export function restorePrompt(root, cycle, token) {
  return `请读取下方 documentPath 中的交付文档，按需查阅其他文件，恢复到能够接续任务的状态。\n\n${receiptInstruction(root, cycle, 'restored', token)}`;
}
export function continuePrompt() {
  return '上下文维护已完成，继续工作。';
}
