import type { ReactNode } from 'react';

import { Alert, Card, Chip, DataTable, Grid, PageHead, Row, Stack, Stat, type Column } from '@nexus/ui';

import { DomainCreateForm, DomainDeleteButton } from '@/components/domain-forms';
import { loadViewerContext, type ViewerContext } from '@/lib/viewer-context';
import { listAllDomains, type DomainRow } from '@/lib/repo/businesses';

export const dynamic = 'force-dynamic';

/**
 * The database's domain vocabulary, with the human label from
 * spec `admin_self_assignment_and_domains.business_domains.types`
 * ("primary", "alias", "parent/source", "service domain"). The stored values come from
 * the `business_domains_type_check` constraint in 0002.
 */
const DOMAIN_TYPE_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'primary', label: 'primary — the business’s own official domain' },
  { value: 'alias', label: 'alias — an explicit additional domain for the same business' },
  { value: 'parent_source', label: 'parent/source — a parent or source domain, never a merge trigger' },
  { value: 'service', label: 'service — a service-specific domain' },
];

/**
 * A30 — Admin · Business Domains.
 *
 * Contract: "Primary/alias/source domains for business scoping and matching; no
 * automatic cross-business merge."
 *
 * spec `business_domains.rule`: "One primary business context per registered domain.
 * Explicit aliases are allowed. Never auto-merge leads across businesses because of a
 * related/parent domain." The uniqueness is enforced in Postgres
 * (`business_domains_normalized_unique`), so two businesses cannot quietly claim the
 * same domain through this screen.
 */
