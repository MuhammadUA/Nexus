import { describe, expect, it } from 'vitest';
import {
  AGENT_JOB_CAPABILITIES,
  defaultPriority,
  planChainedJobs,
  qualificationPrerequisites,
  type AgentJobPlan,
  type ChainInput,
  type QualificationPrerequisites,
} from './agent-jobs.js';
import { AGENT_JOB_PRIORITIES, AGENT_JOB_TYPES, ENRICHMENT_STATES } from './vocabulary.js';

/** The bar for scoring a lead: person, company, and something to score against. */
const READY_PREREQUISITES: QualificationPrerequisites = {
  personResolved: true,
  companyResolved: true,
  hasCompanyResearch: true,
  signalCount: 2,
  hasAiContext: true,
};

/** A lead whose profile is ready, with the company still unresearched. */
function input(overrides: Partial<ChainInput> = {}): ChainInput {
  return {
    leadId: 'lead-1',
    personId: 'person-1',
    companyId: 'company-1',
    enrichmentState: 'PROFILE_READY',
    hasLinkedinUrl: true,
    hasCompanyWebsite: true,
    hasCompanyResearch: false,
    hasAiContext: false,
    openJobKeys: [],
    ...overrides,
  };
}

function types(plans: readonly AgentJobPlan[]): string[] {
  return plans.map((plan) => plan.type);
}

/* -------------------------------------------------------- plan shapes ---- */

describe('planChainedJobs', () => {
  it('plans nothing for a lead that needs a profile (human-assisted enrichment is the path)', () => {
    expect(planChainedJobs(input({ enrichmentState: 'NEEDS_PROFILE' }))).toEqual([]);
    // Even when a matching job is somehow already open, rule one still wins.
    expect(
      planChainedJobs(input({ enrichmentState: 'NEEDS_PROFILE', openJobKeys: ['RESEARCH_COMPANY:lead-1:company-1'] })),
    ).toEqual([]);
  });

  it('plans RESEARCH_COMPANY when the profile is ready and no company research exists', () => {
    const plans = planChainedJobs(input({ enrichmentState: 'PROFILE_READY', hasCompanyResearch: false }));
    expect(types(plans)).toEqual(['RESEARCH_COMPANY']);
    const [plan] = plans;
    expect(plan).toBeDefined();
    if (plan === undefined) throw new Error('expected a plan');
    expect(plan.dedupeKey).toBe('RESEARCH_COMPANY:lead-1:company-1');
    expect(plan.priority).toBe('high');
    expect(plan.reason).toContain('no company research');
    expect(plan.requiredCapabilities.length).toBeGreaterThan(0);
    expect(plan.instructions.length).toBeGreaterThan(0);
  });

  it('plans RESEARCH_COMPANY from COMPANY_RESEARCH_PENDING and AGENT_RESEARCH_PENDING too', () => {
    expect(types(planChainedJobs(input({ enrichmentState: 'COMPANY_RESEARCH_PENDING' })))).toEqual([
      'RESEARCH_COMPANY',
    ]);
    expect(types(planChainedJobs(input({ enrichmentState: 'AGENT_RESEARCH_PENDING' })))).toEqual([
      'RESEARCH_COMPANY',
    ]);
  });

  it('plans RESEARCH_SIGNALS and BUILD_CONTEXT once company research exists but no context pack does', () => {
    const plans = planChainedJobs(input({ hasCompanyResearch: true, hasAiContext: false }));
    expect(types(plans)).toEqual(['RESEARCH_SIGNALS', 'BUILD_CONTEXT']);
    expect(plans.map((plan) => plan.priority)).toEqual(['high', 'normal']);
    expect(plans.map((plan) => plan.dedupeKey)).toEqual([
      'RESEARCH_SIGNALS:lead-1:company-1',
      'BUILD_CONTEXT:lead-1:company-1',
    ]);
  });

  it('plans nothing once the context pack exists', () => {
    expect(planChainedJobs(input({ hasCompanyResearch: true, hasAiContext: true }))).toEqual([]);
    expect(
      planChainedJobs(input({ enrichmentState: 'READY', hasCompanyResearch: true, hasAiContext: true })),
    ).toEqual([]);
  });

  it('plans nothing from states that are mid-pipeline or waiting on a human', () => {
    for (const state of ['MINIMAL', 'AI_PROCESSING', 'NEEDS_REVIEW', 'FAILED'] as const) {
      expect(planChainedJobs(input({ enrichmentState: state }))).toEqual([]);
    }
  });

  it('returns at most three plans, never two of the same type, for every state and fact combination', () => {
    for (const enrichmentState of ENRICHMENT_STATES) {
      for (const hasCompanyResearch of [false, true]) {
        for (const hasAiContext of [false, true]) {
          const plans = planChainedJobs(input({ enrichmentState, hasCompanyResearch, hasAiContext }));
          expect(plans.length).toBeLessThanOrEqual(2);
          expect(new Set(types(plans)).size).toBe(plans.length);
          expect(new Set(plans.map((plan) => plan.dedupeKey)).size).toBe(plans.length);
        }
      }
    }

    // With qualification state supplied the ceiling is three: the research branch
    // and the signals/context branch are mutually exclusive, and qualification adds
    // at most one more.
    for (const enrichmentState of ENRICHMENT_STATES) {
      const plans = planChainedJobs(
        input({
          enrichmentState,
          hasCompanyResearch: false,
          hasAiContext: false,
          qualification: { prerequisites: READY_PREREQUISITES, qualifiedForCurrentInput: false },
        }),
      );
      expect(plans.length).toBeLessThanOrEqual(3);
      expect(new Set(types(plans)).size).toBe(plans.length);
    }
  });

  it('keeps the plan stable across repeated calls (same facts, same plan)', () => {
    const first = planChainedJobs(input({ hasCompanyResearch: true, hasAiContext: false }));
    const second = planChainedJobs(input({ hasCompanyResearch: true, hasAiContext: false }));
    expect(second).toEqual(first);
  });
});

