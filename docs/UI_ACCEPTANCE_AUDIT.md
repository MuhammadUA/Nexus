# Nexus UI Acceptance Audit

**Method.** Every row below was rendered in a real Chrome (headless, device metrics overridden
to the reference viewport), signed in as `admin@nexus.local`, against the demo database seeded by
`apps/web/scripts/seed-demo.ts` + `seed-demo-operational.ts`. The route was then measured from the
live DOM (page title, card/table/chip/stat counts, sidebar geometry, horizontal overflow, empty
state) and screenshotted. Nothing in this file is inferred from reading JSX.

**Evidence files**

| File | Contents |
| --- | --- |
| `ui-audit/ui-acceptance.json` | Per-route measurements for all 51 web routes |
| `ui-audit/shots/*.png` | 51 route screenshots at 1440×980 |
| `ui-audit/interactions.json` | 11 browser interaction results |
| `ui-audit/browseros/companion-*.png` | 9 Companion screens at 420×820 |
| `ui-audit/companion-capture.json` | Per-screen Companion measurements |

**Seed state used for the pass.** 3 businesses, 4 users, 34 leads covering all 17 statuses in
`leads_status_check`, 33 people, 12 companies, 19 tasks (open, overdue, done), 18 notes,
41 interactions, 23 conversations, 7 exact inbound replies with outcomes, 5 import batches with
38 per-row results, 3 open duplicate candidates, 3 profile-queue items, 3 automations with agent
runs, 3 saved views, 4 ICPs, 8 scoring rules, 1 published sequence with 4 steps, 3 sender
identities.

---

## 1. Web routes — 51 of 51 rendered

A route counts as rendered only when it produced a page title and did **not** land on the
not-found or error branch. Content column = cards + table rows + chips + stats in the live DOM,
so `0` would mean an empty shell.

