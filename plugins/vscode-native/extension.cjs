const vscode = require('vscode');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, randomBytes, timingSafeEqual } = require('node:crypto');
const { pathToFileURL } = require('node:url');
let shutdown;
exports.activate = async function(context) {
  const root = path.resolve(__dirname, '../..');
  if (existsSync(path.join(root,'session-lifecycle-cancelled.json')) || existsSync(path.join(root,'.cooperation/session-lifecycle-cancelled.json'))) return;
  const { sameDirectory, listenOpenCodeBridge } = await import(pathToFileURL(path.join(root,'src/opencode-bridge.mjs')).href);
  const { readAccessPolicy } = await import(pathToFileURL(path.join(root,'src/access-policy.mjs')).href);
  if (!vscode.workspace.workspaceFolders?.length && context.extensionMode === vscode.ExtensionMode.Development && (await readAccessPolicy()).permits(root)) {
    await vscode.commands.executeCommand('vscode.openFolder',vscode.Uri.file(root),{forceReuseWindow:true,noRecentEntry:true});return;
  }
  const current = () => vscode.workspace.workspaceFolders?.length === 1 && sameDirectory(vscode.workspace.workspaceFolders[0].uri.fsPath,root);
  if (!current() || !vscode.workspace.isTrusted || !(await readAccessPolicy()).permits(root)) return;
  const native = vscode.extensions.getExtension('anthropic.claude-code');
  if (!native || native.packageJSON.version !== '2.1.237') return;
  const wrapper = vscode.workspace.getConfiguration('claudeCode').get('claudeProcessWrapper');
  if (typeof wrapper !== 'string' || !sameDirectory(wrapper,path.join(root,'bin/claude-wrapper.exe'))) return;
  const instanceId=randomUUID(), token=randomBytes(32).toString('hex');
  const previous=process.env.COOP_NATIVE_UI_INSTANCE_ID;
  process.env.COOP_NATIVE_UI_INSTANCE_ID=instanceId;
  await native.activate();
  const folder=path.join(root,'.cooperation/native-ui'),instances=path.join(folder,'instances'),operations=path.join(folder,'operations');
  await fs.mkdir(instances,{recursive:true});await fs.mkdir(operations,{recursive:true});
  const pending=new Map();
  const json=(response,status,value)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(value));};
  async function match(operationId,id){
    const candidates=[];
    for(const name of await fs.readdir(path.join(root,'.cooperation/claude-wrapper/instances')).catch(()=>[])) {
      if(!name.endsWith('.json'))continue;
      try{
        const record=JSON.parse(await fs.readFile(path.join(root,'.cooperation/claude-wrapper/instances',name),'utf8'));
        if(!sameDirectory(record.cwd,root)||record.nativeUiInstanceId!==instanceId||!record.sessionId||operationId&&record.nativeLifecycleOperationId!==operationId||id&&record.sessionId!==id)continue;
        const url=new URL(record.endpoint);if(url.hostname!=='127.0.0.1'||url.protocol!=='http:')continue;
        const response=await fetch(new URL('/status',url),{headers:{Authorization:'Bearer '+record.token},signal:AbortSignal.timeout(2000)});
        const state=await response.json();
        if(response.ok&&state.connected&&state.sessionId===record.sessionId&&state.instanceId===record.instanceId&&sameDirectory(state.cwd,root))candidates.push(state);
      }catch{}
    }
    if(candidates.length>1)throw new Error('Native session has multiple instances.');
    const state=candidates[0];if(!state)return null;
    return {status:operationId?'created':'connected',session:{client:'claude',id:state.sessionId,cwd:root,name:'Claude '+state.sessionId.slice(0,8),live:true,status:'connected'},
      hostReachable:true,loaded:true,sendReady:null,nativeRecorded:false,displayConfirmed:false,modelProcessed:false,uiOpenRequested:true,instanceId,
      detail:'原生面板已接受打开请求，并已核对同目录 wrapper 身份；投递和模型处理需单独确认。'};
  }
  async function waitFor(operationId,id){const deadline=Date.now()+22000;while(Date.now()<deadline){const result=await match(operationId,id);if(result)return result;await new Promise(r=>setTimeout(r,150));}return {status:'unknown',uiOpenRequested:true,detail:'原生面板已请求打开，身份仍待核对；不会重复创建。'};}
  async function operate(input){
    if(!current()||!(await readAccessPolicy()).permits(root)||!sameDirectory(input.cwd,root))throw new Error('Native workspace changed.');
    if(input.action==='capabilities')return{client:'claude',create:true,connect:true,cwd:root,instanceId,version:native.packageJSON.version};
    if(input.action==='reconcile')return await match(input.operationId,input.targetId)||{status:'unknown'};
    if(input.action==='connect'){
      if(!/^[0-9a-f-]{36}$/i.test(input.targetId))throw new Error('Invalid native ID.');
      const existing=await match(null,input.targetId);if(existing)return existing;
      await vscode.commands.executeCommand('claude-vscode.editor.open',input.targetId,undefined,vscode.ViewColumn.Active);
      return waitFor(null,input.targetId);
    }
    if(input.action==='create'){
      if(!/^[0-9a-f-]{36}$/.test(input.operationId)||typeof input.prompt!=='string'||!input.prompt.trim())throw new Error('Creation requires a native first prompt.');
      const file=path.join(operations,input.operationId+'.json');
      try{await fs.writeFile(file,JSON.stringify({operationId:input.operationId,instanceId,cwd:root,state:'unknown',at:new Date().toISOString()}),{flag:'wx',mode:0o600});}
      catch(error){if(error.code==='EEXIST')return await match(input.operationId)||{status:'unknown'};throw error;}
      await vscode.commands.executeCommand('claude-vscode.editor.open',undefined,input.prompt,vscode.ViewColumn.Active);
      const result=await waitFor(input.operationId);
      await fs.writeFile(file,JSON.stringify({operationId:input.operationId,instanceId,cwd:root,result}),{mode:0o600});
      return result;
    }
    throw new Error('Unsupported native operation.');
  }
  const server=http.createServer(async(request,response)=>{
    const expected='Bearer '+token,auth=request.headers.authorization||'';
    if(request.headers.host!==new URL(record.endpoint).host||request.headers.origin||request.headers['sec-fetch-site']==='cross-site'||Buffer.byteLength(auth)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(auth),Buffer.from(expected)))return json(response,403,{error:'Authentication required.'});
    if(request.method!=='POST'||request.url!=='/rpc')return json(response,404,{error:'Unknown operation.'});
    try{
      let bytes=0;const chunks=[];for await(const chunk of request){bytes+=chunk.length;if(bytes>300*1024)throw new Error('Request too large.');chunks.push(chunk);}
      const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(input.instanceId!==instanceId)throw new Error('Native instance changed.');
      const key=input.operationId||randomUUID();
      if(!pending.has(key)){const work=operate(input).finally(()=>pending.delete(key));pending.set(key,work);}
      json(response,200,await pending.get(key));
    }catch{json(response,400,{error:'Native operation rejected or outcome unconfirmed.'});}
  });
  await listenOpenCodeBridge(server);
  const record={client:'claude',instanceId,token,pid:process.pid,cwd:root,endpoint:'http://127.0.0.1:'+server.address().port,startedAt:new Date().toISOString()};
  const file=path.join(instances,instanceId+'.json');await fs.writeFile(file,JSON.stringify(record),{mode:0o600});
  shutdown=async()=>{await Promise.allSettled(pending.values());server.closeAllConnections();await new Promise(r=>server.close(r));await fs.unlink(file).catch(()=>{});if(previous===undefined)delete process.env.COOP_NATIVE_UI_INSTANCE_ID;else process.env.COOP_NATIVE_UI_INSTANCE_ID=previous;};
  context.subscriptions.push({dispose:()=>{void shutdown?.();}});
};
exports.deactivate=()=>shutdown?.();
