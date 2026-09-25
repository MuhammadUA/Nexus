# NEXUS — Database Contract

This document is the binding interface between the SQL migrations in
`packages/db/migrations/` and the TypeScript code in `packages/core` and
`packages/api`. Both sides are written against it.

Everything here derives from `Nexus_CRM_Master_Spec_v1.json`:

| Contract area | Spec section |
| --- | --- |
| Table list | `data_model.recommended_tables` |
| Required columns | `data_model.critical_fields` |
| Uniqueness / indexes | `data_model.indexes_and_uniqueness` |
| Invariants | `lead_invariants` |
| Lifecycle | `lead_lifecycle` |
| Sequence entities | `sequence_engine.entities` |
| Permissions | `roles_and_permissions`, `extension_visibility_rule` |
| Write requirements | `mcp_contract.write_requirements` |
| Soft delete | `security_and_reliability.rules` |

## 0. Conventions

- **Schema**: single application schema, `public`. Supabase's `auth.users` is the
  credential table; `public.users` is the profile row keyed by the same UUID.
- **Primary keys**: `uuid` default `gen_random_uuid()`.
- **Timestamps**: `timestamptz not null default now()`.
- **Soft delete**: `deleted_at timestamptz` (nullable). Nothing is hard-deleted
  except through the audited admin flow.
- **Money / numbers**: `numeric(14,2)` where money, `integer` for counts.
- **Enums**: Postgres `text` + `CHECK (col = ANY (ARRAY[...]))` rather than native
  `enum` types, so adding a vocabulary value is a data migration not a type
  migration, and so the values stay greppable against `packages/core/src/vocabulary.ts`.
- **RLS**: every business-scoped table is `ENABLE ROW LEVEL SECURITY` **and**
  `FORCE ROW LEVEL SECURITY`, with explicit policies. No table relies on a
  "service role bypass" for correctness.
- **Tenant predicate**: RLS reads the current actor via helper functions, never
  via a client-supplied column:

  ```
  public.current_user_id()            -- auth.uid() :: uuid, or NULL for API clients
  public.is_admin()                   -- role = 'admin'
  public.has_business_access(uuid)    -- user_business_access row exists
  public.visible_business_ids()       -- setof uuid for IN (...) predicates
  public.api_client_scopes()          -- text[] of the acting service token's scopes
  public.acting_api_client_id()       -- uuid of the acting service token, or NULL
  ```

  In Supabase, `public.current_user_id()` wraps `auth.uid()`. Because `auth.uid()`
  reads `request.jwt.claims`, the local PGlite test harness emulates it by
  `SET LOCAL request.jwt.claims = '{"sub":"<uuid>"}'`, so the *same* policy SQL is
  exercised locally and in production. `auth.uid()` is provided by a shim
  migration guarded by `IF NOT EXISTS` so the real Supabase function always wins.

## 1. Tables

`data_model.recommended_tables` is the required list. Every one of the following
must exist. The parenthetical column list marks columns that the spec names
explicitly in `data_model.critical_fields` and are therefore mandatory by name.

### 1.1 Tenancy & access
| Table | Notes |
| --- | --- |
| `users` | `id uuid pk` (mirrors `auth.users.id`), `email`, `full_name`, `role` (`admin`/`manager`/`user`), `status`, `created_at`, `updated_at`, `deleted_at` |
| `teams` | `id`, `name`, `business_id` (nullable = cross-business team), `created_at` |
| `team_members` | `team_id`, `user_id`, `team_role` |
| `businesses` | `id`, `key` (unique slug), `name`, `focus`, `regions text[]`, `status`, `is_template`, `settings jsonb`, `created_at`, `updated_at`, `deleted_at` |
| `business_domains` | `id`, `business_id`, `domain`, `normalized_domain`, `domain_type` (`primary`/`alias`/`parent_source`/`service`), `is_default`, `notes` |
| `user_business_access` | `user_id`, `business_id`, `access_level`, `can_manage_leads`, `can_use_lead_sources`, `can_use_profile_queue`, `can_delete_leads`, `created_by`, unique `(user_id, business_id)` |
| `user_lead_scope` | optional per-user lead scoping: `user_id`, `business_id`, `mode` (`all`/`assigned`/`own`), `icp_ids uuid[]` |

