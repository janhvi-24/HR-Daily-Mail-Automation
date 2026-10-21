# Daily Work-Log → HR Email

Connect one or more mailboxes in the dashboard: **Gmail and Outlook with a "Sign in" button**, and Hostinger, Zoho, Titan, GoDaddy, Yahoo, iCloud or any SMTP server with a password. The provider is detected automatically from the email address. Each one is its own automation: a work-log Google Sheet, an HR recipient, and working days. Every working day at ~10:30 AM IST the app checks each account's sheet for today's row. If the row is there, Gemini turns it into a short, professional update, and the app sends it **from that person's own mailbox** to their HR. It never sends twice, and if today's row is missing or empty it sends nothing.

```
Vercel Cron 10:30 IST ──► /api/cron ──► for each enabled account (in parallel, isolated):
                                         1. today in Asia/Kolkata, working-day check
                                         2. already SENT? → stop
                                         3. read that account's sheet → MISSING / INCOMPLETE → record, stop
                                         4. Gemini → bullet points (JSON only)
                                         5. atomic claim → SENDING (only one caller can win)
                                         6. send from the account's own mailbox → HR
                                            (Gmail API · Microsoft Graph · SMTP)
Dashboard (/) ──► connect / edit / test accounts, Check · Preview · Send Now, history, log
Postgres (Neon): accounts (password / sign-in token AES-encrypted) · runs · logs
```

## Technology

| Need | Choice |
|---|---|
| Hosting + schedule | Vercel functions + Vercel Cron. No framework, no build step |
| Sheet | Google Sheets API with one service account. Each person shares their sheet with it |
| AI | Google Gemini `generateContent` called with plain `fetch` and JSON-schema output. The model writes only the bullets and notes; subject, date, greeting and sign-off come from code |
| Email | **Gmail**: OAuth sign-in, Gmail API, `gmail.send` scope only. **Outlook / Microsoft 365**: OAuth sign-in, Microsoft Graph, `Mail.Send` only. **Everything else**: SMTP via `nodemailer`. All mail is sent from the person's own mailbox, so it appears in their Sent folder |
| Storage | Neon Postgres (Vercel Marketplace) |

Runtime dependencies: `nodemailer`, `@neondatabase/serverless`.

## Project structure

```
api/cron.ts        GET  – scheduled run for all enabled accounts (requires CRON_SECRET)
api/accounts.ts    POST – detect provider / connect / edit / remove / test an account (admin)
api/oauth.ts       GET  – "Sign in with Google / Microsoft" popup + callback (admin)
api/run.ts         POST – Check / Preview / Send Now for one account (admin)
api/status.ts      GET  – accounts (no passwords), history, log (admin)
api/login.ts       POST sign in · DELETE sign out
lib/workflow.ts    the daily flow and all its guards (dependency-injected, fully tested)
lib/accounts.ts    account model + form validation
lib/providers.ts   provider list (Hostinger, Gmail, Zoho, …) + MX-based auto-detection
lib/oauth.ts       Google/Microsoft sign-in: state, token exchange/refresh, sealed hand-off
lib/crypto.ts      AES-256-GCM for stored passwords and tokens
lib/mailer.ts      send + verify via Gmail API, Microsoft Graph or SMTP
lib/ai.ts          Gemini prompt, schema, response validation
lib/sheet.ts       Google auth, find today's rows by Date header
lib/compose.ts     the email template
lib/store.ts       Postgres tables + duplicate-safe status transitions
lib/auth.ts        admin cookie, cron secret, same-origin check
public/index.html  the dashboard
scripts/local.ts   run the real flow from your laptop
tests/             all required scenarios + multi-account, crypto, validation
```

## Environment variables (global only)

See [.env.example](.env.example). Mailboxes, recipients, sheets and working days are set in the dashboard, not here.

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Gemini key; model defaults to `gemini-3.8-flash` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service-account key that reads the sheets |
| `DATABASE_URL` | Neon connection string |
| `ENCRYPTION_KEY` | Encrypts mailbox passwords and sign-in tokens at rest. **Keep it.** If it changes, every mailbox must be reconnected |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Optional; enables the **Sign in with Google** button |
| `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET` | Optional; enables the **Sign in with Microsoft** button |
| `APP_URL` | Optional; your public URL (for example a custom domain). Defaults to the request's origin |
| `CRON_SECRET` | Protects `/api/cron` |
| `ADMIN_PASSWORD` | Dashboard password |
| `APP_TIMEZONE` | Default `Asia/Kolkata` |

