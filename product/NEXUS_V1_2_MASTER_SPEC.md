# NEXUS V1.2 — Master Specification (AI-first redesign)

**Status:** FROZEN. This document is normative. An implementation that disagrees with it is wrong, and a
disagreement must be resolved by amending this document, not by bending the code.
**Branch:** `v1.2/ai-first-redesign`. **Base spec:** `product/Nexus_CRM_Master_Spec_v1.json` (V1).
**Migration tail:** `0030`–`0035` (see `docs/V1_2_MIGRATION_PLAN.md`).
**Companion documents:** `docs/V1_2_IMPLEMENTATION_PLAN.md`, `docs/V1_2_MIGRATION_PLAN.md`,
`docs/V1_2_AI_COST_CONTROL.md`, `docs/OPENCODE_AGENT_WORKFLOW.md`, `docs/CHATGPT_MCP_WORKFLOW.md`.

V1.2 keeps the V1 data model, the V1 authorization model and the V1 visual language. It changes *what
the product does with a lead*: enrichment becomes a first-class, durable, asynchronous process; the
intelligence about a lead is presented before the outreach; and two external agents (ChatGPT over MCP,
OpenCode over MCP) are given narrow, typed, auditable ways to contribute work without ever holding a
database credential.

---

# Part A — Foundation

## 1. Purpose and vision

1.1 V1 answered "where is this lead in the outreach sequence". V1.2 answers "what do we know about this
lead, how do we know it, and what is the next piece of work that would make the next message better".

1.2 The vision is an **AI-first lead workspace**: a lead may exist while almost nothing is known about
it; the product then drives a deterministic, observable enrichment process (human paste, deterministic
search links, browser research by OpenCode, DeepSeek extraction) until the lead is *ready*, and only
then does outreach become the primary action.

1.3 Three properties are non-negotiable and are the reason for most of the design below:

- **Durable work.** Research that depends on a live browser cannot be a request-scoped HTTP call. It
  is a queue row with a lease, not a promise held in a request.
- **Raw data is transient; facts and provenance are permanent.** A pasted profile body is staging
  material for one extraction. It is deleted once the structured commit it produced has been verified.
- **No agent gets a database.** ChatGPT and OpenCode speak typed verbs over MCP. There is no SQL tool
  and no connection string, in any environment, for either of them.

1.4 Cost is a product constraint, not an operational afterthought. Deterministic work (search links,
completeness, chaining decisions, dedupe) must never call a model, and every model call must be
cacheable by input hash. `docs/V1_2_AI_COST_CONTROL.md` is part of this specification.

## 2. Scope and non-goals

2.1 **In scope.** Minimal-lead ingestion; the enrichment state machine; `channel_accounts` and
`person_contact_points`; deterministic intelligence completeness; deterministic search links; the
durable agent job queue and its lease/crash semantics; the DeepSeek task pipeline, prompt registry, AI
cache, Context Pack and AI usage ledger; thirteen new MCP tools; the ChatGPT and OpenCode boundaries; the
V1.2 Lead Detail, Leads, Agent Jobs, Overview, Business Setup and Companion surfaces.

2.2 **Out of scope (V1.2).** New outreach channels beyond linkedin/email/instagram/upwork; a webhook
delivery mechanism (`docs/FRONTEND_CONTRACTS.md` §6.1 remains true); arbitrary user-written prompts;
an autonomous agent that sends outreach without a human; and any change to `leads.status` semantics.

2.3 **Not a rewrite.** Nothing in V1.2 removes a table, renames a table or column, rewrites an applied
migration, or changes an existing RLS predicate. See §80 and `docs/V1_2_MIGRATION_PLAN.md`.

## 3. Normative language

3.1 `must` / `must not` are requirements. `should` is a strong default that may be traded with a
recorded reason. `may` is optional.

3.2 Every requirement that can be tested is written so it can become a test name. Where a number or a
vocabulary is given, it is exhaustive.

3.3 `> OPEN:` marks a detail the frozen design does not settle. `> OPEN:` items are collected in §82.
An implementation must not invent a contradiction to fill one; it must either leave the behaviour
unimplemented or resolve the item with the product owner and amend this document.

## 4. Relationship to the V1 specification, the DB contract and the migrations

4.1 The V1 spec remains the source for: `data_model.recommended_tables`, `lead_invariants`,
`lead_lifecycle.states`, `sequence_engine`, `messaging_rules`, `roles_and_permissions`,
`mcp_contract.write_requirements` and `security_and_reliability`. V1.2 adds to it and contradicts none
of it.

4.2 `docs/DB_CONTRACT.md` remains the binding interface between migrations and TypeScript. V1.2 extends
it: every new table listed in Part E–K is `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY`
unless it is server-only by design (`raw_staging`, §33), and every new function that the application
calls is `SECURITY DEFINER` with `SET search_path = public, pg_temp` and an explicit authorization
assertion (DB_CONTRACT §4).

4.3 Reserved names. The migrations use the `nexus_` prefix for server-side functions. V1.2 continues
that convention (`nexus_stage_raw`, `nexus_claim_agent_job`, `nexus_complete_agent_job`, …). A new
server function that does not begin with `nexus_` is a naming defect.

4.4 The MCP tool surface uses the `nexus.` prefix (`nexus.list_agent_jobs`). The RLS scope vocabulary is
`resource:action` (`jobs:claim`). Both are exact strings; neither may be paraphrased in code, tests or
documentation.

## 5. Frozen status, change control and evidence

5.1 This specification is frozen at the level of vocabulary, state sets, weights, tool names, raw data
policy and UI hierarchy. Those may not drift during implementation.

5.2 The following may change during implementation without amending this document: file layout of the
TypeScript modules, index names inside a new table's migration, the internal shape of a Context Pack
body, and any `> OPEN:` item once the product owner answers it.

5.3 Claiming V1.2 is COMPLETE requires the gates in §79 to have been run on a clean checkout, and
requires that persistent agent jobs, raw deletion, AI orchestration, MCP agent access and the
intelligence-first Lead workflow are **real**, not mocked. §79.5 states what "mocked" means.

---

# Part B — Product flow and ingestion

## 6. The core product flow

6.1 The V1.2 flow is exactly this sequence, and the vocabulary in it is exact:

```
DISCOVERY → MINIMAL LEAD → ENRICHMENT → STRUCTURED INTELLIGENCE → QUALIFICATION
          → RESEARCH → AI CONTEXT → OUTREACH → CONVERSATION → LEARNING / NEXT ACTION
```

6.2 The flow is not a wizard a lead is walked through in one sitting. It is a state machine that a lead
occupies over time, across sessions, humans and agents. Every stage must be resumable from the database
alone: no stage may depend on in-memory state from a previous stage.

6.3 A lead may be created at DISCOVERY with almost no data and may sit in MINIMAL LEAD indefinitely
without being an error.

| # | Stage | Entry condition | Exit condition | Primary owner |
| --- | --- | --- | --- | --- |
| 1 | DISCOVERY | a person/company/source is noticed | a lead row exists | human, Companion, MCP client, importer |
| 2 | MINIMAL LEAD | lead exists with partial data | enough is known to attempt enrichment | product (automatic), human |
| 3 | ENRICHMENT | `lead_enrichment.status` is not `READY` | the required facts exist with provenance | human + OpenCode + DeepSeek |
| 4 | STRUCTURED INTELLIGENCE | facts exist | facts are committed as structured rows with provenance | DeepSeek orchestrator |
| 5 | QUALIFICATION | ICPs exist for the business | `ICP_QUALIFICATION` has produced fit/intent | DeepSeek |
| 6 | RESEARCH | company or signals are incomplete | research evidence is committed | OpenCode + DeepSeek |
| 7 | AI CONTEXT | qualification and facts exist | an AI Context Pack version exists | DeepSeek |
| 8 | OUTREACH | a channel account is available and the lead is not blocked | a message is sent on a channel | human (Companion/browser) |
| 9 | CONVERSATION | a reply exists | the reply is captured and classified | human + DeepSeek |
| 10 | LEARNING / NEXT ACTION | an outcome exists | a next action is scheduled or the lead is parked | product + human |

## 7. Stage ownership: human, AI, agent

7.1 Three kinds of actor do work, and each kind has a boundary that must not be crossed:

- **The human** decides what is true when sources conflict (§73), confirms a contact point (§26), and
  sends outreach. Only a human may set `confirmed_by_user`.
- **DeepSeek** converts raw text into schema-validated structured facts and drafts. It never writes a
  canonical row directly; its output is validated (§61) and then committed by server code.
- **OpenCode** reads live web/browser pages and produces raw evidence. It never writes a canonical
  field, never completes a job and never sees a database credential (§41, §58).

7.2 Automatic transitions between stages are performed by server-side code from data already in the
database. No automatic transition may depend on a model call for its *decision* (§60.4).

## 8. The Minimal Lead ingestion contract

8.1 A **Minimal Lead** is a lead whose existence is worth recording even though some identifiers are
missing. Creating one must never require a full profile.

8.2 The Minimal Lead contract applies to every ingress path: the web UI, the Companion
(`POST /api/v1/companion/add`), CSV/XLSX import, paste import, Apollo import and MCP
(`nexus.submit_minimal_lead`).

8.3 Every Minimal Lead insert must, in one transaction:

1. validate and normalise the payload;
2. resolve or create the canonical `people` and `companies` rows through the controlled
   `SECURITY DEFINER` helpers (`nexus_resolve_or_create_person`, `nexus_resolve_or_create_company`);
3. insert the `leads` row inside the business scope;
4. let the `leads_seed_enrichment` trigger create the `lead_enrichment` row (§14.3);
5. record provenance: `source_type`, `source_url` (when known), `observed_at`, `content_hash`;
6. write an `audit_events` row;
7. create the follow-on agent job if the automatic chaining rules say so (§46).

8.4 Minimum acceptable content. At least one of: a person `full_name`, a `linkedin_url`, or a company
name plus a domain. A bare email address is acceptable only as a `person_contact_point`, not as an
identity; `> OPEN:` whether a bare email should be able to create a lead on its own.

8.5 Absent identifiers must remain absent. An ingestion path must not write a placeholder string
(`"unknown"`, `"-"`, `"n/a"`) into `people.full_name`, `companies.name` or `company_id`. A missing
company is a missing company, and the enrichment workspace is where it gets resolved.

8.6 Every Minimal Lead mutation requires an idempotency key (§44.4) and must be safe to replay: two
replays with the same key and the same payload create one lead and return the same `lead_id` with
`idempotent: true`.

## 9. Enforcement of "minimal is legitimate"

9.1 A lead with `lead_enrichment.status = 'MINIMAL'` must render as a normal, actionable lead. It must
not be hidden, filtered out by default, counted as an error, or shaded as broken.

9.2 Every list surface that shows leads must offer an explicit way to see exactly the leads that need
enrichment (§80.2 "Needs Enrichment"), because "minimal is legitimate" only works if the incomplete
leads are findable.

9.3 An enrichment failure must never delete or archive a lead. A `FAILED` enrichment state is a state of
a live lead (`last_error_code` explains it), and the lead's sales state is untouched by it.

## 10. Provenance is not optional

10.1 Every fact that came from outside Nexus must be accompanied by provenance at commit time. The
permanent provenance vocabulary is: source type, source URL, observed timestamp, content hash,
collector agent, agent job id, prompt version id, model, extracted timestamp (§32.3).

10.2 A structured commit that cannot supply provenance must be refused. Losing the provenance of a fact
is worse than losing the fact.

## 11. Discovery and re-discovery

11.1 Rediscovery of an existing person must create a new `source_evidence` row, never overwrite the
existing one (DB_CONTRACT §2 invariant 5). The `(business_id, content_hash)` uniqueness rule is the
mechanism: identical bytes are evidence once, and different bytes are new evidence.

11.2 Ingestion must reuse an existing canonical person by the strongest key available, in this order:
`normalized_linkedin_url` (unique), then email (via `person_contact_points.normalized_value`), then
normalised name plus company. A path that matches on name alone must record the match as weak
provenance and must not overwrite a confirmed field.

---

# Part C — State model

## 12. Sales state versus enrichment state

12.1 These are two independent axes. Conflating them is the single most damaging mistake available in
V1.2.

| Axis | Column | Question it answers | Vocabulary | Owner |
| --- | --- | --- | --- | --- |
| Sales state | `leads.status` | where is this lead in outreach? | `LEAD_STATES` (V1, unchanged, 18 values) | humans and the sequence engine |
| Enrichment state | `lead_enrichment.status` | how complete is our intelligence? | 9 V1.2 states (§14) | enrichment pipeline |

12.2 **A `leads.status` value may never be derived from an enrichment state, and an enrichment state
may never be derived from `leads.status`.** Code that does either must be rejected in review.

12.3 Consequences that must hold:

- A lead may be `leads.status = 'ready'` (sales-ready) with `lead_enrichment.status = 'NEEDS_PROFILE'`.
  The UI must show both, side by side, without implying one contradicts the other.
- A lead may be `lead_enrichment.status = 'READY'` with `leads.status = 'do_not_contact'`. Enrichment
  continues to be visible; outreach remains blocked (V1 `OUTREACH_BLOCKING_LEAD_STATES`).
- Enrichment work must never write `leads.status`. The only permitted exception is an explicit,
  audited human action, and `> OPEN:` whether V1.2 allows even that.

## 13. `leads.status` — the sales state (unchanged)

13.1 `leads.status` keeps exactly the V1 value list and CHECK: `new`, `needs_profile`, `ready`,
`connection_due`, `connection_sent`, `connection_accepted`, `message_due`, `followup_due`, `replied`,
`paused`, `cooldown`, `dormant`, `reactivation_due`, `interested`, `wrong_person`, `do_not_contact`,
`archived`, `deleted` (`packages/core/src/vocabulary.ts` `LEAD_STATES`).

13.2 The `needs_profile` sales state and the `NEEDS_PROFILE` enrichment state are different things that
happen to share a word. The sales state means "the outreach plan is waiting for a profile capture"; the
enrichment state means "the intelligence is below the profile-ready threshold". They may be true at the
same time and they may diverge.

