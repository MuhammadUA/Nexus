# NEXUS V1.2 — Agent Jobs

Durable work queue that lets OpenCode, BrowserOS or any other browser agent do
research for Nexus without being online when the work is created. Reference:
`product/NEXUS_V1_2_MASTER_SPEC.md` §16–§21, migrations
`0032_agent_jobs.sql`, `0034_v1_2_processor_and_read_models.sql`.

## 1. Why the queue is in the database

Research that reads a live browser cannot be replaced by a request-scoped HTTP
call. If the job lived in the agent's process:

* work created while the agent is closed would be lost,
* a crashed agent would silently drop whatever it had claimed,
* nothing would be able to say *why* a lead was still unqualified,
* and the operator would have no queue to look at.

So a job is a row. It is created by the product (a human pressing **Research
Company**), by automatic chaining (a lead that cleared profile enrichment but has
no company intelligence), or by an external planner (ChatGPT through
`nexus.create_agent_job`). It stays there until an agent works it or an operator
cancels it.

## 2. `agent_jobs` — the row

| Column | Meaning |
| --- | --- |
| `id` | uuid |
| `business_id` | the tenant. Every read is filtered by RLS on this column |
| `lead_id` / `person_id` / `company_id` | nullable entity references; a job may be entity-less (e.g. a bulk import audit) |
| `job_type` | `RESEARCH_COMPANY`, `RESEARCH_PERSON`, `RESEARCH_SIGNALS`, `CAPTURE_PROFILE`, `ENRICH_PROFILE`, `QUALIFY_LEAD`, `BUILD_CONTEXT`, `DRAFT_OUTREACH`, `OTHER` |
| `priority` | `low` \| `normal` \| `high` \| `urgent`; the claim orders on this |
| `status` | `OPEN` \| `RUNNING` \| `WAITING_AI` \| `COMPLETE` \| `FAILED` \| `CANCELLED` |
| `instructions` | operator/planner text for the agent |
| `required_capabilities` | text[]. A job is only offered to an agent whose advertised capabilities are a superset |
| `created_by_type` / `created_by_id` | `user` \| `api_client` \| `system` \| `agent` + the id |
| `claimed_by_agent` | the agent name holding the lease |
| `claimed_at`, `lease_expires_at`, `last_heartbeat_at` | lease bookkeeping |
| `attempt_count`, `max_attempts` | retry bookkeeping (claim increments, release/fail do not decrement) |
| `last_error_code` | typed failure code; never a raw provider or page body |
| `dedupe_key`, `reason` | why the job exists, and the key that stops automatic chaining from creating a second identical job |
| `result_ai_run_id` | the `ai_runs` row whose extraction completed the job |
| `created_at`, `updated_at`, `completed_at` | timestamps |

`agent_job_events` is append-only history: `created`, `claimed`, `heartbeat`,
`released`, `failed`, `result_submitted`, `ai_started`, `completed`,
`cancelled`, `lease_expired`, `retry_scheduled`. Notes are short operator text —
raw evidence is never written there, because a note that quoted the payload would
outlive the deletion policy that removes the payload.

## 3. Status lifecycle

```
                create                claim                 submit evidence
  (nothing) ──────────▶ OPEN ──────────────▶ RUNNING ──────────────────────▶ WAITING_AI
                         ▲   ▲                  │                                  │
              release /  │   │ lease expired    │ fail (retryable, attempts left)  │ DeepSeek extract
              retry      │   └──────────────────┘                                  │ validate
                         │                                                          │ commit facts + provenance
                         │                                                          │ verify
                         │                                                          │ delete raw
                         └──────────────────────────── COMPLETE ◀───────────────────┘
                                    (only via nexus_complete_agent_job)
```

`FAILED` and `CANCELLED` are terminal until an operator explicitly retries.
`COMPLETE` is reachable from `WAITING_AI` only.

### 3.1 The model-only jobs

Two job types need no worker and no staged body: `QUALIFY_LEAD` and `BUILD_CONTEXT`.
Their prerequisites are committed structured facts, so the chaining planner creates
them `OPEN` and the AI processor claims them directly:

```
   OPEN ──── nexus_claim_ai_direct_work ────▶ RUNNING ──── model call ────▶ persist result
            (lease, attempts, SKIP LOCKED)                    │                    │
                                                              │             nexus_complete_direct_agent_job
                                                              │             (refuses while any un-consumed
                                                              ▼              raw_staging row remains)
                                                     typed failure ──▶ OPEN / FAILED
```

The completion rule is the same in substance as the extraction path's: only the
processor holding the running lease may complete, and no un-consumed `raw_staging`
row may remain for the job. For a model-only job there is never a staged body, and
the caller has already persisted the structured result before it completes. Before
migration `0036` these two types were planned but unclaimable, so they sat `OPEN` for
ever.

## 4. Claim, lease and crash recovery

Claiming is one statement:

```sql
update public.agent_jobs j
   set status = 'RUNNING', claimed_by_agent = $agent, claimed_at = now(),
       lease_expires_at = now() + make_interval(secs => $lease),
       attempt_count = attempt_count + 1, ...
 where j.id = (
   select c.id from public.agent_jobs c
    where c.business_id = $business
      and (c.status = 'OPEN' or (c.status = 'RUNNING' and c.lease_expires_at < now()))
      and c.attempt_count < c.max_attempts
      and (c.required_capabilities = '{}' or c.required_capabilities <@ $capabilities)
    order by (priority rank), c.created_at
    for update skip locked
    limit 1)
returning *;
```

Consequences that matter:

* **Two agents cannot both win.** `FOR UPDATE SKIP LOCKED` inside a single UPDATE
  means the loser skips the locked row and takes the next candidate instead of
  blocking or double-claiming.
