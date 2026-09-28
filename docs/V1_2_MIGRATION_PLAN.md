# NEXUS V1.2 — Migration Plan (`0030`–`0036`)

**Branch:** `v1.2/ai-first-redesign`. **Migrations:** `packages/db/migrations/0030` … `0036`.
**Normative sibling:** `product/NEXUS_V1_2_MASTER_SPEC.md` (the product contract; this document is the
database contract for the same change).
**Audience:** the person who applies these to a real PostgreSQL/Supabase project — ChatGPT, per the V1.2
boundary. The implementer does **not** apply them to any hosted database.

This document describes the migrations that exist in the branch. Where a migration's name or content
differs from the frozen V1.2 outline, the difference is called out in §12 and the SQL in the repository
is the implementation of record.

---

## 1. What these seven migrations are for

| Migration | Adds | Implements |
| --- | --- | --- |
| `0030_channel_accounts_and_contact_points.sql` | `outreach_identities.channel`, `public.channel_accounts` view, `person_contact_points` | master spec §19, §23, §24, §25, §26 |
| `0031_lead_enrichment_and_raw_staging.sql` | `lead_enrichment`, `raw_staging`, the seed trigger, `source_evidence` V1.2 provenance columns, the `nexus_raw_writer` role and the raw staging functions | §14, §28, §32, §33, §34 |
| `0032_agent_jobs.sql` | `agent_jobs`, `agent_job_events`, the claim/lease/heartbeat/fail/submit/complete/reap functions | §35–§42 |
| `0033_ai_runs_prompts_context.sql` | `ai_runs`, `ai_context_packs`, an additive extension of `prompt_versions`, `nexus_active_prompt` | §46–§54, §56, §59, §60, §61 |
| `0034_v1_2_processor_and_read_models.sql` | `nexus_claim_ai_work`, three `security_invoker` read views, V1.2 read indexes, `nexus_retry_agent_job` | §42.6, §56.3, §64, §65, §70, §76 |
| `0035_companion_binding_scope.sql` | corrected `companion_visible_business_ids`, `companion_ineligible_reason`, `assert_companion_binding_scope` | §71, §78, §77 |
| `0036_lead_qualification.sql` | the ICP-qualification columns on `lead_icp_matches` (intent score, recommended angle, reasons, disqualifiers, confidence, AI-run id, qualified-at, input hash) with their checks and two partial indexes, plus `nexus_claim_ai_direct_work` and `nexus_complete_direct_agent_job` for jobs whose whole work is a model call | §36, §46, §49, §59 |

---

## 2. The additivity contract

### 2.1 The three rules

1. **Nothing is destructive.** No `drop table`, no `drop column`, no `delete`, no `truncate`, no data
   rewrite that loses a stored value. Every `alter table` either adds a column or widens an existing
   `CHECK`.
2. **Nothing is renamed.** `outreach_identities` stays `outreach_identities`; `channel_accounts` is a
   *view over it*, not a rename of it. Every foreign key, trigger, policy and historical attribution
   that references the V1 tables keeps working untouched.
3. **No applied migration is rewritten.** `0001`–`0029` are history. A correction is a new migration, and
   that is what `0029` (upgrading `0028`'s first deployed revision) and `0035` (upgrading `0001`'s
   `companion_visible_business_ids`) both are.

### 2.2 The four constraint replacements, stated honestly

Four statements drop a constraint that exists in a live database. Each is non-destructive and each is
listed here so that nobody discovers it from a diff:

| Migration | Statement | Why it is safe |
| --- | --- | --- |
| `0030` | `outreach_identities_platform_check` dropped and re-added as a **superset** (`linkedin`, `email`, `instagram`, `upwork`, `twitter`, `other`) | every previously valid value still validates; no row changes |
| `0033` | `prompt_versions_key_version_key` dropped, replaced by two partial uniques (global `(key, version) where business_id is null`; business `(business_id, key, version) where business_id is not null`) | the new rules are strictly weaker in the global scope and identical within a scope; no stored row is invalidated, and a business override with the same key/version can now coexist with the global default, which is the point |
| `0033` | `prompt_versions_temperature_check` and `prompt_versions_max_output_check` added (they did not exist) | additive bounds on columns that are new or unconstrained |
| `0032`/`0034` | none | all `CHECK`s are on new tables |

`prompt_versions_key_version_key` is the single V1.1 constraint V1.2 replaces. It is replaced because the
V1.1 rule ("one `(key, version)` in the whole installation") makes a business override impossible to
insert: a business row would collide with the global default. The replacement keeps the default and the
override in separate uniqueness scopes.

### 2.3 Idempotency

Every statement in `0030`–`0035` is written to be re-runnable:

- `create table if not exists`, `create index if not exists`, `add column if not exists`;
- `create or replace function` / `create or replace view`;
- `drop policy if exists` immediately before `create policy`; `drop trigger if exists` before
  `create trigger`; `drop constraint if exists` before `add constraint`;
- the only data statements are `update … where channel is null` and
  `insert … on conflict (lead_id) do nothing`, both of which converge.

`packages/db/test/migration-idempotency.test.ts` is the executable form of this claim: the whole set is
applied, then applied again, and the schema and row counts must be identical.

---

## 3. Application order

Apply in this exact order. The order is not cosmetic: `0034` reads `0032`'s tables and `0033`'s ledger,
and `0031`'s functions are referenced by `0032`'s submit path.

```
0030_channel_accounts_and_contact_points.sql
0031_lead_enrichment_and_raw_staging.sql
0032_agent_jobs.sql
0033_ai_runs_prompts_context.sql
0034_v1_2_processor_and_read_models.sql
0035_companion_binding_scope.sql
```

