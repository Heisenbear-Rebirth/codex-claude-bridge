import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { visibleAddresses, messageMatches, autoCompressEnabled, validThresholds, PolicySaver } from '../public/ui-state.mjs';
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
