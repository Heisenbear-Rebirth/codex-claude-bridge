import test from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceView, maintenanceDiagnostic } from '../public/maintenance-view.mjs';

test('maintenance view communicates task stages and only asks for a concrete necessary action', () => {
  assert.deepEqual(maintenanceView({ state: 'writing_handoff' }).stages, ['保存进度','整理上下文','恢复任务']);
  assert.equal(maintenanceView({ state: 'writing_handoff' }).primary, null);
  assert.equal(maintenanceView({ state: 'compacting' }).index, 1);
  assert.equal(maintenanceView({ state: 'restoring' }).index, 2);
  assert.equal(maintenanceView({ state: 'writing_handoff' }, { activity: 'waiting_permission' }).title, '等待你的确认');
  const view = maintenanceView({ state: 'needs_attention', previousState: 'writing_handoff', reason: '维护阶段超时；会话锁及排队消息已保留。' });
  assert.equal(view.primary.label, '检查并继续'); assert.doesNotMatch(view.description, /回执|会话锁|FIFO/);
  assert.equal(maintenanceView({ state: 'needs_attention', previousState: 'writing_handoff', reason: '目标轮次已结束，但系统未收到阶段回执。' }).primary.label, '继续保存进度');
});
test('copyable support diagnostics select public fields and omit credentials, prompts, paths and document contents', () => {
  const diagnostic = maintenanceDiagnostic({ client: 'claude', id: 'public-session', cwd: 'private-directory', token: 'secret' },
    { id: 'public-cycle', state: 'needs_attention', receiptToken: 'secret', receiptHashes: { handoff: 'secret' }, handoffPath: 'private-file', controlPrompt: 'private-prompt' },
    { model: 'chosen', token: 'secret', history: ['private-conversation'] });
  assert.equal(diagnostic.cycleId, 'public-cycle');
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|private-/);
});
