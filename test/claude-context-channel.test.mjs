import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeContextChannel } from '../src/claude-context-channel.mjs';

test('native query response can share chunks with IDE replies and preserves UTF8/CRLF bytes', async () => {
  let sent; const channel = new NativeContextChannel(bytes => { sent = JSON.parse(bytes); }, () => true);
  const result = channel.query(); const forwarded = [];
  const ordinary = Buffer.from('{"type":"assistant","text":"中文🙂"}\r\n');
  const owned = Buffer.from(JSON.stringify({ type: 'control_response', response: { request_id: sent.request_id, subtype: 'success', response: { totalTokens: 10, rawMaxTokens: 100 } } }) + '\n');
  const other = Buffer.from('{"type":"control_response","response":{"request_id":"ide-owned"}}\n');
  const all = Buffer.concat([ordinary, owned, other]);
  for (let index = 0; index < all.length; index += 3) channel.push(all.subarray(index, index + 3), part => forwarded.push(part));
  assert.deepEqual(Buffer.concat(forwarded), Buffer.concat([ordinary, other]));
  assert.equal((await result).usedPercent, 10); channel.close();
});
test('context request refuses a busy input boundary without writing to Claude', async () => {
  let wrote = false; const channel = new NativeContextChannel(() => { wrote = true; }, () => false);
  await assert.rejects(channel.query(), /input boundary/); assert.equal(wrote, false); channel.close();
});
