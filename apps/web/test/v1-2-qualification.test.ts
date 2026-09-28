/**
 * V1.2 AI call sites: ICP qualification and reply classification.
 *
 * These are the two tasks that existed as contracts but had no caller, so this file
 * is deliberately written as *end-to-end* evidence rather than unit coverage of the
 * helpers: the qualification is planned by the real chaining planner, claimed by the
 * real processor through the real SQL claim function, run through the real runner
 * (prompt resolution, input hash, cache lookup, ledger), and persisted to
 * `lead_icp_matches` through the audited `set_primary_icp`. Reply classification
 * runs against a reply captured by the real `capture_reply`.
 *
 * A fake provider is injected everywhere, so **no test makes a network call**, and
 * the call count is itself an assertion: the properties that matter most here are
 * "identical facts cost nothing" and "changed facts cost exactly one call".
 *
 * The raw-payload rule is asserted from the other side too: a marker body is staged,
 * and the prompt the provider actually received must not contain it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { qualificationPrerequisites } from '@nexus/core';

import { classifyCapturedReply, captureReplyAndClassify } from '@/lib/ai/reply-classification';
import { processAiQueue } from '@/lib/ai/pipeline';
import { ensureDefaultPrompts } from '@/lib/ai/prompts';
import {
  buildQualificationInput,
  qualificationInputHashMatches,
  qualificationStateForLead,
  runLeadQualification,
} from '@/lib/ai/qualification';
import type { AiJsonRequest, AiProvider, AiResult } from '@/lib/ai/types';
import { loadViewer, type Viewer } from '@/lib/actor';
import type { CapturedReply } from '@/lib/repo/common';
import { chainJobsForLead, getAgentJob, listAgentJobs } from '@/lib/repo/agent-jobs';
import { captureReply } from '@/lib/repo/leads';
import { stageRaw } from '@/lib/repo/raw-staging';

import { createAppHarness, type AppHarness } from './harness';

let h: AppHarness;
let admin: Viewer;

/** The reply whose reading was stored, reused by the cache test. */
let classifiedReply: CapturedReply | undefined;

const ADMIN_ID = 'c0000000-0000-4000-8000-000000000001';
const BUSINESS = 'c0000000-0000-4000-8000-00000000000a';
const ICP_PRIMARY = 'c0000000-0000-4000-8000-0000000000c1';
const ICP_SECONDARY = 'c0000000-0000-4000-8000-0000000000c2';
const PERSON = 'c0000000-0000-4000-8000-000000000010';
const PERSON_BARE = 'c0000000-0000-4000-8000-000000000011';
const PERSON_CHAIN = 'c0000000-0000-4000-8000-000000000012';
const PERSON_REPLY = 'c0000000-0000-4000-8000-000000000013';
const PERSON_DNC = 'c0000000-0000-4000-8000-000000000014';
const COMPANY = 'c0000000-0000-4000-8000-000000000020';
const LEAD_MAIN = 'c0000000-0000-4000-8000-000000000030';
const LEAD_CHAIN = 'c0000000-0000-4000-8000-000000000031';
const LEAD_NO_COMPANY = 'c0000000-0000-4000-8000-000000000032';
const LEAD_REPLY = 'c0000000-0000-4000-8000-000000000033';
const LEAD_DNC = 'c0000000-0000-4000-8000-000000000034';
const IDENTITY = 'c0000000-0000-4000-8000-000000000040';

/** A body that exists only in staging; it must never reach a prompt or a row we write. */
const RAW_MARKER = 'RAW-PAYLOAD-MARKER-7c1f Ada Lovelace personal notes, private email ada@example.test';

const EXACT_REPLY = 'Thanks for reaching out — we might have something here. What does it cost?';
const DNC_REPLY = 'Please stop contacting me.';

/* ----------------------------------------------------------- providers --- */

type Answer = unknown | ((request: AiJsonRequest<z.ZodTypeAny>) => unknown);

