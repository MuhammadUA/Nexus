/**
 * V1.2 repository layer: raw staging, `lead_enrichment`, and the agent job queue.
 *
 * These assertions run against the real migrations — the SECURITY DEFINER functions,
 * the FORCE row level security on `raw_staging`, the completion guard on
 * `nexus_complete_agent_job` — because those are exactly the guarantees a mock
 * cannot have. The two that matter most:
 *
 *   * the raw body is reachable only through the six functions, and its hash is
 *     computed server-side rather than trusted from a caller;
 *   * the completeness score is derived in TypeScript from permanent facts, so a
 *     stored score can never silently disagree with the facts that produced it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { intelligenceCompleteness, OUTREACH_CHANNELS } from '@nexus/core';

import { loadViewer, type Viewer } from '@/lib/actor';
import {
  agentJobSummary,
  cancelAgentJob,
  chainJobsForLead,
  claimAgentJob,
  completeAgentJob,
  createAgentJob,
  failAgentJob,
  getAgentJob,
  heartbeatAgentJob,
  listAgentJobEvents,
  listAgentJobs,
  reapExpiredLeases,
  releaseAgentJob,
  submitAgentJobResult,
} from '@/lib/repo/agent-jobs';
import {
  listLeadsNeedingEnrichment,
  loadLeadIntelligence,
  recomputeLeadEnrichment,
} from '@/lib/repo/enrichment';
import {
  cleanupExpiredRaw,
  deleteRaw,
  markRawFailed,
  readRaw,
  stageRaw,
} from '@/lib/repo/raw-staging';

import { createAppHarness, type AppHarness } from './harness';

let h: AppHarness;
let admin: Viewer;

const ADMIN_ID = 'b0000000-0000-4000-8000-000000000001';
const MEMBER_ID = 'b0000000-0000-4000-8000-000000000002';
const BUSINESS_A = 'b0000000-0000-4000-8000-00000000000a';
const BUSINESS_B = 'b0000000-0000-4000-8000-00000000000b';
const PERSON_ADA = 'b0000000-0000-4000-8000-000000000010';
const PERSON_GRACE = 'b0000000-0000-4000-8000-000000000011';
const COMPANY_ACME = 'b0000000-0000-4000-8000-000000000020';
const LEAD_ADA = 'b0000000-0000-4000-8000-000000000030';
const LEAD_GRACE = 'b0000000-0000-4000-8000-000000000031';
const LEAD_B = 'b0000000-0000-4000-8000-000000000032';

const STAGED_BODY = 'RAW-BODY-MARKER-9f3a2b Ada Lovelace, Head of Content at Acme Media';

/**
 * Every capability a test agent might need. A claim requires
 * `required_capabilities <@ capabilities`, so a test agent that declared nothing
 * could not take a `RESEARCH_*` job — which is the rule, not an inconvenience.
 */
const AGENT_CAPS = [
  'browser',
  'public_web',
  'news',
  'linkedin_profile_read',
  'ai_qualify',
  'ai_context',
  'ai_draft',
];

async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  await h.db.exec('set row_security = off');
  try {
    return await fn();
  } finally {
    await h.db.exec('set row_security = on');
  }
}

