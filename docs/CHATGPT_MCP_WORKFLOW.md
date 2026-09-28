# NEXUS V1.2 — ChatGPT MCP Workflow

**Audience:** ChatGPT (and the person connecting it), acting as a planning, reading and drafting client
against Nexus.
**Transport:** MCP over HTTP — `POST /api/v1/mcp`, JSON-RPC 2.0, `Authorization: Bearer <token>`.
**Normative:** `product/NEXUS_V1_2_MASTER_SPEC.md` — the flows below are its §55 flows A–I, and the tool
list is its §43.1.

ChatGPT's role in V1.2 is to **read structured intelligence and ask for work**, not to hold data or to
decide facts. It has no database, no SQL and no credential; it has a catalogue of typed verbs, each of
which is scoped, validated, idempotent and audited.

---

## 1. What ChatGPT can and cannot do

### 1.1 The catalogue it may use

| Group | Tools |
| --- | --- |
| Discovery | `nexus.list_accessible_businesses`, `nexus.get_business_context` |
| Search | `nexus.search_person`, `nexus.search_company`, `nexus.check_duplicate` |
| Lead intelligence | `nexus.get_lead_enrichment_context`, `nexus.get_today_queue` |
| Lead creation | `nexus.submit_minimal_lead`, `nexus.submit_candidate`, `nexus.create_or_update_lead` |
| Enrichment input | `nexus.submit_profile_data`, `nexus.submit_company_research`, `nexus.submit_source_metadata`, `nexus.submit_profile_capture`, `nexus.add_source_evidence` |
| Signals | `nexus.create_signal` |
| Work | `nexus.create_agent_job`, `nexus.list_agent_jobs`, `nexus.get_agent_job` |
| Assignment | `nexus.assign_lead` |
| Conversation | `nexus.add_note`, `nexus.create_task`, `nexus.submit_research` |
| Outreach | `nexus.submit_message_draft`, `nexus.capture_reply` |
| Housekeeping | `nexus.finish_agent_run` |

### 1.2 What ChatGPT cannot do

| # | Prohibited | Why |
| --- | --- | --- |
| 1 | **Run SQL.** There is no SQL tool. `database.execute_sql`, `nexus.execute_sql`, `nexus.run_sql` and `nexus.query` all return `-32601 "Unknown tool"`, and no `api_clients` scope can grant one. | `mcp_contract.forbidden_tool`; a database that accepts SQL text from a model is a database with no authorization model |
| 2 | **Hold or use a database credential.** No connection string, no service-role key, no Supabase key, no password. | the token is scoped to tools and businesses; a credential bypasses both |
| 3 | **Set a canonical field directly.** Every write is a typed verb that validates arguments, checks scope and records provenance. | an unvalidated write cannot be attributed, and an unattributed fact cannot be reviewed |
| 4 | **Claim, heartbeat, submit or complete an agent job.** `nexus.claim_agent_job`, `nexus.heartbeat_agent_job`, `nexus.release_agent_job`, `nexus.submit_agent_job_result` and `nexus.fail_agent_job` are OpenCode's verbs. | ChatGPT is a planner; claiming work it cannot do would park it |
| 5 | **Change a lead's sales state, mark a message sent, or confirm a fact (`confirmed_by_user`).** | human actions; the enrichment and sales axes are separate (spec §12) |
| 6 | **Read a raw body.** There is none to read: a staged body is deleted after the commit it produced, and no read tool returns one. | the raw-data policy (spec §32) |
| 7 | **See another tenant's data.** Every call is business-scoped and the scope check runs before the read. | RLS plus the token's `business_ids` allow-list |
| 8 | **Invent a score, a metric or a confidence.** Completeness, ICP fit and confidence are computed by Nexus. | a model-authored number is unauditable |

### 1.3 The envelope on every call

| Key | Required | Notes |
| --- | --- | --- |
| `business_id` | yes, for every tool except `nexus.list_accessible_businesses` | uuid; must be inside the token's allow-list, or the call is refused `-32003` |
| `idempotency_key` | yes, for every mutating tool | ≥ 8 characters; the same key + the same payload replays the first result with `idempotent: true`; the same key + different arguments is refused |
| `source_client` | optional | a label for the audit row (e.g. `chatgpt`) |
| `agent_run_id` | optional | links a run of related calls to an `agent_runs` row |

