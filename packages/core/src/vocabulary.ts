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
