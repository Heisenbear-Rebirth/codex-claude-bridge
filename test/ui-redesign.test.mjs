import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { visibleAddresses, messageMatches, autoCompressEnabled, validThresholds, PolicySaver, directoryConnection, connectionGuidance, sessionConnected } from '../public/ui-state.mjs';
import { ContextMonitor } from '../src/context-monitor.mjs';
import { ManagementStore } from '../src/management-store.mjs';
import { CooperationService } from '../src/service.mjs';
import { startServer } from '../src/http-server.mjs';
const idA='11111111-1111-4111-8111-111111111111',idB='22222222-2222-4222-8222-222222222222';
test('visible tree leaf union matches sender or recipient, excludes closed groups and deduplicates overlap',()=>{
  const dirs=[{id:'a'},{id:'b'}],sessions=[{client:'claude',id:idA,name:'A',directoryIds:['a','b']},{client:'codex',id:idB,name:'B',directoryIds:['a']}];
  const open=new Set(['a']),groups=new Set(['a:claude','a:codex','b:claude']);
  assert.equal(visibleAddresses(dirs,sessions,open,groups).size,2);
  groups.delete('a:codex');
  const v=visibleAddresses(dirs,sessions,open,groups);
  assert.deepEqual([...v],['claude:'+idA]);
  assert.equal(messageMatches({from:sessions[1],to:sessions[0]},v),true);
  assert.equal(messageMatches({from:sessions[1],to:sessions[1]},v),false);
  open.add('b');assert.equal(visibleAddresses(dirs,sessions,open,groups).size,1);
  open.clear();assert.equal(visibleAddresses(dirs,sessions,open,groups).size,0);
  assert.equal(visibleAddresses(dirs,sessions,new Set(['a']),groups,'B').size,0);
});
test('old observe-only policies do not become automatic when controls are merged',()=>{
  assert.equal(autoCompressEnabled({enabled:true,mode:'observe'}),false);
  assert.equal(autoCompressEnabled({enabled:true,mode:'automatic'}),true);
  assert.equal(autoCompressEnabled({enabled:false,mode:'automatic'}),false);
  assert.equal(validThresholds(50,80),true);assert.equal(validThresholds(80,50),false);assert.equal(validThresholds(NaN,80),false);
});
test('autosave serializes rapid edits, carries revision and retains the final intended value',async()=>{
  const sent=[],events=[];let release;
  const saver=new PolicySaver(async(value,revision)=>{
    sent.push({value,revision});
    if(sent.length===1)await new Promise(resolve=>release=resolve);
    return {...value,revision:revision+1};
  },(status,item)=>events.push({status,item}));
  const first=saver.save({softPercent:40});await saver.save({softPercent:42});await saver.save({softPercent:44});
  assert.equal(sent.length,1);release();await first;
  assert.deepEqual(sent.map(s=>s.value.softPercent),[40,44]);assert.deepEqual(sent.map(s=>s.revision),[0,1]);
  assert.equal(events.at(-1).status,'saved');assert.equal(events.at(-1).item.policy.softPercent,44);
});
test('autosave failure is visible and does not blindly replay queued changes',async()=>{
  const statuses=[];const saver=new PolicySaver(async()=>{throw new Error('offline');},status=>statuses.push(status));
  await saver.save({autoCompress:true});assert.deepEqual(statuses,['saving','error']);assert.equal(saver.running,false);
});
test('discovered sessions update context without any policy; disabling automatic compression keeps observation running',async t=>{
  const root=await mkdtemp(join(resolve('.'),'.ui-monitor-test-'));
  const store=await new ManagementStore(join(root,'.cooperation')).init();store.saveDirectory({path:root,normalized:root.toLowerCase()});
  const session={client:'claude',id:idA,name:'observed',cwd:root};let used=100,calls=0;
  const service=new CooperationService({store,adapters:{claude:{list:async()=>({sessions:[session],warnings:[]})}}});
  const monitor=new ContextMonitor({store,service,runtimeFactory:()=>({status:async()=>{calls++;return{connected:true,activity:'idle',usage:{usedTokens:used,contextWindowTokens:1000,source:'fixture',measuredAt:new Date().toISOString()}};},close(){}})});
  t.after(async()=>{monitor.close();store.close();await rm(root,{recursive:true,force:true});});
  await monitor.observeAll();assert.equal(store.getSnapshot(session).usage.usedTokens,100);assert.equal(store.getPolicy(session),null);
  store.savePolicy(session,{enabled:false,mode:'automatic'});used=150;monitor.nextSampleAt.clear();
  await monitor.observeAll();assert.equal(store.getSnapshot(session).usage.usedTokens,150);assert.equal(calls,2);
  const size = JSON.stringify(store.getSnapshot(session)).length;
  for (let i = 0; i < 4; i++) {
    monitor.discoveryAt = 0; monitor.nextSampleAt.clear(); await monitor.observeAll();
    const sample = store.getSnapshot(session);
    assert.equal(sample.session.monitoring, undefined);
    assert.equal(sample.session.policy, undefined);
    assert.equal(JSON.stringify(sample).length, size);
  }
});
test('HTTP autosave maps one checkbox, rejects stale edits and filters messages by exact participants',async t=>{
  const root=await mkdtemp(join(resolve('.'),'.ui-http-test-'));
  const a={client:'claude',id:idA,name:'A',cwd:root},b={client:'codex',id:idB,name:'B',cwd:root};
  const server=await startServer({root,port:0,startMonitoring:false,adapters:{claude:{find:async()=>a},codex:{find:async()=>b}}});
  t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true});});
  const config=await(await fetch(server.url+'/api/config')).json();
  const save=body=>fetch(server.url+'/api/policies',{method:'POST',headers:{'Content-Type':'application/json','X-Coop-UI':config.csrfToken},body:JSON.stringify(body)});
  let response=await save({address:'claude:'+idA,expectedRevision:0,policy:{autoCompress:false,softPercent:51,hardPercent:81}});
  const first=(await response.json()).policy;assert.equal(first.enabled,false);assert.equal(first.mode,'automatic');
  response=await save({address:'claude:'+idA,expectedRevision:0,policy:{autoCompress:true}});assert.equal(response.status,409);assert.equal(server.store.getPolicy(a).enabled,false);
  response=await save({address:'claude:'+idA,expectedRevision:first.revision,policy:{autoCompress:true}});assert.equal((await response.json()).policy.enabled,true);
  const record=(id,from,to)=>({id,from,to,text:id,createdAt:new Date().toISOString(),status:'submitted'});
  server.store.create(record('incoming',b,a));server.store.create(record('outgoing',a,b));server.store.create(record('unrelated',b,b));
  const messages=async addresses=>(await(await fetch(server.url+'/api/messages?'+new URLSearchParams({addresses:JSON.stringify(addresses)}))).json()).messages;
  assert.deepEqual((await messages(['claude:'+idA])).map(m=>m.id).sort(),['incoming','outgoing']);
  assert.equal((await messages([])).length,0);
});


