import { addressOf, autoCompressEnabled, visibleAddresses, messageMatches, validThresholds, PolicySaver, directoryConnection, connectionGuidance, sessionConnected } from './ui-state.mjs';
const $ = id => document.getElementById(id);
const state = { config: null, bridgeStatus:null, serviceOnline:true, connectionButtons:new Map(), connectionHelp:null, directories: [], sessions: [], messages: [], openDirs: new Set(), openClients: new Set(), knownDirs: new Set(),
  editors: new Map(), cards: new Map(), selected: null, messageRequest: 0, sessionRequest: 0, discoveryBusy: false, events: null, closed: false, signature: '', connectedSignature: '', scope: '', messageTimer: null };
const activities = { idle: '空闲', running: '工作中', waiting_permission: '等待权限', waiting_input: '等待答复', initializing: '初始化中', unloaded: '未加载', offline: '离线', unknown: '待确认' };
const delivery = { submitted: '已提交', queued: '已排队', pending: '提交中', unknown: '待确认', failed: '发送失败', held: '已保留' };
const phases = { waiting_client: '等待客户端重连', interrupting: '正在暂停任务', writing_handoff: '保存交付文档', awaiting_handoff_end: '等待交付轮次结束', compacting: '正在压缩', restoring: '加载上文', awaiting_restore_end: '等待恢复轮次结束', needs_attention: '需要处理', user_intervened: '用户已介入', completed: '维护已完成', cancelled: '维护已取消' };
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function button(text, className, action) { const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', action); return node; }
function notice(text) { $('global-error').textContent = text || ''; $('global-error').hidden = !text; }
let toastTimer;
function toast(text) { clearTimeout(toastTimer); $('toast').textContent = text; $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, 3600); }
function timestamp(value, full = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return '等待数据';
  return new Intl.DateTimeFormat('zh-CN', full ? { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false } : { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).format(new Date(value));
}
const name = session => session.name || '未命名会话';
function label(session) { return session.client + '://' + name(session) + ':' + session.id; }
function defaults(session) { return { softPercent: 50, hardPercent: 80, ...state.config.policyDefaults[session.client] }; }
function effective(session) { const policy = session.policy; return { autoCompress: autoCompressEnabled(policy), ...defaults(session), softPercent: policy?.softPercent ?? defaults(session).softPercent, hardPercent: policy?.hardPercent ?? defaults(session).hardPercent }; }
async function request(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || '请求失败'), { status: response.status, policy: data.policy });
  return data;
}
async function post(path, body, retried = false) {
  try { return await request(path, { method:'POST', headers:{ 'Content-Type':'application/json', 'X-Coop-UI':state.config.csrfToken }, body:JSON.stringify(body) }); }
  catch (error) {
    if (error.status === 403 && !retried) { state.config = await request('/api/config'); return post(path, body, true); }
    throw error;
  }
}
async function copy(value) { try { await navigator.clipboard.writeText(value); toast('已复制'); } catch { toast('复制失败，可直接选中会话 ID 复制。'); } }
function editor(session) {
  const key = addressOf(session);
  if (state.editors.has(key)) return state.editors.get(key);
  const value = { draft: effective(session), status:'saved', error:null, editing:false, dirty:false, version:0, saver:null };
  value.saver = new PolicySaver(async (policy, revision) => (await post('/api/policies', { address:key, policy, expectedRevision:revision })).policy,
    (status, item) => {
      if (!value.dirty) { value.status = status; value.error = item.error?.message || null; }
      if (item.error?.status === 409) {
        value.saver.revision = item.error.policy?.revision || 0;
        session.policy = item.error.policy;
      }
      if (item.policy) {
        const current = state.sessions.find(s => addressOf(s) === key);
        if (current) current.policy = item.policy;
      }
      refreshCards();
    });
  value.saver.revision = session.policy?.revision || 0; state.editors.set(key, value); return value;
}
function commit(session) {
  const value = editor(session); value.editing = false;
  if (!validThresholds(Number(value.draft.softPercent), Number(value.draft.hardPercent))) {
    value.status = 'error'; value.error = '请输入 0 到 100 之间的数值，空闲阈值必须小于强停阈值。'; refreshCards(); return;
  }
  value.draft.softPercent = Number(value.draft.softPercent); value.draft.hardPercent = Number(value.draft.hardPercent);
  value.dirty = false; value.version++; void value.saver.save(value.draft); refreshCards();
}
function markDraft(session, key, next) { const value = editor(session); value.draft[key] = next; value.editing = true; value.dirty = true; value.status = 'editing'; value.error = null; }
function buildCard(session) {
  const key = addressOf(session), value = editor(session);
  const card = el('section', 'session-card'); card.dataset.address = key; card.setAttribute('aria-label', name(session));
  const head = el('div', 'session-head'), title = el('h3', 'session-name', name(session)), badge = el('span', 'activity-badge');
  title.title = name(session); head.append(title, badge);
  const identity = el('div', 'identity'); const id = el('code', '', session.id);
  identity.append(id, button('复制地址', 'text-button copy-address', () => copy(label(session))));
  const usage = el('div', 'usage-summary'), amount = el('strong', 'usage-number', '—'), info = el('div', 'usage-info'), tokens = el('span', 'token-count'), model = el('span', 'model-name');
  info.append(tokens, model); usage.append(amount, info);
  const meter = el('meter', 'usage-meter'); meter.min = 0; meter.max = 100; meter.setAttribute('aria-label', name(session) + ' 上下文占用');
  const freshness = el('div','freshness');
  const controls = el('div','compression-controls'), toggleLabel = el('label', 'auto-toggle'), toggle = el('input'); toggle.type='checkbox'; toggle.checked=value.draft.autoCompress;
  toggle.setAttribute('aria-label', name(session) + ' 启用自动压缩');
  toggle.addEventListener('change', () => { value.draft.autoCompress = toggle.checked; commit(session); });
  toggleLabel.append(toggle, el('span','', '启用自动压缩'));
  const saveStatus = el('span', 'save-status'); saveStatus.setAttribute('role','status'); controls.append(toggleLabel, saveStatus);
  const fields = {};
  for (const [field, caption, type] of [['softPercent', '空闲阈值', 'soft'], ['hardPercent', '强停阈值', 'hard']]) {
    const row = el('div', 'threshold ' + type), top = el('div','threshold-top'), title = el('span','threshold-label', caption);
    const numberLabel = el('label','threshold-value'), input = el('input');
    input.type='number'; input.min='0.01'; input.max='99.99'; input.step='0.01'; input.inputMode='decimal'; input.value=value.draft[field];
    input.setAttribute('aria-label', name(session) + ' ' + caption + ' 数值');
    const range = el('input','threshold-range'); range.type='range'; range.min='0.01'; range.max='99.99'; range.step='0.01'; range.value=value.draft[field];
    range.setAttribute('aria-label', name(session) + ' ' + caption + ' 滑动条');
    input.addEventListener('focus', () => value.editing = true);
    input.addEventListener('input', () => { markDraft(session, field, input.value === '' ? NaN : Number(input.value)); if (Number.isFinite(value.draft[field])) range.value = value.draft[field]; saveStatus.textContent='编辑中'; });
    const finish = () => { if (value.dirty) commit(session); else value.editing=false; };
    input.addEventListener('blur', finish); input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); finish(); input.blur(); } });
    range.addEventListener('input', () => {
      const other = Number(value.draft[field === 'softPercent' ? 'hardPercent' : 'softPercent']);
      const raw = Number(range.value), bounded = Number.isFinite(other) ? field === 'softPercent' ? Math.min(raw, other - .01) : Math.max(raw, other + .01) : raw;
      const next = Math.max(.01, Math.min(99.99, Math.round(bounded * 100) / 100));
      markDraft(session, field, next); input.value=next; range.value=next; saveStatus.textContent='松手后保存';
    });
    range.addEventListener('change', () => commit(session));
    numberLabel.append(input,el('span','','%')); top.append(title,numberLabel); row.append(top,range); controls.append(row); fields[field]={input,range};
  }
  const note=el('p','policy-hint','达到空闲阈值，工作结束后压缩；达到强停阈值，先暂停再压缩。开启后降低阈值可能立即触发。');
  const validation=el('div','policy-error'); validation.setAttribute('role','alert'); validation.hidden=true;
  const retry=button('重新保存','text-button retry-save',()=>commit(session)); retry.hidden=true;
  const cycle=el('div','cycle-controls');
  controls.append(note,validation,retry); card.append(head,identity,usage,meter,freshness,controls,cycle);
  const entry={card,badge,amount,tokens,model,meter,freshness,toggle,saveStatus,fields,validation,retry,cycle,cycleSignature:''};
  if(!state.cards.has(key))state.cards.set(key,[]);state.cards.get(key).push(entry);
  return card;
}
function refreshCards() {
  if(refreshConnectedFilter())return;
  let automatic=0;
  for(const session of state.sessions) {
    const key=addressOf(session), value=editor(session), sample=session.monitoring, runtime=sample?.runtime, usage=sample?.usage;
    if(autoCompressEnabled(session.policy))automatic++;
    const hasCount=Number.isFinite(usage?.usedTokens), percent=hasCount&&usage.contextWindowTokens>0?usage.usedTokens*100/usage.contextWindowTokens:null;
    for(const card of state.cards.get(key)||[]) {
      const activity=runtime?.activity || (session.live?'initializing':'unknown');
      card.badge.textContent=activities[activity]||'待确认'; card.badge.className='activity-badge '+activity;
      card.amount.textContent=percent===null?'—':percent.toFixed(1)+'%';
      card.amount.className='usage-number '+(percent!==null&&percent>=Number(value.draft.hardPercent)?'high':percent!==null&&percent>=Number(value.draft.softPercent)?'warm':'');
      card.tokens.textContent=hasCount?usage.usedTokens.toLocaleString()+' / '+(usage.contextWindowTokens>0?usage.contextWindowTokens.toLocaleString():'容量未知')+' tokens':'等待上下文用量';
      card.model.textContent=runtime?.model||usage?.model||'模型待确认';
      card.meter.value=percent===null?0:Math.min(100,percent);card.meter.low=Number(value.draft.softPercent)||50;card.meter.high=Number(value.draft.hardPercent)||80;card.meter.optimum=0;card.meter.hidden=percent===null;
      card.freshness.textContent=runtime?.connected?(usage?.historyChangedAfterMeasurement?'等待本轮新统计 · ':'最近统计 ')+timestamp(usage?.measuredAt||usage?.queriedAt||usage?.observedAt)
        : (usage?'离线快照 · '+timestamp(usage.measuredAt||usage.observedAt):session.client==='claude'&&session.controlAccess?.directoryEnabled===false?'未接入 Claude 控制，等待可用记录':'等待客户端连接');
      card.toggle.checked=Boolean(value.draft.autoCompress);
      if(!value.editing) for(const field of ['softPercent','hardPercent']) {
        const control=card.fields[field]; if(document.activeElement!==control.input&&document.activeElement!==control.range) {
          control.input.value=Number.isFinite(Number(value.draft[field]))?value.draft[field]:'';control.range.value=value.draft[field];
        }
      }
      card.saveStatus.textContent=({saving:'保存中…',saved:'已保存',editing:'编辑中',error:'保存失败'})[value.status]||'';
      card.saveStatus.className='save-status '+value.status;card.validation.hidden=!value.error;card.validation.textContent=value.error||'';card.retry.hidden=value.status!=='error';
      const cycle=session.cycle; const signature=JSON.stringify([cycle,session.lastCycle?.id,session.queueCount,session.queueState]);
      if(signature!==card.cycleSignature) {
        card.cycleSignature=signature;card.cycle.replaceChildren();
        if(cycle) {
          card.cycle.append(el('p','cycle-title',(phases[cycle.state]||cycle.state)+' · 排队 '+(session.queueCount||0)+' 条'));
          if(cycle.reason)card.cycle.append(el('p','cycle-reason',cycle.reason));
          const actions=[];
          if(['needs_attention','user_intervened'].includes(cycle.state)) {
            actions.push(['reconcile','核对后继续']);
            if(['writing_handoff','restoring'].includes(cycle.previousState))actions.push(['retry','重发当前请求']);
          }
          actions.push(['cancel-release','取消并释放消息'],['cancel-hold','取消并保留消息']);
          for(const [action,text]of actions)card.cycle.append(button(text,'text-button',async event=>{
            const target=event.currentTarget;target.disabled=true;
            try{await post('/api/cycles/action',{id:cycle.id,action});await loadMonitoring();await loadMessages();}
            catch(error){toast(error.message);}finally{target.disabled=false;}
          }));
        } else if(session.lastCycle) card.cycle.append(el('span','last-cycle',(phases[session.lastCycle.state]||session.lastCycle.state)+(session.queueCount?' · 待处理 '+session.queueCount+' 条':'')));
        if(session.queueState?.held)card.cycle.append(button('释放保留消息','text-button',async()=>{try{await post('/api/queue/release',{address:key});await loadMonitoring();await loadMessages();}catch(error){toast(error.message);}}));
      }
    }
  }
  $('auto-count').textContent=automatic;$('total-sessions').textContent=state.sessions.length;refreshConnections();
}
function connectionState(client, directory = null) {
  return directoryConnection({client,directory,sessions:state.sessions,bridge:state.bridgeStatus,online:state.serviceOnline});
}
function refreshConnections() {
  for(const [key,entry] of state.connectionButtons) {
    const directory=state.directories.find(d=>d.id===entry.directoryId);if(!directory)continue;
    const status=connectionState(entry.client,directory);
    entry.button.textContent=status.label;entry.button.className='client-connection '+status.tone;
    entry.button.title='此目录全部 '+(entry.client==='claude'?'Claude':'Codex')+' 会话的连接状态，点击查看接入方法';
    entry.button.setAttribute('aria-label',directory.path+' 的 '+entry.client+'：'+status.label+'，查看连接方法');
  }
  if(state.connectionHelp)renderConnectionHelp();
}
function renderConnectionHelp() {
  const context=state.connectionHelp;if(!context)return;
  const directory=context.directoryId?state.directories.find(d=>d.id===context.directoryId):null;
  if(context.directoryId&&!directory){$('connection-dialog').close();state.connectionHelp=null;return;}
  const status=connectionState(context.client,directory);
  const signature=JSON.stringify([context.client,directory,status,state.config?.installationDirectory]);
  if(context.signature===signature)return;context.signature=signature;
  const guide=connectionGuidance({client:context.client,directory,status,installationDirectory:state.config?.installationDirectory||''});
  $('connection-help-title').textContent=guide.title;$('connection-help-scope').textContent=guide.scope;
  $('connection-help-summary').textContent=guide.summary;$('connection-help-steps').replaceChildren();
  for(const step of guide.steps) {
    const item=el('li'),content=el('div','connection-step');content.append(el('h3','',step.title),el('p','',step.text));
    if(step.code)content.append(el('pre','connection-code',step.code),button(step.copyLabel||'复制','text-button',()=>copy(step.code)));
    item.append(content);$('connection-help-steps').append(item);
  }
  $('connection-help-note').textContent=guide.note||'';$('connection-help-note').hidden=!guide.note;
}
function showConnectionHelp(client,directoryId=null) {
  state.connectionHelp={client,directoryId,signature:null};renderConnectionHelp();
  if(!$('connection-dialog').open)$('connection-dialog').showModal();
}
function rememberTree() { try { localStorage.setItem('cooperation-tree-v1',JSON.stringify({dirs:[...state.openDirs],clients:[...state.openClients],known:[...state.knownDirs]})); } catch {} }
function connectionFilter(directory) { return {directory,onlyConnected:$('connected-only').checked,bridge:state.bridgeStatus,online:state.serviceOnline}; }
function matchesConnection(session,directory) { return !$('connected-only').checked||sessionConnected(session,connectionFilter(directory)); }
function connectedSignature() {
  return $('connected-only').checked?JSON.stringify(state.directories.map(d=>[d.id,state.sessions.filter(s=>s.directoryIds?.includes(d.id)&&matchesConnection(s,d)).map(addressOf).sort()])):'';
}
function refreshConnectedFilter() {
  if(connectedSignature()===state.connectedSignature)return false;
  renderTree();return true;
}
function visible() { return visibleAddresses(state.directories,state.sessions,state.openDirs,state.openClients,$('session-search').value,connectionFilter()); }
function updateScope() {
  const addresses=[...visible()].sort(),signature=JSON.stringify(addresses);
  $('session-count').textContent=addresses.length;
  $('message-scope').textContent=addresses.length?'涉及左侧已展开的 '+addresses.length+' 个会话 · 发送或接收均计入':'尚未展开会话 · 展开目录和客户端后显示通信';
  if(signature!==state.scope) { state.scope=signature; state.selected=null; state.messages=[];renderMessages();void loadMessages(); }
}
function renderTree() {
  state.connectedSignature=connectedSignature();
  const previousScroll=$('directory-tree').scrollTop;
  state.cards.clear();state.connectionButtons.clear();$('directory-tree').replaceChildren();
  const query=$('session-search').value.trim().toLocaleLowerCase();
  for(const directory of state.directories) {
    const folder=el('section','directory-node'), heading=el('div','directory-heading');
    const display=directory.label&&directory.label!==directory.path?directory.label:directory.path.replaceAll('\\','/').split('/').filter(Boolean).at(-1);
    const title=button('', 'folder-toggle',()=>{
      const open=!state.openDirs.has(directory.id);if(open)state.openDirs.add(directory.id);else state.openDirs.delete(directory.id);
      title.setAttribute('aria-expanded',String(open));children.hidden=!open;rememberTree();updateScope();
    });
    title.setAttribute('aria-expanded',String(state.openDirs.has(directory.id)));title.setAttribute('aria-label','展开目录 '+directory.path);
    const text=el('span','folder-text');text.append(el('strong','',display),el('small','',directory.path));
    title.append(el('span','chevron','›'),el('span','folder-symbol','▰'),text,el('span','count',String(state.sessions.filter(s=>s.directoryIds?.includes(directory.id)&&matchesConnection(s,directory)).length)));
    const remove=button('×','icon-button remove-directory',async()=>{
      try{const result=await post('/api/directories/remove',{id:directory.id});state.directories=result.directories;state.openDirs.delete(directory.id);rememberTree();await loadSessions(true);}
      catch(error){toast(error.message);}
    });remove.setAttribute('aria-label','移除目录 '+directory.path);
    heading.append(title,remove);folder.append(heading);
    const children=el('div','directory-children');children.hidden=!state.openDirs.has(directory.id);
    const options=el('div','directory-options'), controlLabel=el('label'), control=el('input');control.type='checkbox';control.checked=directory.claudeControlEnabled===true;
    control.setAttribute('aria-label','允许 '+directory.path+' 的 Claude 控制接入');
    control.addEventListener('change',async()=>{
      control.disabled=true;try{const result=await post('/api/directories/claude-control',{id:directory.id,enabled:control.checked});state.directories=result.directories;toast(result.detail);await loadSessions(true);}
      catch(error){control.checked=!control.checked;toast(error.message);}finally{control.disabled=false;}
    });
    controlLabel.append(control,document.createTextNode('Claude 控制'));controlLabel.title='允许本目录的 Claude 控制接入，重开面板生效；与自动压缩开关独立。';
    options.append(controlLabel,el('span','',directory.recursive?'含子目录':'仅当前目录'));children.append(options);
    if(directory.error)children.append(el('p','directory-error',directory.error));
    for(const client of ['claude','codex']) {
      const groupKey=directory.id+':'+client, group=el('section','client-node '+client);
      const sessions=state.sessions.filter(s=>s.client===client&&s.directoryIds?.includes(directory.id)&&matchesConnection(s,directory)&&(!query||(name(s)+' '+s.id).toLocaleLowerCase().includes(query)));
      const toggle=button('','client-toggle',()=>{
        const open=!state.openClients.has(groupKey);if(open)state.openClients.add(groupKey);else state.openClients.delete(groupKey);
        toggle.setAttribute('aria-expanded',String(open));list.hidden=!open;rememberTree();updateScope();
      });
      toggle.setAttribute('aria-label','展开 '+display+' 的 '+(client==='claude'?'Claude':'Codex'));toggle.setAttribute('aria-expanded',String(state.openClients.has(groupKey)));
      toggle.append(el('span','chevron','›'),el('span','client-mark',client==='claude'?'✳':'⌘'),el('strong','',client==='claude'?'Claude':'Codex'),el('span','count',String(sessions.length)));
      const list=el('div','client-sessions');list.hidden=!state.openClients.has(groupKey);
      if(!sessions.length)list.append(el('p','group-empty',query?'没有匹配会话':$('connected-only').checked?'没有已连接会话':'尚未发现会话'));
      for(const session of sessions)list.append(buildCard(session));
      const connection=button('检查连接','client-connection checking',()=>showConnectionHelp(client,directory.id));
      connection.setAttribute('aria-haspopup','dialog');
      state.connectionButtons.set(groupKey,{button:connection,client,directoryId:directory.id});
      const groupHeading=el('div','client-heading');groupHeading.append(toggle,connection);
      group.append(groupHeading,list);children.append(group);
    }
    folder.append(children);$('directory-tree').append(folder);
  }
  $('tree-empty').hidden=state.directories.length>0;$('tree-empty').textContent='添加项目目录，开始查看会话和上下文。';
  $('directory-tree').scrollTop=previousScroll;refreshCards();updateScope();
}
function newDirectories(directories) {
  state.directories=directories;
  for(const d of directories)if(!state.knownDirs.has(d.id)) {
    state.knownDirs.add(d.id);state.openDirs.add(d.id);state.openClients.add(d.id+':claude');state.openClients.add(d.id+':codex');
  }
}
async function loadSessions(force=false) {
  if(state.discoveryBusy)return;
  state.discoveryBusy=true;const id=++state.sessionRequest;
  try{
    const dirs=await request('/api/directories');newDirectories(dirs.directories);
    const result=await post('/api/sessions',{directoryIds:state.directories.map(d=>d.id)});
    if(id!==state.sessionRequest||state.closed)return;
    for(const session of result.sessions) {
      const existing=state.sessions.find(s=>addressOf(s)===addressOf(session));
      if(existing) {
        session.monitoring=existing.monitoring||session.monitoring;
        if((session.policy?.revision||0)<(existing.policy?.revision||0))session.policy=existing.policy;
      }
      const value=state.editors.get(addressOf(session));
      if(value&&!value.editing&&!value.saver.running&&value.status!=='error') {
        value.draft=effective(session);value.saver.revision=session.policy?.revision||0;
      }
    }
    state.sessions=result.sessions;
    for(const d of state.directories)d.error=result.directories?.find(r=>r.id===d.id)?.error;
    const signature=JSON.stringify([state.directories,state.sessions.map(s=>[s.client,s.id,s.name,s.directoryIds])]);
    if(force||signature!==state.signature){state.signature=signature;renderTree();}
    await loadMonitoring();notice('');
  }catch(error){notice('发现会话失败：'+error.message);}
  finally{state.discoveryBusy=false;}
}
async function loadMonitoring() {
  if(state.closed)return;
  try {
    const result=await request('/api/monitoring');
    for(const sample of result.sessions) {
      const session=state.sessions.find(s=>addressOf(s)===addressOf(sample.session));if(!session)continue;
      if((sample.policy?.revision||0)<(session.policy?.revision||0))sample.policy=session.policy;
      session.monitoring=sample;session.policy=sample.policy;session.cycle=sample.cycle;session.lastCycle=sample.lastCycle;session.queueCount=sample.queueCount;session.queueState=sample.queueState;
      const value=state.editors.get(addressOf(session));
      if(value&&!value.editing&&!value.saver.running&&value.status!=='error') {value.draft=effective(session);value.saver.revision=sample.policy?.revision||0;}
    }
    refreshCards();
  }catch{ /* The service connection indicator handles disconnection. */ }
}
function statusBadge(status) { return el('span','delivery-badge '+status,delivery[status]||'待确认'); }
function routePart(session, direction) {
  const row=el('div','message-route'), badge=el('span','route-client '+session.client,session.client==='claude'?'Claude':'Codex');
  row.append(el('span','route-direction',direction),badge,el('strong','',name(session)));row.title=label(session);return row;
}
function renderDetail(message) {
  const panel=$('message-detail');panel.replaceChildren();panel.classList.toggle('has-selection',Boolean(message));
  if(!message) {const empty=el('div','detail-empty');empty.append(el('span','detail-symbol','↗'),el('h3','','选择一条通信'),el('p','','查看完整正文、发送方和接收方。'));panel.append(empty);return;}
  const head=el('div','detail-heading');head.append(el('h3','','消息详情'),statusBadge(message.status));
  const meta=el('dl','detail-meta');
  for(const [title,value]of [['发送方',label(message.from)],['接收方',label(message.to)],['发送时间',timestamp(message.createdAt,true)],['消息 ID',message.id]]) {
    const row=el('div');row.append(el('dt','',title),el('dd','',value));meta.append(row);
  }
  panel.append(head,meta,el('pre','message-body',message.text),button('复制消息正文','button',()=>copy(message.text)));
  if(message.error)panel.append(el('p','notice error',message.error));
  if(message.detail)panel.append(el('p','detail-note',message.detail));
  panel.append(el('p','detail-note',message.status==='submitted'?'已提交到原生客户端；不代表对方已处理。':message.status==='queued'?'消息已持久排队，将在维护完成后按顺序投递。':''));
  if(message.status==='unknown')for(const [outcome,title]of [['submitted','确认已送达，继续队列'],['not_submitted','确认未送达，重新发送']])
    panel.append(button(title,'button',async()=>{try{await post('/api/messages/resolve',{id:message.id,outcome});await loadMessages();}catch(error){toast(error.message);}}));
}
function renderMessages() {
  const addresses=visible(),query=$('message-search').value.trim().toLocaleLowerCase(),filter=$('message-status').value;
  const messages=state.messages.filter(m=>messageMatches(m,addresses)&&(filter==='all'||m.status===filter)&&(!query||[m.text,label(m.from),label(m.to)].some(t=>t.toLocaleLowerCase().includes(query))));
  $('message-count').textContent=messages.length;$('message-list').replaceChildren();$('message-empty').hidden=messages.length>0;
  $('message-empty').replaceChildren(el('span','empty-symbol','⇄'),el('h3','',addresses.size?'没有匹配的通信':'展开会话，聚焦通信'),el('p','',addresses.size?'当前展开会话暂时没有符合筛选条件的消息。':'展开左侧目录下的 Claude 或 Codex，会自动显示涉及这些会话的发送与接收记录。'));
  for(const message of messages) {
    const li=el('li'),row=button('','message-row',()=>{state.selected=message.id;renderMessages();});
    row.setAttribute('aria-label',name(message.from)+' → '+name(message.to)+' '+timestamp(message.createdAt,true));row.setAttribute('aria-pressed',String(state.selected===message.id));
    const top=el('div','message-row-top');top.append(el('time','',timestamp(message.createdAt,true)),statusBadge(message.status));
    row.append(top,routePart(message.from,'从'),routePart(message.to,'到'),el('p','message-preview',message.text));li.append(row);$('message-list').append(li);
  }
  const selected=messages.find(m=>m.id===state.selected);if(!selected)state.selected=null;renderDetail(selected);
}
async function loadMessages() {
  const id=++state.messageRequest,addresses=[...visible()];
  if(!addresses.length){state.messages=[];renderMessages();return;}
  try {
    const result=await request('/api/messages?'+new URLSearchParams({addresses:JSON.stringify(addresses)}));
    if(id!==state.messageRequest||state.closed)return;state.messages=result.messages;renderMessages();$('message-error').hidden=true;
  }catch(error){if(id===state.messageRequest){$('message-error').textContent=error.message;$('message-error').hidden=false;}}
}
function renderBridge(status) {
  state.bridgeStatus=status;
  const badge=$('codex-connection'),display=connectionState('codex');
  badge.textContent='Codex '+display.label;badge.className='bridge-status '+display.tone;
  badge.title=(status?.detail||'Codex 连接状态')+'；点击查看连接方法';
  if(!refreshConnectedFilter())refreshConnections();
}
async function loadBridge(force=false) {
  try { renderBridge(await request('/api/bridge'+(force?'?refresh=1':''))); }
  catch { renderBridge({connected:false,detail:'管理服务暂不可用，连接恢复后会自动检查。'}); }
}
function connectEvents() {
  state.events=new EventSource('/api/events');
  state.events.addEventListener('bridge',event=>{try{renderBridge(JSON.parse(event.data));}catch{}});
  state.events.addEventListener('open',()=>{state.serviceOnline=true;void loadBridge();$('connection-dot').className='dot connected';$('connection-label').textContent='本地服务在线';});
  state.events.addEventListener('error',()=>{state.serviceOnline=false;renderBridge({connected:false,detail:'管理服务暂不可用'});$('connection-dot').className='dot disconnected';$('connection-label').textContent='服务连接中断';});
  let monitorTimer;
  state.events.addEventListener('management',()=>{if(!monitorTimer)monitorTimer=setTimeout(()=>{monitorTimer=null;void loadMonitoring();},250);});
  state.events.addEventListener('message',()=>{clearTimeout(state.messageTimer);state.messageTimer=setTimeout(loadMessages,200);});
}
$('codex-connection').addEventListener('click',()=>showConnectionHelp('codex'));
$('connection-help-close').addEventListener('click',()=>$('connection-dialog').close());
$('connection-dialog').addEventListener('close',()=>{state.connectionHelp=null;});
$('connection-recheck').addEventListener('click',async event=>{
  const target=event.currentTarget;target.disabled=true;target.textContent='正在检查…';
  try { await loadBridge(true);await loadSessions(true);renderConnectionHelp(); }
  finally { target.disabled=false;target.textContent='重新检查'; }
});
$('directory-form').addEventListener('submit',async event=>{
  event.preventDefault();const path=$('directory').value.trim();if(!path)return;$('add-directory').disabled=true;
  try{const result=await post('/api/directories',{path,recursive:$('recursive').checked});newDirectories(result.directories);$('directory').value='';await loadSessions(true);}
  catch(error){notice(error.message);}finally{$('add-directory').disabled=false;}
});
$('refresh-all').addEventListener('click',()=>loadSessions(true));
$('collapse-all').addEventListener('click',()=>{state.openDirs.clear();rememberTree();renderTree();});
let searchTimer;
$('session-search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(renderTree,150);});
$('connected-only').addEventListener('change',()=>{
  try{localStorage.setItem('cooperation-connected-only-v1',String($('connected-only').checked));}catch{}
  renderTree();
});
$('message-search').addEventListener('input',renderMessages);$('message-status').addEventListener('change',renderMessages);
let discoverTimer,monitorTimer,messageTimer;
window.addEventListener('pagehide',()=>{state.closed=true;state.events?.close();clearInterval(discoverTimer);clearInterval(monitorTimer);clearInterval(messageTimer);});
try {
  try{$('connected-only').checked=localStorage.getItem('cooperation-connected-only-v1')==='true';}catch{}
  state.config=await request('/api/config');$('version').textContent='v'+state.config.version;renderBridge(state.config.bridge?.codexStatus);
  try{const saved=JSON.parse(localStorage.getItem('cooperation-tree-v1'));if(saved){state.openDirs=new Set(saved.dirs);state.openClients=new Set(saved.clients);state.knownDirs=new Set(saved.known);}}catch{}
  newDirectories(state.config.directories||[]);connectEvents();await loadSessions(true);
  discoverTimer=setInterval(()=>loadSessions(),15000);monitorTimer=setInterval(loadMonitoring,2500);messageTimer=setInterval(loadMessages,10000);
}catch(error){notice('无法连接本地管理服务：'+error.message);$('connection-label').textContent='服务未连接';}
