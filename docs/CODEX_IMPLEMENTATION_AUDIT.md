# NEXUS — Independent Codebase + Figma Implementation Audit

Audit snapshot: 2026-09-25, repository `E:\CRM\CRM`. No product code was modified for this audit. Generated browser screenshots and build artifacts were refreshed under `E:\CRM\ui-audit` and the normal build directories.

## 1. Executive Summary

NEXUS is a substantial implementation, not a shell. The database contract is unusually strong: all 17 migrations apply to a clean PostgreSQL-compatible database, and the verifier reports 63 tables, 179 RLS policies, 97 triggers, 87 functions, and 173 indexes. The core CRM invariants, sequence timing, reply/DNC behavior, soft deletion, ingestion idempotency, and message immutability have executable database coverage. All 51 web routes rendered in a fresh 1440×980 Chromium pass, and the built MV3 package booted on a real `chrome-extension://` origin at 420×820 with a live service worker and real `chrome.storage`/`chrome.tabs` APIs.

It is not production-ready. The current repository fails its root typecheck and root test command; the latter now discovers a Playwright spec through Vitest but does not install `@playwright/test`. A standard user can directly open admin configuration routes, including platform settings. DeepSeek has schemas, prompt composition, retrieval, validation, and claim checking but no provider client or live request. The MCP surface advertises generic schemas rather than real per-tool schemas and does not centrally enforce its declared idempotency requirement. Webhook tables exist without a delivery worker. The actual extension boot is verified, but Chrome Side Panel lifecycle, alarm heartbeat behavior, a complete authenticated extension flow, and live LinkedIn DOM behavior remain unverified. Visible mojibake is widespread across the web and Companion UI.

### Scored completeness

Scores use a requirement-weighted rubric: enforcement/runtime evidence (40%), primary behavior (30%), test evidence (15%), and states/fidelity (15%). `PASS=1`, `PARTIAL=0.5`, `FAIL/UNVERIFIED=0`; safety-critical failures cap the relevant production score.

| Area | Score | Basis |
| --- | ---: | --- |
| Backend / DB completeness | **88%** | 17 migrations and DB verifier pass; core invariants are enforced and tested. Deductions: MCP validation/idempotency gaps, no webhook dispatcher, no live AI provider. |
| Admin functional completeness | **77%** | 23 web admin screens render with real seeded data and real repositories; principal actions exist. Deductions: sparse runtime interaction coverage, encoding defects, dense screens, and integration-only shells. |
| User functional completeness | **69%** | Real standard-user My Day and hidden-business denial were verified. Deductions: admin configuration URLs remain readable, contextual routes are incomplete when entered directly, and most prior user captures used an admin cookie. |
| Visual / Figma fidelity | **64%** | Correct 1440×980/420×820 references, 238/220px sidebars, token palette, radii, tables, cards, and no horizontal overflow. Deductions: widespread mojibake, My Day composition mismatch, excessive density, and incomplete true-user comparisons. |
| Companion UI completeness | **76%** | Shared shell and U22–U30 state components exist; preview flows and a real extension boot were observed. Deductions: authenticated real-origin flow is not currently runnable in CI and several states lack runtime evidence. |
| Real extension runtime completeness | **52%** | MV3 manifest, service worker, real extension origin, storage/tabs APIs, content script registration, and 420×820 mount verified. Side Panel lifecycle, alarms, authenticated flows, persistence, and live LinkedIn behavior are not fully verified. |
| Integrations completeness | **47%** | Scoped MCP/API token architecture and Supabase/Postgres path exist; Apollo remains zero-credit/manual. DeepSeek live calls, webhook delivery, and external BrowserOS/OpenCode/ChatGPT client E2E are missing or unverified. |
| Production readiness | **44%** | Web build passes, DB verifier passes, frozen install passes, lint passes. Root typecheck and root tests fail; security boundary and required live integrations remain open. |

**Overall implementation confidence: 65%.** This reflects a strong data/core foundation with material release, access-control, integration, visual-content, and end-to-end validation gaps.

### Repository map and dependency graph

```text
product/Nexus_CRM_Master_Spec_v1.json + product/figma/*.fig
                         │
packages/core ───────────┼──── pure contracts, normalization, permissions, sequence/My Day rules
       │                 │
       ├───────── packages/db ─ migrations, RLS, triggers, RPCs, verifier/tests
       │                 │
       └───────── packages/ui ─ tokens, shared web/Companion primitives
                         │
                apps/web (Next.js)
                 ├─ page routes + server actions
                 ├─ repositories / actor-scoped SQL
                 ├─ Companion REST API
                 └─ MCP JSON-RPC gateway
                         │
                apps/extension (MV3)
                 ├─ side panel React bundle
                 ├─ service worker / alarms / storage
                 └─ LinkedIn content script
```

## 2. Critical Blockers

### NX-001 — Verification gate is red

- **Severity:** critical
- **Affected area:** release / tests
- **Expected behavior:** frozen install, typecheck, lint, tests, and builds all pass from the committed manifests.
- **Actual behavior:** frozen install and lint pass; the web build passes. Root typecheck fails in `packages/core/src/permissions.test.ts` (unknown `operatorName`; missing required arguments). Root tests fail because Vitest loads `apps/extension/e2e/boot-and-auth.spec.mjs`, which imports unavailable `@playwright/test`.
- **Evidence:** `package.json:10-17`; `packages/core/src/permissions.test.ts:53`; `packages/core/src/permissions.test.ts:105`; `apps/extension/e2e/boot-and-auth.spec.mjs:8`; command `pnpm run typecheck`; command `pnpm run test`.
- **Files:** `packages/core/src/permissions.test.ts`, `apps/extension/e2e/boot-and-auth.spec.mjs`, `apps/extension/package.json`.
- **Recommended fix:** type-correct the concurrency fixtures; separate Vitest and Playwright discovery or add/configure `@playwright/test`; make the root build include both web and extension; rerun every gate from a clean frozen install.

