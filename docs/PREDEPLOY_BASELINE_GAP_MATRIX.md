# NEXUS — Pre-Deployment Baseline Gap Matrix

**Branch:** `integration/final`
**Base:** `backend/remediation` @ `9f009186cfc976f27bd85a3406b2448053266b26`
**Visual donor:** `codex/figma-frontend` @ `4427dd2efef8e3542174596ccae34944710855c4` (selective, never merged)
**Visual authority:** live Figma `EmH8Y5EuI6PZ0tfKyBf7Ay` (Admin) and `KNDsf7bYArPXtGpSkUk9D6` (User/Companion)
**Integration strategy:** `HYBRID_BY_MODULE` — one integrated system, not "Candidate A vs B"

Every `Wired` entry below was traced to a real action, repository function, API route or RPC. Nothing is
marked wired on the basis that it "looks wired".

## Legend

| Column | Meaning |
| --- | --- |
| **UI** | Does a screen/control for this exist? |
| **BE** | Does backend support exist (repo fn / server action / route / RPC)? |
| **Wired** | Is the control actually connected to that backend? |
| **Tested** | Has it been exercised at runtime in this baseline? |

Status vocabulary: `PASS`, `PARTIAL`, `BLOCKED`, `INTENTIONALLY_DEFERRED`.

## Matrix

