import { setupPromptEditor } from './prompt-editor.mjs';
import { setupRestartConfirmation } from './restart-confirmation.mjs';
import { setupMotion, revealPanel, syncTabIndicator } from './ui-state.mjs';
import { maintenanceView, maintenanceDiagnostic, quotaView } from './maintenance-view.mjs';
import { addressOf, clientName, autoCompressEnabled, projectMembers, workspaceAddresses, messageMatches, validThresholds, PolicySaver, directoryConnection, connectionGuidance, sessionConnected, openCodeContextState, reconcileChildren } from './ui-state.mjs';
const $ = id => document.getElementById(id);
setupMotion();
const state = { config: null, bridge: null, online: true, mode: 'directories', directories: [], groups: [], sessions: [],
  picks: { directories: null, custom: null }, selectedAddress: null, expanded: new Set(), known: new Set(), connectedOnly: false,
  tab: 'overview', messages: [], selectedMessage: null, messageRequest: 0, scope: '', discoveryBusy: false, closed: false,
  editors: new Map(), cards: new Map(), connectionHelp: null, groupDraft: null, directoryDraft: null, events: null, discoveryReady: false, discoveryError: null };
const activities = { idle: '空闲', running: '工作中', quota_limited: '等待额度', waiting_permission: '等待权限', waiting_input: '等待答复', initializing: '初始化中', unloaded: '未加载', offline: '离线', unknown: '待确认' };
const delivery = { submitted: '已发送到会话', queued: '等待发送', pending: '发送中', unknown: '需要确认', failed: '发送失败', held: '已暂存' };
const phases = { waiting_client: '等待客户端重连', interrupting: '正在暂停任务', writing_handoff: '保存交付文档', awaiting_handoff_end: '等待交付轮次结束', compacting: '正在压缩', restoring: '加载上文', awaiting_restore_end: '等待恢复轮次结束', needs_attention: '需要处理', user_intervened: '用户已介入', completed: '维护已完成', cancelled: '维护已取消' };
const name = s => s.name || '未命名会话';
const label = s => `${s.client}://${name(s)}:${s.id}`;
const projects = () => state.mode === 'custom' ? state.groups : state.directories;
const currentProject = () => projects().find(p => p.id === state.picks[state.mode]);
const projectName = p => state.mode === 'custom' ? p.name : p.label && p.label !== p.path ? p.label : p.path.replaceAll('\\','/').split('/').filter(Boolean).at(-1) || p.path;
const members = () => projectMembers(currentProject(), state.sessions, state.mode);
const currentSession = () => members().find(s => addressOf(s) === state.selectedAddress);
const activity = s => s.missing ? 'offline' : s.monitoring?.runtime?.activity || (s.live ? 'initializing' : 'unknown');
const connected = s => !s.missing && sessionConnected(s, { directory: state.directories.find(d => d.id === s.directoryIds?.[0]), bridge: state.bridge, online: state.online });
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function setText(node, value) { const next=String(value??'');if(node.textContent!==next)node.textContent=next; }
function projectIcon(custom, expanded) {
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
  svg.setAttribute('viewBox','0 0 20 20');svg.setAttribute('class','folder-icon project-icon');svg.setAttribute('aria-hidden','true');
  svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.4');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');
  const paths=custom?['M7 2.5h6a1.5 1.5 0 0 1 1.5 1.5v2','M4 5.5h9.5A1.5 1.5 0 0 1 15 7v7.5a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 4 5.5Z','M15 8h1a1.5 1.5 0 0 1 1.5 1.5V16a1.5 1.5 0 0 1-1.5 1.5H7']
    :expanded?['M2.5 8V5a1.5 1.5 0 0 1 1.5-1.5h3l2 2h6A1.5 1.5 0 0 1 16.5 7v1','M3.5 8.5h13a1 1 0 0 1 1 1.3l-1.4 5.5a1.5 1.5 0 0 1-1.5 1.2H4.4a1.5 1.5 0 0 1-1.5-1.2L1.5 9.8a1 1 0 0 1 1-1.3Z']
    :['M2.5 6V5a1.5 1.5 0 0 1 1.5-1.5h3l2 2h7A1.5 1.5 0 0 1 17.5 7v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 15V6Z','M2.5 7.5h15'];
  for(const d of paths){const path=document.createElementNS(ns,'path');path.setAttribute('d',d);svg.append(path);}return svg;
}
function button(text, className, action) { const node = el('button', className, text); node.type = 'button';if(text)node.dataset.renderKey='action:'+text;
  node.onclick = event => {
    const target = event.currentTarget; if (target.dataset.uiBusy) return;
    const result = action(event);
    if (result?.then) { target.dataset.uiBusy = 'true'; return result.finally(() => { delete target.dataset.uiBusy; }); }
    return result;
  }; return node;
}
function setError(id, text = '') { $(id).textContent = text; $(id).hidden = !text; }
let toastTimer;
function toast(text) { clearTimeout(toastTimer);if(!text){$('toast').hidden=true;return;}$('toast').textContent = text; $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, 4200); }
function timestamp(value, full = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return '等待数据';
  return new Intl.DateTimeFormat('zh-CN', full ? { month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false } : {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value));
}
async function request(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options }); const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || '请求失败'), { status: response.status, policy: data.policy, notSubmitted: data.notSubmitted===true }); return data;
}
async function post(path, body, retried = false) {
  try { return await request(path, {method:'POST',headers:{'Content-Type':'application/json','X-Coop-UI':state.config.csrfToken},body:JSON.stringify(body)}); }
  catch (error) { if (error.status === 403 && !retried) { state.config = await request('/api/config'); return post(path,body,true); } throw error; }
}
async function copy(value) { try { await navigator.clipboard.writeText(value); toast('已复制'); } catch { toast('复制失败，请选中文本手动复制。'); } }
function remember() { try { localStorage.setItem('cooperation-workspace-v2',JSON.stringify({mode:state.mode,picks:state.picks,address:state.selectedAddress,expanded:[...state.expanded],known:[...state.known]})); } catch {} }
function ensureSelection() {
  if (!currentProject()) { state.picks[state.mode] = projects()[0]?.id || null; state.selectedAddress = null; }
  if (state.selectedAddress && !currentSession()) state.selectedAddress = null;
}
let navigationReturnFocus = null;
function setMobileNavigation(open, { content = false, animate = true } = {}) {
  const sidebar=$('sidebar'),main=document.querySelector('.main-pane'),mobile=matchMedia('(max-width:760px)').matches,wasOpen=sidebar.classList.contains('mobile-open');
  open=mobile&&open;document.body.classList.toggle('navigation-motion',animate);
  if(open&&!wasOpen)navigationReturnFocus=document.activeElement;
  sidebar.classList.toggle('mobile-open',open);sidebar.inert=mobile&&!open;main.inert=open;$('sidebar-scrim').hidden=!open;
  if(open){sidebar.setAttribute('role','dialog');sidebar.setAttribute('aria-modal','true');}
  else{sidebar.removeAttribute('role');sidebar.removeAttribute('aria-modal');}
  updateNavigationButton();
  if(open&&!wasOpen)requestAnimationFrame(()=>{if(sidebar.classList.contains('mobile-open'))$('sidebar-close').focus({preventScroll:true});});
  else if(wasOpen&&!open&&mobile){
    const target=content?$('workspace-title'):navigationReturnFocus?.isConnected?navigationReturnFocus:$('sidebar-toggle');
    if(content)target.tabIndex=-1;target.focus({preventScroll:true});
  }
}
function closeMobileNavigation(options) { setMobileNavigation(false,options); }
function updateNavigationButton() { $('sidebar-toggle').setAttribute('aria-expanded', String(matchMedia('(max-width:760px)').matches ? $('sidebar').classList.contains('mobile-open') : !document.body.classList.contains('sidebar-hidden'))); }
function selectProject(project, address = null) {
  const changed=state.picks[state.mode]!==project.id||state.selectedAddress!==address;
  state.picks[state.mode] = project.id; state.selectedAddress = address; state.selectedMessage = null;
  if(address)setTab('overview');
  state.expanded.add(state.mode+':'+project.id); remember(); renderNavigation(); renderWorkspace(); updateScope(); closeMobileNavigation({content:true});
  syncTabIndicator({animate:false});if(changed)revealPanel($(state.tab==='overview'?'inspector':'messages-panel'));
}
function setMode(mode) { const changed=state.mode!==mode;state.mode = mode; state.selectedAddress = null; ensureSelection(); remember(); renderNavigation(); renderWorkspace(); updateScope();if(changed)revealPanel($(state.tab==='overview'?'inspector':'messages-panel')); }
function setTab(tab) {
  const changed=state.tab!==tab;
  state.tab = tab;
  for (const key of ['overview','messages']) { $('tab-'+key).setAttribute('aria-selected',String(key===tab)); $('tab-'+key).tabIndex = key===tab ? 0 : -1; $(key+'-panel').hidden = key!==tab; }
  if (tab === 'messages') void loadMessages();
  syncTabIndicator();if(changed)revealPanel($(tab==='overview'?'inspector':'messages-panel'));
}
function matchesSearch(s, query) { return !query || [name(s),s.id,s.cwd,clientName(s.client)].some(v => String(v||'').toLocaleLowerCase().includes(query)); }
function renderNavigation() {
  const target = $('directory-tree'), scroll = target.scrollTop, tree = el('div'), query = $('session-search').value.trim().toLocaleLowerCase();
  $('mode-directories').setAttribute('aria-pressed',String(state.mode==='directories')); $('mode-custom').setAttribute('aria-pressed',String(state.mode==='custom'));
  $('navigation-label').textContent = state.mode==='custom' ? '我的分组' : '项目目录';
  $('add-project').setAttribute('aria-label',state.mode==='custom'?'新建自定义项目':'添加目录'); $('add-project').title=state.mode==='custom'?'新建自定义项目':'添加目录';
  $('connected-only').setAttribute('aria-pressed',String(state.connectedOnly));
  let rendered = 0;
  for (const project of projects()) {
    const key=state.mode+':'+project.id, title=projectName(project), all=projectMembers(project,state.sessions,state.mode);
    const projectMatch = query && (title+' '+(project.path||'')).toLocaleLowerCase().includes(query);
    const shown=all.filter(s=>(!state.connectedOnly||connected(s))&&(projectMatch||matchesSearch(s,query)));
    if (query && !projectMatch && !shown.length) continue;
    rendered++;
    const section=el('section','project-node'), head=el('div','project-heading'), active=project.id===state.picks[state.mode];section.dataset.renderKey=key;
    head.classList.toggle('active',active&&!state.selectedAddress);
    const expanded=Boolean(query)||state.expanded.has(key);
    const toggle=button('','project-toggle',()=>{ if(state.expanded.has(key))state.expanded.delete(key);else state.expanded.add(key);remember();renderNavigation(); });
    toggle.append(el('span','','›'));toggle.setAttribute('aria-expanded',String(expanded));toggle.setAttribute('aria-label','展开项目 '+title);
    const projectButton=button('','project-select',()=>selectProject(project)); projectButton.setAttribute('aria-label','查看项目 '+title);projectButton.title=project.path||title;
    projectButton.append(projectIcon(state.mode==='custom',expanded),el('span','project-name',title),el('span','count',String(shown.length)));
    const edit=button('···','icon-button',()=>state.mode==='custom'?openGroup(project):openDirectory(project));edit.setAttribute('aria-label','项目设置 '+title);edit.title='项目设置';
    head.append(toggle,projectButton,edit);section.append(head);
    const list=el('div','project-sessions');list.hidden=!expanded;list.inert=!expanded;list.setAttribute('aria-hidden',String(!expanded));
    for(const session of shown) {
      const row=button('','session-link',()=>selectProject(project,addressOf(session)));row.dataset.address=addressOf(session);
      row.setAttribute('aria-current',String(active&&state.selectedAddress===addressOf(session)));row.setAttribute('aria-label',name(session)+' · '+clientName(session.client));
      row.title=name(session)+'\n'+session.cwd+'\n'+(activities[activity(session)]||'待确认');
      row.append(el('span','dot '+(connected(session)?activity(session):'disconnected')),el('span','session-title',name(session)),el('span','session-client',clientName(session.client)));
      list.append(row);
    }
    if(!shown.length){
      const text=project.error?'目录暂不可访问':state.discoveryError?'会话发现失败，请刷新':!state.discoveryReady?'正在发现会话…':all.length?'已发现 '+all.length+' 个会话，当前筛选无匹配':state.mode==='custom'?'尚未选择成员':'尚未发现原生会话';
      list.append(el('p','nav-empty',text));
      if(all.length&&(query||state.connectedOnly))list.append(button('显示全部会话','text-button reset-filter',()=>{$('session-search').value='';state.connectedOnly=false;try{localStorage.setItem('cooperation-connected-only-v1','false');}catch{}renderNavigation();renderProjectOverview();updateScope();}));
      else if(state.discoveryError||project.error)list.append(button('重新发现','text-button reset-filter',()=>void loadSessions(true)));
      else if(state.discoveryReady&&state.mode==='directories')list.append(button('OpenCode 接入说明','text-button reset-filter',()=>showConnectionHelp('opencode',project.id)));
    }
    section.append(list);tree.append(section);
  }
  if(!rendered)tree.append(el('div','nav-empty',query?'没有匹配的项目或会话':state.mode==='custom'?'点击 ＋，为几个会话创建协作分组。':'点击 ＋，添加一个项目目录。'));
  reconcileChildren(target,tree.childNodes);target.scrollTop=scroll;
}
function visible() { return workspaceAddresses({project:currentProject(),sessions:state.sessions,mode:state.mode,selectedAddress:state.selectedAddress,onlyConnected:state.connectedOnly,directories:state.directories,bridge:state.bridge,online:state.online}); }
function updateScope() {
  const addresses=[...visible()].sort(), signature=JSON.stringify(addresses);
  $('message-scope').textContent=addresses.length?(state.selectedAddress?'当前会话':'当前项目 · '+addresses.length+' 个成员')+'的发送与接收记录':'当前范围没有可显示的会话';
  if(signature!==state.scope){state.scope=signature;state.selectedMessage=null;state.messages=[];renderMessages();void loadMessages();}
}
function renderWorkspace() {
  ensureSelection(); const project=currentProject(),session=currentSession();
  const contextKey=JSON.stringify([state.mode,project?.id,project&&projectName(project),project?.path,session&&addressOf(session),session?.name,session?.cwd,session?.missing,session?.directoryIds]);
  if(state.workspaceKey===contextKey){if(session)refreshCards();else renderProjectOverview();return;}
  state.workspaceKey=contextKey;state.cards.clear(); $('inspector').replaceChildren();$('workspace-actions').replaceChildren();
  $('project-crumb').textContent=project?projectName(project):'协作空间';$('session-crumb').textContent=session?' / '+name(session):'';
  $('workspace-kicker').textContent=session?clientName(session.client)+' · 会话':state.mode==='custom'?'自定义项目':'目录项目';
  $('workspace-title').textContent=session?name(session):project?projectName(project):state.mode==='custom'?'创建你的协作分组':'让会话井然有序';
  $('workspace-title').title=$('workspace-title').textContent;
  $('workspace-subtitle').textContent=session?session.cwd:project?state.mode==='custom'?'跨目录组合会话，专注当前协作。':project.path:'先添加目录，再挑选需要一起工作的会话。';
  $('workspace-subtitle').title=$('workspace-subtitle').textContent;
  $('tab-overview').textContent=session?'会话设置':'项目概览';
  if(!project){
    const empty=el('div','empty welcome');empty.append(el('span','empty-symbol','◈'),el('h3','',state.mode==='custom'?'为一个目标，组织几个会话':'从一个项目开始'),el('p','',state.mode==='custom'?'从已发现的会话中自由选择成员，给这次协作一个名字。':'添加工作目录，查看原生会话的连接、上下文和通信。'),button(state.mode==='custom'?'新建自定义项目':'添加目录','button primary',()=>state.mode==='custom'?openGroup():openDirectory()));
    if(state.mode==='custom')empty.append(button('添加会话来源目录','button',()=>openDirectory()));
    $('inspector').append(empty);return;
  }
  if(session){
    $('workspace-actions').append(button('复制地址','button',()=>copy(label(session))),button('新建分组','button',()=>openGroup(null,session)));
    if(session.missing)$('inspector').append(el('p','offline-note','此成员暂未在目录列表中发现。分组与通信历史仍保留，重新接入后恢复设置。'));
    $('inspector').append(buildCard(session));refreshCards();
  }else{
    $('workspace-actions').append(button(state.mode==='custom'?'编辑分组':'项目设置','button',()=>state.mode==='custom'?openGroup(project):openDirectory(project)));
    if(state.mode==='directories'){
      $('workspace-actions').append(button('创建协作分组','button primary',()=>openGroup(null,null,projectMembers(project,state.sessions))));
      if(state.config.lifecycle)$('workspace-actions').append(button('新建会话','button',()=>openLifecycle('create',project.path)),button('连接会话','button',()=>openLifecycle('connect',project.path)));
    }
    renderProjectOverview();
  }
}
function renderProjectOverview() {
  const project=currentProject();if(!project||state.selectedAddress)return;
  const list=members(), shown=list.filter(s=>!state.connectedOnly||connected(s)), target=$('inspector'),panel=el('div');
  const grid=el('div','overview-grid');
  for(const [caption,value]of [['项目成员',list.length],['已连接',list.filter(connected).length],['工作中',list.filter(s=>activity(s)==='running').length]]){const tile=el('div','summary-tile');tile.append(el('span','',caption),el('strong','',String(value)));grid.append(tile);}panel.append(grid);
  const heading=el('div','section-heading');heading.append(el('h2','','协作成员'),button('查看通信记录 →','text-button',()=>setTab('messages')));panel.append(heading);
  const cards=el('div','member-grid');
  for(const session of shown){
    const card=button('','member-card',()=>selectProject(project,addressOf(session))),top=el('span','member-card-title');card.dataset.address=addressOf(session);
    top.append(el('span','dot '+(connected(session)?activity(session):'disconnected')),el('strong','',name(session)),el('span','session-client',clientName(session.client)));
    const foot=el('span','member-card-footer'),u=session.monitoring?.usage,p=u?.contextWindowTokens>0&&Number.isFinite(u.usedTokens)?(u.usedTokens*100/u.contextWindowTokens).toFixed(1)+'% 上下文':openCodeContextState(session)?.label||'上下文待确认';
    foot.append(el('span','',session.missing?'暂未发现':activities[activity(session)]||'待确认'),el('span','',p));card.append(top,el('span','member-path',session.cwd),foot);cards.append(card);
  }
  if(!shown.length)cards.append(el('p','section-note',state.connectedOnly?'没有已连接的成员。可以关闭左侧“已连接”筛选。':'这里还没有成员。编辑分组来选择会话，或添加包含会话的目录。'));
  panel.append(cards);
  if(state.mode==='custom')panel.append(el('p','policy-hint','成员可来自不同目录；同一会话的设置在所有分组中保持一致。'));
  if(project.error)panel.append(el('p','notice error',project.error));
  reconcileChildren(target,panel.childNodes);
}
function defaults(s){return{softPercent:50,hardPercent:80,...state.config.policyDefaults[s.client]};}
function effective(s){return{autoCompress:autoCompressEnabled(s.policy),softPercent:s.policy?.softPercent??defaults(s).softPercent,hardPercent:s.policy?.hardPercent??defaults(s).hardPercent};}
function editor(session){
  const key=addressOf(session);if(state.editors.has(key))return state.editors.get(key);
  const value={draft:effective(session),status:'saved',editing:false,dirty:false,error:null};
  value.saver=new PolicySaver(async(policy,revision)=>(await post('/api/policies',{address:key,policy,expectedRevision:revision})).policy,(status,item)=>{
    if(!value.dirty){value.status=status;value.error=item.error?.message||null;}
    if(item.error?.status===409)value.saver.revision=item.error.policy?.revision||0;
    const current=state.sessions.find(s=>addressOf(s)===key);if(current&&(item.policy||item.error?.policy))current.policy=item.policy||item.error.policy;
    refreshCards();
  });value.saver.revision=session.policy?.revision||0;state.editors.set(key,value);return value;
}
function commit(session){const value=editor(session);value.editing=false;if(!validThresholds(Number(value.draft.softPercent),Number(value.draft.hardPercent))){value.status='error';value.error='阈值须满足 0 < 空闲阈值 < 强停阈值 < 100。';refreshCards();return;}value.draft.softPercent=Number(value.draft.softPercent);value.draft.hardPercent=Number(value.draft.hardPercent);value.dirty=false;void value.saver.save(value.draft);refreshCards();}
function buildCard(session){
  const key=addressOf(session),value=editor(session),card=el('section','session-card');card.dataset.address=key;
  const summary=el('div','session-summary'),head=el('div','session-head'),badge=el('span','activity-badge');head.append(el('h3','','上下文与状态'),badge);
  const usage=el('div','usage-summary'),amount=el('strong','usage-number','—'),info=el('div','usage-info'),tokens=el('span'),model=el('span');info.append(tokens,model);usage.append(amount,info);
  const meter=el('meter','usage-meter');meter.min=0;meter.max=100;meter.setAttribute('aria-label','上下文占用');
  const freshness=el('div','freshness'),identity=el('details','identity session-disclosure');identity.append(el('summary','','会话详情'),el('code','',session.id));summary.append(head,usage,meter,freshness,identity);
  const controls=el('div','compression-controls'),row=el('div','setting-row'),setting=el('div');setting.append(el('strong','','自动管理'),el('p','','保存进度、整理上下文并接续任务'));
  const toggle=button('','switch',()=>{value.draft.autoCompress=!value.draft.autoCompress;commit(session);});toggle.setAttribute('role','switch');toggle.setAttribute('aria-label','启用自动管理');toggle.setAttribute('aria-checked',String(value.draft.autoCompress));row.append(setting,toggle);controls.append(row);
  const thresholdSettings=el('details','threshold-settings'),thresholdHeading=el('summary'),thresholdSummary=el('span','threshold-summary');
  thresholdHeading.append(el('strong','','整理阈值'),thresholdSummary);thresholdSettings.append(thresholdHeading);controls.append(thresholdSettings);
  const fields={};
  for(const[field,caption,description]of[['softPercent','空闲时整理','达到后，等当前工作结束再整理'],['hardPercent','优先整理','达到后，暂停工作并先保存进度']]){
    const block=el('div','threshold'),top=el('div','threshold-top'),title=el('span','',caption);title.append(el('small','',description));
    const number=el('label','threshold-value'),input=el('input');input.type='number';input.min='.01';input.max='99.99';input.step='.01';input.value=value.draft[field];input.setAttribute('aria-label',caption+'数值');
    const range=el('input','threshold-range');range.type='range';range.min='.01';range.max='99.99';range.step='.01';range.value=value.draft[field];range.setAttribute('aria-label',caption+'滑动条');
    const edit=next=>{value.draft[field]=next;value.editing=true;value.dirty=true;value.status='editing';value.error=null;};
    input.addEventListener('focus',()=>value.editing=true);input.addEventListener('input',()=>{edit(input.value===''?NaN:Number(input.value));if(Number.isFinite(value.draft[field]))range.value=value.draft[field];saveStatus.textContent='编辑中';});
    const finish=()=>{if(value.dirty)commit(session);else value.editing=false;};input.addEventListener('blur',finish);input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();finish();input.blur();}});
    range.addEventListener('input',()=>{const other=Number(value.draft[field==='softPercent'?'hardPercent':'softPercent']);let n=Number(range.value);if(Number.isFinite(other))n=field==='softPercent'?Math.min(n,other-.01):Math.max(n,other+.01);n=Math.max(.01,Math.min(99.99,Math.round(n*100)/100));edit(n);input.value=n;range.value=n;saveStatus.textContent='松手后保存';});range.addEventListener('change',()=>commit(session));
    number.append(input,el('span','','%'));top.append(title,number);block.append(top,range);thresholdSettings.append(block);fields[field]={input,range};
  }
  const saveStatus=el('span','save-status'),validation=el('p','policy-error'),retry=button('重新保存','text-button',()=>commit(session));saveStatus.setAttribute('role','status');validation.setAttribute('role','alert');retry.hidden=true;validation.hidden=true;
  thresholdSettings.append(el('p','policy-hint','修改后自动保存。调低阈值可能立即开始整理。'));
  controls.append(saveStatus,validation,retry,el('p','policy-hint','额度不足时自动检测，确认可继续后恢复原任务。关闭自动管理即可停止自动继续。'));
  let contextTitle,contextHint;
  if(session.client==='opencode'){contextTitle=el('h3');contextHint=el('p','policy-hint');contextHint.setAttribute('role','status');controls.append(contextTitle,contextHint);}
  if(session.missing)for(const control of controls.querySelectorAll('input,button'))control.disabled=true;
  const extra=el('div','session-extra'),actions=el('div','session-actions'),cycle=el('div','cycle-controls');extra.setAttribute('aria-label','当前会话状态');extra.append(el('h3','status-eyebrow','当前状态'));
  actions.append(button('查看连接','button',()=>showConnectionHelp(session.client,state.directories.find(d=>d.id===session.directoryIds?.[0])?.id)),button('更新状态','button',async e=>{const target=e.currentTarget;target.disabled=true;try{await post('/api/runtime',{address:key,native:true});await loadMonitoring();}catch(error){toast(error.message);}finally{target.disabled=false;}}));
  if(session.missing)actions.lastChild.disabled=true;
  if(state.config.lifecycle&&session.client==='opencode'&&!connected(session))actions.append(button('连接此会话','button',()=>openLifecycle('connect',session.cwd,key)));
  extra.append(cycle,actions);card.append(extra,summary,controls);state.cards.set(key,{badge,amount,tokens,model,meter,freshness,toggle,fields,saveStatus,validation,retry,cycle,thresholdSettings,thresholdSummary,contextTitle,contextHint,signature:null});return card;
}
function refreshCards(){
  for(const [key,card]of state.cards){const session=members().find(s=>addressOf(s)===key);if(!session)continue;const value=editor(session),u=session.monitoring?.usage,r=session.monitoring?.runtime,a=activity(session),p=Number.isFinite(u?.usedTokens)&&u.contextWindowTokens>0?u.usedTokens*100/u.contextWindowTokens:null;
    setText(card.badge,activities[a]||'待确认');card.badge.className='activity-badge '+a;setText(card.amount,p===null?'—':p.toFixed(1)+'%');card.amount.className='usage-number '+(p>=value.draft.hardPercent?'high':p>=value.draft.softPercent?'warm':'');
    const contextState=openCodeContextState(session);if(contextState){setText(card.contextTitle,contextState.label);setText(card.contextHint,contextState.detail);}
    if(session.client==='opencode'){
      card.toggle.disabled=Boolean(session.missing)||r?.capabilities?.automaticMaintenance!==true&&!value.draft.autoCompress;
      card.toggle.title=card.toggle.disabled?'等待已接入维护能力的原生插件':'';
    }
    setText(card.tokens,Number.isFinite(u?.usedTokens)?u.usedTokens.toLocaleString()+' / '+(u.contextWindowTokens>0?u.contextWindowTokens.toLocaleString():'容量未知')+' tokens':contextState?.label||'等待有效上下文统计');setText(card.model,r?.model||u?.model||'模型待确认');
    card.meter.hidden=p===null;card.meter.value=p===null?0:Math.min(100,p);card.meter.low=value.draft.softPercent;card.meter.high=value.draft.hardPercent;card.meter.optimum=0;
    setText(card.freshness,(r?.connected?(u?'最近统计 · ':'状态检查 · '):'离线快照 · ')+timestamp(u?.measuredAt||u?.queriedAt||u?.observedAt||session.monitoring?.observedAt)+(u?.historyChangedAfterMeasurement?' · 上下文已有后续变化':''));card.toggle.setAttribute('aria-checked',String(value.draft.autoCompress));
    for(const[field,control]of Object.entries(card.fields))if(!value.editing&&document.activeElement!==control.input&&document.activeElement!==control.range){control.input.value=Number.isFinite(Number(value.draft[field]))?value.draft[field]:'';control.range.value=value.draft[field];}
    setText(card.saveStatus,({saved:'已保存',saving:'保存中…',editing:'编辑中',error:'保存失败'})[value.status]||'');card.saveStatus.className='save-status '+value.status;card.validation.hidden=!value.error;setText(card.validation,value.error||'');card.retry.hidden=value.status!=='error';
    setText(card.thresholdSummary,'空闲 '+value.draft.softPercent+'% · 优先 '+value.draft.hardPercent+'%');
    if(value.error&&!validThresholds(Number(value.draft.softPercent),Number(value.draft.hardPercent)))card.thresholdSettings.open=true;
    const q=session.monitoring?.quotaRecovery,c=session.cycle,signature=JSON.stringify([c,session.lastCycle,session.queueCount,session.queueState,q,r?.quota,r?.quotaRestart,r?.requiresReopen,r?.activity,r?.connected,session.policy]);if(signature===card.signature)continue;card.signature=signature;const panel=el('div');
    const quota=quotaView(session);
    if(r?.requiresReopen&&!quota)panel.append(el('p','cycle-title','接入需要更新'),el('p','cycle-reason',r.detail));
    if(quota) {
      panel.append(el('p','cycle-title',quota.title),el('p','cycle-reason',quota.description));
      if(quota.resetAt)panel.append(el('p','last-cycle','上次报告的额度重置时间 · '+timestamp(quota.resetAt,true)));
      if(quota.nextCheckAt)panel.append(el('p','last-cycle','下次检测 · '+timestamp(quota.nextCheckAt)));
    }
    if(!quota&&!c&&!r?.requiresReopen){
      const blocked=autoCompressEnabled(session.policy)&&(r?.capabilities?.automaticMaintenance===false||session.monitoring?.decision?.action==='disabled');
      const title=!r?.connected?'等待原会话连接':blocked?'自动管理暂未就绪':activities[a]||'正在核对会话状态';
      const reason=!r?.connected?'打开原会话后可重新读取状态。':a==='waiting_permission'||a==='waiting_input'?'请在原会话中处理确认，完成后会继续。':blocked?contextState?.detail||session.monitoring?.decision?.reason||'当前原生状态尚不支持自动管理，请先核对原会话。':a==='unknown'?'正在核对原生状态，确认就绪后再继续自动管理。':autoCompressEnabled(session.policy)?'自动管理已开启，会按当前设置整理上下文并检测额度恢复。':'自动管理未开启，可在下方设置中开启。';
      panel.append(el('p','cycle-title',title),el('p','cycle-reason',reason));
      if(session.queueCount)panel.append(el('p','last-cycle',session.queueCount+' 条消息等待发送。'));
    }
    if(c){const view=maintenanceView(c,r),progress=el('ol','maintenance-progress');progress.setAttribute('aria-label','维护进度');
      view.stages.forEach((title,index)=>{const step=el('li',index<view.index?'complete':index===view.index?'current':'',title);if(index===view.index)step.setAttribute('aria-current','step');progress.append(step);});
      panel.append(el('p','cycle-title',view.title),el('p','cycle-reason',view.description));
      if(session.queueCount)panel.append(el('p','last-cycle',session.queueCount+' 条消息将在维护完成后发送。'));
      const run=(action,title)=>{const control=button(title,action===view.primary?.action?'button primary':'text-button',async e=>{const target=e.currentTarget;
        if(action.startsWith('cancel-')&&!await confirmRemoval('结束这次维护？',action==='cancel-release'?'停止后续整理，并发送等待中的消息。':'停止后续整理，等待中的消息会保留，可稍后发送。','结束维护'))return;
        target.disabled=true;try{await post('/api/cycles/action',{id:c.id,action});await loadMonitoring();await loadMessages();toast('会话状态已检查');}catch(error){toast(error.message);}finally{target.disabled=false;}});control.dataset.renderKey='maintenance:'+c.id+':'+action;return control;};
      if(view.primary)panel.append(run(view.primary.action,view.primary.label));
      panel.append(progress);
      const options=el('details','maintenance-options session-disclosure');options.dataset.renderKey='options:'+c.id;options.append(el('summary','','更多操作'));
      if(view.paused&&['writing_handoff','restoring'].includes(c.previousState)&&view.primary?.action!=='retry')options.append(run('retry',c.previousState==='writing_handoff'?'重新请求保存进度':'重新请求恢复任务'));
      options.append(run('cancel-hold','结束维护，保留待处理消息'),run('cancel-release','结束维护并发送待处理消息'));panel.append(options);
      const details=el('details','maintenance-details session-disclosure'),diagnostic=maintenanceDiagnostic(session,c,r);details.dataset.renderKey='diagnostic:'+c.id;details.append(el('summary','','诊断详情'));
      if(c.reason)details.append(el('p','cycle-reason',c.reason));if(c.lastReceiptIssue)details.append(el('p','cycle-reason','最近一次确认：'+c.lastReceiptIssue.reason));
      details.append(button('复制诊断信息','text-button',()=>copy(JSON.stringify(diagnostic,null,2))),el('pre','diagnostic-data',JSON.stringify(diagnostic,null,2)));panel.append(details);
    }else if(session.lastCycle)panel.append(el('p','last-cycle','上次上下文维护 · '+(phases[session.lastCycle.state]||session.lastCycle.state)));
    if(session.queueState?.held)panel.append(button('释放保留消息','text-button',async()=>{try{await post('/api/queue/release',{address:key});await loadMonitoring();await loadMessages();}catch(error){toast(error.message);}}));
    const headline=panel.querySelector('.cycle-title');if(headline)headline.setAttribute('role','status');
    reconcileChildren(card.cycle,panel.childNodes);
  }
}
let lifecycleDraft = null;
const lifecycleStorage = 'cooperation-pending-session-operation-v1';
function lifecycleCapabilities(){
  const client=$('lifecycle-client').value;
  $('lifecycle-capability').textContent=lifecycleDraft?.action==='create'?state.config.lifecycle?.[client]?.detail||'能力待确认':'连接会保留原生 ID。Codex 和 Claude Code 当前需已有原生实例接入。';
}
function openLifecycle(action,directory,to=''){
  let pending;try{pending=JSON.parse(localStorage.getItem(lifecycleStorage));}catch{}
  lifecycleDraft=pending?.args?.requestId?pending:{action,args:{requestId:crypto.randomUUID(),directory,...(action==='create'?{client:'opencode'}:{to})}};
  action=lifecycleDraft.action;const args=lifecycleDraft.args;
  $('lifecycle-title').textContent=action==='create'?'新建原生会话':'连接原生会话';
  $('lifecycle-description').textContent=pending?'有待核对的会话操作，保留原参数继续核对。':'在当前项目的原生客户端中操作，完成后返回可用于通信的地址。';
  $('lifecycle-directory').value=args.directory;$('lifecycle-client').value=args.client||'opencode';$('lifecycle-name').value=args.title||'';$('lifecycle-address').value=args.to||'';
  $('lifecycle-create-fields').hidden=action!=='create';$('lifecycle-connect-fields').hidden=action!=='connect';$('lifecycle-address').required=action==='connect';
  for(const option of $('lifecycle-client').options)option.disabled=state.config.lifecycle?.[option.value]?.create!==true;
  for(const id of ['lifecycle-client','lifecycle-name','lifecycle-address'])$(id).disabled=Boolean(pending);
  $('lifecycle-submit').hidden=false;$('lifecycle-submit').disabled=false;$('lifecycle-submit').textContent=pending?'核对原操作':action==='create'?'新建会话':'连接会话';
  $('lifecycle-result').textContent='';$('lifecycle-copy').hidden=true;setError('lifecycle-error');lifecycleCapabilities();$('lifecycle-dialog').showModal();
}
$('lifecycle-client').addEventListener('change',lifecycleCapabilities);
$('lifecycle-form').addEventListener('submit',async e=>{
  e.preventDefault();const submit=$('lifecycle-submit');submit.disabled=true;setError('lifecycle-error');
  if(!lifecycleDraft.submitted){const args=lifecycleDraft.args; if(lifecycleDraft.action==='create'){args.client=$('lifecycle-client').value;const title=$('lifecycle-name').value.trim();if(title)args.title=title;else delete args.title;}else args.to=$('lifecycle-address').value.trim();lifecycleDraft.submitted=true;}
  try{localStorage.setItem(lifecycleStorage,JSON.stringify(lifecycleDraft));}catch{setError('lifecycle-error','无法保存操作编号，请先允许此页面使用本地存储。');submit.disabled=false;return;}
  for(const id of ['lifecycle-client','lifecycle-name','lifecycle-address'])$(id).disabled=true;
  try{
    const result=await post('/api/ui/lifecycle',{action:lifecycleDraft.action,args:lifecycleDraft.args});
    $('lifecycle-result').textContent=({created:'已创建',connected:'已连接',unknown:'结果待核对',unavailable:'暂不可连接',unsupported:'当前不支持',blocked:'暂不可操作'})[result.status]+'。'+(result.detail||'')+(result.address?'\n'+result.address:'');
    if(result.address){$('lifecycle-copy').hidden=false;$('lifecycle-copy').onclick=()=>copy(result.address);}
    if(result.status==='unknown')submit.textContent='核对原操作';
    else{localStorage.removeItem(lifecycleStorage);submit.hidden=true;}
    if(['created','connected'].includes(result.status))await loadSessions(true);
  }catch(error){setError('lifecycle-error',error.message+' 操作编号：'+lifecycleDraft.args.requestId);submit.textContent='核对原操作';
    if(error.notSubmitted){localStorage.removeItem(lifecycleStorage);lifecycleDraft.submitted=false;for(const id of ['lifecycle-client','lifecycle-name','lifecycle-address'])$(id).disabled=false;submit.textContent='重新提交';}
  }
  finally{submit.disabled=false;}
});
function adoptProjects(){for(const mode of ['directories','custom'])for(const p of mode==='custom'?state.groups:state.directories){const key=mode+':'+p.id;if(!state.known.has(key)){state.known.add(key);state.expanded.add(key);}}ensureSelection();}
async function loadGroups(){try{const result=await request('/api/groups');if(JSON.stringify(result.groups)!==JSON.stringify(state.groups)){state.groups=result.groups;adoptProjects();renderNavigation();if(state.mode==='custom'){renderWorkspace();updateScope();}}}catch(error){toast(error.message);}}
async function loadSessions(force=false){
  if(state.discoveryBusy||state.closed)return;state.discoveryBusy=true;
  try{
    const [dirs,groups]=await Promise.all([request('/api/directories'),request('/api/groups')]);
    const result=await post('/api/sessions',{directoryIds:dirs.directories.map(d=>d.id)});if(state.closed)return;
    const signature=JSON.stringify([dirs.directories,groups.groups,result.sessions.map(s=>[s.client,s.id,s.name,s.cwd,s.directoryIds])]);
    for(const session of result.sessions){const old=state.sessions.find(s=>addressOf(s)===addressOf(session));if(old){session.monitoring=old.monitoring||session.monitoring;if((old.policy?.revision||0)>(session.policy?.revision||0))session.policy=old.policy;}}
    state.directories=dirs.directories;state.groups=groups.groups;state.sessions=result.sessions;state.discoveryReady=true;state.discoveryError=null;
    for(const d of state.directories)d.error=result.directories?.find(r=>r.id===d.id)?.error;
    adoptProjects();if(signature!==state.signature){state.signature=signature;renderNavigation();renderWorkspace();updateScope();}else renderNavigation();
    await loadMonitoring();setError('global-error',result.warnings?.join(' · ')||'');
  }catch(error){state.discoveryError=error.message;setError('global-error','发现会话失败：'+error.message);renderNavigation();}finally{state.discoveryBusy=false;}
}
let monitoringBusy=false;
const restartConfirmation = setupRestartConfirmation({ post, toast });
async function loadMonitoring(){if(state.closed||monitoringBusy)return;monitoringBusy=true;const restartRevision=restartConfirmation.revision();try{const result=await request('/api/monitoring',{signal:AbortSignal.timeout(8000)});if(state.closed)return;setServiceOnline(true);for(const sample of result.sessions){const s=state.sessions.find(s=>addressOf(s)===addressOf(sample.session));if(!s)continue;if((sample.policy?.revision||0)<(s.policy?.revision||0))sample.policy=s.policy;Object.assign(s,{monitoring:sample,policy:sample.policy,cycle:sample.cycle,lastCycle:sample.lastCycle,queueCount:sample.queueCount,queueState:sample.queueState});const value=state.editors.get(addressOf(s));if(value&&!value.editing&&!value.saver.running&&value.status!=='error'){value.draft=effective(s);value.saver.revision=s.policy?.revision||0;}}
    if(result.bootId && result.bootId!==state.config.bootId)state.config=await request('/api/config');
    restartConfirmation.update(result,restartRevision);
    refreshCards();const navSig=JSON.stringify(state.sessions.map(s=>[addressOf(s),activity(s),connected(s)]));if(navSig!==state.navSig){state.navSig=navSig;renderNavigation();updateScope();}if(!state.selectedAddress)renderProjectOverview();if(state.connectionHelp)renderConnectionHelp();
  }catch{void checkServiceHealth();}finally{monitoringBusy=false;}}
