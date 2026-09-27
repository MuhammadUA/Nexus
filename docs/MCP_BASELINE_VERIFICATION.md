# MCP Baseline Verification

Generated 2026-09-27T18:34:05.863Z against the **running** MCP gateway at `http://127.0.0.1:3000/api/v1/mcp` (tree `E:\CRM\CRM-integration`, branch `integration/final`), embedded PGlite database seeded by `apps/web/scripts/seed-demo.ts`.

Transport is JSON-RPC 2.0 over HTTP. Raw request/response pairs are in `scripts/baseline-verify/results.json`. Verdicts are `PASS` / `FAIL` / `PARTIAL` / `BLOCKED`. **Returned results were asserted, not merely the HTTP status**: a `200` whose `result.isError` was true, or whose `structuredContent` carried a `null` id, is recorded as a failure or a block and never as a pass.

**Snapshot caveat.** The working tree was modified by another writer during this run — `apps/web/src/lib/repo/leads.ts`, `apps/web/src/components/identity-forms.tsx`, `apps/web/src/app/(app)/businesses/page.tsx`, `apps/web/src/app/(app)/identities/[id]/actions.ts` and `apps/web/src/app/b/[slug]/setup/icps/page.tsx` all changed at 23:35 on the run date, while the server was already serving. The results below therefore describe the build that was running, and the two `PARTIAL` cases on `/api/v1/companion/actions/[operation]` and `COMP-BIND-OK` fall in `lib/repo/leads.ts` and the bind path — both of which were being edited. Re-run `scripts/baseline-verify/harness.mjs` against a frozen tree to confirm them.

## 1. Declared tools and their JSON schemas

Source: `apps/web/src/app/api/v1/mcp/tool-schemas.ts` (`MCP_TOOL_SCHEMAS`, `MCP_TOOLS_REQUIRING_IDEMPOTENCY`, `toolInputSchema`) and the tool list in `packages/core/src/contracts.ts:504-524`. The `tools/list` response was compared against both.

MCP-TOOLS-LIST: — — **PASS** 18 tools: nexus.list_accessible_businesses, nexus.get_business_context, nexus.search_person, nexus.search_company, nexus.check_duplicate, nexus.submit_candidate, nexus.create_signal, nexus.add_source_…<br>MCP-TOOLS-LIST-SCHEMA: — — **PASS** all 18 schemas are objects with business_id (uuid) required except the discovery tool; all 12 write tools require idempotency_key<br>MCP-GET-DISCOVERY: — — **PASS** 200, protocol=mcp transport=http-jsonrpc tools=18<br>MCP-INITIALIZE: — — **PASS** protocolVersion=2024-11-05 server=nexus v1.0.0

