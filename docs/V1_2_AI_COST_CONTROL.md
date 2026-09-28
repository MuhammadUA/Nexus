# NEXUS V1.2 — AI Cost Control

**Status:** normative. This document expands `product/NEXUS_V1_2_MASTER_SPEC.md` §46–§54 and §56–§63 and is
the authority for anything that decides whether a model is called, what is sent, what is cached and what
is recorded.

**Scope.** Seven server-side DeepSeek tasks, one orchestrator, one ledger, one cache key. Nothing here
constrains *what* the model is asked — the prompt registry does that — only *when*, *at what size*, *at
what cost* and *with what evidence*.

**Provider.** DeepSeek is the only provider (`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`,
plus `DEEPSEEK_TIMEOUT_MS` default 30 000, `DEEPSEEK_MAX_ATTEMPTS` default 3, `DEEPSEEK_RETRY_BASE_MS`
default 500). The key is server-only, read per call, never logged, never returned, and its absence is a
supported state (`provider_not_configured`).

---

## 1. The hard rules

### 1.1 Rules that are enforced in code

| # | Rule | Enforced by |
| --- | --- | --- |
| E1 | Deterministic work never calls a model: search links, completeness scoring, chaining decisions, job deduplication, contact normalisation, duplicate detection, source→vocabulary normalisation | `packages/core/src/enrichment.ts`, `packages/core/src/vocabulary.ts`, `packages/core/src/agent-jobs.ts`, `packages/core/src/dedupe.ts` — these modules import no provider |
| E2 | One door for every provider call | `apps/web/src/lib/ai/runner.ts`; the prompt builders live in `prompts.ts`, the Context Pack in `context-pack.ts`, and the transport (`deepseek.ts`) is not imported anywhere else |
| E3 | The answer must satisfy a strict schema before anything is written | the schema is applied in the orchestrator, before the caller sees the value |
| E4 | A failed validation writes nothing | the commit happens in domain code after validation, never inside the call |
| E5 | Every attempt or reuse writes one `ai_runs` row | the orchestrator writes it, including failures |
| E6 | The cache key covers the facts, so a changed fact is a miss | the normalised `input_hash` (§3) |
| E7 | There is no manual cache flush | no code path deletes or invalidates `ai_runs`; `delete` is revoked on the ledger |
| E8 | Raw bytes never enter a prompt body from a store: the staged row is the source, and it is deleted after commit | `nexus_read_raw_staging` + the raw lifecycle (`docs/V1_2_MIGRATION_PLAN.md` §5.5) |
| E9 | Every task has an output ceiling taken from the active prompt version, not from a call site | `prompt_versions.max_output_tokens` resolved through `nexus_active_prompt` |
| E10 | No page render calls a provider | read paths never import the orchestrator's write surface; asserted by a render test with a recording provider |

### 1.2 Rules that are policy, reviewed rather than compiled

| # | Rule | Why it is policy |
| --- | --- | --- |
| P1 | Prompts are small and task-specific: one task, one schema, one job | a prompt's size is a design decision reviewed per prompt version |
| P2 | Send cleaned text, never raw HTML | cleaning happens before staging; a collector that stages HTML is a collector defect |
| P3 | Never send the whole Business Brain | retrieval (`selectRelevantAssets`) is bounded; the bound is reviewed per task |
| P4 | Never send the whole timeline | the Context Pack summary is the only history a draft sees |
| P5 | Never re-extract the same profile | re-extraction is prevented by the `(business_id, content_hash)` evidence rule and the input hash |
| P6 | Deeper research only when the facts are insufficient | chaining checks "is research already committed" before creating a job |
| P7 | A draft reads a Context Pack, never the world | `MESSAGE_DRAFT` inputs are the pack + step rules + selected approved assets |
| P8 | Read the cache before spending: a hit is preferred to a call even when a call would be "fresher" | freshness is defined by the facts, and the facts are in the hash |

### 1.3 The one thing that is never traded

A cheaper answer that is unvalidated, ungrounded or unattributed is not a cheaper answer; it is a defect
that will be found later, in a sent message. Cost control may reduce *how often* and *how much* we ask;
it may never remove validation, grounding, provenance or the ledger row.

