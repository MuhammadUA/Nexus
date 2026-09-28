/**
 * Harness for the Nexus web app V1.2 browser suite.
 *
 * Everything the config, the global setup and the specs must agree on lives here, exactly once, so
 * the suite cannot end up signing in against one database while the server reads another:
 *
 *   * `EMBEDDED_DATA_DIR` — the isolated database root this run owns, under the OS temp dir.
 *   * `e2eDataDirEnv` — the environment that points the server at that root, with any ambient
 *     connection string removed.
 *   * `provisionDataDir` — creates the first administrator with the project's own bootstrap script,
 *     applies the production migration set and seeds the documented fixture graph.
 *   * `signIn` / `openScreen` — the real `/login` form and the real routes.
 *   * `collectConsole` / `describeConsole` — the house rule that a console error is a failure.
 *
 * Two things are deliberately NOT here: no API key of any kind, and no direct AI call. The suite
 * asserts the unconfigured-deployment behaviour, which is the state every fresh checkout is in.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

// `playwright/test` rather than `@playwright/test`: this app does not declare the latter, and Node's
// resolver finds the root `playwright` package from here. `playwright/test` re-exports the same runner
// the extension suite imports from `@playwright/test`, so the config shape and the reporters match.
import { expect, test } from 'playwright/test';

/**
 * The app this suite drives, resolved from this file rather than from the working directory.
 *
 * Playwright is invoked from `apps/web` (`pnpm --filter @nexus/web run e2e`), but a developer may also
 * run it from the repository root. Deriving every path here means both invocations address the same
 * app, the same build and the same fixture graph.
 */
export const E2E_DIR = import.meta.dirname;
export const APP_DIR = path.resolve(E2E_DIR, '..');
export const REPO_DIR = path.resolve(E2E_DIR, '..', '..', '..');

/**
 * The production migration set.
 *
 * Passed to the bootstrap script as `NEXUS_MIGRATIONS_DIR` because that script runs with the isolated
 * run directory as its working directory, and `@nexus/db/migrate` otherwise looks for the `.sql` files
 * relative to the working directory.
 */
export const MIGRATIONS_DIR = path.join(REPO_DIR, 'packages', 'db', 'migrations');

/** The dedicated port. Never 3000: a developer's `next dev` lives there, and so does the extension suite. */
export const PORT = 3100;

/**
 * `http://localhost:3100`.
 *
 * `localhost`, not `127.0.0.1`, and that is not cosmetic: the app runs with `NODE_ENV=production` (it has
 * to — `serve.mjs` sets it), so `sessionCookieOptions` marks the session cookie `Secure`. Chromium treats
 * `localhost` as a trustworthy origin and therefore accepts and returns a `Secure` cookie over plain HTTP,
 * while a literal IP address is not a trustworthy origin and the cookie is silently dropped. With
 * `127.0.0.1` the sign-in POST succeeds, sets the cookie, and every subsequent request is anonymous —
 * which presents as `waitForURL` timing out on the login screen.
 */
export function webOrigin() {
  return `http://localhost:${String(PORT)}`;
}

/**
 * The isolated directories for this run.
 *
 * Named rather than `mkdtemp`-generated on purpose: the config computes them at load time, `globalSetup`
 * must provision exactly these, and the server is handed the same paths. One name per role, all removed
 * by `globalTeardown`.
 *
 *   * `RUN_DIR`           - the run's root, under the OS temp dir.
 *   * `BOOTSTRAP_CWD`     - what `scripts/bootstrap-admin.ts` runs from. It resolves its database as
 *                           `<cwd>/.data`, and it does not read `NEXUS_DATA_DIR`, so this is the only way
 *                           to pin where the first administrator is written.
 *   * `EMBEDDED_DATA_DIR` - what the server is handed as `NEXUS_DATA_DIR`, i.e. the directory *containing*
 *                           the `nexus` database the app opens. It is the `.data` directory the script
 *                           above created, so the account it wrote is the account the server authenticates.
 *   * `ARTIFACTS_DIR`     - traces and failure screenshots.
 */
