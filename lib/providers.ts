// Supported mail providers and auto-detection from an email address (MX lookup).
// "oauth" providers connect with a Sign-in button; "smtp" providers use a password.

import { promises as dns } from 'node:dns';

export type Kind = 'google' | 'microsoft' | 'smtp';

export interface Provider {
  id: string;
  name: string;
  kind: Kind;
  host?: string;
  port?: number;
  hint: string;
}

export const PROVIDERS: Provider[] = [
  { id: 'google', name: 'Gmail / Google Workspace', kind: 'google', hint: 'Sign in with Google. No password is stored; you can revoke access any time at myaccount.google.com/permissions.' },
  { id: 'microsoft', name: 'Outlook / Microsoft 365', kind: 'microsoft', hint: 'Sign in with Microsoft. Works for outlook.com/hotmail and work accounts (some organisations require admin approval).' },
  { id: 'hostinger', name: 'Hostinger', kind: 'smtp', host: 'smtp.hostinger.com', port: 465, hint: 'Use your full email address and the mailbox password (hPanel → Emails → Manage).' },
  { id: 'titan', name: 'Titan Mail', kind: 'smtp', host: 'smtp.titan.email', port: 465, hint: 'Use your full email address and mailbox password.' },
  { id: 'zoho-in', name: 'Zoho Mail (India)', kind: 'smtp', host: 'smtppro.zoho.in', port: 465, hint: 'Free @zoho.in accounts use smtp.zoho.in. With 2FA on, create an App Password in Zoho Accounts → Security.' },
  { id: 'zoho', name: 'Zoho Mail', kind: 'smtp', host: 'smtppro.zoho.com', port: 465, hint: 'Free @zoho.com accounts use smtp.zoho.com. With 2FA on, use an App Password.' },
  { id: 'godaddy', name: 'GoDaddy Email', kind: 'smtp', host: 'smtpout.secureserver.net', port: 465, hint: 'Use your full email address and mailbox password.' },
  { id: 'yahoo', name: 'Yahoo Mail', kind: 'smtp', host: 'smtp.mail.yahoo.com', port: 465, hint: 'Requires an App Password (Yahoo Account Security → Generate app password).' },
  { id: 'icloud', name: 'iCloud Mail', kind: 'smtp', host: 'smtp.mail.me.com', port: 587, hint: 'Requires an app-specific password (appleid.apple.com → Sign-In and Security).' },
  { id: 'gmail-smtp', name: 'Gmail (App Password)', kind: 'smtp', host: 'smtp.gmail.com', port: 465, hint: 'Fallback when Google sign-in is not set up: needs 2-Step Verification and an App Password.' },
  { id: 'custom', name: 'Other (SMTP)', kind: 'smtp', port: 465, hint: 'Ask your provider for the outgoing (SMTP) server. Port 465 = SSL/TLS, 587 = STARTTLS.' },
];

const CONSUMER_DOMAINS: Record<string, string> = {
  'gmail.com': 'google',
  'googlemail.com': 'google',
  'outlook.com': 'microsoft',
  'hotmail.com': 'microsoft',
  'live.com': 'microsoft',
  'msn.com': 'microsoft',
  'outlook.in': 'microsoft',
  'yahoo.com': 'yahoo',
  'yahoo.co.in': 'yahoo',
  'ymail.com': 'yahoo',
  'icloud.com': 'icloud',
  'me.com': 'icloud',
  'mac.com': 'icloud',
  'zoho.com': 'zoho',
  'zohomail.com': 'zoho',
  'zoho.in': 'zoho-in',
  'zohomail.in': 'zoho-in',
};

/** Maps MX host names to a provider id. Pure, for testing. */
export function providerFromMx(exchanges: string[]): string {
  const mx = exchanges.join(' ').toLowerCase();
  if (/google\.com|googlemail\.com/.test(mx)) return 'google';
  if (/outlook\.com|office365|microsoft/.test(mx)) return 'microsoft';
  if (/hostinger/.test(mx)) return 'hostinger';
  if (/titan\.email/.test(mx)) return 'titan';
  if (/zoho\.in/.test(mx)) return 'zoho-in';
  if (/zoho/.test(mx)) return 'zoho';
  if (/secureserver\.net/.test(mx)) return 'godaddy';
  if (/yahoodns|yahoo/.test(mx)) return 'yahoo';
  if (/icloud|me\.com/.test(mx)) return 'icloud';
  return 'custom';
}

export async function detectProvider(email: string): Promise<string> {
  const domain = email.split('@')[1]?.trim().toLowerCase();
  if (!domain) return 'custom';
  if (CONSUMER_DOMAINS[domain]) return CONSUMER_DOMAINS[domain];
  try {
    const records = await dns.resolveMx(domain);
    return providerFromMx(records.map((r) => r.exchange));
  } catch {
    return 'custom';
  }
}
