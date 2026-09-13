export const addressOf = session => session.client + ':' + session.id.toLowerCase();
export const autoCompressEnabled = policy => policy?.enabled === true && policy?.mode === 'automatic';
export function visibleAddresses(directories, sessions, expandedDirectories, expandedClients, query = '', connectionFilter = {}) {
  const needle = query.trim().toLocaleLowerCase(), visible = new Set();
  for (const directory of directories) {
    if (!expandedDirectories.has(directory.id)) continue;
    for (const client of ['claude', 'codex']) {
      if (!expandedClients.has(directory.id + ':' + client)) continue;
      for (const session of sessions) if (session.client === client && session.directoryIds?.includes(directory.id)
        && (!connectionFilter.onlyConnected || sessionConnected(session, { ...connectionFilter, directory }))
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

const connectionPath = value => String(value || '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
export function directoryConnection({ client, directory = null, sessions = [], bridge = null, online = true, now = Date.now() }) {
  const members = [...new Map(sessions.filter(s => s.client === client && (!directory || s.directoryIds?.includes(directory.id))).map(s => [addressOf(s), s])).values()];
  const result = (tone, label, reason, connected = 0) => ({ tone, label, reason, connected, total: members.length });
  if (!online) return result('disconnected', '服务离线', 'service_offline');
  if (directory?.error) return result('disconnected', '目录不可用', 'directory_error');
  if (client === 'codex' && !bridge?.connected) return result('disconnected', '未连接', 'codex_bridge');
  if (client === 'codex' && !directory) return result('connected', '已连接', 'ready');
  const allowed = session => client !== 'claude' || (connectionPath(session.cwd) === connectionPath(directory?.path)
    ? directory?.claudeControlEnabled === true : session.controlAccess?.directoryEnabled === true);
  const stale = sample => {
    const value = sample?.observedAt || sample?.runtime?.observedAt;
    return value && Number.isFinite(Date.parse(value)) && now - Date.parse(value) > 60000;
  };
  const connected = members.filter(s => allowed(s) && s.monitoring?.runtime?.connected === true
    && s.monitoring.runtime.controlsEnabled !== false && !stale(s.monitoring)).length;
  if (connected) return result('connected', '已连接 ' + connected + ' 个', 'ready', connected);
  if (client === 'claude' && !directory?.claudeControlEnabled && !members.some(allowed)) return result('disconnected', '未接入', 'claude_access');
  if (!members.length) return result('disconnected', '未连接', 'no_sessions');
  if (members.every(s => !s.monitoring || stale(s.monitoring))) return result('checking', '待确认', 'checking');
  return result('disconnected', '未连接', client === 'claude' ? 'claude_session' : 'codex_session');
}

export function connectionGuidance({ client, directory = null, status, installationDirectory = '' }) {
  const install = installationDirectory.replaceAll('\\', '/').replace(/\/+$/, '');
  const title = client === 'claude' ? '连接 Claude' : '连接 Codex';
  const scope = directory?.path || 'Codex 消息连接（所有目录共用）';
  if (status.reason === 'service_offline') return { title, scope, summary: '管理服务当前未连接。', steps: [
    { title: '启动管理服务', text: '双击 Cooperation 安装目录中的“启动项目.cmd”，再打开它显示的管理页。' },
    { title: '重新检查', text: '服务恢复后，点击下方“重新检查”。' },
  ] };
  if (status.reason === 'directory_error') return { title, scope, summary: '这个目录目前无法访问。', steps: [
    { title: '确认目录位置', text: '检查目录是否存在，以及所在磁盘或网络位置是否可用；路径已变化时，在左侧重新添加正确目录。' },
  ] };
  const count = status.connected ? '已发现 ' + status.total + ' 个会话，其中 ' + status.connected + ' 个已连接。已连接的会话无需重新设置。' : '';
  if (client === 'claude') {
    const wrapper = install ? install + '/bin/claude-wrapper.exe' : '<Cooperation安装目录>/bin/claude-wrapper.exe';
    const build = install ? "& '" + (install + '/scripts/build-claude-wrapper.ps1').replaceAll("'", "''") + "'" : '.\\scripts\\build-claude-wrapper.ps1';
    return { title, scope,
      summary: count || (status.reason === 'claude_access' ? '尚未允许该工作目录接入 Claude。' : status.reason === 'checking' ? '尚未取得最新连接状态，可以先重新检查。' : '目录已允许接入，但还没有检测到可用的 Claude 会话连接。'),
      steps: [
        { title: '首次使用：构建接入程序', text: '在 PowerShell 中运行；已构建且安装位置未变化时可跳过。', code: build, copyLabel: '复制构建命令' },
        { title: '设置 VS Code', text: '在 VS Code 的用户设置 JSON 中合并这一项，保留其他设置。', code: '"claudeCode.claudeProcessWrapper": ' + JSON.stringify(wrapper), copyLabel: '复制设置项' },
        { title: '允许工作目录接入', text: '在左侧该工作目录下勾选“Claude 控制”。勾选后仍需原生会话实际接入，才会显示已连接。' },
        { title: '重新打开 Claude 面板', text: '在 VS Code 中打开该项目；等当前任务结束后，关闭并重新打开对应 Claude 面板，再点击“重新检查”。' },
      ], note: directory?.recursive ? '包含子目录时，接入权限按实际工作目录分别设置，不会从父目录自动继承。已连接数量只统计本目录展示范围内的会话。' : '接入与自动压缩是两个独立开关。查看说明和重新检查不会重启会话或修改配置。',
    };
  }
  const config = '[mcp_servers.cooperation]\ncommand = "node"\nargs = ' + JSON.stringify([(install || '<Cooperation安装目录>') + '/bin/coop.mjs', 'mcp', '--client', 'codex'])
    + '\ntool_timeout_sec = 75\nenv_vars = ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_THREAD_ID", "CODEX_MCP_NODE_PATH"]';
  const bridgeMissing = status.reason === 'codex_bridge';
  return { title, scope,
    summary: bridgeMissing ? 'Codex 消息连接尚未就绪。完成一次 MCP 接入后，服务会自动保存并恢复连接。'
      : count || (directory ? 'Codex 消息连接已就绪；该目录下暂未检测到已打开的原生任务。' : 'Codex 消息连接已就绪。'),
    steps: [
      { title: '打开 Codex 桌面 App', text: directory ? '在 Codex 中打开该工作项目，以及希望连接的已有任务。' : '保持 Codex 桌面 App 打开。' },
      ...(bridgeMissing ? [
        { title: '首次使用：配置 Cooperation MCP', text: '将下方内容合并到 Codex 用户配置文件 ~/.codex/config.toml；也可放入受信任工作项目的 .codex/config.toml。', code: config, copyLabel: '复制 MCP 配置' },
        { title: '重新连接 MCP', text: '在 Codex 的 MCP 设置中重新连接 Cooperation。管理服务会自动更新连接，无需反复重启。' },
      ] : []),
      { title: '重新检查', text: '等待原生任务初始化完成，再点击下方“重新检查”。' },
    ], note: '消息连接由各目录共用；每个目录的“已连接”数量只统计其中已接入的原生任务，历史任务不必全部打开。',
  };
}


export function sessionConnected(session, options = {}) {
  return directoryConnection({ ...options, client: session.client, sessions: [session] }).connected === 1;
}