export const RUN_DIR = path.join(tmpdir(), 'nexus-web-e2e');
export const BOOTSTRAP_CWD = path.join(RUN_DIR, 'bootstrap');
export const EMBEDDED_DATA_DIR = path.join(BOOTSTRAP_CWD, '.data');
export const ARTIFACTS_DIR = path.join(RUN_DIR, 'artifacts');

/** The database directory inside `EMBEDDED_DATA_DIR`; the layout the app's embedded driver creates. */
export const DATABASE_DIR = path.join(EMBEDDED_DATA_DIR, 'nexus');

/** A marker written only after the bootstrap and the seed succeed, so a half-provisioned run is never reused. */
export const PROVISIONED_MARKER = path.join(RUN_DIR, 'provisioned.json');

/**
 * The administrator the suite signs in as.
 *
 * Created by `scripts/bootstrap-admin.ts` at provisioning time, so the credential is whatever that
 * script and the login route agree on. The account is deliberately *not* one of the seed fixture users:
 * the fixture graph is inserted directly as the table owner and carries no password, and giving a fixture
 * row one here would mean this suite writing credentials the application never created.
 *
 * The password is a fixed literal, comfortably over the 12-character policy. This account exists only
 * inside a temporary directory that is deleted when the run ends, and a generated password would make a
 * failed sign-in unreproducible.
 */
export const ADMIN = Object.freeze({
  email: 'admin@nexus.e2e',
  password: 'nexus-e2e-admin-password',
  fullName: 'Nexus E2E Admin',
});

/**
 * The restricted operator, and what they are restricted to.
 *
 * The route crawl needs both halves of the authorization story: an administrator who may open
 * everything, and an operator who may not. This account holds the `user` share of the fixture
 * business — a granted business with the default user permissions and no capability booleans — so
 * the crawl can assert that the admin screens are not offered in their navigation *and* that typing
 * one of those URLs still fails closed.
 *
 * Created by `scripts/create-test-user.ts`, which uses the application's own password KDF.
 */
export const RESTRICTED = Object.freeze({
  email: 'restricted@nexus.e2e',
  password: 'nexus-e2e-restricted-password',
  fullName: 'Nexus E2E Restricted',
  role: 'user',
});

/** The business every business-scoped screen is opened for. `DEMO_BUSINESSES[0]` from `@nexus/db/seed`. */
export const BUSINESS = Object.freeze({
  id: 'a0000000-0000-4000-8000-000000000001',
  key: 'zemnas',
  name: 'Zemnas Creative Studio',
});

/** A seeded lead that is deliberately incomplete (`needs_profile`), with no LinkedIn URL committed. */
export const INCOMPLETE_LEAD = Object.freeze({
  id: '13000000-0000-4000-8000-000000000007',
  personName: 'Lisa Weber',
  companyName: 'Frame House',
});

/**
 * The server environment for the isolated run.
 *
 * Exported as a function so the caller supplies only what it means to add; the four variables that
 * decide *which database is opened* are set here and cannot be forgotten at a call site.
 * `DATABASE_URL` and `SUPABASE_DB_URL` are put back to empty strings rather than left absent, because
 * `serve.mjs` reads them and an ambient value exported in a developer's shell would otherwise point
 * the suite at a live database.
 */
export function e2eDataDirEnv(extra = {}) {
  return { ...extra, NEXUS_DATA_DIR: EMBEDDED_DATA_DIR, DATABASE_URL: '', SUPABASE_DB_URL: '' };
}

/**
 * Creates the isolated database: first administrator, schema, fixture graph. Idempotent.
 *
 * Order matters and is the whole point of the function:
 *
 *   1. remove any previous run's directory, so the state is identical on the first and the second
 *      consecutive invocation;
 *   2. run `scripts/bootstrap-admin.ts` against that directory — the project's own first-admin path, which
 *      also brings the schema to the current migration set with the application's own runner, so triggers,
 *      RLS and the SECURITY DEFINER functions are exactly the ones production runs;
 *   3. execute the documented fixture SQL as the table owner (the same way a Supabase service-role seed
 *      does), which is what gives the specs a business, leads and channel accounts to navigate;
 *   4. prove the administrator is signable through `authenticate_user`, the same function the login route
 *      calls, so a provisioning mistake fails here rather than as a generic sign-in error;
 *   5. write the marker last, so a crash mid-provision leaves a directory that will be discarded.
 */
