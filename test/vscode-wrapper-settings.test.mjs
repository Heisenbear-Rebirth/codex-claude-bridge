import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareText } from '../scripts/vscode-wrapper-settings.mjs';

test('settings patch preserves unrelated JSONC comments, strings and trailing commas', () => {
  const original = '{\r\n  // user comment\r\n  "url": "https://example.com/a//b",\r\n  "nested": { "text": "not /* a comment */", },\r\n}\r\n';
  const prepared = prepareText(original);
  assert.equal(prepared.originallyPresent, false);
  assert.ok(prepared.proposed.endsWith(original.slice(1)));
  assert.ok(prepared.proposed.includes('claudeCode.claudeProcessWrapper'));
});
test('settings patch refuses to replace another wrapper', () => {
  assert.throws(() => prepareText('{"claudeCode.claudeProcessWrapper":"C:/other/wrapper.exe"}'), /existing different/);
});
test('settings patch rejects duplicate wrapper entries and invalid JSON', () => {
  assert.throws(() => prepareText('{"claudeCode.claudeProcessWrapper":null,"claudeCode.claudeProcessWrapper":null}'), /Duplicate/);
  assert.throws(() => prepareText('{ invalid }'));
});
