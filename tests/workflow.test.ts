import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, parseSheetId, validateAccount, ValidationError, type Account } from '../lib/accounts';
import { parseGeminiResponse, validate } from '../lib/ai';
import { isAdmin, sessionCookie } from '../lib/auth';
import { decrypt, encrypt } from '../lib/crypto';
import { safeMessage } from '../lib/env';
import { classify, findEntries, parseSheetDate, type SheetResult } from '../lib/sheet';
import type { DayRecord, DayStatus, LogRecord, RunStore } from '../lib/store';
import { todayIn } from '../lib/time';
import { runAll, runDaily, type Deps } from '../lib/workflow';

// In-memory RunStore with the same guard semantics as the Postgres SQL.
function memoryStore(): RunStore & { days: Map<string, DayRecord>; entries: LogRecord[] } {
  const days = new Map<string, DayRecord>();
  const entries: LogRecord[] = [];
  const k = (id: number, date: string) => `${id}:${date}`;
  const blank = (account_id: number, date: string): DayRecord => ({
    account_id, date, status: 'MISSING', sheet_status: null, detail: null, email_subject: null,
    email_body: null, email_sent_at: null, email_message_id: null, updated_at: new Date().toISOString(),
  });
  const locked = (d?: DayRecord) => d?.status === 'SENT' || d?.status === 'SENDING';
  return {
    days, entries,
    async getDay(id, date) { return days.get(k(id, date)) ?? null; },
    async setStatus(id, date, status: DayStatus, sheetStatus, detail = null) {
      if (locked(days.get(k(id, date)))) return;
      days.set(k(id, date), { ...(days.get(k(id, date)) ?? blank(id, date)), status, sheet_status: sheetStatus, detail });
    },
    async claimForSending(id, date, subject, body) {
      if (locked(days.get(k(id, date)))) return false;
      days.set(k(id, date), { ...(days.get(k(id, date)) ?? blank(id, date)), status: 'SENDING', sheet_status: 'UPDATED', email_subject: subject, email_body: body });
      return true;
    },
    async markSent(id, date, messageId) {
      const d = days.get(k(id, date));
      if (d?.status === 'SENDING') days.set(k(id, date), { ...d, status: 'SENT', email_message_id: messageId, email_sent_at: new Date().toISOString() });
    },
    async markSendFailed(id, date, detail) {
      const d = days.get(k(id, date));
      if (d?.status === 'SENDING') days.set(k(id, date), { ...d, status: 'ERROR', detail });
    },
    async log(account_id, date, event, result, detail = null) { entries.push({ at: new Date().toISOString(), account_id, date, event, result, detail }); },
  };
}

const WEDNESDAY_1030_IST = new Date('2026-10-21T05:00:00Z');
const SUNDAY_1030_IST = new Date('2026-10-25T05:00:00Z');
const READY: SheetResult = {
  state: 'READY',
  entries: [{ tasks: 'Completed LMS Phase 2 planning, worked on CRM automation', status: 'Completed', notes: 'Development work' }],
};

const account = (id = 1, overrides: Partial<Account> = {}): Account => ({
  id, label: `Account ${id}`, enabled: true, provider: 'smtp', senderName: 'Janhvi', senderEmail: 'janhvi.k@brainmine.ai',
  smtpHost: 'smtp.hostinger.com', smtpUser: 'janhvi.k@brainmine.ai',
  hrEmail: 'hr@brainmine.ai', hrName: 'Priya', sheetId: 'x'.repeat(30), ...DEFAULTS, ...overrides,
});

function setup(overrides: Partial<Deps> = {}) {
  const store = memoryStore();
  const sent: { from: string; subject: string }[] = [];
  const deps: Deps = {
    timezone: 'Asia/Kolkata',
    store,
    now: () => WEDNESDAY_1030_IST,
    readSheet: async () => READY,
    generate: async () => ({ bullets: ['Completed LMS Phase 2 planning.', 'Worked on CRM automation.'], notes: 'Development work.' }),
    send: async (acc, mail) => {
      await new Promise((r) => setTimeout(r, 5));
      sent.push({ from: acc.senderEmail, subject: mail.subject });
      return { messageId: `msg-${sent.length}` };
    },
    ...overrides,
  };
  return { deps, store, sent };
}

