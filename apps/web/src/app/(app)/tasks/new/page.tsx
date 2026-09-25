import type { ReactNode } from 'react';

import { Alert, Card, Chip, EmptyState, Grid, PageHead, Row, Stack, Stat } from '@nexus/ui';
import { TASK_PRIORITIES, TASK_TYPES } from '@nexus/core';

import { loadViewerContext } from '@/lib/viewer-context';
import { getBoundLead } from '@/lib/repo/user-sources';
import { openTasksForLead } from '@/lib/repo/sequence';
import { TaskForm } from '@/components/task-form';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly lead?: string;
}

/**
 * U18 — Create Task.
 *
 * Contract: "Task title, due date, priority, reminder, note."
 *
 * Accepts `?lead=<uuid>` so My Day, My Leads and the Companion can open the form
 * already bound to the lead the operator was working. A task always belongs to a lead:
 * `public.tasks.lead_id` drives My Day's "custom tasks" category, so a leadless task
 * would be invisible in the queue the operator works from. When no lead is supplied the
 * screen explains that and offers the lists to pick one from, rather than creating an
 * orphan row.
 */
export default async function CreateTaskPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const context = await loadViewerContext();

  const canCreateTask = context.permissions.has('task.create');
  const lead =
    query.lead === undefined || query.lead.length === 0
      ? null
      : await getBoundLead(context.viewer.actor, query.lead);

  const openTasks =
    lead === null ? [] : await openTasksForLead(context.viewer.actor, lead.id);
  const leadLabel = lead === null ? '' : lead.fullName;

  return (
    <>
      <PageHead
        subtitle="Tasks you create are yours, appear in My Day on the due date, and stay attached to the lead."
        actions={
          <Row wrap>
            <a className="nx-btn nx-btn--secondary" href="/my-day">
              My Day
            </a>
            <a className="nx-btn nx-btn--secondary" href="/my-leads">
              My Leads
            </a>
          </Row>
        }
      >
        Create Task
      </PageHead>

      {!canCreateTask && (
        <Alert accent="amber" title="Read-only" role="alert">
          Your access does not include creating tasks. Ask an administrator for the task permission.
        </Alert>
      )}

      {lead === null ? (
        <Card>
          <EmptyState
            title="Choose a lead first"
            body={
              query.lead === undefined || query.lead.length === 0
                ? 'A task belongs to a lead. Open a lead from My Leads or My Day, then choose Task — the form opens already bound to it.'
                : 'That lead is not available to you, or it has been deleted.'
            }
            action={
              <a className="nx-btn nx-btn--primary" href="/my-leads">
                Open My Leads
              </a>
            }
          />
        </Card>
      ) : (
        <Grid split>
          <Stack size="lg">
            <Card
              title="Task"
              actions={<Chip accent="indigo">{lead.status.replace(/_/g, ' ')}</Chip>}
            >
              {canCreateTask ? (
                <TaskForm
                  leadId={lead.id}
                  leadLabel={`${leadLabel}${lead.companyName === null ? '' : ` · ${lead.companyName}`}`}
                  businessName={lead.businessName}
                  taskTypes={TASK_TYPES}
                  priorities={TASK_PRIORITIES}
                />
              ) : (
                <span className="nx-hint">Creating tasks is not part of your access.</span>
              )}
            </Card>
          </Stack>

          <Stack size="lg">
            <Card title="This task is for">
              <Stack size="sm">
                <Row between>
                  <span className="nx-hint">Lead</span>
                  <a className="nx-nav__item" style={{ padding: 0 }} href={`/leads/${lead.id}`}>
                    <strong>{leadLabel}</strong>
                  </a>
                </Row>
                <Row between>
                  <span className="nx-hint">Company</span>
                  <span>{lead.companyName ?? '—'}</span>
                </Row>
                <Row between>
                  <span className="nx-hint">Title</span>
                  <span>{lead.jobTitle ?? '—'}</span>
                </Row>
                <Row between>
                  <span className="nx-hint">Business</span>
                  <span>{lead.businessName}</span>
                </Row>
                <Row between>
                  <span className="nx-hint">Next action</span>
                  <span className="nx-table__mono">
                    {lead.nextActionAt === null ? 'not scheduled' : lead.nextActionAt.slice(0, 16).replace('T', ' ')}
                  </span>
                </Row>
              </Stack>
            </Card>

            <Card title="Open tasks" actions={<Chip>{openTasks.length} open</Chip>}>
              {openTasks.length === 0 ? (
                <span className="nx-hint">No open tasks on this lead.</span>
              ) : (
                <Stack size="sm">
                  {openTasks.map((task) => (
                    <Row key={task.id} between>
                      <span>{task.title}</span>
                      <span className="nx-hint">
                        {task.priority}
                        {task.dueAt === null ? '' : ` · ${task.dueAt.slice(0, 16).replace('T', ' ')}`}
                      </span>
                    </Row>
                  ))}
                </Stack>
              )}
            </Card>

            <Grid cols={2}>
              <Stat value={TASK_TYPES.length} label="Task types" meta="spec task type list" />
              <Stat value={TASK_PRIORITIES.length} label="Priorities" meta="low → urgent" />
            </Grid>
          </Stack>
        </Grid>
      )}
    </>
  );
}
