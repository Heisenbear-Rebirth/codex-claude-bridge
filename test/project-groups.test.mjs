import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ManagementStore } from '../src/management-store.mjs';
import { ProjectGroups } from '../src/project-groups.mjs';
import { startServer } from '../src/http-server.mjs';
import { addressOf, projectMembers, workspaceAddresses, messageMatches } from '../public/ui-state.mjs';

const a={client:'claude',id:'11111111-1111-4111-8111-111111111111',name:'实现会话',cwd:'project-a',directoryIds:['a']};
const b={client:'codex',id:'22222222-2222-4222-8222-222222222222',name:'评审会话',cwd:'project-b',directoryIds:['b']};
const c={client:'opencode',id:'ses_MixedCaseSession123',name:'文档会话',cwd:'project-c',directoryIds:['c']};
async function scratch(t){const parent=resolve('.cooperation/group-tests');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'case-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}

test('custom projects persist cross-directory members and leave policies and messages intact',async t=>{
  const root=await scratch(t);let store=await new ManagementStore(join(root,'.cooperation')).init();
  try{
    store.savePolicy(a,{enabled:true,mode:'automatic'});store.create({id:'existing',from:a,to:b,text:'keep',createdAt:new Date().toISOString(),status:'submitted'});
    const groups=new ProjectGroups(store), first=groups.save({name:'产品研发',members:[addressOf(a),addressOf(b),addressOf(a),addressOf(c)],expectedRevision:0},[a,b,c]);
    assert.equal(first.members.length,3);assert.equal(first.members[2].id,c.id);
    const overlap=groups.save({name:'论文审阅',members:[addressOf(b)],expectedRevision:0},[b]);assert.equal(groups.list().length,2);
    store.close();store=await new ManagementStore(join(root,'.cooperation')).init();const reopened=new ProjectGroups(store);
    assert.deepEqual(reopened.list()[0],first);
    const renamed=reopened.save({id:first.id,name:'版本二',members:first.members.map(addressOf),expectedRevision:first.revision},[]);
    assert.equal(renamed.members.length,3);assert.equal(renamed.revision,2);
    assert.throws(()=>reopened.save({id:first.id,name:'stale',members:[],expectedRevision:1},[]),e=>e.statusCode===409);
    assert.throws(()=>reopened.remove({id:first.id,expectedRevision:1}),e=>e.statusCode===409);
    reopened.remove({id:first.id,expectedRevision:2});assert.equal(reopened.list()[0].id,overlap.id);
    assert.equal(store.getPolicy(a).enabled,true);assert.equal(store.getMessage('existing').text,'keep');assert.equal(store.activeCycles().length,0);
  }finally{store.close();}
});

test('group mutations validate membership, size and revision, preserve missing members only in their own group',async t=>{
  const root=await scratch(t),store=await new ManagementStore(join(root,'.cooperation')).init();try{
    const groups=new ProjectGroups(store);
    for(const input of [{name:' ',members:[]},{name:'x'.repeat(81),members:[]},{name:'x\ny',members:[]},{name:'x',members:['unknown:12345678']},{name:'x',members:[addressOf(a)]},{name:'x',members:Array(201).fill(addressOf(a))}])assert.throws(()=>groups.save({...input,expectedRevision:0},[]));
    assert.throws(()=>groups.save({name:'x',members:[]},[]),e=>e.statusCode===409);
    const group=groups.save({name:'空项目',members:[],expectedRevision:0});assert.equal(group.members.length,0);
    const original=groups.save({name:'已选',members:[addressOf(c)],expectedRevision:0},[c]);
    assert.throws(()=>groups.save({id:group.id,name:group.name,members:[addressOf(c)],expectedRevision:1},[]));
    assert.equal(groups.save({id:original.id,name:'离线仍保留',members:[addressOf(c)],expectedRevision:1},[]).members.length,1);
  }finally{store.close();}
});

test('workspace scope resolves custom membership, respects case, preserves missing history and filters connection',()=>{
  const group={id:'g',name:'跨目录',members:[a,c]},online={...a,monitoring:{runtime:{connected:true,activity:'running'}},controlAccess:{directoryEnabled:true}};
  const resolved=projectMembers(group,[online,b],'custom');assert.equal(resolved[0],online);assert.equal(resolved[1].missing,true);
  const opts={project:group,sessions:[online,b],mode:'custom',directories:[{id:'a',path:a.cwd,claudeControlEnabled:true}]};
  assert.deepEqual([...workspaceAddresses(opts)],[addressOf(a),addressOf(c)]);
  assert.deepEqual([...workspaceAddresses({...opts,onlyConnected:true})],[addressOf(a)]);
  assert.deepEqual([...workspaceAddresses({...opts,selectedAddress:addressOf(c)})],[addressOf(c)]);
  assert.equal(workspaceAddresses({...opts,selectedAddress:addressOf(b)}).size,0);
  assert.equal(workspaceAddresses({...opts,selectedAddress:addressOf(c).toLowerCase()}).size,0);
  assert.equal(messageMatches({from:b,to:c},workspaceAddresses(opts)),true);
  assert.equal(messageMatches({from:b,to:b},workspaceAddresses(opts)),false);
  assert.deepEqual([...workspaceAddresses({project:{id:'b'},sessions:[a,b,c],mode:'directories'})],[addressOf(b)]);
});

test('group HTTP endpoints enforce CSRF, server-resolved members, revisions and restart persistence',async t=>{
  const root=await scratch(t),other=join(root,'other');await mkdir(other);
  const sessions=[{...a,cwd:root},{...b,cwd:other}];let sends=0;
  const adapters=Object.fromEntries(['claude','codex'].map(client=>[client,{list:async({directory})=>({sessions:sessions.filter(s=>s.client===client&&s.cwd===directory),warnings:[]}),send:async()=>{sends++;throw Error('No sends expected');}}]));
  let manager=await startServer({root,port:0,startMonitoring:false,adapters});
  try{
    manager.store.saveDirectory({path:other,normalized:other.toLowerCase()});let config=await(await fetch(manager.url+'/api/config')).json();
    const post=(path,body,csrf=config.csrfToken)=>fetch(manager.url+path,{method:'POST',headers:{'Content-Type':'application/json','X-Coop-UI':csrf},body:JSON.stringify(body)});
    const input={name:'跨目录团队',members:sessions.map(addressOf),expectedRevision:0};
    assert.equal((await post('/api/groups',input,'wrong')).status,403);
    let response=await post('/api/groups',input);assert.equal(response.status,200);const group=(await response.json()).group;assert.equal(group.members.length,2);
    assert.equal((await post('/api/groups',{...input,id:group.id,expectedRevision:0})).status,409);
    assert.equal((await post('/api/groups',{...input,members:[{...a,cwd:'forged'}]})).status,400);
    await manager.close();manager=await startServer({root,port:0,startMonitoring:false,adapters});config=await(await fetch(manager.url+'/api/config')).json();
    assert.deepEqual((await(await fetch(manager.url+'/api/groups')).json()).groups,[group]);
    assert.equal((await post('/api/groups/remove',{id:group.id,expectedRevision:group.revision})).status,200);
    assert.equal((await(await fetch(manager.url+'/api/groups')).json()).groups.length,0);assert.equal(sends,0);assert.equal(manager.store.policies().length,0);
  }finally{await manager.close();}
});
