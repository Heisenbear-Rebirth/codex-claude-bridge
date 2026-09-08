const ID = /^[a-zA-Z0-9_-]{8,128}$/;
export function parseAddress(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('请提供 codex:会话ID、claude:会话ID 或原生会话链接。');
  const address = input.trim();
  if (address.startsWith('vscode://anthropic.claude-code/open?')) {
    return checked('claude', new URL(address).searchParams.get('session'));
  }
  const match = /^(codex|claude):(.*)$/i.exec(address);
  if (!match) throw new Error('会话地址必须带 codex: 或 claude: 前缀。');
  const client = match[1].toLowerCase();
  let rest = match[2];
  if (rest.startsWith('//threads/')) rest = rest.slice(10);
  else if (rest.startsWith('//')) rest = rest.slice(2).slice(rest.slice(2).lastIndexOf(':') + 1);
  return checked(client, rest);
}
function checked(client, id) {
  if (!id || !ID.test(id)) throw new Error('无效的会话 ID。');
  return { client, id };
}
export function sessionAddress(session) { return `${session.client}:${session.id}`; }
export function displayAddress(session) {
  const name = (String(session.name || '未命名会话')).replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 200);
  return `${session.client}://${name}:${session.id}`;
}
export function publicSession(session) {
  return {
    client: session.client, id: session.id, name: session.name || '未命名会话', cwd: session.cwd || '',
    status: session.status || 'unknown', live: Boolean(session.live), updatedAt: session.updatedAt || null,
    address: sessionAddress(session), displayAddress: displayAddress(session),
  };
}
export function messageEnvelope(from, text, id) {
  return `发送方：${displayAddress(from)}\n发送方地址：${sessionAddress(from)}\n消息编号：${id}\n\n${text}`;
}
