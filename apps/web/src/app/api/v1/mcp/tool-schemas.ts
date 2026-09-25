/**
 * Per-tool argument schemas for the MCP gateway.
 *
 * `mcp_contract.write_requirements` calls for schema validation on every call, and the audit found the
 * gateway only checking that `business_id` was a non-empty string: a client could send
 * `{"kind": "other"}` to `nexus.create_signal` and the first thing to object was a Postgres check
 * constraint, surfaced as `isError` text. Two consequences, both real:
 *
 *   * **`tools/list` lied.** It advertised `{business_id}` as the entire input schema, so a client
 *     that generated its call from the catalogue could not make a single tool succeed.
 *   * **Bad input was indistinguishable from a refusal.** An agent has no way to tell "your arguments
 *     were wrong" from "the database rejected this", and the first is fixable by retrying differently.
 *
 * So each tool declares its arguments once, here, and the transport does three things with it: it
 * publishes the JSON Schema through `tools/list`, it validates the call before dispatch, and it
 * strips the envelope keys (`business_id`, `idempotency_key`, …) so a tool never has to look at them.
 *
 * Arguments are validated by stripping unknown keys rather than rejecting them. Rejecting would break
 * a client that sends a harmless extra field the spec does not name, and the envelope fields are
 * already extracted; nothing unvalidated reaches a repository either way.
 */
import { z } from 'zod';

import { MCP_TOOLS, REPLY_OUTCOMES, SIGNAL_KINDS, SIGNAL_POLARITIES } from '@nexus/core';
import type { McpToolName } from '@nexus/core';

const uuid = z.string().uuid();

/** Non-empty, trimmed text with a length ceiling, so a tool cannot receive a megabyte of prose. */
const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * The envelope every call may carry.
 *
 * Extracted before the tool schema runs, because these are transport concerns: the business scope is
 * checked against the token's allow-list, and the idempotency key is consumed by the gateway itself.
 */
export const mcpEnvelopeSchema = z.object({
  business_id: uuid.optional(),
  business_key: z.string().trim().min(1).max(60).optional(),
  idempotency_key: z.string().trim().min(8).max(200).optional(),
  source_client: z.string().trim().min(1).max(120).optional(),
  agent_run_id: uuid.nullable().optional(),
});

export type McpEnvelope = z.infer<typeof mcpEnvelopeSchema>;

/** Envelope keys, so a tool schema never sees them and cannot accidentally depend on them. */
export const MCP_ENVELOPE_KEYS: readonly string[] = [
  'business_id',
  'business_key',
  'idempotency_key',
  'source_client',
  'agent_run_id',
];

/** Ignores rather than rejects unknown keys; see the note at the top of this module. */
const loose = <Shape extends z.ZodRawShape>(shape: Shape) => z.object(shape);

/**
 * One schema per tool, and the exhaustive `Record` type is load-bearing: adding a tool to `MCP_TOOLS`
 * without declaring its arguments is a compile error, not a runtime surprise.
 */
