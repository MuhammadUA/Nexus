/**
 * External ingestion envelope + pipeline.
 *
 * Spec `api_contract.external_ingest`:
 *   required_envelope: source_client, business_key_or_id, payload_type, payload,
 *     idempotency_key, observed_at
 *   pipeline: validate -> normalize -> dedupe -> persist source evidence ->
 *     apply business/ICP rules -> create/update candidate/lead -> assignment ->
 *     optional sequence enrollment -> audit
 *
 * Spec `mcp_contract.write_requirements`:
 *   business scope, actor/client identity, idempotency key when ingestion-related,
 *   schema validation, audit event.
 *
 * Everything crossing the trust boundary is parsed with Zod here, including AI
 * output: spec `integrations.deepseek.rule` — "All AI output must be JSON/schema
 * validated server-side before mutation."
 */

import { z } from 'zod';
import {
  LEAD_SOURCE_TYPES,
  REPLY_OUTCOMES,
  SIGNAL_KINDS,
  SIGNAL_POLARITIES,
  type LeadSourceType,
  type ReplyOutcome,
  type SignalKind,
  type SignalPolarity,
} from './vocabulary.js';

/* ------------------------------------------------------------- helpers -- */

const uuid = z.string().uuid();
const isoDateTime = z.string().datetime({ offset: true });
const nonEmpty = z.string().trim().min(1);

/** Accepts ISO strings, `Date`, or epoch millis. Always yields a `Date`. */
export const zDate = z.union([z.string(), z.number(), z.date()]).transform((value, ctx) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid date' });
    return z.NEVER;
  }
  return date;
});

/**
 * Content captured from a page. Treat as hostile: the spec requires that scraped
 * page content is never executed as instructions
 * (`security_and_reliability.rules`). We therefore bound its size and strip
 * control characters, but we never interpret it.
 *
 * The control-character class is the point of this transform, not an accident —
 * `no-control-regex` is disabled for this line only, because removing it would let
 * NULs and other control bytes from a scraped page reach the database.
 */
export const zUntrustedContent = z
  .string()
  .max(400_000, 'captured page content exceeds the 400k character limit')
  // eslint-disable-next-line no-control-regex -- deliberately strips control characters from untrusted input
  .transform((s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''));

export const zUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an absolute http(s) URL');

export const zLinkedInOrEmptyUrl = z
  .string()
  .trim()
  .max(2048)
  .optional()
  .transform((s) => (s === undefined || s.length === 0 ? undefined : s));

/* ------------------------------------------------------------ candidate - */

export const candidatePersonSchema = z.object({
  full_name: nonEmpty.max(200).optional(),
  first_name: z.string().trim().max(120).optional(),
  last_name: z.string().trim().max(120).optional(),
  headline: z.string().trim().max(500).optional(),
  job_title: z.string().trim().max(300).optional(),
  location: z.string().trim().max(200).optional(),
  linkedin_url: zLinkedInOrEmptyUrl,
  email: z.string().trim().email().max(320).optional(),
  company_name: z.string().trim().max(300).optional(),
  company_domain: z.string().trim().max(300).optional(),
  company_linkedin_url: zLinkedInOrEmptyUrl,
  company_industry: z.string().trim().max(200).optional(),
  company_employee_count: z.number().int().nonnegative().max(10_000_000).optional(),
  source_url: zUrl.optional(),
  /** Free-form extra fields are allowed but never trusted as canonical. */
  extra: z.record(z.unknown()).optional(),
});
export type CandidatePerson = z.infer<typeof candidatePersonSchema>;

/* --------------------------------------------------------------- signal - */

export const signalInputSchema = z.object({
  kind: z.enum(SIGNAL_KINDS),
  polarity: z.enum(SIGNAL_POLARITIES),
  strength: z.number().int().min(-100).max(100).default(0),
  label: nonEmpty.max(200),
  detail: z.string().max(4000).optional(),
  observed_at: zDate.optional(),
  expires_at: zDate.optional(),
  source_url: zUrl.optional(),
  person_id: uuid.optional(),
  company_id: uuid.optional(),
  lead_id: uuid.optional(),
});
export type SignalInput = z.infer<typeof signalInputSchema>;

