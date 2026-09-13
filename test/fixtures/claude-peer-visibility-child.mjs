import { createInterface } from 'node:readline';
import { readFileSync, appendFileSync } from 'node:fs';
const id = process.argv[process.argv.indexOf('--resume') + 1];
const emit = message => process.stdout.write(JSON.stringify(message) + '\n');
let last = '';
// A fixture-only side channel represents output from an independently arriving peer.
const timer = setInterval(() => {
  try {
    const text = readFileSync('replay.json', 'utf8');
    if (text === last) return; last = text;
    const event = JSON.parse(text);
    for (const frame of event.frames || []) emit(frame);
    if (event.finish) {
      emit({ type: 'assistant', session_id: id, message: { content: [{ type: 'text', text: 'original-work-completed' }] } });
      emit({ type: 'result', subtype: 'success', session_id: id });
    }
  } catch { /* File not ready. */ }
}, 20);
createInterface({ input: process.stdin }).on('line', line => {
  appendFileSync('input.jsonl', line + '\n');
  const m = JSON.parse(line);
  if (m.type === 'control_request' && m.request.subtype === 'initialize') {
    emit({ type: 'control_response', response: { request_id: m.request_id, subtype: 'success', response: {} } });
    emit({ type: 'system', subtype: 'init', session_id: id, permissionMode: 'default', model: 'fixture' });
  } else if (m.type === 'user') {
    emit({ type: 'assistant', session_id: id, message: { content: [{ type: 'tool_use', id: 'original-tool', name: 'Read', input: {} }] } });
  }
}).on('close', () => clearInterval(timer));
