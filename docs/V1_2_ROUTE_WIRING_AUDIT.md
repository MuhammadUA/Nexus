# NEXUS V1.2 — Route / Access / Wiring Audit

**Branch:** `v1.2/ai-first-redesign` · **Scope:** routing, route authorization and internal links only.
**Status: PASS** — every internal destination in the product resolves, every navigation entry is
declared and reachable, a grantless administrator can open every screen, and a restricted operator is
refused the administration.

This document is the record of a remediation pass that the Preview forced. The previous browser suite
opened the screens it already knew about, with `page.goto`, signed in as an administrator who had been
granted the business. Both of those hid real defects: a screen that no link can reach, and a screen
that only answers 404 for the one account that is supposed to administer it. The suite now builds an
inventory from the filesystem and clicks every destination as two different operators
(`apps/web/test/route-wiring.test.ts`, `apps/web/e2e/v1-2-route-crawl.spec.mjs`).

---

## 1. What was broken, and what fixed it

### 1.1 A global administrator with no business grant got 404 on every business screen

**Confirmed, and the most serious of the set.** `routeAccessAllowed()` judged a business-scoped route
against that business's `user_business_access` row alone:

```ts
function scopedPermissions(role, grants, businessId) {
  if (role === null || businessId === null) return null;
  const grant = grants.find((candidate) => candidate.businessId === businessId);
  if (grant === undefined) return null;   // ← an administrator with no grant landed here
  return effectivePermissions(role, grant, businessId);
}
```

A production administrator has an account and **no grant rows**: their reach comes from the role, and
the per-business table records *delegated* access for managers and users. So every screen guarded by
`requireRouteAccess(context, { route: '/b/:businessSlug/...', businessId })` answered `notFound()` —
Business Setup, ICPs, Sequences, Knowledge, Signals, AI, Agent Jobs, Insights, Automations, the whole
administration.

**Fix** (`packages/core/src/permissions.ts`): a global administrator holds `ADMIN_PERMISSIONS` in every
business, with or without a grant. Two boundaries keep that narrow rather than a general loosening:

* visibility is checked *before* the guard runs — a page resolves the slug against the businesses the
  viewer can see (`resolveBusiness`) and 404s there, so naming a business does not reveal it, and RLS
  remains the data boundary;
* the grant stays authoritative for everyone else: a manager or user with no grant for the business
  still gets `no_grant_for_business`.

A grant's `revokedPermissions` is deliberately not applied to an administrator. Revoking a permission
from an account that can grant itself any permission is not a security boundary; honouring it produced
the perverse state where adding a grant to an admin *reduced* their access. The union for a global
route is also derived from `ADMIN_PERMISSIONS` rather than trusted from the caller.

**No fake grants.** The end-to-end provisioning used to insert a `user_business_access` row for the
administrator, which is exactly the workaround that hid this. It now asserts the opposite: the
administrator has **zero** grants, and the suite fails to start if a grant is ever re-added.

| Case | Before | Now |
| --- | --- | --- |
| Admin, zero grants, `/b/:slug/setup` | `notFound()` | allowed |
| Admin, zero grants, `/b/:slug/setup/icps` | `notFound()` | allowed |
| Admin, zero grants, `/b/:slug/agent-jobs` | `notFound()` | allowed |
| Admin, zero grants, `/b/:slug/insights` | `notFound()` | allowed |
| Manager without a grant | refused | refused (`no_grant_for_business`) |
| User without a grant | refused | refused (`no_grant_for_business`) |
| Manager with a grant, missing permission | refused | refused (`permission_denied`) |
| Manager with a grant and the permission | allowed | allowed |

Covered by `packages/core/src/route-access.test.ts` ("a global admin needs no business grant") and by
the crawl, which signs in as a grantless administrator and clicks the whole navigation.

### 1.2 The user Trash screen answered 404 to everybody

`apps/web/src/app/(app)/trash/page.tsx` called `requireRouteAccess(context, { route: '/trash' })`, and
`/trash` was **not in `ROUTE_PERMISSIONS`**. The guard fails closed on an undeclared route, so the
screen was unreachable — and `/my-trash`, the entry `USER_NAV` points at, was a one-line redirect
*into* it. Two navigation entries and the screen they named were all dead.

**Fix:** the screen now lives at `/my-trash` (the address the navigation offers and the matrix
declares), guarded by `/my-trash`; `/trash` is a declared alias that redirects to it. The four server
actions that revalidated `/trash` now revalidate `/my-trash`, which is the path that actually renders.

### 1.3 Links to lead screens that do not exist

