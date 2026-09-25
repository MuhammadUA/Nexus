/**
 * ICP configuration and scoring rules (screen A12).
 *
 * spec `screen_inventory` A12: "Company types, markets, buyers, signals, scoring,
 * exclusions, primary ICP rule, default sequence, routing."
 *
 * Design notes tied to the spec:
 *   - `criteria`, `scoring_overrides` and `routing` are jsonb columns. They are read
 *     into typed shapes and written back as JSON *here*, so no screen ever edits raw
 *     JSON with a textarea.
 *   - spec `signals_and_scoring.rule`: "Scores are configuration, not hard-coded
 *     product constants." Points therefore live in `scoring_rules` rows, and the
 *     per-ICP `scoring_overrides` are only a delta on top of them.
 *   - Spec `lead_invariants` puts the Primary-ICP rules on the *lead* (one active
 *     primary per lead, secondary matches never duplicate a lead, changing it is an
 *     audited state change). Those are enforced by `0010_constraints_and_indexes.sql`
 *     and `public.set_primary_icp`; this repository only owns the configuration side.
 */
import 'server-only';

import {
  SCORING_RULE_TARGETS,
  SIGNAL_KINDS,
  type ScoringRuleTarget,
  type SignalKind,
  type SignalPolarity,
} from '@nexus/core';

import { withActor, type Actor, type Viewer } from '../actor';
import { ICP_PRIORITIES } from '../icp-view';
import type {
  Icp,
  IcpCriteria,
  IcpPriority,
  IcpRouting,
  IcpScoringOverrides,
  ScoringRule,
} from '../icp-view';
import type { Db, Row } from '../sql';
import {
  asBoolean,
  asIso,
  asNumber,
  asNumberOrNull,
  asString,
  asStringArray,
  asStringOrNull,
  describeDbError,
  read,
  type MutationResult,
} from './common';

// The shapes are shared with the client components through `lib/icp-view.ts`; they are
// re-exported here so server code can keep importing them alongside the repository.
export type { Icp, IcpCriteria, IcpPriority, IcpRouting, IcpScoringOverrides, ScoringRule };
export { ICP_PRIORITIES } from '../icp-view';

/* ------------------------------------------------------------ coercion --- */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isSignalKind(value: string): value is SignalKind {
  return (SIGNAL_KINDS as readonly string[]).includes(value);
}

function isPriority(value: string): value is IcpPriority {
  return (ICP_PRIORITIES as readonly string[]).includes(value);
}

function isTargetType(value: string): value is ScoringRuleTarget {
  return (SCORING_RULE_TARGETS as readonly string[]).includes(value);
}

function readCriteria(value: unknown): IcpCriteria {
  const record = asRecord(value);
  return {
    companyTypes: asStringArray(record.company_types),
    markets: asStringArray(record.markets),
    companySizeMin: asNumberOrNull(record.company_size_min),
    companySizeMax: asNumberOrNull(record.company_size_max),
    buyerTitles: asStringArray(record.buyer_titles),
    requiredSignals: asStringArray(record.required_signals).filter(isSignalKind),
    exclusions: asStringArray(record.exclusions),
    notes: asStringOrNull(record.notes),
  };
}

function readScoringOverrides(value: unknown): IcpScoringOverrides {
  const record = asRecord(value);
  const rawWeights = asRecord(record.weights);
  const weights: Record<string, number> = {};
  // Only the signal vocabulary in `scoring_rules_signal_kind_check` is retained, so
  // a stale key in an old jsonb row can never leak into a prompt or a score.
  for (const kind of SIGNAL_KINDS) {
    const points = asNumberOrNull(rawWeights[kind]);
    if (points !== null) weights[kind] = points;
  }
  return { weights, minScore: asNumberOrNull(record.min_score) };
}

function readRouting(value: unknown): IcpRouting {
  const record = asRecord(value);
  const priority = asString(record.priority, 'normal');
  return {
    ownerUserId: asStringOrNull(record.owner_user_id),
    outreachIdentityId: asStringOrNull(record.outreach_identity_id),
    priority: isPriority(priority) ? priority : 'normal',
    autoEnroll: asBoolean(record.auto_enroll),
  };
}