export default async function BusinessDomainsPage(): Promise<ReactNode> {
  const context = await loadViewerContext();
  const domains = await listAllDomains(context.viewer.actor);

  // `domain.manage` is admin-only (packages/core ADMIN_ONLY_PERMISSIONS) and
  // `business_domains_write` requires public.is_admin(); this only decides what renders.
  const canManage = context.permissions.has('domain.manage');

  const primaries = domains.filter((domain) => domain.domainType === 'primary');
  const defaults = domains.filter((domain) => domain.isDefault);
  const businessesCovered = new Set(domains.map((domain) => domain.businessId)).size;

  const columns: readonly Column<DomainRow>[] = [
    {
      key: 'domain',
      header: 'Domain',
      cell: (domain) => (
        <div className="nx-stack nx-stack--sm">
          <span className="nx-table__mono">{domain.domain}</span>
          {domain.normalizedDomain !== domain.domain && (
            <span className="nx-hint">normalized: {domain.normalizedDomain}</span>
          )}
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      cell: (domain) => (
        <Row wrap>
          <Chip accent={domain.domainType === 'primary' ? 'indigo' : 'neutral'}>
            {domainTypeLabel(domain.domainType)}
          </Chip>
          {domain.isDefault && <Chip accent="green">default primary</Chip>}
        </Row>
      ),
    },
    {
      key: 'business',
      header: 'Business context',
      cell: (domain) => {
        const slug = slugFor(context, domain.businessId);
        // A domain can only be seen when its business is visible, but the slug lookup
        // is still guarded so a missing match renders a label, never a dead link.
        return slug === null ? (
          <span>{domain.businessName}</span>
        ) : (
          <a className="nx-nav__item" style={{ padding: 0 }} href={`/b/${slug}/overview`}>
            {domain.businessName}
          </a>
        );
      },
    },
    { key: 'notes', header: 'Notes', cell: (domain) => domain.notes ?? '—' },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            cell: (domain: DomainRow) => <DomainDeleteButton id={domain.id} domain={domain.domain} />,
          } satisfies Column<DomainRow>,
        ]
      : []),
  ];

  return (
    <>
      <PageHead
        subtitle="Which owned domains map to which business context. Scoping and matching only — never a merge."
        actions={
          <Row wrap>
            <Chip accent="indigo">{domains.length} domains</Chip>
            <Chip accent="green">{defaults.length} default primaries</Chip>
          </Row>
        }
      >
        Business domains
      </PageHead>

      <Grid cols={4}>
        <Stat value={domains.length} label="Registered domains" />
        <Stat value={primaries.length} label="Primary domains" meta={`${defaults.length} marked default`} />
        <Stat value={businessesCovered} label="Businesses with a domain" />
        <Stat
          value={context.businesses.length - businessesCovered}
          label="Businesses without one"
          meta="scoping falls back to explicit leads"
        />
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Alert accent="red" title="Domains never merge leads across businesses">
        A related, parent or source domain is recorded as <strong>parent/source</strong> so scoping and matching
        can use it — it is never a reason to combine two businesses&apos; leads, people or history. Each
        normalized domain belongs to exactly one business (<code>business_domains_normalized_unique</code>), and
        at most one default primary domain exists per business (
        <code>business_domains_default_primary_key</code>).
      </Alert>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      {!canManage && (
        <>
          <Alert accent="amber" role="alert">
            You can review the registry but not change it: registering or removing a domain needs the{' '}
            <code>domain.manage</code> permission, which is admin-only, and the database refuses the write
            regardless.
          </Alert>
          <div style={{ height: 'var(--nx-space-lg)' }} />
        </>
      )}

      <Card title="Domain registry" actions={<Chip accent="indigo">globally unique</Chip>}>
        <DataTable
          columns={columns}
          rows={domains}
          rowKey={(domain) => domain.id}
          caption="Registered business domains"
          empty={
            <span className="nx-hint">
              No domain is registered yet. Until one is, business scoping relies on explicit lead data only.
            </span>
          }
        />
      </Card>

      {canManage && (
        <>
          <div style={{ height: 'var(--nx-space-lg)' }} />

          <Grid split>
            <Card title="Register a domain">
              <DomainCreateForm
                businesses={context.businesses.map((business) => ({
                  id: business.id,
                  name: business.name,
                }))}
                typeOptions={DOMAIN_TYPE_OPTIONS}
              />
            </Card>

            <Card title="Rules the database enforces" actions={<Chip accent="neutral">0010 / 0011</Chip>}>
              <Stack size="sm">
                <Rule title="One business context per domain">
                  <code>unique (normalized_domain)</code> — the same domain cannot be claimed by two businesses.
                  A trigger lowercases the value and strips the scheme, <code>www.</code> and any path before the
                  check, so <code>https://www.Example.com/x</code> and <code>example.com</code> collide on purpose.
                </Rule>
                <Rule title="One default primary per business">
                  <code>unique (business_id) where is_default and domain_type = &apos;primary&apos;</code> — a
                  business may list several primaries, but only one of them can be the default its admin screens
                  and the Companion start from.
                </Rule>
                <Rule title="Aliases are explicit">
                  Only what an admin registers here is treated as the same business. A domain that looks related is
                  not inferred into an alias.
                </Rule>
                <Rule title="No automatic cross-business merge">
                  spec <code>business_domains.rule</code>: a parent or source domain never combines leads between
                  businesses. Matching may score a company higher; it never moves a record.
                </Rule>
              </Stack>
            </Card>
          </Grid>
        </>
      )}
    </>
  );
}

function Rule({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactNode {
  return (
    <div className="nx-stack nx-stack--sm">
      <strong>{title}</strong>
      <span className="nx-hint">{children}</span>
    </div>
  );
}

function domainTypeLabel(value: string): string {
  switch (value) {
    case 'primary':
      return 'primary';
    case 'alias':
      return 'alias';
    case 'parent_source':
      return 'parent/source';
    case 'service':
      return 'service';
    default:
      return value;
  }
}

/**
 * Only the businesses the viewer can see are in `context.businesses`, so a domain that
 * points at an invisible business gets a plain label instead of a dead link.
 */
function slugFor(context: ViewerContext, businessId: string): string | null {
  const business = context.businesses.find((candidate) => candidate.id === businessId);
  return business?.key ?? null;
}