`/leads/<id>` is not a page. The canonical detail is `/b/:businessSlug/leads/:leadId`, and
`/my-leads/:leadId` is the user alias. Six call sites linked to the non-existent paths, including the
"Back to lead" link on the edit screen and the redirect after saving a task or a snooze:

| File | Was | Now |
| --- | --- | --- |
| `(app)/my-day/done/page.tsx` | `/leads/${entry.leadId}` | `/my-leads/${entry.leadId}` (alias → canonical) |
| `(app)/my-leads/page.tsx` | `/leads/${lead.id}` · `/leads/${lead.id}/edit` · `/trash` | `/my-leads/${lead.id}` · `/my-leads/${lead.id}/edit` · `/my-trash` |
| `(app)/snooze/page.tsx` | `/leads/${lead.id}` | `/my-leads/${lead.id}` |
| `(app)/tasks/new/page.tsx` | `/leads/${lead.id}` | `/my-leads/${lead.id}` |
| `components/lead-row-menu.tsx` | `/leads/${leadId}/edit` | `/b/${businessSlug}/leads/${leadId}/edit` |
| `(app)/leads/[id]/edit/page.tsx` (the screen itself) | back link to `/leads/${lead.leadId}` | the canonical detail of the business it belongs to |

**No guessed slug.** The lists and the actions hold a lead id, not a slug, so
`apps/web/src/lib/lead-links.ts` resolves the owning business through the same RLS-scoped read as
everything else and returns `null` for a lead the viewer cannot see. `revalidatePath` targets are
resolved the same way: a `revalidatePath` for a path that is not a page is a silent no-op, which is
how `revalidatePath('/leads/<id>')` and `revalidatePath('/automations')` never refreshed anything.

### 1.4 Forms that saved and then went nowhere

The edit, task and snooze actions returned a state object and left the operator on the form. They now
redirect to the canonical lead detail, which is the round trip the screens promise:

* **Edit Lead → Save →** canonical lead detail;
* **Create Task →** canonical lead detail (a task belongs to a lead);
* **Snooze →** canonical lead detail.

Each redirect resolves the path rather than guessing it, and the edit screen also carries a real
"Back to lead" link, so the affordance works from a bookmark and from the alias routes rather than
relying on browser history.

### 1.5 The "All Businesses" roll-up was used as a business slug

The crawl found this immediately, and it is the kind of defect that only a click can find. The
switcher's first entry for an administrator is the `All Businesses` roll-up, whose slug is the
placeholder `__all__`. The shell substituted `businesses[0].slug` into business-scoped navigation
routes on every global screen, so `/team`, `/integrations` and `/businesses` rendered sidebar links
like `/b/__all__/overview` and `/b/__all__/insights` — dead links, 404 on every click.

**Fix:** the roll-up is marked (`BusinessOption.isRollUp`) and is never used as a route segment; the
shell substitutes the first *real* business. Choosing the roll-up in the dropdown now lands on
`/businesses`, the admin hub that lists them all, instead of on a route that does not exist.

### 1.6 Pages that declared a requirement and did not enforce it

Sixteen screens rendered without calling the guard, so a viewer could open a screen the matrix says
they may not. They now call `requireRouteAccess` with their own declared route: the two business lead
screens, My Day and its two views, My Leads, the five Lead Sources screens, the Profile Queue,
Duplicate Review, Snooze and Create Task.

---

## 2. The route matrix, resolved

Generated from `ROUTE_PERMISSIONS` and `routeAccessAllowed` by
`apps/web/test/route-wiring.test.ts` ("the audit table"), so this table cannot drift from the code.
The two access columns are decisions, not hand-written claims.

* **admin (no grant)** — a global administrator with **zero** `user_business_access` rows.
* **restricted** — a `user`-role operator with a `user`-level grant on the business and every
  capability boolean off.

