import { randomBytes } from 'node:crypto';

/** A random, easy-to-read temporary password for an Owner-managed login
 *  (portal kiosk accounts, staff accounts) — shown once at creation/reset,
 *  never stored in plaintext. Shared so every such flow generates the same
 *  shape rather than inventing its own. */
export function tempPassword(): string {
  const a = 'abcdefghjkmnpqrstuvwxyz';
  const n = '23456789';
  const pick = (s: string, k: number) => {
    const b = randomBytes(k);
    let out = '';
    for (let i = 0; i < k; i++) out += s.charAt((b[i] as number) % s.length);
    return out;
  };
  return `${pick(a.toUpperCase(), 1)}${pick(a, 3)}-${pick(a, 2)}${pick(n, 2)}-${pick(n, 1)}${pick(a, 3)}`;
}
