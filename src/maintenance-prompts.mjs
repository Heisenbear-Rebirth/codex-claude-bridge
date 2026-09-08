import { join } from 'node:path';

function receiptInstruction(root, cycle, stage, token) {
  const args = { cycleId: cycle.id, stage, receiptToken: token, documentPath: cycle.handoffPath };
  const quote = value => "'" + String(value).replaceAll("'", cycle.session.client === 'codex' ? "''" : "'\\''") + "'";
  const entry = join(root, 'bin', 'coop-checkpoint.mjs').replaceAll('\\', '/');
  const command = ['node', /^[a-z0-9_./:-]+$/i.test(entry) ? entry : quote(entry), '--client', cycle.session.client,
    '--cycle', quote(cycle.id), '--stage', stage, '--receipt-token', quote(token), '--document', quote(cycle.handoffPath.replaceAll('\\', '/'))].join(' ');
  return `调用 context_checkpoint 工具，参数为 ${JSON.stringify(args)}。若当前工具列表尚未加载该工具，请通过原有命令工具执行以下 CLI（${cycle.session.client === 'codex' ? 'PowerShell' : 'Bash'} 写法，保留原权限流程）：\n${command}\n必须等工具返回 status=accepted，然后结束本轮。普通聊天中的 OK 不能代替系统回执；若执行被权限阻止，请说明阻碍并等待用户，不改权限。`;
}
export function handoffPrompt(root, cycle, token) {
  return `现在进行一次 Cooperation 上下文维护，流程 ${cycle.id}。暂停原业务任务，将接续所需信息写入 ${cycle.handoffPath}（必要时在本会话获准目录内创建父目录）。记录目标和用户约束、已完成内容、关键决定、文件及命令、验证结果、未完成事项、下一步，以及刚被中断的操作和需复查的副作用。记录能够确认的模型、思考强度和权限，不改变它们。文档简明完整，不复制全量聊天。确认文件可读后，${receiptInstruction(root, cycle, 'handoff', token)} 暂不继续业务，等待恢复指令。`;
}
export function restorePrompt(root, cycle, token) {
  return `开始加载上文，Cooperation 维护流程 ${cycle.id}。请读取 ${cycle.handoffPath} 和接续所需的必要文件，恢复目标、约束、已完成事项和下一步。交付文档已校验保存，请保持其内容不变。保留原模型、思考强度和权限。不要推进原业务任务。准备好后，${receiptInstruction(root, cycle, 'restored', token)} 等待系统释放消息或发送继续工作。`;
}
export function continuePrompt(cycle) {
  return `Cooperation 上下文维护 ${cycle.id} 已完成。继续工作：根据 ${cycle.handoffPath} 接续刚才暂停的原任务，先复查中断操作，避免重复已完成的副作用。随后按时间顺序处理收到的协作消息。`;
}
