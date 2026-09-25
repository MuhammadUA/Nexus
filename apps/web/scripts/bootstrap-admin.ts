/**
 * Creates the first administrator for a deployment, from the command line.
 *
 * The web UI can do this too (the first-run panel on `/login`), but that requires the
 * operator to reach the page before anyone else does. For a deployment you are
 * bringing up yourself, this is the reproducible path: apply every migration to a
 * clean database if needed, then create the admin with a password you choose.
 *
 * It is **idempotent**: re-running it against a claimed deployment reports that fact
 * and changes nothing, so it is safe to call from a start-up script.
 *
 * Usage:
 *   node --experimental-strip-types scripts/bootstrap-admin.ts <email> <password> [full name]
 *
 * The database driver matches the web app exactly (`DATABASE_URL` when set, otherwise
 * the embedded PGlite database under `apps/web/.data`), so the account this creates is
 * the account the server authenticates against.
 */
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '@nexus/db/migrate';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Must match `apps/web/src/lib/password.ts` so the server can verify what we store here. */
async function hashPassword(password: string): Promise<string> {
  const N = 32_768;
  const r = 8;
  const p = 1;
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, 64, {
    N,
    r,
    p,
    maxmem: 256 * N * r * 2,
  });
  return ['scrypt', String(N), String(r), String(p), salt.toString('base64'), derived.toString('base64')].join('$');
}

const [emailArg, passwordArg, ...nameParts] = process.argv.slice(2);
if (emailArg === undefined || passwordArg === undefined) {
  console.error('usage: bootstrap-admin.ts <email> <password> [full name]');
  process.exit(1);
}

const email = emailArg.trim().toLowerCase();
const fullName = nameParts.join(' ').trim() || 'Administrator';

if (!email.includes('@')) {
  console.error(`"${email}" is not an email address.`);
  process.exit(1);
}
if (passwordArg.length < 12) {
  console.error('The password must be at least 12 characters.');
  process.exit(1);
}

async function main(): Promise<void> {
  const external = (process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL ?? '').trim();

  if (external.length > 0) {
    console.error(
      'DATABASE_URL is set, so this script will not touch it.\n' +
        'Apply the migrations and create the first admin through your database tooling,\n' +
        'or unset DATABASE_URL to provision the embedded database instead.',
    );
    process.exit(1);
  }

  const dataDir = path.join(process.cwd(), '.data');
  mkdirSync(dataDir, { recursive: true });

  const db = await PGlite.create({ dataDir: path.join(dataDir, 'nexus') });

  try {
    const applied = await applyMigrations(db);
    console.log(`migrations applied: ${String(applied.length)}`);

    // `row_security = off` mirrors a Supabase service-role seed. FORCE RLS still binds
    // the table owner, so without this the insert below would be refused by policy.
    await db.exec('set row_security = off');

    const existing = await db.query<{ n: number }>('select count(*)::int as n from public.users');
    const count = Number(existing.rows[0]?.n ?? 0);

    if (count > 0) {
      const admins = await db.query<{ email: string; role: string }>(
        `select email, role from public.users where deleted_at is null order by created_at`,
      );
      console.log(`\nThis deployment already has ${String(count)} user(s). Nothing was changed.`);
      for (const row of admins.rows) console.log(`  ${row.role.padEnd(7)} ${row.email}`);
      console.log('\nSign in with one of those accounts, or create more at /team.');
      return;
    }

    const passwordHash = await hashPassword(passwordArg);

    const inserted = await db.query<{ id: string }>(
      `insert into public.users (email, full_name, role, status)
       values ($1, $2, 'admin', 'active')
       returning id`,
      [email, fullName],
    );
    const userId = inserted.rows[0]?.id;
    if (userId === undefined) throw new Error('the admin row was not created');

    await db.query(`insert into public.user_credentials (user_id, password_hash) values ($1, $2)`, [
      userId,
      passwordHash,
    ]);

    // Audited like any other sensitive mutation, so the trail starts at the beginning.
    await db.query(
      `insert into public.audit_events
         (actor_type, actor_id, entity_type, entity_id, action, after_json, source_client)
       values ('system', $1, 'users', $1, 'bootstrap_first_admin', $2, 'cli-bootstrap')`,
      [userId, JSON.stringify({ email, role: 'admin', via: 'cli' })],
    );

    await db.exec('set row_security = on');

    console.log('\nAdministrator created.');
    console.log(`  email    ${email}`);
    console.log(`  user id  ${userId}`);
    console.log('  role     admin');
    console.log('\nSign in at /login. Change this password once you are in.');
  } finally {
    await db.close();
  }
}

await main();