/* ----------------------------------------------------- qualification ----- */

describe('qualificationPrerequisites', () => {
  it('is ready on a person, a company and one piece of intelligence', () => {
    expect(qualificationPrerequisites(READY_PREREQUISITES).ready).toBe(true);
    expect(qualificationPrerequisites(READY_PREREQUISITES).missing).toEqual([]);
  });

  it('accepts a signal or a context pack in place of company research', () => {
    const base = { ...READY_PREREQUISITES, hasCompanyResearch: false };
    expect(qualificationPrerequisites({ ...base, signalCount: 1, hasAiContext: false }).ready).toBe(true);
    expect(qualificationPrerequisites({ ...base, signalCount: 0, hasAiContext: true }).ready).toBe(true);
  });

  it('is not ready without a person, a company, or anything to score against', () => {
    const noPerson = qualificationPrerequisites({ ...READY_PREREQUISITES, personResolved: false });
    expect(noPerson.ready).toBe(false);
    expect(noPerson.missing).toContain('person');

    const noCompany = qualificationPrerequisites({ ...READY_PREREQUISITES, companyResolved: false });
    expect(noCompany.ready).toBe(false);
    expect(noCompany.missing).toContain('company');

    const nothingToScore = qualificationPrerequisites({
      ...READY_PREREQUISITES,
      hasCompanyResearch: false,
      signalCount: 0,
      hasAiContext: false,
    });
    expect(nothingToScore.ready).toBe(false);
    expect(nothingToScore.missing.join(' ')).toContain('intelligence');
  });
});

