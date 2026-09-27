# NEXUS — Pre-Deployment Baseline Report

**Status: PARTIAL.** The integration is underway and the shell/navigation work is complete and verified,
but eight areas remain `BLOCKED` and the full release gate has not been run to green. **No tag was
created and `integration/final` was not pushed.**

| | |
| --- | --- |
| Branch | `integration/final` |
| Backend source | `backend/remediation` @ `9f009186cfc976f27bd85a3406b2448053266b26` |
| Frontend donor | `codex/figma-frontend` @ `4427dd2efef8e3542174596ccae34944710855c4` (selective only, never merged) |
| Integration SHA at this report | `cebd25d` |
| Baseline tag | **not created** |
| Pushed | **no** |
| Working tree | clean apart from `scripts/baseline-verify/` (verification scratch, untracked) |

## 1. Integration strategy actually applied

`HYBRID_BY_MODULE`, per the brief's §6. One integrated system on top of the authoritative backend:
the shell and information architecture follow the live Figma structure, while permissions, data,
behavior and lifecycle rules stay with the backend contracts. No wholesale merge of the donor branch
was performed and neither source branch was modified.

Module-by-module direction is recorded in `PREDEPLOY_BASELINE_GAP_MATRIX.md`.

## 2. What was rebuilt or fixed

### 2.1 Admin shell and navigation — complete and verified

The single highest-impact defect in the whole project. `ADMIN_NAV`
(`packages/core/src/permissions.ts`) is now the final Figma seven-destination IA in three groups —
WORK (Overview, Leads), CONFIGURE (Business Setup, Team & Accounts, Integrations), ADMIN (Insights,
Settings) — keyed by **stable route identifiers**, with a new optional `children` field carrying
secondary destinations.

Two independent failure modes were removed:

1. **Label-based resolution.** Resolving nav entries by matching `item.label` against a hard-coded
   string drops the entry the moment a label is reworded.
2. **Unresolvable `:businessSlug`.** Business-scoped entries were filtered out entirely when no slug
   was bound, which is why the sidebar collapsed on `/`, `/team`, `/integrations` and the user
   surfaces. `AppShell` now falls back to the viewer's default business.

Measured, with one seeded database and one admin session (238px sidebar, 1202px content — both
matching frame A02):

| Route | Before | After |
| --- | --- | --- |
| `/` | 4 links | **8 links** |
| `/b/zemnas/leads` | 8 | 8 |
| `/b/zemnas/setup/icps` | 8 | 8 |
| `/team` | 4 | **8** |
| `/integrations` | 4 | **8** |
| `/my-day` | 4 | **8** |

### 2.2 Content measure

`--nx-content-max-width` 1120px → **1202px**. The 82px shortfall was the largest measurable layout
deviation from the design.

### 2.3 Secondary navigation

A tab strip renders per active section, so nested modules are reachable without a flat 21-item
sidebar: Business Setup (`Overview / ICPs / Sequences / Knowledge / Signals`), Team & Accounts,
Integrations, and Insights.

### 2.4 Routes that did not exist

Three destinations referenced by the new IA returned 404. All are now real pages reading live data:

| Route | Content | Data source |
| --- | --- | --- |
| `/b/:slug/setup` | Business Setup landing: context-asset counts, offer/services/personas, value propositions and proof, configuration surfaces | `listOffers`, `listServices`, `listPersonas`, `listValuePropositions`, `listIcps`, `listSequences`, `listKnowledgeAssets`, `listScoringRules` |
| `/b/:slug/setup/signals` | Signals: scoring rules with signal kind, scope, polarity, signed points and active state; Primary ICP rule | `listScoringRules`, `listIcps` |
| `/b/:slug/insights` | Insights parent: reply outcomes and step-level reply rate | `getOverview`, `getReplyThemes`, `getStepPerformance` |

All figures are read from the same repositories the detail screens use, so a summary and its rows
cannot disagree. Nothing is hard-coded from the Figma sample.

**Verified: 28 navigation destinations → 28 × HTTP 200, zero 404.**

### 2.5 Workspace entry point

`/` previously redirected every signed-in viewer to `/my-day`, which is why an administrator saw a
personal task queue where frame A02 specifies a business roll-up. An admin now lands on
`/b/<slug>/overview` (which already implemented A02 correctly with `getOverview`); a standard user
still lands on My Day.

### 2.6 Demo seed now complies with the SENT invariant

