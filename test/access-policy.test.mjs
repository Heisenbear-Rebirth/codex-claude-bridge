import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectoryAccessPolicy } from '../src/access-policy.mjs';
import { CooperationService } from '../src/service.mjs';
import { SessionLifecycle } from '../src/session-lifecycle.mjs';

test('Protected-directory checks reject exact paths, children, extended paths and recursive ancestors without IO', () => {
  const policy=new DirectoryAccessPolicy(['E:/Fixture/PrivateA','E:/Fixture/PrivateB']);
  for(const path of ['e:\\fixture\\privatea','E:/Fixture/PrivateA/sub','\\\\?\\E:\\Fixture\\PrivateB','E:/Fixture/PrivateB/../PrivateB'])assert.equal(policy.permits(path),false);
  assert.equal(policy.permits('E:/Fixture',true),false);
  assert.equal(policy.permits('E:/AllowedProject',true),true);
  assert.equal(policy.permits('E:/Fixture/PrivateB-other'),true);
});
test('Discovery and lifecycle reject protected paths before any filesystem discovery or native adapter invocation', async()=>{
  let calls=0;const adapters={codex:{list:async()=>{calls++;throw new Error('Should not discover');}}};
  const accessPolicy=new DirectoryAccessPolicy(['E:/Fixture/PrivateA','E:/Fixture/PrivateB']);
  const service=new CooperationService({adapters,accessPolicy});
  await assert.rejects(service.sessions({directory:'E:/Fixture/PrivateA'}),{code:'DIRECTORY_PROTECTED'});
  await assert.rejects(service.sessions({directory:'E:/Fixture',recursive:true}),{code:'DIRECTORY_PROTECTED'});
  const lifecycle=new SessionLifecycle({store:{},adapters,root:'E:/Fixture/Manager',directories:['E:/Fixture/PrivateB'],accessPolicy});
  await assert.rejects(lifecycle.execute('create',{client:'codex',directory:'E:/Fixture/PrivateB',requestId:'protected-test'},{kind:'management-ui'}),{code:'DIRECTORY_PROTECTED'});
  assert.equal(calls,0);
});
