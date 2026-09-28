# NEXUS V1.2 — Implementation Plan

**Branch:** `v1.2/ai-first-redesign`. **Normative spec:** `product/NEXUS_V1_2_MASTER_SPEC.md` (V1.2 master
specification, referred to below as "the spec"). **Companion documents:** `docs/V1_2_MIGRATION_PLAN.md`
(the database contract), `docs/V1_2_AI_COST_CONTROL.md` (the cost rules), `docs/OPENCODE_AGENT_WORKFLOW.md`
and `docs/CHATGPT_MCP_WORKFLOW.md` (the two agent boundaries).

This plan orders the work. The spec decides what the work is; where this plan and the spec disagree, the
spec wins and this plan is corrected.

---

## 1. How to read this plan

1.1 A **phase** is a unit of work that can be verified on its own. Phases are ordered by dependency, not
by importance: P2 cannot be verified before P1 defines the vocabulary the migrations check, and P8 must
not be built before P3 makes the reads real.

1.2 Every phase states: goal, areas and files touched, dependencies, deliverables, verification, and exit
criteria. An exit criterion is a fact, not an intention — "the table exists and `db:verify` passes", not
"the table is done".

1.3 A phase is complete when its verification has been run **and** the result recorded with the SHA it
was run at. A phase that is "nearly done" is not done, and a later phase must not assume it.

1.4 Nothing in this plan is permitted to weaken the spec. If a phase cannot meet an exit criterion, the
finding is recorded and the phase stays open; the criterion is not relaxed.

---

## 2. Branch, SHA and production policy

2.1 **Branch.** All V1.2 work happens on `v1.2/ai-first-redesign`. The base SHA is recorded once, in the
V1.2 status note, when P0 runs. Every phase's verification is recorded against a SHA.

2.2 **Never touch production.** These are hard boundaries, restated from spec §80:

- **Do not deploy.** No Vercel deployment, no production promotion.
- **Do not touch live Supabase.** No migration is applied to a hosted project by the implementer; no
  hosted connection string is used for anything except an explicitly authorised read-only verification.
- **Do not touch live Vercel.** No project settings, no environment variables, no domain change.
- **Do not merge to `main`.**
- **Do not force-push `integration/final`.** It is a shared baseline; a force-push destroys the history
  other work depends on.
- **Do not move tags.** A moved tag makes a build hash unreproducible.
- **Do not rewrite an applied migration.** `0001`–`0029` are history; `0030`–`0035` become history the
  moment they are applied anywhere. A defect is fixed by the next migration number (`docs/V1_2_MIGRATION_PLAN.md` §14).

2.3 **The final action is pushing `v1.2/ai-first-redesign` only.** ChatGPT later reviews that branch and
handles applying the migrations, the Preview deployment and promotion. Those are not implementer steps,
and an implementer must not perform them in order to "finish" the work.

2.4 **No live credentials in the repository or in the extension.** `DEEPSEEK_API_KEY` stays server-side;
no service-role key is referenced from a client bundle or an extension file (DB_CONTRACT §5); no database
credential is handed to ChatGPT or OpenCode (spec §45.2).

2.5 **Scope discipline.** Work in a phase touches that phase's areas. A drive-by change to an unrelated
module is a review finding, because V1.2's risk is concentrated in the interaction between new state and
old invariants.

---

## 3. Workstreams

| Workstream | Owns | Primary areas |
| --- | --- | --- |
| **DB / migrations** | schema, RLS, functions, indexes, migration tests | `packages/db/migrations/`, `packages/db/scripts/verify.ts`, `packages/db/test/` |
| **Core contracts** | vocabulary, types, deterministic engines, permissions and IA | `packages/core/src/` |
| **Server data layer** | repositories, transactions, read projections | `apps/web/src/lib/repo/` |
| **Server AI** | orchestrator, prompts, cache, ledger, commit paths | `apps/web/src/lib/ai/` |
| **MCP gateway** | tool catalogue, schemas, scopes, idempotency, dispatch | `apps/web/src/app/api/v1/mcp/` |
| **Agent engine** | job lifecycle wiring, chaining, reaping, raw cleanup | `packages/db/migrations/0032`, `0034`, server processor |
| **Web UI** | Leads, Lead Detail, Agent Jobs, Overview, Business Setup, IA, Access | `apps/web/src/app/(app)/`, `apps/web/src/app/b/[slug]/` |
| **Companion** | MV3 extension, companion API, binding scope | `apps/extension/`, `apps/web/src/app/api/v1/companion/` |
| **Verification** | gates, E2E, clean-checkout run, evidence recording | root `package.json`, `packages/db/test/`, `apps/web/test/`, `apps/extension/e2e/` |

