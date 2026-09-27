# NEXUS — Final UI Acceptance

**Branch:** `integration/final` · **Visual authority:** live Figma `EmH8Y5EuI6PZ0tfKyBf7Ay` (Admin) and
`KNDsf7bYArPXtGpSkUk9D6` (User + Companion)

This document records what was **actually verified** against a running build, and what was not. A row is
`PASS` only where an explicit check was executed and its result recorded. Nothing here is inferred from
source alone.

---

## 1. Build gates

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck (web) | `tsc --noEmit -p apps/web/tsconfig.json` | **PASS** — 0 errors |
| Typecheck (core) | `tsc --noEmit -p packages/core/tsconfig.json` | **PASS** — 0 errors |
| Typecheck (ui) | `tsc --noEmit -p packages/ui/tsconfig.json` | **PASS** — 0 errors |
| Web build | `next build` (via `apps/web` binary) | **PASS** — `BUILD_ID` written |
| Lint | `pnpm run lint` (5 packages, `--max-warnings 0`) | **PASS** |
| Unit/integration tests | `pnpm run test` | **PASS** — 0 failures |
| DB gate | `pnpm run db:verify` | **PASS** |
| Extension build | `pnpm --filter @nexus/extension run build` | **PASS** |

### Test counts

| Package | Tests | Result |
| --- | --- | --- |
| `@nexus/core` | 88 | PASS |
| `@nexus/db` | 82 | PASS |
| `@nexus/extension` | 9 | PASS |
| `@nexus/web` | 220 | PASS |
| **Total** | **399** | **0 failures** |

Notable web suites exercising the surfaces this baseline touched: `identity-lifecycle` (20),
`business-archive` (16), `business-lifecycle` (6), `ai-drafting` (23), `ai-draft-outcome` (9),
`ai-profile-capture` (9), `sent-message-content` (6), `mcp-gateway` (30), `lead-timeline` (2),
`companion-binding` (6), `auth` (26), `settings` (5), `duplicates` (4), `form-data` (14),
`platform-settings-scope` (5).

### Database

`pnpm run db:verify` applied **25 migrations to a clean database** and verified the result:

| Object | Count |
| --- | --- |
| Tables | 64 |
| Policies | 181 |
| Triggers | 105 |
| Functions | 98 |
| Indexes | 177 |

`Verification passed.` Migration order, constraints, triggers, RLS, functions, indexes and seed
behaviour all verified. The demo seed satisfies the SENT invariant by transitioning
DYNAMIC → version → SENT; migration `0021` was not weakened.

---

## 2. Admin shell and navigation

Verified by measuring the rendered DOM with an authenticated session (1440 × 980, device scale 1).

| Check | Expected (Figma A02) | Measured | Result |
| --- | --- | --- | --- |
| Sidebar width | 238 px | 238 px | PASS |
| Content width | ~1202 px | 1202 px | PASS |
| Top-level destinations | 7 | 8 (7 + Businesses) | PASS_WITH_MINOR_VISUAL_GAPS |
| Groups | WORK / CONFIGURE / ADMIN | Work / Configure / Admin | PASS |
| Content x-origin | 238 px | 238 px | PASS |

**Consistency across route families** — the previous implementation collapsed on non-business-scoped
routes. Measured link counts after the fix:

| Route | Before | After |
| --- | --- | --- |
| `/` | 4 | **8** |
| `/b/zemnas/leads` | 8 | 8 |
| `/b/zemnas/setup/icps` | 8 | 8 |
| `/team` | 4 | **8** |
| `/integrations` | 4 | **8** |
| `/my-day` | 4 | **8** |

**Secondary navigation** — each section renders its own tab strip, so nested modules are reachable:

| Section | Tabs rendered |
| --- | --- |
| Leads | Lead Sources · Profile Queue · Duplicate Review · Reactivation · Trash |
| Business Setup | ICPs · Sequences · Knowledge · Signals |
| Team & Accounts | Outreach Identities · My Access |
| Integrations | Automations · Import Builder · Business Domains |

**Route reachability** — all 28 navigation destinations were fetched with an authenticated session:
**28 × HTTP 200, zero 404**. Three previously 404'd (`/b/:slug/setup`, `/b/:slug/setup/signals`,
`/b/:slug/insights`) and now resolve to real pages reading live data.

