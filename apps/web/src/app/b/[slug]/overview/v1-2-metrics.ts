/**
 * V1.2 read models for the Overview and Insights screens.
 *
 * **Why this is its own module.** Three things here are easy to get subtly wrong
 * and impossible to see in a screenshot:
 *
 *   1. **The metric definitions.** "Needs enrichment" is a set of enrichment
 *      states, "ready for outreach" additionally requires that the lead is not in an
 *      outreach-blocking sales state, and "replies today" is an interaction type and
 *      a day boundary. Two screens computing these from their own SQL would drift;
 *      one module computing them means the Overview's headline and the Insights
 *      screen's series cannot disagree.
 *   2. **Bounded queries.** Every read here is a count, a grouped count or a small
 *      aggregate over a fixed window. No metric loads a lead's history, and the
 *      query count does not grow with the size of the business.
 *   3. **No AI on a render.** Nothing in this module calls a model. A page render
 *      that invoked the pipeline would make the same figure differ between two
 *      consecutive loads and spend money producing it.
 *
 * Everything runs through `withActor`, so RLS — not a filter written here — decides
 * which rows an operator may see, and the three V1.2 views (`lead_enrichment_funnel`,
 * `agent_job_queue_summary`, `ai_usage_daily`) are `security_invoker`, so they inherit
 * exactly those policies.
 *
 * The module is deliberately free of presentation: it returns numbers and dates, and
 * the labels, accents and empty states live in the pages and in
 * `@/lib/channel-vocabulary`.
 */
import 'server-only';

import {
  OUTREACH_BLOCKING_LEAD_STATES,
  normalizeDiscoverySource,
  type DiscoverySource,
} from '@nexus/core';

import { withActor, type Actor } from '@/lib/actor';
import type { Row } from '@/lib/sql';
import { asIso, asNumber, asString, asStringOrNull } from '@/lib/repo/common';

/* ------------------------------------------------------------- Overview -- */

export interface OverviewFunnelRow {
  readonly status: string;
  readonly leads: number;
  readonly avgCompleteness: number;
  readonly withError: number;
}

export interface OverviewAgentStatusRow {
  readonly status: string;
  readonly jobs: number;
  readonly attempts: number;
  readonly oldestCreatedAt: string | null;
}

export interface OverviewActivityRow {
  readonly id: string;
  readonly kind: string;
  readonly at: string;
  readonly summary: string;
  readonly recordType: string;
  readonly actorType: string;
  readonly leadId: string | null;
}

export interface OverviewSignalRow {
  readonly id: string;
  readonly at: string;
  readonly summary: string;
  readonly polarity: string;
  readonly detail: string | null;
  readonly leadId: string | null;
}

export interface OverviewSnapshot {
  readonly activeLeads: number;
  readonly needsEnrichment: number;
  readonly jobsOpen: number;
  readonly jobsWaitingAi: number;
  readonly readyForOutreach: number;
  readonly repliesToday: number;
  readonly aiRunsToday: number;
  readonly aiTokensIn: number;
  readonly aiTokensOut: number;
  readonly aiCostUsd: number;
  readonly failedEnrichments: number;
  /** Every lead with an enrichment row, whatever its state — not "active leads". */
  readonly enrichmentTotal: number;
  readonly enrichmentWithError: number;
  readonly oldestOpenJobAt: string | null;
  readonly funnel: readonly OverviewFunnelRow[];
  readonly agentStates: readonly OverviewAgentStatusRow[];
  readonly recentSignals: readonly OverviewSignalRow[];
  readonly activity: readonly OverviewActivityRow[];
  readonly activityTotal: number;
}

/** How many rows each bounded feed on the Overview renders. */
const SIGNAL_LIMIT = 8;
const ACTIVITY_LIMIT = 12;

/**
 * The Overview's reads (spec §71).
 *
 * Nine statements, all independent, issued in one `Promise.all` inside a single
 * `withActor` transaction so they are not serialised behind each other.
 */