`tools/list` is authoritative for arguments. A call generated from the published schema is the only kind
guaranteed to succeed; a call written from memory is not.

---

## 2. The core flows

### Flow A — Search for leads and read structured context

1. `nexus.list_accessible_businesses` → the businesses the token may act on.
2. `nexus.search_person` (`query`, `limit` ≤ 50) or `nexus.search_company`.
3. `nexus.check_duplicate` before proposing a new person or company.
4. `nexus.get_lead_enrichment_context` (`lead_id`) → the **structured** context: person and company facts,
   contact points with their confirmation state, signals, ICP fit and intent, the current Context Pack
   version and its summary, the completeness score and `missing_fields`.
5. A `null`/empty result is an answer: the lead exists but nothing is known yet. Report the missing fields;
   never fill them in from imagination.

```jsonc
{ "jsonrpc": "2.0", "id": 4, "method": "tools/call",
  "params": { "name": "nexus.get_lead_enrichment_context",
              "arguments": { "business_id": "d0000002-…-0001", "lead_id": "a22…" } } }
```

### Flow B — Create a minimal lead

1. `nexus.submit_minimal_lead` with at least a `full_name`, plus whatever is actually known:
   `company_name`, `company_domain`, `job_title`, `headline`, `location`, `linkedin_url`, `source`,
   `source_url`, `snippet`.
2. Supply `source` from the discovery-source vocabulary (`linkedin`, `upwork`, `reddit`, `job_board`,
   `youtube`, `instagram`, `company_website`, `google`, `web`, `apollo`, `csv`, `paste`, `mcp`,
   `companion`, `manual`, `other`). **Do not** pick a source to imply an outreach channel: the two are
   independent, and a Reddit-discovered lead can be contacted by email (spec §20).
3. Nexus resolves or creates the canonical person and company, inserts the lead, and its trigger creates
   the `lead_enrichment` row, so the lead starts at `NEEDS_PROFILE` or `MINIMAL`.
4. Do not try to make it complete. A minimal lead is a legitimate state, and a top-up is what the
   enrichment workspace is for.

### Flow C — Ask for research work

1. `nexus.create_agent_job` with a `job_type` (`RESEARCH_COMPANY`, `RESEARCH_PERSON`,
   `RESEARCH_SIGNALS`, `CAPTURE_PROFILE`, …), the entity ids, a `priority`, `instructions`, and — this is
   the part that matters — a deterministic `dedupe_key` and a plain-language `reason`.
2. A `dedupe_key` makes the request idempotent in the queue: a second identical request returns the live
   job with `created: false` instead of enqueuing a duplicate.
3. `nexus.list_agent_jobs` / `nexus.get_agent_job` to observe. **Do not claim.** A job in `OPEN` is
   waiting for a browser agent; a job in `WAITING_AI` is waiting for Nexus's extraction.