| Migration | Depends on | Must precede |
| --- | --- | --- |
| `0030` | `0001` (`person_visible`), `0004`, `0006`, `0013`, `0014` | `0031` (no hard dependency, but `person_contact_points` is written by the same commit path) |
| `0031` | `0001`, `0005`, `0013`, `0014`, `0030` (soft) | `0032` (its submit path calls `nexus_stage_raw`) |
| `0032` | `0005`, `0009`, `0013`, `0014`, `0027`, `0031` | `0033` (`ai_runs.agent_job_id` references it), `0034` |
| `0033` | `0003` (`prompt_versions`), `0005`, `0007`, `0013`, `0014`, `0032` | `0034` |
| `0034` | `0031`, `0032`, `0033` | `0035` (no hard dependency) |
| `0035` | `0001`, `0006`, `0017`, `0025` | nothing |

Because `0031` grants `execute` on the raw staging functions to `authenticated` and revokes them from
`public`/`anon`, a deployment that stops after `0031` is consistent, just incomplete.

---

## 4. `0030` — channel accounts and person contact points

### 4.1 `outreach_identities.channel`

| Statement | Effect |
| --- | --- |
| `add column if not exists channel text` | nullable first, so existing rows are legal |
| `update … set channel = case platform … where channel is null` | backfill: `linkedin`→`linkedin`, `email`→`email`, `instagram`→`instagram`, `upwork`→`upwork`, everything else (in practice `twitter`, `other`)→`other` |
| `alter column channel set default 'linkedin'`, `set not null` | new rows default to LinkedIn; every existing row has a value by now |
| `add constraint outreach_identities_channel_check check (channel in ('linkedin','email','instagram','upwork','other'))` | the V1.2 outreach channel vocabulary |
| `drop constraint if exists outreach_identities_platform_check` + re-add as the superset | widens the V1 platform vocabulary; `twitter` rows keep validating |

**Why it is backward compatible.** `platform` is untouched as a stored value and still carries the
historical truth for reporting. A row that was `twitter` becomes `channel = 'other'` and stays fully
valid. Nothing reads `channel` until application code is deployed, so a schema-only rollout is safe.

**Index:** `outreach_identities_channel_idx (channel, status) where deleted_at is null` — the "which
accounts can send on this channel" lookup used by the channel selector and the Companion binding list.

### 4.2 `public.channel_accounts` (view)

- `create or replace view public.channel_accounts with (security_invoker = true) as select … from outreach_identities`.
- Exposes `id`, `channel`, `platform`, `display_name`, `profile_url`, `normalized_profile_url`,
  `managed_by_user_id`, `status`, `daily_target`, `daily_sent_count`, `notes`, `created_at`,
  `updated_at`, `deleted_at`.
- `grant select on public.channel_accounts to authenticated`.

**`security_invoker = true` is load-bearing.** A `security_definer` view would evaluate the base table's
RLS as the view owner and become a way around the `outreach_identities` policies. With `security_invoker`,
a caller sees exactly the rows the table policy already allows.

**Why a view rather than a rename.** Every V1 foreign key, trigger, policy and audit row names
`outreach_identities`. Renaming the table would rewrite history and break historical sender attribution;
the view moves only the product vocabulary.

### 4.3 `person_contact_points`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `person_id` | uuid not null → `people` on delete cascade | a contact point without a person is meaningless |
| `kind` | text not null | `email`, `linkedin`, `instagram`, `upwork`, `phone`, `website`, `other` |
| `value` | text not null | as observed, preserved for display and evidence |
| `normalized_value` | text not null | lower-cased email, canonicalised URL, digits-only phone |
| `label` | text | "work", "personal" |
| `is_primary` | boolean not null default false | at most one per `(person, kind)` |
| `confidence` | numeric(5,4) not null default 0.5 | 0–1 |
| `source` | text not null | required: a contact point without a source is not committable |
| `source_url` | text | |
| `observed_at` | timestamptz not null default now() | |
| `confirmed_by_user` | boolean not null default false | only a human action may set it |
| `agent_job_id` | uuid | when an agent job produced it |
| `created_by`, `created_at`, `updated_at`, `deleted_at` | | soft delete, consistent with the rest of the schema |

Constraints and indexes:

- `unique (person_id, kind, normalized_value)` — `Sarah@Acme.com` cannot be stored twice.
- `person_contact_points_one_primary` — partial unique `(person_id, kind) where is_primary and deleted_at is null`.
- `person_contact_points_person_idx (person_id, kind) where deleted_at is null`.
- `person_contact_points_normalized_idx (kind, normalized_value) where deleted_at is null`.

**Why it is backward compatible.** It is a new table. `people.primary_email` and
`people.normalized_linkedin_url` are untouched; `people.normalized_linkedin_url` remains the person dedupe
key (DB_CONTRACT §2 invariant 3), so no uniqueness behaviour changes for existing ingestion.

RLS: `enable` + `force`, with `select` using the existing `public.person_visible(person_id)` helper,
`insert`/`update` allowing an admin, a user with `can_use_lead_sources`, or an acting API client, and
`delete` admin-only. Grants: `select, insert, update` to `authenticated`; `delete, truncate` revoked.
Deleting is a soft delete (`deleted_at`), so the `delete` policy exists only to stop a hard delete.

**Not in this migration:** nothing constrains which outreach channel a lead discovered on one source may
be contacted through. `0030` adds no source↔channel relationship, by design (master spec §20).

---

## 5. `0031` — lead enrichment and ephemeral raw staging

### 5.1 `lead_enrichment` (1:1 with `leads`)

