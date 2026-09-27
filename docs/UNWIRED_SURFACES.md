# NEXUS — Unwired Surfaces Audit

**Branch:** `integration/final`
**Method:** repository-wide search, then per-control trace to a real action / repository function / API
route / RPC. A control is `WIRED` only when that trace completes.

Every finding below ends in exactly one of the three mandated states. **There are no silent `UNKNOWN`
entries.**

- `WIRED` — the control reaches a real backend path.
- `INTENTIONALLY_DEFERRED` — out of scope by explicit product decision, UI does not claim it works.
- `REMOVED_AS_DEAD_UI` — deleted from the product.

> ### Status of this document
>
> This file was first written as an inventory of **unwired surfaces in the pre-remediation tree**. Every
> one of its findings has since been either fixed, removed, or deliberately accepted, and the document
> has been rewritten so that it states the **current** code rather than the state it was found in.
>
> A finding is only recorded as fixed here when the fix is traceable in the source at this commit and,
> where a runtime behaviour is claimed, it was observed against a running build. Section 7 records the
> one finding that was reported as a defect and is **not** one.

## 1. Pattern sweep results

| Pattern searched | Product source scope | Hits |
| --- | --- | --- |
| `TODO` / `FIXME` / `HACK` / `XXX` | `apps/**`, `packages/**` excluding `node_modules`, `.next`, `dist` | **0** |
| `href="#"` and placeholder anchors | `apps/web/src`, `packages/ui/src` | **0** |
| Empty / no-op click handlers (`onClick={() => {}}`, `=> undefined`, `=> null`) | same | **0** |
| Permanently disabled controls without a reason | same | **0** (15 matches, all legitimate — see §3) |
| Static mock values rendered as runtime state | same | **0** — the three recorded here are bound to real state (§4) |
| Hard `.slice(0, n)` row caps | same | **0** now that the six recorded here are fixed (§5) |
| Links to non-existent routes | shell + all page anchors | **0** (3 found and fixed, see §6) |
| Old sentinel hacks | same | **0** (2 found and fixed, see §7) |

The codebase is unusually clean on the conventional markers: there are no `TODO`s, no placeholder
anchors and no dead click handlers anywhere in product source. The real findings were *semantic* —
a control that looks live and is not — rather than the usual litter, and each is now closed.

## 2. Navigation and shell

| Finding | State | Evidence |
| --- | --- | --- |
| Admin sidebar collapsed to 3 links on non-business-scoped routes | **WIRED** (fixed) | `packages/ui/src/app-shell.tsx`: business-scoped entries were dropped when `:businessSlug` could not be resolved. Now resolved from the viewer's default business; measured 8 links on all of `/`, `/b/zemnas/leads`, `/team`, `/integrations`, `/my-day` |
| Navigation resolved by display-label lookup | **REMOVED_AS_DEAD_UI** | The label-matching builder is gone. `ADMIN_NAV` in `packages/core/src/permissions.ts` is now a fixed tree keyed by stable route identifiers, filtered only by permission |
| `/b/:slug/setup` (Business Setup landing) 404 | **WIRED** (fixed) | Page created; returns 200 |
| `/b/:slug/setup/signals` (Signals tab) 404 | **WIRED** (fixed) | Page created; reads real `scoring_rules`; returns 200 |
| `/b/:slug/insights` (Insights destination) 404 | **WIRED** (fixed) | Page created; reads `getOverview` / `getReplyThemes` / `getStepPerformance`; returns 200 |
| Nested modules unreachable from the sidebar | **WIRED** (fixed) | Secondary tab strip renders per active section: Business Setup, Team & Accounts, Integrations, Insights |
| `/` rendered a My Day task list instead of the Admin Overview | **WIRED** (fixed) | `apps/web/src/app/page.tsx` now redirects an admin to `/b/<slug>/overview` and a standard user to `/my-day` |

All 28 navigation destinations were fetched with an authenticated session: **28 × HTTP 200, zero 404**.

## 3. Disabled controls — reviewed, all legitimate

All 15 matches for "disabled" were inspected. None is a control disabled without reason:

- `my-lead-sources/page.tsx:83`, `b/[slug]/lead-sources/page.tsx:270`, `import-wizard.tsx:236` — prose
  stating that credit-spending actions are disabled by product scope (Apollo enrichment OFF).
