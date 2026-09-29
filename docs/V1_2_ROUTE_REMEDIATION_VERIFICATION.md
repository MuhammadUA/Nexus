# NEXUS V1.2 — Route Remediation Verification (independent code audit)

**Audit date:** performed against the committed tree only. **No code was modified, no commit was
created, and no database was changed** by this audit. The only file it adds is this document, which is
left uncommitted.

**Verdict: NEEDS FIXES** — one class of dead link survives the remediation, reachable from My Day and
My Day · Upcoming. Everything else the remediation claimed is verified from source.

**Method.** Every claim below was re-derived from the committed source: the matrix was parsed out of
`packages/core/src/permissions.ts`, the page tree was read from `apps/web/src/app/**/page.tsx`, and the
destination sweep walked every `.ts`/`.tsx` file under `apps/web/src` — using throwaway scripts kept
**outside** the repository so that the artifact is not audited with the project's own test helpers. The
resulting inventory is at `E:\CRM\audit\route-inventory.json` and
`E:\CRM\audit\path-literals.json` (outside the repo, not committed).

---

## 1. Git verification

| Item | Value |
| --- | --- |
| Branch | `v1.2/ai-first-redesign` |
| HEAD SHA | `6faa60a965e9c5586b0988e6fd84f7716745a42f` |
| `origin/v1.2/ai-first-redesign` | `6faa60a965e9c5586b0988e6fd84f7716745a42f` (equal to HEAD) |
| Working tree | clean — `git status --porcelain` returns 0 lines (before this document was written) |
| `origin/integration/final` | `50aa3c19005c7ac34777554ff4bbc7035c13aef4` (unchanged) |
| `origin/main` | `4e0d7c471c544ded0ceefa056dcfac7ea7b6432f` (unchanged) |
| Tag `nexus-predeploy-baseline-v1` | `dbf6127200365d21a8978d9ec913906a7d660a91` locally and on the remote (`^{}` = `f93bff4f…`), unchanged |

The remediation commit `6faa60a` changes **52 files**, all under `apps/web`, `packages/core/src/permissions.ts`,
`packages/core/src/route-access.test.ts`, `packages/ui/src/app-shell.tsx` and `docs/`.

---

## 2. Admin authorization verification — PASS

### 2.1 The fix, in source

`packages/core/src/permissions.ts:985-995`:

```ts
function scopedPermissions(role, grants, businessId) {
  if (role === null || businessId === null) return null;
  if (role === 'admin') return new Set<Permission>(ADMIN_PERMISSIONS);   // ← the fix, line 991
  const grant = grants.find((candidate) => candidate.businessId === businessId);
  if (grant === undefined) return null;
  return effectivePermissions(role, grant, businessId);
}
```

`routeAccessAllowed` selects it for a business-scoped requirement
(`packages/core/src/permissions.ts:942-946`), and the global branch no longer trusts the caller:

```ts
const subject = isBusinessScopedRoute(requirement.route)
  ? scopedPermissions(params.role, params.grants, params.businessId ?? null)
  : params.role === 'admin'
    ? new Set<Permission>([...ADMIN_PERMISSIONS, ...params.unionPermissions])
    : unionFromGrants(params.role, params.grants);
```

