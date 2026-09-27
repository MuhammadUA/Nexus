# NEXUS — Deployment Readiness

**Provider-neutral.** No hosting provider is chosen and nothing has been deployed. This document
exists so that selecting a host becomes a configuration step rather than another development cycle.

**Branch:** `integration/final` · **No provider-specific infrastructure, DNS, domain or secret is
committed anywhere in this repository.**

---

## 1. Runtime

| Requirement | Value | Notes |
| --- | --- | --- |
| Node.js | **≥ 22** (developed and verified on **24.21.0**) | The app uses `node --experimental-strip-types` in three scripts and the built-in `WebSocket` (Node ≥ 22) in tooling. Node 20 is not tested. |
| pnpm | **9.15.4** | Pinned by `packageManager`; `pnpm install --frozen-lockfile` is the supported install. |
| Workspace | pnpm workspace | `apps/web`, `apps/extension`, `packages/core`, `packages/db`, `packages/ui` |
| TypeScript | 5.9.3, strict | |

### Build

```powershell
pnpm install --frozen-lockfile
pnpm run build                              # web (Next.js production build)
pnpm --filter @nexus/extension run build    # extension (MV3)
```

> **Use the direct binaries if a wrapper misbehaves.** `pnpm exec next build` intermittently fails in
> a multi-worktree checkout with `ENOENT: .next/server/*-manifest.json`; `apps/web/node_modules/.bin/next build`
> succeeds reliably. Prefer the path that works on your host rather than debugging the wrapper.

### Start

```powershell
cd apps/web
.\node_modules\.bin\next start --port $env:PORT
```

`apps/web/scripts/serve.mjs` is a convenience wrapper that also generates a session secret and
prepares the embedded database. It resolves the `next` binary from the **workspace root**
`node_modules/.bin`, where it does not exist — so it can fail with `'next' is not recognized`. Either
use the direct command above, or fix the wrapper's resolution before relying on it in production.

### Ports

- **Web:** `PORT` (default `3000`).
- **Extension:** none (MV3 side panel; it only makes outbound requests).

### Persistent / static requirements

- **Persistent volume** when running the embedded PGlite database — the data directory *is* the
  database. On an ephemeral filesystem every redeploy destroys it. See §3.
- Static assets are served by Next.js; no separate CDN is required. No external object storage is
  used.

---

## 2. Environment variables

Every variable the source reads. `.env.example` carries these as placeholders; no real secret is
committed.

| Variable | Purpose | Required | Scope | Secret | Example placeholder |
| --- | --- | --- | --- | --- | --- |
| `PORT` | Web server port | optional (default 3000) | server | no | `3000` |
| `NODE_ENV` | Enables the production path | set by the runner | server | no | `production` |
| `SUPABASE_DB_URL` | External Postgres/Supabase connection | one of this or `DATABASE_URL` when not embedded | server | **yes** | `postgresql://postgres:REPLACE@db.REPLACE.supabase.co:5432/postgres` |
| `DATABASE_URL` | External Postgres connection (alternative name) | as above | server | **yes** | `postgresql://nexus:REPLACE@127.0.0.1:5432/nexus` |
| `NEXUS_DATA_DIR` | Embedded PGlite data directory | optional (default `<app>/.data/nexus`) | server | no | `/var/lib/nexus/data` |
| `NEXUS_MIGRATIONS_DIR` | Directory holding `.sql` migrations | optional | server | no | `/app/packages/db/migrations` |
| `NEXUS_SESSION_SECRET` | Session-cookie signing key | **required in production** | server | **yes** | 32-byte base64url value |
| `NEXUS_LOCAL_AUTH` | Enables email+password sign-in | optional (on by default) | server | no | `1` |
| `NEXUS_ALLOW_EMBEDDED_IN_PRODUCTION` | Permits PGlite under `NODE_ENV=production` | optional, explicit opt-in | server | no | `1` |
| `NEXUS_COMPANION_PREVIEW` | Serves the static panel preview | optional (off) | server | no | leave unset in production |
| `DEEPSEEK_API_KEY` | Provider key for drafting/extraction | optional | server | **yes** | `REPLACE_WITH_PROVIDER_KEY` |
| `DEEPSEEK_BASE_URL` | Provider base URL | optional | server | no | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | Provider model id | optional | server | no | `deepseek-chat` |
| `NEXUS_API_ORIGIN` | **Build-time** API origin baked into the extension | required for a production extension build | extension build | no (public URL) | `https://app.example.com` |

### Secret-handling rules this codebase enforces

- **No `NEXT_PUBLIC_*` variable exists, deliberately.** Next.js inlines those into the client bundle.
  Placing `NEXUS_SESSION_SECRET` or `DEEPSEEK_API_KEY` behind that prefix would publish it.
