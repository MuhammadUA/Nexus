'use client';

/**
 * Duplicate Review panel (A07).
 *
 * spec `lead_sources.duplicate_review` is three resolutions and one warning:
 * merge into the existing record, "keep separate only when truly different
 * person/entity", or skip. The side-by-side comparison is what makes that
 * judgement possible, so the incoming and existing person are shown field by
 * field — including the dedupe key that produced the match — rather than as two
 * names the operator is asked to trust.
 *
 * All three buttons post to the same action; the resolution is the only
 * difference, and the database function rejects anything outside the vocabulary.
 */
import { useActionState, type ReactElement } from 'react';

import { Alert, Chip, Grid, Row, Stack } from '@nexus/ui';

import { resolveDuplicateAction, type ActionResult } from '@/app/b/[slug]/duplicates/actions';
import type { DuplicateCandidate, DuplicateLeadSummary, DuplicatePerson } from '@/lib/repo/duplicates';

const INITIAL: ActionResult = { ok: false, error: null };

const REASON_LABELS: Readonly<Record<string, string>> = {
  linkedin_url: 'LinkedIn URL (strongest key)',
  email: 'Email address',
  company_domain: 'Name + company domain',
  name_company_title: 'Name + company + job title',
  manual: 'Flagged manually',
};

function confidenceTone(confidence: number | null): 'green' | 'amber' | 'red' | 'neutral' {
  if (confidence === null) return 'neutral';
  if (confidence >= 0.85) return 'green';
  if (confidence >= 0.6) return 'amber';
  return 'red';
}