export const MCP_TOOL_SCHEMAS: Readonly<Record<McpToolName, z.ZodTypeAny>> = {
  'nexus.list_accessible_businesses': loose({}),

  'nexus.get_business_context': loose({}),

  'nexus.search_person': loose({
    query: text(200),
    limit: z.number().int().min(1).max(50).optional(),
  }),

  'nexus.search_company': loose({
    query: text(200),
    limit: z.number().int().min(1).max(50).optional(),
  }),

  'nexus.check_duplicate': loose({
    query: text(200),
  }),

  'nexus.submit_candidate': loose({
    // Any of the three names is accepted; the pipeline normalises them. The schema does not require
    // one because a candidate may legitimately arrive as a bare source URL.
    full_name: text(200).optional(),
    name: text(200).optional(),
    company_name: text(300).optional(),
    company: text(300).optional(),
    company_domain: text(300).optional(),
    job_title: text(300).optional(),
    title: text(300).optional(),
    linkedin_url: text(2048).optional(),
    source_url: text(2048).optional(),
    location: text(200).optional(),
    notes: text(4000).optional(),
  }),

  'nexus.create_signal': loose({
    // The full vocabulary, not a fallback string: 'other' is not a permitted kind, and the previous
    // default meant a call omitting `kind` could only ever fail at the database.
    kind: z.enum(SIGNAL_KINDS),
    polarity: z.enum(SIGNAL_POLARITIES).optional(),
    strength: z.number().int().min(-100).max(100).optional(),
    label: text(200).optional(),
    detail: text(2000).optional(),
    company_id: uuid.nullable().optional(),
    person_id: uuid.nullable().optional(),
    lead_id: uuid.nullable().optional(),
  }),

  'nexus.add_source_evidence': loose({
    person_id: uuid.nullable().optional(),
    company_id: uuid.nullable().optional(),
    lead_id: uuid.nullable().optional(),
    source: text(120),
    source_url: text(2048).nullable().optional(),
    raw_text_or_json: text(200_000).optional(),
    // Optional: the gateway derives it from the payload when the client does not supply one, so a
    // caller cannot record evidence with a hash that does not match what it sent.
    content_hash: text(128).optional(),
    confidence: z.number().min(0).max(1).optional(),
  }),

  'nexus.create_or_update_lead': loose({
    person_id: uuid.optional(),
    full_name: text(200).optional(),
    company_name: text(300).optional(),
    linkedin_url: text(2048).optional(),
    job_title: text(300).optional(),
    status: text(40).optional(),
    primary_icp_id: uuid.nullable().optional(),
    owner_user_id: uuid.nullable().optional(),
  }),

  'nexus.assign_lead': loose({
    lead_id: uuid,
    owner_user_id: uuid.nullable().optional(),
    primary_icp_id: uuid.nullable().optional(),
  }),

  'nexus.submit_profile_capture': loose({
    lead_id: uuid,
    linkedin_url: text(2048),
    pasted_content: text(200_000),
  }),

  'nexus.capture_reply': loose({
    lead_id: uuid,
    exact_text: text(20_000),
    outcome: z.enum(REPLY_OUTCOMES),
    note: text(4000).nullable().optional(),
  }),

  'nexus.add_note': loose({
    lead_id: uuid,
    body: text(8000),
  }),

  'nexus.create_task': loose({
    lead_id: uuid,
    title: text(200),
    type: text(40).optional(),
    due_at: z.string().trim().max(40).nullable().optional(),
    priority: text(20).optional(),
    note: text(2000).nullable().optional(),
  }),

  'nexus.get_today_queue': loose({
    user_id: uuid,
  }),

  'nexus.submit_research': loose({
    lead_id: uuid,
    summary: text(8000),
    findings: z.record(z.string(), z.unknown()).optional(),
    model: text(120).optional(),
  }),

  'nexus.submit_message_draft': loose({
    message_instance_id: uuid,
    content: text(4000),
    model: text(120).optional(),
  }),

  'nexus.finish_agent_run': loose({
    agent_name: text(120).optional(),
    objective: text(2000).nullable().optional(),
    state: text(40).optional(),
    summary: text(8000).nullable().optional(),
    result: z.record(z.string(), z.unknown()).optional(),
    stats: z.record(z.string(), z.unknown()).optional(),
  }),
};

/**
 * Which tools require an idempotency key.
 *
 * Every tool that creates something needs one, not only the ingestion tools. A retried
 * `nexus.create_signal` without a key inserts a second signal — and signals are append-only by
 * design, so there is nothing in the table to catch it afterwards. Read-only tools are exempt
 * because repeating them changes nothing.
 */
export const MCP_TOOLS_REQUIRING_IDEMPOTENCY: Readonly<Record<McpToolName, boolean>> = {
  'nexus.list_accessible_businesses': false,
  'nexus.get_business_context': false,
  'nexus.search_person': false,
  'nexus.search_company': false,
  'nexus.check_duplicate': false,
  'nexus.submit_candidate': true,
  'nexus.create_signal': true,
  'nexus.add_source_evidence': true,
  'nexus.create_or_update_lead': true,
  'nexus.assign_lead': true,
  'nexus.submit_profile_capture': true,
  'nexus.capture_reply': true,
  'nexus.add_note': true,
  'nexus.create_task': true,
  'nexus.get_today_queue': false,
  'nexus.submit_research': true,
  'nexus.submit_message_draft': true,
  'nexus.finish_agent_run': true,
};