- Provider error bodies pass through `redactSecrets` (`apps/web/src/lib/ai/deepseek.ts`) before they
  reach a log or a response.
- The extension bundle is checked at build time for embedded session-secret patterns.
- `NEXUS_SESSION_SECRET` changing silently signs every operator out, because the cookie is signed with
  it. Behind an autoscaler it **must** be set explicitly, or each new instance invalidates all sessions.

### Optional features and their degraded states

| Feature | Without configuration | Behaviour |
| --- | --- | --- |
| AI drafting | no `DEEPSEEK_API_KEY` | A typed `provider_not_configured` result; the UI renders it as a normal deployment state, not an error. The local profile-extraction fallback still works. |
| External database | no `SUPABASE_DB_URL`/`DATABASE_URL` | Falls back to embedded PGlite, which refuses `NODE_ENV=production` unless explicitly overridden. **See §3 for the service-token ingestion limitation that comes with it.** |
| Companion preview | `NEXUS_COMPANION_PREVIEW` unset | Route returns 404. |

### ⚠️ The embedded engine is single-process

PGlite is a WASM PostgreSQL and **one data directory supports exactly one process**. Two processes
opening `apps/web/.data` at once corrupts the cluster — observed during this baseline, where the
database had to be rebuilt from migrations and the seed. This is why `NODE_ENV=production` refuses the
embedded engine unless `NEXUS_ALLOW_EMBEDDED_IN_PRODUCTION=1` is set explicitly.

**Operational rule:** stop the server before running anything that opens the data directory directly
(`scripts/baseline-verify/db-setup.mjs`, `diag-rls.mjs`, the seed, `db:reset`).

---

## 3. Database

### Expected requirements

- **PostgreSQL 15+** (Supabase-compatible), or the embedded PGlite engine for single-instance use.
- The app connects via `SUPABASE_DB_URL` or `DATABASE_URL`. `apps/web/src/lib/db.ts` documents the
  resolution order: external Postgres when a connection string is present, embedded otherwise.

### Migration and verification commands

```powershell
pnpm run db:reset      # rebuild the local database from migrations
pnpm run db:verify     # verify schema, constraints, triggers, RLS, functions and indexes
```

Migrations live in `packages/db/migrations` and are applied in filename order. They include the RLS
policies, the Business and Outreach Identity lifecycle guards (`0023`–`0025`), and
`assert_sent_message_has_content()` (`0021`).

### RLS expectations

- **Postgres RLS is the authorization boundary.** Application checks are a second line, never the
  only one. `withActor(actor, fn)` sets `set local role authenticated` and the request JWT claims, so
  a query runs with the caller's own policies.
- A deployment must therefore connect as a role that is **not** `BYPASSRLS`. A superuser connection
  silently disables the entire tenancy model.
- `SUPABASE_DB_URL` should be the **direct** database connection, not the pooled transaction-mode
  endpoint, because `set local role` and `set_config` are per-transaction and a transaction-pooler can
  move statements between backends.

### ⚠️ Service-token ingestion is not usable on the embedded engine

**This is a deployment constraint, and it is the reason the embedded PGlite mode is recommended only
for a single-operator review instance, not for a real one.**

A service token (`nxs_…`, i.e. an `api_clients` row) cannot INSERT into the business-less canonical
tables `public.companies` and `public.people`. The refusal is:

```
42501 new row violates row-level security policy for table "companies"
```

That breaks `POST /api/v1/ingest`, `nexus.submit_candidate` and `nexus.create_or_update_lead` whenever
the pipeline has to create a new Company or Person. An **admin user token succeeds**, which is what
makes the difference easy to misread as a permissions problem.

**The policy is not the cause, and has deliberately not been changed.** Verified against a freshly
seeded database at the current commit (`scripts/baseline-verify/diag-rls.mjs`):

1. Inside the gateway's own session shape — `set local role authenticated` plus
   `set_config('nexus.api_client_id', …)` — `public.acting_api_client_id()` resolves to the token's
   UUID, `public.api_client_scopes()` returns all 29 granted scopes, and `current_setting` reads back
   the same value.
2. The only INSERT policy on `companies` is `companies_insert`; it is `PERMISSIVE`, granted to
   `authenticated`, and its `WITH CHECK` is
   `is_admin() OR EXISTS(SELECT 1 FROM user_business_access … can_use_lead_sources) OR acting_api_client_id() IS NOT NULL`.
3. That same expression is evaluated **in the same transaction** and returns `true`.
4. The insert is still refused with `42501`. In PostgreSQL, a permissive `WITH CHECK` that evaluates
   true cannot deny an insert.
5. `authenticated` holds the INSERT privilege, and the table owner inserts successfully.
6. The failure reduces to a **throwaway table created inside the diagnostic**: a one-term policy
   `with check (acting_api_client_id() is not null)` accepts the insert; adding a second disjunct that
   must also be evaluated makes the same engine refuse it — on a table with no triggers, no foreign
   keys and no product policy.