### NX-002 — DeepSeek is not connected

- **Severity:** critical
- **Affected area:** AI message generation / research normalization
- **Expected behavior:** the primary DeepSeek provider receives schema-constrained requests with timeout/retry/failure handling, and only validated output can mutate state.
- **Actual behavior:** schemas, selective retrieval, prompt construction, validation, and claim checking exist, but there is no DeepSeek client, API-key wiring, live HTTP request, retry/timeout policy, or provider failure path.
- **Evidence:** `packages/core/src/contracts.ts:16`; `packages/core/src/messaging-rules.ts:378`; repository search found no DeepSeek fetch/provider implementation; spec `integrations.deepseek`.
- **Files:** `packages/core/src/contracts.ts`, `packages/core/src/messaging-rules.ts`.
- **Recommended fix:** add a server-only provider abstraction and DeepSeek implementation, validate JSON before any write, persist model/prompt provenance, add timeout/retry/circuit behavior, and test success plus malformed/timeout/rate-limit cases.

### NX-003 — Users can read admin configuration routes

- **Severity:** critical
- **Affected area:** access control / user surface
- **Expected behavior:** standard users cannot access admin configuration.
- **Actual behavior:** a real `osama@nexus.local` user session directly rendered `/businesses`, `/team`, and `/settings`. Writes are permission-gated and RLS limited the rows, but `/settings` disclosed global security, retention, DNC, sequence, and uniqueness settings. Hidden-business access correctly returned 404.
- **Evidence:** runtime route `/settings` as standard user; runtime route `/businesses`; runtime route `/team`; hidden route `/b/lavish-foods/overview` returned 404; `apps/web/src/app/(app)/layout.tsx:16-57`; `apps/web/src/app/(app)/settings/page.tsx:36-64,92-160`.
- **Files:** `apps/web/src/app/(app)/layout.tsx`, admin pages under `apps/web/src/app/(app)`.
- **Recommended fix:** enforce route-level surface/permission checks before repository calls and return 404/403 or redirect for admin-only pages; retain RLS as defense in depth.

## 3. High Priority Gaps

### NX-004 — MCP contracts are under-validated

- **Severity:** high; **production blocker:** yes for ChatGPT-ready MCP
- **Affected area:** MCP / API
- **Expected behavior:** each tool publishes and enforces its complete input schema; ingestion-related writes enforce idempotency; invalid JSON-RPC batches are handled correctly.
- **Actual behavior:** arguments are `Record<string, unknown>` and parsed with permissive helpers; every advertised schema contains essentially only `business_id`; `needsIdempotencyKey` is metadata but is not centrally enforced. `submit_research` is marked idempotent-required yet inserts without checking an idempotency key. Batch requests use only the first element.
- **Evidence:** `apps/web/src/app/api/v1/mcp/route.ts:57-64,82-83,389-445,501-515,536,563-569`.
- **Recommended fix:** define a Zod schema per tool, derive MCP JSON schemas from them, reject unknown/invalid fields, enforce handler metadata centrally, and implement correct batch semantics or explicitly reject batches.

### NX-005 — Webhooks are persistence-only

- **Severity:** high
- **Affected area:** integrations
- **Expected behavior:** configured endpoints receive signed, retried, auditable deliveries.
- **Actual behavior:** endpoint/delivery tables and read UI exist, but no outbound dispatcher, signing, retry worker, or delivery request was found.
- **Evidence:** `packages/db/migrations/0009_integrations_audit.sql:53-86`; `apps/web/src/lib/repo/integrations.ts:189`; repository-wide `fetch(` appears only in smoke scripts and the extension.
- **Recommended fix:** implement event enqueueing, signature generation, bounded retry/backoff, terminal failure state, observability, and integration tests with a local receiver.

### NX-006 — Real extension E2E is incomplete and currently misconfigured

- **Severity:** high
- **Affected area:** Companion extension / test
- **Expected behavior:** CI loads the unpacked extension, signs in, binds/transfers identity, exercises Leads/Today/Search/Add/focus/reply/snooze/reactivation, verifies storage/persistence, Side Panel lifecycle, alarms, and a LinkedIn fixture/live adapter.
- **Actual behavior:** the boot probe passed on Chrome 153 with a real service worker, extension origin, storage/tabs APIs, and 420×820 viewport. The new Playwright E2E spec cannot run from the root test command because `@playwright/test` is unavailable and is discovered by Vitest. The harness opens the side-panel document as a tab, so it still does not prove actual Chrome Side Panel lifecycle.
- **Evidence:** `apps/extension/e2e/probe.mjs`; `apps/extension/e2e/harness.mjs:16-20`; `apps/extension/e2e/boot-and-auth.spec.mjs:8`; command `node apps/extension/e2e/probe.mjs` passed; command `pnpm run test` failed.
- **Recommended fix:** isolate Playwright config/dependency, run the suite as a separate root gate, add alarm/storage assertions, and add at least one browser-driven LinkedIn fixture flow plus manual real-site certification.

