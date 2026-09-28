/**
 * Password hashing for the local credential path — the application's entry point.
 *
 * The implementation lives in `lib/scrypt-kdf.ts`, which has no `server-only` import and no Next.js
 * dependency so the account-creating scripts can share it (`scripts/bootstrap-admin.ts`,
 * `scripts/create-test-user.ts`). This module is the guarded door the application imports:
 * a client component that reaches for a password helper fails at build time rather than shipping
 * the KDF to a browser.
 *
 *   scrypt$<N>$<r>$<p>$<salt-b64>$<derived-key-b64>
 */
import 'server-only';

export { hashPassword, passwordPolicyError, verifyPassword } from './scrypt-kdf';
