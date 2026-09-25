/**
 * Production start helper.
 *
 * `next start` reads its configuration from the environment, and two variables must
 * stay stable across restarts or behaviour appears to change for no visible reason:
 *
 *   NEXUS_SESSION_SECRET  — signing key for the session cookie. If this changes, every
 *                           existing session becomes invalid and users are silently
 *                           logged out. It is therefore generated once and persisted to
 *                           `.env.local`, not regenerated per run.
 *   NEXUS_LOCAL_AUTH      — enables the email/password path. Without it, `/api/auth/login`
 *                           refuses with "local sign-in is disabled" and the only way in
 *                           is Supabase Auth.
 *
 * `NEXUS_ALLOW_EMBEDDED_IN_PRODUCTION=1` is set for the embedded-database mode, which is
 * a **single-process** database: correct for one machine serving one operator, and not
 * correct for a real multi-instance deployment. Set `DATABASE_URL` and this file stops
 * applying that flag. See docs/DEPLOYMENT.md §4.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const appDir = path.resolve(import.meta.dirname, '..');
const envFile = path.join(appDir, '.env.local');

/** Reads a single key out of `.env.local` without pulling in a dotenv dependency. */
function readEnvValue(key) {
  if (!existsSync(envFile)) return null;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`).exec(line);
    if (match !== null) {
      const value = match[1].trim();
      if (value.length > 0) return value;
    }
  }
  return null;
}

function ensureEnvValue(key, generate) {
  const existing = process.env[key] ?? readEnvValue(key);
  if (existing !== null && existing.length > 0) return existing;

  const value = generate();
  writeFileSync(envFile, `${existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''}${key}=${value}\n`, 'utf8');
  console.log(`[serve] generated ${key} and saved it to .env.local (keep this file: losing it signs everyone out)`);
  return value;
}

const sessionSecret = ensureEnvValue('NEXUS_SESSION_SECRET', () => randomBytes(32).toString('base64url'));
const port = process.env.PORT ?? '3000';

const childEnv = {
  ...process.env,
  NODE_ENV: 'production',
  NEXUS_SESSION_SECRET: sessionSecret,
  NEXUS_LOCAL_AUTH: process.env.NEXUS_LOCAL_AUTH ?? '1',
};

const external = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? '').trim();
if (external.length === 0) {
  childEnv.NEXUS_ALLOW_EMBEDDED_IN_PRODUCTION = process.env.NEXUS_ALLOW_EMBEDDED_IN_PRODUCTION ?? '1';
  console.log('[serve] using the embedded PostgreSQL database (apps/web/.data) — single process only');
} else {
  console.log('[serve] using the PostgreSQL database from DATABASE_URL');
}

/** Locates the `next` CLI shipped with this app. */
function resolveNextBin() {
  const binDir = path.join(appDir, '..', '..', 'node_modules', '.bin');
  const candidates =
    process.platform === 'win32'
      ? [path.join(binDir, 'next.cmd'), path.join(binDir, 'next.exe'), path.join(binDir, 'next')]
      : [path.join(binDir, 'next')];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Fall back to resolving through PATH; `shell` below makes that work on Windows.
  return 'next';
}

const nextBin = resolveNextBin();

/**
 * `stdio: 'inherit'` so the server's own request log reaches this process's output and
 * can be tailed from wherever it was started.
 *
 * `shell: true` is required on Windows: Node refuses to `spawn` a `.cmd` shim directly
 * (it would otherwise be an argument-injection vector), and reports `spawn EINVAL`. The
 * arguments here are literals from this file, never user input.
 */
const child = spawn(nextBin, ['start', '--port', port], {
  cwd: appDir,
  env: childEnv,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('exit', (code) => process.exit(code ?? 0));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
