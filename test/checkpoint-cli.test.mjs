import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpointArguments } from '../bin/coop-checkpoint.mjs';

test('dedicated checkpoint CLI rejects other operations, forged identities and repeated arguments', () => {
  const args = ['--cycle', '11111111-1111-4111-8111-111111111111', '--stage', 'restored', '--receipt-token', 'abcdefghijklmnopqrstuvwx', '--document', 'E:/project/handoff.md', '--client', 'claude'];
  assert.equal(checkpointArguments(args).stage, 'restored');
  assert.throws(() => checkpointArguments(['serve']));
  assert.throws(() => checkpointArguments([...args, '--from', 'somebody']));
  assert.throws(() => checkpointArguments([...args, '--stage', 'handoff']));
});
