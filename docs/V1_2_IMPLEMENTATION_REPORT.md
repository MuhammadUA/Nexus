# NEXUS V1.2 — Implementation Report

**Branch:** `v1.2/ai-first-redesign` (pushed to `MuhammadUA/Nexus`)
**Source branch:** `integration/final`, treated as read-only
**Source SHA:** `50aa3c19005c7ac34777554ff4bbc7035c13aef4`
**Final V1.2 SHA:** `ef1c8ce` plus the documentation commit that carries this report;
the clean-checkout gate ran at `ef1c8ce` and only documentation follows it.
**Production / Supabase / Vercel:** not touched. Nothing was deployed, merged or
force-pushed; no tag was moved.

---

## 1. What was built

NEXUS V1.2 turns the CRM from a database-shaped tool into an AI-first sales OS:

* **A lead may now be incomplete and still be real.** Ingestion accepts a name, a
  company and a source; canonical Person/Company dedupe, provenance and an
  enrichment state are assigned, and nothing is invented to fill the gaps.
* **Sales state and enrichment state are separate axes.** `leads.status` is
  untouched; `lead_enrichment` carries completeness, missing fields, last
  profile/company/context timestamps and a typed last error.
* **Finding the profile is a human step, and it costs nothing to find.** Four
  deterministic Google queries are generated in code — never by a model.
* **DeepSeek is a first-class pipeline**, not a button: seven tasks, each with a
  versioned prompt, a strict schema, an input-hash cache and a ledger row.
* **Raw bodies are ephemeral by construction.** A pasted profile or a research
  dump is staged, extracted, validated, committed, verified, and then deleted; an
  abandoned body dies on a 24h TTL. Only metadata survives.
* **Agent work is durable.** OpenCode lists, claims, heartbeats and submits
  through MCP; a job reaches `COMPLETE` only after a structured commit, and the
  database — not the agent — enforces that.
* **Discovery source and outreach channel are different concepts**, with four
  first-class channels (LinkedIn, email, Instagram, Upwork).
* **The Lead screens lead with intelligence**, not with columns.

## 2. Commits

| SHA | Commit |
| --- | --- |
| `e2c1dce` | `feat(db): V1.2 enrichment state, ephemeral raw staging, agent jobs and AI ledger` |
| `89f0638` | `feat(core): V1.2 vocabulary, deterministic enrichment helpers and agent job planning` |
| `c1de7f4` | `feat(mcp): V1.2 agent job and lead intelligence tools` |
| `330806c` | `fix(mcp): validate submitted drafts, and record the discovery source as provenance` |
| `4e787a7` | `docs: V1.2 agent jobs, AI pipeline, MCP contract, UI acceptance and test report` |
| `69edb09` `0aecf20` `197c84a` `c4b4a43` `4446b5e` | the application: Companion, AI pipeline, Leads/Lead Detail, Agent Jobs + AI settings + navigation, Overview/Insights/Channel Accounts |
| `7bd1d76` `ab29f66` `83f24e1` `ef1c8ce` | integration fixes, the document set, the browser E2E suite and its three defects, and the last MCP corrections |

## 3. Migrations (additive, forward-only)

| Migration | Contains |
| --- | --- |
| `0030_channel_accounts_and_contact_points.sql` | `outreach_identities.channel` (backfilled from `platform`), widened platform CHECK, `channel_accounts` view (`security_invoker`), `person_contact_points` + its policies/indexes |
| `0031_lead_enrichment_and_raw_staging.sql` | `lead_enrichment` + seed trigger + backfill, `raw_staging` + the `nexus_raw_writer` role and its policy, the staging/read/delete/fail/cleanup functions, `source_evidence` V1.2 provenance columns |
| `0032_agent_jobs.sql` | `agent_jobs`, `agent_job_events`, the dedupe index, and the create/claim/heartbeat/release/fail/cancel/submit/complete/reap functions |
| `0033_ai_runs_prompts_context.sql` | `ai_runs` + cache index, `prompt_versions` extended (business override, sampling, active flag) and `nexus_active_prompt`, `ai_context_packs` |
| `0034_v1_2_processor_and_read_models.sql` | `nexus_claim_ai_work`, `nexus_retry_agent_job`, `ai_usage_daily` / `agent_job_queue_summary` / `lead_enrichment_funnel` views, V1.2 read indexes |
| `0035_companion_binding_scope.sql` | corrected `companion_visible_business_ids`, `companion_ineligible_reason`, the `browser_sessions` bind-scope trigger |