function serializeCriteria(criteria: IcpCriteria): string {
  return JSON.stringify({
    company_types: [...(criteria.companyTypes ?? [])],
    markets: [...(criteria.markets ?? [])],
    company_size_min: criteria.companySizeMin ?? null,
    company_size_max: criteria.companySizeMax ?? null,
    buyer_titles: [...(criteria.buyerTitles ?? [])],
    required_signals: [...(criteria.requiredSignals ?? [])],
    exclusions: [...(criteria.exclusions ?? [])],
    notes: criteria.notes,
  });
}

function serializeScoringOverrides(overrides: IcpScoringOverrides): string {
  const weights: Record<string, number> = {};
  for (const kind of SIGNAL_KINDS) {
    const points = overrides.weights[kind];
    if (typeof points === 'number' && Number.isFinite(points)) weights[kind] = Math.trunc(points);
  }
  return JSON.stringify({ weights, min_score: overrides.minScore });
}

function serializeRouting(routing: IcpRouting): string {
  return JSON.stringify({
    owner_user_id: routing.ownerUserId,
    outreach_identity_id: routing.outreachIdentityId,
    priority: routing.priority,
    auto_enroll: routing.autoEnroll,
  });
}

function mapIcp(row: Row): Icp {
  return {
    id: asString(row.id),
    businessId: asString(row.business_id),
    name: asString(row.name),
    description: asStringOrNull(row.description),
    criteria: readCriteria(row.criteria),
    isDefault: asBoolean(row.is_default),
    isActive: asBoolean(row.is_active),
    scoringOverrides: readScoringOverrides(row.scoring_overrides),
    defaultSequenceId: asStringOrNull(row.default_sequence_id),
    defaultSequenceName: asStringOrNull(row.default_sequence_name),
    routing: readRouting(row.routing),
    primaryLeadCount: asNumber(row.primary_lead_count),
    secondaryMatchCount: asNumber(row.secondary_match_count),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

function mapScoringRule(row: Row): ScoringRule {
  const targetType = asString(row.target_type, 'global');
  const targetLabel = asStringOrNull(row.target_label);
  return {
    id: asString(row.id),
    targetType: isTargetType(targetType) ? targetType : 'global',
    targetId: asStringOrNull(row.target_id),
    targetLabel: targetLabel ?? (targetType === 'global' ? 'All businesses' : 'Unassigned'),
    signalKind: asString(row.signal_kind),
    polarity: asString(row.polarity, 'neutral'),
    points: asNumber(row.points),
    label: asStringOrNull(row.label),
    isActive: asBoolean(row.is_active),
  };
}

/**
 * The lead counts next to each ICP are the rows this viewer can actually see: the
 * `leads` select policy applies inside the subqueries exactly as it does anywhere
 * else, so a scoped operator never sees a business-wide number they cannot open.
 */
const ICP_SELECT = `
  select i.id, i.business_id, i.name, i.description, i.criteria, i.is_default,
         i.is_active, i.scoring_overrides, i.default_sequence_id, i.routing,
         i.created_at, i.updated_at,
         s.name as default_sequence_name,
         (select count(*) from public.leads l
           where l.primary_icp_id = i.id and l.deleted_at is null) as primary_lead_count,
         (select count(*) from public.lead_icp_matches m
            join public.leads l2 on l2.id = m.lead_id and l2.deleted_at is null
           where m.icp_id = i.id and not m.is_primary) as secondary_match_count
    from public.icps i
    left join public.sequences s on s.id = i.default_sequence_id
`;

/* ----------------------------------------------------------------- reads -- */

export async function listIcps(actor: Actor, businessId: string): Promise<readonly Icp[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `${ICP_SELECT}
        where i.business_id = $1 and i.deleted_at is null
        order by i.is_default desc, i.is_active desc, i.name`,
      [businessId],
    );
    return result.rows.map(mapIcp);
  });
}

export async function getIcp(actor: Actor, icpId: string): Promise<Icp | null> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(`${ICP_SELECT} where i.id = $1 and i.deleted_at is null`, [
      icpId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : mapIcp(row);
  });
}

/**
 * Every scoring rule that can affect this business: the global defaults, the
 * business-scoped rows, and the rows scoped to one of its ICPs.
 */
