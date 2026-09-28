# NEXUS V1.2 — MCP Contract

The V1.2 tool surface exposed to ChatGPT, OpenCode and any other MCP client, and
the boundaries those clients cannot cross. Reference:
`product/NEXUS_V1_2_MASTER_SPEC.md` §19–§20, `apps/web/src/app/api/v1/mcp/`.

## 1. Transport

JSON-RPC 2.0 over HTTP at `POST /api/v1/mcp` (`initialize`, `tools/list`,
`tools/call`). Batch requests are executed sequentially, because several elements
of a batch may write. `GET /api/v1/mcp` returns the tool list for capability
discovery.

Authentication is a bearer token:

* `nxu_…` — a user token, resolved to a user id and then subject to the ordinary
  `withActor` path, so RLS decides visibility exactly as it does for the web app.
* `nxs_…` — a service token (`api_clients`), carrying an explicit scope list and
  a business allow-list.

Both are hashed with SHA-256 and compared against `api_clients.token_hash` /
`user_api_tokens.token_hash`. **No database credential is ever issued to a client,
and there is no tool that accepts SQL.** `MCP_TOOLS` is a closed list, the dispatch
table is an exhaustive `Record<McpToolName, handler>`, and
`FORBIDDEN_MCP_TOOLS` (`database.execute_sql`, `nexus.execute_sql`,
`nexus.run_sql`, `nexus.query`) can never reach a handler. `pnpm run db:verify`
additionally fails the build if any function whose name matches
`%execute_sql%`/`%exec_sql%` exists in the schema.

## 2. Envelope and validation

Every call may carry:

| Key | Meaning |
| --- | --- |
| `business_id` | required on every business-scoped tool; checked against the token's allow-list before dispatch |
| `business_key` | accepted as an alternative business reference |
| `idempotency_key` | required on every writing tool; the same key is never applied twice for the same caller, business and tool |
| `source_client` | provenance label |
| `agent_run_id` | links the call to an `agent_runs` row |

Arguments are validated against a per-tool Zod schema *before* dispatch and
unknown keys are stripped rather than rejected, so an extra field never becomes a
silent refusal. Envelope keys are extracted first, so a tool never sees them.

`tools/list` publishes a JSON Schema derived from the same Zod declarations, so a
client that generates its call from the catalogue produces something the server
accepts: required fields, enums and the idempotency requirement are all advertised.

## 3. Idempotency

`public.mcp_tool_invocations` records `(caller, business, tool, key,
arguments_hash, result)`. A replay with the same arguments returns the *first*
result and does not run the tool again. A replay with **different** arguments is
refused, because answering it with the earlier result would hide the client's bug
behind a plausible response. Ingestion-shaped tools carry a second, deeper key
(`ingest_requests`), so a retry after a crash mid-pipeline is safe too.

## 4. Tools

### 4.1 Discovery and reading (spec's original list)

| Tool | Scope | Notes |
| --- | --- | --- |
| `nexus.list_accessible_businesses` | `businesses:read` | the only tool that is not business-scoped |
| `nexus.get_business_context` | `context:read` | |
| `nexus.search_person` | `person:search` | |
| `nexus.search_company` | `company:search` | |
| `nexus.check_duplicate` | `duplicate:check` | |
| `nexus.get_today_queue` | `today:read` | |
| `nexus.get_lead_enrichment_context` | `lead:read` | V1.2: enrichment state, completeness, channels, deterministic search links |

### 4.2 Writing a lead

| Tool | Scope | Notes |
| --- | --- | --- |
| `nexus.submit_candidate` | `candidate:submit` | full ingest pipeline |
| `nexus.create_or_update_lead` | `lead:create` | full ingest pipeline |
| `nexus.submit_minimal_lead` | `lead:create` | V1.2: name + company + source (+ optional title/headline/snippet) only |
| `nexus.submit_profile_data` | `profile:capture` | V1.2: pasted profile, extracted, committed, raw deleted |
| `nexus.assign_lead` | `lead:assign` | |
| `nexus.create_signal` | `signal:create` | |
| `nexus.add_source_evidence` | `evidence:add` | |
| `nexus.submit_source_metadata` | `evidence:add` | V1.2: metadata + structured summary, never a raw body |
| `nexus.capture_reply` | `reply:capture` | exact inbound text, verbatim | capture commits first; the AI reading is a separate result (`classification`, or `null` with a typed `classification_error`), and a `Do not contact` capture stays DNC whatever the model reads |
| `nexus.add_note` | `note:add` | |
| `nexus.create_task` | `task:create` | |
| `nexus.submit_research` | `research:submit` | |
| `nexus.submit_message_draft` | `message:draft` | new immutable version; never an overwrite |
| `nexus.finish_agent_run` | `agent_run:finish` | |