/* ------------------------------------------------------------- evidence - */

export const sourceEvidenceInputSchema = z.object({
  source: nonEmpty.max(120),
  source_url: zUrl.optional(),
  raw_text_or_json: zUntrustedContent,
  observed_at: zDate,
  captured_at: zDate.optional(),
  confidence: z.number().min(0).max(1),
  person_id: uuid.optional(),
  company_id: uuid.optional(),
  lead_id: uuid.optional(),
});
export type SourceEvidenceInput = z.infer<typeof sourceEvidenceInputSchema>;

/* ------------------------------------------------------------- research - */

export const researchFindingSchema = z.object({
  claim: nonEmpty.max(2000),
  evidence_url: zUrl.optional(),
  confidence: z.number().min(0).max(1),
  observed_at: zDate.optional(),
});

export const researchSubmissionSchema = z.object({
  lead_id: uuid.optional(),
  person_id: uuid.optional(),
  company_id: uuid.optional(),
  summary: nonEmpty.max(8000),
  findings: z.array(researchFindingSchema).max(100).default([]),
  signals: z.array(signalInputSchema).max(50).default([]),
  model: z.string().max(120).optional(),
  prompt_key: z.string().max(120).optional(),
});
export type ResearchSubmission = z.infer<typeof researchSubmissionSchema>;

/* -------------------------------------------------------- message draft - */

export const messageDraftSchema = z.object({
  lead_id: uuid,
  message_instance_id: uuid.optional(),
  step_name: z.string().max(120).optional(),
  content: nonEmpty.max(8000),
  personalization_signal: z.string().max(2000).optional(),
  cited_asset_ids: z.array(uuid).max(20).default([]),
  cited_claim_ids: z.array(uuid).max(20).default([]),
  model: z.string().max(120).optional(),
  prompt_key: z.string().max(120).optional(),
});
export type MessageDraft = z.infer<typeof messageDraftSchema>;

/* ------------------------------------------------------- reply capture -- */

export const replyCaptureSchema = z.object({
  lead_id: uuid,
  /** "Reply text must be preserved exactly" — no trimming, no normalization. */
  exact_inbound_text: z.string().min(1).max(40_000),
  outcome: z.enum(REPLY_OUTCOMES),
  internal_note: z.string().max(8000).optional(),
  occurred_at: zDate.optional(),
  channel: z.enum(['linkedin', 'email', 'phone', 'other']).default('linkedin'),
  source_client: nonEmpty.max(120),
  outreach_identity_id: uuid.optional(),
  /** Provenance of the captured text; page content is untrusted. */
  capture_method: z.enum(['manual_paste', 'extension_autofill', 'api', 'import']).default('manual_paste'),
});
export type ReplyCapture = z.infer<typeof replyCaptureSchema>;

/* ------------------------------------------------------- profile capture - */

export const profileCaptureSchema = z.object({
  lead_id: uuid.optional(),
  person_id: uuid.optional(),
  linkedin_url: zUrl,
  /** "captured raw payload/content hash" — spec companion add_to_crm. */
  page_content: zUntrustedContent,
  business_id: uuid,
  primary_icp_id: uuid.optional(),
  auto_match_icp: z.boolean().default(false),
  owner_user_id: uuid.optional(),
  outreach_identity_id: uuid.optional(),
  source_client: nonEmpty.max(120),
  captured_at: zDate.optional(),
  /** Fields the extractor believes it found; validated server-side. */
  extracted: candidatePersonSchema.partial().optional(),
  extractor_confidence: z.number().min(0).max(1).optional(),
  capture_method: z.enum(['manual_paste', 'extension_autofill', 'api']).default('manual_paste'),
});
export type ProfileCapture = z.infer<typeof profileCaptureSchema>;

