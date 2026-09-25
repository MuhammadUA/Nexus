import type { ReactNode } from 'react';

import { Alert, Card, Chip, PageHead, Row, Stack } from '@nexus/ui';

import { loadViewerContext } from '@/lib/viewer-context';
import { buildImportProps } from '@/lib/repo/user-sources';
import { UserImportWizard } from '@/components/user-import';

export const dynamic = 'force-dynamic';

/**
 * U14 — Lead Sources · Google.
 *
 * Contract: "Enter Google search URL, collect candidate rows, create partial leads, send
 * missing profiles to queue."
 *
 * spec `lead_sources.google.expected_partial_data`: name, company, job title, source
 * result — exactly the columns this screen asks for. spec
 * `google.missing_profile_behavior`: "Create partial lead/person candidate, mark Needs
 * Profile, send to Profile Queue" — which is what the shared pipeline does for any row
 * without a LinkedIn profile URL, so the count is visible in the preview before the
 * import runs.
 *
 * The search URL is recorded as the provenance of every row in the batch.
 */
export default async function MyLeadSourcesGooglePage(): Promise<ReactNode> {
  const context = await loadViewerContext();
  const props = await buildImportProps(context.viewer.actor, context.businesses, context.permissions);

  return (
    <>
      <PageHead
        subtitle="Record the search you ran, paste the candidate rows it returned, and review which of them will arrive as partial records."
        actions={
          <Row wrap>
            <a className="nx-btn nx-btn--secondary" href="/my-lead-sources">
              All lead sources
            </a>
            <a className="nx-btn nx-btn--secondary" href="/my-profile-queue">
              Profile Queue
            </a>
          </Row>
        }
      >
        Lead Sources · Google
      </PageHead>

      <Card title="How this path behaves" actions={<Chip accent="cyan">partial records allowed</Chip>}>
        <Stack size="sm">
          <span className="nx-hint">
            Put the Google search results URL in the field below: it becomes the source of every row, so the lead can
            always be traced back to the search that found it.
          </span>
          <span className="nx-hint">
            Expected per row: name, company, job title and the source result. A LinkedIn URL is optional.
          </span>
          <span className="nx-hint">
            Rows without a profile URL are created as partial leads, marked <strong>Needs profile</strong>, and
            queued in the Profile Queue — they are never silently discarded.
          </span>
          <span className="nx-hint">
            Nothing on this screen scrapes or automates Google; you paste what you collected, and it is stored and
            rendered as text.
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
        mode="google"
        businesses={props.businesses}
        icps={props.icps}
        canImport={props.canImport}
        defaultBusinessId={props.defaultBusinessId}
      />
    </>
  );
}
