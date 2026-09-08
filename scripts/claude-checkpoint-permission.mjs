import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = join(root, '.claude', 'settings.local.json');
const folder = join(root, '.cooperation', 'proposals', 'checkpoint-permission');
const rule = `Bash(node ${join(root, 'bin', 'coop-checkpoint.mjs').replaceAll('\\', '/')} *)`;
const sha = value => createHash('sha256').update(value).digest('hex');
const mode = process.argv[2];
if (!['prepare', 'apply', 'restore'].includes(mode)) throw new Error('Use prepare|apply|restore. Apply only after explicit user approval.');
if (mode === 'prepare') {
  const original = await readFile(target, 'utf8'); const source = JSON.parse(original);
  if (source.permissions?.allow && !Array.isArray(source.permissions.allow)) throw new Error('Unexpected permissions.allow shape.');
  const changed = { ...source, permissions: { ...source.permissions, allow: [...new Set([...(source.permissions?.allow || []), rule])] } };
  const candidate = JSON.stringify(changed, null, 2) + '\n';
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'original.json'), original);
  await writeFile(join(folder, 'proposed-settings.local.json'), candidate);
  await writeFile(join(folder, 'manifest.json'), JSON.stringify({ target, rule, originalHash: sha(original), proposedHash: sha(candidate), preparedAt: new Date().toISOString() }, null, 2) + '\n');
  await writeFile(join(folder, 'CHANGE.md'), `# Proposed project-only checkpoint permission\n\nTarget: ${target}\n\nAdd one allow rule, keeping the existing rule and all other settings:\n\n\`\`\`json\n${JSON.stringify(rule)}\n\`\`\`\n\nThe command only submits a structured maintenance receipt using the real calling session identity. It has no service, peer messaging, model, or permission-setting operation. This permission applies to Claude sessions started in this project. Native permission mode stays unchanged.\n\nStatus: prepared, not applied.\n`);
  console.log(JSON.stringify({ status: 'prepared-not-applied', target, rule, proposal: join(folder, 'CHANGE.md'), originalHash: sha(original), proposedHash: sha(candidate) }, null, 2));
} else {
  const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
  if (manifest.target !== target || manifest.rule !== rule) throw new Error('Proposal target or rule does not match this project.');
  const current = await readFile(target, 'utf8');
  const expected = mode === 'apply' ? manifest.originalHash : manifest.proposedHash;
  if (sha(current) !== expected) throw new Error('Project settings changed after preparation; refusing to overwrite.');
  const contents = await readFile(join(folder, mode === 'apply' ? 'proposed-settings.local.json' : 'original.json'), 'utf8');
  if (sha(contents) !== (mode === 'apply' ? manifest.proposedHash : manifest.originalHash)) throw new Error('Proposal backup hash mismatch.');
  await writeFile(target + '.cooperation-tmp', contents); await rename(target + '.cooperation-tmp', target);
  if (sha(await readFile(target, 'utf8')) !== sha(contents)) throw new Error('Settings verification failed.');
  console.log(JSON.stringify({ status: mode === 'apply' ? 'applied' : 'restored', target, rule, hash: sha(contents) }, null, 2));
}
