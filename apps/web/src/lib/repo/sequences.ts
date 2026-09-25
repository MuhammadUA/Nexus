/**
 * Sequence configuration (screen A13).
 *
 * spec `screen_inventory` A13: "Message 1 + FU1 + FU2 + FU3; delays, generation
 * rules, lifecycle, publishing/version behavior, dormant/reactivation."
 *
 * Design notes tied to the spec:
 *   - The default cadence is `DEFAULT_SEQUENCE_STEPS` from `@nexus/core`
 *     (`sequence_engine.default_steps`); the business-configurable delays come from
 *     the `sequence.default_followup_delays_days` platform setting.
 *   - spec `sequence_engine.publish_behavior`: publishing is not a column update. It
 *     goes through `public.publish_sequence_version`, which freezes SENT content,
 *     leaves LOCKED untouched, invalidates eligible DYNAMIC unsent instances and
 *     stores the preview it actually applied. This module only previews and calls it.
 *   - Published versions are immutable, so a step edit is refused unless the version
 *     is still `draft`; changing a live sequence means creating a new draft version.
 */
import 'server-only';

import {
  DEFAULT_REACTIVATION_COOLDOWN_DAYS,
  DEFAULT_SEQUENCE_STEPS,
  type DelayBasis,
  type MessageInstance,
  type SequenceStepKind,
} from '@nexus/core';

import { withActor, type Actor, type Viewer } from '../actor';
import type {
  GenerationMode,
  ProofPolicy,
  SequenceStatus,
  SequenceStep,
  SequenceSummary,
  SequenceVersion,
  StoredImpactPreview,
} from '../sequence-view';
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

// The shapes are shared with the client components through `lib/sequence-view.ts`.
export type {
  GenerationMode,
  ProofPolicy,
  SequenceStatus,
  SequenceStep,
  SequenceSummary,
  SequenceVersion,
  SequenceVersionStatus,
  StoredImpactPreview,
} from '../sequence-view';
export {
  GENERATION_MODES,
  PROOF_POLICIES,
  SEQUENCE_STATUSES,
  SEQUENCE_VERSION_STATUSES,
} from '../sequence-view';

/* ------------------------------------------------------------ coercion --- */

export interface Option {
  readonly value: string;
  readonly label: string;
}

const DELAY_BASIS_VALUES: readonly string[] = [
  'immediate',
  'after_previous',
  'after_enrollment',
  'after_connection',
];

const STEP_KIND_VALUES: readonly string[] = ['connection', 'message', 'followup', 'reactivation'];

function isDelayBasis(value: string): value is DelayBasis {
  return DELAY_BASIS_VALUES.includes(value);
}

