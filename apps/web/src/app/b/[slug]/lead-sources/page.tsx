import type { ReactNode } from 'react';

import {
  Alert,
  Card,
  Chip,
  DataTable,
  EnrichmentOffChip,
  Grid,
  PageHead,
  Row,
  Stack,
  Stat,
  type Column,
} from '@nexus/ui';
import { notFound } from 'next/navigation';

import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import {
  getIngestionCounts,
  listImportBatches,
  type ImportBatch,
  type ImportBatchSource,
} from '@/lib/repo/ingestion';
import { UndoImportLink } from '@/components/trash-actions';

export const dynamic = 'force-dynamic';

interface ModeLink {
  readonly title: string;
  readonly body: string;
  readonly href: string;
  readonly source: ImportBatchSource;
  /** Apollo is discovery only; the others never touch enrichment at all. */
  readonly enrichmentOff: boolean;
}

/**
 * A05 — Lead Sources.
 *
 * Contract: "File, Paste, Google Search, Apollo basic discovery, recent imports,
 * profile queue, duplicate review."
 *
 * spec `lead_sources.required_context_each_ingestion`: "Business, Primary ICP OR
 * Auto-match" — so the Business is already fixed by the URL, and every mode below
 * opens the Import Builder, which refuses to run without a Primary ICP or
 * Auto-match.
 *
 * spec `lead_sources.apollo.ui_must_label` — the Apollo entry carries the visible
 * "Enrichment OFF" label and spends no credits: discovery only, no email/phone
 * enrichment and no paid export.
 */
