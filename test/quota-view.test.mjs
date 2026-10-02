import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaView } from '../public/maintenance-view.mjs';

test('reopened and offline clients explain the retained quota state before a new live quota marker exists', () => {
  const session = { policy: { enabled: true, mode: 'automatic' }, monitoring: {
    runtime: { connected: false }, quotaRecovery: { state: 'waiting', reason: 'old' } } };
  assert.match(quotaView(session).title, /重新连接/);
  session.monitoring.runtime = { connected: true, quotaRestart: { pending: true, reason: '等待核对原生历史' } };
  assert.equal(quotaView(session).description, '等待核对原生历史'); assert.match(quotaView(session).title, /退出前/);
});

test('quota guidance follows saved automatic policy and reports a pending state without asking to enable it again', () => {
  const session = { policy: { enabled: true, mode: 'automatic' }, monitoring: { runtime: { activity: 'running', quota: { turnId: 'failed', autoResume: true } } } };
  assert.match(quotaView(session).description, /自动管理已开启/);
  assert.doesNotMatch(quotaView(session).description, /启用自动管理后/);
  session.policy.enabled = false; assert.match(quotaView(session).description, /启用自动管理后/);
});
test('quota guidance distinguishes blocked recovery, client upgrades and an active maintenance cycle', () => {
  const session = { policy: { enabled: true, mode: 'automatic' }, monitoring: { runtime: { activity: 'unknown', quota: { turnId: 'failed' } },
    quotaRecovery: { eventId: 'failed', state: 'waiting', blockedReason: '等待输入', reason: '额度已恢复。等待输入', nextCheckAt: '2030-01-01' } } };
  assert.match(quotaView(session).title, /等待会话就绪/); assert.equal(quotaView(session).nextCheckAt, '2030-01-01');
  session.monitoring.runtime.requiresReopen = true; session.monitoring.runtime.detail = '需要重开原面板';
  assert.equal(quotaView(session).description, '需要重开原面板'); assert.equal(quotaView(session).nextCheckAt, null);
  session.monitoring.runtime.requiresReopen = false; session.cycle = { state: 'needs_attention' };
  assert.match(quotaView(session).description, /核对当前维护步骤/);
});
test('a previous failed turn cannot lend its cancellation message or quota reading to a new event', () => {
  const session = { policy: { enabled: true, mode: 'automatic' }, monitoring: { runtime: { activity: 'quota_limited', quota: { turnId: 'new', autoResume: true } },
    quotaRecovery: { eventId: 'old', state: 'cancelled', reason: '旧请求已取消', quota: { nextResetAt: 'old-date' } } } };
  assert.match(quotaView(session).description, /自动管理已开启/); assert.equal(quotaView(session).resetAt, undefined);
});
