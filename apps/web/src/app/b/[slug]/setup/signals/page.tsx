import type { ReactNode } from 'react';

import { Alert, Card, Chip, DataTable, Grid, PageHead, Stat, type Column } from '@nexus/ui';
import { notFound } from 'next/navigation';

import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import { listIcps, listScoringRules } from '@/lib/repo/icps';
import type { ScoringRule } from '@/lib/icp-view';

export const dynamic = 'force-dynamic';

/**
 * A12 — Signals (the `SIGNALS` tab of Business Setup).
 *
 * The final Figma draws signals twice: as the "Signals" tab of Business Setup, and as the "Top
 * signals" column of the ICP list. spec `signals_and_scoring` puts the actual values in
 * `scoring_rules` — a signal kind, a polarity, and a signed point value that an ICP can override —
 * and A12's "Marketing Services · scoring & routing" panel shows exactly that: positive scoring,
 * exclusions, and the Primary ICP rule.
 *
 * This screen renders the real rules rather than a placeholder, because a Signals tab with no rules
 * would be an unwired surface pretending to be a feature.
 */
export default async function SignalsPage({
  params,
}: {
  readonly params: Promise<{ slug: string }>;
}): Promise<ReactNode> {
  const { slug } = await params;
  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);
  if (business === null) notFound();

  requireRouteAccess(context, { route: '/b/:businessSlug/setup/signals', businessId: business.id });

  const [rules, icps] = await Promise.all([
    listScoringRules(context.viewer.actor, business.id),
    listIcps(context.viewer.actor, business.id),
  ]);

  const canManage = context.permissions.has('scoring.manage');
  const positives = rules.filter((rule) => rule.polarity === 'positive');
  const negatives = rules.filter((rule) => rule.polarity !== 'positive');

  const columns: readonly Column<ScoringRule>[] = [
    {
      key: 'signal',
      header: 'Signal',
      cell: (rule) => (
        <div className="nx-stack nx-stack--sm">
          <span>{rule.label ?? rule.signalKind}</span>
          <span className="nx-hint">{rule.signalKind}</span>
        </div>
      ),
    },
    {
      key: 'scope',
      header: 'Scope',
      cell: (rule) =>
        rule.targetType === 'icp' ? (
          <Chip accent="indigo">{rule.targetLabel}</Chip>
        ) : (
          <span className="nx-hint">{rule.targetLabel}</span>
        ),
    },
    {
      key: 'polarity',
      header: 'Polarity',
      cell: (rule) =>
        rule.polarity === 'positive' ? (
          <Chip accent="green">positive</Chip>
        ) : (
          <Chip accent="red">exclusion</Chip>
        ),
    },
    {
      key: 'points',
      header: 'Points',
      numeric: true,
      cell: (rule) => (rule.points > 0 ? `+${String(rule.points)}` : String(rule.points)),
    },
    {
      key: 'active',
      header: 'State',
      cell: (rule) => (rule.isActive ? <Chip accent="green">active</Chip> : <Chip>inactive</Chip>),
    },
  ];

  const primary = icps.find((icp) => icp.isDefault) ?? null;

  return (
    <>
      <PageHead
        subtitle={`Signals and scoring rules for ${business.name}.`}
        actions={
          <Chip accent={rules.some((rule) => rule.isActive) ? 'green' : 'amber'}>
            {rules.filter((rule) => rule.isActive).length} active
          </Chip>
        }
      >
        Signals
      </PageHead>

      <Alert accent="indigo" title="How a signal becomes a score">
        spec <code>signals_and_scoring</code>: each rule contributes a signed point value for one
        signal kind. Positive rules raise a lead's match score; exclusions subtract, and an exclusion
        can veto a match outright. An ICP may override the points for its own scope, which is why the
        scope column is shown alongside each rule.
      </Alert>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Grid cols={4}>
        <Stat value={rules.length} label="Scoring rules" />
        <Stat value={positives.length} label="Positive signals" meta="raise the score" />
        <Stat value={negatives.length} label="Exclusions" meta="lower or veto" />
        <Stat value={icps.length} label="ICPs scored" meta={primary === null ? 'no primary' : `primary: ${primary.name}`} />
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Card title="Scoring rules" actions={<Chip accent="indigo">signal → points</Chip>}>
        <DataTable
          columns={columns}
          rows={rules}
          rowKey={(rule) => rule.id}
          caption="Scoring rules for this business and its ICPs"
          empty={
            <span className="nx-hint">
              No scoring rules are configured. Leads will match ICPs on criteria alone until signals are
              defined.
            </span>
          }
        />
      </Card>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card title="Primary ICP rule" actions={<Chip accent={primary === null ? 'amber' : 'green'}>{primary === null ? 'unset' : 'set'}</Chip>}>
        {primary === null ? (
          <span className="nx-hint">
            No ICP is marked primary. Exactly one Primary ICP per business is expected; a lead&apos;s
            primary ICP drives its sequence routing, while secondary matches never create duplicates.
          </span>
        ) : (
          <div className="nx-stack nx-stack--sm">
            <span>
              <strong>{primary.name}</strong> is the Primary ICP
              {primary.defaultSequenceName === null ? '' : ` and routes to “${primary.defaultSequenceName}”`}.
            </span>
            <span className="nx-hint">
              {primary.primaryLeadCount} primary leads · {primary.secondaryMatchCount} secondary matches
            </span>
          </div>
        )}
        {!canManage && (
          <p className="nx-hint">
            Changing scoring rules requires the <code>scoring.manage</code> permission.
          </p>
        )}
      </Card>
    </>
  );
}
