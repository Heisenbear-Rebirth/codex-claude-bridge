import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'settings.json');
const key = 'claudeCode.claudeProcessWrapper';
const desired = join(root, 'bin', 'claude-wrapper.exe');
const hash = value => createHash('sha256').update(value).digest('hex');
function tokens(text) {
  const result = []; let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < text.length) {
    if (/\s/.test(text[index])) { index++; continue; }
    if (text.slice(index, index + 2) === '//') { const end = text.indexOf('\n', index); index = end < 0 ? text.length : end; continue; }
    if (text.slice(index, index + 2) === '/*') { const end = text.indexOf('*/', index + 2); if (end < 0) throw new Error('Unclosed settings comment.'); index = end + 2; continue; }
    const start = index;
    if (text[index] === '"') {
      index++;
      while (index < text.length) { if (text[index] === '\\') { index += 2; continue; } if (text[index++] === '"') break; }
    } else if ('{}[]:,'.includes(text[index])) index++;
    else { while (index < text.length && !/[\s{}\[\]:,\/]/.test(text[index])) index++; if (index === start) throw new Error('Invalid settings token.'); }
    result.push({ start, end: index, raw: text.slice(start, index) });
  }
  return result;
}
function parse(text) {
  const list = tokens(text);
  const json = list.filter((token, index) => token.raw !== ',' || !['}', ']'].includes(list[index + 1]?.raw)).map(token => token.raw).join('');
  const value = JSON.parse(json);
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('VS Code settings must be an object.');
  return { value, list };
}
export function prepareText(text) {
  const before = parse(text); let depth = 0; let match;
  for (let index = 0; index < before.list.length; index++) {
    const token = before.list[index];
    if (depth === 1 && token.raw.startsWith('"') && before.list[index + 1]?.raw === ':' && JSON.parse(token.raw) === key) {
      if (match) throw new Error('Duplicate wrapper setting.');
      match = before.list[index + 2];
    }
    if (['{', '['].includes(token.raw)) depth++;
    if (['}', ']'].includes(token.raw)) depth--;
  }
  let proposed;
  if (match) {
    if (!match.raw.startsWith('"') && match.raw !== 'null') throw new Error('Existing wrapper setting has an unexpected type.');
    if (before.value[key] && before.value[key] !== desired) throw new Error('An existing different Claude wrapper is configured. Preserve it and review integration first.');
    proposed = text.slice(0, match.start) + JSON.stringify(desired) + text.slice(match.end);
  } else {
    const opening = before.list[0]; const eol = text.includes('\r\n') ? '\r\n' : '\n';
    proposed = text.slice(0, opening.end) + eol + '    ' + JSON.stringify(key) + ': ' + JSON.stringify(desired)
      + (Object.keys(before.value).length ? ',' : '') + text.slice(opening.end);
  }
  const after = parse(proposed).value;
  const old = { ...before.value }; delete old[key]; const remaining = { ...after }; delete remaining[key];
  assert.deepEqual(remaining, old); assert.equal(after[key], desired);
  return { proposed, originalWrapper: Object.hasOwn(before.value, key) ? before.value[key] : null, originallyPresent: Object.hasOwn(before.value, key) };
}
async function main() {
  const action = process.argv[2];
  const directory = join(root, '.cooperation', 'backups');
  const manifestPath = join(directory, 'vscode-wrapper-change.json');
  if (action === 'prepare') {
    const original = await readFile(target); const text = original.toString('utf8'); const prepared = prepareText(text);
    await mkdir(directory, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const backup = join(directory, `vscode-settings-${stamp}.original.json`);
    const proposed = join(directory, `vscode-settings-${stamp}.proposed.json`);
    await writeFile(backup, original, { flag: 'wx' }); await writeFile(proposed, prepared.proposed, { flag: 'wx' });
    const manifest = { target, backup, proposed, originalHash: hash(original), proposedHash: hash(prepared.proposed), key, desired, originalWrapper: prepared.originalWrapper, originallyPresent: prepared.originallyPresent };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(JSON.stringify({ action, target, key, desired, backup, originalHash: manifest.originalHash, changed: manifest.originalHash !== manifest.proposedHash }, null, 2));
  } else if (action === 'apply' || action === 'restore') {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.target !== target || manifest.key !== key || manifest.desired !== desired) throw new Error('Unexpected change manifest.');
    const current = await readFile(target);
    const expected = action === 'apply' ? manifest.originalHash : manifest.proposedHash;
    if (hash(current) !== expected) throw new Error('Settings changed since preparation. Nothing was overwritten.');
    const contents = await readFile(action === 'apply' ? manifest.proposed : manifest.backup);
    if (hash(contents) !== (action === 'apply' ? manifest.proposedHash : manifest.originalHash)) throw new Error('Prepared/backup file integrity check failed.');
    if (action === 'apply') assert.equal(prepareText(current.toString('utf8')).proposed, contents.toString('utf8'));
    await writeFile(target, contents);
    assert.equal(hash(await readFile(target)), hash(contents));
    console.log(JSON.stringify({ action, target, key, verified: true }, null, 2));
  } else throw new Error('Use prepare | apply | restore. User authorization is required for these external settings operations.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
