import type { ReactNode } from 'react';

import {
  Alert,
  Card,
  Chip,
  DataTable,
  EmptyState,
  EnrichmentOffChip,
  Grid,
  PageHead,
  Row,
  Stack,
  Stat,
  type Column,
} from '@nexus/ui';

import { loadViewerContext } from '@/lib/viewer-context';
import type { ImportBatch } from '@/lib/repo/ingestion';
import { getUserSourceCounts, listRecentImports } from '@/lib/repo/user-sources';

export const dynamic = 'force-dynamic';

type RecentImport = ImportBatch & { readonly businessId: string };

interface ModeLink {
  readonly title: string;
  readonly body: string;
  readonly href: string;
  /** Apollo is discovery only; the other paths never touch enrichment at all. */
  readonly enrichmentOff: boolean;
}

/**
 * U11 — Lead Sources (user surface).
 *
 * Contract: "User-accessible File/Paste/Google/Apollo basic lead ingestion plus recent
 * imports/profile queue."
 *
 * This is the same four ingestion paths and the same `lib/repo/ingestion.ts` pipeline the
 * admin Lead Sources hub runs; what differs is only which businesses and identities the
 * operator can reach, which RLS decides. Nothing about ingestion is implemented twice.
 *
 * spec `lead_sources.required_context_each_ingestion`: "Business, Primary ICP OR
 * Auto-match" is enforced by the wizard and again by the server action before any write.
 */
