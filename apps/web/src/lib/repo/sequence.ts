/**
 * Sequence state for a single lead: the step that is actually due, and the open
 * tasks attached to it.
 *
 * The due-step decision is made by the database (`message_instances` is the record
 * of what has been scheduled and sent), not recomputed here. Application-side
 * recomputation would be a second implementation of the lifecycle rules and could
 * disagree with what the queue shows.
 */
import 'server-only';

import type { Actor } from '../actor';
import type { Row } from '../sql';
import { asIso, asNumber, asString, asStringOrNull, read } from './common';

export interface DueMessage {
  readonly id: string;
  readonly stepOrder: number;
  readonly stepKind: string;
  readonly state: 'DYNAMIC' | 'LOCKED' | 'SENT';
  readonly content: string | null;
  readonly dueAt: string | null;
  readonly sentAt: string | null;
  readonly snoozedUntil: string | null;
}

/**
 * The message the operator should act on now.
 *
 * Prefers the earliest unsent instance that is due, then the most recently sent one
 * so the screen can still show history when nothing is pending.
 */
export async function dueMessageForLead(actor: Actor, leadId: string): Promise<DueMessage | null> {
  return read(actor, async (sql) => {
    const pending = await sql.query<Row>(
      `select m.id, m.step_order, m.step_kind, m.state, m.due_at, m.sent_at, m.snoozed_until,
              mv.content
         from public.message_instances m
         left join public.message_versions mv on mv.id = m.current_version_id
        where m.lead_id = $1
          and m.state in ('DYNAMIC', 'LOCKED')
          and m.sent_at is null
        order by m.step_order
        limit 1`,
      [leadId],
    );

    const row =
      pending.rows[0] ??
      (
        await sql.query<Row>(
          `select m.id, m.step_order, m.step_kind, m.state, m.due_at, m.sent_at, m.snoozed_until,
                  mv.content
             from public.message_instances m
             left join public.message_versions mv on mv.id = m.current_version_id
            where m.lead_id = $1 and m.state = 'SENT'
            order by m.sent_at desc nulls last
            limit 1`,
          [leadId],
        )
      ).rows[0];

    if (row === undefined) return null;

    const state = asString(row.state, 'DYNAMIC');
    return {
      id: asString(row.id),
      stepOrder: asNumber(row.step_order),
      stepKind: asString(row.step_kind, 'message'),
      state: state === 'SENT' || state === 'LOCKED' ? state : 'DYNAMIC',
      content: asStringOrNull(row.content),
      dueAt: asIso(row.due_at),
      sentAt: asIso(row.sent_at),
      snoozedUntil: asIso(row.snoozed_until),
    };
  });
}

export interface OpenTask {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly dueAt: string | null;
  readonly priority: string;
}

export async function openTasksForLead(actor: Actor, leadId: string): Promise<readonly OpenTask[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, title, type, due_at, priority
         from public.tasks
        where lead_id = $1 and status in ('open', 'snoozed') and deleted_at is null
        order by due_at nulls last, created_at`,
      [leadId],
    );
    return result.rows.map((row: Row) => ({
      id: asString(row.id),
      title: asString(row.title),
      type: asString(row.type, 'follow_up'),
      dueAt: asIso(row.due_at),
      priority: asString(row.priority, 'normal'),
    }));
  });
}

export interface SequenceState {
  readonly enrollmentId: string | null;
  readonly sequenceName: string | null;
  readonly state: string | null;
  readonly currentStepOrder: number | null;
  readonly reactivationDueAt: string | null;
  readonly dormantAt: string | null;
}

/** The lead's active enrollment, or its most recent one when parked. */
export async function sequenceStateForLead(actor: Actor, leadId: string): Promise<SequenceState> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select e.id, e.state, e.current_step_order, e.reactivation_due_at, e.dormant_at,
              s.name as sequence_name
         from public.sequence_enrollments e
         left join public.sequences s on s.id = e.sequence_id
        where e.lead_id = $1
        order by e.created_at desc
        limit 1`,
      [leadId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return {
        enrollmentId: null,
        sequenceName: null,
        state: null,
        currentStepOrder: null,
        reactivationDueAt: null,
        dormantAt: null,
      };
    }
    return {
      enrollmentId: asString(row.id),
      sequenceName: asStringOrNull(row.sequence_name),
      state: asStringOrNull(row.state),
      currentStepOrder: row.current_step_order === null ? null : asNumber(row.current_step_order),
      reactivationDueAt: asIso(row.reactivation_due_at),
      dormantAt: asIso(row.dormant_at),
    };
  });
}

export interface ReactivationCandidate {
  readonly leadId: string;
  readonly personName: string;
  readonly companyName: string | null;
  readonly dormantAt: string | null;
  readonly reactivationDueAt: string | null;
  readonly lastStepOrder: number | null;
  readonly lastStepSentAt: string | null;
}

/**
 * Dormant leads whose review is due, plus those already flagged.
 *
 * spec `lead_lifecycle.reactivation`: "Prefer a fresh buying signal/new angle. Do
 * not blindly repeat the old sequence." The prior outreach summary is returned so
 * the screen can show what was already said.
 */
export async function listReactivationCandidates(
  actor: Actor,
  businessId: string,
  limit = 50,
): Promise<readonly ReactivationCandidate[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      // `sequence_enrollments` has no `last_step_sent_at` column: the last send is derived
      // from the message instances, which is also the only value that cannot go stale.
      `select l.id as lead_id, p.full_name as person_name, c.name as company_name,
              e.dormant_at, e.reactivation_due_at, e.current_step_order,
              (select max(mi.sent_at) from public.message_instances mi
                where mi.lead_id = l.id and mi.sent_at is not null) as last_step_sent_at
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
      lastStepOrder: row.current_step_order === null ? null : asNumber(row.current_step_order),
      lastStepSentAt: asIso(row.last_step_sent_at),
    }));
  });
}
