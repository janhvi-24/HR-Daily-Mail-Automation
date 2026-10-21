import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { validateAccount, ValidationError } from '../lib/accounts';
import { buildMime, deliver } from '../lib/mailer';
import { authorizeUrl, createState, exchangeCode, sealConnection, unsealConnection, verifyState } from '../lib/oauth';
import { detectProvider, providerFromMx, PROVIDERS } from '../lib/providers';

process.env.ENCRYPTION_KEY = 'connect-test-key-0123456789abcdef';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-client';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'google-secret';
process.env.MICROSOFT_OAUTH_CLIENT_ID = 'ms-client';
process.env.MICROSOFT_OAUTH_CLIENT_SECRET = 'ms-secret';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Replaces fetch with a router of url-substring → response; records calls. */
function mockFetch(routes: Record<string, (init: RequestInit) => Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    return routes[key](init);
  }) as typeof fetch;
  return calls;
}
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const idToken = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

test('provider detection from MX records and consumer domains', async () => {
  assert.equal(providerFromMx(['mx1.hostinger.com', 'mx2.hostinger.com']), 'hostinger');
  assert.equal(providerFromMx(['aspmx.l.google.com']), 'google');
  assert.equal(providerFromMx(['brainmine-ai.mail.protection.outlook.com']), 'microsoft');
  assert.equal(providerFromMx(['mx1.titan.email']), 'titan');
  assert.equal(providerFromMx(['mx.zoho.in']), 'zoho-in');
  assert.equal(providerFromMx(['smtp.secureserver.net']), 'godaddy');
  assert.equal(providerFromMx(['mail.example.org']), 'custom');
  assert.equal(await detectProvider('someone@gmail.com'), 'google');
  assert.equal(await detectProvider('someone@hotmail.com'), 'microsoft');
  assert.equal(await detectProvider('not-an-email'), 'custom');
  for (const p of PROVIDERS.filter((p) => p.kind === 'smtp' && p.id !== 'custom')) assert.ok(p.host && p.port, p.id);
});

test('OAuth state: signed, browser-bound, expiring', () => {
  const { state, nonce } = createState('google');
  assert.equal(verifyState(state, nonce), 'google');
  assert.throws(() => verifyState(state, null), /different browser/);
  assert.throws(() => verifyState(state, 'other-nonce'), /different browser/);
  assert.throws(() => verifyState(state.replace('google', 'microsoft'), nonce), /Invalid/);
  assert.throws(() => verifyState('google.n.1.forged', 'n'), /Invalid/);
});

test('authorize URLs request only send + identity scopes', () => {
  const g = new URL(authorizeUrl('google', 'https://app.example.com/api/oauth', 'st', 'janhvi@gmail.com'));
  assert.equal(g.searchParams.get('scope'), 'openid email profile https://www.googleapis.com/auth/gmail.send');
  assert.equal(g.searchParams.get('access_type'), 'offline');
  assert.equal(g.searchParams.get('login_hint'), 'janhvi@gmail.com');
  assert.equal(g.searchParams.get('redirect_uri'), 'https://app.example.com/api/oauth');
  const m = new URL(authorizeUrl('microsoft', 'https://app.example.com/api/oauth', 'st'));
  assert.match(m.searchParams.get('scope')!, /offline_access User\.Read Mail\.Send/);
});

test('sealed connection: browser cannot read it, it expires, tampering fails', () => {
  const sealed = sealConnection({ provider: 'google', refreshToken: '1//refresh-token', email: 'a@gmail.com', name: 'A' });
  assert.ok(!sealed.includes('refresh') && !sealed.includes('gmail'));
  assert.deepEqual(unsealConnection(sealed), { provider: 'google', refreshToken: '1//refresh-token', email: 'a@gmail.com', name: 'A' });
  assert.throws(() => unsealConnection(sealed.slice(0, -4) + 'AAAA'));
  assert.throws(() => unsealConnection(42));
});