### NX-007 — Visible character encoding corruption

- **Severity:** high
- **Affected area:** visual/content fidelity across web and Companion
- **Expected behavior:** bullets, em dashes, arrows, ellipses, and multiplication/close glyphs render correctly.
- **Actual behavior:** 247 source matches were found for mojibake patterns; at least 116 are likely runtime strings. Live screenshots show text such as `Studio · ...`. Loading labels, DNC copy, table empty values, sequence arrows, and Companion back controls are affected.
- **Evidence:** `packages/ui/src/primitives.tsx:475,617`; `packages/ui/src/domain.tsx:110,136`; `apps/web/src/app/b/[slug]/overview/page.tsx:57`; `apps/extension/src/sidepanel.tsx:278,1081`; screenshot `E:/CRM/ui-audit/shots/biz-overview.png`.
- **Recommended fix:** normalize affected source files to UTF-8, replace corrupted literals, add an automated mojibake scan, and recapture every Figma screen.

### NX-008 — Prior user UI evidence used an administrator session

- **Severity:** high
- **Affected area:** UI acceptance / permissions testing
- **Expected behavior:** user screenshots and flows run as a real user with the 220px user shell and restricted navigation.
- **Actual behavior:** `capture-all.mjs` applies one administrator cookie to admin, user, and business routes. The resulting “user” screenshots show the 238px admin sidebar and cannot prove user navigation or permission behavior. A separate manual user session was required to verify the real shell.
- **Evidence:** `E:/CRM/ui-audit/capture-all.mjs` cookie setup and route list; `E:/CRM/ui-audit/ui-acceptance.json` reports 238px sidebar for `user-*`; runtime standard-user session showed only Zemnas and WORK/INGESTION navigation.
- **Recommended fix:** create distinct admin/manager/user browser contexts, assert role-specific navigation and 220px width, and recapture all U screens.

### NX-009 — Root build omits the extension

- **Severity:** high
- **Affected area:** release engineering
- **Expected behavior:** the release build validates both deployable products.
- **Actual behavior:** root `build` only runs `@nexus/web`; extension compilation, manifest validation, secret scan, and packaging are separate and can regress without failing the main build.
- **Evidence:** `package.json:14`; `apps/extension/package.json`; extension build script validates manifest and credentials independently.
- **Recommended fix:** make root build run web and extension, and add separate packaged artifact checks for development and production `NEXUS_API_ORIGIN`.

## 4. Medium / Low Gaps

| ID | Severity | Area | Gap | Evidence / recommended fix |
| --- | --- | --- | --- | --- |
| NX-010 | medium | My Day visual | Figma U02 has stat tiles Connections, Message 1, Follow-ups, Overdue and Today/Upcoming/Done/+Task tabs. Runtime uses Due today, Connections, Accepted/Message 1, Overdue and link/filter composition. | `.work/figtool/out/SCREEN_MANIFEST.md:2191`; `apps/web/src/app/(app)/my-day/page.tsx:72`. Align composition without changing behavior. |
| NX-011 | medium | ICP Manager | Browser capture rendered 122 table rows and 371 chips in one screen; this is substantially denser than the Figma operational layout. | `E:/CRM/ui-audit/ui-acceptance.json` `biz-setup-icps`; split hierarchy/editor panels and preserve Figma density. |
| NX-012 | medium | Team detail | User Permissions renders seven cards, 49 chips, and a dense permission matrix; functionally rich but visually beyond the reference frame. | screenshot `admin-team-detail.png`; collapse advanced sections and retain primary hierarchy. |
| NX-013 | medium | Contextual user flows | `/tasks/new` and `/snooze` render empty states when entered without `?lead=`; the 51-route capture therefore did not verify the actual form/modal workflow. | `ui-acceptance.json` shows `showsEmptyState=true`; add context-bearing browser flows and safe lead selection fallback. |
| NX-014 | medium | State coverage | Loading/error/empty components exist, but route capture mostly proves seeded happy paths and direct empty states; network, permission, conflict, validation, and partial-failure states have little browser automation. | `packages/ui/src/primitives.tsx:460-515`; add route-level failure injection and visual assertions. |
| NX-015 | medium | Duplicate surfaces | Three trash routes (`/trash`, `/my-trash`, `/b/[slug]/trash`) and separate action components create drift risk; global and user screenshots were effectively identical empty states. | route build output; `apps/web/src/components/trash-actions.tsx`; `trash-restore.tsx`. Consolidate shared behavior and make surface differences explicit. |
| NX-016 | medium | Documentation drift | `IMPLEMENTATION_MATRIX.md` names routes/components/tests that do not exist or differ from the implementation, and claimed 86 functions while verifier now reports 87. | docs vs build route list and `db:verify`; regenerate the matrix from real routes/tests. |
| NX-017 | medium | External agents | BrowserOS/OpenCode/n8n are configurable labels and can use scoped MCP tokens, but no external-client interoperability test was found. | `automation-forms.tsx`, `gateway.ts`; test discovery, auth, scope refusal, revocation, and idempotency with representative clients. |
| NX-018 | low | Identity detail | With no transfer history the detail screen is sparse. This is a design difference, not a functional defect. | `admin-identity-detail.png`; add a purposeful empty-history state only if desired. |
| NX-019 | low | Demo coverage | Upcoming can contain only one seed item. This is a test/demo-data gap, not production logic evidence. | `user-my-day-upcoming.png`; seed multiple dates/categories for visual QA. |
| NX-020 | low | Bundle / primitives | Development Companion bundle is ~3.96 MB and several feature forms use raw checkbox/radio/file inputs outside shared wrappers. | `apps/extension/dist/sidepanel.js`; raw input search. Add production minification/budget and shared checkbox/radio/file primitives where styling drifts. |

