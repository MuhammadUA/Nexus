/**
 * Provisioning entry point for the V1.2 browser suite.
 *
 * **This runs as the first half of the `webServer` command, and that placement is the entire design.**
 *
 * The embedded PGlite database is a set of files, and it must not be created, seeded and then replaced
 * while anything else holds it open. Playwright starts `webServer` and calls `globalSetup` in the same
 * phase, with the server first, and the server's readiness probe (`GET /login`) is a real request that
 * opens the database. Provisioning from `globalSetup` therefore deleted and recreated the database *under*
 * a running server: the server kept answering from the file that had been removed, so the suite seeded an
 * administrator, reported success, and the sign-in was rejected as "Email or password is incorrect."
 *
 * Running here instead makes the order explicit and unfalsifiable:
 *
 *   1. this script creates and seeds the database, and exits;
 *   2. only then does `scripts/serve.mjs` start, and it opens the database this script just wrote.
 *
 * It is a CLI rather than a module Playwright loads for the same reason: `webServer.command` is the only
 * hook that is guaranteed to finish before the server process exists.
 *
 * Usage (the config supplies the environment): `node e2e/provision.mjs`
 */
import { ADMIN, BUSINESS, EMBEDDED_DATA_DIR, provisionDataDir, removeRunDir } from './harness.mjs';

const started = Date.now();

try {
  /**
   * A stale directory is removed rather than reused.
   *
   * `provisionDataDir` does this too, but doing it here as well means a crashed previous run can never
   * leave a partially-written database behind for the server to open — the failure mode this whole file
   * exists to prevent. It is also what makes two consecutive runs identical.
   */
  removeRunDir();

  const result = await provisionDataDir();

  // Printed rather than hidden behind a reporter line: a reader diagnosing a failing spec needs to know
  // which database it ran against and whether the seed actually landed.
  console.log(
    [
      '[e2e] provisioned the isolated web database',
      `  data dir     ${EMBEDDED_DATA_DIR}`,
      `  seed         ${String(result.businesses)} business(es), ${String(result.leads)} enrichment row(s)`,
      `  admin        ${ADMIN.email}`,
      `  fixture biz  ${BUSINESS.key} - ${BUSINESS.name}`,
      `  elapsed      ${String(Date.now() - started)}ms`,
    ].join('\n'),
  );
} catch (error) {
  // Exit non-zero so Playwright's webServer reports this instead of waiting for a URL that will never
  // answer. The message carries the command and the script's own output; `provisionDataDir` builds those.
  console.error(`[e2e] provisioning failed after ${String(Date.now() - started)}ms`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
