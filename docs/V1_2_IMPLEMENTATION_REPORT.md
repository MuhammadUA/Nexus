# NEXUS V1.2 — Implementation Report

**Branch:** `v1.2/ai-first-redesign` (pushed to `MuhammadUA/Nexus`)
**Source branch:** `integration/final`, treated as read-only
**Source SHA:** `50aa3c19005c7ac34777554ff4bbc7035c13aef4`
**Final V1.2 SHA:** the head of `v1.2/ai-first-redesign` after the AI call-site commit
in §15; the clean-checkout gate ran at `ef1c8ce`, and the only commits after it are the
gate report, the disclosure of the two then-unwired tasks, and the change that wired
them (which re-ran the whole gate — see §12).
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
| `e658b80` `a8580b1` | the clean-checkout gate results, and the disclosure of the two AI tasks that had no caller yet |
| `SELF` | `feat(ai): invoke ICP qualification and reply classification, and process model-only agent jobs` — the call sites, the persistence, migration `0036` and 17 new tests (see §15) |

## 3. Migrations (additive, forward-only)

| Migration | Contains |
| --- | --- |
| `0030_channel_accounts_and_contact_points.sql` | `outreach_identities.channel` (backfilled from `platform`), widened platform CHECK, `channel_accounts` view (`security_invoker`), `person_contact_points` + its policies/indexes |
| `0031_lead_enrichment_and_raw_staging.sql` | `lead_enrichment` + seed trigger + backfill, `raw_staging` + the `nexus_raw_writer` role and its policy, the staging/read/delete/fail/cleanup functions, `source_evidence` V1.2 provenance columns |
| `0032_agent_jobs.sql` | `agent_jobs`, `agent_job_events`, the dedupe index, and the create/claim/heartbeat/release/fail/cancel/submit/complete/reap functions |
| `0033_ai_runs_prompts_context.sql` | `ai_runs` + cache index, `prompt_versions` extended (business override, sampling, active flag) and `nexus_active_prompt`, `ai_context_packs` |
| `0034_v1_2_processor_and_read_models.sql` | `nexus_claim_ai_work`, `nexus_retry_agent_job`, `ai_usage_daily` / `agent_job_queue_summary` / `lead_enrichment_funnel` views, V1.2 read indexes |
| `0035_companion_binding_scope.sql` | corrected `companion_visible_business_ids`, `companion_ineligible_reason`, the `browser_sessions` bind-scope trigger |
| `0036_lead_qualification.sql` | the qualification columns on `lead_icp_matches` (intent score, angle, reasons, disqualifiers, confidence, run id, qualified-at, input hash) with their checks and indexes, plus `nexus_claim_ai_direct_work` and `nexus_complete_direct_agent_job` for model-only jobs |

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

## 12. Gate results

The full release gate was run twice: once from a **clean worktree** (`git worktree add
--detach E:\CRM\v12-cleancheck v1.2/ai-first-redesign`) at the code commit `ef1c8ce`,
and again in the integration tree after the AI call sites in §15 landed (migration
`0036`, 17 new tests). Nothing depended on this machine's scratch state: the web E2E
suite provisions its own database in the OS temp directory and removes it afterwards,
and the extension suite seeds a fresh demo database in `apps/web/.data`.

```
pnpm install --frozen-lockfile                     pass (3.2s)
pnpm run typecheck                                 pass — every package, no errors
pnpm run lint                                      pass — --max-warnings 0 per package
pnpm run test                                      pass — 42 files, 730 tests
pnpm run db:verify                                 pass — 36 migrations, 71 tables,
                                                   198 policies, 111 triggers,
                                                   129 functions, 220 indexes
pnpm run build                                     pass — Next.js production build
pnpm --filter @nexus/extension run build           pass — manifest valid, no credentials
pnpm --filter @nexus/web run e2e                   pass — 15 tests
pnpm --filter @nexus/extension run e2e             pass — 38 tests
```

Per suite: `@nexus/core` 154, `@nexus/db` 110, `@nexus/web` 457, `@nexus/extension`
(unit) 9. The extension E2E baseline on `integration/final` was 36 passed / 2 skipped;
it is now 38 passed / 0 failed, with the two previously skipped cases covered by the
account-scoped bind work. Full detail: `docs/V1_2_TEST_REPORT.md`.

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
9. ~~**Two of the seven AI tasks are implemented but not yet invoked from a product
   flow.**~~ **Closed in this branch — see §15.** Both tasks now have a call site and
   a persistence path, and `QUALIFY_LEAD` is processed rather than failing with
   `no_processor_for_job_type`.

