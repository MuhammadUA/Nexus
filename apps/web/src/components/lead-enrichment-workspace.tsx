'use client';

/**
 * The V1.2 enrichment workspace (§31) and the enrichment row actions (§68.3).
 *
 * This is the only place in the product that accepts a raw paste, and that is the whole
 * reason it is a separate component: §32.2.6 requires that discarded raw is never
 * re-displayed, so the textarea's value lives in *client* state that starts empty and is
 * cleared on success. No server value is ever bound to it — a `defaultValue` from the
 * server, or an action result that echoed the paste back, would re-display text the
 * pipeline has already deleted.
 *
 * Everything else here is the deterministic half of enrichment:
 *
 *   * the generated Google queries come from `searchLinks()` in `@nexus/core` (§30.1 —
 *     a model must never compose a search query, and a search link must never cost a
 *     token). A link whose precondition is unmet is rendered *disabled with the missing
 *     field named* rather than as a link that cannot work (§30.3.4);
 *   * the processing steps (§67.2) are derived from stored rows by `processingSteps`,
 *     so enrichment never feels synchronous and no spinner is ever shown for work the
 *     operator could instead do by hand (§67.5);
 *   * the add-lead form is the §2 minimal-lead path, submitted through the audited
 *     ingest pipeline rather than by inserting rows itself.
 */
import * as React from 'react';

import { searchLinks, type SearchLink } from '@nexus/core';
import {
  Alert,
  Button,
  Card,
  Chip,
  Field,
  Row,
  Select,
  Stack,
  TextArea,
  TextInput,
} from '@nexus/ui';

import {
  createAgentJobAction,
  createLeadAction,
  enrichProfileAction,
  recomputeEnrichmentAction,
  researchCompanyAction,
  type ActionResult,
  type CreateLeadResult,
  type EnrichProfileActionResult,
  type ResearchCompanyActionResult,
} from '@/app/b/[slug]/leads/[id]/actions';

import { enrichmentStateLabel, intelligenceLabel } from './lead-intelligence-brief';

const IDLE: ActionResult = { ok: false, error: null };

/** The research action reports a split, so its idle value carries the empty split. */
const IDLE_RESEARCH: ResearchCompanyActionResult = {
  ok: false,
  error: null,
  created: [],
  alreadyOpen: [],
};

/* ------------------------------------------------------------ search links -- */

export interface SearchLinkInputFacts {
  readonly fullName: string | null;
  readonly companyName: string | null;
  readonly location: string | null;
  readonly companyDomain?: string | null;
  readonly linkedinUrl?: string | null;
}

export interface UnavailableSearchLink {
  readonly key: SearchLink['key'];
  readonly label: string;
  /** The fact that is missing, named so the operator knows what to supply. */
  readonly reason: string;
}

/**
 * The §30.2 actions that cannot be built from the stored facts, with the missing field
 * named (§30.3.4). `searchLinks` omits an unbuildable link; the UI still has to *account*
 * for it, which is what this returns.
 */
export function missingSearchLinks(input: SearchLinkInputFacts): readonly UnavailableSearchLink[] {
  const has = (value: string | null | undefined): boolean =>
    typeof value === 'string' && value.trim().length > 0;
  const missing: UnavailableSearchLink[] = [];

  if (!has(input.fullName) && !has(input.linkedinUrl)) {
    missing.push({
      key: 'find_linkedin',
      label: 'Find LinkedIn profile',
      reason: 'person name is missing',
    });
  }
  if (!has(input.fullName) || (!has(input.companyName) && !has(input.location))) {
    missing.push({
      key: 'search_person',
      label: 'Search this person',
      reason: has(input.fullName)
        ? 'company or location is missing'
        : 'person name is missing',
    });
  }
  if (!has(input.companyName) && !has(input.companyDomain)) {
    missing.push({ key: 'search_company', label: 'Search this company', reason: 'company is missing' });
    missing.push({
      key: 'search_signals',
      label: 'Search for buying signals',
      reason: 'company is missing',
    });
  }
  return missing;
}

