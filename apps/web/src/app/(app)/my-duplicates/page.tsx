import type { ReactNode } from 'react';

import { Alert, Card, Chip, EmptyState, Grid, PageHead, Row, Stack, Stat } from '@nexus/ui';

import { loadViewerContext } from '@/lib/viewer-context';
import { listDuplicatesForViewer } from '@/lib/repo/user-sources';
import { DuplicateReviewPanel } from '@/components/user-duplicate-review';

export const dynamic = 'force-dynamic';

/**
 * U17 — Duplicate Review.
 *
 * Contract: "Merge/keep/skip candidate vs existing canonical record."
 *
 * spec `lead_sources.duplicate_review` and `lead_invariants`: "Rediscovery creates a new
 * Signal/SourceEvidence, not a duplicate Person/Company." A weak match therefore opens a
 * candidate row instead of silently merging or silently forking — and this screen is where
 * a human decides.
 *
 * The decision itself runs in `public.merge_duplicate_candidate`, the same audited function
 * the admin Duplicate Review uses, so the merge semantics cannot differ between surfaces.
 */
export default async function MyDuplicatesPage(): Promise<ReactNode> {
  const context = await loadViewerContext();

  const canReview = context.permissions.has('duplicate.review');
  const rows = canReview ? await listDuplicatesForViewer(context.viewer.actor, context.businesses, 50) : [];

  const strong = rows.filter((row) => (row.candidate.confidence ?? 0) >= 0.8).length;
  const withHistory = rows.filter(
    (row) =>
      (row.candidate.incomingLead !== null &&
        (row.candidate.incomingLead.sentMessages > 0 || row.candidate.incomingLead.replies > 0)) ||
      (row.candidate.existingLead !== null &&
        (row.candidate.existingLead.sentMessages > 0 || row.candidate.existingLead.replies > 0)),
  ).length;

  return (
    <>
      <PageHead
        subtitle="Possible duplicates found during ingestion and profile capture. Each one is a decision, never an automatic merge."
        actions={
          <Row wrap>
            <a className="nx-btn nx-btn--secondary" href="/my-lead-sources">
              Lead Sources
            </a>
            <a className="nx-btn nx-btn--secondary" href="/my-profile-queue">
              Profile Queue
            </a>
            <a className="nx-btn nx-btn--secondary" href="/my-leads">
              My Leads
            </a>
          </Row>
        }
      >
        Duplicate Review
      </PageHead>

      {!canReview && (
        <Alert accent="amber" title="Not available" role="alert">
          Your access does not include duplicate review. Ask an administrator for the duplicate-review permission.
        </Alert>
      )}

      <Alert accent="indigo" title="One active lead per person, per business">
        A person may match several ICPs, but a business may hold only one active lead for that person. Merging keeps
        the existing record and moves the candidate&rsquo;s history onto it; the duplicate lead is soft-deleted and can
        be restored from Trash.
      </Alert>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Grid cols={4}>
        <Stat value={rows.length} label="Open candidates" meta="across your businesses" />
        <Stat value={strong} label="High confidence" meta="0.80 and above" />
        <Stat value={withHistory} label="With outreach history" meta="merge moves it" />
        <Stat
          value={rows.length - withHistory}
          label="No history yet"
          meta="cheapest to merge"
        />
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing to review"
            body={
              canReview
                ? 'No open duplicate candidates. A weak match during an import or a profile capture appears here instead of being merged automatically.'
                : 'You do not have access to duplicate review.'
            }
          />
        </Card>
      ) : (
        <Stack size="lg">
          {rows.map((row) => (
            <DuplicateReviewPanel
              key={row.candidate.id}
              candidateId={row.candidate.id}
              businessName={row.businessName}
              matchReason={row.candidate.matchReason}
              confidence={row.candidate.confidence}
              incoming={row.candidate.incoming}
              existing={row.candidate.existing}
              incomingLead={row.candidate.incomingLead}
              existingLead={row.candidate.existingLead}
            />
          ))}

          <Row wrap>
            <Chip accent="cyan">next</Chip>
            <span className="nx-hint">
              Resolving the last candidate clears this queue. Re-run the import that raised it if you kept the records
              separate and still want the new row.
            </span>
          </Row>
        </Stack>
      )}
    </>
  );
}
