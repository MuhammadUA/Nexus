import type { ReactNode } from 'react';

import {
  DEFAULT_SEQUENCE_STEPS,
  ZEMNAS_MESSAGE_DEFAULTS,
  computePublishImpact,
  type PublishImpactItem,
} from '@nexus/core';
import {
  Alert,
  Card,
  Chip,
  DataTable,
  Grid,
  MessageStateChip,
  PageHead,
  Row,
  Stack,
  Stat,
  type Column,
} from '@nexus/ui';
import { notFound } from 'next/navigation';

import {
  ArchiveSequenceAction,
  CreateVersionForm,
  PublishVersionForm,
  SequenceForm,
  StepEditForm,
} from '@/components/sequence-forms';
import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import {
  getSequenceTimingSettings,
  listDormantLeads,
  listMessageInstancesForVersion,
  listSequenceVersions,
  listSequences,
  seedSteps,
  type SequenceStep,
  type SequenceSummary,
  type SequenceVersion,
} from '@/lib/repo/sequences';

export const dynamic = 'force-dynamic';

/**
 * A13 — Sequence Manager.
 *
 * Contract: "Message 1 + FU1 + FU2 + FU3; delays, generation rules, lifecycle,
 * publishing/version behavior, dormant/reactivation."
 *
 * Publishing is previewed against the real `message_instances` rows of the selected
 * version with `computePublishImpact` before the operator can press the button, and the
 * write itself goes through `public.publish_sequence_version`.
 */