### 1.2 Business Brain
| Table | Notes |
| --- | --- |
| `personas` | `business_id`, `name`, `description`, `pain_points text[]`, `goals text[]`, `approved boolean` |
| `offers` | `business_id`, `name`, `description`, `positioning`, `cta_style`, `approved boolean`, `version` |
| `services` | `business_id`, `name`, `description`, `category`, `approved boolean` |
| `value_propositions` | `business_id`, `persona_id` (nullable), `icp_id` (nullable), `statement`, `proof_required boolean`, `approved boolean` |
| `knowledge_assets` | `id`, `business_id`, `type` (one of `business_brain_and_knowledge.asset_types`), `url`, `title`, `description`, `tags text[]`, `ai_use_allowed boolean default false`, `may_mention_client_name boolean default false`, `may_mention_numeric_results boolean default false`, `approval_state`, `current_version_id`, `created_by`, `deleted_at` |
| `knowledge_asset_versions` | `id`, `asset_id`, `version`, `content_hash`, `raw_content`, `extracted jsonb`, `created_by`, `created_at`, unique `(asset_id, version)` |
| `asset_extractions` | `id`, `asset_version_id`, `kind` (`case_study`/`youtube`/`generic`), `fields jsonb`, `confidence numeric`, `model`, `prompt_version_id`, `created_at` |
| `asset_tags` | `asset_id`, `tag`, `weight` |
| `prompt_versions` | `id`, `key`, `version`, `purpose`, `template`, `model`, `created_at`, unique `(key, version)` |
| `scoring_rules` | `id`, `target_type` (`icp`/`business`/`global`), `target_id` (nullable), `signal_kind`, `polarity`, `points integer`, `label`, `is_active` |

### 1.3 Canonical identities (GLOBAL — no `business_id`)
| Table | Notes |
| --- | --- |
| `companies` | `id`, `name`, `normalized_name`, `normalized_domain` (unique when non-null), `primary_domain`, `industry`, `employee_count`, `hq_country`, `linkedin_url`, `normalized_linkedin_url`, `description`, `created_at`, `updated_at`, `deleted_at` |
| `people` | `id`, `full_name`, `normalized_name`, `first_name`, `last_name`, `headline`, `job_title`, `location`, `primary_email`, `normalized_linkedin_url` (**UNIQUE when non-null**), `linkedin_url`, `company_id`, `created_at`, `updated_at`, `deleted_at` |
| `social_profiles` | `id`, `person_id` (nullable), `company_id` (nullable), `platform`, `profile_url`, `normalized_url`, `handle`, `source`, `first_seen_at`, `last_seen_at`, unique `(platform, normalized_url)`; CHECK exactly one of person/company is set |
| `signals` | `id`, `business_id` (nullable = global signal), `company_id`, `person_id`, `lead_id`, `kind`, `polarity`, `strength integer`, `label`, `detail`, `observed_at`, `expires_at`, `is_active`, `created_by`, `created_at` |
| `source_evidence` | `id`, `business_id`, `person_id`, `company_id`, `lead_id`, `source`, `source_url`, `raw_text_or_json`, `content_hash`, `observed_at`, `captured_at`, `confidence`, `created_by`, `created_at`; unique `(business_id, content_hash)` |
| `research_snapshots` | `id`, `business_id`, `lead_id`, `person_id`, `company_id`, `summary`, `findings jsonb`, `model`, `prompt_version_id`, `created_by`, `created_at` |

