# NEXUS V1.2 — Test Report

Branch `v1.2/ai-first-redesign`. Every result below was produced by running the
command on this branch in this environment; nothing is projected. Host: Windows,
Node 24.21 (`engines` asks for 22.x, so pnpm prints an engine warning — the suite is
green regardless), pnpm 9.15.4.

`DATABASE_URL` and `SUPABASE_DB_URL` are unset, so every database assertion runs
against the real PostgreSQL engine embedded in PGlite — the same migrations,
triggers, RLS policies and `SECURITY DEFINER` functions a hosted project runs.
**No live Supabase or Vercel project was contacted at any point.**

## 1. Release gate

Run from a **clean worktree** of `v1.2/ai-first-redesign` (detached at the code
commit `ef1c8ce`, created with `git worktree add --detach`), after
`pnpm install --frozen-lockfile`. Nothing in the gate depends on this machine's
`apps/web/.data`, an old build artefact or an earlier run's evidence: the web suite
provisions its own database in the OS temp directory and removes it afterwards, and
the extension suite seeds a fresh demo database in the worktree.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass (3.2s) |
| `pnpm run typecheck` | pass (5 packages, no errors) |
| `pnpm run lint` | pass (`--max-warnings 0` per package) |
| `pnpm run test` | pass — 41 files, 704 tests (144 core + 110 db + 9 extension + 441 web) |
| `pnpm run db:verify` | pass — 35 migrations, 71 tables, 198 policies, 111 triggers, 127 functions, 218 indexes |
| `pnpm run build` | pass (Next.js production build, all V1.2 routes present) |
| `pnpm --filter @nexus/extension run build` | pass (`manifest valid, no credentials in the bundle`) |
| `pnpm --filter @nexus/web run e2e` | pass — 15 tests |
| `pnpm --filter @nexus/extension run e2e` | pass — 38 tests |


## 2. Database

`pnpm run db:verify` applies all **35** migrations to a clean database and asserts
the structural contract:

```
Applying 35 migrations to a clean database…
  tables    71
  policies  198
  triggers  111
  functions 127
  indexes   218
Verification passed.
```

`db:verify` also fails the build if any table carrying a `business_id` is missing
`FORCE ROW LEVEL SECURITY`, or if a function whose name matches
`%execute_sql%` / `%exec_sql%` exists anywhere in the schema. Both checks pass.

### 2.1 Raw-deletion gate (spec §56)

`packages/db/test/v1-2-raw-lifecycle.test.ts` — **7 tests**:

1. a tenant role cannot read, write or delete `raw_staging` (privileges revoked,
   `42501` observed on both a `select` and an `insert`);
2. staging requires the lead-source capability, not merely business access
   (a business member without it and a user from another business are both refused);
3. a staged body can be read once (attempt counted, status `PROCESSING`), consumed,
   and is then **gone** — verified by the owner, so "gone" is not "invisible to me";
4. a failed extraction **keeps** the body for a retry, the retry increments the
   attempt, and only then is the body deleted;
5. TTL removes an abandoned row and leaves a live one alone;
6. the staged payload appears in neither `audit_events` nor any error code;
7. `source_evidence` keeps the metadata that outlives the body — raw content hash,
   byte count, deletion timestamp, collector agent and model — with no raw text.

### 2.2 Agent job and lease gate (spec §57)

`packages/db/test/v1-2-agent-jobs.test.ts` — **17 tests**: durable creation with a
recorded reason; deduplication by key; an atomic claim that two agents cannot both
win; capability matching; heartbeat ownership (`55006` for an impostor); an expired
lease being reclaimed by another agent; the reaper returning an expired job to the
queue and failing one with no attempts left; submit → `WAITING_AI` (not
`COMPLETE`); refusal to complete while un-consumed raw remains; completion after the
raw body is deleted; retryable failure returning to the queue and a capped failure
becoming terminal; release and its ownership rule; cancel; a scoped token needing
`jobs:*`; a scoped token successfully claiming and submitting; cross-business
refusal; `nexus_claim_ai_work` leasing `WAITING_AI` work to exactly one processor
and re-issuing it after a lapse; and a member without manage-leads permission being
refused.

The pre-existing database suites (RLS access, invariants, immutability, sequence
lifecycle, DNC and replies, migration idempotency) all pass unchanged alongside
them.

## 3. Application tests

| Suite | Files | Tests | Result |
| --- | --- | --- | --- |
| `@nexus/core` | 6 | 144 | pass |
| `@nexus/db` | 8 | 110 | pass |
| `@nexus/web` | 26 | 441 | pass |
| `@nexus/extension` (unit) | 1 | 9 | pass |
| **Total** | **41** | **704** | **pass** |

The V1.2 additions inside those totals: 56 core tests (37 deterministic enrichment
and search links, 19 job chaining), 24 database tests (7 raw lifecycle, 17 agent
jobs), and 148 web tests (16 MCP agent tools, 22 AI pipeline, 13 enrichment repo,
59 Lead UI, 18 Agent Jobs UI, 17 metrics, 18 channel vocabulary) — plus the
Companion binding suite grown from 6 to 31 and `rls-access` from 28 to 31.

