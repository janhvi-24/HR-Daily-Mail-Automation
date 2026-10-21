// Fills in .env from .env.example without overwriting anything you already set:
//   - generates ENCRYPTION_KEY and CRON_SECRET
//   - converts the service-account key file into GOOGLE_SERVICE_ACCOUNT_JSON (base64)
// Never prints secret values. Usage: npm run setup [-- path/to/key.json]
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const ENV = '.env';

function parse(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) vars.set(m[1], m[2].trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  return vars;
}

function findKeyFile(arg?: string): string | null {
  const candidates = arg ? [arg] : readdirSync('.').filter((f) => f.endsWith('.json'));
  for (const file of candidates) {
    try {
      const json = JSON.parse(readFileSync(file, 'utf8'));
      if (json.type === 'service_account' && json.private_key && json.client_email) return file;
    } catch {
      /* not a key file */
    }
  }
  return null;
}

const template = readFileSync('.env.example', 'utf8');
const current = existsSync(ENV) ? parse(readFileSync(ENV, 'utf8')) : new Map<string, string>();
const defaults = parse(template);
const filled: string[] = [];

const generated: Record<string, () => string | null> = {
  ENCRYPTION_KEY: () => randomBytes(32).toString('hex'),
  CRON_SECRET: () => randomBytes(32).toString('hex'),
  GOOGLE_SERVICE_ACCOUNT_JSON: () => {
    const file = findKeyFile(process.argv[2]);
    if (!file) return null;
    const json = JSON.parse(readFileSync(file, 'utf8'));
    console.log(`Using service account ${json.client_email} from ${file}`);
    return Buffer.from(JSON.stringify(json)).toString('base64');
  },
};

const value = (name: string): string => {
  const existing = current.get(name);
  if (existing) return existing;
  const make = generated[name];
  const made = make?.();
  if (made) {
    filled.push(name);
    return made;
  }
  return defaults.get(name) ?? '';
};

// Rebuild .env in the template's order (keeping its comments), plus any extra vars you added.
const out = template.split('\n').map((line) => {
  const m = line.match(/^([A-Z0-9_]+)=/);
  return m ? `${m[1]}=${value(m[1])}` : line;
});
for (const [name, v] of current) if (!defaults.has(name)) out.push(`${name}=${v}`);
writeFileSync(ENV, out.join('\n'), { mode: 0o600 });
chmodSync(ENV, 0o600); // owner-only, also when .env already existed

const final = parse(out.join('\n'));
const todo: Record<string, string> = {
  GEMINI_API_KEY: 'paste your key from https://aistudio.google.com/apikey',
  ADMIN_PASSWORD: 'choose the dashboard password (a long passphrase)',
  DATABASE_URL: 'created by Vercel → Storage → Neon (README step 4); paste it here to test locally',
};
console.log(filled.length ? `Generated: ${filled.join(', ')}` : 'Nothing new to generate.');
const missing = Object.keys(todo).filter((k) => !final.get(k));
if (missing.length) {
  console.log('\nStill needed in .env:');
  for (const k of missing) console.log(`  ${k.padEnd(16)} ${todo[k]}`);
} else {
  console.log('\nAll required values are set.');
}
console.log('\nOptional: GOOGLE_OAUTH_* / MICROSOFT_OAUTH_* only for the Gmail/Outlook sign-in buttons.');