Nothing destructive, nothing renamed, and no applied migration was rewritten. The
one V1.1 constraint V1.2 replaces is `prompt_versions_key_version_key`, because a
global default and a business override may legitimately share `(key, version)`; it
is replaced by two partial uniques. Two additive details that keep the migration
safe on live data: `lead_enrichment` is backfilled for existing leads, and the
"one active prompt per (scope, key)" rule is enforced by the resolver plus a
transactional activation rather than by a unique index that existing rows could
violate. Details: `docs/V1_2_MIGRATION_PLAN.md`.

## 4. RLS and tenancy

Every new table is `ENABLE` + `FORCE` row level security with explicit policies:

| Table | Read | Write |
| --- | --- | --- |
| `lead_enrichment` | `has_business_access(business_id)` | `has_business_access` |
| `raw_staging` | **nobody but the server**: a single policy satisfied only by members of `nexus_raw_writer`, privileges revoked from `authenticated` and `anon`; all access through capability-checked `SECURITY DEFINER` functions | same |
| `agent_jobs`, `agent_job_events` | `has_business_access` | **no write policy at all** — every mutation goes through a function, so `COMPLETE` cannot be forged by an `UPDATE` |
| `ai_runs` | `has_business_access` | `has_business_access` (no delete) |
| `ai_context_packs` | `has_business_access` | `has_business_access` |
| `person_contact_points` | `person_visible(person_id)` | admin, a lead-source-permissioned user, or an API client |
| `prompt_versions` | global rows to any signed-in actor, overrides to that business | admin only |

`pnpm run db:verify` fails the build if a table with a `business_id` is missing
`FORCE ROW LEVEL SECURITY`, and it also fails if any SQL-execution function exists.
Both pass. Existing audit, DNC and SENT-immutability behaviour is unchanged and
still covered by the V1.1 suites.

## 5. API and MCP

`POST /api/v1/mcp` gains **thirteen** tools (see `docs/V1_2_MCP_CONTRACT.md`):
`create_agent_job`, `list_agent_jobs`, `get_agent_job`, `claim_agent_job`,
`heartbeat_agent_job`, `release_agent_job`, `submit_agent_job_result`,
`fail_agent_job`, `get_lead_enrichment_context`, `submit_minimal_lead`,
`submit_profile_data`, `submit_company_research`, `submit_source_metadata`.
Scopes `jobs:read`, `jobs:create`, `jobs:claim`, `jobs:submit` were added to
`API_SCOPES` and the three writing ones to `WRITE_SCOPES`, so a token can actually
be granted them from the integrations UI.

New routes: `POST /api/v1/enrichment` (human-assisted profile enrichment),
`POST /api/v1/enrichment/company-job` (automatic chaining), `POST /api/v1/ai/processor`
(bounded, idempotent batch processor — the future Vercel Cron target) and
`GET /api/v1/ai/usage`.

There is **no** tool that accepts SQL and none that can complete a job. A client
never receives a database credential.

Two defects found during integration were fixed:

* `nexus.submit_message_draft` stored a submitted body without validating it and
  labelled it `is_manual_edit = false`, so an unapproved numeric claim or a
  prohibited phrase could be persisted through MCP and then sent. It now runs the
  same `validateMessage` and assertable-claim set the drafting path uses, refuses
  the violations that make text unsafe to send, returns the style rules as
  warnings, and writes `is_manual_edit = true`.
* The ingest pipeline recorded the *transport* as the discovery source and
  hard-coded `leads.source_type`. It now persists the discovery source as
  provenance in `source_evidence.source` and projects it onto the V1.1 vocabulary.