Every phase names exactly one **owning** workstream. Other workstreams may contribute; the owner is
accountable for the exit criteria.

---

## 4. Phase overview

| Phase | Name | Owner | Depends on |
| --- | --- | --- | --- |
| P0 | Baseline and branch hygiene | Verification | — |
| P1 | Vocabulary and contracts | Core contracts | P0 |
| P2 | Migrations `0030`–`0035` | DB / migrations | P1 |
| P3 | Server data layer | Server data layer | P2 |
| P4 | AI orchestration | Server AI | P2, P3 |
| P5 | MCP surface | MCP gateway | P1, P3, P4 |
| P6 | Agent job engine | Agent engine | P2, P4, P5 |
| P7 | Intelligence completeness and search links | Core contracts | P1, P3 |
| P8 | Web UI | Web UI | P3, P4, P6, P7 |
| P9 | Companion V1.2 | Companion | P6, P7, P8 (header contract only) |
| P10 | Verification and release | Verification | all |

Critical path: **P0 → P1 → P2 → P3 → P4 → P6 → P8 → P10**. P5 can proceed in parallel with P6 once P4's
failure vocabulary is frozen, because the MCP transport is a thin layer over the same functions.

---

## 5. Phase detail

### P0 — Baseline and branch hygiene

**Goal.** Know exactly what state the branch is in before changing it, so every later claim is relative to
a recorded SHA and a working gate.

**Areas.** No source changes.

**Deliverables.** A recorded base SHA, a recorded gate result, and a list of pre-existing failures.

**Verification.**

```
git -C . status --porcelain          # record what is already dirty
git rev-parse HEAD                    # record the base SHA
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run db:verify
pnpm run build
pnpm --filter @nexus/extension run build
```

**Exit criteria.** Every command above has been run at the recorded SHA; any failure is written down as
pre-existing with its output; a clean worktree is confirmed for the files this plan will touch (the six
V1.2 documents and the V1.2 source areas), or the pre-existing dirt is itemised.

**Notes.** V1.2 inherits known-open V1 findings — `docs/MCP_BASELINE_VERIFICATION.md` records F-2
(service-token RLS on the business-less canonical tables) and F-8 (`get_today_queue` answers an unknown
user with an empty queue). They must be listed here so that a V1.2 failure is not confused with them.

### P1 — Vocabulary and contracts

**Goal.** The V1.2 vocabularies exist once, in code, and match the migration CHECK constraints exactly.

**Areas.**

- `packages/core/src/vocabulary.ts` — `ENRICHMENT_STATES`, `DISCOVERY_SOURCES`, `OUTREACH_CHANNELS`,
  `CONTACT_POINT_KINDS`, `AGENT_JOB_TYPES`, `AGENT_JOB_STATUSES`, `AGENT_JOB_PRIORITIES`, `AI_TASK_TYPES`,
  `PROMPT_KEYS`, `AI_RUN_STATUSES`, `LEGACY_SOURCE_TO_DISCOVERY`, `CHANNELS_FOR_SOURCE`,
  `discoverySourceFromLegacy`, `normalizeDiscoverySource`.
- `packages/core/src/contracts.ts` — the new `MCP_TOOLS` entries, `MCP_TOOL_SCOPES` for each, the
  envelope unchanged, `FORBIDDEN_MCP_TOOLS` unchanged.
