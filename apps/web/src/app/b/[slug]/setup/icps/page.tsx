import type { ReactNode } from 'react';

import {
  Alert,
  Card,
  Chip,
  DataTable,
  EmptyState,
  Grid,
  PageHead,
  Row,
  Stack,
  type Column,
} from '@nexus/ui';
import { notFound } from 'next/navigation';

import {
  DeleteIcpAction,
  DeleteScoringRuleAction,
  IcpForm,
  ScoringRuleForm,
} from '@/components/icp-forms';
import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import {
  getScoringRule,
  listIcps,
  listScoringRules,
  type Icp,
  type ScoringRule,
} from '@/lib/repo/icps';
import { listIdentityOptions, listOwnerOptions } from '@/lib/repo/leads';
import { listSequenceOptions } from '@/lib/repo/sequences';

export const dynamic = 'force-dynamic';

/**
 * A12 — ICP Manager (final Figma frame `4:176`).
 *
 * The frame's information architecture is a *short ICP list* plus a *full-width detail
 * panel* for one selected ICP, not a wide configuration table. The list carries the six
 * scan columns (ICP · company type · markets · buyers · top signals · sequence); the panel
 * carries everything that needs a sentence rather than a cell — positive scoring,
 * exclusions, the Primary ICP rule, the default sequence and the assignment/routing — and
 * the editors for both the ICP and its scoring rules.
 *
 * Two rules shape the composition:
 *
 *   1. Nothing the previous wide table showed is dropped. Every one of Signals, Primary
 *      leads, Secondary matches, Default sequence and Routing stays visible and editable:
 *      the first four also live in the panel footer, and all five are reachable through the
 *      reused `IcpForm` below the panel.
 *   2. The selection is a URL parameter (`?icp=<id>`), matching how the Leads screen models
 *      its filters, so a shared or refreshed link reopens the same panel. The default is the
 *      Primary ICP, then the first configured ICP — never an empty panel when ICPs exist.
 *
 * "Exactly one Primary ICP per business" is a database invariant: the partial unique index
 * `icps_default_business_key` (packages/db/migrations/0010_constraints_and_indexes.sql) puts
 * one row per business where `is_default and deleted_at is null`. `createIcp`/`updateIcp` in
 * `lib/repo/icps.ts` clear the previous default inside the same transaction, and the form
 * control is a Yes/No choice rather than a second "make primary" affordance, so the UI cannot
 * even express a second primary.
 */