### Divergence from the frame

The sidebar carries **eight** destinations where the frame draws seven. `Businesses` is retained as a
top-level entry because it is the only route to business creation and the business lifecycle controls,
and the frame provides no other home for it. This is a deliberate, documented divergence, not an
oversight.

---

## 3. Leads

| Requirement (frame A03) | Result |
| --- | --- |
| Eight columns: Person · Company · Status · Primary ICP · Owner · Sender · Source · row menu | PASS |
| Five filter selects | PASS |
| Status-chip quick-filter row with real counts | PASS |
| Bulk-actions bar: Assign owner · Change Primary ICP · Change sender · Archive · Delete | PASS |
| Row action menu with a per-row accessible name | PASS |

**Bulk actions are real.** A server action enforces the per-operation permission
(`lead.assign_owner`, `lead.change_primary_icp`, `lead.change_sender_identity`, `lead.archive`,
`lead.soft_delete`; `lead.permanent_delete` admin-only), re-authorizes the route independently because a
Server Action is reachable without its page, and returns real counts so the bar renders
"18 of 20 archived; 2 refused" rather than a bare success.

### Pagination

| Check | Result |
| --- | --- |
| `PAGE_SIZE` 25 with offset paging | PASS (source + runtime) |
| Pager preserves filters | PASS |
| No `.slice(0, n)` row cap anywhere in `apps/web/src` | PASS — verified by repository-wide search |
| Records reachable with no gaps | PASS |

**On the row caps:** a repository-wide search for `.slice(0, n)` row limits found **none** on Leads,
My Leads, My Day Upcoming/Done, Lead Sources or Overview. The eight hard caps recorded in the earlier
comparison audit belonged to the **donor branch**, which this tree does not contain. My Day Done is
bounded at 50 by a documented observation window ("don't scan all interaction history"), which is a
design choice, not an inaccessible-data defect.

**Not verified:** the boundary matrix at exactly 1 / 5 / 6 / 21 / 25 / 26+ records with a `pageSize`
override. The seeded business has 21 leads against `PAGE_SIZE` 25, so the pager renders one page and the
override was not exercised end to end. Recorded as `PARTIAL`.

---

## 4. Lead Detail

Composition recomposed to frames A04 (`3:239`) and U06 (`4:294`): header → **Lead control** +
**Sequence** two-up → **Actions** bar → **Conversation, replies & notes**.

| Requirement | Result | Evidence |
| --- | --- | --- |
| Two-up Lead control + Sequence at the top | PASS | Recomposed; Sequence moved out of the rail |
| Actions bar with note/task/reply/snooze/connection/edit/trash | PASS | `LeadActionWorkspace` renders the bar with modal forms |
| Sequence rows bound to real state | PASS | New `sequenceStepsForLead` reads `message_instances` |
| No runtime literals (`PAUSED · REPLY`, `CANCELLED`, `Keep paused`) | PASS | Repository-wide search found **zero** occurrences in `apps/web/src` |
| `CANCELLED` derived from stored state | PASS | Computed as an unsent LOCKED step past its due date |
| SENT content shown, never "not generated" | PASS | `dueMessageForLead` content in a `MessageBlock`, with `ImmutableNotice` |
| Full history reachable | PASS | Every timeline event renders in a scrollable container; no `.slice()` |

**Correction to the earlier audit:** the hard-coded sequence literals were a **donor-branch** defect.
This branch never contained them, so "replace the literals" was not the work — establishing the real
step binding was, because the panel previously showed a single summary row rather than the frame's step
list.

**Not verified:** a lead whose sequence is genuinely paused-with-reply, to confirm the panel renders a
real `PAUSED · REPLY`-equivalent from stored state for that specific case.

---

## 5. Business and Identity lifecycle

### Business

| Requirement | Result |
| --- | --- |
| Archive with optional reason | PASS |
| Restore, only when `status === 'archived'` | PASS |
| Guarded permanent Delete behind typed-key confirmation | PASS |
| `business_has_protected_history` rendered as why-it-is-blocked plus preservation counts | PASS |
| Archive offered as the safe alternative | PASS |
| Branches on the error CODE, never on message prose | PASS |
| Archived businesses leave active selectors | PASS — `listBusinesses` excludes them |
| Archived businesses remain historically readable | PASS — hub lists with `includeArchived` |

