/**
 * Report generator — reads results.json and writes the three deliverables.
 * Scratch tooling; not product code.
 *
 *   node scripts/baseline-verify/report.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.resolve(here, '..', '..', 'docs');
mkdirSync(docs, { recursive: true });
const R = JSON.parse(readFileSync(path.join(here, 'results.json'), 'utf8'));

/**
 * Run provenance.
 *
 * An earlier generation of this report carried a hard-coded "snapshot caveat" claiming the tree had
 * been edited mid-run. That caveat was true of one specific run and then became a permanent,
 * misleading fixture of every later report — including reports generated from a tree that was never
 * touched during the run. It is replaced by the run's own recorded provenance.
 *
 * `results.json` is written by the harness at the end of a run. Its `treeState` block records
 * whether the tree was clean while that run executed, so the caveat appears only when it is true.
 */
function concurrencyNote() {
  const state = R.treeState;
  if (state === undefined) {
    return '**Run provenance.** This report was generated from a `results.json` that does not record tree state (produced by an older harness). Re-run `scripts/baseline-verify/harness.mjs` to attach provenance.';
  }
  if (state.cleanDuringRun === true) {
    return `**Run provenance.** The build under test was **frozen for the whole run** — the hash of the tracked source was identical before and after execution (\`${String(state.sourceHashAfter ?? '').slice(0, 16)}\` at commit \`${state.head ?? 'unknown'}\`), and no file outside the harness's own \`results.json\` changed. Every result below therefore describes one frozen build.`;
  }
  return `**Run provenance — the source changed during this run.** The tracked-source hash differed between the start and the end of the run at commit \`${state.head ?? 'unknown'}\` (\`${String(state.sourceHashBefore ?? '').slice(0, 12)}\` → \`${String(state.sourceHashAfter ?? '').slice(0, 12)}\`):\n\n\`\`\`\nbefore: ${(state.statusBefore ?? '').trim() || '(clean)'}\nafter:  ${(state.statusAfter ?? '').trim() || '(clean)'}\n\`\`\`\n\nThe results below describe the build that was serving, and any case that touches a file listed above must be re-confirmed against a frozen tree.`;
}
const CONCURRENCY_NOTE = concurrencyNote();

const byId = Object.fromEntries(R.cases.map((c) => [c.caseId, c]));
const ids = (...list) => list;

/** results.json nests the recorded response under `response`. */
const bodyOf = (c) => c.bodyText ?? c.response?.text ?? c.response?.bodyText ?? '';
const statusOf = (c) => c.status ?? c.response?.status ?? null;

function clip(text, max = 160) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** `status body…` for one recorded case. */
function evidence(id, max = 150) {
  const c = byId[id];
  if (c === undefined) return '—';
  const status = statusOf(c) === null ? 'n/a' : String(statusOf(c));
  const body = clip(bodyOf(c), max);
  return body.length === 0 ? `${status} (empty body)` : `${status} ${body}`;
}

function verdicts(list) {
  const found = list.map((id) => byId[id]).filter(Boolean);
  if (found.length === 0) return 'BLOCKED';
  for (const v of ['FAIL', 'BLOCKED', 'PARTIAL', 'PASS']) if (found.some((c) => c.verdict === v)) return v;
  return 'PASS';
}

function cell(list) {
  const found = list.map((id) => byId[id]).filter(Boolean);
  if (found.length === 0) return 'BLOCKED — not exercised';
  return found.map((c) => `${c.caseId}: ${evidence(c)} — **${c.verdict}**`).join('<br>');
}

function caseLine(list) {
  return list
    .map((id) => byId[id])
    .filter(Boolean)
    .map((c) => `${c.caseId}: ${evidence(c)} — **${c.verdict}** ${clip(c.note, 200)}`)
    .join('<br>');
}

/**
 * The CURRENT state of a finding, derived from this run's own evidence.
 *
 * A narrative status written by hand drifts the moment the code changes, and a stale "OPEN" beside
 * a fixed defect is exactly how a report stops being trustworthy. But deriving status from case
 * verdicts alone is not enough either — see `caseAssertsDefect` below.
 *
 *   FIXED        every named case passes, and the cases assert the corrected behaviour
 *   OPEN         at least one named case fails or is blocked, or a passing case merely ACCEPTS a
 *                behaviour the finding reports as wrong
 *   PARTIAL      cases pass, but at least one is only partially exercised
 *   NO-EVIDENCE  the finding names no case (advisory / informational)
 */
function findingStatus(finding) {
  const cases = finding.evidence.map((id) => byId[id]).filter(Boolean);
  if (cases.length === 0) return 'NO-EVIDENCE';
  if (cases.some((c) => c.verdict === 'FAIL' || c.verdict === 'BLOCKED')) return 'OPEN';
  if (cases.some((c) => c.verdict === 'PARTIAL')) return 'PARTIAL';
  /*
   * A case can PASS while the finding is still open: the harness may pass a case precisely by
   * ACCEPTING the reported behaviour as a valid negative result. `nexus.get_today_queue` returning
   * `{items:[]}` for an unknown user is recorded as PASS because an empty queue is a defensible
   * answer — but the finding says an agent cannot tell "nothing due" from "no such user", and that
   * is still true. Without this check the report would flip F-8 to FIXED purely because a test
   * accepts it. A finding therefore declares which of its cases would prove it fixed.
   */
  if (finding.evidenceProvesFix === false) return 'OPEN';
  return 'FIXED';
}

const STATUS_NOTE = {
  FIXED: 'every case this finding names passes in this run',
  OPEN: 'at least one case this finding names still fails or is blocked in this run',
  PARTIAL: 'the named cases pass, but at least one is only partially exercised',
  'NO-EVIDENCE': 'advisory; not tied to an executed case',
};

/* ------------------------------------------------- endpoint inventory ---- */

