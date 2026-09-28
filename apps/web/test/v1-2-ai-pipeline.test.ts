/**
 * The V1.2 AI pipeline against the real schema.
 *
 * Everything here is a release gate from spec §56, and each case exists because the
 * property is otherwise only claimed:
 *
 *   * a fake provider is injected everywhere, so **no test makes a network call**
 *     and the call count is an assertion;
 *   * the cache is keyed on the caller's input hash + the resolved prompt version +
 *     the model, so changing facts *or* the prompt version must cost a second call;
 *   * a schema-invalid answer mutates nothing, leaves a `FAILED` run with a typed
 *     code, and leaves the staged body in place for a retry;
 *   * a successful extraction commits structured facts and provenance, deletes the
 *     staged row, and advances the enrichment state — in that order;
 *   * the staged body never appears in `audit_events`, `agent_job_events` or
 *     `ai_runs`;
 *   * a context pack contains no raw body and no whole-business-brain dump, and
 *     identical facts reuse it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadViewer, type Viewer } from '@/lib/actor';
import {
  buildContextPackInput,
  getOrBuildContextPack,
} from '@/lib/ai/context-pack';
import { enrichProfileFromPaste, commitCompanyResearch } from '@/lib/ai/extract';
import { processAiQueue } from '@/lib/ai/pipeline';
import { activatePromptVersion, ensureDefaultPrompts, resolvePrompt } from '@/lib/ai/prompts';
import { estimateCostUsd, hashAiInput, runAiTask } from '@/lib/ai/runner';
import {
  claimAgentJob,
  createAgentJob,
  getAgentJob,
  submitAgentJobResult,
} from '@/lib/repo/agent-jobs';
import { loadLeadEnrichment } from '@/lib/repo/enrichment';
import { cleanupExpiredRaw, deleteRaw } from '@/lib/repo/raw-staging';
import type { AiJsonRequest, AiProvider, AiResult } from '@/lib/ai/types';

import { createAppHarness, type AppHarness } from './harness';

let h: AppHarness;
let admin: Viewer;

const ADMIN_ID = 'c0000000-0000-4000-8000-000000000001';
const BUSINESS_ID = 'c0000000-0000-4000-8000-00000000000a';
const PERSON_ID = 'c0000000-0000-4000-8000-000000000010';
const PERSON_2 = 'c0000000-0000-4000-8000-000000000011';
const PERSON_3 = 'c0000000-0000-4000-8000-000000000012';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000020';
const LEAD_ID = 'c0000000-0000-4000-8000-000000000030';
const LEAD_2 = 'c0000000-0000-4000-8000-000000000031';
const LEAD_3 = 'c0000000-0000-4000-8000-000000000032';

/** An unmistakable marker so "did the raw body leak anywhere" has an exact answer. */
const MARKER = 'RAW-BODY-MARKER-9f3a2b';
const PASTED = [
  'Ada Lovelace',
  'Head of Content at Acme Media',
  'London, United Kingdom',
  `${MARKER} we are scaling editorial output this quarter.`,
].join('\n');
const RESEARCH_BODY = `Acme Media services and hiring. ${MARKER}`;

/**
 * A claiming agent must declare the capabilities a job requires
 * (`required_capabilities <@ capabilities`), so every test agent declares all of
 * them.
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

/* ----------------------------------------------------------- providers --- */

function validatingProvider(
  value: unknown | ((request: AiJsonRequest<z.ZodTypeAny>) => unknown),
  options: { configured?: boolean } = {},
): AiProvider & { calls: number } {
  const provider = {
    name: 'deepseek' as const,
    model: 'deepseek-chat',
    configured: options.configured ?? true,
    calls: 0,
    async complete<Schema extends z.ZodTypeAny>(
      request: AiJsonRequest<Schema>,
    ): Promise<AiResult<z.infer<Schema>>> {
      provider.calls += 1;
      const raw = typeof value === 'function' ? value(request) : value;
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
          latencyMs: 7,
          usage: { promptTokens: 120, completionTokens: 80 },
        },
      };
    },
  };
  return provider;
}

/** A provider that does *not* validate, proving the runner validates anyway. */
function sloppyProvider(value: unknown): AiProvider & { calls: number } {
  const provider = {
    name: 'deepseek' as const,
    model: 'deepseek-chat',
    configured: true,
    calls: 0,
    async complete<Schema extends z.ZodTypeAny>(
      request: AiJsonRequest<Schema>,
    ): Promise<AiResult<z.infer<Schema>>> {
      provider.calls += 1;
      return {
        ok: true,
        data: value as z.infer<Schema>,
        provenance: {
          provider: 'deepseek',
          model: 'deepseek-chat',
          promptVersionId: request.promptVersionId ?? null,
          attempts: 1,
          latencyMs: 3,
          usage: null,
        },
      };
    },
  };
  return provider;
}