### 3.1 V1.2 MCP agent surface

`apps/web/test/v1-2-mcp-agents.test.ts` — **16 tests** through the real JSON-RPC
transport with the credential resolver replaced by a fixed token: the published
schemas and idempotency requirements; the absence of any tool that could complete a
job or accept SQL; listing durable work while no agent is online; dedupe; atomic
claim; heartbeat ownership; lease expiry handing the job on; submit → `WAITING_AI`;
idempotent replay (one staging row, `idempotent: true`); idempotency mismatch
refusal; retryable failure and release; cross-business refusal without confirming
existence; the enrichment context's deterministic score, its four available
channels and its **exact** Google query strings; the minimal-lead path landing in
`NEEDS_PROFILE`; minimal-lead replay; and metadata-only evidence storage.

### 3.2 AI pipeline

`apps/web/test/v1-2-ai-pipeline.test.ts` (22) and `v1-2-enrichment-repo.test.ts`
(13), both with injected providers so no request leaves the machine:

* **Cache** — the same input hash, prompt version and model makes exactly one
  provider call, the second returns `cached: true` and writes a `CACHED` row;
  changed facts make a second call; activating a new prompt version makes a second
  call.
* **Validation** — a provider answer that violates the schema returns
  `schema_invalid`, writes a `FAILED` run, and mutates nothing at all.
* **Raw lifecycle** — a successful extraction commits facts plus provenance,
  deletes the staging row and advances the enrichment state; a failure retains the
  row with a typed code; the retry deletes its own row; a run with no staged
  evidence is failed with `raw_staging_missing` and **zero** provider calls.
* **No leakage** — a marker planted in the pasted body is absent from
  `audit_events`, `agent_job_events`, `ai_runs`, `people` and
  `source_evidence.raw_text_or_json`.
* **Context pack** — identical facts reproduce the same pack hash, a changed fact
  rebuilds it, the claim list is bounded, and no marker is present.
* **Processor** — a `WAITING_AI` job reaches `COMPLETE` only after extraction and
  deletion; a retryable failure reuses the same staging row on the next pass and then
  completes; a terminal failure leaves the job `FAILED` with its evidence retained.


## 4. End-to-end

| Suite | Result |
| --- | --- |
| Web browser E2E (`apps/web/e2e`, production build on port 3100, isolated database) | **15 passed, 0 failed** |
| Extension E2E (real MV3 extension in Chromium, seeded demo server on 3000) | **38 passed, 0 failed** |

The web suite is new in V1.2 and covers the Overview metrics and enrichment funnel,
the Leads columns and a real deterministic Find-LinkedIn link, the Agent Jobs
summary plus the absence of any manual complete control, the twelve prompt keys and
the provider state on the AI tab, the Channel Accounts vocabulary, the secondary
navigation (including that the V1.1 concatenation defect is gone), and the
enrichment workspace's "discarded raw text is never re-displayed" rule.

It found three defects that no unit test could, all fixed before this run:

* the Lead Detail page answered **500** in a production build — the page called
  `processingSteps()` and `missingSearchLinks()`, which were exported from a
  `'use client'` module, and Next.js treats every export of a client module as a
  client reference;
* every load of that page produced a **hydration mismatch (React #418)** — the shared
  `PageHead` rendered its `subtitle` prop inside a `<p>`, and this page passes a row
  of chips, so the browser closed the paragraph early and the DOM no longer matched
  what React rendered;
* the Companion's **search blanked the side panel** — the search projection returned
  the enrichment indicator nested while the panel read it flat, so the chip received
  `undefined` and `.toLowerCase()` threw during render. The extension suite caught it;
  the extension suite's own drift (business lists are now scoped to the selected
  channel account, spec §36) was corrected at the same time.


## 5. Live provider smoke (spec §62)

`DEEPSEEK_API_KEY` is **not set** on this host, so:

```
node scripts/smoke-deepseek.mjs
PENDING_DEPLOYMENT_ENV: DEEPSEEK_API_KEY is not set on this host.
```

The AI pipeline is exercised through injected provider mocks, which is what makes
the cache, validation and raw-deletion assertions deterministic. The script is
committed so the live provider can be confirmed in one command after deployment.

## 6. Final gate results

Produced by the clean-checkout run described in §1. The whole gate is green:

```
pnpm install --frozen-lockfile                     pass
pnpm run typecheck                                 pass
pnpm run lint                                      pass
pnpm run test                                      41 files / 704 tests pass
pnpm run db:verify                                 35 migrations, verification passed
pnpm run build                                     pass
pnpm --filter @nexus/extension run build           pass
pnpm --filter @nexus/web run e2e                   15 passed
pnpm --filter @nexus/extension run e2e             38 passed
```

The only commits after the gated commit are documentation, so the result applies to
the final tree of the branch.