### 1.4 Business-scoped CRM
| Table | Notes |
| --- | --- |
| `leads` | **exact spec columns**: `id`, `business_id`, `person_id`, `company_id`, `primary_icp_id`, `owner_user_id`, `outreach_identity_id`, `status`, `source_type`, `source_url`, `sequence_enrollment_id`, `next_action_type`, `next_action_at`, `deleted_at`, `created_at`, `updated_at`. Plus: `needs_profile boolean`, `lost_reason`, `is_dnc boolean`, `import_batch_id`, `created_by`, `deleted_by`, `archived_at`, `last_activity_at`, `duplicate_of_lead_id` |
| `lead_icp_matches` | **exact spec columns**: `lead_id`, `icp_id`, `is_primary`, `match_score`, `reason`, `created_at`; pk `(lead_id, icp_id)`; partial unique on `(lead_id) WHERE is_primary` |
| `lead_assignments` | `id`, `lead_id`, `business_id`, `from_user_id`, `to_user_id`, `reason`, `actor_user_id`, `created_at` |
| `icps` | `id`, `business_id`, `name`, `description`, `criteria jsonb`, `is_default`, `is_active`, `scoring_overrides jsonb`, `default_sequence_id`, `routing jsonb`, `created_at`, `updated_at`, `deleted_at` |
| `notes` | `id`, `business_id`, `lead_id`, `person_id`, `author_user_id`, `body`, `is_internal`, `created_at`, `deleted_at` |
| `tasks` | **exact spec fields**: `id`, `lead_id`, `business_id`, `owner_user_id`, `type`, `title`, `due_at`, `priority`, `reminder_at`, `status`, `note`, `source`; plus `completed_at`, `snoozed_until`, `created_by`, `created_at`, `updated_at`, `deleted_at` |
| `interactions` | `id`, `business_id`, `lead_id`, `person_id`, `conversation_id`, `type` (`interaction_types`), `actor_user_id`, `outreach_identity_id`, `direction`, `summary`, `payload jsonb`, `source_client`, `occurred_at`, `created_at` |
| `cooldowns` | `id`, `business_id`, `lead_id`, `person_id`, `reason`, `starts_at`, `ends_at`, `is_active`, `created_at` |
| `contact_suppressions` | **exact spec fields**: `id`, `person_id`, `channel`, `reason`, `source_reply_id`, `active`, `created_at`; plus `business_id` (nullable = global), `created_by`, `revoked_at`, `revoked_by`, `evidence text` |
| `opportunities` | `id`, `business_id`, `lead_id`, `name`, `stage`, `value numeric`, `currency`, `expected_close_at`, `created_at`, `updated_at` |
| `rfps` | `id`, `business_id`, `lead_id`, `company_id`, `title`, `source_url`, `deadline_at`, `min_days_before_deadline integer default 2`, `state`, `detail jsonb`, `created_at` |

### 1.5 Identities, browsers
| Table | Notes |
| --- | --- |
| `outreach_identities` | **exact spec fields**: `id`, `platform`, `display_name`, `profile_url`, `managed_by_user_id`, `status`, `daily_target`, `optional_browser_profile_id`, `created_at`, `updated_at`; plus `normalized_profile_url`, `daily_sent_count`, `daily_count_reset_at`, `notes`, `deleted_at` |
| `outreach_identity_business_access` | `outreach_identity_id`, `business_id`, unique pair |
| `browser_sessions` | **exact spec fields**: `id`, `user_id`, `browser_fingerprint_or_install_id`, `outreach_identity_id`, `default_business_id`, `last_active_at`, `status`; plus `created_at`, `revoked_at`, `user_agent`, unique `(outreach_identity_id) WHERE status='active'` unless concurrency allowed |
| `identity_transfers` | `id`, `outreach_identity_id`, `from_user_id`, `to_user_id`, `actor_user_id`, `confirmed boolean`, `note`, `created_at` |

