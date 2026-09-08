'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { directory: '', recursive: false, directories: [], selectedDirectories: new Set(), expanded: new Set(), config: null, sessions: [], messages: [], sessionClient: 'all', selectedId: null, sessionRequest: 0, messageRequest: 0, events: null, debounce: null, toastTimer: null, loadingSessions: false };
  const clients = { codex: 'Codex', claude: 'Claude' };
  const statuses = { pending: '正在提交', submitted: '已提交', queued: '已排队', held: '已保留', unknown: '待确认', failed: '发送失败' };
  const activityNames = { idle: '空闲', running: '工作中', waiting_permission: '等待权限', waiting_input: '等待答复', initializing: '正在初始化', unloaded: '未加载', offline: '离线', unknown: '状态待确认' };
  const phaseNames = { interrupting: '暂停业务', writing_handoff: '保存交付文档', awaiting_handoff_end: '等待交付轮次结束', compacting: '原生压缩', restoring: '加载上文', awaiting_restore_end: '等待恢复轮次结束', needs_attention: '需要处理', user_intervened: '检测到用户介入', completed: '维护已完成', cancelled: '维护已取消' };
  const liveStatusWarning = 'Codex history metadata does not report whether a conversation is currently running; live status is unknown.';

  function singleLine(value, maxLength = 120) {
    const line = String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
    return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
  }

  function sessionName(session) {
    return singleLine(session?.name || '未命名会话');
  }

  function sessionStatus(session) {
    if (session.monitoring?.runtime?.activity) return activityNames[session.monitoring.runtime.activity] || '状态待确认';
    if (session.live) return '已打开';
    if (session.status === 'offline' || session.status === 'closed') return '历史会话';
    return '状态未知';
  }

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }

  function address(participant) {
    if (!participant) return '未知会话';
    return `${singleLine(participant.client || 'unknown', 24)}://${sessionName(participant)}:${singleLine(participant.id || '', 100)}`;
  }

  function time(value, full = false) {
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) return '时间未知';
    return new Intl.DateTimeFormat('zh-CN', full ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false } : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }

  async function request(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { Accept: 'application/json', ...options.headers }, cache: 'no-store' });
    let data;
    try { data = await response.json(); } catch { throw new Error(`服务返回了无法解析的响应（${response.status}）。`); }
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `请求失败（${response.status}）。`);
    return data;
  }
  const post = (path, value) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Coop-UI': state.config.csrfToken }, body: JSON.stringify(value) });
  function renderDirectories() {
    $('directory-list').replaceChildren();
    for (const directory of state.directories) {
      const chip = element('div', 'directory-chip');
      const label = element('label'); const input = element('input'); input.type = 'checkbox'; input.checked = state.selectedDirectories.has(directory.id);
      input.addEventListener('change', () => { input.checked ? state.selectedDirectories.add(directory.id) : state.selectedDirectories.delete(directory.id); refreshAll(); });
      label.append(input, element('span', '', directory.path), element('small', '', directory.recursive ? '含子目录' : '当前层'));
      const remove = element('button', 'remove-directory', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `移除目录 ${directory.path}`);
      remove.addEventListener('click', async () => { try { const result = await post('/api/directories/remove', { id: directory.id }); state.directories = result.directories; state.selectedDirectories.delete(directory.id); renderDirectories(); refreshAll(); } catch (error) { showToast(error.message); } });
      const controlLabel = element('label', 'directory-control'); const control = element('input'); control.type = 'checkbox'; control.checked = directory.claudeControlEnabled === true;
      control.setAttribute('aria-label', `允许 ${directory.path} 的 Claude 控制接入`);
      controlLabel.title = '仅精确匹配本目录；在已配置的官方启动器下，重开 Claude 会话后生效。';
      controlLabel.append(control, document.createTextNode('Claude 控制'));
      control.addEventListener('change', async () => { control.disabled = true; try { const result = await post('/api/directories/claude-control', { id: directory.id, enabled: control.checked }); state.directories = result.directories; renderDirectories(); showToast(result.detail); await loadSessions(); } catch (error) { control.checked = !control.checked; showToast(error.message); } finally { control.disabled = false; } });
      chip.append(label, controlLabel, remove); $('directory-list').append(chip);
    }
    $('directory-scope').textContent = `已选择 ${state.selectedDirectories.size} / ${state.directories.length} 个目录 · 跨目录消息一并展示`;
  }
  function managementPanel(session) {
    const details = element('details', 'management-panel'); details.open = state.expanded.has(session.address);
    details.addEventListener('toggle', () => { details.open ? state.expanded.add(session.address) : state.expanded.delete(session.address); });
    details.append(element('summary', '', '上下文管理'));
    const usage = element('p', 'usage-line'); usage.dataset.field = 'usage';
    const meta = element('p', 'runtime-meta'); meta.dataset.field = 'runtime';
    const decision = element('p', 'decision-note'); decision.dataset.field = 'decision';
    const read = element('button', 'text-button', '读取当前状态'); read.type = 'button';
    read.addEventListener('click', async () => {
      read.disabled = true; read.textContent = '正在读取…';
      try { session.monitoring = await post('/api/runtime', { address: session.address, native: true }); updateManagement(); }
      catch (error) { showToast(error.message); }
      finally { read.disabled = false; read.textContent = '读取当前状态'; }
    });
    const policy = { enabled: false, mode: 'observe', ...state.config.policyDefaults[session.client], ...session.policy };
    const form = element('form', 'policy-form');
    const enabled = element('input'); enabled.type = 'checkbox'; enabled.checked = policy.enabled;
    const enabledLabel = element('label', 'policy-enabled'); enabledLabel.append(enabled, document.createTextNode('启用此会话'));
    const mode = element('select'); mode.setAttribute('aria-label', `${sessionName(session)} 的管理模式`);
    for (const [value, title] of [['observe', '只观察触发条件'], ['automatic', '自动维护']]) { const option = element('option', '', title); option.value = value; mode.append(option); }
    mode.value = policy.mode;
    const grid = element('div', 'policy-grid');
    const fields = {};
    for (const [key, title] of [['softPercent', '空闲阈值 %'], ['hardPercent', '强停阈值 %']]) {
      const label = element('label', '', title); const input = element('input'); input.type = 'number'; input.min = '0.01'; input.max = '99.99'; input.step = '0.01'; input.required = true; input.value = policy[key];
      input.setAttribute('aria-label', `${sessionName(session)} ${title}`); label.append(input); grid.append(label); fields[key] = input;
    }
    const save = element('button', 'button', '保存此会话策略'); save.type = 'submit';
    form.append(enabledLabel, mode, grid, save);
    form.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true;
      try { const result = await post('/api/policies', { address: session.address, policy: { enabled: enabled.checked, mode: mode.value, softPercent: Number(fields.softPercent.value), hardPercent: Number(fields.hardPercent.value) } }); session.policy = result.policy; showToast('已保存，仅应用于此会话'); await loadMonitoring(); }
      catch (error) { showToast(error.message); } finally { save.disabled = false; }
    });
    const controls = element('div', 'cycle-controls'); controls.dataset.field = 'cycle';
    details.append(usage, meta, read, form, decision, controls); return details;
  }
  function updateManagement() {
    for (const item of $('session-list').children) {
      const session = state.sessions.find(s => s.address === item.dataset.address); if (!session) continue;
      const sample = session.monitoring, runtime = sample?.runtime, usage = sample?.usage;
      const activityLabel = item.querySelector('[data-field="activity-label"]');
      if (activityLabel) activityLabel.textContent = sessionStatus(session);
      const used = Number.isFinite(usage?.usedTokens) ? usage.usedTokens.toLocaleString() : '—';
      const capacity = usage?.contextWindowTokens > 0 ? usage.contextWindowTokens.toLocaleString() : '容量未知';
      const percent = Number.isFinite(usage?.usedTokens) && usage?.contextWindowTokens > 0 ? (usage.usedTokens * 100 / usage.contextWindowTokens).toFixed(2) + '%' : '—';
      item.querySelector('[data-field="usage"]').textContent = usage ? `${percent} · ${used} / ${capacity} tokens` : '尚未读取上下文';
      item.querySelector('[data-field="runtime"]').textContent = runtime ? `${activityNames[runtime.activity] || '状态待确认'} · ${runtime.model || usage?.model || '模型待确认'}\n用量观测：${time(usage?.measuredAt || usage?.queriedAt, true)}` : '点击读取当前状态，查看原生会话的用量与活动状态。';
      item.querySelector('[data-field="decision"]').textContent = sample?.error || (runtime && !runtime.connected ? runtime.detail : null) ||
        (session.client === 'claude' && session.controlAccess?.directoryEnabled === false ? session.controlAccess.detail : null) || sample?.decision?.reason || '默认关闭；启用后可先观察触发条件。';
      const controls = item.querySelector('[data-field="cycle"]'); controls.replaceChildren();
      const cycle = session.cycle;
      if (cycle) {
        controls.append(element('p', 'cycle-phase', `${phaseNames[cycle.state] || cycle.state} · 排队 ${session.queueCount || 0} 条`));
        if (cycle.reason) controls.append(element('p', 'cycle-reason', cycle.reason));
        const actions = [['cancel-release', '取消维护并释放消息'], ['cancel-hold', '取消维护并保留消息']];
        if (['needs_attention', 'user_intervened'].includes(cycle.state)) actions.unshift(['reconcile', '核对原生状态后继续']);
        if (['writing_handoff', 'restoring'].includes(cycle.previousState) && ['needs_attention', 'user_intervened'].includes(cycle.state)) actions.unshift(['retry', '重新发送交付／恢复请求']);
        else if (['not_submitted', 'failed'].includes(cycle.lastAttemptOutcome)) actions.unshift(['retry', '重试已失败步骤']);
        for (const [action, title] of actions) {
          const button = element('button', 'text-button', title); button.type = 'button';
          button.addEventListener('click', async () => { button.disabled = true; try { await post('/api/cycles/action', { id: cycle.id, action }); await loadMonitoring(); await loadMessages({ silent: true }); } catch (error) { showToast(error.message); } finally { button.disabled = false; } }); controls.append(button);
        }
      } else if (session.queueCount > 0) controls.append(element('p', 'cycle-phase', `待处理消息 ${session.queueCount} 条`));
      else if (session.lastCycle) controls.append(element('p', 'cycle-phase', phaseNames[session.lastCycle.state] || session.lastCycle.state));
      if (session.queueState?.held) {
        const release = element('button', 'text-button', `释放 ${session.queueState.held} 条保留消息`); release.type = 'button';
        release.addEventListener('click', async () => { try { await post('/api/queue/release', { address: session.address }); await loadMonitoring(); loadMessages({ silent: true }); } catch (error) { showToast(error.message); } }); controls.append(release);
      }
    }
  }
  async function loadMonitoring() {
    try {
      const result = await request('/api/monitoring');
      for (const sample of result.sessions) {
        const session = state.sessions.find(s => s.client === sample.session.client && s.id === sample.session.id);
        if (session) { session.monitoring = sample; session.policy = sample.policy; session.cycle = sample.cycle; session.lastCycle = sample.lastCycle; session.queueCount = sample.queueCount; session.queueState = sample.queueState; }
      }
      updateManagement();
    } catch { /* The connection banner already reports service disconnection. */ }
  }

  function showToast(message) {
    clearTimeout(state.toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600);
  }

  async function copy(text, label) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const input = element('textarea');
        input.value = text;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.append(input);
        input.select();
        const ok = document.execCommand('copy');
        input.remove();
        if (!ok) throw new Error('copy failed');
      }
      showToast(`已复制${label}`);
    } catch { showToast('复制未成功，请选中文本后手动复制。'); }
  }

  function empty(id, title, description, error = false) {
    const node = $(id);
    node.hidden = false;
    node.classList.toggle('error', error);
    node.querySelector('p').textContent = title;
    node.querySelector('span').textContent = description;
  }

  function setGlobalError(message) {
    $('global-error').textContent = message || '';
    $('global-error').hidden = !message;
  }

  function badge(status) {
    const safeStatus = Object.hasOwn(statuses, status) ? status : 'unknown';
    return element('span', `status-badge ${safeStatus}`, statuses[safeStatus]);
  }

  function renderSessions() {
    const query = $('session-search').value.trim().toLocaleLowerCase();
    const sessions = state.sessions.filter((session) => (state.sessionClient === 'all' || session.client === state.sessionClient) && `${session.name || ''} ${session.id || ''}`.toLocaleLowerCase().includes(query));
    $('session-count').textContent = String(sessions.length);
    $('session-list').replaceChildren();
    $('session-list').hidden = sessions.length === 0;
    $('session-state').hidden = sessions.length > 0;
    if (!sessions.length) {
      const filtered = query || state.sessionClient !== 'all';
      empty('session-state', filtered ? '没有匹配的会话' : '这个目录还没有会话', filtered ? '尝试其他名称、ID 或客户端。' : '在 Codex 或 Claude Code 中打开此项目的对话，然后刷新。');
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const session of sessions) {
      const item = element('li', 'session-item');
      item.dataset.address = session.address;
      const titleRow = element('div', 'session-title-row');
      const icon = element('span', `client-icon${session.client === 'claude' ? ' claude' : ''}`, session.client === 'claude' ? '✳' : '⌘');
      icon.setAttribute('aria-hidden', 'true');
      const title = element('h3', 'session-title', sessionName(session));
      title.title = sessionName(session);
      titleRow.append(icon, title);
      if (session.live) { const dot = element('span', 'live-dot'); dot.title = '已打开'; dot.setAttribute('aria-label', '已打开'); titleRow.append(dot); }
      const meta = element('div', 'session-meta');
      const activity = element('span', '', sessionStatus(session)); activity.dataset.field = 'activity-label';
      meta.append(element('span', '', clients[session.client] || singleLine(session.client, 24)), element('span', '', '·'), activity);
      meta.title = singleLine(session.cwd, 240);
      const id = element('code', 'session-id', session.id || '');
      id.title = singleLine(session.id, 100);
      const actions = element('div', 'session-actions');
      const copyAddress = element('button', 'copy-address', '复制通信地址');
      copyAddress.type = 'button';
      copyAddress.title = singleLine(address(session), 300);
      copyAddress.setAttribute('aria-label', `复制 ${sessionName(session)} 的通信地址`);
      copyAddress.addEventListener('click', () => copy(`${singleLine(session.client, 24)}://${sessionName(session)}:${session.id}`, '通信地址'));
      const copyId = element('button', 'copy-id', '复制 ID');
      copyId.type = 'button';
      copyId.setAttribute('aria-label', `复制 ${sessionName(session)} 的会话 ID`);
      copyId.addEventListener('click', () => copy(session.id, '会话 ID'));
      actions.append(copyAddress, copyId);
      item.append(titleRow, meta, id, actions, managementPanel(session));
      fragment.append(item);
    }
    $('session-list').append(fragment);
    updateManagement();
  }

  function resetDetail() {
    const placeholder = element('div', 'detail-placeholder');
    const mark = element('div', 'detail-placeholder-mark', '↗');
    mark.setAttribute('aria-hidden', 'true');
    mark.append(element('span', '', '↙'));
    placeholder.append(mark, element('h3', '', '每一次交接，都有记录'), element('p', '', '选择一条消息，查看完整内容、发送方与接收方。'), element('span', 'privacy-note', '仅展示经本工具传递的消息'));
    $('message-detail').replaceChildren(placeholder);
  }

  function renderDetail(message) {
    if (!message) { resetDetail(); return; }
    const content = element('div', 'detail-content');
    const top = element('div', 'detail-top');
    top.append(element('h3', '', '消息详情'), badge(message.status));
    const metadata = element('dl', 'detail-meta');
    for (const [label, value, className] of [['发送方', address(message.from), ''], ['接收方', address(message.to), ''], ['发送时间', time(message.createdAt, true), ''], ['消息 ID', message.id, 'monospace']]) {
      const row = element('div');
      row.append(element('dt', '', label), element('dd', className, value));
      metadata.append(row);
    }
    const body = element('pre', 'detail-body', message.text || '（空消息）');
    content.append(top, metadata, body);
    if (message.error) content.append(element('div', 'detail-error', typeof message.error === 'string' ? message.error : JSON.stringify(message.error)));
    const copyMessage = element('button', 'copy-address detail-copy', '复制消息内容');
    copyMessage.type = 'button';
    copyMessage.addEventListener('click', () => copy(message.text || '', '消息内容'));
    content.append(copyMessage);
    const notes = { submitted: '已提交到目标客户端；此状态不代表对方已阅读或处理。', queued: '消息已持久排队，维护完成后按顺序投递。', held: '消息按用户选择保留，等待在会话管理中释放。', pending: '正在向目标客户端提交消息。', unknown: '投递结果尚未确认。核对目标会话后，可选择以下处理方式。', failed: '消息发送失败，原因见上方记录。' };
    content.append(element('p', 'delivery-note', notes[message.status] || notes.unknown));
    if (message.detail) content.append(element('p', 'delivery-note', message.detail));
    if (message.status === 'unknown') {
      for (const [outcome, title] of [['submitted', '确认已送达，继续队列'], ['not_submitted', '确认未送达，重新发送']]) {
        const button = element('button', 'button resolve-message', title); button.type = 'button';
        button.addEventListener('click', async () => { button.disabled = true; try { await post('/api/messages/resolve', { id: message.id, outcome }); await loadMessages(); await loadMonitoring(); } catch (error) { showToast(error.message); } finally { button.disabled = false; } }); content.append(button);
      }
    }
    $('message-detail').replaceChildren(content);
  }

  function selectMessage(message) {
    state.selectedId = message.id;
    for (const button of $('message-list').querySelectorAll('button[data-id]')) {
      const selected = button.dataset.id === String(message.id);
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    renderDetail(message);
  }

  function renderMessages(total) {
    $('message-count').textContent = String(total ?? state.messages.length);
    $('history-summary').textContent = total > state.messages.length ? `显示最近 ${state.messages.length} 条，共 ${total} 条；名称保留发送时的记录。` : '消息中的会话名称保留发送时的记录。';
    $('message-list').replaceChildren();
    $('message-list').hidden = state.messages.length === 0;
    $('message-state').hidden = state.messages.length > 0;
    if (!state.messages.length) {
      const filtered = $('message-search').value.trim() || $('message-client').value !== 'all';
      empty('message-state', filtered ? '没有匹配的消息' : '还没有通信记录', filtered ? '调整搜索词或客户端筛选后重试。' : 'agent 通过此工具发送消息后，记录会自动显示在这里。');
      state.selectedId = null;
      resetDetail();
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const message of state.messages) {
      const row = element('li');
      const button = element('button', 'message-row');
      button.type = 'button';
      button.dataset.id = String(message.id);
      button.setAttribute('aria-pressed', String(state.selectedId === message.id));
      button.classList.toggle('selected', state.selectedId === message.id);
      button.setAttribute('aria-label', `${address(message.from)} 发送给 ${address(message.to)}，${time(message.createdAt, true)}`);
      const top = element('div', 'message-row-top');
      const stamp = element('time', 'message-time', time(message.createdAt));
      const date = new Date(message.createdAt);
      if (Number.isFinite(date.getTime())) stamp.dateTime = date.toISOString();
      top.append(stamp, badge(message.status));
      const from = element('div', 'message-route', address(message.from));
      from.title = singleLine(address(message.from), 300);
      const to = element('div', 'message-route to', `→ ${address(message.to)}`);
      to.title = singleLine(address(message.to), 300);
      button.append(top, from, to, element('p', 'message-preview', message.text || '（空消息）'));
      button.addEventListener('click', () => selectMessage(message));
      row.append(button);
      fragment.append(row);
    }
    $('message-list').append(fragment);
    const selected = state.messages.find((message) => message.id === state.selectedId);
    if (selected) renderDetail(selected);
    else { state.selectedId = null; resetDetail(); }
  }

  async function loadSessions() {
    const requestId = ++state.sessionRequest;
    state.loadingSessions = true;
    $('load-directory').disabled = true;
    $('refresh-all').disabled = true;
    $('session-list').hidden = true;
    $('sessions-title').setAttribute('aria-busy', 'true');
    empty('session-state', '正在载入会话', '读取此目录的本地会话信息…');
    $('warnings').hidden = true;
    $('session-status-note').hidden = true;
    try {
      const result = await post('/api/sessions', { directoryIds: [...state.selectedDirectories] });
      if (requestId !== state.sessionRequest) return;
      state.sessions = Array.isArray(result.sessions) ? result.sessions : [];
      renderSessions();
      const allWarnings = Array.isArray(result.warnings) ? result.warnings.map((warning) => typeof warning === 'string' ? warning : warning.message || JSON.stringify(warning)) : [];
      const warnings = allWarnings.filter((warning) => warning !== liveStatusWarning);
      $('session-status-note').hidden = !allWarnings.includes(liveStatusWarning) && !state.sessions.some((session) => session.client === 'codex' && !session.live && session.status === 'unknown');
      $('warnings').textContent = warnings.join('\n');
      $('warnings').hidden = warnings.length === 0;
    } catch (error) {
      if (requestId !== state.sessionRequest) return;
      state.sessions = [];
      $('session-count').textContent = '0';
      $('session-list').hidden = true;
      empty('session-state', '无法载入会话', error.message, true);
    } finally {
      if (requestId === state.sessionRequest) {
        state.loadingSessions = false;
        $('load-directory').disabled = false;
        $('refresh-all').disabled = false;
        $('sessions-title').removeAttribute('aria-busy');
      }
    }
  }

  async function loadMessages({ silent = false } = {}) {
    if (!state.config) return;
    const requestId = ++state.messageRequest;
    if (!silent && !state.messages.length) empty('message-state', '正在载入通信记录', '读取本地通信记录…');
    $('message-error').hidden = true;
    $('messages-title').setAttribute('aria-busy', 'true');
    const query = new URLSearchParams({ directoryIds: JSON.stringify([...state.selectedDirectories]), q: $('message-search').value.trim(), client: $('message-client').value });
    try {
      const result = await request(`/api/messages?${query}`);
      if (requestId !== state.messageRequest) return;
      state.messages = Array.isArray(result.messages) ? result.messages : [];
      renderMessages(result.total);
    } catch (error) {
      if (requestId !== state.messageRequest) return;
      if (state.messages.length) {
        $('message-error').textContent = `更新失败：${error.message}`;
        $('message-error').hidden = false;
      } else { empty('message-state', '无法载入通信记录', error.message, true); }
    } finally { if (requestId === state.messageRequest) $('messages-title').removeAttribute('aria-busy'); }
  }

  async function loadDirectory(directory) {
    if (!directory) return;
    setGlobalError('');
    try {
      const result = await post('/api/directories', { path: directory, recursive: $('recursive').checked });
      state.directories = result.directories; state.selectedDirectories.add(result.directory.id);
      $('directory').value = ''; await refreshAll();
    } catch (error) { setGlobalError(error.message); }
  }
  async function refreshAll() {
    renderDirectories();
    await Promise.allSettled([loadSessions(), loadMessages()]);
    await loadMonitoring();
  }

  function connectEvents() {
    if (!window.EventSource) { $('connection-label').textContent = '已连接 · 请手动刷新'; return; }
    state.events = new EventSource('/api/events');
    state.events.addEventListener('open', async () => {
      $('connection-dot').className = 'status-dot connected'; $('connection-label').textContent = '本地服务已连接'; document.querySelector('.realtime-indicator').hidden = false;
      try { const fresh = await request('/api/config'); state.config = { ...state.config, ...fresh }; } catch {}
    });
    state.events.addEventListener('error', () => { $('connection-dot').className = 'status-dot disconnected'; $('connection-label').textContent = '正在重新连接'; document.querySelector('.realtime-indicator').hidden = true; });
    let eventDebounce;
    state.events.addEventListener('message', () => { clearTimeout(eventDebounce); eventDebounce = setTimeout(() => loadMessages({ silent: true }), 180); });
    let managementDebounce;
    state.events.addEventListener('management', () => { clearTimeout(managementDebounce); managementDebounce = setTimeout(loadMonitoring, 200); });
  }

  $('directory-form').addEventListener('submit', (event) => { event.preventDefault(); if (state.config) loadDirectory($('directory').value.trim()); });
  $('refresh-all').addEventListener('click', refreshAll);
  $('session-search').addEventListener('input', () => { if (!state.loadingSessions) renderSessions(); });
  $('session-filters').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-client]');
    if (!button) return;
    state.sessionClient = button.dataset.client;
    for (const item of $('session-filters').querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === button));
    if (!state.loadingSessions) renderSessions();
  });
  $('message-search').addEventListener('input', () => { clearTimeout(state.debounce); state.debounce = setTimeout(() => loadMessages(), 250); });
  $('message-client').addEventListener('change', () => { clearTimeout(state.debounce); loadMessages(); });
  let monitoringTimer;
  window.addEventListener('pagehide', () => { state.events?.close(); clearInterval(monitoringTimer); });

  async function initialize() {
    $('load-directory').disabled = true;
    try {
      state.config = await request('/api/config');
      $('version').textContent = state.config.version ? `v${state.config.version}` : '';
      $('connection-dot').className = 'status-dot connected';
      $('connection-label').textContent = '本地服务已连接';
      $('load-directory').disabled = false;
      connectEvents();
      state.directories = state.config.directories || [];
      state.selectedDirectories = new Set(state.directories.map(directory => directory.id));
      await refreshAll(); monitoringTimer = setInterval(loadMonitoring, 5000);
    } catch (error) {
      $('connection-dot').className = 'status-dot disconnected';
      $('connection-label').textContent = '服务未连接';
      setGlobalError(`无法连接本地管理服务：${error.message} 请确认服务已启动后刷新页面。`);
      empty('session-state', '本地服务尚未连接', '启动服务后刷新此页面。', true);
      empty('message-state', '暂时无法读取记录', '启动服务后刷新此页面。', true);
    }
  }

  initialize();
})();
