import { createInterface } from 'node:readline';
const id = process.argv[process.argv.indexOf('--resume') + 1];
const emit = message => process.stdout.write(JSON.stringify(message) + '\n');
if (process.argv.includes('--show-args')) { emit({ args: process.argv.slice(2) }); process.exit(0); }
let permissionRequest;
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
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
    emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    emit({ type: 'system', subtype: 'init', session_id: id });
  } else if (message.type === 'user') {
    emit({ ...message, fixtureReceivedExactly: true });
    if (message.message.content === '/compact') {
      emit({ type: 'system', subtype: 'status', status: 'compacting', session_id: id });
      if (!process.argv.includes('--no-boundary')) emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 12345 }, session_id: id });
      emit({ type: 'result', subtype: 'success', is_error: false, session_id: id });
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