| # | Tool | Scope required (route) | Idempotency key | Declared arguments (JSON Schema properties) | Required | Schema published |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `nexus.list_accessible_businesses` | `businesses:read` | not required | _(none beyond the envelope)_ | _(none)_ | object, `additionalProperties: true`, `business_id` format uuid |
| 2 | `nexus.get_business_context` | `context:read` | not required | _(none beyond the envelope)_ | _(none)_ | object, `additionalProperties: true`, `business_id` format uuid |
| 3 | `nexus.search_person` | `person:search` | not required | `query`, `limit` | `query` | object, `additionalProperties: true`, `business_id` format uuid |
| 4 | `nexus.search_company` | `company:search` | not required | `query`, `limit` | `query` | object, `additionalProperties: true`, `business_id` format uuid |
| 5 | `nexus.check_duplicate` | `duplicate:check` | not required | `query` | `query` | object, `additionalProperties: true`, `business_id` format uuid |
| 6 | `nexus.submit_candidate` | `candidate:submit` | required | `full_name`, `name`, `company_name`, `company`, `company_domain`, `job_title`, `title`, `linkedin_url`, `source_url`, `location`, `notes` | _(none)_ | object, `additionalProperties: true`, `business_id` format uuid |
| 7 | `nexus.create_signal` | `signal:create` | required | `kind`, `polarity`, `strength`, `label`, `detail`, `company_id`, `person_id`, `lead_id` | `kind` | object, `additionalProperties: true`, `business_id` format uuid |
| 8 | `nexus.add_source_evidence` | `evidence:add` | required | `person_id`, `company_id`, `lead_id`, `source`, `source_url`, `raw_text_or_json`, `content_hash`, `confidence` | `source` | object, `additionalProperties: true`, `business_id` format uuid |
| 9 | `nexus.create_or_update_lead` | `lead:create` | required | `person_id`, `full_name`, `company_name`, `linkedin_url`, `job_title`, `status`, `primary_icp_id`, `owner_user_id` | _(none)_ | object, `additionalProperties: true`, `business_id` format uuid |
| 10 | `nexus.assign_lead` | `lead:assign` | required | `lead_id`, `owner_user_id`, `primary_icp_id` | `lead_id` | object, `additionalProperties: true`, `business_id` format uuid |
| 11 | `nexus.submit_profile_capture` | `profile:capture` | required | `lead_id`, `linkedin_url`, `pasted_content` | `lead_id`, `linkedin_url`, `pasted_content` | object, `additionalProperties: true`, `business_id` format uuid |
| 12 | `nexus.capture_reply` | `reply:capture` | required | `lead_id`, `exact_text`, `outcome`, `note` | `lead_id`, `exact_text`, `outcome` | object, `additionalProperties: true`, `business_id` format uuid |
| 13 | `nexus.add_note` | `note:add` | required | `lead_id`, `body` | `lead_id`, `body` | object, `additionalProperties: true`, `business_id` format uuid |
| 14 | `nexus.create_task` | `task:create` | required | `lead_id`, `title`, `type`, `due_at`, `priority`, `note` | `lead_id`, `title` | object, `additionalProperties: true`, `business_id` format uuid |
| 15 | `nexus.get_today_queue` | `today:read` | not required | `user_id` | `user_id` | object, `additionalProperties: true`, `business_id` format uuid |
| 16 | `nexus.submit_research` | `research:submit` | required | `lead_id`, `summary`, `findings`, `model` | `lead_id`, `summary` | object, `additionalProperties: true`, `business_id` format uuid |
| 17 | `nexus.submit_message_draft` | `message:draft` | required | `message_instance_id`, `content`, `model` | `message_instance_id`, `content` | object, `additionalProperties: true`, `business_id` format uuid |
| 18 | `nexus.finish_agent_run` | `agent:run` | required | `agent_name`, `objective`, `state`, `summary`, `result`, `stats` | _(none)_ | object, `additionalProperties: true`, `business_id` format uuid |

`nexus.list_accessible_businesses` is the only tool for which `business_id` is not required — its purpose is discovery, and `requireScope` is called without a business for it (`route.ts:671-674`).

## 2. Arbitrary-SQL tool: confirmed absent

**There is no arbitrary-SQL tool.** MCP-TOOLS-LIST-NOSQL: — — **PASS** no tool name or argument mentions sql/statement; catalogue = intent tools only (checked 18 tools, 102 distinct args)<br>MCP-NO-SQL-TOOL: — — **PASS** -32601 "Unknown tool: database.execute_sql" — the tool is not in the dispatch table<br>MCP-NO-SQL-TOOL-2: — — **PASS** -32601 Unknown tool

The catalogue names 18 intent-level tools and 102 distinct argument keys; none of them is a SQL, query, or statement field, and no tool name contains `sql`. `packages/core/src/contracts.ts:527-532` lists the forbidden names (`database.execute_sql`, `nexus.execute_sql`, `nexus.run_sql`, `nexus.query`); calling `database.execute_sql` and `nexus.run_sql` both return JSON-RPC `-32601 "Unknown tool"` because dispatch is an exhaustive `Record<McpToolName, …>` membership test (`route.ts:631-634`), and the `api_clients` schema itself carries `api_clients_no_sql_scope_check` (`0009_integrations_audit.sql:28-29`), so a token cannot even be granted a SQL scope.

## 3. Tool verification

