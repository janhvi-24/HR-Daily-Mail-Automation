// Connect / edit / remove / test mail accounts. Admin only.
//   { op: "detect", email }                                     → suggested provider id
//   { op: "save",   id?, account: {...}, password?, connection? }
//   { op: "delete", id }
//   { op: "test",   id?, account: {...}, password?, connection?, sendTest? }
// SMTP accounts send a password (blank on edit = keep). Google/Microsoft accounts
// send the sealed `connection` from the sign-in popup (absent on edit = keep).
import { validateAccount, ValidationError, type AccountFields } from '../lib/accounts';
import { json, toPublic } from '../lib/app';
import { isAdmin, sameOrigin } from '../lib/auth';
import { decrypt, encrypt } from '../lib/crypto';
import { safeMessage, timezone } from '../lib/env';
import { deliver, verifyAccount } from '../lib/mailer';
import { unsealConnection } from '../lib/oauth';
import { detectProvider } from '../lib/providers';
import { readSheetForDate } from '../lib/sheet';
import { postgresStore, type Store } from '../lib/store';
import { todayIn } from '../lib/time';

interface Body {
  op?: unknown;
  id?: unknown;
  email?: unknown;
  account?: Record<string, unknown>;
  password?: unknown;
  connection?: unknown;
  sendTest?: unknown;
}

/** Validates the form and works out the credential to use (new or stored). */
async function resolve(body: Body, id: number | undefined, store: Store) {
  const input = body.account ?? {};
  const stored = id === undefined ? null : await store.getAccount(id);
  if (id !== undefined && !stored) throw new ValidationError('Account not found');
  const oauth = input.provider === 'google' || input.provider === 'microsoft';

  if (oauth) {
    if (body.connection) {
      const c = unsealConnection(body.connection);
      if (c.provider !== input.provider) throw new ValidationError('Sign-in does not match the selected provider');
      const fields = validateAccount({ ...input, senderEmail: c.email, senderName: input.senderName || c.name });
      return { fields, secret: c.refreshToken, isNew: true };
    }
    if (stored && stored.provider === input.provider) {
      // The mailbox address always comes from the sign-in, never from the form.
      const fields = validateAccount({ ...input, senderEmail: stored.senderEmail });
      return { fields, secret: decrypt(stored.secretEnc), isNew: false };
    }
    throw new ValidationError(`Click "Sign in with ${input.provider === 'google' ? 'Google' : 'Microsoft'}" first`);
  }

  const fields = validateAccount(input);
  const password = typeof body.password === 'string' && body.password.length > 0 ? body.password : null;
  if (password && password.length > 500) throw new ValidationError('Password is too long');
  if (password) return { fields, secret: password, isNew: true };
  if (stored && stored.provider === 'smtp') return { fields, secret: decrypt(stored.secretEnc), isNew: false };
  throw new ValidationError('Mailbox password is required');
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: 'Forbidden' }, 403);
  if (!isAdmin(req)) return json({ error: 'Unauthorized' }, 401);
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return json({ error: 'Invalid JSON' }, 400);
  const id = Number.isInteger(body.id) ? (body.id as number) : undefined;

  try {
    if (body.op === 'detect') {
      const email = typeof body.email === 'string' ? body.email.trim().slice(0, 200) : '';
      return json({ provider: await detectProvider(email) });
    }

    const store = postgresStore();

    if (body.op === 'delete') {
      if (id === undefined) return json({ error: 'id is required' }, 400);
      await store.deleteAccount(id);
      return json({ ok: true });
    }

    const { fields, secret, isNew } = await resolve(body, id, store);

    if (body.op === 'save') {
      const savedId = await store.saveAccount(fields, isNew ? encrypt(secret) : null, id);
      return json({ ok: true, account: toPublic((await store.getAccount(savedId))!) });
    }

    if (body.op === 'test') return json(await test(fields, secret, body.sendTest === true));

    return json({ error: 'op must be detect, save, delete or test' }, 400);
  } catch (error) {
    if (error instanceof ValidationError) return json({ error: error.message }, 400);
    console.error('accounts failed', safeMessage(error));
    return json({ error: safeMessage(error) }, 500);
  }
}

async function test(fields: AccountFields, secret: string, sendTest: boolean) {
  const result: Record<string, { ok: boolean; message: string }> = {};
  try {
    result.mail = { ok: true, message: await verifyAccount(fields, secret) };
    if (sendTest) {
      const note = `This mailbox is connected. Daily updates will be sent to ${fields.hrEmail}.`;
      // Test emails only ever go to the account's own address.
      await deliver(fields, secret, { to: fields.senderEmail, subject: 'Test – Daily HR Update automation', text: note, html: `<p>${note}</p>` });
      result.mail.message += `; test email sent to ${fields.senderEmail}`;
    }
  } catch (error) {
    result.mail = { ok: false, message: safeMessage(error, [secret]) };
  }
  try {
    const sheet = await readSheetForDate(fields, todayIn(timezone()).date);
    const today = { MISSING: 'no row for today yet', INCOMPLETE: "today's row has no tasks", READY: "today's row is ready" };
    result.sheet = { ok: true, message: `Sheet readable; ${today[sheet.state]}` };
  } catch (error) {
    result.sheet = { ok: false, message: safeMessage(error) };
  }
  return result;
}
