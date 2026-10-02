export function setupRestartConfirmation({ post, toast }) {
  const $ = id => document.getElementById(id), dialog = $('restart-dialog'), badge = $('restart-review');
  let items = [], bootId, signature = '', busy = false, revision = 0;
  const dismissed = new Set();
  const token = item => `${item.bootId}:${item.id}:${item.revision}`;
  const payload = selected => ({ bootId, items: selected.map(({ id, revision }) => ({ id, revision })) });
  function show() { if (!dialog.open && !document.querySelector('dialog[open]')) { dialog.showModal(); $('restart-later').focus(); } }
  function render() {
    badge.hidden = !items.length; badge.textContent = `待确认接续 ${items.length}`;
    const next = JSON.stringify([bootId, items]); if (signature === next) return;
    const selected = new Map([...$('restart-items').querySelectorAll('input')].map(input => [input.value, input.checked]));
    const focused = $('restart-items').contains(document.activeElement) ? document.activeElement.value : null;
    signature = next; const rows = [];
    for (const item of items) {
      const row = document.createElement('label'); row.className = 'restart-item';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = item.id; checkbox.checked = selected.get(item.id) ?? true;
      const body = document.createElement('span'), heading = document.createElement('strong'), description = document.createElement('span'), path = document.createElement('small');
      heading.textContent = `${({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' })[item.session.client] || item.session.client} · ${item.session.name || item.session.id}`;
      description.textContent = item.work.map(w => w.label).join('；') + (item.connected ? '。' : '。等待原会话连接。');
      path.textContent = item.session.cwd || item.session.id; body.append(heading, description, path); row.append(checkbox, body); rows.push(row);
    }
    $('restart-items').replaceChildren(...rows);
    if (focused) [...$('restart-items').querySelectorAll('input')].find(input => input.value === focused)?.focus();
    $('restart-approve').disabled = busy || !items.length;
    if (!items.length && dialog.open) dialog.close();
  }
  async function decide(action, selected) {
    if (busy || !selected.length) return;
    busy = true; revision++; $('restart-approve').disabled = true; $('restart-later').disabled = true; $('restart-error').hidden = true;
    try {
      const result = await post('/api/restart-confirmation', { ...payload(selected), action });
      items = result.restartConfirmations; bootId = result.bootId; signature = ''; render();
      if (action === 'approve') toast('已确认；连接、额度及原任务核验通过后接续');
    } catch (error) { $('restart-error').textContent = error.message; $('restart-error').hidden = false; }
    finally { busy = false; revision++; $('restart-approve').disabled = !items.length; $('restart-later').disabled = false; }
  }
  function later() {
    if (busy) return;
    const selected = [...items]; selected.forEach(item => dismissed.add(token(item)));
    dialog.close(); void decide('defer', selected);
  }
  badge.addEventListener('click', show);
  $('restart-later').addEventListener('click', later);
  dialog.addEventListener('cancel', event => { event.preventDefault(); later(); });
  $('restart-form').addEventListener('submit', event => {
    event.preventDefault();
    const selected = new Set([...$('restart-items').querySelectorAll('input:checked')].map(input => input.value));
    if (!selected.size) { $('restart-error').textContent = '请选择要接续的会话，或选择稍后处理。'; $('restart-error').hidden = false; return; }
    void decide('approve', items.filter(item => selected.has(item.id)));
  });
  return {
    revision: () => revision,
    update(result, requestedRevision = revision) {
      if (busy || requestedRevision !== revision) return;
      items = result.restartConfirmations || []; bootId = result.bootId; render();
      if (items.some(item => item.status === 'pending' && !dismissed.has(token(item)))) show();
    },
  };
}