function statusBadge(status){return el('span','delivery-badge '+status,delivery[status]||'待确认');}
function routePart(s,direction){const row=el('div','message-route');row.append(el('span','route-direction',direction),el('strong','',name(s)),el('span','route-client',clientName(s.client)));row.title=label(s);return row;}
function renderDetail(message){const target=$('message-detail'),panel=el('div'),scroll=target.dataset.messageId===message?.id?target.scrollTop:0;target.dataset.messageId=message?.id||'';$('messages-panel').classList.toggle('detail-open',Boolean(message));if(!message){const empty=el('div','detail-empty');empty.append(el('span','detail-symbol','↗'),el('h3','','选择一条通信'),el('p','','在这里阅读完整消息。'));panel.append(empty);reconcileChildren(target,panel.childNodes);return;}
  panel.append(button('‹ 返回通信列表','text-button detail-back',()=>{state.selectedMessage=null;renderMessages();revealPanel(document.querySelector('.message-feed'));}));const heading=el('div','detail-heading');heading.append(el('h3','','消息详情'),statusBadge(message.status));const meta=el('dl','detail-meta');
  for(const[title,value]of[['发送方',label(message.from)],['接收方',label(message.to)],['发送时间',timestamp(message.createdAt,true)],['消息 ID',message.id]]){const row=el('div');row.append(el('dt','',title),el('dd','',value));meta.append(row);}const body=el('pre','message-body',message.text);body.dataset.renderKey=message.id;panel.append(heading,meta,body,button('复制正文','button',()=>copy(message.text)));
  if(message.error)panel.append(el('p','notice error',message.error));if(message.detail)panel.append(el('p','detail-note',message.detail));panel.append(el('p','detail-note',message.status==='submitted'?'消息已交给接收会话，回复会显示在原会话中。':message.status==='queued'?'消息已保存，接收会话可用后会按顺序发送。':''));
  if(message.status==='unknown')for(const[outcome,title]of[['submitted','确认已送达，继续队列'],['not_submitted','确认未送达，重新发送']])panel.append(button(title,'button',async()=>{try{await post('/api/messages/resolve',{id:message.id,outcome});await loadMessages();}catch(error){toast(error.message);}}));
  reconcileChildren(target,panel.childNodes);target.scrollTop=scroll;
}
function renderMessages(){const addresses=visible(),query=$('message-search').value.trim().toLocaleLowerCase(),filter=$('message-status').value;
  const messages=state.messages.filter(m=>messageMatches(m,addresses)&&(filter==='all'||m.status===filter)&&(!query||[m.text,label(m.from),label(m.to)].some(t=>t.toLocaleLowerCase().includes(query))));
  const list=el('ul');$('message-count').textContent=messages.length;$('message-empty').hidden=messages.length>0;$('message-empty').replaceChildren(el('span','empty-symbol','⇄'),el('h3','','暂无通信记录'),el('p','',addresses.size?'这里展示当前会话或项目的发送与接收记录。':'在左侧选择项目或会话。'));
  for(const message of messages){const li=el('li'),row=button('','message-row',()=>{const changed=state.selectedMessage!==message.id;state.selectedMessage=message.id;renderMessages();if(changed)revealPanel($('message-detail'));});li.dataset.renderKey=message.id;row.setAttribute('aria-pressed',String(state.selectedMessage===message.id));row.setAttribute('aria-label',name(message.from)+' → '+name(message.to));const top=el('div','message-row-top');top.append(el('time','',timestamp(message.createdAt,true)),statusBadge(message.status));row.append(top,routePart(message.from,'从'),routePart(message.to,'到'),el('p','message-preview',message.text));li.append(row);list.append(li);}
  reconcileChildren($('message-list'),list.childNodes);
  const selected=messages.find(m=>m.id===state.selectedMessage);if(!selected)state.selectedMessage=null;renderDetail(selected);
}
async function loadMessages(){const id=++state.messageRequest,addresses=[...visible()];if(!addresses.length){state.messages=[];renderMessages();return;}try{const result=await request('/api/messages?'+new URLSearchParams({addresses:JSON.stringify(addresses)}));if(id!==state.messageRequest||state.closed)return;state.messages=result.messages;renderMessages();setError('message-error');}catch(error){if(id===state.messageRequest)setError('message-error',error.message);}}
function showConnectionHelp(client,directoryId){state.connectionHelp={client,directoryId};renderConnectionHelp();$('connection-dialog').showModal();}
function renderConnectionHelp(){const c=state.connectionHelp;if(!c)return;const directory=state.directories.find(d=>d.id===c.directoryId),status=directoryConnection({client:c.client,directory,sessions:state.sessions,bridge:state.bridge,online:state.online}),guide=connectionGuidance({client:c.client,directory,status,installationDirectory:state.config.installationDirectory});
  $('connection-help-title').textContent=guide.title;$('connection-help-scope').textContent=guide.scope;$('connection-help-summary').textContent=guide.summary;$('connection-help-steps').replaceChildren();
  for(const step of guide.steps){const li=el('li'),content=el('div','connection-step');content.append(el('h3','',step.title),el('p','',step.text));li.append(content);$('connection-help-steps').append(li);}$('connection-help-note').textContent=guide.note||'';
  $('connection-help-steps').hidden=!guide.steps.length;$('connection-help-note').hidden=!guide.note;
  $('connection-primary').textContent=guide.primary.label;$('connection-primary').dataset.action=guide.primary.action;
  $('connection-recheck').hidden=guide.primary.action==='recheck';
  $('connection-diagnostic').onclick=()=>copy(JSON.stringify({client:c.client,serviceOnline:state.online,status:status.reason,connected:status.connected,total:status.total,version:state.config.version},null,2));
}
function renderBridge(status){state.bridge=status;const display=directoryConnection({client:'codex',bridge:status,online:state.online});$('codex-connection').textContent='Codex '+display.label;$('codex-connection').className='bridge-status '+display.tone;renderNavigation();updateScope();if(state.connectionHelp)renderConnectionHelp();}
async function loadBridge(force=false){try{const bridge=await request('/api/bridge'+(force?'?refresh=1':''),{signal:AbortSignal.timeout(12000)});if(state.closed)return;setServiceOnline(true);renderBridge(bridge);}catch{void checkServiceHealth();}}
let eventStreamOnline=false,healthBusy=false,serviceSuccessRevision=0;
function setServiceOnline(online){
  if(state.closed)return;
  if(online)serviceSuccessRevision++;
  const changed=state.online!==online;state.online=online;
  $('connection-dot').className='dot '+(online?'connected':'disconnected');
  $('connection-label').textContent=online?(eventStreamOnline?'本地服务在线':'服务在线 · 实时通知重连中'):'本地服务暂不可达';
  if(changed)renderBridge(state.bridge);
}
async function checkServiceHealth(){
  if(healthBusy||state.closed)return;healthBusy=true;const revision=serviceSuccessRevision;
  try{const bridge=await request('/api/bridge',{signal:AbortSignal.timeout(5000)});if(state.closed)return;setServiceOnline(true);renderBridge(bridge);}
  catch{if(revision===serviceSuccessRevision)setServiceOnline(false);}
  finally{healthBusy=false;}
}
function openDirectory(directory){state.directoryDraft=directory?{...directory}:null;$('directory-title').textContent=directory?'项目设置':'添加目录';$('directory').value=directory?.path||'';$('directory').readOnly=Boolean(directory);$('directory-label').value=directory?.label===directory?.path?'':directory?.label||'';$('recursive').setAttribute('aria-checked',String(directory?.recursive===true));$('directory-control').setAttribute('aria-checked',String(directory?.claudeControlEnabled===true));$('directory-control-row').hidden=!directory;$('remove-directory').hidden=!directory;setError('directory-error');$('directory-dialog').showModal();}
function openGroup(group,session,initial=[]){state.groupDraft={id:group?.id,revision:group?.revision||0,members:new Map((group?.members||initial).map(s=>[addressOf(s),s]))};if(session)state.groupDraft.members.set(addressOf(session),session);$('group-title').textContent=group?'编辑自定义项目':'新建自定义项目';$('group-name').value=group?.name||'';$('member-search').value='';$('delete-group').hidden=!group;setError('group-error');renderMemberPicker();$('group-dialog').showModal();}
function renderMemberPicker(){const draft=state.groupDraft;if(!draft)return;const available=new Map(state.sessions.map(s=>[addressOf(s),s]));for(const[address,s]of draft.members)if(!available.has(address))available.set(address,s);const query=$('member-search').value.trim().toLocaleLowerCase(),focused=document.activeElement?.closest('.member-choice')?.dataset.address,scroll=$('member-list').scrollTop;$('member-list').replaceChildren();let count=0;
  for(const[address,s]of available){if(!matchesSearch(s,query))continue;count++;const picked=draft.members.has(address),choice=button('','member-choice',()=>{if(draft.members.has(address))draft.members.delete(address);else draft.members.set(address,s);renderMemberPicker();});choice.setAttribute('aria-pressed',String(picked));choice.setAttribute('aria-label','选择 '+name(s)+' · '+clientName(s.client));choice.dataset.address=address;const info=el('span','member-choice-info'),title=el('span');title.append(el('strong','',name(s)),el('span','session-client',clientName(s.client)));info.append(title,el('small','',s.cwd||s.id));choice.append(info,el('span','selection-mark',picked?'✓':'＋'));$('member-list').append(choice);}
  if(!count)$('member-list').append(el('p','nav-empty',state.sessions.length?'没有匹配的会话':'请先在目录模式添加会话来源目录。'));$('member-count').textContent='已选 '+draft.members.size;
  $('member-list').scrollTop=scroll;if(focused)[...$('member-list').children].find(node=>node.dataset.address===focused)?.focus({preventScroll:true});
}
function confirmRemoval(title,description,actionLabel='确认移除'){return new Promise(resolve=>{const dialog=$('confirm-dialog');$('confirm-title').textContent=title;$('confirm-description').textContent=description;$('confirm-form').querySelector('[type=submit]').textContent=actionLabel;dialog.returnValue='';const close=()=>{dialog.removeEventListener('close',close);resolve(dialog.returnValue==='confirmed');};dialog.addEventListener('close',close);dialog.showModal();});}
$('confirm-form').addEventListener('submit',e=>{e.preventDefault();$('confirm-dialog').close('confirmed');});
for(const node of document.querySelectorAll('[data-close]'))node.addEventListener('click',()=>$(node.dataset.close).close());
for(const id of ['recursive','directory-control'])$(id).addEventListener('click',()=>$(id).setAttribute('aria-checked',String($(id).getAttribute('aria-checked')!=='true')));
$('directory-form').addEventListener('submit',async e=>{e.preventDefault();const save=$('save-directory');save.disabled=true;setError('directory-error');try{const result=await post('/api/directories',{path:$('directory').value.trim(),label:$('directory-label').value.trim(),recursive:$('recursive').getAttribute('aria-checked')==='true'});state.directories=result.directories;
  if(state.directoryDraft&&($('directory-control').getAttribute('aria-checked')==='true')!==state.directoryDraft.claudeControlEnabled)await post('/api/directories/claude-control',{id:result.directory.id,enabled:$('directory-control').getAttribute('aria-checked')==='true'});
  $('directory-dialog').close();if(state.mode==='directories')state.picks.directories=result.directory.id;await loadSessions(true);toast('项目已保存');}catch(error){setError('directory-error',error.message);}finally{save.disabled=false;}});
