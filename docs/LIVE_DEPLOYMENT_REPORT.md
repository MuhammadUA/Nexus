# NEXUS live deployment report

Recorded: 2026-09-28

## Release identity

- Repository: `MuhammadUA/Nexus`
- Deployed branch: `integration/final`
- Deployed product SHA: `47fccdff510e0bcd7e5bce8cdb5593c21adc15d1`
- Baseline tag: `nexus-predeploy-baseline-v1`
- Baseline tag target: `f93bff4f15ee9b79f2453f909b39915d8fb2d665`
- Full monorepo and release evidence verified: yes
- Secret and forbidden-artifact scan: passed; no deployed secret values were committed

## Supabase

- Project: `MuhammadUA's Project`
- Project ref: `niyannfhhfzbrtvdxffa`
- Region: `ap-northeast-2`
- PostgreSQL: 17.6
- Migration status: repository migrations `0001` through `0029` applied
- Schema result: 64 public tables, 177 indexes, 181 policies, 105 triggers, and 105 functions
- RLS result: enabled and forced on all public tables; no policy was weakened for deployment
- Runtime role: dedicated `NOLOGIN` service boundary plus a restricted `NOINHERIT` login role; neither role has superuser, role-creation, database-creation, or RLS-bypass privileges
- External production driver verified: yes
- Production database evidence: F-2 lead `e647987a-3917-435e-83e0-131f29e07917` and F-6 lead `25814331-f0db-48bf-a7d9-72e1584fb90d` exist in this project
- F-2 REST ingestion: passed on real PostgreSQL (`201`)
- F-6 MCP ingestion: passed on real PostgreSQL (`200`)
- Post-deployment PostgreSQL log check: no `ERROR`, `FATAL`, or `PANIC` entries in the checked one-hour window
- Security advisor: no deployment-blocking RLS regression. Two credential tables intentionally have RLS with no policies (deny all). Existing authenticated `SECURITY DEFINER` architecture remains a future hardening-review item.

The existing incompatible `public` schema was reset only after explicit user approval. Supabase Auth and platform-managed schemas were not reset.

## Vercel

- Project: `nexus`
- Project ID: `prj_ozODKzM9t6TK8YmhGllQxxX5Gn28`
- Framework: Next.js
- Root directory: `apps/web`
- Workspace access outside root: enabled
- Node.js: `22.x`
- Package manager declared by source: `pnpm@9.15.4`
- Preview deployment: `dpl_9yGQobYZCSLLgA7HcumLdmU45PC7`
- Preview URL: <https://nexus-ibf1pgygi-abdulwaheedmmg21-7697s-projects.vercel.app>
- Production deployment: `dpl_61XTfXWyD9uQeDTkky6udSySngQg`
- Production URL: <https://nexus-rouge-tau-75.vercel.app>
- Immutable production URL: <https://nexus-a2ozzuz66-abdulwaheedmmg21-7697s-projects.vercel.app>
- Git metadata returned by Vercel: branch `integration/final`, SHA `47fccdff510e0bcd7e5bce8cdb5593c21adc15d1`
- Deployment state: `READY`
- Runtime error-log check: no production error entries found after smoke testing

## Environment and runtime

- Database: `SUPABASE_DB_URL` configured as a Vercel secret for Preview and Production
- Session: stable `NEXUS_SESSION_SECRET` configured as a Vercel secret for Preview and Production
- Auth mode: NEXUS local email/password session path (`NEXUS_LOCAL_AUTH=1`), as implemented by this baseline
- Database role boundary: `NEXUS_DB_SERVICE_ROLE=nexus_service`
- Serverless pool limit: `NEXUS_DB_POOL_MAX=1`
- Embedded PGlite production override: absent; production uses the external PostgreSQL driver
- DeepSeek: not configured; AI provider smoke remains pending. The baseline treats the missing key as the typed `provider_not_configured` state.
- Extension rebuild origin: `NEXUS_API_ORIGIN=https://nexus-rouge-tau-75.vercel.app`

## Live smoke results

- HTTPS/login page: passed (`200`), with rendered production assets
- Root: passed; unauthenticated traffic reaches the login flow without a server error
- Invalid login: passed with the expected redirect/error path; no credentials leaked
- Health/auth rejection: `GET /api/v1/companion/me` returned the expected `401` and `Sign in to Nexus.` response
- Companion extension CORS: preflight passed (`204`), with the documented methods/headers and wildcard origin on the cookie-free companion API only
- MCP public catalogue: passed; 18 tools returned
- MCP authenticated `tools/list`: passed
- API safe mutation: F-2 ingestion passed and persisted in Supabase
- MCP mutation: F-6 candidate submission passed and persisted in Supabase
- Business-scope rejection: passed (`404`, scoped non-disclosing error)
- Preview smoke: 7/7 passed before Production
- Production smoke: 7/7 passed
- Local release gates after deployment fixes: typecheck, lint, migration verification, 420 tests, and production build passed

No persistent administrator account was invented during deployment. The production login/bootstrap surface is live and ready for the owner to claim using credentials they choose.

## Remaining work and boundaries

- DeepSeek live-provider testing is pending a provider key.
- Run the separate rigorous live-server acceptance audit, including a real signed-in user session and the full Chrome extension U22-U30 pass.
- Rebuild the Chrome extension with the recorded `NEXUS_API_ORIGIN` before its full audit.
- Review the intentional `SECURITY DEFINER` footprint in a dedicated hardening pass; do not weaken RLS as a shortcut.
- No DNS/custom-domain change was made.
- No merge to `main`, tag movement, force-push, credential rotation, or further destructive database action was performed.