13.3 `leads.needs_profile` (boolean) predates V1.2 and remains. V1.2 uses it in exactly one place: the
`leads_seed_enrichment` trigger reads it to choose the initial enrichment status (§14.3).
`> OPEN:` whether `leads.needs_profile` is deprecated in favour of `lead_enrichment.status` or kept in
sync by dual-write; until that is answered, nothing may remove the column and nothing may assume the
two agree after the initial insert.

## 14. `lead_enrichment.status` — the enrichment state

14.1 The vocabulary is exactly nine values, uppercase, and is a closed set:

| State | Means | Typical next state |
| --- | --- | --- |
| `MINIMAL` | the lead exists; nothing has been attempted yet | `NEEDS_PROFILE` |
| `NEEDS_PROFILE` | the person identifier set is insufficient (no LinkedIn, no title, or no company) | `PROFILE_READY` |
| `PROFILE_READY` | person facts are committed; company research has not been attempted | `COMPANY_RESEARCH_PENDING` or `AI_PROCESSING` |
| `COMPANY_RESEARCH_PENDING` | a company research job is required or queued | `AGENT_RESEARCH_PENDING` |
| `AGENT_RESEARCH_PENDING` | an agent job exists and has not been completed | `AI_PROCESSING` |
| `AI_PROCESSING` | DeepSeek work (extraction, qualification, context) is in flight | `READY` or `NEEDS_REVIEW` |
| `READY` | the required facts, qualification and context exist | `MINIMAL` (if facts are invalidated) |
| `NEEDS_REVIEW` | a conflict needs a human decision (§73) | `READY` or `FAILED` |
| `FAILED` | the last attempt failed and exhausted its retries; `last_error_code` explains it | `MINIMAL` (after a human retry) |

14.2 `lead_enrichment` is 1:1 with `leads` (`lead_id` is the primary key), carries `business_id`, and
holds `completeness_score` (integer 0–100), `missing_fields text[]`, the four timestamps
(`last_profile_enrichment_at`, `last_company_enrichment_at`, `last_context_build_at`) and
`last_error_code`. Profile provenance lives here too: `profile_source_type`, `profile_source_url`,
`profile_observed_at`, `profile_content_hash`, `profile_agent_job_id` — the raw body is gone, the hash
is what proves which bytes produced the current facts.

14.3 A row must exist for **every** lead, whatever created it. This is guaranteed by the
`leads_seed_enrichment` AFTER INSERT trigger, which inserts `NEEDS_PROFILE` when
`leads.needs_profile` is true and `MINIMAL` otherwise, with `on conflict (lead_id) do nothing`. A lead
without an enrichment row must be impossible; a missing row is a defect, not a "0% but nothing to do".

14.4 Every write to `lead_enrichment` must recompute `missing_fields` and `completeness_score` in the
same transaction (§28). A status change that leaves the score stale is a defect.

## 15. Enrichment state transitions

15.1 Permitted transitions. Anything not in this table must be refused by the application layer:

```
MINIMAL                  → NEEDS_PROFILE, PROFILE_READY, AI_PROCESSING, FAILED
NEEDS_PROFILE            → PROFILE_READY, AI_PROCESSING, FAILED, MINIMAL
PROFILE_READY            → COMPANY_RESEARCH_PENDING, AGENT_RESEARCH_PENDING, AI_PROCESSING, READY, FAILED
COMPANY_RESEARCH_PENDING → AGENT_RESEARCH_PENDING, AI_PROCESSING, FAILED, NEEDS_REVIEW
AGENT_RESEARCH_PENDING   → AI_PROCESSING, FAILED, NEEDS_REVIEW, COMPANY_RESEARCH_PENDING
AI_PROCESSING            → READY, NEEDS_REVIEW, FAILED, PROFILE_READY
READY                    → MINIMAL, NEEDS_REVIEW, AI_PROCESSING
NEEDS_REVIEW             → READY, FAILED, AI_PROCESSING, MINIMAL
FAILED                   → MINIMAL, NEEDS_PROFILE, AI_PROCESSING
```

15.2 `READY` must be reachable only when the deterministic completeness score is at or above the
readiness threshold **and** an AI Context Pack version exists for the lead. `> OPEN:` the exact numeric
readiness threshold (the weight table implies a natural candidate; see §28.5).

15.3 A transition to `FAILED` must record `last_error_code`; a transition out of `FAILED` must clear it.
An error code is a stable machine string, never a sentence and never an upstream body.

## 16. Enrichment invariants (must-nots)

16.1 Enrichment must not change `leads.status`, `leads.owner_user_id`, `leads.primary_icp_id` or
`leads.sequence_enrollment_id`.

16.2 Enrichment must not create, pause or cancel a `sequence_enrollment`.

16.3 Enrichment must not send anything. Nothing in the enrichment pipeline may write
`message_instances.state = 'SENT'`, `message_events`, or an `interactions` row of type send.

16.4 Enrichment must not delete a canonical row. Merging two people is a duplicate-resolution decision
(`public.merge_duplicate_candidate`), not an enrichment outcome.

16.5 Enrichment must not retry forever. Every retry loop is bounded by `agent_jobs.max_attempts` for
agent work and by the provider attempt policy for AI work (`DEEPSEEK_MAX_ATTEMPTS`, default 3).

16.6 Enrichment must not run on page render. A read path may display state; it must not start work
(§76).

---

# Part D — Vocabulary

## 17. Where V1.2 vocabulary lives

17.1 Every new V1.2 vocabulary must be declared once in `packages/core/src/vocabulary.ts` and referenced
from the migration CHECK constraint, so the two cannot drift (the convention DB_CONTRACT §0 records).

17.2 Postgres `text` + `CHECK (col = ANY (ARRAY[...]))` remains the mechanism. No native `enum` types.

17.3 The migration CHECK constraint is the authority at rest; the TypeScript constant is the authority
in code. A value added to one without the other is a defect.

## 18. Discovery sources

18.1 A **discovery source** is how we came to know the lead exists. The vocabulary is exactly:

```
linkedin, upwork, reddit, job_board, youtube, instagram, company_website, google, web,
apollo, csv, paste, mcp, companion, manual, other
```

18.2 A discovery source answers "where did this lead come from". It is recorded once, at ingestion, and
is history: it must not be rewritten because the lead's channel usage later changes.

18.3 `> OPEN:` how the V1.2 discovery-source vocabulary is persisted. The V1 lead source vocabulary
(`LEAD_SOURCE_TYPES`: `manual_add`, `manual_companion`, `file_csv`, `file_xlsx`, `paste_list`,
`google_search`, `apollo_basic`, `external_ingest`, `mcp_agent`, `research_agent`) is already the CHECK
on `leads.source_type`, and migrations `0030`–`0035` do not add a column for the V1.2 list. The choice is
between (a) widening `leads.source_type`'s CHECK to a superset with a documented mapping for existing
rows (`manual_add`→`manual`, `manual_companion`→`companion`, `file_csv`/`file_xlsx`→`csv`,
`paste_list`→`paste`, `google_search`→`google`, `apollo_basic`→`apollo`, `mcp_agent`→`mcp`,
`research_agent`→`web`), (b) a new `lead_discovery_source` column, or (c) a lookup table. Whichever is
chosen must be additive and must not invalidate a stored value. `packages/core/src/vocabulary.ts` already carries the projection: `DISCOVERY_SOURCES`, `LEGACY_SOURCE_TO_DISCOVERY`, `discoverySourceFromLegacy` and `normalizeDiscoverySource`, so a value that is already a discovery source normalises unchanged and a V1.1 value maps deterministically. Only the storage decision remains open.

## 19. Outreach channels

19.1 An **outreach channel** is how we contact the lead. The vocabulary is exactly four values plus a
fallback, lowercase:

```
linkedin, email, instagram, upwork, other
```

19.2 The channel vocabulary is the CHECK on `outreach_identities.channel` (migration `0030`) and is the
set of values the product schedules outreach on.

19.3 `outreach_identities.platform` — the V1 column — is retained for historical attribution and its
CHECK is **widened, never narrowed**, to
`linkedin, email, instagram, upwork, twitter, other`. A stored `twitter` value keeps validating and is
mapped to `channel = 'other'` because V1.2 does not schedule Twitter outreach. Removing `twitter` from
the platform vocabulary would invalidate live rows and is forbidden.

## 20. Sources and channels are independent

20.1 **A discovery source never dictates an outreach channel, and an outreach channel never implies a
discovery source.** They are separate columns, separate vocabularies, and separate UI concepts.

20.2 Worked examples, which are acceptance tests:

| Lead discovered on | May be contacted on | Why |
| --- | --- | --- |
| reddit | email | the Reddit post exposed a person and an address; the channel is email |
| linkedin | upwork | the LinkedIn profile names a freelancer who has an Upwork account |
| youtube | linkedin | the channel is a property of the account we hold, not of the source |
| csv | instagram | an import may carry an Instagram handle |
| job_board | linkedin, email | either account may be the right one |

20.3 The available channels for a lead are computed from the accounts and contact points that exist —
`person_contact_points` and the business's active `channel_accounts` — and never from `source_type`.

20.4 The UI must not label a channel button with a source name, must not filter a channel list by
source, and must not phrase an error as "this lead was discovered on X, so Y is unavailable".

## 21. Agent job types, statuses and AI task types

21.1 **Agent job types** (`agent_jobs.job_type`, exact):

```
RESEARCH_COMPANY, RESEARCH_PERSON, RESEARCH_SIGNALS, CAPTURE_PROFILE, ENRICH_PROFILE,
QUALIFY_LEAD, BUILD_CONTEXT, DRAFT_OUTREACH, OTHER
```

21.2 **Agent job statuses** (`agent_jobs.status`, exact):

```
OPEN, RUNNING, WAITING_AI, COMPLETE, FAILED, CANCELLED
```

`DONE TODAY` is a UI bucket (COMPLETE with `completed_at` today), not a status value.

21.3 **AI task types** (`ai_runs.task`, exact — seven, server-side only):

```
PROFILE_EXTRACTION, COMPANY_EXTRACTION, SIGNAL_EXTRACTION, ICP_QUALIFICATION,
CONTEXT_BUILD, MESSAGE_DRAFT, REPLY_CLASSIFICATION
```

21.4 **Prompt keys** (`prompt_versions.key`, exact — twelve):

```
profile_extract, company_extract, signal_extract, icp_qualify, context_build,
linkedin_initial, linkedin_followup, email_initial, email_followup,
instagram_dm, upwork_proposal, reply_classify
```

21.5 A new task type or prompt key is a vocabulary change and therefore a spec amendment, not an
implementation detail.

## 22. Required capabilities

22.1 `agent_jobs.required_capabilities` is a `text[]` and uses the `must include all of` semantics
(`required_capabilities <@ agent_capabilities`) implemented by `nexus_claim_agent_job`. `> OPEN:` the
capability name vocabulary — the migration stores the comparison but the frozen design does not name the
values. A candidate list to be ratified: `browser.research`, `web.fetch`, `linkedin.profile`,
`company.site`, `job_board.read`, `social.read`.

---

# Part E — Accounts and contacts

## 23. Channel accounts

23.1 V1.2's product-facing name for an `outreach_identities` row is a **channel account**: one account
on one channel through which a business sends outreach.

23.2 `public.channel_accounts` is a `security_invoker` view over `outreach_identities` (migration
`0030`). It must stay `security_invoker`; a `security_definer` view here would become a way around the
table's RLS policies and is forbidden.

23.3 A channel account must expose: `id`, `channel`, `platform` (legacy, display only), `display_name`,
`profile_url`, `normalized_profile_url`, `managed_by_user_id`, `status`, `daily_target`,
`daily_sent_count`, `notes`, timestamps and `deleted_at`.

23.4 Account status semantics are unchanged from V1: `active`, `paused`, `retired`. A retired account
must not be offered as a sending account and must not be resurrected (V1 identity lifecycle, archive is
terminal).

23.5 `> OPEN:` whether one account per `(channel, display_name)` is enforced by a unique constraint. The
`0030` view comment states the rule but the migration enforces no uniqueness on it; adding one later
would be additive but must not fail on existing data.

## 24. Account selection, binding and historical attribution

24.1 The selected account is per (business, channel) for the acting user. Changing the account must
recalculate what the user may do; the server, not the client, is authoritative for the recalculation.

24.2 Historical sender attribution must survive the V1.2 rename. Every existing foreign key to
`outreach_identities`, every `message_events.outreach_identity_id`, every `browser_sessions` row and
every `identity_transfers` row keeps pointing at the same row. V1.2 renames nothing.

24.3 A stored `platform` value must be preserved verbatim for reporting even when `channel` differs
(the `twitter` → `other` case is the only expected divergence).

24.4 The Companion's current LinkedIn binding semantics are preserved: the bound identity is the sending
account, the binding is subject to the concurrency rules in `packages/core/src/permissions.ts`, and the
account the user may bind must satisfy both account access and business access (§78).

## 25. Person contact points

25.1 A person's reachable addresses and handles live in `person_contact_points`, **not** in new columns
on `people`. `people.primary_email` remains as a V1 legacy display field and must not be treated as the
authoritative address set.

25.2 `person_contact_points` carries: `id`, `person_id`, `kind`
(`email|linkedin|instagram|upwork|phone|website|other`), `value` (as observed), `normalized_value`
(uniqueness key), `label`, `is_primary`, `confidence` (0–1), `source`, `source_url`, `observed_at`,
`confirmed_by_user`, `agent_job_id`, `created_by`, `created_at`, `updated_at`, `deleted_at`.

25.3 Uniqueness is `unique (person_id, kind, normalized_value)`; normalisation is lower-cased email,
canonicalised profile URL, digits-only phone. `Sarah@Acme.com` and `sarah@acme.com` are one contact
point with the original `value` preserved for display.

25.4 At most one primary per `(person_id, kind)` — enforced by a partial unique index. "The primary
email" must not depend on row order.

25.5 `> OPEN:` the frozen column list for `person_contact_points` names a `provenance` column;
migration `0030` instead implements `agent_job_id` + `created_by` + `source` + `source_url` +
`observed_at`. Whether an additional `provenance jsonb` is still required, or whether the existing
columns are the provenance, must be ratified before code depends on the name.

