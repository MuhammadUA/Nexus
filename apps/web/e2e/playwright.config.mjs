/**
 * Playwright configuration for the Nexus web app V1.2 browser suite.
 *
 * Three decisions are load-bearing, and each exists because the alternative produces a false
 * result:
 *
 *   * **Port 3100, never 3000.** A developer almost always has `next dev` on 3000, and the
 *     Companion extension suite already targets a Nexus on 3000. Sharing either origin would make
 *     this suite's pass/fail depend on whatever that other server happens to be serving, and it
 *     would let this suite's destructive steps touch a developer's data.
 *   * **A temporary `NEXUS_DATA_DIR`, never `apps/web/.data`.** The production start helper uses the
 *     embedded PGlite database rooted at `NEXUS_DATA_DIR`; pointing it at a directory inside the OS
 *     temp dir means the suite can create and delete accounts, businesses and leads without ever
 *     opening the database a person is working in. `e2e/provision.mjs` creates it and `globalTeardown`
 *     removes it.
 *   * **`reuseExistingServer: false`.** A server that was already listening on 3100 would be one
 *     this config did not start, so it would not carry the environment below — and the suite would
 *     silently test the wrong database.
 *
 * **A fresh checkout needs `pnpm run build` first.** This config assumes `.next` already exists: the
 * release gate builds and then runs the suite, so building inside the harness would double the runtime
 * and would still leave the failure ("no production build") discovered late and reported vaguely.
 * `e2e/provision.mjs` refuses immediately and says so when `.next` is missing, which is the honest
 * failure.
 *
 * **The database is provisioned by the first half of the `webServer` command, not by `globalSetup`.**
 * `e2e/provision.mjs` explains why: Playwright starts the server and calls `globalSetup` in the same
 * phase with the server first, and the server's readiness probe opens the database — so a `globalSetup`
 * that created the database would be recreating it underneath a live connection, and the sign-in would
 * be refused against a file that had already been deleted.
 *
 * The same reasoning is why **this config performs no filesystem work of its own**: see the note below.
 *
 * No AI provider key is set anywhere here. The suite asserts the *unconfigured* behaviour, and a real
 * model call would make the result depend on a third party and could cost money.
 */
import { defineConfig } from 'playwright/test';

import { ARTIFACTS_DIR, e2eDataDirEnv, webOrigin } from './harness.mjs';

/**
 * The config deliberately performs **no filesystem work**.
 *
 * That is a correctness rule, not tidiness. The embedded database is a directory of files, and deleting
 * or recreating it while a `PGlite` instance holds it open corrupts the instance: it aborts with
 * `RuntimeError: Aborted()` from inside the WASM engine, which surfaces as "the webServer did not start"
 * and points at the server rather than at the directory. An earlier version of this file cleaned the run
 * directory here, at config-load time, and every run after the first could therefore abort.
 *
 * `e2e/provision.mjs` - run as the first half of `webServer.command`, before any server process exists -
 * owns the whole lifecycle instead: it removes the previous run's directory, creates it, migrates it and
 * seeds it. Doing it in that order is the only ordering in which nothing else can be holding the database.
 */

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.mjs',

  /**
   * One worker at a time.
   *
   * The suite signs in as a single administrator and shares one embedded database and one server
   * process. Parallel workers would interleave writes into that one database and would race on the
   * same session cookie, which turns "which spec destabilised this" into guesswork.
   */
  workers: 1,
  fullyParallel: false,

  /**
   * Generous, because the first request to a cold production server compiles route handlers on
   * demand and the embedded database engine starts then too. Later tests in the run are far faster;
   * this number is the cold-start budget, not the expected time.
   */
  timeout: 120_000,
  expect: { timeout: 15_000 },

  // The house reporter. `list` keeps every spec, every assertion failure and the full stack in one
  // readable stream, which is what a release gate needs; HTML report artefacts are not required here.
  reporter: [['list']],

  /**
   * Removes the run's temporary directory after the tests, so the database this suite created does not
   * outlive it. Provisioning itself happens inside `webServer.command` — see `e2e/provision.mjs`.
   */
  globalTeardown: './global-teardown.mjs',

  use: {
    baseURL: webOrigin(),
    // The admin surfaces are desktop-first at 1440x980 (docs/V1_2_UI_ACCEPTANCE.md §0); a narrower
    // viewport would reflow the secondary tab strip and the lead table and test a layout nobody ships.
    viewport: { width: 1440, height: 980 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The suite drives a local production server over plain HTTP on loopback; there is no TLS to
    // ignore and no proxy to bypass.
    ignoreHTTPSErrors: false,
  },

  webServer: {
    /**
     * Provision the isolated database, then start the production server the deployment uses.
     *
     * Two commands, in this order, and the order is the point. `e2e/provision.mjs` creates and seeds the
     * embedded database and exits; `scripts/serve.mjs` then opens exactly that database. Splitting them
     * the other way round — provisioning from `globalSetup` while the server is already up — left the
     * server reading a database file the provisioner had replaced, which surfaced as a rejected password.
     *
     * `serve.mjs` is used rather than `next start` directly because it is what decides the
     * embedded-database branch and what would otherwise persist `NEXUS_SESSION_SECRET`; running it means
     * the suite exercises the same start path a deployment does. It is spawned from the app directory so
     * `next start` resolves this app's build.
     *
     * `node` is resolved through the environment's `PATH`, which Playwright runs the command with.
     */
    command: 'node e2e/provision.mjs && node scripts/serve.mjs',
    cwd: '..',
    url: `${webOrigin()}/login`,
    reuseExistingServer: false,
    // Generous: provisioning writes a fresh database (migrations plus seed) and the server then compiles
    // its first route on demand. This is the cold-start budget, not the expected time.
    timeout: 240_000,
    // Piped rather than ignored, so a provisioner or server that refuses to start prints *why* into the
    // test output instead of leaving a bare "Timed out waiting for http://localhost:3100/login".
    stdout: 'pipe',
    stderr: 'pipe',
    env: e2eDataDirEnv({
      PORT: '3100',
      NODE_ENV: 'production',
      // The local email/password path. Without it `/api/auth/login` refuses and there is no way in.
      NEXUS_LOCAL_AUTH: '1',
      // The embedded engine is single-process by design; this flag is what permits it under
      // `next start`. See docs/DEPLOYMENT.md §4.
      NEXUS_ALLOW_EMBEDDED_IN_PRODUCTION: '1',
      /**
       * Fixed, not generated.
       *
       * `serve.mjs` would otherwise persist a generated secret into `apps/web/.env.local`, which is
       * the developer's file and not ours to write. A fixed value also keeps the session cookie valid
       * across the run and across two consecutive runs.
       */
      NEXUS_SESSION_SECRET: 'nexus-web-e2e-fixed-session-secret-000000000001',
      // Explicit, though the ambient environment of a clean checkout has neither. If a developer has
      // exported one, the suite must not quietly connect to it.
      DATABASE_URL: '',
      SUPABASE_DB_URL: '',
      // Never set: an extract attempt in the enrichment spec must return the typed
      // `provider_not_configured` refusal, and no request may leave this machine.
      DEEPSEEK_API_KEY: '',
    }),
  },

  // Traces and failure screenshots land in the run's own temporary directory, never in the repository.
  outputDir: ARTIFACTS_DIR,
});
