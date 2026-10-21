import { checkPassword, clearedCookie, sameOrigin, sessionCookie } from '../lib/auth';
import { json } from '../lib/app';

// POST { "password": "..." } -> sets the session cookie. DELETE -> logs out.
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: 'Forbidden' }, 403);
  const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
  if (!checkPassword(body?.password)) {
    await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
    return json({ error: 'Wrong password' }, 401);
  }
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie() });
}

export async function DELETE() {
  return json({ ok: true }, 200, { 'Set-Cookie': clearedCookie });
}