export default async function MyLeadSourcesPage(): Promise<ReactNode> {
  const context = await loadViewerContext();
  const businessIds = context.businesses.map((business) => business.id);

  const canUseLeadSources = context.permissions.has('lead_source.use');
  const canUseProfileQueue = context.permissions.has('profile_queue.use');
  const canReviewDuplicates = context.permissions.has('duplicate.review');

  const [counts, recent] = await Promise.all([
    getUserSourceCounts(context.viewer.actor, businessIds),
    listRecentImports(context.viewer.actor, businessIds, 15),
  ]);

  const businessNames = new Map(context.businesses.map((business) => [business.id, business.name]));

  const modes: readonly ModeLink[] = [
    {
      title: 'File upload',
      body: 'CSV or XLSX. Minimum columns: name, company, job title. Optional: LinkedIn URL, location, source URL. You see the duplicate and profile counts before anything is written.',
      href: '/my-lead-sources/file',
      enrichmentOff: false,
    },
    {
      title: 'Paste list',
      body: 'Paste rows or a table you already have. Same required columns as a file, mapped name → company → job title → LinkedIn URL.',
      href: '/my-lead-sources/paste',
      enrichmentOff: false,
    },
    {
      title: 'Google Search',
      body: 'Paste candidate rows from a Google search result with its URL. Rows without a profile URL become partial leads marked Needs profile and go to the Profile Queue.',
      href: '/my-lead-sources/google',
      enrichmentOff: false,
    },
    {
      title: 'Apollo basic',
      body: 'People Search/basic discovery only: name, company, title and non-credit metadata. Email and phone enrichment, paid exports and any credit-spending action are disabled.',
      href: '/my-lead-sources/apollo',
      enrichmentOff: true,
    },
  ];

  const columns: readonly Column<RecentImport>[] = [
    {
      key: 'when',
      header: 'Imported',
      cell: (batch) => (
        <Stack size="sm">
          <span className="nx-table__mono">
            {batch.createdAt === null ? '—' : batch.createdAt.slice(0, 16).replace('T', ' ')}
          </span>
          <span className="nx-hint">{batch.createdByName ?? 'unknown operator'}</span>
        </Stack>
      ),
    },
    { key: 'source', header: 'Source', cell: (batch) => <Chip accent="indigo">{batch.source.replace(/_/g, ' ')}</Chip> },
    {
      key: 'business',
      header: 'Business',
      cell: (batch) => businessNames.get(batch.businessId) ?? '—',
    },
    {
      key: 'icp',
      header: 'Primary ICP',
      cell: (batch) =>
        batch.autoMatch ? (
          <Chip accent="cyan">{batch.requestedPrimaryIcp ?? 'Auto-match'}</Chip>
        ) : (
          <Chip accent="indigo">{batch.requestedPrimaryIcp ?? 'unknown ICP'}</Chip>
        ),
    },
    { key: 'rows', header: 'Rows', numeric: true, cell: (batch) => batch.rowCount },
    { key: 'created', header: 'Created', numeric: true, cell: (batch) => batch.createdCount },
    { key: 'updated', header: 'Updated', numeric: true, cell: (batch) => batch.updatedCount },
    {
      key: 'duplicates',
      header: 'Duplicates',
      numeric: true,
      cell: (batch) =>
        batch.duplicateCount > 0 ? (
          canReviewDuplicates ? (
            <a href="/my-duplicates">
              <Chip accent="amber">{batch.duplicateCount}</Chip>
            </a>
          ) : (
            <Chip accent="amber">{batch.duplicateCount}</Chip>
          )
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
          canUseProfileQueue ? (
            <a href="/my-profile-queue">
              <Chip accent="cyan">{batch.needsProfileCount}</Chip>
            </a>
          ) : (
            <Chip accent="cyan">{batch.needsProfileCount}</Chip>
          )
        ) : (
          batch.needsProfileCount
        ),
    },
    { key: 'failed', header: 'Failed', numeric: true, cell: (batch) => batch.failedCount },
    {
      key: 'status',
      header: 'State',
      cell: (batch) => (
        <Chip
          accent={batch.status === 'failed' ? 'red' : batch.status === 'completed' ? 'green' : 'neutral'}
          dataState={batch.status}
        >
          {batch.status}
        </Chip>
      ),
    },
  ];

  return (
    <>
      <PageHead
        subtitle="Import leads you are allowed to work. Every path below needs a Business plus a Primary ICP or Auto-match, and runs the same normalization and dedupe as the admin import."
        actions={
          <Row wrap>
            {canUseProfileQueue && (
              <a className="nx-btn nx-btn--secondary" href="/my-profile-queue">
                Profile Queue
              </a>
            )}
            {canReviewDuplicates && (
              <a className="nx-btn nx-btn--secondary" href="/my-duplicates">
                Duplicate Review
              </a>
            )}
            <a className="nx-btn nx-btn--secondary" href="/my-leads">
              My Leads
            </a>
          </Row>
        }
      >
        Lead Sources
      </PageHead>

      {!canUseLeadSources && (
        <Alert accent="amber" title="Read-only" role="alert">
          You can see this hub but not run an import: your access does not include using lead sources. Ask an
          administrator for the lead-source permission.
        </Alert>
      )}

      {context.businesses.length === 0 && (
        <Alert accent="amber" title="No business access">
          An administrator has not granted you access to a business yet, so there is nowhere to import into.
        </Alert>
      )}

      <Grid cols={4}>
        <Stat value={counts.batches} label="Import batches" meta="across your businesses" />
        <Stat value={counts.importsLast30Days} label="Imports (30 days)" />
        <Stat value={counts.profileQueueOpen} label="Profile queue open" meta="partial leads to complete" />
        <Stat value={counts.openDuplicates} label="Duplicates to review" meta="possible matches" />
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Grid cols={2}>
        {modes.map((mode) => (
          <Card
            key={mode.title}
            title={mode.title}
            actions={
              mode.enrichmentOff ? <EnrichmentOffChip /> : <Chip accent="indigo">lead_source.use</Chip>
            }
            footer={
              canUseLeadSources ? (
                <a className="nx-btn nx-btn--primary nx-btn--block" href={mode.href}>
                  Start {mode.title}
                </a>
              ) : (
                <span className="nx-hint">Your access does not include using lead sources.</span>
              )
            }
          >
            <Stack size="sm">
              <span className="nx-hint">{mode.body}</span>
              {mode.enrichmentOff && (
                <span className="nx-hint">
                  spec lead_sources.apollo: basic/zero-credit people search only by default. This screen never
                  triggers an enrichment call and never spends a credit.
                </span>
              )}
            </Stack>
          </Card>
        ))}
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card
        title="Recent imports"
        actions={
          <Row wrap>
            <Chip accent="neutral">newest first</Chip>
            <span className="nx-hint">{counts.needsProfile} lead(s) still need a profile</span>
          </Row>
        }
      >
        <DataTable
          columns={columns}
          rows={recent}
          rowKey={(batch) => batch.id}
          caption="Recent import batches across the businesses you can see"
          empty={
            <EmptyState
              title="No imports yet"
              body="Every path above records an import batch with created, updated, duplicate, needs-profile and failed counts, so you can see exactly what an import did."
            />
          }
        />
      </Card>

      <p className="nx-hint" style={{ marginTop: 'var(--nx-space-md)' }}>
        <Chip accent="cyan">note</Chip> A weak match never merges silently: it is sent to Duplicate Review, where you
        decide whether to merge into the existing record, keep the records separate, or skip.
      </p>
    </>
  );
}