---

## 2. Tasks and prompt keys

### 2.1 The seven tasks

```
PROFILE_EXTRACTION  COMPANY_EXTRACTION  SIGNAL_EXTRACTION  ICP_QUALIFICATION
CONTEXT_BUILD       MESSAGE_DRAFT      REPLY_CLASSIFICATION
```

### 2.2 The twelve prompt keys

```
profile_extract  company_extract  signal_extract  icp_qualify  context_build
linkedin_initial  linkedin_followup  email_initial  email_followup
instagram_dm  upwork_proposal  reply_classify
```

### 2.3 Task → prompt key

| Task | `prompt_key` | Channel-specific |
| --- | --- | --- |
| `PROFILE_EXTRACTION` | `profile_extract` | no |
| `COMPANY_EXTRACTION` | `company_extract` | no |
| `SIGNAL_EXTRACTION` | `signal_extract` | no |
| `ICP_QUALIFICATION` | `icp_qualify` | no |
| `CONTEXT_BUILD` | `context_build` | no |
| `MESSAGE_DRAFT` | `linkedin_initial`, `linkedin_followup`, `email_initial`, `email_followup`, `instagram_dm`, `upwork_proposal` | **yes** — the key is chosen by the channel of the account the draft is for |
| `REPLY_CLASSIFICATION` | `reply_classify` | no |

A `MESSAGE_DRAFT` run therefore has a different cache identity per channel, which is correct: an email
follow-up and a LinkedIn follow-up are different answers to different questions.

---

## 3. The input hash and the cache key

### 3.1 The full cache key

```
(task, prompt_version_id, model, input_hash)
```

scoped to `business_id`, which is part of the uniqueness in the database:

```sql
create unique index ai_runs_cache_key on public.ai_runs (
  business_id, task, coalesce(prompt_version_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(model, ''), input_hash
) where status = 'SUCCEEDED' and cache_hit = false;
```

Four properties follow, and each is a requirement rather than an observation:

1. A **failed** attempt can never be reused as an answer (the index is partial on `SUCCEEDED`).
2. A **cache-hit row** can never itself become a cache source (`cache_hit = false` in the predicate), so
   hits cannot chain into one another.
3. A **changed model** is a different key — a model upgrade does not silently reuse the old model's
   answers.
4. A **changed prompt version** is a different key, which is why §7.3 needs no manual invalidation.

### 3.2 `input_hash`, defined

`input_hash` is the SHA-256 hex digest of the canonical JSON of the task's normalised input, where
"canonical" means all of:

1. **A fixed field order** defined by the task (not object key order), so two builders produce the same
   string. Implementation note: build an array of `[name, value]` pairs and serialise it in the task's
   declared order rather than serialising a map.
2. **Entity identity included.** `business_id`, `lead_id`, `person_id`, `company_id`, `agent_job_id` (when
   applicable) and `message_instance_id` (when applicable) are fields of the hashed input. Two leads with
   identical pasted text therefore have **two** cache entries; they are not each other's answers.
3. **Text normalised.** Trim, collapse every whitespace run (including newlines) to a single space,
   normalise line endings, and strip a UTF-8 BOM. This is the `cleanedText` form, never raw HTML.
4. **Identifiers canonicalised.** URLs through the same canonicaliser the rest of the schema uses
   (lower-cased host, no trailing slash, tracking parameters removed); emails lower-cased; phone numbers
   digits-only; domains lower-cased without `www.`.
5. **Nulls explicit.** A missing field is `null` in the hashed object, not absent, so "no location" and
   "an empty location" cannot collide into the same hash by accident of construction.
6. **No timestamps, no run ids, no actor ids.** A hash that changed because a different human pressed the
   button would defeat the cache.
7. **The prompt version and model are *not* inside the hash** — they are separate components of the key,
   so the ledger can show "the same input, a different prompt version" as a distinct row.

### 3.3 What each task hashes

