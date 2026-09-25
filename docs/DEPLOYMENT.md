# NEXUS — Deployment & Setup

## 1. What this repository contains

| Path | What it is |
| --- | --- |
| `apps/web` | Next.js 15 app: admin + user surfaces, REST/MCP gateway, server actions |
| `apps/extension` | Chrome/Chromium **Manifest V3** Side Panel Companion |
| `packages/core` | Pure domain logic: normalization, dedupe, sequence engine, today engine, message rules, permissions |
| `packages/db` | SQL migrations, PGlite test harness, seed fixtures, `db:verify` |
| `packages/ui` | Shared design-language CSS + React primitives (used by the app *and* the extension) |
| `product/` | The master JSON spec and the two `.fig` sources |
| `docs/` | `DB_CONTRACT.md`, `IMPLEMENTATION_MATRIX.md`, `DESIGN_TOKENS.md`, `ACCEPTANCE_AUDIT.md` |

## 2. Requirements

- **Node.js ≥ 22** (the DB scripts use `node --experimental-strip-types`; tested on 24)
- **pnpm 9** (`corepack enable` or install globally)
- **PostgreSQL 15+** for a real deployment. Supabase is the intended host
  (spec `security_and_reliability.stack.database`).
- Chrome/Chromium ≥ 114 for the Companion

> On Windows the `pnpm.ps1` shim is often blocked by the execution policy. Use
> `pnpm.cmd` (or `corepack pnpm`) instead.

## 3. Install and verify

```bash
pnpm install

pnpm run typecheck     # all packages, TypeScript strict
pnpm run lint          # ESLint, type-aware, zero warnings allowed
pnpm run test          # core + db + web test suites (166 tests)
pnpm --filter @nexus/db run verify   # applies every migration to a clean database
pnpm run build         # Next.js production build
```

`db:verify` is the fastest signal that the schema is sound: it applies all
migrations to a real PostgreSQL engine (PGlite), then asserts that RLS is **forced**
on every table that has a `business_id`, that no SQL-execution function exists, and
prints table/policy/trigger/function/index counts.

### End-to-end smoke test

`apps/web/scripts/smoke-gateway.mjs` drives a **running** server over HTTP and checks
the whole authentication and gateway chain: first-run bootstrap (including the session
cookie and redirect), rejection of a wrong password, user-token issuance, an
authenticated Companion bootstrap, search, `me`, revocation actually revoking, MCP
capability discovery, and refusal of the forbidden `database.execute_sql` tool.

```bash
# in one shell
cd apps/web
NEXUS_LOCAL_AUTH=1 NEXUS_ALLOW_EMBEDDED_IN_PRODUCTION=1 pnpm exec next start --port 3300

# in another (needs an UNCLAIMED database: delete apps/web/.data first)
node apps/web/scripts/smoke-gateway.mjs http://127.0.0.1:3300
```

### A note on `next dev`

`pnpm --filter @nexus/web run dev` does not work in every environment: webpack's
on-demand compilation trips over the `node:` scheme in `@nexus/db`'s filesystem code.
The production build resolves it, so **verify with `next build` + `next start`**. This
is a development-server limitation, not a defect in the application, and it is recorded
in `docs/ACCEPTANCE_AUDIT.md` §6.


## 4. Configuration

