// Persistent state:
//   accounts  – connected mailboxes and their settings (password / OAuth token AES-encrypted)
//   runs      – one row per account per day
//   logs      – append-only automation log
// Duplicate protection lives in claimForSending(): an atomic Postgres upsert that
// only succeeds when that account's day is not already SENT or SENDING.

import { neon } from '@neondatabase/serverless';
import type { Account, AccountFields } from './accounts';
import { env } from './env';

export type DayStatus = 'MISSING' | 'INCOMPLETE' | 'READY' | 'SENDING' | 'SENT' | 'ERROR';

export interface DayRecord {
  account_id: number;
  date: string;
  status: DayStatus;
  sheet_status: string | null;
  detail: string | null;
  email_subject: string | null;
  email_body: string | null;
  email_sent_at: string | null;
  email_message_id: string | null;
  updated_at: string;
}

export interface LogRecord {
  at: string;
  account_id: number;
  date: string;
  event: string;
  result: string;
  detail: string | null;
}

/** What the daily workflow needs. */
export interface RunStore {
  getDay(accountId: number, date: string): Promise<DayRecord | null>;
  /** Records a non-final status. Never overwrites a SENT or SENDING day. */
  setStatus(accountId: number, date: string, status: DayStatus, sheetStatus: string, detail?: string | null): Promise<void>;
  /** Atomically moves the day to SENDING. Returns false if it is already SENT/SENDING. */
  claimForSending(accountId: number, date: string, subject: string, body: string): Promise<boolean>;
  markSent(accountId: number, date: string, messageId: string): Promise<void>;
  markSendFailed(accountId: number, date: string, detail: string): Promise<void>;
  log(accountId: number, date: string, event: string, result: string, detail?: string | null): Promise<void>;
}

export interface StoredAccount extends Account {
  /** AES-encrypted SMTP password or OAuth refresh token */
  secretEnc: string;
}

