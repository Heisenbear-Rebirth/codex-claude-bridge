import { join } from 'node:path';
import { PROMPT_DEFAULTS, renderPromptTemplate } from '../public/prompt-templates.mjs';

function receiptInstruction(root, cycle, stage, token) {
  const args = { cycleId: cycle.id, stage, receiptToken: token, documentPath: cycle.handoffPath };
  if (cycle.session.client === 'opencode') return `这是用户在 Cooperation 中启用的上下文维护阶段，沿用本会话原有权限。完成后调用 cooperation_context_checkpoint：${JSON.stringify(args)}\n收到 status=accepted 后结束本轮，等待后续指令；不要自行继续业务或执行额外压缩。`;
  if (!['codex', 'claude'].includes(cycle.session.client)) throw new Error('此客户端的维护回执尚未开放。');
  const quote = value => "'" + String(value).replaceAll("'", cycle.session.client === 'codex' ? "''" : "'\\''") + "'";
  const entry = join(root, 'bin', 'coop-checkpoint.mjs').replaceAll('\\', '/');
  const command = ['node', /^[a-z0-9_./:-]+$/i.test(entry) ? entry : quote(entry), '--client', cycle.session.client,
    '--cycle', quote(cycle.id), '--stage', stage, '--receipt-token', quote(token), '--document', quote(cycle.handoffPath.replaceAll('\\', '/'))].join(' ');
  return `完成后调用 context_checkpoint：${JSON.stringify(args)}\n若无此工具，执行以下命令（${cycle.session.client === 'codex' ? 'PowerShell' : 'Bash'}）：\n${command}\n收到 status=accepted 后结束本轮，等待后续指令。`;
}
function render(stage, root, cycle, token, values = PROMPT_DEFAULTS) {
  return renderPromptTemplate(values.maintenance[stage], { documentPath: cycle.handoffPath, cycleId: cycle.id,
    sessionId: cycle.session.id, client: cycle.session.client,
    checkpoint: stage === 'continue' ? '' : receiptInstruction(root, cycle, stage === 'handoff' ? 'handoff' : 'restored', token) });
}
export function handoffPrompt(root, cycle, token, values) { return render('handoff', root, cycle, token, values); }
export function restorePrompt(root, cycle, token, values) { return render('restore', root, cycle, token, values); }
export function continuePrompt(cycle, values) {
  return render('continue', '', cycle || { session: {}, id: '', handoffPath: '' }, '', values);
}
export function promptPreviewSamples(root) {
  return Object.fromEntries(['codex', 'claude', 'opencode'].map(client => {
    const cycle = { id: '示例流程', session: { id: '示例会话', client }, handoffPath: join(root, '.cooperation', 'handoffs', client, '示例会话', '示例流程.md') };
    return [client, { documentPath: cycle.handoffPath, cycleId: cycle.id, sessionId: cycle.session.id, client,
      handoffCheckpoint: receiptInstruction(root, cycle, 'handoff', '<运行时生成的阶段凭证>'),
      restoreCheckpoint: receiptInstruction(root, cycle, 'restored', '<运行时生成的阶段凭证>') }];
  }));
}