- `packages/core/src/index.ts` — the new exports.
- `packages/core/src/permissions.ts` — any new permission a V1.2 screen needs, added to `PERMISSIONS`,
  the role matrices and `ROUTE_PERMISSIONS` in the same change (visibility and authorization must not
  drift).

**Deliverables.** Typed vocabularies with unit tests; the source↔channel independence guard
(`CHANNELS_FOR_SOURCE` returns every channel for every source, which is the executable form of spec §20).

**Verification.**

```
pnpm --filter @nexus/core run test
pnpm --filter @nexus/core run typecheck
pnpm run lint
```

Test names that must exist: `ENRICHMENT_STATES has exactly nine values`;
`DISCOVERY_SOURCES has exactly sixteen values`; `OUTREACH_CHANNELS has exactly four values`;
`PROMPT_KEYS has exactly twelve values`; `AI_TASK_TYPES has exactly seven values`; `every MCP tool
declares a scope`; `source never restricts channel`.

**Exit criteria.** Every vocabulary matches spec §14.1, §18.1, §19.1, §21.1–§21.4 and §43.1; no new
vocabulary value exists in SQL that does not exist in TypeScript, or vice versa.

### P2 — Migrations `0030`–`0035`

**Goal.** The schema, RLS, functions and indexes of `docs/V1_2_MIGRATION_PLAN.md` exist and are
re-appliable, verified by the local harness.

**Areas.** `packages/db/migrations/0030_channel_accounts_and_contact_points.sql`,
`0031_lead_enrichment_and_raw_staging.sql`, `0032_agent_jobs.sql`,
`0033_ai_runs_prompts_context.sql`, `0034_v1_2_processor_and_read_models.sql`,
`0035_companion_binding_scope.sql`; `packages/db/scripts/verify.ts`;
`packages/db/test/migration-idempotency.test.ts`; `packages/db/test/harness.ts` if the harness needs new
actor shapes.

**Deliverables.** The migrations; the idempotency proof; the RLS matrix assertions for every new table.

**Verification.**

```
pnpm run db:verify
pnpm --filter @nexus/db run test
```

Plus the manual checks in `docs/V1_2_MIGRATION_PLAN.md` §13.2 against the local PGlite database.

**Exit criteria.** The complete migration set applies twice with an identical schema and identical row
counts; `raw_staging` is SELECT-denied as `authenticated`; `nexus_complete_agent_job` refuses while an
un-consumed staging row exists; the same SQL is exercised locally and (later, by ChatGPT) on Supabase.

**Notes.** The migrations were authored alongside this plan; P2's exit criteria are about *evidence*, not
about writing the files. Where the SQL diverges from the frozen outline, `docs/V1_2_MIGRATION_PLAN.md` §12
records the divergence and why.

### P3 — Server data layer

**Goal.** Every V1.2 read and write has one repository function with an explicit transaction, and the read
projections the UI needs are bounded aggregates rather than row scans.

**Areas.** `apps/web/src/lib/repo/` — new modules `agent-jobs.ts`, `enrichment.ts`, `raw-staging.ts`,
`ai-runs.ts`, `ai-context.ts`, `channel-accounts.ts`, `contact-points.ts`; existing `leads.ts`,
`ingest.ts`, `profile-capture.ts`, `companion.ts`, `today.ts`, `insights.ts` extended where the spec
changes their contract. `apps/web/src/lib/actor.ts` for the RLS transaction shape (unchanged in
mechanism).

**Deliverables.** Repositories that (a) never select a raw body, (b) never write `leads.status` from an
enrichment path, (c) read the new `security_invoker` views for counts, and (d) go through the
`SECURITY DEFINER` functions for anything touching `raw_staging` or an `agent_jobs` mutation.

**Verification.**

```
pnpm --filter @nexus/web run test
pnpm run typecheck
pnpm --filter @nexus/db run test
```

**Exit criteria.** A grep for `raw_staging` in `apps/web/src/lib/repo/` finds only calls to the six
`nexus_*_raw_*` functions and no direct `select`/`insert`/`update`/`delete`; a grep for `status` writes in
`enrichment.ts` finds no `leads.status` assignment; every new list read has a `limit`.

