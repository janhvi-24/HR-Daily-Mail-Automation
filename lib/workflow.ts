// The daily automation for one account: check sheet -> generate -> send -> record.
// Dependencies are injected so the whole flow is testable without network access.

import type { Account } from './accounts';
import type { EmailContent } from './ai';
import { composeEmail, type ComposedEmail } from './compose';
import { safeMessage } from './env';
import type { Entry, SheetResult } from './sheet';
import type { RunStore } from './store';
import { todayIn, weekdayName } from './time';

export type Mode = 'cron' | 'check' | 'preview' | 'send';

export interface Deps {
  timezone: string;
  store: RunStore;
  readSheet(account: Account, isoDate: string): Promise<SheetResult>;
  generate(entries: Entry[]): Promise<EmailContent>;
  send(account: Account, mail: ComposedEmail & { to: string }): Promise<{ messageId: string }>;
  now?: () => Date;
}

export type Outcome =
  | 'SKIPPED_NON_WORKING_DAY'
  | 'SKIPPED_DISABLED'
  | 'ALREADY_SENT'
  | 'SEND_IN_PROGRESS'
  | 'MISSING'
  | 'INCOMPLETE'
  | 'READY'
  | 'PREVIEW'
  | 'SENT'
  | 'ERROR';

export interface RunResult {
  accountId: number;
  date: string;
  outcome: Outcome;
  message: string;
  email?: ComposedEmail;
}

export async function runDaily(deps: Deps, account: Account, mode: Mode): Promise<RunResult> {
  const { store } = deps;
  const id = account.id;
  const { date, weekday } = todayIn(deps.timezone, deps.now?.() ?? new Date());
  const log = (event: string, result: string, detail?: string) => store.log(id, date, event, result, detail ?? null);
  const done = async (outcome: Outcome, message: string, email?: ComposedEmail): Promise<RunResult> => {
    if (mode === 'cron') await log('AUTOMATION_COMPLETED', outcome);
    return { accountId: id, date, outcome, message, email };
  };

  if (mode === 'cron') {
    if (!account.enabled) return { accountId: id, date, outcome: 'SKIPPED_DISABLED', message: 'Automation is paused.' };
    await log('CRON_STARTED', 'OK');
  }

  // Working-day guard (independent of the cron schedule). Check/preview stay available.
  if ((mode === 'cron' || mode === 'send') && !account.workingDays.includes(weekday)) {
    await log('SKIPPED', 'NON_WORKING_DAY', weekdayName(weekday));
    return done('SKIPPED_NON_WORKING_DAY', `${weekdayName(weekday)} is not a working day for this account.`);
  }

  // Duplicate guard #1 (cheap early exit; the atomic claim below is the real lock).
  const existing = await store.getDay(id, date);
  if (existing?.status === 'SENT') {
    await log('DUPLICATE_GUARD', 'ALREADY_SENT');
    return done('ALREADY_SENT', 'Today\'s email has already been sent.');
  }
  if (existing?.status === 'SENDING' && (mode === 'cron' || mode === 'send')) {
    await log('DUPLICATE_GUARD', 'SEND_IN_PROGRESS');
    return done('SEND_IN_PROGRESS', 'A send for today is already in progress or unconfirmed. Check your Sent folder.');
  }

  // 1. Sheet
  let sheet: SheetResult;
  try {
    sheet = await deps.readSheet(account, date);
  } catch (error) {
    const detail = `Unable to read sheet: ${safeMessage(error)}`;
    await store.setStatus(id, date, 'ERROR', 'ERROR', detail);
    await log('SHEET_CHECK', 'ERROR', detail);
    return done('ERROR', detail);
  }
  if (sheet.state !== 'READY') {
    const message =
      sheet.state === 'MISSING' ? 'No row for today in the sheet.' : 'Today\'s row exists but has no tasks/activities.';
    await store.setStatus(id, date, sheet.state, sheet.state, message);
    await log('SHEET_CHECK', sheet.state);
    return done(sheet.state, message);
  }
  await log('SHEET_CHECK', 'UPDATED', `${sheet.entries.length} row(s)`);

  if (mode === 'check') {
    await store.setStatus(id, date, 'READY', 'UPDATED', 'Sheet updated; email not sent yet.');
    return done('READY', 'Today\'s sheet entry is ready.');
  }

  // 2. AI
  let email: ComposedEmail;
  try {
    email = composeEmail(date, await deps.generate(sheet.entries), account);
  } catch (error) {
    const detail = `Unable to generate email: ${safeMessage(error)}`;
    await store.setStatus(id, date, 'ERROR', 'UPDATED', detail);
    await log('AI_GENERATION', 'ERROR', detail);
    return done('ERROR', detail);
  }
  await log('AI_GENERATION', 'SUCCESS');

  if (mode === 'preview') {
    await store.setStatus(id, date, 'READY', 'UPDATED', 'Preview generated; email not sent yet.');
    return done('PREVIEW', 'Preview generated. Nothing was sent.', email);
  }

  // 3. Send — duplicate guard #2: atomic claim. Only one caller can win it per account per day.
  if (!(await store.claimForSending(id, date, email.subject, email.text))) {
    await log('DUPLICATE_GUARD', 'CLAIM_REJECTED');
    return done('ALREADY_SENT', 'Today\'s email was already sent or is being sent.');
  }

  let messageId: string;
  try {
    ({ messageId } = await deps.send(account, { ...email, to: account.hrEmail }));
  } catch (error) {
    const detail = `Email delivery failed: ${safeMessage(error)}`;
    await store.markSendFailed(id, date, detail);
    await log('EMAIL_SEND', 'ERROR', detail);
    return done('ERROR', detail, email);
  }

  try {
    await store.markSent(id, date, messageId);
  } catch (error) {
    // The email went out; the row stays SENDING, which still blocks any resend.
    console.error('markSent failed', safeMessage(error));
  }
  await log('EMAIL_SEND', 'SUCCESS', `message id ${messageId}`);
  return done('SENT', `Email sent to ${account.hrEmail}.`, email);
}

/** Runs every account independently; one account failing never affects another. */
export async function runAll(deps: Deps, accounts: Account[], mode: Mode): Promise<RunResult[]> {
  const settled = await Promise.allSettled(accounts.map((a) => runDaily(deps, a, mode)));
  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { accountId: accounts[i].id, date: '', outcome: 'ERROR' as const, message: safeMessage(s.reason) },
  );
}
