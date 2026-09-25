/**
 * Embedded-database support: reading and applying the SQL migration set from disk.
 *
 * Separated from `db.ts` on purpose. `db.ts` is reachable from the web app's
 * server bundle, and a bundler cannot resolve Node's `node:` scheme — so this
 * module, which is the only place that touches `node:fs`, is loaded lazily and
 * exclusively on the embedded-database branch. Nothing imports it eagerly.
 */
import 'server-only';

import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_MIGRATIONS_DIR,
  migrationDirCandidates,
  type MigrationExecutor,
} from '@nexus/db';

export type { MigrationExecutor };

/**
 * Directory holding the embedded database files.
 *
 * Overridable so tests and CI can isolate a run without deleting a developer's
 * local data.
 */
export function embeddedDataDir(): string {
  const configured = process.env.NEXUS_DATA_DIR ?? '';
  if (configured.trim().length > 0) return configured.trim();
  return path.join(process.cwd(), '.data');
}

export function prepareEmbeddedDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * The migrations directory that actually exists.
 *
 * Walks the candidates from `@nexus/db` rather than trusting one derived path,
 * because the working directory differs between `next dev`, `next build` and the
 * test runner.
 */
export function resolveMigrationsDir(): string {
  const candidates = [DEFAULT_MIGRATIONS_DIR, ...migrationDirCandidates()];

  for (const candidate of candidates) {
    try {
      const entries = readdirSync(candidate);
      if (entries.some((name) => name.endsWith('.sql'))) return candidate;
    } catch {
      // Not a directory we can read; try the next candidate.
    }
  }

  throw new Error(
    `could not locate the NEXUS migrations (looked in: ${candidates.join(', ')}). ` +
      'Set NEXUS_MIGRATIONS_DIR to the directory holding the .sql files.',
  );
}

/**
 * Applies every migration in lexical order.
 *
 * A failure surfaces to the caller rather than being swallowed: an embedded
 * database missing its schema is a broken deployment, and starting anyway would
 * serve errors from every request.
 */
export async function applyMigrationFiles(executor: MigrationExecutor): Promise<string[]> {
  const dir = resolveMigrationsDir();

  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));

  if (files.length === 0) {
    throw new Error(`no .sql migrations found in ${dir}`);
  }

  for (const file of files) {
    await executor.exec(readFileSync(path.join(dir, file), 'utf8'));
  }

  return files;
}
