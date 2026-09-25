/**
 * Remote MCP gateway.
 *
 * spec `mcp_contract`:
 *   - "Expose intent-level tools, never arbitrary SQL."
 *   - forbidden: `database.execute_sql`
 *   - every write requires business scope, actor/client identity, an idempotency key
 *     when ingestion-related, schema validation and an audit event.
 *
 * The transport is JSON-RPC 2.0 over HTTP (`initialize`, `tools/list`, `tools/call`),
 * which is what an MCP client speaks. Only the tools listed in `MCP_TOOLS`
 * (`packages/core/src/contracts.ts`) can be called: the dispatch table below is an
 * exhaustive map, so an unknown tool name is a hard error rather than a fallback.
 *
 * There is no tool that takes SQL, and no generic "run this query" escape hatch. A
 * tool that needs data calls a repository function that runs through `withActor`, so
 * row-level security applies to an agent exactly as it does to a person.
 */
import { MCP_TOOLS, type McpToolName } from '@nexus/core';
import { contentHash, sha256Hex } from '@nexus/core';

import { withActor } from '@/lib/actor';
import type { Db } from '@/lib/sql';
import { requireScope, resolveCredential, type ServiceCredential, type UserCredential } from '@/lib/gateway';
import { companionSearch } from '@/lib/repo/companion';
import { listBusinesses } from '@/lib/repo/businesses';
import { submitIngest } from '@/lib/repo/ingest';

import { jsonOk } from '../_lib/http';
import {
  MCP_ENVELOPE_KEYS,
  MCP_TOOLS_REQUIRING_IDEMPOTENCY,
  mcpEnvelopeSchema,
  MCP_TOOL_SCHEMAS,
  toolCatalogue,
} from './tool-schemas';

export const dynamic = 'force-dynamic';

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

interface JsonRpcError {
  readonly code: number;
  readonly message: string;
}

const PARSE_ERROR: JsonRpcError = { code: -32700, message: 'Parse error' };
const INVALID_REQUEST: JsonRpcError = { code: -32600, message: 'Invalid Request' };
const METHOD_NOT_FOUND: JsonRpcError = { code: -32601, message: 'Method not found' };

function rpcError(id: unknown, error: JsonRpcError): Response {
  // JSON-RPC errors are part of the protocol, so they are returned with HTTP 200.
  return jsonOk({ jsonrpc: '2.0', id: id ?? null, error });
}

/** One entry per permitted tool. `never` for anything not in `MCP_TOOLS`. */
type ToolArgs = Readonly<Record<string, unknown>>;

/**
 * Refuses new business-specific work in an archived business.
 *
 * spec `business_units`: archiving takes a business out of the active selectors and stops new work
 * inside it, while preserving everything it already holds. An agent calling the gateway has to meet the
 * same rule a person does — otherwise MCP becomes the way around a lifecycle decision an administrator
 * made.
 *
 * The message names the state rather than the policy so the calling agent can act: an archived business
 * is a "restore it first" situation, not a retryable failure.
 */
async function assertBusinessAcceptsNewWork(sql: Db, businessId: string): Promise<void> {
  const result = await sql.query<{ open: boolean }>(
    `select public.business_is_open($1) as open`,
    [businessId],
  );
  if (result.rows[0]?.open !== true) {
    throw new Error(
      `Business ${businessId} is archived and does not accept new work. Restore it first; its existing leads, messages and history are unaffected.`,
    );
  }
}