function isStepKind(value: string): value is SequenceStepKind {
  return STEP_KIND_VALUES.includes(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readImpactPreview(value: unknown): StoredImpactPreview {
  const record = asRecord(value);
  return {
    sentUntouched: asNumberOrNull(record.sent_untouched),
    lockedUntouched: asNumberOrNull(record.locked_untouched),
    dynamicNeedsRegeneration: asNumberOrNull(record.dynamic_needs_regeneration),
    enrollmentsMoved: asNumberOrNull(record.enrollments_moved),
    publishedAt: asIso(record.published_at),
  };
}

function mapSequence(row: Row): SequenceSummary {
  return {
    id: asString(row.id),
    businessId: asString(row.business_id),
    name: asString(row.name),
    description: asStringOrNull(row.description),
    isDefault: asBoolean(row.is_default),
    status: asString(row.status, 'draft'),
    currentVersionId: asStringOrNull(row.current_version_id),
    currentVersion: asNumberOrNull(row.current_version),
    currentVersionStatus: asStringOrNull(row.current_version_status),
    versionCount: asNumber(row.version_count),
    publishedVersionCount: asNumber(row.published_version_count),
    stepCount: asNumber(row.step_count),
    activeEnrollments: asNumber(row.active_enrollments),
    dormantEnrollments: asNumber(row.dormant_enrollments),
    updatedAt: asIso(row.updated_at),
  };
}

function mapStep(row: Row): SequenceStep {
  const kind = asString(row.kind, 'message');
  const basis = asString(row.delay_basis, 'after_previous');
  return {
    id: asString(row.id),
    sequenceVersionId: asString(row.sequence_version_id),
    stepOrder: asNumber(row.step_order),
    kind: isStepKind(kind) ? kind : 'message',
    name: asString(row.name),
    delayDays: asNumber(row.delay_days),
    delayBasis: isDelayBasis(basis) ? basis : 'after_previous',
    goal: asStringOrNull(row.goal),
    allowedContext: asStringArray(row.allowed_context),
    wordMax: asNumberOrNull(row.word_max),
    ctaStyle: asStringOrNull(row.cta_style),
    prohibitedPhrases: asStringArray(row.prohibited_phrases),
    proofPolicy: asStringOrNull(row.proof_policy),
    tone: asStringOrNull(row.tone),
    generationMode: asString(row.generation_mode, 'ai'),
    isActive: asBoolean(row.is_active),
  };
}

const STEP_SELECT = `
  select st.id, st.sequence_version_id, st.step_order, st.kind, st.name, st.delay_days,
         st.delay_basis, st.goal, st.allowed_context, st.word_max, st.cta_style,
         st.prohibited_phrases, st.proof_policy, st.tone, st.generation_mode, st.is_active
    from public.sequence_steps st
`;

/* ----------------------------------------------------------------- reads -- */

export async function listSequences(
  actor: Actor,
  businessId: string,
): Promise<readonly SequenceSummary[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select s.id, s.business_id, s.name, s.description, s.is_default, s.status,
              s.current_version_id, s.updated_at,
              cv.version as current_version,
              cv.status as current_version_status,
              (select count(*) from public.sequence_versions v
                where v.sequence_id = s.id) as version_count,
              (select count(*) from public.sequence_versions v
                where v.sequence_id = s.id and v.status = 'published') as published_version_count,
              (select count(*) from public.sequence_steps st
                where st.sequence_version_id = s.current_version_id) as step_count,
              (select count(*) from public.sequence_enrollments e
                where e.sequence_id = s.id
                  and e.state in ('active', 'paused', 'reactivation_due')) as active_enrollments,
              (select count(*) from public.sequence_enrollments e
                where e.sequence_id = s.id and e.state = 'dormant') as dormant_enrollments
         from public.sequences s
         left join public.sequence_versions cv on cv.id = s.current_version_id
        where s.business_id = $1 and s.deleted_at is null
        order by s.is_default desc, s.name`,
      [businessId],
    );
    return result.rows.map(mapSequence);
  });
}

export async function getSequence(actor: Actor, sequenceId: string): Promise<SequenceSummary | null> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select s.id, s.business_id, s.name, s.description, s.is_default, s.status,
              s.current_version_id, s.updated_at,
              cv.version as current_version,
              cv.status as current_version_status,
              (select count(*) from public.sequence_versions v
                where v.sequence_id = s.id) as version_count,
              (select count(*) from public.sequence_versions v
                where v.sequence_id = s.id and v.status = 'published') as published_version_count,
              (select count(*) from public.sequence_steps st
                where st.sequence_version_id = s.current_version_id) as step_count,
              (select count(*) from public.sequence_enrollments e
                where e.sequence_id = s.id
                  and e.state in ('active', 'paused', 'reactivation_due')) as active_enrollments,
              (select count(*) from public.sequence_enrollments e
                where e.sequence_id = s.id and e.state = 'dormant') as dormant_enrollments
         from public.sequences s
         left join public.sequence_versions cv on cv.id = s.current_version_id
        where s.id = $1 and s.deleted_at is null`,
      [sequenceId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapSequence(row);
  });
}

/** Every version of a sequence with its steps, newest first. */
export async function listSequenceVersions(
  actor: Actor,
  sequenceId: string,
): Promise<readonly SequenceVersion[]> {
  return read(actor, async (sql) => {
    const versions = await sql.query<Row>(
      `select v.id, v.sequence_id, v.version, v.status, v.published_at, v.change_summary,
              v.impact_preview, v.created_at, u.full_name as published_by_name,
              (select count(*) from public.sequence_enrollments e
                where e.sequence_version_id = v.id) as enrollment_count
         from public.sequence_versions v
         left join public.users u on u.id = v.published_by
        where v.sequence_id = $1
        order by v.version desc`,
      [sequenceId],
    );

    const steps = await sql.query<Row>(
      `${STEP_SELECT}
         join public.sequence_versions v on v.id = st.sequence_version_id
        where v.sequence_id = $1
        order by st.sequence_version_id, st.step_order`,
      [sequenceId],
    );

    const byVersion = new Map<string, SequenceStep[]>();
    for (const row of steps.rows) {
      const step = mapStep(row);
      const bucket = byVersion.get(step.sequenceVersionId);
      if (bucket === undefined) byVersion.set(step.sequenceVersionId, [step]);
      else bucket.push(step);
    }

    return versions.rows.map((row: Row) => ({
      id: asString(row.id),
      sequenceId: asString(row.sequence_id),
      version: asNumber(row.version, 1),
      status: asString(row.status, 'draft'),
      publishedAt: asIso(row.published_at),
      publishedByName: asStringOrNull(row.published_by_name),
      changeSummary: asStringOrNull(row.change_summary),
      impactPreview: readImpactPreview(row.impact_preview),
      enrollmentCount: asNumber(row.enrollment_count),
      createdAt: asIso(row.created_at),
      steps: byVersion.get(asString(row.id)) ?? [],
    }));
  });
}

/**
 * The message instances that belong to one sequence version, in the exact shape
 * `computePublishImpact` expects.
 *
 * Instances reach their version through `sequence_step_id`, which is why the publish
 * preview can be computed from real scheduled rows rather than from a copy of the
 * counts the RPC keeps afterwards.
 */
export async function listMessageInstancesForVersion(
  actor: Actor,
  sequenceVersionId: string,
): Promise<readonly MessageInstance[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select mi.id, mi.business_id, mi.lead_id, mi.conversation_id, mi.sequence_step_id,
              mi.step_order, mi.step_kind, mi.state, mi.current_version_id, mi.due_at,
              mi.sent_at, mi.snoozed_until, mi.invalidated_at, mi.regeneration_reason
         from public.message_instances mi
         join public.sequence_steps st on st.id = mi.sequence_step_id
        where st.sequence_version_id = $1
        order by mi.due_at nulls last, mi.step_order`,
      [sequenceVersionId],
    );

    return result.rows.map((row: Row): MessageInstance => {
      const state = asString(row.state, 'DYNAMIC');
      const kind = asString(row.step_kind, 'message');
      return {
        id: asString(row.id),
        businessId: asString(row.business_id),
        leadId: asString(row.lead_id),
        conversationId: asString(row.conversation_id),
        sequenceStepId: asString(row.sequence_step_id),
        stepOrder: asNumber(row.step_order),
        stepKind: isStepKind(kind) ? kind : 'message',
        state: (state === 'SENT' || state === 'LOCKED' ? state : 'DYNAMIC'),
        currentVersionId: asStringOrNull(row.current_version_id),
        dueAt: asIso(row.due_at),
        sentAt: asIso(row.sent_at),
        snoozedUntil: asIso(row.snoozed_until),
        invalidatedAt: asIso(row.invalidated_at),
        regenerationReason: asStringOrNull(row.regeneration_reason),
      };
    });
  });
}

export interface DormantLead {
  readonly leadId: string;
  readonly personName: string;
  readonly companyName: string | null;
  readonly dormantAt: string | null;
  readonly reactivationDueAt: string | null;
  readonly lastStepOrder: number | null;
  readonly dormancyDays: number;
}

/**
 * Dormant leads awaiting reactivation review (spec `lead_lifecycle.reactivation`).
 *
 * Deliberately queried from `sequence_enrollments` columns that exist: the dormancy
 * window is derived from `dormant_at` (falling back to `updated_at`) and the scheduled
 * `reactivation_due_at`, so the screen never depends on a denormalised "last step"
 * column. `sequence.enrollments.last_step_sent_at` does not exist in the schema.
 */
export async function listDormantLeads(
  actor: Actor,
  businessId: string,
  limit = 50,
): Promise<readonly DormantLead[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select l.id as lead_id, p.full_name as person_name, c.name as company_name,
              e.dormant_at, e.reactivation_due_at, e.current_step_order,
              greatest(
                0,
                floor(extract(epoch from (now() - coalesce(e.dormant_at, e.updated_at))) / 86400)
              )::int as dormancy_days
         from public.leads l
         join public.people p on p.id = l.person_id
         left join public.companies c on c.id = l.company_id
         join public.sequence_enrollments e on e.lead_id = l.id
        where l.business_id = $1
          and l.deleted_at is null
          and e.state in ('dormant', 'reactivation_due')
        order by e.reactivation_due_at nulls last, e.dormant_at
        limit $2`,
      [businessId, limit],
    );

    return result.rows.map((row: Row) => ({
      leadId: asString(row.lead_id),
      personName: asString(row.person_name),
      companyName: asStringOrNull(row.company_name),
      dormantAt: asIso(row.dormant_at),
      reactivationDueAt: asIso(row.reactivation_due_at),
      lastStepOrder: asNumberOrNull(row.current_step_order),
      dormancyDays: asNumber(row.dormancy_days),
    }));
  });
}