| Task | Hashed input (in order) |
| --- | --- |
| `PROFILE_EXTRACTION` | `business_id`, `lead_id`, staged `content_hash`, cleaned staged text |
| `COMPANY_EXTRACTION` | `business_id`, `company_id`, lead id, staged `content_hash`, cleaned staged text |
| `SIGNAL_EXTRACTION` | `business_id`, `company_id`, lead id, staged `content_hash`, cleaned staged text |
| `ICP_QUALIFICATION` | `business_id`, `lead_id`, the committed fact summary, the ICP criteria of the candidate ICPs |
| `CONTEXT_BUILD` | `business_id`, `lead_id`, the canonical facts JSON (person, company, signals, ICP fit, intent, contacts, channel availability), the selected approved-asset ids and their `content_hash`es |
| `MESSAGE_DRAFT` | `business_id`, `lead_id`, `message_instance_id`, the Context Pack `input_hash`, the sequence step identity and its rules (`word_max`, `cta_style`, `proof_policy`, `tone`, prohibited phrases), the channel, the prompt key |
| `REPLY_CLASSIFICATION` | `business_id`, `lead_id`, the exact reply text (normalised per §3.2.3) |

### 3.4 Open items

- `> OPEN:` (spec OPEN-14) the versioning of the `ai_context_packs.pack` body. Recommended: a `schema`
  field inside the pack, included in the `CONTEXT_BUILD` hash input so a schema change is a miss.
- `> OPEN:` (spec OPEN-15) cross-lead reuse for identical company text. **Default: no.** §3.2.2 puts the
  entity ids in the hash. A future deliberate exception must be a documented rule, not an accident of a
  hash that forgot `company_id`.
- `> OPEN:` (spec OPEN-21) the groundedness comparison: whitespace-normalised exact match, or byte-exact.
  Recommended: normalise whitespace, then require an exact match. This affects validation, not the hash.

---

## 4. Cacheability per task

| Task | Cacheable | Why |
| --- | --- | --- |
| `PROFILE_EXTRACTION` | **yes** | the answer is a function of the staged text and the schema; a second extraction of the same bytes is pure waste and a duplicate-fact risk |
| `COMPANY_EXTRACTION` | **yes** | same shape: staged research text in, facts out |
| `SIGNAL_EXTRACTION` | **yes** | same shape |
| `ICP_QUALIFICATION` | **yes** | the answer is a function of the facts and the ICP criteria; a re-qualification with nothing changed is a no-op |
| `CONTEXT_BUILD` | **yes** | the pack is explicitly a *cache* of the facts (`ai_context_packs`), keyed by `input_hash` |
| `MESSAGE_DRAFT` | **conditionally** | reusable only for the identical `(pack input_hash, step rules, channel, prompt version)`; a human *regenerate* is an explicit, recorded miss, because the operator asked for a different answer and silently serving the cached one would be a lie |
| `REPLY_CLASSIFICATION` | **yes** | the reply text is immutable once captured; two classifications of one identical reply text are the same question |

**The regeneration rule.** A regeneration must be requested by a human, must be recorded as a
non-cached run (`cache_hit = false`, `status` `SUCCEEDED`), and must produce a **new** `message_versions`
row. Because the first draft's row already occupies the cache index for that key, the second run must
carry a deliberate cache-bypass marker in the hashed input (for example an explicit
`regeneration_reason` field that is `null` on a first generation). `> OPEN:` whether that bypass field is
`regeneration_reason` (recommended) or a separate ledger column; until it is decided, a regenerate must
not be implemented as an automatic retry.

---

## 5. Per-task sampling and output policy

### 5.1 The policy table

Values are the **plan-of-record defaults** seeded into `prompt_versions` (`temperature`,
`max_output_tokens` are columns, so every value here is a per-version decision an admin can change — and
changing it invalidates the cache by construction, because the prompt version is part of the key).

