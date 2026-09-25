/**
 * Password hashing for the local credential path.
 *
 * scrypt is used from Node's core `crypto` — no extra dependency, and it is a
 * memory-hard KDF, which is the property that matters here. Parameters are stored
 * alongside the hash so they can be raised later without invalidating existing
 * credentials:
 *
 *   scrypt$<N>$<r>$<p>$<salt-b64>$<derived-key-b64>
 *
 * Verification is constant-time via `timingSafeEqual`, after a length check
 * (which `timingSafeEqual` requires).
 */
import 'server-only';

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** N=2^15, r=8, p=1 — ~32MB per hash, tuned to stay well under scrypt's default maxmem. */
const DEFAULT_PARAMS = { N: 32_768, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** scrypt's own default maxmem (32MB) is too low for N=2^15,r=8; raise it explicitly. */
function maxmemFor(N: number, r: number): number {
  return 256 * N * r * 2;
}

export async function hashPassword(
  password: string,
  params: { N: number; r: number; p: number } = DEFAULT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    ...params,
    maxmem: maxmemFor(params.N, params.r),
  });
  return [
    'scrypt',
    String(params.N),
    String(params.r),
    String(params.p),
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [algorithm, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (algorithm !== 'scrypt') return false;

  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N <= 1 || r <= 0 || p <= 0) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltRaw, 'base64');
    expected = Buffer.from(hashRaw, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: maxmemFor(N, r),
    });
  } catch {
    // An unsupported parameter set (e.g. maxmem exceeded) must read as "does not
    // match", never as an exception that leaks which branch was taken.
    return false;
  }

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * Minimum policy for the local path. Length only — deliberately no character-class
 * rules, which push users toward predictable substitutions.
 */
export function passwordPolicyError(password: string): string | null {
  if (password.length < 12) return 'Use at least 12 characters.';
  if (password.length > 200) return 'Use at most 200 characters.';
  return null;
}
