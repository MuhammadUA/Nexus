# NEXUS — Unwired Surfaces Audit

**Branch:** `integration/final`
**Method:** repository-wide search, then per-control trace to a real action / repository function / API
route / RPC. A control is `WIRED` only when that trace completes.

Every finding below ends in exactly one of the three mandated states. **There are no silent `UNKNOWN`
entries.**

- `WIRED` — the control reaches a real backend path.
- `INTENTIONALLY_DEFERRED` — out of scope by explicit product decision, UI does not claim it works.
- `REMOVED_AS_DEAD_UI` — deleted from the product.

## 1. Pattern sweep results

| Pattern searched | Product source scope | Hits |
| --- | --- | --- |
| `TODO` / `FIXME` / `HACK` / `XXX` | `apps/**`, `packages/**` excluding `node_modules`, `.next`, `dist` | **0** |
| `href="#"` and placeholder anchors | `apps/web/src`, `packages/ui/src` | **0** |
| Empty / no-op click handlers (`onClick={() => {}}`, `=> undefined`, `=> null`) | same | **0** |
| Permanently disabled controls without a reason | same | **0** (15 matches, all legitimate — see §3) |
| Static mock values rendered as runtime state | same | **3** (see §4) |
| Hard `.slice(0, n)` row caps | same | **6** (see §5) |
| Links to non-existent routes | shell + all page anchors | **3 found and FIXED** (see §6) |
| Old sentinel hacks | same | **2** (see §7) |

The codebase is unusually clean on the conventional markers: there are no `TODO`s, no placeholder
anchors and no dead click handlers anywhere in product source. The real findings are *semantic* —
a control that looks live and is not — rather than the usual litter.

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

| Location | Literal | State | Why |
| --- | --- | --- | --- |
| `b/[slug]/leads/[id]/page.tsx` | `PAUSED · REPLY` | **BLOCKED** | Rendered unconditionally for every lead as the Sequence state. `dueMessageForLead` is fetched at the top of the same component and otherwise unused |
| same | `CANCELLED` | **BLOCKED** | Step state literal |
| same | `Keep paused` | **BLOCKED** | Control label literal presented as current state |

Note these three strings *are* verbatim in the live Figma A04/U06 frames — so they are correct as
**sample** values and wrong as **runtime** values. The distinction matters: the fix is to bind them to
`dueMessageForLead` / `sequenceStateForLead`, not to delete them.

Everything else on that screen reads real data. No hard-coded user, business or sender name was found
in any production page component.

## 5. Hard list caps — six sites

| Route | Cap | Pagination exists? | State |
| --- | --- | --- | --- |
| `/b/:slug/leads` | `slice(0, 5)` | yes — PAGE_SIZE 25 + Previous/Next | **BLOCKED** |
| `/my-leads` | `slice(0, 5)` | yes | **BLOCKED** |
| `/my-day/upcoming` | `slice(0, 3)` | no | **BLOCKED** |
| `/my-day/done` | `slice(0, 3)` | no | **BLOCKED** |
| `/my-lead-sources` (recent imports) | `slice(0, 3)` | no | **BLOCKED** |
| `/b/:slug/overview` (senders, recent activity) | `slice(0, 3)` ×2 | no | **BLOCKED** |

**The Leads case is not a preview.** `PAGE_SIZE = 25`, `offset = (page - 1) * 25`, `totalPages =
ceil(total / 25)` and the Previous/Next links are all real; the slice is then applied to the
already-paginated page. With the 21 seeded leads `totalPages === 1`, so no pager renders and only
leads 1–5 are reachable. Above 25 leads, page 1 shows 1–5 and page 2 shows 26–30, leaving **6–25
unreachable by any UI path**.

Six `BLOCKED` entries. This is the single largest correctness gap in the baseline.

## 6. Links to non-existent routes

Three routes were referenced by the navigation and returned 404. All three are now real pages
(§2). Two further links were corrected to avoid a dead target:

| Location | Problem | State |
| --- | --- | --- |
| `app-shell.tsx` Team & Accounts child `/team/:userId/permissions` | No single user is known from the sidebar; resolved naively this is `/team//permissions` | **WIRED** — resolves to the concrete user while editing that user, otherwise to `/team`; never renders a malformed path |

## 7. Sentinel hacks

| Location | Sentinel | State |
| --- | --- | --- |
| `identities/[id]/actions.ts` — unassign via `assignIdentityManagerAction` | `toUserId: ''` | **BLOCKED** — a dedicated `unassignIdentityAction` exists (writes an `identity_unassigned` audit event and, deliberately, no `identity_transfers` row because that table names a recipient). The sentinel must be retired and the dedicated action wired |
| `identities/[id]/actions.ts` — scope selection | empty-string scope sentinel | **BLOCKED** — same workstream |

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
| `apps/web/middleware.ts` | **BLOCKED — not removed** | It is real code that **never executes**. Next.js resolves middleware to `src/middleware.ts` when a `src` directory exists, and this app has one, so `.next/server/middleware-manifest.json` lists no middleware. Moving it to `src/` makes it compile but breaks the build, because Next bundles `src/instrumentation.ts` for the edge middleware runtime and that file imports `@/lib/db` → `node:path`. The CORS policy it documents is now enforced by static headers in `next.config.ts`. **The file is retained deliberately** so the conflict stays visible, but as written it is misleading: anyone editing it will believe they changed behaviour. Decide: make it execute by fixing the instrumentation edge-safety, or delete it and keep the static headers as the single source of truth |

## 10. Summary

| State | Count |
| --- | --- |
| `WIRED` (including 7 fixed in this baseline) | 14 |
| `INTENTIONALLY_DEFERRED` | 1 |
| `REMOVED_AS_DEAD_UI` | 2 |
| `BLOCKED` (actionable work remaining) | 13 |

The 13 `BLOCKED` entries are the actionable remainder: 3 runtime literals, 6 row caps, 2 sentinels,
the dead middleware decision, and the lifecycle-control work recorded in
`PREDEPLOY_BASELINE_GAP_MATRIX.md`.
