const names = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
export function connectionGuidance({ client, directory = null, status }) {
  const app = names[client] || client;
  const base = { title: '连接 ' + (client === 'claude' ? 'Claude' : app), scope: directory?.label || directory?.path || '所有项目共用此连接',
    steps: [], primary: { action: 'recheck', label: '检查连接' }, note: '' };
  if (status.reason === 'service_offline') return { ...base, summary: 'Cooperation 暂时没有连接。', steps: [
    { title: '打开 Cooperation', text: '使用“启动项目”打开管理服务，随后回到这里检查连接。' },
  ] };
  if (status.reason === 'directory_error') return { ...base, summary: '找不到这个项目文件夹。', primary: { action: 'settings', label: '查看项目设置' },
    steps: [{ title: '确认项目位置', text: '检查文件夹所在的磁盘是否已连接；项目移动后，请添加它的新位置。' }] };
  if (status.reason === 'claude_reopen') return { ...base, summary: 'Claude 已连接，更新将在重新打开后生效。',
    steps: [{ title: '在合适时机重新打开面板', text: '等当前任务结束后，重新打开这个项目的 Claude 面板。Cooperation 会自动识别，无需重复设置。' }] };
  if (status.reason === 'ready') return { ...base, summary: status.connected ? `${status.connected} 个会话已连接，可以正常使用。` : `${app} 已连接，可以正常使用。`,
    primary: { action: 'done', label: '完成' } };
  if (client === 'claude' && status.reason === 'claude_access') return { ...base, summary: '这个项目尚未允许 Claude 连接。',
    primary: { action: 'settings', label: '打开项目设置' },
    steps: [{ title: '允许 Claude 连接', text: '在项目设置中打开“允许 Claude 连接”，然后在 VS Code 中打开这个项目的 Claude 面板。' }],
    note: directory?.recursive ? '子文件夹中的项目需要分别允许连接。' : '' };
  if (status.reason === 'checking') return { ...base, summary: '正在等待最新连接状态。',
    steps: [{ title: '保持会话打开', text: `请保持 ${app} 中的项目和会话打开，然后检查连接。` }] };
  if (client === 'claude') return { ...base, summary: '项目已允许连接，正在等待 Claude 面板。', steps: [
    { title: '打开项目中的会话', text: '在 VS Code 中打开这个项目，再打开要使用的 Claude 会话。' },
    { title: '仍未连接时重新打开面板', text: '等当前任务结束后，关闭并重新打开该 Claude 面板，然后检查连接。' },
  ] };
  if (client === 'codex') return { ...base,
    summary: status.reason === 'codex_bridge' ? '正在等待 Codex 连接。' : 'Codex 已就绪，请打开要使用的会话。',
    steps: [{ title: '打开 Codex 中的项目和会话', text: '保持 Codex 桌面应用打开，并进入这个项目中已有的会话。连接建立后会自动显示在这里。' },
      ...(status.reason === 'codex_bridge' ? [{ title: '需要时重新连接', text: '如果一直未连接，在 Codex 的连接设置中重新连接 Cooperation，然后回到这里检查。' }] : [])] };
  return { ...base, summary: '正在等待 OpenCode 中的项目会话。', steps: [
    { title: '打开对应项目', text: '在你平时使用的 OpenCode 中打开这个项目及已有会话，连接后这里会自动更新。' },
    { title: '更新后重新打开', text: '如果刚更新过 Cooperation，等当前任务结束后重新打开 OpenCode，再检查连接。' },
  ] };
}