function provider(
  answer: Answer,
  options: { configured?: boolean } = {},
): AiProvider & { calls: number; prompts: string[]; byOperation: Record<string, number>; callsFor(op: string): number } {
  const stub = {
    name: 'deepseek' as const,
    model: 'deepseek-chat',
    configured: options.configured ?? true,
    calls: 0,
    prompts: [] as string[],
    byOperation: {} as Record<string, number>,
    callsFor(op: string): number {
      return stub.byOperation[op] ?? 0;
    },
    async complete<Schema extends z.ZodTypeAny>(
      request: AiJsonRequest<Schema>,
    ): Promise<AiResult<z.infer<Schema>>> {
      stub.calls += 1;
      stub.byOperation[request.operation] = (stub.byOperation[request.operation] ?? 0) + 1;
      stub.prompts.push(request.user);
      const raw = typeof answer === 'function' ? answer(request) : answer;
      const parsed = request.schema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          kind: 'schema_invalid',
          error: 'The AI provider returned data that did not match the required shape.',
          retryable: false,
          status: null,
        };
      }
      return {
        ok: true,
        data: parsed.data as z.infer<Schema>,
        provenance: {
          provider: 'deepseek',
          model: 'deepseek-chat',
          promptVersionId: request.promptVersionId ?? null,
          attempts: 1,
          latencyMs: 5,
          usage: { promptTokens: 240, completionTokens: 90 },
        },
      };
    },
  };
  return stub;
}

function qualificationAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fit_score: 88,
    intent_score: 71,
    icp_id: ICP_PRIMARY,
    reasons: ['Matches the content-team ICP: Head of Content at a mid-size media company.'],
    disqualifiers: [],
    recommended_angle: 'Lead with the editorial workflow case study.',
    confidence: 0.82,
    ...overrides,
  };
}

function classificationAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome: 'Interested',
    sentiment: 'positive',
    intent: 'Asking about price before committing',
    recommended_next_action: 'Send the pricing one-pager and offer a 15-minute call.',
    reason: 'Explicit interest plus a commercial question.',
    ...overrides,
  };
}

/* --------------------------------------------------------------- owner --- */

async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  await h.db.exec('set row_security = off');
  try {
    return await fn();
  } finally {
    await h.db.exec('set row_security = on');
  }
}

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return asOwner(async () => {
    const result = await h.db.query<Record<string, unknown>>(sql, params);
    const row = result.rows[0];
    return row === undefined ? undefined : (Object.values(row)[0] as T);
  });
}

interface MatchRow {
  icp_id: string;
  is_primary: boolean;
  match_score: string | number | null;
  intent_score: number | null;
  reasons: string[] | null;
  disqualifiers: string[] | null;
  recommended_angle: string | null;
  confidence: string | number | null;
  input_hash: string | null;
  ai_run_id: string | null;
  qualified_at: string | null;
  reason: string | null;
}

async function primaryMatch(): Promise<MatchRow | undefined> {
  return asOwner(async () => {
    const result = await h.db.query<MatchRow>(
      `select m.icp_id, m.is_primary, m.match_score, m.intent_score, m.reasons, m.disqualifiers,
              m.recommended_angle, m.confidence, m.input_hash, m.ai_run_id, m.qualified_at, m.reason
         from public.lead_icp_matches m
        where m.lead_id = $1 and m.is_primary`,
      [LEAD_MAIN],
    );
    return result.rows[0];
  });
}

