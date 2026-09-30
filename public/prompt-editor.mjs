import { applyMessageAffixes, renderPromptTemplate, validatePromptValues } from './prompt-templates.mjs';

const panels = [
  ['codex', 'Codex 消息'], ['claude', 'Claude 消息'], ['opencode', 'OpenCode 消息'],
  ['handoff', '交付文档'], ['restore', '恢复上下文'], ['continue', '继续任务'],
];
const peer = key => ['codex', 'claude', 'opencode'].includes(key);
const $ = id => document.getElementById(id);
function node(tag, className, text) { const n = document.createElement(tag); n.className = className || ''; if (text !== undefined) n.textContent = text; return n; }

export function setupPromptEditor({ request, post, toast }) {
  const dialog = $('prompt-dialog'), form = $('prompt-form'), open = $('open-prompts');
  let data, draft, selected = 'codex', generation = 0, saving = false;
  const error = text => { $('prompt-error').textContent = text; $('prompt-error').hidden = !text; };
  const status = text => { $('prompt-save-status').textContent = text; };
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
      validatePromptValues(draft); error('');
      const changed = JSON.stringify(draft) !== JSON.stringify(data.values);
      $('save-prompts').disabled = saving || !changed;
      status(saving ? '保存中…' : changed ? '有未保存修改' : '已保存 · 第 ' + data.revision + ' 版');
    } catch (e) { error(e.message); $('save-prompts').disabled = true; status('请修正提示词'); }
  }
  function field(title, key, value, multiline = true, rows = 4) {
    const label = node('label', 'field-label', title), input = node(multiline ? 'textarea' : 'input', 'text-input prompt-input');
    input.id = 'prompt-' + key; label.htmlFor = input.id; input.value = value;
    if (multiline) input.rows = rows;
    else { input.type = 'text'; input.maxLength = 512; }
    input.spellcheck = false;
    input.addEventListener('input', () => {
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
        : '内容可自由编辑。请保留 {{checkpoint}}，系统会在发送时填入正确的工具名、文档路径和回执参数。';
    if (isPeer) {
      field('消息前缀', 'prefix', draft.messages[selected].prefix, true, selected === 'opencode' ? 5 : 3);
      field('消息后缀', 'suffix', draft.messages[selected].suffix, true, 3);
      if (selected === 'claude') field('界面显示标签', 'label', draft.messages.claude.label, false);
    } else {
      const textarea = field('提示词内容', 'template', draft.maintenance[selected], true, 9);
      $('prompt-variable-buttons').replaceChildren();
      for (const name of ['documentPath', 'cycleId', 'sessionId', 'client', ...(selected === 'continue' ? [] : ['checkpoint'])]) {
        const button = node('button', 'prompt-variable', '{{' + name + '}}'); button.type = 'button';
        button.addEventListener('click', () => { textarea.setRangeText(button.textContent, textarea.selectionStart, textarea.selectionEnd, 'end'); textarea.dispatchEvent(new Event('input')); textarea.focus(); });
        $('prompt-variable-buttons').append(button);
      }
    }
    preview();
  }
  for (const [key, title] of panels) {
    const button = node('button', 'prompt-tab', title); button.type = 'button'; button.id = 'prompt-tab-' + key; button.dataset.panel = key; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', 'prompt-panel');
    button.addEventListener('click', () => { selected = key; render(); });
    button.addEventListener('keydown', event => {
      const index = panels.findIndex(p => p[0] === selected);
      const next = ['ArrowDown', 'ArrowRight'].includes(event.key) ? (index + 1) % panels.length
        : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? (index + panels.length - 1) % panels.length : event.key === 'Home' ? 0 : event.key === 'End' ? panels.length - 1 : null;
      if (next !== null) { event.preventDefault(); $('prompt-navigation').children[next].click(); $('prompt-navigation').children[next].focus(); }
    });
    $('prompt-navigation').append(button);
  }
  open.addEventListener('click', async () => {
    const current = ++generation; draft = null; data = null; saving = false;
    error(''); status('正在读取…'); $('prompt-editor-body').disabled = true; $('save-prompts').disabled = true;
    $('prompt-fields').replaceChildren(); $('prompt-preview').textContent = ''; dialog.showModal();
    try {
      const result = await request('/api/prompt-settings');
      if (current !== generation || !dialog.open) return;
      data = result; draft = structuredClone(result.values); $('prompt-editor-body').disabled = false; render();
    } catch (e) { if (current === generation && dialog.open) { error(e.message); status('读取失败'); } }
  });
  dialog.addEventListener('close', () => { generation++; draft = null; });
  $('prompt-reset-current').addEventListener('click', () => { if (!draft) return; if (peer(selected)) draft.messages[selected] = structuredClone(data.defaults.messages[selected]); else draft.maintenance[selected] = data.defaults.maintenance[selected]; render(); });
  $('prompt-reset-all').addEventListener('click', () => { if (!draft) return; draft = structuredClone(data.defaults); render(); });
  $('prompt-preview-client').addEventListener('change', preview);
  $('prompt-preview-mode').addEventListener('change', preview);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!draft || saving) return;
    let values; try { values = validatePromptValues(draft); } catch (e) { error(e.message); return; }
    const current = generation; saving = true; $('prompt-editor-body').disabled = true; $('save-prompts').disabled = true; error(''); status('保存中…');
    try {
      const result = await post('/api/prompt-settings', { values, expectedRevision: data.revision });
      if (current !== generation || !dialog.open) return;
      data = { ...data, ...result }; draft = structuredClone(result.values); status('已保存 · 第 ' + result.revision + ' 版'); toast('提示词已保存');
    } catch (e) { if (current === generation && dialog.open) { error(e.message); status('保存未完成，修改已保留'); } }
    finally { if (current === generation && dialog.open) { saving = false; $('prompt-editor-body').disabled = false; $('save-prompts').disabled = JSON.stringify(draft) === JSON.stringify(data.values); } }
  });
}