**Conclusion:** this is how the **embedded PGlite** engine evaluates a multi-term policy expression
containing those helper functions. Changing a security policy to satisfy a possibly-buggy local engine
would be the wrong trade, so the policy stands.

**What to do on a real deployment:**

1. Connect to real **PostgreSQL 15+** (the direct connection, per the note above).
2. Re-run `POST /api/v1/ingest` with a service token and confirm it returns `200`/`201` with a
   `leadId`. The two `BLOCKED` cases in `API_BASELINE_VERIFICATION.md` §10 are exactly this check.
3. If it passes — as it is expected to on PostgreSQL — no code change is needed and this limitation
   applies only to the embedded engine. If it fails on PostgreSQL, the finding is real and must be
   fixed before ingestion is relied on.

Until step 2 has been performed and recorded, treat service-token ingestion as **unverified**.

### The SENT invariant

A message in state `SENT` must have non-blank current content. Migration `0021` enforces it and the
demo seed complies by transitioning DYNAMIC → version → SENT rather than bypassing the trigger. **Do
not weaken `0021` to make a seed or import pass.**

### ⚠ Embedded-database caveat (single-process)

PGlite is a WASM Postgres and **one data directory supports exactly one process**. Two instances
sharing a directory corrupt or deadlock it — observed during this baseline, where concurrent access
forced a rebuild from migrations and the seed. For any host that runs more than one instance, use
`SUPABASE_DB_URL`/`DATABASE_URL`. The operational rule that follows from it, and the service-token
ingestion limitation that comes with the embedded engine, are in **§2**.

---

## 4. Networking

| Concern | Requirement |
| --- | --- |
| Public origin | One HTTPS origin serving the app. `NEXUS_API_ORIGIN` for the extension build must be that origin. |
| HTTPS | **Required in production.** The extension build refuses a non-https production origin, and the session cookie should be `Secure`. |
| API base | Same origin, path `/api/v1/...`. There is no separate API host. |
| Extension origin | `chrome-extension://<id>` is opaque and cannot be allow-listed ahead of time. |
| CORS | Declared in **`apps/web/next.config.ts`** (see below). |
| Host restrictions | The extension's `manifest.json` `host_permissions` allow-lists exactly the API origin and `https://www.linkedin.com/*`. Changing the origin requires rebuilding the extension. |

### Companion CORS — single source of truth

`/api/v1/companion/*` carries `Access-Control-Allow-Origin: *` plus the methods and headers the panel
sends. This is declared in `apps/web/next.config.ts`.

A wildcard is safe **for this surface specifically**: it is authenticated with
`Authorization: Bearer`, not cookies, and the app sets no companion cookie — so `*` (which forbids
credentialed requests) gives a third-party page no way to borrow an operator's session. The
cookie-authenticated app routes remain same-origin.

**Historical note, because it cost real debugging time:** this policy previously lived in
`apps/web/middleware.ts`, which **never executed**. Next.js resolves middleware to `src/middleware.ts`
when a `src` directory exists, and this app has one — so no middleware was ever registered, and every
panel request failed with "Nexus is unreachable" while the server was answering. Moving the file into
`src/` compiles it but breaks the build, because Next bundles `src/instrumentation.ts` for the edge
middleware runtime and that file imports `@/lib/db` → `node:path`, which edge cannot resolve. The dead
middleware has been **deleted**; `next.config.ts` is now the only place this policy is expressed.

---

## 5. Health

There is **no dedicated `/api/health` endpoint**. The safe health check is the unauthenticated
Companion session gate:

```
GET /api/v1/companion/me
```

| Response | Meaning |
| --- | --- |
| `401 {"error":"Sign in to Nexus."}` | **Healthy.** The server is up, routing works, and the auth layer answered. |
| `200` | Also healthy (a valid token was supplied). |
| connection refused / 5xx | Unhealthy. |

A `401` is the correct success signal — it proves the request reached the application and was
authenticated against, without needing a database write.

**This endpoint leaks nothing:** no secrets, no connection strings, no schema or version internals. It
returns a fixed refusal string. Do not add database-version or environment detail to it — a public
health endpoint is reconnaissance for an attacker.

---

## 6. Deployment modes

Both are documented; **neither has been attempted**, and no compatibility is claimed beyond what is
stated.

### A. Serverless-style web hosting (e.g. Vercel)

- Works with the standard Next.js App Router build (`pnpm run build`).
- **Requires an external Postgres** (`SUPABASE_DB_URL` or `DATABASE_URL`). The embedded PGlite engine
  cannot be used: functions are ephemeral and may run concurrently.
- **Requires `NEXUS_SESSION_SECRET` to be set explicitly** in the environment. Without it there is no
  stable signing key across instances and sessions will not survive.