test('1 — sheet updated: email generated, sent, status SENT', async () => {
  const { deps, store, sent } = setup();
  const result = await runDaily(deps, account(), 'cron');
  assert.equal(result.outcome, 'SENT');
  assert.deepEqual(sent, [{ from: 'janhvi.k@brainmine.ai', subject: 'Daily Work Update – 21 October 2026' }]);
  const day = store.days.get('1:2026-10-21')!;
  assert.equal(day.status, 'SENT');
  assert.equal(day.email_message_id, 'msg-1');
  assert.match(day.email_body!, /^Hi Priya,\n\nHere is my daily work update for 21 October 2026:\n\n• Completed LMS/);
  assert.match(day.email_body!, /Regards,\nJanhvi$/);
  assert.deepEqual(store.entries.map((e) => e.event), ['CRON_STARTED', 'SHEET_CHECK', 'AI_GENERATION', 'EMAIL_SEND', 'AUTOMATION_COMPLETED']);
});

test('2 — no row for today: no email, status MISSING', async () => {
  const { deps, store, sent } = setup({ readSheet: async () => ({ state: 'MISSING' }) });
  assert.equal((await runDaily(deps, account(), 'cron')).outcome, 'MISSING');
  assert.equal(sent.length, 0);
  assert.equal(store.days.get('1:2026-10-21')!.status, 'MISSING');
});

test('3 — empty task field: no email, status INCOMPLETE', async () => {
  const { deps, store, sent } = setup({ readSheet: async () => classify([{ tasks: '  ', status: 'Completed', notes: 'x' }]) });
  assert.equal((await runDaily(deps, account(), 'cron')).outcome, 'INCOMPLETE');
  assert.equal(sent.length, 0);
  assert.equal(store.days.get('1:2026-10-21')!.status, 'INCOMPLETE');
});

test('4 — cron runs twice (sequentially and concurrently): exactly one email', async () => {
  const { deps, sent } = setup();
  const a = account();
  const results = await Promise.all([runDaily(deps, a, 'cron'), runDaily(deps, a, 'cron'), runDaily(deps, a, 'send')]);
  assert.equal(results.filter((r) => r.outcome === 'SENT').length, 1);
  assert.equal((await runDaily(deps, a, 'cron')).outcome, 'ALREADY_SENT');
  assert.equal((await runDaily(deps, a, 'send')).outcome, 'ALREADY_SENT');
  assert.equal(sent.length, 1);
});

test('5 — AI fails: no email, status ERROR', async () => {
  const { deps, store, sent } = setup({ generate: async () => { throw new Error('Gemini 503'); } });
  assert.equal((await runDaily(deps, account(), 'cron')).outcome, 'ERROR');
  assert.equal(sent.length, 0);
  assert.match(store.days.get('1:2026-10-21')!.detail!, /^Unable to generate email/);
});

test('6 — email API fails: status is not SENT, and a later retry can send', async () => {
  let fail = true;
  const { deps, store, sent } = setup();
  const realSend = deps.send;
  deps.send = async (a, m) => { if (fail) throw new Error('Invalid login: 535 authentication failed'); return realSend(a, m); };
  assert.equal((await runDaily(deps, account(), 'cron')).outcome, 'ERROR');
  assert.equal(store.days.get('1:2026-10-21')!.status, 'ERROR');
  assert.match(store.days.get('1:2026-10-21')!.detail!, /^Email delivery failed/);
  fail = false;
  assert.equal((await runDaily(deps, account(), 'send')).outcome, 'SENT');
  assert.equal(sent.length, 1);
});

test('6b — sheet unavailable: no email, status ERROR', async () => {
  const { deps, store, sent } = setup({ readSheet: async () => { throw new Error('Sheets API 403'); } });
  assert.equal((await runDaily(deps, account(), 'cron')).outcome, 'ERROR');
  assert.equal(sent.length, 0);
  assert.match(store.days.get('1:2026-10-21')!.detail!, /^Unable to read sheet/);
});

