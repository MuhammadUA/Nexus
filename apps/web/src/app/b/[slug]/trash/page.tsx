import type { ReactNode } from 'react';

import { Alert, Card, Chip, DataTable, EmptyState, Grid, PageHead, Row, Stack, Stat, type Column } from '@nexus/ui';
import { notFound } from 'next/navigation';

import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import { listLeads, type LeadListItem } from '@/lib/repo/leads';
import { listImportBatches, type ImportBatch } from '@/lib/repo/ingestion';
import {
  PermanentDeleteAction,
  RestoreFromTrashAction,
  UndoImportAction,
} from '@/components/trash-actions';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

/**
 * A08 — Trash.
 *
 * Contract: "Restore soft-deleted leads/import artifacts; permanent delete
 * remains auditable/admin-only."
 *
 * Two artifact kinds are recoverable here and they recover differently:
 *   - a soft-deleted **lead** is restored with `public.restore_lead`, which
 *     re-checks invariant 1 before re-activating it;
 *   - a recent **import batch** is reverted with `public.undo_import`, which
 *     returns how many leads it reverted and how many it deliberately kept
 *     because they have history the import did not create.
 *
 * Permanent deletion is offered only to a viewer holding
 * `lead.permanent_delete`, and the control itself demands the literal string
 * `DELETE PERMANENTLY`. The database demands it again.
 */