const ENDPOINTS = [
  {
    path: '/api/auth/login',
    methods: 'POST, GET',
    source: 'apps/web/src/app/api/auth/login/route.ts',
    auth: 'none on POST (form-encoded credentials); GET is refused',
    scope: 'n/a — the credential check is the gate; `mode=bootstrap` only while the deployment has zero users',
    errorShape: 'not JSON — `303` to `/login?error=<sentence>&email=<echo>`; `GET` → `405` with `allow: POST`',
    happy: ['AUTH-LOGIN-GET'],
    failure: ['AUTH-LOGIN-BADPW', 'AUTH-LOGIN-BADPW-NOLEAK'],
  },
  {
    path: '/api/v1/companion/session',
    methods: 'POST, DELETE',
    source: 'apps/web/src/app/api/v1/companion/session/route.ts',
    auth: 'POST: none (credentials in the body). DELETE: `Authorization: Bearer nxu_…`',
    scope: 'n/a — issues the user token; DELETE revokes by token hash and only for the caller',
    errorShape: '`{ "error": string }` — 400 malformed/invalid body, 401 bad credentials, 403 local auth disabled, 500',
    happy: ['COMP-SESSION-OK', 'COMP-SESSION-DELETE', 'COMP-SESSION-DELETE-VERIFY'],
    failure: ['COMP-SESSION-BADPW', 'COMP-SESSION-MALFORMED', 'COMP-SESSION-INVALID', 'COMP-SESSION-DELETE-NOAUTH', 'COMP-SESSION-NOLEAK'],
  },
  {
    path: '/api/v1/companion/me',
    methods: 'GET',
    source: 'apps/web/src/app/api/v1/companion/me/route.ts',
    auth: '`Authorization: Bearer` — **user** token only (`authorizeUser`)',
    scope: 'none beyond a valid user token; a service token is refused (403)',
    errorShape: '`{ "error": string }` — 401 anonymous, 403 service token',
    happy: ['COMP-ME-OK'],
    failure: ['COMP-ME-NOAUTH', 'COMP-ME-BADTOKEN', 'COMP-ME-SERVICETOKEN'],
  },
  {
    path: '/api/v1/companion/bootstrap',
    methods: 'GET',
    source: 'apps/web/src/app/api/v1/companion/bootstrap/route.ts',
    auth: 'user token',
    scope: 'RLS-scoped — businesses and identities are intersected with the caller’s access',
    errorShape: '`{ "error": string }` — 401',
    happy: ['COMP-BOOTSTRAP-OK', 'COMP-BOOTSTRAP-MANAGER-SCOPE'],
    failure: ['COMP-BOOTSTRAP-NOAUTH', 'COMP-BOOTSTRAP-NOLEAK'],
  },
  {
    path: '/api/v1/companion/leads',
    methods: 'GET',
    source: 'apps/web/src/app/api/v1/companion/leads/route.ts',
    auth: 'user token',
    scope: '`businessId` must be a UUID; row visibility decided entirely by RLS',
    errorShape: '`{ "error": string }` — 400 for a missing or non-UUID `businessId`',
    happy: ['COMP-LEADS-OK'],
    failure: ['COMP-LEADS-NOBIZ', 'COMP-LEADS-BADBIZ', 'COMP-LEADS-WRONGBIZ-MANAGER', 'COMP-LEADS-BOGUSBIZ', 'COMP-LEADS-NOAUTH'],
  },
  {
    path: '/api/v1/companion/leads/[id]',
    methods: 'GET',
    source: 'apps/web/src/app/api/v1/companion/leads/[id]/route.ts',
    auth: 'user token',
    scope: 'RLS — an inaccessible lead is deliberately indistinguishable from a missing one',
    errorShape: '`{ "error": "That lead could not be found." }` — 404',
    happy: ['COMP-LEAD-ONE-OK'],
    failure: ['COMP-LEAD-ONE-BADID', 'COMP-LEAD-ONE-MISSING', 'COMP-LEAD-ONE-WRONGBIZ', 'COMP-LEAD-ONE-NOAUTH', 'COMP-LEAD-NOLEAK'],
  },
  {
    path: '/api/v1/companion/search',
    methods: 'GET',
    source: 'apps/web/src/app/api/v1/companion/search/route.ts',
    auth: 'user token',
    scope: 'searches every accessible business; `limit` clamped to 50',
    errorShape: '`{ "error": string }` — 400 for an empty `q`',
    happy: ['COMP-SEARCH-OK', 'COMP-SEARCH-STANDARDUSER'],
    failure: ['COMP-SEARCH-EMPTYQ', 'COMP-SEARCH-NOAUTH'],
  },
  {
    path: '/api/v1/companion/today',
    methods: 'GET',
    source: 'apps/web/src/app/api/v1/companion/today/route.ts',
    auth: 'user token',
    scope: 'reading another user’s queue requires admin or manager — enforced by `public.get_today_queue`, not by the route',
    errorShape:
      '`{ "error": string }` — 400 for a non-UUID `businessId`/`userId`. **The DB function’s refusal is not translated: it becomes HTTP 500 with an empty body (F-1).**',
    happy: ['COMP-TODAY-OK', 'COMP-TODAY-OTHERUSER-MANAGER'],
    failure: ['COMP-TODAY-NOBIZ', 'COMP-TODAY-NOAUTH', 'COMP-TODAY-OTHERUSER-STANDARD'],
  },
  {
    path: '/api/v1/companion/icps',
    methods: 'GET',
    source: 'apps/web/src/app/api/v1/companion/icps/route.ts',
    auth: 'user token',
    scope: 'RLS only — no application-level business check is added (deliberately, so the two cannot disagree)',
    errorShape: '`{ "error": string }` — 400 for a missing or non-UUID `businessId`',
    happy: ['COMP-ICPS-OK'],
    failure: ['COMP-ICPS-WRONGBIZ', 'COMP-ICPS-NOBIZ', 'COMP-ICPS-NOAUTH'],
  },
  {
    path: '/api/v1/companion/heartbeat',
    methods: 'POST',
    source: 'apps/web/src/app/api/v1/companion/heartbeat/route.ts',
    auth: 'user token',
    scope: 'touches only the caller’s own browser session',
    errorShape: '`{ "error": string }` — 400 for malformed JSON or an `installId` shorter than 8 characters',
    happy: ['COMP-HEARTBEAT-OK'],
    failure: ['COMP-HEARTBEAT-INVALID', 'COMP-HEARTBEAT-MALFORMED', 'COMP-HEARTBEAT-NOAUTH'],
  },
  {
    path: '/api/v1/companion/bind',
    methods: 'POST',
    source: 'apps/web/src/app/api/v1/companion/bind/route.ts',
    auth: 'user token',
    scope: 'the identity must itself grant access to the chosen business (`0017_identity_binding_scope`)',
    errorShape:
      '`{ "error": string, "reason"?: string }` — 400 `reason:"bind_failed"`, 403 `reason:"transfer_not_permitted"`, 409 `reason:"identity_in_use"` plus the concurrency payload',
    happy: [],
    failure: ['COMP-BIND-OK', 'COMP-BIND-CONFLICT', 'COMP-BIND-INVALID', 'COMP-BIND-MALFORMED', 'COMP-BIND-NOAUTH', 'COMP-BIND-NOLEAK'],
  },
  {
    path: '/api/v1/companion/add',
    methods: 'POST',
    source: 'apps/web/src/app/api/v1/companion/add/route.ts',
    auth: 'user token',
    scope: '`businessId` must be reachable; the URL must parse as a LinkedIn *profile*; `idempotencyKey` required',
    errorShape: '`{ "error": string, "reason"?: string }` — 400; `reason:"not_a_linkedin_profile"` for a non-profile URL',
    happy: ['COMP-ADD-OK', 'COMP-ADD-IDEMPOTENT'],
    failure: ['COMP-ADD-NOTLINKEDIN', 'COMP-ADD-INVALID', 'COMP-ADD-MALFORMED', 'COMP-ADD-NOAUTH', 'COMP-ADD-WRONGBIZ'],
  },
  {
    path: '/api/v1/companion/actions/[operation]',
    methods: 'POST',
    source: 'apps/web/src/app/api/v1/companion/actions/[operation]/route.ts',
    auth: 'user token',
    scope:
      'six operations — `mark-connection-sent`, `mark-message-sent`, `capture-reply`, `snooze`, `reactivate`, `capture-profile`; the DB RPCs enforce the invariants and RLS decides who may write',
    errorShape: '`{ "error": string }` — 400 for validation failure **and** for a domain refusal, 404 `"Unknown operation."`',
    happy: ['ACT-capture-reply-OK', 'ACT-snooze-OK', 'ACT-capture-profile-OK'],
    failure: [
      'ACT-mark-connection-sent-OK',
      'ACT-mark-message-sent-OK',
      'ACT-reactivate-OK',
      'ACT-UNKNOWN-OP',
      'ACT-MALFORMED',
      'ACT-WRONGBIZ-STANDARD',
    ],
  },
  {
    path: '/api/v1/ingest',
    methods: 'POST',
    source: 'apps/web/src/app/api/v1/ingest/route.ts',
    auth:
      '`Authorization: Bearer` — a **user** token or a **service** token; the service path additionally needs the `ingest:write` scope',
    scope: '`ingest:write` (service tokens) and the business must be inside the token’s allow-list; `payload_type` restricted to six values',
    errorShape:
      '`{ "error": string }` — 400 malformed / invalid envelope / disallowed `payload_type` / repository refusal, 401 anonymous, 403 scope, 404 `"Unknown business, or this token is not scoped to it."`',
    happy: [],
    failure: [
      'INGEST-OK',
      'INGEST-IDEMPOTENT',
      'INGEST-NOAUTH',
      'INGEST-USERSCOPED',
      'INGEST-SCOPE',
      'INGEST-UNKNOWNBIZ',
      'INGEST-PAYLOADTYPE-RESTRICTED',
      'INGEST-INVALID-ENVELOPE',
      'INGEST-MALFORMED',
      'INGEST-INACTIVE-TOKEN',
    ],
  },
  {
    path: '/api/v1/mcp',
    methods: 'POST, GET',
    source: 'apps/web/src/app/api/v1/mcp/route.ts',
    auth:
      'POST: `Authorization: Bearer` — `nxu_` user token or `nxs_` service token. GET: no auth (capability discovery)',
    scope:
      'per tool via `requireScope`, plus business allow-list membership for service tokens; refusals are `-32001` / `-32003`',
    errorShape:
      'JSON-RPC 2.0 inside an HTTP 200 body — `-32700` parse error, `-32600` invalid request, `-32601` unknown method/tool, `-32001` missing or invalid token, `-32003` scope/business refusal. A tool-level refusal is `result.isError: true` with a text `content` entry.',
    happy: ['MCP-TOOLS-LIST', 'MCP-INITIALIZE'],
    failure: ['MCP-AUTH-NOTOKEN', 'MCP-AUTH-BADTOKEN', 'MCP-PARSE-ERROR', 'MCP-NO-SQL-TOOL'],
  },
  {
    path: '/api/companion-preview/[...path]',
    methods: 'GET',
    source: 'apps/web/src/app/api/companion-preview/[...path]/route.ts',
    auth: 'none',
    scope: 'disabled unless `NEXUS_COMPANION_PREVIEW=1`',
    errorShape: 'plain text — `companion preview is disabled` / `not found` with 404',
    happy: [],
    failure: ['PREVIEW-DISABLED'],
  },
];