/** Sequence options for the ICP "default sequence" select (screen A12). */export async function listSequenceOptions(actor: Actor, businessId: string): Promise<readonly Option[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, name, status from public.sequences
        where business_id = $1 and deleted_at is null
        order by is_default desc, name`,
      [businessId],
    );
    return result.rows.map((row: Row) => ({
      value: asString(row.id),
      label: `${asString(row.name)} (${asString(row.status, 'draft')})`,
    }));
  });
}

/* ------------------------------------------------------------- mutations -- */

export interface SequenceTimingSettings {
  /** Delays for Follow-up 1/2/3, from `sequence.default_followup_delays_days`. */
  readonly followupDelays: readonly number[];
  /** spec `lead_lifecycle.after_followup_3`: "around 60 days (business configurable)". */
  readonly reactivationDays: number;
}

/**
 * The business's configured cadence.
 *
 * spec `lead_lifecycle.after_followup_3` and `sequence_engine.default_steps` are
 * defaults, not constants: migration 0010 seeds
 * `sequence.default_followup_delays_days = [3, 4, 7]` and
 * `dormant.reactivation_days = 60` as platform settings, and a business-scoped row
 * overrides the global one.
 */
export async function getSequenceTimingSettings(
  actor: Actor,
  businessId: string,
): Promise<SequenceTimingSettings> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select key, value, business_id
         from public.platform_settings
        where key in ('sequence.default_followup_delays_days', 'dormant.reactivation_days')
          and (business_id is null or business_id = $1)`,
      [businessId],
    );

    const values = new Map<string, unknown>();
    for (const row of result.rows) {
      if (asStringOrNull(row.business_id) === null) values.set(asString(row.key), row.value);
    }
    for (const row of result.rows) {
      if (asStringOrNull(row.business_id) !== null) values.set(asString(row.key), row.value);
    }

    const raw = values.get('sequence.default_followup_delays_days');
    const configured = Array.isArray(raw)
      ? raw.filter(
          (entry): entry is number =>
            typeof entry === 'number' && Number.isFinite(entry) && entry >= 0,
        )
      : [];
    const fallback = DEFAULT_SEQUENCE_STEPS.slice(1).map((step) => step.delayDays);

    return {
      followupDelays: configured.length > 0 ? configured : fallback,
      reactivationDays:
        asNumberOrNull(values.get('dormant.reactivation_days')) ?? DEFAULT_REACTIVATION_COOLDOWN_DAYS,
    };
  });
}