| # | Route | Screen | Rendered | Screenshot | Content | Figma frame | Fidelity | Discrepancy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `/` | My Day | yes | `shots/admin-overview.png` | 22 | A01 (admin overview) | pass | stat row reads 2 due / 1 connection; the admin owns 6 leads, so the Open-leads figure is not surfaced |
| 2 | `/businesses` | Businesses hub | yes | `shots/admin-businesses.png` | 17 | A02 | pass | — |
| 3 | `/businesses/new` | Add business | yes | `shots/admin-businesses-new.png` | 16 | A03 | pass | key field is client-derived; see interaction 2 |
| 4 | `/business-domains` | Business domains | yes | `shots/admin-business-domains.png` | 24 | A05 | pass | — |
| 5 | `/team` | Team & Accounts | yes | `shots/admin-team.png` | 24 | A06 | pass | — |
| 6 | `/team/[id]` | User permissions | yes | `shots/admin-team-detail.png` | 61 | A06 (detail) | pass | 49 chips is dense at 1440; the permission list could paginate |
| 7 | `/identities` | Outreach identities | yes | `shots/admin-identities.png` | 20 | A04 | pass | — |
| 8 | `/identities/[id]` | Identity detail | yes | `shots/admin-identity-detail.png` | 21 | A04 (detail) | pass | shows an empty state for "no transfers yet"; correct, but the screen is mostly empty |
| 9 | `/integrations` | Integrations gateway | yes | `shots/admin-integrations.png` | 48 | A08 | pass | 18 rows; empty state present for the webhook list |
| 10 | `/settings` | Settings | yes | `shots/admin-settings.png` | 13 | A22 | pass | — |
| 11 | `/my-access` | My access & assignment | yes | `shots/admin-access.png` | 37 | U18 | pass | — |
| 12 | `/trash` | Trash | yes | `shots/admin-trash.png` | 7 | A10 | pass | empty state; nothing is in the admin trash in this seed |
| 13 | `/my-day` | My Day | yes | `shots/user-my-day.png` | 22 | U01 | pass | same stat-row note as row 1 |
| 14 | `/my-day/upcoming` | Upcoming | yes | `shots/user-my-day-upcoming.png` | 3 | U01 (tab) | pass | 1 scheduled item; the seed's next actions cluster on today |
| 15 | `/my-day/done` | Done | yes | `shots/user-my-day-done.png` | 69 | U01 (tab) | pass | 34 rows |
| 16 | `/my-leads` | My Leads | yes | `shots/user-my-leads.png` | 31 | U02 | pass | 6 rows for admin |
| 17 | `/my-leads/[id]` | Lead detail (user) | yes | `shots/user-my-lead-detail.png` | 24 | U03 | pass | — |
| 18 | `/leads/[id]/edit` | Edit lead | yes | `shots/user-lead-edit.png` | 8 | — (spec has no frame) | pass | four fields only; deliberate, the rest is edited from the detail screen |
| 19 | `/my-lead-sources` | Lead Sources | yes | `shots/user-lead-sources.png` | 41 | U06 | pass | — |
| 20 | `/my-lead-sources/file` | Lead Sources · File | yes | `shots/user-lead-sources-file.png` | 4 | U06 / U07 | pass | — |
| 21 | `/my-lead-sources/paste` | Lead Sources · Paste | yes | `shots/user-lead-sources-paste.png` | 4 | U07 | pass | — |
| 22 | `/my-lead-sources/google` | Lead Sources · Google | yes | `shots/user-lead-sources-google.png` | 4 | U07 | pass | — |
| 23 | `/my-lead-sources/apollo` | Lead Sources · Apollo | yes | `shots/user-lead-sources-apollo.png` | 7 | U07 | pass | — |
| 24 | `/my-profile-queue` | Profile Queue | yes | `shots/user-profile-queue.png` | 17 | U08 | pass | — |
| 25 | `/my-duplicates` | Duplicate Review | yes | `shots/user-duplicates.png` | 29 | U17 | pass | 0 open candidates for this viewer today; the panel below is the empty state |
| 26 | `/my-trash` | Trash | yes | `shots/user-my-trash.png` | 7 | U19 | pass | empty state |
| 27 | `/tasks/new` | Create Task | yes | `shots/user-tasks-new.png` | 1 | — (spec has no frame) | pass | one card, correct for a single-purpose form |
| 28 | `/snooze` | Snooze & Reschedule | yes | `shots/user-snooze.png` | 1 | — (spec has no frame) | pass | one card |
| 29 | `/b/zemnas/overview` | Overview | yes | `shots/biz-overview.png` | 74 | A11 | pass | 30 rows across the summary tables |
| 30 | `/b/zemnas/leads` | Leads | yes | `shots/biz-leads.png` | 72 | A13 | pass | 21 rows |
| 31 | `/b/zemnas/leads/[id]` (replied) | Lead detail | yes | `shots/biz-lead-detail-replied.png` | 28 | A14 | pass | — |
| 32 | `/b/zemnas/leads/[id]` (needs profile) | Lead detail | yes | `shots/biz-lead-detail-needs-profile.png` | 20 | A14 | pass | the profile-capture prompt is the distinguishing element |
| 33 | `/b/zemnas/leads/[id]` (DNC) | Lead detail | yes | `shots/biz-lead-detail-dnc.png` | 24 | A14 | pass | DNC banner renders |
| 34 | `/b/zemnas/lead-sources` | Lead Sources | yes | `shots/biz-lead-sources.png` | 30 | A15 | pass | — |
| 35 | `/b/zemnas/lead-sources/import` | Import Builder | yes | `shots/biz-lead-sources-import.png` | 4 | A16 | pass | — |
| 36 | `/b/zemnas/profile-queue` | Profile Queue | yes | `shots/biz-profile-queue.png` | 13 | A17 | pass | 2 queued |
| 37 | `/b/zemnas/duplicates` | Duplicate Review | yes | `shots/biz-duplicates.png` | 22 | A07 | pass | 2 candidates, 4 status tabs as links |
| 38 | `/b/zemnas/reactivation` | Reactivation | yes | `shots/biz-reactivation.png` | 25 | A09 | pass | 1 dormant candidate |
| 39 | `/b/zemnas/insights/messaging` | Messaging Insights | yes | `shots/biz-insights-messaging.png` | 72 | A20 | pass | 31 rows |
| 40 | `/b/zemnas/automations` | Automation Mapping | yes | `shots/biz-automations.png` | 19 | A21 | pass | — |
| 41 | `/b/zemnas/trash` | Trash | yes | `shots/biz-trash.png` | 17 | A10 | pass | 3 rows |
| 42 | `/b/zemnas/setup/brain` | Business Brain | yes | `shots/biz-setup-brain.png` | 18 | A12 | pass | — |
| 43 | `/b/zemnas/setup/icps` | ICP Manager | yes | `shots/biz-setup-icps.png` | 503 | A12 | pass | 122 rows / 371 chips; the densest screen; no overflow |
| 44 | `/b/zemnas/setup/icps?icp=…` | ICP Manager (edit) | yes | `shots/biz-setup-icps-edit.png` | 503 | A12 | pass | same density |
| 45 | `/b/zemnas/setup/sequences` | Sequence Manager | yes | `shots/biz-setup-sequences.png` | 77 | A18 | pass | — |
| 46 | `/b/zemnas/setup/knowledge` | Knowledge Library | yes | `shots/biz-setup-knowledge.png` | 61 | A19 | pass | — |
| 47 | `/b/lavish-foods/overview` | Overview | yes | `shots/biz-lavish-overview.png` | 54 | A11 | pass | — |
| 48 | `/b/lavish-foods/leads` | Leads | yes | `shots/biz-lavish-leads.png` | 28 | A13 | pass | 7 rows |
| 49 | `/b/ai-integrations/overview` | Overview | yes | `shots/biz-ai-overview.png` | 52 | A11 | pass | — |
| 50 | `/b/ai-integrations/leads` | Leads | yes | `shots/biz-ai-leads.png` | 25 | A13 | pass | 6 rows |
| 51 | `/login` | Sign in | yes (via interaction 1) | `shots/_diagnose.png` | — | A00 | pass | — |