### Previously suspected gaps — classification

| Suspected item | Classification | Finding |
| --- | --- | --- |
| My Day open-lead count missing | **NOT A PROBLEM** | Figma U02 specifies Connections, Message 1, Follow-ups, Overdue—not open leads. There is a different stat-composition mismatch (NX-010). |
| Outreach Identity detail sparse without history | **DESIGN DIFFERENCE** | NX-018. |
| Upcoming has one seed item | **TEST GAP** | NX-019. |
| Team detail excessively dense | **DESIGN DIFFERENCE** | NX-012. |
| ICP Manager excessively dense | **DESIGN DIFFERENCE** | NX-011. |
| User Figma has no frames 07–10 | **NOT A PROBLEM** | The file intentionally numbers 01–06 then 11–30; U18–U21 are present as frames 18–21. |
| Concurrent identity warning missing | **NOT A PROBLEM in current code; runtime test partial** | API returns 409 before transfer, UI offers Cancel/Transfer, transfer is audited; real browser conflict flow awaits working E2E. |
| Real Chrome API E2E missing | **TEST GAP** | Boot verified; full lifecycle remains NX-006. |
| LinkedIn content script unverified | **TEST GAP** | Adapter unit tests exist; live LinkedIn/fixture browser execution remains unverified. |
| Live DeepSeek API missing | **PRODUCTION BLOCKER** | NX-002. |

## 5. Screen Audit Matrix

Legend: PASS = independently evidenced; PARTIAL = route/code exists but one or more completion criteria are missing; FAIL = confirmed mismatch; UNVERIFIED = no direct evidence.