/* -------------------------------------------------------- processing steps -- */

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
 * §67.2 — the named processing steps, each derived from stored rows rather than from
 * client-side optimism. The first unfinished step is marked `current`, so the indicator
 * always names exactly what is happening next.
 *
 * A step waiting on an agent is `waiting`, not `current`: §67.5 requires the screen to say
 * it is waiting and offer the manual alternative rather than showing an indefinite spinner.
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
        ? { ...step, state: 'failed' as const, detail: 'a user-confirmed value conflicts; a review decision is required' }
        : step,
    );
  }

  if (aiProcessing) {
    const first = mapped.findIndex((step) => step.state === 'current');
    if (first >= 0) {
      const step = mapped[first];
      if (step !== undefined) {
        return mapped.map((candidate, index) =>
          index === first ? { ...candidate, state: 'waiting' as const, detail: 'AI work is in flight; nothing blocks the page' } : candidate,
        );
      }
    }
  }

  return mapped;
}

/* ------------------------------------------------------------ sub-controls -- */

function GeneratedSearchLinks({ links }: { readonly links: readonly SearchLink[] }): React.ReactElement {
  return (
    <Stack size="sm">
      {links.map((link) => (
        <div key={link.key} className="nx-search-link">
          <Row between wrap>
            <span className="nx-label">{link.label}</span>
            <a
              className="nx-btn nx-btn--secondary nx-btn--sm"
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Google Search
            </a>
          </Row>
          {/* §30.4: the query is visible and copyable so it can be run outside the browser. */}
          <code className="nx-search-link__query">{link.query}</code>
        </div>
      ))}
    </Stack>
  );
}

function UnavailableSearchLinks({
  links,
}: {
  readonly links: readonly UnavailableSearchLink[];
}): React.ReactElement {
  return (
    <Stack size="sm">
      {links.map((link) => (
        <Row key={link.key} between wrap>
          <span className="nx-label">{link.label}</span>
          <Row wrap>
            <Button variant="secondary" size="sm" disabled title={link.reason}>
              Open Google Search
            </Button>
            <span className="nx-hint">disabled — {link.reason}</span>
          </Row>
        </Row>
      ))}
    </Stack>
  );
}

/**
 * The paste + URL form.
 *
 * The paste lives in component state only (`pasted`), is never seeded from the server, and
 * is cleared the moment the extraction succeeds — so the discarded raw text cannot come
 * back. A failed attempt keeps the operator's own text so §31.3's "never paste twice" holds
 * while the staged row is still inside its TTL.
 */