interface SeedStep {
  readonly stepOrder: number;
  readonly kind: SequenceStepKind;
  readonly name: string;
  readonly delayDays: number;
  readonly delayBasis: DelayBasis;
  readonly goal: string;
}

/**
 * The default lifecycle's steps, with the delays the business configured.
 *
 * `sequence.default_followup_delays_days` is seeded as `[3, 4, 7]` by migration 0010
 * and matches spec `sequence_engine.default_steps` ("~3 days", "~4 days after FU1",
 * "~7 days after FU2"). Message 1 has no delay of its own: it becomes due when the
 * connection is accepted.
 */
export function seedSteps(followupDelays: readonly number[]): readonly SeedStep[] {
  return DEFAULT_SEQUENCE_STEPS.map((step, index) => {
    const configured = index === 0 ? undefined : followupDelays[index - 1];
    return {
      stepOrder: step.stepOrder,
      kind: step.kind,
      name: step.name,
      delayDays: index === 0 ? 0 : (configured ?? step.delayDays),
      delayBasis: step.delayBasis,
      goal: step.purpose,
    };
  });
}

export interface SequenceInput {
  readonly name: string;
  readonly description: string | null;
  readonly isDefault: boolean;
}

async function clearDefaultSequence(sql: Db, businessId: string, exceptId: string | null): Promise<void> {
  await sql.query(
    `update public.sequences set is_default = false, updated_at = now()
      where business_id = $1 and is_default and deleted_at is null
        and ($2::uuid is null or id <> $2::uuid)`,
    [businessId, exceptId],
  );
}

