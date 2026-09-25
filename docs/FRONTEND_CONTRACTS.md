# Frontend-facing backend contracts

This document exists because the backend's behaviour was only discoverable by reading it. Every
screen in `apps/web` depends on contracts that are not visible in a component: which of them may run
at all, what shape a read returns, when a mutation is refused, and which of the spec's claims are
actually implemented. Getting one of these wrong produces a screen that looks right and is wrong, so
they are written down here with the file that owns each one.

Scope note: this describes the **server** side. It says nothing about layout, styling or component
structure, and it is not a design document.

---

## 1. Authorization

### 1.1 Three layers, and which one decides what

| Layer | Owner | Decides |
| --- | --- | --- |
| Route guard | `apps/web/src/lib/route-guard.ts` | whether a **screen** may render at all |
| Action guard | same file, `authorizeAction` | whether a **posted action** may run |
| RLS | `packages/db/migrations/0013_rls.sql` | whether a **row** may be read or written |

RLS is the real security boundary. The two guards above it are there so a refusal happens before a
read and with a message the operator can act on; a bug in a guard is a disclosure, not a breach.

**A hidden control is not authorization.** A `Server Action` is a public HTTP endpoint once its
module has been rendered anywhere. Gating the page does nothing for its action, which is why every
action now repeats its page's requirement.

### 1.2 Route requirements

`ROUTE_PERMISSIONS` in `packages/core/src/permissions.ts` maps a route pattern to the permission it
needs and whether it is business-scoped. It is the single source of truth: the guard, the sidebar and
the tests all read it.

Server-side usage, in a page:

```ts
// apps/web/src/app/(app)/settings/page.tsx
const context = await loadViewerContext();
requireRouteAccess(context, { route: '/settings' });   // calls notFound() when denied
```

In an action:

```ts
const refusal = await authorizeAction(null, { route: '/team' });
if (refusal !== null) return refusal;   // { ok: false, error: 'You do not have permission to do that.' }
```

**A business-scoped route must be passed its business id.** Without it the decision is made against
the union of the operator's permissions across every business, which is exactly the wrong basis:

```ts
requireRouteAccess(context, { route: '/b/:businessSlug/setup/icps', businessId: business.id });
```

Client-side usage, for hiding a control, is `canAccessRoute(context, …)` — same decision, no 404.
`routeAccessDecision(context, …)` returns the reason as well, for a diagnostic.

### 1.3 Behaviours to rely on

- **A denied route is `notFound()` (404), not 403.** Revealing "this exists but you may not see it"
  is itself a disclosure, and it matches how a hidden business already behaves.
- **A route with no entry in the matrix is denied** (`route_not_declared`). A screen that forgets to
  declare its requirement is unreachable rather than open.
- **`ADMIN_ONLY_PERMISSIONS` cannot be granted to a non-admin.** `business.create`, `settings.manage`,
  `audit.view`, `domain.manage`, `integration.manage`, `user.manage` and `lead.permanent_delete` are
  re-derived from the actor's role inside the decision, so a hand-edited grant or a caller supplying
  its own permission list cannot widen it.
- **`ViewerContext.permissions` is a union across every business on purpose** — it is correct for
  sidebar visibility and is never the basis for a business-scoped decision.

### 1.4 Reasons returned

`routeAccessDecision` reports one of: `granted`, `no_permission_required`, `permission_denied`,
`business_scope_required` (a business-scoped route with no `businessId` supplied),
`no_grant_for_business` (the operator has no access to that business at all), `route_not_declared`.

---

## 2. Server Actions

### 2.1 Result shape

Actions in the lead, team, settings, integration, business and domain areas return:

```ts
interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;   // operator-safe sentence, never SQL
  readonly message?: string;                   // success text, safe to display
}
```

