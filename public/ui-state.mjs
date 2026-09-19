export const clientName = client => ({ codex: 'Codex', claude: 'Claude', opencode: 'OpenCode' })[client] || client;
export const addressOf = session => session.client + ':' + (session.client === 'opencode' ? session.id : session.id.toLowerCase());
export const autoCompressEnabled = policy => policy?.enabled === true && policy?.mode === 'automatic';
export function openCodeContextState(session) {
  if (session.client !== 'opencode') return null;
  const sample = session.monitoring, runtime = sample?.runtime, usage = sample?.usage;
  if (session.missing || runtime?.connected === false) return { label: 'OpenCode 未连接', detail: '等待该会话所属的 OpenCode 后端重新连接。' };
  if (!runtime) return { label: '等待上下文状态', detail: '正在检查原生 OpenCode 插件的上下文读取能力。' };
  // Legacy bridges explicitly return usage:null and lack passiveUsage. A live
  // message connection alone does not mean the loaded plugin can read usage.
  if (!usage && runtime.connected === true && runtime.capabilities?.passiveUsage !== true)
    return { label: '插件需要重新加载', detail: '当前 OpenCode 后端仍加载旧版 Cooperation 插件。请在当前任务结束后重启该后端，再打开这个已有会话。刷新管理网页或重启 Cooperation 服务不会重新加载原生插件。' };
  if (runtime.usageState === 'query_failed') return { label: '上下文读取失败', detail: '原生上下文查询失败。可点击“刷新状态”重试；会话连接仍然有效。' };
  if (!Number.isFinite(usage?.usedTokens)) return { label: '等待原生回复统计', detail: '插件已支持上下文读取，尚未取得有效的单次回复 token 统计。原生回复记录用量后会自动更新。' };
  if (!(usage.contextWindowTokens > 0)) return { label: '模型容量未知', detail: '已读取 token 用量，但原生模型目录尚未提供对应模型的上下文容量，暂时无法计算百分比。' };
  return { label: '上下文已接入', detail: runtime.capabilities?.automaticMaintenance === true
    ? '支持交付、原生压缩和恢复上下文。开启自动压缩后按本会话阈值执行；有子任务、权限请求或新输入时等待处理。'
    : runtime.maintenanceError || '当前插件尚未提供维护能力。请在任务结束后加载新版插件，再刷新状态。' };
}
export function projectMembers(project, sessions, mode = 'directories') {
  if (!project) return [];
  if (mode === 'directories') return sessions.filter(s => s.directoryIds?.includes(project.id));
  const current = new Map(sessions.map(s => [addressOf(s), s]));
  return (project.members || []).map(saved => current.get(addressOf(saved)) || { ...saved, missing: true, live: false, status: 'offline', directoryIds: [] });
}
export function workspaceAddresses({ project, sessions, mode, selectedAddress = null, query = '', onlyConnected = false, directories = [], bridge, online = true }) {
  const needle = query.trim().toLocaleLowerCase();
  return new Set(projectMembers(project, sessions, mode).filter(s => (!selectedAddress || addressOf(s) === selectedAddress)
    && (!needle || [s.name, s.id, s.cwd, clientName(s.client)].some(v => String(v || '').toLocaleLowerCase().includes(needle)))
    && (!onlyConnected || !s.missing && sessionConnected(s, { directory: directories.find(d => d.id === s.directoryIds?.[0]), bridge, online })))
    .map(addressOf));
}
export function visibleAddresses(directories, sessions, expandedDirectories, expandedClients, query = '', connectionFilter = {}) {
  const needle = query.trim().toLocaleLowerCase(), visible = new Set();
  for (const directory of directories) {
    if (!expandedDirectories.has(directory.id)) continue;
    for (const client of ['claude', 'codex', 'opencode']) {
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
  return result('disconnected', '未连接', client + '_session');
}

export function connectionGuidance({ client, directory = null, status, installationDirectory = '' }) {
  const install = installationDirectory.replaceAll('\\', '/').replace(/\/+$/, '');
  const title = '连接 ' + clientName(client);
  const scope = directory?.path || 'Codex 消息连接（所有目录共用）';
  if (status.reason === 'service_offline') return { title, scope, summary: '管理服务当前未连接。', steps: [
    { title: '启动管理服务', text: '双击 Cooperation 安装目录中的“启动项目.cmd”，再打开它显示的管理页。' },
    { title: '重新检查', text: '服务恢复后，点击下方“重新检查”。' },
  ] };
  if (status.reason === 'directory_error') return { title, scope, summary: '这个目录目前无法访问。', steps: [
    { title: '确认目录位置', text: '检查目录是否存在，以及所在磁盘或网络位置是否可用；路径已变化时，在左侧重新添加正确目录。' },
  ] };
  const count = status.connected ? '已发现 ' + status.total + ' 个会话，其中 ' + status.connected + ' 个已连接。已连接的会话无需重新设置。' : '';
  if (client === 'opencode') return { title, scope, summary: count || '等待该工作目录原生 OpenCode 后端中的 Cooperation 插件。', steps: [
    { title: '加载项目插件', text: '首次按 docs/OPENCODE.md 接入 Cooperation 插件。全局接入后，在管理台添加项目目录，保持管理服务运行，再打开该目录的 OpenCode；插件会跟随已添加的目录。已启动的后端需等任务结束后重新打开。' },
    { title: '确认接收方式', text: 'OpenCode 使用原生 user 消息接收协作内容，需要显式启用 acceptUserMessages。消息保留来源，不授予新的工作权限。' },
    { title: '使用同一后端', text: '在 TUI 或桌面实际使用的后端加载插件；独立启动的 serve 不代表当前工作会话。完成后点击重新检查。' },
  ], note: '当前开放通信与活动观察。上下文用量、自动维护和原生界面验收状态见接入文档。' };
  if (client === 'claude') {
    const wrapper = install ? install + '/bin/claude-wrapper.exe' : '<Cooperation安装目录>/bin/claude-wrapper.exe';
    const build = install ? "& '" + (install + '/scripts/build-claude-wrapper.ps1').replaceAll("'", "''") + "'" : '.\\scripts\\build-claude-wrapper.ps1';
    return { title, scope,
      summary: count || (status.reason === 'claude_access' ? '尚未允许该工作目录接入 Claude。' : status.reason === 'checking' ? '尚未取得最新连接状态，可以先重新检查。' : '目录已允许接入，但还没有检测到可用的 Claude 会话连接。'),
      steps: [
        { title: '首次使用：构建接入程序', text: '在 PowerShell 中运行；已构建且安装位置未变化时可跳过。', code: build, copyLabel: '复制构建命令' },
        { title: '设置 VS Code', text: '在 VS Code 的用户设置 JSON 中合并这一项，保留其他设置。', code: '"claudeCode.claudeProcessWrapper": ' + JSON.stringify(wrapper), copyLabel: '复制设置项' },
        { title: '允许工作目录接入', text: '打开目录旁的“项目设置”，开启“Claude 控制接入”。原生会话实际接入后才会显示已连接。' },
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