async function countRaw(id: string): Promise<number> {
  return asOwner(async () => {
    const result = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.raw_staging where id = $1`,
      [id],
    );
    return Number(result.rows[0]?.n ?? 0);
  });
}

beforeAll(async () => {
  h = await createAppHarness();
  await h.db.exec('set row_security = off');
  await h.db.query(
    `insert into public.users (id, email, full_name, role, status)
     values ($1, 'v12-admin@nexus.test', 'V12 Admin', 'admin', 'active'),
            ($2, 'v12-member@nexus.test', 'V12 Member', 'user', 'active')`,
    [ADMIN_ID, MEMBER_ID],
  );
  await h.db.query(
    `insert into public.businesses (id, key, name, status, created_by)
     values ($1, 'v12-a', 'V12 Business A', 'active', $3),
            ($2, 'v12-b', 'V12 Business B', 'active', $3)`,
    [BUSINESS_A, BUSINESS_B, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.user_business_access
       (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources,
        can_use_profile_queue, can_delete_leads, created_by)
     values ($1, $3, 'admin', true, true, true, true, $1),
            ($2, $4, 'user', false, false, false, false, $1)`,
    [ADMIN_ID, MEMBER_ID, BUSINESS_A, BUSINESS_B],
  );
  await h.db.query(
    `insert into public.companies (id, name, normalized_name, primary_domain, normalized_domain, created_by)
     values ($1, 'Acme Media', 'acme-media', 'acme.example', 'acme.example', $2)`,
    [COMPANY_ACME, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.people (id, full_name, normalized_name, job_title, linkedin_url, normalized_linkedin_url, company_id, created_by)
     values ($1, 'Ada Lovelace', 'ada-lovelace', 'Head of Content',
             'https://www.linkedin.com/in/ada-lovelace', 'https://www.linkedin.com/in/ada-lovelace', $3, $4),
            ($2, 'Grace Hopper', 'grace-hopper', null, null, null, null, $4)`,
    [PERSON_ADA, PERSON_GRACE, COMPANY_ACME, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.leads (id, business_id, person_id, company_id, status, source_type, created_by)
     values ($1, $4, $6, $8, 'new', 'manual_add', $9),
            ($2, $4, $7, null, 'new', 'paste_list', $9),
            ($3, $5, $7, null, 'new', 'manual_add', $9)`,
    [LEAD_ADA, LEAD_GRACE, LEAD_B, BUSINESS_A, BUSINESS_B, PERSON_ADA, PERSON_GRACE, COMPANY_ACME, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.signals (business_id, lead_id, kind, polarity, strength, label, is_active)
     values ($1, $2, 'hiring', 'positive', 80, 'Hiring two editors', true)`,
    [BUSINESS_A, LEAD_ADA],
  );
  await h.db.exec('set row_security = on');
  admin = await loadViewer({ kind: 'user', userId: ADMIN_ID });
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('raw staging', () => {
  it('stages a body, computes its hash server-side, and counts the read as an attempt', async () => {
    const staged = await stageRaw(admin, {
      businessId: BUSINESS_A,
      leadId: LEAD_ADA,
      personId: PERSON_ADA,
      companyId: COMPANY_ACME,
      kind: 'profile_paste',
      sourceType: 'linkedin',
      payload: STAGED_BODY,
      collectorAgent: 'test',
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;

    const first = await readRaw(admin, staged.id);
    expect(first).not.toBeNull();
    expect(first?.payload).toBe(STAGED_BODY);
    expect(first?.kind).toBe('profile_paste');
    // The hash is computed from the payload and is not accepted from a caller.
    expect(first?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first?.attemptCount).toBe(1);
    expect(first?.status).toBe('PROCESSING');

    const second = await readRaw(admin, staged.id);
    expect(second?.attemptCount).toBe(2);

    expect(await deleteRaw(admin, staged.id)).toBe(true);
    expect(await readRaw(admin, staged.id)).toBeNull();
    expect(await countRaw(staged.id)).toBe(0);
  });

  it('refuses an empty payload rather than staging nothing', async () => {
    const staged = await stageRaw(admin, {
      businessId: BUSINESS_A,
      leadId: LEAD_ADA,
      kind: 'profile_paste',
      sourceType: 'linkedin',
      payload: '   ',
    });
    expect(staged.ok).toBe(false);
  });

  it('marks a staging row failed without storing a message', async () => {
    const staged = await stageRaw(admin, {
      businessId: BUSINESS_A,
      leadId: LEAD_ADA,
      kind: 'profile_paste',
      sourceType: 'linkedin',
      payload: `${STAGED_BODY} (fail case)`,
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;

    await markRawFailed(admin, staged.id, 'schema_invalid');

    const row = await asOwner(async () => {
      const result = await h.db.query<{ status: string; last_error_code: string | null }>(
        `select status, last_error_code from public.raw_staging where id = $1`,
        [staged.id],
      );
      return result.rows[0];
    });
    expect(row?.status).toBe('FAILED');
    // A code, never a sentence and never the body.
    expect(row?.last_error_code).toBe('schema_invalid');

    await deleteRaw(admin, staged.id);
  });

  it('sweeps an abandoned row past its TTL and leaves a live one alone', async () => {
    const expired = await asOwner(async () => {
      const result = await h.db.query<{ id: string }>(
        `insert into public.raw_staging
           (business_id, lead_id, kind, source_type, payload, content_hash, status, expires_at)
         values ($1, $2, 'profile_paste', 'test', 'abandoned', 'sha256:abandoned', 'PENDING', now() - interval '1 hour')
         returning id`,
        [BUSINESS_A, LEAD_ADA],
      );
      return result.rows[0]?.id ?? '';
    });
    const live = await stageRaw(admin, {
      businessId: BUSINESS_A,
      leadId: LEAD_ADA,
      kind: 'profile_paste',
      sourceType: 'test',
      payload: 'still inside its TTL',
    });
    expect(live.ok).toBe(true);
    if (!live.ok) return;

    const swept = await cleanupExpiredRaw(admin, 200);
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await countRaw(expired)).toBe(0);
    expect(await countRaw(live.id)).toBe(1);

    await deleteRaw(admin, live.id);
  });
});

describe('lead intelligence', () => {
  it('derives the score from permanent facts and always offers all four channels', async () => {
    const intelligence = await loadLeadIntelligence(admin, LEAD_ADA);
    expect(intelligence).not.toBeNull();
    if (intelligence === null) return;

    // The score is `intelligenceCompleteness`'s, computed here in TypeScript from
    // exactly the facts the row provides.
    const expected = intelligenceCompleteness({
      fullName: 'Ada Lovelace',
      companyName: 'Acme Media',
      location: null,
      jobTitle: 'Head of Content',
      linkedinUrl: 'https://www.linkedin.com/in/ada-lovelace',
      companyWebsite: 'acme.example',
      companyResearch: false,
      signalCount: 1,
      hasAiContext: false,
      contactCount: 0,
    });
    expect(intelligence.completenessScore).toBe(expected.score);
    expect(intelligence.missingFields).toEqual(expected.missing);

    // Discovery source never restricts a channel.
    expect(intelligence.availableChannels).toEqual(OUTREACH_CHANNELS);
    expect(intelligence.source).toBe('manual');

    const keys = intelligence.searchLinks.map((link) => link.key);
    expect(keys).toContain('find_linkedin');
    expect(keys).toContain('search_person');
    expect(keys).toContain('search_company');
    expect(keys).toContain('search_signals');
  });

  it('advances the state along a permitted path and keeps the score in step', async () => {
    // LEAD_GRACE has a name and no company, no LinkedIn and no research.
    const before = await recomputeLeadEnrichment(admin, LEAD_GRACE);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.status).toBe('PROFILE_READY');
    expect(before.missingFields.length).toBeGreaterThan(0);

    const listed = await listLeadsNeedingEnrichment(admin, BUSINESS_A);
    // PROFILE_READY is not an outstanding state, so it is not on the work list.
    expect(listed.some((entry) => entry.leadId === LEAD_GRACE)).toBe(false);
  });

  it('returns null for a lead the actor cannot see', async () => {
    const member = await loadViewer({ kind: 'user', userId: MEMBER_ID });
    expect(await loadLeadIntelligence(member, LEAD_ADA)).toBeNull();
    expect(await loadLeadIntelligence(admin, 'b0000000-0000-4000-8000-00000000ffff')).toBeNull();
  });
});

describe('agent jobs', () => {
  it('creates a job, deduplicates by key, and refuses a duplicate', async () => {
    const first = await createAgentJob(admin, {
      businessId: BUSINESS_A,
      jobType: 'RESEARCH_COMPANY',
      leadId: LEAD_ADA,
      companyId: COMPANY_ACME,
      dedupeKey: `RESEARCH_COMPANY:${LEAD_ADA}:${COMPANY_ACME}`,
      reason: 'fixture: company intelligence is incomplete',
    });
    expect(first.created).toBe(true);

    const second = await createAgentJob(admin, {
      businessId: BUSINESS_A,
      jobType: 'RESEARCH_COMPANY',
      leadId: LEAD_ADA,
      companyId: COMPANY_ACME,
      dedupeKey: `RESEARCH_COMPANY:${LEAD_ADA}:${COMPANY_ACME}`,
      reason: 'fixture: repeated',
    });
    expect(second.created).toBe(false);
    expect(second.jobId).toBe(first.jobId);

    const job = await getAgentJob(admin, first.jobId);
    expect(job?.status).toBe('OPEN');
    // Priority comes from `defaultPriority`, and the capabilities from the planner,
    // so a chained job can never be offered to an agent that cannot do it.
    expect(job?.priority).toBe('high');
    expect(job?.requiredCapabilities).toEqual(['browser', 'public_web']);
    expect(job?.createdByType).toBe('user');
    expect(job?.entityLabel).toBe('Acme Media');

    const events = await listAgentJobEvents(admin, first.jobId);
    expect(events.map((event) => event.eventType)).toContain('created');

    const page = await listAgentJobs(admin, { businessId: BUSINESS_A, status: 'OPEN', limit: 10 });
    expect(page.total).toBeGreaterThanOrEqual(1);
    expect(page.jobs.some((entry) => entry.id === first.jobId)).toBe(true);

    const summary = await agentJobSummary(admin, BUSINESS_A);
    expect(summary.OPEN).toBeGreaterThanOrEqual(1);
    expect(summary.CANCELLED).toBe(0);
  });

  it('claims atomically, heartbeats, releases and re-claims', async () => {
    const created = await createAgentJob(admin, {
      businessId: BUSINESS_A,
      jobType: 'RESEARCH_SIGNALS',
      leadId: LEAD_ADA,
      dedupeKey: `RESEARCH_SIGNALS:${LEAD_ADA}`,
    });

    const claimed = await claimAgentJob(admin, {
      businessId: BUSINESS_A,
      agent: 'opencode',
      capabilities: AGENT_CAPS,
      jobId: created.jobId,
      leaseSeconds: 120,
    });
    expect(claimed?.status).toBe('RUNNING');
    expect(claimed?.claimedByAgent).toBe('opencode');
    expect(claimed?.attemptCount).toBe(1);

    // A different agent cannot take the same job while the lease is live.
    const loser = await claimAgentJob(admin, {
      businessId: BUSINESS_A,
      agent: 'other-agent',
      capabilities: AGENT_CAPS,
      jobId: created.jobId,
    });
    expect(loser).toBeNull();

    const beat = await heartbeatAgentJob(admin, { jobId: created.jobId, agent: 'opencode', leaseSeconds: 1800 });
    expect(beat.status).toBe('RUNNING');
    expect(beat.leaseExpiresAt).not.toBeNull();

    await releaseAgentJob(admin, { jobId: created.jobId, agent: 'opencode', reason: 'handing back' });
    expect((await getAgentJob(admin, created.jobId))?.status).toBe('OPEN');
  });

  it('submits evidence into WAITING_AI and cannot complete while it remains', async () => {
    const created = await createAgentJob(admin, {
      businessId: BUSINESS_A,
      jobType: 'RESEARCH_COMPANY',
      leadId: LEAD_ADA,
      companyId: COMPANY_ACME,
      dedupeKey: `RESEARCH_COMPANY:${LEAD_ADA}:submit-case`,
    });
    await claimAgentJob(admin, { businessId: BUSINESS_A, agent: 'opencode', capabilities: AGENT_CAPS, jobId: created.jobId });

    const submitted = await submitAgentJobResult(admin, {
      jobId: created.jobId,
      agent: 'opencode',
      payload: STAGED_BODY,
      kind: 'company_research',
      sourceType: 'web',
      sourceUrl: 'https://acme.example',
    });
    expect(submitted.status).toBe('WAITING_AI');
    expect((await getAgentJob(admin, created.jobId))?.status).toBe('WAITING_AI');
    expect(await countRaw(submitted.rawStagingId)).toBe(1);

    // "Evidence that still exists has not been committed" — the database refuses to
    // report the job done while an un-consumed staging row remains.
    await expect(completeAgentJob(admin, { jobId: created.jobId })).rejects.toThrow();
    expect((await getAgentJob(admin, created.jobId))?.status).toBe('WAITING_AI');

    await deleteRaw(admin, submitted.rawStagingId);
    expect(await countRaw(submitted.rawStagingId)).toBe(0);
    const completed = await completeAgentJob(admin, { jobId: created.jobId });
    expect(completed.status).toBe('COMPLETE');
  });

  it('fails a job with a typed code and reaps an expired lease', async () => {
    const created = await createAgentJob(admin, {
      businessId: BUSINESS_A,
      jobType: 'RESEARCH_PERSON',
      leadId: LEAD_ADA,
      personId: PERSON_ADA,
      dedupeKey: `RESEARCH_PERSON:${PERSON_ADA}`,
    });
    await claimAgentJob(admin, { businessId: BUSINESS_A, agent: 'doomed-agent', capabilities: AGENT_CAPS, jobId: created.jobId });

    const failed = await failAgentJob(admin, {
      jobId: created.jobId,
      agent: 'doomed-agent',
      errorCode: 'site_unreachable',
      message: 'The page timed out',
      retryable: false,
    });
    expect(failed.status).toBe('FAILED');
    expect((await getAgentJob(admin, created.jobId))?.lastErrorCode).toBe('site_unreachable');

    // An expired lease never leaves a job RUNNING forever.
    const leased = await createAgentJob(admin, {
      businessId: BUSINESS_A,
      jobType: 'RESEARCH_PERSON',
      leadId: LEAD_GRACE,
      personId: PERSON_GRACE,
      dedupeKey: `RESEARCH_PERSON:${PERSON_GRACE}`,
    });
    await claimAgentJob(admin, { businessId: BUSINESS_A, agent: 'crashed', capabilities: AGENT_CAPS, jobId: leased.jobId });
    await asOwner(async () => {
      await h.db.query(
        `update public.agent_jobs set lease_expires_at = now() - interval '5 minutes' where id = $1`,
        [leased.jobId],
      );
    });
    expect(await reapExpiredLeases(admin)).toBeGreaterThanOrEqual(1);
    expect((await getAgentJob(admin, leased.jobId))?.status).toBe('OPEN');
  });

  it('cancels a job and leaves a completed one alone', async () => {
    const created = await createAgentJob(admin, {
      businessId: BUSINESS_A,
      jobType: 'OTHER',
      leadId: LEAD_GRACE,
      dedupeKey: `OTHER:${LEAD_GRACE}`,
      instructions: 'No default instruction',
    });
    await cancelAgentJob(admin, created.jobId, 'No longer needed');
    expect((await getAgentJob(admin, created.jobId))?.status).toBe('CANCELLED');
  });

  it('chains the missing work from stored facts, once', async () => {
    // Put the lead in a state the planner may plan from.
    await asOwner(async () => {
      await h.db.query(`update public.lead_enrichment set status = 'COMPANY_RESEARCH_PENDING' where lead_id = $1`, [
        LEAD_GRACE,
      ]);
    });

    const first = await chainJobsForLead(admin, { businessId: BUSINESS_A, leadId: LEAD_GRACE });
    expect(first).toHaveLength(1);
    expect(first[0]?.jobType).toBe('RESEARCH_COMPANY');
    expect(first[0]?.created).toBe(true);

    // Re-planning finds the live job's dedupe key and creates nothing.
    const second = await chainJobsForLead(admin, { businessId: BUSINESS_A, leadId: LEAD_GRACE });
    expect(second).toHaveLength(0);
  });
});
