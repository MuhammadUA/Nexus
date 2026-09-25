import type { ReactNode } from 'react';

import { Alert, Card, Chip, EmptyState, Grid, PageHead, Row, Stack, Stat } from '@nexus/ui';

import { loadViewerContext } from '@/lib/viewer-context';
import { listProfileQueueForViewer } from '@/lib/repo/user-sources';
import { ProfileCapturePanel } from '@/components/user-profile-capture';

export const dynamic = 'force-dynamic';

/**
 * U16 — Profile Queue.
 *
 * Contract: "Work partial leads by opening LinkedIn, capturing URL + full profile content,
 * updating existing lead."
 *
 * spec `lead_sources.profile_queue_flow`: the capture UPDATEs the partial lead; it never
 * creates a second one. This screen therefore shows one panel per queue item that already
 * carries the lead it belongs to, and the capture action passes that id — there is no way
 * to capture onto a different lead from here.
 *
 * The queue itself is read through the shared `lib/repo/profile-queue.ts` repository used
 * by the admin Profile Queue, once per accessible business and merged, so triage order and
 * visibility cannot drift between the two surfaces.
 */
export default async function MyProfileQueuePage(): Promise<ReactNode> {
  const context = await loadViewerContext();

  const canUseQueue = context.permissions.has('profile_queue.use');
  const rows = canUseQueue
    ? await listProfileQueueForViewer(context.viewer.actor, context.businesses, 50)
    : [];

  const pending = rows.filter((row) => row.item.state === 'pending').length;
  const inProgress = rows.filter((row) => row.item.state === 'in_progress').length;
  const failed = rows.filter((row) => row.item.state === 'failed').length;

  return (
    <>
      <PageHead
        subtitle="Partial leads waiting for a full LinkedIn profile. Capturing updates the lead that is already there."
        actions={
          <Row wrap>
            <a className="nx-btn nx-btn--secondary" href="/my-lead-sources">
              Lead Sources
            </a>
            <a className="nx-btn nx-btn--secondary" href="/my-leads">
              My Leads
            </a>
          </Row>
        }
      >
        Profile Queue
      </PageHead>

      {!canUseQueue && (
        <Alert accent="amber" title="Not available" role="alert">
          Your access does not include the profile queue. Ask an administrator for the profile-queue permission.
        </Alert>
      )}

      <Grid cols={4}>
        <Stat value={rows.length} label="Open items" meta="across your businesses" />
        <Stat value={pending} label="Pending" />
        <Stat value={inProgress} label="In progress" meta="claimed by an operator" />
        <Stat value={failed} label="Failed" meta="needs a retry or a skip" />
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing to capture"
            body={
              canUseQueue
                ? 'Partial leads appear here when an import row has no LinkedIn profile URL. Capture a profile and the lead leaves this queue.'
                : 'You do not have access to the profile queue.'
            }
          />
        </Card>
      ) : (
        <Stack size="lg">
          {rows.map((row) => (
            <Card
              key={row.item.id}
              title={
                <Row wrap>
                  <span>{row.item.personName ?? 'Unknown person'}</span>
                  {row.item.jobTitle !== null && <span className="nx-hint">· {row.item.jobTitle}</span>}
                </Row>
              }
              actions={
                <Row wrap>
                  <Chip accent="indigo">{row.businessName}</Chip>
                  <Chip
                    accent={
                      row.item.state === 'failed' ? 'red' : row.item.state === 'captured' ? 'green' : 'cyan'
                    }
                    dataState={row.item.state}
                  >
                    {row.item.state.replace(/_/g, ' ')}
                  </Chip>
                </Row>
              }
              footer={
                row.item.reason === null ? undefined : (
                  <span className="nx-hint">Queued because: {row.item.reason}</span>
                )
              }
            >
              <Stack size="sm">
                <Row wrap>
                  <span className="nx-hint">Company</span>
                  <span>{row.item.companyName ?? '—'}</span>
                  {row.item.attempts > 0 && <span className="nx-hint">· {row.item.attempts} attempt(s)</span>}
                  {row.item.lastError !== null && <span className="nx-hint">· last error: {row.item.lastError}</span>}
                </Row>

                {canUseQueue ? (
                  <ProfileCapturePanel
                    queueId={row.item.id}
                    leadId={row.item.leadId}
                    personName={row.item.personName ?? 'this person'}
                    linkedinUrl={row.item.linkedinUrl}
                    state={row.item.state}
                  />
                ) : (
                  <span className="nx-hint">Capturing is not part of your access.</span>
                )}
              </Stack>
            </Card>
          ))}
        </Stack>
      )}

      <p className="nx-hint" style={{ marginTop: 'var(--nx-space-md)' }}>
        <Chip accent="cyan">note</Chip> Capture never creates a lead. If the LinkedIn URL you paste already belongs to
        another person, the capture is refused and the pair is sent to Duplicate Review so a human decides.
      </p>
    </>
  );
}
