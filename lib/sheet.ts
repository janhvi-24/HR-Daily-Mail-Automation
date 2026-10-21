// Reads the work-log Google Sheet with a service account and finds today's row(s)
// by the Date column. No googleapis dependency: a signed JWT + two fetch calls.

import { createSign } from 'node:crypto';
import type { Account } from './accounts';
import { serviceAccount } from './env';

export interface Entry {
  tasks: string;
  status: string;
  notes: string;
}

export type SheetResult =
  | { state: 'MISSING' }
  | { state: 'INCOMPLETE'; entries: Entry[] }
  | { state: 'READY'; entries: Entry[] };

export interface SheetColumns {
  date: string;
  tasks: string;
  status: string;
  notes: string;
  dateOrder: 'DMY' | 'MDY';
}

type SheetAccount = Pick<
  Account,
  'sheetId' | 'sheetName' | 'colDate' | 'colTasks' | 'colStatus' | 'colNotes' | 'dateOrder'
>;

export async function readSheetForDate(account: SheetAccount, isoDate: string): Promise<SheetResult> {
  const columns: SheetColumns = {
    date: account.colDate,
    tasks: account.colTasks,
    status: account.colStatus,
    notes: account.colNotes,
    dateOrder: account.dateOrder,
  };
  const values = await fetchSheetValues(account.sheetId, account.sheetName);
  return classify(findEntries(values, columns, isoDate));
}

// ---------- Google API access ----------

async function fetchSheetValues(sheetId: string, sheetName: string): Promise<unknown[][]> {
  const token = await serviceAccountToken();
  const range = encodeURIComponent(`'${sheetName.replace(/'/g, "''")}'`);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${range}` +
    '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 403 || res.status === 404) {
    throw new Error(`Sheets API ${res.status}: share the sheet with ${serviceAccount().client_email} (Viewer) and check the link/tab name`);
  }
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { values?: unknown[][] };
  return body.values ?? [];
}

async function serviceAccountToken(): Promise<string> {
  const account = serviceAccount();

  const now = Math.floor(Date.now() / 1000);
  const encode = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`Google auth ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

// ---------- Pure parsing (unit-tested) ----------

const norm = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const cell = (value: unknown) => String(value ?? '').trim();

/** Finds every row whose Date column equals isoDate. The header row is located by name. */
export function findEntries(values: unknown[][], columns: SheetColumns, isoDate: string): Entry[] {
  const headerIndex = values.slice(0, 10).findIndex((row) => row.some((c) => norm(c) === norm(columns.date)));
  if (headerIndex === -1) throw new Error(`Header "${columns.date}" not found in the first 10 rows`);
  const header = values[headerIndex].map(norm);
  const col = (name: string) => header.indexOf(norm(name));
  const dateCol = col(columns.date);
  const tasksCol = col(columns.tasks);
  if (tasksCol === -1) throw new Error(`Header "${columns.tasks}" not found`);
  const statusCol = col(columns.status);
  const notesCol = col(columns.notes);

  return values
    .slice(headerIndex + 1)
    .filter((row) => parseSheetDate(row[dateCol], columns.dateOrder) === isoDate)
    .map((row) => ({
      tasks: cell(row[tasksCol]),
      status: statusCol === -1 ? '' : cell(row[statusCol]),
      notes: notesCol === -1 ? '' : cell(row[notesCol]),
    }));
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function iso(year: number, month: number, day: number): string | null {
  if (year < 100) year += 2000;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Accepts real date cells (Sheets serial numbers) and common typed formats:
 * 21-Oct-2026, 21 Oct 2026, October 21, 2026, 2026-10-21, 21/10/2026 (DMY by default).
 */
export function parseSheetDate(value: unknown, order: 'DMY' | 'MDY' = 'DMY'): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Google Sheets serial: days since 1899-12-30
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000).toISOString().slice(0, 10);
  }
  const s = cell(value);
  if (!s) return null;
  const month = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-\s./]+([A-Za-z]{3,})[-\s.,/]+(\d{2,4})$/)) && month(m[2]))
    return iso(+m[3], month(m[2]), +m[1]);
  if ((m = s.match(/^([A-Za-z]{3,})[-\s.]+(\d{1,2})(?:st|nd|rd|th)?,?[-\s.]+(\d{4})$/)) && month(m[1]))
    return iso(+m[3], month(m[1]), +m[2]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/)))
    return order === 'DMY' ? iso(+m[3], +m[2], +m[1]) : iso(+m[3], +m[1], +m[2]);
  return null;
}

const PLACEHOLDERS = new Set(['-', '--', 'na', 'n/a', 'nil', 'none', 'tbd', 'todo', 'pending', 'x']);

export function isMeaningful(tasks: string): boolean {
  const t = tasks.trim().toLowerCase();
  return !PLACEHOLDERS.has(t) && (t.match(/[a-z0-9]/g)?.length ?? 0) >= 3;
}

export function classify(entries: Entry[]): SheetResult {
  if (entries.length === 0) return { state: 'MISSING' };
  const ready = entries.filter((e) => isMeaningful(e.tasks));
  return ready.length ? { state: 'READY', entries: ready } : { state: 'INCOMPLETE', entries };
}
