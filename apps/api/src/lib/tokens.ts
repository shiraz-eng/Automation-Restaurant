import { randomBytes, createHash } from 'node:crypto';

export interface ClaimToken {
  /** Goes in the emailed link. Never stored. */
  raw: string;
  /** SHA-256 hex of `raw`. This is what lands in the database. */
  hash: string;
}

/**
 * Single-use onboarding token. The raw value is a 256-bit random string; only
 * its hash is persisted, so a database leak does not hand out portal access.
 */
export function createClaimToken(): ClaimToken {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashClaimToken(raw) };
}

export function hashClaimToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