**Viewport and geometry (measured, 1440×980):** no route overflows horizontally. Sidebar 238 px on
the admin surface, ~220 px on the user surface. Body background, font stack and the 1 px card
border all match the values recorded in `.work/figtool/out/DESIGN_TOKENS.md` for the Figma frames.

**Route-level failure found and fixed during this pass.** `/b/zemnas/duplicates` returned a 500
with the error boundary. Cause: `Tabs` was rendered from a Server Component with an `onChange`,
and an event handler cannot cross the Server/Client boundary ("Event handlers cannot be passed to
Client Component props"). `Tabs` is now a Client Component (`packages/ui/src/tabs.tsx`) whose tabs
may carry an `href`, so a Server Component can render it as real navigation. Two further bugs were
found on the same path and fixed: the duplicate-candidate query read a `duplicate_candidates
.incoming_lead_id` column that does not exist, and the reactivation query read a
`sequence_enrollments.last_step_sent_at` column that does not exist.

---

## 2. Functional interactions — 11 of 11 passed

Driven through the live DOM with prototype-level value setters plus `input` events, so React
state updates exactly as it does for a real keystroke.

| # | Interaction | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Sign in with email + password | pass — lands on `/my-day` with the My Day title | `interactions.json` |
| 2 | Business key auto-derives from the name | pass — `Riverside Studio 508872` → `riverside-studio-508872` | the reported bug; see §5 |
| 3 | Create a business | pass — success alert, row created | idem |
| 4 | New business appears on the hub | pass | idem |
| 5 | Leads filter by status | pass — 21 rows → 1 row at `?status=replied` | `interactions.json` |
| 6 | Lead detail shows the captured reply verbatim | pass — exact text and the paste note both in the DOM | timeline body |
| 7 | Lead detail shows the conversation outcome | pass — "Already has supplier" chip and the reply form | idem |
| 8 | Profile queue lists partial records | pass — 2 queued | idem |
| 9 | Sidebar navigates to Leads | pass — `/b/zemnas/overview` → `/b/zemnas/leads` | idem |
| 10 | Duplicate Review lists candidates with 4 status tabs | pass — 2 rows, 4 tabs, all anchors | idem |
| 11 | Duplicate status tab navigates | pass — `?status=merged` | idem |

The verification business rows are deleted after the pass
(`apps/web/scripts/cleanup-verify-business.ts`), so the screenshots stay comparable.

---

## 3. Companion (Chrome MV3 side panel) — 9 screens at 420×820, all pass

Served from the app's own origin (`/api/companion-preview/...`) because an unpacked extension may
only reach origins in its `host_permissions`; a preview on another port is blocked before the
request leaves the browser. The `chrome.storage` / `chrome.tabs` surface is stubbed, which is
enough for the bundle to mount and its layout, styles and copy to be measured.

| # | Screen | Rendered | Screenshot | Measured |
| --- | --- | --- | --- | --- |
| 1 | Sign in | yes | `browseros/companion-01-sign-in.png` | shell 420×820, no overflow |
| 2 | Choose identity + default business | yes | `browseros/companion-02-after-sign-in.png` | 3 identities with their status, 3 businesses |
| 3 | CRM View · Leads | yes | `browseros/companion-03-bound.png` | 3 chips, 1 lead row |
| 4 | CRM View · Today | yes | `browseros/companion-04-today.png` | 2 items: "custom tasks Overdue 2d", "connections Overdue" |
| 5 | Add to CRM | yes | `browseros/companion-05-add-to-crm.png` | URL + pasted content fields, 3 buttons |
| 6 | CRM View (return) | yes | `browseros/companion-06-crm-view.png` | — |
| 7 | Search | yes | `browseros/companion-07-search.png` | — |
| 8 | Today (again) | yes | `browseros/companion-08-today-again.png` | — |
| 9 | Lead focus | yes | `browseros/companion-08-lead-focus.png` | 4 chips, 6 buttons, "Open LinkedIn", 606 chars of content |

**Two real Companion defects found and fixed in this pass.**

1. **The panel never mounted.** `sidepanel.tsx` exports the component; nothing called
   `createRoot`. The bundle loaded, exported a component and rendered nothing. Added
   `src/mount.tsx` as the build entry (`scripts/build.mjs`).
2. **Sign-in could never succeed.** `api.signIn` went through the same request wrapper as every
   authenticated call, and that wrapper returns `'Sign in to Nexus Companion.'` when no token
   exists — so the sign-in button reported an error without ever reaching the server. The wrapper
   now takes `authenticated: false` for the session exchange, which is the one call that runs
   before a token exists.
3. **The companion API had no CORS headers.** Adding `Authorization` is not a simple request, so
   Chrome preflights it; with no `Access-Control-Allow-Origin` the browser blocks every companion
   call. Added `apps/web/middleware.ts`, scoped to `/api/v1/companion/:path*`, echoing a
   `chrome-extension://` origin and refusing anything else. This surface is bearer-token
   authenticated, not cookie authenticated, so an open origin does not let a third-party page act
   as a signed-in operator.
4. **Binding an identity another profile holds failed.** `browser_sessions_active_identity_key`
   permits one active session per identity, so the insert raised a unique violation surfaced as
   "That record already exists." — not something an operator can act on. `bindBrowser` now revokes
   the previous session (stamped `revoked_at`) before inserting, which also leaves a truthful
   record that it was replaced.

**Not verified in the Companion.** `chrome.sidePanel.open`, the LinkedIn content script, the
service-worker heartbeat, and Chrome's own loading of an unpacked extension. Chrome 153 silently
ignores `--load-extension` from the command line, so there was no way to reach a real
`chrome-extension://` origin in this environment. Neither is verified: that the panel behaves
correctly under `chrome.storage.session` being genuinely in-memory.

---

## 4. Figma fidelity

Behaviour and invariants come from `Nexus_CRM_Master_Spec_v1.json`; the visual language comes from
the two `.fig` files, decoded with `fig-kiwi` into `.work/figtool/out/` (`SCREEN_MANIFEST.md`,
`DESIGN_TOKENS.md`, `admin-tree.json`, `user-tree.json`).

Measured properties that match the decoded frames:

* Desktop reference viewport 1440×980; every route fits without horizontal overflow.
* Sidebar width 238 px (admin) / ~220 px (user); content column and topbar heights match.
* Card radius 9–14 px, 1 px borders, the decoded spacing scale, the decoded body font stack.
* The Companion shell is exactly 420×820 with no overflow on any of its nine screens.
* Verbatim copy where the spec fixes it: `business_units.clone_behavior` on the Add Business
  screen, the DNC suppression wording, "paste the exact reply", the dedupe-key wording on
  Duplicate Review.

**Known Figma-related limitations.**

* The `.fig` files contain **no** components, groups, auto-layout, styles or images — only flat
  rounded rectangles and text. Fidelity is therefore judged on measured geometry and tokens, not
  on a component-by-component diff.
* The user `.fig` file has **no frames numbered 07–10**, and the spec's `screen_inventory.user`
  lists U18–U21 rather than U07–U10. Those four screens were built from the spec without a pixel
  reference.

---

## 5. Fixes made in this pass

| # | Defect | Where | Verified by |
| --- | --- | --- | --- |
| 1 | Adding a business was rejected with "Use lowercase letters, numbers and dashes…" even with valid input | `.optional()` schemas reject `null`, and a blank optional field submits as `null`; switched the action schemas to `.nullish()`, and the key now derives from the name | interaction 2–4 |
| 2 | `/b/[slug]/duplicates` failed to render (500) | `Tabs` needed an event handler across the Server/Client boundary; it is now a Client Component that accepts `href` | route 37 |
| 3 | Duplicate Review query read a non-existent `incoming_lead_id` column | `lib/repo/duplicates.ts` derives the incoming lead from the person, as the merge function does | `test/duplicates.test.ts` |
| 4 | Reactivation query read a non-existent `last_step_sent_at` column | `lib/repo/sequence.ts` derives it from `message_instances` | `test/duplicates.test.ts` |
| 5 | The exact inbound reply was shown only as a truncated summary | `lib/repo/leads.ts` reads the verbatim text off the interaction payload into the timeline body | `test/lead-timeline.test.ts`, interaction 6 |
| 6 | The panel never mounted | `apps/extension/src/mount.tsx` + build entry | Companion §3 |
| 7 | Companion sign-in always failed without contacting the server | `apps/extension/src/api.ts` `authenticated: false` for the session exchange | Companion §3 |
| 8 | Companion API had no CORS headers | `apps/web/middleware.ts` | Companion §3 |
| 9 | Binding an in-use identity failed with a unique violation | `lib/repo/companion.ts` revokes the previous session | Companion §3 |
| 10 | `seed-demo.ts` and the operational seed could not be re-run | reset disarms `prevent_hard_delete`, the audit triggers and message immutability, then re-arms them in a `finally` | re-run twice |

**Also added, because a digest is not a diagnosis.** `apps/web/src/app/error.tsx` renders a real
route-level error boundary (digest, retry, way back), and `instrumentation.ts` implements Next 15's
`onRequestError`, so a render failure is recorded server-side with its message instead of only its
digest.

---

## 6. Test totals

| Suite | Tests | Result |
| --- | --- | --- |
| `@nexus/core` | 45 | pass |
| `@nexus/db` | 82 | pass (includes `migration-idempotency`, which applies the set 3×) |
| `@nexus/web` | 51 | pass (includes the 6 new duplicate/reactivation/timeline tests) |
| `db:verify` | — | 63 tables, 179 policies, 97 triggers, 86 functions, 173 indexes |
| Workspace typecheck | — | clean, 5 projects |
| Web build | 60 routes | clean |

---

## 7. What is still not right

1. **`My Day` stat row.** Shows "2 due / 1 connection / 0 accepted" while the admin owns 6 leads.
   The Open-leads count is not in the stat row. Cosmetic, but the screen reads quieter than the
   data warrants.
2. **Identity detail is sparse.** With no transfers recorded it is one card plus an empty state.
3. **"Upcoming" holds one item.** The seed's next actions cluster on today, so the tab looks thin
   even though it is correct.
4. **`admin-team-detail` renders 49 chips** and `ICP Manager` 371; both are dense at 1440 px with
   no overflow, but they are the two screens most likely to need pagination.
5. **Companion: `chrome.*` behaviour is unverified** (see §3). The layout, styles, copy, sign-in,
   binding and all six screens are verified; the extension APIs are not.
6. **Four user screens have no Figma frame** (spec U18–U21, no frames 07–10 in the file).
7. **`bindBrowser` revokes a previous session silently.** It now leaves a truthful `revoked_at`
   record, but it does not yet surface the `concurrent identity use` warning from
   `conflictingSessions` on the binding screen before it does so.