export async function createSequence(
  viewer: Viewer,
  businessId: string,
  input: SequenceInput,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      if (input.isDefault) await clearDefaultSequence(sql, businessId, null);
      const created = await sql.query<{ id: string }>(
        `insert into public.sequences (business_id, name, description, is_default, status, created_by)
         values ($1, $2, $3, $4, 'draft', $5)
         returning id`,
        [businessId, input.name, input.description, input.isDefault, viewer.userId],
      );
      const id = created.rows[0]?.id;
      if (id === undefined) return { ok: false, error: 'The sequence was not created.' };
      return { ok: true, id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export async function updateSequence(
  viewer: Viewer,
  sequenceId: string,
  businessId: string,
  input: SequenceInput & { readonly status: SequenceStatus },
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      if (input.isDefault) await clearDefaultSequence(sql, businessId, sequenceId);
      const result = await sql.query(
        `update public.sequences
            set name = $3, description = $4, is_default = $5, status = $6, updated_at = now()
          where id = $1 and business_id = $2 and deleted_at is null`,
        [sequenceId, businessId, input.name, input.description, input.isDefault, input.status],
      );
      if (result.affectedRows === 0) return { ok: false, error: 'That sequence no longer exists.' };
      return { ok: true, id: sequenceId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export async function archiveSequence(viewer: Viewer, sequenceId: string): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query(
        `update public.sequences
            set deleted_at = now(), is_default = false, status = 'archived', updated_at = now()
          where id = $1 and deleted_at is null`,
        [sequenceId],
      );
      if (result.affectedRows === 0) return { ok: false, error: 'That sequence no longer exists.' };
      return { ok: true, id: sequenceId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export interface DraftVersionOptions {
  /** Copy the steps of this version; null seeds the default lifecycle instead. */
  readonly sourceVersionId: string | null;
  readonly followupDelays: readonly number[];
  readonly changeSummary: string | null;
}

/**
 * Opens a new draft version, which is the only editable state.
 *
 * A version is the unit of change in the spec's publish model, so "edit the live
 * sequence" means "create the next draft from what is live, edit that, publish it".
 */
export async function createDraftVersion(
  viewer: Viewer,
  sequenceId: string,
  options: DraftVersionOptions,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const sequence = await sql.query<Row>(
        `select id from public.sequences where id = $1 and deleted_at is null`,
        [sequenceId],
      );
      if (sequence.rows[0] === undefined) {
        return { ok: false, error: 'That sequence no longer exists.' };
      }

      const next = await sql.query<Row>(
        `select coalesce(max(version), 0) + 1 as next_version
           from public.sequence_versions where sequence_id = $1`,
        [sequenceId],
      );
      const version = asNumber(next.rows[0]?.next_version, 1);

      const created = await sql.query<{ id: string }>(
        `insert into public.sequence_versions (sequence_id, version, status, change_summary, created_by)
         values ($1, $2, 'draft', $3, $4)
         returning id`,
        [sequenceId, version, options.changeSummary, viewer.userId],
      );
      const versionId = created.rows[0]?.id;
      if (versionId === undefined) {
        return { ok: false, error: 'The draft version was not created.' };
      }

      if (options.sourceVersionId !== null) {
        await sql.query(
          `insert into public.sequence_steps
             (sequence_version_id, step_order, kind, name, delay_days, delay_basis, goal,
              allowed_context, word_max, cta_style, prohibited_phrases, proof_policy, tone,
              generation_mode, is_active)
           select $1, step_order, kind, name, delay_days, delay_basis, goal, allowed_context,
                  word_max, cta_style, prohibited_phrases, proof_policy, tone, generation_mode,
                  is_active
             from public.sequence_steps
            where sequence_version_id = $2
            order by step_order`,
          [versionId, options.sourceVersionId],
        );
      } else {
        for (const step of seedSteps(options.followupDelays)) {
          await sql.query(
            `insert into public.sequence_steps
               (sequence_version_id, step_order, kind, name, delay_days, delay_basis, goal, generation_mode)
             values ($1, $2, $3, $4, $5, $6, $7, 'ai')`,
            [
              versionId,
              step.stepOrder,
              step.kind,
              step.name,
              step.delayDays,
              step.delayBasis,
              step.goal,
            ],
          );
        }
      }

      return { ok: true, id: versionId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export interface StepInput {
  readonly name: string;
  readonly kind: SequenceStepKind;
  readonly delayDays: number;
  readonly delayBasis: DelayBasis;
  readonly goal: string | null;
  readonly allowedContext: readonly string[];
  readonly wordMax: number | null;
  readonly ctaStyle: string | null;
  readonly prohibitedPhrases: readonly string[];
  readonly proofPolicy: ProofPolicy | null;
  readonly tone: string | null;
  readonly generationMode: GenerationMode;
  readonly isActive: boolean;
}

/**
 * Edits one step, but only while its version is still a draft.
 *
 * The `exists (... status = 'draft')` guard is what makes "published versions are
 * immutable" true at the database boundary rather than only in the UI.
 */
export async function updateStep(
  viewer: Viewer,
  stepId: string,
  input: StepInput,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query(
        `update public.sequence_steps st
            set name = $2,
                kind = $3,
                delay_days = $4,
                delay_basis = $5,
                goal = $6,
                allowed_context = $7::text[],
                word_max = $8,
                cta_style = $9,
                prohibited_phrases = $10::text[],
                proof_policy = $11,
                tone = $12,
                generation_mode = $13,
                is_active = $14,
                updated_at = now()
          where st.id = $1
            and exists (
              select 1 from public.sequence_versions v
               where v.id = st.sequence_version_id and v.status = 'draft'
            )`,
        [
          stepId,
          input.name,
          input.kind,
          input.delayDays,
          input.delayBasis,
          input.goal,
          [...input.allowedContext],
          input.wordMax,
          input.ctaStyle,
          [...input.prohibitedPhrases],
          input.proofPolicy,
          input.tone,
          input.generationMode,
          input.isActive,
        ],
      );
      if (result.affectedRows === 0) {
        return {
          ok: false,
          error: 'Only a draft version can be edited. Create a new draft version from this one first.',
        };
      }
      return { ok: true, id: stepId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/**
 * Publishing (spec `sequence_engine.publish_behavior`).
 *
 * The RPC is the only writer: it refuses an already-published version, requires an
 * admin, invalidates eligible DYNAMIC unsent instances, moves live enrollments to the
 * new version and records the applied preview in `impact_preview`.
 */
export async function publishSequenceVersion(
  viewer: Viewer,
  versionId: string,
): Promise<MutationResult> {
  if (viewer.userId === null) {
    return { ok: false, error: 'Publishing a sequence version requires a signed-in admin.' };
  }
  try {
    return await withActor(viewer.actor, async (sql) => {
      await sql.query(`select public.publish_sequence_version($1, $2) as result`, [
        versionId,
        viewer.userId,
      ]);
      return { ok: true, id: versionId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}