test('7 — Sunday: automation does nothing (even if the cron fires)', async () => {
  let sheetRead = false;
  const { deps, store, sent } = setup({ now: () => SUNDAY_1030_IST, readSheet: async () => { sheetRead = true; return READY; } });
  assert.equal((await runDaily(deps, account(), 'cron')).outcome, 'SKIPPED_NON_WORKING_DAY');
  assert.equal((await runDaily(deps, account(), 'send')).outcome, 'SKIPPED_NON_WORKING_DAY');
  assert.equal(sheetRead, false);
  assert.equal(sent.length, 0);
  assert.equal(store.days.size, 0);
});

test('multiple accounts: each sends once from its own mailbox; failures are isolated; paused accounts skipped', async () => {
  const { deps, sent } = setup();
  const realSend = deps.send;
  deps.send = async (a, m) => { if (a.id === 2) throw new Error('SMTP down'); return realSend(a, m); };
  const accounts = [
    account(1),
    account(2, { senderEmail: 'second@brainmine.ai' }),
    account(3, { senderEmail: 'third@example.com' }),
    account(4, { senderEmail: 'paused@example.com', enabled: false }),
    account(5, { senderEmail: 'weekdays@example.com', workingDays: [1, 2, 4, 5] }), // no Wednesday
  ];
  const results = await runAll(deps, accounts, 'cron');
  assert.deepEqual(results.map((r) => r.outcome), ['SENT', 'ERROR', 'SENT', 'SKIPPED_DISABLED', 'SKIPPED_NON_WORKING_DAY']);
  assert.deepEqual(sent.map((s) => s.from).sort(), ['janhvi.k@brainmine.ai', 'third@example.com']);
  await runAll(deps, accounts, 'cron');
  assert.equal(sent.length, 2, 'second cron run sends nothing new');
});

test('preview never sends and does not block a later send', async () => {
  const { deps, sent } = setup();
  const preview = await runDaily(deps, account(), 'preview');
  assert.equal(preview.outcome, 'PREVIEW');
  assert.match(preview.email!.text, /• Worked on CRM automation\./);
  assert.equal(sent.length, 0);
  assert.equal((await runDaily(deps, account(), 'send')).outcome, 'SENT');
});

test('8 — manual send is admin-only', () => {
  process.env.ADMIN_PASSWORD = 'correct horse battery staple';
  process.env.CRON_SECRET = 'cron-secret-value-123';
  const url = 'https://app.example.com/api/run';
  const cookie = sessionCookie().split(';')[0];
  assert.equal(isAdmin(new Request(url, { method: 'POST' })), false);
  assert.equal(isAdmin(new Request(url, { method: 'POST', headers: { cookie: 'hr_session=123.forged' } })), false);
  assert.equal(isAdmin(new Request(url, { method: 'POST', headers: { authorization: 'Bearer wrong' } })), false);
  assert.equal(isAdmin(new Request(url, { method: 'POST', headers: { cookie } })), true);
  assert.equal(isAdmin(new Request(url, { method: 'POST', headers: { authorization: 'Bearer cron-secret-value-123' } })), true);
  process.env.ADMIN_PASSWORD = 'rotated password';
  assert.equal(isAdmin(new Request(url, { method: 'POST', headers: { cookie } })), false, 'password change revokes sessions');
});

test('mailbox passwords are encrypted at rest and tamper-proof', () => {
  process.env.ENCRYPTION_KEY = 'test-encryption-key-0123456789';
  const stored = encrypt('hostinger-mailbox-pass');
  assert.ok(!stored.includes('hostinger'));
  assert.notEqual(stored, encrypt('hostinger-mailbox-pass'), 'random IV');
  assert.equal(decrypt(stored), 'hostinger-mailbox-pass');
  const parts = stored.split('.');
  parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => decrypt(parts.join('.')));
  process.env.ENCRYPTION_KEY = 'a-different-key-9876543210';
  assert.throws(() => decrypt(stored), /ENCRYPTION_KEY/);
});

