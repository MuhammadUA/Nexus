import type { ReactNode } from 'react';

import {
  Alert,
  Card,
  Chip,
  DataTable,
  DncChip,
  DuplicateOutreachWarning,
  Grid,
  ImmutableNotice,
  LeadStatusChip,
  MessageBlock,
  MessageStateChip,
  PageHead,
  Row,
  Stack,
  Timeline,
  TimelineItem,
  type Column,
} from '@nexus/ui';
import { LEAD_STATES, REPLY_OUTCOMES, TASK_PRIORITIES, TASK_TYPES } from '@nexus/core';
import { notFound } from 'next/navigation';

import {
  MessageSentAction,
  ConnectionAction,
  CompleteTaskButton,
  LeadEditForm,
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
  listIcpOptions,
  listIdentityOptions,
  listOwnerOptions,
  type TimelineEntry,
} from '@/lib/repo/leads';
import { dueMessageForLead, openTasksForLead } from '@/lib/repo/sequence';

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

  const [timeline, icps, identities, owners, tasks, dueMessage] = await Promise.all([
    getLeadTimeline(context.viewer.actor, id),
    listIcpOptions(context.viewer.actor, business.id),
    listIdentityOptions(context.viewer.actor, business.id),
    listOwnerOptions(context.viewer.actor, business.id),
    openTasksForLead(context.viewer.actor, id),
    dueMessageForLead(context.viewer.actor, id),
  ]);

  const canEdit = context.permissions.has('lead.update');
  const canCaptureReply = context.permissions.has('lead.capture_reply');
  const canDelete = context.permissions.has('lead.soft_delete');
  const defaultIdentityId = lead.outreachIdentityId ?? identities[0]?.value ?? '';

  // The most recent recorded outcome, shown next to the history: it is the answer to "how did
  // this reply land?", which is otherwise only inferable by reading the timeline backwards.
  const latestOutcome =
    timeline.find((entry) => entry.outcome !== null && entry.outcome !== undefined)?.outcome ?? null;
  const outcomeChip =
    latestOutcome === null ? undefined : (
      <Chip accent={latestOutcome === 'Do not contact' || latestOutcome === 'Not interested' ? 'red' : 'green'}>
        {latestOutcome}
      </Chip>
    );

  const taskColumns: readonly Column<(typeof tasks)[number]>[] = [
    { key: 'title', header: 'Task', cell: (task) => task.title },
    { key: 'type', header: 'Type', cell: (task) => task.type.replace(/_/g, ' ') },
    { key: 'due', header: 'Due', cell: (task) => <span className="nx-table__mono">{task.dueAt?.slice(0, 16) ?? '—'}</span> },
    { key: 'priority', header: 'Priority', cell: (task) => <Chip>{task.priority}</Chip> },
    {
      key: 'actions',
      header: '',
      cell: (task) => (
        <CompleteTaskButton leadId={lead.id} taskId={task.id} businessSlug={business.key} />
      ),
    },
  ];

  return (
    <>
      <PageHead
        subtitle={
          <Row wrap>
            <span>{lead.companyName ?? 'No company'}</span>
            {lead.jobTitle !== null && <span>· {lead.jobTitle}</span>}
            {lead.location !== null && <span>· {lead.location}</span>}
          </Row>
        }
        actions={
          <Row wrap>
            <LeadStatusChip state={lead.status} />
            {lead.isDnc && <DncChip />}
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

      {lead.isDnc && (
        <Alert accent="red" title="Do Not Contact" role="alert">
          This person is suppressed on every LinkedIn sender identity. Do not attempt outreach from another account.
        </Alert>
      )}

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <LeadActionWorkspace
        {...(canEdit ? {
          edit: (
            <LeadEditForm
              leadId={lead.id}
              businessSlug={business.key}
              icps={icps}
              identities={identities}
              owners={owners}
              statuses={LEAD_STATES}
              current={{
                icpId: lead.primaryIcpId ?? '',
                ownerId: lead.ownerUserId ?? '',
                identityId: lead.outreachIdentityId ?? '',
                status: lead.status,
              }}
            />
          ),
          connection: (
            <ConnectionAction
              leadId={lead.id}
              businessSlug={business.key}
              identities={identities}
              defaultIdentityId={defaultIdentityId}
            />
          ),
          snooze: <SnoozeForm leadId={lead.id} businessSlug={business.key} />,
        } : {})}
        note={<NoteForm leadId={lead.id} businessSlug={business.key} />}
        task={<TaskForm leadId={lead.id} businessSlug={business.key} taskTypes={TASK_TYPES} priorities={TASK_PRIORITIES} />}
        {...(canCaptureReply ? {
          reply: <ReplyForm leadId={lead.id} businessSlug={business.key} outcomes={REPLY_OUTCOMES} />,
        } : {})}
        {...(canDelete ? {
          trash: (
            <Stack size="sm">
              <p className="nx-hint">This keeps the complete history and moves the lead to Trash.</p>
              <SoftDeleteAction leadId={lead.id} businessSlug={business.key} />
            </Stack>
          ),
        } : {})}
      />

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Grid split>
        <Stack size="lg">
          {/*
            spec `identity_model.duplicate_outreach_warning`: warn when this lead was
            already contacted from a different identity than the one selected.
          */}
          <DuplicateCheck lead={lead} identities={identities} />

          <Card
            title="Current action"
            actions={dueMessage === null ? <Chip accent="neutral">no step due</Chip> : <MessageStateChip state={dueMessage.state} />}
          >
            {dueMessage === null ? (
              <span className="nx-hint">
                Nothing is due on this lead right now. Its next action is{' '}
                {lead.nextActionAt === null ? 'not scheduled' : lead.nextActionAt.slice(0, 16)}.
              </span>
            ) : (
              <Stack>
                <Row wrap>
                  <Chip accent="cyan">
                    {dueMessage.stepOrder <= 1 ? 'Message 1' : `Follow-up ${String(dueMessage.stepOrder - 1)}`}
                  </Chip>
                  <MessageStateChip state={dueMessage.state} />
                  {dueMessage.dueAt !== null && (
                    <span className="nx-hint">due {dueMessage.dueAt.slice(0, 16)}</span>
                  )}
                </Row>

                <MessageBlock
                  direction="outbound"
                  immutable={dueMessage.state === 'SENT'}
                  meta={<span>{dueMessage.state === 'SENT' ? 'Sent (immutable)' : 'Draft — editable before sending'}</span>}
                >
                  {dueMessage.content ?? (dueMessage.state === 'SENT'
                    ? 'Sent content is unavailable in this record.'
                    : 'This message has not been generated yet.')}
                </MessageBlock>

                {dueMessage.state === 'SENT' ? (
                  <ImmutableNotice />
                ) : (
                  <MessageSentAction
                    leadId={lead.id}
                    businessSlug={business.key}
                    messageInstanceId={dueMessage.id}
                    defaultIdentityId={defaultIdentityId}
                  />
                )}
              </Stack>
            )}
          </Card>

          <Card
            title="History"
            actions={
              <Row wrap>
                <Chip accent="neutral">{timeline.length} events</Chip>
                {outcomeChip}
              </Row>
            }
          >
            <Timeline label="Lead history">
              {timeline.map((entry) => (
                <TimelineItem key={entry.id} dot={dotFor(entry)} meta={metaFor(entry)}>
                  {entry.body ?? entry.summary ?? ''}
                </TimelineItem>
              ))}
            </Timeline>
          </Card>
        </Stack>

        <Stack size="lg">
          <Card title="Lead details">
            <Stack size="sm">
              <Row between>
                <span className="nx-hint">Owner</span>
                <span>{lead.ownerName ?? 'Unassigned'}</span>
              </Row>
              <Row between>
                <span className="nx-hint">Sender identity</span>
                <span>{lead.identityName ?? 'Not bound'}</span>
              </Row>
              <Row between>
                <span className="nx-hint">Source</span>
                <span>{lead.sourceType?.replace(/_/g, ' ') ?? '—'}</span>
              </Row>
              <Row between>
                <span className="nx-hint">Added</span>
                <span>{lead.createdAt?.slice(0, 10) ?? '—'}</span>
              </Row>
              {lead.sourceUrl !== null && (
                <a className="nx-hint" href={lead.sourceUrl} target="_blank" rel="noreferrer noopener">
                  {lead.sourceUrl}
                </a>
              )}
            </Stack>
          </Card>

          <Card title="ICPs" actions={<Chip accent="indigo">one primary</Chip>}>
            <DataTable
              columns={[
                {
                  key: 'icp',
                  header: 'ICP',
                  cell: (match) => (
                    <Row>
                      <span>{match.icpName}</span>
                      {match.isPrimary && <Chip accent="indigo">primary</Chip>}
                    </Row>
                  ),
                },
                {
                  key: 'score',
                  header: 'Score',
                  numeric: true,
                  cell: (match) => (match.matchScore === null ? '—' : match.matchScore),
                },
              ]}
              rows={lead.icpMatches}
              rowKey={(match) => match.icpId}
              caption="ICP matches for this lead"
              empty={<span className="nx-hint">No ICP match recorded.</span>}
            />
            <p className="nx-hint" style={{ marginTop: 'var(--nx-space-sm)' }}>
              Secondary matches are allowed and never create a second lead.
            </p>
          </Card>

          <Card title="Sequence" actions={<LeadStatusChip state={lead.status} />}>
            <Stack size="sm">
              <Row between><span className="nx-hint">Current step</span><span>{dueMessage === null ? 'No step due' : dueMessage.stepOrder <= 1 ? 'Message 1' : `Follow-up ${String(dueMessage.stepOrder - 1)}`}</span></Row>
              <Row between><span className="nx-hint">Message state</span>{dueMessage === null ? <Chip>none</Chip> : <MessageStateChip state={dueMessage.state} />}</Row>
              <Row between><span className="nx-hint">Next action</span><span className="nx-table__mono">{lead.nextActionAt?.slice(0, 16) ?? '—'}</span></Row>
              <p className="nx-hint">Sent messages stay immutable. Replies pause the remaining sequence.</p>
            </Stack>
          </Card>

          <Card title="Tasks" actions={<Chip>{tasks.length} open</Chip>}>
            <DataTable
              columns={taskColumns}
              rows={tasks}
              rowKey={(task) => task.id}
              caption="Open tasks for this lead"
              empty={<span className="nx-hint">No open tasks.</span>}
            />
          </Card>
        </Stack>
      </Grid>
    </>
  );
}

