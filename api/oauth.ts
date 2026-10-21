// "Sign in with Google / Microsoft" (opened in a popup by the dashboard).
//   GET /api/oauth?provider=google[&hint=me@x.com]  → redirects to the provider
//   GET /api/oauth?code=…&state=…                    → provider redirects back here
// The result is posted to the dashboard window as a sealed blob (see lib/oauth.ts).
import { json } from '../lib/app';
import { isAdmin, readCookie } from '../lib/auth';
import { safeMessage } from '../lib/env';
import {
  authorizeUrl,
  createState,
  exchangeCode,
  isOAuthProvider,
  oauthConfigured,
  redirectUri,
  sealConnection,
  verifyState,
} from '../lib/oauth';

const NONCE_COOKIE = 'oauth_nonce';

export async function GET(req: Request) {
  if (!isAdmin(req)) return resultPage({ ok: false, error: 'Your dashboard session expired. Sign in again and retry.' });
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const providerError = url.searchParams.get('error');

  // Step 1: start
  if (!code && !providerError) {
    const provider = url.searchParams.get('provider');
    if (!isOAuthProvider(provider)) return json({ error: 'provider must be google or microsoft' }, 400);
    if (!oauthConfigured(provider)) return resultPage({ ok: false, error: `${provider === 'google' ? 'Google' : 'Microsoft'} sign-in is not set up on the server yet (see README).` });
    const hint = url.searchParams.get('hint') ?? undefined;
    const { state: newState, nonce } = createState(provider);
    return new Response(null, {
      status: 302,
      headers: {
        Location: authorizeUrl(provider, redirectUri(req), newState, hint?.includes('@') ? hint : undefined),
        'Set-Cookie': `${NONCE_COOKIE}=${nonce}; Path=/api/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        'Cache-Control': 'no-store',
      },
    });
  }

  // Step 2: callback
  try {
    const provider = verifyState(state ?? '', readCookie(req, NONCE_COOKIE));
    if (providerError) {
      const denied = providerError === 'access_denied' || providerError === 'consent_required';
      return resultPage({ ok: false, error: denied ? 'Sign-in was cancelled or permission was not granted.' : `Sign-in failed: ${providerError}` });
    }
    const connection = await exchangeCode(provider, code!, redirectUri(req));
    return resultPage({ ok: true, provider, email: connection.email, name: connection.name, connection: sealConnection(connection) });
  } catch (error) {
    return resultPage({ ok: false, error: safeMessage(error) });
  }
}

/** Tiny page that hands the result to the dashboard window and closes itself. */
function resultPage(result: Record<string, unknown>): Response {
  const data = JSON.stringify({ type: 'oauth-result', ...result }).replace(/</g, '\\u003c');
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connecting…</title>
<body style="font:15px system-ui;padding:24px;background:Canvas;color:CanvasText">
<p id="m">Finishing…</p>
<script>
const r = ${data};
if (window.opener) { window.opener.postMessage(r, location.origin); window.close(); }
document.getElementById('m').textContent = r.ok
  ? 'Connected ' + r.email + '. You can close this window and return to the dashboard.'
  : r.error;
</script>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': `${NONCE_COOKIE}=; Path=/api/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    },
  });
}