/** A short human description, so `tools/list` is usable without reading the schemas. */
const DESCRIPTIONS: Readonly<Record<McpToolName, string>> = {
  'nexus.list_accessible_businesses': 'List the businesses this token may act on.',
  'nexus.get_business_context': 'Read the name, key, focus and regions of one business.',
  'nexus.search_person': 'Search people by name, company or profile URL.',
  'nexus.search_company': 'Search companies by name or domain.',
  'nexus.check_duplicate': 'Check whether a person or company already exists in a business.',
  'nexus.submit_candidate': 'Submit a candidate through the full ingest pipeline.',
  'nexus.create_signal': 'Record a signal against a company, person or lead.',
  'nexus.add_source_evidence': 'Attach source evidence with a mandatory provenance record.',
  'nexus.create_or_update_lead': 'Create or update a lead for a person in a business.',
  'nexus.assign_lead': 'Assign a lead to an owner and/or a primary ICP.',
  'nexus.submit_profile_capture': 'Capture a pasted profile onto an existing partial lead.',
  'nexus.capture_reply': 'Record an inbound reply verbatim and classify its outcome.',
  'nexus.add_note': 'Add an internal note to a lead.',
  'nexus.create_task': 'Create a task for a lead.',
  'nexus.get_today_queue': 'Read a user’s Today queue for a business.',
  'nexus.submit_research': 'Attach a research snapshot to a lead.',
  'nexus.submit_message_draft': 'Submit a message draft as a new immutable version.',
  'nexus.finish_agent_run': 'Record the completion of an agent run.',
};

/**
 * Converts a Zod object schema into the JSON Schema fragment `tools/list` publishes.
 *
 * Written by hand rather than pulled from a dependency: only the subset this tool set uses needs to
 * be represented, and a wrong-but-plausible schema is worse than none because a client generates its
 * calls from it.
 */
export function toolInputSchema(name: McpToolName): Record<string, unknown> {
  const schema = MCP_TOOL_SCHEMAS[name];
  // `_def.shape` is internal to Zod but stable across the 3.x line, and this is the only way to
  // enumerate the fields without maintaining a second copy of every declaration.
  const shape = (schema as unknown as { _def?: { shape?: () => Record<string, z.ZodTypeAny> } })._def?.shape?.() ?? {};

  const properties: Record<string, unknown> = {
    business_id: { type: 'string', format: 'uuid', description: 'Target business; must be within the token scope.' },
  };
  const required: string[] = [];

  for (const [key, field] of Object.entries(shape)) {
    properties[key] = jsonSchemaFor(field);
    // `.optional()` is the only marker this tool set uses for a non-required field, and it is the
    // one that matters to a client generating a call.
    if (!field.isOptional()) required.push(key);
  }

  if (name !== 'nexus.list_accessible_businesses') required.push('business_id');
  if (MCP_TOOLS_REQUIRING_IDEMPOTENCY[name]) {
    properties['idempotency_key'] = {
      type: 'string',
      minLength: 8,
      description: 'Required: the same key is never applied twice for this business and token.',
    };
    required.push('idempotency_key');
  }

  return {
    type: 'object',
    properties,
    required: [...new Set(required)],
    additionalProperties: true,
  };
}

/** A best-effort JSON Schema for the shapes this tool set declares. */
function jsonSchemaFor(field: z.ZodTypeAny): Record<string, unknown> {
  if (field instanceof z.ZodNullable) return { ...jsonSchemaFor(field.unwrap() as z.ZodTypeAny), nullable: true };
  if (field instanceof z.ZodEnum) return { type: 'string', enum: [...(field.options as string[])] };
  if (field instanceof z.ZodNumber) return { type: 'number' };
  if (field instanceof z.ZodBoolean) return { type: 'boolean' };
  if (field instanceof z.ZodArray) return { type: 'array' };
  if (field instanceof z.ZodRecord || field instanceof z.ZodObject) return { type: 'object' };
  if (field instanceof z.ZodString) return { type: 'string' };
  return {};
}

/** The catalogue `tools/list` returns, generated from the schemas above. */
export function toolCatalogue(): readonly {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}[] {
  return MCP_TOOLS.map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    inputSchema: toolInputSchema(name),
  }));
}
