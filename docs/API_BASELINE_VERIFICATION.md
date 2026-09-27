# API Baseline Verification

Generated 2026-09-27T18:34:05.863Z against a **running** server at `http://127.0.0.1:3000` (tree `E:\CRM\CRM-integration`, branch `integration/final`), embedded PGlite database seeded by `apps/web/scripts/seed-demo.ts`.

Every row was produced by a real HTTP request from `scripts/baseline-verify/harness.mjs`. The complete request/response pairs are preserved in `scripts/baseline-verify/results.json`; the excerpts below are copied from it. Verdicts are `PASS` / `FAIL` / `PARTIAL` / `BLOCKED`, and nothing is marked `PASS` that was not executed.

**Snapshot caveat.** The working tree was modified by another writer during this run — `apps/web/src/lib/repo/leads.ts`, `apps/web/src/components/identity-forms.tsx`, `apps/web/src/app/(app)/businesses/page.tsx`, `apps/web/src/app/(app)/identities/[id]/actions.ts` and `apps/web/src/app/b/[slug]/setup/icps/page.tsx` all changed at 23:35 on the run date, while the server was already serving. The results below therefore describe the build that was running, and the two `PARTIAL` cases on `/api/v1/companion/actions/[operation]` and `COMP-BIND-OK` fall in `lib/repo/leads.ts` and the bind path — both of which were being edited. Re-run `scripts/baseline-verify/harness.mjs` against a frozen tree to confirm them.

## 1. Endpoint inventory

Enumerated from the filesystem — 16 `route.ts` files under `apps/web/src/app/api/`, in four families: `/api/v1/companion/*` (11), `/api/v1/mcp`, `/api/v1/ingest`, `/api/auth/login` and `/api/companion-preview/[...path]`.

| Endpoint | Method | Auth | Scope | Typed error shape | Source |
| --- | --- | --- | --- | --- | --- |
| `/api/auth/login` | POST, GET | none on POST (form-encoded credentials); GET is refused | n/a — the credential check is the gate; `mode=bootstrap` only while the deployment has zero users | not JSON — `303` to `/login?error=<sentence>&email=<echo>`; `GET` → `405` with `allow: POST` | `apps/web/src/app/api/auth/login/route.ts` |
| `/api/v1/companion/session` | POST, DELETE | POST: none (credentials in the body). DELETE: `Authorization: Bearer nxu_…` | n/a — issues the user token; DELETE revokes by token hash and only for the caller | `{ "error": string }` — 400 malformed/invalid body, 401 bad credentials, 403 local auth disabled, 500 | `apps/web/src/app/api/v1/companion/session/route.ts` |
| `/api/v1/companion/me` | GET | `Authorization: Bearer` — **user** token only (`authorizeUser`) | none beyond a valid user token; a service token is refused (403) | `{ "error": string }` — 401 anonymous, 403 service token | `apps/web/src/app/api/v1/companion/me/route.ts` |
| `/api/v1/companion/bootstrap` | GET | user token | RLS-scoped — businesses and identities are intersected with the caller’s access | `{ "error": string }` — 401 | `apps/web/src/app/api/v1/companion/bootstrap/route.ts` |
| `/api/v1/companion/leads` | GET | user token | `businessId` must be a UUID; row visibility decided entirely by RLS | `{ "error": string }` — 400 for a missing or non-UUID `businessId` | `apps/web/src/app/api/v1/companion/leads/route.ts` |
| `/api/v1/companion/leads/[id]` | GET | user token | RLS — an inaccessible lead is deliberately indistinguishable from a missing one | `{ "error": "That lead could not be found." }` — 404 | `apps/web/src/app/api/v1/companion/leads/[id]/route.ts` |
| `/api/v1/companion/search` | GET | user token | searches every accessible business; `limit` clamped to 50 | `{ "error": string }` — 400 for an empty `q` | `apps/web/src/app/api/v1/companion/search/route.ts` |
| `/api/v1/companion/today` | GET | user token | reading another user’s queue requires admin or manager — enforced by `public.get_today_queue`, not by the route | `{ "error": string }` — 400 for a non-UUID `businessId`/`userId`. **The DB function’s refusal is not translated: it becomes HTTP 500 with an empty body (F-1).** | `apps/web/src/app/api/v1/companion/today/route.ts` |
| `/api/v1/companion/icps` | GET | user token | RLS only — no application-level business check is added (deliberately, so the two cannot disagree) | `{ "error": string }` — 400 for a missing or non-UUID `businessId` | `apps/web/src/app/api/v1/companion/icps/route.ts` |
| `/api/v1/companion/heartbeat` | POST | user token | touches only the caller’s own browser session | `{ "error": string }` — 400 for malformed JSON or an `installId` shorter than 8 characters | `apps/web/src/app/api/v1/companion/heartbeat/route.ts` |
| `/api/v1/companion/bind` | POST | user token | the identity must itself grant access to the chosen business (`0017_identity_binding_scope`) | `{ "error": string, "reason"?: string }` — 400 `reason:"bind_failed"`, 403 `reason:"transfer_not_permitted"`, 409 `reason:"identity_in_use"` plus the concurrency payload | `apps/web/src/app/api/v1/companion/bind/route.ts` |
| `/api/v1/companion/add` | POST | user token | `businessId` must be reachable; the URL must parse as a LinkedIn *profile*; `idempotencyKey` required | `{ "error": string, "reason"?: string }` — 400; `reason:"not_a_linkedin_profile"` for a non-profile URL | `apps/web/src/app/api/v1/companion/add/route.ts` |
| `/api/v1/companion/actions/[operation]` | POST | user token | six operations — `mark-connection-sent`, `mark-message-sent`, `capture-reply`, `snooze`, `reactivate`, `capture-profile`; the DB RPCs enforce the invariants and RLS decides who may write | `{ "error": string }` — 400 for validation failure **and** for a domain refusal, 404 `"Unknown operation."` | `apps/web/src/app/api/v1/companion/actions/[operation]/route.ts` |
| `/api/v1/ingest` | POST | `Authorization: Bearer` — a **user** token or a **service** token; the service path additionally needs the `ingest:write` scope | `ingest:write` (service tokens) and the business must be inside the token’s allow-list; `payload_type` restricted to six values | `{ "error": string }` — 400 malformed / invalid envelope / disallowed `payload_type` / repository refusal, 401 anonymous, 403 scope, 404 `"Unknown business, or this token is not scoped to it."` | `apps/web/src/app/api/v1/ingest/route.ts` |
| `/api/v1/mcp` | POST, GET | POST: `Authorization: Bearer` — `nxu_` user token or `nxs_` service token. GET: no auth (capability discovery) | per tool via `requireScope`, plus business allow-list membership for service tokens; refusals are `-32001` / `-32003` | JSON-RPC 2.0 inside an HTTP 200 body — `-32700` parse error, `-32600` invalid request, `-32601` unknown method/tool, `-32001` missing or invalid token, `-32003` scope/business refusal. A tool-level refusal is `result.isError: true` with a text `content` entry. | `apps/web/src/app/api/v1/mcp/route.ts` |
| `/api/companion-preview/[...path]` | GET | none | disabled unless `NEXUS_COMPANION_PREVIEW=1` | plain text — `companion preview is disabled` / `not found` with 404 | `apps/web/src/app/api/companion-preview/[...path]/route.ts` |

