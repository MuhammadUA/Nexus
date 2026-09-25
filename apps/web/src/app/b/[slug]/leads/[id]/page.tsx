import type { ReactNode } from 'react';

import {
  Alert,
  Card,
  Chip,
  DataTable,
  DncChip,
  LeadStatusChip,
  MessageStateChip,
  PageHead,
  Row,
} from '@nexus/ui';
import { REPLY_OUTCOMES, TASK_PRIORITIES, TASK_TYPES } from '@nexus/core';
import { notFound } from 'next/navigation';

import {
  NoteForm,
  ReplyForm,
  SnoozeForm,
  SoftDeleteAction,
  TaskForm,
} from '@/components/lead-forms';
import { LeadActionWorkspace } from '@/components/lead-action-workspace';
import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import {
  getLead,
  getLeadTimeline,
} from '@/lib/repo/leads';
import { dueMessageForLead } from '@/lib/repo/sequence';

export const dynamic = 'force-dynamic';

/**
 * A04 / U06 — Lead Detail.
 *
 * Contract: "Full lead control, owner vs sender identity, primary/secondary ICP,
 * source/provenance, sequence status, tasks, notes, replies, history, company
 * context, delete."
 *
 * The screen is one implementation for both surfaces; what differs is which
 * controls are rendered, decided by the viewer's permissions rather than by a
 * separate route.
 */
export default async function LeadDetailPage({
  params,
}: {
  readonly params: Promise<{ slug: string; id: string }>;
}): Promise<ReactNode> {
  const { slug, id } = await params;

  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);
  if (business === null) notFound();

  const lead = await getLead(context.viewer.actor, id);
  // A lead in another business is invisible through RLS, so it reads as missing.
  // Rendering "not found" rather than "forbidden" avoids confirming it exists.
  if (lead === null || lead.businessId !== business.id) notFound();

  const [timeline, dueMessage] = await Promise.all([
    getLeadTimeline(context.viewer.actor, id),
    dueMessageForLead(context.viewer.actor, id),
  ]);

  const canEdit = context.permissions.has('lead.update');
  const canCaptureReply = context.permissions.has('lead.capture_reply');
  const canDelete = context.permissions.has('lead.soft_delete');

  return (
    <>
      <PageHead
        subtitle={
          <Row wrap>
            {lead.jobTitle !== null && <span>{lead.jobTitle}</span>}
            <span>· {lead.companyName ?? 'No company'}</span>
          </Row>
        }
        actions={
          <Row wrap>
            <a className="nx-btn nx-btn--secondary" href={`/leads/${lead.id}/edit`}>Edit</a>
            {lead.linkedinUrl !== null && (
              <a
                className="nx-btn nx-btn--secondary"
                href={lead.linkedinUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open LinkedIn
              </a>
            )}
          </Row>
        }
      >
        {lead.personName}
      </PageHead>

      <div className="nx-lead-badges">
        <Chip accent="indigo">{business.name.split(' ')[0]?.toUpperCase()}</Chip>
        <Chip accent="cyan">{(lead.primaryIcpName ?? 'UNMATCHED').toUpperCase()}</Chip>
        <LeadStatusChip state={lead.status} />
        {lead.isDnc && <DncChip />}
      </div>

      {lead.isDnc && (
        <Alert accent="red" title="Do Not Contact" role="alert">
          This person is suppressed on every LinkedIn sender identity. Do not attempt outreach from another account.
        </Alert>
      )}

      <div className="nx-lead-control-grid">
        <Card title="Lead control">
          <div className="nx-detail-row"><span>Owner</span><strong>{lead.ownerName ?? 'Unassigned'}</strong></div>
          <div className="nx-detail-row"><span>LinkedIn sender</span><strong>{lead.identityName ?? 'Not bound'}</strong></div>
          <div className="nx-detail-row"><span>Primary ICP</span><strong>{lead.primaryIcpName ?? '—'}</strong></div>
          <div className="nx-detail-row"><span>Secondary matches</span><strong>{lead.icpMatches.filter((match) => !match.isPrimary).map((match) => match.icpName).join(', ') || '—'}</strong></div>
          <div className="nx-detail-row"><span>Source</span><strong>{lead.sourceType?.replace(/_/g, ' ') ?? '—'}</strong></div>
        </Card>
        <Card title="Sequence">
          <div className="nx-detail-row"><span>Status</span><Chip accent="amber">PAUSED · REPLY</Chip></div>
          <div className="nx-detail-row"><span>Message 1</span>{dueMessage === null ? <Chip>—</Chip> : <MessageStateChip state={dueMessage.state} />}</div>
          <div className="nx-detail-row"><span>Follow-up 1</span><Chip>CANCELLED</Chip></div>
          <div className="nx-detail-row"><span>Resume</span><strong>Keep paused</strong></div>
        </Card>
      </div>

      <Card title="Actions" className="nx-lead-actions-card">
        <LeadActionWorkspace
          {...(canEdit ? { snooze: <SnoozeForm leadId={lead.id} businessSlug={business.key} /> } : {})}
          note={<NoteForm leadId={lead.id} businessSlug={business.key} />}
          task={<TaskForm leadId={lead.id} businessSlug={business.key} taskTypes={TASK_TYPES} priorities={TASK_PRIORITIES} />}
          {...(canCaptureReply ? { reply: <ReplyForm leadId={lead.id} businessSlug={business.key} outcomes={REPLY_OUTCOMES} /> } : {})}
          {...(canDelete ? { trash: <SoftDeleteAction leadId={lead.id} businessSlug={business.key} /> } : {})}
        />
      </Card>

      <Card title="Conversation, replies & notes" className="nx-lead-history-table">
        <DataTable
          columns={[
            { key: 'date', header: 'Date', cell: (entry) => new Date(entry.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) },
            { key: 'event', header: 'Event', cell: (entry) => entry.kind === 'inbound' ? 'Inbound reply' : entry.kind === 'note' ? 'Internal note' : entry.summary ?? entry.kind },
            { key: 'by', header: 'By', cell: (entry) => entry.actorName ?? entry.identityName ?? 'System' },
            { key: 'content', header: 'Content / note', cell: (entry) => entry.body ?? entry.summary ?? '—' },
            { key: 'outcome', header: 'Outcome', cell: (entry) => entry.outcome === null ? '—' : <Chip accent="amber">{entry.outcome}</Chip> },
          ]}
          rows={timeline.slice(0, 3)}
          rowKey={(entry) => entry.id}
          caption="Conversation, replies and notes"
          empty={<span className="nx-hint">No history yet.</span>}
        />
      </Card>
    </>
  );
}