## 6. Application architecture

```
apps/web/src/lib/repo/       enrichment.ts   - completeness facts, state, chaining data
                             agent-jobs.ts   - queue reads + the agent-facing operations
                             raw-staging.ts  - the only door to raw_staging
apps/web/src/lib/ai/         prompts.ts      - versioned prompts + activation
                             tasks.ts        - the seven task contracts and their schemas
                             runner.ts       - cache, provider call, ledger
                             context-pack.ts - permanent-facts-only context
                             extract.ts      - the raw lifecycle and merge precedence
                             pipeline.ts     - bounded processor (reap, TTL, claim, extract, chain)
```

The AI provider boundary (`lib/ai/types.ts`) is unchanged, so a second provider is
a new implementation of one interface rather than a refactor. `DEEPSEEK_API_KEY`
remains server-only; a missing key is a typed `provider_not_configured` state, not
a crash.

## 7. Agent jobs

Durable rows, atomic claim (`FOR UPDATE SKIP LOCKED` inside one `UPDATE`), leases
with heartbeat, reaping of expired leases, capped retries and typed failures.
Automatic chaining is a pure function (`planChainedJobs`) that is loop-free by
construction and deduplicated by a partial unique index. `COMPLETE` is reachable
only from `WAITING_AI` and only when no un-consumed staging row remains for the
job. Full detail: `docs/V1_2_AGENT_JOBS.md`.

## 8. Raw lifecycle and deletion proof

Order, as implemented and asserted: receive raw → stage → read → DeepSeek extract →
validate → commit structured facts → commit provenance → verify → **delete raw** →
advance enrichment state / complete the job. On failure the body is marked
`FAILED` and retained for the retry; a 24h TTL sweep removes anything abandoned.

The proof is a database-level test suite (`packages/db/test/v1-2-raw-lifecycle.test.ts`,
7 tests) rather than an assertion about application code: a tenant role cannot read
staging at all, a successful consume removes the row (verified by the owner, so
"gone" is not "invisible to me"), a failure keeps it and a retry deletes it, TTL
removes an abandoned row and leaves a live one, and the payload appears in neither
the audit ledger nor an error code while the hash, byte count, collector agent and
model do survive.

## 9. Source / channel separation

`DISCOVERY_SOURCES` (16 values) and `OUTREACH_CHANNELS` (4 values) are separate
vocabularies with separate columns and separate UI concepts. The completeness of
the separation is asserted rather than asserted-in-prose: every discovery source
maps to all four channels, the MCP minimal-lead tool returns all four channels for
a Reddit-sourced lead, and the enrichment context offers email for a lead found on
Reddit. `outreach_identities.channel` carries the outgoing channel while the legacy
`platform` is retained for historical attribution, and the Companion's LinkedIn
binding is preserved through the same table and the same business-access rows.

## 10. Create User and Companion binding

* **Create User** was already corrected on `integration/final` (commit `4098c69`,
  removing the `users.created_by` insert). V1.2 verified it and there is no
  remaining `users.created_by` assumption anywhere in `apps/`: every
  `insert into public.users` in the repository, the bootstrap script, the seed and
  the tests names columns that exist. The regression suite
  (`apps/web/test/team-create-user.test.ts`, 12 tests) covers no password, a valid
  password, no grant, an initial grant, a duplicate email, an invalid password and
  a non-admin refusal.
* **Companion binding** now shows only the businesses valid for the selected
  channel account, recalculates on account switch, handles a global admin
  correctly, disables Bind with a specific reason when nothing is eligible, and
  refuses a crafted invalid pair server-side (`0035` adds both the corrected
  visibility function and a trigger that enforces the same rule on the write).

## 11. Documents