## 26. Contact precedence and confirmation

26.1 `confirmed_by_user = true` means a human asserted this value in the product. AI extraction must
never set it. Only a user action may set it, and the action must be audited.

26.2 Contact-point resolution when two rows contend for the same `(person, kind)`:

1. a user-confirmed row wins over everything;
2. otherwise the higher `confidence` wins;
3. otherwise the more recently `observed_at` wins;
4. a tie is a conflict and the person's enrichment state becomes `NEEDS_REVIEW` (§73).

26.3 Removing primary status from a confirmed row requires a user action. No process may silently
demote a confirmed contact point.

26.4 Presentation must distinguish "confirmed", "extracted" and "imported". The UI must not present an
extracted address as if a human had confirmed it.

---

# Part F — Intelligence

## 27. Intelligence completeness

27.1 Completeness is a **deterministic weighted score out of 100**. It must never be produced by a model
and must never be estimated by one.

27.2 The score is stored as `lead_enrichment.completeness_score` (integer 0–100) and the missing
components are stored as `lead_enrichment.missing_fields text[]`. Both are recomputed in the same
transaction as any fact change.

27.3 The score is a function of stored facts only. It must be reproducible: the same rows must produce
the same number, in any process, on any day, without network access.

## 28. The completeness weight table

28.1 Exact weights, total 100. A component is awarded in full or not at all:

| # | Component | Weight | Awarded when |
| --- | --- | --- | --- |
| 1 | name | 12 | `people.full_name` is present and non-placeholder |
| 2 | company | 12 | the lead resolves to a `companies` row |
| 3 | location | 6 | `people.location` is present |
| 4 | job_title | 10 | `people.job_title` (or `headline` fallback) is present |
| 5 | linkedin | 14 | a LinkedIn URL or handle exists on the person and is normalised |
| 6 | company website | 8 | the company has `primary_domain` or `normalized_domain` |
| 7 | company research | 12 | a committed company research result exists with provenance |
| 8 | signals | 8 | at least one active `signals` row is attached to the lead/person/company |
| 9 | AI context | 10 | an `ai_context_packs` version exists for the lead |
| 10 | contacts | 8 | at least one usable `person_contact_points` row exists |

Sum: 12 + 12 + 6 + 10 + 14 + 8 + 12 + 8 + 10 + 8 = **100**.

28.2 Component names in `missing_fields` must be stable machine keys matching the table above
(`name`, `company`, `location`, `job_title`, `linkedin`, `company_website`, `company_research`, `signals`,
`ai_context`, `contacts`) so the UI can render a label and the operator can filter on them.

28.3 `missing_fields` must be exhaustive: every unawarded component is listed, in the table's order.

28.4 A component must not be awarded from an uncommitted or failed attempt. A staged raw body, an
in-flight job and a cached-but-unapplied extraction award nothing.

28.5 `> OPEN:` the readiness threshold that permits `lead_enrichment.status = 'READY'`. The table
implies a natural candidate (all of `linkedin`, `company`, `company_research`, `ai_context` present);
the exact number must be ratified before `READY` is asserted by code.

28.6 `> OPEN:` whether the `contacts` component requires a *confirmed* contact point, a contact point on
a channel the business can actually send on, or any non-deleted contact point. The strictest of the
three is recommended, because a contact point we cannot use is not reachability.

## 29. Display and recomputation

29.1 The product displays the score as a percentage with the missing pieces named, for example
`Lead intelligence 35%` plus `missing: linkedin, company research, signals, AI context, contacts`.

29.2 A score must never be rendered without its `missing_fields` when the score is below 100. A bare
number is a defect: it tells the operator nothing actionable.

29.3 Recompute triggers. The score must be recomputed after: a person fact change, a company fact change,
a contact-point insert/update/delete, a committed company research result, a signal insert/expire, a
Context Pack insert, and an enrichment state change that follows any of those.

29.4 The score is *not* a gate on sending outreach in V1.2 unless the business turns that on.
`> OPEN:` whether a business-level setting may require a minimum score before a message can be marked
sent.

---

# Part G — Deterministic search links

## 30. Zero-token deterministic search links

30.1 Nexus generates search links **deterministically**, in code, from stored facts. A model must never
be asked to compose a search query, and a search link must never cost a token.

30.2 Exactly these four shapes exist. The quoted terms are the person's full name, the company name and
the person's location:

| UI action | Shape |
| --- | --- |
| Find LinkedIn (`find_linkedin`) | `"Sarah Miller" "Acme Media" site:linkedin.com/in` |
| Search Person (`search_person`) | `"Sarah Miller" "Acme Media" "New York"` |
| Search Company (`search_company`) | `"Acme Media" company` |
| Search Signals (`search_signals`) | `"Acme Media" hiring OR expansion OR video OR podcast` |

30.3 Construction rules, all mandatory:

1. Every substituted value is wrapped in double quotes.
2. The link is built with URL encoding (`URLSearchParams` / equivalent), never by string concatenation.
3. A term that is absent is omitted with its quotes and its separating space; the link must never
   contain `""`, `undefined`, `null` or a placeholder.
4. `Find LinkedIn` and `Search Person` require the person name; `Search Person` additionally requires
   either the company or the location. When the precondition is unmet the action must be disabled with
   the missing field named, not rendered as a link.
5. `Search Company` requires the company name. `Search Signals` requires the company name.
6. The generic search engine is Google, and the base URL is configured in one place.
7. The link must open in a new tab with `rel="noopener noreferrer"`.

30.4 The generated link's text must be visible and copyable. An operator must be able to run the same
search outside the browser.

30.5 These links must appear wherever the corresponding facts appear: the Leads table row actions
(§68.3), the Lead Detail header and enrichment workspace (§69.1, §69.5) and the Companion.

30.6 The link set must not grow "AI-suggested queries". A fifth shape is a spec amendment.

---

# Part H — Enrichment work and raw data

## 31. The human-assisted enrichment workflow

31.1 The workflow, step by step. Steps 1–3 are deterministic; step 6 is the only AI step; steps 4–8 are
the enrichment workspace's supported sequence.

1. **Enter the workspace.** The operator opens the lead's ENRICHMENT WORKSPACE (§69.5).
2. **Find LinkedIn.** Nexus renders the `Find LinkedIn` link (§30.2). If the person name is missing, the
   action is disabled and says so.
3. **Search Person / Search Company / Search Signals.** Nexus renders the remaining generated links. The
   operator opens them, reads the results, and comes back with either a URL or the page text.
4. **Supply a URL.** The operator pastes a LinkedIn (or other) profile URL into the URL input. Nexus
   validates the shape, normalises it, and records it as a `person_contact_points` row with
   `confirmed_by_user = false` and `source = 'manual'` — a URL is a location, not a fact set.
5. **Supply raw text.** The operator pastes the profile body into the temporary raw paste textarea. The
   text is posted to the API and staged in `raw_staging` with `kind = 'profile_paste'`, a `content_hash`
   and a 24h `expires_at`. It is never written to a canonical field and never displayed again (§32.6).
6. **Enrich with AI.** The server runs `PROFILE_EXTRACTION` over the staged text via DeepSeek, validates
   the result against the strict schema, drops ungrounded facts (§64), and then commits: canonical
   facts, contact points, signals, provenance, the `source_evidence` metadata row. Only after the commit
   is verified is the staged raw row deleted. On success the enrichment state advances and the
   completeness score is recomputed.
7. **Research Company.** If the company is incomplete, Nexus creates (or reuses) a `RESEARCH_COMPANY`
   agent job (§42.5). The job waits durably for an agent. Its result returns through
   `nexus.submit_agent_job_result` → `WAITING_AI` → `COMPANY_EXTRACTION` → commit → raw deletion →
   COMPLETE.
8. **Watch, don't wait.** The workspace shows the processing steps as states, never as a blocking
   spinner: source captured → person resolved → company resolved → profile extraction → company research
   pending → qualification pending → ready (§67). The operator may leave and come back.
9. **Human decision on conflict.** If the extraction conflicts with a user-confirmed value, the state
   becomes `NEEDS_REVIEW` and the workspace offers the specific decision (§66.4).
10. **Readiness.** When the score and the Context Pack satisfy §28.5, the lead becomes `READY` and
    outreach becomes the primary action.

31.2 The workspace must be usable with no AI key configured. With `DEEPSEEK_API_KEY` unset,
`Enrich with AI` reports `provider_not_configured` (a supported state, not an error), the URL and paste
paths still work, and manual editing of the facts remains available.

31.3 The operator must never be required to paste raw text twice. A staged row that is still inside its
TTL is reusable: `nexus_read_raw_staging` marks the attempt and returns the payload; a retry does not ask
the operator to re-paste while the row lives.

## 32. Raw data policy (hard requirement)

32.1 **Raw pasted and scraped bodies are staged in `raw_staging` only for async/retry safety.** The
canonical order of operations is fixed:

```
receive raw → DeepSeek extract → validate → commit structured facts → commit provenance
            → verify commit → delete raw → advance state / complete job
```

32.2 Consequences, each of which is a test:

1. Raw must never enter `audit_events`, an application log, an error message, or a job event note.
2. Raw must never land in a canonical Lead, Person or Company field.
3. Raw must never remain as a permanent `source_evidence` body. `source_evidence.raw_text_or_json`
   must not be populated by a V1.2 path; `> OPEN:` what happens to the bodies already stored by V1
   (recommended: grandfather them, purge nothing, and stop new writes) and whether the column is
   eventually emptied for V1.2 ingestions only.
4. Raw must be deleted as soon as the structured commit for it is verified, not later.
5. While a failure is retryable, raw remains **temporarily**. Abandoned raw is removed by the 24h TTL
   (§34).
6. The product must never re-display discarded raw. The enrichment workspace shows the *structured*
   result and the provenance metadata; a "show me what I pasted" affordance must not exist.

32.3 Permanent metadata **may** remain, and this is the complete allow-list: source type, source URL,
observed timestamp, content hash, collector agent, agent job id, prompt version, model, extracted
timestamp. These are the `source_evidence` V1.2 columns (`raw_content_hash`, `raw_bytes`,
`raw_deleted_at`, `collector_agent`, `agent_job_id`, `prompt_version_id`, `model`, `extracted_at`).

32.4 `raw_staging` rows are ephemeral by construction: `expires_at` defaults to `now() + 24 hours`,
`consumed_at` records consumption, and the TTL sweep (`nexus_cleanup_raw_staging`) deletes rows past
expiry that were never consumed.

32.5 Raw staging must not be reachable from a read path, an export, a report or an MCP read tool. There
is no MCP tool that returns a raw body (§43.3).

32.6 The paste textarea is temporary by design. After a successful extraction the UI must show the
committed facts and the content hash, never the body.

## 33. Raw staging access control

33.1 `raw_staging` is `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY`, with exactly one
policy, `raw_staging_writer_only`, whose `USING` and `WITH CHECK` are
`pg_has_role(current_user, 'nexus_raw_writer', 'member')`.

33.2 `nexus_raw_writer` is a `NOLOGIN NOINHERIT NOBYPASSRLS` role. It is granted to the migration owner
only. It deliberately has no `BYPASSRLS`: it satisfies the policy rather than escaping it.

33.3 `revoke all on public.raw_staging from public, anon, authenticated`. A repository that selects from
`raw_staging` as a tenant fails closed.

33.4 All access is through `SECURITY DEFINER` functions owned by the migration role:
`nexus_can_touch_raw`, `nexus_stage_raw`, `nexus_read_raw_staging`, `nexus_delete_raw_staging`,
`nexus_mark_raw_failed`, `nexus_cleanup_raw_staging`. Each asserts a business capability before touching
a row, and a refusal raises `42501`.

33.5 `nexus_can_touch_raw(business_id)` authorises: an admin, or a user with business access and
`can_use_lead_sources`, or an API client holding `lead_sources:write` or `jobs:submit`. A caller that is
not authorised must get the **same** answer for "row does not exist" and "row is not yours"
(`nexus_read_raw_staging` returns no rows in both cases), because distinguishing them leaks tenancy
information.

33.6 The payload ceiling is 400 000 characters per staged row. A larger body must be refused with
`22023`, not truncated.

33.7 `nexus_mark_raw_failed` stores the error **code** only, truncated to 120 characters. An upstream
message can quote the payload, and this table's whole purpose is that the payload does not persist.

## 34. Retention, TTL and cleanup

34.1 Default lifetime is 24 hours, stored per row in `expires_at` so a retry can shorten it and an
operator can see when it dies.

34.2 `nexus_cleanup_raw_staging(p_limit default 200)` deletes rows where `expires_at < now()` and
`consumed_at is null`, oldest first. It is called by the V1.2 AI processor on every run, so an abandoned
row lives at most one processor interval past expiry.

34.3 Cleanup must be idempotent and must never fail the processor: a cleanup error is logged as an error
code, not raised into the job path.

34.4 Deletion is hard deletion. There is no soft-delete and no archive of raw bodies, by design.

34.5 A staging row's `payload` must never be copied into `agent_job_events.payload`,
`audit_events.before_json/after_json`, `ai_runs`, or a `research_snapshots.findings` blob. If a research
finding needs raw proof, it is re-fetched or it is not a finding.

---

# Part I — The durable agent job queue

## 35. Why the queue exists

35.1 A job is **durable**: it stays in Nexus while OpenCode is offline. Restarting a browser, closing a
laptop, or a deploy must not lose queued research work.

35.2 The queue is the only mechanism by which browser research is requested. A request-scoped
"please research this now" call must not exist: it cannot survive a crash and it makes the job
invisible.

35.3 The canonical loop:

```
Nexus creates job (OPEN)
   → OpenCode lists open jobs through MCP
   → OpenCode claims one atomically (RUNNING + lease)
   → OpenCode heartbeats while it works
   → OpenCode researches the live page
   → OpenCode submits evidence (raw staged, job WAITING_AI)
   → DeepSeek extracts → server validates → structured commit → provenance commit
   → commit verified → raw deleted → COMPLETE
```

