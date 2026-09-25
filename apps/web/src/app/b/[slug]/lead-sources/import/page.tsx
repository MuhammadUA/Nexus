import type { ReactNode } from 'react';

import { Alert, Chip, EnrichmentOffChip, PageHead, Row, Stack } from '@nexus/ui';
import { notFound } from 'next/navigation';

import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import { listIcpOptions } from '@/lib/repo/leads';
import { IMPORT_BATCH_SOURCES, type ImportBatchSource } from '@/lib/repo/ingestion';
import { ImportWizard } from '@/components/import-wizard';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly mode?: string;
}

function parseSourceType(value: string | undefined): ImportBatchSource {
  const candidate = value ?? 'paste_list';
  return (IMPORT_BATCH_SOURCES as readonly string[]).includes(candidate)
    ? (candidate as ImportBatchSource)
    : 'paste_list';
}

/**
 * A20 — Admin Import Builder.
 *
 * Contract: "Business + Primary ICP/Auto-match, source input, preview, mapping,
 * validation, duplicate/profile counts, import."
 *
 * The screen is one wizard shared by every ingestion mode the hub links to; the
 * mode decides the recorded `import_batches.source` and the copy, and the wizard
 * refuses to preview or import without a Primary ICP or Auto-match — the spec's
 * `required_context_each_ingestion`.
 */
export default async function ImportBuilderPage({
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

  // Business-scoped configuration: judged against this business's grant alone.
  requireRouteAccess(context, { route: '/b/:businessSlug/lead-sources/import', businessId: business.id });

  const sourceType = parseSourceType(query.mode);
  const icps = await listIcpOptions(context.viewer.actor, business.id);
  const canUseLeadSources = context.permissions.has('lead_source.use');
  const apollo = sourceType === 'apollo_basic';

  return (
    <>
      <PageHead
        subtitle="Preview, map and validate every row before a lead is created. Nothing is written until the import runs."
        actions={
          <Row wrap>
            <Chip accent="indigo">{business.name}</Chip>
            {apollo && <EnrichmentOffChip />}
            <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/lead-sources`}>
              Lead sources
            </a>
          </Row>
        }
      >
        Import Builder
      </PageHead>

      {!canUseLeadSources && (
        <Alert accent="red" title="Not permitted" role="alert">
          You do not have the lead-source permission for this business, so an import here would be refused by the
          database. Ask an administrator to grant it.
        </Alert>
      )}

      {icps.length === 0 && (
        <Alert accent="amber" title="No ICP is configured">
          An import needs a Primary ICP or Auto-match. Configure at least one ICP for {business.name} first, or the
          wizard can only run Auto-match against a default ICP.
        </Alert>
      )}

      <Stack size="lg">
        <ImportWizard
          businessSlug={business.key}
          businessName={business.name}
          sourceType={sourceType}
          defaultIcpId={icps[0]?.value ?? ''}
          icps={icps.map((icp) => ({ value: icp.value, label: icp.label }))}
        />
      </Stack>
    </>
  );
}
