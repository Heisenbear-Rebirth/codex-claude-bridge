import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageAccumulator, publicNativeContext } from '../src/context-usage.mjs';

test('Codex context uses the last snapshot rather than cumulative consumption', () => {
  const accumulator = createUsageAccumulator('codex', 'id');
  accumulator.add({ type: 'event_msg', timestamp: 't1', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 17515 }, total_token_usage: { total_tokens: 900000 }, model_context_window: 828400 } } });
  assert.equal(accumulator.result().usedTokens, 17515); assert.equal(accumulator.result().usedPercent, 2.11);
  accumulator.add({ type: 'compacted', timestamp: 't2' }); assert.equal(accumulator.result().available, false);
});
test('Claude counts all input cache categories once and leaves unknown capacity unset', () => {
  const accumulator = createUsageAccumulator('claude', 'id');
  accumulator.add({ type: 'assistant', sessionId: 'id', timestamp: 't1', message: { model: 'm', usage: { input_tokens: 10, cache_creation_input_tokens: 31923, cache_read_input_tokens: 0, output_tokens: 244 } } });
  assert.equal(accumulator.result().usedTokens, 31933); assert.equal(accumulator.result().withLastOutputTokens, 32177);
  assert.equal(accumulator.result().usedPercent, null); assert.equal(accumulator.result().contextWindowTokens, null);
  accumulator.add({ type: 'assistant', parent_tool_use_id: 'child', message: { usage: { input_tokens: 99999 } } });
  assert.equal(accumulator.result().usedTokens, 31933);
  accumulator.add({ type: 'system', subtype: 'compact_boundary', sessionId: 'id', timestamp: 't2' });
  assert.equal(accumulator.result().available, false);
});
test('native context summaries exclude memory-file paths and full content', () => {
  const result = publicNativeContext({ model: 'm', totalTokens: 40000, rawMaxTokens: 200000, percentage: 20,
    categories: [{ name: 'Messages', tokens: 30000 }], memoryFiles: [{ path: 'private', content: 'secret' }] });
  assert.equal(result.usedPercent, 20); assert.equal(JSON.stringify(result).includes('secret'), false); assert.equal(Object.hasOwn(result, 'memoryFiles'), false);
});
test('Codex per-API usage is available during a long tool, excludes aggregates, and a delayed duplicate does not hide newer tool output', () => {
  const a = createUsageAccumulator('codex', 'target');
  a.add({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn', model_context_window: 1000 } });
  a.add({ type: 'turn_context', payload: { turn_id: 'turn', model: 'model' } });
  const usage = { input_tokens: 590, output_tokens: 10, total_tokens: 600 };
  a.add({ type: 'token_usage_record', timestamp: 'early', payload: { thread_id: 'target', turn_id: 'turn', usage, turn_token_usage: { total_tokens: 999999 }, thread_token_usage: { total_tokens: 99999999 } } });
  assert.equal(a.result().usedTokens, 600); assert.equal(a.result().usedPercent, 60); assert.equal(a.result().historyChangedAfterMeasurement, false);
  a.add({ type: 'token_usage_record', payload: { thread_id: 'child', usage: { total_tokens: 9999 } } });
  assert.equal(a.result().usedTokens, 600);
  a.add({ type: 'response_item', payload: { type: 'custom_tool_call_output' } });
  a.add({ type: 'event_msg', timestamp: 'delayed', payload: { type: 'token_count', info: { last_token_usage: usage, model_context_window: 1000 } } });
  assert.equal(a.result().measuredAt, 'early'); assert.equal(a.result().historyChangedAfterMeasurement, true);
  a.add({ type: 'turn_context', payload: { turn_id: 'new', model: 'different-model' } });
  a.add({ type: 'token_usage_record', payload: { thread_id: 'target', usage } });
  assert.equal(a.result().contextWindowTokens, null);
});