export async function provisionDataDir() {
  if (!existsSync(path.join(APP_DIR, '.next'))) {
    throw new Error(
      `no production build at ${path.join(APP_DIR, '.next')}.\n` +
        'The V1.2 browser suite runs against `next start`, so build first:\n' +
        '  pnpm --filter @nexus/web run build\n' +
        '  pnpm --filter @nexus/web run e2e',
    );
  }

  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  mkdirSync(EMBEDDED_DATA_DIR, { recursive: true });

  /**
   * 1. The first administrator, created by the project's own documented script.
   *
   * `scripts/bootstrap-admin.ts` is called as a separate process rather than its logic being copied here.
   * That is the whole point: the credential format lives in exactly one place (`src/lib/password.ts`, used
   * by the script and by the login route), so a change to the KDF or the stored layout cannot leave this
   * suite seeding credentials the server refuses to verify. The script is idempotent and applies every
   * migration itself, so it also brings the database to the current schema.
   *
   * It is spawned through `process.execPath` with the same `--experimental-strip-types` flag its own
   * `package.json` script uses, and with `cwd` set so its `.data` lands inside the isolated run directory.
   * `NEXUS_DATA_DIR` is not read by the script, which is why `cwd` - not the variable - is what pins it.
   */
  const bootstrap = await runBootstrapAdmin();
  if (!bootstrap.ok) {
    throw new Error(
      'provisioning failed: scripts/bootstrap-admin.ts did not create the first administrator.\n' +
        `  command  ${bootstrap.command}\n` +
        `  exit     ${String(bootstrap.code)}\n` +
        `  stdout   ${bootstrap.stdout.trim()}\n` +
        `  stderr   ${bootstrap.stderr.trim()}`,
    );
  }

  /**
   * 1b. The restricted operator, created through the application's own credential path.
   *
   * A separate process for the same reason as the administrator: the password format lives in
   * `src/lib/scrypt-kdf.ts` and is not re-implemented here.
   *
   * It runs **before** this process opens the database below. The embedded engine is a single-writer
   * database: opening the same directory from a second process while this one holds it lets the
   * child succeed against its own view while its writes never reach the file the server reads —
   * which is exactly how the account appeared "created" and then was missing from `public.users`.
   */
  const restricted = await runCreateTestUser();
  if (!restricted.ok) {
    throw new Error(
      'provisioning failed: scripts/create-test-user.ts did not create the restricted operator.\n' +
        `  command  ${restricted.command}\n` +
        `  exit     ${String(restricted.code)}\n` +
        `  stdout   ${restricted.stdout.trim()}\n` +
        `  stderr   ${restricted.stderr.trim()}`,
    );
  }

  // Imported lazily so a resolution problem names the module it could not load rather than failing the
  // whole config with a bare specifier error.
  const { PGlite } = await import('@electric-sql/pglite');
  const { FIXTURE_SQL } = await import('@nexus/db/seed');

  const db = await PGlite.create({ dataDir: DATABASE_DIR });
  try {
    /**
     * 2. The documented fixture graph, as the table owner with row security off - exactly the way a
     * Supabase service-role seed does it. It is what gives the specs a business, leads, companies, ICPs
     * and channel accounts to navigate; its own user rows are unused by this suite, and the accounts here
     * and there have separate ids on purpose (see `ADMIN`).
     */
    await db.exec('set row_security = off');
    await db.exec(FIXTURE_SQL);

    /**
     * 2b. Give the restricted operator a `user`-level grant on the fixture business — and give the
     * administrator none.
     *
     * That asymmetry is the point of this provisioning. A production administrator has an account
     * and no `user_business_access` rows at all; their reach comes from the role, and the per-business
     * table records *delegated* access for everyone else. Seeding the administrator a grant (which
     * this suite used to do, as a workaround) hid a real defect: every business-scoped screen derived
     * its permission set from the grant table alone, so an administrator with no grant got
     * `notFound()` on Business Setup, ICPs, Agent Jobs and Insights.
     *
     * The condition is asserted below rather than assumed, so the crawl cannot silently start
     * passing because someone re-added the workaround.
     */
    const granted = await db.query(
      `insert into public.user_business_access
         (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources,
          can_use_profile_queue, can_delete_leads)
       select u.id, $2, 'user', false, false, false, false
         from public.users u
        where lower(u.email) = lower($1)
       on conflict (user_id, business_id) do update
         set access_level = excluded.access_level,
             can_manage_leads = excluded.can_manage_leads,
             can_use_lead_sources = excluded.can_use_lead_sources,
             can_use_profile_queue = excluded.can_use_profile_queue,
             can_delete_leads = excluded.can_delete_leads
       returning user_id`,
      [RESTRICTED.email, BUSINESS.id],
    );
    if (granted.rows.length === 0) {
      throw new Error(
        `the restricted operator ${RESTRICTED.email} could not be granted access to ${BUSINESS.key}; ` +
          'the account is missing from public.users',
      );
    }

    const adminGrants = await db.query(
      `select count(*)::int as n
         from public.user_business_access a
         join public.users u on u.id = a.user_id
        where lower(u.email) = lower($1)`,
      [ADMIN.email],
    );
    if (Number(adminGrants.rows[0]?.n ?? 0) !== 0) {
      throw new Error(
        `the administrator ${ADMIN.email} has a user_business_access row. The suite must run as a ` +
          'grantless administrator, which is the production condition the route guards are written for.',
      );
    }

    /**
     * 3. Assert the administrator is actually signable, through the same function the login route calls.
     *
     * `authenticate_user` is the join the local sign-in path uses, and it returns nothing for a missing
     * credential, a soft-deleted user or a disabled account. Checking it here means a provisioning mistake
     * fails with that sentence instead of surfacing as the deliberately generic "Email or password is
     * incorrect." on the login form, which would send a reader looking in entirely the wrong place.
     */
    const credential = await db.query(
      `select password_hash, role, status from public.authenticate_user($1)`,
      [ADMIN.email],
    );
    const account = credential.rows[0];
    if (account === undefined) {
      throw new Error(
        `the bootstrap administrator ${ADMIN.email} has no usable credential after provisioning`,
      );
    }
    // The format itself is never re-implemented here; its algorithm marker is asserted so that a change to
    // the stored layout is caught at provisioning rather than at sign-in.
    if (!String(account.password_hash).startsWith('scrypt$')) {
      throw new Error(
        `the stored credential for ${ADMIN.email} is not in the format the login route verifies: ` +
          `it begins "${String(account.password_hash).slice(0, 42)}"`,
      );
    }
    if (account.role !== 'admin') {
      throw new Error(`the bootstrap administrator has role ${String(account.role)}, not admin`);
    }

    const businesses = await db.query(`select count(*)::int as n from public.businesses`);
    const leads = await db.query(`select count(*)::int as n from public.lead_enrichment`);

    writeFileSync(
      PROVISIONED_MARKER,
      JSON.stringify(
        {
          provisionedAt: new Date().toISOString(),
          dataDir: EMBEDDED_DATA_DIR,
          businesses: businesses.rows[0]?.n ?? 0,
          leads: leads.rows[0]?.n ?? 0,
          admin: ADMIN.email,
        },
        null,
        2,
      ),
      'utf8',
    );

    return {
      businesses: Number(businesses.rows[0]?.n ?? 0),
      leads: Number(leads.rows[0]?.n ?? 0),
    };
  } finally {
    await db.close();
  }
}