export default async function SequenceManagerPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { slug } = await params;
  const query = await searchParams;

  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);
  if (business === null) notFound();

  // Business-scoped configuration: judged against this business's grant alone.
  requireRouteAccess(context, { route: '/b/:businessSlug/setup/sequences', businessId: business.id });

  const actor = context.viewer.actor;
  const basePath = `/b/${business.key}/setup/sequences`;

  const [sequences, timing, dormantLeads] = await Promise.all([
    listSequences(actor, business.id),
    getSequenceTimingSettings(actor, business.id),
    listDormantLeads(actor, business.id),
  ]);

  const requestedSequenceId = firstParam(query.sequence);
  const selectedSequence: SequenceSummary | null =
    (requestedSequenceId === null
      ? undefined
      : sequences.find((sequence) => sequence.id === requestedSequenceId)) ??
    sequences.find((sequence) => sequence.isDefault) ??
    sequences[0] ??
    null;

  const versions: readonly SequenceVersion[] =
    selectedSequence === null ? [] : await listSequenceVersions(actor, selectedSequence.id);

  const requestedVersionId = firstParam(query.version);
  const selectedVersion: SequenceVersion | null =
    (requestedVersionId === null
      ? undefined
      : versions.find((version) => version.id === requestedVersionId)) ??
    versions.find((version) => version.id === selectedSequence?.currentVersionId) ??
    versions[0] ??
    null;

  // The preview is computed from the rows that would actually be affected, which is why
  // it is read per version rather than derived from counts on the sequence.
  const instances =
    selectedVersion === null ? [] : await listMessageInstancesForVersion(actor, selectedVersion.id);
  const impact = computePublishImpact(instances);

  const canManage = context.permissions.has('sequence.manage');
  const canPublish = canManage && context.viewer.role === 'admin';

  const lifecycle =
    selectedVersion === null || selectedVersion.steps.length === 0
      ? seedSteps(timing.followupDelays).map((step) => ({
          stepOrder: step.stepOrder,
          name: step.name,
          kind: step.kind,
          delayDays: step.delayDays,
          delayBasis: step.delayBasis,
        }))
      : selectedVersion.steps.map((step) => ({
          stepOrder: step.stepOrder,
          name: step.name,
          kind: step.kind,
          delayDays: step.delayDays,
          delayBasis: step.delayBasis,
        }));

  const totalActiveEnrollments = sequences.reduce(
    (sum, sequence) => sum + sequence.activeEnrollments,
    0,
  );
  const totalDormant = sequences.reduce((sum, sequence) => sum + sequence.dormantEnrollments, 0);

  const sequenceColumns: readonly Column<SequenceSummary>[] = [
    {
      key: 'name',
      header: 'Sequence',
      cell: (sequence) => (
        <Stack size="sm">
          <Row wrap>
            <span>{sequence.name}</span>
            {sequence.isDefault && <Chip accent="indigo">business default</Chip>}
            <Chip accent={sequence.status === 'active' ? 'green' : 'neutral'}>{sequence.status}</Chip>
          </Row>
          {sequence.description !== null && <span className="nx-hint">{sequence.description}</span>}
        </Stack>
      ),
    },
    {
      key: 'version',
      header: 'Current version',
      cell: (sequence) =>
        sequence.currentVersion === null ? (
          <span className="nx-hint">no version yet</span>
        ) : (
          <Row wrap>
            <span className="nx-table__mono">{`v${String(sequence.currentVersion)}`}</span>
            <Chip accent={sequence.currentVersionStatus === 'published' ? 'green' : 'amber'}>
              {sequence.currentVersionStatus ?? 'draft'}
            </Chip>
          </Row>
        ),
    },
    { key: 'versions', header: 'Versions', numeric: true, cell: (sequence) => sequence.versionCount },
    { key: 'steps', header: 'Steps', numeric: true, cell: (sequence) => sequence.stepCount },
    {
      key: 'enrolled',
      header: 'Live enrollments',
      numeric: true,
      cell: (sequence) => sequence.activeEnrollments,
    },
    { key: 'dormant', header: 'Dormant', numeric: true, cell: (sequence) => sequence.dormantEnrollments },
    {
      key: 'actions',
      header: '',
      cell: (sequence) => (
        <a className="nx-btn nx-btn--secondary nx-btn--sm" href={`${basePath}?sequence=${sequence.id}`}>
          Open
        </a>
      ),
    },
  ];

  const versionColumns: readonly Column<SequenceVersion>[] = [
    {
      key: 'version',
      header: 'Version',
      cell: (version) => (
        <Row wrap>
          <span className="nx-table__mono">{`v${String(version.version)}`}</span>
          <Chip
            accent={
              version.status === 'published' ? 'green' : version.status === 'draft' ? 'amber' : 'neutral'
            }
          >
            {version.status}
          </Chip>
        </Row>
      ),
    },
    {
      key: 'steps',
      header: 'Steps',
      numeric: true,
      cell: (version) => version.steps.length,
    },
    {
      key: 'published',
      header: 'Published',
      cell: (version) => (
        <Stack size="sm">
          <span className="nx-table__mono">{formatWhen(version.publishedAt)}</span>
          {version.publishedByName !== null && <span className="nx-hint">{version.publishedByName}</span>}
        </Stack>
      ),
    },
    {
      key: 'summary',
      header: 'Change summary',
      cell: (version) => version.changeSummary ?? <span className="nx-hint">—</span>,
    },
    {
      key: 'impact',
      header: 'Recorded impact',
      cell: (version) =>
        version.status !== 'published' ? (
          <span className="nx-hint">not published yet</span>
        ) : (
          <span className="nx-hint">
            {`${String(version.impactPreview.sentUntouched ?? 0)} sent kept · ${String(
              version.impactPreview.lockedUntouched ?? 0,
            )} locked kept · ${String(version.impactPreview.dynamicNeedsRegeneration ?? 0)} dynamic invalidated · ${String(
              version.impactPreview.enrollmentsMoved ?? 0,
            )} enrollments moved`}
          </span>
        ),
    },
    {
      key: 'actions',
      header: '',
      cell: (version) => (
        <a
          className="nx-btn nx-btn--secondary nx-btn--sm"
          href={`${basePath}?sequence=${version.sequenceId}&version=${version.id}`}
        >
          {version.status === 'draft' ? 'Edit and publish' : 'Inspect'}
        </a>
      ),
    },
  ];

  const impactColumns: readonly Column<PublishImpactItem>[] = [
    {
      key: 'lead',
      header: 'Lead',
      cell: (item) => <span className="nx-table__mono">{item.leadId.slice(0, 8)}</span>,
    },
    { key: 'state', header: 'Message state', cell: (item) => <MessageStateChip state={item.state} /> },
    {
      key: 'action',
      header: 'On publish',
      cell: (item) => (
        <Chip accent={item.action === 'invalidate' ? 'amber' : 'green'}>
          {item.action === 'invalidate' ? 'needs regeneration' : 'unchanged'}
        </Chip>
      ),
    },
    { key: 'reason', header: 'Reason', cell: (item) => <span className="nx-hint">{item.reason}</span> },
  ];

  const stepColumns: readonly Column<SequenceStep>[] = [
    {
      key: 'order',
      header: 'Order',
      numeric: true,
      cell: (step) => step.stepOrder,
    },
    {
      key: 'name',
      header: 'Step',
      cell: (step) => (
        <Stack size="sm">
          <span>{step.name}</span>
          {step.goal !== null && <span className="nx-hint">{step.goal}</span>}
        </Stack>
      ),
    },
    { key: 'kind', header: 'Kind', cell: (step) => step.kind },
    {
      key: 'delay',
      header: 'Delay',
      cell: (step) => (
        <Row wrap>
          <Chip accent={step.delayDays === 0 ? 'cyan' : 'amber'}>{`${String(step.delayDays)}d`}</Chip>
          <span className="nx-hint">{step.delayBasis.replace(/_/g, ' ')}</span>
        </Row>
      ),
    },
    {
      key: 'words',
      header: 'Word max',
      numeric: true,
      cell: (step) => step.wordMax ?? <span className="nx-hint">—</span>,
    },
    {
      key: 'generation',
      header: 'Generation',
      cell: (step) => <Chip accent="indigo">{step.generationMode}</Chip>,
    },
    {
      key: 'active',
      header: 'Active',
      cell: (step) => (
        <Chip accent={step.isActive ? 'green' : 'neutral'}>{step.isActive ? 'active' : 'inactive'}</Chip>
      ),
    },
  ];

  return (
    <>
      <PageHead
        subtitle={`${business.name} · Message 1 + FU1 + FU2 + FU3, delays, generation rules and publishing`}
        actions={
          <Row wrap>
            <Chip accent="indigo">configuration</Chip>
            <Chip accent="green">{`${String(totalActiveEnrollments)} live enrollments`}</Chip>
          </Row>
        }
      >
        Sequence Manager
      </PageHead>

      <Alert accent="indigo" title="Lifecycle and publishing behaviour">
        Connection, then Message 1 when the connection is accepted, then Follow-up 1, 2 and 3. After
        FU3 without a reply the lead becomes Dormant and is scheduled for reactivation review around{' '}
        {timing.reactivationDays} days later. Any captured reply pauses the pending automatic steps.
        Publishing a version never rewrites history: SENT messages stay immutable, LOCKED unsent
        messages are left alone, and eligible DYNAMIC unsent messages are marked needs-regeneration.
        Every message keeps its <span className="nx-table__mono">sequence_version_id</span> and{' '}
        <span className="nx-table__mono">message_version_id</span> for audit.
      </Alert>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Grid cols={4}>
        <Stat value={sequences.length} label="Sequences" meta={`${String(versions.length)} versions on the selected one`} />
        <Stat
          value={selectedSequence === null ? '—' : (selectedSequence.currentVersion ?? '—')}
          label="Selected current version"
          meta={selectedSequence?.name ?? 'no sequence yet'}
        />
        <Stat value={totalActiveEnrollments} label="Live enrollments" meta="active, paused, reactivation due" />
        <Stat value={totalDormant} label="Dormant leads" meta={`reactivation ~${String(timing.reactivationDays)} days`} />
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Card
        title="Lifecycle"
        actions={
          <Chip accent="indigo">
            {selectedVersion === null
              ? 'default delays'
              : `from v${String(selectedVersion.version)}`}
          </Chip>
        }
      >
        <Stack size="sm">
          <Row wrap>
            <Chip accent="cyan">Connection</Chip>
            {lifecycle.map((step) => (
              <Row key={`${String(step.stepOrder)}-${step.name}`} wrap>
                <span className="nx-hint">→</span>
                <Chip accent={step.kind === 'message' ? 'green' : 'amber'}>
                  {`${step.name} ${
                    step.delayDays === 0 ? '(when eligible)' : `(+${String(step.delayDays)}d)`
                  }`}
                </Chip>
              </Row>
            ))}
            <span className="nx-hint">→</span>
            <Chip accent="neutral">{`Dormant (~${String(timing.reactivationDays)} days)`}</Chip>
          </Row>
          <p className="nx-hint">
            Delays are configuration: they come from this business&apos;s platform settings
            (`sequence.default_followup_delays_days` and `dormant.reactivation_days`), seeded as{' '}
            {DEFAULT_SEQUENCE_STEPS.slice(1)
              .map((step) => `${String(step.delayDays)}d`)
              .join(' / ')}{' '}
            by default. Follow-ups are not pre-generated: each one is generated close to its due time
            from the current approved Business Brain, the current sequence version and the prior
            messages.
          </p>
        </Stack>
      </Card>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Card
        title="Sequences"
        actions={
          <Row>
            <Chip accent="indigo">{sequences.length}</Chip>
            <a className="nx-btn nx-btn--ghost nx-btn--sm" href={basePath}>
              New sequence
            </a>
          </Row>
        }
      >
        <DataTable
          columns={sequenceColumns}
          rows={sequences}
          rowKey={(sequence) => sequence.id}
          caption="Configured outreach sequences"
          empty={
            <span className="nx-hint">
              No sequences yet. Create one, then open a draft version to define its steps and delays.
            </span>
          }
        />
      </Card>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Grid split>
        <Stack size="lg">
          <Card
            title={selectedSequence === null ? 'New sequence' : `Sequence settings — ${selectedSequence.name}`}
            actions={<Chip accent="indigo">sequence</Chip>}
          >
            {canManage ? (
              <>
                <SequenceForm
                  mode={selectedSequence === null ? 'create' : 'edit'}
                  businessSlug={business.key}
                  businessId={business.id}
                  {...(selectedSequence === null ? {} : { sequence: selectedSequence })}
                />
                {selectedSequence !== null && (
                  <>
                    <div style={{ height: 'var(--nx-space-lg)' }} />
                    <ArchiveSequenceAction
                      sequenceId={selectedSequence.id}
                      sequenceName={selectedSequence.name}
                      businessSlug={business.key}
                    />
                  </>
                )}
              </>
            ) : (
              <span className="nx-hint">
                You do not have the sequence.manage permission, so sequence configuration is read-only
                for you. The database refuses the write either way.
              </span>
            )}
          </Card>

          {selectedSequence !== null && (
            <Card
              title="Versions"
              actions={<Chip accent="indigo">{versions.length}</Chip>}
            >
              <Stack>
                <DataTable
                  columns={versionColumns}
                  rows={versions}
                  rowKey={(version) => version.id}
                  caption="Versions of the selected sequence"
                  empty={
                    <span className="nx-hint">
                      This sequence has no version yet. Create version 1 to get the default lifecycle
                      with this business&apos;s configured delays.
                    </span>
                  }
                />
                {canManage &&
                  (selectedVersion === null || selectedVersion.status !== 'draft' ? (
                    <CreateVersionForm
                      businessSlug={business.key}
                      businessId={business.id}
                      sequenceId={selectedSequence.id}
                      sourceVersionId={selectedVersion === null ? null : selectedVersion.id}
                      sourceLabel={
                        selectedVersion === null
                          ? 'the current version'
                          : `v${String(selectedVersion.version)}`
                      }
                    />
                  ) : (
                    <p className="nx-hint">
                      This version is already a draft, so its steps are editable below. Publishing it
                      closes the draft; open a published version to start the next draft from it.
                    </p>
                  ))}
              </Stack>
            </Card>
          )}
        </Stack>

        <Stack size="lg">
          <Card title="Message defaults (Zemnas)" actions={<Chip accent="cyan">guidance</Chip>}>
            <Stack size="sm">
              <p className="nx-hint">
                Target length: about {String(ZEMNAS_MESSAGE_DEFAULTS.minWords)}–
                {String(ZEMNAS_MESSAGE_DEFAULTS.maxWords)} words.
              </p>
              <p className="nx-hint">
                Banned phrases: {ZEMNAS_MESSAGE_DEFAULTS.prohibitedPhrases.join(' · ')} — plus generic
                praise about the prospect or their profile.
              </p>
              <p className="nx-hint">
                A draft must carry one real personalization signal, explain what the business does in
                one sentence, and end with a low-pressure call to action. These defaults are
                configuration, not product constants, and the same checks run server-side before a
                message may be marked sent.
              </p>
            </Stack>
          </Card>

          <Card title="Message states" actions={<Chip accent="indigo">publish behaviour</Chip>}>
            <Stack size="sm">
              <Row wrap>
                <MessageStateChip state="DYNAMIC" />
                <span className="nx-hint">
                  May regenerate when the sequence or Business Brain changes before it is sent.
                </span>
              </Row>
              <Row wrap>
                <MessageStateChip state="LOCKED" />
                <span className="nx-hint">
                  Manually edited or approved: publishing never overwrites it.
                </span>
              </Row>
              <Row wrap>
                <MessageStateChip state="SENT" />
                <span className="nx-hint">
                  Immutable historical content; corrections are new events, never overwrites.
                </span>
              </Row>
            </Stack>
          </Card>

          <Card
            title="Dormant & reactivation"
            actions={<Chip accent="amber">{dormantLeads.length}</Chip>}
          >
            <Stack size="sm">
              <p className="nx-hint">
                After FU3 with no reply a lead becomes dormant and is reviewed around{' '}
                {String(timing.reactivationDays)} days later. A reactivation prefers a fresh buying
                signal or a new angle over repeating the old sequence.
              </p>
              <DataTable
                columns={[
                  { key: 'person', header: 'Lead', cell: (row) => row.personName },
                  {
                    key: 'company',
                    header: 'Company',
                    cell: (row) => row.companyName ?? <span className="nx-hint">—</span>,
                  },
                  {
                    key: 'days',
                    header: 'Dormant for',
                    numeric: true,
                    cell: (row) => `${String(row.dormancyDays)}d`,
                  },
                  {
                    key: 'dormant',
                    header: 'Dormant since',
                    cell: (row) => <span className="nx-table__mono">{formatWhen(row.dormantAt)}</span>,
                  },
                  {
                    key: 'due',
                    header: 'Reactivation due',
                    cell: (row) => <span className="nx-table__mono">{formatWhen(row.reactivationDueAt)}</span>,
                  },
                ]}
                rows={dormantLeads}
                rowKey={(row) => row.leadId}
                caption="Dormant leads awaiting a reactivation review"
                empty={<span className="nx-hint">No dormant leads are waiting on a reactivation.</span>}
              />
            </Stack>
          </Card>
        </Stack>
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      {selectedVersion !== null && (
        <>
          <Card
            title={`Publish impact — v${String(selectedVersion.version)}`}
            actions={
              <Row wrap>
                <Chip accent={selectedVersion.status === 'published' ? 'green' : 'amber'}>
                  {selectedVersion.status}
                </Chip>
                <Chip accent="indigo">{`${String(impact.total)} message instances`}</Chip>
              </Row>
            }
          >
            <Stack size="lg">
              <Grid cols={4}>
                <Stat
                  value={impact.sentUntouched}
                  label="SENT kept immutable"
                  meta="content never rewritten"
                />
                <Stat
                  value={impact.lockedUntouched}
                  label="LOCKED kept unchanged"
                  meta="manual edits preserved"
                />
                <Stat
                  value={impact.dynamicInvalidated}
                  label="DYNAMIC to invalidate"
                  meta="unsent, eligible for regeneration"
                />
                <Stat
                  value={selectedVersion.enrollmentCount}
                  label="Enrollments on this version"
                  meta="history is retained"
                />
              </Grid>

              {selectedVersion.status === 'draft' ? (
                <p className="nx-hint">
                  This preview is computed from the actual message instances attached to this
                  version&apos;s steps. Publishing archives the previously published version, moves
                  live enrollments onto this one, and records the applied counts on the version.
                </p>
              ) : (
                <p className="nx-hint">
                  This version is {selectedVersion.status}, so it can no longer be changed. It recorded{' '}
                  {String(selectedVersion.impactPreview.sentUntouched ?? 0)} SENT messages kept,{' '}
                  {String(selectedVersion.impactPreview.lockedUntouched ?? 0)} LOCKED messages kept,{' '}
                  {String(selectedVersion.impactPreview.dynamicNeedsRegeneration ?? 0)} DYNAMIC messages
                  invalidated and {String(selectedVersion.impactPreview.enrollmentsMoved ?? 0)}{' '}
                  enrollments moved when it was published
                  {selectedVersion.impactPreview.publishedAt === null
                    ? '.'
                    : ` on ${formatWhen(selectedVersion.impactPreview.publishedAt)}.`}
                </p>
              )}

              <DataTable
                columns={impactColumns}
                rows={impact.items}
                rowKey={(item) => item.instanceId}
                caption="Message instances affected by publishing this version"
                empty={
                  <span className="nx-hint">
                    No message instances are attached to this version yet, so publishing it changes no
                    scheduled message.
                  </span>
                }
              />

              {selectedVersion.status === 'draft' && canManage && (
                <PublishVersionForm
                  businessSlug={business.key}
                  versionId={selectedVersion.id}
                  version={selectedVersion.version}
                  canPublish={canPublish}
                />
              )}
            </Stack>
          </Card>

          <div style={{ height: 'var(--nx-space-xl)' }} />

          <Card
            title={`Steps — v${String(selectedVersion.version)}`}
            actions={<Chip accent="indigo">{selectedVersion.steps.length}</Chip>}
          >
            <DataTable
              columns={stepColumns}
              rows={selectedVersion.steps}
              rowKey={(step) => step.id}
              caption="Steps in the selected version"
              empty={
                <span className="nx-hint">
                  This version has no steps. Steps are created with the version; create a new draft to
                  seed the default lifecycle.
                </span>
              }
            />
          </Card>

          <div style={{ height: 'var(--nx-space-lg)' }} />

          {selectedVersion.steps.length > 0 && (
            <Stack size="lg">
              {selectedVersion.steps.map((step) => (
                <Card
                  key={step.id}
                  title={`${String(step.stepOrder)}. ${step.name}`}
                  actions={
                    <Row wrap>
                      <Chip accent={step.kind === 'message' ? 'green' : 'amber'}>{step.kind}</Chip>
                      <Chip accent={step.delayDays === 0 ? 'cyan' : 'amber'}>{`${String(step.delayDays)}d`}</Chip>
                      <Chip accent="indigo">{step.generationMode}</Chip>
                    </Row>
                  }
                >
                  {canManage ? (
                    <StepEditForm
                      businessSlug={business.key}
                      step={step}
                      editable={selectedVersion.status === 'draft'}
                    />
                  ) : (
                    <Stack size="sm">
                      <p className="nx-hint">{step.goal ?? 'No goal recorded.'}</p>
                      <p className="nx-hint">
                        {`Delay: ${String(step.delayDays)} days ${step.delayBasis.replace(/_/g, ' ')} · word max ${
                          step.wordMax === null ? 'not set' : String(step.wordMax)
                        } · proof policy ${step.proofPolicy ?? 'not set'}`}
                      </p>
                      <p className="nx-hint">
                        You do not have the sequence.manage permission, so this step is read-only for
                        you.
                      </p>
                    </Stack>
                  )}
                </Card>
              ))}
            </Stack>
          )}
        </>
      )}
    </>
  );
}

function firstParam(value: string | string[] | undefined): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0];
  return null;
}

function formatWhen(value: string | null): string {
  if (value === null || value.length === 0) return '—';
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16);
}
