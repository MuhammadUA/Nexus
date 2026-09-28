# NEXUS V1.2 — OpenCode Agent Workflow

**Audience:** the OpenCode agent (and the human configuring it).
**Transport:** MCP over HTTP — `POST /api/v1/mcp`, JSON-RPC 2.0, `Authorization: Bearer <token>`.
**Normative:** `product/NEXUS_V1_2_MASTER_SPEC.md` §35–§45 (the queue, the tools, the boundary) and
`docs/V1_2_MIGRATION_PLAN.md` §6 (the SQL that implements it).

OpenCode does the work that cannot be done from a database row: reading a live page in a real browser.
Everything else — deciding what to research, extracting facts, validating them, committing them, deciding
when a job is done — belongs to Nexus. This document is the exact loop, the exact tool names, and the
things OpenCode must never do.

---

## 1. The one-paragraph version

Authenticate with a scoped token. Ask Nexus which jobs are open. Claim one atomically, which gives you a
lease. Heartbeat while you work. Read the live page. Submit what you found as evidence. Read back
`WAITING_AI` and stop working on that job — Nexus now extracts, validates, commits and deletes the raw
body, and only then does the job become `COMPLETE`. If your lease is gone, drop the job and claim another.
If you keep failing, report the failure with a code and let Nexus decide whether it is retried.

---

## 2. Before the first call

### 2.1 What the agent must be configured with

| Setting | Where it comes from | Notes |
| --- | --- | --- |
| `base_url` | the Nexus deployment (e.g. `https://<host>`) | never a database host |
| `token` | an `api_clients` token issued by an admin in Nexus | a service token, scoped and expiring; treat it as a secret |
| `business_id` | the business the agent works for | obtained from `nexus.list_accessible_businesses` |
| `agent_name` | a stable name for this agent instance | e.g. `opencode-01`; it is what the lease records |
| `capabilities` | the list you declare | must satisfy a job's `required_capabilities` |

**There is no database credential.** No connection string, no `postgres://` URL, no service-role key, no
Supabase key. If any is present in the agent's configuration, delete it: the MCP token is the only
credential OpenCode is ever given (spec §45.2).

### 2.2 The scopes OpenCode needs

| Scope | Needed for |
| --- | --- |
| `jobs:read` | `nexus.list_agent_jobs`, `nexus.get_agent_job` |
| `jobs:claim` | `nexus.claim_agent_job`, `nexus.heartbeat_agent_job`, `nexus.release_agent_job` |
| `jobs:submit` | `nexus.submit_agent_job_result`, `nexus.submit_company_research`, `nexus.fail_agent_job` |
| `lead:read` | `nexus.get_lead_enrichment_context` (useful for choosing how deep to research) |
| `evidence:add` | `nexus.submit_source_metadata` |

Do **not** request `jobs:create`. Planning work and doing work are deliberately separable: an agent that
can enqueue can flood its own queue. Creating jobs is a human or planner action.

### 2.3 Handshake

```jsonc
// 1. initialize
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }

// 2. discover the businesses this token may act on (no business_id needed)
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "nexus.list_accessible_businesses", "arguments": {} } }

// 3. learn the exact argument schemas — do not hard-code them from this document
{ "jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {} }
```

`tools/list` is authoritative. This document is a guide; the published `inputSchema` is the contract, and
a call generated from it is the only kind guaranteed to succeed.

---

## 3. The loop, step by step

### Step 1 — List open work

```jsonc
{ "jsonrpc": "2.0", "id": 10, "method": "tools/call",
  "params": {
    "name": "nexus.list_agent_jobs",
    "arguments": {
      "business_id": "d0000002-0000-4000-8000-000000000001",
      "status": "OPEN",
      "job_type": "RESEARCH_COMPANY",
      "limit": 20
    }
  } }
```

- `status` is one of `OPEN`, `RUNNING`, `WAITING_AI`, `COMPLETE`, `FAILED`, `CANCELLED`. Ask for `OPEN`
  for new work.
- `job_type` is one of `RESEARCH_COMPANY`, `RESEARCH_PERSON`, `RESEARCH_SIGNALS`, `CAPTURE_PROFILE`,
  `ENRICH_PROFILE`, `QUALIFY_LEAD`, `BUILD_CONTEXT`, `DRAFT_OUTREACH`, `OTHER`. Omit it to see everything.