Primary key `lead_id` → `leads(id) on delete cascade`, plus `business_id` → `businesses(id) on delete
cascade`. Columns: `status` (9-value CHECK), `completeness_score` (integer 0–100), `missing_fields
text[] not null default '{}'`, `last_profile_enrichment_at`, `last_company_enrichment_at`,
`last_context_build_at`, `last_error_code`, and the profile provenance set `profile_source_type`,
`profile_source_url`, `profile_observed_at`, `profile_content_hash`, `profile_agent_job_id`,
`created_at`, `updated_at` (with the standard `touch_updated_at` trigger).

Indexes: `(business_id, status)` for the Overview/funnel counts, and
`(business_id, updated_at desc) where status in ('NEEDS_PROFILE','COMPANY_RESEARCH_PENDING','AGENT_RESEARCH_PENDING','FAILED')`
for the "needs work" queue.

**The seed trigger.** `leads_seed_enrichment` is an `AFTER INSERT` trigger on `leads` calling
`public.nexus_seed_lead_enrichment()`, which inserts a row with `status = 'NEEDS_PROFILE'` when
`leads.needs_profile` is true and `'MINIMAL'` otherwise, `on conflict (lead_id) do nothing`. The function
is deliberately **not** `SECURITY DEFINER`: it runs as the writer and the insert policy allows exactly
the callers that may create a lead in that business, so the trigger cannot become a privilege escalation.

**Backfill.** `insert into lead_enrichment … select … from leads where deleted_at is null on conflict do
nothing`. Deleted leads are skipped: their enrichment row would be a row nothing can read.

**Why it is backward compatible.** A new table plus one `AFTER INSERT` trigger on `leads`. The trigger
adds one row per new lead and never fails a lead insert (an `on conflict do nothing` insert of two
non-null values). No V1 column changes, so every existing writer (CSV import, paste, Companion,
`nexus.submit_candidate`, `nexus.create_or_update_lead`) keeps working and silently gains an enrichment
row.

RLS: `enable` + `force`; `select`, `insert`, `update` all gated on `has_business_access(business_id)`;
**no delete policy** — the row is derived from the lead and disappears with it through the foreign key, so
a delete could only ever lose the "why is this incomplete" answer. Grants: `select, insert, update` to
`authenticated`; `delete, truncate` revoked.

### 5.2 `source_evidence` — permanent metadata about bytes that no longer exist

`add column if not exists`: `raw_content_hash text`, `raw_bytes integer`, `raw_deleted_at timestamptz`,
`collector_agent text`, `agent_job_id uuid`, `prompt_version_id uuid → prompt_versions(id) on delete set
null`, `model text`, `extracted_at timestamptz`.

All nullable, so every existing row stays valid and `raw_text_or_json` is untouched. The `(business_id,
content_hash)` uniqueness from V1 is unchanged, so a rediscovery still inserts new evidence.

**What this migration does not do:** it does not purge, null or rewrite the `raw_text_or_json` bodies V1
already stored. Whether those are eventually emptied is master spec OPEN-12; until it is answered, nothing
here touches them. V1.2 ingestion paths must simply stop populating that column (master spec §32.2.3).

### 5.3 `raw_staging` — ephemeral and server-only

Columns: `id`, `business_id` (not null → `businesses`), `lead_id` (→ `leads` on delete cascade),
`person_id` (→ `people` on delete set null), `company_id` (→ `companies` on delete set null),
`agent_job_id`, `kind` (CHECK: `profile_paste`, `company_research`, `signal_research`,
`source_metadata`), `source_type`, `source_url`, `payload text not null`, `content_hash text not null`,
`collector_agent`, `status` (CHECK: `PENDING`, `PROCESSING`, `CONSUMED`, `FAILED`, `EXPIRED`),
`attempt_count`, `last_error_code`, `expires_at timestamptz not null default now() + interval '24 hours'`,
`consumed_at`, `created_by`, `created_at`, `updated_at`.

Indexes: `raw_staging_ttl_idx (expires_at) where consumed_at is null`,
`raw_staging_job_idx (agent_job_id) where consumed_at is null`,
`raw_staging_lead_idx (lead_id, created_at desc)`.

### 5.4 The `nexus_raw_writer` role and the raw staging policies

A policy cannot say "only server code": by the time SQL runs, the caller is a role. The migration
therefore:

1. creates `nexus_raw_writer` as `NOLOGIN NOINHERIT NOBYPASSRLS` if it does not exist;
2. attempts `grant nexus_raw_writer to current_user` inside a `do` block that swallows the failure
   (hosted projects may run migrations as a role that may not grant membership);
3. grants `usage on schema public` and `select, insert, update, delete on raw_staging` to the role;
4. `enable` + `force` RLS on `raw_staging`;
5. creates one policy for `all` with `using` **and** `with check` equal to
   `pg_has_role(current_user, 'nexus_raw_writer', 'member')`;
6. `revoke all on public.raw_staging from public, anon, authenticated`.

`NOBYPASSRLS` is deliberate: the role satisfies the policy rather than escaping it. `using` and
`with check` are identical so a writer cannot read back a row it could not have written.

**Operational caveat, and a required post-apply check.** If step 2 was skipped (the failure branch), the
definer functions are only able to write because the migration role itself bypasses RLS (a superuser, or
a role with `BYPASSRLS`). That must be verified, not assumed, on the target project:

```sql
-- expect: t (or the definer role is a superuser / has rolbypassrls)
select pg_has_role(current_user, 'nexus_raw_writer', 'member');
select rolname, rolsuper, rolbypassrls from pg_roles where rolname in (current_user, 'nexus_raw_writer');
-- expect: permission denied for table raw_staging
set local role authenticated; select count(*) from public.raw_staging;
```

If neither membership nor a bypassing owner holds, `nexus_stage_raw` will fail for every caller and the
raw pipeline is broken on that project. The remedy is to grant membership manually as an owner:
`grant nexus_raw_writer to <migration_role>;` and re-run `0031`.