### 1.6 Sequence engine
| Table | Notes |
| --- | --- |
| `sequences` | `id`, `business_id`, `name`, `description`, `is_default`, `status`, `current_version_id`, `created_at`, `updated_at`, `deleted_at` |
| `sequence_versions` | `id`, `sequence_id`, `version`, `status` (`draft`/`published`/`archived`), `published_at`, `published_by`, `change_summary`, `impact_preview jsonb`, `created_at`, unique `(sequence_id, version)` |
| `sequence_steps` | `id`, `sequence_version_id`, `step_order`, `kind`, `name`, `delay_days`, `delay_basis`, `goal`, `allowed_context text[]`, `word_max`, `cta_style`, `prohibited_phrases text[]`, `proof_policy`, `tone`, `generation_mode`, `is_active`, unique `(sequence_version_id, step_order)` |
| `sequence_enrollments` | `id`, `business_id`, `lead_id`, `sequence_id`, `sequence_version_id`, `state`, `current_step_order`, `started_at`, `completed_at`, `paused_at`, `pause_reason`, `dormant_at`, `reactivation_due_at`, `created_at`, `updated_at`; unique `(lead_id) WHERE state IN ('active','paused','reactivation_due')` |
| `conversations` | `id`, `business_id`, `lead_id`, `channel`, `sender_identity_id`, `default_owner_user_id`, `last_outbound_at`, `last_inbound_at`, `created_at`, `updated_at`; unique `(lead_id, channel)` |
| `conversation_outcomes` | `id`, `conversation_id`, `lead_id`, `business_id`, `outcome`, `is_terminal`, `reason`, `source_reply_id`, `actor_user_id`, `created_at` |
| `message_instances` | **exact spec fields**: `id`, `conversation_id`, `sequence_step_id`, `state`, `current_version_id`, `due_at`, `sent_at`; plus `business_id`, `lead_id`, `step_order`, `step_kind`, `invalidated_at`, `regeneration_reason`, `snoozed_until`, `created_at`, `updated_at` |
| `message_versions` | **exact spec fields**: `id`, `message_instance_id`, `content`, `generated_by_model`, `prompt_version_id`, `sequence_version_id`, `business_context_version_id`, `asset_version_refs uuid[]`, `created_by`, `created_at`; plus `version_no`, `subject`, `is_manual_edit`, unique `(message_instance_id, version_no)` |
| `message_events` | **exact spec fields**: `id`, `message_instance_id`, `event_type`, `actor_user_id`, `outreach_identity_id`, `source_client`, `note`, `created_at`; plus `business_id`, `lead_id`, `message_version_id`, `payload jsonb` |
| `business_context_versions` | `id`, `business_id`, `version`, `snapshot jsonb`, `reason`, `created_by`, `created_at` |

### 1.7 Ingestion
| Table | Notes |
| --- | --- |
| `import_batches` | **exact spec fields**: `source`, `business`, `requested_primary_icp`, `created_count`, `updated_count`, `duplicate_count`, `needs_profile_count`, `failed_count`, `created_by`, `created_at`; plus `id`, `business_id`, `requested_icp_id`, `auto_match boolean`, `row_count`, `skipped_count`, `status`, `undone_at`, `undone_by`, `idempotency_key`, `raw_summary jsonb`; unique `(idempotency_key)` when non-null |
| `import_rows` | `id`, `batch_id`, `row_number`, `raw jsonb`, `normalized jsonb`, `result`, `lead_id`, `person_id`, `company_id`, `message`, `created_at` |
| `profile_capture_queue` | `id`, `business_id`, `lead_id`, `person_id`, `state`, `reason`, `assigned_user_id`, `captured_at`, `attempts`, `last_error`, `created_at`, `updated_at`; unique `(lead_id) WHERE state IN ('pending','in_progress')` |
| `duplicate_candidates` | `id`, `business_id`, `incoming_person_id`, `existing_person_id`, `existing_lead_id`, `match_reason`, `confidence`, `status` (`open`/`merged`/`kept_separate`/`skipped`), `resolution`, `resolved_by`, `resolved_at`, `payload jsonb`, `created_at` |
| `ingest_requests` | `id`, `source_client`, `business_id`, `payload_type`, `idempotency_key`, `observed_at`, `payload jsonb`, `content_hash`, `status`, `result jsonb`, `error`, `created_at`; unique `(source_client, business_id, idempotency_key)` |

