export const clientName = client => ({ codex: 'Codex', claude: 'Claude', opencode: 'OpenCode' })[client] || client;
export const addressOf = session => session.client + ':' + (session.client === 'opencode' ? session.id : session.id.toLowerCase());
export const autoCompressEnabled = policy => policy?.enabled === true && policy?.mode === 'automatic';

const panelAnimations = new Map();
// Only explicit navigation calls this. Polling must not animate reading content.
export function revealPanel(element) {
  if (!element) return;
  const previous = panelAnimations.get(element), current = previous && getComputedStyle(element);
  const from = current ? { opacity: current.opacity, transform: current.transform } : null;
  previous?.cancel(); panelAnimations.delete(element);
  if (document.documentElement.dataset.motionInput === 'keyboard' || !element.getClientRects().length || !element.animate) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tokens = getComputedStyle(document.documentElement);
  const animation = element.animate([
    reduced ? { opacity: from?.opacity || .65 } : from || { opacity: .65, transform: 'translateY(6px)' },
    reduced ? { opacity: 1 } : { opacity: 1, transform: 'translateY(0)' },
  ], { duration: parseFloat(tokens.getPropertyValue(reduced ? '--motion-fade' : '--motion-panel')) || 180,
    easing: tokens.getPropertyValue('--ease-out').trim() || 'cubic-bezier(0.23, 1, 0.32, 1)' });
  animation.id = 'cooperation-panel'; panelAnimations.set(element, animation);
  animation.finished.catch(() => {}).finally(() => { if (panelAnimations.get(element) === animation) panelAnimations.delete(element); });
}

export function syncTabIndicator({ animate = true } = {}) {
  const tabs = document.querySelector('.workspace-tabs'), indicator = document.getElementById('workspace-tab-indicator');
  const selected = tabs?.querySelector('[aria-selected="true"]');
  if (!indicator || !selected) return;
  const transform = `translateX(${selected.offsetLeft}px) scaleX(${selected.offsetWidth})`;
  if (indicator.style.transform === transform) return;
  if (!animate) indicator.style.transition = 'none';
  indicator.style.transform = transform; tabs.classList.add('motion-ready');
  if (!animate) { void indicator.offsetWidth; indicator.style.removeProperty('transition'); }
}

export function setupMotion() {
  const html = document.documentElement;
  html.dataset.motionInput = 'pointer';
  document.addEventListener('pointerdown', () => { html.dataset.motionInput = 'pointer'; }, { capture: true, passive: true });
  document.addEventListener('keydown', event => {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
    html.dataset.motionInput = 'keyboard';
    for (const animation of panelAnimations.values()) animation.cancel(); panelAnimations.clear();
  }, { capture: true });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  reduced.addEventListener('change', () => { for (const animation of panelAnimations.values()) animation.cancel(); panelAnimations.clear(); });
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => syncTabIndicator({ animate: false }));
    for (const node of document.querySelectorAll('.workspace-tabs,.workspace-tabs button')) observer.observe(node);
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  }
  syncTabIndicator({ animate: false });
}

