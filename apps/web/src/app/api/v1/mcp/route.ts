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
import {
  contentHash,
  intelligenceCompleteness,
  normalizeDiscoverySource,
  OUTREACH_CHANNELS,
  searchLinks,
  sha256Hex,
  validateMessage,
} from '@nexus/core';

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

/**
 * Message-rule violations that refuse a submitted draft outright.
 *
 * The remaining codes (`too_short`, `too_long`, `missing_personalization`,
 * `missing_explanation`, `missing_low_pressure_cta`) are style rules that exist to
 * shape *generated* text; they are returned as warnings so an agent that is editing
 * or excerpting a body is not blocked, while a body that asserts an unapproved
 * claim, quotes a prohibited phrase or names a client without permission is refused.
 * Before V1.2 this tool validated nothing at all and labelled the row as
 * model-generated, which is what made an unapproved claim persistable.
 */
const BLOCKING_DRAFT_VIOLATIONS: readonly string[] = [
  'empty',
  'prohibited_phrase',
  'generic_praise',
  'high_pressure_cta',
  'unapproved_claim',
  'unauthorized_client_name',
];

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
 * The id of a row an `insert ... select ... where <parent>.id = $1` actually wrote.
 *
 * Several tools resolve their tenant and person columns by selecting from the parent row —
 * `insert into notes (...) select l.business_id, l.person_id, ... from leads l where l.id = $1`.
 * When the referenced parent does not exist (or is invisible under RLS) the SELECT matches zero
 * rows, the INSERT writes nothing, and `returning id` yields no rows. Returning `rows[0]?.id ?? null`
 * in that case reported **success with a null id**: the caller was told a note was created and no
 * note existed, which is silent data loss with no error to retry on.
 *
 * This is a caller error, not an empty result, so it throws and the tool answers with `isError`.
 * The message names the entity and id so the caller can fix the argument, and deliberately does not
 * distinguish "does not exist" from "not visible to you" — confirming existence of a lead outside
 * the caller's scope would leak tenancy information.
 */