### 1.8 Integrations / automation / audit
| Table | Notes |
| --- | --- |
| `api_clients` | `id`, `name`, `kind` (`mcp`/`rest_ingest`/`webhook`/`internal_worker`), `token_hash` (unique), `token_prefix`, `scopes text[]`, `business_ids uuid[]` (empty = none), `is_active`, `last_used_at`, `expires_at`, `rate_limit_per_minute`, `created_by`, `created_at`, `revoked_at`; **never stores a plaintext token** |
| `webhook_endpoints` | `id`, `business_id`, `name`, `url`, `secret_hash`, `events text[]`, `is_active`, `last_status`, `last_delivery_at`, `created_at` |
| `webhook_deliveries` | `id`, `endpoint_id`, `event`, `payload jsonb`, `status`, `attempts`, `response_code`, `error`, `created_at`, `delivered_at` |
| `automation_configs` | `id`, `business_id`, `name`, `runner` (`browseros`/`opencode`/`n8n`/`other`), `purpose`, `run_mode`, `schedule`, `source_type`, `icp_id`, `data_contract jsonb`, `is_active`, `last_run_at`, `created_by`, `created_at`, `updated_at` |
| `agent_runs` | `id`, `business_id`, `automation_config_id`, `api_client_id`, `actor_user_id`, `agent_name`, `objective`, `state`, `started_at`, `finished_at`, `summary`, `result jsonb`, `error`, `stats jsonb` |
| `audit_events` | **exact spec fields**: `id`, `actor_type`, `actor_id`, `business_id`, `entity_type`, `entity_id`, `action`, `before_json`, `after_json`, `source_client`, `created_at`; plus `api_client_id`, `ip`, `user_agent`, `correlation_id` |
| `saved_views` | `id`, `business_id`, `owner_user_id`, `scope` (`leads`/`today`/`companion_leads`), `name`, `filters jsonb`, `sort jsonb`, `is_shared`, `created_at` |
| `platform_settings` | `id`, `business_id` (nullable = global), `key`, `value jsonb`, `updated_by`, `updated_at`, unique `(business_id, key)`; mirrors `screen_inventory` A22 (security, retention, soft delete, DNC, uniqueness defaults, reply pause, dormant defaults) |

## 2. Enforced invariants (constraints, not just application code)

