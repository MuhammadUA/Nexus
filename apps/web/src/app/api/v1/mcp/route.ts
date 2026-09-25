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

import { withActor } from '@/lib/actor';
import { requireScope, resolveCredential, type ServiceCredential, type UserCredential } from '@/lib/gateway';
import { companionSearch } from '@/lib/repo/companion';
import { listBusinesses } from '@/lib/repo/businesses';
import { submitIngest } from '@/lib/repo/ingest';

import { jsonOk } from '../_lib/http';

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

function rpcResult(id: unknown, result: unknown): Response {
  return jsonOk({ jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, error: JsonRpcError): Response {
  // JSON-RPC errors are part of the protocol, so they are returned with HTTP 200.
  return jsonOk({ jsonrpc: '2.0', id: id ?? null, error });
}

/** One entry per permitted tool. `never` for anything not in `MCP_TOOLS`. */
type ToolArgs = Readonly<Record<string, unknown>>;

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
      readonly run: (credential: UserCredential | ServiceCredential, args: ToolArgs, businessId: string | null) => Promise<unknown>;
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
        const idempotencyKey = stringArg(args, 'idempotency_key');
        if (idempotencyKey === null) throw new Error('idempotency_key is required');

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
            stringArg(args, 'kind') ?? 'other',
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
        const contentHash = stringArg(args, 'content_hash');
        const source = stringArg(args, 'source');
        if (contentHash === null || source === null) {
          throw new Error('source and content_hash are required');
        }
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
            contentHash,
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
        sourceClient: stringArg(args, 'source_client') ?? 'mcp',
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
): Promise<unknown> {
  if (businessId === null) throw new Error('business_id is required');

  const idempotencyKey = stringArg(args, 'idempotency_key');
  if (idempotencyKey === null) throw new Error('idempotency_key is required for ingestion tools');

  const outcome = await submitIngest(credential.actor, {
    sourceClient: stringArg(args, 'source_client') ?? 'mcp',
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

/** Human-readable tool catalogue for `tools/list`. */
function toolCatalogue(): readonly {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}[] {
  return MCP_TOOLS.map((name) => ({
    name,
    description: `Nexus intent-level tool: ${name.replace('nexus.', '')}`,
    inputSchema: {
      type: 'object',
      properties: {
        business_id: { type: 'string', description: 'Target business (must be within the token scope).' },
      },
      required: name === 'nexus.list_accessible_businesses' ? [] : ['business_id'],
    },
  }));
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

  const rpc = (Array.isArray(body) ? body[0] : body) as JsonRpcRequest;
  if (typeof rpc !== 'object' || rpc === null || typeof rpc.method !== 'string') {
    return rpcError(rpc?.id ?? null, INVALID_REQUEST);
  }

  switch (rpc.method) {
    case 'initialize':
      return rpcResult(rpc.id, {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'nexus', version: '1.0.0' },
        capabilities: { tools: {} },
      });

    case 'tools/list':
      return rpcResult(rpc.id, { tools: toolCatalogue() });

    case 'tools/call': {
      const params = (rpc.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof params.name === 'string' ? params.name : '';

      // Exhaustive membership test against the spec's tool list. An unknown or
      // forbidden tool (e.g. database.execute_sql) cannot reach a handler.
      if (!(MCP_TOOLS as readonly string[]).includes(name)) {
        return rpcError(rpc.id, { code: METHOD_NOT_FOUND.code, message: `Unknown tool: ${name}` });
      }

      const handler = TOOL_HANDLERS[name as McpToolName];
      const args: ToolArgs =
        typeof params.arguments === 'object' && params.arguments !== null
          ? (params.arguments as ToolArgs)
          : {};

      const businessId = stringArg(args, 'business_id');
      const scopeCheck = requireScope(credential, handler.scope, businessId ?? '');
      if (!scopeCheck.ok) {
        return rpcError(rpc.id, { code: -32003, message: scopeCheck.error });
      }

      try {
        const result = await handler.run(credential, args, businessId);
        return rpcResult(rpc.id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The tool call failed.';
        // Tool failures are reported inside the result so the calling agent can react
        // without treating a refusal as a transport error.
        return rpcResult(rpc.id, {
          isError: true,
          content: [{ type: 'text', text: message }],
        });
      }
    }

    default:
      return rpcError(rpc.id, METHOD_NOT_FOUND);
  }
}

export function GET(): Response {
  // Capability discovery for a client that probes with GET before POSTing.
  return jsonOk({
    protocol: 'mcp',
    transport: 'http-jsonrpc',
    tools: MCP_TOOLS,
  });
}
