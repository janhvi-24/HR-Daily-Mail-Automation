// Called by Vercel Cron (see vercel.json). Vercel sends "Authorization: Bearer $CRON_SECRET".
// Runs every enabled account; each one is independent.
import { json, realDeps } from '../lib/app';
import { hasCronSecret } from '../lib/auth';
import { safeMessage } from '../lib/env';
import { runAll } from '../lib/workflow';

export async function GET(req: Request) {
  if (!hasCronSecret(req)) return json({ error: 'Unauthorized' }, 401);
  try {
    const deps = realDeps();
    const accounts = (await deps.store.listAccounts()).filter((a) => a.enabled);
    const results = await runAll(deps, accounts, 'cron');
    for (const r of results) console.log('cron', r.accountId, r.date, r.outcome);
    return json({ results: results.map(({ email, ...r }) => r) });
  } catch (error) {
    console.error('cron failed', safeMessage(error));
    return json({ error: safeMessage(error) }, 500);
  }
}