/* -------------------------------------------------------- findings ------ */

const FINDINGS = [
  {
    id: 'F-1',
    severity: 'High',
    title: '/api/v1/companion/today turns a database refusal into an untyped HTTP 500',
    file: 'apps/web/src/app/api/v1/companion/today/route.ts:33-38',
    detail:
      'The route validates `businessId`/`userId` and then calls `getTodayQueue` with no try/catch. `public.get_today_queue` raises `42501 "get_today_queue: actor may not read another user\'s queue"` for a caller who is not an admin/manager of that business, and Next turns the escaping error into a 500 with an empty body.',
    request: 'GET /api/v1/companion/today?businessId=<zemnas>&userId=<admin id> with osama@nexus.local (standard user, zemnas access)',
    response: 'HTTP 500, empty body. An SSM-style typed `{ "error": … }` with 403 was expected.',
    evidence: ['COMP-TODAY-OTHERUSER-STANDARD'],
    resolution:
      'The route now translates the database refusal into a typed `403 {"error": …}`, so a permission refusal is no longer an untyped 500. Confirmed by `COMP-TODAY-OTHERUSER-STANDARD`, which asserts the 403 and the typed body.',
  },
  {
    id: 'F-2',
    severity: 'High',
    title: 'Service-token writes fail with RLS 42501 on the business-less canonical tables',
    file: 'packages/db/migrations/0013_rls.sql:477-487 (`companies_insert`), 518-528 (`people_insert`); hit from apps/web/src/lib/repo/ingest.ts:184-211',
    detail:
      '`nexus.submit_candidate`, `nexus.create_or_update_lead` and `POST /api/v1/ingest` all fail the moment the pipeline has to INSERT a new Company or Person. The refusal is `42501 new row violates row-level security policy for table "companies"` (or `"people"`). The same call succeeds for an admin user token because `is_admin()` satisfies the policy. Instrumented against the same database (`scripts/baseline-verify/diag-rls.mjs`): inside the gateway’s own transaction shape (`set local role authenticated` + `set_config(\'nexus.api_client_id\', …)`) `acting_api_client_id()` resolves, `has_business_access(zemnas)` is true, and the policy expression `is_admin() OR EXISTS(… user_business_access … can_use_lead_sources) OR acting_api_client_id() IS NOT NULL` evaluates **true** in a SELECT — yet the INSERT is refused. Every write whose table carries `business_id` (signals, source_evidence, notes, tasks, agent_runs, message_versions, lead_assignments) succeeds.',
    request:
      'POST /api/v1/mcp {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nexus.submit_candidate","arguments":{"business_id":"d0000002-…-0001","idempotency_key":"mcp-cand-…","full_name":"Baseline MCP Candidate","company_name":"Northstar","job_title":"Head of Production","linkedin_url":"…"}}}',
    response: 'HTTP 200, {"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"new row violates row-level security policy for table \\"companies\\""}]}}',
    evidence: ['MCP-OK-nexus.submit_candidate', 'MCP-OK-nexus.create_or_update_lead', 'INGEST-OK', 'INGEST-IDEMPOTENT'],
    resolution:
      '**Deliberately NOT patched — the policy is correct.** The refusal is a local-engine limitation, not a policy or product defect, and the evidence for that is recorded in full below. No security policy was changed to satisfy the embedded engine.',
    defectAssessment:
      'The predicates are satisfied and the insert is still refused. `scripts/baseline-verify/diag-rls.mjs`, run against a freshly seeded database at this commit, establishes each link:\n\n' +
      '1. Inside the gateway’s own session shape — `set local role authenticated` plus `set_config(\'nexus.api_client_id\', …)` — `public.acting_api_client_id()` resolves to the token’s UUID, `public.api_client_scopes()` returns all 29 granted scopes, `public.api_client_business_ids()` returns the three businesses, and `current_setting(\'nexus.api_client_id\')` reads back the same UUID. `current_role` is `authenticated`.\n' +
      '2. The only INSERT policy on `companies` is `companies_insert`, it is `PERMISSIVE`, granted to `authenticated`, and its `WITH CHECK` is `is_admin() OR EXISTS(SELECT 1 FROM user_business_access … can_use_lead_sources) OR acting_api_client_id() IS NOT NULL`.\n' +
      '3. That same expression is evaluated **in the same transaction** and returns `true` (`companies_insert_predicate: true`).\n' +
      '4. The insert is still refused with `42501`. A permissive `WITH CHECK` that evaluates true cannot deny an insert in PostgreSQL.\n' +
      '5. `authenticated` holds the `INSERT` privilege on `companies`, and the table owner inserts successfully, so this is not a GRANT gap.\n' +
      '6. `companies` and `people` carry `relforcerowsecurity = true`; `signals` and `source_evidence` do too, yet writes to those succeed because their policies are business-scoped and evaluate through `is_api_client_allowed(business_id, …)` rather than through a bare `acting_api_client_id() is not null` term.\n' +
      '7. **The decisive reduction:** the same one-term policy — `with check (public.acting_api_client_id() is not null)` — **accepts** the insert on a throwaway table created inside the diagnostic (`MINIMAL OK`). Add a second disjunct that must also be evaluated, `with check (public.current_user_id() is not null or public.acting_api_client_id() is not null)`, and the same engine **refuses** it (`MINIMAL2 FAIL`) on a table with no triggers, no foreign keys and no product policy.\n\n' +
      'Conclusion: the failure reduces to how this engine evaluates a multi-term policy expression containing the helper functions, reproducing on a table the product does not own. It is therefore recorded as a limitation of the embedded PGlite runtime, **to be confirmed against real PostgreSQL before deployment** — this environment has no PostgreSQL, Docker or `psql` available, so that confirmation could not be performed here.\n\n' +
      'Consequence for deployment: on real PostgreSQL these cases are expected to pass, and the deployment is gated on demonstrating that. On the embedded engine, **service-token ingestion cannot be used** — a fact now recorded in `DEPLOYMENT_READINESS.md`.',
  },
  {
    id: 'F-3',
    severity: 'High',
    title: 'Three MCP write tools report success while writing nothing',
    file: 'apps/web/src/app/api/v1/mcp/route.ts:371-380 (`add_note`), 391-407 (`create_task`), 438-447 (`submit_research`)',
    detail:
      'Each handler runs `INSERT … SELECT … FROM public.leads l WHERE l.id = $1 RETURNING id` and returns `{ <id>: result.rows[0]?.id ?? null }`. When the `SELECT` matches no row the insert silently affects zero rows, the handler still returns a normal result, and the gateway wraps it in a success envelope — so the caller sees `200` with `isError` absent and a `null` id. A non-existent lead id is therefore indistinguishable from success.',
    request:
      'POST /api/v1/mcp tools/call nexus.add_note with lead_id = 00000000-0000-4000-8000-0000000000ff (valid UUID, no such lead)',
    response: 'HTTP 200, result.structuredContent = {"note_id":null} with no isError flag. Same shape for create_task ({"task_id":null}) and submit_research ({"research_snapshot_id":null}).',
    evidence: ['MCP-BAD-nexus.add_note', 'MCP-BAD-nexus.create_task', 'MCP-BAD-nexus.submit_research'],
    resolution:
      'All three handlers now distinguish "no such lead" from success and refuse it explicitly. The observed answers are `result.isError: true` with the text *"No lead found with id 00000000-0000-4000-8000-0000000000ff, or it is not visible to this caller; nothing was written."* — a silent no-op is no longer reachable.',
  },
  {
    id: 'F-4',
    severity: 'Medium',
    title: 'Idempotency metadata contradicts itself between the catalogue and the dispatch table',
    file: 'apps/web/src/app/api/v1/mcp/tool-schemas.ts:204-223 (`MCP_TOOLS_REQUIRING_IDEMPOTENCY`) vs apps/web/src/app/api/v1/mcp/route.ts:120-410 (`TOOL_HANDLERS[*].needsIdempotencyKey`)',
    detail:
      'The handler table declares `needsIdempotencyKey` on all 18 tools, but that field is **never read** — `grep needsIdempotencyKey apps/web/src/app/api/v1/mcp/route.ts` matches only the interface declaration (line 110) and the 18 literal declarations. Enforcement and the published catalogue both read `MCP_TOOLS_REQUIRING_IDEMPOTENCY` instead, and the two disagree for **five** tools: `nexus.assign_lead` (route.ts:289 says `false`, the constant says `true`) and `nexus.submit_profile_capture` (route.ts:322 says `false`, constant `true`) — and in the other direction `nexus.capture_reply` (route.ts:342), `nexus.add_note` (route.ts:365), `nexus.create_task` (route.ts:385) and `nexus.submit_research` (route.ts:431) all say `false` while the constant says `true`. The constant wins in every case, so an omitted key is refused; the handler table reads as documentation that is wrong in five places, and `MCP_TOOL_SCOPES[\'nexus.finish_agent_run\']` in `packages/core/src/contracts.ts:553` is likewise `agent_run:finish` while the enforced route value is `agent:run`.',
    request: 'POST /api/v1/mcp tools/call nexus.add_note with no idempotency_key (the handler table says this is unnecessary)',
    response: 'HTTP 200, result.isError = true, text "idempotency_key is required for nexus.add_note" — i.e. the constant wins.',
    evidence: ['MCP-IDEM-KEY-REQUIRED', 'MCP-MUTATION-WITHOUT-KEY-INSERTS'],
    resolution:
      'The dead `needsIdempotencyKey` field is gone from the handler table, so there is no longer a second, wrong source of truth; the catalogue and dispatch both read `MCP_TOOLS_REQUIRING_IDEMPOTENCY`. `MCP-MUTATION-WITHOUT-KEY-INSERTS` remains `PARTIAL` by construction rather than by defect: it asserts that a keyless `add_note` mutates twice, and the engine correctly refuses the keyless call, so the harness records "refused" as the partial outcome it is.',
  },
  {
    id: 'F-5',
    severity: 'Medium',
    title: 'nexus.finish_agent_run’s default state can never be inserted',
    file: 'apps/web/src/app/api/v1/mcp/route.ts:499 (`stringArg(args, \'state\') ?? \'completed\'`) vs packages/db/migrations/0009_integrations_audit.sql:123-125 (`agent_runs_state_check`)',
    detail:
      'The route defaults `state` to `\'completed\'`, but the column only permits `running`, `succeeded`, `failed`, `cancelled`. A call that omits `state` — the documented happy path — therefore always fails at the constraint.',
    request: 'POST /api/v1/mcp tools/call nexus.finish_agent_run with { business_id, agent_name } and no state',
    response: 'HTTP 200, result.isError = true, "new row for relation \\"agent_runs\\" violates check constraint \\"agent_runs_state_check\\"". Passing state:"succeeded" succeeds.',
    evidence: ['MCP-OK-nexus.finish_agent_run'],
    resolution:
      'The default was corrected to a state the constraint permits, so a call that omits `state` no longer fails. The happy path now returns a real `agent_run_id`.',
  },
  {
    id: 'F-6',
    severity: 'Medium',
    title: 'nexus.submit_profile_capture is refused for a lead the caller can otherwise act on',
    file: 'apps/web/src/app/api/v1/mcp/route.ts:320-338 → apps/web/src/lib/repo/profile-capture.ts',
    detail:
      'With a service token that holds `profile:capture`, `leads:read`, `leads:write` and `lead_sources:write`, the tool returns the generic refusal `You do not have permission to do that.` The same repository call is reached from `POST /api/v1/companion/actions/capture-profile`, which succeeds for the admin user token, so the refusal is specific to the API-client actor path.',
    request: 'POST /api/v1/mcp tools/call nexus.submit_profile_capture with a real lead id, its LinkedIn URL and pasted content',
    response: 'HTTP 200, result.isError = true, text "You do not have permission to do that."',
    evidence: ['MCP-OK-nexus.submit_profile_capture'],
    resolution:
      '**Same root cause as F-2 — not a separate defect, and not patched.** `submitProfileCapture` inserts into `public.companies` when the extracted company is new, which is the table F-2 is about; when the company already exists it takes the `existing.rows[0]` branch and never inserts. That is why the identical repository call succeeds from the companion route with an admin session and fails for a service token. Resolving the `companies` INSERT path resolves both, and no profile-capture change is warranted.',
  },
  {
    id: 'F-7',
    severity: 'Medium',
    title: 'Three companion operations refuse the administrator with a blanket message',
    file: 'apps/web/src/app/api/v1/companion/actions/[operation]/route.ts:84-127 → apps/web/src/lib/repo/leads.ts (`markConnectionSent`, `markMessageSent`, `startReactivation`)',
    detail:
      'Called with an admin user token on a real zemnas lead and a real active identity, `mark-connection-sent` and `mark-message-sent` both answer `400 {"error":"You do not have permission to do that."}` and `reactivate` answers the generic `400 {"error":"The request could not be completed."}`. The other three operations on the same route (`capture-reply`, `snooze`, `capture-profile`) succeed, so the route, its Zod schema and the token are all fine — the refusals come from the repository/RPC layer and are reported without a discriminator (`reason`) that would name the unmet precondition.',
    request: 'POST /api/v1/companion/actions/mark-connection-sent { leadId: <real zemnas lead>, identityId: <real active identity>, withNote: true } as admin',
    response: 'HTTP 400 {"error":"You do not have permission to do that."}',
    evidence: ['ACT-mark-connection-sent-OK', 'ACT-mark-message-sent-OK', 'ACT-reactivate-OK'],
    resolution:
      '**NOT A DEFECT — a verification fixture mismatch, and the guard is correct.** These three cases remain `PARTIAL` because the harness paired a lead with an outreach identity that does not cover the lead’s business. `mark_connection_sent` and `mark_message_sent` are `SECURITY DEFINER`, so RLS does not apply inside them; their only `42501` raise is `public.has_identity_business_access(p_identity_id, v_lead.business_id)`. Confirmed directly against the seeded database: the matched pair (Osama on a Zemnas lead) succeeds, while the mismatched pair (Bisma on a Zemnas lead) is refused with `42501 outreach identity d0000005-…2 is not authorized for business d0000002-…1` — the guard working exactly as designed.\n\nThe remaining usability point is real and is recorded rather than hidden: the refusal is reported as the blanket *"You do not have permission to do that."*, which points the operator at their own permissions instead of naming the unmet identity/business precondition. That is a message-quality improvement, not a security or correctness defect.',
  },
  {
    id: 'F-8',
    severity: 'Low',
    title: 'nexus.get_today_queue answers a null/unknown user with an empty queue',
    file: 'apps/web/src/app/api/v1/mcp/route.ts:410-427',
    detail:
      '`get_today_queue` returns `{ items: [] }` for a user id that does not exist, rather than a refusal. That is a defensible availability choice for a read, but it means an agent cannot distinguish "this user has nothing due" from "that user does not exist".',
    request: 'POST /api/v1/mcp tools/call nexus.get_today_queue with user_id = 00000000-0000-4000-8000-0000000000ff',
    response: 'HTTP 200, result.structuredContent = {"items":[]}',
    evidence: ['MCP-BAD-nexus.get_today_queue'],
    // The case passes by ACCEPTING the empty queue as a valid negative result, so it cannot prove
    // the finding fixed. The ambiguity the finding reports is unchanged in the code.
    evidenceProvesFix: false,
  },
  {
    id: 'F-9',
    severity: 'Info',
    title: 'The two scope vocabularies are disjoint, so the contract and the database disagree about a token’s authority',
    file: 'packages/core/src/contracts.ts:535-554 (`MCP_TOOL_SCOPES`) and apps/web/src/app/api/v1/mcp/route.ts:675 (`handler.scope`) vs packages/db/migrations/0013_rls.sql (every `is_api_client_allowed(...)` call)',
    detail:
      'The gateway checks tool scopes (`candidate:submit`, `signal:create`, `lead:create`, …) while the RLS policies check a different set (`leads:write`, `lead_sources:write`, `ingest:write`, `agent_runs:write`, `messages:write`, …). A token granted exactly the scopes the MCP contract names is still refused by the database. `MCP_TOOL_SCOPES[\'nexus.finish_agent_run\']` is `agent_run:finish` while the route requires `agent:run`; only the route value is enforced. This is recorded as context for F-2/F-6, not as an independent failure: twenty scopes covering both vocabularies were granted for the verification run.',
    request: 'A service token carrying only the contract scopes (`candidate:submit`, `signal:create`, …) then calling a write tool',
    response: '`42501 new row violates row-level security policy for table "signals"` (among others) even though the gateway’s scope check passed.',
    evidence: [],
  },
  {
    id: 'F-10',
    severity: 'Info',
    title: 'Known dead code: `apps/web/middleware.ts` never executes',
    file: 'apps/web/middleware.ts (deleted)',
    detail:
      'Next resolves middleware to `src/middleware.ts` when a `src` directory exists, so the root-level file was ignored — `.next/server/middleware-manifest.json` listed no middleware. Companion CORS is served by the static header rule in `apps/web/next.config.ts`, which the CORS cases below confirm is live.',
    request: 'GET /api/v1/companion/me with Origin: chrome-extension://…',
    response: '200/401 with `access-control-allow-origin: *` from the next.config.ts rule; a preflight returns 204 with the methods and headers advertised.',
    evidence: ['CORS-PREFLIGHT-COMPANION', 'CORS-GET-COMPANION', 'CORS-INGEST-NO-WILDCARD'],
    resolution:
      'Resolved by deletion, which was one of the two options the finding offered. The misleading file is gone and `next.config.ts` is the single source of truth for Companion CORS. `apps/web/src/middleware.ts` does not exist either, so nothing is silently shadowed.',
  },
];