function stringArg(args: ToolArgs, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function numberArg(args: ToolArgs, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * The tool table.
 *
 * Each entry declares the scope it needs and, for ingestion-shaped tools, whether an
 * idempotency key is mandatory. The `business_id` argument is required by every
 * business-scoped tool, and is checked against the token's allow-list before the
 * repository is called.
 */
const TOOL_HANDLERS: Readonly<
  Record<
    McpToolName,
    {
      readonly scope: string;
      readonly needsIdempotencyKey: boolean;
      readonly run: (
        credential: UserCredential | ServiceCredential,
        args: ToolArgs,
        businessId: string | null,
        envelope: { readonly idempotencyKey: string | undefined },
      ) => Promise<unknown>;
    }
  >
> = {
  'nexus.list_accessible_businesses': {
    scope: 'businesses:read',
    needsIdempotencyKey: false,
    run: async (credential) => {
      const businesses = await listBusinesses(credential.actor);
      return {
        businesses: businesses.map((business) => ({
          id: business.id,
          key: business.key,
          name: business.name,
          focus: business.focus,
          regions: business.regions,
        })),
      };
    },
  },

  'nexus.get_business_context': {
    scope: 'context:read',
    needsIdempotencyKey: false,
    run: async (credential, _args, businessId) => {
      if (businessId === null) throw new Error('business_id is required');
      return withActor(credential.actor, async (sql) => {
        const result = await sql.query<{
          name: string;
          key: string;
          focus: string | null;
          regions: string[];
        }>(`select name, key, focus, regions from public.businesses where id = $1`, [businessId]);
        const row = result.rows[0];
        if (row === undefined) throw new Error('Unknown business');
        return { business: row };
      });
    },
  },

  'nexus.search_person': {
    scope: 'person:search',
    needsIdempotencyKey: false,
    run: async (credential, args) => {
      const query = stringArg(args, 'query');
      if (query === null) throw new Error('query is required');
      const results = await companionSearch(credential.actor, query, numberArg(args, 'limit', 10));
      return { results };
    },
  },

  'nexus.search_company': {
    scope: 'company:search',
    needsIdempotencyKey: false,
    run: async (credential, args) => {
      const query = stringArg(args, 'query');
      if (query === null) throw new Error('query is required');
      return withActor(credential.actor, async (sql) => {
        const result = await sql.query<{ id: string; name: string; normalized_domain: string | null }>(
          `select id, name, normalized_domain from public.companies
            where normalized_name ilike $1 or coalesce(normalized_domain, '') ilike $1
            limit $2`,
          [`%${query}%`, numberArg(args, 'limit', 10)],
        );
        return { companies: result.rows };
      });
    },
  },

  'nexus.check_duplicate': {
    scope: 'duplicate:check',
    needsIdempotencyKey: false,
    run: async (credential, args, businessId) => {
      if (businessId === null) throw new Error('business_id is required');
      const query = stringArg(args, 'query');
      if (query === null) throw new Error('query is required');
      const results = await companionSearch(credential.actor, query, 5);
      return {
        duplicate: results.some((row) => row.businessId === businessId),
        matches: results.filter((row) => row.businessId === businessId),
      };
    },
  },

  'nexus.submit_candidate': {
    scope: 'candidate:submit',
    needsIdempotencyKey: true,
    run: submitThroughPipeline,
  },

  'nexus.create_signal': {
    scope: 'signal:create',
    needsIdempotencyKey: true,
    run: async (credential, args, businessId) => {
      if (businessId === null) throw new Error('business_id is required');
      return withActor(credential.actor, async (sql) => {
        // A signal is new business-specific intelligence, so an archived business refuses it. The
        // database gates leads, enrolments, message instances and imports with a trigger; `signals` is
        // not one of the four, so the check is stated here rather than left implicit.
        await assertBusinessAcceptsNewWork(sql, businessId);

        // No idempotency check here: the gateway owns it for every tool and has already replayed or
        // reserved this key before dispatch. Reading it from `args` would always fail, because the
        // envelope is stripped.
        const result = await sql.query<{ id: string }>(
          `insert into public.signals
             (business_id, company_id, person_id, lead_id, kind, polarity, strength, label, detail, observed_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
           returning id`,
          [
            businessId,
            stringArg(args, 'company_id'),
            stringArg(args, 'person_id'),
            stringArg(args, 'lead_id'),
            stringArg(args, 'kind') ?? 'custom',
            stringArg(args, 'polarity') ?? 'neutral',
            numberArg(args, 'strength', 0),
            stringArg(args, 'label'),
            stringArg(args, 'detail'),
          ],
        );
        return { signal_id: result.rows[0]?.id ?? null };
      });
    },
  },

  'nexus.add_source_evidence': {
    scope: 'evidence:add',
    needsIdempotencyKey: true,
    run: async (credential, args, businessId) => {
      if (businessId === null) throw new Error('business_id is required');
      return withActor(credential.actor, async (sql) => {
        const source = stringArg(args, 'source');
        if (source === null) throw new Error('source is required');
        // Derived from the payload when the client does not supply one, so the stored hash always
        // describes what was actually recorded rather than what the client claimed.
        const evidenceHash =
          stringArg(args, 'content_hash') ??
          contentHash({ source, payload: args, observedAt: new Date().toISOString().slice(0, 10) });
        // Rediscovery is recorded as new evidence; the unique (business_id,
        // content_hash) index makes a repeat a no-op rather than a duplicate.
        const result = await sql.query<{ id: string }>(
          `insert into public.source_evidence
             (business_id, person_id, company_id, lead_id, source, source_url, raw_text_or_json,
              content_hash, observed_at, confidence)
           values ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
           on conflict (business_id, content_hash) do nothing
           returning id`,
          [
            businessId,
            stringArg(args, 'person_id'),
            stringArg(args, 'company_id'),
            stringArg(args, 'lead_id'),
            source,
            stringArg(args, 'source_url'),
            stringArg(args, 'raw_text_or_json') ?? JSON.stringify(args),
            evidenceHash,
            numberArg(args, 'confidence', 0.5),
          ],
        );
        return { evidence_id: result.rows[0]?.id ?? null, deduplicated: result.rows[0] === undefined };
      });
    },
  },

  'nexus.create_or_update_lead': {
    scope: 'lead:create',
    needsIdempotencyKey: true,
    run: submitThroughPipeline,
  },

  'nexus.assign_lead': {
    scope: 'lead:assign',
    needsIdempotencyKey: false,
    run: async (credential, args, businessId) => {
      if (businessId === null) throw new Error('business_id is required');
      const leadId = stringArg(args, 'lead_id');
      const ownerId = stringArg(args, 'owner_user_id');
      if (leadId === null || ownerId === null) throw new Error('lead_id and owner_user_id are required');

      return withActor(credential.actor, async (sql) => {
        // Assignment is audited because it is a sensitive mutation
        // (spec `roles_and_permissions.admin.can`: "Assign/reassign lead ownership").
        const lead = await sql.query<{ owner_user_id: string | null; business_id: string }>(
          `select owner_user_id, business_id from public.leads where id = $1`,
          [leadId],
        );
        const row = lead.rows[0];
        if (row === undefined) throw new Error('Unknown lead');

        await sql.query(`update public.leads set owner_user_id = $2, last_activity_at = now() where id = $1`, [
          leadId,
          ownerId,
        ]);
        await sql.query(
          `insert into public.lead_assignments (lead_id, business_id, from_user_id, to_user_id, reason, actor_user_id)
           values ($1, $2, $3, $4, $5, null)`,
          [leadId, row.business_id, row.owner_user_id, ownerId, 'Assigned via MCP'],
        );
        return { lead_id: leadId, owner_user_id: ownerId };
      });
    },
  },

  'nexus.submit_profile_capture': {
    scope: 'profile:capture',
    needsIdempotencyKey: false,
    run: async (credential, args, businessId) => {
      if (businessId === null) throw new Error('business_id is required');
      const leadId = stringArg(args, 'lead_id');
      const linkedinUrl = stringArg(args, 'linkedin_url');
      const pastedContent = stringArg(args, 'pasted_content');
      if (leadId === null || linkedinUrl === null || pastedContent === null) {
        throw new Error('lead_id, linkedin_url and pasted_content are required');
      }
      const { submitProfileCapture } = await import('@/lib/repo/profile-capture');
      const { loadViewer } = await import('@/lib/actor');
      const viewer = await loadViewer(credential.actor);
      const result = await submitProfileCapture(viewer, { leadId, linkedinUrl, pastedContent });
      if (!result.ok) throw new Error(result.error ?? 'The capture was refused');
      return { lead_id: result.id ?? leadId, updated: true };
    },
  },

  'nexus.capture_reply': {
    scope: 'reply:capture',
    needsIdempotencyKey: false,
    run: async (credential, args) => {
      const leadId = stringArg(args, 'lead_id');
      const exactText = stringArg(args, 'exact_text');
      const outcome = stringArg(args, 'outcome');
      if (leadId === null || exactText === null || outcome === null) {
        throw new Error('lead_id, exact_text and outcome are required');
      }
      const { recordExternalReply } = await import('@/lib/repo/ingest');
      await recordExternalReply(credential.actor, {
        leadId,
        exactText,
        outcome,
        // The envelope's `source_client` was stripped before the tool ran, so the default is the
        // transport's own name rather than something an argument could spoof.
        sourceClient: 'mcp',
      });
      return { lead_id: leadId, captured: true };
    },
  },

  'nexus.add_note': {
    scope: 'note:add',
    needsIdempotencyKey: false,
    run: async (credential, args, businessId) => {
      if (businessId === null) throw new Error('business_id is required');
      const leadId = stringArg(args, 'lead_id');
      const body = stringArg(args, 'body');
      if (leadId === null || body === null) throw new Error('lead_id and body are required');
      return withActor(credential.actor, async (sql) => {
        const result = await sql.query<{ id: string }>(
          `insert into public.notes (business_id, lead_id, person_id, author_user_id, body, is_internal)
           select l.business_id, l.id, l.person_id, null, $2, true from public.leads l where l.id = $1
           returning id`,
          [leadId, body],
        );
        return { note_id: result.rows[0]?.id ?? null };
      });
    },
  },

  'nexus.create_task': {
    scope: 'task:create',
    needsIdempotencyKey: false,
    run: async (credential, args, businessId) => {
      if (businessId === null) throw new Error('business_id is required');
      const leadId = stringArg(args, 'lead_id');
      const title = stringArg(args, 'title');
      if (leadId === null || title === null) throw new Error('lead_id and title are required');
      return withActor(credential.actor, async (sql) => {
        const result = await sql.query<{ id: string }>(
          `insert into public.tasks (lead_id, business_id, owner_user_id, type, title, due_at, priority, status, source)
           select l.id, l.business_id, l.owner_user_id, $2, $3, $4, $5, 'open', 'agent'
             from public.leads l where l.id = $1
           returning id`,
          [
            leadId,
            stringArg(args, 'type') ?? 'follow_up',
            title,
            stringArg(args, 'due_at'),
            stringArg(args, 'priority') ?? 'normal',
          ],
        );
        return { task_id: result.rows[0]?.id ?? null };
      });
    },
  },

  'nexus.get_today_queue': {
    scope: 'today:read',
    needsIdempotencyKey: false,
    run: async (credential, args, businessId) => {
      if (businessId === null) throw new Error('business_id is required');
      // An API client reading a user's queue is refused by the database function,
      // which requires an actor user; that is the intended behaviour.
      return withActor(credential.actor, async (sql) => {
        const userId = stringArg(args, 'user_id');
        if (userId === null) throw new Error('user_id is required');
        const result = await sql.query(
          `select * from public.get_today_queue($1, $2, 'today', null, now())`,
          [userId, businessId],
        );
        return { items: result.rows };
      });
    },
  },

  'nexus.submit_research': {
    scope: 'research:submit',
    needsIdempotencyKey: true,
    run: async (credential, args, businessId) => {
      if (businessId === null) throw new Error('business_id is required');
      return withActor(credential.actor, async (sql) => {
        const leadId = stringArg(args, 'lead_id');
        const summary = stringArg(args, 'summary');
        if (leadId === null || summary === null) throw new Error('lead_id and summary are required');
        const result = await sql.query<{ id: string }>(
          `insert into public.research_snapshots
             (business_id, lead_id, person_id, company_id, summary, findings, model, created_by)
           select $1, l.id, l.person_id, l.company_id, $3, $4::jsonb, $5, null
             from public.leads l where l.id = $2
           returning id`,
          [businessId, leadId, summary, JSON.stringify(args['findings'] ?? {}), stringArg(args, 'model')],
        );
        return { research_snapshot_id: result.rows[0]?.id ?? null };
      });
    },
  },

  'nexus.submit_message_draft': {
    scope: 'message:draft',
    needsIdempotencyKey: false,
    run: async (credential, args, businessId) => {
      if (businessId === null) throw new Error('business_id is required');
      const instanceId = stringArg(args, 'message_instance_id');
      const content = stringArg(args, 'content');
      if (instanceId === null || content === null) {
        throw new Error('message_instance_id and content are required');
      }
      return withActor(credential.actor, async (sql) => {
        // A draft is a NEW version, never an overwrite: sent content is immutable
        // (spec `sequence_engine.message_states`).
        const result = await sql.query<{ id: string }>(
          `insert into public.message_versions
             (message_instance_id, content, generated_by_model, prompt_version_id, sequence_version_id, is_manual_edit, created_by)
           values ($1, $2, $3, null, null, false, null)
           returning id`,
          [instanceId, content, stringArg(args, 'model')],
        );
        const versionId = result.rows[0]?.id ?? null;
        if (versionId !== null) {
          await sql.query(
            `update public.message_instances
                set current_version_id = $2, updated_at = now()
              where id = $1 and state <> 'SENT'`,
            [instanceId, versionId],
          );
        }
        return { message_version_id: versionId };
      });
    },
  },

  'nexus.finish_agent_run': {
    scope: 'agent:run',
    needsIdempotencyKey: false,
    run: async (credential, args, businessId) => {
      if (businessId === null) throw new Error('business_id is required');
      return withActor(credential.actor, async (sql) => {
        const result = await sql.query<{ id: string }>(
          `insert into public.agent_runs
             (business_id, api_client_id, agent_name, objective, state, finished_at, summary, result, stats)
           values ($1, public.acting_api_client_id(), $2, $3, $4, now(), $5, $6::jsonb, $7::jsonb)
           returning id`,
          [
            businessId,
            stringArg(args, 'agent_name') ?? 'unknown',
            stringArg(args, 'objective'),
            stringArg(args, 'state') ?? 'completed',
            stringArg(args, 'summary'),
            JSON.stringify(args['result'] ?? {}),
            JSON.stringify(args['stats'] ?? {}),
          ],
        );
        return { agent_run_id: result.rows[0]?.id ?? null };
      });
    },
  },
};

/** Candidate/lead tools all funnel through the audited ingest pipeline. */
async function submitThroughPipeline(
  credential: UserCredential | ServiceCredential,
  args: ToolArgs,
  businessId: string | null,
  envelope: { readonly idempotencyKey: string | undefined },
): Promise<unknown> {
  if (businessId === null) throw new Error('business_id is required');

  // Two layers of idempotency, deliberately: the gateway key guards the *tool call*, and this key
  // guards the *ingest*. The ingest record is what makes a retry after a crash mid-pipeline safe, so
  // it needs the key even though the gateway has already seen it.
  const idempotencyKey = envelope.idempotencyKey;
  if (idempotencyKey === undefined) throw new Error('idempotency_key is required for ingestion tools');

  const outcome = await submitIngest(credential.actor, {
    sourceClient: 'mcp',
    businessId,
    payloadType: 'candidate',
    payload: args,
    idempotencyKey,
    observedAt: new Date().toISOString(),
    businessKeyOrId: businessId,
  });

  return {
    lead_id: outcome.leadId ?? null,
    person_id: outcome.personId ?? null,
    company_id: outcome.companyId ?? null,
    idempotent: outcome.idempotent,
    stages: outcome.stages,
  };
}

/** Human-readable tool catalogue for `tools/list`, generated from the argument schemas. */
export { toolCatalogue };

/* ------------------------------------------------------------ dispatch --- */
interface DispatchOutcome {
  readonly response: Record<string, unknown>;
  /** True when a write happened, so batch execution can proceed sequentially. */
  readonly mutated: boolean;
}

/**
 * Handles one JSON-RPC message.
 *
 * Extracted from `POST` so a batch element and a single request take exactly the same path — the
 * audit found the transport doing `Array.isArray(body) ? body[0] : body`, which silently discarded
 * every element after the first.
 */
async function dispatch(
  message: unknown,
  credential: UserCredential | ServiceCredential,
): Promise<DispatchOutcome> {
  const rpc = (typeof message === 'object' && message !== null ? message : {}) as JsonRpcRequest;
  const id = rpc.id ?? null;

  const error = (code: number, textMessage: string): DispatchOutcome => ({
    response: { jsonrpc: '2.0', id, error: { code, message: textMessage } },
    mutated: false,
  });

  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    return error(INVALID_REQUEST.code, INVALID_REQUEST.message);
  }

  switch (rpc.method) {
    case 'initialize':
      return {
        response: {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'nexus', version: '1.0.0' },
            capabilities: { tools: {} },
          },
        },
        mutated: false,
      };

    case 'tools/list':
      return { response: { jsonrpc: '2.0', id, result: { tools: toolCatalogue() } }, mutated: false };

    case 'tools/call':
      return callTool(rpc, credential);

    default:
      return error(METHOD_NOT_FOUND.code, METHOD_NOT_FOUND.message);
  }
}

