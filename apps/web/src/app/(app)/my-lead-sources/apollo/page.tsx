import type { ReactNode } from 'react';

import { Alert, Card, Chip, EnrichmentOffChip, PageHead, Row, Stack } from '@nexus/ui';

import { loadViewerContext } from '@/lib/viewer-context';
import { buildImportProps } from '@/lib/repo/user-sources';
import { UserImportWizard } from '@/components/user-import';

export const dynamic = 'force-dynamic';

/**
 * U15 — Lead Sources · Apollo.
 *
 * Contract: "Basic/zero-credit people search only by default; name/company/title;
 * enrichment OFF."
 *
 * spec `lead_sources.apollo`:
 *   - `default_mode`: "People Search/basic discovery only"
 *   - `allowed_default_fields`: name, company, title and basic metadata available without
 *     credits
 *   - `prohibited_without_explicit_approval`: email enrichment, phone enrichment, paid
 *     export/enrichment, credit-spending enrichment
 *   - `ui_must_label`: "Enrichment OFF"
 *
 * The label is rendered on the page AND in the wizard header. There is no enrichment call,
 * no email/phone lookup and no export button anywhere on this path — the only fields this
 * screen accepts are the non-credit ones listed above, and they go through the same
 * normalization and dedupe as every other source.
 */
export default async function MyLeadSourcesApolloPage(): Promise<ReactNode> {
  const context = await loadViewerContext();
  const props = await buildImportProps(context.viewer.actor, context.businesses, context.permissions);

  return (
    <>
      <PageHead
        subtitle="Bring in Apollo People Search results you already have, using only the fields available without credits."
        actions={
          <Row wrap>
            <EnrichmentOffChip />
            <a className="nx-btn nx-btn--secondary" href="/my-lead-sources">
              All lead sources
            </a>
          </Row>
        }
      >
        Lead Sources · Apollo
      </PageHead>

      <Card
        title="Basic discovery only — Enrichment OFF"
        actions={<EnrichmentOffChip />}
      >
        <Stack size="sm">
          <span className="nx-hint">
            <strong>Allowed on this screen:</strong> name, company, job title, and basic company/person metadata that
            Apollo returns without spending a credit — plus an optional LinkedIn URL if the row already has one.
          </span>
          <span className="nx-hint">
            <strong>Not available:</strong> email enrichment, phone enrichment, paid exports and any
            credit-spending action. Those are prohibited without explicit approval and this screen cannot trigger
            them.
          </span>
          <span className="nx-hint">
            Do not paste enriched email or phone data into the LinkedIn URL column: it will be rejected by the
            validator, and personal contact data belongs in the field it belongs to.
          </span>
          <span className="nx-hint">
            Rows without a profile URL become partial leads marked <strong>Needs profile</strong> and go to the
            Profile Queue.
          </span>
        </Stack>
      </Card>

      <div style={{ height: 'var(--nx-space-md)' }} />

      {context.businesses.length === 0 && (
        <Alert accent="amber" title="No business access">
          An administrator has not granted you access to a business yet, so there is nowhere to import into.
        </Alert>
      )}

      <Stack size="sm">
        <Row wrap>
          <Chip accent="amber" dataState="enrichment-off">
            Enrichment OFF
          </Chip>
          <span className="nx-hint">No credits are spent anywhere on this screen.</span>
        </Row>

        <UserImportWizard
          mode="apollo"
          businesses={props.businesses}
          icps={props.icps}
          canImport={props.canImport}
          defaultBusinessId={props.defaultBusinessId}
        />
      </Stack>
    </>
  );
}
