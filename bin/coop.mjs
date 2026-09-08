#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { startServer } from '../src/http-server.mjs';
import { startMcp } from '../src/mcp.mjs';
import { detectSender } from '../src/identity.mjs';
import { sendViaManager, checkpointViaManager } from '../src/client.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [command = 'help', ...args] = process.argv.slice(2);
function option(name) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
try {
  if (command === 'serve') {
    const codexContext = { pipePath: process.env.CODEX_APP_TOOLS_PIPE_PATH, callerThreadId: process.env.CODEX_THREAD_ID, nodePath: process.env.CODEX_MCP_NODE_PATH };
    const instance = await startServer({ root, port: Number(option('--port') || 0), defaultDirectory: resolve(option('--directory') || process.cwd()), codexContext });
    console.log(`Cooperation 管理台：${instance.url}`);
    console.log(`数据保存于：${resolve(root, '.cooperation')}`);
    if (!codexContext.pipePath || !codexContext.callerThreadId) console.log('未连接 Codex App 发送桥；会话元数据与消息记录仍可查看。');
    const stop = () => instance.close().finally(() => process.exit(0));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } else if (command === 'mcp') startMcp({ root, client: option('--client') });
  else if (command === 'context' && args[0] === 'checkpoint') {
    const from = await detectSender({ client: option('--client') });
    const result = await checkpointViaManager(root, { from, cycleId: option('--cycle'), stage: option('--stage'),
      receiptToken: option('--receipt-token'), documentPath: option('--document') });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'send') {
    const message = option('--file') ? await readFile(resolve(option('--file')), 'utf8') : option('--text');
    const from = await detectSender({ client: option('--client') });
    const result = await sendViaManager(root, { from, to: option('--to'), message });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'failed') process.exitCode = 1;
  } else {
    console.log('Cooperation\n\n  node bin/coop.mjs serve [--directory PATH] [--port 47821]\n  node bin/coop.mjs send --to ADDRESS --text MESSAGE [--client codex|claude]\n  node bin/coop.mjs send --to ADDRESS --file REPORT.txt [--client codex|claude]\n  node bin/coop.mjs context checkpoint --cycle ID --stage handoff|restored --receipt-token TOKEN --document PATH\n  node bin/coop.mjs mcp [--client codex|claude]\n\n会话查询与消息历史位于用户管理页面；MCP 提供 send_message 和 context_checkpoint。');
    if (command !== 'help' && command !== '--help') process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
