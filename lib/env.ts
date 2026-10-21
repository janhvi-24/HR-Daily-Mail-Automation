// Global configuration from environment variables. Per-account settings
// (mailbox, HR recipient, sheet, working days) live in the database and are
// managed from the dashboard.

export function env(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing environment variable ${name}`);
}

export const timezone = () => env('APP_TIMEZONE', 'Asia/Kolkata');
export const geminiModel = () => env('GEMINI_MODEL', 'gemini-3.8-flash');

/** Raw JSON or base64 of the service-account key file. */
export function serviceAccount(): { client_email: string; private_key: string } {
  let raw = env('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(raw);
}

/** The address users share their sheet with (not secret). */
export function serviceAccountEmail(): string | null {
  try {
    return serviceAccount().client_email;
  } catch {
    return null;
  }
}

const SECRET_VARS = [
  'GEMINI_API_KEY',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'ENCRYPTION_KEY',
  'CRON_SECRET',
  'ADMIN_PASSWORD',
  'DATABASE_URL',
];

/** Turns any error into a short, log-safe message with secret values masked. */
export function safeMessage(error: unknown, extraSecrets: string[] = []): string {
  let text = error instanceof Error ? error.message : String(error);
  for (const secret of [...SECRET_VARS.map((name) => process.env[name]), ...extraSecrets]) {
    if (secret && secret.length >= 6) text = text.split(secret).join('***');
  }
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