function EnrichWithAiForm({
  businessSlug,
  businessId,
  leadId,
  defaultLinkedinUrl,
}: {
  readonly businessSlug: string;
  readonly businessId: string;
  readonly leadId: string;
  readonly defaultLinkedinUrl: string;
}): React.ReactElement {
  const [state, formAction, pending] = React.useActionState<EnrichProfileActionResult, FormData>(
    enrichProfileAction,
    { ok: false, error: null },
  );
  const [pasted, setPasted] = React.useState('');
  const [linkedinUrl, setLinkedinUrl] = React.useState(defaultLinkedinUrl);

  const applied = state.applied ?? [];
  const review = state.review ?? [];

  React.useEffect(() => {
    // §32.2.6/§32.6: on success the temporary paste is gone from the database, so it must
    // be gone from the screen too. Nothing else in this component can re-populate it.
    if (state.ok) setPasted('');
  }, [state]);

  const notConfigured = state.errorCode === 'provider_not_configured';

  return (
    <form action={formAction}>
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="leadId" value={leadId} />
      <Stack size="sm">
        <Field
          label="LinkedIn profile URL"
          htmlFor={`enrich-url-${leadId}`}
          hint="Recorded as a contact point for this person. A URL is a location, not a fact set."
        >
          <TextInput
            id={`enrich-url-${leadId}`}
            name="linkedinUrl"
            type="url"
            value={linkedinUrl}
            onChange={setLinkedinUrl}
            placeholder="https://www.linkedin.com/in/…"
          />
        </Field>

        <Field
          label="Temporary raw paste"
          htmlFor={`enrich-paste-${leadId}`}
          hint="Temporary: this text is staged only until the structured commit is verified, then deleted. It is never shown again and never written to a canonical field."
        >
          <TextArea
            id={`enrich-paste-${leadId}`}
            name="pastedContent"
            tall
            mono
            rows={12}
            value={pasted}
            onChange={setPasted}
            placeholder="Paste the copied profile text here. It is deleted after extraction."
          />
        </Field>

        {notConfigured && (
          <Alert accent="amber" role="status" title="AI is not configured on this deployment">
            No provider key is set, so no extraction ran. This is a supported configuration, not a
            failure: the URL and manual edits still work, and the staged text stays only for its
            retention window.
          </Alert>
        )}

        {!notConfigured && state.error !== null && state.error !== undefined && (
          <Alert accent="red" role="alert" title="Enrichment was refused">
            <Stack size="sm">
              <span>{state.error}</span>
              {state.errorCode !== undefined && <Chip accent="red">{state.errorCode}</Chip>}
              {state.rawRetained === true && (
                <span className="nx-hint">
                  The staged text was kept for a retry inside its retention window; the paste box
                  still holds what you typed, because you do not have to paste it twice.
                </span>
              )}
            </Stack>
          </Alert>
        )}

        {state.ok && (
          <Alert accent="green" role="status" title="Enriched from the pasted profile">
            <Stack size="sm">
              <span>
                {applied.length === 0
                  ? 'No new facts were applied.'
                  : `Applied: ${applied.join(', ')}.`}
              </span>
              <span className="nx-hint">
                {state.rawDeleted === true
                  ? 'The temporary raw paste was deleted after the structured commit was verified.'
                  : 'The raw paste is still staged for a retry inside its retention window.'}
              </span>
              {review.length > 0 && (
                <span>
                  Needs review — a user-confirmed value conflicts with the extraction:{' '}
                  {review.join(', ')}.
                </span>
              )}
            </Stack>
          </Alert>
        )}

        <Row wrap>
          <Button type="submit" variant="primary" busy={pending} disabled={pasted.trim().length === 0}>
            Enrich with AI
          </Button>
          <span className="nx-hint">
            Runs profile extraction over the staged text, validates it, commits grounded facts and
            deletes the raw body. It never runs on page render.
          </span>
        </Row>
      </Stack>
    </form>
  );
}

/** §68.3 *Research Company* — creates or reuses the deduplicated job and says which. */
export function ResearchCompanyButton({
  businessSlug,
  businessId,
  leadId,
}: {
  readonly businessSlug: string;
  readonly businessId: string;
  readonly leadId: string;
}): React.ReactElement {
  const [state, formAction, pending] = React.useActionState<ResearchCompanyActionResult, FormData>(
    researchCompanyAction,
    IDLE_RESEARCH,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="leadId" value={leadId} />
      <Stack size="sm">
        <Row wrap>
          <Button type="submit" variant="secondary" busy={pending}>
            Research company
          </Button>
          {state.created.length > 0 && (
            <Chip accent="cyan">created {state.created.join(', ')}</Chip>
          )}
          {state.created.length === 0 && state.alreadyOpen.length > 0 && (
            <Chip accent="amber">already open: {state.alreadyOpen.join(', ')}</Chip>
          )}
        </Row>
        {state.error !== null && state.error !== undefined && (
          <Alert accent="red" role="alert">
            {state.error}
          </Alert>
        )}
        {state.message !== undefined && (
          <span className="nx-hint" role="status">
            {state.message}
          </span>
        )}
      </Stack>
    </form>
  );
}