| # | Invariant (spec) | Enforcement |
| --- | --- | --- |
| 1 | "Within the same business, a Person may have only one active Lead" | `UNIQUE (business_id, person_id) WHERE deleted_at IS NULL` on `leads` |
| 2 | "exactly one Primary ICP may be active at a time" | `UNIQUE (lead_id) WHERE is_primary` on `lead_icp_matches` |
| 3 | "Normalized LinkedIn URL is the strongest person dedupe key" | `UNIQUE (normalized_linkedin_url) WHERE normalized_linkedin_url IS NOT NULL` on `people` |
| 4 | "Normalized company domain is the strongest company dedupe key" | `UNIQUE (normalized_domain) WHERE normalized_domain IS NOT NULL` on `companies` |
| 5 | "Rediscovery creates a new Signal/SourceEvidence" | `UNIQUE (business_id, content_hash)` on `source_evidence`; no unique on `signals` |
| 6 | Ingestion idempotency | `UNIQUE (source_client, business_id, idempotency_key)` on `ingest_requests` |
| 7 | "Sent message content is immutable" | trigger `enforce_message_immutability()` — `message_versions` rows whose instance is `SENT` cannot be UPDATEd or DELETEd; `message_instances.state` cannot leave `SENT` |
| 8 | "Explicit DNC creates a person+channel suppression across all outreach identities" | `enforce_dnc_suppression()` trigger on `conversation_outcomes` inserts an active `contact_suppressions` row when `outcome = 'Do not contact'`; `block_dnc_message()` trigger on `message_instances` rejects a transition to `SENT` while an active suppression exists for that person+channel |
| 9 | "Reply pauses/cancels pending sequence steps by default" | `pause_sequence_on_reply()` trigger on `conversation_outcomes`: sets enrollment `state='paused'`, cancels pending `message_instances` |
| 10 | Only one active enrollment per lead | partial unique on `sequence_enrollments` |
| 11 | "permanent deletion is admin-only/audited" | `prevent_hard_delete()` trigger on `leads`, `people`, `companies` raising unless `current_setting('nexus.allow_hard_delete', true) = 'on'` |
| 12 | Exactly one primary business domain default | partial unique `(business_id) WHERE is_default AND domain_type='primary'` |
| 13 | Business domain is globally unique | `UNIQUE (normalized_domain)` on `business_domains` |
| 14 | "Each OutreachIdentity has its own business access" | `outreach_identity_business_access` + `has_identity_business_access()` RLS helper |
| 15 | Browser session bound only to an identity the user may use | trigger `validate_browser_session_identity()` |
| 16 | `leads.status` must be a spec lead state | CHECK against `LEAD_STATES` |
| 17 | `leads.next_action_type` must be a spec next-action | CHECK against `NEXT_ACTION_TYPES` |
| 18 | `source_evidence` requires provenance | `NOT NULL` on `source`, `observed_at`, `content_hash`, `confidence` |
| 19 | `message_versions` requires audit refs | `sequence_version_id`, `prompt_version_id` nullable but `created_by` NOT NULL unless generated by an api_client |
| 20 | Every audited mutation appends an `audit_events` row | `audit_row_change()` triggers on the sensitive tables |

## 3. RLS policy matrix

`has_business_access(b)` is `is_admin() OR EXISTS (user_business_access ...)`.
Companion visible businesses = `user_business_access INTERSECT identity business access`
— implemented by `public.companion_visible_business_ids(identity uuid)`.

| Table | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- |
| `users` | own row, admin all | admin | own profile (not `role`), admin all | admin (soft) |
| `businesses` | `has_business_access(id)` | admin | admin | admin |
| `business_domains` | `has_business_access(business_id)` | admin | admin | admin |
| `user_business_access` | own row, admin all | admin | admin | admin |
| `icps`, `sequences`, `knowledge_assets`, `offers`, `services`, `personas`, `value_propositions`, `scoring_rules` | `has_business_access(business_id)` | admin | admin | admin |
| `companies`, `people`, `social_profiles` | any user with access to **any** business that has a lead for that person, or admin; plus rows referenced by the user's own leads | admin or user with `can_use_lead_sources` in any accessible business | same as insert | admin |
| `leads` | `has_business_access(business_id)` AND lead-scope filter (`all`/`assigned`/`own`) | `has_business_access` + `can_manage_leads` | same | soft delete: owner/manager/admin with `can_delete_leads`; hard delete admin only |
| `lead_icp_matches`, `notes`, `tasks`, `interactions`, `cooldowns`, `opportunities`, `rfps` | `has_business_access(business_id)` | same + not DNC-blocked | same | soft delete per permission |
| `contact_suppressions` | `has_business_access(business_id)` or `business_id IS NULL` | admin/manager | admin/manager | admin |
| `signals`, `source_evidence`, `research_snapshots` | `has_business_access(business_id)` | `can_use_lead_sources` | same | admin |
| `outreach_identities` | admin all; user only identities where `managed_by_user_id = current_user_id()` | admin | admin or owner (display_name/target only) | admin |
| `outreach_identity_business_access` | admin, or owner of the identity | admin | admin | admin |
| `browser_sessions` | own rows, admin all | own rows + identity assigned to self | own rows | own rows, admin |
| `conversations`, `conversation_outcomes`, `message_instances`, `message_versions`, `message_events`, `sequence_enrollments` | `has_business_access(business_id)` | same | SENT rows immutable (trigger) | never (append-only) |
| `sequences`, `sequence_versions`, `sequence_steps` | `has_business_access(business_id)` | admin | admin | admin |
| `import_batches`, `import_rows`, `profile_capture_queue`, `duplicate_candidates` | `has_business_access(business_id)` | `can_use_lead_sources` | same | admin |
| `api_clients`, `webhook_endpoints`, `automation_configs` | admin only | admin | admin | admin |
| `agent_runs` | `has_business_access(business_id)` | api client with scope or admin | same | admin |
| `audit_events` | admin only; a user may read events for their own `actor_id` | insert-only for any authenticated writer | never | never |
| `saved_views` | own or `is_shared` within accessible business | own | own | own |
| `platform_settings` | `business_id IS NULL` readable by all authenticated; business rows via access | admin | admin | admin |