- `team/page.tsx:15,67` — `disabled` is a **user account status value**, not a disabled control.
- `login-form.tsx:85` — a message shown when local sign-in is switched off.
- `trash-restore.tsx:33,36,59,60`, `companion-shell.tsx:253,258` — a `disabled` prop that carries a
  `title` explaining *why* ("You can restore a lead you own or created"), which is the correct pattern.

State: `WIRED`.

## 4. Static values rendered as runtime state

| Location | Literal | State | Evidence |
| --- | --- | --- | --- |
| `b/[slug]/leads/[id]/page.tsx` | `PAUSED · REPLY` | **WIRED** (fixed) | Bound to real state. `sequenceStateForLead` / `sequenceStepsForLead` (`apps/web/src/lib/repo/sequence.ts:125`, `:193`) read `message_instances`, and the panel renders the step list the frame specifies. A repository-wide search for the literal finds **zero** occurrences in `apps/web/src` |
| same | `CANCELLED` | **WIRED** (fixed) | Derived from stored state — an unsent `LOCKED` step past its due date — rather than rendered as a constant |
| same | `Keep paused` | **WIRED** (fixed) | No longer presented as current state; the sequence panel reports the state the database holds |

`dueMessageForLead` is no longer fetched and discarded: the sent content it returns is displayed in a
`MessageBlock` with `ImmutableNotice`, and `FINAL_UI_ACCEPTANCE.md` §4 records the runtime check.

The three strings *are* verbatim in the live Figma A04/U06 frames, which is why they were correct as
**sample** values and wrong as **runtime** values. They are now runtime values only.

## 5. Hard list caps — all six sites fixed

| Route | Was | State | Evidence |
| --- | --- | --- | --- |
| `/b/:slug/leads` | `slice(0, 5)` | **WIRED** (fixed) | The cap is gone. `PAGE_SIZE` is real, the pager spans the dataset, and `pageSize` is an operator-selectable override bounded 1–100. Verified against a running build: **24 records tile across 5 pages at `pageSize=5` with no gap and no duplicate (union = total = 24)**, and out-of-range pages clamp by redirect rather than rendering a blank table |
| `/my-leads` | `slice(0, 5)` | **WIRED** (fixed) | Same pager implementation |
| `/my-day/upcoming` | `slice(0, 3)` | **WIRED** (fixed) | Cap removed |
| `/my-day/done` | `slice(0, 3)` | **WIRED** (fixed) | Bounded at 50 by a documented observation window ("don't scan all interaction history"), which is a design choice, not an inaccessible-data defect |
| `/my-lead-sources` (recent imports) | `slice(0, 3)` | **WIRED** (fixed) | Cap removed |
| `/b/:slug/overview` (senders, recent activity) | `slice(0, 3)` ×2 | **WIRED** (fixed) | Caps removed |

A repository-wide search for `.slice(0, n)` row limits over `apps/web/src` and `packages/ui/src`
returns **no row caps**. The remaining matches are string/date formatting (`createdAt.slice(0, 10)`) and
`timeline.slice(0, 5)` inside the Companion's lead-detail API response, which is a deliberate
payload-size bound on a "recent history" preview rather than a cap on what the CRM UI can reach.

**The Leads case mattered most.** It was not a preview: pagination existed at `PAGE_SIZE` 25 and the
slice was applied to the already-paginated page, so with more than 25 leads records 6–25 were
unreachable by any UI path. That is fixed and the boundary is now exercised by
`scripts/baseline-verify/a03-leads-verify.mjs` (42/42 checks).

## 6. Links to non-existent routes

Three routes were referenced by the navigation and returned 404. All three are now real pages (§2).
Two further links were corrected to avoid a dead target:

| Location | Problem | State |
| --- | --- | --- |
| `app-shell.tsx` Team & Accounts child `/team/:userId/permissions` | No single user is known from the sidebar; resolved naively this is `/team//permissions` | **WIRED** — resolves to the concrete user while editing that user, otherwise to `/team`; never renders a malformed path |

## 7. Sentinel hacks — retired

| Location | Sentinel | State |
| --- | --- | --- |
| `identities/[id]/actions.ts` — unassign via `assignIdentityManagerAction` | `toUserId: ''` | **WIRED** (fixed) — a dedicated `unassignIdentityAction` writes an `identity_unassigned` audit event and deliberately no `identity_transfers` row (that table names a recipient). `assignSchema.toUserId` is a `uuid`; the empty-string mapping is gone |
| `identities/[id]/actions.ts` — scope selection | empty-string scope sentinel | **WIRED** (fixed) — same workstream |