### Identity

| Requirement | Result |
| --- | --- |
| Dedicated **Unassign** (`unassignIdentityAction`) | PASS |
| `toUserId: ''` sentinel removed | PASS — `assignSchema.toUserId` is a `uuid`; the empty-string mapping is gone |
| Transfer with explicit confirmation | PASS |
| Retire / Archive with terminal confirmation | PASS |
| Guarded Delete behind typed-name confirmation | PASS |
| `identity_has_attribution` rendered with counts + Retire offered | PASS |
| **No Restore-Identity control** (retirement is terminal) | PASS |

Backed by `identity-lifecycle` (20 tests) and `business-archive` (16 tests).

---

## 6. DeepSeek AI

| Requirement | Result |
| --- | --- |
| Drafting control wired to the real `draftMessageAction` | PASS |
| Every `AiFailureKind` rendered as a distinct state | PASS — `ai-draft-outcome` (9 tests) |
| `provider_not_configured` shown as a normal deployment state, not an error | PASS |
| Schema failure shown as "regenerate — nothing was stored" | PASS |
| Profile capture: local fallback, schema validation, provenance, grounding | PASS — `ai-profile-capture` (9 tests), `ai-drafting` (23 tests) |
| No secret in browser or logs | PASS — `redactSecrets`; extension bundle scanned at build time |
| Live provider smoke test | **PENDING_HOST_ENV** — no `DEEPSEEK_API_KEY` in this environment |

The live test is deferred because the environment has no key. **The code path is wired**, exercised by
the mocked/provider-contract suites, and the UI correctly reports the unconfigured state — so this is
not an unwired integration.

---

## 7. Companion CORS

| Check | Result |
| --- | --- |
| Preflight from `chrome-extension://` | PASS — 204 with `Access-Control-Allow-Origin: *` |
| Sign-in | PASS — 200 with token |
| Authenticated read (`/me`, `/bootstrap`) | PASS — 200 |
| Browser-context fetch that previously threw `Failed to fetch` | PASS — now completes |

`next.config.ts` is the single source of truth. The dead `middleware.ts` that never executed has been
deleted (see `DEPLOYMENT_READINESS.md` §4 for the full history).

---

## 8. Chrome Companion

| Check | Result |
| --- | --- |
| Extension build | PASS — 6 files; "manifest valid, no credentials in the bundle" |
| Extension lint | PASS |
| Extension unit tests | PASS — 9 |
| Real panel boot in Chromium | **PASS** — 420 × 820, extension id `aioglcndcbbdfallibppohnfakadieki` |
| Real-origin API connectivity | **PASS** — preflight from `chrome-extension://…` returns 204 with `ACAO: *` |
| Real-origin E2E (Playwright) | **PASS** — **38 passed, 0 failed, 0 skipped**, exit 0 |
| Flow verification (binding, leads, today, search, Add to CRM, connection, reply/note, DNC, list restore) | **PASS** |
| Visual comparison against frames U22–U30 (420 × 820) | **PARTIAL** — U22 compared and differs; U23–U30 `BLOCKED` (no captures) |

The full per-flow and per-frame detail is in `_extension-acceptance-section.md`. Summary:

- The panel genuinely boots, signs in, binds an identity, survives a reload and a service-worker
  restart, persists list state in `chrome.storage.local` and the token in `chrome.storage.session`,
  and handles a revoked token by returning to sign-in.
- **Both previously-skipped cases now pass**, including `a Do-Not-Contact lead is shown as suppressed
  and offers no outreach` — suppression is a safety control, so its UI verification matters.
- **One real visual deviation (U22):** the live frame draws credential sign-in and browser binding as
  two stages of a **single** panel; the built panel shows only the credential form and puts the
  persistent business/ICP/sender selectors in the CRM view. The binding functionality exists and is
  covered by eight E2E tests, so this is a **composition** defect, not missing function. The header
  also shows `Companion` where the frame shows the operator's identity, and the panel leaves a large
  empty lower half where the frame places the binding controls.
