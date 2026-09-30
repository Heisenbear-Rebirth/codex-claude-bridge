import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Run the actual frontend transport handlers, with a deterministic HTTP/EventSource
// harness. No native discovery or business sessions are involved.
async function harness(){
 const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const elements=new Map(),events=new Map();let failing=false,healthPending;
 const context=vm.createContext({AbortSignal,setTimeout,clearTimeout,console,
  state:{closed:false,online:true,bridge:{connected:true},events:null},
  $:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);},
  request:async()=>{if(healthPending)return healthPending;if(failing)throw Error('network');return{connected:true};},
  renderBridge:value=>{context.state.bridge=value;},loadGroups(){},loadMonitoring(){},loadMessages(){},
  EventSource:class{addEventListener(name,callback){events.set(name,callback);}},
 });
 const health=app.slice(app.indexOf('let eventStreamOnline='),app.indexOf('function openDirectory('));
 const eventCode=app.slice(app.indexOf('function connectEvents()'),app.indexOf("window.addEventListener('pagehide'"));
 vm.runInContext('let eventMonitorTimer,eventMessageTimer;'+health+eventCode+';connectEvents();',context);
 const flush=()=>new Promise(setImmediate);
 return{context,elements,events,flush,fail:value=>{failing=value;},pending:value=>{healthPending=value;}};
}
test('SSE failure does not disconnect both clients when HTTP still responds',async()=>{
 const h=await harness();h.events.get('error')();await h.flush();
 assert.equal(h.context.state.online,true);assert.equal(h.context.state.bridge.connected,true);
 assert.match(h.elements.get('connection-label').textContent,/实时通知重连中/);
});
test('Actual service failure is shown and HTTP success recovers without SSE reopening',async()=>{
 const h=await harness();h.fail(true);h.events.get('error')();await h.flush();
 assert.equal(h.context.state.online,false);assert.equal(h.context.state.bridge.connected,true);
 h.fail(false);await vm.runInContext('checkServiceHealth()',h.context);
 assert.equal(h.context.state.online,true);
});
test('A late failed health check cannot overwrite newer successful polling evidence',async()=>{
 const h=await harness();let reject;h.pending(new Promise((_,fail)=>{reject=fail;}));
 const work=vm.runInContext('checkServiceHealth()',h.context);
 vm.runInContext('setServiceOnline(true)',h.context);reject(Error('old failure'));await work;
 assert.equal(h.context.state.online,true);
});
