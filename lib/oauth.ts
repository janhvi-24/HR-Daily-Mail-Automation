// "Sign in with Google / Microsoft" for sending mail without storing a password.
// We request only send permission (+ basic identity), keep the refresh token
// AES-encrypted, and exchange it for a short-lived access token at send time.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { decrypt, encrypt } from './crypto';
import { env } from './env';

export type OAuthProvider = 'google' | 'microsoft';

const CONFIG = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile https://www.googleapis.com/auth/gmail.send',
    extra: { access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true' },
    idVar: 'GOOGLE_OAUTH_CLIENT_ID',
    secretVar: 'GOOGLE_OAUTH_CLIENT_SECRET',
  },
  microsoft: {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'openid email profile offline_access User.Read Mail.Send',
    extra: { prompt: 'select_account' },
    idVar: 'MICROSOFT_OAUTH_CLIENT_ID',
    secretVar: 'MICROSOFT_OAUTH_CLIENT_SECRET',
  },
} as const;

export const isOAuthProvider = (p: unknown): p is OAuthProvider => p === 'google' || p === 'microsoft';

export function oauthConfigured(p: OAuthProvider): boolean {
  return Boolean(process.env[CONFIG[p].idVar]?.trim() && process.env[CONFIG[p].secretVar]?.trim());
}

export function redirectUri(req: Request): string {
  return `${env('APP_URL', new URL(req.url).origin).replace(/\/$/, '')}/api/oauth`;
}

// ---------- state (CSRF protection for the redirect) ----------

const stateKey = () => `oauth-state:${env('ENCRYPTION_KEY')}`;
const mac = (s: string) => createHmac('sha256', stateKey()).update(s).digest('base64url');

export function createState(provider: OAuthProvider): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString('base64url');
  const payload = `${provider}.${nonce}.${Date.now() + 10 * 60_000}`;
  return { state: `${payload}.${mac(payload)}`, nonce };
}

export function verifyState(state: string, cookieNonce: string | null): OAuthProvider {
  const [provider, nonce, expires, signature] = state.split('.');
  const payload = `${provider}.${nonce}.${expires}`;
  const expected = Buffer.from(mac(payload));
  const given = Buffer.from(signature ?? '');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('Invalid sign-in state');
  if (Number(expires) < Date.now()) throw new Error('Sign-in took too long; please try again');
  if (!cookieNonce || cookieNonce !== nonce) throw new Error('Sign-in was started in a different browser session');
  if (!isOAuthProvider(provider)) throw new Error('Unknown provider');
  return provider;
}

export function authorizeUrl(p: OAuthProvider, redirect: string, state: string, loginHint?: string): string {
  const c = CONFIG[p];
  const params = new URLSearchParams({
    client_id: env(c.idVar),
    redirect_uri: redirect,
    response_type: 'code',
    scope: c.scope,
    state,
    ...c.extra,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return `${c.authUrl}?${params}`;
}

// ---------- tokens ----------

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

async function tokenRequest(p: OAuthProvider, params: Record<string, string>): Promise<TokenResponse> {
  const c = CONFIG[p];
  const res = await fetch(c.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env(c.idVar), client_secret: env(c.secretVar), ...params }),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) {
    const reason = body.error === 'invalid_grant' ? 'access was revoked or expired; reconnect the account' : body.error_description ?? body.error;
    throw new Error(`${p === 'google' ? 'Google' : 'Microsoft'} sign-in failed: ${String(reason ?? res.status).slice(0, 200)}`);
  }
  return body;
}

export async function exchangeCode(p: OAuthProvider, code: string, redirect: string) {
  const tokens = await tokenRequest(p, { grant_type: 'authorization_code', code, redirect_uri: redirect });
  if (!tokens.refresh_token) throw new Error('No refresh token returned; remove the app from your account permissions and try again');
  if (p === 'google' && !tokens.scope?.includes('gmail.send')) {
    throw new Error('Permission to send email was not granted. Try again and tick "Send email on your behalf".');
  }
  let email = '';
  let name = '';
  if (p === 'google') {
    const claims = JSON.parse(Buffer.from(tokens.id_token!.split('.')[1], 'base64url').toString()) as { email?: string; name?: string };
    email = claims.email ?? '';
    name = claims.name ?? '';
  } else {
    const res = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!res.ok) throw new Error(`Microsoft profile lookup failed (${res.status})`);
    const me = (await res.json()) as { mail?: string; userPrincipalName?: string; displayName?: string };
    email = me.mail || me.userPrincipalName || '';
    name = me.displayName ?? '';
  }
  if (!email) throw new Error('Could not read the account email address');
  return { provider: p, refreshToken: tokens.refresh_token, email: email.toLowerCase(), name };
}

/** Returns a fresh access token, and a new refresh token when the provider rotates it. */
export async function refreshAccess(p: OAuthProvider, refreshToken: string) {
  const tokens = await tokenRequest(p, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    ...(p === 'microsoft' ? { scope: CONFIG.microsoft.scope } : {}),
  });
  return { accessToken: tokens.access_token, rotatedRefreshToken: tokens.refresh_token !== refreshToken ? tokens.refresh_token : undefined };
}

// ---------- handing the result back to the dashboard ----------
// The popup returns a sealed (AES-GCM encrypted, 30-minute) blob. The browser
// cannot read the refresh token inside; the server unseals it on Save.

export interface Connection {
  provider: OAuthProvider;
  refreshToken: string;
  email: string;
  name: string;
}

export function sealConnection(c: Connection): string {
  return encrypt(JSON.stringify({ ...c, exp: Date.now() + 30 * 60_000 }));
}

export function unsealConnection(sealed: unknown): Connection {
  if (typeof sealed !== 'string' || sealed.length > 8000) throw new Error('Invalid connection');
  const c = JSON.parse(decrypt(sealed)) as Connection & { exp: number };
  if (c.exp < Date.now()) throw new Error('The sign-in expired; please sign in again');
  return { provider: c.provider, refreshToken: c.refreshToken, email: c.email, name: c.name };
}