/**
 * Runs `scripts/bootstrap-admin.ts` against the isolated data directory.
 *
 * The flags are the script's documented positional interface and its own `package.json` uses the same
 * `--experimental-strip-types` flag; `cwd` is the run directory, because the script resolves its `.data`
 * root from the working directory (it does not read `NEXUS_DATA_DIR`). `NEXUS_DATA_DIR` is still exported
 * for the server, and `e2eDataDirEnv` is what guarantees the two agree.
 *
 * Returns the exit code and both streams so a failure can be reported with the command that failed and
 * what it printed, rather than as a bare throw.
 */
async function runBootstrapAdmin() {
  const script = path.join(APP_DIR, 'scripts', 'bootstrap-admin.ts');
  const args = ['--experimental-strip-types', script, ADMIN.email, ADMIN.password, ADMIN.fullName];
  const command = [process.execPath, ...args].join(' ');

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      /**
       * `cwd` is the isolated run directory, not the app directory, and that is load-bearing.
       *
       * `scripts/bootstrap-admin.ts` resolves its embedded database as `<cwd>/.data` and does not read
       * `NEXUS_DATA_DIR`, so pointing the working directory at this run's own directory is what keeps the
       * administrator it creates out of a developer's `apps/web/.data`. The script itself is addressed by
       * absolute path for the same reason.
       */
      cwd: BOOTSTRAP_CWD,
      env: {
        ...process.env,
        // The script refuses to run when an external connection string is set, and this suite must never
        // touch a live database.
        DATABASE_URL: '',
        SUPABASE_DB_URL: '',
        /**
         * The migration set has to be addressed absolutely.
         *
         * `@nexus/db/migrate` resolves the `.sql` files relative to the *working directory* by default, and
         * the working directory here is the isolated run directory (which the script needs, so its `.data`
         * lands inside it). Without this the migration runner reports that it cannot find the migrations..
         */
        NEXUS_MIGRATIONS_DIR: MIGRATIONS_DIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n${error.message}`, command });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, code, stdout, stderr, command });
    });
  });
}

/**
 * Runs `scripts/create-test-user.ts` against the isolated data directory.
 *
 * Same shape as `runBootstrapAdmin` and for the same reasons: the credential format lives in the
 * application, and `cwd` is what pins the embedded database the script opens.
 */
async function runCreateTestUser() {
  const script = path.join(APP_DIR, 'scripts', 'create-test-user.ts');
  const args = [
    '--experimental-strip-types',
    script,
    RESTRICTED.email,
    RESTRICTED.password,
    RESTRICTED.fullName,
    RESTRICTED.role,
  ];
  const command = [process.execPath, ...args].join(' ');

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: BOOTSTRAP_CWD,
      env: {
        ...process.env,
        DATABASE_URL: '',
        SUPABASE_DB_URL: '',
        NEXUS_MIGRATIONS_DIR: MIGRATIONS_DIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n${error.message}`, command });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, code, stdout, stderr, command });
    });
  });
}