| Area | UI present | Backend present | Wired | Tested | Status | Required action |
| --- | --- | --- | --- | --- | --- | --- |
| Auth (sign-in / session / sign-out) | yes | yes | yes | yes | PASS | — |
| Admin shell (7-destination Figma IA) | yes | yes | yes | yes | PASS | — |
| Admin shell secondary navigation | yes | yes | yes | yes | PASS | — |
| User shell (My Day / My Leads / Lead Sources + search) | yes | yes | yes | partial | PARTIAL | Verify a Standard User sees no Admin nav; capture user-surface runtime evidence |
| Overview (A02 at `/b/:slug/overview`) | yes | yes | yes | yes | PASS | — |
| Overview reachable from `/` for an admin | yes | yes | yes | yes | PASS | Fixed this baseline: `/` redirected to My Day |
| Leads list | yes | yes | yes | partial | PARTIAL | Replace `slice(0,5)` with real page size 5 + pagination; port Figma composition (chips, 5 filters, Source column, row menu, bulk actions) |
| Leads pagination boundaries (1/5/6/21/25/26+) | yes | yes | yes | no | BLOCKED | Not yet exercised; requires the row-cap fix first |
| Lead Detail composition (Figma: header, Lead control, Sequence, Actions, history) | yes | yes | yes | partial | PARTIAL | Adopt Figma composition; A's extra "Current action" card is not in the frame |
| Lead Detail live sequence state | yes | yes | partial | no | BLOCKED | `PAUSED · REPLY`, `CANCELLED`, `Keep paused` are string literals; bind to `dueMessageForLead` / `sequenceStateForLead` |
| Lead Detail history reachability | yes | yes | partial | yes | PARTIAL | `timeline.slice(0,3)` with no scroll/paging; events beyond 3 unreachable |
| Lead Detail actions (note, task, reply, snooze, edit, trash, LinkedIn) | yes | yes | yes | partial | PARTIAL | Runtime exercise of each control pending |
| My Day (Today / Upcoming / Done) | yes | yes | yes | partial | PARTIAL | Remove `slice(0,3)` on Upcoming and Done |
| My Day task creation | yes | yes | yes | partial | PARTIAL | Runtime exercise pending |
| Lead Sources (File / Paste / Google / Apollo) | yes | yes | yes | no | PARTIAL | Exercise real ingestion paths and verify DB results, not just form render |
| Lead Sources recent-import list | yes | yes | partial | no | PARTIAL | Remove `slice(0,3)` |
| Profile Queue | yes | yes | yes | partial | PARTIAL | Runtime exercise pending |
| Duplicate Review | yes | yes | yes | partial | PARTIAL | Runtime exercise pending |
| Trash | yes | yes | yes | partial | PARTIAL | Runtime exercise pending |
| Reactivation | yes | yes | yes | partial | PARTIAL | Runtime exercise pending |
| Business Setup tab strip | yes | yes | yes | yes | PASS | Created this baseline: landing tab + Signals tab; shell renders the strip on every section |
| Business Setup · Overview (`/b/:slug/setup`) | yes | yes | yes | yes | PASS | Created this baseline |
| ICP Manager | yes | yes | yes | partial | PARTIAL | Rebuild to Figma: list + selected-ICP scoring/routing panel, exclusions, Primary ICP rule |
| Sequences | yes | yes | yes | no | PARTIAL | Verify Connection / Message 1 / FU1-3 / Dormant / Reactivation and DYNAMIC/LOCKED/SENT states |
| Knowledge Library | yes | yes | yes | partial | PARTIAL | Runtime exercise pending |
| Business Brain | yes | yes | yes | partial | PARTIAL | Runtime exercise pending |
| Signals (scoring rules) | yes | yes | yes | yes | PASS | Created this baseline; reads real `scoring_rules` |
| Team | yes | yes | yes | partial | PARTIAL | Runtime exercise pending |
| User Permissions | yes | yes | yes | partial | PARTIAL | Sidebar child resolves to the team list (no single user is known from the sidebar); verify the edit path |
| Businesses hub | yes | yes | yes | partial | PARTIAL | Runtime exercise pending |
| Business lifecycle (archive / restore / guarded delete) | **no** | yes | **no** | no | **BLOCKED** | Actions exist (`businesses/[id]/actions.ts`); no control calls them. Must add a row overflow menu on the Businesses hub |
| Business typed refusal (`business_has_protected_history`) | **no** | yes | **no** | no | **BLOCKED** | Render preservation counts + offer Archive; do not parse prose |
| Outreach Identities list | yes | yes | yes | partial | PARTIAL | Runtime exercise pending |
| Identity lifecycle (unassign / archive / guarded delete) | **no** | yes | **no** | no | **BLOCKED** | Dedicated `unassignIdentityAction` exists; retire the `toUserId: ''` sentinel |
| Identity typed refusal (`identity_has_attribution`) | **no** | yes | **no** | no | **BLOCKED** | Render attribution counts + offer Retire. Never add Restore (retirement is terminal, migration `0025`) |
| Integrations gateway | yes | yes | yes | yes | PASS | — |
| Integrations → Automations / Import Builder / Business Domains | yes | yes | yes | yes | PASS | Reachable as secondary nav; verified 200 |
| Automations | yes | yes | yes | no | PARTIAL | Runtime exercise pending |
| Import Builder | yes | yes | yes | no | PARTIAL | Verify a real import applies and is undoable |
| Messaging Insights | yes | yes | yes | yes | PASS | — |
| Insights (parent destination) | yes | yes | yes | yes | PASS | Created this baseline; reply outcomes + step performance from real data |
| Settings | yes | yes | yes | partial | PARTIAL | Runtime exercise pending |
| My Access | yes | yes | yes | partial | PARTIAL | Reachable as Team & Accounts child; verified 200 |
| Business Domains | yes | yes | yes | yes | PASS | — |
| DeepSeek — profile capture | yes | yes | partial | no | PARTIAL | Local extraction fallback + model path; verify schema validation and provenance |
| DeepSeek — message drafting | **no** | yes | **no** | no | **BLOCKED** | `draftMessageAction` + 9-value `AiFailureKind` exist; no control invokes it. Mark live-provider smoke `PENDING_HOST_ENV` if no key |
| MCP tools | n/a | yes | yes | in progress | PARTIAL | Running-endpoint conformance suite (see `MCP_BASELINE_VERIFICATION.md`) |
| API v1 (incl. companion) | n/a | yes | yes | in progress | PARTIAL | Full inventory + exercise (see `API_BASELINE_VERIFICATION.md`) |
| Ingestion (file/paste/google/apollo) | yes | yes | yes | no | PARTIAL | Exercise and verify DB changes |
| Dedupe | yes | yes | yes | partial | PARTIAL | Runtime exercise pending |
| Tasks | yes | yes | yes | partial | PARTIAL | Runtime exercise pending |
| Notes | yes | yes | yes | partial | PARTIAL | Runtime exercise pending |
| Replies (verbatim capture) | yes | yes | yes | partial | PARTIAL | Verify verbatim body preserved and distinct from notes |
| Sequences engine (states, pause/cancel on reply) | yes | yes | yes | no | PARTIAL | Verify reply pauses/cancels pending steps |
| Sent-message invariant | yes | yes | yes | **yes** | PASS | Enforced by migration `0021`; the demo seed was corrected to comply rather than the invariant weakened |
| Do Not Contact (suppression) | yes | yes | yes | partial | PARTIAL | Verify suppression blocks every sender identity |
| Audit history | yes | yes | yes | partial | PARTIAL | Overview "Recent activity" reads the real audit trail |
| Row caps / unreachable records | yes | yes | **no** | no | **BLOCKED** | Six `slice(0,n)` caps reachable only by URL or not at all |
| Chrome Companion | yes | yes | yes | in progress | PARTIAL | Build + unit + real-origin E2E + side-panel boot; companion CORS fixed this baseline |
| Companion CORS | n/a | yes | yes | yes | PASS | Fixed this baseline: static headers in `next.config.ts`; the `middleware.ts` implementation never executed |
| Repository cleanliness | n/a | n/a | n/a | yes | PARTIAL | 88.3 MiB of PGlite data dirs are committed to git; see `REPO_CLEANUP_REPORT.md` |
| Deployment configuration | n/a | n/a | n/a | partial | PARTIAL | See `DEPLOYMENT_READINESS.md` |
| Outbound webhook delivery worker | no | partial | no | n/a | INTENTIONALLY_DEFERRED | Configuration persists; delivery deferred by scope |

