import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

for (const source of ['argument', 'environment', 'handshake']) {
  test(`OpenCode MCP ${source} cannot mask native plugin tools or accept a forged checkpoint`, async () => {
    const env = { ...process.env };
    delete env.COOP_CLIENT;
    if (source === 'environment') env.COOP_CLIENT = 'opencode';
    const script = `import {startMcp} from './src/mcp.mjs';startMcp(${JSON.stringify({ root: resolve('.'), ...(source === 'argument' ? { client: 'opencode' } : {}) })});`;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { cwd: resolve('.'), env, windowsHide: true });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    const requests = [
      { id: 1, method: 'initialize', params: { clientInfo: { name: source === 'handshake' ? 'opencode' : 'fixture', version: '1' } } },
      { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name: 'context_checkpoint', arguments: { cycleId: 'forged', stage: 'handoff', receiptToken: 'forged', documentPath: 'does-not-exist' } } },
    ];
    child.stdin.end(requests.map(r => JSON.stringify({ jsonrpc: '2.0', ...r })).join('\n') + '\n');
    const code = await new Promise((done, reject) => { child.on('error', reject); child.on('close', done); });
    assert.equal(code, 0, errors);
    const result = new Map(output.trim().split('\n').map(line => { const r = JSON.parse(line); return [r.id, r.result]; }));
    assert.deepEqual(result.get(2).tools, []);
    assert.match(result.get(1).instructions, /cooperation_context_checkpoint/);
    assert.equal(result.get(3).isError, true);
    assert.match(result.get(3).content[0].text, /原生/);
    assert.doesNotMatch(result.get(3).content[0].text, /ENOENT|阶段回执|from/);
  });
}
