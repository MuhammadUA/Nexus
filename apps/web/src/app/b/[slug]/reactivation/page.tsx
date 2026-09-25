import type { ReactNode } from 'react';

import {
  Alert,
  Card,
  Chip,
  DataTable,
  DueChip,
  EmptyState,
  Grid,
  LeadStatusChip,
  MessageBlock,
  PageHead,
  Row,
  Stack,
  Stat,
  type Column,
} from '@nexus/ui';
import { notFound } from 'next/navigation';

import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import { asIso, asNumber, asString, asStringOrNull, read } from '@/lib/repo/common';
import type { Row as SqlRow } from '@/lib/sql';
import { listReactivationCandidates, type ReactivationCandidate } from '@/lib/repo/sequence';
import { OpenReactivationAction } from '@/components/reactivation-actions';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly lead?: string;
}

interface PriorMessage {
  readonly id: string;
  readonly stepOrder: number;
  readonly stepKind: string;
  readonly content: string | null;
  readonly sentAt: string | null;
}

interface FreshSignal {
  readonly id: string;
  readonly kind: string;
  readonly polarity: string;
  readonly strength: number;
  readonly label: string | null;
  readonly detail: string | null;
  readonly observedAt: string | null;
}

interface DormancyRow {
  readonly state: string;
  readonly currentStepOrder: number;
  readonly dormancyDays: number;
  readonly reactivationDays: number;
  readonly reactivationDueAt: string | null;
  readonly dormantAt: string | null;
  readonly lastStepSentAt: string | null;
}

interface ReactivationContext {
  readonly dormancy: DormancyRow | null;
  readonly priorMessages: readonly PriorMessage[];
  readonly signals: readonly FreshSignal[];
  readonly replyOutcome: string | null;
}

/**
 * A09 - Reactivation.
 *
 * Contract: "Review dormant prospects after cooling period or fresh signal;
 * generate non-repetitive reactivation."
 *
 * spec `lead_lifecycle.reactivation` ("Prefer a fresh buying signal/new angle. Do
 * not blindly repeat the old sequence") and `reply_and_notes.dormant_reactivation`
 * ("Show previous outreach summary and fresh signal/why-now") are what this screen
 * exists to make impossible to get wrong: the prior messages are rendered verbatim
 * above the decision, the cooling period is shown with the configured review date,
 * and nothing here writes copy the operator could send unchanged.
 */