describe('planChainedJobs qualification', () => {
  it('plans QUALIFY_LEAD last, once the facts are there and no answer covers them', () => {
    const plans = planChainedJobs(
      input({
        hasCompanyResearch: true,
        hasAiContext: false,
        qualification: { prerequisites: READY_PREREQUISITES, qualifiedForCurrentInput: false },
      }),
    );
    expect(types(plans)).toEqual(['RESEARCH_SIGNALS', 'BUILD_CONTEXT', 'QUALIFY_LEAD']);
    const qualification = plans[2];
    expect(qualification?.dedupeKey).toBe('QUALIFY_LEAD:lead-1:company-1');
    expect(qualification?.requiredCapabilities).toEqual(['ai_qualify']);
    expect(qualification?.priority).toBe('normal');
    expect(qualification?.reason).toContain('no qualification answers the current facts');
  });

  it('plans nothing for qualification when the stored answer matches the current facts', () => {
    const plans = planChainedJobs(
      input({
        hasCompanyResearch: true,
        hasAiContext: true,
        qualification: { prerequisites: READY_PREREQUISITES, qualifiedForCurrentInput: true },
      }),
    );
    expect(types(plans)).toEqual([]);
  });

  it('requalifies from READY when the facts have changed', () => {
    const plans = planChainedJobs(
      input({
        enrichmentState: 'READY',
        hasCompanyResearch: true,
        hasAiContext: true,
        qualification: { prerequisites: READY_PREREQUISITES, qualifiedForCurrentInput: false },
      }),
    );
    expect(types(plans)).toEqual(['QUALIFY_LEAD']);
  });

  it('plans nothing for qualification when the prerequisites are unmet', () => {
    for (const prerequisites of [
      { ...READY_PREREQUISITES, personResolved: false },
      { ...READY_PREREQUISITES, companyResolved: false },
      { ...READY_PREREQUISITES, hasCompanyResearch: false, signalCount: 0, hasAiContext: false },
    ] satisfies QualificationPrerequisites[]) {
      const plans = planChainedJobs(
        input({
          enrichmentState: 'READY',
          hasCompanyResearch: true,
          hasAiContext: true,
          qualification: { prerequisites, qualifiedForCurrentInput: false },
        }),
      );
      expect(types(plans)).toEqual([]);
    }
  });

  it('plans no qualification for a lead that is mid-ingestion or waiting on a human', () => {
    for (const enrichmentState of ['NEEDS_PROFILE', 'MINIMAL', 'AI_PROCESSING', 'NEEDS_REVIEW', 'FAILED'] as const) {
      const plans = planChainedJobs(
        input({
          enrichmentState,
          hasCompanyResearch: true,
          hasAiContext: true,
          qualification: { prerequisites: READY_PREREQUISITES, qualifiedForCurrentInput: false },
        }),
      );
      expect(types(plans)).not.toContain('QUALIFY_LEAD');
    }
  });

  it('is loop-free at the facts level: an open qualification job suppresses the plan', () => {
    const first = planChainedJobs(
      input({
        hasCompanyResearch: true,
        hasAiContext: true,
        qualification: { prerequisites: READY_PREREQUISITES, qualifiedForCurrentInput: false },
      }),
    );
    const second = planChainedJobs(
      input({
        hasCompanyResearch: true,
        hasAiContext: true,
        openJobKeys: first.map((plan) => plan.dedupeKey),
        qualification: { prerequisites: READY_PREREQUISITES, qualifiedForCurrentInput: false },
      }),
    );
    expect(second).toEqual([]);
  });

  it('plans no qualification when the caller cannot report its state', () => {
    const plans = planChainedJobs(
      input({ enrichmentState: 'READY', hasCompanyResearch: true, hasAiContext: true }),
    );
    expect(types(plans)).not.toContain('QUALIFY_LEAD');
  });
});

/* ------------------------------------------------------------- dedupe ---- */