Copy `apps/web/.env.example` to `apps/web/.env.local` and set:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` or `SUPABASE_DB_URL` | **production** | PostgreSQL/Supabase connection. |
| `NEXUS_SESSION_SECRET` | **production** | HMAC key for the session cookie (≥32 random bytes). |
| `NEXUS_LOCAL_AUTH=1` | local dev | Enables the local email/password path (migration 0015). |
| `NEXUS_ALLOW_EMBEDDED_IN_PRODUCTION=1` | smoke tests only | Permits a production build on the embedded driver. |
| `NEXUS_MIGRATIONS_DIR` | optional | Overrides the migration directory lookup. |
| `NEXUS_DATA_DIR` | optional | Where the embedded database persists. |

### Two database drivers, one schema

`apps/web/src/lib/db.ts` resolves the connection at boot:

1. **`DATABASE_URL` / `SUPABASE_DB_URL` set** → PostgreSQL via a pooled `pg` client.
   This is the production path.
2. **Neither set** → embedded PostgreSQL (PGlite) persisted under `apps/web/.data/`.

The second driver is a real PostgreSQL engine, not a mock — the same migrations,
triggers and RLS policies run in both, which is why local development and the test
suite exercise production SQL. What it is *not* is a multi-process server: PGlite is
single-connection WASM.

**`assertRuntimePosture()` refuses to start a production build on the embedded
driver**, and refuses to start at all without `NEXUS_SESSION_SECRET`. Both failures
are deliberate: silently serving from a single-process database, or signing sessions
with a development fallback, would be worse than not starting.

## 5. First run

### Creating the first administrator

Two equivalent paths. The CLI one is reproducible and is what you want when bringing
up a server you cannot yet log into:

```bash
cd apps/web
pnpm run bootstrap-admin admin@example.com 'choose-a-password-of-12-chars-or-more' 'Admin Name'
```

It applies the migrations if the database is empty, creates the admin, writes an audit
row, and is **idempotent** — re-running it against a claimed deployment lists the
existing users and changes nothing.

Alternatively, open `/login`. With **zero users** the page shows a first-run panel that
does the same thing through the UI. That path works exactly once: the guard is
re-checked inside the inserting transaction, so two concurrent first-run requests cannot
both succeed.

### Starting the server

```bash
cd apps/web
pnpm run start          # generates NEXUS_SESSION_SECRET on first run and serves :3000
PORT=8080 pnpm run start
```

`pnpm run start` wraps `next start` to keep two environment details stable across
restarts; see the docblock in `apps/web/scripts/serve.mjs`. Notably it **persists**
`NEXUS_SESSION_SECRET` to `.env.local` on first run, because regenerating it would
silently sign every existing session out.

### Verifying a running server

```bash
node apps/web/scripts/smoke-login.mjs http://127.0.0.1:3000 <email> <password>
```

Checks the login page, refusal of a wrong password, acceptance of the real one, that the
session cookie actually authenticates `/my-day`, and that the admin surfaces render while
an anonymous visitor is redirected.

`apps/web/scripts/smoke-gateway.mjs` does the same for the whole API surface (token
issuance, Companion endpoints, MCP discovery, revocation). It needs an **unclaimed**
database, so delete `apps/web/.data` first.

Then, in order:

1. **Businesses → Add business** (`/businesses/new`) — create a business, or clone
   one. Cloning copies configuration only; leads and history are never copied.
2. **Business setup** — `/b/<slug>/setup/brain`, `/setup/icps`, `/setup/sequences`,
   `/setup/knowledge`.
3. **Team & Accounts** (`/team`) — create users, grant business access, set a local
   password. Then **Outreach Identities** (`/identities`) and **My Access &
   Assignment** (`/my-access`) to bind a sender identity.
4. **Integrations Gateway** (`/integrations`) — issue a scoped service token for an
   external agent, then **Automation Mapping** (`/b/<slug>/automations`).

## 6. Supabase (production auth and data)

1. Create a Supabase project.
2. Apply the migrations. They are plain `.sql` in lexical order, so either
   `psql "$SUPABASE_DB_URL" -f packages/db/migrations/000N_*.sql` in order, or point
   `supabase db push` at `packages/db/migrations`.
   Migration `0001` creates `auth.uid()` **only when absent**, so a Supabase project
   keeps its own function; the body is re-asserted to the same blank-safe semantics.
3. Set `SUPABASE_DB_URL` and `NEXUS_SESSION_SECRET`.
4. `NEXUS_LOCAL_AUTH` stays unset, so the local password path is inert and Supabase
   Auth is the only way in.

Either provider converges on the same authorization decision: the session yields a
`userId`, the app publishes it to PostgreSQL as `request.jwt.claims`, and RLS decides
what that user can see. That is why the app is not the security boundary — the
database is.

### Database roles

Migration `0001` creates the `authenticated` and `anon` roles when they are absent,
so the migration set also runs on a bare PostgreSQL instance. On Supabase they
already exist and are left alone.

Every business-scoped table is `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, so even
the table owner is bound by policy. The only way past it is the deliberate,
audit-logged `withServiceRole(reason, fn)` helper, used solely for bootstrap and
seeding.

