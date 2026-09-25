import type { ReactNode } from 'react';

import { SIGNAL_KINDS } from '@nexus/core';
import {
  Alert,
  Card,
  Chip,
  DataTable,
  Grid,
  PageHead,
  Row,
  Stack,
  Stat,
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
import {
  getIcp,
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
 * A12 — ICP Manager.
 *
 * Contract: "Company types, markets, buyers, signals, scoring, exclusions, primary ICP
 * rule, default sequence, routing."
 *
 * The screen is deliberately explicit about three invariants that are enforced in the
 * database rather than here: a lead has exactly one Primary ICP, a secondary match
 * never creates a duplicate lead, and changing the Primary ICP is an audited state
 * change. Scoring is rendered as editable configuration, never as a constant.
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

  const selectedIcpId = firstParam(query.icp);
  const selectedRuleId = firstParam(query.rule);

  const [icps, rules, sequences, owners, identities, selectedIcp, selectedRule] = await Promise.all([
    listIcps(context.viewer.actor, business.id),
    listScoringRules(context.viewer.actor, business.id),
    listSequenceOptions(context.viewer.actor, business.id),
    listOwnerOptions(context.viewer.actor, business.id),
    listIdentityOptions(context.viewer.actor, business.id),
    selectedIcpId === null ? Promise.resolve(null) : getIcp(context.viewer.actor, selectedIcpId),
    selectedRuleId === null ? Promise.resolve(null) : getScoringRule(context.viewer.actor, selectedRuleId),
  ]);

  const canManageIcp = context.permissions.has('icp.manage');
  const canManageScoring = context.permissions.has('scoring.manage');

  const ownerLabels = new Map(owners.map((owner) => [owner.value, owner.label]));
  const basePath = `/b/${business.key}/setup/icps`;

  const activeIcps = icps.filter((icp) => icp.isActive).length;
  const defaultIcp = icps.find((icp) => icp.isDefault) ?? null;
  const primaryLeadTotal = icps.reduce((sum, icp) => sum + icp.primaryLeadCount, 0);
  const activeRuleCount = rules.filter((rule) => rule.isActive).length;

  const icpColumns: readonly Column<Icp>[] = [
    {
      key: 'name',
      header: 'ICP',
      cell: (icp) => (
        <Stack size="sm">
          <Row wrap>
            <span>{icp.name}</span>
            {icp.isDefault && <Chip accent="indigo">business default</Chip>}
            {!icp.isActive && <Chip accent="neutral">inactive</Chip>}
          </Row>
          {icp.description !== null && <span className="nx-hint">{icp.description}</span>}
        </Stack>
      ),
    },
    {
      key: 'criteria',
      header: 'Company types · markets',
      cell: (icp) => (
        <Stack size="sm">
          <span>{summarize(icp.criteria.companyTypes)}</span>
          <span className="nx-hint">{summarize(icp.criteria.markets)}</span>
        </Stack>
      ),
    },
    {
      key: 'signals',
      header: 'Signals',
      cell: (icp) => {
        const signals = icp.criteria.requiredSignals ?? [];
        return signals.length === 0 ? (
          <span className="nx-hint">none chosen</span>
        ) : (
          <Row wrap>
            {signals.slice(0, 3).map((signal) => (
              <Chip key={signal} accent="cyan">
                {signal.replace(/_/g, ' ')}
              </Chip>
            ))}
            {signals.length > 3 && (
              <Chip accent="neutral">{`+${String(signals.length - 3)}`}</Chip>
            )}
          </Row>
        );
      },
    },
    {
      key: 'primary',
      header: 'Primary leads',
      numeric: true,
      cell: (icp) => icp.primaryLeadCount,
    },
    {
      key: 'secondary',
      header: 'Secondary matches',
      numeric: true,
      cell: (icp) => icp.secondaryMatchCount,
    },
    {
      key: 'sequence',
      header: 'Default sequence',
      cell: (icp) =>
        icp.defaultSequenceName === null ? (
          <span className="nx-hint">not set</span>
        ) : (
          <Chip accent="indigo">{icp.defaultSequenceName}</Chip>
        ),
    },
    {
      key: 'routing',
      header: 'Routing',
      cell: (icp) => (
        <Stack size="sm">
          <Chip accent="indigo">{icp.routing.priority ?? 'normal'}</Chip>
          <span className="nx-hint">
            {icp.routing.ownerUserId == null
              ? 'no owner'
              : (ownerLabels.get(icp.routing.ownerUserId) ?? 'owner')}
            {icp.routing.autoEnroll ? ' · auto-enroll' : ' · manual enroll'}
          </span>
        </Stack>
      ),
    },
    {
      key: 'actions',
      header: '',
      cell: (icp) => (
        <a className="nx-btn nx-btn--secondary nx-btn--sm" href={`${basePath}?icp=${icp.id}`}>
          Edit
        </a>
      ),
    },
  ];

  const ruleColumns: readonly Column<ScoringRule>[] = [
    {
      key: 'target',
      header: 'Applies to',
      cell: (rule) => (
        <Row wrap>
          <Chip accent={rule.targetType === 'global' ? 'neutral' : 'indigo'}>{rule.targetType}</Chip>
          <span>{rule.targetLabel}</span>
        </Row>
      ),
    },
    { key: 'signal', header: 'Signal', cell: (rule) => rule.signalKind.replace(/_/g, ' ') },
    {
      key: 'polarity',
      header: 'Polarity',
      cell: (rule) => (
        <Chip accent={rule.polarity === 'negative' ? 'red' : rule.polarity === 'positive' ? 'green' : 'neutral'}>
          {rule.polarity}
        </Chip>
      ),
    },
    {
      key: 'points',
      header: 'Points',
      numeric: true,
      cell: (rule) => (rule.points > 0 ? `+${String(rule.points)}` : String(rule.points)),
    },
    {
      key: 'label',
      header: 'Label',
      cell: (rule) => rule.label ?? <span className="nx-hint">—</span>,
    },
    {
      key: 'active',
      header: 'Active',
      cell: (rule) => <Chip accent={rule.isActive ? 'green' : 'neutral'}>{rule.isActive ? 'active' : 'inactive'}</Chip>,
    },
    {
      key: 'actions',
      header: '',
      cell: (rule) => (
        <Row>
          <a className="nx-btn nx-btn--secondary nx-btn--sm" href={`${basePath}?rule=${rule.id}`}>
            Edit
          </a>
          {canManageScoring && (
            <DeleteScoringRuleAction ruleId={rule.id} businessSlug={business.key} />
          )}
        </Row>
      ),
    },
  ];

  return (
    <>
      <PageHead
        subtitle={`${business.name} · company types, markets, buyers, signals, scoring and routing`}
        actions={
          <Row wrap>
            <Chip accent="indigo">configuration</Chip>
            {defaultIcp !== null && <Chip accent="green">{`default: ${defaultIcp.name}`}</Chip>}
          </Row>
        }
      >
        ICP Manager
      </PageHead>

      <Alert accent="indigo" title="Primary ICP rules">
        A lead has exactly one Primary ICP. A person may match several ICPs in the same business, but a
        secondary match never creates a duplicate lead. Changing a lead&apos;s Primary ICP is an
        audited state change, not a new lead. The numbers on this screen are configuration — scores
        are not hard-coded product constants.
      </Alert>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Grid cols={4}>
        <Stat value={icps.length} label="ICPs configured" meta={`${String(activeIcps)} active`} />
        <Stat
          value={defaultIcp === null ? '—' : defaultIcp.name}
          label="Business default ICP"
          meta={defaultIcp === null ? 'none set: new leads match by score only' : 'one default per business'}
        />
        <Stat value={primaryLeadTotal} label="Leads with a Primary ICP" meta="counted from lead records" />
        <Stat value={activeRuleCount} label="Active scoring rules" meta={`${String(rules.length)} configured`} />
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Card
        title="ICPs"
        actions={
          <Row>
            <Chip accent="indigo">{icps.length}</Chip>
            <a className="nx-btn nx-btn--ghost nx-btn--sm" href={basePath}>
              New ICP
            </a>
          </Row>
        }
      >
        <DataTable
          columns={icpColumns}
          rows={icps}
          rowKey={(icp) => icp.id}
          caption="Configured ideal customer profiles"
          empty={
            <span className="nx-hint">
              No ICPs yet. Add one to describe the company types, markets and buyers this business
              targets; leads are then matched and scored against it.
            </span>
          }
        />
      </Card>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Grid split>
        <Stack size="lg">
          {selectedIcp !== null ? (
            <Card
              title={`Edit ${selectedIcp.name}`}
              actions={<Chip accent="indigo">ICP</Chip>}
            >
              {canManageIcp ? (
                <>
                  <IcpForm
                    mode="edit"
                    businessSlug={business.key}
                    businessId={business.id}
                    sequences={sequences}
                    owners={owners}
                    identities={identities}
                    icp={selectedIcp}
                  />
                  <div style={{ height: 'var(--nx-space-lg)' }} />
                  <DeleteIcpAction
                    icpId={selectedIcp.id}
                    icpName={selectedIcp.name}
                    businessSlug={business.key}
                    primaryLeadCount={selectedIcp.primaryLeadCount}
                  />
                </>
              ) : (
                <span className="nx-hint">
                  You do not have the icp.manage permission, so this configuration is read-only for
                  you. The database refuses the write either way.
                </span>
              )}
            </Card>
          ) : (
            <Card title="New ICP" actions={<Chip accent="indigo">configuration</Chip>}>
              {canManageIcp ? (
                <IcpForm
                  mode="create"
                  businessSlug={business.key}
                  businessId={business.id}
                  sequences={sequences}
                  owners={owners}
                  identities={identities}
                />
              ) : (
                <span className="nx-hint">
                  You do not have the icp.manage permission, so you cannot add an ICP.
                </span>
              )}
            </Card>
          )}
        </Stack>

        <Stack size="lg">
          <Card title="What belongs in an ICP" actions={<Chip accent="cyan">guidance</Chip>}>
            <Stack size="sm">
              <p className="nx-hint">
                Company types and markets describe the shape of the account. Buyer titles describe who
                is worth contacting inside it. Signals are the evidence kinds that make a prospect
                worth contacting now — the same vocabulary the scoring rules below score.
              </p>
              <p className="nx-hint">
                Known signal kinds: {SIGNAL_KINDS.join(', ')}.
              </p>
              <p className="nx-hint">
                Exclusions are hard disqualifiers (recruitment intermediaries, wedding-only businesses,
                stale vacancies, wrong geography) and are best expressed as negative scoring rules so
                the reason a lead scored low stays visible.
              </p>
            </Stack>
          </Card>
        </Stack>
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Card
        title="Scoring rules"
        actions={
          <Row>
            <Chip accent="indigo">{rules.length}</Chip>
            <a className="nx-btn nx-btn--ghost nx-btn--sm" href={basePath}>
              Add rule
            </a>
          </Row>
        }
      >
        <DataTable
          columns={ruleColumns}
          rows={rules}
          rowKey={(rule) => rule.id}
          caption="Configured signal scoring rules"
          empty={
            <span className="nx-hint">
              No scoring rules yet. Add points per signal kind so matches can be ranked and explained.
            </span>
          }
        />
      </Card>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Grid split>
        <Stack size="lg">
          {selectedRule !== null ? (
            <Card title="Edit scoring rule" actions={<Chip accent="indigo">scoring</Chip>}>
              {canManageScoring ? (
                <ScoringRuleForm
                  mode="edit"
                  businessSlug={business.key}
                  businessId={business.id}
                  icps={icps.map((icp) => ({ value: icp.id, label: icp.name }))}
                  rule={selectedRule}
                />
              ) : (
                <span className="nx-hint">
                  You do not have the scoring.manage permission, so this rule is read-only for you.
                </span>
              )}
            </Card>
          ) : (
            <Card title="Add scoring rule" actions={<Chip accent="indigo">scoring</Chip>}>
              {canManageScoring ? (
                <ScoringRuleForm
                  mode="create"
                  businessSlug={business.key}
                  businessId={business.id}
                  icps={icps.map((icp) => ({ value: icp.id, label: icp.name }))}
                />
              ) : (
                <span className="nx-hint">
                  You do not have the scoring.manage permission, so you cannot add a rule.
                </span>
              )}
            </Card>
          )}
        </Stack>

        <Stack size="lg">
          <Card title="How scoring is applied" actions={<Chip accent="cyan">guidance</Chip>}>
            <Stack size="sm">
              <p className="nx-hint">
                Points are configuration, not product constants: they are rows in this table, so the
                numbers can change without a deploy. A rule can apply to every business, to this
                business, or to a single ICP.
              </p>
              <p className="nx-hint">
                An ICP&apos;s own score overrides are a delta on top of these rules — useful for the
                one signal that matters more for that segment, without changing it everywhere.
              </p>
              <p className="nx-hint">
                Negative points encode exclusions. Keeping them as rules (rather than as a plain
                disqualifier list) means a low score always has a stated reason attached to it.
              </p>
            </Stack>
          </Card>
        </Stack>
      </Grid>
    </>
  );
}

function firstParam(value: string | string[] | undefined): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0];
  return null;
}

function summarize(input: readonly string[] | null | undefined): string {
  const values = input ?? [];
  if (values.length === 0) return 'not specified';
  if (values.length <= 3) return values.join(', ');
  return `${values.slice(0, 3).join(', ')} +${String(values.length - 3)}`;
}