function failingProvider(
  kind: 'rate_limited' | 'unauthorized' | 'provider_unavailable',
): AiProvider & { calls: number } {
  const retryable = kind === 'rate_limited' || kind === 'provider_unavailable';
  const provider = {
    name: 'deepseek' as const,
    model: 'deepseek-chat',
    configured: true,
    calls: 0,
    async complete<Schema extends z.ZodTypeAny>(): Promise<AiResult<z.infer<Schema>>> {
      provider.calls += 1;
      return {
        ok: false,
        kind,
        error: 'The AI provider could not answer.',
        retryable,
        status: retryable ? 429 : 401,
      };
    },
  };
  return provider;
}

/* ------------------------------------------------------------- fixtures -- */

function profilePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    full_name: 'Ada Lovelace',
    headline: 'Head of Content at Acme Media',
    job_title: 'Head of Content',
    current_company: 'Acme Media',
    location: 'London, United Kingdom',
    linkedin_url: null,
    about_summary: 'Scaling editorial output.',
    seniority: 'senior',
    department: 'Marketing',
    experience: [{ title: 'Head of Content', company: 'Acme Media', period: '2022 — present' }],
    signals: [{ kind: 'hiring', label: 'Scaling editorial output', detail: 'Mentioned in the profile', polarity: 'positive' }],
    confidence: { full_name: 0.99, job_title: 0.9, current_company: 0.9, signals: 0.7 },
    inference_fields: ['seniority'],
    ...overrides,
  };
}

function companyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    website: 'https://acme.example',
    industry: 'Media production',
    description: 'Acme Media produces editorial content for B2B brands.',
    services: ['Editorial strategy', 'Video production'],
    size_indicators: ['20-50 employees'],
    locations: ['London'],
    hiring: true,
    job_openings: [{ title: 'Senior Editor', url: 'https://acme.example/jobs/1' }],
    content_activity: ['Weekly newsletter'],
    signals: [{ kind: 'hiring', label: 'Hiring a senior editor', detail: 'Careers page', polarity: 'positive' }],
    confidence: { website: 0.95, industry: 0.8, signals: 0.7 },
    ...overrides,
  };
}

async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  await h.db.exec('set row_security = off');
  try {
    return await fn();
  } finally {
    await h.db.exec('set row_security = on');
  }
}

async function countRows(table: string, where: string, params: readonly unknown[]): Promise<number> {
  return asOwner(async () => {
    const result = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.${table} where ${where}`,
      params as unknown[],
    );
    return Number(result.rows[0]?.n ?? 0);
  });
}

async function rawStagingCount(leadId: string): Promise<number> {
  return countRows('raw_staging', 'lead_id = $1', [leadId]);
}

/** How many rows in one table mention the staged marker anywhere in the row. */
async function rowsMentioning(table: string, columns: readonly string[]): Promise<number> {
  return asOwner(async () => {
    const predicate = columns.map((column) => `coalesce(${column}::text, '') like '%${MARKER}%'`).join(' or ');
    const result = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.${table} where ${predicate}`,
    );
    return Number(result.rows[0]?.n ?? 0);
  });
}