| ID | Figma Screen | Route | Implemented | Browser Verified | Visual Match | Functional | Backend Connected | Tests | Status | Gap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A01 | Login | `/login` | PASS | PASS | PARTIAL | PASS | PASS | PASS | PASS | No pixel diff; auth runtime verified. |
| A02 | Overview | `/b/[slug]/overview` | PASS | PASS | PARTIAL | PASS | PASS | PARTIAL | PARTIAL | Mojibake; no interaction tests. |
| A03 | Leads | `/b/[slug]/leads` | PASS | PASS | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Filters render; bulk/runtime actions not fully exercised. |
| A04 | Lead Detail | `/b/[slug]/leads/[id]` | PASS | PASS | PARTIAL | PARTIAL | PASS | PASS | PARTIAL | Core reply/DNC tested; all UI actions not. |
| A05 | Lead Sources | `/b/[slug]/lead-sources` | PASS | PASS | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Import list real; every ingestion flow not browser-run. |
| A06 | Profile Queue | `/b/[slug]/profile-queue` | PASS | PASS | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Same-lead update code exists; browser mutation not run. |
| A07 | Duplicate Review | `/b/[slug]/duplicates` | PASS | PASS | PARTIAL | PARTIAL | PASS | PASS | PARTIAL | Repository tests, limited UI workflow evidence. |
| A08 | Trash | `/b/[slug]/trash` | PASS | PASS | PARTIAL | PARTIAL | PASS | PASS | PARTIAL | Restore/delete DB rules strong; duplicate surfaces. |
| A09 | Reactivation | `/b/[slug]/reactivation` | PASS | PASS | PARTIAL | PARTIAL | PASS | PASS | PARTIAL | Scheduling tested; new-angle generation provider missing. |
| A10 | Businesses Hub | `/businesses` | PASS | PASS | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Standard users can reach read-only page. |
| A11 | Business Brain | `/b/[slug]/setup/brain` | PASS | PASS | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Real CRUD; no live AI use. |
| A12 | ICP Manager | `/b/[slug]/setup/icps` | PASS | PASS | FAIL | PARTIAL | PASS | PARTIAL | PARTIAL | Extreme density (NX-011). |
| A13 | Sequence Manager | `/b/[slug]/setup/sequences` | PASS | PASS | PARTIAL | PASS | PASS | PASS | PARTIAL | Core publish behavior tested; UI publish interaction not. |
| A14 | Knowledge Library | `/b/[slug]/setup/knowledge` | PASS | PASS | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Retrieval state works; extraction/provider missing. |
| A15 | Team & Accounts | `/team` | PASS | PASS | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | User route reachable; role runtime coverage incomplete. |
| A16 | User Permissions | `/team/[id]` | PASS | PASS | FAIL | PARTIAL | PASS | PARTIAL | PARTIAL | Dense; mutation matrix not browser-tested. |
| A17 | Identity Detail | `/identities/[id]` | PASS | PASS | PARTIAL | PARTIAL | PASS | PASS | PARTIAL | Transfer code/tests exist; real conflict flow unavailable. |
| A18 | Integrations Gateway | `/integrations` | PASS | PASS | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | MCP present; webhooks/DeepSeek incomplete. |
| A19 | Automation Mapping | `/b/[slug]/automations` | PASS | PASS | PARTIAL | PARTIAL | PASS | UNVERIFIED | PARTIAL | Mapping persists; no runner execution. |
| A20 | Admin Import Builder | `/b/[slug]/lead-sources/import` | PASS | PASS | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Browser execution/undo not independently completed. |
| A21 | Messaging Insights | `/b/[slug]/insights/messaging` | PASS | PASS | PARTIAL | PASS | PASS | UNVERIFIED | PARTIAL | Real aggregates; visible encoding defects. |
| A22 | Settings | `/settings` | PASS | PASS | PARTIAL | PARTIAL | PASS | PASS | FAIL | User can read admin settings (NX-003). |
| A23 | Add Business Wizard | `/businesses/new` | PASS | PASS | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Rendered; full clone/template rollback not browser-tested. |
| A24 | Companion Leads | extension CRM/Leads | PASS | PARTIAL | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Preview evidence; real-origin authenticated flow unavailable. |
| A25 | Companion Today | extension CRM/Today | PASS | PARTIAL | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Same. |
| A26 | Companion Search | extension CRM/Search | PASS | PARTIAL | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Same. |
| A27 | Companion Add to CRM | extension Add | PASS | PARTIAL | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Required fields enforced; real-origin flow incomplete. |
| A28 | Companion Action Focus | extension lead focus | PASS | PARTIAL | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Multiple focus states exist; full runtime not verified. |
| A29 | My Access & Assignment | `/my-access` | PASS | PASS | PARTIAL | PARTIAL | PASS | PASS | PARTIAL | Transfer confirmation tested below UI, not browser. |
| A30 | Business Domains | `/business-domains` | PASS | PASS | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Constraints strong; CRUD browser flow incomplete. |
| U01 | Login | `/login` | PASS | PASS | PARTIAL | PASS | PASS | PASS | PASS | Shared login. |
| U02 | My Day Today | `/my-day` | PASS | PASS | FAIL | PASS | PASS | PARTIAL | Real user verified; composition differs (NX-010). |
| U03 | My Day Upcoming | `/my-day/upcoming` | PASS | PASS | PARTIAL | PARTIAL | PASS | UNVERIFIED | PARTIAL | Sparse seed; no scheduling interaction proof. |
| U04 | My Day Done | `/my-day/done` | PASS | PASS | PARTIAL | PASS | PASS | UNVERIFIED | PARTIAL | Real rows render; no user-role capture in prior harness. |
| U05 | My Leads | `/my-leads` | PASS | PASS | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Prior screenshot used admin cookie. |
| U06 | Lead Detail | `/my-leads/[id]` | PASS | PASS | PARTIAL | PARTIAL | PASS | PASS | PARTIAL | Shared business detail; action set not fully browser-tested. |
| U11 | Lead Sources | `/my-lead-sources` | PASS | PASS | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Real UI; every path not end-to-end. |
| U12 | File Import | `/my-lead-sources/file` | PASS | PASS | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | No real file browser flow in audit. |
| U13 | Paste Import | `/my-lead-sources/paste` | PASS | PASS | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Preview/execute not browser-run. |
| U14 | Google | `/my-lead-sources/google` | PASS | PASS | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Partial-record lifecycle not browser-run. |
| U15 | Apollo | `/my-lead-sources/apollo` | PASS | PASS | PARTIAL | PASS | PASS | PARTIAL | PARTIAL | BASIC/Enrichment OFF present; manual-only. |
| U16 | Profile Queue | `/my-profile-queue` | PASS | PASS | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Same-lead behavior code/DB; UI mutation incomplete. |
| U17 | Duplicate Review | `/my-duplicates` | PASS | PASS | PARTIAL | PARTIAL | PASS | PASS | PARTIAL | Resolution handlers exist; browser path incomplete. |
| U18 | Create Task | `/tasks/new?lead=...` | PASS | PARTIAL | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Direct route capture was only empty state. |
| U19 | Snooze / Reschedule | `/snooze?lead=...` | PASS | PARTIAL | PARTIAL | PARTIAL | PASS | PASS | PARTIAL | Direct route capture was only empty state. |
| U20 | Edit Lead | `/leads/[id]/edit` | PASS | PASS | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Form rendered; mutation not browser-run. |
| U21 | Trash | `/my-trash` | PASS | PASS | PARTIAL | PARTIAL | PASS | PASS | PARTIAL | Restore-only rule exists; empty capture. |
| U22 | Companion Login / Binding | extension bind | PASS | PARTIAL | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Boot verified; auth/bind E2E currently cannot run. |
| U23 | Companion Leads | extension CRM/Leads | PASS | PARTIAL | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | List state code exists; real reopen proof missing. |
| U24 | Companion Today | extension CRM/Today | PASS | PARTIAL | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Exact action endpoint exists; real-origin flow missing. |
| U25 | Companion Search | extension CRM/Search | PASS | PARTIAL | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Multi-business selection not real-origin tested. |
| U26 | Companion Add to CRM | extension Add | PASS | PARTIAL | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Capture/dedupe API exists; content-script flow unverified. |
| U27 | Connection Focus | extension focus | PASS | PARTIAL | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | With/without note code exists; Chrome flow unverified. |
| U28 | Follow-up Focus | extension focus | PASS | PARTIAL | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | Correct-step code exists; live dynamic generation absent. |
| U29 | Reply & Notes | extension reply | PASS | PARTIAL | PARTIAL | PARTIAL | PASS | PASS | PARTIAL | DB exact reply/DNC strong; extension flow unverified. |
| U30 | Dormant / Reactivation | extension reactivate | PASS | PARTIAL | PARTIAL | PARTIAL | PASS | PASS | PARTIAL | Scheduling works; fresh AI angle missing. |