/** Removes everything this run created. Safe to call twice. */
export function removeRunDir() {
  rmSync(RUN_DIR, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ browser -- */

/**
 * Signs in through the real `/login` form.
 *
 * The suite never injects a session cookie. The sign-in form is a plain HTML POST to
 * `/api/auth/login` (not a server action), so driving the real inputs and the real submit button is
 * both possible and the only way the session-establishing code path is exercised.
 *
 * Landing is asserted rather than assumed: `/login` redirects an authenticated viewer to `/my-day`,
 * so waiting for the login form to disappear and the shell to appear is the actual success signal.
 */
export async function signIn(page, credentials = ADMIN) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });

  // An already-authenticated context (a second call in the same spec) has no form; `/login` would
  // have redirected. That is a success, not a missing form.
  if (new URL(page.url()).pathname !== '/login') return;

  await page.waitForSelector('#email', { timeout: 30_000 });

  /**
   * Let hydration finish before touching the form.
   *
   * `/login` is a server component that renders a client form, so between the HTML arriving and React
   * attaching its handlers there is a window in which a click is a DOM event on a subtree React is about
   * to replace. Waiting for the network to go quiet is the observable proxy for "the client bundle has
   * loaded and run"; it is not a sleep, and it is what makes the click below land on the hydrated tree.
   */
  await page.waitForLoadState('networkidle');

  await page.fill('#email', credentials.email);
  await page.fill('#password', credentials.password);

  // Read the values back before submitting. A form that was filled and then silently emptied (a
  // hydration pass overwriting the input, or a password manager clearing it) submits an empty field and
  // the server answers with its deliberately generic failure, which points nowhere.
  const typed = await page.evaluate(() => ({
    email: document.querySelector('#email')?.value ?? '',
    passwordLength: (document.querySelector('#password')?.value ?? '').length,
  }));
  if (typed.email !== credentials.email || typed.passwordLength !== credentials.password.length) {
    throw new Error(
      `the sign-in form did not hold what was typed: email=${JSON.stringify(typed.email)} ` +
        `password length=${String(typed.passwordLength)} (expected ${String(credentials.password.length)})`,
    );
  }

  // Observe the submission's own response. A rejected password and a request that never reached the
  // handler both leave the browser on `/login`, and only the status distinguishes them.
  let authResponse = null;
  const requests = [];
  const onRequest = (request) => {
    requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
  };
  const onResponse = (response) => {
    if (response.request().method() === 'POST' && response.url().includes('/api/auth/login')) {
      authResponse = { status: response.status(), location: response.headers()['location'] ?? null };
    }
  };
  page.on('request', onRequest);
  page.on('response', onResponse);

  await page.click('button[type="submit"]');

  // Wait for either outcome, and report what the form still holds afterwards. A submission that never
  // happened and a submission the server rejected both leave the browser on `/login`; only the second
  // clears the password input, so reading the fields afterwards separates them.
  const left = await page
    .waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 })
    .then(() => true)
    .catch(() => false);

  page.off('request', onRequest);
  page.off('response', onResponse);

  if (!left) {
    // Report what the POST actually did, not only where the browser ended up. "Did not leave /login" on
    // its own cannot distinguish a rejected password from a request that never reached the handler.
    const after = await page
      .evaluate(() => {
        const button = document.querySelector('button[type="submit"]');
        const box = button?.getBoundingClientRect();
        return {
          url: location.href,
          email: document.querySelector('#email')?.value ?? null,
          passwordLength: (document.querySelector('#password')?.value ?? '').length,
          buttonBox: box === undefined ? null : { x: box.x, y: box.y, w: box.width, h: box.height },
          topElementAtButton:
            box === undefined
              ? null
              : (() => {
                  const el = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                  return el === null ? null : `${el.tagName}.${el.className}`;
                })(),
          alerts: [...document.querySelectorAll('[role="alert"], .nx-error')].map((el) =>
            (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
          ),
        };
      })
      .catch(() => null);
    throw new Error(
      `sign-in did not leave /login. The app answered ${JSON.stringify(page.url())}.\n` +
        `Before submitting: email=${JSON.stringify(typed.email)}, password length=${String(typed.passwordLength)}.\n` +
        `After submitting:  ${JSON.stringify(after)}\n` +
        `POST /api/auth/login responded: ${JSON.stringify(authResponse)}\n` +
        `Requests seen: ${JSON.stringify(requests)}\n` +
        `The administrator ${credentials.email} was created by scripts/bootstrap-admin.ts at provisioning time.`,
    );
  }
}

