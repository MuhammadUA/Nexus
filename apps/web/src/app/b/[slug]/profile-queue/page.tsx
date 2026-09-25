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
  Stack,
  Stat,
  type Column,
} from '@nexus/ui';
import { PROFILE_QUEUE_STATES } from '@nexus/core';
import { notFound } from 'next/navigation';

import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import {
  getProfileQueueCounts,
  getProfileQueueItem,
  listProfileQueue,
  type ProfileQueueItem,
} from '@/lib/repo/profile-queue';
import { ProfileCaptureForm } from '@/components/profile-capture-form';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 10;

interface SearchParams {
  readonly state?: string;
  readonly page?: string;
  readonly item?: string;
}

function parseState(value: string | undefined): string | undefined {
  return value !== undefined && (PROFILE_QUEUE_STATES as readonly string[]).includes(value) ? value : undefined;
}

/**
 * A06 — Profile Queue.
 *
 * Contract: "Imported leads that lack full LinkedIn profile capture."
 *
 * spec `lead_sources.google.missing_profile_behavior`: a partial record is still
 * created, marked Needs Profile and sent here rather than discarded. spec
 * `profile_queue_flow` then requires the capture to update that existing partial
 * lead — so the capture form is always bound to one `lead_id` chosen from this
 * queue, and nothing on this screen can create a lead.
 */