## 36. `agent_jobs` — full field list

36.1 `agent_jobs` columns, exactly as migration `0032` creates them:

| Column | Type / values | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `business_id` | uuid not null → `businesses` | the tenant boundary |
| `lead_id` | uuid → `leads` on delete cascade | nullable: a research job may target a company only |
| `person_id` | uuid → `people` on delete set null | |
| `company_id` | uuid → `companies` on delete set null | |
| `job_type` | text, 9 values (§21.1) | |
| `priority` | `low\|normal\|high\|urgent`, default `normal` | drives claim ordering |
| `status` | 6 values (§21.2), default `OPEN` | |
| `instructions` | text | operator- or rule-written brief; never raw evidence |
| `required_capabilities` | text[] default `{}` | claim requires `required_capabilities <@ agent_capabilities` |
| `created_by_type` | `user\|api_client\|system\|agent`, default `system` | |
| `created_by_id` | uuid | |
| `claimed_by_agent` | text | the agent name, not a credential |
| `claimed_at` | timestamptz | |
| `lease_expires_at` | timestamptz | null when not RUNNING |
| `last_heartbeat_at` | timestamptz | |
| `attempt_count` | integer ≥ 0, default 0 | incremented by claim |
| `max_attempts` | integer 1–20, default 3 | |
| `last_error_code` | text | stable machine string |
| `dedupe_key` | text | the stable key for automatic chaining (§47) |
| `reason` | text | why the job exists, in operator words |
| `result_ai_run_id` | uuid | the `ai_runs` row that produced the commit |
| `created_at`, `updated_at`, `completed_at` | timestamptz | |

36.2 Uniqueness: one **active** job per `(business_id, dedupe_key)` — a partial unique index over
`status in ('OPEN','RUNNING','WAITING_AI')`. A `COMPLETE`, `FAILED` or `CANCELLED` row keeps its key so
re-creating the job later is a new row and the history is intact.

36.3 Indexes: the claimable ordering index `(business_id, priority_rank, created_at)` over `OPEN`/`RUNNING`;
`(business_id, status, updated_at desc)`; `(lead_id, created_at desc)`; `(lease_expires_at)` over
`RUNNING`.

36.4 RLS: `ENABLE` + `FORCE`, with a **read policy only** (`has_business_access(business_id)`).
`authenticated` is granted `select` and has `insert`, `update`, `delete`, `truncate` revoked. Every
mutation goes through a function, because an UPDATE policy broad enough to let the UI cancel a job would
also be broad enough to let a caller set `COMPLETE`.

## 37. `agent_job_events` — append-only history

37.1 Columns: `id`, `job_id` (cascade), `business_id` (cascade), `event_type`, `actor_type`
(`user|api_client|system|agent`), `actor_id`, `agent_name`, `note`, `payload jsonb default '{}'`,
`created_at`.

37.2 `event_type` is exactly: `created`, `claimed`, `heartbeat`, `released`, `failed`,
`result_submitted`, `ai_started`, `completed`, `cancelled`, `lease_expired`, `retry_scheduled`.

37.3 Append-only. No update and no delete path exists for any actor; `authenticated` gets `select` only.

37.4 `note` is short operator text (500 characters where the functions write it). Raw evidence must never
be written here (§32.2.1).

## 38. Claim and lease semantics

38.1 `nexus_claim_agent_job(business_id, agent, capabilities, job_id?, lease_seconds default 900)` is
the only way a job becomes `RUNNING`. It must be atomic and singular:

- candidate selection is `for update skip locked` (a racing loser skips the locked row and takes the
  next one rather than blocking);
- a candidate is `OPEN`, or `RUNNING` with `lease_expires_at < now()` (§40 crash recovery);
- `attempt_count < max_attempts`;
- `required_capabilities <@ capabilities`;
- ordering is priority (`urgent` → `high` → `normal` → `low`) then `created_at`.

38.2 The claim sets `status='RUNNING'`, `claimed_by_agent`, `claimed_at`, `last_heartbeat_at`,
`lease_expires_at = now() + lease`, `attempt_count = attempt_count + 1`, clears `last_error_code`, and
appends a `claimed` event.

38.3 `lease_seconds` is clamped to **30…7200**; a caller cannot request an unbounded lease or a
zero-second one.

38.4 A claim must return the job's identity, type, priority, instructions, required capabilities, entity
ids, attempt count and lease expiry — everything the agent needs to work without a second read.

38.5 A claim with no claimable job returns no rows. That is not an error.

## 39. Heartbeat

39.1 `nexus_heartbeat_agent_job(job_id, agent, lease_seconds default 900)` pushes
`lease_expires_at = now() + lease`, sets `last_heartbeat_at`, appends a `heartbeat` event, and returns
status, lease expiry and attempt count.

39.2 A heartbeat must be refused with `55006` when the job is not `RUNNING` or is held by another agent.
It must be distinguishable from "unknown job" (`P0002`), because an agent whose lease was reaped must
learn that the job moved on, not that it never existed.

39.3 An agent must heartbeat at most every `lease/3` and must treat a heartbeat refusal as
"stop working on this job" (see `docs/OPENCODE_AGENT_WORKFLOW.md`).

## 40. Release, failure, reaping and crash recovery

40.1 **Release** (`nexus_release_agent_job`) returns the job to `OPEN`, clears the claim and lease, and
appends a `released` event. The attempt that was consumed by the claim is **not** refunded, so a job that
keeps failing cannot be released forever.

40.2 **Fail** (`nexus_fail_agent_job(job_id, agent, error_code, message?, retryable?)`) sets `OPEN` when
the failure is retryable and attempts remain, otherwise `FAILED`. It records `last_error_code`
(truncated to 120 characters) and appends `retry_scheduled` or `failed`. A non-retryable failure is
terminal immediately: retrying a malformed request forever is worse than showing an operator a failed
job.

40.3 **Cancel** (`nexus_cancel_agent_job`) sets `CANCELLED`, clears the claim, and appends `cancelled`.
A `COMPLETE` job must not be cancellable (`55006`).

40.4 **Expired-lease reaping** (`nexus_reap_expired_job_leases(p_limit default 50)`) moves every
`RUNNING` job whose `lease_expires_at < now()` back to `OPEN`, or to `FAILED` with
`last_error_code = 'lease_expired_no_attempts'` when `attempt_count >= max_attempts`, appending a
`lease_expired` event either way. **Jobs must never be left permanently `RUNNING`.**

40.5 Crash recovery is therefore two-layered: an expired lease makes a `RUNNING` job claimable again
*and* the reaper returns it to `OPEN` for visibility. A reaped agent that later heartbeats is refused
and must stop.

40.6 The reaper runs on a schedule in the server process (a managed background job, not a request) and
is idempotent under concurrency.

## 41. Submit-result, extraction and completion

41.1 `nexus_submit_agent_job_result(job_id, agent, payload, content_hash, kind, source_type,
source_url?)`:

1. refuses unless the job is `RUNNING` and held by the caller (`55006`);
2. stages the payload via `nexus_stage_raw` (business, entities, job id, kind, source, hash, agent);
3. moves the job to `WAITING_AI` and clears the lease;
4. appends `result_submitted` with `raw_staging_id`, `content_hash` and `kind` in `payload`;
5. returns `(job_id, status, raw_staging_id)`.

41.2 **It must be impossible for this function to reach `COMPLETE`.** The transition does not exist in
its scope.

41.3 `nexus_complete_agent_job(job_id, ai_run_id?)` is the only path to `COMPLETE`. It must:

1. require status `WAITING_AI` (`55006`);
2. count `raw_staging` rows for the job with `consumed_at is null` and raise `55006` if any remain —
   *evidence that still exists has not been committed*;
3. set `COMPLETE`, `completed_at`, `result_ai_run_id`, clear the claim and lease;
4. append `completed`.

41.4 Because `nexus_submit_agent_job_result` writes RLS-invisible rows, it is only callable by a
`SECURITY DEFINER` function owned by the migration role (`nexus_raw_writer` member).

41.5 **OpenCode never completes a job.** Submitting research stages actionable evidence and sets
`WAITING_AI`. Only after DeepSeek extraction, schema validation, the structured commit, the provenance
commit, the commit verification and the raw deletion does the job become `COMPLETE`. This is enforced by
the database (§41.3), not by agent discipline.

## 42. Automatic chaining and job deduplication

42.1 The canonical automatic chain:

```
minimal lead
  → NEEDS_PROFILE
  → human enrichment
  → profile extracted
  → company incomplete
  → RESEARCH_COMPANY job created
  → OpenCode research
  → DeepSeek extraction
  → qualification / context
  → READY
```

42.2 Every automatic transition runs server-side from stored facts (no model call for the decision) and
must be idempotent: running the chain twice must not create a second job or a second signal.

42.3 **Automatic jobs are deduplicated by a stable key and must record their reason.** The key is
`agent_jobs.dedupe_key`, written on creation, and `agent_jobs.reason` must contain an operator-readable
sentence. A chained job must be distinguishable from a hand-made one in the queue.

42.4 Recommended key shapes (the key must be deterministic from the entity, never from a timestamp or a
random value):

| Job | Key shape |
| --- | --- |
| company research | `RESEARCH_COMPANY:<company_id>` |
| person research | `RESEARCH_PERSON:<person_id>` |
| signal research | `RESEARCH_SIGNALS:<lead_id>` |
| profile capture | `CAPTURE_PROFILE:<lead_id>` |
| context build | `BUILD_CONTEXT:<lead_id>` |
| qualification | `QUALIFY_LEAD:<lead_id>` |

42.5 `nexus_create_agent_job` must return `(job_id, created boolean)`. On a dedupe conflict it returns
the existing live job with `created = false` and creates nothing. Without a key there is no conflict to
detect.

42.6 A chained job must not be created when the work is already satisfied: company research must not be
chained when committed company research exists, and context build must not be chained when a Context
Pack matches the current input hash (§68.5).

42.7 Chaining must be bounded: at most one live job per `dedupe_key`, and the chain must not create a
`RESEARCH_*` job whose `attempt_count >= max_attempts` would immediately fail. Reaping must not
resurrect a job into a permanent loop (§47.4).

---

# Part J — The MCP agent surface

## 43. The new MCP tools

43.1 The V1.2 MCP surface adds the tools below to the V1 catalogue. The frozen design named twelve;
`nexus.create_agent_job` is the thirteenth and is required by the create-a-research-job flow that both the
Agent Jobs screen and ChatGPT need (§71.4 and `docs/CHATGPT_MCP_WORKFLOW.md`), so the surface is thirteen,
not twelve. The scope column is normative: it is the same vocabulary the RLS-side capability helper checks
for the corresponding operation, which is how V1.2 avoids repeating MCP baseline finding F-9.

| Tool | Purpose | Scope | Mutating |
| --- | --- | --- | --- |
| `nexus.create_agent_job` | enqueue a research job, deduplicated by key | `jobs:create` | yes |
| `nexus.list_agent_jobs` | list jobs in scope, filtered by status/type/priority/lead | `jobs:read` | no |
| `nexus.get_agent_job` | read one job with its events and instructions | `jobs:read` | no |
| `nexus.claim_agent_job` | atomically claim a job and receive a lease | `jobs:claim` | yes |
| `nexus.heartbeat_agent_job` | extend a lease | `jobs:claim` | yes |
| `nexus.release_agent_job` | return a job to the queue without failing it | `jobs:claim` | yes |
| `nexus.submit_agent_job_result` | stage evidence and move the job to `WAITING_AI` | `jobs:submit` | yes |
| `nexus.fail_agent_job` | report a classified failure | `jobs:submit` | yes |
| `nexus.get_lead_enrichment_context` | read the structured enrichment context for a lead | `lead:read` | no |
| `nexus.submit_minimal_lead` | create a lead from minimal data | `lead:create` | yes |
| `nexus.submit_profile_data` | submit a profile URL and/or pasted profile body | `profile:capture` | yes |
| `nexus.submit_company_research` | submit company research evidence for a lead | `jobs:submit` | yes |
| `nexus.submit_source_metadata` | record permanent source metadata without a raw body | `evidence:add` | yes |

43.2 The tool names are exact and must appear exactly once in `MCP_TOOLS`
(`packages/core/src/contracts.ts`), in `MCP_TOOL_SCHEMAS` and `MCP_TOOLS_REQUIRING_IDEMPOTENCY`
(`apps/web/src/app/api/v1/mcp/tool-schemas.ts`), and in the dispatch table
(`apps/web/src/app/api/v1/mcp/route.ts`). The exhaustive `Record<McpToolName, …>` types make a missing
entry a compile error, which is the point.

43.3 `nexus.list_agent_jobs` and `nexus.get_agent_job` must never return a raw body, `raw_staging`
contents, or an upstream error message. They return job metadata, entity ids, and short event notes.

43.4 `nexus.get_lead_enrichment_context` returns the *structured* enrichment context: person and company
facts, contact points, signals, ICP fit, the Context Pack version and its summary, and the
`missing_fields` list. It must not return a stored raw body (there are none) and must not trigger any
work.

43.5 `nexus.submit_source_metadata` exists so a collector can record permanent metadata (source type,
URL, observed time, content hash, collector agent) without staging a body at all. It must reject a
payload field.

43.6 The tool→scope mapping is settled and is the table in §43.1. The new job tools use the **same**
`jobs:*` vocabulary that the RLS-side capability helpers in migrations `0032` and `0034` check
(`jobs:create`, `jobs:claim`, `jobs:submit`, `jobs:read`), and the submission tools reuse the existing V1
scopes for the capability they exercise (`lead:create`, `lead:read`, `profile:capture`, `evidence:add`).
That is deliberate: field finding **F-9** in `docs/MCP_BASELINE_VERIFICATION.md` records that the V1 MCP
tool-scope vocabulary and the RLS scope vocabulary were disjoint, so a token granted exactly the scopes
the tool catalogue named was still refused by the database. A V1.2 tool must **not** introduce a scope
that no RLS helper checks, and a new scope must be added to both sides in the same change.

## 44. Mutation requirements

44.1 Every V1.2 mutation must satisfy all five, and a missing one is a defect:

1. **Authentication.** A valid, active, unexpired token (`-32001` otherwise).
2. **Business scope.** The target business must be inside `api_clients.business_ids` and the required
   scope must be present (`-32003` otherwise, with the same message whether the business does not exist
   or is out of scope).
3. **Provenance.** Every submitted fact carries source type, source URL (when known), observed time and
   content hash.
4. **Idempotency.** Every mutating tool requires `idempotency_key` (≥ 8 chars). Same key + same payload
   replays the first result with `idempotent: true`; same key + different payload is refused.
5. **Typed validation.** Arguments are validated against the published JSON Schema before dispatch; a
   failure names the offending argument by path and nothing is written.

44.2 The published `inputSchema` and the validating schema must be the same object. A catalogue that
disagrees with dispatch is a defect (§4 of `docs/FRONTEND_CONTRACTS.md`).

44.3 A tool that writes must distinguish "no such entity" from success. A silently zero-row write that
returns `ok` is forbidden; field finding **F-3** is the historical instance of this defect.

44.4 A mutation that cannot complete must write nothing at all. Partial writes across a multi-table
commit are forbidden: the structured commit is one transaction.

## 45. The safe boundary for ChatGPT and OpenCode

45.1 **There is no arbitrary SQL tool.** `database.execute_sql`, `nexus.execute_sql`, `nexus.run_sql`
and `nexus.query` are forbidden names (`FORBIDDEN_MCP_TOOLS`) and must remain unresolvable. A test must
assert that no `api_clients` scope grants SQL and that the string `execute_sql` appears nowhere in the
migration set except as a forbidden name.

45.2 **No database credential is ever handed to ChatGPT or OpenCode.** Not a connection string, not a
service-role key, not a `postgres` URL, not a Supabase key. Neither agent's configuration may carry one,
and no tool may return one.

45.3 Neither agent may write a canonical field directly. OpenCode's only write path is evidence
submission through a typed tool; ChatGPT's write paths are the V1 typed verbs plus the V1.2 submission
tools.

45.4 Neither agent may see another tenant's data. Every tool is business-scoped, and the scope check
happens before the read.

45.5 Neither agent may advance a lead's sales state, mark a message sent, or set `confirmed_by_user`.
These are human actions.

45.6 What the boundary *does* give them: a durable queue to work from (OpenCode), structured reads that
are useful without SQL (ChatGPT), typed writes that are validated and auditable, and an idempotency
guarantee that makes retrying safe.

---

# Part K — Intelligence pipeline

## 46. The DeepSeek AI pipeline

46.1 DeepSeek is the only model provider (`integrations.deepseek`). Seven tasks exist (§21.3) and they
are **server-side only**:

| Task | Input | Output | Committed to |
| --- | --- | --- | --- |
| `PROFILE_EXTRACTION` | staged profile text | person/company/evidence/signals (§47) | `people`, `companies`, `person_contact_points`, `signals`, `source_evidence` |
| `COMPANY_EXTRACTION` | staged company research text | company facts, industry, size, domain, evidence | `companies`, `signals`, `source_evidence` |
| `SIGNAL_EXTRACTION` | staged signal research text | signals with polarity/strength and quotes | `signals`, `source_evidence` |
| `ICP_QUALIFICATION` | committed facts + ICP criteria | fit score, intent, matched ICP, reasons | `lead_icp_matches`, `signals` |
| `CONTEXT_BUILD` | permanent facts only (§59) | the Context Pack body | `ai_context_packs` |
| `MESSAGE_DRAFT` | Context Pack + step rules + approved assets | message body (and subject for email) | `message_versions` |
| `REPLY_CLASSIFICATION` | inbound reply text | one `REPLY_OUTCOMES` value + reason | `conversation_outcomes`, `interactions` |

46.2 **One centralised orchestrator.** Prompt construction, provider call, schema validation, cache
lookup, commit and ledger write must live in one server-side module per task, invoked through one
orchestration entry point. A call site that builds its own prompt or writes its own `ai_runs` row is a
defect: the cost rules in `docs/V1_2_AI_COST_CONTROL.md` are only enforceable if there is one door.

46.3 The provider is configured by `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` and `DEEPSEEK_MODEL`
(plus `DEEPSEEK_TIMEOUT_MS`, `DEEPSEEK_MAX_ATTEMPTS`, `DEEPSEEK_RETRY_BASE_MS`). The key is server-only,
read per call rather than at module load, never logged, never returned, and never sent to a browser.
**A missing key is a normal state**: the caller gets `provider_not_configured`, nothing is written, and
the screen still renders with manual alternatives.

## 47. The AI task contract

47.1 Every task invocation must record, without exception:

- task type (one of the seven);
- prompt version (`prompt_versions.id`) and `prompt_key`;
- provider and model;
- temperature and max output tokens actually used;
- the strict schema the answer had to satisfy;
- the normalised `input_hash` (§60);
- `business_id`;
- the relevant entity ids (lead, person, company, agent job as applicable);
- status and timestamps.

47.2 Every task must satisfy a **strict** schema before anything is written. Unknown keys are rejected
rather than persisted (`aiProfileExtractionSchema` is `.strict()`, and the profile task's grounding
guard `aiFactIsGrounded` drops an ungrounded field and reports it in `droppedUngrounded`).

47.3 **JSON must be validated before any canonical mutation, and a failed validation must not partially
merge.** Failure behaviour, in order: nothing is written; the failure is recorded with a closed
kind (`provider_not_configured`, `unauthorized`, `rate_limited`, `timeout`, `provider_unavailable`,
`invalid_request`, `malformed_json`, `schema_invalid`, `empty_response`); the retry decision uses the
error's `retryable` flag; the job or enrichment state records a stable error code.

47.4 Retry behaviour is the closed policy in §50.2: a schema violation may be retried once and only once,
because a model that emitted invalid JSON once sometimes does not the second time, while a
systematically wrong model must not spin.

47.5 No AI output may write a canonical field that a user has confirmed (§66.2). The quote requirement,
the drop rule and the untrusted-text boundary are specified in §51.

## 48. The orchestrator: one door for every model call

48.1 Every model call in V1.2 goes through one server-side orchestrator entry point per task. In this
branch that door is `apps/web/src/lib/ai/runner.ts`, with the prompt builders in `prompts.ts` and the
Context Pack in `context-pack.ts`. A call
site supplies the task, the business, the relevant entity ids, the facts to be considered and the prompt
key, and receives either validated data or a typed failure. It does not supply a prompt, and it does not
see an HTTP response.

48.2 The orchestrator owns, in this order: prompt resolution (an active business version, else the global
default); cache lookup on the normalised input hash; the provider call with the resolved temperature and
max output; strict schema validation; the `ai_runs` ledger write; and returning a commit-ready payload
together with its provenance (provider, model, prompt version, run id, attempts, latency, token usage).

48.3 The orchestrator must **not** own the commit. Writing facts to canonical tables is domain code and
happens in a transaction the orchestrator does not start, so a validation failure can never leave a
partial write.

48.4 A call site that builds its own prompt, calls the transport directly, writes its own `ai_runs` row,
or catches a provider failure in order to continue must be rejected in review. The cost rules in
`docs/V1_2_AI_COST_CONTROL.md` and the failure policy in §50 are only enforceable at one door.

48.5 The transport is the `AiProvider` interface (`complete(request): Promise<AiResult<T>>`), so a test
substitutes a deterministic provider and no test needs the network.

48.6 The orchestrator must behave identically when called from a background processor and from a request
path. A task must not depend on request-scoped state: no session, no open file handle, no
client-supplied business id beyond what the orchestrator re-validates.

## 49. Commit boundaries: what each task may write

49.1 A task's write set is part of its contract. Widening it is a specification amendment.

| Task | May write | Must not write |
| --- | --- | --- |
| `PROFILE_EXTRACTION` | `people`, `companies`, `person_contact_points`, `signals`, `source_evidence`, `lead_enrichment` (provenance + timestamps), `ai_runs` | `leads.status`, `leads.needs_profile`, `message_*`, `outreach_identities`, `confirmed_by_user` |
| `COMPANY_EXTRACTION` | `companies`, `signals`, `source_evidence`, `lead_enrichment`, `ai_runs` | as above |
| `SIGNAL_EXTRACTION` | `signals`, `source_evidence`, `lead_enrichment`, `ai_runs` | as above |
| `ICP_QUALIFICATION` | `lead_icp_matches`, `signals`, `ai_runs` | `leads.primary_icp_id` (only the audited `public.set_primary_icp` may swap it) |
| `CONTEXT_BUILD` | `ai_context_packs`, `ai_runs` | anything canonical — a Context Pack is derived, not a fact |
| `MESSAGE_DRAFT` | `message_versions` through the drafting path, `ai_runs` | `message_instances.state`, `message_events`, the versions of a `SENT` instance |
| `REPLY_CLASSIFICATION` | `conversation_outcomes`, `interactions`, `ai_runs` | `contact_suppressions` (created by the `capture_reply` trigger), and the stored reply text once written |

49.2 No task may write an `audit_events` row directly. The committing domain action writes its own audit
row, so the trail names the action rather than a model call.

49.3 No task may set `confirmed_by_user`, may demote a confirmed contact point's `is_primary`, or may
change a lead's sales state (§16.1, §66.2).

49.4 A task that needs a write outside its set must return the payload and let the owning domain action
commit it. "The model already returned it" is not a commit.

## 50. The failure taxonomy and retry policy

50.1 The failure vocabulary is closed (`AiFailureKind`) and total. A caller branches on `kind`; the
`retryable` flag decides whether another attempt could plausibly help.

| `kind` | Retryable | Effect |
| --- | --- | --- |
| `provider_not_configured` | no | nothing written; no state change; the UI offers the manual path (§52.2) |
| `unauthorized` | no | nothing written; a configuration defect an operator must fix |
| `rate_limited` | yes | nothing written; back off; the job stays `WAITING_AI` |
| `timeout` | yes | nothing written; retry within the attempt budget |
| `provider_unavailable` | yes | nothing written; retry within the attempt budget |
| `invalid_request` | no | nothing written; a code defect, not a data problem |
| `malformed_json` | once | nothing written; one extra attempt is allowed |
| `schema_invalid` | once | nothing written; one extra attempt is allowed |
| `empty_response` | once | nothing written; one extra attempt is allowed |

50.2 Attempts in total are `DEEPSEEK_MAX_ATTEMPTS` (default 3, including the first), with exponential
backoff from `DEEPSEEK_RETRY_BASE_MS` (default 500 ms) and a per-attempt timeout of
`DEEPSEEK_TIMEOUT_MS` (default 30 000 ms).

50.3 A failure must never advance `lead_enrichment.status` on its own. A retryable AI failure leaves an
agent job in `WAITING_AI` — it is not a lease expiry, because `WAITING_AI` holds no lease. A terminal
failure follows the agent-job failure rule (§40.2) and records a stable error code.

50.4 Every failure writes an `ai_runs` row with a status and an `error_code`, even when nothing else was
written. An unrecorded failure is indistinguishable from a call that never happened, which is what makes
"why did this lead not enrich" unanswerable.

50.5 A failure must never be retried by re-sending a raw body recovered from a log or a cache. The staged
row is the retry input; if it has expired, the work restarts from the operator or from a fresh agent job.

## 51. Groundedness, drops and untrusted text

51.1 Every extraction task must require a verbatim quote from the staged text for each fact it proposes,
in the shape `evidence: [{ field, quoted_text, confidence }]` (`aiProfileExtractionSchema`).

51.2 A proposed fact without a quote is **dropped, not persisted**, and its field name is returned in
`droppedUngrounded`. The UI must distinguish "not found" from "refused": a dropped field is displayed as
unconfirmed, with the reason, never silently as empty.

51.3 Quoted text must come from the staged body. `> OPEN:` whether a whitespace-normalised comparison is
sufficient or an exact byte match is required (recommended: normalise whitespace, then require an exact
match).

51.4 Staged text is untrusted data. An instruction inside pasted or scraped content is never an
instruction to the system: prompt construction must place it in the user turn inside an explicit
boundary, and the answer schema must contain no field that could change behaviour beyond the fact it
names. Grounding is what stops an injected instruction inside a scraped page from becoming a canonical
field.

51.5 The `uncertainties` array must be persisted with the run's provenance or inside the Context Pack, so
an operator can see what the model could not determine instead of inferring it from an empty field.

## 52. Provider configuration and degradation

52.1 Provider configuration is `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` and `DEEPSEEK_MODEL`, read per call
from the environment and never captured at module load. A build machine therefore needs no credential,
and a key rotation needs no code change.

52.2 `configured: false` is a supported state, not an error. Every screen that offers an AI action must
render, must say plainly that AI is not configured, and must offer the manual path. No AI screen may fail
because a key is absent.

52.3 `describeProvider` may report the model, the origin and a boolean. It must never return the key, a
prefix or a suffix of it, or the surrounding environment.

52.4 An upstream error body must pass through `redactSecrets` before it is logged, and a returned failure
carries an operator sentence plus an error code — never the upstream body.

52.5 The AI tab reports the same boolean and never a key (§63.4).

## 53. The AI Opportunity Brief

53.1 The AI Opportunity Brief is the intelligence-first summary at the top of Lead Detail (§69.1, item 2).
It answers four questions: why this lead, which signals justify it, what angle is recommended, and how
confident the recommendation is.

53.2 It is a **projection of the current AI Context Pack**, not a second model call. Rendering a brief
must never call a provider.

53.3 Required content: the recommendation, the signal list with its provenance, the recommended angle
naming the offer or positioning it derives from, a confidence indicator, the Context Pack version and its
generated timestamp, and the *view evidence* affordance (§54).

53.4 A brief must be visibly empty when there is nothing to say. With no signals it must say it has no
signals; with no Context Pack it must offer *refresh context* instead of showing an empty brief. It must
never invent a reason, a signal, a client name or a number.

53.5 Confidence must be derived deterministically from stored inputs (signal count and strength, ICP fit,
completeness score, and the age of the pack) and must be reproducible. A model-authored confidence is
forbidden, for the same reason a model-authored completeness score is forbidden (§27.1).