| Requirement | Verification |
| --- | --- |
| Admin, `role = admin`, **0** `user_business_access` rows, business-scoped route | `scopedPermissions` returns `ADMIN_PERMISSIONS` without consulting `grants` → allowed (`reason: 'granted'`). Tested for Business Setup, ICPs, Agent Jobs, Insights, AI and Automations at `packages/core/src/route-access.test.ts:197-219`, and on a sibling business with no grant at `:221-231`. |
| Admin on **global** routes (`/team`, `/settings`, `/businesses`, `/integrations`) | `role === 'admin'` branch → union of `ADMIN_PERMISSIONS`, independent of grants |
| Config pages (Business Setup, ICPs, Sequences, Knowledge, Signals, AI, Integrations, Team, Automations) | 54/54 declared routes: admin decision `PASS` — see the table in §6 |
| No fake grants | `apps/web/e2e/harness.mjs:284-292` queries `user_business_access` for the administrator and **throws** if the count is not 0; the grant it writes is for the *restricted* operator only (`:277`) |
| Hidden business still 404s | Pages resolve the slug **before** the guard — e.g. `app/b/[slug]/setup/page.tsx:33-36`, `setup/icps/page.tsx:75-79`, `agent-jobs/page.tsx:140-143`, `insights/page.tsx:77-80`, `leads/[id]/page.tsx:136-138` — through `resolveBusiness` (`lib/viewer-context.ts:116-118`), which looks only in `context.businesses`. That list comes from `listBusinesses` (`lib/repo/businesses.ts`), which reads `public.businesses` under RLS and filters `deleted_at is null`. So a hidden or deleted business never reaches the guard: `notFound()`. |
| Normal users still require grants | non-admin path → `grant === undefined → null` → `no_grant_for_business` (`permissions.ts:948-956`). Tested at `route-access.test.ts:260-285`. |
| Managers cannot bypass permissions | `effectivePermissions` is the only builder for a non-admin, and it subtracts `ADMIN_ONLY_PERMISSIONS` last (`permissions.ts:276-289`); global routes re-derive the union instead of accepting it (`unionFromGrants`, `:1004-1015`). Tested at `route-access.test.ts:286-301` (manager with grant but without the permission → `permission_denied`) and `:369-395` (a grant listing `settings.manage` cannot escalate). |
| API clients remain scoped | The MCP path never calls `routeAccessAllowed`. It authorises with `requireScope(credential, handler.scope, businessId)` (`apps/web/src/app/api/v1/mcp/route.ts:1338-1344`), which checks the token's scopes **and** `credential.businessIds.includes(businessId)` (`lib/gateway.ts:155-169`). RLS additionally admits an API client only through `is_api_client_allowed` / `api_client_business_ids` inside `has_business_access`. |
| RLS remains unchanged | §8 — zero database files changed. `has_business_access` (0001) already contained `is_admin()`, which is *why* an ungranted administrator can see businesses at all; the defect was purely in the route guard. |

### 2.2 What the administrator's `ViewerContext` contains

`lib/viewer-context.ts:77-86`: an admin's permission set starts from `ADMIN_PERMISSIONS` and adds the
union over grants; for an admin with no grants it is exactly `ADMIN_PERMISSIONS`, so the sidebar and
the guard agree. `visibleNavItems` (used at `viewer-context.ts:93`) therefore offers the whole
administration, which is what the crawl observed.

---

## 3. Route inventory verification — PASS

