import { revealPanel } from './ui-state.mjs';
import { applyMessageAffixes, renderPromptTemplate, validatePromptValues } from './prompt-templates.mjs';

const panels = [
  ['codex', 'Codex 消息'], ['claude', 'Claude 消息'], ['opencode', 'OpenCode 消息'],
  ['handoff', '交付文档'], ['restore', '恢复上下文'], ['continue', '继续任务'], ['quotaContinue', '额度恢复'],
];
const peer = key => ['codex', 'claude', 'opencode'].includes(key);
const $ = id => document.getElementById(id);
function node(tag, className, text) { const n = document.createElement(tag); n.className = className || ''; if (text !== undefined) n.textContent = text; return n; }

export function setupPromptEditor({ request, post, toast }) {
  const dialog = $('prompt-dialog'), form = $('prompt-form'), open = $('open-prompts');
  let data, draft, selected = 'codex', generation = 0, saving = false, undoSnapshot = null, saveIssue = '', lastField = null;
  const changed = () => Boolean(draft && data && JSON.stringify(draft) !== JSON.stringify(data.values));
  const error = text => { if ($('prompt-error').textContent !== text) $('prompt-error').textContent = text; $('prompt-error').hidden = !text; };
  const status = text => { if ($('prompt-save-status').textContent !== text) $('prompt-save-status').textContent = text; };
  function preview() {
    if (!draft) return;
    const item = peer(selected) ? draft.messages[selected] : null;
    const client = peer(selected) ? selected : $('prompt-preview-client').value;
    if (item) {
      let text = applyMessageAffixes('发送方：codex://示例会话:example-session\n发送方地址：codex:example-session\n消息编号：示例消息编号\n\n这里是原始消息正文。', item);
      if (selected === 'claude' && $('prompt-preview-mode').value === 'display' && item.label) text = item.label + '\n' + text;
      $('prompt-preview').textContent = text;
    } else {
      const sample = data.samples[client];
      $('prompt-preview').textContent = renderPromptTemplate(draft.maintenance[selected], { ...sample,
        checkpoint: selected === 'handoff' ? sample.handoffCheckpoint : selected === 'restore' ? sample.restoreCheckpoint : '' });
    }
    try {
      validatePromptValues(draft); error(saveIssue);
      $('save-prompts').disabled = saving || !changed();
      status(saving ? '保存中…' : changed() ? '有未保存修改 · 关闭后保留草稿' : '已保存 · 第 ' + data.revision + ' 版');
    } catch (e) { error(e.message); $('save-prompts').disabled = true; status('请修正提示词'); }
    $('prompt-discard').hidden = !changed(); $('prompt-discard').disabled = saving;
    $('prompt-undo').hidden = !undoSnapshot; $('prompt-undo').disabled = saving;
    if (undoSnapshot) $('prompt-undo').textContent = undoSnapshot.label;
  }
  function field(title, key, value, multiline = true, rows = 4) {
    const label = node('label', 'field-label', title), input = node(multiline ? 'textarea' : 'input', 'text-input prompt-input');
    input.id = 'prompt-' + key; label.htmlFor = input.id; input.value = value;
    if (multiline) input.rows = rows;
    else { input.type = 'text'; input.maxLength = 512; }
    input.spellcheck = false;
    const panel = selected;
    const rememberPosition = () => { lastField = { panel, id: input.id, start: input.selectionStart, end: input.selectionEnd }; };
    input.addEventListener('focus', rememberPosition); input.addEventListener('blur', rememberPosition);
    input.addEventListener('input', () => {
      undoSnapshot = null; saveIssue = ''; rememberPosition();
      if (peer(selected)) draft.messages[selected][key] = input.value;
      else draft.maintenance[selected] = input.value;
      preview();
    });
    $('prompt-fields').append(label, input);
    return input;
  }
  function render() {
    if (!draft) return;
    for (const button of $('prompt-navigation').children) { const active = button.dataset.panel === selected; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; }
    $('prompt-panel').setAttribute('aria-labelledby', 'prompt-tab-' + selected);
    $('prompt-fields').replaceChildren();
    $('prompt-section-title').textContent = panels.find(p => p[0] === selected)[1];
    const isPeer = peer(selected);
    $('prompt-preview-client-label').hidden = isPeer;
    $('prompt-preview-mode-label').hidden = selected !== 'claude';
    $('prompt-variables').hidden = isPeer;
    $('prompt-help').textContent = isPeer
      ? selected === 'codex' ? '前后缀会进入模型上下文；留空则不添加。Codex 原生的 codex_delegation 外层保持原样。'
        : selected === 'claude' ? '前后缀会进入模型上下文；显示标签只出现在 Claude 界面，留空可隐藏。'
          : '前后缀会进入模型上下文；留空可取消附加提示。发送方信息与原始正文会保留。'
      : selected === 'continue' ? '只在维护前正在执行任务时发送，空闲会话不会收到继续提示。'
        : selected === 'quotaContinue' ? '自动管理开启时，确认额度恢复后向原会话发送一次。发送前会核对轮次和设置是否改变。'
        : '内容可自由编辑。请保留 {{checkpoint}}，系统会在发送时填入正确的工具名、文档路径和回执参数。';
    if (isPeer) {
      field('消息前缀', 'prefix', draft.messages[selected].prefix, true, selected === 'opencode' ? 5 : 3);
      field('消息后缀', 'suffix', draft.messages[selected].suffix, true, 3);
      if (selected === 'claude') field('界面显示标签', 'label', draft.messages.claude.label, false);
    } else {
      const textarea = field('提示词内容', 'template', draft.maintenance[selected], true, 9);
      $('prompt-variable-buttons').replaceChildren();
      for (const name of selected === 'quotaContinue' ? ['sessionId', 'client'] : ['documentPath', 'cycleId', 'sessionId', 'client', ...(selected === 'continue' ? [] : ['checkpoint'])]) {
        const button = node('button', 'prompt-variable', '{{' + name + '}}'); button.type = 'button';
        button.addEventListener('click', () => { textarea.setRangeText(button.textContent, textarea.selectionStart, textarea.selectionEnd, 'end'); textarea.dispatchEvent(new Event('input')); textarea.focus(); });
        $('prompt-variable-buttons').append(button);
      }
    }
    preview();
  }
  for (const [key, title] of panels) {
    const button = node('button', 'prompt-tab', title); button.type = 'button'; button.id = 'prompt-tab-' + key; button.dataset.panel = key; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', 'prompt-panel');
    button.addEventListener('click', () => { const changed=selected!==key;selected = key; render();if(changed)revealPanel($('prompt-panel')); });
    button.addEventListener('keydown', event => {
      const index = panels.findIndex(p => p[0] === selected);
      const next = ['ArrowDown', 'ArrowRight'].includes(event.key) ? (index + 1) % panels.length
        : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? (index + panels.length - 1) % panels.length : event.key === 'Home' ? 0 : event.key === 'End' ? panels.length - 1 : null;
      if (next !== null) { event.preventDefault(); $('prompt-navigation').children[next].click(); $('prompt-navigation').children[next].focus(); }
    });
    $('prompt-navigation').append(button);
  }
  open.addEventListener('click', async () => {
    const current = ++generation;
    const focusEditor = () => { const position = lastField, input = position?.panel === selected ? $(position.id) : $('prompt-fields').querySelector('textarea,input');
      if (input && !saving) { input.focus({ preventScroll: true }); if (position?.panel === selected && input.id === position.id) input.setSelectionRange(position.start, position.end); } };
    if (draft && (changed() || undoSnapshot || saving)) {
      $('prompt-editor-body').disabled = saving; dialog.showModal(); render(); focusEditor(); return;
    }
    draft = null; data = null; saveIssue = '';
    error(''); status('正在读取…'); $('prompt-editor-body').disabled = true; $('save-prompts').disabled = true;
    $('prompt-discard').hidden = true; $('prompt-undo').hidden = true;
    $('prompt-fields').replaceChildren(); $('prompt-preview').textContent = ''; dialog.showModal();
    try {
      const result = await request('/api/prompt-settings');
      if (current !== generation || !dialog.open) return;
      data = result; draft = structuredClone(result.values); $('prompt-editor-body').disabled = false; render(); focusEditor();
    } catch (e) { if (current === generation && dialog.open) { error(e.message); status('读取失败'); } }
  });
  dialog.addEventListener('close', () => { generation++; });
  window.addEventListener('beforeunload', event => { if (changed()) { event.preventDefault(); event.returnValue = ''; } });
  const rememberUndo = label => { undoSnapshot = { values: structuredClone(draft), selected, label }; saveIssue = ''; toast(''); };
  $('prompt-reset-current').addEventListener('click', () => { if (!draft || saving) return; rememberUndo('撤销恢复默认'); if (peer(selected)) draft.messages[selected] = structuredClone(data.defaults.messages[selected]); else draft.maintenance[selected] = data.defaults.maintenance[selected]; render(); });
  $('prompt-reset-all').addEventListener('click', () => { if (!draft || saving) return; rememberUndo('撤销全部恢复默认'); draft = structuredClone(data.defaults); render(); });
  $('prompt-discard').addEventListener('click', () => { if (!draft || saving) return; rememberUndo('撤销放弃草稿'); draft = structuredClone(data.values); render(); });
  $('prompt-undo').addEventListener('click', () => { if (!undoSnapshot || saving) return; draft = undoSnapshot.values; selected = undoSnapshot.selected; undoSnapshot = null; saveIssue = ''; render(); });
  $('prompt-preview-client').addEventListener('change', preview);
  $('prompt-preview-mode').addEventListener('change', preview);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!draft || saving) return;
    let values; try { values = validatePromptValues(draft); } catch (e) { error(e.message); return; }
    saving = true; saveIssue = ''; toast(''); $('prompt-editor-body').disabled = true; preview();
    try {
      const result = await post('/api/prompt-settings', { values, expectedRevision: data.revision });
      data = { ...data, ...result }; draft = structuredClone(result.values); undoSnapshot = null; toast('提示词已保存');
    } catch (e) { saveIssue = e.message + ' 草稿已保留。'; toast('保存未完成，草稿已保留'); }
    finally { saving = false; if (dialog.open) { $('prompt-editor-body').disabled = false; preview(); } }
  });
}
