import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const id = process.argv[process.argv.indexOf('--resume') + 1];
const emit = message => {
  if (process.env.COOP_FIXTURE_HISTORY && (['user', 'assistant'].includes(message.type) || message.type === 'system' && message.subtype === 'compact_boundary')) {
    if (!resolve(process.env.COOP_FIXTURE_HISTORY).startsWith(resolve('.') + sep)) throw Error('Fixture history left its workspace');
    message = { ...message, uuid: message.uuid || randomUUID() };
    appendFileSync(process.env.COOP_FIXTURE_HISTORY, JSON.stringify({ ...message, sessionId: id, cwd: process.cwd(), timestamp: new Date().toISOString() }) + '\n');
  }
  return process.stdout.write(JSON.stringify(message) + '\n');
};
if (process.argv.includes('--show-args')) { emit({ args: process.argv.slice(2) }); process.exit(0); }
let permissionRequest, checkpointRequest;
const foldedInputs = [];
async function quotaUtilization() {
  try { const value = JSON.parse(await readFile('quota-utilization.json', 'utf8')).value; if (Number.isFinite(value)) return value; } catch {}
  return 12;
}
createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line);
  if (message.type === 'fixture_finish_folded_quota') {
    emit({ type: 'rate_limit_event', session_id: id, rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1 } });
    emit({ type: 'assistant', session_id: id, error: 'rate_limit', message: { model: '<synthetic>', content: [] } });
    for (const uuid of foldedInputs.splice(0)) emit({ type: 'command_lifecycle', session_id: id, command_uuid: uuid, state: 'cancelled' });
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: id }); return;
  }
  if (message.type === 'fixture_peer_delivery') {
    emit({ type: 'user', session_id: id, uuid: message.uuid, parent_tool_use_id: null, isReplay: true, isSynthetic: true,
      origin: { kind: 'peer', from: 'fixture', hostInjected: false }, message: { role: 'user', content: message.text } });
    if (await quotaUtilization() >= 100) {
      emit({ type: 'rate_limit_event', session_id: id, rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1 } });
      emit({ type: 'assistant', session_id: id, error: 'rate_limit', message: { model: '<synthetic>', content: [] } });
      emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: id });
    } else {
      emit({ type: 'assistant', session_id: id, message: { model: 'fixture', content: [{ type: 'text', text: 'fixture-peer-processed' }] } });
      emit({ type: 'result', subtype: 'success', is_error: false, session_id: id });
    }
    return;
  }
  if (message.type === 'fixture_release_checkpoint' && checkpointRequest && process.env.COOP_FIXTURE_MANAGER_PATH) {
    const args = checkpointRequest; checkpointRequest = null;
    if (!resolve(args.documentPath).startsWith(resolve('.') + sep)) throw Error('Fixture document left its workspace');
    if (args.stage === 'handoff') { await mkdir(dirname(args.documentPath), { recursive: true }); await writeFile(args.documentPath, 'Deterministic original task handoff'); }
    const manager = JSON.parse(await readFile(process.env.COOP_FIXTURE_MANAGER_PATH, 'utf8'));
    const response = await fetch(manager.url + '/api/checkpoint', { method: 'POST', headers: { authorization: 'Bearer ' + manager.token, 'content-type': 'application/json' },
      body: JSON.stringify({ ...args, from: { client: 'claude', id, cwd: process.cwd() } }) });
    const result = await response.json(); emit({ type: 'fixture_receipt', stage: args.stage, status: result.status || 'rejected', httpStatus: response.status });
    emit({ type: 'result', subtype: 'success', is_error: false, session_id: id }); return;
  }
  if (message.type === 'control_request') {
    if (message.request.subtype === 'interrupt') {
      if (permissionRequest) { emit({ type: 'control_cancel_request', request_id: permissionRequest }); permissionRequest = null; }
      emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { still_queued: [] } } });
      emit({ type: 'result', subtype: 'success', session_id: id });
      return;
    }
    if (message.request.subtype === 'get_context_usage') {
      emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { model: 'fixture', totalTokens: 30000, rawMaxTokens: 200000, percentage: 15, memoryFiles: [{ path: 'private', content: 'not-returned' }], categories: [{ name: 'Messages', tokens: 30000 }] } } });
      return;
    }
    if (message.request.subtype === 'get_usage') {
      emit({ type: 'fixture_quota_request', skipBehaviors: message.request.skip_behaviors });
      emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
        response: { rate_limits_available: true, rate_limits: { five_hour: { utilization: await quotaUtilization(), resets_at: '2030-01-01T00:00:00Z' },
          seven_day: { utilization: 30, resets_at: '2030-01-05T00:00:00Z' } }, behaviors: { private: 'not-returned' } } } });
      return;
    }
    emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    emit({ type: 'system', subtype: 'init', session_id: id, ...(process.env.COOP_FIXTURE_MANAGER_PATH ? { model: 'fixture' } : {}) });
  } else if (message.type === 'user') {
    emit({ ...message, fixtureReceivedExactly: true });
    const checkpoint = process.env.COOP_FIXTURE_MANAGER_PATH && /context_checkpoint：(\{[^\n]+\})/.exec(message.message.content);
    if (checkpoint) {
      checkpointRequest = JSON.parse(checkpoint[1]);
      emit({ type: 'assistant', session_id: id, message: { model: '<synthetic>', content: [], usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
      emit({ type: 'assistant', session_id: id, message: { model: 'fixture', content: [], usage: { input_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 1000 } } });
      emit({ type: 'fixture_pending_checkpoint', stage: checkpointRequest.stage }); return;
    }
    if (message.message.content === 'fold-into-current-turn') {
      foldedInputs.push(message.uuid);
      emit({ type: 'command_lifecycle', session_id: id, command_uuid: message.uuid, state: 'started' }); return;
    }
    if (message.message.content === '/compact') {
      emit({ type: 'system', subtype: 'status', status: 'compacting', session_id: id });
      if (!process.argv.includes('--no-boundary')) emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 12345 }, session_id: id });
      if (process.env.COOP_FIXTURE_HOLD_COMPACT === '1') return;
      emit({ type: 'result', subtype: 'success', is_error: false, session_id: id });
    } else if (message.message.content === 'quota-failure') {
      emit({ type: 'rate_limit_event', session_id: id, rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: 1893456000 } });
      emit({ type: 'assistant', session_id: id, error: 'rate_limit', message: { content: [] } });
      emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: id });
    } else if (message.message.content === 'hold') {
      emit({ type: 'assistant', session_id: id, message: { model: 'fixture', content: [], usage: { input_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 120000 } } });
    } else if (message.message.content === 'permission') {
      permissionRequest = 'fixture-permission';
      emit({ type: 'control_request', request_id: permissionRequest, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo fixture' } } });
    } else { emit({ type: 'assistant', session_id: id, message: { content: [{ type: 'text', text: '你好🙂\\quotes"\n' }] } }); emit({ type: 'result', subtype: 'success', session_id: id }); }
  } else if (message.type === 'control_response' && message.response.request_id === permissionRequest) {
    emit({ type: 'fixture_permission_answer', response: message.response });
    emit({ type: 'result', subtype: 'success', session_id: id });
  }
});