`seed-demo-operational.ts` inserted a `SENT` `message_instances` row before its
`message_versions` row, so `assert_sent_message_has_content()` (migration `0021`) correctly refused it
and the database could not be seeded at all. Corrected to the ordering `mark_message_sent` uses —
insert `DYNAMIC` → insert the version → `update … set current_version_id, state='SENT', sent_at`. The
invariant was **not** weakened.

Verified: `node --experimental-strip-types scripts/seed-demo.ts` exits 0 and reports every section.

### 2.7 Companion CORS — the middleware never ran

`apps/web/middleware.ts` documents a CORS policy for `/api/v1/companion/*` and **has never executed**.
Next.js resolves middleware to `src/middleware.ts` when a `src` directory exists, and this app has one,
so `.next/server/middleware-manifest.json` listed no middleware at all. Every panel request therefore
failed with "Nexus is unreachable" while the server was running and answering.

Moving it to `src/` compiles the middleware but breaks the build: Next bundles `src/instrumentation.ts`
for the edge middleware runtime, and that file imports `@/lib/db` → `node:path`, which edge cannot
resolve.

Resolved by declaring the headers statically in `next.config.ts`. `*` is safe for this surface
specifically because it is `Authorization: Bearer` authenticated and sets no cookie (`set-cookie` is
absent from the sign-in response), so no third-party page can borrow an operator's session.

Verified on the wire from a `chrome-extension://` origin: preflight 204 with
`Access-Control-Allow-Origin: *`, sign-in 200 with a token, `/me` 200, and a browser-context fetch
that previously threw `Failed to fetch` now completes.

## 3. Verification performed

| Check | Result |
| --- | --- |
| `tsc --noEmit` (apps/web) | PASS |
| `tsc --noEmit` (packages/core) | PASS |
| `tsc --noEmit` (packages/ui) | PASS |
| Production build (web) | PASS |
| Database seed from scratch | PASS |
| All 28 nav routes return 200 with an authenticated session | PASS |
| Companion CORS from an extension origin (raw header dump + browser fetch) | PASS |
| Sidebar/content measure against frame A02 | PASS (238px / 1202px) |
| Root redirect target for an admin | PASS |
| Unwired-surface pattern sweep | PASS (0 `TODO`, 0 placeholder anchors, 0 no-op handlers) |
| API baseline verification | **in progress** (subagent) |
| MCP baseline verification | **in progress** (subagent) |
| Auth/RBAC/RLS regression | not run |
| Ingestion / dedupe / sequences / sent-invariant runtime | not run |
| Extension build + unit + real-origin E2E + side-panel boot | not run |
| Extension visual check against companion frames U22–U30 | not run |
| `pnpm install --frozen-lockfile` → typecheck → lint → test → db:verify → build, from a clean checkout | not run end-to-end |
| Repository cleanup execution | dry-run inventory only (**nothing deleted**) |

`pnpm exec next build`/`start` intermittently fails in this worktree with `ENOENT` on
`.next/server/*-manifest.json`; the direct `.\node_modules\.bin\next.cmd` works reliably. The release
gate must account for that.

## 4. Repository cleanup

Inventory only. **Nothing was deleted, moved or renamed.**

**Headline finding:** two complete PGlite/PostgreSQL data directories are **committed to git**, from
commit `4e0d7c4`:

| Path | Size | Tracked files |
| --- | --- | --- |
| `apps/web/.data-corrupt-20260925165536/` | 52.1 MiB | 1,353 |
| `apps/web/.data-broken-171559/` | 36.3 MiB | 1,353 |

88.3 MiB and 2,706 files ≈ 12% of the repository, and duplicated regenerable state. `.gitignore`
missed them because its rules match a directory named exactly `.data`, while these are `.data-<stamp>`.
They contain no source references and no `git status` output, so the tree looks pristine. Removal
requires `git rm -r` plus a commit — an index change the owner should approve, and it is the only
change available that actually shrinks the repository.

Otherwise the repository is clean: **zero** tracked logs, archives, `*.tsbuildinfo`, build output or
images. Full detail, per-file dispositions and the proposed-but-unexecuted removal list are in
`REPO_CLEANUP_REPORT.md` and `_repo-cleanup-inventory.json`.

Sizes: repository excluding `.git` = 731.1 MiB; genuine source/docs/spec/tests = **3.5 MiB** across 326
files; `node_modules` = 450.6 MiB (kept); removable excluding `node_modules` = **277.0 MiB**.

