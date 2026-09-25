import type { ReactNode } from 'react';

import {
  Alert,
  Card,
  Chip,
  DataTable,
  EmptyState,
  Grid,
  LeadStatusChip,
  PageHead,
  Row,
  Stat,
  type Column,
} from '@nexus/ui';

import { loadViewerContext } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import { listTrashedLeads, type TrashedLead } from '@/lib/repo/user-sources';
import { RestoreLeadButton } from '@/components/trash-restore';

export const dynamic = 'force-dynamic';

/**
 * U21 â€” Trash.
 *
 * Contract: "Restore deleted leads; no permanent deletion for normal user."
 *
 * spec `roles_and_permissions.user.cannot`: "Permanently delete records", and
 * `security_and_reliability.rules`: "Soft delete by default". This screen therefore has
 * exactly one control per row â€” Restore â€” and no delete control of any kind. The admin
 * Trash screen (`/b/[slug]/trash`) is where a permanent delete lives, behind
 * `lead.permanent_delete`, which `ADMIN_ONLY_PERMISSIONS` keeps off every normal user.
 *
 * spec `import_batch.undo` note: undoing an import soft-deletes what that import created,
 * so those leads arrive here and are restorable in the same way.
 */
export default async function TrashPage(): Promise<ReactNode> {
  const context = await loadViewerContext();
  requireRouteAccess(context, { route: '/trash' });

  const canViewTrash = context.permissions.has('trash.view');
  const businessIds = context.businesses.map((business) => business.id);
  const leads =
    canViewTrash && businessIds.length > 0
      ? await listTrashedLeads(context.viewer.actor, businessIds, context.viewer.userId)
      : [];

  const restorable = leads.filter((lead) => lead.canRestore).length;
  const byBusiness = new Map<string, number>();
  for (const lead of leads) {
    byBusiness.set(lead.businessName, (byBusiness.get(lead.businessName) ?? 0) + 1);
  }

  const columns: readonly Column<TrashedLead>[] = [
    {
      key: 'person',
      header: 'Person',
      cell: (lead) => (
        <div className="nx-stack nx-stack--sm">
          <strong>{lead.personName}</strong>
          {lead.jobTitle !== null && <span className="nx-hint">{lead.jobTitle}</span>}
        </div>
      ),
    },
    { key: 'company', header: 'Company', cell: (lead) => lead.companyName ?? <span className="nx-hint">â€”</span> },
    { key: 'business', header: 'Business', cell: (lead) => lead.businessName },
    {
      key: 'status',
      header: 'Status when deleted',
      cell: (lead) => <LeadStatusChip state={lead.status} />,
    },
    {
      key: 'owner',
      header: 'Owner',
      cell: (lead) => lead.ownerName ?? <span className="nx-hint">unassigned</span>,
    },
    {
      key: 'deleted',
      header: 'Deleted',
      cell: (lead) => (
        <span className="nx-table__mono">
          {lead.deletedAt === null ? 'â€”' : lead.deletedAt.slice(0, 16).replace('T', ' ')}
        </span>
      ),
    },
    {
      key: 'restore',
      header: '',
      cell: (lead) =>
        lead.canRestore ? (
          <RestoreLeadButton leadId={lead.id} />
        ) : (
          <span className="nx-hint">not yours to restore</span>
        ),
    },
  ];

  return (
    <>
      <PageHead
        subtitle="Soft-deleted leads across the businesses you can see. Restoring puts the lead back exactly where it was, with its history intact."
        actions={
          <Row wrap>
            <a className="nx-btn nx-btn--secondary" href="/my-leads">
              My Leads
            </a>
            <a className="nx-btn nx-btn--secondary" href="/my-day">
              My Day
            </a>
          </Row>
        }
      >
        Trash
      </PageHead>

      {!canViewTrash && (
        <Alert accent="amber" title="Not available" role="alert">
          Your access does not include viewing Trash. Ask an administrator for the trash permission.
        </Alert>
      )}

      <Alert accent="indigo" title="Deletion here is reversible">
        A normal user can restore a deleted lead but cannot permanently delete one. Permanent deletion is an
        administrator action and is recorded in the audit log.
      </Alert>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Grid cols={4}>
        <Stat value={leads.length} label="Deleted leads" meta={canViewTrash ? 'across your businesses' : 'no access'} />
        <Stat value={restorable} label="You can restore" meta="owned or created by you" />
        <Stat value={byBusiness.size} label="Businesses affected" />
        <Stat
          value={leads.filter((lead) => lead.status === 'deleted').length}
          label="Marked deleted"
          meta="status at soft delete"
        />
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card title="Deleted leads" actions={<Chip accent="neutral">most recently deleted first</Chip>}>
        <DataTable
          columns={columns}
          rows={leads}
          rowKey={(lead) => lead.id}
          caption="Soft-deleted leads you can restore"
          empty={
            <EmptyState
              title="Trash is empty"
              body={
                canViewTrash
                  ? 'Nothing has been deleted in the businesses you can see. Leads you remove appear here and can be restored.'
                  : 'You do not have access to Trash.'
              }
            />
          }
        />
      </Card>

      <p className="nx-hint" style={{ marginTop: 'var(--nx-space-md)' }}>
        <Chip accent="cyan">note</Chip> A lead cannot be restored while the same person already has an active lead in
        that business â€” the database enforces one active lead per person per business, and will say so.
      </p>
    </>
  );
}