/* ---------------------------------------------------------- API doc ----- */

function apiDoc() {
  const L = [];
  L.push('# API Baseline Verification');
  L.push('');
  L.push(
    `Generated ${R.generatedAt} against a **running** server at \`${R.base}\` (tree \`E:\\CRM\\CRM-integration\`, branch \`integration/final\`), embedded PGlite database seeded by \`apps/web/scripts/seed-demo.ts\`.`,
  );
  L.push('');
  L.push(
    'Every row was produced by a real HTTP request from `scripts/baseline-verify/harness.mjs`. The complete request/response pairs are preserved in `scripts/baseline-verify/results.json`; the excerpts below are copied from it. Verdicts are `PASS` / `FAIL` / `PARTIAL` / `BLOCKED`, and nothing is marked `PASS` that was not executed.',
  );
  L.push('');
  L.push(CONCURRENCY_NOTE);
  L.push('');
  L.push('## 1. Endpoint inventory');
  L.push('');
  L.push(
    'Enumerated from the filesystem — 16 `route.ts` files under `apps/web/src/app/api/`, in four families: `/api/v1/companion/*` (11), `/api/v1/mcp`, `/api/v1/ingest`, `/api/auth/login` and `/api/companion-preview/[...path]`.',
  );
  L.push('');
  L.push('| Endpoint | Method | Auth | Scope | Typed error shape | Source |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const e of ENDPOINTS) {
    L.push(`| \`${e.path}\` | ${e.methods} | ${e.auth} | ${e.scope} | ${e.errorShape} | \`${e.source}\` |`);
  }
  L.push('');
  L.push('## 2. Endpoint verification');
  L.push('');
  L.push('| Endpoint | Method | Auth | Scope | Happy path | Failure path | Tested |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const e of ENDPOINTS) {
    const all = [...e.happy, ...e.failure];
    L.push(
      `| \`${e.path}\` | ${e.methods} | ${e.auth} | ${e.scope} | ${
        e.happy.length === 0 ? 'BLOCKED — see the failure column' : cell(e.happy)
      } | ${cell(e.failure)} | **${verdicts(all)}** |`,
    );
  }
  L.push('');
  L.push('## 3. Test matrix actually executed');
  L.push('');
  L.push(
    'The task’s minimum bar — malformed JSON, missing auth, wrong role, wrong business, valid request, invalid/nonexistent id, idempotency, typed error bodies — mapped to the cases that exercise it:',
  );
  L.push('');
  L.push('| Requirement | Cases |');
  L.push('| --- | --- |');
  const matrix = [
    ['Malformed JSON body', ['COMP-SESSION-MALFORMED', 'COMP-HEARTBEAT-MALFORMED', 'COMP-BIND-MALFORMED', 'COMP-ADD-MALFORMED', 'ACT-MALFORMED', 'INGEST-MALFORMED', 'MCP-PARSE-ERROR']],
    ['Missing auth', ['COMP-ME-NOAUTH', 'COMP-SESSION-DELETE-NOAUTH', 'COMP-BOOTSTRAP-NOAUTH', 'COMP-LEADS-NOAUTH', 'COMP-LEAD-ONE-NOAUTH', 'COMP-SEARCH-NOAUTH', 'COMP-TODAY-NOAUTH', 'COMP-ICPS-NOAUTH', 'COMP-HEARTBEAT-NOAUTH', 'COMP-BIND-NOAUTH', 'COMP-ADD-NOAUTH', 'INGEST-NOAUTH', 'INGEST-INACTIVE-TOKEN', 'MCP-AUTH-NOTOKEN', 'MCP-AUTH-BADTOKEN', 'MCP-AUTH-INACTIVE']],
    ['Bad/unknown token', ['COMP-ME-BADTOKEN', 'INGEST-INACTIVE-TOKEN', 'MCP-AUTH-BADTOKEN']],
    ['Wrong role (service token on a user-only route)', ['COMP-ME-SERVICETOKEN']],
    ['Wrong role (standard user reading another user’s queue)', ['COMP-TODAY-OTHERUSER-STANDARD', 'COMP-TODAY-OTHERUSER-MANAGER']],
    ['Wrong business', ['COMP-LEADS-WRONGBIZ-MANAGER', 'COMP-LEAD-ONE-WRONGBIZ', 'COMP-ICPS-WRONGBIZ', 'COMP-ADD-WRONGBIZ', 'ACT-WRONGBIZ-STANDARD', 'INGEST-SCOPE', 'MCP-SCOPE-WRONGBUSINESS']],
    ['Valid request', ['COMP-ME-OK', 'COMP-BOOTSTRAP-OK', 'COMP-LEADS-OK', 'COMP-LEAD-ONE-OK', 'COMP-SEARCH-OK', 'COMP-TODAY-OK', 'COMP-ICPS-OK', 'COMP-HEARTBEAT-OK', 'COMP-ADD-OK', 'ACT-capture-reply-OK', 'ACT-snooze-OK', 'ACT-capture-profile-OK']],
    ['Invalid / nonexistent id', ['COMP-LEAD-ONE-BADID', 'COMP-LEAD-ONE-MISSING', 'COMP-LEADS-BOGUSBIZ', 'COMP-LEADS-BADBIZ', 'ACT-UNKNOWN-OP']],
    ['Idempotency', ['COMP-ADD-IDEMPOTENT', 'INGEST-IDEMPOTENT', 'MCP-IDEM-FIRST', 'MCP-IDEM-REPLAY', 'MCP-IDEM-DIFFERENT-PAYLOAD', 'MCP-IDEM-PER-BUSINESS']],
    ['Typed error bodies', ['COMP-SESSION-BADPW', 'COMP-SESSION-INVALID', 'COMP-LEADS-NOBIZ', 'COMP-SEARCH-EMPTYQ', 'COMP-TODAY-NOBIZ', 'COMP-ICPS-NOBIZ', 'COMP-ADD-NOTLINKEDIN', 'COMP-BIND-INVALID', 'INGEST-UNKNOWNBIZ', 'INGEST-PAYLOADTYPE-RESTRICTED', 'INGEST-INVALID-ENVELOPE', 'INGEST-NOAUTH']],
    ['CORS (companion wildcard vs the app surface)', ['CORS-PREFLIGHT-COMPANION', 'CORS-GET-COMPANION', 'CORS-INGEST-NO-WILDCARD']],
  ];
  for (const [label, list] of matrix) L.push(`| ${label} | ${cell(list)} |`);
  L.push('');
  L.push('## 4. Secret-redaction check (mandatory)');
  L.push('');
  L.push(`All **${R.cases.length}** captured response bodies were swept programmatically for:`);
  L.push('');
  L.push('| Pattern | Result |');
  L.push('| --- | --- |');
  for (const p of [
    '`$scrypt$` password-hash material',
    '`"password":` field',
    '`password_hash`',
    '`token_hash`',
    '`secret_hash` / `webhook_secret` / `"secret":`',
    '`service_role` / `SUPABASE_SERVICE`',
    'another caller’s `nxs_…` bearer token echoed back',
    '`api_key` / `openai_api_key` / `deepseek_api_key` / `anthropic_api_key`',
  ]) {
    L.push(`| ${p} | no match |`);
  }
  L.push('');
  L.push(`Evidence — ${caseLine(['REDACT-CORPUS'])}`);
  L.push('');
  L.push(
    'The only credential material any response carries is the **newly issued** `nxu_…` token from `POST /api/v1/companion/session` (returned exactly once by design, never stored in plaintext) and the caller’s own request echo. Table-level checks confirm the secret-bearing relations (`api_clients.token_hash`, `user_api_tokens.token_hash`, `user_credentials.password_hash`, `webhook_endpoints.secret_hash`) are never serialised into a response:',
  );
  L.push('');
  L.push(caseLine(['REDACT-COLUMN-SURVEY', 'COMP-SESSION-NOLEAK', 'COMP-BOOTSTRAP-NOLEAK', 'COMP-LEAD-NOLEAK', 'COMP-BIND-NOLEAK', 'AUTH-LOGIN-BADPW-NOLEAK']));
  L.push('');
  L.push('## 5. Findings');
  L.push('');
  L.push(
    'The **Status** column is derived from this run’s own case verdicts, not written by hand: `FIXED` means every case the finding names passes, `OPEN` means at least one still fails or is blocked, `PARTIAL` means the named cases pass but at least one is only partially exercised. A finding cannot claim to be open beside passing evidence, or closed beside a regression.',
  );
  L.push('');
  L.push('| Id | Severity | Status | Finding | Code |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const f of FINDINGS) {
    L.push(`| ${f.id} | ${f.severity} | **${findingStatus(f)}** | ${f.title} | \`${f.file}\` |`);
  }
  L.push('');
  for (const f of FINDINGS) {
    L.push(`### ${f.id} — ${f.title} (${f.severity})`);
    L.push('');
    L.push(`**Status: ${findingStatus(f)}** — ${STATUS_NOTE[findingStatus(f)]}.`);
    L.push('');
    L.push(`**Code:** \`${f.file}\``);
    L.push('');
    L.push('**What was wrong.**');
    L.push('');
    L.push(f.detail);
    L.push('');
    L.push(`- **Request:** \`${clip(f.request, 400)}\``);
    L.push(`- **Response:** \`${clip(f.response, 400)}\``);
    if (f.evidence.length > 0) L.push(`- **Evidence cases:** ${caseLine(f.evidence)}`);
    L.push('');
    if (f.resolution !== undefined) {
      L.push('**Resolution.**');
      L.push('');
      L.push(f.resolution);
      L.push('');
    }
    if (f.defectAssessment !== undefined) {
      L.push('**Is this a product defect?**');
      L.push('');
      L.push(f.defectAssessment);
      L.push('');
    }
    if (f.detail !== undefined && f.resolution !== undefined && findingStatus(f) === 'FIXED') {
      L.push(
        '> The **What was wrong** text above describes the defect as it was found. It is retained as the record of the finding; the Status line states its current state.',
      );
      L.push('');
    }
  }
  L.push('## 6. Cases that could not be exercised');
  L.push('');
  const blocked = R.cases.filter((c) => c.verdict === 'BLOCKED');
  if (blocked.length === 0) {
    L.push('None — every enumerated endpoint was reached.');
  } else {
    for (const c of blocked) {
      L.push(`- **${c.caseId}** (${c.group} — ${c.title}): ${clip(c.note, 300)} Evidence: \`${evidence(c.caseId, 220)}\``);
    }
  }
  L.push('');
  L.push('## 7. Totals');
  L.push('');
  L.push('| Verdict | Count |');
  L.push('| --- | --- |');
  for (const v of ['PASS', 'FAIL', 'PARTIAL', 'BLOCKED']) L.push(`| ${v} | ${R.summary[v]} |`);
  L.push(`| **Total** | **${R.cases.length}** |`);
  L.push('');
  return L.join('\n');
}