function dotFor(entry: TimelineEntry): 'outbound' | 'inbound' | 'task' | 'system' | 'danger' {
  switch (entry.kind) {
    case 'outbound':
      return 'outbound';
    case 'inbound':
      return 'inbound';
    case 'task':
      return 'task';
    default:
      return 'system';
  }
}

function metaFor(entry: TimelineEntry): ReactNode {
  return (
    <Row wrap>
      <span>{entry.at.slice(0, 16).replace('T', ' ')}</span>
      <span>· {entry.kind}</span>
      {entry.identityName !== null && <span>· {entry.identityName}</span>}
      {entry.actorName !== null && <span>· {entry.actorName}</span>}
      {entry.outcome !== null && <Chip accent="cyan">{entry.outcome}</Chip>}
      {entry.immutable && <Chip accent="green">immutable</Chip>}
    </Row>
  );
}

/**
 * spec `identity_model.duplicate_outreach_warning`: "If a prospect has already been
 * contacted from another identity, opening the lead from a different identity must
 * show previous sender, timestamp, prior message/status, and a duplicate-outreach
 * warning."
 *
 * A lead has one conversation per channel but several sender identities may have
 * touched it, so the recorded sender is surfaced whenever the operator has a choice
 * of identity.
 */
function DuplicateCheck({
  lead,
  identities,
}: {
  readonly lead: {
    readonly identityName: string | null;
    readonly lastActivityAt: string | null;
    readonly status: string;
  };
  readonly identities: readonly { readonly value: string; readonly label: string }[];
}): ReactNode {
  if (lead.identityName === null || identities.length <= 1) return null;
  return (
    <DuplicateOutreachWarning
      senderName={lead.identityName}
      at={lead.lastActivityAt?.slice(0, 16) ?? 'unknown'}
      status={lead.status.replace(/_/g, ' ')}
    />
  );
}