beforeAll(async () => {
  h = await createAppHarness();
  await h.db.exec('set row_security = off');
  await h.db.query(
    `insert into public.users (id, email, full_name, role, status)
     values ($1, 'v12-ai@nexus.test', 'V12 AI Admin', 'admin', 'active')`,
    [ADMIN_ID],
  );
  await h.db.query(
    `insert into public.businesses (id, key, name, status, created_by)
     values ($1, 'v12-ai', 'V12 AI Business', 'active', $2)`,
    [BUSINESS_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.user_business_access
       (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources,
        can_use_profile_queue, can_delete_leads, created_by)
     values ($1, $2, 'admin', true, true, true, true, $1)`,
    [ADMIN_ID, BUSINESS_ID],
  );
  await h.db.query(
    `insert into public.companies (id, name, normalized_name, primary_domain, normalized_domain, created_by)
     values ($1, 'Acme Media', 'acme-media', 'acme.example', 'acme.example', $2)`,
    [COMPANY_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.people (id, full_name, normalized_name, created_by)
     values ($1, 'Ada Lovelace', 'ada-lovelace', $4),
            ($2, 'Grace Hopper', 'grace-hopper', $4),
            ($3, 'Alan Turing', 'alan-turing', $4)`,
    [PERSON_ID, PERSON_2, PERSON_3, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.leads (id, business_id, person_id, company_id, status, source_type, created_by)
     values ($1, $4, $5, $8, 'new', 'manual_add', $9),
            ($2, $4, $6, null, 'new', 'paste_list', $9),
            ($3, $4, $7, null, 'new', 'manual_add', $9)`,
    [LEAD_ID, LEAD_2, LEAD_3, BUSINESS_ID, PERSON_ID, PERSON_2, PERSON_3, COMPANY_ID, ADMIN_ID],
  );
  // A Business Brain the pack must retrieve from selectively rather than dump.
  await h.db.query(
    `insert into public.knowledge_assets
       (business_id, type, title, description, approval_state, ai_use_allowed, created_by)
     select $1, 'Case Study', 'Approved case study ' || g, 'A verified claim about outcome ' || g,
            'approved', true, $2
       from generate_series(1, 12) as g`,
    [BUSINESS_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.offers (business_id, name, positioning, approved, created_by)
     values ($1, 'Editorial Retainer', 'Ongoing editorial output for B2B brands', true, $2)`,
    [BUSINESS_ID, ADMIN_ID],
  );
  await h.db.exec('set row_security = on');

  admin = await loadViewer({ kind: 'user', userId: ADMIN_ID });
  // Global prompt version 1, so the prompt version is part of the cache key.
  await ensureDefaultPrompts(admin);
}, 240_000);

afterAll(async () => {
  await h.close();
});

/* ---------------------------------------------------------------- tests -- */

describe('hashAiInput', () => {
  it('is stable under key order and changes when a value changes', () => {
    expect(hashAiInput({ b: 1, a: { d: 2, c: [3, 4] } })).toBe(
      hashAiInput({ a: { c: [3, 4], d: 2 }, b: 1 }),
    );
    expect(hashAiInput({ a: 1 })).not.toBe(hashAiInput({ a: 2 }));
  });
});

describe('estimateCostUsd', () => {
  it('prices a known model, and returns null rather than zero for an unknown one', () => {
    expect(estimateCostUsd('deepseek-chat', 1_000_000, 1_000_000)).toBeCloseTo(1.37, 6);
    expect(estimateCostUsd('deepseek-chat', 0, 0)).toBe(0);
    expect(estimateCostUsd('some-other-model', 10, 10)).toBeNull();
    expect(estimateCostUsd('deepseek-chat', null, null)).toBeNull();
  });
});

describe('runAiTask caching', () => {
  const cacheSchema = z.object({ value: z.string().min(1) }).strict();

  it('calls the provider once for identical input, then reuses the answer', async () => {
    const provider = validatingProvider({ value: 'cached-answer' });
    let materialised: string | null = null;

    const ctx = {
      businessId: BUSINESS_ID,
      task: 'SIGNAL_EXTRACTION' as const,
      promptKey: 'signal_extract' as const,
      leadId: LEAD_ID,
    };
    const request = {
      inputHash: hashAiInput({ fixture: 'cache-1', leadId: LEAD_ID }),
      schema: cacheSchema,
      build: () => ({ system: 'system', user: 'user' }),
      loadCached: async () => materialised,
      provider,
    };

    const first = await runAiTask<{ value: string }>(admin, ctx, request);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.cached).toBe(false);
    expect(provider.calls).toBe(1);
    materialised = first.data;

    const second = await runAiTask<{ value: string }>(admin, ctx, request);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.cached).toBe(true);
    expect(second.data.value).toBe('cached-answer');
    // No second provider call: the cache is the reason the ledger exists.
    expect(provider.calls).toBe(1);

    const cachedRows = await countRows(
      'ai_runs',
      "business_id = $1 and task = 'SIGNAL_EXTRACTION' and status = 'CACHED' and cache_hit",
      [BUSINESS_ID],
    );
    expect(cachedRows).toBeGreaterThanOrEqual(1);
  });

  it('costs a second provider call when the facts change', async () => {
    const provider = validatingProvider({ value: 'answer' });
    const schema = cacheSchema;
    const base = {
      businessId: BUSINESS_ID,
      task: 'SIGNAL_EXTRACTION' as const,
      promptKey: 'signal_extract' as const,
      leadId: LEAD_ID,
    };
    const build = () => ({ system: 's', user: 'u' });

    const one = await runAiTask<{ value: string }>(admin, base, {
      inputHash: hashAiInput({ fixture: 'changed-facts', version: 1 }),
      schema,
      build,
      provider,
    });
    expect(one.ok).toBe(true);

    const two = await runAiTask<{ value: string }>(admin, base, {
      inputHash: hashAiInput({ fixture: 'changed-facts', version: 2 }),
      schema,
      build,
      provider,
    });
    expect(two.ok).toBe(true);
    expect(provider.calls).toBe(2);
  });

  it('costs a second provider call when the prompt version changes', async () => {
    const provider = validatingProvider({ value: 'answer' });
    const inputHash = hashAiInput({ fixture: 'prompt-version' });
    const base = {
      businessId: BUSINESS_ID,
      task: 'REPLY_CLASSIFICATION' as const,
      promptKey: 'reply_classify' as const,
      leadId: LEAD_ID,
    };
    const build = () => ({ system: 's', user: 'u' });

    const before = await resolvePrompt(admin, 'reply_classify', BUSINESS_ID);
    expect(before.id).not.toBeNull();

    const one = await runAiTask<{ value: string }>(admin, base, {
      inputHash,
      schema: cacheSchema,
      build,
      provider,
    });
    expect(one.ok).toBe(true);
    expect(provider.calls).toBe(1);

    // A second global version, activated: the cache key contains the prompt
    // version, so the cache is invalidated by construction (spec §56.5).
    const versionId = await asOwner(async () => {
      const created = await h.db.query<{ id: string }>(
        `insert into public.prompt_versions
           (key, version, purpose, template, system_prompt, max_output_tokens, schema_ref, is_active, business_id)
         values ('reply_classify', 2, 'v2', 'template v2', 'system v2', 500, 'replyClassificationSchema', false, null)
         returning id`,
        [],
      );
      return created.rows[0]?.id ?? '';
    });
    // Activation runs inside its own actor transaction, so it must not be nested in
    // a `row_security = off` owner block.
    const activated = await activatePromptVersion(admin, versionId);
    expect(activated.ok).toBe(true);

    const after = await resolvePrompt(admin, 'reply_classify', BUSINESS_ID);
    expect(after.version).toBe(2);
    expect(after.id).not.toBe(before.id);

    const two = await runAiTask<{ value: string }>(admin, base, {
      inputHash,
      schema: cacheSchema,
      build,
      provider,
    });
    expect(two.ok).toBe(true);
    expect(provider.calls).toBe(2);
  });

  it('refuses a schema-invalid answer even when the provider did not validate it', async () => {
    const provider = sloppyProvider({ value: 12345 });
    const outcome = await runAiTask<{ value: string }>(
      admin,
      {
        businessId: BUSINESS_ID,
        task: 'SIGNAL_EXTRACTION',
        promptKey: 'signal_extract',
        leadId: LEAD_ID,
      },
      {
        inputHash: hashAiInput({ fixture: 'sloppy-provider' }),
        schema: cacheSchema,
        build: () => ({ system: 's', user: 'u' }),
        provider,
      },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errorCode).toBe('schema_invalid');
    expect(outcome.runId).not.toBeNull();

    const failed = await countRows(
      'ai_runs',
      "business_id = $1 and status = 'FAILED' and error_code = 'schema_invalid'",
      [BUSINESS_ID],
    );
    expect(failed).toBeGreaterThanOrEqual(1);
  });
});

