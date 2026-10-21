// AES-256-GCM encryption for mailbox passwords stored in the database.
// The key comes from ENCRYPTION_KEY and never leaves the server.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from './env';

const key = () => createHash('sha256').update(env('ENCRYPTION_KEY')).digest();

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

export function decrypt(stored: string): string {
  const [version, iv, tag, data] = stored.split('.');
  if (version !== 'v1') throw new Error('Unknown password format');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Could not decrypt the mailbox password (was ENCRYPTION_KEY changed?). Re-enter it in the dashboard.');
  }
}
