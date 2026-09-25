/**
 * Integrations, automation and audit-trail data access.
 *
 * spec `integrations.architecture`: "NEXUS is the system of record. External
 * agents/tools call a narrow authenticated gateway." This module manages the
 * *credentials and mappings* for that gateway — never the data those callers touch.
 *
 * Two rules are enforced here rather than in the UI:
 *   - A service token is shown to an operator exactly once, at creation. Only its
 *     SHA-256 hash is stored, so a later reader cannot recover it.
 *   - A service token's scopes and business allow-list are always visible alongside
 *     it, because "what could this token do" must be answerable at a glance.
 */
import 'server-only';

import { API_SCOPES, MCP_TOOL_SCOPES, MCP_TOOLS } from '@nexus/core';

import { withActor, type Actor, type Viewer } from '../actor';
import type { Row } from '../sql';
import {
  asBoolean,
  asIso,
  asNumber,
  asString,
  asStringArray,
  asStringOrNull,
  describeDbError,
  read,
  type MutationResult,
} from './common';

export interface ApiClientRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly tokenPrefix: string;
  readonly scopes: readonly string[];
  readonly businessIds: readonly string[];
  readonly isActive: boolean;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string | null;
}

export interface WebhookRow {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly isActive: boolean;
  readonly lastStatus: string | null;
  readonly lastDeliveryAt: string | null;
}

export interface AutomationRow {
  readonly id: string;
  readonly name: string;
  readonly runner: string;
  readonly purpose: string | null;
  readonly runMode: string | null;
  readonly schedule: string | null;
  readonly sourceType: string | null;
  readonly icpId: string | null;
  readonly isActive: boolean;
  readonly lastRunAt: string | null;
}

export interface AgentRunRow {
  readonly id: string;
  readonly agentName: string;
  readonly objective: string | null;
  readonly state: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly summary: string | null;
  readonly error: string | null;
}

export interface AuditRow {
  readonly id: string;
  readonly at: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly sourceClient: string | null;
}

export async function listApiClients(actor: Actor): Promise<readonly ApiClientRow[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, name, kind, token_prefix, scopes, business_ids, is_active,
              last_used_at, expires_at, revoked_at, created_at
         from public.api_clients
        order by created_at desc`,
    );
    return result.rows.map((row: Row) => ({
      id: asString(row.id),
      name: asString(row.name),
      kind: asString(row.kind, 'rest_ingest'),
      // Only the prefix is ever displayed; the token itself is unrecoverable.
      tokenPrefix: asString(row.token_prefix),
      scopes: asStringArray(row.scopes),
      businessIds: asStringArray(row.business_ids),
      isActive: asBoolean(row.is_active),
      lastUsedAt: asIso(row.last_used_at),
      expiresAt: asIso(row.expires_at),
      revokedAt: asIso(row.revoked_at),
      createdAt: asIso(row.created_at),
    }));
  });
}

export interface CreateApiClientInput {
  readonly name: string;
  readonly kind: 'mcp' | 'rest_ingest' | 'webhook' | 'internal_worker';
  readonly scopes: readonly string[];
  readonly businessIds: readonly string[];
  readonly expiresInDays?: number | null;
}

/**
 * Issues a service token.
 *
 * Returns the RAW token exactly once — it is not stored and cannot be retrieved
 * again, which is why the UI must show it immediately and require the operator to
 * copy it.
 */
export async function createApiClient(
  viewer: Viewer,
  input: CreateApiClientInput,
  token: { readonly hash: string; readonly prefix: string },
): Promise<MutationResult & { readonly rawTokenRevealed?: boolean }> {
  const validScopes = input.scopes.filter((scope) => (API_SCOPES as readonly string[]).includes(scope));
  if (validScopes.length === 0) {
    return { ok: false, error: 'Choose at least one scope. A token with no scopes can do nothing.' };
  }

  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ id: string }>(
        `insert into public.api_clients
           (name, kind, token_hash, token_prefix, scopes, business_ids, is_active, expires_at, created_by)
         values ($1, $2, $3, $4, $5::text[], $6::uuid[], true,
                 case when $7::int is null then null else now() + make_interval(days => $7::int) end,
                 $8)
         returning id`,
        [
          input.name,
          input.kind,
          token.hash,
          token.prefix,
          [...validScopes],
          [...input.businessIds],
          input.expiresInDays,
          viewer.userId,
        ],
      );
      const id = result.rows[0]?.id;
      return id === undefined
        ? { ok: false, error: 'The token was not created.' }
        : { ok: true, id, rawTokenRevealed: true };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export async function revokeApiClient(viewer: Viewer, id: string): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query(
        `update public.api_clients
            set is_active = false, revoked_at = now()
          where id = $1 and revoked_at is null`,
        [id],
      );
      return result.affectedRows === 0
        ? { ok: false, error: 'That token is already revoked.' }
        : { ok: true, id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export async function listWebhooks(actor: Actor): Promise<readonly WebhookRow[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, name, url, events, is_active, last_status, last_delivery_at
         from public.webhook_endpoints
        order by created_at desc`,
    );
    return result.rows.map((row: Row) => ({
      id: asString(row.id),
      name: asString(row.name),
      url: asString(row.url),
      events: asStringArray(row.events),
      isActive: asBoolean(row.is_active),
      lastStatus: asStringOrNull(row.last_status),
      lastDeliveryAt: asIso(row.last_delivery_at),
    }));
  });
}

