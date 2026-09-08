import { parseAddress } from '../src/address.mjs';
import { readRecordedContext } from '../src/context-usage.mjs';
const args = process.argv.slice(2);
try {
  const at = args.indexOf('--to');
  if (at < 0) throw new Error('Use: node bin/coop-context.mjs --to codex:ID|claude:ID');
  const target = parseAddress(args[at + 1]);
  console.log(JSON.stringify(await readRecordedContext(target), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