## Setup

### 1. Gemini key

Go to <https://aistudio.google.com/apikey>, click **Create API key**, and put it in `GEMINI_API_KEY`. The request uses low thinking and is a few hundred tokens a day, which is within the free tier. Set `GEMINI_MODEL=gemini-3.1-flash-lite` for the cheapest option.

### 2. Google service account (reads the sheets)

1. In <https://console.cloud.google.com>, create a project and enable the **Google Sheets API** (*APIs & Services → Library*).
2. Go to *IAM & Admin → Service Accounts → Create*. You don't need to grant it any roles.
3. Open the service account and go to *Keys → Add key → JSON*.
4. Run `base64 -i key.json | tr -d '\n'`, paste the output into `GOOGLE_SERVICE_ACCOUNT_JSON`, then delete the file.

The dashboard shows this account's email address in the "Connect mail account" form. Everyone shares their sheet with that address as a **Viewer**.

### 3. Sheet format

| Date | Tasks / Activities | Status | Additional Notes |
|---|---|---|---|
| 21-Oct-2026 | Worked on LMS Phase 2 | Completed | Reviewed API and frontend changes |

- Rows can be in any order. Today's row is found by the Date column.
- Dates can be real date cells, `21-Oct-2026`, `21 Oct 2026`, `2026-10-21` or `21/10/2026`.
- Several rows with today's date are combined into one email.
- An empty task cell, or a placeholder like `-`, `NA` or `TBD`, counts as INCOMPLETE.
- Column names and the date order can be changed per account under *Advanced*.
- If your log is an Excel file, open it in Google Drive and use *File → Save as Google Sheets*.

### 4. Deploy to Vercel

```bash
npm install
npm test                       # offline test suite
```

1. Put `GEMINI_API_KEY` and an `ADMIN_PASSWORD` of your choice into `.env` and save it.
2. Run `npm run setup`. It generates `ENCRYPTION_KEY` and `CRON_SECRET`, converts the service-account key file in this folder into `GOOGLE_SERVICE_ACCOUNT_JSON`, and lists anything still missing. It never overwrites values you set. Afterwards, move the key `.json` file out of the project folder; `.env` now holds it.
3. Run `vercel login` (opens your browser), then `vercel link`. When asked, create a new project with framework "Other" and no build command.
4. **Database:** in the Vercel dashboard, open the project → *Storage → Create Database → Neon (Postgres)*. Connect it to the project, and `DATABASE_URL` is added automatically.
5. Run `npm run push-env`. It copies every value from `.env` to Vercel (Production, marked sensitive), skipping `DATABASE_URL`.
6. Run `vercel deploy --prod`. It prints your URL, such as `https://hr-mail-automation.vercel.app`.
7. Open the URL, sign in with `ADMIN_PASSWORD`, and click **+ Connect mail account**.
8. Under *Project → Settings → Cron Jobs*, check that `/api/cron` is listed.

Whenever you change `.env`, run `npm run push-env` again, then `vercel deploy --prod`. Secrets never go to git or the deployment bundle: `.gitignore` and `.vercelignore` exclude `.env` and key files.

### 5. Enable "Sign in with Google" (for Gmail users)

You can skip this if nobody uses Gmail. Without it, the Google tile offers "Gmail (App Password)" instead.

1. In the same Google Cloud project, enable the **Gmail API** (*APIs & Services → Library*).
2. Go to *APIs & Services → OAuth consent screen* (called "Google Auth Platform" in newer consoles).
   - **User type:** use **External** (Gmail accounts and other companies), or **Internal** if every user is in one Google Workspace.
   - **Data access / Scopes:** add `…/auth/gmail.send`. Also allow the basic `openid`, `email` and `profile` scopes.
   - **Publishing status:** click **Publish app**. In "Testing" mode, Google expires sign-ins after 7 days and the daily email would start failing.
   - Until Google verifies the app, users see a "Google hasn't verified this app" screen. They click **Advanced → Continue**. That's fine for a small team. Verification removes the warning and lifts the 100-user cap.
3. Go to *Credentials → Create credentials → OAuth client ID*.
   - Type: **Web application**.
   - Authorized redirect URI: `https://<your-app>.vercel.app/api/oauth`
4. Put the client ID and secret in `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`, then redeploy.

### 6. Enable "Sign in with Microsoft" (for Outlook / Microsoft 365 users)