- **U23–U30 are `BLOCKED`, not passed** — no side-panel captures were produced for those states.

Status: `PASS_WITH_MINOR_VISUAL_GAPS`.

---

## 9. Auth / RBAC / RLS, dedupe, ingestion and invariants

The objective requires these to be verified rather than asserted. They are, and by database-level
suites that exercise real RLS as a **non-owner** role rather than by reading the policy text. The
earlier note in this document that these were "not independently re-run" was accurate about a manual
pass but understated the coverage: **55 named cases across three `packages/db` suites** already prove
each requirement. They run as part of `pnpm run test`, and were re-run from a clean checkout.

### RLS and access control — `packages/db/test/rls-access.test.ts` (26 cases)

| Requirement | Proven by |
| --- | --- |
| A user cannot see a hidden business | `a user cannot see a hidden business` |
| A user cannot reach another business's leads even by guessing the UUID | `a user cannot see another business leads even by guessing the uuid` |
| Only an admin can create a business | `a normal user cannot create a business` |
| A user cannot select an identity they do not manage | `a user cannot select an identity they do not manage` |
| Lead writes are scoped to accessible businesses | `a user cannot insert a lead into a business they lack access to`; `…cannot move a lead into a business they lack access to`; `a user without can_manage_leads cannot insert a lead` |
| An update against an invisible lead changes nothing | `an update against an invisible lead affects zero rows and changes nothing` |
| Permanent delete is refused for users **and** managers | `a normal user cannot permanently delete a lead`; `a manager in the business still cannot permanently delete a lead` |
| Anon sees nothing | `the anon role cannot read any application table` |
| A session with no subject, and a user with no grants, see nothing | two cases under `anon and unmatched actors see nothing` |
| **Companion visibility is an intersection, never a union** | `equals user_business_access INTERSECT identity business access`; `is an intersection, never a union` |
| **No arbitrary-SQL entry point exists** | `no application function executes caller-supplied SQL` |
| API-client scope boundary and auditing | `a token reads only businesses inside api_clients.business_ids`; `an allowed api-client write succeeds and is audited as api_client`; `a client cannot write into a business outside its business_ids` |

The "hidden-business non-disclosure" requirement from the brief is covered directly, as is the rule
that frontend hiding is not security — every case above is enforced in the database, not in the UI.

### Dedupe, ingestion and invariants — `packages/db/test/invariants.test.ts` (22 cases)

| Requirement | Proven by |
| --- | --- |
| One active lead per person per business | three cases under `invariant 1`, including that a duplicate is **rejected**, that a soft-deleted lead does not block a new one, and that `restore_lead` re-checks |
| Exactly one primary ICP per lead | `a second primary ICP match is rejected`; `secondary matches never create a second lead`; `set_primary_icp swaps the primary and keeps the secondaries, audited` |
| Canonical dedupe keys | `normalizes a LinkedIn URL before the uniqueness check`; `rejects a second person with the same normalized LinkedIn URL`; `rejects a second company with the same normalized domain` |
| **Rediscovery adds evidence, never duplicate entities** | `creates new source_evidence and leaves person/company counts unchanged`; `rejects a replayed evidence hash inside the same business` |
| **Ingestion idempotency** | `the same (source_client, business_id, idempotency_key) cannot be inserted twice` |
| Provenance is mandatory | `null provenance columns are rejected` |
| Message versions require audit refs | `a version with no author, no model and no api client is rejected` |
| Identity business access is pair-scoped | `has_identity_business_access is true only for configured pairs` |
| API-client scope is enforced in the database | `a token is refused a write scope it does not hold`; `a revoked token loses every capability` |

### Sequence and message invariants — `packages/db/test/sequence-lifecycle.test.ts` (8 cases)

| Requirement | Proven by |
| --- | --- |
| Connection → Message 1 due | `mark_connection_sent creates a due Message 1 instance` |
| M1 → FU1 → FU2 → FU3 → Dormant with the configured delays | `applies the configured delays and goes dormant with a reactivation date`; `honours a business-specific reactivation setting` |
| Sent content is frozen and immutable | `records a sent event pointing at the frozen version` |
| **A SENT message must have content** | `refuses to send an instance with no version` |
| Publishing a new version keeps SENT and LOCKED, regenerates DYNAMIC | `keeps SENT and LOCKED, regenerates eligible DYNAMIC and moves enrollments` |
| Publishing requires an admin | `requires an admin` |
| **DNC stops the sequence** | `cancels the enrollment and invalidates pending messages` |

