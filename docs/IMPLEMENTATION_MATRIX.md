# NEXUS — Implementation Matrix (Phase 0)

**Derived from:** `product/Nexus_CRM_Master_Spec_v1.json` (`screen_inventory`,
`screen_behavior_crosswalk`, `data_model`, `api_contract`, `mcp_contract`) plus
the decoded Figma manifests in `.work/figtool/out/`.

**Status legend:** `[x]` implemented · `[~]` partially implemented · `[ ]` not started

This file is the single place that maps *wireframe → route/component → backend
entities/API → tests*, as required by the master prompt's Phase 0. It is kept up
to date as milestones land.

---

## 0. Input audit

| Input | Status | Notes |
| --- | --- | --- |
| `product/Nexus_CRM_Master_Spec_v1.json` | **read in full** (1638 lines) | Behavioural source of truth. |
| `Nexus_Admin_Backend_Final.fig` | **decoded** | `fig-kiwi` binary, format version 101, SCHEMA (raw DEFLATE) + DATA (Zstandard). 30 frames, A01–A30, no gaps. |
| `Nexus_User_CRM_Companion_Final.fig` | **decoded** | Same container/schema. 26 frames numbered `01–06, 11–30`. |

### Unresolved design input (reported, not silently redesigned)

The user `.fig` file **does not contain frames 07, 08, 09, 10**. This is not a
decoder limitation: the frame list is exhaustive and the file's own
`Internal Only Canvas` page is empty. Per the master prompt ("Report the exact
inaccessible design input, retain the route/state, and implement it in the same
documented Nexus design language"), those four screens are treated as follows:

| Missing frame | Spec screen that fills the slot | Decision |
| --- | --- | --- |
| `07` | `U18 — Create Task` | Not in the file. Route `/tasks/new` implemented in Nexus design language. |
| `08` | `U19 — Snooze & Reschedule` | Not in the file. Modal state on the lead/today context. |
| `09` | `U20 — Edit Lead` | Not in the file. Route `/leads/:id/edit`. |
| `10` | `U21 — Trash` | Not in the file. Route `/trash`. |

The spec's `screen_inventory.user` list is authoritative for *what must exist*,
and it lists U18–U21 but **not** U07–U10. So the file's numbering gap and the
spec's inventory agree on content; only the frame numbers differ. Nothing is
missing from the build — the four screens are implemented without pixel
reference.

Other decoded-file facts that constrain the build (recorded so nobody
re-derives them):

- No Figma components, groups, auto-layout, named styles, variables or effects.
  Every screen is a flat list of `ROUNDED_RECTANGLE` + `TEXT` nodes.
- No images, gradients or shadows anywhere. All fills are `SOLID`.
- Typography is effectively `10px`/`11px`/`12px` body with `14/18/24` headings.
- Palette measured from text fills: `#6B758C` (muted), `#131825` (ink),
  `#1F9E6B` (green), `#0DB8D1` (cyan), `#E08F14` (amber), `#5252E0` (indigo),
  `#D14047` (red), `#FFFFFF`.

---

## 1. Screen → route → component → data → test

Route conventions from spec `business_units.recommended_routes`:
`/b/:businessSlug/...` for business-scoped admin/user surfaces.
All business-scoped data access goes through `requireBusinessScope()`.

### 1.1 Admin surface (`screen_inventory.admin`, A01–A30)

| ID | Screen | Route | Primary components | Backend entities / RPC | Tests |
| --- | --- | --- | --- | --- | --- |
| A01 | Login | `/login` | `LoginForm` | `auth.users`, `users` | `auth.test.ts` |
| A02 | Overview | `/b/[slug]/overview` | `StatTile`, `ActivityFeed`, `LeadHealthPanel` | `leads`, `tasks`, `conversations`, `profile_capture_queue`, `audit_events` | `overview.test.ts` |
| A03 | Leads | `/b/[slug]/leads` | `LeadTable`, `LeadFilters`, `BulkActionBar` | `leads`, `lead_icp_matches`, `outreach_identities`, RPC `bulk_assign` | `leads.test.ts` |
| A04 | Lead Detail | `/b/[slug]/leads/[id]` | `LeadHeader`, `Timeline`, `NoteComposer`, `ReplyCapture`, `TaskList`, `SequencePanel` | `leads`, `interactions`, `notes`, `tasks`, `conversation_outcomes`, `message_instances` | `lead-detail.test.ts` |
| A05 | Lead Sources | `/b/[slug]/sources` | `SourceTabs`, `ImportHistory` | `import_batches`, `ingest_requests` | `ingestion.test.ts` |
| A06 | Profile Queue | `/b/[slug]/profile-queue` | `ProfileQueueTable`, `ProfileCapturePanel` | `profile_capture_queue`, RPC `submit_profile_capture` | `profile-queue.test.ts` |
| A07 | Duplicate Review | `/b/[slug]/duplicates` | `DuplicateCompare` | `duplicate_candidates`, RPC `merge_duplicate_candidate` | `dedupe.test.ts` |
| A08 | Trash | `/b/[slug]/trash` | `TrashTable` | `leads.deleted_at`, RPC `restore_lead` / `permanent_delete_lead` | `immutability.test.ts` |
| A09 | Reactivation | `/b/[slug]/reactivation` | `ReactivationList` | `sequence_enrollments.reactivation_due_at`, RPC `start_reactivation` | `reactivation.test.ts` |
| A10 | Businesses Hub | `/admin/businesses` | `BusinessTable`, `BusinessSwitcher` | `businesses` | `businesses.test.ts` |
| A11 | Business Setup · Brain | `/b/[slug]/setup` | `BrainTabs`, `AssetEditor` | `offers`, `services`, `personas`, `value_propositions`, `knowledge_assets` | `brain.test.ts` |
| A12 | ICP Manager | `/b/[slug]/icps` | `IcpList`, `IcpEditor`, `ScoringRuleEditor` | `icps`, `scoring_rules` | `icp.test.ts` |
| A13 | Sequence Manager | `/b/[slug]/sequences` | `SequenceEditor`, `StepEditor`, `PublishImpactDialog` | `sequences`, `sequence_versions`, `sequence_steps`, RPC `publish_sequence_version` | `sequence-lifecycle.test.ts` |
| A14 | Knowledge Library | `/b/[slug]/knowledge` | `AssetTable`, `AssetReviewPanel` | `knowledge_assets`, `knowledge_asset_versions`, `asset_extractions` | `knowledge.test.ts` |
| A15 | Team & Accounts | `/admin/team` | `UserTable`, `IdentityTable` | `users`, `outreach_identities` | `team.test.ts` |
| A16 | User Permissions | `/admin/team/[id]` | `PermissionMatrix` | `user_business_access`, `user_lead_scope` | `rls-access.test.ts` |
| A17 | Outreach Identity Detail | `/admin/identities/[id]` | `IdentityDetail`, `TransferDialog` | `outreach_identities`, `outreach_identity_business_access`, `identity_transfers`, `browser_sessions` | `identities.test.ts` |
| A18 | Integrations Gateway | `/admin/integrations` | `ApiClientTable`, `WebhookTable`, `TokenReveal` | `api_clients`, `webhook_endpoints` | `mcp.test.ts` |
| A19 | Automation Mapping | `/b/[slug]/automations` | `AutomationTable`, `AutomationEditor` | `automation_configs`, `agent_runs` | `automation.test.ts` |
| A20 | Admin Import Builder | `/b/[slug]/sources/import` | `ImportWizard`, `ColumnMapper` | `import_batches`, `import_rows`, RPC `run_import` | `ingestion.test.ts` |
| A21 | Messaging Insights | `/b/[slug]/insights` | `ReplyThemeChart`, `StepPerformanceTable` | `conversation_outcomes`, `message_events`, `message_instances` | `insights.test.ts` |
| A22 | Settings | `/admin/settings` | `SettingsForm` | `platform_settings` | `settings.test.ts` |
| A23 | Add Business Wizard | `/admin/businesses/new` | `BusinessWizard` | `businesses` + clone rules | `businesses.test.ts` |
| A24 | Companion · Leads (Shared) | extension `#/leads` | `CompanionLeadList` | same as U23 | `extension.test.ts` |
| A25 | Companion · Today (Shared) | extension `#/today` | `CompanionToday` | same as U24 | `extension.test.ts` |
| A26 | Companion · Search (Shared) | extension `#/search` | `CompanionSearch` | same as U25 | `extension.test.ts` |
| A27 | Companion · Add to CRM (Shared) | extension `#/add` | `AddToCrmForm` | same as U26 | `extension.test.ts` |
| A28 | Companion · Action Focus (Shared) | extension `#/focus/:leadId` | `ActionFocus` | same as U27/U28 | `extension.test.ts` |
| A29 | Admin · My Access & Assignment | `/admin/me` | `SelfAssignmentPanel` | RPC `self_assign_identity`, `identity_transfers` | `identities.test.ts` |
| A30 | Admin · Business Domains | `/admin/domains` | `DomainTable` | `business_domains` | `domains.test.ts` |

### 1.2 User surface (`screen_inventory.user`, U01–U30)

| ID | Screen | Route | Primary components | Backend entities / RPC | Tests |
| --- | --- | --- | --- | --- | --- |
| U01 | Login | `/login` | `LoginForm` | `users` | `auth.test.ts` |
| U02 | My Day · Today | `/my-day` | `TodayQueue`, `CategoryTabs`, `WorkNextButton` | RPC `get_today_queue` | `today.test.ts` |
| U03 | My Day · Upcoming | `/my-day/upcoming` | `TodayQueue` | RPC `get_today_queue(bucket=upcoming)` | `today.test.ts` |
| U04 | My Day · Done | `/my-day/done` | `DoneList` | `interactions`, `message_events` | `today.test.ts` |
| U05 | My Leads | `/leads` | `LeadTable` (user scope) | `leads`, `saved_views` | `leads.test.ts` |
| U06 | Lead Detail | `/leads/[id]` | shared with A04, reduced actions | as A04 | `lead-detail.test.ts` |
| U11 | Lead Sources | `/sources` | `SourceTabs` | `import_batches` | `ingestion.test.ts` |
| U12 | Lead Sources · File | `/sources/file` | `ImportWizard` | `import_batches`, `import_rows` | `ingestion.test.ts` |
| U13 | Lead Sources · Paste | `/sources/paste` | `PasteImport` | `import_batches`, `import_rows` | `ingestion.test.ts` |
| U14 | Lead Sources · Google | `/sources/google` | `GoogleDiscover` | `import_batches`, `profile_capture_queue` | `ingestion.test.ts` |
| U15 | Lead Sources · Apollo | `/sources/apollo` | `ApolloSearch` + **"Enrichment OFF"** label | `ingest_requests` | `ingestion.test.ts` |
| U16 | Profile Queue | `/profile-queue` | `ProfileQueueTable`, `ProfileCapturePanel` | RPC `submit_profile_capture` | `profile-queue.test.ts` |
| U17 | Duplicate Review | `/duplicates` | `DuplicateCompare` | RPC `merge_duplicate_candidate` | `dedupe.test.ts` |
| U18 | Create Task | `/tasks/new` | `TaskForm` | `tasks` | `tasks.test.ts` |
| U19 | Snooze & Reschedule | modal on `/my-day` + lead | `SnoozeDialog` | RPC `snooze_lead` | `today.test.ts` |
| U20 | Edit Lead | `/leads/[id]/edit` | `LeadEditForm` | `leads` | `leads.test.ts` |
| U21 | Trash | `/trash` | `TrashTable` (restore only) | RPC `restore_lead` | `immutability.test.ts` |
| U22 | Companion · Login & Browser Binding | extension `#/bind` | `BindForm` | RPC `bind_browser_session` | `browser-session.test.ts` |
| U23 | Companion · Leads | extension `#/leads` | `CompanionLeadList` | `leads` + list-state store | `extension.test.ts` |
| U24 | Companion · Today | extension `#/today` | `CompanionToday` | RPC `get_today_queue` | `extension.test.ts` |
| U25 | Companion · Search | extension `#/search` | `CompanionSearch` | `people`, `companies`, `leads` | `extension.test.ts` |
| U26 | Companion · Add to CRM | extension `#/add` | `AddToCrmForm` | RPC `submit_candidate` | `extension.test.ts` |
| U27 | Companion · Connection Focus | extension `#/focus/:leadId` | `ConnectionFocus` | RPC `mark_connection_sent` | `extension.test.ts` |
| U28 | Companion · Follow-up Focus | extension `#/focus/:leadId` | `FollowUpFocus` | RPC `mark_message_sent` | `extension.test.ts` |
| U29 | Companion · Reply & Notes | extension `#/reply/:leadId` | `ReplyCapture` | RPC `capture_reply` | `dnc-and-replies.test.ts` |
| U30 | Companion · Dormant & Reactivation | extension `#/reactivate/:leadId` | `ReactivationFocus` | RPC `start_reactivation` | `reactivation.test.ts` |

**Shared-implementation rule.** A24–A28 are the *same extension routes* as
U23–U28, not separate screens. `spec.companion_extension.shared_for_admin_and_user`
and `crm_modules` "shared lead detail" forbid three (or two) independent
implementations. The role only widens the selector options (business, ICP, owner,
sender) rendered by `CompanionShell`.

---

## 2. Data dependency graph (build order)

```
                    businesses ─┬─ business_domains
                                ├─ user_business_access ── user_lead_scope
                                ├─ outreach_identities ─┬─ outreach_identity_business_access
                                │                       └─ browser_sessions
                                ├─ icps ── scoring_rules
                                ├─ sequences ─ sequence_versions ─ sequence_steps
                                ├─ personas / offers / services / value_propositions
                                └─ knowledge_assets ─ knowledge_asset_versions ─ asset_extractions
                                          │
        companies ── people ── social_profiles      (canonical, global)
                     │           │
                     └─────┬─────┘
                           ▼
                         leads ─┬─ lead_icp_matches
                                ├─ lead_assignments
                                ├─ signals ── source_evidence ── research_snapshots
                                ├─ sequence_enrollments ─┬─ conversations ─┬─ conversation_outcomes
                                │                        │                  └─ message_instances ─┬─ message_versions
                                │                        │                                       └─ message_events
                                ├─ notes / tasks / interactions / opportunities / rfps
                                ├─ cooldowns
                                ├─ profile_capture_queue
                                ├─ duplicate_candidates
                                └─ import_batches ─ import_rows
                                
        contact_suppressions (person+channel, global)
        api_clients ─ webhook_endpoints ─ automation_configs ─ agent_runs ─ ingest_requests
        audit_events (append-only) · saved_views · platform_settings · prompt_versions
        business_context_versions
```

Migrations `0001`–`0014` already implement this graph, including the enforcing
triggers, RPCs and RLS.

---

## 3. Invariant → enforcement → test (closure check)

| # | Invariant (spec) | Enforced by | Test |
| --- | --- | --- | --- |
| 1 | one active Lead per (business, person) | partial unique `leads_business_person_active_key` | `invariants.test.ts` |
| 2 | exactly one Primary ICP per lead | partial unique `lead_icp_matches_primary_key` | `invariants.test.ts` |
| 3 | normalized LinkedIn URL is the person key | unique `people_normalized_linkedin_key` | `invariants.test.ts` |
| 4 | normalized domain is the company key | unique `companies_normalized_domain_key` | `invariants.test.ts` |
| 5 | rediscovery → new evidence, not new identity | unique `(business_id, content_hash)` on `source_evidence` | `invariants.test.ts` |
| 6 | ingestion idempotency | unique `(source_client, business_id, idempotency_key)` | `invariants.test.ts` |
| 7 | sent content immutable | `enforce_message_immutability()` | `immutability.test.ts` |
| 8 | DNC suppresses across all identities | `enforce_dnc_suppression()` + `block_dnc_message()` | `dnc-and-replies.test.ts` |
| 9 | reply pauses pending steps | `pause_sequence_on_reply()` | `dnc-and-replies.test.ts` |
| 10 | one active enrollment per lead | partial unique on `sequence_enrollments` | `invariants.test.ts` |
| 11 | permanent delete admin-only + audited | `prevent_hard_delete()` + `permanent_delete_lead()` | `immutability.test.ts` |
| 12 | one default primary domain per business | partial unique on `business_domains` | `domains` tests |
| 13 | business domain globally unique | unique `business_domains_normalized_domain_key` | `domains` tests |
| 14 | each identity has its own business access | `outreach_identity_business_access` + `has_identity_business_access()` | `rls-access.test.ts` |
| 15 | browser session bound to a usable identity | `validate_browser_session_identity()` | `rls-access.test.ts` |
| 16 | lead status ∈ spec states | CHECK against `LEAD_STATES` | `invariants.test.ts` |
| 17 | next_action_type ∈ spec values | CHECK against `NEXT_ACTION_TYPES` | `invariants.test.ts` |
| 18 | evidence carries provenance | NOT NULL on source/observed_at/content_hash/confidence | `invariants.test.ts` |
| 19 | message versions carry audit refs | CHECK on `message_versions` | `immutability.test.ts` |
| 20 | sensitive mutations are audited | `audit_row_change()` triggers | `immutability.test.ts` |
| R1 | hidden business invisible to a user | RLS `has_business_access()` | `rls-access.test.ts` |
| R2 | unassigned identity unusable | RLS on `outreach_identities` + `assert_identity_usable()` | `rls-access.test.ts` |
| R3 | external token cannot exceed scopes | `is_api_client_allowed()` | `rls-access.test.ts` |
| R4 | deleted leads excluded from lists | RLS + `deleted_at IS NULL` predicates | `invariants.test.ts` |
| R5 | no raw SQL execution anywhere | no such function; `execute_sql` string absent | `rls-access.test.ts` |

**Defects found and fixed during the Phase 0 audit** (all were pre-existing, and
all are now covered):

1. `auth.uid()` raised `22P02` on the transaction immediately after any
   `ROLLBACK`, because a rolled-back `LOCAL` setting reads back as `''`, not
   `NULL`. Fixed in `0001_extensions_and_helpers.sql`; the same bug would have
   hit pooled PostgREST connections.
2. `advanceAfterSent` read the *next* step's `delayBasis` instead of the
   just-sent step's, which would have anchored FU2/FU3 to connection acceptance
   and collapsed the cadence. Fixed in `packages/core/src/sequence-engine.ts`.
3. `packages/core` delay-basis vocabulary (`connection_accepted` /
   `previous_step_sent` / `enrollment_start`) contradicted the SQL CHECK
   constraint (`immediate` / `after_previous` / `after_enrollment` /
   `after_connection`). Unified on the SQL vocabulary, exported as `DELAY_BASES`.
4. `normalizeLinkedInUrl` returned `null` for regional hosts
   (`de.linkedin.com/in/x`), losing the strongest dedupe key. Fixed.
5. `normalizeCompanyName` stripped `group`/`holdings`/`company` as if they were
   legal suffixes, collapsing names to `''` and merging unrelated companies.
   Fixed, and suffix stripping can no longer empty a name.
6. `evaluateIdentityConcurrency` ignored its `staleAfterMinutes` parameter, so a
   browser profile closed uncleanly would lock its sender identity forever. Fixed.
7. `usableIdentities` ignored business grants, contradicting
   `extension_visibility_rule`. Fixed.
8. `packages/db/package.json` pointed `verify`/`reset` at a non-existent
   `scripts/verify.ts`. Fixed.

---

## 4. AI / external boundary

| Boundary | Schema | Validated at | Test |
| --- | --- | --- | --- |
| Ingest envelope | `ingestEnvelopeSchema` | gateway before any write | `contracts` tests |
| AI profile extraction | `aiProfileExtractionSchema` | server before mutation | `contracts` tests |
| Message draft | `messageDraftSchema` | server before persisting a version | `contracts` tests |
| Reply capture | `replyCaptureSchema` | server before `capture_reply` | `dnc-and-replies.test.ts` |
| MCP tool call | `mcpToolEnvelopeSchema` | gateway, per-tool schema | `mcp` tests |
| Scraped content | `zUntrustedContent` | treated as data, never instructions | `contracts` tests |

Forbidden everywhere: `database.execute_sql`, service-role keys in any client or
extension bundle.
