/**
 * AI-assisted profile capture.
 *
 * Exercises the whole path against the real schema: the model's answer, the grounding check, the
 * write to the existing person, the audit row naming the extractor, and — the case that matters most
 * for availability — the fallback when no provider is configured. A capture must never fail because
 * the AI is unavailable; the operator is looking at the profile and the raw text is already in hand.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadViewer, type Viewer } from '@/lib/actor';
import type { AiProvider, AiResult, AiJsonRequest } from '@/lib/ai/types';
import { heuristicProfileFields, resolveProfileFields } from '@/lib/ai/drafting';
import { submitProfileCapture } from '@/lib/repo/profile-capture';

import { createAppHarness, type AppHarness } from './harness';

let h: AppHarness;
let viewer: Viewer;

const ADMIN_ID = 'f0000000-0000-4000-8000-000000000001';
const BUSINESS_ID = 'f0000000-0000-4000-8000-000000000002';
const PERSON_ID = 'f0000000-0000-4000-8000-000000000003';
const LEAD_ID = 'f0000000-0000-4000-8000-000000000004';

const PASTED = [
  'Ada Lovelace',
  'Head of Content at Analytical Engines',
  'London, United Kingdom',
  'We are scaling our editorial output this quarter.',
].join('\n');

/** A provider that returns a fixed extraction, so the write path can be driven deterministically. */
function extractionProvider(
  value: unknown,
  options: { configured?: boolean } = {},
): AiProvider {
  return {
    name: 'deepseek',
    model: 'deepseek-chat',
    configured: options.configured ?? true,
    async complete<Schema extends z.ZodTypeAny>(
      request: AiJsonRequest<Schema>,
    ): Promise<AiResult<z.infer<Schema>>> {
      const parsed = request.schema.safeParse(value);
      if (!parsed.success) {
        return {
          ok: false,
          kind: 'schema_invalid',
          error: 'The AI provider returned data that did not match the required shape.',
          retryable: false,
          status: null,
          issues: parsed.error.issues.map((issue) => issue.path.join('.')),
        };
      }
      return {
        ok: true,
        data: parsed.data as z.infer<Schema>,
        provenance: {
          provider: 'deepseek',
          model: 'deepseek-chat',
          promptVersionId: null,
          attempts: 1,
          latencyMs: 12,
          usage: null,
        },
      };
    },
  };
}

function extractionWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    person: {
      full_name: 'Ada Lovelace',
      headline: 'Head of Content at Analytical Engines',
      job_title: 'Head of Content',
      location: 'London, United Kingdom',
      linkedin_url: null,
    },
    company: {
      name: 'Analytical Engines',
      domain: null,
      industry: null,
      employee_count: null,
      linkedin_url: null,
    },
    evidence: [
      { field: 'person.full_name', quoted_text: 'Ada Lovelace', confidence: 1 },
      { field: 'person.job_title', quoted_text: 'Head of Content', confidence: 0.9 },
      { field: 'person.headline', quoted_text: 'Head of Content at Analytical Engines', confidence: 0.9 },
      { field: 'person.location', quoted_text: 'London, United Kingdom', confidence: 0.8 },
      { field: 'company.name', quoted_text: 'Analytical Engines', confidence: 0.8 },
    ],
    signals: [],
    personalization_candidates: [],
    uncertainties: [],
    ...overrides,
  };
}