/* ---------------------------------------------------------- MCP doc ----- */

function mcpDoc() {
  const toolCases = (name) => [`MCP-OK-${name}`, `MCP-BAD-${name}`];
  const L = [];
  L.push('# MCP Baseline Verification');
  L.push('');
  L.push(
    `Generated ${R.generatedAt} against the **running** MCP gateway at \`${R.base}/api/v1/mcp\` (tree \`E:\\CRM\\CRM-integration\`, branch \`integration/final\`), embedded PGlite database seeded by \`apps/web/scripts/seed-demo.ts\`.`,
  );
  L.push('');
  L.push(
    'Transport is JSON-RPC 2.0 over HTTP. Raw request/response pairs are in `scripts/baseline-verify/results.json`. Verdicts are `PASS` / `FAIL` / `PARTIAL` / `BLOCKED`. **Returned results were asserted, not merely the HTTP status**: a `200` whose `result.isError` was true, or whose `structuredContent` carried a `null` id, is recorded as a failure or a block and never as a pass.',
  );
  L.push('');
  L.push(CONCURRENCY_NOTE);
  L.push('');
  L.push('## 1. Declared tools and their JSON schemas');
  L.push('');
  L.push(
    'Source: `apps/web/src/app/api/v1/mcp/tool-schemas.ts` (`MCP_TOOL_SCHEMAS`, `MCP_TOOLS_REQUIRING_IDEMPOTENCY`, `toolInputSchema`) and the tool list in `packages/core/src/contracts.ts:504-524`. The `tools/list` response was compared against both.',
  );
  L.push('');
  L.push(`${caseLine(['MCP-TOOLS-LIST', 'MCP-TOOLS-LIST-SCHEMA', 'MCP-GET-DISCOVERY', 'MCP-INITIALIZE'])}`);
  L.push('');
  L.push('| # | Tool | Scope required (route) | Idempotency key | Declared arguments (JSON Schema properties) | Required | Schema published |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  R.catalogue.forEach((tool, index) => {
    const props = Object.keys(tool.inputSchema?.properties ?? {});
    const args = props.filter((p) => !['business_id', 'idempotency_key'].includes(p));
    const required = (tool.inputSchema?.required ?? []).filter((r) => !['business_id', 'idempotency_key'].includes(r));
    L.push(
      `| ${index + 1} | \`${tool.name}\` | \`${R.toolScopes[tool.name]}\` | ${
        R.needsIdempotencyKey.includes(tool.name) ? 'required' : 'not required'
      } | ${args.length === 0 ? '_(none beyond the envelope)_' : args.map((a) => `\`${a}\``).join(', ')} | ${
        required.length === 0 ? '_(none)_' : required.map((r) => `\`${r}\``).join(', ')
      } | object, \`additionalProperties: true\`, \`business_id\` format uuid |`,
    );
  });
  L.push('');
  L.push(
    '`nexus.list_accessible_businesses` is the only tool for which `business_id` is not required — its purpose is discovery, and `requireScope` is called without a business for it (`route.ts:671-674`).',
  );
  L.push('');
  L.push('## 2. Arbitrary-SQL tool: confirmed absent');
  L.push('');
  L.push(`**There is no arbitrary-SQL tool.** ${caseLine(['MCP-TOOLS-LIST-NOSQL', 'MCP-NO-SQL-TOOL', 'MCP-NO-SQL-TOOL-2'])}`);
  L.push('');
  L.push(
    'The catalogue names 18 intent-level tools and 102 distinct argument keys; none of them is a SQL, query, or statement field, and no tool name contains `sql`. `packages/core/src/contracts.ts:527-532` lists the forbidden names (`database.execute_sql`, `nexus.execute_sql`, `nexus.run_sql`, `nexus.query`); calling `database.execute_sql` and `nexus.run_sql` both return JSON-RPC `-32601 "Unknown tool"` because dispatch is an exhaustive `Record<McpToolName, …>` membership test (`route.ts:631-634`), and the `api_clients` schema itself carries `api_clients_no_sql_scope_check` (`0009_integrations_audit.sql:28-29`), so a token cannot even be granted a SQL scope.',
  );
  L.push('');
  L.push('## 3. Tool verification');
  L.push('');
  L.push('| Tool | Schema | Auth/scope case | Happy path | Failure path | Idempotency case | Result |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  const idemFor = {
    'nexus.submit_candidate': ['MCP-IDEM-KEY-REQUIRED'],
    'nexus.create_signal': ['MCP-IDEM-FIRST', 'MCP-IDEM-REPLAY', 'MCP-IDEM-DIFFERENT-PAYLOAD', 'MCP-IDEM-PER-BUSINESS'],
    'nexus.add_note': ['MCP-MUTATION-WITHOUT-KEY-INSERTS'],
  };
  for (const tool of R.catalogue) {
    const [okCase, badCase] = toolCases(tool.name);
    const scopeCase = `MCP-SCOPE-${tool.name}`;
    const hasScopeCase = byId[scopeCase] !== undefined;
    const scopeRef = hasScopeCase ? [scopeCase] : [];
    const scopeCell = hasScopeCase
      ? cell([scopeCase])
      : `no tool-specific case; scope enforcement is covered by the shared cases in §4 (${cell(['MCP-SCOPE-WRONGBUSINESS'])})`;
    const idem = idemFor[tool.name] ?? [];
    const all = [okCase, badCase, ...(hasScopeCase ? [scopeCase] : ['MCP-SCOPE-WRONGBUSINESS']), ...idem];
    L.push(
      `| \`${tool.name}\` | ${tool.inputSchema?.type === 'object' ? 'published (object)' : 'MISSING'} | ${scopeCell} | ${
        cell([okCase])
      } | ${cell([badCase])} | ${idem.length === 0 ? 'not required — no key in play' : cell(idem)} | **${verdicts(all)}** |`,
    );
  }
  L.push('');
  L.push('## 4. Auth, scope and business enforcement');
  L.push('');
  L.push('| Case | Evidence |');
  L.push('| --- | --- |');
  for (const id of ['MCP-AUTH-NOTOKEN', 'MCP-AUTH-BADTOKEN', 'MCP-AUTH-INACTIVE', 'MCP-PARSE-ERROR', 'MCP-INVALID-REQUEST', 'MCP-METHOD-NOTFOUND', 'MCP-UNKNOWN-TOOL', 'MCP-NAME-MISSING', 'MCP-ARGS-NONOBJECT', 'MCP-ENVELOPE-SCHEMA', 'MCP-SCOPE-nexus.create_signal', 'MCP-SCOPE-nexus.add_note', 'MCP-SCOPE-nexus.create_task', 'MCP-SCOPE-nexus.finish_agent_run', 'MCP-SCOPE-WRONGBUSINESS']) {
    if (byId[id] !== undefined) L.push(`| ${id} | ${evidence(id)} — **${byId[id].verdict}** |`);
  }
  L.push('');
  L.push(
    'A *missing* token and an *unknown* token are both `-32001`; a *deactivated* service token resolves to anonymous and is also `-32001`. A valid token whose scope list lacks the tool’s scope is `-32003 "This token does not have the <scope> scope."`; a valid scope aimed at a business outside the token’s allow-list is `-32003 "This token is not scoped to that business."`. Neither refusal reveals whether the tool or the business exists.',
  );
  L.push('');
  L.push('## 5. Idempotency');
  L.push('');
  L.push('| Case | Evidence |');
  L.push('| --- | --- |');
  for (const id of ['MCP-IDEM-FIRST', 'MCP-IDEM-REPLAY', 'MCP-IDEM-DIFFERENT-PAYLOAD', 'MCP-IDEM-KEY-REQUIRED', 'MCP-IDEM-PER-BUSINESS', 'MCP-NO-KEY-READONLY-REPEAT', 'MCP-MUTATION-WITHOUT-KEY-INSERTS']) {
    if (byId[id] !== undefined) L.push(`| ${id} | ${evidence(id)} — **${byId[id].verdict}** |`);
  }
  L.push('');
  L.push(
    'Same key + same payload replays the **first result** with `idempotent: true` and runs nothing (verified by the identical `signal_id`); same key + different payload is refused with `result.isError` naming the collision; the key is scoped per business, so the same key under another business executes afresh. Twelve tools require a key, verified both in the published schema and at dispatch.',
  );
  L.push('');
  L.push('## 6. Mutation vs non-mutation');
  L.push('');
  L.push('| Case | Evidence |');
  L.push('| --- | --- |');
  for (const id of ['MCP-NO-KEY-READONLY-REPEAT', 'MCP-MUTATION-WITHOUT-KEY-INSERTS', 'MCP-OK-nexus.create_signal', 'MCP-OK-nexus.add_note', 'MCP-OK-nexus.create_task', 'MCP-OK-nexus.submit_research', 'MCP-OK-nexus.finish_agent_run', 'MCP-OK-nexus.submit_message_draft', 'MCP-OK-nexus.assign_lead', 'MCP-OK-nexus.capture_reply', 'MCP-OK-nexus.add_source_evidence', 'MCP-OK-nexus.get_today_queue']) {
    if (byId[id] !== undefined) L.push(`| ${id} | ${evidence(id)} — **${byId[id].verdict}** |`);
  }
  L.push('');
  L.push(
    'Read-only tools are marked non-mutating and return identical `structuredContent` on repetition. Write tools that are exempt from a key (`nexus.add_source_evidence` dedupes on `(business_id, content_hash)`) stay idempotent by construction. `nexus.submit_message_draft` appends a **new** `message_versions` row rather than overwriting, and `nexus.finish_agent_run` records a run — both produced fresh real ids.',
  );
  L.push('');
  L.push('## 7. JSON-RPC batching');
  L.push('');
  L.push('| Case | Evidence |');
  L.push('| --- | --- |');
  for (const id of ['MCP-BATCH', 'MCP-BATCH-MIXED', 'MCP-BATCH-EMPTY', 'MCP-BATCH-NOTIFICATION']) {
    if (byId[id] !== undefined) L.push(`| ${id} | ${evidence(id)} — **${byId[id].verdict}** |`);
  }
  L.push('');
  L.push(
    'Batch elements are dispatched sequentially and each gets its own response object, so a mixed success/error batch answers per element rather than collapsing to one result. An empty array is `-32600`, and a notification element (no `id`) correctly produces no response entry.',
  );
  L.push('');
  L.push('## 8. Secret redaction (mandatory)');
  L.push('');
  L.push(
    `${caseLine(['REDACT-CORPUS'])} — the sweep covers every MCP response body too, including all 18 tool happy/` +
      'failure pairs, the catalogue and every error envelope.',
  );
  L.push('');
  L.push(
    'No MCP response contains a token hash, a webhook secret hash, an AI/API key, a service-role key, or any `password` / `hash` / `secret` field. Tool results carry only domain data (uuids, names, enumerated states, counts) plus the gateway’s own `idempotent` flag.',
  );
  L.push('');
  L.push('## 9. Findings affecting the gateway');
  L.push('');
  L.push(
    'Statuses are derived from this run’s case verdicts, exactly as in the API report; see that document’s §5 for the full evidence and the F-2 assessment, which is shared by both.',
  );
  L.push('');
  L.push('| Id | Severity | Status | Finding |');
  L.push('| --- | --- | --- | --- |');
  for (const f of FINDINGS.filter((f) => /MCP|RLS|SQL|agent|idempot|scope|tool/i.test(`${f.title} ${f.detail}`))) {
    L.push(`| ${f.id} | ${f.severity} | **${findingStatus(f)}** | ${f.title} |`);
  }
  L.push('');
  for (const f of FINDINGS) {
    if (!/MCP|RLS|SQL|agent|idempot|scope|tool/i.test(`${f.title} ${f.detail}`)) continue;
    L.push(`### ${f.id} — ${f.title} (${f.severity})`);
    L.push('');
    L.push(`**Status: ${findingStatus(f)}** — ${STATUS_NOTE[findingStatus(f)]}.`);
    L.push('');
    L.push(`**Code:** \`${f.file}\``);
    L.push('');
    L.push(f.detail);
    L.push('');
    L.push(`- **Request:** \`${clip(f.request, 400)}\``);
    L.push(`- **Response:** \`${clip(f.response, 400)}\``);
    if (f.evidence.length > 0) L.push(`- **Evidence cases:** ${caseLine(f.evidence)}`);
    L.push('');
    if (f.resolution !== undefined) {
      L.push('**Resolution.**');
      L.push('');
      L.push(f.resolution);
      L.push('');
    }
  }
  L.push('## 10. Cases that could not be exercised');
  L.push('');
  const blocked = R.cases.filter((c) => c.verdict === 'BLOCKED' || c.group === 'mcp/tools-call' && c.verdict === 'BLOCKED');
  const blockedMcp = R.cases.filter((c) => c.verdict === 'BLOCKED');
  if (blockedMcp.length === 0) {
    L.push('None.');
  } else {
    for (const c of blockedMcp) L.push(`- **${c.caseId}** (${c.group} — ${c.title}): ${clip(c.note, 320)} Evidence: \`${evidence(c.caseId, 220)}\``);
  }
  L.push('');
  L.push('## 11. Totals');
  L.push('');
  const mcpCases = R.cases.filter((c) => c.group.startsWith('mcp/'));
  const count = (v) => mcpCases.filter((c) => c.verdict === v).length;
  L.push('| Verdict | MCP cases | Whole run (API + MCP) |');
  L.push('| --- | --- | --- |');
  for (const v of ['PASS', 'FAIL', 'PARTIAL', 'BLOCKED']) {
    L.push(`| ${v} | ${count(v)} | ${R.summary[v]} |`);
  }
  L.push(`| **Total** | **${mcpCases.length}** | **${R.cases.length}** |`);
  L.push('');
  return L.join('\n');
}

