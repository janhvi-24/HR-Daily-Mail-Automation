// Sends mail from a connected account:
//   google    → Gmail API with an OAuth token (gmail.send scope only)
//   microsoft → Microsoft Graph sendMail with an OAuth token (Mail.Send only)
//   smtp      → the account's SMTP server with its password (Hostinger, Zoho, …)

import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { Account } from './accounts';
import type { ComposedEmail } from './compose';
import { refreshAccess } from './oauth';

type MailAccount = Pick<Account, 'provider' | 'smtpHost' | 'smtpPort' | 'smtpUser' | 'senderName' | 'senderEmail'>;
type Mail = ComposedEmail & { to: string };

/** secret = SMTP password or OAuth refresh token. onRotated persists a new refresh token. */
export async function deliver(
  account: MailAccount,
  secret: string,
  mail: Mail,
  onRotated?: (refreshToken: string) => Promise<void>,
): Promise<{ messageId: string }> {
  if (account.provider === 'smtp') return sendSmtp(account, secret, mail);
  const { accessToken, rotatedRefreshToken } = await refreshAccess(account.provider, secret);
  if (rotatedRefreshToken && onRotated) await onRotated(rotatedRefreshToken);
  return account.provider === 'google' ? sendGmail(account, accessToken, mail) : sendGraph(accessToken, mail);
}

/** Proves the credentials work without sending anything. */
export async function verifyAccount(account: MailAccount, secret: string): Promise<string> {
  if (account.provider === 'smtp') {
    await smtpTransport(account, secret).verify();
    return `Logged in to ${account.smtpHost}:${account.smtpPort}`;
  }
  await refreshAccess(account.provider, secret);
  return `${account.provider === 'google' ? 'Google' : 'Microsoft'} access for ${account.senderEmail} is valid`;
}

// ---------- SMTP ----------

function smtpTransport(account: MailAccount, password: string) {
  return nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpPort === 465, // 465 = SSL/TLS; 587 = STARTTLS
    requireTLS: account.smtpPort !== 465,
    auth: { user: account.smtpUser, pass: password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
}

async function sendSmtp(account: MailAccount, password: string, mail: Mail) {
  const info = await smtpTransport(account, password).sendMail({
    from: { name: account.senderName, address: account.senderEmail },
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
  if (info.rejected.length) throw new Error(`Recipient rejected: ${info.rejected.join(', ')}`);
  return { messageId: info.messageId };
}

// ---------- Gmail API ----------

export async function buildMime(account: Pick<Account, 'senderName' | 'senderEmail'>, mail: Mail): Promise<Buffer> {
  return new MailComposer({
    from: { name: account.senderName, address: account.senderEmail },
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  })
    .compile()
    .build();
}

async function sendGmail(account: MailAccount, accessToken: string, mail: Mail) {
  const raw = (await buildMime(account, mail)).toString('base64url');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`Gmail ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { messageId: ((await res.json()) as { id: string }).id };
}

// ---------- Microsoft Graph ----------

async function sendGraph(accessToken: string, mail: Mail) {
  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: mail.subject,
        body: { contentType: 'HTML', content: mail.html },
        toRecipients: [{ emailAddress: { address: mail.to } }],
      },
      saveToSentItems: true,
    }),
  });
  if (res.status !== 202) throw new Error(`Microsoft Graph ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { messageId: res.headers.get('request-id') ?? `graph-${Date.now()}` };
}