describe('profile extraction', () => {
  it('commits grounded facts, records provenance, deletes the raw body and advances the state', async () => {
    const provider = validatingProvider(profilePayload());
    const outcome = await enrichProfileFromPaste(admin, {
      leadId: LEAD_ID,
      linkedinUrl: 'https://www.linkedin.com/in/ada-lovelace',
      pastedContent: PASTED,
      sourceType: 'linkedin',
      provider,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(provider.calls).toBe(1);
    expect(outcome.applied).toContain('job_title');
    expect(outcome.applied).toContain('linkedin_url');
    expect(outcome.rawDeleted).toBe(true);

    const person = await asOwner(async () => {
      const result = await h.db.query<{ job_title: string | null; location: string | null }>(
        `select job_title, location from public.people where id = $1`,
        [PERSON_ID],
      );
      return result.rows[0];
    });
    expect(person?.job_title).toBe('Head of Content');
    expect(person?.location).toBe('London, United Kingdom');

    // The staged row is gone; what remains is metadata.
    expect(await rawStagingCount(LEAD_ID)).toBe(0);

    const evidence = await asOwner(async () => {
      const result = await h.db.query<{
        raw_text_or_json: string | null;
        raw_content_hash: string | null;
        raw_bytes: number | null;
        raw_deleted_at: Date | null;
        model: string | null;
        prompt_version_id: string | null;
        extracted_at: Date | null;
      }>(
        `select raw_text_or_json, raw_content_hash, raw_bytes, raw_deleted_at, model,
                prompt_version_id, extracted_at
           from public.source_evidence
          where lead_id = $1`,
        [LEAD_ID],
      );
      return result.rows[0];
    });
    expect(evidence?.raw_content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evidence?.raw_bytes).toBeGreaterThan(0);
    expect(evidence?.model).toBe('deepseek-chat');
    expect(evidence?.prompt_version_id).not.toBeNull();
    expect(evidence?.extracted_at).not.toBeNull();
    expect(evidence?.raw_deleted_at).not.toBeNull();
    // A small structured summary, never the body.
    expect(evidence?.raw_text_or_json).not.toContain(MARKER);
    expect(JSON.parse(evidence?.raw_text_or_json ?? '{}')).toHaveProperty('fields');

    const enrichment = await loadLeadEnrichment(admin, LEAD_ID);
    expect(enrichment?.profileContentHash).toMatch(/^sha256:/);
    expect(enrichment?.lastProfileEnrichmentAt).not.toBeNull();
    expect(enrichment?.status).not.toBe('MINIMAL');

    // A signal was recorded, and it carries a derived strength rather than a
    // model-authored number.
    const signal = await asOwner(async () => {
      const result = await h.db.query<{ strength: number; kind: string }>(
        `select strength, kind from public.signals where lead_id = $1 and label = $2`,
        [LEAD_ID, 'Scaling editorial output'],
      );
      return result.rows[0];
    });
    expect(signal?.kind).toBe('hiring');
    expect(signal?.strength).toBe(70);
  });

  it('is idempotent: the same paste does not duplicate facts or signals', async () => {
    const signalsBefore = await countRows('signals', 'lead_id = $1', [LEAD_ID]);
    const evidenceBefore = await countRows('source_evidence', 'lead_id = $1', [LEAD_ID]);

    const provider = validatingProvider(profilePayload());
    const outcome = await enrichProfileFromPaste(admin, {
      leadId: LEAD_ID,
      linkedinUrl: 'https://www.linkedin.com/in/ada-lovelace',
      pastedContent: PASTED,
      sourceType: 'linkedin',
      provider,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.applied).toEqual([]);
    expect(outcome.rawDeleted).toBe(true);

    expect(await countRows('signals', 'lead_id = $1', [LEAD_ID])).toBe(signalsBefore);
    expect(await countRows('source_evidence', 'lead_id = $1', [LEAD_ID])).toBe(evidenceBefore);
    expect(await rawStagingCount(LEAD_ID)).toBe(0);
  });

  it('never lets the staged body reach the audit trail, the job events or the ledger', async () => {
    expect(await rowsMentioning('ai_runs', ['input_hash', 'error_code', 'prompt_key', 'model'])).toBe(0);
    expect(await rowsMentioning('agent_job_events', ['note', 'payload'])).toBe(0);
    expect(await rowsMentioning('audit_events', ['before_json', 'after_json'])).toBe(0);
    // And not into a canonical field either.
    expect(await rowsMentioning('people', ['headline', 'job_title', 'location', 'full_name'])).toBe(0);
    expect(await rowsMentioning('source_evidence', ['raw_text_or_json'])).toBe(0);
  });

  it('mutates nothing and keeps the staged row when the answer is schema-invalid', async () => {
    const before = await asOwner(async () => {
      const result = await h.db.query<{ job_title: string | null; company_id: string | null }>(
        `select job_title, company_id from public.people where id = $1`,
        [PERSON_2],
      );
      return result.rows[0];
    });

    const provider = sloppyProvider({ full_name: 'Grace Hopper', job_title: 42 });
    const outcome = await enrichProfileFromPaste(admin, {
      leadId: LEAD_2,
      linkedinUrl: 'https://www.linkedin.com/in/grace-hopper',
      pastedContent: `${PASTED}\nGrace Hopper variant`,
      sourceType: 'linkedin',
      provider,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errorCode).toBe('schema_invalid');
    expect(outcome.rawRetained).toBe(true);

    const after = await asOwner(async () => {
      const result = await h.db.query<{ job_title: string | null; company_id: string | null }>(
        `select job_title, company_id from public.people where id = $1`,
        [PERSON_2],
      );
      return result.rows[0];
    });
    expect(after).toEqual(before);

    // Nothing canonical was written, and the evidence row does not exist.
    expect(await countRows('source_evidence', 'lead_id = $1', [LEAD_2])).toBe(0);
    // The row is still there, marked with the typed code, for a retry inside the TTL.
    expect(await rawStagingCount(LEAD_2)).toBe(1);
    const row = await asOwner(async () => {
      const result = await h.db.query<{ status: string; last_error_code: string | null }>(
        `select status, last_error_code from public.raw_staging where lead_id = $1`,
        [LEAD_2],
      );
      return result.rows[0];
    });
    expect(row?.status).toBe('FAILED');
    expect(row?.last_error_code).toBe('schema_invalid');

    const failedRuns = await countRows(
      'ai_runs',
      "lead_id = $1 and status = 'FAILED' and error_code = 'schema_invalid'",
      [LEAD_2],
    );
    expect(failedRuns).toBeGreaterThanOrEqual(1);
  });

  it('deletes the raw row when the retry succeeds', async () => {
    const retained = await asOwner(async () => {
      const result = await h.db.query<{ id: string }>(
        `select id from public.raw_staging where lead_id = $1`,
        [LEAD_2],
      );
      return result.rows;
    });
    expect(retained.length).toBe(1);

    const provider = validatingProvider(
      profilePayload({
        full_name: 'Grace Hopper',
        job_title: 'Rear Admiral',
        current_company: null,
        location: null,
        headline: null,
      }),
    );
    const outcome = await enrichProfileFromPaste(admin, {
      leadId: LEAD_2,
      linkedinUrl: 'https://www.linkedin.com/in/grace-hopper',
      pastedContent: `${PASTED}\nGrace Hopper variant`,
      sourceType: 'linkedin',
      provider,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rawDeleted).toBe(true);

    // The retry staged its own row and deleted it, so the only staging row left for
    // this lead is the *old* failed one — which §32.2.5 keeps temporarily and the
    // 24h TTL sweep removes.
    const remaining = await asOwner(async () => {
      const result = await h.db.query<{ id: string; status: string }>(
        `select id, status from public.raw_staging where lead_id = $1`,
        [LEAD_2],
      );
      return result.rows;
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(retained[0]?.id);
    expect(remaining[0]?.status).toBe('FAILED');

    await asOwner(async () => {
      await h.db.query(
        `update public.raw_staging set expires_at = now() - interval '1 minute' where lead_id = $1`,
        [LEAD_2],
      );
    });
    expect(await cleanupExpiredRaw(admin, 200)).toBeGreaterThanOrEqual(1);
    expect(await rawStagingCount(LEAD_2)).toBe(0);

    const person = await asOwner(async () => {
      const result = await h.db.query<{ job_title: string | null }>(
        `select job_title from public.people where id = $1`,
        [PERSON_2],
      );
      return result.rows[0];
    });
    expect(person?.job_title).toBe('Rear Admiral');
  });

  it('reports a conflict with a user-confirmed value and does not overwrite it', async () => {
    await asOwner(async () => {
      await h.db.query(
        `insert into public.person_contact_points
           (person_id, kind, value, normalized_value, label, confidence, source, confirmed_by_user)
         values ($1, 'linkedin', 'https://www.linkedin.com/in/ada-confirmed',
                 'https://www.linkedin.com/in/ada-confirmed', 'Confirmed by operator', 1.0, 'manual', true)`,
        [PERSON_ID],
      );
    });

    const provider = validatingProvider(profilePayload());
    const outcome = await enrichProfileFromPaste(admin, {
      leadId: LEAD_ID,
      linkedinUrl: 'https://www.linkedin.com/in/ada-lovelace',
      pastedContent: `${PASTED}\nsecond capture`,
      sourceType: 'linkedin',
      provider,
    });

    // The identical bytes were already committed, so this is a no-op run; the
    // conflict assertion below uses a changed body to force a fresh commit.
    expect(outcome.ok).toBe(true);

    const freshProvider = validatingProvider(profilePayload({ full_name: 'Ada B Lovelace' }));
    const fresh = await enrichProfileFromPaste(admin, {
      leadId: LEAD_ID,
      linkedinUrl: 'https://www.linkedin.com/in/ada-lovelace',
      pastedContent: `${PASTED}\nthird capture, genuinely different bytes`,
      sourceType: 'linkedin',
      provider: freshProvider,
    });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.review).toContain('linkedin_url:conflicts_with_confirmed_contact_point');

    const enrichment = await loadLeadEnrichment(admin, LEAD_ID);
    expect(enrichment?.status).toBe('NEEDS_REVIEW');

    // The confirmed value is untouched.
    const confirmed = await asOwner(async () => {
      const result = await h.db.query<{ normalized_value: string }>(
        `select normalized_value from public.person_contact_points
          where person_id = $1 and confirmed_by_user and kind = 'linkedin'`,
        [PERSON_ID],
      );
      return result.rows[0];
    });
    expect(confirmed?.normalized_value).toBe('https://www.linkedin.com/in/ada-confirmed');
  });
});

describe('context pack', () => {
  it('is reproducible from the same facts and contains no raw body', async () => {
    const first = await buildContextPackInput(admin, LEAD_ID);
    const second = await buildContextPackInput(admin, LEAD_ID);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (first === null || second === null) return;

    // `builtAt` moves; the hash must not.
    expect(first.inputHash).toBe(second.inputHash);
    expect(first.businessId).toBe(BUSINESS_ID);
    expect(JSON.stringify(first.pack)).not.toContain(MARKER);
    // Retrieval is bounded, never the whole Business Brain.
    expect(first.pack.approvedClaims.length).toBeLessThanOrEqual(8);
    expect(first.pack.channels).toHaveLength(4);
    expect(first.pack.builtAt.length).toBeGreaterThan(0);
    expect(first.sourceSummary).toHaveProperty('signalCount');
  });

  it('caches a pack for identical facts and rebuilds it when a fact changes', async () => {
    const provider = validatingProvider((request) => {
      // Echo the supplied fact set, which is exactly what a compliant model must do
      // for every non-narrative field.
      const match = /PERMANENT FACTS[^\n]*\n\n(\{.*\})/s.exec(request.user);
      const pack = JSON.parse(match?.[1] ?? '{}') as Record<string, unknown>;
      const person = pack['person'] as Record<string, unknown>;
      const company = pack['company'] as Record<string, unknown>;
      person['summary'] = 'Ada runs content at Acme Media.';
      company['summary'] = 'Acme Media is an editorial production company.';
      company['services'] = ['Editorial strategy'];
      return pack;
    });

    const first = await getOrBuildContextPack(admin, LEAD_ID, { provider });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.cached).toBe(false);
    expect(first.pack.person.summary).toBe('Ada runs content at Acme Media.');
    const callsAfterFirst = provider.calls;

    const second = await getOrBuildContextPack(admin, LEAD_ID, { provider });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.cached).toBe(true);
    expect(provider.calls).toBe(callsAfterFirst);

    const stored = await countRows('ai_context_packs', 'lead_id = $1', [LEAD_ID]);
    expect(stored).toBeGreaterThanOrEqual(1);

    // A new fact changes the input hash, so the pack is rebuilt rather than reused.
    await asOwner(async () => {
      await h.db.query(
        `insert into public.signals (business_id, lead_id, kind, polarity, strength, label, is_active)
         values ($1, $2, 'funding', 'positive', 60, 'Raised a Series A', true)`,
        [BUSINESS_ID, LEAD_ID],
      );
    });

    const third = await getOrBuildContextPack(admin, LEAD_ID, { provider });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.cached).toBe(false);
    expect(provider.calls).toBeGreaterThan(callsAfterFirst);

    const packs = await countRows('ai_context_packs', 'lead_id = $1', [LEAD_ID]);
    expect(packs).toBeGreaterThanOrEqual(2);

    const enrichment = await loadLeadEnrichment(admin, LEAD_ID);
    expect(enrichment?.lastContextBuildAt).not.toBeNull();
  });
});

describe('processAiQueue', () => {
  it('completes a WAITING_AI job only after extraction and raw deletion', async () => {
    const created = await createAgentJob(admin, {
      businessId: BUSINESS_ID,
      jobType: 'RESEARCH_COMPANY',
      leadId: LEAD_3,
      personId: PERSON_2,
      dedupeKey: `RESEARCH_COMPANY:${LEAD_3}`,
      reason: 'fixture: processor happy path',
    });
    await claimAgentJob(admin, { businessId: BUSINESS_ID, agent: 'opencode', capabilities: AGENT_CAPS, jobId: created.jobId });
    const submitted = await submitAgentJobResult(admin, {
      jobId: created.jobId,
      agent: 'opencode',
      payload: RESEARCH_BODY,
      kind: 'company_research',
      sourceType: 'web',
      sourceUrl: 'https://acme.example',
    });
    expect(submitted.status).toBe('WAITING_AI');

    const provider = validatingProvider(companyPayload());
    const report = await processAiQueue(admin, { businessId: BUSINESS_ID, limit: 5, provider });

    expect(report.jobsClaimed).toBeGreaterThanOrEqual(1);
    expect(report.jobsCompleted).toBeGreaterThanOrEqual(1);
    expect(report.rawDeleted).toBeGreaterThanOrEqual(1);
    expect(report.jobsFailed).toBe(0);

    expect((await getAgentJob(admin, created.jobId))?.status).toBe('COMPLETE');
    expect(await countRows('raw_staging', 'agent_job_id = $1', [created.jobId])).toBe(0);

    const evidence = await asOwner(async () => {
      const result = await h.db.query<{ raw_deleted_at: Date | null; model: string | null; raw_bytes: number | null }>(
        `select raw_deleted_at, model, raw_bytes from public.source_evidence where lead_id = $1`,
        [LEAD_3],
      );
      return result.rows[0];
    });
    expect(evidence?.raw_deleted_at).not.toBeNull();
    expect(evidence?.model).toBe('deepseek-chat');
    expect(evidence?.raw_bytes).toBeGreaterThan(0);

    const snapshots = await countRows('research_snapshots', 'lead_id = $1', [LEAD_3]);
    expect(snapshots).toBeGreaterThanOrEqual(1);

    const enrichment = await loadLeadEnrichment(admin, LEAD_3);
    expect(enrichment?.lastCompanyEnrichmentAt).not.toBeNull();

    // The chain continued: a signals job is now queued for this lead.
    const chained = await countRows(
      'agent_jobs',
      "lead_id = $1 and job_type = 'RESEARCH_SIGNALS' and status = 'OPEN'",
      [LEAD_3],
    );
    expect(chained).toBeGreaterThanOrEqual(1);
  });

  it('retries a retryable failure from the same staged row, and only then completes', async () => {
    const created = await createAgentJob(admin, {
      businessId: BUSINESS_ID,
      jobType: 'RESEARCH_SIGNALS',
      leadId: LEAD_2,
      personId: PERSON_2,
      dedupeKey: `RESEARCH_SIGNALS:${LEAD_2}`,
      reason: 'fixture: retryable failure',
    });
    await claimAgentJob(admin, { businessId: BUSINESS_ID, agent: 'opencode', capabilities: AGENT_CAPS, jobId: created.jobId });
    const submitted = await submitAgentJobResult(admin, {
      jobId: created.jobId,
      agent: 'opencode',
      payload: `${RESEARCH_BODY} retryable`,
      kind: 'signal_research',
      sourceType: 'web',
    });

    const failing = failingProvider('rate_limited');
    const first = await processAiQueue(admin, { businessId: BUSINESS_ID, limit: 5, provider: failing });

    expect(first.jobsFailed).toBeGreaterThanOrEqual(1);
    // The job holds no lease in WAITING_AI, so it is not a lease expiry: it stays
    // waiting for the next pass, with the same staged row to retry (§50.3, §31.3).
    expect((await getAgentJob(admin, created.jobId))?.status).toBe('WAITING_AI');
    expect(await countRows('raw_staging', 'agent_job_id = $1', [created.jobId])).toBe(1);

    const staged = await asOwner(async () => {
      const result = await h.db.query<{ id: string; status: string; last_error_code: string | null }>(
        `select id, status, last_error_code from public.raw_staging where agent_job_id = $1`,
        [created.jobId],
      );
      return result.rows[0];
    });
    expect(staged?.id).toBe(submitted.rawStagingId);
    expect(staged?.status).toBe('FAILED');
    expect(staged?.last_error_code).toBe('rate_limited');

    // The next pass must reuse the *same* row: a second staged row for one job would
    // make `nexus_complete_agent_job` refuse for ever, because it counts every
    // un-consumed row for the job. The lease has to lapse first — the failed attempt
    // deliberately leaves `WAITING_AI` alone rather than re-opening the job.
    await asOwner(async () => {
      await h.db.query(
        `update public.agent_jobs set lease_expires_at = now() - interval '1 minute' where id = $1`,
        [created.jobId],
      );
    });

    const working = validatingProvider(companyPayload());
    const second = await processAiQueue(admin, { businessId: BUSINESS_ID, limit: 5, provider: working });

    expect(second.jobsCompleted).toBeGreaterThanOrEqual(1);
    expect(working.calls).toBe(1);
    expect((await getAgentJob(admin, created.jobId))?.status).toBe('COMPLETE');
    expect(await countRows('raw_staging', 'agent_job_id = $1', [created.jobId])).toBe(0);
    expect(await countRows('raw_staging', 'id = $1', [submitted.rawStagingId])).toBe(0);
  });

  it('fails a job terminally when the provider refuses without retrying', async () => {
    const created = await createAgentJob(admin, {
      businessId: BUSINESS_ID,
      jobType: 'RESEARCH_COMPANY',
      leadId: LEAD_2,
      personId: PERSON_2,
      dedupeKey: `RESEARCH_COMPANY:${LEAD_2}`,
      reason: 'fixture: terminal failure',
    });
    await claimAgentJob(admin, { businessId: BUSINESS_ID, agent: 'opencode', capabilities: AGENT_CAPS, jobId: created.jobId });
    const submitted = await submitAgentJobResult(admin, {
      jobId: created.jobId,
      agent: 'opencode',
      payload: `${RESEARCH_BODY} terminal`,
      kind: 'company_research',
      sourceType: 'web',
    });

    const provider = failingProvider('unauthorized');
    const report = await processAiQueue(admin, { businessId: BUSINESS_ID, limit: 5, provider });

    expect(report.jobsFailed).toBeGreaterThanOrEqual(1);
    const job = await getAgentJob(admin, created.jobId);
    expect(job?.status).toBe('FAILED');
    expect(job?.lastErrorCode).toBe('unauthorized');
    // The evidence is retained for the TTL sweep rather than silently dropped.
    expect(await countRows('raw_staging', 'agent_job_id = $1', [created.jobId])).toBe(1);

    await deleteRaw(admin, submitted.rawStagingId);
  });

  it('fails a job with no staged evidence without calling the provider', async () => {
    const created = await createAgentJob(admin, {
      businessId: BUSINESS_ID,
      jobType: 'RESEARCH_COMPANY',
      leadId: LEAD_ID,
      dedupeKey: `RESEARCH_COMPANY:${LEAD_ID}`,
      reason: 'fixture: missing evidence',
    });
    // A `WAITING_AI` job with no `result_submitted` event: nothing to extract.
    await asOwner(async () => {
      await h.db.query(
        `update public.agent_jobs set status = 'WAITING_AI', lease_expires_at = null where id = $1`,
        [created.jobId],
      );
    });

    const provider = validatingProvider(companyPayload());
    const report = await processAiQueue(admin, { businessId: BUSINESS_ID, limit: 5, provider });

    expect(report.jobsFailed).toBeGreaterThanOrEqual(1);
    expect(report.errors.some((entry) => entry.includes('raw_staging_missing'))).toBe(true);
    // The whole point: no model call was paid for.
    expect(provider.calls).toBe(0);
    expect((await getAgentJob(admin, created.jobId))?.status).toBe('FAILED');
  });

  it('refuses an unauthenticated processor sweep', async () => {
    const anonymous = await loadViewer({ kind: 'service' });
    // A service actor with no api-client identity cannot sweep every business; the
    // claim is refused and the report says so rather than throwing.
    const report = await processAiQueue(anonymous, { limit: 5 });
    expect(report.jobsClaimed).toBe(0);
    expect(report.errors.some((entry) => entry.includes('claim_ai_work_failed'))).toBe(true);
  });
});

describe('prompt library', () => {
  it('seeds every key once and resolves a business override ahead of the global default', async () => {
    await ensureDefaultPrompts(admin);
    const globals = await asOwner(async () => {
      const result = await h.db.query<{ key: string; version: number }>(
        `select key, version from public.prompt_versions where business_id is null order by key`,
      );
      return result.rows;
    });
    // Twelve keys, one global version each (the reply_classify v2 added above is
    // inactive, so it does not appear twice in the resolution).
    expect(new Set(globals.map((row) => row.key)).size).toBe(12);

    const resolved = await resolvePrompt(admin, 'email_initial', BUSINESS_ID);
    expect(resolved.key).toBe('email_initial');
    expect(resolved.system.length).toBeGreaterThan(0);
    expect(resolved.template.length).toBeGreaterThan(0);
    expect(resolved.id).not.toBeNull();
  });

  it('refuses activation for a non-administrator', async () => {
    const member = { ...admin, role: 'manager' as const };
    const result = await activatePromptVersion(member, 'c0000000-0000-4000-8000-0000000000ff');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/administrator/i);
  });
});

describe('service actors', () => {
  it('exposes a service actor that the enrichment path refuses politely', async () => {
    // A service actor has no tenant identity; RLS makes the lead invisible, so the
    // first honest answer is "not found" rather than a crash.
    const service = await loadViewer({ kind: 'service' });
    const outcome = await commitCompanyResearch(service, {
      jobId: 'c0000000-0000-4000-8000-0000000000ff',
      agent: 'nobody',
      payload: 'irrelevant',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errorCode).toBe('job_not_found');
  });
});