beforeAll(async () => {
  h = await createAppHarness();
  await h.db.exec('set row_security = off');

  await h.db.query(
    `insert into public.users (id, email, full_name, role, status)
     values ($1, 'v12-qual@nexus.test', 'V12 Qual Admin', 'admin', 'active')`,
    [ADMIN_ID],
  );
  await h.db.query(
    `insert into public.businesses (id, key, name, status, created_by)
     values ($1, 'v12-qual', 'V12 Qualification Co', 'active', $2)`,
    [BUSINESS, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.user_business_access
       (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources,
        can_use_profile_queue, can_delete_leads, created_by)
     values ($1, $2, 'admin', true, true, true, true, $1)`,
    [ADMIN_ID, BUSINESS],
  );
  await h.db.query(
    `insert into public.icps (id, business_id, name, criteria, is_default, is_active, created_by)
     values ($1, $3, 'Content leaders', '{"titles":["Head of Content"],"size":"50-500"}'::jsonb, true, true, $4),
            ($2, $3, 'Agencies', '{"company_type":"agency"}'::jsonb, false, true, $4)`,
    [ICP_PRIMARY, ICP_SECONDARY, BUSINESS, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.companies (id, name, normalized_name, primary_domain, normalized_domain, industry, employee_count, description, created_by)
     values ($1, 'Acme Media', 'acme-media', 'acme.example', 'acme.example', 'Media', 180,
             'An independent media company.', $2)`,
    [COMPANY, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.people (id, full_name, normalized_name, job_title, headline, location,
                                linkedin_url, normalized_linkedin_url, company_id, created_by)
     values ($1, 'Ada Lovelace', 'ada-lovelace', 'Head of Content', 'Editorial leader', 'London',
             'https://www.linkedin.com/in/ada-lovelace', 'https://www.linkedin.com/in/ada-lovelace', $6, $7),
            ($2, 'Grace Hopper', 'grace-hopper', null, null, null, null, null, null, $7),
            ($3, 'Alan Turing', 'alan-turing', 'Content Director', null, 'Cambridge',
             'https://www.linkedin.com/in/alan-turing', 'https://www.linkedin.com/in/alan-turing', $6, $7),
            ($4, 'Katherine Johnson', 'katherine-johnson', 'Editorial Manager', null, 'Hampton',
             'https://www.linkedin.com/in/katherine-johnson', 'https://www.linkedin.com/in/katherine-johnson', $6, $7),
            ($5, 'Barbara Liskov', 'barbara-liskov', 'Publisher', null, 'Boston',
             'https://www.linkedin.com/in/barbara-liskov', 'https://www.linkedin.com/in/barbara-liskov', $6, $7)`,
    [PERSON, PERSON_BARE, PERSON_CHAIN, PERSON_REPLY, PERSON_DNC, COMPANY, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.outreach_identities
       (id, platform, display_name, channel, profile_url, status, daily_target, created_by)
     values ($1, 'linkedin', 'Sender A1', 'linkedin', 'https://www.linkedin.com/in/sender-a1', 'active', 20, $2)`,
    [IDENTITY, ADMIN_ID],
  );
  // Invariant 14: an identity reaches a business through its own access row.
  await h.db.query(
    `insert into public.outreach_identity_business_access (outreach_identity_id, business_id, created_by)
     values ($1, $2, $3)`,
    [IDENTITY, BUSINESS, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.leads (id, business_id, person_id, company_id, primary_icp_id, outreach_identity_id,
                               owner_user_id, status, source_type, created_by)
     values ($1, $6, $8,  $10, $11, $12, $7, 'new', 'manual_add', $7),
            ($2, $6, $13, $10, $11, $12, $7, 'new', 'manual_add', $7),
            ($3, $6, $9,  null, null, $12, $7, 'new', 'manual_add', $7),
            ($4, $6, $14, $10, $11, $12, $7, 'new', 'manual_add', $7),
            ($5, $6, $15, $10, $11, $12, $7, 'new', 'manual_add', $7)`,
    [
      LEAD_MAIN,
      LEAD_CHAIN,
      LEAD_NO_COMPANY,
      LEAD_REPLY,
      LEAD_DNC,
      BUSINESS,
      ADMIN_ID,
      PERSON,
      PERSON_BARE,
      COMPANY,
      ICP_PRIMARY,
      IDENTITY,
      PERSON_CHAIN,
      PERSON_REPLY,
      PERSON_DNC,
    ],
  );
  // Structured intelligence for the two leads that should qualify: a committed
  // research summary and an active signal.
  await h.db.query(
    `insert into public.research_snapshots (business_id, lead_id, company_id, summary, findings, created_by)
     values ($1, $2, $4, 'Acme Media is hiring editors and expanding its content team.', '{}'::jsonb, $3),
            ($1, $5, $4, 'Acme Media is hiring editors and expanding its content team.', '{}'::jsonb, $3)`,
    [BUSINESS, LEAD_MAIN, ADMIN_ID, COMPANY, LEAD_CHAIN],
  );
  await h.db.query(
    `insert into public.signals (business_id, lead_id, kind, polarity, strength, label, is_active)
     values ($1, $2, 'hiring', 'positive', 80, 'Hiring two editors', true),
            ($1, $3, 'hiring', 'positive', 60, 'Hiring an editor', true),
            ($1, $4, 'hiring', 'positive', 55, 'Hiring a designer', true),
            ($1, $5, 'hiring', 'positive', 65, 'Hiring a sub-editor', true)`,
    [BUSINESS, LEAD_MAIN, LEAD_CHAIN, LEAD_REPLY, LEAD_DNC],
  );
  // The match rows the ingest path creates alongside a primary ICP: a lead that
  // names a primary ICP always has the match row that carries its assessment.
  await h.db.query(
    `insert into public.lead_icp_matches (lead_id, icp_id, is_primary, reason, created_by)
     values ($1, $5, true, 'seeded primary', $6),
            ($2, $5, true, 'seeded primary', $6),
            ($3, $5, true, 'seeded primary', $6),
            ($4, $5, true, 'seeded primary', $6)`,
    [LEAD_MAIN, LEAD_CHAIN, LEAD_REPLY, LEAD_DNC, ICP_PRIMARY, ADMIN_ID],
  );
  // A cached context pack for the main lead, so the planner has exactly one job to
  // consider (qualification) instead of also re-planning context building.
  await h.db.query(
    `insert into public.ai_context_packs (business_id, lead_id, input_hash, pack, created_by)
     values ($1, $2, 'sha256:seed', '{"person":{},"company":{}}'::jsonb, $3)`,
    [BUSINESS, LEAD_MAIN, ADMIN_ID],
  );
  // A trigger seeds a MINIMAL row per lead, so this is an update-by-insert: the
  // states below are the facts the planner reads.
  await h.db.query(
    `insert into public.lead_enrichment (business_id, lead_id, status, completeness_score, missing_fields, last_profile_enrichment_at)
     values ($1, $2, 'READY', 100, '{}'::text[], now()),
            ($1, $3, 'PROFILE_READY', 60, '{"company"}', now()),
            ($1, $4, 'NEEDS_PROFILE', 12, '{"person","company"}', now()),
            ($1, $5, 'READY', 100, '{}'::text[], now()),
            ($1, $6, 'READY', 100, '{}'::text[], now())
     on conflict (lead_id) do update
       set status = excluded.status,
           completeness_score = excluded.completeness_score,
           missing_fields = excluded.missing_fields,
           last_profile_enrichment_at = excluded.last_profile_enrichment_at`,
    [BUSINESS, LEAD_MAIN, LEAD_CHAIN, LEAD_NO_COMPANY, LEAD_REPLY, LEAD_DNC],
  );
  // The staged raw body: only the extraction path may ever read it, and nothing in
  // this file's write path may contain it.
  await h.db.query(
    `insert into public.raw_staging (business_id, lead_id, person_id, company_id, kind, source_type,
                                     payload, content_hash, status, expires_at, created_by)
     values ($1, $2, $3, $4, 'profile_paste', 'linkedin', $5, 'sha256:staged', 'PENDING', now() + interval '24 hours', $6)`,
    [BUSINESS, LEAD_MAIN, PERSON, COMPANY, RAW_MARKER, ADMIN_ID],
  );

  await h.db.exec('set row_security = on');
  admin = await loadViewer({ kind: 'user', userId: ADMIN_ID });

  // The real prompt versions, so the ledger rows name the version that ran.
  await ensureDefaultPrompts(admin);
}, 240_000);

afterAll(async () => {
  await h.close();
});

/* --------------------------------------------------------------- tests --- */

describe('qualification prerequisites', () => {
  it('refuses to score a lead with no company, and does not call a provider', async () => {
    const built = await buildQualificationInput(admin, LEAD_NO_COMPANY);
    expect(built).not.toBeNull();
    if (built === null) return;

    const readiness = qualificationPrerequisites(built.prerequisites);
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toContain('company');

    const stub = provider(qualificationAnswer());
    const outcome = await runLeadQualification(admin, { leadId: LEAD_NO_COMPANY, provider: stub });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errorCode).toBe('prerequisites_unmet');
    expect(outcome.retryable).toBe(false);
    // Zero tokens: the refusal happens before the runner is reached.
    expect(stub.calls).toBe(0);
  });
});

describe('chaining into qualification', () => {
  it('plans QUALIFY_LEAD from the facts a research hop produces', async () => {
    const state = await qualificationStateForLead(admin, LEAD_CHAIN);
    expect(state).not.toBeNull();
    if (state === null) return;
    expect(state.qualifiedForCurrentInput).toBe(false);

    const created = await chainJobsForLead(admin, {
      businessId: BUSINESS,
      leadId: LEAD_CHAIN,
      qualification: {
        prerequisites: state.prerequisites,
        qualifiedForCurrentInput: state.qualifiedForCurrentInput,
      },
    });
    const types = created.map((entry) => entry.jobType);
    expect(types).toContain('QUALIFY_LEAD');

    const jobs = await listAgentJobs(admin, { businessId: BUSINESS, limit: 50 });
    const qualification = jobs.jobs.find((job) => job.jobType === 'QUALIFY_LEAD' && job.leadId === LEAD_CHAIN);
    expect(qualification).toBeDefined();
    expect(qualification?.status).toBe('OPEN');
    expect(qualification?.dedupeKey).toBe(`QUALIFY_LEAD:${LEAD_CHAIN}:${COMPANY}`);
  });

  it('creates no second qualification job while one is open', async () => {
    const state = await qualificationStateForLead(admin, LEAD_CHAIN);
    expect(state).not.toBeNull();
    if (state === null) return;
    const again = await chainJobsForLead(admin, {
      businessId: BUSINESS,
      leadId: LEAD_CHAIN,
      qualification: {
        prerequisites: state.prerequisites,
        qualifiedForCurrentInput: state.qualifiedForCurrentInput,
      },
    });
    expect(again.map((entry) => entry.jobType)).not.toContain('QUALIFY_LEAD');

    // The plan is what this block is about, and the other jobs it created
    // (research signals, context building) belong to the extraction suites.
    // Removing them keeps the later provider-call counts in this file exact.
    await asOwner(async () => {
      await h.db.query(`delete from public.agent_jobs where lead_id = $1`, [LEAD_CHAIN]);
    });
  });
});

describe('QUALIFY_LEAD is processed by the real processor', () => {
  const stub = provider((request) =>
    request.operation === 'icp_qualification' ? qualificationAnswer() : classificationAnswer(),
  );
  let jobId = '';

  it('claims the OPEN job, runs the versioned task, and completes it only after the result is stored', async () => {
    const created = await chainJobsForLead(admin, {
      businessId: BUSINESS,
      leadId: LEAD_MAIN,
      qualification: { prerequisites: (await buildQualificationInput(admin, LEAD_MAIN))!.prerequisites, qualifiedForCurrentInput: false },
    });
    const planned = created.find((entry) => entry.jobType === 'QUALIFY_LEAD');
    expect(planned).toBeDefined();
    jobId = planned?.jobId ?? '';

    const report = await processAiQueue(admin, { businessId: BUSINESS, limit: 5, provider: stub });
    expect(report.directJobsClaimed).toBeGreaterThanOrEqual(1);
    expect(report.qualifications, JSON.stringify(report)).toBeGreaterThanOrEqual(1);
    // The typed failure this work exists to remove must not appear.
    expect(report.errors.join(' ')).not.toContain('no_processor_for_job_type');

    const job = await getAgentJob(admin, jobId);
    expect(job?.status).toBe('COMPLETE');
    expect(job?.resultAiRunId).not.toBeNull();

    // The prompt the provider saw carries committed facts only — never the staged body.
    expect(stub.prompts.some((prompt) => prompt.includes('Head of Content'))).toBe(true);
    expect(stub.prompts.some((prompt) => prompt.includes(RAW_MARKER))).toBe(false);
  });

  it('persists the primary ICP through the audited setter and the assessment on that match', async () => {
    const match = await primaryMatch();
    expect(match).toBeDefined();
    if (match === undefined) return;

    expect(match.icp_id).toBe(ICP_PRIMARY);
    expect(Number(match.match_score)).toBe(88);
    expect(match.intent_score).toBe(71);
    expect(match.reasons?.[0]).toContain('content-team ICP');
    expect(match.recommended_angle).toContain('editorial workflow');
    expect(Number(match.confidence)).toBeCloseTo(0.82, 3);
    expect(match.input_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(match.ai_run_id).not.toBeNull();
    expect(match.qualified_at).not.toBeNull();

    const primary = await scalar<string>(`select primary_icp_id::text from public.leads where id = $1`, [LEAD_MAIN]);
    expect(primary).toBe(ICP_PRIMARY);
    // No primary change happened here — the model agreed with the seeded ICP — so
    // the audited setter was not needed. The audit path itself is asserted in the
    // requalification test, where the primary really moves.
    expect(match.icp_id).toBe(primary);
  });

  it('records the run in the ledger with tokens, cost and the prompt version', async () => {
    const row = await asOwner(async () => {
      const result = await h.db.query<{
        task: string;
        status: string;
        tokens_in: number | null;
        tokens_out: number | null;
        estimated_cost_usd: string | null;
        prompt_version_id: string | null;
        input_hash: string;
      }>(
        `select task, status, tokens_in, tokens_out, estimated_cost_usd, prompt_version_id, input_hash
           from public.ai_runs
          where lead_id = $1 and task = 'ICP_QUALIFICATION'
          order by created_at desc
          limit 1`,
        [LEAD_MAIN],
      );
      return result.rows[0];
    });

    expect(row?.status).toBe('SUCCEEDED');
    expect(row?.tokens_in).toBe(240);
    expect(row?.tokens_out).toBe(90);
    expect(Number(row?.estimated_cost_usd ?? 0)).toBeGreaterThan(0);
    expect(row?.prompt_version_id).not.toBeNull();
    expect(row?.input_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('cache and requalification', () => {
  it('does not buy a second answer for identical facts', async () => {
    const stub = provider(qualificationAnswer());
    const first = await runLeadQualification(admin, { leadId: LEAD_MAIN, provider: stub });
    expect(first.ok).toBe(true);
    expect(stub.calls, JSON.stringify(first)).toBe(0);
    if (first.ok) expect(first.cached).toBe(true);

    // And the planner agrees: nothing to do for this input.
    const state = await qualificationStateForLead(admin, LEAD_MAIN);
    expect(state?.qualifiedForCurrentInput).toBe(true);
    const created = await chainJobsForLead(admin, {
      businessId: BUSINESS,
      leadId: LEAD_MAIN,
      qualification: {
        prerequisites: state!.prerequisites,
        qualifiedForCurrentInput: state!.qualifiedForCurrentInput,
      },
    });
    expect(created.map((entry) => entry.jobType)).not.toContain('QUALIFY_LEAD');
  });

  it('requalifies when the facts change, with a new input hash and a new call', async () => {
    const before = await qualificationStateForLead(admin, LEAD_MAIN);
    const previousHash = before?.inputHash ?? '';

    // A new committed signal is a fact change: nothing needs flushing.
    await asOwner(async () => {
      await h.db.query(
        `insert into public.signals (business_id, lead_id, kind, polarity, strength, label, is_active)
         values ($1, $2, 'funding', 'positive', 90, 'Raised a Series B', true)`,
        [BUSINESS, LEAD_MAIN],
      );
    });

    const after = await qualificationStateForLead(admin, LEAD_MAIN);
    expect(after?.inputHash).not.toBe(previousHash);
    expect(after?.qualifiedForCurrentInput).toBe(false);

    const created = await chainJobsForLead(admin, {
      businessId: BUSINESS,
      leadId: LEAD_MAIN,
      qualification: {
        prerequisites: after!.prerequisites,
        qualifiedForCurrentInput: after!.qualifiedForCurrentInput,
      },
    });
    expect(created.map((entry) => entry.jobType), JSON.stringify({ before, after })).toContain('QUALIFY_LEAD');

    const stub = provider(qualificationAnswer({ fit_score: 74, intent_score: 93, icp_id: ICP_SECONDARY }));
    const report = await processAiQueue(admin, { businessId: BUSINESS, limit: 5, provider: stub });
    expect(report.qualifications).toBeGreaterThanOrEqual(1);
    // Exactly one qualification, and the context pack rebuilt from the new facts —
    // which is its own model call and the reason drafting now sees the new ICP.
    expect(stub.callsFor('icp_qualification'), JSON.stringify(report)).toBe(1);
    expect(report.contextPacksRebuilt).toBeGreaterThanOrEqual(1);

    const match = await primaryMatch();
    expect(match?.icp_id).toBe(ICP_SECONDARY);
    expect(Number(match?.match_score)).toBe(74);
    expect(match?.intent_score).toBe(93);
    expect(match?.input_hash).toBe(after?.inputHash);

    // The primary moved, and moving it is the audited domain function's job.
    const primary = await scalar<string>(`select primary_icp_id::text from public.leads where id = $1`, [LEAD_MAIN]);
    expect(primary).toBe(ICP_SECONDARY);
    const audited = await scalar<number>(
      `select count(*)::int from public.audit_events
        where action ilike '%primary_icp%' or action ilike '%icp%'`,
    );
    expect(Number(audited ?? 0)).toBeGreaterThan(0);

    // The answer for the new facts is recognised as current, and the ledger shows a
    // *second* real answer: requalification appends a run, it does not rewrite one.
    const hasNew = await qualificationInputHashMatches(admin, LEAD_MAIN, after?.inputHash ?? '');
    expect(hasNew).toBe(true);
    const answers = await scalar<number>(
      `select count(*)::int from public.ai_runs
        where lead_id = $1 and task = 'ICP_QUALIFICATION' and status = 'SUCCEEDED' and cache_hit = false`,
      [LEAD_MAIN],
    );
    expect(Number(answers ?? 0)).toBe(2);
  });

  it('fails typed and leaves the lead untouched when the model answers out of schema', async () => {
    await asOwner(async () => {
      await h.db.query(
        `insert into public.signals (business_id, lead_id, kind, polarity, strength, label, is_active)
         values ($1, $2, 'leadership_change', 'positive', 70, 'Opened an office', true)`,
        [BUSINESS, LEAD_MAIN],
      );
    });

    const matchBefore = await primaryMatch();
    const stub = provider({ fit_score: 900 });
    const outcome = await runLeadQualification(admin, { leadId: LEAD_MAIN, provider: stub });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errorCode).toBe('schema_invalid');
    expect(outcome.retryable).toBe(false);

    const matchAfter = await primaryMatch();
    expect(matchAfter?.icp_id).toBe(matchBefore?.icp_id);
    expect(Number(matchAfter?.match_score)).toBe(Number(matchBefore?.match_score));
    expect(matchAfter?.input_hash).toBe(matchBefore?.input_hash);

    const failed = await scalar<number>(
      `select count(*)::int from public.ai_runs
        where lead_id = $1 and task = 'ICP_QUALIFICATION' and status = 'FAILED'`,
      [LEAD_MAIN],
    );
    expect(Number(failed ?? 0)).toBeGreaterThan(0);
  });
});

describe('reply classification', () => {
  it('saves the exact reply even when the reading fails, and reports the failure typed', async () => {
    const unconfigured = provider(classificationAnswer(), { configured: false });
    const { reply, classification } = await captureReplyAndClassify(
      { kind: 'user', userId: ADMIN_ID },
      { leadId: LEAD_REPLY, exactText: EXACT_REPLY, outcome: 'Positive / needs info', sourceClient: 'test' },
    );

    expect(reply.interactionId).not.toBeNull();
    expect(reply.outcomeId).not.toBeNull();
    expect(classification).not.toBeNull();
    expect(classification?.ok).toBe(false);
    if (classification !== null && !classification.ok) {
      expect(classification.errorCode).toBe('provider_not_configured');
    }

    // The reply is stored verbatim, and no reading row exists.
    const stored = await scalar<string>(
      `select summary from public.interactions where id = $1`,
      [reply.interactionId],
    );
    expect(stored).toBe(EXACT_REPLY);
    const readings = await scalar<number>(
      `select count(*)::int from public.interactions
        where lead_id = $1 and type = 'system' and payload ? 'ai_outcome'`,
      [LEAD_REPLY],
    );
    expect(Number(readings ?? 0)).toBe(0);
    expect(unconfigured.calls).toBe(0);
  });

  it('stores a successful reading in its own row, never overwriting the captured text or outcome', async () => {
    const stub = provider(classificationAnswer());
    const result = await captureReply(admin, {
      leadId: LEAD_REPLY,
      exactText: EXACT_REPLY,
      outcome: 'Positive / needs info',
      sourceClient: 'test',
    });
    expect(result.ok).toBe(true);
    expect(result.reply).toBeDefined();
    if (result.reply === undefined) return;

    const classified = await classifyCapturedReply(
      { kind: 'user', userId: ADMIN_ID },
      { reply: result.reply, exactText: EXACT_REPLY, provider: stub },
    );
    if (!classified.ok) throw new Error(JSON.stringify(classified));
    // The model read "Positive / needs info" as the more specific "Interested", so
    // the disagreement is *reported* — and, as the assertions below show, the
    // captured outcome is what stands.
    expect(classified.agreesWithCapturedOutcome).toBe(false);
    expect(stub.calls).toBe(1);
    classifiedReply = result.reply;

    const inbound = await asOwner(async () => {
      const r = await h.db.query<{ summary: string; payload: Record<string, unknown> }>(
        `select summary, payload from public.interactions where id = $1`,
        [result.reply?.interactionId],
      );
      return r.rows[0];
    });
    expect(inbound?.summary).toBe(EXACT_REPLY);
    expect(inbound?.payload['exact_text']).toBe(EXACT_REPLY);

    const reading = await asOwner(async () => {
      const r = await h.db.query<{ summary: string; payload: Record<string, unknown> }>(
        `select summary, payload from public.interactions where id = $1`,
        [classified.interactionId],
      );
      return r.rows[0];
    });
    expect(reading?.payload['ai_outcome']).toBe('Interested');
    expect(reading?.payload['ai_sentiment']).toBe('positive');
    expect(reading?.payload['captured_outcome']).toBe('Positive / needs info');
    expect(reading?.payload['ai_run_id']).not.toBeNull();
    expect(reading?.payload['model']).toBe('deepseek-chat');
    // The reading is separate: it does not carry a second copy of the reply text.
    expect(reading?.payload['exact_text']).toBeUndefined();
    expect(reading?.summary).not.toContain(EXACT_REPLY);

    // The outcome row keeps the operator's outcome and is not made terminal by a model.
    const outcome = await asOwner(async () => {
      const r = await h.db.query<{ outcome: string; is_terminal: boolean; reason: string | null }>(
        `select outcome, is_terminal, reason from public.conversation_outcomes where id = $1`,
        [result.reply?.outcomeId],
      );
      return r.rows[0];
    });
    expect(outcome?.outcome).toBe('Positive / needs info');
    expect(outcome?.is_terminal).toBe(false);
    expect(outcome?.reason).toContain('AI reading: Interested');
  });

  it('reuses the stored reading for the same reply instead of calling the provider again', async () => {
    /**
     * The same *reply*, not merely the same words: the input hash covers the reply
     * interaction, so a second, separately captured reply with identical text is a
     * different event and must not be served the first one's reading. This re-asks
     * about the reply whose reading already exists.
     */
    expect(classifiedReply).toBeDefined();
    if (classifiedReply === undefined) return;

    const stub = provider(classificationAnswer());
    const again = await classifyCapturedReply(
      { kind: 'user', userId: ADMIN_ID },
      { reply: classifiedReply, exactText: EXACT_REPLY, provider: stub },
    );

    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (again.ok) {
      expect(again.cached).toBe(true);
      expect(again.classification.reason).toContain('commercial question');
    }
    expect(stub.calls).toBe(0);
  });

  it('leaves DNC authoritative even when the model reads the reply as interested', async () => {
    const stub = provider(classificationAnswer({ outcome: 'Interested' }));
    const { reply, classification } = await captureReplyAndClassify(
      { kind: 'user', userId: ADMIN_ID },
      {
        leadId: LEAD_DNC,
        exactText: DNC_REPLY,
        outcome: 'Do not contact',
        sourceClient: 'test',
        provider: stub,
      },
    );

    expect(classification?.ok, JSON.stringify(classification)).toBe(true);
    if (classification !== null && classification.ok) {
      expect(classification.classification.outcome).toBe('Interested');
      expect(classification.agreesWithCapturedOutcome).toBe(false);
    }
    expect(stub.calls).toBe(1);

    const outcome = await asOwner(async () => {
      const r = await h.db.query<{ outcome: string; is_terminal: boolean }>(
        `select outcome, is_terminal from public.conversation_outcomes where id = $1`,
        [reply.outcomeId],
      );
      return r.rows[0];
    });
    // The captured outcome wins: a model's reading may not reopen a DNC.
    expect(outcome?.outcome).toBe('Do not contact');
    expect(outcome?.is_terminal).toBe(true);

    const suppression = await scalar<number>(
      `select count(*)::int from public.contact_suppressions
        where person_id = $1 and active and business_id is null`,
      [PERSON_DNC],
    );
    expect(Number(suppression ?? 0)).toBeGreaterThan(0);

    const stored = await scalar<string>(`select summary from public.interactions where id = $1`, [
      reply.interactionId,
    ]);
    expect(stored).toBe(DNC_REPLY);
  });

  it('records the classification run in the ledger with tokens and cost', async () => {
    const row = await asOwner(async () => {
      const r = await h.db.query<{
        task: string;
        status: string;
        tokens_in: number | null;
        tokens_out: number | null;
        estimated_cost_usd: string | null;
        prompt_version_id: string | null;
      }>(
        `select task, status, tokens_in, tokens_out, estimated_cost_usd, prompt_version_id
           from public.ai_runs
          where task = 'REPLY_CLASSIFICATION'
          order by created_at desc
          limit 1`,
      );
      return r.rows[0];
    });

    expect(row?.status).toBe('SUCCEEDED');
    expect(row?.tokens_in).toBe(240);
    expect(row?.tokens_out).toBe(90);
    expect(Number(row?.estimated_cost_usd ?? 0)).toBeGreaterThan(0);
    expect(row?.prompt_version_id).not.toBeNull();
  });
});

describe('no raw enrichment payload is reintroduced', () => {
  it('keeps the staged body out of every row and prompt this work writes', async () => {
    const inLedger = await scalar<number>(
      `select count(*)::int from public.ai_runs where ai_runs::text like '%RAW-PAYLOAD-MARKER%'`,
    );
    expect(Number(inLedger ?? 0)).toBe(0);

    const inInteractions = await scalar<number>(
      `select count(*)::int from public.interactions where interactions::text like '%RAW-PAYLOAD-MARKER%'`,
    );
    expect(Number(inInteractions ?? 0)).toBe(0);

    const inMatches = await scalar<number>(
      `select count(*)::int from public.lead_icp_matches where lead_icp_matches::text like '%RAW-PAYLOAD-MARKER%'`,
    );
    expect(Number(inMatches ?? 0)).toBe(0);

    // And the body is still exactly where it belongs, untouched.
    const staged = await scalar<number>(
      `select count(*)::int from public.raw_staging where payload like '%RAW-PAYLOAD-MARKER%'`,
    );
    expect(Number(staged ?? 0)).toBe(1);
  });

  it('stages nothing of its own: the qualification path writes no raw row', async () => {
    const forMain = await scalar<number>(
      `select count(*)::int from public.raw_staging where lead_id = $1`,
      [LEAD_MAIN],
    );
    expect(Number(forMain ?? 0)).toBe(1);
    // The one row is the seeded marker, not something a qualification created.
    const nonMarker = await scalar<number>(
      `select count(*)::int from public.raw_staging where lead_id = $1 and payload not like '%RAW-PAYLOAD-MARKER%'`,
      [LEAD_MAIN],
    );
    expect(Number(nonMarker ?? 0)).toBe(0);
  });
});