## 6. Backend Rule Matrix

| Rule | DB Enforcement | Server Enforcement | Automated Test | Runtime Verified | Result |
| --- | --- | --- | --- | --- | --- |
| Person global | PASS | PASS | PASS | PASS | PASS |
| Company global | PASS | PASS | PASS | PASS | PASS |
| SocialProfile global | PASS | PASS | PASS | PARTIAL | PASS |
| Lead business-specific | PASS | PASS | PASS | PASS | PASS |
| Same person across businesses | PASS | PASS | PASS | PASS | PASS |
| One active lead/business/person | PASS | PASS | PASS | PASS | PASS |
| One Primary ICP/lead | PASS | PASS | PASS | PASS | PASS |
| Secondary ICP does not create lead | PASS | PASS | PASS | PARTIAL | PASS |
| LinkedIn normalization | PASS | PASS | PASS | PARTIAL | PASS |
| Company dedupe | PASS | PASS | PASS | PARTIAL | PASS |
| Soft delete preserves history | PASS | PASS | PASS | PARTIAL | PASS |
| Restore rechecks uniqueness | PASS | PASS | PASS | PASS | PASS |
| DNC person+channel/global identities | PASS | PASS | PASS | PASS | PASS |
| SENT immutable | PASS | PASS | PASS | PASS | PASS |
| LOCKED protected on publish | PASS | PASS | PASS | PASS | PASS |
| DYNAMIC invalidated/regenerated | PASS | PASS | PASS | PARTIAL | PARTIAL — invalidation works; live provider absent |
| Import idempotency | PASS | PASS | PASS | PARTIAL | PASS |
| Reply byte-for-byte + notes separate | PASS | PASS | PASS | PASS | PASS |
| Sequence uses next step delay | PASS | PASS | PASS | PASS | PASS |
| Business reactivation delay | PASS | PASS | PASS | PASS | PASS |
| FORCE RLS | PASS | N/A | PASS | PASS | PASS |
| User denied hidden business | PASS | PASS | PASS | PASS | PASS |
| User denied admin configuration | PARTIAL | PARTIAL | UNVERIFIED | FAIL | FAIL |
| Companion business intersection | PASS | PASS | PARTIAL | PARTIAL | PARTIAL |

## 7. Extension Matrix

| Screen / Capability | Implemented | Real extension tested | Chrome API tested | LinkedIn tested | Status |
| --- | --- | --- | --- | --- | --- |
| MV3 manifest / CSP / narrow hosts | PASS | PASS | PASS | N/A | PASS |
| Service worker boot | PASS | PASS | PASS | N/A | PASS |
| Side panel document mount 420×820 | PASS | PASS (as extension tab) | PASS | N/A | PARTIAL |
| Actual Side Panel open/close lifecycle | PASS | UNVERIFIED | UNVERIFIED | N/A | UNVERIFIED |
| `storage.session` token | PASS | PARTIAL | PASS (API presence) | N/A | PARTIAL |
| `storage.local` binding/list state | PASS | PARTIAL | PASS (API presence) | N/A | PARTIAL |
| alarms heartbeat | PASS | UNVERIFIED | UNVERIFIED | N/A | UNVERIFIED |
| Login and token revocation | PASS | PARTIAL | PARTIAL | N/A | PARTIAL |
| Concurrent identity warning/transfer | PASS | PARTIAL | PARTIAL | N/A | PARTIAL |
| Leads / Today / Search | PASS | preview only | PARTIAL | N/A | PARTIAL |
| Add to CRM | PASS | preview only | PARTIAL | fixture/unit only | PARTIAL |
| Connection / follow-up / reply focus | PASS | preview only | PARTIAL | UNVERIFIED | PARTIAL |
| Content script extraction | PASS | UNVERIFIED | PARTIAL | unit fixture only | PARTIAL |
| Open LinkedIn in active tab | PASS | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| State restoration | PASS | UNVERIFIED | PARTIAL | N/A | PARTIAL |

## 8. Integration Matrix

| Integration | Implementation | Runtime evidence | Status | Gap |
| --- | --- | --- | --- | --- |
| DeepSeek | Schemas, prompts, retrieval, validation, claim checking | No provider call | FAIL | NX-002 |
| MCP | 18 intent tools, scoped tokens, no arbitrary SQL | discovery/unknown-tool smoke exists | PARTIAL | Weak schemas/idempotency/batches (NX-004) |
| BrowserOS | Configurable automation runner via scoped tools | No external-client E2E | PARTIAL | NX-017 |
| OpenCode | Configurable automation runner via scoped tools | No external-client E2E | PARTIAL | NX-017 |
| Apollo | Manual/basic import, Enrichment OFF, no paid fetch | Browser render + source search | PASS | No paid calls found |
| Supabase/Postgres | External URL driver, same migrations/RLS, production posture guard | Clean embedded PostgreSQL verification | PARTIAL | No live Supabase deployment smoke in this audit |
| Webhooks | Endpoint/delivery schema + read UI | No sender | FAIL | NX-005 |
| ChatGPT-ready MCP | JSON-RPC HTTP and bearer scopes | Partial smoke | PARTIAL | NX-004/NX-017 |

## 9. Dead / Duplicate / Suspicious Code

