/**
 * Migration runner.
 *
 * Migrations are plain `.sql` files applied in lexical filename order, so the
 * same set runs locally (PGlite) and in production (Supabase / `psql -f`).
 *
 * The directory constant lives in `./migrations-dir` so the web app can reference
 * the location without bundling this file's `node:fs` imports.
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import type { PGlite } from '@electric-sql/pglite';

import {
  DEFAULT_MIGRATIONS_DIR,
  migrationDirCandidates,
  type MigrationExecutor,
} from './migrations-dir.ts';

export { DEFAULT_MIGRATIONS_DIR };
export type { MigrationExecutor };

/**
 * The migrations directory that actually exists, or a descriptive error.
 *
 * Resolved lazily and cached, because the correct answer depends on the working
 * directory of whichever process is running — the app, the test harness and the
 * `db:verify` script do not share one.
 */
let resolvedDir: string | null = null;

export function migrationsDir(): string {
  if (resolvedDir !== null) return resolvedDir;

  const candidates = [DEFAULT_MIGRATIONS_DIR, ...migrationDirCandidates()];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, '0001_extensions_and_helpers.sql'))) {
      resolvedDir = candidate;
      return candidate;
    }
  }

  throw new Error(
    `could not locate the NEXUS migrations (looked in: ${candidates.join(', ')}). ` +
      'Set NEXUS_MIGRATIONS_DIR to the directory holding the .sql files.',
  );
}

/** Migration filenames in the order they must be applied. */
export async function listMigrations(migrationsDirOverride?: string): Promise<string[]> {
  const dir = migrationsDirOverride ?? migrationsDir();
  const entries = await readdir(dir);
  return entries.filter((name) => name.endsWith('.sql')).sort((a, b) => a.localeCompare(b, 'en'));
}

/**
 * Applies every migration in `migrationsDir` to `db` and returns the list of
 * applied filenames. Each file is executed as a single batch, so a failing file
 * aborts that file (and every later one) and the error surfaces to the caller.
 */
export async function applyMigrations(
  db: PGlite | MigrationExecutor,
  migrationsDirOverride?: string,
): Promise<string[]> {
  const dir = migrationsDirOverride ?? migrationsDir();
  const files = await listMigrations(dir);
  const applied: string[] = [];

  for (const file of files) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    await db.exec(sql);
    applied.push(file);
  }

  return applied;
}

/** Reads the migration sources without executing them (used by parity tests). */
export async function readMigrations(
  migrationsDirOverride?: string,
): Promise<{ file: string; sql: string }[]> {
  const dir = migrationsDirOverride ?? migrationsDir();
  const files = await listMigrations(dir);
  return Promise.all(
    files.map(async (file) => ({ file, sql: await readFile(path.join(dir, file), 'utf8') })),
  );
}