export async function listScoringRules(
  actor: Actor,
  businessId: string,
): Promise<readonly ScoringRule[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select r.id, r.target_type, r.target_id, r.signal_kind, r.polarity, r.points,
              r.label, r.is_active,
              coalesce(i.name, b.name) as target_label
         from public.scoring_rules r
         left join public.icps i on r.target_type = 'icp' and i.id = r.target_id
         left join public.businesses b on r.target_type = 'business' and b.id = r.target_id
        where r.target_type = 'global'
           or (r.target_type = 'business' and r.target_id = $1)
           or (r.target_type = 'icp' and i.business_id = $1 and i.deleted_at is null)
        order by r.target_type, target_label nulls first, r.signal_kind, r.polarity`,
      [businessId],
    );
    return result.rows.map(mapScoringRule);
  });
}

export async function getScoringRule(actor: Actor, ruleId: string): Promise<ScoringRule | null> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select r.id, r.target_type, r.target_id, r.signal_kind, r.polarity, r.points,
              r.label, r.is_active,
              coalesce(i.name, b.name) as target_label
         from public.scoring_rules r
         left join public.icps i on r.target_type = 'icp' and i.id = r.target_id
         left join public.businesses b on r.target_type = 'business' and b.id = r.target_id
        where r.id = $1`,
      [ruleId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapScoringRule(row);
  });
}

/* ------------------------------------------------------------- mutations -- */

export interface IcpInput {
  readonly name: string;
  readonly description: string | null;
  readonly criteria: IcpCriteria;
  readonly isDefault: boolean;
  readonly isActive: boolean;
  readonly scoringOverrides: IcpScoringOverrides;
  readonly defaultSequenceId: string | null;
  readonly routing: IcpRouting;
}

/** One default ICP per business is a partial unique index, so it is cleared first. */
async function clearDefaultIcp(sql: Db, businessId: string, exceptId: string | null): Promise<void> {
  await sql.query(
    `update public.icps set is_default = false, updated_at = now()
      where business_id = $1 and is_default and deleted_at is null
        and ($2::uuid is null or id <> $2::uuid)`,
    [businessId, exceptId],
  );
}

/**
 * A cross-business reference would be a configuration leak: scoring and routing are
 * resolved through the business, so the referenced row must belong to it. The reason is
 * returned rather than thrown, because `describeDbError` only understands driver errors.
 */
async function sequenceReferenceError(
  sql: Db,
  businessId: string,
  sequenceId: string | null,
): Promise<string | null> {
  if (sequenceId === null) return null;
  const found = await sql.query<Row>(
    `select id from public.sequences
      where id = $1 and business_id = $2 and deleted_at is null`,
    [sequenceId, businessId],
  );
  return found.rows[0] === undefined
    ? 'That default sequence does not belong to this business.'
    : null;
}