### P4 — AI orchestration

**Goal.** One door for every model call (spec §48), with the cache, the prompt registry and the ledger
behind it, and validation strictly before commit.

**Areas.** `apps/web/src/lib/ai/` — the one door is `runner.ts` (prompt resolution, cache lookup,
provider call, strict validation, ledger write, commit-ready payload); `prompts.ts` holds the prompt
builders and the prompt-key registry; `context-pack.ts` builds the Context Pack; `drafting.ts` and
`draft-outcome.ts` are refactored to call the runner rather than the transport. `config.ts`, `types.ts`
and `deepseek.ts` remain the transport. A per-task module is the natural split when a task grows its own
commit path.

**Deliverables.** The input-hash normaliser, the prompt resolver using `nexus_active_prompt`, the cache
lookup on the `ai_runs_cache_key` shape, the ledger writes for both hits and misses, the per-task failure
handling of spec §50, and commit functions whose write sets are exactly spec §49.1.

**Verification.**

```
pnpm --filter @nexus/web run test
pnpm run typecheck
```

Test names that must exist: `a second identical task is served from the cache with zero tokens`;
`a changed fact changes the input hash`; `a changed prompt version misses`;
`a schema-invalid answer writes nothing`; `a failure writes an ai_runs row with an error code`;
`no call is made with a missing DEEPSEEK_API_KEY`; `the ledger row contains no payload`.

**Exit criteria.** No call site outside `runner.ts` imports the transport; a page render performs no
provider call (asserted by a test that renders a lead screen with a recording provider and expects zero
invocations); a failed validation leaves the database byte-identical.

### P5 — MCP surface

**Goal.** The thirteen new tools are listed, schema-validated, scope-checked, idempotent, and
provenance-recording, and they cannot reach `COMPLETE` or a raw body.

**Areas.** `apps/web/src/app/api/v1/mcp/tool-schemas.ts` (schemas, idempotency map, catalogue
descriptions), `apps/web/src/app/api/v1/mcp/route.ts` (handlers, scope check, dispatch),
`apps/web/test/mcp-gateway.test.ts`, plus a new V1.2 MCP suite in `apps/web/test/`.

**Deliverables.** The tool entries; a documented scope per tool (spec §43.1); the `tools/list` catalogue
generated from the same schema that validates; a refusal for `nexus.complete_agent_job` by
non-existence — there is **no** such tool at all (spec §63.4).

**Verification.**

```
pnpm --filter @nexus/web run test
pnpm run typecheck
pnpm run lint
```

Per-tool cases that must exist: published schema; happy path; refusal naming the offending argument;
wrong scope (`-32003`); missing token (`-32001`); idempotency replay returning the first result with
`idempotent: true`; idempotency collision with a different payload refused; unknown tool `-32601`;
`database.execute_sql` unresolvable.

**Exit criteria.** The catalogue and the dispatch table agree for all thirteen tools; every mutating tool
requires an idempotency key; a scope that no RLS helper checks does not exist (finding F-9 closed for the
V1.2 surface).

### P6 — Agent job engine

**Goal.** The durable queue is real end to end: a job is created, claimed, heartbeated, submitted,
extracted, completed by the verified commit, and reaped when its agent dies.

**Areas.** Server processor (new module under `apps/web/src/lib/` — e.g. `agent-processor.ts`) calling
`nexus_claim_ai_work`, `nexus_complete_agent_job`, `nexus_reap_expired_job_leases` and
`nexus_cleanup_raw_staging`; the chaining rules (new module, using the determinism of
`packages/core/src/agent-jobs.ts`); `packages/db/test/v1-2-agent-jobs.test.ts` and
`packages/db/test/v1-2-raw-lifecycle.test.ts`.

**Deliverables.** The chaining table from spec §46.3 with a dedupe key and a `reason` for every automatic
job; a scheduled reaper and TTL sweep that are managed background jobs (not request-triggered); the
submit → extract → commit → delete-raw → complete sequence with no bypass.