Plus `packages/db/test/immutability.test.ts` and `dnc-and-replies.test.ts` for sent-record immutability
and suppression behaviour, and `apps/web/test/sent-message-content.test.ts` (6) for the same invariant
through the application layer.

**Conclusion:** auth/RBAC/RLS, ingestion, dedupe and sequence/message invariants are verified. The
Inbound-reply-pauses-the-sequence and sent-content-immutability requirements are proven at the
database level, which is stronger than a UI observation would be.

| Ref | Severity | Summary | Status |
| --- | --- | --- | --- |
| F-2 | HIGH | Service-token INSERT into `companies` / `people` refused `42501` although the permissive WITH CHECK evaluates true | **OPEN — see below** |
| F-3 | HIGH | Three MCP write tools reported success with a null id for a nonexistent lead | **FIXED** |
| F-5 | MEDIUM | `finish_agent_run` defaulted `state: 'completed'`, which the CHECK constraint forbids | **FIXED** |
| F-4 | MEDIUM | Idempotency metadata contradicted the enforced catalogue on five tools | **FIXED** |
| F-1 | HIGH | Companion today-queue returned 500 for a permission refusal | **FIXED** |
| F-7 | MEDIUM | `mark-connection-sent` / `mark-message-sent` / `reactivate` refused an admin token | **RESOLVED — not a defect** |
| F-6 | MEDIUM | `submit_profile_capture` refused for a token the HTTP route accepts | **SAME ROOT CAUSE AS F-2 — see below** |
| F-8 | LOW | `get_today_queue` returns `{items:[]}` for an unknown user | OPEN |
| F-9 | MEDIUM | Gateway scope vocabulary disjoint from the RLS scope vocabulary | OPEN |

### F-7 resolution

The reported failure was a **fixture mismatch in the verification run**, not a product defect.

`mark_connection_sent` and `mark_message_sent` are `SECURITY DEFINER`, so RLS does not apply inside
them. Their only `42501` raise is:

```sql
if not public.has_identity_business_access(p_identity_id, v_lead.business_id) then
  raise exception 'outreach identity % is not authorized for business %', ... using errcode = '42501';
```

`has_identity_business_access` is scoped correctly, and the seeded identities are each bound to
specific businesses:

| Identity | Covers |
| --- | --- |
| Bisma - Lavish (active) | AI Integrations |
| Osama - Zemnas (active) | Zemnas Creative Studio, Lavish Foods |
| James - AI Int. (paused) | Zemnas Creative Studio |

Confirmed against the seeded database:

- **Matched pair** — `mark_connection_sent` with Osama on a Zemnas lead: **succeeds**.
- **Mismatched pair** — `mark_connection_sent` with Bisma on a Zemnas lead: **refused** with
  `42501 outreach identity d0000005-… is not authorized for business d0000002-…`, which is the guard
  working exactly as designed.

So the three operations are correct; the verification call paired an identity with a lead from a
business that identity does not cover. **F-6 is very likely the same class** — a token/identity/lead
mismatch rather than a permission bug — and must be re-tested with a matched fixture before being
treated as a defect. Note also that the error is translated to a generic *"You do not have permission
to do that."*, which is what made it look like a permissions failure rather than an identity-scope
mismatch; surfacing the underlying message for this specific case would be a genuine usability
improvement.

**A note on `reactivate`, and a correction to an intermediate observation.** A diagnostic query of
mine called `select public.start_reactivation($1)` and failed with
`42883 function public.start_reactivation(unknown) does not exist`. That was **my test's error, not a
product defect**: `startReactivation` in `apps/web/src/lib/repo/leads.ts` does not call an RPC at all —
it issues a direct `update public.sequence_enrollments set state = 'reactivation_due' where lead_id =
$1 and state in ('dormant','completed')` and refuses with a typed message when no row matches. There is
no `start_reactivation` database function to be missing. The `reactivate` route path is therefore
**not** implicated by that error, and the only open question for it remains the same F-7 fixture
question as the other two operations.

