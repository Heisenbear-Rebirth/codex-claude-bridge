import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {SessionLifecycle} from '../src/session-lifecycle.mjs';
import {lifecycleEnabled} from '../src/lifecycle-availability.mjs';
test('Published cancellation marker disables lifecycle without local runtime files',async t=>{
  const root=await mkdtemp(join(resolve('.'),'.lifecycle-disabled-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'session-lifecycle-cancelled.json'),'{}');
  assert.equal(lifecycleEnabled(root),false);
});
async function fixture(t){const root=await mkdtemp(join(resolve('.'),'.lifecycle-disabled-'));await mkdir(join(root,'.cooperation'));await writeFile(join(root,'.cooperation/session-lifecycle-cancelled.json'),'{}');t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('Cancellation prevents native operations and intent writes, and hides management capabilities',async t=>{
  const root=await fixture(t);let calls=0;
  const lifecycle=new SessionLifecycle({root,store:{reserveLifecycle(){calls++;}},adapters:{opencode:{find(){calls++;},createSession(){calls++;}}}});
  assert.equal(lifecycle.capabilities(),null);
  await assert.rejects(lifecycle.execute('create',{requestId:'cancelled-create',directory:root,client:'opencode'},{kind:'management-ui'}),{code:'LIFECYCLE_DISABLED'});
  await assert.rejects(lifecycle.execute('connect',{requestId:'cancelled-connect',directory:root,to:'opencode:ses_Cancelled123'},{kind:'management-ui'}),{code:'LIFECYCLE_DISABLED'});
  assert.equal(calls,0);
});
test('Cancelled MCP retains message/checkpoint tools and rejects stale lifecycle calls before identity lookup',async t=>{
  const root=await fixture(t),script=`import {startMcp} from './src/mcp.mjs';startMcp({root:${JSON.stringify(root)},client:'codex'});`;
  const child=spawn(process.execPath,['--input-type=module','--eval',script],{cwd:resolve('.'),windowsHide:true});let output='';child.stdout.on('data',chunk=>output+=chunk);
  child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})+'\n'+JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'create_session',arguments:{requestId:'stale-create',directory:root,client:'codex',prompt:'Must not run'}}})+'\n');
  await new Promise((done,fail)=>{child.once('close',done);child.once('error',fail);});
  const rows=output.trim().split('\n').map(JSON.parse),catalog=rows.find(r=>r.id===1).result,error=rows.find(r=>r.id===2).result;
  assert.deepEqual(catalog.tools.map(t=>t.name),['send_message','context_checkpoint']);assert.equal(error.isError,true);assert.match(error.content[0].text,/已取消/);
});