### 5.5 The raw staging functions

| Function | Effect | Refusal |
| --- | --- | --- |
| `nexus_can_touch_raw(business_id)` | capability helper: admin, or a user with business access **and** `can_use_lead_sources`, or a token with `lead_sources:write` or `jobs:submit` | returns false |
| `nexus_stage_raw(...)` | inserts one staging row, `status='PENDING'`, `expires_at = now() + 24h`; refuses an empty payload and anything over 400 000 characters | raises `42501` / `22023` |
| `nexus_read_raw_staging(id)` | returns the row for one extraction attempt, moves `PENDING`→`PROCESSING`, increments `attempt_count` | returns **no rows** for an unknown id *and* for a row outside the caller's scope, so existence is not leaked |
| `nexus_delete_raw_staging(id)` | hard-deletes one row; returns whether a row was deleted | raises `42501` when the caller may not touch that business |
| `nexus_mark_raw_failed(id, error_code)` | sets `status='FAILED'` and stores **only** the error code, truncated to 120 characters | raises `42501` |
| `nexus_cleanup_raw_staging(limit default 200)` | TTL sweep: deletes rows where `expires_at < now()` and `consumed_at is null`, oldest first | — |

All six are `SECURITY DEFINER` with `SET search_path = public, pg_temp`, revoked from `public`/`anon` and
granted to `authenticated`. `nexus_cleanup_raw_staging` is idempotent and is intended to be called by the
V1.2 AI processor on every run, so an abandoned row lives at most one processor interval past expiry.

### 5.6 Why `0031` is backward compatible

- The only change to an existing table is eight nullable columns on `source_evidence`.
- The only trigger on an existing table inserts into a new table, with `on conflict do nothing`.
- `raw_staging` is new and invisible to every existing role: `authenticated` has no privileges on it at
  all, and the only policy requires a role membership no tenant role has.
- Every function is new.

---

## 6. `0032` — the durable agent job queue

### 6.1 `agent_jobs`

Full column list, with the semantics that matter:

| Column | Values / type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `business_id` | uuid not null → `businesses` | tenant boundary |
| `lead_id` | uuid → `leads` on delete cascade | nullable (a company-only research job) |
| `person_id` | uuid → `people` on delete set null | |
| `company_id` | uuid → `companies` on delete set null | |
| `job_type` | `RESEARCH_COMPANY`, `RESEARCH_PERSON`, `RESEARCH_SIGNALS`, `CAPTURE_PROFILE`, `ENRICH_PROFILE`, `QUALIFY_LEAD`, `BUILD_CONTEXT`, `DRAFT_OUTREACH`, `OTHER` | |
| `priority` | `low`, `normal`, `high`, `urgent`; default `normal` | drives claim ordering |
| `status` | `OPEN`, `RUNNING`, `WAITING_AI`, `COMPLETE`, `FAILED`, `CANCELLED`; default `OPEN` | |
| `instructions` | text | operator/rule brief; never raw evidence |
| `required_capabilities` | text[] not null default `{}` | claim requires `required_capabilities <@ agent_capabilities` |
| `created_by_type` | `user`, `api_client`, `system`, `agent`; default `system` | |
| `created_by_id` | uuid | |
| `claimed_by_agent` | text | an agent name, never a credential |
| `claimed_at`, `lease_expires_at`, `last_heartbeat_at` | timestamptz | lease bookkeeping |
| `attempt_count` | integer ≥ 0, default 0 | incremented by claim |
| `max_attempts` | integer 1–20, default 3 | |
| `last_error_code` | text | stable machine string, ≤ 120 characters at the write sites |
| `dedupe_key` | text | the stable key for automatic chaining |
| `reason` | text | why the job exists, in operator words |
| `result_ai_run_id` | uuid | the `ai_runs` row that produced the commit |
| `created_at`, `updated_at`, `completed_at` | timestamptz | `touch_updated_at` trigger |

Indexes:

- `agent_jobs_active_dedupe_key` — unique `(business_id, dedupe_key) where dedupe_key is not null and
  status in ('OPEN','RUNNING','WAITING_AI')`. Terminal rows keep their key, so a later re-creation is a
  new row and the history stays intact.
- `agent_jobs_claimable_idx (business_id, priority_rank, created_at) where status in ('OPEN','RUNNING')` —
  the claim ordering.
- `agent_jobs_status_idx (business_id, status, updated_at desc)` — the Agent Jobs screen.
- `agent_jobs_lead_idx (lead_id, created_at desc)` — the lead timeline / job panel.
- `agent_jobs_lease_idx (lease_expires_at) where status = 'RUNNING'` — the reaper.

### 6.2 `agent_job_events` (append-only)

Columns: `id`, `job_id` (→ `agent_jobs` on delete cascade), `business_id` (→ `businesses` on delete
cascade), `event_type`, `actor_type`, `actor_id`, `agent_name`, `note`, `payload jsonb default '{}'`,
`created_at`.

`event_type` CHECK: `created`, `claimed`, `heartbeat`, `released`, `failed`, `result_submitted`,
`ai_started`, `completed`, `cancelled`, `lease_expired`, `retry_scheduled`.

Indexes: `(job_id, created_at desc)`, `(business_id, created_at desc)`.

### 6.3 Read-only RLS with function-only writes

`agent_jobs` and `agent_job_events` are `enable` + `force` RLS with **only** a `select` policy
(`has_business_access(business_id)`). `authenticated` is granted `select`; `insert`, `update`, `delete`
and `truncate` are revoked. The reason is a security property, not tidiness: an `UPDATE` policy broad
enough to let the UI cancel a job would also be broad enough to let a caller write `COMPLETE`, which is
exactly the transition the raw-deletion rule forbids. Every mutation therefore goes through a function.