// Keep live DOM nodes while refreshed data changes. In particular, a polling
// response must not replace the text that someone is selecting or copying.
export function reconcileChildren(parent, incoming) {
  const key = node => node.nodeType === 1 ? node.dataset.renderKey || node.dataset.address || node.id || null : null;
  const focused = parent.contains(document.activeElement) ? document.activeElement : null;
  const selection = window.getSelection(), selected = selection?.rangeCount && parent.contains(selection.anchorNode) && parent.contains(selection.focusNode)
    ? { anchor: selection.anchorNode, start: selection.anchorOffset, focus: selection.focusNode, end: selection.focusOffset,
      anchorText: selection.anchorNode.textContent, focusText: selection.focusNode.textContent } : null;
  function update(container, incomingNodes) {
    const desired = [...incomingNodes], previous = [...container.childNodes], used = new Set();
    const keyed = new Map(previous.filter(key).map(node => [key(node), node]));
    let cursor = container.firstChild;
    for (const next of desired) {
      const id = key(next);
      let current = id ? keyed.get(id) : previous.find(node => !used.has(node) && !key(node) && node.nodeType === next.nodeType && node.nodeName === next.nodeName);
      if (!current || current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) current = next;
      else if (current.nodeType === 3) { if (current.data !== next.data) current.data = next.data; }
      else if (current.nodeType === 1) {
        for (const attr of [...current.attributes]) {
          if (attr.name === 'data-ui-busy' || attr.name === 'open' && current.tagName === 'DETAILS' || attr.name === 'disabled' && current.dataset.uiBusy) continue;
          if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
        }
        for (const attr of next.attributes) if (!(attr.name === 'disabled' && current.dataset.uiBusy) && current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
        current.onclick = next.onclick;
        update(current, next.childNodes);
      }
      used.add(current);
      if (current !== cursor) container.insertBefore(current, cursor);
      cursor = current.nextSibling;
    }
    for (const node of [...container.childNodes]) if (!used.has(node)) node.remove();
  }
  update(parent, incoming);
  if (focused && document.activeElement !== focused && focused.isConnected) focused.focus({ preventScroll: true });
  else if (focused && !focused.isConnected && document.activeElement === document.body) {
    const fallback = parent.querySelector('[role="status"],.cycle-title,button,a[href]');
    if (fallback) { if (fallback.tabIndex < 0) fallback.tabIndex = -1; fallback.focus({ preventScroll: true }); }
  }
  if (selected && (selection.anchorNode !== selected.anchor || selection.anchorOffset !== selected.start || selection.focusNode !== selected.focus || selection.focusOffset !== selected.end)
    && selected.anchor.isConnected && selected.focus.isConnected && selected.anchor.textContent === selected.anchorText && selected.focus.textContent === selected.focusText)
    selection.setBaseAndExtent(selected.anchor, selected.start, selected.focus, selected.end);
}
export function openCodeContextState(session) {
  if (session.client !== 'opencode') return null;
  const sample = session.monitoring, runtime = sample?.runtime, usage = sample?.usage;
  if (session.missing || runtime?.connected === false) return { label: 'OpenCode 未连接', detail: '等待该会话所属的 OpenCode 后端重新连接。' };
  if (!runtime) return { label: '等待上下文状态', detail: '正在读取这个 OpenCode 会话的状态。' };
  // Legacy bridges explicitly return usage:null and lack passiveUsage. A live
  // message connection alone does not mean the loaded plugin can read usage.
  if (!usage && runtime.connected === true && runtime.capabilities?.passiveUsage !== true)
    return { label: '插件需要重新加载', detail: '更新尚未在这个会话中生效。等当前任务结束后，重新打开 OpenCode 和原会话。' };
  if (runtime.usageState === 'query_failed') return { label: '上下文读取失败', detail: '暂时无法读取用量。点击“更新状态”重试；会话仍保持连接。' };
  if (!Number.isFinite(usage?.usedTokens)) return { label: '等待原生回复统计', detail: '收到这个会话的回复用量后，百分比会自动更新。' };
  if (!(usage.contextWindowTokens > 0)) return { label: '模型容量未知', detail: '模型尚未提供上下文容量，收到完整统计后会自动显示百分比。' };
  return { label: '上下文已接入', detail: runtime.capabilities?.automaticMaintenance === true
    ? '开启自动管理后，会按本会话的设置保存进度、整理上下文并恢复任务。'
    : '自动维护暂未就绪。请在任务结束后重新打开 OpenCode，使更新生效。' };
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
  if (connected) return result('connected', '已连接 ' + connected + ' 个', client === 'claude' && members.some(s => s.monitoring?.runtime?.requiresReopen) ? 'claude_reopen' : 'ready', connected);
  if (client === 'claude' && !directory?.claudeControlEnabled && !members.some(allowed)) return result('disconnected', '未接入', 'claude_access');
  if (!members.length) return result('disconnected', '未连接', 'no_sessions');
  if (members.every(s => !s.monitoring || stale(s.monitoring))) return result('checking', '待确认', 'checking');
  return result('disconnected', '未连接', client + '_session');
}

export { connectionGuidance } from './connection-guidance.mjs';

export function sessionConnected(session, options = {}) {
  return directoryConnection({ ...options, client: session.client, sessions: [session] }).connected === 1;
}