1. Go to <https://portal.azure.com> → *Microsoft Entra ID → App registrations → New registration*.
   - **Supported account types:** "Accounts in any organizational directory and personal Microsoft accounts".
   - **Redirect URI:** platform **Web**, `https://<your-app>.vercel.app/api/oauth`
2. Go to *Certificates & secrets → New client secret*. Copy the **Value**, not the ID. It expires after at most 24 months, so set a reminder to renew it.
3. Go to *API permissions → Add → Microsoft Graph → Delegated*. Add `Mail.Send`, `User.Read`, `offline_access`, `openid`, `email` and `profile`.
4. Put the Application (client) ID and the secret value in `MICROSOFT_OAUTH_CLIENT_ID` and `MICROSOFT_OAUTH_CLIENT_SECRET`, then redeploy.

Some organisations only let admins approve new apps. In that case the user sees "Need admin approval", and an admin of that tenant must click *Grant admin consent*.

### 7. Connect mailboxes

Open the dashboard and click **+ Connect mail account**. Type the email address and the provider is detected from the domain's mail servers. For example, `janhvi.k@brainmine.ai` is detected as Hostinger. You can also pick a tile yourself.

| Provider | How it connects |
|---|---|
| **Gmail / Google Workspace** | **Sign in with Google** in a popup. Only "send email on your behalf" is requested, and no password is stored. Revoke any time at myaccount.google.com/permissions |
| **Outlook / Microsoft 365** | **Sign in with Microsoft** in a popup. Only `Mail.Send` is requested |
| **Hostinger** | `smtp.hostinger.com:465`, full email address + mailbox password (hPanel → Emails) |
| Titan · GoDaddy | `smtp.titan.email:465` · `smtpout.secureserver.net:465`, mailbox password |
| Zoho | `smtppro.zoho.in` / `smtppro.zoho.com` (custom domain) or `smtp.zoho.in` / `.com` (free), App Password if 2FA is on |
| Yahoo · iCloud | App Password (Yahoo) or app-specific password (Apple) |
| Gmail (App Password) | Fallback when Google sign-in isn't set up: 2-Step Verification + App Password |
| Other (SMTP) | Any server. Port 465 means SSL; 587 means STARTTLS |

Then fill in the HR email and name, paste the Google Sheet link, and click **Test connection**. It checks the mailbox login or sign-in and reads the sheet, without sending anything. Click **Send test email to me** to send a test to your own address (never to HR), then click **Save**.

If a Google or Microsoft sign-in is later revoked, or its password changes, the account card shows the error and a **Reconnect** button.

## Scheduler

`vercel.json` contains `"schedule": "0 5 * * 1-6"`. Vercel Cron runs in UTC, so this is 10:30 IST Monday to Saturday.

- On the Hobby plan, Vercel may start it any time in that hour (10:30–11:29 IST). Pro is exact.
- To change the time, use UTC = IST − 5:30.
- The time is shared by all accounts. Each account's own working days are checked in IST by the app itself.
- **Optional catch-up run:** add `{ "path": "/api/cron", "schedule": "0 7 * * 1-6" }` for 12:30 IST. It sends for anyone who filled in their sheet late and skips anyone already sent.

## Duplicate protection

There's one `runs` row per account per day. Statuses move `MISSING | INCOMPLETE | READY | ERROR` → `SENDING` → `SENT`, and a day in `SENDING` or `SENT` is never changed by the app again. Before sending, an atomic `INSERT … ON CONFLICT … WHERE status NOT IN ('SENT','SENDING') RETURNING` claims the day. Postgres guarantees only one caller wins, even if two cron runs and a manual Send happen at once (this is tested).

If a send is interrupted, the day stays `SENDING` ("Sending / unconfirmed") and is never retried automatically. Check the Sent folder, then see `schema.sql` for the release query.

## Security

