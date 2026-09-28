# NEXUS V1.2 — AI Pipeline

How DeepSeek is invoked, cached, accounted for, and — the hard part — made to
leave no raw evidence behind. Reference: `product/NEXUS_V1_2_MASTER_SPEC.md`
§12–§24, `docs/V1_2_AI_COST_CONTROL.md`, `apps/web/src/lib/ai/`.

## 1. Shape

```
caller (route / action / processor)
   │
   ├─ repo: read permanent facts, stage raw through the database functions
   │
   ├─ runner.runAiTask(...)
   │     ├─ prompts.resolvePrompt(key, business)      ← versioned, DB-backed
   │     ├─ cache lookup in ai_runs                   ← input hash + prompt version + model
   │     ├─ provider.complete({ system, user, schema, maxTokens, temperature })
   │     └─ ledger write (SUCCEEDED / FAILED / CACHED) — tokens, cost, duration, no bodies
   │
   └─ extract: validate → commit structured facts → provenance → verify → DELETE RAW → advance state
```

Seven server-side tasks, all in `AI_TASK_TYPES`, all invoked from a product flow:

| Task | Output | Cached | Invoked by |
| --- | --- | --- | --- |
| `PROFILE_EXTRACTION` | structured person facts, experience, signals, per-field confidence | yes | the enrichment commit, from a staged paste |
| `COMPANY_EXTRACTION` | site, industry, services, size, locations, hiring, content activity, signals | yes | the enrichment commit, from staged company research |
| `SIGNAL_EXTRACTION` | typed signals with polarity/strength | yes | signal extraction on a staged research body |
| `ICP_QUALIFICATION` | fit score, intent score, reasons, disqualifiers, recommended angle | yes | the `QUALIFY_LEAD` job, planned from facts and processed by the AI processor; persisted on `lead_icp_matches` through `set_primary_icp` |
| `CONTEXT_BUILD` | the compact AI Context Pack | yes (stored in `ai_context_packs`) | the `BUILD_CONTEXT` job, the lead screen, and automatically after a qualification |
| `MESSAGE_DRAFT` | channel-specific draft (subject/body/claims used) | no (a draft is a new immutable version) | the draft action on a lead, or `nexus.submit_message_draft` |
| `REPLY_CLASSIFICATION` | outcome, sentiment, intent, next action, reason | yes | every reply capture, after the reply is stored |

The two that run from a job are the *model-only* jobs: they are created `OPEN` by the
chaining planner and claimed by `nexus_claim_ai_direct_work`, because there is no
staged body to wait for. Reply classification runs inline after `capture_reply` has
committed, and is best-effort: a missing provider or a schema failure is reported as a
missing reading, never as a lost reply.

`DEEPSEEK_API_KEY` is read server-side only (`apps/web/src/lib/ai/config.ts`). A
missing key is a normal deployment state: the task returns a typed
`provider_not_configured` failure and the UI renders that, rather than crashing a
page or leaking a stack trace. Nothing key-shaped is ever returned, logged or
stored; provider error bodies pass through `redactSecrets`.

## 2. The AI task contract

Every invocation records: task type, prompt version, provider/model,
temperature, max output, the Zod schema the answer must satisfy, the normalised
input hash, the business id, the relevant entity ids, and status/timestamps. All of
it lands in `ai_runs`, which is the single source of truth for "what did the model
do, and what did it cost".

Validation happens **before** any canonical mutation. A schema-invalid answer is a
typed failure (`malformed_json`, `schema_invalid`, `empty_response`, …) with the
offending field paths, and nothing is partially merged.

## 3. Cache

Key = `business_id` + `task` + `prompt_version_id` + `model` + `input_hash`, where
`input_hash` is a SHA-256 over a canonically serialised (key-sorted) projection of
the *normalised input only*.

A lookup finds a `SUCCEEDED`, non-cache-hit row for that key; the caller then
supplies the previously committed artefact (`ai_context_packs.pack`, the current
structured facts, the existing draft) through `loadCached()`. If it materialises,
the runner writes a `CACHED` row (`cache_hit = true`, zero tokens) and **does not
call the provider**. If it cannot be materialised, the run proceeds as a miss.

This is what makes reopening a lead page free: enrichment is only recomputed when
the relevant facts, the prompt version or the model actually changed. A changed
fact changes the hash; activating a new prompt version changes the key; both
invalidate by construction rather than by a manual cache purge.