- `limit` is 1–100, `offset` 0–10 000. Page; do not assume the first page is the whole queue.
- `nexus.list_agent_jobs` is a **read**: no idempotency key, no side effect, safe to repeat.

A sensible filter for a browser agent is `job_type` in (`RESEARCH_COMPANY`, `RESEARCH_PERSON`,
`RESEARCH_SIGNALS`, `CAPTURE_PROFILE`), because those need a page. `BUILD_CONTEXT`, `QUALIFY_LEAD` and
`DRAFT_OUTREACH` are Nexus's own work even if they appear in the queue for visibility.

### Step 2 — Read one job before claiming it

```jsonc
{ "jsonrpc": "2.0", "id": 11, "method": "tools/call",
  "params": { "name": "nexus.get_agent_job",
              "arguments": { "business_id": "…", "job_id": "…" } } }
```

The response gives `job_type`, `priority`, `instructions`, `required_capabilities`, `attempt_count`,
`dedupe_key`, `reason`, the entity ids, and the event history. Read `instructions` and `reason`: they are
how a chained job explains what is missing.

The event history is short operator text. It never contains a raw body, and the agent must not try to
reconstruct one from it.

### Step 3 — Claim (this is where the lease starts)

```jsonc
{ "jsonrpc": "2.0", "id": 12, "method": "tools/call",
  "params": {
    "name": "nexus.claim_agent_job",
    "arguments": {
      "business_id": "…",
      "idempotency_key": "opencode-01-claim-2026-09-28T12-00-00Z",
      "agent": "opencode-01",
      "capabilities": ["browser.research", "linkedin.profile", "company.site"],
      "lease_seconds": 900
    }
  } }
```

- The claim is **atomic**. Nexus selects the highest-priority claimable job with
  `for update skip locked`, so two agents racing for one job is resolved by the database: one wins, the
  other skips that row and takes the next.
- A job is claimable when it is `OPEN`, **or** it is `RUNNING` with an expired lease (that is the crash
  recovery path — a dead agent does not park work forever), and `attempt_count < max_attempts`, and the
  job's `required_capabilities` are a **subset** of the capabilities you declared.
- `lease_seconds` is clamped to **30–7200**. Choose 900 for a normal page and longer (up to 7200) only for
  a genuinely long research task. A lease longer than your real work costs nothing; a lease shorter than
  your work loses the job.
- **No rows back means there is nothing to do.** That is not an error: back off (exponential with jitter,
  e.g. 30 s → 60 s → 120 s, capped at 5 minutes) and list again. Do not spin.
- Optionally pass `job_id` to claim a **specific** job you saw in the list. Prefer the un-targeted claim:
  it is what keeps the queue moving when several agents run.

### Step 4 — Heartbeat while you work

```jsonc
{ "jsonrpc": "2.0", "id": 13, "method": "tools/call",
  "params": {
    "name": "nexus.heartbeat_agent_job",
    "arguments": { "business_id": "…", "idempotency_key": "…", "job_id": "…",
                   "agent": "opencode-01", "lease_seconds": 900 }
  } }
```

- Heartbeat at most every `lease_seconds / 3` (300 s for a 900-second lease) and **before** any step that
  could exceed the remaining lease — a slow page load, a login wall, a paginated crawl.
- The response carries `status`, `lease_expires_at` and `attempt_count`. Use it: if `status` is no longer
  `RUNNING`, stop working on this job immediately.
- A heartbeat refusal with **`55006`** ("agent job is not held by this agent") means your lease was reaped
  or another agent holds the job. **Stop, discard your partial findings, and go back to step 1.** Do not
  submit: a submit from a reaped agent is refused, and retrying it wastes the attempt budget.
- A heartbeat refusal with **`P0002`** ("unknown agent job") means the job or the entity was deleted.
  Discard and continue.

### Step 5 — Research

Do the actual work the job names, using a real browser session:

| `job_type` | What to collect |
| --- | --- |
| `RESEARCH_COMPANY` | the company's own site (about/product/careers pages), its size, industry, locations, and any hiring or expansion evidence |
| `RESEARCH_PERSON` | public professional information about the person: role, remit, tenure, public activity |
| `RESEARCH_SIGNALS` | recent events that are a reason to make contact now: hiring, launches, funding, a podcast or video appearance |
| `CAPTURE_PROFILE` | the text of a specific profile page the job names |

Rules for the research step:

1. **Read the page; do not ask a model what it says.** The text you submit is the evidence; Nexus's
   extraction step turns it into facts.
2. **Prefer the page's own text.** Strip navigation, cookie banners and repeated boilerplate; do not send
   raw HTML when you can send the visible text.
3. **Record where it came from.** `source_url` is the exact URL you read, and `source_type` is one of the
   discovery-source vocabulary (`linkedin`, `upwork`, `reddit`, `job_board`, `youtube`, `instagram`,
   `company_website`, `google`, `web`, `apollo`, `csv`, `paste`, `mcp`, `companion`, `manual`, `other`).
4. **One job, one answer.** Do not append a second company's page to a company research payload. If you
   found something that answers a *different* job, either report it through `nexus.submit_source_metadata`
   (metadata only) or let Nexus enqueue the right job.
5. **Stay inside the payload ceiling.** `nexus.submit_agent_job_result.payload` is capped at 200 000
   characters and the staging table at 400 000. If a page is longer, submit the part that answers the job.
6. **Never put a credential in a payload.** No cookies, no session tokens, no screenshots of a logged-in
   page containing personal data.

### Step 6 — Submit the evidence

```jsonc
{ "jsonrpc": "2.0", "id": 14, "method": "tools/call",
  "params": {
    "name": "nexus.submit_agent_job_result",
    "arguments": {
      "business_id": "…",
      "idempotency_key": "opencode-01-result-<job_id>-1",
      "job_id": "…",
      "agent": "opencode-01",
      "payload": "…the page text…",
      "kind": "company_research",
      "source_type": "company_website",
      "source_url": "https://acme.example/about"
    }
  } }
```

- `kind` is one of `company_research`, `signal_research`, `source_metadata`, `profile_paste`. Choose the
  one the job asked for; the AI processor dispatches on it.
- The tool has no `content_hash` argument on purpose: the gateway derives the hash from what it actually
  stored, so a stored hash always describes the stored bytes.
- `nexus.submit_company_research` is the same operation with the company-research defaults filled in
  (`job_id`, `agent`, `payload`, `source_type`, `source_url`). Use whichever the published schema for
  your task names; both land in the same pipeline.
- **Always send a stable `idempotency_key`.** A retried submit with the same key replays the first result
  instead of staging a second copy of the same bytes. Reusing a key with *different* arguments is
  refused — that refusal is Nexus telling you that you changed the payload under a key you had already
  used.
- The response is `{ job_id, status: "WAITING_AI", raw_staging_id }`.

### Step 7 — Read back `WAITING_AI` and stop

`WAITING_AI` means: **your part is done; the job now belongs to Nexus.** The payload is staged, not
committed. Nexus will:

1. claim the job for the AI processor (`nexus_claim_ai_work`, lease-guarded so two processors never
   extract the same evidence);
2. run the task (`COMPANY_EXTRACTION`, `SIGNAL_EXTRACTION`, `PROFILE_EXTRACTION`) through DeepSeek;
3. validate the answer against a strict schema, dropping ungrounded facts;
4. commit the structured facts and their provenance in one transaction;
5. verify the commit;
6. **delete the staged raw body** and mark `raw_deleted_at` on the evidence;
7. only then call `nexus_complete_agent_job`, which the database refuses while any un-consumed staging row
   for the job remains.

So the job sits in `WAITING_AI` for as long as Nexus needs, and it can move to `FAILED` if the extraction
fails terminally. OpenCode's correct behaviour after a submit is:

- **do not** poll in a tight loop. If you want to observe, poll `nexus.get_agent_job` with backoff (30 s,
  60 s, 120 s, … capped) and stop after a few attempts;
- **do not** resubmit to "push it along". A resubmit is refused because the job is no longer `RUNNING`,
  and a second staging row would only make the completion guard stricter;
- go straight back to step 1 and take the next job. The queue is the agent's only concern.

### Step 8 — Repeat until the queue is empty

Loop steps 1–7. When `nexus.list_agent_jobs` returns nothing, back off and try again on a schedule. A
durable queue is designed to be empty sometimes: the work is created by humans and by chaining rules, not
by the agent's arrival.

---

## 4. Failure, release and abandonment

### 4.1 Report a classified failure

