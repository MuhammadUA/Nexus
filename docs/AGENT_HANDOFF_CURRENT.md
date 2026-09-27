# NEXUS — Current Agent Handoff

**Read this first.** It is the entry point for continuing the NEXUS pre-deployment baseline. It states
where the work stands, what is verified, what is genuinely left, and the exact commands to reproduce
each claim. It does not restate research that is already recorded elsewhere — each section points at
the document that holds the detail.

| | |
| --- | --- |
| Repository | `E:\CRM\CRM-integration` |
| Branch | `integration/final` — **pushed** to `origin` |
| HEAD at this handoff | `f93bff4` |
| Working tree | **clean** |
| Backend source | `backend/remediation` @ `9f009186cfc976f27bd85a3406b2448053266b26` (never modified) |
| Frontend donor | `codex/figma-frontend` @ `4427dd2efef8e3542174596ccae34944710855c4` (selective only, never merged) |
| Baseline tag | `nexus-predeploy-baseline-v1` — **moved to `f93bff4`** and pushed; see §5 |
| Deployment | **not performed**, and no provider was chosen |

## 1. What this baseline is

One integrated system built on the authoritative backend, `HYBRID_BY_MODULE` per the brief's §6: the
shell and information architecture follow the live Figma structure, while permissions, data, behaviour
and lifecycle rules stay with the backend contracts.

The eight `BLOCKED` areas that the first gap matrix recorded are **all closed**. The matrix was
rewritten to state the current code rather than the state it was found in, and it now records
**zero blocked areas**. See `PREDEPLOY_BASELINE_GAP_MATRIX.md`.

## 2. Gates — verified at HEAD, with the command that proves each

Run from `E:\CRM\CRM-integration`. `pnpm` is invoked as `pnpm.cmd` on this host because the PowerShell
shim is blocked by execution policy.

| Gate | Command | Result |
| --- | --- | --- |
| Frozen install | `pnpm install --frozen-lockfile` | PASS |
| Typecheck | `pnpm run typecheck` | PASS — 0 errors |
| Lint | `pnpm run lint` (`--max-warnings 0`) | PASS |
| Tests | `pnpm run test` | PASS — **420** across 5 packages |
| Database | `pnpm run db:verify` | PASS — 25 migrations; 64 tables, 181 policies, 105 triggers, 98 functions, 177 indexes |
| Web build | `pnpm run build` | PASS — `Compiled successfully`, `BUILD_ID` written |
| Extension build | `pnpm --filter @nexus/extension run build` | PASS — 6 files, manifest valid, no credentials in the bundle |
| Extension E2E | `pnpm --filter @nexus/extension run e2e` | PASS — **38 passed, 0 failed, 0 skipped** |
| Auth / RBAC / RLS | part of `pnpm run test` | PASS — 27 database-level cases as a non-owner role |
| Ingestion / dedupe / invariants | part of `pnpm run test` | PASS — 20 database-level cases |
| Sequence / message invariants | part of `pnpm run test` | PASS — 8 cases + immutability and DNC suites |
| Leads composition + pagination | `node scripts/baseline-verify/a03-leads-verify.mjs` | PASS — **43/43** |
| API + MCP running endpoints | `node scripts/baseline-verify/harness.mjs` then `node scripts/baseline-verify/report.mjs` | **158 PASS / 3 FAIL / 4 PARTIAL / 2 BLOCKED** of 167 |
| Companion visual U22–U30 | `node E:\CRM\extension-baseline\capture-focus-frames.mjs` | 9 of 10 states captured and compared |
| **Clean-checkout release gate** | `E:\CRM\CRM-cleancheck-2` at `585d51c`, all 7 steps | **PASS** — see `CLEAN_CHECKOUT_GATE.md` |

### A local workaround worth knowing

`pnpm exec next build`/`start` intermittently fails in this multi-worktree setup with `ENOENT` on
`.next/server/*-manifest.json`. The app's own `start` script works — it did not before, because it
resolved the `next` binary from the workspace root, where pnpm does not put it; that is fixed in
`apps/web/scripts/serve.mjs`.

The embedded database is **single-process**. Two processes opening `apps/web/.data` at once corrupts
it — this happened during this baseline and the database had to be rebuilt from migrations and the
seed. **Always stop the server before running anything that opens the data directory directly**
(`scripts/baseline-verify/db-setup.mjs`, `diag-rls.mjs`).

## 3. Two real defects found and fixed in this baseline

Both were found by exercising the running product, not by reading source, and neither was caught by the
existing suites. Both now have regression tests.

1. **The Leads quick-filter chips.** Every chip sent its key with the value `1`. That is right for the
   boolean filters and wrong for the two that select a lifecycle status: "Replied" and "Dormant"
   linked to `?status=1` and returned **0 rows while advertising 2 and 1**, and their own active-state
   checks looked for `status === 'replied'`, so they could never be highlighted either. Fixed by making
   the row data (`apps/web/src/lib/quick-filter-chips.ts`) and deriving the highlight from the same
   payload that builds the link. 10 regression tests.

2. **The Companion's list page size.** `GET /api/v1/companion/leads` and `/companion/search` read an
   absent `limit` as `Number('')`, which is **`0`**, and clamped it up to **1** instead of using the
   route default. The panel sends no `limit`, so its lead list answered
   `200 {"total":24,"leads":[ …one row… ]}` — which also made the Companion's follow-up and dormant
   focus screens unreachable, because the lead that renders them was never listed. Fixed with
   `optionalLimit`. 11 regression tests.