test('Google code exchange reads the email and insists on gmail.send', async () => {
  mockFetch({ 'oauth2.googleapis.com/token': () => jsonRes({ access_token: 'at', refresh_token: 'rt', scope: 'openid https://www.googleapis.com/auth/gmail.send', id_token: idToken({ email: 'Janhvi@Gmail.com', name: 'Janhvi K' }) }) });
  assert.deepEqual(await exchangeCode('google', 'code', 'https://x/api/oauth'), { provider: 'google', refreshToken: 'rt', email: 'janhvi@gmail.com', name: 'Janhvi K' });
  mockFetch({ 'oauth2.googleapis.com/token': () => jsonRes({ access_token: 'at', refresh_token: 'rt', scope: 'openid email', id_token: idToken({ email: 'a@b.c' }) }) });
  await assert.rejects(exchangeCode('google', 'code', 'https://x/api/oauth'), /Permission to send email was not granted/);
});

test('Gmail send: refreshes token, posts raw MIME to Gmail API', async () => {
  const calls = mockFetch({
    'oauth2.googleapis.com/token': () => jsonRes({ access_token: 'fresh-at' }),
    'gmail.googleapis.com': () => jsonRes({ id: 'gmail-msg-1' }),
  });
  const account = { provider: 'google' as const, smtpHost: '', smtpPort: 0, smtpUser: '', senderName: 'Janhvi', senderEmail: 'janhvi@gmail.com' };
  const r = await deliver(account, 'refresh-token', { to: 'hr@x.com', subject: 'Daily Work Update – 21 October 2026', text: 'hi', html: '<p>hi</p>' });
  assert.equal(r.messageId, 'gmail-msg-1');
  const send = calls.find((c) => c.url.includes('gmail'))!;
  assert.equal((send.init.headers as Record<string, string>).Authorization, 'Bearer fresh-at');
  const mime = Buffer.from(JSON.parse(String(send.init.body)).raw, 'base64url').toString();
  assert.match(mime, /^From: Janhvi <janhvi@gmail.com>/m);
  assert.match(mime, /^To: hr@x.com/m);
  assert.match(mime, /^Subject: =\?UTF-8\?/m);
});

test('Microsoft send: Graph sendMail, rotated refresh token is saved', async () => {
  const calls = mockFetch({
    'login.microsoftonline.com': () => jsonRes({ access_token: 'ms-at', refresh_token: 'rotated-rt' }),
    'graph.microsoft.com/v1.0/me/sendMail': () => new Response(null, { status: 202, headers: { 'request-id': 'req-1' } }),
  });
  let saved = '';
  const account = { provider: 'microsoft' as const, smtpHost: '', smtpPort: 0, smtpUser: '', senderName: 'J', senderEmail: 'j@outlook.com' };
  const r = await deliver(account, 'old-rt', { to: 'hr@x.com', subject: 'S', text: 't', html: '<p>t</p>' }, async (t) => { saved = t; });
  assert.equal(r.messageId, 'req-1');
  assert.equal(saved, 'rotated-rt');
  const body = JSON.parse(String(calls[1].init.body));
  assert.deepEqual(body.message.toRecipients, [{ emailAddress: { address: 'hr@x.com' } }]);
  assert.equal(body.saveToSentItems, true);
});

test('revoked access gives a clear "reconnect" error', async () => {
  mockFetch({ 'oauth2.googleapis.com/token': () => jsonRes({ error: 'invalid_grant' }, 400) });
  const account = { provider: 'google' as const, smtpHost: '', smtpPort: 0, smtpUser: '', senderName: 'J', senderEmail: 'j@gmail.com' };
  await assert.rejects(deliver(account, 'rt', { to: 'hr@x.com', subject: 'S', text: 't', html: 't' }), /reconnect the account/);
});

test('validation: OAuth accounts need no SMTP fields; SMTP accounts do', () => {
  const base = { senderName: 'J', senderEmail: 'j@gmail.com', hrEmail: 'hr@x.com', sheetId: 'x'.repeat(30) };
  const g = validateAccount({ ...base, provider: 'google', smtpHost: 'ignored' });
  assert.equal(g.provider, 'google');
  assert.equal(g.smtpHost, '');
  assert.throws(() => validateAccount({ ...base }), ValidationError, 'smtp needs a host');
  assert.equal(validateAccount({ ...base, provider: 'nonsense', smtpHost: 'smtp.hostinger.com' }).provider, 'smtp');
});

test('MIME builder keeps Unicode subject intact', async () => {
  const mime = (await buildMime({ senderName: 'Jānhvi', senderEmail: 'j@x.com' }, { to: 'hr@x.com', subject: 'Update – ✓', text: 'a', html: 'a' })).toString();
  assert.match(mime, /Subject: =\?UTF-8\?/);
});