**Verification.**

```
pnpm --filter @nexus/db run test
pnpm --filter @nexus/db run verify
pnpm --filter @nexus/web run test
```

Concurrency cases that must exist: two concurrent claims, exactly one winner; an expired lease
re-claimable; the reaper leaves nothing `RUNNING`; a submit never yields `COMPLETE`; completion refused
while an un-consumed staging row exists; a job at `max_attempts` becomes `FAILED` and is not claimable;
an automatic chain run twice creates one job.

**Exit criteria.** A job created with no agent online survives a process restart and is claimable
afterwards; a raw row is deleted before the job is `COMPLETE`; no code path other than
`nexus_complete_agent_job` writes `COMPLETE`.

### P7 — Intelligence completeness and deterministic search links

**Goal.** The score and the links are deterministic, testable and free.

**Areas.** `packages/core/src/enrichment.ts` (`intelligenceCompleteness`, `searchLinks`), with unit tests;
the fact assembly (which rows feed the inputs) in the server data layer.

**Deliverables.** The ten weights totalling 100 (name 12, company 12, location 6, `job_title` 10,
`linkedin` 14, `company_website` 8, `company_research` 12, `signals` 8, `ai_context` 10, `contacts` 8);
`missing_fields` in table order; the four link shapes with their keys `find_linkedin`, `search_person`,
`search_company`, `search_signals`.

**Verification.**

```
pnpm --filter @nexus/core run test
```

Test names that must exist: `weights total exactly 100`; `an empty lead scores 0 with all ten missing`;
`a complete lead scores 100 with no missing fields`; `the four link shapes match the spec exactly`;
`a missing term is omitted rather than producing an empty quoted string`;
`link building performs no AI call`.

**Exit criteria.** The same inputs produce the same score and the same URLs in any process; no link
contains `""`, `undefined` or `null`.

### P8 — Web UI

**Goal.** The V1.2 screens exist with the spec's hierarchy, the spec's columns, and no invented metrics.

**Areas.** `apps/web/src/app/b/[slug]/leads/` (table + row actions), `apps/web/src/app/b/[slug]/leads/[id]/`
(Lead Detail hierarchy), a new Agent Jobs route under the Integrations/Automation area,
`apps/web/src/app/b/[slug]/overview/`, `apps/web/src/app/b/[slug]/setup/` (the AI tab),
`packages/core/src/permissions.ts` (`ADMIN_NAV`, `ROUTE_PERMISSIONS`), `packages/ui/` for any shared
primitive.

**Deliverables.** Leads table with the thirteen columns and six row actions; Lead Detail in the fixed
order of spec §69.1; Agent Jobs screen with the five summary buckets and authorized actions only;
Overview with the eight metrics plus funnel and recent activity; Business Setup with six tabs; the
three-group IA with functioning secondary navigation; Access UX with tabs instead of concatenated links.

**Verification.**

```
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm --filter @nexus/web run test
```

Browser E2E (Playwright, per the existing `apps/extension/e2e` pattern) covering: the Lead Detail
hierarchy renders in order; `Find LinkedIn` produces the deterministic URL; a mutation is refused in the
UI when the action is refused on the server; a denied route is a 404; paging reports an accurate count.

**Exit criteria.** No screen renders a metric that is not in spec §71.1; no Agent Jobs action can set
`COMPLETE`; loading a lead screen issues no provider call and no raw read; the sidebar is three groups
deep, not 25 items.

### P9 — Companion V1.2

**Goal.** The MV3 extension keeps its security posture and gains the V1.2 lead flow, with the bind UX
defect fixed against migration `0035`.

**Areas.** `apps/extension/src/` (`api.ts`, `sidepanel.tsx`, `background.ts`, `chrome-actions.ts`,
`linkedin-adapter.ts`, `use-list-state.ts`), `apps/web/src/app/api/v1/companion/` (`bind`, `add`,
`leads`, `today`, `search`, `actions`), `apps/extension/e2e/`.