### 4.3 Agent jobs (V1.2)

| Tool | Scope | Idempotency | Notes |
| --- | --- | --- | --- |
| `nexus.create_agent_job` | `jobs:create` | required | deduplicated by `dedupe_key` among active jobs |
| `nexus.list_agent_jobs` | `jobs:read` | not required | filter by status/type/lead, paged |
| `nexus.get_agent_job` | `jobs:read` | not required | includes the event history |
| `nexus.claim_agent_job` | `jobs:claim` | required | atomic, capability-matched, leases the job |
| `nexus.heartbeat_agent_job` | `jobs:claim` | required | only the holder |
| `nexus.release_agent_job` | `jobs:claim` | required | returns the job to the queue |
| `nexus.submit_agent_job_result` | `jobs:submit` | required | stages raw, sets `WAITING_AI` |
| `nexus.fail_agent_job` | `jobs:submit` | required | typed code, retryable or terminal |
| `nexus.submit_company_research` | `jobs:submit` | required | stages raw, extracts, commits, deletes raw, completes |

There is **no** tool that completes a job, and no manual-complete path anywhere in
the product. See `docs/V1_2_AGENT_JOBS.md` §5.

## 5. What a client can and cannot do

**ChatGPT may:** find leads needing enrichment, add minimal leads, create research
jobs, read a lead's structured enrichment context, add notes and tasks, and request
drafts through `nexus.submit_message_draft`. It cannot read a raw pasted body —
those are deleted after extraction — and it cannot run SQL.

**OpenCode may:** list open browser-research jobs, claim one, heartbeat while it
works, submit the evidence it gathered, and release or fail the job safely. It
cannot mark a job complete, cannot write canonical fields directly, and receives no
database credential.

**Neither may:** read another business's data. Every policy is `to authenticated`
and reads `current_user_id()` / `acting_api_client_id()`; a service token is
additionally bounded by `api_clients.business_ids` and `api_clients.scopes`, both
of which are mandatory terms. A refusal never distinguishes "does not exist" from
"not visible to you".

## 6. Raw data over MCP

`nexus.submit_agent_job_result`, `nexus.submit_company_research` and
`nexus.submit_profile_data` accept raw text as *input*. It lands in
`raw_staging`, is extracted by DeepSeek, and is deleted once the structured commit
is verified. The staging table is `ENABLE` + `FORCE` row level security with a
single policy that only members of the `nexus_raw_writer` role satisfy, and its
privileges are revoked from `authenticated` outright — so no MCP client, however
scoped, can read it back. Only the metadata survives: source type, source URL,
observed timestamp, content hash, collector agent, agent job id, prompt version,
model, extraction timestamp.

## 7. Errors

Transport-level failures (bad token, unscoped business, missing scope, unknown
tool) are JSON-RPC errors; a refusal inside a valid call is returned in
`result.isError` with operator-safe text, so an agent can distinguish "fix your
arguments" from "the call failed". No error message quotes a raw payload, and
provider errors are passed through `redactSecrets` before they are logged.

## 8. Scope vocabulary

Scopes are declared once in `packages/core/src/permissions.ts` (`API_SCOPES`) and
mapped per tool in `MCP_TOOL_SCOPES`. V1.2 adds `jobs:read`, `jobs:create`,
`jobs:claim` and `jobs:submit`; the three writing scopes are also in
`WRITE_SCOPES`, so the integrations UI can grant them and the audit rules treat
them as mutations. The database-side capability names used by
`nexus_job_scope_ok` are the same strings, so a token that can call a tool can
also satisfy the SQL check behind it.