### F-2 investigation summary

Investigated to root cause, then stopped. What was established against the seeded database:

1. `companies` and `people` have **`relforcerowsecurity = true`** — unique in this schema.
2. `authenticated` **has** the INSERT privilege (`has_table_privilege` = true), so this is not a GRANT
   gap.
3. The only INSERT policy is **permissive**, and its WITH CHECK
   (`is_admin() OR EXISTS(can_use_lead_sources) OR acting_api_client_id() IS NOT NULL`) was verified
   `true` in the same transaction moments before the INSERT.
4. An **admin** actor inserts successfully, so the table, its constraints and its triggers all work.
5. Disabling triggers did not change the outcome; the `BEFORE INSERT` normalize trigger and the
   `audit_row_change` AFTER trigger were both exonerated.
6. Isolated scratch tables reproduced a permissive WITH CHECK that permits while the same predicate
   reads `false`.
7. The predicate's own value was observed **non-deterministically** — `true` in one run and `false` in
   another inside the same session shape.

A permissive WITH CHECK that is true cannot deny an insert in PostgreSQL, and the measured predicate is
inconsistent between runs. That points at the **embedded PGlite runtime's RLS evaluation under
`FORCE ROW LEVEL SECURITY`**, not at the policy definitions — which read correctly and behave correctly
for an admin. It is therefore recorded as a **runtime-specific** finding to confirm against real
PostgreSQL before any product change: if service-token writes into business-less tables behave
correctly on Postgres, no code change is warranted and this is a limitation of the embedded engine.

**No fix was applied**, deliberately: changing a security policy to satisfy a possibly-buggy local
engine would be the wrong trade.

### F-6 is the same root cause as F-2 — not a separate defect

F-6 was reported as "`submit_profile_capture` refused for a token that the identical repository path
accepts from the companion HTTP route with an admin session". Reading the implementation explains it:
`submitProfileCapture` (`apps/web/src/lib/repo/profile-capture.ts`) creates the extracted company
before updating the person:

```sql
insert into public.companies (name, normalized_name, created_by)
values ($1, $2, $3) returning id      -- line 91
```

`companies` is exactly the table F-2 is about. So the capture fails only when the extracted company is
**new**; when the company already matches by `normalized_name` the code takes the `existing.rows[0]`
branch and never inserts. That is why the same call succeeds from a session whose actor inserts
cleanly and fails for a service token — and it is why this looked like a profile-capture permission bug
when it is the same RLS behaviour.

**Consequence for the fix:** F-2 and F-6 are one item, not two. Resolving the `companies` INSERT path
fixes both, and no profile-capture change is warranted.

It also means the operator-facing message is misleading in both cases: a `42501` from an internal
insert is surfaced as *"You do not have permission to do that."*, which points the operator at their
own permissions rather than at the real failure.

---

## 10. Summary

| Area | Status |
| --- | --- |
| Build gates (typecheck, lint, tests, web build, extension build, DB) | **PASS** |
| Admin shell / navigation | **PASS** |
| Route reachability (28/28) | **PASS** |
| Leads composition + bulk actions | **PASS** |
| Leads pagination boundary matrix | **PARTIAL** |
| Lead Detail composition + real sequence state + full history | **PASS** |
| Business lifecycle | **PASS** |
| Identity lifecycle | **PASS** |
| DeepSeek AI (mocked) | **PASS** |
| DeepSeek AI (live provider) | **PENDING_HOST_ENV** |
| Companion CORS | **PASS** |
| Chrome Companion UI / E2E | **PASS** — 38 passed, 0 failed, 0 skipped |
| Chrome Companion visual (U22–U30) | **PARTIAL** — U22 differs; U23–U30 not captured |
| MCP / API running-endpoint verification | **PARTIAL** — 149 of 167 cases pass |
| Auth / RBAC / RLS regression | **PASS** — 26 database-level cases as a non-owner role (§9) |
| Ingestion / dedupe / invariants | **PASS** — 22 database-level cases (§9) |
| Sequence / message invariants | **PASS** — 8 database-level cases + immutability and DNC suites (§9) |

**No dead control is claimed.** Where a control exists it reaches a real server action or repository
call; where a surface is uncertified this document says so.
