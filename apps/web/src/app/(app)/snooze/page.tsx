import type { ReactNode } from 'react';

import { Alert, Card, Chip, EmptyState, Grid, PageHead, Row, Stack, Stat } from '@nexus/ui';

import { loadViewerContext } from '@/lib/viewer-context';
import { getBoundLead } from '@/lib/repo/user-sources';
import { openTasksForLead } from '@/lib/repo/sequence';
import { SnoozeForm, SNOOZE_PRESETS } from '@/components/snooze-form';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly lead?: string;
}

/**
 * U19 — Snooze & Reschedule.
 *
 * Contract: "Tomorrow/2 days/next week/custom date; optional reason."
 *
 * spec `tasks_and_my_day.today_engine_inputs` lists "Snooze/reschedule" as an input to
 * the Today engine, so the consequence is shown plainly: the lead's next action, every
 * pending message instance and every open task move to the new instant together, which
 * is what `snoozeLead` does in one transaction.
 */
export default async function SnoozePage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const context = await loadViewerContext();

  const canSnooze = context.permissions.has('lead.snooze');
  const lead =
    query.lead === undefined || query.lead.length === 0
      ? null
      : await getBoundLead(context.viewer.actor, query.lead);

  const openTasks = lead === null ? [] : await openTasksForLead(context.viewer.actor, lead.id);

  return (
    <>
      <PageHead
        subtitle="Move this lead's next action — and any pending step or open task — to a date you will actually work it."
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
        Snooze &amp; Reschedule
      </PageHead>

      {!canSnooze && (
        <Alert accent="amber" title="Read-only" role="alert">
          Your access does not include snoozing leads. Ask an administrator for the snooze permission.
        </Alert>
      )}

      {lead === null ? (
        <Card>
          <EmptyState
            title="Choose a lead first"
            body={
              query.lead === undefined || query.lead.length === 0
                ? 'Snoozing applies to one lead. Open a lead from My Day or My Leads and choose Snooze — this screen opens already bound to it.'
                : 'That lead is not available to you, or it has been deleted.'
            }
            action={
              <a className="nx-btn nx-btn--primary" href="/my-day">
                Open My Day
              </a>
            }
          />
        </Card>
      ) : (
        <Grid split>
          <Stack size="lg">
            <Card
              title="Reschedule"
              actions={<Chip accent="amber">{lead.status.replace(/_/g, ' ')}</Chip>}
            >
              {canSnooze ? (
                <SnoozeForm leadId={lead.id} />
              ) : (
                <span className="nx-hint">Snoozing is not part of your access.</span>
              )}
            </Card>
          </Stack>

          <Stack size="lg">
            <Card title="This snooze applies to">
              <Stack size="sm">
                <Row between>
                  <span className="nx-hint">Lead</span>
                  <a className="nx-nav__item" style={{ padding: 0 }} href={`/leads/${lead.id}`}>
                    <strong>{lead.fullName}</strong>
                  </a>
                </Row>
                <Row between>
                  <span className="nx-hint">Company</span>
                  <span>{lead.companyName ?? '—'}</span>
                </Row>
                <Row between>
                  <span className="nx-hint">Business</span>
                  <span>{lead.businessName}</span>
                </Row>
                <Row between>
                  <span className="nx-hint">Next action now</span>
                  <span className="nx-table__mono">
                    {lead.nextActionAt === null ? 'not scheduled' : lead.nextActionAt.slice(0, 16).replace('T', ' ')}
                  </span>
                </Row>
                <Row between>
                  <span className="nx-hint">Open tasks</span>
                  <span>{openTasks.length}</span>
                </Row>
              </Stack>
            </Card>

            <Card title="What changes">
              <Stack size="sm">
                <span className="nx-hint">
                  The lead&rsquo;s next action, every pending (unsent) message instance and every open task move to
                  the chosen instant.
                </span>
                <span className="nx-hint">
                  A snooze writes a timeline entry with your reason, so the next operator can see why this lead went
                  quiet.
                </span>
                <span className="nx-hint">
                  Snoozing is not Do Not Contact: it changes timing only and never suppresses outreach.
                </span>
              </Stack>
            </Card>

            <Grid cols={2}>
              <Stat value={openTasks.length} label="Open tasks moved" />
              <Stat value={SNOOZE_PRESETS.length} label="Presets" meta="tomorrow → custom" />            </Grid>
          </Stack>
        </Grid>
      )}
    </>
  );
}
