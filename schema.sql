-- Created automatically on first run; kept here for reference.

CREATE TABLE IF NOT EXISTS accounts (
  id            SERIAL PRIMARY KEY,
  label         TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  sender_name   TEXT NOT NULL,
  sender_email  TEXT NOT NULL,
  smtp_host     TEXT NOT NULL,
  smtp_port     INT  NOT NULL,
  smtp_user     TEXT NOT NULL,
  smtp_pass_enc TEXT NOT NULL,              -- AES-256-GCM, key = ENCRYPTION_KEY
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
);

CREATE TABLE IF NOT EXISTS runs (
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
);

CREATE TABLE IF NOT EXISTS logs (
  id         BIGSERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  account_id INT  NOT NULL,
  date       TEXT NOT NULL,
  event      TEXT NOT NULL,
  result     TEXT NOT NULL,
  detail     TEXT
);

-- Only if a send was interrupted (status stuck at SENDING) AND you confirmed in that
-- mailbox's Sent folder that the email did NOT go out:
--   UPDATE runs SET status = 'ERROR', detail = 'Manually released'
--   WHERE account_id = 1 AND date = '2026-10-21' AND status = 'SENDING';