export async function createIcp(
  viewer: Viewer,
  businessId: string,
  input: IcpInput,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const invalid = await sequenceReferenceError(sql, businessId, input.defaultSequenceId);
      if (invalid !== null) return { ok: false, error: invalid };
      if (input.isDefault) await clearDefaultIcp(sql, businessId, null);
      const created = await sql.query<{ id: string }>(
        `insert into public.icps
           (business_id, name, description, criteria, is_default, is_active,
            scoring_overrides, default_sequence_id, routing, created_by)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, $9::jsonb, $10)
         returning id`,
        [
          businessId,
          input.name,
          input.description,
          serializeCriteria(input.criteria),
          input.isDefault,
          input.isActive,
          serializeScoringOverrides(input.scoringOverrides),
          input.defaultSequenceId,
          serializeRouting(input.routing),
          viewer.userId,
        ],
      );
      const id = created.rows[0]?.id;
      if (id === undefined) return { ok: false, error: 'The ICP was not created.' };
      return { ok: true, id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export async function updateIcp(
  viewer: Viewer,
  icpId: string,
  businessId: string,
  input: IcpInput,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const invalid = await sequenceReferenceError(sql, businessId, input.defaultSequenceId);
      if (invalid !== null) return { ok: false, error: invalid };
      if (input.isDefault) await clearDefaultIcp(sql, businessId, icpId);
      const result = await sql.query(
        `update public.icps
            set name = $3,
                description = $4,
                criteria = $5::jsonb,
                is_default = $6,
                is_active = $7,
                scoring_overrides = $8::jsonb,
                default_sequence_id = $9,
                routing = $10::jsonb,
                updated_at = now()
          where id = $1 and business_id = $2 and deleted_at is null`,
        [
          icpId,
          businessId,
          input.name,
          input.description,
          serializeCriteria(input.criteria),
          input.isDefault,
          input.isActive,
          serializeScoringOverrides(input.scoringOverrides),
          input.defaultSequenceId,
          serializeRouting(input.routing),
        ],
      );
      if (result.affectedRows === 0) return { ok: false, error: 'That ICP no longer exists.' };
      return { ok: true, id: icpId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/**
 * Soft delete. `deleted_at` also drops the row out of the one-default partial unique
 * index, and leads keep their recorded Primary ICP for history rather than having the
 * reference silently rewritten.
 */
export async function deleteIcp(viewer: Viewer, icpId: string): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query(
        `update public.icps
            set deleted_at = now(), is_default = false, is_active = false, updated_at = now()
          where id = $1 and deleted_at is null`,
        [icpId],
      );
      if (result.affectedRows === 0) return { ok: false, error: 'That ICP no longer exists.' };
      return { ok: true, id: icpId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export interface ScoringRuleInput {
  readonly businessId: string;
  readonly targetType: ScoringRuleTarget;
  readonly targetId: string | null;
  readonly signalKind: string;
  readonly polarity: SignalPolarity;
  readonly points: number | null | undefined;
  readonly label: string | null | undefined;
  readonly isActive: boolean;
}

/** An ICP-scoped rule whose ICP lives elsewhere would score another business's leads. */
async function targetReferenceError(
  sql: Db,
  businessId: string,
  targetType: ScoringRuleTarget,
  targetId: string | null,
): Promise<string | null> {
  if (targetType !== 'icp' || targetId === null) return null;
  const found = await sql.query<Row>(
    `select id from public.icps
      where id = $1 and business_id = $2 and deleted_at is null`,
    [targetId, businessId],
  );
  return found.rows[0] === undefined ? 'That ICP does not belong to this business.' : null;
}

export async function createScoringRule(
  viewer: Viewer,
  input: ScoringRuleInput,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const invalid = await targetReferenceError(
        sql,
        input.businessId,
        input.targetType,
        input.targetId,
      );
      if (invalid !== null) return { ok: false, error: invalid };
      const created = await sql.query<{ id: string }>(
        `insert into public.scoring_rules
           (target_type, target_id, signal_kind, polarity, points, label, is_active, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning id`,
        [
          input.targetType,
          input.targetType === 'global' ? null : input.targetId,
          input.signalKind,
          input.polarity,
          input.points,
          input.label,
          input.isActive,
          viewer.userId,
        ],
      );
      const id = created.rows[0]?.id;
      if (id === undefined) return { ok: false, error: 'The scoring rule was not created.' };
      return { ok: true, id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export async function updateScoringRule(
  viewer: Viewer,
  ruleId: string,
  input: ScoringRuleInput,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const invalid = await targetReferenceError(
        sql,
        input.businessId,
        input.targetType,
        input.targetId,
      );
      if (invalid !== null) return { ok: false, error: invalid };
      const result = await sql.query(
        `update public.scoring_rules
            set target_type = $2,
                target_id = $3,
                signal_kind = $4,
                polarity = $5,
                points = $6,
                label = $7,
                is_active = $8,
                updated_at = now()
          where id = $1`,
        [
          ruleId,
          input.targetType,
          input.targetType === 'global' ? null : input.targetId,
          input.signalKind,
          input.polarity,
          input.points,
          input.label,
          input.isActive,
        ],
      );
      if (result.affectedRows === 0) {
        return { ok: false, error: 'That scoring rule no longer exists.' };
      }
      return { ok: true, id: ruleId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export async function deleteScoringRule(viewer: Viewer, ruleId: string): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query(`delete from public.scoring_rules where id = $1`, [ruleId]);
      if (result.affectedRows === 0) {
        return { ok: false, error: 'That scoring rule no longer exists.' };
      }
      return { ok: true, id: ruleId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}