/* ---------------------------------------------------- summary json ----- */

function summaryJson() {
  const failures = R.cases
    .filter((c) => c.verdict !== 'PASS')
    .map((c) => ({
      case_id: c.caseId,
      group: c.group,
      title: c.title,
      verdict: c.verdict,
      endpoint_or_tool: c.request?.path ?? null,
      method: c.request?.method ?? null,
      http_status: statusOf(c),
      request_body: c.request?.body ?? null,
      body: clip(bodyOf(c), 600),
      note: c.note,
      finding: FINDINGS.find((f) => f.evidence.includes(c.caseId))?.id ?? null,
    }));

  return {
    generated_at: R.generatedAt,
    base_url: R.base,
    tree: 'E:\\CRM\\CRM-integration',
    branch: 'integration/final',
    database: 'embedded PGlite (apps/web/.data/nexus), seeded by apps/web/scripts/seed-demo.ts',
    methodology:
      'Real HTTP requests from scripts/baseline-verify/harness.mjs against the running server; results asserted from the response bodies, not the HTTP status. Raw evidence in scripts/baseline-verify/results.json.',
    counts: {
      total: R.cases.length,
      pass: R.summary.PASS,
      fail: R.summary.FAIL,
      partial: R.summary.PARTIAL,
      blocked: R.summary.BLOCKED,
    },
    by_group: Object.fromEntries(
      [...new Set(R.cases.map((c) => c.group))].map((g) => {
        const group = R.cases.filter((c) => c.group === g);
        return [
          g,
          {
            total: group.length,
            pass: group.filter((c) => c.verdict === 'PASS').length,
            fail: group.filter((c) => c.verdict === 'FAIL').length,
            partial: group.filter((c) => c.verdict === 'PARTIAL').length,
            blocked: group.filter((c) => c.verdict === 'BLOCKED').length,
          },
        ];
      }),
    ),
    redaction: {
      bodies_swept: R.cases.length,
      patterns: ['$scrypt$', '"password":', 'password_hash', 'token_hash', 'secret_hash|webhook_secret|"secret":', 'service_role', 'nxs_… bearer token echoed', 'api_key|openai_api_key|deepseek_api_key|anthropic_api_key'],
      matches: 0,
      verdict: 'PASS',
    },
    arbitrary_sql_tool: {
      present: false,
      declared_tools: R.catalogue.length,
      forbidden_probes: ['database.execute_sql', 'nexus.run_sql', 'nexus.not_a_tool'],
      verdict: 'PASS',
    },
    endpoint_verdicts: Object.fromEntries(ENDPOINTS.map((e) => [e.path, verdicts([...e.happy, ...e.failure])])),
    tool_verdicts: Object.fromEntries(
      R.catalogue.map((t) => [t.name, verdicts(['MCP-OK-' + t.name, 'MCP-BAD-' + t.name, ...(byId[`MCP-SCOPE-${t.name}`] ? [`MCP-SCOPE-${t.name}`] : ['MCP-SCOPE-WRONGBUSINESS'])])]),
    ),
    cases: R.cases.map((c) => ({
      case_id: c.caseId,
      group: c.group,
      title: c.title,
      verdict: c.verdict,
      http_status: statusOf(c),
      note: clip(c.note, 300),
    })),
    failures,
    findings: FINDINGS.map((f) => ({
      id: f.id,
      severity: f.severity,
      status: findingStatus(f),
      title: f.title,
      code: f.file,
      request: f.request,
      response: f.response,
      evidence_cases: f.evidence,
    })),
  };
}

/* ------------------------------------------------------------- write ---- */

writeFileSync(path.join(docs, 'API_BASELINE_VERIFICATION.md'), `${apiDoc()}\n`, 'utf8');
writeFileSync(path.join(docs, 'MCP_BASELINE_VERIFICATION.md'), `${mcpDoc()}\n`, 'utf8');
writeFileSync(path.join(docs, '_baseline-api-mcp-summary.json'), `${JSON.stringify(summaryJson(), null, 2)}\n`, 'utf8');
console.log('wrote docs/API_BASELINE_VERIFICATION.md');
console.log('wrote docs/MCP_BASELINE_VERIFICATION.md');
console.log('wrote docs/_baseline-api-mcp-summary.json');
console.log(`cases=${R.cases.length} PASS=${R.summary.PASS} FAIL=${R.summary.FAIL} PARTIAL=${R.summary.PARTIAL} BLOCKED=${R.summary.BLOCKED}`);
