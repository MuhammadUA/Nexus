import type { ReactNode } from 'react';

import { Alert, Card, Chip, DataTable, Grid, PageHead, Row, Stack, Stat, type Column } from '@nexus/ui';
import { notFound } from 'next/navigation';

import {
  BrainApprovalButton,
  BrainOfferForm,
  BrainPersonaForm,
  BrainServiceForm,
  BrainSnapshotForm,
  BrainValuePropositionForm,
} from '@/components/brain-forms';
import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import {
  listContextVersions,
  listOffers,
  listPersonas,
  listServices,
  listValuePropositions,
  type BusinessContextVersionRow,
  type OfferRow,
  type PersonaRow,
  type ServiceRow,
  type ValuePropositionRow,
} from '@/lib/repo/brain';

export const dynamic = 'force-dynamic';

/**
 * A11 — Business Setup · Brain.
 *
 * Contract: "Offer, services, positioning, value props, approved proof,
 * AI-eligible context, versioning."
 *
 * The screen is deliberately approval-centric. spec
 * `business_brain_and_knowledge.claim_policy` says outbound "may use only approved
 * factual claims" and retrieval must "not dump the entire Business Brain into every
 * prompt", so each asset shows whether the model may actually use it, and freezing a
 * `business_context_versions` row is what a sent message refers back to.
 */