/**
 * Opens a business-scoped screen and returns nothing, so a caller reads the page rather than a helper's
 * opinion of it.
 *
 * `waitUntil: 'domcontentloaded'` and no marker here on purpose: each spec asserts its own stable
 * marker, and a shared marker would hide a screen that rendered the shell but not its content.
 */
export async function openBusinessScreen(page, path) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
}

/** The concatenated whitespace-normalised text of the document body. */
export async function bodyText(page) {
  return page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim());
}

/** Every visible label of every button, link, tab and summary, trimmed and in document order. */
export async function controlLabels(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('a, button, [role="tab"], summary')].map((el) =>
      (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
    ),
  );
}

/* ------------------------------------------------------------------ console -- */

/**
 * Console noise the suite ignores, and why each entry is safe to ignore.
 *
 * Kept deliberately tiny. A React key warning, a hydration mismatch or an unhandled rejection is a
 * real defect and must fail the spec - so nothing here suppresses a JavaScript error, only requests
 * this environment cannot satisfy.
 */
const IGNORED_CONSOLE = [
  // Chromium requests `/favicon.ico` itself. The app serves no icon file, so the browser logs a bare
  // 404 that no application code produced.
  /favicon\.ico/i,
  // Chrome DevTools probes this endpoint when a debugging client is attached; the app does not
  // implement it and the browser logs the 404.
  /\/\.well-known\/appspecific\/com\.chrome\.devtools/i,
];