export function DuplicateReview({
  candidate,
  businessSlug,
}: {
  readonly candidate: DuplicateCandidate;
  readonly businessSlug: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(resolveDuplicateAction, INITIAL);

  const canMerge = candidate.incoming !== null && candidate.existing !== null;

  return (
    <Stack size="md">
      <Row between wrap>
        <Row wrap>
          <Chip accent="indigo">candidate {candidate.id.slice(0, 8)}</Chip>
          <Chip accent={confidenceTone(candidate.confidence)} dataState="confidence">
            {candidate.confidence === null
              ? 'no confidence recorded'
              : `${(candidate.confidence * 100).toFixed(0)}% confidence`}
          </Chip>
          <Chip accent="amber">
            {candidate.matchReason === null
              ? 'no match reason'
              : (REASON_LABELS[candidate.matchReason] ?? candidate.matchReason)}
          </Chip>
          {candidate.createdAt !== null && (
            <span className="nx-hint">found {candidate.createdAt.slice(0, 16).replace('T', ' ')}</span>
          )}
        </Row>
        {candidate.importBatchId !== null && <Chip accent="cyan">from an import</Chip>}
      </Row>

      <Grid cols={2}>
        <PersonPanel
          title="Incoming (from the import)"
          tone="cyan"
          person={candidate.incoming}
          lead={candidate.incomingLead}
          businessSlug={businessSlug}
          note="Created by the import that raised this candidate."
        />
        <PersonPanel
          title="Existing (already in the CRM)"
          tone="indigo"
          person={candidate.existing}
          lead={candidate.existingLead}
          businessSlug={businessSlug}
          note="Pre-existing record. Merging keeps this person and this lead."
        />
      </Grid>

      <Alert accent="amber" title="Comparing the dedupe key">
        <Stack size="sm">
          <span>
            LinkedIn: {candidate.incoming?.normalizedLinkedinUrl ?? 'none'} ·{' '}
            {candidate.existing?.normalizedLinkedinUrl ?? 'none'}
          </span>
          <span>
            Company: {candidate.incoming?.companyName ?? 'none'}
            {candidate.incoming?.companyDomain === null || candidate.incoming?.companyDomain === undefined
              ? ''
              : ` (${candidate.incoming.companyDomain})`}{' '}
            · {candidate.existing?.companyName ?? 'none'}
            {candidate.existing?.companyDomain === null || candidate.existing?.companyDomain === undefined
              ? ''
              : ` (${candidate.existing.companyDomain})`}
          </span>
        </Stack>
      </Alert>

      <form action={formAction}>
        <input type="hidden" name="businessSlug" value={businessSlug} />
        <input type="hidden" name="candidateId" value={candidate.id} />

        <Stack size="sm">
          {state.error !== null && (
            <Alert accent="red" role="alert">
              {state.error}
            </Alert>
          )}
          {state.error === null && state.message !== undefined && (
            <Alert accent="green" role="status">
              {state.message}
            </Alert>
          )}

          <Row wrap>
            {/*
              Real submit buttons carry `name`/`value`, so the clicked resolution is
              part of the form data — React serialises the submitter for form
              actions. `@nexus/ui`'s Button does not forward those attributes, which
              is why these use the design-system classes directly.
            */}
            <button
              type="submit"
              name="resolution"
              value="merge"
              className="nx-btn nx-btn--primary"
              disabled={pending || !canMerge}
              title={
                canMerge
                  ? 'Keep the existing person and lead; re-point or soft-delete the incoming one'
                  : 'Merge needs both an incoming and an existing person'
              }
            >
              Merge into existing
            </button>
            <button
              type="submit"
              name="resolution"
              value="keep_separate"
              className="nx-btn nx-btn--secondary"
              disabled={pending}
              title="Only when these really are two different people"
            >
              Keep separate
            </button>
            <button
              type="submit"
              name="resolution"
              value="skip"
              className="nx-btn nx-btn--ghost"
              disabled={pending}
            >
              Skip
            </button>
          </Row>

          <span className="nx-hint">
            <strong>Keep separate</strong> is only correct when these are genuinely two different people — different
            employers, different profiles, no shared stronger key. If the LinkedIn URL or the person matches, merging is
            what the spec requires; leaving a real duplicate in place breaks the one-active-lead rule the two records
            would violate the moment both went live.
          </span>
        </Stack>
      </form>
    </Stack>
  );
}

function PersonPanel({
  title,
  tone,
  person,
  lead,
  businessSlug,
  note,
}: {
  readonly title: string;
  readonly tone: 'cyan' | 'indigo';
  readonly person: DuplicatePerson | null;
  readonly lead: DuplicateLeadSummary | null;
  readonly businessSlug: string;
  readonly note: string;
}): ReactElement {
  if (person === null) {
    return (
      <Stack size="sm">
        <Chip accent={tone}>{title}</Chip>
        <Alert accent="red" title="Person missing">
          This side of the candidate no longer exists — it may have been merged or deleted since the review was raised.
        </Alert>
      </Stack>
    );
  }

  return (
    <Stack size="sm">
      <Chip accent={tone}>{title}</Chip>
      <Stack size="sm">
        <strong>{person.fullName}</strong>
        <span className="nx-hint">{person.headline ?? 'no headline'}</span>
        <span className="nx-hint">{person.jobTitle ?? 'no job title'}</span>
        <span className="nx-hint">{person.location ?? 'no location'}</span>
        <span className="nx-hint">
          {person.companyName ?? 'no company'}
          {person.companyDomain === null ? '' : ` · ${person.companyDomain}`}
        </span>
        {person.linkedinUrl === null ? (
          <Chip accent="amber">no LinkedIn URL — a weak key</Chip>
        ) : (
          <a className="nx-hint" href={person.linkedinUrl} target="_blank" rel="noreferrer noopener">
            {person.linkedinUrl}
          </a>
        )}
        {person.isDeleted && (
          <Chip accent="red" dataState="deleted">
            merged away / soft-deleted
          </Chip>
        )}
        <span className="nx-hint">{note}</span>
      </Stack>

      <Stack size="sm">
        <span className="nx-hint">Lead in this business</span>
        {lead === null ? (
          <Chip accent="amber">no lead in this business</Chip>
        ) : (
          <>
            <Row wrap>
              <Chip accent={lead.deletedAt === null ? 'green' : 'red'} dataState={lead.deletedAt === null ? 'active' : 'deleted'}>
                {lead.deletedAt === null ? lead.status.replace(/_/g, ' ') : 'deleted'}
              </Chip>
              <Chip>{lead.primaryIcpName ?? 'no ICP'}</Chip>
            </Row>
            <span className="nx-hint">
              owner {lead.ownerName ?? 'unassigned'} · source {(lead.sourceType ?? 'unknown').replace(/_/g, ' ')} · added{' '}
              {lead.createdAt?.slice(0, 10) ?? '—'}
            </span>
            <span className="nx-hint">
              {String(lead.sentMessages)} sent message{lead.sentMessages === 1 ? '' : 's'} · {String(lead.replies)}{' '}
              recorded repl{lead.replies === 1 ? 'y' : 'ies'}
            </span>
            <a className="nx-btn nx-btn--ghost nx-btn--sm" href={`/b/${businessSlug}/leads/${lead.id}`}>
              Open this lead
            </a>
          </>
        )}
      </Stack>
    </Stack>
  );
}