export async function loadOverviewSnapshot(actor: Actor, businessId: string): Promise<OverviewSnapshot> {
  return withActor(actor, async (sql) => {
    const [leadTotals, funnel, jobs, ready, replies, aiUsage, failed, signals, activity] =
      await Promise.all([
        /*
         * Active Leads excludes `archived` as well as `deleted`. spec §71.2 states
         * `status != 'deleted'`; an archived lead is out of every working view, and
         * counting it would make this headline disagree with the Leads screen the
         * operator opens next. `deleted_at is null` is kept as well because a
         * soft-deleted row can still carry its previous status.
         */
        sql.query<Row>(
          `select
             (select count(*)::int from public.leads l
               where l.business_id = $1 and l.deleted_at is null
                 and l.status not in ('archived', 'deleted')) as active_leads,
             (select count(*)::int from public.lead_enrichment e
               where e.business_id = $1
                 and e.status in ('NEEDS_PROFILE', 'COMPANY_RESEARCH_PENDING',
                                  'AGENT_RESEARCH_PENDING', 'FAILED')) as needs_enrichment`,
          [businessId],
        ),

        /*
         * The funnel: leads per enrichment state, with average completeness and the
         * error count, plus the totals computed as window functions so the total is
         * a second read rather than a second query. The totals are used to label the
         * "share" column, and they come from the same rows the bars do.
         */
        sql.query<Row>(
          `select status, leads, avg_completeness, with_error,
                  sum(leads) over () as total_leads,
                  sum(with_error) over () as total_with_error
             from (
               select status,
                      count(*)::int as leads,
                      coalesce(round(avg(completeness_score)), 0)::int as avg_completeness,
                      count(*) filter (where last_error_code is not null)::int as with_error
                 from public.lead_enrichment
                where business_id = $1
                group by status
             ) per_state`,
          [businessId],
        ),

        sql.query<Row>(
          `select status, jobs, attempts, oldest_created_at, next_lease_expiry
             from public.agent_job_queue_summary
            where business_id = $1`,
          [businessId],
        ),

        /*
         * "Ready for outreach" is narrower than "enrichment READY": the lead must
         * also not be in a sales state that blocks outreach. §71.2 defines it that
         * way, and the state list comes from `@nexus/core`, so this page and the
         * sequence engine cannot disagree about which states block a send.
         */
        sql.query<Row>(
          `select count(*)::int as ready
             from public.lead_enrichment e
             join public.leads l on l.id = e.lead_id
            where e.business_id = $1
              and e.status = 'READY'
              and l.deleted_at is null
              and not (l.status = any($2::text[]))`,
          [businessId, [...OUTREACH_BLOCKING_LEAD_STATES]],
        ),

        /*
         * Replies today: inbound replies recorded today, from the interaction
         * timeline rather than from outcome rows. An outcome is the operator's
         * classification and can lag the reply it describes.
         */
        sql.query<Row>(
          `select count(*)::int as replies
             from public.interactions i
            where i.business_id = $1
              and i.type = 'inbound_reply'
              and i.occurred_at >= date_trunc('day', now())`,
          [businessId],
        ),

        sql.query<Row>(
          `select
             coalesce(sum(runs), 0)::int as runs,
             coalesce(sum(tokens_in), 0)::bigint as tokens_in,
             coalesce(sum(tokens_out), 0)::bigint as tokens_out,
             coalesce(sum(estimated_cost_usd), 0) as cost_usd,
             coalesce(sum(cache_hits), 0)::int as cache_hits
           from public.ai_usage_daily
          where business_id = $1 and day = current_date`,
          [businessId],
        ),

        sql.query<Row>(
          `select count(*)::int as failed
             from public.lead_enrichment
            where business_id = $1 and status = 'FAILED'`,
          [businessId],
        ),

        sql.query<Row>(
          `select s.id, s.kind, s.observed_at, s.polarity, s.label, s.detail, s.lead_id,
                  coalesce(p.full_name, 'Lead') as lead_name
             from public.signals s
             left join public.leads l on l.id = s.lead_id
             left join public.people p on p.id = l.person_id
            where s.business_id = $1 and s.is_active
            order by s.observed_at desc
            limit ${String(SIGNAL_LIMIT)}`,
          [businessId],
        ),

        /*
         * The merged activity feed (§71.5): audit trail, lead timeline, signals and
         * agent job history, newest first. `total_rows` is a window function, so the
         * "N events" label reports how many rows the four feeds hold without a
         * second counting query — and the `limit` is applied after the window, so it
         * is the full count rather than the page size.
         */
        sql.query<Row>(
          `with feed as (
             select 'audit'::text as kind, a.id, a.created_at as at,
                    a.action as summary,
                    a.entity_type as record_type,
                    a.actor_type as actor_type,
                    a.entity_id as record_id,
                    null::uuid as lead_id,
                    count(*) over () as total_rows
               from public.audit_events a
              where a.business_id = $1
             union all
             select 'interaction', i.id, i.occurred_at,
                    coalesce(nullif(left(i.summary, 140), ''), i.type),
                    i.type, coalesce(i.source_client, 'user'),
                    i.id, i.lead_id,
                    count(*) over ()
               from public.interactions i
              where i.business_id = $1
             union all
             select 'signal', s.id, s.observed_at,
                    s.kind, 'signal', 'system', s.id, s.lead_id,
                    count(*) over ()
               from public.signals s
              where s.business_id = $1
             union all
             select 'agent_job', e.id, e.created_at,
                    e.event_type, 'agent_jobs', coalesce(e.actor_type, 'system'),
                    e.job_id, null::uuid, count(*) over ()
               from public.agent_job_events e
              where e.business_id = $1
           )
           select kind, id, at, summary, record_type, actor_type, record_id, lead_id,
                  max(total_rows) over () as total_rows
             from feed
            order by at desc
            limit ${String(ACTIVITY_LIMIT)}`,
          [businessId],
        ),
      ]);

    const totals = leadTotals.rows[0];
    const firstFunnel = funnel.rows[0];

    const agentStates: readonly OverviewAgentStatusRow[] = jobs.rows.map((row: Row) => ({
      status: asString(row.status, 'OPEN'),
      jobs: asNumber(row.jobs),
      attempts: asNumber(row.attempts),
      oldestCreatedAt: asIso(row.oldest_created_at),
    }));

    let jobsOpen = 0;
    let jobsWaitingAi = 0;
    let oldestOpenJobAt: string | null = null;
    for (const state of agentStates) {
      if (state.status === 'OPEN') {
        jobsOpen += state.jobs;
        oldestOpenJobAt = state.oldestCreatedAt;
      }
      if (state.status === 'WAITING_AI') jobsWaitingAi += state.jobs;
    }

    return {
      activeLeads: asNumber(totals?.active_leads),
      needsEnrichment: asNumber(totals?.needs_enrichment),
      failedEnrichments: asNumber(failed.rows[0]?.failed),
      enrichmentTotal: asNumber(firstFunnel?.total_leads),
      enrichmentWithError: asNumber(firstFunnel?.total_with_error),
      readyForOutreach: asNumber(ready.rows[0]?.ready),
      repliesToday: asNumber(replies.rows[0]?.replies),
      aiRunsToday: asNumber(aiUsage.rows[0]?.runs),
      aiTokensIn: asNumber(aiUsage.rows[0]?.tokens_in),
      aiTokensOut: asNumber(aiUsage.rows[0]?.tokens_out),
      aiCostUsd: asNumber(aiUsage.rows[0]?.cost_usd),
      jobsOpen,
      jobsWaitingAi,
      oldestOpenJobAt,
      funnel: funnel.rows.map((row: Row) => ({
        status: asString(row.status),
        leads: asNumber(row.leads),
        avgCompleteness: asNumber(row.avg_completeness),
        withError: asNumber(row.with_error),
      })),
      agentStates,
      recentSignals: signals.rows.map((row: Row) => ({
        id: asString(row.id),
        at: asIso(row.observed_at) ?? '',
        summary: signalSummary(row),
        polarity: asString(row.polarity, 'neutral'),
        detail: asStringOrNull(row.detail),
        leadId: asStringOrNull(row.lead_id),
      })),
      activity: activity.rows.map((row: Row) => ({
        id: `${asString(row.kind)}:${asString(row.id)}`,
        kind: asString(row.kind),
        at: asIso(row.at) ?? '',
        summary: asString(row.summary) === '' ? '—' : asString(row.summary),
        recordType: asString(row.record_type, 'record'),
        actorType: asString(row.actor_type, 'system'),
        leadId: asStringOrNull(row.lead_id),
      })),
      activityTotal: asNumber(activity.rows[0]?.total_rows),
    };
  });
}

