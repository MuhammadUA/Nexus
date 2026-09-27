import type { ReactNode } from 'react';

import { Card, Chip, Grid, PageHead, Row, Stack, Stat } from '@nexus/ui';
import { notFound } from 'next/navigation';

import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import { listOffers, listPersonas, listServices, listValuePropositions } from '@/lib/repo/brain';
import { listIcps, listScoringRules } from '@/lib/repo/icps';
import { listKnowledgeAssets } from '@/lib/repo/knowledge';
import { listSequences } from '@/lib/repo/sequences';

export const dynamic = 'force-dynamic';

/**
 * A11 — Business Setup · Overview (the landing tab of the Business Setup section).
 *
 * Final Figma A11 draws a tab strip — OVERVIEW / ICPS / SEQUENCES / KNOWLEDGE / SIGNALS — over a
 * business-context composition: "Offer & positioning", "Value propositions & proof" and "AI context
 * rules". This screen is that landing tab: it reports the real configuration state for the selected
 * business and links into each section.
 *
 * Every figure is read from the same repositories the detail screens use, so a count here and the
 * rows behind it can never disagree. Nothing is hard-coded from the Figma sample.
 */
export default async function BusinessSetupPage({
  params,
}: {
  readonly params: Promise<{ slug: string }>;
}): Promise<ReactNode> {
  const { slug } = await params;
  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);
  if (business === null) notFound();

  requireRouteAccess(context, { route: '/b/:businessSlug/setup', businessId: business.id });

  const [offers, services, personas, valuePropositions, icps, sequences, knowledge, scoringRules] =
    await Promise.all([
      listOffers(context.viewer.actor, business.id),
      listServices(context.viewer.actor, business.id),
      listPersonas(context.viewer.actor, business.id),
      listValuePropositions(context.viewer.actor, business.id),
      listIcps(context.viewer.actor, business.id),
      listSequences(context.viewer.actor, business.id),
      listKnowledgeAssets(context.viewer.actor, business.id),
      listScoringRules(context.viewer.actor, business.id),
    ]);

  const assets = [...offers, ...services, ...personas, ...valuePropositions];
  const aiEligible = assets.filter((asset) => asset.aiEligible).length;
  const primaryIcp = icps.find((icp) => icp.isDefault) ?? null;
  const activeSequences = sequences.filter((sequence) => sequence.status === 'active').length;
  const approvedKnowledge = knowledge.filter((asset) => asset.approvalState === 'approved').length;

  const base = `/b/${business.key}`;

  return (
    <>
      <PageHead
        subtitle={`Approved business context used by AI and sequences for ${business.name}.`}
        actions={
          <Row wrap>
            <Chip accent="indigo">{assets.length} context assets</Chip>
            <Chip accent={aiEligible > 0 ? 'green' : 'amber'}>{aiEligible} AI-eligible</Chip>
          </Row>
        }
      >
        Business Setup · {business.name}
      </PageHead>

      <Grid cols={4}>
        <Stat value={icps.length} label="ICPs" meta={primaryIcp === null ? 'no primary set' : `primary: ${primaryIcp.name}`} />
        <Stat value={sequences.length} label="Sequences" meta={`${String(activeSequences)} active`} />
        <Stat
          value={knowledge.length}
          label="Knowledge assets"
          meta={`${String(approvedKnowledge)} approved`}
        />
        <Stat value={scoringRules.length} label="Scoring rules" meta="signals and exclusions" />
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Grid split>
        <Card
          title="Offer & positioning"
          actions={<Chip accent="indigo">{offers.length + services.length} assets</Chip>}
        >
          <Stack>
            <DetailRow label="Offers" value={offers.length === 0 ? 'none recorded' : offers.map((o) => o.name).join(', ')} />
            <DetailRow
              label="Services"
              value={services.length === 0 ? 'none recorded' : services.map((s) => s.name).join(', ')}
            />
            <DetailRow label="Personas" value={personas.length === 0 ? 'none recorded' : personas.map((p) => p.name).join(', ')} />
          </Stack>
          <SetupLink href={`${base}/setup/brain`} label="Edit offer, services and positioning" />
        </Card>

        <Card
          title="Value propositions & proof"
          actions={<Chip accent="indigo">{valuePropositions.length}</Chip>}
        >
          <Stack>
            <DetailRow
              label="Value propositions"
              value={String(valuePropositions.length)}
            />
            <DetailRow
              label="Requiring proof"
              value={String(valuePropositions.filter((v) => v.proofRequired).length)}
            />
            <DetailRow
              label="Approved knowledge"
              value={`${String(approvedKnowledge)} of ${String(knowledge.length)}`}
            />
          </Stack>
          <SetupLink href={`${base}/setup/knowledge`} label="Open the knowledge library" />
        </Card>
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card title="Configuration surfaces">
        <Stack>
          <DetailRow
            label="ICPs"
            value={`${String(icps.length)} configured · ${String(icps.reduce((sum, icp) => sum + icp.primaryLeadCount, 0))} primary leads`}
          />
          <DetailRow
            label="Sequences"
            value={`${String(sequences.length)} defined · ${String(sequences.reduce((sum, s) => sum + s.activeEnrollments, 0))} active enrollments`}
          />
          <DetailRow
            label="Scoring rules"
            value={`${String(scoringRules.filter((rule) => rule.isActive).length)} active of ${String(scoringRules.length)}`}
          />
        </Stack>
        <Row wrap>
          <SetupLink href={`${base}/setup/icps`} label="ICPs" />
          <SetupLink href={`${base}/setup/sequences`} label="Sequences" />
          <SetupLink href={`${base}/setup/knowledge`} label="Knowledge" />
          <SetupLink href={`${base}/setup/signals`} label="Signals" />
        </Row>
      </Card>
    </>
  );
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <Row between>
      <span className="nx-hint">{label}</span>
      <span>{value}</span>
    </Row>
  );
}

function SetupLink({ href, label }: { readonly href: string; readonly label: string }): ReactNode {
  return (
    <a className="nx-btn nx-btn--secondary nx-btn--sm" href={href}>
      {label}
    </a>
  );
}