test('Claude connection is per directory and permission alone is not a live connection', () => {
  const directory = { id: 'a', path: 'E:/Work/A', claudeControlEnabled: true };
  const session = { client: 'claude', id: idA, cwd: directory.path, directoryIds: ['a'], monitoring: { runtime: { connected: false } } };
  assert.equal(directoryConnection({ client: 'claude', directory, sessions: [session] }).reason, 'claude_session');
  session.monitoring.runtime.connected = true;
  let status = directoryConnection({ client: 'claude', directory, sessions: [session, session] });
  assert.equal(status.connected, 1); assert.equal(status.total, 1);
  const other = { ...directory, id: 'b', path: 'E:/Work/B' };
  assert.equal(directoryConnection({ client: 'claude', directory: other, sessions: [session] }).connected, 0);
  directory.claudeControlEnabled = false;
  assert.equal(directoryConnection({ client: 'claude', directory, sessions: [session] }).reason, 'claude_access');
});
test('recursive directory status uses the actual child control permission and excludes stale snapshots', () => {
  const directory = { id: 'a', path: 'E:/Work', recursive: true, claudeControlEnabled: false };
  const session = { client: 'claude', id: idA, cwd: 'E:/Work/Child', directoryIds: ['a'], controlAccess: { directoryEnabled: true }, monitoring: { observedAt: '2026-09-09T00:00:00Z', runtime: { connected: true } } };
  assert.equal(directoryConnection({ client: 'claude', directory, sessions: [session], now: Date.parse('2026-09-09T00:00:20Z') }).connected, 1);
  assert.equal(directoryConnection({ client: 'claude', directory, sessions: [session], now: Date.parse('2026-09-09T00:02:00Z') }).reason, 'checking');
});
test('Codex directory readiness distinguishes a missing message bridge from an unopened task', () => {
  const directory = { id: 'a', path: 'E:/Work' };
  const session = { client: 'codex', id: idA, directoryIds: ['a'], monitoring: { runtime: { connected: true } } };
  assert.equal(directoryConnection({ client: 'codex', directory, sessions: [session], bridge: { connected: false } }).reason, 'codex_bridge');
  assert.equal(directoryConnection({ client: 'codex', directory, sessions: [session], bridge: { connected: true } }).connected, 1);
  session.monitoring.runtime.connected = false;
  assert.equal(directoryConnection({ client: 'codex', directory, sessions: [session], bridge: { connected: true } }).reason, 'codex_session');
  assert.equal(directoryConnection({ client: 'codex', bridge: { connected: true } }).label, '已连接');
  assert.equal(directoryConnection({ client: 'codex', directory, sessions: [session], bridge: { connected: true }, online: false }).reason, 'service_offline');
});
test('connection help provides scoped manual setup and preserves a running Claude task', () => {
  const directory = { id: 'a', path: 'E:/Work/A', recursive: true };
  const install = "E:/Tools/O'Brien Cooperation";
  const guide = connectionGuidance({ client: 'claude', directory, status: { reason: 'claude_access', connected: 0 }, installationDirectory: install });
  assert.equal(guide.scope, directory.path);
  assert.ok(guide.steps.some(step => step.code?.includes("O''Brien")));
  assert.ok(guide.steps.some(step => step.text.includes('等当前任务结束后')));
  assert.ok(guide.note.includes('不会从父目录自动继承'));
  const codex = connectionGuidance({ client: 'codex', directory, status: { reason: 'codex_bridge', connected: 0 }, installationDirectory: install });
  const code = codex.steps.find(step => step.code).code;
  assert.ok(code.includes('[mcp_servers.cooperation]'));
  assert.ok(code.includes('CODEX_APP_TOOLS_PIPE_PATH'));
  const args = JSON.parse(code.split('\n').find(line => line.startsWith('args = ')).slice(7));
  assert.deepEqual(args, [install + '/bin/coop.mjs', 'mcp', '--client', 'codex']);
  const ready = connectionGuidance({ client: 'codex', directory, status: { reason: 'codex_session', connected: 0 }, installationDirectory: install });
  assert.equal(ready.steps.some(step => step.code), false);
});