**API-client path.** When a service token acts, `current_user_id()` is NULL and
`acting_api_client_id()` is set. Policies that allow API clients additionally
require the target `business_id` to be in `api_clients.business_ids` and the
required scope to be present in `api_clients.scopes`. A token can never exceed its
scopes — enforced in policy, and asserted by test `rls: external token cannot
exceed its scopes`.

## 4. Functions / RPCs the application calls

| Function | Purpose |
| --- | --- |
| `public.one_primary_icp_per_lead(lead_id uuid)` | returns the primary ICP id or NULL |
| `public.set_primary_icp(lead_id uuid, icp_id uuid)` | audited swap of the primary ICP match, keeping secondaries |
| `public.mark_connection_sent(lead_id uuid, identity uuid, action text, source_client text)` | writes the connection event, advances the enrollment to Message 1 due |
| `public.mark_message_sent(message_instance_id uuid, identity uuid, source_client text)` | freezes the current version, sets `SENT`, schedules the next step |
| `public.capture_reply(lead_id uuid, exact_text text, outcome text, note text, source_client text, occurred_at timestamptz)` | stores the exact inbound text, records the outcome, pauses the sequence, and creates the DNC suppression when applicable |
| `public.soft_delete_lead(lead_id uuid, actor uuid)` | sets `deleted_at`, state `deleted`, cancels pending steps, audits |
| `public.restore_lead(lead_id uuid, actor uuid)` | clears soft delete with the invariant re-checked |
| `public.permanent_delete_lead(lead_id uuid, actor uuid, confirmation text)` | admin-only, audited, requires literal confirmation string |
| `public.undo_import(batch_id uuid, actor uuid)` | reverts records created exclusively by that batch |
| `public.get_today_queue(user_id uuid, business_id uuid, bucket text, categories text[], at timestamptz)` | the My Day / Companion Today projection |
| `public.publish_sequence_version(version_id uuid, actor uuid)` | transactional publish with impact preview |
| `public.merge_duplicate_candidate(candidate_id uuid, actor uuid, resolution text)` | merge / keep separate / skip |
| `public.assert_business_scope(business_id uuid)` | raises if the actor cannot touch that business |
| `public.assert_identity_usable(identity_id uuid)` | raises if the actor may not use that sender identity |
| `public.enqueue_audit(...)` | internal helper used by triggers |

All of these are `SECURITY DEFINER` with `SET search_path = public, pg_temp`, and
each begins with an explicit authorization assertion. None of them accept SQL text.

## 5. Forbidden

- No function, table or view exposes arbitrary SQL execution. `database.execute_sql`
  is explicitly forbidden by `mcp_contract.forbidden_tool`; a test asserts that no
  `api_clients` scope grants it and that the string `execute_sql` appears nowhere
  in the migration set.
- No service-role key is referenced from any client bundle or extension file; a
  test asserts this.
