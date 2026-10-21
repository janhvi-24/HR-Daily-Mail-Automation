// A connected account = one mailbox + where its work log lives + who receives it.
// Each account is automated independently.

import type { Kind } from './providers';

export interface Account {
  id: number;
  label: string;
  enabled: boolean;
  /** google / microsoft = OAuth sign-in; smtp = server + password */
  provider: Kind;
  senderName: string;
  senderEmail: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  hrEmail: string;
  hrName: string;
  sheetId: string;
  sheetName: string;
  colDate: string;
  colTasks: string;
  colStatus: string;
  colNotes: string;
  dateOrder: 'DMY' | 'MDY';
  workingDays: number[];
}

export type AccountFields = Omit<Account, 'id'>;

/** What the browser sees: everything except the stored password / token. */
export interface PublicAccount extends Account {
  connected: boolean;
}

export const DEFAULTS = {
  smtpPort: 465,
  sheetName: 'Sheet1',
  colDate: 'Date',
  colTasks: 'Tasks / Activities',
  colStatus: 'Status',
  colNotes: 'Additional Notes',
  dateOrder: 'DMY' as const,
  workingDays: [1, 2, 3, 4, 5, 6],
};

export class ValidationError extends Error {}

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function text(value: unknown, field: string, { required = true, max = 200, fallback = '' } = {}): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s && required && !fallback) throw new ValidationError(`${field} is required`);
  if (s.length > max) throw new ValidationError(`${field} is too long`);
  // Header-injection guard: names/addresses end up in email headers.
  if (/[\r\n]/.test(s)) throw new ValidationError(`${field} cannot contain line breaks`);
  return s || fallback;
}

function email(value: unknown, field: string): string {
  const s = text(value, field);
  if (!EMAIL.test(s)) throw new ValidationError(`${field} is not a valid email address`);
  return s.toLowerCase();
}

/** Accepts a full Google Sheets URL or a bare spreadsheet id. */
export function parseSheetId(value: unknown): string {
  const s = text(value, 'Google Sheet link');
  const id = s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1] ?? s;
  if (!/^[A-Za-z0-9_-]{20,}$/.test(id)) throw new ValidationError('Google Sheet link is not valid');
  return id;
}

/**
 * Validates dashboard form input. Credentials are handled separately (password
 * blank = keep; OAuth accounts take their address from the sign-in, not the form).
 */
export function validateAccount(input: Record<string, unknown>): AccountFields {
  const provider: Kind = input.provider === 'google' || input.provider === 'microsoft' ? input.provider : 'smtp';
  const senderEmail = email(input.senderEmail, 'Your email');
  let smtpHost = '';
  let smtpPort = 0;
  let smtpUser = senderEmail;
  if (provider === 'smtp') {
    smtpHost = text(input.smtpHost, 'SMTP server').toLowerCase();
    if (!HOST.test(smtpHost)) throw new ValidationError('SMTP server is not a valid host name');
    smtpPort = Number(input.smtpPort ?? DEFAULTS.smtpPort);
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) throw new ValidationError('SMTP port is not valid');
    smtpUser = text(input.smtpUser, 'SMTP username', { fallback: senderEmail });
  }
  const workingDays = Array.isArray(input.workingDays)
    ? [...new Set(input.workingDays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    : DEFAULTS.workingDays;

  return {
    label: text(input.label, 'Name', { fallback: senderEmail, max: 80 }),
    enabled: input.enabled !== false,
    provider,
    senderName: text(input.senderName, 'Your name', { max: 100 }),
    senderEmail,
    smtpHost,
    smtpPort,
    smtpUser,
    hrEmail: email(input.hrEmail, 'HR email'),
    hrName: text(input.hrName, 'HR name', { required: false, max: 100 }),
    sheetId: parseSheetId(input.sheetId),
    sheetName: text(input.sheetName, 'Sheet tab', { fallback: DEFAULTS.sheetName, max: 100 }),
    colDate: text(input.colDate, 'Date column', { fallback: DEFAULTS.colDate, max: 100 }),
    colTasks: text(input.colTasks, 'Tasks column', { fallback: DEFAULTS.colTasks, max: 100 }),
    colStatus: text(input.colStatus, 'Status column', { fallback: DEFAULTS.colStatus, max: 100 }),
    colNotes: text(input.colNotes, 'Notes column', { fallback: DEFAULTS.colNotes, max: 100 }),
    dateOrder: input.dateOrder === 'MDY' ? 'MDY' : 'DMY',
    workingDays,
  };
}
