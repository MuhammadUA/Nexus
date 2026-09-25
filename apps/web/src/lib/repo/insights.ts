/**
 * Dashboard-style aggregates for the admin Overview and the Insights screens.
 *
 * Every figure is computed from the same tables the operational screens read, so a
 * number on the dashboard can always be traced to rows an operator can open. No
 * figure is stored, cached or approximated: a stale dashboard that disagrees with
 * the queue is worse than no dashboard.
 */
import 'server-only';

import type { Actor } from '../actor';
import type { Row } from '../sql';
import { asIso, asNumber, asString, asStringOrNull, read } from './common';

export interface OverviewSnapshot {
  readonly activeLeads: number;
  readonly needsProfile: number;
  readonly dueToday: number;
  readonly overdue: number;
  readonly repliesRecorded: number;
  readonly dormant: number;
  readonly suppressed: number;
  readonly openTasks: number;
  readonly profileQueuePending: number;
  readonly duplicateCandidatesOpen: number;
  readonly importsLast30Days: number;
  readonly senders: readonly SenderActivity[];
  readonly recentActivity: readonly ActivityEntry[];
  readonly leadHealth: readonly LeadHealthBucket[];
}

export interface SenderActivity {
  readonly identityId: string;
  readonly displayName: string;
  readonly platform: string;
  readonly status: string;
  readonly dailyTarget: number | null;
  readonly sentToday: number;
  readonly activeSessions: number;
}

export interface ActivityEntry {
  readonly id: string;
  readonly at: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly actorType: string;
  readonly businessId: string | null;
}

export interface LeadHealthBucket {
  readonly status: string;
  readonly count: number;
}

export async function getOverview(
  actor: Actor,
  businessId: string,
): Promise<OverviewSnapshot> {
  return read(actor, async (sql) => {
    const totals = await sql.query<Row>(
      `select
         count(*) filter (where deleted_at is null and status not in ('archived', 'deleted')) as active_leads,
         count(*) filter (where deleted_at is null and needs_profile) as needs_profile,
         count(*) filter (where deleted_at is null and status = 'dormant') as dormant,
         count(*) filter (where deleted_at is null and is_dnc) as suppressed,
         count(*) filter (where deleted_at is null
                            and next_action_at is not null
                            and next_action_at < now() + interval '1 day') as due_today,
         count(*) filter (where deleted_at is null
                            and next_action_at is not null
                            and next_action_at < now()) as overdue
       from public.leads
       where business_id = $1`,
      [businessId],
    );

    const replies = await sql.query<Row>(
      `select count(*)::int as n
         from public.conversation_outcomes
        where business_id = $1`,
      [businessId],
    );

    const tasks = await sql.query<Row>(
      `select count(*)::int as n
         from public.tasks
        where business_id = $1 and status = 'open' and deleted_at is null`,
      [businessId],
    );

    const queue = await sql.query<Row>(
      `select count(*)::int as n
         from public.profile_capture_queue
        where business_id = $1 and state in ('pending', 'in_progress')`,
      [businessId],
    );

    const duplicates = await sql.query<Row>(
      `select count(*)::int as n
         from public.duplicate_candidates
        where business_id = $1 and status = 'open'`,
      [businessId],
    );

    const imports = await sql.query<Row>(
      `select count(*)::int as n
         from public.import_batches
        where business_id = $1 and created_at > now() - interval '30 days'`,
      [businessId],
    );

    // Daily counts come from the identity's own rolling counter, which is the same
    // figure the operator sees before sending.
    const senders = await sql.query<Row>(
      `select i.id, i.display_name, i.platform, i.status, i.daily_target, i.daily_sent_count,
              i.daily_count_reset_at,
              (select count(*) from public.browser_sessions s
                where s.outreach_identity_id = i.id and s.status = 'active') as active_sessions
         from public.outreach_identities i
        where i.deleted_at is null
          and exists (select 1 from public.outreach_identity_business_access a
                       where a.outreach_identity_id = i.id and a.business_id = $1)
        order by i.display_name`,
      [businessId],
    );

    const activity = await sql.query<Row>(
      `select id, created_at, action, entity_type, entity_id, actor_type, business_id
         from public.audit_events
        where business_id = $1
        order by created_at desc
        limit 12`,
      [businessId],
    );

    const health = await sql.query<Row>(
      `select status, count(*)::int as n
         from public.leads
        where business_id = $1 and deleted_at is null
        group by status
        order by n desc`,
      [businessId],
    );

    const t = totals.rows[0];
    return {
      activeLeads: asNumber(t?.active_leads),
      needsProfile: asNumber(t?.needs_profile),
      dueToday: asNumber(t?.due_today),
      overdue: asNumber(t?.overdue),
      repliesRecorded: asNumber(replies.rows[0]?.n),
      dormant: asNumber(t?.dormant),
      suppressed: asNumber(t?.suppressed),
      openTasks: asNumber(tasks.rows[0]?.n),
      profileQueuePending: asNumber(queue.rows[0]?.n),
      duplicateCandidatesOpen: asNumber(duplicates.rows[0]?.n),
      importsLast30Days: asNumber(imports.rows[0]?.n),
      senders: senders.rows.map((row: Row) => {
        const resetAt = asIso(row.daily_count_reset_at);
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const current = resetAt !== null && new Date(resetAt) >= startOfDay;
        return {
          identityId: asString(row.id),
          displayName: asString(row.display_name),
          platform: asString(row.platform, 'linkedin'),
          status: asString(row.status, 'active'),
          dailyTarget:
            row.daily_target === null || row.daily_target === undefined
              ? null
              : asNumber(row.daily_target),
          sentToday: current ? asNumber(row.daily_sent_count) : 0,
          activeSessions: asNumber(row.active_sessions),
        };
      }),
      recentActivity: activity.rows.map((row: Row) => ({
        id: asString(row.id),
        at: asIso(row.created_at) ?? '',
        action: asString(row.action),
        entityType: asString(row.entity_type),
        entityId: asStringOrNull(row.entity_id),
        actorType: asString(row.actor_type, 'system'),
        businessId: asStringOrNull(row.business_id),
      })),
      leadHealth: health.rows.map((row: Row) => ({
        status: asString(row.status),
        count: asNumber(row.n),
      })),
    };
  });
}