| Task | Temperature | Max output tokens | Input ceiling | Rationale |
| --- | --- | --- | --- | --- |
| `PROFILE_EXTRACTION` | `0.00` | 2 000 | 40 000 chars | extraction: variety is a defect, not a feature |
| `COMPANY_EXTRACTION` | `0.00` | 1 500 | 40 000 chars | same |
| `SIGNAL_EXTRACTION` | `0.00` | 1 500 | 40 000 chars | same |
| `ICP_QUALIFICATION` | `0.00` | 1 000 | 8 000 chars | a scored judgement, not prose |
| `CONTEXT_BUILD` | `0.00` | 3 000 | 12 000 chars | a structured summary of stored facts |
| `MESSAGE_DRAFT` | `0.70` | 500 (LinkedIn / Instagram), 700 (Email / Upwork) | 6 000 chars | drafting is the one task where variation is the product; the ceiling is what keeps a body short enough to be a real message |
| `REPLY_CLASSIFICATION` | `0.00` | 300 | 6 000 chars | one label and a reason |

### 5.2 Why these are caps and not targets

`max_output_tokens` is a **ceiling**, not a request. A model that answers in 40 tokens costs 40 tokens.
The ceiling exists so that a malformed prompt or a looping model cannot produce a 30 000-token answer at
3 a.m., and so that `prompt_versions.max_output_tokens` can be lowered for a business without a code
change.

### 5.3 Constraints the database already enforces

- `prompt_versions.temperature` is `numeric(3,2)` with `0 <= temperature <= 2`.
- `prompt_versions.max_output_tokens` is `> 0 and <= 32000`.
- `raw_staging.payload` is capped at 400 000 characters by `nexus_stage_raw`; `MCP` tool payloads are
  capped at 200 000 for an agent result and 400 000 for a profile paste. A collector that exceeds a cap
  must split the work into several jobs, not raise the cap for one caller.

---

## 6. What is never sent to the model

| Never sent | Because | The rule that keeps it out |
| --- | --- | --- |
| Raw HTML when cleaned text exists | most of an HTML page is markup, script and navigation; tokens spent on it buy nothing and the extraction quality is worse | clean before staging; stage `source_text`, not markup |
| The whole Business Brain | unapproved or non-AI-usable assets must not influence a message, and the token cost is unbounded | `selectRelevantAssets` + `ai_use_allowed` + `approved` |
| The whole timeline | a draft does not need every event; the Context Pack's summary is the intake | `context_build` packs a summary; `message_draft` reads the pack |
| Raw source bodies longer than the task's input ceiling | cost, and the ceiling is per task | the input builder truncates deterministically **and records that it truncated** in the run's provenance, or refuses; silently sliding the window is forbidden |
| Another tenant's rows | a disclosure, not a cost problem | every read is business-scoped; RLS is the boundary |
| Another lead's data | nothing in one lead's answer may come from another | entity ids are in the input hash and the reads are per lead |
| A user-confirmed value as a *candidate for replacement* | precedence rule 1 (spec §66.1) | the commit path refuses; conflicts go to `NEEDS_REVIEW` |
| Any secret: the API key, a token hash, a webhook secret, a database credential | never leaves the server | `describeProvider` returns a boolean; `redactSecrets` scrubs upstream bodies |
| An unapproved numeric claim or an unapproved client name | V1 messaging rules | `validateMessage` discards the body; the model is not asked to repair it |
| A prompt for a task whose required facts are absent | an answer to an unanswerable question is a hallucination | the input builder refuses and records `SKIPPED` |

**Truncation must be visible.** If an input is truncated to fit a ceiling, the run records the original
length and the sent length. A truncated extraction that silently looks complete is the most expensive
kind of cheap call, because the missing facts become a second research job.

---

## 7. The ledger

### 7.1 What `ai_runs` stores

One row per attempt **or** per reuse:

| Column | Content |
| --- | --- |
| `id` | the run id (referenced by `agent_jobs.result_ai_run_id`, `ai_context_packs.generated_by_run_id`) |
| `business_id` | the tenant the cost belongs to |
| `task` | one of the seven |
| `lead_id`, `person_id`, `company_id`, `agent_job_id`, `message_instance_id` | the entities, so cost is attributable to a lead and a job |
| `provider`, `model` | `deepseek` and the resolved model |
| `prompt_key`, `prompt_version_id`, `prompt_version` | which prompt produced it |
| `input_hash` | the normalised input identity (§3.2) |
| `status` | `PENDING`, `SUCCEEDED`, `FAILED`, `CACHED`, `SKIPPED` |
| `cache_hit` | whether this row reused a previous answer |
| `tokens_in`, `tokens_out` | as reported by the provider, null when unknown |
| `estimated_cost_usd` | `numeric(12,6)`, derived from tokens and the price table (§8) |
| `duration_ms` | wall time of the attempt, or the lookup time for a hit |
| `attempt` | which attempt of the run this row is |
| `error_code` | a stable machine string, never an upstream sentence |
| `created_at`, `completed_at` | timestamps |

### 7.2 What the ledger must never store

| Never stored | Why |
| --- | --- |
| The prompt body (system or user) | it contains pasted profile text, which is staging material and must not persist (spec §32.2) |
| The model's answer | same reason, plus it would turn the ledger into an unvalidated fact store |
| An upstream response body | it can echo the request, and it can contain a key-shaped string |
| A credential, token or key | never, anywhere, in any form, including truncated |
| Raw HTML or a staged `payload` | the raw lifecycle deletes it; a copy here would undo the deletion |
| A user's email or the reply's verbatim text | the reply text is stored once, in the interaction it belongs to; the ledger needs only the classification result |
| A human-readable error message from the provider | it can quote the input; only `error_code` is kept |

`delete` and `truncate` are revoked on `ai_runs`, and there is no delete policy. A ledger that can be
edited is not a ledger.

### 7.3 How a cache hit is recorded

A hit is a **row**, not the absence of one:

1. resolve the cache key `(business_id, task, prompt_version_id, model, input_hash)`;
2. find the most recent `ai_runs` row with that key where `status = 'SUCCEEDED' and cache_hit = false`;
3. load the answer it produced — for `CONTEXT_BUILD`, the `ai_context_packs` row with the same
   `(lead_id, input_hash)`; for the extraction tasks and `REPLY_CLASSIFICATION`, the committed facts or
   outcome that the run produced, which the domain layer re-uses rather than re-derives;
4. insert a **new** `ai_runs` row with:
   - the same `business_id`, `task`, `prompt_key`, `prompt_version_id`, `prompt_version`, `model`,
     `input_hash`, entity ids;
   - `status = 'CACHED'`, `cache_hit = true`;
   - `tokens_in = 0`, `tokens_out = 0`, `estimated_cost_usd = 0`;
   - the lookup `duration_ms`, and `completed_at = created_at`;
   - no `error_code`.

**Why a row rather than a flag.** An invisible hit is indistinguishable from a broken call. With a row,
"why did this cost nothing" is answerable, cache effectiveness is measurable per task
(`cache_hits / runs`), and a permanently-100% miss rate is visible as a defect rather than as a bill.

**`status = 'SKIPPED'`** is the other zero-cost row: a task that declined to run because its required
facts were absent or its input was empty. A skip must be distinguishable from a failure, because a failure
is retried and a skip is not.

### 7.4 What a failure records

`status = 'FAILED'`, the `error_code` from the closed vocabulary (`provider_not_configured`,
`unauthorized`, `rate_limited`, `timeout`, `provider_unavailable`, `invalid_request`, `malformed_json`,
`schema_invalid`, `empty_response`), `attempt`, `duration_ms`, and any tokens the provider still reported
(a rate-limited request that charged nothing records zero). Nothing else is written: on a failure, the
database must be otherwise byte-identical.

---

## 8. Cost accounting

### 8.1 The formula

```
estimated_cost_usd = (tokens_in / 1_000_000) * price_in
                   + (tokens_out / 1_000_000) * price_out
```

rounded to six decimal places. Prices are per million tokens, per model, and live in a code-held table —
**not** in the database, so a pricing change is a deploy of a constant rather than a data migration.
`> OPEN:` (spec OPEN-16) the exact location and owner of that table. Recommended: one exported constant
module next to the provider config, with the provider's published price and the date it was read.

### 8.2 A worked example, with placeholder prices

> **The prices below are placeholders.** They must be replaced with the provider's published values before
> any number in this document is used to make a decision.