| UI label | route (matrix) | rendered href / physical page | alias of | required permission | business-scoped? | admin, zero grants | restricted user | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Sign in | `/login` | `/login` | — | — | no | n/a | allowed | PASS |
| Workspace entry | `/` | `/` | — | — | no | n/a | allowed | PASS |
| Overview | `/b/:businessSlug/overview` | `/b/[slug]/overview` | — | `insights.view` | yes | PASS | refused | PASS |
| Leads | `/b/:businessSlug/leads` | `/b/[slug]/leads` | — | `lead.view_all` | yes | PASS | refused | PASS |
| Lead detail | `/b/:businessSlug/leads/:leadId` | `/b/[slug]/leads/[id]` | — | `lead.view_all` | yes | PASS | refused | PASS |
| Edit lead | `/b/:businessSlug/leads/:leadId/edit` | `/b/[slug]/leads/[id]/edit` | — | `lead.update` | yes | PASS | allowed | PASS |
| Lead Sources | `/b/:businessSlug/lead-sources` | `/b/[slug]/lead-sources` | — | `lead_source.use` | yes | PASS | allowed | PASS |
| Profile Queue | `/b/:businessSlug/profile-queue` | `/b/[slug]/profile-queue` | — | `profile_queue.use` | yes | PASS | allowed | PASS |
| Duplicate Review | `/b/:businessSlug/duplicates` | `/b/[slug]/duplicates` | — | `duplicate.review` | yes | PASS | allowed | PASS |
| Trash | `/b/:businessSlug/trash` | `/b/[slug]/trash` | — | `trash.view` | yes | PASS | allowed | PASS |
| Reactivation | `/b/:businessSlug/reactivation` | `/b/[slug]/reactivation` | — | `sequence.reactivate` | yes | PASS | refused | PASS |
| Businesses | `/businesses` | `/businesses` | — | `business.create` | no | PASS | refused | PASS |
| New business | `/businesses/new` | `/businesses/new` | — | `business.create` | no | PASS | refused | PASS |
| Business Setup | `/b/:businessSlug/setup` | `/b/[slug]/setup` | — | `knowledge.manage` | yes | PASS | refused | PASS |
| Business Brain | `/b/:businessSlug/setup/brain` | `/b/[slug]/setup/brain` | — | `knowledge.manage` | yes | PASS | refused | PASS |
| ICPs | `/b/:businessSlug/setup/icps` | `/b/[slug]/setup/icps` | — | `icp.manage` | yes | PASS | refused | PASS |
| Sequences | `/b/:businessSlug/setup/sequences` | `/b/[slug]/setup/sequences` | — | `sequence.manage` | yes | PASS | refused | PASS |
| Knowledge | `/b/:businessSlug/setup/knowledge` | `/b/[slug]/setup/knowledge` | — | `knowledge.manage` | yes | PASS | refused | PASS |
| Signals | `/b/:businessSlug/setup/signals` | `/b/[slug]/setup/signals` | — | `scoring.manage` | yes | PASS | refused | PASS |
| Team & Accounts | `/team` | `/team` | — | `user.manage` | no | PASS | refused | PASS |
| Team member | `/team/:userId` | `/team/[id]` | — | `user.manage` | no | PASS | refused | PASS |
| Permissions | `/team/:userId/permissions` | `/team/[id]/permissions` | `/team/:userId` | `user.manage` | no | PASS | refused | PASS |
| Outreach Identities | `/identities` | `/identities` | — | `identity.manage` | no | PASS | refused | PASS |
| Channel account | `/identities/:identityId` | `/identities/[id]` | — | `identity.manage` | no | PASS | refused | PASS |
| Integrations | `/integrations` | `/integrations` | — | `integration.manage` | no | PASS | refused | PASS |
| Automations | `/b/:businessSlug/automations` | `/b/[slug]/automations` | — | `automation.manage` | yes | PASS | refused | PASS |
| agent-jobs | `/b/:businessSlug/agent-jobs` | `/b/[slug]/agent-jobs` | — | `lead.view_all` | yes | PASS | refused | PASS |
| ai | `/b/:businessSlug/setup/ai` | `/b/[slug]/setup/ai` | — | `knowledge.manage` | yes | PASS | refused | PASS |
| Import Builder | `/b/:businessSlug/lead-sources/import` | `/b/[slug]/lead-sources/import` | — | `lead_source.use` | yes | PASS | allowed | PASS |
| Insights | `/b/:businessSlug/insights` | `/b/[slug]/insights` | — | `insights.view` | yes | PASS | refused | PASS |
| Messaging Insights | `/b/:businessSlug/insights/messaging` | `/b/[slug]/insights/messaging` | — | `insights.view` | yes | PASS | refused | PASS |
| Settings | `/settings` | `/settings` | — | `settings.manage` | no | PASS | refused | PASS |
| My Access | `/my-access` | `/my-access` | — | `identity.self_assign` | no | PASS | refused | PASS |
| Business Domains | `/business-domains` | `/business-domains` | — | `domain.manage` | no | PASS | refused | PASS |
| My Day | `/my-day` | `/my-day` | — | `business.view` | no | PASS | allowed | PASS |
| upcoming | `/my-day/upcoming` | `/my-day/upcoming` | — | `business.view` | no | PASS | allowed | PASS |
| done | `/my-day/done` | `/my-day/done` | — | `business.view` | no | PASS | allowed | PASS |
| My Leads | `/my-leads` | `/my-leads` | — | `lead.view_assigned + lead.view_own` | no | PASS | allowed | PASS |
| My lead (alias) | `/my-leads/:leadId` | `/my-leads/[id]` | `/b/:businessSlug/leads/:leadId` | `lead.view_assigned + lead.view_own` | no | PASS | allowed | PASS |
| Edit lead (alias) | `/my-leads/:leadId/edit` | `/my-leads/[id]/edit` | `/b/:businessSlug/leads/:leadId/edit` | `lead.update` | no | PASS | allowed | PASS |
| new | `/tasks/new` | `/tasks/new` | — | `task.create` | no | PASS | allowed | PASS |
| Create task (alias) | `/my-leads/:leadId/task` | `/my-leads/[id]/task` | `/tasks/new` | `task.create` | no | PASS | allowed | PASS |
| snooze | `/snooze` | `/snooze` | — | `lead.snooze` | no | PASS | allowed | PASS |
| Snooze (alias) | `/my-leads/:leadId/snooze` | `/my-leads/[id]/snooze` | `/snooze` | `lead.snooze` | no | PASS | allowed | PASS |
| Old edit URL (alias) | `/leads/:leadId/edit` | `/leads/[id]/edit` | `/b/:businessSlug/leads/:leadId/edit` | `lead.update` | no | PASS | allowed | PASS |
| Lead Sources | `/my-lead-sources` | `/my-lead-sources` | — | `lead_source.use` | no | PASS | allowed | PASS |
| file | `/my-lead-sources/file` | `/my-lead-sources/file` | — | `lead_source.use` | no | PASS | allowed | PASS |
| paste | `/my-lead-sources/paste` | `/my-lead-sources/paste` | — | `lead_source.use` | no | PASS | allowed | PASS |
| google | `/my-lead-sources/google` | `/my-lead-sources/google` | — | `lead_source.use` | no | PASS | allowed | PASS |
| apollo | `/my-lead-sources/apollo` | `/my-lead-sources/apollo` | — | `lead_source.use` | no | PASS | allowed | PASS |
| Profile Queue | `/my-profile-queue` | `/my-profile-queue` | — | `profile_queue.use` | no | PASS | allowed | PASS |
| Duplicate Review | `/my-duplicates` | `/my-duplicates` | — | `duplicate.review` | no | PASS | allowed | PASS |
| Trash | `/my-trash` | `/my-trash` | — | `trash.view` | no | PASS | allowed | PASS |
| Trash (alias) | `/trash` | `/trash` | `/my-trash` | `trash.view` | no | PASS | allowed | PASS |