export interface Store extends RunStore {
  listAccounts(): Promise<StoredAccount[]>;
  getAccount(id: number): Promise<StoredAccount | null>;
  /** Creates (no id) or updates an account. secretEnc null = keep the stored credential. */
  saveAccount(fields: AccountFields, secretEnc: string | null, id?: number): Promise<number>;
  /** Stores a rotated OAuth refresh token. */
  updateSecret(id: number, secretEnc: string): Promise<void>;
  deleteAccount(id: number): Promise<void>;
  history(limit: number): Promise<DayRecord[]>;
  logs(limit: number): Promise<LogRecord[]>;
}

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id            SERIAL PRIMARY KEY,
    label         TEXT NOT NULL,
    enabled       BOOLEAN NOT NULL DEFAULT true,
    provider      TEXT NOT NULL DEFAULT 'smtp',  -- google | microsoft | smtp
    sender_name   TEXT NOT NULL,
    sender_email  TEXT NOT NULL,
    smtp_host     TEXT NOT NULL DEFAULT '',     -- SMTP accounts only
    smtp_port     INT  NOT NULL DEFAULT 0,
    smtp_user     TEXT NOT NULL DEFAULT '',
    secret_enc    TEXT NOT NULL,                -- password or refresh token, AES-256-GCM (ENCRYPTION_KEY)
    hr_email      TEXT NOT NULL,
    hr_name       TEXT NOT NULL DEFAULT '',
    sheet_id      TEXT NOT NULL,
    sheet_name    TEXT NOT NULL,
    col_date      TEXT NOT NULL,
    col_tasks     TEXT NOT NULL,
    col_status    TEXT NOT NULL,
    col_notes     TEXT NOT NULL,
    date_order    TEXT NOT NULL DEFAULT 'DMY',
    working_days  TEXT NOT NULL DEFAULT '1,2,3,4,5,6',  -- 0 = Sunday
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Upgrade from the earlier password-only version (no-ops on a fresh database).
  `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'smtp_pass_enc') THEN
      ALTER TABLE accounts RENAME COLUMN smtp_pass_enc TO secret_enc;
    END IF;
  END $$`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'smtp'`,
  `CREATE TABLE IF NOT EXISTS runs (
    account_id       INT  NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    date             TEXT NOT NULL,             -- YYYY-MM-DD in APP_TIMEZONE
    status           TEXT NOT NULL,             -- MISSING | INCOMPLETE | READY | SENDING | SENT | ERROR
    sheet_status     TEXT,                      -- UPDATED | MISSING | INCOMPLETE | ERROR
    detail           TEXT,
    email_subject    TEXT,
    email_body       TEXT,
    email_sent_at    TIMESTAMPTZ,
    email_message_id TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, date)
  )`,
  `CREATE TABLE IF NOT EXISTS logs (
    id         BIGSERIAL PRIMARY KEY,
    at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    account_id INT  NOT NULL,
    date       TEXT NOT NULL,
    event      TEXT NOT NULL,
    result     TEXT NOT NULL,
    detail     TEXT
  )`,
];

const toIso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

function dayRow(row: Record<string, unknown>): DayRecord {
  return { ...(row as unknown as DayRecord), email_sent_at: toIso(row.email_sent_at), updated_at: toIso(row.updated_at)! };
}

function accountRow(r: Record<string, any>): StoredAccount {
  return {
    id: r.id,
    label: r.label,
    enabled: r.enabled,
    provider: r.provider === 'google' || r.provider === 'microsoft' ? r.provider : 'smtp',
    senderName: r.sender_name,
    senderEmail: r.sender_email,
    smtpHost: r.smtp_host,
    smtpPort: r.smtp_port,
    smtpUser: r.smtp_user,
    secretEnc: r.secret_enc,
    hrEmail: r.hr_email,
    hrName: r.hr_name,
    sheetId: r.sheet_id,
    sheetName: r.sheet_name,
    colDate: r.col_date,
    colTasks: r.col_tasks,
    colStatus: r.col_status,
    colNotes: r.col_notes,
    dateOrder: r.date_order === 'MDY' ? 'MDY' : 'DMY',
    workingDays: String(r.working_days).split(',').filter(Boolean).map(Number),
  };
}

let schemaReady: Promise<unknown> | null = null;

export function postgresStore(): Store {
  const sql = neon(env('DATABASE_URL'));
  const ready = () =>
    (schemaReady ??= (async () => {
      for (const s of SCHEMA) await sql.query(s);
    })().catch((e) => {
      schemaReady = null;
      throw e;
    }));

  return {
    async listAccounts() {
      await ready();
      return (await sql`SELECT * FROM accounts ORDER BY id`).map(accountRow);
    },
    async getAccount(id) {
      await ready();
      const rows = await sql`SELECT * FROM accounts WHERE id = ${id}`;
      return rows[0] ? accountRow(rows[0]) : null;
    },
    async saveAccount(a, secretEnc, id) {
      await ready();
      const days = a.workingDays.join(',');
      if (id === undefined) {
        if (!secretEnc) throw new Error('Credentials are required for a new account');
        const rows = await sql`
          INSERT INTO accounts (label, enabled, provider, sender_name, sender_email, smtp_host, smtp_port, smtp_user, secret_enc,
            hr_email, hr_name, sheet_id, sheet_name, col_date, col_tasks, col_status, col_notes, date_order, working_days)
          VALUES (${a.label}, ${a.enabled}, ${a.provider}, ${a.senderName}, ${a.senderEmail}, ${a.smtpHost}, ${a.smtpPort}, ${a.smtpUser},
            ${secretEnc}, ${a.hrEmail}, ${a.hrName}, ${a.sheetId}, ${a.sheetName}, ${a.colDate}, ${a.colTasks}, ${a.colStatus},
            ${a.colNotes}, ${a.dateOrder}, ${days})
          RETURNING id`;
        return rows[0].id as number;
      }
      const rows = await sql`
        UPDATE accounts SET label = ${a.label}, enabled = ${a.enabled}, provider = ${a.provider}, sender_name = ${a.senderName},
          sender_email = ${a.senderEmail}, smtp_host = ${a.smtpHost}, smtp_port = ${a.smtpPort}, smtp_user = ${a.smtpUser},
          secret_enc = COALESCE(${secretEnc}, secret_enc), hr_email = ${a.hrEmail}, hr_name = ${a.hrName},
          sheet_id = ${a.sheetId}, sheet_name = ${a.sheetName}, col_date = ${a.colDate}, col_tasks = ${a.colTasks},
          col_status = ${a.colStatus}, col_notes = ${a.colNotes}, date_order = ${a.dateOrder}, working_days = ${days},
          updated_at = now()
        WHERE id = ${id} RETURNING id`;
      if (!rows[0]) throw new Error('Account not found');
      return id;
    },
    async updateSecret(id, secretEnc) {
      await sql`UPDATE accounts SET secret_enc = ${secretEnc}, updated_at = now() WHERE id = ${id}`;
    },
    async deleteAccount(id) {
      await ready();
      await sql`DELETE FROM accounts WHERE id = ${id}`;
    },
    async getDay(accountId, date) {
      await ready();
      const rows = await sql`SELECT * FROM runs WHERE account_id = ${accountId} AND date = ${date}`;
      return rows[0] ? dayRow(rows[0]) : null;
    },
    async setStatus(accountId, date, status, sheetStatus, detail = null) {
      await ready();
      await sql`
        INSERT INTO runs (account_id, date, status, sheet_status, detail, updated_at)
        VALUES (${accountId}, ${date}, ${status}, ${sheetStatus}, ${detail}, now())
        ON CONFLICT (account_id, date) DO UPDATE
          SET status = EXCLUDED.status, sheet_status = EXCLUDED.sheet_status,
              detail = EXCLUDED.detail, updated_at = now()
          WHERE runs.status NOT IN ('SENT', 'SENDING')`;
    },
    async claimForSending(accountId, date, subject, body) {
      await ready();
      const rows = await sql`
        INSERT INTO runs (account_id, date, status, sheet_status, email_subject, email_body, updated_at)
        VALUES (${accountId}, ${date}, 'SENDING', 'UPDATED', ${subject}, ${body}, now())
        ON CONFLICT (account_id, date) DO UPDATE
          SET status = 'SENDING', sheet_status = 'UPDATED', detail = NULL,
              email_subject = EXCLUDED.email_subject, email_body = EXCLUDED.email_body, updated_at = now()
          WHERE runs.status NOT IN ('SENT', 'SENDING')
        RETURNING date`;
      return rows.length === 1;
    },
    async markSent(accountId, date, messageId) {
      await sql`
        UPDATE runs SET status = 'SENT', email_sent_at = now(), email_message_id = ${messageId}, updated_at = now()
        WHERE account_id = ${accountId} AND date = ${date} AND status = 'SENDING'`;
    },
    async markSendFailed(accountId, date, detail) {
      await sql`
        UPDATE runs SET status = 'ERROR', detail = ${detail}, updated_at = now()
        WHERE account_id = ${accountId} AND date = ${date} AND status = 'SENDING'`;
    },
    async log(accountId, date, event, result, detail = null) {
      await ready();
      await sql`INSERT INTO logs (account_id, date, event, result, detail)
                VALUES (${accountId}, ${date}, ${event}, ${result}, ${detail})`;
    },
    async history(limit) {
      await ready();
      return (await sql`SELECT * FROM runs ORDER BY date DESC, account_id LIMIT ${limit}`).map(dayRow);
    },
    async logs(limit) {
      await ready();
      const rows = await sql`SELECT at, account_id, date, event, result, detail FROM logs ORDER BY id DESC LIMIT ${limit}`;
      return rows.map((r) => ({ ...(r as unknown as LogRecord), at: toIso(r.at)! }));
    },
  };
}