Both are backed by `identity-lifecycle` (20 tests) and `business-archive` (16 tests). No Restore
control exists for identities, deliberately: retirement is terminal (migration `0025`).

## 8. Webhooks

| Surface | State | Evidence |
| --- | --- | --- |
| Webhook configuration storage | `WIRED` | Configuration persists; secrets are stored hashed |
| Secret hashing | `WIRED` | No plaintext secret is returned by any read path |
| UI implies active delivery? | **Not falsely implied** | The configuration screen does not claim delivery occurs |
| Outbound delivery / retry / dead-letter worker | `INTENTIONALLY_DEFERRED` | Deferred by the brief's explicit scope. Documented in `DEPLOYMENT_READINESS.md` |

## 9. Dead UI removed

| Item | State | Evidence |
| --- | --- | --- |
| `ADMIN_NAV` flat 21-entry structure | **REMOVED_AS_DEAD_UI** | Replaced by the two-level Figma tree with `children` |
| Label-based nav resolution (`pickItem`-style lookup) | **REMOVED_AS_DEAD_UI** | Not present in this branch; replaced by identifier-keyed resolution |
| `apps/web/middleware.ts` | **REMOVED_AS_DEAD_UI** | **Deleted.** Next.js resolves middleware to `src/middleware.ts` when a `src` directory exists, so the root-level file never executed — `.next/server/middleware-manifest.json` listed no middleware, and every Companion request failed with "Nexus is unreachable" while the server was answering. The CORS policy it documented is enforced as static headers in `next.config.ts`, which becomes the single source of truth. `apps/web/src/middleware.ts` does not exist either, so nothing is silently shadowed. Confirmed live: preflight 204 with `Access-Control-Allow-Origin: *` from a `chrome-extension://` origin |

## 10. Findings reported as defects that are not defects

| Finding | Verdict | Evidence |
| --- | --- | --- |
| Three companion operations (`mark-connection-sent`, `mark-message-sent`, `reactivate`) "refuse the administrator" | **NOT A DEFECT — verification fixture mismatch** | `mark_connection_sent` / `mark_message_sent` are `SECURITY DEFINER`, so RLS does not apply inside them; their only `42501` raise is `has_identity_business_access(identity, lead.business)`. Confirmed against the seeded database: the **matched** pair (Osama on a Zemnas lead) succeeds; the **mismatched** pair (Bisma on a Zemnas lead) is refused with `42501 outreach identity … is not authorized for business …` — the guard working as designed. The remaining usability point is real and recorded: the refusal is surfaced as the blanket *"You do not have permission to do that."*, which points at the operator's permissions instead of the unmet identity/business precondition |
| `COMP-BIND-OK` "refuses a free identity" | **NOT A DEFECT — two fixture errors** | (1) The harness paired Bisma's identity with a business that identity is not granted — the seeded grants are not what the names suggest ("Bisma - Lavish" is granted `ai-integrations`). (2) A fixed `installId` meant a previous run's active binding was still held, and `browser_sessions_active_identity_key` (`0010`) permits exactly one active session per identity. Both are fixed in `db-setup.mjs` / `harness.mjs` by deriving the business from the identity's own grant and releasing stale `baseline-install-%` bindings |
| The Leads quick-filter chips | **REAL DEFECT — FIXED** | Found by this audit and fixed in the same baseline. Every chip sent its key as the value `1`, so "Replied" and "Dormant" linked to `?status=1` and returned **0 rows while the chip advertised 2 and 1**. Extracted to `apps/web/src/lib/quick-filter-chips.ts` with 10 regression tests. Verified live: the chips now emit `?status=replied` / `?status=dormant` and each returns exactly the count it advertises |

## 11. Summary

| State | Count |
| --- | --- |
| `WIRED` (including the fixes recorded in this baseline) | 22 |
| `INTENTIONALLY_DEFERRED` | 1 |
| `REMOVED_AS_DEAD_UI` | 4 |
| **`BLOCKED` actionable surfaces** | **0** |

Every surface this audit originally recorded as `BLOCKED` is now either wired to a real backend path or
removed. The one open item that is not a wiring defect — service-token inserts refused by the embedded
PGlite engine — is recorded in `API_BASELINE_VERIFICATION.md` §5 (F-2) and gated on confirmation
against real PostgreSQL in `DEPLOYMENT_READINESS.md`.