## 15. Closing the AI call sites (qualification and reply classification)

The two tasks that existed as contracts without a caller are now invoked, persisted
and tested end to end. Nothing was redesigned: the prompts, schemas, runner, cache
key and ledger are the ones already in the branch, and the new migration only adds
the columns and the two functions the call sites need.

### 15.1 `ICP_QUALIFICATION` as the `QUALIFY_LEAD` job

* **Planned from facts, by the existing planner.** `planChainedJobs` gained an
  optional `qualification` input; when the caller supplies it, a `QUALIFY_LEAD` plan
  is produced only when the prerequisites hold, the state allows it, and the stored
  answer does *not* already cover the current input. The prerequisites are
  `qualificationPrerequisites()` in `@nexus/core`: a resolved person, a resolved
  company, and at least one piece of intelligence (company research, a signal, or an
  existing context pack). Without qualification state the planner plans nothing —
  the conservative default, so a caller that cannot judge staleness cannot cause a
  model call.
* **Claimed from `OPEN`.** These jobs are created `OPEN` by the planner, and
  `nexus_claim_ai_work` only takes `WAITING_AI` (jobs an agent staged evidence for).
  Migration 0036 adds `nexus_claim_ai_direct_work`, the same lease-guarded,
  `SKIP LOCKED`, attempt-counted claim, for jobs whose whole work is a model call.
  This also fixed a **pre-existing stuck state**: `BUILD_CONTEXT` was planned by the
  chaining table but never claimable, so those rows sat `OPEN` for ever and the
  processor's `BUILD_CONTEXT` branch was unreachable.
* **Run through the shared runner.** `lib/ai/qualification.ts` projects the facts
  (person, company, research summary, up to twelve signals, contact kinds, ICP
  criteria), hashes them, and calls `runAiTask` with the versioned `icp_qualify`
  prompt, the task's own schema and temperature, and the resolved prompt version.
* **Cached on the input, requalified on change.** The hash covers the facts, the
  criteria, the prompt version and the model. `loadCached` materialises the stored
  answer, so identical facts cost nothing and write a `CACHED` ledger row; changed
  facts produce a new hash, which is the only trigger requalification needs. The
  "is this answer current?" check consults both `lead_icp_matches.input_hash` and the
  newest `SUCCEEDED` run, so a lead the model could not match to an ICP does not buy
  the same answer on every pass.
* **Persisted through the domain path.** A chosen ICP is applied with the audited
  `set_primary_icp` (business check, single primary, `leads.primary_icp_id`, audit
  event) and only when it actually changes; the rest of the answer — fit, intent,
  reasons, disqualifiers, recommended angle, confidence, run id, input hash, the
  timestamp — is written onto that match row. A model that names no ICP (or an ICP
  from another business) does not get to invent a primary; the assessment lands on
  the lead's existing primary match, and if the lead has no match at all the ledger
  row is the record. A lead carrying `primary_icp_id` without a match row (an import)
  is materialised through the same audited function rather than silently dropping a
  paid-for answer.
* **Context updates itself.** Because the pack's input hash includes the match score,
  intent and reason, a qualification invalidates the stored pack by construction. The
  processor rebuilds it right after a successful qualification, so the draft prompt
  sees the new fit and intent — and `buildContextPackInput` now reads the intent
  score and angle from the match row instead of the hard `null` that the old comment
  promised qualification would fill in.
* **Failures are typed and leave the lead alone.** `prerequisites_unmet` and
  `lead_not_found` are non-retryable and cost zero tokens; provider failures carry
  the runner's own code and retryability; a persistence failure returns
  `commit_failed` with the ledger row already written and no partial score or
  half-applied ICP. A terminal failure is recorded on the job so the queue shows it.
* **No duplicate work.** The dedupe key is `QUALIFY_LEAD:<leadId>:<scope>` under the
  existing partial unique index over open jobs, and the input-hash check stops a new
  job once the answer matches.

### 15.2 `REPLY_CLASSIFICATION` on the reply-capture path