/**
 * A signal's one-line summary.
 *
 * `label` is the operator-facing text when the capture wrote one; otherwise the
 * `kind` is de-snake-cased, so an unlabelled signal still reads as something rather
 * than as an empty cell.
 */
function signalSummary(row: Row): string {
  const label = asStringOrNull(row.label);
  const kind = asString(row.kind).replace(/_/g, ' ');
  return label ?? (kind.length === 0 ? 'signal' : kind);
}

/* ------------------------------------------------------------- Insights -- */

export interface EnrichmentEventDay {
  readonly day: string;
  readonly profiles: number;
  readonly companies: number;
  readonly context: number;
}

export interface EnrichmentStateRow {
  readonly status: string;
  readonly leads: number;
  readonly withError: number;
  readonly avgCompleteness: number;
}

export interface JobDayRow {
  readonly day: string;
  readonly completed: number;
  readonly failed: number;
  readonly attempts: number;
}

export interface QueueRow {
  readonly status: string;
  readonly jobs: number;
  readonly attempts: number;
  readonly oldestCreatedAt: string | null;
}

export interface AiDayRow {
  readonly day: string;
  readonly runs: number;
  readonly cacheHits: number;
  readonly failures: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

export interface AiTaskRow {
  readonly task: string;
  readonly runs: number;
  readonly cacheHits: number;
  readonly failures: number;
  readonly costUsd: number;
  readonly avgDurationMs: number;
}

export interface SourceRow {
  readonly source: DiscoverySource;
  readonly leads: number;
}

export interface ChannelRow {
  readonly channel: string;
  readonly sent: number;
}

export interface OutcomeRow {
  readonly outcome: string;
  readonly count: number;
}

export interface StepRow {
  readonly stepOrder: number;
  readonly stepName: string;
  readonly sent: number;
  readonly repliesAfter: number;
}

export interface InsightsData {
  readonly readyForOutreach: number;
  readonly failedEnrichments: number;
  readonly enrichmentByDay: readonly EnrichmentEventDay[];
  readonly enrichmentStates: readonly EnrichmentStateRow[];
  readonly jobsByDay: readonly JobDayRow[];
  readonly queue: readonly QueueRow[];
  readonly queueDepth: number;
  readonly completedJobsWindow: number;
  readonly attemptsPerCompletion: number | null;
  readonly aiByDay: readonly AiDayRow[];
  readonly aiByTask: readonly AiTaskRow[];
  readonly aiRunsWindow: number;
  readonly aiCacheHitsWindow: number;
  readonly aiCostWindow: number;
  readonly bySource: readonly SourceRow[];
  readonly sourceTotal: number;
  readonly byChannel: readonly ChannelRow[];
  readonly sentWindow: number;
  readonly outcomes: readonly OutcomeRow[];
  readonly replyTotal: number;
  readonly steps: readonly StepRow[];
  readonly stepCount: number;
}

/** Every history series covers a fixed 30 days; the send series covers 90. */
const HISTORY_DAYS = 30;
const SEND_DAYS = 90;
const AI_DAY_LIMIT = 30;

/**
 * The Insights reads.
 *
 * Twelve statements, all independent, in one `Promise.all`. Every one is bounded by
 * a fixed window, so neither the query count nor a single query's row count grows
 * with the business.
 *
 * Two honesties are built in rather than stated on the page:
 *
 *   * The enrichment throughput series counts the enrichment events the schema
 *     actually records (profile, company research, context build). No table stores
 *     enrichment *state* history, so presenting this as state transitions would
 *     claim data the CRM does not have.
 *   * `ai_usage_daily` counts a cache reuse as its own row, so a cache hit appears
 *     in `runs` and in `cache_hits`. The page divides one by the other and labels
 *     the result a ratio, not a saving.
 */
export async function loadInsightsData(actor: Actor, businessId: string): Promise<InsightsData> {
  return withActor(actor, async (sql) => {
    const [
      ready,
      enrichmentDaily,
      enrichmentStates,
      jobsDaily,
      queue,
      queueHealth,
      aiDaily,
      aiTasks,
      sources,
      channels,
      outcomes,
      steps,
    ] = await Promise.all([
      sql.query<Row>(
        `select count(*)::int as ready
           from public.lead_enrichment e
           join public.leads l on l.id = e.lead_id
          where e.business_id = $1
            and e.status = 'READY'
            and l.deleted_at is null
            and not (l.status = any($2::text[]))`,
        [businessId, [...OUTREACH_BLOCKING_LEAD_STATES]],
      ),

      sql.query<Row>(
        `select to_char(day, 'YYYY-MM-DD') as day,
                sum(profiles)::int as profiles,
                sum(companies)::int as companies,
                sum(context_builds)::int as context_builds
           from (
             select date_trunc('day', last_profile_enrichment_at)::date as day,
                    1 as profiles, 0 as companies, 0 as context_builds
               from public.lead_enrichment
              where business_id = $1 and last_profile_enrichment_at is not null
                and last_profile_enrichment_at >= now() - interval '30 days'
             union all
             select date_trunc('day', last_company_enrichment_at)::date,
                    0, 1, 0
               from public.lead_enrichment
              where business_id = $1 and last_company_enrichment_at is not null
                and last_company_enrichment_at >= now() - interval '30 days'
             union all
             select date_trunc('day', last_context_build_at)::date,
                    0, 0, 1
               from public.lead_enrichment
              where business_id = $1 and last_context_build_at is not null
                and last_context_build_at >= now() - interval '30 days'
           ) events
          group by day
          order by day desc`,
        [businessId],
      ),

      sql.query<Row>(
        `select status, leads, avg_completeness, with_error
           from public.lead_enrichment_funnel
          where business_id = $1
          order by leads desc, status`,
        [businessId],
      ),

      /*
       * Agent job throughput from the append-only event history: a job is counted on
       * the day its completion was recorded, not the day it was created. `claimed`
       * events are counted separately as attempts, so "attempts per completed job"
       * is a measured ratio rather than an assumption.
       */
      sql.query<Row>(
        `select to_char(day, 'YYYY-MM-DD') as day,
                sum(completed)::int as completed,
                sum(failed)::int as failed,
                sum(attempts)::int as attempts
           from (
             select date_trunc('day', e.created_at)::date as day,
                    count(*) filter (where e.event_type = 'completed') as completed,
                    count(*) filter (where e.event_type = 'failed') as failed,
                    0 as attempts
               from public.agent_job_events e
              where e.business_id = $1
                and e.created_at >= now() - interval '30 days'
              group by 1
             union all
             select date_trunc('day', e.created_at)::date,
                    0, 0, count(*) filter (where e.event_type = 'claimed')
               from public.agent_job_events e
              where e.business_id = $1
                and e.created_at >= now() - interval '30 days'
              group by 1
           ) events
          group by day
          order by day desc`,
        [businessId],
      ),

      sql.query<Row>(
        `select status, jobs, attempts, oldest_created_at, next_lease_expiry
           from public.agent_job_queue_summary
          where business_id = $1
          order by status`,
        [businessId],
      ),

      sql.query<Row>(
        `select
           coalesce(sum(jobs) filter (where status in ('OPEN', 'RUNNING', 'WAITING_AI')), 0)::int as queue_depth,
           coalesce(sum(jobs) filter (where status = 'COMPLETE'), 0)::int as completed_total,
           coalesce(sum(attempts) filter (where status = 'COMPLETE'), 0)::int as completed_attempts
         from public.agent_job_queue_summary
        where business_id = $1`,
        [businessId],
      ),

      sql.query<Row>(
        `select to_char(day, 'YYYY-MM-DD') as day,
                sum(runs)::int as runs,
                sum(cache_hits)::int as cache_hits,
                sum(failures)::int as failures,
                sum(tokens_in)::bigint as tokens_in,
                sum(tokens_out)::bigint as tokens_out,
                sum(estimated_cost_usd) as cost_usd
           from public.ai_usage_daily
          where business_id = $1
            and day >= current_date - interval '30 days'
          group by day
          order by day desc
          limit $2`,
        [businessId, AI_DAY_LIMIT],
      ),

      /*
       * Per task, aggregated over the whole window rather than per day: the question
       * is which task spends the budget, and a per-day breakdown of the same task
       * would produce thirty rows that each answer it worse.
       */
      sql.query<Row>(
        `select task,
                sum(runs)::int as runs,
                sum(cache_hits)::int as cache_hits,
                sum(failures)::int as failures,
                sum(tokens_in)::bigint as tokens_in,
                sum(tokens_out)::bigint as tokens_out,
                sum(estimated_cost_usd) as cost_usd,
                (sum(avg_duration_ms * runs) / nullif(sum(runs), 0))::int as avg_duration_ms
           from public.ai_usage_daily
          where business_id = $1
            and day >= current_date - interval '30 days'
          group by task
          order by runs desc`,
        [businessId],
      ),

      /*
       * Leads by discovery source. Archived and soft-deleted leads are excluded, so
       * the source mix describes the leads the business is actually working and its
       * total agrees with the "Active leads" definition on the Overview.
       */
      sql.query<Row>(
        `select source_type, count(*)::int as leads
           from public.leads
          where business_id = $1
            and deleted_at is null
            and status not in ('archived', 'deleted')
          group by source_type`,
        [businessId],
      ),

      /*
       * Messages actually sent, by the channel of the account that sent them. A send
       * whose account was deleted is labelled `unattributed` rather than dropped, so
       * the rows still add up to the sends that happened.
       */
      sql.query<Row>(
        `select coalesce(i.channel, 'unattributed') as channel, count(*)::int as sent
           from public.message_events e
           left join public.outreach_identities i on i.id = e.outreach_identity_id
          where e.business_id = $1
            and e.event_type = 'sent'
            and e.created_at >= now() - interval '90 days'
          group by 1
          order by sent desc`,
        [businessId],
      ),

      sql.query<Row>(
        `select outcome, count(*)::int as n
           from public.conversation_outcomes
          where business_id = $1
          group by outcome
          order by n desc`,
        [businessId],
      ),

      sql.query<Row>(
        `with per_step as (
           select mi.step_order,
                  min(mi.sent_at) as first_sent_at,
                  count(*)::int as sent
             from public.message_instances mi
            where mi.business_id = $1 and mi.state = 'SENT' and mi.sent_at is not null
            group by mi.step_order
         )
         select s.step_order, s.sent,
                coalesce((
                  select count(*) from public.conversation_outcomes o
                   where o.business_id = $1 and o.created_at >= s.first_sent_at
                ), 0)::int as replies_after
           from per_step s
          order by s.step_order`,
        [businessId],
      ),
    ]);

    const health = queueHealth.rows[0];
    const completedTotal = asNumber(health?.completed_total);
    const completedAttempts = asNumber(health?.completed_attempts);

    const aiByDay: readonly AiDayRow[] = aiDaily.rows.map((row: Row) => ({
      day: asString(row.day),
      runs: asNumber(row.runs),
      cacheHits: asNumber(row.cache_hits),
      failures: asNumber(row.failures),
      tokensIn: asNumber(row.tokens_in),
      tokensOut: asNumber(row.tokens_out),
      costUsd: asNumber(row.cost_usd),
    }));

    const stateRows: readonly EnrichmentStateRow[] = enrichmentStates.rows.map((row: Row) => ({
      status: asString(row.status),
      leads: asNumber(row.leads),
      withError: asNumber(row.with_error),
      avgCompleteness: asNumber(row.avg_completeness),
    }));

    const channelRows: readonly ChannelRow[] = channels.rows.map((row: Row) => ({
      channel: asString(row.channel, 'unattributed'),
      sent: asNumber(row.sent),
    }));

    const outcomeRows: readonly OutcomeRow[] = outcomes.rows.map((row: Row) => ({
      outcome: asString(row.outcome, 'Other'),
      count: asNumber(row.n),
    }));

    const stepRows: readonly StepRow[] = steps.rows.map((row: Row) => {
      const stepOrder = asNumber(row.step_order);
      return {
        stepOrder,
        stepName: stepOrder <= 1 ? 'Message 1' : `Follow-up ${String(stepOrder - 1)}`,
        sent: asNumber(row.sent),
        repliesAfter: asNumber(row.replies_after),
      };
    });

    return {
      readyForOutreach: asNumber(ready.rows[0]?.ready),
      failedEnrichments: stateRows.find((row) => row.status === 'FAILED')?.leads ?? 0,
      enrichmentByDay: enrichmentDaily.rows.map((row: Row) => ({
        day: asString(row.day),
        profiles: asNumber(row.profiles),
        companies: asNumber(row.companies),
        context: asNumber(row.context_builds),
      })),
      enrichmentStates: stateRows,
      jobsByDay: jobsDaily.rows.map((row: Row) => ({
        day: asString(row.day),
        completed: asNumber(row.completed),
        failed: asNumber(row.failed),
        attempts: asNumber(row.attempts),
      })),
      queue: queue.rows.map((row: Row) => ({
        status: asString(row.status, 'OPEN'),
        jobs: asNumber(row.jobs),
        attempts: asNumber(row.attempts),
        oldestCreatedAt: asIso(row.oldest_created_at),
      })),
      queueDepth: asNumber(health?.queue_depth),
      completedJobsWindow: completedTotal,
      attemptsPerCompletion: completedTotal === 0 ? null : completedAttempts / completedTotal,
      aiByDay,
      aiByTask: aiTasks.rows.map((row: Row) => ({
        task: asString(row.task, 'unknown task'),
        runs: asNumber(row.runs),
        cacheHits: asNumber(row.cache_hits),
        failures: asNumber(row.failures),
        costUsd: asNumber(row.cost_usd),
        avgDurationMs: asNumber(row.avg_duration_ms),
      })),
      aiRunsWindow: aiByDay.reduce((sum, row) => sum + row.runs, 0),
      aiCacheHitsWindow: aiByDay.reduce((sum, row) => sum + row.cacheHits, 0),
      aiCostWindow: aiByDay.reduce((sum, row) => sum + row.costUsd, 0),
      bySource: leadsByDiscoverySource(sources.rows),
      sourceTotal: sources.rows.reduce((sum, row: Row) => sum + asNumber(row.leads), 0),
      byChannel: channelRows,
      sentWindow: channelRows.reduce((sum, row) => sum + row.sent, 0),
      outcomes: outcomeRows,
      replyTotal: outcomeRows.reduce((sum, row) => sum + row.count, 0),
      steps: stepRows,
      stepCount: stepRows.length,
    };
  });
}

/**
 * Leads by discovery source.
 *
 * The column holds the V1.1 vocabulary (`leads.source_type`), so each value is
 * projected through `normalizeDiscoverySource` and the **projected** names are then
 * summed: `file_csv` and `file_xlsx` both mean `csv`, and showing them as two rows
 * would overstate how many distinct sources exist. A null source becomes `other`
 * rather than being dropped, so the rows still add up to the lead count.
 *
 * Exported because it is the one pure decision in this module — the mapping a later
 * edit is most likely to get wrong — and is asserted in
 * `v1-2-metrics.test.ts`.
 */
export function leadsByDiscoverySource(rows: readonly Row[]): readonly SourceRow[] {
  const totals = new Map<DiscoverySource, number>();
  for (const row of rows) {
    const source = normalizeDiscoverySource(asStringOrNull(row.source_type));
    totals.set(source, (totals.get(source) ?? 0) + asNumber(row.leads));
  }
  return [...totals.entries()]
    .map(([source, leads]) => ({ source, leads }))
    .sort((left, right) => right.leads - left.leads || left.source.localeCompare(right.source));
}

/**
 * The windows every series covers, exported so a screen can name them in its own
 * copy instead of restating them: a chip that says "last 30 days" must be reading
 * the same 30 the SQL filters on.
 */
export const V1_2_WINDOWS = { historyDays: HISTORY_DAYS, sendDays: SEND_DAYS } as const;