/**
 * Subscribes to a page's console and uncaught errors, appending into a caller-owned array.
 *
 * Mirrors `apps/extension/e2e/harness.mjs`: a console error or warning is a failure in its own right,
 * so every spec asserts the returned list is empty instead of letting a React warning sit unnoticed in
 * the output.
 *
 * The sink is owned by the caller rather than created here because the shared-page lifecycle below
 * needs one long-lived array that is emptied between tests, while a single-navigation probe wants a
 * fresh one. `collectConsole` is the thin wrapper for the second case.
 */
export function collectConsoleInto(sink, page) {
  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    const text = message.text();
    if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return;
    sink.push({ type: message.type(), text });
  });
  page.on('pageerror', (error) => sink.push({ type: 'pageerror', text: error.message }));
  return sink;
}

/** `collectConsoleInto` with an array of its own, for a page a spec creates and disposes itself. */
export function collectConsole(page) {
  return collectConsoleInto([], page);
}

/** Renders collected console messages into an assertion-friendly string. */
export function describeConsole(messages) {
  return messages
    .map((message) => `${message.type}: ${message.text}`)
    .join('\n  ');
}

/* -------------------------------------------------------------------- probes -- */

/** The labels of the design system's stat cards (`.nx-stat__label`), in document order. */
export async function statLabels(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.nx-stat__label')].map((el) =>
      (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
    ),
  );
}

/** Every `<th>` text on the page, in document order. */
export async function tableHeaders(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('th')].map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()),
  );
}

/**
 * `{ label, href }` for every link on the page.
 *
 * Both halves are returned so a spec can assert the *pair*: a link whose visible label is "Find
 * LinkedIn" but whose href points somewhere else is exactly the defect worth catching.
 */
export async function links(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('a[href]')].map((el) => ({
      label: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
      href: el.getAttribute('href') ?? '',
    })),
  );
}

/** The page's own rendered HTML, which is what "does the DOM contain this string" must be asked about.
 *
 * `page.content()` is the serialised DOM *after* hydration, so it catches text a client component
 * rendered as well as text the server sent. `innerText` would miss anything inside a closed
 * `<details>` or a visually hidden element, and a leaked key or a re-displayed raw paste inside either
 * of those is still a leak.
 */
export async function pageHtml(page) {
  return page.content();
}

/** The current value of every non-hidden text input and textarea, keyed by id. */
export async function fieldValues(page) {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('input:not([type="hidden"]), textarea')]
        .filter((el) => el.id.length > 0)
        .map((el) => [el.id, el.value]),
    ),
  );
}

