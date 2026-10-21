// Single-admin auth. The dashboard logs in with ADMIN_PASSWORD and gets an
// HttpOnly, SameSite=Lax signed cookie (Lax so it survives the redirect back from
// Google/Microsoft sign-in; state-changing calls are POST + same-origin checked).
// The cron (and curl) use CRON_SECRET.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env';

const COOKIE = 'hr_session';
const SESSION_DAYS = 30;

const digest = (s: string) => createHash('sha256').update(s).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
// Changing ADMIN_PASSWORD invalidates every existing session.
const sign = (payload: string) => createHmac('sha256', `session:${env('ADMIN_PASSWORD')}`).update(payload).digest('base64url');

export function checkPassword(input: unknown): boolean {
  return typeof input === 'string' && input.length > 0 && safeEqual(input, env('ADMIN_PASSWORD'));
}

export function sessionCookie(): string {
  const expires = String(Date.now() + SESSION_DAYS * 86_400_000);
  return `${COOKIE}=${expires}.${sign(expires)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}`;
}

export const clearedCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function hasValidSession(req: Request): boolean {
  const value = readCookie(req, COOKIE);
  if (!value) return false;
  const [expires, signature] = value.split('.');
  return Boolean(expires && signature) && Number(expires) > Date.now() && safeEqual(signature, sign(expires));
}

export function hasCronSecret(req: Request): boolean {
  const header = req.headers.get('authorization') ?? '';
  return safeEqual(header, `Bearer ${env('CRON_SECRET')}`);
}

/** Admin = valid dashboard session, or the CRON_SECRET bearer token (for curl/testing). */
export function isAdmin(req: Request): boolean {
  return hasValidSession(req) || hasCronSecret(req);
}

export function readCookie(req: Request, name: string): string | null {
  return (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1] ?? null;
}

/** Blocks cross-site POSTs (defence in depth on top of SameSite). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  return !origin || new URL(origin).host === new URL(req.url).host;
}
