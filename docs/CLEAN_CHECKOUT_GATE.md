# NEXUS — Clean-Checkout Release Gate

**Purpose.** A baseline that only works in the workstation it was built in is not a baseline. This
records the full release gate executed in a **fresh git worktree at the same commit**, with no
`node_modules`, no `.next`, no local database and no untracked file carried over.

| | |
| --- | --- |
| Integration worktree | `E:\CRM\CRM-integration` |
| Clean gate worktree | `E:\CRM\CRM-cleancheck` (git worktree, `--detach`) |
| Commit under test | `a9db4dc1a7f0fb28eab595a9060ee7aec6d47d1a` |
| Started from | pristine tree — verified absent: `node_modules`, `apps/web/node_modules`, `apps/web/.data`, `apps/web/.next`, `apps/extension/dist` |

## Gate results

| # | Gate | Command | Result |
| --- | --- | --- | --- |
| 1 | Frozen install | `pnpm install --frozen-lockfile` | **PASS** (exit 0) |
| 2 | Typecheck | `pnpm run typecheck` | **PASS** (exit 0) |
| 3 | Lint | `pnpm run lint` (`--max-warnings 0`) | **PASS** (exit 0) |
| 4 | Tests | `pnpm run test` | **PASS** (exit 0) |
| 5 | Database | `pnpm run db:verify` | **PASS** (exit 0) |
| 6 | Web build | `pnpm run build` | **PASS** (exit 0), `BUILD_ID` written |
| 7 | Extension build | `pnpm --filter @nexus/extension run build` | **PASS** (exit 0) |

### Test counts from the clean tree

| Package | Tests | Result |
| --- | --- | --- |
| `@nexus/core` | 88 | PASS |
| `@nexus/db` | 82 | PASS |
| `@nexus/extension` | 9 | PASS |
| `@nexus/web` | 220 | PASS |
| **Total** | **399** | **0 failures** |

### Database from the clean tree

25 migrations applied to a clean database: **64 tables, 181 policies, 105 triggers, 98 functions,
177 indexes** — `Verification passed.`

### Extension artefact from the clean tree

6 files emitted; `manifest valid, no credentials in the bundle`. `sidepanel.js` hash differs from the
integration worktree build (`e58fd6eb10c2e24f` vs `9321183b41667284`) because the API origin baked into
the bundle is a build input, not a constant — the clean worktree built with the default
`http://127.0.0.1:3000`, which is expected.

## A defect this gate caught

**The first gate failed on the first run.** `pnpm install --frozen-lockfile` aborted with:

```
ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up
to date with <ROOT>\packages\db\package.json
```

Cause: an earlier commit pruned three unused dependencies from `packages/db/package.json` and
`apps/extension/package.json` but did not regenerate `pnpm-lock.yaml`, so the lockfile still described
`@nexus/core` and `zod` for `packages/db`. Every gate passed in the integration worktree, because its
`node_modules` was already installed and pnpm never re-resolved. **From a clean checkout the very first
command failed.**

Fixed in `a9db4dc` by regenerating the lockfile (`pnpm install --no-frozen-lockfile`, 9 lines removed),
after which all seven gates pass.

This is precisely the class of defect the clean-checkout requirement exists to catch, and it would not
have been visible by any amount of testing in the working tree. It is worth noting that the working
tree had `node_modules` present throughout every previous "green" run in this session.

## Reproducing

```powershell
cd E:\CRM\CRM-integration
git worktree add E:\CRM\CRM-cleancheck --detach <commit>
cd E:\CRM\CRM-cleancheck
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run db:verify
pnpm run build
pnpm --filter @nexus/extension run build
```

`serve.mjs` is not used by this gate. It resolves the `next` binary from the workspace root
`node_modules/.bin`, where it does not exist, and fails with `'next' is not recognized`; the root
`build` script and the direct `apps/web/node_modules/.bin/next` both work. See
`DEPLOYMENT_READINESS.md` §1.