- **Known limitation:** the RLS model depends on `set local role` + `set_config` inside a transaction.
  If you point `SUPABASE_DB_URL` at a transaction-mode connection pooler, those settings can escape the
  intended transaction and RLS may misbehave. Use a direct or session-mode connection.
- Server Actions and the companion Bearer routes both work on this target.

### B. Conventional Node process (VPS / cPanel Node / container)

- Long-running `next start`, so the embedded PGlite engine is usable **on a single instance with a
  persistent volume** (set `NEXUS_ALLOW_EMBEDDED_IN_PRODUCTION=1` and `NEXUS_DATA_DIR`).
- Set `NEXUS_SESSION_SECRET` explicitly so a restart does not sign everyone out.
- Migrations run against the configured database; `pnpm run db:verify` confirms the result.
- Needs a process manager (systemd, pm2, container restart policy) and a reverse proxy terminating TLS.
- **Known limitation:** more than one instance must not share a PGlite data directory. Scale out only
  with an external Postgres.

### What is identical either way

No product-code change is required to switch between these. The database choice and the session secret
are environment inputs; the CORS policy is host-agnostic static headers; the extension is rebuilt with
a new `NEXUS_API_ORIGIN` and reloaded.

---

## 7. Production start — exact commands

**Serverless / managed:**

```powershell
pnpm install --frozen-lockfile
pnpm run build
# start command: pnpm --filter @nexus/web run start   (or the platform's Next.js preset)
```

**Conventional Node host:**

```powershell
pnpm install --frozen-lockfile
pnpm run build
cd apps/web
$env:NODE_ENV='production'
$env:PORT='3000'
$env:NEXUS_SESSION_SECRET='<32-byte base64url value>'
$env:SUPABASE_DB_URL='<direct postgres connection string>'
.\node_modules\.bin\next start --port $env:PORT
```

**Extension (client machines, after the API origin is known):**

```powershell
$env:NEXUS_API_ORIGIN='https://app.example.com'
pnpm --filter @nexus/extension run build
# then load apps/extension/dist as an unpacked extension, or ship it as a packaged CRX
```

---

## 8. Deferred by scope

**Outbound webhook delivery worker.** Configuration storage persists and secrets are stored hashed,
but no delivery/retry/dead-letter worker exists. This is the single intentional deferral in the
baseline, and the UI does not claim delivery occurs. See `PREDEPLOY_BASELINE_GAP_MATRIX.md`.

---

## 9. Pre-deployment checklist

- [ ] `NEXUS_SESSION_SECRET` set to a stable 32-byte value
- [ ] `SUPABASE_DB_URL` (or `DATABASE_URL`) set to a **direct** Postgres connection, as a **non-BYPASSRLS** role
- [ ] Migrations applied and `pnpm run db:verify` green against the target database
- [ ] **`POST /api/v1/ingest` verified with a service token on real PostgreSQL** — this is the F-2/F-6
      check, and it is the one item the embedded engine cannot answer (see §3)
- [ ] `NODE_ENV=production`; embedded engine off (or `NEXUS_ALLOW_EMBEDDED_IN_PRODUCTION=1` **and** a persistent volume **and** exactly one instance)
- [ ] `NEXUS_COMPANION_PREVIEW` unset
- [ ] HTTPS terminating in front of the app
- [ ] `DEEPSEEK_API_KEY` set if AI drafting is wanted (otherwise the UI correctly reports it unconfigured)
- [ ] Extension rebuilt with `NEXUS_API_ORIGIN` = the public origin, then reloaded
- [ ] Health check wired to `GET /api/v1/companion/me` expecting **401**
- [ ] `logs` confirmed to reveal no secrets (the redaction path is covered by tests)

### Health check

```
GET /api/v1/companion/me
```

| Response | Meaning |
| --- | --- |
| `401 {"error":"Sign in to Nexus."}` | **Healthy.** The server is up, routing works, and the auth layer answered. |
| `200` | Also healthy (a valid token was supplied). |
| connection refused / 5xx | Unhealthy. |

**This endpoint leaks nothing**, and that is deliberate: no secrets, no connection strings, no schema
or version internals, just a fixed refusal string. Do not add database-version or environment detail
to it — a public health endpoint is reconnaissance for an attacker.

### Known non-blocking observations

| Observation | Impact |
| --- | --- |
| The Companion panel truncates its selected Business name (`Zemnas Creati`) at 420px | Cosmetic; the selector still works |
| `nexus.get_today_queue` answers an unknown user with an empty queue rather than a refusal (F-8) | An agent cannot distinguish "nothing due" from "no such user". Accepted |
| Gateway tool scopes and RLS scopes are disjoint vocabularies (F-9) | A service token must be granted both. Recorded as context for F-2/F-6 |
