# NEXUS — Clean-Checkout Release Gate

**Purpose.** A baseline that only works in the workstation it was built in is not a baseline. This
records the full release gate executed in a **fresh git worktree at the same commit**, with no
`node_modules`, no `.next`, no local database and no untracked file carried over.

| | |
| --- | --- |
| Integration worktree | `E:\CRM\CRM-integration` |
| Clean gate worktree | `E:\CRM\CRM-cleancheck-2` (git worktree, `--detach`) |
| Commit under test | `f93bff4f15ee9b79f2453f909b39915d8fb2d665` |
| Started from | pristine tree — verified absent: `node_modules`, `apps/web/node_modules`, `apps/web/.data`, `apps/web/.next`, `apps/extension/dist` |

## Gate results

| # | Gate | Command | Result |
| --- | --- | --- | --- |
| 1 | Frozen install | `pnpm install --frozen-lockfile` | **PASS** (exit 0) |
| 2 | Typecheck | `pnpm run typecheck` | **PASS** (exit 0) |
| 3 | Lint | `pnpm run lint` (`--max-warnings 0`) | **PASS** (exit 0) |
| 4 | Tests | `pnpm run test` | **PASS** (exit 0) |
| 5 | Database | `pnpm run db:verify` | **PASS** (exit 0) |
| 6 | Web build | `pnpm run build` | **PASS** (exit 0) — `Compiled successfully` |
| 7 | Extension build | `pnpm --filter @nexus/extension run build` | **PASS** (exit 0) |

### Test counts from the clean tree

| Package | Tests | Result |
| --- | --- | --- |
| `@nexus/core` | 88 | PASS |
| `@nexus/db` | 82 | PASS |
| `@nexus/extension` | 9 | PASS |
| `@nexus/web` | 241 | PASS |
| **Total** | **420** | **0 failures** |

The count rose from 399 at the previous gate run because this baseline added 21 regression cases: 10
for the Leads quick-filter chip defect (`quick-filter-chips.test.ts`) and 11 for the Companion list
`limit` defect (`api-limit-params.test.ts`).

### Database from the clean tree

25 migrations applied to a clean database: **64 tables, 181 policies, 105 triggers, 98 functions,
177 indexes** — `Verification passed.`

### Extension artefact from the clean tree

6 files emitted; `manifest valid, no credentials in the bundle`. `sidepanel.js` hash is
`e58fd6eb10c2e24f`, which differs from the integration worktree's `9321183b41667284` because the API
origin baked into the bundle is a build input, not a constant — the clean worktree built with the
default `http://127.0.0.1:3000`. The other five hashes are identical.

## A defect the previous gate run caught, and why this gate exists

The first clean-checkout run **failed on its first command**. `pnpm install --frozen-lockfile` aborted
with `ERR_PNPM_OUTDATED_LOCKFILE`: an earlier commit had pruned three unused dependencies without
regenerating `pnpm-lock.yaml`, so the lockfile still described them. Every gate had passed in the
integration worktree, because its `node_modules` was already installed and pnpm never re-resolved —
**from a clean checkout the very first command failed.**

That is precisely the class of defect this gate exists to catch, and it is why the gate is re-run
whenever the tree moves rather than once per baseline.

## Reproducing

```powershell
cd E:\CRM\CRM-integration
git worktree add E:\CRM\CRM-cleancheck-2 --detach f93bff4
cd E:\CRM\CRM-cleancheck-2
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run db:verify
pnpm run build
pnpm --filter @nexus/extension run build
```

`serve.mjs` is not used by this gate. It previously resolved the `next` binary from the workspace root
`node_modules/.bin`, where pnpm does not place it, and failed with `'next' is not recognized`; the
documented root `build` script and the direct `apps/web/node_modules/.bin/next` both work. **That
wrapper bug is now fixed** — `apps/web/scripts/serve.mjs` searches the app's own `node_modules/.bin`
first — so `pnpm --filter @nexus/web run start` is usable. See `DEPLOYMENT_READINESS.md` §1.

## Environment notes for whoever re-runs this

- `pnpm` must be invoked as `pnpm.cmd` on this host; the PowerShell shim is blocked by execution
  policy (`pnpm.ps1 cannot be loaded because running scripts is disabled`).
- `pnpm exec next build`/`start` intermittently fails in this multi-worktree setup with `ENOENT` on
  `.next/server/*-manifest.json`. The root `build` script and the app's `start` script both work.
- The embedded PGlite database is **single-process**. Nothing in this gate opens the integration
  worktree's data directory, which is why the gate can run while a server is up elsewhere.