Dead-code candidates found with proof (report-only, nothing removed): unused dependencies
`packages/db → @nexus/core`, `packages/db → zod`, `apps/extension → @nexus/core`; unused exports
`Breadcrumbs`, `SelectorOption`, `CountChip`, `leadStateAccent`, `leadStateLabel`, `ProvenanceBlock`;
unused CSS `nx-companion__segmented`, `nx-nav__count`, `nx-spacer`. Important negatives disproved:
`packages/ui/src/tabs.tsx` is live, the ~21 seemingly-unused CSS modifiers are built dynamically, and
all 44 routes have inbound references.

## 5. Required documents

| Document | State |
| --- | --- |
| `docs/PREDEPLOY_BASELINE_GAP_MATRIX.md` | written |
| `docs/UNWIRED_SURFACES.md` | written |
| `docs/REPO_CLEANUP_REPORT.md` | written |
| `docs/_repo-cleanup-inventory.json` | written |
| `docs/PREDEPLOY_BASELINE_REPORT.md` | this file |
| `docs/MCP_BASELINE_VERIFICATION.md` | pending (verification in progress) |
| `docs/API_BASELINE_VERIFICATION.md` | pending (verification in progress) |
| `docs/DEPLOYMENT_READINESS.md` | not yet written |
| `docs/FINAL_UI_ACCEPTANCE.md` | not yet written |

## 6. Remaining blockers

In priority order; each is implementable work with backend support already present.

1. **Business lifecycle controls** — archive / restore / guarded delete. Actions exist at
   `businesses/[id]/actions.ts`; no control calls them. Typed refusal
   `business_has_protected_history` must be rendered with its preservation counts, offering Archive.
2. **Identity lifecycle controls** — dedicated unassign / archive / guarded delete; retire the
   `toUserId: ''` sentinel. Typed refusal `identity_has_attribution` with attribution counts, offering
   Retire. No Restore control (retirement is terminal, migration `0025`).
3. **DeepSeek message drafting UI** — `draftMessageAction` and the nine-value `AiFailureKind` exist;
   nothing invokes them. Live-provider smoke is `PENDING_HOST_ENV` if no key is present.
4. **Lead Detail sequence literals** — `PAUSED · REPLY`, `CANCELLED`, `Keep paused` are rendered as
   runtime state for every lead while `dueMessageForLead` is fetched and discarded.
5. **Lead Detail history reachability** — `timeline.slice(0,3)` with no scroll, paging or Load More.
6. **Six hard row caps** — Leads, My Leads, My Day Upcoming, My Day Done, Lead Sources, Overview
   (×2). On Leads this is not a preview: pagination is real at PAGE_SIZE 25 and the slice is applied
   to the already-paginated page, so above 25 leads records 6–25 are unreachable by any UI path. The
   Figma row counts (5, 3) should be honoured as a real page size, with the existing pager spanning
   the dataset.
7. **Figma Leads composition** — status-chip row, five filter selects, `Source` column, row action
   menu, bulk-actions bar.
8. **ICP Manager rebuild** — the frame's compact list plus selected-ICP scoring/routing panel
   (positive scoring, exclusions, Primary ICP rule, default sequence, assignment).
9. **Dead `middleware.ts` decision** — make it execute by fixing instrumentation edge-safety, or
   delete it and keep the static headers as the single source of truth. As written it is misleading.
10. **Committed PGlite data directories** — needs owner approval for the `git rm` commit.
11. **Full release gate from a clean checkout** — not yet run to green.
12. **Extension build, unit tests, real-origin E2E, side-panel boot and companion visual check** —
    not yet run.

## 7. Known deferred

- **Outbound webhook delivery worker** — configuration storage persists and secrets stay hashed; the
  UI does not claim delivery occurs. Deferred by explicit scope. This is the only intentional deferral.

## 8. Deployment

No provider-specific deployment was performed. No DNS, domain, Supabase project or hosting change was
made. Provider-neutral documentation (`docs/DEPLOYMENT_READINESS.md`) is **not yet written**.

One portability note already established: CORS for the Companion is currently expressed as static
headers in `next.config.ts`, so it is host-agnostic; the dead middleware file is not a deployment
dependency.

## 9. Honest statement of completeness

The shell and navigation integration — the defect that most affected whether the product works at all —
is complete, verified, and committed. The remaining work is the wiring and verification layer: eight
`BLOCKED` areas, two verification legs in progress, and the release gate. The brief's own criterion for
"baseline complete" is that every one of its twenty conditions holds; **nine do not**, so calling this
complete would be false. The tag was deliberately not created, because the brief forbids tagging with
unresolved baseline blockers, and the branch was not pushed.