- **Dashboard:** `ADMIN_PASSWORD` sign-in sets an HttpOnly, Secure, SameSite=Lax, HMAC-signed cookie. It's Lax so the session survives the redirect back from Google or Microsoft. All account and run endpoints need it, or the `CRON_SECRET` bearer token. Cross-origin POSTs are rejected.
- **Credentials at rest:** SMTP passwords and Google/Microsoft refresh tokens are encrypted with AES-256-GCM using `ENCRYPTION_KEY`. They're decrypted only at the moment of sending or testing and are never returned to the browser. When editing an account, leave the password blank to keep the saved one.
- **Sign-in flow:** the request is signed, expires after 10 minutes and is bound to your browser by a cookie, which blocks login CSRF. Only the minimum send scopes are requested. The popup hands the token back to the dashboard encrypted, so the page can't read it. The mailbox address always comes from the sign-in, not the form.
- **Rotating tokens:** Microsoft periodically issues a new refresh token, and the app saves it automatically.
- **Fixed recipients:** each account's recipient is fixed by its saved settings. Test emails go only to the account's own address. There is no "send to any address" endpoint.
- **Input validation:** names and addresses can't contain line breaks (no header injection). Host names, ports, emails and sheet IDs are checked.
- **Logs:** errors are truncated, and secret values are masked before they're stored.
- **Single admin:** whoever has `ADMIN_PASSWORD` manages all accounts. If each colleague needs their own login, that's a separate feature.

## Local testing

```bash
cp .env.example .env     # fill in, including DATABASE_URL from Neon
npm test
npm run local -- accounts            # list accounts (add them in the dashboard)
npm run local -- check 1             # read account 1's sheet
npm run local -- preview 1           # + Gemini, prints the email, sends nothing
npm run local -- send 1 --yes        # really sends to account 1's HR
npm run local -- status              # history + log
```

### Required scenarios

`npm test` covers all of these:

| # | Scenario | Expected |
|---|---|---|
| 1 | Sheet updated | sent, `SENT`, full log sequence |
| 2 | No row | no email, `MISSING` |
| 3 | Empty tasks | no email, `INCOMPLETE` |
| 4 | Cron twice / three concurrent runs | exactly one email |
| 5 | Gemini fails | no email, `ERROR – Unable to generate email` |
| 6 | SMTP fails | not `SENT`; a later manual send works |
| 7 | Sunday | nothing read, nothing recorded |
| 8 | Manual send auth | anonymous, forged or wrong-secret requests rejected |
| – | Multiple accounts | each sends once from its own mailbox; one failing doesn't affect others; paused accounts and non-working days skipped |
| – | Password storage | encrypted, random IV, tamper-proof, wrong key detected |
| – | Connecting accounts | MX detection, signed and browser-bound sign-in state, sealed tokens, minimal scopes, Gmail API and Graph send (mocked HTTP), Microsoft token rotation, "reconnect" on revoked access |

### Live checklist before going live

Set the account's HR email to **your own address** first.

1. Run **Test connection** and **Send test email to me**.
2. Delete today's row and run **Check Now**: expect *Not updated*. Add the row with no tasks: expect *Incomplete*. Fill it in: expect *Updated*.
3. Run **Generate Preview** and read the wording.
4. Run **Send Now**: expect *Sent* and the email in your inbox. Run **Send Now** again: expect "already sent".
5. Check the cron is protected:
   ```bash
   curl -i https://<app>.vercel.app/api/cron
   ```
   Expect 401. Run it with `-H "Authorization: Bearer $CRON_SECRET"` and expect `ALREADY_SENT`.
6. Clear the test data in the Neon SQL editor: `DELETE FROM runs; DELETE FROM logs;`
7. Edit the account and set the real HR email.

## Troubleshooting

| Message | Fix |
|---|---|
| `Invalid login: 535 … authentication failed` | Wrong mailbox password, or Zoho/Yahoo/iCloud needs an App Password |
| `… access was revoked or expired; reconnect the account` | Click **Reconnect** on the account card. For Google, make sure the consent screen is **Published**, not Testing |
| Sign-in popup: `redirect_uri_mismatch` | The redirect URI registered with Google or Microsoft must exactly match `https://<your-app>/api/oauth`. Set `APP_URL` if you use a custom domain |
| "Need admin approval" (Microsoft) | A tenant admin must grant consent to the app registration |
| Sign-in window doesn't open | Allow pop-ups for the dashboard's site |
| `Sheets API 403: share the sheet with …` | Share the sheet with the service-account email shown, as Viewer |
| `Header "Date" not found` | Set the column names under *Advanced* to match your sheet |
| `Could not decrypt the mailbox password` | `ENCRYPTION_KEY` changed. Re-enter the password and save |
| `Gemini 429` | Rate or quota limit. Use **Send Now** later, or add the catch-up cron |
| Stuck at "Sending / unconfirmed" | Check the Sent folder. If it wasn't sent, run the release query in `schema.sql` |