beforeAll(async () => {
  h = await createAppHarness();
  await h.db.exec('set row_security = off');
  await h.db.query(
    `insert into public.users (id, email, full_name, role, status)
     values ($1, 'capture-admin@nexus.test', 'Capture Admin', 'admin', 'active')`,
    [ADMIN_ID],
  );
  await h.db.query(
    `insert into public.businesses (id, key, name, status, created_by)
     values ($1, 'capture-test', 'Capture Test Co', 'active', $2)`,
    [BUSINESS_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.user_business_access
       (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources, can_use_profile_queue, can_delete_leads, created_by)
     values ($1, $2, 'admin', true, true, true, true, $1)`,
    [ADMIN_ID, BUSINESS_ID],
  );
  await h.db.query(
    `insert into public.people (id, full_name, created_by) values ($1, 'Ada Lovelace', $2)`,
    [PERSON_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.leads (id, business_id, person_id, status, source_type, needs_profile, created_by)
     values ($1, $2, $3, 'needs_profile', 'paste_list', true, $4)`,
    [LEAD_ID, BUSINESS_ID, PERSON_ID, ADMIN_ID],
  );
  await h.db.exec('set row_security = on');
  viewer = await loadViewer({ kind: 'user', userId: ADMIN_ID });
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('local extraction', () => {
  it('reads a name, headline, title, company and location from the pasted text', () => {
    const fields = heuristicProfileFields(PASTED);
    expect(fields.fullName).toBe('Ada Lovelace');
    expect(fields.company).toBe('Analytical Engines');
    expect(fields.jobTitle).toBe('Head of Content');
    expect(fields.location).toBe('London, United Kingdom');
  });

  it('leaves a field null rather than guessing it', () => {
    const fields = heuristicProfileFields('Ada Lovelace');
    expect(fields.company).toBeNull();
    expect(fields.location).toBeNull();
  });
});

describe('resolveProfileFields', () => {
  it('reports the local extractor when no provider is configured', async () => {
    const resolved = await resolveProfileFields(extractionProvider(extractionWith(), { configured: false }), {
      pastedContent: PASTED,
      linkedinUrl: null,
    });

    expect(resolved.method).toBe('heuristic');
    expect(resolved.model).toBeNull();
    expect(resolved.note).toContain('DEEPSEEK_API_KEY is not set');
    expect(resolved.fields.fullName).toBe('Ada Lovelace');
  });

  it('reports the model when one is configured', async () => {
    const resolved = await resolveProfileFields(extractionProvider(extractionWith()), {
      pastedContent: PASTED,
      linkedinUrl: null,
    });

    expect(resolved.method).toBe('model');
    expect(resolved.model).toBe('deepseek-chat');
    expect(resolved.note).toBeNull();
    expect(resolved.droppedUngrounded).toEqual([]);
  });

  it('falls back to the local extractor, with a reason, when the provider fails', async () => {
    const failing: AiProvider = {
      ...extractionProvider(extractionWith()),
      async complete() {
        return {
          ok: false,
          kind: 'rate_limited',
          error: 'The AI provider is rate limiting requests. Try again shortly.',
          retryable: true,
          status: 429,
        };
      },
    };

    const resolved = await resolveProfileFields(failing, { pastedContent: PASTED, linkedinUrl: null });

    expect(resolved.method).toBe('heuristic');
    // The reason names the failure kind and never a secret.
    expect(resolved.note).toContain('rate_limited');
    expect(resolved.fields.fullName).toBe('Ada Lovelace');
  });

  it('drops a model field with no supporting quote and keeps the local read', async () => {
    const resolved = await resolveProfileFields(
      extractionProvider(
        extractionWith({
          evidence: [{ field: 'person.full_name', quoted_text: 'Ada Lovelace', confidence: 1 }],
        }),
      ),
      { pastedContent: PASTED, linkedinUrl: null },
    );

    expect(resolved.method).toBe('model');
    expect(resolved.droppedUngrounded).toContain('person.job_title');
    expect(resolved.droppedUngrounded).toContain('person.headline');
    // The local extractor still knew the title from the "at" pattern, so the field is not lost.
    expect(resolved.fields.jobTitle).toBe('Head of Content');
  });
});

describe('submitProfileCapture', () => {
  it('captures the profile, records how it was read, and drains the queue', async () => {
    await h.db.exec('set row_security = off');
    await h.db.query(
      `insert into public.profile_capture_queue (business_id, lead_id, person_id, state)
       values ($1, $2, $3, 'pending')`,
      [BUSINESS_ID, LEAD_ID, PERSON_ID],
    );
    await h.db.exec('set row_security = on');

    const result = await submitProfileCapture(viewer, {
      leadId: LEAD_ID,
      linkedinUrl: 'https://www.linkedin.com/in/ada-lovelace/',
      pastedContent: PASTED,
    });

    expect(result.ok).toBe(true);

    await h.db.exec('set row_security = off');
    const person = await h.db.query<{ job_title: string | null; location: string | null }>(
      `select job_title, location from public.people where id = $1`,
      [PERSON_ID],
    );
    // No AI key is configured in the test environment, so the local extractor produced these.
    expect(person.rows[0]?.job_title).toBe('Head of Content');
    expect(person.rows[0]?.location).toBe('London, United Kingdom');

    const queue = await h.db.query<{ state: string }>(
      `select state from public.profile_capture_queue where lead_id = $1`,
      [LEAD_ID],
    );
    expect(queue.rows[0]?.state).toBe('captured');

    const lead = await h.db.query<{ needs_profile: boolean; status: string }>(
      `select needs_profile, status from public.leads where id = $1`,
      [LEAD_ID],
    );
    expect(lead.rows[0]?.needs_profile).toBe(false);
    expect(lead.rows[0]?.status).toBe('ready');

    // The raw paste is kept as source evidence, with the content hash that makes a re-capture a
    // no-op.
    const evidence = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.source_evidence where lead_id = $1`,
      [LEAD_ID],
    );
    expect(evidence.rows[0]?.n).toBe(1);

    // And the audit trail names the extractor, so "which fields did a model write?" is answerable
    // later even though the fields themselves carry no such marker.
    const audit = await h.db.query<{ after_json: Record<string, unknown> | null }>(
      `select after_json from public.audit_events
        where entity_type = 'lead' and entity_id = $1 and action = 'profile_capture_extracted'`,
      [LEAD_ID],
    );
    expect(audit.rows[0]?.after_json?.['method']).toBe('heuristic');
    expect(audit.rows[0]?.after_json?.['model']).toBeNull();
    await h.db.exec('set row_security = on');
  });

  it('refuses an empty paste', async () => {
    const result = await submitProfileCapture(viewer, {
      leadId: LEAD_ID,
      linkedinUrl: 'https://www.linkedin.com/in/ada-lovelace/',
      pastedContent: '   ',
    });
    expect(result.ok).toBe(false);
  });

  it('reports a lead it cannot see rather than writing anywhere', async () => {
    const result = await submitProfileCapture(viewer, {
      leadId: 'f0000000-0000-4000-8000-0000000000ff',
      linkedinUrl: 'https://www.linkedin.com/in/nobody/',
      pastedContent: PASTED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/could not be found/i);
  });
});