* **A dead agent cannot park work.** The claim considers a `RUNNING` job whose
  lease is in the past as available again, and `nexus_reap_expired_job_leases`
  moves such jobs back to `OPEN` (or to `FAILED` when no attempts remain) with a
  `lease_expired` event that explains the transition.
* **An empty queue is not an error.** A claim that matches nothing returns zero
  rows; polling agents get an empty answer rather than a failure they would retry.
* **Leases are bounded.** `p_lease_seconds` is clamped to 30–7200 so no caller can
  pin a job for a day or acquire one for a millisecond.

`nexus_heartbeat_agent_job` extends the lease, and refuses with `55006` when the
job is not `RUNNING` or is held by a different agent — a reaped agent learns that
the job moved on rather than that it never existed.

## 5. Why OpenCode does not complete a job

The rule is structural, not procedural:

1. `nexus_submit_agent_job_result` stages the submitted evidence in
   `raw_staging` and sets the job to `WAITING_AI`. It never sets `COMPLETE`.
2. `nexus_complete_agent_job` refuses unless the job is `WAITING_AI` **and** no
   un-consumed `raw_staging` row remains for that job. A job therefore cannot be
   reported done while the evidence it is based on still exists.
3. There is no MCP tool that completes a job, and `agent_jobs` has no UPDATE
   policy, so a direct `update ... set status = 'COMPLETE'` is refused as well.
   Every mutation goes through a `SECURITY DEFINER` function with an explicit
   capability assertion.

The processor (`apps/web/src/lib/ai/pipeline.ts`) is the only caller that reaches
`COMPLETE`; it does so after extraction, validation, structured commit and raw
deletion, in that order.

## 6. Capabilities and authority

`public.nexus_job_scope_ok(business_id, scope)` is the single capability check:

* `admin`, or
* a user with business access **and** `can_manage_leads` in that business, or
* a service token holding the required scope and scoped to that business.

Scopes: `jobs:create` (create, cancel, retry), `jobs:read` (list, get),
`jobs:claim` (claim, heartbeat, release), `jobs:submit` (submit result, fail,
complete). `jobs:create`, `jobs:claim` and `jobs:submit` are in `WRITE_SCOPES`,
so a token that has them is treated as a writing client everywhere else in the
product too.

## 7. Automatic chaining

`planChainedJobs()` in `@nexus/core` is pure, so the decision is testable without
a database. It is given the lead's real facts and the dedupe keys of currently
`OPEN`/`RUNNING`/`WAITING_AI` jobs and returns at most three plans:

| Situation | Plan |
| --- | --- |
| `NEEDS_PROFILE`, `MINIMAL`, `AI_PROCESSING`, `NEEDS_REVIEW`, `FAILED` | nothing — human-assisted enrichment is the path |
| profile ready, no company research | `RESEARCH_COMPANY` (`high`) |
| company research present, signals absent | `RESEARCH_SIGNALS` (`high`) |
| company research present, no context pack | `BUILD_CONTEXT` (`normal`) |
| person + company + intelligence present, and the stored qualification does not answer the current facts | `QUALIFY_LEAD` (`normal`) |

The qualification row is only produced when the caller supplies the qualification
state — the prerequisites plus whether the stored answer already matches the current
input hash. A caller that cannot report that plans nothing, because a caller that
cannot judge staleness must not be able to cause a model call. `READY` is a planning
state for qualification (and only for qualification): a ready lead whose facts have
changed since it was scored needs a new answer, and research is not re-planned there
because its absence would have blocked readiness in the first place.

Loop-freedom is by construction: a type whose dedupe key is already open is never
re-created, and the dedupe key is unique per `(business_id, dedupe_key)` among
active jobs, enforced by a partial unique index rather than by application care.
Qualification carries a second guarantee at the facts level — once an answer matches
the current input hash, no new job is planned until the facts actually change.
`reason` records why each automatic job was created, so an operator looking at the
queue can tell a chained job from a hand-made one.

## 8. Processor

`processAiQueue(viewer, { businessId?, limit? })` runs, in order:

1. `nexus_reap_expired_job_leases` — no job stays `RUNNING` because its agent died.
2. `nexus_cleanup_raw_staging` — the 24h TTL sweep for abandoned raw evidence.
3. `nexus_claim_ai_work` — a bounded batch of `WAITING_AI` jobs, leased so two
   processors never extract the same evidence.
4. `nexus_claim_ai_direct_work` — a bounded batch of the model-only jobs
   (`QUALIFY_LEAD`, `BUILD_CONTEXT`), claimed from `OPEN` under the same lease.
5. For each claimed job: extract → validate → commit → verify → delete raw →
   complete → chain the next job → rebuild the context pack. A `QUALIFY_LEAD` job
   runs the versioned `icp_qualify` task, persists through `set_primary_icp` and the
   match row, completes, and rebuilds the context pack so drafting sees the new fit
   and intent. A `BUILD_CONTEXT` job builds the pack.
6. A failure on one job records a typed error and does not abort the batch.

It is exposed at `POST /api/v1/ai/processor` and is safe to call repeatedly: every
step is idempotent and bounded. It is the intended target for a Vercel Cron entry
after deployment (see `docs/V1_2_IMPLEMENTATION_REPORT.md`).

## 9. Operational screen

`/[business]/agent-jobs` shows OPEN / RUNNING / WAITING AI / FAILED / DONE TODAY
counts, and per-job priority, type, entity, status, agent, lease (with an explicit
*expired* state), attempts and timestamps. Authorized actions are create, retry,
cancel, release stale claim and open entity. There is deliberately **no manual
complete**.
