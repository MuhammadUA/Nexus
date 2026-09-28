/**
 * The V1.2 processing-steps indicator, derived from stored rows.
 *
 * This lives in its own module — not beside the workspace component — because of a
 * Next.js boundary rule that bit the V1.2 Lead Detail page in a production build:
 * **every export of a `'use client'` module is a client reference**, so calling one
 * from a Server Component throws
 *
 *   Attempted to call processingSteps() from the server but processingSteps is on the client
 *
 * and the page answered 500. A unit render cannot catch that, because vitest does not
 * enforce the boundary; the browser E2E suite did. Keeping the pure derivation in a
 * module with no `'use client'` makes it callable from both sides.
 *
 * The steps themselves are §67.2 of the master spec: each state is read from a stored
 * row rather than assumed from client optimism, and the screen must say it is waiting
 * on an agent rather than showing an indefinite spinner (§67.5).
 */

export type ProcessingStepState = 'done' | 'current' | 'pending' | 'waiting' | 'failed';

export interface ProcessingStep {
  readonly key: string;
  readonly label: string;
  readonly state: ProcessingStepState;
  readonly detail: string;
}

export interface ProcessingStepInput {
  /** The lead row exists: the discovery source has been captured. */
  readonly leadExists: boolean;
  /** A full name is committed. */
  readonly personResolved: boolean;
  /** A company with a domain is committed. */
  readonly companyResolved: boolean;
  /** A profile extraction has committed facts (`last_profile_enrichment_at`). */
  readonly profileExtractionDone: boolean;
  /** A committed company research snapshot exists. */
  readonly companyResearchDone: boolean;
  /** A `RESEARCH_COMPANY` job is OPEN/RUNNING/WAITING_AI. */
  readonly companyResearchJobOpen: boolean;
  /** A qualification (`lead_icp_matches`) is recorded. */
  readonly qualificationDone: boolean;
  /** `lead_enrichment.status`. */
  readonly enrichmentState: string;
  /** `lead_enrichment.last_error_code`, when the last attempt failed. */
  readonly lastErrorCode: string | null;
}

/**
 * The first unfinished step is marked `current`, so the indicator always names exactly
 * what is happening next. A step waiting on an agent is `waiting`, not `current`.
 */
export function processingSteps(input: ProcessingStepInput): readonly ProcessingStep[] {
  const failed = input.enrichmentState === 'FAILED';
  const inReview = input.enrichmentState === 'NEEDS_REVIEW';
  const aiProcessing = input.enrichmentState === 'AI_PROCESSING';

  const steps: ProcessingStep[] = [
    {
      key: 'source_captured',
      label: 'Source captured',
      state: input.leadExists ? 'done' : 'pending',
      detail: 'the lead row exists with its discovery source and provenance',
    },
    {
      key: 'person_resolved',
      label: 'Person resolved',
      state: input.personResolved ? 'done' : 'pending',
      detail: 'a canonical person is linked to this lead',
    },
    {
      key: 'company_resolved',
      label: 'Company resolved',
      state: input.companyResolved ? 'done' : 'pending',
      detail: 'a company with a website is linked to this lead',
    },
    {
      key: 'profile_extraction',
      label: 'Profile extraction',
      state: input.profileExtractionDone ? 'done' : 'pending',
      detail: 'structured facts committed from the captured profile',
    },
    {
      key: 'company_research',
      label: 'Company research pending',
      state: input.companyResearchDone
        ? 'done'
        : input.companyResearchJobOpen
          ? 'waiting'
          : 'pending',
      detail: input.companyResearchJobOpen
        ? 'an agent job is open and waits durably; you may leave this page'
        : 'a committed company research snapshot with provenance',
    },
    {
      key: 'qualification',
      label: 'Qualification pending',
      state: input.qualificationDone ? 'done' : 'pending',
      detail: 'an ICP match and intent assessment recorded for this lead',
    },
    {
      key: 'ready',
      label: 'Ready for outreach',
      state: input.enrichmentState === 'READY' ? 'done' : 'pending',
      detail: 'the readiness threshold and a context pack are both satisfied',
    },
  ];

  // The first unfinished step is the current one, unless it is waiting on an agent.
  const firstOpen = steps.find((step) => step.state !== 'done');
  const mapped = steps.map((step) =>
    step === firstOpen && step.state === 'pending' ? { ...step, state: 'current' as const } : step,
  );

  if (failed) {
    const target = mapped.find((step) => step.state === 'current') ?? mapped[mapped.length - 1];
    if (target !== undefined) {
      return mapped.map((step) =>
        step.key === target.key
          ? { ...step, state: 'failed' as const, detail: `failed: ${input.lastErrorCode ?? 'unknown error code'}` }
          : step,
      );
    }
  }

  if (inReview) {
    const review = mapped.find((step) => step.state === 'current') ?? mapped[0];
    return mapped.map((step) =>
      step === review
        ? {
            ...step,
            state: 'failed' as const,
            detail: 'a user-confirmed value conflicts; a review decision is required',
          }
        : step,
    );
  }

  if (aiProcessing) {
    const first = mapped.findIndex((step) => step.state === 'current');
    if (first >= 0) {
      const step = mapped[first];
      if (step !== undefined) {
        return mapped.map((candidate, index) =>
          index === first
            ? { ...candidate, state: 'waiting' as const, detail: 'AI work is in flight; nothing blocks the page' }
            : candidate,
        );
      }
    }
  }

  return mapped;
}