### 6.4 The functions, and the scopes they check

| Function | Scope checked | Behaviour |
| --- | --- | --- |
| `nexus_job_scope_ok(business_id, scope)` | — | admin, a user with business access **and** `can_manage_leads`, or a token allowed `scope` |
| `nexus_create_agent_job(...)` | `jobs:create` | inserts `OPEN`; `on conflict do nothing` on the dedupe key; returns `(job_id, created)`; on conflict returns the live job with `created = false`; appends a `created` event carrying `job_type`, `priority`, `dedupe_key`, `reason` |
| `nexus_claim_agent_job(business_id, agent, capabilities, job_id?, lease_seconds 900)` | `jobs:claim` | atomic `for update skip locked` claim of the highest-priority `OPEN` job or a `RUNNING` job whose lease expired, with `attempt_count < max_attempts` and capabilities satisfied; sets `RUNNING`, the claim, `lease_expires_at`, increments `attempt_count`, clears `last_error_code`; lease clamped to 30–7200 s; appends `claimed` |
| `nexus_heartbeat_agent_job(job_id, agent, lease_seconds 900)` | `jobs:claim` | extends the lease; refuses `55006` when the job is not `RUNNING` or is held by another agent; `P0002` for an unknown job; appends `heartbeat` |
| `nexus_release_agent_job(job_id, agent, reason?)` | `jobs:claim` | returns the job to `OPEN`, clears the claim; the attempt is **not** refunded; appends `released` |
| `nexus_fail_agent_job(job_id, agent, error_code, message?, retryable?)` | `jobs:submit` | `OPEN` when retryable and attempts remain, else `FAILED`; stores `last_error_code`; appends `retry_scheduled` or `failed` |
| `nexus_cancel_agent_job(job_id, reason?)` | `jobs:create` | `CANCELLED`; refuses to cancel a `COMPLETE` job (`55006`); appends `cancelled` |
| `nexus_submit_agent_job_result(job_id, agent, payload, content_hash, kind, source_type, source_url?)` | `jobs:submit` | only from `RUNNING` and only for the holder; stages the payload through `nexus_stage_raw`; sets `WAITING_AI`; clears the lease; appends `result_submitted` with `raw_staging_id`, `content_hash`, `kind`; **cannot reach `COMPLETE`** |
| `nexus_complete_agent_job(job_id, ai_run_id?)` | `jobs:submit` | only from `WAITING_AI`; **refuses while any `raw_staging` row for the job has `consumed_at is null`**; sets `COMPLETE`, `completed_at`, `result_ai_run_id`; appends `completed` |
| `nexus_reap_expired_job_leases(limit default 50)` | — (system) | `RUNNING` jobs whose lease expired go back to `OPEN`, or to `FAILED` with `last_error_code = 'lease_expired_no_attempts'` when attempts are exhausted; appends `lease_expired` |

All are `SECURITY DEFINER`, `SET search_path = public, pg_temp`, revoked from `public`/`anon`, granted to
`authenticated`.

**Why this is backward compatible.** Both tables are new; nothing existing references them; the only V1
surface that changes is that a `WAITING_AI` job holds a lease on the job row, which no V1 code reads.

### 6.5 The rule the database enforces

`nexus_complete_agent_job` is the only path to `COMPLETE`, and it is unreachable while staged evidence
still exists. That is the database-level expression of "OpenCode does not complete the job; a validated
structured commit does" (master spec §41.5). An implementer must not add a UI or MCP path that writes
`COMPLETE` directly, and the `select`-only RLS on `agent_jobs` makes such a path fail rather than pass
silently.

---

## 7. `0033` — AI runs, versioned prompts and context packs

### 7.1 `prompt_versions` — additive extension

Added columns: `business_id uuid → businesses(id) on delete cascade` (**NULL = global default**),
`system_prompt text`, `temperature numeric(3,2)`, `max_output_tokens integer`, `schema_ref text`,
`is_active boolean not null default true`, `notes text`, `updated_at timestamptz not null default now()`
(with a `touch_updated_at` trigger).

Constraints and indexes:

- `prompt_versions_global_key_version` — unique `(key, version) where business_id is null`.
- `prompt_versions_business_key_version` — unique `(business_id, key, version) where business_id is not null`.
- `prompt_versions_active_lookup (key, business_id, version desc) where is_active`.
- `temperature` check 0–2; `max_output_tokens` check 1–32 000.

**No unique index enforces "one active version per scope and key", deliberately.** Every existing row
becomes `is_active = true` the moment the column is added, so such an index would fail on live data and
block the migration. Activation is an application-level transaction (deactivate the siblings, activate
the chosen version), and `nexus_active_prompt` resolves the highest active version so a deployment that
somehow holds two still behaves deterministically.

Policies: `select` allows an admin, a global row, or a row whose `business_id` the actor can access;
`all` for write is admin-only. `nexus_active_prompt(key, business_id)` prefers an active business override
(`scope_rank 0`) over the active global default (`scope_rank 1`), then the highest version, and is the
only resolution path the application may use.

### 7.2 `ai_runs` — the ledger and the cache index

Columns: `id`, `business_id` (not null), `task` (7-value CHECK), `lead_id`, `person_id`, `company_id`,
`agent_job_id` (→ `agent_jobs` on delete set null), `message_instance_id`, `provider` (default
`deepseek`), `model`, `prompt_key`, `prompt_version_id` (→ `prompt_versions` on delete set null),
`prompt_version integer`, `input_hash text not null`, `status`, `cache_hit boolean not null default
false`, `tokens_in`, `tokens_out`, `estimated_cost_usd numeric(12,6)`, `duration_ms`, `attempt`, 
`error_code`, `created_at`, `completed_at`, plus a non-negative tokens check.