```jsonc
{ "jsonrpc": "2.0", "id": 20, "method": "tools/call",
  "params": {
    "name": "nexus.fail_agent_job",
    "arguments": {
      "business_id": "…",
      "idempotency_key": "opencode-01-fail-<job_id>-1",
      "job_id": "…",
      "agent": "opencode-01",
      "error_code": "page_unreachable",
      "message": "The profile page returned 404 twice.",
      "retryable": true
    }
  } }
```

- `error_code` is a **stable machine string** you choose from your own vocabulary (`page_unreachable`,
  `login_required`, `captcha`, `no_matching_page`, `page_empty`, `navigation_timeout`,
  `unsupported_page`, `policy_refused`, …). Keep it short and stable; the operator filters on it.
- `message` is ≤ 500 characters of **operator-facing** text. It must not quote the payload. This is the
  rule that keeps the raw-deletion policy true (spec §32.2.1).
- `retryable = true` returns the job to `OPEN` while attempts remain; `retryable = false` moves it
  straight to `FAILED`. A non-retryable failure is terminal on purpose: retrying a login wall forever is
  worse than showing an operator a failed job.
- Nexus decides the outcome. You may propose; you may not set the status.

| Situation | `error_code` | `retryable` |
| --- | --- | --- |
| page did not load | `navigation_timeout`, `page_unreachable` | yes |
| the page exists but requires a login you do not have | `login_required` | **no** for this run — a human must fix the session |
| an interactive challenge blocked you | `captcha` | yes, with a long backoff (a challenge is often transient) |
| the entity is not on the site you searched | `no_matching_page` | yes |
| the page loaded but has no usable text | `page_empty` | no |
| the job asks for something your capabilities do not cover | `unsupported_page` | **no** — release instead if you claimed it by mistake |

### 4.2 Release a job you cannot finish

```jsonc
{ "jsonrpc": "2.0", "id": 21, "method": "tools/call",
  "params": { "name": "nexus.release_agent_job",
              "arguments": { "business_id": "…", "idempotency_key": "…", "job_id": "…",
                             "agent": "opencode-01", "reason": "Claimed by mistake: no browser session" } } }
```

Release returns the job to `OPEN` **without** failing it. Use it when the job is valid but you are the
wrong agent, or when you must shut down cleanly mid-claim. The attempt that the claim consumed is **not**
refunded, so release is not a way to reset a job you keep failing — use `nexus.fail_agent_job` for that.

### 4.3 Repeated failure

- Each claim increments `attempt_count`. `max_attempts` defaults to 3 (max 20).
- After `attempt_count >= max_attempts`, a retryable failure becomes `FAILED` with
  `last_error_code = 'lease_expired_no_attempts'` when the failure was a lease expiry, or with your
  reported code when you reported it.
- A `FAILED` job is **not claimable**. Do not keep listing it. Recovery is an operator action (retry from
  the Agent Jobs screen, which resets `attempt_count`) — not an agent loop.
- If three different jobs of the same `job_type` fail with the same code, treat it as an environment
  problem (a session, a network path, a blocked domain) and report it to the operator rather than grinding
  through the queue.

### 4.4 Losing a lease (crash, hang, sleep)

If the process dies, the lease simply expires. Nexus reaps it
(`nexus_reap_expired_job_leases`): the job returns to `OPEN` with a `lease_expired` event, or to `FAILED`
if attempts are exhausted. Nothing is lost, and a second agent can claim it. That is exactly why the
lease exists, and it is why OpenCode must not try to "hold" a job while it is not actually working on it.

---

## 5. A worked sequence

The following is one company research job, end to end. Elisions are marked `…`.