test('connected-only filter shares connection badges, keeps busy sessions and filters communication scope',()=>{
  const now=Date.now(),directory={id:'d',path:'E:/work',claudeControlEnabled:true};
  const live={client:'claude',id:idA,name:'busy',cwd:directory.path,directoryIds:['d'],monitoring:{observedAt:new Date(now).toISOString(),runtime:{connected:true,controlsEnabled:true,activity:'running'}}};
  const offline={...live,id:idB,name:'offline',monitoring:{runtime:{connected:false}}};
  const options={onlyConnected:true,bridge:{connected:true},online:true,now};
  assert.equal(sessionConnected(live,{...options,directory}),true);
  assert.equal(sessionConnected({...live,monitoring:{...live.monitoring,observedAt:new Date(now-61000).toISOString()}},{...options,directory}),false);
  assert.equal(sessionConnected(live,{...options,directory,online:false}),false);
  assert.equal(sessionConnected({...live,client:'codex'},{...options,directory,bridge:{connected:false}}),false);
  const dirs=[directory],open=new Set(['d']),groups=new Set(['d:claude']);
  const visible=visibleAddresses(dirs,[live,offline],open,groups,'',options);
  assert.deepEqual([...visible],['claude:'+idA]);
  assert.equal(messageMatches({from:offline,to:offline},visible),false);
  assert.equal(visibleAddresses(dirs,[live,offline],open,groups).size,2);
  assert.equal(visibleAddresses(dirs,[live,offline],open,groups,'offline',options).size,0);
});
