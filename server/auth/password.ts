import crypto from 'node:crypto';

/** scrypt-based hashing for PINs. Format: scrypt$N$salt$hash */
const N = 16384, KEYLEN = 64;

export function hashSecret(secret: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(secret, salt, KEYLEN, { N }).toString('hex');
  return `scrypt$${N}$${salt}$${hash}`;
}

export function verifySecret(secret: string, stored: string): boolean {
  const [alg, n, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(secret, salt, KEYLEN, { N: Number(n) });
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/** Weak-PIN guard for member PINs. */
export function pinProblems(pin: string): string | null {
  if (!/^\d{4}$/.test(pin)) return 'PIN must be exactly 4 digits.';
  if (/^(\d)\1{3}$/.test(pin)) return 'Choose a PIN that is not a repeated digit.';
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return 'Choose a PIN that is harder to guess than digits in a row.';
  return null;
}
