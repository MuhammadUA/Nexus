import type { ReactNode } from 'react';

import {
  AGENT_JOB_TYPES,
  LEAD_STATES,
  REPLY_OUTCOMES,
  TASK_PRIORITIES,
  TASK_TYPES,
  type OutreachChannel,
} from '@nexus/core';
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
  actionLabel,
  type Column,
} from '@nexus/ui';
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
import { AiDraftControl } from '@/components/ai-draft-control';
import { LeadActionWorkspace } from '@/components/lead-action-workspace';
import {
  CreateAgentJobForm,
  LeadEnrichmentWorkspace,
  ProcessingStepsIndicator,
  RecomputeEnrichmentButton,
  RefreshContextButton,
  missingSearchLinks,
  processingSteps,
} from '@/components/lead-enrichment-workspace';
import {
  LeadIntelligenceBrief,
  IntelligenceMeter,
  buildOpportunityBrief,
  discoverySourceLabel,
  enrichmentIsIncomplete,
  enrichmentStateAccent,
  enrichmentStateLabel,
  flattenPackSummary,
  intelligenceLabel,
  missingFieldsText,
  outreachChannelLabel,
  readPackString,
  type BriefPack,
  type BriefSignal,
  type EvidenceEntry,
} from '@/components/lead-intelligence-brief';
import {
  LeadChannelOutreach,
  channelOutreachRows,
  contactPointProvenanceLabel,
  type ChannelAccountView,
  type ContactPointView,
} from '@/components/lead-channel-outreach';
import { asIso, asNumber, asString, asStringArray, read } from '@/lib/repo/common';
import { canAccessRoute } from '@/lib/route-guard';
import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import { loadLeadIntelligence } from '@/lib/repo/enrichment';
import {
  getLead,
  getLeadTimeline,
  listIcpOptions,
  listIdentityOptions,
  listOwnerOptions,
  type TimelineEntry,
} from '@/lib/repo/leads';
import {
  dueMessageForLead,
  openTasksForLead,
  sequenceStateForLead,
  sequenceStepsForLead,
  type SequenceStep,
} from '@/lib/repo/sequence';

export const dynamic = 'force-dynamic';

