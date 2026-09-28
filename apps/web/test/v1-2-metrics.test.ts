/**
 * V1.2 read models — the Overview and Insights metrics, against a real database.
 *
 * These are the metric definitions from spec §71.2, and they are exactly the kind
 * of thing that looks right on screen and is wrong in the number: a "needs
 * enrichment" that quietly includes READY leads, a "ready for outreach" that
 * ignores the sales state that blocks sending, a "replies today" counted from
 * classifications instead of from replies, or a funnel total that does not add up
 * to the leads it claims to describe.
 *
 * So every assertion below is about a **number**, driven through `withActor` against
 * the production migration set (PGlite, the same schema, triggers and RLS the
 * application runs against). The reads go through RLS as an ordinary admin, which is
 * also how the pages reach them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadViewer, type Actor, type Viewer } from '@/lib/actor';
import {
  leadsByDiscoverySource,
  loadInsightsData,
  loadOverviewSnapshot,
} from '@/app/b/[slug]/overview/v1-2-metrics';

import { createAppHarness, type AppHarness } from './harness';

const ADMIN_ID = 'a0000000-0000-4000-8000-000000000001';
const BUSINESS_ID = 'a0000000-0000-4000-8000-000000000002';
const OTHER_BUSINESS_ID = 'a0000000-0000-4000-8000-000000000003';
const READY_PERSON = 'a0000000-0000-4000-8000-000000000010';
const NEEDS_PERSON = 'a0000000-0000-4000-8000-000000000011';
const FAILED_PERSON = 'a0000000-0000-4000-8000-000000000012';
const BLOCKED_PERSON = 'a0000000-0000-4000-8000-000000000013';
const ARCHIVED_PERSON = 'a0000000-0000-4000-8000-000000000014';
const READY_LEAD = 'a0000000-0000-4000-8000-000000000020';
const NEEDS_LEAD = 'a0000000-0000-4000-8000-000000000021';
const FAILED_LEAD = 'a0000000-0000-4000-8000-000000000022';
const JOB_OPEN = 'a0000000-0000-4000-8000-000000000030';
const JOB_WAITING_A = 'a0000000-0000-4000-8000-000000000031';
const JOB_WAITING_B = 'a0000000-0000-4000-8000-000000000032';
const IDENTITY_LINKEDIN = 'a0000000-0000-4000-8000-000000000040';
const IDENTITY_EMAIL = 'a0000000-0000-4000-8000-000000000041';
const CONVERSATION_ID = 'a0000000-0000-4000-8000-000000000050';
const MESSAGE_INSTANCE_ID = 'a0000000-0000-4000-8000-000000000051';
const MESSAGE_VERSION_ID = 'a0000000-0000-4000-8000-000000000052';

let h: AppHarness;
let viewer: Viewer;
let actor: Actor;

beforeAll(async () => {
  h = await createAppHarness();
  await h.db.exec('set row_security = off');

  /** Names the failing setup statement, so a schema surprise is diagnosable. */
  const step = async (label: string, sql: string, params: unknown[]): Promise<void> => {
    try {
      await h.db.query(sql, params);
    } catch (error) {
      throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await step('insert users', `insert into public.users (id, email, full_name, role, status)
     values ($1::uuid, 'metrics-admin@nexus.test', 'Metrics Admin', 'admin', 'active')`, [ADMIN_ID]);
  await step('insert businesses', `insert into public.businesses (id, key, name, status, created_by)
     values ($1::uuid, 'metrics-test', 'Metrics Test Co', 'active', $2::uuid),
            ($3::uuid, 'metrics-other', 'Other Metrics Co', 'active', $2::uuid)`, [BUSINESS_ID, ADMIN_ID, OTHER_BUSINESS_ID]);
  await step('insert user_business_access', `insert into public.user_business_access
       (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources,
        can_use_profile_queue, can_delete_leads, created_by)
     values ($1::uuid, $2::uuid, 'admin', true, true, true, true, $1::uuid)`, [ADMIN_ID, BUSINESS_ID]);

  await step('insert people', `insert into public.people (id, full_name, normalized_name, created_by)
     values ($1::uuid, 'Ready Person', 'ready person', $4::uuid),
            ($2::uuid, 'Needs Person', 'needs person', $4::uuid),
            ($3::uuid, 'Failed Person', 'failed person', $4::uuid)`, [READY_PERSON, NEEDS_PERSON, FAILED_PERSON, ADMIN_ID]);
  await step('insert more people', `insert into public.people (id, full_name, normalized_name, created_by)
     values ($1::uuid, 'Blocked Person', 'blocked person', $3::uuid),
            ($2::uuid, 'Archived Person', 'archived person', $3::uuid)`, [BLOCKED_PERSON, ARCHIVED_PERSON, ADMIN_ID]);

  /*
   * Three leads: one READY, one that still needs enrichment, one FAILED. The
   * enrichment row is created by the `leads_seed_enrichment` trigger, so each state
   * is set as an update afterwards — which is also how the pipeline moves a lead.
   * Each lead has its own person: `leads_business_person_active_key` allows one
   * active lead per (business, person).
   */
  await step('insert leads', `insert into public.leads (id, business_id, person_id, status, source_type, created_by)
     values ($1::uuid, $4::uuid, $5::uuid, 'ready', 'google_search', $8::uuid),
            ($2::uuid, $4::uuid, $6::uuid, 'new', 'google_search', $8::uuid),
            ($3::uuid, $4::uuid, $7::uuid, 'new', 'file_xlsx', $8::uuid)`,
    [READY_LEAD, NEEDS_LEAD, FAILED_LEAD, BUSINESS_ID, READY_PERSON, NEEDS_PERSON, FAILED_PERSON, ADMIN_ID]);
  await step('ready enrichment', `update public.lead_enrichment
        set status = 'READY', completeness_score = 82, last_profile_enrichment_at = now(),
            last_company_enrichment_at = now(), last_context_build_at = now()
      where lead_id = $1::uuid`, [READY_LEAD]);
  await step('pending enrichment', `update public.lead_enrichment
        set status = 'AGENT_RESEARCH_PENDING', completeness_score = 40,
            last_profile_enrichment_at = now()
      where lead_id = $1::uuid`, [NEEDS_LEAD]);
  await step('failed enrichment', `update public.lead_enrichment
        set status = 'FAILED', completeness_score = 10, last_error_code = 'provider_timeout'
      where lead_id = $1::uuid`, [FAILED_LEAD]);

  /*
   * A READY lead in a blocking sales state. It must *not* count as ready for
   * outreach, and it is the case a naive "status = READY" count gets wrong.
   */
  const blockedLead = 'a0000000-0000-4000-8000-000000000023';
  await step('insert blocked lead', `insert into public.leads (id, business_id, person_id, status, source_type, created_by)
     values ($1::uuid, $2::uuid, $3::uuid, 'do_not_contact', 'paste_list', $4::uuid)`,
    [blockedLead, BUSINESS_ID, BLOCKED_PERSON, ADMIN_ID]);
  await step('blocked enrichment', `update public.lead_enrichment set status = 'READY', completeness_score = 90 where lead_id = $1::uuid`, [blockedLead]);

  // An archived lead: excluded from "active leads" and from the source mix, because
  // it is out of every working view.
  const archivedLead = 'a0000000-0000-4000-8000-000000000024';
  await step('insert archived lead', `insert into public.leads (id, business_id, person_id, status, source_type, created_by)
     values ($1::uuid, $2::uuid, $3::uuid, 'archived', 'research_agent', $4::uuid)`,
    [archivedLead, BUSINESS_ID, ARCHIVED_PERSON, ADMIN_ID]);

  // Jobs: one OPEN, two WAITING_AI, one COMPLETE with two claims and two completions.
  const jobComplete = 'a0000000-0000-4000-8000-000000000033';
  await step('insert agent jobs', `insert into public.agent_jobs (id, business_id, lead_id, job_type, status, attempt_count, created_by_type)
     values ($1::uuid, $5::uuid, $6::uuid, 'RESEARCH_COMPANY', 'OPEN', 0, 'system'),
            ($2::uuid, $5::uuid, $6::uuid, 'BUILD_CONTEXT', 'WAITING_AI', 1, 'system'),
            ($3::uuid, $5::uuid, $7::uuid, 'CAPTURE_PROFILE', 'WAITING_AI', 1, 'system'),
            ($4::uuid, $5::uuid, $7::uuid, 'ENRICH_PROFILE', 'COMPLETE', 2, 'system')`,
    [JOB_OPEN, JOB_WAITING_A, JOB_WAITING_B, jobComplete, BUSINESS_ID, READY_LEAD, NEEDS_LEAD]);
  await step('insert agent job events', `insert into public.agent_job_events (job_id, business_id, event_type, actor_type)
     values ($1::uuid, $4::uuid, 'claimed', 'system'),
            ($1::uuid, $4::uuid, 'completed', 'system'),
            ($2::uuid, $4::uuid, 'claimed', 'system'),
            ($2::uuid, $4::uuid, 'claimed', 'system'),
            ($3::uuid, $4::uuid, 'failed', 'system')`,
    [jobComplete, JOB_OPEN, JOB_WAITING_A, BUSINESS_ID]);

  // One inbound reply today, so "replies today" has something to count.
  await step('insert interaction', `insert into public.interactions (business_id, lead_id, type, direction, summary, occurred_at)
     values ($1::uuid, $2::uuid, 'inbound_reply', 'inbound', 'Interested, send rates', now())`,
    [BUSINESS_ID, READY_LEAD]);

  // Two channel accounts, on two channels. `platform` is the legacy attribution.
  await step('insert channel accounts', `insert into public.outreach_identities (id, platform, channel, display_name, status, daily_target, created_by)
     values ($1::uuid, 'linkedin', 'linkedin', 'Ada LinkedIn', 'active', 20, $3::uuid),
            ($2::uuid, 'twitter', 'other', 'Legacy Twitter', 'paused', 0, $3::uuid)`,
    [IDENTITY_LINKEDIN, IDENTITY_EMAIL, ADMIN_ID]);
  await step('insert account grants', `insert into public.outreach_identity_business_access (outreach_identity_id, business_id, created_by)
     values ($1::uuid, $3::uuid, $4::uuid), ($2::uuid, $3::uuid, $4::uuid)`,
    [IDENTITY_LINKEDIN, IDENTITY_EMAIL, BUSINESS_ID, ADMIN_ID]);

  /*
   * The conversation names the LinkedIn account as its sender, so the account rows
   * above must exist first — hence the ordering of these setup steps.
   */
  await step('insert conversation', `insert into public.conversations (id, business_id, lead_id, channel, sender_identity_id)
     values ($1::uuid, $2::uuid, $3::uuid, 'linkedin', $4::uuid)`,
    [CONVERSATION_ID, BUSINESS_ID, READY_LEAD, IDENTITY_LINKEDIN]);
  await step('insert outcome', `insert into public.conversation_outcomes (conversation_id, lead_id, business_id, outcome)
     values ($1::uuid, $2::uuid, $3::uuid, 'Interested')`,
    [CONVERSATION_ID, READY_LEAD, BUSINESS_ID]);

  /*
   * A sent message instance, so the send events below have real rows to reference.
   * The invariant `message_instances_sent_check` (via trigger) refuses SENT without a
   * current version, so the version is written first — the same order a real send
   * takes.
   */
  await step('insert message instance', `insert into public.message_instances
       (id, conversation_id, state, business_id, lead_id, step_order)
     values ($1::uuid, $2::uuid, 'DYNAMIC', $3::uuid, $4::uuid, 1)`,
    [MESSAGE_INSTANCE_ID, CONVERSATION_ID, BUSINESS_ID, READY_LEAD]);
  await step('insert message version', `insert into public.message_versions
       (id, message_instance_id, content, version_no, created_by)
     values ($1::uuid, $2::uuid, 'Hello from the metrics test', 1, $3::uuid)`,
    [MESSAGE_VERSION_ID, MESSAGE_INSTANCE_ID, ADMIN_ID]);
  await step('mark message sent', `update public.message_instances
        set state = 'SENT', sent_at = now(), current_version_id = $2::uuid
      where id = $1::uuid`,
    [MESSAGE_INSTANCE_ID, MESSAGE_VERSION_ID]);

  // One send from each channel account, so the channel series has two rows.
  await step('insert sends', `insert into public.message_events
       (message_instance_id, event_type, business_id, lead_id, outreach_identity_id)
     select $1::uuid, 'sent', $2::uuid, $3::uuid, i.id
       from public.outreach_identities i
      where i.id in ($4::uuid, $5::uuid)`,
    [MESSAGE_INSTANCE_ID, BUSINESS_ID, READY_LEAD, IDENTITY_LINKEDIN, IDENTITY_EMAIL]);

  // The AI ledger: one ordinary run, one cache reuse, one failure.
  await step('insert ai runs', `insert into public.ai_runs
       (business_id, task, input_hash, status, cache_hit, tokens_in, tokens_out, estimated_cost_usd, duration_ms)
     values ($1::uuid, 'PROFILE_EXTRACTION', 'hash-1', 'SUCCEEDED', false, 1000, 200, 0.020000, 1200),
            ($1::uuid, 'PROFILE_EXTRACTION', 'hash-1', 'CACHED', true, 0, 0, 0.000000, 5),
            ($1::uuid, 'CONTEXT_BUILD', 'hash-2', 'FAILED', false, 500, 0, 0.005000, 900)`,
    [BUSINESS_ID]);

  /*
   * Seeded with `row_security = off`, then switched back on so the reads below run
   * as the admin through the real policies — the path the pages take.
   */
  await h.db.exec('set row_security = on');

  viewer = await loadViewer({ kind: 'user', userId: ADMIN_ID });
  actor = viewer.actor;
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('Overview V1.2 metrics', () => {
  it('counts active leads and excludes the archived one', async () => {
    const snapshot = await loadOverviewSnapshot(actor, BUSINESS_ID);
    // Four live leads (ready, needs, failed, do_not_contact); the archived lead is out.
    expect(snapshot.activeLeads).toBe(4);
  });

  it('counts needs-enrichment as the four outstanding states, not as "not READY"', async () => {
    const snapshot = await loadOverviewSnapshot(actor, BUSINESS_ID);
    // AGENT_RESEARCH_PENDING + FAILED. The two READY leads are not "needing enrichment".
    expect(snapshot.needsEnrichment).toBe(2);
    expect(snapshot.failedEnrichments).toBe(1);
  });

  it('counts ready-for-outreach as READY enrichment AND no blocking sales state', async () => {
    const snapshot = await loadOverviewSnapshot(actor, BUSINESS_ID);
    // Two leads have enrichment READY; one of them is do_not_contact, so one is ready.
    expect(snapshot.readyForOutreach).toBe(1);
  });

  it('counts inbound replies recorded today from the interaction timeline', async () => {
    const snapshot = await loadOverviewSnapshot(actor, BUSINESS_ID);
    expect(snapshot.repliesToday).toBe(1);
  });

  it('reports today’s AI usage as runs, tokens and an estimated cost', async () => {
    const snapshot = await loadOverviewSnapshot(actor, BUSINESS_ID);
    expect(snapshot.aiRunsToday).toBe(3);
    expect(snapshot.aiTokensIn).toBe(1500);
    expect(snapshot.aiTokensOut).toBe(200);
    expect(snapshot.aiCostUsd).toBeCloseTo(0.025, 6);
  });

  it('builds the funnel from enrichment states and a total that agrees with it', async () => {
    const snapshot = await loadOverviewSnapshot(actor, BUSINESS_ID);
    const byState = new Map(snapshot.funnel.map((row) => [row.status, row.leads]));
    expect(byState.get('READY')).toBe(2);
    expect(byState.get('AGENT_RESEARCH_PENDING')).toBe(1);
    expect(byState.get('FAILED')).toBe(1);
    // The window-function totals must equal the rows they were computed from, or the
    // "share" column would not add up to 100%.
    const sum = snapshot.funnel.reduce((total, row) => total + row.leads, 0);
    expect(snapshot.enrichmentTotal).toBe(sum);
    // Five leads have an enrichment row; `activeLeads` is four because the archived
    // lead is excluded from the working count but still has its enrichment row.
    expect(snapshot.enrichmentTotal).toBe(5);
    // One FAILED lead carries an error code, and one more row does too.
    expect(snapshot.enrichmentWithError).toBeGreaterThanOrEqual(1);
  });

  it('reports the queue per status and keeps the oldest open job', async () => {
    const snapshot = await loadOverviewSnapshot(actor, BUSINESS_ID);
    expect(snapshot.jobsOpen).toBe(1);
    expect(snapshot.jobsWaitingAi).toBe(2);
    expect(snapshot.oldestOpenJobAt).not.toBeNull();
  });

  it('merges the activity feeds without inventing a lead link for an audit row', async () => {
    const snapshot = await loadOverviewSnapshot(actor, BUSINESS_ID);
    expect(snapshot.activity.length).toBeGreaterThan(0);
    expect(snapshot.activityTotal).toBeGreaterThanOrEqual(snapshot.activity.length);
    for (const row of snapshot.activity) {
      if (row.kind === 'audit') expect(row.leadId).toBeNull();
      if (row.kind === 'agent_job') expect(row.leadId).toBeNull();
    }
  });
});

describe('Insights V1.2 metrics', () => {
  it('reports the same ready-for-outreach figure the Overview shows', async () => {
    // Two screens, one definition: this is the drift these tests exist to prevent.
    const [snapshot, insights] = await Promise.all([
      loadOverviewSnapshot(actor, BUSINESS_ID),
      loadInsightsData(actor, BUSINESS_ID),
    ]);
    expect(insights.readyForOutreach).toBe(snapshot.readyForOutreach);
  });

  it('counts enrichment events per day from the timestamps that exist', async () => {
    const insights = await loadInsightsData(actor, BUSINESS_ID);
    expect(insights.enrichmentByDay.length).toBeGreaterThan(0);
    const today = insights.enrichmentByDay[0];
    // Profile: READY + AGENT_RESEARCH_PENDING. Company and context: READY only.
    expect(today?.profiles).toBe(2);
    expect(today?.companies).toBe(1);
    expect(today?.context).toBe(1);
  });

  it('counts job completions and attempts per day from the event history', async () => {
    const insights = await loadInsightsData(actor, BUSINESS_ID);
    const today = insights.jobsByDay[0];
    expect(today?.completed).toBe(1);
    expect(today?.failed).toBe(1);
    expect(today?.attempts).toBe(3);
  });

  it('reports queue depth as the states that are still work', async () => {
    const insights = await loadInsightsData(actor, BUSINESS_ID);
    expect(insights.queueDepth).toBe(3);
    expect(insights.completedJobsWindow).toBe(1);
    // Two claims on the completed job, one completion.
    expect(insights.attemptsPerCompletion).toBeCloseTo(2, 6);
    expect(insights.queue.map((row) => row.status)).toContain('WAITING_AI');
  });

  it('reports AI usage per day and per task, with a cache ratio of the runs there were', async () => {
    const insights = await loadInsightsData(actor, BUSINESS_ID);
    expect(insights.aiRunsWindow).toBe(3);
    expect(insights.aiCacheHitsWindow).toBe(1);
    expect(insights.aiCostWindow).toBeCloseTo(0.025, 6);
    const profile = insights.aiByTask.find((row) => row.task === 'PROFILE_EXTRACTION');
    expect(profile?.runs).toBe(2);
    expect(profile?.cacheHits).toBe(1);
    expect(profile?.failures).toBe(0);
    const context = insights.aiByTask.find((row) => row.task === 'CONTEXT_BUILD');
    expect(context?.failures).toBe(1);
  });

  it('projects the legacy source vocabulary onto discovery sources', async () => {
    const insights = await loadInsightsData(actor, BUSINESS_ID);
    const bySource = new Map(insights.bySource.map((row) => [row.source, row.leads]));
    // `google_search` -> `google`; `file_xlsx` -> `csv`; `paste_list` -> `paste`.
    expect(bySource.get('google')).toBe(2);
    expect(bySource.get('csv')).toBe(1);
    expect(bySource.get('paste')).toBe(1);
    // `research_agent` belongs to the archived lead, which is not part of the source
    // mix the business is working.
    expect(bySource.get('web')).toBeUndefined();
    expect(insights.sourceTotal).toBe(4);
  });

  it('counts sends per outreach channel from the accounts that sent them', async () => {
    const insights = await loadInsightsData(actor, BUSINESS_ID);
    const byChannel = new Map(insights.byChannel.map((row) => [row.channel, row.sent]));
    expect(byChannel.get('linkedin')).toBe(1);
    // The Twitter-era account has channel `other`; it is reported as such, never as
    // its legacy `platform`.
    expect(byChannel.get('other')).toBe(1);
    expect(insights.sentWindow).toBe(2);
  });

  it('reports reply outcomes with a share that can be computed', async () => {
    const insights = await loadInsightsData(actor, BUSINESS_ID);
    expect(insights.replyTotal).toBe(1);
    expect(insights.outcomes[0]?.outcome).toBe('Interested');
  });
});

describe('discovery source projection', () => {
  it('sums legacy values that mean the same discovery source', () => {
    const rows = [
      { source_type: 'file_csv', leads: 3 },
      { source_type: 'file_xlsx', leads: 2 },
      { source_type: 'google_search', leads: 4 },
      { source_type: null, leads: 1 },
    ];
    expect(leadsByDiscoverySource(rows)).toEqual([
      { source: 'csv', leads: 5 },
      { source: 'google', leads: 4 },
      { source: 'other', leads: 1 },
    ]);
  });
});