export default async function ProfileQueuePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<SearchParams>;
}): Promise<ReactNode> {
  const [{ slug }, query] = await Promise.all([params, searchParams]);

  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);
  if (business === null) notFound();

  const state = parseState(query.state);
  const page = Math.max(Number(query.page ?? '1') || 1, 1);

  const [items, counts] = await Promise.all([
    listProfileQueue(
      context.viewer.actor,
      { businessId: business.id, ...(state === undefined ? {} : { state }) },
      { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE },
    ),
    getProfileQueueCounts(context.viewer.actor, business.id),
  ]);

  const canCapture = context.permissions.has('profile_queue.use');
  const totalPages = Math.max(Math.ceil(items.total / PAGE_SIZE), 1);

  const requestedId = query.item ?? '';
  const selected =
    requestedId.length > 0
      ? (items.items.find((item) => item.id === requestedId) ?? (await getProfileQueueItem(context.viewer.actor, requestedId)))
      : null;

  const columns: readonly Column<ProfileQueueItem>[] = [
    {
      key: 'person',
      header: 'Lead',
      cell: (item) => (
        <Stack size="sm">
          <a className="nx-nav__item" style={{ padding: 0 }} href={`/b/${business.key}/leads/${item.leadId}`}>
            <strong>{item.personName ?? 'Unknown person'}</strong>
          </a>
          <span className="nx-hint">
            {item.jobTitle ?? 'no job title'} · {item.companyName ?? 'no company'}
          </span>
          {item.leadStatus !== null && <LeadStatusChip state={item.leadStatus} />}
        </Stack>
      ),
    },
    {
      key: 'linkedin',
      header: 'LinkedIn URL',
      cell: (item) =>
        item.linkedinUrl === null ? (
          <Chip accent="amber" dataState="missing">
            none on the lead
          </Chip>
        ) : (
          <a className="nx-hint" href={item.linkedinUrl} target="_blank" rel="noreferrer noopener">
            Open profile
          </a>
        ),
    },
    {
      key: 'queue',
      header: 'Queue state',
      cell: (item) => (
        <Stack size="sm">
          <Chip
            accent={
              item.state === 'failed'
                ? 'red'
                : item.state === 'pending'
                  ? 'cyan'
                  : item.state === 'in_progress'
                    ? 'indigo'
                    : item.state === 'captured'
                      ? 'green'
                      : 'neutral'
            }
            dataState={item.state}
          >
            {item.state.replace(/_/g, ' ')}
          </Chip>
          <span className="nx-hint">
            {String(item.attempts)} attempt{item.attempts === 1 ? '' : 's'}
          </span>
        </Stack>
      ),
    },
    {
      key: 'reason',
      header: 'Reason',
      cell: (item) => (
        <Stack size="sm">
          <span className="nx-hint">{item.reason ?? '—'}</span>
          {item.lastError !== null && <Chip accent="red">{item.lastError}</Chip>}
        </Stack>
      ),
    },
    {
      key: 'captured',
      header: 'Captured',
      cell: (item) =>
        item.capturedAt === null ? (
          <span className="nx-hint">—</span>
        ) : (
          <span className="nx-table__mono">{item.capturedAt.slice(0, 16).replace('T', ' ')}</span>
        ),
    },
    {
      key: 'capture',
      header: 'Capture',
      cell: (item) => (
        <a
          className={
            requestedId === item.id ? 'nx-btn nx-btn--primary nx-btn--sm' : 'nx-btn nx-btn--secondary nx-btn--sm'
          }
          href={queueHref(business.key, state, page, item.id)}
        >
          {requestedId === item.id ? 'Selected' : 'Capture'}
        </a>
      ),
    },
  ];

  return (
    <>
      <PageHead
        subtitle={`Imported leads in ${business.name} that still lack a full LinkedIn profile capture. Capturing one updates that lead — it never creates a second.`}
        actions={
          <Row wrap>
            <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/lead-sources`}>
              Lead sources
            </a>
            <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/leads`}>
              Leads
            </a>
          </Row>
        }
      >
        Profile Queue
      </PageHead>

      <Grid cols={4}>
        <Stat value={counts.pending} label="Pending" meta="waiting for a capture" />
        <Stat value={counts.inProgress} label="In progress" meta="being worked" />
        <Stat value={counts.captured} label="Captured" meta="profile applied to the lead" />
        <Stat
          value={counts.needsProfile}
          label="Leads flagged Needs Profile"
          meta={`${String(counts.failed)} failed · ${String(counts.skipped)} skipped`}
        />
      </Grid>

      <div style={{ height: 'var(--nx-space-md)' }} />

      <Card
        title="Queue"
        actions={
          <Row wrap>
            {(['all', ...PROFILE_QUEUE_STATES] as readonly string[]).map((option) => {
              const active = option === 'all' ? state === undefined : state === option;
              return (
                <a
                  key={option}
                  className={active ? 'nx-btn nx-btn--primary nx-btn--sm' : 'nx-btn nx-btn--secondary nx-btn--sm'}
                  href={
                    option === 'all'
                      ? `/b/${business.key}/profile-queue`
                      : `/b/${business.key}/profile-queue?state=${option}`
                  }
                >
                  {option.replace(/_/g, ' ')}
                </a>
              );
            })}
          </Row>
        }
      >
        <Stack size="lg">
          <DataTable
            columns={columns}
            rows={items.items}
            rowKey={(item) => item.id}
            caption="Profile capture queue for this business"
            empty={
              <EmptyState
                title={state === undefined ? 'Nothing waiting for a profile' : `No ${state.replace(/_/g, ' ')} items`}
                body="Imports that carry a full LinkedIn URL skip this queue. Partial records land here so a human can open the profile and paste it in."
                action={
                  <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/lead-sources`}>
                    Import more leads
                  </a>
                }
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
                  href={queueHref(business.key, state, page - 1, requestedId)}
                >
                  Previous
                </a>
              )}
              {page < totalPages && (
                <a
                  className="nx-btn nx-btn--secondary nx-btn--sm"
                  href={queueHref(business.key, state, page + 1, requestedId)}
                >
                  Next
                </a>
              )}
            </div>
          )}
        </Stack>
      </Card>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card
        title="Capture a profile"
        actions={
          <Row wrap>
            <Chip accent="cyan">updates the existing lead</Chip>
            {selected !== null && <Chip accent="indigo">{selected.state.replace(/_/g, ' ')}</Chip>}
          </Row>
        }
      >
        {!canCapture && (
          <Alert accent="amber" title="Read-only">
            You can see the queue but not capture into it. Ask an administrator for the profile-queue permission.
          </Alert>
        )}

        {selected === null ? (
          <span className="nx-hint">
            Choose <strong>Capture</strong> on a row above. The form opens with that lead bound to it, so a capture can
            only update the lead it came from.
          </span>
        ) : (
          <Stack size="md">
            <Row between wrap>
              <Row wrap>
                <Chip accent="indigo">{selected.personName ?? 'Unknown person'}</Chip>
                <Chip>{selected.companyName ?? 'no company'}</Chip>
                {selected.needsProfile && <Chip accent="cyan">needs profile</Chip>}
              </Row>
              <a className="nx-btn nx-btn--ghost nx-btn--sm" href={`/b/${business.key}/leads/${selected.leadId}`}>
                Open lead
              </a>
            </Row>

            <Alert accent="cyan" title="What the capture writes">
              The full copied profile is stored verbatim as source evidence with the LinkedIn URL, the capture time, a
              content hash and a confidence. The person record is updated, Needs Profile is cleared on this lead, and
              the queue item becomes captured. No second lead is created.
            </Alert>

            <ProfileCaptureForm
              businessSlug={business.key}
              leadId={selected.leadId}
              queueId={selected.id}
              personName={selected.personName ?? 'this person'}
              defaultLinkedinUrl={selected.linkedinUrl ?? ''}
              queueState={selected.state}
            />
          </Stack>
        )}
      </Card>
    </>
  );
}

function queueHref(slug: string, state: string | undefined, page: number, itemId: string): string {
  const search = new URLSearchParams();
  if (state !== undefined) search.set('state', state);
  if (page > 1) search.set('page', String(page));
  if (itemId.length > 0) search.set('item', itemId);
  const query = search.toString();
  return query.length === 0 ? `/b/${slug}/profile-queue` : `/b/${slug}/profile-queue?${query}`;
}
