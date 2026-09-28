/**
 * Agent job planning — pure, deterministic, database-free.
 *
 * The V1.2 pipeline is a chain: capture the profile -> research the company ->
 * find signals -> build the AI context pack -> draft outreach. Each hop becomes a
 * row in `agent_jobs` that a worker (or the Companion extension) claims. This
 * module answers one question: *given what we know about a lead right now, which
 * hops are outstanding?*
 *
 * It is pure on purpose, for two reasons:
 *
 *   * the same lead must plan the same work every time it is planned. The planner
 *     runs from a request handler and from a background sweep; if it were
 *     stateful or time-dependent, those two callers would disagree and a lead
 *     would be stamped with duplicate jobs;
 *   * the plan must be testable without a database, because the interesting bugs
 *     here are chaining bugs (a loop, a missing hop, a duplicate), not SQL.
 *
 * Re-planning is made safe by `dedupeKey`: it is derived only from the job type,
 * the lead and its company/person scope, so the caller can hand back the keys of
 * every job still OPEN/RUNNING/WAITING_AI and get an empty plan instead of a
 * second copy of work already in flight. That is also what makes the chain
 * loop-free: a completed job leaves the open set only once it is done, and a
 * re-plan can then only produce the *next* hop, never a hop already satisfied.
 *
 * Nothing here writes, enqueues or estimates cost. The caller decides whether to
 * persist the plans.
 */

import type { AgentJobPriority, AgentJobType, EnrichmentState } from './vocabulary.js';

export interface AgentJobPlan {
  readonly type: AgentJobType;
  readonly priority: AgentJobPriority;
  readonly instructions: string;
  readonly requiredCapabilities: readonly string[];
  /** Stable dedupe key: `${type}:${leadId}:${companyId ?? personId ?? '-'}` */
  readonly dedupeKey: string;
  /** Why this job exists — recorded on the job row so automatic chaining is never mysterious. */
  readonly reason: string;
}

/**
 * What a worker must be able to do to take each job type.
 *
 * Declared here rather than on the worker so a job can never be offered to an
 * agent that cannot perform it: the gateway matches these strings against the
 * caller's declared capabilities before claiming. `browser` means a real logged-in
 * browsing context (the Companion extension), `public_web` means unauthenticated
 * fetching, and the `ai_*` entries mean a call through the server-side model
 * gateway — never a raw provider key on the worker.
 */
export const AGENT_JOB_CAPABILITIES: Readonly<Record<AgentJobType, readonly string[]>> = {
  RESEARCH_COMPANY: ['browser', 'public_web'],
  RESEARCH_PERSON: ['browser', 'public_web'],
  RESEARCH_SIGNALS: ['browser', 'public_web', 'news'],
  CAPTURE_PROFILE: ['linkedin_profile_read'],
  ENRICH_PROFILE: ['linkedin_profile_read'],
  QUALIFY_LEAD: ['ai_qualify'],
  BUILD_CONTEXT: ['ai_context'],
  DRAFT_OUTREACH: ['ai_draft'],
  OTHER: [],
};

export interface ChainInput {
  readonly leadId: string;
  readonly personId: string | null;
  readonly companyId: string | null;
  readonly enrichmentState: EnrichmentState;
  readonly hasLinkedinUrl: boolean;
  readonly hasCompanyWebsite: boolean;
  readonly hasCompanyResearch: boolean;
  readonly hasAiContext: boolean;
  readonly openJobKeys: readonly string[]; // dedupe keys of jobs already OPEN/RUNNING/WAITING_AI
  /**
   * ICP qualification state, when the caller can supply it.
   *
   * Optional so every existing caller keeps its behaviour: without it the planner
   * plans no qualification, which is the conservative default — a caller that
   * cannot say whether the current facts have already been scored must not cause a
   * model call. The AI processor computes it and passes it.
   */
  readonly qualification?: QualificationChainInput;
}

/** What the planner needs to know about qualification, all of it stored facts. */
export interface QualificationChainInput {
  readonly prerequisites: QualificationPrerequisites;
  /**
   * True when a committed qualification already answers exactly today's facts.
   *
   * The comparison is the qualification *input hash*: identical facts, prompt
   * version and model mean the stored answer is still the answer, so a new job
   * would only buy the same result again. Changed facts change the hash, which is
   * what makes requalification automatic rather than manual.
   */
  readonly qualifiedForCurrentInput: boolean;
}

/* ------------------------------------------------------ qualification --- */