`status` CHECK: `PENDING`, `SUCCEEDED`, `FAILED`, `CACHED`, `SKIPPED`.

**There is no column for a request or a response body.** That is the point: the raw body is deleted after
commit, and a ledger that kept a copy would quietly undo the deletion policy. `prompt_key` carries the
prompt key (`profile_extract`, …), `input_hash` carries the normalised input identity,
`cache_hit`/`status = 'CACHED'` distinguishes a reuse from a call.

The cache index is the correctness mechanism:

```sql
create unique index ai_runs_cache_key on public.ai_runs (
  business_id, task, coalesce(prompt_version_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(model, ''), input_hash
) where status = 'SUCCEEDED' and cache_hit = false;
```

It is partial on `SUCCEEDED and cache_hit = false` so a failed attempt can never be reused as an answer,
and it covers exactly the four things that define "same input" (business, task, prompt version, model)
plus the hash.

Other indexes: `(business_id, task, created_at desc)`, `(business_id, created_at desc)`,
`(agent_job_id, created_at desc)`, `(lead_id, created_at desc)`, `(business_id, task, input_hash)`.

RLS: `enable` + `force`; `select`, `insert`, `update` gated on `has_business_access(business_id)`;
**no delete policy** and `delete, truncate` revoked — a ledger that can be edited or pruned is not a
ledger.

### 7.3 `ai_context_packs`

Columns: `id`, `business_id` (not null), `lead_id` (not null → `leads` on delete cascade), `version`
(> 0, default 1), `input_hash text not null`, `pack jsonb not null`, `source_summary jsonb not null
default '{}'`, `generated_by_run_id uuid → ai_runs(id) on delete set null`, `model`,
`prompt_version_id`, `created_by`, `created_at`, and `unique (lead_id, input_hash)`.

`source_summary` stores the **permanent facts** the pack was built from, so a cache miss can be explained
without re-reading a raw body that no longer exists. Neither `pack` nor `source_summary` may contain a raw
body (master spec §59.6, §52.3).

Indexes: `(lead_id, created_at desc)`, `(business_id, created_at desc)`. RLS: `enable` + `force`, all four
verbs gated on `has_business_access(business_id)`. The `unique (lead_id, input_hash)` constraint is what
makes a pack immutable in practice: a refresh with unchanged facts is a no-op, and a refresh with changed
facts is a new row, which is exactly the versioning rule.

**Backward compatibility.** `0033` only adds to `prompt_versions` (the one constraint replacement in
§2.2) and creates two new tables. V1 rows in `prompt_versions` remain valid, keep their `(key, version)`
uniqueness in the global scope, and become active by default.

---

## 8. `0034` — processor surface, read models and read indexes

### 8.1 `nexus_claim_ai_work(limit 5, business_id?, lease_seconds 600)`

Claims `WAITING_AI` jobs for the server-side processor, `for update skip locked`, ordered by
`created_at`, excluding a job whose lease is still live (so a crashed processor's work is picked up after
its lease lapses). Sets `claimed_by_agent = 'ai_processor'` and a lease clamped to 60–3600 s — it reuses
the job lease rather than adding a second locking mechanism.

Scope: a caller targeting one business needs `nexus_job_scope_ok(business_id, 'jobs:submit')`. A caller
sweeping **all** businesses must be an admin session or a scoped service token; an ordinary user is
refused with `42501`.

### 8.2 Three `security_invoker` read views

| View | Groups by | Feeds |
| --- | --- | --- |
| `ai_usage_daily` | `business_id`, day, `task`; counts runs/cache hits/failures, sums tokens and cost, averages duration | Overview "AI usage today", Insights |
| `agent_job_queue_summary` | `business_id`, `status`; counts jobs, oldest created, next lease expiry, total attempts | Agent Jobs screen summary buckets |
| `lead_enrichment_funnel` | `business_id`, `status`; counts leads, average completeness, error count | Overview enrichment funnel |

All three are `security_invoker`, so they are filtered by the RLS of the tables underneath and cannot
become a cross-business read. `grant select … to authenticated`.

### 8.3 Read indexes

| Index | Serves |
| --- | --- |
| `source_evidence_agent_job_idx (business_id, agent_job_id) where agent_job_id is not null` | the completion guard and the processor after a submit |
| `interactions_lead_recent_idx (lead_id, occurred_at desc)` | the Lead Detail timeline |
| `leads_business_source_idx (business_id, source_type) where deleted_at is null` | the Leads list "source" filter |
| `leads_needs_profile_idx (business_id, updated_at desc) where deleted_at is null and needs_profile` | the V1 "needs profile" queue, still valid |
| `signals_lead_active_recent_idx (lead_id, observed_at desc) where is_active` | the "latest signal" column |
| `people_linkedin_null_idx (updated_at desc) where normalized_linkedin_url is null and deleted_at is null` | deciding whether a profile capture is needed |

Partial where the query is partial, so the write cost of the busiest tables barely moves.

### 8.4 `nexus_retry_agent_job(job_id, reason?)`

The one transition an operator may make on a terminal job: `FAILED` or `CANCELLED` → `OPEN`, clearing
`last_error_code`, the claim and the lease, and resetting `attempt_count = 0` (a human explicitly granted
another run; without the reset a job at its attempt cap could never be retried). It refuses anything else
with `55006`, so it **cannot reach `COMPLETE`**. Scope: `jobs:create`.

---

## 9. `0035` — Companion binding scope

### 9.1 The corrected `companion_visible_business_ids(identity)`

V1 derived the visible set as `user_business_access INTERSECT outreach_identity_business_access` for every
caller. A global administrator holds no `user_business_access` row — `has_business_access` and
`visible_business_ids` short-circuit on `is_admin()` — so the intersection was empty for them, the
Companion offered no business, and every bind was refused.

