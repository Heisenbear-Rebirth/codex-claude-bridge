// Presentation only: these bytes go to the IDE, never back to Claude.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENVELOPE = /^发送方：(codex|claude):\/\/[^\r\n]+:([a-zA-Z0-9_-]{8,128})\r?\n发送方地址：(codex|claude):([a-zA-Z0-9_-]{8,128})\r?\n消息编号：([0-9a-f-]{36})\r?\n\r?\n/gm;
const LABEL = '【Cooperation 会话消息】\n';

export function visiblePeerMessage(message, sessionId) {
  if (!UUID.test(sessionId || '') || message?.session_id?.toLowerCase?.() !== sessionId.toLowerCase()
    || message.type !== 'user' || message.isReplay !== true || message.parent_tool_use_id != null
    || message.origin?.kind !== 'peer' || !UUID.test(message.uuid || '') || message.message?.role !== 'user') return message;
  const content = message.message.content;
  if (typeof content !== 'string' && (!Array.isArray(content) || !content.length
    || content.some(block => block?.type !== 'text' || typeof block.text !== 'string'))) return message;
  const text = typeof content === 'string' ? content : content.map(block => block.text).join('\n');
  const matches = [...text.matchAll(ENVELOPE)];
  if (matches.length !== 1) return message;
  const [, client, sender, addressClient, addressId, id] = matches[0];
  if (client !== addressClient || sender !== addressId || id.toLowerCase() !== message.uuid.toLowerCase()) return message;
  const labelled = text.startsWith(LABEL);
  const visible = labelled ? content : typeof content === 'string' ? LABEL + content
    : content.map((block, index) => index === 0 ? { ...block, text: LABEL + block.text } : block);
  return { ...message, isSynthetic: false, message: { ...message.message, content: visible } };
}

// Bounded line framing. Malformed, oversized and incomplete frames pass unchanged.
export class PeerMessageVisibility {
  constructor(sessionId, maximum = 1024 * 1024) {
    this.sessionId = sessionId; this.maximum = maximum; this.parts = []; this.size = 0; this.passthrough = false; this.seen = new Set(); this.history = [];
  }
  push(chunk, forward) {
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset);
      const part = chunk.subarray(offset, end < 0 ? chunk.length : end + 1);
      if (this.passthrough) forward(part);
      else if (this.size + part.length > this.maximum) {
        for (const saved of this.parts) forward(saved);
        this.parts = []; this.size = 0; this.passthrough = true; forward(part);
      } else { this.parts.push(part); this.size += part.length; }
      if (end < 0) return;
      if (!this.passthrough) {
        const line = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.size);
        let output = line;
        try {
          const original = JSON.parse(line.toString('utf8'));
          const projected = visiblePeerMessage(original, this.sessionId());
          if (projected !== original) {
            output = this.firstDisplay(projected)
              ? Buffer.from(JSON.stringify(projected) + (line.at(-2) === 13 ? '\r\n' : '\n')) : null;
          }
        } catch { /* Preserve native bytes if parsing or projection is unavailable. */ }
        if (output !== null) forward(output);
      }
      this.parts = []; this.size = 0; this.passthrough = false; offset = end + 1;
      this.flushHistory(forward);
    }
  }
  firstDisplay(frame) {
    const key = `${frame.session_id.toLowerCase()}:${frame.uuid.toLowerCase()}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key); return true;
  }
  restoreHistory(frames, forward) {
    this.history = frames.flatMap(frame => {
      const projected = visiblePeerMessage(frame, this.sessionId());
      return projected !== frame ? [projected] : [];
    });
    this.flushHistory(forward);
  }
  flushHistory(forward) {
    if (this.size || this.passthrough) return;
    for (const frame of this.history) {
      if (!this.firstDisplay(frame)) continue;
      // Share the native replay ledger; do not rely on the IDE to discard duplicates.
      forward(Buffer.from(JSON.stringify(frame) + '\n'));
    }
    this.history = [];
  }
  end(forward) { for (const part of this.parts) forward(part); this.parts = []; this.size = 0; this.passthrough = false; }
}
