// Manual dashboard actions: { "accountId": 1, "action": "check" | "preview" | "send" }. Admin only.
import { json, realDeps } from '../lib/app';
import { isAdmin, sameOrigin } from '../lib/auth';
import { safeMessage } from '../lib/env';
import { runDaily } from '../lib/workflow';

const ACTIONS = ['check', 'preview', 'send'] as const;

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: 'Forbidden' }, 403);
  if (!isAdmin(req)) return json({ error: 'Unauthorized' }, 401);
  const body = (await req.json().catch(() => null)) as { action?: unknown; accountId?: unknown } | null;
  const action = ACTIONS.find((a) => a === body?.action);
  if (!action) return json({ error: 'action must be check, preview or send' }, 400);
  try {
    const deps = realDeps();
    const account = Number.isInteger(body?.accountId) ? await deps.store.getAccount(body!.accountId as number) : null;
    if (!account) return json({ error: 'Account not found' }, 404);
    return json(await runDaily(deps, account, action));
  } catch (error) {
    console.error('run failed', action, safeMessage(error));
    return json({ error: safeMessage(error) }, 500);
  }
}