- `apps/web/src/app/(app)/trash`, `apps/web/src/app/(app)/my-trash`, and `apps/web/src/app/b/[slug]/trash` duplicate surface logic and create drift risk.
- `apps/web/src/components/trash-actions.tsx` and `trash-restore.tsx` overlap restore behavior.
- `apps/web/scripts/diag-identity-scope.ts` is a one-off diagnostic left in the product tree and not declared as a package script.
- `docs/IMPLEMENTATION_MATRIX.md` refers to non-existent test files/components and old route conventions; it is a claim document, not executable mapping.
- Demo values are confined mainly to seed scripts. Production page repositories read real database state; no fake production data path was found.
- Direct SQL is concentrated in server-only repositories/routes and parameterized. No `database.execute_sql`, `exec_sql`, or arbitrary SQL MCP tool was found.
- No service-role, database URL, DeepSeek key, Apollo key, or MCP master key was found in the web static bundle or extension bundle.

## 10. Tests That Give False Confidence

- The old 178-test headline was dominated by 82 DB tests and 45 normalization tests; it did not imply screen coverage.
- Root web build compiles successfully while root typecheck fails because Next excludes test files and root build excludes the extension.
- `--passWithNoTests` previously made UI and extension packages green with zero tests.
- The 51-route screenshot harness uses an admin cookie for user routes, so successful user screenshots did not test user permissions or the user sidebar.
- Rendering a Companion preview with stubbed `chrome.*` calls does not validate an extension origin, service worker, Side Panel lifecycle, alarms, or LinkedIn content scripts.
- The real extension boot probe verifies API availability, not authenticated workflows.
- Seeded rows can make tables appear complete while loading/error/permission/empty/rollback paths remain untested.

## 11. Missing Tests

- Route-level denial for every admin configuration route as manager and user.
- Full standard-user visual pass at 1440×980 and permission bypass attempts with IDs/URLs.
- Playwright component/route interactions for all primary mutations, dialogs, loading/error/empty states, and rollback cases.
- Working real-extension Playwright suite separated from Vitest.
- Chrome Side Panel lifecycle, alarm creation/firing, browser restart/session persistence, and list scroll/index restoration.
- LinkedIn fixture page injection and a documented live-site certification pass.
- DeepSeek success, invalid JSON, unsupported claims, timeout, retry, rate limit, and provider outage.
- MCP per-tool schema rejection, batch behavior, idempotency for every declared tool, audit-event assertions, and representative external clients.
- Webhook signatures, retry/backoff, duplicate suppression, revocation, and terminal failure.
- Visual diffs against every Figma frame, with encoding scan and real role-specific sessions.

## 12. Final Remaining Work

### MUST FIX BEFORE PRODUCTION

1. Restore green root typecheck and root tests; isolate/configure Playwright E2E.
2. Enforce admin-only route access, not merely read-only writes.
3. Wire and harden the live DeepSeek provider or explicitly remove AI generation from the production claim.
4. Make MCP schemas/idempotency/batch behavior conform to the master spec before advertising ChatGPT-ready MCP.
5. Remove all visible mojibake and rerun the full screen audit.
6. Run the complete real-extension flow, including actual Side Panel and LinkedIn adapter certification.
7. Include extension build/package validation in the root release gate.

### SHOULD FIX

1. Implement webhook delivery.
2. Recapture U screens with user/manager sessions and assert the 220px user shell.
3. Align My Day structure to Figma while preserving backend categories.
4. Reduce ICP Manager and Team detail density.
5. Consolidate trash surfaces/actions.
6. Regenerate implementation/acceptance matrices from executable evidence.

### OPTIONAL POLISH

1. Improve sparse identity-history and Upcoming demo states.
2. Add production bundle budgets and reduce Companion bundle size.
3. Add shared checkbox/radio/file primitives where repeated styling diverges.

---

## 13. Backend remediation status (branch `backend/remediation`)

The items below are the backend's share of section 12, with what was actually done. Anything not
listed here was **not** addressed by this pass, and the frontend and extension items are outside its
scope. `docs/FRONTEND_CONTRACTS.md` is the companion document: it states each contract a screen
depends on, including the parts of the spec that are deliberately not implemented.

### MUST FIX

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Green root typecheck and tests; Playwright isolation | **Done** | `pnpm run typecheck`, `lint`, `test`, `db:verify`, `build` all exit 0; extension vitest excludes `e2e/**` |
| 2 | Admin-only route access | **Done** | `lib/route-guard.ts`; 23 pages call `requireRouteAccess`, 19 actions call `authorizeAction`; `route-access.test.ts` (14 cases) |
| 3 | Wire and harden DeepSeek | **Done** | `lib/ai/{config,types,deepseek,drafting}.ts`; 71 tests; used by profile capture and `draftMessageAction` |
| 4 | MCP schemas/idempotency/batch | **Done** | `mcp/tool-schemas.ts`, migration `0020`; `mcp-gateway.test.ts` (30 cases, including every handler) |
| 5 | Remove visible mojibake | **Done** | `scripts/repair-encoding.mjs`; 28 files repaired, repository now scans clean |
| 6 | Complete real-extension flow | **Not addressed by this pass** | extension-owned; handled in the separate extension remediation |
| 7 | Extension build in the root release gate | **Not addressed by this pass** | `build` still targets `@nexus/web` only (NX-009) |

### REQUIRED LIFECYCLE CONTRACTS

Both were declared in the schema and unreachable from the application. Implemented in migrations
`0023`–`0025`; documented in `FRONTEND_CONTRACTS.md` §6.2 and §6.3.