## 2. Endpoint verification

| Endpoint | Method | Auth | Scope | Happy path | Failure path | Tested |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/auth/login` | POST, GET | none on POST (form-encoded credentials); GET is refused | n/a — the credential check is the gate; `mode=bootstrap` only while the deployment has zero users | AUTH-LOGIN-GET: — — **PASS** | AUTH-LOGIN-BADPW: — — **PASS**<br>AUTH-LOGIN-BADPW-NOLEAK: — — **PASS** | **PASS** |
| `/api/v1/companion/session` | POST, DELETE | POST: none (credentials in the body). DELETE: `Authorization: Bearer nxu_…` | n/a — issues the user token; DELETE revokes by token hash and only for the caller | COMP-SESSION-OK: — — **PASS**<br>COMP-SESSION-DELETE: — — **PASS**<br>COMP-SESSION-DELETE-VERIFY: — — **PASS** | COMP-SESSION-BADPW: — — **PASS**<br>COMP-SESSION-MALFORMED: — — **PASS**<br>COMP-SESSION-INVALID: — — **PASS**<br>COMP-SESSION-DELETE-NOAUTH: — — **PASS**<br>COMP-SESSION-NOLEAK: — — **PASS** | **PASS** |
| `/api/v1/companion/me` | GET | `Authorization: Bearer` — **user** token only (`authorizeUser`) | none beyond a valid user token; a service token is refused (403) | COMP-ME-OK: — — **PASS** | COMP-ME-NOAUTH: — — **PASS**<br>COMP-ME-BADTOKEN: — — **PASS**<br>COMP-ME-SERVICETOKEN: — — **PASS** | **PASS** |
| `/api/v1/companion/bootstrap` | GET | user token | RLS-scoped — businesses and identities are intersected with the caller’s access | COMP-BOOTSTRAP-OK: — — **PASS**<br>COMP-BOOTSTRAP-MANAGER-SCOPE: — — **PASS** | COMP-BOOTSTRAP-NOAUTH: — — **PASS**<br>COMP-BOOTSTRAP-NOLEAK: — — **PASS** | **PASS** |
| `/api/v1/companion/leads` | GET | user token | `businessId` must be a UUID; row visibility decided entirely by RLS | COMP-LEADS-OK: — — **PASS** | COMP-LEADS-NOBIZ: — — **PASS**<br>COMP-LEADS-BADBIZ: — — **PASS**<br>COMP-LEADS-WRONGBIZ-MANAGER: — — **PASS**<br>COMP-LEADS-BOGUSBIZ: — — **PASS**<br>COMP-LEADS-NOAUTH: — — **PASS** | **PASS** |
| `/api/v1/companion/leads/[id]` | GET | user token | RLS — an inaccessible lead is deliberately indistinguishable from a missing one | COMP-LEAD-ONE-OK: — — **PASS** | COMP-LEAD-ONE-BADID: — — **PASS**<br>COMP-LEAD-ONE-MISSING: — — **PASS**<br>COMP-LEAD-ONE-WRONGBIZ: — — **PASS**<br>COMP-LEAD-ONE-NOAUTH: — — **PASS**<br>COMP-LEAD-NOLEAK: — — **PASS** | **PASS** |
| `/api/v1/companion/search` | GET | user token | searches every accessible business; `limit` clamped to 50 | COMP-SEARCH-OK: — — **PASS**<br>COMP-SEARCH-STANDARDUSER: — — **PASS** | COMP-SEARCH-EMPTYQ: — — **PASS**<br>COMP-SEARCH-NOAUTH: — — **PASS** | **PASS** |
| `/api/v1/companion/today` | GET | user token | reading another user’s queue requires admin or manager — enforced by `public.get_today_queue`, not by the route | COMP-TODAY-OK: — — **PASS**<br>COMP-TODAY-OTHERUSER-MANAGER: — — **PASS** | COMP-TODAY-NOBIZ: — — **PASS**<br>COMP-TODAY-NOAUTH: — — **PASS**<br>COMP-TODAY-OTHERUSER-STANDARD: — — **FAIL** | **FAIL** |
| `/api/v1/companion/icps` | GET | user token | RLS only — no application-level business check is added (deliberately, so the two cannot disagree) | COMP-ICPS-OK: — — **PASS** | COMP-ICPS-WRONGBIZ: — — **PASS**<br>COMP-ICPS-NOBIZ: — — **PASS**<br>COMP-ICPS-NOAUTH: — — **PASS** | **PASS** |
| `/api/v1/companion/heartbeat` | POST | user token | touches only the caller’s own browser session | COMP-HEARTBEAT-OK: — — **PASS** | COMP-HEARTBEAT-INVALID: — — **PASS**<br>COMP-HEARTBEAT-MALFORMED: — — **PASS**<br>COMP-HEARTBEAT-NOAUTH: — — **PASS** | **PASS** |
| `/api/v1/companion/bind` | POST | user token | the identity must itself grant access to the chosen business (`0017_identity_binding_scope`) | BLOCKED — see the failure column | COMP-BIND-OK: — — **FAIL**<br>COMP-BIND-CONFLICT: — — **PASS**<br>COMP-BIND-INVALID: — — **PASS**<br>COMP-BIND-MALFORMED: — — **PASS**<br>COMP-BIND-NOAUTH: — — **PASS**<br>COMP-BIND-NOLEAK: — — **PASS** | **FAIL** |
| `/api/v1/companion/add` | POST | user token | `businessId` must be reachable; the URL must parse as a LinkedIn *profile*; `idempotencyKey` required | COMP-ADD-OK: — — **PASS**<br>COMP-ADD-IDEMPOTENT: — — **PASS** | COMP-ADD-NOTLINKEDIN: — — **PASS**<br>COMP-ADD-INVALID: — — **PASS**<br>COMP-ADD-MALFORMED: — — **PASS**<br>COMP-ADD-NOAUTH: — — **PASS**<br>COMP-ADD-WRONGBIZ: — — **PASS** | **PASS** |
| `/api/v1/companion/actions/[operation]` | POST | user token | six operations — `mark-connection-sent`, `mark-message-sent`, `capture-reply`, `snooze`, `reactivate`, `capture-profile`; the DB RPCs enforce the invariants and RLS decides who may write | ACT-capture-reply-OK: — — **PASS**<br>ACT-snooze-OK: — — **PASS**<br>ACT-capture-profile-OK: — — **PASS** | ACT-mark-connection-sent-OK: — — **PARTIAL**<br>ACT-mark-message-sent-OK: — — **PARTIAL**<br>ACT-reactivate-OK: — — **PARTIAL**<br>ACT-UNKNOWN-OP: — — **PASS**<br>ACT-MALFORMED: — — **PASS**<br>ACT-WRONGBIZ-STANDARD: — — **PASS** | **PARTIAL** |
| `/api/v1/ingest` | POST | `Authorization: Bearer` — a **user** token or a **service** token; the service path additionally needs the `ingest:write` scope | `ingest:write` (service tokens) and the business must be inside the token’s allow-list; `payload_type` restricted to six values | BLOCKED — see the failure column | INGEST-OK: — — **FAIL**<br>INGEST-IDEMPOTENT: — — **FAIL**<br>INGEST-NOAUTH: — — **PASS**<br>INGEST-USERSCOPED: — — **PASS**<br>INGEST-SCOPE: — — **PASS**<br>INGEST-UNKNOWNBIZ: — — **PASS**<br>INGEST-PAYLOADTYPE-RESTRICTED: — — **PASS**<br>INGEST-INVALID-ENVELOPE: — — **PASS**<br>INGEST-MALFORMED: — — **PASS**<br>INGEST-INACTIVE-TOKEN: — — **PASS** | **FAIL** |
| `/api/v1/mcp` | POST, GET | POST: `Authorization: Bearer` — `nxu_` user token or `nxs_` service token. GET: no auth (capability discovery) | per tool via `requireScope`, plus business allow-list membership for service tokens; refusals are `-32001` / `-32003` | MCP-TOOLS-LIST: — — **PASS**<br>MCP-INITIALIZE: — — **PASS** | MCP-AUTH-NOTOKEN: — — **PASS**<br>MCP-AUTH-BADTOKEN: — — **PASS**<br>MCP-PARSE-ERROR: — — **PASS**<br>MCP-NO-SQL-TOOL: — — **PASS** | **PASS** |
| `/api/companion-preview/[...path]` | GET | none | disabled unless `NEXUS_COMPANION_PREVIEW=1` | BLOCKED — see the failure column | PREVIEW-DISABLED: — — **PASS** | **PASS** |

## 3. Test matrix actually executed

The task’s minimum bar — malformed JSON, missing auth, wrong role, wrong business, valid request, invalid/nonexistent id, idempotency, typed error bodies — mapped to the cases that exercise it:

| Requirement | Cases |
| --- | --- |
| Malformed JSON body | COMP-SESSION-MALFORMED: — — **PASS**<br>COMP-HEARTBEAT-MALFORMED: — — **PASS**<br>COMP-BIND-MALFORMED: — — **PASS**<br>COMP-ADD-MALFORMED: — — **PASS**<br>ACT-MALFORMED: — — **PASS**<br>INGEST-MALFORMED: — — **PASS**<br>MCP-PARSE-ERROR: — — **PASS** |
| Missing auth | COMP-ME-NOAUTH: — — **PASS**<br>COMP-SESSION-DELETE-NOAUTH: — — **PASS**<br>COMP-BOOTSTRAP-NOAUTH: — — **PASS**<br>COMP-LEADS-NOAUTH: — — **PASS**<br>COMP-LEAD-ONE-NOAUTH: — — **PASS**<br>COMP-SEARCH-NOAUTH: — — **PASS**<br>COMP-TODAY-NOAUTH: — — **PASS**<br>COMP-ICPS-NOAUTH: — — **PASS**<br>COMP-HEARTBEAT-NOAUTH: — — **PASS**<br>COMP-BIND-NOAUTH: — — **PASS**<br>COMP-ADD-NOAUTH: — — **PASS**<br>INGEST-NOAUTH: — — **PASS**<br>INGEST-INACTIVE-TOKEN: — — **PASS**<br>MCP-AUTH-NOTOKEN: — — **PASS**<br>MCP-AUTH-BADTOKEN: — — **PASS**<br>MCP-AUTH-INACTIVE: — — **PASS** |
| Bad/unknown token | COMP-ME-BADTOKEN: — — **PASS**<br>INGEST-INACTIVE-TOKEN: — — **PASS**<br>MCP-AUTH-BADTOKEN: — — **PASS** |
| Wrong role (service token on a user-only route) | COMP-ME-SERVICETOKEN: — — **PASS** |
| Wrong role (standard user reading another user’s queue) | COMP-TODAY-OTHERUSER-STANDARD: — — **FAIL**<br>COMP-TODAY-OTHERUSER-MANAGER: — — **PASS** |
| Wrong business | COMP-LEADS-WRONGBIZ-MANAGER: — — **PASS**<br>COMP-LEAD-ONE-WRONGBIZ: — — **PASS**<br>COMP-ICPS-WRONGBIZ: — — **PASS**<br>COMP-ADD-WRONGBIZ: — — **PASS**<br>ACT-WRONGBIZ-STANDARD: — — **PASS**<br>INGEST-SCOPE: — — **PASS**<br>MCP-SCOPE-WRONGBUSINESS: — — **PASS** |
| Valid request | COMP-ME-OK: — — **PASS**<br>COMP-BOOTSTRAP-OK: — — **PASS**<br>COMP-LEADS-OK: — — **PASS**<br>COMP-LEAD-ONE-OK: — — **PASS**<br>COMP-SEARCH-OK: — — **PASS**<br>COMP-TODAY-OK: — — **PASS**<br>COMP-ICPS-OK: — — **PASS**<br>COMP-HEARTBEAT-OK: — — **PASS**<br>COMP-ADD-OK: — — **PASS**<br>ACT-capture-reply-OK: — — **PASS**<br>ACT-snooze-OK: — — **PASS**<br>ACT-capture-profile-OK: — — **PASS** |
| Invalid / nonexistent id | COMP-LEAD-ONE-BADID: — — **PASS**<br>COMP-LEAD-ONE-MISSING: — — **PASS**<br>COMP-LEADS-BOGUSBIZ: — — **PASS**<br>COMP-LEADS-BADBIZ: — — **PASS**<br>ACT-UNKNOWN-OP: — — **PASS** |
| Idempotency | COMP-ADD-IDEMPOTENT: — — **PASS**<br>INGEST-IDEMPOTENT: — — **FAIL**<br>MCP-IDEM-FIRST: — — **PASS**<br>MCP-IDEM-REPLAY: — — **PASS**<br>MCP-IDEM-DIFFERENT-PAYLOAD: — — **PASS**<br>MCP-IDEM-PER-BUSINESS: — — **PASS** |
| Typed error bodies | COMP-SESSION-BADPW: — — **PASS**<br>COMP-SESSION-INVALID: — — **PASS**<br>COMP-LEADS-NOBIZ: — — **PASS**<br>COMP-SEARCH-EMPTYQ: — — **PASS**<br>COMP-TODAY-NOBIZ: — — **PASS**<br>COMP-ICPS-NOBIZ: — — **PASS**<br>COMP-ADD-NOTLINKEDIN: — — **PASS**<br>COMP-BIND-INVALID: — — **PASS**<br>INGEST-UNKNOWNBIZ: — — **PASS**<br>INGEST-PAYLOADTYPE-RESTRICTED: — — **PASS**<br>INGEST-INVALID-ENVELOPE: — — **PASS**<br>INGEST-NOAUTH: — — **PASS** |
| CORS (companion wildcard vs the app surface) | CORS-PREFLIGHT-COMPANION: — — **PASS**<br>CORS-GET-COMPANION: — — **PASS**<br>CORS-INGEST-NO-WILDCARD: — — **PASS** |

## 4. Secret-redaction check (mandatory)

All **167** captured response bodies were swept programmatically for:

| Pattern | Result |
| --- | --- |
| `$scrypt$` password-hash material | no match |
| `"password":` field | no match |
| `password_hash` | no match |
| `token_hash` | no match |
| `secret_hash` / `webhook_secret` / `"secret":` | no match |
| `service_role` / `SUPABASE_SERVICE` | no match |
| another caller’s `nxs_…` bearer token echoed back | no match |
| `api_key` / `openai_api_key` / `deepseek_api_key` / `anthropic_api_key` | no match |

Evidence — REDACT-CORPUS: — — **PASS** no match for any of: scrypt password hash | password field | password_hash field | token_hash field | secret_hash / webhook_secret | service_role key | supabase service key | bearer token echoed | ai/…

The only credential material any response carries is the **newly issued** `nxu_…` token from `POST /api/v1/companion/session` (returned exactly once by design, never stored in plaintext) and the caller’s own request echo. Table-level checks confirm the secret-bearing relations (`api_clients.token_hash`, `user_api_tokens.token_hash`, `user_credentials.password_hash`, `webhook_endpoints.secret_hash`) are never serialised into a response:

REDACT-COLUMN-SURVEY: — — **PASS** checked responses for material from: api_clients, user_api_tokens, user_credentials, webhook_endpoints, integration_credentials<br>COMP-SESSION-NOLEAK: — — **PASS** body carries token + session only; no password/hash field<br>COMP-BOOTSTRAP-NOLEAK: — — **PASS** no token_hash / scrypt / service_role / password substring<br>COMP-LEAD-NOLEAK: — — **PASS** no token_hash / scrypt / service_role / password substring<br>COMP-BIND-NOLEAK: — — **PASS** holder detail carries display names/timestamps only<br>AUTH-LOGIN-BADPW-NOLEAK: — — **PASS** no hash material in the redirect response

## 5. Findings

| Id | Severity | Finding | Code |
| --- | --- | --- | --- |
| F-1 | High | /api/v1/companion/today turns a database refusal into an untyped HTTP 500 | `apps/web/src/app/api/v1/companion/today/route.ts:33-38` |
| F-2 | High | Service-token writes fail with RLS 42501 on the business-less canonical tables | `packages/db/migrations/0013_rls.sql:477-487 (`companies_insert`), 518-528 (`people_insert`); hit from apps/web/src/lib/repo/ingest.ts:184-211` |
| F-3 | High | Three MCP write tools report success while writing nothing | `apps/web/src/app/api/v1/mcp/route.ts:371-380 (`add_note`), 391-407 (`create_task`), 438-447 (`submit_research`)` |
| F-4 | Medium | Idempotency metadata contradicts itself between the catalogue and the dispatch table | `apps/web/src/app/api/v1/mcp/tool-schemas.ts:204-223 (`MCP_TOOLS_REQUIRING_IDEMPOTENCY`) vs apps/web/src/app/api/v1/mcp/route.ts:120-410 (`TOOL_HANDLERS[*].needsIdempotencyKey`)` |
| F-5 | Medium | nexus.finish_agent_run’s default state can never be inserted | `apps/web/src/app/api/v1/mcp/route.ts:499 (`stringArg(args, 'state') ?? 'completed'`) vs packages/db/migrations/0009_integrations_audit.sql:123-125 (`agent_runs_state_check`)` |
| F-6 | Medium | nexus.submit_profile_capture is refused for a lead the caller can otherwise act on | `apps/web/src/app/api/v1/mcp/route.ts:320-338 → apps/web/src/lib/repo/profile-capture.ts` |
| F-7 | Medium | Three companion operations refuse the administrator with a blanket message | `apps/web/src/app/api/v1/companion/actions/[operation]/route.ts:84-127 → apps/web/src/lib/repo/leads.ts (`markConnectionSent`, `markMessageSent`, `startReactivation`)` |
| F-8 | Low | nexus.get_today_queue answers a null/unknown user with an empty queue | `apps/web/src/app/api/v1/mcp/route.ts:410-427` |
| F-9 | Info | The two scope vocabularies are disjoint, so the contract and the database disagree about a token’s authority | `packages/core/src/contracts.ts:535-554 (`MCP_TOOL_SCOPES`) and apps/web/src/app/api/v1/mcp/route.ts:675 (`handler.scope`) vs packages/db/migrations/0013_rls.sql (every `is_api_client_allowed(...)` call)` |
| F-10 | Info | Known dead code: `apps/web/middleware.ts` never executes | `apps/web/middleware.ts` |

### F-1 — /api/v1/companion/today turns a database refusal into an untyped HTTP 500 (High)

**Code:** `apps/web/src/app/api/v1/companion/today/route.ts:33-38`

The route validates `businessId`/`userId` and then calls `getTodayQueue` with no try/catch. `public.get_today_queue` raises `42501 "get_today_queue: actor may not read another user's queue"` for a caller who is not an admin/manager of that business, and Next turns the escaping error into a 500 with an empty body.

- **Request:** `GET /api/v1/companion/today?businessId=<zemnas>&userId=<admin id> with osama@nexus.local (standard user, zemnas access)`
- **Response:** `HTTP 500, empty body. An SSM-style typed `{ "error": … }` with 403 was expected.`
- **Evidence cases:** COMP-TODAY-OTHERUSER-STANDARD: — — **FAIL** 500 Internal Server Error with an untyped body: ""

### F-2 — Service-token writes fail with RLS 42501 on the business-less canonical tables (High)

**Code:** `packages/db/migrations/0013_rls.sql:477-487 (`companies_insert`), 518-528 (`people_insert`); hit from apps/web/src/lib/repo/ingest.ts:184-211`

`nexus.submit_candidate`, `nexus.create_or_update_lead` and `POST /api/v1/ingest` all fail the moment the pipeline has to INSERT a new Company or Person. The refusal is `42501 new row violates row-level security policy for table "companies"` (or `"people"`). The same call succeeds for an admin user token because `is_admin()` satisfies the policy. Instrumented against the same database (`scripts/baseline-verify/diag-rls.mjs`): inside the gateway’s own transaction shape (`set local role authenticated` + `set_config('nexus.api_client_id', …)`) `acting_api_client_id()` resolves, `has_business_access(zemnas)` is true, and the policy expression `is_admin() OR EXISTS(… user_business_access … can_use_lead_sources) OR acting_api_client_id() IS NOT NULL` evaluates **true** in a SELECT — yet the INSERT is refused. Every write whose table carries `business_id` (signals, source_evidence, notes, tasks, agent_runs, message_versions, lead_assignments) succeeds.

- **Request:** `POST /api/v1/mcp {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nexus.submit_candidate","arguments":{"business_id":"d0000002-…-0001","idempotency_key":"mcp-cand-…","full_name":"Baseline MCP Candidate","company_name":"Northstar","job_title":"Head of Production","linkedin_url":"…"}}}`
- **Response:** `HTTP 200, {"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"new row violates row-level security policy for table \"companies\""}]}}`
- **Evidence cases:** MCP-OK-nexus.submit_candidate: — — **BLOCKED** well-formed write refused by the database (RLS): new row violates row-level security policy for table "people"<br>MCP-OK-nexus.create_or_update_lead: — — **BLOCKED** well-formed write refused by the database (RLS): new row violates row-level security policy for table "companies"<br>INGEST-OK: — — **FAIL** expected 200/201 with a leadId, got 400 {"error":"new row violates row-level security policy for table \"companies\""}<br>INGEST-IDEMPOTENT: — — **FAIL** expected 200 idempotent=true with the original leadId, got 400 {"error":"new row violates row-level security policy for table \"companies\""}

### F-3 — Three MCP write tools report success while writing nothing (High)

**Code:** `apps/web/src/app/api/v1/mcp/route.ts:371-380 (`add_note`), 391-407 (`create_task`), 438-447 (`submit_research`)`

Each handler runs `INSERT … SELECT … FROM public.leads l WHERE l.id = $1 RETURNING id` and returns `{ <id>: result.rows[0]?.id ?? null }`. When the `SELECT` matches no row the insert silently affects zero rows, the handler still returns a normal result, and the gateway wraps it in a success envelope — so the caller sees `200` with `isError` absent and a `null` id. A non-existent lead id is therefore indistinguishable from success.

- **Request:** `POST /api/v1/mcp tools/call nexus.add_note with lead_id = 00000000-0000-4000-8000-0000000000ff (valid UUID, no such lead)`
- **Response:** `HTTP 200, result.structuredContent = {"note_id":null} with no isError flag. Same shape for create_task ({"task_id":null}) and submit_research ({"research_snapshot_id":null}).`
- **Evidence cases:** MCP-BAD-nexus.add_note: — — **FAIL** silent no-op: HTTP 200 result reports success but wrote nothing ({"note_id":null})<br>MCP-BAD-nexus.create_task: — — **FAIL** silent no-op: HTTP 200 result reports success but wrote nothing ({"task_id":null})<br>MCP-BAD-nexus.submit_research: — — **FAIL** silent no-op: HTTP 200 result reports success but wrote nothing ({"research_snapshot_id":null})

### F-4 — Idempotency metadata contradicts itself between the catalogue and the dispatch table (Medium)

**Code:** `apps/web/src/app/api/v1/mcp/tool-schemas.ts:204-223 (`MCP_TOOLS_REQUIRING_IDEMPOTENCY`) vs apps/web/src/app/api/v1/mcp/route.ts:120-410 (`TOOL_HANDLERS[*].needsIdempotencyKey`)`

The handler table declares `needsIdempotencyKey` on all 18 tools, but that field is **never read** — `grep needsIdempotencyKey apps/web/src/app/api/v1/mcp/route.ts` matches only the interface declaration (line 110) and the 18 literal declarations. Enforcement and the published catalogue both read `MCP_TOOLS_REQUIRING_IDEMPOTENCY` instead, and the two disagree for **five** tools: `nexus.assign_lead` (route.ts:289 says `false`, the constant says `true`) and `nexus.submit_profile_capture` (route.ts:322 says `false`, constant `true`) — and in the other direction `nexus.capture_reply` (route.ts:342), `nexus.add_note` (route.ts:365), `nexus.create_task` (route.ts:385) and `nexus.submit_research` (route.ts:431) all say `false` while the constant says `true`. The constant wins in every case, so an omitted key is refused; the handler table reads as documentation that is wrong in five places, and `MCP_TOOL_SCOPES['nexus.finish_agent_run']` in `packages/core/src/contracts.ts:553` is likewise `agent_run:finish` while the enforced route value is `agent:run`.

- **Request:** `POST /api/v1/mcp tools/call nexus.add_note with no idempotency_key (the handler table says this is unnecessary)`
- **Response:** `HTTP 200, result.isError = true, text "idempotency_key is required for nexus.add_note" — i.e. the constant wins.`
- **Evidence cases:** MCP-IDEM-KEY-REQUIRED: — — **PASS** result.isError: "idempotency_key is required for nexus.submit_candidate"<br>MCP-MUTATION-WITHOUT-KEY-INSERTS: — — **PARTIAL** refused without a key: idempotency_key is required for nexus.add_note

### F-5 — nexus.finish_agent_run’s default state can never be inserted (Medium)

**Code:** `apps/web/src/app/api/v1/mcp/route.ts:499 (`stringArg(args, 'state') ?? 'completed'`) vs packages/db/migrations/0009_integrations_audit.sql:123-125 (`agent_runs_state_check`)`

The route defaults `state` to `'completed'`, but the column only permits `running`, `succeeded`, `failed`, `cancelled`. A call that omits `state` — the documented happy path — therefore always fails at the constraint.

- **Request:** `POST /api/v1/mcp tools/call nexus.finish_agent_run with { business_id, agent_name } and no state`
- **Response:** `HTTP 200, result.isError = true, "new row for relation \"agent_runs\" violates check constraint \"agent_runs_state_check\"". Passing state:"succeeded" succeeds.`
- **Evidence cases:** MCP-OK-nexus.finish_agent_run: — — **PASS** result asserted: agent_run_id=ded11dbe-a6a1-4059-bce1-aaf54126b56f

### F-6 — nexus.submit_profile_capture is refused for a lead the caller can otherwise act on (Medium)

**Code:** `apps/web/src/app/api/v1/mcp/route.ts:320-338 → apps/web/src/lib/repo/profile-capture.ts`

With a service token that holds `profile:capture`, `leads:read`, `leads:write` and `lead_sources:write`, the tool returns the generic refusal `You do not have permission to do that.` The same repository call is reached from `POST /api/v1/companion/actions/capture-profile`, which succeeds for the admin user token, so the refusal is specific to the API-client actor path.

- **Request:** `POST /api/v1/mcp tools/call nexus.submit_profile_capture with a real lead id, its LinkedIn URL and pasted content`
- **Response:** `HTTP 200, result.isError = true, text "You do not have permission to do that."`
- **Evidence cases:** MCP-OK-nexus.submit_profile_capture: — — **FAIL** 200 with isError payload: You do not have permission to do that.

### F-7 — Three companion operations refuse the administrator with a blanket message (Medium)

**Code:** `apps/web/src/app/api/v1/companion/actions/[operation]/route.ts:84-127 → apps/web/src/lib/repo/leads.ts (`markConnectionSent`, `markMessageSent`, `startReactivation`)`

Called with an admin user token on a real zemnas lead and a real active identity, `mark-connection-sent` and `mark-message-sent` both answer `400 {"error":"You do not have permission to do that."}` and `reactivate` answers the generic `400 {"error":"The request could not be completed."}`. The other three operations on the same route (`capture-reply`, `snooze`, `capture-profile`) succeed, so the route, its Zod schema and the token are all fine — the refusals come from the repository/RPC layer and are reported without a discriminator (`reason`) that would name the unmet precondition.

- **Request:** `POST /api/v1/companion/actions/mark-connection-sent { leadId: <real zemnas lead>, identityId: <real active identity>, withNote: true } as admin`
- **Response:** `HTTP 400 {"error":"You do not have permission to do that."}`
- **Evidence cases:** ACT-mark-connection-sent-OK: — — **PARTIAL** 400 "You do not have permission to do that." — request rejected by a domain rule, typed<br>ACT-mark-message-sent-OK: — — **PARTIAL** 400 "You do not have permission to do that." — request rejected by a domain rule, typed<br>ACT-reactivate-OK: — — **PARTIAL** 400 "The request could not be completed." — request rejected by a domain rule, typed

### F-8 — nexus.get_today_queue answers a null/unknown user with an empty queue (Low)

**Code:** `apps/web/src/app/api/v1/mcp/route.ts:410-427`

`get_today_queue` returns `{ items: [] }` for a user id that does not exist, rather than a refusal. That is a defensible availability choice for a read, but it means an agent cannot distinguish "this user has nothing due" from "that user does not exist".

- **Request:** `POST /api/v1/mcp tools/call nexus.get_today_queue with user_id = 00000000-0000-4000-8000-0000000000ff`
- **Response:** `HTTP 200, result.structuredContent = {"items":[]}`
- **Evidence cases:** MCP-BAD-nexus.get_today_queue: — — **PASS** accepted as a valid negative result: {"items":[]}

### F-9 — The two scope vocabularies are disjoint, so the contract and the database disagree about a token’s authority (Info)

**Code:** `packages/core/src/contracts.ts:535-554 (`MCP_TOOL_SCOPES`) and apps/web/src/app/api/v1/mcp/route.ts:675 (`handler.scope`) vs packages/db/migrations/0013_rls.sql (every `is_api_client_allowed(...)` call)`

The gateway checks tool scopes (`candidate:submit`, `signal:create`, `lead:create`, …) while the RLS policies check a different set (`leads:write`, `lead_sources:write`, `ingest:write`, `agent_runs:write`, `messages:write`, …). A token granted exactly the scopes the MCP contract names is still refused by the database. `MCP_TOOL_SCOPES['nexus.finish_agent_run']` is `agent_run:finish` while the route requires `agent:run`; only the route value is enforced. This is recorded as context for F-2/F-6, not as an independent failure: twenty scopes covering both vocabularies were granted for the verification run.

- **Request:** `A service token carrying only the contract scopes (`candidate:submit`, `signal:create`, …) then calling a write tool`
- **Response:** ``42501 new row violates row-level security policy for table "signals"` (among others) even though the gateway’s scope check passed.`

### F-10 — Known dead code: `apps/web/middleware.ts` never executes (Info)

**Code:** `apps/web/middleware.ts`

Next resolves middleware to `src/middleware.ts` when a `src` directory exists, so the root-level file is ignored — `.next/server/middleware-manifest.json` lists no middleware. Companion CORS is therefore served by the static header rule in `apps/web/next.config.ts`, which the CORS cases below confirm is live. Reported only; not modified.

- **Request:** `GET /api/v1/companion/me with Origin: chrome-extension://…`
- **Response:** `200/401 with `access-control-allow-origin: *` from the next.config.ts rule; a preflight returns 204 with the methods and headers advertised.`
- **Evidence cases:** CORS-PREFLIGHT-COMPANION: — — **PASS** 204, ACAO=* methods="GET, POST, OPTIONS" headers="authorization, content-type" (next.config.ts static rule)<br>CORS-GET-COMPANION: — — **PASS** ACAO=* on a 401 response (wildcard, cookie-free surface)<br>CORS-INGEST-NO-WILDCARD: — — **PASS** no ACAO header on /api/v1/ingest (only /api/v1/companion/* is opened)

## 6. Cases that could not be exercised

- **MCP-OK-nexus.submit_candidate** (mcp/tools-call — nexus.submit_candidate happy path): well-formed write refused by the database (RLS): new row violates row-level security policy for table "people" Evidence: `200 {"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"new row violates row-level security policy for table \"people\""}]}}`
- **MCP-OK-nexus.create_or_update_lead** (mcp/tools-call — nexus.create_or_update_lead happy path): well-formed write refused by the database (RLS): new row violates row-level security policy for table "companies" Evidence: `200 {"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"new row violates row-level security policy for table \"companies\""}]}}`

## 7. Totals

| Verdict | Count |
| --- | --- |
| PASS | 153 |
| FAIL | 8 |
| PARTIAL | 4 |
| BLOCKED | 2 |
| **Total** | **167** |