53.6 *Refresh context* builds a new Context Pack version; the brief then shows the new version, and the
previous version remains readable.

## 54. Evidence: what "view evidence" returns

54.1 The evidence set for a lead is the union of its active `signals` rows, the `source_evidence` metadata
rows those facts point at, the committed `research_snapshots` summaries, and the `ai_runs` identifiers
that produced them.

54.2 Every evidence entry must show the permanent allow-list of §32.3: source type, source URL, observed
timestamp, content hash, collector agent, agent job id, prompt version, model, extracted timestamp.

54.3 Evidence must never return a raw body. There is none to return for a V1.2 ingestion (§32.2.3), no MCP
tool returns one (§43.3), and a request for one must be refused rather than served from a cache or a log.

54.4 A claim with no evidence must be displayed as unproven. The product must not render a fact as
established when the only thing behind it is an inference.

54.5 Evidence must be filtered by the same business scope and RLS as the lead it belongs to. The evidence
view must not become a way to read another tenant's source URLs or collector agents.

## 55. Core end-to-end flows (A–I)

55.1 These nine flows are the acceptance scenarios for V1.2. Each must be executable end to end against
a real database, and each is referenced by `docs/CHATGPT_MCP_WORKFLOW.md`.

**Flow A — Minimal lead to ready lead (happy path).**
A human or ChatGPT creates a minimal lead (`nexus.submit_minimal_lead`) with a name, a company and a
LinkedIn URL. `lead_enrichment` starts at `NEEDS_PROFILE`; the chain creates a `RESEARCH_COMPANY` job;
OpenCode claims it, researches, submits evidence; DeepSeek extracts; the commit is verified; raw is
deleted; qualification and a Context Pack are produced; the state reaches `READY` and the score
recomputes upward.

**Flow B — Paste-only enrichment with no AI key.**
With `DEEPSEEK_API_KEY` unset, a human pastes a profile URL and body. The URL is recorded as a contact
point; the body is staged; `Enrich with AI` returns `provider_not_configured`; **the staged raw row
stays for the TTL and the UI does not display it**; the operator can still record facts manually and the
completeness score moves.

**Flow C — Deterministic search, no tokens.**
A lead with a name, a company and a location renders all four search links (§30.2) with correct URL
encoding. No provider call is made while rendering the page.

**Flow D — OpenCode researches a company.**
An agent authenticates, lists jobs, claims `RESEARCH_COMPANY`, heartbeats twice, submits the page text,
and receives `WAITING_AI`. The agent's next list call shows the job gone from `OPEN`. The job reaches
`COMPLETE` only after extraction and raw deletion, and `agent_job_events` shows `claimed`, `heartbeat`,
`result_submitted`, `ai_started`, `completed`.

**Flow E — Agent crash and lease recovery.**
An agent claims a job and dies. The lease expires. A second agent (or the same one) claims the job again
because `RUNNING` + expired lease is claimable; the reaper has returned it to `OPEN` and appended
`lease_expired`. No job is left `RUNNING` forever.

**Flow F — Repeated failure.**
An agent fails a job with `retryable = true` three times. After `attempt_count = max_attempts` the job
is `FAILED` with a specific `last_error_code`, the enrichment state records the failure, and the job is
no longer claimable.

**Flow G — ChatGPT reads and drafts.**
ChatGPT searches a lead, reads its structured enrichment context, adds a note and a task, and requests a
draft through Nexus. It never sees a raw body, never sees another tenant's data, and never obtains a
credential.

**Flow H — Human-confirmed value versus AI extraction.**
A user confirms an email. A later extraction proposes a different one. The confirmed value is **not**
overwritten; the lead's enrichment state becomes `NEEDS_REVIEW` and the workspace offers the specific
decision.

**Flow I — Reply, classification and DNC.**
An inbound reply is captured verbatim. `REPLY_CLASSIFICATION` proposes one `REPLY_OUTCOMES` value and a
reason; a human confirms. A `Do not contact` outcome creates the person+channel suppression across all
outreach identities (V1 invariant 8) and pauses the sequence (V1 invariant 9).

55.2 A flow is only satisfied when the same result is observable from the database and from the UI. A
mock, a fixture or a seeded state must not be presented as a passed flow.

---

# Part L — Prompts, extraction and context

## 56. Versioned prompts

56.1 Every AI task is driven by a row in `prompt_versions`. V1.2 extends the V1 table **additively**:
`business_id` (nullable — `NULL` means the global default), `system_prompt`, `template`, `temperature`,
`max_output_tokens`, `schema_ref`, `is_active`, `notes`. `key`, `version`, `purpose`, `template`,
`model`, `created_by`, `created_at` and the `unique (key, version)` constraint are unchanged.

56.2 The key list is exactly the twelve in §21.4. A prompt row whose `key` is not in that list must not
be activatable.

56.3 Resolution order for a task: an active business-specific version wins over the global default for
the same key, and the rule is implemented by `public.nexus_active_prompt(key, business_id)`, which
resolves the highest active version in the narrower scope. It is the only resolution path the
application may use. Migration `0033` deliberately adds **no** unique index enforcing "at most one
active version per `(business_id, key)`": every existing row becomes `is_active = true` when the column
is added, so such an index would fail on live data. Activation is therefore an application-level
transaction (deactivate the siblings, activate the chosen version), and a deployment that somehow holds
two active rows still resolves deterministically rather than unpredictably.

56.4 Activating a version is an admin action in the AI tab (§63) and must be audited. Activation must
not rewrite history: a stored `message_versions.prompt_version_id` keeps naming the version that
produced it.

56.5 The prompt version is part of the cache key (§60). Changing the active version must invalidate the
cache for that task by construction, not by a manual flush.

## 57. Profile extraction

57.1 `PROFILE_EXTRACTION` converts staged profile text into: person facts (`full_name`, `headline`,
`job_title`, `location`, `linkedin_url`), company facts (nullable: `name`, `domain`, `industry`,
`employee_count`, `linkedin_url`), an `evidence` array of `{field, quoted_text, confidence}`,
`signals`, `personalization_candidates`, and `uncertainties`.

57.2 It is grounded. A field with no verbatim quote in `evidence` is dropped and its name is returned in
`droppedUngrounded`. The UI must not present a dropped field as "nothing found".

57.3 The commit is ordered and transactional: resolve/create person → resolve/create company → write
contact points → write signals → write `source_evidence` metadata (including `raw_content_hash`,
`prompt_version_id`, `model`, `extracted_at`) → update `lead_enrichment` provenance and timestamps →
recompute completeness → delete the staged raw row → verify deletion → advance state.

57.4 `profile_agent_job_id` and, when the extraction came from an agent job, the job's
`result_ai_run_id` must be recorded so the fact set can be traced to the run that produced it.

57.5 Re-extracting the same profile must not create a second copy of the same facts. The
`(business_id, content_hash)` uniqueness on `source_evidence` and the contact-point uniqueness rule
(§25.3) are the mechanisms; a re-extraction whose `raw_content_hash` already exists must be a no-op for
the structured commit and must still consume and delete its staging row.

## 58. Company research and signals

58.1 `COMPANY_EXTRACTION` (and `SIGNAL_EXTRACTION`) follow the same shape as profile extraction:
staged raw in, strict schema out, grounded facts committed with provenance, raw deleted, state advanced.

58.2 Company research must record the domain it resolved from. A company fact set without a domain or a
`normalized_name` is not committable.

58.3 A signal must carry `kind` (from `SIGNAL_KINDS`), `polarity`, `strength` (−100…100), `label`,
`detail`, `observed_at` and, when it came from a page, the evidence row that proves it. A signal is
append-only: rediscovery inserts a new signal rather than updating one.

58.4 `ICP_QUALIFICATION` consumes committed facts and the business's ICP `criteria`, and writes
`lead_icp_matches` (`match_score`, `reason`) plus an intent assessment. Exactly one primary ICP may be
active (V1 invariant 2) and the qualification must not silently swap the primary ICP: a swap is the
audited `public.set_primary_icp` action.

## 59. The AI Context Pack

59.1 An **AI Context Pack** is the single, versioned, deterministic-from-facts bundle a drafting call is
given instead of the whole world. It is stored in `ai_context_packs`
(`business_id`, `lead_id`, `version`, `input_hash`, `pack jsonb`, `generated_by_run_id`, `model`,
`prompt_version_id`).

59.2 A Context Pack is built from **permanent facts only**: person, company, signals, ICP fit, intent,
opportunity, relevant offer, approved claims/proof, channel availability, and a prior
outreach/reply summary.

59.3 A Context Pack **must never contain raw source bodies**. It contains committed facts, their
provenance identifiers, and short summaries. If a summary would need the raw body to be meaningful, the
summary is wrong.

59.4 A pack must be reproducible from the database: regenerating with the same facts and the same
prompt version must produce the same `input_hash`, which is what makes the cache and the "changed facts
invalidate" rule work.

59.5 A Context Pack version is immutable once written. A refresh writes a new version; it never mutates
an existing one, because `message_versions.business_context_version_id` may point at it.

59.6 `> OPEN:` the schema version of `pack jsonb` and its forward-compatibility policy (a `schema`
field inside the pack is the recommended approach; the frozen design names the column but not the body).
Migration `0033` stores `pack` beside `source_summary jsonb` — the permanent facts the pack was built
from, so a cache miss can be explained without re-reading a raw body that no longer exists. Neither
column may hold a raw body (§52.3).

## 60. The AI cache

60.1 **Cache key = task type + normalised input hash + prompt version + model.** A successful prior
result for the identical key is reused.

60.2 The normalisation rules, the hash input composition and the per-task cacheability matrix live in
`docs/V1_2_AI_COST_CONTROL.md` and are normative.

60.3 A cache **hit** must be recorded in `ai_runs` as a row with `cache_hit = true`, the same task,
prompt version, model and `input_hash`, zero tokens in and out, and a zero or near-zero
`estimated_cost_usd`. A hit must be visible in the ledger, because an invisible hit is indistinguishable
from a broken call.

60.4 Cache invalidation is structural, not manual: changed facts change the input hash; a changed prompt
version changes the key; a changed model changes the key. There must be no "clear the cache" button,
because a manual flush is how a stale answer survives a fact change.

60.5 A cached result must never be used to satisfy a *different* entity. The hash covers the entity ids
and the fact values, so two leads with identical text and different ids are two cache entries. `> OPEN:`
whether a deliberate cross-lead reuse for identical company text is permitted; the default must be no.

## 61. The usage and cost ledger

61.1 `ai_runs` is the append-only ledger: business, task, entity ids, `agent_job_id`, provider, model,
`prompt_version_id`, `prompt_key`, `input_hash`, status, `tokens_in`, `tokens_out`,
`estimated_cost_usd`, `duration_ms`, `error_code`, `cache_hit`, timestamps.

61.2 **The ledger must never store a raw payload.** No prompt body, no user content, no model output, no
upstream response body. It stores identifiers, counts, money and status — the metadata that makes cost
attributable — and nothing that could contain a pasted profile.

61.3 An error is stored as a stable `error_code`, never as an upstream sentence.

61.4 The ledger is the source for the operator's usage view: usage by task, by business, by day
(§71.2 "AI usage today"). An operator must be able to answer "what did we spend on
`COMPANY_EXTRACTION` in this business this week, and how much of it was cache hits" from `ai_runs`
alone.

61.5 Cost estimation uses a per-model price table held in code/config, not in the database. `> OPEN:`
where the price table lives and who owns updating it when provider pricing changes.

## 62. Business Brain and AI

62.1 The Business Brain (personas, offers, services, value propositions, `knowledge_assets` and their
versions, `business_context_versions`) is the *only* source of approved positioning and proof.

62.2 A drafting call may use an asset only when it is approved **and** `ai_use_allowed` is true
(V1 `knowledge_assets.ai_use_allowed`), and may mention a client name only when
`may_mention_client_name` is true and a numeric result only when `may_mention_numeric_results` is true.

62.3 The whole Business Brain must never be dumped into a prompt. Retrieval is selective
(`selectRelevantAssets`) and bounded; the Context Pack carries the selected references.

62.4 A model must never invent a claim, a client name or a number. If no approved asset authorises a
numeric result, any digit is refused — including one that only quotes the prospect's own posting.

62.5 A Business Brain change that invalidates a claim must not silently rewrite a sent message.
`message_versions` for a `SENT` instance are immutable (V1 invariant 7).

## 63. AI settings

63.1 AI configuration is a first-class tab in Business Setup (§72.3), not a hidden environment toggle.

63.2 The AI tab must show, per task: the prompt key, the active version, the model, the temperature, the
max output tokens, and the status.

63.3 An admin must be able to activate a prompt version from the tab, and the activation must be
audited.

63.4 The tab must show the provider as **configured** or **not configured** and must never reveal the
key — not truncated, not partially masked, not in a tooltip, not in a network response
(`describeProvider` returns model, origin and a boolean; nothing secret).

63.5 The tab must be usable when the provider is not configured: it shows the prompt registry and the
status, and says plainly that AI features are unavailable rather than erroring.

## 64. Channel-specific messaging

64.1 Outreach is channel-specific and the channel is a property of the account, not of the source
(§20).

64.2 Each channel has its own prompt key and its own rules:

| Channel | Initial | Follow-up | Shape |
| --- | --- | --- | --- |
| linkedin | `linkedin_initial` | `linkedin_followup` | connection note / short message, no subject |
| email | `email_initial` | `email_followup` | subject + body |
| instagram | `instagram_dm` | `instagram_dm` | short DM, no subject |
| upwork | `upwork_proposal` | `upwork_proposal` | proposal against the job post, no subject |

64.3 A draft must be produced for the channel it will be sent on, using that channel's prompt key and
that channel's account. A LinkedIn draft must not be offered for an email send.

64.4 Generated bodies remain subject to `validateMessage` before storage: a body that misses its
personalization signal, asserts an unapproved numeric claim, contains a prohibited phrase, uses generic
praise or a high-pressure CTA is **discarded, not repaired**.

64.5 A draft is always a new `message_versions` row. A `SENT` instance's versions are immutable and a
generation against a `SENT` instance must be refused outright.