Assume `price_in = 0.27` and `price_out = 1.10` per million tokens for `deepseek-chat`.

| Case | tokens_in | tokens_out | cost |
| --- | --- | --- | --- |
| `PROFILE_EXTRACTION`, a long profile | 6 000 | 700 | `(6000/1e6)*0.27 + (700/1e6)*1.10 = 0.00162 + 0.00077 = 0.00239` |
| The same extraction, served from cache | 0 | 0 | `0.000000` |
| `MESSAGE_DRAFT`, an email | 2 500 | 300 | `0.000675 + 0.00033 = 0.001005` |
| A cache hit on a draft | 0 | 0 | `0.000000` |

The example is the whole argument for the cache: at these placeholder prices, a re-extraction of an
unchanged profile costs about 0.24 cents, and a draft about 0.10 cents. A hundred unnecessary
re-extractions a day is a rounding error; a hundred thousand is a line item, and neither is worth the
fact-drift risk of a second extraction.

### 8.3 Caps and alerts

| Control | Kind | Behaviour |
| --- | --- | --- |
| Per-business daily spend cap | `> OPEN:` whether a setting exists; recommended as a `platform_settings` key (`ai.daily_cost_cap_usd`) | when exceeded: queue-context tasks (`CONTEXT_BUILD`) and drafts continue, batch/extraction tasks pause and the Overview shows the cap state. Never a silent failure. |
| Cost-per-extraction drift | alert | compare `estimated_cost_usd / runs` for a task over a rolling window; a step change means a prompt, a ceiling or a model changed |
| Cache-hit share | metric | `cache_hits / runs` per task; a sudden drop to zero means the hash inputs changed |
| `max_attempts` | bound | an agent job stops at `max_attempts`; the provider attempts stop at `DEEPSEEK_MAX_ATTEMPTS` |
| Retry input | rule | a retry re-reads the **staged** row, never a stored copy of the prompt or the answer. There is no stored copy. |

---

## 9. How an operator reads usage

All of these are aggregates over `ai_runs` and the `ai_usage_daily` view. None of them loads a payload,
because there is none to load.

### 9.1 The four questions the UI must answer

1. **What did this business spend today, and on what?**
2. **Which task is the expensive one, and is it getting more expensive?**
3. **How much of the spend was avoided by the cache?**
4. **What failed, and is it failing repeatedly?**

### 9.2 Queries

```sql
-- 1. usage by business, day and task (the view exists in migration 0034)
select business_id, day, task, runs, cache_hits, failures,
       tokens_in, tokens_out, estimated_cost_usd, avg_duration_ms
  from public.ai_usage_daily
 order by day desc, estimated_cost_usd desc;

-- 2. today's total for one business, with the cache-hit share
select count(*)                                            as runs,
       count(*) filter (where cache_hit)                    as cache_hits,
       round(100.0 * count(*) filter (where cache_hit) / greatest(count(*), 1), 1) as cache_hit_pct,
       coalesce(sum(tokens_in), 0)                          as tokens_in,
       coalesce(sum(tokens_out), 0)                         as tokens_out,
       coalesce(sum(estimated_cost_usd), 0)                 as cost_usd
  from public.ai_runs
 where business_id = $1
   and created_at >= date_trunc('day', now());

-- 3. cost by task over a window, with the average per run
select task,
       count(*)                                    as runs,
       count(*) filter (where cache_hit)            as hits,
       count(*) filter (where status = 'FAILED')    as failures,
       coalesce(sum(estimated_cost_usd), 0)         as cost_usd,
       round(coalesce(avg(estimated_cost_usd) filter (where not cache_hit), 0), 6) as avg_cost_per_call
  from public.ai_runs
 where business_id = $1 and created_at >= now() - interval '7 days'
 group by task
 order by cost_usd desc;

-- 4. the most expensive leads (which leads are worth improving, or fixing)
select lead_id, count(*) as runs, coalesce(sum(estimated_cost_usd), 0) as cost_usd,
       count(*) filter (where status = 'FAILED') as failures
  from public.ai_runs
 where business_id = $1 and lead_id is not null and created_at >= now() - interval '30 days'
 group by lead_id
 order by cost_usd desc
 limit 20;

-- 5. failures by code — the operational view of "is something broken"
select task, error_code, count(*) as failures, max(created_at) as last_seen
  from public.ai_runs
 where business_id = $1 and status = 'FAILED' and created_at >= now() - interval '7 days'
 group by task, error_code
 order by failures desc;

-- 6. the token trend per task per day, for spotting prompt growth
select date_trunc('day', created_at)::date as day, task,
       sum(tokens_in) as tokens_in, sum(tokens_out) as tokens_out
  from public.ai_runs
 where business_id = $1 and created_at >= now() - interval '14 days'
 group by 1, 2
 order by 1 desc, 2;
```