export interface ReplyTheme {
  readonly outcome: string;
  readonly count: number;
  readonly share: number;
}

/** spec `screen_inventory` A21 — reply themes that feed ICP/sequence improvement. */
export async function getReplyThemes(actor: Actor, businessId: string): Promise<readonly ReplyTheme[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select outcome, count(*)::int as n
         from public.conversation_outcomes
        where business_id = $1
        group by outcome
        order by n desc`,
      [businessId],
    );
    const total = result.rows.reduce((sum, row: Row) => sum + asNumber(row.n), 0);
    return result.rows.map((row: Row) => {
      const count = asNumber(row.n);
      return {
        outcome: asString(row.outcome),
        count,
        share: total === 0 ? 0 : count / total,
      };
    });
  });
}

export interface StepPerformance {
  readonly stepOrder: number;
  readonly stepName: string;
  readonly sent: number;
  readonly repliesAfter: number;
  readonly replyRate: number;
}

/**
 * Per-step performance.
 *
 * "Replies after" counts replies recorded at or after that step was sent, which is
 * the honest reading: an outcome is not attributable to a single step, and claiming
 * otherwise would overstate the precision of the data.
 */
export async function getStepPerformance(
  actor: Actor,
  businessId: string,
): Promise<readonly StepPerformance[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `with steps as (
         select mi.step_order,
                min(mi.sent_at) as first_sent_at,
                count(*)::int as sent
           from public.message_instances mi
          where mi.business_id = $1 and mi.state = 'SENT' and mi.sent_at is not null
          group by mi.step_order
       )
       select s.step_order,
              s.sent,
              coalesce((
                select count(*) from public.conversation_outcomes o
                 where o.business_id = $1 and o.created_at >= s.first_sent_at
              ), 0)::int as replies_after
         from steps s
        order by s.step_order`,
      [businessId],
    );

    return result.rows.map((row: Row) => {
      const sent = asNumber(row.sent);
      const replies = asNumber(row.replies_after);
      const stepOrder = asNumber(row.step_order);
      return {
        stepOrder,
        stepName: stepOrder <= 1 ? 'Message 1' : `Follow-up ${String(stepOrder - 1)}`,
        sent,
        repliesAfter: replies,
        replyRate: sent === 0 ? 0 : replies / sent,
      };
    });
  });
}
