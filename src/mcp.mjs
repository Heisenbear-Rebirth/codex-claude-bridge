import { createInterface } from 'node:readline';
import { detectSender } from './identity.mjs';
import { sendViaManager, checkpointViaManager } from './client.mjs';
export const checkpointTool = { name: 'context_checkpoint', description: '在 Cooperation 指定的上下文维护流程中，确认交付文档已写好或上文已加载。只用于已收到 cycleId 和阶段凭证的维护请求。', inputSchema: {
  type: 'object', properties: { cycleId: { type: 'string' }, stage: { type: 'string', enum: ['handoff', 'restored'] }, receiptToken: { type: 'string' }, documentPath: { type: 'string', description: '本会话工作目录内交付文档的绝对路径。' } },
  required: ['cycleId', 'stage', 'receiptToken', 'documentPath'], additionalProperties: false } };
export function startMcp({ root, client } = {}) {
  const input = createInterface({ input: process.stdin });
  const respond = (id, result, error) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n');
  input.on('line', async (line) => {
    let request;
    try { request = JSON.parse(line); } catch { respond(null, null, { code: -32700, message: 'Invalid JSON' }); return; }
    if (!Object.hasOwn(request, 'id')) return;
    try {
      if (request.method === 'initialize') return respond(request.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cooperation', version: '0.2.0' }, instructions: '向用户指定的 Codex 或 Claude Code 会话发送正文，或在指定维护流程中回传阶段回执。工具自动取得当前发送方身份。' });
      if (request.method === 'ping') return respond(request.id, {});
      if (request.method === 'tools/list') return respond(request.id, { tools: [{ name: 'send_message', description: '向指定的现有原生会话发送一条消息。只发送给定正文，自动附带发送方身份；返回投递结果。', inputSchema: { type: 'object', properties: { to: { type: 'string', description: '接收方地址：codex:ID、claude:ID、客户端://会话名称:ID，或 Codex 原生深度链接。' }, message: { type: 'string', description: '要发送的完整消息正文。' } }, required: ['to', 'message'], additionalProperties: false } }, checkpointTool] });
      if (request.method === 'tools/call') {
        if (!['send_message', 'context_checkpoint'].includes(request.params?.name)) throw new Error('Unknown tool');
        const args = request.params.arguments || {};
        if (request.params.name === 'context_checkpoint') {
          if (Object.keys(args).some(key => !['cycleId', 'stage', 'receiptToken', 'documentPath'].includes(key))) throw new Error('Invalid checkpoint fields.');
          const from = await detectSender({ client, metadata: request.params._meta });
          const result = await checkpointViaManager(root, { from, ...args });
          return respond(request.id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
        }
        if (Object.keys(args).some((key) => !['to', 'message'].includes(key))) throw new Error('Only to and message are accepted.');
        const from = await detectSender({ client, metadata: request.params._meta });
        const result = await sendViaManager(root, { from, to: args.to, message: args.message });
        return respond(request.id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.status === 'failed' });
      }
      respond(request.id, null, { code: -32601, message: 'Method not found' });
    } catch (error) {
      if (request.method === 'tools/call') respond(request.id, { content: [{ type: 'text', text: error.message }], isError: true });
      else respond(request.id, null, { code: -32602, message: error.message });
    }
  });
}