Rebuilt independently for this audit by reading `apps/web/src/app/**/page.tsx` and the TypeScript
matrix directly (a throwaway script kept outside the repository, which does **not** import the
project's own test helpers, so the artifact is not audited with itself).

| Measure | Audit result |
| --- | --- |
| Physical pages | **54** |
| `ROUTE_PERMISSIONS` application entries | **54** (47 canonical + **7 aliases**) |
| Distinct internal destination shapes | **41** |
| Destination occurrences scanned | **243** |
| Navigation entries (`ADMIN_NAV` + `USER_NAV` flattened) | **34** |
| Dead destinations (`href`, `router.push`, `redirect`, `revalidatePath`) | **0** |
| Undeclared pages | **0** |
| Declared routes with no page | **0** |
| Broken aliases (missing target / alias-of-alias / target has no page / page does not redirect) | **0** |
| Pages that name a route they do not own | **0** |
| Navigation entries without a declaration or without a page | **0** |
| Operational tabs without a page | **0** |
| Legacy `/leads/...` links | **0** |
| Business-scoped destinations without a business | **0** |

**Coverage caveat, and the defect it hid.** Those four call shapes miss a path that is *returned by a
helper* and rendered by its caller. A superset sweep of **every** `/`-prefixed literal in the app
source (385 literals, again read-only and outside the repository) found one such builder — see §5.2.
The remediation's own test (`apps/web/test/route-wiring.test.ts`) scans the same four shapes, which is
why it reports 0 dead links while a real one exists; the claim "dead links: 0" is therefore **not**
verified, and this audit reports it as a finding.

---

## 4. Business selector verification — PASS

The previous defect was that the administrator's "All Businesses" roll-up supplied the placeholder slug
`__all__` to business-scoped navigation routes, producing `/b/__all__/overview` and
`/b/__all__/insights` links that 404'd.

| Check | Evidence |
| --- | --- |
| The placeholder is defined once | `lib/repo/businesses.ts:66` `ALL_BUSINESSES_ID = '__all__'`; used only at `:866` to build the switcher's roll-up option, marked `isRollUp: true` |
| The shell never uses a roll-up as a slug | `components/shell.tsx:54-55`: `const defaultBusiness = businesses.find((b) => b.isRollUp !== true) ?? businesses[0]; const effectiveSlug = businessSlug ?? defaultBusiness?.slug;` |
| Selecting the roll-up routes somewhere real | `components/shell.tsx:71-75`: `if (target.isRollUp === true) { router.push('/businesses'); return; }` — `/businesses` is a declared page (`business.create`) |
| The flag reaches the shell | `app/(app)/layout.tsx:51-56` and `app/b/[slug]/layout.tsx:139-144` both map `isRollUp: option.isRollUp`; these are the only two `Shell` call sites |
| A business-scoped page cannot be reached with the placeholder | `app/b/[slug]/layout.tsx:118-122` resolves the raw param and 404s; the shell is given `business.key` (`:138`), i.e. the resolved key, never the request's param |
| Only two files mention `__all__` | the audit's placeholder sweep returns exactly `components/shell.tsx` and `lib/repo/businesses.ts`; no `/b/all/` or `/b/__all__/` link exists anywhere in the source |
| No-slug case | `app/(app)/layout.tsx:23-30` passes `businesses={[]}` when the viewer has none, so business-scoped entries drop out of the sidebar instead of rendering as dead links (`AppShell.resolveRoute` returns `null` without a slug) |

Runtime confirmation from the crawl: the sidebar entries on a global screen resolved to
`/b/ai-integrations/…` and `/b/zemnas/…` (real keys), and the crawl asserts the landing path equals the
clicked link's own href, so a placeholder segment would fail loudly.

---

## 5. Lead route verification — **FAIL** (one class of dead link)

### 5.1 Verified correct

| Surface | Evidence |
| --- | --- |
| Canonical detail `/b/:businessSlug/leads/:leadId` | physical page `app/b/[slug]/leads/[id]/page.tsx`, declared `ROUTE_PERMISSIONS` entry, guarded with its own route |
| User alias `/my-leads/:leadId` | `app/(app)/my-leads/[id]/page.tsx`, declared `aliasOf: '/b/:businessSlug/leads/:leadId'`, resolves the owning business through RLS (`lib/lead-links.ts`) and redirects |
| Edit Lead | canonical `app/b/[slug]/leads/[id]/edit/page.tsx` with the action moved beside it; aliases `/my-leads/:leadId/edit` and `/leads/:leadId/edit` both declared and both redirecting |
| Task / Snooze | real routes `/tasks/new` and `/snooze`; the `:leadId` paths are declared aliases onto them |
| Row menus, list links, trash, duplicate review, reactivation, profile queue, agent jobs, overview, enrichment workspace | all use `/b/${businessSlug}/leads/${leadId}` with the slug in hand, or `/my-leads/${id}` on the user surface |
| Old literal `/leads/<id>` hrefs | none remain: the only mentions are comments explaining the removal (`my-profile-queue/actions.ts:72`, `snooze/actions.ts:104`, `tasks/new/actions.ts:107`) |

### 5.2 The surviving dead link

**`lib/today-view.ts:72-81`** builds the destination for every My Day queue item:

```ts
export function focusHref(item: TodayItem): string {
  if (item.taskId !== null) return `/leads/${item.leadId}?task=${item.taskId}`;
  if (item.category === 'connections') return `/leads/${item.leadId}?focus=connection`;
  if (item.stepOrder !== null && item.stepOrder >= 2) return `/leads/${item.leadId}?focus=followup&step=${item.stepOrder}`;
  if (item.category === 'accepted_message1') return `/leads/${item.leadId}?focus=message1`;
  if (item.category === 'overdue') return `/leads/${item.leadId}?focus=overdue`;
  return `/leads/${item.leadId}`;
}
```

`/leads/:id` is not a page — the audit's page tree contains no `/leads/[id]` (only `/leads/[id]/edit`,
which is the declared alias). The helper is **rendered** in two places and **pushed** in a third:

| Call site | Shape | Reachability |
| --- | --- | --- |
| `app/(app)/my-day/upcoming/page.tsx:47` | `href={focusHref(item)}` on the row's **Open** button | the page is declared, guarded and was opened successfully by the crawl |
| `components/today-list.tsx:160` | `router.push(focusHref(item))` when a row is opened | `TodayList` is rendered by `app/(app)/my-day/page.tsx:95` |
| `components/today-list.tsx:77` | `router.push(focusHref(next))` — the **Work Next** button | same component/page |
| `lib/repo/today.ts:24,32` | imports and re-exports `focusHref`, which is what the My Day pages import | — |

So on a queue with any items, **Open** on My Day and My Day · Upcoming, and **Work Next**, navigate to a
404. The queue is scoped to one operator (`getTodayQueue` takes `actingUserId` and calls
`public.get_today_queue($1, …)` — `lib/repo/today.ts`), and the fixture's tasks and sequence
enrollments belong to the seeded operator accounts, so the crawl's administrator session can have an
empty queue: the defect is live for a `user`-role operator whose queue has items, which is the ordinary
case in production.

Why the earlier work missed it:

* the route inventory scans four call shapes with an inline literal; a path *returned* from a helper is
  invisible to it, so the suite reports 0 dead links;
* the browser crawl opened `/my-day`, `/my-day/upcoming` and `/my-day/done` and asserted the heading,
  the route and the absence of console errors, but never clicked a queue row — and as a grantless
  administrator its own queue is not the populated one. The coverage gap is therefore twofold: no
  row clicks, and no run as an operator with work in their queue.

A secondary observation, not a defect in itself: no page reads a `focus=`/`task=` query parameter on
the lead detail, so even with a corrected path the "land on the exact actionable step" rule
(`tasks_and_my_day.today_action_rule`) is not implemented on the canonical route.

---

## 6. Permission matrix consistency — PASS

Every declared route with a page, its guard and its status. *Alias* marks a route whose page only
redirects; *alias-of* names the canonical route it redirects to.