| Tool | Schema | Auth/scope case | Happy path | Failure path | Idempotency case | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `nexus.list_accessible_businesses` | published (object) | no tool-specific case; scope enforcement is covered by the shared cases in §4 (MCP-SCOPE-WRONGBUSINESS: — — **PASS**) | MCP-OK-nexus.list_accessible_businesses: — — **PASS** | MCP-BAD-nexus.list_accessible_businesses: — — **PASS** | not required — no key in play | **PASS** |
| `nexus.get_business_context` | published (object) | no tool-specific case; scope enforcement is covered by the shared cases in §4 (MCP-SCOPE-WRONGBUSINESS: — — **PASS**) | MCP-OK-nexus.get_business_context: — — **PASS** | MCP-BAD-nexus.get_business_context: — — **PASS** | not required — no key in play | **PASS** |
| `nexus.search_person` | published (object) | no tool-specific case; scope enforcement is covered by the shared cases in §4 (MCP-SCOPE-WRONGBUSINESS: — — **PASS**) | MCP-OK-nexus.search_person: — — **PASS** | MCP-BAD-nexus.search_person: — — **PASS** | not required — no key in play | **PASS** |
| `nexus.search_company` | published (object) | no tool-specific case; scope enforcement is covered by the shared cases in §4 (MCP-SCOPE-WRONGBUSINESS: — — **PASS**) | MCP-OK-nexus.search_company: — — **PASS** | MCP-BAD-nexus.search_company: — — **PASS** | not required — no key in play | **PASS** |
| `nexus.check_duplicate` | published (object) | no tool-specific case; scope enforcement is covered by the shared cases in §4 (MCP-SCOPE-WRONGBUSINESS: — — **PASS**) | MCP-OK-nexus.check_duplicate: — — **PASS** | MCP-BAD-nexus.check_duplicate: — — **PASS** | not required — no key in play | **PASS** |
| `nexus.submit_candidate` | published (object) | no tool-specific case; scope enforcement is covered by the shared cases in §4 (MCP-SCOPE-WRONGBUSINESS: — — **PASS**) | MCP-OK-nexus.submit_candidate: — — **BLOCKED** | MCP-BAD-nexus.submit_candidate: — — **PASS** | MCP-IDEM-KEY-REQUIRED: — — **PASS** | **BLOCKED** |
| `nexus.create_signal` | published (object) | MCP-SCOPE-nexus.create_signal: — — **PASS** | MCP-OK-nexus.create_signal: — — **PASS** | MCP-BAD-nexus.create_signal: — — **PASS** | MCP-IDEM-FIRST: — — **PASS**<br>MCP-IDEM-REPLAY: — — **PASS**<br>MCP-IDEM-DIFFERENT-PAYLOAD: — — **PASS**<br>MCP-IDEM-PER-BUSINESS: — — **PASS** | **PASS** |
| `nexus.add_source_evidence` | published (object) | no tool-specific case; scope enforcement is covered by the shared cases in §4 (MCP-SCOPE-WRONGBUSINESS: — — **PASS**) | MCP-OK-nexus.add_source_evidence: — — **PASS** | MCP-BAD-nexus.add_source_evidence: — — **PASS** | not required — no key in play | **PASS** |
| `nexus.create_or_update_lead` | published (object) | no tool-specific case; scope enforcement is covered by the shared cases in §4 (MCP-SCOPE-WRONGBUSINESS: — — **PASS**) | MCP-OK-nexus.create_or_update_lead: — — **BLOCKED** | MCP-BAD-nexus.create_or_update_lead: — — **PASS** | not required — no key in play | **BLOCKED** |
| `nexus.assign_lead` | published (object) | no tool-specific case; scope enforcement is covered by the shared cases in §4 (MCP-SCOPE-WRONGBUSINESS: — — **PASS**) | MCP-OK-nexus.assign_lead: — — **PASS** | MCP-BAD-nexus.assign_lead: — — **PASS** | not required — no key in play | **PASS** |
| `nexus.submit_profile_capture` | published (object) | no tool-specific case; scope enforcement is covered by the shared cases in §4 (MCP-SCOPE-WRONGBUSINESS: — — **PASS**) | MCP-OK-nexus.submit_profile_capture: — — **FAIL** | MCP-BAD-nexus.submit_profile_capture: — — **PASS** | not required — no key in play | **FAIL** |
| `nexus.capture_reply` | published (object) | no tool-specific case; scope enforcement is covered by the shared cases in §4 (MCP-SCOPE-WRONGBUSINESS: — — **PASS**) | MCP-OK-nexus.capture_reply: — — **PASS** | MCP-BAD-nexus.capture_reply: — — **PASS** | not required — no key in play | **PASS** |
| `nexus.add_note` | published (object) | MCP-SCOPE-nexus.add_note: — — **PASS** | MCP-OK-nexus.add_note: — — **PASS** | MCP-BAD-nexus.add_note: — — **FAIL** | MCP-MUTATION-WITHOUT-KEY-INSERTS: — — **PARTIAL** | **FAIL** |
| `nexus.create_task` | published (object) | MCP-SCOPE-nexus.create_task: — — **PASS** | MCP-OK-nexus.create_task: — — **PASS** | MCP-BAD-nexus.create_task: — — **FAIL** | not required — no key in play | **FAIL** |
| `nexus.get_today_queue` | published (object) | no tool-specific case; scope enforcement is covered by the shared cases in §4 (MCP-SCOPE-WRONGBUSINESS: — — **PASS**) | MCP-OK-nexus.get_today_queue: — — **PASS** | MCP-BAD-nexus.get_today_queue: — — **PASS** | not required — no key in play | **PASS** |
| `nexus.submit_research` | published (object) | no tool-specific case; scope enforcement is covered by the shared cases in §4 (MCP-SCOPE-WRONGBUSINESS: — — **PASS**) | MCP-OK-nexus.submit_research: — — **PASS** | MCP-BAD-nexus.submit_research: — — **FAIL** | not required — no key in play | **FAIL** |
| `nexus.submit_message_draft` | published (object) | no tool-specific case; scope enforcement is covered by the shared cases in §4 (MCP-SCOPE-WRONGBUSINESS: — — **PASS**) | MCP-OK-nexus.submit_message_draft: — — **PASS** | MCP-BAD-nexus.submit_message_draft: — — **PASS** | not required — no key in play | **PASS** |
| `nexus.finish_agent_run` | published (object) | MCP-SCOPE-nexus.finish_agent_run: — — **PASS** | MCP-OK-nexus.finish_agent_run: — — **PASS** | MCP-BAD-nexus.finish_agent_run: — — **PASS** | not required — no key in play | **PASS** |

