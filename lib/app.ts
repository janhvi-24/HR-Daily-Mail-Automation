// Wires the real Google Sheets / Gemini / SMTP / Postgres implementations,
// plus small helpers shared by the API routes.

import type { PublicAccount } from './accounts';
import { generateEmailContent } from './ai';
import { decrypt, encrypt } from './crypto';
import { timezone } from './env';
import { deliver } from './mailer';
import { readSheetForDate } from './sheet';
import { postgresStore, type Store, type StoredAccount } from './store';
import type { Deps } from './workflow';

export function realDeps(store: Store = postgresStore()): Deps & { store: Store } {
  return {
    timezone: timezone(),
    store,
    readSheet: readSheetForDate,
    generate: generateEmailContent,
    // Credentials are looked up and decrypted only at send time.
    send: async (account, mail) => {
      const stored = await store.getAccount(account.id);
      if (!stored) throw new Error('Account was deleted');
      return deliver(stored, decrypt(stored.secretEnc), mail, (token) => store.updateSecret(stored.id, encrypt(token)));
    },
  };
}

export function toPublic({ secretEnc, ...account }: StoredAccount): PublicAccount {
  return { ...account, connected: Boolean(secretEnc) };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}