test('account form validation', () => {
  const form = {
    senderName: 'Janhvi', senderEmail: 'Janhvi.K@brainmine.ai', smtpHost: 'smtp.hostinger.com', smtpPort: 465,
    hrEmail: 'hr@brainmine.ai', sheetId: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0',
  };
  const a = validateAccount(form);
  assert.equal(a.senderEmail, 'janhvi.k@brainmine.ai');
  assert.equal(a.smtpUser, 'janhvi.k@brainmine.ai', 'username defaults to email');
  assert.equal(a.sheetId, '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
  assert.deepEqual(a.workingDays, [1, 2, 3, 4, 5, 6]);
  assert.equal(a.colTasks, 'Tasks / Activities');
  assert.throws(() => validateAccount({ ...form, hrEmail: 'not-an-email' }), ValidationError);
  assert.throws(() => validateAccount({ ...form, senderName: 'Eve\r\nBcc: victim@x.com' }), ValidationError);
  assert.throws(() => validateAccount({ ...form, smtpHost: 'http://evil' }), ValidationError);
  assert.throws(() => validateAccount({ ...form, smtpPort: 99999 }), ValidationError);
  assert.throws(() => parseSheetId('hello'), ValidationError);
});

test('Gemini response parsing', () => {
  const ok = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thinking…', thought: true }, { text: '{"bullets":["A."],"notes":null}' }] } }] };
  assert.deepEqual(parseGeminiResponse(ok), { bullets: ['A.'], notes: null });
  assert.throws(() => parseGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }), /blocked/);
  assert.throws(() => parseGeminiResponse({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"bul' }] } }] }), /stopped early/);
  assert.throws(() => validate({ bullets: [], notes: null }));
  assert.deepEqual(validate({ bullets: [' A ', ''], notes: ' ' }), { bullets: ['A'], notes: null });
});

test('IST date is used, not UTC', () => {
  assert.deepEqual(todayIn('Asia/Kolkata', new Date('2026-10-21T19:00:00Z')), { date: '2026-10-22', weekday: 4 });
  assert.deepEqual(todayIn('Asia/Kolkata', new Date('2026-10-24T18:31:00Z')), { date: '2026-10-25', weekday: 0 });
});

test('sheet dates in common formats', () => {
  for (const v of ['21-Oct-2026', '21 Oct 2026', '21 October 2026', 'Oct 21, 2026', '2026-10-21', '21/10/2026', '21.10.26', 46316]) {
    assert.equal(parseSheetDate(v), '2026-10-21', String(v));
  }
  assert.equal(parseSheetDate('10/21/2026', 'MDY'), '2026-10-21');
  assert.equal(parseSheetDate('31/02/2026'), null);
});

test('rows are found by Date header, wherever they are', () => {
  const values = [
    ['My work log'],
    ['Date', 'Tasks / Activities', 'Status', 'Additional Notes'],
    ['20-Oct-2026', 'Yesterday work', 'Completed', ''],
    [46316, 'Worked on LMS Phase 2', 'In progress', 'Reviewed API'],
  ];
  const cols = { date: 'date', tasks: 'TASKS / ACTIVITIES', status: 'Status', notes: 'Additional Notes', dateOrder: 'DMY' as const };
  assert.deepEqual(findEntries(values, cols, '2026-10-21'), [{ tasks: 'Worked on LMS Phase 2', status: 'In progress', notes: 'Reviewed API' }]);
  assert.equal(classify(findEntries(values, cols, '2026-10-23')).state, 'MISSING');
  assert.equal(classify([{ tasks: 'N/A', status: '', notes: '' }]).state, 'INCOMPLETE');
});

test('secrets are masked in logged errors', () => {
  process.env.GEMINI_API_KEY = 'AIzaSy-very-secret';
  assert.equal(safeMessage(new Error('bad key AIzaSy-very-secret')), 'bad key ***');
  assert.equal(safeMessage(new Error('auth failed for pass123456'), ['pass123456']), 'auth failed for ***');
});