### 9.3 Reading the numbers

| Symptom | Likely cause | Where to look |
| --- | --- | --- |
| cache-hit share near zero for extraction tasks | the input hash is changing between identical requests (a timestamp or a run id leaked into the hash) | the task's input builder, §3.2.6 |
| cost per run climbing for one task | the prompt grew, the input ceiling is not applied, or the output ceiling was raised | `prompt_versions.max_output_tokens`, then the prompt template |
| many `FAILED` rows with one `error_code` | a configuration or schema defect, not a transient one | the code path that maps `kind` to the failure (§7.4) |
| the same lead dominates the cost table | a chaining loop is re-creating work that is already committed | `agent_jobs.dedupe_key`, the chaining checks (spec §46.6) |
| `SKIPPED` rows rising | inputs are being built for tasks whose required facts are absent | the caller, not the model |

---

## 10. Acceptance checklist

Each line is testable.

1. An unchanged `(task, prompt version, model, input)` produces a cache hit: `status = 'CACHED'`,
   `cache_hit = true`, `tokens_in = 0`, `tokens_out = 0`, `estimated_cost_usd = 0`.
2. A changed fact produces a miss, and a new row with `cache_hit = false`.
3. A changed prompt version produces a miss.
4. A changed model produces a miss.
5. Two leads with identical text produce two entries, not one.
6. A failed attempt is never reused as an answer, and a `FAILED` row carries an `error_code`.
7. A schema-invalid answer writes nothing except one `FAILED` `ai_runs` row.
8. A missing `DEEPSEEK_API_KEY` writes one `FAILED` row with `error_code = 'provider_not_configured'` and
   nothing else, and the screen still renders a manual path.
9. A page render performs zero provider calls.
10. No `ai_runs` row contains a prompt body, a model answer, a raw staged payload or a secret.
11. `delete` on `ai_runs` is not granted to `authenticated` and no code path deletes a row.
12. Every task's `prompt_key` is one of the twelve in §2.2.
13. Every `MESSAGE_DRAFT` run names the channel-specific prompt key it used.
14. A regeneration is a deliberate, recorded miss and produces a new `message_versions` row.
15. Truncation of an oversized input is recorded (original length and sent length) or the run refuses.
16. `ai_usage_daily` answers §9.1's four questions without reading any other table.

---

## 11. Open items in this document

| Id | Item | Default behaviour until answered |
| --- | --- | --- |
| spec OPEN-14 | `ai_context_packs.pack` body schema versioning | a `schema` field inside the pack, included in the `CONTEXT_BUILD` hash |
| spec OPEN-15 | cross-lead cache reuse for identical company text | not permitted; entity ids are in the hash |
| spec OPEN-16 | where the per-model price table lives and who owns it | one exported constant next to the provider config, with the date the prices were read |
| spec OPEN-21 | groundedness comparison semantics | whitespace-normalised, then exact |
| spec OPEN-22 | the level-4 confidence floor | `confidence > 0.5`, and level 4 still never replaces user-confirmed (1), verified structured (2) or strong-identifier (3) values |
| spec OPEN-24 | whether a per-business daily spend cap is enforced or advisory | advisory until a setting exists; the Overview shows the cap state either way |
| spec OPEN-25 | the regeneration bypass field | `regeneration_reason` in the hashed input, `null` on a first generation |