Legend: *physical page* is the file route under `apps/web/src/app`; *alias of* means the page exists
only to redirect to the route named there; *scoped* means the route carries `:businessSlug` and is
judged against that business's own grant.

---

## 3. Ownership decisions for the drifted screens

There was one incoherent answer per screen before this pass; each now has exactly one, and the matrix
records it.

| Screen | Decision | Canonical route | Alias(es) |
| --- | --- | --- | --- |
| Edit Lead (U20) | **Real canonical route** under the business that owns the lead | `/b/:businessSlug/leads/:leadId/edit` | `/my-leads/:leadId/edit`, `/leads/:leadId/edit` |
| Lead Detail | **Real canonical route** (unchanged) | `/b/:businessSlug/leads/:leadId` | `/my-leads/:leadId` |
| Create Task (U18) | **Real route**; the `:leadId` path is an alias onto it | `/tasks/new?lead=<id>` | `/my-leads/:leadId/task` |
| Snooze & Reschedule (U19) | **Real route**; the `:leadId` path is an alias onto it | `/snooze?lead=<id>` | `/my-leads/:leadId/snooze` |
| Team user detail | **Real route**; the permissions section is on it | `/team/:userId` | `/team/:userId/permissions` |
| User Trash (U21) | **Real route** at the address the navigation offers | `/my-trash` | `/trash` |
| Business lead-source modes | **Stale declarations removed** — the business ingestion screen is one page with its own mode tabs, and the four `/b/:slug/lead-sources/{file,paste,google,apollo}` entries had no page and no caller | `/b/:businessSlug/lead-sources` | the `/my-lead-sources/*` screens are the user-surface equivalents |
| Workspace entry point | **Declared with no permission** — it is a redirect whose destination is judged on its own | `/` | — |