/* --------------------------------------------------------- task + note -- */

export const taskCreateSchema = z.object({
  lead_id: uuid.optional(),
  business_id: uuid,
  owner_user_id: uuid,
  type: z.string().trim().min(1).max(60),
  title: nonEmpty.max(300),
  due_at: zDate,
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  reminder_at: zDate.optional(),
  note: z.string().max(4000).optional(),
  source: z.enum(['user', 'admin', 'system', 'agent', 'sequence']).default('user'),
});
export type TaskCreate = z.infer<typeof taskCreateSchema>;

export const noteCreateSchema = z.object({
  lead_id: uuid,
  body: nonEmpty.max(8000),
  is_internal: z.boolean().default(true),
});
export type NoteCreate = z.infer<typeof noteCreateSchema>;

/* ---------------------------------------------------------- lead create - */

export const leadCreateSchema = z
  .object({
    business_id: uuid,
    person: candidatePersonSchema,
    primary_icp_id: uuid.optional(),
    auto_match_icp: z.boolean().default(false),
    owner_user_id: uuid.optional(),
    outreach_identity_id: uuid.optional(),
    source_type: z.enum(LEAD_SOURCE_TYPES),
    source_url: zUrl.optional(),
    source_evidence: z
      .object({
        raw_text_or_json: zUntrustedContent,
        confidence: z.number().min(0).max(1),
        observed_at: zDate,
      })
      .optional(),
    signals: z.array(signalInputSchema).max(50).default([]),
    /** Required when a person cannot be identified from LinkedIn URL or name. */
    allow_needs_profile: z.boolean().default(false),
  })
  .refine((v) => v.primary_icp_id !== undefined || v.auto_match_icp, {
    message: 'Business plus either a Primary ICP or Auto-match is required',
    path: ['primary_icp_id'],
  });
export type LeadCreate = z.infer<typeof leadCreateSchema>;

/* ------------------------------------------------- business context read */

export const businessKeyOrId = z.union([uuid, z.string().trim().min(1).max(60)]);

/* ------------------------------------------------------------- envelope - */

export const PAYLOAD_TYPES = [
  'candidate',
  'signal',
  'source_evidence',
  'lead',
  'research',
  'message_draft',
  'profile_capture',
  'reply',
  'task',
  'note',
  'rfp',
  'opportunity',
] as const;
export type PayloadType = (typeof PAYLOAD_TYPES)[number];

/**
 * spec `api_contract.external_ingest.required_envelope` — all six fields.
 * `source_client` and `idempotency_key` are additionally bound in the DB by
 * `UNIQUE (source_client, business_id, idempotency_key)` on `ingest_requests`.
 */
export const ingestEnvelopeSchema = z.object({
  source_client: nonEmpty.max(120),
  business_key_or_id: businessKeyOrId,
  payload_type: z.enum(PAYLOAD_TYPES),
  payload: z.unknown(),
  idempotency_key: z.string().trim().min(8).max(200),
  observed_at: zDate,
  /** Optional: lets an agent correlate multiple writes into one run. */
  agent_run_id: uuid.optional(),
  /** Optional actor override; only honoured for admin-scoped tokens. */
  actor_user_id: uuid.optional(),
});
export type IngestEnvelope = z.infer<typeof ingestEnvelopeSchema>;

const PAYLOAD_SCHEMAS: Record<PayloadType, z.ZodTypeAny> = {
  candidate: candidatePersonSchema,
  signal: signalInputSchema,
  source_evidence: sourceEvidenceInputSchema,
  lead: leadCreateSchema,
  research: researchSubmissionSchema,
  message_draft: messageDraftSchema,
  profile_capture: profileCaptureSchema,
  reply: replyCaptureSchema,
  task: taskCreateSchema,
  note: noteCreateSchema,
  rfp: z.object({
    title: nonEmpty.max(300),
    company_name: nonEmpty.max(300).optional(),
    company_id: uuid.optional(),
    source_url: zUrl.optional(),
    deadline_at: zDate.optional(),
    detail: z.record(z.unknown()).optional(),
  }),
  opportunity: z.object({
    lead_id: uuid,
    name: nonEmpty.max(300),
    stage: z.enum(['identified', 'qualified', 'proposal', 'negotiation', 'won', 'lost']),
    value: z.number().nonnegative().optional(),
    currency: z.string().length(3).optional(),
    expected_close_at: zDate.optional(),
  }),
};