export interface QualificationPrerequisites {
  /** A canonical person with a committed name. */
  readonly personResolved: boolean;
  /** A canonical company. */
  readonly companyResolved: boolean;
  /** A committed company research snapshot exists. */
  readonly hasCompanyResearch: boolean;
  /** Active signals recorded for the lead, its person or its company. */
  readonly signalCount: number;
  /** A cached AI context pack exists for the lead. */
  readonly hasAiContext: boolean;
}

export interface QualificationReadiness {
  readonly ready: boolean;
  /** What is missing, named so the queue can say why a lead is not being scored. */
  readonly missing: readonly string[];
}

/**
 * Whether there is enough committed structure to score a lead against an ICP.
 *
 * The bar is deliberate: a person, a company, and at least one piece of
 * *intelligence* (company research, a signal, or an AI context pack) to score
 * against. Scoring a bare name would be the model inventing the evidence, and
 * scoring before the company is resolved would put a fit score on the lead that
 * the next enrichment hop invalidates.
 */
export function qualificationPrerequisites(facts: QualificationPrerequisites): QualificationReadiness {
  const missing: string[] = [];
  if (!facts.personResolved) missing.push('person');
  if (!facts.companyResolved) missing.push('company');
  if (!facts.hasCompanyResearch && facts.signalCount <= 0 && !facts.hasAiContext) {
    missing.push('intelligence (company research, a signal or an AI context pack)');
  }
  return { ready: missing.length === 0, missing };
}

/**
 * Priority per job type.
 *
 * Research is `high`: it is only ever planned for a lead that already exists, and
 * a lead exists because it matched an ICP — so the facts that make it
 * contactable are the blocking work, not background tidying. Context building is
 * `normal` (READY-path work that feeds drafting, which is not scheduled yet), and
 * the rest is `normal`. `low` and `urgent` are operator choices recorded on the
 * row; the planner never invents them.
 */
const DEFAULT_AGENT_JOB_PRIORITIES: Readonly<Record<AgentJobType, AgentJobPriority>> = {
  RESEARCH_COMPANY: 'high',
  RESEARCH_PERSON: 'high',
  RESEARCH_SIGNALS: 'high',
  CAPTURE_PROFILE: 'normal',
  ENRICH_PROFILE: 'normal',
  QUALIFY_LEAD: 'normal',
  BUILD_CONTEXT: 'normal',
  DRAFT_OUTREACH: 'normal',
  OTHER: 'normal',
};

/** The planner's priority for a job type. */
export function defaultPriority(type: AgentJobType): AgentJobPriority {
  return DEFAULT_AGENT_JOB_PRIORITIES[type];
}

/**
 * States from which automatic chaining is allowed to start.
 *
 * A narrow allow-list rather than "anything but NEEDS_PROFILE", because the
 * excluded states each mean something specific and none of them wants another
 * automatic hop: MINIMAL is mid-ingestion, AI_PROCESSING already has a model
 * working, READY has everything, and NEEDS_REVIEW/FAILED are waiting on a human.
 * Planning research from a state that is already past research would also fight
 * the worker that set it.
 */
const RESEARCH_PLANNABLE_STATES: ReadonlySet<EnrichmentState> = new Set<EnrichmentState>([
  'PROFILE_READY',
  'COMPANY_RESEARCH_PENDING',
  'AGENT_RESEARCH_PENDING',
]);

/**
 * States from which a qualification hop may be planned.
 *
 * Wider than the research list by exactly one state: `READY`. A ready lead that
 * has not been scored — or whose facts have changed since it was scored — needs a
 * qualification, and refusing one would leave the fit and intent the drafts depend
 * on permanently stale. Research is not re-planned from READY because it is
 * expensive and its absence would have blocked readiness in the first place;
 * qualification is cheap, cached by input hash, and only planned when the stored
 * answer no longer matches the facts.
 */
const QUALIFICATION_PLANNABLE_STATES: ReadonlySet<EnrichmentState> = new Set<EnrichmentState>([
  'PROFILE_READY',
  'COMPANY_RESEARCH_PENDING',
  'AGENT_RESEARCH_PENDING',
  'READY',
]);