describe('planChainedJobs dedupe', () => {
  it('skips a job whose dedupe key is already open', () => {
    expect(
      planChainedJobs(
        input({
          hasCompanyResearch: false,
          openJobKeys: ['RESEARCH_COMPANY:lead-1:company-1'],
        }),
      ),
    ).toEqual([]);
  });

  it('skips only the open job and still plans the other', () => {
    const plans = planChainedJobs(
      input({
        hasCompanyResearch: true,
        hasAiContext: false,
        openJobKeys: ['RESEARCH_SIGNALS:lead-1:company-1'],
      }),
    );
    expect(types(plans)).toEqual(['BUILD_CONTEXT']);
  });

  it('does not treat another lead or company scope as a match', () => {
    const plans = planChainedJobs(
      input({
        hasCompanyResearch: false,
        openJobKeys: ['RESEARCH_COMPANY:lead-2:company-1', 'RESEARCH_COMPANY:lead-1:company-9'],
      }),
    );
    expect(types(plans)).toEqual(['RESEARCH_COMPANY']);
  });

  it('is loop-free: feeding the first plan’s keys back in creates nothing', () => {
    const states = [
      input({ enrichmentState: 'PROFILE_READY', hasCompanyResearch: false }),
      input({ enrichmentState: 'COMPANY_RESEARCH_PENDING' }),
      input({ enrichmentState: 'AGENT_RESEARCH_PENDING' }),
      input({ enrichmentState: 'AGENT_RESEARCH_PENDING', hasCompanyResearch: true, hasAiContext: false }),
    ];
    for (const first of states) {
      const plans = planChainedJobs(first);
      expect(plans.length).toBeGreaterThan(0);
      const second = planChainedJobs({ ...first, openJobKeys: plans.map((plan) => plan.dedupeKey) });
      expect(second).toEqual([]);
    }
  });

  it('scopes the dedupe key to company, then person, then a placeholder', () => {
    expect(planChainedJobs(input({ companyId: null }))[0]?.dedupeKey).toBe('RESEARCH_COMPANY:lead-1:person-1');
    expect(planChainedJobs(input({ companyId: null, personId: null }))[0]?.dedupeKey).toBe(
      'RESEARCH_COMPANY:lead-1:-',
    );
  });
});

/* ------------------------------------------------ capabilities & priority - */

describe('AGENT_JOB_CAPABILITIES', () => {
  it('declares a capability list for every job type', () => {
    for (const type of AGENT_JOB_TYPES) {
      expect(AGENT_JOB_CAPABILITIES[type]).toBeDefined();
    }
  });

  it('requires capabilities for every research type', () => {
    for (const type of ['RESEARCH_COMPANY', 'RESEARCH_PERSON', 'RESEARCH_SIGNALS'] as const) {
      expect(AGENT_JOB_CAPABILITIES[type].length).toBeGreaterThan(0);
    }
    expect(AGENT_JOB_CAPABILITIES.RESEARCH_COMPANY).toEqual(['browser', 'public_web']);
    expect(AGENT_JOB_CAPABILITIES.RESEARCH_SIGNALS).toEqual(['browser', 'public_web', 'news']);
  });

  it('planning a research job carries those capabilities onto the plan', () => {
    const [plan] = planChainedJobs(input({ hasCompanyResearch: false }));
    expect(plan?.requiredCapabilities).toEqual(['browser', 'public_web']);
  });

  it('lets OTHER carry no capability (the caller must describe the work)', () => {
    expect(AGENT_JOB_CAPABILITIES.OTHER).toEqual([]);
  });
});

describe('defaultPriority', () => {
  it('is high for research (the lead already cleared ICP) and normal elsewhere', () => {
    expect(defaultPriority('RESEARCH_COMPANY')).toBe('high');
    expect(defaultPriority('RESEARCH_PERSON')).toBe('high');
    expect(defaultPriority('RESEARCH_SIGNALS')).toBe('high');
    expect(defaultPriority('BUILD_CONTEXT')).toBe('normal');
    expect(defaultPriority('CAPTURE_PROFILE')).toBe('normal');
    expect(defaultPriority('ENRICH_PROFILE')).toBe('normal');
    expect(defaultPriority('QUALIFY_LEAD')).toBe('normal');
    expect(defaultPriority('DRAFT_OUTREACH')).toBe('normal');
    expect(defaultPriority('OTHER')).toBe('normal');
  });

  it('only ever returns a declared priority', () => {
    for (const type of AGENT_JOB_TYPES) {
      expect(AGENT_JOB_PRIORITIES).toContain(defaultPriority(type));
    }
  });
});