Every alias: carries its own permission requirement (so it cannot be a way around the screen it points
at), names a declared non-alias route, and has a physical page that redirects. The inventory test
asserts all three properties, so a future alias that points at a dead route fails the suite.

---

## 4. Route inventory

Produced by `apps/web/test/route-wiring.test.ts`, which reads the filesystem and the matrices:

| Measure | Count |
| --- | --- |
| Physical pages (`src/app/**/page.tsx`) | **54** |
| `ROUTE_PERMISSIONS` entries (application routes) | **54** (7 aliases) |
| Distinct internal destination shapes | **41** |
| Internal destination occurrences scanned | **243** |
| Navigation entries (`ADMIN_NAV` + `USER_NAV`, flattened) | **34** |
| Pages with no declaration | **0** |
| Declared routes with no page | **0** |
| Aliases pointing at a dead or aliased route | **0** |
| Pages that declare a permission and do not guard it | **0** |
| Pages guarding an undeclared route | **0** |
| Dead internal destinations | **0** |
| Links to the old V1.1 lead shape | **0** |
| Business-scoped destinations without a business | **0** |
| Navigation entries whose permission disagrees with the matrix | **0** |

The scan covers `href`, template-literal `href`, `router.push`, `redirect` and `revalidatePath`, with
comments stripped so a path mentioned in prose is not read as a link, and template holes (`${...}`)
reduced to a wildcard segment so a dynamic destination is compared with a dynamic page.

---

## 5. Browser acceptance

`apps/web/e2e/v1-2-route-crawl.spec.mjs` — a dedicated suite, reported separately from the screen
suite. It clicks rather than navigates:

| Crawl | Result |
| --- | --- |
| Admin sidebar destinations, clicked in turn | all opened; the destination is asserted against the link's own href |
| Secondary tabs on every parent, clicked | all opened |
| Operational tabs (Agent Jobs, Channel Accounts, AI, Automations, Imports, Access) | all present and reachable |
| Every lead row's **Open**, plus **Edit lead** and **Add task** from the row menus | all opened the expected screens |
| User-surface screens (16) | all opened, with their headings |
| Alias round trips (`/trash`, `/my-leads/:id`, `/my-leads/:id/edit`, `/leads/:id/edit`, `/my-leads/:id/task`, `/my-leads/:id/snooze`) | all forward to the canonical screen |
| Form round trips: Edit → Save, Create Task, Snooze, plus the "Back to lead" link | all returned to the canonical lead detail |
| Configuration and account screens: every internal link followed | no link answered 4xx/5xx |
| Team member detail and channel account detail | opened |
| Restricted operator: navigation offered, direct navigation refused | admin screens neither offered nor reachable |
| Clicks recorded | **56 clicks across 46 destinations** |
| 404s | **0** |
| 500s | **0** |
| Console errors | **0** |

The crawl also asserts that the responses it received contain no 4xx or 5xx, so a client-side
navigation that renders the not-found screen with a 200 document cannot pass unnoticed.

---

## 6. Reproducing

```powershell
cd E:\CRM\CRM-integration
pnpm run typecheck                 # includes the route matrix and the aliases
pnpm run test                      # apps/web/test/route-wiring.test.ts builds the inventory
pnpm --filter @nexus/web run build # the crawl runs against `next start`
pnpm --filter @nexus/web run e2e   # 26 tests: 15 screen + 11 route-crawl
pnpm --filter @nexus/extension run e2e   # 38 tests (needs a seeded server on :3000)
```

The web suite provisions its own database and **asserts that the administrator it signs in as has zero
`user_business_access` rows**. If someone re-adds the workaround grant, provisioning fails with that
sentence rather than the crawl passing for the wrong reason.

---

## 7. Observations that are not defects

Recorded so they are decisions rather than surprises:

* **Two row menus on the same row.** A lead row renders the V1.2 intelligence actions *and* the
  operational menu, and both use `nx-row-menu`. Opening both at once makes the panels overlap. This is
  not reachable by clicking a single `⋯` (each menu is opened independently), and it is a presentation
  matter rather than a routing one, so it is left alone in this pass.
* **`/my-access` is refused to a plain user.** It requires `identity.self_assign`, a manager default,
  so the tab is not offered on the user surface either — consistent, and unchanged by this pass.
* **The Overview is not a user screen.** It requires `insights.view`, so a `user`-role operator is
  refused `/b/:slug/overview`; their home is `/my-day`. That is the intended IA, not a gap.
* **`companion/*` entries** are extension surfaces, not App Router pages, and are declared with
  `surface: 'extension'`; the inventory only compares `/`-prefixed routes with the page tree.
