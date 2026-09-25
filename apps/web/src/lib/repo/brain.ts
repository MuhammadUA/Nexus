/**
 * Business Brain repository — offers, services, personas, value propositions and
 * the frozen `business_context_versions` snapshots.
 *
 * spec `business_brain_and_knowledge`:
 *   - "Outbound may use only approved factual claims. Never invent metrics/results."
 *     -> approval is the only gate this module exposes, and `aiEligible` is derived
 *        from it rather than stored a second time.
 *   - "Sent messages retain referenced asset versions. Dynamic unsent messages may
 *     use newest approved versions."
 *     -> `snapshotBusinessContext` freezes the Brain into `business_context_versions`.
 *
 * RLS is the authorization boundary: reads require `has_business_access(business_id)`
 * and writes require `is_admin()` (migration 0013, "Business Brain" block). A
 * non-admin therefore gets a privilege error rather than a silent no-op.
 */
import 'server-only';

import { withActor, type Actor, type Viewer } from '../actor';
import type { Db, Row } from '../sql';
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

/** The four Brain asset tables that carry an `approved` boolean (0003). */
export const BRAIN_ASSET_KINDS = ['offer', 'service', 'persona', 'value_proposition'] as const;
export type BrainAssetKind = (typeof BRAIN_ASSET_KINDS)[number];

/**
 * Fixed kind -> table map.
 *
 * The table name is never interpolated from caller text: the action validates the
 * kind against `BRAIN_ASSET_KINDS` and this record resolves it to a literal, so no
 * query can be redirected at another table.
 */
const ASSET_TABLE: Readonly<Record<BrainAssetKind, string>> = {
  offer: 'offers',
  service: 'services',
  persona: 'personas',
  value_proposition: 'value_propositions',
};

export const BRAIN_ASSET_LABELS: Readonly<Record<BrainAssetKind, string>> = {
  offer: 'Offer',
  service: 'Service',
  persona: 'Persona',
  value_proposition: 'Value proposition',
};

/* ------------------------------------------------------------------ offers -- */

export interface OfferRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly positioning: string | null;
  readonly ctaStyle: string | null;
  readonly approved: boolean;
  readonly version: number;
  /** Derived: only approved facts are eligible for AI drafting. */
  readonly aiEligible: boolean;
  readonly updatedAt: string | null;
}

export async function listOffers(actor: Actor, businessId: string): Promise<readonly OfferRow[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, name, description, positioning, cta_style, approved, version, updated_at
         from public.offers
        where business_id = $1 and deleted_at is null
        order by approved desc, name`,
      [businessId],
    );
    return result.rows.map((row: Row) => {
      const approved = asBoolean(row.approved);
      return {
        id: asString(row.id),
        name: asString(row.name),
        description: asStringOrNull(row.description),
        positioning: asStringOrNull(row.positioning),
        ctaStyle: asStringOrNull(row.cta_style),
        approved,
        version: asNumber(row.version, 1),
        aiEligible: approved,
        updatedAt: asIso(row.updated_at),
      };
    });
  });
}

/* ---------------------------------------------------------------- services -- */

export interface ServiceRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly approved: boolean;
  readonly aiEligible: boolean;
  readonly updatedAt: string | null;
}

export async function listServices(actor: Actor, businessId: string): Promise<readonly ServiceRow[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, name, description, category, approved, updated_at
         from public.services
        where business_id = $1 and deleted_at is null
        order by approved desc, name`,
      [businessId],
    );
    return result.rows.map((row: Row) => {
      const approved = asBoolean(row.approved);
      return {
        id: asString(row.id),
        name: asString(row.name),
        description: asStringOrNull(row.description),
        category: asStringOrNull(row.category),
        approved,
        aiEligible: approved,
        updatedAt: asIso(row.updated_at),
      };
    });
  });
}

/* ---------------------------------------------------------------- personas -- */

export interface PersonaRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly painPoints: readonly string[];
  readonly goals: readonly string[];
  readonly approved: boolean;
  readonly aiEligible: boolean;
  readonly updatedAt: string | null;
}