/**
 * A04 / U06 — Lead Detail (V1.2, intelligence first).
 *
 * The hierarchy is fixed by §69.1 and is the whole point of this screen: intelligence comes
 * **before** the conversation. In order —
 *
 *   1. HEADER — who this is, both states side by side, the intelligence score with its missing
 *      pieces, the available channels and the two generated links;
 *   2. AI OPPORTUNITY BRIEF — a projection of the current Context Pack (§53.2), never a second
 *      model call, and visibly empty when there is nothing to say;
 *   3. PERSON / COMPANY / CONTACTS — the structured facts, with user-confirmed values
 *      distinguished from AI-extracted ones (§26.4);
 *   4. ENRICHMENT WORKSPACE — the only place that accepts a raw paste, and the only place that
 *      could ever re-display it, which it does not (§32.2.6);
 *   5. SOURCE / PROVENANCE — the permanent metadata allow-list (§32.3) and structured summaries;
 *   6. OUTREACH — account, state and next action per channel, with the source kept out of the
 *      availability rule (§20.3);
 *   7. AI DRAFT — the existing drafting control, unchanged, including SENT immutability;
 *   8. TIMELINE — human, message, reply, enrichment and agent-job events, newest first;
 *   9. TASKS — the V1 task surface, unchanged.
 *
 * Nothing on this page calls a model or creates a job: those live in server actions (§76.1).
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

  const [
    timeline,
    icps,
    identities,
    owners,
    tasks,
    dueMessage,
    sequence,
    steps,
    intelligence,
    enrichment,
    evidenceRows,
    jobRows,
  ] = await Promise.all([
    getLeadTimeline(context.viewer.actor, id),
    listIcpOptions(context.viewer.actor, business.id),
    listIdentityOptions(context.viewer.actor, business.id),
    listOwnerOptions(context.viewer.actor, business.id),
    openTasksForLead(context.viewer.actor, id),
    dueMessageForLead(context.viewer.actor, id),
    sequenceStateForLead(context.viewer.actor, id),
    sequenceStepsForLead(context.viewer.actor, id),
    // The frozen V1.2 read model: stored state, score, missing components, facts, channels and
    // the deterministic search links. It performs no AI call and no write.
    loadLeadIntelligence(context.viewer, id),
    loadEnrichmentBundle(context.viewer.actor, id, lead.personId, lead.companyId),
    loadEvidenceBundle(context.viewer.actor, id, lead.personId, lead.companyId),
    loadJobBundle(context.viewer.actor, id, business.id),
  ]);

  const canEdit = context.permissions.has('lead.update');
  const canCaptureReply = context.permissions.has('lead.capture_reply');
  const canDelete = context.permissions.has('lead.soft_delete');
  const canEnrich = canEdit && context.permissions.has('lead_source.use');
  const canCreateJobs = canEdit;
  const defaultIdentityId = lead.outreachIdentityId ?? identities[0]?.value ?? '';

  // AI drafting is offered only to a viewer the server action will serve. The action re-checks this
  // same route requirement against this same business (`draftMessageAction`), so a control that
  // renders here and a call that is accepted cannot disagree — a user-surface reader of the shared
  // lead screen still gets the whole page, just not a control that would be refused.
  const canDraftWithAi = canAccessRoute(context, {
    route: '/b/:businessSlug/leads/:leadId',
    businessId: business.id,
  });

  /**
   * The authoritative V1.2 values.
   *
   * `loadLeadIntelligence` is the frozen read model; a `null` means the lead was not visible to it,
   * which cannot happen after `getLead` succeeded — so the canonical row is the fallback rather than
   * an invented default.
   *
   * **The stored score wins.** §27.2/§14.4 require `completeness_score` and `missing_fields` to be
   * recomputed in the same transaction as any fact change, and the Leads table renders the stored
   * column (§68.2). Deriving a second number here would let the same lead read 65% in the list and
   * 72% on its own page, so this screen reads the column and *reports* a disagreement (see the chip
   * below) instead of quietly papering over it.
   */
  const missingEnrichmentRow = enrichment.status === null;
  const enrichmentState = missingEnrichmentRow ? 'MINIMAL' : enrichment.status;
  const completenessScore = missingEnrichmentRow ? 0 : enrichment.completenessScore;
  const missingFields = missingEnrichmentRow ? [] : enrichment.missingFields;
  const scoreDisagrees =
    !missingEnrichmentRow &&
    intelligence !== null &&
    intelligence.completenessScore !== enrichment.completenessScore;
  const discoverySource = intelligence?.source ?? 'other';
  const facts = intelligence?.facts ?? null;

  /**
   * §20.3 — a channel is available when the business holds an account on it **and** the person has a
   * contact point for it. The read model reports the vocabulary rather than a per-lead restriction
   * (its own comment says a discovery source must never restrict a channel), so the intersection is
   * computed here from the accounts and contact points this page has already read.
   */
  const hasAccount = (channel: OutreachChannel): boolean =>
    jobRows.accounts.some((account) => account.channel === channel && account.status !== 'retired');
  const hasContact = (channel: OutreachChannel): boolean =>
    enrichment.contactPoints.some((point) => point.kind === channel) ||
    (channel === 'linkedin' && lead.linkedinUrl !== null);
  const availableChannels: readonly OutreachChannel[] = (intelligence?.availableChannels ?? []).filter(
    (channel) => hasAccount(channel) && hasContact(channel),
  );

  /**
   * §53.4/§69.3 — the brief says what is stored and nothing more.
   *
   * Signals come from the `signals` table (they are the evidence), and the pack body is projected
   * over a bounded set of candidate keys because §59.6 leaves `pack jsonb`'s schema OPEN.
   */
  const briefSignals: readonly BriefSignal[] = evidenceRows.signals.map((signal) => ({
    id: signal.id,
    kind: signal.kind,
    label: signal.label,
    detail: signal.detail,
    polarity: signal.polarity,
    strength: signal.strength,
    observedAt: signal.observedAt,
    sourceUrl: signal.sourceUrl,
    collectorAgent: signal.collectorAgent,
    contentHash: signal.contentHash,
  }));

  const pack = evidenceRows.pack;
  const briefPack: BriefPack | null =
    pack === null
      ? null
      : {
          version: pack.version,
          createdAt: pack.createdAt,
          model: pack.model,
          promptKey: pack.promptKey,
          promptVersion: pack.promptVersion,
          angle: readPackString(pack.pack, ['recommended_angle', 'angle', 'positioning']),
          recommendation: readPackString(pack.pack, ['recommendation', 'recommended_approach', 'approach']),
          summary: flattenPackSummary(pack.sourceSummary),
        };

  const bestMatch = lead.icpMatches.find((match) => match.isPrimary) ?? lead.icpMatches[0] ?? null;
  const brief = buildOpportunityBrief({
    leadName: lead.personName,
    leadTitle: lead.jobTitle,
    companyName: lead.companyName,
    primaryIcpName: lead.primaryIcpName,
    icpFit: bestMatch?.matchScore ?? null,
    icpReason: bestMatch?.reason ?? null,
    completenessScore,
    missingFields,
    signals: briefSignals,
    pack: briefPack,
    availableChannels,
    now: new Date(),
  });

  const evidenceEntries: readonly EvidenceEntry[] = evidenceRows.evidence;

  /** §67.2 — the async states, derived from stored rows only. */
  const processing = processingSteps({
    leadExists: true,
    personResolved: lead.personId.length > 0 && lead.personName.trim().length > 0,
    companyResolved: lead.companyId !== null,
    profileExtractionDone: enrichment.lastProfileEnrichmentAt !== null,
    companyResearchDone: facts?.companyResearch ?? false,
    companyResearchJobOpen: jobRows.jobs.some(
      (job) =>
        job.jobType === 'RESEARCH_COMPANY' &&
        (job.status === 'OPEN' || job.status === 'RUNNING' || job.status === 'WAITING_AI'),
    ),
    qualificationDone: lead.icpMatches.length > 0,
    enrichmentState: String(enrichmentState),
    lastErrorCode: enrichment.lastErrorCode,
  });

  const searchLinkList = intelligence?.searchLinks ?? [];
  const unavailableLinks = missingSearchLinks({
    fullName: lead.personName,
    companyName: lead.companyName,
    location: lead.location,
    companyDomain: lead.companyDomain,
    linkedinUrl: lead.linkedinUrl,
  });

  const knownFields: readonly { readonly label: string; readonly value: string }[] = [
    { label: 'Full name', value: lead.personName },
    { label: 'Job title', value: lead.jobTitle ?? 'not recorded' },
    { label: 'Location', value: lead.location ?? 'not recorded' },
    { label: 'LinkedIn URL', value: lead.linkedinUrl ?? 'not recorded' },
    { label: 'Company', value: lead.companyName ?? 'not recorded' },
    { label: 'Company website', value: lead.companyDomain ?? 'not recorded' },
    { label: 'Contact points', value: String(enrichment.contactPoints.length) },
  ];

  const accountViews: readonly ChannelAccountView[] = jobRows.accounts.map((account) => ({
    channel: account.channel,
    displayName: account.displayName,
    status: account.status,
  }));

  const outreachRows = channelOutreachRows({
    availableChannels,
    accounts: accountViews,
    contactPoints: enrichment.contactPoints,
    discoverySource,
    nextAction: actionLabel(lead.nextActionType, null),
    sequenceState: sequence.state,
    isDnc: lead.isDnc,
  });

  const dueIdentityChannel =
    jobRows.accounts.find((account) => account.id === lead.outreachIdentityId)?.channel ?? null;

  /** The merged timeline: the V1 events plus enrichment and agent-job entries (§69.1 item 8). */
  const mergedTimeline: readonly DetailTimelineEntry[] = [
    ...timeline.map((entry: TimelineEntry): DetailTimelineEntry => ({ ...entry, kind: entry.kind })),
    ...enrichmentEventEntries(enrichment),
    ...jobRows.eventEntries,
  ]
    .filter((entry) => entry.at.length > 0)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

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
      {/* ---------------------------------------------------------------- 1. HEADER -- */}
      <PageHead
        subtitle={
          <Row wrap>
            <span>{lead.jobTitle ?? 'No title'}</span>
            <span>· {lead.companyName ?? 'No company'}</span>
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
            {lead.companyDomain !== null && (
              <a
                className="nx-btn nx-btn--secondary"
                href={`https://${lead.companyDomain}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open site
              </a>
            )}
          </Row>
        }
      >
        {lead.personName}
      </PageHead>

      {lead.isDnc && (
        <Alert accent="red" title="Do Not Contact" role="alert">
          This person is suppressed on every outreach channel. Do not attempt outreach from another
          account or channel.
        </Alert>
      )}

      {missingEnrichmentRow && (
        <Alert accent="amber" role="alert" title="This lead has no enrichment row">
          Every lead is supposed to get a `lead_enrichment` row from the insert trigger (§14.3), so its
          absence is a defect rather than a state. The lead is being read as Minimal at 0%, exactly as
          the Leads table reads it.
        </Alert>
      )}

      <div style={{ height: 'var(--nx-space-lg)' }} />

      {/*
        §69.2 — both states side by side, without implying a contradiction: the sales state is where
        the conversation is, the enrichment state is how much is known. They are separate columns in
        the database and separate chips here.
      */}
      <Card
        title="Intelligence"
        actions={
          <Row wrap>
            <Chip accent={enrichmentStateAccent(String(enrichmentState))} dataState={String(enrichmentState)}>
              enrichment: {enrichmentStateLabel(String(enrichmentState))}
            </Chip>
            <Chip accent="neutral">sales: {lead.status.replace(/_/g, ' ')}</Chip>
            {/*
              §29.3 — the stored score is recomputed with every fact change. If the read model's own
              derivation disagrees with the stored column, that disagreement is a fact about the row
              and is shown with both numbers rather than hidden.
            */}
            {scoreDisagrees && (
              <Chip
                accent="amber"
                title={`stored ${String(enrichment.completenessScore)}% · derived from facts ${String(
                  intelligence?.completenessScore ?? 0,
                )}%`}
              >
                score needs recompute
              </Chip>
            )}
            {enrichment.lastErrorCode !== null && <Chip accent="red">{enrichment.lastErrorCode}</Chip>}
            {canEnrich && (
              <RecomputeEnrichmentButton
                businessSlug={business.key}
                businessId={business.id}
                leadId={lead.id}
              />
            )}
          </Row>
        }
      >
        <Stack>
          <IntelligenceMeter score={completenessScore} missingFields={missingFields} />

          <Grid cols={3}>
            <Stack size="sm">
              <span className="nx-overline">ICP &amp; intent</span>
              <Row wrap>
                {lead.primaryIcpName === null ? (
                  <Chip accent="amber">unmatched</Chip>
                ) : (
                  <Chip accent="indigo">{lead.primaryIcpName}</Chip>
                )}
                {bestMatch?.matchScore != null && <Chip>fit {String(bestMatch.matchScore)}</Chip>}
              </Row>
              <span className="nx-hint">
                {bestMatch?.reason ?? 'No qualification reason is recorded for this lead yet.'}
              </span>
            </Stack>

            <Stack size="sm">
              <span className="nx-overline">Available channels</span>
              {availableChannels.length === 0 ? (
                <span className="nx-hint">
                  No channel is available yet: a channel needs an account here and a contact point on
                  the person.
                </span>
              ) : (
                <Row wrap>
                  {availableChannels.map((channel) => (
                    <Chip key={channel} accent="cyan">
                      {outreachChannelLabel(channel)}
                    </Chip>
                  ))}
                </Row>
              )}
              <span className="nx-hint">
                The discovery source ({discoverySourceLabel(discoverySource)}) never restricts these;
                see the outreach panel below.
              </span>
            </Stack>

            <Stack size="sm">
              <span className="nx-overline">Owner &amp; sender</span>
              <span>{lead.ownerName ?? 'Unassigned'}</span>
              <span className="nx-hint">LinkedIn sender: {lead.identityName ?? 'not bound'}</span>
              <span className="nx-hint">Added {lead.createdAt?.slice(0, 10) ?? '—'}</span>
            </Stack>
          </Grid>

          {/* §67.2/§39 — enrichment never feels synchronous. */}
          <div>
            <span className="nx-overline">Processing steps</span>
            <ProcessingStepsIndicator steps={processing} />
          </div>
        </Stack>
      </Card>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      {/* ------------------------------------------------- 2. AI OPPORTUNITY BRIEF -- */}
      <LeadIntelligenceBrief
        brief={brief}
        evidence={evidenceEntries}
        refreshAction={
          canCreateJobs ? (
            <RefreshContextButton
              businessSlug={business.key}
              businessId={business.id}
              leadId={lead.id}
            />
          ) : undefined
        }
      />

      <div style={{ height: 'var(--nx-space-lg)' }} />

      {/* ---------------------------------------- 3. PERSON / COMPANY / CONTACTS -- */}
      <Grid cols={3}>
        <Card title="Person">
          <dl className="nx-facts">
            <div>
              <dt>Full name</dt>
              <dd>{lead.personName}</dd>
            </div>
            <div>
              <dt>Job title</dt>
              <dd>{lead.jobTitle ?? 'not recorded'}</dd>
            </div>
            <div>
              <dt>Headline</dt>
              <dd>{lead.headline ?? 'not recorded'}</dd>
            </div>
            <div>
              <dt>Location</dt>
              <dd>{lead.location ?? 'not recorded'}</dd>
            </div>
            <div>
              <dt>LinkedIn</dt>
              <dd>
                {lead.linkedinUrl === null ? (
                  'not recorded'
                ) : (
                  <a href={lead.linkedinUrl} target="_blank" rel="noreferrer noopener">
                    {lead.linkedinUrl}
                  </a>
                )}
              </dd>
            </div>
          </dl>
        </Card>

        <Card title="Company">
          <dl className="nx-facts">
            <div>
              <dt>Name</dt>
              <dd>{lead.companyName ?? 'not recorded'}</dd>
            </div>
            <div>
              <dt>Domain</dt>
              <dd>{lead.companyDomain ?? 'not recorded'}</dd>
            </div>
            <div>
              <dt>Industry</dt>
              <dd>{lead.companyIndustry ?? 'not recorded'}</dd>
            </div>
            <div>
              <dt>Research snapshot</dt>
              <dd>{facts?.companyResearch === true ? 'recorded' : 'not recorded'}</dd>
            </div>
            <div>
              <dt>Signals</dt>
              <dd>{String(briefSignals.length)} active</dd>
            </div>
          </dl>
        </Card>

        <Card
          title="Contacts"
          actions={
            <span className="nx-hint">confirmed values are never overwritten by an extraction</span>
          }
        >
          <DataTable
            columns={[
              {
                key: 'kind',
                header: 'Kind',
                cell: (point: ContactPointView) => <Chip accent="indigo">{point.kind}</Chip>,
              },
              {
                key: 'value',
                header: 'Value',
                cell: (point: ContactPointView) => (
                  <span className="nx-table__mono">{point.value}</span>
                ),
              },
              {
                key: 'state',
                header: 'State',
                cell: (point: ContactPointView) => {
                  const provenance = contactPointProvenanceLabel(point);
                  return (
                    <Chip
                      accent={provenance === 'confirmed' ? 'green' : provenance === 'imported' ? 'amber' : 'cyan'}
                      dataState={provenance}
                    >
                      {provenance}
                    </Chip>
                  );
                },
              },
              {
                key: 'confidence',
                header: 'Confidence',
                numeric: true,
                cell: (point: ContactPointView) => point.confidence.toFixed(2),
              },
              {
                key: 'source',
                header: 'Source',
                cell: (point: ContactPointView) => point.source ?? 'not recorded',
              },
            ]}
            rows={enrichment.contactPoints}
            rowKey={(point) => `${point.kind}:${point.value}`}
            caption="Contact points for this person, with their confirmation state"
            empty={
              <span className="nx-hint">
                No contact point is recorded. A person with no contact point has no reachable channel.
              </span>
            }
          />
        </Card>
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      {/* ------------------------------------------------- 4. ENRICHMENT WORKSPACE -- */}
      <div id="enrichment" />
      {enrichmentIsIncomplete(String(enrichmentState)) ? (
        <LeadEnrichmentWorkspace
          businessSlug={business.key}
          businessId={business.id}
          leadId={lead.id}
          enrichmentState={String(enrichmentState)}
          completenessScore={completenessScore}
          missingFields={missingFields}
          knownFields={knownFields}
          searchLinks={searchLinkList}
          unavailableLinks={unavailableLinks}
          defaultLinkedinUrl={lead.linkedinUrl ?? ''}
          steps={processing}
          canEnrich={canEnrich}
          canCreateJobs={canCreateJobs}
          jobTypes={AGENT_JOB_TYPES}
          openJobs={jobRows.jobs
            .filter((job) => job.status === 'OPEN' || job.status === 'RUNNING' || job.status === 'WAITING_AI')
            .map((job) => ({ jobType: job.jobType, status: job.status }))}
          lastErrorCode={enrichment.lastErrorCode}
        />
      ) : (
        <Card
          title="Enrichment"
          actions={
            <Row wrap>
              <Chip accent={enrichmentStateAccent(String(enrichmentState))}>
                {enrichmentStateLabel(String(enrichmentState))}
              </Chip>
              <span className="nx-hint">{intelligenceLabel(completenessScore)}</span>
            </Row>
          }
        >
          <Stack>
            <p className="nx-hint">
              {missingFieldsText(missingFields) === null
                ? 'Every completeness component is present. Re-enrichment stays available below.'
                : `Still to fill: ${missingFieldsText(missingFields)}.`}
            </p>
            <details className="nx-workspace__more">
              <summary>Enrich anyway</summary>
              <div style={{ marginTop: 'var(--nx-space-sm)' }}>
                <LeadEnrichmentWorkspace
                  businessSlug={business.key}
                  businessId={business.id}
                  leadId={lead.id}
                  enrichmentState={String(enrichmentState)}
                  completenessScore={completenessScore}
                  missingFields={missingFields}
                  knownFields={knownFields}
                  searchLinks={searchLinkList}
                  unavailableLinks={unavailableLinks}
                  defaultLinkedinUrl={lead.linkedinUrl ?? ''}
                  steps={processing}
                  canEnrich={canEnrich}
                  canCreateJobs={canCreateJobs}
                  jobTypes={AGENT_JOB_TYPES}
                  openJobs={[]}
                  lastErrorCode={enrichment.lastErrorCode}
                />
              </div>
            </details>
          </Stack>
        </Card>
      )}

      <div style={{ height: 'var(--nx-space-lg)' }} />

      {/* --------------------------------------------- 5. SOURCE / PROVENANCE -- */}
      <Card
        title={'Source & provenance'}
        actions={<Chip accent="indigo">{discoverySourceLabel(discoverySource)}</Chip>}
      >
        <Stack>
          <dl className="nx-facts">
            <div>
              <dt>Source type</dt>
              <dd>{lead.sourceType?.replace(/_/g, ' ') ?? 'not recorded'}</dd>
            </div>
            <div>
              <dt>Source URL</dt>
              <dd>
                {lead.sourceUrl === null ? (
                  'not recorded'
                ) : (
                  <a href={lead.sourceUrl} target="_blank" rel="noreferrer noopener">
                    {lead.sourceUrl}
                  </a>
                )}
              </dd>
            </div>
            <div>
              <dt>Profile source</dt>
              <dd>{enrichment.profileSourceType ?? 'not recorded'}</dd>
            </div>
            <div>
              <dt>Profile source URL</dt>
              <dd>
                {enrichment.profileSourceUrl === null ? (
                  'not recorded'
                ) : (
                  <a href={enrichment.profileSourceUrl} target="_blank" rel="noreferrer noopener">
                    {enrichment.profileSourceUrl}
                  </a>
                )}
              </dd>
            </div>
            <div>
              <dt>Observed</dt>
              <dd className="nx-table__mono">{formatStamp(enrichment.profileObservedAt)}</dd>
            </div>
            <div>
              <dt>Content hash</dt>
              <dd className="nx-table__mono">{enrichment.profileContentHash ?? 'not recorded'}</dd>
            </div>
            <div>
              <dt>Collector agent</dt>
              <dd>{enrichment.collectorAgent ?? 'not recorded'}</dd>
            </div>
            <div>
              <dt>Agent job</dt>
              <dd className="nx-table__mono">
                {enrichment.profileAgentJobId ?? enrichment.sourceAgentJobId ?? 'not recorded'}
              </dd>
            </div>
            <div>
              <dt>Prompt version</dt>
              <dd>
                {pack?.promptKey == null
                  ? (enrichment.promptKey ?? 'not recorded')
                  : `${pack.promptKey}${pack.promptVersion === null ? '' : ` v${String(pack.promptVersion)}`}`}
              </dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{pack?.model ?? enrichment.model ?? 'not recorded'}</dd>
            </div>
            <div>
              <dt>Extracted</dt>
              <dd className="nx-table__mono">{formatStamp(enrichment.extractedAt)}</dd>
            </div>
            <div>
              <dt>Last profile enrichment</dt>
              <dd className="nx-table__mono">{formatStamp(enrichment.lastProfileEnrichmentAt)}</dd>
            </div>
            <div>
              <dt>Last company enrichment</dt>
              <dd className="nx-table__mono">{formatStamp(enrichment.lastCompanyEnrichmentAt)}</dd>
            </div>
            <div>
              <dt>Last context build</dt>
              <dd className="nx-table__mono">{formatStamp(enrichment.lastContextBuildAt)}</dd>
            </div>
          </dl>

          {evidenceRows.research.length > 0 && (
            <div>
              <span className="nx-overline">Company research summaries</span>
              <ul className="nx-brief__signals">
                {evidenceRows.research.map((snapshot) => (
                  <li key={snapshot.id}>
                    <Row wrap between>
                      <span>{snapshot.summary ?? 'Summary not recorded'}</span>
                      <Row wrap>
                        {snapshot.model !== null && <Chip>{snapshot.model}</Chip>}
                        <span className="nx-hint nx-table__mono">
                          {snapshot.createdAt.slice(0, 16).replace('T', ' ')}
                        </span>
                      </Row>
                    </Row>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="nx-hint">
            Only this metadata is kept. The raw body a fact was extracted from is deleted once the
            structured commit is verified, so there is nothing to re-display.
          </p>
        </Stack>
      </Card>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      {/* ------------------------------------------------------ 6. OUTREACH -- */}
      <div id="outreach" />
      <LeadChannelOutreach
        rows={outreachRows}
        discoverySource={discoverySourceLabel(discoverySource)}
        isDnc={lead.isDnc}
      />

      <div style={{ height: 'var(--nx-space-lg)' }} />

      {/* ------------------------------------------------------- 7. AI DRAFT -- */}
      {dueMessage !== null && (
        <>
          <Card
            title={
              dueIdentityChannel === null
                ? 'AI draft'
                : `AI draft · ${outreachChannelLabel(dueIdentityChannel)}`
            }
            actions={
              <Row wrap>
                <MessageStateChip state={dueMessage.state} />
                {dueMessage.dueAt !== null && (
                  <span className="nx-hint">due {dueMessage.dueAt.slice(0, 16)}</span>
                )}
              </Row>
            }
          >
            <Stack>
              <Row wrap>
                <Chip accent="cyan">
                  {dueMessage.stepOrder <= 1 ? 'Message 1' : `Follow-up ${String(dueMessage.stepOrder - 1)}`}
                </Chip>
                <span className="nx-hint">
                  Next action {lead.nextActionAt === null ? 'not scheduled' : lead.nextActionAt.slice(0, 16)}
                </span>
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
                <>
                  {/*
                    The AI drafting control invokes the real `draftMessageAction` for this instance. A
                    stored draft becomes the message's current version, so it reappears above in the
                    MessageBlock on the next render; the control previews the same body and carries the
                    accept/regenerate choice.
                  */}
                  {canDraftWithAi && (
                    <AiDraftControl
                      leadId={lead.id}
                      businessSlug={business.key}
                      businessId={business.id}
                      messageInstanceId={dueMessage.id}
                      messageVersionId={dueMessage.currentVersionId}
                      hasStoredContent={dueMessage.content !== null}
                    />
                  )}
                  <MessageSentAction
                    leadId={lead.id}
                    businessSlug={business.key}
                    messageInstanceId={dueMessage.id}
                    defaultIdentityId={defaultIdentityId}
                  />
                </>
              )}
            </Stack>
          </Card>

          <div style={{ height: 'var(--nx-space-lg)' }} />
        </>
      )}

      {/* -------------------------------- the V1 control surfaces, unchanged -- */}
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
          <Card
            title="Sequence"
            actions={
              sequence.state === null ? (
                <Chip accent="neutral">not enrolled</Chip>
              ) : (
                <Chip accent={sequence.state === 'active' ? 'green' : 'amber'}>
                  {sequence.state.replace(/_/g, ' ')}
                </Chip>
              )
            }
          >
            <Stack size="sm">
              <Row between>
                <span className="nx-hint">Sequence</span>
                <span>{sequence.sequenceName ?? 'None'}</span>
              </Row>
              {steps.length === 0 ? (
                <span className="nx-hint">No message has been scheduled for this lead yet.</span>
              ) : (
                steps.map((step) => (
                  <Row key={step.id} between>
                    <span>{step.label}</span>
                    <Chip accent={stepAccent(step.state)}>{step.state}</Chip>
                  </Row>
                ))
              )}
              {sequence.reactivationDueAt !== null && (
                <Row between>
                  <span className="nx-hint">Reactivation due</span>
                  <span className="nx-table__mono">{sequence.reactivationDueAt.slice(0, 10)}</span>
                </Row>
              )}
              <p className="nx-hint">
                Sent messages stay immutable. Replies pause the remaining sequence.
              </p>
            </Stack>
          </Card>

          {canCreateJobs && (
            <details className="nx-workspace__more">
              <summary>Create a specific agent job</summary>
              <div style={{ marginTop: 'var(--nx-space-sm)' }}>
                <CreateAgentJobForm
                  businessSlug={business.key}
                  businessId={business.id}
                  leadId={lead.id}
                  jobTypes={AGENT_JOB_TYPES}
                />
              </div>
            </details>
          )}

          {jobRows.jobs.length > 0 && (
            <Card title="Agent jobs" actions={<Chip>{jobRows.jobs.length} recorded</Chip>}>
              <DataTable
                columns={[
                  {
                    key: 'type',
                    header: 'Type',
                    cell: (job: JobRow) => job.jobType.replace(/_/g, ' ').toLowerCase(),
                  },
                  {
                    key: 'status',
                    header: 'Status',
                    cell: (job: JobRow) => (
                      <Chip
                        accent={
                          job.status === 'COMPLETE'
                            ? 'green'
                            : job.status === 'FAILED'
                              ? 'red'
                              : job.status === 'CANCELLED'
                                ? 'neutral'
                                : 'amber'
                        }
                      >
                        {job.status.replace(/_/g, ' ')}
                      </Chip>
                    ),
                  },
                  {
                    key: 'reason',
                    header: 'Reason',
                    cell: (job: JobRow) => (
                      <span className="nx-hint" title={job.dedupeKey ?? undefined}>
                        {job.reason ?? 'not recorded'}
                      </span>
                    ),
                  },
                  {
                    key: 'attempts',
                    header: 'Attempts',
                    numeric: true,
                    cell: (job: JobRow) => `${String(job.attemptCount)}/${String(job.maxAttempts)}`,
                  },
                  {
                    key: 'error',
                    header: 'Last error',
                    cell: (job: JobRow) => job.lastErrorCode ?? '—',
                  },
                  {
                    key: 'updated',
                    header: 'Updated',
                    cell: (job: JobRow) => (
                      <span className="nx-table__mono">{job.updatedAt.slice(0, 16).replace('T', ' ')}</span>
                    ),
                  },
                ]}
                rows={jobRows.jobs}
                rowKey={(job) => job.id}
                caption="Agent jobs recorded for this lead"
                empty={<span className="nx-hint">No agent job has been created for this lead.</span>}
              />
            </Card>
          )}
        </Stack>

        <Stack size="lg">
          {/*
            spec `identity_model.duplicate_outreach_warning`: warn when this lead was
            already contacted from a different identity than the one selected.
          */}
          <DuplicateCheck lead={lead} identities={identities} />

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
        </Stack>
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      {/* ------------------------------------------------------- 8. TIMELINE -- */}
      <Card
        title="Timeline"
        actions={
          <Row wrap>
            <Chip accent="neutral">{mergedTimeline.length} events</Chip>
            {outcomeChip}
          </Row>
        }
      >
        {mergedTimeline.length === 0 ? (
          <span className="nx-hint">No history recorded for this lead yet.</span>
        ) : (
          <div style={{ maxHeight: '32rem', overflowY: 'auto' }}>
            <Timeline label="Lead history">
              {mergedTimeline.map((entry) => (
                <TimelineItem key={entry.id} dot={dotFor(entry)} meta={metaFor(entry)}>
                  {entry.body ?? entry.summary ?? ''}
                </TimelineItem>
              ))}
            </Timeline>
          </div>
        )}
      </Card>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      {/* ---------------------------------------------------------- 9. TASKS -- */}
      <Card title="Tasks" actions={<Chip>{tasks.length} open</Chip>}>
        <DataTable
          columns={taskColumns}
          rows={tasks}
          rowKey={(task) => task.id}
          caption="Open tasks for this lead"
          empty={<span className="nx-hint">No open tasks.</span>}
        />
      </Card>
    </>
  );
}

/* ------------------------------------------------------------------ reads -- */

interface EnrichmentBundle {
  readonly status: string | null;
  readonly completenessScore: number;
  readonly missingFields: readonly string[];
  readonly lastErrorCode: string | null;
  readonly lastProfileEnrichmentAt: string | null;
  readonly lastCompanyEnrichmentAt: string | null;
  readonly lastContextBuildAt: string | null;
  readonly profileSourceType: string | null;
  readonly profileSourceUrl: string | null;
  readonly profileObservedAt: string | null;
  readonly profileContentHash: string | null;
  readonly profileAgentJobId: string | null;
  readonly collectorAgent: string | null;
  readonly sourceAgentJobId: string | null;
  readonly promptKey: string | null;
  readonly model: string | null;
  readonly extractedAt: string | null;
  readonly contactPoints: readonly ContactPointView[];
}

/**
 * The enrichment row and the person's contact points, in one bounded read.
 *
 * A missing `lead_enrichment` row reads as MINIMAL with 0 (§68.2) rather than as an error: §14.3
 * makes the row impossible, so the tolerant reading is how a defect in that trigger shows up as a
 * visibly incomplete lead instead of a broken screen.
 */
async function loadEnrichmentBundle(
  actor: Parameters<typeof getLead>[0],
  leadId: string,
  personId: string,
  companyId: string | null,
): Promise<EnrichmentBundle> {
  return read(actor, async (sql) => {
    const enrichmentRow = await sql.query<Record<string, unknown>>(
      `select status, completeness_score, missing_fields, last_error_code,
              last_profile_enrichment_at, last_company_enrichment_at, last_context_build_at,
              profile_source_type, profile_source_url, profile_observed_at, profile_content_hash,
              profile_agent_job_id
         from public.lead_enrichment
        where lead_id = $1`,
      [leadId],
    );

    // The newest evidence metadata row carries the collector, prompt version and model that
    // produced the current facts. Only the §32.3 allow-list is selected — never `raw_text_or_json`.
    const evidenceRow = await sql.query<Record<string, unknown>>(
      `select collector_agent, agent_job_id, model, extracted_at, raw_content_hash, content_hash,
              prompt_version_id
         from public.source_evidence
        where lead_id = $1
           or ($2::uuid is not null and person_id = $2)
           or ($3::uuid is not null and company_id = $3)
        order by extracted_at desc nulls last, observed_at desc
        limit 1`,
      [leadId, personId, companyId],
    );

    const promptRow = await sql.query<Record<string, unknown>>(
      `select pv.key, pv.version
         from public.prompt_versions pv
        where pv.id = (select se.prompt_version_id from public.source_evidence se
                        where se.lead_id = $1
                        order by se.extracted_at desc nulls last, se.observed_at desc
                        limit 1)`,
      [leadId],
    );

    const contactRows = await sql.query<Record<string, unknown>>(
      `select kind, value, normalized_value, label, is_primary, confidence, source, source_url,
              observed_at, confirmed_by_user
         from public.person_contact_points
        where person_id = $1 and deleted_at is null
        order by is_primary desc, observed_at desc
        limit 50`,
      [personId],
    );

    const row = enrichmentRow.rows[0];
    const evidence = evidenceRow.rows[0];
    const prompt = promptRow.rows[0];

    return {
      status: row === undefined ? null : asString(row.status, 'MINIMAL'),
      completenessScore: row === undefined ? 0 : asNumber(row.completeness_score, 0),
      missingFields: row === undefined ? [] : asStringArray(row.missing_fields),
      lastErrorCode: row === undefined ? null : asOptionalString(row.last_error_code),
      lastProfileEnrichmentAt: row === undefined ? null : asIso(row.last_profile_enrichment_at),
      lastCompanyEnrichmentAt: row === undefined ? null : asIso(row.last_company_enrichment_at),
      lastContextBuildAt: row === undefined ? null : asIso(row.last_context_build_at),
      profileSourceType: row === undefined ? null : asOptionalString(row.profile_source_type),
      profileSourceUrl: row === undefined ? null : asOptionalString(row.profile_source_url),
      profileObservedAt: row === undefined ? null : asIso(row.profile_observed_at),
      profileContentHash: row === undefined ? null : asOptionalString(row.profile_content_hash),
      profileAgentJobId: row === undefined ? null : asOptionalString(row.profile_agent_job_id),
      collectorAgent: evidence === undefined ? null : asOptionalString(evidence.collector_agent),
      sourceAgentJobId: evidence === undefined ? null : asOptionalString(evidence.agent_job_id),
      promptKey:
        prompt === undefined
          ? null
          : `${asString(prompt.key)}${prompt.version === undefined ? '' : ` v${String(asNumber(prompt.version))}`}`,
      model: evidence === undefined ? null : asOptionalString(evidence.model),
      extractedAt: evidence === undefined ? null : asIso(evidence.extracted_at),
      contactPoints: contactRows.rows.map((contact) => ({
        kind: asString(contact.kind),
        value: asString(contact.value),
        isPrimary: contact.is_primary === true,
        confirmedByUser: contact.confirmed_by_user === true,
        confidence: asNumber(contact.confidence, 0.5),
        source: asOptionalString(contact.source),
        observedAt: asIso(contact.observed_at) ?? '',
      })),
    };
  });
}

interface EvidenceBundle {
  readonly signals: readonly {
    readonly id: string;
    readonly kind: string;
    readonly label: string | null;
    readonly detail: string | null;
    readonly polarity: 'positive' | 'negative' | 'neutral';
    readonly strength: number;
    readonly observedAt: string;
    readonly sourceUrl: string | null;
    readonly collectorAgent: string | null;
    readonly contentHash: string | null;
  }[];
  readonly evidence: readonly EvidenceEntry[];
  readonly research: readonly {
    readonly id: string;
    readonly summary: string | null;
    readonly model: string | null;
    readonly createdAt: string;
  }[];
  readonly pack: {
    readonly version: number;
    readonly createdAt: string;
    readonly model: string | null;
    readonly promptKey: string | null;
    readonly promptVersion: number | null;
    readonly pack: unknown;
    readonly sourceSummary: unknown;
  } | null;
}

/**
 * §54.1 — the evidence set: active signals, the `source_evidence` metadata those facts point at,
 * the committed research summaries and the AI run identifiers.
 *
 * Every field selected is on the §32.3 allow-list. `raw_text_or_json` and `raw_bytes` are never
 * selected, because a body that no longer exists cannot be displayed, and one that still exists
 * must not be (§54.3).
 */
async function loadEvidenceBundle(
  actor: Parameters<typeof getLead>[0],
  leadId: string,
  personId: string,
  companyId: string | null,
): Promise<EvidenceBundle> {
  return read(actor, async (sql) => {
    const signals = await sql.query<Record<string, unknown>>(
      `select s.id, s.kind, s.label, s.detail, s.polarity, s.strength, s.observed_at
         from public.signals s
        where s.is_active
          and (s.lead_id = $1 or s.person_id = $2 or ($3::uuid is not null and s.company_id = $3))
        order by s.observed_at desc
        limit 10`,
      [leadId, personId, companyId],
    );

    const evidenceRows = await sql.query<Record<string, unknown>>(
      `select id, source, source_url, observed_at, content_hash, raw_content_hash, collector_agent,
              agent_job_id, model, extracted_at
         from public.source_evidence
        where lead_id = $1
           or person_id = $2
           or ($3::uuid is not null and company_id = $3)
        order by extracted_at desc nulls last, observed_at desc
        limit 10`,
      [leadId, personId, companyId],
    );

    const research = await sql.query<Record<string, unknown>>(
      `select r.id, r.summary, r.model, r.created_at,
              pv.key as prompt_key, pv.version as prompt_version
         from public.research_snapshots r
         left join public.prompt_versions pv on pv.id = r.prompt_version_id
        where r.lead_id = $1 or r.person_id = $2 or ($3::uuid is not null and r.company_id = $3)
        order by r.created_at desc
        limit 5`,
      [leadId, personId, companyId],
    );

    const packRow = await sql.query<Record<string, unknown>>(
      `select p.version, p.created_at, p.model, p.pack, p.source_summary,
              pv.key as prompt_key, pv.version as prompt_version
         from public.ai_context_packs p
         left join public.prompt_versions pv on pv.id = p.prompt_version_id
        where p.lead_id = $1
        order by p.version desc
        limit 1`,
      [leadId],
    );

    const entries: EvidenceEntry[] = [];

    for (const signal of signals.rows) {
      entries.push({
        id: `signal:${asString(signal.id)}`,
        label: `Signal · ${asString(signal.kind).replace(/_/g, ' ')}`,
        sourceType: 'signal',
        sourceUrl: asOptionalString(signal.source_url),
        observedAt: asIso(signal.observed_at),
        contentHash: asOptionalString(signal.content_hash),
        collectorAgent: asOptionalString(signal.collector_agent),
        agentJobId: null,
        promptVersion: null,
        model: null,
        extractedAt: asIso(signal.observed_at),
      });
    }

    for (const row of evidenceRows.rows) {
      entries.push({
        id: `evidence:${asString(row.id)}`,
        label: `Evidence · ${asString(row.source, 'source')}`,
        sourceType: asOptionalString(row.source),
        sourceUrl: asOptionalString(row.source_url),
        observedAt: asIso(row.observed_at),
        contentHash: asOptionalString(row.raw_content_hash) ?? asOptionalString(row.content_hash),
        collectorAgent: asOptionalString(row.collector_agent),
        agentJobId: asOptionalString(row.agent_job_id),
        promptVersion: null,
        model: asOptionalString(row.model),
        extractedAt: asIso(row.extracted_at),
      });
    }

    for (const row of research.rows) {
      const key = asOptionalString(row.prompt_key);
      const version = row.prompt_version === null || row.prompt_version === undefined
        ? null
        : asNumber(row.prompt_version);
      entries.push({
        id: `research:${asString(row.id)}`,
        label: 'Company research',
        sourceType: 'research_snapshot',
        sourceUrl: null,
        observedAt: asIso(row.created_at),
        contentHash: null,
        collectorAgent: null,
        agentJobId: null,
        promptVersion: key === null ? null : `${key}${version === null ? '' : ` v${String(version)}`}`,
        model: asOptionalString(row.model),
        extractedAt: asIso(row.created_at),
      });
    }

    const pack = packRow.rows[0];

    return {
      signals: signals.rows.map((signal) => ({
        id: asString(signal.id),
        kind: asString(signal.kind),
        label: asOptionalString(signal.label),
        detail: asOptionalString(signal.detail),
        polarity:
          signal.polarity === 'positive' || signal.polarity === 'negative'
            ? signal.polarity
            : ('neutral' as const),
        strength: asNumber(signal.strength, 0),
        observedAt: asIso(signal.observed_at) ?? '',
        sourceUrl: asOptionalString(signal.source_url),
        collectorAgent: asOptionalString(signal.collector_agent),
        contentHash: asOptionalString(signal.content_hash),
      })),
      evidence: entries,
      research: research.rows.map((row) => ({
        id: asString(row.id),
        summary: asOptionalString(row.summary),
        model: asOptionalString(row.model),
        createdAt: asIso(row.created_at) ?? '',
      })),
      pack:
        pack === undefined
          ? null
          : {
              version: asNumber(pack.version, 1),
              createdAt: asIso(pack.created_at) ?? '',
              model: asOptionalString(pack.model),
              promptKey: asOptionalString(pack.prompt_key),
              promptVersion:
                pack.prompt_version === null || pack.prompt_version === undefined
                  ? null
                  : asNumber(pack.prompt_version),
              pack: pack.pack,
              sourceSummary: pack.source_summary,
            },
    };
  });
}

interface JobRow {
  readonly id: string;
  readonly jobType: string;
  readonly status: string;
  readonly priority: string;
  readonly reason: string | null;
  readonly dedupeKey: string | null;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly lastErrorCode: string | null;
  readonly updatedAt: string;
}

interface JobBundle {
  readonly jobs: readonly JobRow[];
  readonly eventEntries: readonly DetailTimelineEntry[];
  readonly accounts: readonly {
    readonly id: string;
    readonly channel: string;
    readonly displayName: string;
    readonly status: string;
  }[];
}

/**
 * The durable side of enrichment: the jobs for this lead, their append-only events and the
 * business's channel accounts.
 *
 * An event's `note` is short operator text by contract (§agent_job_events: "Raw evidence belongs in
 * `raw_staging`, which is deleted; a note here that quoted it would outlive the deletion policy"),
 * and it is rendered as the event body verbatim. Nothing here is a research dump.
 */
async function loadJobBundle(
  actor: Parameters<typeof getLead>[0],
  leadId: string,
  businessId: string,
): Promise<JobBundle> {
  return read(actor, async (sql) => {
    const jobs = await sql.query<Record<string, unknown>>(
      `select id, job_type, status, priority, reason, dedupe_key, attempt_count, max_attempts,
              last_error_code, created_at, updated_at, completed_at
         from public.agent_jobs
        where lead_id = $1
        order by created_at desc
        limit 20`,
      [leadId],
    );

    const events = await sql.query<Record<string, unknown>>(
      `select e.id, e.event_type, e.actor_type, e.agent_name, e.note, e.created_at, j.job_type
         from public.agent_job_events e
         join public.agent_jobs j on j.id = e.job_id
        where j.lead_id = $1
        order by e.created_at desc
        limit 40`,
      [leadId],
    );

    const accounts = await sql.query<Record<string, unknown>>(
      `select oi.id, oi.channel, oi.display_name, oi.status
         from public.outreach_identities oi
         join public.outreach_identity_business_access a on a.outreach_identity_id = oi.id
        where a.business_id = $1 and oi.deleted_at is null
        order by oi.channel, oi.display_name`,
      [businessId],
    );

    return {
      jobs: jobs.rows.map((job) => ({
        id: asString(job.id),
        jobType: asString(job.job_type, 'OTHER'),
        status: asString(job.status, 'OPEN'),
        priority: asString(job.priority, 'normal'),
        reason: asOptionalString(job.reason),
        dedupeKey: asOptionalString(job.dedupe_key),
        attemptCount: asNumber(job.attempt_count, 0),
        maxAttempts: asNumber(job.max_attempts, 3),
        lastErrorCode: asOptionalString(job.last_error_code),
        updatedAt: asIso(job.updated_at) ?? '',
      })),
      eventEntries: events.rows.map((event) => ({
        id: `job-event:${asString(event.id)}`,
        kind: 'agent_job',
        at: asIso(event.created_at) ?? '',
        actorName: asOptionalString(event.agent_name) ?? asOptionalString(event.actor_type),
        identityName: null,
        summary: `${asString(event.job_type, 'job').replace(/_/g, ' ').toLowerCase()} · ${asString(
          event.event_type,
        ).replace(/_/g, ' ')}`,
        body: asOptionalString(event.note),
        outcome: null,
        immutable: true,
      })),
      accounts: accounts.rows.map((account) => ({
        id: asString(account.id),
        channel: asString(account.channel, 'linkedin'),
        displayName: asString(account.display_name, 'account'),
        status: asString(account.status, 'active'),
      })),
    };
  });
}

/* ------------------------------------------------------------------ helpers -- */

/**
 * The timeline entry shape this screen renders: the V1 entries plus the enrichment and agent-job
 * kinds the V1.2 sections add. `TimelineEntry` is a subset, so no mapping table is needed for it.
 */
interface DetailTimelineEntry {
  readonly id: string;
  readonly kind: string;
  readonly at: string;
  readonly actorName: string | null;
  readonly identityName: string | null;
  readonly summary: string | null;
  readonly body: string | null;
  readonly outcome: string | null;
  readonly immutable: boolean;
}

/** The three enrichment timestamps as timeline events, newest first by the caller's sort. */
function enrichmentEventEntries(enrichment: EnrichmentBundle): readonly DetailTimelineEntry[] {
  const events: DetailTimelineEntry[] = [];
  if (enrichment.lastProfileEnrichmentAt !== null) {
    events.push({
      id: 'enrichment:profile',
      kind: 'enrichment',
      at: enrichment.lastProfileEnrichmentAt,
      actorName: enrichment.collectorAgent,
      identityName: null,
      summary: 'Profile enrichment committed',
      body:
        enrichment.profileContentHash === null
          ? null
          : `content hash ${enrichment.profileContentHash}`,
      outcome: null,
      immutable: true,
    });
  }
  if (enrichment.lastCompanyEnrichmentAt !== null) {
    events.push({
      id: 'enrichment:company',
      kind: 'enrichment',
      at: enrichment.lastCompanyEnrichmentAt,
      actorName: null,
      identityName: null,
      summary: 'Company research committed',
      body: null,
      outcome: null,
      immutable: true,
    });
  }
  if (enrichment.lastContextBuildAt !== null) {
    events.push({
      id: 'enrichment:context',
      kind: 'enrichment',
      at: enrichment.lastContextBuildAt,
      actorName: null,
      identityName: null,
      summary: 'AI context pack built',
      body: null,
      outcome: null,
      immutable: true,
    });
  }
  return events;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function formatStamp(value: string | null): string {
  return value === null ? 'not recorded' : value.slice(0, 19).replace('T', ' ');
}

/**
 * Colour for a step state.
 *
 * `CANCELLED` is rendered with its own accent so a cancelled step is visually distinct from one that
 * is still merely locked and waiting.
 */
function stepAccent(state: SequenceStep['state']): 'green' | 'amber' | 'neutral' | 'red' {
  switch (state) {
    case 'SENT':
      return 'green';
    case 'DYNAMIC':
      return 'amber';
    case 'CANCELLED':
      return 'red';
    case 'LOCKED':
      return 'neutral';
  }
}

function dotFor(entry: DetailTimelineEntry): 'outbound' | 'inbound' | 'task' | 'system' | 'danger' {
  switch (entry.kind) {
    case 'outbound':
      return 'outbound';
    case 'inbound':
      return 'inbound';
    case 'task':
    case 'agent_job':
      return 'task';
    default:
      return 'system';
  }
}

function metaFor(entry: DetailTimelineEntry): ReactNode {
  return (
    <Row wrap>
      <span>{entry.at.slice(0, 16).replace('T', ' ')}</span>
      <span>· {entry.kind.replace(/_/g, ' ')}</span>
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
