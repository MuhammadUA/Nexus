import type { ReactNode } from 'react';

import {
  Alert,
  Card,
  Chip,
  DataTable,
  EmptyState,
  Grid,
  PageHead,
  Row,
  Stack,
  Stat,
  Tabs,
  type Column,
} from '@nexus/ui';
import { notFound } from 'next/navigation';

import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import {
  getDuplicateCounts,
  listDuplicateCandidates,
  type DuplicateCandidate,
} from '@/lib/repo/duplicates';
import { DuplicateReview } from '@/components/duplicate-review';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly status?: string;
  readonly item?: string;
}

const STATUSES = ['open', 'merged', 'kept_separate', 'skipped'] as const;
type CandidateStatus = (typeof STATUSES)[number];

function parseStatus(value: string | undefined): CandidateStatus {
  return value !== undefined && (STATUSES as readonly string[]).includes(value)
    ? (value as CandidateStatus)
    : 'open';
}

/**
 * A07 — Duplicate Review.
 *
 * Contract: "Compare imported candidate with existing person/lead; merge, keep
 * separate, skip."
 *
 * The comparison is the point: an import can only tell that two records look
 * alike, not whether they are the same human being, so every candidate is shown
 * side by side with the dedupe key that produced the match and the confidence the
 * `@nexus/core` matcher assigned. The three resolutions then run through
 * `public.merge_duplicate_candidate`, which also has to fix up the lead so the
 * one-active-lead-per-person rule still holds afterwards.
 */