Product-level: `product/NEXUS_V1_2_MASTER_SPEC.md`,
`docs/V1_2_IMPLEMENTATION_PLAN.md`, `docs/V1_2_MIGRATION_PLAN.md`,
`docs/V1_2_AI_COST_CONTROL.md`, `docs/OPENCODE_AGENT_WORKFLOW.md`,
`docs/CHATGPT_MCP_WORKFLOW.md`.
Implementation-level: `docs/V1_2_AI_PIPELINE.md`, `docs/V1_2_AGENT_JOBS.md`,
`docs/V1_2_MCP_CONTRACT.md`, `docs/V1_2_UI_ACCEPTANCE.md`,
`docs/V1_2_TEST_REPORT.md`, and this report. All historical documents are
preserved.

## 12. Gate results and the clean-checkout run

The full release gate was run from a **clean worktree** (`git worktree add --detach
E:\CRM\v12-cleancheck v1.2/ai-first-redesign`, at the code commit `ef1c8ce`) after
`pnpm install --frozen-lockfile`. Nothing depended on this machine's scratch state:
the web E2E suite provisions its own database in the OS temp directory and removes it
afterwards, and the extension suite seeds a fresh demo database inside the worktree.

```
pnpm install --frozen-lockfile                     pass (3.2s)
pnpm run typecheck                                 pass — 5 packages, no errors
pnpm run lint                                      pass — --max-warnings 0 per package
pnpm run test                                      pass — 41 files, 704 tests
pnpm run db:verify                                 pass — 35 migrations, 71 tables,
                                                   198 policies, 111 triggers,
                                                   127 functions, 218 indexes
pnpm run build                                     pass — Next.js production build
pnpm --filter @nexus/extension run build           pass — manifest valid, no credentials
pnpm --filter @nexus/web run e2e                   pass — 15 tests
pnpm --filter @nexus/extension run e2e             pass — 38 tests
```

Per suite: `@nexus/core` 144, `@nexus/db` 110, `@nexus/web` 441, `@nexus/extension`
(unit) 9. The extension E2E baseline on `integration/final` was 36 passed / 2 skipped;
it is now 38 passed / 0 failed, with the two previously skipped cases covered by the
account-scoped bind work. Full detail: `docs/V1_2_TEST_REPORT.md`.

The only commits after the gated commit are documentation, so the result applies to
the final tree of the branch.

### Defects the new browser E2E found and that are fixed here

1. **Lead Detail answered 500 in a production build.** `processingSteps()` and
   `missingSearchLinks()` were exported from a `'use client'` module and called by the
   Server Component page; Next.js treats every export of a client module as a client
   reference. Both derivations now live in dedicated server-safe modules
   (`lib/lead-processing-steps.ts`, `lib/lead-search-links.ts`).