export default async function BrainPage({
  params,
}: {
  readonly params: Promise<{ slug: string }>;
}): Promise<ReactNode> {
  const { slug } = await params;
  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);
  if (business === null) notFound();

  const [offers, services, personas, valuePropositions, versions] = await Promise.all([
    listOffers(context.viewer.actor, business.id),
    listServices(context.viewer.actor, business.id),
    listPersonas(context.viewer.actor, business.id),
    listValuePropositions(context.viewer.actor, business.id),
    listContextVersions(context.viewer.actor, business.id),
  ]);

  // `knowledge.manage` is admin-only (packages/core ADMIN_ONLY_PERMISSIONS), so this
  // decides what is rendered; RLS refuses the write regardless.
  const canManage = context.permissions.has('knowledge.manage');

  const all = [
    offers.map((offer) => offer.aiEligible),
    services.map((service) => service.aiEligible),
    personas.map((persona) => persona.aiEligible),
    valuePropositions.map((proposition) => proposition.aiEligible),
  ].flat();

  const personaOptions = personas.map((persona) => ({ value: persona.id, label: persona.name }));

  const offerColumns: readonly Column<OfferRow>[] = [
    { key: 'name', header: 'Offer', cell: (offer) => offer.name },
    {
      key: 'positioning',
      header: 'Positioning',
      cell: (offer) => <span className="nx-hint">{offer.positioning ?? '—'}</span>,
    },
    { key: 'cta', header: 'CTA style', cell: (offer) => offer.ctaStyle ?? '—' },
    { key: 'version', header: 'Version', numeric: true, cell: (offer) => offer.version },
    {
      key: 'state',
      header: 'Approval',
      cell: (offer) => <ApprovalChip approved={offer.approved} eligible={offer.aiEligible} />,
    },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            cell: (offer: OfferRow) => (
              <BrainApprovalButton
                businessId={business.id}
                businessSlug={business.key}
                kind="offer"
                id={offer.id}
                approved={offer.approved}
              />
            ),
          } satisfies Column<OfferRow>,
        ]
      : []),
  ];

  const serviceColumns: readonly Column<ServiceRow>[] = [
    { key: 'name', header: 'Service', cell: (service) => service.name },
    { key: 'category', header: 'Category', cell: (service) => service.category ?? '—' },
    {
      key: 'description',
      header: 'Description',
      cell: (service) => <span className="nx-hint">{service.description ?? '—'}</span>,
    },
    {
      key: 'state',
      header: 'Approval',
      cell: (service) => <ApprovalChip approved={service.approved} eligible={service.aiEligible} />,
    },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            cell: (service: ServiceRow) => (
              <BrainApprovalButton
                businessId={business.id}
                businessSlug={business.key}
                kind="service"
                id={service.id}
                approved={service.approved}
              />
            ),
          } satisfies Column<ServiceRow>,
        ]
      : []),
  ];

  const personaColumns: readonly Column<PersonaRow>[] = [
    { key: 'name', header: 'Persona', cell: (persona) => persona.name },
    {
      key: 'pains',
      header: 'Pain points',
      cell: (persona) =>
        persona.painPoints.length === 0 ? (
          <span className="nx-hint">—</span>
        ) : (
          <Row wrap>
            {persona.painPoints.slice(0, 4).map((pain) => (
              <Chip key={pain}>{pain}</Chip>
            ))}
          </Row>
        ),
    },
    {
      key: 'goals',
      header: 'Goals',
      cell: (persona) =>
        persona.goals.length === 0 ? (
          <span className="nx-hint">—</span>
        ) : (
          <Row wrap>
            {persona.goals.slice(0, 4).map((goal) => (
              <Chip key={goal}>{goal}</Chip>
            ))}
          </Row>
        ),
    },
    {
      key: 'state',
      header: 'Approval',
      cell: (persona) => <ApprovalChip approved={persona.approved} eligible={persona.aiEligible} />,
    },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            cell: (persona: PersonaRow) => (
              <BrainApprovalButton
                businessId={business.id}
                businessSlug={business.key}
                kind="persona"
                id={persona.id}
                approved={persona.approved}
              />
            ),
          } satisfies Column<PersonaRow>,
        ]
      : []),
  ];

  const valuePropColumns: readonly Column<ValuePropositionRow>[] = [
    {
      key: 'statement',
      header: 'Value proposition',
      cell: (proposition) => (
        <div className="nx-stack nx-stack--sm">
          <span>{proposition.statement}</span>
          {proposition.proofRequired && <span className="nx-hint">proof required</span>}
        </div>
      ),
    },
    { key: 'persona', header: 'Persona', cell: (proposition) => proposition.personaName ?? '—' },
    {
      key: 'state',
      header: 'Approval',
      cell: (proposition) => (
        <ApprovalChip approved={proposition.approved} eligible={proposition.aiEligible} />
      ),
    },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            cell: (proposition: ValuePropositionRow) => (
              <BrainApprovalButton
                businessId={business.id}
                businessSlug={business.key}
                kind="value_proposition"
                id={proposition.id}
                approved={proposition.approved}
              />
            ),
          } satisfies Column<ValuePropositionRow>,
        ]
      : []),
  ];

  const versionColumns: readonly Column<BusinessContextVersionRow>[] = [
    { key: 'version', header: 'Version', numeric: true, cell: (version) => version.version },
    {
      key: 'when',
      header: 'Frozen',
      cell: (version) => (
        <span className="nx-table__mono">{formatWhen(version.createdAt)}</span>
      ),
    },
    {
      key: 'assets',
      header: 'Assets',
      numeric: true,
      cell: (version) =>
        version.counts.offers +
        version.counts.services +
        version.counts.personas +
        version.counts.valuePropositions,
    },
    {
      key: 'eligible',
      header: 'AI-eligible',
      numeric: true,
      cell: (version) => version.counts.aiEligible,
    },
    { key: 'reason', header: 'Reason', cell: (version) => version.reason ?? '—' },
  ];

  return (
    <>
      <PageHead
        subtitle={`Offer, services, positioning, value propositions and approved proof for ${business.name}.`}
        actions={
          <Row wrap>
            <Chip accent="indigo">{all.length} assets</Chip>
            <Chip accent={all.some(Boolean) ? 'green' : 'amber'}>
              {all.filter(Boolean).length} AI-eligible
            </Chip>
          </Row>
        }
      >
        Business Brain
      </PageHead>

      <Alert accent="indigo" title="Only approved claims may be used outbound">
        spec `business_brain_and_knowledge.claim_policy`: outbound may use only approved factual claims and
        the model must never invent metrics or results. An asset counts as{' '}
        <strong>AI-eligible</strong> once it is approved — a value proposition that requires proof also needs
        an approved knowledge asset behind it.
      </Alert>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      {!canManage && (
        <>
          <Alert accent="amber" role="alert">
            You can read this Brain but not change it: approving assets needs the <code>knowledge.manage</code>{' '}
            permission, which is admin-only. The database would refuse the write in any case.
          </Alert>
          <div style={{ height: 'var(--nx-space-lg)' }} />
        </>
      )}

      <Grid cols={4}>
        <Stat value={offers.length} label="Offers" meta={`${offers.filter((o) => o.approved).length} approved`} />
        <Stat
          value={services.length}
          label="Services"
          meta={`${services.filter((s) => s.approved).length} approved`}
        />
        <Stat
          value={personas.length}
          label="Personas"
          meta={`${personas.filter((p) => p.approved).length} approved`}
        />
        <Stat
          value={valuePropositions.length}
          label="Value propositions"
          meta={`${valuePropositions.filter((v) => v.aiEligible).length} AI-eligible`}
        />
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Card title="Offers" actions={<Chip accent="indigo">positioning + CTA</Chip>}>
        <DataTable
          columns={offerColumns}
          rows={offers}
          rowKey={(offer) => offer.id}
          caption="Offers for this business"
          empty={<span className="nx-hint">No offers recorded yet.</span>}
        />
        {canManage && (
          <div style={{ marginTop: 'var(--nx-space-lg)' }}>
            <BrainOfferForm businessId={business.id} businessSlug={business.key} />
          </div>
        )}
      </Card>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card title="Services">
        <DataTable
          columns={serviceColumns}
          rows={services}
          rowKey={(service) => service.id}
          caption="Services for this business"
          empty={<span className="nx-hint">No services recorded yet.</span>}
        />
        {canManage && (
          <div style={{ marginTop: 'var(--nx-space-lg)' }}>
            <BrainServiceForm businessId={business.id} businessSlug={business.key} />
          </div>
        )}
      </Card>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card title="Personas" actions={<Chip accent="indigo">buyer context</Chip>}>
        <DataTable
          columns={personaColumns}
          rows={personas}
          rowKey={(persona) => persona.id}
          caption="Personas for this business"
          empty={<span className="nx-hint">No personas recorded yet.</span>}
        />
        {canManage && (
          <div style={{ marginTop: 'var(--nx-space-lg)' }}>
            <BrainPersonaForm businessId={business.id} businessSlug={business.key} />
          </div>
        )}
      </Card>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card
        title="Value propositions"
        actions={<Chip accent={valuePropositions.some((v) => v.proofRequired) ? 'amber' : 'neutral'}>proof-aware</Chip>}
      >
        <DataTable
          columns={valuePropColumns}
          rows={valuePropositions}
          rowKey={(proposition) => proposition.id}
          caption="Value propositions for this business"
          empty={<span className="nx-hint">No value propositions recorded yet.</span>}
        />
        {canManage && (
          <div style={{ marginTop: 'var(--nx-space-lg)' }}>
            <BrainValuePropositionForm
              businessId={business.id}
              businessSlug={business.key}
              personas={personaOptions}
            />
          </div>
        )}
      </Card>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Grid split>
        <Card
          title="Context versions"
          actions={<Chip accent="indigo">{versions.length} frozen</Chip>}
        >
          <DataTable
            columns={versionColumns}
            rows={versions}
            rowKey={(version) => version.id}
            caption="Frozen Business Brain snapshots"
            empty={
              <span className="nx-hint">
                No context version has been frozen yet. Messages drafted from this Brain will record the
                version they used.
              </span>
            }
          />
          <p className="nx-hint" style={{ marginTop: 'var(--nx-space-sm)' }}>
            spec `business_brain_and_knowledge.versioning`: sent messages retain the referenced asset
            versions, while unsent dynamic messages may pick up the newest approved versions.
          </p>
        </Card>

        <StackedPanel
          canManage={canManage}
          businessId={business.id}
          businessSlug={business.key}
          offers={offers.length}
          eligible={all.filter(Boolean).length}
        />
      </Grid>
    </>
  );
}