**Deliverables.** Binding with channel-account and business selection; the corrected business
intersection via `companion_visible_business_ids`; the specific reason code from
`companion_ineligible_reason` surfaced in the panel; Leads/Today/Search with the enrichment indicator;
minimal-lead Add to CRM; profile paste feeding the same staging pipeline; no raw re-display.

**Verification.**

```
pnpm --filter @nexus/extension run build
pnpm --filter @nexus/extension run e2e
pnpm --filter @nexus/extension run typecheck
pnpm --filter @nexus/extension run lint
pnpm --filter @nexus/extension run test
```

E2E cases that must exist: a global admin sees the businesses the selected account may send from; a
non-admin sees only the intersection; switching the account recalculates the list; an ineligible pair
returns a specific reason rather than a generic permission message; the extension bundle contains no
service-role key; adding a minimal lead makes it immediately searchable; pasted content is submitted and
not re-displayed.

**Exit criteria.** Every exit criterion above is asserted by a Playwright test, not by inspection.

### P10 — Verification and release

**Goal.** One frozen build, the whole gate green, the evidence recorded, the branch pushed.

**Areas.** No product changes; only the status note and the evidence record.

**Deliverables.** The gate output at the frozen SHA; the V1.2 test suites; a clean-checkout run of the
same gate at the same SHA; the branch pushed.

**Verification.** The full list in §6, in order, on a clean worktree.

**Exit criteria.** Every command green; the frozen-build hash identical before and after the run (the
method `docs/MCP_BASELINE_VERIFICATION.md` used); a clean checkout at the same SHA reproduces it; the
branch is pushed and nothing else is.

---

## 6. The release gate

### 6.1 Commands, in order

```
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run db:verify
pnpm run build
pnpm --filter @nexus/extension run build
```

### 6.2 Beyond the commands

| Gate | What it proves | Where |
| --- | --- | --- |
| Browser E2E | the Lead Detail hierarchy, the Leads actions and the enrichment workspace work in a browser | `apps/web` E2E (add to the existing Playwright setup) |
| Extension E2E | the Companion flows of P9 | `pnpm --filter @nexus/extension run e2e` |
| Migration / idempotency | `0030`–`0035` apply twice with no drift | `packages/db/test/migration-idempotency.test.ts` |
| Raw lifecycle | staging is unreachable, a commit deletes the row, the TTL sweep removes an abandoned row | `packages/db/test/v1-2-raw-lifecycle.test.ts` |
| Agent concurrency | one winner per claim, expired leases recoverable, no permanent `RUNNING`, no forged `COMPLETE` | `packages/db/test/v1-2-agent-jobs.test.ts` |
| V1.2 MCP | all thirteen tools: schema, scope, idempotency, refusal, validation | `apps/web/test/` V1.2 MCP suite |
| Clean checkout | the same gate on a fresh worktree at the same SHA | `docs/CLEAN_CHECKOUT_GATE.md` procedure |

### 6.3 Per-phase command map

| Phase | Minimum command set |
| --- | --- |
| P1 | `pnpm --filter @nexus/core run test` |
| P2 | `pnpm run db:verify` + `pnpm --filter @nexus/db run test` |
| P3 | `pnpm --filter @nexus/web run test` + `pnpm run typecheck` |
| P4 | `pnpm --filter @nexus/web run test` |
| P5 | `pnpm --filter @nexus/web run test` + `pnpm run lint` |
| P6 | `pnpm --filter @nexus/db run test` + `pnpm run db:verify` |
| P7 | `pnpm --filter @nexus/core run test` |
| P8 | `pnpm run build` + browser E2E |
| P9 | `pnpm --filter @nexus/extension run build` + `run e2e` |
| P10 | the whole of §6.1, plus §6.2 |

---

## 7. Dependency graph

```
P0 ──▶ P1 ──▶ P2 ──┬──▶ P3 ──┬──▶ P4 ──┬──▶ P5 ──┐
                   │         │         │         │
                   │         └──▶ P7   └──▶ P6 ──┴──▶ P8 ──▶ P9
                   │                          │
                   └──────────────────────────┴──────────▶ P10
```

