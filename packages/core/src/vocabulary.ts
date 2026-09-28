/**
 * Canonical enums and primitive domain vocabulary.
 *
 * Every value here traces to `Nexus_CRM_Master_Spec_v1.json`. Nothing is
 * invented; where the spec enumerates a list we reproduce it exactly so that
 * database CHECK constraints, Zod schemas and UI labels cannot drift apart.
 */

/* -------------------------------------------------------------- tenancy -- */

export const ROLES = ['admin', 'manager', 'user'] as const;
export type Role = (typeof ROLES)[number];

export const BUSINESS_STATUSES = ['active', 'archived', 'template'] as const;
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

/**
 * spec `admin_self_assignment_and_domains.business_domains.types`
 */
export const BUSINESS_DOMAIN_TYPES = ['primary', 'alias', 'parent_source', 'service'] as const;
export type BusinessDomainType = (typeof BUSINESS_DOMAIN_TYPES)[number];

/* ---------------------------------------------------- lead lifecycle ---- */

/**
 * spec `lead_lifecycle.states` — reproduced verbatim and in order.
 */
export const LEAD_STATES = [
  'new',
  'needs_profile',
  'ready',
  'connection_due',
  'connection_sent',
  'connection_accepted',
  'message_due',
  'followup_due',
  'replied',
  'paused',
  'cooldown',
  'dormant',
  'reactivation_due',
  'interested',
  'wrong_person',
  'do_not_contact',
  'archived',
  'deleted',
] as const;
export type LeadState = (typeof LEAD_STATES)[number];

/** States in which a Lead is still "active" for the one-lead-per-business rule. */
export const ACTIVE_LEAD_STATES: readonly LeadState[] = LEAD_STATES.filter(
  (s) => s !== 'deleted',
);

/** States that mean outreach must not proceed. */
export const OUTREACH_BLOCKING_LEAD_STATES: readonly LeadState[] = [
  'do_not_contact',
  'wrong_person',
  'archived',
  'deleted',
];

/** States that mean the sequence is intentionally not advancing. */
export const SEQUENCE_PARKED_LEAD_STATES: readonly LeadState[] = [
  'replied',
  'paused',
  'cooldown',
  'dormant',
  'reactivation_due',
  'interested',
  'wrong_person',
  'do_not_contact',
  'archived',
  'deleted',
];

/* --------------------------------------------------------- next action -- */

export const NEXT_ACTION_TYPES = [
  'capture_profile',
  'connection',
  'message_1',
  'followup_1',
  'followup_2',
  'followup_3',
  'reactivation',
  'review',
  'task',
  'none',
] as const;
export type NextActionType = (typeof NEXT_ACTION_TYPES)[number];

/* ------------------------------------------------------- lead sources -- */

/**
 * spec `lead_sources.available_to_user_if_permissioned` + `api_contract`.
 */
export const LEAD_SOURCE_TYPES = [
  'manual_add',
  'manual_companion',
  'file_csv',
  'file_xlsx',
  'paste_list',
  'google_search',
  'apollo_basic',
  'external_ingest',
  'mcp_agent',
  'research_agent',
] as const;
export type LeadSourceType = (typeof LEAD_SOURCE_TYPES)[number];

/* --------------------------------------------------- sequence & messages - */

export const MESSAGE_STATES = ['DYNAMIC', 'LOCKED', 'SENT'] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

export const MESSAGE_EVENT_TYPES = [
  'generated',
  'regenerated',
  'edited',
  'locked',
  'unlocked',
  'copied',
  'sent',
  'snoozed',
  'invalidated',
  'reverted',
  'failed',
] as const;
export type MessageEventType = (typeof MESSAGE_EVENT_TYPES)[number];

export const SEQUENCE_STEP_KINDS = [
  'connection',
  'message',
  'followup',
  'reactivation',
] as const;
export type SequenceStepKind = (typeof SEQUENCE_STEP_KINDS)[number];

export const ENROLLMENT_STATES = [
  'active',
  'completed',
  'paused',
  'cancelled',
  'dormant',
  'reactivation_due',
] as const;
export type EnrollmentState = (typeof ENROLLMENT_STATES)[number];