/** §29.3 — the stored score is recomputed in one transaction with the fact change. */
export function RecomputeEnrichmentButton({
  businessSlug,
  businessId,
  leadId,
}: {
  readonly businessSlug: string;
  readonly businessId: string;
  readonly leadId: string;
}): React.ReactElement {
  const [state, formAction, pending] = React.useActionState<ActionResult, FormData>(
    recomputeEnrichmentAction,
    IDLE,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="leadId" value={leadId} />
      <Stack size="sm">
        <Row wrap>
          <Button type="submit" variant="ghost" size="sm" busy={pending}>
            Recompute intelligence
          </Button>
          <span className="nx-hint">
            Recounts the ten weighted components from stored facts. It never calls a model.
          </span>
        </Row>
        {state.error !== null && state.error !== undefined && (
          <Alert accent="red" role="alert">
            {state.error}
          </Alert>
        )}
        {state.ok && state.message !== undefined && (
          <span className="nx-hint" role="status">
            {state.message}
          </span>
        )}
      </Stack>
    </form>
  );
}

/** §68.3 *Create Agent Job* — an explicit job type, created by a person, with a reason. */
export function CreateAgentJobForm({
  businessSlug,
  businessId,
  leadId,
  jobTypes,
  defaultJobType,
  compact,
}: {
  readonly businessSlug: string;
  readonly businessId: string;
  readonly leadId: string;
  readonly jobTypes: readonly string[];
  readonly defaultJobType?: string;
  readonly compact?: boolean;
}): React.ReactElement {
  const [state, formAction, pending] = React.useActionState<ActionResult, FormData>(
    createAgentJobAction,
    IDLE,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="leadId" value={leadId} />
      <Stack size="sm">
        <Field label="Agent job type" htmlFor={`job-type-${leadId}`}>
          <Select
            id={`job-type-${leadId}`}
            name="jobType"
            defaultValue={defaultJobType ?? jobTypes[0] ?? 'OTHER'}
            options={jobTypes.map((type) => ({ value: type, label: type.replace(/_/g, ' ').toLowerCase() }))}
          />
        </Field>
        {compact !== true && (
          <Field
            label="Reason"
            htmlFor={`job-reason-${leadId}`}
            hint="Recorded on the job so a chained job and a hand-made one can be told apart."
          >
            <TextInput id={`job-reason-${leadId}`} name="reason" defaultValue="" placeholder="Why this job exists" />
          </Field>
        )}
        <Row wrap>
          <Button type="submit" variant="secondary" size={compact === true ? 'sm' : 'md'} busy={pending}>
            Create agent job
          </Button>
        </Row>
        {state.error !== null && state.error !== undefined && (
          <Alert accent="red" role="alert">
            {state.error}
          </Alert>
        )}
        {state.ok && state.message !== undefined && (
          <span className="nx-hint" role="status">
            {state.message}
          </span>
        )}
      </Stack>
    </form>
  );
}

/**
 * §69.4 *Refresh context* — builds a **new** Context Pack version through a
 * `BUILD_CONTEXT` agent job. It never mutates the previous version and never runs on render.
 */
export function RefreshContextButton({
  businessSlug,
  businessId,
  leadId,
}: {
  readonly businessSlug: string;
  readonly businessId: string;
  readonly leadId: string;
}): React.ReactElement {
  const [state, formAction, pending] = React.useActionState<ActionResult, FormData>(
    createAgentJobAction,
    IDLE,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="jobType" value="BUILD_CONTEXT" />
      <input type="hidden" name="reason" value="Context pack refresh requested from Lead Detail" />
      <Stack size="sm">
        <Button type="submit" variant="secondary" size="sm" busy={pending}>
          Refresh context
        </Button>
        {state.error !== null && state.error !== undefined && (
          <Alert accent="red" role="alert">
            {state.error}
          </Alert>
        )}
        {state.ok && state.message !== undefined && (
          <span className="nx-hint" role="status">
            {state.message}
          </span>
        )}
      </Stack>
    </form>
  );
}

/* -------------------------------------------------------------- workspace -- */