Readings that matter:

- **P6 needs P4 and P5.** A submit that never becomes a commit is a queue that grows; the extraction path
  and the MCP submit path must both exist before the engine can be verified end to end.
- **P8 needs P6.** An Agent Jobs screen cannot be verified against a queue nothing drives.
- **P9 needs P7** only for the enrichment indicator's wording and the search links in the panel; the bind
  fix itself depends on P2's `0035`.
- **P10 needs everything**, and is the only phase that may push.

---

## 8. Risk register

| # | Risk | Impact | Mitigation | Owner |
| --- | --- | --- | --- | --- |
| R1 | A job reaches `COMPLETE` without a verified structured commit | the raw-deletion guarantee is fiction | completion is a database function that refuses while un-consumed staging exists (`0032`); no UI or MCP path to `COMPLETE`; a test asserts the refusal | Agent engine |
| R2 | Raw bytes survive in a log, an audit row, a job note or the ledger | the central V1.2 promise is broken | `nexus_mark_raw_failed` stores only a code; `agent_job_events.note` is short text; `ai_runs` has no body column; a secret/raw sweep over responses and logs | DB / migrations |
| R3 | `raw_staging` becomes tenant-reachable | cross-tenant raw disclosure | `FORCE` RLS with a `nexus_raw_writer`-membership policy; privileges revoked from `authenticated`; a denial test | DB / migrations |
| R4 | A hosted project cannot grant `nexus_raw_writer` membership to the migration role | the raw pipeline fails for every caller on that project | the required post-apply check in `docs/V1_2_MIGRATION_PLAN.md` §5.4; a manual `grant` remedy | DB / migrations |
| R5 | Enrichment state drifts into `leads.status` | the two axes collapse and V1 sequences misbehave | spec §12.2; a repository test that enrichment writes never touch `leads.status` | Server data layer |
| R6 | The AI cache returns a stale answer after a fact change | wrong facts reach a draft | the cache key covers the normalised input hash, so a changed fact is a different key; no manual flush exists; a test asserts the miss | Server AI |
| R7 | Cost per draft or extraction drifts upward invisibly | the AI feature becomes unaffordable | the `ai_runs` ledger plus `ai_usage_daily`; per-task output caps; cache-hit share on the Overview | Server AI |
| R8 | Two processors extract the same staged evidence | double commits and double spend | `nexus_claim_ai_work` is lease-guarded and skip-locked; an expired lease makes work reclaimable rather than lost | Agent engine |
| R9 | The UI presents a state the database does not hold (optimistic "ready") | an operator acts on a lead that is not ready | states are read from rows; the processing steps derive from `lead_enrichment`, `agent_jobs` and `agent_job_events`; no render-time work | Web UI |
| R10 | Migration order is applied differently on a hosted project than locally | a half-applied V1.2 | the exact order and dependencies in `docs/V1_2_MIGRATION_PLAN.md` §3; apply by ChatGPT after review, never by the implementer | Verification |
| R11 | The V1 scope vocabularies remain disjoint (finding F-9) for a new tool | a token that the catalogue says is sufficient is refused by RLS | the V1.2 tools reuse the RLS vocabulary; a new scope must be added on both sides in one change | MCP gateway |
| R12 | `prompt_versions_key_version_key` replacement behaves differently on live data | a migration failure on a hosted project | the replacement is strictly weaker in the global scope; idempotency test; a pre-flight row count on the target | DB / migrations |
| R13 | The extension ships a service-role key or an over-broad host permission | a security regression in the one component with browser access | the existing extension security audit criteria; a bundle grep test; MV3 policy unchanged | Companion |
| R14 | A V1.2 screen silently truncates a list at a hidden cap | an operator cannot reach work that exists | spec §68.4: accurate, reachable pagination; an E2E assertion on the reported count | Web UI |

---

## 9. Definition of done

9.1 V1.2 is done when, for one frozen SHA: the gate in §6.1 passes; the §6.2 suites pass; the acceptance
checklist in spec §83 is true line by line; and the branch `v1.2/ai-first-redesign` is pushed with nothing
else changed.