64.6 `> OPEN:` whether the `upwork_proposal` prompt key needs a follow-up variant. The frozen key list
has one Upwork key, and the table above follows the frozen list.

64.7 A body submitted through `nexus.submit_message_draft` becomes a new `message_versions` row, never an
overwrite, and the version of a `SENT` instance stays immutable. **RESOLVED (OPEN-23).** The V1.1 transport
path stored the submitted content without running `validateMessage` and marked the row
`is_manual_edit = false`, so a body that violated the messaging rules could be persisted through MCP even
though the AI drafting path would discard it. The V1.2 transport now loads the same draft context and
assertable-claim set the drafting path uses, runs `validateMessage`, refuses the violations that make text
unsafe to send (`prohibited_phrase`, `generic_praise`, `high_pressure_cta`, `unapproved_claim`,
`unauthorized_client_name`, `empty`), returns the style rules (`too_short`, `too_long`,
`missing_personalization`, `missing_explanation`, `missing_low_pressure_cta`) as warnings rather than
refusals — an external client may legitimately submit an excerpt or an edit — and writes the row with
`is_manual_edit = true`, which is what it is. `loadDraftContext` continues to refuse a `SENT` instance, so
sent content stays immutable.

## 65. Reply classification

65.1 `REPLY_CLASSIFICATION` receives the inbound reply text and proposes exactly one V1
`REPLY_OUTCOMES` value plus a short reason.

65.2 The proposal is a **suggestion**. The outcome recorded on `conversation_outcomes` is a human
decision; the capture path (`public.capture_reply`) writes the exact inbound text verbatim, records the
outcome, pauses the sequence and creates the DNC suppression when the outcome is `Do not contact`
(V1 invariants 8 and 9).

65.3 The classifier must never be the only writer of an outcome, must never invent a reply body, and
must never alter the verbatim text. The verbatim text is what is shown; a summary is a fallback only for
older rows without one.

65.4 A classification failure must not block the human path: the operator can always choose an outcome.

---

# Part M — Merge safety, async UX and the UI

## 66. Merge safety precedence

66.1 When two candidate values compete for one field, precedence is exactly, highest first:

1. **user-confirmed** (`confirmed_by_user = true`, or a field a user edited and the edit is audited);
2. **verified structured source** (a value from a named source with provenance and a confident schema
   commit);
3. **strong canonical identifier** (normalised LinkedIn URL, normalised company domain, normalised
   email);