The corrected rule:

- **a global administrator** sees every business in `outreach_identity_business_access` for the chosen
  identity;
- **anyone else** still needs `user_business_access INTERSECT` identity access — the V1 "never a union"
  rule is unchanged.

The admin branch widens **visibility** only. Binding authority is still checked separately, by
`companion_ineligible_reason` for a signed-in user and by the `0017` identity trigger for the account's
own availability.

### 9.2 `companion_ineligible_reason(identity, business)`

Returns one stable, non-disclosing code:

| Code | Meaning |
| --- | --- |
| `ok` | the pair may be bound (also returned for a NULL business, after the identity is validated) |
| `identity_not_usable` | the identity is missing, deleted, not `active`, or one this actor may not bind |
| `no_account_access` | the identity has no `outreach_identity_business_access` row for that business |
| `no_user_grant` | a signed-in non-admin has no `user_business_access` row for that business |

The function **never reads `public.businesses`**, so an unknown business id and an existing business the
account cannot reach both answer `no_account_access`. The identity is judged first, so a caller who may
not use the account learns nothing about any business. An admin and a service-token writer (`current_user_id()
is null`) answer `ok` after the account-access check, because they are already validated by their own
boundary.

### 9.3 `assert_companion_binding_scope()` trigger

`before insert or update of outreach_identity_id, default_business_id on browser_sessions`. It applies the
same rule to every write, so the pair the panel would not offer and the pair the database accepts are the
same set. It is deliberately narrow:

- it fires only when the identity or the default business is part of the statement, so a heartbeat
  (`last_active_at`) or a revocation (`status`) is never blocked by a binding that has since gone stale;
- it applies only to a signed-in user — a service-role writer and a scoped API client carry no `sub`
  claim, so `current_user_id()` is NULL for them and they are exempt, exactly as in `0017`'s service_role
  branch;
- **existing rows are not revalidated**: a binding made before this migration keeps working.

Grants: both helpers revoked from `public`/`anon` and granted to `authenticated`; the trigger function is
revoked from **every** API-reachable role including `authenticated`, because the database invokes it and
no caller may.

**Backward compatibility.** The function is replaced with `create or replace`, so it is a new definition of
an existing helper; a non-admin's visible set is unchanged; a service-role writer is unaffected; a
pre-existing row is not examined.

---

## 10. The RLS model of every new object, in one table

| Object | Select | Insert | Update | Delete | Notes |
| --- | --- | --- | --- | --- | --- |
| `outreach_identities.channel` | V1 policies unchanged | V1 | V1 | V1 | new column only |
| `channel_accounts` (view) | inherits `outreach_identities` | — | — | — | `security_invoker`, read-only |
| `person_contact_points` | `person_visible(person_id)` | admin \| `can_use_lead_sources` \| api client | same | admin (hard delete) | soft delete is the normal path |
| `lead_enrichment` | `has_business_access(business_id)` | same | same | **none** | derived from the lead |
| `source_evidence` (new columns) | V1 policies unchanged | V1 | V1 | V1 | nullable additions |
| `raw_staging` | `pg_has_role(current_user,'nexus_raw_writer','member')` | same | same | same | `FORCE` RLS; nothing granted to `authenticated`; all access via `SECURITY DEFINER` functions |
| `agent_jobs` | `has_business_access(business_id)` | **none** | **none** | **none** | all writes via functions, so `COMPLETE` cannot be forged |
| `agent_job_events` | `has_business_access(business_id)` | **none** | **none** | **none** | append-only, written by the functions |
| `prompt_versions` (V1.2 columns) | admin \| global row \| `has_business_access(business_id)` | admin | admin | admin | activation is admin-only |
| `ai_runs` | `has_business_access(business_id)` | same | same | **none** | ledger: insert + update, never delete |
| `ai_context_packs` | `has_business_access(business_id)` | same | same | same | versions are immutable in practice via `unique (lead_id, input_hash)` |
| `ai_usage_daily`, `agent_job_queue_summary`, `lead_enrichment_funnel` (views) | inherits the base tables | — | — | — | `security_invoker` |

Every table above is `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY`, so no table relies on
an owner or a service-role bypass for correctness.

---

## 11. Backfills, and the absence of backfills

| Object | Backfill | Convergence |
| --- | --- | --- |
| `outreach_identities.channel` | `update … set channel = case platform … end where channel is null` | idempotent: a second run updates nothing |
| `lead_enrichment` | `insert … select id, business_id, case when needs_profile then 'NEEDS_PROFILE' else 'MINIMAL' end from leads where deleted_at is null on conflict (lead_id) do nothing` | idempotent |
| new leads | the `leads_seed_enrichment` trigger | one row per lead, `on conflict do nothing` |
| `prompt_versions` | none needed: `is_active` defaults to `true`, `business_id` stays null (global) | — |
| `ai_runs`, `ai_context_packs`, `agent_jobs`, `agent_job_events`, `raw_staging`, `person_contact_points` | none — new tables with no V1 counterpart | — |
| `source_evidence` V1.2 columns | none; they stay null for historical rows | — |

Two deliberate non-backfills worth stating:

- **Deleted leads get no `lead_enrichment` row.** A row for a soft-deleted lead is unreadable by the
  product and would only distort a funnel count.
- **Historical `source_evidence` rows keep their `raw_text_or_json`.** `0031` does not purge them
  (master spec OPEN-12). If the product later decides they must go, that is a separate, explicitly
  authorised migration, not a side effect of applying V1.2.

Domain backfill of *facts* (a person's title, a company's domain) is out of scope for the schema
migrations: that is enrichment work and belongs to the job queue.

---