/* ------------------------------------------------------------ replies --- */

/**
 * spec `sequence_engine.reply_outcomes` — reproduced verbatim and in order.
 */
export const REPLY_OUTCOMES = [
  'Interested',
  'Positive / needs info',
  'Maybe later',
  'No current need',
  'Not interested',
  'Wrong person',
  'Already has supplier',
  'Do not contact',
  'Other',
] as const;
export type ReplyOutcome = (typeof REPLY_OUTCOMES)[number];

export const CHANNELS = ['linkedin', 'email', 'phone', 'other'] as const;
export type Channel = (typeof CHANNELS)[number];

/* ------------------------------------------------------- task & notes --- */

export const TASK_TYPES = [
  'follow_up',
  'connection',
  'message',
  'research',
  'reply',
  'profile_capture',
  'reactivation',
  'admin',
  'other',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUSES = ['open', 'done', 'cancelled', 'snoozed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_SOURCES = ['user', 'admin', 'system', 'agent', 'sequence'] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

/* ------------------------------------------------------- interactions --- */

export const INTERACTION_TYPES = [
  'outbound_message',
  'inbound_reply',
  'internal_note',
  'connection_event',
  'sequence_state_change',
  'task_event',
  'profile_capture',
  'signal',
  'assignment',
  'identity_transfer',
  'import',
  'system',
] as const;
export type InteractionType = (typeof INTERACTION_TYPES)[number];

/* --------------------------------------------------------- knowledge ---- */

/**
 * spec `business_brain_and_knowledge.asset_types` — verbatim.
 */
export const KNOWLEDGE_ASSET_TYPES = [
  'Portfolio',
  'Case Study',
  'Service',
  'Offer',
  'Pricing',
  'Testimonial',
  'Process',
  'Web Page',
  'Document',
  'Video / YouTube',
  'Other proof',
] as const;
export type KnowledgeAssetType = (typeof KNOWLEDGE_ASSET_TYPES)[number];

export const APPROVAL_STATES = [
  'draft',
  'extracting',
  'needs_review',
  'approved',
  'rejected',
  'superseded',
] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

/* --------------------------------------------------- import & review ---- */

export const IMPORT_SOURCES = [
  'file_csv',
  'file_xlsx',
  'paste_list',
  'google_search',
  'apollo_basic',
  'external_ingest',
] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const IMPORT_ROW_RESULTS = [
  'pending',
  'created',
  'updated',
  'duplicate',
  'needs_profile',
  'failed',
  'skipped',
] as const;
export type ImportRowResult = (typeof IMPORT_ROW_RESULTS)[number];

export const DUPLICATE_RESOLUTIONS = ['merge', 'keep_separate', 'skip'] as const;
export type DuplicateResolution = (typeof DUPLICATE_RESOLUTIONS)[number];

export const DUPLICATE_MATCH_REASONS = [
  'linkedin_url',
  'company_domain',
  'name_company_title',
  'email',
  'manual',
] as const;
export type DuplicateMatchReason = (typeof DUPLICATE_MATCH_REASONS)[number];

export const PROFILE_QUEUE_STATES = [
  'pending',
  'in_progress',
  'captured',
  'skipped',
  'failed',
] as const;
export type ProfileQueueState = (typeof PROFILE_QUEUE_STATES)[number];

/* ------------------------------------------------------------ signals --- */

export const SIGNAL_KINDS = [
  'hiring',
  'contractor_need',
  'content_output',
  'geography_size',
  'rfp_tender',
  'funding',
  'technology',
  'leadership_change',
  'negative_recruitment',
  'negative_wedding_only',
  'negative_stale_vacancy',
  'negative_geography',
  'custom',
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export const SIGNAL_POLARITIES = ['positive', 'negative', 'neutral'] as const;
export type SignalPolarity = (typeof SIGNAL_POLARITIES)[number];

/* -------------------------------------------------------- integrations -- */

export const API_CLIENT_KINDS = ['mcp', 'rest_ingest', 'webhook', 'internal_worker'] as const;
export type ApiClientKind = (typeof API_CLIENT_KINDS)[number];

export const AUTHENTICATION_ACTOR_TYPES = ['user', 'api_client', 'system', 'agent'] as const;
export type ActorType = (typeof AUTHENTICATION_ACTOR_TYPES)[number];

export const AGENT_RUN_STATES = ['running', 'succeeded', 'failed', 'cancelled'] as const;
export type AgentRunState = (typeof AGENT_RUN_STATES)[number];

export const BROWSER_SESSION_STATUSES = ['active', 'idle', 'revoked'] as const;
export type BrowserSessionStatus = (typeof BROWSER_SESSION_STATUSES)[number];

export const OUTREACH_IDENTITY_STATUSES = ['active', 'paused', 'retired'] as const;
export type OutreachIdentityStatus = (typeof OUTREACH_IDENTITY_STATUSES)[number];

export const OUTREACH_PLATFORMS = ['linkedin', 'email', 'twitter', 'other'] as const;
export type OutreachPlatform = (typeof OUTREACH_PLATFORMS)[number];

/* --------------------------------------------------- companion context -- */

/** Companion top-level tabs — spec `companion_extension.top_level`. */
export const COMPANION_TOP_LEVEL = ['crm_view', 'add_to_crm'] as const;
export type CompanionTopLevel = (typeof COMPANION_TOP_LEVEL)[number];

/** Companion CRM modules — spec `companion_extension.crm_modules`. */
export const COMPANION_MODULES = ['leads', 'today', 'search'] as const;
export type CompanionModule = (typeof COMPANION_MODULES)[number];

/** My Day buckets — spec `tasks_and_my_day.today_categories`. */
export const TODAY_CATEGORIES = [
  'connections',
  'accepted_message1',
  'followups',
  'overdue',
  'custom_tasks',
] as const;
export type TodayCategory = (typeof TODAY_CATEGORIES)[number];

export const MY_DAY_BUCKETS = ['today', 'upcoming', 'done'] as const;
export type MyDayBucket = (typeof MY_DAY_BUCKETS)[number];

/* ------------------------------------------------------------ scoring --- */

export const SCORING_RULE_TARGETS = ['icp', 'business', 'global'] as const;
export type ScoringRuleTarget = (typeof SCORING_RULE_TARGETS)[number];

export const AUTOMATION_RUN_MODES = ['manual', 'scheduled', 'continuous'] as const;
export type AutomationRunMode = (typeof AUTOMATION_RUN_MODES)[number];

/* --------------------------------------------------------- RFP / opps --- */

export const OPPORTUNITY_STAGES = [
  'identified',
  'qualified',
  'proposal',
  'negotiation',
  'won',
  'lost',
] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

export const RFP_STATES = ['discovered', 'reviewing', 'bidding', 'submitted', 'won', 'lost', 'ignored'] as const;
export type RfpState = (typeof RFP_STATES)[number];

/* ============================================= V1.2 (AI-first) vocabulary -- */

/**
 * The V1.2 AI-first redesign replaced the single "lead state" story with an
 * explicit enrichment pipeline, an agent work queue and a fixed outreach channel
 * set. Every one of those lists lives here, beside the V1.1 enums, so database
 * CHECK constraints, Zod schemas, the MCP tool registry and UI labels all read
 * the same source of truth and cannot drift apart.
 *
 * The V1.1 enums above are deliberately untouched. `LEAD_SOURCE_TYPES` still
 * describes how a row was historically ingested; `LEGACY_SOURCE_TO_DISCOVERY`
 * and `discoverySourceFromLegacy` below are the one-way bridge onto the V1.2
 * `DISCOVERY_SOURCES` vocabulary.
 */

/* --------------------------------------------------- enrichment states --- */

/** Where a lead sits in profile -> company research -> signals -> AI context. */
export const ENRICHMENT_STATES = [
  'MINIMAL',
  'NEEDS_PROFILE',
  'PROFILE_READY',
  'COMPANY_RESEARCH_PENDING',
  'AGENT_RESEARCH_PENDING',
  'AI_PROCESSING',
  'READY',
  'NEEDS_REVIEW',
  'FAILED',
] as const;
export type EnrichmentState = (typeof ENRICHMENT_STATES)[number];

/* ---------------------------------------------------- discovery source --- */

/**
 * How a lead entered the CRM.
 *
 * Free-text sources (an import column, an MCP caller's `source`, a manual note)
 * are normalised onto this list by `normalizeDiscoverySource`, so the column
 * never accumulates a long tail of spellings.
 */
export const DISCOVERY_SOURCES = [
  'linkedin',
  'upwork',
  'reddit',
  'job_board',
  'youtube',
  'instagram',
  'company_website',
  'google',
  'web',
  'apollo',
  'csv',
  'paste',
  'mcp',
  'companion',
  'manual',
  'other',
] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

/* -------------------------------------------------- outreach channels --- */

/** The channels V1.2 can actually send through. */
export const OUTREACH_CHANNELS = ['linkedin', 'email', 'instagram', 'upwork'] as const;
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];

/* -------------------------------------------------------- agent jobs ---- */

export const AGENT_JOB_TYPES = [
  'RESEARCH_COMPANY',
  'RESEARCH_PERSON',
  'RESEARCH_SIGNALS',
  'CAPTURE_PROFILE',
  'ENRICH_PROFILE',
  'QUALIFY_LEAD',
  'BUILD_CONTEXT',
  'DRAFT_OUTREACH',
  'OTHER',
] as const;
export type AgentJobType = (typeof AGENT_JOB_TYPES)[number];

export const AGENT_JOB_STATUSES = [
  'OPEN',
  'RUNNING',
  'WAITING_AI',
  'COMPLETE',
  'FAILED',
  'CANCELLED',
] as const;
export type AgentJobStatus = (typeof AGENT_JOB_STATUSES)[number];

/** The same four-step scale as `TASK_PRIORITIES`, kept separate so the two can move apart. */
export const AGENT_JOB_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type AgentJobPriority = (typeof AGENT_JOB_PRIORITIES)[number];

/* ---------------------------------------------------------- AI tasks ---- */

export const AI_TASK_TYPES = [
  'PROFILE_EXTRACTION',
  'COMPANY_EXTRACTION',
  'SIGNAL_EXTRACTION',
  'ICP_QUALIFICATION',
  'CONTEXT_BUILD',
  'MESSAGE_DRAFT',
  'REPLY_CLASSIFICATION',
] as const;
export type AiTaskType = (typeof AI_TASK_TYPES)[number];

/** Keys into the prompt library; one row per key, versioned in the database. */
export const PROMPT_KEYS = [
  'profile_extract',
  'company_extract',
  'signal_extract',
  'icp_qualify',
  'context_build',
  'linkedin_initial',
  'linkedin_followup',
  'email_initial',
  'email_followup',
  'instagram_dm',
  'upwork_proposal',
  'reply_classify',
] as const;
export type PromptKey = (typeof PROMPT_KEYS)[number];

/* ----------------------------------------------------- contact points --- */

export const CONTACT_POINT_KINDS = [
  'email',
  'linkedin',
  'instagram',
  'upwork',
  'phone',
  'website',
  'other',
] as const;
export type ContactPointKind = (typeof CONTACT_POINT_KINDS)[number];

/* ---------------------------------------------------------- AI runs ----- */

export const AI_RUN_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'CACHED', 'SKIPPED'] as const;
export type AiRunStatus = (typeof AI_RUN_STATUSES)[number];

/* -------------------------------------------------- source <-> channel --- */

/**
 * Which outreach channels each discovery source is typically paired with — used
 * for UI copy only, never to restrict.
 *
 * Every source maps to *all four* channels, and that is the truthful answer, not
 * a shortcut: how a lead was discovered says nothing about how it may be
 * contacted. A Reddit-sourced lead with a LinkedIn URL is a LinkedIn lead. The
 * table exists so a screen can render channel chips without special-casing an
 * empty value; outreach eligibility is decided by contact points, the lead's
 * state and `outreachEligibility` in `permissions.ts`.
 */
export const CHANNELS_FOR_SOURCE: Readonly<Record<DiscoverySource, readonly OutreachChannel[]>> = {
  linkedin: OUTREACH_CHANNELS,
  upwork: OUTREACH_CHANNELS,
  reddit: OUTREACH_CHANNELS,
  job_board: OUTREACH_CHANNELS,
  youtube: OUTREACH_CHANNELS,
  instagram: OUTREACH_CHANNELS,
  company_website: OUTREACH_CHANNELS,
  google: OUTREACH_CHANNELS,
  web: OUTREACH_CHANNELS,
  apollo: OUTREACH_CHANNELS,
  csv: OUTREACH_CHANNELS,
  paste: OUTREACH_CHANNELS,
  mcp: OUTREACH_CHANNELS,
  companion: OUTREACH_CHANNELS,
  manual: OUTREACH_CHANNELS,
  other: OUTREACH_CHANNELS,
};

/* --------------------------------------------------- legacy source map --- */

/**
 * The V1.1 `LEAD_SOURCE_TYPES` values projected onto V1.2 `DISCOVERY_SOURCES`.
 *
 * `file_xlsx` collapses onto `csv` because V1.2 stores the artefact kind only in
 * the evidence row; `external_ingest` is a transport, not a discovery surface,
 * so it lands on `other`; `research_agent` work is public-web research.
 */
export const LEGACY_SOURCE_TO_DISCOVERY: Readonly<Record<LeadSourceType, DiscoverySource>> = {
  manual_add: 'manual',
  manual_companion: 'companion',
  file_csv: 'csv',
  file_xlsx: 'csv',
  paste_list: 'paste',
  google_search: 'google',
  apollo_basic: 'apollo',
  external_ingest: 'other',
  mcp_agent: 'mcp',
  research_agent: 'web',
};

/**
 * The inverse bridge: the V1.1 `leads.source_type` value a V1.2 discovery source
 * maps onto.
 *
 * The V1.2 source of truth for where a lead came from is
 * `source_evidence.source`, which is free text and carries the exact discovery
 * source. `leads.source_type` predates V1.2 and is constrained to the V1.1
 * vocabulary, so it keeps a coarse, backward-compatible value: surfaces that map
 * one-to-one do so exactly, and every browser-research surface (LinkedIn, Upwork,
 * Reddit, job boards, video, Instagram, a company site, the open web) lands on
 * `research_agent`, which is what it is. Nothing is discarded — the precise value
 * is in the evidence row.
 */
export const DISCOVERY_TO_LEGACY_SOURCE: Readonly<Record<DiscoverySource, LeadSourceType>> = {
  linkedin: 'research_agent',
  upwork: 'research_agent',
  reddit: 'research_agent',
  job_board: 'research_agent',
  youtube: 'research_agent',
  instagram: 'research_agent',
  company_website: 'research_agent',
  web: 'research_agent',
  other: 'research_agent',
  google: 'google_search',
  apollo: 'apollo_basic',
  csv: 'file_csv',
  paste: 'paste_list',
  manual: 'manual_add',
  companion: 'manual_companion',
  mcp: 'mcp_agent',
};

/** The `leads.source_type` value to store for a V1.2 discovery source. */
export function legacyLeadSourceFor(discovery: DiscoverySource): LeadSourceType {
  return DISCOVERY_TO_LEGACY_SOURCE[discovery];
}

const DISCOVERY_SOURCE_SET: ReadonlySet<string> = new Set<string>(DISCOVERY_SOURCES);
const LEAD_SOURCE_TYPE_SET: ReadonlySet<string> = new Set<string>(LEAD_SOURCE_TYPES);
const OUTREACH_CHANNEL_SET: ReadonlySet<string> = new Set<string>(OUTREACH_CHANNELS);

/** Lower-cases and drops every non-alphanumeric run, so 'job_board' == 'Job Board' == 'jobboard'. */
function squashSourceValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Projects a V1.1 `LeadSourceType` value onto a V1.2 `DiscoverySource`.
 *
 * A value that is already a discovery source is returned unchanged, so this can
 * be applied to a column that may hold either vocabulary during the migration.
 * Anything unrecognised becomes `other` rather than throwing: an unknown source
 * must never block a lead from being created.
 */
export function discoverySourceFromLegacy(value: string | null | undefined): DiscoverySource {
  if (value === null || value === undefined) return 'other';
  const raw = value.trim().toLowerCase();
  if (raw.length === 0) return 'other';
  if (DISCOVERY_SOURCE_SET.has(raw)) return raw as DiscoverySource;
  if (LEAD_SOURCE_TYPE_SET.has(raw)) return LEGACY_SOURCE_TO_DISCOVERY[raw as LeadSourceType];
  return 'other';
}

/**
 * Normalises a free-text source (e.g. 'LinkedIn manual import', 'reddit') to a
 * `DISCOVERY_SOURCE`, defaulting to 'other'. Case-insensitive; handles the
 * legacy enum values too.
 *
 * Source never dictates channel: the result is used for reporting, filtering and
 * UI copy, and must not be used to restrict which outreach channels a lead may
 * be contacted on — see `CHANNELS_FOR_SOURCE`.
 */
export function normalizeDiscoverySource(value: string | null | undefined): DiscoverySource {
  if (value === null || value === undefined) return 'other';
  const raw = value.trim().toLowerCase();
  if (raw.length === 0) return 'other';
  if (DISCOVERY_SOURCE_SET.has(raw)) return raw as DiscoverySource;
  if (LEAD_SOURCE_TYPE_SET.has(raw)) return LEGACY_SOURCE_TO_DISCOVERY[raw as LeadSourceType];

  const squashed = squashSourceValue(raw);
  if (squashed.length === 0) return 'other';
  // Order matters: the more specific phrase wins, so 'manual companion' is a
  // companion import and 'LinkedIn manual import' is a LinkedIn find.
  if (squashed.includes('linkedin')) return 'linkedin';
  if (squashed.includes('upwork')) return 'upwork';
  if (squashed.includes('reddit')) return 'reddit';
  if (squashed.includes('youtube')) return 'youtube';
  if (squashed.includes('instagram')) return 'instagram';
  if (
    squashed.includes('jobboard') ||
    squashed.includes('indeed') ||
    squashed.includes('greenhouse') ||
    squashed.includes('lever') ||
    squashed.includes('workable') ||
    squashed.includes('jobs')
  ) {
    return 'job_board';
  }
  if (squashed.includes('apollo')) return 'apollo';
  if (squashed.includes('google')) return 'google';
  if (squashed.includes('csv') || squashed.includes('xlsx') || squashed.includes('excel') || squashed.includes('spreadsheet')) {
    return 'csv';
  }
  if (squashed.includes('paste')) return 'paste';
  if (squashed.includes('companion') || squashed.includes('extension') || squashed.includes('chrome')) {
    return 'companion';
  }
  if (squashed.includes('mcp')) return 'mcp';
  if (squashed.includes('website') || squashed.includes('domain')) return 'company_website';
  if (squashed.includes('web') || squashed.includes('research') || squashed.includes('search')) return 'web';
  if (squashed.includes('manual') || squashed.includes('hand')) return 'manual';
  return 'other';
}

/**
 * Normalises a free-text outreach channel to an `OUTREACH_CHANNEL`.
 *
 * Returns `null` when the value is not one of the four V1.2 channels — a phone
 * number or a Twitter handle is a real contact route, just not one this pipeline
 * can send through, and inventing a channel for it would silently mis-route a
 * message. LinkedIn-ish values ('LinkedIn Sales Navigator', 'li') resolve to
 * 'linkedin' because that is the platform the operator was working in.
 */
export function normalizeOutreachChannel(value: string | null | undefined): OutreachChannel | null {
  if (value === null || value === undefined) return null;
  const raw = value.trim().toLowerCase();
  if (raw.length === 0) return null;
  if (OUTREACH_CHANNEL_SET.has(raw)) return raw as OutreachChannel;

  const squashed = squashSourceValue(raw);
  if (squashed.length === 0) return null;
  if (squashed.includes('linkedin') || squashed === 'li' || squashed === 'ln') return 'linkedin';
  if (squashed.includes('instagram') || squashed === 'ig' || squashed === 'insta') return 'instagram';
  if (squashed.includes('upwork')) return 'upwork';
  if (
    squashed.includes('email') ||
    squashed.includes('mail') ||
    squashed.includes('gmail') ||
    squashed.includes('outlook')
  ) {
    return 'email';
  }
  return null;
}