const INSTRUCTIONS: Readonly<Record<AgentJobType, string>> = {
  RESEARCH_COMPANY:
    'Research the company: what it does, size, locations, services and recent activity. Record each finding with its source URL.',
  RESEARCH_PERSON:
    'Research the person: current role, remit, tenure and public activity. Record each finding with its source URL.',
  RESEARCH_SIGNALS:
    'Look for buying signals (hiring, expansion, new video or podcast output, tenders, funding) and record each one with its source URL.',
  CAPTURE_PROFILE: "Capture the person's LinkedIn profile page and keep the raw payload as evidence.",
  ENRICH_PROFILE:
    'Enrich the lead from the captured profile page: name, title, location, company and contact points.',
  QUALIFY_LEAD: 'Score this lead against the active ICP and record the pass/fail decision with reasons.',
  BUILD_CONTEXT:
    'Build the AI context pack for this lead from the captured profile, the company research and the recorded signals.',
  DRAFT_OUTREACH: 'Draft the next outreach message for this lead using the AI context pack.',
  OTHER: 'No default instruction; the caller must describe the work.',
};

/**
 * Returns the jobs to create now, at most one per type, skipping any whose dedupe
 * key is already open.
 *
 * Rules:
 *   * NEEDS_PROFILE -> nothing (human-assisted enrichment is the path);
 *   * PROFILE_READY with no company research -> RESEARCH_COMPANY;
 *   * company research present and signals absent -> RESEARCH_SIGNALS;
 *   * company research + context absent -> BUILD_CONTEXT (only when company
 *     research exists);
 *   * prerequisites met and the stored qualification does not answer the current
 *     facts -> QUALIFY_LEAD (only when the caller supplied the qualification state).
 *
 * There is no separate `signalCount` on the input by design: while a company
 * research snapshot exists and no context pack has been built yet, signal
 * discovery is still outstanding, because the context pack is assembled *from*
 * the signals. Once the pack exists, the signals phase has completed and neither
 * job is re-planned.
 *
 * Never returns a job whose dedupe key is in `openJobKeys`. Never returns more
 * than three plans: the research branch and the signals/context branch are mutually
 * exclusive (`!hasCompanyResearch` versus `hasCompanyResearch`), each branch pushes
 * each type at most once, and qualification adds at most one more.
 *
 * Loop-free by construction: a type whose dedupe key is already open is never
 * re-created, so feeding a plan's own keys back in as `openJobKeys` yields
 * nothing. Qualification carries the same guarantee at the *facts* level as well —
 * once it succeeds, `qualifiedForCurrentInput` becomes true and the plan is not
 * produced again until the facts actually change.
 */
export function planChainedJobs(input: ChainInput): readonly AgentJobPlan[] {
  // A lead with no usable profile is a human task: the operator is already
  // looking at the page, and the Companion extension captures it in one click.
  if (input.enrichmentState === 'NEEDS_PROFILE') return [];

  const scope = input.companyId ?? input.personId ?? '-';
  const plans: AgentJobPlan[] = [];

  const plan = (type: AgentJobType, reason: string): void => {
    const dedupeKey = `${type}:${input.leadId}:${scope}`;
    if (input.openJobKeys.includes(dedupeKey)) return; // already in flight; never duplicate work
    if (plans.some((existing) => existing.type === type)) return; // at most one job per type
    plans.push({
      type,
      priority: defaultPriority(type),
      instructions: INSTRUCTIONS[type],
      requiredCapabilities: AGENT_JOB_CAPABILITIES[type],
      dedupeKey,
      reason,
    });
  };

  if (!input.hasCompanyResearch && RESEARCH_PLANNABLE_STATES.has(input.enrichmentState)) {
    plan(
      'RESEARCH_COMPANY',
      `no company research snapshot exists for enrichment state ${input.enrichmentState}`,
    );
  }

  if (input.hasCompanyResearch && !input.hasAiContext) {
    plan(
      'RESEARCH_SIGNALS',
      'company research exists but no AI context pack has been built, so signal discovery is still outstanding',
    );
    plan(
      'BUILD_CONTEXT',
      'company research exists but this lead has no cached AI context pack',
    );
  }

  // Qualification, when the caller could tell us whether it is outstanding. It is
  // planned last so the hops that *create* the facts it scores against are already
  // in the queue, and it is skipped entirely once the stored answer matches the
  // current input hash — which is what stops a page view or a sweep from buying
  // the same model call again.
  if (input.qualification !== undefined) {
    const readiness = qualificationPrerequisites(input.qualification.prerequisites);
    if (readiness.ready && !input.qualification.qualifiedForCurrentInput && QUALIFICATION_PLANNABLE_STATES.has(input.enrichmentState)) {
      plan(
        'QUALIFY_LEAD',
        'structured person, company and intelligence facts are committed and no qualification answers the current facts',
      );
    }
  }

  return plans;
}