/** `tools/call`: validate the name, the envelope and the arguments, then dispatch. */
async function callTool(
  rpc: JsonRpcRequest,
  credential: UserCredential | ServiceCredential,
): Promise<DispatchOutcome> {
  const id = rpc.id ?? null;
  const fail = (code: number, message: string): DispatchOutcome => ({
    response: { jsonrpc: '2.0', id, error: { code, message } },
    mutated: false,
  });
  // A tool refusal is reported inside the *result* so the calling agent can react to it without
  // treating it as a transport failure; a malformed call is a protocol error and is not.
  const refused = (message: string): DispatchOutcome => ({
    response: {
      jsonrpc: '2.0',
      id,
      result: { isError: true, content: [{ type: 'text', text: message }] },
    },
    mutated: false,
  });

  const params = (rpc.params ?? {}) as { name?: unknown; arguments?: unknown };
  const name = typeof params.name === 'string' ? params.name : '';

  // Exhaustive membership test against the spec's tool list. An unknown or forbidden tool
  // (e.g. database.execute_sql) cannot reach a handler.
  if (!(MCP_TOOLS as readonly string[]).includes(name)) {
    return fail(METHOD_NOT_FOUND.code, `Unknown tool: ${name}`);
  }
  const toolName = name as McpToolName;

  const rawArgs =
    typeof params.arguments === 'object' && params.arguments !== null
      ? (params.arguments as ToolArgs)
      : {};

  const envelope = mcpEnvelopeSchema.safeParse(rawArgs);
  if (!envelope.success) {
    return refused(`Invalid arguments: ${describeIssues(envelope.error)}`);
  }
  // Read from `rawArgs`, not from `envelope.data`: Zod strips unknown keys, so a tool schema with a
  // different field set would silently blank these out.
  const businessId = typeof rawArgs['business_id'] === 'string' ? rawArgs['business_id'] : null;
  const idempotencyKey = typeof rawArgs['idempotency_key'] === 'string' ? rawArgs['idempotency_key'] : undefined;

  // Validated *before* dispatch, so "your arguments were wrong" is distinguishable from "the
  // database refused this" — the first is fixable by retrying differently, the second is not.
  const schema = MCP_TOOL_SCHEMAS[toolName];
  const toolArgs: ToolArgs = Object.fromEntries(
    Object.entries(rawArgs).filter(([key]) => !MCP_ENVELOPE_KEYS.includes(key)),
  );
  const parsed = schema.safeParse(toolArgs);
  if (!parsed.success) {
    return refused(`Invalid arguments for ${toolName}: ${describeIssues(parsed.error)}`);
  }
  const args = parsed.data as ToolArgs;

  if (MCP_TOOLS_REQUIRING_IDEMPOTENCY[toolName] && idempotencyKey === undefined) {
    return refused(`idempotency_key is required for ${toolName}`);
  }

  const handler = TOOL_HANDLERS[toolName];
  // `nexus.list_accessible_businesses` is the one tool that is not business-scoped: its purpose is to
  // discover which businesses the token reaches. Passing an absent `business_id` through to
  // `requireScope` made it answer `-32003 "not scoped to that business"` for a token whose scope list
  // was perfectly correct, so a client could never get past discovery.
  const scopeCheck =
    businessId === null
      ? requireScope(credential, handler.scope)
      : requireScope(credential, handler.scope, businessId);
  if (!scopeCheck.ok) {
    return fail(-32003, scopeCheck.error);
  }

  // ---------------------------------------------------------------- idempotency --
  //
  // A key already used for this caller, business and tool returns the *first* result and does not
  // run the tool again. Reusing a key with different arguments is refused rather than answered with
  // the earlier result, because that would hide the client's bug behind a plausible response.
  const key = idempotencyKey;
  if (key !== undefined) {
    const argumentsHash = sha256Hex(canonicalJson(args));
    const prior = await findPriorInvocation(credential, businessId, toolName, key);
    if (prior !== null) {
      if (prior.argumentsHash !== argumentsHash) {
        return refused(
          `idempotency_key ${key} was already used for ${toolName} with different arguments.`,
        );
      }
      return {
        response: {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(prior.result) }],
            structuredContent: prior.result,
            idempotent: true,
          },
        },
        mutated: false,
      };
    }

    let result: unknown;
    try {
      result = await handler.run(credential, args, businessId, { idempotencyKey: key });
    } catch (toolError) {
      return refused(toolError instanceof Error ? toolError.message : 'The tool call failed.');
    }

    await rememberInvocation(credential, businessId, toolName, key, argumentsHash, result);
    return {
      response: {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
          idempotent: false,
        },
      },
      mutated: true,
    };
  }

  try {
    const result = await handler.run(credential, args, businessId, { idempotencyKey: undefined });
    return {
      response: {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        },
      },
      mutated: true,
    };
  } catch (toolError) {
    const message = toolError instanceof Error ? toolError.message : 'The tool call failed.';
    return { response: { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: message }] } }, mutated: false };
  }
}