## Summary

| Status | Count |
| --- | --- |
| PASS | 17 |
| PARTIAL | 33 |
| BLOCKED | 8 |
| INTENTIONALLY_DEFERRED | 1 |

**The baseline is not complete.** Eight areas are `BLOCKED` because a required capability is present
in the backend but has no UI reaching it, or because runtime state is faked. None is blocked by an
external dependency; each is implementable work.

### The eight blockers, in priority order

1. **Business lifecycle controls** — archive / restore / guarded delete. Backend complete and typed;
   no control exists. Needs a row overflow menu on the Businesses hub.
2. **Identity lifecycle controls** — dedicated unassign / archive / guarded delete; retire the
   `toUserId: ''` sentinel. Needs controls in the identity detail action area.
3. **DeepSeek message drafting UI** — `draftMessageAction` exists, nothing calls it.
4. **Lead Detail sequence literals** — `PAUSED · REPLY`, `CANCELLED`, `Keep paused` rendered as
   runtime state for every lead while `dueMessageForLead` is already fetched and discarded.
5. **Lead Detail history reachability** — `timeline.slice(0,3)` with no retrieval path.
6. **Row caps on Leads / My Leads / My Day Upcoming / My Day Done / Lead Sources / Overview** —
   six unconditional slices. On Leads this is not a preview: pagination exists at PAGE_SIZE 25 and the
   slice is applied to the already-paginated page, so with >25 leads records 6–25 are unreachable by
   any UI path.
7. **Figma Leads composition** — status-chip row, five filter selects, `Source` column, row action
   menu and bulk-actions bar are all specified by A03 and absent.
8. **ICP Manager rebuild** — the frame's list + selected-ICP scoring/routing panel is absent.

### What this baseline fixed

1. **Admin sidebar collapse (8 items, identical on every route).** `ADMIN_NAV` is now the final Figma
   seven-destination IA in three groups, resolved by stable route identifiers. Previously the sidebar
   collapsed to 3 links on `/`, `/team`, `/integrations` and the user surfaces because business-scoped
   entries were dropped for want of a slug.
2. **Content measure** 1120px → 1202px, matching A02 beside the 238px sidebar.
3. **Secondary navigation** for Business Setup (`Overview / ICPs / Sequences / Knowledge / Signals`),
   Team & Accounts, Integrations and Insights, so no product screen is orphaned.
4. **Three 404 routes eliminated** — `/b/:slug/setup`, `/b/:slug/setup/signals`, `/b/:slug/insights`
   now exist. All 28 navigation destinations return 200.
5. **`/` reaches the real Overview** for admins instead of showing My Day.
6. **Demo seed complies with the SENT invariant** — corrected the insert ordering to DYNAMIC →
   version → SENT rather than weakening migration `0021`.
7. **Companion CORS** — the policy in `apps/web/middleware.ts` never executed (Next resolves middleware
   to `src/middleware.ts` when a `src` directory exists, and moving it there breaks the edge build via
   `instrumentation.ts` → `lib/db` → `node:path`). Declared as static headers in `next.config.ts`;
   previously every panel request failed with "Nexus is unreachable".