| Route | Physical page | Permission entry | Guard | Alias / redirect | Status |
| --- | --- | --- | --- | --- | --- |
| `/login` | `/login` | — (none required) | n/a (no permission declared) | — | PASS |
| `/` | `/` | — (none required) | n/a (no permission declared) | — | PASS |
| `/b/:businessSlug/overview` | `/b/[slug]/overview` | insights.view | requireRouteAccess | — | PASS |
| `/b/:businessSlug/leads` | `/b/[slug]/leads` | lead.view_all | requireRouteAccess | — | PASS |
| `/b/:businessSlug/leads/:leadId` | `/b/[slug]/leads/[id]` | lead.view_all | requireRouteAccess, canAccessRoute | — | PASS |
| `/b/:businessSlug/leads/:leadId/edit` | `/b/[slug]/leads/[id]/edit` | lead.update | requireRouteAccess | — | PASS |
| `/b/:businessSlug/lead-sources` | `/b/[slug]/lead-sources` | lead_source.use | requireRouteAccess | — | PASS |
| `/b/:businessSlug/profile-queue` | `/b/[slug]/profile-queue` | profile_queue.use | requireRouteAccess | — | PASS |
| `/b/:businessSlug/duplicates` | `/b/[slug]/duplicates` | duplicate.review | requireRouteAccess | — | PASS |
| `/b/:businessSlug/trash` | `/b/[slug]/trash` | trash.view | requireRouteAccess | — | PASS |
| `/b/:businessSlug/reactivation` | `/b/[slug]/reactivation` | sequence.reactivate | requireRouteAccess | — | PASS |
| `/businesses` | `/businesses` | business.create | requireRouteAccess | — | PASS |
| `/businesses/new` | `/businesses/new` | business.create | requireRouteAccess | — | PASS |
| `/b/:businessSlug/setup` | `/b/[slug]/setup` | knowledge.manage | requireRouteAccess | — | PASS |
| `/b/:businessSlug/setup/brain` | `/b/[slug]/setup/brain` | knowledge.manage | requireRouteAccess | — | PASS |
| `/b/:businessSlug/setup/icps` | `/b/[slug]/setup/icps` | icp.manage | requireRouteAccess | — | PASS |
| `/b/:businessSlug/setup/sequences` | `/b/[slug]/setup/sequences` | sequence.manage | requireRouteAccess | — | PASS |
| `/b/:businessSlug/setup/knowledge` | `/b/[slug]/setup/knowledge` | knowledge.manage | requireRouteAccess | — | PASS |
| `/b/:businessSlug/setup/signals` | `/b/[slug]/setup/signals` | scoring.manage | requireRouteAccess | — | PASS |
| `/team` | `/team` | user.manage | requireRouteAccess | — | PASS |
| `/team/:userId` | `/team/[id]` | user.manage | requireRouteAccess | — | PASS |
| `/team/:userId/permissions` | `/team/[id]/permissions` | user.manage | requireRouteAccess | alias of `/team/:userId` | PASS |
| `/identities` | `/identities` | identity.manage | requireRouteAccess | — | PASS |
| `/identities/:identityId` | `/identities/[id]` | identity.manage | requireRouteAccess | — | PASS |
| `/integrations` | `/integrations` | integration.manage | requireRouteAccess | — | PASS |
| `/b/:businessSlug/automations` | `/b/[slug]/automations` | automation.manage | requireRouteAccess | — | PASS |
| `/b/:businessSlug/agent-jobs` | `/b/[slug]/agent-jobs` | lead.view_all | requireRouteAccess | — | PASS |
| `/b/:businessSlug/setup/ai` | `/b/[slug]/setup/ai` | knowledge.manage | requireRouteAccess | — | PASS |
| `/b/:businessSlug/lead-sources/import` | `/b/[slug]/lead-sources/import` | lead_source.use | requireRouteAccess | — | PASS |
| `/b/:businessSlug/insights` | `/b/[slug]/insights` | insights.view | requireRouteAccess | — | PASS |
| `/b/:businessSlug/insights/messaging` | `/b/[slug]/insights/messaging` | insights.view | requireRouteAccess | — | PASS |
| `/settings` | `/settings` | settings.manage | requireRouteAccess | — | PASS |
| `/my-access` | `/my-access` | identity.self_assign | requireRouteAccess | — | PASS |
| `/business-domains` | `/business-domains` | domain.manage | requireRouteAccess | — | PASS |
| `/my-day` | `/my-day` | business.view | requireRouteAccess | — | PASS |
| `/my-day/upcoming` | `/my-day/upcoming` | business.view | requireRouteAccess | — | PASS |
| `/my-day/done` | `/my-day/done` | business.view | requireRouteAccess | — | PASS |
| `/my-leads` | `/my-leads` | lead.view_assigned + lead.view_own | requireRouteAccess | — | PASS |
| `/my-leads/:leadId` | `/my-leads/[id]` | lead.view_assigned + lead.view_own | requireRouteAccess | alias of `/b/:businessSlug/leads/:leadId` | PASS |
| `/my-leads/:leadId/edit` | `/my-leads/[id]/edit` | lead.update | requireRouteAccess | alias of `/b/:businessSlug/leads/:leadId/edit` | PASS |
| `/tasks/new` | `/tasks/new` | task.create | requireRouteAccess | — | PASS |
| `/my-leads/:leadId/task` | `/my-leads/[id]/task` | task.create | requireRouteAccess | alias of `/tasks/new` | PASS |
| `/snooze` | `/snooze` | lead.snooze | requireRouteAccess | — | PASS |
| `/my-leads/:leadId/snooze` | `/my-leads/[id]/snooze` | lead.snooze | requireRouteAccess | alias of `/snooze` | PASS |
| `/leads/:leadId/edit` | `/leads/[id]/edit` | lead.update | requireRouteAccess | alias of `/b/:businessSlug/leads/:leadId/edit` | PASS |
| `/my-lead-sources` | `/my-lead-sources` | lead_source.use | requireRouteAccess | — | PASS |
| `/my-lead-sources/file` | `/my-lead-sources/file` | lead_source.use | requireRouteAccess | — | PASS |
| `/my-lead-sources/paste` | `/my-lead-sources/paste` | lead_source.use | requireRouteAccess | — | PASS |
| `/my-lead-sources/google` | `/my-lead-sources/google` | lead_source.use | requireRouteAccess | — | PASS |
| `/my-lead-sources/apollo` | `/my-lead-sources/apollo` | lead_source.use | requireRouteAccess | — | PASS |
| `/my-profile-queue` | `/my-profile-queue` | profile_queue.use | requireRouteAccess | — | PASS |
| `/my-duplicates` | `/my-duplicates` | duplicate.review | requireRouteAccess | — | PASS |
| `/my-trash` | `/my-trash` | trash.view | requireRouteAccess | — | PASS |
| `/trash` | `/trash` | trash.view | none (pure redirect) | alias of `/my-trash` | PASS |