## 4. Prompt versioning

`prompt_versions` holds a global default (`business_id IS NULL`) and optional
per-business overrides, each with a version, system prompt, template, model,
temperature, max output ceiling and schema reference. `nexus_active_prompt(key,
business)` resolves an active override first, then the highest active global
version, so a deployment that somehow holds two active rows still behaves
deterministically. Twelve keys are versioned:

`profile_extract`, `company_extract`, `signal_extract`, `icp_qualify`,
`context_build`, `linkedin_initial`, `linkedin_followup`, `email_initial`,
`email_followup`, `instagram_dm`, `upwork_proposal`, `reply_classify`.

`ensureDefaultPrompts()` inserts the shipped defaults as global version 1 when a
key has no global row, so a fresh deployment shows real rows in the AI settings
tab instead of an empty table. Activating a version is admin-only, transactional
(deactivate the siblings, activate the chosen row), and never deletes history.
Prompts contain no secrets and never receive a raw body.

## 5. Context Pack

Built from permanent facts only: person, company, signals, ICP fit, intent,
opportunity, the relevant approved offer, approved claims/proof, channel
availability and a compact prior-outreach/reply summary. It never contains:

* a raw pasted profile, scraped page or research dump,
* the whole Business Brain,
* the whole timeline,
* anything that is not needed to write one message.

Packs are stored in `ai_context_packs` keyed by `(lead_id, input_hash)`, so the
same facts reuse the same pack and changed facts produce a new one. Drafts and
follow-ups are generated from the pack rather than from source bodies, which is
both the correctness rule and the main cost control.

## 6. Raw data lifecycle (hard requirement)

```
receive raw
  → nexus_stage_raw            (raw_staging, 24h expiry)
  → nexus_read_raw_staging     (raw body enters the process, attempt_count++)
  → DeepSeek extract           (schema-validated)
  → commit structured facts    (people / companies / leads / signals / research_snapshots)
  → commit provenance          (source_evidence metadata + content hash + model + prompt version)
  → verify commit              (the row is read back)
  → nexus_delete_raw_staging   (raw body destroyed)
  → advance enrichment state / nexus_complete_agent_job
```

On failure the raw row is marked `FAILED` with a typed error code and **kept** for
the retry; `nexus_cleanup_raw_staging` deletes anything still abandoned past its
`expires_at` (default 24h). Failure paths never delete early, success paths never
leave a body behind, and neither path writes the body into a log, an error code,
an audit row or an event note.

Access control is the database's job: `raw_staging` is `ENABLE` + `FORCE` row
level security with a single policy satisfied only by members of the
`nexus_raw_writer` role (the migration owner), and its privileges are revoked from
`authenticated` and `anon`. Tenant code cannot read it even by guessing an id;
every legitimate access goes through a `SECURITY DEFINER` function that asserts
the caller's business capability first.

## 7. Merge safety

Precedence when a field already has a value:

1. user-confirmed (`person_contact_points.confirmed_by_user`, or an operator edit),
2. verified structured source,
3. strong canonical identifier (normalised LinkedIn URL, company domain),
4. high-confidence AI extraction,
5. AI inference.

A conflict with a user-confirmed value never overwrites; the enrichment status
becomes `NEEDS_REVIEW` and the conflict is reported to the operator. Extracted
facts and inferences are separate fields in the schema, so an inference is never
promoted to a fact by being stored.

## 8. Idempotence and retries

Extraction is idempotent: the same paste with the same prompt version produces the
same structured facts, the source-evidence unique key `(business_id, content_hash)`
makes a re-capture a no-op, and signals are only appended when new. The processor
leases each job (`nexus_claim_ai_work`) so two processors never extract the same
staged evidence, and a crashed processor's lease lapses back into the queue.

## 9. What the pipeline never does

* No AI call on a normal page render.
* No deterministic work through a model: Google queries, completeness scoring,
  dedupe keys and job planning are pure functions in `@nexus/core`.
* No raw HTML when cleaned text exists; no whole-brain or whole-timeline prompts.
* No repeated extraction of the same profile (the cache key prevents it).
* No raw payload in `ai_runs`, `audit_events`, `agent_job_events`, error codes or
  logs.