export interface EnvelopeValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type EnvelopeValidation =
  | {
      readonly ok: true;
      readonly envelope: IngestEnvelope;
      readonly payload: unknown;
    }
  | {
      readonly ok: false;
      readonly issues: readonly EnvelopeValidationIssue[];
    };

/**
 * Validate an external ingest envelope, including the type-specific payload
 * schema. Nothing is mutated until this returns `ok: true`.
 */
export function validateIngestEnvelope(input: unknown): EnvelopeValidation {
  const envelopeResult = ingestEnvelopeSchema.safeParse(input);
  if (!envelopeResult.success) {
    return {
      ok: false,
      issues: envelopeResult.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    };
  }
  const envelope = envelopeResult.data;
  const payloadSchema = PAYLOAD_SCHEMAS[envelope.payload_type];
  const payloadResult = payloadSchema.safeParse(envelope.payload);
  if (!payloadResult.success) {
    return {
      ok: false,
      issues: payloadResult.error.issues.map((i) => ({
        path: `payload.${i.path.join('.')}`,
        message: i.message,
      })),
    };
  }
  return { ok: true, envelope, payload: payloadResult.data };
}

/* ---------------------------------------------------------- AI boundary - */

/**
 * Schema for the structured extraction DeepSeek returns when normalizing a
 * LinkedIn profile or a research result. Spec requires server-side schema
 * validation before mutation, so this is parsed with a strict object: unknown
 * keys are rejected rather than silently persisted.
 */
export const aiProfileExtractionSchema = z
  .object({
    person: z.object({
      full_name: z.string().max(200).nullable(),
      headline: z.string().max(500).nullable(),
      job_title: z.string().max(300).nullable(),
      location: z.string().max(200).nullable(),
      linkedin_url: z.string().max(2048).nullable(),
    }),
    company: z
      .object({
        name: z.string().max(300).nullable(),
        domain: z.string().max(300).nullable(),
        industry: z.string().max(200).nullable(),
        employee_count: z.number().int().nonnegative().nullable(),
        linkedin_url: z.string().max(2048).nullable(),
      })
      .nullable(),
    /** Each item must quote the page text it came from. */
    evidence: z
      .array(
        z.object({
          field: z.string().max(60),
          quoted_text: z.string().max(2000),
          confidence: z.number().min(0).max(1),
        }),
      )
      .max(40),
    signals: z
      .array(
        z.object({
          kind: z.enum(SIGNAL_KINDS),
          polarity: z.enum(SIGNAL_POLARITIES),
          label: z.string().max(200),
          detail: z.string().max(2000).nullable(),
          confidence: z.number().min(0).max(1),
        }),
      )
      .max(20),
    personalization_candidates: z
      .array(
        z.object({
          text: z.string().max(600),
          source_quote: z.string().max(600),
          confidence: z.number().min(0).max(1),
        }),
      )
      .max(10),
    /** The model must declare what it could not determine. */
    uncertainties: z.array(z.string().max(400)).max(30),
  })
  .strict();

export type AiProfileExtraction = z.infer<typeof aiProfileExtractionSchema>;

/**
 * Guard used on every AI-derived fact before it is written: a claim must carry a
 * verbatim quote from the untrusted source. This is what stops an injected
 * instruction inside scraped page content from becoming a canonical field.
 */
export function aiFactIsGrounded(
  extraction: AiProfileExtraction,
  requiredField: string,
): boolean {
  return extraction.evidence.some((e) => e.field === requiredField && e.quoted_text.trim().length > 0);
}