## 12. Where the migrations differ from the frozen V1.2 outline

Recorded so the difference is not read as an omission:

1. **`0034` is named `0034_v1_2_processor_and_read_models.sql`, not `0034_v1_2_rls_and_indexes.sql`.**
   The outline expected `0034` to carry "RLS policies, FORCE RLS, grants and indexes for every new
   table". The implementation instead put each new table's RLS, `FORCE` and grants **inline in the
   migration that creates it** (`0030`, `0031`, `0032`, `0033`), which keeps a table and its policies in
   one reviewable file, and used `0034` for what was left: the processor claim function, the
   `security_invoker` read views plus their grants, the additional read indexes, and the operator retry
   function. The RLS model is complete (§10); it is just distributed rather than centralised.
2. **`person_contact_points` has no `provenance jsonb` column.** The frozen column list named one; the
   implementation carries `source`, `source_url`, `observed_at`, `agent_job_id` and `created_by` instead.
   Whether a distinct `provenance` column is still required is master spec OPEN-8.
3. **No migration persists the V1.2 discovery-source vocabulary.** `DISCOVERY_SOURCES` and the V1.1→V1.2
   projection exist in `packages/core/src/vocabulary.ts`, but no migration widens `leads.source_type`'s
   CHECK or adds a column (master spec OPEN-1). `0034` indexes the existing `leads.source_type`.
4. **No uniqueness on `(channel, display_name)`** for `channel_accounts` (master spec OPEN-9), and
   **no unique index on "one active prompt version per scope and key"** (§7.1, master spec OPEN-13,
   resolved as "not enforced; resolved deterministically instead").
5. **`lead_enrichment.completeness_score` is `integer` 0–100** with no readiness threshold encoded in the
   schema; the threshold is application policy and is master spec OPEN-5.

---

## 13. Verification

### 13.1 Automated

```
pnpm run db:verify
pnpm --filter @nexus/db run test        # includes migration-idempotency, invariants, RLS access
```

The V1.2-specific suites that must exist and pass:

| Test file | What it must prove |
| --- | --- |
| `packages/db/test/migration-idempotency.test.ts` | `0030`–`0035` apply twice with an identical resulting schema and row counts |
| `packages/db/test/v1-2-raw-lifecycle.test.ts` | raw staging is unreadable as `authenticated`; a staged row is readable, markable failed and deletable only through the definer functions; the TTL sweep removes an expired row and leaves a consumed one alone; `nexus_complete_agent_job` refuses while an un-consumed row exists |
| `packages/db/test/v1-2-agent-jobs.test.ts` | two racing claims produce one winner; an expired lease is re-claimable; the reaper never leaves a job `RUNNING`; the dedupe unique index returns the live job instead of inserting a second; `nexus_submit_agent_job_result` never yields `COMPLETE`; a non-retryable failure is terminal |
| `packages/db/test/rls-access.test.ts` | the new tables appear in the policy matrix assertions; `raw_staging` is SELECT-denied for `authenticated` |
| `apps/web/test/mcp-gateway.test.ts` (+ the new V1.2 MCP suite) | the twelve new tools: published schema, happy path, refusal, scope, idempotency replay and collision, typed-validation failure |

### 13.2 Manual, on the target project after applying

```sql
-- 1. every lead has an enrichment row
select count(*) from public.leads where deleted_at is null;
select count(*) from public.lead_enrichment;

-- 2. no lead is left without one, and no orphan exists
select count(*) from public.leads l left join public.lead_enrichment e on e.lead_id = l.id
 where l.deleted_at is null and e.lead_id is null;   -- expect 0

-- 3. the channel backfill is complete and only 'twitter' diverged from platform
select channel, platform, count(*) from public.outreach_identities
 group by channel, platform order by 3 desc;

-- 4. no outreach identity lost its channel
select count(*) from public.outreach_identities where channel is null;   -- expect 0

-- 5. the prompt registry is intact and every V1 row is still active
select key, version, business_id, is_active from public.prompt_versions order by key, version;

-- 6. the raw staging surface is not tenant-reachable
set local role authenticated;
select count(*) from public.raw_staging;                                 -- expect permission denied
select pg_has_role(current_user, 'nexus_raw_writer', 'member');          -- expect f

-- 7. the new views are filtered, not open
select count(*) from public.ai_usage_daily;      -- only the rows the caller's access allows
select count(*) from public.agent_job_queue_summary;
select count(*) from public.lead_enrichment_funnel;
```

### 13.3 What must be true before a Preview deployment

- All six migrations applied in order, with no statement error in the migration log.
- The four `do` blocks and every `grant`/`revoke` reported success.
- §13.2's seven checks pass.
- `pnpm run db:verify` passes against the target (not only against the local PGlite harness).
- The application's `service`/`anon`/`authenticated` roles reflect §10 — in particular that
  `authenticated` has **no** privilege on `raw_staging`.

---

## 14. Forward-only posture

- **There are no down migrations.** A rollback is either a restore or a *new* additive migration.
- **Once applied anywhere, `0030`–`0036` are frozen.** A defect is fixed by the next number, exactly as
  `0029` fixed `0028`'s first deployed revision and `0035` fixed `0001`'s helper. Editing an applied
  migration means two databases with the same version number and different schemas.
- **Dropping something is not a rollback.** Dropping `raw_staging`, `agent_jobs` or `ai_runs` would delete
  in-flight work and the cost ledger; if a surface must be retired, retire the code path and leave the
  table, or write a migration that is explicit about what it destroys and why.
- **No migration in this set touches `0001`–`0029`'s statements.** The two behaviours they replace
  (`companion_visible_business_ids`, `prompt_versions_key_version_key`) are replaced from `0035`/`0033`,
  which is the only safe direction.