```jsonc
// 1. discover business
→ {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nexus.list_accessible_businesses","arguments":{}}}
← {"result":{"structuredContent":{"businesses":[{"id":"d0000002-…-0001","key":"zemnas","name":"Zemnas Creative Studio"}]}}}

// 2. list open jobs
→ {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"nexus.list_agent_jobs","arguments":{
     "business_id":"d0000002-…-0001","status":"OPEN","limit":10}}}
← {"result":{"structuredContent":{"jobs":[{"id":"7f1…","job_type":"RESEARCH_COMPANY","priority":"high",
     "company_id":"c91…","dedupe_key":"RESEARCH_COMPANY:c91…","reason":"Company research is missing for a
     lead that is otherwise profile-ready.","required_capabilities":["browser.research","company.site"],
     "attempt_count":0,"created_at":"2026-09-28T11:58:02Z"}]}}}

// 3. read it
→ {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"nexus.get_agent_job","arguments":{
     "business_id":"d0000002-…-0001","job_id":"7f1…"}}}
← {"result":{"structuredContent":{"job":{"id":"7f1…","status":"OPEN","instructions":"Find the company's
     own site, size, industry and any current hiring or launch activity.","lead_id":"a22…"},
     "events":[{"event_type":"created","note":"Job created","created_at":"2026-09-28T11:58:02Z"}]}}}

// 4. claim
→ {"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"nexus.claim_agent_job","arguments":{
     "business_id":"d0000002-…-0001","idempotency_key":"oc01-claim-7f1-1","agent":"opencode-01",
     "capabilities":["browser.research","company.site","web.fetch"],"lease_seconds":900}}}
← {"result":{"structuredContent":{"id":"7f1…","job_type":"RESEARCH_COMPANY","status":"RUNNING",
     "attempt_count":1,"lease_expires_at":"2026-09-28T12:15:00Z"}}}

// 5. heartbeat at ~12:05
→ {"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"nexus.heartbeat_agent_job","arguments":{
     "business_id":"d0000002-…-0001","idempotency_key":"oc01-hb-7f1-1","job_id":"7f1…","agent":"opencode-01",
     "lease_seconds":900}}}
← {"result":{"structuredContent":{"id":"7f1…","status":"RUNNING","lease_expires_at":"2026-09-28T12:20:00Z",
     "attempt_count":1}}}

// 6. submit the evidence
→ {"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"nexus.submit_agent_job_result","arguments":{
     "business_id":"d0000002-…-0001","idempotency_key":"oc01-result-7f1-1","job_id":"7f1…","agent":"opencode-01",
     "payload":"Acme Media — about page … (visible text) …","kind":"company_research",
     "source_type":"company_website","source_url":"https://acme.example/about"}}}
← {"result":{"structuredContent":{"job_id":"7f1…","status":"WAITING_AI","raw_staging_id":"b31…"}}}

// 7. later, observe (optional, backed off)
→ {"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"nexus.get_agent_job","arguments":{
     "business_id":"d0000002-…-0001","job_id":"7f1…"}}}
← {"result":{"structuredContent":{"job":{"id":"7f1…","status":"COMPLETE","completed_at":"2026-09-28T12:07:41Z",
     "result_ai_run_id":"d4c…"},
     "events":[{"event_type":"created"},{"event_type":"claimed"},{"event_type":"heartbeat"},
               {"event_type":"result_submitted"},{"event_type":"ai_started"},
               {"event_type":"completed","note":"Structured commit verified and raw evidence deleted"}]}}}
```

Note what the agent never saw: the extracted facts as a payload, the raw body after deletion, the
`ai_runs` contents, or a path to `COMPLETE` it could call itself.

---

## 6. What OpenCode must never do

| # | Never | Why, and what happens if you try |
| --- | --- | --- |
| 1 | **Call an arbitrary SQL tool** | there is none. `database.execute_sql`, `nexus.execute_sql`, `nexus.run_sql` and `nexus.query` return JSON-RPC `-32601 "Unknown tool"` because dispatch is a membership test. There is no tool name or argument that accepts SQL, and no `api_clients` scope can grant one. |
| 2 | **Hold or use a database credential** | none is issued. If you find one in a configuration file, remove it and report it. |
| 3 | **Mark a job complete** | there is no `nexus.complete_agent_job` tool, and the status is not settable by an agent. `COMPLETE` is written only by `nexus_complete_agent_job`, called by Nexus's AI processor, and only when no un-consumed staging row remains for the job. |
| 4 | **Write a database field directly** | all writes go through typed tools; `agent_jobs` and `agent_job_events` have `select`-only RLS for tenant roles, so a direct `update` cannot reach `COMPLETE` even if a credential existed. |
| 5 | **Put a raw payload in a log, a failure message or an event note** | the raw body is staged for one extraction and deleted. Log it and it outlives the deletion policy. `message` is ≤ 500 characters of operator text, and `error_code` is a code. |
| 6 | **Resubmit to advance a `WAITING_AI` job** | a submit is refused unless the job is `RUNNING` and held by you. Re-staging the same bytes would also make the completion guard stricter, not looser. |
| 7 | **Keep working after a `55006` heartbeat refusal** | your lease is gone; the findings you have are for a job another agent owns. Discard and re-list. |
| 8 | **Set `confirmed_by_user`, change a lead's sales state, or send a message** | those are human actions. An agent contributes evidence; a person decides. |
| 9 | **Claim a job whose `required_capabilities` you did not declare** | Nexus enforces the subset check, so you cannot be handed one — but do not declare a capability you do not have in order to be handed more work. |
| 10 | **Poll in a tight loop** | an empty list is a normal state. Back off with jitter; the queue is durable and will still be there. |
| 11 | **Read another tenant's data** | every tool is business-scoped and the scope check runs before the read; a refusal is `-32003` and does not reveal whether the entity exists. |
| 12 | **Ask a model what a page says and submit that as evidence** | you are the collector, not the extractor. Submit what the page says; Nexus does the extraction, the grounding check and the commit. |

