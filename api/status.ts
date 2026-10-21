// Dashboard data: accounts (no passwords), today's status per account, history, logs. Admin only.
import { json, toPublic } from '../lib/app';
import { isAdmin } from '../lib/auth';
import { geminiModel, safeMessage, serviceAccountEmail, timezone } from '../lib/env';
import { oauthConfigured } from '../lib/oauth';
import { PROVIDERS } from '../lib/providers';
import { postgresStore } from '../lib/store';
import { longDate, todayIn, weekdayName } from '../lib/time';

export async function GET(req: Request) {
  if (!isAdmin(req)) return json({ error: 'Unauthorized' }, 401);
  try {
    const store = postgresStore();
    const tz = timezone();
    const { date, weekday } = todayIn(tz);
    const [accounts, history, logs] = await Promise.all([store.listAccounts(), store.history(100), store.logs(80)]);
    return json({
      today: { date, dateLong: longDate(date), weekday, weekdayName: weekdayName(weekday) },
      accounts: accounts.map(toPublic),
      history,
      logs,
      config: {
        timezone: tz,
        aiModel: geminiModel(),
        serviceAccountEmail: serviceAccountEmail(),
        providers: PROVIDERS,
        oauth: { google: oauthConfigured('google'), microsoft: oauthConfigured('microsoft') },
      },
    });
  } catch (error) {
    return json({ error: safeMessage(error) }, 500);
  }
}