**Result: 54/54 pages declare a permission entry and enforce it** — 47 canonical screens call
`requireRouteAccess` with their own route pattern, and 7 alias pages either call the guard and then
`redirect()` (5 of them) or are pure redirects whose destination enforces the requirement
(`/trash`, and `/` which requires nothing). No page guards a route it does not own, and the audit's
guard scan reports 0 unguarded pages and 0 mis-named routes.

Two details worth recording:

* the five alias pages that call `requireRouteAccess` and then redirect are
  `/my-leads/:leadId`, `/my-leads/:leadId/edit`, `/my-leads/:leadId/task`, `/my-leads/:leadId/snooze`
  and `/leads/:leadId/edit`; each names its *own* declared pattern, so an operator who could not open
  the canonical screen is refused at the alias too;
* `/login` and `/` declare no permission (`permissions: []`) by design, and
  `route-access.test.ts:353-363` asserts that every other entry declares one.

---

## 7. Automated tests review — PASS, with one coverage gap recorded

| Required coverage | Where | Verdict |
| --- | --- | --- |
| Admin without grants | `packages/core/src/route-access.test.ts:197-231` (6 screens + sibling business), plus the whole crawl, which runs as a grantless admin because `harness.mjs:284-292` fails provisioning otherwise | real |
| Manager without grants | `route-access.test.ts:260-272` | real |
| Manager with grants | `route-access.test.ts:302-312`; manager with a grant but missing the permission at `:286-300` | real |
| Restricted user | `route-access.test.ts:314-336` (api_client), the audit-table block in `apps/web/test/route-wiring.test.ts` (`:406-468`: 24 administration screens must be refused, 17 work screens must stay allowed) and `v1-2-route-crawl.spec.mjs:474-537`, which signs in as `restricted@nexus.e2e` (a real account created through the app's own KDF by `scripts/create-test-user.ts`) and asserts both that the admin screens are not offered and that 11 direct navigations fail closed | real |
| Route crawl | `apps/web/e2e/v1-2-route-crawl.spec.mjs`, 11 tests, 56 clicks | real |
| Placeholder slug prevention | Not directly unit-tested; the crawl's sidebar test asserts each click lands on the link's own href, which would fail on a `__all__` segment. The audit verified it statically (§4) | partially covered |
| Form redirects | `v1-2-route-crawl.spec.mjs` — Edit → Save, Create Task and Snooze each assert the browser lands on the canonical lead detail, plus the "Back to lead" link | real |

**Are the tests mocked in a way that hides failures?** No:

* `route-access.test.ts` and `route-wiring.test.ts` call the real functions and read the real
  filesystem — no `vi.mock`, no stubs;
* the crawl drives the real production build (`next start`) against a real PGlite database created by
  the production migration set, and signs in through the real `/login` form (`harness.mjs:372-470`
  fills `#email`/`#password`, reads the values back and clicks submit — no cookie is injected, and the
  audit found no `addInitScript`, `page.route` or `document.cookie` in the suite);
* every crawl test that records HTTP failures asserts the list is empty (6 such assertions), and the
  body is checked for the app's not-found text;
* the inventory suite cannot pass vacuously: it asserts `physicalPages.length > 40`,
  `destinations.length > 50`, more than 30 guarded pages inspected, more than 6 tabs found, more than
  30 clicks recorded and more than 20 distinct destinations.

**Coverage gap to close:** no suite clicks a My Day queue row, and the inventory's destination scan
does not follow a path returned by a helper. Both are why §5.2 survived.

---

## 8. Database impact — NONE

```
git diff --name-only f3f6a31..6faa60a -- packages/db   → 0 files
git diff --name-only f3f6a31..6faa60a -- packages/db/migrations → 0 files
git diff f3f6a31..6faa60a | grep -c 'create policy|drop policy|security definer|grant execute|revoke |enable row level|force row level|alter table'  → 0
```

No migration was added or edited, no table/column/policy/trigger changed, no `SECURITY DEFINER`
function was touched, and no grant or revoke was added. The migration set remains `0001`–`0036` as
committed in the two preceding commits. `has_business_access` (0001) is unchanged and already admitted
`is_admin()`; the fix is entirely in the application's route guard.

## 9. Security impact — NONE beyond the intended authorization correction

* **Widened:** a global administrator (`users.role = 'admin'`) may now reach business-scoped screens in
  every business they can already see. They could already reach that business's *data*: RLS admits an
  admin through `is_admin()` in `has_business_access`, and `canAccessBusiness` (`permissions.ts:344`)
  returns true for an admin independently of grants. So the change removes a guard-level contradiction
  rather than granting new data access.
* **Not widened:** non-admins still need a grant per business (verified in §2.1); `ADMIN_ONLY_PERMISSIONS`
  is still subtracted for them; the global-route union is still re-derived, so a forged
  `unionPermissions` cannot carry an admin-only permission; hidden/deleted businesses still 404 before
  the guard; API clients are still bounded by token scopes *and* `credential.businessIds`.
* **RLS:** unchanged and still the data boundary.
* **New files:** `apps/web/scripts/create-test-user.ts` writes a credential with the application's own
  `hashPassword` and is used only by the E2E harness in an isolated temp database; `lib/scrypt-kdf.ts`
  is the same implementation moved out of the `server-only` module so the scripts can share it
  (the app still imports it through `lib/password.ts`, which keeps `import 'server-only'`).

---

## 10. Final report

```
NEXUS ROUTE REMEDIATION CODE AUDIT
SHA:                    6faa60a965e9c5586b0988e6fd84f7716745a42f
Branch:                 v1.2/ai-first-redesign (clean, equal to origin)
Admin zero-grant access: PASS
Business selector:       PASS
Route inventory:         PASS (54 pages / 54 entries / 243 destinations / 0 dead by the scanned shapes)
Dead links:              FAIL — 6 dead destination variants from lib/today-view.ts:72-81,
                         reachable via my-day, my-day/upcoming and the "Work Next" button
Permission matrix:       PASS (54/54 declared and guarded; 7 aliases each verified)
Database impact:         NONE
Security impact:         NONE (route-guard correction only; RLS, tokens and grants unchanged)
Tests reviewed:          16 route/link inventory, 24 route authorization, 11 route crawl
                         (56 clicks), plus the provisioning assertions; no mocks that hide failures
Overall:                 NEEDS FIXES
```

**The one fix required.** `focusHref()` must return a canonical lead path — the business slug has to be
resolved (the helper holds only a lead id, so either the queue query should also select the business
key, or the caller should resolve through the same RLS-scoped lookup `lib/lead-links.ts` uses). The
same change should decide whether the `focus=`/`task=` intent is carried as a query parameter the lead
detail understands, because today no page reads it. Two tests should accompany it: a My Day row click
and the "Work Next" button in the crawl, and a destination-scan rule that follows a path returned from
a helper rather than only the four inline call shapes.
