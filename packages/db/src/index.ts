/**
 * `@nexus/db` — package barrel.
 *
 * Deliberately FREE of `node:fs`: the web app imports this file, and a bundler
 * cannot resolve Node's `node:` scheme. The migration *runner* therefore lives
 * behind the `@nexus/db/migrate` subpath, which only the test harness and the
 * `db:verify` script use — both run in plain Node.
 *
 * The location helpers are safe to export here: the app needs to find the `.sql`
 * files without needing the runner that executes them.
 */
export {
  DEFAULT_MIGRATIONS_DIR,
  migrationDirCandidates,
  type MigrationExecutor,
} from './migrations-dir.js';
export { createDb, num, one, str, type Db, type QueryResult, type Row } from './client.js';