export async function listPersonas(actor: Actor, businessId: string): Promise<readonly PersonaRow[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, name, description, pain_points, goals, approved, updated_at
         from public.personas
        where business_id = $1 and deleted_at is null
        order by approved desc, name`,
      [businessId],
    );
    return result.rows.map((row: Row) => {
      const approved = asBoolean(row.approved);
      return {
        id: asString(row.id),
        name: asString(row.name),
        description: asStringOrNull(row.description),
        painPoints: asStringArray(row.pain_points),
        goals: asStringArray(row.goals),
        approved,
        aiEligible: approved,
        updatedAt: asIso(row.updated_at),
      };
    });
  });
}

/* ----------------------------------------------------- value propositions -- */

export interface ValuePropositionRow {
  readonly id: string;
  readonly personaId: string | null;
  readonly personaName: string | null;
  readonly icpId: string | null;
  readonly statement: string;
  readonly proofRequired: boolean;
  readonly approved: boolean;
  /**
   * spec `business_brain_and_knowledge.claim_policy` — a claim may only be used by
   * the model once it is approved. A proposition that still requires proof is
   * approved *and* has an approved knowledge asset behind it; until then it is not
   * eligible, which is why the two flags are shown separately.
   */
  readonly aiEligible: boolean;
  readonly updatedAt: string | null;
}

export async function listValuePropositions(
  actor: Actor,
  businessId: string,
): Promise<readonly ValuePropositionRow[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select v.id, v.persona_id, p.name as persona_name, v.icp_id, v.statement,
              v.proof_required, v.approved, v.updated_at,
              (select count(*) from public.knowledge_assets k
                where k.business_id = v.business_id
                  and k.deleted_at is null
                  and k.approval_state = 'approved'
                  and k.ai_use_allowed) as approved_proof_count
         from public.value_propositions v
         left join public.personas p on p.id = v.persona_id
        where v.business_id = $1 and v.deleted_at is null
        order by v.approved desc, v.statement`,
      [businessId],
    );
    return result.rows.map((row: Row) => {
      const approved = asBoolean(row.approved);
      const proofRequired = asBoolean(row.proof_required);
      const approvedProof = asNumber(row.approved_proof_count);
      return {
        id: asString(row.id),
        personaId: asStringOrNull(row.persona_id),
        personaName: asStringOrNull(row.persona_name),
        icpId: asStringOrNull(row.icp_id),
        statement: asString(row.statement),
        proofRequired,
        approved,
        aiEligible: approved && (proofRequired ? approvedProof > 0 : true),
        updatedAt: asIso(row.updated_at),
      };
    });
  });
}

/* ---------------------------------------------------------------- create --- */

export interface OfferInput {
  readonly businessId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly positioning?: string | null;
  readonly ctaStyle?: string | null;
}