export default async function DuplicatesPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<SearchParams>;
}): Promise<ReactNode> {
  const [{ slug }, query] = await Promise.all([params, searchParams]);

  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);
  if (business === null) notFound();

  // Business-scoped configuration: judged against this business's grant alone.
  requireRouteAccess(context, { route: '/b/:businessSlug/duplicates', businessId: business.id });

  const status = parseStatus(query.status);
  const [candidates, counts] = await Promise.all([
    listDuplicateCandidates(context.viewer.actor, business.id, status, 100),
    getDuplicateCounts(context.viewer.actor, business.id),
  ]);

  const canReview = context.permissions.has('duplicate.review');

  const selected =
    query.item === undefined || query.item.length === 0
      ? (candidates[0] ?? null)
      : (candidates.find((candidate) => candidate.id === query.item) ?? null);

  const columns: readonly Column<DuplicateCandidate>[] = [
    {
      key: 'incoming',
      header: 'Incoming candidate',
      cell: (candidate) => (
        <Stack size="sm">
          <strong>{candidate.incoming?.fullName ?? 'missing record'}</strong>
          <span className="nx-hint">
            {candidate.incoming?.jobTitle ?? 'no job title'} · {candidate.incoming?.companyName ?? 'no company'}
          </span>
          <span className="nx-hint">
            {candidate.incoming?.normalizedLinkedinUrl ?? 'no LinkedIn URL'}
          </span>
        </Stack>
      ),
    },
    {
      key: 'existing',
      header: 'Existing person',
      cell: (candidate) => (
        <Stack size="sm">
          <strong>{candidate.existing?.fullName ?? 'missing record'}</strong>
          <span className="nx-hint">
            {candidate.existing?.jobTitle ?? 'no job title'} · {candidate.existing?.companyName ?? 'no company'}
          </span>
          <span className="nx-hint">
            {candidate.existing?.normalizedLinkedinUrl ?? 'no LinkedIn URL'}
          </span>
        </Stack>
      ),
    },
    {
      key: 'reason',
      header: 'Match reason',
      cell: (candidate) => (
        <Chip accent="amber" dataState={candidate.matchReason ?? 'none'}>
          {(candidate.matchReason ?? 'unknown').replace(/_/g, ' ')}
        </Chip>
      ),
    },
    {
      key: 'confidence',
      header: 'Confidence',
      numeric: true,
      cell: (candidate) =>
        candidate.confidence === null ? (
          <span className="nx-hint">—</span>
        ) : (
          <Chip
            accent={candidate.confidence >= 0.85 ? 'green' : candidate.confidence >= 0.6 ? 'amber' : 'red'}
          >
            {(candidate.confidence * 100).toFixed(0)}%
          </Chip>
        ),
    },
    {
      key: 'leads',
      header: 'Leads',
      cell: (candidate) => (
        <Stack size="sm">
          <span className="nx-hint">
            incoming: {candidate.incomingLead === null ? 'none in this business' : candidate.incomingLead.status}
          </span>
          <span className="nx-hint">
            existing: {candidate.existingLead === null ? 'none in this business' : candidate.existingLead.status}
          </span>
        </Stack>
      ),
    },
    {
      key: 'actions',
      header: 'Review',
      cell: (candidate) =>
        status === 'open' ? (
          <a
            className={
              selected?.id === candidate.id
                ? 'nx-btn nx-btn--primary nx-btn--sm'
                : 'nx-btn nx-btn--secondary nx-btn--sm'
            }
            href={`/b/${business.key}/duplicates?status=${status}&item=${candidate.id}`}
          >
            {selected?.id === candidate.id ? 'Selected' : 'Compare'}
          </a>
        ) : (
          <span className="nx-hint">
            {candidate.resolvedAt === null ? '—' : `${candidate.resolution ?? 'resolved'} ${candidate.resolvedAt.slice(0, 10)}`}
          </span>
        ),
    },
  ];

  return (
    <>
      <PageHead
        subtitle={`Imported candidates that look like an existing person in ${business.name}. Merge, keep separate, or skip — each decision is audited.`}
        actions={
          <Row wrap>
            <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/lead-sources`}>
              Lead sources
            </a>
            <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/profile-queue`}>
              Profile queue
            </a>
          </Row>
        }
      >
        Duplicate Review
      </PageHead>

      <Grid cols={4}>
        <Stat value={counts.open} label="Open" meta="awaiting a decision" />
        <Stat value={counts.merged} label="Merged" meta="incoming lead re-pointed" />
        <Stat value={counts.keptSeparate} label="Kept separate" meta="two different people" />
        <Stat value={counts.skipped} label="Skipped" meta="no decision recorded" />
      </Grid>

      <div style={{ height: 'var(--nx-space-md)' }} />

      <Stack size="lg">
        <Card
          title="Candidates"
          actions={
            <Tabs
              label="Duplicate candidate status"
              active={status}
              tabs={STATUSES.map((option) => ({
                key: option,
                label: option.replace(/_/g, ' '),
                // A tab is a link, not a click handler: the selection is part of the URL, so
                // the screen stays a Server Component and the state survives a refresh or a
                // share. `Tabs` is a Client Component and cannot take an `onChange` from here.
                href: `/b/${business.key}/duplicates?status=${option}`,
                count:
                  option === 'open'
                    ? counts.open
                    : option === 'merged'
                      ? counts.merged
                      : option === 'kept_separate'
                        ? counts.keptSeparate
                        : counts.skipped,
              }))}
            />
          }
          footer={
            <Row wrap>
              {STATUSES.map((option) => (
                <a
                  key={option}
                  className={
                    option === status ? 'nx-btn nx-btn--primary nx-btn--sm' : 'nx-btn nx-btn--secondary nx-btn--sm'
                  }
                  href={`/b/${business.key}/duplicates?status=${option}`}
                >
                  {option.replace(/_/g, ' ')}
                </a>
              ))}
            </Row>
          }
        >
          <DataTable
            columns={columns}
            rows={candidates}
            rowKey={(candidate) => candidate.id}
            caption="Duplicate candidates for this business"
            empty={
              <EmptyState
                title={status === 'open' ? 'No duplicates waiting' : `Nothing is ${status.replace(/_/g, ' ')}`}
                body="Imports raise a candidate when a row matches an existing person weakly — by name, or by name plus company. Exact LinkedIn URL or email matches merge automatically."
                action={
                  <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/lead-sources`}>
                    Import leads
                  </a>
                }
              />
            }
          />
        </Card>

        <Card
          title="Compare and resolve"
          actions={
            <Row wrap>
              {selected !== null && <Chip accent="indigo">{selected.id.slice(0, 8)}</Chip>}
              {!canReview && <Chip accent="amber">read-only</Chip>}
            </Row>
          }
        >
          {!canReview && (
            <Alert accent="amber" title="Read-only">
              You can see duplicate candidates but not resolve them. Ask an administrator for the duplicate-review
              permission.
            </Alert>
          )}

          {selected === null ? (
            <span className="nx-hint">
              {status === 'open'
                ? 'No candidate is selected. Choose Compare on a row above.'
                : 'This list shows already-resolved candidates. Switch to Open to review one.'}
            </span>
          ) : (
            <Stack size="md">
              {status !== 'open' && (
                <Alert accent="green" title="Already resolved">
                  {selected.resolution ?? 'resolved'}
                  {selected.resolvedByName === null ? '' : ` by ${selected.resolvedByName}`}
                  {selected.resolvedAt === null ? '' : ` on ${selected.resolvedAt.slice(0, 16).replace('T', ' ')}`}
                  . This panel is shown for the record; the buttons below are inert because the database refuses a
                  second resolution.
                </Alert>
              )}
              <DuplicateReview candidate={selected} businessSlug={business.key} />
            </Stack>
          )}
        </Card>
      </Stack>
    </>
  );
}