| Contract | Status | Evidence |
| --- | --- | --- |
| Business archive / restore, Admin-only, audited | **Done** | `archive_business` / `restore_business`; `business-archive.test.ts` (16 cases) |
| Archiving blocks new outreach, imports and automations | **Done** | `BEFORE INSERT` trigger on `leads`, `sequence_enrollments`, `message_instances`, `import_batches`; asserted by direct SQL in the tests |
| Archiving preserves leads, messages, replies, tasks, audit | **Done** | asserted against the sent message text and identity attribution |
| Permanent deletion refused when protected history exists | **Done** | `business_protected_history` + repository guard + `BEFORE DELETE` trigger |
| Identity unassign / disable / safe delete | **Done** | `unassignIdentity`, `archiveIdentity`, `deleteIdentitySafely`; `identity-lifecycle.test.ts` (20 cases) |
| Archived identities leave selectors and are blocked from outreach | **Done** | `identity_usable_by_actor`, `listIdentityOptions`, `companionIdentities`, assignment list |
| Historical sent-message attribution intact after archive | **Done** | asserted on `message_events` after archiving |
| Hard delete of an identity with history returns a typed rejection | **Done** | `errorCode: 'identity_has_attribution'` with counts |
| MCP handlers exercised end to end | **Done** | 16 new cases covering `get_today_queue`, `search_*`, `check_duplicate`, `submit_research`, `finish_agent_run`, `submit_message_draft`, `create_task`, `add_note`, `submit_candidate` |

### SHOULD FIX

| # | Item | Status |
| --- | --- | --- |
| 1 | Webhook delivery | **Explicitly deferred**, with the deferral documented in `FRONTEND_CONTRACTS.md` §6.1. The tables remain; no delivery mechanism was added. |
| 2–6 | UI recapture, My Day structure, density, trash consolidation, matrix regeneration | Not addressed by this pass (frontend-owned) |

### Additional defects found and fixed while doing the above

These were not in the audit. Each was found by writing the test that had never been written, and each
has regression coverage.

| Defect | Consequence before the fix | Fix |
| --- | --- | --- |
| The percentage branch of the numeric-claim pattern ended in `\b`, which `%` can never satisfy | **Every percentage claim escaped the claim policy entirely** — `40%` is the most likely fabricated metric in outreach | `packages/core/src/messaging-rules.ts`; `messaging-rules.test.ts` |
| Profile heuristics selected the *name* as the headline and split the headline non-greedily | `jobTitle` and `company` were null on every ordinary capture; "Head of Content at X" became "Head of" + "Content at X" | `heuristicProfileFields` |
| The schema-retry budget was tested after retrying | a systematically wrong model spent its whole attempt budget on a failure retrying cannot fix | `lib/ai/deepseek.ts` |
| A capture for an invisible lead reported an RLS policy name to the operator | leaked that the row exists, and a raw policy name; a model call was also spent first | visibility is settled before extraction |
| `cloneBusiness` copied `sequences` without their versions or steps | **every cloned sequence was an empty shell that could never produce a message** | `repo/businesses.ts`; `business-lifecycle.test.ts` |
| A `SENT` instance could hold an empty message version | SENT forever with nothing to display, and unrepairable because SENT content is immutable | migration `0021`; `sent-message-content.test.ts` |
| Global `platform_settings` were readable by any authenticated user | the DNC rule, reply-pause rule and retention/security defaults were exposed platform-wide | migration `0022`; `platform-settings-scope.test.ts` |
| `nexus.submit_candidate` wrote `ingest_requests.status = 'processing'`, then `'completed'` | neither is in the check constraint, and the ledger row shares a transaction with the lead, so **every externally ingested candidate failed at the first write**. The path had no test. | `repo/ingest.ts`; `mcp-gateway.test.ts` |
| `repo/ingest.ts` inserted `leads.source_type = 'api_ingest'` | not in `LEAD_SOURCE_TYPES`, so the lead insert was rejected — the same path, a second failure | now `external_ingest` |
| `requireScope` was called with `businessId ?? ''` for every tool | `nexus.list_accessible_businesses` — the one non-business-scoped tool — answered "not scoped to that business" for a correct token, so **a client could never get past discovery** | `lib/gateway.ts`, `mcp/route.ts` |
| All lifecycle-relevant code paths were untestable by construction: `identity_usable_by_actor` short-circuited on `is_admin()` | an admin bypassed a retired identity's state entirely, so "archive" would not have blocked anything for the one role that can send as anyone | migration `0025` |
| 28 files carried double-encoded UTF-8 from a Windows-1252 round trip | runtime strings were corrupted, not only comments: table placeholders, domain-type labels, transfer arrows, seed message bodies | `scripts/repair-encoding.mjs` |

### Not covered by tests in this pass

The MCP handler gap recorded here earlier is closed: every declared tool now has a case that asserts its
*result* against seeded data, not merely that it was not refused — see `mcp-gateway.test.ts`.

Still uncovered, and out of scope for a backend pass:

- Companion/extension endpoints beyond `companion-binding.test.ts`: the Side Panel's own flows are
  verified by the extension suite, which needs a real browser.
- The PDF/DOCX knowledge extractors (`repo/knowledge.ts`) — they need fixture files and a running
  extractor, and no behaviour was changed.
- `nx-009`: the root `build` script still compiles `@nexus/web` only, so the extension is not part of
  the release gate.


