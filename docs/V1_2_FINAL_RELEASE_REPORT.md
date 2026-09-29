# Nexus V1.2 Final Release Report

## Git

```yaml
Branch: v1.2/ai-first-redesign
SHA: 6c075e0de2d2bb0d3d527ca550be81fe3759f52e
Working tree: Clean detached verification checkout at the exact SHA
Previous SHA: 6faa60a965e9c5586b0988e6fd84f7716745a42f
Remote SHA: 6c075e0de2d2bb0d3d527ca550be81fe3759f52e
```

The final commit contains only the My Day canonical-route fix and automated coverage. This report is
kept outside that commit to preserve the requested commit scope.

## Verification

```yaml
Frozen install: PASS (pnpm 9.15.4, frozen lockfile)
Typecheck: PASS
Lint: PASS
Tests: PASS (481 application tests)
DB verify: PASS (36 migrations; 71 tables; 198 policies; 111 triggers; 129 functions; 220 indexes)
Build: PASS (web production build and extension build)
Web E2E: PASS (29 tests)
Extension E2E: PASS (38 tests against a fresh isolated seeded API)
```

The clean-checkout host provides Node 24.21.0 while the repository declares Node 22.x, so pnpm emitted
an engine warning. The build completed successfully. The web build also retained two existing
autoprefixer warnings about `end` versus `flex-end`; neither is part of the route change.

## Route

```yaml
Physical pages: 54
Permission entries: 54 (7 aliases)
Destination scans: 291 occurrences across 42 distinct internal destination shapes
Dead links: 0
404: 0
500: 0
Browser route crawl: 57 clicks across 46 destinations
```

The inventory now scans helper return values, template-generated paths, and named route/path/href/URL
builders in addition to inline links and navigation calls. `focus`, `task`, and `step` query parameters
were removed because the lead-detail page did not consume them.

## Security

```yaml
RLS changed: No
Permissions weakened: No
Secrets exposed: No
Database schema changed: No
```

Queue rows obtain the business key through the existing actor-scoped query. Admin, manager, and user
browser tests prove canonical navigation, grantless-admin behavior, business isolation, and the absence
of inaccessible leads from My Day.

## Release decision

```yaml
My Day route: PASS
Work Next: PASS
Route crawl: PASS
Full tests: PASS
Ready for production deployment: NO (production environment configuration blocked)
Production deployment completed: NO
```

Code verification and push are complete. Vercel created a Ready Preview deployment from the exact
verified SHA (`7R8PuWwxzBdG2NVi11xP34y5R2rG`), but it was not promoted. The pre-promotion production
environment check found `DEEPSEEK_API_KEY` scoped only to Preview and
`NEXUS_DB_SERVICE_ROLE` flagged `Needs Attention`. `SUPABASE_DB_URL` and
`NEXUS_SESSION_SECRET` are present for Production and Preview. Secret values were not read or exposed.

Production promotion is blocked until the two environment findings are corrected and re-verified.
Because no Production deployment was created, unchanged live migration state, authenticated role
smokes, live AI/MCP calls, production extension origin, and runtime-error checks remain pending.