* **Capture first, always.** All three capture paths — the business lead page
  (`captureReplyAction`), the Companion (`capture-reply`), and MCP
  (`nexus.capture_reply`) — now run `capture_reply` to completion and only then
  classify. The classification is best-effort by construction
  (`classifyCapturedReplyQuietly` returns its failures and never throws), so a
  missing provider key, a rate limit or a schema failure cannot turn a saved reply
  into an error. It is deliberately not fire-and-forget: a floating promise can be
  killed with the request, and the capture has already committed, so awaiting it is
  what makes "classification happens afterwards" a guarantee rather than a wish.
* **The verbatim text is never touched.** The reading is a new `interactions` row
  (`type = 'system'`, `direction = 'internal'`, `source_client = 'ai_pipeline'`)
  carrying the structured reading and its provenance. No statement in the module
  updates a reply interaction, and the reading deliberately does not repeat the reply
  text — there is one copy of the bytes, in the row `capture_reply` wrote.
* **The captured outcome stands.** `conversation_outcomes.outcome` and `is_terminal`
  are never written by this path, so a reply captured as `Do not contact` remains DNC
  even when the model reads it as interested; the disagreement is recorded
  (`agrees_with_captured_outcome: false`) rather than acted on. Only an empty
  `reason` is filled, so an operator's note is never overwritten. DNC suppression and
  sequence pausing remain the trigger's and the RPC's work.
* **Cached only where it is safe.** The input hash covers the exact reply text, the
  reply interaction, the channel, the bounded prior-outreach summary and the prompt
  version, so re-asking about the *same* reply reuses the stored reading while a
  different reply with identical words can never be served it.

### 15.3 What this adds to the schema

Migration `0036_lead_qualification.sql` is additive and forward-only:

* seven columns on `lead_icp_matches` (intent score, recommended angle, reasons,
  disqualifiers, confidence, ai-run id, qualified-at, input hash) with their checks
  and two partial indexes;
* `nexus_claim_ai_direct_work(limit, business, lease, types, capabilities)` and
  `nexus_complete_direct_agent_job(job, ai_run, agent)`.

The completion rule is unchanged in substance: the job must be held by the claiming
processor, and no un-consumed `raw_staging` row may remain for it. For a model-only
job there is no staged body at all, and the caller has already persisted the
structured result before it completes.

### 15.4 Evidence

`apps/web/test/v1-2-qualification.test.ts` (16 tests) drives the real planner, the
real claim function, the real runner and the real persistence with injected
providers, and asserts the whole list: chaining into qualification, the job actually
processed and completed, the primary ICP and assessment persisted, no second provider
call for unchanged facts, requalification with a new hash and a new ledger row on
changed facts, a typed non-retryable failure leaving the lead untouched, the exact
reply saved when classification fails, the reading stored separately, DNC remaining
authoritative, the ledger recording both tasks with tokens and cost, and the staged
raw marker absent from every row and prompt this work writes. A tenth of the suite
runs through the MCP transport (`v1-2-mcp-agents.test.ts`): a reply captured by
`nexus.capture_reply` with no provider configured answers `captured: true` with
`classification: null` and a typed `classification_error`.


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
0036_lead_qualification.sql
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

This schedule is also what runs **ICP qualification and context building**: the same
pass claims the model-only jobs (`QUALIFY_LEAD`, `BUILD_CONTEXT`) created by the
chaining planner, runs the versioned tasks, persists the result and completes the
job. No additional schedule or manual step is needed, and a qualification is never
planned twice for the same facts.

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

**8. Watch one qualification and one reply too**, in the same sitting:

```sql
-- The qualification ran, was paid for, and is attached to the lead.
select status, cache_hit, tokens_in, tokens_out, estimated_cost_usd, prompt_version_id
  from public.ai_runs where task = 'ICP_QUALIFICATION' order by created_at desc limit 3;
select icp_id, is_primary, match_score, intent_score, reasons, recommended_angle, input_hash
  from public.lead_icp_matches where lead_id = '<id>' and is_primary;
-- The reply is verbatim, and the reading is a separate row.
select type, direction, summary from public.interactions
 where lead_id = '<id>' and type in ('inbound_reply','system') order by created_at desc limit 5;
```

A second processor pass with no new facts must record a `cache_hit = true` run and
must **not** create a second `QUALIFY_LEAD` job. A `Do not contact` reply must leave
`conversation_outcomes.is_terminal` true and an active `contact_suppressions` row
even when the reading disagrees with it.