export async function listAutomations(actor: Actor, businessId?: string): Promise<readonly AutomationRow[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, name, runner, purpose, run_mode, schedule, source_type, icp_id, is_active, last_run_at
         from public.automation_configs
        where ($1::uuid is null or business_id = $1)
        order by name`,
      [businessId ?? null],
    );
    return result.rows.map((row: Row) => ({
      id: asString(row.id),
      name: asString(row.name),
      runner: asString(row.runner, 'other'),
      purpose: asStringOrNull(row.purpose),
      runMode: asStringOrNull(row.run_mode),
      schedule: asStringOrNull(row.schedule),
      sourceType: asStringOrNull(row.source_type),
      icpId: asStringOrNull(row.icp_id),
      isActive: asBoolean(row.is_active),
      lastRunAt: asIso(row.last_run_at),
    }));
  });
}

export interface AutomationInput {
  readonly businessId: string;
  readonly name: string;
  readonly runner: 'browseros' | 'opencode' | 'n8n' | 'other';
  readonly purpose: string | null;
  readonly runMode: string | null;
  readonly schedule: string | null;
  readonly sourceType: string | null;
  readonly icpId: string | null;
}

export async function upsertAutomation(viewer: Viewer, input: AutomationInput): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ id: string }>(
        `insert into public.automation_configs
           (business_id, name, runner, purpose, run_mode, schedule, source_type, icp_id, is_active, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)
         returning id`,
        [
          input.businessId,
          input.name,
          input.runner,
          input.purpose,
          input.runMode,
          input.schedule,
          input.sourceType,
          input.icpId,
          viewer.userId,
        ],
      );
      const id = result.rows[0]?.id;
      return id === undefined ? { ok: false, error: 'The automation was not saved.' } : { ok: true, id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export async function listAgentRuns(actor: Actor, businessId?: string, limit = 25): Promise<readonly AgentRunRow[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, agent_name, objective, state, started_at, finished_at, summary, error
         from public.agent_runs
        where ($1::uuid is null or business_id = $1)
        order by started_at desc nulls last
        limit $2`,
      [businessId ?? null, limit],
    );
    return result.rows.map((row: Row) => ({
      id: asString(row.id),
      agentName: asString(row.agent_name),
      objective: asStringOrNull(row.objective),
      state: asString(row.state, 'unknown'),
      startedAt: asIso(row.started_at),
      finishedAt: asIso(row.finished_at),
      summary: asStringOrNull(row.summary),
      error: asStringOrNull(row.error),
    }));
  });
}

export async function listAuditEvents(
  actor: Actor,
  businessId?: string,
  limit = 50,
): Promise<readonly AuditRow[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, created_at, action, entity_type, entity_id, actor_type, actor_id, source_client
         from public.audit_events
        where ($1::uuid is null or business_id = $1)
        order by created_at desc
        limit $2`,
      [businessId ?? null, limit],
    );
    return result.rows.map((row: Row) => ({
      id: asString(row.id),
      at: asIso(row.created_at),
      action: asString(row.action),
      entityType: asString(row.entity_type),
      entityId: asStringOrNull(row.entity_id),
      actorType: asString(row.actor_type, 'system'),
      actorId: asStringOrNull(row.actor_id),
      sourceClient: asStringOrNull(row.source_client),
    }));
  });
}

/** Job health: how many agent runs finished, failed or are still going. */
export interface JobHealth {
  readonly pending: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly lastFailureAt: string | null;
}

export async function getJobHealth(actor: Actor, businessId: string): Promise<JobHealth> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select
         count(*) filter (where state in ('queued', 'pending')) as pending,
         count(*) filter (where state = 'running') as running,
         count(*) filter (where state in ('completed', 'succeeded')) as completed,
         count(*) filter (where state in ('failed', 'error')) as failed,
         max(finished_at) filter (where state in ('failed', 'error')) as last_failure_at
       from public.agent_runs
       where business_id = $1`,
      [businessId],
    );
    const row = result.rows[0];
    return {
      pending: asNumber(row?.pending),
      running: asNumber(row?.running),
      completed: asNumber(row?.completed),
      failed: asNumber(row?.failed),
      lastFailureAt: asIso(row?.last_failure_at),
    };
  });
}

/**
 * The tool catalogue exposed to operators.
 *
 * Built from `MCP_TOOLS` so the documented surface is the implemented surface: a tool
 * cannot exist in the gateway without being listed here, and `database.execute_sql`
 * appears nowhere because it is not in `MCP_TOOLS`.
 */
export interface ToolDoc {
  readonly name: string;
  readonly scope: string;
}

export function mcpToolCatalogue(): readonly ToolDoc[] {
  return MCP_TOOLS.map((name) => ({
    name,
    scope: MCP_TOOL_SCOPES[name] ?? 'ingest:write',
  }));
}

export { API_SCOPES, MCP_TOOLS };