---

## 7. Error and status reference

### 7.1 JSON-RPC level

| Code | Meaning | Agent action |
| --- | --- | --- |
| `-32700` | parse error | a bug in your request builder; fix it, do not retry |
| `-32600` | invalid request (bad envelope, empty batch) | fix the request |
| `-32601` | unknown or forbidden tool | check `tools/list`; never probe for a SQL tool |
| `-32001` | missing or invalid token (also an inactive or expired token) | refresh the token; stop if it cannot be refreshed |
| `-32003` | the token is not scoped to that business or lacks the scope | do not retry; request the scope or the business |
| `result.isError: true` | the call was well formed and was refused or failed; the text names the offending argument by path | branch on the text; fix the argument or give up on that job |

### 7.2 Database-level refusals surfaced through a tool

| Signal | Meaning | Agent action |
| --- | --- | --- |
| `55006` on heartbeat / submit / fail | the job is not `RUNNING`, or is held by another agent | stop, discard, re-list |
| `P0002` | unknown job (or the entity was deleted) | discard, re-list |
| `42501` | the caller may not touch that business (raw staging, job scope) | do not retry; a configuration problem |
| `22023` | an argument was rejected (empty payload, over the ceiling) | fix the payload; never truncate silently |
| idempotency-key collision | the same key was used with different arguments | use a new key for a genuinely new payload |

### 7.3 Job status reference

| Status | Who sets it | What it means for the agent |
| --- | --- | --- |
| `OPEN` | creation, release, failure with retries, reaping | claimable |
| `RUNNING` | `nexus_claim_agent_job` | held by an agent until its lease expires |
| `WAITING_AI` | `nexus.submit_agent_job_result` | the agent's part is finished; Nexus extracts |
| `COMPLETE` | `nexus_complete_agent_job` only, after the verified commit and raw deletion | done; never touch |
| `FAILED` | exhausted attempts, non-retryable failure, or an expired lease with no attempts left | not claimable; an operator decides |
| `CANCELLED` | an operator or a rule | not claimable |

---

## 8. Operational checklist

### 8.1 Per run

- [ ] Token valid, business discovered, `tools/list` read for the current schemas.
- [ ] Jobs listed with a bounded `limit`; an empty result backs off instead of spinning.
- [ ] Claim used with a real capability list and a lease matched to the work.
- [ ] Heartbeat at ≤ `lease/3` and before any slow step.
- [ ] Every submit carries a stable, unique `idempotency_key`.
- [ ] Every failure carries a stable, short `error_code` and a ≤ 500-character operator message.
- [ ] No payload, page text, cookie or token appears in any log line.

### 8.2 Per agent deployment

- [ ] The token is short-lived, scoped to the minimum (`jobs:read`, `jobs:claim`, `jobs:submit`,
      optionally `lead:read`, `evidence:add`) and stored as a secret, not in a config file in the repo.
- [ ] No database credential exists anywhere in the agent's configuration.
- [ ] The `agent_name` is stable and identifies the machine, so a lease can be attributed.
- [ ] The agent can be stopped without leaving a job stuck: stopping is safe, because the lease expires
      and Nexus reaps it.
- [ ] The agent's logs are excluded from any raw payload by construction, not by discipline.

---

## 9. Why the split is where it is

OpenCode has the browser and the live page; Nexus has the schema, the transaction, the validation, the
provenance and the ledger. Putting the extraction on the agent's side would mean an unvalidated,
unattributed fact could reach a canonical field; putting the browsing on Nexus's side would mean a
request-scoped HTTP call standing in for work that needs a real session. The lease-and-submit boundary is
the smallest interface that keeps both properties: **the agent produces evidence, Nexus produces facts,
and only a verified commit closes a job.**
