/**
 * Creates a second, deliberately restricted account for the browser suite.
 *
 * `scripts/bootstrap-admin.ts` is idempotent on purpose — it refuses to touch a deployment that
 * already has users — so it cannot create the *restricted* account the route crawl needs: an
 * operator who holds a grant on the fixture business but only the `user` share of it, so the crawl
 * can prove that a screen they may not open is neither offered nor reachable.
 *
 * The credential is written with the application's own `hashPassword` (`src/lib/password.ts`), which
 * the login route verifies with. That is the whole point of doing it here rather than with SQL in the
 * harness: the stored layout stays in one place, so a change to the KDF cannot leave this suite
 * seeding a credential the server refuses.
 *
 * Usage:
 *   node --experimental-strip-types scripts/create-test-user.ts <email> <password> <full name> <role>
 *
 * The grant is *not* written here: access is data, and the harness writes it the same way it writes
 * every other fixture row.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '@nexus/db/migrate';

import { hashPassword, passwordPolicyError } from '../src/lib/scrypt-kdf.ts';

const [email, password, fullName, role] = process.argv.slice(2);

if (email === undefined || password === undefined || fullName === undefined || role === undefined) {
  console.error('usage: create-test-user.ts <email> <password> <full name> <role>');
  process.exit(2);
}
if (role !== 'admin' && role !== 'manager' && role !== 'user') {
  console.error(`unsupported role ${role}`);
  process.exit(2);
}
const policy = passwordPolicyError(password);
if (policy !== null) {
  console.error(`password refused by the application's own policy: ${policy}`);
  process.exit(2);
}

const dataDir = path.resolve(process.cwd(), '.data');
mkdirSync(dataDir, { recursive: true });
const db = await PGlite.create({ dataDir: path.join(dataDir, 'nexus') });

try {
  await applyMigrations(db);

  const existing = await db.query<{ id: string }>(
    `select id from public.users where lower(email) = lower($1) and deleted_at is null`,
    [email],
  );

  let userId = existing.rows[0]?.id;
  if (userId === undefined) {
    const inserted = await db.query<{ id: string }>(
      `insert into public.users (email, full_name, role, status)
       values ($1, $2, $3, 'active')
       returning id`,
      [email, fullName, role],
    );
    userId = inserted.rows[0]?.id;
    if (userId === undefined) throw new Error('the user row was not created');
  } else {
    // Re-running keeps the account usable rather than failing on the unique email.
    await db.query(`update public.users set role = $2, full_name = $3 where id = $1`, [
      userId,
      role,
      fullName,
    ]);
  }

  const hash = await hashPassword(password);
  await db.query(
    `insert into public.user_credentials (user_id, password_hash)
     values ($1, $2)
     on conflict (user_id) do update set password_hash = excluded.password_hash`,
    [userId, hash],
  );

  console.log(`${email} (${role}) is ready`);
} finally {
  await db.close();
}
