import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { restartPlan, readRestartEvidence, restartCandidate, controlTurnEnded } from '../src/maintenance-recovery.mjs';
const id = randomUUID(), at = n => new Date(1700000000000 + n * 1000).toISOString();
const cycle = (state, patch={}) => ({ id:randomUUID(),session:{client:'claude',id,cwd:resolve('.')},state,createdAt:at(0),
  triggerRuntime:{instanceId:'old'},controlTurnId:'control',controlDispatched:true,controlIntentAt:at(1),...patch });
test('phase planning preserves completed receipts and resends only unfinished prompt stages',()=>{
  for(const stage of ['writing_handoff','restoring']) {
    const c=cycle(stage),e={verified:true,lastInputId:'control'};
    assert.equal(restartPlan(c,e,{handoff:stage==='restoring'}).resending,true);
    const result=restartPlan(c,e,{handoff:true,restored:true});
    assert.equal(result.stage,stage==='writing_handoff'?'awaiting_handoff_end':'awaiting_restore_end');assert.equal(result.endedControl,true);
    assert.equal(restartPlan(c,{...e,lastInputId:'business'},{handoff:true}).action,'attention');
  }
  assert.equal(restartPlan(cycle('awaiting_restore_end'),{verified:true,lastInputId:'control'},{handoff:true}).action,'attention');
  assert.equal(restartPlan(cycle('writing_handoff'),{verified:false}).action,'wait');
});
test('unknown compaction is never retried; confirmed compaction advances directly to restore',()=>{
  const c=cycle('compacting',{compactDispatched:true});
  assert.equal(restartPlan(c,{verified:true,lastInputId:'compact'},{handoff:true}).action,'attention');
  const result=restartPlan(c,{verified:true,compactCompleted:true},{handoff:true});
  assert.equal(result.stage,'restoring');assert.equal(result.patch.controlDispatched,false);
  assert.equal(restartPlan(c,{verified:true,compactCompleted:true},{}).action,'attention');
});
test('restart boundary is valid only for the same idle instance and unchanged activity revision',()=>{
  const c=cycle('awaiting_restore_end',{recoveryBoundary:{instanceId:'new',activityRevision:8,controlTurnId:'control'}});
  const s={activity:'idle',instanceId:'new',activityRevision:8,lastCompletedTurnId:null};
  assert.equal(controlTurnEnded(c,s),true);
  for(const patch of [{activity:'running'},{instanceId:'other'},{activityRevision:9},{lastCompletedTurnId:'business'}]) assert.equal(controlTurnEnded(c,{...s,...patch}),false);
  assert.equal(restartCandidate({...c,state:'needs_attention',reason:'原生客户端实例已经改变，请核对原会话状态。'}),true);
  assert.equal(restartCandidate({...c,state:'needs_attention',reason:'原生客户端实例已经改变',recoveryBlocked:true}),false);
});
test('Codex reconnect evidence requires a completed native head, and a final compact item with matching time',async()=>{
  const c=cycle('compacting',{session:{client:'codex',id,cwd:resolve('.')},compactIntentAt:at(10)});
  const sample={runtime:{latestTurn:{id:'compact',status:'completed',itemTypes:['contextCompaction']}},usage:{recordedTurnState:'task_complete',lastCompactionAt:at(11)}};
  assert.equal((await readRestartEvidence(c,sample)).compactCompleted,true);
  sample.runtime.latestTurn.itemTypes=['userMessage'];assert.equal((await readRestartEvidence(c,sample)).compactCompleted,false);
  sample.runtime.latestTurn.status='inProgress';assert.equal((await readRestartEvidence(c,sample)).verified,false);
});
test('Claude evidence joins original request audit to native compact boundary and rejects later input or damaged history',async t=>{
  const root=await mkdtemp(join(resolve('.'),'.recovery-evidence-test-'));t.after(async()=>{assert.ok(root.startsWith(resolve('.')+sep));await rm(root,{recursive:true,force:true})});
  const configDir=join(root,'claude'),folder=join(configDir,'projects',root.replace(/[^a-zA-Z0-9]/g,'-'));
  await mkdir(folder,{recursive:true});const file=join(folder,id+'.jsonl'),auditFolder=join(root,'.cooperation','claude-wrapper');await mkdir(auditFolder,{recursive:true});
  const control=randomUUID(),request=randomUUID();
  const c=cycle('compacting',{session:{client:'claude',id,cwd:root},compactDispatched:true,controlTurnId:control,compactIntentAt:at(10),compactResult:{status:'unknown',requestId:request}});
  const history=[{sessionId:id,cwd:root,type:'user',uuid:control,timestamp:at(1),message:{role:'user',content:'private maintenance prompt'}},
    {sessionId:id,type:'user',uuid:request,timestamp:at(11),message:{role:'user',content:'/compact'}},
    {sessionId:id,type:'system',subtype:'compact_boundary',timestamp:at(12),compactMetadata:{trigger:'manual'}},
    {sessionId:id,type:'user',uuid:randomUUID(),isCompactSummary:true,timestamp:at(12),message:{role:'user',content:'private summary'}},
    {sessionId:id,type:'assistant',timestamp:at(13),message:{role:'assistant',stop_reason:'end_turn'}}];
  const audit=[{type:'requested',at:at(10),sessionId:id,instanceId:'old',requestId:request},
    {type:'finished',at:at(13),sessionId:id,instanceId:'old',requestId:request,status:'completed',boundary:{trigger:'manual'}}];
  const put=()=>writeFile(file,history.map(JSON.stringify).join('\n')+'\n');
  await put();await writeFile(join(auditFolder,'compactions.jsonl'),audit.map(JSON.stringify).join('\n')+'\n');
  const before=await readFile(file,'utf8'),e=await readRestartEvidence(c,{}, {root,configDir});
  assert.equal(e.compactCompleted,true);assert.equal(e.lastInputId,request);assert.equal(JSON.stringify(e).includes('private'),false);assert.equal(await readFile(file,'utf8'),before);
  history.push({sessionId:id,cwd:root,type:'user',uuid:randomUUID(),timestamp:at(14),message:{role:'user',content:'new business'}});await put();
  assert.equal((await readRestartEvidence(c,{}, {root,configDir})).compactCompleted,false);
  await writeFile(file,before+'{bad}\n');assert.equal((await readRestartEvidence(c,{}, {root,configDir})).verified,false);
  await writeFile(file,before+'{"partial":');assert.equal((await readRestartEvidence(c,{}, {root,configDir})).reason,'history_changing');
  await writeFile(file,before);audit[1].instanceId='unrelated';await writeFile(join(auditFolder,'compactions.jsonl'),audit.map(JSON.stringify).join('\n')+'\n');
  assert.equal((await readRestartEvidence(c,{}, {root,configDir})).compactCompleted,false);
});