export async function createOffer(viewer: Viewer, input: OfferInput): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ id: string }>(
        `insert into public.offers (business_id, name, description, positioning, cta_style, created_by)
         values ($1, $2, $3, $4, $5, $6)
         returning id`,
        [
          input.businessId,
          input.name,
          input.description ?? null,
          input.positioning ?? null,
          input.ctaStyle ?? null,
          viewer.userId,
        ],
      );
      const id = result.rows[0]?.id;
      await writeAudit(sql, viewer, input.businessId, 'offers', id ?? null, 'create_offer', {
        name: input.name,
      });
      return id === undefined ? { ok: false, error: 'The offer was not saved.' } : { ok: true, id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export interface ServiceInput {
  readonly businessId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly category?: string | null;
}

export async function createService(viewer: Viewer, input: ServiceInput): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ id: string }>(
        `insert into public.services (business_id, name, description, category, created_by)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [input.businessId, input.name, input.description ?? null, input.category ?? null, viewer.userId],
      );
      const id = result.rows[0]?.id;
      await writeAudit(sql, viewer, input.businessId, 'services', id ?? null, 'create_service', {
        name: input.name,
      });
      return id === undefined ? { ok: false, error: 'The service was not saved.' } : { ok: true, id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export interface PersonaInput {
  readonly businessId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly painPoints?: readonly string[];
  readonly goals?: readonly string[];
}

export async function createPersona(viewer: Viewer, input: PersonaInput): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ id: string }>(
        `insert into public.personas (business_id, name, description, pain_points, goals, created_by)
         values ($1, $2, $3, $4::text[], $5::text[], $6)
         returning id`,
        [
          input.businessId,
          input.name,
          input.description ?? null,
          [...(input.painPoints ?? [])],
          [...(input.goals ?? [])],
          viewer.userId,
        ],
      );
      const id = result.rows[0]?.id;
      await writeAudit(sql, viewer, input.businessId, 'personas', id ?? null, 'create_persona', {
        name: input.name,
      });
      return id === undefined ? { ok: false, error: 'The persona was not saved.' } : { ok: true, id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export interface ValuePropositionInput {
  readonly businessId: string;
  readonly statement: string;
  readonly personaId?: string | null;
  readonly proofRequired: boolean;
}

export async function createValueProposition(
  viewer: Viewer,
  input: ValuePropositionInput,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ id: string }>(
        `insert into public.value_propositions
           (business_id, persona_id, statement, proof_required, created_by)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [
          input.businessId,
          input.personaId ?? null,
          input.statement,
          input.proofRequired,
          viewer.userId,
        ],
      );
      const id = result.rows[0]?.id;
      await writeAudit(
        sql,
        viewer,
        input.businessId,
        'value_propositions',
        id ?? null,
        'create_value_proposition',
        { proof_required: input.proofRequired },
      );
      return id === undefined ? { ok: false, error: 'The value proposition was not saved.' } : { ok: true, id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/* --------------------------------------------------------------- approval -- */

/**
 * Approve or unapprove one Brain asset.
 *
 * spec `business_brain_and_knowledge.claim_policy`: approval is what makes a claim
 * usable outbound, so both transitions are audited — unapproving matters as much as
 * approving.
 */
export async function setBrainAssetApproval(
  viewer: Viewer,
  kind: BrainAssetKind,
  id: string,
  approved: boolean,
): Promise<MutationResult> {
  const table = ASSET_TABLE[kind];
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ id: string; business_id: string }>(
        `update public.${table}
            set approved = $2, updated_at = now()
          where id = $1 and deleted_at is null
          returning id, business_id`,
        [id, approved],
      );
      const row = result.rows[0];
      if (row === undefined) return { ok: false, error: `That ${BRAIN_ASSET_LABELS[kind].toLowerCase()} no longer exists.` };

      await writeAudit(sql, viewer, row.business_id, table, row.id, approved ? 'approve' : 'unapprove', {
        approved,
      });
      return { ok: true, id: row.id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/* ------------------------------------------------------------- versioning -- */

export interface ContextSnapshotCounts {
  readonly offers: number;
  readonly services: number;
  readonly personas: number;
  readonly valuePropositions: number;
  readonly aiEligible: number;
}

export interface BusinessContextVersionRow {
  readonly id: string;
  readonly version: number;
  readonly reason: string | null;
  readonly counts: ContextSnapshotCounts;
  readonly createdAt: string | null;
}

function mapCounts(value: unknown): ContextSnapshotCounts {
  const empty: ContextSnapshotCounts = {
    offers: 0,
    services: 0,
    personas: 0,
    valuePropositions: 0,
    aiEligible: 0,
  };
  if (typeof value !== 'object' || value === null) return empty;
  const counts = (value as { counts?: unknown }).counts;
  if (typeof counts !== 'object' || counts === null) return empty;
  const record = counts as Record<string, unknown>;
  return {
    offers: asNumber(record.offers),
    services: asNumber(record.services),
    personas: asNumber(record.personas),
    valuePropositions: asNumber(record.value_propositions),
    aiEligible: asNumber(record.ai_eligible),
  };
}

export async function listContextVersions(
  actor: Actor,
  businessId: string,
): Promise<readonly BusinessContextVersionRow[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, version, reason, snapshot, created_at
         from public.business_context_versions
        where business_id = $1
        order by version desc
        limit 50`,
      [businessId],
    );
    return result.rows.map((row: Row) => ({
      id: asString(row.id),
      version: asNumber(row.version, 1),
      reason: asStringOrNull(row.reason),
      counts: mapCounts(row.snapshot),
      createdAt: asIso(row.created_at),
    }));
  });
}

/**
 * Freeze the current Brain into a new `business_context_versions` row.
 *
 * The snapshot records every asset with its `approved` flag at the moment of the
 * freeze, which is what lets a sent message point back at the exact claims that
 * were live when it was drafted.
 */
export async function snapshotBusinessContext(
  viewer: Viewer,
  businessId: string,
  reason: string | null,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      // Sequential, not Promise.all: these share one transaction handle, and the
      // snapshot must be read from a single consistent point in time.
      const offers = await sql.query<Row>(
        `select id, name, approved, version from public.offers
          where business_id = $1 and deleted_at is null order by name`,
        [businessId],
      );
      const services = await sql.query<Row>(
        `select id, name, approved from public.services
          where business_id = $1 and deleted_at is null order by name`,
        [businessId],
      );
      const personas = await sql.query<Row>(
        `select id, name, approved from public.personas
          where business_id = $1 and deleted_at is null order by name`,
        [businessId],
      );
      const valuePropositions = await sql.query<Row>(
        `select id, statement, approved, proof_required from public.value_propositions
          where business_id = $1 and deleted_at is null order by id`,
        [businessId],
      );

      const approved = (rows: readonly Row[]): number =>
        rows.filter((row) => row.approved === true).length;

      const counts = {
        offers: offers.rows.length,
        services: services.rows.length,
        personas: personas.rows.length,
        value_propositions: valuePropositions.rows.length,
        ai_eligible:
          approved(offers.rows) +
          approved(services.rows) +
          approved(personas.rows) +
          approved(valuePropositions.rows),
      };

      const snapshot = {
        frozen_at: new Date().toISOString(),
        counts,
        offers: offers.rows.map((row) => ({
          id: row.id,
          name: row.name,
          approved: row.approved === true,
          version: row.version,
        })),
        services: services.rows.map((row) => ({
          id: row.id,
          name: row.name,
          approved: row.approved === true,
        })),
        personas: personas.rows.map((row) => ({
          id: row.id,
          name: row.name,
          approved: row.approved === true,
        })),
        value_propositions: valuePropositions.rows.map((row) => ({
          id: row.id,
          statement: row.statement,
          approved: row.approved === true,
          proof_required: row.proof_required === true,
        })),
      };

      const nextVersion = await sql.query<Row>(
        `select coalesce(max(version), 0) + 1 as next_version
           from public.business_context_versions
          where business_id = $1`,
        [businessId],
      );

      const result = await sql.query<{ id: string; version: number }>(
        `insert into public.business_context_versions (business_id, version, snapshot, reason, created_by)
         values ($1, $2, $3::jsonb, $4, $5)
         returning id, version`,
        [
          businessId,
          asNumber(nextVersion.rows[0]?.next_version, 1),
          JSON.stringify(snapshot),
          reason,
          viewer.userId,
        ],
      );

      const row = result.rows[0];
      if (row === undefined) return { ok: false, error: 'The context version was not saved.' };

      await writeAudit(sql, viewer, businessId, 'business_context_versions', row.id, 'snapshot_context', {
        version: row.version,
      });
      return { ok: true, id: row.id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/* ------------------------------------------------------------------ audit -- */

/**
 * Append-only audit row. Kept local so this repository never has to reach into a
 * mutable shared helper; `audit_events` has no UPDATE or DELETE policy for anyone.
 */
async function writeAudit(
  sql: Db,
  viewer: Viewer,
  businessId: string,
  entityType: string,
  entityId: string | null,
  action: string,
  after: Record<string, unknown>,
): Promise<void> {
  await sql.query(
    `insert into public.audit_events
       (actor_type, actor_id, business_id, entity_type, entity_id, action, after_json, source_client)
     values ('user', $1, $2, $3, $4, $5, $6::jsonb, 'web')`,
    [viewer.userId, businessId, entityType, entityId, action, JSON.stringify(after)],
  );
}