export default async function LeadSourcesPage({
  params,
}: {
  readonly params: Promise<{ slug: string }>;
}): Promise<ReactNode> {
  const { slug } = await params;

  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);
  if (business === null) notFound();

  // Business-scoped configuration: judged against this business's grant alone.
  requireRouteAccess(context, { route: '/b/:businessSlug/lead-sources', businessId: business.id });

  const canUseLeadSources = context.permissions.has('lead_source.use');
  const canUndoImport = context.permissions.has('import.undo');

  const [batches, counts] = await Promise.all([
    listImportBatches(context.viewer.actor, business.id, 20),
    getIngestionCounts(context.viewer.actor, business.id),
  ]);

  const base = `/b/${business.key}/lead-sources`;
  const modes: readonly ModeLink[] = [
    {
      title: 'File upload',
      body: 'CSV or XLSX. Minimum columns: name, company, job title. Optional: LinkedIn URL, location, source URL.',
      href: `${base}/import?mode=file_csv`,
      source: 'file_csv',
      enrichmentOff: false,
    },
    {
      title: 'Paste list',
      body: 'Paste rows straight from a spreadsheet or a copied search result. Same required columns as a file.',
      href: `${base}/import?mode=paste_list`,
      source: 'paste_list',
      enrichmentOff: false,
    },
    {
      title: 'Google Search',
      body: 'Bring in a Google results page with name, company, job title and the source result URL. Partial rows become Needs Profile leads.',
      href: `${base}/import?mode=google_search`,
      source: 'google_search',
      enrichmentOff: false,
    },
    {
      title: 'Apollo basic discovery',
      body: 'People Search results only: name, company, title and non-credit metadata. Email and phone enrichment stay off.',
      href: `${base}/import?mode=apollo_basic`,
      source: 'apollo_basic',
      enrichmentOff: true,
    },
  ];

  const batchColumns: readonly Column<ImportBatch>[] = [
    {
      key: 'when',
      header: 'Imported',
      cell: (batch) => (
        <Stack size="sm">
          <span className="nx-table__mono">{batch.createdAt?.slice(0, 16).replace('T', ' ') ?? '—'}</span>
          <span className="nx-hint">{batch.createdByName ?? 'unknown operator'}</span>
        </Stack>
      ),
    },
    {
      key: 'source',
      header: 'Source',
      cell: (batch) => <Chip accent="indigo">{batch.source.replace(/_/g, ' ')}</Chip>,
    },
    {
      key: 'business',
      header: 'Business',
      cell: (batch) => batch.businessName ?? business.name,
    },
    {
      key: 'icp',
      header: 'Requested Primary ICP',
      cell: (batch) =>
        batch.autoMatch ? (
          <Chip accent="cyan">{batch.requestedPrimaryIcp ?? 'Auto-match'}</Chip>
        ) : (
          <Chip accent="indigo">{batch.requestedPrimaryIcp ?? 'unknown ICP'}</Chip>
        ),
    },
    {
      key: 'counts',
      header: 'Created',
      numeric: true,
      cell: (batch) => batch.createdCount,
    },
    {
      key: 'updated',
      header: 'Updated',
      numeric: true,
      cell: (batch) => batch.updatedCount,
    },
    {
      key: 'duplicates',
      header: 'Duplicates',
      numeric: true,
      cell: (batch) =>
        batch.duplicateCount > 0 ? (
          <a href={`/b/${business.key}/duplicates`}>
            <Chip accent="amber">{batch.duplicateCount}</Chip>
          </a>
        ) : (
          batch.duplicateCount
        ),
    },
    {
      key: 'needs_profile',
      header: 'Needs profile',
      numeric: true,
      cell: (batch) =>
        batch.needsProfileCount > 0 ? (
          <a href={`/b/${business.key}/profile-queue`}>
            <Chip accent="cyan">{batch.needsProfileCount}</Chip>
          </a>
        ) : (
          batch.needsProfileCount
        ),
    },
    { key: 'failed', header: 'Failed', numeric: true, cell: (batch) => batch.failedCount },
    {
      key: 'status',
      header: 'State',
      cell: (batch) =>
        batch.undoneAt !== null ? (
          <Chip accent="amber" dataState="undone">
            undone
          </Chip>
        ) : (
          <Chip accent={batch.status === 'failed' ? 'red' : batch.status === 'completed' ? 'green' : 'neutral'} dataState={batch.status}>
            {batch.status}
          </Chip>
        ),
    },
    {
      key: 'undo',
      header: 'Undo',
      cell: (batch) => {
        if (batch.undoneAt !== null) {
          return (
            <span className="nx-hint">
              undone {batch.undoneAt.slice(0, 10)}
              {batch.undoneByName === null ? '' : ` by ${batch.undoneByName}`}
            </span>
          );
        }
        if (batch.status !== 'completed') return <span className="nx-hint">nothing to undo</span>;
        if (!canUndoImport) return <span className="nx-hint">no undo permission</span>;
        return <UndoImportLink batchId={batch.id} businessSlug={business.key} />;
      },
    },
  ];

  return (
    <>
      <PageHead
        subtitle={`Every ingestion path into ${business.name} requires Business + a Primary ICP or Auto-match, and runs normalization and dedupe before a lead is created.`}
        actions={
          <Row wrap>
            <a className="nx-btn nx-btn--primary" href={`${base}/import`}>
              Open Import Builder
            </a>
            <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/profile-queue`}>
              Profile Queue
            </a>
            <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/duplicates`}>
              Duplicate Review
            </a>
          </Row>
        }
      >
        Lead Sources
      </PageHead>

      {!canUseLeadSources && (
        <Alert accent="amber" title="Read-only">
          You can see this hub but not run an import. Ask an administrator for the lead-source permission.
        </Alert>
      )}

      <Grid cols={4}>
        <Stat value={counts.batches} label="Import batches" meta="all time" />
        <Stat value={counts.importsLast30Days} label="Imports (30 days)" />
        <Stat value={counts.profileQueueOpen} label="Profile queue open" meta="imported without a profile" />
        <Stat value={counts.openDuplicates} label="Duplicates to review" meta="possible matches" />
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Grid cols={2}>
        {modes.map((mode) => (
          <Card
            key={mode.title}
            title={mode.title}
            actions={
              mode.enrichmentOff ? (
                <EnrichmentOffChip />
              ) : (
                <Chip accent="indigo">{mode.source.replace(/_/g, ' ')}</Chip>
              )
            }
            footer={
              <a className="nx-btn nx-btn--primary nx-btn--block" href={mode.href}>
                Start {mode.title}
              </a>
            }
          >
            <Stack size="sm">
              <span className="nx-hint">{mode.body}</span>
              {mode.enrichmentOff && (
                <span className="nx-hint">
                  Apollo is used for basic people discovery only. Email and phone enrichment, exports and any
                  credit-spending action are disabled and this screen never triggers them.
                </span>
              )}
            </Stack>
          </Card>
        ))}
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Card
        title="Recent imports"
        actions={
          <Row wrap>
            <Chip accent="neutral">newest first</Chip>
            <a className="nx-btn nx-btn--ghost nx-btn--sm" href={`/b/${business.key}/trash`}>
              Undo from Trash
            </a>
          </Row>
        }
      >
        <DataTable
          columns={batchColumns}
          rows={batches}
          rowKey={(batch) => batch.id}
          caption="Recent import batches with per-row outcomes"
          empty={
            <span className="nx-hint">
              No imports yet. Every mode above records a batch with created, updated, duplicate, needs-profile and
              failed counts, and can be undone while it is recent.
            </span>
          }
        />
      </Card>
    </>
  );
}
