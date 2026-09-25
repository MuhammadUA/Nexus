/**
 * Absolute location of the SQL migration set.
 *
 * Two anchors, tried in order:
 *
 *  1. `NEXUS_MIGRATIONS_DIR`, when set explicitly (containers, CI).
 *  2. The monorepo layout relative to the process working directory.
 *
 * Neither uses `import.meta.url` on purpose: this module is imported by the web
 * app, which then transpiles it, and a bundler rewrites module URLs in ways that
 * do not describe the on-disk layout. Resolving from the working directory keeps
 * the answer correct under both plain Node and a bundler, and the explicit
 * override covers deployments where the app is not run from the repo root.
 *
 * This file must stay free of `node:fs` so a bundler can follow it.
 */
import path from 'node:path';

const MONOREPO_RELATIVE = ['packages', 'db', 'migrations'];

function fromEnvironment(): string | null {
  const configured = process.env.NEXUS_MIGRATIONS_DIR ?? '';
  return configured.trim().length === 0 ? null : configured.trim();
}

/**
 * `packages/db/migrations`, resolved for the monorepo layout.
 *
 * `process.cwd()` is `apps/web` when Next.js runs, so we step up to the workspace
 * root and back down.
 */
export const DEFAULT_MIGRATIONS_DIR: string = (() => {
  const override = fromEnvironment();
  if (override !== null) return override;

  const cwd = process.cwd();
  // apps/web -> repo root; a build run from the root needs no adjustment.
  const repoRoot = cwd.endsWith(path.join('apps', 'web')) ? path.resolve(cwd, '..', '..') : cwd;
  return path.join(repoRoot, ...MONOREPO_RELATIVE);
})();

/** Candidate directories to probe when the default does not exist. */
export function migrationDirCandidates(): readonly string[] {
  const cwd = process.cwd();
  const candidates = new Set<string>([DEFAULT_MIGRATIONS_DIR]);
  // Walk up a few levels; covers `apps/web`, the repo root, and a nested build dir.
  let current = cwd;
  for (let depth = 0; depth < 4; depth += 1) {
    candidates.add(path.join(current, ...MONOREPO_RELATIVE));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...candidates];
}

/** Minimal surface a migration applier needs; satisfied by PGlite and wrappers. */
export interface MigrationExecutor {
  exec(sql: string): Promise<unknown>;
}
