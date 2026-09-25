'use client';

import { useActionState, type ReactElement } from 'react';

import { Alert, Button, Card, Chip, Grid, Row, Stack } from '@nexus/ui';

import { resolveDuplicateAction } from '@/app/(app)/my-duplicates/actions';

/** Mirrored result shape: a client component may only import functions from `'use server'`. */
interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly message?: string;
}

const INITIAL: ActionResult = { ok: false, error: null };

export interface ReviewPerson {
  readonly id: string;
  readonly fullName: string;
  readonly headline: string | null;
  readonly jobTitle: string | null;
  readonly location: string | null;
  readonly linkedinUrl: string | null;
  readonly companyName: string | null;
  readonly isDeleted: boolean;
}

export interface ReviewLead {
  readonly id: string;
  readonly status: string;
  readonly primaryIcpName: string | null;
  readonly ownerName: string | null;
  readonly sentMessages: number;
  readonly replies: number;
  readonly createdAt: string | null;
}

/**
 * U17 — one duplicate decision.
 *
 * Contract: "Merge/keep/skip candidate vs existing canonical record."
 *
 * The three actions are presented with what each one does, and the merge warning is shown
 * whenever either side already has outreach history — spec
 * `lead_sources.duplicate_review` allows "keep separate only when truly different
 * person/entity", so history that a merge would move is exactly the information the
 * operator needs to make that call.
 *
 * Everything shown here came from the database and is rendered as text: names, headlines,
 * URLs and locations are untrusted input from imports and captures.
 */
export function DuplicateReviewPanel({
  candidateId,
  businessName,
  matchReason,
  confidence,
  incoming,
  existing,
  incomingLead,
  existingLead,
}: {
  readonly candidateId: string;
  readonly businessName: string;
  readonly matchReason: string | null;
  readonly confidence: number | null;
  readonly incoming: ReviewPerson | null;
  readonly existing: ReviewPerson | null;
  readonly incomingLead: ReviewLead | null;
  readonly existingLead: ReviewLead | null;
}): ReactElement {
  const [state, formAction, pending] = useActionState(resolveDuplicateAction, INITIAL);

  const hasHistory =
    (incomingLead !== null && (incomingLead.sentMessages > 0 || incomingLead.replies > 0)) ||
    (existingLead !== null && (existingLead.sentMessages > 0 || existingLead.replies > 0));

  function personBlock(person: ReviewPerson | null, lead: ReviewLead | null, label: string): ReactElement {
    return (
      <Card title={label} actions={lead === null ? <Chip accent="neutral">no lead here</Chip> : <Chip accent="indigo">{lead.status.replace(/_/g, ' ')}</Chip>}>
        {person === null ? (
          <span className="nx-hint">This side of the pair is missing, so a merge is not possible.</span>
        ) : (
          <Stack size="sm">
            <Row between>
              <span className="nx-hint">Name</span>
              <span>{person.fullName}</span>
            </Row>
            <Row between>
              <span className="nx-hint">Job title</span>
              <span>{person.jobTitle ?? '—'}</span>
            </Row>
            <Row between>
              <span className="nx-hint">Headline</span>
              <span>{person.headline ?? '—'}</span>
            </Row>
            <Row between>
              <span className="nx-hint">Company</span>
              <span>{person.companyName ?? '—'}</span>
            </Row>
            <Row between>
              <span className="nx-hint">Location</span>
              <span>{person.location ?? '—'}</span>
            </Row>
            <Row between>
              <span className="nx-hint">LinkedIn</span>
              {person.linkedinUrl === null ? (
                <span className="nx-hint">—</span>
              ) : (
                <a href={person.linkedinUrl} target="_blank" rel="noreferrer noopener">
                  {person.linkedinUrl}
                </a>
              )}
            </Row>
            <Row between>
              <span className="nx-hint">Primary ICP</span>
              <span>{lead?.primaryIcpName ?? '—'}</span>
            </Row>
            <Row between>
              <span className="nx-hint">Owner</span>
              <span>{lead?.ownerName ?? '—'}</span>
            </Row>
            <Row between>
              <span className="nx-hint">Messages sent / replies</span>
              <span>
                {String(lead?.sentMessages ?? 0)} / {String(lead?.replies ?? 0)}
              </span>
            </Row>
            {person.isDeleted && <Chip accent="amber">this person row is soft-deleted</Chip>}
          </Stack>
        )}
      </Card>
    );
  }

  return (
    <Card
      title="Candidate vs existing record"
      actions={
        <Row wrap>
          <Chip accent="indigo">{businessName}</Chip>
          <Chip accent="amber">{matchReason ?? 'name match'}</Chip>
          {confidence !== null && <Chip>{`confidence ${confidence.toFixed(2)}`}</Chip>}
        </Row>
      }
    >
      <Stack>
        <Grid cols={2}>
          {personBlock(incoming, incomingLead, 'Candidate (incoming)')}
          {personBlock(existing, existingLead, 'Existing canonical record')}
        </Grid>

        {hasHistory && (
          <Alert accent="amber" title="History is involved">
            At least one side already has outreach history. Merging moves that history onto the surviving record and
            soft-deletes the losing lead — keep them separate if these are genuinely different people.
          </Alert>
        )}

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
          <form action={formAction}>
            <input type="hidden" name="candidateId" value={candidateId} />
            <input type="hidden" name="resolution" value="merge" />
            <Button type="submit" variant="primary" busy={pending}>
              Merge into existing
            </Button>
          </form>

          <form action={formAction}>
            <input type="hidden" name="candidateId" value={candidateId} />
            <input type="hidden" name="resolution" value="keep_separate" />
            <Button type="submit" variant="secondary" busy={pending}>
              Keep separate
            </Button>
          </form>

          <form action={formAction}>
            <input type="hidden" name="candidateId" value={candidateId} />
            <input type="hidden" name="resolution" value="skip" />
            <Button type="submit" variant="ghost" busy={pending}>
              Skip
            </Button>
          </form>
        </Row>

        <span className="nx-hint">
          Merge: keep the existing person, move the candidate&rsquo;s leads, evidence, notes and signals across, and
          soft-delete the duplicate lead (restorable from Trash). Keep separate: only when these are truly different
          people. Skip: leave the candidate open for a later decision.
        </span>
      </Stack>
    </Card>
  );
}