export default async function ReactivationPage({
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

  // The candidate list and the "open reactivation" write both come from the
  // existing sequences/leads repositories; only this view's history read is local.
  const candidates = await listReactivationCandidates(context.viewer.actor, business.id, 50);
  const selected =
    query.lead === undefined || query.lead.length === 0
      ? (candidates[0] ?? null)
      : (candidates.find((candidate) => candidate.leadId === query.lead) ?? null);

  const detail =
    selected === null ? null : await loadContext(context.viewer.actor, business.id, selected.leadId);

  const canReactivate = context.permissions.has('sequence.reactivate');
  const withPriorOutreach = candidates.filter((candidate) => candidate.lastStepOrder !== null).length;
  const dueNow = candidates.filter(
    (candidate) => candidate.reactivationDueAt !== null && new Date(candidate.reactivationDueAt) <= new Date(),
  );

  const columns: readonly Column<ReactivationCandidate>[] = [
    {
      key: 'person',
      header: 'Prospect',
      cell: (candidate) => (
        <Stack size="sm">
          <a className="nx-nav__item" style={{ padding: 0 }} href={`/b/${business.key}/leads/${candidate.leadId}`}>
            <strong>{candidate.personName}</strong>
          </a>
          <span className="nx-hint">{candidate.companyName ?? 'no company'}</span>
        </Stack>
      ),
    },
    {
      key: 'dormant',
      header: 'Dormant since',
      cell: (candidate) => (
        <Stack size="sm">
          <span className="nx-table__mono">{candidate.dormantAt?.slice(0, 10) ?? 'not recorded'}</span>
          {candidate.dormantAt !== null && (
            <span className="nx-hint">{daysSince(candidate.dormantAt)} days cooling</span>
          )}
        </Stack>
      ),
    },
    {
      key: 'review',
      header: 'Review due',
      cell: (candidate) => (
        <Stack size="sm">
          <DueChip
            dueAt={candidate.reactivationDueAt}
            overdue={
              candidate.reactivationDueAt !== null && new Date(candidate.reactivationDueAt) <= new Date()
            }
          />
          <span className="nx-hint">{candidate.reactivationDueAt?.slice(0, 10) ?? 'not scheduled'}</span>
        </Stack>
      ),
    },
    {
      key: 'prior',
      header: 'Prior outreach',
      cell: (candidate) => (
        <Stack size="sm">
          <Chip accent="indigo">{priorStepLabel(candidate.lastStepOrder)}</Chip>
          <span className="nx-hint">last sent {candidate.lastStepSentAt?.slice(0, 10) ?? 'never'}</span>
        </Stack>
      ),
    },
    {
      key: 'open',
      header: 'Review',
      cell: (candidate) => (
        <a
          className={
            selected?.leadId === candidate.leadId
              ? 'nx-btn nx-btn--primary nx-btn--sm'
              : 'nx-btn nx-btn--secondary nx-btn--sm'
          }
          href={`/b/${business.key}/reactivation?lead=${candidate.leadId}`}
        >
          {selected?.leadId === candidate.leadId ? 'Selected' : 'Open'}
        </a>
      ),
    },
  ];

  return (
    <>
      <PageHead
        subtitle={`Dormant prospects in ${business.name} whose cooling period is ending, or which carry a fresh signal. A reactivation must take a new angle - never a repeat of the sequence shown below.`}
        actions={
          <Row wrap>
            <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/leads?status=dormant`}>
              Dormant leads
            </a>
            <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/overview`}>
              Overview
            </a>
          </Row>
        }
      >
        Reactivation
      </PageHead>

      <Grid cols={4}>
        <Stat value={candidates.length} label="Awaiting review" meta="dormant or flagged" />
        <Stat value={dueNow.length} label="Cooling period complete" meta="ready to re-approach" />
        <Stat value={withPriorOutreach} label="With prior outreach" meta="sequence history exists" />
        <Stat
          value={candidates.length - withPriorOutreach}
          label="Never contacted"
          meta="nothing was ever sent"
        />
      </Grid>

      <div style={{ height: 'var(--nx-space-md)' }} />

      <Stack size="lg">
        <Card
          title="Dormant prospects"
          actions={<Chip accent="indigo">{candidates.length} awaiting review</Chip>}
        >
          <DataTable
            columns={columns}
            rows={candidates}
            rowKey={(candidate) => candidate.leadId}
            caption="Dormant prospects awaiting a reactivation decision"
            empty={
              <EmptyState
                title="Nothing is dormant right now"
                body="A lead reaches this screen once the configured cooling period elapses without a reply, or when it is explicitly flagged for reactivation."
                action={
                  <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/leads`}>
                    Open leads
                  </a>
                }
              />
            }
          />
        </Card>

        <Card
          title="Prior outreach and why now"
          actions={
            <Row wrap>
              {detail?.dormancy !== null && detail?.dormancy !== undefined && (
                <Chip
                  accent={detail.dormancy.state === 'reactivation_due' ? 'amber' : 'neutral'}
                  dataState={detail.dormancy.state}
                >
                  {detail.dormancy.state.replace(/_/g, ' ')}
                </Chip>
              )}
              {!canReactivate && <Chip accent="amber">read-only</Chip>}
            </Row>
          }
        >
          {!canReactivate && (
            <Alert accent="amber" title="Read-only">
              You can review dormant prospects but not open a reactivation. Ask an administrator for the
              sequence-reactivate permission.
            </Alert>
          )}

          {selected === null || detail === null ? (
            <span className="nx-hint">
              Select a prospect above to see exactly what was already sent before writing a new angle.
            </span>
          ) : (
            <Stack size="lg">
              <Row between wrap>
                <Row wrap>
                  <Chip accent="indigo">{selected.personName}</Chip>
                  <Chip>{selected.companyName ?? 'no company'}</Chip>
                  <LeadStatusChip
                    state={detail.dormancy?.state === 'reactivation_due' ? 'reactivation_due' : 'dormant'}
                  />
                </Row>
                <a className="nx-btn nx-btn--ghost nx-btn--sm" href={`/b/${business.key}/leads/${selected.leadId}`}>
                  Open lead
                </a>
              </Row>

              <Grid cols={3}>
                <Stat
                  value={detail.dormancy === null ? 'unknown' : String(detail.dormancy.dormancyDays)}
                  label="Days dormant"
                  meta={detail.dormancy?.dormantAt?.slice(0, 10) ?? 'not recorded'}
                />
                <Stat
                  value={detail.dormancy === null ? 'unknown' : String(detail.dormancy.reactivationDays)}
                  label="Cooling period (days)"
                  meta="business-configured, default 60"
                />
                <Stat
                  value={detail.dormancy === null ? 0 : detail.dormancy.currentStepOrder}
                  label="Sequence step reached"
                  meta={detail.dormancy?.lastStepSentAt?.slice(0, 10) ?? 'nothing sent'}
                />
              </Grid>

              {detail.replyOutcome !== null && (
                <Alert accent="cyan" title="Last recorded reply">
                  {detail.replyOutcome.replace(/_/g, ' ')}. The exact reply text is on the lead timeline. A reactivation
                  after a real reply needs a different reason to talk, not a repeat of the sequence.
                </Alert>
              )}

              <Card
                title="What was already sent"
                actions={<Chip accent="neutral">{detail.priorMessages.length} step(s)</Chip>}
              >
                {detail.priorMessages.length === 0 ? (
                  <span className="nx-hint">
                    No step was ever sent on this lead. The first approach is still the approach, so treat this as new
                    outreach rather than reactivation.
                  </span>
                ) : (
                  <Stack size="md">
                    {detail.priorMessages.map((message) => (
                      <MessageBlock
                        key={message.id}
                        direction="outbound"
                        immutable
                        meta={
                          <Row wrap>
                            <Chip accent="cyan">{priorStepLabel(message.stepOrder)}</Chip>
                            <span className="nx-hint">
                              sent {message.sentAt?.slice(0, 16).replace('T', ' ') ?? 'unknown'}
                            </span>
                            <Chip accent="green">immutable</Chip>
                          </Row>
                        }
                      >
                        {message.content ?? 'The sent content is no longer readable.'}
                      </MessageBlock>
                    ))}
                  </Stack>
                )}
              </Card>

              <Card
                title="Fresh signal / why now"
                actions={
                  <Chip accent={detail.signals.length > 0 ? 'green' : 'amber'}>
                    {detail.signals.length} signal(s)
                  </Chip>
                }
              >
                {detail.signals.length === 0 ? (
                  <Alert accent="amber" title="No fresh signal recorded">
                    spec `lead_lifecycle.reactivation` prefers a fresh buying signal or a new angle. Without one the
                    reactivation has to be justified by something that genuinely changed, never by re-sending the old
                    sequence.
                  </Alert>
                ) : (
                  <Stack size="sm">
                    {detail.signals.map((signal) => (
                      <Row key={signal.id} wrap>
                        <Chip accent={signal.polarity === 'negative' ? 'red' : 'green'}>
                          {signal.kind.replace(/_/g, ' ')}
                        </Chip>
                        <Chip accent="indigo">strength {signal.strength}</Chip>
                        <span>{signal.label ?? 'unlabelled signal'}</span>
                        <span className="nx-hint">observed {signal.observedAt?.slice(0, 10) ?? 'unknown'}</span>
                        {signal.detail !== null && <span className="nx-hint">{signal.detail}</span>}
                      </Row>
                    ))}
                  </Stack>
                )}
              </Card>

              <Alert accent="red" title="Do not repeat the previous sequence">
                The messages above are immutable history. A reactivation must lead with the new signal or a new angle,
                must not restate the earlier pitch, and must never go out while the person is suppressed. This screen
                makes that history impossible to miss; it deliberately does not write the copy.
              </Alert>

              {canReactivate && <OpenReactivationAction leadId={selected.leadId} businessSlug={business.key} />}
            </Stack>
          )}
        </Card>
      </Stack>
    </>
  );
}

function priorStepLabel(stepOrder: number | null): string {
  if (stepOrder === null || stepOrder === 0) return 'no steps sent';
  if (stepOrder === 1) return 'Message 1 sent';
  return `Follow-up ${String(stepOrder - 1)} sent`;
}

/**
 * Reads the history this screen exists to show.
 *
 * Kept in the page rather than a repository because it is specific to this view;
 * the reusable read (`listReactivationCandidates`) and the write
 * (`startReactivation`) live in the sequences and leads repositories and are
 * imported, never re-implemented.
 */
async function loadContext(
  actor: Parameters<typeof read>[0],
  businessId: string,
  leadId: string,
): Promise<ReactivationContext> {
  return read(actor, async (sql) => {
    // The cooling period is business-configurable (`dormant.reactivation_days`,
    // spec `tasks_and_my_day`), falling back to the global platform default.
    const dormancy = await sql.query<SqlRow>(
      `select e.lead_id, e.state, e.current_step_order, e.dormant_at, e.reactivation_due_at,
              e.updated_at,
              greatest(0, floor(extract(epoch from (now() - coalesce(e.dormant_at, e.updated_at))) / 86400))::int
                as dormancy_days,
              coalesce(
                (select (ps.value #>> '{}')::int from public.platform_settings ps
                  where ps.key = 'dormant.reactivation_days'
                    and (ps.business_id = $2 or ps.business_id is null)
                  order by ps.business_id nulls last
                  limit 1),
                60
              ) as reactivation_days,
              (select max(mi.sent_at) from public.message_instances mi
                where mi.lead_id = e.lead_id and mi.sent_at is not null) as last_step_sent_at
         from public.sequence_enrollments e
        where e.lead_id = $1
        order by e.created_at desc
        limit 1`,
      [leadId, businessId],
    );

    const messages = await sql.query<SqlRow>(
      `select m.id, m.step_order, m.step_kind, m.sent_at, mv.content
         from public.message_instances m
         left join public.message_versions mv on mv.id = m.current_version_id
        where m.lead_id = $1 and m.sent_at is not null
        order by m.step_order`,
      [leadId],
    );

    const signals = await sql.query<SqlRow>(
      `select s.id, s.kind, s.polarity, s.strength, s.label, s.detail, s.observed_at
         from public.signals s
        where s.is_active and s.lead_id = $1
        order by s.observed_at desc
        limit 10`,
      [leadId],
    );

    const outcome = await sql.query<SqlRow>(
      `select o.outcome from public.conversation_outcomes o
        where o.lead_id = $1
        order by o.created_at desc
        limit 1`,
      [leadId],
    );

    const dormancyRow = dormancy.rows[0];

    return {
      dormancy:
        dormancyRow === undefined
          ? null
          : {
              state: asString(dormancyRow.state, 'dormant'),
              currentStepOrder: asNumber(dormancyRow.current_step_order),
              dormancyDays: asNumber(dormancyRow.dormancy_days),
              reactivationDays: asNumber(dormancyRow.reactivation_days, 60),
              reactivationDueAt: asIso(dormancyRow.reactivation_due_at),
              dormantAt: asIso(dormancyRow.dormant_at),
              lastStepSentAt: asIso(dormancyRow.last_step_sent_at),
            },
      priorMessages: messages.rows.map((row: SqlRow) => ({
        id: asString(row.id),
        stepOrder: asNumber(row.step_order),
        stepKind: asString(row.step_kind, 'message'),
        content: asStringOrNull(row.content),
        sentAt: asIso(row.sent_at),
      })),
      signals: signals.rows.map((row: SqlRow) => ({
        id: asString(row.id),
        kind: asString(row.kind, 'custom'),
        polarity: asString(row.polarity, 'neutral'),
        strength: asNumber(row.strength),
        label: asStringOrNull(row.label),
        detail: asStringOrNull(row.detail),
        observedAt: asIso(row.observed_at),
      })),
      replyOutcome: outcome.rows[0] === undefined ? null : asString(outcome.rows[0].outcome),
    };
  });
}

function daysSince(iso: string): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}