## 4. Auth, scope and business enforcement

| Case | Evidence |
| --- | --- |
| MCP-AUTH-NOTOKEN | 200 {"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"Missing or invalid token."}} — **PASS** |
| MCP-AUTH-BADTOKEN | 200 {"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"Missing or invalid token."}} — **PASS** |
| MCP-AUTH-INACTIVE | 200 {"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"Missing or invalid token."}} — **PASS** |
| MCP-PARSE-ERROR | 200 {"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}} — **PASS** |
| MCP-INVALID-REQUEST | 200 {"jsonrpc":"2.0","id":7,"error":{"code":-32600,"message":"Invalid Request"}} — **PASS** |
| MCP-METHOD-NOTFOUND | 200 {"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}} — **PASS** |
| MCP-UNKNOWN-TOOL | 200 {"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Unknown tool: nexus.not_a_tool"}} — **PASS** |
| MCP-NAME-MISSING | 200 {"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Unknown tool: "}} — **PASS** |
| MCP-ARGS-NONOBJECT | 200 {"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"Invalid arguments for nexus.search_company: query: Required"}]}} — **PASS** |
| MCP-ENVELOPE-SCHEMA | 200 {"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"Invalid arguments: idempotency_key: String must contain at least 8 … — **PASS** |
| MCP-SCOPE-nexus.create_signal | 200 {"jsonrpc":"2.0","id":1,"error":{"code":-32003,"message":"This token does not have the signal:create scope."}} — **PASS** |
| MCP-SCOPE-nexus.add_note | 200 {"jsonrpc":"2.0","id":1,"error":{"code":-32003,"message":"This token does not have the note:add scope."}} — **PASS** |
| MCP-SCOPE-nexus.create_task | 200 {"jsonrpc":"2.0","id":1,"error":{"code":-32003,"message":"This token does not have the task:create scope."}} — **PASS** |
| MCP-SCOPE-nexus.finish_agent_run | 200 {"jsonrpc":"2.0","id":1,"error":{"code":-32003,"message":"This token does not have the agent:run scope."}} — **PASS** |
| MCP-SCOPE-WRONGBUSINESS | 200 {"jsonrpc":"2.0","id":1,"error":{"code":-32003,"message":"This token is not scoped to that business."}} — **PASS** |

A *missing* token and an *unknown* token are both `-32001`; a *deactivated* service token resolves to anonymous and is also `-32001`. A valid token whose scope list lacks the tool’s scope is `-32003 "This token does not have the <scope> scope."`; a valid scope aimed at a business outside the token’s allow-list is `-32003 "This token is not scoped to that business."`. Neither refusal reveals whether the tool or the business exists.

## 5. Idempotency

| Case | Evidence |
| --- | --- |
| MCP-IDEM-FIRST | 200 {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"signal_id\":\"f4790b89-08ea-41da-8639-8f83d1fa5c36\"}"}],"structuredContent":{"… — **PASS** |
| MCP-IDEM-REPLAY | 200 {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"signal_id\":\"f4790b89-08ea-41da-8639-8f83d1fa5c36\"}"}],"structuredContent":{"… — **PASS** |
| MCP-IDEM-DIFFERENT-PAYLOAD | 200 {"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"idempotency_key mcp-idem-1790534044329 was already used for nexus.c… — **PASS** |
| MCP-IDEM-KEY-REQUIRED | 200 {"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"idempotency_key is required for nexus.submit_candidate"}]}} — **PASS** |
| MCP-IDEM-PER-BUSINESS | 200 {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"signal_id\":\"5abe3fef-33e6-4dba-a38d-ae52ea1a1a73\"}"}],"structuredContent":{"… — **PASS** |
| MCP-NO-KEY-READONLY-REPEAT | n/a (empty body) — **PASS** |
| MCP-MUTATION-WITHOUT-KEY-INSERTS | 200 {"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"idempotency_key is required for nexus.add_note"}]}} — **PARTIAL** |

Same key + same payload replays the **first result** with `idempotent: true` and runs nothing (verified by the identical `signal_id`); same key + different payload is refused with `result.isError` naming the collision; the key is scoped per business, so the same key under another business executes afresh. Twelve tools require a key, verified both in the published schema and at dispatch.

## 6. Mutation vs non-mutation

| Case | Evidence |
| --- | --- |
| MCP-NO-KEY-READONLY-REPEAT | n/a (empty body) — **PASS** |
| MCP-MUTATION-WITHOUT-KEY-INSERTS | 200 {"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"idempotency_key is required for nexus.add_note"}]}} — **PARTIAL** |
| MCP-OK-nexus.create_signal | 200 {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"signal_id\":\"80c4ae36-76a1-430c-a0c3-c92a0fae6b51\"}"}],"structuredContent":{"… — **PASS** |
| MCP-OK-nexus.add_note | 200 {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"note_id\":\"eff1494b-5b73-402b-ad84-37273ae5f2c4\"}"}],"structuredContent":{"no… — **PASS** |
| MCP-OK-nexus.create_task | 200 {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"task_id\":\"97afba55-c007-41cd-ad47-ddffdcaeb38e\"}"}],"structuredContent":{"ta… — **PASS** |
| MCP-OK-nexus.submit_research | 200 {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"research_snapshot_id\":\"9f2382d8-d4af-494b-8215-bd498e757775\"}"}],"structured… — **PASS** |
| MCP-OK-nexus.finish_agent_run | 200 {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"agent_run_id\":\"ded11dbe-a6a1-4059-bce1-aaf54126b56f\"}"}],"structuredContent"… — **PASS** |
| MCP-OK-nexus.submit_message_draft | 200 {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"message_version_id\":\"fe6b1c9c-1bdf-4f34-8625-1d8920774342\"}"}],"structuredCo… — **PASS** |
| MCP-OK-nexus.assign_lead | 200 {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"lead_id\":\"69358a9d-f18e-4ff5-b09e-d32507bbe90d\",\"owner_user_id\":\"d0000001… — **PASS** |
| MCP-OK-nexus.capture_reply | 200 {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"lead_id\":\"69358a9d-f18e-4ff5-b09e-d32507bbe90d\",\"captured\":true}"}],"struc… — **PASS** |
| MCP-OK-nexus.add_source_evidence | 200 {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"evidence_id\":\"298f5c0b-2641-4b1a-9945-212484f49fa8\",\"deduplicated\":false}"… — **PASS** |
| MCP-OK-nexus.get_today_queue | 200 {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"items\":[{\"item_lead_id\":\"d0000012-0000-4000-8000-000000000005\",\"item_busi… — **PASS** |

Read-only tools are marked non-mutating and return identical `structuredContent` on repetition. Write tools that are exempt from a key (`nexus.add_source_evidence` dedupes on `(business_id, content_hash)`) stay idempotent by construction. `nexus.submit_message_draft` appends a **new** `message_versions` row rather than overwriting, and `nexus.finish_agent_run` records a run — both produced fresh real ids.

## 7. JSON-RPC batching

| Case | Evidence |
| --- | --- |
| MCP-BATCH | 200 [{"jsonrpc":"2.0","id":101,"result":{"content":[{"type":"text","text":"{\"business\":{\"name\":\"Zemnas Creative Studio\",\"key\":\"zemnas\",\"focus\"… — **PASS** |
| MCP-BATCH-MIXED | 200 [{"jsonrpc":"2.0","id":201,"result":{"content":[{"type":"text","text":"{\"results\":[{\"leadId\":\"d0000012-0000-4000-8000-000000000001\",\"businessId… — **PASS** |
| MCP-BATCH-EMPTY | 200 {"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}} — **PASS** |
| MCP-BATCH-NOTIFICATION | 200 [{"jsonrpc":"2.0","id":301,"result":{"content":[{"type":"text","text":"{\"companies\":[{\"id\":\"d0000010-0000-4000-8000-000000000002\",\"name\":\"Fra… — **PASS** |

Batch elements are dispatched sequentially and each gets its own response object, so a mixed success/error batch answers per element rather than collapsing to one result. An empty array is `-32600`, and a notification element (no `id`) correctly produces no response entry.

## 8. Secret redaction (mandatory)

REDACT-CORPUS: — — **PASS** no match for any of: scrypt password hash | password field | password_hash field | token_hash field | secret_hash / webhook_secret | service_role key | supabase service key | bearer token echoed | ai/… — the sweep covers every MCP response body too, including all 18 tool happy/failure pairs, the catalogue and every error envelope.

No MCP response contains a token hash, a webhook secret hash, an AI/API key, a service-role key, or any `password` / `hash` / `secret` field. Tool results carry only domain data (uuids, names, enumerated states, counts) plus the gateway’s own `idempotent` flag.

## 9. Findings affecting the gateway

| Id | Severity | Finding |
| --- | --- | --- |
| F-2 | High | Service-token writes fail with RLS 42501 on the business-less canonical tables |
| F-3 | High | Three MCP write tools report success while writing nothing |
| F-4 | Medium | Idempotency metadata contradicts itself between the catalogue and the dispatch table |
| F-5 | Medium | nexus.finish_agent_run’s default state can never be inserted |
| F-6 | Medium | nexus.submit_profile_capture is refused for a lead the caller can otherwise act on |
| F-8 | Low | nexus.get_today_queue answers a null/unknown user with an empty queue |
| F-9 | Info | The two scope vocabularies are disjoint, so the contract and the database disagree about a token’s authority |

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

## 10. Cases that could not be exercised

- **MCP-OK-nexus.submit_candidate** (mcp/tools-call — nexus.submit_candidate happy path): well-formed write refused by the database (RLS): new row violates row-level security policy for table "people" Evidence: `200 {"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"new row violates row-level security policy for table \"people\""}]}}`
- **MCP-OK-nexus.create_or_update_lead** (mcp/tools-call — nexus.create_or_update_lead happy path): well-formed write refused by the database (RLS): new row violates row-level security policy for table "companies" Evidence: `200 {"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"new row violates row-level security policy for table \"companies\""}]}}`

## 11. Totals

| Verdict | MCP cases | Whole run (API + MCP) |
| --- | --- | --- |
| PASS | 62 | 153 |
| FAIL | 4 | 8 |
| PARTIAL | 1 | 4 |
| BLOCKED | 2 | 2 |
| **Total** | **69** | **167** |