/** Cleans up a locator's text for case-insensitive comparison. */
export function normalise(text) {
  return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Navigates and asserts the route actually answered, before any content assertion.
 *
 * This exists because the most likely failure on this branch is a screen that another agent has not
 * landed yet, and a bare `expect(text).toContain('Agent Jobs')` timeout on a `404` says only that a
 * string was absent. This reports the status, the `notFound()` marker and the page's own title, so the
 * report distinguishes "the route does not exist" from "the route exists and its content is wrong" -
 * two findings that call for completely different follow-up.
 */
export async function openScreen(page, path) {
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  const status = response?.status() ?? null;
  const body = await bodyText(page);
  // `notFound()` is only a body check that is safe when it is the *only* signal: the status is already
  // asserted above, and no real screen in this app contains this sentence.
  const missing = /this page could not be found/i.test(body);

  if (status !== null && status >= 400) {
    throw new Error(
      `GET ${path} answered ${String(status)}.\n` +
        `The screen this spec is written for is not implemented at that route yet.\n` +
        `page title: ${await page.title()}`,
    );
  }
  if (missing) {
    throw new Error(
      `GET ${path} rendered the app's not-found screen (the route resolved to notFound()).\n` +
        `The screen this spec is written for is not implemented at that route yet.`,
    );
  }
  return { status, response };
}

/** The visible heading text, which every screen prints through `PageHead`. */
export async function heading(page) {
  return page.evaluate(() => {
    const first = document.querySelector('h1, .nx-page-head h1, .nx-page-head');
    return (first?.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

/**
 * Renders a page's interactive controls so a failure message names what was actually on screen.
 *
 * Used in the "this control must exist" assertions. Without it, the failure of a form that never
 * rendered is indistinguishable from the failure of a form whose button is worded differently, and
 * those two call for different follow-up.
 */
export async function controlInventory(page) {
  return page.evaluate(() => ({
    buttons: [...document.querySelectorAll('button')].map((el) =>
      (el.textContent ?? el.getAttribute('value') ?? '').replace(/\s+/g, ' ').trim(),
    ),
    textareas: [...document.querySelectorAll('textarea')].map((el) => el.id || el.getAttribute('name') || '(unnamed)'),
    inputs: [...document.querySelectorAll('input:not([type="hidden"])')].map(
      (el) => el.id || el.getAttribute('name') || '(unnamed)',
    ),
    links: [...document.querySelectorAll('a')].map((el) =>
      (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
    ),
  }));
}

/**
 * Playwright's runner, re-exported so every spec imports its `test` and `expect` from one place.
 *
 * A spec that imported `test` from `playwright/test` itself and `expect` from here would be importing
 * the same module twice under two specifiers, which is how two independent runner states get created.
 */
export { expect, test };

/* --------------------------------------------------------------- page lifecycle -- */

/**
 * The standard per-spec lifecycle: one signed-in page, one console buffer, reset before each test.
 *
 * Called at the top level of a spec file; it registers the file-level hooks itself so every spec gets
 * identical lifecycle behaviour and none of them re-implements sign-in.
 *
 * Three things are deliberate:
 *
 *   * **One page per spec file, not per test.** Signing in costs a password KDF plus a session round
 *     trip, and each spec makes several navigations; a fresh sign-in per test would be slower than
 *     every assertion it guards. The suite runs with one worker, so nothing else shares the page.
 *   * **`consoleErrors.length = 0` before each test.** Because the page is shared, errors would
 *     otherwise accumulate across tests and every later test would fail for the first test's reason.
 *     Clearing it makes each spec's assertion mean "the errors *this* test produced".
 *   * **The listener is attached before the first navigation.** A hydration error on the very first
 *     screen is the most likely one, and attaching later would miss it.
 */
export function useSignedInPage() {
  const context = { consoleErrors: [], page: null, authenticated: false };

  test.beforeAll(async ({ browser }) => {
    context.page = await browser.newPage();
    collectConsoleInto(context.consoleErrors, context.page);
    await signIn(context.page);
    context.authenticated = true;
  });

  test.afterAll(async () => {
    await context.page?.close();
  });

  test.beforeEach(() => {
    if (!context.authenticated) {
      throw new Error('the shared page was never signed in; beforeAll did not complete');
    }
    context.consoleErrors.length = 0;
  });

  /**
   * A live view of the shared page.
   *
   * `page` is a **getter**, not a value: `beforeAll` assigns it after this object is
   * created, so a spec that destructures `{ page }` at module scope would otherwise
   * capture `null` and fail every navigation with "Cannot read properties of null
   * (reading 'goto')" — which is exactly what happened before this was a getter.
   */
  return {
    consoleErrors: context.consoleErrors,
    get page() {
      return context.page;
    },
    get authenticated() {
      return context.authenticated;
    },
  };
}