4. `nexus.submit_research` is for a *summary you were given* (a human's finding), not for a page you read;
   page evidence belongs on the agent path.

### Flow D — Add notes and tasks

1. `nexus.add_note` (`lead_id`, `body` ≤ 8 000) — an internal note. It is attributed to the caller and
   audited.
2. `nexus.create_task` (`lead_id`, `title`, `type`, `due_at`, `priority`, `note`) — real work in Nexus's
   Today queue, not a reminder inside the conversation.
3. Neither tool changes the lead's status. If a state change is intended, say so and let a human make it.

### Flow E — Submit evidence and source metadata

1. `nexus.submit_source_metadata` records **permanent metadata about something observed**: `source`,
   `source_url`, `summary`, `observed_at`, `collector_agent`, and optionally `content_hash`. It takes no
   body, deliberately.
2. `nexus.submit_profile_data` (`lead_id`, `linkedin_url`, `pasted_content` ≤ 400 000) stages a profile
   body for extraction. It is the same pipeline the web workspace and the Companion use.
3. `nexus.add_source_evidence` attaches evidence with mandatory provenance to a person, company or lead.
4. `nexus.submit_company_research` submits a company research payload against a job id.
5. In every case: the body is staged, extracted, validated, committed and then **deleted**. Do not expect
   to read it back, and do not ask for it.

### Flow F — Request or submit a draft

Nexus owns draft **generation**; ChatGPT may ask for it or propose one.

1. **Ask Nexus to draft.** `nexus.create_agent_job` with `job_type: "DRAFT_OUTREACH"` and an
   `instructions` field naming the channel; Nexus resolves the channel-specific prompt key
   (`linkedin_initial`, `linkedin_followup`, `email_initial`, `email_followup`, `instagram_dm`,
   `upwork_proposal`), builds the draft from the AI Context Pack and stores it as a new
   `message_versions` row.
2. **Propose a body.** `nexus.submit_message_draft` (`message_instance_id`, `content`, `model`) stores the
   content as a **new** version and repoints `current_version_id`; it never overwrites, and a `SENT`
   instance's versions are immutable by trigger.
3. **Read before proposing.** Call `nexus.get_lead_enrichment_context` first and build only on facts that
   are actually there. A body built on an invented fact is worse than no draft: it is a message a human
   might send.
4. **Respect the messaging rules.** A generated body that misses its personalization signal, asserts an
   unapproved numeric claim, contains a prohibited phrase, uses generic praise or a high-pressure CTA is
   discarded rather than repaired, and a numeric result may be mentioned only when an approved,
   AI-usable knowledge asset sets `may_mention_numeric_results`.
   `> OPEN:` (spec OPEN-23) the MCP submit path currently stores a submitted body **without** running that
   validation, so on this path the rule is a rule ChatGPT is trusted to keep. Do not submit a body you
   know to violate it, and do not treat a stored version as approved.
5. **Never send.** There is no send tool for ChatGPT. Sending is a human action in the Companion or the
   browser.

### Flow G — Capture a reply

1. `nexus.capture_reply` (`lead_id`, `exact_text`, `outcome`, `note`) stores the reply **verbatim**,
   records the outcome, pauses the sequence, and creates the person+channel suppression when the outcome
   is `Do not contact`.
2. The exact text is the record. Do not summarise, clean up or paraphrase it — a summary belongs in the
   `note`.
3. `outcome` must be one of the V1 reply outcomes. Nexus proposes a classification; the recorded outcome
   is the one this call carries, and a human is responsible for it.

### Flow H — Assign, hand over and observe a run

1. `nexus.assign_lead` (`lead_id`, `owner_user_id`, `primary_icp_id`) — assignment only; a primary-ICP swap
   is audited in Nexus.
2. `nexus.get_today_queue` (`user_id`) — read a person's queue. An unknown user answers with an empty
   queue (baseline finding F-8), so treat "empty" as "nothing due or unknown user" rather than as proof
   the person exists.
3. `nexus.finish_agent_run` — record the end of a multi-call working session with a `state`
   (`succeeded`/`failed`/`cancelled`/`running`), a `summary` and optional `stats`.

### Flow I — Work a whole batch

For each candidate: `nexus.check_duplicate` → `nexus.submit_minimal_lead` → `nexus.create_agent_job`
(research) → `nexus.add_note` (why this lead) → `nexus.create_task` (the next human action). Use one
`agent_run_id` for the batch so the audit trail shows it as one session, and use a distinct
`idempotency_key` per mutation derived from the batch and the row (e.g. `chatgpt-batch-42-row-7`), so a
retry after a timeout cannot double-create.

---

## 3. The nine spec flows, from this side

`product/NEXUS_V1_2_MASTER_SPEC.md` §55 defines nine end-to-end acceptance flows. What ChatGPT sees of
each:

| Flow | ChatGPT's part | What it must not assume |
| --- | --- | --- |
| **A** minimal lead → ready lead | create the lead (Flow B), optionally enqueue research (Flow C), read the context later | that `READY` is immediate: the chain is asynchronous and may take hours |
| **B** paste-only enrichment with no AI key | `nexus.submit_profile_data` still stages the body; the URL is recorded | that enrichment happened: with no provider key the extraction does not run and the body expires in 24 h |
| **C** deterministic search, no tokens | nothing — the links are built by Nexus | that a search link needs a model; it never does |
| **D** OpenCode researches a company | create the job, observe it | that ChatGPT may claim or submit for the agent |
| **E** agent crash and lease recovery | observe `OPEN` → `RUNNING` → `OPEN` again | that a `RUNNING` job with a dead agent is stuck; the lease recovers it |
| **F** repeated failure | read `last_error_code` from `nexus.get_agent_job` and report it | that a `FAILED` job is claimable; it is not |
| **G** read and draft | Flows A, F and H — search, read context, note, task, draft | that a raw body or a credential is available |
| **H** user-confirmed value vs AI extraction | observe `NEEDS_REVIEW` in the context | that an extraction may overwrite a confirmed value; it may not |
| **I** reply, classification and DNC | `nexus.capture_reply` with the verbatim text | that a `Do not contact` outcome is reversible by an agent; the suppression is across all identities |

---

## 4. The raw-deletion guarantees, stated for a client

These are properties ChatGPT can rely on, and must not attempt to work around.

1. **A submitted body is staging material.** `nexus.submit_profile_data`, `nexus.submit_company_research`
   and the agent submit path write to `raw_staging`, with a 24-hour default lifetime and a `content_hash`.
2. **The order is fixed:** receive raw → extract → validate → commit structured facts → commit provenance
   → verify the commit → delete raw → advance state / complete the job.
3. **The raw row is deleted as soon as the commit it produced is verified.** After that, no tool, on any
   path, can return it.
4. **An abandoned row is removed by the TTL sweep** after its `expires_at`; a retryable failure keeps the
   row only until then, so a retry does not require re-pasting while the row lives.
5. **What remains is metadata, and only metadata:** source type, source URL, observed timestamp, content
   hash, collector agent, agent job id, prompt version, model, extracted timestamp. That is what
   `nexus.get_lead_enrichment_context` and the Lead Detail *Source / Provenance* section show.
6. **Raw never lands in a canonical field, in an audit row, in an error message, in a job event or in the
   AI ledger.** A ledger row stores identifiers, counts, money and status only.
7. **There is no "show me what I pasted" path**, and a request for one must be answered with the metadata,
   not the body.
8. **A failing extraction does not keep the body as a record.** It records an error code; the body's
   lifetime is unchanged.

If a client believes it needs a raw body to do its job, the correct request is a **new** submission of the
body (staged, extracted, deleted again), or a read of the structured facts — not a copy retained
somewhere.

---

## 5. Rules ChatGPT must not break

1. **No SQL, no database credential, no probing for one.** A `-32601` on a SQL-shaped name is the
   designed answer.
2. **Every mutation carries an idempotency key**, unique per intended change, so a retry is safe.
3. **Every submission carries provenance** — a source, and a source URL when there is one.
4. **Do not invent facts, scores, signals or confidence.** Read them; if they are absent, say they are
   absent.
5. **Do not overwrite a user-confirmed value.** A conflict is `NEEDS_REVIEW`, and the resolution is a
   human's.
6. **Do not change a lead's sales state and do not send anything.**
7. **Do not claim, heartbeat, submit or fail an agent job.** Those verbs belong to the browser agent.
8. **Do not ask for a raw body**, and do not retain one you were given by a human; submit it and let Nexus
   stage it.
9. **Do not read across businesses.** A refusal is `-32003` and deliberately does not reveal whether the
   entity exists.
10. **Do not paraphrase a reply.** `exact_text` is verbatim.
11. **Do not present a metric that Nexus did not compute** (spec §71.1 lists the only Overview metrics).
12. **Do not treat a stored draft as approved.** A version is a proposal; the messaging rules still apply.

---

## 6. Error handling

| Signal | Meaning | What ChatGPT should do |
| --- | --- | --- |
| `-32001` | missing, invalid, inactive or expired token | stop; the connection must be repaired by a human |
| `-32003` | the token is not scoped to that business, or lacks the tool's scope | do not retry; report the missing scope or business |
| `-32601` | unknown or forbidden tool | check `tools/list`; a SQL-shaped name will always be this |
| `-32600` / `-32700` | malformed request | fix the request; do not retry unchanged |
| `result.isError: true` with an argument path | the arguments failed validation | fix the named argument |
| `result.isError: true` with an idempotency collision | the same key was used with different arguments | use a new key for a genuinely new payload |
| `result.isError: true` naming a timestamp/date problem | the argument is not in the accepted shape | use an ISO-8601 instant |

A `200` response with `result.isError: true` is a **refusal**, not a success. Reading only the HTTP status
is the classic way to report work that never happened.

---

## 7. A worked session

```jsonc
// read the business, then find the lead
→ {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nexus.list_accessible_businesses","arguments":{}}}
← {"result":{"structuredContent":{"businesses":[{"id":"d0000002-…-0001","key":"zemnas"}]}}}

→ {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"nexus.search_person","arguments":{
     "business_id":"d0000002-…-0001","query":"Sarah Miller","limit":10}}}
← {"result":{"structuredContent":{"people":[{"id":"p71…","full_name":"Sarah Miller","job_title":"Head of Production"}]}}}

// read the structured intelligence (no raw body exists to read)
→ {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"nexus.get_lead_enrichment_context","arguments":{
     "business_id":"d0000002-…-0001","lead_id":"a22…"}}}
← {"result":{"structuredContent":{"enrichment":{"status":"COMPANY_RESEARCH_PENDING","completeness_score":62,
     "missing_fields":["company_website","company_research","signals","ai_context"]},
     "person":{"full_name":"Sarah Miller","job_title":"Head of Production","location":"New York"},
     "company":{"id":"c91…","name":"Acme Media"},
     "contacts":[{"kind":"linkedin","value":"https://www.linkedin.com/in/sarahmiller","confirmed_by_user":false}],
     "signals":[],"icp_fit":null,"context_pack":null}}}

// ask for the missing research, deduplicated and with a reason
→ {"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"nexus.create_agent_job","arguments":{
     "business_id":"d0000002-…-0001","idempotency_key":"chatgpt-2026-09-28-acme-company-research",
     "job_type":"RESEARCH_COMPANY","lead_id":"a22…","company_id":"c91…","priority":"normal",
     "instructions":"Find Acme Media's own site, size, industry and any current hiring or launch activity.",
     "dedupe_key":"RESEARCH_COMPANY:c91…","reason":"Company research is missing for a lead that is otherwise profile-ready."}}}
← {"result":{"structuredContent":{"job_id":"7f1…","created":true}}}

// record why, and what happens next
→ {"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"nexus.add_note","arguments":{
     "business_id":"d0000002-…-0001","idempotency_key":"chatgpt-2026-09-28-acme-note",
     "lead_id":"a22…","body":"Found while reviewing Q4 production hires; no company research committed yet."}}}
← {"result":{"structuredContent":{"note_id":"n31…"}}}

→ {"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"nexus.create_task","arguments":{
     "business_id":"d0000002-…-0001","idempotency_key":"chatgpt-2026-09-28-acme-task",
     "lead_id":"a22…","title":"Review company research and draft outreach","type":"review",
     "priority":"normal","note":"Blocked on the RESEARCH_COMPANY job (7f1…)."}}}
← {"result":{"structuredContent":{"task_id":"t88…"}}}
```

Nothing in that session wrote a fact, claimed a job, or read a body. That is the intended shape of a
ChatGPT contribution: **it turns intent into typed work and reads structured truth back.**

---

## 8. Handover, review and escalation

1. When a session produced work, `nexus.finish_agent_run` with a `summary` so a human can review the
   session as a unit.
2. A live job that has not moved in a long time is an operator question, not a client one: report the
   `job_id`, its `status`, `attempt_count` and `last_error_code`.
3. A `NEEDS_REVIEW` lead needs a human decision; report the two conflicting values and their provenance,
   and do not resolve it.
4. A refusal that names a scope or a business is a configuration problem for whoever issued the token.
5. Never report a Nexus state that was not returned by a tool call. If the call was refused, the state is
   unknown, and saying so is the correct answer.