4. **high-confidence AI extraction** (`confidence` above the task's threshold, grounded in a quote);
5. **AI inference** (a value the model derived rather than quoted).

66.2 **A conflict with a user-confirmed value must go to `NEEDS_REVIEW`, never silently overwrite it.**
The rules are: no AI write may replace a confirmed value; no import may replace a confirmed value; a
verified structured source may *propose* a replacement but must surface it as a review decision.

66.3 Level 4 must not replace level 2 or 3 either: an AI extraction that disagrees with a verified
structured source is a review, not an overwrite.

66.4 `NEEDS_REVIEW` must be actionable: the UI shows the two values, their provenance and their
precedence rank, and offers exactly two resolutions (keep the confirmed value, or accept the new one
with an audit entry). "Dismiss" must not be available, because a dismissed conflict is an unresolved
conflict that will be found again.

66.5 Every resolution must be audited with both values and the actor.

## 67. Async UX and processing states

67.1 **Enrichment must not feel synchronous.** No screen may block on a model call or on an agent job.

67.2 The processing steps must be shown as named states: source captured, person resolved, company
resolved, profile extraction, company research pending, qualification pending — each with a
done/current/pending indication, and each derived from stored rows rather than from client-side
optimism.

67.3 Long research must remain durable: closing the tab, restarting the browser, or a deploy must not
cancel a job or lose a staged body.

67.4 Progress must be observable without polling a model. The screen reads
`lead_enrichment.status`, `completeness_score`, `missing_fields`, the live `agent_jobs` rows and
`agent_job_events`; it must not trigger work to render.

67.5 A step that is waiting on an agent must say so and offer the manual alternative (paste, URL) rather
than an indefinite spinner.

67.6 A failure must be shown as a state with a stable code and a human sentence, not as a toast that
disappears. `FAILED` enrichment is visible in the Leads table and in the Overview metric (§71.2).

67.7 The elapsed-time display is derived from stored timestamps, never from a client timer that keeps
counting after the tab was closed.

## 68. UI — the Leads table (V1.2)

68.1 Columns, in this order: **Person, Company, title/location, enrichment status, completeness,
source, ICP, fit/intent, channels, owner, next action, latest signal, AI context readiness.**

68.2 Column semantics that must be exact:

- *enrichment status* — `lead_enrichment.status`, rendered with the nine-state vocabulary (§14.1);
- *completeness* — `Lead intelligence N%` with the missing fields available (§29.1);
- *source* — the discovery source (§18), never a channel;
- *channels* — the channels actually available from accounts and contact points (§20.3), never the
  source;
- *fit/intent* — the qualification output;
- *AI context readiness* — whether an `ai_context_packs` version exists and whether it is current with
  the facts;
- *next action* — V1 `next_action_type` / `next_action_at`, unchanged.

68.3 Row actions: **Open, Find LinkedIn, Enrich, Research Company, Create Agent Job, Draft Outreach.**
`Find LinkedIn` uses the deterministic link (§30). `Enrich` opens the lead's enrichment workspace.
`Research Company` creates or reuses the `RESEARCH_COMPANY` job (deduplicated, §42.5). `Create Agent
Job` opens the job dialog with type and priority. `Draft Outreach` is offered per available channel.

68.4 **No inaccessible row caps.** The table must paginate and must not silently truncate at a hidden
limit; the count shown must be the count returned by the query, and "showing N of M" must be accurate.
A cap that a user cannot see or reach is a defect.

68.5 Filtering and sorting must exist at least for: business, owner, enrichment status, completeness,
source, ICP, channel, and needs-enrichment. Sorting must be server-side for a paginated list.

68.6 The table must not load raw content, message history or the timeline. It reads structured columns
only (§76).

## 69. UI — the Lead Detail hierarchy (V1.2, intelligence first)

69.1 The hierarchy is fixed and ordered. Intelligence comes **before** the conversation:

1. **HEADER** — person, title, company, location; sales status; enrichment status; intelligence %;
   ICP/intent; available channels; Open LinkedIn / Open website actions.
2. **AI OPPORTUNITY BRIEF** — why this lead, the signals that justify it, the recommended angle, a
   confidence indicator, a *view evidence* affordance, and *refresh context*.
3. **PERSON / COMPANY / CONTACTS** — the structured facts, each with its provenance available, and the
   contact points with their confirmation state.
4. **ENRICHMENT WORKSPACE** — Find LinkedIn, the generated Google queries, the LinkedIn URL input, the
   temporary raw paste textarea, *Enrich with AI*, and *Research Company*. It must never re-display
   discarded raw (§32.2.6).
5. **SOURCE / PROVENANCE** — source type, source URL, observed time, content hash, collector agent,
   agent job id, prompt version, model, extracted time; plus concise structured summaries. No retained
   raw body.
6. **OUTREACH** — for each of LinkedIn, Email, Instagram, Upwork: the account, the state, and the next
   action. A channel with no account or no contact point must say which is missing.
7. **AI DRAFT** — channel-specific, with the prompt version and model named, and the validation result
   visible if the body was refused.
8. **TIMELINE** — human, message, reply, enrichment and agent-job events, merged newest-first. It must
   not become a research dump: an event's note is short operator text, and evidence is a structured
   summary plus a link to its provenance.
9. **TASKS** — the V1 task surface, unchanged.

69.2 The header must render both states side by side without implying a contradiction (§12.3).

69.3 The AI Opportunity Brief must never be shown as authoritative without its evidence affordance. A
brief with no signals must say it has no signals rather than inventing a reason.

69.4 *Refresh context* builds a new Context Pack version. It must not mutate the previous one (§59.5)
and must not run automatically on render.

69.5 The enrichment workspace is the only place that accepts raw paste. It must state, in the interface,
that the pasted text is temporary and will not be kept.

## 70. UI — the Agent Jobs operational screen

70.1 It lives under **Integrations / Automation** and is reachable by secondary navigation
(§73.2).

70.2 Summary counts must be shown for: **OPEN / RUNNING / WAITING AI / FAILED / DONE TODAY**. `DONE
TODAY` is `COMPLETE` with `completed_at` today. No other bucket may be invented.

70.3 Row columns: priority, type, entity, business, status, agent, lease, attempts, created, updated.

70.4 Authorized actions: **create, retry, cancel, release stale claim, open entity.** There must be **no
manual "complete"** action and no path that sets `COMPLETE` other than the verified commit (§41.3).
"Release stale claim" calls the reaping path for one job; it must not mark anything complete.

70.5 A failed job must show its `last_error_code` and the last event note, not a raw upstream message.

70.6 The screen must show the reason a job exists (`agent_jobs.reason`) and its dedupe key, so an
operator can tell a chained job from a hand-made one.

70.7 Job events are append-only in the UI too: no edit, no delete.

## 71. UI — Overview metrics (V1.2)

71.1 Metrics, exactly these: **Active Leads, Needs Enrichment, Agent Jobs Open, Waiting AI, Ready for
Outreach, Replies Today, AI usage today, Failed enrichments.** Plus an enrichment funnel and a recent
activity feed. No invented metrics.

71.2 Definitions, so two screens cannot disagree:

| Metric | Definition |
| --- | --- |
| Active Leads | leads in the business with `deleted_at is null` and `status != 'deleted'` |
| Needs Enrichment | leads whose `lead_enrichment.status` is one of `MINIMAL`, `NEEDS_PROFILE`, `PROFILE_READY`, `COMPANY_RESEARCH_PENDING`, `AGENT_RESEARCH_PENDING`, `AI_PROCESSING`, `NEEDS_REVIEW`, `FAILED` (i.e. not `READY`) |
| Agent Jobs Open | `agent_jobs.status = 'OPEN'` |
| Waiting AI | `agent_jobs.status = 'WAITING_AI'` |
| Ready for Outreach | `lead_enrichment.status = 'READY'` and the lead is not in an outreach-blocking sales state |
| Replies Today | inbound interactions of type reply with `occurred_at` today |
| AI usage today | `ai_runs` for the business today: calls, tokens, estimated cost, cache-hit share |
| Failed enrichments | `lead_enrichment.status = 'FAILED'` |

71.3 Every metric must be computed from stored rows with a bounded query (a count, a grouped count, or a
small aggregate). A metric must never require loading a lead's history.

71.4 The enrichment funnel must correspond to the enrichment states, not to the sales states.

71.5 "Recent activity" is the merged recent event feed (human, message, reply, enrichment, agent job),
bounded and paginated.

## 72. UI — Business Setup tabs

72.1 Tabs, in this order: **Overview, ICPs, Sequences, Knowledge, Signals, AI.**

72.2 Overview, ICPs, Sequences, Knowledge and Signals keep their V1 content and permissions
(`knowledge.manage`, `icp.manage`, `sequence.manage`, `scoring.manage`).

72.3 The AI tab is defined in §63.

72.4 A tab the actor may not use must be hidden, and its route must still be guarded with the same
permission it declares (`ROUTE_PERMISSIONS`), because a hidden control is not authorization.

## 73. UI — Admin IA and navigation

73.1 The IA is three groups and seven top-level destinations:

- **WORK** — Overview, Leads
- **CONFIGURE** — Business Setup, Team & Accounts, Integrations
- **ADMIN** — Insights, Settings

73.2 Secondary navigation carries the operational surfaces: **Agent Jobs, Channel Accounts, AI,
Automations, Imports, Access**. Secondary navigation must have a visible active state and must not be a
row of tiny concatenated links.

73.3 **No 25-item sidebar.** The sidebar stays the V1 width and depth; a new surface becomes a tab, a
child or a header action, not a new top-level entry.

73.4 Each secondary destination must declare its own route permission, and the route guard must enforce
it independently of the parent.

73.5 `> OPEN:` where the global businesses admin screen (V1 route `/businesses`, permission
`business.create`, currently a top-level Admin entry) sits in the V1.2 IA, since the frozen ADMIN group
names only Insights and Settings.

## 74. UI — Access UX

74.1 The role model is unchanged: **Admin / Manager / User**, with the V1 permission matrix, server
guards, RLS and hidden-business non-disclosure.

74.2 **A denied route is a 404, not a 403.** Revealing "this exists but you may not see it" is itself a
disclosure (`docs/FRONTEND_CONTRACTS.md` §1.3).

74.3 The three layers stay: route guard (may the screen render), action guard (may the posted action
run), RLS (may the row be read or written). RLS is the security boundary; a guard bug is a disclosure,
not a breach.

74.4 A `Server Action` must repeat its page's requirement. Gating the page does nothing for the action.

74.5 Secondary access links must be replaced by proper tabs or secondary navigation with active states,
keyboard reachability and a visible current location.

74.6 A business the actor cannot see must not appear in any selector, count, filter option or error
message. A missing account-business binding gets a **specific** message rather than the generic
"you do not have permission to do that" (§78.4).

## 75. Visual language and density

75.1 Unchanged from V1: light/off-white surfaces, cool gray structure, restrained cyan/indigo accents,
thin borders, compact professional density, desktop-first at 1440×980.

75.2 V1.2 adds no new colour semantics. Enrichment states and job statuses must be distinguishable
without relying on colour alone (label plus a shape or weight difference), because status colour alone
is not accessible.

75.3 Density is a feature: the Leads table shows thirteen columns at 1440 without horizontal scrolling
of the primary identifiers.

75.4 `docs/DESIGN_TOKENS.md` remains the token source. A new hard-coded colour or spacing value in a V1.2
screen is a defect.

## 76. Performance and rendering rules

76.1 **No AI on a normal page render.** A page load must not call a model, must not build a Context
Pack, and must not create an agent job.

76.2 Structured database reads only. A read path must not parse prose, must not compute an embedding and
must not call an external service.

76.3 Independent reads must be issued in parallel, not in a chain.

76.4 The viewer/business context must not be re-resolved in a query waterfall. `loadViewerContext()` is
idempotent and not cached (V1); V1.2 must not add a second, per-component resolution of the same data.

76.5 Lists paginate. Every new lookup field used by a list, a job claim, an enrichment filter or an AI
cache hit gets an index in `0034` (§`docs/V1_2_MIGRATION_PLAN.md`).

76.6 Raw content and full history must never be loaded unless explicitly requested by the operator, and
a raw body can never be requested because it no longer exists.

76.7 A screen that shows enrichment state must render in bounded time even when a thousand jobs are
queued: counts are aggregates, not row scans.

---

# Part N — Companion, gates and boundaries

## 77. Companion V1.2

77.1 The secure MV3 extension contract is preserved: no service-role key in the bundle, no arbitrary
host permission, no page-script injection beyond what V1 approved. The extension authenticates as the
signed-in user through `/api/v1/companion/*`.

77.2 V1.2 additions:

- **Binding** — the side panel selects the channel account and the business; the binding carries both.
- **LinkedIn channel account selection** — the extension shows the accounts the user may actually use,
  and remembers the selection.
- **Proper business intersection** — the businesses offered are exactly
  `companion_visible_business_ids(identity)` (§78).
- **Leads / Today / Search** — the three V1 modules stay, and the Leads list shows the enrichment
  indicator.
- **Minimal-lead Add to CRM** — a profile can be added with minimal data, immediately searchable, and
  without a complete enrichment (§8).
- **Enrichment indicator** — the panel shows the enrichment status of the lead it resolved.
- **Profile paste feeding the same pipeline** — pasted profile text goes to the same staging and
  extraction pipeline as the web workspace. The extension must not have a second, parallel extraction
  path.

77.3 The Companion must not display raw pasted text after it has been submitted, for the same reason the
web workspace must not (§32.2.6).

77.4 The Companion must keep working when the AI provider is not configured: capture and add-to-CRM are
not AI features.

## 78. Companion binding scope (migration `0035`)

78.1 The V1 function `public.companion_visible_business_ids(p_identity_id)` intersects
`user_business_access` with the identity's `outreach_identity_business_access`. For a **global admin**
with no `user_business_access` rows the intersection is empty, so an admin cannot bind an account they
administer. That is the defect V1.2 corrects.

78.2 The corrected rule: a global admin's eligibility is **the identity's own business access**;
account access remains mandatory for every actor. A non-admin still requires the intersection.

78.3 `public.companion_ineligible_reason(identity, business)` returns a specific, non-disclosing reason
code for the refusal. The reason must tell the operator what to fix without revealing a business they
cannot see.

78.4 The bind screen must use that reason: the business selector shows only businesses valid for the
selected channel account, switching the account recalculates the list, the server is authoritative, and
a missing account-business access produces the specific message rather than the generic permission text.

78.5 The reason codes returned by `public.companion_ineligible_reason(identity, business)` are exactly
`ok`, `identity_not_usable`, `no_account_access` and `no_user_grant`. They are stable machine strings.
The function is non-disclosing by construction: it never reads `public.businesses`, so an unknown
business id and an existing business the account cannot reach both answer `no_account_access`, and the
identity is judged first, so a caller who may not use the account learns nothing about any business. A
NULL business answers `ok` — binding before a business is chosen is legitimate — while still validating
the identity. The same rule is enforced by the `trg_browser_sessions_companion_scope` trigger, so the
pair the panel would not offer and the pair the database accepts are the same set.

## 79. Release gates

79.1 The gate is this exact command list, in this order:

```
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run db:verify
pnpm run build
pnpm --filter @nexus/extension run build
```

79.2 On top of the command gate, V1.2 requires:

- browser E2E and extension E2E (`pnpm --filter @nexus/extension run e2e`) covering the Lead Detail
  hierarchy, the Leads table actions and the enrichment workspace;
- migration and idempotency tests over `0030`–`0035` (re-running the set changes nothing);
- **V1.2 MCP tests** for all thirteen new tools: happy path, refusal, scope, idempotency replay,
  idempotency collision and typed-validation failure;
- **raw-deletion tests**: after a successful commit the staged row is gone, `source_evidence` carries
  the hash and not the body, the ledger has no payload, and a TTL sweep removes an abandoned row;
- **agent-concurrency tests**: two agents race for one job and exactly one wins; an expired lease is
  re-claimable; the reaper leaves nothing `RUNNING`; `nexus_complete_agent_job` refuses while an
  un-consumed staging row exists;
- a **clean checkout / clean worktree** run of the same gate, on the same SHA.

79.3 The build under test must be frozen for the run, as the V1 baseline verification did, and the
report must record the source hash and the SHA.

79.4 A gate must not be "passed" by skipping a test, by a `--passWithNoTests` empty suite that should
have had tests, or by a manual step performed outside the gate.

79.5 **Never claim COMPLETE if raw deletion, persistent agent jobs, AI orchestration, MCP agent access
or the intelligence-first Lead workflow are only mocked.** A mock is: a fixture standing in for a
persistent row; a stub provider standing in for the extraction commit path; a UI state that is rendered
without the row that produces it; a raw row that is never actually deleted; a job that reaches
`COMPLETE` without a verified commit; or an MCP tool that returns a canned structured result.

## 80. Hard boundaries

80.1 Do **not** deploy. Do **not** touch live Supabase. Do **not** touch live Vercel. Do **not** merge
to `main`. Do **not** force-push `integration/final`. Do **not** move tags.

80.2 The final action is pushing branch **`v1.2/ai-first-redesign`** only. ChatGPT later reviews it and
handles migrations, the Preview deployment and promotion. Those are not the implementer's steps.

80.3 Working in the branch is not authorization to run a migration against any hosted database. A
migration is applied by ChatGPT in a real PostgreSQL/Supabase project in the order given in
`docs/V1_2_MIGRATION_PLAN.md`.

80.4 Do not commit, push, or edit files outside the claimed scope of a workstream. The document set for
V1.2 is the six files listed at the top of this document plus the code, migrations and tests that
implement it.

## 81. Deferred and out of scope

81.1 Webhook delivery remains deferred (V1 finding, `docs/FRONTEND_CONTRACTS.md` §6.1). V1.2 must not
present webhooks as working.

81.2 Twitter/X outreach is not a V1.2 channel. Existing `twitter` platform values remain valid and map
to `channel = 'other'`.

81.3 Autonomy is bounded: no agent sends outreach in V1.2. `DRAFT_OUTREACH` produces a draft; a human
sends.

81.4 An agent may not confirm a fact, resolve a duplicate, merge a person, archive a business or delete
anything.

81.5 Multi-business cross-tenant learning, embeddings and vector search are out of scope. V1.2's
retrieval is selective and deterministic.

81.6 `> OPEN:` nothing in the frozen design describes what happens to facts already committed when a
prompt version is deactivated, beyond "sent messages stay immutable". Recommended: deactivation affects
only future runs.

## 82. OPEN register

82.1 These are the `> OPEN:` items in one place. Each must be answered and this document amended.

| Id | Item | Section |
| --- | --- | --- |
| OPEN-1 | **RESOLVED** — the discovery source is persisted as provenance in `source_evidence.source` (free text, so no migration is needed) and projected onto the V1.1 `leads.source_type` vocabulary by `DISCOVERY_TO_LEGACY_SOURCE`/`legacyLeadSourceFor()`; the ingest pipeline accepts an optional `discoverySource` | §18.3 |
| OPEN-2 | Whether a bare email may create a lead on its own | §8.4 |
| OPEN-3 | Whether an automatic transition may ever change `leads.status` | §12.3 |
| OPEN-4 | Deprecate `leads.needs_profile` or keep it in sync with `lead_enrichment.status` | §13.3 |
| OPEN-5 | The numeric readiness threshold for `READY` | §28.5 |
| OPEN-6 | Whether the `contacts` completeness component requires a confirmed, usable-channel or any contact point | §28.6 |
| OPEN-7 | Whether a business setting may require a minimum intelligence score before sending | §29.4 |
| OPEN-8 | Whether `person_contact_points` still needs a `provenance jsonb` column | §25.5 |
| OPEN-9 | Whether one account per `(channel, display_name)` is enforced by a constraint | §23.5 |
| OPEN-10 | The `required_capabilities` value vocabulary | §22 |
| OPEN-11 | **RESOLVED** — the new tools use `jobs:create`/`jobs:read`/`jobs:claim`/`jobs:submit` plus `lead:create`, `lead:read`, `profile:capture` and `evidence:add`, the same vocabulary the RLS helpers check (finding F-9 closed for the V1.2 surface) | §43.1, §43.6 |
| OPEN-12 | What happens to V1 `source_evidence.raw_text_or_json` bodies already stored | §32.2.3 |
| OPEN-13 | **RESOLVED** (migration `0033`) — no unique index; `nexus_active_prompt` resolves the highest active version and activation is an application-level transaction | §56.3 |
| OPEN-14 | The `ai_context_packs.pack` body schema version and compatibility policy | §59.6 |
| OPEN-15 | Whether cross-lead cache reuse for identical company text is permitted | §60.5 |
| OPEN-16 | Where the per-model price table lives and who owns it | §61.5 |
| OPEN-17 | Where the global businesses admin screen sits in the V1.2 IA | §73.5 |
| OPEN-18 | **RESOLVED** (migration `0035`) — codes are `ok`, `identity_not_usable`, `no_account_access`, `no_user_grant` | §78.5 |
| OPEN-19 | Whether the `upwork_proposal` prompt key needs a follow-up variant | §64.6 |
| OPEN-20 | The effect of deactivating a prompt version on already-committed facts | §81.6 |
| OPEN-21 | Whether groundedness compares quotes exactly or after whitespace normalisation | §51.3 |
| OPEN-22 | The `confidence` threshold that makes an AI extraction "high-confidence" for merge precedence level 4 | §66.1 |
| OPEN-23 | **RESOLVED** — `nexus.submit_message_draft` now runs `validateMessage` against the drafting path's assertable-claim set, refuses unsafe violations, warns on style ones and writes `is_manual_edit = true` | §64.7 |
| OPEN-24 | Whether a per-business AI daily spend cap is enforced or advisory, and where it is stored | `docs/V1_2_AI_COST_CONTROL.md` §8.3 |
| OPEN-25 | The field that makes an explicit draft regeneration a deliberate cache miss | `docs/V1_2_AI_COST_CONTROL.md` §4 |

82.2 An item marked `> OPEN:` must not be resolved by guessing. Where implementation needs a value
before the item is answered, the code must fail closed (refuse the operation, or leave the behaviour
unimplemented) rather than pick a plausible default that contradicts the frozen design.

## 83. Acceptance checklist

83.1 Each line is testable. V1.2 is complete only when every line is true of the same frozen build.

**State model**
1. `leads.status` and `lead_enrichment.status` are separate; no code derives one from the other.
2. Every lead has a `lead_enrichment` row, including leads created by import, paste, Companion and MCP.
3. `lead_enrichment.status` only ever holds one of the nine values.
4. `completeness_score` is 0–100 and matches the ten weights exactly; `missing_fields` is exhaustive.

**Ingestion**
5. A minimal lead can be created from the web UI, the Companion and `nexus.submit_minimal_lead`.
6. A minimal lead is not hidden, not an error, and is findable via *Needs Enrichment*.
7. Placeholder values are never written into canonical fields.
8. Replaying a minimal-lead ingestion returns the same `lead_id` with `idempotent: true`.

**Raw data**
9. After a successful extraction the staged row is deleted and `raw_deleted_at` is set on the evidence.
10. `source_evidence` for a V1.2 ingestion carries the hash and metadata, never the body.
11. `ai_runs`, `agent_job_events` and `audit_events` contain no raw body.
12. No MCP read tool can return a staged body.
13. An abandoned staging row is removed within one processor interval of its 24h TTL.
14. `raw_staging` is SELECT-denied for `authenticated`.

**Agent jobs**
15. Two agents racing for one job: exactly one claim succeeds.
16. A `RUNNING` job whose lease expires is claimable again and is reaped with a `lease_expired` event.
17. No job remains `RUNNING` after the reaper runs.
18. `nexus_submit_agent_job_result` can never produce `COMPLETE`.
19. `nexus_complete_agent_job` refuses while an un-consumed staging row exists.
20. A job that exhausts `max_attempts` becomes `FAILED` with an `last_error_code` and is not claimable.
21. Duplicate automatic chaining produces one live job, not two.

**AI**
22. A page render makes no provider call.
23. Every task records task type, prompt version, model, temperature, max output, input hash, business
    and entity ids in `ai_runs`.
24. A schema violation writes nothing.
25. An unchanged task/input/prompt/model reuses the cached result and records `cache_hit = true` with
    zero tokens.
26. A changed fact or a changed prompt version invalidates the cache.
27. A Context Pack contains no raw body.
28. A user-confirmed value is never overwritten; the conflict becomes `NEEDS_REVIEW`.
29. A missing `DEEPSEEK_API_KEY` degrades to `provider_not_configured` and writes nothing.

**MCP**
30. The thirteen new tools are listed, schema-validated, scope-checked, idempotent and provenance-recording.
31. No tool name or argument mentions SQL, and the forbidden names remain unresolvable.
32. No response, log or configuration contains a database credential or an AI key.

**UI**
33. The Leads table has the thirteen columns and the six row actions, with accurate, reachable paging.
34. The Lead Detail hierarchy is ordered as §69.1 and intelligence precedes the timeline.
35. The Agent Jobs screen shows the five summary buckets and offers no manual complete.
36. The Overview shows exactly the eight metrics plus a funnel and recent activity.
37. Business Setup has the six tabs including AI, and AI never reveals the key.
38. The IA is three groups and the secondary navigation has active states.
39. A denied route is a 404.
40. The Companion binds against the corrected business intersection and reports a specific reason.

**Gates**
41. The command list in §79.1 passes on a clean checkout of the same SHA.
42. The raw-deletion, agent-concurrency and V1.2 MCP test suites exist and pass.
43. Nothing in the release is a mock in the sense of §79.5.

---

*End of the V1.2 master specification.*
