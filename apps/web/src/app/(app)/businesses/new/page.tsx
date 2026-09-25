import type { ReactNode } from 'react';

import { Alert, Card, Chip, DataTable, Grid, PageHead, Row, Stat, type Column } from '@nexus/ui';

import { BusinessWizard, type WizardSource } from '@/components/business-wizard';
import { loadViewerContext } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import { listBusinessSummaries, type BusinessSummary } from '@/lib/repo/businesses';

export const dynamic = 'force-dynamic';

/**
 * A23 — Add Business Wizard.
 *
 * Contract: "Business identity, offer, ICPs, knowledge, sequences, team, automations;
 * scratch/clone/template."
 *
 * The wizard creates the business (and, optionally, its first offer). Everything else
 * in that list is configuration that already has a dedicated screen, so the wizard
 * points at them rather than half-configuring them here — and it states the
 * `business_units.clone_behavior` boundary explicitly, because "copy an existing
 * business" is the one option people read as "copy everything".
 */
export default async function NewBusinessPage(): Promise<ReactNode> {
  const context = await loadViewerContext();
  requireRouteAccess(context, { route: '/businesses/new' });

  // `business.create` is admin-only (packages/core ADMIN_ONLY_PERMISSIONS) and RLS
  // refuses the insert for anyone else; this only decides what is rendered.
  const canCreate = context.permissions.has('business.create');
  const summaries = canCreate ? await listBusinessSummaries(context.viewer.actor) : [];

  const sources: readonly WizardSource[] = summaries.map((summary) => ({
    id: summary.id,
    name: summary.name,
    isTemplate: summary.isTemplate,
    leadCount: summary.leadCount,
  }));
  const templates = sources.filter((source) => source.isTemplate);

  const templateColumns: readonly Column<BusinessSummary>[] = [
    { key: 'name', header: 'Template', cell: (business) => business.name },
    { key: 'focus', header: 'Focus', cell: (business) => business.focus ?? '—' },
    {
      key: 'regions',
      header: 'Regions',
      cell: (business) => (business.regions.length === 0 ? '—' : business.regions.join(', ')),
    },
    { key: 'domains', header: 'Domains', numeric: true, cell: (business) => business.domainCount },
  ];

  return (
    <>
      <PageHead
        subtitle="Create a business context from scratch, from an existing one, or from a template."
        actions={
          <Row wrap>
            <a className="nx-btn nx-btn--secondary" href="/businesses">
              All businesses
            </a>
            {templates.length > 0 && <Chip accent="indigo">{templates.length} templates</Chip>}
          </Row>
        }
      >
        Add business
      </PageHead>

      {!canCreate ? (
        <Alert accent="amber" role="alert" title="Creating a business needs the business.create permission">
          That permission is admin-only, and the database refuses the insert regardless. Ask an administrator to
          create the business and grant you access to it.
        </Alert>
      ) : (
        <>
          <Grid cols={4}>
            <Stat value={sources.length} label="Businesses you can see" />
            <Stat value={templates.length} label="Templates" meta="is_template = true" />
            <Stat value={sources.reduce((sum, source) => sum + source.leadCount, 0)} label="Leads that will not be copied" />
            <Stat value="4" label="Wizard steps" meta="one page, one form" />
          </Grid>

          <div style={{ height: 'var(--nx-space-xl)' }} />

          <BusinessWizard sources={sources} templates={templates} />

          {templates.length > 0 && (
            <>
              <div style={{ height: 'var(--nx-space-lg)' }} />
              <Card title="Available templates" actions={<Chip accent="indigo">start from one of these</Chip>}>
                <DataTable
                  columns={templateColumns}
                  rows={summaries.filter((summary) => summary.isTemplate)}
                  rowKey={(business) => business.id}
                  caption="Businesses marked as templates"
                  empty={<span className="nx-hint">No business is marked as a template.</span>}
                />
              </Card>
            </>
          )}

          <div style={{ height: 'var(--nx-space-lg)' }} />

          <Card title="What happens after creation" actions={<Chip accent="neutral">next screens</Chip>}>
            <ul className="nx-stack nx-stack--sm">
              <li>
                <strong>ICPs</strong> — company types, buyers, signals, scoring, exclusions, primary ICP rule.
              </li>
              <li>
                <strong>Business Brain</strong> — offers, services, personas, value propositions and approval
                before the AI may use a claim.
              </li>
              <li>
                <strong>Knowledge</strong> — portfolio, case studies, pages and videos, with AI-eligibility.
              </li>
              <li>
                <strong>Sequences</strong> — message 1 plus follow-ups, delays and publishing.
              </li>
              <li>
                <strong>Team &amp; access</strong> — who may see this business, and which LinkedIn identities
                they may send from.
              </li>
              <li>
                <strong>Automations</strong> — map scouts to this business, ICP, source and schedule.
              </li>
            </ul>
          </Card>
        </>
      )}
    </>
  );
}