$('remove-directory').addEventListener('click',async()=>{const d=state.directoryDraft;if(!d||!await confirmRemoval('移除这个目录？','会话、通信历史和自定义分组成员会保留。'))return;try{await post('/api/directories/remove',{id:d.id});$('directory-dialog').close();await loadSessions(true);}catch(error){setError('directory-error',error.message);}});
$('group-form').addEventListener('submit',async e=>{e.preventDefault();const draft=state.groupDraft;if(!draft)return;$('save-group').disabled=true;setError('group-error');try{const result=await post('/api/groups',{id:draft.id,name:$('group-name').value.trim(),members:[...draft.members.keys()],expectedRevision:draft.revision});state.groups=result.groups;$('group-dialog').close();state.mode='custom';state.picks.custom=result.group.id;state.selectedAddress=null;adoptProjects();remember();renderNavigation();renderWorkspace();updateScope();toast('自定义项目已保存');}catch(error){setError('group-error',error.message);}finally{$('save-group').disabled=false;}});
$('delete-group').addEventListener('click',async()=>{const draft=state.groupDraft;if(!draft?.id||!await confirmRemoval('删除这个分组？','仅移除分组，会话、设置和通信历史会保留。'))return;try{const result=await post('/api/groups/remove',{id:draft.id,expectedRevision:draft.revision});state.groups=result.groups;$('group-dialog').close();ensureSelection();remember();renderNavigation();renderWorkspace();updateScope();}catch(error){setError('group-error',error.message);}});
$('member-search').addEventListener('input',renderMemberPicker);
$('mode-directories').addEventListener('click',()=>setMode('directories'));$('mode-custom').addEventListener('click',()=>setMode('custom'));
$('add-project').addEventListener('click',()=>state.mode==='custom'?openGroup():openDirectory());$('project-crumb').addEventListener('click',()=>{const p=currentProject();if(p)selectProject(p);});
for(const tab of ['overview','messages'])$('tab-'+tab).addEventListener('click',()=>setTab(tab));
document.querySelector('.workspace-tabs').addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const tab=e.key==='Home'?'overview':e.key==='End'?'messages':state.tab==='overview'?'messages':'overview';setTab(tab);$('tab-'+tab).focus();}});
$('session-search').addEventListener('input',renderNavigation);$('refresh-all').addEventListener('click',async e=>{const target=e.currentTarget;target.disabled=true;try{await loadBridge(true);await loadSessions(true);}finally{target.disabled=false;}});
$('collapse-all').addEventListener('click',()=>{for(const p of projects())state.expanded.delete(state.mode+':'+p.id);$('session-search').value='';remember();renderNavigation();});
$('connected-only').addEventListener('click',()=>{state.connectedOnly=!state.connectedOnly;try{localStorage.setItem('cooperation-connected-only-v1',String(state.connectedOnly));}catch{}renderNavigation();if(!state.selectedAddress)renderProjectOverview();updateScope();});
$('message-search').addEventListener('input',renderMessages);$('message-status').addEventListener('change',renderMessages);
$('codex-connection').addEventListener('click',()=>showConnectionHelp('codex'));$('connection-dialog').addEventListener('close',()=>state.connectionHelp=null);
$('connection-recheck').addEventListener('click',async e=>{const target=e.currentTarget;target.disabled=true;try{await loadBridge(true);await loadSessions(true);renderConnectionHelp();}finally{target.disabled=false;}});
$('connection-primary').addEventListener('click',async e=>{const target=e.currentTarget,action=target.dataset.action;
  if(action==='done'){$('connection-dialog').close();return;}
  if(action==='settings'){const directory=state.directories.find(d=>d.id===state.connectionHelp?.directoryId);$('connection-dialog').close();openDirectory(directory);return;}
  target.disabled=true;try{await loadBridge(true);await loadSessions(true);renderConnectionHelp();}finally{target.disabled=false;}
});
$('sidebar-toggle').addEventListener('click',()=>{if(matchMedia('(max-width:760px)').matches)setMobileNavigation(!$('sidebar').classList.contains('mobile-open'));else document.body.classList.toggle('sidebar-hidden');updateNavigationButton();});
$('sidebar-close').addEventListener('click',()=>closeMobileNavigation());$('sidebar-scrim').addEventListener('click',()=>closeMobileNavigation());
window.addEventListener('resize',()=>setMobileNavigation(matchMedia('(max-width:760px)').matches&&$('sidebar').classList.contains('mobile-open'),{animate:false}));
document.addEventListener('keydown',e=>{
  if(document.querySelector('dialog[open]')||!$('sidebar').classList.contains('mobile-open'))return;
  if(e.key==='Escape'){e.preventDefault();closeMobileNavigation();return;}
  if(e.key==='Tab'){
    const items=[...$('sidebar').querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),[tabindex]')].filter(n=>n.tabIndex>=0&&n.getClientRects().length&&!n.closest('[hidden]'));
    const first=items[0],last=items.at(-1),outside=!$('sidebar').contains(document.activeElement);
    if(!items.length){e.preventDefault();return;}
    if(e.shiftKey&&(outside||document.activeElement===first)){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&(outside||document.activeElement===last)){e.preventDefault();first.focus();}
  }
});
let discoverTimer,monitorTimer,messageTimer,eventMonitorTimer,eventMessageTimer;
function connectEvents(){state.events=new EventSource('/api/events');state.events.addEventListener('open',()=>{eventStreamOnline=true;setServiceOnline(true);void loadBridge();void loadMonitoring();void loadGroups();});state.events.addEventListener('error',()=>{eventStreamOnline=false;setServiceOnline(state.online);void checkServiceHealth();});state.events.addEventListener('bridge',e=>{try{renderBridge(JSON.parse(e.data));}catch{}});state.events.addEventListener('groups',()=>void loadGroups());state.events.addEventListener('management',()=>{if(!eventMonitorTimer)eventMonitorTimer=setTimeout(()=>{eventMonitorTimer=null;void loadMonitoring();},200);});state.events.addEventListener('message',()=>{clearTimeout(eventMessageTimer);eventMessageTimer=setTimeout(loadMessages,200);});}
window.addEventListener('pagehide',()=>{state.closed=true;state.events?.close();for(const t of [discoverTimer,monitorTimer,messageTimer,eventMonitorTimer,eventMessageTimer])clearTimeout(t);});
try{
  try{const saved=JSON.parse(localStorage.getItem('cooperation-workspace-v2'));if(saved){state.mode=saved.mode==='custom'?'custom':'directories';state.picks=saved.picks||state.picks;state.selectedAddress=saved.address||null;state.expanded=new Set(saved.expanded||[]);state.known=new Set(saved.known||[]);}state.connectedOnly=localStorage.getItem('cooperation-connected-only-v1')==='true';}catch{}
  state.config=await request('/api/config');$('version').textContent='v'+state.config.version;state.directories=state.config.directories||[];state.bridge=state.config.bridge?.codexStatus;await loadSessions(true);renderBridge(state.bridge);connectEvents();setMobileNavigation(false,{animate:false});
  discoverTimer=setInterval(loadSessions,15000);monitorTimer=setInterval(loadMonitoring,2500);messageTimer=setInterval(loadMessages,10000);
}catch(error){setError('global-error','无法连接本地管理服务：'+error.message);$('connection-label').textContent='服务未连接';}

setupPromptEditor({ request, post, toast });
