import type { ReactNode } from 'react';

import { Alert, Card, Chip, PageHead, Row, Stack } from '@nexus/ui';

import { loadViewerContext } from '@/lib/viewer-context';
import { buildImportProps } from '@/lib/repo/user-sources';
import { UserImportWizard } from '@/components/user-import';

export const dynamic = 'force-dynamic';

/**
 * U12 — Lead Sources · File.
 *
 * Contract: "CSV/XLSX upload with business + ICP tagging/auto-match, preview, duplicate
 * counts."
 *
 * The preview and the duplicate/needs-profile counts are produced by the shared
 * `prepareIngestion` pipeline — the same code the import then runs — so the numbers shown
 * here are the numbers the operator gets, not an estimate.
 */
export default async function MyLeadSourcesFilePage(): Promise<ReactNode> {
  const context = await loadViewerContext();
  const props = await buildImportProps(context.viewer.actor, context.businesses, context.permissions);

  return (
    <>
      <PageHead
        subtitle="Upload a CSV or XLSX, choose the business and how the Primary ICP is decided, then review the exact outcome before anything is written."
        actions={
          <Row wrap>
            <a className="nx-btn nx-btn--secondary" href="/my-lead-sources">
              All lead sources
            </a>
            <a className="nx-btn nx-btn--secondary" href="/my-leads">
              My Leads
            </a>
          </Row>
        }
      >
        Lead Sources · File
      </PageHead>

      <Card
        title="What a file import needs"
        actions={<Chip accent="indigo">spec lead_sources.file</Chip>}
      >
        <Stack size="sm">
          <span className="nx-hint">
            <strong>Required columns:</strong> name, company, job title.
          </span>
          <span className="nx-hint">
            <strong>Optional columns:</strong> LinkedIn URL, location, source URL.
          </span>
          <span className="nx-hint">
            A row without a LinkedIn URL still becomes a lead: it is marked Needs profile and sent to the Profile
            Queue rather than being dropped.
          </span>
          <span className="nx-hint">
            Normalization and dedupe run before any lead is created, so the same person imported twice updates one
            record instead of creating two.
          </span>
        </Stack>
      </Card>

      <div style={{ height: 'var(--nx-space-md)' }} />

      {context.businesses.length === 0 && (
        <Alert accent="amber" title="No business access">
          An administrator has not granted you access to a business yet, so there is nowhere to import into.
        </Alert>
      )}

      <UserImportWizard
        mode="file"
        businesses={props.businesses}
        icps={props.icps}
        canImport={props.canImport}
        defaultBusinessId={props.defaultBusinessId}
      />
    </>
  );
}