## 7. Vercel deployment

1. Import the repository; set the **root directory** to `apps/web`.
2. Build command `pnpm --filter @nexus/web run build`; install `pnpm install`.
3. Set the environment variables from §4. Do **not** set
   `NEXUS_ALLOW_EMBEDDED_IN_PRODUCTION`.
4. Health check: `/login` must return `200`.

No service-role key is ever read by application code, so none needs to be exposed.

## 8. Companion extension

```bash
pnpm --filter @nexus/extension run build      # -> apps/extension/dist
```

`NEXUS_API_ORIGIN` is baked in at build time (default `http://127.0.0.1:3000`),
which is what lets `host_permissions` stay narrow:

```bash
NEXUS_API_ORIGIN=https://your-app.vercel.app pnpm --filter @nexus/extension run build
```

Load it:

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select `apps/extension/dist`.
3. Click the toolbar icon to open the Side Panel, then sign in and bind this browser
   profile to one of your assigned sender identities.

**Permissions requested and why:** `sidePanel` (the product *is* a side panel),
`storage` (session token + list state), `tabs` (open the prospect's profile in the
active tab), `alarms` (session heartbeat). There is deliberately no `cookies`, no
`<all_urls>`, and no `webRequest`; `host_permissions` is limited to
`linkedin.com` and your API origin.

The token lives in `chrome.storage.session` (in-memory, never written to disk). The
extension uses **user-scoped** authentication and never receives a database
credential.

## 9. Background jobs

NEXUS does not require a worker to function. The spec allows an optional worker
(`worker`/`n8n`) for background orchestration, and the pieces it would drive already
exist as audited functions:

- `public.get_today_queue(...)` — the My Day / Companion Today projection
- `public.publish_sequence_version(...)` — transactional publish with impact preview
- `public.mark_message_sent(...)` — schedules the next step
- `public.undo_import(...)` — reverts an import batch

If you add a worker, give it a scoped `api_clients` token of kind
`internal_worker`. **Never** give it the service-role key, and never a SQL-execution
scope — there is no such scope by design.

## 10. Operational notes

- **Soft delete by default.** Trash restores; permanent deletion is admin-only,
  audited, and gated on the literal string `DELETE PERMANENTLY` in the database
  function itself.
- **Do Not Contact** is a person+channel suppression, checked by a trigger on
  every transition to `SENT`. It cannot be bypassed by switching sender identity.
- **Sent messages are immutable.** Corrections are new versions/events. Publishing a
  sequence version never rewrites SENT or LOCKED content and invalidates only eligible
  DYNAMIC unsent instances.
- **Audit coverage.** Sensitive mutations append `audit_events` rows via triggers;
  the table is append-only (no UPDATE/DELETE privilege for any application role).
- **Token hygiene.** Only SHA-256 hashes of service and user tokens are stored. A
  service token is displayed once, at creation; revoke and reissue if lost.
- **Retention.** `retention.trash_days` and the other defaults live in
  `platform_settings` (migration `0010`), editable on `/settings`.

## 11. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `NEXUS refuses to run a production build on the embedded PGlite driver` | `DATABASE_URL` is unset. Set it, or set `NEXUS_ALLOW_EMBEDDED_IN_PRODUCTION=1` for a single-process smoke test only. |
| `NEXUS_SESSION_SECRET is required in production` | Set it (§4). |
| `pnpm.ps1 cannot be loaded` | Execution policy. Use `pnpm.cmd`. |
| `ERR_PNPM_UNEXPECTED_STORE` | Pass `--store-dir E:\CRM\.pnpm-store`, or reinstall. |
| The Companion says "Nexus is unreachable" | `NEXUS_API_ORIGIN` was wrong at build time, or the API origin is not in `host_permissions`. Rebuild the extension. |
| Sign-in does nothing | `NEXUS_LOCAL_AUTH=1` is not set, or Supabase Auth is not configured. |
| A screen is empty but data exists | That is RLS: the viewer has no grant covering those rows. Check `/team/[id]`. |