export interface EnrichmentWorkspaceProps {
  readonly businessSlug: string;
  readonly businessId: string;
  readonly leadId: string;
  readonly enrichmentState: string;
  readonly completenessScore: number;
  readonly missingFields: readonly string[];
  readonly knownFields: readonly { readonly label: string; readonly value: string }[];
  readonly searchLinks: readonly SearchLink[];
  readonly unavailableLinks: readonly UnavailableSearchLink[];
  readonly defaultLinkedinUrl: string;
  readonly steps: readonly ProcessingStep[];
  readonly canEnrich: boolean;
  readonly canCreateJobs: boolean;
  readonly jobTypes: readonly string[];
  readonly openJobs: readonly { readonly jobType: string; readonly status: string }[];
  readonly lastErrorCode: string | null;
}

/** The §67.2 processing-step indicator. Labelled states, never colour alone. */
export function ProcessingStepsIndicator({
  steps,
}: {
  readonly steps: readonly ProcessingStep[];
}): React.ReactElement {
  return (
    <ol className="nx-steps" aria-label="Enrichment processing steps">
      {steps.map((step) => (
        <li key={step.key} className="nx-steps__item" data-state={step.state}>
          <span className="nx-steps__marker" aria-hidden="true" />
          <span className="nx-steps__label">{step.label}</span>
          <span className="nx-steps__state">{step.state}</span>
          <span className="nx-hint nx-steps__detail">{step.detail}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * §69.1 item 4 / §31.1 — the enrichment workspace.
 *
 * It states what is known, what is missing, and the three deterministic ways forward
 * (a generated Google query, a URL, or a temporary paste), plus the durable agent path.
 */
export function LeadEnrichmentWorkspace({
  businessSlug,
  businessId,
  leadId,
  enrichmentState,
  completenessScore,
  missingFields,
  knownFields,
  searchLinks: links,
  unavailableLinks,
  defaultLinkedinUrl,
  steps,
  canEnrich,
  canCreateJobs,
  jobTypes,
  openJobs,
  lastErrorCode,
}: EnrichmentWorkspaceProps): React.ReactElement {
  const missingText = missingFields.length === 0 ? null : missingFields.join(', ');

  return (
    <Card
      title="Enrichment workspace"
      actions={
        <Row wrap>
          <Chip accent="cyan" dataState={enrichmentState}>
            {enrichmentStateLabel(enrichmentState)}
          </Chip>
          <span className="nx-hint">{intelligenceLabel(completenessScore)}</span>
          {lastErrorCode !== null && <Chip accent="red">{lastErrorCode}</Chip>}
        </Row>
      }
    >
      <Stack>
        <ProcessingStepsIndicator steps={steps} />

        {openJobs.length > 0 && (
          <Row wrap>
            <span className="nx-hint">Open agent work:</span>
            {openJobs.map((job) => (
              <Chip key={`${job.jobType}-${job.status}`} accent="amber">
                {job.jobType.replace(/_/g, ' ').toLowerCase()} · {job.status.replace(/_/g, ' ').toLowerCase()}
              </Chip>
            ))}
          </Row>
        )}

        <div className="nx-grid nx-grid--2">
          <div>
            <span className="nx-overline">Known fields</span>
            {knownFields.length === 0 ? (
              <p className="nx-hint">No structured facts are recorded for this lead yet.</p>
            ) : (
              <dl className="nx-facts">
                {knownFields.map((field) => (
                  <div key={field.label}>
                    <dt>{field.label}</dt>
                    <dd>{field.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {missingText !== null && (
              <p className="nx-hint">
                Still missing: {missingText}. Missing components are named rather than counted, so
                the next action is unambiguous.
              </p>
            )}
          </div>

          <div>
            <span className="nx-overline">Generated Google queries</span>
            <p className="nx-hint">
              Built in code from the stored facts. No model is asked to compose a query, and these
              links cost nothing.
            </p>
            <GeneratedSearchLinks links={links} />
            <UnavailableSearchLinks links={unavailableLinks} />
          </div>
        </div>

        {canEnrich ? (
          <EnrichWithAiForm
            businessSlug={businessSlug}
            businessId={businessId}
            leadId={leadId}
            defaultLinkedinUrl={defaultLinkedinUrl}
          />
        ) : (
          <p className="nx-hint">
            You do not have permission to change facts on this lead, so the extraction form is not
            offered. The generated queries above still work.
          </p>
        )}

        <Row wrap>
          {canCreateJobs && (
            <ResearchCompanyButton businessSlug={businessSlug} businessId={businessId} leadId={leadId} />
          )}
          {canEnrich && (
            <RecomputeEnrichmentButton businessSlug={businessSlug} businessId={businessId} leadId={leadId} />
          )}
        </Row>

        {canCreateJobs && (
          <details className="nx-workspace__more">
            <summary>Create a specific agent job</summary>
            <CreateAgentJobForm
              businessSlug={businessSlug}
              businessId={businessId}
              leadId={leadId}
              jobTypes={jobTypes}
            />
          </details>
        )}
      </Stack>
    </Card>
  );
}

/* --------------------------------------------------------- row actions (§68.3) -- */

export interface LeadRowIntelligenceActionsProps {
  readonly businessSlug: string;
  readonly businessId: string;
  readonly leadId: string;
  readonly personName: string;
  readonly facts: SearchLinkInputFacts;
  readonly canCreateJobs: boolean;
  readonly jobTypes: readonly string[];
}

/**
 * The V1.2 row actions: Open, Find LinkedIn, Enrich, Research Company, Create Agent Job,
 * Draft Outreach (§68.3).
 *
 * "Find LinkedIn" is a **link built by `searchLinks`**, never an AI call, and opens in a new
 * tab with `rel="noopener noreferrer"` (§30.3.7). The two jobs actions post the same server
 * actions the Lead Detail screen uses, so the permission checks are identical wherever the
 * action is offered.
 */
export function LeadRowIntelligenceActions({
  businessSlug,
  businessId,
  leadId,
  personName,
  facts,
  canCreateJobs,
  jobTypes,
}: LeadRowIntelligenceActionsProps): React.ReactElement {
  const links = searchLinks(facts);
  const findLinkedin = links.find((link) => link.key === 'find_linkedin') ?? null;
  const unavailable = missingSearchLinks(facts).find((entry) => entry.key === 'find_linkedin') ?? null;
  const label = `Leads V1.2 actions for ${personName}`;

  const [researchState, researchAction, researchPending] = React.useActionState<
    ResearchCompanyActionResult,
    FormData
  >(researchCompanyAction, IDLE_RESEARCH);
  const [jobState, jobAction, jobPending] = React.useActionState<ActionResult, FormData>(
    createAgentJobAction,
    IDLE,
  );

  return (
    <details className="nx-row-menu">
      <summary aria-label={label} title={label}>
        <span aria-hidden="true">⋯</span>
      </summary>
      <div className="nx-row-menu__panel">
        <ul className="nx-row-menu__list">
          <li>
            <a className="nx-row-menu__item" href={`/b/${businessSlug}/leads/${leadId}`}>
              Open
            </a>
          </li>
          <li>
            {findLinkedin === null ? (
              <button
                className="nx-row-menu__item"
                type="button"
                disabled
                title={unavailable?.reason ?? 'the person name is missing'}
              >
                Find LinkedIn — {unavailable?.reason ?? 'person name missing'}
              </button>
            ) : (
              <a
                className="nx-row-menu__item"
                href={findLinkedin.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Find LinkedIn
              </a>
            )}
          </li>
          <li>
            <a className="nx-row-menu__item" href={`/b/${businessSlug}/leads/${leadId}#enrichment`}>
              Enrich
            </a>
          </li>
          <li>
            <a className="nx-row-menu__item" href={`/b/${businessSlug}/leads/${leadId}#outreach`}>
              Draft outreach
            </a>
          </li>
        </ul>

        {canCreateJobs && (
          <>
            <form className="nx-row-menu__form" action={researchAction}>
              <input type="hidden" name="businessSlug" value={businessSlug} />
              <input type="hidden" name="businessId" value={businessId} />
              <input type="hidden" name="leadId" value={leadId} />
              <button className="nx-row-menu__item" type="submit" disabled={researchPending}>
                Research company
              </button>
            </form>

            <form className="nx-row-menu__form" action={jobAction}>
              <input type="hidden" name="businessSlug" value={businessSlug} />
              <input type="hidden" name="businessId" value={businessId} />
              <input type="hidden" name="leadId" value={leadId} />
              <label className="nx-row-menu__item" htmlFor={`row-job-${leadId}`}>
                Create agent job
              </label>
              <select
                id={`row-job-${leadId}`}
                className="nx-select nx-select--sm"
                name="jobType"
                defaultValue="RESEARCH_COMPANY"
              >
                {jobTypes.map((type) => (
                  <option key={type} value={type}>
                    {type.replace(/_/g, ' ').toLowerCase()}
                  </option>
                ))}
              </select>
              <button className="nx-row-menu__item" type="submit" disabled={jobPending}>
                Create job
              </button>
            </form>
          </>
        )}

        {researchPending && <p className="nx-row-menu__result">Creating or reusing the job…</p>}
        {!researchPending && researchState.error !== null && researchState.error !== undefined && (
          <p className="nx-row-menu__result nx-row-menu__result--error" role="alert">
            {researchState.error}
          </p>
        )}
        {!researchPending &&
          (researchState.error === null || researchState.error === undefined) &&
          researchState.message !== undefined && (
            <p className="nx-row-menu__result" role="status">
              {researchState.message}
            </p>
          )}

        {jobPending && <p className="nx-row-menu__result">Creating the job…</p>}
        {!jobPending && jobState.error !== null && jobState.error !== undefined && (
          <p className="nx-row-menu__result nx-row-menu__result--error" role="alert">
            {jobState.error}
          </p>
        )}
        {!jobPending &&
          (jobState.error === null || jobState.error === undefined) &&
          jobState.message !== undefined && (
            <p className="nx-row-menu__result" role="status">
              {jobState.message}
            </p>
          )}
      </div>
    </details>
  );
}

/* ------------------------------------------------------------- add lead (§2) -- */

export interface AddLeadFormProps {
  readonly businessSlug: string;
  readonly businessId: string;
  readonly sourceOptions: readonly { readonly value: string; readonly label: string }[];
  readonly defaultSource: string;
  readonly canCreate: boolean;
  /**
   * Rendered open. The page passes this when the URL asks for the form (`?add=1`), because an
   * anchor cannot open a `<details>` element and the header's "+ Lead" button has to land on a form
   * rather than on a closed summary.
   */
  readonly defaultOpen?: boolean;
}

/**
 * §2 / §8 — create a Lead from as little as a name.
 *
 * It posts to `createLeadAction`, which submits through the audited ingest pipeline
 * (`submitIngest`) rather than inserting rows: the pipeline is what normalises, dedupes,
 * preserves provenance and lets the `leads_seed_enrichment` trigger create the enrichment
 * row. There is no model call on this path.
 *
 * The success panel states the **stored** enrichment state and offers the deterministic
 * Find LinkedIn query, so the next step after "add" is obvious and nothing about the new
 * lead is guessed.
 */
export function AddLeadForm({
  businessSlug,
  businessId,
  sourceOptions,
  defaultSource,
  canCreate,
  defaultOpen,
}: AddLeadFormProps): React.ReactElement {
  const [state, formAction, pending] = React.useActionState<CreateLeadResult, FormData>(
    createLeadAction,
    { ok: false, error: null },
  );

  const created = state.created;

  return (
    <details className="nx-add-lead" id="add-lead" open={state.ok || defaultOpen === true}>
      <summary className="nx-add-lead__summary">Add lead</summary>
      <form action={formAction}>
        <input type="hidden" name="businessSlug" value={businessSlug} />
        <input type="hidden" name="businessId" value={businessId} />
        <Stack size="sm">
          <div className="nx-filter-grid nx-filter-grid--secondary">
            <Field label="Full name" htmlFor="add-lead-name" required>
              <TextInput id="add-lead-name" name="fullName" required placeholder="Sarah Miller" />
            </Field>
            <Field label="Company" htmlFor="add-lead-company">
              <TextInput id="add-lead-company" name="companyName" defaultValue="" placeholder="Acme Media" />
            </Field>
            <Field label="Location" htmlFor="add-lead-location">
              <TextInput id="add-lead-location" name="location" defaultValue="" placeholder="New York" />
            </Field>
            <Field label="Source" htmlFor="add-lead-source">
              <Select
                id="add-lead-source"
                name="source"
                defaultValue={defaultSource}
                options={sourceOptions.map((option) => ({ value: option.value, label: option.label }))}
              />
            </Field>
            <Field label="Source URL" htmlFor="add-lead-source-url" hint="Optional. The page this lead was found on.">
              <TextInput id="add-lead-source-url" name="sourceUrl" type="url" defaultValue="" placeholder="https://…" />
            </Field>
            <Field label="Job title" htmlFor="add-lead-title">
              <TextInput id="add-lead-title" name="jobTitle" defaultValue="" placeholder="Head of Content" />
            </Field>
            <Field label="Headline" htmlFor="add-lead-headline">
              <TextInput id="add-lead-headline" name="headline" defaultValue="" placeholder="Marketing leader" />
            </Field>
            <Field label="Snippet" htmlFor="add-lead-snippet" hint="Optional short quote from the source.">
              <TextInput id="add-lead-snippet" name="snippet" defaultValue="" placeholder="We are hiring a video editor…" />
            </Field>
          </div>

          <p className="nx-hint">
            A name is enough. The ingest pipeline normalises and dedupes, keeps the source as
            provenance, and the lead starts in the enrichment pipeline rather than pretending to be
            complete. Location, source and URL are optional but make the deterministic searches
            sharper.
          </p>

          {state.error !== null && state.error !== undefined && (
            <Alert accent="red" role="alert" title="The lead was not created">
              {state.error}
            </Alert>
          )}

          {state.ok && created !== undefined && (
            <Alert accent="green" role="status" title={`${created.personName} added`}>
              <Stack size="sm">
                <Row wrap>
                  <Chip accent="cyan" dataState={created.enrichmentState}>
                    enrichment {enrichmentStateLabel(created.enrichmentState)}
                  </Chip>
                  <span className="nx-hint">{intelligenceLabel(created.completenessScore)}</span>
                  {state.idempotent === true && <Chip accent="amber">already ingested — reused</Chip>}
                  <a className="nx-btn nx-btn--secondary nx-btn--sm" href={created.leadHref}>
                    Open lead
                  </a>
                </Row>
                <span className="nx-hint">
                  {created.missingFields.length === 0
                    ? 'No components are missing.'
                    : `Missing: ${created.missingFields.join(', ')}. The deterministic search below is the next step.`}
                </span>
                {created.findLinkedinUrl === null ? (
                  <span className="nx-hint">
                    No LinkedIn query can be built yet: {created.findLinkedinBlockedReason ?? 'the person name is missing'}.
                  </span>
                ) : (
                  <div className="nx-search-link">
                    <Row between wrap>
                      <span className="nx-label">Find LinkedIn profile</span>
                      <a
                        className="nx-btn nx-btn--secondary nx-btn--sm"
                        href={created.findLinkedinUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open Google Search
                      </a>
                    </Row>
                    <code className="nx-search-link__query">{created.findLinkedinQuery}</code>
                  </div>
                )}
              </Stack>
            </Alert>
          )}

          <Row wrap>
            <Button type="submit" variant="primary" busy={pending} disabled={!canCreate}>
              Add lead
            </Button>
            <span className="nx-hint">
              Submitted through the audited ingest pipeline. No AI call is made.
            </span>
          </Row>
        </Stack>
      </form>
    </details>
  );
}
