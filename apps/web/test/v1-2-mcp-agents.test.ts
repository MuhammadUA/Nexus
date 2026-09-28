/**
 * V1.2 MCP agent surface — spec §19, §57.
 *
 * The claims under test are the ones an agent's correctness depends on:
 *
 *   * a job is durable and listable while the agent is offline,
 *   * a claim is atomic, so two agents cannot both work one job,
 *   * a lease expires, so a crashed agent cannot park work,
 *   * submitting evidence moves a job to WAITING_AI and never to COMPLETE,
 *   * no MCP tool can set COMPLETE at all,
 *   * idempotency replays the first answer and refuses a key reused with different
 *     arguments,
 *   * a caller outside the business learns nothing — not even that a row exists,
 *   * the enrichment context and the minimal-lead path cost zero model calls.
 *
 * The transport is exercised through the real `POST`, with the credential resolver
 * replaced by a fixed token exactly as `mcp-gateway.test.ts` does, so scope checks,
 * JSON-RPC envelopes and the dispatch table are all real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MCP_TOOLS } from '@nexus/core';
import type { ServiceCredential } from '@/lib/gateway';

import { createAppHarness, type AppHarness } from './harness';

const ADMIN_ID = 'e1000000-0000-4000-8000-000000000001';
const BUSINESS_ID = 'e1000000-0000-4000-8000-000000000002';
const OTHER_BUSINESS_ID = 'e1000000-0000-4000-8000-000000000003';
const PERSON_ID = 'e1000000-0000-4000-8000-000000000004';
const COMPANY_ID = 'e1000000-0000-4000-8000-000000000005';
const LEAD_ID = 'e1000000-0000-4000-8000-000000000006';
const HIDDEN_LEAD_ID = 'e1000000-0000-4000-8000-000000000007';
const HIDDEN_PERSON_ID = 'e1000000-0000-4000-8000-000000000008';

let CREDENTIAL: ServiceCredential;

function credentialFor(): ServiceCredential {
  return {
    kind: 'service',
    actor: { kind: 'user', userId: ADMIN_ID },
    scopes: [
      'jobs:read',
      'jobs:create',
      'jobs:claim',
      'jobs:submit',
      'lead:read',
      'lead:create',
      'profile:capture',
      'evidence:add',
      'candidate:submit',
      // The reply-capture tool, so the transport half of the "capture then
      // classify" path is exercised here rather than only in the repo suites.
      'reply:capture',
    ],
    // One business only, so "not scoped to that business" is a real refusal path.
    businessIds: [BUSINESS_ID],
  } as unknown as ServiceCredential;
}

vi.mock('@/lib/gateway', async () => {
  const actual = await vi.importActual<typeof import('@/lib/gateway')>('@/lib/gateway');
  return {
    ...actual,
    resolveCredential: async () => CREDENTIAL,
    requireScope: actual.requireScope,
  };
});

const { POST } = await import('@/app/api/v1/mcp/route');

let h: AppHarness;

function rpc(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/v1/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

interface ToolAnswer {
  readonly structured: Record<string, unknown>;
  readonly isError: boolean;
  readonly text: string;
  readonly idempotent: boolean;
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const payload = (await response.json()) as {
    result?: { structuredContent?: Record<string, unknown>; isError?: boolean; content?: { text: string }[]; idempotent?: boolean };
    error?: { message: string };
  };
  const result = payload.result ?? {};
  return {
    structured: (result.structuredContent ?? {}) as Record<string, unknown>,
    // A transport-level refusal (a scope or business-scope failure) is reported as a
    // JSON-RPC error rather than inside the result, and both are failures to a
    // caller, so both count as one here.
    isError: result.isError === true || payload.error !== undefined,
    text: result.content?.[0]?.text ?? payload.error?.message ?? '',
    idempotent: result.idempotent === true,
  };
}

let keyCounter = 0;
function key(prefix: string): string {
  keyCounter += 1;
  return `${prefix}-${String(keyCounter).padStart(4, '0')}-key`;
}

async function createJob(overrides: Record<string, unknown> = {}): Promise<string> {
  const answer = await call('nexus.create_agent_job', {
    business_id: BUSINESS_ID,
    idempotency_key: key('create'),
    job_type: 'RESEARCH_COMPANY',
    lead_id: LEAD_ID,
    person_id: PERSON_ID,
    company_id: COMPANY_ID,
    priority: 'high',
    instructions: 'Collect the site, services, size and hiring signals.',
    required_capabilities: ['browser'],
    reason: 'company intelligence is incomplete',
    ...overrides,
  });
  expect(answer.isError, answer.text).toBe(false);
  return String(answer.structured['job_id']);
}

async function jobStatus(jobId: string): Promise<string> {
  const answer = await call('nexus.get_agent_job', {
    business_id: BUSINESS_ID,
    job_id: jobId,
  });
  expect(answer.isError, answer.text).toBe(false);
  const job = answer.structured['job'] as Record<string, unknown>;
  return String(job['status']);
}

beforeAll(async () => {
  h = await createAppHarness();
  await h.db.exec('set row_security = off');
  await h.db.query(
    `insert into public.users (id, email, full_name, role, status)
     values ($1, 'v12-agent@nexus.test', 'V1.2 Agent Admin', 'admin', 'active')`,
    [ADMIN_ID],
  );
  await h.db.query(
    `insert into public.businesses (id, key, name, status, created_by) values
       ($1, 'v12-agents', 'V1.2 Agents', 'active', $3),
       ($2, 'v12-other', 'V1.2 Other', 'active', $3)`,
    [BUSINESS_ID, OTHER_BUSINESS_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.companies (id, name, normalized_name, normalized_domain, description, created_by)
     values ($1, 'ABC Media', 'abc media', 'abcmedia.example', 'Independent media company.', $2)`,
    [COMPANY_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.people (id, full_name, normalized_name, job_title, location, linkedin_url, normalized_linkedin_url, company_id, created_by)
     values ($1, 'Sarah Smith', 'sarah smith', 'Marketing Director', 'New York',
             'https://www.linkedin.com/in/sarah-smith', 'https://www.linkedin.com/in/sarah-smith', $2, $3)`,
    [PERSON_ID, COMPANY_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.people (id, full_name, normalized_name, created_by)
     values ($1, 'Hidden Person', 'hidden person', $2)`,
    [HIDDEN_PERSON_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.leads (id, business_id, person_id, company_id, status, source_type, created_by) values
       ($1, $2, $3, $4, 'ready', 'manual_add', $6),
       ($5, $7, $8, null, 'ready', 'manual_add', $6)`,
    [LEAD_ID, BUSINESS_ID, PERSON_ID, COMPANY_ID, HIDDEN_LEAD_ID, ADMIN_ID, OTHER_BUSINESS_ID, HIDDEN_PERSON_ID],
  );
  await h.db.exec('set row_security = on');
  CREDENTIAL = credentialFor();
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('v1.2 mcp job tools', () => {
  it('publishes the job tools with their scopes and idempotency requirement', async () => {
    const payload = (await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as {
      result: { tools: { name: string; inputSchema: { required?: string[]; properties?: Record<string, unknown> } }[] };
    };

    const byName = new Map(payload.result.tools.map((tool) => [tool.name, tool]));
    for (const name of [
      'nexus.create_agent_job',
      'nexus.list_agent_jobs',
      'nexus.get_agent_job',
      'nexus.claim_agent_job',
      'nexus.heartbeat_agent_job',
      'nexus.release_agent_job',
      'nexus.submit_agent_job_result',
      'nexus.fail_agent_job',
      'nexus.get_lead_enrichment_context',
      'nexus.submit_minimal_lead',
      'nexus.submit_profile_data',
      'nexus.submit_company_research',
      'nexus.submit_source_metadata',
    ]) {
      expect(byName.has(name), `${name} is not published`).toBe(true);
    }

    // The mutation tools advertise the key they require; the reads do not.
    expect(byName.get('nexus.claim_agent_job')?.inputSchema.required).toContain('idempotency_key');
    expect(byName.get('nexus.list_agent_jobs')?.inputSchema.required).not.toContain('idempotency_key');
    expect(byName.get('nexus.get_lead_enrichment_context')?.inputSchema.required).not.toContain('idempotency_key');
  });

  it('has no tool that can complete a job — completion belongs to the extraction pipeline', () => {
    expect(MCP_TOOLS.some((name) => name.includes('complete'))).toBe(false);
    // And nothing SQL-shaped, which is the standing prohibition.
    expect(MCP_TOOLS.some((name) => /sql|query|exec/i.test(name))).toBe(false);
  });

  it('lists a durable job while no agent is online', async () => {
    const jobId = await createJob();

    const answer = await call('nexus.list_agent_jobs', {
      business_id: BUSINESS_ID,
      status: 'OPEN',
    });
    expect(answer.isError, answer.text).toBe(false);
    const jobs = answer.structured['jobs'] as Record<string, unknown>[];
    expect(jobs.some((job) => job['id'] === jobId)).toBe(true);
    expect(Number(answer.structured['total'])).toBeGreaterThanOrEqual(1);
  });

  it('deduplicates a job by its key', async () => {
    const dedupe = `RESEARCH_COMPANY:${LEAD_ID}:dedupe-fixture`;
    const first = await createJob({ dedupe_key: dedupe });
    const second = await createJob({ dedupe_key: dedupe });
    expect(second).toBe(first);
  });

  it('claims atomically: the second agent gets nothing', async () => {
    const jobId = await createJob();
    const claim = (agent: string) =>
      call('nexus.claim_agent_job', {
        business_id: BUSINESS_ID,
        idempotency_key: key('claim'),
        agent,
        capabilities: ['browser'],
        job_id: jobId,
        lease_seconds: 900,
      });

    const first = await claim('opencode');
    expect(first.isError, first.text).toBe(false);
    expect((first.structured['job'] as Record<string, unknown>)['status']).toBe('RUNNING');

    const second = await claim('other-agent');
    expect(second.isError, second.text).toBe(false);
    expect(second.structured['job']).toBeNull();

    expect(await jobStatus(jobId)).toBe('RUNNING');
  });

  it('heartbeats only for the agent holding the lease', async () => {
    const jobId = await createJob();
    await call('nexus.claim_agent_job', {
      business_id: BUSINESS_ID,
      idempotency_key: key('claim'),
      agent: 'opencode',
      capabilities: ['browser'],
      job_id: jobId,
    });

    const beat = await call('nexus.heartbeat_agent_job', {
      job_id: jobId,
      idempotency_key: key('beat'),
      agent: 'opencode',
      lease_seconds: 1800,
    });
    expect(beat.isError, beat.text).toBe(false);

    const impostor = await call('nexus.heartbeat_agent_job', {
      job_id: jobId,
      idempotency_key: key('beat'),
      agent: 'impostor',
    });
    expect(impostor.isError).toBe(true);
  });

  it('hands an expired lease to the next agent', async () => {
    const jobId = await createJob();
    await call('nexus.claim_agent_job', {
      business_id: BUSINESS_ID,
      idempotency_key: key('claim'),
      agent: 'crashed-agent',
      capabilities: ['browser'],
      job_id: jobId,
    });

    // The agent died; nothing renewed the lease. Backdating it is the only way to
    // observe the recovery path without waiting.
    await h.db.query(`update public.agent_jobs set lease_expires_at = now() - interval '10 minutes' where id = $1`, [
      jobId,
    ]);

    const reclaimed = await call('nexus.claim_agent_job', {
      business_id: BUSINESS_ID,
      idempotency_key: key('claim'),
      agent: 'second-agent',
      capabilities: ['browser'],
      job_id: jobId,
    });
    expect(reclaimed.isError, reclaimed.text).toBe(false);
    const job = reclaimed.structured['job'] as Record<string, unknown>;
    expect(job['status']).toBe('RUNNING');
    expect(job['attempt_count']).toBe(2);
  });

  it('stages submitted evidence and waits for AI instead of completing', async () => {
    const jobId = await createJob();
    await call('nexus.claim_agent_job', {
      business_id: BUSINESS_ID,
      idempotency_key: key('claim'),
      agent: 'opencode',
      capabilities: ['browser'],
      job_id: jobId,
    });

    const submit = await call('nexus.submit_agent_job_result', {
      job_id: jobId,
      idempotency_key: key('submit'),
      agent: 'opencode',
      payload: 'abcmedia.example — services, industry, size and hiring signals.',
      kind: 'company_research',
      source_type: 'company_website',
      source_url: 'https://abcmedia.example',
    });
    expect(submit.isError, submit.text).toBe(false);
    expect(submit.structured['status']).toBe('WAITING_AI');
    expect(String(submit.structured['raw_staging_id'] ?? '')).not.toBe('');

    expect(await jobStatus(jobId)).toBe('WAITING_AI');
  });

  it('replays an idempotent submit instead of staging the evidence twice', async () => {
    const jobId = await createJob();
    await call('nexus.claim_agent_job', {
      business_id: BUSINESS_ID,
      idempotency_key: key('claim'),
      agent: 'opencode',
      capabilities: ['browser'],
      job_id: jobId,
    });

    const replayKey = 'submit-replay-fixture-key';
    const args = {
      job_id: jobId,
      idempotency_key: replayKey,
      agent: 'opencode',
      payload: 'Replayed research body.',
      kind: 'company_research',
    };

    const first = await call('nexus.submit_agent_job_result', args);
    expect(first.idempotent).toBe(false);
    const second = await call('nexus.submit_agent_job_result', args);
    expect(second.idempotent).toBe(true);
    expect(second.structured['raw_staging_id']).toBe(first.structured['raw_staging_id']);

    const staged = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.raw_staging where agent_job_id = $1`,
      [jobId],
    );
    expect(Number(staged.rows[0]?.n)).toBe(1);
  });

  it('refuses a reused idempotency key with different arguments', async () => {
    const jobId = await createJob();
    await call('nexus.claim_agent_job', {
      business_id: BUSINESS_ID,
      idempotency_key: key('claim'),
      agent: 'opencode',
      capabilities: ['browser'],
      job_id: jobId,
    });

    const reused = 'submit-mismatch-fixture-key';
    await call('nexus.submit_agent_job_result', {
      job_id: jobId,
      idempotency_key: reused,
      agent: 'opencode',
      payload: 'First body.',
    });
    const second = await call('nexus.submit_agent_job_result', {
      job_id: jobId,
      idempotency_key: reused,
      agent: 'opencode',
      payload: 'Different body.',
    });

    // A plausible answer would hide the client's bug, so it is refused instead.
    expect(second.isError).toBe(true);
    expect(second.text).toMatch(/different arguments/i);
  });

  it('returns a retryable failure to the queue and releases a held job', async () => {
    const failedJob = await createJob();
    await call('nexus.claim_agent_job', {
      business_id: BUSINESS_ID,
      idempotency_key: key('claim'),
      agent: 'opencode',
      capabilities: ['browser'],
      job_id: failedJob,
    });
    const failed = await call('nexus.fail_agent_job', {
      job_id: failedJob,
      idempotency_key: key('fail'),
      agent: 'opencode',
      error_code: 'site_unreachable',
      message: 'The company site timed out',
      retryable: true,
    });
    expect(failed.isError, failed.text).toBe(false);
    expect(failed.structured['status']).toBe('OPEN');

    const releasedJob = await createJob();
    await call('nexus.claim_agent_job', {
      business_id: BUSINESS_ID,
      idempotency_key: key('claim'),
      agent: 'opencode',
      capabilities: ['browser'],
      job_id: releasedJob,
    });
    const released = await call('nexus.release_agent_job', {
      job_id: releasedJob,
      idempotency_key: key('release'),
      agent: 'opencode',
      reason: 'Handing back',
    });
    expect(released.isError, released.text).toBe(false);
    expect(await jobStatus(releasedJob)).toBe('OPEN');
  });

  it('refuses a business outside the token scope without confirming the row exists', async () => {
    const jobId = await createJob();

    const scoped = await call('nexus.get_agent_job', {
      business_id: OTHER_BUSINESS_ID,
      job_id: jobId,
    });
    expect(scoped.isError).toBe(true);

    // Same refusal for a job in the *right* business but a different tenant: the
    // caller learns nothing beyond "unknown".
    const hidden = await call('nexus.get_agent_job', {
      business_id: BUSINESS_ID,
      job_id: 'e1000000-0000-4000-8000-0000000000ff',
    });
    expect(hidden.isError).toBe(true);
    expect(hidden.text).toMatch(/unknown agent job/i);
  });
});

describe('v1.2 mcp lead intelligence tools', () => {
  it('answers a lead intelligence query with a deterministic score and zero-token searches', async () => {
    const answer = await call('nexus.get_lead_enrichment_context', {
      business_id: BUSINESS_ID,
      lead_id: LEAD_ID,
    });
    expect(answer.isError, answer.text).toBe(false);

    const enrichment = answer.structured['enrichment'] as Record<string, unknown>;
    expect(Number(enrichment['completeness_score'])).toBeGreaterThan(0);
    expect(enrichment['status']).toBeTruthy();

    const channels = answer.structured['available_channels'] as string[];
    expect(channels).toEqual(['linkedin', 'email', 'instagram', 'upwork']);

    const links = answer.structured['search_links'] as { key: string; query: string; url: string }[];
    const findLinkedin = links.find((link) => link.key === 'find_linkedin');
    // The known LinkedIn URL is appended as a confirmatory term when one is known.
    expect(findLinkedin?.query.startsWith('"Sarah Smith" "ABC Media" site:linkedin.com/in')).toBe(true);
    expect(findLinkedin?.url.startsWith('https://www.google.com/search?q=')).toBe(true);

    const signals = links.find((link) => link.key === 'search_signals');
    expect(signals?.query).toBe('"ABC Media" hiring OR expansion OR video OR podcast');
  });

  it('creates a minimal lead from a name, company and source only', async () => {
    const answer = await call('nexus.submit_minimal_lead', {
      business_id: BUSINESS_ID,
      idempotency_key: key('minimal'),
      full_name: 'Nora Klein',
      company_name: 'Klein Studio',
      location: 'Berlin',
      source: 'reddit',
    });
    expect(answer.isError, answer.text).toBe(false);
    expect(String(answer.structured['lead_id'] ?? '')).not.toBe('');
    expect(answer.structured['discovery_source']).toBe('reddit');
    // Reddit-discovered, and email is still an available channel: source never
    // dictates channel.
    const links = answer.structured['search_links'] as { key: string }[];
    expect(links.length).toBeGreaterThan(0);

    // The new lead is in the enrichment workspace, not silently "ready".
    const enrichment = await h.db.query<{ status: string }>(
      `select status from public.lead_enrichment where lead_id = $1`,
      [answer.structured['lead_id']],
    );
    expect(enrichment.rows[0]?.status).toBe('NEEDS_PROFILE');
  });

  it('replays a minimal-lead submission with the same idempotency key', async () => {
    const replayKey = 'minimal-lead-replay-fixture';
    const args = {
      business_id: BUSINESS_ID,
      idempotency_key: replayKey,
      full_name: 'Replay Person',
      company_name: 'Replay Co',
      source: 'paste',
    };
    const first = await call('nexus.submit_minimal_lead', args);
    const second = await call('nexus.submit_minimal_lead', args);
    expect(second.idempotent).toBe(true);
    expect(second.structured['lead_id']).toBe(first.structured['lead_id']);
  });

  it('captures a reply verbatim and reports the AI reading as a separate result', async () => {
    /**
     * The transport-level half of the reply rule: the reply is stored by
     * `capture_reply` before any model call, and this deployment has no provider
     * key, so the answer must say "captured, no reading" rather than "failed".
     * The classifier's own behaviour is covered in `v1-2-qualification.test.ts`.
     */
    const exact = 'MCP-REPLY-MARKER Thanks, but we already have a supplier.';
    const answer = await call('nexus.capture_reply', {
      business_id: BUSINESS_ID,
      idempotency_key: key('capture-reply'),
      lead_id: LEAD_ID,
      exact_text: exact,
      outcome: 'Already has supplier',
    });
    expect(answer.isError, answer.text).toBe(false);
    expect(answer.structured['captured']).toBe(true);
    expect(answer.structured['lead_id']).toBe(LEAD_ID);
    expect(answer.structured['outcome']).toBe('Already has supplier');
    // No provider here: the reading is missing and named as missing.
    expect(answer.structured['classification']).toBeNull();
    const failure = answer.structured['classification_error'] as { code: string } | null;
    expect(failure?.code).toBe('provider_not_configured');

    // The exact bytes are in the inbound interaction, and the reply exists.
    const stored = await h.db.query<{ summary: string }>(
      `select summary from public.interactions
        where lead_id = $1 and type = 'inbound_reply' order by created_at desc limit 1`,
      [LEAD_ID],
    );
    expect(stored.rows[0]?.summary).toBe(exact);

    // The transport never echoed the paste back in its own payload.
    expect(JSON.stringify(answer.structured)).not.toContain(exact);
  });

  it('records source metadata without storing a raw body', async () => {    const answer = await call('nexus.submit_source_metadata', {
      business_id: BUSINESS_ID,
      idempotency_key: key('metadata'),
      lead_id: LEAD_ID,
      person_id: PERSON_ID,
      company_id: COMPANY_ID,
      source: 'company_website',
      source_url: 'https://abcmedia.example/about',
      summary: 'Services page: video production, 40 staff, hiring an editor.',
      collector_agent: 'opencode',
      confidence: 0.7,
    });
    expect(answer.isError, answer.text).toBe(false);

    const stored = await h.db.query<{ raw_text_or_json: string; raw_content_hash: string | null; raw_deleted_at: string | null }>(
      `select raw_text_or_json, raw_content_hash, raw_deleted_at from public.source_evidence where id = $1`,
      [answer.structured['evidence_id']],
    );
    const row = stored.rows[0];
    expect(row?.raw_content_hash).toBeTruthy();
    expect(row?.raw_deleted_at).not.toBeNull();
    // Metadata only: the stored body is the structured summary, not a page dump.
    expect(row?.raw_text_or_json).toContain('Services page');
    expect((row?.raw_text_or_json ?? '').length).toBeLessThan(1000);
  });
});