2. **Every load of that page produced a hydration mismatch (React #418).** The shared
   `PageHead` rendered its `subtitle` prop inside a `<p>` while the page passes a row
   of chips, so the browser closed the paragraph early. The element is now a `<div>`
   with the same class, which fixes every caller of the primitive.
3. **The Companion's search blanked the side panel.** The search projection nested the
   enrichment indicator while the panel and its own type read it flat, so
   `EnrichmentChip` received `undefined` and threw inside render. The projection is
   flat like every other Companion projection, and the presentation helpers now accept
   `unknown` so a future shape drift degrades to a neutral chip.
4. `nexus.submit_message_draft` stored a submitted body unvalidated and labelled it
   model-generated (see §5), and `nexus.submit_source_metadata` ignored the
   `observed_at` it accepted.


## 13. Limitations and known gaps

Carried forward honestly rather than papered over:

1. **No live provider call was made on this host.** `DEEPSEEK_API_KEY` is unset, so
   the AI pipeline is proven with injected provider mocks and the live provider is
   `PENDING_DEPLOYMENT_ENV`. `node apps/web/scripts/smoke-deepseek.mjs` confirms it
   in one command after the key is set.
2. **The extension E2E suite needs a running seeded Nexus and a real Chrome.** Its
   expectations were written against the pre-V1.2 bind panel, where the business
   selector listed every business the user could see. The selector is now scoped to
   the selected channel account (spec §36), so those specs must choose the account
   before reading the business list. The specs are deterministic and the bind path
   is strictly safer, but the drift is real and is recorded in
   `docs/V1_2_TEST_REPORT.md`.
3. **Pre-existing 3-valued-logic hole in `manages_outreach_identity` (0017).** The
   function returns `NULL` rather than `false` when the JWT claims carry no `role`
   key, so `if not public.manages_outreach_identity(...)` inside
   `validate_browser_session_identity` evaluates to `NULL`, and the trigger does not
   raise. It is **not reachable through RLS** — the `browser_sessions_insert` policy
   requires the same call to be `true`, and `NULL` is treated as a refusal — so only
   a writer with `BYPASSRLS` could reach it, and the bootstrap/seed path sets
   `role = 'service_role'` and is admitted explicitly. The V1.2 helper
   `companion_ineligible_reason` coalesces it. The clean fix is a forward-only
   migration wrapping that expression in `coalesce(..., false)`; it was left out of
   this branch to avoid touching V1.1 trigger behaviour at the end of integration,
   and is the first item to consider for V1.2.1.
4. **`prompt_versions` has no unique index enforcing "one active version per
   (scope, key)".** Live V1.1 rows would all become active at once, so such an index
   would fail the migration on a real project. Activation is transactional and
   `nexus_active_prompt` resolves the highest active version, so a deployment that
   somehow holds two behaves deterministically.
5. **`leads.source_type` still carries the V1.1 vocabulary.** The V1.2 discovery
   source is persisted as provenance in `source_evidence.source`; widening the
   CHECK was deliberately avoided because a deployed CHECK cannot be narrowed again
   safely and nothing in V1.2 needs it.
6. **A per-business AI daily spend cap is not enforced.** Tokens, cost and cache
   hits are recorded per run and aggregated per day; a cap would need a policy
   decision about what to do when it is reached (fail the task, queue it, or alert),
   which is recorded as an open item in the master spec rather than guessed at.
7. **`ai_context_packs` is not garbage-collected.** Packs are keyed by the hash of
   the facts they were built from and are cheap, but old rows accumulate. A retention
   sweep belongs with the TTL cleanup function when a policy exists.
8. **The web browser E2E suite asserts structure, not data**, because a fresh
   database has no leads. It proves the screens, the deterministic search links and
   the absence of a manual complete action; it does not prove a full enrichment
   round trip, which the PGlite suites do.
9. **Two of the seven AI tasks are implemented but not yet invoked from a product
   flow.** `ICP_QUALIFICATION` and `REPLY_CLASSIFICATION` both exist as first-class
   tasks — versioned prompt (`icp_qualify`, `reply_classify`), strict schema, input
   hashing, cache lookup, ledger row with tokens and cost — and are callable through
   the same `runAiTask` the other five use, so the pipeline and cache correctness
   apply to them unchanged. What is missing is the call site and its persistence:
   * `ICP_QUALIFICATION` should run as the `QUALIFY_LEAD` job the chaining table
     names (`QUALIFY_LEAD:<lead_id>`, master spec §36) and write the decided ICP to
     `lead_icp_matches` through the audited `set_primary_icp`. Until then the fit and
     intent the Lead screens show come from the deterministic `lead_icp_matches`
     rows the ingest pipeline writes, and the Brief's confidence is the derived
     figure — no qualification score is invented. A hand-created `QUALIFY_LEAD` job
     fails with the typed `no_processor_for_job_type`, which is visible in the queue
     rather than silently stuck, and automatic chaining never creates one.
   * `REPLY_CLASSIFICATION` should run from the reply-capture path and write the
     proposed outcome and reason to `conversation_outcomes` and an `interactions`
     row (master spec §64.5), leaving the verbatim inbound text untouched. Until
     then reply capture is exactly V1.1 behaviour — the exact text verbatim, the
     operator's outcome, DNC and sequence pausing intact, which the DNC and reply
     suites still assert.

   Both are additive: no schema change is needed for either, because the target
   tables already exist and the runner already records the attempt.

## 14. Deployment actions for ChatGPT

Ordered, and nothing here has been done on this branch.

**1. Apply the migrations to the target PostgreSQL/Supabase project, in order.**
Only additive migrations; no data backfill script is required beyond what the
migrations do themselves (`lead_enrichment` for existing leads,
`outreach_identities.channel` from `platform`).

```
0030_channel_accounts_and_contact_points.sql
0031_lead_enrichment_and_raw_staging.sql
0032_agent_jobs.sql
0033_ai_runs_prompts_context.sql
0034_v1_2_processor_and_read_models.sql
0035_companion_binding_scope.sql
```

Before applying, confirm the `nexus_raw_writer` role can be created and granted to
the migration role (0031 does this inside an exception-tolerant block; if the grant
is refused, the `raw_staging` policy still keeps tenants out, and the definitions
should be re-run as the owner). After applying, run the post-checks listed in
`docs/V1_2_MIGRATION_PLAN.md` §12 and confirm:
`select count(*) from pg_policies where schemaname = 'public'` is at least 198, and
`select relname from pg_class where relkind = 'r' and relrowsecurity and not
relforcerowsecurity` returns no table with a `business_id`.

**2. Set the environment.**
* `DEEPSEEK_API_KEY` — server-side only, never prefixed `NEXT_PUBLIC_`.
* `DEEPSEEK_BASE_URL` (default `https://api.deepseek.com`), `DEEPSEEK_MODEL`
  (default `deepseek-chat`), optionally `DEEPSEEK_TIMEOUT_MS`,
  `DEEPSEEK_MAX_ATTEMPTS`, `DEEPSEEK_RETRY_BASE_MS`.
* `NEXUS_DB_SERVICE_ROLE=nexus_service` on a hosted project, so the runtime never
  needs database ownership.
* No new client-side variable is introduced; there are still no `NEXT_PUBLIC_*`
  secrets.

**3. Seed the global prompt versions** by opening any business's Business Setup → AI
tab as an administrator (it calls `ensureDefaultPrompts`), or by calling
`resolvePrompt` once per key. Without this the pipeline falls back to the built-in
defaults, which is functional but leaves the settings screen empty.

**4. Configure the processor on a schedule** — the one piece that is deliberately
left to the deployment:

```
POST /api/v1/ai/processor       { "limit": 5 }      every 5 minutes
```

The caller must be an administrator session or a service token holding
`jobs:submit` scoped to the target business. A Vercel Cron entry with a service
token is the intended shape; a 5-minute cadence keeps an abandoned staging row's
lifetime at 24h plus at most one interval. The route is idempotent, bounded and safe
to call concurrently (the work claim is lease-guarded).

**5. Create the agent tokens.**
* OpenCode: `jobs:read`, `jobs:claim`, `jobs:submit` scoped to the businesses it
  works. It never needs `jobs:create` unless ChatGPT-style planning is intended.
* ChatGPT: `businesses:read`, `lead:read`, `lead:create`, `jobs:read`,
  `jobs:create`, `note:add`, `task:create`, `message:draft`.
Scopes are granted from the integrations UI; `jobs:*` became assignable in this
branch, so an existing client must be re-saved to pick them up.

**6. Verify after deployment, in this order.**

```
node apps/web/scripts/smoke-deepseek.mjs          # live provider, capped tokens
curl -s $NEXUS_ORIGIN/api/v1/mcp                   # tool list
# then, through MCP with the OpenCode token: list_agent_jobs -> claim -> submit
```

**7. Do not promote until** a single real enrichment has been watched end to end:
stage a paste, confirm the structured commit, confirm the `raw_staging` row is gone
(`select count(*) from public.raw_staging where lead_id = '<id>'` is 0), and confirm
the job reached `COMPLETE` only after that.

**8. Two follow-ups that are deliberately not in this branch** (limitations §13.9,
both additive and schema-free): invoke `ICP_QUALIFICATION` from the `QUALIFY_LEAD`
job and write the decision through `set_primary_icp`, and invoke
`REPLY_CLASSIFICATION` from the reply-capture path into `conversation_outcomes` and
`interactions`. The prompts, schemas and ledger rows already exist, so each is a
call site plus its persistence, not new plumbing.