export default async function TrashPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<{ page?: string }>;
}): Promise<ReactNode> {
  const [{ slug }, query] = await Promise.all([params, searchParams]);

  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);
  if (business === null) notFound();

  const page = Math.max(Number(query.page ?? '1') || 1, 1);

  // Soft-deleted rows are only visible through `includeDeleted`, which the
  // database gates on the trash permission — the screen does not widen scope.
  const visible = await listLeads(
    context.viewer.actor,
    { businessId: business.id, includeDeleted: true, sort: 'recent_activity' },
    { limit: 200, offset: 0 },
  );
  const deleted = visible.items.filter((lead) => lead.deletedAt !== null);

  const batches = await listImportBatches(context.viewer.actor, business.id, 20);
  const undoable = batches.filter((batch) => batch.status === 'completed' && batch.undoneAt === null);

  const canRestore = context.permissions.has('lead.restore');
  const canDeletePermanently = context.permissions.has('lead.permanent_delete');
  const canUndoImport = context.permissions.has('import.undo');

  const start = (page - 1) * PAGE_SIZE;
  const pageRows = deleted.slice(start, start + PAGE_SIZE);
  const totalPages = Math.max(Math.ceil(deleted.length / PAGE_SIZE), 1);

  const columns: readonly Column<LeadListItem>[] = [
    {
      key: 'person',
      header: 'Person',
      cell: (lead) => (
        <Stack size="sm">
          <a className="nx-nav__item" style={{ padding: 0 }} href={`/b/${business.key}/leads/${lead.id}`}>
            <strong>{lead.personName}</strong>
          </a>
          {lead.jobTitle !== null && <span className="nx-hint">{lead.jobTitle}</span>}
        </Stack>
      ),
    },
    { key: 'company', header: 'Company', cell: (lead) => lead.companyName ?? <span className="nx-hint">—</span> },
    {
      key: 'source',
      header: 'Source',
      cell: (lead) => <Chip accent="indigo">{lead.sourceType?.replace(/_/g, ' ') ?? 'unknown'}</Chip>,
    },
    {
      key: 'deleted',
      header: 'Soft-deleted',
      cell: (lead) => (
        <Row>
          <Chip accent="red" dataState="deleted">
            deleted
          </Chip>
          <span className="nx-table__mono">{lead.deletedAt?.slice(0, 16).replace('T', ' ') ?? '—'}</span>
        </Row>
      ),
    },
    {
      key: 'actions',
      header: 'Recover',
      cell: (lead) => (
        <Stack size="sm">
          {canRestore ? (
            <RestoreFromTrashAction leadId={lead.id} businessSlug={business.key} />
          ) : (
            <span className="nx-hint">No restore permission</span>
          )}
          {canDeletePermanently && (
            <PermanentDeleteAction leadId={lead.id} businessSlug={business.key} personName={lead.personName} />
          )}
        </Stack>
      ),
    },
  ];

  const batchColumns: readonly Column<ImportBatch>[] = [
    {
      key: 'created',
      header: 'Imported',
      cell: (batch) => (
        <span className="nx-table__mono">{batch.createdAt?.slice(0, 16).replace('T', ' ') ?? '—'}</span>
      ),
    },
    { key: 'source', header: 'Source', cell: (batch) => <Chip accent="indigo">{batch.source.replace(/_/g, ' ')}</Chip> },
    {
      key: 'icp',
      header: 'Requested ICP',
      cell: (batch) => batch.requestedPrimaryIcp ?? <span className="nx-hint">—</span>,
    },
    {
      key: 'counts',
      header: 'Created / updated / duplicates / needs profile / failed',
      cell: (batch) => (
        <span className="nx-table__mono">
          {batch.createdCount} / {batch.updatedCount} / {batch.duplicateCount} / {batch.needsProfileCount} /{' '}
          {batch.failedCount}
        </span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      cell: (batch) =>
        batch.undoneAt !== null ? (
          <Chip accent="amber" dataState="undone">
            undone
          </Chip>
        ) : batch.status === 'failed' ? (
          <Chip accent="red" dataState="failed">
            failed
          </Chip>
        ) : (
          <Chip accent="green" dataState={batch.status}>
            {batch.status}
          </Chip>
        ),
    },
    {
      key: 'actions',
      header: 'Undo',
      cell: (batch) =>
        batch.undoneAt !== null ? (
          <span className="nx-hint">already undone</span>
        ) : canUndoImport ? (
          <UndoImportAction batchId={batch.id} businessSlug={business.key} />
        ) : (
          <span className="nx-hint">No undo permission</span>
        ),
    },
  ];

  return (
    <>
      <PageHead
        subtitle={`Soft-deleted leads and recent imports in ${business.name}. Nothing here is gone until it is permanently deleted.`}
        actions={
          <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/leads`}>
            Back to leads
          </a>
        }
      >
        Trash
      </PageHead>

      <Grid cols={4}>
        <Stat value={deleted.length} label="Soft-deleted leads" meta="restorable" />
        <Stat value={batches.length} label="Recent imports" meta={`${String(undoable.length)} undoable`} />
        <Stat
          value={batches.filter((batch) => batch.undoneAt !== null).length}
          label="Imports undone"
          meta="reverted or kept"
        />
        <Stat
          value={canDeletePermanently ? 'admin' : '—'}
          label="Permanent delete"
          meta={canDeletePermanently ? 'audited, confirmation required' : 'admin only'}
        />
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Stack size="lg">
        <Card
          title="Soft-deleted leads"
          actions={<Chip accent="red">{deleted.length}</Chip>}
        >
          {!canRestore && (
            <Alert accent="amber" title="Read-only">
              You can see Trash but not restore from it. Ask an administrator for the restore permission.
            </Alert>
          )}
          <DataTable
            columns={columns}
            rows={pageRows}
            rowKey={(lead) => lead.id}
            caption="Soft-deleted leads in this business"
            empty={
              <EmptyState
                title="Trash is empty"
                body="Soft-deleted leads appear here and can be restored. Deleting a lead never removes its history."
              />
            }
          />
          {totalPages > 1 && (
            <div className="nx-card__footer">
              <span className="nx-hint">
                Page {page} of {totalPages}
              </span>
              {page > 1 && (
                <a
                  className="nx-btn nx-btn--secondary nx-btn--sm"
                  href={`/b/${business.key}/trash?page=${String(page - 1)}`}
                >
                  Previous
                </a>
              )}
              {page < totalPages && (
                <a
                  className="nx-btn nx-btn--secondary nx-btn--sm"
                  href={`/b/${business.key}/trash?page=${String(page + 1)}`}
                >
                  Next
                </a>
              )}
            </div>
          )}
        </Card>

        <Card
          title="Recent imports"
          actions={<Chip accent="indigo">{batches.length}</Chip>}
        >
          <p className="nx-hint">
            Undoing an import reverts only the records that import created. Any lead with a sent message or a reply
            recorded since is kept, and the batch reports both counts.
          </p>
          <DataTable
            columns={batchColumns}
            rows={batches}
            rowKey={(batch) => batch.id}
            caption="Recent import batches for this business"
            empty={<span className="nx-hint">No imports recorded for this business yet.</span>}
          />
        </Card>
      </Stack>
    </>
  );
}