9.2 **Never claim COMPLETE if the following are only mocked** (spec §79.5). A mock is any of:

- a fixture standing in for a persistent row;
- a stub provider standing in for the extraction commit path;
- a UI state rendered without the row that produces it;
- a raw row that is never actually deleted;
- a job that reaches `COMPLETE` without a verified commit;
- an MCP tool that returns a canned structured result;
- a chained job that is created but never claimable.

9.3 A phase may hand over a deliberately incomplete surface **only** by recording it as incomplete in the
status note, with the reason. "Temporarily stubbed" is not a state a release can be in.

---

## 10. `> OPEN:` items that block a phase

An unanswered item must fail closed: refuse the operation or leave the behaviour unimplemented. A phase
must not guess a value to unblock itself.

| Spec item | Blocks | Effect while unanswered |
| --- | --- | --- |
| OPEN-1 discovery-source persistence | P3, P8 | `DISCOVERY_SOURCES` exists in code and normalises; the *stored* column remains `leads.source_type`, so a screen filters on the normalised projection until the storage decision is made |
| OPEN-2 bare-email lead creation | P5 (`nexus.submit_minimal_lead`) | a bare email is refused as the only identifier |
| OPEN-4 `leads.needs_profile` versus the enrichment state | P3, P6 | the trigger's initial state stands; nothing dual-writes |
| OPEN-5 readiness threshold | P3, P6, P8 | `READY` is not asserted by code; a lead can reach the other states |
| OPEN-6 `contacts` component rule | P7 | the strictest reading is implemented (a usable, non-deleted contact point) |
| OPEN-7 minimum score before sending | P8 | no score gate exists |
| OPEN-8 `person_contact_points.provenance` | P2, P3 | the implemented columns (`source`, `source_url`, `observed_at`, `agent_job_id`, `created_by`) are the provenance |
| OPEN-9 `(channel, display_name)` uniqueness | P2, P8 | the panel tolerates duplicates; no constraint claims otherwise |
| OPEN-10 `required_capabilities` values | P5, P6 | capabilities compare as sets; the values are advisory until ratified |
| OPEN-12 historical `source_evidence` bodies | P2 | nothing purges them; V1.2 paths stop writing them |
| OPEN-14 Context Pack body schema version | P4, P8 | a `schema` field inside the pack is written; no other versioning is promised |
| OPEN-15 cross-lead cache reuse | P4 | no cross-lead reuse |
| OPEN-16 price table location | P4, P8 | cost is estimated from a code-held table with the values marked provisional |
| OPEN-17 `/businesses` in the V1.2 IA | P8 | the screen keeps its V1 route and permission; its IA placement is unchanged until decided |
| OPEN-19 Upwork follow-up key | P4 | `upwork_proposal` is the only Upwork key |
| OPEN-20 prompt deactivation semantics | P4 | deactivation affects future runs only |
| OPEN-21 groundedness comparison | P4 | whitespace-normalised exact match |
| OPEN-22 level-4 confidence threshold | P4, P3 | a level-4 write must not replace level 2 or 3 regardless of confidence, so the threshold only affects level-4-vs-level-5 ordering (`confidence > 0.5` as the provisional floor) |
| OPEN-23 `nexus.submit_message_draft` validation | P4, P5 | the MCP path stores a submitted body without `validateMessage`; until it validates or marks the row as a manual edit, a submitted body is the client's responsibility and a stored draft is not an approval |

---

## 11. Handoff and reporting

11.1 Every phase report states: phase, SHA, commands run, raw result (pass/fail and the failing output),
files touched, and any exit criterion not met.

11.2 A phase report must not summarise a test that was skipped or an assertion that was loosened. If a
test was changed, the change is part of the report.

11.3 The final handoff to ChatGPT contains: the pushed branch name, the final SHA, the gate output, the
list of migrations to apply in order, the §13.2 manual checks from `docs/V1_2_MIGRATION_PLAN.md`, and the
open items of §10 with the behaviour that is consequently unimplemented.