They are shaped for `useActionState`. `error` is always a sentence written for the operator: raw SQL
never reaches the UI, and a constraint `hint` is surfaced only where the migration authors wrote one
deliberately (for example `permanentDeleteLead`'s confirmation phrase).

**Lifecycle actions extend this with a stable `errorCode`.** Where a refusal is really a different
screen state — "this has history, archive it instead" — the action returns a machine-readable code
alongside the sentence, and the UI branches on the code. Matching on `error` text would break the moment
a sentence is reworded. The lifecycle result shapes are in §6.2 (identities) and §6.3 (businesses).

### 2.2 The AI drafting action

`draftMessageAction` (in `apps/web/src/app/b/[slug]/leads/[id]/actions.ts`) generates a draft for one
message instance and stores it as a new version.

| Field | Required | Notes |
| --- | --- | --- |
| `leadId` | yes | uuid |
| `messageInstanceId` | yes | uuid |
| `businessId` | yes | uuid; the action checks the route against this business |

Outcomes the UI must handle distinctly:

| Result | Meaning | What the operator should do |
| --- | --- | --- |
| `ok: true` | a new version was stored | show `message` |
| `provider_not_configured` | no `DEEPSEEK_API_KEY` on this deployment | nothing to retry; explain it is not set up |
| `rate_limited` | provider is throttling | retry shortly |
| `timeout`, `provider_unavailable` | transient | retry |
| `unauthorized`, `invalid_request` | configuration or payload problem | do not retry blindly |
| `malformed_json`, `schema_invalid` | the model's answer was unusable and **nothing was stored** | regenerate; the message may need editing first |

`provider_not_configured` is a normal state, not an error: a deployment without an AI key must still
render the screen and offer manual drafting.

### 2.3 What the AI is not allowed to do

Worth knowing before building a "regenerate" control:

- A generated body is validated against the messaging rules **before** it is stored. A body that
  misses its personalization signal, asserts an unapproved numeric claim, contains a prohibited
  phrase, uses generic praise or a high-pressure CTA is **discarded, not repaired**. Repairing it
  would mean showing content that was never validated.
- Whether numeric results may be mentioned at all comes from `knowledge_assets.may_mention_numeric_results`
  on approved, AI-usable assets. If none authorises it, any digit is refused — including one that only
  quotes the prospect's own job posting.
- Profile extraction is grounded: a field with no verbatim quote in the model's `evidence` array is
  **dropped** and its name is returned in `droppedUngrounded`. Do not treat an absent field as "the
  model found nothing"; it may have been refused.

---

## 3. Reads a screen depends on

### 3.1 Message state and content

- `message_instances.state` is `DYNAMIC | LOCKED | SENT`.
- **A `SENT` instance always has a version with non-empty content.** This is enforced by a `CHECK` on
  `message_versions` and by a trigger on `message_instances`, so a UI may render
  `current_version_id`'s content unconditionally for a SENT row.
- A `SENT` instance's versions and its `current_version_id` are immutable by trigger. A UI must not
  offer an edit path for them; the edit produces an exception, not a no-op.
- `dueMessageForLead` prefers the earliest due unsent instance and falls back to the most recently
  sent one, so a screen can show history when nothing is pending. Its `content` is nullable **only**
  for the unsent case.

### 3.2 Lead timeline

`getLeadTimeline` returns a merged, newest-first list. Each entry has `kind`
(`outbound | inbound | note | task | connection | state | system`), `at`, `actorName`, `identityName`,
`summary`, `body`, `outcome` and `immutable`. `kind` is the discriminant, so a renderer should switch
on it exhaustively — `system` exists and carries entries no person produced.

An inbound reply's `body` is the reply **verbatim**, taken from the interaction payload, not the
truncated `summary`. A UI should render `body`; `summary` is a fallback for older rows.

### 3.3 The viewer context

`loadViewerContext()` returns `{ viewer, permissions, businesses, switcher, grants, nav }`.
`viewer.role` is `'admin' | 'manager' | 'user' | null`, and `viewer.userId` is null for a service
token. It is called by `(app)/layout.tsx` and again by each page, so it runs twice per render; it is
idempotent and not cached.

---

## 4. MCP gateway (`POST /api/v1/mcp`)

JSON-RPC 2.0 over HTTP. Methods: `initialize`, `tools/list`, `tools/call`. Errors follow the protocol
and are returned with HTTP 200.

### 4.1 `tools/list`

Each entry is `{ name, description, inputSchema }`, and `inputSchema` is generated from the same
schema that validates the call (`apps/web/src/app/api/v1/mcp/tool-schemas.ts`). It is therefore
authoritative — a client may generate its arguments from it. `business_id` (uuid) is required for
every tool except `nexus.list_accessible_businesses`, and `idempotency_key` (string, ≥ 8 chars) is
required for every tool that creates something.

### 4.2 Error classification

This distinction matters for an agent deciding whether to retry:

| Response | Meaning |
| --- | --- |
| `error` with `-32601` | unknown or forbidden tool (`database.execute_sql` and friends) |
| `error` with `-32600` | malformed JSON-RPC message, or an empty batch |
| `error` with `-32001` | missing or invalid token |
| `error` with `-32003` | the token is not scoped to that business or scope |
| `result.isError: true` | the call was well-formed and was refused, or the work failed. The text names the offending argument by path |

### 4.3 Idempotency

Every mutating tool requires an `idempotency_key`. Replaying a key returns the **first** result with
`idempotent: true` and does not run the tool again. Reusing a key with **different** arguments is
refused — answering with the earlier result would hide the caller's bug behind a plausible response.
Keys are scoped to the caller, the business and the tool.

### 4.4 Batches

An array body is a batch: every element receives its own response, in order. An empty batch is an
invalid request. A notification (no `id`) is executed and not answered. Elements execute sequentially,
because several may write.

---

## 5. Configuration and secrets

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DEEPSEEK_API_KEY` | no | — | absence is a supported state; AI features report `provider_not_configured` |
| `DEEPSEEK_BASE_URL` | no | `https://api.deepseek.com` | trailing slashes trimmed |
| `DEEPSEEK_MODEL` | no | `deepseek-chat` | |
| `DEEPSEEK_TIMEOUT_MS` | no | `30000` | per attempt |
| `DEEPSEEK_MAX_ATTEMPTS` | no | `3` | includes the first |
| `DEEPSEEK_RETRY_BASE_MS` | no | `500` | exponential, capped |

Read per call rather than at module load, so a build machine needs no credential.

**Nothing secret is ever returned to the browser.** `listApiClients` selects `token_prefix` and never
`token_hash`; `listWebhooks` never selects `secret_hash`. A raw service or user token is returned
exactly once, at creation, and is unrecoverable afterwards — the UI must require the operator to copy
it immediately. The AI provider's key never reaches a log line: upstream error bodies are passed
through `redactSecrets` before they are logged, and a returned failure carries a sentence, not a body.

---

## 6. Deliberately not implemented

Stated here so a frontend team does not build against something that does not exist. The lifecycle
sections below replace an earlier note that said archiving and identity retirement were not exposed —
both are now real actions with the contracts in §6.2 and §6.3.

### 6.1 Webhook delivery — deferred

`webhook_endpoints` and `webhook_deliveries` exist as tables, `GET /integrations` lists endpoints, and
`api_clients.kind` accepts `'webhook'`. **There is no delivery mechanism.** Nothing dispatches an
event, nothing signs a payload with `secret_hash`, nothing retries a failed delivery, and
`webhook_deliveries` is never written.

What this means for a screen:

- Treat the webhook list as **read-only**. There is no create, edit, test-fire or retry path on the
  server, so a form that offers one has nothing to call.
- `last_status` and `last_delivery_at` are always null in practice, because nothing updates them.
- Do not present webhooks as a working integration. `spec integrations.webhooks` is unimplemented;
  the tables are the schema for it, not evidence of it.

Implementing it properly needs a signed delivery worker with retry and dead-letter handling — an
outbox, a scheduler that is not the web process, and signature verification documented for the
receiver. That is a feature, not a wiring fix, and it is out of scope for this remediation.

### 6.2 Outreach identity lifecycle

Implemented. Three actions beyond the existing transfer, all in
`apps/web/src/app/(app)/identities/[id]/actions.ts`, all requiring `identity.manage` (admin-only), and
each re-authorized independently because a Server Action is a public endpoint.

Shared result shape:

```ts
interface LifecycleActionResult {
  ok: boolean;
  error: string | null | undefined;   // operator sentence
  message?: string;                   // success text
  errorCode?: string;                 // stable identifier — branch on this, not on `error`
  attribution?: Record<string, number>;  // identity only; present with identity_has_attribution
}
```

**`unassignIdentityAction`** — releases an identity without giving it to anyone.

| Input | Required | Notes |
| --- | --- | --- |
| `identityId` | yes | uuid |
| `note` | no | ≤ 2000 chars, recorded on the audit row |

State change: `managed_by_user_id` becomes `null`. **No `identity_transfers` row is written** — that
table names a recipient, and "nobody has this now" is not a transfer; recording it there would put a row
in the transfer log that answers no question. The change is audited as `identity_unassign`.

`errorCode`: `identity_not_found`, `identity_not_assigned`. Reversible: assign it again.

**`archiveIdentityAction`** — the way to retire a sender account.

| Input | Required | Notes |
| --- | --- | --- |
| `identityId` | yes | uuid |
| `note` | no | ≤ 2000 chars |

State changes, all in one transaction:

- `status` becomes `'retired'`.
- Every `browser_sessions` row with `status = 'active'` becomes `'revoked'` with `revoked_at` set. A
  bound browser profile would otherwise keep sending as a closed identity.
- Business bindings are **left in place** — they are configuration and part of the identity's history.
  Use `revokeBusinessAction` if the binding itself should go.
- An `identity_archive` audit row records the note and the revoked-session count.
- The identity disappears from `listIdentityOptions`, `companionIdentities` and the assignment list. It
  **stays visible on `/identities` marked `retired`**: archiving is not hiding.
- `identity_usable_by_actor` returns false, so every send and bind path refuses it — **including for an
  admin**, which it previously did not.

**Archiving is terminal.** The database refuses `status` moving away from `'retired'`, because
un-retiring would make the historical attribution of everything the identity sent ambiguous. Do not
render a "reactivate" control. Create a new identity instead.

`errorCode`: `identity_not_found`, `identity_already_archived` (idempotent retry).

**`deleteIdentityAction`** — only for an identity that never sent anything.

| Input | Required | Notes |
| --- | --- | --- |
| `identityId` | yes | uuid |
| `confirmation` | yes | the identity's `displayName`, typed exactly |

Returns `ok: false` with `errorCode: 'identity_has_attribution'` and the counts when history references
the identity. **This is not a validation failure and must not be rendered as one**: the request was
well-formed and the operation is genuinely unavailable. The UI is expected to offer Archive in that
state, which is why `attribution` comes back with it.

The underlying reason is worth knowing, because it is the one gap that was silently destructive: every
foreign key pointing at `outreach_identities` is `on delete set null`, so deleting an identity that had
sent messages **succeeded** and blanked the sender on all of them. The text survived with nobody
attributed to it, and nothing reported the loss. A repository guard and a `BEFORE DELETE` trigger now
refuse it.

`errorCode`: `identity_has_attribution`, `confirmation_required`, `identity_not_found`.

### 6.3 Business lifecycle

Implemented. Three actions in `apps/web/src/app/(app)/businesses/[id]/actions.ts`, all requiring the
route `/businesses` (`business.create`, admin-only).

`LifecycleActionResult` as above, plus:

```ts
protectedHistory?: Record<string, number>;  // business only; with business_has_protected_history
alreadyInState?: boolean;                   // the business was already archived
```

**`archiveBusinessAction`** — the safe way to close a business.

| Input | Required | Notes |
| --- | --- | --- |
| `businessId` | yes | uuid |
| `reason` | no | ≤ 2000 chars, recorded on the audit row |

State changes:

- `businesses.status` becomes `'archived'`, and the business leaves `listBusinesses()` — which is what
  removes it from the sidebar, the admin switcher, the Companion selector and
  `nexus.list_accessible_businesses`.
- Active `sequence_enrollments` become `'paused'`.
- Unsent `message_instances` are invalidated with `regeneration_reason = 'business_archived'`. **`SENT`
  instances are untouched** — they are history.
- A trigger then refuses any new lead, enrolment, message instance or import in the business, for every
  caller including direct SQL.
- An `archive_business` audit row records the reason.

Nothing is deleted. Leads, people, companies, conversations, messages, replies, tasks, notes, evidence
and audit rows are all preserved, and the business stays readable (an old `/b/<slug>/...` link resolves
and reports `archived` rather than 404). Idempotent: a retried archive returns
`alreadyInState: true`, not an error.

`errorCode`: none beyond `ok: false` with a sentence for an unknown business; authorization refusals
come back as the guard's generic message.

**`restoreBusinessAction`** — reverses an archive.

| Input | Required |
| --- | --- |
| `businessId` | yes |

State change: `status` becomes `'active'` and the business returns to the selectors; new work is
accepted again. Invalidated drafts are **not** resurrected — they are regenerated, the same path a
sequence publish takes. Audited as `restore_business`. Idempotent on an active business.

**`deleteBusinessAction`** — only for a business with no history at all.

| Input | Required | Notes |
| --- | --- | --- |
| `businessId` | yes | uuid |
| `confirmation` | yes | the business `key`, typed exactly |

Returns `errorCode: 'business_has_protected_history'` with `protectedHistory` when anything would be
destroyed, or `errorCode: 'confirmation_required'` when the typed key does not match. The first is a
screen state, not a validation failure — offer Archive.

`businesses` is the root of cascading foreign keys, so a delete destroys every lead, message version and
event, reply, note, task and evidence row the business owned, and none of it is reconstructible. The
guard therefore runs twice: in the repository before anything is attempted, and in a `BEFORE DELETE`
trigger so a caller that does not come through the repository cannot cascade by mistake. The
`security.hard_delete_requires_confirmation` setting does **not** unlock this — purging a trashed lead and
destroying a tenant's entire history are different decisions.

A business with no history (created by mistake, then deleted) still deletes normally.

---

## 7. Where to look

| Concern | File |
| --- | --- |
| Route → permission matrix, `routeAccessAllowed` | `packages/core/src/permissions.ts` |
| Route guard, action guard | `apps/web/src/lib/route-guard.ts` |
| Viewer context | `apps/web/src/lib/viewer-context.ts` |
| Actor / RLS transaction | `apps/web/src/lib/actor.ts` |
| AI provider transport | `apps/web/src/lib/ai/deepseek.ts` |
| AI drafting and extraction | `apps/web/src/lib/ai/drafting.ts` |
| AI configuration | `apps/web/src/lib/ai/config.ts` |
| MCP transport | `apps/web/src/app/api/v1/mcp/route.ts` |
| MCP argument schemas | `apps/web/src/app/api/v1/mcp/tool-schemas.ts` |
| Business lifecycle actions | `apps/web/src/app/(app)/businesses/[id]/actions.ts` |
| Business lifecycle repository | `apps/web/src/lib/repo/businesses.ts` |
| Identity lifecycle actions | `apps/web/src/app/(app)/identities/[id]/actions.ts` |
| Identity lifecycle repository | `apps/web/src/lib/repo/identities.ts` |
| Messaging rules, claim policy | `packages/core/src/messaging-rules.ts` |
| Schema, RLS, triggers, functions | `packages/db/migrations/` |
| Encoding repair (run once, idempotent) | `scripts/repair-encoding.mjs` |