/**
 * "Approved proof / AI-eligible context" summary plus the version-freeze control.
 *
 * Approval and eligibility are printed as words as well as colour, so the state is
 * never conveyed by colour alone.
 */
function StackedPanel({
  canManage,
  businessId,
  businessSlug,
  offers,
  eligible,
}: {
  readonly canManage: boolean;
  readonly businessId: string;
  readonly businessSlug: string;
  readonly offers: number;
  readonly eligible: number;
}): ReactNode {
  return (
    <Card title="AI retrieval eligibility" actions={<Chip accent="indigo">retrieval scope</Chip>}>
      <Stack>
        <Row between>
          <span className="nx-hint">Approved, AI-usable assets</span>
          <Chip accent={eligible > 0 ? 'green' : 'amber'}>{eligible}</Chip>
        </Row>
        <Row between>
          <span className="nx-hint">Offers on file</span>
          <span>{offers}</span>
        </Row>
        <p className="nx-hint">
          spec `business_brain_and_knowledge.retrieval`: prospect + company + signal + ICP drive retrieval of
          the top relevant approved value proposition and proof. The entire Brain is never dumped into a
          prompt, which is why unapproved assets are simply not eligible.
        </p>
        {canManage ? (
          <BrainSnapshotForm businessId={businessId} businessSlug={businessSlug} />
        ) : (
          <span className="nx-hint">Freezing a context version requires the knowledge.manage permission.</span>
        )}
      </Stack>
    </Card>
  );
}

function ApprovalChip({
  approved,
  eligible,
}: {
  readonly approved: boolean;
  readonly eligible: boolean;
}): ReactNode {
  if (!approved) return <Chip accent="amber">draft — not approved</Chip>;
  if (!eligible) return <Chip accent="amber">approved — awaiting proof</Chip>;
  return <Chip accent="green" dataState="approved">approved — AI-eligible</Chip>;
}

function formatWhen(value: string | null): string {
  if (value === null || value.length === 0) return '—';
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16);
}