export default async function IcpManagerPage({
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
  requireRouteAccess(context, { route: '/b/:businessSlug/setup/icps', businessId: business.id });

  const [icps, rules, sequences, owners, identities] = await Promise.all([
    listIcps(context.viewer.actor, business.id),
    listScoringRules(context.viewer.actor, business.id),
    listSequenceOptions(context.viewer.actor, business.id),
    listOwnerOptions(context.viewer.actor, business.id),
    listIdentityOptions(context.viewer.actor, business.id),
  ]);

  const canManageIcp = context.permissions.has('icp.manage');
  const canManageScoring = context.permissions.has('scoring.manage');

  const basePath = `/b/${business.key}/setup/icps`;
  const ownerLabels = new Map(owners.map((owner) => [owner.value, owner.label]));
  const identityLabels = new Map(identities.map((identity) => [identity.value, identity.label]));

  const defaultIcp = icps.find((icp) => icp.isDefault) ?? null;

  /**
   * A scoring rule can only be *edited* from the panel of the ICP it scores, so `?rule=` is
   * resolved first and, when it names an ICP of this business, it also decides the panel. A
   * global or business-scoped rule names no ICP and leaves the panel to `?icp=`.
   */
  const requestedRuleId = firstParam(query.rule);
  const requestedRule =
    requestedRuleId === null ? null : await getScoringRule(context.viewer.actor, requestedRuleId);
  const ruleOwnerIcpId =
    requestedRule !== null && requestedRule.targetType === 'icp' ? requestedRule.targetId : null;
  const requestedIcpId = ruleOwnerIcpId ?? firstParam(query.icp);

  // An ICP id that this business does not own falls back rather than 404s: the screen is the
  // business's configuration surface, and the selection is a view concern, not a resource.
  const selectedIcp = icps.find((icp) => icp.id === requestedIcpId) ?? defaultIcp ?? icps[0] ?? null;
  // Only a rule that this panel can actually explain is treated as selected, so a stale or
  // foreign `?rule=` cannot render an editor for a rule that belongs to another business.
  const selectedRule =
    requestedRule !== null &&
    (requestedRule.targetType !== 'icp' || requestedRule.targetId === selectedIcp?.id)
      ? requestedRule
      : null;

  // Ancestry is by scope, not by `targetLabel`: a rule whose ICP was archived keeps
  // `target_type = 'icp'` but joins to no row, and it must not be shown as applying here.
  const selectedRuleIds = new Set(selectedIcp === null ? [] : [selectedIcp.id]);
  const panelRules =
    selectedIcp === null
      ? []
      : rules.filter(
          (rule) =>
            rule.targetType !== 'icp' ||
            (rule.targetId !== null && selectedRuleIds.has(rule.targetId)),
        );
  const positiveRules = panelRules.filter((rule) => rule.polarity === 'positive');
  const exclusionRules = panelRules.filter((rule) => rule.polarity !== 'positive');

  const icpColumns: readonly Column<Icp>[] = [
    {
      key: 'name',
      header: 'ICP',
      // The name is the selection control: a real link, so the row works from a Server
      // Component and the panel a reader is looking at is the one in the URL.
      cell: (icp) => (
        <a
          className="nx-nav__item"
          style={{ padding: 0, fontWeight: icp.id === selectedIcp?.id ? 600 : 400 }}
          href={`${basePath}?icp=${icp.id}`}
          aria-current={icp.id === selectedIcp?.id ? 'true' : undefined}
        >
          {icp.name}
        </a>
      ),
    },
    {
      key: 'companyType',
      header: 'Company type',
      cell: (icp) => summarize(icp.criteria.companyTypes),
    },
    { key: 'markets', header: 'Markets', cell: (icp) => summarize(icp.criteria.markets) },
    { key: 'buyers', header: 'Buyers', cell: (icp) => summarize(icp.criteria.buyerTitles) },
    {
      key: 'signals',
      header: 'Top signals',
      cell: (icp) => {
        const signals = icp.criteria.requiredSignals ?? [];
        if (signals.length === 0) return <span className="nx-hint">none chosen</span>;
        const shown = signals.slice(0, 2).map((signal) => signal.replace(/_/g, ' '));
        return signals.length > 2
          ? `${shown.join(' · ')} +${String(signals.length - 2)}`
          : shown.join(' · ');
      },
    },
    {
      key: 'sequence',
      header: 'Sequence',
      cell: (icp) =>
        icp.defaultSequenceName === null ? (
          <span className="nx-hint">not set</span>
        ) : (
          <Chip accent="indigo">{icp.defaultSequenceName}</Chip>
        ),
    },
  ];

  const activeIcps = icps.filter((icp) => icp.isActive).length;
  const primaryLeadTotal = icps.reduce((sum, icp) => sum + icp.primaryLeadCount, 0);

  return (
    <>
      <PageHead
        subtitle="Define buyers, signals, scoring and routing"
        actions={
          <a className="nx-btn nx-btn--primary" href={basePath}>
            + New ICP
          </a>
        }
      >
        {`ICPs · ${business.name}`}
      </PageHead>

      <Card
        title="ICP list"
        flush
        actions={
          <Row wrap>
            <Chip accent="indigo">{`${String(icps.length)} configured`}</Chip>
            <Chip accent={activeIcps > 0 ? 'green' : 'neutral'}>{`${String(activeIcps)} active`}</Chip>
          </Row>
        }
      >
        <DataTable
          columns={icpColumns}
          rows={icps}
          rowKey={(icp) => icp.id}
          selectedKey={selectedIcp?.id ?? null}
          caption="Configured ideal customer profiles"
          empty={
            <EmptyState
              title="No ICPs yet"
              body="Add one to describe the company types, markets and buyers this business targets; leads are then matched and scored against it."
              action={
                canManageIcp ? (
                  <a className="nx-btn nx-btn--primary" href={basePath}>
                    + New ICP
                  </a>
                ) : undefined
              }
            />
          }
        />
      </Card>

      <div style={{ height: 'var(--nx-space-md)' }} />
      <p className="nx-hint">
        {`${String(icps.length)} ICP${icps.length === 1 ? '' : 's'} · ${String(primaryLeadTotal)} lead(s) hold a Primary ICP. Select a row to open its scoring and routing panel.`}
      </p>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      {selectedIcp === null ? (
        <Card title="Scoring & routing">
          <span className="nx-hint">
            There is no ICP to show yet. The detail panel appears once this business has at least
            one ICP.
          </span>
        </Card>
      ) : (
        <IcpDetailPanel
          icp={selectedIcp}
          icps={icps}
          businessSlug={business.key}
          businessId={business.id}
          basePath={basePath}
          sequences={sequences}
          owners={owners}
          identities={identities}
          ownerLabels={ownerLabels}
          identityLabels={identityLabels}
          positiveRules={positiveRules}
          exclusionRules={exclusionRules}
          panelRules={panelRules}
          selectedRule={selectedRule}
          canManageIcp={canManageIcp}
          canManageScoring={canManageScoring}
        />
      )}
    </>
  );
}

/** The full-width detail panel: scoring, exclusions, the Primary ICP rule and the editors. */
function IcpDetailPanel({
  icp,
  icps,
  businessSlug,
  businessId,
  basePath,
  sequences,
  owners,
  identities,
  ownerLabels,
  identityLabels,
  positiveRules,
  exclusionRules,
  panelRules,
  selectedRule,
  canManageIcp,
  canManageScoring,
}: {
  readonly icp: Icp;
  readonly icps: readonly Icp[];
  readonly businessSlug: string;
  readonly businessId: string;
  readonly basePath: string;
  readonly sequences: readonly { readonly value: string; readonly label: string }[];
  readonly owners: readonly { readonly value: string; readonly label: string }[];
  readonly identities: readonly { readonly value: string; readonly label: string }[];
  readonly ownerLabels: ReadonlyMap<string, string>;
  readonly identityLabels: ReadonlyMap<string, string>;
  readonly positiveRules: readonly ScoringRule[];
  readonly exclusionRules: readonly ScoringRule[];
  readonly panelRules: readonly ScoringRule[];
  readonly selectedRule: ScoringRule | null;
  readonly canManageIcp: boolean;
  readonly canManageScoring: boolean;
}): ReactNode {
  const scopeCounts = {
    global: panelRules.filter((rule) => rule.targetType === 'global').length,
    business: panelRules.filter((rule) => rule.targetType === 'business').length,
    icp: panelRules.filter((rule) => rule.targetType === 'icp').length,
  };

  return (
    <Card
      title={`${icp.name} · scoring & routing`}
      actions={
        <Row wrap>
          {icp.isDefault && <Chip accent="indigo">primary ICP</Chip>}
          <Chip accent={icp.isActive ? 'green' : 'neutral'}>{icp.isActive ? 'active' : 'inactive'}</Chip>
          <Chip accent="neutral">{`${String(panelRules.length)} scoring rule(s)`}</Chip>
        </Row>
      }
      footer={
        <div
          className="nx-stack nx-stack--sm"
          style={{ width: '100%', alignItems: 'stretch' }}
        >
          <FooterRow label="Primary ICP rule">
            <span>One Primary ICP per person per business. Secondary matches never create duplicate leads.</span>
            <span className="nx-hint">
              {icp.isDefault
                ? 'This ICP is the business primary. Choosing it on another ICP clears this one in the same transaction, and the partial unique index `icps_default_business_key` makes a second primary impossible.'
                : 'Marking another ICP primary is one yes/no field on its editor: the repository clears the previous default first, so a second primary cannot be stored.'}
            </span>
          </FooterRow>
          <FooterRow label="Default sequence">
            {icp.defaultSequenceName === null ? (
              <span className="nx-hint">not set — enrolling a match asks for a sequence</span>
            ) : (
              <Chip accent="indigo">{icp.defaultSequenceName}</Chip>
            )}
          </FooterRow>
          <FooterRow label="Assignment">
            <Row wrap>
              <Chip accent={icp.routing.priority === 'high' ? 'amber' : 'neutral'}>{`priority: ${icp.routing.priority ?? 'normal'}`}</Chip>
              <Chip accent="indigo">
                {icp.routing.ownerUserId == null
                  ? 'owner: unassigned'
                  : `owner: ${ownerLabels.get(icp.routing.ownerUserId) ?? 'assigned'}`}
              </Chip>
              <Chip accent="indigo">
                {icp.routing.outreachIdentityId == null
                  ? 'sender: not bound'
                  : `sender: ${identityLabels.get(icp.routing.outreachIdentityId) ?? 'bound'}`}
              </Chip>
              <Chip accent={icp.routing.autoEnroll === true ? 'green' : 'neutral'}>
                {icp.routing.autoEnroll === true ? 'auto-enroll on' : 'auto-enroll off'}
              </Chip>
            </Row>
          </FooterRow>
          <FooterRow label="Primary leads">
            <Row wrap>
              <Chip accent="cyan">{`${String(icp.primaryLeadCount)} primary lead(s)`}</Chip>
              <Chip accent="neutral">{`${String(icp.secondaryMatchCount)} secondary match(es)`}</Chip>
              <span className="nx-hint">
                Counted from lead records, and those leads keep this ICP in their history even after
                it is archived.
              </span>
            </Row>
          </FooterRow>
        </div>
      }
    >
      <Grid split>
        <Stack size="lg">
          <Stack size="sm">
            {icp.description !== null && <span>{icp.description}</span>}
            <span className="nx-hint">
              {`Company types: ${summarize(icp.criteria.companyTypes)} · Markets: ${summarize(icp.criteria.markets)} · Buyers: ${summarize(icp.criteria.buyerTitles)}`}
            </span>
            <span className="nx-hint">
              {`Company size: ${companySize(icp)} · Minimum match score: ${icp.scoringOverrides.minScore === null || icp.scoringOverrides.minScore === undefined ? 'not set' : String(icp.scoringOverrides.minScore)}`}
            </span>
            {icp.criteria.notes !== null && icp.criteria.notes !== undefined && (
              <span className="nx-hint">{icp.criteria.notes}</span>
            )}
          </Stack>

          <ScoreGroup
            title="Positive scoring"
            accent="green"
            rules={positiveRules}
            hint="Points added when a matching signal is observed."
          />
          <ScoreGroup
            title="Exclusions"
            accent="red"
            rules={exclusionRules}
            hint="Points removed, so a disqualifying signal always carries a stated reason."
          />

          <Stack size="sm">
            <span className="nx-overline">Required signals</span>
            <Row wrap>
              {(icp.criteria.requiredSignals ?? []).length === 0 ? (
                <span className="nx-hint">No signal kinds are required by this ICP yet.</span>
              ) : (
                (icp.criteria.requiredSignals ?? []).map((signal) => (
                  <Chip key={signal} accent="cyan">
                    {signal.replace(/_/g, ' ')}
                  </Chip>
                ))
              )}
            </Row>
            <span className="nx-hint">
              These are the evidence kinds this ICP treats as a match; the scoring rules above set
              what each one is worth.
            </span>
          </Stack>

          <Stack size="sm">
            <span className="nx-overline">ICP exclusions</span>
            <Row wrap>
              {(icp.criteria.exclusions ?? []).length === 0 ? (
                <span className="nx-hint">No hard disqualifiers recorded on this ICP.</span>
              ) : (
                (icp.criteria.exclusions ?? []).map((exclusion) => (
                  <Chip key={exclusion} accent="red">
                    {exclusion}
                  </Chip>
                ))
              )}
            </Row>
            <span className="nx-hint">
              Hard disqualifiers. Expressing the reason as a negative scoring rule above keeps the
              low score explainable.
            </span>
          </Stack>

          <Stack size="sm">
            <span className="nx-overline">Score overrides</span>
            <Row wrap>
              {Object.entries(icp.scoringOverrides.weights).length === 0 ? (
                <span className="nx-hint">
                  No per-ICP delta: every signal uses the configured rule values unchanged.
                </span>
              ) : (
                Object.entries(icp.scoringOverrides.weights).map(([kind, points]) => (
                  <Chip key={kind} accent={points < 0 ? 'red' : 'green'}>
                    {`${formatPoints(points)} ${kind.replace(/_/g, ' ')}`}
                  </Chip>
                ))
              )}
            </Row>
            <span className="nx-hint">
              {`Deltas applied only to ${icp.name}. ${String(scopeCounts.global)} global and ${String(scopeCounts.business)} business-scoped rule(s) also score this ICP; ${String(scopeCounts.icp)} rule(s) are scoped to it.`}
            </span>
          </Stack>
        </Stack>

        <Stack size="lg">
          {canManageIcp ? (
            <>
              <Card title={`Edit ${icp.name}`} actions={<Chip accent="indigo">ICP</Chip>}>
                <IcpForm
                  mode="edit"
                  businessSlug={businessSlug}
                  businessId={businessId}
                  sequences={sequences}
                  owners={owners}
                  identities={identities}
                  icp={icp}
                />
              </Card>
              <DeleteIcpAction
                icpId={icp.id}
                icpName={icp.name}
                businessSlug={businessSlug}
                primaryLeadCount={icp.primaryLeadCount}
              />
            </>
          ) : (
            <Alert accent="amber" title="Read-only">
              You do not have the icp.manage permission, so this configuration is read-only for you.
              The database refuses the write either way.
            </Alert>
          )}

          <Card
            title="Scoring rules for this panel"
            actions={<Chip accent="indigo">{panelRules.length}</Chip>}
            footer={
              canManageScoring ? (
                <a className="nx-btn nx-btn--secondary nx-btn--sm" href={basePath}>
                  Add scoring rule
                </a>
              ) : undefined
            }
          >
            <Stack size="sm">
              {panelRules.length === 0 ? (
                <span className="nx-hint">
                  No scoring rule applies to this ICP yet. Add one so a match can be ranked and its
                  score explained.
                </span>
              ) : (
                panelRules.map((rule) => (
                  <Row key={rule.id} between wrap>
                    <Row wrap>
                      <Chip
                        accent={
                          rule.polarity === 'positive'
                            ? 'green'
                            : rule.polarity === 'negative'
                              ? 'red'
                              : 'neutral'
                        }
                      >
                        {formatPoints(rule.points)}
                      </Chip>
                      <span>{rule.label ?? rule.signalKind.replace(/_/g, ' ')}</span>
                      <Chip accent="neutral">{`${rule.targetType} · ${rule.targetLabel}`}</Chip>
                      {!rule.isActive && <Chip accent="neutral">inactive</Chip>}
                    </Row>
                    <Row wrap>
                      <a
                        className="nx-btn nx-btn--secondary nx-btn--sm"
                        href={`${basePath}?rule=${rule.id}`}
                      >
                        Edit
                      </a>
                      {canManageScoring && (
                        <DeleteScoringRuleAction ruleId={rule.id} businessSlug={businessSlug} />
                      )}
                    </Row>
                  </Row>
                ))
              )}
            </Stack>
          </Card>

          {canManageScoring ? (
            selectedRule === null ? (
              <Card title="Add scoring rule" actions={<Chip accent="indigo">scoring</Chip>}>
                <ScoringRuleForm
                  mode="create"
                  businessSlug={businessSlug}
                  businessId={businessId}
                  icps={icps.map((option) => ({ value: option.id, label: option.name }))}
                />
              </Card>
            ) : (
              <Card title="Edit scoring rule" actions={<Chip accent="indigo">scoring</Chip>}>
                <ScoringRuleForm
                  mode="edit"
                  businessSlug={businessSlug}
                  businessId={businessId}
                  icps={icps.map((option) => ({ value: option.id, label: option.name }))}
                  rule={selectedRule}
                />
              </Card>
            )
          ) : (
            <Alert accent="amber" title="Scoring is read-only">
              You do not have the scoring.manage permission, so you cannot add or change a rule.
            </Alert>
          )}
        </Stack>
      </Grid>
    </Card>
  );
}

/** One scoring group: positive points, or exclusions (every non-positive polarity). */
function ScoreGroup({
  title,
  accent,
  rules,
  hint,
}: {
  readonly title: string;
  readonly accent: 'green' | 'red';
  readonly rules: readonly ScoringRule[];
  readonly hint: string;
}): ReactNode {
  return (
    <Stack size="sm">
      <span
        className="nx-overline"
        style={{ color: `var(--nx-accent-${accent}-fg)` }}
      >
        {title}
      </span>
      <Row wrap>
        {rules.length === 0 ? (
          <span className="nx-hint">None configured.</span>
        ) : (
          rules.map((rule) => (
            <Chip
              key={rule.id}
              accent={accent}
              title={`${rule.targetType}: ${rule.targetLabel}${rule.isActive ? '' : ' · inactive'}`}
            >
              {`${formatPoints(rule.points)} ${rule.label ?? rule.signalKind.replace(/_/g, ' ')}`}
            </Chip>
          ))
        )}
      </Row>
      <span className="nx-hint">{hint}</span>
    </Stack>
  );
}

function FooterRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <Row wrap style={{ alignItems: 'baseline', gap: 'var(--nx-space-md)' }}>
      <span className="nx-hint" style={{ minWidth: '11rem' }}>
        {label}
      </span>
      <Stack size="sm">{children}</Stack>
    </Row>
  );
}

function firstParam(value: string | string[] | undefined): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0];
  return null;
}

/** The signed value as the frame prints it: `+30`, `-20`, `0`. */
function formatPoints(points: number): string {
  return points > 0 ? `+${String(points)}` : String(points);
}

function summarize(input: readonly string[] | null | undefined): string {
  const values = input ?? [];
  if (values.length === 0) return 'not specified';
  if (values.length <= 3) return values.join(', ');
  return `${values.slice(0, 3).join(', ')} +${String(values.length - 3)}`;
}

function companySize(icp: Icp): string {
  const min = icp.criteria.companySizeMin;
  const max = icp.criteria.companySizeMax;
  if (min == null && max == null) return 'not specified';
  return `${min == null ? 'any' : String(min)}–${max == null ? 'any' : String(max)} headcount`;
}