## 4. What is genuinely left

There are **no blocked capabilities and no outstanding release gate**. What remains is three recorded
items that this environment cannot close, plus two optional improvements.

### 4.1 Nothing required before release

The clean-checkout release gate has been re-run at this HEAD and **all seven steps pass** — including
`pnpm install --frozen-lockfile`, which is the step that caught a real lockfile defect on the previous
run. See `CLEAN_CHECKOUT_GATE.md` for the per-step results, the test counts, and the exact commands to
reproduce. It was executed in a fresh `--detach` worktree (`E:\CRM\CRM-cleancheck-2`) with no
`node_modules`, no `.next`, no local database and no untracked file carried over.

### 4.2 Recorded, with the reason each is not closed

| Item | State | What closes it |
| --- | --- | --- |
| **F-2 / F-6** — service-token INSERT into `companies` / `people` refused `42501` | **OPEN, deliberately unpatched** | Confirmation against **real PostgreSQL**. The gateway's own session shape resolves the token, the only INSERT policy is `PERMISSIVE` and its `WITH CHECK` evaluates `true`, `authenticated` holds the privilege, and the failure reproduces on a throwaway table with a multi-term policy and no triggers. A permissive `WITH CHECK` that is true cannot deny an insert in PostgreSQL, so this is the embedded PGlite engine, not the policy. Full working in `API_BASELINE_VERIFICATION.md` §5. No PostgreSQL, Docker or `psql` is available in this environment |
| **F-8** | OPEN, accepted | Nothing. `nexus.get_today_queue` answers an unknown user with `{"items":[]}`, so an agent cannot tell "nothing due" from "no such user". Recorded; not a defect |
| **F-9** | Advisory | Nothing. The gateway's tool scopes and the database's RLS scopes are disjoint vocabularies, so a token needs both. Context for F-2/F-6 |
| **Companion U28** (Follow-up Focus) | BLOCKED, cause established | A seeded lead with a due `Message 1`. `mark-connection-sent` succeeds but creates no message instance for any seeded lead, so no lead leaves the connection step. This is demo-content reach, not a broken control |
| **Business-selector truncation** | Recorded, not fixed | A styling change so a long business name is readable in the 420px panel. Captured value shows `Zemnas Creati` |
| **Live DeepSeek provider smoke** | PENDING_HOST_ENV | A `DEEPSEEK_API_KEY` on the host. The code path is wired and covered by mocked and provider-contract suites; the unconfigured state renders correctly |
| **Outbound webhook delivery worker** | INTENTIONALLY_DEFERRED | Out of scope by explicit decision. Configuration persists and secrets stay hashed; the UI does not claim delivery occurs. This is the only intentional deferral |

## 5. The tag — action taken

`nexus-predeploy-baseline-v1` **has been moved to `f93bff4`** and force-pushed, and its message was
rewritten to match the commit it names.

**What it named before, and why it moved.** It previously targetted `1e866b0`, an ancestor of the
release commit — 5 commits back. That message described the state at that commit, including two scoped
residuals that have since changed: **U29 and U30 are now captured and compared from the real panel**,
and the **U28 cause is established**. The tag's own gate list also predated the two product defects
fixed here. The requirement was that the tag be created only once every baseline gate is green; the
gates are now green and verified in a fresh worktree, so the tag now names that commit.

**Why force-pushing was acceptable here, and when it would not be.** The tag named a commit in this
branch's own linear history, no release was cut from it, and no consumer could have depended on it —
re-pointing changes which commit the name refers to, which is exactly the operation that is unsafe once
a tag has been released against. The previous target `1e866b0` remains permanently reachable on the
branch, so nothing was lost.

**The message names its own residuals**, so the tag cannot be read as asserting more than was verified:
F-2/F-6 pending real PostgreSQL, U28 pending seeded sequence content, the live provider smoke pending a
host key, plus F-8, F-9 and the Companion selector truncation.

## 6. Honest statement of completeness

**Every gate is green at this commit**, including the clean-checkout release gate, and the two product
defects found during this baseline are fixed with regression tests. The shell and navigation
integration, the eight previously-`BLOCKED` areas, the six row caps, the lifecycle controls, the AI
drafting UI, the Leads/Figma composition and the ICP Manager are complete and verified. The branch is
pushed and tagged.

What remains is **three items that cannot be closed inside this environment**, and they are recorded
rather than worked around:

1. **F-2 / F-6** needs real PostgreSQL to confirm. The evidence establishes it as an embedded-PGlite
   engine limitation, and the policy was deliberately left unchanged rather than weakened to satisfy a
   possibly-buggy local engine. `DEPLOYMENT_READINESS.md` §3 gives the deployment-time check, and the
   pre-deployment checklist gates on it.
2. **The live DeepSeek provider smoke test** needs a `DEEPSEEK_API_KEY` on the host. The code path is
   wired and covered by mocked and provider-contract suites.
3. **Companion U28** needs a seeded lead with a due `Message 1`. This is demo-content reach, not a
   broken control.

Plus two accepted observations (F-8, F-9) and one cosmetic defect (the Business-selector truncation).

**What "tagged" does and does not mean here.** The tag marks a commit at which every gate named in the
brief was verified. It is **not** a claim that the product has been deployed, that service-token
ingestion works on the embedded engine, or that the live AI provider has been exercised. Those are
stated as residuals in the tag message itself.

Where a claim is made in these documents, the command or case that proves it is named beside it; where
something could not be exercised, the document says so and says why.
