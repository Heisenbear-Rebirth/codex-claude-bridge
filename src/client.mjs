import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function sendViaManager(root, payload) {
  return requestManager(root, '/api/send', payload);
}
export async function checkpointViaManager(root, payload) {
  return requestManager(root, '/api/checkpoint', payload);
}
async function requestManager(root, endpoint, payload) {
  let connection;
  try { connection = JSON.parse(await readFile(join(root, '.cooperation', 'connection.json'), 'utf8')); }
  catch { throw new Error('管理台尚未启动。请在 Codex 会话的终端运行 node bin/coop.mjs serve。'); }
  const url = new URL(connection.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('通信服务必须是本机地址。');
  let response;
  try {
    response = await fetch(new URL(endpoint, url), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify(payload), signal: AbortSignal.timeout(60000) });
  } catch (error) { throw new Error(error.name === 'TimeoutError' ? '发送结果待确认，请在管理台核对；不会自动重发。' : '无法连接本地管理台，请检查它是否仍在运行。'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '发送失败。');
  return result;
}
