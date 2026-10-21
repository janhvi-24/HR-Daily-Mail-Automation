// Copies every non-empty value from .env to the linked Vercel project (Production),
// marked "sensitive". DATABASE_URL is skipped: the Neon integration manages it.
// Usage: npm run push-env   (after `vercel login` and `vercel link`)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SKIP = new Set(['DATABASE_URL']);
const vars = readFileSync('.env', 'utf8')
  .split('\n')
  .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
  .filter((m): m is RegExpMatchArray => Boolean(m && m[2].trim() && !SKIP.has(m[1])))
  .map((m) => [m[1], m[2].trim().replace(/^(['"])(.*)\1$/, '$2')] as const);

let failed = 0;
for (const [name, value] of vars) {
  const r = spawnSync('vercel', ['env', 'add', name, 'production', '--force', '--sensitive', '--yes'], {
    input: value,
    encoding: 'utf8',
  });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  ${(r.stderr || r.stdout).trim().split('\n').pop()}`}`);
}
console.log(failed ? `\n${failed} failed. Run \`vercel login\` and \`vercel link\` first.` : '\nDone. Redeploy for changes to apply: vercel deploy --prod');
process.exit(failed ? 1 : 0);