function requireWrittenRow(
  result: { readonly rows: readonly { readonly id: string }[] },
  parentId: string,
  parentKind: string,
): string {
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error(
      `No ${parentKind} found with id ${parentId}, or it is not visible to this caller; nothing was written.`,
    );
  }
  return id;
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
    run: async (credential, args) => {
      const query = stringArg(args, 'query');
      if (query === null) throw new Error('query is required');
      const results = await companionSearch(credential.actor, query, numberArg(args, 'limit', 10));
      return { results };
    },
  },

  'nexus.search_company': {
    scope: 'company:search',
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
    run: submitThroughPipeline,
  },

  'nexus.create_signal': {
    scope: 'signal:create',
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
    run: submitThroughPipeline,
  },

  'nexus.assign_lead': {
    scope: 'lead:assign',
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
    run: async (credential, args) => {
      const leadId = stringArg(args, 'lead_id');
      const exactText = stringArg(args, 'exact_text');
      const outcome = stringArg(args, 'outcome');
      if (leadId === null || exactText === null || outcome === null) {
        throw new Error('lead_id, exact_text and outcome are required');
      }

      // Capture first, classify second, and never the other way round: the reply
      // exists before any model call is attempted, and a classification failure is
      // reported as a missing reading rather than as a failed capture. The exact
      // text is stored verbatim by `capture_reply`; the reading goes into its own
      // interaction row.
      const { captureReplyAndClassify } = await import('@/lib/ai/reply-classification');
      const { reply, classification } = await captureReplyAndClassify(credential.actor, {
        leadId,
        exactText,
        outcome,
        // The envelope's `source_client` was stripped before the tool ran, so the default is the
        // transport's own name rather than something an argument could spoof.
        sourceClient: 'mcp',
      });

      return {
        lead_id: reply.leadId,
        captured: true,
        outcome: reply.outcome,
        // `null` means "no reading", never "the reply failed": the capture above
        // already committed.
        classification:
          classification !== null && classification.ok
            ? {
                outcome: classification.classification.outcome,
                sentiment: classification.classification.sentiment,
                intent: classification.classification.intent,
                recommended_next_action: classification.classification.recommended_next_action,
                agrees_with_captured_outcome: classification.agreesWithCapturedOutcome,
                cached: classification.cached,
              }
            : null,
        classification_error:
          classification !== null && !classification.ok
            ? { code: classification.errorCode, message: classification.error }
            : null,
      };
    },
  },

  'nexus.add_note': {
    scope: 'note:add',
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
        return { note_id: requireWrittenRow(result, leadId, 'lead') };
      });
    },
  },

  'nexus.create_task': {
    scope: 'task:create',
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
        return { task_id: requireWrittenRow(result, leadId, 'lead') };
      });
    },
  },

  'nexus.get_today_queue': {
    scope: 'today:read',
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
        return { research_snapshot_id: requireWrittenRow(result, leadId, 'lead') };
      });
    },
  },

  'nexus.submit_message_draft': {
    scope: 'message:draft',
    run: async (credential, args, businessId) => {
      if (businessId === null) throw new Error('business_id is required');
      const instanceId = stringArg(args, 'message_instance_id');
      const content = stringArg(args, 'content');
      if (instanceId === null || content === null) {
        throw new Error('message_instance_id and content are required');
      }

      const { loadViewer } = await import('@/lib/actor');
      const { loadAssertableContext, loadDraftContext, resolveMessageRules } = await import(
        '@/lib/ai/drafting'
      );
      const viewer = await loadViewer(credential.actor);

      // A body submitted by an external client is a *manual edit*, and it faces the
      // same rules one would: the previous revision stored it without validating it
      // and labelled it as model-generated, so an unapproved numeric claim or a
      // prohibited phrase could be persisted through this tool and then sent. The
      // rules and the assertable-claim set are the same ones the drafting path uses,
      // so the two cannot disagree about what is acceptable.
      const context = await loadDraftContext(viewer, instanceId);
      if (context === null) {
        // Includes the SENT case: `loadDraftContext` refuses a sent instance, which
        // is what keeps sent content immutable.
        throw new Error('That message is not available for drafting.');
      }

      const assertable = await loadAssertableContext(viewer, context);
      const validation = validateMessage({
        content,
        rules: resolveMessageRules(context.step.wordMax, null),
        approvedClaims: assertable.claims,
        mayMentionNumericResults: assertable.mayMentionNumericResults,
        mayMentionClientName: assertable.mayMentionClientName,
      });

      // Blocking violations are the ones that make the text unsafe or untrue to
      // send: a prohibited phrase, generic praise, high-pressure pressure, an
      // unapproved numeric claim, or an unauthorised client name. The style rules
      // (length, personalisation, CTA shape) are reported as warnings instead: an
      // external client may legitimately be submitting an edit or an excerpt, and
      // refusing it for being five words long would push callers to bypass Nexus.
      const blocked = validation.violations.filter((violation) =>
        BLOCKING_DRAFT_VIOLATIONS.includes(violation.code),
      );
      if (blocked.length > 0) {
        throw new Error(
          `The submitted draft does not satisfy the messaging rules: ${blocked
            .map((violation) => violation.code)
            .join(', ')}`,
        );
      }

      return withActor(credential.actor, async (sql) => {
        // A draft is a NEW version, never an overwrite: sent content is immutable
        // (spec `sequence_engine.message_states`).
        const result = await sql.query<{ id: string }>(
          `insert into public.message_versions
             (message_instance_id, content, generated_by_model, prompt_version_id, sequence_version_id, is_manual_edit, created_by)
           values ($1, $2, $3, null, null, true, null)
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
        return {
          message_version_id: versionId,
          is_manual_edit: true,
          words: validation.words,
          warnings: validation.violations.map((violation) => violation.code),
        };
      });
    },
  },

  'nexus.finish_agent_run': {
    scope: 'agent:run',
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
            // `agent_runs_state_check` (0009_integrations_audit.sql) permits only
            // running | succeeded | failed | cancelled. The previous default of 'completed' was not a
            // member, so every call that omitted `state` failed the check constraint — the tool could
            // not be used as documented. 'succeeded' is the terminal success state and the correct
            // meaning of "finish a run".
            stringArg(args, 'state') ?? 'succeeded',
            stringArg(args, 'summary'),
            JSON.stringify(args['result'] ?? {}),
            JSON.stringify(args['stats'] ?? {}),
          ],
        );
        return { agent_run_id: requireWrittenRow(result, businessId, 'business') };
      });
    },
  },

  /* --------------------------------------------------------- V1.2 jobs --- */

  'nexus.create_agent_job': {
    scope: 'jobs:create',
    run: async (credential, args, businessId) => {
      if (businessId === null) throw new Error('business_id is required');
      const jobType = stringArg(args, 'job_type');
      if (jobType === null) throw new Error('job_type is required');

      const capabilities = Array.isArray(args['required_capabilities'])
        ? (args['required_capabilities'] as unknown[]).filter(
            (value): value is string => typeof value === 'string',
          )
        : null;

      return withActor(credential.actor, async (sql) => {
        await assertBusinessAcceptsNewWork(sql, businessId);

        // The database decides deduplication, so two callers racing on the same
        // dedupe key cannot both create a job.
        const result = await sql.query<{ job_id: string; created: boolean }>(
          `select * from public.nexus_create_agent_job(
             $1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, $12
           )`,
          [
            businessId,
            jobType,
            stringArg(args, 'lead_id'),
            stringArg(args, 'person_id'),
            stringArg(args, 'company_id'),
            stringArg(args, 'priority') ?? 'normal',
            stringArg(args, 'instructions'),
            capabilities,
            credential.kind === 'service' ? 'api_client' : 'user',
            // `ServiceCredential` has no user id; a user credential carries one
            // directly, which is narrower than the actor union.
            credential.kind === 'service' ? null : credential.userId,
            stringArg(args, 'dedupe_key'),
            stringArg(args, 'reason'),
          ],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error('The job could not be created');
        return { job_id: row.job_id, created: row.created };
      });
    },
  },

  'nexus.list_agent_jobs': {
    scope: 'jobs:read',
    run: async (credential, args, businessId) => {
      if (businessId === null) throw new Error('business_id is required');
      const status = stringArg(args, 'status');
      const jobType = stringArg(args, 'job_type');
      const leadId = stringArg(args, 'lead_id');
      const limit = Math.min(numberArg(args, 'limit', 25), 100);
      const offset = numberArg(args, 'offset', 0);

      return withActor(credential.actor, async (sql) => {
        const rows = await sql.query(
          `select j.id, j.job_type, j.priority, j.status, j.lead_id, j.person_id, j.company_id,
                  j.instructions, j.required_capabilities, j.attempt_count, j.max_attempts,
                  j.claimed_by_agent, j.lease_expires_at, j.last_heartbeat_at, j.last_error_code,
                  j.dedupe_key, j.reason, j.created_at, j.updated_at, j.completed_at,
                  coalesce(p.full_name, c.name) as entity_label
             from public.agent_jobs j
             left join public.people p on p.id = j.person_id
             left join public.companies c on c.id = j.company_id
            where j.business_id = $1
              and ($2::text is null or j.status = $2)
              and ($3::text is null or j.job_type = $3)
              and ($4::uuid is null or j.lead_id = $4)
            order by case j.priority
                       when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3
                     end,
                     j.created_at desc
            limit $5 offset $6`,
          [businessId, status, jobType, leadId, limit, offset],
        );

        const total = await sql.query<{ n: number }>(
          `select count(*)::int as n from public.agent_jobs j
            where j.business_id = $1
              and ($2::text is null or j.status = $2)
              and ($3::text is null or j.job_type = $3)
              and ($4::uuid is null or j.lead_id = $4)`,
          [businessId, status, jobType, leadId],
        );

        return { jobs: rows.rows, total: Number(total.rows[0]?.n ?? 0) };
      });
    },
  },

  'nexus.get_agent_job': {
    scope: 'jobs:read',
    run: async (credential, args, businessId) => {
      if (businessId === null) throw new Error('business_id is required');
      const jobId = stringArg(args, 'job_id');
      if (jobId === null) throw new Error('job_id is required');

      return withActor(credential.actor, async (sql) => {
        const job = await sql.query(
          `select j.id, j.business_id, j.lead_id, j.person_id, j.company_id, j.job_type, j.priority,
                  j.status, j.instructions, j.required_capabilities, j.created_by_type, j.created_by_id,
                  j.claimed_by_agent, j.claimed_at, j.lease_expires_at, j.last_heartbeat_at,
                  j.attempt_count, j.max_attempts, j.last_error_code, j.dedupe_key, j.reason,
                  j.result_ai_run_id, j.created_at, j.updated_at, j.completed_at,
                  coalesce(p.full_name, c.name) as entity_label
             from public.agent_jobs j
             left join public.people p on p.id = j.person_id
             left join public.companies c on c.id = j.company_id
            where j.id = $1 and j.business_id = $2`,
          [jobId, businessId],
        );
        const row = job.rows[0];
        if (row === undefined) throw new Error('Unknown agent job');

        const events = await sql.query(
          `select event_type, actor_type, agent_name, note, payload, created_at
             from public.agent_job_events
            where job_id = $1
            order by created_at desc
            limit 50`,
          [jobId],
        );

        return { job: row, events: events.rows };
      });
    },
  },

  'nexus.claim_agent_job': {
    scope: 'jobs:claim',
    run: async (credential, args, businessId) => {
      if (businessId === null) throw new Error('business_id is required');
      const agent = stringArg(args, 'agent');
      if (agent === null) throw new Error('agent is required');

      const capabilities = Array.isArray(args['capabilities'])
        ? (args['capabilities'] as unknown[]).filter((value): value is string => typeof value === 'string')
        : [];

      return withActor(credential.actor, async (sql) => {
        // No result is a normal answer: an agent polling an empty queue must be able
        // to tell "nothing to do" from "the call failed".
        const result = await sql.query(
          `select * from public.nexus_claim_agent_job($1, $2, $3::text[], $4, $5)`,
          [businessId, agent, capabilities, stringArg(args, 'job_id'), numberArg(args, 'lease_seconds', 900)],
        );
        return { job: result.rows[0] ?? null };
      });
    },
  },

  'nexus.heartbeat_agent_job': {
    scope: 'jobs:claim',
    run: async (credential, args) => {
      const jobId = stringArg(args, 'job_id');
      const agent = stringArg(args, 'agent');
      if (jobId === null || agent === null) throw new Error('job_id and agent are required');

      return withActor(credential.actor, async (sql) => {
        const result = await sql.query(
          `select * from public.nexus_heartbeat_agent_job($1, $2, $3)`,
          [jobId, agent, numberArg(args, 'lease_seconds', 900)],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error('The lease on that job is not held by this agent');
        return row;
      });
    },
  },

  'nexus.release_agent_job': {
    scope: 'jobs:claim',
    run: async (credential, args) => {
      const jobId = stringArg(args, 'job_id');
      const agent = stringArg(args, 'agent');
      if (jobId === null || agent === null) throw new Error('job_id and agent are required');

      await withActor(credential.actor, async (sql) => {
        await sql.query(`select public.nexus_release_agent_job($1, $2, $3)`, [
          jobId,
          agent,
          stringArg(args, 'reason'),
        ]);
      });
      return { job_id: jobId, released: true };
    },
  },

  'nexus.fail_agent_job': {
    scope: 'jobs:submit',
    run: async (credential, args) => {
      const jobId = stringArg(args, 'job_id');
      const agent = stringArg(args, 'agent');
      const errorCode = stringArg(args, 'error_code');
      if (jobId === null || agent === null || errorCode === null) {
        throw new Error('job_id, agent and error_code are required');
      }

      return withActor(credential.actor, async (sql) => {
        const result = await sql.query<{ id: string; status: string; attempt_count: number }>(
          `select * from public.nexus_fail_agent_job($1, $2, $3, $4, $5)`,
          [jobId, agent, errorCode, stringArg(args, 'message'), args['retryable'] !== false],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error('Unknown agent job');
        return { job_id: row.id, status: row.status, attempt_count: row.attempt_count };
      });
    },
  },

  'nexus.submit_agent_job_result': {
    scope: 'jobs:submit',
    run: async (credential, args) => {
      const jobId = stringArg(args, 'job_id');
      const agent = stringArg(args, 'agent');
      const payload = stringArg(args, 'payload');
      if (jobId === null || agent === null || payload === null) {
        throw new Error('job_id, agent and payload are required');
      }

      // The hash is derived here, never taken from the caller: the stored hash must
      // describe the bytes that were actually staged.
      const hash = contentHash({ jobId, agent, payload });

      return withActor(credential.actor, async (sql) => {
        const result = await sql.query<{ job_id: string; status: string; raw_staging_id: string }>(
          `select * from public.nexus_submit_agent_job_result($1, $2, $3, $4, $5, $6, $7)`,
          [
            jobId,
            agent,
            payload,
            hash,
            stringArg(args, 'kind') ?? 'company_research',
            stringArg(args, 'source_type') ?? 'web',
            stringArg(args, 'source_url'),
          ],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error('Unknown agent job');
        // `WAITING_AI`, deliberately: submitting evidence is not completing a job.
        return { job_id: row.job_id, status: row.status, raw_staging_id: row.raw_staging_id };
      });
    },
  },

  'nexus.submit_company_research': {
    scope: 'jobs:submit',
    run: async (credential, args) => {
      const jobId = stringArg(args, 'job_id');
      const agent = stringArg(args, 'agent');
      const payload = stringArg(args, 'payload');
      if (jobId === null || agent === null || payload === null) {
        throw new Error('job_id, agent and payload are required');
      }

      // Discovery of the extraction pipeline is deferred: `lib/ai/extract` imports
      // the provider stack, and this transport must stay loadable on a deployment
      // with no AI key configured.
      const { commitCompanyResearch } = await import('@/lib/ai/extract');
      const { loadViewer } = await import('@/lib/actor');
      const viewer = await loadViewer(credential.actor);

      const outcome = await commitCompanyResearch(viewer, {
        jobId,
        agent,
        payload,
        sourceType: stringArg(args, 'source_type') ?? 'web',
        sourceUrl: stringArg(args, 'source_url'),
      });

      if (!outcome.ok) {
        // The raw body is still staged for a retry; the caller is told which code to
        // act on rather than being told the job succeeded.
        throw new Error(`${outcome.errorCode}: ${outcome.error}`);
      }

      return {
        job_id: jobId,
        company_id: outcome.companyId,
        signals: outcome.signals,
        raw_deleted: outcome.rawDeleted,
      };
    },
  },

  /* ------------------------------------------------ V1.2 lead intelligence - */

  'nexus.get_lead_enrichment_context': {
    scope: 'lead:read',
    run: async (credential, args, businessId) => {
      if (businessId === null) throw new Error('business_id is required');
      const leadId = stringArg(args, 'lead_id');
      if (leadId === null) throw new Error('lead_id is required');

      return withActor(credential.actor, async (sql) => {
        const lead = await sql.query<{
          id: string;
          business_id: string;
          person_id: string;
          company_id: string | null;
          status: string;
          source_type: string | null;
          source_url: string | null;
          needs_profile: boolean;
        }>(
          `select id, business_id, person_id, company_id, status, source_type, source_url, needs_profile
             from public.leads
            where id = $1 and business_id = $2 and deleted_at is null`,
          [leadId, businessId],
        );
        const row = lead.rows[0];
        if (row === undefined) throw new Error('Unknown lead');

        const facts = await sql.query<{
          full_name: string;
          job_title: string | null;
          headline: string | null;
          location: string | null;
          linkedin_url: string | null;
          company_name: string | null;
          company_domain: string | null;
          company_description: string | null;
          signal_count: number;
          contact_count: number;
          has_context_pack: boolean;
          has_company_research: boolean;
          enrichment_status: string | null;
          completeness_score: number | null;
          missing_fields: string[] | null;
        }>(
          `select p.full_name, p.job_title, p.headline, p.location, p.linkedin_url,
                  c.name as company_name, c.normalized_domain as company_domain,
                  c.description as company_description,
                  (select count(*)::int from public.signals s
                    where s.is_active and (s.lead_id = l.id or s.person_id = l.person_id
                          or s.company_id = l.company_id)) as signal_count,
                  (select count(*)::int from public.person_contact_points cp
                    where cp.person_id = l.person_id and cp.deleted_at is null) as contact_count,
                  exists (select 1 from public.ai_context_packs a where a.lead_id = l.id) as has_context_pack,
                  exists (select 1 from public.research_snapshots r where r.company_id = l.company_id) as has_company_research,
                  e.status as enrichment_status,
                  e.completeness_score,
                  e.missing_fields
             from public.leads l
             join public.people p on p.id = l.person_id
             left join public.companies c on c.id = l.company_id
             left join public.lead_enrichment e on e.lead_id = l.id
            where l.id = $1`,
          [leadId],
        );
        const f = facts.rows[0];
        if (f === undefined) throw new Error('Unknown lead');

        // The score is computed here, deterministically, from permanent facts.
        const completeness = intelligenceCompleteness({
          fullName: f.full_name,
          companyName: f.company_name,
          location: f.location,
          jobTitle: f.job_title,
          linkedinUrl: f.linkedin_url,
          companyWebsite: f.company_domain,
          companyResearch: f.has_company_research,
          signalCount: Number(f.signal_count ?? 0),
          hasAiContext: f.has_context_pack,
          contactCount: Number(f.contact_count ?? 0),
        });

        return {
          lead_id: leadId,
          enrichment: {
            status: f.enrichment_status ?? 'MINIMAL',
            completeness_score: completeness.score,
            missing_fields: completeness.missing,
            components: completeness.components,
            stored_score: f.completeness_score,
          },
          person: { full_name: f.full_name, job_title: f.job_title, headline: f.headline, location: f.location, linkedin_url: f.linkedin_url },
          company: { name: f.company_name, domain: f.company_domain, description: f.company_description },
          available_channels: OUTREACH_CHANNELS,
          // Zero-token, deterministic — the agent can hand these straight to a browser.
          search_links: searchLinks({
            fullName: f.full_name,
            companyName: f.company_name,
            location: f.location,
            companyDomain: f.company_domain,
            linkedinUrl: f.linkedin_url,
          }),
        };
      });
    },
  },

  'nexus.submit_minimal_lead': {
    scope: 'lead:create',
    run: async (credential, args, businessId, envelope) => {
      if (businessId === null) throw new Error('business_id is required');
      const idempotencyKey = envelope.idempotencyKey;
      if (idempotencyKey === undefined) throw new Error('idempotency_key is required for ingestion tools');

      const fullName = stringArg(args, 'full_name');
      if (fullName === null) throw new Error('full_name is required');

      // A minimal lead carries a name, a company and a source and nothing invented.
      // Everything else is absent on purpose and is filled later by enrichment.
      const discoverySource = normalizeDiscoverySource(stringArg(args, 'source'));
      const payload = {
        full_name: fullName,
        company_name: stringArg(args, 'company_name'),
        location: stringArg(args, 'location'),
        job_title: stringArg(args, 'job_title'),
        headline: stringArg(args, 'headline'),
        linkedin_url: stringArg(args, 'linkedin_url'),
        source_url: stringArg(args, 'source_url'),
        notes: stringArg(args, 'snippet'),
      };

      const outcome = await submitIngest(credential.actor, {
        sourceClient: 'mcp',
        businessId,
        payloadType: 'candidate',
        payload,
        idempotencyKey,
        observedAt: new Date().toISOString(),
        businessKeyOrId: businessId,
        // The *surface the person was found on* is provenance; the transport is not.
        discoverySource,
      });

      return {
        lead_id: outcome.leadId ?? null,
        person_id: outcome.personId ?? null,
        company_id: outcome.companyId ?? null,
        idempotent: outcome.idempotent,
        discovery_source: discoverySource,
        enrichment_status: 'NEEDS_PROFILE',
        // The caller is handed the deterministic searches immediately: finding the
        // profile is the next human step and it must not cost a model call.
        search_links: searchLinks({
          fullName,
          companyName: stringArg(args, 'company_name'),
          location: stringArg(args, 'location'),
          companyDomain: stringArg(args, 'company_domain'),
          linkedinUrl: stringArg(args, 'linkedin_url'),
        }),
      };
    },
  },

  'nexus.submit_profile_data': {
    scope: 'profile:capture',
    run: async (credential, args) => {
      const leadId = stringArg(args, 'lead_id');
      const linkedinUrl = stringArg(args, 'linkedin_url');
      const pastedContent = stringArg(args, 'pasted_content');
      if (leadId === null || linkedinUrl === null || pastedContent === null) {
        throw new Error('lead_id, linkedin_url and pasted_content are required');
      }

      const { enrichProfileFromPaste } = await import('@/lib/ai/extract');
      const { loadViewer } = await import('@/lib/actor');
      const viewer = await loadViewer(credential.actor);

      const outcome = await enrichProfileFromPaste(viewer, {
        leadId,
        linkedinUrl,
        pastedContent,
        sourceType: stringArg(args, 'source_type') ?? 'linkedin',
        sourceUrl: stringArg(args, 'source_url') ?? linkedinUrl,
      });

      if (!outcome.ok) {
        // The pasted body is deliberately absent from the answer and from the error.
        throw new Error(`${outcome.errorCode}: ${outcome.error}`);
      }

      return {
        lead_id: outcome.leadId,
        person_id: outcome.personId,
        company_id: outcome.companyId,
        applied: outcome.applied,
        review: outcome.review,
        raw_deleted: outcome.rawDeleted,
      };
    },
  },

  'nexus.submit_source_metadata': {
    scope: 'evidence:add',
    run: async (credential, args, businessId) => {
      if (businessId === null) throw new Error('business_id is required');
      const source = stringArg(args, 'source') ?? 'other';
      const summary = stringArg(args, 'summary');
      if (summary === null) throw new Error('summary is required');

      return withActor(credential.actor, async (sql) => {
        await assertBusinessAcceptsNewWork(sql, businessId);

        // Metadata and a structured summary only. A raw body is staged separately,
        // extracted, and deleted — storing it here would make it permanent by
        // accident, which is exactly what the V1.2 raw policy forbids.
        const metadata = {
          summary,
          collector_agent: stringArg(args, 'collector_agent'),
          observed_at: stringArg(args, 'observed_at'),
        };
        const hash =
          stringArg(args, 'content_hash') ??
          contentHash({ source, summary, observedAt: stringArg(args, 'observed_at') ?? '' });

        const result = await sql.query<{ id: string }>(
          `insert into public.source_evidence
             (business_id, person_id, company_id, lead_id, source, source_url, raw_text_or_json,
              content_hash, raw_content_hash, collector_agent, agent_job_id, observed_at, confidence,
              raw_deleted_at, extracted_at)
           values ($1, $2, $3, $4, $5, $6, $7::text, $8, $8, $9, $10,
                   coalesce($11::timestamptz, now()), $12, now(), now())
           on conflict (business_id, content_hash) do nothing
           returning id`,
          [
            businessId,
            stringArg(args, 'person_id'),
            stringArg(args, 'company_id'),
            stringArg(args, 'lead_id'),
            source,
            stringArg(args, 'source_url'),
            JSON.stringify(metadata),
            hash,
            stringArg(args, 'collector_agent'),
            stringArg(args, 'agent_job_id'),
            // When the observation happened is the caller's fact, not ours: a
            // research dump read an hour ago is an hour-old observation.
            stringArg(args, 'observed_at'),
            numberArg(args, 'confidence', 0.6),
          ],
        );

        return { evidence_id: result.rows[0]?.id ?? null, deduplicated: result.rows[0] === undefined };
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