/** `path: message` for each Zod issue, capped so a pathological payload cannot flood the response. */
function describeIssues(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * A canonical JSON form for hashing arguments.
 *
 * Keys are sorted so that `{a,b}` and `{b,a}` hash identically: argument order is not part of what a
 * caller means, and treating it as significant would refuse a legitimate retry.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

interface PriorInvocation {
  readonly result: unknown;
  readonly argumentsHash: string;
}

async function findPriorInvocation(
  credential: UserCredential | ServiceCredential,
  businessId: string | null,
  toolName: string,
  idempotencyKey: string,
): Promise<PriorInvocation | null> {
  return withActor(credential.actor, async (sql) => {
    const result = await sql.query<{ result: unknown; arguments_hash: string }>(
      `select result, arguments_hash from public.mcp_tool_invocations
        where tool_name = $1 and idempotency_key = $2
          and business_id is not distinct from $3`,
      [toolName, idempotencyKey, businessId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { result: row.result, argumentsHash: row.arguments_hash };
  });
}

async function rememberInvocation(
  credential: UserCredential | ServiceCredential,
  businessId: string | null,
  toolName: string,
  idempotencyKey: string,
  argumentsHash: string,
  result: unknown,
): Promise<void> {
  await withActor(credential.actor, async (sql) => {
    await sql.query(
      `insert into public.mcp_tool_invocations
         (api_client_id, actor_user_id, business_id, tool_name, idempotency_key, arguments_hash, result)
       values (
         public.acting_api_client_id(),
         public.current_user_id(),
         $1, $2, $3, $4, $5::jsonb
       )
       on conflict do nothing`,
      [businessId, toolName, idempotencyKey, argumentsHash, JSON.stringify(result ?? {})],
    );

    await sql.query(
      `select public.enqueue_audit(
         'mcp_tool', null, 'mcp_tool_call', $1, null,
         jsonb_build_object(
           'tool_name', $2::text,
           'idempotency_key', $3::text,
           'arguments_hash', $4::text
         ),
         'mcp'
       )`,
      [businessId, toolName, idempotencyKey, argumentsHash],
    );
  });
}

export async function POST(request: Request): Promise<Response> {
  const resolved = await resolveCredential(request.headers.get('authorization'));
  if (resolved.kind === 'anonymous') {
    return rpcError(null, { code: -32001, message: 'Missing or invalid token.' });
  }

  // Narrowed once, here: every tool handler below is guaranteed a real identity, so
  // none of them has to re-check (or could forget to).
  const credential: UserCredential | ServiceCredential = resolved;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, PARSE_ERROR);
  }

  // JSON-RPC 2.0 batch. Returning only the first element — as this did — makes a client that sends
  // two calls in one request see the second silently dropped. An empty batch is an invalid request,
  // and a *notification* (no `id`) never gets a response at all.
  if (Array.isArray(body)) {
    if (body.length === 0) return jsonOk({ jsonrpc: '2.0', id: null, error: INVALID_REQUEST });

    const responses: Record<string, unknown>[] = [];
    // Sequential, not parallel: several elements may write, and interleaving them through one
    // connection would make the ordering of those writes depend on network timing.
    for (const message of body) {
      const outcome = await dispatch(message, credential);
      const isNotification =
        typeof message === 'object' && message !== null && !('id' in (message as object));
      if (!isNotification) responses.push(outcome.response);
    }
    return jsonOk(responses);
  }

  const outcome = await dispatch(body, credential);
  return jsonOk(outcome.response);
}

export function GET(): Response {
  // Capability discovery for a client that probes with GET before POSTing.
  return jsonOk({
    protocol: 'mcp',
    transport: 'http-jsonrpc',
    tools: MCP_TOOLS,
  });
}
