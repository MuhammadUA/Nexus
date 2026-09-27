# NEXUS Repository Cleanup — Inventory & Report

**Repository:** `E:\CRM\CRM-integration` (git worktree, branch `integration/final`, HEAD `9f00918`)
**Generated:** 2026-09-27T18:17:51Z
**Mode:** **INVENTORY ONLY — NOTHING WAS DELETED, MOVED, RENAMED OR MODIFIED.**
**Machine-readable companion:** [`docs/_repo-cleanup-inventory.json`](_repo-cleanup-inventory.json)

> ### ⚠️ The single most important finding
>
> **Two complete PGlite/PostgreSQL database directories are COMMITTED to git —
> `apps/web/.data-broken-171559/` and `apps/web/.data-corrupt-20260925165536/` — totalling
> 2,706 tracked files and 92,607,328 bytes (88.3 MiB).**
>
> These are committed build/generated artifacts. They were introduced by commit
> `4e0d7c4` ("NEXUS baseline before parallel frontend and backend remediation").
> `.gitignore` does **not** cover them, because the rules are `apps/web/.data/` and `.data/`
> — which match a directory named exactly `.data`, not `.data-broken-<stamp>` or
> `.data-corrupt-<stamp>`. Because they were never ignored, they were added to the index
> like ordinary source files. **No source file in the repository references either path**
> (proof in [Category 1](#category-1--committed-build--generated-artifacts--stale-database-copies)).
> This is the one genuine "committed build artifact" finding, and it is roughly 12% of the
> entire repository.

---

## Snapshot caveat (read this before acting)

The working tree is **live**. Another agent is running `pnpm install` and builds inside this
exact worktree (port 3000 is in use by it). During this inventory:

- `node_modules/` appeared/grew (now 472,517,628 bytes) — it is being populated by pnpm.
- `apps/web/.next/` appeared (160,628,348 bytes) — a build ran mid-inventory.
- `apps/web/.data/` appeared (37,172,649 bytes).
- The set of modified files grew from 3 to 5 between two consecutive `git status` calls.
- A brand-new untracked directory `scripts/baseline-verify/` appeared.

Every count of untracked/ignored entries below is therefore **point-in-time**. Nothing in
this report was executed against those paths.

---

## Summary table

Byte figures are exact. Sizes > 1 MiB are also shown as MiB (1 MiB = 1,048,576 B).

| Path | Tracked/Ignored | Size | Reproducible | Disposition | Reason |
|---|---|---|---|---|---|
| `apps/web/.data-corrupt-20260925165536/` | **tracked** (1,353 files) | 54,589,872 B (52.1 MiB) | Yes | **safe-to-remove** (needs `git rm` + commit) | **Committed generated artifact.** A full PGlite data dir. Zero source references. Duplicate of regenerable DB state. |
| `apps/web/.data-broken-171559/` | **tracked** (1,353 files) | 38,017,456 B (36.3 MiB) | Yes | **safe-to-remove** (needs `git rm` + commit) | **Committed generated artifact.** Sibling DB snapshot; contains a dead `postmaster.pid` + socket lock. Zero source references. |
| `apps/web/.next/` | ignored | 160,628,348 B (153.2 MiB) | Yes | safe-to-remove | Next.js build output; already outside git. Created mid-inventory by a live build. |
| `apps/web/.data/` | ignored | 37,172,649 B (35.4 MiB) | Yes | safe-to-remove (with care) | Live local embedded DB. Regenerable from migrations + seed. May be held open by the running server. |
| `node_modules/` (root + 230 nested) | ignored | 472,517,628 B (450.6 MiB) | Yes (`pnpm install`) | **keep** | Expected, required, and **currently being written by a running `pnpm install`**. Explicitly *not* clutter. |
| `scripts/baseline-verify/` | **untracked** + 2 ignored logs | 9,252 B | No | **keep** | Active work-in-progress of the concurrent agent. Do not remove. |
| `scripts/baseline-verify/build.log`, `build2.log` | ignored (`*.log`) | 3,504 B | Yes | keep | Live evidence for the concurrent agent; inside the active scratch dir. |
| `docs/` (11 files) | tracked | 218,272 B | No | **keep** | Text audit/contract/spec docs — protected category. Not image blobs. |
| `apps/extension/dist/` | *(does not exist)* | 0 B | Yes | keep | Not tracked and correctly absent; ignored by `dist/`. Must be rebuilt with `pnpm --filter @nexus/extension run build` if ever produced. |
| OS/editor caches (`.DS_Store`, `Thumbs.db`, `.idea/`, `.vscode/`) | — | 0 B | — | **nothing found** | Already covered by `.gitignore`; none present. |

### Finding counts

| Metric | Count |
|---|---|
| **Tracked findings** (committed artifacts) | **1 category / 2 paths / 2,706 files** |
| **Ignored findings** (distinct top-level paths) | **6** |
| **Untracked findings** | **2** (`scripts/baseline-verify/` dir + `db-setup.mjs`) |
| Tracked files that are committed artifacts | 2,706 of 3,032 |
| Tracked files that are *legitimate* source/docs/spec | 326 |

---

## "Size before" figures

| Figure | Bytes | Human |
|---|---|---|
| **Total repo size excluding `.git`** | **766,650,521** | **731.1 MiB** |
| `.git` | worktree pointer file; real gitdir at `E:/CRM/CRM/.git/worktrees/CRM-integration` | — |
| Tracked source, docs, spec, migrations, tests (326 files) | 3,648,212 | 3.5 MiB |
| **Committed artifact bytes (tracked)** | **92,607,328** | **88.3 MiB** |
| **Ignored clutter bytes, excluding `node_modules`** | **197,810,249** | **188.7 MiB** |
| — of which `apps/web/.next/` | 160,628,348 | 153.2 MiB |
| — of which `apps/web/.data/` | 37,172,649 | 35.4 MiB |
| — of which scratch/logs | 9,252 | 9.0 KiB |
| Untracked clutter bytes | 5,748 | 5.6 KiB |
| `node_modules/` (expected — **keep**) | 472,517,628 | 450.6 MiB |

### Per-category clutter totals

| Category | Bytes | MiB |
|---|---|---|
| Committed generated artifacts / stale DB copies (**tracked**) | 92,607,328 | 88.3 |
| Ignored build output (`apps/web/.next/`) | 160,628,348 | 153.2 |
| Ignored local database (`apps/web/.data/`) | 37,172,649 | 35.4 |
| Ignored dependencies (`node_modules` — **KEEP**) | 472,517,628 | 450.6 |
| Scratch/verification folder + logs (live — **KEEP**) | 9,252 | 0.009 |
| OS/editor cache | 0 | 0.0 |
| Tracked logs/test reports/coverage/screenshots/archives/zips | 0 | 0.0 |
| Duplicate generated artifacts (the two committed DB dirs) | 92,607,328 | 88.3 |
| Stale audit output in repo (`docs/`) | 218,272 | 0.2 |

**Total removable excluding `node_modules`: 290,708,177 bytes ≈ 277.2 MiB.**

### Top 10 largest removable items

| # | Path | Bytes | MiB | Tracking |
|---|---|---|---|---|
| 1 | `apps/web/.next/` | 160,628,348 | 153.2 | ignored |
| 2 | `apps/web/.data-corrupt-20260925165536/` | 54,589,872 | 52.1 | **tracked** |
| 3 | `apps/web/.data-broken-171559/` | 38,017,456 | 36.3 | **tracked** |
| 4 | `apps/web/.data/` | 37,172,649 | 35.4 | ignored |
| 5 | `apps/web/.data-corrupt-20260925165536/nexus/base/1/3256` | 4,923,392 | 4.7 | **tracked** |
| 6 | `apps/web/.data-corrupt-20260925165536/nexus/base/1/2608` | 4,145,152 | 4.0 | **tracked** |
| 7 | `apps/web/.data-corrupt-20260925165536/nexus/base/1/1255` | 3,604,480 | 3.4 | **tracked** |
| 8 | `apps/web/.data-corrupt-20260925165536/nexus/base/1/2673` | 2,105,344 | 2.0 | **tracked** |
| 9 | `apps/web/.data-corrupt-20260925165536/nexus/base/1/18148` | 2,023,424 | 1.9 | **tracked** |
| 10 | `apps/web/.data-corrupt-20260925165536/nexus/base/1/2836` | 2,023,424 | 1.9 | **tracked** |

Items 5–10 are single PGlite relation files *inside* item 2 and are listed for shape only —
they are not independent of their parent directory.

---

## Category 1 — Committed build / generated artifacts & stale database copies

**This is the only category containing committed artifacts, and it contains all of them.**

Nothing else in the brief's artifact list is committed. Verified by exhaustive enumeration
over `git ls-files`, all of which returned **zero** matches:

| Pattern searched | Tracked matches |
|---|---|
| `(^|/)(.next|out|dist|build|coverage|.vitest|playwright-report|test-results|.turbo|.data)(/\|$)` | **0** |
| `*.log` | **0** |
| `*.zip`, `*.tar`, `*.tar.gz`, `*.tgz`, `*.7z`, `*.rar` | **0** |
| `*.tsbuildinfo` | **0** |
| `*.png`, `*.jpg`, `*.jpeg`, `*.webp`, `*.gif` | **0** |
| `.DS_Store`, `Thumbs.db`, `.idea/*`, `.vscode/*` | **0** |
| `node_modules` | **0** |

The two `.data-*` directories escape those patterns because the regex `\.data(/|$)` requires
a separator immediately after `.data`, whereas the committed names are
`.data-broken-171559` and `.data-corrupt-20260925165536`. This is also exactly why
`.gitignore` failed to protect them.

### Why they were committed rather than ignored

`.gitignore` contains two relevant lines:

```
# Embedded database (PGlite) and local runtime state
apps/web/.data/
.data/
```

A trailing-slash pattern matches a directory named precisely `.data`. Neither committed
directory has that name, so `git check-ignore` returns **exit 1 (not ignored)** for
`apps/web/.data-corrupt-20260925165536` and for files inside it. A naive
`git status --short` shows **nothing** for them because their content is identical to the
committed blob — they are clean tracked files, invisible as clutter until you look at the
index. This is worth stating plainly because the working tree *looks* pristine.

### Contents confirm these are dead database state

Both directories have **exactly 1,353 files** with identical layout — a duplicated snapshot,
not distinct data:

```
nexus/PG_VERSION              nexus/base/{1,4,5}/…            nexus/global/…
nexus/postgresql.conf         nexus/pg_hba.conf               nexus/pg_ident.conf
nexus/postgresql.auto.conf    nexus/pg_wal/000000010000…      nexus/pg_xact/0000
nexus/postmaster.pid          nexus/.s.PGSQL.5432.lock.out    nexus/pg_filenode.map
```

`postmaster.pid` and `.s.PGSQL.5432.lock.out` are PID and socket lock files from a server
process that is long dead; committing them is meaningless outside the machine that wrote
them.

### Reproducibility

Both are regenerable. The documented path is:

```bash
pnpm --filter @nexus/db run verify      # applies all 25 migrations to a fresh PGlite DB
node --experimental-strip-types apps/web/scripts/seed-demo.ts   # builds demo content
```

`packages/db/scripts/verify.ts` applies every migration from scratch and asserts table,
policy, trigger, function and index counts, plus RLS enforcement and the absence of
forbidden SQL-execution functions. The seed is documented in-file as repeatable
(`--reset` soft-deletes demo businesses first).

**Removing these requires `git rm -r` and a commit** — they are in the index, so a plain
delete would leave 2,706 staged deletions in the working tree. That is a deliberate decision
for the repository owner, not a working-tree cleanup.

---

## Category 2 — Untracked and gitignored clutter in the working tree

`git clean -nd` (dry-run, **never** run with `-f`) returns **empty** — there are no untracked
non-ignored files that `git clean` would remove apart from the live item below.

`git status --short --ignored` reports these top-level ignored paths:

| Path | Bytes | Disposition |
|---|---|---|
| `apps/extension/node_modules/` | 17,920 | keep |
| `apps/web/.data/` | 37,172,649 | safe-to-remove (with care) |
| `apps/web/.next/` | 160,628,348 | safe-to-remove |
| `apps/web/node_modules/` | 16,384 | keep |
| `node_modules/` | 472,517,628 | keep |
| `packages/core/node_modules/` | 0 | keep |
| `packages/db/node_modules/` | 0 | keep |
| `packages/ui/node_modules/` | 0 | keep |
| `scripts/baseline-verify/build.log` | 1,572 | keep (live) |
| `scripts/baseline-verify/build2.log` | 1,932 | keep (live) |

Untracked, non-ignored:

| Path | Bytes | Disposition |
|---|---|---|
| `scripts/baseline-verify/db-setup.mjs` | 5,748 | **keep** — active agent work |
| `scripts/baseline-verify/` (dir) | 9,252 total | **keep** |

`scripts/baseline-verify/` did not exist when this inventory began. It is live working state
belonging to the agent that is currently installing and building. It superficially resembles
a scratch folder, which is exactly why it is called out here: **do not delete it.**

`git clean -ndX` lists only the ignored paths already itemised above (all `node_modules`,
`.next`, `.data`, and the two logs). No `-f` form was run.

---

## Category 3 — Stale local database copies (`apps/web/.data/`)

| Path | Tracking | Bytes | Files |
|---|---|---|---|
| `apps/web/.data/` | ignored | 37,172,649 (35.4 MiB) | 1,353 |

This is the directory the application genuinely uses — it is **not** stale in the sense of
being unreferenced. It is referenced at:

- `apps/web/scripts/smoke-gateway.mjs:21` → `path.join(repoRoot, 'apps', 'web', '.data', 'nexus')`
- `apps/web/scripts/seed-demo.ts:93`, `probe-ui-queries.ts:18`, `dump-ui-ids.ts:11`, `cleanup-verify-business.ts:13`
- `apps/web/scripts/bootstrap-admin.ts:79` and `serve.mjs:64` document `apps/web/.data`

**It is regenerable from the seed script.** `pnpm db:reset` (→ `packages/db/scripts/verify.ts`)
rebuilds the schema from the 25 migrations; `seed-demo.ts` repopulates demo content.
`apps/web/.env.example` documents that leaving `DATABASE_URL` unset selects this embedded
PGlite driver and that the path is *single-process only*.

**Caution:** the server on port 3000 may hold this database open. Deleting it under a running
server is unsafe. `smoke-gateway.mjs:52` itself instructs "Delete apps/web/.data and restart
the server for a full run," confirming deletion is a supported operation *between* runs.

---

## Category 4 — Duplicate generated artifacts across `apps/web`, `apps/extension`, repo root

| Location | Exists | Tracking | Bytes | Note |
|---|---|---|---|---|
| `apps/web/.data/` | yes | ignored | 37,172,649 | live DB |
| `apps/web/.data-broken-171559/` | yes | **tracked** | 38,017,456 | committed DB copy #1 |
| `apps/web/.data-corrupt-20260925165536/` | yes | **tracked** | 54,589,872 | committed DB copy #2 |
| `apps/web/.next/` | yes (mid-inventory) | ignored | 160,628,348 | Next.js output |
| `apps/extension/dist/` | **no** | not tracked | 0 | correctly absent; ignored by `dist/` |
| repo-root `dist/`, `build/`, `out/`, `coverage/` | **no** | not tracked | 0 | correctly absent |

**The duplication is three copies of the same generated artifact class** — and two of the
three are committed. All three contain exactly 1,353 files in an identical layout. The only
copy that should exist in a working tree is `apps/web/.data/`.

**`apps/extension/dist/` — explicitly checked, as instructed.** It does **not** exist on disk
and is **not tracked** (`git ls-files apps/extension/dist` → empty; `Test-Path` → false). It is
covered by `.gitignore` line 5 (`dist/`), so the extension build output is correctly excluded
from version control. If a future cleanup ever removes it, it **must** be rebuilt with:

```bash
pnpm --filter @nexus/extension run build
```

without which the MV3 side panel cannot be loaded. There is nothing to remove today.

---

## Category 5 — OS / editor cache files

**Nothing found.** No `.DS_Store`, `Thumbs.db`, `.idea/`, or user-specific `.vscode/` settings
exist in this worktree, tracked or untracked.

`.gitignore` already handles all of them:

```
.DS_Store
Thumbs.db
.idea/
.vscode/*
!.vscode/extensions.json
```

Note the deliberate exception: `.vscode/extensions.json` is un-ignored, i.e. it is a *shared*
recommendation file rather than user-specific state, and is correctly present as the sole
tracked editor file. No action.

---

## Category 6 — Stale audit output committed inside the repo

11 tracked files under `docs/`, totalling 218,272 bytes (0.21 MiB):

| File | Size |
|---|---|
| `docs/CODEX_IMPLEMENTATION_AUDIT.md` | 43.5 KB |
| `docs/DB_CONTRACT.md` | 25.0 KB |
| `docs/EXTENSION_ACCEPTANCE_AUDIT.md` | 22.8 KB |
| `docs/FRONTEND_CONTRACTS.md` | 21.2 KB |
| `docs/ACCEPTANCE_AUDIT.md` | 20.5 KB |
| `docs/UI_ACCEPTANCE_AUDIT.md` | 19.2 KB |
| `docs/IMPLEMENTATION_MATRIX.md` | 18.8 KB |
| `docs/CODEX_IMPLEMENTATION_AUDIT.json` | 15.3 KB |
| `docs/DEPLOYMENT.md` | 12.5 KB |
| `docs/EXTENSION_SECURITY_AUDIT.md` | 11.3 KB |
| `docs/DESIGN_TOKENS.md` | 3.3 KB |

These are **text** audit and contract documents — there are **no committed PNG/JPEG/screenshot
blobs anywhere in the repository** (verified: zero tracked image files of any kind). The
largest is 43.5 KB. `CODEX_IMPLEMENTATION_AUDIT.json` is a structured implementation-contract
record, not disposable tool output.

**Disposition: keep all of them.** The brief protects audit reports, and at 0.21 MiB total the
size argument for removing them does not exist. The in-repo UI-audit *screenshots* that the
brief anticipated are not here — they live outside the repo (see below).

### External historical evidence (out of scope for deletion)

Reported for completeness only; **not touched**:

| Path | Size |
|---|---|
| `E:\CRM\frontend-comparison\` | 16.04 MiB |
| `E:\CRM\ui-audit\` | 8.92 MiB |
| `E:\CRM\frontend-live-figma-reaudit\` | 4.56 MiB |
| `E:\CRM\.work\` | 0.05 MiB |
| `E:\CRM\extension-probe\` | 0.01 MiB |
| `E:\CRM\.pnpm-store\` | 693.70 MiB (shared pnpm store — **never** delete) |

### Sibling worktrees (inspected read-only, **not modified**)

| Worktree | Branch | Status | Notes |
|---|---|---|---|
| `E:\CRM\CRM` | `codex/figma-frontend` | clean (0 modified) | Ignored: `.work/`, `apps/extension/dist/`, `apps/extension/test-results/`, `apps/web/.data/`, `apps/web/.next/`, `dist/`, many `*.tsbuildinfo`. `git clean -nd` would remove **empty PGlite subdirectories** under `apps/web/.data-broken-171559/` and `.data-corrupt-…` (e.g. `pg_commit_ts/`, `pg_dynshmem/`, `pg_serial/`) — the same two committed DB dirs, here with empty leftover dirs. |
| `E:\CRM\CRM-backend` | `backend/remediation` | 6 modified | `git clean -nd` would remove 4 **untracked** docs: `FRONTEND_COMPARISON_AUDIT.{json,md}` and `FRONTEND_LIVE_FIGMA_REAUDIT.{json,md}` — historical evidence, **keep**. Ignored: `node_modules`, `apps/web/.data/`, `apps/web/.next/`, many `*.tsbuildinfo`. |

---

## Category 7 — Dead code / unused dependency candidates

Method: every declared dependency in all 5 `package.json` files (41 total) was searched with
fixed-string matching for `from '<dep>'`, `from "<dep>"`, `require('<dep>')`, `import('<dep>')`
and `from '<dep>/`. Exports were inventoried and then each symbol checked repo-wide with
`git grep -l -w`. Results below; **nothing was modified.**

### 7a. Genuinely unused dependencies (proof: only the declaration matches)

| Package | Dependency | Section | Proof |
|---|---|---|---|
| `packages/db` | `@nexus/core` | dependencies | `git grep -n '@nexus/core' -- packages/db` → **exactly one hit**, `packages/db/package.json:23`, the declaration. No file under `packages/db/src` or `packages/db/scripts` mentions it. |
| `packages/db` | `zod` | dependencies | `git grep -n -w zod -- packages/db` → **exactly one hit**, `packages/db/package.json:24`, the declaration. (Control: `zod` **is** genuinely imported in `packages/core`, so this is not a repo-wide false positive.) |
| `apps/extension` | `@nexus/core` | dependencies | `git grep -n '@nexus/core' -- apps/extension` → **exactly one hit**, `apps/extension/package.json:19`, the declaration. The extension imports only `@nexus/ui` (`apps/extension/src/sidepanel.tsx:36`). |

### 7b. Unused exports from `@nexus/ui`

Each symbol below has **exactly one occurrence repo-wide: its own definition.** It is
re-exported publicly through `packages/ui/src/index.ts`, so it is reachable API that nothing
currently renders.

| File | Symbol | Evidence |
|---|---|---|
| `packages/ui/src/app-shell.tsx` | `Breadcrumbs` | `git grep -l -w Breadcrumbs` → 1 file (its definition) |
| `packages/ui/src/companion-shell.tsx` | `SelectorOption` | 1 file (its definition) |
| `packages/ui/src/domain.tsx` | `CountChip` | 1 file |
| `packages/ui/src/domain.tsx` | `leadStateAccent` | 1 file |
| `packages/ui/src/domain.tsx` | `leadStateLabel` | 1 file |
| `packages/ui/src/domain.tsx` | `ProvenanceBlock` | 1 file |

`leadStateLabel` / `leadStateAccent` look like the intended lead-state presentation helpers,
but the UI renders lead state through the `LeadStatusChip` component instead — suggesting
superseded helpers rather than missing wiring.

### 7c. Unused CSS classes (medium confidence — flagged `needs-proof`)

150 class names are defined in `packages/ui/src/styles.css`. For each, a whole-word search was
run over `*.ts`/`*.tsx`. **Three** have no consumer in either literal or template-literal form:

| Class | Definition | Occurrences |
|---|---|---|
| `nx-companion__segmented` | `styles.css:1213` | 1 (the rule itself) |
| `nx-nav__count` | `styles.css:621` | 1 (the rule itself) |
| `nx-spacer` | `styles.css:778` | 1 (the rule itself) |

**Important negative control.** An initial pass flagged ~24 more modifier classes as unused
(`nx-alert--green`, `nx-chip--red`, `nx-btn--danger`, `nx-grid--3`, `nx-stack--lg`,
`nx-message--inbound`, `nx-timeline__dot--*`, …). **All of those were disproven** — they are
constructed dynamically:

```
packages/ui/src/primitives.tsx:514  `nx-alert--${accent}`
packages/ui/src/primitives.tsx:163  `nx-chip--${accent}`
packages/ui/src/primitives.tsx:137  `nx-btn--${variant}`
packages/ui/src/primitives.tsx:638  `nx-stack--${size}`
packages/ui/src/primitives.tsx:670  `nx-grid--${cols}`
packages/ui/src/primitives.tsx:544  `nx-timeline__dot--${dot}`
packages/ui/src/primitives.tsx:581  `nx-message--${direction}`
```

Only the three in the table above lack both forms of consumer.

### 7d. Extension `dist/` status

Not committed and not present — see [Category 4](#category-4--duplicate-generated-artifacts-across-appsweb-appsextension-repo-root).
Correctly ignored by `dist/`. Rebuild with `pnpm --filter @nexus/extension run build`.

### 7e. Routes with no inbound links

All **44** `page.tsx` routes were extracted and each route's final path segment searched as a
literal `/segment` across `apps/web/src` and `packages/core/src`.

**Every route has at least one inbound reference. There are no dead routes.**

The weakest is `/my-trash` with exactly one inbound reference — and it is a real one:
`packages/core/src/permissions.ts:738` registers `{ route: '/my-trash', surface: 'user',
permissions: ['trash.view'] }` and `:1045` adds a nav item `{ label: 'Trash', route:
'/my-trash', permission: 'trash.view' }`.

### 7f. Investigated and cleared (explicitly *not* dead code)

| Suspect | Verdict | Proof |
|---|---|---|
| `packages/ui/src/tabs.tsx` | **live** | Not listed in `index.ts` and imported by nobody *directly* — but `packages/ui/src/primitives.tsx:528` re-exports it (`export { Tabs, type TabItem, type TabsProps } from './tabs.js';`) and it is rendered at `apps/web/src/app/b/[slug]/duplicates/page.tsx:209`. |
| `Tabs`, `TabItem`, `TabsProps` | **live** | Same as above. |
| `ErrorState`, `LoadingState`, `Skeleton`, `Overline`, `SectionTitle`, `MessageBlock`, `Timeline`, `TimelineDot`, `TimelineItem`, `VisuallyHidden` | **live / documented API** | A first pass flagged these, but they appear in `apps/web/CONTRIBUTING.md` (the design-kit table) and several are genuinely rendered. Documentation-only matches, not dead code. |
| `@types/*`, `typescript` in every package | **required** | Consumed by the compiler via tsconfig resolution; no `import` statement is expected. |
| `vitest` in `packages/ui`, `apps/*` | **required** | Test runner invoked by the `test` npm script. |
| `next`, `react`, `react-dom` in `apps/web` | **required** | Used implicitly by the Next.js/JSX runtime; modern transform needs no explicit import. `react-dom` is pulled in by Next.js's renderer. |
| `@electric-sql/pglite` in `apps/web` | **required** | Imported indirectly through `@nexus/db`; and directly in `packages/db/scripts/verify.ts`. |
| `esbuild`, `@playwright/test`, `@types/chrome` in `apps/extension` | **required** | Used by `scripts/build.mjs`, `e2e/playwright.config.mjs` and the Chrome API typings respectively. |

---

## Category 8 — Tracked files that appear obsolete

Only one thing in this repository is both tracked and obsolete-looking: the pair of committed
PGlite directories. Their proof is documented in Category 1 and reproduced here in the
required form (which searches were run, what they found):

| Tracked path | Obsolete? | Proof required and gathered |
|---|---|---|
| `apps/web/.data-broken-171559/` (1,353 files) | **Yes** | (1) `git grep -n -I -e 'data-broken'` over **all tracked files** → **exit 1, no match**. (2) `git grep -n -I -e '\.data' -- '*.ts' '*.mjs' '*.json' '*.yaml' '*.yml' ':!apps/web/.data-*'` → every hit is either `.data/<x>` property access on parsed objects (`parsed.data.x`) or `path.join(process.cwd(), '.data', 'nexus')`. The referenced path is `.data`, **never** `.data-broken-171559`. (3) `git check-ignore` → exit 1 (not ignored, hence committable). (4) Name itself records a broken snapshot; contains a dead `postmaster.pid`. (5) File count is identical (1,353) to its sibling, i.e. a duplicate. |
| `apps/web/.data-corrupt-20260925165536/` (1,353 files) | **Yes** | Same five checks; `data-corrupt` → exit 1, no match. The name records a timestamped corrupt snapshot. |

**These are reported only. Nothing was removed.** Deleting tracked files also requires an
index change (`git rm -r`) plus a commit, which is beyond an inventory and is the repository
owner's call.

No other tracked file was found to be obsolete: all 25 migrations, all 25 extension source/e2e
files, all 8 `packages/ui/src` files (including `tabs.tsx`), all `packages/core/src` including
tests, all 11 docs, both `.fig` references, the master spec JSON, the env template, the
lockfile and all seed/codemod/smoke scripts have demonstrated consumers or are protected
reference material.

---

## MUST NOT DELETE

Nothing in this list may be removed by a cleanup pass. Each entry states the reason it is
retained.

### Source code

| Path | Reason |
|---|---|
| `apps/web/src/` (174 files) | Application source: routes, components, `lib/repo/*` data layer, `lib/ai/*`, auth, guard, view models. |
| `apps/web/test/` (17 files) | Test suite plus `stubs/server-only.ts`. |
| `apps/web/middleware.ts`, `apps/web/next.config.ts`, `apps/web/instrumentation.ts`, `apps/web/tsconfig.json`, `apps/web/vitest.config.ts` | Application configuration; `next.config.ts` declares `transpilePackages` for the three workspace packages. |
| `apps/extension/src/` (12 files) | Extension source: `sidepanel.tsx`, `background.ts`, `content.ts`, `linkedin-adapter.ts` (+ its test), `mount.tsx`, `api.ts`, `chrome-actions.ts`, `use-list-state.ts`, `config.ts`, `types.ts`, `globals.d.ts`. |
| `apps/extension/e2e/` (8 files) | Playwright specs + harness/helpers/probe/config. |
| `apps/extension/static/sidepanel.html` | Extension host page; the side panel cannot load without it. |
| `apps/extension/scripts/build.mjs` | The documented extension build implementation. |
| `apps/extension/scripts/package.mjs` | In-repo ZIP packer. Keep **even though no zip is committed** — this is how archives are produced; it is the reason no duplicate generated zip exists. |
| `apps/extension/tsconfig.json`, `apps/extension/vitest.config.mjs`, `apps/extension/package.json` | Extension build/test config + manifest package definition. |
| `packages/ui/src/` (8 files) | Shared design system consumed by **both** hosts — `index.ts`, `tokens.ts`, `primitives.tsx`, `app-shell.tsx`, `companion-shell.tsx`, `domain.tsx`, `tabs.tsx`, `styles.css` (34.5 KB). This shared kit is what makes the "single design language" claim structurally true. |
| `packages/core/src/` | Domain contracts + engines + their tests: `contracts.ts`, `permissions.ts`, `dedupe.ts`, `messaging-rules.ts`, `normalize.ts`, `sequence-engine.ts`, `today-engine.ts`, `vocabulary.ts` and 4 test files. |
| `packages/db/src/` | `client.ts`, `index.ts`, `migrate.ts`, `migrations-dir.ts` — the last implements the `NEXUS_MIGRATIONS_DIR` contract and the cwd-relative resolution the bundled app depends on. |
| `scripts/repair-encoding.mjs` | Encoding-repair tooling; provenance for the NX-007 double-encoded-UTF-8 fix. |

### Migrations, schema contracts and seed scripts

| Path | Reason |
|---|---|
| `packages/db/migrations/` (25 files, `0001`–`0025`) | The entire schema: extensions/helpers, tenancy, business brain, canonical identities, ICPs/leads, outreach identities, sequences, ingestion, integrations/audit, constraints/indexes, triggers/invariants, functions/RPC, RLS, grants, local credentials, user tokens, identity binding scope, snooze type, dedupe lookup, MCP idempotency, sent-requires-content, platform-settings-admin-only, business lifecycle, business delete guard, identity lifecycle. Irreplaceable source of truth. |
| `packages/db/seed/fixtures.ts` | Test fixture seed (deliberately minimal, distinct from the demo seed). |
| `packages/db/scripts/verify.ts` | `pnpm db:verify` / `pnpm db:reset`. Applies all migrations and asserts schema invariants. **This is the regeneration path for local DB state.** |
| `apps/web/scripts/seed-demo.ts` (23.6 KB) | Documented demo/visual-QA seed. The other half of the regeneration path. |
| `apps/web/scripts/seed-demo-operational.ts` (47.7 KB) | Operational demo seed (currently modified by the concurrent agent). |
| `apps/web/scripts/bootstrap-admin.ts` | `pnpm --filter @nexus/web run bootstrap-admin`. |
| `apps/web/scripts/smoke-gateway.mjs`, `smoke-login.mjs` | Documented smoke tests; `smoke-gateway.mjs:52` documents the `.data` deletion-and-restart workflow. |
| `apps/web/scripts/probe-ui-queries.ts`, `dump-ui-ids.ts`, `cleanup-verify-business.ts` | Evidence/verification tooling. |
| `apps/web/scripts/serve.mjs` | The `start` entry point. |
| `apps/web/scripts/codemod-action-guard.mjs`, `codemod-route-guard.mjs`, `codemod-route-guard-business.mjs` | Codemods that produced the enforced guard patterns; retained as provenance. |

### Tests, docs, spec and Figma references

| Path | Reason |
|---|---|
| `docs/` (all 11 files, incl. `CODEX_IMPLEMENTATION_AUDIT.json`, `UI_ACCEPTANCE_AUDIT.md`, `DB_CONTRACT.md`, `FRONTEND_CONTRACTS.md`, `ACCEPTANCE_AUDIT.md`, `DEPLOYMENT.md`, `DESIGN_TOKENS.md`, `IMPLEMENTATION_MATRIX.md`, `EXTENSION_ACCEPTANCE_AUDIT.md`, `EXTENSION_SECURITY_AUDIT.md`) | Audit reports and schema/UI contracts. A protected category; only 0.21 MiB total. |
| `product/Nexus_CRM_Master_Spec_v1.json` (56.5 KB) | Master product spec — source of truth for the whole build. |
| `product/figma/Nexus_User_CRM_Companion_Final.fig` (179.3 KB) | Figma reference — explicitly protected. |
| `product/figma/Nexus_Admin_Backend_Final.fig` (290.2 KB) | Figma reference — explicitly protected. |

### Manifests, lockfile, env templates and workspace config

| Path | Reason |
|---|---|
| `pnpm-lock.yaml` | Single lockfile for the workspace — explicitly protected. |
| `pnpm-workspace.yaml` | Declares `apps/*` and `packages/*` membership. |
| `package.json` (root) | Defines the documented `build`, `test`, `typecheck`, `lint`, `verify`, `db:reset`, `db:verify` scripts. |
| `package.json` in each of the 5 workspace packages | Workspace manifests. |
| `apps/web/.env.example` | Env **template**, deliberately un-ignored by `!.env.example`. Documents `DATABASE_URL`, Supabase vars, `NEXUS_SESSION_SECRET` and `NEXUS_LOCAL_AUTH=1`. |
| `tsconfig.base.json` | Shared TypeScript config. |
| `eslint.config.mjs` | Lint config backing `pnpm lint`. |
| `.gitignore` | The ignore rules this inventory depends on. |
| `.vscode/extensions.json` | The one deliberately un-ignored editor file — a *shared* recommendation, not user-specific state. |

### Extensions, manifests and live state

| Path | Reason |
|---|---|
| `apps/extension/` as a whole | Extension source, e2e, static host page, build/pack scripts and `package.json` manifest. |
| `scripts/baseline-verify/` | **Active work-in-progress** of the agent currently installing/building. Do not remove. |
| `node_modules/` (all 230 nested dirs) | Expected and required; a `pnpm install` is running right now. Only a `pnpm install`-driven rebuild is legitimate. |

### Out of scope for this cleanup

| Path | Reason |
|---|---|
| `E:\CRM\frontend-comparison\` (16.04 MiB) | External historical evidence — explicitly out of scope. |
| `E:\CRM\frontend-live-figma-reaudit\` (4.56 MiB) | External historical evidence — explicitly out of scope. |
| `E:\CRM\ui-audit\` (8.92 MiB) | External historical evidence — explicitly out of scope. |
| `E:\CRM\.pnpm-store\` (693.70 MiB) | Shared pnpm content-addressable store. Deleting it would force every worktree to re-download. |
| `E:\CRM\CRM` (`codex/figma-frontend`) | Different worktree — DO NOT MODIFY. Holds 5 modified `packages/ui` + `packages/core` files matching this branch's uncommitted changes. |
| `E:\CRM\CRM-backend` (`backend/remediation`) | Different worktree — DO NOT MODIFY. Holds 4 untracked audit docs (`FRONTEND_COMPARISON_AUDIT.{json,md}`, `FRONTEND_LIVE_FIGMA_REAUDIT.{json,md}`) which are historical evidence. |

Also note for the first two sibling-worktree entries: `git clean -nd` in `E:\CRM\CRM` reports
empty PGlite subdirectories (`pg_commit_ts/`, `pg_dynshmem/`, `pg_serial/`, `pg_snapshots/`,
`pg_stat/`, …) inside the same two committed `.data-*` directories. Those are leftovers from
git's inability to track empty directories, not separate clutter.

---

## Dead code / unused dependency candidates — consolidated

**Nothing was removed.** Summary of the proof gathered (full detail in Category 7):

**Unused dependencies — high confidence, 3 findings:**

1. `packages/db/package.json` → `@nexus/core` (dependencies). Only the declaration mentions it.
2. `packages/db/package.json` → `zod` (dependencies). Only the declaration mentions it.
3. `apps/extension/package.json` → `@nexus/core` (dependencies). Only the declaration mentions it.

**Unused exports — high confidence, 6 findings:**
`Breadcrumbs` (app-shell.tsx); `SelectorOption` (companion-shell.tsx); `CountChip`,
`leadStateAccent`, `leadStateLabel`, `ProvenanceBlock` (domain.tsx). Each has exactly one
occurrence repo-wide: its own definition.

**Unused CSS — medium confidence, 3 findings (`needs-proof`):**
`nx-companion__segmented` (styles.css:1213), `nx-nav__count` (:621), `nx-spacer` (:778).

**Explicitly cleared (not dead code):** `tabs.tsx`/`Tabs` (re-exported at
`primitives.tsx:528`, rendered at `duplicates/page.tsx:209`); the ~21 dynamically-built CSS
modifier classes; all 44 routes (every one has an inbound reference); and all `@types/*`,
`typescript`, `vitest`, `next`, `react`, `react-dom`, `@electric-sql/pglite`, `esbuild`,
`@playwright/test`, `@types/chrome` declarations.

---

## PROPOSED (NOT EXECUTED)

**Nothing in this section has been run. Nothing has been deleted, moved, renamed or modified.**
It is presented for the repository owner to approve. It is exactly four items.

> **Blocker to be aware of:** a `pnpm install` and a build are running in this worktree right
> now, and the dev server on port 3000 holds `apps/web/.data/` open. Two of the four proposals
> touch live state and must not be run until that agent has stopped. This inventory did not
> interrupt it.

| # | Path | Bytes | Tracking | Why it could go | How it is regenerated | Risk |
|---|---|---|---|---|---|---|
| 1 | `apps/web/.data-corrupt-20260925165536/` | 54,589,872 (52.1 MiB) | **tracked** | Committed stale/corrupt PGlite snapshot. Zero source references (`git grep -e data-corrupt` → exit 1). Pure duplicate of regenerable DB state. | `pnpm --filter @nexus/db run verify && node --experimental-strip-types apps/web/scripts/seed-demo.ts` | low |
| 2 | `apps/web/.data-broken-171559/` | 38,017,456 (36.3 MiB) | **tracked** | Committed broken PGlite snapshot. Zero source references (`git grep -e data-broken` → exit 1). Contains a dead `postmaster.pid` and stale socket lock. | same as #1 | low |
| 3 | `apps/web/.next/` | 160,628,348 (153.2 MiB) | ignored | Next.js build output, already outside git. Only exists because a build ran. | `pnpm --filter @nexus/web run build` | low — **but a build is in flight; deleting now disrupts the concurrent agent** |
| 4 | `apps/web/.data/` | 37,172,649 (35.4 MiB) | ignored | Local embedded-database state for single-process dev. | `pnpm db:reset && node --experimental-strip-types apps/web/scripts/seed-demo.ts` | **medium** — loses local demo/admin state, and the running server may hold it open |

**Total proposed: 290,408,325 bytes ≈ 276.9 MiB.** Of that, 92,607,328 bytes (88.3 MiB) —
items 1 and 2 — are **in the git index**, so removing them is a `git rm -r` plus a commit, not
a working-tree delete. That is the one change here that actually shrinks the repository, and it
is the change worth making.

### What is explicitly *not* proposed for removal

- `node_modules/` — expected, required, currently being installed.
- `scripts/baseline-verify/` and its logs — active work of the concurrent agent.
- `apps/extension/dist/` — already absent and correctly ignored; if it is ever produced,
  rebuild with `pnpm --filter @nexus/extension run build` before loading the extension.
- Everything in the **MUST NOT DELETE** section, including all source, all 25 migrations, all
  tests, `docs/`, both `.fig` references, the master spec, `.env.example`, `pnpm-lock.yaml`,
  and the seed scripts.
- `E:\CRM\frontend-comparison\`, `E:\CRM\frontend-live-figma-reaudit\`, `E:\CRM\ui-audit\`.
- The two sibling worktrees.

---

## Method note — commands used

All inspection was read-only. The only `git clean` forms used were the permitted dry-runs
`git clean -nd` and `git clean -ndX`; **no `-f` form was ever run**, and there was no
`git reset --hard`, `git checkout -- .`, recursive delete, process kill, or port change.
File enumeration used `git ls-files`, `git status --short --ignored`, `git check-ignore -v`,
`git grep`, `git log`, and PowerShell `Get-ChildItem`/`Measure-Object` size scans. The only
files created were the two deliverables named at the top of this report.