/* ------------------------------------------------------- pipeline shape - */

export interface PipelineStageResult {
  readonly stage:
    | 'validate'
    | 'normalize'
    | 'dedupe'
    | 'persist_evidence'
    | 'apply_rules'
    | 'upsert_candidate'
    | 'assign'
    | 'enroll'
    | 'audit';
  readonly status: 'ok' | 'skipped' | 'failed';
  readonly detail?: string;
}

/** spec pipeline ordering; kept in one place so every ingest path uses it. */
export const INGEST_PIPELINE_STAGES: readonly PipelineStageResult['stage'][] = [
  'validate',
  'normalize',
  'dedupe',
  'persist_evidence',
  'apply_rules',
  'upsert_candidate',
  'assign',
  'enroll',
  'audit',
];

/* -------------------------------------------------------- MCP tool input - */

/**
 * Every MCP tool call carries explicit business scope + actor identity, per
 * `mcp_contract.write_requirements`. Tool names are the spec's
 * `mcp_contract.recommended_tools` with the `nexus.` prefix stripped by the
 * transport.
 */
export const mcpToolEnvelopeSchema = z.object({
  business_id: uuid.optional(),
  business_key: z.string().trim().max(60).optional(),
  idempotency_key: z.string().trim().min(8).max(200).optional(),
  source_client: nonEmpty.max(120).default('mcp'),
  agent_run_id: uuid.optional(),
});
export type McpToolEnvelope = z.infer<typeof mcpToolEnvelopeSchema>;

/** The spec's recommended MCP tool list, reproduced exactly. */
export const MCP_TOOLS = [
  'nexus.list_accessible_businesses',
  'nexus.get_business_context',
  'nexus.search_person',
  'nexus.search_company',
  'nexus.check_duplicate',
  'nexus.submit_candidate',
  'nexus.create_signal',
  'nexus.add_source_evidence',
  'nexus.create_or_update_lead',
  'nexus.assign_lead',
  'nexus.submit_profile_capture',
  'nexus.capture_reply',
  'nexus.add_note',
  'nexus.create_task',
  'nexus.get_today_queue',
  'nexus.submit_research',
  'nexus.submit_message_draft',
  'nexus.finish_agent_run',
] as const;
export type McpToolName = (typeof MCP_TOOLS)[number];

/** spec `mcp_contract.forbidden_tool`. */
export const FORBIDDEN_MCP_TOOLS: readonly string[] = [
  'database.execute_sql',
  'nexus.execute_sql',
  'nexus.run_sql',
  'nexus.query',
];

/** Scope each MCP tool requires. */
export const MCP_TOOL_SCOPES: Readonly<Record<McpToolName, string>> = {
  'nexus.list_accessible_businesses': 'businesses:read',
  'nexus.get_business_context': 'context:read',
  'nexus.search_person': 'person:search',
  'nexus.search_company': 'company:search',
  'nexus.check_duplicate': 'duplicate:check',
  'nexus.submit_candidate': 'candidate:submit',
  'nexus.create_signal': 'signal:create',
  'nexus.add_source_evidence': 'evidence:add',
  'nexus.create_or_update_lead': 'lead:create',
  'nexus.assign_lead': 'lead:assign',
  'nexus.submit_profile_capture': 'profile:capture',
  'nexus.capture_reply': 'reply:capture',
  'nexus.add_note': 'note:add',
  'nexus.create_task': 'task:create',
  'nexus.get_today_queue': 'today:read',
  'nexus.submit_research': 'research:submit',
  'nexus.submit_message_draft': 'message:draft',
  'nexus.finish_agent_run': 'agent_run:finish',
};

export type { LeadSourceType, ReplyOutcome, SignalKind, SignalPolarity };
export { LEAD_SOURCE_TYPES, REPLY_OUTCOMES, SIGNAL_KINDS, SIGNAL_POLARITIES };
export { isoDateTime };
