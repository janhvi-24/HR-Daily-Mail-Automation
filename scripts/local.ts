// Run the real workflow from your machine with credentials from .env:
//   npm run local -- accounts                  list connected accounts
//   npm run local -- check   <accountId>       read the sheet only
//   npm run local -- preview <accountId>       sheet + Gemini, prints the email, sends nothing
//   npm run local -- send    <accountId> --yes really sends to that account's HR
//   npm run local -- cron --yes                exactly what the scheduler does, for all accounts
//   npm run local -- status                    recent history and logs
import { realDeps } from '../lib/app';
import { runAll, runDaily } from '../lib/workflow';

async function main() {
  const [action = 'accounts', ...rest] = process.argv.slice(2);
  const confirmed = rest.includes('--yes');
  const deps = realDeps();
  const accounts = await deps.store.listAccounts();

  if (action === 'accounts') {
    console.table(accounts.map((a) => ({ id: a.id, label: a.label, via: a.provider, enabled: a.enabled, from: a.senderEmail, to: a.hrEmail })));
  } else if (action === 'status') {
    console.table(await deps.store.history(15));
    console.table(await deps.store.logs(25));
  } else if (action === 'cron') {
    if (!confirmed) throw new Error('"cron" really emails HR for every enabled account. Re-run with --yes.');
    console.table(await runAll(deps, accounts.filter((a) => a.enabled), 'cron'));
  } else if (action === 'check' || action === 'preview' || action === 'send') {
    const account = accounts.find((a) => a.id === Number(rest[0]));
    if (!account) throw new Error(`Unknown account id "${rest[0] ?? ''}". Run: npm run local -- accounts`);
    if (action === 'send' && !confirmed) throw new Error(`"send" really emails ${account.hrEmail}. Re-run with --yes.`);
    const result = await runDaily(deps, account, action);
    console.log(`\n${account.label}  ${result.date}  ${result.outcome}\n${result.message}`);
    if (result.email) console.log(`\nSubject: ${result.email.subject}\n\n${result.email.text}\n`);
  } else {
    throw new Error('Usage: npm run local -- accounts | check <id> | preview <id> | send <id> --yes | cron --yes | status');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
